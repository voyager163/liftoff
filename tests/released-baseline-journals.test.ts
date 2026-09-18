import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  inspectReviewedUpdateTransaction, recoverReviewedUpdateTransaction
} from '../src/adapters/filesystem/reviewed-update-transaction.js';
import { projectMutationLockPath } from '../src/adapters/filesystem/project-lock.js';
import { createUpdateTransactionApprovalStore } from '../src/adapters/filesystem/update-previews.js';
import {
  updateTransactionApprovalKey, validateUpdateTransactionApprovalSeal
} from '../src/application/update/transaction-approval.js';
import {
  capturedTree, materializeReleasedFiles, materializeReleasedJournalSource,
  readReleasedBaselineIndex, releasedBytes, releasedDigest, type CapturedJournal
} from './fixtures/released-baseline/corpus.js';

interface Snapshot {
  kind: 'missing' | 'file';
  bytes?: string;
  sha256?: string;
  mode?: number;
}
interface Header {
  schemaVersion: number;
  transactionKind?: 'update' | 'repair';
  projectRoot: string;
  planFingerprint: string;
  nonce: string;
  transactionDigest: string;
  repairIdentity?: { cliVersion: string; repairContractVersion: number; recipe: { id: string; version: number } };
  mutations: Array<{ type: 'write' | 'delete'; pathParts: string[]; original: Snapshot; target: Snapshot }>;
}
interface Handover {
  caseId: string;
  root: string;
  home: string;
  lock: string;
  fingerprint: string;
  before: Array<{ path: string; bytes: string; mode: number }>;
}
const index = readReleasedBaselineIndex();
const journals = index.cases.filter((entry): entry is CapturedJournal => entry.family === 'journal');
const writers = journals.filter((entry) => entry.checkpoint.phase === 'committed');
const roots = new Set<string>();
const sourceParent = path.resolve('tests', `.released-baseline-sources-${process.pid}-${randomUUID()}`);
const now = () => new Date('2026-09-10T00:00:00.000Z');

beforeAll(async () => {
  await mkdir(sourceParent, { mode: 0o700 });
  for (const source of index.sources) {
    const root = path.join(sourceParent, source.release);
    await mkdir(root, { mode: 0o700 });
    await materializeReleasedJournalSource(root, source);
  }
});
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});
afterAll(async () => { await rm(sourceParent, { recursive: true, force: true }); });

async function workspace() {
  const root = path.resolve('tests', `.released-baseline-journal-${process.pid}-${randomUUID()}`);
  roots.add(root);
  await mkdir(root, { mode: 0o700 });
  return root;
}

function parsedJournal(bytes: Buffer) {
  expect(bytes.at(-1)).toBe(0x0a);
  const lines = bytes.toString('utf8').split('\n').slice(0, -1);
  const values = lines.map((line) => {
    const value = JSON.parse(line);
    expect(canonicalJson(value)).toBe(`${line}\n`);
    return value;
  });
  const header = values[0] as Header;
  const { transactionDigest, ...body } = header;
  expect(canonicalSha256(body)).toBe(transactionDigest);
  for (const mutation of header.mutations) {
    for (const snapshot of [mutation.original, mutation.target]) {
      if (snapshot.kind === 'file') expect(releasedDigest(Buffer.from(snapshot.bytes!, 'base64'))).toBe(snapshot.sha256);
    }
  }
  return { header, frames: values.slice(1) as Array<{ phase: string; index?: number }> };
}

function assertOriginalSeals(
  header: Header,
  frames: Array<{ phase: string; index?: number }>,
  seals: Array<{ path: string; bytes: Buffer }>
) {
  const expected = new Set([
    header.transactionDigest,
    canonicalSha256({ schemaVersion: 1, transactionDigest: header.transactionDigest, phase: 'rollback-cleanup-only' }),
    ...frames.map((frame) => canonicalSha256({ schemaVersion: 1, transactionDigest: header.transactionDigest, ...frame }))
  ]);
  const actual = new Set<string>();
  for (const file of seals) {
    const seal = JSON.parse(file.bytes.toString('utf8'));
    const binding = {
      projectRoot: header.projectRoot, planFingerprint: header.planFingerprint, transactionDigest: seal.transactionDigest
    };
    expect(validateUpdateTransactionApprovalSeal(seal, binding, now())).toEqual(seal);
    expect(path.basename(file.path)).toBe(`approval-${updateTransactionApprovalKey(binding)}.json`);
    expect(canonicalJson(seal)).toBe(file.bytes.toString('utf8'));
    expect(seal.approvedAt).toBe('2026-09-09T00:00:00.000Z');
    actual.add(seal.transactionDigest);
  }
  expect(actual).toEqual(expected);
}

async function releasedHandover(writer: CapturedJournal, checkpoint: { phase: string; index?: number }) {
  const parent = await workspace();
  const sourceRoot = path.join(sourceParent, writer.release);
  const child = spawnSync(process.execPath, [
    path.resolve('tests/fixtures/released-baseline/journal-producer.mjs'),
    JSON.stringify({ sourceRoot, workspace: parent, caseId: writer.writerId, checkpoint })
  ], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status, child.stderr).toBe(73);
  const handover = JSON.parse(await readFile(path.join(parent, 'handover.json'), 'utf8')) as Handover;
  expect(handover.root).toBe(path.join(parent, "project's directory with spaces"));
  expect(handover.caseId).toBe(writer.writerId);
  const owner = await readFile(handover.lock);
  expect(JSON.parse(owner.toString('utf8'))).toMatchObject({ schemaVersion: 1, pid: child.pid });
  expect(await projectMutationLockPath(handover.root)).toBe(handover.lock);
  const dependencies = JSON.parse(await readFile(path.join(parent, 'loaded-source.json'), 'utf8')) as string[];
  const source = index.sources.find((entry) => entry.release === writer.release)!;
  for (const name of dependencies) {
    expect(source.journalExecutionFiles).toContain(name);
    const file = source.files.find((entry) => entry.path === name)!;
    expect(await readFile(path.join(sourceRoot, ...name.split('/')))).toEqual(releasedBytes(file));
  }
  const journal = path.join(handover.root, ...writer.journalPath.split('/'));
  const original = await readFile(journal);
  const parsed = parsedJournal(original);
  expect(parsed.header.projectRoot).toBe(handover.root);
  expect(parsed.header.schemaVersion).toBe(writer.schemaVersion);
  expect(Object.hasOwn(parsed.header, 'transactionKind')).toBe(writer.explicitKind);
  const seals = await capturedTree(handover.home);
  assertOriginalSeals(parsed.header, parsed.frames, seals.map((file) => ({ path: file.path, bytes: Buffer.from(file.bytes, 'base64') })));
  const approvalStore = createUpdateTransactionApprovalStore(handover.root, {
    homedir: handover.home, env: {}, repositoryRoot: handover.root, clock: now
  });
  return { ...handover, writer, journal, original, owner, ownerDetails: await lstat(handover.lock), producerPid: child.pid, seals, ...parsed, approvalStore };
}

async function reviewStoppedFixtureOwner(fixture: Awaited<ReturnType<typeof releasedHandover>>) {
  const owner = JSON.parse(fixture.owner.toString('utf8'));
  expect(owner.pid).toBe(fixture.producerPid);
  let absent = false;
  try { process.kill(owner.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') absent = true; else throw error; }
  if (!absent) throw new Error('The exact released fixture owner is still live; preserve its lock.');
  const details = await lstat(fixture.lock);
  expect(details.isFile()).toBe(true);
  expect(details.nlink).toBe(1);
  expect([details.dev, details.ino, details.mode, details.uid, details.gid])
    .toEqual([fixture.ownerDetails.dev, fixture.ownerDetails.ino, fixture.ownerDetails.mode, fixture.ownerDetails.uid, fixture.ownerDetails.gid]);
  expect(await readFile(fixture.lock)).toEqual(fixture.owner);
  // Only the test-owned, observed-stopped producer lock is reviewed away; journals and seals are never edited.
  await unlink(fixture.lock);
}

describe('immutable released journals are root-bound static diagnostic evidence', () => {
  it.each(journals)('validates $id seals and refuses foreign-root recovery without rebasing any bytes', async (entry) => {
    const original = releasedBytes(entry.files.find((file) => file.path === entry.journalPath)!);
    const { header, frames } = parsedJournal(original);
    expect(header.projectRoot).toBe(entry.root);
    expect(header.schemaVersion).toBe(entry.schemaVersion);
    expect(Object.hasOwn(header, 'transactionKind')).toBe(entry.explicitKind);
    if (entry.explicitKind) expect(header.transactionKind).toBe(entry.kind);
    if (entry.recipe) {
      expect(header.repairIdentity).toMatchObject({
        cliVersion: '0.12.3', repairContractVersion: 1, recipe: { id: entry.recipe, version: 1 }
      });
    } else expect(header).not.toHaveProperty('repairIdentity');
    expect(frames).toEqual(entry.checkpoint.phase === 'committed'
      ? [...Array.from({ length: 5 }, (_, index) => ({ phase: 'mutation', index })), { phase: 'committed' }]
      : Array.from({ length: 3 }, (_, index) => ({ phase: 'mutation', index })));
    assertOriginalSeals(header, frames, entry.externalSeals.map((file) => ({ path: file.path, bytes: releasedBytes(file) })));
    const owner = JSON.parse(releasedBytes(entry.owner).toString('utf8'));
    expect(owner.schemaVersion).toBe(1);
    expect(owner.pid).toBeGreaterThan(0);
    expect(owner.token).toMatch(/^[a-f0-9-]{36}$/u);
    const handover = JSON.parse(releasedBytes(entry.handover).toString('utf8')) as Handover;
    expect(handover).toMatchObject({ root: entry.root, home: entry.home, lock: entry.owner.path, fingerprint: header.planFingerprint });
    const raw = Buffer.from(handover.before.find((file) => file.path.endsWith('main.tf') || file.path.endsWith('receipt.bin'))!.bytes, 'base64');
    expect(raw.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(raw.includes(Buffer.from([0xff, 0x00, 0x80, 0x0d, 0x0a]))).toBe(true);
    expect(header.mutations[0].target.mode).toBe(0o440);
    const parent = await workspace();
    const root = path.join(parent, 'foreign project'), home = path.join(parent, 'foreign private home');
    await mkdir(root, { mode: 0o700 });
    await mkdir(home, { mode: 0o700 });
    await materializeReleasedFiles(root, entry.files);
    await materializeReleasedFiles(home, entry.externalSeals);
    expect(root).not.toBe(header.projectRoot);
    expect(await projectMutationLockPath(root)).not.toBe(entry.owner.path);
    const before = await capturedTree(parent);
    const approvalStore = createUpdateTransactionApprovalStore(root, { homedir: home, env: {}, repositoryRoot: root, clock: now });
    const options = { transactionKind: entry.kind, approvalStore };
    expect(await inspectReviewedUpdateTransaction(root, options)).toMatchObject({
      status: 'blocked', reason: expect.stringMatching(/wrong-project/u)
    });
    expect(await recoverReviewedUpdateTransaction(root, options)).toMatchObject({ status: 'blocked', committed: false });
    expect(await capturedTree(parent)).toEqual(before);
    expect(await readFile(path.join(root, ...entry.journalPath.split('/')))).toEqual(original);
  });
});

describe('actual released writer to current recovery at the same private root', () => {
  const checkpoints = [
    { phase: 'after-mutation', index: 2 },
    { phase: 'staged', index: 3 },
    { phase: 'committed' }
  ];
  const executions = writers.flatMap((writer) => checkpoints.map((checkpoint) => ({
    writer, checkpoint, label: `${writer.writerId} / ${checkpoint.phase}`
  })));
  it.each(executions)('recovers $label with original journals, private seals, bytes and modes', async ({ writer, checkpoint }) => {
    const fixture = await releasedHandover(writer, checkpoint);
    const options = { transactionKind: writer.kind, approvalStore: fixture.approvalStore };
    const inspection = await inspectReviewedUpdateTransaction(fixture.root, options);
    expect(inspection).toMatchObject({
      status: checkpoint.phase === 'committed' ? 'committed' : 'interrupted',
      schemaVersion: writer.schemaVersion, planFingerprint: fixture.fingerprint,
      transactionDigest: fixture.header.transactionDigest
    });
    if (writer.recipe) expect(inspection.repairIdentity).toEqual(fixture.header.repairIdentity);
    else expect(inspection.repairIdentity).toBeUndefined();
    expect(await readFile(fixture.journal)).toEqual(fixture.original);
    expect(await readFile(fixture.lock)).toEqual(fixture.owner);
    expect(await capturedTree(fixture.home)).toEqual(fixture.seals);
    await expect(recoverReviewedUpdateTransaction(fixture.root, options)).rejects.toThrow(/never removes an unowned lock/u);
    await reviewStoppedFixtureOwner(fixture);
    expect(await readFile(fixture.journal)).toEqual(fixture.original);
    expect(await capturedTree(fixture.home)).toEqual(fixture.seals);
    const validateRecovery = vi.fn(async (fingerprint: string) => { expect(fingerprint).toBe(fixture.fingerprint); });
    const onCommittedReadback = vi.fn(async () => {
      expect(await readFile(fixture.journal)).toEqual(fixture.original);
    });
    const result = await recoverReviewedUpdateTransaction(fixture.root, { ...options, validateRecovery, onCommittedReadback });
    const committed = checkpoint.phase === 'committed';
    expect(result).toMatchObject({
      status: committed ? 'committed' : 'rolled-back', committed,
      planFingerprint: fixture.fingerprint, transactionDigest: fixture.header.transactionDigest,
      rollbackFailures: [], cleanupFailures: []
    });
    expect(validateRecovery).toHaveBeenCalledOnce();
    expect(onCommittedReadback).toHaveBeenCalledTimes(committed ? 1 : 0);
    const expected = new Map(fixture.before.map((file) => [file.path, file]));
    if (committed) {
      for (const mutation of fixture.header.mutations) {
        const name = mutation.pathParts.join('/');
        if (mutation.target.kind === 'missing') expected.delete(name);
        else expected.set(name, { path: name, bytes: mutation.target.bytes!, mode: mutation.target.mode! });
      }
    }
    const sort = <T extends { path: string }>(files: T[]) => files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    expect(sort(await capturedTree(fixture.root))).toEqual(sort([...expected.values()]));
    expect(await capturedTree(fixture.home)).toEqual([]);
    await expect(lstat(fixture.journal)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(fixture.lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['future-schema', 'unknown-recipe', 'missing-checkpoint-seal', 'changed-original'] as const)(
    'blocks %s in a same-root released repair without issuing replacement authority',
    async (variant) => {
      const writer = writers.find((entry) => entry.writerId === 'repair-v0.12.3-azure-schema2')!;
      const fixture = await releasedHandover(writer, { phase: 'after-mutation', index: 2 });
      await reviewStoppedFixtureOwner(fixture);
      if (variant === 'future-schema' || variant === 'unknown-recipe') {
        const lines = fixture.original.toString('utf8').split('\n');
        const header = JSON.parse(lines[0]);
        if (variant === 'future-schema') header.schemaVersion = 99;
        else header.repairIdentity.recipe.version = 99;
        // Deliberately corrupt only the disposable copy; retain its original digest and external seals.
        lines[0] = canonicalJson(header).trimEnd();
        await writeFile(fixture.journal, lines.join('\n'));
      } else if (variant === 'missing-checkpoint-seal') {
        const checkpointDigest = canonicalSha256({
          schemaVersion: 1, transactionDigest: fixture.header.transactionDigest, phase: 'mutation', index: 2
        });
        const seal = fixture.seals.find((entry) =>
          JSON.parse(Buffer.from(entry.bytes, 'base64').toString('utf8')).transactionDigest === checkpointDigest)!;
        await rm(path.join(fixture.home, ...seal.path.split('/')));
      } else {
        const original = fixture.header.mutations[2].pathParts;
        await writeFile(path.join(fixture.root, ...original), Buffer.from('concurrent developer bytes\r\n'));
      }
      const before = await capturedTree(fixture.root), seals = await capturedTree(fixture.home);
      const options = { transactionKind: 'repair' as const, approvalStore: fixture.approvalStore };
      if (variant !== 'changed-original') {
        const result = await inspectReviewedUpdateTransaction(fixture.root, options);
        expect(result.status).toBe('blocked');
        expect(result.reason).toMatch(variant === 'future-schema' ? /unsupported.*schema\/identity/iu
          : variant === 'unknown-recipe' ? /Unsupported repair recipe/u : /matching user-local approval/u);
      }
      const recovery = await recoverReviewedUpdateTransaction(fixture.root, options);
      expect(recovery).toMatchObject({ status: 'blocked', committed: false });
      if (variant === 'changed-original') {
        expect(recovery.rollbackFailures).toContainEqual(expect.stringContaining('target changed before rollback; it was preserved'));
        const rolledBack = new Set(fixture.header.mutations.slice(0, 2).map((mutation) => mutation.pathParts.join('/')));
        expect(await capturedTree(fixture.root)).toEqual(before.filter((file) => !rolledBack.has(file.path)));
        expect(await readFile(fixture.journal)).toEqual(fixture.original);
      } else expect(await capturedTree(fixture.root)).toEqual(before);
      expect(await capturedTree(fixture.home)).toEqual(seals);
    }
  );

  it('does not reinterpret the released schema-1 update without a kind as a repair journal', async () => {
    const writer = writers.find((entry) => entry.writerId === 'update-v0.11.2-schema1')!;
    const fixture = await releasedHandover(writer, { phase: 'after-mutation', index: 2 });
    await reviewStoppedFixtureOwner(fixture);
    const wrongPath = path.join(fixture.root, '.liftoff', 'reviewed-repair-transaction.json');
    await rename(fixture.journal, wrongPath);
    const before = await capturedTree(fixture.root), seals = await capturedTree(fixture.home);
    const options = { transactionKind: 'repair' as const, approvalStore: fixture.approvalStore };
    expect(await inspectReviewedUpdateTransaction(fixture.root, options)).toMatchObject({
      status: 'blocked', reason: expect.stringMatching(/transaction kind does not match/u)
    });
    expect(await recoverReviewedUpdateTransaction(fixture.root, options)).toMatchObject({ status: 'blocked', committed: false });
    expect(await capturedTree(fixture.root)).toEqual(before);
    expect(await capturedTree(fixture.home)).toEqual(seals);
    expect(await readFile(wrongPath)).toEqual(fixture.original);
  });
});
