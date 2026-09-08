import { createGeneratorContext } from './generators/context.js';
import {
  packagedTemplateAssets,
  type PackagedTemplateAssetContext
} from './adapters/packaged-assets/template-assets.js';
import { packagedSupportedStack } from './adapters/packaged-assets/supported-stack.js';
import type { GeneratorContext } from './generators/context.js';
import type { AddArtifact } from './template-types.js';
import { addBaseArtifacts } from './generators/common/base.js';
import { addDockerArtifacts } from './generators/containers/compose.js';
import { addEnvironmentArtifacts } from './generators/common/environments.js';
import { addFrontendArtifacts } from './generators/common/frontend.js';
import { addGenAiExtensionArtifacts } from './generators/genai/index.js';
import { addInfrastructureArtifacts } from './generators/infrastructure/azure.js';
import { addSpecWorkflowArtifacts } from './generators/common/spec-workflow.js';
import { addStandardStackArtifacts } from './generators/standard/index.js';
import type { ApiProjectPlan } from './domain/project/contracts.js';
import { assertImmutableGeneratedContainerReferences } from './container-validation.js';
import { buildRepositoryGovernanceArtifacts } from './repository-governance.js';
import { createArtifactAdder } from './generators/common/artifacts.js';
import { createHash } from 'node:crypto';
import { currentActivationIdentity } from './governance-activation/graph.js';
import { ensureTrailingNewline } from './generators/common/artifacts.js';
import type { GenAiProjectPlan } from './domain/project/contracts.js';
import type { GeneratedArtifact } from './domain/project/contracts.js';
import { governancePolicyVersion } from './repository-governance.js';
import type { LiftoffManifest } from './domain/project/contracts.js';
import { liftoffVersion } from './version.js';
import type { ManifestWorkload } from './domain/project/contracts.js';
import type { ProjectPlan } from './domain/project/contracts.js';

const contentHash = (content: string) => `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
export { AZURE_NAME_LIMITS, buildAzureResourceNames } from './generators/infrastructure/names.js';
export type { AzureResourceNames } from './generators/infrastructure/names.js';

export function resolveGeneratorContext(
  plan: ApiProjectPlan,
  assets: PackagedTemplateAssetContext = packagedTemplateAssets
): GeneratorContext {
  return createGeneratorContext(plan, assets, packagedSupportedStack);
}

export function buildArtifacts(plan: ProjectPlan, context: GeneratorContext = resolveGeneratorContext(plan)): GeneratedArtifact[] {
  const artifacts: GeneratedArtifact[] = [];
  const addProject = createArtifactAdder(artifacts, 'project', 'base');
  const addDesiredState = createArtifactAdder(artifacts, 'desired-state');
  const addFramework = createArtifactAdder(artifacts, 'framework');
  const addSeed = createArtifactAdder(artifacts, 'seed');

  switch (plan.workload) {
    case 'genai':
      addGenAiWorkloadArtifacts(addProject, addDesiredState, artifacts, plan, context);
      break;
    case 'standard':
      addStandardWorkloadArtifacts(addProject, addDesiredState, artifacts, plan, context);
      break;
  }
  addSpecWorkflowArtifacts(addSeed, addFramework, plan);
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

  return artifacts;
}

function addGenAiWorkloadArtifacts(
  add: AddArtifact,
  addDesiredState: AddArtifact,
  artifacts: GeneratedArtifact[],
  plan: GenAiProjectPlan, context: GeneratorContext
): void {
  addBaseArtifacts(add, addDesiredState, plan, context);
  addGenAiExtensionArtifacts(add, plan, context);
  addApiWorkloadOperations(add, artifacts, plan, context);
}

function addStandardWorkloadArtifacts(
  add: AddArtifact,
  addDesiredState: AddArtifact,
  artifacts: GeneratedArtifact[],
  plan: Extract<ProjectPlan, { workload: 'standard' }>, context: GeneratorContext
): void {
  addBaseArtifacts(add, addDesiredState, plan, context);
  addStandardStackArtifacts(add, plan, context);
  addApiWorkloadOperations(add, artifacts, plan, context);
}

function addApiWorkloadOperations(
  add: AddArtifact,
  artifacts: GeneratedArtifact[],
  plan: ApiProjectPlan, context: GeneratorContext
): void {
  addEnvironmentArtifacts(artifacts, plan);
  addDockerArtifacts(add, plan, context);
  addInfrastructureArtifacts(add, artifacts, plan, context);
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
  const workload: ManifestWorkload = plan.workload === 'genai'
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
