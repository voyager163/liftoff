import type { LiftoffManifest, ManifestManagedArtifact, ManifestProjectArtifact } from '../contracts.js';
import { FileSystemError } from '../errors.js';
import { isManagedCoreLogicalName, isRetiredManagedCoreLogicalName,
  isUnknownRetiredManagedCoreAliasLogicalName, legacyProvisioningGroup } from '../artifact-lifecycle.js';
import { isRetiredPowerAppsWorkload, retiredPowerAppsMessage } from '../retired-workload.js';
import type { ManifestContractContext } from './context.js';
import { assertOnlyFields, isRecord, requiredString, SEMVER_PATTERN } from './fields.js';
import { createManifestProjectReader } from './project-identity.js';
import { createManifestArtifactReader } from './artifacts.js';
import { createManifestGovernanceReader } from './governance.js';

export const SUPPORTED_MANIFEST_VERSIONS: readonly number[] = [2, 3, 4, 5, 6, 7];

// seed entries recorded by 0.2.0 manifests; dropped on read so archiving the
// seeded change is a non-event for validate, update, and doctor
const LEGACY_SEED_LOGICAL_NAMES = new Set([
  'openspec-config',
  'openspec-seed-change-metadata',
  'openspec-seed-proposal',
  'openspec-seed-design',
  'openspec-seed-tasks',
  'openspec-seed-spec',
  'openspec-spec-placeholder',
  'spec-kit-constitution',
  'specs-placeholder'
]);
const LEGACY_NON_PROVENANCE_LOGICAL_NAMES = new Set([
  ...LEGACY_SEED_LOGICAL_NAMES,
  'liftoff-config',
  'spec-kit-spec-template',
  'spec-kit-plan-template'
]);
const manifestsWithFilteredLegacySeedOwnership = new WeakSet<LiftoffManifest>();

export function manifestHadFilteredLegacyNonDurableOwnership(
  manifest: LiftoffManifest
): boolean {
  return manifestsWithFilteredLegacySeedOwnership.has(manifest);
}

export function createManifestReader(context: ManifestContractContext) {
  const { normalizeManifestProject, normalizeManifestFramework } = createManifestProjectReader(context.catalog);
  const { normalizeManifestManagedArtifacts, normalizeManifestProjectArtifacts,
    validateV6AndV7ArtifactAuthority, validateManifestArtifactUniqueness } = createManifestArtifactReader(context.catalog);
  const { normalizeManifestGovernance, validateGovernanceArtifactIdentity } = createManifestGovernanceReader(context);

  function parseManifest(raw: unknown): LiftoffManifest {
    if (!isRecord(raw)) {
      throw new FileSystemError('Manifest root must be a JSON object.');
    }
    if (isRecord(raw.project)) {
      const retiredIdentity = isRecord(raw.project.workload)
        ? raw.project.workload.kind
        : raw.project.projectType;
      if (isRetiredPowerAppsWorkload(retiredIdentity)) {
        throw new FileSystemError(retiredPowerAppsMessage(String(retiredIdentity)));
      }
    }

    const artifactVersion = raw.artifactVersion;
    if (typeof artifactVersion !== 'number' || !Number.isInteger(artifactVersion)) {
      throw new FileSystemError('Manifest artifactVersion must be an integer.');
    }
    if (!SUPPORTED_MANIFEST_VERSIONS.includes(artifactVersion)) {
      throw new FileSystemError(
        `Unsupported manifest artifactVersion ${JSON.stringify(artifactVersion)}: found ${JSON.stringify(artifactVersion)}; ` +
          `supported values are ${SUPPORTED_MANIFEST_VERSIONS.join(', ')}; write version is 7. ` +
          `Minimum Liftoff ${context.minimumLiftoffVersion} is required for manifest v7. ` +
          'Regenerate the project with this CLI, upgrade the CLI for future manifests, or use the Liftoff version that generated this project; no downgrade or write was performed.'
      );
    }
    if (artifactVersion === 6 || artifactVersion === 7) {
      assertOnlyFields(
        raw,
        [
          'artifactVersion',
          'generatedBy',
          'liftoffVersion',
          'project',
          'framework',
          'governance',
          'managedArtifacts',
          'projectArtifacts'
        ],
        'Manifest'
      );
    } else if (artifactVersion === 5) {
      assertOnlyFields(
        raw,
        [
          'artifactVersion',
          'generatedBy',
          'liftoffVersion',
          'project',
          'framework',
          'governance',
          'artifacts'
        ],
        'Manifest'
      );
    }

    if (raw.generatedBy !== 'Mission Control Liftoff') {
      throw new FileSystemError('Manifest generatedBy must be "Mission Control Liftoff".');
    }
    const liftoffVersion = requiredString(raw, 'liftoffVersion', 'Manifest');
    if (!SEMVER_PATTERN.test(liftoffVersion)) {
      throw new FileSystemError('Manifest liftoffVersion must be a valid semantic version.');
    }

    const project = normalizeManifestProject(raw.project, artifactVersion);
    const framework = normalizeManifestFramework(raw.framework, artifactVersion, project);
    const governance = normalizeManifestGovernance(raw.governance, artifactVersion);
    let managedArtifacts: ManifestManagedArtifact[];
    let projectArtifacts: ManifestProjectArtifact[];
    let filteredLegacySeedOwnership = false;
    if (artifactVersion === 6 || artifactVersion === 7) {
      managedArtifacts = normalizeManifestManagedArtifacts(
        raw.managedArtifacts,
        'Manifest.managedArtifacts'
      );
      projectArtifacts = normalizeManifestProjectArtifacts(raw.projectArtifacts);
      validateV6AndV7ArtifactAuthority(managedArtifacts, projectArtifacts);
    } else {
      const normalizedArtifacts = normalizeManifestManagedArtifacts(
        raw.artifacts,
        'Manifest.artifacts'
      );
      const artifacts = normalizedArtifacts.filter(
        (artifact) => !LEGACY_NON_PROVENANCE_LOGICAL_NAMES.has(artifact.logicalName)
      );
      for (const artifact of artifacts) {
        if (isUnknownRetiredManagedCoreAliasLogicalName(artifact.logicalName)) {
          throw new FileSystemError(
            `Manifest artifact ${artifact.logicalName} is an unknown retired managed-core alias logical name.`
          );
        }
      }
      filteredLegacySeedOwnership = artifacts.length !== normalizedArtifacts.length;
      managedArtifacts = artifacts.filter((artifact) =>
        isManagedCoreLogicalName(artifact.logicalName) ||
        isRetiredManagedCoreLogicalName(artifact.logicalName)
      );
      projectArtifacts = artifacts
        .filter((artifact) =>
          !isManagedCoreLogicalName(artifact.logicalName) &&
          !isRetiredManagedCoreLogicalName(artifact.logicalName)
        )
        .map((artifact) => ({
          logicalName: artifact.logicalName,
          category: artifact.category,
          pathParts: artifact.pathParts,
          generatedBy: liftoffVersion,
          generationHash: artifact.contentHash,
          provisioningGroup: legacyProvisioningGroup(artifact.logicalName)
        }));
    }
    validateManifestArtifactUniqueness(managedArtifacts, projectArtifacts);
    const manifest: LiftoffManifest = {
      artifactVersion: artifactVersion as 2 | 3 | 4 | 5 | 6 | 7,
      generatedBy: 'Mission Control Liftoff',
      liftoffVersion,
      project,
      framework,
      governance,
      managedArtifacts,
      projectArtifacts
    };
    validateGovernanceArtifactIdentity(manifest);
    if (filteredLegacySeedOwnership) {
      manifestsWithFilteredLegacySeedOwnership.add(manifest);
    }
    return manifest;
  }

  return { parseManifest, normalizeManifestProject, normalizeManifestFramework };
}
