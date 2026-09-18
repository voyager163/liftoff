import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { DirectInstallReceipt, NativeTarget } from '../../domain/distribution/contracts.js';
import { DistributionError } from '../../domain/distribution/errors.js';
import type { NativeArtifactProvenance } from '../../domain/distribution/native-trust.js';
import type { ProjectFileSnapshot } from '../filesystem/project-transaction.js';
import { assertNativeRuntimeTarget } from './native-archive.js';
import {
  assertSafeNativePath, hashNativeFile, ioCode, nativePayloadMode, type NativeFileSnapshot
} from './native-files.js';
import { NATIVE_LAUNCHER_MAX_BYTES } from './native-launcher-limits.js';

export { NATIVE_LAUNCHER_MAX_BYTES } from './native-launcher-limits.js';
export const WINDOWS_DIRECT_LAUNCHER_ABI_ARGUMENT = '--liftoff-native-launcher-abi';
export const WINDOWS_DIRECT_LAUNCHER_ABI = 'liftoff-windows-launcher/1 receipt-bin/1';

export function assertWindowsDirectLayout(installRoot: string, launcherPath: string): void {
  if (path.win32.join(installRoot, 'bin', 'liftoff.exe') !== launcherPath ||
      !path.win32.isAbsolute(installRoot) || path.win32.normalize(installRoot) !== installRoot ||
      installRoot.startsWith('\\\\') || installRoot === path.win32.parse(installRoot).root) {
    throw new DistributionError(
      'Windows direct ownership requires an explicit local installation root and its exact bin\\liftoff.exe launcher; no receipt location is guessed.',
      'unsafe_path'
    );
  }
}

export function assertWindowsLauncherAbi(stdout: string, target: NativeTarget): void {
  if (!target.startsWith('win32-') ||
      stdout !== `${WINDOWS_DIRECT_LAUNCHER_ABI} ${target}\r\n`) {
    throw new DistributionError(
      'The admitted Windows PE does not implement the required receipt-owned stable-launcher ABI.',
      'artifact_mismatch'
    );
  }
}

export function windowsDirectLauncherBytes(bytes: Buffer, provenance: NativeArtifactProvenance): Buffer {
  const { entrypoints } = provenance;
  const file = provenance.files.find((entry) => entry.path === 'bin/liftoff.exe');
  if (!provenance.target.startsWith('win32-') || entrypoints.launcher !== 'bin/liftoff.exe' ||
      entrypoints.runtime !== 'runtime/node.exe' || entrypoints.cli !== 'dist/cli.js' ||
      !file || !bytes.length || bytes.length > NATIVE_LAUNCHER_MAX_BYTES || file.size !== bytes.length ||
      file.mode !== 0o755 || file.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
    throw new DistributionError('The direct Windows launcher must retain every exact signed candidate PE byte.', 'artifact_mismatch');
  }
  assertNativeRuntimeTarget(bytes, provenance.target);
  return Buffer.from(bytes);
}

export function assertDirectLauncherIdentity(
  receipt: DirectInstallReceipt, provenance: NativeArtifactProvenance, launcher: NativeFileSnapshot
): void {
  if (!receipt.authority || launcher.sha256 !== receipt.authority.launcherSha256) {
    throw new DistributionError('Receipt-owned direct launcher bytes changed.', 'ownership_conflict');
  }
  if (receipt.target.startsWith('win32-')) {
    assertWindowsDirectLayout(receipt.installRoot, receipt.launcherPath);
    const expected = provenance.files.find((entry) => entry.path === 'bin/liftoff.exe');
    if (provenance.target !== receipt.target || provenance.entrypoints.launcher !== 'bin/liftoff.exe' ||
        !expected || expected.sha256 !== launcher.sha256 || expected.size !== launcher.size ||
        nativePayloadMode(expected.mode) !== launcher.mode) {
      throw new DistributionError('A different Windows launcher cannot stand in for the selected signed candidate.', 'ownership_conflict');
    }
  }
}

export async function captureNativeLauncher(root: string, parts: readonly string[]): Promise<{
  snapshot: ProjectFileSnapshot; file?: NativeFileSnapshot;
}> {
  const pathParts = [...parts];
  let before: NativeFileSnapshot;
  try { before = await hashNativeFile(root, pathParts, NATIVE_LAUNCHER_MAX_BYTES); }
  catch (error) {
    if (ioCode(error) === 'ENOENT') return { snapshot: { pathParts } };
    throw error;
  }
  const target = await assertSafeNativePath(root, pathParts);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.device || opened.ino !== before.inode || !opened.isFile() ||
        opened.nlink !== 1 || opened.size !== before.size || (opened.mode & 0o7777) !== before.mode) {
      throw new DistributionError('Native launcher changed while opening its exact bytes.', 'stale_plan');
    }
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const content = bytes.subarray(0, length);
    const final = await handle.stat();
    if (length !== before.size || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs ||
        final.ctimeMs !== opened.ctimeMs || final.nlink !== 1 ||
        createHash('sha256').update(content).digest('hex') !== before.sha256 ||
        canonicalSha256(await hashNativeFile(root, pathParts, NATIVE_LAUNCHER_MAX_BYTES)) !== canonicalSha256(before)) {
      throw new DistributionError('Native launcher changed while capturing its exact bytes.', 'stale_plan');
    }
    return { file: before, snapshot: { pathParts, content, mode: before.mode } };
  } finally { await handle.close(); }
}
