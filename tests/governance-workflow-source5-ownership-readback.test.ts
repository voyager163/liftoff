import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { withSource5WorkflowLease } from '../src/governance-activation/workflow-source5-authority.js';
import { source5WorkflowOwnership } from '../src/governance-activation/workflow-source5-ownership.js';
import { source5WorkflowOriginalPlanValue } from '../src/governance-activation/workflow-source5-context.js';
import { workflowSource5JournalFixture } from './fixtures/workflow-source5-journal.js';

const io = vi.hoisted(() => ({
  observe: undefined as undefined | ((namespace: string, key: string) => (error: unknown) => Promise<void>)
}));
vi.mock('../src/adapters/filesystem/update-previews.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/adapters/filesystem/update-previews.js')>();
  return { ...actual, createWorkflowSource5ControlStore(...args: Parameters<typeof actual.createWorkflowSource5ControlStore>) {
    const store = actual.createWorkflowSource5ControlStore(...args);
    return { ...store, async read(...selected: Parameters<typeof store.read>) {
      const observe = io.observe?.(...selected);
      let failure: unknown;
      try { return await store.read(...selected); }
      catch (error) { failure = error; throw error; }
      finally { await observe?.(failure); }
    } };
  } };
});

const roots: string[] = [];
afterEach(async () => {
  io.observe = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const value = await workflowSource5JournalFixture();
  roots.push(value.root);
  await value.store.save('plan', value.control.controlKey,
    source5WorkflowOriginalPlanValue(value.projectRoot, value.plan, value.approval), null);
  return value;
}

async function prepared(value: Awaited<ReturnType<typeof fixture>>,
  lease: Parameters<typeof source5WorkflowOwnership>[0]['lease']) {
  const owner = await source5WorkflowOwnership({ ...value, lease });
  await owner.prepare();
  const generationKey = (kind: 'reservation' | 'confirmation', generation: number) =>
    canonicalSha256({ kind: `workflow-source5-owner-${kind}-key.v1`, entryKey: owner.entryKey, generation });
  const selections = [
    { namespace: 'proof' as const,
      key: canonicalSha256({ kind: 'workflow-source5-owner-manifest-key.v1', entryKey: owner.entryKey }) },
    { namespace: 'operation' as const, key: owner.entryKey },
    { namespace: 'proof' as const, key: generationKey('reservation', 1) },
    { namespace: 'proof' as const, key: generationKey('confirmation', 0) }
  ];
  const records = await Promise.all(selections.map(({ namespace, key }) => value.store.read(namespace, key)));
  return { owner, selections, records };
}

function observePairs(selections: readonly { namespace: string; key: string }[]) {
  const keys = selections.map(({ namespace, key }) => `${namespace}:${key}`);
  const state = { started: [] as string[], completed: [] as number[],
    active: 0, maximum: 0, errors: new Map<string, unknown>() };
  const pairs = [0, 2].map(() => ({ ready: Promise.withResolvers<void>(), sibling: Promise.withResolvers<void>(),
    started: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined }));
  io.observe = (namespace, key) => {
    const selected = `${namespace}:${key}`, index = keys.indexOf(selected);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(state.started).not.toContain(selected);
    const pair = pairs[Math.floor(index / 2)]!;
    expect(state.completed).toHaveLength(Math.floor(index / 2) * 2);
    if (!pair.started) expect(state.active).toBe(0);
    state.started.push(selected);
    state.maximum = Math.max(state.maximum, ++state.active);
    if (++pair.started === 1) {
      pair.timer = setTimeout(() => pair.ready.reject(new Error('Both ownership reads did not start.')), 5000);
    } else {
      clearTimeout(pair.timer);
      pair.ready.resolve();
    }
    return async error => {
      try {
        if (error !== undefined) state.errors.set(selected, error);
        await pair.ready.promise;
        if (index % 2 === 0) await pair.sibling.promise;
        else pair.sibling.resolve();
      } finally { state.completed.push(index); state.active--; }
    };
  };
  return { keys, state };
}

describe('bounded fresh ownership readback', () => {
  it('reads both ordered pairs completely, preserves retained bytes and rereads lost confirmation on the next call', async () => {
    const value = await fixture();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const { owner, selections, records } = await prepared(value, lease);
      const retained = await Promise.all(records.map(async record =>
        record ? { path: record.path, bytes: await readFile(record.path) } : null));
      const { keys, state } = observePairs(selections);
      await owner.assertCurrent(false);
      io.observe = undefined;
      expect(state.started.toSorted()).toEqual(keys.toSorted());
      expect(state.maximum).toBe(2);
      expect(state.active).toBe(0);
      expect(state.completed).toEqual([1, 0, 3, 2]);
      expect(state.errors.size).toBe(0);
      for (const record of retained) if (record) expect(await readFile(record.path)).toEqual(record.bytes);
      await unlink(records[3]!.path);
      await expect(owner.assertCurrent(false)).rejects.toThrow(/durably confirmed/);
    });
  });

  it.each([0, 2])('settles the failed pair at index %s and retains its first raw error rather than temporal completion order', async offset => {
    const value = await fixture();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const { owner, selections, records } = await prepared(value, lease);
      if (offset === 2) {
        await value.store.save('proof', selections[2]!.key, { pending: true }, null);
        records[2] = await value.store.read('proof', selections[2]!.key);
      }
      await writeFile(records[offset]!.path, '{');
      await writeFile(records[offset + 1]!.path, '{}');
      const { keys, state } = observePairs(selections);
      const failure = await owner.assertCurrent(false).then(
        () => { throw new Error('Malformed physical ownership records must refuse.'); }, (error: unknown) => error);
      io.observe = undefined;
      expect(state.started.toSorted()).toEqual(keys.slice(0, offset + 2).toSorted());
      expect(state.active).toBe(0);
      expect(state.maximum).toBe(2);
      expect(state.completed).toEqual(offset === 0 ? [1, 0] : [1, 0, 3, 2]);
      expect(state.errors.size).toBe(2);
      expect(failure).toBe(state.errors.get(keys[offset]!));
    });
  });

  it.each(['missing-manifest', 'retired-owner', 'foreign-original-snapshot'] as const)(
    'retains the original %s semantic refusal ahead of a later physical sibling failure', async fault => {
      const value = await fixture();
      await withSource5WorkflowLease(value.projectRoot, async lease => {
        const { owner, selections, records } = await prepared(value, lease);
        if (fault === 'missing-manifest') {
          await unlink(records[0]!.path);
          await writeFile(records[1]!.path, '{');
        } else if (fault === 'retired-owner') {
          await value.store.save('proof', selections[2]!.key, { pending: true }, null);
          await writeFile(records[3]!.path, '{');
        } else {
          const pointer = records[1]!;
          if (!isRecord(pointer.value) || !isRecord(pointer.value.owner)) throw new Error('Expected original pointer.');
          await unlink(pointer.path);
          await value.store.save('operation', selections[1]!.key,
            { ...pointer.value, owner: { ...pointer.value.owner, rawSnapshotDigest: 'f'.repeat(64) } }, null);
          await writeFile(records[3]!.path, '{');
        }
        const { keys, state } = observePairs(selections);
        const failure = await owner.assertCurrent(false).then(
          () => { throw new Error('Missing or retired original ownership must refuse.'); }, (error: unknown) => error);
        io.observe = undefined;
        expect(failure).toMatchObject({ code: fault === 'retired-owner'
          ? 'workflow-source5-owner-retired' : 'workflow-source5-owner' });
        if (fault === 'foreign-original-snapshot') {
          expect(failure).toMatchObject({ message: expect.stringContaining('independently sealed original plan') });
        }
        expect(state.started.toSorted()).toEqual(keys.slice(0, fault === 'missing-manifest' ? 2 : 4).toSorted());
        expect(state.active).toBe(0);
        expect(state.maximum).toBe(2);
        expect(state.errors.size).toBe(1);
        expect(failure).not.toBe([...state.errors.values()][0]);
      });
    });
});
