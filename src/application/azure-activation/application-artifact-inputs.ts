import {
  applicationImageDigest, applicationImageRepository, applicationObject, applicationUuid,
  containerRegistryResourceId
} from '../../adapters/azure/application-provisioning.js';
import { azureArmBinding, createAzureCliArmTransport, type AzureArmBinding } from '../../adapters/azure/activation-rest.js';
import { validateWorkflowRunBinding, type WorkflowRunBinding } from '../../adapters/github/workflow-dispatch.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import { repositoryConfiguration } from '../../governance-activation/github-config.js';
import type { PhaseAdapterExecutionInput, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import type { ApprovalCostCeiling, TransitionOperation } from '../../domain/governance/activation/types.js';
import { normalizeApprovalCostCeiling } from '../../domain/governance/activation/approvals.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { LiftoffManifest, ManifestComponent } from '../../domain/project/contracts.js';
import { currentStandardsManifestContext } from '../../adapters/packaged-assets/resource-catalog.js';
import { AzureActivationAdmissionError } from './authority.js';
import { resolveAzureInputs } from './producer-discovery.js';

export type ApplicationArtifactRole = 'backend' | 'frontend';

export interface RequiredApplicationArtifact {
  role: ApplicationArtifactRole;
  component: ManifestComponent;
}

/** Component names are operator-owned; only registered profile facets select image roles. */
export function requiredApplicationArtifacts(manifest: LiftoffManifest): readonly RequiredApplicationArtifact[] {
  if (manifest.artifactVersion !== 8) {
    throw new AzureActivationAdmissionError('application-artifact-components', 'Artifact sets require actual manifest 8 component boundaries; historical single-image inputs remain a separate contract.');
  }
  const installed = currentStandardsManifestContext();
  if (manifest.standards.catalogDigest !== installed.profiles.digest ||
    manifest.standards.resourceCatalogDigest !== installed.resourceCatalogDigest) {
    throw new AzureActivationAdmissionError('application-artifact-components', 'Artifact roles require the exact installed manifest profile and resource catalogs.');
  }
  const result: RequiredApplicationArtifact[] = manifest.standards.components.map((component) => {
    const profile = Object.values(installed.profiles.profiles).find((entry) => entry.id === component.profile.id);
    if (!profile || canonicalSha256(component.profile) !== canonicalSha256({
      schemaVersion: 1, id: profile.id, revision: profile.revision, digest: profile.digest
    }) || !(profile.capabilities.backend && ['backend', 'genai'].includes(profile.category) ||
      !profile.capabilities.backend && profile.category === 'frontend')) {
      throw new AzureActivationAdmissionError('application-artifact-components', 'Every application component must have an exact registered backend or frontend profile facet.');
    }
    return { role: profile.capabilities.backend ? 'backend' : 'frontend', component: structuredClone(component) };
  });
  const backends = result.filter((entry) => entry.role === 'backend');
  const frontends = result.filter((entry) => entry.role === 'frontend');
  const workload = manifest.project.workload;
  if (backends.length !== 1 || frontends.length > 1 || result.length !== backends.length + frontends.length ||
    workload.kind !== 'components' && (frontends.length !== Number(workload.frontend) ||
      backends[0]!.component.profile.id !== (workload.kind === 'genai' ? `genai-${workload.pattern}` : workload.apiStack))) {
    throw new AzureActivationAdmissionError('application-artifact-components', 'This artifact set requires one actual backend and every configured frontend, with manifest workload and component facets in agreement.');
  }
  return [...backends, ...frontends];
}

export interface ApplicationArtifactInputs {
  azure: AzureArmBinding;
  region: string;
  resourceGroup: string;
  acrName: string;
  imageName: string;
  registryResourceId: string;
  expectedDigest?: string;
  artifactName: string;
  platform: 'linux/amd64' | 'linux/arm64';
  maxRunMinutes: number;
  budget: ApprovalCostCeiling;
  workflow: WorkflowRunBinding;
  dispatchInputs: Record<string, string>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new AzureActivationAdmissionError('application-configuration', `${label} must be an exact bounded public string.`);
  }
  return value;
}

function positive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new AzureActivationAdmissionError('application-configuration', `${label} requires an actual positive numeric provider identity.`);
  }
  return value;
}

function workflowBinding(value: unknown): WorkflowRunBinding {
  const data = applicationObject(value, 'Application build workflow', [
    'repository', 'repositoryId', 'workflowPath', 'workflowId', 'workflowDigest', 'sourceSha',
    'producerSourceSha', 'ref', 'actorId', 'event', 'expectedJobs', 'runAttempt'
  ]);
  if (data.event !== 'workflow_dispatch' || data.runAttempt !== 1 || !Array.isArray(data.expectedJobs)) {
    throw new AzureActivationAdmissionError('application-configuration', 'Build requires its exact first workflow-dispatch attempt and required jobs.');
  }
  const workflow: WorkflowRunBinding = {
    repository: text(data.repository, 'Build repository'), repositoryId: positive(data.repositoryId, 'Build repository ID'),
    workflowPath: text(data.workflowPath, 'Build workflow path'), workflowId: positive(data.workflowId, 'Build workflow ID'),
    workflowDigest: text(data.workflowDigest, 'Build workflow digest'), sourceSha: text(data.sourceSha, 'Build source commit'),
    ...(data.producerSourceSha === undefined ? {} : { producerSourceSha: text(data.producerSourceSha, 'Build producer source commit') }),
    ref: text(data.ref, 'Build ref'), actorId: positive(data.actorId, 'Build actor ID'),
    event: 'workflow_dispatch', expectedJobs: data.expectedJobs.map((job) => text(job, 'Required build job')), runAttempt: 1
  };
  validateWorkflowRunBinding(workflow);
  return workflow;
}

export function applicationArtifactInputs(input: Pick<PhasePlanningInput, 'inspection' | 'phase'>): ApplicationArtifactInputs {
  if (input.phase.id !== 'application-artifact-ready') throw new AzureActivationAdmissionError('application-phase', 'Application build inputs belong only to application-artifact-ready.');
  const manifest = input.inspection.manifest;
  if (manifest.project.workload.kind !== 'components' && manifest.project.workload.frontend ||
    manifest.artifactVersion === 8 && requiredApplicationArtifacts(manifest).some((entry) => entry.role === 'frontend')) {
    throw new AzureActivationAdmissionError('application-artifact-set-required', 'A configured frontend requires its own reviewed artifact-set build; the single-image compatibility API cannot stand in for another role.');
  }
  const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  return applicationArtifactBindingInputs(configuration?.phases['application-artifact-ready'], {
    azure: resolveAzureInputs(input), budget: configuration?.budget,
    repository: repositoryConfiguration(input.inspection).name,
    repositoryId: input.inspection.state.remoteBinding?.id
  });
}

/** Pure binding parser shared by the legacy facade and exact set selections; not execution authority. */
export function applicationArtifactBindingInputs(value: unknown, context: {
  azure: { subscriptionId?: unknown; tenantId?: unknown; region?: unknown };
  budget: unknown;
  repository: string;
  repositoryId: string | undefined;
}): ApplicationArtifactInputs {
  const data = applicationObject(value, 'Application artifact configuration', [
    'subscriptionId', 'tenantId', 'region', 'principalId', 'resourceGroup', 'acrName', 'imageName',
    'expectedDigest', 'workflow', 'dispatchInputs', 'artifactName', 'platform', 'maxRunMinutes'
  ]);
  if (!context.budget) throw new AzureActivationAdmissionError('application-budget', 'Application build requires an explicitly reviewed cost ceiling; no default spending authority is inferred.');
  applicationObject(context.budget, 'Build cost ceiling', ['currency', 'fixedMonthlyCents', 'usageMonthlyCents']);
  let budget: ApprovalCostCeiling;
  try { budget = normalizeApprovalCostCeiling(context.budget as ApprovalCostCeiling); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new AzureActivationAdmissionError('application-budget', 'Application build requires an explicit valid currency and non-negative safe integer cost ceilings.');
  }
  const scope = context.azure;
  const azure = azureArmBinding({
    subscriptionId: applicationUuid(scope.subscriptionId, 'Build subscription'),
    tenantId: applicationUuid(scope.tenantId, 'Build tenant'),
    principalId: applicationUuid(data.principalId, 'Explicit build-readback Azure principal')
  });
  const region = text(scope.region, 'Build registry region');
  if (!/^[a-z0-9-]+$/u.test(region)) throw new AzureActivationAdmissionError('application-region', 'Build registry region must be an exact declared Azure region.');
  const resourceGroup = text(data.resourceGroup, 'Build registry resource group');
  const acrName = text(data.acrName, 'Build registry name');
  const registryResourceId = containerRegistryResourceId(azure.subscriptionId, resourceGroup, acrName);
  const imageName = applicationImageRepository(data.imageName);
  const artifactName = text(data.artifactName, 'Build report artifact name');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(artifactName)) throw new AzureActivationAdmissionError('application-artifact-name', 'Build report artifact requires one exact portable name.');
  if (data.platform !== 'linux/amd64' && data.platform !== 'linux/arm64') {
    throw new AzureActivationAdmissionError('application-platform', 'Build requires an explicitly selected supported single OCI platform.');
  }
  const maxRunMinutes = positive(data.maxRunMinutes, 'Build job time limit');
  if (maxRunMinutes > 30) throw new AzureActivationAdmissionError('application-time-bound', 'Application build jobs require an explicit limit of at most thirty minutes.');
  const workflow = workflowBinding(data.workflow);
  if (workflow.repository !== context.repository || String(workflow.repositoryId) !== context.repositoryId) {
    throw new AzureActivationAdmissionError('application-repository', 'Build repository identity must equal the explicitly verified remote binding.');
  }
  const supplied = applicationObject(data.dispatchInputs, 'Application build dispatch inputs', [
    'source_sha', 'registry_resource_id', 'image_repository', 'artifact_name', 'platform'
  ]);
  const dispatchInputs = {
    source_sha: workflow.sourceSha, registry_resource_id: registryResourceId,
    image_repository: imageName, artifact_name: artifactName, platform: data.platform
  };
  if (canonicalSha256(supplied) !== canonicalSha256(dispatchInputs)) {
    throw new AzureActivationAdmissionError('application-dispatch-target', 'Dispatch inputs must bind the exact source, registry, image repository, report name and platform; no target or command input is inferred.');
  }
  return {
    azure, region, resourceGroup, acrName, registryResourceId, imageName, artifactName,
    platform: data.platform, maxRunMinutes, budget, workflow, dispatchInputs,
    ...(data.expectedDigest === undefined ? {} : { expectedDigest: applicationImageDigest(data.expectedDigest) })
  };
}

export function applicationArtifactOperations(config: ApplicationArtifactInputs): TransitionOperation[] {
  return [{
    phaseId: 'application-artifact-ready', adapter: 'github', actionId: 'github.artifact.build-dispatch',
    mutationClass: 'github-workflow-dispatch', remote: true, destructive: false,
    destination: { type: 'repository', identity: config.workflow.repository, repository: config.workflow.repository },
    inputs: { workflow: config.workflow, dispatchInputs: config.dispatchInputs, application: config },
    effects: [
      { mutationClass: 'github-read', destination: { type: 'repository', identity: config.workflow.repository, repository: config.workflow.repository }, remote: true, destructive: false },
      { mutationClass: 'registry-publish', destination: {
        type: 'subscription', identity: config.registryResourceId, subscriptionId: config.azure.subscriptionId
      }, remote: true, destructive: false }
    ]
  }, {
    phaseId: 'application-artifact-ready', adapter: 'azure-opentofu', actionId: 'azure.artifact.readback',
    mutationClass: 'azure-read', remote: true, destructive: false,
    destination: { type: 'subscription', identity: config.registryResourceId, subscriptionId: config.azure.subscriptionId },
    inputs: { application: config }
  }];
}

export function defaultAzureArmTransport(input: PhaseAdapterExecutionInput) {
  return azurePorts(input).transport ?? createAzureCliArmTransport(input.runner, input.inspection.projectRoot, {
    now: () => (input.clock?.() ?? input.now).getTime()
  });
}
