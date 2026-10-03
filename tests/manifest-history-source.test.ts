import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createManifestHistoryIndex,
  manifestHistoryMaximumSourceBytes,
  validateManifestHistorySource,
  type ManifestHistorySource
} from '../src/domain/project/manifest/history.js';
import { FileSystemError } from '../src/domain/project/errors.js';

const source = () => ({
  artifactVersion: 2,
  digest: '51711f029ad7d872689f56f8689378918a06a71ab793181b81b3cac8c0d46949',
  bytes: 22,
  mode: 0o644
});

describe('public manifest history source validator', () => {
  it('accepts unknown input and returns exactly the existing readonly source type', () => {
    expectTypeOf(validateManifestHistorySource).toEqualTypeOf<(value: unknown) => ManifestHistorySource>();
    expectTypeOf<keyof ManifestHistorySource>().toEqualTypeOf<'artifactVersion' | 'digest' | 'bytes' | 'mode'>();
    expectTypeOf<ManifestHistorySource>().toEqualTypeOf<{
      readonly artifactVersion: 2 | 3 | 4 | 5 | 6 | 7;
      readonly digest: string;
      readonly bytes: number;
      readonly mode: number;
    }>();
    const result = validateManifestHistorySource(source());
    expect(result).toEqual(source());
    expect(Object.keys(result)).toEqual(['artifactVersion', 'digest', 'bytes', 'mode']);
    expect(result).toEqual(createManifestHistoryIndex(source()).source);
  });

  it.each([2, 3, 4, 5, 6, 7])('preserves supported source version %i', (artifactVersion) => {
    const input = { ...source(), artifactVersion };
    expect(validateManifestHistorySource(input)).toEqual(input);
    expect(validateManifestHistorySource(input)).toEqual(createManifestHistoryIndex(input).source);
  });

  it.each([1, 8_388_608])('accepts inclusive source-byte bound %i', (bytes) => {
    expect(manifestHistoryMaximumSourceBytes).toBe(8_388_608);
    expect(validateManifestHistorySource({ ...source(), bytes }).bytes).toBe(bytes);
  });

  it.each([0, 0o600, 0o644, 0o7777])('preserves inclusive original mode %i', (mode) => {
    expect(validateManifestHistorySource({ ...source(), mode }).mode).toBe(mode);
  });

  it('is syntax only and does not require a real source, index, reference or publication identity', () => {
    const input = { artifactVersion: 7, digest: '0'.repeat(64), bytes: 1, mode: 0 };
    expect(validateManifestHistorySource(input)).toEqual(input);
    expect(Object.keys(validateManifestHistorySource(input)).sort()).toEqual(['artifactVersion', 'bytes', 'digest', 'mode']);
  });

  it('returns an independent frozen copy without freezing or changing its caller', () => {
    const input = source();
    const result = validateManifestHistorySource(input);
    expect(result).not.toBe(input);
    expect(input).toEqual(source());
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Reflect.set(result, 'mode', 0)).toBe(false);
    expect(Reflect.set(result, 'snapshotId', '0'.repeat(64))).toBe(false);
    input.mode = 0;
    expect(result.mode).toBe(0o644);
    const plain: object = Object.assign(Object.create(null), source());
    expect(validateManifestHistorySource(plain)).toEqual(source());
    expect(Object.isFrozen(plain)).toBe(false);
  });

  it('directly validates without invoking canonical hashes or index encoding', async () => {
    vi.resetModules();
    const forbidden = () => { throw new Error('canonical helper must not run during source validation'); };
    const canonicalJson = vi.fn(forbidden);
    const canonicalSha256 = vi.fn(forbidden);
    const sha256Hex = vi.fn(forbidden);
    vi.doMock('../src/domain/governance/activation/canonical-json.js', () => ({
      canonicalJson, canonicalSha256, sha256Hex
    }));
    try {
      const isolated = await import('../src/domain/project/manifest/history.js');
      for (const artifactVersion of [2, 3, 4, 5, 6, 7]) {
        const input = { ...source(), artifactVersion };
        expect(isolated.validateManifestHistorySource(input)).toEqual(input);
      }
      expect(() => isolated.validateManifestHistorySource({ ...source(), bytes: 0 })).toThrow('source.bytes');
      expect(canonicalJson).not.toHaveBeenCalled();
      expect(canonicalSha256).not.toHaveBeenCalled();
      expect(sha256Hex).not.toHaveBeenCalled();
      // The positive control proves this module uses the mocked helpers for actual index construction.
      expect(() => isolated.createManifestHistoryIndex(source())).toThrow('canonical helper must not run');
      expect(canonicalSha256).toHaveBeenCalledTimes(1);
      expect(canonicalJson).not.toHaveBeenCalled();
      expect(sha256Hex).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../src/domain/governance/activation/canonical-json.js');
      vi.resetModules();
    }
  });
});

describe('unchanged source validation boundaries', () => {
  it.each([0, 1, 8, 32, -1, -0, 2.5, NaN, Infinity, '2', null, undefined, true, 2n].map((value) => ({ value })))(
    'rejects invalid source version %#', ({ value }) => {
      expect(() => validateManifestHistorySource({ ...source(), artifactVersion: value }))
        .toThrow('Manifest history source.artifactVersion must be one of 2, 3, 4, 5, 6, 7.');
    });

  it.each([0, -0, -1, 8_388_609, 0.5, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity,
    '22', undefined, null, true, {}, [], 22n].map((value) => ({ value })))(
    'rejects invalid source byte count %#', ({ value }) => {
      expect(() => validateManifestHistorySource({ ...source(), bytes: value }))
        .toThrow('Manifest history source.bytes must be a safe integer from 1 through 8388608.');
    });

  it.each([-0, -1, 0o10000, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity,
    '420', undefined, null, true, {}, [], 420n].map((value) => ({ value })))(
    'rejects invalid source mode %#', ({ value }) => {
      expect(() => validateManifestHistorySource({ ...source(), mode: value }))
        .toThrow('Manifest history source.mode must be a safe integer from 0 through 4095.');
    });

  it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64),
    `sha256:${'a'.repeat(64)}`, ` ${'a'.repeat(64)}`, `${'a'.repeat(64)}\n`,
    `${'a'.repeat(63)}\0`, undefined, null, true, 1, {}, []].map((value) => ({ value })))(
    'rejects invalid raw digest %#', ({ value }) => {
      expect(() => validateManifestHistorySource({ ...source(), digest: value }))
        .toThrow('Manifest history source.digest must be a raw lowercase 64-hex SHA-256 digest.');
    });

  it('preserves validation order and diagnostics when several fields are invalid', () => {
    const input = { artifactVersion: 8, digest: 'bad', bytes: 0, mode: -1 };
    expect(() => validateManifestHistorySource(input)).toThrow('source.artifactVersion');
    input.artifactVersion = 2;
    expect(() => validateManifestHistorySource(input)).toThrow('source.digest');
    input.digest = source().digest;
    expect(() => validateManifestHistorySource(input)).toThrow('source.bytes');
    input.bytes = 1;
    expect(() => validateManifestHistorySource(input)).toThrow('source.mode');
    input.mode = 0;
    expect(validateManifestHistorySource(input)).toEqual(input);
  });

  it.each([undefined, null, false, 0, '', [], new Array(1), new Date(0), () => source()].map((value) => ({ value })))(
    'rejects non-record or executable input %#', ({ value }) => {
      expect(() => validateManifestHistorySource(value)).toThrow('Manifest history source must be a plain JSON object.');
    });

  it.each(['artifactVersion', 'digest', 'bytes', 'mode'])('requires own enumerable data for %s without evaluating hooks', (field) => {
    const missing = source();
    Reflect.deleteProperty(missing, field);
    expect(() => validateManifestHistorySource(missing)).toThrow('must contain exactly the required fields');
    const hidden = Object.defineProperty(source(), field, { enumerable: false });
    expect(() => validateManifestHistorySource(hidden)).toThrow(`source.${field} must be an own enumerable data field`);
    for (const kind of ['get', 'set']) {
      const hook = vi.fn(() => { throw new Error('accessor evaluated'); });
      const accessor = Object.defineProperty(source(), field, { enumerable: true, [kind]: hook });
      expect(() => validateManifestHistorySource(accessor)).toThrow(`source.${field} must be an own enumerable data field`);
      expect(hook).not.toHaveBeenCalled();
    }
  });

  it('rejects inherited and unknown fields without invoking their hooks', () => {
    expect(() => validateManifestHistorySource(Object.create(source()))).toThrow('plain JSON object');
    const hook = vi.fn(() => { throw new Error('untrusted hook evaluated'); });
    const inherited = Object.create(Object.defineProperty({}, 'mode', { get: hook }));
    expect(() => validateManifestHistorySource(inherited)).toThrow('plain JSON object');
    const extraGetter = Object.defineProperty(source(), 'extra', { enumerable: true, get: hook });
    expect(() => validateManifestHistorySource(extraGetter)).toThrow('required fields');
    for (const field of ['snapshotId', 'source', 'indexDigest', 'pathParts', 'root', 'approval', 'fingerprint', 'time', 'verified']) {
      expect(() => validateManifestHistorySource({ ...source(), [field]: true })).toThrow('required fields');
    }
    for (const extra of [{ toJSON: hook }, { valueOf: hook }, { [Symbol.iterator]: hook }, { [Symbol.toPrimitive]: hook }]) {
      expect(() => validateManifestHistorySource({ ...source(), ...extra })).toThrow('required fields');
    }
    expect(() => validateManifestHistorySource(Object.defineProperty(source(), 'extra', { value: 1, enumerable: false })))
      .toThrow('required fields');
    expect(hook).not.toHaveBeenCalled();
  });

  it('does not coerce field values using toJSON, valueOf or primitive conversion', () => {
    const hook = vi.fn(() => '2');
    const value = { toJSON: hook, valueOf: hook, toString: hook, [Symbol.toPrimitive]: hook, [Symbol.iterator]: hook };
    for (const field of ['artifactVersion', 'digest', 'bytes', 'mode']) {
      expect(() => validateManifestHistorySource({ ...source(), [field]: value })).toThrow(FileSystemError);
    }
    expect(hook).not.toHaveBeenCalled();
  });
});
