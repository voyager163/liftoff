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
  type InstallationOwner,
  type ReleaseAvailability,
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
import { installedPackageRoot } from '../../adapters/packaged-assets/package-root.js';
import { createNativeUpgradePort } from '../../adapters/distribution/native.js';
import { nativeManagerHandoff, type NativeInstallation, type NativeUpgradePort } from '../../domain/distribution/native-upgrade.js';
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
  runningExecutable?: string;
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
    ...defaultSelfUpgradeDependencies(overrides.environment),
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
    ...defaultSelfUpgradeDependencies(overrides.environment),
    ...overrides,
    ...(request.runningExecutable ? { runningExecutable: request.runningExecutable } : {})
  };
  let neutralDirectory: string;
  let targetVersion: string | undefined;
  let registry: SelfUpgradeRegistryKind | undefined;
  let installationTarget: SelfUpgradeInstallationTarget | undefined;
  let installationOwner: InstallationOwner = 'unknown';
  let upstream: ReleaseAvailability = { status: 'unknown' };
  let channel: ReleaseAvailability = { status: 'unknown' };
  let effects: 'none' | 'possible' | 'installed' = 'none';
  let verification: 'not-run' | 'verified' | 'failed' = 'not-run';
  const finish = (
    status: SelfUpgradeStatus,
    reasonCode: SelfUpgradeReasonCode,
    details: Parameters<typeof selfUpgradeResult>[3] = {}
  ) => selfUpgradeResult(request, status, reasonCode, { targetVersion, ...details, installationTarget,
    installationOwner, upstream, channel, effects, verification });
  try {
    neutralDirectory = await dependencies.makeNeutralDirectory();
  } catch {
    return finish('failed', 'neutral_directory_unavailable');
  }
  const outcome = await inspectAndUpgrade();
  try {
    await dependencies.removeNeutralDirectory(neutralDirectory);
  } catch {
    return { ...outcome, status: 'failed', reasonCode: 'cleanup_failed' };
  }
  return outcome;

  async function inspectAndUpgrade(): Promise<SelfUpgradeResult> {
    try {
      if (!isStableSemver(request.currentVersion)) return finish('blocked', 'invalid_package');
      request.onStage?.('Inspect installation owner');
      const native = dependencies.nativeUpgrade ?? createNativeUpgradePort(dependencies);
      const nativeInstallation = await native.inspect(
        request.runningPackageRoot ?? installedPackageRoot, request.currentVersion, neutralDirectory
      );
      if (nativeInstallation) {
        installationOwner = nativeInstallation.owner;
        return await runNativeUpgrade(nativeInstallation, native);
      }
      const installation = await inspectGlobalInstallation(
        request,
        neutralDirectory,
        dependencies
      );
      installationOwner = 'npm';
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
      upstream = { status: 'available', version: targetVersion };
      const comparison = compareSemver(targetVersion, request.currentVersion);
      if (comparison < 0) {
        return finish('blocked', 'downgrade_refused', { targetVersion });
      }

      request.onStage?.('Verify configured registry parity');
      const registryInspection = await inspectRegistryParity(
        targetVersion,
        installation.npmExecutable,
        neutralDirectory,
        dependencies,
        dependencies.probeTimeoutMs ?? selfUpgradeProbeTimeoutMs,
        installationTarget
      );
      registry = registryInspection.kind;
      channel = { status: 'available', version: targetVersion };
      if (comparison === 0) return finish('current', 'current');
      if (request.mode === 'check') {
        return finish('update-available', 'update_available', {
          targetVersion,
          registryKind: registry
        });
      }

      const currentInstallation = await inspectGlobalInstallation(request, neutralDirectory, dependencies);
      if (currentInstallation.identity !== installation.identity ||
        currentInstallation.packageRoot !== installation.packageRoot || currentInstallation.installationTarget !== installation.installationTarget) {
        return finish('blocked', 'owner_changed');
      }
      const currentStable = await dependencies.lookupStableRelease();
      if (currentStable.name !== stable.name || currentStable.version !== targetVersion) return finish('blocked', 'channel_changed');
      const currentRegistry = await inspectRegistryParity(targetVersion, installation.npmExecutable, neutralDirectory,
        dependencies, dependencies.probeTimeoutMs ?? selfUpgradeProbeTimeoutMs, installationTarget);
      if (currentRegistry.identity !== registryInspection.identity) return finish('blocked', 'channel_changed');
      const finalInstallation = await inspectGlobalInstallation(request, neutralDirectory, dependencies);
      if (finalInstallation.identity !== installation.identity) return finish('blocked', 'owner_changed');
      await reconfirmHomebrewInstallation(installation, request.currentVersion, neutralDirectory, dependencies);
      request.onStage?.('Install exact Liftoff release', targetVersion);
      const installCommand = buildGlobalNpmInstallCommand(
        targetVersion,
        dependencies.platform,
        installationTarget
      );
      request.onInstallCommand?.(installCommand);
      effects = 'possible';
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
      verification = 'failed';
      await verifyReplacement(
        targetVersion,
        installation,
        neutralDirectory,
        dependencies
      );
      effects = 'installed';
      verification = 'verified';
      return finish('upgraded', 'upgrade_complete', {
        targetVersion,
        registryKind: registry
      });
    } catch (error) {
      if (error instanceof SelfUpgradeFailure) {
        if (error.reasonCode.startsWith('registry_')) channel = {
          status: error.reasonCode === 'registry_stale' ? 'lagging' : error.reasonCode === 'registry_absent' ? 'absent' : 'unknown'
        };
        if (error.reasonCode === 'native_unqualified') upstream = channel = { status: 'unqualified' };
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
    }
  }

  async function runNativeUpgrade(installation: NativeInstallation, port: NativeUpgradePort): Promise<SelfUpgradeResult> {
    if (installation.recovery || installation.locked) {
      effects = 'possible';
      return finish('blocked', 'recovery_required');
    }
    request.onStage?.('Resolve verified stable target');
    const candidate = await port.stable(installation, neutralDirectory);
    if (!isStableSemver(candidate.version) || candidate.target !== installation.target ||
      !/^[a-f0-9]{40}$/.test(candidate.sourceCommit) || !/^[a-f0-9]{64}$/.test(candidate.manifestSha256) ||
      !/^[a-f0-9]{64}$/.test(candidate.inventorySha256) || !candidate.identity) {
      return finish('failed', 'native_invalid');
    }
    targetVersion = candidate.version;
    upstream = { status: 'available', version: targetVersion };
    const comparison = compareSemver(targetVersion, request.currentVersion);
    if (comparison < 0) return finish('blocked', 'downgrade_refused');
    request.onStage?.('Verify owning channel availability');
    const available = await port.channel(installation, candidate, neutralDirectory);
    channel = available.status === 'absent' ? { status: 'absent' } : {
      status: available.status, version: available.version
    };
    if (available.status !== 'available') return finish('blocked', available.status === 'absent' ? 'channel_absent' : 'channel_lag');
    if (available.version !== targetVersion || !available.identity) return finish('failed', 'channel_invalid');
    if (comparison === 0) {
      if (candidate.manifestSha256 !== installation.manifestSha256 ||
        candidate.inventorySha256 !== installation.inventorySha256 || candidate.sourceCommit !== installation.sourceCommit) {
        return finish('blocked', 'native_identity_mismatch');
      }
      return finish('current', 'current');
    }
    const handoff = nativeManagerHandoff(installation, targetVersion);
    if (request.mode === 'check') return finish('update-available', 'update_available', { handoff });
    const observed = await port.inspect(installation.packageRoot, request.currentVersion, neutralDirectory);
    if (!observed || observed.identity !== installation.identity || observed.owner !== installation.owner) {
      return finish('blocked', 'owner_changed');
    }
    const refreshed = await port.stable(observed, neutralDirectory);
    const freshChannel = await port.channel(observed, refreshed, neutralDirectory);
    if (refreshed.identity !== candidate.identity || freshChannel.status !== 'available' ||
      refreshed.version !== targetVersion || freshChannel.identity !== available.identity ||
      freshChannel.version !== targetVersion || freshChannel.exactApply !== available.exactApply) {
      return finish('blocked', 'channel_changed');
    }
    const finalOwner = await port.inspect(installation.packageRoot, request.currentVersion, neutralDirectory);
    if (!finalOwner || finalOwner.owner !== installation.owner || finalOwner.identity !== installation.identity ||
      finalOwner.recovery || finalOwner.locked) {
      return finish('blocked', 'owner_changed');
    }
    if (installation.owner === 'winget' || installation.owner === 'homebrew-cask' || !available.exactApply) {
      return finish('handoff-required', installation.owner === 'winget' ? 'restart_required' : 'manual_handoff', {
        handoff, restartRequired: installation.owner === 'winget'
      });
    }
    request.onStage?.('Install exact Liftoff release', targetVersion);
    effects = 'possible';
    const applied = await port.apply(installation, candidate, neutralDirectory);
    effects = applied.effects;
    verification = 'failed';
    request.onStage?.('Verify replacement', targetVersion);
    await port.verify(installation, candidate, neutralDirectory);
    verification = 'verified';
    effects = 'installed';
    return finish('upgraded', 'upgrade_complete');
  }
}
