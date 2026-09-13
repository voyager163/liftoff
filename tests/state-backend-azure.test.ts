import { describe, expect, it, vi } from 'vitest';
import {
  AzureBlobStateBackend, FetchAzureStateTransport, azureStateUrl,
  type AzureBlobAccessProvider, type AzureStateRequest, type AzureStateResponse, type AzureStateTransport
} from '../src/adapters/state/azure-blob.js';
import { type AzureBlobStateBinding, type StateBackendLease } from '../src/domain/repair/stateful.js';
import { inspectStateBytes, stateBindingDigest, stateDigest } from '../src/domain/repair/stateful-invariants.js';
import { binding, context, fixtureNow, sourceInstances, stateBytes } from './fixtures/state-migration/fakes.js';

class SyntheticBlobTransport implements AzureStateTransport {
  calls: AzureStateRequest[] = [];
  bytes: Uint8Array | null = stateBytes(sourceInstances);
  version = 1;
  leaseId: string | null = null;
  operationId: string | undefined;
  absentError = 'BlobNotFound';
  containerStatus = 200;
  failLeaseRenewal = false;
  beforePut: (() => void) | null = null;
  reply(status: number, headers: Record<string, string> = {}, body = new Uint8Array()): AzureStateResponse {
    return {
      status, headers: {
        etag: `"0x${this.version.toString(16)}"`, 'x-ms-version-id': `2026-09-12T00:00:00.${this.version}Z`,
        'x-ms-server-encrypted': 'true', 'content-length': String(this.bytes?.byteLength ?? 0),
        ...(this.operationId ? { 'x-ms-meta-liftoff-operation': this.operationId } : {}), ...headers
      }, body
    };
  }
  async request(request: AzureStateRequest): Promise<AzureStateResponse> {
    this.calls.push({ ...request, ...(request.body ? { body: Uint8Array.from(request.body) } : {}) });
    const headers = request.headers ?? {};
    if (request.target === 'container') return this.reply(this.containerStatus);
    if (request.target === 'lease') {
      if (headers['x-ms-lease-action'] === 'acquire') {
        if (this.leaseId || headers['if-match'] !== `"0x${this.version.toString(16)}"`) return this.reply(412);
        this.leaseId = headers['x-ms-proposed-lease-id'];
        return this.reply(201, { 'x-ms-lease-id': this.leaseId });
      }
      if (headers['x-ms-lease-id'] !== this.leaseId) return this.reply(412);
      if (headers['x-ms-lease-action'] === 'renew') return this.reply(this.failLeaseRenewal ? 412 : 200);
      if (headers['x-ms-lease-action'] === 'release') { this.leaseId = null; return this.reply(200); }
      throw new Error('Unexpected synthetic lease action');
    }
    if (request.method === 'HEAD') {
      return this.bytes ? this.reply(200) : this.reply(404, { 'x-ms-error-code': this.absentError });
    }
    if (request.method === 'GET') {
      return headers['if-match'] === `"0x${this.version.toString(16)}"` && this.bytes
        ? this.reply(200, {}, Uint8Array.from(this.bytes)) : this.reply(412);
    }
    if (request.method === 'PUT') {
      this.beforePut?.();
      if (this.bytes) {
        if (headers['if-match'] !== `"0x${this.version.toString(16)}"` || headers['x-ms-lease-id'] !== this.leaseId || !this.leaseId) return this.reply(412);
      } else if (headers['if-none-match'] !== '*') return this.reply(412);
      this.bytes = Uint8Array.from(request.body!);
      this.operationId = headers['x-ms-meta-liftoff-operation'];
      this.version++;
      return this.reply(201);
    }
    if (request.method === 'DELETE') {
      if (headers['if-match'] !== `"0x${this.version.toString(16)}"` || headers['x-ms-lease-id'] !== this.leaseId || !this.leaseId) return this.reply(412);
      this.bytes = null;
      this.leaseId = null;
      this.version++;
      return this.reply(202);
    }
    throw new Error('Unexpected synthetic blob operation');
  }
}

function access(bound: AzureBlobStateBinding, now: () => number): AzureBlobAccessProvider {
  return {
    async observe() {
      return {
        bindingDigest: stateBindingDigest(bound), ownerId: bound.ownerId, hostId: context().hostId,
        principalId: context().principalId, network: bound.network, reachable: true,
        canRead: true, canWrite: true, serverSideEncryption: true, versioning: true, softDelete: true,
        expiresAt: now() + 60_000
      };
    }
  };
}

function fixture() {
  const transport = new SyntheticBlobTransport();
  const bound = binding('source') as AzureBlobStateBinding;
  const clock = { now: fixtureNow };
  const provider = access(bound, () => clock.now);
  const backend = new AzureBlobStateBackend(bound, { transport, access: provider, now: () => clock.now });
  return { transport, bound, clock, backend, provider };
}

describe('Azure Blob state backend contract (deterministic transport, no live qualification)', () => {
  it('uses only HEAD for metadata; absence additionally proves the named container is accessible', async () => {
    const { backend, transport } = fixture();
    const present = await backend.metadata(context());
    expect(present.exists).toBe(true);
    expect(transport.calls.map((call) => [call.method, call.target])).toEqual([['HEAD', 'blob']]);
    transport.bytes = null;
    const absent = await backend.metadata(context());
    expect(absent.exists).toBe(false);
    expect(transport.calls.slice(1).map((call) => [call.method, call.target])).toEqual([['HEAD', 'blob'], ['HEAD', 'container']]);
    expect(transport.calls.some((call) => call.method === 'GET')).toBe(false);
  });

  it.each(['ContainerNotFound', 'AuthorizationFailure', ''])('does not accept %s as negative blob proof', async (code) => {
    const { backend, transport } = fixture();
    transport.bytes = null;
    transport.absentError = code;
    await expect(backend.metadata(context())).rejects.toMatchObject({ code: 'incomplete-observation' });
  });

  it('reads only the approved version and rejects a racing ETag', async () => {
    const { backend, transport } = fixture();
    const metadata = await backend.metadata(context());
    const bytes = await backend.readPrivate(metadata, context());
    expect(Buffer.from(bytes)).toEqual(stateBytes(sourceInstances));
    expect(transport.calls.find((call) => call.method === 'GET')?.headers).toEqual({ 'if-match': metadata.etag });
    transport.version++;
    await expect(backend.readPrivate(metadata, context())).rejects.toMatchObject({ code: 'stale-state' });
  });

  it('takes a per-blob lease and publishes with both its owned lease ID and exact If-Match', async () => {
    const { backend, transport } = fixture();
    const metadata = await backend.metadata(context());
    const expected = inspectStateBytes(metadata, transport.bytes).snapshot;
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const lease = await backend.acquire(metadata, context(), id);
    try {
      const candidate = stateBytes(sourceInstances, expected.lineage!, expected.serial! + 1);
      await backend.writePrivate({ bytes: candidate, expected, lease, context: context(), operationId: id });
      const write = transport.calls.find((call) => call.method === 'PUT' && call.target === 'blob')!;
      expect(write.headers!['if-match']).toBe(metadata.etag);
      expect(write.headers!['x-ms-lease-id']).toBe(transport.leaseId);
      expect(write.headers!['x-ms-meta-liftoff-operation']).toBe(id);
      const acquire = transport.calls.find((call) => call.headers?.['x-ms-lease-action'] === 'acquire')!;
      expect(acquire.target).toBe('lease');
      expect(azureStateUrl(acquire.binding, acquire.target)).toContain('/source.tfstate?comp=lease');
      expect(acquire.headers!['x-ms-lease-duration']).toBe('60');
      expect(transport.calls.some((call) => call.target === 'container' && call.method !== 'HEAD')).toBe(false);
    } finally { await lease.release(); }
    expect(transport.leaseId).toBeNull();
    expect(transport.calls.some((call) => call.headers?.['x-ms-lease-action'] === 'break')).toBe(false);
  });

  it('atomically creates an absent destination, then leases the exact created version', async () => {
    const { backend, transport } = fixture();
    transport.bytes = null;
    const metadata = await backend.metadata(context());
    const expected = inspectStateBytes(metadata, null).snapshot;
    const lease = await backend.acquire(metadata, context(), 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
    expect(lease.kind).toBe('conditional-create');
    try {
      await backend.writePrivate({
        bytes: stateBytes(sourceInstances), expected, lease, context: context(),
        operationId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
      });
      const write = transport.calls.find((call) => call.method === 'PUT' && call.target === 'blob')!;
      expect(write.headers!['if-none-match']).toBe('*');
      expect(write.headers!['x-ms-lease-id']).toBeUndefined();
      const acquire = transport.calls.find((call) => call.headers?.['x-ms-lease-action'] === 'acquire')!;
      expect(acquire.headers!['if-match']).toBe(`"0x${transport.version.toString(16)}"`);
      expect(lease.kind).toBe('blob-lease');
    } finally { await lease.release(); }
  });

  it('never overwrites a destination that appears at the conditional-create boundary', async () => {
    const { backend, transport } = fixture();
    transport.bytes = null;
    const metadata = await backend.metadata(context());
    const lease = await backend.acquire(metadata, context(), 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
    const concurrent = stateBytes([{ address: 'azurerm_resource_group.foreign', id: '/synthetic/unrelated' }], 'other-lineage', 4);
    transport.beforePut = () => { transport.bytes = concurrent; transport.version++; };
    try {
      await expect(backend.writePrivate({
        bytes: stateBytes(sourceInstances), expected: inspectStateBytes(metadata, null).snapshot,
        lease, context: context(), operationId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
      })).rejects.toMatchObject({ code: 'stale-state' });
      expect(transport.bytes).toEqual(concurrent);
    } finally { await lease.release(); }
  });

  it.each(['serial', 'lineage', 'digest'] as const)('checks %s under the lease, not only Azure metadata', async (change) => {
    const { backend, transport } = fixture();
    const metadata = await backend.metadata(context());
    const expected = inspectStateBytes(metadata, transport.bytes).snapshot;
    const lease = await backend.acquire(metadata, context(), 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
    try {
      const text = Buffer.from(transport.bytes!).toString();
      transport.bytes = Buffer.from(change === 'serial' ? text.replace('"serial":7', '"serial":8')
        : change === 'lineage' ? text.replace('fixture-source-lineage', 'fixture-source-lineagX')
          : text.replace('SYNTHETIC_STATE_VALUE', 'XYNTHETIC_STATE_VALUE'));
      await expect(backend.writePrivate({
        bytes: stateBytes(sourceInstances, expected.lineage!, expected.serial! + 1),
        expected, lease, context: context(), operationId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
      })).rejects.toMatchObject({ code: 'stale-state' });
      expect(transport.calls.some((call) => call.target === 'blob' && call.method === 'PUT')).toBe(false);
    } finally { await lease.release(); }
  });

  it('detects lease loss and expiry without releasing or breaking another owner lock', async () => {
    const { backend, transport, clock } = fixture();
    const metadata = await backend.metadata(context());
    const lease = await backend.acquire(metadata, context(), 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
    transport.leaseId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
    await expect(lease.assertHeld()).rejects.toMatchObject({ code: 'lock-lost' });
    await expect(lease.release()).rejects.toMatchObject({ code: 'lock-lost' });
    expect(transport.leaseId).toBe('bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb');
    transport.leaseId = null;
    const another = await backend.acquire(metadata, context(), 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
    clock.now += 61_000;
    await expect(another.assertHeld()).rejects.toMatchObject({ code: 'lock-lost' });
    await another.release();
    expect(transport.calls.some((call) => call.headers?.['x-ms-lease-action'] === 'break')).toBe(false);
  });

  it('does not accept a forged lease or decreasing serial/different lineage publication', async () => {
    const { backend, transport } = fixture();
    const metadata = await backend.metadata(context());
    const expected = inspectStateBytes(metadata, transport.bytes).snapshot;
    const forged: StateBackendLease = { backendId: 'source', kind: 'blob-lease', async assertHeld() {}, async release() {} };
    await expect(backend.writePrivate({ bytes: stateBytes(sourceInstances), expected, lease: forged, context: context(), operationId: 'fixture' }))
      .rejects.toMatchObject({ code: 'lock-lost' });
    const lease = await backend.acquire(metadata, context(), 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
    try {
      for (const candidate of [stateBytes(sourceInstances, 'different-lineage', 7), stateBytes(sourceInstances, expected.lineage!, 1)]) {
        await expect(backend.writePrivate({ bytes: candidate, expected, lease, context: context(), operationId: 'fixture' }))
          .rejects.toMatchObject({ code: 'stale-state' });
      }
      expect(transport.calls.some((call) => call.target === 'blob' && call.method === 'PUT')).toBe(false);
    } finally { await lease.release(); }
  });

  it('keeps encryption, versioning, private routing, ownership and current access as prerequisites', async () => {
    const { backend, provider, transport } = fixture();
    const original = provider.observe;
    for (const changes of [
      { versioning: false }, { softDelete: false }, { serverSideEncryption: false },
      { reachable: false }, { network: 'public' as const }, { ownerId: 'unrelated' }, { hostId: 'other-host' }
    ]) {
      provider.observe = async (...args) => ({ ...await original(...args), ...changes });
      await expect(backend.metadata(context())).rejects.toBeInstanceOf(Error);
    }
    expect(transport.calls).toHaveLength(0);
  });
});

describe('bounded private Azure authentication and endpoint transport', () => {
  it('places a short-lived token only in an HTTPS authorization header with redirects disabled', async () => {
    const token = 'SYNTHETIC_AZURE_TOKEN_NOT_A_REAL_CREDENTIAL';
    const fakeFetch = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) =>
      new Response(null, { status: 200, headers: { etag: '"0x1"', 'content-length': '0' } }));
    const transport = new FetchAzureStateTransport({
      now: () => fixtureNow, fetch: fakeFetch,
      tokens: { async getToken(request) { return { token, tenantId: request.tenantId, principalId: request.principalId, expiresAt: fixtureNow + 60_000 }; } }
    });
    const result = await transport.request({ binding: binding('source') as AzureBlobStateBinding, context: context(), method: 'HEAD', target: 'blob' });
    expect(fakeFetch.mock.calls[0][0]).toBe('https://liftoffsynthetic.blob.core.windows.net/state-fixtures/source.tfstate');
    expect(fakeFetch.mock.calls[0][1]?.redirect).toBe('error');
    expect((fakeFetch.mock.calls[0][1]?.headers as Record<string, string>).authorization).toBe(`Bearer ${token}`);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(transport)).not.toContain(token);
  });

  it('rejects wrong identity, expired tokens, arbitrary endpoints and credential-shaped paths without fetching', async () => {
    const fakeFetch = vi.fn();
    const bound = binding('source') as AzureBlobStateBinding;
    for (const current of [
      { ...bound, account: 'evil.example.com' }, { ...bound, key: '../../outside' }, { ...bound, key: 'state?sig=SYNTHETIC' }
    ]) expect(() => azureStateUrl(current, 'blob')).toThrow();
    const transport = new FetchAzureStateTransport({
      now: () => fixtureNow, fetch: fakeFetch,
      tokens: { async getToken() { return { token: 'SYNTHETIC', tenantId: 'wrong', principalId: 'wrong', expiresAt: fixtureNow - 1 }; } }
    });
    await expect(transport.request({ binding: bound, context: context(), method: 'GET', target: 'blob' })).rejects.toMatchObject({ code: 'access-denied' });
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('bounds response bytes and never exposes a raw error body', async () => {
    const transport = new FetchAzureStateTransport({
      now: () => fixtureNow, maxResponseBytes: 16,
      fetch: async () => new Response('SYNTHETIC_STATE_SECRET_ERROR_BODY_EXCEEDING_LIMIT', { status: 500 }),
      tokens: { async getToken(request) { return { token: 'SYNTHETIC', tenantId: request.tenantId, principalId: request.principalId, expiresAt: fixtureNow + 60_000 }; } }
    });
    let error: unknown;
    try { await transport.request({ binding: binding('source') as AzureBlobStateBinding, context: context(), method: 'GET', target: 'blob' }); }
    catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'storage-limit' });
    expect(String(error)).not.toContain('SYNTHETIC_STATE_SECRET');
  });

  it('stops a nonresponsive HTTP request using a finite abort signal', async () => {
    const transport = new FetchAzureStateTransport({
      now: () => fixtureNow, timeoutMs: 20,
      fetch: (_url, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('SYNTHETIC_SECRET')), { once: true })),
      tokens: { async getToken(request) { return { token: 'SYNTHETIC', tenantId: request.tenantId, principalId: request.principalId, expiresAt: fixtureNow + 60_000 }; } }
    });
    await expect(transport.request({ binding: binding('source') as AzureBlobStateBinding, context: context(), method: 'HEAD', target: 'blob' }))
      .rejects.toMatchObject({ code: 'timeout' });
  });

  it('also bounds an unavailable token provider that does not honor cancellation', async () => {
    const fakeFetch = vi.fn();
    const transport = new FetchAzureStateTransport({
      timeoutMs: 20, fetch: fakeFetch,
      tokens: { getToken: () => new Promise(() => undefined) }
    });
    await expect(transport.request({ binding: binding('source') as AzureBlobStateBinding, context: context(), method: 'HEAD', target: 'blob' }))
      .rejects.toMatchObject({ code: 'timeout' });
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});
