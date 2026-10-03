export {
  selfUpgradeExitCode,
  selfUpgradeInstallTimeoutMs,
  selfUpgradeProbeTimeoutMs,
  selfUpgradeRemedy,
  selfUpgradeSchemaVersion,
  selfUpgradeSummary,
  selfUpgradeVerificationTimeoutMs,
  type SelfUpgradeInstallationTarget,
  type SelfUpgradeMode,
  type SelfUpgradeReasonCode,
  type SelfUpgradeRegistryKind,
  type SelfUpgradeResult,
  type SelfUpgradeStage,
  type SelfUpgradeStatus
} from './domain/distribution/liftoff-upgrade.js';
export {
  buildGlobalNpmInstallCommand,
  expectedGlobalPackageRoot,
  pathIsContained
} from './domain/distribution/liftoff-npm-installation.js';
export type { SelfUpgradeDependencies } from './adapters/distribution/upgrade-host.js';
export {
  checkConfiguredRegistryTarget,
  runSelfUpgrade,
  type ConfiguredRegistryTargetLookup,
  type ConfiguredRegistryTargetResult,
  type SelfUpgradeExecutor,
  type SelfUpgradeRequest
} from './application/upgrade/self-upgrade.js';
