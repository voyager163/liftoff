import { isUtf8 } from 'node:buffer';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { stateDigest } from '../../domain/repair/stateful-invariants.js';
import { boundedStateOperation } from '../../domain/repair/stateful-bounded.js';
import {
  ApplicationPrivateError, applicationPrivateAssert as must, applicationPrivateResourceTypes,
  type ApplicationPrivateIntent, type ApplicationPrivateObservation, type ApplicationPrivateTarget
} from '../../application/azure-activation/application-private-contracts.js';
import { applicationPrivateTargetName } from '../../application/azure-activation/application-private-inputs.js';
import { applicationPrivateValue } from '../../application/azure-activation/application-private-plan.js';
import {
  AzureApplicationProvisioningClient, applicationUuid, parseApplicationImageReference
} from './application-provisioning.js';
import { AzureProviderClient, azureArmUrl, type AzureArmResponse, type AzureArmTransport } from './activation-rest.js';
import { readApplicationPrivateResponse } from './application-private-credentials.js';
import { ApplicationPrivateResourceReadbackError } from './application-private-readback-errors.js';
export { ApplicationPrivateResourceReadbackError } from './application-private-readback-errors.js';
import { isGeneratedApplicationResourceType } from '../../application/azure-activation/application-generated-resource-contracts.js';
import { readGeneratedApplicationResource } from './application-generated-resource-readback.js';
import { applicationFunctionReadRequests } from './application-function-readback.js';
import {
  applicationPrivateArtifactForTarget, applicationPrivateHealthUrl
} from '../../application/azure-activation/application-private-artifacts.js';

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

/** Explicit document structure; comments and raw-text elements cannot supply missing health markers. */
function assertHtmlDocument(document: string): void {
  must(!/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(document), 'runtime-html-document');
  const stack: string[] = [];
  const seen = new Set<string>();
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  let offset = 0, doctype = false;
  while (offset < document.length) {
    const parent = stack.at(-1);
    if (parent && ['script', 'style', 'textarea', 'title'].includes(parent)) {
      const closing = new RegExp(`</${parent}\\s*>`, 'giu');
      closing.lastIndex = offset;
      const end = closing.exec(document);
      must(end, 'runtime-html-document');
      if (parent === 'title') must(document.slice(offset, end.index).trim().length > 0, 'runtime-html-document');
      offset = end.index + end[0].length;
      stack.pop();
      continue;
    }
    if (document[offset] !== '<') {
      const next = document.indexOf('<', offset);
      const end = next < 0 ? document.length : next;
      must(parent && parent !== 'html' && parent !== 'head' || document.slice(offset, end).trim() === '', 'runtime-html-document');
      offset = end;
      continue;
    }
    if (document.startsWith('<!--', offset)) {
      const end = document.indexOf('-->', offset + 4);
      must(end >= 0 && !document.slice(offset + 4, end).includes('--'), 'runtime-html-document');
      offset = end + 3;
      continue;
    }
    const declaration = /^<!doctype\s+html\s*>/iu.exec(document.slice(offset));
    if (declaration) {
      must(!doctype && !seen.has('html') && stack.length === 0, 'runtime-html-document');
      doctype = true; offset += declaration[0].length;
      continue;
    }
    const start = /^<(\/?)([a-z][a-z0-9:-]*)(?=[\s/>])/iu.exec(document.slice(offset));
    must(start, 'runtime-html-document');
    const tag = start[2]!.toLowerCase(), closing = start[1] === '/';
    let end = offset + start[0].length, quote = '';
    for (; end < document.length; end++) {
      const character = document[end]!;
      if (quote) { if (character === quote) quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
      else must(character !== '<', 'runtime-html-document');
    }
    must(end < document.length && quote === '', 'runtime-html-document');
    const attributes = document.slice(offset + start[0].length, end);
    const selfClosing = attributes.trimEnd().endsWith('/');
    if (closing) {
      must(attributes.trim() === '' && stack.at(-1) === tag, 'runtime-html-document');
      stack.pop();
    } else {
      must(!selfClosing || voidTags.has(tag), 'runtime-html-document');
      if (['html', 'head', 'title', 'body'].includes(tag)) {
        must(!seen.has(tag) && (tag === 'html' ? stack.length === 0 :
          tag === 'head' ? parent === 'html' && !seen.has('body') :
            tag === 'title' ? parent === 'head' :
              parent === 'html' && seen.has('head') && seen.has('title')), 'runtime-html-document');
        seen.add(tag);
      } else must(stack.includes('head') || stack.includes('body'), 'runtime-html-document');
      if (!voidTags.has(tag)) stack.push(tag);
      must(stack.length <= 64, 'runtime-html-document');
    }
    offset = end + 1;
  }
  must(stack.length === 0 && ['html', 'head', 'title', 'body'].every((tag) => seen.has(tag)), 'runtime-html-document');
}

async function readHtmlDocument(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  must(reader, 'runtime-html-document');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
      size += part.value.byteLength;
      must(size <= 65_536, 'runtime-html-bound');
    }
    const bytes = Buffer.concat(chunks);
    try {
      must(bytes.length > 0 && isUtf8(bytes), 'runtime-html-document');
      assertHtmlDocument(bytes.toString('utf8'));
      return stateDigest(bytes);
    } finally { bytes.fill(0); }
  } finally {
    await reader.cancel().catch(() => undefined);
    for (const chunk of chunks) chunk.fill(0);
  }
}

export class ApplicationPrivateResourceReader {
  readonly client: AzureApplicationProvisioningClient;
  constructor(private readonly options: {
    intent: ApplicationPrivateIntent;
    transport: AzureArmTransport;
    authorize(): Promise<void>;
    now?: () => number;
    fetch?: typeof globalThis.fetch;
  }) {
    this.client = new AzureApplicationProvisioningClient({
      request: async (request, binding) => {
        must(request.method === 'GET' || request.method === 'POST' && request.body === undefined &&
          options.intent.targets.some((target) => target.type === 'azurerm_linux_function_app' &&
            applicationFunctionReadRequests(target.resourceId).some((allowed) =>
              allowed.method === request.method && allowed.resourceId === request.resourceId && allowed.apiVersion === request.apiVersion)),
        'readback-only');
        await this.options.authorize();
        return options.transport.request(request, binding);
      }
    }, options.intent.binding);
  }

  async assertProviders(): Promise<void> {
    const client = new AzureProviderClient(this.client.transport, this.options.intent.binding);
    const namespaces = new Set(this.options.intent.targets.map((target) => applicationPrivateResourceTypes[target.type].arm.split('/')[0]!));
    for (const namespace of namespaces) {
      const observed = await client.read(namespace);
      must(observed.state === 'Registered', 'provider-not-ready');
    }
  }

  private now(): string { return new Date(this.options.now?.() ?? Date.now()).toISOString(); }

  private async dependencies(target: ApplicationPrivateTarget): Promise<ApplicationPrivateObservation['dependencies']> {
    const role = target.role;
    const application = target.type === 'azurerm_container_app';
    if (!role && !application) return [];
    const artifact = applicationPrivateArtifactForTarget(this.options.intent, target);
    must(role || artifact, 'artifact-runtime-required');
    const identityId = role?.identityResourceId ?? String(target.expected['identity.0.identity_ids.0']);
    const registryId = role?.scope ?? artifact!.registryResourceId;
    const parts = identityId.split('/');
    const identity = await this.client.getIdentity(parts[4]!, parts.at(-1)!);
    if (role && role.roleDefinitionName) {
      const definition = await this.client.transport.request({
        method: 'GET', resourceId: role.roleDefinitionId, apiVersion: '2022-04-01'
      }, this.options.intent.binding);
      const definitionId = applicationUuid(definition.requestId, 'Actual role definition GET');
      const definitionBody = object(definition.data), definitionProperties = object(definitionBody.properties);
      must(definition.status === 200 && sameId(definitionBody.id, role.roleDefinitionId) &&
        definitionProperties.roleName === role.roleDefinitionName && definitionProperties.type === 'BuiltInRole', 'role-definition-readback');
      const kind = role.scope.includes('/Microsoft.ContainerRegistry/registries/') ? 'Microsoft.ContainerRegistry/registries' :
        role.scope.includes('/Microsoft.ServiceBus/namespaces/') ? role.scope.includes('/queues/')
          ? 'Microsoft.ServiceBus/namespaces/queues' : 'Microsoft.ServiceBus/namespaces' : 'Microsoft.Storage/storageAccounts';
      const api = kind === 'Microsoft.ContainerRegistry/registries' ? '2023-07-01' :
        kind.startsWith('Microsoft.ServiceBus/') ? '2024-01-01' : '2023-05-01';
      const scope = await this.client.transport.request({ method: 'GET', resourceId: role.scope, apiVersion: api }, this.options.intent.binding);
      const scopeId = applicationUuid(scope.requestId, 'Actual role scope GET');
      const scopeBody = object(scope.data), properties = object(scopeBody.properties);
      must(scope.status === 200 && sameId(scopeBody.id, role.scope) && sameId(scopeBody.type, kind) &&
        (kind === 'Microsoft.ServiceBus/namespaces/queues' ? properties.status === 'Active' : properties.provisioningState === 'Succeeded') &&
        (scopeBody.tags === undefined || isRecord(scopeBody.tags) && (scopeBody.tags['liftoff-repository-id'] === undefined ||
          scopeBody.tags['liftoff-repository-id'] === this.options.intent.backend.backend.ownerId)) &&
        identity.principalId === role.principalId &&
        identity.clientId === role.clientId && identity.tenantId === this.options.intent.binding.tenantId, 'role-scope-readback');
      return [
        { resourceId: identity.id, resourceType: 'Microsoft.ManagedIdentity/userAssignedIdentities', readbackRequestId: identity.requestId,
          principalId: identity.principalId, clientId: identity.clientId, tenantId: identity.tenantId },
        { resourceId: role.scope, resourceType: kind, readbackRequestId: scopeId },
        { resourceId: role.roleDefinitionId, resourceType: 'Microsoft.Authorization/roleDefinitions', readbackRequestId: definitionId }
      ];
    }
    const registryParts = registryId.split('/');
    const registry = await this.client.getAcr(registryParts[4]!, registryParts.at(-1)!);
    must((!role || identity.principalId === role.principalId && identity.clientId === role.clientId) &&
      identity.tenantId === this.options.intent.binding.tenantId && registry.provisioningState === 'Succeeded' &&
      sameId(identity.id, identityId) && sameId(registry.id, registryId) && !registry.adminUserEnabled &&
      (!artifact || registry.loginServer === parseApplicationImageReference(artifact.imageRef).loginServer), 'additional-rbac-plan-required');
    for (const resource of [{ id: identityId, api: '2023-01-31' }, { id: registryId, api: '2023-07-01' }]) {
      const response = await this.client.transport.request({ method: 'GET', resourceId: resource.id, apiVersion: resource.api }, this.options.intent.binding);
      applicationUuid(response.requestId, 'Actual dependency ownership GET');
      const body = object(response.data);
      must(response.status === 200 && sameId(body.id, resource.id) &&
        (body.tags === undefined || isRecord(body.tags) && (body.tags['liftoff-repository-id'] === undefined ||
          body.tags['liftoff-repository-id'] === this.options.intent.backend.backend.ownerId)), 'dependency-ownership');
      const properties = object(body.properties);
      must(resource.id === identityId
        ? properties.principalId === identity.principalId && properties.clientId === identity.clientId && properties.tenantId === identity.tenantId
        : properties.loginServer === registry.loginServer && properties.adminUserEnabled === registry.adminUserEnabled &&
          properties.provisioningState === registry.provisioningState, 'dependency-readback-race');
    }
    return [
      { resourceId: identity.id, resourceType: 'Microsoft.ManagedIdentity/userAssignedIdentities',
        readbackRequestId: identity.requestId, principalId: identity.principalId, clientId: identity.clientId, tenantId: identity.tenantId },
      { resourceId: registry.id, resourceType: 'Microsoft.ContainerRegistry/registries', readbackRequestId: registry.requestId }
    ];
  }

  async observe(target: ApplicationPrivateTarget, verify: boolean, signal?: AbortSignal, expectedState?: Record<string, unknown>): Promise<ApplicationPrivateObservation> {
    if (isGeneratedApplicationResourceType(target.type)) {
      return readGeneratedApplicationResource({
        target: { ...target, type: target.type, role: null, runtime: null }, verify, signal,
        binding: this.options.intent.binding, transport: this.client.transport, authorize: this.options.authorize,
        ownerId: this.options.intent.backend.backend.ownerId, now: this.options.now, expectedState
      });
    }
    await this.options.authorize();
    must(!signal?.aborted, 'readback-cancelled');
    const dependencies = await this.dependencies(target);
    const contract = applicationPrivateResourceTypes[target.type];
    const response = await this.client.transport.request({
      method: 'GET', resourceId: target.resourceId, apiVersion: contract.api
    }, this.options.intent.binding);
    const requestId = applicationUuid(response.requestId, 'Actual application GET request');
    try { return await this.decode(target, verify, response, requestId, dependencies, signal, expectedState); }
    catch (error) {
      throw new ApplicationPrivateResourceReadbackError(error instanceof ApplicationPrivateError ? error.code : 'arm-resource-readback-incomplete', {
        address: target.address, requestedResourceId: target.resourceId, readbackRequestId: requestId, status: response.status
      });
    }
  }

  private async decode(
    target: ApplicationPrivateTarget, verify: boolean, response: AzureArmResponse, requestId: string,
    dependencies: ApplicationPrivateObservation['dependencies'], signal?: AbortSignal, expectedState?: Record<string, unknown>
  ): Promise<ApplicationPrivateObservation> {
    const contract = applicationPrivateResourceTypes[target.type], name = applicationPrivateTargetName(target);
    const artifact = applicationPrivateArtifactForTarget(this.options.intent, target);
    const artifactBinding = artifact && 'role' in artifact ? { artifact } : {};
    const dependencyBinding = dependencies.map(({ readbackRequestId: _requestId, ...binding }) => binding);
    if (response.status === 404) {
      must(!verify && isRecord(response.data) && isRecord(response.data.error) &&
        ['ResourceNotFound', 'ResourceGroupNotFound', 'NotFound'].includes(String(response.data.error.code)), 'absence-unproven');
      return {
        address: target.address, resourceId: target.resourceId, resourceType: contract.arm, exists: false, verified: false,
        readbackRequestId: requestId, observedAt: this.now(), values: {},
        privateDigest: canonicalSha256({ resourceId: target.resourceId, exists: false, dependencies: dependencyBinding }), runtime: null, dependencies,
        ...artifactBinding
      };
    }
    must(response.status === 200, 'arm-readback-failed');
    const value = object(response.data), properties = object(value.properties);
    must(sameId(value.id, target.resourceId) && sameId(value.type, contract.arm) && sameId(value.name, name.name), 'arm-resource-identity');
    const values: Record<string, unknown> = {
      id: value.id, name: value.name, location: value.location, resource_group_name: name.resourceGroup,
      tags: value.tags, provisioning_state: properties.provisioningState
    };
    if (target.type === 'azurerm_container_registry') {
      const registry = await this.client.getAcr(name.resourceGroup, name.name);
      must(sameId(registry.id, String(value.id)) && registry.loginServer === properties.loginServer &&
        registry.adminUserEnabled === properties.adminUserEnabled && registry.provisioningState === properties.provisioningState,
      'arm-readback-race');
      Object.assign(values, {
        sku: object(value.sku).name, admin_enabled: registry.adminUserEnabled, login_server: registry.loginServer,
        public_network_access_enabled: ['Enabled', 'Disabled'].includes(String(properties.publicNetworkAccess))
          ? properties.publicNetworkAccess === 'Enabled' : undefined,
        zone_redundancy_enabled: ['Enabled', 'Disabled'].includes(String(properties.zoneRedundancy))
          ? properties.zoneRedundancy === 'Enabled' : undefined
      });
    } else if (target.type === 'azurerm_user_assigned_identity') {
      const identity = await this.client.getIdentity(name.resourceGroup, name.name);
      must(identity.principalId === properties.principalId && identity.clientId === properties.clientId &&
        identity.tenantId === properties.tenantId, 'arm-readback-race');
      Object.assign(values, { principal_id: identity.principalId, client_id: identity.clientId, tenant_id: identity.tenantId });
    } else if (target.type === 'azurerm_role_assignment') {
      must(target.role && properties.principalId === target.role.principalId &&
        sameId(properties.roleDefinitionId, target.role.roleDefinitionId) &&
        (properties.scope === undefined || sameId(properties.scope, target.role.scope)) &&
        properties.principalType === 'ServicePrincipal', 'role-readback');
      Object.assign(values, { scope: target.resourceId.slice(0, target.resourceId.lastIndexOf('/providers/Microsoft.Authorization/roleAssignments/')),
        principal_id: properties.principalId, role_definition_id: properties.roleDefinitionId, principal_type: properties.principalType });
    } else if (target.type === 'azurerm_container_app_environment') {
      const network = properties.vnetConfiguration === undefined ? {} : object(properties.vnetConfiguration);
      const logging = properties.appLogsConfiguration === undefined ? {} : object(properties.appLogsConfiguration);
      const analytics = logging.logAnalyticsConfiguration === undefined ? {} : object(logging.logAnalyticsConfiguration);
      Object.assign(values, {
        infrastructure_subnet_id: network.infrastructureSubnetId, internal_load_balancer_enabled: network.internal,
        zone_redundancy_enabled: properties.zoneRedundant, log_analytics_customer_id: analytics.customerId,
        default_domain: properties.defaultDomain, static_ip_address: properties.staticIp
      });
      if (target.expected.log_analytics_workspace_id !== undefined) {
        const workspaceId = String(target.expected.log_analytics_workspace_id);
        azureArmUrl(workspaceId, '2023-09-01', this.options.intent.binding.subscriptionId);
        const workspace = await this.client.transport.request({ method: 'GET', resourceId: workspaceId, apiVersion: '2023-09-01' }, this.options.intent.binding);
        applicationUuid(workspace.requestId, 'Actual Log Analytics GET request');
        must(workspace.status === 200 && sameId(object(workspace.data).id, workspaceId) &&
          object(object(workspace.data).properties).customerId === analytics.customerId, 'environment-logging-readback');
        values.log_analytics_workspace_id = workspaceId;
      }
    } else if (target.type === 'azurerm_container_app') {
      const configuration = object(properties.configuration), template = object(properties.template);
      const ingress = object(configuration.ingress), scale = object(template.scale), identity = object(value.identity);
      const assigned = Object.keys(object(identity.userAssignedIdentities));
      must(Array.isArray(template.containers) && template.containers.length === 1 && assigned.length === 1 &&
        identity.type === 'UserAssigned', 'application-readback-inventory');
      const container = object(template.containers[0]), resources = object(container.resources);
      Object.assign(values, {
        container_app_environment_id: properties.managedEnvironmentId, revision_mode: configuration.activeRevisionsMode,
        identity: [{ type: identity.type, identity_ids: assigned }],
        template: [{
          min_replicas: scale.minReplicas, max_replicas: scale.maxReplicas,
          container: [{ name: container.name, image: container.image, cpu: resources.cpu, memory: resources.memory }]
        }],
        ingress: [{
          fqdn: ingress.fqdn, external_enabled: ingress.external, target_port: ingress.targetPort, transport: ingress.transport
        }],
        latest_revision_name: properties.latestRevisionName, latest_ready_revision_name: properties.latestReadyRevisionName,
        running_status: properties.runningStatus
      });
      if (verify) {
        must(artifact && container.image === artifact.imageRef && properties.runningStatus === 'Running' &&
          typeof properties.latestRevisionName === 'string' && properties.latestRevisionName.length > 0 &&
          properties.latestRevisionName === properties.latestReadyRevisionName &&
          sameId(assigned[0], String(target.expected['identity.0.identity_ids.0'])) &&
          sameId(properties.managedEnvironmentId, String(target.expected.container_app_environment_id)), 'application-runtime-not-ready');
        const image = parseApplicationImageReference(artifact.imageRef);
        const registries = configuration.registries;
        must(Array.isArray(registries) && registries.length === 1 && object(registries[0]).server === image.loginServer &&
          sameId(object(registries[0]).identity, assigned[0]!), 'application-registry-identity');
        const secretMetadata = (value: unknown, arm: boolean) => {
          if (value === undefined) return [];
          must(Array.isArray(value) && value.length <= 64, 'application-secret-metadata');
          return value.map((entry) => {
            const secret = object(entry);
            must(typeof secret.name === 'string', 'application-secret-metadata');
            return { name: secret.name, identity: secret.identity ?? null,
              keyVaultReference: secret[arm ? 'keyVaultUrl' : 'key_vault_secret_id'] || null };
          }).sort((left, right) => left.name.localeCompare(right.name, 'en'));
        };
        const expectedSecrets = secretMetadata(expectedState?.secret, false);
        must(canonicalSha256(secretMetadata(configuration.secrets, true)) === canonicalSha256(expectedSecrets),
          'application-secret-metadata');
        const environmentMetadata = (value: unknown, arm: boolean) => {
          if (value === undefined) return [];
          must(Array.isArray(value) && value.length <= 128, 'application-environment-readback');
          return value.map((entry) => {
            const variable = object(entry);
            must(typeof variable.name === 'string' && (variable.value === undefined || variable.value === null || typeof variable.value === 'string'),
              'application-environment-readback');
            return { name: variable.name, value: variable.value ?? '', secret: variable[arm ? 'secretRef' : 'secret_name'] || null };
          }).sort((left, right) => left.name.localeCompare(right.name, 'en'));
        };
        must(canonicalSha256(environmentMetadata(container.env, true)) ===
          canonicalSha256(environmentMetadata(expectedState ? applicationPrivateValue(expectedState, 'template.0.container.0.env') : undefined, false)),
        'application-environment-readback');
        must(Array.isArray(ingress.traffic) && ingress.traffic.length === 1 &&
          object(ingress.traffic[0]).latestRevision === true && object(ingress.traffic[0]).weight === 100 &&
          (container.command === undefined || Array.isArray(container.command) && container.command.length === 0) &&
          (container.args === undefined || Array.isArray(container.args) && container.args.length === 0),
        'application-unreviewed-runtime-effect');
        const identityParts = assigned[0]!.split('/');
        await this.client.getIdentity(identityParts[4]!, identityParts.at(-1)!);
        const environmentId = String(target.expected.container_app_environment_id);
        const environment = await this.client.transport.request({
          method: 'GET', resourceId: environmentId, apiVersion: '2023-05-01'
        }, this.options.intent.binding);
        applicationUuid(environment.requestId, 'Actual managed environment GET request');
        must(environment.status === 200 && sameId(object(environment.data).id, environmentId) &&
          object(object(environment.data).properties).provisioningState === 'Succeeded', 'environment-not-ready');
      }
    }
    if (verify) {
      for (const [field, expected] of Object.entries(target.expected)) {
        must(applicationPrivateValue(values, field) === expected, 'independent-resource-readback');
      }
      if (!['azurerm_user_assigned_identity', 'azurerm_role_assignment'].includes(target.type)) {
        must(properties.provisioningState === 'Succeeded', 'resource-not-ready');
      }
    }
    let runtime: ApplicationPrivateObservation['runtime'] = null;
    if (verify && target.runtime) {
      const recipe = target.runtime;
      const url = applicationPrivateHealthUrl(recipe, artifact && 'role' in artifact ? artifact.role : undefined);
      must(applicationPrivateValue(values, 'ingress.0.fqdn') === url.hostname, 'runtime-host-binding');
      const bounded = AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
      await this.options.authorize();
      const health = await boundedStateOperation(bounded, async () => {
        const response = await (this.options.fetch ?? globalThis.fetch)(url.href, {
          method: 'GET', redirect: 'error', credentials: 'omit', signal: bounded,
          ...(recipe.kind === 'frontend-html/1' ? { cache: 'no-store' as const, referrerPolicy: 'no-referrer' as const } : {}),
          headers: { accept: recipe.kind === 'frontend-html/1' ? 'text/html' : 'application/json' }
        });
        if (recipe.kind === 'frontend-html/1') {
          try {
            must(response.status === 200 && !response.redirected &&
              /^text\/html(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/iu.test(response.headers.get('content-type') ?? ''),
            'runtime-html-readback');
            return { kind: recipe.kind, status: 200 as const, contentType: 'text/html' as const, bodyDigest: await readHtmlDocument(response) };
          } finally { await response.body?.cancel().catch(() => undefined); }
        }
        must(response.status === 200 && /^application\/json(?:;|$)/iu.test(response.headers.get('content-type') ?? ''),
          'runtime-health-readback');
        const body = await readApplicationPrivateResponse(response, 16_384);
        must(body[recipe.statusField] === recipe.statusValue, 'runtime-health-readback');
        return {};
      });
      runtime = { url: url.href, healthy: true, observedAt: this.now(), ...health };
    }
    return {
      address: target.address, resourceId: String(value.id), resourceType: contract.arm, exists: true, verified: verify,
      readbackRequestId: requestId, observedAt: this.now(), values: recordedValues(values) as Record<string, unknown>,
      privateDigest: canonicalSha256({ resourceId: String(value.id), body: value, dependencies: dependencyBinding }), runtime, dependencies,
      ...artifactBinding,
      ...(target.type === 'azurerm_container_app' && typeof properties.latestRevisionName === 'string'
        ? { revisionName: properties.latestRevisionName } : {})
    };
  }
}
