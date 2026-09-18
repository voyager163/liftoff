import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NativeArtifactProvenance } from '../../src/domain/distribution/native-trust.js';
import { createDirectReceipt } from '../../src/domain/distribution/direct-receipt.js';
import {
  applyReviewedUpdateTransaction, inspectReviewedUpdateTransaction, recoverReviewedUpdateTransaction,
  type ReviewedUpdateApprovalStore, type ReviewedUpdateTransactionOptions
} from '../../src/adapters/filesystem/reviewed-update-transaction.js';
import { ReceiptStore } from '../../src/adapters/distribution/receipt-store.js';
import { nativeDirectorySnapshot, nativePayloadMode } from '../../src/adapters/distribution/native-files.js';
import { observeLauncher } from '../../src/adapters/distribution/launcher-observation.js';
import {
  assertDirectLauncherIdentity, assertWindowsDirectLayout, assertWindowsLauncherAbi, captureNativeLauncher,
  NATIVE_LAUNCHER_MAX_BYTES, WINDOWS_DIRECT_LAUNCHER_ABI, windowsDirectLauncherBytes
} from '../../src/adapters/distribution/native-launcher.js';
import { sha } from './native-fixture.js';

const scopes: Array<{ root: string; device: number; inode: number }> = [];
afterEach(async () => {
  for (const created of scopes.splice(0)) {
    const actual = await lstat(created.root);
    expect(await realpath(created.root)).toBe(created.root);
    expect({ device: actual.dev, inode: actual.ino }).toEqual({ device: created.device, inode: created.inode });
    await rm(created.root, { recursive: true });
  }
});

function peBytes(arch: 'x64' | 'arm64' = 'x64', size = 3 * 1024 * 1024): Buffer {
  const bytes = Buffer.alloc(size, 0xa3);
  bytes.write('MZ');
  bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x00004550, 64);
  bytes.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 68);
  bytes.writeUInt16LE(2, 86);
  bytes.writeUInt16LE(0x20b, 88);
  return bytes;
}

function provenance(bytes: Buffer, arch: 'x64' | 'arm64' = 'x64'): NativeArtifactProvenance {
  return {
    schemaVersion: 1, product: 'liftoff', repository: 'voyager163/liftoff', version: '0.13.0',
    sourceCommit: '7'.repeat(40), target: `win32-${arch}`, checksumSha256: 'a'.repeat(64),
    buildManifestSha256: 'b'.repeat(64), buildInfoSha256: 'c'.repeat(64),
    entrypoints: { launcher: 'bin/liftoff.exe', runtime: 'runtime/node.exe', cli: 'dist/cli.js' },
    runtime: { nodeVersion: '24.20.0', minimumHostVersion: '10.0.17763', minimumBuild: 17763 },
    resources: { inventoryHash: 'd'.repeat(64), count: 1 },
    files: [{ path: 'bin/liftoff.exe', sha256: sha(bytes), size: bytes.length, mode: 0o755 }]
  };
}

async function transactionFixture() {
  const root = await realpath(await mkdtemp(path.join(await realpath('tests'), '.windows-direct-source-')));
  const details = await lstat(root);
  scopes.push({ root, device: details.dev, inode: details.ino });
  const home = path.join(root, 'isolated home');
  const transactionRoot = path.join(home, 'installation transaction');
  const launcherParts = ['bin', 'liftoff.exe'];
  const receiptParts = ['owner', 'liftoff-receipt.json'];
  const launcher = path.join(transactionRoot, ...launcherParts);
  const receipt = path.join(transactionRoot, ...receiptParts);
  const image = peBytes();
  for (const parts of [[], ['bin'], ['owner'], ['.liftoff'], ['owner', 'versions', 'retained-old']]) {
    await mkdir(path.join(transactionRoot, ...parts), { recursive: true, mode: 0o700 });
  }
  await writeFile(launcher, image, { mode: 0o755 });
  await writeFile(receipt, 'original receipt source fixture\n', { mode: 0o600 });
  const oldPayload = path.join(transactionRoot, 'owner', 'versions', 'retained-old', 'node.exe');
  await writeFile(oldPayload, 'exact old payload source fixture\n');
  const store = new ReceiptStore({ homedir: home, env: { HOME: home, USERPROFILE: home } });
  const approvalStore = store.approvalStore(transactionRoot);
  const installationDirectories = await Promise.all([[], ['bin'], ['owner'], ['.liftoff']].map(async (pathParts) => {
    const observed = await nativeDirectorySnapshot(path.join(transactionRoot, ...pathParts));
    return { pathParts, state: 'directory' as const, device: observed.device, inode: observed.inode, mode: observed.mode };
  }));
  const options: ReviewedUpdateTransactionOptions = {
    transactionKind: 'installation', planFingerprint: 'f'.repeat(64), approvalStore,
    installationIdentity: {
      schemaVersion: 1, recipe: 'native-direct-handover', intent: 'upgrade', version: '0.14.0',
      candidateIdentity: 'e'.repeat(64), launcherPathParts: launcherParts, receiptPathParts: receiptParts
    },
    installationDirectories,
    preconditions: [
      (await captureNativeLauncher(transactionRoot, launcherParts)).snapshot,
      (await captureNativeLauncher(transactionRoot, receiptParts)).snapshot
    ]
  };
  const apply = (target = image, changes: Partial<ReviewedUpdateTransactionOptions> = {}) =>
    applyReviewedUpdateTransaction(transactionRoot, [
      { type: 'write' as const, pathParts: receiptParts, content: 'selected receipt source fixture\n', mode: 0o600 },
      { type: 'write' as const, pathParts: launcherParts, content: target, mode: 0o755 }
    ], { ...options, ...changes });
  return { root, transactionRoot, launcher, receipt, launcherParts, image, oldPayload, approvalStore, options, apply };
}

describe('Windows direct launcher byte and ABI contracts (portable source evidence only)', () => {
  it.each(['x64', 'arm64'] as const)('preserves all selected %s PE bytes, including bytes beyond prior script limits', (arch) => {
    const image = peBytes(arch);
    const copy = windowsDirectLauncherBytes(image, provenance(image, arch));
    expect(copy).toEqual(image);
    expect(copy).not.toBe(image);
    expect(copy.length).toBeGreaterThan(2 * 1024 * 1024);
    copy[copy.length - 1] ^= 1;
    expect(() => windowsDirectLauncherBytes(copy, provenance(image, arch))).toThrow(/every exact signed/);
  });

  it('requires the concrete receipt-bin ABI, not JSON approval, a header, or a version-only assertion', () => {
    expect(() => assertWindowsLauncherAbi(`${WINDOWS_DIRECT_LAUNCHER_ABI} win32-x64\r\n`, 'win32-x64')).not.toThrow();
    for (const output of [
      '{"approved":true,"supportsReceiptHandover":true}', 'Liftoff 0.13.0\r\n',
      `${WINDOWS_DIRECT_LAUNCHER_ABI} win32-arm64\r\n`, `${WINDOWS_DIRECT_LAUNCHER_ABI} win32-x64\n`,
      `${WINDOWS_DIRECT_LAUNCHER_ABI} win32-x64\r\nextra`
    ]) expect(() => assertWindowsLauncherAbi(output, 'win32-x64')).toThrow(/ABI/);
  });

  it('rejects different images, architectures, script entrypoints, modes and oversized launchers', () => {
    const image = peBytes();
    const candidate = provenance(image);
    expect(() => windowsDirectLauncherBytes(image, { ...candidate, target: 'win32-arm64' })).toThrow();
    expect(() => windowsDirectLauncherBytes(image, {
      ...candidate, entrypoints: { ...candidate.entrypoints, launcher: 'bin/liftoff.cmd' }
    })).toThrow();
    expect(() => windowsDirectLauncherBytes(image, {
      ...candidate, files: [{ ...candidate.files[0], mode: 0o644 }]
    })).toThrow();
    const oversized = peBytes('x64', NATIVE_LAUNCHER_MAX_BYTES + 1);
    expect(() => windowsDirectLauncherBytes(oversized, provenance(oversized))).toThrow();
  });

  it('uses the explicit canonical local receipt-bin layout instead of guessing external receipt paths', () => {
    expect(() => assertWindowsDirectLayout('C:\\Owned Liftoff', 'C:\\Owned Liftoff\\bin\\liftoff.exe')).not.toThrow();
    for (const [root, launcher] of [
      ['C:\\Owned Liftoff', 'C:\\bin\\liftoff.exe'],
      ['C:\\Owned Liftoff', 'C:\\Owned Liftoff\\bin\\liftoff.cmd'],
      ['\\\\server\\share\\owned', '\\\\server\\share\\owned\\bin\\liftoff.exe'],
      ['C:\\', 'C:\\bin\\liftoff.exe']
    ]) expect(() => assertWindowsDirectLayout(root, launcher)).toThrow(/explicit local installation root/);
  });

  it('refuses an incompatible retained launcher even when a privately owned receipt hashes it', () => {
    const image = peBytes(), candidate = provenance(image);
    const receipt = createDirectReceipt({
      version: candidate.version, target: candidate.target, sourceCommit: candidate.sourceCommit,
      installRoot: 'C:\\Owned\\Liftoff', versionRoot: 'C:\\Owned\\Liftoff\\versions\\0.13.0',
      launcherPath: 'C:\\Owned\\Liftoff\\bin\\liftoff.exe', runtime: candidate.runtime, checksumSha256: candidate.checksumSha256,
      authority: {
        id: '10000000-0000-4000-8000-000000000001', manifestDigest: 'a'.repeat(64), provenanceDigest: 'b'.repeat(64),
        launcherSha256: sha(image), resources: candidate.resources, transactionRoot: 'C:\\Owned'
      }
    });
    const observed = {
      path: 'liftoff.exe', sha256: sha(image), size: image.length, mode: nativePayloadMode(0o755),
      device: 1, inode: 1, uid: 1, gid: 1
    };
    expect(() => assertDirectLauncherIdentity(receipt, candidate, observed)).not.toThrow();
    const different = Buffer.from(image);
    different[different.length - 1] ^= 1;
    expect(() => assertDirectLauncherIdentity(receipt, provenance(different), observed)).toThrow(/different Windows launcher/);
  });

  it('captures complete large PE snapshots and rejects linked files without reading the foreign target', async () => {
    const value = await transactionFixture();
    const captured = await captureNativeLauncher(value.transactionRoot, value.launcherParts);
    expect(captured.snapshot.content).toEqual(value.image);
    expect(captured.file?.sha256).toBe(sha(value.image));
    expect(await observeLauncher(value.launcher)).toMatchObject({ state: 'file', file: { sha256: sha(value.image) } });
    await symlink(value.launcher, path.join(value.transactionRoot, 'bin', 'other.exe'));
    await expect(captureNativeLauncher(value.transactionRoot, ['bin', 'other.exe'])).rejects.toThrow(/symlink|linked/);
  });
});

describe('sealed Windows-shaped handover transaction source cases, not Windows lock qualification', () => {
  it('activates the selected receipt without staging or replacing an identical running-image identity', async () => {
    const value = await transactionFixture();
    const before = await lstat(value.launcher);
    const stages: number[] = [];
    const outcome = await value.apply(value.image, {
      onCheckpoint: async (checkpoint) => { if (checkpoint.phase === 'staged') stages.push(checkpoint.index!); }
    });
    expect(outcome).toMatchObject({ committed: true, status: 'committed', cleanupFailures: [], rollbackFailures: [] });
    expect(stages).toEqual([0]);
    expect(await readFile(value.receipt, 'utf8')).toBe('selected receipt source fixture\n');
    expect(await readFile(value.launcher)).toEqual(value.image);
    const after = await lstat(value.launcher);
    expect({ device: after.dev, inode: after.ino }).toEqual({ device: before.dev, inode: before.ino });
    expect(await readFile(value.oldPayload, 'utf8')).toBe('exact old payload source fixture\n');
  });

  it('does not give project update transactions the installation-only mapped-image shortcut', async () => {
    const value = await transactionFixture();
    const stages: number[] = [];
    const outcome = await value.apply(value.image, {
      transactionKind: 'update', installationIdentity: undefined, installationDirectories: undefined,
      onCheckpoint: async (checkpoint) => { if (checkpoint.phase === 'staged') stages.push(checkpoint.index!); }
    });
    expect(outcome).toMatchObject({ committed: true, cleanupFailures: [] });
    expect(stages).toEqual([0, 1]);
    expect(await readFile(value.launcher)).toEqual(value.image);
  });

  it('a different-image lock never succeeds; rollback preserves the usable owner and a later exact retry actually replaces all bytes', async () => {
    const value = await transactionFixture();
    const next = Buffer.from(value.image);
    next[next.length - 1] ^= 1;
    await expect(value.apply(next, {
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.phase === 'staged' && checkpoint.index === 1) throw new Error('EPERM: image is still in use (source fault injection)');
      }
    })).rejects.toThrow(/EPERM.*rolled back/);
    expect(await readFile(value.receipt, 'utf8')).toBe('original receipt source fixture\n');
    expect(await readFile(value.launcher)).toEqual(value.image);
    const outcome = await value.apply(next);
    expect(outcome).toMatchObject({ committed: true, cleanupFailures: [], rollbackFailures: [] });
    expect(await readFile(value.launcher)).toEqual(next);
    expect(await readFile(value.oldPayload, 'utf8')).toBe('exact old payload source fixture\n');
  });

  it('late cancellation restores the original receipt without touching the identical PE or old payload', async () => {
    const value = await transactionFixture();
    const before = await lstat(value.launcher);
    await expect(value.apply(value.image, {
      onCheckpoint: async (checkpoint) => { if (checkpoint.phase === 'before-commit') throw new Error('cancelled before commit'); }
    })).rejects.toThrow(/cancelled before commit/);
    expect(await readFile(value.receipt, 'utf8')).toBe('original receipt source fixture\n');
    expect((await lstat(value.launcher)).ino).toBe(before.ino);
    expect(await readFile(value.oldPayload, 'utf8')).toBe('exact old payload source fixture\n');
  });

  it('committed readback failure remains committed/incomplete and requires a fresh independent guarded readback', async () => {
    const value = await transactionFixture();
    const failed = await value.apply(value.image, {
      onCheckpoint: async (checkpoint) => { if (checkpoint.phase === 'committed') throw new Error('exact PATH readback unavailable'); }
    });
    expect(failed).toMatchObject({ committed: true, status: 'committed', rollbackFailures: [] });
    expect(failed.cleanupFailures).toEqual([expect.stringContaining('PATH readback unavailable')]);
    expect(await inspectReviewedUpdateTransaction(value.transactionRoot, {
      transactionKind: 'installation', approvalStore: value.approvalStore
    })).toMatchObject({ status: 'committed' });
    let readbacks = 0;
    const recovered = await recoverReviewedUpdateTransaction(value.transactionRoot, {
      transactionKind: 'installation', approvalStore: value.approvalStore,
      onCommittedReadback: async () => {
        readbacks += 1;
        expect(await readFile(value.launcher)).toEqual(value.image);
        expect(await readFile(value.receipt, 'utf8')).toBe('selected receipt source fixture\n');
      }
    });
    expect(readbacks).toBe(1);
    expect(recovered).toMatchObject({ committed: true, cleanupFailures: [], rollbackFailures: [] });
  });

  it('changed owner bytes after partial commit cannot be overwritten or used to manufacture recovery success', async () => {
    const value = await transactionFixture();
    await value.apply(value.image, {
      onCheckpoint: async (checkpoint) => { if (checkpoint.phase === 'committed') throw new Error('readback lost'); }
    });
    await writeFile(value.receipt, 'newer foreign receipt content\n');
    let readback = false;
    const recovered = await recoverReviewedUpdateTransaction(value.transactionRoot, {
      transactionKind: 'installation', approvalStore: value.approvalStore,
      onCommittedReadback: async () => { readback = true; }
    });
    expect(readback).toBe(false);
    expect(recovered.cleanupFailures.length).toBeGreaterThan(0);
    expect(await readFile(value.receipt, 'utf8')).toBe('newer foreign receipt content\n');
    expect(await readFile(value.launcher)).toEqual(value.image);
    expect(await readFile(value.oldPayload, 'utf8')).toBe('exact old payload source fixture\n');
  });

  it('lost private approval authority leaves the exact journal and payloads retained instead of inferring permission from JSON', async () => {
    const value = await transactionFixture();
    let authorityAvailable = true;
    const approvalStore: ReviewedUpdateApprovalStore = {
      write: (...args) => value.approvalStore.write(...args),
      remove: (...args) => value.approvalStore.remove(...args),
      verify: async (...args) => authorityAvailable && await value.approvalStore.verify(...args)
    };
    await expect(value.apply(value.image, {
      approvalStore,
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.phase === 'after-mutation' && checkpoint.index === 0) {
          authorityAvailable = false;
          throw new Error('private authority became unavailable (source fault injection)');
        }
      }
    })).rejects.toThrow(/Recovery blocked/);
    const inspection = await inspectReviewedUpdateTransaction(value.transactionRoot, { transactionKind: 'installation', approvalStore });
    expect(inspection).toMatchObject({ status: 'blocked', committed: false });
    expect(await readFile(value.launcher)).toEqual(value.image);
    expect(await readFile(value.oldPayload, 'utf8')).toBe('exact old payload source fixture\n');
    authorityAvailable = true;
    const recovered = await recoverReviewedUpdateTransaction(value.transactionRoot, { transactionKind: 'installation', approvalStore });
    expect(recovered).toMatchObject({ status: 'rolled-back', committed: false, rollbackFailures: [], cleanupFailures: [] });
    expect(await readFile(value.receipt, 'utf8')).toBe('original receipt source fixture\n');
  });
});
