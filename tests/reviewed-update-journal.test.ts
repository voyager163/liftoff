import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repairExecutionIdentity } from '../src/domain/repair/identity.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { FileSystemError } from '../src/domain/project/errors.js';
import type { ProjectFileMutation, ProjectFileSnapshot } from '../src/adapters/filesystem/project-transaction.js';
import {
  reviewedJournalLimits, captureJournalMutations, captureJournalPreconditions, storeJournalSnapshot,
  measureReviewedJournal, encodeReviewedJournalHeader, encodeReviewedJournalFrame, parseReviewedJournalHeader,
  type JournalPayload, type JournalBody, type StoredSnapshot, type StoredMutation
} from '../src/adapters/filesystem/reviewed-update-journal.js';
import { projectMutationLockPath } from '../src/adapters/filesystem/project-lock.js';
import {
  applyReviewedUpdateTransaction, recoverReviewedUpdateTransaction,
  reviewedRepairTransactionPathParts, reviewedUpdateTransactionPathParts,
  type ReviewedUpdateApprovalStore
} from '../src/adapters/filesystem/reviewed-update-transaction.js';

const roots: string[] = [];
const fingerprint = 'a'.repeat(64);
const maximumJournalBytes = 32 * 1024 * 1024;
const maximumFileBytes = 8 * 1024 * 1024;
const nonce = '12345678-1234-4234-8234-123456789abc';
const rawDigest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function stored(content: Buffer | string, mode = 0o600): StoredSnapshot {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return { kind: 'file', bytes: bytes.toString('base64'), sha256: rawDigest(bytes), mode };
}

function payload(mutations: StoredMutation[] = [{
  type: 'write', pathParts: ['file'], original: { kind: 'missing' }, target: stored('abc')
}]): JournalPayload {
  return { schemaVersion: 1, transactionKind: 'update', projectRoot: '/project', mutations, missingDirectories: [] };
}

function bodyFor(input: JournalPayload): JournalBody {
  return { ...input, planFingerprint: fingerprint, nonce };
}

function oracleHeader(body: JournalBody): Buffer {
  return Buffer.from(canonicalJson({ ...body, transactionDigest: canonicalSha256(body) }));
}

function oracleFrames(count: number): Buffer {
  return Buffer.from([
    ...Array.from({ length: count }, (_, index) => `{"index":${index},"phase":"mutation"}\n`),
    '{"phase":"committed"}\n'
  ].join(''));
}

function repairAtHeaderSize(
  headerBytes: number, root = '/project', mutations?: StoredMutation[], missingDirectories: string[][] = []
): JournalPayload {
  const initial: JournalPayload = {
    ...payload(mutations), projectRoot: root, schemaVersion: 2, transactionKind: 'repair', missingDirectories,
    repairIdentity: repairExecutionIdentity('1.0.0', 'azure-local-layout')
  };
  const difference = headerBytes - oracleHeader(bodyFor(initial)).length;
  if (difference < 0) throw new Error('Fixture header size is too small.');
  const result = { ...initial, repairIdentity: repairExecutionIdentity(`${'1'.repeat(difference + 1)}.0.0`, 'azure-local-layout') };
  expect(oracleHeader(bodyFor(result)).length).toBe(headerBytes);
  return result;
}

function approvalStore(): ReviewedUpdateApprovalStore & { seals: Set<string> } {
  const seals = new Set<string>();
  return {
    seals,
    write: vi.fn(async (plan, digest) => { seals.add(`${plan}:${digest}`); }),
    verify: vi.fn(async (plan, digest) => seals.has(`${plan}:${digest}`)),
    remove: vi.fn(async (plan, digest) => { seals.delete(`${plan}:${digest}`); })
  };
}

async function fixture() {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'journal-size-')));
  roots.push(parent);
  const root = path.join(parent, 'project with spaces');
  await mkdir(root);
  await writeFile(path.join(root, 'source'), 'original bytes\r\n', { mode: 0o640 });
  return { root, store: approvalStore() };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('complete forward journal admission before effect seals', () => {
  it('refuses an oversized real repair envelope before writing seals, a journal or destination bytes', async () => {
    const { root, store } = await fixture();
    const before = await readFile(path.join(root, 'source'));
    const mode = (await stat(path.join(root, 'source'))).mode;
    // The current repair schema accepts this concrete SemVer string. Its bytes
    // are real adapter input, not a placeholder used by a sizing function.
    const identity = repairExecutionIdentity(`${'1'.repeat(maximumJournalBytes)}.0.0`, 'azure-local-layout');
    let failure: unknown;
    try {
      await applyReviewedUpdateTransaction(root, [{ type: 'write', pathParts: ['source'], content: 'target bytes\n' }], {
        transactionKind: 'repair', repairIdentity: identity, planFingerprint: fingerprint, approvalStore: store
      });
    } catch (error) { failure = error; }
    expect.soft(failure).toBeInstanceOf(Error);
    expect.soft(store.write).not.toHaveBeenCalled();
    expect.soft(store.seals.size).toBe(0);
    expect.soft(await readdir(root)).toEqual(['source']);
    expect((await readFile(path.join(root, 'source'))).equals(before)).toBe(true);
    expect((await stat(path.join(root, 'source'))).mode).toBe(mode);
    await expect(stat(await projectMutationLockPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(root, ...reviewedRepairTransactionPathParts))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reserves the real pending frames before any seal when the header alone would fit exactly', async () => {
    const { root, store } = await fixture();
    const original = await readFile(path.join(root, 'source'));
    const mode = (await stat(path.join(root, 'source'))).mode & 0o7777;
    const concrete = repairAtHeaderSize(maximumJournalBytes, root, [{
      type: 'write', pathParts: ['source'], original: stored(original, mode), target: stored('target', mode)
    }], [['.liftoff']]);
    await expect(applyReviewedUpdateTransaction(root, [{ type: 'write', pathParts: ['source'], content: 'target' }], {
      transactionKind: 'repair', repairIdentity: concrete.repairIdentity,
      planFingerprint: fingerprint, approvalStore: store
    })).rejects.toThrow('complete forward journal exceeds');
    expect(store.write).not.toHaveBeenCalled();
    expect(store.seals.size).toBe(0);
    expect(await readdir(root)).toEqual(['source']);
    expect((await readFile(path.join(root, 'source'))).equals(original)).toBe(true);
    await expect(stat(await projectMutationLockPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains target file-size validation under the lock after validatePlan and before authority writes', async () => {
    const { root, store } = await fixture();
    const validatePlan = vi.fn(async () => {
      expect(await readFile(await projectMutationLockPath(root), 'utf8')).toContain('"pid"');
      expect(store.write).not.toHaveBeenCalled();
    });
    await expect(applyReviewedUpdateTransaction(root, [{
      type: 'write', pathParts: ['source'], content: Buffer.alloc(maximumFileBytes + 1)
    }], { planFingerprint: fingerprint, approvalStore: store, validatePlan })).rejects.toThrow('oversized target: source');
    expect(validatePlan).toHaveBeenCalledOnce();
    expect(store.write).not.toHaveBeenCalled();
    expect(await readFile(path.join(root, 'source'), 'utf8')).toBe('original bytes\r\n');
    await expect(stat(await projectMutationLockPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes the shared canonical header and frames exactly without changing authority or modes', async () => {
    const { root, store } = await fixture();
    let expectedHeader: Buffer | undefined;
    const before = await readFile(path.join(root, 'source'));
    const originalMode = (await stat(path.join(root, 'source'))).mode & 0o7777;
    const result = await applyReviewedUpdateTransaction(root, [
      { type: 'write', pathParts: ['source'], content: 'replacement\r\n' },
      { type: 'write', pathParts: ['nested', 'new'], content: Buffer.from([0, 255]), mode: 0o640 }
    ], {
      planFingerprint: fingerprint, approvalStore: store,
      onCheckpoint: async ({ phase, index }) => {
        const content = await readFile(path.join(root, ...reviewedUpdateTransactionPathParts));
        if (phase === 'prepared') {
          const actual: JournalBody = JSON.parse(content.toString('utf8'));
          const { planFingerprint: _fingerprint, nonce: _nonce, ...rest } = actual;
          Reflect.deleteProperty(rest, 'transactionDigest');
          const size = measureReviewedJournal(rest, [], process.platform);
          const encoded = encodeReviewedJournalHeader(bodyFor({ ...rest }), process.platform);
          expect(size.headerBytes).toBe(content.length);
          expect(encoded.content.length).toBe(content.length);
          expect(content.equals(oracleHeader({
            ...rest, nonce: actual.nonce, planFingerprint: actual.planFingerprint
          }))).toBe(true);
          expect(rest.mutations[0].original).toEqual(stored(before, originalMode));
          expectedHeader = content;
        }
        if (phase === 'before-mutation') {
          expect(content.equals(Buffer.concat([
            expectedHeader!,
            Buffer.from(Array.from({ length: index! + 1 }, (_, position) => `{"index":${position},"phase":"mutation"}\n`).join(''))
          ]))).toBe(true);
        }
        if (phase === 'committed') expect(content.equals(Buffer.concat([expectedHeader!, oracleFrames(2)]))).toBe(true);
      }
    });
    expect(result).toMatchObject({ committed: true, cleanupFailures: [], rollbackFailures: [] });
    expect(await readFile(path.join(root, 'source'), 'utf8')).toBe('replacement\r\n');
    expect((await stat(path.join(root, 'source'))).mode & 0o7777).toBe(originalMode);
  });

  it('keeps captured supplied snapshots and their count across validatePlan without rereading caller inputs', async () => {
    const { root, store } = await fixture();
    const original = await readFile(path.join(root, 'source'));
    const mode = (await stat(path.join(root, 'source'))).mode & 0o7777;
    const conditions: ProjectFileSnapshot[] = [{ pathParts: ['source'], content: Buffer.from(original), mode }];
    const target = Buffer.from('reviewed target');
    const mutations: ProjectFileMutation[] = [{ type: 'write', pathParts: ['source'], content: target }];
    const getter = vi.fn(() => { throw new Error('Caller preconditions were reread after validation.'); });
    const options = {
      planFingerprint: fingerprint, approvalStore: store, preconditions: conditions,
      validatePlan: async () => {
        conditions[0].pathParts[0] = 'unreviewed';
        conditions[0].content!.fill(0);
        conditions[0].mode = 0o777;
        conditions.push(...Array.from({ length: 4097 }, (_, index) => ({ pathParts: [`unexpected-${index}`] })));
        mutations.splice(0, mutations.length);
        target.fill(0);
        Object.defineProperty(options, 'preconditions', { get: getter });
      },
      onCheckpoint: async ({ phase }: { phase: string }) => {
        if (phase !== 'prepared') return;
        const header = JSON.parse((await readFile(path.join(root, ...reviewedUpdateTransactionPathParts))).toString('utf8'));
        expect(header.mutations).toHaveLength(1);
        expect(header.mutations[0]).toMatchObject({
          pathParts: ['source'], original: stored(original, mode), target: stored('reviewed target', mode)
        });
      }
    };
    expect(await applyReviewedUpdateTransaction(root, mutations, options)).toMatchObject({ committed: true });
    expect(getter).not.toHaveBeenCalled();
    expect(await readFile(path.join(root, 'source'), 'utf8')).toBe('reviewed target');
  });
});

describe('literal canonical wire vectors', () => {
  const abcHash = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  const mutation = `{"original":{"kind":"missing"},"pathParts":["file"],"target":{"bytes":"YWJj","kind":"file","mode":384,"sha256":"${abcHash}"},"type":"write"}`;
  const prefix = `{"missingDirectories":[],"mutations":[${mutation}],"nonce":"${nonce}","planFingerprint":"${fingerprint}","projectRoot":"/project"`;
  const repairFields = '"repairIdentity":{"cliVersion":"0.12.3","recipe":{"id":"azure-local-layout","sourceLayouts":["azure-flat-root-v1","azure-partial-independent-v1"],"targetLayout":"azure-independent-roots-v1","version":1},"repairContractVersion":1}';

  it.each(['update', 'legacy-update', 'repair', 'legacy-repair'] as const)('matches independent %s bytes and raw digest', (kind) => {
    const current = payload();
    if (kind === 'legacy-update') delete current.transactionKind;
    if (kind === 'repair' || kind === 'legacy-repair') current.transactionKind = 'repair';
    if (kind === 'repair') {
      current.schemaVersion = 2;
      current.repairIdentity = repairExecutionIdentity('0.12.3', 'azure-local-layout');
    }
    const literalBody = `${prefix}${kind === 'repair' ? `,${repairFields}` : ''},"schemaVersion":${kind === 'repair' ? 2 : 1}${kind === 'legacy-update' ? '' : `,"transactionKind":"${current.transactionKind}"`}}\n`;
    expect(rawDigest('abc')).toBe(abcHash);
    expect(Buffer.from('abc').toString('base64')).toBe('YWJj');
    const digest = rawDigest(literalBody);
    const literalHeader = `${prefix}${kind === 'repair' ? `,${repairFields}` : ''},"schemaVersion":${kind === 'repair' ? 2 : 1},"transactionDigest":"${digest}"${kind === 'legacy-update' ? '' : `,"transactionKind":"${current.transactionKind}"`}}\n`;
    const encoded = encodeReviewedJournalHeader(bodyFor(current), 'darwin');
    expect(encoded.content.toString('utf8')).toBe(literalHeader);
    expect(encoded.header.transactionDigest).toBe(digest);
    const size = measureReviewedJournal(current, [], 'darwin');
    expect(size.headerBytes).toBe(Buffer.byteLength(literalHeader));
    expect(size.snapshotBytes).toBe(3);
    expect(encodeReviewedJournalFrame({ phase: 'mutation', index: 0 }).toString('utf8')).toBe('{"index":0,"phase":"mutation"}\n');
    expect(encodeReviewedJournalFrame({ phase: 'committed' }).toString('utf8')).toBe('{"phase":"committed"}\n');
    expect(size.completeJournalBytes).toBe(Buffer.byteLength(literalHeader + '{"index":0,"phase":"mutation"}\n{"phase":"committed"}\n'));
    expect(parseReviewedJournalHeader(encoded.header, '/project', current.transactionKind ?? 'update', 'darwin')).toEqual(encoded.header);
  });

  it.each(['0'.repeat(64), 'f'.repeat(64), '1234abcd'.repeat(8)])('counts exact envelope widths independently of actual fingerprint %s', (planFingerprint) => {
    const input = payload();
    const encoded = encodeReviewedJournalHeader({ ...input, planFingerprint, nonce: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, 'darwin');
    const size = measureReviewedJournal(input, [], 'darwin');
    expect(encoded.content.length).toBe(size.headerBytes);
    expect(encoded.content.equals(oracleHeader({ ...input, planFingerprint, nonce: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }))).toBe(true);
  });

  it.each(['darwin', 'win32'] as const)('accounts Unicode, escaped root, optional requested and effective modes on %s', (platform) => {
    const targetMode = platform === 'win32' ? 0o666 : 0o750;
    const input = payload([{
      type: 'write', pathParts: ['caf\u00e9', '\ud83d\ude80.txt'], mode: 0o750,
      original: stored('', 0o444), target: stored('new\n', targetMode)
    }, { type: 'delete', pathParts: ['deleted'], original: stored('old', 0o640), target: { kind: 'missing' } }]);
    input.projectRoot = platform === 'win32' ? 'C:\\projects\\caf\u00e9 "one"' : '/projects/caf\u00e9 "one"';
    const body = bodyFor(input);
    const encoded = encodeReviewedJournalHeader(body, platform);
    expect(encoded.content.equals(oracleHeader(body))).toBe(true);
    expect(measureReviewedJournal(input, [], platform).completeJournalBytes).toBe(encoded.content.length + oracleFrames(2).length);
  });

  it('measures the actual ordered absent-directory inventory rather than deduplicating shared prefixes', () => {
    const input = payload([
      { type: 'write', pathParts: ['new', 'a', 'one'], original: { kind: 'missing' }, target: stored('') },
      { type: 'write', pathParts: ['new', 'b', 'two'], original: { kind: 'missing' }, target: stored('') }
    ]);
    input.missingDirectories = [['new'], ['new', 'a'], ['new', 'b'], ['.liftoff']];
    const encoded = encodeReviewedJournalHeader(bodyFor(input), 'darwin');
    expect(encoded.content.equals(oracleHeader(bodyFor(input)))).toBe(true);
    expect(encoded.header.missingDirectories).toEqual(input.missingDirectories);
    expect(measureReviewedJournal(input, [], 'darwin').headerBytes).toBe(encoded.content.length);
  });
});

describe('exact finite byte and entry admission', () => {
  it('keeps all numeric limits unchanged', () => {
    expect(reviewedJournalLimits).toEqual({
      mutations: 1024, suppliedPreconditions: 4096, fileBytes: 8_388_608,
      snapshotBytes: 16_777_216, journalBytes: 33_554_432, missingDirectories: 65_537
    });
  });

  it('accepts actual exact 8 MiB original and target buffers at an exact 16 MiB total, without deduplication', () => {
    const content = Buffer.alloc(maximumFileBytes, 'a');
    const snapshot = stored(content);
    const input = payload([{ type: 'write', pathParts: ['same'], original: snapshot, target: snapshot }]);
    expect(measureReviewedJournal(input, [], 'darwin').snapshotBytes).toBe(16_777_216);
    const over = payload([...input.mutations,
      { type: 'write', pathParts: ['one-extra-byte'], original: { kind: 'missing' }, target: stored('x') }]);
    expect(() => measureReviewedJournal(over, [], 'darwin')).toThrow('transaction snapshots exceed');
    const bytesOver = Buffer.alloc(maximumFileBytes + 1);
    expect(() => storeJournalSnapshot({ pathParts: ['source'], content: bytesOver, mode: 0o600 })).toThrow('oversized');
    expect(() => measureReviewedJournal(payload([{ type: 'delete', pathParts: ['source'], original: stored(bytesOver), target: { kind: 'missing' } }]), [], 'darwin'))
      .toThrow(/invalid stored file snapshot|stored snapshot digest/);
    expect(() => measureReviewedJournal(payload([{ type: 'write', pathParts: ['target'], original: { kind: 'missing' }, target: stored(bytesOver) }]), [], 'darwin'))
      .toThrow(/invalid stored file snapshot|stored snapshot digest/);
  });

  it('does not count read-only supplied file bodies in the mutation-snapshot budget', () => {
    const content = Buffer.alloc(maximumFileBytes, 'r');
    const supplied = captureJournalPreconditions([0, 1, 2].map((index) =>
      ({ pathParts: [`readonly-${index}`], content, mode: 0o640 })));
    const size = measureReviewedJournal(payload(), supplied, 'darwin');
    expect(size.suppliedPreconditionCount).toBe(3);
    expect(size.snapshotBytes).toBe(3);
  });

  it.each([0, 1, 10, 100, 1000, 1024])('accounts exactly %i mutation frames including index width changes', (count) => {
    const input = payload(Array.from({ length: count }, (_, index) => ({
      type: 'write', pathParts: [`file-${index}`], original: { kind: 'missing' }, target: stored('')
    })));
    const size = measureReviewedJournal(input, [], 'darwin');
    if (count === 0) {
      expect(size).toEqual({
        kind: 'no-journal', mutationCount: 0, suppliedPreconditionCount: 0, snapshotBytes: 0,
        headerBytes: 0, mutationFrameBytes: 0, commitFrameBytes: 0, completeJournalBytes: 0
      });
      expect(() => encodeReviewedJournalHeader(bodyFor(input), 'darwin')).toThrow('no journal');
    } else {
      expect(size.mutationFrameBytes + size.commitFrameBytes).toBe(oracleFrames(count).length);
      expect(size.completeJournalBytes).toBe(oracleHeader(bodyFor(input)).length + oracleFrames(count).length);
    }
  });

  it('refuses 1025 mutations and 4097 supplied conditions while allowing 4096 supplied plus a new destination', () => {
    const input = payload(Array.from({ length: 1025 }, (_, index) => ({
      type: 'delete', pathParts: [`file-${index}`], original: { kind: 'missing' }, target: { kind: 'missing' }
    })));
    expect(() => measureReviewedJournal(input, [], 'darwin')).toThrow('oversized recovery journal');
    const raw = Array.from({ length: 4096 }, (_, index) => ({ pathParts: [`condition-${index}`] }));
    const captured = captureJournalPreconditions(raw);
    expect(measureReviewedJournal(payload(), captured, 'darwin').suppliedPreconditionCount).toBe(4096);
    expect(() => captureJournalPreconditions([...raw, { pathParts: ['one-over'] }])).toThrow('too many preconditions');
    expect(() => measureReviewedJournal(payload(), [...captured, { pathParts: ['one-over'], stored: { kind: 'missing' } }], 'darwin'))
      .toThrow('too many preconditions');
  });

  it('retains the cleanup-directory count bound independently of directory semantics', () => {
    const input = payload();
    input.missingDirectories = Array.from({ length: 65_538 }, (_, index) => [`parent-${index}`]);
    expect(() => measureReviewedJournal(input, [], 'darwin')).toThrow('oversized recovery journal');
    input.missingDirectories.pop();
    expect(() => measureReviewedJournal(input, [], 'darwin')).toThrow('invalid or duplicate directory cleanup inventory');
  });

  it('accepts exactly 32 MiB including frames and rejects one additional real encoded byte', () => {
    const frameBytes = oracleFrames(1).length;
    const exact = repairAtHeaderSize(maximumJournalBytes - frameBytes);
    const size = measureReviewedJournal(exact, [], 'darwin');
    expect(size.completeJournalBytes).toBe(33_554_432);
    const encoded = encodeReviewedJournalHeader(bodyFor(exact), 'darwin');
    expect(encoded.content.length + frameBytes).toBe(33_554_432);
    const over = { ...exact, repairIdentity: repairExecutionIdentity(`1${exact.repairIdentity!.cliVersion}`, 'azure-local-layout') };
    expect(oracleHeader(bodyFor(over)).length + frameBytes).toBe(33_554_433);
    expect(() => measureReviewedJournal(over, [], 'darwin')).toThrow('complete forward journal exceeds');
    expect(() => encodeReviewedJournalHeader(bodyFor(over), 'darwin')).toThrow('complete forward journal exceeds');
  });

  it('rejects a header that fits when its pending mutation and commit frames cross the cap', () => {
    const input = repairAtHeaderSize(maximumJournalBytes);
    expect(oracleHeader(bodyFor(input)).length).toBe(maximumJournalBytes);
    expect(() => measureReviewedJournal(input, [], 'darwin')).toThrow('complete forward journal exceeds');
  });

  it('counts source copying and active-manifest replacement as 2*S+I+T+C', () => {
    const original = Buffer.from('{"historical":"raw bytes"}\r\n');
    const index = 'canonical index\n';
    const target = 'complete successor bytes\n';
    const coreBefore = 'old core', coreAfter = 'new core';
    const input = payload([
      { type: 'write', pathParts: ['history', 'copy'], original: { kind: 'missing' }, target: stored(original) },
      { type: 'write', pathParts: ['history', 'index'], original: { kind: 'missing' }, target: stored(index) },
      { type: 'write', pathParts: ['core'], original: stored(coreBefore), target: stored(coreAfter) },
      { type: 'write', pathParts: ['liftoff.manifest.json'], original: stored(original), target: stored(target) }
    ]);
    const size = measureReviewedJournal(input, [], 'darwin');
    expect(size.snapshotBytes).toBe(2 * original.length + Buffer.byteLength(index + target + coreBefore + coreAfter));
    const maximumSource = stored(Buffer.alloc(maximumFileBytes, ' '));
    input.mutations[0].target = maximumSource;
    input.mutations[3].original = maximumSource;
    expect(() => measureReviewedJournal(input, [], 'darwin')).toThrow('transaction snapshots exceed');
  });
});

describe('shared input and protocol guards', () => {
  it('captures real Buffer bytes without executing valueOf, iterator or constructor hooks', () => {
    const bytes = Buffer.from('actual');
    const hook = vi.fn(() => Buffer.from('replacement'));
    for (const key of ['valueOf', 'constructor', Symbol.iterator]) Object.defineProperty(bytes, key, { get: hook });
    const captures = captureJournalPreconditions([{ pathParts: ['source'], content: bytes, mode: 0o640 }]);
    const mutations = captureJournalMutations([{ type: 'write', pathParts: ['target'], content: bytes }]);
    expect(captures[0].stored).toEqual(stored('actual', 0o640));
    const mutation = mutations[0];
    if (mutation.type !== 'write') throw new Error('Expected write.');
    expect(mutation.content.toString()).toBe('actual');
    expect(hook).not.toHaveBeenCalled();
    bytes.fill(0);
    expect(captures[0].stored).toEqual(stored('actual', 0o640));
    expect(mutation.content.toString()).toBe('actual');
  });

  it.each(['payload', 'mutation', 'snapshot', 'array', 'path', 'repair-identity'] as const)('rejects accessor-bearing %s before invoking it', (level) => {
    const input = payload();
    const getter = vi.fn(() => { throw new Error('Unexpected accessor invocation'); });
    if (level === 'payload') Object.defineProperty(input, 'projectRoot', { get: getter });
    if (level === 'mutation') Object.defineProperty(input.mutations[0], 'target', { get: getter });
    if (level === 'snapshot') Object.defineProperty(input.mutations[0].target, 'kind', { get: getter });
    if (level === 'array') Object.defineProperty(input.mutations, '0', { get: getter });
    if (level === 'path') Object.defineProperty(input.mutations[0].pathParts, '0', { get: getter });
    if (level === 'repair-identity') {
      input.schemaVersion = 2;
      input.transactionKind = 'repair';
      input.repairIdentity = repairExecutionIdentity('0.12.3', 'azure-local-layout');
      Object.defineProperty(input.repairIdentity, 'cliVersion', { get: getter });
    }
    expect(() => measureReviewedJournal(input, [], 'darwin')).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(['duplicate', 'case', 'prefix', 'reserved', 'bad-base64', 'digest', 'mode', 'extra', 'sparse', 'unknown-kind', 'unknown-schema', 'false-missing-directory'] as const)(
    'rejects malformed concrete input %s without a success-shaped size',
    (fault) => {
      const input = payload();
      if (fault === 'duplicate') input.mutations.push(structuredClone(input.mutations[0]));
      if (fault === 'case') input.mutations.push({ ...structuredClone(input.mutations[0]), pathParts: ['FILE'] });
      if (fault === 'prefix') input.mutations.push({ ...structuredClone(input.mutations[0]), pathParts: ['file', 'child'] });
      if (fault === 'reserved') input.mutations[0].pathParts = [...reviewedUpdateTransactionPathParts];
      if (fault === 'bad-base64') Object.assign(input.mutations[0].target, { bytes: '!!!!' });
      if (fault === 'digest') Object.assign(input.mutations[0].target, { sha256: '0'.repeat(64) });
      if (fault === 'mode') Object.assign(input.mutations[0].target, { mode: 0o10000 });
      if (fault === 'extra') Object.assign(input, { approved: true });
      if (fault === 'sparse') Reflect.deleteProperty(input.mutations, '0');
      if (fault === 'unknown-kind') Object.assign(input, { transactionKind: 'unregistered' });
      if (fault === 'unknown-schema') Object.assign(input, { schemaVersion: 99 });
      if (fault === 'false-missing-directory') input.missingDirectories = [['unrelated']];
      expect(() => measureReviewedJournal(input, [], 'darwin')).toThrow();
    }
  );

  it('rejects inconsistent supplied originals and does not count merged destinations as supplied conditions', () => {
    const input = payload();
    const same = [{ pathParts: ['file'], stored: { kind: 'missing' as const } }];
    expect(measureReviewedJournal(input, same, 'darwin').suppliedPreconditionCount).toBe(1);
    expect(() => measureReviewedJournal(input, [{ pathParts: ['file'], stored: stored('changed') }], 'darwin')).toThrow('supplied precondition');
    expect(() => measureReviewedJournal(input, [...same, ...same], 'darwin')).toThrow('duplicate or case-colliding preconditions');
  });

  it('preserves exact legacy schema dispatch and refuses reclassification as repair', () => {
    const input = payload();
    delete input.transactionKind;
    const encoded = encodeReviewedJournalHeader(bodyFor(input), 'darwin');
    expect(encoded.header).not.toHaveProperty('transactionKind');
    expect(() => parseReviewedJournalHeader(encoded.header, input.projectRoot, 'repair', 'darwin')).toThrow('does not match its registered path');
    const invalid = { ...encoded.header, nonce: 'not-a-uuid' };
    expect(() => parseReviewedJournalHeader(invalid, input.projectRoot, 'update', 'darwin')).toThrow(FileSystemError);
  });
});

describe('bounded legacy recovery is independent of forward admission', () => {
  it('recovers a real sealed legacy header within the reader limit even when remaining frames exceed it', async () => {
    const { root, store } = await fixture();
    const target = stored(Buffer.alloc(16 * 1024, 'x'), process.platform === 'win32' ? 0o666 : 0o600);
    const mutations: StoredMutation[] = Array.from({ length: 1024 }, (_, index) => ({
      type: 'write', pathParts: [`m${String(index).padStart(4, '0')}`, ...Array<string>(62).fill('segment'), 'file'],
      original: { kind: 'missing' }, target
    }));
    const legacy: JournalPayload = {
      schemaVersion: 1, transactionKind: 'repair', projectRoot: root, mutations, missingDirectories: []
    };
    let bytes = oracleHeader(bodyFor(legacy)).length;
    const targetBytes = maximumJournalBytes - 1000;
    const directories = [['.liftoff'], ...mutations.flatMap((mutation) =>
      Array.from({ length: mutation.pathParts.length - 1 }, (_, index) => mutation.pathParts.slice(0, index + 1)))];
    for (const parts of directories) {
      const additional = Buffer.byteLength(JSON.stringify(parts)) + (legacy.missingDirectories.length ? 1 : 0);
      if (bytes + additional > targetBytes) break;
      legacy.missingDirectories.push(parts);
      bytes += additional;
    }
    const headerBytes = oracleHeader(bodyFor(legacy));
    expect(headerBytes.length).toBe(bytes);
    expect(headerBytes.length).toBeLessThanOrEqual(maximumJournalBytes);
    expect(headerBytes.length + oracleFrames(mutations.length).length).toBeGreaterThan(maximumJournalBytes);
    const header = JSON.parse(headerBytes.toString('utf8'));
    expect(() => measureReviewedJournal(legacy, [], process.platform)).toThrow('complete forward journal exceeds');
    expect(parseReviewedJournalHeader(header, root, 'repair', process.platform).transactionDigest).toBe(header.transactionDigest);

    // This fixture has no attempted mutations: all concrete destinations are
    // absent. Recovery must read and preserve that state, not resume the writes.
    expect(await readdir(root)).toEqual(['source']);
    await mkdir(path.join(root, '.liftoff'));
    const journal = path.join(root, ...reviewedRepairTransactionPathParts);
    await writeFile(journal, headerBytes, { mode: 0o600 });
    await store.write(fingerprint, header.transactionDigest);
    await store.write(fingerprint, canonicalSha256({
      schemaVersion: 1, transactionDigest: header.transactionDigest, phase: 'rollback-cleanup-only'
    }));
    const result = await recoverReviewedUpdateTransaction(root, { transactionKind: 'repair', approvalStore: store });
    expect(result).toMatchObject({ status: 'rolled-back', committed: false, rollbackFailures: [], cleanupFailures: [] });
    expect(await readdir(root)).toEqual(['source']);
    expect(await readFile(path.join(root, 'source'), 'utf8')).toBe('original bytes\r\n');
    expect(store.seals.size).toBe(0);
    await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it('retains a zero-mutation no-journal apply with actual precondition validation and lock cleanup', async () => {
    const { root, store } = await fixture();
    const original = await readFile(path.join(root, 'source'));
    const mode = (await stat(path.join(root, 'source'))).mode & 0o7777;
    expect(await applyReviewedUpdateTransaction(root, [], {
      planFingerprint: fingerprint, approvalStore: store,
      preconditions: [{ pathParts: ['source'], content: original, mode }]
    })).toMatchObject({ status: 'absent', committed: false });
    expect(store.write).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['source']);
    await expect(stat(await projectMutationLockPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(applyReviewedUpdateTransaction(root, [], {
      planFingerprint: fingerprint, approvalStore: store,
      preconditions: [{ pathParts: ['source'], content: Buffer.from('changed expectation'), mode }]
    })).rejects.toThrow('target changed after review');
  });
});
import { createHash } from 'node:crypto';
