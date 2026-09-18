import { governanceAgentIntegrations, governanceArtifactPaths } from '../../domain/project/catalog.js';
import { managedCoreLogicalNames } from '../../domain/project/artifact-lifecycle.js';
import type { GeneratedArtifact, ProjectPlan } from '../../domain/project/contracts.js';
import { canonicalJson } from '../../domain/governance/activation/canonical-json.js';
import { buildGovernanceCompatibilityMetadata, validateGovernanceCompatibilityMetadata, type ManagedCompatibilityInventoryEntry } from '../../governance-activation/compatibility.js';
import { canonicalPhaseGraphJson } from '../../domain/governance/activation/graph.js';
import { assertGovernanceContentSafe } from '../../domain/governance/policy/content-validation.js';
import { renderCanonicalGovernancePolicy } from './policy-rendering.js';
import { credentialPolicySchema, renderCredentialPolicySchema } from './credential-schema.js';
import { renderGovernanceContext } from './workload-context.js';
import { renderGovernanceGuide, renderRepairIntegration, renderSetupIntegration, renderAssessmentIntegration } from './agent-rendering.js';

export const governanceManagedCoreLogicalNames = managedCoreLogicalNames;

export function managedCompatibilityInventory(
  artifacts: readonly GeneratedArtifact[]
): ManagedCompatibilityInventoryEntry[] {
  return artifacts.map((artifact) => ({
    logicalName: artifact.logicalName,
    pathParts: artifact.pathParts,
    lifecycle: 'managed-core',
    contentHashAuthority: 'liftoff.manifest.json managedArtifacts[].contentHash'
  }));
}

export function sortedGovernancePathAllowlist(
  artifacts: readonly GeneratedArtifact[]
): readonly string[][] {
  return artifacts.map((artifact) => [...artifact.pathParts]);
}

export function buildRepositoryGovernanceArtifacts(
  plan: ProjectPlan
): GeneratedArtifact[] {
  const repairArtifacts = plan.agents.map((agent): GeneratedArtifact => ({
    logicalName: governanceAgentIntegrations[agent.id].repair.logicalName,
    category: 'governance',
    lifecycle: 'managed-core',
    pathParts: [...governanceArtifactPaths.repair[agent.id]],
    content: `${renderRepairIntegration(agent.id).trimEnd()}\n`
  }));
  for (const artifact of repairArtifacts) assertGovernanceContentSafe(artifact.content);
  if (plan.governanceProfile.id === 'none') {
    return repairArtifacts;
  }
  const policy = renderCanonicalGovernancePolicy();
  const context = renderGovernanceContext(plan);
  const guide = `${renderGovernanceGuide(plan).trimEnd()}\n`;
  const artifacts: GeneratedArtifact[] = [
    {
      logicalName: 'repository-governance-policy',
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.policy],
      content: policy
    },
    {
      logicalName: 'repository-governance-context',
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.context],
      content: context
    },
    {
      logicalName: 'repository-governance-guide',
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.guide],
      content: guide
    },
    {
      logicalName: 'repository-governance-phase-graph',
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.phaseGraph],
      content: canonicalPhaseGraphJson
    },
    {
      logicalName: 'repository-governance-compatibility',
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.compatibility],
      content: ''
    },
    {
      logicalName: 'repository-governance-credential-policy-schema',
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.credentialPolicySchema],
      content: renderCredentialPolicySchema()
    },
    ...plan.agents.map((agent): GeneratedArtifact => ({
      logicalName: governanceAgentIntegrations[agent.id].setup.logicalName,
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.setup[agent.id]],
      content: `${renderSetupIntegration(agent.id).trimEnd()}\n`
    })),
    ...plan.agents.map((agent): GeneratedArtifact => ({
      logicalName: governanceAgentIntegrations[agent.id].assessment.logicalName,
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.assessment[agent.id]],
      content: `${renderAssessmentIntegration(agent.id).trimEnd()}\n`
    })),
    ...repairArtifacts
  ];
  const compatibility = artifacts.find((artifact) =>
    artifact.logicalName === 'repository-governance-compatibility'
  );
  if (!compatibility) {
    throw new Error('Governance compatibility artifact was not rendered.');
  }
  const compatibilityMetadata = buildGovernanceCompatibilityMetadata(
    managedCompatibilityInventory(artifacts),
    governanceManagedCoreLogicalNames,
    sortedGovernancePathAllowlist(artifacts)
  );
  validateGovernanceCompatibilityMetadata(compatibilityMetadata, {
    logicalNameAllowlist: governanceManagedCoreLogicalNames,
    pathAllowlist: sortedGovernancePathAllowlist(artifacts),
    inventory: managedCompatibilityInventory(artifacts),
    agents: plan.agents.map((agent) => agent.id)
  });
  compatibility.content = `${canonicalJson(compatibilityMetadata)}\n`;
  for (const artifact of artifacts) {
    assertGovernanceContentSafe(artifact.content);
  }
  return artifacts;
}
