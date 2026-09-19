import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { azureArmBinding, azureArmUrl, type AzureArmBinding } from '../../adapters/azure/activation-rest.js';
import { AzureActivationAdmissionError } from './authority.js';

export interface PrivateArmResource {
  resourceId: string;
  resourceType: string;
  apiVersion: string;
  location: string | null;
  body: Readonly<Record<string, unknown>>;
  bodyDigest: string;
  dependsOn: readonly string[];
}

export interface PrivateArmResourcePlan {
  schemaVersion: 1;
  recipe: 'bootstrap-access-arm/1' | 'github-runner-network-arm/1';
  phaseId: 'bootstrap-local';
  binding: AzureArmBinding;
  repositoryId: string;
  region: string;
  configurationDigest: string;
  expiresAt: string;
  sourceDigest: string;
  planDigest: string;
  resources: readonly PrivateArmResource[];
}

export interface RunnerNetworkArmInputs {
  binding: AzureArmBinding;
  repositoryId: string;
  region: string;
  configurationDigest: string;
  expiresAt: string;
  resourceGroup: string;
  networkSettingsName: string;
  githubBusinessId: string;
  subnetId: string;
}

export interface BootstrapAccessInputs {
  binding: AzureArmBinding;
  repositoryId: string;
  region: string;
  configurationDigest: string;
  expiresAt: string;
  resourceGroup: string;
  storageAccountResourceId: string;
  network: {
    vnetName: string;
    addressPrefix: string;
    runnerSubnetName: string;
    runnerSubnetPrefix: string;
    endpointSubnetName: string;
    endpointSubnetPrefix: string;
    endpointAddress: string;
    networkSecurityGroupName: string;
    routeTableName: string;
    natGatewayName: string;
    publicIpName: string;
    privateEndpointName: string;
    dnsLinkName: string;
    outboundHttpsPrefixes: readonly string[];
  };
  runner: { networkSettingsName: string; githubBusinessId: string };
}

const networkApi = '2024-05-01';
const dnsApi = '2020-06-01';
const runnerApi = '2024-04-02';
const dnsZone = 'privatelink.blob.core.windows.net';
const source = Object.freeze({
  bootstrap: {
    recipe: 'bootstrap-access-arm/1',
    networkApi, dnsApi, dnsZone,
    scope: 'new-repository-dedicated-network-only',
    resources: [
      'Microsoft.Network/networkSecurityGroups', 'Microsoft.Network/routeTables',
      'Microsoft.Network/publicIPAddresses', 'Microsoft.Network/natGateways',
      'Microsoft.Network/virtualNetworks', 'Microsoft.Network/virtualNetworks/subnets',
      'Microsoft.Network/privateDnsZones', 'Microsoft.Network/privateDnsZones/virtualNetworkLinks',
      'Microsoft.Network/privateEndpoints', 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups'
    ],
    storage: 'existing-only', roleAssignments: 'existing-only', applicationProvisioning: 'forbidden',
    runnerDelegation: 'GitHub.Network/networkSettings', privateEndpointGroup: 'blob',
    inbound: 'deny-all', outbound: 'exact-reviewed-https-prefixes-and-private-blob-and-azure-dns',
    routing: 'explicit-internet-route-through-dedicated-nat',
    tls: '1.2-or-newer'
  },
  runner: { recipe: 'github-runner-network-arm/1', apiVersion: runnerApi, resourceType: 'GitHub.Network/networkSettings' }
});

function fail(message: string): never {
  throw new AzureActivationAdmissionError('private-plan-input', message);
}

export function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} requires its exact declared fields; flags, inferred targets and additional payloads are not accepted.`);
  }
  return value;
}

export function privateDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail(`${label} must be an exact public configuration or source digest.`);
  return value;
}

export function privateName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u.test(value) || value.includes('..')) {
    fail(`${label} must be one explicit safe resource name.`);
  }
  return value;
}

function decimalId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(value)) fail(`${label} must be the actual positive provider ID.`);
  return value;
}

export function privateIpv4(value: unknown): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/u.test(value)) fail('An exact IPv4 address is required.');
  const parts = value.split('.').map(Number);
  if (parts.some((part) => part > 255)) fail('An IPv4 octet is out of range.');
  return parts.reduce((result, part) => result * 256 + part, 0);
}

function cidr(value: unknown, privateOnly = true): { start: number; end: number; bits: number } {
  if (typeof value !== 'string' || !/\/(?:[0-9]|[12][0-9]|3[0-2])$/u.test(value)) fail('An explicit canonical IPv4 CIDR is required.');
  const [address, suffix] = value.split('/');
  const start = privateIpv4(address);
  const bits = Number(suffix);
  const size = 2 ** (32 - bits);
  if (start % size !== 0) fail('Network CIDRs must not contain host bits.');
  const end = start + size - 1;
  if (privateOnly && ![[0x0a000000, 0x0affffff], [0xac100000, 0xac1fffff], [0xc0a80000, 0xc0a8ffff]]
    .some(([first, last]) => start >= first! && end <= last!)) fail('Private runner and endpoint subnets must use RFC1918 address space.');
  return { start, end, bits };
}

function common(value: {
  binding: AzureArmBinding; repositoryId: string; region: string; configurationDigest: string; expiresAt: string; resourceGroup: string;
}) {
  exactObject(value.binding, ['subscriptionId', 'tenantId', 'principalId'], 'Azure identity');
  const binding = azureArmBinding(value.binding);
  if (typeof value.region !== 'string' || !/^[a-z][a-z0-9]{1,39}$/u.test(value.region)) fail('Select the exact Azure region; no ambient location is used.');
  if (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) ||
    new Date(value.expiresAt).toISOString() !== value.expiresAt) fail('The access plan requires an exact ISO expiry.');
  return {
    binding, repositoryId: decimalId(value.repositoryId, 'Repository ID'), region: value.region,
    configurationDigest: privateDigest(value.configurationDigest, 'Configuration binding'), expiresAt: value.expiresAt,
    resourceGroup: privateName(value.resourceGroup, 'Resource group')
  };
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function finish(
  recipe: PrivateArmResourcePlan['recipe'], base: ReturnType<typeof common>,
  resources: readonly PrivateArmResource[], sourceDigest: string
): PrivateArmResourcePlan {
  const { resourceGroup: _group, ...binding } = base;
  const plan = { schemaVersion: 1 as const, recipe, phaseId: 'bootstrap-local' as const, ...binding, sourceDigest, resources };
  return freeze({ ...plan, planDigest: canonicalSha256(plan) });
}

export function planRunnerArmResources(input: RunnerNetworkArmInputs): PrivateArmResourcePlan {
  exactObject(input, ['binding', 'repositoryId', 'region', 'configurationDigest', 'expiresAt', 'resourceGroup',
    'networkSettingsName', 'githubBusinessId', 'subnetId'], 'Runner network plan');
  const base = common(input);
  const root = `/subscriptions/${base.binding.subscriptionId}/resourceGroups/${base.resourceGroup}`;
  const resourceId = `${root}/providers/GitHub.Network/networkSettings/${privateName(input.networkSettingsName, 'Network settings name')}`;
  azureArmUrl(input.subnetId, networkApi, base.binding.subscriptionId);
  if (!input.subnetId.startsWith(`${root}/providers/Microsoft.Network/virtualNetworks/`) ||
    !/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/virtualNetworks\/[^/]+\/subnets\/[^/]+$/u.test(input.subnetId)) {
    fail('Runner network settings must bind the exact dedicated subnet in the reviewed resource group.');
  }
  const body = {
    location: base.region,
    tags: { 'liftoff-repository-id': base.repositoryId, 'liftoff-purpose': 'private-state-access' },
    properties: { subnetId: input.subnetId, businessId: decimalId(input.githubBusinessId, 'GitHub business ID') }
  };
  return finish('github-runner-network-arm/1', base, [{
    resourceId, resourceType: 'GitHub.Network/networkSettings', apiVersion: runnerApi, location: base.region,
    body, bodyDigest: canonicalSha256(body), dependsOn: [input.subnetId]
  }], privateArmSourceDigest('github-runner-network-arm/1'));
}

export function planBootstrapArmResources(input: BootstrapAccessInputs): PrivateArmResourcePlan {
  exactObject(input, ['binding', 'repositoryId', 'region', 'configurationDigest', 'expiresAt', 'resourceGroup',
    'storageAccountResourceId', 'network', 'runner'], 'Bootstrap access plan');
  exactObject(input.network, ['vnetName', 'addressPrefix', 'runnerSubnetName', 'runnerSubnetPrefix',
    'endpointSubnetName', 'endpointSubnetPrefix', 'endpointAddress', 'networkSecurityGroupName', 'routeTableName',
    'natGatewayName', 'publicIpName', 'privateEndpointName', 'dnsLinkName', 'outboundHttpsPrefixes'], 'Dedicated network');
  exactObject(input.runner, ['networkSettingsName', 'githubBusinessId'], 'Runner network settings');
  const base = common(input);
  const n = input.network;
  for (const field of ['vnetName', 'runnerSubnetName', 'endpointSubnetName', 'networkSecurityGroupName',
    'routeTableName', 'natGatewayName', 'publicIpName', 'privateEndpointName', 'dnsLinkName'] as const) privateName(n[field], field);
  const address = cidr(n.addressPrefix), runner = cidr(n.runnerSubnetPrefix), endpoint = cidr(n.endpointSubnetPrefix);
  if ([runner, endpoint].some((subnet) => subnet.start < address.start || subnet.end > address.end) ||
    runner.start <= endpoint.end && endpoint.start <= runner.end || runner.bits > 27 || endpoint.bits > 29 ||
    n.runnerSubnetName === n.endpointSubnetName) fail('Runner and endpoint subnets must be disjoint, contained and large enough for the supported private runner recipe.');
  const ip = privateIpv4(n.endpointAddress);
  if (ip < endpoint.start + 4 || ip >= endpoint.end) fail('The blob endpoint needs a reviewed usable static IP in its dedicated subnet.');
  if (!Array.isArray(n.outboundHttpsPrefixes) || !n.outboundHttpsPrefixes.length || n.outboundHttpsPrefixes.length > 64 ||
    new Set(n.outboundHttpsPrefixes).size !== n.outboundHttpsPrefixes.length) fail('Supply a bounded exact outbound HTTPS address inventory; no service tags are guessed.');
  for (const prefix of n.outboundHttpsPrefixes) {
    const range = cidr(prefix, false);
    if (range.bits < 8 || range.start === 0 || range.start >= 0xe0000000) fail('Wildcard and special-use outbound networks are not supported.');
  }
  azureArmUrl(input.storageAccountResourceId, '2023-05-01', base.binding.subscriptionId);
  if (!/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Storage\/storageAccounts\/[a-z0-9]{3,24}$/u.test(input.storageAccountResourceId)) {
    fail('Bootstrap binds an existing exact storage account; storage and RBAC creation need distinct authority.');
  }
  const root = `/subscriptions/${base.binding.subscriptionId}/resourceGroups/${base.resourceGroup}/providers/Microsoft.Network`;
  const id = (type: string, name: string) => `${root}/${type}/${name}`;
  const vnet = id('virtualNetworks', n.vnetName);
  const runnerSubnet = `${vnet}/subnets/${n.runnerSubnetName}`;
  const endpointSubnet = `${vnet}/subnets/${n.endpointSubnetName}`;
  const nsg = id('networkSecurityGroups', n.networkSecurityGroupName);
  const routes = id('routeTables', n.routeTableName);
  const publicIp = id('publicIPAddresses', n.publicIpName);
  const nat = id('natGateways', n.natGatewayName);
  const zone = id('privateDnsZones', dnsZone);
  const pe = id('privateEndpoints', n.privateEndpointName);
  const resources: PrivateArmResource[] = [];
  const add = (resourceId: string, resourceType: string, properties: object, dependsOn: string[] = [],
    extras: Record<string, unknown> = {}, location: string | null = base.region, apiVersion = networkApi) => {
    const body = {
      ...(location === null ? {} : { location }),
      ...(!resourceType.includes('/subnets') && !resourceType.includes('/privateDnsZoneGroups')
        ? { tags: { 'liftoff-repository-id': base.repositoryId, 'liftoff-purpose': 'private-state-access' } } : {}),
      ...extras, properties
    };
    azureArmUrl(resourceId, apiVersion, base.binding.subscriptionId);
    resources.push({ resourceId, resourceType, apiVersion, location, body, bodyDigest: canonicalSha256(body), dependsOn });
  };
  const rule = (name: string, priority: number, direction: 'Inbound' | 'Outbound', access: 'Allow' | 'Deny',
    protocol: string, destinationPortRange: string, destinationAddressPrefixes: string[]) => ({
    name, properties: { priority, direction, access, protocol, sourcePortRange: '*', destinationPortRange,
      sourceAddressPrefix: '*', destinationAddressPrefixes }
  });
  add(nsg, 'Microsoft.Network/networkSecurityGroups', {
    securityRules: [
      rule('deny-inbound', 100, 'Inbound', 'Deny', '*', '*', ['0.0.0.0/0']),
      rule('private-blob', 100, 'Outbound', 'Allow', 'Tcp', '443', [`${n.endpointAddress}/32`]),
      rule('dns-udp', 110, 'Outbound', 'Allow', 'Udp', '53', ['168.63.129.16/32']),
      rule('dns-tcp', 120, 'Outbound', 'Allow', 'Tcp', '53', ['168.63.129.16/32']),
      rule('reviewed-https', 130, 'Outbound', 'Allow', 'Tcp', '443', [...n.outboundHttpsPrefixes]),
      rule('deny-other-egress', 4096, 'Outbound', 'Deny', '*', '*', ['0.0.0.0/0'])
    ]
  });
  add(routes, 'Microsoft.Network/routeTables', {
    disableBgpRoutePropagation: true,
    routes: [{ name: 'reviewed-internet', properties: { addressPrefix: '0.0.0.0/0', nextHopType: 'Internet' } }]
  });
  add(publicIp, 'Microsoft.Network/publicIPAddresses', {
    publicIPAllocationMethod: 'Static', publicIPAddressVersion: 'IPv4'
  }, [], { sku: { name: 'Standard', tier: 'Regional' } });
  add(nat, 'Microsoft.Network/natGateways', {
    idleTimeoutInMinutes: 4, publicIpAddresses: [{ id: publicIp }]
  }, [publicIp], { sku: { name: 'Standard' } });
  add(vnet, 'Microsoft.Network/virtualNetworks', {
    addressSpace: { addressPrefixes: [n.addressPrefix] }, dhcpOptions: { dnsServers: [] }
  });
  add(runnerSubnet, 'Microsoft.Network/virtualNetworks/subnets', {
    addressPrefix: n.runnerSubnetPrefix, networkSecurityGroup: { id: nsg }, routeTable: { id: routes },
    natGateway: { id: nat }, defaultOutboundAccess: false,
    delegations: [{ name: 'github-runners', properties: { serviceName: 'GitHub.Network/networkSettings' } }]
  }, [vnet, nsg, routes, nat], {}, null);
  add(endpointSubnet, 'Microsoft.Network/virtualNetworks/subnets', {
    addressPrefix: n.endpointSubnetPrefix, privateEndpointNetworkPolicies: 'Disabled', defaultOutboundAccess: false
  }, [vnet], {}, null);
  add(zone, 'Microsoft.Network/privateDnsZones', {}, [], {}, 'global', dnsApi);
  add(`${zone}/virtualNetworkLinks/${n.dnsLinkName}`, 'Microsoft.Network/privateDnsZones/virtualNetworkLinks', {
    virtualNetwork: { id: vnet }, registrationEnabled: false
  }, [zone, vnet], {}, 'global', dnsApi);
  add(pe, 'Microsoft.Network/privateEndpoints', {
    subnet: { id: endpointSubnet },
    privateLinkServiceConnections: [{
      name: 'private-state-blob', properties: { privateLinkServiceId: input.storageAccountResourceId, groupIds: ['blob'] }
    }],
    ipConfigurations: [{ name: 'private-state-blob', properties: { privateIPAddress: n.endpointAddress, groupId: 'blob', memberName: 'blob' } }]
  }, [endpointSubnet]);
  add(`${pe}/privateDnsZoneGroups/state`, 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups', {
    privateDnsZoneConfigs: [{ name: 'blob', properties: { privateDnsZoneId: zone } }]
  }, [pe, zone], {}, null);
  const runnerPlan = planRunnerArmResources({
    ...base, networkSettingsName: input.runner.networkSettingsName,
    githubBusinessId: input.runner.githubBusinessId, subnetId: runnerSubnet
  });
  resources.push(...runnerPlan.resources);
  return finish('bootstrap-access-arm/1', base, resources, privateArmSourceDigest('bootstrap-access-arm/1'));
}

export function privateArmSourceDigest(recipe: PrivateArmResourcePlan['recipe']): string {
  return canonicalSha256({
    recipe,
    definitions: recipe === 'bootstrap-access-arm/1' ? source : source.runner,
    executableSources: [
      ...(recipe === 'bootstrap-access-arm/1' ? [planBootstrapArmResources, cidr, privateIpv4] : []),
      planRunnerArmResources, common, decimalId, privateName, privateDigest, exactObject, finish
    ].map((implementation) => Function.prototype.toString.call(implementation))
  });
}

export function privateArmInventory(plan: PrivateArmResourcePlan) {
  const { planDigest, ...body } = plan;
  if (canonicalSha256(body) !== planDigest || plan.sourceDigest !== privateArmSourceDigest(plan.recipe) ||
    plan.resources.some((resource) => resource.bodyDigest !== canonicalSha256(resource.body))) {
    fail('The exact immutable access resource plan has changed.');
  }
  return {
    schemaVersion: 1 as const, recipe: plan.recipe, phaseId: plan.phaseId,
    sourceDigest: plan.sourceDigest, planDigest,
    resources: plan.resources.map(({ resourceId, resourceType, apiVersion, bodyDigest }) => ({ resourceId, resourceType, apiVersion, bodyDigest }))
  };
}
