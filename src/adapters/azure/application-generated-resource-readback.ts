import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import {
  type ApplicationPrivateObservation
} from '../../application/azure-activation/application-private-contracts.js';
import { ApplicationPrivateError, applicationPrivateAssert as must } from '../../application/azure-activation/application-private-errors.js';
import {
  ApplicationPrivateResourceReadbackError
} from './application-private-readback-errors.js';
import {
  applicationUuid
} from './application-provisioning.js';
import {
  azureArmUrl,
  type AzureArmBinding,
  type AzureArmResponse,
  type AzureArmTransport
} from './activation-rest.js';
import {
  generatedApplicationResourceContracts,
  isGeneratedApplicationResourceType,
  parseGeneratedResourceId,
  buildGeneratedResourceId,
  generatedResourceValue,
  type GeneratedApplicationResourceType,
  type GeneratedApplicationResourceTarget
} from '../../application/azure-activation/application-generated-resource-contracts.js';
import { readApplicationFunctionConfiguration } from './application-function-readback.js';

function object(value: unknown): Record<string, unknown> {
  must(isRecord(value), 'arm-readback-shape');
  return value;
}

function sameId(value: unknown, expected: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();
}

function recordedValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => entry === undefined ? null : recordedValues(entry));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, recordedValues(entry)]));
  return value;
}

function sanitizeArmBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeArmBody);
  if (isRecord(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (/password|secret|key|credential|connectionstring/iu.test(k)) {
        continue;
      }
      sanitized[k] = sanitizeArmBody(v);
    }
    return sanitized;
  }
  return value;
}

export interface GeneratedResourceReadbackOptions {
  target: GeneratedApplicationResourceTarget;
  verify: boolean;
  binding: AzureArmBinding;
  transport: AzureArmTransport;
  authorize(): Promise<void>;
  ownerId?: string;
  now?: () => number;
  signal?: AbortSignal;
  expectedState?: Record<string, unknown>;
}

export class GeneratedApplicationResourceReadbackError extends ApplicationPrivateResourceReadbackError {}

export class GeneratedApplicationResourceReader {
  constructor(private readonly options: {
    transport: AzureArmTransport;
    binding: AzureArmBinding;
    authorize(): Promise<void>;
    ownerId?: string;
    now?: () => number;
  }) {}

  private now(): string {
    return new Date(this.options.now?.() ?? Date.now()).toISOString();
  }

  async read(
    target: GeneratedApplicationResourceTarget,
    verify: boolean,
    signal?: AbortSignal,
    expectedState?: Record<string, unknown>
  ): Promise<ApplicationPrivateObservation> {
    await this.options.authorize();
    must(!signal?.aborted, 'readback-cancelled');

    must(isGeneratedApplicationResourceType(target.type), 'unsupported-generated-resource-type');
    const contract = generatedApplicationResourceContracts[target.type];

    const parsed = parseGeneratedResourceId(target.type, target.resourceId);
    must(sameId(parsed.subscriptionId, this.options.binding.subscriptionId), 'target-resource-id');

    azureArmUrl(target.resourceId, contract.api, this.options.binding.subscriptionId);

    const response: AzureArmResponse = await this.options.transport.request({
      method: 'GET',
      resourceId: target.resourceId,
      apiVersion: contract.api
    }, this.options.binding);

    const requestId = applicationUuid(response.requestId, 'Actual application GET request');

    try {
      return await this.decode(target, parsed, verify, response, requestId, signal, expectedState);
    } catch (error) {
      if (error instanceof ApplicationPrivateResourceReadbackError) throw error;
      throw new GeneratedApplicationResourceReadbackError(
        error instanceof ApplicationPrivateError ? error.code : 'arm-resource-readback-incomplete',
        {
          address: target.address,
          requestedResourceId: target.resourceId,
          readbackRequestId: requestId,
          status: response.status
        }
      );
    }
  }

  private async decode(
    target: GeneratedApplicationResourceTarget,
    parsed: ReturnType<typeof parseGeneratedResourceId>,
    verify: boolean,
    response: AzureArmResponse,
    requestId: string,
    signal?: AbortSignal,
    expectedState?: Record<string, unknown>
  ): Promise<ApplicationPrivateObservation> {
    const contract = generatedApplicationResourceContracts[target.type];

    if (response.status === 404) {
      must(
        !verify &&
          isRecord(response.data) &&
          isRecord(response.data.error) &&
          ['ResourceNotFound', 'ResourceGroupNotFound', 'NotFound'].includes(String(response.data.error.code)),
        'absence-unproven'
      );
      return {
        address: target.address,
        resourceId: target.resourceId,
        resourceType: contract.arm,
        exists: false,
        verified: false,
        readbackRequestId: requestId,
        observedAt: this.now(),
        values: {},
        privateDigest: canonicalSha256({
          resourceId: target.resourceId,
          exists: false,
          dependencies: []
        }),
        runtime: null,
        dependencies: []
      };
    }

    must(response.status === 200, 'arm-readback-failed');
    const value = object(response.data);
    must(isRecord(value.properties), 'arm-readback-shape');
    const properties = object(value.properties);

    must(
      sameId(value.id, target.resourceId) &&
        sameId(value.type, contract.arm) &&
        sameId(value.name, parsed.name),
      'arm-resource-identity'
    );

    if (contract.scopeKind === 'resource-group' && target.type !== 'azurerm_communication_service') {
      if (target.expected.location !== undefined) {
        must(sameId(value.location, String(target.expected.location)), 'arm-resource-identity');
      }
    }

    const values: Record<string, unknown> = {
      id: value.id,
      name: value.name
    };

    if (value.location !== undefined) {
      values.location = value.location;
    }
    if (parsed.resourceGroup) {
      values.resource_group_name = parsed.resourceGroup;
    }
    if (value.tags !== undefined) {
      values.tags = value.tags;
    }

    this.projectProperties(target.type, values, value, properties, parsed, target);
    const functionConfiguration = target.type === 'azurerm_linux_function_app'
      ? await readApplicationFunctionConfiguration({
        resourceId: target.resourceId, address: target.address, binding: this.options.binding,
        transport: this.options.transport, authorize: this.options.authorize, signal,
        ...(verify && expectedState ? { expectedState } : {})
      }) : null;
    if (functionConfiguration) Object.assign(values, functionConfiguration.values);

    for (const sensitiveKey of contract.sensitiveOutputs) {
      must(values[sensitiveKey] === undefined, 'sensitive-field-withheld');
    }

    if (verify) {
      for (const [field, expected] of Object.entries(target.expected)) {
        const actual = generatedResourceValue(values, field);
        must(actual === expected, 'independent-resource-readback');
      }

      this.verifyReadiness(target.type, properties, values);
    }

    const observedDependencies = await this.readDependencies(target.type, values, verify, signal);
    const dependencies = [...observedDependencies.dependencies, ...functionConfiguration?.dependencies ?? []];
    const directOwner = isRecord(value.tags) && typeof value.tags['liftoff-repository-id'] === 'string'
      ? value.tags['liftoff-repository-id'] : undefined;
    const ownership = directOwner ? {
      ownerId: directOwner, resourceId: target.resourceId, readbackRequestId: requestId, source: 'resource-tags' as const
    } : observedDependencies.ownership;
    if (this.options.ownerId !== undefined && ownership) {
      must(ownership?.ownerId === this.options.ownerId, 'resource-ownership');
    }
    const sanitizedBody = sanitizeArmBody(value);

    return {
      address: target.address,
      resourceId: String(value.id),
      resourceType: contract.arm,
      exists: true,
      verified: verify,
      readbackRequestId: requestId,
      observedAt: this.now(),
      values: recordedValues(values) as Record<string, unknown>,
      privateDigest: canonicalSha256({
        resourceId: String(value.id),
        body: sanitizedBody,
        ...(functionConfiguration ? { privateConfigurationDigest: functionConfiguration.privateDigest } : {}),
        dependencies: dependencies.map(({ readbackRequestId: _req, ...rest }) => rest)
      }),
      runtime: null,
      dependencies,
      ...(ownership ? { ownership } : {})
    };
  }

  private async readDependencies(
    type: GeneratedApplicationResourceType, values: Record<string, unknown>, verify: boolean, signal?: AbortSignal
  ): Promise<{ dependencies: ApplicationPrivateObservation['dependencies']; ownership?: ApplicationPrivateObservation['ownership'] }> {
    const requests: Array<{ resourceId: string; resourceType: string; apiVersion: string; ready: 'postgres' | 'provisioning' | 'identity' }> = [];
    const add = (value: unknown, resourceType: string, apiVersion: string, ready: 'postgres' | 'provisioning' | 'identity') => {
      must(typeof value === 'string' && value.startsWith(`/subscriptions/${this.options.binding.subscriptionId}/`), 'dependency-binding');
      azureArmUrl(value, apiVersion, this.options.binding.subscriptionId);
      requests.push({ resourceId: value, resourceType, apiVersion, ready });
    };
    if (type === 'azurerm_postgresql_flexible_server_firewall_rule') add(values.server_id, 'Microsoft.DBforPostgreSQL/flexibleServers', '2023-03-01-preview', 'postgres');
    if (type === 'azurerm_storage_container') add(values.storage_account_id, 'Microsoft.Storage/storageAccounts', '2023-05-01', 'provisioning');
    if (type === 'azurerm_servicebus_queue') add(values.namespace_id, 'Microsoft.ServiceBus/namespaces', '2022-10-01-preview', 'provisioning');
    if (type === 'azurerm_linux_function_app') {
      add(values.service_plan_id, 'Microsoft.Web/serverfarms', '2023-12-01', 'provisioning');
      const identities = generatedResourceValue(values, 'identity.0.identity_ids');
      if (identities !== undefined) {
        must(Array.isArray(identities) && identities.length <= 8, 'dependency-inventory');
        for (const identity of identities) add(identity, 'Microsoft.ManagedIdentity/userAssignedIdentities', '2023-01-31', 'identity');
      }
    }
    const dependencies: Array<ApplicationPrivateObservation['dependencies'][number]> = [];
    let ownership: ApplicationPrivateObservation['ownership'];
    for (const request of requests) {
      await this.options.authorize();
      must(!signal?.aborted, 'readback-cancelled');
      const response = await this.options.transport.request({
        method: 'GET', resourceId: request.resourceId, apiVersion: request.apiVersion
      }, this.options.binding);
      const requestId = applicationUuid(response.requestId, 'Actual dependency GET request');
      const observed = object(response.data), properties = object(observed.properties);
      must(response.status === 200 && sameId(observed.id, request.resourceId) && sameId(observed.type, request.resourceType), 'dependency-readback');
      if (verify) {
        must(request.ready === 'postgres' ? properties.state === 'Ready' :
          request.ready === 'identity' ? typeof properties.principalId === 'string' && typeof properties.clientId === 'string' &&
            properties.tenantId === this.options.binding.tenantId : properties.provisioningState === 'Succeeded', 'dependency-not-ready');
      }
      const owner = isRecord(observed.tags) ? observed.tags['liftoff-repository-id'] : undefined;
      if (this.options.ownerId !== undefined && owner !== undefined) must(owner === this.options.ownerId, 'dependency-ownership');
      if (typeof owner === 'string' && generatedApplicationResourceContracts[type].scopeKind !== 'resource-group') {
        ownership = { ownerId: owner, resourceId: request.resourceId, readbackRequestId: requestId, source: 'parent-tags' };
      }
      dependencies.push({
        resourceId: request.resourceId, resourceType: request.resourceType, readbackRequestId: requestId,
        ...(request.ready === 'identity' ? {
          principalId: applicationUuid(properties.principalId, 'Observed dependency principal'),
          clientId: applicationUuid(properties.clientId, 'Observed dependency client'),
          tenantId: applicationUuid(properties.tenantId, 'Observed dependency tenant')
        } : {})
      });
    }
    return { dependencies, ...(ownership ? { ownership } : {}) };
  }

  private projectProperties(
    type: GeneratedApplicationResourceType,
    values: Record<string, unknown>,
    body: Record<string, unknown>,
    properties: Record<string, unknown>,
    parsed: ReturnType<typeof parseGeneratedResourceId>,
    target: GeneratedApplicationResourceTarget
  ): void {
    switch (type) {
      case 'azurerm_postgresql_flexible_server': {
        const sku = body.sku !== undefined ? object(body.sku) : undefined;
        const storage = properties.storage !== undefined ? object(properties.storage) : undefined;
        values.version = properties.version;
        values.administrator_login = properties.administratorLogin;
        if (sku !== undefined) {
          const tier = sku.tier === 'Burstable' ? 'B' : sku.tier === 'GeneralPurpose' ? 'GP' : sku.tier === 'MemoryOptimized' ? 'MO' : null;
          must(tier && typeof sku.name === 'string' && /^Standard_[A-Za-z0-9_]+$/u.test(sku.name), 'postgres-sku-shape');
          values.sku_name = `${tier}_${sku.name}`;
        }
        if (storage?.storageSizeGB !== undefined) {
          must(Number.isSafeInteger(storage.storageSizeGB) && Number(storage.storageSizeGB) > 0, 'postgres-storage-shape');
          values.storage_mb = Number(storage.storageSizeGB) * 1024;
        }
        values.fqdn = properties.fullyQualifiedDomainName;
        if (properties.network !== undefined) {
          const access = object(properties.network).publicNetworkAccess;
          must(access === 'Enabled' || access === 'Disabled', 'postgres-network-shape');
          values.public_network_access_enabled = access === 'Enabled';
        }
        values.provisioning_state = properties.state ?? properties.provisioningState;
        break;
      }
      case 'azurerm_postgresql_flexible_server_firewall_rule': {
        values.server_id = buildGeneratedResourceId('azurerm_postgresql_flexible_server', parsed.subscriptionId, parsed.resourceGroup, parsed.parentName!);
        values.start_ip_address = properties.startIpAddress;
        values.end_ip_address = properties.endIpAddress;
        values.provisioning_state = properties.provisioningState;
        break;
      }
      case 'azurerm_redis_cache': {
        const sku = body.sku !== undefined ? object(body.sku) : (properties.sku !== undefined ? object(properties.sku) : undefined);
        if (sku !== undefined) {
          values.capacity = sku.capacity;
          values.family = sku.family;
          values.sku_name = sku.name;
        }
        values.minimum_tls_version = properties.minimumTlsVersion;
        values.hostname = properties.hostName;
        values.ssl_port = properties.sslPort;
        values.port = properties.port;
        values.provisioning_state = properties.provisioningState;
        break;
      }
      case 'azurerm_storage_account': {
        const sku = body.sku !== undefined ? object(body.sku) : undefined;
        const endpoints = properties.primaryEndpoints !== undefined ? object(properties.primaryEndpoints) : undefined;
        if (sku?.name !== undefined) {
          must(typeof sku.name === 'string' && /^(Standard|Premium)_(LRS|ZRS|GRS|RAGRS|GZRS|RAGZRS)$/u.test(sku.name), 'storage-sku-shape');
          const [tier, replication] = sku.name.split('_');
          if (sku.tier !== undefined) must(sku.tier === tier, 'storage-sku-shape');
          values.account_tier = tier;
          values.account_replication_type = replication;
        }
        values.min_tls_version = properties.minimumTlsVersion;
        if (properties.allowBlobPublicAccess !== undefined) {
          must(typeof properties.allowBlobPublicAccess === 'boolean', 'storage-public-access-shape');
          values.allow_nested_items_to_be_public = properties.allowBlobPublicAccess;
        }
        if (endpoints?.blob !== undefined) {
          values.primary_blob_endpoint = endpoints.blob;
        }
        values.primary_location = properties.primaryLocation;
        values.secondary_location = properties.secondaryLocation;
        values.provisioning_state = properties.provisioningState;
        break;
      }
      case 'azurerm_storage_container': {
        values.storage_account_id = buildGeneratedResourceId('azurerm_storage_account', parsed.subscriptionId, parsed.resourceGroup, parsed.parentName!);
        if (properties.publicAccess !== undefined) {
          must(['None', 'Blob', 'Container'].includes(String(properties.publicAccess)), 'container-public-access-shape');
          values.container_access_type = properties.publicAccess === 'None' ? 'private' : String(properties.publicAccess).toLowerCase();
        }
        values.has_immutability_policy = properties.hasImmutabilityPolicy;
        values.has_legal_hold = properties.hasLegalHold;
        break;
      }
      case 'azurerm_servicebus_namespace': {
        const sku = body.sku !== undefined ? object(body.sku) : undefined;
        if (sku?.name !== undefined) values.sku = sku.name;
        values.minimum_tls_version = properties.minimumTlsVersion;
        values.endpoint = properties.serviceBusEndpoint;
        values.provisioning_state = properties.provisioningState;
        break;
      }
      case 'azurerm_servicebus_queue': {
        values.namespace_id = buildGeneratedResourceId('azurerm_servicebus_namespace', parsed.subscriptionId, parsed.resourceGroup, parsed.parentName!);
        values.status = properties.status;
        break;
      }
      case 'azurerm_communication_service': {
        values.data_location = properties.dataLocation;
        values.hostname = properties.hostName;
        values.provisioning_state = properties.provisioningState;
        break;
      }
      case 'azurerm_key_vault': {
        const sku = properties.sku !== undefined ? object(properties.sku) : (body.sku !== undefined ? object(body.sku) : undefined);
        values.tenant_id = properties.tenantId;
        if (sku?.name !== undefined) values.sku_name = sku.name;
        values.rbac_authorization_enabled = properties.enableRbacAuthorization;
        values.vault_uri = properties.vaultUri;
        values.provisioning_state = properties.provisioningState;
        break;
      }
      case 'azurerm_service_plan': {
        const sku = body.sku !== undefined ? object(body.sku) : undefined;
        if (properties.reserved !== undefined) {
          must(typeof properties.reserved === 'boolean', 'serverfarm-os-shape');
          values.os_type = properties.reserved === true ? 'Linux' : 'Windows';
        }
        if (sku?.name !== undefined) values.sku_name = sku.name;
        values.provisioning_state = properties.provisioningState;
        break;
      }
      case 'azurerm_linux_function_app': {
        const identity = body.identity !== undefined ? object(body.identity) : undefined;
        const siteConfig = properties.siteConfig !== undefined ? object(properties.siteConfig) : undefined;
        values.service_plan_id = properties.serverFarmId;
        values.default_hostname = properties.defaultHostName;
        values.outbound_ip_addresses = properties.outboundIpAddresses;
        values.possible_outbound_ip_addresses = properties.possibleOutboundIpAddresses;
        if (identity !== undefined) {
          const userIdentities = identity.userAssignedIdentities !== undefined ? object(identity.userAssignedIdentities) : {};
          values.identity = [{
            type: identity.type,
            identity_ids: Object.keys(userIdentities)
          }];
        }
        if (siteConfig?.linuxFxVersion !== undefined) {
          must(typeof siteConfig.linuxFxVersion === 'string' && /^Python\|[0-9]+\.[0-9]+$/iu.test(siteConfig.linuxFxVersion), 'function-runtime-shape');
          const pyVersion = siteConfig.linuxFxVersion.slice('Python|'.length);
          values.site_config = [{
            application_stack: [{
              python_version: pyVersion
            }]
          }];
        }
        values.running_status = properties.state;
        values.provisioning_state = properties.provisioningState;
        break;
      }
    }
  }

  private verifyReadiness(
    type: GeneratedApplicationResourceType,
    properties: Record<string, unknown>,
    values: Record<string, unknown>
  ): void {
    switch (type) {
      case 'azurerm_postgresql_flexible_server': {
        must(properties.state === 'Ready', 'resource-not-ready');
        break;
      }
      case 'azurerm_postgresql_flexible_server_firewall_rule': {
        must(typeof properties.startIpAddress === 'string' && typeof properties.endIpAddress === 'string' &&
          (properties.provisioningState === undefined || properties.provisioningState === 'Succeeded'), 'resource-not-ready');
        break;
      }
      case 'azurerm_storage_container': {
        must(properties.publicAccess !== undefined, 'resource-not-ready');
        break;
      }
      case 'azurerm_servicebus_queue': {
        must(properties.status === 'Active', 'resource-not-ready');
        break;
      }
      case 'azurerm_linux_function_app': {
        must(properties.state === 'Running', 'resource-not-ready');
        if (properties.provisioningState !== undefined) {
          must(properties.provisioningState === 'Succeeded', 'resource-not-ready');
        }
        break;
      }
      default: {
        must(properties.provisioningState === 'Succeeded', 'resource-not-ready');
        break;
      }
    }
  }
}

export async function readGeneratedApplicationResource(
  options: GeneratedResourceReadbackOptions
): Promise<ApplicationPrivateObservation> {
  const reader = new GeneratedApplicationResourceReader({
    transport: options.transport,
    binding: options.binding,
    authorize: options.authorize,
    ownerId: options.ownerId,
    now: options.now
  });
  return reader.read(options.target, options.verify, options.signal, options.expectedState);
}
