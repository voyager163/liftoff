import { randomUUID } from 'node:crypto';
import {
  AzurePrivateStatePath, PinnedPrivateAzureStateTransport,
  type PrivateNetworkProbe, type PrivateStateEffectRecorder, type PrivateStatePathTarget
} from '../../src/adapters/azure/private-state-path.js';
import type { AzureArmRequest, AzureArmResponse, AzureArmTransport } from '../../src/adapters/azure/activation-rest.js';
import type { AzureStateRequest, AzureStateResponse } from '../../src/domain/repair/stateful.js';
import { fixtureTime, fixtureStorageAccount, privateTarget } from './private-activation-fixture.js';

export class PrivateBlobHttpFixture {
  bytes: Uint8Array | null = null;
  version = 1;
  leaseId: string | null = null;
  operationId: string | null = null;
  calls: AzureStateRequest[] = [];
  unknownWrite = false;
  staleWrite = false;

  private response(status: number, headers: Record<string, string> = {}, body = new Uint8Array()): AzureStateResponse {
    return { status, body, headers: {
      'x-ms-request-id': randomUUID(), etag: `"0x${this.version.toString(16)}"`,
      'content-length': String(this.bytes?.byteLength ?? 0), 'x-ms-version-id': `2026-09-15T00:00:00.000000${this.version}Z`,
      'x-ms-server-encrypted': 'true', 'x-ms-lease-status': this.leaseId ? 'locked' : 'unlocked',
      'x-ms-lease-state': this.leaseId ? 'leased' : 'available',
      ...(this.operationId ? { 'x-ms-meta-liftoff-operation': this.operationId } : {}), ...headers
    } };
  }

  async send(request: AzureStateRequest): Promise<AzureStateResponse> {
    this.calls.push({ ...request, headers: { ...request.headers }, ...(request.body ? { body: Uint8Array.from(request.body) } : {}) });
    const headers = request.headers ?? {};
    if (request.target === 'container') return this.response(200);
    if (request.target === 'lease') {
      if (headers['x-ms-lease-action'] === 'acquire') {
        if (this.leaseId) return this.response(409, { 'x-ms-error-code': 'LeaseAlreadyPresent' });
        if (!this.bytes || headers['if-match'] !== `"0x${this.version.toString(16)}"`) return this.response(412);
        this.leaseId = headers['x-ms-proposed-lease-id']!;
        return this.response(201, { 'x-ms-lease-id': this.leaseId });
      }
      if (!this.leaseId || headers['x-ms-lease-id'] !== this.leaseId) return this.response(412);
      if (headers['x-ms-lease-action'] === 'renew') return this.response(200, { 'x-ms-lease-id': this.leaseId });
      if (headers['x-ms-lease-action'] === 'release') { this.leaseId = null; return this.response(200); }
      throw new Error('Unregistered lease action in HTTP fixture');
    }
    if (request.method === 'HEAD') return this.bytes ? this.response(200) : this.response(404, { 'x-ms-error-code': 'BlobNotFound' });
    if (request.method === 'GET') {
      if (!this.bytes || headers['if-match'] !== `"0x${this.version.toString(16)}"`) return this.response(412);
      return this.response(200, {}, Uint8Array.from(this.bytes));
    }
    if (request.method === 'PUT') {
      if (this.staleWrite) return this.response(412);
      if (this.bytes ? headers['if-match'] !== `"0x${this.version.toString(16)}"` || headers['x-ms-lease-id'] !== this.leaseId || !this.leaseId
        : headers['if-none-match'] !== '*') return this.response(412);
      this.bytes = Uint8Array.from(request.body!);
      this.operationId = headers['x-ms-meta-liftoff-operation']!;
      this.version++;
      if (this.unknownWrite) throw new Error('SYNTHETIC_SECRET_MUST_NOT_APPEAR');
      return this.response(201);
    }
    throw new Error('This fixture never permits state deletion.');
  }
}

export function privateStateHttpFixture(target: PrivateStatePathTarget = privateTarget(), effects?: PrivateStateEffectRecorder) {
  const armCalls: AzureArmRequest[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  const serviceId = `${fixtureStorageAccount}/blobServices/default`;
  const nicId = `${target.privateEndpointId.replace(/\/privateEndpoints\/[^/]+$/, '')}/networkInterfaces/private-state-nic`;
  rows.set(fixtureStorageAccount, {
    id: fixtureStorageAccount, type: 'Microsoft.Storage/storageAccounts', location: target.region,
    tags: { 'liftoff-repository-id': target.backend.ownerId },
    properties: { publicNetworkAccess: 'Disabled', allowBlobPublicAccess: false, minimumTlsVersion: 'TLS1_2',
      encryption: { services: { blob: { enabled: true } } }, primaryEndpoints: { blob: `https://${target.backend.account}.blob.core.windows.net/` } }
  });
  rows.set(serviceId, { id: serviceId, properties: { isVersioningEnabled: true, deleteRetentionPolicy: { enabled: true, days: 30 } } });
  rows.set(`${serviceId}/containers/${target.backend.container}`, {
    id: `${serviceId}/containers/${target.backend.container}`, properties: { publicAccess: 'None' }
  });
  rows.set(target.privateEndpointId, {
    id: target.privateEndpointId, location: target.region,
    properties: { provisioningState: 'Succeeded', subnet: { id: target.subnetId }, networkInterfaces: [{ id: nicId }],
      privateLinkServiceConnections: [{ properties: { privateLinkServiceId: fixtureStorageAccount,
        groupIds: ['blob'], privateLinkServiceConnectionState: { status: 'Approved' } } }] }
  });
  rows.set(nicId, { id: nicId, properties: {
    privateEndpoint: { id: target.privateEndpointId },
    ipConfigurations: [{ properties: { privateIPAddress: target.endpointAddress, subnet: { id: target.subnetId } } }]
  } });
  rows.set(target.privateDnsLinkId, {
    id: target.privateDnsLinkId, properties: { virtualNetwork: { id: target.virtualNetworkId },
      provisioningState: 'Succeeded', virtualNetworkLinkState: 'Completed', registrationEnabled: false }
  });
  rows.set(target.privateDnsZoneGroupId, {
    id: target.privateDnsZoneGroupId, properties: {
      privateDnsZoneConfigs: [{ properties: { privateDnsZoneId: target.privateDnsZoneId } }]
    }
  });
  rows.set(`${serviceId}/containers/${target.backend.container}/providers/Microsoft.Authorization/permissions`, {
    value: [{ actions: [], notActions: [], dataActions: ['Microsoft.Storage/storageAccounts/blobServices/containers/blobs/*'], notDataActions: [] }]
  });
  const arm: AzureArmTransport = {
    async request(request): Promise<AzureArmResponse> {
      armCalls.push(structuredClone(request));
      if (request.method !== 'GET') throw new Error('Read-only private path cannot mutate ARM.');
      const value = rows.get(request.resourceId);
      return { status: value ? 200 : 404, data: value ? structuredClone(value) : null, requestId: randomUUID() };
    }
  };
  const networkCalls: string[] = [];
  const network: PrivateNetworkProbe = {
    async observe(hostname, expectedAddress) {
      networkCalls.push(hostname);
      return { hostname, cname: hostname.replace('.blob.', '.privatelink.blob.'), addresses: [expectedAddress],
        connectedAddress: expectedAddress, tlsProtocol: 'TLSv1.3', observedAt: fixtureTime.getTime() };
    }
  };
  const blob = new PrivateBlobHttpFixture();
  const transport = new PinnedPrivateAzureStateTransport({
    target, network, effects, now: () => fixtureTime.getTime(),
    tokens: { async getToken() { return { token: 'SYNTHETIC_BEARER', tenantId: target.binding.tenantId,
      principalId: target.binding.principalId, expiresAt: fixtureTime.getTime() + 60_000 }; } },
    send: async (url, address, request, headers) => {
      if (url.hostname !== `${target.backend.account}.blob.core.windows.net` || address !== target.endpointAddress ||
        headers.host !== url.hostname) throw new Error('Private HTTPS request was not pinned.');
      return blob.send(request);
    }
  });
  const privatePath = new AzurePrivateStatePath({ target, arm, state: transport, network, now: () => fixtureTime.getTime() });
  return { path: privatePath, target, arm, armCalls, rows, network, networkCalls, blob, transport };
}
