import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import {
  StateMigrationError,
  type LocalStateBinding,
  type NativeLocalStateLockProvider,
  type ProtectedVolumeAttestor,
  type StateBackendAdapter,
  type StateBackendLease,
  type StateBackendMetadata,
  type StateExecutionContext,
  type StateSnapshot
} from '../../domain/repair/stateful.js';
import {
  inspectStateBytes, stateAssert, stateBindingDigest, stateMetadataMatches, stateObjectDigest, stateSnapshotMatches
} from '../../domain/repair/stateful-invariants.js';
import { assertExistingStateSourcePath, assertPrivateStatePath } from './protected-workspace.js';

export type { NativeLocalStateLockProvider } from '../../domain/repair/stateful.js';

class LocalLease implements StateBackendLease {
  readonly kind = 'native-file' as const;
  #released = false;
  constructor(readonly backendId: string, readonly native: Awaited<ReturnType<NativeLocalStateLockProvider['acquire']>>) {}
  async assertHeld(): Promise<void> {
    stateAssert(!this.#released, 'lock-lost');
    await this.native.assertHeld();
  }
  async release(): Promise<void> {
    if (!this.#released) {
      await this.native.release();
      this.#released = true;
    }
  }
}

export class LocalStateBackend implements StateBackendAdapter {
  readonly binding: LocalStateBinding;
  #leases = new WeakSet<LocalLease>();
  constructor(binding: LocalStateBinding, private readonly options: {
    volume: ProtectedVolumeAttestor;
    locks?: NativeLocalStateLockProvider;
    now?: () => number;
    maxStateBytes?: number;
  }) {
    stateBindingDigest(binding);
    this.binding = Object.freeze(structuredClone(binding));
  }

  toJSON(): { backendRef: string; kind: 'local' } { return { backendRef: stateBindingDigest(this.binding), kind: 'local' }; }

  async assertAccess(context: StateExecutionContext, write: boolean): Promise<void> {
    if (this.binding.readOnlySource) await assertExistingStateSourcePath(this.binding.statePath, context);
    else await assertPrivateStatePath(this.binding.statePath, context, this.options.volume, false, this.options.now?.() ?? Date.now());
    if (write) stateAssert(this.options.locks, 'native-lock-provider-required');
    if (write && this.options.locks?.capabilities) {
      stateAssert(!this.binding.readOnlySource, 'unsupported-local-state-operation');
      const existing = await lstat(this.binding.statePath).catch(() => null);
      stateAssert(existing?.isFile(), 'unsupported-local-state-operation');
    }
  }

  async metadata(context: StateExecutionContext): Promise<StateBackendMetadata> {
    await this.assertAccess(context, false);
    const info = await lstat(this.binding.statePath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw new StateMigrationError('access-denied');
    });
    stateAssert(!info || (info.isFile() && !info.isSymbolicLink() && info.nlink === 1n), 'unsafe-path');
    const version = info ? stateObjectDigest({
      dev: String(info.dev), ino: String(info.ino), size: String(info.size),
      mtime: String(info.mtimeNs), ctime: String(info.ctimeNs)
    }) : null;
    return {
      backendId: this.binding.id, bindingDigest: stateBindingDigest(this.binding),
      exists: info !== null, version, etag: null, size: info ? Number(info.size) : 0,
      observedAt: this.options.now?.() ?? Date.now()
    };
  }

  async readPrivate(expected: StateBackendMetadata, context: StateExecutionContext, lease?: StateBackendLease): Promise<Uint8Array> {
    await this.assertAccess(context, false);
    if (lease) await this.held(lease);
    stateAssert(expected.exists && stateMetadataMatches(expected, await this.metadata(context)), 'stale-state');
    stateAssert(expected.size <= (this.options.maxStateBytes ?? 32 * 1024 * 1024), 'storage-limit');
    const file = await open(this.binding.statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      stateAssert(info.isFile() && info.nlink === 1 && info.size === expected.size, 'stale-state');
      const bytes = await file.readFile();
      stateAssert(stateMetadataMatches(expected, await this.metadata(context)), 'stale-state');
      if (lease) await this.held(lease);
      return bytes;
    } finally { await file.close(); }
  }

  async acquire(expected: StateBackendMetadata, context: StateExecutionContext, operationId: string, signal?: AbortSignal): Promise<StateBackendLease> {
    await this.assertAccess(context, true);
    stateAssert(stateMetadataMatches(expected, await this.metadata(context)), 'stale-state');
    const native = await this.options.locks!.acquire({ path: this.binding.statePath, operationId, expectedVersion: expected.version, signal });
    const lease = new LocalLease(this.binding.id, native);
    this.#leases.add(lease);
    try {
      await lease.assertHeld();
      stateAssert(stateMetadataMatches(expected, await this.metadata(context)), 'stale-state');
      return lease;
    } catch (error) { await lease.release(); throw error; }
  }

  private async held(lease: StateBackendLease): Promise<LocalLease> {
    stateAssert(lease instanceof LocalLease && this.#leases.has(lease) && lease.backendId === this.binding.id, 'lock-lost');
    await lease.assertHeld();
    return lease;
  }

  private async check(expected: StateSnapshot, context: StateExecutionContext, lease: LocalLease): Promise<void> {
    const metadata = await this.metadata(context);
    const bytes = metadata.exists ? await this.readPrivate(metadata, context, lease) : null;
    try { stateAssert(stateSnapshotMatches(expected, inspectStateBytes(metadata, bytes).snapshot), 'stale-state'); }
    finally { bytes?.fill(0); }
    await lease.assertHeld();
  }

  async writePrivate(request: Parameters<StateBackendAdapter['writePrivate']>[0]): Promise<StateBackendMetadata> {
    stateAssert(!this.binding.readOnlySource, 'unsupported-state');
    await this.assertAccess(request.context, true);
    const lease = await this.held(request.lease);
    await this.check(request.expected, request.context, lease);
    const candidate = inspectStateBytes({ ...request.expected, exists: true, size: request.bytes.byteLength }, request.bytes).snapshot;
    if (request.expected.exists) {
      stateAssert(candidate.lineage === request.expected.lineage && candidate.serial! >= request.expected.serial!, 'stale-state');
    }
    await lease.native.replace(request.bytes, request.expected.version);
    await lease.assertHeld();
    return this.metadata(request.context);
  }

  async remove(request: Parameters<StateBackendAdapter['remove']>[0]): Promise<StateBackendMetadata> {
    stateAssert(!this.options.locks?.capabilities || this.options.locks.capabilities.remove, 'unsupported-local-state-operation');
    await this.assertAccess(request.context, true);
    const lease = await this.held(request.lease);
    await this.check(request.expected, request.context, lease);
    stateAssert(request.expected.exists && request.expected.version, 'stale-state');
    await lease.native.remove(request.expected.version);
    await lease.assertHeld();
    const result = await this.metadata(request.context);
    stateAssert(!result.exists, 'verification-incomplete');
    return result;
  }
}
