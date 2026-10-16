import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import type {
  ApprovalCostCeiling,
  LiveReadbackProof,
  PhaseOutputBindings,
  TransitionOperation
} from '../domain/governance/activation/types.js';
import { projectIdentityDigest, boundedToken } from '../generators/infrastructure/names.js';
import {
  GitHubActivationError,
  object as githubObject,
  positiveId,
  safeGitHubFailure,
  text as githubText
} from '../adapters/github/activation-rest.js';
import type {
  PhaseAdapterExecutionInput,
  PhaseAdapterOutcome,
  PhasePlanningInput
} from './transition-ports.js';
import {
  AzureDiscoveryError,
  azureObject,
  azureText,
  runAzureJson
} from './azure-discovery.js';
import {
  bootstrapBinding,
  type BootstrapBinding
} from './azure-backend-bootstrap.js';
import {
  observeBackendIdentity
} from './azure-backend-readiness.js';
import {
  azurePermits,
  observeAzureEffectivePermissions
} from './azure-permissions.js';
import {
  assertGitHubAuthorized,
  clientFor,
  repositoryConfiguration,
  verifiedOutput
} from './github-config.js';
import { runnerPreflightWorkflowAllowlist } from './credentials.js';
import { readbackProof } from './transition-records.js';

const networkSettingsApiVersion = '2024-04-02';
const supportedRunnerStatus = new Set(['Ready', 'Provisioning', 'Shutdown', 'Deleting', 'Stuck']);
const requiredAzureActions = [
  'GitHub.Network/networkSettings/read',
  'GitHub.Network/networkSettings/write',
  'Microsoft.Network/virtualNetworks/subnets/read',
  'Microsoft.Network/natGateways/read',
  'Microsoft.Network/privateDnsZones/virtualNetworkLinks/read',
  'Microsoft.Network/privateEndpoints/privateDnsZoneGroups/read'
] as const;

interface RunnerBinding {
  bootstrap: BootstrapBinding;
  organization: string;
  organizationId: number;
  repository: string;
  repositoryId: number;
  environment: string;
  egressMode: 'nat-gateway';
  label: string;
  imageId: 'ubuntu-latest';
  imageSource: 'github';
  machineSize: '4-core';
  maximumRunners: 1;
  networkSettingsName: string;
  networkSettingsResourceId: string;
  networkConfigurationName: string;
  runnerGroupName: string;
  selectedWorkflows: readonly string[];
  subnetResourceId: string;
  natGatewayResourceId: string;
  dnsLinkResourceId: string;
  dnsZoneGroupResourceId: string;
  budget: ApprovalCostCeiling;
  bindingDigest: string;
}

interface AzureRunnerNetworkObservation {
  networkSettingsId: string;
  networkSettings: Record<string, unknown>;
  subnet: Record<string, unknown>;
  natGateway: Record<string, unknown>;
  dnsLink: Record<string, unknown>;
  dnsZoneGroup: Record<string, unknown>;
  permissions: {
    requiredActions: readonly string[];
    permissionEntryCount: number;
  };
  liveReadback: readonly LiveReadbackProof[];
}

interface GitHubRunnerPreflight {
  organization: Record<string, unknown>;
  repository: Record<string, unknown>;
  image: Record<string, unknown>;
  machineSize: Record<string, unknown>;
}

interface GitHubRunnerObservation {
  networkConfiguration: Record<string, unknown>;
  networkSettings: Record<string, unknown>;
  group: Record<string, unknown>;
  runner: Record<string, unknown>;
  networkConfigurationId: string;
  groupId: number;
  runnerId: number;
  status: string;
  repositoryAssigned: boolean;
  liveReadback: readonly LiveReadbackProof[];
}

function runnerError(code: string, message: string): never {
  throw new GitHubActivationError(code, message);
}

class RunnerWriteDispatchedError extends GitHubActivationError {}

function dispatchedGitHubWrite(error: unknown): never {
  if (error instanceof GitHubActivationError) {
    throw new RunnerWriteDispatchedError(error.code, error.message, error.status);
  }
  throw error;
}

function exactObject(
  value: unknown,
  allowed: readonly string[],
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))) {
    return runnerError('runner-configuration', `${label} is absent or contains unsupported fields.`);
  }
  return value as Record<string, unknown>;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)) {
    return runnerError('runner-configuration', `${label} is absent or invalid.`);
  }
  return value;
}

function exactPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    return runnerError('runner-configuration', `${label} must be an exact positive provider identifier.`);
  }
  return Number(value);
}

function resourceOfType(
  bootstrap: BootstrapBinding,
  resourceType: string,
  resourceIdSuffix?: string
): string {
  const matches = bootstrap.resourceIds.filter((resource) =>
    resource.resourceType === resourceType &&
    (!resourceIdSuffix || resource.resourceId.endsWith(resourceIdSuffix)));
  if (matches.length !== 1) {
    return runnerError(
      'runner-bootstrap-binding',
      `The verified bootstrap must expose exactly one ${resourceType} resource.`
    );
  }
  return matches[0]!.resourceId;
}

function budget(input: PhasePlanningInput | PhaseAdapterExecutionInput): ApprovalCostCeiling {
  const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  if (!configuration?.budget || configuration.budget.fixedMonthlyCents <= 0 ||
    configuration.budget.usageMonthlyCents <= 0) {
    return runnerError(
      'runner-cost',
      'Runner readiness requires an exact reviewed nonzero fixed and usage monthly cost ceiling.'
    );
  }
  return configuration.budget;
}

function predecessorBinding(
  input: PhasePlanningInput | PhaseAdapterExecutionInput,
  bootstrap: BootstrapBinding
): void {
  const phase = input.inspection.state.phases['bootstrap-local'];
  const output = input.inspection.state.phaseOutputs?.['bootstrap-local'];
  if (phase.state !== 'verified' || !output ||
    output.values.bootstrapBindingDigest !== bootstrap.bindingDigest ||
    output.values.environment !== bootstrap.environment ||
    output.values.egressMode !== bootstrap.egressMode) {
    return runnerError(
      'runner-bootstrap-binding',
      'Runner readiness requires current verified bootstrap-local outputs for the exact network and egress binding.'
    );
  }
  const provider = input.inspection.state.phases['provider-ready'];
  const providerOutput = input.inspection.state.phaseOutputs?.['provider-ready'];
  if (provider.state !== 'verified' || !providerOutput?.resources.some((resource) =>
    resource.provider === 'azure' &&
    resource.resourceId.toLowerCase() ===
      `/subscriptions/${bootstrap.backend.subscriptionId}/providers/github.network`.toLowerCase())) {
    return runnerError(
      'runner-provider-binding',
      'Runner readiness requires current verified GitHub.Network provider registration in the selected subscription.'
    );
  }
}

export function runnerBinding(
  input: PhasePlanningInput | PhaseAdapterExecutionInput
): RunnerBinding {
  const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  if (!configuration) {
    return runnerError('runner-configuration', 'Runner readiness requires exact reviewed activation inputs.');
  }
  const phase = exactObject(configuration.phases['runner-ready'], [
    'environment',
    'organizationId',
    'egressMode',
    'image',
    'size',
    'maximumRunners'
  ], 'Reviewed runner-ready configuration');
  const bootstrap = bootstrapBinding(input);
  predecessorBinding(input, bootstrap);
  const repository = repositoryConfiguration(input.inspection);
  const [organization] = repository.name.split('/');
  const environment = exactString(phase.environment, 'Runner environment');
  if (environment !== bootstrap.environment) {
    return runnerError(
      'runner-environment',
      'Runner environment must exactly match the verified bootstrap-local environment.'
    );
  }
  if (phase.egressMode !== 'nat-gateway' || phase.egressMode !== bootstrap.egressMode) {
    return runnerError(
      'runner-egress',
      'Runner readiness qualifies exactly the verified nat-gateway egress mode.'
    );
  }
  if (phase.image !== 'ubuntu-latest' || phase.size !== '4-core' ||
    phase.maximumRunners !== 1) {
    return runnerError(
      'runner-capacity',
      'Runner readiness qualifies ubuntu-latest on 4-core capacity with maximumRunners fixed at 1.'
    );
  }
  const digest = projectIdentityDigest({ projectName: input.inspection.manifest.project.name });
  const environmentToken = boundedToken(environment.toLowerCase().replace(/[^a-z0-9-]/gu, '-'), 12);
  const token = `${digest}-${environmentToken}`;
  const label = `liftoff-${token}-private-staging`;
  const networkSettingsName = `ghns-${token}`;
  const networkConfigurationName = `liftoff-${token}-network`;
  const runnerGroupName = `liftoff-${token}-private-staging`;
  const networkSettingsResourceId =
    `/subscriptions/${bootstrap.backend.subscriptionId}/resourceGroups/${bootstrap.resourceGroup}` +
    `/providers/GitHub.Network/networkSettings/${networkSettingsName}`;
  const selectedWorkflows = runnerPreflightWorkflowAllowlist.map((workflow) =>
    `${repository.name}/${workflow.path}@refs/heads/${repository.defaultBranch}`);
  const provisional = {
    bootstrapBindingDigest: bootstrap.bindingDigest,
    organization,
    organizationId: exactPositiveInteger(phase.organizationId, 'GitHub organization ID'),
    repository: repository.name,
    repositoryId: exactPositiveInteger(
      verifiedOutput(input.inspection, 'phase-0-complete', 'repositoryId'),
      'Verified repository ID'
    ),
    environment,
    egressMode: 'nat-gateway' as const,
    label,
    imageId: 'ubuntu-latest' as const,
    imageSource: 'github' as const,
    machineSize: '4-core' as const,
    maximumRunners: 1 as const,
    networkSettingsName,
    networkSettingsResourceId,
    networkConfigurationName,
    runnerGroupName,
    selectedWorkflows,
    subnetResourceId: resourceOfType(
      bootstrap,
      'Microsoft.Network/virtualNetworks/subnets',
      `/subnets/${bootstrap.runnerSubnetName}`
    ),
    natGatewayResourceId: resourceOfType(bootstrap, 'Microsoft.Network/natGateways'),
    dnsLinkResourceId: resourceOfType(
      bootstrap,
      'Microsoft.Network/privateDnsZones/virtualNetworkLinks'
    ),
    dnsZoneGroupResourceId: resourceOfType(
      bootstrap,
      'Microsoft.Network/privateEndpoints/privateDnsZoneGroups'
    ),
    budget: budget(input)
  };
  return {
    bootstrap,
    ...provisional,
    bindingDigest: canonicalSha256(provisional)
  };
}

export function runnerNetworkPlanInputs(
  input: PhasePlanningInput | PhaseAdapterExecutionInput
): Record<string, unknown> {
  const binding = runnerBinding(input);
  return {
    runnerBindingDigest: binding.bindingDigest,
    bootstrapBindingDigest: binding.bootstrap.bindingDigest,
    organization: binding.organization,
    organizationId: binding.organizationId,
    repository: binding.repository,
    repositoryId: binding.repositoryId,
    environment: binding.environment,
    egressMode: binding.egressMode,
    networkSettingsName: binding.networkSettingsName,
    networkSettingsResourceId: binding.networkSettingsResourceId,
    subnetResourceId: binding.subnetResourceId,
    natGatewayResourceId: binding.natGatewayResourceId,
    dnsLinkResourceId: binding.dnsLinkResourceId,
    dnsZoneGroupResourceId: binding.dnsZoneGroupResourceId,
    budget: binding.budget,
    adoptsExistingResources: false
  };
}

export function runnerGitHubPlanInputs(
  input: PhasePlanningInput | PhaseAdapterExecutionInput
): Record<string, unknown> & { organization: string } {
  const binding = runnerBinding(input);
  return {
    runnerBindingDigest: binding.bindingDigest,
    organization: binding.organization,
    organizationId: binding.organizationId,
    repository: binding.repository,
    repositoryId: binding.repositoryId,
    environment: binding.environment,
    label: binding.label,
    image: { id: binding.imageId, source: binding.imageSource },
    size: binding.machineSize,
    maximumRunners: binding.maximumRunners,
    enableStaticIp: false,
    networkSettingsResourceId: binding.networkSettingsResourceId,
    networkConfigurationName: binding.networkConfigurationName,
    runnerGroupName: binding.runnerGroupName,
    selectedWorkflows: binding.selectedWorkflows,
    budget: binding.budget,
    repositoryDedicated: true,
    allowsPublicRepositories: false
  };
}

function operationFor(
  input: PhaseAdapterExecutionInput,
  actionId: 'azure.runner-network.ensure' | 'github.runner.ensure-ready',
  inputs: Record<string, unknown>
): TransitionOperation {
  const operation = input.plan.operations.find((candidate) => candidate.actionId === actionId);
  if (!operation || canonicalSha256(operation.inputs) !== canonicalSha256(inputs)) {
    return runnerError(
      'runner-plan-stale',
      `The approved ${actionId} operation no longer matches the reviewed runner, network, repository, and cost scope.`
    );
  }
  return operation;
}

function sameId(left: unknown, right: string): boolean {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    return runnerError('runner-readback', `${label} did not return a JSON array.`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((entry) => githubText(entry, label));
}

function nestedId(value: unknown, label: string): string {
  return azureText(azureObject(value, label).id, `${label} id`);
}

function verifySubnet(
  value: unknown,
  binding: RunnerBinding
): Record<string, unknown> {
  const subnet = azureObject(value, 'Azure runner subnet');
  if (!sameId(subnet.id, binding.subnetResourceId)) {
    throw new AzureDiscoveryError(
      'runner-network-binding',
      'Azure runner subnet readback differs from the exact verified bootstrap resource.'
    );
  }
  const properties = azureObject(subnet.properties, 'Azure runner subnet properties');
  if (!sameId(nestedId(properties.natGateway, 'Azure runner subnet NAT gateway'), binding.natGatewayResourceId)) {
    throw new AzureDiscoveryError(
      'runner-network-routing',
      'Azure runner subnet is not routed through the exact approved NAT gateway.'
    );
  }
  const delegations = array(properties.delegations, 'Azure runner subnet delegations');
  const exact = delegations.filter((entry) => {
    const delegation = azureObject(entry, 'Azure runner subnet delegation');
    const detail = azureObject(delegation.properties, 'Azure runner subnet delegation properties');
    return detail.serviceName === 'GitHub.Network/networkSettings';
  });
  if (exact.length !== 1) {
    throw new AzureDiscoveryError(
      'runner-network-delegation',
      'Azure runner subnet does not have exactly one GitHub.Network/networkSettings delegation.'
    );
  }
  return subnet;
}

function verifyNatGateway(
  value: unknown,
  binding: RunnerBinding
): Record<string, unknown> {
  const natGateway = azureObject(value, 'Azure runner NAT gateway');
  if (!sameId(natGateway.id, binding.natGatewayResourceId)) {
    throw new AzureDiscoveryError(
      'runner-network-routing',
      'Azure NAT gateway readback differs from the exact verified bootstrap resource.'
    );
  }
  const properties = azureObject(natGateway.properties, 'Azure runner NAT gateway properties');
  if (properties.provisioningState !== 'Succeeded' ||
    array(properties.publicIpAddresses, 'Azure runner NAT gateway public IP addresses').length !== 1) {
    throw new AzureDiscoveryError(
      'runner-network-routing',
      'Azure NAT gateway is not terminal ready with exactly one approved outbound public IP.'
    );
  }
  return natGateway;
}

function verifyDnsLink(
  value: unknown,
  binding: RunnerBinding
): Record<string, unknown> {
  const link = azureObject(value, 'Azure private DNS VNet link');
  if (!sameId(link.id, binding.dnsLinkResourceId)) {
    throw new AzureDiscoveryError(
      'runner-dns-binding',
      'Azure private DNS link readback differs from the exact verified bootstrap resource.'
    );
  }
  const properties = azureObject(link.properties, 'Azure private DNS VNet link properties');
  const expectedVnet = binding.subnetResourceId.split('/subnets/')[0]!;
  if (!sameId(nestedId(properties.virtualNetwork, 'Azure private DNS linked VNet'), expectedVnet) ||
    properties.registrationEnabled !== false) {
    throw new AzureDiscoveryError(
      'runner-dns-binding',
      'Azure private DNS link is not bound to the exact runner VNet with registration disabled.'
    );
  }
  return link;
}

function verifyDnsZoneGroup(
  value: unknown,
  binding: RunnerBinding
): Record<string, unknown> {
  const group = azureObject(value, 'Azure private endpoint DNS zone group');
  if (!sameId(group.id, binding.dnsZoneGroupResourceId)) {
    throw new AzureDiscoveryError(
      'runner-dns-binding',
      'Azure private endpoint DNS zone-group readback differs from the verified bootstrap resource.'
    );
  }
  const properties = azureObject(group.properties, 'Azure private endpoint DNS zone-group properties');
  const configurations = array(properties.privateDnsZoneConfigs, 'Azure private endpoint DNS configurations');
  const expectedZoneId = binding.dnsLinkResourceId.split('/virtualNetworkLinks/')[0]!;
  if (configurations.length !== 1 ||
    !sameId(
      azureObject(
        azureObject(configurations[0], 'Azure private endpoint DNS configuration').properties,
        'Azure private endpoint DNS configuration properties'
      ).privateDnsZoneId,
      expectedZoneId
    )) {
    throw new AzureDiscoveryError(
      'runner-dns-binding',
      'Azure private endpoint must have exactly one binding to the reviewed private Blob DNS zone.'
    );
  }
  return group;
}

function networkSettingsObservation(
  value: unknown,
  binding: RunnerBinding
): { resource: Record<string, unknown>; networkSettingsId: string } {
  const resource = azureObject(value, 'Azure GitHub network settings resource');
  if (!sameId(resource.id, binding.networkSettingsResourceId) ||
    azureText(resource.name, 'Azure GitHub network settings name') !== binding.networkSettingsName) {
    throw new AzureDiscoveryError(
      'runner-network-binding',
      'Azure returned a GitHub network settings resource outside the exact reviewed scope.'
    );
  }
  const properties = azureObject(resource.properties, 'Azure GitHub network settings properties');
  if (!sameId(properties.subnetId, binding.subnetResourceId) ||
    String(properties.businessId) !== String(binding.organizationId)) {
    throw new AzureDiscoveryError(
      'runner-network-binding',
      'Azure GitHub network settings do not match the exact subnet and organization bindings.'
    );
  }
  if (properties.provisioningState !== undefined &&
    !['Succeeded', 'Completed'].includes(String(properties.provisioningState))) {
    throw new AzureDiscoveryError(
      'runner-network-state',
      'Azure GitHub network settings are not in a terminal successful state.'
    );
  }
  const tags = azureObject(resource.tags, 'Azure GitHub network settings tags');
  if (tags['liftoff-managed-by'] !== 'liftoff' ||
    tags['liftoff-phase'] !== 'runner-ready' ||
    tags['liftoff-binding'] !== binding.bindingDigest) {
    throw new AzureDiscoveryError(
      'runner-network-ownership',
      'Azure GitHub network settings do not carry the exact current Liftoff runner ownership binding.'
    );
  }
  const networkSettingsId = azureText(tags.GitHubId, 'Azure GitHub network settings GitHubId');
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(networkSettingsId)) {
    throw new AzureDiscoveryError(
      'runner-network-binding',
      'Azure GitHub network settings returned an unsupported GitHubId.'
    );
  }
  return { resource, networkSettingsId };
}

async function ensureAzureRunnerNetwork(
  input: PhaseAdapterExecutionInput,
  binding: RunnerBinding
): Promise<AzureRunnerNetworkObservation> {
  const operation = operationFor(input, 'azure.runner-network.ensure', runnerNetworkPlanInputs(input));
  const identity = await observeBackendIdentity(input, binding.bootstrap.backend);
  const permissions = await observeAzureEffectivePermissions(input, {
    subscriptionId: identity.identity.subscription.id,
    resourceManager: identity.identity.cloud.resourceManager,
    resourceManagerAudience: identity.identity.cloud.resourceManagerAudience
  }, 'Azure runner-network permission discovery');
  const missing = requiredAzureActions.filter((action) => !azurePermits(permissions, action));
  if (missing.length) {
    throw new AzureDiscoveryError(
      'runner-network-permission',
      `The current Azure identity lacks ${missing.length} exact runner-network permission${missing.length === 1 ? '' : 's'}; no network settings write was dispatched.`
    );
  }
  const subnet = verifySubnet(await runAzureJson(input, [
    'resource', 'show',
    '--subscription', binding.bootstrap.backend.subscriptionId,
    '--ids', binding.subnetResourceId,
    '--query', '{id:id,name:name,type:type,properties:properties}'
  ], 'Azure runner subnet readback'), binding);
  const natGateway = verifyNatGateway(await runAzureJson(input, [
    'resource', 'show',
    '--subscription', binding.bootstrap.backend.subscriptionId,
    '--ids', binding.natGatewayResourceId,
    '--query', '{id:id,name:name,type:type,properties:properties}'
  ], 'Azure runner NAT-gateway readback'), binding);
  const dnsLink = verifyDnsLink(await runAzureJson(input, [
    'resource', 'show',
    '--subscription', binding.bootstrap.backend.subscriptionId,
    '--ids', binding.dnsLinkResourceId,
    '--query', '{id:id,name:name,type:type,properties:properties}'
  ], 'Azure private DNS VNet-link readback'), binding);
  const dnsZoneGroup = verifyDnsZoneGroup(await runAzureJson(input, [
    'resource', 'show',
    '--subscription', binding.bootstrap.backend.subscriptionId,
    '--ids', binding.dnsZoneGroupResourceId,
    '--query', '{id:id,name:name,type:type,properties:properties}'
  ], 'Azure private endpoint DNS zone-group readback'), binding);
  const existing = await runAzureJson(input, [
    'resource', 'list',
    '--subscription', binding.bootstrap.backend.subscriptionId,
    '--resource-group', binding.bootstrap.resourceGroup,
    '--resource-type', 'GitHub.Network/networkSettings',
    '--query', `[?name=='${binding.networkSettingsName}'].{id:id,name:name,type:type,location:location,properties:properties,tags:tags}`
  ], 'Azure GitHub network settings name discovery');
  if (!Array.isArray(existing) || existing.length > 1) {
    throw new AzureDiscoveryError(
      'runner-network-occupied',
      'Azure GitHub network settings name discovery returned an invalid or ambiguous result.'
    );
  }
  const previous = input.inspection.state.phases['runner-ready'].operation;
  let observed: { resource: Record<string, unknown>; networkSettingsId: string };
  if (existing.length === 1) {
    if (!previous) {
      throw new AzureDiscoveryError(
        'runner-network-occupied',
        'The deterministic Azure GitHub network settings name is occupied without a current owned runner operation.'
      );
    }
    observed = networkSettingsObservation(existing[0], binding);
  } else {
    if (previous) {
      throw new AzureDiscoveryError(
        'runner-network-missing',
        'The recorded runner operation lost its exact Azure GitHub network settings resource.'
      );
    }
    const url = new URL(
      `${binding.networkSettingsResourceId.slice(1)}?api-version=${networkSettingsApiVersion}`,
      identity.identity.cloud.resourceManager
    ).toString();
    const created = await runAzureJson(input, [
      'rest', '--method', 'PUT',
      '--url', url,
      '--resource', identity.identity.cloud.resourceManagerAudience,
      '--body', JSON.stringify({
        location: binding.bootstrap.region,
        properties: {
          subnetId: binding.subnetResourceId,
          businessId: String(binding.organizationId)
        },
        tags: {
          'liftoff-managed-by': 'liftoff',
          'liftoff-phase': 'runner-ready',
          'liftoff-binding': binding.bindingDigest
        }
      })
    ], 'Azure GitHub network settings creation', 10 * 60 * 1_000);
    observed = networkSettingsObservation(created, binding);
  }
  const liveReadback = [
    readbackProof(input, 'azure', 'Microsoft.Network/virtualNetworks/subnets', binding.subnetResourceId, subnet),
    readbackProof(input, 'azure', 'Microsoft.Network/natGateways', binding.natGatewayResourceId, natGateway),
    readbackProof(input, 'azure', 'Microsoft.Network/privateDnsZones/virtualNetworkLinks', binding.dnsLinkResourceId, dnsLink),
    readbackProof(input, 'azure', 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups', binding.dnsZoneGroupResourceId, dnsZoneGroup),
    readbackProof(input, 'azure', 'GitHub.Network/networkSettings', binding.networkSettingsResourceId, observed.resource)
  ];
  return {
    networkSettingsId: observed.networkSettingsId,
    networkSettings: observed.resource,
    subnet,
    natGateway,
    dnsLink,
    dnsZoneGroup,
    permissions: {
      requiredActions: [...requiredAzureActions],
      permissionEntryCount: permissions.length
    },
    liveReadback
  };
}

function matchingName(
  values: readonly Record<string, unknown>[],
  name: string,
  label: string
): void {
  if (values.some((value) => value.name === name)) {
    return runnerError(
      'runner-name-occupied',
      `The deterministic ${label} name is already occupied without a current owned runner operation.`
    );
  }
}

async function observeGitHubRunnerPreflight(
  input: PhaseAdapterExecutionInput,
  binding: RunnerBinding
): Promise<GitHubRunnerPreflight> {
  const client = clientFor(input);
  const organization = await client.get(`/orgs/${binding.organization}`);
  if (positiveId(organization.id, 'GitHub organization ID') !== binding.organizationId ||
    githubText(organization.login, 'GitHub organization login').toLowerCase() !==
      binding.organization.toLowerCase()) {
    return runnerError(
      'runner-organization-binding',
      'GitHub organization readback differs from the exact reviewed owner and database ID.'
    );
  }
  const repository = await client.get(`/repos/${binding.repository}`);
  if (positiveId(repository.id, 'GitHub repository ID') !== binding.repositoryId ||
    githubText(repository.full_name, 'GitHub repository full name').toLowerCase() !==
      binding.repository.toLowerCase() ||
    repository.private !== true) {
    return runnerError(
      'runner-repository-binding',
      'Runner readiness requires the exact verified private repository identity.'
    );
  }
  const images = await client.list(
    `/orgs/${binding.organization}/actions/hosted-runners/images/github-owned`,
    'images'
  );
  const image = images.find((candidate) =>
    candidate.id === binding.imageId && candidate.source === binding.imageSource);
  if (!image) {
    return runnerError(
      'runner-image-unavailable',
      'The approved GitHub-owned ubuntu-latest larger-runner image is unavailable to this organization.'
    );
  }
  const sizes = await client.list(
    `/orgs/${binding.organization}/actions/hosted-runners/machine-sizes`,
    'machine_specs'
  );
  const machineSize = sizes.find((candidate) =>
    candidate.id === binding.machineSize &&
    Number(candidate.cpu_cores) >= 4 &&
    Number(candidate.memory_gb) >= 16);
  if (!machineSize) {
    return runnerError(
      'runner-size-unavailable',
      'The approved 4-core larger-runner size is unavailable to this organization.'
    );
  }
  for (const workflow of runnerPreflightWorkflowAllowlist) {
    const response = await client.get(
      `/repos/${binding.repository}/contents/${workflow.path}?ref=${repositoryConfiguration(input.inspection).defaultBranch}`
    );
    if (response.type !== 'file' || response.path !== workflow.path) {
      return runnerError(
        'runner-workflow-unavailable',
        'An exact runner-restricted preflight workflow is absent from the verified default branch.'
      );
    }
  }
  if (!input.inspection.state.phases['runner-ready'].operation) {
    const [runners, groups, networks] = await Promise.all([
      client.list(`/orgs/${binding.organization}/actions/hosted-runners`, 'runners'),
      client.list(`/orgs/${binding.organization}/actions/runner-groups`, 'runner_groups'),
      client.list(`/orgs/${binding.organization}/settings/network-configurations`, 'network_configurations')
    ]);
    matchingName(runners, binding.label, 'larger-runner label');
    matchingName(groups, binding.runnerGroupName, 'runner-group');
    matchingName(networks, binding.networkConfigurationName, 'network-configuration');
  }
  return { organization, repository, image, machineSize };
}

function networkConfigurationObservation(
  value: unknown,
  binding: RunnerBinding,
  networkSettingsId: string
): { resource: Record<string, unknown>; id: string } {
  const resource = githubObject(value, 'GitHub network configuration');
  const id = githubText(resource.id, 'GitHub network configuration ID');
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id) ||
    githubText(resource.name, 'GitHub network configuration name') !==
      binding.networkConfigurationName ||
    resource.compute_service !== 'actions' ||
    canonicalSha256(stringArray(resource.network_settings_ids, 'GitHub network settings IDs')) !==
      canonicalSha256([networkSettingsId]) ||
    resource.failover_network_enabled === true) {
    return runnerError(
      'runner-network-configuration',
      'GitHub network configuration readback differs from the exact reviewed Actions network binding.'
    );
  }
  return { resource, id };
}

function runnerGroupObservation(
  value: unknown,
  binding: RunnerBinding,
  networkConfigurationId: string
): { resource: Record<string, unknown>; id: number } {
  const resource = githubObject(value, 'GitHub runner group');
  const id = positiveId(resource.id, 'GitHub runner group ID');
  const workflows = stringArray(resource.selected_workflows, 'GitHub runner-group workflows');
  if (githubText(resource.name, 'GitHub runner-group name') !== binding.runnerGroupName ||
    resource.visibility !== 'selected' ||
    resource.allows_public_repositories !== false ||
    resource.restricted_to_workflows !== true ||
    resource.inherited === true ||
    resource.network_configuration_id !== networkConfigurationId ||
    canonicalSha256([...workflows].sort()) !==
      canonicalSha256([...binding.selectedWorkflows].sort())) {
    return runnerError(
      'runner-group-binding',
      'GitHub runner-group readback differs from the exact repository, workflow, and network restrictions.'
    );
  }
  return { resource, id };
}

function hostedRunnerObservation(
  value: unknown,
  binding: RunnerBinding,
  groupId: number
): { resource: Record<string, unknown>; id: number; status: string } {
  const resource = githubObject(value, 'GitHub hosted runner');
  const id = positiveId(resource.id, 'GitHub hosted runner ID');
  const status = githubText(resource.status, 'GitHub hosted runner status');
  if (!supportedRunnerStatus.has(status)) {
    return runnerError('runner-status', 'GitHub returned an unsupported larger-runner status.');
  }
  const image = githubObject(resource.image_details, 'GitHub hosted runner image');
  const size = githubObject(resource.machine_size_details, 'GitHub hosted runner machine size');
  if (githubText(resource.name, 'GitHub hosted runner name') !== binding.label ||
    positiveId(resource.runner_group_id, 'GitHub hosted runner group ID') !== groupId ||
    image.id !== binding.imageId ||
    image.source !== binding.imageSource ||
    size.id !== binding.machineSize ||
    Number(size.cpu_cores) < 4 ||
    Number(size.memory_gb) < 16 ||
    resource.maximum_runners !== binding.maximumRunners ||
    resource.public_ip_enabled !== false) {
    return runnerError(
      'runner-binding',
      'GitHub larger-runner readback differs from the exact label, image, capacity, group, or public-IP restrictions.'
    );
  }
  return { resource, id, status };
}

function githubNetworkSettingsObservation(
  value: unknown,
  binding: RunnerBinding,
  networkSettingsId: string,
  networkConfigurationId: string
): Record<string, unknown> {
  const resource = githubObject(value, 'GitHub network settings metadata');
  if (githubText(resource.id, 'GitHub network settings ID') !== networkSettingsId ||
    !sameId(resource.subnet_id, binding.subnetResourceId) ||
    resource.network_configuration_id !== networkConfigurationId) {
    return runnerError(
      'runner-network-binding',
      'GitHub network settings metadata differs from the exact Azure subnet and network configuration.'
    );
  }
  return resource;
}

function resumeIds(
  input: PhaseAdapterExecutionInput,
  binding: RunnerBinding
): { networkConfigurationId: string; groupId: number; runnerId: number; networkSettingsId: string } {
  const output = input.inspection.state.phaseOutputs?.['runner-ready'];
  const values = output?.values;
  if (!output || !values || values.runnerBindingDigest !== binding.bindingDigest) {
    return runnerError(
      'runner-resume-binding',
      'The recorded runner operation has no exact provider output bindings.'
    );
  }
  const ids = {
    networkConfigurationId: githubText(values.networkConfigurationId, 'Recorded network configuration ID'),
    groupId: exactPositiveInteger(values.groupId, 'Recorded runner group ID'),
    runnerId: exactPositiveInteger(values.runnerId, 'Recorded hosted runner ID'),
    networkSettingsId: githubText(values.networkSettingsId, 'Recorded network settings ID')
  };
  const expectedResources = [
    ['azure', 'GitHub.Network/networkSettings', binding.networkSettingsResourceId],
    ['github', 'network-configuration', `/orgs/${binding.organization}/settings/network-configurations/${ids.networkConfigurationId}`],
    ['github', 'runner-group', `/orgs/${binding.organization}/actions/runner-groups/${ids.groupId}`],
    ['github', 'hosted-runner', `/orgs/${binding.organization}/actions/hosted-runners/${ids.runnerId}`]
  ] as const;
  if (!expectedResources.every(([provider, resourceType, resourceId]) =>
    output.resources.some((resource) =>
      resource.provider === provider &&
      resource.resourceType === resourceType &&
      resource.resourceId === resourceId))) {
    return runnerError(
      'runner-resume-binding',
      'The recorded runner outputs do not bind every exact Azure and GitHub provider resource.'
    );
  }
  const operation = input.inspection.state.phases['runner-ready'].operation;
  const expectedRunnerPath = `/orgs/${binding.organization}/actions/hosted-runners/${ids.runnerId}`;
  if (!operation || operation.provider !== 'github' ||
    operation.actionId !== 'github.runner.ensure-ready' ||
    operation.resourceId !== expectedRunnerPath ||
    operation.pollUrl !== `https://api.github.com${expectedRunnerPath}`) {
    return runnerError(
      'runner-resume-binding',
      'The recorded runner operation contradicts the exact hosted-runner output binding.'
    );
  }
  return ids;
}

async function repositoryAssignment(
  input: PhaseAdapterExecutionInput,
  binding: RunnerBinding,
  groupId: number
): Promise<boolean> {
  const groups = await clientFor(input).list(
    `/orgs/${binding.organization}/actions/runner-groups?visible_to_repository=${binding.repository.split('/')[1]}`,
    'runner_groups'
  );
  return groups.some((group) => positiveId(group.id, 'Visible runner-group ID') === groupId);
}

async function observeGitHubResources(
  input: PhaseAdapterExecutionInput,
  binding: RunnerBinding,
  ids: ReturnType<typeof resumeIds>
): Promise<GitHubRunnerObservation> {
  const client = clientFor(input);
  const networkConfiguration = networkConfigurationObservation(
    await client.get(
      `/orgs/${binding.organization}/settings/network-configurations/${ids.networkConfigurationId}`
    ),
    binding,
    ids.networkSettingsId
  );
  const networkSettings = githubNetworkSettingsObservation(
    await client.get(`/orgs/${binding.organization}/settings/network-settings/${ids.networkSettingsId}`),
    binding,
    ids.networkSettingsId,
    ids.networkConfigurationId
  );
  const group = runnerGroupObservation(
    await client.get(`/orgs/${binding.organization}/actions/runner-groups/${ids.groupId}`),
    binding,
    ids.networkConfigurationId
  );
  const runner = hostedRunnerObservation(
    await client.get(`/orgs/${binding.organization}/actions/hosted-runners/${ids.runnerId}`),
    binding,
    ids.groupId
  );
  if (networkConfiguration.id !== ids.networkConfigurationId ||
    group.id !== ids.groupId ||
    runner.id !== ids.runnerId) {
    return runnerError(
      'runner-resume-binding',
      'GitHub runner readback contradicts the exact recorded provider output bindings.'
    );
  }
  const repositoryAssigned = await repositoryAssignment(input, binding, ids.groupId);
  if (!repositoryAssigned) {
    return runnerError(
      'runner-repository-assignment',
      'The exact runner group is not authoritatively visible to the reviewed repository.'
    );
  }
  return {
    networkConfiguration: networkConfiguration.resource,
    networkSettings,
    group: group.resource,
    runner: runner.resource,
    networkConfigurationId: networkConfiguration.id,
    groupId: group.id,
    runnerId: runner.id,
    status: runner.status,
    repositoryAssigned,
    liveReadback: [
      readbackProof(
        input,
        'github',
        'network-configuration',
        `/orgs/${binding.organization}/settings/network-configurations/${networkConfiguration.id}`,
        networkConfiguration.resource
      ),
      readbackProof(
        input,
        'github',
        'network-settings',
        `/orgs/${binding.organization}/settings/network-settings/${ids.networkSettingsId}`,
        networkSettings
      ),
      readbackProof(
        input,
        'github',
        'runner-group',
        `/orgs/${binding.organization}/actions/runner-groups/${group.id}`,
        group.resource
      ),
      readbackProof(
        input,
        'github',
        'hosted-runner',
        `/orgs/${binding.organization}/actions/hosted-runners/${runner.id}`,
        runner.resource
      )
    ]
  };
}

async function ensureGitHubRunner(
  input: PhaseAdapterExecutionInput,
  binding: RunnerBinding,
  networkSettingsId: string
): Promise<GitHubRunnerObservation> {
  const operation = operationFor(input, 'github.runner.ensure-ready', runnerGitHubPlanInputs(input));
  const previous = input.inspection.state.phases['runner-ready'].operation;
  if (previous) return observeGitHubResources(input, binding, resumeIds(input, binding));
  const client = clientFor(input);
  await assertGitHubAuthorized(input, operation);
  let networkResponse: unknown;
  try {
    networkResponse = await client.write('POST', `/orgs/${binding.organization}/settings/network-configurations`, {
      name: binding.networkConfigurationName,
      compute_service: 'actions',
      network_settings_ids: [networkSettingsId],
      failover_network_enabled: false
    });
  } catch (error) {
    dispatchedGitHubWrite(error);
  }
  let network: ReturnType<typeof networkConfigurationObservation>;
  try {
    network = networkConfigurationObservation(networkResponse, binding, networkSettingsId);
  } catch (error) {
    dispatchedGitHubWrite(error);
  }
  await assertGitHubAuthorized(input, operation);
  let groupResponse: unknown;
  try {
    groupResponse = await client.write('POST', `/orgs/${binding.organization}/actions/runner-groups`, {
      name: binding.runnerGroupName,
      visibility: 'selected',
      selected_repository_ids: [binding.repositoryId],
      runners: [],
      allows_public_repositories: false,
      restricted_to_workflows: true,
      selected_workflows: binding.selectedWorkflows,
      network_configuration_id: network.id
    });
  } catch (error) {
    dispatchedGitHubWrite(error);
  }
  let group: ReturnType<typeof runnerGroupObservation>;
  try {
    group = runnerGroupObservation(groupResponse, binding, network.id);
  } catch (error) {
    dispatchedGitHubWrite(error);
  }
  await assertGitHubAuthorized(input, operation);
  let runnerResponse: unknown;
  try {
    runnerResponse = await client.write('POST', `/orgs/${binding.organization}/actions/hosted-runners`, {
      name: binding.label,
      image: { id: binding.imageId, source: binding.imageSource },
      size: binding.machineSize,
      runner_group_id: group.id,
      maximum_runners: binding.maximumRunners,
      enable_static_ip: false
    });
  } catch (error) {
    dispatchedGitHubWrite(error);
  }
  let runner: ReturnType<typeof hostedRunnerObservation>;
  try {
    runner = hostedRunnerObservation(runnerResponse, binding, group.id);
  } catch (error) {
    dispatchedGitHubWrite(error);
  }
  return observeGitHubResources(input, binding, {
    networkConfigurationId: network.id,
    groupId: group.id,
    runnerId: runner.id,
    networkSettingsId
  });
}

function outputs(
  binding: RunnerBinding,
  azure: AzureRunnerNetworkObservation,
  github: GitHubRunnerObservation
): PhaseOutputBindings {
  return {
    values: {
      runnerBindingDigest: binding.bindingDigest,
      organization: binding.organization,
      organizationId: binding.organizationId,
      repository: binding.repository,
      repositoryId: binding.repositoryId,
      environment: binding.environment,
      egressMode: binding.egressMode,
      label: binding.label,
      networkSettingsId: azure.networkSettingsId,
      networkConfigurationId: github.networkConfigurationId,
      groupId: github.groupId,
      runnerId: github.runnerId,
      fixedMonthlyCents: binding.budget.fixedMonthlyCents,
      usageMonthlyCents: binding.budget.usageMonthlyCents
    },
    resources: [
      {
        provider: 'azure',
        resourceType: 'GitHub.Network/networkSettings',
        resourceId: binding.networkSettingsResourceId
      },
      {
        provider: 'github',
        resourceType: 'network-configuration',
        resourceId: `/orgs/${binding.organization}/settings/network-configurations/${github.networkConfigurationId}`
      },
      {
        provider: 'github',
        resourceType: 'runner-group',
        resourceId: `/orgs/${binding.organization}/actions/runner-groups/${github.groupId}`
      },
      {
        provider: 'github',
        resourceType: 'hosted-runner',
        resourceId: `/orgs/${binding.organization}/actions/hosted-runners/${github.runnerId}`
      }
    ]
  };
}

function observedAt(input: PhaseAdapterExecutionInput): string {
  return (input.clock?.() ?? input.now).toISOString();
}

export async function executeRunnerReadiness(
  input: PhaseAdapterExecutionInput
): Promise<PhaseAdapterOutcome> {
  const completedOperations: TransitionOperation[] = [];
  let githubOperation: TransitionOperation | null = null;
  try {
    const binding = runnerBinding(input);
    const azureOperation = operationFor(
      input,
      'azure.runner-network.ensure',
      runnerNetworkPlanInputs(input)
    );
    githubOperation = operationFor(
      input,
      'github.runner.ensure-ready',
      runnerGitHubPlanInputs(input)
    );
    const preflight = await observeGitHubRunnerPreflight(input, binding);
    const azure = await ensureAzureRunnerNetwork(input, binding);
    completedOperations.push(azureOperation);
    const github = await ensureGitHubRunner(input, binding, azure.networkSettingsId);
    const phaseOutputs = outputs(binding, azure, github);
    const time = observedAt(input);
    const liveReadback = [...azure.liveReadback, ...github.liveReadback];
    const handle = {
      provider: 'github' as const,
      actionId: githubOperation.actionId,
      operationId: `github-hosted-runner:${github.runnerId}`,
      resourceId: `/orgs/${binding.organization}/actions/hosted-runners/${github.runnerId}`,
      startedAt: input.inspection.state.phases['runner-ready'].operation?.startedAt ?? time,
      observedAt: time,
      pollUrl: `https://api.github.com/orgs/${binding.organization}/actions/hosted-runners/${github.runnerId}`
    };
    if (github.status === 'Provisioning') {
      return {
        status: 'pending',
        blocker: 'GitHub larger-runner provisioning is still in progress; resume reobserves the same runner without redispatch.',
        operation: { ...handle, status: 'running' },
        liveReadback,
        outputs: phaseOutputs,
        completedOperations
      };
    }
    if (github.status !== 'Ready') {
      return {
        status: 'blocked',
        resultState: 'failed',
        blocker: 'GitHub larger-runner provisioning reached a terminal non-ready state; provider diagnostics were withheld.',
        operation: { ...handle, status: 'failed' },
        liveReadback,
        outputs: phaseOutputs,
        completedOperations
      };
    }
    completedOperations.push(githubOperation);
    return {
      status: 'completed',
      resultState: 'verified',
      operation: { ...handle, status: 'completed' },
      evidencePayload: {
        kind: 'runner-ready.v1',
        runnerBindingDigest: binding.bindingDigest,
        organization: binding.organization,
        organizationId: binding.organizationId,
        repository: binding.repository,
        repositoryId: binding.repositoryId,
        environment: binding.environment,
        egressMode: binding.egressMode,
        label: binding.label,
        runnerId: github.runnerId,
        groupId: github.groupId,
        networkConfigurationId: github.networkConfigurationId,
        networkSettingsId: azure.networkSettingsId,
        repositoryAssigned: github.repositoryAssigned,
        selectedWorkflows: binding.selectedWorkflows,
        image: {
          id: binding.imageId,
          source: binding.imageSource,
          observedDigest: canonicalSha256(preflight.image)
        },
        machineSize: {
          id: binding.machineSize,
          observedDigest: canonicalSha256(preflight.machineSize)
        },
        budget: binding.budget,
        azure: {
          resourceId: binding.networkSettingsResourceId,
          subnetResourceId: binding.subnetResourceId,
          natGatewayResourceId: binding.natGatewayResourceId,
          dnsLinkResourceId: binding.dnsLinkResourceId,
          dnsZoneGroupResourceId: binding.dnsZoneGroupResourceId,
          permissions: azure.permissions
        },
        github: {
          organizationDigest: canonicalSha256(preflight.organization),
          repositoryDigest: canonicalSha256(preflight.repository),
          networkConfigurationDigest: canonicalSha256(github.networkConfiguration),
          networkSettingsDigest: canonicalSha256(github.networkSettings),
          runnerGroupDigest: canonicalSha256(github.group),
          runnerDigest: canonicalSha256(github.runner)
        },
        adoptsExistingResources: false
      },
      liveReadback,
      outputs: phaseOutputs,
      completedOperations
    };
  } catch (error) {
    if (!(error instanceof GitHubActivationError) &&
      !(error instanceof AzureDiscoveryError)) {
      throw error;
    }
    if (error instanceof RunnerWriteDispatchedError && githubOperation &&
      !completedOperations.includes(githubOperation)) {
      completedOperations.push(githubOperation);
    }
    return {
      status: 'blocked',
      resultState: 'failed',
      blocker: error instanceof GitHubActivationError
        ? safeGitHubFailure(error)
        : error.message,
      completedOperations
    };
  }
}
