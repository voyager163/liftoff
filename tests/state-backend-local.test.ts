import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { LocalStateBackend, type NativeLocalStateLockProvider } from '../src/adapters/state/local.js';
import { inspectStateBytes, stateAssert } from '../src/domain/repair/stateful-invariants.js';
import { context, sourceInstances, stateBytes } from './fixtures/state-migration/fakes.js';
import type { StateBackendLease } from '../src/domain/repair/stateful.js';

// The native-lock and volume checks here are deterministic capabilities. The
// separate protection suite verifies that real repository paths are rejected.
vi.mock('../src/adapters/state/protected-workspace.js', async (original) => ({
  ...await original<typeof import('../src/adapters/state/protected-workspace.js')>(),
  assertPrivateStatePath: async () => undefined
}));

const scratch = path.join(process.cwd(), '.cache', `state-backend-local-${process.pid}`);
afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });
let next = 0;

async function fixture() {
  const directory = path.join(scratch, String(next++));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'source with spaces.tfstate');
  await writeFile(filename, stateBytes(sourceInstances), { mode: 0o600 });
  let held = false;
  let acquisitions = 0;
  let replacements = 0;
  let removals = 0;
  let race: (() => Promise<void>) | null = null;
  let backend: LocalStateBackend;
  const locks: NativeLocalStateLockProvider = {
    async acquire(request) {
      acquisitions++;
      expect(request.path).toBe(filename);
      stateAssert(!held, 'lock-unavailable');
      held = true;
      return {
        async assertHeld() { stateAssert(held, 'lock-lost'); },
        async replace(bytes, expectedVersion) {
          await race?.();
          stateAssert(held && (await backend.metadata(context())).version === expectedVersion, 'stale-state');
          replacements++;
          await writeFile(filename, bytes, { mode: 0o600 });
        },
        async remove(expectedVersion) {
          stateAssert(held && (await backend.metadata(context())).version === expectedVersion, 'stale-state');
          removals++;
          await rm(filename);
        },
        async release() { held = false; }
      };
    }
  };
  const volume = { async verify() { throw new Error('Volume proof is supplied by this isolated synthetic fixture'); } };
  const binding = { id: 'source', kind: 'local' as const, statePath: filename, format: 'opentofu-v4-json' as const, ownerId: context().projectId };
  backend = new LocalStateBackend(binding, { locks, volume });
  return {
    backend, filename, binding, volume,
    counts: () => ({ acquisitions, replacements, removals }),
    lose() { held = false; },
    race(callback: () => Promise<void>) { race = callback; }
  };
}

describe('local backend native-lock capability contract', () => {
  it('observes only metadata before sensitive reads and never substitutes a sentinel for native locking', async () => {
    const current = await fixture();
    const metadata = await current.backend.metadata(context());
    expect(metadata.exists).toBe(true);
    expect(metadata.etag).toBeNull();
    expect(metadata.version).toMatch(/^[a-f0-9]{64}$/);
    expect(current.counts()).toEqual({ acquisitions: 0, replacements: 0, removals: 0 });
    const unavailable = new LocalStateBackend(current.binding, { volume: current.volume });
    await expect(unavailable.assertAccess(context(), true)).rejects.toMatchObject({ code: 'native-lock-provider-required' });
  });

  it('checks the entire snapshot under the native lock and sends the exact version to conditional replacement', async () => {
    const current = await fixture();
    const metadata = await current.backend.metadata(context());
    const bytes = await current.backend.readPrivate(metadata, context());
    const expected = inspectStateBytes(metadata, bytes).snapshot;
    const lease = await current.backend.acquire(metadata, context(), 'synthetic-operation');
    const candidate = stateBytes(sourceInstances, expected.lineage!, expected.serial! + 1);
    try {
      const updated = await current.backend.writePrivate({ bytes: candidate, expected, lease, context: context(), operationId: 'synthetic-operation' });
      expect(updated.version).not.toBe(expected.version);
      expect(await readFile(current.filename)).toEqual(candidate);
      expect(current.counts()).toEqual({ acquisitions: 1, replacements: 1, removals: 0 });
    } finally { await lease.release(); }
  });

  it('does not overwrite a writer racing at the native replacement boundary', async () => {
    const current = await fixture();
    const metadata = await current.backend.metadata(context());
    const expected = inspectStateBytes(metadata, await current.backend.readPrivate(metadata, context())).snapshot;
    const lease = await current.backend.acquire(metadata, context(), 'synthetic-operation');
    const concurrent = stateBytes(sourceInstances, expected.lineage!, 99);
    current.race(() => writeFile(current.filename, concurrent));
    try {
      await expect(current.backend.writePrivate({
        bytes: stateBytes(sourceInstances, expected.lineage!, 8), expected, lease, context: context(), operationId: 'synthetic-operation'
      })).rejects.toMatchObject({ code: 'stale-state' });
      expect(await readFile(current.filename)).toEqual(concurrent);
      expect(current.counts().replacements).toBe(0);
    } finally { await lease.release(); }
  });

  it('rejects forged/lost locks and conditional retirement of a changed source', async () => {
    const current = await fixture();
    const metadata = await current.backend.metadata(context());
    const expected = inspectStateBytes(metadata, await current.backend.readPrivate(metadata, context())).snapshot;
    const fakeLease: StateBackendLease = { backendId: 'source', kind: 'native-file', async assertHeld() {}, async release() {} };
    await expect(current.backend.remove({ expected, lease: fakeLease, context: context(), operationId: 'synthetic-operation' }))
      .rejects.toMatchObject({ code: 'lock-lost' });
    const lease = await current.backend.acquire(metadata, context(), 'synthetic-operation');
    current.lose();
    await expect(current.backend.remove({ expected, lease, context: context(), operationId: 'synthetic-operation' }))
      .rejects.toMatchObject({ code: 'lock-lost' });
    await lease.release();
    expect(current.counts().removals).toBe(0);
  });

  it('conditionally retires only the exact locked source and verifies its absence', async () => {
    const current = await fixture();
    const metadata = await current.backend.metadata(context());
    const expected = inspectStateBytes(metadata, await current.backend.readPrivate(metadata, context())).snapshot;
    const lease = await current.backend.acquire(metadata, context(), 'synthetic-operation');
    try {
      const absent = await current.backend.remove({ expected, lease, context: context(), operationId: 'synthetic-operation' });
      expect(absent.exists).toBe(false);
      expect(absent.version).toBeNull();
      expect(current.counts().removals).toBe(1);
    } finally { await lease.release(); }
  });
});
