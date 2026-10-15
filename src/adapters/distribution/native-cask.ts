import { createHash } from 'node:crypto';
import path from 'node:path';
import { commandFailed, readOnlyEnvironment } from '../../domain/distribution/liftoff-npm-installation.js';
import { SelfUpgradeFailure, selfUpgradeProbeTimeoutMs } from '../../domain/distribution/liftoff-upgrade.js';
import type { NativeBundleInventory, NativeReleasePolicy } from '../../domain/distribution/native-upgrade.js';
import { isStableSemver } from '../../stable-release.js';
import type { CaskOwnershipObservation } from './native.js';
import type { SelfUpgradeDependencies } from './upgrade-host.js';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const invalid = () => new SelfUpgradeFailure('blocked', 'unsupported_installation');
const changed = () => new SelfUpgradeFailure('blocked', 'owner_changed');

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

export async function readHomebrewCaskOwnership(
  dependencies: SelfUpgradeDependencies, installation: NativeBundleInventory, policy: NativeReleasePolicy,
  neutralDirectory: string, signal: AbortSignal
): Promise<CaskOwnershipObservation & { receiptSha256: string; definitionSha256: string; tapCommit: string }> {
  const fullToken = policy.homebrew.cask;
  const repository = policy.homebrew.sourceRepository;
  if (!fullToken || !repository) throw new SelfUpgradeFailure('blocked', 'native_unqualified');
  if (dependencies.platform !== 'darwin' || installation.target !== 'darwin-arm64' ||
    !isStableSemver(installation.version) ||
    !/^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(fullToken) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw invalid();
  const [owner, tapName, token] = fullToken.split('/');
  const prefix = ['/opt/homebrew', '/usr/local'].find(value =>
    installation.bundleRoot === path.posix.join(value, 'Caskroom', token, installation.version));
  if (!prefix || installation.packageRoot !== path.posix.join(installation.bundleRoot, 'application') ||
    installation.launcher !== path.posix.join(installation.bundleRoot, 'bin', 'liftoff')) throw invalid();
  if (!dependencies.readBytes) throw new SelfUpgradeFailure('blocked', 'native_unavailable');
  const readBytes = dependencies.readBytes;
  const caskRoot = path.posix.join(prefix, 'Caskroom', token);
  const tapRoot = path.posix.join(prefix, 'Library', 'Taps', owner, `homebrew-${tapName}`);
  const receiptPath = path.posix.join(caskRoot, '.metadata', 'INSTALL_RECEIPT.json');
  const configPath = path.posix.join(tapRoot, '.git', 'config');
  const directories = new Map<string, string>();
  const fileBytes = new Map<string, { bytes: Buffer; maximum: number }>();
  const checkSignal = () => {
    if (signal.aborted) throw new SelfUpgradeFailure('failed', 'native_unavailable');
  };
  const directoryIdentity = async (directory: string) => {
    checkSignal();
    const stat = await dependencies.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await dependencies.realpath(directory) !== directory) throw invalid();
    checkSignal();
    return JSON.stringify([stat.dev, stat.ino, stat.uid, stat.mode]);
  };
  const inspectDirectories = async (directory: string) => {
    const relative = path.posix.relative(prefix, directory);
    if (relative.startsWith('..') || path.posix.isAbsolute(relative)) throw invalid();
    for (const item of [prefix, ...relative.split('/').map((_, index, parts) =>
      path.posix.join(prefix, ...parts.slice(0, index + 1)))]) {
      const identity = await directoryIdentity(item);
      const before = directories.get(item);
      if (before && before !== identity) throw changed();
      directories.set(item, identity);
    }
  };
  const file = async (filename: string, maximum: number) => {
    await inspectDirectories(path.posix.dirname(filename));
    const stat = await dependencies.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || await dependencies.realpath(filename) !== filename) throw invalid();
    const bytes = await readBytes(filename, maximum);
    if (bytes.length > maximum) throw invalid();
    checkSignal();
    return bytes;
  };
  const environment = Object.fromEntries(Object.entries(readOnlyEnvironment(dependencies, neutralDirectory))
    .filter(([key]) => !/^git_/i.test(key)));
  Object.assign(environment, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' });
  const git = async (...args: string[]) => {
    checkSignal();
    const result = await dependencies.runner.run({
      executable: 'git',
      args: ['--no-optional-locks', '--git-dir', path.posix.join(tapRoot, '.git'), '--work-tree', tapRoot, ...args]
    }, {
      cwd: neutralDirectory, env: environment, signal,
      timeoutMs: dependencies.probeTimeoutMs ?? selfUpgradeProbeTimeoutMs,
      maxOutputBytes: 8192, ensureProcessTreeSettled: true
    });
    checkSignal();
    if (commandFailed(result)) throw new SelfUpgradeFailure('failed', result.timedOut ? 'native_timeout' : 'native_unavailable');
    return result.stdout.trim();
  };
  try {
    await inspectDirectories(installation.bundleRoot);
    const receiptBytes = await file(receiptPath, 256 * 1024);
    fileBytes.set(receiptPath, { bytes: receiptBytes, maximum: 256 * 1024 });
    let receipt: Record<string, unknown>;
    try { receipt = record(JSON.parse(receiptBytes.toString('utf8'))); }
    catch { throw new SelfUpgradeFailure('blocked', 'native_invalid'); }
    const source = record(receipt.source);
    if (receipt.arch !== 'arm64' || source.tap !== `${owner}/${tapName}` ||
      source.version !== installation.version || typeof source.path !== 'string' ||
      typeof source.tap_git_head !== 'string' || !/^[a-f0-9]{40}$/.test(source.tap_git_head)) throw invalid();
    const definitionPath = source.path;
    const definitionRelative = path.posix.relative(path.posix.join(tapRoot, 'Casks'), definitionPath);
    if (!path.posix.isAbsolute(definitionPath) || path.posix.normalize(definitionPath) !== definitionPath ||
      definitionRelative.startsWith('..') || path.posix.isAbsolute(definitionRelative) ||
      path.posix.basename(definitionPath) !== `${token}.rb`) throw invalid();
    const definitionBytes = await file(definitionPath, 256 * 1024);
    fileBytes.set(definitionPath, { bytes: definitionBytes, maximum: 256 * 1024 });
    fileBytes.set(configPath, { bytes: await file(configPath, 64 * 1024), maximum: 64 * 1024 });
    const remote = await git('config', '--no-includes', '--local', '--get-all', 'remote.origin.url');
    const approvedRemotes = [
      `https://github.com/${repository}`, `https://github.com/${repository}.git`,
      `git@github.com:${repository}`, `git@github.com:${repository}.git`,
      `ssh://git@github.com/${repository}`, `ssh://git@github.com/${repository}.git`
    ];
    if (!approvedRemotes.some(value => value.toLowerCase() === remote.toLowerCase())) throw invalid();
    const tapCommit = await git('rev-parse', '--verify', 'HEAD');
    if (!/^[a-f0-9]{40}$/.test(tapCommit)) throw invalid();
    for (const [filename, before] of fileBytes) {
      if (!before.bytes.equals(await file(filename, before.maximum))) throw changed();
    }
    for (const [directory, before] of directories) {
      if (await directoryIdentity(directory) !== before) throw changed();
    }
    if (await git('rev-parse', '--verify', 'HEAD') !== tapCommit) throw changed();
    return {
      fullToken, sourceRepository: repository, installedVersion: installation.version,
      bundleRoot: installation.bundleRoot, launcher: installation.launcher,
      receiptSha256: sha256(receiptBytes), definitionSha256: sha256(definitionBytes), tapCommit
    };
  } catch (error) {
    if (error instanceof SelfUpgradeFailure) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw invalid();
    throw new SelfUpgradeFailure('failed', 'native_unavailable');
  }
}
