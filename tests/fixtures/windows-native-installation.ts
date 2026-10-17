import { createHash } from 'node:crypto';
import path from 'node:path';
import { vi } from 'vitest';
import { nativeWindowsInstallerInputs } from '../../scripts/native-release.mjs';
import type { NativeBundleInventory } from '../../src/domain/distribution/native-upgrade.js';
import type { CommandRunner } from '../../src/process-runner.js';
import { upgradeWorld } from './installer-upgrade.js';
import { signedMaterial } from './native-stable-material.js';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

/** Producer/consumer source contract fixture; no actual Windows, registry, signer or manager qualification. */
export function windowsReceiptWorld() {
  const fixture = upgradeWorld({ platform: 'win32' });
  const policy = signedMaterial().policy;
  policy.homebrew = { cask: 'fixture/tools/liftoff', sourceRepository: 'fixture/tools', developerTeamId: 'ABCDEFGHIJ' };
  policy.winget = { packageIdentifier: 'Fixture.Liftoff', publisher: 'Fixture Publisher',
    certificateSha256: '0'.repeat(64), installerAppId: 'Fixture.Liftoff' };
  const local = 'C:\\Users\\Fixture\\AppData\\Local';
  const installRoot = path.win32.join(local, 'Programs', 'Liftoff');
  const names = ['runtime/node.exe', 'bin/liftoff.exe', 'application/dist/cli.js',
    'installation/native-bundle-contract.mjs', 'installation/native-install.mjs',
    'installation/native-release-admission.mjs', 'installation/release-policy.json'];
  const relativeFiles = new Map(names.map(name => [name, Buffer.from(`inert Windows ownership fixture ${name}`)]));
  const entries = names.map(name => {
    const bytes = relativeFiles.get(name)!;
    return { path: name, kind: 'file', bytes: bytes.length, sha256: hash(bytes), mode: 0o755 };
  });
  const inventory = { sha256: hash(JSON.stringify(entries)), entries };
  const manifest = {
    schemaVersion: 1, kind: 'liftoff-native-development-bundle', releaseReady: false,
    package: { name: '@msn-control/liftoff', version: '0.12.3' },
    source: { repository: 'voyager163/liftoff', commit: 'c'.repeat(40) },
    platform: { platform: 'win32', architecture: 'x64' }, launcher: 'bin/liftoff.exe',
    runtime: { executable: 'runtime/node.exe' }, inventory
  };
  const manifestSha256 = hash(json(manifest));
  const produced = nativeWindowsInstallerInputs(manifest, manifestSha256, policy);
  const bundleRoot = path.win32.join(installRoot, 'versions', produced.versionName);
  const packageRoot = path.win32.join(bundleRoot, 'application');
  const stableLauncher = path.win32.join(installRoot, 'bin', 'liftoff.exe');
  const files = new Map([...relativeFiles].map(([name, content]) => [path.win32.join(bundleRoot, name), content]));
  files.set(path.win32.join(bundleRoot, 'bundle.json'), json(manifest));
  const receiptFile = path.win32.join(installRoot, 'native-install.json'), pointerFile = path.win32.join(installRoot, 'current.txt');
  files.set(receiptFile, json(produced.receipt));
  files.set(pointerFile, Buffer.from(produced.pointer));
  files.set(stableLauncher, Buffer.from(relativeFiles.get('bin/liftoff.exe')!));
  for (const filename of files.keys()) {
    fixture.world.nodes.set(filename, { kind: 'file' });
    for (let directory = path.win32.dirname(filename);;) {
      fixture.world.nodes.set(directory, { kind: 'directory' });
      const parent = path.win32.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const installation: NativeBundleInventory = {
    packageRoot, bundleRoot, launcher: path.win32.join(bundleRoot, 'bin', 'liftoff.exe'),
    runtime: path.win32.join(bundleRoot, 'runtime', 'node.exe'), version: manifest.package.version,
    target: 'win32-x64', manifestSha256, inventorySha256: inventory.sha256, sourceCommit: manifest.source.commit,
    identity: 'fixture-local-inventory-only'
  };
  const runner = { run: vi.fn<CommandRunner['run']>(async command => ({
    command, displayCommand: 'inert Windows inventory process port', status: 0, signal: null, timedOut: false,
    stdout: JSON.stringify(inventory), stderr: ''
  })) };
  const environment: NodeJS.ProcessEnv = { LOCALAPPDATA: local };
  const dependencies = {
    ...fixture.dependencies, runner, architecture: 'x64', execPath: installation.runtime,
    environment, runningExecutable: path.win32.join(packageRoot, 'dist', 'cli.js'),
    resolveLiftoff: async () => stableLauncher, readJson: async () => policy,
    lstat: async (file: string) => {
      const stat = await fixture.dependencies.lstat(file);
      return Object.assign(stat, { nlink: 1, dev: 1, ino: Number.parseInt(hash(file).slice(0, 8), 16),
        uid: 1000, mode: stat.isDirectory() ? 0o40700 : 0o100600 });
    },
    lstatBigInt: async (file: string) => {
      const stat = await fixture.dependencies.lstat(file);
      return { ...stat, dev: 1n, ino: BigInt(`0x${hash(file).slice(0, 16)}`), uid: 1000n, gid: 1000n,
        mode: stat.isDirectory() ? 0o40700n : 0o100600n, nlink: 1n, rdev: 0n, size: BigInt(files.get(file)?.length ?? 0),
        blksize: 4096n, blocks: 0n, atimeMs: 0n, mtimeMs: 0n, ctimeMs: 0n, birthtimeMs: 0n,
        atimeNs: 0n, mtimeNs: 0n, ctimeNs: 0n, birthtimeNs: 0n };
    },
    readBytes: vi.fn(async (file: string, maximum: number) => {
      const bytes = files.get(file);
      if (!bytes) throw Object.assign(new Error('No fixture bytes'), { code: 'ENOENT' });
      if (bytes.length > maximum) throw new Error('Fixture byte bound exceeded');
      return Buffer.from(bytes);
    })
  };
  const winget = { packageIdentifier: policy.winget.packageIdentifier!, source: 'fixture-source',
    publisher: policy.winget.publisher!, certificateSha256: policy.winget.certificateSha256!,
    signatureStatus: 'valid' as const,
    appId: policy.winget.installerAppId!, scope: 'user' as const, installLocation: installRoot,
    bundleRoot, launcher: stableLauncher, installedVersion: installation.version,
    installerRegistration: { receiptSha256: hash(files.get(receiptFile)!), currentSha256: hash(files.get(pointerFile)!),
      launcherSha256: hash(files.get(stableLauncher)!) } };
  const cask = { fullToken: policy.homebrew.cask!, sourceRepository: policy.homebrew.sourceRepository!,
    bundleRoot, launcher: installation.launcher, installedVersion: installation.version };
  return { ...fixture, dependencies, installation, policy, manifest, produced, files, runner, packageRoot, installRoot,
    stableLauncher, receiptFile, pointerFile, winget, cask };
}
