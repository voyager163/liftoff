import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CommandResult,
  CommandRunner,
  RunCommandOptions
} from '../src/process-runner.js';
import {
  buildGlobalNpmInstallCommand,
  expectedGlobalPackageRoot,
  pathIsContained,
  runSelfUpgrade,
  selfUpgradeExitCode,
  selfUpgradeRemedy,
  type SelfUpgradeDependencies,
  type SelfUpgradeRequest
} from '../src/self-upgrade.js';
import type { ExternalCommand } from '../src/types.js';
import { CaptureStream } from './helpers.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    )
  );
});

function commandResult(
  command: ExternalCommand,
  values: Partial<CommandResult> = {}
): CommandResult {
  return {
    command,
    displayCommand: [command.executable, ...command.args].join(' '),
    status: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...values
  };
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, fullPath);
      if (entry.isDirectory()) {
        snapshot[`${relativePath}/`] = 'directory';
        await walk(fullPath);
      } else {
        snapshot[relativePath] = (await readFile(fullPath)).toString('base64');
      }
    }
  };
  await walk(root);
  return snapshot;
}

interface RunnerOptions {
  registry?: string;
  targetVersion?: string;
  viewResult?: Partial<CommandResult>;
  installResult?: Partial<CommandResult>;
  versionOutput?: string;
  onInstall?: () => Promise<void>;
}

class UpgradeRunner implements CommandRunner {
  readonly calls: Array<{
    command: ExternalCommand;
    options?: RunCommandOptions;
  }> = [];
  rootCalls = 0;

  constructor(
    readonly globalRoot: string,
    private readonly options: RunnerOptions = {}
  ) {}

  async run(
    command: ExternalCommand,
    options?: RunCommandOptions
  ): Promise<CommandResult> {
    this.calls.push({ command, options });
    if (command.args.join(' ') === 'root --global') {
      this.rootCalls += 1;
      return commandResult(command, { stdout: `${this.globalRoot}\n` });
    }
    if (command.args.join(' ') === 'config get registry') {
      return commandResult(command, {
        stdout: `${this.options.registry ?? 'https://registry.npmjs.org/'}\n`
      });
    }
    if (command.args[0] === 'view') {
      return commandResult(command, {
        stdout: JSON.stringify({
          name: '@msn-control/liftoff',
          version: this.options.targetVersion ?? '0.8.0'
        }),
        ...this.options.viewResult
      });
    }
    if (command.args[0] === 'install') {
      await this.options.onInstall?.();
      return commandResult(command, {
        stdout: 'installed\n',
        ...this.options.installResult
      });
    }
    if (command.executable === process.execPath) {
      return commandResult(command, {
        stdout: `${this.options.versionOutput ?? 'Liftoff 0.8.0'}\n`
      });
    }
    return commandResult(command);
  }
}

async function writePackage(
  packageRoot: string,
  version: string,
  values: {
    name?: string;
    bin?: unknown;
    binaryKind?: 'file' | 'directory';
  } = {}
): Promise<void> {
  const bin = values.bin ?? { liftoff: 'dist/cli.js' };
  await mkdir(path.join(packageRoot, 'dist'), { recursive: true });
  await writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify({
    name: values.name ?? '@msn-control/liftoff',
    version,
    bin
  }, null, 2)}\n`);
  if (values.binaryKind === 'directory') {
    await mkdir(path.join(packageRoot, 'dist', 'cli.js'), { recursive: true });
  } else {
    await writeFile(path.join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
  }
}

async function harness(values: {
  currentVersion?: string;
  targetVersion?: string;
  mode?: 'apply' | 'check';
  runningPackageRoot?: string;
  runnerOptions?: RunnerOptions;
  packageValues?: Parameters<typeof writePackage>[2];
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-upgrade-test-'));
  temporaryRoots.push(root);
  const globalRoot = path.join(root, 'global', 'node_modules');
  const packageRoot = expectedGlobalPackageRoot(globalRoot, process.platform);
  const neutralDirectory = path.join(root, 'neutral');
  const currentVersion = values.currentVersion ?? '0.7.0';
  const targetVersion = values.targetVersion ?? '0.8.0';
  await mkdir(globalRoot, { recursive: true });
  await mkdir(neutralDirectory, { recursive: true });
  await writePackage(packageRoot, currentVersion, values.packageValues);
  await writeFile(path.join(root, '.npmrc'), 'registry=https://malicious.example.test/\n');

  const runner = new UpgradeRunner(globalRoot, {
    targetVersion,
    onInstall: async () => writePackage(packageRoot, targetVersion),
    ...values.runnerOptions
  });
  const lookup = vi.fn().mockResolvedValue({
    name: '@msn-control/liftoff',
    version: targetVersion
  });
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const request: SelfUpgradeRequest = {
    mode: values.mode ?? 'check',
    currentVersion,
    stdout,
    stderr,
    json: false,
    runningPackageRoot: values.runningPackageRoot ?? packageRoot
  };
  const dependencies: Partial<SelfUpgradeDependencies> = {
    runner,
    lookupStableRelease: lookup,
    makeNeutralDirectory: async () => neutralDirectory,
    removeNeutralDirectory: async () => undefined,
    readJson: async (filePath) => JSON.parse(await readFile(filePath, 'utf8')),
    lstat,
    realpath,
    platform: process.platform,
    execPath: process.execPath,
    environment: { npm_config_registry: 'https://registry.npmjs.org/' }
  };
  return {
    root,
    globalRoot,
    packageRoot,
    neutralDirectory,
    currentVersion,
    targetVersion,
    runner,
    lookup,
    stdout,
    stderr,
    request,
    dependencies
  };
}

describe('self-upgrade state machine', () => {
  it('returns current in check and apply modes without registry or install calls', async () => {
    for (const mode of ['check', 'apply'] as const) {
      const fixture = await harness({ mode, targetVersion: '0.7.0' });
      const result = await runSelfUpgrade(fixture.request, fixture.dependencies);
      expect(result).toEqual({
        schemaVersion: 1,
        mode,
        status: 'current',
        currentVersion: '0.7.0',
        reasonCode: 'current'
      });
      expect(selfUpgradeExitCode(result)).toBe(0);
      expect(fixture.runner.calls.map(({ command }) => command.args[0]))
        .toEqual(['root']);
    }
  });

  it('reports a read-only installable update with byte-pure fields', async () => {
    const fixture = await harness({ mode: 'check' });
    const userCache = path.join(fixture.root, 'user-cache');
    await mkdir(userCache);
    await writeFile(path.join(userCache, 'marker'), 'unchanged\n');
    fixture.dependencies.environment = {
      ...fixture.dependencies.environment,
      npm_config_cache: userCache
    };
    const currentDirectory = process.cwd();
    const treeBefore = await snapshotTree(fixture.root);
    const before = await Promise.all([
      readFile(path.join(fixture.packageRoot, 'package.json')),
      readFile(path.join(fixture.root, '.npmrc'))
    ]);
    const result = await runSelfUpgrade(fixture.request, fixture.dependencies);
    expect(result).toEqual({
      schemaVersion: 1,
      mode: 'check',
      status: 'update-available',
      currentVersion: '0.7.0',
      targetVersion: '0.8.0',
      registryKind: 'canonical',
      reasonCode: 'update_available'
    });
    expect(Object.values(result)).not.toContain(undefined);
    expect(selfUpgradeExitCode(result)).toBe(2);
    expect(fixture.runner.calls.some(({ command }) => command.args[0] === 'install'))
      .toBe(false);
    expect(await Promise.all([
      readFile(path.join(fixture.packageRoot, 'package.json')),
      readFile(path.join(fixture.root, '.npmrc'))
    ])).toEqual(before);
    expect(await snapshotTree(fixture.root)).toEqual(treeBefore);
    expect(process.cwd()).toBe(currentDirectory);
    expect(fixture.runner.calls.every(({ options }) =>
      options?.cwd === fixture.neutralDirectory
    )).toBe(true);
  });

  it('uses configured registry parity without forcing a registry install argument', async () => {
    const fixture = await harness({
      mode: 'apply',
      runnerOptions: { registry: 'https://packages.example.test/npm/' }
    });
    const result = await runSelfUpgrade(fixture.request, fixture.dependencies);
    expect(result).toMatchObject({
      status: 'upgraded',
      registryKind: 'configured',
      targetVersion: '0.8.0',
      reasonCode: 'upgrade_complete'
    });
    expect(selfUpgradeExitCode(result)).toBe(0);
    const install = fixture.runner.calls.find(({ command }) =>
      command.args[0] === 'install'
    )!;
    expect(install.command).toEqual(
      buildGlobalNpmInstallCommand('0.8.0', process.platform)
    );
    expect(install.command.args.join(' ')).not.toMatch(
      /--registry|latest|sudo|run-scripts/
    );
    expect(install.options).toMatchObject({
      cwd: fixture.neutralDirectory,
      stream: true
    });
    const verification = fixture.runner.calls.find(({ command }) =>
      command.executable === process.execPath
    )!;
    expect(verification.options?.env).toMatchObject({
      CI: 'true',
      DO_NOT_TRACK: '1',
      LIFTOFF_TELEMETRY: '0'
    });
    expect(fixture.runner.rootCalls).toBe(2);
  });

  it('routes child stdout to stderr in JSON mode', async () => {
    const fixture = await harness({ mode: 'apply' });
    fixture.request.json = true;
    const result = await runSelfUpgrade(fixture.request, fixture.dependencies);
    expect(result.status).toBe('upgraded');
    const install = fixture.runner.calls.find(({ command }) =>
      command.args[0] === 'install'
    )!;
    expect(install.options?.stdout).toBe(fixture.stderr);
    expect(install.options?.stderr).toBe(fixture.stderr);
  });

  it('refuses local and linked origins before canonical lookup', async () => {
    const local = await harness();
    const localRoot = path.join(local.root, 'project', 'node_modules', '@msn-control', 'liftoff');
    await writePackage(localRoot, local.currentVersion);
    local.request.runningPackageRoot = localRoot;
    const localResult = await runSelfUpgrade(local.request, local.dependencies);
    expect(localResult).toMatchObject({
      status: 'blocked',
      reasonCode: 'unsupported_installation'
    });
    expect(local.lookup).not.toHaveBeenCalled();

    const linked = await harness();
    const checkout = path.join(linked.root, 'checkout');
    await writePackage(checkout, linked.currentVersion);
    await rm(linked.packageRoot, { recursive: true, force: true });
    await symlink(
      checkout,
      linked.packageRoot,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    linked.request.runningPackageRoot = checkout;
    const linkedResult = await runSelfUpgrade(linked.request, linked.dependencies);
    expect(linkedResult).toMatchObject({
      status: 'blocked',
      reasonCode: 'unsupported_installation'
    });
    expect(linked.lookup).not.toHaveBeenCalled();
  });

  it('rejects invalid package identity and ambiguous global roots before network', async () => {
    const wrongPackage = await harness({
      packageValues: { name: '@other/liftoff' }
    });
    expect(await runSelfUpgrade(wrongPackage.request, wrongPackage.dependencies))
      .toMatchObject({ status: 'blocked', reasonCode: 'invalid_package' });
    expect(wrongPackage.lookup).not.toHaveBeenCalled();

    const ambiguous = await harness();
    ambiguous.runner.run = async (command, options) => {
      ambiguous.runner.calls.push({ command, options });
      return commandResult(command, {
        stdout: `${ambiguous.globalRoot}\n${ambiguous.globalRoot}\n`
      });
    };
    expect(await runSelfUpgrade(ambiguous.request, ambiguous.dependencies))
      .toMatchObject({ status: 'blocked', reasonCode: 'invalid_global_root' });
    expect(ambiguous.lookup).not.toHaveBeenCalled();
  });

  it('reports missing npm and unreadable global roots before network', async () => {
    const missingNpm = await harness();
    missingNpm.runner.run = async (command, options) => {
      missingNpm.runner.calls.push({ command, options });
      return commandResult(command, {
        status: null,
        errorCode: 'ENOENT',
        errorMessage: 'npm not found'
      });
    };
    expect(await runSelfUpgrade(missingNpm.request, missingNpm.dependencies))
      .toMatchObject({ status: 'blocked', reasonCode: 'npm_unavailable' });
    expect(missingNpm.lookup).not.toHaveBeenCalled();

    const unreadable = await harness();
    unreadable.dependencies.realpath = async () => {
      throw new Error('permission denied for /private/global/path');
    };
    const unreadableResult = await runSelfUpgrade(
      unreadable.request,
      unreadable.dependencies
    );
    expect(unreadableResult).toMatchObject({
      status: 'blocked',
      reasonCode: 'invalid_global_root'
    });
    expect(JSON.stringify(unreadableResult)).not.toContain('/private/global/path');
    expect(unreadable.lookup).not.toHaveBeenCalled();
  });

  it('blocks stale and credential-bearing registries without leaking values', async () => {
    const stale = await harness({
      runnerOptions: {
        registry: 'https://packages.example.test/npm/',
        viewResult: { status: 1, stderr: 'npm error E404 target not found' }
      }
    });
    const staleResult = await runSelfUpgrade(stale.request, stale.dependencies);
    expect(staleResult).toMatchObject({
      status: 'blocked',
      reasonCode: 'registry_stale',
      registryKind: 'configured'
    });
    expect(selfUpgradeRemedy(staleResult)).toContain('synchronize');

    const credential = await harness({
      runnerOptions: {
        registry: 'https://user:secret@packages.example.test/npm/?token=private'
      }
    });
    const credentialResult = await runSelfUpgrade(
      credential.request,
      credential.dependencies
    );
    expect(credentialResult).toMatchObject({
      status: 'blocked',
      reasonCode: 'registry_invalid'
    });
    expect(JSON.stringify(credentialResult)).not.toMatch(/secret|token|packages/);
    expect(selfUpgradeRemedy(credentialResult)).not.toMatch(/secret|token/);
  });

  it('fails malformed or unavailable registry responses without installation', async () => {
    const malformed = await harness({
      runnerOptions: {
        viewResult: { stdout: '{"name":' }
      }
    });
    expect(await runSelfUpgrade(malformed.request, malformed.dependencies))
      .toMatchObject({ status: 'failed', reasonCode: 'registry_invalid' });
    expect(malformed.runner.calls.some(({ command }) =>
      command.args[0] === 'install'
    )).toBe(false);

    const unavailable = await harness({
      runnerOptions: {
        viewResult: { status: 1, stderr: 'network unavailable' }
      }
    });
    expect(await runSelfUpgrade(unavailable.request, unavailable.dependencies))
      .toMatchObject({
        status: 'failed',
        reasonCode: 'registry_unavailable'
      });
    expect(unavailable.runner.calls.some(({ command }) =>
      command.args[0] === 'install'
    )).toBe(false);
  });

  it('refuses downgrade and prerelease targets without install calls', async () => {
    const downgrade = await harness({ targetVersion: '0.6.0' });
    const downgradeResult = await runSelfUpgrade(
      downgrade.request,
      downgrade.dependencies
    );
    expect(downgradeResult).toMatchObject({
      status: 'blocked',
      reasonCode: 'downgrade_refused'
    });
    expect(downgrade.runner.calls).toHaveLength(1);

    const prerelease = await harness();
    prerelease.dependencies.lookupStableRelease = async () => ({
      name: '@msn-control/liftoff',
      version: '0.8.0-rc.1'
    } as never);
    const prereleaseResult = await runSelfUpgrade(
      prerelease.request,
      prerelease.dependencies
    );
    expect(prereleaseResult).toMatchObject({
      status: 'failed',
      reasonCode: 'canonical_invalid'
    });
    expect(prerelease.runner.calls).toHaveLength(1);
  });

  it.each([
    ['timeout', { timedOut: true, status: null }, 'npm_install_timeout'],
    ['spawn', { status: null, errorCode: 'ENOENT' }, 'npm_install_failed'],
    ['signal', { status: null, signal: 'SIGTERM' }, 'npm_install_failed'],
    ['nonzero', { status: 1, stderr: 'permission denied' }, 'npm_install_failed']
  ] as const)('fails a %s npm installation without verification', async (
    _name,
    installResult,
    reasonCode
  ) => {
    const fixture = await harness({
      mode: 'apply',
      runnerOptions: { installResult }
    });
    const result = await runSelfUpgrade(fixture.request, fixture.dependencies);
    expect(result).toMatchObject({ status: 'failed', reasonCode });
    expect(fixture.runner.calls.some(({ command }) =>
      command.executable === process.execPath
    )).toBe(false);
    expect(selfUpgradeRemedy(result)).toContain(
      '@msn-control/liftoff@0.8.0'
    );
  });

  it.each([
    ['wrong version', async (root: string) => writePackage(root, '0.7.0')],
    ['missing package', async (root: string) => rm(root, { recursive: true, force: true })],
    ['malformed bin', async (root: string) => writePackage(root, '0.8.0', { bin: 'dist/cli.js' })],
    ['escaping bin', async (root: string) => writePackage(root, '0.8.0', { bin: { liftoff: '../outside.js' } })],
    ['non-regular bin', async (root: string) => writePackage(root, '0.8.0', { binaryKind: 'directory' })]
  ] as const)('fails replacement verification for %s', async (
    _name,
    mutate
  ) => {
    const fixture = await harness({
      mode: 'apply',
      runnerOptions: { onInstall: async () => mutate(fixture.packageRoot) }
    });
    const result = await runSelfUpgrade(fixture.request, fixture.dependencies);
    expect(result).toMatchObject({
      status: 'failed',
      reasonCode: 'verification_failed'
    });
    expect(selfUpgradeRemedy(result)).toContain(
      '@msn-control/liftoff@0.8.0'
    );
  });

  it('fails when replacement version output does not match', async () => {
    const fixture = await harness({
      mode: 'apply',
      runnerOptions: { versionOutput: 'Liftoff 9.9.9' }
    });
    expect(await runSelfUpgrade(fixture.request, fixture.dependencies))
      .toMatchObject({ status: 'failed', reasonCode: 'verification_failed' });
  });
});

describe('cross-platform global npm paths', () => {
  it('uses Windows executable, spaces, drive case, and UNC containment safely', () => {
    expect(buildGlobalNpmInstallCommand('1.2.3', 'win32').executable)
      .toBe('npm.cmd');
    expect(expectedGlobalPackageRoot(
      'C:\\Program Files\\nodejs\\node_modules',
      'win32'
    )).toBe(
      'C:\\Program Files\\nodejs\\node_modules\\@msn-control\\liftoff'
    );
    expect(pathIsContained(
      'C:\\Users\\DEV\\AppData\\Roaming\\npm\\node_modules',
      'c:\\users\\dev\\AppData\\Roaming\\npm\\node_modules\\@msn-control\\liftoff',
      'win32'
    )).toBe(true);
    expect(pathIsContained(
      '\\\\server\\share\\node_modules',
      '\\\\server\\share\\node_modules\\@msn-control\\liftoff',
      'win32'
    )).toBe(true);
    expect(pathIsContained(
      'C:\\global\\node_modules',
      'C:\\other\\liftoff',
      'win32'
    )).toBe(false);
  });
});
