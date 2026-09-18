import type { Stats } from 'node:fs';
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installedPackageRoot } from './adapters/packaged-assets/package-root.js';
import {
  canonicalManualInstallCommand,
  canonicalNpmRegistry,
  exactGlobalInstallCommand,
  liftoffBinaryName,
  liftoffPackageName,
  liftoffScopedRegistryKey,
  npmExecutableForPlatform
} from './package-identity.js';
import {
  isStableSemver,
  lookupStableRelease,
  stableReleaseLookupTimeoutMs,
  StableReleaseLookupError,
  type StableRelease
} from './stable-release.js';
import {
  NodeCommandRunner,
  type CommandResult,
  type CommandRunner
} from './process-runner.js';
import { compareSemver } from './semver.js';
import type { ExternalCommand } from './domain/project/contracts.js';

export const selfUpgradeSchemaVersion = 1 as const;
export const selfUpgradeInstallTimeoutMs = 10 * 60_000;
export const selfUpgradeProbeTimeoutMs = 30_000;
export const selfUpgradeVerificationTimeoutMs = 15_000;

const homebrewPrefixes = {
  'homebrew-opt': path.posix.join('/', 'opt', 'homebrew'),
  'homebrew-usr-local': path.posix.join('/', 'usr', 'local')
} as const;
export type SelfUpgradeInstallationTarget = keyof typeof homebrewPrefixes;

export type SelfUpgradeMode = 'apply' | 'check';
export type SelfUpgradeStatus =
  | 'blocked'
  | 'current'
  | 'failed'
  | 'update-available'
  | 'upgraded';
export type SelfUpgradeRegistryKind = 'canonical' | 'configured';
export type SelfUpgradeReasonCode =
  | 'canonical_invalid'
  | 'canonical_timeout'
  | 'canonical_unavailable'
  | 'current'
  | 'downgrade_refused'
  | 'invalid_global_root'
  | 'invalid_package'
  | 'npm_install_failed'
  | 'npm_install_timeout'
  | 'npm_unavailable'
  | 'registry_invalid'
  | 'registry_prefix_mismatch'
  | 'registry_stale'
  | 'registry_unavailable'
  | 'unsupported_installation'
  | 'update_available'
  | 'upgrade_complete'
  | 'verification_failed';

interface SelfUpgradeResultBase {
  schemaVersion: typeof selfUpgradeSchemaVersion;
  mode: SelfUpgradeMode;
  status: SelfUpgradeStatus;
  currentVersion: string;
  reasonCode: SelfUpgradeReasonCode;
  installationTarget?: SelfUpgradeInstallationTarget;
}

export type SelfUpgradeResult =
  | SelfUpgradeResultBase & {
      status: 'current';
      reasonCode: 'current';
    }
  | SelfUpgradeResultBase & {
      status: 'update-available';
      reasonCode: 'update_available';
      targetVersion: string;
      registryKind: SelfUpgradeRegistryKind;
    }
  | SelfUpgradeResultBase & {
      status: 'upgraded';
      reasonCode: 'upgrade_complete';
      targetVersion: string;
      registryKind: SelfUpgradeRegistryKind;
    }
  | SelfUpgradeResultBase & {
      status: 'blocked' | 'failed';
      targetVersion?: string;
      registryKind?: SelfUpgradeRegistryKind;
    };

export type SelfUpgradeStage =
  | 'Inspect global installation'
  | 'Resolve canonical stable target'
  | 'Verify configured registry parity'
  | 'Install exact Liftoff release'
  | 'Verify replacement';

export interface SelfUpgradeRequest {
  mode: SelfUpgradeMode;
  currentVersion: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  json: boolean;
  runningPackageRoot?: string;
  onStage?: (stage: SelfUpgradeStage, detail?: string) => void;
  onInstallCommand?: (command: ExternalCommand) => void;
}

export type SelfUpgradeExecutor = (
  request: SelfUpgradeRequest
) => Promise<SelfUpgradeResult>;

interface PathApi {
  isAbsolute(value: string): boolean;
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
  resolve(...parts: string[]): string;
  sep: string;
}

export interface SelfUpgradeDependencies {
  runner: CommandRunner;
  lookupStableRelease(): Promise<StableRelease>;
  makeNeutralDirectory(): Promise<string>;
  removeNeutralDirectory(directory: string): Promise<void>;
  readJson(filePath: string): Promise<unknown>;
  lstat(filePath: string): Promise<Stats>;
  realpath(filePath: string): Promise<string>;
  platform: NodeJS.Platform;
  execPath: string;
  environment: NodeJS.ProcessEnv;
}

interface InstallationInspection {
  npmExecutable: string;
  packageRoot: string;
  installationTarget?: SelfUpgradeInstallationTarget;
}

interface RegistryInspection {
  kind: SelfUpgradeRegistryKind;
}

export type ConfiguredRegistryTargetResult =
  | {
      status: 'available';
      registryKind: SelfUpgradeRegistryKind;
    }
  | {
      status: 'stale' | 'unavailable';
    };

export type ConfiguredRegistryTargetLookup = (
  targetVersion: string
) => Promise<ConfiguredRegistryTargetResult>;

class SelfUpgradeFailure extends Error {
  constructor(
    readonly status: 'blocked' | 'failed',
    readonly reasonCode: SelfUpgradeReasonCode,
    readonly registryKind?: SelfUpgradeRegistryKind
  ) {
    super(reasonCode);
    this.name = 'SelfUpgradeFailure';
  }
}

const sourcePackageRoot = installedPackageRoot;

function pathApiForPlatform(platform: NodeJS.Platform): PathApi {
  return platform === 'win32' ? path.win32 : path.posix;
}

function comparisonPath(value: string, platform: NodeJS.Platform): string {
  const normalized = pathApiForPlatform(platform).resolve(value);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function pathIsContained(
  root: string,
  candidate: string,
  platform: NodeJS.Platform
): boolean {
  const api = pathApiForPlatform(platform);
  const relative = api.relative(
    comparisonPath(root, platform),
    comparisonPath(candidate, platform)
  );
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${api.sep}`) &&
    !api.isAbsolute(relative)
  );
}

export function expectedGlobalPackageRoot(
  globalRoot: string,
  platform: NodeJS.Platform
): string {
  return pathApiForPlatform(platform).join(globalRoot, ...liftoffPackageName.split('/'));
}

export function buildGlobalNpmInstallCommand(
  targetVersion: string,
  platform: NodeJS.Platform,
  installationTarget?: SelfUpgradeInstallationTarget
): ExternalCommand {
  return npmCommand(
    npmExecutableForPlatform(platform),
    [
      'install',
      '--global',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `${liftoffPackageName}@${targetVersion}`
    ],
    installationTarget
  );
}

function npmCommand(
  executable: string,
  args: string[],
  installationTarget?: SelfUpgradeInstallationTarget
): ExternalCommand {
  return {
    executable,
    args: [
      ...args,
      ...(installationTarget ? [
        ...(!args.includes('--global') ? ['--global'] : []),
        '--prefix', homebrewPrefixes[installationTarget]
      ] : [])
    ]
  };
}

function result(
  request: SelfUpgradeRequest,
  status: SelfUpgradeStatus,
  reasonCode: SelfUpgradeReasonCode,
  details: {
    targetVersion?: string;
    registryKind?: SelfUpgradeRegistryKind;
    installationTarget?: SelfUpgradeInstallationTarget;
  } = {}
): SelfUpgradeResult {
  return {
    schemaVersion: selfUpgradeSchemaVersion,
    mode: request.mode,
    status,
    currentVersion: request.currentVersion,
    reasonCode,
    ...(details.installationTarget ? { installationTarget: details.installationTarget } : {}),
    ...(details.targetVersion ? { targetVersion: details.targetVersion } : {}),
    ...(details.registryKind ? { registryKind: details.registryKind } : {})
  } as SelfUpgradeResult;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled self-upgrade state: ${String(value)}`);
}

export function selfUpgradeExitCode(value: SelfUpgradeResult): number {
  switch (value.status) {
    case 'current':
    case 'upgraded':
      return 0;
    case 'update-available':
      return 2;
    case 'blocked':
    case 'failed':
      return 1;
    default:
      return assertNever(value);
  }
}

export function selfUpgradeRemedy(value: SelfUpgradeResult): string | undefined {
  const prefix = value.installationTarget ? ` --prefix ${homebrewPrefixes[value.installationTarget]}` : '';
  switch (value.reasonCode) {
    case 'current':
    case 'update_available':
    case 'upgrade_complete':
      return undefined;
    case 'registry_stale':
      return 'Ask the managed registry owner to synchronize or approve the canonical target, then retry.';
    case 'npm_install_failed':
    case 'npm_install_timeout':
    case 'verification_failed':
      return value.targetVersion
        ? `Run the exact repair command manually: ${exactGlobalInstallCommand(value.targetVersion)}${prefix}`
        : undefined;
    case 'unsupported_installation':
    case 'invalid_global_root':
    case 'invalid_package':
    case 'npm_unavailable':
      return `Use a supported global npm installation: ${canonicalManualInstallCommand()}${prefix}`;
    case 'canonical_invalid':
    case 'canonical_timeout':
    case 'canonical_unavailable':
      return 'Retry after canonical npm is reachable and exposes valid stable Liftoff metadata.';
    case 'registry_invalid':
    case 'registry_unavailable':
      return 'Repair the approved npm registry configuration without placing credentials in the registry URL, then retry.';
    case 'registry_prefix_mismatch':
      return 'The active npm and verified Homebrew prefix select different registries. Reconcile the approved machine-level registry policy before retrying; Liftoff did not switch registries or install.';
    case 'downgrade_refused':
      return 'Keep the newer installed CLI; Liftoff does not perform automatic downgrades.';
    default:
      return assertNever(value);
  }
}

export function selfUpgradeSummary(value: SelfUpgradeResult): string {
  switch (value.status) {
    case 'current':
      return `Liftoff ${value.currentVersion} is already the canonical stable release.`;
    case 'update-available':
      return `Liftoff ${value.targetVersion} is available for this supported global npm installation.`;
    case 'upgraded':
      return `Liftoff ${value.targetVersion} was installed and verified.`;
    case 'blocked':
      return `CLI upgrade was blocked (${value.reasonCode}).`;
    case 'failed':
      return `CLI upgrade failed (${value.reasonCode}).`;
    default:
      return assertNever(value);
  }
}

function readOnlyEnvironment(
  dependencies: SelfUpgradeDependencies,
  neutralDirectory: string
): NodeJS.ProcessEnv {
  return {
    ...dependencies.environment,
    npm_config_cache: path.join(neutralDirectory, 'npm-cache')
  };
}

function commandFailed(command: CommandResult): boolean {
  return command.errorCode !== undefined ||
    command.errorMessage !== undefined ||
    command.timedOut ||
    command.signal !== null ||
    command.status !== 0;
}

async function homebrewInstallationTarget(
  globalRoot: string,
  runningRoot: string,
  dependencies: SelfUpgradeDependencies
): Promise<SelfUpgradeInstallationTarget | undefined> {
  if (dependencies.platform !== 'darwin') return undefined;
  for (const target of Object.keys(homebrewPrefixes) as SelfUpgradeInstallationTarget[]) {
    const prefix = homebrewPrefixes[target];
    const stableRoot = path.posix.join(prefix, 'lib', 'node_modules');
    if (runningRoot !== expectedGlobalPackageRoot(stableRoot, 'darwin')) continue;
    try {
      const executable = await dependencies.realpath(dependencies.execPath);
      const parts = path.posix.relative(prefix, executable).split(path.posix.sep);
      if (parts.length !== 5 || parts[0] !== 'Cellar' || parts[3] !== 'bin' || parts[4] !== 'node' ||
        !/^\d+\.\d+\.\d+(?:_\d+)?$/u.test(parts[2]) ||
        !['node', `node@${parts[2].split('.')[0]}`].includes(parts[1])) continue;
      const cellarRoot = path.posix.join(prefix, ...parts.slice(0, 3), 'lib', 'node_modules');
      if (globalRoot !== cellarRoot || await dependencies.realpath(stableRoot) !== stableRoot) continue;
      return target;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function assertHomebrewInstallation(
  installation: InstallationInspection,
  version: string,
  dependencies: SelfUpgradeDependencies
): Promise<void> {
  if (!installation.installationTarget) return;
  const prefix = homebrewPrefixes[installation.installationTarget];
  const globalRoot = path.posix.join(prefix, 'lib', 'node_modules');
  const packageRoot = expectedGlobalPackageRoot(globalRoot, 'darwin');
  try {
    for (const directory of [prefix, path.posix.join(prefix, 'bin'), globalRoot,
      path.posix.dirname(packageRoot), packageRoot]) {
      const details = await dependencies.lstat(directory);
      if (!details.isDirectory() || details.isSymbolicLink() || await dependencies.realpath(directory) !== directory) {
        throw new Error('Unsafe Homebrew installation directory.');
      }
    }
    const metadataPath = path.posix.join(packageRoot, 'package.json');
    const metadataDetails = await dependencies.lstat(metadataPath);
    if (!metadataDetails.isFile() || metadataDetails.isSymbolicLink()) {
      throw new Error('Unsafe Homebrew package metadata.');
    }
    const metadata = await dependencies.readJson(metadataPath) as Record<string, unknown> | null;
    if (!metadata || metadata.name !== liftoffPackageName || metadata.version !== version ||
      !metadata.bin || typeof metadata.bin !== 'object' || Array.isArray(metadata.bin)) {
      throw new Error('Invalid Homebrew package metadata.');
    }
    const declaredBin = (metadata.bin as Record<string, unknown>)[liftoffBinaryName];
    if (typeof declaredBin !== 'string' || !declaredBin || path.posix.isAbsolute(declaredBin)) {
      throw new Error('Invalid Homebrew package binary.');
    }
    const binary = path.posix.resolve(packageRoot, declaredBin);
    const launcher = path.posix.join(prefix, 'bin', liftoffBinaryName);
    if (!pathIsContained(packageRoot, binary, 'darwin')) {
      throw new Error('Escaping Homebrew package binary.');
    }
    const binaryDetails = await dependencies.lstat(binary);
    if (!binaryDetails.isFile() || binaryDetails.isSymbolicLink() ||
      await dependencies.realpath(binary) !== binary ||
      !(await dependencies.lstat(launcher)).isSymbolicLink() ||
      await dependencies.realpath(launcher) !== binary) {
      throw new Error('Homebrew launcher does not identify the running package.');
    }
  } catch {
    throw new SelfUpgradeFailure('blocked', 'unsupported_installation');
  }
}

async function inspectGlobalInstallation(
  request: SelfUpgradeRequest,
  neutralDirectory: string,
  dependencies: SelfUpgradeDependencies
): Promise<InstallationInspection> {
  const npmExecutable = npmExecutableForPlatform(dependencies.platform);
  const rootResult = await dependencies.runner.run(
    { executable: npmExecutable, args: ['root', '--global'] },
    {
      cwd: neutralDirectory,
      env: readOnlyEnvironment(dependencies, neutralDirectory),
      timeoutMs: selfUpgradeProbeTimeoutMs
    }
  );
  if (rootResult.errorCode === 'ENOENT') {
    throw new SelfUpgradeFailure('blocked', 'npm_unavailable');
  }
  if (commandFailed(rootResult)) {
    throw new SelfUpgradeFailure('failed', 'invalid_global_root');
  }
  const rootLines = rootResult.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (rootLines.length !== 1) {
    throw new SelfUpgradeFailure('blocked', 'invalid_global_root');
  }
  const pathApi = pathApiForPlatform(dependencies.platform);
  const reportedRoot = rootLines[0];
  if (!pathApi.isAbsolute(reportedRoot)) {
    throw new SelfUpgradeFailure('blocked', 'invalid_global_root');
  }

  let globalRoot: string;
  let runningRoot: string;
  try {
    globalRoot = await dependencies.realpath(reportedRoot);
    runningRoot = await dependencies.realpath(
      request.runningPackageRoot ?? sourcePackageRoot
    );
  } catch {
    throw new SelfUpgradeFailure('blocked', 'invalid_global_root');
  }
  let packageRoot = expectedGlobalPackageRoot(globalRoot, dependencies.platform);
  let installationTarget: SelfUpgradeInstallationTarget | undefined;
  if (
    !pathIsContained(globalRoot, packageRoot, dependencies.platform) ||
    comparisonPath(packageRoot, dependencies.platform) !==
      comparisonPath(runningRoot, dependencies.platform)
  ) {
    installationTarget = await homebrewInstallationTarget(globalRoot, runningRoot, dependencies);
    if (!installationTarget) throw new SelfUpgradeFailure('blocked', 'unsupported_installation');
    packageRoot = expectedGlobalPackageRoot(
      path.posix.join(homebrewPrefixes[installationTarget], 'lib', 'node_modules'), 'darwin'
    );
  }
  const installation = { npmExecutable, packageRoot, ...(installationTarget ? { installationTarget } : {}) };
  await assertHomebrewInstallation(installation, request.currentVersion, dependencies);

  let packageDetails: Stats;
  let metadata: unknown;
  try {
    packageDetails = await dependencies.lstat(packageRoot);
    metadata = await dependencies.readJson(pathApi.join(packageRoot, 'package.json'));
  } catch {
    throw new SelfUpgradeFailure('blocked', 'invalid_package');
  }
  if (packageDetails.isSymbolicLink() || !packageDetails.isDirectory()) {
    throw new SelfUpgradeFailure('blocked', 'unsupported_installation');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new SelfUpgradeFailure('blocked', 'invalid_package');
  }
  const packageMetadata = metadata as Record<string, unknown>;
  if (
    packageMetadata.name !== liftoffPackageName ||
    packageMetadata.version !== request.currentVersion
  ) {
    throw new SelfUpgradeFailure('blocked', 'invalid_package');
  }
  if (installationTarget) {
    const confirmedRoot = await npmGlobalRoot(npmExecutable, neutralDirectory, dependencies, installationTarget);
    if (expectedGlobalPackageRoot(confirmedRoot, dependencies.platform) !== packageRoot) {
      throw new SelfUpgradeFailure('blocked', 'unsupported_installation');
    }
  }
  return installation;
}

// Native handover reuses this read-only released owner inspection, never its npm updater.
export const inspectReleasedNpmInstallation = inspectGlobalInstallation;

function registryKind(value: string): SelfUpgradeRegistryKind {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SelfUpgradeFailure('blocked', 'registry_invalid');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new SelfUpgradeFailure('blocked', 'registry_invalid');
  }
  const normalized = parsed.toString().replace(/\/$/, '');
  return normalized === canonicalNpmRegistry ? 'canonical' : 'configured';
}

async function configuredUpgradeRegistry(
  npmExecutable: string,
  neutralDirectory: string,
  dependencies: SelfUpgradeDependencies,
  timeoutMs: number,
  installationTarget?: SelfUpgradeInstallationTarget
): Promise<{ url: string; kind: SelfUpgradeRegistryKind }> {
  const options = {
    cwd: neutralDirectory,
    env: readOnlyEnvironment(dependencies, neutralDirectory),
    timeoutMs
  };
  const scopedRegistryResult = await dependencies.runner.run(
    npmCommand(npmExecutable, ['config', 'get', liftoffScopedRegistryKey], installationTarget),
    options
  );
  if (commandFailed(scopedRegistryResult)) {
    throw new SelfUpgradeFailure('failed', 'registry_unavailable');
  }

  const scopedRegistry = scopedRegistryResult.stdout.trim();
  let configuredRegistry = scopedRegistry;
  if (
    configuredRegistry === '' ||
    configuredRegistry === 'undefined' ||
    configuredRegistry === 'null'
  ) {
    const defaultRegistryResult = await dependencies.runner.run(
      npmCommand(npmExecutable, ['config', 'get', 'registry'], installationTarget),
      options
    );
    if (commandFailed(defaultRegistryResult)) {
      throw new SelfUpgradeFailure('failed', 'registry_unavailable');
    }
    configuredRegistry = defaultRegistryResult.stdout.trim();
  }
  const kind = registryKind(configuredRegistry);
  return { url: new URL(configuredRegistry).toString().replace(/\/$/, ''), kind };
}

async function inspectRegistryParity(
  targetVersion: string,
  npmExecutable: string,
  neutralDirectory: string,
  dependencies: SelfUpgradeDependencies,
  timeoutMs = selfUpgradeProbeTimeoutMs,
  installationTarget?: SelfUpgradeInstallationTarget
): Promise<RegistryInspection> {
  const active = await configuredUpgradeRegistry(npmExecutable, neutralDirectory, dependencies, timeoutMs);
  const delivery = installationTarget
    ? await configuredUpgradeRegistry(npmExecutable, neutralDirectory, dependencies, timeoutMs, installationTarget)
    : active;
  if (delivery.url !== active.url) {
    throw new SelfUpgradeFailure('blocked', 'registry_prefix_mismatch');
  }
  const kind = delivery.kind;
  const options = {
    cwd: neutralDirectory,
    env: readOnlyEnvironment(dependencies, neutralDirectory),
    timeoutMs
  };
  const targetResult = await dependencies.runner.run(
    npmCommand(npmExecutable, [
      'view',
      `${liftoffPackageName}@${targetVersion}`,
      'name',
      'version',
      '--json'
    ], installationTarget),
    options
  );
  if (commandFailed(targetResult)) {
    const notFound = targetResult.status === 1 &&
      /\b(?:E404|404|not found|no match)\b/i.test(targetResult.stderr);
    throw new SelfUpgradeFailure(
      notFound ? 'blocked' : 'failed',
      notFound ? 'registry_stale' : 'registry_unavailable',
      kind
    );
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(targetResult.stdout);
  } catch {
    throw new SelfUpgradeFailure('failed', 'registry_invalid', kind);
  }
  if (Array.isArray(metadata)) {
    if (metadata.length !== 1) {
      throw new SelfUpgradeFailure('failed', 'registry_invalid', kind);
    }
    [metadata] = metadata;
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new SelfUpgradeFailure('failed', 'registry_invalid', kind);
  }
  const record = metadata as Record<string, unknown>;
  if (record.name !== liftoffPackageName || record.version !== targetVersion) {
    throw new SelfUpgradeFailure('blocked', 'registry_stale', kind);
  }
  return { kind };
}

export async function checkConfiguredRegistryTarget(
  targetVersion: string,
  overrides: Partial<SelfUpgradeDependencies> = {}
): Promise<ConfiguredRegistryTargetResult> {
  const dependencies: SelfUpgradeDependencies = {
    ...defaultSelfUpgradeDependencies(),
    ...overrides
  };
  let neutralDirectory: string;
  try {
    neutralDirectory = await dependencies.makeNeutralDirectory();
  } catch {
    return { status: 'unavailable' };
  }
  try {
    const inspection = await inspectRegistryParity(
      targetVersion,
      npmExecutableForPlatform(dependencies.platform),
      neutralDirectory,
      dependencies,
      stableReleaseLookupTimeoutMs
    );
    return { status: 'available', registryKind: inspection.kind };
  } catch (error) {
    if (
      error instanceof SelfUpgradeFailure &&
      error.reasonCode === 'registry_stale'
    ) {
      return { status: 'stale' };
    }
    return { status: 'unavailable' };
  } finally {
    await dependencies.removeNeutralDirectory(neutralDirectory);
  }
}

async function npmGlobalRoot(
  npmExecutable: string,
  neutralDirectory: string,
  dependencies: SelfUpgradeDependencies,
  installationTarget?: SelfUpgradeInstallationTarget
): Promise<string> {
  const rootResult = await dependencies.runner.run(
    npmCommand(npmExecutable, ['root', '--global'], installationTarget),
    {
      cwd: neutralDirectory,
      env: readOnlyEnvironment(dependencies, neutralDirectory),
      timeoutMs: selfUpgradeProbeTimeoutMs
    }
  );
  if (commandFailed(rootResult)) {
    throw new SelfUpgradeFailure('failed', 'verification_failed');
  }
  const lines = rootResult.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1 || !pathApiForPlatform(dependencies.platform).isAbsolute(lines[0])) {
    throw new SelfUpgradeFailure('failed', 'verification_failed');
  }
  try {
    return await dependencies.realpath(lines[0]);
  } catch {
    throw new SelfUpgradeFailure('failed', 'verification_failed');
  }
}

async function verifyReplacement(
  targetVersion: string,
  installation: InstallationInspection,
  neutralDirectory: string,
  dependencies: SelfUpgradeDependencies
): Promise<void> {
  const pathApi = pathApiForPlatform(dependencies.platform);
  const globalRoot = await npmGlobalRoot(
    installation.npmExecutable, neutralDirectory, dependencies, installation.installationTarget
  );
  const packageRoot = expectedGlobalPackageRoot(globalRoot, dependencies.platform);
  if (comparisonPath(packageRoot, dependencies.platform) !== comparisonPath(installation.packageRoot, dependencies.platform)) {
    throw new SelfUpgradeFailure('failed', 'verification_failed');
  }
  let packageDetails: Stats;
  let metadata: unknown;
  try {
    packageDetails = await dependencies.lstat(packageRoot);
    metadata = await dependencies.readJson(pathApi.join(packageRoot, 'package.json'));
  } catch {
    throw new SelfUpgradeFailure('failed', 'verification_failed');
  }
  if (
    packageDetails.isSymbolicLink() ||
    !packageDetails.isDirectory() ||
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata)
  ) {
    throw new SelfUpgradeFailure('failed', 'verification_failed');
  }
  try {
    if (comparisonPath(await dependencies.realpath(packageRoot), dependencies.platform) !==
      comparisonPath(packageRoot, dependencies.platform)) {
      throw new Error('Replacement package escaped its original root.');
    }
    await assertHomebrewInstallation(installation, targetVersion, dependencies);
  } catch {
    throw new SelfUpgradeFailure('failed', 'verification_failed');
  }
  const record = metadata as Record<string, unknown>;
  const bin = record.bin;
  if (
    record.name !== liftoffPackageName ||
    record.version !== targetVersion ||
    !bin ||
    typeof bin !== 'object' ||
    Array.isArray(bin) ||
    typeof (bin as Record<string, unknown>)[liftoffBinaryName] !== 'string'
  ) {
    throw new SelfUpgradeFailure('failed', 'verification_failed');
  }
  const declaredBin = (bin as Record<string, string>)[liftoffBinaryName];
  if (pathApi.isAbsolute(declaredBin)) {
    throw new SelfUpgradeFailure('failed', 'verification_failed');
  }
  const binaryPath = pathApi.resolve(packageRoot, declaredBin);
  if (!pathIsContained(packageRoot, binaryPath, dependencies.platform)) {
    throw new SelfUpgradeFailure('failed', 'verification_failed');
  }
  let binaryDetails: Stats;
  let canonicalBinary: string;
  try {
    binaryDetails = await dependencies.lstat(binaryPath);
    canonicalBinary = await dependencies.realpath(binaryPath);
  } catch {
    throw new SelfUpgradeFailure('failed', 'verification_failed');
  }
  if (
    binaryDetails.isSymbolicLink() ||
    !binaryDetails.isFile() ||
    !pathIsContained(packageRoot, canonicalBinary, dependencies.platform)
  ) {
    throw new SelfUpgradeFailure('failed', 'verification_failed');
  }
  const versionResult = await dependencies.runner.run(
    {
      executable: dependencies.execPath,
      args: [canonicalBinary, '--version']
    },
    {
      cwd: neutralDirectory,
      env: {
        ...dependencies.environment,
        CI: 'true',
        DO_NOT_TRACK: '1',
        LIFTOFF_TELEMETRY: '0'
      },
      timeoutMs: selfUpgradeVerificationTimeoutMs
    }
  );
  if (
    commandFailed(versionResult) ||
    versionResult.stdout.trim() !== `Liftoff ${targetVersion}`
  ) {
    throw new SelfUpgradeFailure('failed', 'verification_failed');
  }
}

function canonicalFailureReason(error: StableReleaseLookupError): SelfUpgradeReasonCode {
  switch (error.code) {
    case 'invalid_metadata':
      return 'canonical_invalid';
    case 'timeout':
      return 'canonical_timeout';
    case 'http_failure':
    case 'network_failure':
      return 'canonical_unavailable';
    default:
      return assertNever(error.code);
  }
}

export async function runSelfUpgrade(
  request: SelfUpgradeRequest,
  overrides: Partial<SelfUpgradeDependencies> = {}
): Promise<SelfUpgradeResult> {
  const dependencies: SelfUpgradeDependencies = {
    ...defaultSelfUpgradeDependencies(),
    ...overrides
  };
  const neutralDirectory = await dependencies.makeNeutralDirectory();
  let targetVersion: string | undefined;
  let registry: SelfUpgradeRegistryKind | undefined;
  let installationTarget: SelfUpgradeInstallationTarget | undefined;
  const finish = (
    status: SelfUpgradeStatus,
    reasonCode: SelfUpgradeReasonCode,
    details: { targetVersion?: string; registryKind?: SelfUpgradeRegistryKind } = {}
  ) => result(request, status, reasonCode, { ...details, installationTarget });
  try {
    request.onStage?.('Inspect global installation');
    const installation = await inspectGlobalInstallation(
      request,
      neutralDirectory,
      dependencies
    );
    installationTarget = installation.installationTarget;

    request.onStage?.('Resolve canonical stable target');
    let stable: StableRelease;
    try {
      stable = await dependencies.lookupStableRelease();
    } catch (error) {
      if (error instanceof StableReleaseLookupError) {
        return finish('failed', canonicalFailureReason(error));
      }
      return finish('failed', 'canonical_unavailable');
    }
    if (stable.name !== liftoffPackageName || !isStableSemver(stable.version)) {
      return finish('failed', 'canonical_invalid');
    }
    targetVersion = stable.version;
    const comparison = compareSemver(targetVersion, request.currentVersion);
    if (comparison === 0) {
      return finish('current', 'current');
    }
    if (comparison < 0) {
      return finish('blocked', 'downgrade_refused', { targetVersion });
    }

    request.onStage?.('Verify configured registry parity');
    const registryInspection = await inspectRegistryParity(
      targetVersion,
      installation.npmExecutable,
      neutralDirectory,
      dependencies,
      selfUpgradeProbeTimeoutMs,
      installationTarget
    );
    registry = registryInspection.kind;
    if (request.mode === 'check') {
      return finish('update-available', 'update_available', {
        targetVersion,
        registryKind: registry
      });
    }

    if (installationTarget) {
      const confirmedRoot = await npmGlobalRoot(
        installation.npmExecutable, neutralDirectory, dependencies, installationTarget
      );
      if (expectedGlobalPackageRoot(confirmedRoot, dependencies.platform) !== installation.packageRoot) {
        throw new SelfUpgradeFailure('blocked', 'unsupported_installation');
      }
      await assertHomebrewInstallation(installation, request.currentVersion, dependencies);
    }
    request.onStage?.('Install exact Liftoff release', targetVersion);
    const installCommand = buildGlobalNpmInstallCommand(
      targetVersion,
      dependencies.platform,
      installationTarget
    );
    request.onInstallCommand?.(installCommand);
    const installResult = await dependencies.runner.run(installCommand, {
      cwd: neutralDirectory,
      env: readOnlyEnvironment(dependencies, neutralDirectory),
      timeoutMs: selfUpgradeInstallTimeoutMs,
      stream: true,
      stdout: request.json ? request.stderr : request.stdout,
      stderr: request.stderr
    });
    if (installResult.timedOut) {
      return finish('failed', 'npm_install_timeout', {
        targetVersion,
        registryKind: registry
      });
    }
    if (commandFailed(installResult)) {
      return finish('failed', 'npm_install_failed', {
        targetVersion,
        registryKind: registry
      });
    }

    request.onStage?.('Verify replacement', targetVersion);
    await verifyReplacement(
      targetVersion,
      installation,
      neutralDirectory,
      dependencies
    );
    return finish('upgraded', 'upgrade_complete', {
      targetVersion,
      registryKind: registry
    });
  } catch (error) {
    if (error instanceof SelfUpgradeFailure) {
      return finish(error.status, error.reasonCode, {
        ...(targetVersion ? { targetVersion } : {}),
        ...(registry ?? error.registryKind
          ? { registryKind: registry ?? error.registryKind }
          : {})
      });
    }
    return finish('failed', 'verification_failed', {
      ...(targetVersion ? { targetVersion } : {}),
      ...(registry ? { registryKind: registry } : {})
    });
  } finally {
    await dependencies.removeNeutralDirectory(neutralDirectory);
  }
}

function defaultSelfUpgradeDependencies(): SelfUpgradeDependencies {
  return {
    runner: new NodeCommandRunner(),
    lookupStableRelease,
    makeNeutralDirectory: () =>
      mkdtemp(path.join(os.tmpdir(), 'liftoff-upgrade-')),
    removeNeutralDirectory: (directory) =>
      rm(directory, { recursive: true, force: true }),
    readJson: async (filePath) =>
      JSON.parse(await readFile(filePath, 'utf8')) as unknown,
    lstat,
    realpath,
    platform: process.platform,
    execPath: process.execPath,
    environment: process.env
  };
}
