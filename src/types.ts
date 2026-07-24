export type PatternId =
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
export type ProjectTypeId = 'genai' | 'standard';
export type ApiStackId = 'python-fastapi' | 'node-fastify' | 'go-huma';

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

export interface ProjectOptions {
  projectName?: string;
  projectType?: string;
  apiStack?: string;
  pattern?: string;
  cloud?: string;
  region?: string;
  includeFrontend?: boolean;
  environments?: string[];
  specWorkflow?: string;
  agents?: string[];
  defaultAgent?: string;
  configPath?: string;
  yes?: boolean;
  force?: boolean;
  installTools?: boolean;
  installDependencies?: boolean;
}

export interface ProjectPlan {
  projectName: string;
  safeProjectName: string;
  packageName: string;
  projectType: ProjectTypeDefinition;
  apiStack: ApiStackDefinition;
  pattern?: PatternDefinition;
  provider: ProviderDefinition;
  region: RegionDefinition;
  includeFrontend: boolean;
  frontendStarter: string;
  environments: EnvironmentDefinition[];
  specWorkflow: SpecWorkflowDefinition;
  agents: CodingAgentDefinition[];
  defaultAgent?: CodingAgentDefinition;
  framework: FrameworkDefinition;
  approvedStack: string[];
}

export interface GeneratedArtifact {
  logicalName: string;
  category: string;
  pathParts: string[];
  content: string;
}

export interface ManifestArtifact {
  logicalName: string;
  category: string;
  pathParts: string[];
  contentHash: string;
}

export interface LiftoffManifest {
  artifactVersion: 2 | 3;
  generatedBy: 'Mission Control Liftoff';
  liftoffVersion: string;
  project: {
    name: string;
    projectType: ProjectTypeId;
    apiStack: ApiStackId;
    pattern?: PatternId;
    cloud: ProviderId;
    region: string;
    frontend: boolean;
    specWorkflow: SpecWorkflowId;
    agents: CodingAgentId[];
    defaultAgent?: CodingAgentId;
    environments: EnvironmentId[];
  };
  framework: {
    state: 'initialized' | 'legacy';
    adapter: SpecWorkflowId;
    contractVersion?: string;
  };
  artifacts: ManifestArtifact[];
}

export interface ParsedArgs {
  command?: string;
  subcommand?: string;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}