import { createHash } from 'node:crypto';
import path from 'node:path';
import { comparisonPath } from '../../domain/distribution/liftoff-npm-installation.js';
import { SelfUpgradeFailure } from '../../domain/distribution/liftoff-upgrade.js';
import type { NativeBundleInventory, NativeReleasePolicy, WindowsInstallerLayout } from '../../domain/distribution/native-upgrade.js';
import type { SelfUpgradeDependencies } from './upgrade-host.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const invalid = () => new SelfUpgradeFailure('blocked', 'unsupported_installation');
const same = (left: string, right: string) => comparisonPath(left, 'win32') === comparisonPath(right, 'win32');

/** Local installer attribution only; neither a WinGet source observation nor publisher authentication. */
export async function readWindowsInstallerLayout(
  dependencies: SelfUpgradeDependencies, installation: NativeBundleInventory, policy: NativeReleasePolicy,
  selectedLauncher: string | null, signal: AbortSignal
): Promise<WindowsInstallerLayout> {
  const approved = policy.winget;
  if (!policy.approvedSigningKeySha256 || !approved.packageIdentifier || !approved.installerAppId ||
    !approved.publisher || !approved.certificateSha256) throw new SelfUpgradeFailure('blocked', 'native_unqualified');
  if (dependencies.platform !== 'win32' || installation.target !== 'win32-x64') throw invalid();
  if (!dependencies.readBytes || !dependencies.lstatBigInt) throw new SelfUpgradeFailure('blocked', 'native_unavailable');
  const localValues = Object.entries(dependencies.environment).filter(([key]) => key.toLowerCase() === 'localappdata');
  const local = localValues[0]?.[1];
  if (localValues.length !== 1 || !local || !/^[A-Za-z]:\\/.test(local) ||
    /[/\u0000-\u001f<>:"|?*]/.test(local.slice(3)) || path.win32.normalize(local) !== local) throw invalid();
  const installRoot = path.win32.join(local, 'Programs', 'Liftoff');
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(installation.version) ||
    installation.version.length > 128 || !/^[a-f0-9]{64}$/.test(installation.manifestSha256) ||
    !/^[a-f0-9]{64}$/.test(installation.inventorySha256) || !/^[a-f0-9]{40}$/.test(installation.sourceCommit)) throw invalid();
  const versionName = `${installation.version}-${installation.manifestSha256}`;
  const versionDirectory = `versions/${versionName}`;
  const stableLauncher = path.win32.join(installRoot, 'bin', 'liftoff.exe');
  if (versionName.length > 193 || !same(installation.bundleRoot, path.win32.join(installRoot, 'versions', versionName)) ||
    !same(installation.launcher, path.win32.join(installation.bundleRoot, 'bin', 'liftoff.exe')) ||
    !same(installation.runtime, path.win32.join(installation.bundleRoot, 'runtime', 'node.exe'))) throw invalid();
  if (!selectedLauncher || !same(selectedLauncher, stableLauncher)) {
    throw new SelfUpgradeFailure('blocked', 'executable_selection');
  }
  const directories = new Map<string, string>();
  const files = new Map<string, { bytes: Buffer; maximum: number }>();
  const check = () => {
    if (signal.aborted) throw new SelfUpgradeFailure('failed', 'native_timeout');
  };
  const inspectDirectory = async (directory: string) => {
    check();
    const stat = await dependencies.lstatBigInt!(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(await dependencies.realpath(directory), directory)) throw invalid();
    const identity = JSON.stringify([stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.birthtimeNs].map(value => value.toString()));
    const previous = directories.get(directory);
    if (previous && previous !== identity) throw new SelfUpgradeFailure('blocked', 'owner_changed');
    directories.set(directory, identity);
  };
  const inspectAncestors = async (directory: string) => {
    for (;;) {
      await inspectDirectory(directory);
      const parent = path.win32.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  };
  const read = async (filename: string, maximum: number) => {
    await inspectAncestors(path.win32.dirname(filename));
    const stat = await dependencies.lstatBigInt!(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n ||
      !same(await dependencies.realpath(filename), filename)) throw invalid();
    const bytes = await dependencies.readBytes!(filename, maximum);
    if (!bytes.length || bytes.length > maximum) throw invalid();
    check();
    const previous = files.get(filename);
    if (previous && !previous.bytes.equals(bytes)) throw new SelfUpgradeFailure('blocked', 'owner_changed');
    files.set(filename, { bytes: Buffer.from(bytes), maximum });
    return bytes;
  };
  const receiptBytes = await read(path.win32.join(installRoot, 'native-install.json'), 16 * 1024);
  let receipt: unknown;
  try { receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes)); }
  catch { throw invalid(); }
  const pointer = await read(path.win32.join(installRoot, 'current.txt'), 256);
  if (!pointer.equals(Buffer.from(`${versionName}\r\n`, 'ascii'))) throw invalid();
  const stableBytes = await read(stableLauncher, 8 * 1024 * 1024);
  const innerBytes = await read(installation.launcher, 8 * 1024 * 1024);
  if (!stableBytes.equals(innerBytes)) throw invalid();
  const stableLauncherSha256 = hash(stableBytes);
  const expected = {
    schemaVersion: 1, kind: 'liftoff-windows-install-receipt', scope: 'user',
    package: '@msn-control/liftoff', packageIdentifier: approved.packageIdentifier, appId: approved.installerAppId,
    publisher: approved.publisher, certificateSha256: approved.certificateSha256, version: installation.version,
    sourceCommit: installation.sourceCommit, manifestSha256: installation.manifestSha256,
    inventorySha256: installation.inventorySha256, versionDirectory,
    launcher: `${versionDirectory}/bin/liftoff.exe`, runtime: `${versionDirectory}/runtime/node.exe`,
    stableLauncher: 'bin/liftoff.exe', stableLauncherSha256
  };
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
    Object.keys(receipt).sort().join() !== Object.keys(expected).sort().join() ||
    Object.entries(expected).some(([key, value]) => Reflect.get(receipt, key) !== value)) throw invalid();
  for (const [filename, previous] of files) await read(filename, previous.maximum);
  for (const directory of directories.keys()) await inspectDirectory(directory);
  check();
  const receiptSha256 = hash(receiptBytes), currentSha256 = hash(pointer);
  const policySha256 = hash(Buffer.from(JSON.stringify(policy)));
  return {
    installRoot, stableLauncher, receiptSha256, currentSha256, stableLauncherSha256, policySha256,
    identity: JSON.stringify([installRoot, receiptSha256, currentSha256, stableLauncherSha256, policySha256, [...directories]])
  };
}
