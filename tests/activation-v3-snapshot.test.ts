import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { historicalV1ActivationIdentity, historicalV2ActivationIdentity, releasedV3ActivationIdentity } from '../src/domain/governance/policy/identity.js';
import {
  historyRecord, historyArray, parseHistoryJson, rawHistoryDigest, validateActivationHistoryIndex,
  validateFrozenV3SourceIndex, type HistoricalFileKind
} from '../src/governance-activation/history-contracts.js';
import {
  readFrozenActivationManifestHistory, readFrozenV3ActivationManifestHistory, type FrozenV3ActivationManifestHistory
} from '../src/governance-activation/frozen-manifest-history.js';
import { validateCapturedV3SourceSnapshot } from '../src/governance-activation/historical-state.js';
import { historicalV3EvidenceBodyDigest, validateHistoricalV3EvidenceRecord } from '../src/governance-activation/historical-v3.js';
import { capturedV3Records, capturedV3Successor, writeFixtureBytes } from './fixtures/activation-v3/fixture.js';

const roots: string[] = [];
afterEach(async () => {
  vi.doUnmock('node:fs/promises');
  vi.doUnmock('../src/domain/governance/activation/graph.js');
  vi.doUnmock('../src/domain/governance/policy/identity.js');
  vi.resetModules();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true });
});
interface Source { kind: HistoricalFileKind; parts: string[]; content: Buffer; mode: number }
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, '\t') + '\r\n');
const identities = { 1: historicalV1ActivationIdentity, 2: historicalV2ActivationIdentity, 3: releasedV3ActivationIdentity };
function minimal(version: 1 | 2 | 3): Source[] {
  const capture = capturedV3Successor(version === 1 ? 1 : 2);
  const manifest = version === 3 ? capturedV3Records().manifest : parseHistoryJson(capture.files.get('liftoff.manifest.json')!, 'manifest');
  const state = version === 3 ? historyRecord(capture.state, 'state') :
    historyRecord(parseHistoryJson(capture.files.get('governance/activation-state.json')!, 'state'), 'state');
  state.activeChange = null;
  for (const key of ['bootstrapState', 'successorHistory', 'phaseOutputs', 'taskProjection', 'activationInputs']) delete state[key];
  for (const value of Object.values(historyRecord(state.phases, 'phases'))) {
    const phase = historyRecord(value, 'phase');
    Object.assign(phase, { state: 'pending', evidence: [], approvals: [], blockers: [] });
    delete phase.operation; delete phase.executionPlanDigest;
  }
  return [
    { kind: 'manifest', parts: ['liftoff.manifest.json'], content: json(manifest), mode: 0o640 },
    { kind: 'state', parts: ['governance', 'activation-state.json'], content: json(state), mode: 0o644 }
  ];
}
function snapshot(version: 1 | 2 | 3, files: Source[]) {
  const originals = files.map(file => ({ kind: file.kind, originalPathParts: file.parts, digest: rawHistoryDigest(file.content), mode: file.mode }))
    .sort((a, b) => a.originalPathParts.join('/') < b.originalPathParts.join('/') ? -1 : 1);
  const snapshotId = canonicalSha256({ schemaVersion: 1, sourceIdentity: identities[version], files: originals });
  const index = { schemaVersion: 1, snapshotId, sourceIdentity: identities[version], files: originals.map(file => ({
    ...file, copyPathParts: ['governance', 'history', snapshotId, 'files', ...file.originalPathParts]
  })) };
  const bytes = json(index);
  return { version, files, index, bytes, reference: { schemaVersion: 1, kind: 'activation-history', snapshotId, indexDigest: rawHistoryDigest(bytes) } };
}
type Snapshot = ReturnType<typeof snapshot>;
function linked(version: 2 | 3, source: Snapshot, files = minimal(version)) {
  const stateFile = files.find(file => file.kind === 'state')!, state = historyRecord(parseHistoryJson(stateFile.content, 'state'), 'state');
  const journal = historyRecord(structuredClone(capturedV3Successor(1).journal), 'journal');
  Object.assign(journal, {
    laneId: `activation-v${source.version}-to-v${version}`, sourceIdentity: identities[source.version],
    targetIdentity: identities[version], snapshotId: source.index.snapshotId,
    historyIndexDigest: source.reference.indexDigest, historyIndexPathParts: ['governance', 'history', source.index.snapshotId, 'index.json'],
    successor: { repositoryId: historyRecord(state.repository, 'repository').id, createdAt: state.createdAt },
    transaction: { status: 'committed', committedAt: state.createdAt }
  });
  if (version === 3) state.successorHistory = {
    schemaVersion: 1, snapshotId: source.index.snapshotId, historyIndexDigest: source.reference.indexDigest,
    historyIndexPathParts: journal.historyIndexPathParts, journalPathParts: ['governance', 'migration-state.json'],
    sourceActiveChange: historyRecord(parseHistoryJson(source.files.find(file => file.kind === 'state')!.content, 'state'), 'state').activeChange
  };
  stateFile.content = json(state);
  const existing = files.find(file => file.kind === 'migration');
  if (existing) existing.content = json(journal);
  else files.push({ kind: 'migration', parts: ['governance', 'migration-state.json'], content: json(journal), mode: 0o600 });
  return snapshot(version, files);
}
async function install(snapshots: Snapshot[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'v3-stored-')); roots.push(root);
  for (const source of snapshots) {
    await writeFixtureBytes(root, ['governance', 'history', source.index.snapshotId, 'index.json'], source.bytes);
    for (const entry of source.index.files) {
      await writeFixtureBytes(root, entry.copyPathParts, source.files.find(file => file.parts.join('/') === entry.originalPathParts.join('/'))!.content);
    }
  }
  return root;
}
function rebuildChain(files: Source[][]) {
  const one = snapshot(1, files[0]), two = linked(2, one, files[1]), three = linked(3, two, files[2]);
  return [one, two, three];
}
function chain() { return rebuildChain([minimal(1), minimal(2), minimal(3)]); }
function appendPadding(source: Snapshot, name: string, bytes: number) {
  source.files.push({ kind: 'metadata', parts: ['.liftoff', 'governance', name], content: Buffer.alloc(bytes, 120), mode: 0o644 });
}
function byteCount(snapshots: Snapshot[]) {
  return snapshots.reduce((sum, item) => sum + item.bytes.length + item.files.reduce((size, file) => size + file.content.length, 0), 0);
}

describe('new stored v3 preservation combination, not a released snapshot writer', () => {
  it.each([{ versions: [] }, { versions: [1] }, { versions: [2] }, { versions: [1, 2] }] as const)(
    'verifies complete ancestry $versions with independent physical observations', async ({ versions }) => {
    let sources: Snapshot[] = [];
    for (const version of [...versions, 3] as const) {
      sources.push(sources.length ? linked(version as 2 | 3, sources.at(-1)!) : snapshot(version, minimal(version)));
    }
    const root = await install(sources), top = sources.at(-1)!;
    const result = await readFrozenV3ActivationManifestHistory(root, top.reference);
    expectTypeOf(result).toEqualTypeOf<FrozenV3ActivationManifestHistory>();
    expectTypeOf(result.sourceIdentity).toEqualTypeOf<typeof releasedV3ActivationIdentity>();
    expect(result.captures.filter(file => file.pathParts.at(-1) === 'index.json')).toHaveLength(sources.length);
    expect(result.source).toEqual({ artifactVersion: 7, digest: rawHistoryDigest(top.files[0].content), bytes: top.files[0].content.length, mode: 0o640 });
    expect(result.captures.every(file => file.mode === 0o600)).toBe(true);
    for (const source of sources) for (const file of source.index.files) {
      expect(result.captures.find(copy => copy.pathParts.join('/') === file.copyPathParts.join('/'))?.content)
        .toEqual(source.files.find(original => original.parts.join('/') === file.originalPathParts.join('/'))!.content);
    }
    expect(() => validateActivationHistoryIndex(top.index)).toThrow(/historical/);
    await expect(readFrozenActivationManifestHistory(root, top.reference)).rejects.toThrow(/v1 or v2/);
    if (sources.length === 3) expect((await readFrozenActivationManifestHistory(root, sources[1].reference)).captures
      .filter(file => file.pathParts.at(-1) === 'index.json')).toHaveLength(2);
  });

  it('requires v3 at the root and validates captured copy closure', async () => {
    const old = snapshot(2, minimal(2)), root = await install([old]);
    await expect(readFrozenV3ActivationManifestHistory(root, old.reference)).rejects.toThrow(/exact frozen v3/);
    const source = snapshot(3, minimal(3)), index = validateFrozenV3SourceIndex(source.index);
    await expect(validateCapturedV3SourceSnapshot(index, [])).rejects.toThrow(/every indexed copy/);
    const copies = index.files.map(entry => ({ pathParts: entry.copyPathParts, mode: 0o600,
      content: source.files.find(file => file.parts.join('/') === entry.originalPathParts.join('/'))!.content }));
    await expect(validateCapturedV3SourceSnapshot(index, [...copies, copies[0]])).rejects.toThrow(/unique complete/);
    expect((await validateCapturedV3SourceSnapshot(index, copies)).state.schemaVersion).toBe(3);
  });

  it.each(Object.keys(releasedV3ActivationIdentity))('rejects a mixed or future indexed %s', field => {
    const source = snapshot(3, minimal(3)), identity = { ...source.index.sourceIdentity };
    Reflect.set(identity, field, typeof Reflect.get(identity, field) === 'number' ? 99 : 'future');
    expect(() => validateFrozenV3SourceIndex({ ...source.index, sourceIdentity: identity })).toThrow(/exact frozen v3/);
  });

  it('refuses linked roots and multiply-linked original copies on the real filesystem', async () => {
    const sources = chain(), root = await install(sources), top = sources[2];
    const alias = path.join(root, 'linked-root');
    await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readFrozenV3ActivationManifestHistory(alias, top.reference)).rejects.toThrow(/real nonlink/);
    await fs.unlink(alias);
    const copy = path.join(root, ...sources[0].index.files[0].copyPathParts);
    await fs.link(copy, path.join(root, 'second-link'));
    await expect(readFrozenV3ActivationManifestHistory(root, top.reference)).rejects.toThrow(/link/);
  });

  it.each(['missing-index', 'copy', 'index', 'lane', 'source', 'target', 'anchor', 'time', 'backlink', 'source-pointer', 'complete'] as const)(
    'rejects %s corruption without mutable successor fallback', async corruption => {
      let sources = chain(), top = sources[2];
      if (!['missing-index', 'copy', 'index'].includes(corruption)) {
        const journalFile = top.files.find(file => file.kind === 'migration')!, journal = historyRecord(parseHistoryJson(journalFile.content, 'journal'), 'journal');
        const stateFile = top.files.find(file => file.kind === 'state')!, state = historyRecord(parseHistoryJson(stateFile.content, 'state'), 'state');
        if (corruption === 'lane') journal.laneId = 'activation-v3-to-v4';
        if (corruption === 'source') journal.sourceIdentity = releasedV3ActivationIdentity;
        if (corruption === 'target') journal.targetIdentity = historicalV2ActivationIdentity;
        if (corruption === 'anchor') historyRecord(journal.successor, 'successor').repositoryId = 'different';
        if (corruption === 'time') historyRecord(journal.successor, 'successor').createdAt = '2020-01-01T00:00:00.000Z';
        if (corruption === 'backlink') historyRecord(state.successorHistory, 'history').historyIndexDigest = 'f'.repeat(64);
        if (corruption === 'source-pointer') historyRecord(state.successorHistory, 'history').sourceActiveChange = { id: 'other', kind: 'openspec' };
        if (corruption === 'complete') {
          const progress = historyRecord(journal.revalidation, 'progress');
          const first = historyRecord(historyArray(progress.phases, 'phases')[0], 'phase');
          first.status = 'complete'; first.evidenceIds = ['absent-original-proof'];
        }
        journalFile.content = json(journal); stateFile.content = json(state); top = snapshot(3, top.files); sources[2] = top;
      }
      const root = await install(sources);
      await writeFixtureBytes(root, ['liftoff.manifest.json'], 'not a fallback');
      if (corruption === 'missing-index') await fs.unlink(path.join(root, 'governance', 'history', sources[0].index.snapshotId, 'index.json'));
      if (corruption === 'copy') await fs.appendFile(path.join(root, ...sources[0].index.files[0].copyPathParts), 'x');
      if (corruption === 'index') await fs.appendFile(path.join(root, 'governance', 'history', sources[1].index.snapshotId, 'index.json'), ' ');
      await expect(readFrozenV3ActivationManifestHistory(root, top.reference)).rejects.toThrow();
      expect(await fs.readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')).toBe('not a fallback');
    }
  );

  it('reads only registered stored files with no writes and no shared mutable buffers', async () => {
    const sources = chain(), top = sources[2], root = await install(sources);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const opened: string[] = [], effect = vi.fn(() => { throw new Error('unexpected effect'); });
    vi.doMock('node:fs/promises', () => ({ ...actual,
      open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
        opened.push(String(args[0])); expect(String(args[0])).toContain('/governance/history/');
        return actual.open(...args);
      }), writeFile: effect, mkdir: effect, unlink: effect, rm: effect, chmod: effect
    }));
    vi.resetModules();
    const isolated = await import('../src/governance-activation/frozen-manifest-history.js');
    const result = await isolated.readFrozenV3ActivationManifestHistory(root, top.reference);
    expect(opened).toHaveLength(result.captures.length);
    expect(new Set(opened).size).toBe(opened.length);
    expect(effect).not.toHaveBeenCalled();
    result.captures[0].content!.fill(0);
    expect((await isolated.readFrozenV3ActivationManifestHistory(root, top.reference)).captures[0].content).toEqual(top.bytes);
  });

  it('ignores poisoned mutable current identity and graph constants', async () => {
    const source = snapshot(3, minimal(3)), root = await install([source]);
    const graph = await vi.importActual<typeof import('../src/domain/governance/activation/graph.js')>('../src/domain/governance/activation/graph.js');
    vi.doMock('../src/domain/governance/activation/graph.js', () => ({
      ...graph, currentActivationIdentity: { ...graph.currentActivationIdentity, activationContractVersion: 99 },
      canonicalPhaseGraphHash: 'f'.repeat(64)
    }));
    vi.resetModules();
    const isolated = await import('../src/governance-activation/frozen-manifest-history.js');
    expect((await isolated.readFrozenV3ActivationManifestHistory(root, source.reference)).sourceIdentity).toEqual(releasedV3ActivationIdentity);
  });

  it('keeps original inconsistent A1 readback negative', async () => {
    const source = snapshot(3, minimal(3)), record = historyArray(capturedV3Records().evidence, 'evidence')[1];
    source.files.push({ kind: 'evidence', parts: ['governance', 'evidence', 'original.json'], content: json(record), mode: 0o600 });
    const bad = snapshot(3, source.files), root = await install([bad]);
    await expect(readFrozenV3ActivationManifestHistory(root, bad.reference)).rejects.toThrow(/original reviewed transition/);
  });

  it('preserves v1 metadata stored by v2 and inherited by v3 without inventing old snapshot roles', async () => {
    const sources = chain(), change = { id: 'inherited-original', kind: 'openspec' };
    const metadata = historyRecord(capturedV3Records().metadata, 'metadata');
    const firstState = historyRecord(parseHistoryJson(sources[0].files[1].content, 'state'), 'state');
    Object.assign(metadata, { changeId: change.id, workflowKind: change.kind,
      activationIdentity: historicalV1ActivationIdentity, phaseGraphHash: historicalV1ActivationIdentity.phaseGraphHash });
    metadata.phaseTaskMapping = historyArray(metadata.phaseTaskMapping, 'mappings').filter(value =>
      Object.hasOwn(historyRecord(firstState.phases, 'phases'), String(historyRecord(value, 'mapping').phaseId)));
    historyRecord(metadata.createdFrom, 'createdFrom').evidenceIds = [];
    for (const source of sources) {
      const state = historyRecord(parseHistoryJson(source.files[1].content, 'state'), 'state');
      state.activeChange = change; source.files[1].content = json(state);
      // The released v1-to-v2 snapshot had no source metadata/task roles.
      if (source.version === 1) continue;
      source.files.push(
        { kind: 'source-metadata', parts: ['openspec', 'changes', change.id, 'liftoff-governance.json'], content: json(metadata), mode: 0o640 },
        { kind: 'source-tasks', parts: ['openspec', 'changes', change.id, 'tasks.md'], content: Buffer.alloc(0), mode: 0o644 }
      );
    }
    const rebuilt = rebuildChain(sources.map(source => source.files)), root = await install(rebuilt);
    const result = await readFrozenV3ActivationManifestHistory(root, rebuilt[2].reference);
    expect(result.captures.filter(file => file.pathParts.at(-1) === 'liftoff-governance.json')).toHaveLength(2);
    const top = rebuilt[2].files.find(file => file.kind === 'source-metadata')!;
    const tampered = historyRecord(parseHistoryJson(top.content, 'metadata'), 'metadata');
    tampered.owner = 'rewritten'; top.content = json(tampered);
    const changed = snapshot(3, rebuilt[2].files), badRoot = await install([rebuilt[0], rebuilt[1], changed]);
    await expect(readFrozenV3ActivationManifestHistory(badRoot, changed.reference)).rejects.toThrow(/ancestor metadata/);
  });
});

describe('real whole three-source operational ceilings', () => {
  it.each([0, 1])('checks exact8MiB per file across the chain, excess=%s', async excess => {
    const sources = chain(); appendPadding(sources[1], 'policy.md', 8 * 1024 * 1024 + excess);
    const rebuilt = rebuildChain(sources.map(source => source.files)), root = await install(rebuilt);
    const result = readFrozenV3ActivationManifestHistory(root, rebuilt[2].reference);
    if (excess) await expect(result).rejects.toThrow(/bounded size/);
    else expect((await result).captures.some(file => file.content!.length === 8 * 1024 * 1024)).toBe(true);
  }, 60_000);

  it.each([0, 1])('checks exact32MiB including all3 indices and empty files, excess=%s', async excess => {
    const sources = chain();
    appendPadding(sources[0], 'policy.md', 0); appendPadding(sources[1], 'policy.md', 0);
    appendPadding(sources[2], 'policy.md', 0); appendPadding(sources[2], 'README.md', 0);
    appendPadding(sources[0], 'README.md', 0);
    const before = rebuildChain(sources.map(source => source.files)), overhead = byteCount(before);
    for (const source of sources) source.files.find(file => file.parts.at(-1) === 'policy.md')!.content = Buffer.alloc(8 * 1024 * 1024, 120);
    sources[2].files.find(file => file.parts.at(-1) === 'README.md')!.content = Buffer.alloc(8 * 1024 * 1024 - overhead + excess, 120);
    const rebuilt = rebuildChain(sources.map(source => source.files));
    expect(byteCount(rebuilt)).toBe(32 * 1024 * 1024 + excess);
    const root = await install(rebuilt), result = readFrozenV3ActivationManifestHistory(root, rebuilt[2].reference);
    if (excess) await expect(result).rejects.toThrow(/raw bytes|bounded size/);
    else {
      const captured = await result;
      expect(captured.captures.reduce((sum, file) => sum + file.content!.length, 0)).toBe(32 * 1024 * 1024);
      expect(captured.captures.some(file => file.content!.length === 0)).toBe(true);
    }
  }, 120_000);

  it.each([0, 1])('checks exact1024 actual captures across3 sources, excess=%s', async excess => {
    const sources = chain();
    const base = validateHistoricalV3EvidenceRecord(historyArray(capturedV3Records().evidence, 'evidence')[0]);
    base.header.producer = 'synthetic-original-observation';
    base.header.repositoryId = String(historyRecord(historyRecord(parseHistoryJson(sources[2].files[1].content, 'state'), 'state').repository, 'repository').id);
    base.payload = { kind: 'seed-valid.v1' };
    base.header.bodyDigest = historicalV3EvidenceBodyDigest(base.payload);
    const existing = sources.reduce((sum, source) => sum + source.files.length + 1, 0);
    for (let i = existing; i < 1024 + excess; i++) sources[2].files.push({
      kind: 'evidence', parts: ['governance', 'evidence', `observation-${i}.json`],
      content: json({ ...base, evidenceId: `observation-${i}` }), mode: 0o640
    });
    const rebuilt = rebuildChain(sources.map(source => source.files)), root = await install(rebuilt);
    const result = readFrozenV3ActivationManifestHistory(root, rebuilt[2].reference);
    if (excess) await expect(result).rejects.toThrow(/1024/);
    else expect((await result).captures).toHaveLength(1024);
  }, 120_000);
});
