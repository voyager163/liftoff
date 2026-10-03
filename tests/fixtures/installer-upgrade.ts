import type { Stats } from 'node:fs';
import path from 'node:path';
import type { ExternalCommand } from '../../src/domain/project/contracts.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../../src/process-runner.js';
import type { SelfUpgradeDependencies, SelfUpgradeRequest } from '../../src/self-upgrade.js';
import type { StableRelease } from '../../src/stable-release.js';
import { CaptureStream } from '../helpers.js';

export type UpgradePlatform = 'linux' | 'darwin' | 'win32';
export type UpgradeLayout = 'npm-global' | 'homebrew-opt' | 'homebrew-usr-local';

export interface VirtualNode {
  kind: 'directory' | 'file' | 'symlink';
  /** Symlink resolution; directories and files resolve to themselves. */
  target?: string;
  json?: () => unknown;
}

export type UpgradeTraceEvent =
  | { fs: 'lstat' | 'realpath' | 'readJson'; path: string }
  | { run: RecordedRun }
  | { stage: string; detail: string | null }
  | { installCommand: ExternalCommand }
  | { lookup: 'stable-release' }
  | { neutral: 'make' | 'remove'; path?: string };

export interface RecordedRun {
  executable: string;
  args: string[];
  cwd: string | null;
  env: Array<[string, string | null]>;
  timeoutMs: number | null;
  stream: boolean | null;
  stdout: string | null;
  stderr: string | null;
}

export const liftoffPackage = '@msn-control/liftoff';
export const scopedRegistryKey = '@msn-control:registry';

/**
 * A fully injected npm/Homebrew host: no real npm, filesystem, network, clock or ambient environment.
 * Every capability records its call, so a trace describes the exact effect order of one upgrade run.
 */
export function upgradeWorld(options: {
  platform?: UpgradePlatform;
  layout?: UpgradeLayout;
  mode?: 'check' | 'apply';
  json?: boolean;
  currentVersion?: string;
  targetVersion?: string;
} = {}) {
  const layout = options.layout ?? 'npm-global';
  const platform: UpgradePlatform = layout === 'npm-global' ? options.platform ?? 'linux' : 'darwin';
  const api = platform === 'win32' ? path.win32 : path.posix;
  const currentVersion = options.currentVersion ?? '0.12.3';
  const targetVersion = options.targetVersion ?? '0.13.0';
  const npm = platform === 'win32' ? 'npm.cmd' : 'npm';
  const neutralDirectory = platform === 'win32'
    ? 'C:\\virtual\\upgrade neutral'
    : path.posix.join('/', 'virtual', 'upgrade neutral');
  const nodes = new Map<string, VirtualNode>();
  const trace: UpgradeTraceEvent[] = [];
  const metadata: Record<string, unknown> = { name: liftoffPackage, version: currentVersion, bin: { liftoff: 'dist/cli.js' } };

  let prefix: string | undefined;
  let stableRoot: string;
  let reportedRoot: string;
  let execPath: string;
  if (layout === 'npm-global') {
    stableRoot = platform === 'win32'
      ? 'C:\\Users\\Dev\\AppData\\Roaming\\npm\\node_modules'
      : path.posix.join('/', 'usr', 'local', 'lib', 'node_modules');
    reportedRoot = stableRoot;
    execPath = platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : path.posix.join('/', 'usr', 'local', 'bin', 'node');
    nodes.set(execPath, { kind: 'file' });
  } else {
    prefix = layout === 'homebrew-opt' ? path.posix.join('/', 'opt', 'homebrew') : path.posix.join('/', 'usr', 'local');
    const cellar = path.posix.join(prefix, 'Cellar', 'node@24', '24.21.0');
    stableRoot = path.posix.join(prefix, 'lib', 'node_modules');
    reportedRoot = path.posix.join(cellar, 'lib', 'node_modules');
    execPath = path.posix.join(cellar, 'bin', 'node');
    for (const directory of [prefix, path.posix.join(prefix, 'bin'), reportedRoot]) nodes.set(directory, { kind: 'directory' });
    nodes.set(execPath, { kind: 'file' });
  }
  const packageRoot = api.join(stableRoot, '@msn-control', 'liftoff');
  const metadataPath = api.join(packageRoot, 'package.json');
  const binary = api.join(packageRoot, 'dist', 'cli.js');
  for (const directory of [stableRoot, api.dirname(packageRoot), packageRoot]) nodes.set(directory, { kind: 'directory' });
  nodes.set(metadataPath, { kind: 'file', json: () => structuredClone(metadata) });
  nodes.set(binary, { kind: 'file' });
  if (prefix) nodes.set(path.posix.join(prefix, 'bin', 'liftoff'), { kind: 'symlink', target: binary });

  const world = {
    platform, layout, npm, prefix, neutralDirectory, stableRoot, packageRoot, metadataPath, binary, execPath,
    currentVersion, targetVersion, nodes, metadata, trace,
    reportedRoot,
    prefixRoot: stableRoot,
    rootResult: undefined as Partial<CommandResult> | undefined,
    postInstallRoot: undefined as string | undefined,
    scopedRegistry: 'undefined',
    defaultRegistry: 'https://registry.npmjs.org/',
    prefixScopedRegistry: undefined as string | undefined,
    prefixDefaultRegistry: undefined as string | undefined,
    configResult: {} as Record<string, Partial<CommandResult>>,
    viewResult: undefined as Partial<CommandResult> | undefined,
    installResult: {} as Partial<CommandResult>,
    versionOutput: `Liftoff ${targetVersion}`,
    afterInstall: () => { metadata.version = targetVersion; },
    beforeView: () => {},
    stable: async (): Promise<StableRelease> => ({ name: liftoffPackage, version: targetVersion }),
    makeNeutral: async (): Promise<string> => neutralDirectory,
    runnerFailure: undefined as ((command: ExternalCommand) => Error | undefined) | undefined,
    installed: false
  };

  const request: SelfUpgradeRequest = {
    mode: options.mode ?? 'check',
    currentVersion,
    runningPackageRoot: packageRoot,
    json: options.json ?? true,
    stdout: new CaptureStream(),
    stderr: new CaptureStream(),
    onStage: (stage, detail) => { trace.push({ stage, detail: detail ?? null }); },
    onInstallCommand: (command) => { trace.push({ installCommand: structuredClone(command) }); }
  };

  const cacheValue = path.join(neutralDirectory, 'npm-cache');
  const label = (value: unknown): string | null => {
    if (value === undefined) return null;
    if (value === request.stdout) return 'request.stdout';
    if (value === request.stderr) return 'request.stderr';
    if (value === neutralDirectory) return '<neutral>';
    return typeof value === 'string' ? value : 'unexpected-stream';
  };
  const record = (command: ExternalCommand, runOptions?: RunCommandOptions): RecordedRun => ({
    executable: command.executable,
    args: [...command.args],
    cwd: label(runOptions?.cwd),
    env: Object.entries(runOptions?.env ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, value]) => [key, value === undefined ? null : value === cacheValue ? '<neutral>/npm-cache' : value]),
    timeoutMs: runOptions?.timeoutMs ?? null,
    stream: runOptions?.stream ?? null,
    stdout: label(runOptions?.stdout),
    stderr: label(runOptions?.stderr)
  });
  const result = (command: ExternalCommand, overrides: Partial<CommandResult> = {}): CommandResult => ({
    command, displayCommand: [command.executable, ...command.args].join(' '), status: 0, signal: null,
    stdout: '', stderr: '', timedOut: false, ...overrides
  });

  const runner: CommandRunner = {
    run: async (command, runOptions) => {
      trace.push({ run: record(command, runOptions) });
      const failure = world.runnerFailure?.(command);
      if (failure) throw failure;
      if (command.executable === execPath) return result(command, { stdout: `${world.versionOutput}\n` });
      if (command.executable !== npm) throw new Error(`Unexpected fixture executable ${command.executable}.`);
      const targeted = command.args.includes('--prefix');
      switch (command.args[0]) {
        case 'root':
          if (world.rootResult) return result(command, world.rootResult);
          return result(command, {
            stdout: `${targeted ? world.prefixRoot : world.installed && world.postInstallRoot ? world.postInstallRoot : world.reportedRoot}\n`
          });
        case 'config': {
          const key = command.args[2]!;
          const override = world.configResult[`${targeted ? 'prefix:' : ''}${key}`];
          if (override) return result(command, override);
          const value = key === scopedRegistryKey
            ? (targeted ? world.prefixScopedRegistry : undefined) ?? world.scopedRegistry
            : (targeted ? world.prefixDefaultRegistry : undefined) ?? world.defaultRegistry;
          return result(command, { stdout: `${value}\n` });
        }
        case 'view':
          world.beforeView();
          return result(command, world.viewResult ?? { stdout: JSON.stringify({ name: liftoffPackage, version: targetVersion }) });
        case 'install':
          world.installed = true;
          if (!world.installResult.timedOut && (world.installResult.status ?? 0) === 0) world.afterInstall();
          return result(command, world.installResult);
        default:
          throw new Error(`Unexpected fixture npm command ${command.args.join(' ')}.`);
      }
    }
  };

  const missing = (file: string) => Object.assign(new Error(`Private fixture path is absent: ${file}`), { code: 'ENOENT' });
  const dependencies: SelfUpgradeDependencies = {
    runner,
    platform,
    execPath,
    environment: Object.freeze(platform === 'win32'
      ? { Path: 'C:\\fixture\\bin', USERPROFILE: 'C:\\fixture\\home', npm_config_cache: 'C:\\fixture\\ambient-cache', NPM_CONFIG_PREFIX: 'C:\\fixture\\prefix' }
      : { PATH: '/fixture/bin', HOME: '/fixture/home', npm_config_cache: '/fixture/ambient-cache', NPM_CONFIG_PREFIX: '/fixture/prefix' }),
    lookupStableRelease: async () => {
      trace.push({ lookup: 'stable-release' });
      return world.stable();
    },
    makeNeutralDirectory: async () => {
      trace.push({ neutral: 'make' });
      return world.makeNeutral();
    },
    removeNeutralDirectory: async (directory) => {
      trace.push({ neutral: 'remove', path: label(directory) ?? 'unexpected' });
    },
    lstat: async (file) => {
      trace.push({ fs: 'lstat', path: file });
      const node = nodes.get(file);
      if (!node) throw missing(file);
      return {
        isDirectory: () => node.kind === 'directory',
        isFile: () => node.kind === 'file',
        isSymbolicLink: () => node.kind === 'symlink'
      } as Stats;
    },
    realpath: async (file) => {
      trace.push({ fs: 'realpath', path: file });
      const node = nodes.get(file);
      if (!node) throw missing(file);
      return node.kind === 'symlink' ? node.target! : file;
    },
    readJson: async (file) => {
      trace.push({ fs: 'readJson', path: file });
      const node = nodes.get(file);
      if (!node?.json) throw missing(file);
      return node.json();
    }
  };
  return { world, request, dependencies };
}

export type UpgradeWorld = ReturnType<typeof upgradeWorld>;
