import { createGeneratorContext } from './generators/context.js';
import type { PackagedTemplateAssetContext } from './adapters/packaged-assets/template-assets.js';
import { packagedSupportedStack } from './adapters/packaged-assets/supported-stack.js';
import type { GeneratorContext } from './generators/context.js';
import type { AddArtifact } from './template-types.js';
import { addBaseArtifacts } from './generators/common/base.js';
import { addDockerArtifacts } from './generators/containers/compose.js';
import { addEnvironmentArtifacts } from './generators/common/environments.js';
import { addFrontendArtifacts } from './generators/common/frontend.js';
import { boundRenderers, type BoundRenderers } from './application/project/plugin-renderers.js';
import {
  builtinTemplateAssets, composeModernManifestPlugins, composeProjectPlugins,
  pluginSelectionForPlan, templateAssetsFromRegistry
} from './application/project/plugins.js';
import type { CurrentProjectPlan as ApiProjectPlan } from './domain/project/contracts.js';
import { assertImmutableGeneratedContainerReferences } from './container-validation.js';
import { buildRepositoryGovernanceArtifacts } from './repository-governance.js';
import { createArtifactAdder } from './generators/common/artifacts.js';
import { createHash } from 'node:crypto';
import { currentActivationIdentity } from './governance-activation/graph.js';
import { ensureTrailingNewline } from './generators/common/artifacts.js';
import type { CurrentGenAiProjectPlan as GenAiProjectPlan } from './domain/project/contracts.js';
import type { GeneratedArtifact } from './domain/project/contracts.js';
import { governancePolicyVersion } from './repository-governance.js';
import type { LiftoffManifest } from './domain/project/contracts.js';
import { liftoffVersion } from './version.js';
import type { ManifestWorkload } from './domain/project/contracts.js';
import type { ProjectPlan } from './domain/project/contracts.js';
import { buildModernManagedCore } from './application/project/modern-managed-core.js';
import { createManifestV8Candidate } from './application/project/manifest-writer.js';
import { modernSourceRegistry } from './application/project/modern-plugins.js';
import { projectCatalog } from './application/project/catalog.js';
import { createManifestV8ProjectReader } from './domain/project/manifest/v8-project.js';
import { readManifestPluginMetadata } from './domain/project/manifest/plugins.js';
import { freshActiveLayoutForComposition } from './application/project/manifest.js';

const contentHash = (content: string) => `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
export { AZURE_NAME_LIMITS, buildAzureResourceNames } from './generators/infrastructure/names.js';
export type { AzureResourceNames } from './generators/infrastructure/names.js';

export function resolveGeneratorContext(
  plan: ApiProjectPlan,
  assets: PackagedTemplateAssetContext = builtinTemplateAssets()
): GeneratorContext {
  return createGeneratorContext(plan, assets, packagedSupportedStack);
}

export function buildArtifacts(plan: ProjectPlan, context: GeneratorContext = resolveGeneratorContext(plan)): GeneratedArtifact[] {
  // Resolve, materialize and validate every identity before any renderer runs.
  const composition = composeProjectPlugins(plan);
  const renderers = boundRenderers(composition.resolution);
  const artifacts = renderWorkloadArtifacts(plan, context, renderers);
  for (const artifact of buildRepositoryGovernanceArtifacts(plan)) {
    artifacts.push({ ...artifact, content: ensureTrailingNewline(artifact.content) });
  }
  if (plan.includeFrontend) {
    addFrontendArtifacts(
      createArtifactAdder(artifacts, 'project', 'frontend'),
      plan
    , context);
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

  // Nothing is returned, and so nothing can be written, unless every rendered identity verifies.
  composition.verify(artifacts);
  return artifacts;
}

export function buildCurrentArtifacts(
  plan: ApiProjectPlan,
  context: GeneratorContext = resolveGeneratorContext(plan, templateAssetsFromRegistry(modernSourceRegistry()))
): GeneratedArtifact[] {
  const composition = composeModernManifestPlugins(pluginSelectionForPlan(plan), { safeProjectName: plan.safeProjectName });
  const currentContext: GeneratorContext = { ...context, current: true };
  const artifacts = renderWorkloadArtifacts(plan, currentContext, boundRenderers(composition.resolution));
  if (plan.includeFrontend) {
    addFrontendArtifacts(createArtifactAdder(artifacts, 'project', 'frontend'), plan, currentContext);
  }
  assertImmutableGeneratedContainerReferences(artifacts);
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({
    project: {
      name: plan.projectName,
      workload: manifestWorkloadForPlan(plan),
      specWorkflow: plan.specWorkflow.id,
      agents: plan.agents.map(agent => agent.id),
      ...(plan.defaultAgent ? { defaultAgent: plan.defaultAgent.id } : {})
    },
    framework: plan.framework
      ? { state: 'initialized', adapter: plan.framework.id, contractVersion: plan.framework.version }
      : { state: 'not-required' }
  });
  const selection = { ...leaf, profile: plan.governanceProfile.id };
  const plugins = readManifestPluginMetadata({
    schemaVersion: 1,
    resolutionDigest: composition.resolution.digest,
    selections: composition.resolution.plugins
  }, {
    stack: plan.apiStack.id, cloud: plan.provider.id,
    workflow: plan.specWorkflow.id, agents: plan.agents.map(agent => agent.id)
  });
  const activeLayout = freshActiveLayoutForComposition(composition);
  artifacts.push(...buildModernManagedCore({ selection, plugins, activeLayout }).map(artifact => ({
    ...artifact, pathParts: [...artifact.pathParts]
  })));
  const candidate = createManifestV8Candidate({ origin: 'fresh', selection, generatedArtifacts: artifacts, activeLayout });
  artifacts.push({
    logicalName: 'manifest', category: 'manifest', lifecycle: 'manifest',
    pathParts: ['liftoff.manifest.json'], content: candidate.content
  });
  return artifacts;
}

function renderWorkloadArtifacts(
  plan: ApiProjectPlan,
  context: GeneratorContext,
  renderers: BoundRenderers
): GeneratedArtifact[] {
  const artifacts: GeneratedArtifact[] = [];
  const addProject = createArtifactAdder(artifacts, 'project', 'base');
  const addDesiredState = createArtifactAdder(artifacts, 'desired-state');
  const addFramework = createArtifactAdder(artifacts, 'framework');
  const addSeed = createArtifactAdder(artifacts, 'seed');

  switch (plan.workload) {
    case 'genai':
      addGenAiWorkloadArtifacts(addProject, addDesiredState, artifacts, plan, context, renderers);
      break;
    case 'standard':
      addStandardWorkloadArtifacts(addProject, addDesiredState, artifacts, plan, context, renderers);
      break;
  }
  renderers.renderWorkflow(addSeed, addFramework, plan);
  return artifacts;
}

function addGenAiWorkloadArtifacts(
  add: AddArtifact,
  addDesiredState: AddArtifact,
  artifacts: GeneratedArtifact[],
  plan: GenAiProjectPlan, context: GeneratorContext,
  renderers: BoundRenderers
): void {
  addBaseArtifacts(add, addDesiredState, plan, context);
  renderers.renderGenAiStack(add, plan, context);
  addApiWorkloadOperations(add, artifacts, plan, context, renderers);
}

function addStandardWorkloadArtifacts(
  add: AddArtifact,
  addDesiredState: AddArtifact,
  artifacts: GeneratedArtifact[],
  plan: Extract<ApiProjectPlan, { workload: 'standard' }>, context: GeneratorContext,
  renderers: BoundRenderers
): void {
  addBaseArtifacts(add, addDesiredState, plan, context);
  renderers.renderStandardStack(add, plan, context);
  addApiWorkloadOperations(add, artifacts, plan, context, renderers);
}

function addApiWorkloadOperations(
  add: AddArtifact,
  artifacts: GeneratedArtifact[],
  plan: ApiProjectPlan, context: GeneratorContext,
  renderers: BoundRenderers
): void {
  addEnvironmentArtifacts(artifacts, plan);
  addDockerArtifacts(add, plan, context);
  renderers.renderCloud(add, artifacts, plan, context);
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

function manifestWorkloadForPlan(plan: ApiProjectPlan): ManifestWorkload {
  return plan.workload === 'genai'
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
  const workload = manifestWorkloadForPlan(plan);
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
