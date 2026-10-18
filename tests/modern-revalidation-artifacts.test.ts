import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { captureCompletionInputs } from '../src/adapters/filesystem/modern-local-publication-inputs.js';
import { createLocalRevalidationRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { inspectModernArchivedOpenSpecRuntime } from '../src/application/governance/modern-local-inputs.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { rawLocalDigest } from '../src/domain/governance/activation/modern-local-inputs.js';
import {
  createRevalidationArtifact, localRevalidationPolicy, revalidationArtifactBytes
} from '../src/domain/governance/activation/modern-revalidation-publication.js';
import { fixture } from './fixtures/manifest-update.js';
import { revalidationProject } from './fixtures/modern-revalidation-project.js';
import { fixture as wireFixture } from './fixtures/modern-revalidation-values.js';

const content = Buffer.from('{"protected":"original index bytes"}');
const { intent } = wireFixture();
const nativeFilesystemIt = it.skipIf(process.env.LIFTOFF_HCL_TEST_LANE === 'portable' ||
  process.platform !== 'darwin' || process.arch !== 'arm64' || process.versions.node !== '24.21.0');
const encode = (bytes = content) => createRevalidationArtifact(intent, 'protected-index', bytes, null, null);
const decode = (value: unknown) => Reflect.apply(revalidationArtifactBytes, undefined, [value, intent]);

describe('bounded successor revalidation artifacts', () => {
  nativeFilesystemIt('stores the complete actual archived OpenSpec index without running project commands', async () => {
    const f = await revalidationProject(true, 1, false, 'openspec');
    const observed = await inspectModernArchivedOpenSpecRuntime(f.root);
    if (observed.status !== 'observed' || observed.local.status !== 'modern-observed') {
      throw new Error('Expected complete actual archived filesystem observations.');
    }
    const index = await captureCompletionInputs(observed.installed.snapshot, observed.local.snapshot);
    const bytes = Buffer.from(canonicalJson(index)), attributed = wireFixture(true, f.root).intent;
    const artifact = createRevalidationArtifact(attributed, 'protected-index', bytes, null, null);
    expect(artifact).toMatchObject({ schemaVersion: 2, role: 'protected-index', encoding: 'deflate-raw' });
    expect(Buffer.byteLength(canonicalJson(artifact))).toBeLessThanOrEqual(localRevalidationPolicy.recordBytes);
    const store = createLocalRevalidationRecordStore(f.root, f.options), key = canonicalSha256(artifact);
    await store.write('artifact', key, artifact);
    expect(Reflect.apply(revalidationArtifactBytes, undefined, [(await store.read('artifact', key))!.value, attributed])).toEqual(bytes);
  });

  it('retains byte-identical historical target encoding and reads original uncompressed indexes', () => {
    const target = createRevalidationArtifact(intent, 'target', content, ['governance', 'activation-state.json'], 0o600);
    expect(target).toEqual({
      kind: 'liftoff-local-revalidation-artifact', schemaVersion: 1, projectRoot: intent.projectRoot,
      operationId: intent.operationId, intentFingerprint: intent.fingerprint, role: 'target',
      pathParts: ['governance', 'activation-state.json'], mode: 0o600,
      contentBase64: content.toString('base64'), bytes: content.length, rawDigest: rawLocalDigest(content)
    });
    expect(revalidationArtifactBytes(target, intent)).toEqual(content);
    expect(decode({ ...target, role: 'protected-index', pathParts: null, mode: null })).toEqual(content);
  });

  it('stores a full bounded index despite base64 overhead without raising either ceiling', async () => {
    const f = await fixture(), attributed = wireFixture(true, f.root).intent;
    const maximum = Buffer.alloc(localRevalidationPolicy.recordBytes, 0x20);
    expect(Buffer.byteLength(maximum.toString('base64'))).toBeGreaterThan(localRevalidationPolicy.recordBytes);
    const artifact = createRevalidationArtifact(attributed, 'protected-index', maximum, null, null);
    const store = createLocalRevalidationRecordStore(f.root, f.options), key = canonicalSha256(artifact);
    await store.write('artifact', key, artifact);
    expect(Reflect.apply(revalidationArtifactBytes, undefined, [(await store.read('artifact', key))!.value, attributed])).toEqual(maximum);
    const legacy = {
      kind: 'liftoff-local-revalidation-artifact', schemaVersion: 1, projectRoot: intent.projectRoot,
      operationId: intent.operationId, intentFingerprint: intent.fingerprint, role: 'protected-index',
      pathParts: null, mode: null, contentBase64: maximum.toString('base64'),
      bytes: maximum.length, rawDigest: rawLocalDigest(maximum)
    };
    expect(() => decode(legacy)).toThrow(/64KiB/);
    expect(() => encode(Buffer.alloc(maximum.length + 1))).toThrow(/64KiB/);
    expect(() => encode(randomBytes(maximum.length))).toThrow(/64KiB/);
    expect(() => createRevalidationArtifact(attributed, 'target', maximum, ['target.json'], 0o600)).toThrow(/64KiB/);
  });

  it.each(['encoding', 'target', 'schema', 'root', 'operation', 'fingerprint', 'digest', 'length',
    'zero', 'negative', 'fractional', 'oversized', 'path', 'mode', 'unknown', 'base64', 'stream', 'truncated', 'trailing'] as const)(
    'rejects %s corruption rather than changing bytes or authority', mutation => {
      const original = encode();
      let value: object = original;
      if (mutation === 'encoding') value = { ...original, encoding: 'gzip' };
      else if (mutation === 'target') value = { ...original, role: 'target', pathParts: ['target.json'], mode: 0o600 };
      else if (mutation === 'schema') value = { ...original, schemaVersion: 1 };
      else if (mutation === 'root') value = { ...original, projectRoot: intent.projectRoot + '-foreign' };
      else if (mutation === 'operation') value = { ...original, operationId: '22222222-2222-4222-8222-222222222222' };
      else if (mutation === 'fingerprint') value = { ...original, intentFingerprint: 'b'.repeat(64) };
      else if (mutation === 'digest') value = { ...original, rawDigest: 'b'.repeat(64) };
      else if (mutation === 'length') value = { ...original, bytes: content.length + 1 };
      else if (mutation === 'zero') value = { ...original, bytes: 0 };
      else if (mutation === 'negative') value = { ...original, bytes: -1 };
      else if (mutation === 'fractional') value = { ...original, bytes: 1.5 };
      else if (mutation === 'oversized') value = { ...original, bytes: localRevalidationPolicy.recordBytes + 1 };
      else if (mutation === 'path') value = { ...original, pathParts: ['not-a-target'] };
      else if (mutation === 'mode') value = { ...original, mode: 0o600 };
      else if (mutation === 'unknown') value = { ...original, force: true };
      else if (mutation === 'base64') value = { ...original, contentBase64: original.contentBase64 + '\n' };
      else if (mutation === 'stream') value = { ...original, contentBase64: Buffer.from('not-deflate').toString('base64') };
      else {
        const compressed = Buffer.from(original.contentBase64, 'base64');
        value = { ...original, contentBase64: (mutation === 'truncated' ? compressed.subarray(0, -1)
          : Buffer.concat([compressed, Buffer.from([0])])).toString('base64') };
      }
      expect(() => decode(value)).toThrow();
    });

  it('bounds actual inflation even when the declared decoded size lies', () => {
    const oversized = Buffer.alloc(localRevalidationPolicy.recordBytes + 1, 0x20);
    expect(() => decode({ ...encode(), bytes: localRevalidationPolicy.recordBytes,
      contentBase64: deflateRawSync(oversized).toString('base64'), rawDigest: rawLocalDigest(oversized)
    })).toThrow(/oversized compressed/);
  });

  it('rejects accessors before invoking them', () => {
    const getter = vi.fn(() => 2);
    expect(() => decode(Object.defineProperty(encode(), 'schemaVersion', { get: getter }))).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});
