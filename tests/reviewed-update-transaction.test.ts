import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  applyProjectFileTransaction,
  captureProjectFileSnapshot,
  ProjectFileTransactionError
} from '../src/adapters/filesystem/project-transaction.js';
import type { ProjectFileMutation } from '../src/adapters/filesystem/project-transaction.js';
import { projectMutationLockPath, withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import {
  applyReviewedUpdateTransaction,
  inspectReviewedUpdateTransaction,
  recoverReviewedUpdateTransaction,
  reviewedUpdateTransactionPathParts,
  ReviewedUpdateTransactionError
} from '../src/adapters/filesystem/reviewed-update-transaction.js';
import type {
  ReviewedUpdateApprovalStore,
  ReviewedUpdateTransactionCheckpoint
} from '../src/adapters/filesystem/reviewed-update-transaction.js';

const roots: string[] = [];
const fingerprint = 'a'.repeat(64);
const privateMode = process.platform === 'win32' ? 0o666 : 0o600;
const raw = Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x0d, 0x0a, 0xff, 0x00, 0x7d, 0x0d, 0x0a]);
const faults = vi.hoisted(() => ({
  journalWrite: false, targetWrite: false, targetRename: false, retirement: false,
  intentAppend: false, commitAppend: false, journalCleanup: false, modeChange: false
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    chmod: async (...args: Parameters<typeof actual.chmod>) => {
      if (faults.modeChange) {
        faults.modeChange = false;
        throw Object.assign(new Error('injected permission change denied'), { code: 'EACCES' });
      }
      return actual.chmod(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const name = String(args[0]);
      if (name.endsWith('reviewed-update-transaction.json') || name.endsWith('-target.tmp')) {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementation(async (content, options) => {
          const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content as string);
          const journal = name.endsWith('reviewed-update-transaction.json');
          const initial = journal && args[1] === 'wx' && faults.journalWrite;
          const target = !journal && faults.targetWrite;
          const intent = journal && bytes.toString('utf8').includes('"phase":"mutation"') && faults.intentAppend;
          const commit = journal && bytes.toString('utf8').includes('"phase":"committed"') && faults.commitAppend;
          if (initial || target || intent || commit) {
            if (initial) faults.journalWrite = false;
            if (target) faults.targetWrite = false;
            if (intent) faults.intentAppend = false;
            if (commit) faults.commitAppend = false;
            await write(bytes.subarray(0, Math.min(9, bytes.length)));
            throw Object.assign(new Error('injected partial-write disk full'), { code: 'ENOSPC' });
          }
          return write(content, options);
        });
      }
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (faults.targetRename && String(args[0]).endsWith('-target.tmp')) {
        faults.targetRename = false;
        throw Object.assign(new Error('injected target rename denied'), { code: 'EACCES' });
      }
      return actual.rename(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      const name = String(args[0]);
      if (faults.retirement && name.endsWith(path.join('evidence', 'receipt.json'))) {
        faults.retirement = false;
        throw Object.assign(new Error('injected retirement denied'), { code: 'EACCES' });
      }
      if (faults.journalCleanup && name.endsWith('reviewed-update-transaction.json')) {
        faults.journalCleanup = false;
        throw Object.assign(new Error('injected journal cleanup denied'), { code: 'EACCES' });
      }
      return actual.unlink(...args);
    }
  };
});

class FixtureApprovalStore implements ReviewedUpdateApprovalStore {
  constructor(readonly directory: string) {}
  readonly write = vi.fn(async (plan: string, digest: string) => {
    await mkdir(this.directory, { recursive: true });
    await writeFile(path.join(this.directory, `${plan}-${digest}.json`), canonicalJson({ plan, digest }), { mode: 0o600 });
  });
  readonly verify = vi.fn(async (plan: string, digest: string) => {
    try {
      return await readFile(path.join(this.directory, `${plan}-${digest}.json`), 'utf8') === canonicalJson({ plan, digest });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  });
  readonly remove = vi.fn(async (plan: string, digest: string) => {
    await rm(path.join(this.directory, `${plan}-${digest}.json`), { force: true });
  });
}

async function fixture() {
  const relative = `.reviewed-update-fixture-${randomUUID()}`;
  await mkdir(relative);
  roots.push(relative);
  const parent = path.resolve(relative);
  const root = path.join(parent, 'project with spaces');
  await mkdir(root);
  const store = new FixtureApprovalStore(path.join(parent, 'user local approvals'));
  return { root, parent, store, journal: path.join(root, ...reviewedUpdateTransactionPathParts) };
}

async function put(root: string, parts: string[], content: string | Buffer, mode = 0o600) {
  const target = path.join(root, ...parts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, { mode });
}

async function tree(root: string): Promise<Record<string, { content: string; mode: number } | 'directory'>> {
  const entries: Record<string, { content: string; mode: number } | 'directory'> = {};
  async function visit(parts: string[]) {
    for (const name of (await readdir(path.join(root, ...parts))).sort()) {
      const next = [...parts, name];
      const native = path.join(root, ...next);
      const stat = await lstat(native);
      if (stat.isDirectory()) {
        entries[next.join('/')] = 'directory';
        await visit(next);
      } else if (stat.isFile()) {
        entries[next.join('/')] = { content: (await readFile(native)).toString('base64'), mode: stat.mode & 0o7777 };
      }
    }
  }
  await visit([]);
  return entries;
}

async function migrationFixture() {
  const result = await fixture();
  const source = ['governance', 'evidence', 'receipt.json'];
  const history = ['governance', 'history', 'snapshot', 'files', ...source];
  await put(result.root, source, raw);
  await put(result.root, ['governance', 'state.json'], 'v1 state\r\n');
  await put(result.root, ['liftoff.manifest.json'], 'v1 manifest\r\n');
  const mutations: ProjectFileMutation[] = [
    { type: 'write', pathParts: history, content: raw },
    { type: 'delete', pathParts: source },
    { type: 'write', pathParts: ['governance', 'state.json'], content: 'v2 state\n' },
    { type: 'write', pathParts: ['liftoff.manifest.json'], content: 'v2 manifest\n' },
    { type: 'write', pathParts: ['governance', 'migration-state.json'], content: 'committed successor\n' }
  ];
  return { ...result, source, history, mutations };
}

async function interrupted(phase: ReviewedUpdateTransactionCheckpoint['phase'], index?: number, historyMode?: number) {
  const context = await migrationFixture();
  if (historyMode !== undefined && context.mutations[0].type === 'write') context.mutations[0].mode = historyMode;
  const moduleUrl = new URL('../src/adapters/filesystem/reviewed-update-transaction.ts', import.meta.url).href;
  const sourceRoot = new URL('../src/', import.meta.url).href;
  const serialized = context.mutations.map((entry) => entry.type === 'write'
    ? { ...entry, content: Buffer.from(entry.content).toString('base64') } : entry);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { registerHooks } from 'node:module';
    import { readFileSync } from 'node:fs';
    import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    import { transformSync } from 'rolldown/utils';
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (context.parentURL?.startsWith(${JSON.stringify(sourceRoot)}) && specifier.endsWith('.js')) {
          return nextResolve(new URL(specifier.slice(0, -3) + '.ts', context.parentURL).href, context);
        }
        return nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        if (url.startsWith(${JSON.stringify(sourceRoot)}) && url.endsWith('.ts')) {
          return { format: 'module', shortCircuit: true, source: transformSync(
            url, readFileSync(new URL(url), 'utf8'), { lang: 'ts' }
          ).code };
        }
        return nextLoad(url, context);
      }
    });
    const { applyReviewedUpdateTransaction } = await import(${JSON.stringify(moduleUrl)});
    const { canonicalJson } = await import(${JSON.stringify(new URL('../src/domain/governance/activation/canonical-json.ts', import.meta.url).href)});
    const directory = ${JSON.stringify(context.store.directory)};
    const approvalStore = {
      async write(plan, digest) {
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, plan + '-' + digest + '.json'), canonicalJson({ plan, digest }), { mode: 0o600 });
      },
      async verify(plan, digest) {
        try { return await readFile(path.join(directory, plan + '-' + digest + '.json'), 'utf8') === canonicalJson({ plan, digest }); }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      },
      async remove(plan, digest) { await rm(path.join(directory, plan + '-' + digest + '.json'), { force: true }); }
    };
    const mutations = ${JSON.stringify(serialized)}.map(entry => entry.type === 'write'
      ? { ...entry, content: Buffer.from(entry.content, 'base64') } : entry);
    await applyReviewedUpdateTransaction(${JSON.stringify(context.root)}, mutations, {
      planFingerprint: ${JSON.stringify(fingerprint)}, approvalStore,
      onCheckpoint: async checkpoint => {
        if (checkpoint.phase === ${JSON.stringify(phase)} && checkpoint.index === ${JSON.stringify(index)}) process.exit(73);
      }
    });
    process.exitCode = 9;
  `], { encoding: 'utf8', timeout: 20_000, cwd: process.cwd() });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(73);
  const lock = await projectMutationLockPath(context.root);
  expect(JSON.parse(await readFile(lock, 'utf8')).pid).toBe(child.pid);
  return { ...context, lock };
}

afterEach(async () => {
  for (const name of Object.keys(faults) as (keyof typeof faults)[]) faults[name] = false;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('existing project transactions with raw bytes', () => {
  it('writes Buffer content without UTF-8 conversion and remains reentrant', async () => {
    const { root } = await fixture();
    await withProjectMutationLock(root, async () => {
      await applyProjectFileTransaction(root, [{ type: 'write', pathParts: ['raw.bin'], content: raw }]);
    });
    expect(await readFile(path.join(root, 'raw.bin'))).toEqual(raw);
  });

  it('restores exact original bytes and modes after an injected later error', async () => {
    const { root } = await fixture();
    await put(root, ['raw.bin'], raw, 0o640);
    const mode = (await lstat(path.join(root, 'raw.bin'))).mode & 0o7777;
    await expect(applyProjectFileTransaction(root, [
      { type: 'write', pathParts: ['raw.bin'], content: Buffer.from([0xfe, 0x00]) },
      { type: 'write', pathParts: ['later.bin'], content: raw }
    ], {
      onBeforeMutation: async (_mutation, index) => { if (index === 1) throw new Error('injected failure'); }
    })).rejects.toBeInstanceOf(ProjectFileTransactionError);
    expect(await readFile(path.join(root, 'raw.bin'))).toEqual(raw);
    expect((await lstat(path.join(root, 'raw.bin'))).mode & 0o7777).toBe(mode);
    expect(await readdir(root)).toEqual(['raw.bin']);
  });

  it('rolls back the completed content write when its requested permission change fails', async () => {
    const { root } = await fixture();
    await put(root, ['raw.bin'], raw);
    const before = await tree(root);
    faults.modeChange = true;
    await expect(applyProjectFileTransaction(root, [
      { type: 'write', pathParts: ['raw.bin'], content: Buffer.from('new'), mode: 0o700 }
    ])).rejects.toThrow('permission change denied');
    expect(await tree(root)).toEqual(before);
  });
});

describe.each(['existing', 'durable'] as const)('%s transaction explicit modes', (kind) => {
  const apply = kind === 'existing' ? applyProjectFileTransaction : applyReviewedUpdateTransaction;

  it.runIf(process.platform !== 'win32')('writes explicitly requested source modes for new and replaced files', async () => {
    const { root, store } = await fixture();
    await put(root, ['source'], raw, 0o600);
    await apply(root, [
      { type: 'write', pathParts: ['copy'], content: raw, mode: 0o640 },
      { type: 'write', pathParts: ['source'], content: raw, mode: 0o750 }
    ], { planFingerprint: fingerprint, approvalStore: store });
    expect((await lstat(path.join(root, 'copy'))).mode & 0o777).toBe(0o640);
    expect((await lstat(path.join(root, 'source'))).mode & 0o777).toBe(0o750);
    expect(await readFile(path.join(root, 'copy'))).toEqual(raw);
  });

  it.runIf(process.platform !== 'win32')('restores the original mode rather than the requested target mode on rollback', async () => {
    const { root, store } = await fixture();
    await put(root, ['source'], raw, 0o640);
    const before = await tree(root);
    await expect(apply(root, [
      { type: 'write', pathParts: ['source'], content: Buffer.from('target'), mode: 0o700 },
      { type: 'write', pathParts: ['later'], content: raw, mode: 0o600 }
    ], {
      planFingerprint: fingerprint, approvalStore: store,
      onBeforeMutation: async (_mutation, index) => { if (index === 1) throw new Error('stop'); }
    })).rejects.toThrow('stop');
    expect(await tree(root)).toEqual(before);
  });

  it.runIf(process.platform !== 'win32')('preserves later permission changes instead of rolling them back', async () => {
    const { root, store } = await fixture();
    await put(root, ['source'], raw, 0o640);
    await expect(apply(root, [
      { type: 'write', pathParts: ['source'], content: Buffer.from('target'), mode: 0o700 },
      { type: 'write', pathParts: ['later'], content: raw }
    ], {
      planFingerprint: fingerprint, approvalStore: store,
      onBeforeMutation: async (_mutation, index) => {
        if (index === 1) {
          await chmod(path.join(root, 'source'), 0o750);
          throw new Error('stop');
        }
      }
    })).rejects.toThrow('changed before rollback');
    expect((await lstat(path.join(root, 'source'))).mode & 0o777).toBe(0o750);
    expect(await readFile(path.join(root, 'source'), 'utf8')).toBe('target');
  });

  it.each([-1, 0o10000, 1.5, Number.NaN])('preflights invalid mode %s before any mutation', async (mode) => {
    const { root, store } = await fixture();
    await expect(apply(root, [
      { type: 'write', pathParts: ['first'], content: raw },
      { type: 'write', pathParts: ['invalid'], content: raw, mode }
    ], { planFingerprint: fingerprint, approvalStore: store })).rejects.toThrow(/mode/i);
    expect(await readdir(root)).toEqual([]);
    expect(store.write).not.toHaveBeenCalled();
  });
});

describe('approved durable project transactions', () => {
  it('verifies exact history bytes before retirement and commits the ordered successor', async () => {
    const { root, store, journal, source, history, mutations } = await migrationFixture();
    await put(root, ['.liftoff', 'unrelated.json'], 'not a transaction');
    const preconditions = await Promise.all(mutations.map((entry) => captureProjectFileSnapshot(root, entry.pathParts)));
    const seen: number[] = [];
    const result = await applyReviewedUpdateTransaction(root, mutations, {
      planFingerprint: fingerprint, approvalStore: store, preconditions,
      onBeforeMutation: async (_mutation, index) => {
        seen.push(index);
        if (index === 1) expect(await readFile(path.join(root, ...history))).toEqual(raw);
      }
    });
    expect(result).toMatchObject({ status: 'committed', committed: true, rollbackFailures: [], cleanupFailures: [] });
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(await readFile(path.join(root, ...history))).toEqual(raw);
    expect((await lstat(path.join(root, ...history))).mode & 0o777).toBe(privateMode);
    await expect(readFile(path.join(root, ...source))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')).toBe('v2 manifest\n');
    await expect(readFile(journal)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(root, '.liftoff', 'unrelated.json'), 'utf8')).toBe('not a transaction');
    expect(await readdir(store.directory)).toEqual([]);
  });

  it('validates the plan while holding the lock and before the journal or approval is written', async () => {
    const { root, store } = await fixture();
    const validatePlan = vi.fn(async () => {
      expect(await readFile(await projectMutationLockPath(root), 'utf8')).toContain('"pid"');
      expect(await readdir(root)).toEqual([]);
      expect(store.write).not.toHaveBeenCalled();
      throw new Error('stale exact plan');
    });
    await expect(applyReviewedUpdateTransaction(root, [{ type: 'write', pathParts: ['one'], content: 'one' }], {
      planFingerprint: fingerprint, approvalStore: store, validatePlan
    })).rejects.toThrow('stale exact plan');
    expect(validatePlan).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual([]);
  });

  it('rechecks source preconditions after validation and before any project write', async () => {
    const { root, store } = await fixture();
    await put(root, ['source'], raw);
    const source = await captureProjectFileSnapshot(root, ['source']);
    await expect(applyReviewedUpdateTransaction(root, [{ type: 'write', pathParts: ['destination'], content: raw }], {
      planFingerprint: fingerprint, approvalStore: store, preconditions: [source],
      validatePlan: async () => { await put(root, ['source'], 'concurrent edit'); }
    })).rejects.toThrow('target changed after review: source');
    expect(store.write).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['source']);
  });

  it('rechecks read-only sources and verified copies between mutations', async () => {
    const { root, store, source, history, mutations } = await migrationFixture();
    const before = await tree(root);
    await expect(applyReviewedUpdateTransaction(root, mutations, {
      planFingerprint: fingerprint, approvalStore: store,
      preconditions: [await captureProjectFileSnapshot(root, source)],
      onBeforeMutation: async (_mutation, index) => {
        if (index === 1) await put(root, history, 'changed historical copy');
      }
    })).rejects.toThrow('changed after review');
    expect(await readFile(path.join(root, ...source))).toEqual(raw);
    expect(await readFile(path.join(root, ...history), 'utf8')).toBe('changed historical copy');
    expect((await tree(root))['liftoff.manifest.json']).toEqual(before['liftoff.manifest.json']);
  });

  it('preflights every destination before writing an earlier safe one', async () => {
    const { root, store } = await fixture();
    await mkdir(path.join(root, 'directory'));
    await expect(applyReviewedUpdateTransaction(root, [
      { type: 'write', pathParts: ['first'], content: 'first' },
      { type: 'delete', pathParts: ['directory'] }
    ], { planFingerprint: fingerprint, approvalStore: store })).rejects.toThrow('not a regular file');
    expect(store.write).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['directory']);
  });

  it('preflights case collisions between read-only source and mutation parent paths', async () => {
    const { root, store } = await fixture();
    await expect(applyReviewedUpdateTransaction(root, [{ type: 'write', pathParts: ['source', 'new'], content: 'new' }], {
      planFingerprint: fingerprint, approvalStore: store, preconditions: [{ pathParts: ['Source', 'missing'] }]
    })).rejects.toThrow('case-colliding');
    expect(store.write).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    [['same'], ['same']],
    [['Core'], ['core']],
    [['Upper', 'a'], ['upper', 'b']],
    [['prefix'], ['prefix', 'child']],
    [['.liftoff', 'reviewed-update-transaction.json']],
    [['..', 'outside']],
    [['C:', 'outside']],
    [['folder\\outside']],
    [['file:stream']],
    [['CON']]
  ])('rejects unsafe, duplicate, overlapping, and case-colliding inventories: %j', async (...paths) => {
    const { root, store } = await fixture();
    const mutations = paths.map((pathParts) => ({ type: 'write' as const, pathParts, content: 'never write' }));
    await expect(applyReviewedUpdateTransaction(root, mutations, {
      planFingerprint: fingerprint, approvalStore: store
    })).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
    expect(store.write).not.toHaveBeenCalled();
  });

  it('rejects on-disk case aliases and linked parents without following them', async () => {
    const { root, parent, store } = await fixture();
    await put(root, ['Case'], 'preserved');
    await expect(applyReviewedUpdateTransaction(root, [{ type: 'write', pathParts: ['case'], content: 'new' }], {
      planFingerprint: fingerprint, approvalStore: store
    })).rejects.toThrow('collision');
    const outside = path.join(parent, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(applyReviewedUpdateTransaction(root, [{ type: 'write', pathParts: ['linked', 'file'], content: 'new' }], {
      planFingerprint: fingerprint, approvalStore: store
    })).rejects.toThrow('symlink or junction');
    expect(await readdir(outside)).toEqual([]);
    expect(store.write).not.toHaveBeenCalled();
  });

  it('does not create a journal when the external approval store rejects the write', async () => {
    const { root, store } = await fixture();
    store.write.mockRejectedValueOnce(new Error('approval storage unavailable'));
    await expect(applyReviewedUpdateTransaction(root, [{ type: 'write', pathParts: ['one'], content: 'one' }], {
      planFingerprint: fingerprint, approvalStore: store
    })).rejects.toThrow('approval storage unavailable');
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses a store that acknowledges an approval without actually persisting it', async () => {
    const { root, store } = await fixture();
    store.write.mockResolvedValue(undefined);
    await expect(applyReviewedUpdateTransaction(root, [{ type: 'write', pathParts: ['one'], content: 'one' }], {
      planFingerprint: fingerprint, approvalStore: store
    })).rejects.toThrow('did not persist its transaction seal');
    expect(await readdir(root)).toEqual([]);
  });

  it.each(['journalWrite', 'targetWrite', 'targetRename', 'retirement', 'intentAppend'] as const)(
    'recovers from injected filesystem failure %s and cleans exact partial temporaries', async (fault) => {
      const { root, store, mutations } = await migrationFixture();
      await put(root, ['.unrelated.liftoff.tmp'], 'not owned by this transaction');
      const before = await tree(root);
      faults[fault] = true;
      await expect(applyReviewedUpdateTransaction(root, mutations, {
        planFingerprint: fingerprint, approvalStore: store
      })).rejects.toThrow(/failed to (create .liftoff\/reviewed-update-transaction.json|write governance\/history|delete governance\/evidence)/);
      expect(await tree(root)).toEqual(before);
      expect(await readdir(store.directory)).toEqual([]);
    }
  );

  it('does not roll back when persisting the local commit marker fails after the external commit seal', async () => {
    const { root, store, mutations } = await migrationFixture();
    faults.commitAppend = true;
    const result = await applyReviewedUpdateTransaction(root, mutations, {
      planFingerprint: fingerprint, approvalStore: store
    });
    expect(result).toMatchObject({ status: 'committed', committed: true, rollbackFailures: [] });
    expect(result.cleanupFailures).toContainEqual(expect.stringContaining('partial-write disk full'));
    expect(await inspectReviewedUpdateTransaction(root, { approvalStore: store })).toMatchObject({ status: 'committed' });
    expect(await recoverReviewedUpdateTransaction(root, { approvalStore: store })).toMatchObject({ status: 'committed', cleanupFailures: [] });
    expect(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')).toBe('v2 manifest\n');
  });

  it('rolls back all applied raw bytes and retirements on an injected precommit error', async () => {
    const { root, store, mutations } = await migrationFixture();
    const before = await tree(root);
    await expect(applyReviewedUpdateTransaction(root, mutations, {
      planFingerprint: fingerprint, approvalStore: store,
      onBeforeMutation: async (_mutation, index) => { if (index === 4) throw new Error('manifest/journal failure'); }
    })).rejects.toThrow('All attributable changes were rolled back');
    expect(await tree(root)).toEqual(before);
    expect(await readdir(store.directory)).toEqual([]);
  });

  it('preserves concurrently modified destinations and reports their exact recovery path', async () => {
    const { root, store } = await fixture();
    await put(root, ['one'], raw);
    await expect(applyReviewedUpdateTransaction(root, [
      { type: 'write', pathParts: ['one'], content: 'target' },
      { type: 'write', pathParts: ['two'], content: 'later' }
    ], {
      planFingerprint: fingerprint, approvalStore: store,
      onBeforeMutation: async (_mutation, index) => {
        if (index === 1) {
          await put(root, ['one'], 'developer edit');
          throw new Error('later failure');
        }
      }
    })).rejects.toMatchObject({ rollbackFailures: [expect.stringContaining('one')] });
    expect(await readFile(path.join(root, 'one'), 'utf8')).toBe('developer edit');
    expect((await inspectReviewedUpdateTransaction(root, { approvalStore: store })).destinations[0])
      .toMatchObject({ disposition: 'changed', attempted: true });
    expect(await recoverReviewedUpdateTransaction(root, { approvalStore: store }))
      .toMatchObject({ status: 'blocked', committed: false });
    await put(root, ['one'], raw);
    expect(await recoverReviewedUpdateTransaction(root, { approvalStore: store }))
      .toMatchObject({ status: 'rolled-back', rollbackFailures: [] });
  });

  it.runIf(process.platform !== 'win32')('preserves existing modes and refuses to undo a concurrent mode edit', async () => {
    const { root, store } = await fixture();
    await put(root, ['one'], raw, 0o750);
    await expect(applyReviewedUpdateTransaction(root, [
      { type: 'write', pathParts: ['one'], content: 'target' },
      { type: 'write', pathParts: ['two'], content: 'later' }
    ], {
      planFingerprint: fingerprint, approvalStore: store,
      onBeforeMutation: async (_mutation, index) => {
        if (index === 1) {
          expect((await lstat(path.join(root, 'one'))).mode & 0o777).toBe(0o750);
          await chmod(path.join(root, 'one'), 0o700);
          throw new Error('later failure');
        }
      }
    })).rejects.toBeInstanceOf(ReviewedUpdateTransactionError);
    expect((await lstat(path.join(root, 'one'))).mode & 0o777).toBe(0o700);
    expect(await readFile(path.join(root, 'one'), 'utf8')).toBe('target');
  });

  it('reports approval cleanup errors as committed without undoing project state', async () => {
    const { root, store, mutations, history } = await migrationFixture();
    store.remove.mockRejectedValue(new Error('seal cleanup denied'));
    const result = await applyReviewedUpdateTransaction(root, mutations, {
      planFingerprint: fingerprint, approvalStore: store
    });
    expect(result).toMatchObject({ status: 'committed', committed: true, rollbackFailures: [] });
    expect(result.cleanupFailures).toContainEqual(expect.stringContaining('seal cleanup denied'));
    expect(await readFile(path.join(root, ...history))).toEqual(raw);
    expect(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')).toBe('v2 manifest\n');
  });

  it('retains the commit seal when base-approval removal fails, preventing replay of a precommit journal', async () => {
    const { root, store, mutations, journal } = await migrationFixture();
    store.remove.mockRejectedValueOnce(new Error('base approval revocation failed'));
    let precommit = '';
    const result = await applyReviewedUpdateTransaction(root, mutations, {
      planFingerprint: fingerprint, approvalStore: store,
      onCheckpoint: async ({ phase }) => {
        if (phase === 'committed') {
          precommit = (await readFile(journal, 'utf8')).replace(canonicalJson({ phase: 'committed' }), '');
        }
      }
    });
    expect(result).toMatchObject({ status: 'committed', committed: true });
    await put(root, [...reviewedUpdateTransactionPathParts], precommit);
    expect(await inspectReviewedUpdateTransaction(root, { approvalStore: store })).toMatchObject({ status: 'committed' });
    expect(await recoverReviewedUpdateTransaction(root, { approvalStore: store })).toMatchObject({ status: 'committed', cleanupFailures: [] });
    expect(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')).toBe('v2 manifest\n');
  });

  it('leaves a blocking journal when a completed rollback cannot revoke its external approval', async () => {
    const { root, store, mutations, journal } = await migrationFixture();
    store.remove.mockRejectedValueOnce(new Error('base approval revocation failed'));
    await expect(applyReviewedUpdateTransaction(root, mutations, {
      planFingerprint: fingerprint, approvalStore: store,
      onBeforeMutation: async (_mutation, index) => { if (index === 3) throw new Error('stop before manifest'); }
    })).rejects.toThrow('base approval revocation failed');
    expect(await readFile(journal, 'utf8')).toContain('"schemaVersion":1');
    await expect(applyReviewedUpdateTransaction(root, mutations, {
      planFingerprint: fingerprint, approvalStore: store
    })).rejects.toThrow('existing recovery journal blocks new work');
    expect(await recoverReviewedUpdateTransaction(root, { approvalStore: store }))
      .toMatchObject({ status: 'rolled-back', cleanupFailures: [] });
  });

  it('finishes exact journal cleanup after rollback even if journal unlink failed after approval revocation', async () => {
    const { root, store, mutations } = await migrationFixture();
    const before = await tree(root);
    faults.journalCleanup = true;
    await expect(applyReviewedUpdateTransaction(root, mutations, {
      planFingerprint: fingerprint, approvalStore: store,
      onBeforeMutation: async (_mutation, index) => { if (index === 3) throw new Error('stop before manifest'); }
    })).rejects.toThrow('journal cleanup denied');
    expect(await inspectReviewedUpdateTransaction(root, { approvalStore: store }))
      .toMatchObject({ status: 'interrupted', committed: false });
    expect(await recoverReviewedUpdateTransaction(root, { approvalStore: store }))
      .toMatchObject({ status: 'rolled-back', cleanupFailures: [] });
    expect(await tree(root)).toEqual(before);
  });

  it('reports errors after the committed checkpoint without restoring v1', async () => {
    const { root, store, mutations } = await migrationFixture();
    const result = await applyReviewedUpdateTransaction(root, mutations, {
      planFingerprint: fingerprint, approvalStore: store,
      onCheckpoint: async ({ phase }) => { if (phase === 'committed') throw new Error('postcommit interruption'); }
    });
    expect(result).toMatchObject({ status: 'committed', committed: true });
    expect(result.cleanupFailures).toContainEqual(expect.stringContaining('postcommit interruption'));
    expect(await recoverReviewedUpdateTransaction(root, { approvalStore: store })).toMatchObject({ status: 'committed' });
    expect(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')).toBe('v2 manifest\n');
  });

  it('keeps the commit recoverable when exact journal cleanup fails', async () => {
    const { root, store, mutations, journal } = await migrationFixture();
    faults.journalCleanup = true;
    const result = await applyReviewedUpdateTransaction(root, mutations, {
      planFingerprint: fingerprint, approvalStore: store
    });
    expect(result).toMatchObject({ status: 'committed', committed: true });
    expect(result.cleanupFailures).toContainEqual(expect.stringContaining('journal cleanup denied'));
    expect(await readFile(journal, 'utf8')).toContain('"phase":"committed"');
    expect(store.remove).not.toHaveBeenCalled();
    expect(await recoverReviewedUpdateTransaction(root, { approvalStore: store })).toMatchObject({ status: 'committed', cleanupFailures: [] });
  });

  it('reports a changed lock after commit as committed and preserves the replacement lock', async () => {
    const { root, store, mutations } = await migrationFixture();
    const lock = await projectMutationLockPath(root);
    const result = await applyReviewedUpdateTransaction(root, mutations, {
      planFingerprint: fingerprint, approvalStore: store,
      onCheckpoint: async ({ phase }) => { if (phase === 'committed') await writeFile(lock, 'changed lock'); }
    });
    expect(result).toMatchObject({ status: 'committed', committed: true });
    expect(result.cleanupFailures).toContainEqual(expect.stringContaining('lock'));
    expect(await readFile(lock, 'utf8')).toBe('changed lock');
    expect(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')).toBe('v2 manifest\n');
    await unlink(lock);
    expect(await recoverReviewedUpdateTransaction(root, { approvalStore: store })).toMatchObject({ status: 'committed' });
  });
});

describe('durable recovery across real process interruption', () => {
  it.runIf(process.platform !== 'win32')('recovers a sealed explicit-mode historical copy after process interruption', async () => {
    const context = await interrupted('after-mutation', 0, 0o640);
    await unlink(context.lock);
    const header = JSON.parse((await readFile(context.journal, 'utf8')).split('\n')[0]);
    expect(header.mutations[0].mode).toBe(0o640);
    expect(header.mutations[0].target.mode).toBe(0o640);
    expect((await lstat(path.join(context.root, ...context.history))).mode & 0o777).toBe(0o640);
    const inspection = await inspectReviewedUpdateTransaction(context.root, { approvalStore: context.store });
    expect(inspection.status).toBe('interrupted');
    expect(inspection.destinations[0]).toMatchObject({ disposition: 'target' });
    expect(await recoverReviewedUpdateTransaction(context.root, { approvalStore: context.store }))
      .toMatchObject({ status: 'rolled-back', rollbackFailures: [], cleanupFailures: [] });
    expect(await readFile(path.join(context.root, ...context.source))).toEqual(raw);
    await expect(lstat(path.join(context.root, ...context.history))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([
    ['prepared', undefined],
    ['before-mutation', 0],
    ['staged', 0],
    ['after-mutation', 0],
    ['after-mutation', 1],
    ['after-mutation', 3],
    ['before-commit', undefined]
  ] as const)('recovers only the approved transaction interrupted at %s/%s', async (phase, index) => {
    const context = await interrupted(phase, index);
    const beforeInspection = await tree(context.root);
    const inspection = await inspectReviewedUpdateTransaction(context.root, { approvalStore: context.store });
    expect(inspection).toMatchObject({ status: 'interrupted', committed: false, planFingerprint: fingerprint });
    expect(inspection.journalPath).toBe(context.journal);
    expect((await lstat(context.journal)).mode & 0o777).toBe(privateMode);
    expect(await tree(context.root)).toEqual(beforeInspection);
    await expect(recoverReviewedUpdateTransaction(context.root, { approvalStore: context.store }))
      .rejects.toThrow('Another cooperating Liftoff mutation');
    // Only this known child has stopped; the production adapter never removes an unowned lock.
    await unlink(context.lock);
    const result = await recoverReviewedUpdateTransaction(context.root, { approvalStore: context.store });
    expect(result).toMatchObject({ status: 'rolled-back', committed: false, rollbackFailures: [], cleanupFailures: [] });
    expect(await readFile(path.join(context.root, ...context.source))).toEqual(raw);
    expect(await readFile(path.join(context.root, 'liftoff.manifest.json'), 'utf8')).toBe('v1 manifest\r\n');
    expect(await readFile(path.join(context.root, 'governance', 'state.json'), 'utf8')).toBe('v1 state\r\n');
    expect(await readdir(context.root)).toEqual(['governance', 'liftoff.manifest.json']);
    expect(await readdir(path.join(context.root, 'governance'))).toEqual(['evidence', 'state.json']);
    expect(await readdir(context.store.directory)).toEqual([]);
    expect(await recoverReviewedUpdateTransaction(context.root, { approvalStore: context.store })).toMatchObject({ status: 'absent' });
  });

  it('leaves an untouched target-matching destination alone rather than attributing it to the transaction', async () => {
    const context = await interrupted('prepared');
    await unlink(context.lock);
    await put(context.root, ['liftoff.manifest.json'], 'v2 manifest\n');
    const inspection = await inspectReviewedUpdateTransaction(context.root, { approvalStore: context.store });
    expect(inspection.destinations.find((entry) => entry.pathParts[0] === 'liftoff.manifest.json'))
      .toMatchObject({ disposition: 'changed', attempted: false });
    const recovered = await recoverReviewedUpdateTransaction(context.root, { approvalStore: context.store });
    expect(recovered).toMatchObject({ status: 'blocked', committed: false });
    expect(recovered.rollbackFailures).toContainEqual(expect.stringContaining('liftoff.manifest.json'));
    expect(await readFile(path.join(context.root, 'liftoff.manifest.json'), 'utf8')).toBe('v2 manifest\n');
  });

  it('preserves directories created independently for mutations that were never attempted', async () => {
    const context = await interrupted('prepared');
    await unlink(context.lock);
    const unattempted = path.join(context.root, 'governance', 'history', 'snapshot');
    await mkdir(unattempted, { recursive: true });
    expect(await recoverReviewedUpdateTransaction(context.root, { approvalStore: context.store }))
      .toMatchObject({ status: 'rolled-back', rollbackFailures: [] });
    expect((await lstat(unattempted)).isDirectory()).toBe(true);
  });

  it('committed recovery removes only the journal and exact seals, retaining later edits and neighbors', async () => {
    const context = await interrupted('committed');
    await unlink(context.lock);
    await put(context.root, ['governance', 'state.json'], 'later revalidation progress');
    await put(context.root, ['.liftoff', 'reviewed-update-transaction.json.unrelated'], 'not owned');
    await put(context.root, ['.liftoff', '.liftoff-reviewed-other.tmp'], 'not owned');
    await put(context.root, ['governance', 'unrelated.json'], 'not owned');
    const before = await tree(context.root);
    const inspection = await inspectReviewedUpdateTransaction(context.root, { approvalStore: context.store });
    expect(inspection.status).toBe('committed');
    expect(await tree(context.root)).toEqual(before);
    const result = await recoverReviewedUpdateTransaction(context.root, { approvalStore: context.store });
    expect(result).toMatchObject({ status: 'committed', committed: true, cleanupFailures: [] });
    delete before[reviewedUpdateTransactionPathParts.join('/')];
    expect(await tree(context.root)).toEqual(before);
    expect(await readdir(context.store.directory)).toEqual([]);
  });

  it('uses the external committed seal even when the local commit marker was truncated', async () => {
    const context = await interrupted('committed');
    await unlink(context.lock);
    const journal = await readFile(context.journal, 'utf8');
    expect(journal).toContain(canonicalJson({ phase: 'committed' }));
    await writeFile(context.journal, journal.replace(canonicalJson({ phase: 'committed' }), ''));
    expect(await inspectReviewedUpdateTransaction(context.root, { approvalStore: context.store })).toMatchObject({ status: 'committed' });
    expect(await recoverReviewedUpdateTransaction(context.root, { approvalStore: context.store })).toMatchObject({ status: 'committed' });
    expect(await readFile(path.join(context.root, 'liftoff.manifest.json'), 'utf8')).toBe('v2 manifest\n');
  });

  it('preserves a concurrent edit during bounded recovery after a real interruption', async () => {
    const context = await interrupted('after-mutation', 3);
    await unlink(context.lock);
    await put(context.root, ['liftoff.manifest.json'], 'newer developer manifest');
    const result = await recoverReviewedUpdateTransaction(context.root, { approvalStore: context.store });
    expect(result).toMatchObject({ status: 'blocked', committed: false });
    expect(result.rollbackFailures).toContainEqual(expect.stringContaining('liftoff.manifest.json'));
    expect(await readFile(path.join(context.root, 'liftoff.manifest.json'), 'utf8')).toBe('newer developer manifest');
    expect(await readFile(path.join(context.root, ...context.source))).toEqual(raw);
  });
});

describe('untrusted recovery journals and no-write inspection', () => {
  it('inspection of an absent journal creates no files, directories, seals, or locks', async () => {
    const { root, parent, store } = await fixture();
    const before = await tree(parent);
    expect(await inspectReviewedUpdateTransaction(root, { approvalStore: store })).toMatchObject({ status: 'absent' });
    expect(await tree(parent)).toEqual(before);
    expect(store.write).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('never starts a new apply when a recovery journal exists', async () => {
    const context = await interrupted('prepared');
    await unlink(context.lock);
    const before = await tree(context.parent);
    await expect(applyReviewedUpdateTransaction(context.root, [{ type: 'write', pathParts: ['new-work'], content: 'blocked' }], {
      planFingerprint: fingerprint, approvalStore: context.store
    })).rejects.toThrow('existing recovery journal blocks new work');
    expect(await tree(context.parent)).toEqual(before);
  });

  it('blocks a fabricated journal with no external seal even when its snapshots and digest are valid', async () => {
    const context = await interrupted('after-mutation', 3);
    await unlink(context.lock);
    await rm(context.store.directory, { recursive: true });
    const before = await tree(context.parent);
    expect(await inspectReviewedUpdateTransaction(context.root, { approvalStore: context.store }))
      .toMatchObject({ status: 'blocked', reason: expect.stringContaining('missing or invalid user-local') });
    expect(await recoverReviewedUpdateTransaction(context.root, { approvalStore: context.store }))
      .toMatchObject({ status: 'blocked', rollbackFailures: [expect.stringContaining('missing or invalid user-local')] });
    expect(await tree(context.parent)).toEqual(before);
  });

  it('never uses a cleanup-only seal to restore target-matching files when transaction approval is missing', async () => {
    const context = await interrupted('after-mutation', 3);
    await unlink(context.lock);
    const header = JSON.parse((await readFile(context.journal, 'utf8')).split('\n')[0]);
    await context.store.remove(fingerprint, header.transactionDigest);
    const before = await tree(context.parent);
    expect(await recoverReviewedUpdateTransaction(context.root, { approvalStore: context.store }))
      .toMatchObject({ status: 'blocked', committed: false });
    expect(await tree(context.parent)).toEqual(before);
  });

  it('rejects a self-consistent forged mutation digest instead of treating project JSON as approval', async () => {
    const context = await interrupted('prepared');
    await unlink(context.lock);
    const header = JSON.parse((await readFile(context.journal, 'utf8')).split('\n')[0]);
    header.mutations[0].pathParts = ['liftoff.config.json'];
    const { transactionDigest: _digest, ...body } = header;
    header.transactionDigest = canonicalSha256(body);
    await writeFile(context.journal, canonicalJson(header));
    const before = await tree(context.parent);
    expect(await recoverReviewedUpdateTransaction(context.root, { approvalStore: context.store }))
      .toMatchObject({ status: 'blocked' });
    expect(await tree(context.parent)).toEqual(before);
  });

  it('binds the requested target mode and its effective filesystem mode into the external approval digest', async () => {
    const context = await interrupted('after-mutation', 0, 0o640);
    await unlink(context.lock);
    const lines = (await readFile(context.journal, 'utf8')).trimEnd().split('\n');
    const header = JSON.parse(lines[0]);
    const approvedDigest = header.transactionDigest;
    expect(header.mutations[0].mode).toBe(0o640);
    header.mutations[0].mode = 0o700;
    header.mutations[0].target.mode = process.platform === 'win32' ? 0o666 : 0o700;
    const { transactionDigest: _digest, ...body } = header;
    header.transactionDigest = canonicalSha256(body);
    expect(header.transactionDigest).not.toBe(approvedDigest);
    await writeFile(context.journal, canonicalJson(header) + lines.slice(1).map((line) => `${line}\n`).join(''));
    const before = await tree(context.parent);
    expect(await recoverReviewedUpdateTransaction(context.root, { approvalStore: context.store }))
      .toMatchObject({ status: 'blocked', rollbackFailures: [expect.stringContaining('missing or invalid user-local')] });
    expect(await tree(context.parent)).toEqual(before);
  });

  it.each([
    'bad-json', 'duplicate-json-key', 'raw-hash', 'path-escape', 'duplicate-path', 'fake-progress',
    'unknown-schema', 'unknown-field', 'invalid-mode', 'invalid-base64', 'wrong-root'
  ])(
    'blocks malformed or unsealed journal state: %s', async (fault) => {
      const context = await interrupted('prepared');
      await unlink(context.lock);
      const text = await readFile(context.journal, 'utf8');
      const header = JSON.parse(text.split('\n')[0]);
      let changed: string;
      if (fault === 'bad-json') changed = '{not-json}\n';
      else if (fault === 'duplicate-json-key') changed = text.replace('{"', '{"schemaVersion":1,"');
      else if (fault === 'fake-progress') changed = text + canonicalJson({ phase: 'mutation', index: 0 });
      else {
        if (fault === 'raw-hash') header.mutations[0].target.sha256 = createHash('sha256').update('wrong').digest('hex');
        if (fault === 'path-escape') header.mutations[0].pathParts = ['..', 'escape'];
        if (fault === 'duplicate-path') header.mutations[1].pathParts = header.mutations[0].pathParts;
        if (fault === 'unknown-schema') header.schemaVersion = 99;
        if (fault === 'unknown-field') header.approved = true;
        if (fault === 'invalid-mode') header.mutations[0].target.mode = -1;
        if (fault === 'invalid-base64') header.mutations[0].target.bytes = '!!!!';
        if (fault === 'wrong-root') header.projectRoot = context.parent;
        changed = canonicalJson(header);
      }
      await writeFile(context.journal, changed);
      const before = await tree(context.parent);
      expect(await inspectReviewedUpdateTransaction(context.root, { approvalStore: context.store })).toMatchObject({ status: 'blocked' });
      expect(await recoverReviewedUpdateTransaction(context.root, { approvalStore: context.store })).toMatchObject({ status: 'blocked' });
      expect(await tree(context.parent)).toEqual(before);
    }
  );

  it('accepts only an exact interrupted prefix of the next checkpoint, without inventing an attempted write', async () => {
    const context = await interrupted('prepared');
    await unlink(context.lock);
    await writeFile(context.journal, await readFile(context.journal, 'utf8') + canonicalJson({ phase: 'mutation', index: 0 }).slice(0, 15));
    const inspection = await inspectReviewedUpdateTransaction(context.root, { approvalStore: context.store });
    expect(inspection).toMatchObject({ status: 'interrupted' });
    expect(inspection.destinations.every((entry) => !entry.attempted)).toBe(true);
    expect(await recoverReviewedUpdateTransaction(context.root, { approvalStore: context.store })).toMatchObject({ status: 'rolled-back' });
  });

  it('blocks a symlinked journal without touching its destination', async () => {
    const { root, parent, store, journal } = await fixture();
    const outside = path.join(parent, 'outside.json');
    await writeFile(outside, 'outside');
    await mkdir(path.dirname(journal));
    if (process.platform === 'win32') return;
    await symlink(outside, journal);
    expect(await inspectReviewedUpdateTransaction(root, { approvalStore: store }))
      .toMatchObject({ status: 'blocked', reason: expect.stringContaining('symlink') });
    expect(await recoverReviewedUpdateTransaction(root, { approvalStore: store })).toMatchObject({ status: 'blocked' });
    expect(await readFile(outside, 'utf8')).toBe('outside');
    expect((await lstat(journal)).isSymbolicLink()).toBe(true);
  });

  it('honors a live cooperating lock before writing approvals or project metadata', async () => {
    const { root, store } = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = withProjectMutationLock(root, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    try {
      await expect(applyReviewedUpdateTransaction(root, [{ type: 'write', pathParts: ['one'], content: 'one' }], {
        planFingerprint: fingerprint, approvalStore: store
      })).rejects.toThrow('Another cooperating Liftoff mutation');
      expect(store.write).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
      expect(await inspectReviewedUpdateTransaction(root, { approvalStore: store })).toMatchObject({ status: 'absent' });
    } finally {
      release.resolve();
      await holder;
    }
  });
});
