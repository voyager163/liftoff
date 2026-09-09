import { packagedSupportedStack as supportedStack } from './adapters/packaged-assets/supported-stack.js';

export const liftoffPackageName = '@msn-control/liftoff';
export const liftoffPackageScope = '@msn-control';
export const liftoffScopedRegistryKey = `${liftoffPackageScope}:registry`;
export const liftoffBinaryName = 'liftoff';
export const canonicalNpmRegistry = 'https://registry.npmjs.org';
export const stableNpmTag = 'latest';
export const supportedNpmVersion = supportedStack.packageManagers.npm.version;

export function npmExecutableForPlatform(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function exactGlobalInstallCommand(version: string): string {
  return `npm install --global --ignore-scripts --no-audit --no-fund ${liftoffPackageName}@${version}`;
}

export function npmRegistryOverrideArgs(registry: string): string[] {
  return [
    `--registry=${registry}`,
    `--${liftoffScopedRegistryKey}=${registry}`
  ];
}

export function canonicalManualInstallCommand(version = stableNpmTag): string {
  return [
    exactGlobalInstallCommand(version),
    ...npmRegistryOverrideArgs(canonicalNpmRegistry)
  ].join(' ');
}
