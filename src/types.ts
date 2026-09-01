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
export type CodingAgentId = 'github-copilot' | 'claude';
export type EnvironmentId = 'dev' | 'test' | 'prod';
export type ScaffoldStatus = 'full' | 'foundation' | 'integration-shell';
export type ProjectTypeId = 'genai' | 'standard' | 'power-apps-code-app';
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

export interface PowerAppsStarterSource {
  repository: string;
  path: string;
  commit: string;
}

export interface CodeAppsPluginDefinition {
  id: 'code-apps-preview';
  label: string;
  version: string;
  marketplace: 'power-platform-skills';
  repository: string;
  path: string;
  preview: true;
  probes: Partial<Record<CodingAgentId, ExternalCommand>>;
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
  codeAppsPlugin?: boolean;
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

export interface PowerAppsCodeAppWorkloadPlan {
  workload: 'power-apps-code-app';
  starter: PowerAppsStarterSource;
  codeAppsPlugin: boolean;
}

export type ApiWorkloadPlan = GenAiWorkloadPlan | StandardApiWorkloadPlan;
export type WorkloadPlan = ApiWorkloadPlan | PowerAppsCodeAppWorkloadPlan;

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
export type PowerAppsCodeAppProjectPlan = ProjectPlanBase & PowerAppsCodeAppWorkloadPlan;

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
  | `environment:${EnvironmentId}`
  | 'power-apps-starter';

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

export interface ManifestProjectArtifact {
  logicalName: string;
  category: string;
  pathParts: string[];
  generatedBy: string;
  generationHash: string;
  provisioningGroup: ProjectProvisioningGroup;
}

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

export interface ManifestPowerAppsCodeAppWorkload {
  kind: 'power-apps-code-app';
  starter: PowerAppsStarterSource;
  codeAppsPlugin: boolean;
}

export type ManifestWorkload =
  | ManifestGenAiWorkload
  | ManifestStandardApiWorkload
  | ManifestPowerAppsCodeAppWorkload;

export interface ManifestGovernance {
  profile: ManifestGovernanceProfileId;
  state: 'disabled' | 'handoff-generated' | 'handoff-partial' | 'unspecified';
  policyVersion?: string;
}

export interface LiftoffManifest {
  artifactVersion: 2 | 3 | 4 | 5 | 6;
  generatedBy: 'Mission Control Liftoff';
  liftoffVersion: string;
  project: {
    name: string;
    workload: ManifestWorkload;
    specWorkflow: SpecWorkflowId;
    agents: CodingAgentId[];
    defaultAgent?: CodingAgentId;
  };
  framework: {
    state: 'initialized' | 'legacy';
    adapter: SpecWorkflowId;
    contractVersion?: string;
  };
  governance: ManifestGovernance;
  managedArtifacts: ManifestManagedArtifact[];
  projectArtifacts: ManifestProjectArtifact[];
}

export interface ParsedArgs {
  command?: string;
  subcommand?: string;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}