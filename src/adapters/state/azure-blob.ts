import { randomUUID } from 'node:crypto';
import {
  StateMigrationError,
  type AzureBlobAccessProvider,
  type AzureBlobStateBinding,
  type AzureStateRequest,
  type AzureStateResponse,
  type AzureStateTokenProvider,
  type AzureStateTransport,
  type StateBackendAdapter,
  type StateBackendLease,
  type StateBackendMetadata,
  type StateExecutionContext,
  type StateSnapshot
} from '../../domain/repair/stateful.js';
import {
  inspectStateBytes, stateAssert, stateBindingDigest, stateMetadataMatches, stateSnapshotMatches
} from '../../domain/repair/stateful-invariants.js';
import { boundedStateOperation } from '../../domain/repair/stateful-bounded.js';

export type {
  AzureBlobAccessProvider, AzureStateRequest, AzureStateResponse, AzureStateTokenProvider, AzureStateTransport
} from '../../domain/repair/stateful.js';

const responseHeaders = [
  'etag', 'content-length', 'x-ms-version-id', 'x-ms-server-encrypted',
  'x-ms-error-code', 'x-ms-lease-id', 'x-ms-lease-status', 'x-ms-lease-state',
  'x-ms-meta-liftoff-operation'
] as const;
const requestHeaders = new Set([
  'if-match', 'if-none-match', 'x-ms-lease-id', 'x-ms-lease-action', 'x-ms-lease-duration',
  'x-ms-proposed-lease-id', 'x-ms-blob-type', 'x-ms-meta-liftoff-operation', 'content-type'
]);

export function azureStateUrl(binding: AzureBlobStateBinding, target: AzureStateRequest['target']): string {
  stateBindingDigest(binding);
  const base = `https://${binding.account}.blob.core.windows.net/${binding.container}`;
  return target === 'container'
    ? `${base}?restype=container&comp=metadata`
    : `${base}/${binding.key.split('/').map(encodeURIComponent).join('/')}${target === 'lease' ? '?comp=lease' : ''}`;
}

export class FetchAzureStateTransport implements AzureStateTransport {
  constructor(private readonly options: {
    tokens: AzureStateTokenProvider;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    maxResponseBytes?: number;
    now?: () => number;
  }) {}

  toJSON(): { transport: string } { return { transport: 'azure-blob-private-capture' }; }

  async request(request: AzureStateRequest): Promise<AzureStateResponse> {
    stateBindingDigest(request.binding);
    stateAssert(request.target !== 'container' || request.method === 'HEAD', 'invalid-binding');
    stateAssert(request.target !== 'lease' || request.method === 'PUT', 'invalid-binding');
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    stateAssert(timeoutMs > 0 && timeoutMs <= 120_000, 'invalid-binding');
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(request.signal ? [request.signal] : [])]);
    return boundedStateOperation(signal, () => this.perform(request, signal));
  }

  private async perform(request: AzureStateRequest, signal: AbortSignal): Promise<AzureStateResponse> {
    try {
      const token = await this.options.tokens.getToken({
        tenantId: request.binding.tenantId, principalId: request.context.principalId,
        scope: 'https://storage.azure.com/.default', signal
      });
      stateAssert(token.tenantId === request.binding.tenantId && token.principalId === request.context.principalId
        && token.expiresAt > (this.options.now?.() ?? Date.now()) + 30_000 && typeof token.token === 'string'
        && token.token.length > 0 && !/[\r\n]/.test(token.token), 'access-denied');
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers ?? {})) {
        stateAssert(requestHeaders.has(name) && !/[\r\n]/.test(value), 'invalid-binding');
        headers[name] = value;
      }
      headers.authorization = `Bearer ${token.token}`;
      headers['x-ms-version'] = '2023-11-03';
      headers['x-ms-date'] = new Date(this.options.now?.() ?? Date.now()).toUTCString();
      headers['x-ms-client-request-id'] = request.operationId ?? randomUUID();
      const response = await (this.options.fetch ?? globalThis.fetch)(azureStateUrl(request.binding, request.target), {
        method: request.method, headers, redirect: 'error', signal,
        ...(request.body ? { body: Buffer.from(request.body) } : {})
      });
      const safeHeaders: Record<string, string> = {};
      for (const name of responseHeaders) {
        const value = response.headers.get(name);
        if (value !== null) safeHeaders[name] = value;
      }
      const maxBytes = this.options.maxResponseBytes ?? 32 * 1024 * 1024;
      const length = Number(response.headers.get('content-length') ?? 0);
      stateAssert(Number.isSafeInteger(length) && length >= 0 && (request.method === 'HEAD' || length <= maxBytes), 'storage-limit');
      const parts: Uint8Array[] = [];
      let size = 0;
      const reader = request.method === 'HEAD' ? undefined : response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            stateAssert(size <= maxBytes, 'storage-limit');
            parts.push(chunk.value);
          }
        } finally { await reader.cancel().catch(() => undefined); }
      }
      return { status: response.status, headers: safeHeaders, body: Buffer.concat(parts) };
    } catch (error) {
      if (error instanceof StateMigrationError) throw error;
      if (signal.aborted) throw new StateMigrationError(request.signal?.aborted ? 'cancelled' : 'timeout');
      throw new StateMigrationError('access-denied');
    }
  }
}

function successful(response: AzureStateResponse, allowed: readonly number[]): void {
  if (allowed.includes(response.status)) return;
  if (response.status === 409 || response.status === 412) throw new StateMigrationError('stale-state');
  if (response.status === 401 || response.status === 403) throw new StateMigrationError('access-denied');
  if (response.status === 408 || response.status === 504) throw new StateMigrationError('timeout');
  throw new StateMigrationError('incomplete-observation');
}

class AzureLease implements StateBackendLease {
  #leaseId: string | null = null;
  #lost = false;
  #released = false;
  #removed = false;
  #expiresAt = 0;
  #renewal: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  get kind(): 'blob-lease' | 'conditional-create' { return this.#leaseId ? 'blob-lease' : 'conditional-create'; }
  get leaseId(): string | null { return this.#leaseId; }

  constructor(
    readonly backendId: string,
    private readonly send: (headers: Record<string, string>) => Promise<AzureStateResponse>,
    private readonly now: () => number,
    private readonly absent: () => Promise<boolean>
  ) {}

  async lock(etag: string): Promise<void> {
    stateAssert(!this.#leaseId && !this.#lost && !this.#released, 'lock-lost');
    const id = randomUUID();
    const response = await this.send({
      'x-ms-lease-action': 'acquire', 'x-ms-lease-duration': '60', 'x-ms-proposed-lease-id': id, 'if-match': etag
    });
    successful(response, [201]);
    stateAssert(response.headers['x-ms-lease-id'] === id, 'lock-lost');
    this.#leaseId = id;
    this.#expiresAt = this.now() + 55_000;
    this.#timer = setInterval(() => { void this.renew().catch(() => undefined); }, 20_000);
    this.#timer.unref?.();
  }

  private async renew(): Promise<void> {
    if (this.#renewal) return this.#renewal;
    if (this.#released || this.#removed || this.#lost || !this.#leaseId) return;
    this.#renewal = (async () => {
      try {
        stateAssert(this.now() < this.#expiresAt, 'lock-lost');
        const response = await this.send({ 'x-ms-lease-action': 'renew', 'x-ms-lease-id': this.#leaseId! });
        successful(response, [200]);
        this.#expiresAt = this.now() + 55_000;
      } catch {
        this.#lost = true;
        throw new StateMigrationError('lock-lost');
      }
    })();
    try { await this.#renewal; } finally { this.#renewal = null; }
  }

  async assertHeld(): Promise<void> {
    stateAssert(!this.#released && !this.#lost, 'lock-lost');
    if (this.#removed) return;
    if (!this.#leaseId) {
      stateAssert(await this.absent(), 'stale-state');
      return;
    }
    await this.renew();
    stateAssert(!this.#lost && this.now() < this.#expiresAt, 'lock-lost');
  }

  markRemoved(): void {
    this.#removed = true;
    if (this.#timer) clearInterval(this.#timer);
  }

  async release(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#released) return;
    await this.#renewal?.catch(() => undefined);
    this.#released = true;
    if (!this.#leaseId || this.#removed) return;
    const response = await this.send({ 'x-ms-lease-action': 'release', 'x-ms-lease-id': this.#leaseId });
    if (![200, 404].includes(response.status)) throw new StateMigrationError('lock-lost');
  }
}

export class AzureBlobStateBackend implements StateBackendAdapter {
  readonly binding: AzureBlobStateBinding;
  #leases = new WeakSet<AzureLease>();
  constructor(binding: AzureBlobStateBinding, private readonly options: {
    transport: AzureStateTransport;
    access: AzureBlobAccessProvider;
    now?: () => number;
    maxStateBytes?: number;
  }) {
    stateBindingDigest(binding);
    this.binding = Object.freeze(structuredClone(binding));
  }

  toJSON(): { backendRef: string; kind: 'azurerm' } { return { backendRef: stateBindingDigest(this.binding), kind: 'azurerm' }; }
  private now(): number { return this.options.now?.() ?? Date.now(); }

  async assertAccess(context: StateExecutionContext, write: boolean, signal?: AbortSignal): Promise<void> {
    const access = await this.options.access.observe(this.binding, context, write, signal);
    stateAssert(access.bindingDigest === stateBindingDigest(this.binding) && access.ownerId === this.binding.ownerId
      && access.hostId === context.hostId && access.principalId === context.principalId, 'ownership-mismatch');
    stateAssert(access.network === this.binding.network && access.reachable && access.canRead
      && (!write || access.canWrite) && access.expiresAt > this.now(), 'access-denied');
    stateAssert(access.serverSideEncryption && access.versioning && access.softDelete, 'unsupported-encryption');
  }

  private request(context: StateExecutionContext, fields: Omit<AzureStateRequest, 'context' | 'binding'>): Promise<AzureStateResponse> {
    return this.options.transport.request({ ...fields, binding: this.binding, context });
  }

  async metadata(context: StateExecutionContext, signal?: AbortSignal): Promise<StateBackendMetadata> {
    await this.assertAccess(context, false, signal);
    const response = await this.request(context, { method: 'HEAD', target: 'blob', signal });
    if (response.status === 404) {
      stateAssert(response.headers['x-ms-error-code'] === 'BlobNotFound', 'incomplete-observation');
      successful(await this.request(context, { method: 'HEAD', target: 'container', signal }), [200]);
      return {
        backendId: this.binding.id, bindingDigest: stateBindingDigest(this.binding),
        exists: false, version: null, etag: null, size: 0, observedAt: this.now()
      };
    }
    successful(response, [200]);
    const etag = response.headers.etag;
    const version = response.headers['x-ms-version-id'] ?? etag;
    const size = Number(response.headers['content-length']);
    stateAssert(typeof etag === 'string' && /^"0x[a-fA-F0-9]+"$/.test(etag)
      && typeof version === 'string' && version.length <= 128 && !/[\x00-\x1f]/.test(version), 'incomplete-observation');
    stateAssert(response.headers['x-ms-server-encrypted'] === 'true', 'unsupported-encryption');
    stateAssert(Number.isSafeInteger(size) && size >= 0, 'incomplete-observation');
    const operationId = response.headers['x-ms-meta-liftoff-operation'];
    return {
      backendId: this.binding.id, bindingDigest: stateBindingDigest(this.binding),
      exists: true, version, etag, size, observedAt: this.now(),
      ...(operationId && /^[a-f0-9-]{36}$/.test(operationId) ? { operationId } : {})
    };
  }

  private async held(lease: StateBackendLease): Promise<AzureLease> {
    stateAssert(lease instanceof AzureLease && this.#leases.has(lease) && lease.backendId === this.binding.id, 'lock-lost');
    await lease.assertHeld();
    return lease;
  }

  async readPrivate(expected: StateBackendMetadata, context: StateExecutionContext, lease?: StateBackendLease, signal?: AbortSignal): Promise<Uint8Array> {
    await this.assertAccess(context, false, signal);
    const held = lease ? await this.held(lease) : null;
    stateAssert(expected.backendId === this.binding.id && expected.bindingDigest === stateBindingDigest(this.binding)
      && expected.exists && expected.etag, 'stale-state');
    stateAssert(expected.size <= (this.options.maxStateBytes ?? 32 * 1024 * 1024), 'storage-limit');
    const response = await this.request(context, {
      method: 'GET', target: 'blob', headers: {
        'if-match': expected.etag, ...(held?.leaseId ? { 'x-ms-lease-id': held.leaseId } : {})
      }, signal
    });
    successful(response, [200]);
    stateAssert(response.headers.etag === expected.etag && response.body.byteLength === expected.size, 'stale-state');
    stateAssert(stateMetadataMatches(expected, await this.metadata(context, signal)), 'stale-state');
    if (held) await held.assertHeld();
    return response.body;
  }

  async acquire(expected: StateBackendMetadata, context: StateExecutionContext, operationId: string, signal?: AbortSignal): Promise<StateBackendLease> {
    await this.assertAccess(context, true, signal);
    stateAssert(stateMetadataMatches(expected, await this.metadata(context, signal)), 'stale-state');
    const lease = new AzureLease(
      this.binding.id,
      (headers) => this.request(context, {
        method: 'PUT', target: 'lease', headers, operationId,
        ...(headers['x-ms-lease-action'] === 'acquire' ? { signal } : {})
      }),
      () => this.now(),
      async () => !(await this.metadata(context, signal)).exists
    );
    this.#leases.add(lease);
    if (expected.exists) await lease.lock(expected.etag!);
    else await lease.assertHeld();
    return lease;
  }

  private async check(expected: StateSnapshot, context: StateExecutionContext, lease: AzureLease, signal?: AbortSignal): Promise<void> {
    const metadata = await this.metadata(context, signal);
    const bytes = metadata.exists ? await this.readPrivate(metadata, context, lease, signal) : null;
    try { stateAssert(stateSnapshotMatches(expected, inspectStateBytes(metadata, bytes).snapshot), 'stale-state'); }
    finally { bytes?.fill(0); }
    await lease.assertHeld();
  }

  async writePrivate(request: Parameters<StateBackendAdapter['writePrivate']>[0]): Promise<StateBackendMetadata> {
    await this.assertAccess(request.context, true, request.signal);
    const lease = await this.held(request.lease);
    await this.check(request.expected, request.context, lease, request.signal);
    const candidate = inspectStateBytes({ ...request.expected, exists: true, size: request.bytes.byteLength }, request.bytes).snapshot;
    if (request.expected.exists) {
      stateAssert(candidate.lineage === request.expected.lineage && candidate.serial! >= request.expected.serial!, 'stale-state');
      stateAssert(lease.leaseId, 'lock-lost');
    }
    const response = await this.request(request.context, {
      method: 'PUT', target: 'blob', body: request.bytes, operationId: request.operationId, signal: request.signal,
      headers: {
        'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/json',
        'x-ms-meta-liftoff-operation': request.operationId,
        ...(request.expected.exists
          ? { 'if-match': request.expected.etag!, 'x-ms-lease-id': lease.leaseId! }
          : { 'if-none-match': '*' })
      }
    });
    successful(response, [201]);
    const current = await this.metadata(request.context, request.signal);
    stateAssert(current.etag === response.headers.etag && current.operationId === request.operationId, 'stale-state');
    // An absent blob cannot be leased. Its first publication is an atomic create,
    // followed by acquisition against that exact ETag, before source retirement.
    if (!lease.leaseId) await lease.lock(current.etag!);
    await lease.assertHeld();
    return current;
  }

  /** Empty application bootstrap only. Unlike migration publication, this never acquires a lease or retires a source. */
  async initializeEmptyPrivate(request: {
    bytes: Uint8Array; expected: StateBackendMetadata; context: StateExecutionContext; operationId: string; signal?: AbortSignal;
  }): Promise<StateBackendMetadata> {
    stateAssert(!request.expected.exists && request.bytes.byteLength > 0 && request.bytes.byteLength <= 4096, 'invalid-binding');
    await this.assertAccess(request.context, true, request.signal);
    stateAssert(stateMetadataMatches(request.expected, await this.metadata(request.context, request.signal)), 'stale-state');
    const state = inspectStateBytes({ ...request.expected, exists: true, size: request.bytes.byteLength }, request.bytes);
    let document: unknown;
    try { document = JSON.parse(Buffer.from(request.bytes).toString('utf8')); }
    catch { throw new StateMigrationError('invalid-binding'); }
    stateAssert(typeof document === 'object' && document !== null && !Array.isArray(document) &&
      'version' in document && document.version === 4 &&
      'terraform_version' in document && document.terraform_version === '1.12.6' &&
      'serial' in document && document.serial === 1 &&
      'lineage' in document && typeof document.lineage === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(document.lineage) &&
      'resources' in document && Array.isArray(document.resources) && document.resources.length === 0 &&
      'outputs' in document && typeof document.outputs === 'object' && document.outputs !== null &&
      !Array.isArray(document.outputs) && Object.keys(document.outputs).length === 0 &&
      'check_results' in document && document.check_results === null &&
      Object.keys(document).sort().join(',') === 'check_results,lineage,outputs,resources,serial,terraform_version,version' &&
      state.snapshot.serial === 1, 'invalid-binding');
    const response = await this.request(request.context, {
      method: 'PUT', target: 'blob', body: request.bytes, operationId: request.operationId, signal: request.signal,
      headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/json',
        'x-ms-meta-liftoff-operation': request.operationId, 'if-none-match': '*' }
    });
    successful(response, [201]);
    const current = await this.metadata(request.context, request.signal);
    stateAssert(current.exists && current.etag === response.headers.etag && current.operationId === request.operationId, 'stale-state');
    return current;
  }

  async remove(request: Parameters<StateBackendAdapter['remove']>[0]): Promise<StateBackendMetadata> {
    await this.assertAccess(request.context, true, request.signal);
    const lease = await this.held(request.lease);
    await this.check(request.expected, request.context, lease, request.signal);
    stateAssert(request.expected.exists && request.expected.etag && lease.leaseId, 'stale-state');
    const response = await this.request(request.context, {
      method: 'DELETE', target: 'blob', operationId: request.operationId, signal: request.signal,
      headers: { 'if-match': request.expected.etag, 'x-ms-lease-id': lease.leaseId }
    });
    successful(response, [202]);
    lease.markRemoved();
    const current = await this.metadata(request.context, request.signal);
    stateAssert(!current.exists, 'verification-incomplete');
    return current;
  }
}
