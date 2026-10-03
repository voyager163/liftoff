import { governanceAgentIntegrations, governanceArtifactPaths } from '../../domain/project/catalog.js';
import { managedCoreLogicalNames } from '../../domain/project/artifact-lifecycle.js';
import type { GeneratedArtifact, ProjectPlan } from '../../domain/project/contracts.js';
import { canonicalJson } from '../../domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraphJson } from '../../domain/governance/activation/graph.js';
import { renderCredentialPolicySchema } from '../../domain/governance/activation/credential-policy-schema.js';
import { assertGovernanceContentSafe, validateGovernancePolicy } from '../../domain/governance/policy/policy-contract.js';
import {
  buildGovernanceContext,
  validateGovernanceContext,
  type GovernanceContextOptions
} from '../../domain/governance/policy/context.js';
import { packagedGovernancePolicy } from '../../adapters/packaged-assets/governance-policy.js';
import { packagedSupportedStack } from '../../adapters/packaged-assets/supported-stack.js';
import {
  buildGovernanceCompatibilityMetadata,
  validateGovernanceCompatibilityMetadata,
  type ManagedCompatibilityInventoryEntry
} from '../../governance-activation/compatibility.js';
import { renderGovernanceGuide } from './guides.js';
import { renderAssessmentIntegration, renderRepairIntegration, renderSetupIntegration } from './integrations.js';

const governanceManagedCoreLogicalNames = managedCoreLogicalNames;

export function renderCanonicalGovernancePolicy(): string {
  const rendered = packagedGovernancePolicy;
  validateGovernancePolicy(rendered);
  assertGovernanceContentSafe(rendered);
  return `${rendered.trimEnd()}\n`;
}

export function renderGovernanceContext(plan: ProjectPlan, options: GovernanceContextOptions = {}): string {
  const value = buildGovernanceContext(plan, options, packagedSupportedStack);
  validateGovernanceContext(value);
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  assertGovernanceContentSafe(rendered);
  return rendered;
}

function managedCompatibilityInventory(
  artifacts: readonly GeneratedArtifact[]
): ManagedCompatibilityInventoryEntry[] {
  return artifacts.map((artifact) => ({
    logicalName: artifact.logicalName,
    pathParts: artifact.pathParts,
    lifecycle: 'managed-core',
    contentHashAuthority: 'liftoff.manifest.json managedArtifacts[].contentHash'
  }));
}

function sortedGovernancePathAllowlist(
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
