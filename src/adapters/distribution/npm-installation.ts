import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { lastHistoricalNpmVersion, legacyNpmPackageName, type LegacyInstallationFacts } from '../../domain/distribution/contracts.js';
import { compareSemver } from '../../semver.js';
import { DistributionError } from '../../domain/distribution/errors.js';
import { digest, freeze, stableVersion } from '../../domain/distribution/validation.js';
import { type CommandRunner } from '../../process-runner.js';
import { NativeCommandRunner } from './native-command-runner.js';
import { expectedGlobalPackageRoot, inspectReleasedNpmInstallation } from '../../self-upgrade.js';
import { Writable } from 'node:stream';
import { assertNativeCommandSucceeded, nativeProbeEnvironment } from './native-admission.js';
import {
  canonicalNativeRoot, hashNativeFile, inventoryNativeTree, ioCode, nativeDirectorySnapshot, nativePathParts, readNativeJson, resolveNativeEntrypoint
} from './native-files.js';
import { environmentValue, launcherDigest, observeLauncher, observePathLaunchers, type LauncherObservation } from './launcher-observation.js';
import { resolveNpmToolInvocation } from './npm-invocation.js';

export interface NpmInstallationOptions {
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  npmExecutable?: string;
  windowsLauncherInventory?: {
    packageName: typeof legacyNpmPackageName;
    packageVersion: string;
    prefix: string;
    generator: 'npm.cmd-shim';
    generatorIdentity: string;
    files: Readonly<Record<string, string>>;
  };
}

export interface ObservedNpmInstallation {
  facts: LegacyInstallationFacts;
  packageDigest: string;
  toolDigest: string;
  configurationDigest: string;
  launchers: readonly LauncherObservation[];
  npmExecutable: string;
  npmArgsPrefix: readonly string[];
  neutralDirectory: string;
}

export class NpmInstallationAdapter {
  private readonly runner: CommandRunner;
  readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly executable?: string;
  private readonly windowsLauncherInventory?: NpmInstallationOptions['windowsLauncherInventory'];

  constructor(options: NpmInstallationOptions = {}) {
    this.runner = options.runner ?? new NativeCommandRunner();
    this.env = Object.freeze({ ...options.env ?? process.env });
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.executable = options.npmExecutable;
    this.windowsLauncherInventory = options.windowsLauncherInventory
      ? freeze({ ...options.windowsLauncherInventory, files: { ...options.windowsLauncherInventory.files } }) : undefined;
  }

  private async npmTool(): Promise<string> {
    if (this.executable) return resolveNativeEntrypoint(this.executable, this.cwd);
    const envPath = environmentValue(this.env, 'PATH') ?? '';
    for (const directory of envPath.split(path.delimiter)) {
      if (!directory || !path.isAbsolute(directory)) continue;
      const candidate = path.join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm');
      try { return await resolveNativeEntrypoint(candidate, this.cwd); }
      catch (error) { if (ioCode(error) !== 'ENOENT' && ioCode(error) !== 'ENOTDIR') throw error; }
    }
    throw new DistributionError('The legacy npm owner cannot be inspected because its selected npm tool is unavailable.', 'tool_unavailable');
  }

  private async run(executable: string, args: string[], neutralDirectory: string, argsPrefix: readonly string[]): Promise<string> {
    const result = await this.runner.run({ executable, args: [...argsPrefix, ...args, '--logs-max=0', '--no-update-notifier', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'] }, {
      cwd: neutralDirectory, timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024, ensureProcessTreeSettled: true,
      env: {
        ...nativeProbeEnvironment(this.env), NPM_CONFIG_UPDATE_NOTIFIER: 'false', NPM_CONFIG_AUDIT: 'false',
        NPM_CONFIG_FUND: 'false', NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_LOGS_MAX: '0', NPM_CONFIG_OFFLINE: 'true'
      }
    });
    assertNativeCommandSucceeded(result, 'Legacy npm ownership inspection');
    return result.stdout.trim();
  }

  async inspect(entrypoint: string): Promise<ObservedNpmInstallation | undefined> {
    const executablePath = await resolveNativeEntrypoint(entrypoint, this.cwd);
    let packageRoot = path.dirname(executablePath);
    let metadata: Record<string, unknown> | undefined;
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        const raw = await readNativeJson(await canonicalNativeRoot(packageRoot), 'package.json');
        if (isRecord(raw) && raw.name === legacyNpmPackageName) { metadata = raw; break; }
      } catch (error) {
        if (ioCode(error) !== 'ENOENT' && !(error instanceof DistributionError && error.message === 'Required native metadata is missing.')) throw error;
      }
      const parent = path.dirname(packageRoot);
      if (parent === packageRoot) break;
      packageRoot = parent;
    }
    if (!metadata) return undefined;
    const installedVersion = stableVersion(metadata.version);
    if (compareSemver(installedVersion, lastHistoricalNpmVersion) > 0) {
      throw new DistributionError('This version is not a retained historical npm publication; native-only candidates have no npm replacement authority.', 'ownership_unknown');
    }
    if (!isRecord(metadata.bin) || typeof metadata.bin.liftoff !== 'string' ||
        path.join(packageRoot, ...nativePathParts(metadata.bin.liftoff)) !== executablePath) {
      throw new DistributionError('Legacy package metadata does not identify the actual Liftoff entrypoint.', 'ownership_unknown');
    }
    const globalRoot = path.dirname(path.dirname(packageRoot));
    const prefix = process.platform === 'win32' ? path.dirname(globalRoot) : path.dirname(path.dirname(globalRoot));
    if (expectedGlobalPackageRoot(globalRoot, process.platform) !== packageRoot ||
        path.basename(globalRoot) !== 'node_modules' || process.platform !== 'win32' && path.basename(path.dirname(globalRoot)) !== 'lib') {
      throw new DistributionError('Local, cache, or linked package origins do not establish global npm ownership.', 'ownership_unknown');
    }
    await canonicalNativeRoot(prefix);
    const lock = await readNativeJson(globalRoot, '.package-lock.json');
    const lockKey = '@msn-control/liftoff';
    if (!isRecord(lock) || !isRecord(lock.packages)) throw new DistributionError('Legacy npm artifact identity is missing from its installed lock record.', 'ownership_unknown');
    const installed = lock.packages[lockKey] ?? lock.packages[`node_modules/${lockKey}`];
    if (!isRecord(installed) || installed.version !== installedVersion || typeof installed.integrity !== 'string' ||
        !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(installed.integrity) || typeof installed.resolved !== 'string') {
      throw new DistributionError('Legacy npm package/version/artifact integrity cannot be established.', 'ownership_unknown');
    }
    let artifact: URL;
    try { artifact = new URL(installed.resolved); }
    catch { throw new DistributionError('Legacy package has no valid retained registry artifact identity.', 'ownership_unknown'); }
    if (artifact.protocol !== 'https:' || artifact.username || artifact.password) {
      throw new DistributionError('Linked, local-file, or credential-bearing origins cannot establish historical npm ownership.', 'ownership_unknown');
    }
    const npmLauncher = await this.npmTool();
    const invocation = await resolveNpmToolInvocation(npmLauncher, this.env, this.cwd);
    const npmExecutable = invocation.executable;
    const npmArgsPrefix = invocation.argsPrefix;
    const tool = await hashNativeFile(await canonicalNativeRoot(path.dirname(npmLauncher)), [path.basename(npmLauncher)]);
    const neutralDirectory = await canonicalNativeRoot(environmentValue(this.env, process.platform === 'win32' ? 'USERPROFILE' : 'HOME') ?? os.homedir());
    let nodeExecutable = invocation.nodeExecutable;
    for (const directory of nodeExecutable ? [] : (environmentValue(this.env, 'PATH') ?? '').split(path.delimiter)) {
      if (!path.isAbsolute(directory)) continue;
      try {
        nodeExecutable = await resolveNativeEntrypoint(path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node'), this.cwd);
        break;
      } catch (error) { if (ioCode(error) !== 'ENOENT' && ioCode(error) !== 'ENOTDIR') throw error; }
    }
    const silent = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const released = await inspectReleasedNpmInstallation({
      mode: 'check', currentVersion: installedVersion, runningPackageRoot: packageRoot,
      stdout: silent, stderr: silent, json: true
    }, neutralDirectory, {
      runner: {
        run: async (command, options) => {
          if (!['npm', 'npm.cmd'].includes(command.executable) || command.args[0] !== 'root') {
            throw new DistributionError('Historical owner inspection requested an unregistered effect.', 'ownership_unknown');
          }
          const result = await this.runner.run({
            executable: npmExecutable,
            args: [...npmArgsPrefix, ...command.args, '--logs-max=0', '--no-update-notifier', '--ignore-scripts', '--offline', '--no-audit', '--no-fund']
          }, {
            ...options, cwd: neutralDirectory, env: nativeProbeEnvironment(options?.env ?? this.env),
            ensureProcessTreeSettled: true, maxOutputBytes: 64 * 1024
          });
          assertNativeCommandSucceeded(result, 'Released legacy npm ownership inspection');
          return result;
        }
      },
      readJson: (file) => readNativeJson(path.dirname(file), path.basename(file)),
      lstat, realpath, platform: process.platform, environment: nativeProbeEnvironment(this.env),
      // A non-Node tool path cannot qualify the released Homebrew-Node exception.
      execPath: nodeExecutable ?? npmExecutable,
      lookupStableRelease: async () => { throw new DistributionError('Installation ownership does not query npm release targets.'); },
      makeNeutralDirectory: async () => neutralDirectory,
      removeNeutralDirectory: async () => { throw new DistributionError('Read-only ownership inspection cannot remove a working directory.'); }
    });
    if (released.packageRoot !== packageRoot) throw new DistributionError('The released npm owner probe does not identify this actual Liftoff package.', 'ownership_unknown');
    for (let current = prefix; current !== neutralDirectory && current !== path.dirname(current); current = path.dirname(current)) {
      for (const marker of ['liftoff.manifest.json', 'package.json', 'pyproject.toml', 'go.mod']) {
        try {
          await lstat(path.join(current, marker));
          throw new DistributionError('Project dependencies cannot become global CLI retirement targets.', 'ownership_conflict');
        } catch (error) { if (ioCode(error) !== 'ENOENT') throw error; }
      }
    }
    const registry = async (prefixSelected: boolean): Promise<string> => {
      const suffix = prefixSelected ? ['--global', '--prefix', prefix] : ['--global'];
      let value = await this.run(npmExecutable, ['config', 'get', '@msn-control:registry', ...suffix], neutralDirectory, npmArgsPrefix);
      if (value === 'undefined' || value === 'null' || value === '') {
        value = await this.run(npmExecutable, ['config', 'get', 'registry', ...suffix], neutralDirectory, npmArgsPrefix);
      }
      let parsed: URL;
      try { parsed = new URL(value); }
      catch { throw new DistributionError('The configured legacy npm delivery source is invalid.', 'source_unavailable'); }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new DistributionError('Legacy delivery policy has an unsupported or credential-bearing source URL.', 'source_unavailable');
      }
      return parsed.href.replace(/\/$/u, '');
    };
    const [machineRegistry, prefixRegistry] = await Promise.all([registry(false), registry(true)]);
    if (machineRegistry !== prefixRegistry) throw new DistributionError('Legacy prefix and neutral machine delivery policy differ; the prefix is not guessed or reconfigured.', 'source_changed');
    const configurationFiles = [];
    const selectedConfigPaths = [
      path.join(neutralDirectory, '.npmrc'), path.join(prefix, 'etc', 'npmrc'),
      ...Object.entries(this.env).filter(([key]) => /^(npm_config_userconfig|npm_config_globalconfig)$/iu.test(key)).map(([, value]) => value)
    ];
    for (const file of selectedConfigPaths) {
      if (!file || !path.isAbsolute(file)) throw new DistributionError('Explicit legacy npm configuration paths must be absolute and context-bound.', 'source_changed');
      try {
        configurationFiles.push({ path: file, file: await hashNativeFile(await canonicalNativeRoot(path.dirname(file)), [path.basename(file)], 2 * 1024 * 1024) });
      } catch (error) {
        if (ioCode(error) !== 'ENOENT') throw error;
        configurationFiles.push({ path: file, absent: true });
      }
    }
    const reportedRoot = await this.run(npmExecutable, ['root', '--global', '--prefix', prefix], neutralDirectory, npmArgsPrefix);
    if (!path.isAbsolute(reportedRoot) || await realpath(reportedRoot) !== globalRoot) {
      throw new DistributionError('The npm manager record does not identify the exact legacy prefix.', 'ownership_unknown');
    }
    const packagesText = await this.run(npmExecutable, ['ls', '--global', '--depth=0', '--json', '--long', '--prefix', prefix], neutralDirectory, npmArgsPrefix);
    let packages: unknown;
    try { packages = JSON.parse(packagesText); }
    catch { throw new DistributionError('npm installed-package observation returned malformed JSON.', 'invalid_metadata'); }
    const dependency = isRecord(packages) && isRecord(packages.dependencies) ? packages.dependencies[legacyNpmPackageName] : undefined;
    if (!isRecord(dependency) || dependency.version !== installedVersion || dependency.path !== packageRoot || dependency.link === true) {
      throw new DistributionError('npm does not record this exact unlinked global Liftoff package.', 'ownership_unknown');
    }
    const expectedLauncher = path.join(prefix, process.platform === 'win32' ? 'liftoff.cmd' : 'bin/liftoff');
    const launcher = await observeLauncher(expectedLauncher);
    if (process.platform !== 'win32' && (launcher.state !== 'link' || launcher.resolved !== executablePath) ||
        process.platform === 'win32' && launcher.state !== 'file') {
      throw new DistributionError('Legacy npm launcher is not owned by the observed package.', 'ownership_unknown');
    }
    const launchers = [launcher];
    if (process.platform === 'win32') {
      const registered = this.windowsLauncherInventory;
      if (!registered) {
        throw new DistributionError(
          'Exact Windows npm-generated launcher ownership has not been qualified and registered; matching names or command substrings grant no retirement authority.',
          'qualification_required'
        );
      }
      if (registered.generator !== 'npm.cmd-shim' || registered.packageName !== legacyNpmPackageName ||
          registered.packageVersion !== installedVersion || registered.prefix !== prefix ||
          Object.keys(registered.files).some((name) => !['liftoff', 'liftoff.cmd', 'liftoff.ps1'].includes(name))) {
        throw new DistributionError('The exact Windows npm-generated launcher inventory is not registered; matching names or command substrings grant no retirement authority.', 'ownership_unknown');
      }
      digest(registered.generatorIdentity, 'Registered npm launcher-generator identity');
      for (const name of ['liftoff', 'liftoff.ps1']) {
        const extra = await observeLauncher(path.join(prefix, name));
        if (extra.state !== 'absent') launchers.push(extra);
      }
      for (const observed of launchers) {
        const expected = registered.files[path.basename(observed.path)];
        if (observed.state !== 'file' || !expected || observed.file.sha256 !== digest(expected, 'Registered npm shim digest')) {
          throw new DistributionError('An existing Windows launcher differs from its exact registered npm-owned bytes; it was preserved.', 'ownership_conflict');
        }
      }
      if (Object.keys(registered.files).length !== launchers.length) throw new DistributionError('Windows npm launcher inventory changed.', 'ownership_conflict');
    }
    const pathLaunchers = await observePathLaunchers(this.env, this.cwd);
    const inventory = await inventoryNativeTree(packageRoot, { allowInternalLinks: true });
    const configurationDigest = canonicalSha256({
      env: Object.fromEntries(Object.entries(this.env).filter(([, value]) => value !== undefined)),
      installedLock: canonicalSha256(lock), root: reportedRoot, packages: canonicalSha256(packages),
      neutralDirectory, configurationFiles, registry: canonicalSha256(machineRegistry)
    });
    const evidenceDigest = canonicalSha256({
      packageRoot, prefix, installedVersion, inventory: inventory.digest, tool, invocation, configurationDigest, launchers,
      directories: await Promise.all([prefix, globalRoot, path.dirname(packageRoot)].map(nativeDirectorySnapshot)),
      nodeExecutable: nodeExecutable ? await hashNativeFile(path.dirname(nodeExecutable), [path.basename(nodeExecutable)]) : null,
      launcherGenerator: this.windowsLauncherInventory ?? null
    });
    return {
      facts: {
        owner: 'npm', packageName: legacyNpmPackageName, installedVersion, executablePath, prefix, packageRoot,
        integrity: installed.integrity, evidenceDigest, launcherPath: expectedLauncher,
        launcherPaths: launchers.map((entry) => entry.path),
        launcherConflicts: pathLaunchers.filter((entry) => !launchers.some((known) => launcherDigest(known) === launcherDigest(entry))).map((entry) => entry.path)
      },
      packageDigest: inventory.digest, toolDigest: canonicalSha256({ tool, invocation }), configurationDigest,
      launchers, npmExecutable, npmArgsPrefix, neutralDirectory
    };
  }

  async recheck(observation: ObservedNpmInstallation): Promise<void> {
    const current = await this.inspect(observation.facts.executablePath);
    if (!current || current.facts.evidenceDigest !== observation.facts.evidenceDigest) {
      throw new DistributionError('Legacy owner, bytes, modes, directories, launcher, tool, or configuration changed after review.', 'stale_plan');
    }
  }

  async retire(observation: ObservedNpmInstallation): Promise<void> {
    await this.recheck(observation);
    const result = await this.runner.run({
      executable: observation.npmExecutable,
      args: [...observation.npmArgsPrefix, 'uninstall', '--global', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', observation.facts.prefix, legacyNpmPackageName]
    }, {
      cwd: observation.neutralDirectory, env: nativeProbeEnvironment(this.env), timeoutMs: 120_000,
      maxOutputBytes: 64 * 1024, ensureProcessTreeSettled: true
    });
    assertNativeCommandSucceeded(result, 'Exact legacy Liftoff package retirement');
    if (!await this.isRetired(observation)) throw new DistributionError('npm exited successfully but the exact legacy package or launcher remains.', 'verification_failed');
  }

  async isRetired(observation: ObservedNpmInstallation): Promise<boolean> {
    for (const target of [observation.facts.packageRoot, ...observation.launchers.map((entry) => entry.path)]) {
      if (!target) throw new DistributionError('Legacy retirement record has no exact package target.', 'ownership_unknown');
      try { await lstat(target); return false; }
      catch (error) { if (ioCode(error) !== 'ENOENT') throw error; }
    }
    return true;
  }
}
