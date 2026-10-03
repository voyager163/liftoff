import { packagedSupportedStack as supportedStack } from './adapters/packaged-assets/supported-stack.js';

export {
  canonicalManualInstallCommand,
  canonicalNpmRegistry,
  exactGlobalInstallCommand,
  liftoffBinaryName,
  liftoffPackageName,
  liftoffPackageScope,
  liftoffScopedRegistryKey,
  npmExecutableForPlatform,
  npmRegistryOverrideArgs,
  stableNpmTag
} from './domain/distribution/liftoff-package.js';

export const supportedNpmVersion = supportedStack.packageManagers.npm.version;
