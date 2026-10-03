import type { ExternalCommand } from '../../domain/project/contracts.js';
import {
  liftoffPackageName,
  npmExecutableForPlatform
} from '../../domain/distribution/liftoff-package.js';
import {
  buildGlobalNpmInstallCommand,
  commandFailed
} from '../../domain/distribution/liftoff-npm-installation.js';
import {
  canonicalFailureReason,
  SelfUpgradeFailure,
  selfUpgradeProbeTimeoutMs,
  selfUpgradeResult,
  type SelfUpgradeInstallationTarget,
  type SelfUpgradeMode,
  type SelfUpgradeReasonCode,
  type SelfUpgradeRegistryKind,
  type SelfUpgradeResult,
  type SelfUpgradeStage,
  type SelfUpgradeStatus
} from '../../domain/distribution/liftoff-upgrade.js';
import {
  inspectGlobalInstallation,
  inspectRegistryParity,
  reconfirmHomebrewInstallation,
  runExactGlobalInstall,
  verifyReplacement
} from '../../adapters/distribution/npm.js';
import {
  defaultSelfUpgradeDependencies,
  type SelfUpgradeDependencies
} from '../../adapters/distribution/upgrade-host.js';
import {
  isStableSemver,
  stableReleaseLookupTimeoutMs,
  StableReleaseLookupError,
  type StableRelease
} from '../../stable-release.js';
import { compareSemver } from '../../semver.js';

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
  ) => selfUpgradeResult(request, status, reasonCode, { ...details, installationTarget });
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
        return finish('failed', canonicalFailureReason(error.code));
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

    await reconfirmHomebrewInstallation(installation, request.currentVersion, neutralDirectory, dependencies);
    request.onStage?.('Install exact Liftoff release', targetVersion);
    const installCommand = buildGlobalNpmInstallCommand(
      targetVersion,
      dependencies.platform,
      installationTarget
    );
    request.onInstallCommand?.(installCommand);
    const installResult = await runExactGlobalInstall(installCommand, neutralDirectory, dependencies, request);
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
