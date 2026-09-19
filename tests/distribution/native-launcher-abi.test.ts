import { access } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeArtifactProvenance } from '../../src/domain/distribution/native-trust.js';
import { validateInstallationExecutionIdentity } from '../../src/domain/distribution/transaction-identity.js';
import { inspectNativeArchive } from '../../src/adapters/distribution/native-archive.js';
import {
  assertDirectHandoverImplementation, directLauncherContent, directLauncherName, DirectInstallerAdapter
} from '../../src/adapters/distribution/direct-installer-adapter.js';
import { sha, signedFixture, zipArchive, type SignedFixture } from './native-fixture.js';

const fixtures: SignedFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

function peHeader(arch: 'x64' | 'arm64'): Buffer {
  const bytes = Buffer.alloc(128);
  bytes.write('MZ');
  bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x00004550, 64);
  bytes.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 68);
  bytes.writeUInt16LE(2, 86);
  bytes.writeUInt16LE(0x20b, 88);
  return bytes;
}

function archive(arch: 'x64' | 'arm64', options: {
  launcher?: string; launcherBytes?: Buffer; runtime?: string; cli?: string;
} = {}) {
  const entrypoints = {
    launcher: options.launcher ?? 'bin/liftoff.exe',
    runtime: options.runtime ?? 'runtime/node.exe', cli: options.cli ?? 'dist/cli.js'
  };
  const files = [
    { path: entrypoints.launcher, bytes: options.launcherBytes ?? peHeader(arch), mode: 0o755 },
    { path: entrypoints.runtime, bytes: peHeader(arch), mode: 0o755 },
    { path: entrypoints.cli, bytes: Buffer.from('parser-only fixture; not executable qualification'), mode: 0o644 },
    { path: 'package.json', bytes: Buffer.from(JSON.stringify({ name: '@msn-control/liftoff', version: '0.13.0', type: 'module' })), mode: 0o644 }
  ];
  const bytes = zipArchive(files);
  const provenance: NativeArtifactProvenance = {
    schemaVersion: 1, product: 'liftoff', repository: 'voyager163/liftoff', version: '0.13.0',
    sourceCommit: '7'.repeat(40), target: `win32-${arch}`, checksumSha256: sha(bytes),
    buildManifestSha256: 'a'.repeat(64), buildInfoSha256: 'b'.repeat(64), entrypoints,
    runtime: { nodeVersion: '24.20.0', minimumHostVersion: '10.0.17763', minimumBuild: 17763 },
    resources: { inventoryHash: 'c'.repeat(64), count: 1 },
    files: files.map((file) => ({ path: file.path, sha256: sha(file.bytes), size: file.bytes.length, mode: file.mode }))
  };
  return { bytes, provenance };
}

describe('current Windows archive parser ABI, not host execution qualification', () => {
  it.each(['x64', 'arm64'] as const)('checks both canonical executable headers for %s', (arch) => {
    const value = archive(arch);
    expect(inspectNativeArchive(value.bytes, value.provenance, 'zip').files).toHaveLength(4);
  });

  it.each([
    { launcher: 'bin/liftoff.cmd', launcherBytes: Buffer.from('@echo off\r\n') },
    { launcherBytes: Buffer.from('@echo off\r\n') },
    { launcherBytes: peHeader('arm64') },
    { runtime: 'runtime/node' },
    { cli: 'dist/another-cli.js' }
  ])('rejects script substitution, wrong PE architecture, and alternate entrypoints %#', (options) => {
    const value = archive('x64', options);
    expect(() => inspectNativeArchive(value.bytes, value.provenance, 'zip'))
      .toThrow(expect.objectContaining({ reasonCode: 'artifact_mismatch' }));
  });
});

describe('current direct launcher contract without Windows host qualification', () => {
  it('selects a supported native launcher without substituting a script or claiming host qualification', () => {
    expect(directLauncherName('win32')).toBe('liftoff.exe');
    expect(directLauncherName('darwin')).toBe('liftoff');
    expect(directLauncherName('linux')).toBe('liftoff');
    expect(() => assertDirectHandoverImplementation('win32')).not.toThrow();
    expect(() => directLauncherName('freebsd'))
      .toThrow(expect.objectContaining({ reasonCode: 'unsupported_host' }));
  });

  it('never renders CMD bytes or borrows another admitted host to perform Windows handover', async () => {
    const value = await signedFixture('current-pe-contract');
    fixtures.push(value);
    const candidate = await value.admission.admitBundle(value.candidate);
    expect(() => directLauncherContent(candidate, 'win32'))
      .toThrow(expect.objectContaining({ reasonCode: 'artifact_mismatch' }));
    const direct = new DirectInstallerAdapter({
      admission: value.admission, receiptStore: value.store, runner: value.runner, platform: 'win32'
    });
    await expect(direct.select({
      candidate, installRoot: value.installRoot, launcherPath: path.join(value.home, 'bin', 'liftoff.exe'), intent: 'migrate'
    })).rejects.toMatchObject({ reasonCode: 'unsupported_host' });
    expect(value.runner.calls).toHaveLength(0);
    await access(value.legacyLauncher);
    await expect(access(value.store.baseDirectory)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('accepts PE journal paths while preserving historical identities without making CMD current', () => {
    const base = {
      schemaVersion: 1, recipe: 'native-direct-handover', intent: 'migrate', version: '0.13.0',
      candidateIdentity: 'a'.repeat(64), receiptPathParts: ['native', 'liftoff-receipt.json']
    };
    const current = { ...base, launcherPathParts: ['bin', 'liftoff.exe'] };
    const historical = { ...base, launcherPathParts: ['bin', 'liftoff.cmd'] };
    expect(validateInstallationExecutionIdentity(current)).toEqual(current);
    expect(validateInstallationExecutionIdentity(historical)).toEqual(historical);
    expect(directLauncherName('win32')).not.toBe(historical.launcherPathParts.at(-1));
  });
});
