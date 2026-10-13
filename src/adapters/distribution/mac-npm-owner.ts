import { createHash } from 'node:crypto';
import { access, lstat, opendir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { inspectGlobalInstallation, inspectNpmFiles } from './npm.js';
import { readUpgradeBytes, type SelfUpgradeDependencies } from './upgrade-host.js';
import { commandFailed, readOnlyEnvironment } from '../../domain/distribution/liftoff-npm-installation.js';
import { MacMigrationFailure, type MacNpmOwner, type MacNpmSelection } from '../../domain/distribution/mac-migration.js';
import { isStableSemver } from '../../stable-release.js';

export const macMigrationHash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

export function assertMigrationOutsideOldScope(packageRoot: string, files: readonly string[]): void {
  if (files.some(file => file === packageRoot || file.startsWith(`${packageRoot}${path.sep}`))) {
    throw new MacMigrationFailure('migration-tool-overlaps-old-scope');
  }
}

export async function migrationFileIdentity(file: string, maximum = 8 * 1024 * 1024): Promise<string> {
  const bytes = await readUpgradeBytes(file, maximum);
  const stat = await lstat(file);
  return JSON.stringify([file, stat.dev, stat.ino, stat.uid, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs, macMigrationHash(bytes)]);
}

export async function migrationDirectory(directory: string, writable = false): Promise<string> {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || await realpath(directory) !== directory) {
    throw new MacMigrationFailure('noncanonical-directory');
  }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o7022) throw new MacMigrationFailure('unsafe-directory');
  if (writable) await access(directory, constants.W_OK | constants.X_OK);
  return JSON.stringify([directory, stat.dev, stat.ino, stat.uid, stat.mode]);
}

export function migrationEnvironment(dependencies: SelfUpgradeDependencies, scratch: string, node: string): NodeJS.ProcessEnv {
  const base = readOnlyEnvironment(dependencies, scratch);
  const kept = ['SystemRoot'];
  return {
    ...Object.fromEntries(Object.entries(base).filter(([key]) => kept.includes(key))),
    HOME: scratch, TMPDIR: scratch, XDG_CONFIG_HOME: path.join(scratch, 'config'),
    XDG_CACHE_HOME: path.join(scratch, 'cache'), XDG_STATE_HOME: path.join(scratch, 'state'),
    PATH: `${path.dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    NODE_OPTIONS: '', NODE_PATH: '', CI: 'true', DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0',
    npm_config_cache: path.join(scratch, 'npm-cache'), npm_config_userconfig: path.join(scratch, 'absent.npmrc'),
    npm_config_globalconfig: path.join(scratch, 'absent-global.npmrc'), npm_config_offline: 'true',
    npm_config_update_notifier: 'false', npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
    HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1',
    HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_INSTALL_FROM_API: '1',
    HOMEBREW_CACHE: path.join(scratch, 'homebrew-cache'), HOMEBREW_LOGS: path.join(scratch, 'homebrew-logs'),
    HOMEBREW_TEMP: scratch
  };
}

export async function migrationProbe(dependencies: SelfUpgradeDependencies, scratch: string, node: string,
  executable: string, args: string[]): Promise<string> {
  const result = await dependencies.runner.run({ executable, args }, {
    cwd: scratch, env: migrationEnvironment(dependencies, scratch, node), timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024, ensureProcessTreeSettled: true
  });
  if (commandFailed(result) || result.processTreeSettled !== true) throw new MacMigrationFailure('probe-not-settled');
  return result.stdout.trim();
}

async function canonicalExecutable(file: string): Promise<string> {
  if (!path.isAbsolute(file) || /[\u0000-\u001f]/.test(file)) throw new MacMigrationFailure('invalid-executable');
  const canonical = await realpath(file);
  await migrationDirectory(path.dirname(canonical));
  await access(canonical, constants.X_OK);
  return canonical;
}

export async function inspectMacNpmOwner(selection: MacNpmSelection, dependencies: SelfUpgradeDependencies,
  scratch: string): Promise<MacNpmOwner> {
  const prefix = selection.prefix;
  const packageRoot = path.join(prefix, 'lib/node_modules/@msn-control/liftoff');
  // Inspect the selected old root, never the independently packaged utility's root.
  try {
    await lstat(path.join(packageRoot, '.git'));
    throw new MacMigrationFailure('source-checkout');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const metadata: unknown = JSON.parse((await readUpgradeBytes(path.join(packageRoot, 'package.json'), 64 * 1024)).toString('utf8'));
  if (!metadata || typeof metadata !== 'object' || !('version' in metadata) || !isStableSemver(metadata.version)) {
    throw new MacMigrationFailure('invalid-old-version');
  }
  const version = metadata.version;
  const node = await canonicalExecutable(selection.node);
  const npm = await canonicalExecutable(selection.npm);
  assertMigrationOutsideOldScope(packageRoot, [node, npm,
    ...(selection.managerExecutable ? [await canonicalExecutable(selection.managerExecutable)] : [])]);
  const npmRoot = path.dirname(path.dirname(npm));
  const npmMetadata: unknown = JSON.parse((await readUpgradeBytes(path.join(npmRoot, 'package.json'), 64 * 1024)).toString('utf8'));
  if (path.basename(npm) !== 'npm-cli.js' || path.basename(path.dirname(npm)) !== 'bin' ||
    !npmMetadata || typeof npmMetadata !== 'object' || !('name' in npmMetadata) || npmMetadata.name !== 'npm' ||
    !('version' in npmMetadata) || !isStableSemver(npmMetadata.version)) throw new MacMigrationFailure('unproven-npm-executable');
  const directoryIdentity = [];
  for (const directory of [prefix, path.join(prefix, 'bin'), path.join(prefix, 'lib'),
    path.join(prefix, 'lib/node_modules'), path.dirname(packageRoot)]) {
    directoryIdentity.push(await migrationDirectory(directory));
  }
  const files = await inspectNpmFiles(packageRoot, version, { ...dependencies, platform: 'darwin' });
  const launcher = path.join(prefix, 'bin/liftoff');
  const link = await lstat(launcher);
  if (!link.isSymbolicLink() || await realpath(launcher) !== files.binary) throw new MacMigrationFailure('unproven-old-launcher');
  const probe = (executable: string, args: string[]) => migrationProbe(dependencies, scratch, node, executable, args);
  if (await probe(node, [npm, '--version']) !== npmMetadata.version) throw new MacMigrationFailure('npm-version-mismatch');
  if (selection.manager === 'nvm') {
    if (!selection.managerRoot) throw new MacMigrationFailure('missing-nvm-root');
    const root = await realpath(selection.managerRoot);
    const relative = path.relative(root, node).split(path.sep);
    if (relative.length !== 5 || relative[0] !== 'versions' || relative[1] !== 'node' ||
      !/^v\d+\.\d+\.\d+$/.test(relative[2]) || relative[3] !== 'bin' || relative[4] !== 'node' ||
      prefix !== path.join(root, ...relative.slice(0, 3))) throw new MacMigrationFailure('unproven-nvm-owner');
  } else if (selection.manager === 'homebrew-node') {
    if (!selection.managerExecutable || !selection.managerRoot) throw new MacMigrationFailure('missing-homebrew-node-owner');
    const brew = await canonicalExecutable(selection.managerExecutable);
    const root = await probe(brew, ['--prefix']);
    const parts = path.relative(root, node).split(path.sep);
    if (root !== selection.managerRoot || prefix !== root || parts.length !== 5 || parts[0] !== 'Cellar' ||
      !['node', `node@${parts[2]?.split('.')[0]}`].includes(parts[1]) ||
      !/^\d+\.\d+\.\d+(?:_\d+)?$/.test(parts[2]) || parts[3] !== 'bin' || parts[4] !== 'node') {
      throw new MacMigrationFailure('unproven-homebrew-node-owner');
    }
  } else if (selection.manager === 'volta') {
    if (!selection.managerExecutable || !selection.managerRoot) throw new MacMigrationFailure('missing-volta-owner');
    const volta = await canonicalExecutable(selection.managerExecutable);
    const root = await realpath(selection.managerRoot);
    const which = async (name: string) => {
      const result = await dependencies.runner.run({ executable: volta, args: ['which', name] }, {
        cwd: scratch, env: { ...migrationEnvironment(dependencies, scratch, node), VOLTA_HOME: root, VOLTA_LOGLEVEL: 'off' },
        timeoutMs: 10_000, maxOutputBytes: 64 * 1024, ensureProcessTreeSettled: true
      });
      if (commandFailed(result) || result.processTreeSettled !== true) throw new MacMigrationFailure('probe-not-settled');
      return realpath(result.stdout.trim());
    };
    if (!node.startsWith(`${root}/tools/image/`) || await which('node') !== node ||
      await which('npm') !== npm || await which('liftoff') !== files.binary) throw new MacMigrationFailure('unproven-volta-owner');
  } else if (selection.manager !== 'custom') throw new MacMigrationFailure('unsupported-npm-manager');

  const runner: SelfUpgradeDependencies['runner'] = {
    run: (command, options) => dependencies.runner.run({
      executable: node, args: [npm, ...command.args, '--prefix', prefix]
    }, { ...options, env: migrationEnvironment(dependencies, scratch, node) })
  };
  const installation = await inspectGlobalInstallation({ currentVersion: version, runningPackageRoot: packageRoot,
    runningExecutable: files.binary }, scratch, {
    ...dependencies, platform: 'darwin', execPath: node, runner, resolveLiftoff: async () => launcher
  });
  const tools = [await migrationFileIdentity(node, 256 * 1024 * 1024),
    await migrationFileIdentity(npm), await migrationFileIdentity(path.join(npmRoot, 'package.json'))];
  if (selection.managerExecutable) tools.push(await migrationFileIdentity(await realpath(selection.managerExecutable)));
  return { ...selection, npm, node, packageRoot, version, binary: files.binary, launcher,
    tools,
    identity: macMigrationHash(JSON.stringify([selection, installation.identity, directoryIdentity, tools, link.dev, link.ino, link.ctimeMs])) };
}

export async function assertMigrationTools(owner: MacNpmOwner): Promise<void> {
  const tools = [await migrationFileIdentity(owner.node, 256 * 1024 * 1024),
    await migrationFileIdentity(owner.npm), await migrationFileIdentity(path.join(path.dirname(path.dirname(owner.npm)), 'package.json'))];
  if (owner.managerExecutable) tools.push(await migrationFileIdentity(await realpath(owner.managerExecutable)));
  if (JSON.stringify(tools) !== JSON.stringify(owner.tools)) throw new MacMigrationFailure('owning-tools-changed');
}

export async function discoverMacNpmSelections(environment: NodeJS.ProcessEnv): Promise<MacNpmSelection[]> {
  const directories = (environment.PATH ?? '').split(':');
  if (directories.length > 64 || directories.some(item => !path.isAbsolute(item))) throw new MacMigrationFailure('ambiguous-path');
  const selections = new Map<string, MacNpmSelection>();
  for (const directory of new Set(directories)) {
    const npm = path.join(directory, 'npm');
    try {
      const npmFile = await realpath(npm);
      const node = await realpath(path.join(directory, 'node'));
      const prefix = path.dirname(directory);
      let manager: MacNpmSelection['manager'] = 'custom';
      let managerRoot: string | undefined;
      let managerExecutable: string | undefined;
      if (environment.NVM_DIR && node.startsWith(`${environment.NVM_DIR}/versions/node/`)) {
        manager = 'nvm'; managerRoot = environment.NVM_DIR;
      } else if (environment.VOLTA_HOME && node.startsWith(`${environment.VOLTA_HOME}/tools/image/`)) {
        manager = 'volta'; managerRoot = environment.VOLTA_HOME; managerExecutable = path.join(managerRoot, 'bin/volta');
      } else if (node.startsWith('/opt/homebrew/Cellar/')) {
        manager = 'homebrew-node'; managerRoot = '/opt/homebrew'; managerExecutable = '/opt/homebrew/bin/brew';
      }
      const selected = { npm: npmFile, node, prefix, manager, ...(managerRoot ? { managerRoot } : {}),
        ...(managerExecutable ? { managerExecutable } : {}) };
      selections.set(JSON.stringify([npmFile, node, prefix]), selected);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return [...selections.values()];
}

export async function migrationNames(directory: string, maximum: number): Promise<string[]> {
  const handle = await opendir(directory);
  const names = [];
  try {
    for (;;) {
      const entry = await handle.read();
      if (!entry) break;
      if (names.length === maximum) throw new MacMigrationFailure('inventory-limit');
      names.push(entry.name);
    }
  } finally { await handle.close(); }
  if (new Set(names.map(name => name.normalize('NFC').toLowerCase())).size !== names.length) {
    throw new MacMigrationFailure('path-alias');
  }
  return names.sort();
}
