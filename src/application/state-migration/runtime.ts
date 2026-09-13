import {
  StateMigrationError,
  type InspectedState,
  type StateArtifactDescriptor,
  type StateArtifactPurpose,
  type StateAuthority,
  type StateAuthorityKind,
  type StateBackendAdapter,
  type StateBackendBinding,
  type StateBackendLease,
  type StateBackendMetadata,
  type StateExecutionContext,
  type StateMigrationDependencies,
  type StateNativeDriver,
  type StateWriterCoordinator,
  type StateSnapshot
} from '../../domain/repair/stateful.js';
import {
  canonicalStateValue, inspectStateBytes, stateAssert, stateBindingDigest, stateDigest,
  stateMetadataMatches, stateObjectDigest, stateSnapshotMatches, validateStateContext
} from '../../domain/repair/stateful-invariants.js';
import { protectedStateScope } from '../../adapters/state/protected-workspace.js';
import { boundedStateOperation } from '../../domain/repair/stateful-bounded.js';

export class StateMigrationRuntime {
  readonly ttl: number;
  readonly writers: StateWriterCoordinator;
  readonly native: StateNativeDriver;
  #backends = new Map<string, StateBackendAdapter>();
  constructor(readonly deps: StateMigrationDependencies) {
    this.ttl = deps.observationTtlMs ?? 300_000;
    stateAssert(this.ttl > 0 && this.ttl <= 900_000, 'invalid-binding');
    this.writers = {
      inspectConfiguration: (context, signal) => this.external(signal, (bounded) => deps.writers.inspectConfiguration(context, bounded)),
      quiesce: (request) => this.external(request.signal, (signal) => deps.writers.quiesce({ ...request, signal })),
      assertQuiesced: (handle, digest, signal) => this.external(signal, (bounded) => deps.writers.assertQuiesced(handle, digest, bounded)),
      commitConfiguration: (request) => this.external(request.signal, (signal) => deps.writers.commitConfiguration({ ...request, signal })),
      verifyCutover: (request) => this.external(request.signal, (signal) => deps.writers.verifyCutover({ ...request, signal })),
      publishInventory: (request) => this.external(request.signal, (signal) => deps.writers.publishInventory({ ...request, signal })),
      resume: (request) => this.external(request.signal, (signal) => deps.writers.resume({ ...request, signal }))
    };
    this.native = {
      quiesce: () => this.quiesceNative(),
      review: (request) => this.nativeCall(request.signal, (signal) => deps.native.review({ ...request, signal })),
      prepare: (plan, signal) => this.nativeCall(signal, (bounded) => deps.native.prepare(plan, bounded)),
      verifyDestinations: (plan, current, signal) => this.nativeCall(signal, (bounded) => deps.native.verifyDestinations(plan, current, bounded)),
      verify: (plan, current, signal) => this.nativeCall(signal, (bounded) => deps.native.verify(plan, current, bounded))
    };
  }
  now(): number { return this.deps.now?.() ?? Date.now(); }
  scope(context: StateExecutionContext): string { return protectedStateScope(context); }
  signal(signal?: AbortSignal): AbortSignal {
    const ms = this.deps.operationTimeoutMs ?? 300_000;
    stateAssert(ms > 0 && ms <= 1_800_000, 'invalid-binding');
    return AbortSignal.any([AbortSignal.timeout(ms), ...(signal ? [signal] : [])]);
  }
  checkSignal(signal?: AbortSignal): void {
    if (signal?.aborted) throw new StateMigrationError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled');
  }
  external<T>(signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>, lateResult?: (value: T) => Promise<void>): Promise<T> {
    const bounded = signal ?? this.signal();
    return boundedStateOperation(bounded, () => action(bounded), lateResult);
  }
  async quiesceNative(): Promise<void> {
    stateAssert(this.deps.native.quiesce, 'process-tree-termination-unproven');
    try {
      await boundedStateOperation(AbortSignal.timeout(10_000), () => this.deps.native.quiesce!());
    } catch (error) {
      if (error instanceof StateMigrationError && error.code === 'process-tree-termination-unproven') throw error;
      throw new StateMigrationError('process-tree-termination-unproven');
    }
  }
  private async nativeCall<T>(signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    let outcome: { value: T } | { error: unknown };
    try { outcome = { value: await this.external(signal, action) }; }
    catch (error) { outcome = { error }; }
    // Cancellation can settle the bounded operation before the child's own
    // signal handler finishes. Do not cross the release/cleanup fence yet.
    await this.quiesceNative();
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }
  async available(context: StateExecutionContext, signal?: AbortSignal): Promise<void> {
    validateStateContext(context);
    await this.external(signal, () => this.deps.workspace.assertAvailable(context));
  }
  authority(authority: StateAuthority | undefined, kind: StateAuthorityKind, fingerprint: string, expiresAt: number): void {
    stateAssert(authority?.kind === kind && authority.fingerprint === fingerprint,
      kind === 'state-read' ? 'state-read-approval-required' : 'approval-mismatch');
    stateAssert(Number.isFinite(authority.expiresAt) && this.now() < authority.expiresAt
      && authority.expiresAt <= expiresAt && this.now() < expiresAt, 'expired');
  }
  sameContext(expected: StateExecutionContext, current: StateExecutionContext): void {
    validateStateContext(current);
    stateAssert(stateObjectDigest(expected) === stateObjectDigest(current), 'configuration-changed');
  }
  backend(binding: StateBackendBinding): StateBackendAdapter {
    const digest = stateBindingDigest(binding);
    let adapter = this.#backends.get(digest);
    if (!adapter) {
      const actual = this.deps.backend(structuredClone(binding));
      stateAssert(stateBindingDigest(actual.binding) === digest, 'invalid-binding');
      adapter = {
        binding: structuredClone(binding),
        metadata: (context, signal) => this.external(signal, (bounded) => actual.metadata(context, bounded)),
        assertAccess: (context, write, signal) => this.external(signal, (bounded) => actual.assertAccess(context, write, bounded)),
        readPrivate: (expected, context, lease, signal) => this.external(signal, (bounded) => actual.readPrivate(expected, context, lease, bounded)),
        acquire: (expected, context, operationId, signal) => this.external(
          signal, (bounded) => actual.acquire(expected, context, operationId, bounded), (lease) => lease.release()
        ),
        writePrivate: (request) => this.external(request.signal, (signal) => actual.writePrivate({ ...request, signal })),
        remove: (request) => this.external(request.signal, (signal) => actual.remove({ ...request, signal }))
      };
      this.#backends.set(digest, adapter);
    }
    return adapter;
  }

  publicMetadata(metadata: StateBackendMetadata, binding: StateBackendBinding): StateBackendMetadata {
    stateAssert(metadata.backendId === binding.id && metadata.bindingDigest === stateBindingDigest(binding)
      && typeof metadata.exists === 'boolean' && Number.isSafeInteger(metadata.size) && metadata.size >= 0
      && Number.isFinite(metadata.observedAt) && metadata.observedAt <= this.now()
      && this.now() - metadata.observedAt <= this.ttl, 'incomplete-observation');
    stateAssert((metadata.exists && typeof metadata.version === 'string' && metadata.version.length <= 256
      && /^[a-zA-Z0-9":._-]+$/.test(metadata.version))
      || (!metadata.exists && metadata.version === null && metadata.etag === null && metadata.size === 0), 'incomplete-observation');
    stateAssert(metadata.etag === null || (typeof metadata.etag === 'string' && /^"0x[a-fA-F0-9]+"$/.test(metadata.etag)), 'incomplete-observation');
    return {
      backendId: binding.id, bindingDigest: stateBindingDigest(binding), exists: metadata.exists,
      version: metadata.version, etag: metadata.etag, size: metadata.size, observedAt: metadata.observedAt,
      ...(metadata.operationId && /^[a-f0-9-]{36}$/.test(metadata.operationId) ? { operationId: metadata.operationId } : {})
    };
  }

  async observe(binding: StateBackendBinding, context: StateExecutionContext, signal?: AbortSignal): Promise<StateBackendMetadata> {
    this.checkSignal(signal);
    return this.publicMetadata(await this.backend(binding).metadata(context, signal), binding);
  }

  async readState(
    binding: StateBackendBinding, context: StateExecutionContext, expected?: StateBackendMetadata,
    lease?: StateBackendLease, signal?: AbortSignal
  ): Promise<InspectedState> {
    const metadata = await this.observe(binding, context, signal);
    if (expected) stateAssert(stateMetadataMatches(expected, metadata), 'stale-state');
    if (lease) await this.external(signal, (bounded) => lease.assertHeld(bounded));
    const bytes = metadata.exists ? await this.backend(binding).readPrivate(metadata, context, lease, signal) : null;
    try {
      const parsed = inspectStateBytes(metadata, bytes, this.deps.maxStateBytes);
      stateAssert(stateMetadataMatches(metadata, await this.observe(binding, context, signal)), 'stale-state');
      if (lease) await this.external(signal, (bounded) => lease.assertHeld(bounded));
      const stateRef = bytes ? (await this.deps.workspace.put('state', this.scope(context), bytes)).ref : null;
      return { ...parsed, stateRef };
    } finally { bytes?.fill(0); }
  }

  async checkState(
    binding: StateBackendBinding, context: StateExecutionContext, expected: StateSnapshot,
    lease?: StateBackendLease, signal?: AbortSignal
  ): Promise<InspectedState> {
    const state = await this.readState(binding, context, expected, lease, signal);
    stateAssert(stateSnapshotMatches(expected, state.snapshot), 'stale-state');
    return state;
  }

  async save<T>(purpose: StateArtifactPurpose, context: StateExecutionContext, value: T, id?: string): Promise<StateArtifactDescriptor> {
    const bytes = Buffer.from(canonicalStateValue(value));
    try { return await this.deps.workspace.put(purpose, this.scope(context), bytes, id); }
    finally { bytes.fill(0); }
  }

  async load<T>(ref: string, purpose: StateArtifactPurpose, context: StateExecutionContext): Promise<{ value: T; digest: string }> {
    const bytes = await this.deps.workspace.get(ref, purpose, this.scope(context));
    try {
      const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
      return { value, digest: stateDigest(bytes) };
    } catch { throw new StateMigrationError('artifact-integrity'); }
    finally { bytes.fill(0); }
  }

  async replace<T>(descriptor: StateArtifactDescriptor, value: T): Promise<StateArtifactDescriptor> {
    const bytes = Buffer.from(canonicalStateValue(value));
    try { return await this.deps.workspace.replace(descriptor.ref, descriptor.purpose, descriptor.scope, descriptor.digest, bytes); }
    finally { bytes.fill(0); }
  }
}

export function statePlanFingerprint(value: object): string {
  const { fingerprint: _fingerprint, ...body } = value as Record<string, unknown>;
  return stateObjectDigest(body);
}

export function stateOperationId(fingerprint: string): string {
  const hex = stateDigest(`state-operation:${fingerprint}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
