import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createManifestHistoryIndex, validateManifestHistoryIndex, encodeManifestHistoryIndex,
  validateManifestSourceHistoryReference, manifestHistoryPaths, manifestHistoryMaximumSourceBytes
} from '../src/domain/project/manifest/history.js';
import { FileSystemError } from '../src/domain/project/errors.js';

const rawSource = '{"artifactVersion":2}\n';
const sourceDigest = '51711f029ad7d872689f56f8689378918a06a71ab793181b81b3cac8c0d46949';
const snapshotId = '892a410c545427804e00c1902aa1134af38bb9d73536e6fa789732525339126f';
const indexDigest = '6c0f33de80f9c8092c0d6379e147fafa79ff3580b3b92820ad237887f1fd573b';
// Literal ordered strings and hashes were derived without the production canonical/history helpers.
const canonicalSeed = '{"kind":"liftoff-manifest-history","schemaVersion":1,"source":{"artifactVersion":2,"bytes":22,"digest":"51711f029ad7d872689f56f8689378918a06a71ab793181b81b3cac8c0d46949","mode":420}}\n';
const canonicalIndex = '{"kind":"liftoff-manifest-history","schemaVersion":1,"snapshotId":"892a410c545427804e00c1902aa1134af38bb9d73536e6fa789732525339126f","source":{"artifactVersion":2,"bytes":22,"digest":"51711f029ad7d872689f56f8689378918a06a71ab793181b81b3cac8c0d46949","mode":420}}\n';
const rawHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const source = () => ({ artifactVersion: 2, digest: sourceDigest, bytes: 22, mode: 0o644 });
const index = () => ({ schemaVersion: 1, kind: 'liftoff-manifest-history', snapshotId, source: source() });
const reference = (kind = 'manifest-history') => ({ schemaVersion: 1, kind, snapshotId, indexDigest });

describe('manifest source-only history identity and encoding', () => {
  it('matches independent fixed raw-byte, source-only ID and complete-index vectors', () => {
    expect(Buffer.byteLength(rawSource, 'utf8')).toBe(22);
    expect(rawHash(rawSource)).toBe(sourceDigest);
    expect(rawHash(canonicalSeed)).toBe(snapshotId);
    expect(rawHash(canonicalIndex)).toBe(indexDigest);
    expect(createManifestHistoryIndex(source())).toEqual(index());
    expect(validateManifestHistoryIndex(index())).toEqual(index());
    expect(encodeManifestHistoryIndex(index())).toEqual({ content: canonicalIndex, indexDigest });
    expect(indexDigest).not.toBe(snapshotId);
  });

  it('emits compact UTF-8 JSON with exactly one terminal LF, no BOM and no cyclic fields', () => {
    const encoded = encodeManifestHistoryIndex(index());
    expect(encoded.content).toBe(canonicalIndex);
    expect(encoded.content.endsWith('\n')).toBe(true);
    expect(encoded.content.endsWith('\n\n')).toBe(false);
    expect(encoded.content.split('\n')).toHaveLength(2);
    expect(Buffer.from(encoded.content, 'utf8').subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(rawHash(Buffer.from(encoded.content, 'utf8'))).toBe(encoded.indexDigest);
    expect(Object.keys(JSON.parse(encoded.content)).sort()).toEqual(['kind', 'schemaVersion', 'snapshotId', 'source']);
    expect(Object.keys(JSON.parse(encoded.content).source).sort()).toEqual(['artifactVersion', 'bytes', 'digest', 'mode']);
  });

  it('is independent of input property ordering and repeated rendering', () => {
    const reversedSource = { mode: 420, bytes: 22, digest: sourceDigest, artifactVersion: 2 };
    const reversedIndex = { source: reversedSource, snapshotId, kind: 'liftoff-manifest-history', schemaVersion: 1 };
    expect(createManifestHistoryIndex(reversedSource)).toEqual(index());
    expect(encodeManifestHistoryIndex(reversedIndex)).toEqual(encodeManifestHistoryIndex(index()));
    expect(encodeManifestHistoryIndex(reversedIndex).content).toBe(canonicalIndex);
  });

  it.each([2, 3, 4, 5, 6, 7])('supports exactly recorded source version %i', (artifactVersion) => {
    const created = createManifestHistoryIndex({ ...source(), artifactVersion });
    expect(created.source.artifactVersion).toBe(artifactVersion);
    expect(validateManifestHistoryIndex(created)).toEqual(created);
    const encoded = encodeManifestHistoryIndex(created);
    const ref = validateManifestSourceHistoryReference({
      schemaVersion: 1, kind: 'manifest-history', snapshotId: created.snapshotId, indexDigest: encoded.indexDigest
    });
    expect(manifestHistoryPaths(ref)).toEqual({
      manifestPathParts: ['.liftoff', 'manifest-history', created.snapshotId, 'manifest.json'],
      indexPathParts: ['.liftoff', 'manifest-history', created.snapshotId, 'index.json']
    });
  });

  it('distinguishes raw LF, CRLF and reformatted source bytes with identical parsed content', () => {
    const examples = [rawSource, rawSource.replace('\n', '\r\n'), '{\n  "artifactVersion": 2\n}\n'];
    const ids = examples.map((text) => {
      expect(JSON.parse(text)).toEqual(JSON.parse(rawSource));
      const descriptor = { ...source(), bytes: Buffer.byteLength(text, 'utf8'), digest: rawHash(Buffer.from(text, 'utf8')) };
      return createManifestHistoryIndex(descriptor).snapshotId;
    });
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe(snapshotId);
  });

  it('changes identity for every source field without certifying descriptor truth', () => {
    const changed = [
      { ...source(), artifactVersion: 3 }, { ...source(), digest: '0'.repeat(64) },
      { ...source(), bytes: 23 }, { ...source(), mode: 0o600 }
    ];
    const ids = changed.map((value) => createManifestHistoryIndex(value).snapshotId);
    expect(new Set([snapshotId, ...ids]).size).toBe(5);
    for (const value of changed) {
      expect(() => validateManifestHistoryIndex({ ...index(), source: value })).toThrow('source-only identity');
      expect(() => encodeManifestHistoryIndex({ ...index(), source: value })).toThrow('source-only identity');
    }
  });

  it('does not treat zero digests or an absent reference as observed storage or fresh origin', () => {
    expect(createManifestHistoryIndex({ ...source(), digest: '0'.repeat(64) }).source.digest).toBe('0'.repeat(64));
    const zero = { schemaVersion: 1, kind: 'manifest-history', snapshotId: '0'.repeat(64), indexDigest: '0'.repeat(64) };
    expect(validateManifestSourceHistoryReference(zero)).toEqual(zero);
    expect(manifestHistoryPaths(zero).manifestPathParts[2]).toBe('0'.repeat(64));
    expect(() => validateManifestSourceHistoryReference(undefined)).toThrow(FileSystemError);
    expect(() => validateManifestSourceHistoryReference(null)).toThrow(FileSystemError);
    expect(Object.keys(validateManifestSourceHistoryReference(zero)).sort())
      .toEqual(['indexDigest', 'kind', 'schemaVersion', 'snapshotId']);
  });
});

describe('strict source history thresholds', () => {
  it('pins the maximum independently to exactly 8 MiB', () => {
    expect(manifestHistoryMaximumSourceBytes).toBe(8_388_608);
  });

  it.each([1, 8_388_608])('accepts source byte count %i without allocating source content', (bytes) => {
    expect(createManifestHistoryIndex({ ...source(), bytes }).source.bytes).toBe(bytes);
  });

  it.each([0, -0, -1, 8_388_609, 0.5, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
    '1', '8388608', null, undefined, true, {}, [], 1n].map((value) => ({ value })))(
    'rejects invalid byte count %#', ({ value }) => {
      expect(() => createManifestHistoryIndex({ ...source(), bytes: value })).toThrow('source.bytes');
    });

  it.each([0, 0o600, 0o644, 0o7777])('accepts original mode %i without a chmod claim', (mode) => {
    expect(createManifestHistoryIndex({ ...source(), mode }).source.mode).toBe(mode);
  });

  it.each([-0, -1, 0o10000, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
    '420', '0644', null, undefined, true, {}, [], 420n].map((value) => ({ value })))(
    'rejects invalid mode %#', ({ value }) => {
      expect(() => createManifestHistoryIndex({ ...source(), mode: value })).toThrow('source.mode');
    });

  it.each([0, 1, 8, 9, 2.5, NaN, Infinity, '2', null, undefined, true, 2n].map((value) => ({ value })))(
    'rejects unsupported or coerced source version %#', ({ value }) => {
      expect(() => createManifestHistoryIndex({ ...source(), artifactVersion: value })).toThrow('source.artifactVersion');
    });

  const malformedDigests = [
    '', '0'.repeat(63), '0'.repeat(65), 'G'.repeat(64), 'A'.repeat(64),
    `sha256:${sourceDigest}`, ` ${sourceDigest}`, `${sourceDigest}\n`,
    `${sourceDigest.slice(0, 63)}\0`, 'g'.repeat(64), null, undefined, 0, {}, [], true
  ];

  it.each(malformedDigests.map((value) => ({ value })))('rejects malformed history digests consistently %#', ({ value }) => {
    expect(() => createManifestHistoryIndex({ ...source(), digest: value })).toThrow('source.digest');
    expect(() => validateManifestHistoryIndex({ ...index(), snapshotId: value })).toThrow('index.snapshotId');
    expect(() => encodeManifestHistoryIndex({ ...index(), snapshotId: value })).toThrow('index.snapshotId');
    expect(() => validateManifestSourceHistoryReference({ ...reference(), snapshotId: value })).toThrow('reference.snapshotId');
    expect(() => validateManifestSourceHistoryReference({ ...reference(), indexDigest: value })).toThrow('reference.indexDigest');
    expect(() => manifestHistoryPaths({ ...reference(), snapshotId: value })).toThrow('reference.snapshotId');
  });

  it('rejects a syntactically valid but mismatched snapshot ID', () => {
    expect(() => validateManifestHistoryIndex({ ...index(), snapshotId: '0'.repeat(64) })).toThrow('source-only identity');
  });
});

describe('closed own-data history shapes', () => {
  const models = [
    { label: 'source', sample: source, validate: createManifestHistoryIndex },
    { label: 'index', sample: index, validate: validateManifestHistoryIndex },
    { label: 'encoded index', sample: index, validate: encodeManifestHistoryIndex },
    { label: 'reference', sample: reference, validate: validateManifestSourceHistoryReference },
    { label: 'metadata paths', sample: reference, validate: manifestHistoryPaths }
  ];
  const nonRecords = [undefined, null, false, 0, '', [], new Array(1), () => source(), new Date(0)];

  it.each(models)('rejects non-record inputs for $label', ({ validate }) => {
    for (const value of nonRecords) expect(() => validate(value)).toThrow(FileSystemError);
  });

  it.each(models)('requires every own field and rejects executable/non-data forms for $label', ({ sample, validate }) => {
    for (const key of Object.keys(sample())) {
      const missing = sample();
      Reflect.deleteProperty(missing, key);
      expect(() => validate(missing)).toThrow('required fields');
      const hidden = sample();
      Object.defineProperty(hidden, key, { enumerable: false });
      expect(() => validate(hidden)).toThrow('own enumerable data field');
      for (const accessorKind of ['getter', 'setter']) {
        const input = sample();
        const getter = vi.fn(() => { throw new Error('getter evaluated'); });
        const setter = vi.fn(() => { throw new Error('setter evaluated'); });
        Object.defineProperty(input, key, {
          enumerable: true, configurable: true,
          ...(accessorKind === 'getter' ? { get: getter } : { set: setter })
        });
        expect(() => validate(input)).toThrow('own enumerable data field');
        expect(getter).not.toHaveBeenCalled();
        expect(setter).not.toHaveBeenCalled();
      }
    }
    expect(() => validate(Object.create(sample()))).toThrow('plain JSON object');
    const prototypeGetter = vi.fn(() => { throw new Error('inherited getter evaluated'); });
    const inherited = Object.create(Object.defineProperty({}, 'source', { get: prototypeGetter }));
    expect(() => validate(inherited)).toThrow('plain JSON object');
    expect(prototypeGetter).not.toHaveBeenCalled();
  });

  it.each(models)('rejects unknown fields without evaluating accessors for $label', ({ sample, validate }) => {
    for (const field of [
      'targetDigest', 'targetVersion', 'indexDigestExtra', 'root', 'time', 'approval',
      'fingerprint', 'transitionDigest', 'paths', 'generationHash', 'progress', 'reference'
    ]) {
      expect(() => validate({ ...sample(), [field]: 'untrusted' })).toThrow('required fields');
    }
    const getter = vi.fn(() => { throw new Error('unknown getter evaluated'); });
    const unknown = Object.defineProperty(sample(), 'extra', { enumerable: true, get: getter });
    expect(() => validate(unknown)).toThrow('required fields');
    expect(getter).not.toHaveBeenCalled();
    expect(() => validate({ ...sample(), [Symbol('extra')]: true })).toThrow('required fields');
    expect(() => validate(Object.defineProperty(sample(), 'extra', { value: true, enumerable: false }))).toThrow('required fields');
    const toJSON = vi.fn(() => sample());
    expect(() => validate({ ...sample(), toJSON })).toThrow('required fields');
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('checks nested source descriptors before hashing or serializing them', () => {
    for (const value of nonRecords) expect(() => validateManifestHistoryIndex({ ...index(), source: value })).toThrow(FileSystemError);
    for (const key of Object.keys(source())) {
      const getter = vi.fn(() => { throw new Error('nested source getter evaluated'); });
      const nested = Object.defineProperty(source(), key, { enumerable: true, get: getter });
      expect(() => validateManifestHistoryIndex({ ...index(), source: nested })).toThrow('own enumerable data field');
      expect(() => encodeManifestHistoryIndex({ ...index(), source: nested })).toThrow('own enumerable data field');
      expect(getter).not.toHaveBeenCalled();
    }
    expect(() => validateManifestHistoryIndex({ ...index(), source: { ...source(), indexDigest } })).toThrow('required fields');
    expect(() => validateManifestHistoryIndex({ ...index(), indexDigest })).toThrow('required fields');
  });

  it('accepts plain null-prototype data without inheriting fields', () => {
    const plain: object = Object.assign(Object.create(null), source());
    expect(createManifestHistoryIndex(plain)).toEqual(index());
    expect(validateManifestHistoryIndex(Object.assign(Object.create(null), index()))).toEqual(index());
  });

  it.each([undefined, null, '1', 0, 2, NaN, true].map((value) => ({ value })))(
    'rejects invalid index and reference schema version %#', ({ value }) => {
      expect(() => validateManifestHistoryIndex({ ...index(), schemaVersion: value })).toThrow('schemaVersion 1');
      expect(() => validateManifestSourceHistoryReference({ ...reference(), schemaVersion: value })).toThrow('schemaVersion 1');
    });

  it.each(['manifest-history', 'activation-history', '', null, undefined, 1].map((value) => ({ value })))(
    'rejects wrong index kind %#', ({ value }) => {
      expect(() => validateManifestHistoryIndex({ ...index(), kind: value })).toThrow('kind liftoff-manifest-history');
    });
});

describe('reference syntax and metadata-owned path derivation', () => {
  it.each(['manifest-history', 'activation-history'])('decodes %s as syntax only', (kind) => {
    expect(validateManifestSourceHistoryReference(reference(kind))).toEqual(reference(kind));
  });

  it.each(['liftoff-manifest-history', 'future-history', '', null, undefined, 1].map((value) => ({ value })))(
    'rejects unknown reference kind %#', ({ value }) => {
      expect(() => validateManifestSourceHistoryReference({ ...reference(), kind: value })).toThrow('kind manifest-history or activation-history');
    });

  it('derives only the two exact metadata namespace paths', () => {
    expect(manifestHistoryPaths(reference())).toEqual({
      manifestPathParts: ['.liftoff', 'manifest-history', snapshotId, 'manifest.json'],
      indexPathParts: ['.liftoff', 'manifest-history', snapshotId, 'index.json']
    });
    expect(() => manifestHistoryPaths(reference('activation-history'))).toThrow('activation-owned resolver');
    expect(() => manifestHistoryPaths(snapshotId)).toThrow('plain JSON object');
    expect(() => manifestHistoryPaths({ ...reference(), paths: ['governance', 'history'] })).toThrow('required fields');
  });

  it.each([
    '..', '.', '../source', 'a/b', 'a\\b', 'C:', '\\\\server', '%2f', '%5c',
    snapshotId.toUpperCase(), `${snapshotId}/`, `${snapshotId}.`, `${snapshotId} `,
    `${snapshotId}\n`, `.g\u0131t`
  ])('rejects path-bearing or aliased snapshot input %j', (value) => {
    expect(() => manifestHistoryPaths({ ...reference(), snapshotId: value })).toThrow('raw lowercase 64-hex');
  });

  it('returns independent immutable source, index, encoding, reference and path values', () => {
    const input = source();
    const created = createManifestHistoryIndex(input);
    input.mode = 0;
    expect(created.source.mode).toBe(0o644);
    const originalIndex = index();
    const validated = validateManifestHistoryIndex(originalIndex);
    originalIndex.source.bytes = 1;
    expect(validated.source.bytes).toBe(22);
    expect(validated).not.toBe(originalIndex);
    expect(validated.source).not.toBe(originalIndex.source);
    const originalReference = reference();
    const validatedReference = validateManifestSourceHistoryReference(originalReference);
    originalReference.snapshotId = '0'.repeat(64);
    expect(validatedReference.snapshotId).toBe(snapshotId);
    const paths = manifestHistoryPaths(validatedReference);
    for (const value of [created, created.source, validated, validated.source,
      encodeManifestHistoryIndex(validated), validatedReference, paths, paths.manifestPathParts, paths.indexPathParts]) {
      expect(Object.isFrozen(value)).toBe(true);
      expect(Reflect.set(value, 'extra', true)).toBe(false);
    }
    const untouched = index();
    validateManifestHistoryIndex(untouched);
    encodeManifestHistoryIndex(untouched);
    expect(untouched).toEqual(index());
    expect(Object.isFrozen(untouched)).toBe(false);
    expect(Object.isFrozen(untouched.source)).toBe(false);
  });
});
