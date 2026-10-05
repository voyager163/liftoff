import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { inspectModernLocalRuntime } from '../src/application/governance/modern-local-inputs.js';
import { captureCompletionInputs } from '../src/adapters/filesystem/modern-local-publication-inputs.js';
import { canonicalJson } from '../src/domain/governance/activation/canonical-json.js';
import {
  artifactBytes, completionDigest, createCompletionArtifact, localCompletionPolicy, specKitCompletionPolicy,
  type SpecKitWorkflowInput
} from '../src/domain/governance/activation/modern-local-completion.js';
import { rawLocalDigest } from '../src/domain/governance/activation/modern-local-inputs.js';
import { createLocalFinalizationRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { generatedManualFixture } from './fixtures/modern-manual-project.js';

// Codec context only: no execution or finalization approval is represented.
const context = {
  schemaVersion: 1 as const, projectRoot: path.resolve('codec-project'),
  operationId: '11111111-1111-4111-8111-111111111111', fingerprint: 'a'.repeat(64)
};
const content = Buffer.from('{"protected":"original index bytes"}');
const nativeFilesystemIt = it.skipIf(process.env.LIFTOFF_HCL_TEST_LANE === 'portable' ||
  process.platform !== 'darwin' || process.arch !== 'arm64' || process.versions.node !== '24.21.0');
function encodedIndex() {
  return createCompletionArtifact(context, 'protected-index', content, null, null);
}
function decode(value: unknown) {
  return Reflect.apply(artifactBytes, undefined, [value, context]);
}

describe('bounded completion artifacts', () => {
  nativeFilesystemIt('captures the full all-agent, frontend, three-environment index without running project commands', async () => {
    const fixture = await generatedManualFixture({
      profile: 'single-maintainer-gitflow', agents: ['github-copilot', 'claude', 'codex'],
      frontend: true, environments: ['dev', 'staging', 'prod']
    });
    const observed = await inspectModernLocalRuntime(fixture.project);
    if (observed.status !== 'observed' || observed.local.status !== 'modern-observed') {
      throw new Error('Expected complete actual filesystem observations.');
    }
    const index = await captureCompletionInputs(observed.installed.snapshot, observed.local.snapshot);
    const bytes = Buffer.from(canonicalJson(index));
    console.info('MANUAL_COMPLETION_INDEX ' + JSON.stringify({
      files: index.files.length, directories: index.directories.length, physical: index.physical.length,
      bytes: bytes.length, base64Bytes: Buffer.byteLength(bytes.toString('base64'))
    }));
    expect(bytes.length).toBeLessThanOrEqual(localCompletionPolicy.recordBytes);
    const attributed = { ...context, projectRoot: fixture.project };
    const artifact = createCompletionArtifact(attributed, 'protected-index', bytes, null, null);
    expect(artifact).toMatchObject({ schemaVersion: 3, role: 'protected-index', encoding: 'deflate-raw' });
    expect(Buffer.byteLength(canonicalJson(artifact))).toBeLessThanOrEqual(localCompletionPolicy.recordBytes);
    const store = createLocalFinalizationRecordStore(fixture.project), key = completionDigest(artifact);
    await store.write('artifact', key, artifact);
    const saved = await store.read('artifact', key);
    expect(saved?.value).toEqual(artifact);
    expect(Reflect.apply(artifactBytes, undefined, [saved!.value, attributed])).toEqual(bytes);
    fixture.retained.complete = true;
  });
  it('preserves historical target/index and Spec Kit-original encodings', () => {
    const target = createCompletionArtifact(context, 'target', content, ['target.json'], 0o600);
    if (target.schemaVersion !== 1) throw new Error('Historical target encoding changed.');
    expect(target).toEqual({
      kind: 'liftoff-local-finalization-artifact', schemaVersion: 1, projectRoot: context.projectRoot,
      operationId: context.operationId, finalizationFingerprint: context.fingerprint, role: 'target',
      pathParts: ['target.json'], contentBase64: content.toString('base64'), bytes: content.length,
      rawDigest: rawLocalDigest(content), mode: 0o600
    });
    expect(artifactBytes(target, context)).toEqual(content);
    expect(artifactBytes({ ...target, role: 'protected-index', pathParts: null, mode: null }, context)).toEqual(content);
    const workflowInput: SpecKitWorkflowInput = {
      kind: 'spec-kit-bootstrap-inputs', schemaVersion: 1, bootstrapId: '000-liftoff-bootstrap',
      taskPathParts: specKitCompletionPolicy.taskPath, originalTaskHash: rawLocalDigest(content),
      originalTaskBytes: content.length, originalTaskMode: 0o600,
      bundleDigest: 'b'.repeat(64), markerSetDigest: 'c'.repeat(64), taskProtocolDigest: completionDigest(specKitCompletionPolicy)
    };
    const specKit = { ...context, schemaVersion: 2 as const, workflowInput };
    const original = createCompletionArtifact(specKit, 'workflow-original', content, [...specKitCompletionPolicy.taskPath], 0o600);
    expect(original).toEqual({ ...target, schemaVersion: 2, role: 'workflow-original', pathParts: [...specKitCompletionPolicy.taskPath] });
    expect(artifactBytes(original, specKit)).toEqual(content);
  });
  it('keeps the exact expanded ceiling and the unchanged serialized store ceiling', () => {
    const maximum = Buffer.alloc(localCompletionPolicy.recordBytes, 0x20);
    expect(Buffer.byteLength(maximum.toString('base64'))).toBeGreaterThan(localCompletionPolicy.recordBytes);
    expect(artifactBytes(createCompletionArtifact(context, 'protected-index', maximum, null, null), context)).toEqual(maximum);
    expect(() => createCompletionArtifact(context, 'protected-index', Buffer.alloc(maximum.length + 1), null, null)).toThrow(/64KiB/);
    expect(() => createCompletionArtifact(context, 'target', maximum, ['target.json'], 0o600)).toThrow(/64KiB/);
    expect(() => createCompletionArtifact(context, 'protected-index', randomBytes(maximum.length), null, null)).toThrow(/64KiB/);
  });
  it.each(['encoding', 'target-role', 'workflow-role', 'schema', 'root', 'operation', 'fingerprint', 'digest',
    'length', 'zero', 'negative', 'fractional', 'oversized', 'path', 'mode', 'unknown', 'base64', 'stream', 'truncated', 'trailing'] as const)(
    'rejects %s corruption without silently changing bytes or authority', mutation => {
      const original = encodedIndex();
      let value: object = original;
      if (mutation === 'encoding') value = { ...original, encoding: 'gzip' };
      else if (mutation === 'target-role') value = { ...original, role: 'target', pathParts: ['target.json'], mode: 0o600 };
      else if (mutation === 'workflow-role') value = { ...original, role: 'workflow-original' };
      else if (mutation === 'schema') value = { ...original, schemaVersion: 1 };
      else if (mutation === 'root') value = { ...original, projectRoot: path.resolve('foreign') };
      else if (mutation === 'operation') value = { ...original, operationId: '22222222-2222-4222-8222-222222222222' };
      else if (mutation === 'fingerprint') value = { ...original, finalizationFingerprint: 'b'.repeat(64) };
      else if (mutation === 'digest') value = { ...original, rawDigest: 'b'.repeat(64) };
      else if (mutation === 'length') value = { ...original, bytes: content.length + 1 };
      else if (mutation === 'zero') value = { ...original, bytes: 0 };
      else if (mutation === 'negative') value = { ...original, bytes: -1 };
      else if (mutation === 'fractional') value = { ...original, bytes: 1.5 };
      else if (mutation === 'oversized') value = { ...original, bytes: localCompletionPolicy.recordBytes + 1 };
      else if (mutation === 'path') value = { ...original, pathParts: ['not-a-target'] };
      else if (mutation === 'mode') value = { ...original, mode: 0o600 };
      else if (mutation === 'unknown') value = { ...original, future: true };
      else if (mutation === 'base64') value = { ...original, contentBase64: original.contentBase64 + '\n' };
      else if (mutation === 'stream') value = { ...original, contentBase64: Buffer.from('not-deflate').toString('base64') };
      else {
        const compressed = Buffer.from(original.contentBase64, 'base64');
        value = { ...original, contentBase64: (mutation === 'truncated' ? compressed.subarray(0, -1)
          : Buffer.concat([compressed, Buffer.from([0])])).toString('base64') };
      }
      expect(() => decode(value)).toThrow();
    }
  );
  it('bounds actual inflation even when the declared length lies', () => {
    const oversized = Buffer.alloc(localCompletionPolicy.recordBytes + 1, 0x20);
    expect(() => decode({ ...encodedIndex(), bytes: localCompletionPolicy.recordBytes,
      contentBase64: deflateRawSync(oversized).toString('base64'), rawDigest: rawLocalDigest(oversized)
    })).toThrow(/oversized compressed/);
  });
  it('refuses accessors without running them', () => {
    const getter = vi.fn(() => 3);
    const value = Object.defineProperty(encodedIndex(), 'schemaVersion', { get: getter });
    expect(() => decode(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});
