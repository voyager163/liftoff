import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { capturedV3Records, capturedV3Successor, writeFixtureBytes } from './fixtures/activation-v3/fixture.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { historicalV1ActivationIdentity, historicalV2ActivationIdentity, releasedV3ActivationIdentity } from '../src/domain/governance/policy/identity.js';
import { createReleasedSourceHistoryIndex, historyArray, historyRecord, parseHistoryJson, rawHistoryDigest, type HistoricalFileKind } from '../src/governance-activation/history-contracts.js';
import { validateHistoricalV3EvidenceRecord, historicalV3EvidenceBodyDigest } from '../src/governance-activation/historical-v3.js';
import { validateCapturedReleasedSource, validatePlannedReleasedSourceSnapshot } from '../src/governance-activation/historical-state.js';
import { readModernActivationSuccessorSource } from '../src/governance-activation/migration-history.js';
import { readFrozenActivationManifestHistory, readFrozenV3ActivationManifestHistory } from '../src/governance-activation/frozen-manifest-history.js';
import { copySourceHistoryData, copySourceHistoryObservations, createSourceHistoryCapture } from '../src/governance-activation/source-history-capture.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true }); });
const identities = { 1: historicalV1ActivationIdentity, 2: historicalV2ActivationIdentity, 3: releasedV3ActivationIdentity };
type SourceFile = { kind: HistoricalFileKind; pathParts: string[]; content: Buffer; mode: number };
function minimal(version: 1 | 2 | 3): SourceFile[] {
  const sample = capturedV3Successor(version === 1 ? 1 : 2);
  const manifest = version === 3 ? capturedV3Records().manifest : parseHistoryJson(sample.files.get('liftoff.manifest.json')!, 'manifest');
  const state = version === 3 ? historyRecord(sample.state, 'state') :
    historyRecord(parseHistoryJson(sample.files.get('governance/activation-state.json')!, 'state'), 'state');
  for (const key of ['bootstrapState', 'successorHistory', 'phaseOutputs', 'taskProjection']) delete state[key];
  state.activeChange = null;
  for (const value of Object.values(historyRecord(state.phases, 'phases'))) {
    const phase = historyRecord(value, 'phase'); Object.assign(phase, { state: 'pending', evidence: [], approvals: [], blockers: [] });
    delete phase.executionPlanDigest; delete phase.operation;
  }
  return [
    { kind: 'manifest', pathParts: ['liftoff.manifest.json'], content: Buffer.from(JSON.stringify(manifest, null, '\t') + '\r\n'), mode: 0o640 },
    { kind: 'state', pathParts: ['governance', 'activation-state.json'], content: Buffer.from(JSON.stringify(state, null, '\t') + '\r\n'), mode: 0o644 }
  ];
}
function snapshot(version: 1 | 2 | 3, files: SourceFile[]) {
  const index = createReleasedSourceHistoryIndex(identities[version], files.map(file => ({
    kind: file.kind, originalPathParts: file.pathParts, digest: rawHistoryDigest(file.content), mode: file.mode
  })));
  const content = Buffer.from(canonicalJson(index));
  return { version, files, index, content };
}
function successor(version: 2 | 3, ancestor: ReturnType<typeof snapshot>) {
  const files = minimal(version), state = historyRecord(parseHistoryJson(files[1].content, 'state'), 'state');
  const journal = structuredClone(capturedV3Successor(ancestor.version === 1 ? 1 : 2).journal);
  Reflect.set(journal, 'laneId', `activation-v${ancestor.version}-to-v${version}`);
  Reflect.set(journal, 'sourceIdentity', identities[ancestor.version]); Reflect.set(journal, 'targetIdentity', identities[version]);
  journal.snapshotId = ancestor.index.snapshotId;
  journal.historyIndexPathParts = ['governance', 'history', ancestor.index.snapshotId, 'index.json'];
  journal.historyIndexDigest = rawHistoryDigest(ancestor.content);
  journal.successor = { repositoryId: String(historyRecord(state.repository, 'repository').id), createdAt: String(state.createdAt) };
  journal.transaction.committedAt = String(state.createdAt);
  if (version === 3) state.successorHistory = {
    schemaVersion: 1, snapshotId: ancestor.index.snapshotId, historyIndexDigest: journal.historyIndexDigest,
    historyIndexPathParts: journal.historyIndexPathParts, journalPathParts: ['governance', 'migration-state.json'], sourceActiveChange: null
  };
  files[1].content = Buffer.from(JSON.stringify(state));
  files.push({ kind: 'migration', pathParts: ['governance', 'migration-state.json'], content: Buffer.from(JSON.stringify(journal)), mode: 0o600 });
  return snapshot(version, files);
}
async function setup(files: SourceFile[], ancestors: ReturnType<typeof snapshot>[] = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'c2b-original-')); roots.push(root);
  for (const file of files) await writeFixtureBytes(root, file.pathParts, file.content, file.mode);
  for (const source of ancestors) {
    await writeFixtureBytes(root, ['governance', 'history', source.index.snapshotId, 'index.json'], source.content);
    for (const entry of source.index.files) await writeFixtureBytes(root, entry.copyPathParts,
      source.files.find(file => file.pathParts.join('/') === entry.originalPathParts.join('/'))!.content);
  }
  return root;
}

describe('independent planned-original and stored-ancestor closure', () => {
  it('rejects planned index accessors before selecting the original source identity', async () => {
    const source = snapshot(3, minimal(3)), originalIdentity = source.index.sourceIdentity;
    const originals = source.files.map(({ pathParts, content, mode }) => ({ pathParts, content, mode }));
    let invoked = 0;
    Object.defineProperty(source.index, 'sourceIdentity', { enumerable: true, get() { invoked++; return originalIdentity; } });
    const outcome = await validatePlannedReleasedSourceSnapshot(source.index, originals).then(
      value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    expect(invoked).toBe(0);
    expect(outcome.error).toBeDefined();
  });

  it('captures nested planned index paths and original buffers before inventory yields', async () => {
    const source = snapshot(3, minimal(3));
    const originals = source.files.map(({ pathParts, content, mode }) => ({ pathParts, content, mode }));
    const expected = await validatePlannedReleasedSourceSnapshot(source.index, originals);
    const pending = validatePlannedReleasedSourceSnapshot(source.index, originals);
    let invoked = 0;
    const entry = source.index.files[0], originalPath = [...entry.originalPathParts];
    Object.defineProperty(entry.originalPathParts, '0', { enumerable: true, get() { invoked++; return originalPath[0]; } });
    source.files[0].content.fill(0);
    const result = await pending;
    expect(invoked).toBe(0);
    expect(result).toEqual(expected);
  });

  it.each(['reader-options', 'captured-options', 'nested-captured-options'] as const)(
    'captures %s before the first asynchronous read', async kind => {
      const root = await setup(minimal(3));
      const source = await readModernActivationSuccessorSource(root);
      const options: { reviewedUnreferencedPathParts: string[][] } = { reviewedUnreferencedPathParts: [] };
      const pending = kind === 'reader-options' ? readModernActivationSuccessorSource(root, options) :
        validateCapturedReleasedSource(source.captures, options);
      let invoked = 0;
      if (kind === 'nested-captured-options') {
        Object.defineProperty(options.reviewedUnreferencedPathParts, '0', { enumerable: true, get() { invoked++; return ['governance', 'evidence', 'absent.json']; } });
      } else Object.defineProperty(options, 'reviewedUnreferencedPathParts', { enumerable: true, get() { invoked++; return []; } });
      const outcome = await pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
      expect(invoked).toBe(0);
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toBeDefined();
  });

  it.each([false, true])('captures a new shared file-reader path before filesystem awaits (optional=%s)', async optional => {
    const root = await setup(minimal(3)), reader = await createSourceHistoryCapture(root);
    const parts = ['liftoff.manifest.json'];
    const pending = optional ? reader.capture(parts, true) : reader.capture(parts);
    let invoked = 0;
    Object.defineProperty(parts, '0', { enumerable: true, get() { invoked++; return 'liftoff.manifest.json'; } });
    const result = await pending;
    expect(invoked).toBe(0);
    expect(result.pathParts).toEqual(['liftoff.manifest.json']);
  });

  it('captures an absent-directory path before its first root observation yields', async () => {
    const root = await setup(minimal(3)), reader = await createSourceHistoryCapture(root);
    const parts = ['governance', 'history', 'a'.repeat(64)];
    const pending = reader.assertAbsentDirectory(parts);
    let invoked = 0;
    Object.defineProperty(parts, '0', { enumerable: true, get() { invoked++; return 'governance'; } });
    await expect(pending).resolves.toBeUndefined();
    expect(invoked).toBe(0);
  });

  it('bounds synchronous metadata snapshots and returns independent nested own data', () => {
    const exactString = 'x'.repeat(8 * 1024 * 1024);
    expect(copySourceHistoryData(exactString, 'metadata')).toBe(exactString);
    expect(() => copySourceHistoryData(exactString + 'x', 'metadata')).toThrow(/bounded control-metadata/);
    const nodes = new Array(199_999).fill(null);
    expect(copySourceHistoryData(nodes, 'metadata')).toEqual(nodes);
    expect(() => copySourceHistoryData([...nodes, null], 'metadata')).toThrow(/node or string size/);
    const original = { nested: { paths: [['original']] } }, copied = copySourceHistoryData(original, 'metadata');
    original.nested.paths[0][0] = 'later edit';
    expect(copied).toEqual({ nested: { paths: [['original']] } });
  });

  it.each([1, 2, 3] as const)('validates captured v%s originals without reading nonexistent planned copies', async version => {
    const files = minimal(version), source = snapshot(version, files);
    const originals = files.map(({ pathParts, content, mode }) => ({ pathParts, content, mode }));
    expect((await validatePlannedReleasedSourceSnapshot(source.index, originals)).state.identity).toEqual(identities[version]);
    await expect(validatePlannedReleasedSourceSnapshot(source.index, originals.slice(1))).rejects.toThrow(/exactly all/);
    await expect(validatePlannedReleasedSourceSnapshot(source.index, originals.map((file, i) => i ? file : { ...file, mode: 0o777 }))).rejects.toThrow(/mode/);
    const root = await setup(files), read = await readModernActivationSuccessorSource(root);
    expect(read.historyDisposition).toBe('create');
    const planned = historyRecord(parseHistoryJson(read.indexContent, 'index'), 'index');
    await expect(fs.lstat(path.join(root, 'governance', 'history', String(planned.snapshotId)))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['v3-v1', 'v3-v2', 'v3-v2-v1'] as const)('captures and validates the entire %s chain', async branch => {
    const first = snapshot(branch === 'v3-v2' ? 2 : 1, minimal(branch === 'v3-v2' ? 2 : 1));
    const middle = branch === 'v3-v2-v1' ? successor(2, first) : first;
    const top = successor(3, middle), ancestors = branch === 'v3-v2-v1' ? [first, middle] : [first];
    const root = await setup(top.files, ancestors), before = await fs.readFile(path.join(root, 'governance', 'activation-state.json'));
    const result = await readModernActivationSuccessorSource(root);
    expect(result.ancestors).toHaveLength(ancestors.length);
    expect(result.captures.filter(file => file.content && file.pathParts.at(-1) === 'index.json')).toHaveLength(ancestors.length);
    expect(await fs.readFile(path.join(root, 'governance', 'activation-state.json'))).toEqual(before);
    await fs.unlink(path.join(root, 'governance', 'history', first.index.snapshotId, 'index.json'));
    await expect(readModernActivationSuccessorSource(root)).rejects.toThrow(/missing/);
  });

  it('reuses exact noncanonical stored index bytes without normalizing history or original copy permissions', async () => {
    const source = snapshot(3, minimal(3));
    source.content = Buffer.from(JSON.stringify(source.index, null, '\t') + '\r\n');
    const root = await setup(source.files, [source]);
    const result = await readModernActivationSuccessorSource(root);
    expect(result.historyDisposition).toBe('reuse'); expect(result.indexContent).toEqual(source.content);
    const reference = { schemaVersion: 1, kind: 'activation-history', snapshotId: source.index.snapshotId, indexDigest: rawHistoryDigest(source.content) };
    expect((await readFrozenV3ActivationManifestHistory(root, reference)).source.mode).toBe(0o640);
    await expect(readFrozenActivationManifestHistory(root, reference)).rejects.toThrow(/v1 or v2/);
    await fs.appendFile(path.join(root, ...source.index.files[0].copyPathParts), 'changed');
    await expect(readModernActivationSuccessorSource(root)).rejects.toThrow(/differ/);
  });

  it('rejects original buffer/path accessors without treating copied paths or hooks as proof', () => {
    const file = minimal(3)[0], getter = () => { throw new Error('unexpected hook'); };
    const hostile = { pathParts: file.pathParts, content: file.content, mode: file.mode };
    Object.defineProperty(hostile, 'content', { enumerable: true, get: getter });
    expect(() => copySourceHistoryObservations([hostile])).toThrow(/hooks/);
    expect(() => copySourceHistoryObservations([{ pathParts: ['../escape'], content: Buffer.alloc(0), mode: 0o600 }])).toThrow();
    const buffer = Buffer.from('data');
    let invoked = false;
    Object.defineProperty(buffer, 'length', { get() { invoked = true; return 4; } });
    expect(() => copySourceHistoryObservations([{ pathParts: ['original'], content: buffer, mode: 0o640 }])).toThrow(/hooks/);
    expect(invoked).toBe(false);
  });
});

describe('real planned-preservation operational admission', () => {
  it.each([0, 1])('counts a real 8MiB original metadata file inclusively, excess=%s', async excess => {
    const files = minimal(3);
    files.push({ kind: 'metadata', pathParts: ['.liftoff', 'governance', 'policy.md'], content: Buffer.alloc(8 * 1024 * 1024 + excess, 120), mode: 0o644 });
    const root = await setup(files);
    if (excess) await expect(readModernActivationSuccessorSource(root)).rejects.toThrow(/bounded size/);
    else expect((await readModernActivationSuccessorSource(root)).captures.some(file => file.content?.length === 8 * 1024 * 1024)).toBe(true);
  }, 60_000);

  it.each([0, 1])('includes real generated index bytes at the exact 32MiB cap, excess=%s', async excess => {
    const first = snapshot(1, minimal(1)), middle = successor(2, first);
    const files = successor(3, middle).files;
    for (const parts of [
      ['.liftoff', 'governance', 'policy.md'], ['.liftoff', 'governance', 'README.md'],
      ['.github', 'prompts', 'liftoff-setup.prompt.md'], ['.claude', 'commands', 'liftoff-setup.md']
    ]) files.push({ kind: 'metadata', pathParts: parts, content: Buffer.alloc(0), mode: 0o644 });
    const emptyIndexBytes = snapshot(3, files).content.length;
    const ancestorsBytes = [first, middle].reduce((sum, source) => sum + source.content.length + source.files.reduce((bytes, file) => bytes + file.content.length, 0), 0);
    const originalBytes = files.reduce((sum, file) => sum + file.content.length, 0);
    const padding = files.filter(file => file.kind === 'metadata');
    for (const file of padding.slice(0, 3)) file.content = Buffer.alloc(8 * 1024 * 1024, 120);
    padding[3].content = Buffer.alloc(8 * 1024 * 1024 - originalBytes - emptyIndexBytes - ancestorsBytes + excess, 120);
    expect(files.reduce((sum, file) => sum + file.content.length, 0) + snapshot(3, files).content.length + ancestorsBytes).toBe(32 * 1024 * 1024 + excess);
    const root = await setup(files, [first, middle]);
    if (excess) await expect(readModernActivationSuccessorSource(root)).rejects.toThrow(/32MiB/);
    else {
      const read = await readModernActivationSuccessorSource(root);
      expect(read.ancestors).toHaveLength(2);
      expect(read.captures.reduce((sum, file) => sum + (file.content?.length ?? 0), 0) + read.indexContent.length).toBe(32 * 1024 * 1024);
    }
  }, 120_000);

  it('rejects malformed same-hash declarations rather than interpreting them as a future source', () => {
    expect(() => createReleasedSourceHistoryIndex({ ...releasedV3ActivationIdentity, activationContractVersion: 4 }, [])).toThrow();
    const source = snapshot(3, minimal(3));
    expect(rawHistoryDigest(source.content)).toBe(canonicalSha256(source.index));
    const identity = { ...releasedV3ActivationIdentity };
    let invoked = false;
    Object.defineProperty(identity, 'phaseGraphHash', { enumerable: true, get() { invoked = true; return releasedV3ActivationIdentity.phaseGraphHash; } });
    expect(() => createReleasedSourceHistoryIndex(identity, [])).toThrow(/own enumerable/);
    expect(invoked).toBe(false);
  });

  it.each([0, 1])('admits exactly1024 preserved files including the generated index, excess=%s', async excess => {
    const first = snapshot(1, minimal(1)), middle = successor(2, first), files = successor(3, middle).files;
    const proof = validateHistoricalV3EvidenceRecord(historyArray(capturedV3Records().evidence, 'evidence')[0]);
    proof.header.repositoryId = String(historyRecord(historyRecord(parseHistoryJson(files[1].content, 'state'), 'state').repository, 'repository').id);
    proof.header.producer = 'synthetic-original-format'; proof.payload = { kind: 'seed-valid.v1' };
    proof.header.bodyDigest = historicalV3EvidenceBodyDigest(proof.payload); delete proof.liveReadback;
    const reviewed: string[][] = [];
    const count = files.length + 1 + first.files.length + 1 + middle.files.length + 1;
    for (let i = 0; i < 1024 - count + excess; i++) {
      const parts = ['governance', 'evidence', `original-${i}.json`]; reviewed.push(parts);
      files.push({ kind: 'evidence', pathParts: parts, content: Buffer.from(JSON.stringify({ ...proof, evidenceId: `original-${i}` })), mode: 0o640 });
    }
    const root = await setup(files, [first, middle]), result = readModernActivationSuccessorSource(root, { reviewedUnreferencedPathParts: reviewed });
    if (excess) await expect(result).rejects.toThrow(/1024/);
    else {
      const source = await result;
      expect(source.ancestors).toHaveLength(2);
      expect(source.captures.filter(file => file.content !== undefined).length + 1).toBe(1024);
    }
  }, 120_000);
});
