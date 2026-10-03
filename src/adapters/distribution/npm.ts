import type { Stats } from 'node:fs';
import path from 'node:path';
import { installedPackageRoot } from '../packaged-assets/package-root.js';
import type { ExternalCommand } from '../../domain/project/contracts.js';
import {
  liftoffBinaryName,
  liftoffPackageName,
  liftoffScopedRegistryKey,
  npmExecutableForPlatform
} from '../../domain/distribution/liftoff-package.js';
import {
  homebrewPrefixes,
  SelfUpgradeFailure,
  selfUpgradeInstallTimeoutMs,
  selfUpgradeProbeTimeoutMs,
  selfUpgradeVerificationTimeoutMs,
  type SelfUpgradeInstallationTarget,
  type SelfUpgradeRegistryKind
} from '../../domain/distribution/liftoff-upgrade.js';
import {
  commandFailed,
  comparisonPath,
  expectedGlobalPackageRoot,
  npmCommand,
  pathApiForPlatform,
  pathIsContained,
  readOnlyEnvironment,
  registryKind
} from '../../domain/distribution/liftoff-npm-installation.js';
import type { CommandResult } from '../../process-runner.js';
import type { SelfUpgradeDependencies } from './upgrade-host.js';

export interface InstallationInspection {
  npmExecutable: string;
  packageRoot: string;
  installationTarget?: SelfUpgradeInstallationTarget;
}

export interface RegistryInspection {
  kind: SelfUpgradeRegistryKind;
}

/** Structural subsets of the application request, so this adapter never depends on application types. */
interface InstallationRequest {
  currentVersion: string;
  runningPackageRoot?: string;
}

interface InstallOutput {
  json: boolean;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

const sourcePackageRoot = installedPackageRoot;

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

export async function assertHomebrewInstallation(
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

export async function inspectGlobalInstallation(
  request: InstallationRequest,
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

export async function inspectRegistryParity(
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

export async function npmGlobalRoot(
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

export async function reconfirmHomebrewInstallation(
  installation: InstallationInspection,
  currentVersion: string,
  neutralDirectory: string,
  dependencies: SelfUpgradeDependencies
): Promise<void> {
  if (!installation.installationTarget) return;
  const confirmedRoot = await npmGlobalRoot(
    installation.npmExecutable, neutralDirectory, dependencies, installation.installationTarget
  );
  if (expectedGlobalPackageRoot(confirmedRoot, dependencies.platform) !== installation.packageRoot) {
    throw new SelfUpgradeFailure('blocked', 'unsupported_installation');
  }
  await assertHomebrewInstallation(installation, currentVersion, dependencies);
}

export function runExactGlobalInstall(
  installCommand: ExternalCommand,
  neutralDirectory: string,
  dependencies: SelfUpgradeDependencies,
  output: InstallOutput
): Promise<CommandResult> {
  return dependencies.runner.run(installCommand, {
    cwd: neutralDirectory,
    env: readOnlyEnvironment(dependencies, neutralDirectory),
    timeoutMs: selfUpgradeInstallTimeoutMs,
    stream: true,
    stdout: output.json ? output.stderr : output.stdout,
    stderr: output.stderr
  });
}

export async function verifyReplacement(
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
