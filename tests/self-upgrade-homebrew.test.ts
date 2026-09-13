import type { Stats } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ExternalCommand } from '../src/types.js';
import type { CommandResult, RunCommandOptions } from '../src/process-runner.js';
import {
  buildGlobalNpmInstallCommand,
  runSelfUpgrade,
  selfUpgradeExitCode,
  selfUpgradeRemedy,
  type SelfUpgradeDependencies,
  type SelfUpgradeInstallationTarget,
  type SelfUpgradeRequest
} from '../src/self-upgrade.js';
import { CaptureStream } from './helpers.js';

const layouts: Array<[SelfUpgradeInstallationTarget, string]> = [
  ['homebrew-opt', path.posix.join('/', 'opt', 'homebrew')],
  ['homebrew-usr-local', path.posix.join('/', 'usr', 'local')]
];

type FileEntry = { kind: 'directory' | 'file' | 'symlink'; resolved?: string };

function harness(
  prefix = layouts[0][1],
  mode: 'check' | 'apply' = 'check',
  formula = 'node@24',
  version = '24.21.0'
) {
  const cellar = path.posix.join(prefix, 'Cellar', formula, version);
  const globalRoot = path.posix.join(prefix, 'lib', 'node_modules');
  const cellarRoot = path.posix.join(cellar, 'lib', 'node_modules');
  const packageRoot = path.posix.join(globalRoot, '@msn-control', 'liftoff');
  const binary = path.posix.join(packageRoot, 'dist', 'cli.js');
  const metadataPath = path.posix.join(packageRoot, 'package.json');
  const launcher = path.posix.join(prefix, 'bin', 'liftoff');
  const node = path.posix.join(cellar, 'bin', 'node');
  const neutralDirectory = path.posix.join('/', 'private', 'tmp', 'upgrade neutral directory');
  const files = new Map<string, FileEntry>();
  for (const directory of [prefix, path.posix.join(prefix, 'bin'), globalRoot,
    cellarRoot, path.posix.dirname(packageRoot), packageRoot]) {
    files.set(directory, { kind: 'directory' });
  }
  for (const file of [metadataPath, binary, node]) files.set(file, { kind: 'file' });
  files.set(launcher, { kind: 'symlink', resolved: binary });
  const metadata = { name: '@msn-control/liftoff', version: '0.11.3', bin: { liftoff: 'dist/cli.js' } };
  const behavior = {
    reportedRoot: cellarRoot,
    targetedRoot: globalRoot,
    registry: 'https://registry.npmjs.org/',
    scopedRegistry: 'undefined',
    targetedRegistry: undefined as string | undefined,
    targetedScopedRegistry: undefined as string | undefined,
    viewResult: {} as Partial<CommandResult>,
    installResult: {} as Partial<CommandResult>,
    versionOutput: 'Liftoff 0.12.0',
    onView: () => {},
    onInstall: () => {}
  };
  const calls: Array<{ command: ExternalCommand; options?: RunCommandOptions }> = [];
  const installations: string[] = [];
  const runner = {
    run: vi.fn(async (command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> => {
      calls.push({ command, options });
      const base: CommandResult = {
        command, displayCommand: command.executable, status: 0, signal: null,
        stdout: '', stderr: '', timedOut: false
      };
      if (command.executable === node) return { ...base, stdout: behavior.versionOutput };
      expect(command.executable).toBe('npm');
      const prefixIndex = command.args.indexOf('--prefix');
      if (prefixIndex >= 0) expect(command.args[prefixIndex + 1]).toBe(prefix);
      switch (command.args[0]) {
        case 'root':
          return { ...base, stdout: prefixIndex >= 0 ? behavior.targetedRoot : behavior.reportedRoot };
        case 'config':
          expect(command.args[1]).toBe('get');
          return {
            ...base,
            stdout: command.args[2] === '@msn-control:registry'
              ? (prefixIndex >= 0 ? behavior.targetedScopedRegistry : undefined) ?? behavior.scopedRegistry
              : (prefixIndex >= 0 ? behavior.targetedRegistry : undefined) ?? behavior.registry
          };
        case 'view':
          behavior.onView();
          return { ...base, stdout: JSON.stringify({ name: metadata.name, version: '0.12.0' }), ...behavior.viewResult };
        case 'install':
          installations.push(prefixIndex >= 0 ? command.args[prefixIndex + 1] : cellar);
          metadata.version = '0.12.0';
          behavior.onInstall();
          return { ...base, ...behavior.installResult };
        default:
          throw new Error(`Unexpected command: ${command.args.join(' ')}`);
      }
    })
  };
  const entry = (file: string) => {
    const found = files.get(file);
    if (!found) throw new Error('Missing private fixture path.');
    return found;
  };
  const dependencies: SelfUpgradeDependencies = {
    runner,
    platform: 'darwin',
    execPath: node,
    environment: Object.freeze({
      HOME: path.posix.join('/', 'private', 'fixture-home'),
      npm_config_cache: path.posix.join('/', 'private', 'fixture-cache'),
      NPM_CONFIG_PREFIX: cellar
    }),
    lookupStableRelease: vi.fn(async () => ({ name: '@msn-control/liftoff', version: '0.12.0' })),
    makeNeutralDirectory: vi.fn(async () => neutralDirectory),
    removeNeutralDirectory: vi.fn(async () => {}),
    realpath: vi.fn(async (file: string) => entry(file).resolved ?? file),
    lstat: vi.fn(async (file: string) => {
      const found = entry(file);
      return {
        isDirectory: () => found.kind === 'directory',
        isFile: () => found.kind === 'file',
        isSymbolicLink: () => found.kind === 'symlink'
      } as Stats;
    }),
    readJson: vi.fn(async (file: string) => {
      expect(file).toBe(metadataPath);
      return structuredClone(metadata);
    })
  };
  const request: SelfUpgradeRequest = {
    mode, currentVersion: '0.11.3', runningPackageRoot: packageRoot,
    json: true, stdout: new CaptureStream(), stderr: new CaptureStream()
  };
  return {
    prefix, globalRoot, cellarRoot, packageRoot, binary, metadataPath, launcher, node,
    neutralDirectory, files, metadata, behavior, calls, installations, dependencies, request
  };
}

describe('verified Homebrew npm prefix recovery', () => {
  it.each(layouts)('checks %s without installing or exposing private paths', async (target, prefix) => {
    const f = harness(prefix);
    const before = JSON.stringify({ files: [...f.files], metadata: f.metadata, env: f.dependencies.environment });
    const result = await runSelfUpgrade(f.request, f.dependencies);
    expect(result).toEqual({
      schemaVersion: 1, mode: 'check', status: 'update-available',
      currentVersion: '0.11.3', targetVersion: '0.12.0',
      registryKind: 'canonical', reasonCode: 'update_available', installationTarget: target
    });
    expect(selfUpgradeExitCode(result)).toBe(2);
    expect(f.installations).toEqual([]);
    expect(JSON.stringify({ files: [...f.files], metadata: f.metadata, env: f.dependencies.environment })).toBe(before);
    expect(JSON.stringify(result)).not.toMatch(/\/opt\/|\/usr\/|\/private\/|Cellar|node_modules/);
    expect(f.calls[0].command.args).toEqual(['root', '--global']);
    for (const call of f.calls.slice(1)) {
      if (call.command.args[0] !== 'config' || call.command.args.includes('--prefix')) {
        expect(call.command.args.slice(-2)).toEqual(['--prefix', prefix]);
        expect(call.command.args).toContain('--global');
      }
      expect(call.options).toMatchObject({ cwd: f.neutralDirectory, timeoutMs: 30_000 });
    }
    expect(f.dependencies.removeNeutralDirectory).toHaveBeenCalledWith(f.neutralDirectory);
  });

  it.each(layouts)('installs and verifies only the existing %s target', async (target, prefix) => {
    const f = harness(prefix, 'apply');
    const displayed = vi.fn();
    f.request.onInstallCommand = displayed;
    const result = await runSelfUpgrade(f.request, f.dependencies);
    expect(result).toMatchObject({ status: 'upgraded', installationTarget: target });
    expect(selfUpgradeExitCode(result)).toBe(0);
    expect(f.installations).toEqual([prefix]);
    const install = f.calls.find(({ command }) => command.args[0] === 'install')!;
    expect(install.command).toEqual(buildGlobalNpmInstallCommand('0.12.0', 'darwin', target));
    expect(displayed).toHaveBeenCalledWith(install.command);
    expect(install.options).toMatchObject({ timeoutMs: 600_000, stdout: f.request.stderr, stderr: f.request.stderr });
    expect(f.calls.filter(({ command }) => command.args[0] === 'root')).toHaveLength(4);
    const verification = f.calls.find(({ command }) => command.executable === f.node)!;
    expect(verification.command.args).toEqual([f.binary, '--version']);
    expect(verification.options).toMatchObject({ timeoutMs: 15_000, env: { LIFTOFF_TELEMETRY: '0' } });
    expect(f.calls.some(({ command }) => command.args.includes('--registry') || command.args.includes('set'))).toBe(false);
  });

  it.each(['node', 'node@24'])('accepts the %s Cellar layout with a Homebrew revision', async (formula) => {
    const f = harness(layouts[0][1], 'check', formula, '24.21.0_1');
    expect(await runSelfUpgrade(f.request, f.dependencies)).toMatchObject({ status: 'update-available' });
  });

  const unsafeCases: Array<[string, (f: ReturnType<typeof harness>) => void]> = [
    ['local dependency', (f) => {
      const local = path.posix.join('/', 'private', 'project', 'node_modules', '@msn-control', 'liftoff');
      f.files.set(local, { kind: 'directory' });
      f.request.runningPackageRoot = local;
    }],
    ['npx cache copy', (f) => {
      const cached = path.posix.join('/', 'private', 'cache', '_npx', 'entry', 'node_modules', '@msn-control', 'liftoff');
      f.files.set(cached, { kind: 'directory' });
      f.request.runningPackageRoot = cached;
    }],
    ['linked package', (f) => f.files.set(f.packageRoot, { kind: 'symlink', resolved: path.posix.join('/', 'private', 'checkout') })],
    ['linked scope', (f) => f.files.set(path.posix.dirname(f.packageRoot), { kind: 'symlink' })],
    ['linked global root', (f) => f.files.set(f.globalRoot, { kind: 'symlink' })],
    ['wrong launcher', (f) => f.files.set(f.launcher, { kind: 'symlink', resolved: f.node })],
    ['regular-file launcher', (f) => f.files.set(f.launcher, { kind: 'file' })],
    ['missing launcher', (f) => { f.files.delete(f.launcher); }],
    ['directory binary', (f) => f.files.set(f.binary, { kind: 'directory' })],
    ['symlink binary', (f) => f.files.set(f.binary, { kind: 'symlink' })],
    ['escaping binary', (f) => { f.metadata.bin.liftoff = path.posix.join('..', 'outside.js'); }],
    ['wrong package identity', (f) => { f.metadata.name = '@other/liftoff'; }],
    ['wrong package version', (f) => { f.metadata.version = '9.9.9'; }],
    ['unrelated npm prefix', (f) => { f.behavior.reportedRoot = f.prefix; }],
    ['unrelated Node executable', (f) => { f.dependencies.execPath = f.binary; }],
    ['mismatched prefix confirmation', (f) => { f.behavior.targetedRoot = f.cellarRoot; }]
  ];
  it.each(unsafeCases)('rejects %s before registry access or installation', async (_label, mutate) => {
    const f = harness();
    mutate(f);
    expect(await runSelfUpgrade(f.request, f.dependencies)).toMatchObject({
      status: 'blocked', reasonCode: 'unsupported_installation'
    });
    expect(f.dependencies.lookupStableRelease).not.toHaveBeenCalled();
    expect(f.installations).toEqual([]);
    expect(f.calls.some(({ command }) => command.args[0] === 'view')).toBe(false);
  });

  it('does not follow symlinked metadata while validating a Homebrew target', async () => {
    const f = harness();
    f.files.set(f.metadataPath, { kind: 'symlink' });
    expect(await runSelfUpgrade(f.request, f.dependencies)).toMatchObject({ status: 'blocked' });
    expect(f.dependencies.readJson).not.toHaveBeenCalled();
    expect(f.dependencies.lookupStableRelease).not.toHaveBeenCalled();
  });

  it('does not infer an arbitrary prefix from an npm-shaped package path', async () => {
    const f = harness(path.posix.join('/', 'private', 'custom-brew'));
    expect(await runSelfUpgrade(f.request, f.dependencies)).toMatchObject({
      status: 'blocked', reasonCode: 'unsupported_installation'
    });
    expect(f.dependencies.lookupStableRelease).not.toHaveBeenCalled();
    expect(f.installations).toEqual([]);
  });

  it('rejects a mismatched replacement binary version', async () => {
    const f = harness(layouts[0][1], 'apply');
    f.behavior.versionOutput = 'Liftoff 0.11.3';
    expect(await runSelfUpgrade(f.request, f.dependencies)).toMatchObject({
      status: 'failed', reasonCode: 'verification_failed'
    });
  });

  it.each(['linux', 'win32'] as const)('does not apply the Homebrew fallback on %s', async (platform) => {
    const f = harness();
    f.dependencies.platform = platform;
    const nativeRun = f.dependencies.runner.run;
    f.dependencies.runner = { run: (command, options) => nativeRun({ ...command, executable: 'npm' }, options) };
    expect(await runSelfUpgrade(f.request, f.dependencies)).toMatchObject({ status: 'blocked' });
    expect(f.dependencies.lookupStableRelease).not.toHaveBeenCalled();
    expect(f.installations).toEqual([]);
  });

  it.each(['launcher', 'root', 'metadata'] as const)('rechecks %s drift before installation', async (kind) => {
    const f = harness(layouts[0][1], 'apply');
    f.behavior.onView = () => {
      if (kind === 'launcher') f.files.set(f.launcher, { kind: 'symlink', resolved: f.node });
      if (kind === 'root') f.behavior.targetedRoot = f.cellarRoot;
      if (kind === 'metadata') f.metadata.version = '9.9.9';
    };
    expect(await runSelfUpgrade(f.request, f.dependencies)).toMatchObject({ status: 'blocked' });
    expect(f.installations).toEqual([]);
  });

  it.each(['launcher', 'root', 'package', 'version'] as const)('rejects replacement %s drift', async (kind) => {
    const f = harness(layouts[0][1], 'apply');
    f.behavior.onInstall = () => {
      if (kind === 'launcher') f.files.set(f.launcher, { kind: 'symlink', resolved: f.node });
      if (kind === 'root') f.behavior.targetedRoot = f.cellarRoot;
      if (kind === 'package') f.files.set(f.packageRoot, { kind: 'directory', resolved: f.prefix });
      if (kind === 'version') f.metadata.version = '0.11.3';
    };
    expect(await runSelfUpgrade(f.request, f.dependencies)).toMatchObject({
      status: 'failed', reasonCode: 'verification_failed'
    });
    expect(f.installations).toEqual([f.prefix]);
    expect(f.calls.some(({ command }) => command.executable === f.node)).toBe(false);
  });

  it('retains scoped mirror parity checks without falling back to the default registry', async () => {
    const f = harness(layouts[0][1], 'apply');
    f.behavior.scopedRegistry = 'https://mirror.example.test/npm/';
    f.behavior.viewResult = { status: 1, stderr: 'E404 target not found' };
    expect(await runSelfUpgrade(f.request, f.dependencies)).toMatchObject({
      status: 'blocked', reasonCode: 'registry_stale', registryKind: 'configured'
    });
    expect(f.calls.filter(({ command }) => command.args[0] === 'config').map(({ command }) => command.args))
      .toEqual([
        ['config', 'get', '@msn-control:registry'],
        ['config', 'get', '@msn-control:registry', '--global', '--prefix', f.prefix]
      ]);
    expect(f.installations).toEqual([]);
  });

  it.each(['scoped', 'default'] as const)('rejects a prefix change that would bypass the %s registry', async (kind) => {
    const f = harness(layouts[0][1], 'apply');
    if (kind === 'scoped') {
      f.behavior.scopedRegistry = 'https://mirror.example.test/npm/';
      f.behavior.targetedScopedRegistry = 'undefined';
    } else {
      f.behavior.registry = 'https://mirror.example.test/npm/';
      f.behavior.targetedRegistry = 'https://registry.npmjs.org/';
    }
    const result = await runSelfUpgrade(f.request, f.dependencies);
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'registry_prefix_mismatch' });
    expect(selfUpgradeRemedy(result)).toContain('different registries');
    expect(f.installations).toEqual([]);
    expect(f.calls.some(({ command }) => command.args[0] === 'view')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('mirror.example.test');
  });

  it.each(layouts)('retains the %s prefix in exact-version failure guidance', async (target, prefix) => {
    const f = harness(prefix, 'apply');
    f.behavior.installResult = { status: 1, stderr: 'permission denied' };
    const result = await runSelfUpgrade(f.request, f.dependencies);
    expect(result).toMatchObject({ status: 'failed', reasonCode: 'npm_install_failed', installationTarget: target });
    expect(selfUpgradeRemedy(result)).toBe(
      `Run the exact repair command manually: npm install --global --ignore-scripts --no-audit --no-fund @msn-control/liftoff@0.12.0 --prefix ${prefix}`
    );
    expect(JSON.stringify(result)).not.toContain(prefix);
  });
});
