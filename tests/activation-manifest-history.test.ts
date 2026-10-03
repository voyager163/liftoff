import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  readFrozenActivationManifestHistory, assertFrozenActivationManifestSource,
  type FrozenActivationManifestHistory
} from '../src/governance-activation/frozen-manifest-history.js';
import {
  activationHistorySnapshotId, activationHistoryCopyPathParts, validateActivationHistoryIndex,
  validateFrozenActivationHistoryIndex, rawHistoryDigest, parseHistoryJson, historyRecord, historyArray,
  type HistoricalFileKind
} from '../src/governance-activation/history-contracts.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { historicalV1PhaseContractDigests } from '../src/governance-activation/historical-v1-phase-contracts.js';
import { historicalV1ActivationIdentity, historicalV2ActivationIdentity, releasedV3ActivationIdentity } from '../src/domain/governance/policy/identity.js';
import { readHistoricalSnapshotInventory } from '../src/governance-activation/historical-state.js';
import type { ManifestHistorySource } from '../src/domain/project/manifest/history.js';
import type { ProjectFileSnapshot } from '../src/adapters/filesystem/project-transaction.js';
import { capturedV3Successor, writeFixtureBytes } from './fixtures/activation-v3/fixture.js';

const roots: string[] = [];
afterEach(async () => {
  vi.doUnmock('node:fs/promises');
  vi.doUnmock('../src/domain/governance/policy/identity.js');
  vi.doUnmock('../src/domain/governance/activation/graph.js');
  vi.resetModules();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function newRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r4-origin-'));
  roots.push(root);
  return root;
}
interface Source {
  kind: HistoricalFileKind;
  parts: string[];
  content: Buffer;
  mode: number;
}
function minimal(family: 1 | 2 = 1): Source[] {
  const captured = capturedV3Successor(family);
  const state = historyRecord(parseHistoryJson(captured.files.get('governance/activation-state.json')!, 'state'), 'state');
  delete state.bootstrapState;
  state.activeChange = null;
  for (const phase of Object.values(historyRecord(state.phases, 'phases'))) {
    Object.assign(historyRecord(phase, 'phase'), { state: 'pending', evidence: [], approvals: [], blockers: [] });
  }
  return [
    { kind: 'manifest', parts: ['liftoff.manifest.json'], content: captured.files.get('liftoff.manifest.json')!, mode: 0o640 },
    { kind: 'state', parts: ['governance', 'activation-state.json'], content: Buffer.from(JSON.stringify(state, null, '\t') + '\r\n'), mode: 0o644 }
  ];
}
function snapshot(files: Source[], family: 1 | 2 = 1) {
  const identity = family === 1 ? historicalV1ActivationIdentity : historicalV2ActivationIdentity;
  const originals = files.map(file => ({ kind: file.kind, originalPathParts: file.parts, digest: rawHistoryDigest(file.content), mode: file.mode }));
  const snapshotId = activationHistorySnapshotId(identity, originals);
  const index = validateActivationHistoryIndex({
    schemaVersion: 1, snapshotId, sourceIdentity: identity,
    files: originals.map(file => ({ ...file, copyPathParts: activationHistoryCopyPathParts(snapshotId, file.originalPathParts) }))
  });
  const indexContent = Buffer.from(JSON.stringify(index, null, '\t') + '\r\n');
  return {
    index, indexContent, files,
    reference: { schemaVersion: 1 as const, kind: 'activation-history' as const, snapshotId, indexDigest: rawHistoryDigest(indexContent) }
  };
}
async function install(root: string, source: ReturnType<typeof snapshot>, copyMode = 0o600) {
  await writeFixtureBytes(root, ['governance', 'history', source.index.snapshotId, 'index.json'], source.indexContent, copyMode);
  for (const file of source.index.files) {
    const original = source.files.find(entry => entry.parts.join('/') === file.originalPathParts.join('/'))!;
    await writeFixtureBytes(root, file.copyPathParts, original.content, copyMode);
  }
}
async function fixture(files = minimal(), family: 1 | 2 = 1) {
  const root = await newRoot(), source = snapshot(files, family);
  await install(root, source);
  return { root, ...source };
}
function sourceDescriptor(source: ReturnType<typeof snapshot>): ManifestHistorySource {
  const manifest = source.files.find(file => file.kind === 'manifest')!;
  return { artifactVersion: 7, digest: rawHistoryDigest(manifest.content), bytes: manifest.content.length, mode: manifest.mode };
}
async function rawFiles(root: string) {
  const values: Record<string, { sha256: string; mode: number }> = {};
  async function walk(parts: string[]) {
    for (const entry of await fs.readdir(path.join(root, ...parts), { withFileTypes: true })) {
      const next = [...parts, entry.name];
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) values[next.join('/')] = {
        sha256: rawHistoryDigest(await fs.readFile(path.join(root, ...next))), mode: (await fs.lstat(path.join(root, ...next))).mode & 0o7777
      };
    }
  }
  await walk([]);
  return values;
}

describe('permanent original activation manifest references', () => {
  it.each([1, 2] as const)('reads only stored v%s originals, with physical paths/modes independent of semantic fields', async family => {
    const project = await fixture(minimal(family), family);
    const before = await rawFiles(project.root);
    const read = await readFrozenActivationManifestHistory(project.root, project.reference);
    expectTypeOf(read).toEqualTypeOf<FrozenActivationManifestHistory>();
    expectTypeOf(read.source).toEqualTypeOf<ManifestHistorySource>();
    expectTypeOf(read.captures).toEqualTypeOf<readonly ProjectFileSnapshot[]>();
    expect(read.reference).toEqual(project.reference);
    expect(read.source).toEqual(sourceDescriptor(project));
    expect(read.sourceIdentity).toEqual(project.index.sourceIdentity);
    expect(read.captures).toHaveLength(project.files.length + 1);
    expect(read.captures.every(file => file.pathParts.slice(0, 3).join('/') === `governance/history/${project.index.snapshotId}`)).toBe(true);
    for (const file of read.captures) {
      expect(file.mode).toBe((await fs.lstat(path.join(project.root, ...file.pathParts))).mode & 0o7777);
    }
    expect(read.source.mode).toBe(0o640);
    const storedManifest = read.captures.find(file => file.pathParts.join('/') === read.manifestCopyPathParts.join('/'))!;
    expect(storedManifest.content).toEqual(project.files[0].content);
    expect(read.captures[0].content).toEqual(project.indexContent);
    expect(rawHistoryDigest(project.indexContent)).not.toBe(canonicalSha256(project.index));
    assertFrozenActivationManifestSource(read, sourceDescriptor(project));
    expect(await rawFiles(project.root)).toEqual(before);
  });

  it('never opens live current files, executes effects or mints a replacement origin', async () => {
    const project = await fixture();
    await writeFixtureBytes(project.root, ['liftoff.manifest.json'], '{"artifactVersion":999}');
    await writeFixtureBytes(project.root, ['governance', 'activation-state.json'], 'invalid current state');
    await writeFixtureBytes(project.root, ['governance', 'migration-state.json'], 'invalid current journal');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const opened: string[] = [];
    const forbidden = vi.fn(() => { throw new Error('Unexpected effect'); });
    vi.doMock('node:fs/promises', () => ({
      ...actual, open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
        const name = String(args[0]); opened.push(name);
        expect(name).toContain(`/governance/history/${project.index.snapshotId}/`);
        return actual.open(...args);
      }), writeFile: forbidden, mkdir: forbidden, chmod: forbidden, unlink: forbidden, rm: forbidden
    }));
    vi.resetModules();
    const isolated = await import('../src/governance-activation/frozen-manifest-history.js');
    const result = await isolated.readFrozenActivationManifestHistory(project.root, project.reference);
    expect(opened).toHaveLength(project.files.length + 1);
    expect(new Set(opened).size).toBe(opened.length);
    expect(result.reference).toEqual(project.reference);
    expect(forbidden).not.toHaveBeenCalled();
    vi.doUnmock('node:fs/promises'); vi.resetModules();
    for (const file of ['liftoff.manifest.json', 'governance/activation-state.json', 'governance/migration-state.json']) await fs.unlink(path.join(project.root, file));
    expect((await readFrozenActivationManifestHistory(project.root, project.reference)).reference).toEqual(result.reference);
  });

  it('returns independent owned buffers across captures and calls', async () => {
    const project = await fixture();
    const first = await readFrozenActivationManifestHistory(project.root, project.reference);
    const second = await readFrozenActivationManifestHistory(project.root, project.reference);
    const untouched = Buffer.from(second.captures[0].content!);
    first.captures[0].content!.fill(0);
    expect(second.captures[0].content).toEqual(untouched);
    expect(first.captures[1].content).toEqual(second.captures[1].content);
    expect((await readFrozenActivationManifestHistory(project.root, project.reference)).captures[0].content).toEqual(untouched);
  });

  it.each(['retained', 'disposed'] as const)('preserves original %s lifecycle bytes and due times without opening state or keys', async status => {
    const files = minimal();
    const state = historyRecord(parseHistoryJson(files[1].content, 'state'), 'state');
    const source = capturedV3Successor(1);
    const original = source.index.files.find(file => file.kind === 'evidence')!;
    const wrapped = historyRecord(parseHistoryJson(source.files.get(original.originalPathParts.join('/'))!, 'evidence'), 'evidence');
    const header = historyRecord(wrapped.header ?? wrapped, 'header');
    const proofs = (status === 'disposed' ? ['remote-import-verified', 'bootstrap-state-disposed'] : ['remote-import-verified']) as
      ('remote-import-verified' | 'bootstrap-state-disposed')[];
    for (const phaseId of proofs) {
      const proof = {
        ...header, phaseId, phaseContractDigest: historicalV1PhaseContractDigests[phaseId],
        transition: { ...historyRecord(header.transition, 'transition'), phaseId },
        producer: 'original-lifecycle', result: phaseId === 'remote-import-verified' ? 'verified' : 'disposed'
      };
      files.push({
        kind: 'evidence', parts: ['governance', 'evidence', `${phaseId}.json`],
        content: Buffer.from(JSON.stringify({ evidenceId: phaseId, header: proof })), mode: 0o600
      });
      Object.assign(historyRecord(historyRecord(state.phases, 'phases')[phaseId], 'phase'), {
        state: proof.result, evidence: [{ phaseId, evidenceId: phaseId, headerDigest: canonicalSha256(proof), result: proof.result }]
      });
    }
    const importProof = historyRecord(JSON.parse(files.find(file => file.parts.at(-1) === 'remote-import-verified.json')!.content.toString('utf8')), 'proof');
    const retention = {
      status, remoteImportEvidenceId: 'remote-import-verified', remoteImportEvidenceDigest: canonicalSha256(importProof.header),
      retainedAt: '2026-08-01T00:00:00.000Z', disposeAfter: '2026-08-31T00:00:00.000Z',
      encryptedStatePathParts: [['private', 'protected-state.enc']], encryptionKeyPathParts: [['private', 'protected-key']],
      ...(status === 'disposed' ? { disposedAt: '2026-09-01T00:00:00.000Z', deletionEvidenceId: 'bootstrap-state-disposed' } : {})
    };
    state.bootstrapState = retention;
    historyRecord(state.applicability, 'applicability').statePath = 'bootstrap-local';
    files[1].content = Buffer.from(JSON.stringify(state, null, '\t').replace(/\n/g, '\r\n'));
    const project = await fixture(files);
    const result = await readFrozenActivationManifestHistory(project.root, project.reference);
    const capturedState = result.captures.find(file => file.pathParts.at(-1) === 'activation-state.json')!;
    expect(capturedState.content).toEqual(files[1].content);
    expect(historyRecord(parseHistoryJson(capturedState.content!, 'state'), 'state').bootstrapState).toEqual(retention);
    expect(result.captures.some(file => file.pathParts.includes('private'))).toBe(false);
  });

  it.each(['artifactVersion', 'digest', 'bytes', 'mode'] as const)('compares exact expected original %s only when requested', async field => {
    const project = await fixture(), read = await readFrozenActivationManifestHistory(project.root, project.reference);
    const changed = { ...read.source, [field]: field === 'artifactVersion' ? 6 : field === 'digest' ? '0'.repeat(64) : field === 'bytes' ? read.source.bytes + 1 : 0o644 };
    expect(() => assertFrozenActivationManifestSource(read, changed)).toThrow(/exact original/);
    expect(read.reference).toEqual(project.reference);
  });

  it('preserves legacy negative-zero index mode acceptance but rejects new source-descriptor admission', async () => {
    const files = minimal(); files[0].mode = -0;
    const project = snapshot(files);
    const json = project.indexContent.toString('utf8').replace(/"mode": 0\b/, '"mode": -0');
    const parsed = validateActivationHistoryIndex(JSON.parse(json));
    expect(Object.is(parsed.files[0].mode, -0)).toBe(true);
    expect(Object.is(validateFrozenActivationHistoryIndex(JSON.parse(json)).files[0].mode, -0)).toBe(true);
    project.indexContent = Buffer.from(json); project.reference.indexDigest = rawHistoryDigest(project.indexContent);
    const root = await newRoot(); await install(root, project);
    await expect(readFrozenActivationManifestHistory(root, project.reference)).rejects.toThrow(/source.mode/);
  });
});

describe('frozen origin rejection boundaries', () => {
  it.each(['index', 'copy', 'missing', 'source-v3', 'path', 'duplicate-json'] as const)('blocks corrupt %s without fallback or writes', async kind => {
    const project = await fixture();
    const indexPath = ['governance', 'history', project.index.snapshotId, 'index.json'];
    if (kind === 'copy') await writeFixtureBytes(project.root, project.index.files[0].copyPathParts, 'changed bytes');
    else if (kind === 'missing') await fs.unlink(path.join(project.root, ...project.index.files[0].copyPathParts));
    else {
      let raw = structuredClone(project.index);
      if (kind === 'source-v3') Reflect.set(raw, 'sourceIdentity', releasedV3ActivationIdentity);
      if (kind === 'path') raw.files[0].copyPathParts = ['governance', '..', 'elsewhere'];
      const content = Buffer.from(kind === 'duplicate-json' ? '{"schemaVersion":1,"schemaVersion":1}' : JSON.stringify(raw));
      await writeFixtureBytes(project.root, indexPath, content);
      if (kind !== 'index') project.reference.indexDigest = rawHistoryDigest(content);
    }
    const before = await rawFiles(project.root);
    await expect(readFrozenActivationManifestHistory(project.root, project.reference)).rejects.toThrow();
    expect(await rawFiles(project.root)).toEqual(before);
    await expect(fs.lstat(path.join(project.root, '.liftoff', 'manifest-history'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects invalid/accessor references before touching root or invoking hooks', async () => {
    const getter = vi.fn(() => 'activation-history'), coercion = vi.fn(() => 'value');
    const ref = { schemaVersion: 1, snapshotId: '0'.repeat(64), indexDigest: '0'.repeat(64) };
    Object.defineProperty(ref, 'kind', { get: getter, enumerable: true });
    await expect(readFrozenActivationManifestHistory('/nonexistent-root', ref)).rejects.toThrow(/data field/);
    await expect(readFrozenActivationManifestHistory('/nonexistent-root', { valueOf: coercion, toString: coercion })).rejects.toThrow();
    await expect(readFrozenActivationManifestHistory('/nonexistent-root', {
      schemaVersion: 1, kind: 'manifest-history', snapshotId: '0'.repeat(64), indexDigest: '0'.repeat(64)
    })).rejects.toThrow(/requires an activation-history/);
    expect(getter).not.toHaveBeenCalled(); expect(coercion).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('rejects POSIX linked roots and linked/hardlinked/aliased copies', async () => {
    const project = await fixture(), parent = await newRoot();
    const link = path.join(parent, 'linked-root');
    await fs.symlink(project.root, link);
    await expect(readFrozenActivationManifestHistory(link, project.reference)).rejects.toMatchObject({ code: 'unsafe-history-path' });
    const copy = path.join(project.root, ...project.index.files[0].copyPathParts);
    await fs.rename(copy, `${copy}.original`);
    await fs.symlink(`${copy}.original`, copy);
    await expect(readFrozenActivationManifestHistory(project.root, project.reference)).rejects.toThrow(/symlink|junction/);
    await fs.unlink(copy);
    await fs.link(`${copy}.original`, copy);
    await expect(readFrozenActivationManifestHistory(project.root, project.reference)).rejects.toThrow(/hard-linked/);
    await fs.unlink(copy); await fs.rename(`${copy}.original`, copy);
    await fs.rename(copy, copy.replace('liftoff.manifest.json', 'Liftoff.manifest.json'));
    await expect(readFrozenActivationManifestHistory(project.root, project.reference)).rejects.toThrow(/collision/);
  });

  it('rejects noncanonical root syntax and observes actual canonical root consistently', async () => {
    const project = await fixture();
    await expect(readFrozenActivationManifestHistory('relative', project.reference)).rejects.toMatchObject({ code: 'unsafe-history-path' });
    await expect(readFrozenActivationManifestHistory(`${project.root}/../bad`, project.reference)).rejects.toMatchObject({ code: 'unsafe-history-path' });
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let calls = 0;
    vi.doMock('node:fs/promises', () => ({ ...actual, realpath: vi.fn(async (...args: Parameters<typeof actual.realpath>) => {
      const result = await actual.realpath(...args); return ++calls > 2 ? `${result}-changed` : result;
    }) }));
    vi.resetModules();
    const isolated = await import('../src/governance-activation/frozen-manifest-history.js');
    await expect(isolated.readFrozenActivationManifestHistory(project.root, project.reference)).rejects.toMatchObject({ code: 'historical-source-changed' });
  });

  it.skipIf(process.platform === 'win32')('propagates denied reads and refuses a POSIX dangling link as successful absence', async () => {
    const project = await fixture();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const denial = Object.assign(new Error('denied'), { code: 'EACCES' });
    vi.doMock('node:fs/promises', () => ({ ...actual, open: vi.fn().mockRejectedValue(denial) }));
    vi.resetModules();
    const isolated = await import('../src/governance-activation/frozen-manifest-history.js');
    await expect(isolated.readFrozenActivationManifestHistory(project.root, project.reference)).rejects.toBe(denial);
    vi.doUnmock('node:fs/promises'); vi.resetModules();
    const file = path.join(project.root, ...project.index.files[0].copyPathParts);
    await fs.unlink(file); await fs.symlink('missing-neighbor', file);
    await expect(readFrozenActivationManifestHistory(project.root, project.reference)).rejects.toMatchObject({ code: 'invalid-frozen-history-file' });
  });

  it('refuses actual file growth during the bounded read', async () => {
    const project = await fixture();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let changed = false;
    vi.doMock('node:fs/promises', () => ({ ...actual, open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!changed) {
        changed = true;
        const read = handle.read.bind(handle);
        handle.read = async (...readArgs: Parameters<typeof handle.read>) => {
          await actual.appendFile(String(args[0]), ' ');
          return Reflect.apply(read, handle, readArgs);
        };
      }
      return handle;
    }) }));
    vi.resetModules();
    const isolated = await import('../src/governance-activation/frozen-manifest-history.js');
    await expect(isolated.readFrozenActivationManifestHistory(project.root, project.reference)).rejects.toThrow(/changed while reading/);
  });

  it('ignores changed ambient current identities and graph schemas for exact stored v1/v2 sources', async () => {
    const project = await fixture(minimal(2), 2);
    const identities = await vi.importActual<typeof import('../src/domain/governance/policy/identity.js')>('../src/domain/governance/policy/identity.js');
    const graph = await vi.importActual<typeof import('../src/domain/governance/activation/graph.js')>('../src/domain/governance/activation/graph.js');
    vi.doMock('../src/domain/governance/policy/identity.js', () => ({
      ...identities, liftoffManifestArtifactVersion: 99, phaseGraphSchemaVersion: 99, activationStateSchemaVersion: 99,
      historicalActivationIdentities: [...identities.historicalActivationIdentities, identities.releasedV3ActivationIdentity]
    }));
    vi.doMock('../src/domain/governance/activation/graph.js', () => ({
      ...graph, currentActivationIdentity: { ...graph.currentActivationIdentity, activationContractVersion: 99 },
      canonicalPhaseGraphHash: 'f'.repeat(64)
    }));
    vi.resetModules();
    const isolated = await import('../src/governance-activation/frozen-manifest-history.js');
    expect((await isolated.readFrozenActivationManifestHistory(project.root, project.reference)).sourceIdentity).toEqual(historicalV2ActivationIdentity);
    const sourceV3 = { ...project.index, sourceIdentity: releasedV3ActivationIdentity };
    await writeFixtureBytes(project.root, ['governance', 'history', project.index.snapshotId, 'index.json'], JSON.stringify(sourceV3));
    await expect(isolated.readFrozenActivationManifestHistory(project.root, {
      ...project.reference, indexDigest: rawHistoryDigest(Buffer.from(JSON.stringify(sourceV3)))
    })).rejects.toMatchObject({ code: 'unsupported-historical-identity' });
  });

  it.each([
    Buffer.from([0xff]),
    Buffer.from('{"terraform_version":"1","resources":[]}'),
    Buffer.from('{"secret":"never-preserved"}')
  ])('refuses invalid UTF8 or prohibited original manifest payload %#', async content => {
    const files = minimal(); files[0].content = content;
    const project = await fixture(files), before = await rawFiles(project.root);
    await expect(readFrozenActivationManifestHistory(project.root, project.reference)).rejects.toThrow();
    expect(await rawFiles(project.root)).toEqual(before);
  });
});

function addSourceChange(files: Source[]) {
  const state = historyRecord(parseHistoryJson(files[1].content, 'state'), 'state');
  const change = { id: 'original-change', kind: 'openspec' };
  state.activeChange = change;
  files[1].content = Buffer.from(JSON.stringify(state));
  const metadata = {
    schemaVersion: 1, marker: 'liftoff-governance-source-of-truth', changeId: change.id, workflowKind: change.kind,
    activationIdentity: state.identity, phaseGraphHash: historicalV1ActivationIdentity.phaseGraphHash,
    baselineSha: 'a'.repeat(64),
    phaseTaskMapping: Object.keys(historyRecord(state.phases, 'phases')).map((phaseId, index) => ({
      phaseId, taskId: String(index), marker: `<!-- liftoff-phase: ${phaseId} -->`, policy: 'evidence-projection-v1'
    })),
    currentPolicy: { phaseAuthority: 'managed-phase-graph', taskCompletion: 'authoritative-evidence-projection', approvalPolicy: 'approval-envelope-required-for-gated-phases' },
    createdFrom: { kind: 'approved-phase-0-facts', approvedFactDigest: 'a'.repeat(64), evidenceIds: [] },
    acknowledgedAt: '2026-09-01T00:00:00.000Z', owner: 'original'
  };
  files.push(
    { kind: 'source-metadata', parts: ['openspec', 'changes', change.id, 'liftoff-governance.json'], content: Buffer.from(JSON.stringify(metadata)), mode: 0o640 },
    { kind: 'source-tasks', parts: ['openspec', 'changes', change.id, 'tasks.md'], content: Buffer.alloc(0), mode: 0o644 }
  );
}

describe('real inclusive stored-file operational bounds', () => {
  it.each([0, 1])('admits 8 MiB/file and rejects the first excess byte (excess=%s)', async excess => {
    const files = minimal();
    files.push({ kind: 'metadata', parts: ['.liftoff', 'governance', 'policy.md'], content: Buffer.alloc(8 * 1024 * 1024 + excess, 120), mode: 0o644 });
    const project = await fixture(files);
    if (excess) await expect(readFrozenActivationManifestHistory(project.root, project.reference)).rejects.toThrow(/bounded size/);
    else expect((await readFrozenActivationManifestHistory(project.root, project.reference)).captures.some(file => file.content?.length === 8 * 1024 * 1024)).toBe(true);
  });

  it.each([0, 1])('uses real exact 32 MiB including indices, empty tasks and metadata (excess=%s)', async excess => {
    const files = minimal(); addSourceChange(files);
    for (const parts of [
      ['.liftoff', 'governance', 'policy.md'], ['.liftoff', 'governance', 'README.md'],
      ['.github', 'prompts', 'liftoff-setup.prompt.md'], ['.claude', 'commands', 'liftoff-setup.md']
    ]) files.push({ kind: 'metadata', parts, content: Buffer.alloc(0), mode: 0o644 });
    files.push({ kind: 'metadata', parts: ['.github', 'prompts', 'liftoff-governance-assess.prompt.md'], content: Buffer.alloc(0), mode: 0o644 });
    const padding = files.filter(file => file.kind === 'metadata').slice(0, 4);
    const overhead = snapshot(files).indexContent.length + files.reduce((sum, file) => sum + file.content.length, 0);
    for (const file of padding.slice(0, 3)) file.content = Buffer.alloc(8 * 1024 * 1024, 120);
    padding[3].content = Buffer.alloc(8 * 1024 * 1024 - overhead + excess, 120);
    const project = await fixture(files);
    expect(project.indexContent.length + files.reduce((sum, file) => sum + file.content.length, 0)).toBe(32 * 1024 * 1024 + excess);
    if (excess) await expect(readFrozenActivationManifestHistory(project.root, project.reference)).rejects.toThrow(/bounded size|raw bytes/);
    else {
      const read = await readFrozenActivationManifestHistory(project.root, project.reference);
      expect(read.captures.reduce((sum, file) => sum + file.content!.length, 0)).toBe(32 * 1024 * 1024);
      expect(read.captures.filter(file => file.content!.length === 0)).toHaveLength(2);
      expect(read.captures.at(-1)!.pathParts.at(-1)).toBe('activation-state.json');
    }
  }, 60_000);

  it.each([0, 1])('counts actual index plus 1023 copies inclusively (excess=%s)', async excess => {
    const files = minimal(), original = capturedV3Successor(1);
    const evidenceFile = original.index.files.find(file => file.kind === 'evidence')!;
    const evidence = historyRecord(parseHistoryJson(original.files.get(evidenceFile.originalPathParts.join('/'))!, 'evidence'), 'evidence');
    const header = historyRecord(evidence.header ?? evidence, 'header');
    header.producer = 'original-fixture';
    for (let i = 0; i < 1021 + excess; i++) files.push({
      kind: 'evidence', parts: ['governance', 'evidence', `original-${i}.json`],
      content: Buffer.from(JSON.stringify({ evidenceId: `original-${i}`, header })), mode: 0o640
    });
    const project = await fixture(files);
    if (excess) await expect(readFrozenActivationManifestHistory(project.root, project.reference)).rejects.toMatchObject({ code: 'history-inspection-limit' });
    else expect((await readFrozenActivationManifestHistory(project.root, project.reference)).captures).toHaveLength(1024);
  }, 60_000);
});

describe('stored predecessor links without mutable successor access', () => {
  async function chain(complete = false) {
    const root = await newRoot(), ancestor = snapshot(minimal(1));
    await install(root, ancestor);
    const original = capturedV3Successor(2);
    const files: Source[] = original.index.files.map(file => ({
      kind: file.kind, parts: file.originalPathParts, content: original.files.get(file.originalPathParts.join('/'))!, mode: file.mode
    }));
    const state = historyRecord(parseHistoryJson(files.find(file => file.kind === 'state')!.content, 'state'), 'state');
    const journal = structuredClone(capturedV3Successor(1).journal);
    Reflect.set(journal, 'laneId', 'activation-v1-to-v2');
    Reflect.set(journal, 'targetIdentity', historicalV2ActivationIdentity);
    journal.snapshotId = ancestor.index.snapshotId;
    journal.historyIndexPathParts = ['governance', 'history', ancestor.index.snapshotId, 'index.json'];
    journal.historyIndexDigest = ancestor.reference.indexDigest;
    journal.successor.repositoryId = historyStringField(state.repository, 'id');
    journal.successor.createdAt = String(state.createdAt);
    journal.transaction.committedAt = String(state.createdAt);
    if (complete) {
      journal.revalidation.status = 'complete'; journal.revalidation.nextAction = null;
      for (const phase of journal.revalidation.phases) {
        phase.status = 'complete';
        const refs = historyArray(historyRecord(historyRecord(state.phases, 'phases')[phase.phaseId], 'phase').evidence, 'refs');
        phase.evidenceIds = refs.map(ref => String(historyRecord(ref, 'ref').evidenceId));
      }
    }
    files.push({ kind: 'migration', parts: ['governance', 'migration-state.json'], content: Buffer.from(JSON.stringify(journal)), mode: 0o600 });
    const source = snapshot(files, 2); await install(root, source);
    return { root, ancestor, source, journal };
  }
  function historyStringField(value: unknown, field: string) { return String(historyRecord(value, field)[field]); }

  it.each([false, true])('validates v2-with-v1 ancestry and unconditional completion links (complete=%s)', async complete => {
    const project = await chain(complete);
    const result = await readFrozenActivationManifestHistory(project.root, project.source.reference);
    expect(result.sourceIdentity).toEqual(historicalV2ActivationIdentity);
    expect(result.captures.some(file => file.pathParts[2] === project.ancestor.index.snapshotId)).toBe(true);
    expect(result.captures.filter(file => file.pathParts.at(-1) === 'index.json')).toHaveLength(2);
    const copiedState = project.source.files.find(file => file.kind === 'state')!;
    expect(historyRecord(parseHistoryJson(copiedState.content, 'state'), 'state').bootstrapState).toBeUndefined();
  });

  it('retains optional original source metadata omissions but rejects a declared broken pair', async () => {
    const files = minimal();
    const state = historyRecord(parseHistoryJson(files[1].content, 'state'), 'state');
    state.activeChange = { id: 'old-change', kind: 'openspec' };
    files[1].content = Buffer.from(JSON.stringify(state));
    const project = await fixture(files);
    expect((await readFrozenActivationManifestHistory(project.root, project.reference)).sourceIdentity).toEqual(historicalV1ActivationIdentity);
    const broken = minimal(); addSourceChange(broken);
    broken.splice(broken.findIndex(file => file.kind === 'source-tasks'), 1);
    const invalid = await fixture(broken);
    await expect(readFrozenActivationManifestHistory(invalid.root, invalid.reference)).rejects.toMatchObject({ code: 'missing-historical-record' });
  });

  it('blocks false completed source revalidation even when old inventory has no retention', async () => {
    const project = await chain(true);
    project.journal.revalidation.phases[0].evidenceIds = ['missing-original-proof'];
    project.source.files.find(file => file.kind === 'migration')!.content = Buffer.from(JSON.stringify(project.journal));
    const changed = snapshot(project.source.files, 2); await install(project.root, changed);
    const legacy = await readHistoricalSnapshotInventory(project.root, changed.index);
    expect(legacy.state.bootstrapState).toBeUndefined();
    await expect(readFrozenActivationManifestHistory(project.root, changed.reference)).rejects.toThrow(/original matching proof/);
  });

  it.each(['missing', 'digest', 'target', 'anchor', 'time', 'forward'] as const)('blocks stored predecessor %s corruption', async kind => {
    const project = await chain();
    if (kind === 'missing') await fs.unlink(path.join(project.root, 'governance', 'history', project.ancestor.index.snapshotId, 'index.json'));
    else {
      if (kind === 'digest') project.journal.historyIndexDigest = '0'.repeat(64);
      if (kind === 'target') Reflect.set(project.journal, 'targetIdentity', releasedV3ActivationIdentity);
      if (kind === 'anchor') project.journal.successor.repositoryId = 'local:00000000-0000-4000-8000-000000000009';
      if (kind === 'time') project.journal.successor.createdAt = '2020-01-01T00:00:00.000Z';
      if (kind === 'forward') {
        Reflect.set(project.journal, 'sourceIdentity', historicalV2ActivationIdentity);
        Reflect.set(project.journal, 'laneId', 'activation-v2-to-v3');
      }
      project.source.files.find(file => file.kind === 'migration')!.content = Buffer.from(JSON.stringify(project.journal));
      project.source = snapshot(project.source.files, 2); await install(project.root, project.source);
    }
    const before = await rawFiles(project.root);
    await expect(readFrozenActivationManifestHistory(project.root, project.source.reference)).rejects.toThrow();
    expect(await rawFiles(project.root)).toEqual(before);
  });
});
