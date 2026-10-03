import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { repairExecutionIdentity } from '../src/domain/repair/identity.js';
import {
  applyLocalVerificationTransaction, inspectLocalVerificationCandidate, inspectLocalVerificationTransaction,
  recoverLocalVerificationTransaction, applyReviewedUpdateTransaction, inspectReviewedUpdateCandidate,
  inspectReviewedUpdateTransaction, recoverReviewedUpdateTransaction,
  reviewedUpdateTransactionPathParts, reviewedRepairTransactionPathParts, localVerificationTransactionPathParts,
  type LocalVerificationInputStage, type LocalVerificationTransactionOptions,
  type ReviewedTransactionKind, type ReviewedUpdateTransactionCheckpoint
} from '../src/adapters/filesystem/reviewed-update-transaction.js';
import type { LocalVerificationTransactionAuthorityStore } from '../src/application/update/transaction-approval.js';
import {
  captureJournalPreconditions, encodeReviewedJournalHeader, encodeReviewedJournalFrame,
  measureReviewedJournal, parseReviewedJournalHeader, reviewedJournalLimits, storeJournalSnapshot,
  type JournalBody, type JournalPayload, type StoredMutation
} from '../src/adapters/filesystem/reviewed-update-journal.js';
import type { ProjectFileMutation, ProjectFileSnapshot } from '../src/adapters/filesystem/project-transaction.js';
import { projectMutationLockPath } from '../src/adapters/filesystem/project-lock.js';
import {
  createLocalVerificationTransactionAuthorityStore, createUpdateTransactionApprovalStore
} from '../src/adapters/filesystem/update-previews.js';
import { repairApprovalStore } from '../src/application/repair/preview.js';
import type { ReviewedRecoveryExpectation } from '../src/adapters/filesystem/reviewed-update-transaction.js';

const faults = vi.hoisted(() => ({ denied: new Set<string>() }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (faults.denied.has(String(args[0]))) throw Object.assign(new Error('denied owned fixture read'), { code: 'EACCES' });
    return actual.open(...args);
  } };
});

const roots: string[] = [];
const fingerprint = 'a'.repeat(64);
const nonce = '12345678-1234-4234-8234-123456789abc';
const kinds = ['update', 'repair', 'local-verification'] as const;
const journalParts = (kind: ReviewedTransactionKind) => kind === 'update' ? reviewedUpdateTransactionPathParts :
  kind === 'repair' ? reviewedRepairTransactionPathParts : localVerificationTransactionPathParts;
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function tree(root: string): Promise<Record<string, { bytes: string; mode: number }>> {
  const entries: Record<string, { bytes: string; mode: number }> = {};
  async function visit(parts: string[]) {
    for (const item of await fs.readdir(path.join(root, ...parts), { withFileTypes: true })) {
      const next = [...parts, item.name], file = path.join(root, ...next), stat = await fs.lstat(file);
      if (stat.isDirectory()) await visit(next);
      else entries[next.join('/')] = { bytes: (await fs.readFile(file)).toString('base64'), mode: stat.mode & 0o7777 };
    }
  }
  await visit([]);
  return entries;
}
async function snapshot(root: string, pathParts: string[]): Promise<ProjectFileSnapshot> {
  const file = path.join(root, ...pathParts);
  return { pathParts, content: await fs.readFile(file), mode: (await fs.lstat(file)).mode & 0o7777 };
}
async function fixture() {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lv-transaction-')));
  roots.push(parent);
  const root = path.join(parent, 'project with spaces'), home = path.join(parent, 'home'), state = path.join(parent, 'state');
  await fs.mkdir(root); await fs.mkdir(home); await fs.mkdir(state);
  await fs.writeFile(path.join(root, 'source'), 'protected source\r\n', { mode: 0o640 });
  await fs.writeFile(path.join(root, 'control'), 'original control\r\n', { mode: 0o600 });
  const preconditions = [await snapshot(root, ['source']), await snapshot(root, ['control'])];
  const mutations: ProjectFileMutation[] = [
    { type: 'write', pathParts: ['records', 'proof.json'], content: 'actual fixture result\n' },
    { type: 'write', pathParts: ['control'], content: 'approved target control\n' }
  ];
  const options = { env: { XDG_STATE_HOME: state, LOCALAPPDATA: state }, homedir: home };
  const stores = {
    update: createUpdateTransactionApprovalStore(root, options),
    repair: repairApprovalStore(root, options),
    'local-verification': createLocalVerificationTransactionAuthorityStore(root, options)
  };
  const candidate = await inspectLocalVerificationCandidate(root, mutations, preconditions);
  const stages: LocalVerificationInputStage[] = [];
  const validateCurrentInputs = async (stage: LocalVerificationInputStage) => {
    stages.push(stage);
    expect(await fs.readFile(await projectMutationLockPath(root), 'utf8')).toContain('"pid"');
    expect(await fs.readFile(path.join(root, 'source'), 'utf8')).toBe('protected source\r\n');
    expect(await fs.readFile(path.join(root, 'control'), 'utf8')).toBe(
      stage === 'before-commit' ? 'approved target control\n' : 'original control\r\n');
  };
  const applyOptions: LocalVerificationTransactionOptions = {
    planFingerprint: fingerprint, authorityStore: stores['local-verification'], preconditions,
    expectedCandidateBinding: candidate.binding, validateCurrentInputs
  };
  return { parent, root, options, preconditions, mutations, stores, candidate, stages, applyOptions };
}
function localPayload(mutations: StoredMutation[] = [{
  type: 'write', pathParts: ['proof'], original: { kind: 'missing' },
  target: storeJournalSnapshot({ pathParts: ['proof'], content: Buffer.from('result'), mode: 0o600 })
}]): JournalPayload {
  return { schemaVersion: 3, transactionKind: 'local-verification', projectRoot: '/project', mutations, missingDirectories: [] };
}
const body = (payload: JournalPayload): JournalBody => ({ ...payload, planFingerprint: fingerprint, nonce });

async function interrupted(kind: ReviewedTransactionKind, phase: ReviewedUpdateTransactionCheckpoint['phase'], index?: number) {
  const f = await fixture(), before = await tree(f.root);
  const moduleUrl = new URL('../src/adapters/filesystem/reviewed-update-transaction.ts', import.meta.url).href;
  const sourceRoot = new URL('../src/', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { registerHooks } from 'node:module';
    import { readFileSync } from 'node:fs';
    import { transformSync } from 'rolldown/utils';
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (context.parentURL?.startsWith(${JSON.stringify(sourceRoot)}) && specifier.endsWith('.js'))
          return nextResolve(new URL(specifier.slice(0, -3) + '.ts', context.parentURL).href, context);
        return nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        if (url.startsWith(${JSON.stringify(sourceRoot)}) && url.endsWith('.ts'))
          return { format: 'module', shortCircuit: true, source: transformSync(url, readFileSync(new URL(url), 'utf8'), { lang: 'ts' }).code };
        return nextLoad(url, context);
      }
    });
    const tx = await import(${JSON.stringify(moduleUrl)});
    const storage = await import(${JSON.stringify(new URL('../src/adapters/filesystem/update-previews.ts', import.meta.url).href)});
    const { repairApprovalStore } = await import(${JSON.stringify(new URL('../src/application/repair/preview.ts', import.meta.url).href)});
    const { repairExecutionIdentity } = await import(${JSON.stringify(new URL('../src/domain/repair/identity.ts', import.meta.url).href)});
    const root = ${JSON.stringify(f.root)}, options = ${JSON.stringify(f.options)}, kind = ${JSON.stringify(kind)};
    const mutations = ${JSON.stringify(f.mutations)};
    const preconditions = ${JSON.stringify(f.preconditions.map(item => ({ ...item, content: item.content!.toString('base64') })))}
      .map(item => ({ ...item, content: Buffer.from(item.content, 'base64') }));
    const checkpoint = async value => {
      if (value.phase === ${JSON.stringify(phase)} && value.index === ${JSON.stringify(index)}) process.exit(73);
    };
    if (kind === 'local-verification') {
      const authorityStore = storage.createLocalVerificationTransactionAuthorityStore(root, options);
      const candidate = await tx.inspectLocalVerificationCandidate(root, mutations, preconditions);
      await tx.applyLocalVerificationTransaction(root, mutations, {
        planFingerprint: ${JSON.stringify(fingerprint)}, authorityStore, preconditions, expectedCandidateBinding: candidate.binding,
        validateCurrentInputs: async () => {
          if (readFileSync(root + '/source', 'utf8') !== 'protected source\\r\\n') throw new Error('changed protected source');
        }, onCheckpoint: checkpoint
      });
    } else {
      await tx.applyReviewedUpdateTransaction(root, mutations, {
        transactionKind: kind, ...(kind === 'repair' ? { repairIdentity: repairExecutionIdentity('0.12.3', 'azure-local-layout') } : {}),
        planFingerprint: ${JSON.stringify(fingerprint)}, preconditions,
        approvalStore: kind === 'repair' ? repairApprovalStore(root, options) : storage.createUpdateTransactionApprovalStore(root, options),
        onCheckpoint: checkpoint
      });
    }
    process.exitCode = 9;
  `], { encoding: 'utf8', timeout: 30_000, cwd: process.cwd(), env: process.env });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(73);
  const lock = await projectMutationLockPath(f.root), lockContent = await fs.readFile(lock, 'utf8'), identity = await fs.lstat(lock);
  expect(JSON.parse(lockContent).pid).toBe(child.pid);
  return { ...f, before, lock, lockContent, identity, pid: child.pid, journal: path.join(f.root, ...journalParts(kind)) };
}

async function releaseExitedFixtureLock(f: Awaited<ReturnType<typeof interrupted>>) {
  const current = await fs.lstat(f.lock);
  expect(current.isFile() && !current.isSymbolicLink()).toBe(true);
  expect([current.dev, current.ino]).toEqual([f.identity.dev, f.identity.ino]);
  expect(await fs.readFile(f.lock, 'utf8')).toBe(f.lockContent);
  expect(JSON.parse(f.lockContent).pid).toBe(f.pid);
  await fs.unlink(f.lock);
  console.info(JSON.stringify({ kind: 'test-only-exited-child-lock-cleanup', path: f.lock, pid: f.pid,
    dev: current.dev, ino: current.ino, contentSha256: digest(f.lockContent), exitStatus: 73,
    observedAtUtc: new Date().toISOString(), productionAutomaticallyReaps: false }));
}

afterEach(async () => {
  faults.denied.clear();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true });
});

describe('dedicated local-verification wire and exact admission', () => {
  it('measures actual schema3/header/frames and rejects cross-kind recovery', () => {
    const payload = localPayload(), encoded = encodeReviewedJournalHeader(body(payload), process.platform);
    const measured = measureReviewedJournal(payload, [], process.platform);
    expect(encoded.header).toMatchObject({ schemaVersion: 3, transactionKind: 'local-verification' });
    expect(measured.completeJournalBytes).toBe(encoded.content.length +
      encodeReviewedJournalFrame({ phase: 'mutation', index: 0 }).length + encodeReviewedJournalFrame({ phase: 'committed' }).length);
    expect(parseReviewedJournalHeader(encoded.header, '/project', 'local-verification', process.platform)).toEqual(encoded.header);
    for (const kind of ['update', 'repair'] as const)
      expect(() => parseReviewedJournalHeader(encoded.header, '/project', kind, process.platform)).toThrow(/kind/);
  });

  it.each([
    { schemaVersion: 1 }, { schemaVersion: 2 }, { schemaVersion: 4 }, { transactionKind: 'update' },
    { transactionKind: 'repair' }, { transactionKind: undefined }, { transactionKind: 'unknown' },
    { repairIdentity: repairExecutionIdentity('0.12.3', 'azure-local-layout') }, { extra: true }
  ])('rejects incompatible local envelopes %j', patch => {
    expect(() => encodeReviewedJournalHeader({ ...body(localPayload()), ...patch } as JournalBody, process.platform)).toThrow();
  });

  it.each(kinds)('reserves all three journal paths against %s mutations and conditions', kind => {
    const payload = localPayload();
    payload.transactionKind = kind;
    payload.schemaVersion = kind === 'local-verification' ? 3 : 1;
    for (const reserved of kinds) {
      payload.mutations[0].pathParts = [...journalParts(reserved)];
      expect(() => measureReviewedJournal(payload, [], process.platform)).toThrow(/overlap|duplicate/);
      payload.mutations[0].pathParts = ['proof'];
      expect(() => measureReviewedJournal(payload, captureJournalPreconditions([{ pathParts: [...journalParts(reserved)] }]), process.platform))
        .toThrow(/overlap|duplicate/);
    }
  });

  it('keeps exact/+1 local file, combined snapshot and mutation/precondition limits', () => {
    const maximum = reviewedJournalLimits.fileBytes;
    const snap = storeJournalSnapshot({ pathParts: ['proof'], content: Buffer.alloc(maximum), mode: 0o600 });
    expect(() => storeJournalSnapshot({ pathParts: ['proof'], content: Buffer.alloc(maximum + 1), mode: 0o600 })).toThrow(/oversized/);
    const payload = localPayload([{ type: 'write', pathParts: ['proof'], original: snap, target: snap }]);
    expect(measureReviewedJournal(payload, [], process.platform).snapshotBytes).toBe(16 * 1024 * 1024);
    payload.mutations.push(localPayload().mutations[0]);
    payload.mutations[1].pathParts = ['extra'];
    payload.mutations[1].target = storeJournalSnapshot({ pathParts: ['extra'], content: Buffer.from('x'), mode: 0o600 });
    expect(() => measureReviewedJournal(payload, [], process.platform)).toThrow(/snapshots/);
    const count = localPayload(Array.from({ length: 1024 }, (_, index) => ({
      type: 'delete', pathParts: [`file-${index}`], original: { kind: 'missing' }, target: { kind: 'missing' }
    })));
    expect(measureReviewedJournal(count, [], process.platform).mutationCount).toBe(1024);
    count.mutations.push({ ...count.mutations[0], pathParts: ['overflow'] });
    expect(() => measureReviewedJournal(count, [], process.platform)).toThrow(/oversized/);
    const conditions = Array.from({ length: 4096 }, (_, index) => ({ pathParts: [`condition-${index}`] }));
    expect(measureReviewedJournal(localPayload(), captureJournalPreconditions(conditions), process.platform).suppliedPreconditionCount).toBe(4096);
    expect(() => captureJournalPreconditions([...conditions, { pathParts: ['overflow'] }])).toThrow(/preconditions/);
  });

  it('enforces exactly 32MiB including the real local envelope, not just snapshots', () => {
    const payload = localPayload();
    const initial = measureReviewedJournal(payload, [], process.platform).completeJournalBytes;
    payload.projectRoot += 'x'.repeat(reviewedJournalLimits.journalBytes - initial);
    expect(measureReviewedJournal(payload, [], process.platform).completeJournalBytes).toBe(reviewedJournalLimits.journalBytes);
    expect(encodeReviewedJournalHeader(body(payload), process.platform).content.length +
      encodeReviewedJournalFrame({ phase: 'mutation', index: 0 }).length + encodeReviewedJournalFrame({ phase: 'committed' }).length)
      .toBe(reviewedJournalLimits.journalBytes);
    payload.projectRoot += 'x';
    expect(() => measureReviewedJournal(payload, [], process.platform)).toThrow(/complete forward/);
  });
});

describe('locked exact local publication', () => {
  it('admits a distinct candidate and compares approved target controls before commit', async () => {
    const f = await fixture(), before = await tree(f.root);
    const ordinary = await inspectReviewedUpdateCandidate(f.root, f.mutations, f.preconditions);
    expect(ordinary.binding).not.toBe(f.candidate.binding);
    expect(await tree(f.root)).toEqual(before);
    const result = await applyLocalVerificationTransaction(f.root, f.mutations, f.applyOptions);
    expect(result).toMatchObject({ status: 'committed', committed: true, cleanupFailures: [] });
    expect(f.stages).toEqual(['before-admission', 'before-publication', 'before-commit']);
    expect(await fs.readFile(path.join(f.root, 'source'))).toEqual(f.preconditions[0].content);
    expect(await inspectLocalVerificationTransaction(f.root, { authorityStore: f.stores['local-verification'] })).toMatchObject({ status: 'absent' });
    expect(await recoverLocalVerificationTransaction(f.root, { authorityStore: f.stores['local-verification'] })).toMatchObject({ status: 'absent' });
  });

  it.each(['preconditions', 'expectedCandidateBinding', 'validateCurrentInputs', 'authorityStore'] as const)(
    'requires %s even from an untyped caller before any effects', async field => {
      const f = await fixture(), before = await tree(f.parent);
      const options = { ...f.applyOptions };
      Reflect.deleteProperty(options, field);
      await expect(applyLocalVerificationTransaction(f.root, f.mutations, options)).rejects.toThrow();
      expect(await tree(f.parent)).toEqual(before);
    });

  it('cannot bypass local checks via the generic legacy apply entrypoint', async () => {
    const f = await fixture();
    await expect(applyReviewedUpdateTransaction(f.root, f.mutations, {
      transactionKind: 'local-verification', planFingerprint: fingerprint, approvalStore: f.stores['local-verification']
    })).rejects.toThrow(/dedicated/);
  });

  it('cannot change a generic operation into local-verification between option reads', async () => {
    const f = await fixture(), before = await tree(f.parent);
    let reads = 0;
    await expect(applyReviewedUpdateTransaction(f.root, f.mutations, {
      get transactionKind() { return ++reads === 1 ? 'update' : 'local-verification'; },
      planFingerprint: fingerprint, approvalStore: f.stores['local-verification']
    })).rejects.toThrow(/dedicated|current-input|accessor/);
    expect(await tree(f.parent)).toEqual(before);
  });

  it.each(['before-admission', 'before-publication', 'before-commit'] as const)('fails %s without falsely committing', async stage => {
    const f = await fixture(), before = await tree(f.root);
    await expect(applyLocalVerificationTransaction(f.root, f.mutations, {
      ...f.applyOptions, validateCurrentInputs: async current => {
        if (current === stage) throw new Error(`changed baseline at ${stage}`);
        await f.applyOptions.validateCurrentInputs(current);
      }
    })).rejects.toThrow(/changed baseline/);
    expect(await tree(f.root)).toEqual(before);
  });

  it('captures mutation, precondition, callback and candidate binding before its first await', async () => {
    const f = await fixture();
    const original = await tree(f.root), options = { ...f.applyOptions };
    const pending = applyLocalVerificationTransaction(f.root, f.mutations, options);
    if (f.mutations[0].type === 'write') f.mutations[0].content = 'unapproved replacement';
    f.preconditions[0].content!.fill(0);
    options.expectedCandidateBinding = 'b'.repeat(64);
    options.validateCurrentInputs = async () => { throw new Error('late callback'); };
    expect((await pending).committed).toBe(true);
    expect(await fs.readFile(path.join(f.root, 'records', 'proof.json'), 'utf8')).toBe('actual fixture result\n');
    expect((await tree(f.root)).source).toEqual(original.source);
    expect(f.stages).toHaveLength(3);
  });

  it.each(['body', 'mode', 'parent', 'candidate'] as const)('rejects changed %s before the first seal', async fault => {
    const f = await fixture(), write = vi.spyOn(f.stores['local-verification'], 'write');
    if (fault === 'body') await fs.appendFile(path.join(f.root, 'source'), 'changed');
    if (fault === 'mode') await fs.chmod(path.join(f.root, 'source'), 0o444);
    if (fault === 'parent') await fs.mkdir(path.join(f.root, 'records'));
    if (fault === 'candidate') f.applyOptions.expectedCandidateBinding = 'b'.repeat(64);
    await expect(applyLocalVerificationTransaction(f.root, f.mutations, {
      ...f.applyOptions, validateCurrentInputs: async () => {}
    })).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
    await expect(fs.lstat(path.join(f.root, ...localVerificationTransactionPathParts))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['before-publication', 'before-commit'] as const)('detects a new protected closure member at %s without deleting it', async stage => {
    const f = await fixture(), added = path.join(f.root, 'new-source');
    const original = f.stores['local-verification'].write;
    let first = true;
    const store: LocalVerificationTransactionAuthorityStore = { ...f.stores['local-verification'], write: async (plan, value) => {
      await original(plan, value);
      if (first && stage === 'before-publication') { first = false; await fs.writeFile(added, 'concurrent'); }
    } };
    await expect(applyLocalVerificationTransaction(f.root, f.mutations, {
      ...f.applyOptions, authorityStore: store,
      onCheckpoint: async value => { if (stage === 'before-commit' && value.phase === 'before-commit') await fs.writeFile(added, 'concurrent'); },
      validateCurrentInputs: async current => {
        await f.applyOptions.validateCurrentInputs(current);
        if ((await fs.readdir(f.root)).includes('new-source')) throw new Error('protected closure changed');
      }
    })).rejects.toThrow(/protected closure/);
    expect(await fs.readFile(added, 'utf8')).toBe('concurrent');
    expect(await fs.readFile(path.join(f.root, 'control'), 'utf8')).toBe('original control\r\n');
    await expect(fs.lstat(path.join(f.root, 'records', 'proof.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects denied original/destination reads without a seal or new target', async () => {
    const f = await fixture(), write = vi.spyOn(f.stores['local-verification'], 'write');
    faults.denied.add(path.join(f.root, 'control'));
    await expect(inspectLocalVerificationCandidate(f.root, f.mutations, f.preconditions)).rejects.toThrow(/denied/);
    await expect(applyLocalVerificationTransaction(f.root, f.mutations, {
      ...f.applyOptions, validateCurrentInputs: async () => {}
    })).rejects.toThrow(/denied/);
    expect(write).not.toHaveBeenCalled();
  });

  it('does not turn an empty admitted candidate into a publication or issue authority', async () => {
    const f = await fixture(), before = await tree(f.parent);
    const candidate = await inspectLocalVerificationCandidate(f.root, [], f.preconditions);
    const write = vi.spyOn(f.stores['local-verification'], 'write');
    expect(candidate.size.kind).toBe('no-journal');
    expect(await applyLocalVerificationTransaction(f.root, [], {
      ...f.applyOptions, expectedCandidateBinding: candidate.binding
    })).toMatchObject({ status: 'absent', committed: false });
    expect(f.stages).toEqual(['before-admission']);
    expect(write).not.toHaveBeenCalled();
    expect(await tree(f.parent)).toEqual(before);
  });

  it('rejects a replaced publication lock and preserves that unrelated replacement', async () => {
    const f = await fixture(), lock = await projectMutationLockPath(f.root);
    await expect(applyLocalVerificationTransaction(f.root, f.mutations, {
      ...f.applyOptions, validateCurrentInputs: async stage => {
        if (stage === 'before-admission') await fs.writeFile(lock, 'replacement lock');
      }
    })).rejects.toThrow(/lock/i);
    expect(await fs.readFile(lock, 'utf8')).toBe('replacement lock');
    expect(await fs.readFile(path.join(f.root, 'control'), 'utf8')).toBe('original control\r\n');
  });
});

describe('real local-verification process interruption and recovery', () => {
  it.each([
    ['prepared', undefined], ['before-mutation', 0], ['staged', 0], ['after-mutation', 0],
    ['after-mutation', 1], ['before-commit', undefined], ['committed', undefined]
  ] as const)('recovers a real exited child at %s/%s with persistent dedicated seals', async (phase, index) => {
    const f = await interrupted('local-verification', phase, index);
    await expect(recoverLocalVerificationTransaction(f.root, { authorityStore: f.stores['local-verification'] }))
      .rejects.toThrow(/mutation.*progress|stale lock|Lock:/i);
    await releaseExitedFixtureLock(f);
    const inspected = await inspectLocalVerificationTransaction(f.root, { authorityStore: f.stores['local-verification'] });
    expect(inspected).toMatchObject({ status: phase === 'committed' ? 'committed' : 'interrupted', schemaVersion: 3 });
    const result = await recoverLocalVerificationTransaction(f.root, { authorityStore: f.stores['local-verification'] });
    expect(result).toMatchObject({ status: phase === 'committed' ? 'committed' : 'rolled-back', rollbackFailures: [], cleanupFailures: [] });
    if (phase !== 'committed') expect(await tree(f.root)).toEqual(f.before);
    else expect(await fs.readFile(path.join(f.root, 'control'), 'utf8')).toBe('approved target control\n');
    const after = await tree(f.root);
    expect((await recoverLocalVerificationTransaction(f.root, { authorityStore: f.stores['local-verification'] })).status).toBe('absent');
    expect(await tree(f.root)).toEqual(after);
  });

  it('preserves concurrent destination edits after interruption and leaves its journal', async () => {
    const f = await interrupted('local-verification', 'after-mutation', 1);
    await releaseExitedFixtureLock(f);
    await fs.writeFile(path.join(f.root, 'control'), 'developer edit');
    const result = await recoverLocalVerificationTransaction(f.root, { authorityStore: f.stores['local-verification'] });
    expect(result.status).toBe('blocked');
    expect(result.rollbackFailures.join()).toContain('control');
    expect(await fs.readFile(path.join(f.root, 'control'), 'utf8')).toBe('developer edit');
    expect(await fs.readFile(f.journal, 'utf8')).toContain('local-verification');
  });

  it('accepts only the exact next torn frame and ignores an unattempted destination', async () => {
    const f = await interrupted('local-verification', 'prepared');
    await releaseExitedFixtureLock(f);
    await fs.appendFile(f.journal, canonicalJson({ phase: 'mutation', index: 0 }).slice(0, 12));
    expect((await recoverLocalVerificationTransaction(f.root, { authorityStore: f.stores['local-verification'] })).status).toBe('rolled-back');
    expect(await tree(f.root)).toEqual(f.before);
  });

  it.each(['missing-authority', 'wrong-authority', 'denied', 'changed-journal', 'changed-temporary'] as const)(
    'blocks %s without broad recovery authority', async fault => {
      const f = await interrupted('local-verification', 'staged', 0);
      await releaseExitedFixtureLock(f);
      const header = JSON.parse((await fs.readFile(f.journal, 'utf8')).split('\n')[0]);
      if (fault === 'missing-authority') {
        await f.stores['local-verification'].remove(fingerprint, header.transactionDigest);
        await f.stores['local-verification'].remove(fingerprint, canonicalSha256({
          schemaVersion: 1, transactionDigest: header.transactionDigest, phase: 'rollback-cleanup-only'
        }));
      }
      if (fault === 'denied') faults.denied.add(f.journal);
      if (fault === 'changed-journal') await fs.appendFile(f.journal, 'invalid');
      if (fault === 'changed-temporary') await fs.writeFile(path.join(f.root, 'records',
        `.liftoff-reviewed-${header.transactionDigest}-0-target.tmp`), 'unrelated temporary');
      const before = fault === 'denied' ? undefined : await tree(f.root);
      const result = await Reflect.apply(recoverLocalVerificationTransaction, undefined, [f.root, {
        authorityStore: fault === 'wrong-authority' ? f.stores.update : f.stores['local-verification']
      }]);
      expect(result.status).toBe('blocked');
      if (before) expect(await tree(f.root)).toEqual(before);
    });

  it.each([true, false])('distinguishes commit seal persistence from acknowledgement (persisted=%s)', async persisted => {
    const f = await fixture(), original = f.stores['local-verification'];
    let atCommit = false;
    const store: LocalVerificationTransactionAuthorityStore = { ...original, write: async (plan, value) => {
      if (atCommit) {
        atCommit = false;
        if (persisted) await original.write(plan, value);
        throw new Error('commit seal failure');
      }
      await original.write(plan, value);
    } };
    const pending = applyLocalVerificationTransaction(f.root, f.mutations, {
      ...f.applyOptions, authorityStore: store,
      onCheckpoint: async value => { if (value.phase === 'before-commit') atCommit = true; }
    });
    if (persisted) expect(await pending).toMatchObject({ committed: true, status: 'committed' });
    else await expect(pending).rejects.toThrow(/commit seal failure/);
    expect(await fs.readFile(path.join(f.root, 'control'), 'utf8'))
      .toBe(persisted ? 'approved target control\n' : 'original control\r\n');
  });

  it('retains committed output on cleanup failure and after protected source changes', async () => {
    const f = await fixture();
    let failCleanup = true;
    const store: LocalVerificationTransactionAuthorityStore = { ...f.stores['local-verification'], remove: async (plan, value) => {
      if (failCleanup) throw new Error('denied authority cleanup');
      await f.stores['local-verification'].remove(plan, value);
    } };
    const result = await applyLocalVerificationTransaction(f.root, f.mutations, { ...f.applyOptions, authorityStore: store });
    expect(result.committed).toBe(true);
    expect(result.cleanupFailures.join()).toContain('denied authority cleanup');
    failCleanup = false;
    await fs.writeFile(path.join(f.root, 'source'), 'later source');
    await recoverLocalVerificationTransaction(f.root, { authorityStore: store });
    expect(await fs.readFile(path.join(f.root, 'control'), 'utf8')).toBe('approved target control\n');
    expect(await fs.readFile(path.join(f.root, 'source'), 'utf8')).toBe('later source');
  });

  it('retains a postcommit journal and never rechecks the obsolete original baseline during recovery', async () => {
    const f = await fixture();
    const result = await applyLocalVerificationTransaction(f.root, f.mutations, {
      ...f.applyOptions, onCheckpoint: async value => { if (value.phase === 'committed') throw new Error('postcommit failure'); }
    });
    expect(result.committed).toBe(true);
    expect(result.cleanupFailures.join()).toContain('postcommit failure');
    await fs.writeFile(path.join(f.root, 'source'), 'newer baseline');
    expect((await recoverLocalVerificationTransaction(f.root, { authorityStore: f.stores['local-verification'] })).committed).toBe(true);
    expect(await fs.readFile(path.join(f.root, 'control'), 'utf8')).toBe('approved target control\n');
    expect(await fs.readFile(path.join(f.root, 'source'), 'utf8')).toBe('newer baseline');
    expect(f.stages).toHaveLength(3);
  });
});

describe('three-kind exclusion', () => {
  it.each(kinds.flatMap(kind => (['prepared', 'committed'] as const).map(phase => ({ kind, phase }))))(
    'blocks every new kind for pending $kind/$phase before callbacks/seals', async ({ kind, phase }) => {
      const f = await interrupted(kind, phase);
      await releaseExitedFixtureLock(f);
      const before = await tree(f.parent);
      for (const incoming of kinds) {
        const checked = vi.fn(async () => {}), store = f.stores[incoming], write = vi.spyOn(store, 'write');
        const result = incoming === 'local-verification'
          ? applyLocalVerificationTransaction(f.root, f.mutations, { ...f.applyOptions, validateCurrentInputs: checked })
          : applyReviewedUpdateTransaction(f.root, f.mutations, {
            transactionKind: incoming, ...(incoming === 'repair' ? { repairIdentity: repairExecutionIdentity('0.12.3', 'azure-local-layout') } : {}),
            planFingerprint: fingerprint, approvalStore: store, validatePlan: checked
          });

        await expect(result).rejects.toThrow(/blocks new work/);
        expect(checked).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
      }
      expect(await tree(f.parent)).toEqual(before);
    });

  it('holds the shared mutation lock during local current-input checks, before its journal exists', async () => {
    const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const pending = applyLocalVerificationTransaction(f.root, f.mutations, {
      ...f.applyOptions, validateCurrentInputs: async stage => {
        if (stage === 'before-admission') { entered.resolve(); await release.promise; }
        await f.applyOptions.validateCurrentInputs(stage);
      }
    });
    await entered.promise;
    try {
      for (const kind of kinds) {
        const attempt = kind === 'local-verification' ? applyLocalVerificationTransaction(f.root, f.mutations, f.applyOptions) :
          applyReviewedUpdateTransaction(f.root, f.mutations, {
            transactionKind: kind, ...(kind === 'repair' ? { repairIdentity: repairExecutionIdentity('0.12.3', 'azure-local-layout') } : {}),
            planFingerprint: fingerprint, approvalStore: f.stores[kind]
          });
        await expect(attempt).rejects.toThrow(/cooperating Liftoff mutation/);
      }
    } finally { release.resolve(); }
    expect((await pending).committed).toBe(true);
  });
});

describe('actual production authority attribution', () => {
  async function foreignStore(f: Awaited<ReturnType<typeof fixture>>, kind: 'update' | 'repair' | 'other-root') {
    if (kind !== 'other-root') return f.stores[kind];
    const otherRoot = path.join(f.parent, 'other-project');
    await fs.mkdir(otherRoot);
    return createLocalVerificationTransactionAuthorityStore(otherRoot, f.options);
  }

  it.each(['transactionKind', 'projectRoot'] as const)('rejects accessor %s attribution without invoking it', async field => {
    const f = await fixture(), before = await tree(f.parent), authorityStore = { ...f.stores['local-verification'] };
    const getter = vi.fn(() => field === 'transactionKind' ? 'local-verification' : f.root);
    Object.defineProperty(authorityStore, field, { enumerable: true, get: getter });
    const validateCurrentInputs = vi.fn(async () => {});
    await expect(applyLocalVerificationTransaction(f.root, f.mutations, {
      ...f.applyOptions, authorityStore, validateCurrentInputs
    })).rejects.toThrow(/authority|data/);
    expect(getter).not.toHaveBeenCalled();
    expect(validateCurrentInputs).not.toHaveBeenCalled();
    expect(await tree(f.parent)).toEqual(before);
  });

  it('captures a deliberate fault-adapter attribution and methods before awaiting apply', async () => {
    const f = await fixture(), authorityStore = { ...f.stores['local-verification'] };
    const pending = applyLocalVerificationTransaction(f.root, f.mutations, { ...f.applyOptions, authorityStore });
    Reflect.set(authorityStore, 'transactionKind', 'update');
    authorityStore.projectRoot = path.join(f.parent, 'other-root');
    authorityStore.write = async () => { throw new Error('late substituted writer'); };
    authorityStore.verify = async () => false;
    authorityStore.remove = async () => { throw new Error('late substituted remover'); };
    expect((await pending).committed).toBe(true);
    expect(f.stages).toHaveLength(3);
  });

  it('captures generic local inspection/recovery kind, root and methods before awaits', async () => {
    const f = await interrupted('local-verification', 'committed');
    await releaseExitedFixtureLock(f);
    const store = { ...f.stores['local-verification'] };
    const options = { transactionKind: 'local-verification' as ReviewedTransactionKind, approvalStore: store };
    const inspection = inspectReviewedUpdateTransaction(f.root, options);
    options.transactionKind = 'update';
    store.projectRoot = f.parent;
    store.verify = async () => false;
    expect(await inspection).toMatchObject({ status: 'committed', committed: true });
    const recoveryStore = { ...f.stores['local-verification'] };
    const recoveryOptions = { transactionKind: 'local-verification' as ReviewedTransactionKind, approvalStore: recoveryStore };
    const recovery = recoverReviewedUpdateTransaction(f.root, recoveryOptions);
    recoveryOptions.transactionKind = 'repair';
    recoveryStore.projectRoot = f.parent;
    recoveryStore.verify = async () => false;
    recoveryStore.remove = async () => { throw new Error('late substituted remover'); };
    expect(await recovery).toMatchObject({ status: 'committed', committed: true, cleanupFailures: [] });
  });

  it.each(['update', 'repair', 'other-root'] as const)('rejects the real %s factory before local callbacks or effects', async kind => {
    const f = await fixture(), authorityStore = await foreignStore(f, kind), before = await tree(f.parent);
    const validateCurrentInputs = vi.fn(async () => {});
    await expect(Reflect.apply(applyLocalVerificationTransaction, undefined, [
      f.root, f.mutations, { ...f.applyOptions, authorityStore, validateCurrentInputs }
    ])).rejects.toThrow(/authority|local-verification|project/i);
    expect(validateCurrentInputs).not.toHaveBeenCalled();
    expect(await tree(f.parent)).toEqual(before);
  });

  it.each(['update', 'repair'] as const)('rejects real local authority for a %s operation before callbacks or effects', async kind => {
    const f = await fixture(), before = await tree(f.parent), validatePlan = vi.fn(async () => {});
    await expect(applyReviewedUpdateTransaction(f.root, f.mutations, {
      transactionKind: kind, ...(kind === 'repair' ? { repairIdentity: repairExecutionIdentity('0.12.3', 'azure-local-layout') } : {}),
      planFingerprint: fingerprint, approvalStore: f.stores['local-verification'], validatePlan
    })).rejects.toThrow(/authority|local-verification/);
    expect(validatePlan).not.toHaveBeenCalled();
    expect(await inspectReviewedUpdateTransaction(f.root, {
      transactionKind: kind, approvalStore: f.stores['local-verification']
    })).toMatchObject({ status: 'blocked', committed: false });
    expect(await recoverReviewedUpdateTransaction(f.root, {
      transactionKind: kind, approvalStore: f.stores['local-verification']
    })).toMatchObject({ status: 'blocked', committed: false });
    expect(await tree(f.parent)).toEqual(before);
  });

  it.each((['update', 'repair', 'other-root'] as const).flatMap(kind =>
    (['prepared', 'committed'] as const).map(phase => ({ kind, phase }))))(
    'rejects $kind authority on named and generic local $phase inspection/recovery even with exact seals', async ({ kind, phase }) => {
      const f = await interrupted('local-verification', phase);
      await releaseExitedFixtureLock(f);
      const store = await foreignStore(f, kind);
      const header = JSON.parse((await fs.readFile(f.journal, 'utf8')).split('\n')[0]);
      await store.write(fingerprint, header.transactionDigest);
      for (let index = 0; index < header.mutations.length; index++) await store.write(fingerprint, canonicalSha256({
        schemaVersion: 1, transactionDigest: header.transactionDigest, phase: 'mutation', index
      }));
      if (phase === 'committed') await store.write(fingerprint, canonicalSha256({
        schemaVersion: 1, transactionDigest: header.transactionDigest, phase: 'committed'
      }));
      const before = await tree(f.parent);
      expect(await Reflect.apply(inspectLocalVerificationTransaction, undefined, [f.root, { authorityStore: store }]))
        .toMatchObject({ status: 'blocked', committed: false });
      expect(await inspectReviewedUpdateTransaction(f.root, { transactionKind: 'local-verification', approvalStore: store }))
        .toMatchObject({ status: 'blocked', committed: false });
      expect(await Reflect.apply(recoverLocalVerificationTransaction, undefined, [f.root, { authorityStore: store }]))
        .toMatchObject({ status: 'blocked', committed: false });
      expect(await recoverReviewedUpdateTransaction(f.root, { transactionKind: 'local-verification', approvalStore: store }))
        .toMatchObject({ status: 'blocked', committed: false });
      expect(await tree(f.parent)).toEqual(before);
      expect(await inspectLocalVerificationTransaction(f.root, { authorityStore: f.stores['local-verification'] }))
        .toMatchObject({ status: phase === 'committed' ? 'committed' : 'interrupted' });
    });
});

async function retainedExpectedRecoveryFixture() {
  const f = await fixture(), authorityStore = f.stores['local-verification'];
  const applied = await applyLocalVerificationTransaction(f.root, f.mutations, {
    ...f.applyOptions,
    onCheckpoint: async checkpoint => {
      if (checkpoint.phase === 'committed') throw new Error('Retain genuine journal for exact recovery admission.');
    }
  });
  expect(applied.committed).toBe(true);
  expect(applied.cleanupFailures).toHaveLength(1);
  const inspected = await inspectLocalVerificationTransaction(f.root, { authorityStore });
  if (!inspected.planFingerprint || !inspected.transactionDigest) throw new Error('Actual retained transaction attribution missing.');
  const expectedTransaction: ReviewedRecoveryExpectation = {
    planFingerprint: inspected.planFingerprint, transactionDigest: inspected.transactionDigest
  };
  return { ...f, authorityStore, inspected, expectedTransaction };
}

describe('exact observed local recovery under the mutation lock', () => {
  it.each(['wrong-F', 'same-F-wrong-T'] as const)('rejects %s before real seal removal or target cleanup', async mismatch => {
    const f = await retainedExpectedRecoveryFixture(), before = await tree(f.parent);
    const expectedTransaction = { ...f.expectedTransaction,
      ...(mismatch === 'wrong-F' ? { planFingerprint: 'b'.repeat(64) } : { transactionDigest: 'b'.repeat(64) }) };
    const write = vi.fn(f.authorityStore.write), remove = vi.fn(f.authorityStore.remove);
    const verify = vi.fn(async (plan: string, transaction: string) => {
      expect(JSON.parse(await fs.readFile(await projectMutationLockPath(f.root), 'utf8')).pid).toBe(process.pid);
      return f.authorityStore.verify(plan, transaction);
    });
    const recovered = await recoverLocalVerificationTransaction(f.root, { authorityStore: { ...f.authorityStore, write, verify, remove }, expectedTransaction });
    expect(recovered).toMatchObject({ status: 'blocked', committed: false });
    expect(recovered.rollbackFailures.join(' ')).toMatch(/exact observed/);
    expect(verify).toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(await tree(f.parent)).toEqual(before);
    expect(await inspectLocalVerificationTransaction(f.root, { authorityStore: f.authorityStore })).toEqual(f.inspected);
  });

  it.each(['named', 'generic'] as const)('recovers the exact committed transaction through %s admission', async entrypoint => {
    const f = await retainedExpectedRecoveryFixture();
    const outcome = entrypoint === 'named'
      ? await recoverLocalVerificationTransaction(f.root, { authorityStore: f.authorityStore, expectedTransaction: f.expectedTransaction })
      : await recoverReviewedUpdateTransaction(f.root, { transactionKind: 'local-verification', approvalStore: f.authorityStore, expectedTransaction: f.expectedTransaction });
    expect(outcome).toMatchObject({ status: 'committed', committed: true, ...f.expectedTransaction, rollbackFailures: [], cleanupFailures: [] });
    expect(await fs.readFile(path.join(f.root, 'control'), 'utf8')).toBe('approved target control\n');
    expect((await inspectLocalVerificationTransaction(f.root, { authorityStore: f.authorityStore })).status).toBe('absent');
  });

  it('recovers a matching actual interrupted child without replaying its mutations', async () => {
    const f = await interrupted('local-verification', 'after-mutation', 0);
    expect(() => process.kill(f.pid, 0)).toThrow();
    await releaseExitedFixtureLock(f);
    const authorityStore = f.stores['local-verification'];
    const observed = await inspectLocalVerificationTransaction(f.root, { authorityStore });
    if (!observed.planFingerprint || !observed.transactionDigest) throw new Error('Interrupted attribution missing.');
    expect(await recoverLocalVerificationTransaction(f.root, { authorityStore, expectedTransaction: {
      planFingerprint: observed.planFingerprint, transactionDigest: observed.transactionDigest
    } })).toMatchObject({ status: 'rolled-back', committed: false, planFingerprint: observed.planFingerprint,
      transactionDigest: observed.transactionDigest, rollbackFailures: [], cleanupFailures: [] });
    expect(await tree(f.root)).toEqual(f.before);
  });

  it.each(['matching', 'mismatching'] as const)('captures %s F/T and option fields before awaiting actual journal verification', async initial => {
    const f = await retainedExpectedRecoveryFixture(), before = await tree(f.parent);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const authorityStore = { ...f.authorityStore, verify: async (plan: string, transaction: string) => {
      if (first) { first = false; enter(); await released; }
      return f.authorityStore.verify(plan, transaction);
    } };
    const expectedTransaction = { ...f.expectedTransaction,
      ...(initial === 'mismatching' ? { transactionDigest: 'b'.repeat(64) } : {}) };
    const options = { authorityStore, expectedTransaction };
    const recovery = recoverLocalVerificationTransaction(f.root, options);
    await entered;
    expectedTransaction.planFingerprint = initial === 'matching' ? 'c'.repeat(64) : f.expectedTransaction.planFingerprint;
    expectedTransaction.transactionDigest = initial === 'matching' ? 'd'.repeat(64) : f.expectedTransaction.transactionDigest;
    const getter = vi.fn(() => f.expectedTransaction);
    Object.defineProperty(options, 'expectedTransaction', { enumerable: true, get: getter });
    release();
    const outcome = await recovery;
    expect(getter).not.toHaveBeenCalled();
    expect(outcome.status).toBe(initial === 'matching' ? 'committed' : 'blocked');
    if (initial === 'mismatching') expect(await tree(f.parent)).toEqual(before);
  });

  it.each(['named', 'generic'] as const)('copies the expected tuple synchronously at %s entry before the first await', async entrypoint => {
    const f = await retainedExpectedRecoveryFixture(), expectedTransaction = { ...f.expectedTransaction };
    const recovery = entrypoint === 'named'
      ? recoverLocalVerificationTransaction(f.root, { authorityStore: f.authorityStore, expectedTransaction })
      : recoverReviewedUpdateTransaction(f.root, { transactionKind: 'local-verification', approvalStore: f.authorityStore, expectedTransaction });
    expectedTransaction.planFingerprint = 'b'.repeat(64);
    expectedTransaction.transactionDigest = 'c'.repeat(64);
    expect(await recovery).toMatchObject({ status: 'committed', ...f.expectedTransaction });
  });

  it.each(['field-getter', 'digest-getter', 'inherited-field', 'proxy', 'extra', 'null', 'bad-digest'] as const)(
    'rejects %s expectations without invoking accessors or touching real retained records', async malformed => {
      const f = await retainedExpectedRecoveryFixture(), before = await tree(f.parent), getter = vi.fn(() => fingerprint);
      let options: object = { authorityStore: f.authorityStore, expectedTransaction: { ...f.expectedTransaction } };
      if (malformed === 'field-getter') Object.defineProperty(options, 'expectedTransaction', { enumerable: true, get: getter });
      else if (malformed === 'inherited-field') options = Object.assign(Object.create({ expectedTransaction: f.expectedTransaction }), { authorityStore: f.authorityStore });
      else {
        const value = malformed === 'digest-getter' ? Object.defineProperty({ ...f.expectedTransaction }, 'transactionDigest', { enumerable: true, get: getter })
          : malformed === 'proxy' ? new Proxy(f.expectedTransaction, { get: getter })
          : malformed === 'extra' ? { ...f.expectedTransaction, approved: true }
          : malformed === 'bad-digest' ? { ...f.expectedTransaction, planFingerprint: 'short' } : null;
        options = { authorityStore: f.authorityStore, expectedTransaction: value };
      }
      expect(await Reflect.apply(recoverLocalVerificationTransaction, undefined, [f.root, options])).toMatchObject({ status: 'blocked', committed: false });
      expect(getter).not.toHaveBeenCalled();expect(await tree(f.parent)).toEqual(before);
    });

  it('does not call a disappeared expected transaction absent-success; default absence remains unchanged', async () => {
    const f = await retainedExpectedRecoveryFixture();
    expect((await recoverLocalVerificationTransaction(f.root, { authorityStore: f.authorityStore })).status).toBe('committed');
    const before = await tree(f.parent);
    const outcome = await recoverLocalVerificationTransaction(f.root, { authorityStore: f.authorityStore, expectedTransaction: f.expectedTransaction });
    expect(outcome).toMatchObject({ status: 'blocked', committed: false });
    expect(outcome.rollbackFailures.join(' ')).toMatch(/absent/);
    expect(await tree(f.parent)).toEqual(before);
    expect((await recoverLocalVerificationTransaction(f.root, { authorityStore: f.authorityStore })).status).toBe('absent');
    expect((await recoverReviewedUpdateTransaction(f.root, { approvalStore: f.stores.update })).status).toBe('absent');
    expect((await recoverReviewedUpdateTransaction(f.root, { transactionKind: 'repair', approvalStore: f.stores.repair })).status).toBe('absent');
  });
});
