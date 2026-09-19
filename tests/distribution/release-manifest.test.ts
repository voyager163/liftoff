import { describe, expect, it } from 'vitest';
import { parseNativeReleaseManifest, parseRuntimeConstraints, verifyTargetFloor, compareNumericVersions } from '../../src/domain/distribution/release-manifest.js';
import { validManifest } from './manifest-fixture.js';
import { nativeTargetFloors } from '../../src/domain/distribution/contracts.js';

describe('strict native manifest and host admission', () => {
  it('reads and recursively freezes the independent schema-1 release identity', () => {
    const parsed = parseNativeReleaseManifest(validManifest());
    expect(parsed.schemaVersion).toBe(1);
    expect(Object.isFrozen(parsed.targets['linux-x64'].runtime)).toBe(true);
  });

  it.each([
    null, [], 'manifest', { ...validManifest(), schemaVersion: 3 }, { ...validManifest(), product: 'different' },
    { ...validManifest(), sourceCommit: 'short' }, { ...validManifest(), version: '0.13.0-preview.1' },
    { ...validManifest(), version: '00.13.0' }, { ...validManifest(), publishedAt: 'yesterday' },
    { ...validManifest(), publishedAt: '2026-02-30T00:00:00.000Z' }, { ...validManifest(), targetVersion: '0.13.0' },
    { ...validManifest(), targets: {} }
  ])('rejects incomplete, future, forged, or noncanonical release metadata %#', (input) => {
    expect(() => parseNativeReleaseManifest(input)).toThrow();
  });

  it.each([
    { checksumSha256: 'A'.repeat(64) }, { arch: 'arm64' }, { os: 'darwin' }, { archiveFormat: 'zip' },
    { signatureUrl: undefined }, { provenanceUrl: undefined }, { resources: {} }, { runtime: { nodeVersion: '24.x' } },
    { archiveUrl: 'http://github.com/voyager163/liftoff/releases/download/v0.13.0/linux-x64.tar.gz' },
    { archiveUrl: 'https://github.com/another/tool/releases/download/v0.13.0/linux-x64.tar.gz' },
    { archiveUrl: 'https://user:secret@github.com/voyager163/liftoff/releases/download/v0.13.0/linux-x64.tar.gz' },
    { archiveUrl: 'https://github.com/voyager163/liftoff/releases/download/latest/linux-x64.tar.gz' },
    { archiveUrl: 'https://github.com/voyager163/liftoff/releases/download/v0.13.0/linux-x64.tar.gz?token=secret' }
  ])('rejects unsigned, wrong-host, mutable, or secret-bearing target metadata %#', (patch) => {
    const value = validManifest();
    expect(() => parseNativeReleaseManifest({
      ...value, targets: { ...value.targets, 'linux-x64': { ...value.targets['linux-x64'], ...patch } }
    })).toThrow();
  });

  it.each(['linux-x64', 'darwin-arm64', 'win32-x64'] as const)('rejects an unobserved host floor for %s', (target) => {
    expect(() => verifyTargetFloor(target, {})).toThrow(/unobserved/);
  });

  it('enforces actual runtime-specific floors, not only the global minimum', () => {
    expect(() => verifyTargetFloor('linux-x64', { glibcVersion: '2.35', kernelRelease: '6.0.0' },
      { nodeVersion: '24.20.0', minimumGlibc: '2.36' })).toThrow(/2.36/);
    expect(() => verifyTargetFloor('linux-x64', { glibcVersion: '2.36', kernelRelease: '4.17.0' },
      { nodeVersion: '24.20.0', minimumGlibc: '2.36', minimumKernelVersion: '4.18.0' })).toThrow(/kernel/);
    expect(() => verifyTargetFloor('linux-x64', { glibcVersion: '2.36', kernelRelease: '6.1.0-test' },
      { nodeVersion: '24.20.0', minimumGlibc: '2.36' })).not.toThrow();
    expect(() => verifyTargetFloor('darwin-arm64', { darwinRelease: '20.6.0' })).toThrow();
    expect(() => verifyTargetFloor('darwin-arm64', { darwinRelease: '22.6.0', hostVersion: '13.5.0' })).not.toThrow();
    expect(() => verifyTargetFloor('win32-x64', { windowsBuild: 17762 })).toThrow();
    expect(() => verifyTargetFloor('win32-x64', { windowsBuild: 22621 })).not.toThrow();
  });

  it.each(['NaN', '24.x', '2..31', '', '1e3.0'])('never treats malformed numeric host versions as compatible: %s', (version) => {
    expect(() => compareNumericVersions(version, '2.31')).toThrow();
  });

  it('rejects weakened or missing runtime and resource constraints', () => {
    expect(() => parseRuntimeConstraints({ nodeVersion: '24.19.0' })).toThrow();
    expect(() => parseRuntimeConstraints({ nodeVersion: '24.20.0' }, 'linux-x64')).toThrow();
    expect(compareNumericVersions('2.31', '2.31.0')).toBe(0);
    expect(compareNumericVersions('2.32', '2.31')).toBe(1);
  });

  it.each(['darwin-x64', 'darwin-arm64'] as const)('enforces the pinned Node macOS floor for %s without implying host qualification', (target) => {
    expect(nativeTargetFloors.darwin).toEqual({ minimumHostVersion: '13.5.0', minimumDarwinRelease: '22.6.0' });
    const runtime = { nodeVersion: '24.20.0', ...nativeTargetFloors.darwin };
    for (const hostVersion of ['12.0.0', '13.0.0', '13.4.1']) {
      expect(() => verifyTargetFloor(target, { darwinRelease: '22.6.0', hostVersion }, runtime)).toThrow(/macOS 13.5.0/);
      expect(() => parseRuntimeConstraints({ ...runtime, minimumHostVersion: hostVersion }, target)).toThrow(/weakens/);
    }
    expect(() => verifyTargetFloor(target, { darwinRelease: '22.5.0', hostVersion: '13.5.0' }, runtime)).toThrow(/Darwin 22.6.0/);
    expect(() => verifyTargetFloor(target, { darwinRelease: '22.6.0' }, runtime)).toThrow(/unobserved macOS/);
    expect(() => verifyTargetFloor(target, { darwinRelease: '22.6.0', hostVersion: '13.5.0' }, runtime)).not.toThrow();
    expect(() => verifyTargetFloor(target, { darwinRelease: '25.0.0', hostVersion: '26.0.0' }, runtime)).not.toThrow();
    expect(() => parseRuntimeConstraints({ ...runtime, minimumDarwinRelease: '21.0.0' }, target)).toThrow(/weakens/);
  });

  it('retains the distinct stricter Liftoff Linux and Windows policy bounds', () => {
    expect(nativeTargetFloors.linux.minimumGlibc).toBe('2.31');
    expect(nativeTargetFloors.linux.minimumKernelVersion).toBe('4.18.0');
    expect(nativeTargetFloors.win32.minimumBuild).toBe(17763);
    expect(() => parseRuntimeConstraints({ nodeVersion: '24.20.0', minimumGlibc: '2.28' }, 'linux-x64')).toThrow(/weakens/);
    expect(() => verifyTargetFloor('linux-x64', { glibcVersion: '2.31', kernelRelease: '3.10.0' }, {
      nodeVersion: '24.20.0', minimumGlibc: '2.31', minimumKernelVersion: '3.10.0'
    })).toThrow(/weakens/);
  });
});
