import { isIP } from 'node:net';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import type {
  ApprovalCostCeiling, TransitionOperation
} from '../domain/governance/activation/types.js';
import { projectIdentityDigest, boundedToken } from '../generators/infrastructure/names.js';
import type {
  PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanningInput
} from './transition-ports.js';
import {
  AzureDiscoveryError, azureObject, azureText, expectedAzureEnvironmentBindings,
  runAzureJson
} from './azure-discovery.js';
import {
  azureBackendConfiguration, observeBackendIdentity, observeStorageAccount,
  privateBlobDnsZoneForAzureCloud, type BackendPlanBinding
} from './azure-backend-readiness.js';
import {
  azurePermits, observeAzureEffectivePermissions
} from './azure-permissions.js';
import { readbackProof } from './transition-records.js';

const deploymentApiVersion = '2022-09-01';
const requiredActions = [
  'Microsoft.Resources/deployments/read',
  'Microsoft.Resources/deployments/write',
  'Microsoft.Resources/deployments/validate/action',
  'Microsoft.Resources/subscriptions/resourceGroups/read',
  'Microsoft.Resources/subscriptions/resourceGroups/write',
  'Microsoft.Network/virtualNetworks/read',
  'Microsoft.Network/virtualNetworks/write',
  'Microsoft.Network/virtualNetworks/subnets/read',
  'Microsoft.Network/virtualNetworks/subnets/write',
  'Microsoft.Network/publicIPAddresses/read',
  'Microsoft.Network/publicIPAddresses/write',
  'Microsoft.Network/natGateways/read',
  'Microsoft.Network/natGateways/write',
  'Microsoft.Network/privateEndpoints/read',
  'Microsoft.Network/privateEndpoints/write',
  'Microsoft.Network/privateEndpoints/privateDnsZoneGroups/read',
  'Microsoft.Network/privateEndpoints/privateDnsZoneGroups/write',
  'Microsoft.Network/privateDnsZones/read',
  'Microsoft.Network/privateDnsZones/write',
  'Microsoft.Network/privateDnsZones/virtualNetworkLinks/read',
  'Microsoft.Network/privateDnsZones/virtualNetworkLinks/write',
  'Microsoft.Storage/storageAccounts/privateEndpointConnectionsApproval/action'
] as const;

interface Ipv4Cidr {
  text: string;
  first: number;
  last: number;
  prefix: number;
}

interface BootstrapBinding {
  backend: BackendPlanBinding;
  environment: string;
  region: string;
  egressMode: 'nat-gateway';
  virtualNetworkCidr: string;
  runnerSubnetCidr: string;
  privateEndpointSubnetCidr: string;
  privateDnsZone: string;
  resourceGroup: string;
  deploymentName: string;
  networkDeploymentName: string;
  virtualNetworkName: string;
  runnerSubnetName: string;
  privateEndpointSubnetName: string;
  publicIpName: string;
  natGatewayName: string;
  privateEndpointName: string;
  dnsLinkName: string;
  zoneGroupName: string;
  deploymentResourceId: string;
  networkDeploymentResourceId: string;
  resourceIds: readonly {
    resourceType: string;
    resourceId: string;
  }[];
  budget: ApprovalCostCeiling;
  bindingDigest: string;
}

function configurationSource(input: PhasePlanningInput | PhaseAdapterExecutionInput) {
  const configuration =
    input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  if (!configuration) {
    return bootstrapError(
      'bootstrap-configuration',
      'Bootstrap-local requires exact reviewed activation inputs.'
    );
  }
  return configuration;
}

function bootstrapError(code: string, message: string): never {
  throw new AzureDiscoveryError(code, message);
}

function exactObject(
  value: unknown,
  allowed: readonly string[],
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))) {
    return bootstrapError(
      'bootstrap-configuration',
      `${label} is absent or contains unsupported fields.`
    );
  }
  return value as Record<string, unknown>;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)) {
    return bootstrapError('bootstrap-configuration', `${label} is absent or invalid.`);
  }
  return value;
}

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function ipv4Cidr(value: unknown, label: string, minimumPrefix: number, maximumPrefix: number): Ipv4Cidr {
  const text = exactString(value, label);
  const [address, prefixText, ...rest] = text.split('/');
  const prefix = Number(prefixText);
  if (rest.length || isIP(address ?? '') !== 4 || !Number.isInteger(prefix) ||
    prefix < minimumPrefix || prefix > maximumPrefix) {
    return bootstrapError(
      'bootstrap-network',
      `${label} must be a qualified IPv4 CIDR with prefix ${minimumPrefix}-${maximumPrefix}.`
    );
  }
  const ip = ipv4Number(address!);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const first = (ip & mask) >>> 0;
  if (ip !== first) {
    return bootstrapError('bootstrap-network', `${label} must use its network address.`);
  }
  return {
    text,
    first,
    last: (first | (~mask >>> 0)) >>> 0,
    prefix
  };
}

function contains(parent: Ipv4Cidr, child: Ipv4Cidr): boolean {
  return child.first >= parent.first && child.last <= parent.last;
}

function overlaps(left: Ipv4Cidr, right: Ipv4Cidr): boolean {
  return left.first <= right.last && right.first <= left.last;
}

function budget(configuration: ReturnType<typeof configurationSource>): ApprovalCostCeiling {
  const value = configuration.budget;
  if (!value || value.fixedMonthlyCents <= 0 || value.usageMonthlyCents <= 0) {
    return bootstrapError(
      'bootstrap-cost',
      'Bootstrap-local requires an exact reviewed nonzero fixed and usage monthly cost ceiling.'
    );
  }
  return value;
}

function resourceId(resourceGroupId: string, type: string, name: string): string {
  return `${resourceGroupId}/providers/${type}/${name}`;
}

export function bootstrapBinding(
  input: PhasePlanningInput | PhaseAdapterExecutionInput
): BootstrapBinding {
  const configuration = configurationSource(input);
  const phase = exactObject(configuration.phases['bootstrap-local'], [
    'environment',
    'egressMode',
    'virtualNetworkCidr',
    'runnerSubnetCidr',
    'privateEndpointSubnetCidr',
    'privateDnsZone'
  ], 'Reviewed bootstrap-local configuration');
  const backend = azureBackendConfiguration(input, 'bootstrap-local');
  const environment = exactString(phase.environment, 'Bootstrap environment');
  const expected = expectedAzureEnvironmentBindings(input)
    .find((candidate) => candidate.environment === environment);
  if (!expected) {
    return bootstrapError(
      'bootstrap-environment',
      'Bootstrap environment must exactly match one declared project environment.'
    );
  }
  if (phase.egressMode !== 'nat-gateway') {
    return bootstrapError(
      'bootstrap-egress',
      'Task 13.2 qualifies exactly one explicit egress mode: nat-gateway.'
    );
  }
  const virtualNetwork = ipv4Cidr(phase.virtualNetworkCidr, 'Bootstrap virtual-network CIDR', 16, 24);
  const runnerSubnet = ipv4Cidr(phase.runnerSubnetCidr, 'Bootstrap runner-subnet CIDR', 24, 28);
  const privateEndpointSubnet = ipv4Cidr(
    phase.privateEndpointSubnetCidr,
    'Bootstrap private-endpoint-subnet CIDR',
    24,
    28
  );
  if (!contains(virtualNetwork, runnerSubnet) || !contains(virtualNetwork, privateEndpointSubnet) ||
    overlaps(runnerSubnet, privateEndpointSubnet)) {
    return bootstrapError(
      'bootstrap-network',
      'Bootstrap subnets must be distinct, non-overlapping ranges inside the reviewed virtual network.'
    );
  }
  const region = exactString(configuration.azure?.region, 'Bootstrap Azure region');
  const privateDnsZone = exactString(phase.privateDnsZone, 'Bootstrap private Blob DNS zone');
  if (![
    'privatelink.blob.core.windows.net',
    'privatelink.blob.core.usgovcloudapi.net',
    'privatelink.blob.core.chinacloudapi.cn'
  ].includes(privateDnsZone)) {
    return bootstrapError(
      'bootstrap-network',
      'Bootstrap private Blob DNS zone is not qualified for a supported Azure cloud.'
    );
  }
  const digest = projectIdentityDigest({
    projectName: input.inspection.manifest.project.name
  });
  const environmentToken = boundedToken(environment.toLowerCase().replace(/[^a-z0-9-]/gu, '-'), 12);
  const token = `${digest}-${environmentToken}`;
  const resourceGroup = expected.resources.resourceGroup;
  const resourceGroupId = `/subscriptions/${backend.subscriptionId}/resourceGroups/${resourceGroup}`;
  const deploymentName = `liftoff-${token}-backend-bootstrap`;
  const networkDeploymentName = `network-${token}`;
  const virtualNetworkName = `vnet-${token}-bootstrap`;
  const runnerSubnetName = `snet-${token}-runner`;
  const privateEndpointSubnetName = `snet-${token}-private-endpoint`;
  const publicIpName = `pip-${token}-egress`;
  const natGatewayName = `nat-${token}-egress`;
  const privateEndpointName = `pe-${token}-state`;
  const dnsLinkName = `link-${token}-state`;
  const zoneGroupName = 'blob';
  const deploymentResourceId =
    `/subscriptions/${backend.subscriptionId}/providers/Microsoft.Resources/deployments/${deploymentName}`;
  const networkDeploymentResourceId =
    resourceId(resourceGroupId, 'Microsoft.Resources/deployments', networkDeploymentName);
  const privateDnsZoneResourceId =
    resourceId(resourceGroupId, 'Microsoft.Network/privateDnsZones', privateDnsZone);
  const resourceIds = [
    { resourceType: 'Microsoft.Resources/resourceGroups', resourceId: resourceGroupId },
    {
      resourceType: 'Microsoft.Resources/deployments',
      resourceId: networkDeploymentResourceId
    },
    {
      resourceType: 'Microsoft.Network/virtualNetworks',
      resourceId: resourceId(resourceGroupId, 'Microsoft.Network/virtualNetworks', virtualNetworkName)
    },
    {
      resourceType: 'Microsoft.Network/virtualNetworks/subnets',
      resourceId: resourceId(
        resourceGroupId,
        'Microsoft.Network/virtualNetworks',
        `${virtualNetworkName}/subnets/${runnerSubnetName}`
      )
    },
    {
      resourceType: 'Microsoft.Network/virtualNetworks/subnets',
      resourceId: resourceId(
        resourceGroupId,
        'Microsoft.Network/virtualNetworks',
        `${virtualNetworkName}/subnets/${privateEndpointSubnetName}`
      )
    },
    {
      resourceType: 'Microsoft.Network/publicIPAddresses',
      resourceId: resourceId(resourceGroupId, 'Microsoft.Network/publicIPAddresses', publicIpName)
    },
    {
      resourceType: 'Microsoft.Network/natGateways',
      resourceId: resourceId(resourceGroupId, 'Microsoft.Network/natGateways', natGatewayName)
    },
    {
      resourceType: 'Microsoft.Network/privateEndpoints',
      resourceId: resourceId(resourceGroupId, 'Microsoft.Network/privateEndpoints', privateEndpointName)
    },
    {
      resourceType: 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups',
      resourceId: resourceId(
        resourceGroupId,
        'Microsoft.Network/privateEndpoints',
        `${privateEndpointName}/privateDnsZoneGroups/${zoneGroupName}`
      )
    },
    {
      resourceType: 'Microsoft.Network/privateDnsZones',
      resourceId: privateDnsZoneResourceId
    },
    {
      resourceType: 'Microsoft.Network/privateDnsZones/virtualNetworkLinks',
      resourceId: `${privateDnsZoneResourceId}/virtualNetworkLinks/${dnsLinkName}`
    }
  ] as const;
  const provisional = {
    backendBindingDigest: backend.bindingDigest,
    environment,
    region,
    egressMode: 'nat-gateway' as const,
    virtualNetworkCidr: virtualNetwork.text,
    runnerSubnetCidr: runnerSubnet.text,
    privateEndpointSubnetCidr: privateEndpointSubnet.text,
    privateDnsZone,
    resourceGroup,
    deploymentName,
    networkDeploymentName,
    virtualNetworkName,
    runnerSubnetName,
    privateEndpointSubnetName,
    publicIpName,
    natGatewayName,
    privateEndpointName,
    dnsLinkName,
    zoneGroupName,
    deploymentResourceId,
    networkDeploymentResourceId,
    resourceIds,
    budget: budget(configuration)
  };
  return {
    backend,
    ...provisional,
    bindingDigest: canonicalSha256(provisional)
  };
}

export function bootstrapPlanInputs(
  input: PhasePlanningInput | PhaseAdapterExecutionInput
): Record<string, unknown> {
  const binding = bootstrapBinding(input);
  return {
    backendBindingDigest: binding.backend.bindingDigest,
    bootstrapBindingDigest: binding.bindingDigest,
    environment: binding.environment,
    region: binding.region,
    egressMode: binding.egressMode,
    virtualNetworkCidr: binding.virtualNetworkCidr,
    runnerSubnetCidr: binding.runnerSubnetCidr,
    privateEndpointSubnetCidr: binding.privateEndpointSubnetCidr,
    privateDnsZone: binding.privateDnsZone,
    resourceGroup: binding.resourceGroup,
    deploymentName: binding.deploymentName,
    networkDeploymentName: binding.networkDeploymentName,
    virtualNetworkName: binding.virtualNetworkName,
    runnerSubnetName: binding.runnerSubnetName,
    privateEndpointSubnetName: binding.privateEndpointSubnetName,
    publicIpName: binding.publicIpName,
    natGatewayName: binding.natGatewayName,
    privateEndpointName: binding.privateEndpointName,
    dnsLinkName: binding.dnsLinkName,
    zoneGroupName: binding.zoneGroupName,
    deploymentResourceId: binding.deploymentResourceId,
    networkDeploymentResourceId: binding.networkDeploymentResourceId,
    resourceIds: binding.resourceIds,
    budget: binding.budget,
    adoptsExistingResources: false,
    applicationProvisioning: false
  };
}

function operationFor(input: PhaseAdapterExecutionInput): TransitionOperation {
  const operation = input.plan.operations.find((candidate) =>
    candidate.actionId === 'azure.bootstrap-local.apply'
  );
  if (!operation ||
    canonicalSha256(operation.inputs) !== canonicalSha256(bootstrapPlanInputs(input))) {
    throw new AzureDiscoveryError(
      'bootstrap-plan-stale',
      'The approved bootstrap operation no longer matches the reviewed names, network, backend, and cost scope.'
    );
  }
  return operation;
}

function armTemplate() {
  return {
    $schema: 'https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#',
    contentVersion: '1.0.0.0',
    parameters: {
      resourceGroupName: { type: 'string' },
      location: { type: 'string' },
      virtualNetworkName: { type: 'string' },
      virtualNetworkCidr: { type: 'string' },
      runnerSubnetName: { type: 'string' },
      runnerSubnetCidr: { type: 'string' },
      privateEndpointSubnetName: { type: 'string' },
      privateEndpointSubnetCidr: { type: 'string' },
      publicIpName: { type: 'string' },
      natGatewayName: { type: 'string' },
      privateEndpointName: { type: 'string' },
      storageAccountResourceId: { type: 'string' },
      privateDnsZoneName: { type: 'string' },
      dnsLinkName: { type: 'string' },
      zoneGroupName: { type: 'string' },
      networkDeploymentName: { type: 'string' },
      tags: { type: 'object' }
    },
    resources: [
      {
        type: 'Microsoft.Resources/resourceGroups',
        apiVersion: '2022-09-01',
        name: "[parameters('resourceGroupName')]",
        location: "[parameters('location')]",
        tags: "[parameters('tags')]"
      },
      {
        type: 'Microsoft.Resources/deployments',
        apiVersion: '2022-09-01',
        name: "[parameters('networkDeploymentName')]",
        resourceGroup: "[parameters('resourceGroupName')]",
        dependsOn: ["[resourceId('Microsoft.Resources/resourceGroups', parameters('resourceGroupName'))]"],
        properties: {
          expressionEvaluationOptions: { scope: 'inner' },
          mode: 'Incremental',
          parameters: {
            location: { value: "[parameters('location')]" },
            virtualNetworkName: { value: "[parameters('virtualNetworkName')]" },
            virtualNetworkCidr: { value: "[parameters('virtualNetworkCidr')]" },
            runnerSubnetName: { value: "[parameters('runnerSubnetName')]" },
            runnerSubnetCidr: { value: "[parameters('runnerSubnetCidr')]" },
            privateEndpointSubnetName: { value: "[parameters('privateEndpointSubnetName')]" },
            privateEndpointSubnetCidr: { value: "[parameters('privateEndpointSubnetCidr')]" },
            publicIpName: { value: "[parameters('publicIpName')]" },
            natGatewayName: { value: "[parameters('natGatewayName')]" },
            privateEndpointName: { value: "[parameters('privateEndpointName')]" },
            storageAccountResourceId: { value: "[parameters('storageAccountResourceId')]" },
            privateDnsZoneName: { value: "[parameters('privateDnsZoneName')]" },
            dnsLinkName: { value: "[parameters('dnsLinkName')]" },
            zoneGroupName: { value: "[parameters('zoneGroupName')]" },
            tags: { value: "[parameters('tags')]" }
          },
          template: {
            $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
            contentVersion: '1.0.0.0',
            parameters: {
              location: { type: 'string' },
              virtualNetworkName: { type: 'string' },
              virtualNetworkCidr: { type: 'string' },
              runnerSubnetName: { type: 'string' },
              runnerSubnetCidr: { type: 'string' },
              privateEndpointSubnetName: { type: 'string' },
              privateEndpointSubnetCidr: { type: 'string' },
              publicIpName: { type: 'string' },
              natGatewayName: { type: 'string' },
              privateEndpointName: { type: 'string' },
              storageAccountResourceId: { type: 'string' },
              privateDnsZoneName: { type: 'string' },
              dnsLinkName: { type: 'string' },
              zoneGroupName: { type: 'string' },
              tags: { type: 'object' }
            },
            resources: [
              {
                type: 'Microsoft.Network/publicIPAddresses',
                apiVersion: '2023-09-01',
                name: "[parameters('publicIpName')]",
                location: "[parameters('location')]",
                tags: "[parameters('tags')]",
                sku: { name: 'Standard' },
                properties: { publicIPAllocationMethod: 'Static' }
              },
              {
                type: 'Microsoft.Network/natGateways',
                apiVersion: '2023-09-01',
                name: "[parameters('natGatewayName')]",
                location: "[parameters('location')]",
                tags: "[parameters('tags')]",
                sku: { name: 'Standard' },
                dependsOn: ["[resourceId('Microsoft.Network/publicIPAddresses', parameters('publicIpName'))]"],
                properties: {
                  idleTimeoutInMinutes: 10,
                  publicIpAddresses: [{
                    id: "[resourceId('Microsoft.Network/publicIPAddresses', parameters('publicIpName'))]"
                  }]
                }
              },
              {
                type: 'Microsoft.Network/virtualNetworks',
                apiVersion: '2023-09-01',
                name: "[parameters('virtualNetworkName')]",
                location: "[parameters('location')]",
                tags: "[parameters('tags')]",
                dependsOn: ["[resourceId('Microsoft.Network/natGateways', parameters('natGatewayName'))]"],
                properties: {
                  addressSpace: { addressPrefixes: ["[parameters('virtualNetworkCidr')]"] },
                  subnets: [
                    {
                      name: "[parameters('runnerSubnetName')]",
                      properties: {
                        addressPrefix: "[parameters('runnerSubnetCidr')]",
                        natGateway: {
                          id: "[resourceId('Microsoft.Network/natGateways', parameters('natGatewayName'))]"
                        },
                        delegations: [{
                          name: 'github-network-settings',
                          properties: { serviceName: 'GitHub.Network/networkSettings' }
                        }]
                      }
                    },
                    {
                      name: "[parameters('privateEndpointSubnetName')]",
                      properties: {
                        addressPrefix: "[parameters('privateEndpointSubnetCidr')]",
                        privateEndpointNetworkPolicies: 'Disabled'
                      }
                    }
                  ]
                }
              },
              {
                type: 'Microsoft.Network/privateDnsZones',
                apiVersion: '2020-06-01',
                name: "[parameters('privateDnsZoneName')]",
                location: 'global',
                tags: "[parameters('tags')]"
              },
              {
                type: 'Microsoft.Network/privateDnsZones/virtualNetworkLinks',
                apiVersion: '2020-06-01',
                name: "[format('{0}/{1}', parameters('privateDnsZoneName'), parameters('dnsLinkName'))]",
                location: 'global',
                dependsOn: [
                  "[resourceId('Microsoft.Network/privateDnsZones', parameters('privateDnsZoneName'))]",
                  "[resourceId('Microsoft.Network/virtualNetworks', parameters('virtualNetworkName'))]"
                ],
                properties: {
                  registrationEnabled: false,
                  virtualNetwork: {
                    id: "[resourceId('Microsoft.Network/virtualNetworks', parameters('virtualNetworkName'))]"
                  }
                }
              },
              {
                type: 'Microsoft.Network/privateEndpoints',
                apiVersion: '2023-09-01',
                name: "[parameters('privateEndpointName')]",
                location: "[parameters('location')]",
                tags: "[parameters('tags')]",
                dependsOn: ["[resourceId('Microsoft.Network/virtualNetworks', parameters('virtualNetworkName'))]"],
                properties: {
                  subnet: {
                    id: "[resourceId('Microsoft.Network/virtualNetworks/subnets', parameters('virtualNetworkName'), parameters('privateEndpointSubnetName'))]"
                  },
                  privateLinkServiceConnections: [{
                    name: 'blob',
                    properties: {
                      groupIds: ['blob'],
                      privateLinkServiceId: "[parameters('storageAccountResourceId')]",
                      requestMessage: 'Liftoff approved private backend bootstrap'
                    }
                  }]
                }
              },
              {
                type: 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups',
                apiVersion: '2023-09-01',
                name: "[format('{0}/{1}', parameters('privateEndpointName'), parameters('zoneGroupName'))]",
                dependsOn: [
                  "[resourceId('Microsoft.Network/privateEndpoints', parameters('privateEndpointName'))]",
                  "[resourceId('Microsoft.Network/privateDnsZones', parameters('privateDnsZoneName'))]"
                ],
                properties: {
                  privateDnsZoneConfigs: [{
                    name: 'blob',
                    properties: {
                      privateDnsZoneId: "[resourceId('Microsoft.Network/privateDnsZones', parameters('privateDnsZoneName'))]"
                    }
                  }]
                }
              }
            ]
          }
        }
      }
    ]
  };
}

function deploymentBody(binding: BootstrapBinding, privateDnsZone: string) {
  const tags = {
    'liftoff-managed-by': 'liftoff',
    'liftoff-phase': 'bootstrap-local',
    'liftoff-environment': binding.environment,
    'liftoff-binding': binding.bindingDigest
  };
  const value = (value: unknown) => ({ value });
  return {
    location: binding.region,
    properties: {
      mode: 'Incremental',
      template: armTemplate(),
      parameters: {
        resourceGroupName: value(binding.resourceGroup),
        location: value(binding.region),
        virtualNetworkName: value(binding.virtualNetworkName),
        virtualNetworkCidr: value(binding.virtualNetworkCidr),
        runnerSubnetName: value(binding.runnerSubnetName),
        runnerSubnetCidr: value(binding.runnerSubnetCidr),
        privateEndpointSubnetName: value(binding.privateEndpointSubnetName),
        privateEndpointSubnetCidr: value(binding.privateEndpointSubnetCidr),
        publicIpName: value(binding.publicIpName),
        natGatewayName: value(binding.natGatewayName),
        privateEndpointName: value(binding.privateEndpointName),
        storageAccountResourceId: value(binding.backend.storageAccountResourceId),
        privateDnsZoneName: value(privateDnsZone),
        dnsLinkName: value(binding.dnsLinkName),
        zoneGroupName: value(binding.zoneGroupName),
        networkDeploymentName: value(binding.networkDeploymentName),
        tags: value(tags)
      }
    }
  };
}

interface DeploymentObservation {
  id: string;
  name: string;
  provisioningState: string;
}

function deploymentObservation(value: unknown, binding: BootstrapBinding): DeploymentObservation {
  const deployment = azureObject(value, 'Azure bootstrap deployment');
  const properties = azureObject(deployment.properties, 'Azure bootstrap deployment properties');
  const id = azureText(deployment.id, 'Azure bootstrap deployment id');
  const name = azureText(deployment.name, 'Azure bootstrap deployment name');
  const provisioningState = azureText(
    properties.provisioningState,
    'Azure bootstrap deployment provisioning state'
  );
  if (id.toLowerCase() !== binding.deploymentResourceId.toLowerCase() ||
    name !== binding.deploymentName) {
    return bootstrapError(
      'bootstrap-deployment',
      'Azure returned a bootstrap deployment identity outside the exact reviewed scope.'
    );
  }
  return { id, name, provisioningState };
}

function deploymentUrl(
  resourceManager: string,
  binding: BootstrapBinding
): string {
  return new URL(
    `subscriptions/${binding.backend.subscriptionId}/providers/Microsoft.Resources/deployments/` +
    `${binding.deploymentName}?api-version=${deploymentApiVersion}`,
    resourceManager
  ).toString();
}

async function requireDeploymentAbsence(
  input: PhaseAdapterExecutionInput,
  binding: BootstrapBinding
): Promise<void> {
  const value = await runAzureJson(input, [
    'deployment', 'sub', 'list',
    '--subscription', binding.backend.subscriptionId,
    '--query', `[?name=='${binding.deploymentName}'].{id:id,name:name,provisioningState:properties.provisioningState}`
  ], 'Azure backend bootstrap deployment-name discovery');
  if (!Array.isArray(value) || value.length > 1) {
    return bootstrapError(
      'bootstrap-deployment',
      'Azure bootstrap deployment-name discovery returned an invalid or ambiguous result.'
    );
  }
  if (value.length !== 0) {
    return bootstrapError(
      'bootstrap-deployment',
      'The exact bootstrap deployment name is already occupied without a current owned operation record.'
    );
  }
}

async function observePermissions(
  input: PhaseAdapterExecutionInput,
  identity: Awaited<ReturnType<typeof observeBackendIdentity>>
) {
  const entries = await observeAzureEffectivePermissions(input, {
    subscriptionId: identity.identity.subscription.id,
    resourceManager: identity.identity.cloud.resourceManager,
    resourceManagerAudience: identity.identity.cloud.resourceManagerAudience
  }, 'Azure backend bootstrap permission discovery');
  const missing = requiredActions.filter((action) => !azurePermits(entries, action));
  if (missing.length) {
    return bootstrapError(
      'bootstrap-permission',
      `The current Azure identity lacks ${missing.length} exact bootstrap permission${missing.length === 1 ? '' : 's'}; no billable write was dispatched.`
    );
  }
  return { requiredActions: [...requiredActions], permissionEntryCount: entries.length };
}

function outputs(binding: BootstrapBinding, permissions: {
  requiredActions: readonly string[];
  permissionEntryCount: number;
}) {
  return {
    values: {
      statePath: 'bootstrap-local',
      bootstrapBindingDigest: binding.bindingDigest,
      backendBindingDigest: binding.backend.bindingDigest,
      environment: binding.environment,
      egressMode: binding.egressMode,
      deploymentResourceId: binding.deploymentResourceId,
      fixedMonthlyCents: binding.budget.fixedMonthlyCents,
      usageMonthlyCents: binding.budget.usageMonthlyCents,
      permissionEntryCount: permissions.permissionEntryCount,
      requiredPermissionCount: permissions.requiredActions.length,
      adoptsExistingResources: false,
      applicationProvisioning: false
    },
    resources: [
      {
        provider: 'azure' as const,
        resourceType: 'Microsoft.Resources/deployments',
        resourceId: binding.deploymentResourceId
      },
      ...binding.resourceIds.map((resource) => ({
        provider: 'azure' as const,
        ...resource
      }))
    ]
  };
}

async function observeProvisionedResources(
  input: PhaseAdapterExecutionInput,
  binding: BootstrapBinding,
) {
  const expected = outputs(binding, {
    requiredActions,
    permissionEntryCount: 0
  }).resources.filter((resource) => resource.resourceType !== 'Microsoft.Resources/deployments');
  const observations = [];
  for (const resource of expected) {
    const value = resource.resourceType === 'Microsoft.Resources/resourceGroups'
      ? await runAzureJson(input, [
        'group', 'show',
        '--subscription', binding.backend.subscriptionId,
        '--name', binding.resourceGroup,
        '--query', '{id:id,name:name,location:location,provisioningState:properties.provisioningState,tags:tags}'
      ], 'Azure bootstrap resource-group readback')
      : await runAzureJson(input, [
        'resource', 'show',
        '--subscription', binding.backend.subscriptionId,
        '--ids', resource.resourceId,
        '--query', '{id:id,name:name,type:type,location:location,provisioningState:properties.provisioningState,tags:tags}'
      ], `Azure bootstrap ${resource.resourceType} readback`);
    const observed = azureObject(value, 'Azure bootstrap resource');
    const id = azureText(observed.id, 'Azure bootstrap resource id');
    if (id.toLowerCase() !== resource.resourceId.toLowerCase()) {
      return bootstrapError(
        'bootstrap-readback',
        'Azure bootstrap resource readback differs from the exact reviewed resource identity.'
      );
    }
    const state = observed.provisioningState;
    if (typeof state === 'string' &&
      !['Succeeded', 'Completed'].includes(state)) {
      return bootstrapError(
        'bootstrap-readback',
        'An exact Azure bootstrap resource is not in a terminal successful provisioning state.'
      );
    }
    observations.push({ resource, observed });
  }
  return observations;
}

function operationTime(input: PhaseAdapterExecutionInput): Date {
  return input.clock?.() ?? input.now;
}

export async function executeAzureBackendBootstrap(
  input: PhaseAdapterExecutionInput
): Promise<PhaseAdapterOutcome | null> {
  if (input.phase.id !== 'bootstrap-local') return null;
  const completedOperations: TransitionOperation[] = [];
  try {
    const operation = operationFor(input);
    const binding = bootstrapBinding(input);
    if (input.inspection.state.applicability.statePath !== 'bootstrap-local') {
      return bootstrapError(
        'bootstrap-selection',
        'The activation state does not select the reviewed bootstrap-local backend path.'
      );
    }
    const identity = await observeBackendIdentity(input, binding.backend);
    const account = await observeStorageAccount(input, binding.backend, identity.identity.cloud.name);
    const privateDnsZone = privateBlobDnsZoneForAzureCloud(identity.identity.cloud.name);
    if (binding.privateDnsZone !== privateDnsZone) {
      return bootstrapError(
        'bootstrap-network',
        'The reviewed private Blob DNS zone does not match the exact selected Azure cloud.'
      );
    }
    const permissions = await observePermissions(input, identity);
    const url = deploymentUrl(identity.identity.cloud.resourceManager, binding);
    const previous = input.inspection.state.phases['bootstrap-local'].operation;
    let observation: DeploymentObservation;
    if (previous) {
      const current = await runAzureJson(input, [
        'rest', '--method', 'GET', '--url', url,
        '--resource', identity.identity.cloud.resourceManagerAudience
      ], 'Azure backend bootstrap deployment readback');
      observation = deploymentObservation(current, binding);
    } else {
      await requireDeploymentAbsence(input, binding);
      const body = deploymentBody(binding, privateDnsZone);
      await runAzureJson(input, [
        'rest', '--method', 'POST', '--url', url.replace(
          `?api-version=${deploymentApiVersion}`,
          `/validate?api-version=${deploymentApiVersion}`
        ),
        '--resource', identity.identity.cloud.resourceManagerAudience,
        '--body', JSON.stringify(body)
      ], 'Azure backend bootstrap deployment validation');
      const created = await runAzureJson(input, [
        'rest', '--method', 'PUT', '--url', url,
        '--resource', identity.identity.cloud.resourceManagerAudience,
        '--body', JSON.stringify(body)
      ], 'Azure backend bootstrap deployment dispatch');
      observation = deploymentObservation(created, binding);
    }
    const observedAt = operationTime(input).toISOString();
    const liveReadback = [
      readbackProof(input, 'azure', 'Microsoft.Resources/deployments', observation.id, observation)
    ];
    const handle = {
      provider: 'azure' as const,
      actionId: operation.actionId,
      operationId: `azure-deployment:${observation.id.toLowerCase()}`,
      resourceId: observation.id,
      startedAt: previous?.startedAt ?? observedAt,
      observedAt,
      pollUrl: url
    };
    if (['Accepted', 'Running', 'Ready', 'Creating'].includes(observation.provisioningState)) {
      return {
        status: 'pending',
        blocker: 'Azure backend bootstrap deployment is still running; resume reobserves the same deployment without redispatch.',
        operation: { ...handle, status: 'running' },
        liveReadback,
        outputs: outputs(binding, permissions),
        completedOperations
      };
    }
    if (observation.provisioningState !== 'Succeeded') {
      return {
        status: 'blocked',
        resultState: 'failed',
        blocker: 'Azure backend bootstrap deployment reached a terminal non-success state; provider diagnostics were withheld.',
        operation: { ...handle, status: 'failed' },
        liveReadback,
        outputs: outputs(binding, permissions),
        completedOperations
      };
    }
    const resources = await observeProvisionedResources(input, binding);
    completedOperations.push(operation);
    return {
      status: 'completed',
      resultState: 'verified',
      operation: { ...handle, status: 'completed' },
      evidencePayload: {
        kind: 'bootstrap-local.v1',
        bootstrapBindingDigest: binding.bindingDigest,
        backendBindingDigest: binding.backend.bindingDigest,
        environment: binding.environment,
        region: binding.region,
        egressMode: binding.egressMode,
        network: {
          virtualNetworkCidr: binding.virtualNetworkCidr,
          runnerSubnetCidr: binding.runnerSubnetCidr,
          privateEndpointSubnetCidr: binding.privateEndpointSubnetCidr,
          privateDnsZone
        },
        budget: binding.budget,
        permissions,
        deployment: observation,
        account,
        resources: resources.map(({ resource, observed }) => ({
          resourceType: resource.resourceType,
          resourceId: resource.resourceId,
          observedDigest: canonicalSha256(observed)
        })),
        adoptsExistingResources: false,
        applicationProvisioning: false,
        stateImport: false
      },
      liveReadback: [
        ...liveReadback,
        ...resources.map(({ resource, observed }) =>
          readbackProof(input, 'azure', resource.resourceType, resource.resourceId, observed))
      ],
      outputs: outputs(binding, permissions),
      completedOperations
    };
  } catch (error) {
    if (!(error instanceof AzureDiscoveryError)) throw error;
    return {
      status: 'blocked',
      resultState: 'failed',
      blocker: error.message,
      completedOperations
    };
  }
}
