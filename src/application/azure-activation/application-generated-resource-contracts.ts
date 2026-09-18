import { isRecord } from '../../domain/governance/activation/canonical-json.js';
import {
  ApplicationPrivateError,
  applicationPrivateAssert as must
} from './application-private-errors.js';
import { applicationPrivateAddress } from './application-private-address.js';

export class GeneratedApplicationResourceError extends ApplicationPrivateError {
  constructor(code: string) {
    super(code);
    this.name = 'GeneratedApplicationResourceError';
  }
}

export function generatedApplicationAssert(value: unknown, code: string): asserts value {
  if (!value) throw new GeneratedApplicationResourceError(code);
}

export const generatedApplicationResourceContracts = {
  azurerm_postgresql_flexible_server: {
    arm: 'Microsoft.DBforPostgreSQL/flexibleServers',
    api: '2023-03-01-preview',
    namespace: 'Microsoft.DBforPostgreSQL',
    scopeKind: 'resource-group' as const,
    parentType: null,
    paths: [
      'name',
      'location',
      'resource_group_name',
      'version',
      'administrator_login',
      'storage_mb',
      'sku_name',
      'tags.liftoff-repository-id'
    ] as const,
    computed: [
      'id',
      'fqdn',
      'public_network_access_enabled'
    ] as const,
    sensitiveOutputs: [
      'administrator_password'
    ] as const
  },
  azurerm_postgresql_flexible_server_firewall_rule: {
    arm: 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules',
    api: '2023-03-01-preview',
    namespace: 'Microsoft.DBforPostgreSQL',
    scopeKind: 'server-child' as const,
    parentType: 'azurerm_postgresql_flexible_server' as const,
    paths: [
      'name',
      'server_id',
      'start_ip_address',
      'end_ip_address'
    ] as const,
    computed: [
      'id'
    ] as const,
    sensitiveOutputs: [] as const
  },
  azurerm_redis_cache: {
    arm: 'Microsoft.Cache/redis',
    api: '2023-08-01',
    namespace: 'Microsoft.Cache',
    scopeKind: 'resource-group' as const,
    parentType: null,
    paths: [
      'name',
      'location',
      'resource_group_name',
      'capacity',
      'family',
      'sku_name',
      'minimum_tls_version',
      'tags.liftoff-repository-id'
    ] as const,
    computed: [
      'id',
      'hostname',
      'ssl_port',
      'port'
    ] as const,
    sensitiveOutputs: [
      'primary_access_key',
      'secondary_access_key',
      'primary_connection_string',
      'secondary_connection_string'
    ] as const
  },
  azurerm_storage_account: {
    arm: 'Microsoft.Storage/storageAccounts',
    api: '2023-05-01',
    namespace: 'Microsoft.Storage',
    scopeKind: 'resource-group' as const,
    parentType: null,
    paths: [
      'name',
      'location',
      'resource_group_name',
      'account_tier',
      'account_replication_type',
      'min_tls_version',
      'allow_nested_items_to_be_public',
      'tags.liftoff-repository-id'
    ] as const,
    computed: [
      'id',
      'primary_blob_endpoint',
      'primary_blob_host',
      'primary_location',
      'secondary_location',
      'primary_web_endpoint',
      'primary_web_host'
    ] as const,
    sensitiveOutputs: [
      'primary_access_key',
      'secondary_access_key',
      'primary_connection_string',
      'secondary_connection_string'
    ] as const
  },
  azurerm_storage_container: {
    arm: 'Microsoft.Storage/storageAccounts/blobServices/containers',
    api: '2023-05-01',
    namespace: 'Microsoft.Storage',
    scopeKind: 'storage-container-child' as const,
    parentType: 'azurerm_storage_account' as const,
    paths: [
      'name',
      'storage_account_id',
      'container_access_type'
    ] as const,
    computed: [
      'id',
      'has_immutability_policy',
      'has_legal_hold',
      'resource_manager_id'
    ] as const,
    sensitiveOutputs: [] as const
  },
  azurerm_servicebus_namespace: {
    arm: 'Microsoft.ServiceBus/namespaces',
    api: '2022-10-01-preview',
    namespace: 'Microsoft.ServiceBus',
    scopeKind: 'resource-group' as const,
    parentType: null,
    paths: [
      'name',
      'location',
      'resource_group_name',
      'sku',
      'minimum_tls_version',
      'tags.liftoff-repository-id'
    ] as const,
    computed: [
      'id',
      'endpoint'
    ] as const,
    sensitiveOutputs: [
      'default_primary_connection_string',
      'default_secondary_connection_string',
      'default_primary_key',
      'default_secondary_key'
    ] as const
  },
  azurerm_servicebus_queue: {
    arm: 'Microsoft.ServiceBus/namespaces/queues',
    api: '2022-10-01-preview',
    namespace: 'Microsoft.ServiceBus',
    scopeKind: 'servicebus-queue-child' as const,
    parentType: 'azurerm_servicebus_namespace' as const,
    paths: [
      'name',
      'namespace_id'
    ] as const,
    computed: [
      'id'
    ] as const,
    sensitiveOutputs: [] as const
  },
  azurerm_communication_service: {
    arm: 'Microsoft.Communication/communicationServices',
    api: '2023-04-01',
    namespace: 'Microsoft.Communication',
    scopeKind: 'resource-group' as const,
    parentType: null,
    paths: [
      'name',
      'resource_group_name',
      'data_location',
      'tags.liftoff-repository-id'
    ] as const,
    computed: [
      'id',
      'hostname'
    ] as const,
    sensitiveOutputs: [
      'primary_connection_string',
      'secondary_connection_string',
      'primary_key',
      'secondary_key'
    ] as const
  },
  azurerm_key_vault: {
    arm: 'Microsoft.KeyVault/vaults',
    api: '2023-07-01',
    namespace: 'Microsoft.KeyVault',
    scopeKind: 'resource-group' as const,
    parentType: null,
    paths: [
      'name',
      'location',
      'resource_group_name',
      'tenant_id',
      'sku_name',
      'rbac_authorization_enabled',
      'tags.liftoff-repository-id'
    ] as const,
    computed: [
      'id',
      'vault_uri'
    ] as const,
    sensitiveOutputs: [] as const
  },
  azurerm_service_plan: {
    arm: 'Microsoft.Web/serverfarms',
    api: '2023-12-01',
    namespace: 'Microsoft.Web',
    scopeKind: 'resource-group' as const,
    parentType: null,
    paths: [
      'name',
      'location',
      'resource_group_name',
      'os_type',
      'sku_name',
      'tags.liftoff-repository-id'
    ] as const,
    computed: [
      'id',
      'kind',
      'reserved'
    ] as const,
    sensitiveOutputs: [] as const
  },
  azurerm_linux_function_app: {
    arm: 'Microsoft.Web/sites',
    api: '2023-12-01',
    namespace: 'Microsoft.Web',
    scopeKind: 'resource-group' as const,
    parentType: null,
    paths: [
      'name',
      'location',
      'resource_group_name',
      'service_plan_id',
      'storage_account_name',
      'identity.0.type',
      'identity.0.identity_ids.0',
      'site_config.0.application_stack.0.python_version',
      'tags.liftoff-repository-id'
    ] as const,
    computed: [
      'id',
      'default_hostname',
      'outbound_ip_addresses',
      'possible_outbound_ip_addresses'
    ] as const,
    sensitiveOutputs: [
      'storage_account_access_key',
      'site_credential'
    ] as const
  }
} as const;

export type GeneratedApplicationResourceType = keyof typeof generatedApplicationResourceContracts;

export function isGeneratedApplicationResourceType(type: string): type is GeneratedApplicationResourceType {
  return Object.hasOwn(generatedApplicationResourceContracts, type);
}

export const generatedResourcePaths: Readonly<Record<GeneratedApplicationResourceType, readonly string[]>> =
  Object.freeze(Object.fromEntries(
    Object.entries(generatedApplicationResourceContracts).map(([type, contract]) => [type, contract.paths])
  )) as unknown as Readonly<Record<GeneratedApplicationResourceType, readonly string[]>>;

export const generatedResourceComputedAttributes: Readonly<Record<GeneratedApplicationResourceType, readonly string[]>> =
  Object.freeze(Object.fromEntries(
    Object.entries(generatedApplicationResourceContracts).map(([type, contract]) => [type, contract.computed])
  )) as unknown as Readonly<Record<GeneratedApplicationResourceType, readonly string[]>>;

export const generatedResourceSensitiveAttributes: Readonly<Record<GeneratedApplicationResourceType, readonly string[]>> =
  Object.freeze(Object.fromEntries(
    Object.entries(generatedApplicationResourceContracts).map(([type, contract]) => [type, contract.sensitiveOutputs])
  )) as unknown as Readonly<Record<GeneratedApplicationResourceType, readonly string[]>>;

export type GeneratedApplicationAction = 'create' | 'update' | 'no-op';
export type GeneratedApplicationScalar = string | number | boolean | null;

export interface GeneratedApplicationResourceTarget {
  address: string;
  type: GeneratedApplicationResourceType;
  resourceId: string;
  actions: readonly GeneratedApplicationAction[];
  expected: Readonly<Record<string, GeneratedApplicationScalar>>;
  role?: null;
  runtime?: null;
}

export interface ParsedGeneratedResourceId {
  subscriptionId: string;
  resourceGroup: string;
  name: string;
  parentName?: string;
}

export function parseGeneratedResourceId(
  type: GeneratedApplicationResourceType,
  resourceId: string
): ParsedGeneratedResourceId {
  must(typeof resourceId === 'string' && resourceId.length > 0, 'target-resource-id');

  const patterns: Record<GeneratedApplicationResourceType, RegExp> = {
    azurerm_postgresql_flexible_server:
      /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.DBforPostgreSQL\/flexibleServers\/([^/]+)$/iu,
    azurerm_postgresql_flexible_server_firewall_rule:
      /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.DBforPostgreSQL\/flexibleServers\/([^/]+)\/firewallRules\/([^/]+)$/iu,
    azurerm_redis_cache:
      /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Cache\/redis\/([^/]+)$/iu,
    azurerm_storage_account:
      /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Storage\/storageAccounts\/([^/]+)$/iu,
    azurerm_storage_container:
      /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Storage\/storageAccounts\/([^/]+)\/blobServices\/default\/containers\/([^/]+)$/iu,
    azurerm_servicebus_namespace:
      /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ServiceBus\/namespaces\/([^/]+)$/iu,
    azurerm_servicebus_queue:
      /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ServiceBus\/namespaces\/([^/]+)\/queues\/([^/]+)$/iu,
    azurerm_communication_service:
      /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Communication\/communicationServices\/([^/]+)$/iu,
    azurerm_key_vault:
      /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.KeyVault\/vaults\/([^/]+)$/iu,
    azurerm_service_plan:
      /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Web\/serverfarms\/([^/]+)$/iu,
    azurerm_linux_function_app:
      /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Web\/sites\/([^/]+)$/iu
  };

  const pattern = patterns[type];
  must(pattern !== undefined, 'unsupported-generated-resource-type');
  const match = pattern.exec(resourceId);
  must(match, 'target-resource-id');

  if (type === 'azurerm_postgresql_flexible_server_firewall_rule' ||
      type === 'azurerm_storage_container' ||
      type === 'azurerm_servicebus_queue') {
    return {
      subscriptionId: match[1]!,
      resourceGroup: match[2]!,
      parentName: match[3]!,
      name: match[4]!
    };
  }

  return {
    subscriptionId: match[1]!,
    resourceGroup: match[2]!,
    name: match[3]!
  };
}

export function buildGeneratedResourceId(
  type: GeneratedApplicationResourceType,
  subscriptionId: string,
  resourceGroup: string,
  name: string,
  parentName?: string
): string {
  const base = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers`;
  switch (type) {
    case 'azurerm_postgresql_flexible_server':
      return `${base}/Microsoft.DBforPostgreSQL/flexibleServers/${name}`;
    case 'azurerm_postgresql_flexible_server_firewall_rule':
      must(typeof parentName === 'string' && parentName.length > 0, 'parent-resource-required');
      return `${base}/Microsoft.DBforPostgreSQL/flexibleServers/${parentName}/firewallRules/${name}`;
    case 'azurerm_redis_cache':
      return `${base}/Microsoft.Cache/redis/${name}`;
    case 'azurerm_storage_account':
      return `${base}/Microsoft.Storage/storageAccounts/${name}`;
    case 'azurerm_storage_container':
      must(typeof parentName === 'string' && parentName.length > 0, 'parent-resource-required');
      return `${base}/Microsoft.Storage/storageAccounts/${parentName}/blobServices/default/containers/${name}`;
    case 'azurerm_servicebus_namespace':
      return `${base}/Microsoft.ServiceBus/namespaces/${name}`;
    case 'azurerm_servicebus_queue':
      must(typeof parentName === 'string' && parentName.length > 0, 'parent-resource-required');
      return `${base}/Microsoft.ServiceBus/namespaces/${parentName}/queues/${name}`;
    case 'azurerm_communication_service':
      return `${base}/Microsoft.Communication/communicationServices/${name}`;
    case 'azurerm_key_vault':
      return `${base}/Microsoft.KeyVault/vaults/${name}`;
    case 'azurerm_service_plan':
      return `${base}/Microsoft.Web/serverfarms/${name}`;
    case 'azurerm_linux_function_app':
      return `${base}/Microsoft.Web/sites/${name}`;
    default:
      throw new GeneratedApplicationResourceError('unsupported-generated-resource-type');
  }
}

export function generatedResourceValue(value: unknown, field: string): unknown {
  let selected = value;
  for (const part of field.split('.')) {
    if (Array.isArray(selected) && /^(?:0|[1-9][0-9]*)$/u.test(part)) selected = selected[Number(part)];
    else if (isRecord(selected) && Object.hasOwn(selected, part)) selected = selected[part];
    else return undefined;
  }
  return selected;
}

export function validateGeneratedResourceTarget(
  value: unknown,
  subscriptionId: string,
  ownerId?: string
): GeneratedApplicationResourceTarget {
  must(isRecord(value), 'target-shape');
  must(typeof value.type === 'string' && isGeneratedApplicationResourceType(value.type), 'unsupported-generated-resource-type');
  const typeStr = value.type;
  const contract = generatedApplicationResourceContracts[typeStr];

  const address = applicationPrivateAddress(value.address);
  must(address.type === typeStr && address.mode === 'managed', 'target-address');

  must(typeof value.resourceId === 'string', 'target-resource-id');
  const resourceId = value.resourceId;
  const parsed = parseGeneratedResourceId(typeStr, resourceId);
  must(parsed.subscriptionId.toLowerCase() === subscriptionId.toLowerCase(), 'target-resource-id');

  must(Array.isArray(value.actions) && value.actions.length > 0 && value.actions.length <= 3 &&
    new Set(value.actions).size === value.actions.length &&
    value.actions.every((act) => ['create', 'update', 'no-op'].includes(act)), 'resource-actions');

  must(isRecord(value.expected), 'target-expectations');
  const expectedKeys = Object.keys(value.expected);
  must(expectedKeys.length > 0 && expectedKeys.length <= 40, 'target-expectations');

  const allowedPaths = contract.paths as readonly string[];
  for (const key of expectedKeys) {
    must(allowedPaths.includes(key), 'target-expectations');
    const expected = value.expected[key];
    must(expected === null || typeof expected === 'boolean' || typeof expected === 'number' && Number.isFinite(expected) ||
      typeof expected === 'string' && expected.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(expected), 'target-expectations');
  }

  must(value.expected.name === parsed.name, 'target-name');

  if (value.expected.resource_group_name !== undefined) {
    must(value.expected.resource_group_name === parsed.resourceGroup, 'target-group');
  }

  if (ownerId && value.expected['tags.liftoff-repository-id'] !== undefined) {
    must(value.expected['tags.liftoff-repository-id'] === ownerId, 'target-ownership');
  }

  must(value.role === null || value.role === undefined, 'role-contract');
  must(value.runtime === null || value.runtime === undefined, 'runtime-contract');

  return {
    address: address.address,
    type: typeStr,
    resourceId,
    actions: value.actions as readonly GeneratedApplicationAction[],
    expected: value.expected as Readonly<Record<string, GeneratedApplicationScalar>>,
    role: null,
    runtime: null
  };
}
