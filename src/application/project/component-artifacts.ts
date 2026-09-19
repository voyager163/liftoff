import { createHash } from 'node:crypto';
import type {
  CodingAgentDefinition, GeneratedArtifact, GovernanceProfileDefinition, LiftoffManifestV8,
  ManifestStandards, ProjectPlan
} from '../../domain/project/contracts.js';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { managedCoreLogicalNames } from '../../domain/project/artifact-lifecycle.js';
import { currentActivationIdentity, canonicalPhaseGraphJson } from '../../domain/governance/activation/graph.js';
import { buildGovernanceCompatibilityMetadata } from '../../governance-activation/compatibility.js';
import { governanceAgentIntegrations, governanceArtifactPaths } from '../../domain/project/catalog.js';
import { assertGovernanceContentSafe, governancePolicyVersion } from '../../domain/governance/policy/content-validation.js';
import { renderCanonicalGovernancePolicy } from '../repository-governance/policy-rendering.js';
import { renderCredentialPolicySchema } from '../repository-governance/credential-schema.js';
import { renderSetupIntegration, renderAssessmentIntegration, renderRepairIntegration } from '../repository-governance/agent-rendering.js';
import { liftoffVersion } from '../../version.js';
import { getCodingAgent, getFrameworkDefinition, getGovernanceProfile, getSpecWorkflow } from './catalog.js';

export interface ComponentMaintenancePlan {
  workload: 'components';
  projectName: string;
  standards: ManifestStandards;
  recordedWorkload: LiftoffManifestV8['project']['workload'];
  agents: CodingAgentDefinition[];
  defaultAgent?: CodingAgentDefinition;
  specWorkflow: ProjectPlan['specWorkflow'];
  framework: ProjectPlan['framework'];
  governanceProfile: GovernanceProfileDefinition;
}

export type ManagedProjectPlan = ProjectPlan | ComponentMaintenancePlan;

export function componentMaintenancePlan(manifest: LiftoffManifestV8, desired: unknown): ComponentMaintenancePlan {
  if (manifest.provenance.kind !== 'adopted') throw new Error('Adopted component maintenance requires actual adopted provenance.');
  if (!isRecord(desired) || Object.keys(desired).some((key) => ![
    'schemaVersion', 'kind', 'projectName', 'components', 'specWorkflow', 'agents', 'defaultAgent', 'governanceProfile'
  ].includes(key)) || desired.schemaVersion !== 1 || desired.kind !== 'liftoff-adopted-project' ||
    desired.projectName !== manifest.project.name ||
    canonicalSha256(desired.components) !== canonicalSha256(manifest.standards.components)) {
    throw new Error('Adopted desired state must retain its exact schema-1 component identities and project name. Application/profile conversion is not managed update.');
  }
  const workflow = getSpecWorkflow(typeof desired.specWorkflow === 'string' ? desired.specWorkflow : '');
  if (!workflow || workflow.id !== desired.specWorkflow || workflow.id !== manifest.project.specWorkflow) {
    throw new Error('Changing an adopted framework requires separate official staged integration, not managed update.');
  }
  if (!Array.isArray(desired.agents) || canonicalSha256(desired.agents) !== canonicalSha256(manifest.project.agents) ||
    desired.defaultAgent !== manifest.project.defaultAgent) {
    throw new Error('Changing recorded component agent integrations requires separately reviewed official framework integration.');
  }
  const profile = getGovernanceProfile(typeof desired.governanceProfile === 'string' ? desired.governanceProfile : 'single-maintainer-gitflow');
  if (!profile || desired.governanceProfile !== undefined && profile.id !== desired.governanceProfile) {
    throw new Error('Adopted desired state has an unsupported governance profile.');
  }
  const agents = manifest.project.agents.map((id) => {
    const agent = getCodingAgent(id);
    if (!agent) throw new Error(`Unsupported recorded agent ${id}.`);
    return agent;
  });
  const defaultAgent = agents.find((agent) => agent.id === manifest.project.defaultAgent);
  return {
    workload: 'components', projectName: manifest.project.name, standards: structuredClone(manifest.standards),
    recordedWorkload: structuredClone(manifest.project.workload),
    agents, ...(defaultAgent ? { defaultAgent } : {}), specWorkflow: workflow,
    framework: getFrameworkDefinition(workflow.id), governanceProfile: profile
  };
}

export function componentDesiredState(manifest: LiftoffManifestV8): string {
  return `${JSON.stringify({
    schemaVersion: 1, kind: 'liftoff-adopted-project', projectName: manifest.project.name,
    components: manifest.standards.components, specWorkflow: manifest.project.specWorkflow,
    agents: manifest.project.agents, ...(manifest.project.defaultAgent ? { defaultAgent: manifest.project.defaultAgent } : {}),
    governanceProfile: manifest.governance.profile === 'unspecified' ? 'none' : manifest.governance.profile
  }, null, 2)}\n`;
}

export function renderComponentGovernanceContext(plan: ComponentMaintenancePlan): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    policy: { profile: plan.governanceProfile.id, version: governancePolicyVersion, state: 'handoff-generated', liveEnforcement: 'not-active' },
    project: { name: plan.projectName, workload: plan.recordedWorkload.kind, workloadFacts: plan.recordedWorkload, artifactForm: 'adopted-components', components: plan.standards.components },
    standards: plan.standards,
    agents: plan.agents.map((agent) => agent.id),
    framework: { id: plan.specWorkflow.id, state: plan.agents.length ? 'initialized' : 'uninitialized', ...(plan.agents.length ? { version: plan.framework.version } : {}) },
    discovery: { githubRepository: 'undiscovered' },
    commands: [
      { id: 'project-validate', cwdPathParts: [], executable: 'liftoff', args: ['validate'] },
      { id: 'project-assess', cwdPathParts: [], executable: 'liftoff', args: ['assess', '--project', '.'] }
    ],
    generatedBoundaries: { application: 'not-generated', components: plan.standards.components.map((component) => ({ id: component.id, rootPathParts: component.rootPathParts })), infrastructure: 'not-declared' },
    applicability: {
      application: 'declared-component-profiles-only',
      cloud: plan.recordedWorkload.kind === 'components' ? 'not-declared' : plan.recordedWorkload.cloud,
      activation: 'configuration-and-independent-proof-required'
    },
    limitations: ['Component target selection does not establish application behavior, generated source, cloud deployment or live governance. Project commands and provider actions require their independent reviewed authority.']
  }, null, 2)}\n`;
}

export function buildComponentManagedArtifacts(plan: ComponentMaintenancePlan): GeneratedArtifact[] {
  const artifact = (logicalName: string, pathParts: readonly string[], content: string): GeneratedArtifact => ({
    logicalName, category: 'governance', lifecycle: 'managed-core', pathParts: [...pathParts], content: `${content.trimEnd()}\n`
  });
  const repair = plan.agents.map((agent) => artifact(governanceAgentIntegrations[agent.id].repair.logicalName,
    governanceArtifactPaths.repair[agent.id], renderRepairIntegration(agent.id)));
  if (plan.governanceProfile.id === 'none') return repair;
  const artifacts: GeneratedArtifact[] = [
    artifact('repository-governance-policy', governanceArtifactPaths.policy, renderCanonicalGovernancePolicy()),
    artifact('repository-governance-context', governanceArtifactPaths.context, renderComponentGovernanceContext(plan)),
    artifact('repository-governance-guide', governanceArtifactPaths.guide,
      `# ${plan.projectName}: adopted component governance\n\n` +
      'This handoff records the actual approved component roots, not a generated backend or cloud deployment. ' +
      'Run `liftoff assess --project .` for local evidence and `liftoff update --check` for managed metadata. ' +
      'Project code, dependency preparation, repository publication/controls, and Azure operations require separate applicable review and authority. ' +
      'No application scripts, repository enforcement or activation are proven by this handoff.\n'),
    artifact('repository-governance-phase-graph', governanceArtifactPaths.phaseGraph, canonicalPhaseGraphJson),
    artifact('repository-governance-compatibility', governanceArtifactPaths.compatibility, ''),
    artifact('repository-governance-credential-policy-schema', governanceArtifactPaths.credentialPolicySchema, renderCredentialPolicySchema()),
    ...plan.agents.flatMap((agent) => [
      artifact(governanceAgentIntegrations[agent.id].setup.logicalName, governanceArtifactPaths.setup[agent.id], renderSetupIntegration(agent.id)),
      artifact(governanceAgentIntegrations[agent.id].assessment.logicalName, governanceArtifactPaths.assessment[agent.id], renderAssessmentIntegration(agent.id))
    ]),
    ...repair
  ];
  const compatibility = artifacts.find((item) => item.logicalName === 'repository-governance-compatibility')!;
  compatibility.content = `${canonicalJson(buildGovernanceCompatibilityMetadata(
    artifacts.map((item) => ({
      logicalName: item.logicalName, pathParts: item.pathParts, lifecycle: 'managed-core',
      contentHashAuthority: 'liftoff.manifest.json managedArtifacts[].contentHash'
    })), managedCoreLogicalNames, artifacts.map((item) => item.pathParts)
  ))}\n`;
  for (const item of artifacts) assertGovernanceContentSafe(item.content);
  return artifacts;
}

export function buildComponentMaintenanceManifest(
  source: LiftoffManifestV8, plan: ComponentMaintenancePlan, artifacts: readonly GeneratedArtifact[]
): LiftoffManifestV8 {
  return {
    ...structuredClone(source), liftoffVersion,
    governance: plan.governanceProfile.id === 'none' ? { profile: 'none', state: 'disabled' } : {
      profile: plan.governanceProfile.id, policyVersion: governancePolicyVersion,
      state: 'handoff-generated', activationIdentity: currentActivationIdentity
    },
    managedArtifacts: artifacts.filter((item) => item.lifecycle === 'managed-core').map((item) => ({
      logicalName: item.logicalName, category: item.category, pathParts: [...item.pathParts],
      contentHash: `sha256:${createHash('sha256').update(item.content).digest('hex')}`
    }))
  };
}
