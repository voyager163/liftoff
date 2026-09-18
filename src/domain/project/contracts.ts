import type { ActivationIdentity } from '../../governance-activation/types.js';

export type PatternId =
  | 'generic'
  | 'rag'
  | 'chatbot'
  | 'agent'
  | 'prompt'
  | 'multi-agent'
  | 'fine-tuned'
  | 'streaming'
  | 'workflow';

export type ProviderId = 'azure' | 'aws' | 'gcp';
export type ProviderStatus = 'available' | 'planned';
export type SpecWorkflowId = 'openspec' | 'spec-kit';
export type CodingAgentId = 'github-copilot' | 'claude' | 'codex';
export type EnvironmentId = 'dev' | 'staging' | 'prod';
export type ScaffoldStatus = 'full' | 'foundation' | 'integration-shell';
export type ProjectTypeId = 'genai' | 'standard';
export type ApiStackId = 'python-fastapi' | 'node-fastify' | 'go-huma';
export type GovernanceProfileId = 'single-maintainer-gitflow' | 'none';
export type ManifestGovernanceProfileId = GovernanceProfileId | 'unspecified';

export interface ProjectTypeDefinition {
  id: ProjectTypeId;
  label: string;
  description: string;
}

export interface ApiStackDefinition {
  id: ApiStackId;
  label: string;
  aliases: string[];
  language: string;
  framework: string;
  databaseTooling: string;
  testFramework: string;
}

export interface PatternDefinition {
  id: PatternId;
  label: string;
  aliases: string[];
  description: string;
  scaffoldStatus: ScaffoldStatus;
  frontendStarter: string;
  routePrefix: string;
  worker: boolean;
  requiresVectorStore: boolean;
}

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  status: ProviderStatus;
  description: string;
}

export interface RegionDefinition {
  provider: ProviderId;
  slug: string;
  displayName: string;
  geography: string;
  aliases: string[];
  default?: boolean;
}

export type RegionResolution =
  | { status: 'resolved'; region: RegionDefinition }
  | { status: 'ambiguous'; matches: RegionDefinition[] }
  | { status: 'unknown'; input: string };

export interface EnvironmentDefinition {
  id: EnvironmentId;
  label: string;
  description: string;
}

export interface SpecWorkflowDefinition {
  id: SpecWorkflowId;
  label: string;
  default: boolean;
  description: string;
}

export interface GovernanceProfileDefinition {
  id: GovernanceProfileId;
  label: string;
  description: string;
  default: boolean;
  policyVersion?: string;
}

export interface ExternalCommand {
  executable: string;
  args: string[];
}

export interface CodingAgentDefinition {
  id: CodingAgentId;
  inputName: string;
  label: string;
  aliases: string[];
  executable: string;
  integrationIds: Record<SpecWorkflowId, string>;
}

export interface FrameworkDefinition {
  id: SpecWorkflowId;
  executable: string;
  version: string;
  installCommand: ExternalCommand;
  allowedRoots: string[];
  baseMarkers: string[][];
  agentMarkers: Record<CodingAgentId, string[][]>;
}

export interface AgentWorkflowSurface {
  skillsRoot: readonly string[];
  commands?: {
    root: readonly string[];
    prefix: string;
    suffix: string;
  };
}

export interface ProjectOptions {
  projectName?: string;
  projectType?: string;
  genai?: boolean;
  apiStack?: string;
  pattern?: string;
  cloud?: string;
  region?: string;
  includeFrontend?: boolean;
  environments?: string[];
  specWorkflow?: string;
  agents?: string[];
  defaultAgent?: string;
  copilotCloud?: boolean;
  configureOpenSpecProfile?: boolean;
  governanceProfile?: string;
  configPath?: string;
  yes?: boolean;
  force?: boolean;
  installTools?: boolean;
  installDependencies?: boolean;
}

export interface GenAiWorkloadPlan {
  workload: 'genai';
  apiStack: ApiStackDefinition;
  pattern: PatternDefinition;
  provider: ProviderDefinition;
  region: RegionDefinition;
  includeFrontend: boolean;
  frontendStarter: string;
  environments: EnvironmentDefinition[];
}

export interface StandardApiWorkloadPlan {
  workload: 'standard';
  apiStack: ApiStackDefinition;
  provider: ProviderDefinition;
  region: RegionDefinition;
  includeFrontend: boolean;
  frontendStarter: string;
  environments: EnvironmentDefinition[];
}

export type ApiWorkloadPlan = GenAiWorkloadPlan | StandardApiWorkloadPlan;
export type WorkloadPlan = ApiWorkloadPlan;

export interface ProjectPlanBase {
  projectName: string;
  safeProjectName: string;
  packageName: string;
  projectType: ProjectTypeDefinition;
  specWorkflow: SpecWorkflowDefinition;
  agents: CodingAgentDefinition[];
  defaultAgent?: CodingAgentDefinition;
  copilotCloud: boolean;
  framework: FrameworkDefinition;
  governanceProfile: GovernanceProfileDefinition;
  approvedStack: string[];
}

export type ProjectPlan = ProjectPlanBase & WorkloadPlan;
export type GenAiProjectPlan = ProjectPlanBase & GenAiWorkloadPlan;
export type StandardApiProjectPlan = ProjectPlanBase & StandardApiWorkloadPlan;
export type ApiProjectPlan = GenAiProjectPlan | StandardApiProjectPlan;

export type ArtifactLifecycle =
  | 'managed-core'
  | 'project'
  | 'desired-state'
  | 'framework'
  | 'seed'
  | 'manifest';

export type ProjectProvisioningGroup =
  | 'base'
  | 'frontend'
  | `environment:${EnvironmentId}`;

interface GeneratedArtifactBase {
  logicalName: string;
  category: string;
  pathParts: string[];
  content: string;
}

export type GeneratedArtifact =
  | GeneratedArtifactBase & {
      lifecycle: 'project';
      provisioningGroup: ProjectProvisioningGroup;
    }
  | GeneratedArtifactBase & {
      lifecycle: Exclude<ArtifactLifecycle, 'project'>;
      provisioningGroup?: never;
    };

export interface ManifestManagedArtifact {
  logicalName: string;
  category: string;
  pathParts: string[];
  contentHash: string;
}

export interface ManifestGeneratedProjectArtifact {
  logicalName: string;
  category: string;
  pathParts: string[];
  generatedBy: string;
  generationHash: string;
  provisioningGroup: ProjectProvisioningGroup;
  adoption?: never;
  addition?: never;
}

export interface ManifestAdoptedProjectArtifact {
  logicalName: string;
  category: string;
  pathParts: string[];
  adoption: {
    recordId: string;
    componentId: string;
    sourcePathParts: string[];
    observedHash: string;
    observedMode: number;
  };
  generatedBy?: never;
  generationHash?: never;
  provisioningGroup?: never;
  addition?: never;
}

export interface ManifestAddedProjectArtifact {
  logicalName: string;
  category: string;
  pathParts: string[];
  addition: {
    recordId: string;
    componentId: string;
    producer: 'reviewed-project-proposal';
    contentHash: string;
    mode: number;
  };
  generatedBy?: never;
  generationHash?: never;
  provisioningGroup?: never;
  adoption?: never;
}

export type ManifestProjectArtifact =
  | ManifestGeneratedProjectArtifact
  | ManifestAdoptedProjectArtifact
  | ManifestAddedProjectArtifact;

export type ManifestArtifact = ManifestManagedArtifact;

export interface ManifestGenAiWorkload {
  kind: 'genai';
  apiStack: ApiStackId;
  pattern: PatternId;
  cloud: ProviderId;
  region: string;
  frontend: boolean;
  environments: EnvironmentId[];
}

export interface ManifestStandardApiWorkload {
  kind: 'standard';
  apiStack: ApiStackId;
  cloud: ProviderId;
  region: string;
  frontend: boolean;
  environments: EnvironmentId[];
}

export type ManifestGeneratedWorkload =
  | ManifestGenAiWorkload
  | ManifestStandardApiWorkload;

export interface ManifestComponentWorkload {
  kind: 'components';
}

export type ManifestWorkload = ManifestGeneratedWorkload | ManifestComponentWorkload;

export interface ManifestProfileIdentity {
  schemaVersion: 1;
  id: string;
  revision: string;
  digest: string;
}

export interface ManifestComponent {
  id: string;
  profile: ManifestProfileIdentity;
  rootPathParts: string[];
}

export interface ManifestStandards {
  schemaVersion: 1;
  catalogDigest: string;
  resourceCatalogDigest: string;
  components: ManifestComponent[];
}

export interface ManifestHistoricalSource {
  kind: 'historical-manifest';
  artifactVersion: 2 | 3 | 4 | 5 | 6 | 7;
  writerVersion: string;
  contentHash: string;
  historyPathParts: string[];
  originalProfile: 'unknown';
}

export interface ManifestRepairProvenance {
  recordId: string;
  recipe: string;
  recipeVersion: number;
  sourceManifestHash: string;
}

export type ManifestProvenance =
  | {
      kind: 'generated';
      origin: {
        kind: 'catalog';
        cliVersion: string;
        standards: ManifestStandards;
      } | ManifestHistoricalSource;
      repairs: ManifestRepairProvenance[];
    }
  | {
      kind: 'adopted';
      recordId: string;
      observationDigest: string;
      repairs: ManifestRepairProvenance[];
    };

export type ManifestGovernance =
  | {
      profile: 'none';
      state: 'disabled';
    }
  | {
      profile: 'unspecified';
      state: 'unspecified';
    }
  | {
      profile: Exclude<GovernanceProfileId, 'none'>;
      state: 'handoff-generated' | 'handoff-partial';
      policyVersion: string;
      activationIdentity?: ActivationIdentity;
    };

export interface ManifestProjectIdentity {
  name: string;
  workload: ManifestWorkload;
  specWorkflow: SpecWorkflowId;
  agents: CodingAgentId[];
  defaultAgent?: CodingAgentId;
}

export interface ManifestFrameworkIdentity {
  state: 'initialized' | 'legacy' | 'uninitialized';
  adapter: SpecWorkflowId;
  contractVersion?: string;
}

interface ManifestCommon {
  generatedBy: 'Mission Control Liftoff';
  liftoffVersion: string;
  governance: ManifestGovernance;
  managedArtifacts: ManifestManagedArtifact[];
}

export interface HistoricalLiftoffManifest extends ManifestCommon {
  artifactVersion: 2 | 3 | 4 | 5 | 6 | 7;
  project: ManifestProjectIdentity & { workload: ManifestGeneratedWorkload };
  framework: ManifestFrameworkIdentity & { state: 'initialized' | 'legacy' };
  projectArtifacts: ManifestGeneratedProjectArtifact[];
  standards?: never;
  provenance?: never;
}

export interface LiftoffManifestV8 extends ManifestCommon {
  artifactVersion: 8;
  project: ManifestProjectIdentity;
  framework: ManifestFrameworkIdentity;
  projectArtifacts: ManifestProjectArtifact[];
  standards: ManifestStandards;
  provenance: ManifestProvenance;
}

export type LiftoffManifest = HistoricalLiftoffManifest | LiftoffManifestV8;

export interface ParsedArgs {
  command?: string;
  subcommand?: string;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}