import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  prepareStandaloneManifestHistory,
  type StandaloneManifestHistoryInput
} from '../src/application/update/manifest-history.js';
import {
  createManifestHistoryIndex, encodeManifestHistoryIndex, manifestHistoryPaths,
  manifestHistoryMaximumSourceBytes, validateManifestSourceHistoryReference
} from '../src/domain/project/manifest/history.js';
import { parseManifest } from '../src/application/project/manifest.js';
import { FileSystemError } from '../src/domain/project/errors.js';
import { parseHistoryJson } from '../src/governance-activation/history-contracts.js';
import { ActivationHistoryError } from '../src/governance-activation/historical-safety.js';

const io = vi.hoisted(() => ({ blocked: false, calls: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return Object.fromEntries(Object.entries(actual).map(([name, value]) => [
    name, typeof value === 'function' && /Sync$/.test(name)
      ? (...args: unknown[]) => {
        if (io.blocked) { io.calls.push(name); throw new Error(`Unexpected per-call filesystem I/O: ${name}`); }
        return Reflect.apply(value, actual, args);
      } : value
  ]));
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return Object.fromEntries(Object.entries(actual).map(([name, value]) => [
    name, typeof value === 'function' ? (...args: unknown[]) => {
      if (io.blocked) { io.calls.push(name); throw new Error(`Unexpected per-call filesystem I/O: ${name}`); }
      return Reflect.apply(value, actual, args);
    } : value
  ]));
});

const root = new URL('./fixtures/contract-baseline-0.12.3/', import.meta.url);
const rawHash = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');
const versions = [
  ['0.3.4', 2], ['0.4.1', 3], ['0.7.0', 4], ['0.8.0', 5], ['0.9.9', 6], ['0.12.3', 7]
] as const;
const examples = versions.flatMap(([writer, version]) =>
  ['standard-go', 'genai-rag'].map((workload) => ({ writer, version, file: `manifests/${writer}-${workload}.json` })));
const provenance: { files: Array<{ path: string; sha256: string }> } = JSON.parse(
  readFileSync(new URL('provenance.json', root), 'utf8'));

function source(file = 'manifests/0.12.3-standard-go.json'): Buffer {
  return readFileSync(new URL(file, root));
}

function fixture(content = source(), mode = 0o644) {
  const parsed = parseManifest(parseHistoryJson(content, 'test fixture'));
  const index = createManifestHistoryIndex({
    artifactVersion: parsed.artifactVersion, digest: rawHash(content), bytes: content.length, mode
  });
  const encoded = encodeManifestHistoryIndex(index);
  const reference = validateManifestSourceHistoryReference({
    schemaVersion: 1, kind: 'manifest-history', snapshotId: index.snapshotId, indexDigest: encoded.indexDigest
  });
  const paths = manifestHistoryPaths(reference);
  const input: StandaloneManifestHistoryInput = {
    sourceManifest: { pathParts: ['liftoff.manifest.json'], content: Buffer.from(content), mode },
    destinations: {
      directory: { pathParts: paths.indexPathParts.slice(0, -1), kind: 'absent' },
      copy: { pathParts: [...paths.manifestPathParts] },
      index: { pathParts: [...paths.indexPathParts] }
    }
  };
  return { input, index, encoded, reference, paths };
}

function completed(content = source(), originalMode = 0o750) {
  const f = fixture(content, originalMode);
  return {
    ...f,
    input: {
      ...f.input,
      destinations: {
        directory: { ...f.input.destinations.directory, kind: 'directory' as const },
        copy: { pathParts: [...f.paths.manifestPathParts], content: Buffer.from(content), mode: 0o444 },
        index: { pathParts: [...f.paths.indexPathParts], content: Buffer.from(f.encoded.content), mode: 0o640 }
      }
    }
  };
}

function unchecked(input: unknown): unknown {
  return Reflect.apply(prepareStandaloneManifestHistory, undefined, [input]);
}

afterEach(() => {
  io.blocked = false;
  io.calls.length = 0;
});

describe('standalone source-preservation data preparation', () => {
  it.each(examples)('preserves authentic $file bytes, source identity and provenance', ({ file, version }) => {
    const raw = source(file);
    const saved = Buffer.from(raw);
    const f = fixture(raw, 0o750);
    const result = prepareStandaloneManifestHistory(f.input);
    expect(result.disposition).toBe('create-standalone');
    expect(result.source).toEqual({ artifactVersion: version, digest: rawHash(raw), bytes: raw.length, mode: 0o750 });
    expect(result.index).toEqual(f.index);
    expect(result.reference).toEqual(f.reference);
    expect(result.indexBytes).toEqual(Buffer.from(f.encoded.content));
    expect(result.preservationWrites).toEqual([
      { type: 'write', pathParts: [...f.paths.manifestPathParts], content: raw, mode: 0o600 },
      { type: 'write', pathParts: [...f.paths.indexPathParts], content: Buffer.from(f.encoded.content), mode: 0o600 }
    ]);
    expect(result.filePreconditions).toEqual([
      { pathParts: ['liftoff.manifest.json'], content: raw, mode: 0o750 },
      { pathParts: [...f.paths.manifestPathParts] },
      { pathParts: [...f.paths.indexPathParts] }
    ]);
    expect(result.directoryObservation).toEqual(f.input.destinations.directory);
    expect(result.filePreconditions).toHaveLength(3);
    expect(raw).toEqual(saved);
    expect(source(file)).toEqual(saved);
    expect(parseManifest(parseHistoryJson(result.filePreconditions[0].content!, 'preserved original')))
      .toEqual(parseManifest(parseHistoryJson(raw, 'unchanged original')));
  });

  it('preserves the immutable fixture source pins rather than rewriting source examples', () => {
    expect(provenance).toHaveProperty('files');
    for (const example of examples) {
      const entry = provenance.files.find((file) => file.path === example.file);
      expect(entry, example.file).toBeDefined();
      expect(rawHash(source(example.file))).toBe(entry!.sha256);
    }
  });

  it('does not invent activation for legacy uncertainty or disabled governance', () => {
    const legacy = fixture(source('manifests/0.3.4-standard-go.json'));
    const parsedLegacy = parseManifest(parseHistoryJson(legacy.input.sourceManifest.content, 'legacy source'));
    expect(parsedLegacy.framework.state).toBe('legacy');
    expect(parsedLegacy.project.agents).toEqual([]);
    const disabled = parseManifest(parseHistoryJson(source(), 'none fixture'));
    disabled.governance = { profile: 'none', state: 'disabled' };
    disabled.managedArtifacts = [];
    for (const input of [legacy.input, fixture(Buffer.from(JSON.stringify(disabled))).input]) {
      const result = prepareStandaloneManifestHistory(input);
      expect(result.preservationWrites.map((write) => write.pathParts.slice(0, 2)))
        .toEqual([['.liftoff', 'manifest-history'], ['.liftoff', 'manifest-history']]);
      expect(Object.keys(result).sort()).toEqual([
        'directoryObservation', 'disposition', 'filePreconditions', 'index', 'indexBytes',
        'kind', 'preservationWrites', 'reference', 'source'
      ]);
      expect(Object.keys(result.index).sort()).toEqual(['kind', 'schemaVersion', 'snapshotId', 'source']);
      expect(Object.keys(result.reference).sort()).toEqual(['indexDigest', 'kind', 'schemaVersion', 'snapshotId']);
      for (const field of ['approval', 'fingerprint', 'target', 'activationState', 'applyEligible', 'budgetPassed', 'verified']) {
        expect(result).not.toHaveProperty(field);
      }
    }
  });

  it('keeps CRLF, formatting and original modes in source identity with deterministic repeated output', () => {
    const bytes = source();
    const parsed = JSON.parse(bytes.toString('utf8'));
    const variants = [
      fixture(bytes), fixture(Buffer.from(bytes.toString('utf8').replace(/\r?\n/g, '\r\n'))),
      fixture(Buffer.from(`${JSON.stringify(parsed, null, '\t')}\n`)), fixture(bytes, 0o600)
    ];
    const results = variants.map(({ input }) => prepareStandaloneManifestHistory(input));
    expect(new Set(results.map((result) => result.index.snapshotId)).size).toBe(4);
    for (const [index, f] of variants.entries()) {
      expect(prepareStandaloneManifestHistory(f.input)).toEqual(results[index]);
      expect(results[index].preservationWrites[0]).toMatchObject({ content: f.input.sourceManifest.content });
    }
  });

  it('reuses complete exact history without writes or substituting original modes for physical modes', () => {
    const f = completed();
    const result = prepareStandaloneManifestHistory(f.input);
    expect(result.disposition).toBe('reuse-standalone');
    expect(result.preservationWrites).toEqual([]);
    expect(result.source.mode).toBe(0o750);
    expect(result.filePreconditions).toEqual([
      { pathParts: ['liftoff.manifest.json'], content: f.input.sourceManifest.content, mode: 0o750 },
      { pathParts: [...f.paths.manifestPathParts], content: f.input.destinations.copy.content, mode: 0o444 },
      { pathParts: [...f.paths.indexPathParts], content: f.input.destinations.index.content, mode: 0o640 }
    ]);
    expect(result.filePreconditions.map((entry) => entry.pathParts.join('/'))).toHaveLength(3);
    expect(new Set(result.filePreconditions.map((entry) => entry.pathParts.join('/'))).size).toBe(3);
  });

  it('performs no filesystem I/O, clock reads or randomness during either preparation call', () => {
    const create = fixture();
    const reuse = completed();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Unexpected clock read'); });
    const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Unexpected randomness'); });
    io.blocked = true;
    const result = prepareStandaloneManifestHistory(create.input);
    const again = prepareStandaloneManifestHistory(reuse.input);
    expect(result).not.toBeInstanceOf(Promise);
    expect(again).not.toBeInstanceOf(Promise);
    expect(result.disposition).toBe('create-standalone');
    expect(again.disposition).toBe('reuse-standalone');
    expect(io.calls).toEqual([]);
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  });
});

describe('actual raw buffers and strict source readers', () => {
  it('accepts an actual inclusive 8 MiB source without claiming combined transaction admission', () => {
    expect(manifestHistoryMaximumSourceBytes).toBe(8_388_608);
    const bytes = source();
    const exact = Buffer.alloc(8_388_608, ' ');
    bytes.copy(exact);
    const result = prepareStandaloneManifestHistory(fixture(exact).input);
    expect(result.source.bytes).toBe(8_388_608);
    expect(result.source.digest).toBe(rawHash(exact));
    const copy = result.preservationWrites[0];
    if (copy.type !== 'write' || !Buffer.isBuffer(copy.content)) throw new Error('Expected a raw manifest copy.');
    expect(copy.content.length).toBe(8_388_608);
    expect(copy.content.equals(exact)).toBe(true);
    expect(result).not.toHaveProperty('budgetPassed');
  });

  it.each(['source', 'copy', 'index'] as const)('rejects a real one-byte-over buffer for %s', (member) => {
    const f = completed();
    const content = Buffer.alloc(8_388_609, ' ');
    const input = member === 'source'
      ? { ...f.input, sourceManifest: { ...f.input.sourceManifest, content } }
      : { ...f.input, destinations: { ...f.input.destinations, [member]: { ...f.input.destinations[member], content } } };
    expect(() => unchecked(input)).toThrow('1 through 8388608 bytes');
  });

  it.each([
    Buffer.alloc(0), 'not a Buffer', new Uint8Array([123, 125]), null, undefined, {},
    Buffer.from([0xff, 0xfe]), Buffer.from('{"artifactVersion":2}\0'),
    Buffer.from('{"artifactVersion":2,"artifactVersion":7}'),
    Buffer.from('{"unfinished":'), Buffer.from(`${'['.repeat(65)}0${']'.repeat(65)}`)
  ].map((content) => ({ content })))('rejects invalid raw source %# without replacement bytes', ({ content }) => {
    const f = fixture();
    expect(() => unchecked({ ...f.input, sourceManifest: { ...f.input.sourceManifest, content } })).toThrow();
  });

  it.each(['password', 'tfstate', 'statepayload'] as const)('rejects %s payloads without leaking or redacting them', (field) => {
    const f = fixture();
    const raw = JSON.parse(f.input.sourceManifest.content.toString('utf8'));
    const privateValue = 'must-not-appear-in-the-diagnostic';
    raw[field] = privateValue;
    const content = Buffer.from(JSON.stringify(raw));
    try {
      unchecked({ ...f.input, sourceManifest: { ...f.input.sourceManifest, content } });
      throw new Error('Expected unsafe historical content rejection.');
    } catch (error) {
      expect(error).toBeInstanceOf(ActivationHistoryError);
      expect(error).toMatchObject({ code: 'unsafe-historical-payload' });
      expect(String(error)).not.toContain(privateValue);
    }
    expect(content.toString('utf8')).toContain(privateValue);
  });

  it.each([
    { artifactVersion: 1 }, { artifactVersion: 8 }, { artifactVersion: '7' },
    { generatedBy: 'Unknown writer' }, { project: { workload: { kind: 'power-apps-code-app' } } }
  ])('uses the real manifest reader to reject unsupported source %#', (change) => {
    const f = fixture();
    const content = Buffer.from(JSON.stringify({ ...JSON.parse(f.input.sourceManifest.content.toString('utf8')), ...change }));
    expect(() => unchecked({ ...f.input, sourceManifest: { ...f.input.sourceManifest, content } }))
      .toThrow(FileSystemError);
  });

  it.each([-0, -1, 0o10000, 0.5, NaN, Infinity, '420', null, undefined].map((mode) => ({ mode })))(
    'rejects invalid observed original or physical mode %#', ({ mode }) => {
      const f = completed();
      expect(() => unchecked({ ...f.input, sourceManifest: { ...f.input.sourceManifest, mode } })).toThrow('mode');
      for (const member of ['copy', 'index'] as const) {
        expect(() => unchecked({
          ...f.input, destinations: { ...f.input.destinations, [member]: { ...f.input.destinations[member], mode } }
        })).toThrow('mode');
      }
    });

  it('preserves strict parsing error class, code and diagnostic instead of a fallback result', () => {
    const f = fixture();
    const content = Buffer.from('{"artifactVersion":2,"artifactVersion":2}');
    let expected: unknown;
    try { parseHistoryJson(content, 'original manifest'); } catch (error) { expected = error; }
    expect(() => unchecked({ ...f.input, sourceManifest: { ...f.input.sourceManifest, content } }))
      .toThrow(String(expected instanceof Error ? expected.message : expected));
    try { unchecked({ ...f.input, sourceManifest: { ...f.input.sourceManifest, content } }); }
    catch (error) { expect(error).toMatchObject({ name: 'ActivationHistoryError', code: 'malformed-history-json' }); }
  });
});

describe('exact supplied observation shapes and locations', () => {
  it.each([undefined, null, [], {}, true, () => fixture().input, new Date(0)])('rejects non-observation input %#', (input) => {
    expect(() => unchecked(input)).toThrow(FileSystemError);
  });

  it.each(['root', 'destinations', 'source', 'directory', 'copy', 'index'] as const)(
    'rejects unknown/hidden/symbol/inherited/accessor fields on %s', (location) => {
      const f = completed();
      const item = location === 'root' ? f.input : location === 'destinations' ? f.input.destinations
        : location === 'source' ? f.input.sourceManifest : f.input.destinations[location];
      const attach = (replacement: unknown) => location === 'root' ? replacement :
        location === 'destinations' ? { ...f.input, destinations: replacement } :
        location === 'source' ? { ...f.input, sourceManifest: replacement } :
        { ...f.input, destinations: { ...f.input.destinations, [location]: replacement } };
      const getter = vi.fn(() => { throw new Error('Observation getter executed'); });
      for (const replacement of [
        { ...item, extra: true }, { ...item, [Symbol('extra')]: true },
        Object.defineProperty({ ...item }, 'extra', { value: true }),
        Object.create(item),
        Object.defineProperty({ ...item }, Object.keys(item)[0], { enumerable: true, get: getter }),
        Object.defineProperty({ ...item }, Object.keys(item)[0], { enumerable: false, value: 'hidden' })
      ]) {
        expect(() => unchecked(attach(replacement))).toThrow(FileSystemError);
      }
      expect(getter).not.toHaveBeenCalled();
    }
  );

  it.each(['source', 'directory', 'copy', 'index'] as const)('rejects every wrong or executable %s path', (member) => {
    const f = completed();
    const original = member === 'source' ? f.input.sourceManifest : f.input.destinations[member];
    const getter = vi.fn(() => { throw new Error('Path getter executed'); });
    const candidates: unknown[] = [
      original.pathParts.join('/'), [], ['..'], ['liftoff.manifest.json', 'child'],
      ['C:', 'source'], ['a/b'], ['a\\b'], Array(original.pathParts.length),
      Object.assign([...original.pathParts], { extra: true }),
      Object.assign([...original.pathParts], { [Symbol('extra')]: true }),
      Object.defineProperty([...original.pathParts], '0', { enumerable: true, get: getter }),
      original.pathParts.map((part, index) => index === 0 ? part.toUpperCase() : part),
      original.pathParts.map((part, index) => index === 0 ? `${part} ` : part)
    ];
    if (member !== 'source') candidates.push(['liftoff.manifest.json']);
    for (const pathParts of candidates) {
      const input = member === 'source' ? { ...f.input, sourceManifest: { ...original, pathParts } }
        : { ...f.input, destinations: { ...f.input.destinations, [member]: { ...original, pathParts } } };
      expect(() => unchecked(input)).toThrow(FileSystemError);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects observations claiming future content at absent locations or undefined missing-file modes', () => {
    const f = fixture();
    for (const member of ['copy', 'index'] as const) {
      for (const fields of [{ content: undefined }, { mode: undefined }, { mode: 0o600 },
        { content: Buffer.from('{}'), mode: 0o600 }]) {
        expect(() => unchecked({
          ...f.input, destinations: { ...f.input.destinations, [member]: { ...f.input.destinations[member], ...fields } }
        })).toThrow(FileSystemError);
      }
    }
    expect(() => unchecked({ ...f.input, sourceManifest: { pathParts: ['liftoff.manifest.json'] } }))
      .toThrow('original sourceManifest must be present');
  });

  it('rejects an executable Buffer length without evaluating it', () => {
    const f = fixture();
    const content = Buffer.from(f.input.sourceManifest.content);
    const getter = vi.fn(() => { throw new Error('Buffer getter executed'); });
    Object.defineProperty(content, 'length', { get: getter });
    expect(() => unchecked({ ...f.input, sourceManifest: { ...f.input.sourceManifest, content } }))
      .toThrow('plain Buffer');
    expect(getter).not.toHaveBeenCalled();
  });

  it('accepts own-data null-prototype observations and frozen path arrays', () => {
    const f = fixture();
    const input = Object.assign(Object.create(null), f.input);
    input.sourceManifest = Object.assign(Object.create(null), f.input.sourceManifest);
    Object.freeze(input.sourceManifest.pathParts);
    expect(prepareStandaloneManifestHistory(input)).toEqual(prepareStandaloneManifestHistory(f.input));
  });
});

describe('no repair or fallback for partial or conflicting standalone history', () => {
  it.each([
    ['absent', false, true], ['absent', true, false], ['absent', true, true],
    ['directory', false, false], ['directory', false, true], ['directory', true, false]
  ] as const)('rejects directory=%s, index=%s, copy=%s', (kind, hasIndex, hasCopy) => {
    const f = completed();
    expect(() => prepareStandaloneManifestHistory({
      ...f.input,
      destinations: {
        directory: { ...f.input.destinations.directory, kind },
        index: hasIndex ? f.input.destinations.index : { pathParts: [...f.paths.indexPathParts] },
        copy: hasCopy ? f.input.destinations.copy : { pathParts: [...f.paths.manifestPathParts] }
      }
    })).toThrow('incomplete or inconsistent');
  });

  it.each(['file', 'link', 'unknown', '', undefined, 1].map((kind) => ({ kind })))('rejects invalid directory kind %#', ({ kind }) => {
    const f = fixture();
    expect(() => unchecked({ ...f.input, destinations: {
      ...f.input.destinations, directory: { ...f.input.destinations.directory, kind }
    } })).toThrow('kind must be absent or directory');
  });

  it.each(['copy', 'index'] as const)('refuses missing bytes for supposedly completed %s', (member) => {
    const f = completed();
    expect(() => unchecked({ ...f.input, destinations: {
      ...f.input.destinations, [member]: { ...f.input.destinations[member], content: Buffer.alloc(0) }
    } })).toThrow('1 through');
  });

  it('rejects equal parsed content with different original copy bytes', () => {
    const f = completed();
    const content = Buffer.from(`${JSON.stringify(JSON.parse(f.input.destinations.copy.content.toString('utf8')))}\r\n`);
    expect(content.equals(f.input.destinations.copy.content)).toBe(false);
    expect(() => prepareStandaloneManifestHistory({ ...f.input, destinations: {
      ...f.input.destinations, copy: { ...f.input.destinations.copy, content }
    } })).toThrow('manifest copy differs from the exact original bytes');
  });

  it.each(['format', 'source-mode', 'source-hash', 'snapshot-id', 'extra', 'duplicate', 'unsafe', 'invalid-json'] as const)(
    'rejects %s stored index without rewriting it', (change) => {
      const f = completed();
      let content: Buffer;
      if (change === 'format') content = Buffer.from(`${JSON.stringify(f.index, null, 2)}\n`);
      else if (change === 'source-mode' || change === 'source-hash') {
        const changed = createManifestHistoryIndex({
          ...f.index.source, ...(change === 'source-mode' ? { mode: 0o600 } : { digest: '0'.repeat(64) })
        });
        content = Buffer.from(encodeManifestHistoryIndex(changed).content);
      } else if (change === 'duplicate') content = Buffer.from(f.encoded.content.replace('{"', '{"schemaVersion":1,"'));
      else if (change === 'invalid-json') content = Buffer.from('{invalid');
      else content = Buffer.from(JSON.stringify({
        ...f.index,
        ...(change === 'snapshot-id' ? { snapshotId: '0'.repeat(64) } :
          change === 'unsafe' ? { password: 'private-value' } : { approval: true })
      }));
      const before = Buffer.from(content);
      expect(() => prepareStandaloneManifestHistory({ ...f.input, destinations: {
        ...f.input.destinations, index: { ...f.input.destinations.index, content }
      } })).toThrow();
      expect(content).toEqual(before);
    }
  );
});

describe('defensive copies without immutable authority claims', () => {
  it.each(['create', 'reuse'] as const)('separates all %s buffers and path arrays from inputs and one another', (variant) => {
    const f = variant === 'create' ? fixture() : completed();
    const result = prepareStandaloneManifestHistory(f.input);
    const sourceBefore = Buffer.from(f.input.sourceManifest.content);
    const sourceMode = f.input.sourceManifest.mode;
    const bytes = [
      result.indexBytes,
      ...result.filePreconditions.flatMap((entry) => entry.content ? [entry.content] : []),
      ...result.preservationWrites.flatMap((entry) => entry.type === 'write' && Buffer.isBuffer(entry.content) ? [entry.content] : [])
    ];
    expect(new Set(bytes).size).toBe(bytes.length);
    for (const content of bytes) expect(content).not.toBe(f.input.sourceManifest.content);
    const originalBytes = bytes.map((content) => Buffer.from(content));
    for (const [index, content] of bytes.entries()) {
      content[0] ^= 1;
      for (const [other, original] of originalBytes.entries()) if (other !== index) expect(bytes[other]).toEqual(original);
      content[0] ^= 1;
    }
    const paths = [
      result.directoryObservation.pathParts,
      ...result.filePreconditions.map((entry) => entry.pathParts),
      ...result.preservationWrites.map((entry) => entry.pathParts)
    ];
    expect(new Set(paths).size).toBe(paths.length);
    for (const parts of paths) {
      expect(parts).not.toBe(f.input.sourceManifest.pathParts);
      expect(parts).not.toBe(f.input.destinations.directory.pathParts);
      expect(parts).not.toBe(f.input.destinations.copy.pathParts);
      expect(parts).not.toBe(f.input.destinations.index.pathParts);
    }
    result.filePreconditions[0].pathParts[0] = 'changed-result-path';
    f.input.sourceManifest.content.fill(0);
    expect(result.filePreconditions[0].content).toEqual(sourceBefore);
    expect(f.input.sourceManifest.pathParts).toEqual(['liftoff.manifest.json']);
    expect(result.source.mode).toBe(sourceMode);
    expect(result.index.source).not.toBe(result.source);
  });
});

describe('underlying Buffer bytes without caller hook execution', () => {
  const members = ['source', 'copy', 'index'] as const;
  type Member = typeof members[number];

  function replaceBuffer(input: StandaloneManifestHistoryInput, member: Member, content: Buffer): StandaloneManifestHistoryInput {
    if (member === 'source') return { ...input, sourceManifest: { ...input.sourceManifest, content } };
    const previous = input.destinations[member];
    if (previous.mode === undefined) throw new Error('Expected a present history fixture.');
    return { ...input, destinations: {
      ...input.destinations, [member]: { pathParts: previous.pathParts, content, mode: previous.mode }
    } };
  }

  it.each(['method', 'getter'] as const)('creates history from actual source bytes without invoking a valueOf %s', (form) => {
    const f = fixture();
    const original = Buffer.from(f.input.sourceManifest.content);
    const supplied = Buffer.from(original);
    const hook = vi.fn(() => Buffer.concat([original, Buffer.from('\n')]));
    const getter = vi.fn(() => hook);
    Object.defineProperty(supplied, 'valueOf', form === 'method' ? { value: hook } : { get: getter });

    const result = prepareStandaloneManifestHistory(replaceBuffer(f.input, 'source', supplied));
    expect(result.disposition).toBe('create-standalone');
    expect(result.source).toEqual(f.index.source);
    const copy = result.preservationWrites[0];
    if (copy.type !== 'write' || !Buffer.isBuffer(copy.content)) throw new Error('Expected a raw manifest copy.');
    expect(copy.content.equals(original)).toBe(true);
    expect(result.filePreconditions[0].content?.equals(original)).toBe(true);
    expect(Buffer.prototype.equals.call(supplied, original)).toBe(true);
    expect(hook).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });

  describe.each(members)('%s observation', (member) => {
    it.each(['method', 'getter'] as const)('cannot substitute bytes using an own valueOf %s', (form) => {
      const original = source();
      const replacement = Buffer.concat([original, Buffer.from('\n')]);
      const f = member === 'source' ? completed(replacement) : completed(original);
      const expected = member === 'source' ? replacement : f.input.destinations[member].content;
      const supplied = member === 'source' ? Buffer.from(original) : Buffer.concat([expected, Buffer.from('\n')]);
      const before = Buffer.from(supplied);
      const hook = vi.fn(() => expected);
      const getter = vi.fn(() => hook);
      Object.defineProperty(supplied, 'valueOf', form === 'method' ? { value: hook } : { get: getter });

      expect(() => prepareStandaloneManifestHistory(replaceBuffer(f.input, member, supplied))).toThrow(FileSystemError);
      expect(hook).not.toHaveBeenCalled();
      expect(getter).not.toHaveBeenCalled();
      expect(Buffer.prototype.equals.call(supplied, before)).toBe(true);
    });

    const hooks = [
      { name: 'valueOf', key: 'valueOf' },
      { name: 'primitive conversion', key: Symbol.toPrimitive },
      { name: 'iterator', key: Symbol.iterator },
      { name: 'copy', key: 'copy' },
      { name: 'slice', key: 'slice' },
      { name: 'subarray', key: 'subarray' },
      { name: 'set', key: 'set' },
      { name: 'toString', key: 'toString' }
    ];

    it.each(hooks.flatMap(({ name, key }) => ['method', 'getter'].map((form) => ({ name, key, form }))))(
      'copies actual bytes without invoking $name $form',
      ({ key, form }) => {
        const f = completed();
        const actual = member === 'source' ? f.input.sourceManifest.content : f.input.destinations[member].content;
        const supplied = Buffer.from(actual);
        const expected = Buffer.from(actual);
        const replacement = Buffer.concat([actual, Buffer.from('\n')]);
        const hook = vi.fn(() => replacement);
        const getter = vi.fn(() => hook);
        Object.defineProperty(supplied, key, form === 'method' ? { value: hook } : { get: getter });

        const result = prepareStandaloneManifestHistory(replaceBuffer(f.input, member, supplied));
        expect(result.disposition).toBe('reuse-standalone');
        expect(result.preservationWrites).toEqual([]);
        expect(result.source).toEqual(f.index.source);
        const observed = result.filePreconditions[member === 'source' ? 0 : member === 'copy' ? 1 : 2];
        expect(observed.content?.equals(expected)).toBe(true);
        expect(observed.content !== supplied).toBe(true);
        expect(hook).not.toHaveBeenCalled();
        expect(getter).not.toHaveBeenCalled();
        supplied[0] ^= 1;
        expect(observed.content?.equals(expected)).toBe(true);
      }
    );

    it.each(['constructor-getter', 'species-getter', 'species-constructor'] as const)(
      'does not invoke %s while copying the exact Buffer view',
      (form) => {
        const f = completed();
        const actual = member === 'source' ? f.input.sourceManifest.content : f.input.destinations[member].content;
        const backing = Buffer.concat([Buffer.from('prefix'), actual, Buffer.from('suffix')]);
        const supplied = backing.subarray(6, 6 + actual.length);
        const constructor = vi.fn(() => Buffer.alloc(actual.length, 'x'));
        const species = vi.fn(() => constructor);
        const getConstructor = vi.fn(() => constructor);
        if (form === 'constructor-getter') Object.defineProperty(supplied, 'constructor', { get: getConstructor });
        else {
          Object.defineProperty(constructor, Symbol.species, form === 'species-getter' ? { get: species } : { value: constructor });
          Object.defineProperty(supplied, 'constructor', { value: constructor });
        }

        const result = prepareStandaloneManifestHistory(replaceBuffer(f.input, member, supplied));
        const observed = result.filePreconditions[member === 'source' ? 0 : member === 'copy' ? 1 : 2];
        expect(result.disposition).toBe('reuse-standalone');
        expect(result.source).toEqual(f.index.source);
        expect(observed.content?.length).toBe(actual.length);
        expect(observed.content?.equals(actual)).toBe(true);
        expect(constructor).not.toHaveBeenCalled();
        expect(species).not.toHaveBeenCalled();
        expect(getConstructor).not.toHaveBeenCalled();
        supplied.fill(0);
        expect(observed.content?.equals(actual)).toBe(true);
      }
    );
  });
});
