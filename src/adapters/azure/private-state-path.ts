import { Resolver } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  StateMigrationError, type AzureBlobStateBinding, type AzureBlobAccessProvider, type AzureStateRequest,
  type AzureStateResponse, type AzureStateTokenProvider, type AzureStateTransport, type StateExecutionContext
} from '../../domain/repair/stateful.js';
import { stateAssert, stateBindingDigest } from '../../domain/repair/stateful-invariants.js';
import { AzureBlobStateBackend, azureStateUrl } from '../state/azure-blob.js';
import { nativeStateHostId } from '../state/native-system.js';
import {
  AzureArmError, azureArmBinding, azureArmUrl, createAzureCliArmTransport,
  type AzureArmBinding, type AzureArmTransport
} from './activation-rest.js';
import { isRecord } from '../../domain/governance/activation/canonical-json.js';
import { commandSucceeded } from '../../governance-activation/transition-process.js';
import type { CommandRunner } from '../../process-runner.js';

export interface PrivateStatePathTarget {
  binding: AzureArmBinding;
  backend: AzureBlobStateBinding;
  region: string;
  hostId: string;
  privateEndpointId: string;
  endpointAddress: string;
  subnetId: string;
  virtualNetworkId: string;
  privateDnsZoneId: string;
  privateDnsLinkId: string;
  privateDnsZoneGroupId: string;
}

export interface PrivateNetworkObservation {
  hostname: string;
  cname: string;
  addresses: readonly string[];
  connectedAddress: string;
  tlsProtocol: 'TLSv1.2' | 'TLSv1.3';
  observedAt: number;
}

export interface PrivateNetworkProbe {
  observe(hostname: string, expectedAddress: string, signal?: AbortSignal): Promise<PrivateNetworkObservation>;
}

export interface PrivateStateEffect {
  operationId: string;
  backendId: string;
  method: 'PUT' | 'DELETE';
  target: 'blob' | 'lease';
  action: 'acquire' | 'renew' | 'release' | 'write' | 'delete';
  expectedEtag: string | null;
}

export interface PrivateStateEffectRecorder {
  before(effect: PrivateStateEffect): Promise<string>;
  returned(checkpoint: string, response: { requestId: string; status: number; etag: string | null; versionId: string | null }): Promise<void>;
  uncertain(checkpoint: string): Promise<void>;
}

export interface PrivateStatePathObservation {
  target: PrivateStatePathTarget;
  network: PrivateNetworkObservation;
  requestIds: readonly string[];
  storage: {
    accountResourceId: string;
    containerResourceId: string;
    minimumTlsVersion: string;
    publicNetworkAccess: 'Disabled';
    versioning: true;
    softDeleteDays: number;
    serverSideEncryption: true;
  };
  permissions: {
    canReadMetadata: true;
    blobWriteCapability: boolean;
    leaseCapability: boolean;
    acquiredExclusiveLease: false;
  };
  observedAt: number;
  expiresAt: number;
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const nil = '00000000-0000-0000-0000-000000000000';
const readAction = 'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read';
const writeAction = 'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write';
const storageApi = '2023-05-01';
const networkApi = '2024-05-01';
const timeoutMs = 15_000;

function responseId(value: unknown): string {
  stateAssert(typeof value === 'string' && uuid.test(value) && value !== nil, 'incomplete-observation');
  return value.toLowerCase();
}

function object(value: unknown): Record<string, unknown> {
  stateAssert(isRecord(value), 'incomplete-observation');
  return value;
}

function sameId(left: unknown, right: string): boolean {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
}

function privateIp(value: string): boolean {
  const pieces = value.split('.');
  if (pieces.length !== 4 || pieces.some((part) => !/^(?:0|[1-9][0-9]{0,2})$/u.test(part) || Number(part) > 255)) return false;
  const [a, b] = pieces.map(Number);
  return a === 10 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168;
}

export function validatePrivateStatePathTarget(value: PrivateStatePathTarget): PrivateStatePathTarget {
  stateAssert(isRecord(value) && Object.keys(value).sort().join(',') ===
    ['binding', 'backend', 'region', 'hostId', 'privateEndpointId', 'endpointAddress', 'subnetId',
      'virtualNetworkId', 'privateDnsZoneId', 'privateDnsLinkId', 'privateDnsZoneGroupId'].sort().join(','), 'invalid-binding');
  stateAssert(isRecord(value.binding) && Object.keys(value.binding).sort().join(',') === 'principalId,subscriptionId,tenantId', 'invalid-binding');
  const binding = azureArmBinding(value.binding);
  stateBindingDigest(value.backend);
  stateAssert(value.backend.kind === 'azurerm' && value.backend.network === 'private' &&
    sameId(value.backend.subscriptionId, binding.subscriptionId) && sameId(value.backend.tenantId, binding.tenantId) &&
    typeof value.region === 'string' && /^[a-z][a-z0-9]{1,39}$/u.test(value.region) &&
    typeof value.hostId === 'string' && value.hostId.length > 0 && value.hostId.length <= 160 &&
    !/[\u0000-\u001f\u007f]/u.test(value.hostId) && typeof value.endpointAddress === 'string' && privateIp(value.endpointAddress), 'invalid-binding');
  for (const resourceId of [value.privateEndpointId, value.subnetId, value.virtualNetworkId, value.privateDnsZoneId, value.privateDnsLinkId, value.privateDnsZoneGroupId]) {
    azureArmUrl(resourceId, networkApi, binding.subscriptionId);
  }
  stateAssert(/\/providers\/Microsoft\.Network\/privateEndpoints\/[^/]+$/u.test(value.privateEndpointId) &&
    /\/providers\/Microsoft\.Network\/virtualNetworks\/[^/]+$/u.test(value.virtualNetworkId) &&
    value.subnetId.startsWith(`${value.virtualNetworkId}/subnets/`) &&
    value.subnetId.slice(value.virtualNetworkId.length + 9).split('/').length === 1 &&
    /\/providers\/Microsoft\.Network\/privateDnsZones\/privatelink\.blob\.core\.windows\.net$/u.test(value.privateDnsZoneId) &&
    value.privateDnsLinkId.startsWith(`${value.privateDnsZoneId}/virtualNetworkLinks/`) &&
    value.privateDnsLinkId.slice(value.privateDnsZoneId.length + 21).split('/').length === 1 &&
    value.privateDnsZoneGroupId.startsWith(`${value.privateEndpointId}/privateDnsZoneGroups/`) &&
    !value.privateDnsZoneGroupId.slice(value.privateEndpointId.length + 22).includes('/'), 'invalid-binding');
  const result = structuredClone({ ...value, binding,
    backend: { ...value.backend, subscriptionId: binding.subscriptionId, tenantId: binding.tenantId } });
  Object.freeze(result.binding);
  Object.freeze(result.backend);
  return Object.freeze(result);
}

export function createPrivateNetworkProbe(now: () => number = Date.now): PrivateNetworkProbe {
  return {
    async observe(hostname, expectedAddress, signal) {
      stateAssert(/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/u.test(hostname) && privateIp(expectedAddress), 'invalid-binding');
      const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
      const bounded = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
      const cancel = () => resolver.cancel();
      bounded.addEventListener('abort', cancel, { once: true });
      let cnames: string[], addresses: string[];
      try {
        stateAssert(!bounded.aborted, 'timeout');
        [cnames, addresses] = await Promise.all([resolver.resolveCname(hostname), resolver.resolve4(hostname)]);
      } catch {
        throw new StateMigrationError(bounded.aborted ? 'timeout' : 'access-denied');
      } finally { bounded.removeEventListener('abort', cancel); }
      const cname = hostname.replace('.blob.', '.privatelink.blob.');
      stateAssert(cnames.length === 1 && cnames[0]!.toLowerCase().replace(/\.$/u, '') === cname &&
        addresses.length === 1 && addresses[0] === expectedAddress, 'access-denied');
      const tls = await new Promise<{ connectedAddress: string; tlsProtocol: 'TLSv1.2' | 'TLSv1.3' }>((resolve, reject) => {
        const socket = tlsConnect({
          host: expectedAddress, port: 443, servername: hostname, rejectUnauthorized: true,
          minVersion: 'TLSv1.2', timeout: timeoutMs
        });
        const fail = () => { socket.destroy(); reject(new StateMigrationError(bounded.aborted ? 'timeout' : 'access-denied')); };
        bounded.addEventListener('abort', fail, { once: true });
        socket.once('timeout', fail);
        socket.once('error', fail);
        socket.once('close', () => bounded.removeEventListener('abort', fail));
        socket.once('secureConnect', () => {
          const protocol = socket.getProtocol();
          if (!socket.authorized || socket.remoteAddress !== expectedAddress || !['TLSv1.2', 'TLSv1.3'].includes(protocol ?? '')) {
            fail(); return;
          }
          resolve({ connectedAddress: expectedAddress, tlsProtocol: protocol as 'TLSv1.2' | 'TLSv1.3' });
          socket.destroy();
        });
        if (bounded.aborted) fail();
      });
      return { hostname, cname, addresses, ...tls, observedAt: now() };
    }
  };
}

export function createAzureCliStorageTokenProvider(
  runner: CommandRunner, projectRoot: string, requestedBinding: AzureArmBinding, now: () => number = Date.now
): AzureStateTokenProvider {
  const binding = azureArmBinding(requestedBinding);
  return {
    async getToken(request) {
      stateAssert(!request.signal.aborted && request.tenantId === binding.tenantId &&
        request.principalId === binding.principalId && request.scope === 'https://storage.azure.com/.default', 'access-denied');
      return readAzureCliPrivateToken(runner, projectRoot, binding, 'storage', request.signal, now);
    }
  };
}

export async function readAzureCliPrivateToken(
  runner: CommandRunner, projectRoot: string, requestedBinding: AzureArmBinding,
  purpose: 'storage' | 'log-analytics', signal: AbortSignal, now: () => number = Date.now
): ReturnType<AzureStateTokenProvider['getToken']> {
  const binding = azureArmBinding(requestedBinding);
  stateAssert(!signal.aborted && ['storage', 'log-analytics'].includes(purpose), 'access-denied');
  const resource = purpose === 'storage' ? 'https://storage.azure.com/' : 'https://api.loganalytics.io';
  const result = await runner.run({
    executable: 'az', args: ['account', 'get-access-token', '--subscription', binding.subscriptionId,
      '--tenant', binding.tenantId, '--resource', resource, '--output', 'json', '--only-show-errors']
  }, {
    cwd: projectRoot, timeoutMs, maxOutputBytes: 64 * 1024, stream: false,
    env: { AZURE_CORE_COLLECT_TELEMETRY: 'false', AZURE_CORE_ONLY_SHOW_ERRORS: 'true', AZURE_CORE_NO_COLOR: 'true' }
  }).catch(() => { throw new StateMigrationError('access-denied'); });
  let token: Record<string, unknown>;
  try {
    stateAssert(!signal.aborted && commandSucceeded(result) && !result.aborted && !result.outputLimitExceeded, 'access-denied');
    token = object(JSON.parse(result.stdout));
  } catch { throw new StateMigrationError('access-denied'); }
  finally { result.stdout = ''; result.stderr = ''; }
  stateAssert(token.tokenType === 'Bearer' && sameId(token.tenant, binding.tenantId) &&
    sameId(token.subscription, binding.subscriptionId) && typeof token.accessToken === 'string' &&
    token.accessToken.length <= 48 * 1024, 'access-denied');
  const value = token.accessToken;
  delete token.accessToken;
  const segments = value.split('.');
  stateAssert(segments.length === 3 && segments.every((segment) => /^[A-Za-z0-9_-]+$/u.test(segment)), 'access-denied');
  const bytes = Buffer.from(segments[1]!, 'base64url');
  let claims: Record<string, unknown>;
  try {
    stateAssert(isUtf8(bytes) && bytes.toString('base64url') === segments[1], 'access-denied');
    claims = object(JSON.parse(bytes.toString('utf8')));
  } catch { throw new StateMigrationError('access-denied'); }
  finally { bytes.fill(0); }
  const audiences = purpose === 'storage' ? ['https://storage.azure.com', 'https://storage.azure.com/']
    : ['https://api.loganalytics.io', 'https://api.loganalytics.io/'];
  stateAssert(sameId(claims.tid, binding.tenantId) && sameId(claims.oid, binding.principalId) &&
    audiences.includes(String(claims.aud)) && typeof claims.exp === 'number' && Number.isSafeInteger(claims.exp) &&
    claims.exp * 1000 > now() + 30_000 &&
    (claims.nbf === undefined || typeof claims.nbf === 'number' && Number.isSafeInteger(claims.nbf) && claims.nbf * 1000 <= now()), 'access-denied');
  return { token: value, tenantId: binding.tenantId, principalId: binding.principalId, expiresAt: claims.exp * 1000 };
}

const responseHeaders = [
  'etag', 'content-length', 'x-ms-version-id', 'x-ms-server-encrypted', 'x-ms-error-code',
  'x-ms-lease-id', 'x-ms-lease-status', 'x-ms-lease-state', 'x-ms-meta-liftoff-operation', 'x-ms-request-id'
];
const requestHeaders = new Set([
  'if-match', 'if-none-match', 'x-ms-lease-id', 'x-ms-lease-action', 'x-ms-lease-duration',
  'x-ms-proposed-lease-id', 'x-ms-blob-type', 'x-ms-meta-liftoff-operation', 'content-type'
]);

export class PinnedPrivateAzureStateTransport implements AzureStateTransport {
  constructor(private readonly options: {
    target: PrivateStatePathTarget;
    tokens: AzureStateTokenProvider;
    network: PrivateNetworkProbe;
    effects?: PrivateStateEffectRecorder;
    now?: () => number;
    send?: (url: URL, address: string, request: AzureStateRequest, headers: Record<string, string>, signal: AbortSignal) => Promise<AzureStateResponse>;
  }) { this.options = { ...options, target: validatePrivateStatePathTarget(options.target) }; }

  toJSON() { return { transport: 'pinned-private-azure-blob' }; }

  async request(request: AzureStateRequest): Promise<AzureStateResponse> {
    const target = this.options.target;
    stateAssert(stateBindingDigest(request.binding) === stateBindingDigest(target.backend) &&
      request.context.hostId === target.hostId && request.context.principalId === target.binding.principalId &&
      request.context.projectId === request.binding.ownerId, 'ownership-mismatch');
    stateAssert(request.target !== 'container' || request.method === 'HEAD', 'invalid-binding');
    stateAssert(request.target !== 'lease' || request.method === 'PUT', 'invalid-binding');
    stateAssert(['HEAD', 'GET', 'PUT', 'DELETE'].includes(request.method), 'invalid-binding');
    stateAssert(request.body === undefined || request.method === 'PUT' && request.target === 'blob', 'invalid-binding');
    stateAssert(request.operationId === undefined || typeof request.operationId === 'string' &&
      uuid.test(request.operationId) && request.operationId !== nil, 'invalid-binding');
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(request.signal ? [request.signal] : [])]);
    const url = new URL(azureStateUrl(request.binding, request.target));
    await this.options.network.observe(url.hostname, target.endpointAddress, signal);
    const credential = await this.options.tokens.getToken({
      tenantId: request.binding.tenantId, principalId: request.context.principalId,
      scope: 'https://storage.azure.com/.default', signal
    });
    stateAssert(credential.tenantId === target.binding.tenantId && credential.principalId === target.binding.principalId &&
      credential.expiresAt > (this.options.now?.() ?? Date.now()) + 30_000 &&
      typeof credential.token === 'string' && credential.token.length > 0 && !/[\r\n]/u.test(credential.token), 'access-denied');
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers ?? {})) {
      stateAssert(requestHeaders.has(key) && typeof value === 'string' && !/[\r\n]/u.test(value), 'invalid-binding');
      headers[key] = value;
    }
    const mutation = request.method === 'PUT' || request.method === 'DELETE';
    let checkpoint: string | null = null;
    if (mutation) {
      stateAssert(this.options.effects && typeof request.operationId === 'string' && uuid.test(request.operationId), 'approval-mismatch');
      const action = request.target === 'lease' ? headers['x-ms-lease-action'] : request.method === 'DELETE' ? 'delete' : 'write';
      stateAssert(['acquire', 'renew', 'release', 'write', 'delete'].includes(action ?? ''), 'invalid-binding');
      if (request.target === 'blob' && request.method === 'PUT') {
        stateAssert(headers['x-ms-meta-liftoff-operation'] === request.operationId &&
          headers['x-ms-blob-type'] === 'BlockBlob' &&
          (headers['if-none-match'] === '*' && headers['if-match'] === undefined ||
            /^"0x[a-f0-9]+"$/iu.test(headers['if-match'] ?? '') && headers['if-none-match'] === undefined &&
              uuid.test(headers['x-ms-lease-id'] ?? '')), 'invalid-binding');
      }
      if (request.target === 'lease') {
        stateAssert(action === 'acquire'
          ? headers['x-ms-lease-duration'] === '60' && uuid.test(headers['x-ms-proposed-lease-id'] ?? '') &&
            /^"0x[a-f0-9]+"$/iu.test(headers['if-match'] ?? '')
          : uuid.test(headers['x-ms-lease-id'] ?? ''), 'invalid-binding');
      }
      checkpoint = await this.options.effects.before({
        operationId: request.operationId!, backendId: request.binding.id, method: request.method as 'PUT' | 'DELETE',
        target: request.target as 'blob' | 'lease', action: action as PrivateStateEffect['action'],
        expectedEtag: headers['if-match'] ?? null
      });
      stateAssert(typeof checkpoint === 'string' && checkpoint.length > 0, 'approval-mismatch');
    }
    headers.authorization = `Bearer ${credential.token}`;
    headers.host = url.hostname;
    headers['x-ms-version'] = '2023-11-03';
    headers['x-ms-date'] = new Date(this.options.now?.() ?? Date.now()).toUTCString();
    headers['x-ms-client-request-id'] = request.operationId ?? randomUUID();
    try {
      stateAssert(!signal.aborted, 'timeout');
      const response = await (this.options.send ?? sendPrivateState)(url, target.endpointAddress, request, headers, signal);
      const requestId = responseId(response.headers['x-ms-request-id']);
      if (checkpoint) await this.options.effects!.returned(checkpoint, {
        requestId, status: response.status, etag: response.headers.etag ?? null, versionId: response.headers['x-ms-version-id'] ?? null
      });
      return response;
    } catch {
      if (checkpoint) await this.options.effects!.uncertain(checkpoint);
      throw new StateMigrationError(signal.aborted ? 'timeout' : checkpoint ? 'recovery-required' : 'access-denied');
    } finally { delete headers.authorization; credential.token = ''; }
  }
}

function sendPrivateState(
  url: URL, address: string, request: AzureStateRequest, headers: Record<string, string>, signal: AbortSignal
): Promise<AzureStateResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const req = httpsRequest({
      protocol: 'https:', hostname: address, port: 443, servername: url.hostname,
      method: request.method, path: `${url.pathname}${url.search}`, headers, agent: false,
      rejectUnauthorized: true, minVersion: 'TLSv1.2', signal, timeout: timeoutMs
    }, (response) => {
      const safeHeaders: Record<string, string> = {};
      for (const name of responseHeaders) {
        const value = response.headers[name];
        if (typeof value === 'string') safeHeaders[name] = value;
      }
      response.on('data', (bytes: Buffer) => {
        size += bytes.length;
        if (request.method === 'HEAD' || size > 32 * 1024 * 1024) {
          bytes.fill(0); req.destroy(new StateMigrationError('storage-limit'));
        } else chunks.push(bytes);
      });
      response.once('error', () => req.destroy(new StateMigrationError('incomplete-observation')));
      response.once('aborted', () => req.destroy(new StateMigrationError('incomplete-observation')));
      response.once('end', () => {
        const body = Buffer.concat(chunks);
        for (const chunk of chunks) chunk.fill(0);
        resolve({ status: response.statusCode ?? 0, headers: safeHeaders, body });
      });
    });
    req.once('timeout', () => req.destroy(new StateMigrationError('timeout')));
    req.once('error', () => { for (const chunk of chunks) chunk.fill(0); reject(new StateMigrationError(signal.aborted ? 'timeout' : 'access-denied')); });
    req.end(request.body ? Buffer.from(request.body) : undefined);
  });
}

function allowed(pattern: string, action: string): boolean {
  if (!/^[A-Za-z0-9.*\/]+$/u.test(pattern)) return false;
  return new RegExp(`^${pattern.replaceAll('.', '\\.').replaceAll('*', '.*')}$`, 'iu').test(action);
}

export class AzurePrivateStatePath implements AzureBlobAccessProvider {
  readonly target: PrivateStatePathTarget;
  readonly backend: AzureBlobStateBackend;
  #observation: PrivateStatePathObservation | null = null;
  constructor(private readonly options: {
    target: PrivateStatePathTarget;
    arm: AzureArmTransport;
    state: AzureStateTransport;
    network: PrivateNetworkProbe;
    now?: () => number;
  }) {
    this.target = validatePrivateStatePathTarget(options.target);
    this.backend = new AzureBlobStateBackend(this.target.backend, { transport: options.state, access: this, now: options.now });
  }

  toJSON() { return { adapter: 'azure-private-state-path', backendId: this.target.backend.id }; }

  private async arm(resourceId: string, apiVersion: string, ids: string[]): Promise<Record<string, unknown>> {
    const response = await this.options.arm.request({ method: 'GET', resourceId, apiVersion }, this.target.binding);
    stateAssert(response.status === 200, 'incomplete-observation');
    ids.push(responseId(response.requestId));
    return object(response.data);
  }

  async inspect(context: StateExecutionContext, signal?: AbortSignal): Promise<PrivateStatePathObservation> {
    const target = this.target;
    stateAssert(context.projectId === target.backend.ownerId && context.principalId === target.binding.principalId &&
      context.hostId === target.hostId, 'ownership-mismatch');
    stateAssert(!signal?.aborted, 'cancelled');
    const ids: string[] = [];
    const accountId = `/subscriptions/${target.binding.subscriptionId}/resourceGroups/${target.backend.resourceGroup}/providers/Microsoft.Storage/storageAccounts/${target.backend.account}`;
    const account = await this.arm(accountId, storageApi, ids);
    const properties = object(account.properties);
    stateAssert(sameId(account.id, accountId) && account.type === 'Microsoft.Storage/storageAccounts' &&
      account.location === target.region && object(account.tags)['liftoff-repository-id'] === target.backend.ownerId &&
      properties.publicNetworkAccess === 'Disabled' && properties.allowBlobPublicAccess === false &&
      ['TLS1_2', 'TLS1_3'].includes(String(properties.minimumTlsVersion)) &&
      object(object(object(properties.encryption).services).blob).enabled === true &&
      object(properties.primaryEndpoints).blob === `https://${target.backend.account}.blob.core.windows.net/`, 'ownership-mismatch');
    const serviceId = `${accountId}/blobServices/default`;
    const service = await this.arm(serviceId, storageApi, ids);
    const blob = object(service.properties);
    const deletion = object(blob.deleteRetentionPolicy);
    stateAssert(sameId(service.id, serviceId) && blob.isVersioningEnabled === true && deletion.enabled === true &&
      typeof deletion.days === 'number' && Number.isInteger(deletion.days) && deletion.days >= 1 && deletion.days <= 365, 'unsupported-encryption');
    const containerId = `${serviceId}/containers/${target.backend.container}`;
    const container = await this.arm(containerId, storageApi, ids);
    stateAssert(sameId(container.id, containerId) && object(container.properties).publicAccess === 'None', 'access-denied');
    const endpoint = await this.arm(target.privateEndpointId, networkApi, ids);
    const ep = object(endpoint.properties);
    stateAssert(sameId(endpoint.id, target.privateEndpointId) && endpoint.location === target.region &&
      ep.provisioningState === 'Succeeded' && sameId(object(ep.subnet).id, target.subnetId) &&
      Array.isArray(ep.privateLinkServiceConnections) && ep.privateLinkServiceConnections.length === 1, 'access-denied');
    const connection = object(object(ep.privateLinkServiceConnections[0]).properties);
    stateAssert(sameId(connection.privateLinkServiceId, accountId) &&
      Array.isArray(connection.groupIds) && connection.groupIds.length === 1 && connection.groupIds[0] === 'blob' &&
      object(connection.privateLinkServiceConnectionState).status === 'Approved', 'access-denied');
    stateAssert(Array.isArray(ep.networkInterfaces) && ep.networkInterfaces.length === 1, 'incomplete-observation');
    const nicId = object(ep.networkInterfaces[0]).id;
    stateAssert(typeof nicId === 'string' && /\/providers\/Microsoft\.Network\/networkInterfaces\/[^/]+$/u.test(nicId), 'incomplete-observation');
    const nic = await this.arm(nicId, networkApi, ids);
    const networkInterface = object(nic.properties);
    stateAssert(sameId(nic.id, nicId) && sameId(object(networkInterface.privateEndpoint).id, target.privateEndpointId) &&
      Array.isArray(networkInterface.ipConfigurations) && networkInterface.ipConfigurations.length === 1, 'access-denied');
    const nicIp = object(object(networkInterface.ipConfigurations[0]).properties);
    stateAssert(nicIp.privateIPAddress === target.endpointAddress && sameId(object(nicIp.subnet).id, target.subnetId), 'access-denied');
    const link = await this.arm(target.privateDnsLinkId, '2020-06-01', ids);
    const linkProperties = object(link.properties);
    stateAssert(sameId(link.id, target.privateDnsLinkId) &&
      sameId(object(linkProperties.virtualNetwork).id, target.virtualNetworkId) &&
      linkProperties.registrationEnabled === false && linkProperties.provisioningState === 'Succeeded' &&
      linkProperties.virtualNetworkLinkState === 'Completed', 'access-denied');
    const zoneGroup = await this.arm(target.privateDnsZoneGroupId, networkApi, ids);
    const zones = object(zoneGroup.properties).privateDnsZoneConfigs;
    stateAssert(Array.isArray(zones) && zones.length === 1 &&
      sameId(object(object(zones[0]).properties).privateDnsZoneId, target.privateDnsZoneId), 'access-denied');
    const permissions = await this.arm(`${containerId}/providers/Microsoft.Authorization/permissions`, '2022-04-01', ids);
    stateAssert(Array.isArray(permissions.value) && permissions.value.length <= 128 && !permissions.nextLink, 'incomplete-observation');
    const grants = permissions.value.map((entry) => {
      const permission = object(entry);
      stateAssert(Array.isArray(permission.dataActions) && permission.dataActions.every((v) => typeof v === 'string') &&
        Array.isArray(permission.notDataActions) && permission.notDataActions.every((v) => typeof v === 'string') &&
        !permission.condition, 'access-denied');
      return { data: permission.dataActions as string[], excluded: permission.notDataActions as string[] };
    });
    const permits = (action: string) => grants.some((grant) => grant.data.some((pattern) => allowed(pattern, action)) &&
      !grant.excluded.some((pattern) => allowed(pattern, action)));
    stateAssert(permits(readAction), 'access-denied');
    const network = await this.options.network.observe(`${target.backend.account}.blob.core.windows.net`, target.endpointAddress, signal);
    const metadata = await this.options.state.request({ binding: target.backend, context, method: 'HEAD', target: 'container', signal });
    try {
      stateAssert(metadata.status === 200, 'access-denied');
      ids.push(responseId(metadata.headers['x-ms-request-id']));
    } finally { metadata.body.fill(0); }
    const now = this.options.now?.() ?? Date.now();
    this.#observation = {
      target, network, requestIds: ids,
      storage: {
        accountResourceId: accountId, containerResourceId: containerId,
        minimumTlsVersion: String(properties.minimumTlsVersion), publicNetworkAccess: 'Disabled',
        versioning: true, softDeleteDays: deletion.days, serverSideEncryption: true
      },
      permissions: { canReadMetadata: true, blobWriteCapability: permits(writeAction), leaseCapability: permits(writeAction), acquiredExclusiveLease: false },
      observedAt: now, expiresAt: now + 10_000
    };
    return structuredClone(this.#observation);
  }

  async observe(binding: AzureBlobStateBinding, context: StateExecutionContext, write: boolean, signal?: AbortSignal) {
    stateAssert(stateBindingDigest(binding) === stateBindingDigest(this.target.backend) &&
      context.hostId === this.target.hostId && context.principalId === this.target.binding.principalId &&
      context.projectId === binding.ownerId, 'ownership-mismatch');
    const now = this.options.now?.() ?? Date.now();
    const observation = this.#observation && this.#observation.expiresAt > now ? this.#observation : await this.inspect(context, signal);
    stateAssert(!write || observation.permissions.blobWriteCapability, 'access-denied');
    return {
      bindingDigest: stateBindingDigest(binding), ownerId: binding.ownerId, hostId: this.target.hostId,
      principalId: this.target.binding.principalId, network: 'private' as const, reachable: true, canRead: true,
      canWrite: observation.permissions.blobWriteCapability, serverSideEncryption: true, versioning: true, softDelete: true,
      expiresAt: observation.expiresAt
    };
  }
}

export function createAzureCliPrivateStatePath(
  runner: CommandRunner, projectRoot: string, target: PrivateStatePathTarget,
  options: { arm?: AzureArmTransport; effects?: PrivateStateEffectRecorder; now?: () => number } = {}
): AzurePrivateStatePath {
  const checked = validatePrivateStatePathTarget(target);
  stateAssert(checked.hostId === nativeStateHostId(), 'ownership-mismatch');
  const network = createPrivateNetworkProbe(options.now);
  const transport = new PinnedPrivateAzureStateTransport({
    target: checked, tokens: createAzureCliStorageTokenProvider(runner, projectRoot, checked.binding, options.now),
    network, effects: options.effects, now: options.now
  });
  return new AzurePrivateStatePath({
    target: checked, network, state: transport,
    arm: options.arm ?? createAzureCliArmTransport(runner, projectRoot), now: options.now
  });
}

export function safePrivateStateFailure(error: unknown): string {
  if (error instanceof StateMigrationError) return error.message;
  if (error instanceof AzureArmError) return `Private path ARM observation failed (${error.code}); provider diagnostics were withheld.`;
  return 'Private state observation is incomplete; state and credential diagnostics were withheld.';
}
