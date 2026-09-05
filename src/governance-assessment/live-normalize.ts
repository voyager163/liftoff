import { containsSensitiveText, isRecord, sanitizeAssessmentText } from './sanitize.js';
import { LiveFailure } from './live-transport.js';
import { assessmentLimits, type AzureAssessmentBinding, type JsonValue } from './types.js';

type Decoder = (value: unknown) => JsonValue;
type Fields = Record<string, Decoder>;
const maxEntries = assessmentLimits.maxPages * 100;

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new LiveFailure('invalid-response', 'Required provider metadata was missing or malformed.');
  return value;
}

export function text(value: unknown): string {
  if (typeof value !== 'string') throw new LiveFailure('invalid-response', 'Required textual metadata was missing or malformed.');
  if (containsSensitiveText(value) ||
      /(?:https?|ftp|ssh):\/\/|\b(?:SharedAccessSignature|DefaultEndpointsProtocol|SharedAccessKey|InstrumentationKey|Endpoint|Server|Database|User\s*Id)\s*=/iu.test(value)) {
    throw new LiveFailure('sensitive-response', 'Sensitive or URL-bearing metadata was withheld before normalization.');
  }
  if (!value || value.length > 2048 || sanitizeAssessmentText(value, 2060) !== value) {
    throw new LiveFailure('invalid-response', 'Provider text was empty, oversized or contained unsafe control characters.');
  }
  return value;
}

export function id(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new LiveFailure('invalid-response', 'An expected numeric provider identity was unavailable.');
  }
  return value;
}

export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new LiveFailure('invalid-response', 'Expected boolean metadata was unavailable.');
  return value;
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new LiveFailure('invalid-response', 'Expected numeric metadata was unavailable.');
  }
  return value;
}

export function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > maxEntries) {
    throw new LiveFailure('invalid-response', 'Expected bounded array metadata was unavailable.');
  }
  return value;
}

export function sorted<T>(values: T[]): T[] {
  return values.sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function array(decode: Decoder): Decoder {
  return (value) => sorted(list(value).map(decode));
}

function nullable(decode: Decoder): Decoder {
  return (value) => value === null ? null : decode(value);
}

function enumeration(values: readonly string[]): Decoder {
  return (value) => {
    const entry = text(value);
    if (!values.includes(entry)) {
      throw new LiveFailure('unsupported-response', 'Unrecognized enforcement metadata prevents a complete normalized observation.');
    }
    return entry;
  };
}

function shape(fields: Fields, required: string[] = [], strict = false): Decoder {
  return (value) => {
    const input = record(value);
    if (required.some((key) => !Object.hasOwn(input, key))) {
      throw new LiveFailure('invalid-response', 'Required metadata fields were omitted by the provider.');
    }
    if (strict && Object.keys(input).some((key) => !Object.hasOwn(fields, key))) {
      throw new LiveFailure('unsupported-response', 'Unrecognized enforcement fields prevent a complete normalized observation.');
    }
    return Object.fromEntries(Object.entries(fields)
      .filter(([key]) => Object.hasOwn(input, key))
      .map(([key, decode]) => [key, decode(input[key])]));
  };
}

const strings = array(text);
const toggle = shape({ enabled: boolean }, ['enabled']);
const actor = shape({ id, login: text, slug: text }, ['id']);
const actors = shape({ users: array(actor), teams: array(actor), apps: array(actor) });
const checkContext = shape({ context: text, integration_id: nullable(number) }, ['context'], true);
const workflow = shape({ path: text, repository_id: id, ref: text, sha: text }, ['path', 'repository_id'], true);
const ruleParameters = shape({
  update_allows_fetch_and_merge: boolean,
  required_deployment_environments: strings,
  required_status_checks: array(checkContext),
  strict_required_status_checks_policy: boolean,
  do_not_enforce_on_create: boolean,
  dismiss_stale_reviews_on_push: boolean,
  require_code_owner_review: boolean,
  require_last_push_approval: boolean,
  required_approving_review_count: number,
  required_review_thread_resolution: boolean,
  allowed_merge_methods: strings,
  operator: text, pattern: text, negate: boolean, name: text,
  restricted_file_paths: strings, restricted_file_extensions: strings,
  max_file_path_length: number, max_file_size: number,
  workflows: array(workflow), required_workflows: array(workflow),
  code_scanning_tools: array(shape({
    tool: text, alerts_threshold: text, security_alerts_threshold: text
  }, ['tool', 'alerts_threshold', 'security_alerts_threshold'], true)),
  merge_method: text, grouping_strategy: text,
  check_response_timeout_minutes: number, max_entries_to_build: number,
  min_entries_to_merge: number, max_entries_to_merge: number,
  min_entries_to_merge_wait_minutes: number,
  automatic_review: boolean, review_on_push: boolean, review_draft_pull_requests: boolean
}, [], true);

export const normalizeRule = shape({
  type: enumeration([
    'creation', 'update', 'deletion', 'required_linear_history', 'merge_queue',
    'required_deployments', 'required_signatures', 'pull_request', 'required_status_checks',
    'non_fast_forward', 'commit_message_pattern', 'commit_author_email_pattern', 'committer_email_pattern',
    'branch_name_pattern', 'tag_name_pattern', 'file_path_restriction', 'max_file_path_length',
    'file_extension_restriction', 'max_file_size', 'workflows', 'required_workflows', 'code_scanning', 'copilot_code_review'
  ]),
  parameters: ruleParameters,
  ruleset_id: id, ruleset_source_type: text, ruleset_source: text
}, ['type'], true);

const patterns = shape({ include: strings, exclude: strings }, ['include', 'exclude'], true);
const repositoryPatterns = shape({
  include: strings, exclude: strings, protected: boolean
}, ['include', 'exclude'], true);
const propertyCondition = shape({
  name: text, source: text, property_values: strings
}, ['name', 'property_values'], true);

export const normalizeRuleset = shape({
  id, node_id: text, name: text,
  target: enumeration(['branch', 'tag', 'push']),
  enforcement: enumeration(['disabled', 'active', 'evaluate']),
  source_type: text, source: text,
  conditions: shape({
    ref_name: patterns,
    repository_name: repositoryPatterns,
    repository_id: shape({ repository_ids: array(id) }, ['repository_ids'], true),
    repository_property: shape({
      include: array(propertyCondition), exclude: array(propertyCondition)
    }, ['include', 'exclude'], true)
  }, [], true),
  bypass_actors: array(shape({
    actor_id: nullable(number), actor_type: text, bypass_mode: text
  }, ['actor_id', 'actor_type', 'bypass_mode'], true)),
  rules: array(normalizeRule)
}, ['id', 'name', 'target', 'enforcement', 'source_type', 'source', 'conditions', 'bypass_actors', 'rules']);

export const normalizeProtection = shape({
  required_status_checks: nullable(shape({
    strict: boolean, contexts: strings,
    checks: array(shape({ context: text, app_id: nullable(number) }, ['context', 'app_id']))
  }, ['strict', 'contexts'])),
  enforce_admins: toggle,
  required_pull_request_reviews: nullable(shape({
    dismissal_restrictions: actors,
    dismiss_stale_reviews: boolean, require_code_owner_reviews: boolean,
    required_approving_review_count: number, require_last_push_approval: boolean,
    bypass_pull_request_allowances: actors
  }, ['dismiss_stale_reviews', 'require_code_owner_reviews', 'required_approving_review_count'])),
  restrictions: nullable(actors),
  required_linear_history: toggle, allow_force_pushes: toggle, allow_deletions: toggle,
  block_creations: toggle, required_conversation_resolution: toggle,
  required_signatures: toggle, lock_branch: toggle, allow_fork_syncing: toggle
}, ['enforce_admins']);

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
export function uuid(value: unknown): string {
  const found = text(value);
  if (!uuidPattern.test(found)) throw new LiveFailure('unsafe-scope', 'A subscription or identity GUID was invalid.');
  return found;
}

function armId(value: unknown): string {
  const found = text(value);
  const parts = found.split('/');
  if (parts.length < 9 || parts.length % 2 !== 1 ||
      parts[0] !== '' || parts[1]!.toLowerCase() !== 'subscriptions' ||
      !uuidPattern.test(parts[2]!) || parts[3]!.toLowerCase() !== 'resourcegroups' ||
      parts[5]!.toLowerCase() !== 'providers' ||
      parts.slice(3).some((part) => !/^[A-Za-z0-9_.()-]+$/u.test(part) || part === '.' || part === '..')) {
    throw new LiveFailure('unsafe-scope', 'An ARM resource identity was not a complete safe resource path.');
  }
  return found;
}

const reference = shape({ id: armId }, ['id']);
const references = array(reference);
const addressSpace = shape({ addressPrefixes: strings });
const dnsSettings = shape({ enableProxy: boolean, servers: strings, requireProxyForNetworkRules: boolean });
const subnetFields: Fields = {
  provisioningState: text, addressPrefix: text, addressPrefixes: strings,
  defaultOutboundAccess: boolean, sharingScope: text,
  privateEndpointNetworkPolicies: text, privateLinkServiceNetworkPolicies: text,
  natGateway: nullable(reference), routeTable: nullable(reference), networkSecurityGroup: nullable(reference),
  serviceEndpoints: array(shape({ service: text, locations: strings }, ['service'])),
  serviceEndpointPolicies: references,
  delegations: array(shape({
    name: text, properties: shape({ serviceName: text, actions: strings }, ['serviceName'])
  }, ['name', 'properties']))
};
const subnet = shape(subnetFields);
const resourceChild = (properties: Decoder) => shape({ id: armId, name: text, properties }, ['properties']);
const route = shape({
  provisioningState: text, addressPrefix: text, nextHopType: text,
  nextHopIpAddress: text, hasBgpOverride: boolean
});
const securityRule = shape({
  provisioningState: text, protocol: text, access: text, priority: number, direction: text,
  sourcePortRange: text, sourcePortRanges: strings, destinationPortRange: text, destinationPortRanges: strings,
  sourceAddressPrefix: text, sourceAddressPrefixes: strings,
  destinationAddressPrefix: text, destinationAddressPrefixes: strings,
  sourceApplicationSecurityGroups: references, destinationApplicationSecurityGroups: references
});
const privateConnections = array(shape({
  id: armId,
  properties: shape({
    provisioningState: text, privateEndpoint: reference,
    privateLinkServiceConnectionState: shape({ status: text, actionsRequired: text }, ['status'])
  }, ['privateLinkServiceConnectionState'])
}, ['properties']));
const ipConfiguration = resourceChild(shape({
  provisioningState: text, privateIPAddress: text, publicIPAddress: reference, subnet: reference
}));
const networkRule = shape({
  name: text, protocols: strings, sourceAddresses: strings, destinationAddresses: strings,
  sourceIpGroups: strings, destinationIpGroups: strings, destinationPorts: strings, destinationFqdns: strings
});
const applicationRule = shape({
  name: text, sourceAddresses: strings, sourceIpGroups: strings, targetFqdns: strings, fqdnTags: strings,
  protocols: array(shape({ protocolType: text, port: number }, ['protocolType', 'port']))
});
const ruleCollection = (decode: Decoder) => resourceChild(shape({
  priority: number, action: shape({ type: text }, ['type']), rules: array(decode)
}, ['priority', 'action', 'rules']));

const resourceDefinitions: Record<string, { type: string; apiVersion: string; properties: Decoder }> = {
  'microsoft.storage/storageaccounts': {
    type: 'Microsoft.Storage/storageAccounts', apiVersion: '2023-05-01',
    properties: shape({
      provisioningState: text, publicNetworkAccess: text,
      allowBlobPublicAccess: boolean, allowSharedKeyAccess: boolean,
      supportsHttpsTrafficOnly: boolean, minimumTlsVersion: text,
      defaultToOAuthAuthentication: boolean, allowCrossTenantReplication: boolean,
      isHnsEnabled: boolean, isNfsV3Enabled: boolean,
      networkAcls: shape({
        defaultAction: text, bypass: text,
        ipRules: array(shape({ action: text, value: text }, ['value'])),
        virtualNetworkRules: array(shape({ action: text, id: armId, state: text }, ['id'])),
        resourceAccessRules: array(shape({ tenantId: uuid, resourceId: armId }, ['tenantId', 'resourceId']))
      }),
      encryption: shape({
        keySource: text, requireInfrastructureEncryption: boolean,
        services: shape(Object.fromEntries(['blob', 'file', 'queue', 'table'].map((service) =>
          [service, shape({ enabled: boolean, keyType: text })])))
      }),
      privateEndpointConnections: privateConnections
    })
  },
  'microsoft.network/virtualnetworks': {
    type: 'Microsoft.Network/virtualNetworks', apiVersion: '2024-05-01',
    properties: shape({
      provisioningState: text, addressSpace, dhcpOptions: shape({ dnsServers: strings }),
      enableDdosProtection: boolean, ddosProtectionPlan: reference, flowTimeoutInMinutes: number,
      encryption: shape({ enabled: boolean, enforcement: text }),
      subnets: array(resourceChild(subnet)),
      virtualNetworkPeerings: array(resourceChild(shape({
        allowVirtualNetworkAccess: boolean, allowForwardedTraffic: boolean,
        allowGatewayTransit: boolean, useRemoteGateways: boolean,
        remoteVirtualNetwork: reference, remoteAddressSpace: addressSpace, peeringState: text
      })))
    })
  },
  'microsoft.network/virtualnetworks/subnets': {
    type: 'Microsoft.Network/virtualNetworks/subnets', apiVersion: '2024-05-01', properties: subnet
  },
  'microsoft.network/networksecuritygroups': {
    type: 'Microsoft.Network/networkSecurityGroups', apiVersion: '2024-05-01',
    properties: shape({
      provisioningState: text, securityRules: array(resourceChild(securityRule)),
      defaultSecurityRules: array(resourceChild(securityRule))
    })
  },
  'microsoft.network/routetables': {
    type: 'Microsoft.Network/routeTables', apiVersion: '2024-05-01',
    properties: shape({ provisioningState: text, disableBgpRoutePropagation: boolean, routes: array(resourceChild(route)) })
  },
  'microsoft.network/routetables/routes': {
    type: 'Microsoft.Network/routeTables/routes', apiVersion: '2024-05-01', properties: route
  },
  'microsoft.network/natgateways': {
    type: 'Microsoft.Network/natGateways', apiVersion: '2024-05-01',
    properties: shape({
      provisioningState: text, idleTimeoutInMinutes: number, publicIpAddresses: references,
      publicIpPrefixes: references, subnets: references
    })
  },
  'microsoft.network/azurefirewalls': {
    type: 'Microsoft.Network/azureFirewalls', apiVersion: '2024-05-01',
    properties: shape({
      provisioningState: text, threatIntelMode: text, firewallPolicy: reference, virtualHub: reference,
      dnsSettings, ipConfigurations: array(ipConfiguration), managementIpConfiguration: ipConfiguration,
      applicationRuleCollections: array(ruleCollection(applicationRule)),
      networkRuleCollections: array(ruleCollection(networkRule))
    })
  },
  'microsoft.network/firewallpolicies': {
    type: 'Microsoft.Network/firewallPolicies', apiVersion: '2024-05-01',
    properties: shape({ provisioningState: text, threatIntelMode: text, dnsSettings, basePolicy: reference })
  },
  'microsoft.network/publicipaddresses': {
    type: 'Microsoft.Network/publicIPAddresses', apiVersion: '2024-05-01',
    properties: shape({
      provisioningState: text, publicIPAllocationMethod: text, publicIPAddressVersion: text,
      ipAddress: text, publicIPPrefix: reference, idleTimeoutInMinutes: number,
      dnsSettings: shape({ domainNameLabel: text, fqdn: text, reverseFqdn: text })
    })
  },
  'microsoft.network/publicipprefixes': {
    type: 'Microsoft.Network/publicIPPrefixes', apiVersion: '2024-05-01',
    properties: shape({ provisioningState: text, publicIPAddressVersion: text, prefixLength: number, ipPrefix: text })
  },
  'microsoft.network/privateendpoints': {
    type: 'Microsoft.Network/privateEndpoints', apiVersion: '2024-05-01',
    properties: shape({
      provisioningState: text, subnet: reference,
      privateLinkServiceConnections: array(resourceChild(shape({
        privateLinkServiceId: armId, groupIds: strings,
        privateLinkServiceConnectionState: shape({ status: text, actionsRequired: text }, ['status'])
      }, ['privateLinkServiceId']))),
      customDnsConfigs: array(shape({ fqdn: text, ipAddresses: strings }, ['fqdn', 'ipAddresses']))
    })
  },
  'microsoft.network/privatednszones': {
    type: 'Microsoft.Network/privateDnsZones', apiVersion: '2020-06-01',
    properties: shape({
      provisioningState: text, numberOfRecordSets: number, maxNumberOfRecordSets: number,
      numberOfVirtualNetworkLinks: number, numberOfVirtualNetworkLinksWithRegistration: number
    })
  },
  'microsoft.network/privatednszones/virtualnetworklinks': {
    type: 'Microsoft.Network/privateDnsZones/virtualNetworkLinks', apiVersion: '2020-06-01',
    properties: shape({
      provisioningState: text, registrationEnabled: boolean, virtualNetwork: reference,
      virtualNetworkLinkState: text, resolutionPolicy: text
    })
  },
  'microsoft.managedidentity/userassignedidentities': {
    type: 'Microsoft.ManagedIdentity/userAssignedIdentities', apiVersion: '2023-01-31',
    properties: shape({ tenantId: uuid, principalId: uuid, clientId: uuid })
  },
  'github.network/networksettings': {
    type: 'GitHub.Network/networkSettings', apiVersion: '2024-04-02',
    properties: shape({
      provisioningState: text, subnetId: armId,
      businessId: (value) => typeof value === 'number' ? number(value) : text(value)
    })
  }
};

export interface ValidatedAzureBinding extends AzureAssessmentBinding {
  url: string;
  namespace: string;
}

export function azureBinding(value: AzureAssessmentBinding, environments: readonly string[]): ValidatedAzureBinding {
  const subscriptionId = uuid(value.subscriptionId);
  const resourceId = armId(value.resourceId);
  const parts = resourceId.split('/');
  const definition = resourceDefinitions[text(value.resourceType).toLowerCase()];
  const actualType = [parts[6], ...parts.slice(7).filter((_, index) => index % 2 === 0)].join('/');
  if (!definition || actualType.toLowerCase() !== value.resourceType.toLowerCase() ||
      parts[2]!.toLowerCase() !== subscriptionId.toLowerCase() ||
      !['dev', 'staging', 'prod'].includes(value.environment) || !environments.includes(value.environment) ||
      !['state', 'application', 'runner-network'].includes(value.role)) {
    throw new LiveFailure('unsafe-azure-scope', 'The resource type, subscription, environment or role did not match an explicit allowlisted binding.');
  }
  const namespace = definition.type.split('/')[0]!;
  return {
    subscriptionId, resourceId, resourceType: definition.type, environment: value.environment, role: value.role,
    namespace,
    url: `https://management.azure.com${resourceId}?api-version=${definition.apiVersion}`
  };
}

export function normalizeResource(value: unknown, binding: ValidatedAzureBinding): JsonValue {
  const input = record(value);
  if (armId(input.id).toLowerCase() !== binding.resourceId.toLowerCase() ||
      text(input.type).toLowerCase() !== binding.resourceType.toLowerCase()) {
    throw new LiveFailure('scope-mismatch', 'The ARM resource response did not match the exact requested resource identity and type.');
  }
  const properties = record(resourceDefinitions[binding.resourceType.toLowerCase()]!.properties(input.properties));
  if (Object.keys(properties).length === 0) {
    throw new LiveFailure('invalid-response', 'No allowlisted resource configuration was present in the ARM response.');
  }
  if (input.identity !== undefined && input.identity !== null) {
    const identity = record(input.identity);
    const normalized = record(shape({ type: text, principalId: uuid, tenantId: uuid }, ['type'])(identity));
    if (identity.userAssignedIdentities !== undefined) {
      normalized.userAssignedIdentities = sorted(Object.entries(record(identity.userAssignedIdentities))
        .map(([key, entry]) => ({
          id: armId(key), ...record(shape({ principalId: uuid, clientId: uuid })(entry))
        })));
    }
    properties.identity = normalized;
  }
  return {
    subscriptionId: binding.subscriptionId, environment: binding.environment,
    resourceId: binding.resourceId, resourceType: binding.resourceType, role: binding.role,
    properties: properties as Record<string, JsonValue>,
    sku: input.sku === undefined || input.sku === null ? null
      : shape({ name: text, tier: text, size: text, family: text, capacity: number })(input.sku)
  };
}
