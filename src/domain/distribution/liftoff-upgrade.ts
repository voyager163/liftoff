import path from 'node:path';
import type { StableReleaseFailureCode } from '../../stable-release.js';
import {
  canonicalManualInstallCommand,
  exactGlobalInstallCommand
} from './liftoff-package.js';

export const selfUpgradeSchemaVersion = 2 as const;
export const selfUpgradeInstallTimeoutMs = 10 * 60_000;
export const selfUpgradeProbeTimeoutMs = 30_000;
export const selfUpgradeVerificationTimeoutMs = 15_000;

export const homebrewPrefixes = {
  'homebrew-opt': path.posix.join('/', 'opt', 'homebrew'),
  'homebrew-usr-local': path.posix.join('/', 'usr', 'local')
} as const;
export type SelfUpgradeInstallationTarget = keyof typeof homebrewPrefixes;

export type SelfUpgradeMode = 'apply' | 'check';
export type InstallationOwner = 'npm' | 'homebrew-cask' | 'winget' | 'liftoff-native' | 'unknown';
export interface ReleaseAvailability {
  status: 'available' | 'lagging' | 'absent' | 'unknown' | 'unqualified';
  version?: string;
}
export interface UpgradeHandoff {
  executable: 'brew' | 'winget';
  args: string[];
}
export type SelfUpgradeStatus =
  | 'blocked'
  | 'current'
  | 'failed'
  | 'update-available'
  | 'handoff-required'
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
  | 'registry_absent'
  | 'registry_unavailable'
  | 'registry_timeout'
  | 'owner_changed'
  | 'executable_selection'
  | 'native_unqualified'
  | 'native_invalid'
  | 'native_identity_mismatch'
  | 'native_timeout'
  | 'native_unavailable'
  | 'channel_lag'
  | 'channel_absent'
  | 'channel_invalid'
  | 'channel_timeout'
  | 'channel_unavailable'
  | 'channel_changed'
  | 'manual_handoff'
  | 'restart_required'
  | 'native_install_failed'
  | 'native_install_timeout'
  | 'recovery_required'
  | 'neutral_directory_unavailable'
  | 'cleanup_failed'
  | 'inspection_unavailable'
  | 'unsupported_installation'
  | 'update_available'
  | 'upgrade_complete'
  | 'verification_failed';

interface SelfUpgradeResultBase {
  /** Schema 1 is retained only for historical integrations; production emits schema 2. */
  schemaVersion: 1 | typeof selfUpgradeSchemaVersion;
  mode: SelfUpgradeMode;
  status: SelfUpgradeStatus;
  currentVersion: string;
  reasonCode: SelfUpgradeReasonCode;
  installationTarget?: SelfUpgradeInstallationTarget;
  installationOwner?: InstallationOwner;
  upstream?: ReleaseAvailability;
  channel?: ReleaseAvailability;
  effects?: 'none' | 'possible' | 'installed';
  verification?: 'not-run' | 'verified' | 'failed';
  restartRequired?: boolean;
  handoff?: UpgradeHandoff;
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
      registryKind?: SelfUpgradeRegistryKind;
    }
  | SelfUpgradeResultBase & {
      status: 'upgraded';
      reasonCode: 'upgrade_complete';
      targetVersion: string;
      registryKind?: SelfUpgradeRegistryKind;
    }
  | SelfUpgradeResultBase & {
      status: 'blocked' | 'failed' | 'handoff-required';
      targetVersion?: string;
      registryKind?: SelfUpgradeRegistryKind;
    };

export type SelfUpgradeStage =
  | 'Inspect installation owner'
  | 'Resolve verified stable target'
  | 'Verify owning channel availability'
  | 'Inspect global installation'
  | 'Resolve canonical stable target'
  | 'Verify configured registry parity'
  | 'Install exact Liftoff release'
  | 'Verify replacement';

export class SelfUpgradeFailure extends Error {
  constructor(
    readonly status: 'blocked' | 'failed',
    readonly reasonCode: SelfUpgradeReasonCode,
    readonly registryKind?: SelfUpgradeRegistryKind
  ) {
    super(reasonCode);
    this.name = 'SelfUpgradeFailure';
  }
}

export function selfUpgradeResult(
  request: { mode: SelfUpgradeMode; currentVersion: string },
  status: SelfUpgradeStatus,
  reasonCode: SelfUpgradeReasonCode,
  details: {
    targetVersion?: string;
    registryKind?: SelfUpgradeRegistryKind;
    installationTarget?: SelfUpgradeInstallationTarget;
    installationOwner?: InstallationOwner;
    upstream?: ReleaseAvailability;
    channel?: ReleaseAvailability;
    effects?: 'none' | 'possible' | 'installed';
    verification?: 'not-run' | 'verified' | 'failed';
    restartRequired?: boolean;
    handoff?: UpgradeHandoff;
  } = {}
): SelfUpgradeResult {
  return {
    schemaVersion: selfUpgradeSchemaVersion,
    mode: request.mode,
    status,
    currentVersion: request.currentVersion,
    reasonCode,
    installationOwner: details.installationOwner ?? 'unknown',
    upstream: details.upstream ?? { status: 'unknown' },
    channel: details.channel ?? { status: 'unknown' },
    effects: details.effects ?? 'none',
    verification: details.verification ?? 'not-run',
    ...(details.restartRequired ? { restartRequired: true } : {}),
    ...(details.handoff ? { handoff: details.handoff } : {}),
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
    case 'handoff-required':
      return 1;
    default:
      return assertNever(value);
  }
}

export function selfUpgradeRemedy(value: SelfUpgradeResult): string | undefined {
  if (value.reasonCode === 'verification_failed' && value.installationOwner &&
    !['npm', 'unknown'].includes(value.installationOwner)) {
    return 'Verify the exact replacement through its owning manager and run liftoff doctor from a new shell. Retain native recovery journals; no automatic rollback was attempted.';
  }
  const prefix = value.installationTarget ? ` --prefix ${homebrewPrefixes[value.installationTarget]}` : '';
  switch (value.reasonCode) {
    case 'current':
    case 'update_available':
    case 'upgrade_complete':
      return undefined;
    case 'registry_stale':
      if (value.schemaVersion === 2) return 'Ask the managed registry owner to synchronize or approve the canonical target, then run liftoff upgrade --check.';
      return 'Ask the managed registry owner to synchronize or approve the canonical target, then retry.';
    case 'registry_absent':
      return 'The selected registry does not expose Liftoff. Restore the approved package in that registry before retrying; no mirror bypass or manager migration was attempted.';
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
      if (value.schemaVersion === 2) return 'Identify and repair the manager that owns the running CLI, then run liftoff doctor and liftoff upgrade --check. Do not install over an unknown owner or migrate managers implicitly.';
      return `Use a supported global npm installation: ${canonicalManualInstallCommand()}${prefix}`;
    case 'canonical_invalid':
    case 'canonical_timeout':
    case 'canonical_unavailable':
      return 'Retry after canonical npm is reachable and exposes valid stable Liftoff metadata.';
    case 'registry_invalid':
    case 'registry_unavailable':
    case 'registry_timeout':
      return 'Repair the approved npm registry configuration without placing credentials in the registry URL, then retry.';
    case 'registry_prefix_mismatch':
      return 'The active npm and verified Homebrew prefix select different registries. Reconcile the approved machine-level registry policy before retrying; Liftoff did not switch registries or install.';
    case 'downgrade_refused':
      return 'Keep the newer installed CLI; Liftoff does not perform automatic downgrades.';
    case 'owner_changed':
    case 'channel_changed':
      return 'The reviewed installation or delivery source changed. Run liftoff upgrade --check again; no cross-manager migration is authorized.';
    case 'executable_selection':
      return 'Resolve the selected liftoff launcher to the verified installation, restart the shell if needed, then run liftoff doctor. No PATH or shell configuration was changed.';
    case 'native_unqualified':
      return 'Public native releases, signing and package namespaces are not yet qualified. Keep the existing installation; no npm fallback or manager migration was attempted.';
    case 'native_invalid':
    case 'native_timeout':
    case 'native_unavailable':
      return 'Obtain current authenticated stable native metadata and deployed exact assets from the approved publisher; local receipts alone do not authenticate releases.';
    case 'native_identity_mismatch':
      return 'The installed native source or inventory differs from the authenticated artifact at the same package version. Review an exact same-owner repair with its maintainer; do not treat version equality as current or migrate managers implicitly.';
    case 'channel_lag':
      return 'Wait for the selected package channel to publish the verified upstream target, then retry; Liftoff will not bypass that channel.';
    case 'channel_absent':
    case 'channel_invalid':
    case 'channel_timeout':
    case 'channel_unavailable':
      return 'Restore authoritative metadata for the selected owning channel, then run liftoff upgrade --check. Missing or unavailable metadata is not current.';
    case 'manual_handoff':
      if (value.installationOwner === 'homebrew-cask') return 'Homebrew cannot bind a cask upgrade to this reviewed version. Review the approved cask with its maintainer, upgrade it outside the running Liftoff process, then start a new shell and run liftoff doctor and liftoff upgrade --check. No unbound brew upgrade command was run.';
      return 'Use the reviewed owning installer outside this running process, then start a new shell and run liftoff doctor and liftoff upgrade --check. No upgraded completion is claimed.';
    case 'restart_required':
      return 'Close Liftoff and use the exact reviewed owning-manager command, then start a new shell and run liftoff doctor and liftoff upgrade --check. This process has not upgraded the installation.';
    case 'native_install_failed':
    case 'native_install_timeout':
    case 'recovery_required':
      return 'Retain the native installation journal and immutable versions. Use the bundled native installer recovery with the exact observed journal SHA-256 (and selected dead-process lock owner SHA-256 if required); do not sweep the prefix.';
    case 'neutral_directory_unavailable':
      return 'Restore access to a private temporary directory before retrying. No installation was attempted.';
    case 'cleanup_failed':
      return 'Private upgrade scratch cleanup failed. Preserve the reported installation effects and verification; inspect the temporary directory before retrying, without sweeping installation or configuration paths.';
    case 'inspection_unavailable':
      return 'Installation or freshness inspection was unavailable. Keep the existing installation and retry doctor; unknown metadata is not evidence of a current or installable release.';
    default:
      return assertNever(value);
  }
}

export function selfUpgradeSummary(value: SelfUpgradeResult): string {
  switch (value.status) {
    case 'current':
      return `Liftoff ${value.currentVersion} is already the ${value.installationOwner && value.installationOwner !== 'npm' ? 'verified' : 'canonical'} stable release.`;
    case 'update-available':
      return `Liftoff ${value.targetVersion} is available for this ${value.installationOwner && value.installationOwner !== 'npm' ? value.installationOwner : 'supported global npm'} installation.`;
    case 'upgraded':
      return `Liftoff ${value.targetVersion} was installed and verified.`;
    case 'blocked':
      return `CLI upgrade was blocked (${value.reasonCode}).`;
    case 'failed':
      return `CLI upgrade failed (${value.reasonCode}).`;
    case 'handoff-required':
      return `CLI upgrade requires an owning-manager handoff (${value.reasonCode}); no upgraded completion is claimed.`;
    default:
      return assertNever(value);
  }
}

export function canonicalFailureReason(code: StableReleaseFailureCode): SelfUpgradeReasonCode {
  switch (code) {
    case 'invalid_metadata':
      return 'canonical_invalid';
    case 'timeout':
      return 'canonical_timeout';
    case 'http_failure':
    case 'network_failure':
      return 'canonical_unavailable';
    default:
      return assertNever(code);
  }
}
