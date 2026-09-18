import type { LiftoffManifest } from '../contracts.js';
import { FileSystemError } from '../errors.js';
import { isRetiredManagedCoreArtifactIdentity, isRetiredManagedCoreLogicalName, managedCoreLogicalNames } from '../artifact-lifecycle.js';
import type { ManifestContractContext } from './context.js';
import { assertOnlyFields, isRecord, requiredString } from './fields.js';

export const assessmentLogicalNames = [
  'liftoff-governance-assess-copilot',
  'liftoff-governance-assess-claude'
] as const;
export const preAssessmentManagedCoreLogicalNames = managedCoreLogicalNames.filter((logicalName) =>
  !assessmentLogicalNames.some((assessment) => assessment === logicalName)
);

export function createManifestGovernanceReader(context: ManifestContractContext) {
  const { getGovernanceProfile } = context.catalog;
  const { validateActivationIdentity, policyVersion: governancePolicyVersion,
    governanceArtifactPaths: governanceLogicalPaths } = context;

  function normalizeManifestGovernance(
    value: unknown,
    artifactVersion: number
  ): LiftoffManifest['governance'] {
    if (artifactVersion < 5) {
      return { profile: 'unspecified', state: 'unspecified' };
    }
    if (!isRecord(value)) {
      throw new FileSystemError('Manifest.governance must be a JSON object.');
    }
    const profileValue = requiredString(value, 'profile', 'Manifest.governance');
    const profile = getGovernanceProfile(profileValue);
    if (!profile || profile.id !== profileValue) {
      throw new FileSystemError(
        `Manifest governance profile ${JSON.stringify(profileValue)} is invalid.`
      );
    }
    const state = requiredString(value, 'state', 'Manifest.governance');
    if (profile.id === 'none') {
      assertOnlyFields(value, ['profile', 'state'], 'Manifest.governance');
      if (state !== 'disabled') {
        throw new FileSystemError(
          'Manifest governance profile none requires disabled state.'
        );
      }
      return { profile: profile.id, state };
    }
    assertOnlyFields(
      value,
      artifactVersion === 7
        ? ['profile', 'policyVersion', 'state', 'activationIdentity']
        : ['profile', 'policyVersion', 'state'],
      'Manifest.governance'
    );
    const policyVersion = requiredString(
      value,
      'policyVersion',
      'Manifest.governance'
    );
    if (!/^[1-9]\d*$/.test(policyVersion)) {
      throw new FileSystemError(
        'Manifest governance policyVersion must be a positive integer.'
      );
    }
    const supportedPolicyVersions = artifactVersion === 7
      ? [governancePolicyVersion]
      : ['1', '2', '3', '4', '5', governancePolicyVersion];
    if (!supportedPolicyVersions.includes(policyVersion)) {
      throw new FileSystemError(
        `Manifest governance policyVersion cannot be newer than ${governancePolicyVersion}. ` +
          `Unsupported Manifest.governance.policyVersion: found ${JSON.stringify(policyVersion)}; ` +
          `supported values for artifactVersion ${artifactVersion} are ${supportedPolicyVersions.map((value) => JSON.stringify(value)).join(', ')}. ` +
          `Minimum Liftoff ${context.minimumLiftoffVersion} is required for policy ${governancePolicyVersion}; ` +
          'upgrade the CLI for future policy identities or restore a supported manifest without writing.'
      );
    }
    if (artifactVersion === 7 && policyVersion !== governancePolicyVersion) {
      throw new FileSystemError(
        `Manifest governance policyVersion must be ${governancePolicyVersion} for artifactVersion 7.`
      );
    }
    if (state !== 'handoff-generated' && state !== 'handoff-partial') {
      throw new FileSystemError(
        'Enabled manifest governance requires handoff-generated or handoff-partial state.'
      );
    }
    if (artifactVersion === 7) {
      let activationIdentity;
      try {
        activationIdentity = validateActivationIdentity(value.activationIdentity);
      } catch (error) {
        throw new FileSystemError(
          `Manifest governance activationIdentity is invalid: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (activationIdentity.policyVersion !== policyVersion) {
        throw new FileSystemError(
          'Manifest governance activationIdentity.policyVersion must match policyVersion.'
        );
      }
      return {
        profile: profile.id,
        policyVersion,
        activationIdentity,
        state
      };
    }
    return {
      profile: profile.id,
      policyVersion,
      state
    };
  }

  function validateGovernanceArtifactIdentity(manifest: LiftoffManifest): void {
    if ([...manifest.managedArtifacts, ...manifest.projectArtifacts].some((artifact) =>
      artifact.pathParts.join('/') === 'governance/activation-baseline.json'
    )) {
      throw new FileSystemError(
        'governance/activation-baseline.json is user-owned and cannot be a Liftoff manifest artifact.'
      );
    }
    const governanceArtifacts = manifest.managedArtifacts.filter((artifact) =>
      governanceLogicalPaths.has(artifact.logicalName)
    );
    const retiredGovernanceArtifacts = manifest.managedArtifacts.filter((artifact) =>
      isRetiredManagedCoreLogicalName(artifact.logicalName)
    );
    for (const artifact of retiredGovernanceArtifacts) {
      if (
        !isRetiredManagedCoreArtifactIdentity(
          artifact.logicalName,
          artifact.category,
          artifact.pathParts
        )
      ) {
        throw new FileSystemError(
          `Retired managed-core artifact ${artifact.logicalName} has invalid identity.`
        );
      }
    }
    const applicableAssessment: string[] = manifest.project.agents.map((agent) =>
      agent === 'github-copilot'
        ? 'liftoff-governance-assess-copilot'
        : 'liftoff-governance-assess-claude'
    );
    for (const artifact of governanceArtifacts.filter((entry) =>
      assessmentLogicalNames.some((logicalName) => entry.logicalName === logicalName)
    )) {
      if (!applicableAssessment.includes(artifact.logicalName)) {
        throw new FileSystemError(
          `Manifest governance contains inapplicable assessment integration ${artifact.logicalName}.`
        );
      }
      if (
        artifact.category !== 'governance' ||
        artifact.pathParts.join('\0') !== governanceLogicalPaths.get(artifact.logicalName)!.join('\0')
      ) {
        throw new FileSystemError(
          `Manifest governance artifact ${artifact.logicalName} has invalid identity.`
        );
      }
    }
    if (manifest.governance.profile === 'unspecified') {
      return;
    }
    if (manifest.governance.profile === 'none') {
      if (governanceArtifacts.length > 0 || retiredGovernanceArtifacts.length > 0) {
        throw new FileSystemError(
          'Disabled manifest governance cannot own governance handoff artifacts.'
        );
      }
      return;
    }
    const required = [
      'repository-governance-policy',
      'repository-governance-context',
      'repository-governance-guide',
      'repository-governance-phase-graph',
      'repository-governance-compatibility',
      'repository-governance-credential-policy-schema',
      ...manifest.project.agents.map((agent) =>
        agent === 'github-copilot'
          ? 'liftoff-setup-copilot'
          : 'liftoff-setup-claude'
      )
    ];
    const applicable = [...required, ...applicableAssessment];
    const hasAssessmentInventory = governanceArtifacts.some((artifact) =>
      applicableAssessment.includes(artifact.logicalName)
    );
    const missing: string[] = [];
    for (const logicalName of applicable) {
      const artifact = manifest.managedArtifacts.find((entry) =>
        entry.logicalName === logicalName
      );
      const expectedPath = governanceLogicalPaths.get(logicalName);
      if (!artifact) {
        missing.push(logicalName);
        continue;
      }
      if (!expectedPath) {
        throw new FileSystemError(`Unknown manifest governance artifact ${logicalName}.`);
      }
      if (
        artifact.category !== 'governance' ||
        artifact.pathParts.join('\0') !== expectedPath.join('\0')
      ) {
        throw new FileSystemError(
          `Manifest governance artifact ${logicalName} has invalid identity.`
        );
      }
    }
    // Supported older complete inventories predate assessment integrations.
    const missingRequired = missing.filter((logicalName) =>
      hasAssessmentInventory || required.includes(logicalName)
    );
    if (manifest.governance.state === 'handoff-generated' && missingRequired.length > 0) {
      throw new FileSystemError(
        `Enabled manifest governance is missing artifact ${missingRequired[0]}.`
      );
    }
    if (
      manifest.governance.state === 'handoff-partial' &&
      missing.length === 0 &&
      retiredGovernanceArtifacts.length === 0
    ) {
      throw new FileSystemError(
        'Manifest governance state handoff-partial requires at least one applicable artifact to remain outside Liftoff ownership or one protected retired alias to remain tracked.'
      );
    }
    for (const artifact of governanceArtifacts) {
      if (!applicable.includes(artifact.logicalName)) {
        const integration = assessmentLogicalNames.some((logicalName) => artifact.logicalName === logicalName)
          ? 'assessment'
          : 'setup';
        throw new FileSystemError(
          `Manifest governance contains inapplicable ${integration} integration ${artifact.logicalName}.`
        );
      }
    }
  }

  return { normalizeManifestGovernance, validateGovernanceArtifactIdentity };
}
