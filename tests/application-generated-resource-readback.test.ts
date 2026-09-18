import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import { parseHcl, object } from '../src/adapters/hcl/semantic.js';
import type {
  AzureArmBinding,
  AzureArmRequest,
  AzureArmResponse,
  AzureArmTransport
} from '../src/adapters/azure/activation-rest.js';
import {
  generatedApplicationResourceContracts,
  isGeneratedApplicationResourceType,
  parseGeneratedResourceId,
  buildGeneratedResourceId,
  validateGeneratedResourceTarget,
  type GeneratedApplicationResourceType,
  type GeneratedApplicationResourceTarget
} from '../src/application/azure-activation/application-generated-resource-contracts.js';
import {
  GeneratedApplicationResourceReader,
  GeneratedApplicationResourceReadbackError,
  readGeneratedApplicationResource
} from '../src/adapters/azure/application-generated-resource-readback.js';

const subscriptionId = '11111111-2222-4333-8444-555555555555';
const tenantId = '66666666-7777-4888-8999-000000000001';
const principalId = '88888888-9999-4aaa-8bbb-cccccccccccc';
const binding: AzureArmBinding = { subscriptionId, tenantId, principalId };
const region = 'eastus';
const resourceGroup = 'rg-liftoff-test';
const ownerId = 'liftoff-repo-42';

function mockTransport(
  handler: (request: AzureArmRequest) => AzureArmResponse | Promise<AzureArmResponse>,
  dependencies: Readonly<Record<string, AzureArmResponse>> = {}
) {
  const requests: AzureArmRequest[] = [];
  const transport: AzureArmTransport = {
    request: async (request: AzureArmRequest, reqBinding: AzureArmBinding) => {
      expect(reqBinding).toEqual(binding);
      requests.push(structuredClone(request));
      return dependencies[request.resourceId] ?? handler(request);
    }
  };
  return { transport, requests };
}

describe('generated application resource contracts and discovery', () => {
  it('discovers all 11 additional resource families from actual generator outputs', async () => {
    // 1. Standard API project
    const standardPlan = buildProjectPlan({
      projectName: 'Standard Inventory Test',
      projectType: 'standard',
      apiStack: 'node-fastify',
      cloud: 'azure',
      environments: ['dev']
    }, { requireProjectName: true });
    const standardArtifacts = buildArtifacts(standardPlan);
    const standardMain = standardArtifacts.find((a) => a.pathParts.join('/').endsWith('modules/application/main.tf'))!;
    const standardDoc = await parseHcl(standardMain.content, 'main.tf');
    const standardResources = object(standardDoc.resource, 'resources');

    // Standard includes 8 additional resource families
    const expectedStandardTypes = [
      'azurerm_postgresql_flexible_server',
      'azurerm_postgresql_flexible_server_firewall_rule',
      'azurerm_redis_cache',
      'azurerm_storage_account',
      'azurerm_storage_container',
      'azurerm_servicebus_namespace',
      'azurerm_servicebus_queue',
      'azurerm_communication_service',
      'azurerm_key_vault'
    ];
    for (const type of expectedStandardTypes) {
      expect(standardResources[type], `Standard missing ${type}`).toBeDefined();
      expect(isGeneratedApplicationResourceType(type)).toBe(true);
    }

    // 2. GenAI project with RAG pattern
    const genAiPlan = buildProjectPlan({
      projectName: 'GenAI Inventory Test',
      projectType: 'genai',
      pattern: 'rag',
      cloud: 'azure',
      environments: ['dev']
    }, { requireProjectName: true });
    const genAiArtifacts = buildArtifacts(genAiPlan);
    const genAiMain = genAiArtifacts.find((a) => a.pathParts.join('/').endsWith('modules/application/main.tf'))!;
    const genAiDoc = await parseHcl(genAiMain.content, 'main.tf');
    const genAiResources = object(genAiDoc.resource, 'resources');

    // GenAI also includes Azure Functions resources
    const expectedGenAiTypes = [
      ...expectedStandardTypes,
      'azurerm_service_plan',
      'azurerm_linux_function_app'
    ];
    for (const type of expectedGenAiTypes) {
      expect(genAiResources[type], `GenAI missing ${type}`).toBeDefined();
      expect(isGeneratedApplicationResourceType(type)).toBe(true);
    }

    // Total extra emitted families is exactly 11
    expect(Object.keys(generatedApplicationResourceContracts)).toHaveLength(11);
  });

  it('rejects unsupported resource types such as storage lifecycle policies', () => {
    expect(isGeneratedApplicationResourceType('azurerm_storage_management_policy')).toBe(false);
    expect(isGeneratedApplicationResourceType('azurerm_virtual_network')).toBe(false);
    expect(isGeneratedApplicationResourceType('azurerm_cognitive_account')).toBe(false);

    expect(() => parseGeneratedResourceId('azurerm_storage_management_policy' as any, '/subscriptions/test'))
      .toThrow(/unsupported-generated-resource-type/);

    expect(() => validateGeneratedResourceTarget({
      address: 'azurerm_storage_management_policy.test',
      type: 'azurerm_storage_management_policy',
      resourceId: '/sub',
      actions: ['create'],
      expected: { name: 'test' }
    }, subscriptionId)).toThrow(/unsupported-generated-resource-type/);
  });

  it('parses and constructs canonical resource IDs for root and child resources', () => {
    // Root resource
    const serverId = buildGeneratedResourceId('azurerm_postgresql_flexible_server', subscriptionId, resourceGroup, 'psql-main');
    expect(serverId).toBe(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-main`);
    const parsedServer = parseGeneratedResourceId('azurerm_postgresql_flexible_server', serverId);
    expect(parsedServer).toEqual({ subscriptionId, resourceGroup, name: 'psql-main' });

    // Child resource: firewall rule
    const ruleId = buildGeneratedResourceId('azurerm_postgresql_flexible_server_firewall_rule', subscriptionId, resourceGroup, 'AllowAzureServices', 'psql-main');
    expect(ruleId).toBe(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-main/firewallRules/AllowAzureServices`);
    const parsedRule = parseGeneratedResourceId('azurerm_postgresql_flexible_server_firewall_rule', ruleId);
    expect(parsedRule).toEqual({ subscriptionId, resourceGroup, parentName: 'psql-main', name: 'AllowAzureServices' });

    // Child resource: storage container
    const containerId = buildGeneratedResourceId('azurerm_storage_container', subscriptionId, resourceGroup, 'documents', 'stmain');
    expect(containerId).toBe(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/stmain/blobServices/default/containers/documents`);
    const parsedContainer = parseGeneratedResourceId('azurerm_storage_container', containerId);
    expect(parsedContainer).toEqual({ subscriptionId, resourceGroup, parentName: 'stmain', name: 'documents' });

    // Child resource: service bus queue
    const queueId = buildGeneratedResourceId('azurerm_servicebus_queue', subscriptionId, resourceGroup, 'events', 'sb-main');
    expect(queueId).toBe(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ServiceBus/namespaces/sb-main/queues/events`);
    const parsedQueue = parseGeneratedResourceId('azurerm_servicebus_queue', queueId);
    expect(parsedQueue).toEqual({ subscriptionId, resourceGroup, parentName: 'sb-main', name: 'events' });
  });
});

describe('readback adapter for all 11 generated resource families', () => {
  const defaultAuth = async () => {};

  it('observes azurerm_postgresql_flexible_server with strict property projection and sensitive withholding', async () => {
    const id = buildGeneratedResourceId('azurerm_postgresql_flexible_server', subscriptionId, resourceGroup, 'psql-main');
    const target: GeneratedApplicationResourceTarget = {
      address: 'module.application.azurerm_postgresql_flexible_server.main',
      type: 'azurerm_postgresql_flexible_server',
      resourceId: id,
      actions: ['create'],
      expected: {
        name: 'psql-main',
        location: region,
        resource_group_name: resourceGroup,
        version: '16',
        administrator_login: 'liftoffadmin',
        storage_mb: 32768,
        sku_name: 'B_Standard_B1ms',
        'tags.liftoff-repository-id': ownerId
      }
    };
    validateGeneratedResourceTarget(target, subscriptionId, ownerId);

    const requestId = randomUUID();
    const { transport, requests } = mockTransport(() => ({
      status: 200,
      requestId,
      data: {
        id,
        name: 'psql-main',
        type: 'Microsoft.DBforPostgreSQL/flexibleServers',
        location: region,
        tags: { 'liftoff-repository-id': ownerId },
        sku: { name: 'Standard_B1ms', tier: 'Burstable' },
        properties: {
          version: '16',
          administratorLogin: 'liftoffadmin',
          administratorPassword: 'SECRET_PASSWORD_SHOULD_NEVER_BE_PROJECTED',
          storage: { storageSizeGB: 32 },
          fullyQualifiedDomainName: 'psql-main.postgres.database.azure.com',
          state: 'Ready',
          network: { publicNetworkAccess: 'Enabled' }
        }
      }
    }));

    // Pre-apply observation (verify: false)
    const before = await readGeneratedApplicationResource({
      target,
      verify: false,
      binding,
      transport,
      authorize: defaultAuth
    });
    expect(before.exists).toBe(true);
    expect(before.verified).toBe(false);
    expect(before.readbackRequestId).toBe(requestId);
    expect(before.values.administrator_password).toBeUndefined();
    expect(before.values.version).toBe('16');
    expect(before.values.storage_mb).toBe(32768);

    // Post-apply verification (verify: true)
    const after = await readGeneratedApplicationResource({
      target,
      verify: true,
      binding,
      transport,
      authorize: defaultAuth
    });
    expect(after.exists).toBe(true);
    expect(after.verified).toBe(true);
    expect(after.values.administrator_password).toBeUndefined();
    expect(after.values.fqdn).toBe('psql-main.postgres.database.azure.com');
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('observes azurerm_postgresql_flexible_server_firewall_rule and binds dependency', async () => {
    const serverId = buildGeneratedResourceId('azurerm_postgresql_flexible_server', subscriptionId, resourceGroup, 'psql-main');
    const id = buildGeneratedResourceId('azurerm_postgresql_flexible_server_firewall_rule', subscriptionId, resourceGroup, 'AllowAzureServices', 'psql-main');
    const target: GeneratedApplicationResourceTarget = {
      address: 'module.application.azurerm_postgresql_flexible_server_firewall_rule.azure_services',
      type: 'azurerm_postgresql_flexible_server_firewall_rule',
      resourceId: id,
      actions: ['create'],
      expected: {
        name: 'AllowAzureServices',
        server_id: serverId,
        start_ip_address: '0.0.0.0',
        end_ip_address: '0.0.0.0'
      }
    };
    validateGeneratedResourceTarget(target, subscriptionId);

    const requestId = randomUUID(), parentRequestId = randomUUID();
    const { transport } = mockTransport(() => ({
      status: 200,
      requestId,
      data: {
        id,
        name: 'AllowAzureServices',
        type: 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules',
        properties: {
          startIpAddress: '0.0.0.0',
          endIpAddress: '0.0.0.0'
        }
      }
    }), {
      [serverId]: { status: 200, requestId: parentRequestId, data: {
        id: serverId, name: 'psql-main', type: 'Microsoft.DBforPostgreSQL/flexibleServers',
        properties: { state: 'Ready' }
      } }
    });

    const result = await readGeneratedApplicationResource({
      target,
      verify: true,
      binding,
      transport,
      authorize: defaultAuth
    });
    expect(result.exists).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.dependencies).toEqual([
      {
        resourceId: serverId,
        resourceType: 'Microsoft.DBforPostgreSQL/flexibleServers',
        readbackRequestId: parentRequestId
      }
    ]);
  });

  it('observes azurerm_redis_cache and withholds access keys', async () => {
    const id = buildGeneratedResourceId('azurerm_redis_cache', subscriptionId, resourceGroup, 'redis-main');
    const target: GeneratedApplicationResourceTarget = {
      address: 'module.application.azurerm_redis_cache.main',
      type: 'azurerm_redis_cache',
      resourceId: id,
      actions: ['create'],
      expected: {
        name: 'redis-main',
        location: region,
        resource_group_name: resourceGroup,
        capacity: 0,
        family: 'C',
        sku_name: 'Basic',
        minimum_tls_version: '1.2',
        'tags.liftoff-repository-id': ownerId
      }
    };
    validateGeneratedResourceTarget(target, subscriptionId, ownerId);

    const requestId = randomUUID();
    const { transport } = mockTransport(() => ({
      status: 200,
      requestId,
      data: {
        id,
        name: 'redis-main',
        type: 'Microsoft.Cache/redis',
        location: region,
        tags: { 'liftoff-repository-id': ownerId },
        properties: {
          provisioningState: 'Succeeded',
          sku: { capacity: 0, family: 'C', name: 'Basic' },
          minimumTlsVersion: '1.2',
          hostName: 'redis-main.redis.cache.windows.net',
          sslPort: 6380,
          port: 6379,
          primaryKey: 'SENSITIVE_KEY_NEVER_EXPOSED'
        }
      }
    }));

    const result = await readGeneratedApplicationResource({
      target,
      verify: true,
      binding,
      transport,
      authorize: defaultAuth
    });
    expect(result.exists).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.values.primary_access_key).toBeUndefined();
    expect(result.values.secondary_access_key).toBeUndefined();
    expect(result.values.hostname).toBe('redis-main.redis.cache.windows.net');
    expect(result.values.ssl_port).toBe(6380);
  });

  it('observes azurerm_storage_account and withholds storage keys', async () => {
    const id = buildGeneratedResourceId('azurerm_storage_account', subscriptionId, resourceGroup, 'stmain');
    const target: GeneratedApplicationResourceTarget = {
      address: 'module.application.azurerm_storage_account.main',
      type: 'azurerm_storage_account',
      resourceId: id,
      actions: ['create'],
      expected: {
        name: 'stmain',
        location: region,
        resource_group_name: resourceGroup,
        account_tier: 'Standard',
        account_replication_type: 'LRS',
        min_tls_version: 'TLS1_2',
        allow_nested_items_to_be_public: false,
        'tags.liftoff-repository-id': ownerId
      }
    };
    validateGeneratedResourceTarget(target, subscriptionId, ownerId);

    const requestId = randomUUID();
    const { transport } = mockTransport(() => ({
      status: 200,
      requestId,
      data: {
        id,
        name: 'stmain',
        type: 'Microsoft.Storage/storageAccounts',
        location: region,
        tags: { 'liftoff-repository-id': ownerId },
        sku: { name: 'Standard_LRS', tier: 'Standard' },
        properties: {
          provisioningState: 'Succeeded',
          minimumTlsVersion: 'TLS1_2',
          allowBlobPublicAccess: false,
          primaryEndpoints: { blob: 'https://stmain.blob.core.windows.net/' },
          primaryLocation: region,
          primaryAccessKey: 'STORAGE_KEY_NEVER_EXPOSED'
        }
      }
    }));

    const result = await readGeneratedApplicationResource({
      target,
      verify: true,
      binding,
      transport,
      authorize: defaultAuth
    });
    expect(result.exists).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.values.primary_access_key).toBeUndefined();
    expect(result.values.primary_blob_endpoint).toBe('https://stmain.blob.core.windows.net/');
  });

  it('observes azurerm_storage_container and binds storage account dependency', async () => {
    const storageId = buildGeneratedResourceId('azurerm_storage_account', subscriptionId, resourceGroup, 'stmain');
    const id = buildGeneratedResourceId('azurerm_storage_container', subscriptionId, resourceGroup, 'documents', 'stmain');
    const target: GeneratedApplicationResourceTarget = {
      address: 'module.application.azurerm_storage_container.documents',
      type: 'azurerm_storage_container',
      resourceId: id,
      actions: ['create'],
      expected: {
        name: 'documents',
        storage_account_id: storageId,
        container_access_type: 'private'
      }
    };
    validateGeneratedResourceTarget(target, subscriptionId);

    const requestId = randomUUID(), parentRequestId = randomUUID();
    const { transport } = mockTransport(() => ({
      status: 200,
      requestId,
      data: {
        id,
        name: 'documents',
        type: 'Microsoft.Storage/storageAccounts/blobServices/containers',
        properties: {
          publicAccess: 'None',
          hasImmutabilityPolicy: false,
          hasLegalHold: false
        }
      }
    }), {
      [storageId]: { status: 200, requestId: parentRequestId, data: {
        id: storageId, name: 'stmain', type: 'Microsoft.Storage/storageAccounts',
        properties: { provisioningState: 'Succeeded' }
      } }
    });

    const result = await readGeneratedApplicationResource({
      target,
      verify: true,
      binding,
      transport,
      authorize: defaultAuth
    });
    expect(result.exists).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.values.container_access_type).toBe('private');
    expect(result.dependencies).toEqual([
      {
        resourceId: storageId,
        resourceType: 'Microsoft.Storage/storageAccounts',
        readbackRequestId: parentRequestId
      }
    ]);
  });

  it('observes azurerm_servicebus_namespace and withholds connection strings', async () => {
    const id = buildGeneratedResourceId('azurerm_servicebus_namespace', subscriptionId, resourceGroup, 'sb-main');
    const target: GeneratedApplicationResourceTarget = {
      address: 'module.application.azurerm_servicebus_namespace.main',
      type: 'azurerm_servicebus_namespace',
      resourceId: id,
      actions: ['create'],
      expected: {
        name: 'sb-main',
        location: region,
        resource_group_name: resourceGroup,
        sku: 'Standard',
        minimum_tls_version: '1.2',
        'tags.liftoff-repository-id': ownerId
      }
    };
    validateGeneratedResourceTarget(target, subscriptionId, ownerId);

    const requestId = randomUUID();
    const { transport } = mockTransport(() => ({
      status: 200,
      requestId,
      data: {
        id,
        name: 'sb-main',
        type: 'Microsoft.ServiceBus/namespaces',
        location: region,
        tags: { 'liftoff-repository-id': ownerId },
        sku: { name: 'Standard' },
        properties: {
          provisioningState: 'Succeeded',
          minimumTlsVersion: '1.2',
          serviceBusEndpoint: 'https://sb-main.servicebus.windows.net:443/'
        }
      }
    }));

    const result = await readGeneratedApplicationResource({
      target,
      verify: true,
      binding,
      transport,
      authorize: defaultAuth
    });
    expect(result.exists).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.values.default_primary_connection_string).toBeUndefined();
    expect(result.values.endpoint).toBe('https://sb-main.servicebus.windows.net:443/');
  });

  it('observes azurerm_servicebus_queue and binds namespace dependency', async () => {
    const namespaceId = buildGeneratedResourceId('azurerm_servicebus_namespace', subscriptionId, resourceGroup, 'sb-main');
    const id = buildGeneratedResourceId('azurerm_servicebus_queue', subscriptionId, resourceGroup, 'events', 'sb-main');
    const target: GeneratedApplicationResourceTarget = {
      address: 'module.application.azurerm_servicebus_queue.events',
      type: 'azurerm_servicebus_queue',
      resourceId: id,
      actions: ['create'],
      expected: {
        name: 'events',
        namespace_id: namespaceId
      }
    };
    validateGeneratedResourceTarget(target, subscriptionId);

    const requestId = randomUUID(), parentRequestId = randomUUID();
    const { transport } = mockTransport(() => ({
      status: 200,
      requestId,
      data: {
        id,
        name: 'events',
        type: 'Microsoft.ServiceBus/namespaces/queues',
        properties: {
          status: 'Active'
        }
      }
    }), {
      [namespaceId]: { status: 200, requestId: parentRequestId, data: {
        id: namespaceId, name: 'sb-main', type: 'Microsoft.ServiceBus/namespaces',
        properties: { provisioningState: 'Succeeded' }
      } }
    });

    const result = await readGeneratedApplicationResource({
      target,
      verify: true,
      binding,
      transport,
      authorize: defaultAuth
    });
    expect(result.exists).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.values.status).toBe('Active');
    expect(result.dependencies).toEqual([
      {
        resourceId: namespaceId,
        resourceType: 'Microsoft.ServiceBus/namespaces',
        readbackRequestId: parentRequestId
      }
    ]);
  });

  it('observes azurerm_communication_service with global location and safe properties', async () => {
    const id = buildGeneratedResourceId('azurerm_communication_service', subscriptionId, resourceGroup, 'acs-main');
    const target: GeneratedApplicationResourceTarget = {
      address: 'module.application.azurerm_communication_service.main',
      type: 'azurerm_communication_service',
      resourceId: id,
      actions: ['create'],
      expected: {
        name: 'acs-main',
        resource_group_name: resourceGroup,
        data_location: 'United States',
        'tags.liftoff-repository-id': ownerId
      }
    };
    validateGeneratedResourceTarget(target, subscriptionId, ownerId);

    const requestId = randomUUID();
    const { transport } = mockTransport(() => ({
      status: 200,
      requestId,
      data: {
        id,
        name: 'acs-main',
        type: 'Microsoft.Communication/communicationServices',
        location: 'global',
        tags: { 'liftoff-repository-id': ownerId },
        properties: {
          provisioningState: 'Succeeded',
          dataLocation: 'United States',
          hostName: 'acs-main.communication.azure.com'
        }
      }
    }));

    const result = await readGeneratedApplicationResource({
      target,
      verify: true,
      binding,
      transport,
      authorize: defaultAuth
    });
    expect(result.exists).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.values.primary_connection_string).toBeUndefined();
    expect(result.values.data_location).toBe('United States');
  });

  it('observes azurerm_key_vault without data-plane secret inspection', async () => {
    const id = buildGeneratedResourceId('azurerm_key_vault', subscriptionId, resourceGroup, 'kv-main');
    const target: GeneratedApplicationResourceTarget = {
      address: 'module.application.azurerm_key_vault.main',
      type: 'azurerm_key_vault',
      resourceId: id,
      actions: ['create'],
      expected: {
        name: 'kv-main',
        location: region,
        resource_group_name: resourceGroup,
        tenant_id: tenantId,
        sku_name: 'standard',
        rbac_authorization_enabled: true,
        'tags.liftoff-repository-id': ownerId
      }
    };
    validateGeneratedResourceTarget(target, subscriptionId, ownerId);

    const requestId = randomUUID();
    const { transport } = mockTransport(() => ({
      status: 200,
      requestId,
      data: {
        id,
        name: 'kv-main',
        type: 'Microsoft.KeyVault/vaults',
        location: region,
        tags: { 'liftoff-repository-id': ownerId },
        properties: {
          provisioningState: 'Succeeded',
          tenantId,
          sku: { family: 'A', name: 'standard' },
          enableRbacAuthorization: true,
          vaultUri: 'https://kv-main.vault.azure.net/'
        }
      }
    }));

    const result = await readGeneratedApplicationResource({
      target,
      verify: true,
      binding,
      transport,
      authorize: defaultAuth
    });
    expect(result.exists).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.values.vault_uri).toBe('https://kv-main.vault.azure.net/');
  });

  it('observes azurerm_service_plan with reserved Linux property projection', async () => {
    const id = buildGeneratedResourceId('azurerm_service_plan', subscriptionId, resourceGroup, 'asp-fn');
    const target: GeneratedApplicationResourceTarget = {
      address: 'module.application.azurerm_service_plan.functions',
      type: 'azurerm_service_plan',
      resourceId: id,
      actions: ['create'],
      expected: {
        name: 'asp-fn',
        location: region,
        resource_group_name: resourceGroup,
        os_type: 'Linux',
        sku_name: 'Y1',
        'tags.liftoff-repository-id': ownerId
      }
    };
    validateGeneratedResourceTarget(target, subscriptionId, ownerId);

    const requestId = randomUUID();
    const { transport } = mockTransport(() => ({
      status: 200,
      requestId,
      data: {
        id,
        name: 'asp-fn',
        type: 'Microsoft.Web/serverfarms',
        location: region,
        tags: { 'liftoff-repository-id': ownerId },
        sku: { name: 'Y1', tier: 'Dynamic' },
        properties: {
          provisioningState: 'Succeeded',
          reserved: true
        }
      }
    }));

    const result = await readGeneratedApplicationResource({
      target,
      verify: true,
      binding,
      transport,
      authorize: defaultAuth
    });
    expect(result.exists).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.values.os_type).toBe('Linux');
  });

  it('observes azurerm_linux_function_app with identity and service plan bindings and withholds storage key', async () => {
    const servicePlanId = buildGeneratedResourceId('azurerm_service_plan', subscriptionId, resourceGroup, 'asp-fn');
    const identityId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-worker`;
    const id = buildGeneratedResourceId('azurerm_linux_function_app', subscriptionId, resourceGroup, 'func-worker');
    const target: GeneratedApplicationResourceTarget = {
      address: 'module.application.azurerm_linux_function_app.worker',
      type: 'azurerm_linux_function_app',
      resourceId: id,
      actions: ['create'],
      expected: {
        name: 'func-worker',
        location: region,
        resource_group_name: resourceGroup,
        service_plan_id: servicePlanId,
        storage_account_name: 'stfunction',
        'identity.0.type': 'UserAssigned',
        'identity.0.identity_ids.0': identityId,
        'site_config.0.application_stack.0.python_version': '3.12',
        'tags.liftoff-repository-id': ownerId
      }
    };
    validateGeneratedResourceTarget(target, subscriptionId, ownerId);

    const requestId = randomUUID(), identityRequestId = randomUUID(), planRequestId = randomUUID();
    const webRequestId = randomUUID(), settingsRequestId = randomUUID();
    const storageKey = Buffer.alloc(64, 7).toString('base64');
    const observedPrincipal = randomUUID(), observedClient = randomUUID();
    const { transport } = mockTransport(() => ({
      status: 200,
      requestId,
      data: {
        id,
        name: 'func-worker',
        type: 'Microsoft.Web/sites',
        location: region,
        tags: { 'liftoff-repository-id': ownerId },
        identity: {
          type: 'UserAssigned',
          userAssignedIdentities: {
            [identityId]: { principalId: observedPrincipal, clientId: observedClient }
          }
        },
        properties: {
          state: 'Running',
          provisioningState: 'Succeeded',
          serverFarmId: servicePlanId,
          defaultHostName: 'func-worker.azurewebsites.net',
          storageAccountAccessKey: 'STORAGE_KEY_NEVER_RETURNED',
          siteConfig: {
            linuxFxVersion: 'Python|3.12'
          }
        }
      }
    }), {
      [identityId]: { status: 200, requestId: identityRequestId, data: {
        id: identityId, name: 'id-worker', type: 'Microsoft.ManagedIdentity/userAssignedIdentities',
        properties: { principalId: observedPrincipal, clientId: observedClient, tenantId }
      } },
      [servicePlanId]: { status: 200, requestId: planRequestId, data: {
        id: servicePlanId, name: 'asp-fn', type: 'Microsoft.Web/serverfarms',
        properties: { provisioningState: 'Succeeded' }
      } },
      [`${id}/config/web`]: { status: 200, requestId: webRequestId, data: {
        id: `${id}/config/web`, name: 'web', type: 'Microsoft.Web/sites/config',
        properties: { linuxFxVersion: 'Python|3.12' }
      } },
      [`${id}/config/appsettings/list`]: { status: 200, requestId: settingsRequestId, data: {
        id: `${id}/config/appsettings`, name: 'appsettings', type: 'Microsoft.Web/sites/config',
        properties: { AzureWebJobsStorage: `DefaultEndpointsProtocol=https;AccountName=stfunction;AccountKey=${storageKey};EndpointSuffix=core.windows.net`,
          PRIVATE_VALUE: 'WITHHELD_FUNCTION_SETTING' }
      } }
    });

    const result = await readGeneratedApplicationResource({
      target,
      verify: true,
      binding,
      transport,
      authorize: defaultAuth,
      expectedState: { storage_account_name: 'stfunction', storage_account_access_key: storageKey,
        app_settings: { PRIVATE_VALUE: 'WITHHELD_FUNCTION_SETTING' } }
    });
    expect(result.exists).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.values.storage_account_access_key).toBeUndefined();
    expect(result.values.storage_account_name).toBe('stfunction');
    expect(JSON.stringify(result)).not.toContain(storageKey);
    expect(JSON.stringify(result)).not.toContain('WITHHELD_FUNCTION_SETTING');
    expect(result.values.running_status).toBe('Running');
    expect(result.dependencies).toEqual([
      {
        resourceId: servicePlanId,
        resourceType: 'Microsoft.Web/serverfarms',
        readbackRequestId: planRequestId
      },
      {
        resourceId: identityId,
        resourceType: 'Microsoft.ManagedIdentity/userAssignedIdentities',
        readbackRequestId: identityRequestId, principalId: observedPrincipal, clientId: observedClient, tenantId
      },
      {
        resourceId: `${id}/config/web`, resourceType: 'Microsoft.Web/sites/config', readbackRequestId: webRequestId, method: 'GET'
      },
      {
        resourceId: `${id}/config/appsettings`, resourceType: 'Microsoft.Web/sites/config', readbackRequestId: settingsRequestId, method: 'POST'
      }
    ]);
  });
});

describe('failure and mismatch protocol adherence', () => {
  const defaultAuth = async () => {};
  const serverId = buildGeneratedResourceId('azurerm_postgresql_flexible_server', subscriptionId, resourceGroup, 'psql-main');
  const validTarget: GeneratedApplicationResourceTarget = {
    address: 'module.application.azurerm_postgresql_flexible_server.main',
    type: 'azurerm_postgresql_flexible_server',
    resourceId: serverId,
    actions: ['create'],
    expected: {
      name: 'psql-main',
      location: region,
      resource_group_name: resourceGroup
    }
  };

  it('rejects target and returned identity mismatch (id, type, name, location)', async () => {
    // 1. Returned ID mismatch
    const badIdTransport = mockTransport(() => ({
      status: 200,
      requestId: randomUUID(),
      data: {
        id: `${serverId}-different`,
        name: 'psql-main',
        type: 'Microsoft.DBforPostgreSQL/flexibleServers',
        location: region,
        properties: { state: 'Ready' }
      }
    })).transport;
    await expect(readGeneratedApplicationResource({
      target: validTarget, verify: false, binding, transport: badIdTransport, authorize: defaultAuth
    })).rejects.toThrowError(GeneratedApplicationResourceReadbackError);

    // 2. Returned type mismatch
    const badTypeTransport = mockTransport(() => ({
      status: 200,
      requestId: randomUUID(),
      data: {
        id: serverId,
        name: 'psql-main',
        type: 'Microsoft.DBforPostgreSQL/servers',
        location: region,
        properties: { state: 'Ready' }
      }
    })).transport;
    await expect(readGeneratedApplicationResource({
      target: validTarget, verify: false, binding, transport: badTypeTransport, authorize: defaultAuth
    })).rejects.toThrowError(GeneratedApplicationResourceReadbackError);

    // 3. Returned name mismatch
    const badNameTransport = mockTransport(() => ({
      status: 200,
      requestId: randomUUID(),
      data: {
        id: serverId,
        name: 'psql-other',
        type: 'Microsoft.DBforPostgreSQL/flexibleServers',
        location: region,
        properties: { state: 'Ready' }
      }
    })).transport;
    await expect(readGeneratedApplicationResource({
      target: validTarget, verify: false, binding, transport: badNameTransport, authorize: defaultAuth
    })).rejects.toThrowError(GeneratedApplicationResourceReadbackError);

    // 4. Returned location mismatch
    const badLocationTransport = mockTransport(() => ({
      status: 200,
      requestId: randomUUID(),
      data: {
        id: serverId,
        name: 'psql-main',
        type: 'Microsoft.DBforPostgreSQL/flexibleServers',
        location: 'westus',
        properties: { state: 'Ready' }
      }
    })).transport;
    await expect(readGeneratedApplicationResource({
      target: validTarget, verify: false, binding, transport: badLocationTransport, authorize: defaultAuth
    })).rejects.toThrowError(GeneratedApplicationResourceReadbackError);
  });

  it('handles absent 404 cleanly when verify: false, but fails when verify: true', async () => {
    const absentTransport = mockTransport(() => ({
      status: 404,
      requestId: randomUUID(),
      data: {
        error: { code: 'ResourceNotFound', message: 'Resource not found' }
      }
    })).transport;

    // Verify: false -> proves absence
    const absentResult = await readGeneratedApplicationResource({
      target: validTarget, verify: false, binding, transport: absentTransport, authorize: defaultAuth
    });
    expect(absentResult.exists).toBe(false);
    expect(absentResult.verified).toBe(false);
    expect(absentResult.values).toEqual({});

    // Verify: true -> fails because resource is expected to exist
    await expect(readGeneratedApplicationResource({
      target: validTarget, verify: true, binding, transport: absentTransport, authorize: defaultAuth
    })).rejects.toThrowError(GeneratedApplicationResourceReadbackError);

    // 404 with unproven error code
    const bogusNotFoundTransport = mockTransport(() => ({
      status: 404,
      requestId: randomUUID(),
      data: { error: { code: 'UnhandledError' } }
    })).transport;
    await expect(readGeneratedApplicationResource({
      target: validTarget, verify: false, binding, transport: bogusNotFoundTransport, authorize: defaultAuth
    })).rejects.toThrowError(GeneratedApplicationResourceReadbackError);
  });

  it('rejects nonterminal and failed states during verification', async () => {
    for (const state of ['Creating', 'Updating', 'Deleting', 'Failed']) {
      const nonterminalTransport = mockTransport(() => ({
        status: 200,
        requestId: randomUUID(),
        data: {
          id: serverId,
          name: 'psql-main',
          type: 'Microsoft.DBforPostgreSQL/flexibleServers',
          location: region,
          properties: { state }
        }
      })).transport;

      await expect(readGeneratedApplicationResource({
        target: validTarget, verify: true, binding, transport: nonterminalTransport, authorize: defaultAuth
      })).rejects.toThrowError(GeneratedApplicationResourceReadbackError);
    }
  });

  it('rejects missing or malformed request ID', async () => {
    // Missing requestId
    const noReqIdTransport = mockTransport(() => ({
      status: 200,
      data: {
        id: serverId,
        name: 'psql-main',
        type: 'Microsoft.DBforPostgreSQL/flexibleServers',
        location: region,
        properties: { state: 'Ready' }
      }
    })).transport;
    await expect(readGeneratedApplicationResource({
      target: validTarget, verify: false, binding, transport: noReqIdTransport, authorize: defaultAuth
    })).rejects.toThrow();

    // Malformed requestId
    const badReqIdTransport = mockTransport(() => ({
      status: 200,
      requestId: 'not-a-uuid',
      data: {
        id: serverId,
        name: 'psql-main',
        type: 'Microsoft.DBforPostgreSQL/flexibleServers',
        location: region,
        properties: { state: 'Ready' }
      }
    })).transport;
    await expect(readGeneratedApplicationResource({
      target: validTarget, verify: false, binding, transport: badReqIdTransport, authorize: defaultAuth
    })).rejects.toThrow();
  });

  it('does not default missing fields to Succeeded or Running', async () => {
    // Storage account with missing provisioningState in ARM response
    const stId = buildGeneratedResourceId('azurerm_storage_account', subscriptionId, resourceGroup, 'stmain');
    const stTarget: GeneratedApplicationResourceTarget = {
      address: 'module.application.azurerm_storage_account.main',
      type: 'azurerm_storage_account',
      resourceId: stId,
      actions: ['create'],
      expected: {
        name: 'stmain',
        location: region,
        resource_group_name: resourceGroup
      }
    };

    const missingStateTransport = mockTransport(() => ({
      status: 200,
      requestId: randomUUID(),
      data: {
        id: stId,
        name: 'stmain',
        type: 'Microsoft.Storage/storageAccounts',
        location: region,
        properties: {
          // provisioningState is omitted
        }
      }
    })).transport;

    // Must fail verification because missing field cannot become success!
    await expect(readGeneratedApplicationResource({
      target: stTarget, verify: true, binding, transport: missingStateTransport, authorize: defaultAuth
    })).rejects.toThrowError(GeneratedApplicationResourceReadbackError);
  });

  it('does not treat HTTP failures as absence or success', async () => {
    for (const status of [401, 403, 500, 502, 503]) {
      const errorTransport = mockTransport(() => ({
        status,
        requestId: randomUUID(),
        data: { error: { code: 'ServiceError' } }
      })).transport;

      await expect(readGeneratedApplicationResource({
        target: validTarget, verify: false, binding, transport: errorTransport, authorize: defaultAuth
      })).rejects.toThrowError(GeneratedApplicationResourceReadbackError);
    }
  });

  it('verifies that zero remote mutations occur (strictly GET)', async () => {
    const { transport, requests } = mockTransport(() => ({
      status: 200,
      requestId: randomUUID(),
      data: {
        id: serverId,
        name: 'psql-main',
        type: 'Microsoft.DBforPostgreSQL/flexibleServers',
        location: region,
        properties: { state: 'Ready' }
      }
    }));

    await readGeneratedApplicationResource({
      target: validTarget, verify: false, binding, transport, authorize: defaultAuth
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('GET');
  });

  it('respects abort signal and cancels readback', async () => {
    const controller = new AbortController();
    controller.abort();

    const { transport } = mockTransport(() => ({
      status: 200,
      requestId: randomUUID(),
      data: {}
    }));

    await expect(readGeneratedApplicationResource({
      target: validTarget, verify: false, binding, transport, authorize: defaultAuth, signal: controller.signal
    })).rejects.toThrow(/readback-cancelled/);
  });
});
