import { afterEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import * as filesystem from '../src/adapters/filesystem/update-previews.js';
import type {
  UpdatePreviewFileSystem, WorkflowSource5StoredControl
} from '../src/adapters/filesystem/update-previews.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  source5WorkflowOriginalPlanValue, withSource5WorkflowLease
} from '../src/governance-activation/workflow-source5-authority.js';
import {
  describeSource5WorkflowOwnership, readSource5WorkflowOwnershipHistory
} from '../src/governance-activation/workflow-source5-ownership-description.js';
import { source5WorkflowOwnership } from '../src/governance-activation/workflow-source5-ownership.js';
import type { Source5WorkflowOwnershipInput } from '../src/governance-activation/workflow-source5-ownership.js';
import { workflowSource5JournalFixture } from './fixtures/workflow-source5-journal.js';

type History = Awaited<ReturnType<typeof readSource5WorkflowOwnershipHistory>>;
type Description = Awaited<ReturnType<typeof describeSource5WorkflowOwnership>>;
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function fixture(work: (input: Source5WorkflowOwnershipInput, original: History) => Promise<void>) {
  const value = await workflowSource5JournalFixture(); roots.push(value.root);
  await value.store.save('plan', value.control.controlKey,
    source5WorkflowOriginalPlanValue(value.projectRoot, value.plan, value.approval), null);
  await withSource5WorkflowLease(value.projectRoot, async lease => {
    const input = { ...value, lease };
    const owner = await source5WorkflowOwnership(input);
    await owner.prepare();
    await work(input, await readSource5WorkflowOwnershipHistory(input));
  });
}
async function observe(input: Source5WorkflowOwnershipInput, description: Description, options: {
  readonly held?: readonly number[];
  readonly transform?: (index: number, record: WorkflowSource5StoredControl | null) => WorkflowSource5StoredControl | null;
}, work: (value: {
  readonly starts: number[];
  readonly completions: number[];
  readonly ready: ReturnType<typeof barrier>;
  readonly gates: Map<number, ReturnType<typeof barrier>>;
  readonly loaded: Map<number, ReturnType<typeof barrier>>;
  readonly result: Promise<
    { status: 'fulfilled'; value: History } | { status: 'rejected'; reason: unknown }
  >;
  readonly settled: () => boolean;
  readonly active: () => number;
  readonly maximum: () => number;
  readonly nativeCalls: Record<string, number>;
}) => Promise<void>) {
  const starts: number[] = [], completions: number[] = [], ready = barrier();
  const gates = new Map((options.held ?? []).map(index => [index, barrier()]));
  const loaded = new Map((options.held ?? []).map(index => [index, barrier()]));
  const nativeCalls: Record<string, number> = {};
  let active = 0, maximum = 0, settled = false;
  const native = filesystem.nodeUpdatePreviewFileSystem;
  const denied = async () => { throw new Error('Ownership history cannot write, flush, create or remove metadata.'); };
  const readOnly: UpdatePreviewFileSystem = {
    ...native,
    async lstat(path) { nativeCalls.lstat = (nativeCalls.lstat ?? 0) + 1; return native.lstat(path); },
    async realpath(path) { nativeCalls.realpath = (nativeCalls.realpath ?? 0) + 1; return native.realpath(path); },
    async openFile(path, access, mode) {
      if (access !== 'read') return denied();
      nativeCalls.openFile = (nativeCalls.openFile ?? 0) + 1;
      const handle = await native.openFile(path, access, mode);
      return { ...handle,
        async readText(maximumBytes) {
          nativeCalls.readText = (nativeCalls.readText ?? 0) + 1;
          return handle.readText(maximumBytes);
        },
        async close() { nativeCalls.close = (nativeCalls.close ?? 0) + 1; await handle.close(); }
      };
    },
    makeDirectory: denied, replaceFile: denied, removeFile: denied, syncDirectory: denied
  };
  const create = filesystem.createWorkflowSource5ControlStore;
  const spy = vi.spyOn(filesystem, 'createWorkflowSource5ControlStore').mockImplementation((...args) => {
    const store = create(...args);
    return { ...store, async read(namespace, key) {
      const index = description.inventory.objects.findIndex(object => object.namespace === namespace && object.key === key);
      if (index < 0) return store.read(namespace, key);
      starts.push(index); maximum = Math.max(maximum, ++active);
      if (!gates.size || gates.has(index)) ready.release();
      try {
        const record = await store.read(namespace, key);
        loaded.get(index)?.release();
        await gates.get(index)?.promise;
        return options.transform ? options.transform(index, record) : record;
      } finally { loaded.get(index)?.release(); completions.push(index); active--; }
    }, save: denied, finalizeJournal: denied };
  });
  const result = readSource5WorkflowOwnershipHistory({
    ...input, storage: { ...input.storage, fileSystem: readOnly }
  }).then(value => {
    settled = true; return { status: 'fulfilled' as const, value };
  }, (reason: unknown) => {
    settled = true; return { status: 'rejected' as const, reason };
  });
  try {
    await work({ starts, completions, ready, gates, loaded, result, settled: () => settled,
      active: () => active, maximum: () => maximum, nativeCalls });
  } finally {
    for (const gate of gates.values()) gate.release();
    await result;
    spy.mockRestore();
  }
}

describe('bounded independent read-only source5 ownership history', () => {
  it('reads every actual inventory slot without writes and retains the complete original ordered result', async ({ task }) => {
    await fixture(async (input, original) => {
      const started = performance.now();
      await observe(input, original.description, {}, async value => {
        const result = await value.result;
        expect(result.status).toBe('fulfilled');
        if (result.status !== 'fulfilled') throw result.reason;
        expect(canonicalSha256(result.value)).toBe(canonicalSha256(original));
        expect(value.starts).toEqual(Array.from({ length: 131 }, (_, index) => index));
        expect(value.completions).toHaveLength(131);
        expect(result.value.retained).toHaveLength(3);
        expect(value.maximum()).toBeLessThanOrEqual(4);
        expect(value.active()).toBe(0);
        expect(value.nativeCalls.openFile).toBe(value.nativeCalls.close);
        Object.assign(task.meta, { source5HistoryNativeObservation: {
          elapsedMs: performance.now() - started, inventoryReads: value.starts.length,
          retained: result.value.retained.length, absent: value.starts.length - result.value.retained.length,
          maximumInFlight: value.maximum(), activeAtReturn: value.active(), nativeCalls: value.nativeCalls,
          scope: 'one actual native-filesystem observation; not exclusive-host or hosted-timeout qualification'
        } });
      });
    });
  });

  it('allows four independent reads while retaining inventory order after reverse completion', async () => {
    await fixture(async (input, original) => {
      await observe(input, original.description, { held: [0, 1, 2, 3] }, async value => {
        await value.ready.promise; await setImmediate();
        expect(value.starts).toEqual([0, 1, 2, 3]);
        expect(value.maximum()).toBe(4);
        await Promise.all([...value.loaded.values()].map(gate => gate.promise));
        for (const index of [3, 2, 1, 0]) { value.gates.get(index)!.release(); await setImmediate(); }
        const result = await value.result;
        expect(result.status).toBe('fulfilled');
        if (result.status !== 'fulfilled') throw result.reason;
        expect(canonicalSha256(result.value)).toBe(canonicalSha256(original));
        expect(value.completions.slice(0, 4)).toEqual([3, 2, 1, 0]);
        expect(value.starts).toEqual(Array.from({ length: 131 }, (_, index) => index));
        expect(value.active()).toBe(0);
      });
    });
  });

  it('settles all started reads and selects the earliest inventory error rather than the first rejection', async () => {
    const first = new Error('Original earlier read failure'), later = new Error('Later faster read failure');
    await fixture(async (input, original) => {
      await observe(input, original.description, { held: [0, 1, 2, 3], transform(index, record) {
        if (index === 0) throw first;
        if (index === 1) throw later;
        return record;
      } }, async value => {
        await value.ready.promise; await setImmediate();
        expect(value.starts).toEqual([0, 1, 2, 3]);
        await Promise.all([...value.loaded.values()].map(gate => gate.promise));
        for (const index of [1, 3, 2]) { value.gates.get(index)!.release(); await setImmediate(); }
        expect(value.settled()).toBe(false);
        value.gates.get(0)!.release();
        const result = await value.result;
        expect(result.status).toBe('rejected');
        if (result.status !== 'rejected') throw new Error('A failed read was accepted.');
        expect(result.reason).toBe(first);
        expect(value.active()).toBe(0);
        expect(value.starts).toEqual([0, 1, 2, 3]);
      });
    });
  });

  it('preserves an earlier byte-validation failure ahead of a later read rejection', async () => {
    const later = new Error('Later read cannot replace earlier validation');
    await fixture(async (input, original) => {
      await observe(input, original.description, { held: [0, 1, 2, 3], transform(index, record) {
        if (index === 1) throw later;
        return index === 0 && record ? { ...record,
          encodedBytes: original.description.inventory.objects[0]!.maximumEncodedBytes + 1 } : record;
      } }, async value => {
        await value.ready.promise; await setImmediate();
        expect(value.starts).toEqual([0, 1, 2, 3]);
        await Promise.all([...value.loaded.values()].map(gate => gate.promise));
        for (const gate of value.gates.values()) gate.release();
        const result = await value.result;
        expect(result.status).toBe('rejected');
        if (result.status !== 'rejected') throw new Error('Invalid history was accepted.');
        expect(result.reason).toMatchObject({ message: expect.stringContaining('sealed byte/revision inventory') });
        expect(result.reason).not.toBe(later);
        expect(value.active()).toBe(0);
        expect(value.starts).toEqual([0, 1, 2, 3]);
      });
    });
  });

  it('settles the final partial batch before rejecting and releasing the caller to later work', async () => {
    const failure = new Error('Original final-batch read failure');
    await fixture(async (input, original) => {
      await observe(input, original.description, { held: [128, 129, 130], transform(index, record) {
        if (index === 128) throw failure;
        return record;
      } }, async value => {
        await value.ready.promise; await setImmediate();
        expect(value.starts).toEqual(Array.from({ length: 131 }, (_, index) => index));
        await Promise.all([...value.loaded.values()].map(gate => gate.promise));
        value.gates.get(128)!.release(); await setImmediate();
        expect(value.settled()).toBe(false);
        expect(value.active()).toBe(2);
        value.gates.get(130)!.release(); value.gates.get(129)!.release();
        const result = await value.result;
        expect(result.status).toBe('rejected');
        if (result.status !== 'rejected') throw new Error('A failed final read was accepted.');
        expect(result.reason).toBe(failure);
        expect(value.active()).toBe(0);
      });
    });
  });

  it.each(['bytes', 'revisions', 'single-zero', 'single-two', 'single-predecessor'] as const)(
    'retains the original per-key %s rejection after every in-flight read settles', async fault => {
      await fixture(async (input, original) => {
        const index = fault.startsWith('single-') ? 1 : 0;
        await observe(input, original.description, { transform(selected, record) {
          if (selected !== index || !record) return record;
          const object = original.description.inventory.objects[index]!;
          return { ...record,
            ...(fault === 'bytes' ? { encodedBytes: object.maximumEncodedBytes + 1 } : {}),
            ...(fault === 'revisions' ? { revision: object.maximumRevisions + 1 } : {}),
            ...(fault === 'single-zero' ? { revision: 0 } : {}),
            ...(fault === 'single-two' ? { revision: 2 } : {}),
            ...(fault === 'single-predecessor' ? { previousDigest: 'f'.repeat(64) } : {})
          };
        } }, async value => {
          const result = await value.result;
          expect(result.status).toBe('rejected');
          if (result.status !== 'rejected') throw new Error('Invalid history was accepted.');
          expect(result.reason).toMatchObject({ message: expect.stringContaining('sealed byte/revision inventory') });
          expect(value.active()).toBe(0);
          expect(value.maximum()).toBeLessThanOrEqual(4);
          expect(value.starts.length).toBeLessThanOrEqual(4);
        });
      });
    }
  );
});
