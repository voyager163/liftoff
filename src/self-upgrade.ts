import type { Stats } from 'node:fs';
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalManualInstallCommand,
  canonicalNpmRegistry,
  exactGlobalInstallCommand,
  liftoffBinaryName,
  liftoffPackageName,
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
import type { ExternalCommand } from './types.js';

export const selfUpgradeSchemaVersion = 1 as const;
export const selfUpgradeInstallTimeoutMs = 10 * 60_000;
export const selfUpgradeProbeTimeoutMs = 30_000;
export const selfUpgradeVerificationTimeoutMs = 15_000;

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

const sourcePackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

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
  platform: NodeJS.Platform
): ExternalCommand {
  return {
    executable: npmExecutableForPlatform(platform),
    args: [
      'install',
      '--global',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `${liftoffPackageName}@${targetVersion}`
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
  } = {}
): SelfUpgradeResult {
  return {
    schemaVersion: selfUpgradeSchemaVersion,
    mode: request.mode,
    status,
    currentVersion: request.currentVersion,
    reasonCode,
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
        ? `Run the exact repair command manually: ${exactGlobalInstallCommand(value.targetVersion)}`
        : undefined;
    case 'unsupported_installation':
    case 'invalid_global_root':
    case 'invalid_package':
    case 'npm_unavailable':
      return `Use a supported global npm installation: ${canonicalManualInstallCommand()}`;
    case 'canonical_invalid':
    case 'canonical_timeout':
    case 'canonical_unavailable':
      return 'Retry after canonical npm is reachable and exposes valid stable Liftoff metadata.';
    case 'registry_invalid':
    case 'registry_unavailable':
      return 'Repair the approved npm registry configuration without placing credentials in the registry URL, then retry.';
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
  const packageRoot = expectedGlobalPackageRoot(globalRoot, dependencies.platform);
  if (
    !pathIsContained(globalRoot, packageRoot, dependencies.platform) ||
    comparisonPath(packageRoot, dependencies.platform) !==
      comparisonPath(runningRoot, dependencies.platform)
  ) {
    throw new SelfUpgradeFailure('blocked', 'unsupported_installation');
  }

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
  return { npmExecutable, packageRoot };
}

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

async function inspectRegistryParity(
  targetVersion: string,
  npmExecutable: string,
  neutralDirectory: string,
  dependencies: SelfUpgradeDependencies,
  timeoutMs = selfUpgradeProbeTimeoutMs
): Promise<RegistryInspection> {
  const options = {
    cwd: neutralDirectory,
    env: readOnlyEnvironment(dependencies, neutralDirectory),
    timeoutMs
  };
  const registryResult = await dependencies.runner.run(
    { executable: npmExecutable, args: ['config', 'get', 'registry'] },
    options
  );
  if (commandFailed(registryResult)) {
    throw new SelfUpgradeFailure('failed', 'registry_unavailable');
  }

  const configuredRegistry = registryResult.stdout.trim();
  const kind = registryKind(configuredRegistry);
  const targetResult = await dependencies.runner.run(
    {
      executable: npmExecutable,
      args: [
        'view',
        `${liftoffPackageName}@${targetVersion}`,
        'name',
        'version',
        '--json'
      ]
    },
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
  dependencies: SelfUpgradeDependencies
): Promise<string> {
  const rootResult = await dependencies.runner.run(
    { executable: npmExecutable, args: ['root', '--global'] },
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
  npmExecutable: string,
  neutralDirectory: string,
  dependencies: SelfUpgradeDependencies
): Promise<void> {
  const pathApi = pathApiForPlatform(dependencies.platform);
  const globalRoot = await npmGlobalRoot(npmExecutable, neutralDirectory, dependencies);
  const packageRoot = expectedGlobalPackageRoot(globalRoot, dependencies.platform);
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
  try {
    request.onStage?.('Inspect global installation');
    const installation = await inspectGlobalInstallation(
      request,
      neutralDirectory,
      dependencies
    );

    request.onStage?.('Resolve canonical stable target');
    let stable: StableRelease;
    try {
      stable = await dependencies.lookupStableRelease();
    } catch (error) {
      if (error instanceof StableReleaseLookupError) {
        return result(request, 'failed', canonicalFailureReason(error));
      }
      return result(request, 'failed', 'canonical_unavailable');
    }
    if (stable.name !== liftoffPackageName || !isStableSemver(stable.version)) {
      return result(request, 'failed', 'canonical_invalid');
    }
    targetVersion = stable.version;
    const comparison = compareSemver(targetVersion, request.currentVersion);
    if (comparison === 0) {
      return result(request, 'current', 'current');
    }
    if (comparison < 0) {
      return result(request, 'blocked', 'downgrade_refused', { targetVersion });
    }

    request.onStage?.('Verify configured registry parity');
    const registryInspection = await inspectRegistryParity(
      targetVersion,
      installation.npmExecutable,
      neutralDirectory,
      dependencies
    );
    registry = registryInspection.kind;
    if (request.mode === 'check') {
      return result(request, 'update-available', 'update_available', {
        targetVersion,
        registryKind: registry
      });
    }

    request.onStage?.('Install exact Liftoff release', targetVersion);
    const installCommand = buildGlobalNpmInstallCommand(
      targetVersion,
      dependencies.platform
    );
    request.onInstallCommand?.(installCommand);
    const installResult = await dependencies.runner.run(installCommand, {
      cwd: neutralDirectory,
      env: dependencies.environment,
      timeoutMs: selfUpgradeInstallTimeoutMs,
      stream: true,
      stdout: request.json ? request.stderr : request.stdout,
      stderr: request.stderr
    });
    if (installResult.timedOut) {
      return result(request, 'failed', 'npm_install_timeout', {
        targetVersion,
        registryKind: registry
      });
    }
    if (commandFailed(installResult)) {
      return result(request, 'failed', 'npm_install_failed', {
        targetVersion,
        registryKind: registry
      });
    }

    request.onStage?.('Verify replacement', targetVersion);
    await verifyReplacement(
      targetVersion,
      installation.npmExecutable,
      neutralDirectory,
      dependencies
    );
    return result(request, 'upgraded', 'upgrade_complete', {
      targetVersion,
      registryKind: registry
    });
  } catch (error) {
    if (error instanceof SelfUpgradeFailure) {
      return result(request, error.status, error.reasonCode, {
        ...(targetVersion ? { targetVersion } : {}),
        ...(registry ?? error.registryKind
          ? { registryKind: registry ?? error.registryKind }
          : {})
      });
    }
    return result(request, 'failed', 'verification_failed', {
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
