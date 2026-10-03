import path from 'node:path';
import type { ExternalCommand } from '../project/contracts.js';
import type { CommandResult } from '../../process-runner.js';
import {
  canonicalNpmRegistry,
  liftoffPackageName,
  npmExecutableForPlatform
} from './liftoff-package.js';
import {
  homebrewPrefixes,
  SelfUpgradeFailure,
  type SelfUpgradeInstallationTarget,
  type SelfUpgradeRegistryKind
} from './liftoff-upgrade.js';

interface PathApi {
  isAbsolute(value: string): boolean;
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
  resolve(...parts: string[]): string;
  sep: string;
}

export function pathApiForPlatform(platform: NodeJS.Platform): PathApi {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function comparisonPath(value: string, platform: NodeJS.Platform): string {
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

export function npmCommand(
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

export function readOnlyEnvironment(
  dependencies: { environment: NodeJS.ProcessEnv },
  neutralDirectory: string
): NodeJS.ProcessEnv {
  return {
    ...dependencies.environment,
    npm_config_cache: path.join(neutralDirectory, 'npm-cache')
  };
}

export function commandFailed(command: CommandResult): boolean {
  return command.errorCode !== undefined ||
    command.errorMessage !== undefined ||
    command.timedOut ||
    command.signal !== null ||
    command.status !== 0;
}

export function registryKind(value: string): SelfUpgradeRegistryKind {
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
