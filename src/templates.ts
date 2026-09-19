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
import { buildRepositoryGovernanceArtifacts } from './application/repository-governance/artifacts.js';
import { createArtifactAdder } from './generators/common/artifacts.js';
import { createHash } from 'node:crypto';
import { currentActivationIdentity } from './domain/governance/activation/graph.js';
import { ensureTrailingNewline } from './generators/common/artifacts.js';
import type { GenAiProjectPlan } from './domain/project/contracts.js';
import type { GeneratedArtifact } from './domain/project/contracts.js';
import { governancePolicyVersion } from './domain/governance/policy/content-validation.js';
import type { LiftoffManifest, LiftoffManifestV8, ManifestProvenance, ManifestStandards } from './domain/project/contracts.js';
import { liftoffVersion } from './version.js';
import type { ManifestWorkload } from './domain/project/contracts.js';
import { assertArtifactsSafeBeforeWrite } from './domain/standards/resource-catalog-schema.js';
import { loadPackagedTemplateCatalog, verifyComponentResourceClosure } from './adapters/packaged-assets/resource-catalog.js';
import type { ProjectPlan } from './domain/project/contracts.js';
import { generatedManifestStandards } from './application/project/manifest-provenance.js';

const contentHash = (content: string) => `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
export { AZURE_NAME_LIMITS, buildAzureResourceNames } from './generators/infrastructure/names.js';
export type { AzureResourceNames } from './generators/infrastructure/names.js';

export function resolveGeneratorContext(
  plan: ApiProjectPlan,
  assets: PackagedTemplateAssetContext = packagedTemplateAssets
): GeneratorContext {
  return createGeneratorContext(plan, assets, packagedSupportedStack);
}

export function selectedComponentsForPlan(plan: ProjectPlan): string[] {
  const selected: string[] = ['common-base'];
  if (plan.workload === 'standard') {
    selected.push(`backend-${plan.apiStack.id}`);
  } else if (plan.workload === 'genai') {
    selected.push('genai-common');
    selected.push(`genai-${plan.pattern.id}`);
  }
  if (plan.includeFrontend) {
    selected.push('frontend-vue');
  }
  selected.push('infrastructure-azure-opentofu');
  if (plan.specWorkflow.id === 'openspec') {
    selected.push('workflow-openspec');
  } else if (plan.specWorkflow.id === 'spec-kit') {
    selected.push('workflow-speckit');
  }
  if (plan.governanceProfile.id !== 'none') {
    selected.push('governance-single-maintainer-gitflow');
  }
  return selected;
}

export function composeProjectArtifacts(
  plan: ProjectPlan,
  context: GeneratorContext = resolveGeneratorContext(plan)
): GeneratedArtifact[] {
  const selectedComponents = selectedComponentsForPlan(plan);
  verifyComponentResourceClosure(selectedComponents);

  const catalog = loadPackagedTemplateCatalog();

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
      plan,
      context
    );
  }
  assertImmutableGeneratedContainerReferences(artifacts);

  for (const artifact of artifacts) {
    const owners = selectedComponents.filter((id) =>
      Object.hasOwn(catalog.components[id]?.artifactLifecycles ?? {}, artifact.logicalName));
    if (owners.length !== 1) {
      throw new Error(`Artifact ${artifact.logicalName} requires exactly one declared selected component owner; found ${owners.length}.`);
    }
    const owningComp = owners[0]!;
    const declaredLifecycle = catalog.components[owningComp]!.artifactLifecycles[artifact.logicalName];
    if (declaredLifecycle !== artifact.lifecycle) {
      throw new Error(`Artifact ${artifact.logicalName} lifecycle mismatch: catalog declared ${declaredLifecycle}, but emitted ${artifact.lifecycle}.`);
    }
    Object.defineProperty(artifact, 'component', {
      value: owningComp,
      enumerable: false,
      writable: false,
      configurable: false
    });
  }

  // Enforce collision and link safety across all outputs including manifest boundary
  assertArtifactsSafeBeforeWrite([
    ...artifacts,
    {
      logicalName: 'manifest',
      category: 'manifest',
      lifecycle: 'manifest',
      pathParts: ['liftoff.manifest.json']
    }
  ]);

  return artifacts;
}

export function buildArtifacts(plan: ProjectPlan, context: GeneratorContext = resolveGeneratorContext(plan)): GeneratedArtifact[] {
  const artifacts = composeProjectArtifacts(plan, context);

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
    provenance?: ManifestProvenance;
    standards?: ManifestStandards;
  } = {}
): LiftoffManifestV8 {
  const frameworkState = options.frameworkState ?? 'initialized';
  if (frameworkState === 'legacy' && !options.provenance) {
    throw new Error('Legacy framework uncertainty requires preserved original manifest provenance, not a new generation claim.');
  }
  if (plan.governanceProfile.id !== 'none' &&
    (currentActivationIdentity.manifestArtifactVersion !== 8 || currentActivationIdentity.policyVersion !== '8' ||
      currentActivationIdentity.credentialPolicySchemaVersion !== 2)) {
    throw new Error('Current manifest generation requires the explicitly registered manifest-8/policy-7 activation family.');
  }
  const standards = options.standards ?? generatedManifestStandards(plan);
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
    artifactVersion: 8,
    generatedBy: 'Mission Control Liftoff',
    liftoffVersion,
    standards,
    provenance: options.provenance ?? {
      kind: 'generated',
      origin: { kind: 'catalog', cliVersion: liftoffVersion, standards: structuredClone(standards) },
      repairs: []
    },
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
