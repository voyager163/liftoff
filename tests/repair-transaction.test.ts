import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  applyReviewedUpdateTransaction,
  inspectReviewedUpdateTransaction,
  recoverReviewedUpdateTransaction,
  reviewedRepairTransactionPathParts,
  reviewedUpdateTransactionPathParts
} from '../src/adapters/filesystem/reviewed-update-transaction.js';
import type {
  ReviewedTransactionKind,
  ReviewedUpdateApprovalStore,
  ReviewedUpdateTransactionCheckpoint
} from '../src/adapters/filesystem/reviewed-update-transaction.js';
import { captureProjectFileSnapshot } from '../src/adapters/filesystem/project-transaction.js';
import type { ProjectFileMutation } from '../src/adapters/filesystem/project-transaction.js';
import { projectMutationLockPath, withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { commandShellForPlatform, formatShellCommand } from '../src/adapters/process/shell-command.js';

const roots: string[] = [];
const fingerprint = 'b'.repeat(64);
const raw = Buffer.from([0xef, 0xbb, 0xbf, 0x0d, 0x0a, 0xff, 0x00]);
const originalManifest = '{"original":"provenance"}\r\n';
const repairedManifest = '{"current":"repaired","original":"provenance"}\n';
const source = ['infra', 'opentofu', 'main.tf'];
const target = ['infra', 'opentofu', 'modules', 'application', 'main.tf'];
const history = ['.liftoff', 'repair-history', fingerprint, 'main.tf'];
const historyManifest = ['.liftoff', 'repair-history', fingerprint, 'liftoff.manifest.json'];
const kinds = ['update', 'repair'] as const;
const partsFor = (kind: ReviewedTransactionKind) =>
  kind === 'repair' ? reviewedRepairTransactionPathParts : reviewedUpdateTransactionPathParts;

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

async function put(root: string, parts: readonly string[], content: string | Buffer) {
  const native = path.join(root, ...parts);
  await mkdir(path.dirname(native), { recursive: true });
  await writeFile(native, content, { mode: 0o600 });
}

async function tree(root: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  async function visit(parts: string[]) {
    for (const name of (await readdir(path.join(root, ...parts))).sort()) {
      const next = [...parts, name];
      const native = path.join(root, ...next);
      const details = await lstat(native);
      if (details.isDirectory()) {
        result[path.join(...next)] = 'directory';
        await visit(next);
      } else if (details.isFile()) {
        result[path.join(...next)] = { bytes: (await readFile(native)).toString('base64'), mode: details.mode & 0o7777 };
      }
    }
  }
  await visit([]);
  return result;
}

async function fixture() {
  const relative = `.repair-transaction-fixture-${randomUUID()}`;
  await mkdir(relative);
  roots.push(relative);
  const parent = path.resolve(relative);
  const root = path.join(parent, "project's directory with spaces");
  await mkdir(path.join(root, '.git'), { recursive: true });
  await put(root, source, raw);
  await put(root, ['liftoff.manifest.json'], originalManifest);
  await put(root, ['unrelated.txt'], 'developer bytes\r\n');
  const stores = {
    update: new FixtureApprovalStore(path.join(parent, 'update approvals')),
    repair: new FixtureApprovalStore(path.join(parent, 'repair approvals'))
  };
  const mutations: ProjectFileMutation[] = [
    { type: 'write', pathParts: history, content: raw },
    { type: 'write', pathParts: historyManifest, content: originalManifest },
    { type: 'delete', pathParts: source },
    { type: 'write', pathParts: target, content: raw },
    { type: 'write', pathParts: ['liftoff.manifest.json'], content: repairedManifest }
  ];
  return { parent, root, stores, mutations, before: await tree(root) };
}

async function interrupted(
  kind: ReviewedTransactionKind,
  phase: ReviewedUpdateTransactionCheckpoint['phase'],
  index?: number
) {
  const context = await fixture();
  const sourceRoot = new URL('../src/', import.meta.url).href;
  const moduleUrl = new URL('../src/adapters/filesystem/reviewed-update-transaction.ts', import.meta.url).href;
  const canonicalUrl = new URL('../src/domain/governance/activation/canonical-json.ts', import.meta.url).href;
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
          return { format: 'module', shortCircuit: true,
            source: transformSync(url, readFileSync(new URL(url), 'utf8'), { lang: 'ts' }).code };
        }
        return nextLoad(url, context);
      }
    });
    const { applyReviewedUpdateTransaction } = await import(${JSON.stringify(moduleUrl)});
    const { canonicalJson } = await import(${JSON.stringify(canonicalUrl)});
    const directory = ${JSON.stringify(context.stores[kind].directory)};
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
      transactionKind: ${JSON.stringify(kind)}, planFingerprint: ${JSON.stringify(fingerprint)}, approvalStore,
      onCheckpoint: async checkpoint => {
        if (checkpoint.phase === ${JSON.stringify(phase)} && checkpoint.index === ${JSON.stringify(index)}) process.exit(73);
      }
    });
    process.exitCode = 9;
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(73);
  const lock = await projectMutationLockPath(context.root);
  expect(JSON.parse(await readFile(lock, 'utf8')).pid).toBe(child.pid);
  return { ...context, lock, journal: path.join(context.root, ...partsFor(kind)) };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('registered reviewed repair transaction', () => {
  it('commits ordered raw history and exact provenance using only the repair journal', async () => {
    const { root, stores, mutations } = await fixture();
    const preconditions = await Promise.all(mutations.map((mutation) => captureProjectFileSnapshot(root, mutation.pathParts)));
    const result = await applyReviewedUpdateTransaction(root, mutations, {
      transactionKind: 'repair', planFingerprint: fingerprint, approvalStore: stores.repair, preconditions,
      onBeforeMutation: async (_mutation, index) => {
        if (index === 2) {
          expect(await readFile(path.join(root, ...history))).toEqual(raw);
          expect(await readFile(path.join(root, ...historyManifest), 'utf8')).toBe(originalManifest);
        }
      },
      onCheckpoint: async ({ phase }) => {
        if (phase === 'prepared') {
          const journal = JSON.parse((await readFile(path.join(root, ...reviewedRepairTransactionPathParts), 'utf8')).trimEnd());
          expect(journal.transactionKind).toBe('repair');
          const { transactionDigest, ...body } = journal;
          expect(transactionDigest).toBe(canonicalSha256(body));
          expect(canonicalSha256({ ...body, transactionKind: 'update' })).not.toBe(transactionDigest);
          expect(await inspectReviewedUpdateTransaction(root, { approvalStore: stores.update })).toMatchObject({ status: 'absent' });
        }
      }
    });
    expect(result).toMatchObject({ status: 'committed', committed: true, rollbackFailures: [], cleanupFailures: [] });
    expect(await readFile(path.join(root, ...target))).toEqual(raw);
    expect(await readFile(path.join(root, ...history))).toEqual(raw);
    expect(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')).toBe(repairedManifest);
    expect(await readFile(path.join(root, 'unrelated.txt'), 'utf8')).toBe('developer bytes\r\n');
    for (const parts of [source, reviewedUpdateTransactionPathParts, reviewedRepairTransactionPathParts]) {
      await expect(lstat(path.join(root, ...parts))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await readdir(stores.repair.directory)).toEqual([]);
    expect(stores.update.write).not.toHaveBeenCalled();
  });

  it('rolls back retirement and provenance bytes after an injected later failure', async () => {
    const { root, stores, mutations, before } = await fixture();
    await expect(applyReviewedUpdateTransaction(root, mutations, {
      transactionKind: 'repair', planFingerprint: fingerprint, approvalStore: stores.repair,
      onBeforeMutation: async (_mutation, index) => { if (index === 4) throw new Error('injected manifest failure'); }
    })).rejects.toThrow('All attributable changes were rolled back');
    expect(await tree(root)).toEqual(before);
    expect(await readdir(stores.repair.directory)).toEqual([]);
  });

  it('rejects stale exact preconditions before writing approvals or history', async () => {
    const { root, stores, mutations } = await fixture();
    const preconditions = [await captureProjectFileSnapshot(root, source)];
    await put(root, source, 'developer edit');
    const before = await tree(root);
    await expect(applyReviewedUpdateTransaction(root, mutations, {
      transactionKind: 'repair', planFingerprint: fingerprint, approvalStore: stores.repair, preconditions
    })).rejects.toThrow('target changed after review');
    expect(await tree(root)).toEqual(before);
    expect(stores.repair.write).not.toHaveBeenCalled();
  });

  it.each([
    ['prepared', undefined],
    ['before-mutation', 0],
    ['staged', 0],
    ['after-mutation', 2],
    ['after-mutation', 4],
    ['before-commit', undefined]
  ] as const)('recovers repair interrupted at %s/%s with no update authority', async (phase, index) => {
    const context = await interrupted('repair', phase, index);
    const options = { transactionKind: 'repair' as const, approvalStore: context.stores.repair };
    const pending = await tree(context.parent);
    expect(await inspectReviewedUpdateTransaction(context.root, options))
      .toMatchObject({ status: 'interrupted', committed: false, journalPath: context.journal });
    expect(await tree(context.parent)).toEqual(pending);
    await expect(recoverReviewedUpdateTransaction(context.root, options)).rejects.toThrow('Another cooperating Liftoff mutation');
    // Only the fixture's known exited child owns this lock; production never removes unowned locks.
    await unlink(context.lock);
    expect(await recoverReviewedUpdateTransaction(context.root, options))
      .toMatchObject({ status: 'rolled-back', committed: false, rollbackFailures: [], cleanupFailures: [] });
    expect(await tree(context.root)).toEqual(context.before);
    expect(await readdir(context.stores.repair.directory)).toEqual([]);
    expect(await recoverReviewedUpdateTransaction(context.root, options)).toMatchObject({ status: 'absent' });
    expect(context.stores.update.verify).not.toHaveBeenCalled();
  });

  it('does not roll back a sealed commit or overwrite subsequent edits during cleanup', async () => {
    const context = await interrupted('repair', 'committed');
    await unlink(context.lock);
    await put(context.root, ['liftoff.manifest.json'], 'subsequent governance progress');
    await put(context.root, ['.liftoff', 'unrelated.json'], 'not owned');
    const journal = await readFile(context.journal, 'utf8');
    await writeFile(context.journal, journal.replace(canonicalJson({ phase: 'committed' }), ''));
    const options = { transactionKind: 'repair' as const, approvalStore: context.stores.repair };
    const before = await tree(context.root);
    expect(await inspectReviewedUpdateTransaction(context.root, options)).toMatchObject({ status: 'committed' });
    expect(await recoverReviewedUpdateTransaction(context.root, options))
      .toMatchObject({ status: 'committed', committed: true, cleanupFailures: [] });
    delete before[path.join(...reviewedRepairTransactionPathParts)];
    expect(await tree(context.root)).toEqual(before);
    expect(await readFile(path.join(context.root, ...history))).toEqual(raw);
  });

  it('preserves concurrent destination edits and leaves recovery blocking new work', async () => {
    const context = await interrupted('repair', 'after-mutation', 4);
    await unlink(context.lock);
    await put(context.root, ['liftoff.manifest.json'], 'concurrent manifest');
    const options = { transactionKind: 'repair' as const, approvalStore: context.stores.repair };
    expect(await recoverReviewedUpdateTransaction(context.root, options)).toMatchObject({
      status: 'blocked', committed: false, rollbackFailures: [expect.stringContaining('liftoff.manifest.json')]
    });
    expect(await readFile(path.join(context.root, 'liftoff.manifest.json'), 'utf8')).toBe('concurrent manifest');
    expect(await readFile(path.join(context.root, ...source))).toEqual(raw);
    await expect(applyReviewedUpdateTransaction(context.root, context.mutations, {
      ...options, planFingerprint: fingerprint
    })).rejects.toThrow('existing recovery journal blocks new work');
    await put(context.root, ['liftoff.manifest.json'], originalManifest);
    expect(await recoverReviewedUpdateTransaction(context.root, options)).toMatchObject({ status: 'rolled-back' });
    expect(await tree(context.root)).toEqual(context.before);
  });
});

describe('update and repair isolation', () => {
  it.each([
    ['update', 'prepared'], ['update', 'committed'], ['repair', 'prepared'], ['repair', 'committed']
  ] as const)('blocks either new lane while a %s journal is %s, before validation or seals', async (pendingKind, phase) => {
    const context = await interrupted(pendingKind, phase);
    await unlink(context.lock);
    const before = await tree(context.parent);
    const command = formatShellCommand({
      executable: 'liftoff',
      args: pendingKind === 'repair' ? ['repair', context.root, '--recover'] : ['update', '--project', context.root]
    }, commandShellForPlatform(process.platform));
    for (const kind of kinds) {
      const validatePlan = vi.fn();
      await expect(applyReviewedUpdateTransaction(context.root, context.mutations, {
        transactionKind: kind, planFingerprint: fingerprint, approvalStore: context.stores[kind], validatePlan
      })).rejects.toThrow(command);
      expect(validatePlan).not.toHaveBeenCalled();
      expect(context.stores[kind].write).not.toHaveBeenCalled();
    }
    expect(await tree(context.parent)).toEqual(before);
  });

  it.each(kinds)('shares the mutation lock while %s validation is in progress, even before its journal exists', async (kind) => {
    const { root, stores, mutations, before } = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = applyReviewedUpdateTransaction(root, mutations, {
      transactionKind: kind, planFingerprint: fingerprint, approvalStore: stores[kind],
      validatePlan: async () => { entered.resolve(); await release.promise; }
    });
    await entered.promise;
    const otherKind = kind === 'repair' ? 'update' : 'repair';
    try {
      await expect(applyReviewedUpdateTransaction(root, mutations, {
        transactionKind: otherKind, planFingerprint: fingerprint, approvalStore: stores[otherKind]
      })).rejects.toThrow('Another cooperating Liftoff mutation');
      expect(stores[otherKind].write).not.toHaveBeenCalled();
      expect(await tree(root)).toEqual(before);
    } finally {
      release.resolve();
      expect(await holder).toMatchObject({ status: 'committed', cleanupFailures: [] });
    }
  });

  it.each(kinds)('blocks a reentrant opposite-lane apply after a %s journal is prepared', async (kind) => {
    const { root, stores, mutations } = await fixture();
    const otherKind = kind === 'repair' ? 'update' : 'repair';
    await withProjectMutationLock(root, async () => {
      expect(await applyReviewedUpdateTransaction(root, mutations, {
        transactionKind: kind, planFingerprint: fingerprint, approvalStore: stores[kind],
        onCheckpoint: async ({ phase }) => {
          if (phase === 'prepared') {
            await expect(applyReviewedUpdateTransaction(root, [{ type: 'write', pathParts: ['other'], content: 'blocked' }], {
              transactionKind: otherKind, planFingerprint: fingerprint, approvalStore: stores[otherKind]
            })).rejects.toThrow('existing recovery journal blocks new work');
          }
        }
      })).toMatchObject({ status: 'committed' });
    });
    expect(stores[otherKind].write).not.toHaveBeenCalled();
    await expect(lstat(path.join(root, 'other'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not let default update recovery or an update approval store recover a repair journal', async () => {
    const context = await interrupted('repair', 'after-mutation', 4);
    await unlink(context.lock);
    const before = await tree(context.parent);
    expect(await recoverReviewedUpdateTransaction(context.root, { approvalStore: context.stores.update }))
      .toMatchObject({ status: 'absent' });
    expect(await recoverReviewedUpdateTransaction(context.root, {
      transactionKind: 'repair', approvalStore: context.stores.update
    })).toMatchObject({ status: 'blocked', rollbackFailures: [expect.stringContaining('missing or invalid user-local')] });
    expect(await recoverReviewedUpdateTransaction(context.root, { transactionKind: 'repair' }))
      .toMatchObject({ status: 'blocked' });
    expect(await tree(context.parent)).toEqual(before);
    expect(context.stores.repair.verify).not.toHaveBeenCalled();
  });

  it.each(kinds)('rejects moving a sealed %s journal to the other registered path, even with its original store', async (kind) => {
    const context = await interrupted(kind, 'after-mutation', 4);
    await unlink(context.lock);
    const otherKind = kind === 'repair' ? 'update' : 'repair';
    await rename(context.journal, path.join(context.root, ...partsFor(otherKind)));
    const before = await tree(context.parent);
    const options = { transactionKind: otherKind, approvalStore: context.stores[kind] };
    expect(await inspectReviewedUpdateTransaction(context.root, options))
      .toMatchObject({ status: 'blocked', reason: expect.stringContaining('does not match its registered path') });
    expect(await recoverReviewedUpdateTransaction(context.root, options)).toMatchObject({ status: 'blocked' });
    expect(context.stores[kind].verify).not.toHaveBeenCalled();
    expect(await tree(context.parent)).toEqual(before);
  });

  it('rejects resealing a copied journal by changing its lane and recomputing the public digest', async () => {
    const context = await interrupted('repair', 'prepared');
    await unlink(context.lock);
    const header = JSON.parse((await readFile(context.journal, 'utf8')).trimEnd());
    const { transactionDigest: _digest, ...body } = header;
    body.transactionKind = 'update';
    await put(context.root, reviewedUpdateTransactionPathParts, canonicalJson({ ...body, transactionDigest: canonicalSha256(body) }));
    const before = await tree(context.parent);
    expect(await recoverReviewedUpdateTransaction(context.root, { approvalStore: context.stores.repair }))
      .toMatchObject({ status: 'blocked', rollbackFailures: [expect.stringContaining('missing or invalid user-local')] });
    expect(await tree(context.parent)).toEqual(before);
  });

  it('continues to recover previously sealed schema-1 update journals without a lane field', async () => {
    const context = await interrupted('update', 'prepared');
    await unlink(context.lock);
    const { transactionDigest: _digest, transactionKind: _kind, ...body } =
      JSON.parse((await readFile(context.journal, 'utf8')).trimEnd());
    const legacyDigest = canonicalSha256(body);
    await context.stores.update.write(fingerprint, legacyDigest);
    await writeFile(context.journal, canonicalJson({ ...body, transactionDigest: legacyDigest }));
    expect(await inspectReviewedUpdateTransaction(context.root, { approvalStore: context.stores.update }))
      .toMatchObject({ status: 'interrupted', transactionDigest: legacyDigest });
    await rename(context.journal, path.join(context.root, ...reviewedRepairTransactionPathParts));
    expect(await recoverReviewedUpdateTransaction(context.root, { transactionKind: 'repair', approvalStore: context.stores.update }))
      .toMatchObject({ status: 'blocked', rollbackFailures: [expect.stringContaining('does not match its registered path')] });
    await rename(path.join(context.root, ...reviewedRepairTransactionPathParts), context.journal);
    expect(await recoverReviewedUpdateTransaction(context.root, { approvalStore: context.stores.update }))
      .toMatchObject({ status: 'rolled-back', cleanupFailures: [] });
    expect(await tree(context.root)).toEqual(context.before);
  });

  it('keeps scoped repair previews, repair approvals, and governance approvals separate and immutable', async () => {
    const { parent, root } = await fixture();
    const home = path.join(parent, 'user home');
    await mkdir(home);
    const options = { homedir: home, env: {} };
    const preview = createScopedUserLocalRecordStore(root, 'repair-preview', options);
    const approval = createScopedUserLocalRecordStore(root, 'repair-approval', options);
    const governance = createScopedUserLocalRecordStore(root, 'governance-approval', options);
    const receipt = { schemaVersion: 1, fingerprint };
    const savedPreview = await preview.write(fingerprint, receipt);
    expect(await approval.read(fingerprint)).toBeNull();
    expect(await governance.read(fingerprint)).toBeNull();
    const savedApproval = await approval.write(fingerprint, receipt);
    expect(savedApproval.path).not.toBe(savedPreview.path);
    expect(path.relative(root, savedApproval.path).startsWith('..')).toBe(true);
    expect((await approval.read(fingerprint))?.value).toEqual(receipt);
    await expect(approval.write(fingerprint, { altered: true })).rejects.toThrow('Refusing to replace');
    expect(await governance.read(fingerprint)).toBeNull();
    expect((await preview.read(fingerprint))?.value).toEqual(receipt);
  });
});

describe('repair path confinement', () => {
  it.each(kinds)('reserves both journal paths and their case aliases from %s mutations', async (kind) => {
    const { root, stores, before } = await fixture();
    for (const parts of [
      ...kinds.map((lane) => [...partsFor(lane)]),
      ['.liftoff', 'REVIEWED-REPAIR-TRANSACTION.JSON'],
      ['.liftoff', 'reviewed-repair-transaction.json', 'nested'],
      ['..', 'outside'],
      ['C:', 'outside'],
      ['folder\\outside']
    ]) {
      await expect(applyReviewedUpdateTransaction(root, [
        { type: 'write', pathParts: ['first'], content: 'never written' },
        { type: 'write', pathParts: parts, content: 'never written' }
      ], { transactionKind: kind, planFingerprint: fingerprint, approvalStore: stores[kind] })).rejects.toThrow();
    }
    expect(await tree(root)).toEqual(before);
    expect(stores[kind].write).not.toHaveBeenCalled();
  });

  it('does not accept an arbitrary transaction kind as journal path authority', async () => {
    const { root, stores, mutations, before } = await fixture();
    const transactionKind = '../outside' as ReviewedTransactionKind;
    await expect(applyReviewedUpdateTransaction(root, mutations, {
      transactionKind, planFingerprint: fingerprint, approvalStore: stores.repair
    })).rejects.toThrow('unregistered transaction kind');
    await expect(inspectReviewedUpdateTransaction(root, { transactionKind })).rejects.toThrow('unregistered transaction kind');
    expect(await recoverReviewedUpdateTransaction(root, { transactionKind, approvalStore: stores.repair }))
      .toMatchObject({ status: 'blocked', rollbackFailures: [expect.stringContaining('unregistered transaction kind')] });
    expect(await tree(root)).toEqual(before);
    expect(stores.repair.write).not.toHaveBeenCalled();
  });

  it.each(kinds)('blocks a symlinked or junction journal parent in both lanes without following it (%s)', async (kind) => {
    const { parent, root, stores, mutations } = await fixture();
    const outside = path.join(parent, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'sentinel'), 'not project data');
    await symlink(outside, path.join(root, '.liftoff'), process.platform === 'win32' ? 'junction' : 'dir');
    const before = await tree(outside);
    await expect(applyReviewedUpdateTransaction(root, mutations, {
      transactionKind: kind, planFingerprint: fingerprint, approvalStore: stores[kind]
    })).rejects.toThrow('symlink or junction');
    expect(await inspectReviewedUpdateTransaction(root, { transactionKind: kind, approvalStore: stores[kind] }))
      .toMatchObject({ status: 'blocked', reason: expect.stringContaining('symlink or junction') });
    expect(await recoverReviewedUpdateTransaction(root, { transactionKind: kind, approvalStore: stores[kind] }))
      .toMatchObject({ status: 'blocked' });
    expect(await tree(outside)).toEqual(before);
    expect(stores[kind].write).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== 'win32')('blocks both lanes on a symlinked repair journal and preserves its target', async () => {
    const { parent, root, stores, mutations } = await fixture();
    const outside = path.join(parent, 'outside.json');
    await writeFile(outside, 'outside');
    await mkdir(path.join(root, '.liftoff'));
    const journal = path.join(root, ...reviewedRepairTransactionPathParts);
    await symlink(outside, journal);
    for (const kind of kinds) {
      await expect(applyReviewedUpdateTransaction(root, mutations, {
        transactionKind: kind, planFingerprint: fingerprint, approvalStore: stores[kind]
      })).rejects.toThrow('symlink or junction');
    }
    expect(await recoverReviewedUpdateTransaction(root, { transactionKind: 'repair', approvalStore: stores.repair }))
      .toMatchObject({ status: 'blocked' });
    expect((await lstat(journal)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, 'utf8')).toBe('outside');
  });

  it('refuses a linked repair destination before making the first safe write', async () => {
    const { parent, root, stores, mutations } = await fixture();
    const outside = path.join(parent, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(root, 'infra', 'opentofu', 'modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(applyReviewedUpdateTransaction(root, mutations, {
      transactionKind: 'repair', planFingerprint: fingerprint, approvalStore: stores.repair
    })).rejects.toThrow('symlink or junction');
    expect(await readdir(outside)).toEqual([]);
    expect(await readFile(path.join(root, ...source))).toEqual(raw);
    expect(stores.repair.write).not.toHaveBeenCalled();
  });

  it('preserves a destination parent replaced by a symlink or junction before recovery', async () => {
    const context = await interrupted('repair', 'after-mutation', 3);
    await unlink(context.lock);
    const destinationParent = path.dirname(path.join(context.root, ...target));
    const moved = path.join(context.parent, 'developer moved directory');
    const outside = path.join(context.parent, 'outside');
    await rename(destinationParent, moved);
    await mkdir(outside);
    await writeFile(path.join(outside, 'main.tf'), 'outside data');
    await symlink(outside, destinationParent, process.platform === 'win32' ? 'junction' : 'dir');
    const outsideBefore = await tree(outside);
    const movedBefore = await tree(moved);
    expect(await recoverReviewedUpdateTransaction(context.root, { transactionKind: 'repair', approvalStore: context.stores.repair }))
      .toMatchObject({ status: 'blocked', rollbackFailures: [expect.stringContaining('symlink or junction')] });
    expect(await tree(outside)).toEqual(outsideBefore);
    expect(await tree(moved)).toEqual(movedBefore);
    expect((await lstat(destinationParent)).isSymbolicLink()).toBe(true);
  });
});
