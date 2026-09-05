import { createHash } from 'node:crypto';
import { addGenAiExtensionArtifacts } from './genai-templates.js';
import { assertImmutableGeneratedContainerReferences } from './container-validation.js';
import { addPowerAppsCodeAppArtifacts } from './power-apps-templates.js';
import {
  addStandardStackArtifacts,
  renderStandardDockerfile,
  renderStandardEnv
} from './standard-templates.js';
import type { AddArtifact } from './template-types.js';
import type {
  ApiProjectPlan,
  GeneratedArtifact,
  GenAiProjectPlan,
  LiftoffManifest,
  ManifestWorkload,
  ProjectPlan,
  ExternalCommand,
  ArtifactLifecycle,
  ProjectProvisioningGroup
} from './types.js';
import { liftoffVersion } from './version.js';
import { renderNpmLock, renderNpmPackage } from './npm-template-assets.js';
import {
  renderOpenTofuProviderLock,
  renderOpenTofuVersions
} from './opentofu-template-assets.js';
import { formatCommand } from './process-runner.js';
import { formatContainerImage, supportedStack } from './supported-stack.js';
import {
  buildRepositoryGovernanceArtifacts,
  governancePolicyVersion
} from './repository-governance.js';
import {
  currentActivationIdentity
} from './governance-activation/graph.js';
import {
  OPEN_SPEC_DELIVERY,
  OPEN_SPEC_PROFILE,
  OPEN_SPEC_WORKFLOW_IDS
} from './openspec-profile.js';
import {
  renderFunctionRequirementsAsset,
  renderPythonLock,
  renderPythonPyprojectAsset
} from './python-template-assets.js';
import {
  workstationRequirementCatalog,
  type WorkstationRequirementId
} from './workstation-catalog.js';

const contentHash = (content: string) => `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
const DEFAULT_FUNCTION_WORKER_QUEUE_NAME = 'events';

export const AZURE_NAME_LIMITS = {
  resourceGroup: 90,
  containerRegistry: 50,
  identity: 128,
  containerAppEnvironment: 60,
  backendContainerApp: 32,
  frontendContainerApp: 32,
  functionServicePlan: 40,
  functionApp: 60,
  postgres: 63,
  redis: 63,
  storage: 24,
  serviceBus: 50,
  communication: 63,
  keyVault: 24
} as const;

export type AzureResourceNames = Record<keyof typeof AZURE_NAME_LIMITS, string>;

const boundedToken = (value: string, length: number) =>
  value.slice(0, length).replace(/-+$/g, '') || 'app';

export function buildAzureResourceNames(
  plan: ApiProjectPlan,
  environment: string,
  resourceSuffix: string
): AzureResourceNames {
  const workload = boundedToken(plan.safeProjectName, 12);
  const compactWorkload = boundedToken(plan.safeProjectName.replace(/-/g, ''), 8);
  return {
    resourceGroup: `rg-${workload}-${environment}`,
    containerRegistry: `acr${compactWorkload}${resourceSuffix}`,
    identity: `id-${workload}-${environment}`,
    containerAppEnvironment: `cae-${workload}-${environment}`,
    backendContainerApp: `ca-${workload}-be-${environment}`,
    frontendContainerApp: `ca-${workload}-fe-${environment}`,
    functionServicePlan: `asp-${workload}-fn-${environment}`,
    functionApp: `func-${workload}-${environment}-${resourceSuffix}`,
    postgres: `psql-${workload}-${environment}-${resourceSuffix}`,
    redis: `redis-${workload}-${environment}-${resourceSuffix}`,
    storage: `st${compactWorkload}${resourceSuffix}`,
    serviceBus: `sb-${workload}-${environment}-${resourceSuffix}`,
    communication: `acs-${workload}-${environment}-${resourceSuffix}`,
    keyVault: `kv-${compactWorkload}-${resourceSuffix}`
  };
}

function stableResourceSuffix(plan: ApiProjectPlan, environment: string): string {
  return createHash('sha256')
    .update(`${plan.safeProjectName}:${environment}`, 'utf8')
    .digest('hex')
    .slice(0, 12);
}

const pyModule = (value: string) => value.replace(/-/g, '_');
const titleCase = (value: string) => value.replace(/(^|[-_\s])([a-z])/g, (_match, prefix: string, letter: string) => `${prefix ? ' ' : ''}${letter.toUpperCase()}`).trim();
const sourceString = (value: string) => JSON.stringify(value);
const scriptSourceString = (value: string) => sourceString(value).replaceAll('<', '\\u003c');
const escapeHtml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const genAiPattern = (plan: GenAiProjectPlan) => {
  return plan.pattern;
};
const hasFunctionWorker = (plan: ApiProjectPlan) =>
  plan.workload === 'genai' && plan.provider.id === 'azure' && plan.pattern.worker;
const functionWorkerName = (plan: GenAiProjectPlan) => `${plan.pattern.id}-worker`;

export function buildArtifacts(plan: ProjectPlan): GeneratedArtifact[] {
  const artifacts: GeneratedArtifact[] = [];
  const addProject = createArtifactAdder(artifacts, 'project', 'base');
  const addDesiredState = createArtifactAdder(artifacts, 'desired-state');
  const addFramework = createArtifactAdder(artifacts, 'framework');
  const addSeed = createArtifactAdder(artifacts, 'seed');

  switch (plan.workload) {
    case 'genai':
      addGenAiWorkloadArtifacts(addProject, addDesiredState, artifacts, plan);
      break;
    case 'standard':
      addStandardWorkloadArtifacts(addProject, addDesiredState, artifacts, plan);
      break;
    case 'power-apps-code-app':
      addPowerAppsWorkloadArtifacts(addDesiredState, artifacts, plan);
      break;
  }
  addSpecWorkflowArtifacts(addSeed, addFramework, plan);
  for (const artifact of buildRepositoryGovernanceArtifacts(plan)) {
    artifacts.push({ ...artifact, content: ensureTrailingNewline(artifact.content) });
  }
  if (plan.workload !== 'power-apps-code-app' && plan.includeFrontend) {
    addFrontendArtifacts(
      createArtifactAdder(artifacts, 'project', 'frontend'),
      plan
    );
  }
  assertImmutableGeneratedContainerReferences(artifacts);

  const manifest = buildManifest(plan, artifacts);
  artifacts.push({
    logicalName: 'manifest',
    category: 'manifest',
    lifecycle: 'manifest',
    pathParts: ['liftoff.manifest.json'],
    content: `${JSON.stringify(manifest, null, 2)}\n`
  });

  return artifacts;
}

function createArtifactAdder(
  artifacts: GeneratedArtifact[],
  lifecycle: ArtifactLifecycle,
  provisioningGroup?: ProjectProvisioningGroup
): AddArtifact {
  return (logicalName, category, pathParts, content) => {
    const normalizedContent = ensureTrailingNewline(content);
    if (lifecycle === 'project') {
      if (!provisioningGroup) {
        throw new Error(`Project artifact ${logicalName} is missing a provisioning group.`);
      }
      artifacts.push({
        logicalName,
        category,
        lifecycle,
        provisioningGroup,
        pathParts,
        content: normalizedContent
      });
      return;
    }
    artifacts.push({
      logicalName,
      category,
      lifecycle,
      pathParts,
      content: normalizedContent
    });
  };
}

function addGenAiWorkloadArtifacts(
  add: AddArtifact,
  addDesiredState: AddArtifact,
  artifacts: GeneratedArtifact[],
  plan: GenAiProjectPlan
): void {
  addBaseArtifacts(add, addDesiredState, plan);
  addGenAiExtensionArtifacts(add, plan, {
    backend: addBackendArtifacts,
    database: addDatabaseArtifacts,
    pattern: addPatternArtifacts,
    functions: addFunctionArtifacts
  });
  addApiWorkloadOperations(add, artifacts, plan);
}

function addStandardWorkloadArtifacts(
  add: AddArtifact,
  addDesiredState: AddArtifact,
  artifacts: GeneratedArtifact[],
  plan: Extract<ProjectPlan, { workload: 'standard' }>
): void {
  addBaseArtifacts(add, addDesiredState, plan);
  addStandardStackArtifacts(add, plan);
  addApiWorkloadOperations(add, artifacts, plan);
}

function addPowerAppsWorkloadArtifacts(
  addDesiredState: AddArtifact,
  artifacts: GeneratedArtifact[],
  plan: Extract<ProjectPlan, { workload: 'power-apps-code-app' }>
): void {
  addPowerAppsCodeAppArtifacts(
    createArtifactAdder(artifacts, 'project', 'power-apps-starter'),
    plan
  );
  addPowerAppsProjectConfig(addDesiredState, plan);
}

function addApiWorkloadOperations(
  add: AddArtifact,
  artifacts: GeneratedArtifact[],
  plan: ApiProjectPlan
): void {
  addEnvironmentArtifacts(artifacts, plan);
  addDockerArtifacts(add, plan);
  addInfrastructureArtifacts(add, artifacts, plan);
}

export function partitionGeneratedArtifacts(artifacts: GeneratedArtifact[]): {
  liftoff: GeneratedArtifact[];
  managedCore: GeneratedArtifact[];
  project: GeneratedArtifact[];
  desiredState: GeneratedArtifact[];
  framework: GeneratedArtifact[];
  seed: GeneratedArtifact[];
  manifest: GeneratedArtifact;
} {
  const manifest = artifacts.find((artifact) => artifact.logicalName === 'manifest');
  if (!manifest) {
    throw new Error('Generated artifacts are missing the Liftoff manifest.');
  }
  return {
    liftoff: artifacts.filter((artifact) =>
      artifact.lifecycle === 'managed-core' ||
      artifact.lifecycle === 'project' ||
      artifact.lifecycle === 'desired-state'
    ),
    managedCore: artifacts.filter((artifact) => artifact.lifecycle === 'managed-core'),
    project: artifacts.filter((artifact) => artifact.lifecycle === 'project'),
    desiredState: artifacts.filter((artifact) => artifact.lifecycle === 'desired-state'),
    framework: artifacts.filter((artifact) => artifact.lifecycle === 'framework'),
    seed: artifacts.filter((artifact) => artifact.lifecycle === 'seed'),
    manifest
  };
}

export function buildManifest(
  plan: ProjectPlan,
  artifacts: GeneratedArtifact[],
  options: {
    frameworkState?: 'initialized' | 'legacy';
    projectArtifacts?: LiftoffManifest['projectArtifacts'];
  } = {}
): LiftoffManifest {
  const frameworkState = options.frameworkState ?? 'initialized';
  const agents = frameworkState === 'initialized' ? plan.agents.map((agent) => agent.id) : [];
  const workload: ManifestWorkload = plan.workload === 'power-apps-code-app'
    ? {
        kind: 'power-apps-code-app',
        starter: plan.starter,
        codeAppsPlugin: plan.codeAppsPlugin
      }
    : plan.workload === 'genai'
      ? {
          kind: 'genai',
          apiStack: plan.apiStack.id,
          pattern: plan.pattern.id,
          cloud: plan.provider.id,
          region: plan.region.slug,
          frontend: plan.includeFrontend,
          environments: plan.environments.map((environment) => environment.id)
        }
      : {
          kind: 'standard',
          apiStack: plan.apiStack.id,
          cloud: plan.provider.id,
          region: plan.region.slug,
          frontend: plan.includeFrontend,
          environments: plan.environments.map((environment) => environment.id)
        };
  return {
    artifactVersion: 7,
    generatedBy: 'Mission Control Liftoff',
    liftoffVersion,
    project: {
      name: plan.projectName,
      workload,
      specWorkflow: plan.specWorkflow.id,
      agents,
      ...(frameworkState === 'initialized' && plan.defaultAgent ? { defaultAgent: plan.defaultAgent.id } : {}),
    },
    framework: {
      state: frameworkState,
      adapter: plan.framework.id,
      ...(frameworkState === 'initialized' ? { contractVersion: plan.framework.version } : {})
    },
    governance: plan.governanceProfile.id === 'none'
      ? {
          profile: 'none',
          state: 'disabled'
        }
      : {
          profile: plan.governanceProfile.id,
          policyVersion: governancePolicyVersion,
          activationIdentity: currentActivationIdentity,
          state: 'handoff-generated'
        },
    managedArtifacts: artifacts
      .filter((artifact) => artifact.lifecycle === 'managed-core')
      .map((artifact) => ({
        logicalName: artifact.logicalName,
        category: artifact.category,
        pathParts: artifact.pathParts,
        contentHash: contentHash(artifact.content)
      })),
    projectArtifacts: options.projectArtifacts ?? artifacts
      .filter((artifact): artifact is Extract<GeneratedArtifact, { lifecycle: 'project' }> =>
        artifact.lifecycle === 'project'
      )
      .map((artifact) => ({
        logicalName: artifact.logicalName,
        category: artifact.category,
        pathParts: artifact.pathParts,
        generatedBy: liftoffVersion,
        generationHash: contentHash(artifact.content),
        provisioningGroup: artifact.provisioningGroup
      }))
  };
}

function addBaseArtifacts(
  add: AddArtifact,
  addDesiredState: AddArtifact,
  plan: ApiProjectPlan
): void {
  add('root-readme', 'documentation', ['README.md'], renderRootReadme(plan));
  add('root-gitignore', 'project', ['.gitignore'], renderGeneratedGitignore());
  addDesiredState('liftoff-config', 'project', ['liftoff.config.json'], JSON.stringify({
    projectName: plan.projectName,
    projectType: plan.projectType.id,
    apiStack: plan.apiStack.id,
    ...(plan.workload === 'genai' ? { pattern: plan.pattern.id } : {}),
    cloud: plan.provider.id,
    region: plan.region.slug,
    includeFrontend: plan.includeFrontend,
    environments: plan.environments.map((environment) => environment.id),
    specWorkflow: plan.specWorkflow.id,
    agents: plan.agents.map((agent) => agent.id),
    ...(plan.defaultAgent ? { defaultAgent: plan.defaultAgent.id } : {}),
    governanceProfile: plan.governanceProfile.id
  }, null, 2));
  add('env-example', 'configuration', ['.env.example'], renderEnvExample(plan));
  add(
    'backend-dockerfile',
    'runtime',
    ['Dockerfile'],
    plan.workload === 'genai' ? renderBackendDockerfile() : renderStandardDockerfile(plan)
  );
}

function addPowerAppsProjectConfig(
  add: AddArtifact,
  plan: Extract<ProjectPlan, { workload: 'power-apps-code-app' }>
): void {
  add('liftoff-config', 'project', ['liftoff.config.json'], JSON.stringify({
    projectName: plan.projectName,
    projectType: plan.projectType.id,
    specWorkflow: plan.specWorkflow.id,
    agents: plan.agents.map((agent) => agent.id),
    ...(plan.defaultAgent ? { defaultAgent: plan.defaultAgent.id } : {}),
    codeAppsPlugin: plan.codeAppsPlugin,
    governanceProfile: plan.governanceProfile.id
  }, null, 2));
}

function addBackendArtifacts(add: AddArtifact, plan: GenAiProjectPlan): void {
  const routeModule = pyModule(genAiPattern(plan).id);
  add('backend-pyproject', 'backend', ['backend', 'pyproject.toml'], renderBackendPyproject(plan));
  add('backend-uv-lock', 'backend', ['backend', 'uv.lock'], renderPythonLock('genai', `${plan.safeProjectName}-backend`));
  add('backend-package', 'backend', ['backend', '__init__.py'], '');
  add('backend-api-package', 'backend', ['backend', 'apis', '__init__.py'], '');
  add('backend-main', 'backend', ['backend', 'apis', 'main.py'], renderFastApiMain(plan, routeModule));
  add('backend-health-routes', 'backend', ['backend', 'apis', 'routes', 'health.py'], renderHealthRoutes());
  add('backend-pattern-routes', 'backend', ['backend', 'apis', 'routes', `${routeModule}.py`], renderPatternRoutes(plan));
  add('backend-routes-package', 'backend', ['backend', 'apis', 'routes', '__init__.py'], '');
  add('backend-auth-dependency', 'backend', ['backend', 'apis', 'dependencies', 'auth.py'], renderAuthDependency());
  add('backend-config-package', 'backend', ['backend', 'config', '__init__.py'], '');
  add('backend-settings', 'backend', ['backend', 'config', 'settings.py'], renderSettings(plan));
  add('backend-orchestration-package', 'backend', ['backend', 'orchestration', '__init__.py'], '');
  add('backend-model-config', 'backend', ['backend', 'orchestration', 'model_config.py'], renderModelConfig(plan));
  add('backend-messaging-tool', 'backend', ['backend', 'orchestration', 'tools', 'messaging.py'], renderMessagingBoundary());
  add('backend-tools-package', 'backend', ['backend', 'orchestration', 'tools', '__init__.py'], '');
  add('backend-observability', 'backend', ['backend', 'observability', 'tracing.py'], renderTracing());
  add('backend-observability-package', 'backend', ['backend', 'observability', '__init__.py'], '');
  add('backend-test-health', 'backend-test', ['backend', 'tests', 'test_health.py'], renderBackendHealthTest());
  add('backend-test-messaging', 'backend-test', ['backend', 'tests', 'test_messaging.py'], renderMessagingTest());
  add('backend-test-tracing', 'backend-test', ['backend', 'tests', 'test_tracing.py'], renderTracingTest());
}

function addDatabaseArtifacts(add: AddArtifact, plan: GenAiProjectPlan): void {
  add('database-alembic-ini', 'database', ['database', 'alembic.ini'], renderAlembicIni());
  add('database-alembic-env', 'database', ['database', 'migrations', 'env.py'], renderAlembicEnv());
  add('database-initial-migration', 'database', ['database', 'migrations', 'versions', '0001_initial.py'], renderInitialMigration(plan));
  add('database-schema', 'database', ['database', 'models', 'schema.sql'], renderDatabaseSchema(plan));
}

function addPatternArtifacts(add: AddArtifact, plan: GenAiProjectPlan): void {
  const pattern = genAiPattern(plan);
  const routeModule = pyModule(pattern.id);
  add('pattern-agent', 'pattern', ['backend', 'orchestration', 'agents', `${routeModule}_agent.py`], renderPatternAgent(plan));
  add('pattern-agent-test', 'backend-test', ['backend', 'tests', `test_${routeModule}_orchestration.py`], renderPatternAgentTest(plan));
  add('pattern-prompt', 'pattern', ['backend', 'orchestration', 'prompts', `${pattern.id}.md`], renderPromptTemplate(plan));
  add('pattern-agent-package', 'pattern', ['backend', 'orchestration', 'agents', '__init__.py'], '');
  add('pattern-prompt-readme', 'pattern', ['backend', 'orchestration', 'prompts', 'README.md'], renderPromptReadme());

  if (pattern.id === 'rag') {
    add('rag-vector-store', 'pattern', ['backend', 'orchestration', 'retrieval', 'vector_store.py'], renderVectorStore());
    add('rag-retrieval-package', 'pattern', ['backend', 'orchestration', 'retrieval', '__init__.py'], '');
  }

  if (pattern.worker) {
    add('pattern-worker', 'pattern', ['backend', 'workers', `${routeModule}_worker.py`], renderPatternWorker(plan));
    add('backend-workers-package', 'pattern', ['backend', 'workers', '__init__.py'], '');
  }

  if (pattern.id === 'fine-tuned') {
    add('fine-tuned-eval-dataset', 'pattern', ['backend', 'evaluation', 'datasets', 'sample.jsonl'], '{"input":"Example request","expected":"Expected response placeholder"}');
  }
}

function addFunctionArtifacts(add: AddArtifact, plan: GenAiProjectPlan): void {
  if (!hasFunctionWorker(plan)) {
    return;
  }

  const workerName = functionWorkerName(plan);
  const workerBase = ['functions', workerName];
  add('functions-readme', 'functions', ['functions', 'README.md'], renderFunctionsReadme());
  add('function-worker-readme', 'functions', [...workerBase, 'README.md'], renderFunctionWorkerReadme(plan));
  add('function-worker-host', 'functions', [...workerBase, 'host.json'], renderFunctionHostJson());
  add('function-worker-local-settings', 'functions', [...workerBase, 'local.settings.example.json'], renderFunctionLocalSettings(plan));
  add('function-worker-requirements', 'functions', [...workerBase, 'requirements.txt'], renderFunctionRequirements());
  add('function-worker-app', 'functions', [...workerBase, 'function_app.py'], renderFunctionApp(plan));
  add('function-worker-test', 'functions-test', [...workerBase, 'tests', 'test_function_app.py'], renderFunctionTest());
  add('function-worker-funcignore', 'functions', [...workerBase, '.funcignore'], renderFunctionFuncIgnore());
  add('function-worker-gitignore', 'functions', [...workerBase, '.gitignore'], renderFunctionGitIgnore());
}

function addEnvironmentArtifacts(
  artifacts: GeneratedArtifact[],
  plan: ApiProjectPlan
): void {
  for (const environment of plan.environments) {
    const add = createArtifactAdder(
      artifacts,
      'project',
      `environment:${environment.id}`
    );
    add(
      `environment-${environment.id}-backend`,
      'environment',
      ['environments', environment.id, 'backend.env'],
      plan.workload === 'genai' ? renderBackendEnv(plan, environment.id) : renderStandardEnv(plan, environment.id)
    );
    if (plan.workload === 'genai' && hasFunctionWorker(plan)) {
      add(`environment-${environment.id}-functions`, 'environment', ['environments', environment.id, 'functions.env'], renderFunctionsEnv(plan, environment.id));
    }
  }
}

function addDockerArtifacts(add: AddArtifact, plan: ApiProjectPlan): void {
  add('docker-compose', 'local-development', ['docker-compose.yml'], renderDockerCompose(plan));
}

function addInfrastructureArtifacts(
  add: AddArtifact,
  artifacts: GeneratedArtifact[],
  plan: ApiProjectPlan
): void {
  const base = ['infrastructure', 'opentofu', 'azure'];
  add('opentofu-versions', 'infrastructure', [...base, 'versions.tf'], renderOpenTofuVersions());
  add(
    'opentofu-provider-lock',
    'infrastructure',
    [...base, '.terraform.lock.hcl'],
    renderOpenTofuProviderLock()
  );
  add('opentofu-providers', 'infrastructure', [...base, 'providers.tf'], renderTofuProviders());
  add('opentofu-variables', 'infrastructure', [...base, 'variables.tf'], renderTofuVariables(plan));
  add('opentofu-main', 'infrastructure', [...base, 'main.tf'], renderTofuMain(plan));
  add('opentofu-outputs', 'infrastructure', [...base, 'outputs.tf'], renderTofuOutputs(plan));
  add('opentofu-local-state', 'infrastructure', [...base, 'backend.local.tf'], renderTofuLocalState());
  add('opentofu-remote-state-example', 'infrastructure', [...base, 'backend.remote.example.tf'], renderTofuRemoteStateExample());
  add('opentofu-readme', 'infrastructure', [...base, 'README.md'], renderTofuReadme(plan));
  for (const environment of plan.environments) {
    createArtifactAdder(
      artifacts,
      'project',
      `environment:${environment.id}`
    )(
      `opentofu-${environment.id}-tfvars`,
      'infrastructure',
      [...base, 'environments', `${environment.id}.tfvars`],
      renderTofuTfvars(plan, environment.id)
    );
  }
}

function addSpecWorkflowArtifacts(
  addSeed: AddArtifact,
  addFramework: AddArtifact,
  plan: ProjectPlan
): void {
  if (plan.workload === 'power-apps-code-app') {
    if (plan.specWorkflow.id === 'openspec') {
      const changeName = `bootstrap-${plan.safeProjectName}`;
      addSeed('openspec-config', 'seed', ['openspec', 'config.yaml'], renderPowerAppsOpenSpecConfig(plan));
      addSeed('openspec-seed-change-metadata', 'seed', ['openspec', 'changes', changeName, '.openspec.yaml'], 'schema: spec-driven');
      addSeed('openspec-seed-proposal', 'seed', ['openspec', 'changes', changeName, 'proposal.md'], renderPowerAppsSeedProposal(plan));
      addSeed('openspec-seed-design', 'seed', ['openspec', 'changes', changeName, 'design.md'], renderPowerAppsSeedDesign(plan));
      addSeed('openspec-seed-tasks', 'seed', ['openspec', 'changes', changeName, 'tasks.md'], renderSeedTasks(plan));
      addSeed('openspec-seed-spec', 'seed', ['openspec', 'changes', changeName, 'specs', seedCapabilityId(plan), 'spec.md'], renderSeedSpec(plan));
      addSeed('openspec-spec-placeholder', 'seed', ['openspec', 'specs', '.gitkeep'], '');
    } else {
      addSeed('spec-kit-constitution', 'seed', ['.specify', 'memory', 'constitution.md'], renderPowerAppsSpecKitConstitution(plan));
      addFramework('spec-kit-spec-template', 'framework', ['.specify', 'templates', 'spec-template.md'], renderSpecKitSpecTemplate());
      addFramework('spec-kit-plan-template', 'framework', ['.specify', 'templates', 'plan-template.md'], renderSpecKitPlanTemplate());
      addSeed('specs-placeholder', 'seed', ['specs', '.gitkeep'], '');
    }
    return;
  }
  if (plan.specWorkflow.id === 'openspec') {
    const changeName = `bootstrap-${plan.safeProjectName}`;
    addSeed('openspec-config', 'seed', ['openspec', 'config.yaml'], renderOpenSpecConfig(plan));
    addSeed('openspec-seed-change-metadata', 'seed', ['openspec', 'changes', changeName, '.openspec.yaml'], 'schema: spec-driven');
    addSeed('openspec-seed-proposal', 'seed', ['openspec', 'changes', changeName, 'proposal.md'], renderSeedProposal(plan));
    addSeed('openspec-seed-design', 'seed', ['openspec', 'changes', changeName, 'design.md'], renderSeedDesign(plan));
    addSeed('openspec-seed-tasks', 'seed', ['openspec', 'changes', changeName, 'tasks.md'], renderSeedTasks(plan));
    addSeed('openspec-seed-spec', 'seed', ['openspec', 'changes', changeName, 'specs', seedCapabilityId(plan), 'spec.md'], renderSeedSpec(plan));
    addSeed('openspec-spec-placeholder', 'seed', ['openspec', 'specs', '.gitkeep'], '');
  } else {
    addSeed('spec-kit-constitution', 'seed', ['.specify', 'memory', 'constitution.md'], renderSpecKitConstitution(plan));
    addFramework('spec-kit-spec-template', 'framework', ['.specify', 'templates', 'spec-template.md'], renderSpecKitSpecTemplate());
    addFramework('spec-kit-plan-template', 'framework', ['.specify', 'templates', 'plan-template.md'], renderSpecKitPlanTemplate());
    addSeed('specs-placeholder', 'seed', ['specs', '.gitkeep'], '');
  }
}

function renderPowerAppsOpenSpecConfig(
  plan: Extract<ProjectPlan, { workload: 'power-apps-code-app' }>
): string {
  return `schema: spec-driven${renderOpenSpecCopilotConfig(plan)}
context: |
  Project: ${plan.projectName}
  Workload: Microsoft Power Apps code app
  Stack: React, Vite, TypeScript, Tailwind CSS, Power Apps SDK
  Starter: ${plan.starter.repository}/${plan.starter.path}@${plan.starter.commit}
  Runtime boundary: browser-hosted code app with connector-first data access
  Environment binding: explicit post-scaffold Power Apps CLI action
rules:
  proposal:
    - Keep tenant, environment, connection, solution, and deployment choices explicit.
  design:
    - Prefer Power Platform connectors and generated service modules over custom APIs.
    - Do not add Liftoff-owned Azure or API infrastructure unless a later change explicitly introduces it.
  tasks:
    - Include npm lint and build verification.
`;
}

function renderOpenSpecCopilotConfig(plan: ProjectPlan): string {
  return plan.agents.some((agent) => agent.id === 'github-copilot')
    ? `
githubCopilot:
  cloudAgent: ${plan.copilotCloud}
`
    : '\n';
}

function renderPowerAppsSeedProposal(
  plan: Extract<ProjectPlan, { workload: 'power-apps-code-app' }>
): string {
  const capability = seedCapabilityId(plan);
  return `# Proposal: bootstrap-${plan.safeProjectName}

## Why

Bootstrap the generated ${plan.projectName} Power Apps code app baseline created by Mission Control Liftoff.

## What Changes

- Establish the generated React, Vite, TypeScript, Tailwind CSS, Power Apps SDK, workflow, and governance baseline.
- Confirm that tenant binding, authentication, connector choices, solution packaging, deployment, and domain-specific product behavior are deferred to follow-up changes.

## Capabilities

### New Capabilities

- \`${capability}\`: Generated Power Apps code app baseline for this Liftoff project.

### Modified Capabilities

- None.

## Impact

- Generated Power Apps starter files, package metadata, workflow files, and governance files.
- No Liftoff-owned backend API, Docker stack, Azure resources, \`power.config.json\`, tenant binding, credentials, or deployment.
`;
}

function renderPowerAppsSeedDesign(
  plan: Extract<ProjectPlan, { workload: 'power-apps-code-app' }>
): string {
  return `# Design: bootstrap-${plan.safeProjectName}

## Context

The project uses React, Vite, TypeScript, Tailwind CSS, and Microsoft's Power Apps SDK.
It was initialized from \`${plan.starter.path}\` at \`${plan.starter.commit}\`.

## Goals / Non-Goals

**Goals:**

- Keep the generated baseline aligned to the approved Mission Control Power Apps code app stack.
- Verify only deterministic local scaffold checks before archiving this bootstrap change.

**Non-Goals:**

- Define domain-specific product behavior, including screens, connector behavior, tenant binding, solution packaging, deployment, or credentials, in the bootstrap change.

## Decisions

- Keep pages under \`src/pages\` and shared UI under \`src/components\`.
- Keep connector and generated service boundaries explicit under \`src\`.
- Use TanStack Query for server state and Zustand only for local client state.
- Bind to a tenant and environment only through Microsoft's Power Apps CLI.

## Risks / Trade-offs

- Follow-up product changes own real business behavior; this seed only proves the generated local baseline is coherent.
`;
}

function renderPowerAppsSpecKitConstitution(
  plan: Extract<ProjectPlan, { workload: 'power-apps-code-app' }>
): string {
  return `# ${plan.projectName} Constitution

## I. Power Apps workload boundary

The application MUST remain a Power Apps code app using React, Vite, TypeScript, Tailwind CSS,
the Power Apps SDK, and the Power Apps Vite plugin. Tenant and environment binding MUST remain
an explicit developer action.

## II. Connector-first integration

Features MUST prefer Power Platform connectors and generated service modules. A custom API or
Azure resource requires an explicit specification and MUST NOT be inferred from this scaffold.

## III. Project structure

Pages belong under \`src/pages\`, shared UI under \`src/components\`, and reusable providers or
connector boundaries under named \`src\` modules. \`power.config.json\` is never fabricated.

## IV. Quality gates

Every change MUST pass the applicable npm lint and build checks plus \`liftoff validate\`.
`;
}

function addFrontendArtifacts(add: AddArtifact, plan: ApiProjectPlan): void {
  add('frontend-package', 'frontend', ['frontend', 'package.json'], renderFrontendPackage(plan));
  add('frontend-lock', 'frontend', ['frontend', 'package-lock.json'], renderNpmLock('frontend', `${plan.safeProjectName}-frontend`));
  add('frontend-index', 'frontend', ['frontend', 'index.html'], renderFrontendIndex(plan));
  add('frontend-main', 'frontend', ['frontend', 'src', 'main.ts'], renderFrontendMain());
  add('frontend-app', 'frontend', ['frontend', 'src', 'App.vue'], renderFrontendApp(plan));
  add('frontend-env-example', 'frontend', ['frontend', '.env.example'], 'VITE_API_BASE_URL=http://localhost:8000');
  add('frontend-styles', 'frontend', ['frontend', 'src', 'styles.css'], renderFrontendStyles());
  add('frontend-vite-config', 'frontend', ['frontend', 'vite.config.ts'], renderFrontendViteConfig());
  add('frontend-tailwind-config', 'frontend', ['frontend', 'tailwind.config.ts'], renderFrontendTailwindConfig());
  add('frontend-dockerfile', 'frontend', ['frontend', 'Dockerfile'], renderFrontendDockerfile());
}

function renderDirectBuildAndTestGuide(plan: ApiProjectPlan): string {
  let backendCommands: string;
  if (plan.workload === 'genai' || plan.apiStack.id === 'python-fastapi') {
    const extras = plan.workload === 'genai' && hasFunctionWorker(plan)
      ? ' --extra functions'
      : '';
    backendCommands = `uv sync --frozen --project backend --extra test${extras}
uv run --project backend python -m pytest -q backend/tests`;
  } else if (plan.apiStack.id === 'node-fastify') {
    backendCommands = `cd backend
npm ci
npm run build
npm test`;
  } else {
    backendCommands = `cd backend
go mod download
go test ./...`;
  }
  const frontendCommands = plan.includeFrontend ? `

Build the frontend without a running backend:

\`\`\`bash
cp frontend/.env.example frontend/.env
cd frontend
npm ci
npm run build
\`\`\`
` : '';
  const functionCommands = plan.workload === 'genai' && hasFunctionWorker(plan) ? `

Run the Function worker unit tests from the same locked Python environment:

\`\`\`bash
(cd functions/${functionWorkerName(plan)} && uv run --project ../../backend --directory . python -m pytest -q)
\`\`\`
` : '';
  return `## Project Dependencies, Build, And Test

\`liftoff init --install-dependencies\` runs the selected stack's locked project-local dependency commands. To run or resume them manually:

\`\`\`bash
${backendCommands}
\`\`\`

${frontendCommands}${functionCommands}`;
}

function renderDeterministicSetupGuide(plan: ApiProjectPlan): string {
  const backend = plan.workload === 'genai' || plan.apiStack.id === 'python-fastapi'
    ? '`uv run --project backend python -m pytest -q backend/tests`'
    : plan.apiStack.id === 'node-fastify'
      ? '`npm test` from `backend/` after `npm ci` and `npm run build`'
      : '`go test ./...` from `backend/`';
  const frontend = plan.includeFrontend
    ? '- Frontend build: `npm run build` from `frontend/` after `npm ci`.'
    : '- Frontend build: inapplicable because no frontend was generated.';
  const governance = plan.governanceProfile.id === 'none'
    ? 'Repository governance is disabled, so there is no `/liftoff-setup` integration, managed phase graph, or post-init governance activation path.'
    : 'Run `/liftoff-setup` from a selected agent. It completes, syncs, and archives the generated bootstrap seed, then stops at explicit authority gates. Commit and push are separate approvals, and rerunning `/liftoff-setup` resumes idempotently without repeating verified phases.';
  return `## Deterministic Setup

${governance}

The local baseline contains only applicable checks:

- \`liftoff validate\`
- Backend tests: ${backend}
${frontend}
- \`docker compose config -q\`
- \`tofu fmt -check -recursive\`
- \`tofu init -backend=false\`
- \`tofu validate\`
- strict ${plan.specWorkflow.label} validation

No baseline step runs a live OpenTofu plan or apply, starts containers, deploys,
mutates GitHub, or asks for cloud credentials. Absent components are recorded as
inapplicable rather than simulated. After setup archives the seed, use normal
OpenSpec or Spec Kit changes for features and the governed GitFlow release path
after activation evidence is green.
`;
}

function renderAdvisoryReadinessGuide(plan: ApiProjectPlan): string {
  const selected: WorkstationRequirementId[] = [
    'docker',
    'opentofu',
    ...(plan.provider.id === 'azure' ? ['azure-cli' as const] : [])
  ];
  return selected.map((id) => {
    const requirement = workstationRequirementCatalog[id];
    const mac = requirement.install.darwin;
    const windows = requirement.install.win32;
    const commands = [
      ...(mac ? [`macOS: \`${formatCommand(mac.command)}\``] : []),
      ...(windows ? [`Windows: \`${formatCommand(windows.command)}\``] : []),
      `Linux: ${requirement.linuxRemedies.unknown}`
    ].join('; ');
    const health = id === 'docker'
      ? ' After installation, start Docker Desktop or the Docker daemon.'
      : id === 'azure-cli'
        ? ' After installation, run `az login` if authentication is not ready.'
        : '';
    return `- ${requirement.label}: ${commands}.${health}`;
  }).join('\n');
}

function renderSpecWorkflowGuide(plan: ApiProjectPlan): string {
  const agents = plan.agents.map((agent) =>
    `${agent.label}${plan.defaultAgent?.id === agent.id ? ' (default integration)' : ''}`
  ).join(', ');
  const ownership = plan.specWorkflow.id === 'openspec'
    ? 'OpenSpec workflow skills, commands, configuration, and optional cloud-agent files'
    : 'Spec Kit core files, integration state, and the selected Copilot or Claude skill integrations';
  const openSpecDetails = plan.specWorkflow.id === 'openspec'
    ? [
        `- OpenSpec profile: ${OPEN_SPEC_PROFILE}; delivery: ${OPEN_SPEC_DELIVERY}; workflows: ${OPEN_SPEC_WORKFLOW_IDS.join(', ')}`,
        ...(plan.agents.some((agent) => agent.id === 'github-copilot')
          ? ['- GitHub Copilot cloud agent: controlled by `githubCopilot.cloudAgent` in `openspec/config.yaml`']
          : [])
      ].join('\n')
    : '';
  return `## Spec-Driven Workflow And Validation

- Workflow: ${plan.specWorkflow.label} ${plan.framework.version}
- AI coding agents: ${agents}
${openSpecDetails ? `${openSpecDetails}\n` : ''}
- Framework ownership: the official initializer owns ${ownership}. Liftoff validates these files but excludes framework-owned output and one-time seed content from managed-core hashes.
- Deferred tools: advisory workstation checks may be deferred. Liftoff never claims they are installed and never installs them without \`--install-tools\`.

If \`liftoff doctor\` reports a selected advisory tool as missing, use its registered readiness remedy:

${renderAdvisoryReadinessGuide(plan)}

Validate the scaffold and workstation after setup:

\`\`\`bash
liftoff validate
liftoff doctor
\`\`\`

For an existing OpenSpec project, change workflow delivery with \`openspec config profile\` and refresh framework-owned files with \`openspec update\`. Plain \`liftoff update\` does not regenerate OpenSpec integrations.
`;
}

function renderGeneratedConfigurationGuide(plan: ApiProjectPlan): string {
  const frontendConfiguration = plan.includeFrontend
    ? '\n- `frontend/.env` configures `VITE_API_BASE_URL`; the production build does not contact the backend.'
    : '';
  if (plan.workload === 'standard') {
    return `## Runtime Configuration

Copy \`.env.example\` to \`.env\` before running outside Docker Compose. The backend requires \`DATABASE_URL\` and \`REDIS_URL\`. \`CORS_ALLOWED_ORIGINS\` is a comma-separated allowlist and defaults to the local frontend at \`http://localhost:5173\`.${frontendConfiguration}
`;
  }
  return `## Starter Integration Configuration

Copy \`.env.example\` to \`.env\`, then configure only the integrations you use:

- \`PYDANTIC_AI_MODEL\` is required when production orchestration is invoked. If it is absent, the agent raises an explicit configuration error rather than returning a placeholder answer.
- Redis Streams uses \`REDIS_URL\` and \`REDIS_STREAM_NAME\`.
- Azure Service Bus uses \`SERVICE_BUS_QUEUE_NAME\` plus either \`SERVICE_BUS_CONNECTION_STRING\` or \`SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE\`; set \`AZURE_CLIENT_ID\` when selecting a user-assigned managed identity.
- Langfuse requires both \`LANGFUSE_PUBLIC_KEY\` and \`LANGFUSE_SECRET_KEY\`, with optional \`LANGFUSE_HOST\`. Without both keys, tracing is explicitly disabled and no remote trace ID is reported.${frontendConfiguration}
- \`CORS_ALLOWED_ORIGINS\` is a comma-separated frontend-origin allowlist and defaults to \`http://localhost:5173\`.
`;
}

function renderGeneratedUpdateGuide(plan: ProjectPlan): string {
  const governance = plan.governanceProfile.id === 'none'
    ? 'Repository governance is disabled for this project, so Liftoff does not generate setup integrations, a managed phase graph, credential-policy schema, or post-init setup command.'
    : '`single-maintainer-gitflow` repository governance generates deterministic setup artifacts only. Review `.liftoff/governance/README.md`, then run `/liftoff-setup` from a selected agent. Live enforcement requires evidence and explicit approval; it is never inferred from generated files.';
  return `## Safe Liftoff Updates

\`liftoff upgrade\` replaces a supported global Liftoff CLI installation; it does not inspect or modify this project. Check and apply CLI replacement separately with \`liftoff upgrade --check\` and \`liftoff upgrade\`.

${governance}

\`liftoff update\` maintains only explicit Liftoff core files, currently the repository-governance policy, context, guide, phase graph, credential-policy schema, and selected-agent \`/liftoff-setup\` integrations. Use \`liftoff update --check\` for a read-only core report, or \`liftoff update --check --json\` as an automation gate that exits 0 when core state is clean and 2 when maintenance is available.

Application source, tests, dependencies and locks, schemas, containers, environment files, documentation, and infrastructure become project-owned after generation. No update mode, including \`--force\`, can restore or replace them. Enabling a previously absent frontend or environment in \`liftoff.config.json\` may provision that component once at absent destinations; a collision blocks the whole component and cannot be forced.

Project template modernization is a separately reviewed production change and is not performed by ordinary update or by the existing non-Liftoff \`migrate\` command. Managed-core conflicts are skipped by default; after reviewing every listed core path, \`liftoff update --force\` may replace only those core conflicts. Managed-core orphans remain on disk, and update never installs dependencies. A failed transaction is rolled back, but Liftoff retains no backup after a successful core overwrite.

Liftoff rejects malformed, traversal, absolute, drive-qualified, UNC, separator-containing, or symlink-escaping manifest paths before artifact access. If the manifest is unsafe or malformed, restore \`liftoff.manifest.json\` from version control or regenerate the project with a matching Liftoff version; do not hand-edit unsafe paths. Run \`liftoff <command> --help\` for command-specific syntax because unknown flags, subcommands, values, and extra arguments fail before any write.
`;
}

function renderRootReadme(plan: ApiProjectPlan): string {
  if (plan.workload === 'standard') {
    return `# ${plan.projectName}

Generated by Mission Control Liftoff.

## Stack

- Project type: Standard application
- API: ${plan.apiStack.label}
- Database tooling: ${plan.apiStack.databaseTooling}
- API reference: Scalar with OpenAPI
- Cloud: ${plan.provider.label} (${plan.region.slug})
- Infrastructure: OpenTofu
- Database: PostgreSQL
- Cache and local messaging: Redis
- Local development: Docker Compose
${plan.includeFrontend ? '- Frontend: Vue 3 with Tailwind\n' : ''}
${renderDeterministicSetupGuide(plan)}
## Local Development

\`\`\`bash
docker compose up --build
\`\`\`

The backend API is available on port 8000. Health and readiness endpoints are available at \`/health\` and \`/ready\`; Scalar is exposed at \`/scalar\`.

${renderGeneratedConfigurationGuide(plan)}
${renderDirectBuildAndTestGuide(plan)}
${renderGeneratedUpdateGuide(plan)}
## Infrastructure

\`\`\`bash
cd infrastructure/opentofu/azure
tofu init
tofu plan -var-file=environments/dev.tfvars
tofu apply -var-file=environments/dev.tfvars
\`\`\`

The first apply uses a public bootstrap image. Follow \`infrastructure/opentofu/azure/README.md\` to build the generated backend in ACR and apply its image.

${renderSpecWorkflowGuide(plan)}
`;
  }

  const pattern = genAiPattern(plan);
  const functionsStackLine = hasFunctionWorker(plan) ? `- Azure Functions worker: Python v2 Service Bus trigger under \`functions/${functionWorkerName(plan)}\`
` : '';
  const functionsSection = hasFunctionWorker(plan) ? `
## Azure Functions Worker

Azure Functions trigger adapters live under \`functions/${functionWorkerName(plan)}\`. Keep reusable GenAI orchestration under \`backend/orchestration\`; \`backend/workers\` remains the place for backend-adjacent or containerized worker code.
` : '';
  const genericSection = pattern.id === 'generic' ? `
## Choosing A Specialization Later

This project intentionally starts with a neutral text-in/result-out GenAI boundary. It does not assume RAG, conversation history, agent tools, streaming, fine-tuning, multi-agent coordination, or workflow orchestration.

Generated application files are project-owned. When requirements become clear, specialize through a reviewed project change; \`liftoff update\` and \`--force\` do not convert this project to another GenAI pattern.
` : '';
  return `# ${plan.projectName}

Generated by Mission Control Liftoff.

## Stack

- Backend: FastAPI, PydanticAI, Pydantic settings, Scalar
- Pattern: ${pattern.label}
- Cloud: ${plan.provider.label} (${plan.region.slug})
- Infrastructure: OpenTofu
- Database: PostgreSQL with Alembic migrations${pattern.id === 'rag' ? ' and pgvector retrieval' : ''}
- Cache and local messaging: Redis
- Observability: Langfuse
- Local development: Docker Compose
${functionsStackLine}
${plan.includeFrontend ? '- Frontend: Vue 3 with Tailwind\n' : ''}
${renderDeterministicSetupGuide(plan)}
## Local Development

\`\`\`bash
docker compose up --build
docker compose --profile observability up --build
\`\`\`

The backend API is available on port 8000. Scalar is exposed at \`/scalar\`.

${renderGeneratedConfigurationGuide(plan)}
${renderDirectBuildAndTestGuide(plan)}
${renderGeneratedUpdateGuide(plan)}
## Infrastructure

\`\`\`bash
cd infrastructure/opentofu/azure
tofu init
tofu plan -var-file=environments/dev.tfvars
tofu apply -var-file=environments/dev.tfvars
\`\`\`

The first apply uses a public bootstrap image. Follow \`infrastructure/opentofu/azure/README.md\` to build the generated backend in ACR and apply its image.

${renderSpecWorkflowGuide(plan)}
${functionsSection}
${genericSection}
`;
}

function renderGeneratedGitignore(): string {
  return `.venv/
__pycache__/
.pytest_cache/
node_modules/
dist/
.env
migration/legacy/
*.tfstate
*.tfstate.*
.terraform/
`;
}

function renderEnvExample(plan: ApiProjectPlan): string {
  if (plan.workload === 'standard') {
    return renderStandardEnv(plan);
  }
  const pattern = genAiPattern(plan);
  return `APP_ENV=dev
APP_NAME=${plan.safeProjectName}
GENAI_PATTERN=${pattern.id}
CLOUD_PROVIDER=${plan.provider.id}
AZURE_REGION=${plan.region.slug}
DATABASE_URL=postgresql+asyncpg://postgres:postgres@postgres:5432/${plan.safeProjectName.replace(/-/g, '_')}
REDIS_URL=redis://redis:6379/0
REDIS_STREAM_NAME=liftoff-events
MESSAGING_TRANSPORT=redis-streams
SERVICE_BUS_QUEUE_NAME=${DEFAULT_FUNCTION_WORKER_QUEUE_NAME}
SERVICE_BUS_CONNECTION_STRING=
SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE=
AZURE_CLIENT_ID=
BLOB_ENDPOINT=http://azurite:10000/devstoreaccount1
CORS_ALLOWED_ORIGINS=http://localhost:5173
PYDANTIC_AI_MODEL=
LANGFUSE_HOST=http://langfuse:3000
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
`;
}

function renderBackendDockerfile(): string {
  return `FROM ${formatContainerImage(supportedStack.containers['uv-tool'])} AS uv
FROM ${formatContainerImage(supportedStack.containers['python-runtime'])}

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app
ENV PATH=/app/backend/.venv/bin:$PATH
COPY --from=uv /uv /uvx /bin/

ARG UV_DEFAULT_INDEX=https://pypi.org/simple
COPY backend/pyproject.toml /app/backend/pyproject.toml
COPY backend/uv.lock /app/backend/uv.lock
RUN --mount=type=cache,target=/root/.cache/uv \\
    uv export --frozen --no-dev --no-emit-project --project /app/backend --output-file /tmp/requirements.txt \\
    && uv venv /app/backend/.venv \\
    && uv pip install --python /app/backend/.venv/bin/python --require-hashes \\
      --default-index "$UV_DEFAULT_INDEX" --requirements /tmp/requirements.txt \\
    && rm /tmp/requirements.txt

COPY backend /app/backend
COPY database /app/database

EXPOSE 8000
CMD ["uvicorn", "backend.apis.main:app", "--host", "0.0.0.0", "--port", "8000"]
`;
}

function renderBackendPyproject(plan: GenAiProjectPlan): string {
  return renderPythonPyprojectAsset('genai', `${plan.safeProjectName}-backend`);
}

function renderFastApiMain(plan: GenAiProjectPlan, routeModule: string): string {
  return `from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

try:
    from scalar_fastapi import get_scalar_api_reference
except ImportError:  # pragma: no cover - dependency is present in generated runtime
    get_scalar_api_reference = None

from backend.apis.routes import health, ${routeModule}
from backend.config.settings import get_settings


settings = get_settings()
app = FastAPI(title=settings.app_name, version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in settings.cors_allowed_origins.split(",")
        if origin.strip()
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(${routeModule}.router)


@app.get("/scalar", include_in_schema=False)
def scalar_reference():
    if get_scalar_api_reference is None:
        return {"message": "Install scalar-fastapi to enable the Scalar developer portal."}
    return get_scalar_api_reference(openapi_url=app.openapi_url, title=f"{app.title} API")
`;
}

function renderHealthRoutes(): string {
  return `from fastapi import APIRouter

router = APIRouter(tags=["operations"])


@router.get("/health")
def health():
    return {"status": "ok"}


@router.get("/ready")
def ready():
    return {"status": "ready"}
`;
}

function renderPatternRoutes(plan: GenAiProjectPlan): string {
  const pattern = genAiPattern(plan);
  const moduleName = pyModule(pattern.id);
  const agentName = `${moduleName}_agent`;
  const prefix = pattern.routePrefix;
  if (pattern.id === 'streaming') {
    return `from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from backend.orchestration.agents.${agentName} import stream_response

router = APIRouter(prefix="${prefix}", tags=["${pattern.id}"])


@router.get("")
def stream(prompt: str):
    return StreamingResponse(stream_response(prompt), media_type="text/event-stream")
`;
  }

  if (pattern.id === 'rag') {
    return `from fastapi import APIRouter
from pydantic import BaseModel

from backend.orchestration.agents.${agentName} import answer_question, enqueue_ingestion

router = APIRouter(prefix="${prefix}", tags=["rag"])


class QueryRequest(BaseModel):
    question: str


class IngestionRequest(BaseModel):
    source_uri: str


@router.post("/query")
async def query(request: QueryRequest):
    return await answer_question(request.question)


@router.post("/ingest")
async def ingest(request: IngestionRequest):
    return await enqueue_ingestion(request.source_uri)
`;
  }

  const bodyClass = `${titleCase(pattern.id).replace(/\s/g, '')}Request`;
  return `from fastapi import APIRouter
from pydantic import BaseModel

from backend.orchestration.agents.${agentName} import run_${moduleName}

router = APIRouter(prefix="${prefix}", tags=["${pattern.id}"])


class ${bodyClass}(BaseModel):
    input: str


@router.post("/run")
async def run(request: ${bodyClass}):
    return await run_${moduleName}(request.input)
`;
}

function renderAuthDependency(): string {
  return `from dataclasses import dataclass


@dataclass(frozen=True)
class CurrentUser:
    subject: str = "local-developer"


async def get_current_user() -> CurrentUser:
    return CurrentUser()
`;
}

function renderSettings(plan: GenAiProjectPlan): string {
  const pattern = genAiPattern(plan);
  return `from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = ${sourceString(plan.projectName)}
    app_env: str = "dev"
    genai_pattern: str = "${pattern.id}"
    cloud_provider: str = "${plan.provider.id}"
    azure_region: str = "${plan.region.slug}"
    database_url: str
    redis_url: str
    redis_stream_name: str = "liftoff-events"
    messaging_transport: str = "redis-streams"
    service_bus_queue_name: str = "${DEFAULT_FUNCTION_WORKER_QUEUE_NAME}"
    service_bus_connection_string: str | None = None
    service_bus_fully_qualified_namespace: str | None = None
    azure_client_id: str | None = None
    blob_endpoint: str | None = None
    cors_allowed_origins: str = "http://localhost:5173"
    pydantic_ai_model: str | None = None
    langfuse_host: str | None = None
    langfuse_public_key: str | None = None
    langfuse_secret_key: str | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()
`;
}

function renderModelConfig(plan: GenAiProjectPlan): string {
  const pattern = genAiPattern(plan);
  return `import os
from dataclasses import dataclass
from typing import Protocol


class ModelConfigurationError(RuntimeError):
    pass


class AgentRunner(Protocol):
    async def run(self, prompt: str) -> str:
        ...


@dataclass(frozen=True)
class ModelConfig:
    model_name: str
    pattern: str = "${pattern.id}"

    @classmethod
    def from_environment(cls) -> "ModelConfig":
        model_name = os.getenv("PYDANTIC_AI_MODEL", "").strip()
        if not model_name:
            raise ModelConfigurationError(
                "PYDANTIC_AI_MODEL is required before invoking production GenAI orchestration. "
                "Use a PydanticAI model name such as 'openai:gpt-4.1-mini'."
            )
        return cls(model_name=model_name)


class PydanticAgentRunner:
    def __init__(self, config: ModelConfig):
        from pydantic_ai import Agent

        self._agent = Agent(config.model_name)

    async def run(self, prompt: str) -> str:
        result = await self._agent.run(prompt)
        output = getattr(result, "output", None)
        if output is None:
            output = getattr(result, "data", None)
        if output is None:
            raise RuntimeError("PydanticAI returned a result without output data.")
        return str(output)


def build_agent_runner(config: ModelConfig | None = None) -> AgentRunner:
    return PydanticAgentRunner(config or ModelConfig.from_environment())
`;
}

function renderMessagingBoundary(): string {
  return `import json
import os
from collections.abc import Callable
from typing import Any, Protocol


class MessagingConfigurationError(RuntimeError):
    pass


class MessagePublisher(Protocol):
    async def publish(self, topic: str, payload: dict) -> None:
        ...


class RedisStreamClient(Protocol):
    async def xadd(self, name: str, fields: dict[str, str]) -> Any:
        ...


class ServiceBusSender(Protocol):
    async def __aenter__(self) -> "ServiceBusSender":
        ...

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        ...

    async def send_messages(self, message: Any) -> None:
        ...


class ServiceBusClient(Protocol):
    def get_queue_sender(self, *, queue_name: str) -> ServiceBusSender:
        ...


def _serialize(topic: str, payload: dict) -> str:
    return json.dumps({"topic": topic, "payload": payload}, separators=(",", ":"), sort_keys=True)


class RedisStreamPublisher:
    def __init__(self, client: RedisStreamClient, stream_name: str):
        self._client = client
        self._stream_name = stream_name

    async def publish(self, topic: str, payload: dict) -> None:
        await self._client.xadd(
            self._stream_name,
            {"topic": topic, "payload": _serialize(topic, payload)},
        )


class AzureServiceBusPublisher:
    def __init__(
        self,
        client: ServiceBusClient,
        queue_name: str,
        message_factory: Callable[[str], Any] | None = None,
    ):
        self._client = client
        self._queue_name = queue_name
        self._message_factory = message_factory or self._default_message_factory

    @staticmethod
    def _default_message_factory(body: str) -> Any:
        from azure.servicebus import ServiceBusMessage

        return ServiceBusMessage(body)

    async def publish(self, topic: str, payload: dict) -> None:
        message = self._message_factory(_serialize(topic, payload))
        async with self._client.get_queue_sender(queue_name=self._queue_name) as sender:
            await sender.send_messages(message)


def build_message_publisher(
    transport: str,
    *,
    redis_client: RedisStreamClient | None = None,
    service_bus_client: ServiceBusClient | None = None,
    message_factory: Callable[[str], Any] | None = None,
) -> MessagePublisher:
    if transport == "redis-streams":
        stream_name = os.getenv("REDIS_STREAM_NAME", "liftoff-events").strip()
        if not stream_name:
            raise MessagingConfigurationError("REDIS_STREAM_NAME must not be empty.")
        if redis_client is None:
            redis_url = os.getenv("REDIS_URL", "").strip()
            if not redis_url:
                raise MessagingConfigurationError("REDIS_URL is required for redis-streams messaging.")
            from redis.asyncio import Redis

            redis_client = Redis.from_url(redis_url, decode_responses=True)
        return RedisStreamPublisher(redis_client, stream_name)

    if transport == "azure-service-bus":
        queue_name = os.getenv("SERVICE_BUS_QUEUE_NAME", "").strip()
        if not queue_name:
            raise MessagingConfigurationError(
                "SERVICE_BUS_QUEUE_NAME is required for azure-service-bus messaging."
            )
        if service_bus_client is None:
            connection_string = os.getenv("SERVICE_BUS_CONNECTION_STRING", "").strip()
            namespace = os.getenv("SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE", "").strip()
            from azure.servicebus.aio import ServiceBusClient as AzureServiceBusClient

            if connection_string:
                service_bus_client = AzureServiceBusClient.from_connection_string(connection_string)
            elif namespace:
                from azure.identity.aio import DefaultAzureCredential

                client_id = os.getenv("AZURE_CLIENT_ID", "").strip() or None
                credential = DefaultAzureCredential(managed_identity_client_id=client_id)
                service_bus_client = AzureServiceBusClient(namespace, credential)
            else:
                raise MessagingConfigurationError(
                    "Set SERVICE_BUS_CONNECTION_STRING or SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE "
                    "for azure-service-bus messaging."
                )
        return AzureServiceBusPublisher(service_bus_client, queue_name, message_factory)

    raise MessagingConfigurationError(
        f"Unsupported MESSAGING_TRANSPORT '{transport}'. "
        "Expected 'redis-streams' or 'azure-service-bus'."
    )
`;
}

function renderTracing(): string {
  return `import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncContextManager, Protocol


class TracingConfigurationError(RuntimeError):
    pass


@dataclass
class TraceHandle:
    enabled: bool
    trace_id: str | None
    output: Any = None

    def set_output(self, output: Any) -> None:
        self.output = output


class Tracer(Protocol):
    def trace(self, name: str, input_data: Any = None) -> AsyncContextManager[TraceHandle]:
        ...


class DisabledTracer:
    @asynccontextmanager
    async def trace(self, name: str, input_data: Any = None):
        del name, input_data
        yield TraceHandle(enabled=False, trace_id=None)


class LangfuseTracer:
    def __init__(self, client: Any):
        self._client = client


    @asynccontextmanager
    async def trace(self, name: str, input_data: Any = None):
        remote_trace = self._client.start_observation(
            name=name,
            as_type="span",
            input=input_data,
        )
        remote_id = getattr(remote_trace, "trace_id", None)
        handle = TraceHandle(
            enabled=True,
            trace_id=str(remote_id) if remote_id is not None else None,
        )
        try:
            yield handle
        except Exception as error:
            remote_trace.update(level="ERROR", status_message=str(error))
            raise
        else:
            remote_trace.update(output=handle.output)
        finally:
            remote_trace.end()


def build_tracer(
    *,
    client: Any = None,
    public_key: str | None = None,
    secret_key: str | None = None,
    host: str | None = None,
) -> Tracer:
    if client is not None:
        return LangfuseTracer(client)

    resolved_public_key = public_key or os.getenv("LANGFUSE_PUBLIC_KEY", "").strip()
    resolved_secret_key = secret_key or os.getenv("LANGFUSE_SECRET_KEY", "").strip()
    if not resolved_public_key and not resolved_secret_key:
        return DisabledTracer()
    if not resolved_public_key or not resolved_secret_key:
        raise TracingConfigurationError(
            "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be configured together."
        )

    from langfuse import Langfuse

    resolved_host = host or os.getenv("LANGFUSE_HOST", "").strip() or None
    kwargs = {
        "public_key": resolved_public_key,
        "secret_key": resolved_secret_key,
    }
    if resolved_host:
        kwargs["host"] = resolved_host
    return LangfuseTracer(Langfuse(**kwargs))
`;
}

function renderBackendHealthTest(): string {
  return `from fastapi.testclient import TestClient

from backend.apis.main import app


def test_health():
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_cors_preflight_for_local_frontend():
    response = TestClient(app).options(
        "/health",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
`;
}

function renderMessagingTest(): string {
  return `import asyncio
import json

from backend.orchestration.tools.messaging import build_message_publisher


class FakeRedisClient:
    def __init__(self):
        self.calls = []

    async def xadd(self, name, fields):
        self.calls.append((name, fields))


class FakeSender:
    def __init__(self):
        self.messages = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return None

    async def send_messages(self, message):
        self.messages.append(message)


class FakeServiceBusClient:
    def __init__(self, sender):
        self.sender = sender
        self.queue_names = []

    def get_queue_sender(self, *, queue_name):
        self.queue_names.append(queue_name)
        return self.sender


def test_redis_stream_publisher_uses_xadd(monkeypatch):
    monkeypatch.setenv("REDIS_STREAM_NAME", "orchestration-events")
    client = FakeRedisClient()
    publisher = build_message_publisher("redis-streams", redis_client=client)

    asyncio.run(publisher.publish("rag.ingest", {"source_uri": "az://document"}))

    stream_name, fields = client.calls[0]
    assert stream_name == "orchestration-events"
    assert fields["topic"] == "rag.ingest"
    assert json.loads(fields["payload"]) == {
        "payload": {"source_uri": "az://document"},
        "topic": "rag.ingest",
    }


def test_service_bus_publisher_uses_async_sender(monkeypatch):
    monkeypatch.setenv("SERVICE_BUS_QUEUE_NAME", "orchestration-jobs")
    sender = FakeSender()
    client = FakeServiceBusClient(sender)
    publisher = build_message_publisher(
        "azure-service-bus",
        service_bus_client=client,
        message_factory=lambda body: body,
    )

    asyncio.run(publisher.publish("workflow.run", {"job_id": "job-1"}))

    assert client.queue_names == ["orchestration-jobs"]
    assert json.loads(sender.messages[0]) == {
        "payload": {"job_id": "job-1"},
        "topic": "workflow.run",
    }
`;
}

function renderTracingTest(): string {
  return `import asyncio

import pytest

from backend.observability.tracing import (
    TracingConfigurationError,
    build_tracer,
)


class FakeRemoteTrace:
    trace_id = "trace-123"

    def __init__(self):
        self.updates = []
        self.ended = False

    def update(self, **values):
        self.updates.append(values)

    def end(self):
        self.ended = True


class FakeLangfuse:
    def __init__(self):
        self.calls = []
        self.remote_trace = FakeRemoteTrace()

    def start_observation(self, **values):
        self.calls.append(values)
        return self.remote_trace


def test_unconfigured_tracing_is_explicitly_disabled(monkeypatch):
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)

    async def scenario():
        async with build_tracer().trace("offline") as trace:
            assert trace.enabled is False
            assert trace.trace_id is None

    asyncio.run(scenario())


def test_configured_tracing_updates_langfuse_operation():
    client = FakeLangfuse()

    async def scenario():
        async with build_tracer(client=client).trace(
            "agent.run",
            {"prompt": "hello"},
        ) as trace:
            assert trace.enabled is True
            assert trace.trace_id == "trace-123"
            trace.set_output({"answer": "world"})

    asyncio.run(scenario())
    assert client.calls == [
        {"name": "agent.run", "as_type": "span", "input": {"prompt": "hello"}}
    ]
    assert client.remote_trace.updates == [{"output": {"answer": "world"}}]
    assert client.remote_trace.ended is True


def test_partial_langfuse_configuration_fails(monkeypatch):
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "public")
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    with pytest.raises(TracingConfigurationError, match="configured together"):
        build_tracer()
`;
}

function renderAlembicIni(): string {
  return `[alembic]
script_location = %(here)s/migrations
sqlalchemy.url = driver://user:pass@localhost/dbname
`;
}

function renderAlembicEnv(): string {
  return `import os

from alembic import context
from sqlalchemy import create_engine


def run_migrations_online():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required to run migrations")
    database_url = database_url.replace("postgresql+asyncpg://", "postgresql+psycopg://", 1)
    database_url = database_url.replace("postgresql://", "postgresql+psycopg://", 1)
    connectable = create_engine(database_url)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=None)
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
`;
}

function renderInitialMigration(plan: GenAiProjectPlan): string {
  const vectorExtension = genAiPattern(plan).id === 'rag' ? '    op.execute("CREATE EXTENSION IF NOT EXISTS vector")\n' : '';
  return `from alembic import op
import sqlalchemy as sa

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
${vectorExtension}    op.create_table(
        "events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("event_type", sa.String(length=120), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )


def downgrade():
    op.drop_table("events")
`;
}

function renderDatabaseSchema(plan: GenAiProjectPlan): string {
  return `CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(120) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
${genAiPattern(plan).id === 'rag' ? '\nCREATE EXTENSION IF NOT EXISTS vector;\n' : ''}`;
}

function renderPatternAgent(plan: GenAiProjectPlan): string {
  const pattern = genAiPattern(plan);
  const moduleName = pyModule(pattern.id);
  if (pattern.id === 'rag') {
    return `import os

from backend.observability.tracing import Tracer, build_tracer
from backend.orchestration.model_config import AgentRunner, build_agent_runner
from backend.orchestration.tools.messaging import MessagePublisher, build_message_publisher


async def _run_agent(
    operation: str,
    prompt: str,
    runner: AgentRunner | None,
    tracer: Tracer | None,
) -> str:
    selected_runner = runner or build_agent_runner()
    selected_tracer = tracer or build_tracer()
    async with selected_tracer.trace(operation, {"prompt": prompt}) as trace:
        output = await selected_runner.run(prompt)
        trace.set_output({"text": output})
        return output


async def answer_question(
    question: str,
    *,
    runner: AgentRunner | None = None,
    tracer: Tracer | None = None,
) -> dict:
    answer = await _run_agent(
        "rag.query",
        f"Answer the question using retrieved evidence when available.\\nQuestion: {question}",
        runner,
        tracer,
    )
    return {
        "answer": answer,
        "question": question,
        "citations": [],
    }


async def enqueue_ingestion(
    source_uri: str,
    *,
    publisher: MessagePublisher | None = None,
) -> dict:
    selected_publisher = publisher or build_message_publisher(
        os.getenv("MESSAGING_TRANSPORT", "redis-streams")
    )
    await selected_publisher.publish("rag.ingest", {"source_uri": source_uri})
    return {"status": "queued", "source_uri": source_uri}
`;
  }
  if (pattern.id === 'streaming') {
    return `import json

from backend.observability.tracing import Tracer, build_tracer
from backend.orchestration.model_config import AgentRunner, build_agent_runner


async def stream_response(
    prompt: str,
    *,
    runner: AgentRunner | None = None,
    tracer: Tracer | None = None,
):
    selected_runner = runner or build_agent_runner()
    selected_tracer = tracer or build_tracer()
    async with selected_tracer.trace("streaming.run", {"prompt": prompt}) as trace:
        output = await selected_runner.run(
            f"Respond concisely and safely to this streaming request:\\n{prompt}"
        )
        trace.set_output({"text": output})
    yield f"data: {json.dumps({'text': output})}\\n\\n"
`;
  }
  const instruction = pattern.id === 'generic'
    ? 'Respond safely and usefully to this general-purpose AI request:'
    : `Run the ${pattern.label} orchestration contract for this input:`;
  return `from backend.observability.tracing import Tracer, build_tracer
from backend.orchestration.model_config import AgentRunner, build_agent_runner


async def run_${moduleName}(
    input_text: str,
    *,
    runner: AgentRunner | None = None,
    tracer: Tracer | None = None,
) -> dict:
    selected_runner = runner or build_agent_runner()
    selected_tracer = tracer or build_tracer()
    prompt = (
        "${instruction}\\n"
        f"{input_text}"
    )
    async with selected_tracer.trace("${pattern.id}.run", {"input": input_text}) as trace:
        output = await selected_runner.run(prompt)
        trace.set_output({"result": output})
    return {
        "result": output,
        "input": input_text,
    }
`;
}

function renderPatternAgentTest(plan: GenAiProjectPlan): string {
  const pattern = genAiPattern(plan);
  const moduleName = pyModule(pattern.id);
  const agentModule = `backend.orchestration.agents.${moduleName}_agent`;
  if (pattern.id === 'rag') {
    return `import asyncio

import pytest

from ${agentModule} import answer_question, enqueue_ingestion
from backend.observability.tracing import DisabledTracer
from backend.orchestration.model_config import ModelConfigurationError


class FakeRunner:
    async def run(self, prompt):
        assert "Question: What is Liftoff?" in prompt
        return "Liftoff is the generated orchestration starter."


class FakePublisher:
    def __init__(self):
        self.messages = []

    async def publish(self, topic, payload):
        self.messages.append((topic, payload))


def test_rag_query_uses_injected_runner_without_network():
    result = asyncio.run(
        answer_question(
            "What is Liftoff?",
            runner=FakeRunner(),
            tracer=DisabledTracer(),
        )
    )
    assert result == {
        "answer": "Liftoff is the generated orchestration starter.",
        "question": "What is Liftoff?",
        "citations": [],
    }


def test_rag_ingestion_uses_injected_publisher():
    publisher = FakePublisher()
    result = asyncio.run(
        enqueue_ingestion("az://documents/one.pdf", publisher=publisher)
    )
    assert result == {
        "status": "queued",
        "source_uri": "az://documents/one.pdf",
    }
    assert publisher.messages == [
        ("rag.ingest", {"source_uri": "az://documents/one.pdf"})
    ]


def test_missing_model_configuration_is_explicit(monkeypatch):
    monkeypatch.delenv("PYDANTIC_AI_MODEL", raising=False)
    with pytest.raises(ModelConfigurationError, match="PYDANTIC_AI_MODEL is required"):
        asyncio.run(answer_question("unconfigured"))
`;
  }
  if (pattern.id === 'streaming') {
    return `import asyncio

import pytest

from ${agentModule} import stream_response
from backend.observability.tracing import DisabledTracer
from backend.orchestration.model_config import ModelConfigurationError


class FakeRunner:
    async def run(self, prompt):
        assert "stream this" in prompt
        return "offline streamed answer"


def test_streaming_uses_injected_runner_without_network():
    async def collect():
        return [
            chunk
            async for chunk in stream_response(
                "stream this",
                runner=FakeRunner(),
                tracer=DisabledTracer(),
            )
        ]

    chunks = asyncio.run(collect())
    assert chunks == ['data: {"text": "offline streamed answer"}\\n\\n']


def test_missing_model_configuration_is_explicit(monkeypatch):
    monkeypatch.delenv("PYDANTIC_AI_MODEL", raising=False)

    async def collect():
        return [chunk async for chunk in stream_response("unconfigured")]

    with pytest.raises(ModelConfigurationError, match="PYDANTIC_AI_MODEL is required"):
        asyncio.run(collect())
`;
  }
  return `import asyncio

import pytest

from ${agentModule} import run_${moduleName}
from backend.observability.tracing import DisabledTracer
from backend.orchestration.model_config import ModelConfigurationError


class FakeRunner:
    async def run(self, prompt):
        assert "offline input" in prompt
        return "offline ${pattern.id} result"


def test_${moduleName}_uses_injected_runner_without_network():
    result = asyncio.run(
        run_${moduleName}(
            "offline input",
            runner=FakeRunner(),
            tracer=DisabledTracer(),
        )
    )
    assert result == {
        "result": "offline ${pattern.id} result",
        "input": "offline input",
    }


def test_missing_model_configuration_is_explicit(monkeypatch):
    monkeypatch.delenv("PYDANTIC_AI_MODEL", raising=False)
    with pytest.raises(ModelConfigurationError, match="PYDANTIC_AI_MODEL is required"):
        asyncio.run(run_${moduleName}("unconfigured"))
`;
}

function renderPromptTemplate(plan: GenAiProjectPlan): string {
  const pattern = genAiPattern(plan);
  if (pattern.id === 'generic') {
    return `# Generic GenAI System Prompt

Respond safely and usefully to the general-purpose request.

Do not assume retrieval, conversation memory, tools, streaming, fine-tuning, multi-agent coordination, or workflow behavior unless the project explicitly adds it.
`;
  }
  return `# ${pattern.label} Prompt

You are implementing a ${pattern.label} generated by Mission Control Liftoff.

Use PydanticAI orchestration and return outputs that match the API contract.
`;
}

function renderPromptReadme(): string {
  return `# Prompt Templates

Store prompt templates here and reference them from the PydanticAI orchestration layer.
`;
}

function renderVectorStore(): string {
  return `from typing import Protocol


class VectorStore(Protocol):
    async def search(self, query: str, limit: int = 5) -> list[dict]:
        ...


class PgVectorStore:
    async def search(self, query: str, limit: int = 5) -> list[dict]:
        return []
`;
}

function renderPatternWorker(plan: GenAiProjectPlan): string {
  const pattern = genAiPattern(plan);
  return `async def run_worker() -> None:
    # Consume ${pattern.label} jobs from the configured messaging boundary.
    return None
`;
}

function renderFunctionsReadme(): string {
  return `# Azure Functions Workers

Azure Functions trigger adapters live under \`functions/<worker-name>\`.

Keep reusable GenAI orchestration, model configuration, prompt handling, and domain logic under \`backend/orchestration\`. Use \`backend/workers\` for backend-adjacent or containerized workers; use this folder for Azure Functions runtime files such as \`host.json\`, trigger bindings, local settings, and Function app tests.
`;
}

function renderFunctionWorkerReadme(plan: GenAiProjectPlan): string {
  const workerName = functionWorkerName(plan);
  const pattern = genAiPattern(plan);
  return `# ${workerName}

Azure Functions worker scaffold for ${pattern.label}.

This Function app uses the Python v2 decorator programming model and a Service Bus queue trigger. The trigger adapter should stay thin: decode the message, validate the envelope, and call shared code from \`backend/orchestration\` after that shared code is packaged with the Function app.

Deployed triggers use \`ServiceBusConnection__fullyQualifiedNamespace\` and \`ServiceBusConnection__clientId\` to select the same user-assigned identity that OpenTofu grants the Service Bus Data Receiver role. \`SERVICEBUS_QUEUE_NAME\` is populated from \`function_worker_queue_name\`. Function host storage uses the complete \`AzureWebJobsStorage\` connection setting.

## Local Development

\`\`\`bash
uv sync --frozen --project ../../backend --extra test --extra functions
cp local.settings.example.json local.settings.json
uv run --project ../../backend --directory . python -m pytest -q
func start
\`\`\`
`;
}

function renderFunctionHostJson(): string {
  return JSON.stringify({
    version: '2.0',
    extensionBundle: {
      id: 'Microsoft.Azure.Functions.ExtensionBundle',
      version: '[4.*, 5.0.0)'
    }
  }, null, 2);
}

function renderFunctionLocalSettings(plan: GenAiProjectPlan): string {
  const pattern = genAiPattern(plan);
  return JSON.stringify({
    IsEncrypted: false,
    Values: {
      AzureWebJobsStorage: 'UseDevelopmentStorage=true',
      FUNCTIONS_WORKER_RUNTIME: 'python',
      SERVICEBUS_QUEUE_NAME: DEFAULT_FUNCTION_WORKER_QUEUE_NAME,
      ServiceBusConnection__fullyQualifiedNamespace: '<service-bus-namespace>.servicebus.windows.net',
      GENAI_PATTERN: pattern.id,
      SHARED_ORCHESTRATION_ROOT: '../../backend'
    }
  }, null, 2);
}

function renderFunctionRequirements(): string {
  return renderFunctionRequirementsAsset();
}

function renderFunctionApp(plan: GenAiProjectPlan): string {
  const pattern = genAiPattern(plan);
  const moduleName = pyModule(pattern.id);
  return `import json
import logging

import azure.functions as func


app = func.FunctionApp()


def decode_message_payload(body: str) -> dict:
    try:
        value = json.loads(body)
    except json.JSONDecodeError:
        return {"raw": body}
    if isinstance(value, dict):
        return value
    return {"value": value}


@app.service_bus_queue_trigger(
    arg_name="message",
    queue_name="%SERVICEBUS_QUEUE_NAME%",
    connection="ServiceBusConnection",
)
def process_${moduleName}_work(message: func.ServiceBusMessage) -> None:
    payload = decode_message_payload(message.get_body().decode("utf-8"))
    logging.info("Received ${pattern.id} worker message with keys: %s", sorted(payload.keys()))
    # Keep this adapter thin; call backend.orchestration code from packaged shared modules.
`;
}

function renderFunctionTest(): string {
  return `from function_app import decode_message_payload


def test_decode_message_payload_for_json_object():
    assert decode_message_payload('{"source_uri":"az://documents/example.pdf"}') == {
        "source_uri": "az://documents/example.pdf"
    }


def test_decode_message_payload_for_plain_text():
    assert decode_message_payload("plain text") == {"raw": "plain text"}
`;
}

function renderFunctionFuncIgnore(): string {
  return `.venv/
__pycache__/
.pytest_cache/
local.settings.json
tests/
`;
}

function renderFunctionGitIgnore(): string {
  return `.venv/
__pycache__/
.pytest_cache/
local.settings.json
`;
}

function renderBackendEnv(plan: GenAiProjectPlan, environment: string): string {
  const pattern = genAiPattern(plan);
  const transport = environment === 'dev' ? 'redis-streams' : 'azure-service-bus';
  return `APP_ENV=${environment}
APP_NAME=${plan.safeProjectName}
GENAI_PATTERN=${pattern.id}
CLOUD_PROVIDER=${plan.provider.id}
AZURE_REGION=${plan.region.slug}
DATABASE_URL=postgresql+asyncpg://postgres:postgres@postgres:5432/${plan.safeProjectName.replace(/-/g, '_')}
REDIS_URL=redis://redis:6379/0
REDIS_STREAM_NAME=liftoff-events
MESSAGING_TRANSPORT=${transport}
SERVICE_BUS_QUEUE_NAME=${DEFAULT_FUNCTION_WORKER_QUEUE_NAME}
SERVICE_BUS_CONNECTION_STRING=
SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE=${environment === 'dev' ? '' : '<service-bus-namespace>.servicebus.windows.net'}
AZURE_CLIENT_ID=
BLOB_ENDPOINT=
CORS_ALLOWED_ORIGINS=http://localhost:5173
PYDANTIC_AI_MODEL=
LANGFUSE_HOST=${environment === 'dev' ? 'http://langfuse:3000' : ''}
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
`;
}

function renderFunctionsEnv(plan: GenAiProjectPlan, environment: string): string {
  const pattern = genAiPattern(plan);
  return `APP_ENV=${environment}
APP_NAME=${plan.safeProjectName}
GENAI_PATTERN=${pattern.id}
FUNCTIONS_WORKER_RUNTIME=python
SERVICEBUS_QUEUE_NAME=${DEFAULT_FUNCTION_WORKER_QUEUE_NAME}
ServiceBusConnection__fullyQualifiedNamespace=<service-bus-namespace>.servicebus.windows.net
ServiceBusConnection__clientId=<managed-identity-client-id>
AzureWebJobsStorage=<storage-connection-string>
SHARED_ORCHESTRATION_ROOT=../../backend
`;
}

function renderDockerCompose(plan: ApiProjectPlan): string {
  const localEnvironment = plan.environments.find((environment) => environment.id === 'dev') ?? plan.environments[0];
  const frontendService = plan.includeFrontend ? `
  frontend:
    build:
      context: ./frontend
    ports:
      - "5173:80"
    depends_on:
      - backend
` : '';
  const postgresImage = plan.workload === 'genai'
    ? formatContainerImage(supportedStack.containers.pgvector)
    : formatContainerImage(supportedStack.containers.postgres);
  return `services:
  backend:
    build:
      context: .
      dockerfile: Dockerfile
    env_file:
      - ./environments/${localEnvironment.id}/backend.env
    environment:
      MESSAGING_TRANSPORT: redis-streams
      BLOB_ENDPOINT: http://azurite:10000/devstoreaccount1
    ports:
      - "8000:8000"
    depends_on:
      - postgres
      - redis
      - azurite
      - mailpit
${frontendService}
  postgres:
    image: ${postgresImage}
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: ${plan.safeProjectName.replace(/-/g, '_')}
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 3s
      timeout: 3s
      retries: 10

  redis:
    image: ${formatContainerImage(supportedStack.containers.redis)}
    ports:
      - "6379:6379"

  azurite:
    image: ${formatContainerImage(supportedStack.containers.azurite)}
    command: azurite --blobHost 0.0.0.0
    ports:
      - "10000:10000"

  mailpit:
    image: ${formatContainerImage(supportedStack.containers.mailpit)}
    ports:
      - "8025:8025"

${plan.workload === 'genai' ? `  langfuse-worker:
    image: ${formatContainerImage(supportedStack.containers['langfuse-worker'])}
    profiles:
      - observability
    depends_on: &langfuse-dependencies
      postgres:
        condition: service_healthy
      langfuse-redis:
        condition: service_healthy
      clickhouse:
        condition: service_healthy
      minio:
        condition: service_healthy
    environment: &langfuse-environment
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/${plan.safeProjectName.replace(/-/g, '_')}
      NEXTAUTH_URL: http://localhost:3000
      SALT: local-development-salt
      ENCRYPTION_KEY: 0000000000000000000000000000000000000000000000000000000000000000
      TELEMETRY_ENABLED: "false"
      CLICKHOUSE_MIGRATION_URL: clickhouse://clickhouse:9000
      CLICKHOUSE_URL: http://clickhouse:8123
      CLICKHOUSE_USER: clickhouse
      CLICKHOUSE_PASSWORD: clickhouse
      REDIS_HOST: langfuse-redis
      REDIS_PORT: 6379
      REDIS_AUTH: langfuse-redis
      LANGFUSE_S3_EVENT_UPLOAD_BUCKET: langfuse
      LANGFUSE_S3_EVENT_UPLOAD_REGION: auto
      LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID: minio
      LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY: miniosecret
      LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT: http://minio:9000
      LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE: "true"
      LANGFUSE_S3_MEDIA_UPLOAD_BUCKET: langfuse
      LANGFUSE_S3_MEDIA_UPLOAD_REGION: auto
      LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID: minio
      LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY: miniosecret
      LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT: http://minio:9000
      LANGFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE: "true"

  langfuse:
    image: ${formatContainerImage(supportedStack.containers['langfuse-web'])}
    profiles:
      - observability
    depends_on: *langfuse-dependencies
    environment:
      <<: *langfuse-environment
      NEXTAUTH_SECRET: local-development-secret
      LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT: http://localhost:9090
    ports:
      - "3000:3000"

  clickhouse:
    image: ${formatContainerImage(supportedStack.containers.clickhouse)}
    profiles:
      - observability
    user: "101:101"
    environment:
      CLICKHOUSE_DB: default
      CLICKHOUSE_USER: clickhouse
      CLICKHOUSE_PASSWORD: clickhouse
    volumes:
      - langfuse-clickhouse-data:/var/lib/clickhouse
      - langfuse-clickhouse-logs:/var/log/clickhouse-server
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:8123/ping || exit 1"]
      interval: 5s
      timeout: 5s
      retries: 10

  minio:
    image: ${formatContainerImage(supportedStack.containers.minio)}
    profiles:
      - observability
    entrypoint: sh
    command: -c 'mkdir -p /data/langfuse && minio server --address ":9000" --console-address ":9001" /data'
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: miniosecret
    ports:
      - "9090:9000"
      - "127.0.0.1:9091:9001"
    volumes:
      - langfuse-minio-data:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 1s
      timeout: 5s
      retries: 5

  langfuse-redis:
    image: ${formatContainerImage(supportedStack.containers.redis)}
    profiles:
      - observability
    command: ["redis-server", "--requirepass", "langfuse-redis", "--maxmemory-policy", "noeviction"]
    volumes:
      - langfuse-redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "langfuse-redis", "ping"]
      interval: 3s
      timeout: 10s
      retries: 10
` : ''}
${plan.workload === 'genai' ? `volumes:
  langfuse-clickhouse-data:
  langfuse-clickhouse-logs:
  langfuse-minio-data:
  langfuse-redis-data:
` : ''}
`;
}

function renderTofuProviders(): string {
  return `provider "azurerm" {
  features {}
}
`;
}

function renderTofuVariables(plan: ApiProjectPlan): string {
  const frontendVariables = plan.includeFrontend ? `
variable "frontend_image" {
  type        = string
  default     = "${formatContainerImage(supportedStack.containers['container-apps-bootstrap'])}"
  description = "Frontend image. Replace the bootstrap image with the generated frontend image after pushing it to ACR."
}
` : '';
  const functionVariables = hasFunctionWorker(plan) ? `
variable "function_worker_queue_name" {
  type        = string
  default     = "events"
  description = "Service Bus queue consumed by the generated Azure Functions worker."
}

variable "functions_python_version" {
  type        = string
  default     = "${supportedStack.runtimes.python.releaseLine}"
  description = "Python runtime version for the generated Azure Functions worker."
}
` : '';
  return `variable "environment" {
  type        = string
  description = "Deployment environment name."
}

variable "location" {
  type        = string
  description = "Azure region slug."
  default     = "${plan.region.slug}"
}

variable "resource_suffix" {
  type        = string
  description = "Twelve-character lowercase alphanumeric suffix for globally scoped Azure resource names."

  validation {
    condition     = can(regex("^[a-z0-9]{12}$", var.resource_suffix))
    error_message = "resource_suffix must contain exactly 12 lowercase letters or numbers."
  }
}

variable "backend_image" {
  type        = string
  default     = "${formatContainerImage(supportedStack.containers['container-apps-bootstrap'])}"
  description = "Backend image. Replace the bootstrap image with the generated backend image after pushing it to ACR."
}

variable "backend_target_port" {
  type        = number
  default     = 80
  description = "Backend ingress port. Set to 8000 when switching from the bootstrap image to the generated backend."
}
${frontendVariables}
variable "postgres_admin_password" {
  type        = string
  sensitive   = true
  description = "PostgreSQL administrator password supplied at apply time."
}

variable "enable_private_networking" {
  type        = bool
  default     = false
  description = "Enable production-oriented private-networking-ready settings."
}
${functionVariables}
`;
}

function renderTofuMain(plan: ApiProjectPlan): string {
  const functionPattern = plan.workload === 'genai' && hasFunctionWorker(plan)
    ? genAiPattern(plan)
    : undefined;
  const names = buildAzureResourceNames(plan, '${var.environment}', '${var.resource_suffix}');
  const queueName = hasFunctionWorker(plan)
    ? 'var.function_worker_queue_name'
    : JSON.stringify(DEFAULT_FUNCTION_WORKER_QUEUE_NAME);
  const projectIdentityEnv = plan.workload === 'genai' ? `
      env {
        name  = "GENAI_PATTERN"
        value = "${genAiPattern(plan).id}"
      }
` : `
      env {
        name  = "API_STACK"
        value = "${plan.apiStack.id}"
      }
`;
  const frontendCorsEnvironment = plan.includeFrontend ? `
      env {
        name  = "CORS_ALLOWED_ORIGINS"
        value = "https://\${azurerm_container_app.frontend.ingress[0].fqdn}"
      }
` : '';
  const frontendContainer = plan.includeFrontend ? `
resource "azurerm_container_app" "frontend" {
  name                         = "${names.frontendContainerApp}"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  template {
    container {
      name   = "frontend"
      image  = var.frontend_image
      cpu    = 0.25
      memory = "0.5Gi"
    }
  }

  ingress {
    external_enabled = true
    target_port      = 80
    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  depends_on = [azurerm_role_assignment.acr_pull]
}
` : '';
  const functionWorker = hasFunctionWorker(plan) ? `
resource "azurerm_service_plan" "functions" {
  name                = "${names.functionServicePlan}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  os_type             = "Linux"
  sku_name            = "Y1"
}

resource "azurerm_linux_function_app" "worker" {
  name                       = "${names.functionApp}"
  resource_group_name        = azurerm_resource_group.main.name
  location                   = azurerm_resource_group.main.location
  service_plan_id            = azurerm_service_plan.functions.id
  storage_account_name       = azurerm_storage_account.main.name
  storage_account_access_key = azurerm_storage_account.main.primary_access_key

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  site_config {
    application_stack {
      python_version = var.functions_python_version
    }
  }

  app_settings = {
    APP_ENV                                       = var.environment
    APP_NAME                                      = "${plan.safeProjectName}"
    GENAI_PATTERN                                 = "${functionPattern?.id}"
    FUNCTIONS_WORKER_RUNTIME                      = "python"
    SERVICEBUS_QUEUE_NAME                         = var.function_worker_queue_name
    ServiceBusConnection__clientId                = azurerm_user_assigned_identity.app.client_id
    ServiceBusConnection__fullyQualifiedNamespace = "\${azurerm_servicebus_namespace.main.name}.servicebus.windows.net"
    SHARED_ORCHESTRATION_ROOT                     = "../../backend"
  }
}

resource "azurerm_role_assignment" "function_servicebus_receiver" {
  scope                = azurerm_servicebus_namespace.main.id
  role_definition_name = "Azure Service Bus Data Receiver"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_role_assignment" "function_storage_blob_contributor" {
  scope                = azurerm_storage_account.main.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}
` : '';
  return `resource "azurerm_resource_group" "main" {
  name     = "${names.resourceGroup}"
  location = var.location
}

resource "azurerm_container_registry" "main" {
  name                = "${names.containerRegistry}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "Basic"
  admin_enabled       = false
}

resource "azurerm_user_assigned_identity" "app" {
  name                = "${names.identity}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_container_app_environment" "main" {
  name                = "${names.containerAppEnvironment}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
}

resource "azurerm_container_app" "backend" {
  name                         = "${names.backendContainerApp}"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  secret {
    name  = "database-url"
    value = "postgresql://liftoffadmin:\${urlencode(var.postgres_admin_password)}@\${azurerm_postgresql_flexible_server.main.fqdn}:5432/postgres?sslmode=require"
  }

  secret {
    name  = "redis-url"
    value = "rediss://:\${urlencode(azurerm_redis_cache.main.primary_access_key)}@\${azurerm_redis_cache.main.hostname}:\${azurerm_redis_cache.main.ssl_port}/0"
  }

  template {
    container {
      name   = "backend"
      image  = var.backend_image
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "APP_ENV"
        value = var.environment
      }

      env {
        name  = "APP_NAME"
        value = "${plan.safeProjectName}"
      }

      env {
        name  = "PROJECT_TYPE"
        value = "${plan.projectType.id}"
      }
${projectIdentityEnv}
      env {
        name  = "CLOUD_PROVIDER"
        value = "azure"
      }

      env {
        name  = "AZURE_REGION"
        value = var.location
      }
${frontendCorsEnvironment}

      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }

      env {
        name        = "REDIS_URL"
        secret_name = "redis-url"
      }

      env {
        name  = "MESSAGING_TRANSPORT"
        value = "azure-service-bus"
      }

      env {
        name  = "BLOB_ENDPOINT"
        value = azurerm_storage_account.main.primary_blob_endpoint
      }
    }
  }

  ingress {
    external_enabled = true
    target_port      = var.backend_target_port
    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  depends_on = [azurerm_role_assignment.acr_pull]
}
${frontendContainer}
resource "azurerm_postgresql_flexible_server" "main" {
  name                   = "${names.postgres}"
  resource_group_name    = azurerm_resource_group.main.name
  location               = azurerm_resource_group.main.location
  version                = "16"
  administrator_login    = "liftoffadmin"
  administrator_password = var.postgres_admin_password
  storage_mb             = 32768
  sku_name               = "B_Standard_B1ms"
}

resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
  count            = var.enable_private_networking ? 0 : 1
  name             = "AllowAzureServices"
  server_id        = azurerm_postgresql_flexible_server.main.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

resource "azurerm_redis_cache" "main" {
  name                = "${names.redis}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  capacity            = 0
  family              = "C"
  sku_name            = "Basic"
}

resource "azurerm_storage_account" "main" {
  name                     = "${names.storage}"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

resource "azurerm_storage_container" "documents" {
  name                  = "documents"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

resource "azurerm_servicebus_namespace" "main" {
  name                = "${names.serviceBus}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "Standard"
}

resource "azurerm_servicebus_queue" "events" {
  name         = ${queueName}
  namespace_id = azurerm_servicebus_namespace.main.id
}
${functionWorker}

resource "azurerm_communication_service" "main" {
  name                = "${names.communication}"
  resource_group_name = azurerm_resource_group.main.name
  data_location       = "United States"
}

resource "azurerm_key_vault" "main" {
  name                       = "${names.keyVault}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
}

data "azurerm_client_config" "current" {}
`;
}

function renderTofuOutputs(plan: ApiProjectPlan): string {
  const functionOutputs = hasFunctionWorker(plan) ? `
output "function_app_name" {
  value = azurerm_linux_function_app.worker.name
}

output "function_worker_queue_name" {
  value = azurerm_servicebus_queue.events.name
}
` : '';
  return `output "backend_url" {
  value = azurerm_container_app.backend.ingress[0].fqdn
}

${plan.includeFrontend ? `output "frontend_url" {
  value = azurerm_container_app.frontend.ingress[0].fqdn
}
` : ''}${functionOutputs}output "container_registry" {
  value = azurerm_container_registry.main.login_server
}

output "container_registry_name" {
  value = azurerm_container_registry.main.name
}
`;
}

function renderTofuLocalState(): string {
  return `# Local state is the V1 default for first-use simplicity.
# Teams can replace this file with backend.remote.example.tf when adopting shared state.
`;
}

function renderTofuRemoteStateExample(): string {
  return `# Rename to backend.tf and configure values for shared state.
# terraform {
#   backend "azurerm" {
#     resource_group_name  = "rg-opentofu-state"
#     storage_account_name = "stliftoffstate"
#     container_name       = "tfstate"
#     key                  = "mission-control/liftoff.tfstate"
#   }
# }
`;
}

function renderTofuReadme(plan: ApiProjectPlan): string {
  const env = plan.environments[0]?.id ?? 'dev';
  const functionSection = plan.workload === 'genai' && hasFunctionWorker(plan) ? `
## Azure Functions Worker

This project includes an Azure Functions worker under \`functions/${functionWorkerName(plan)}\`. The OpenTofu configuration attaches one user-assigned identity, grants its principal the Service Bus Data Receiver role, and selects it through \`ServiceBusConnection__clientId\` plus \`ServiceBusConnection__fullyQualifiedNamespace\`. \`function_worker_queue_name\` provisions the queue, configures \`SERVICEBUS_QUEUE_NAME\`, and drives the worker queue output. Function host storage uses the complete key-backed \`AzureWebJobsStorage\` connection setting.
` : '';
  return `# Azure OpenTofu

Azure is the complete V1 provider for this Liftoff project.

## Bootstrap Infrastructure

The first apply uses a public bootstrap image so Azure Container Apps can start before the new ACR contains application images.

\`\`\`bash
tofu init
tofu plan -var-file=environments/${env}.tfvars
tofu apply -var-file=environments/${env}.tfvars
\`\`\`

Build the generated backend in ACR, then replace the bootstrap image:

\`\`\`bash
ACR_NAME="$(tofu output -raw container_registry_name)"
SOURCE_SHA="$(git rev-parse HEAD)"
az acr build --registry "$ACR_NAME" --image ${plan.safeProjectName}-backend:"$SOURCE_SHA" ../../..
${plan.includeFrontend ? `BACKEND_URL="https://$(tofu output -raw backend_url)"
az acr build --registry "$ACR_NAME" --image ${plan.safeProjectName}-frontend:"$SOURCE_SHA" --build-arg VITE_API_BASE_URL="$BACKEND_URL" ../../../frontend
` : ''}\`\`\`

Persist the deployed images in \`environments/${env}.tfvars\` so future applies do not restore the bootstrap image:

\`\`\`hcl
backend_image       = "<login-server>/${plan.safeProjectName}-backend@sha256:<manifest-digest>"
backend_target_port = 8000
${plan.includeFrontend ? `frontend_image      = "<login-server>/${plan.safeProjectName}-frontend@sha256:<manifest-digest>"
` : ''}\`\`\`

\`\`\`bash
tofu apply -var-file=environments/${env}.tfvars
\`\`\`

Local OpenTofu state is generated by default. Use \`backend.remote.example.tf\` as the starting point for team remote state.
The default PostgreSQL firewall permits Azure-hosted services. Replace it with private networking before production; set \`enable_private_networking=true\` only when the required VNet, delegated subnet, and private DNS resources are added.

## Azure Name Suffixes

Each environment tfvars file contains a deterministic 12-character lowercase alphanumeric \`resource_suffix\` used by globally scoped Azure names. If Azure reports that a name is already taken, replace that environment's suffix with another unique value matching \`^[a-z0-9]{12}$\`; \`tofu validate\` rejects invalid overrides before deployment.
${functionSection}
`;
}

function renderTofuTfvars(plan: ApiProjectPlan, environment: string): string {
  const values: Array<[string, string]> = [
    ['environment', JSON.stringify(environment)],
    ['location', JSON.stringify(plan.region.slug)],
    ['resource_suffix', JSON.stringify(stableResourceSuffix(plan, environment))],
    ['backend_image', JSON.stringify(formatContainerImage(supportedStack.containers['container-apps-bootstrap']))],
    ['backend_target_port', '80'],
    ['enable_private_networking', 'false']
  ];
  if (plan.includeFrontend) {
    values.push(['frontend_image', JSON.stringify(formatContainerImage(supportedStack.containers['container-apps-bootstrap']))]);
  }
  if (hasFunctionWorker(plan)) {
    values.push(
      ['function_worker_queue_name', JSON.stringify(DEFAULT_FUNCTION_WORKER_QUEUE_NAME)],
      ['functions_python_version', JSON.stringify(supportedStack.runtimes.python.releaseLine)]
    );
  }
  const width = Math.max(...values.map(([key]) => key.length));
  return values.map(([key, value]) => `${key.padEnd(width)} = ${value}`).join('\n');
}

function renderOpenSpecConfig(plan: ApiProjectPlan): string {
  const frontendRule = plan.includeFrontend ? '\n    - Keep frontend code under frontend.' : '';
  if (plan.workload === 'standard') {
    const backendRule = plan.apiStack.id === 'python-fastapi'
      ? 'Keep backend API code under backend/apis.'
      : plan.apiStack.id === 'node-fastify'
        ? 'Keep backend API code under backend/src.'
        : 'Keep the Go entrypoint under backend/cmd/api and reusable code under backend/internal.';
    return `schema: spec-driven${renderOpenSpecCopilotConfig(plan)}

context: |
  Project generated by Mission Control Liftoff.
  Project type: Standard application.
  API stack: ${plan.apiStack.label}.
  Database tooling: ${plan.apiStack.databaseTooling}.
  API developer portal: Scalar.
  Infrastructure: OpenTofu.
  Primary cloud: Azure (${plan.region.slug}).
  Local development: Docker Compose.
  Database: PostgreSQL.
  Cache and local messaging: Redis.
  Environments: ${plan.environments.map((environment) => environment.id).join(', ')}.

rules:
  specs:
    - Requirements must describe observable product behavior.
    - Cloud behavior must identify environment differences for generated environments.
  design:
    - Use ${plan.apiStack.framework} for backend APIs.
    - Use ${plan.apiStack.databaseTooling} for database access and migrations.
    - Use OpenTofu for infrastructure changes.${frontendRule}
    - ${backendRule}
    - Keep database artifacts under database.
  tasks:
    - Include local Docker Compose verification.
    - Include OpenTofu validation for generated infrastructure.
`;
  }

  const pattern = genAiPattern(plan);
  const functionsContext = hasFunctionWorker(plan) ? `
  Azure Functions worker: functions/${functionWorkerName(plan)}.` : '';
  const functionsRule = hasFunctionWorker(plan) ? `
    - Keep Azure Functions trigger adapters under functions/${functionWorkerName(plan)}.
    - Keep reusable GenAI orchestration under backend/orchestration.` : '';
  return `schema: spec-driven${renderOpenSpecCopilotConfig(plan)}

context: |
  Project generated by Mission Control Liftoff.
  GenAI pattern: ${pattern.label}
  Application framework: FastAPI + PydanticAI.
  API developer portal: Scalar.
  Infrastructure: OpenTofu.
  Primary cloud: Azure (${plan.region.slug}).
  Local development: Docker Compose.
  Database: PostgreSQL with Alembic migrations.
  Cache and local messaging: Redis.
  Observability: Langfuse.
  Environments: ${plan.environments.map((environment) => environment.id).join(', ')}.
${functionsContext}

rules:
  specs:
    - Requirements must describe observable product behavior.
    - Cloud behavior must identify environment differences for generated environments.
  design:
    - Use PydanticAI for orchestration logic.
    - Use Pydantic settings models for runtime configuration.
    - Use OpenTofu for infrastructure changes.${frontendRule}
    - Keep backend API code under backend/apis.
${functionsRule}
    - Keep database artifacts under database.
  tasks:
    - Include local Docker Compose verification.
    - Include OpenTofu validation for generated infrastructure.
`;
}

function renderSeedProposal(plan: ApiProjectPlan): string {
  const capability = seedCapabilityId(plan);
  if (plan.workload === 'standard') {
    return `## Why

Bootstrap the generated ${plan.apiStack.label} standard application baseline created by Mission Control Liftoff.

## What Changes

- Establish the approved backend, infrastructure, local development, and governance baseline.
- Confirm that domain-specific product behavior is deferred to follow-up spec-driven changes.

## Capabilities

### New Capabilities

- \`${capability}\`: Generated standard application baseline for this Liftoff project.

### Modified Capabilities

- None.

## Impact

- Generated ${plan.apiStack.label} backend, OpenTofu infrastructure, Docker Compose local development, and governance files.
`;
  }

  const pattern = genAiPattern(plan);
  const functionsChange = hasFunctionWorker(plan) ? '\n- Establish Azure Functions worker trigger adapters for event-driven processing.' : '';
  return `## Why

Bootstrap the generated ${pattern.label} application baseline created by Mission Control Liftoff.

## What Changes

- Establish the approved backend, infrastructure, local development, and governance baseline.
- Confirm that domain-specific product behavior is deferred to follow-up spec-driven changes.
${functionsChange}

## Capabilities

### New Capabilities

- \`${capability}\`: Generated application baseline for this Liftoff project.

### Modified Capabilities

- None.

## Impact

- Generated FastAPI/PydanticAI backend, OpenTofu infrastructure, Docker Compose local development, and governance files.
`;
}

function renderSeedDesign(plan: ApiProjectPlan): string {
  if (plan.workload === 'standard') {
    return `## Context

This standard project was generated with Liftoff using ${plan.apiStack.label}, Azure, OpenTofu, and ${plan.specWorkflow.label}.

## Goals / Non-Goals

**Goals:**

- Keep the generated baseline aligned to the approved Mission Control stack.
- Verify only deterministic local scaffold checks before archiving this bootstrap change.

**Non-Goals:**

- Define domain-specific product behavior in the bootstrap change.
- Deploy infrastructure, start containers, mutate GitHub, or perform cloud plan/apply operations.

## Decisions

- Use ${plan.apiStack.framework} for backend APIs.
- Use ${plan.apiStack.databaseTooling} for PostgreSQL integration.
- Use OpenTofu for Azure infrastructure.
- Use Docker Compose for local development.

## Risks / Trade-offs

- Follow-up product changes own real business behavior; this seed only proves the generated local baseline is coherent.
`;
  }

  const pattern = genAiPattern(plan);
  const functionsDecision = hasFunctionWorker(plan) ? '\n- Keep Azure Functions trigger adapters under functions/' + functionWorkerName(plan) + ' and shared GenAI logic under backend/orchestration.' : '';
  return `## Context

This project was generated with Liftoff using ${pattern.label}, Azure, OpenTofu, and ${plan.specWorkflow.label}.

## Goals / Non-Goals

**Goals:**

- Keep the generated baseline aligned to the approved Mission Control stack.
- Verify only deterministic local scaffold checks before archiving this bootstrap change.

**Non-Goals:**

- Define domain-specific product behavior in the bootstrap change.
- Deploy infrastructure, start containers, mutate GitHub, or perform cloud plan/apply operations.

## Decisions

- Use FastAPI and PydanticAI for backend APIs and orchestration.
- Use OpenTofu for Azure infrastructure.
- Use Docker Compose for local development.
${functionsDecision}

## Risks / Trade-offs

- Follow-up product changes own real business behavior; this seed only proves the generated local baseline is coherent.
`;
}

function seedCapabilityId(plan: ProjectPlan): string {
  if (plan.workload === 'power-apps-code-app') {
    return 'power-apps-code-app-baseline';
  }
  if (plan.workload === 'standard') {
    return `${plan.apiStack.id}-application-baseline`;
  }
  return `${genAiPattern(plan).id}-application-baseline`;
}

function seedCapabilityPurpose(plan: ProjectPlan): string {
  if (plan.workload === 'power-apps-code-app') {
    return `Define the generated ${plan.projectName} Power Apps code app baseline that setup verifies and archives before domain-specific implementation or deployment begins.`;
  }
  if (plan.workload === 'standard') {
    return `Define the generated ${plan.apiStack.label} application baseline that setup verifies and archives before domain-specific implementation or deployment begins.`;
  }
  return `Define the generated ${genAiPattern(plan).label} application baseline that setup verifies and archives before domain-specific implementation or deployment begins.`;
}

function renderSeedSpec(plan: ProjectPlan): string {
  const capability = seedCapabilityId(plan);
  const purpose = seedCapabilityPurpose(plan);
  if (plan.workload === 'power-apps-code-app') {
    return `## Purpose

${purpose}

## ADDED Requirements

### Requirement: Generated Power Apps code app baseline is locally verifiable
The bootstrap seed SHALL describe only the generated Power Apps code app scaffold, workflow configuration, and local validation boundary. Domain-specific screens, connector behavior, tenant binding, solution packaging, deployment, credentials, and other product behavior SHALL be deferred to later changes.

#### Scenario: Generated baseline is present
- **WHEN** the \`bootstrap-${plan.safeProjectName}\` change is generated
- **THEN** it declares the \`${capability}\` capability
- **AND** the generated React, Vite, TypeScript, Tailwind CSS, Power Apps SDK, workflow, and governance files are in scope

#### Scenario: Product behavior is deferred
- **WHEN** the bootstrap change is completed
- **THEN** no domain-specific connector, tenant, environment, solution, credential, deployment, backend API, Docker, or OpenTofu behavior is introduced

#### Scenario: Local baseline checks pass
- **WHEN** deterministic setup verifies the seed
- **THEN** \`liftoff validate\`, the root frontend build, and strict OpenSpec validation have passed
- **AND** backend, Docker, worker, and OpenTofu checks are recorded as inapplicable without placeholder commands
`;
  }

  if (plan.workload === 'standard') {
    return `## Purpose

${purpose}

## ADDED Requirements

### Requirement: Generated ${plan.apiStack.label} baseline is locally verifiable
The bootstrap seed SHALL describe only the generated ${plan.apiStack.label} backend, optional frontend, Docker Compose, OpenTofu, workflow configuration, and governance baseline. Domain-specific product behavior SHALL be deferred to later changes.

#### Scenario: Generated baseline is present
- **WHEN** the \`bootstrap-${plan.safeProjectName}\` change is generated
- **THEN** it declares the \`${capability}\` capability
- **AND** the generated backend, database, Docker Compose, OpenTofu, workflow, and governance files are in scope

#### Scenario: Product behavior is deferred
- **WHEN** the bootstrap change is completed
- **THEN** no domain-specific API, data model, UI, deployment, GitHub, or cloud mutation is introduced

#### Scenario: Local baseline checks pass
- **WHEN** deterministic setup verifies the seed
- **THEN** \`liftoff validate\`, backend tests, Docker Compose configuration validation, OpenTofu formatting, backend-disabled initialization, OpenTofu validation, and strict OpenSpec validation have passed
- **AND** frontend checks are run only when a frontend was generated
`;
  }

  const pattern = genAiPattern(plan);
  const worker = hasFunctionWorker(plan)
    ? 'Azure Functions worker, '
    : '';
  return `## Purpose

${purpose}

## ADDED Requirements

### Requirement: Generated ${pattern.label} baseline is locally verifiable
The bootstrap seed SHALL describe only the generated FastAPI/PydanticAI backend, ${worker}optional frontend, Docker Compose, OpenTofu, workflow configuration, and governance baseline. Domain-specific product behavior SHALL be deferred to later changes.

#### Scenario: Generated baseline is present
- **WHEN** the \`bootstrap-${plan.safeProjectName}\` change is generated
- **THEN** it declares the \`${capability}\` capability
- **AND** the generated GenAI backend, database, Docker Compose, OpenTofu, workflow, governance${hasFunctionWorker(plan) ? ', and worker' : ''} files are in scope

#### Scenario: Product behavior is deferred
- **WHEN** the bootstrap change is completed
- **THEN** no domain-specific prompts, tools, retrieval corpus, agent policy, UI, deployment, GitHub, or cloud mutation is introduced

#### Scenario: Local baseline checks pass
- **WHEN** deterministic setup verifies the seed
- **THEN** \`liftoff validate\`, backend tests,${hasFunctionWorker(plan) ? ' worker tests,' : ''} Docker Compose configuration validation, OpenTofu formatting, backend-disabled initialization, OpenTofu validation, and strict OpenSpec validation have passed
- **AND** frontend checks are run only when a frontend was generated
`;
}

interface SeedTaskCheck {
  id: string;
  label: string;
  command?: ExternalCommand;
  cwd?: readonly string[];
  inapplicable?: string;
}

function seedTaskChecks(plan: ProjectPlan): SeedTaskCheck[] {
  const checks: SeedTaskCheck[] = [
    {
      id: '2.1',
      label: 'Run Liftoff manifest validation',
      command: { executable: 'liftoff', args: ['validate'] }
    }
  ];
  if (plan.workload === 'power-apps-code-app') {
    checks.push({
      id: '2.2',
      label: 'Record backend tests as inapplicable',
      inapplicable: 'no Liftoff backend is generated for Power Apps code apps'
    });
  } else if (plan.workload === 'genai' || plan.apiStack.id === 'python-fastapi') {
    checks.push({
      id: '2.2',
      label: 'Run backend tests',
      command: { executable: 'uv', args: ['run', '--project', 'backend', 'python', '-m', 'pytest', '-q', 'backend/tests'] }
    });
  } else if (plan.apiStack.id === 'node-fastify') {
    checks.push({
      id: '2.2',
      label: 'Run backend tests',
      command: { executable: 'npm', args: ['test'] },
      cwd: ['backend']
    });
  } else {
    checks.push({
      id: '2.2',
      label: 'Run backend tests',
      command: { executable: 'go', args: ['test', './...'] },
      cwd: ['backend']
    });
  }

  if (plan.workload === 'genai' && hasFunctionWorker(plan)) {
    checks.push({
      id: '2.3',
      label: 'Run generated worker tests',
      command: { executable: 'uv', args: ['run', '--project', '../../backend', '--directory', '.', 'python', '-m', 'pytest', '-q'] },
      cwd: ['functions', functionWorkerName(plan)]
    });
  } else {
    checks.push({
      id: '2.3',
      label: 'Record worker tests as inapplicable',
      inapplicable: 'no generated worker boundary is present'
    });
  }

  if (plan.workload === 'power-apps-code-app') {
    checks.push({
      id: '2.4',
      label: 'Run frontend build',
      command: { executable: 'npm', args: ['run', 'build'] }
    });
  } else if (plan.includeFrontend) {
    checks.push({
      id: '2.4',
      label: 'Run frontend build',
      command: { executable: 'npm', args: ['run', 'build'] },
      cwd: ['frontend']
    });
  } else {
    checks.push({
      id: '2.4',
      label: 'Record frontend build as inapplicable',
      inapplicable: 'no generated frontend is present'
    });
  }

  if (plan.workload === 'power-apps-code-app') {
    checks.push({
      id: '2.5',
      label: 'Record Docker Compose validation as inapplicable',
      inapplicable: 'no generated Docker Compose boundary is present'
    });
    checks.push({
      id: '2.6',
      label: 'Record OpenTofu formatting as inapplicable',
      inapplicable: 'no generated OpenTofu boundary is present'
    });
    checks.push({
      id: '2.7',
      label: 'Record OpenTofu initialization as inapplicable',
      inapplicable: 'no generated OpenTofu boundary is present'
    });
    checks.push({
      id: '2.8',
      label: 'Record OpenTofu validation as inapplicable',
      inapplicable: 'no generated OpenTofu boundary is present'
    });
  } else {
    checks.push({
      id: '2.5',
      label: 'Validate Docker Compose configuration without startup',
      command: { executable: 'docker', args: ['compose', 'config', '-q'] }
    });
    checks.push({
      id: '2.6',
      label: 'Check OpenTofu formatting',
      command: { executable: 'tofu', args: ['fmt', '-check', '-recursive'] },
      cwd: ['infrastructure', 'opentofu', 'azure']
    });
    checks.push({
      id: '2.7',
      label: 'Initialize OpenTofu without a remote backend',
      command: { executable: 'tofu', args: ['init', '-backend=false'] },
      cwd: ['infrastructure', 'opentofu', 'azure']
    });
    checks.push({
      id: '2.8',
      label: 'Validate OpenTofu configuration without plan or apply',
      command: { executable: 'tofu', args: ['validate'] },
      cwd: ['infrastructure', 'opentofu', 'azure']
    });
  }

  checks.push({
    id: '2.9',
    label: 'Run strict OpenSpec validation',
    command: { executable: 'openspec', args: ['validate', `bootstrap-${plan.safeProjectName}`, '--strict'] }
  });
  return checks;
}

function renderSeedTaskCheck(check: SeedTaskCheck): string {
  if (!check.command) {
    return `- [ ] ${check.id} ${check.label}: inapplicable because ${check.inapplicable}.`;
  }
  const cwd = check.cwd && check.cwd.length > 0 ? ` from \`${check.cwd.join('/')}\`` : '';
  return `- [ ] ${check.id} ${check.label}${cwd}: \`${formatCommand(check.command)}\`.`;
}

function renderSeedTasks(plan: ProjectPlan): string {
  return `## 1. Bootstrap Scope

- [ ] 1.1 Confirm generated baseline files, \`liftoff.manifest.json\`, OpenSpec configuration, and the \`${seedCapabilityId(plan)}\` delta spec are present.
- [ ] 1.2 Confirm domain-specific product behavior is deferred to follow-up OpenSpec changes; do not replace generated placeholders in this bootstrap change.

## 2. Local Baseline Checks

${seedTaskChecks(plan).map(renderSeedTaskCheck).join('\n')}

## 3. Completion

- [ ] 3.1 After every applicable local check succeeds and every absent component is recorded inapplicable, archive with \`openspec archive bootstrap-${plan.safeProjectName} --yes\`, then require \`openspec validate --all --strict\` to pass. OpenSpec archive updates the main specs as part of archive; do not pass \`--skip-specs\`.

No task in this bootstrap seed starts containers, runs cloud plan/apply, mutates GitHub, or implements domain-specific product behavior.
`;
}

function renderSpecKitConstitution(plan: ApiProjectPlan): string {
  if (plan.workload === 'standard') {
    const backendLayout = plan.apiStack.id === 'python-fastapi'
      ? 'backend/apis'
      : plan.apiStack.id === 'node-fastify' ? 'backend/src' : 'backend/cmd/api and backend/internal';
    return `# Mission Control Liftoff Constitution

## Principle 1: Approved Application Stack
Generated backend services MUST use ${plan.apiStack.framework}, ${plan.apiStack.databaseTooling}, and Scalar for API documentation.

## Principle 2: Standard Project Layout
Backend APIs live under ${backendLayout}. Database artifacts live under database.${plan.includeFrontend ? ' Frontend code lives under frontend.' : ''}

## Principle 3: Infrastructure As Code
Cloud infrastructure MUST be defined with OpenTofu. Azure is the supported V1 provider.

## Principle 4: Local Development Parity
Projects MUST include Docker Compose for local development with PostgreSQL, Redis, local blob storage, and local messaging behavior.

## Principle 5: Observability And Operations
Services MUST use structured logging and environment-specific configuration for ${plan.environments.map((environment) => environment.id).join(', ')}.
`;
  }

  const functionsLayout = plan.workload === 'genai' && hasFunctionWorker(plan)
    ? ` Azure Functions trigger adapters live under functions/${functionWorkerName(plan)} and call shared orchestration from backend/orchestration.`
    : '';
  return `# Mission Control Liftoff Constitution

## Principle 1: Approved Application Stack
Generated backend services MUST use FastAPI, PydanticAI, Pydantic configuration models, and Scalar for API documentation.

## Principle 2: Standard Project Layout
Backend APIs live under backend/apis. Database artifacts live under database.${plan.includeFrontend ? ' Frontend code lives under frontend.' : ''}${functionsLayout}

## Principle 3: Infrastructure As Code
Cloud infrastructure MUST be defined with OpenTofu. Azure is the supported V1 provider.

## Principle 4: Local Development Parity
Projects MUST include Docker Compose for local development with PostgreSQL, Redis, local blob storage, and local messaging behavior.

## Principle 5: Observability And Operations
LLM workflows MUST include Langfuse tracing hooks and environment-specific configuration for ${plan.environments.map((environment) => environment.id).join(', ')}.
`;
}

function renderSpecKitSpecTemplate(): string {
  return `# Feature Specification

## User Scenarios

## Requirements

## Success Criteria
`;
}

function renderSpecKitPlanTemplate(): string {
  return `# Implementation Plan

## Technical Context

## Constitution Check

## Tasks
`;
}

function renderFrontendPackage(plan: ApiProjectPlan): string {
  return renderNpmPackage('frontend', `${plan.safeProjectName}-frontend`);
}

function renderFrontendIndex(plan: ApiProjectPlan): string {
  return `<div id="app"></div><script type="module" src="/src/main.ts"></script><title>${escapeHtml(plan.projectName)}</title>`;
}

function renderFrontendMain(): string {
  return `import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';

createApp(App).mount('#app');
`;
}

function renderFrontendApp(plan: ApiProjectPlan): string {
  const descriptor = plan.workload === 'genai'
    ? genAiPattern(plan).id === 'generic'
      ? genAiPattern(plan).label
      : `${genAiPattern(plan).label} starter`
    : `${plan.apiStack.label} starter`;
  const apiContract = plan.workload === 'standard'
    ? { route: '/api', method: 'GET', bodyField: '', queryParameter: '', requiresInput: false }
    : genAiPattern(plan).id === 'rag'
      ? { route: `${genAiPattern(plan).routePrefix}/query`, method: 'POST', bodyField: 'question', queryParameter: '', requiresInput: true }
      : genAiPattern(plan).id === 'streaming'
        ? { route: genAiPattern(plan).routePrefix, method: 'GET', bodyField: '', queryParameter: 'prompt', requiresInput: true }
        : { route: `${genAiPattern(plan).routePrefix}/run`, method: 'POST', bodyField: 'input', queryParameter: '', requiresInput: true };
  return `<script setup lang="ts">
import { ref } from 'vue';

const title = ${scriptSourceString(plan.projectName)};
const starter = ${scriptSourceString(plan.frontendStarter)};
const descriptor = ${scriptSourceString(descriptor)};
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\\/+$/, '');
const route = ${scriptSourceString(apiContract.route)};
const method = ${scriptSourceString(apiContract.method)};
const bodyField = ${scriptSourceString(apiContract.bodyField)};
const queryParameter = ${scriptSourceString(apiContract.queryParameter)};
const requiresInput = ${apiContract.requiresInput};

const input = ref('');
const loading = ref(false);
const result = ref('');
const errorMessage = ref('');

async function submit(): Promise<void> {
  const value = input.value.trim();
  if (requiresInput && !value) {
    errorMessage.value = 'Enter a value before running the starter.';
    return;
  }

  loading.value = true;
  result.value = '';
  errorMessage.value = '';
  try {
    const query = queryParameter
      ? '?' + queryParameter + '=' + encodeURIComponent(value)
      : '';
    const request: RequestInit = { method };
    if (method === 'POST') {
      request.headers = { 'Content-Type': 'application/json' };
      request.body = JSON.stringify({ [bodyField]: value });
    }
    const response = await fetch(apiBaseUrl + route + query, request);
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(
        'Backend request failed (' + response.status + '): ' +
        (responseText || response.statusText)
      );
    }
    if ((response.headers.get('content-type') || '').includes('application/json')) {
      result.value = JSON.stringify(JSON.parse(responseText), null, 2);
    } else {
      result.value = responseText;
    }
  } catch (error) {
    errorMessage.value = error instanceof Error
      ? error.message
      : 'The backend request failed unexpectedly.';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 text-slate-950">
    <section class="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-6 py-10">
      <header>
        <p class="text-sm font-semibold uppercase tracking-wide text-emerald-700">Mission Control Liftoff</p>
        <h1 class="mt-2 text-3xl font-bold">{{ title }}</h1>
        <p class="mt-2 text-slate-600">{{ descriptor }}</p>
      </header>
      <section class="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 class="text-xl font-semibold">{{ starter }}</h2>
        <p class="mt-2 text-sm text-slate-500">API: {{ apiBaseUrl }}{{ route }}</p>
        <textarea
          v-if="requiresInput"
          v-model="input"
          class="mt-4 min-h-40 w-full rounded-md border border-slate-300 p-3"
          :disabled="loading"
          placeholder="Enter input for the generated backend."
        />
        <button
          class="mt-4 rounded-md bg-emerald-700 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="loading"
          type="button"
          @click="submit"
        >
          {{ loading ? 'Running...' : 'Run' }}
        </button>
        <p v-if="errorMessage" class="mt-4 rounded-md bg-red-50 p-3 text-red-800" role="alert">
          {{ errorMessage }}
        </p>
        <pre v-if="result" class="mt-4 overflow-auto rounded-md bg-slate-950 p-4 text-sm text-white" aria-live="polite">{{ result }}</pre>
      </section>
    </section>
  </main>
</template>
`;
}

function renderFrontendStyles(): string {
  return `@import "tailwindcss";
`;
}

function renderFrontendViteConfig(): string {
  return `import { defineConfig } from 'vite';
  import tailwindcss from '@tailwindcss/vite';
  import vue from '@vitejs/plugin-vue';

  export default defineConfig({ plugins: [vue(), tailwindcss()] });
`;
}

function renderFrontendTailwindConfig(): string {
  return `import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: { extend: {} },
  plugins: []
} satisfies Config;
`;
}

function renderFrontendDockerfile(): string {
  return `FROM ${formatContainerImage(supportedStack.containers['node-runtime'])} AS build
WORKDIR /app
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts --no-audit --no-fund --registry="$NPM_CONFIG_REGISTRY"
COPY . .
ARG VITE_API_BASE_URL=http://localhost:8000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM ${formatContainerImage(supportedStack.containers['nginx-runtime'])}
COPY --from=build /app/dist /usr/share/nginx/html
`;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}