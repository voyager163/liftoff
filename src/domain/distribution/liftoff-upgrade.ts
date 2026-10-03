import path from 'node:path';
import type { StableReleaseFailureCode } from '../../stable-release.js';
import {
  canonicalManualInstallCommand,
  exactGlobalInstallCommand
} from './liftoff-package.js';

export const selfUpgradeSchemaVersion = 1 as const;
export const selfUpgradeInstallTimeoutMs = 10 * 60_000;
export const selfUpgradeProbeTimeoutMs = 30_000;
export const selfUpgradeVerificationTimeoutMs = 15_000;

export const homebrewPrefixes = {
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
