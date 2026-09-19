import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDirectReceipt } from '../../src/domain/distribution/direct-receipt.js';
import { parseNativeTrustRegistration } from '../../src/domain/distribution/native-trust.js';
import {
  DistributionError, ReleaseManifestValidationError, TargetNotSupportedError, ReleaseChecksumMismatchError,
  InstallationOwnerMismatchError, MigrationPlanStaleError, MigrationApprovalRequiredError, MigrationExecutionError,
  LockedFileHandoverError, DirectReceiptValidationError, NativeCommandFailure
} from '../../src/domain/distribution/errors.js';
import { isNonExecutingInstallationCommand, canPersistInstallationTelemetryNotice } from '../../src/domain/distribution/contracts.js';
import { assertNativeRuntimeTarget, validateNativeArchive } from '../../src/adapters/distribution/native-archive.js';
import { assertSafeNativePath, canonicalDestination, hashNativeFile } from '../../src/adapters/distribution/native-files.js';
import { environmentValue, pathLauncherCandidates } from '../../src/adapters/distribution/launcher-observation.js';
import { signedManifestTransport } from './manifest-fixture.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('native record, path, and trust denial boundaries', () => {
  const receipt = {
    schemaVersion: 1, product: 'liftoff', version: '0.13.0', target: 'linux-x64', installedAt: '2026-09-14T00:00:00.000Z',
    sourceCommit: '7'.repeat(40), installRoot: '/isolated/native', versionRoot: '/isolated/native/versions/0.13.0',
    launcherPath: '/isolated/bin/liftoff', checksumSha256: 'a'.repeat(64),
    runtime: { nodeVersion: '24.20.0', minimumGlibc: '2.31' }
  };

  it.each([
    null, [], 'receipt', { ...receipt, schemaVersion: 3 }, { ...receipt, product: 'unrelated' },
    { ...receipt, version: '0.13.0-pre' }, { ...receipt, target: 'linux-ia32' }, { ...receipt, sourceCommit: 'short' },
    { ...receipt, installRoot: '../elsewhere' }, { ...receipt, versionRoot: '/isolated/foreign' },
    { ...receipt, versionRoot: '/isolated/native/versions/nested/escape' }, { ...receipt, checksumSha256: 'A'.repeat(64) },
    { ...receipt, authority: { id: '../escape' } }, { ...receipt, trusted: true }
  ])('rejects malformed or unregistered direct receipt claims %#', (value) => {
    expect(() => parseDirectReceipt(value)).toThrow();
  });

  it('distinguishes an unsigned receipt definition from private installation authority', () => {
    expect(parseDirectReceipt(receipt).authority).toBeUndefined();
    const expected = {
      ...receipt, authority: {
        id: randomUUID(), manifestDigest: 'b'.repeat(64), provenanceDigest: 'c'.repeat(64),
        launcherSha256: 'd'.repeat(64), resources: { inventoryHash: 'e'.repeat(64), count: 1 }, transactionRoot: '/isolated'
      }
    };
    expect(parseDirectReceipt(expected).authority?.transactionRoot).toBe('/isolated');
    expect(() => parseDirectReceipt({ ...expected, authority: { ...expected.authority, transactionRoot: '/another-root' } })).toThrow(/escapes/);
  });

  it('rejects absent, ambiguous, private-key, and wrong-source trust registrations', () => {
    const fixture = signedManifestTransport();
    expect(() => parseNativeTrustRegistration(null)).toThrow();
    expect(() => parseNativeTrustRegistration({ ...fixture.trust, schemaVersion: 3 })).toThrow();
    expect(() => parseNativeTrustRegistration({ ...fixture.trust, signers: [] })).toThrow();
    expect(() => parseNativeTrustRegistration({ ...fixture.trust, channels: [...fixture.trust.channels, ...fixture.trust.channels] })).toThrow(/duplicate/);
    expect(() => parseNativeTrustRegistration({
      ...fixture.trust, signers: [{ id: 'fixture', publicKeyPem: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----' }]
    })).toThrow(/public key/);
    expect(() => parseNativeTrustRegistration({
      ...fixture.trust, publications: fixture.trust.publications.map((entry) => ({ ...entry, manifestUrl: 'https://unregistered.example/native.json' }))
    })).toThrow(/immutable registered source/);
  });

  it('rejects native ABI/architecture mismatches before a runtime can be invoked', () => {
    const elf = Buffer.alloc(64);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    elf.writeUInt16LE(62, 18);
    expect(() => assertNativeRuntimeTarget(elf, 'linux-x64')).not.toThrow();
    expect(() => assertNativeRuntimeTarget(elf, 'linux-arm64')).toThrow();
    expect(() => assertNativeRuntimeTarget(elf, 'win32-x64')).toThrow();
    const macho = Buffer.alloc(32);
    macho.writeUInt32LE(0xfeedfacf, 0); macho.writeUInt32LE(0x0100000c, 4); macho.writeUInt32LE(2, 12);
    expect(() => assertNativeRuntimeTarget(macho, 'darwin-arm64')).not.toThrow();
    expect(() => assertNativeRuntimeTarget(macho, 'darwin-x64')).toThrow();
    const pe = Buffer.alloc(128);
    pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.writeUInt32LE(0x00004550, 64);
    pe.writeUInt16LE(0x8664, 68); pe.writeUInt16LE(2, 86); pe.writeUInt16LE(0x20b, 88);
    expect(() => assertNativeRuntimeTarget(pe, 'win32-x64')).not.toThrow();
    expect(() => assertNativeRuntimeTarget(pe, 'win32-arm64')).toThrow();
  });

  it('rejects native case/Unicode aliases, links, hardlink-like redirection, and traversal', async () => {
    const root = path.resolve('tests', `.native-path-${randomUUID()}`);
    roots.push(root);
    await mkdir(root, { mode: 0o700 });
    await writeFile(path.join(root, 'Resource'), 'original');
    await expect(assertSafeNativePath(root, ['resource'])).rejects.toThrow(/Case|case/);
    await symlink(path.join(root, 'Resource'), path.join(root, 'link'));
    await expect(hashNativeFile(root, ['link'])).rejects.toThrow(/symlink/);
    await expect(assertSafeNativePath(root, ['..', 'outside'])).rejects.toThrow();
    await expect(canonicalDestination('bad\0path', root)).rejects.toThrow();
  });

  it('uses Windows native PATH/PATHEXT ordering and rejects ambiguous environment aliases', () => {
    expect(pathLauncherCandidates({ Path: 'C:\\first;C:\\second', PATHEXT: '.EXE;.CMD' }, 'C:\\work', 'win32')).toEqual([
      'C:\\first\\liftoff.exe', 'C:\\first\\liftoff.cmd', 'C:\\second\\liftoff.exe', 'C:\\second\\liftoff.cmd'
    ]);
    expect(() => environmentValue({ PATH: 'first', Path: 'second' }, 'PATH', 'win32')).toThrow(/Ambiguous/);
    expect(pathLauncherCandidates({ PATH: ':bin' }, '/work', 'linux')).toEqual(['/work/liftoff', '/work/bin/liftoff']);
  });

  it('keeps preview and recovery out of installation telemetry authority', () => {
    for (const flags of [{}, { json: true }, { check: true }, { recover: true }]) {
      const parsed = { command: 'installation', subcommand: 'migrate', flags };
      expect(isNonExecutingInstallationCommand(parsed)).toBe(true);
      expect(canPersistInstallationTelemetryNotice(parsed)).toBe(false);
    }
    expect(isNonExecutingInstallationCommand({ command: 'installation', subcommand: 'inspect', flags: {} })).toBe(true);
    expect(isNonExecutingInstallationCommand({ command: 'installation', subcommand: 'migrate', flags: { 'approve-plan': 'a'.repeat(64) } })).toBe(false);
  });

  it('retains causal error identities without generic Yes or automatic rollback guidance', () => {
    expect(new DistributionError('failure').message).toBe('failure');
    expect(new ReleaseManifestValidationError('failure', ['issue']).issues).toEqual(['issue']);
    expect(new TargetNotSupportedError('target', 'observed', 'required').reasonCode).toBe('unsupported_host');
    expect(new ReleaseChecksumMismatchError('expected', 'observed', 'target').reasonCode).toBe('artifact_mismatch');
    expect(new InstallationOwnerMismatchError('direct', 'npm').reasonCode).toBe('ownership_conflict');
    expect(new MigrationPlanStaleError('changed', 'expected', 'actual').reasonCode).toBe('stale_plan');
    expect(new MigrationApprovalRequiredError('a'.repeat(64)).message).not.toContain('--yes');
    expect(new MigrationExecutionError('stage-target', 'failed', 1).exitCode).toBe(1);
    expect(new LockedFileHandoverError('launcher').reasonCode).toBe('locked_handover');
    expect(new DirectReceiptValidationError('failure', ['issue']).issues).toEqual(['issue']);
    expect(new NativeCommandFailure('owner query', null, null, true).reasonCode).toBe('timeout');
  });
});
