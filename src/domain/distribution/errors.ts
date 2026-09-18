export type DistributionReason =
  | 'invalid_metadata' | 'trust_unregistered' | 'signature_invalid' | 'artifact_mismatch'
  | 'unsupported_host' | 'unsafe_path' | 'ownership_unknown' | 'ownership_conflict'
  | 'source_unavailable' | 'source_stale' | 'source_changed' | 'tool_unavailable'
  | 'timeout' | 'transport' | 'approval_required' | 'stale_plan' | 'transaction_pending'
  | 'locked_handover' | 'effect_failed' | 'verification_failed' | 'recovery_required' | 'policy_blocked'
  | 'implementation_missing' | 'qualification_required' | 'trust_missing' | 'trust_unconfigured';

export class DistributionError extends Error {
  constructor(message: string, readonly reasonCode: DistributionReason = 'invalid_metadata', options?: ErrorOptions) {
    super(message, options);
    this.name = 'DistributionError';
  }
}

export const winGetReadOnlyObservationBlocker =
  'Required WinGet read-only interfaces are absent from the reviewed public contract. PackageCatalogReference.Connect can initialize a missing source even with background updates disabled; AvailableVersions and GetApplicableInstaller can populate disk caches. A fail-closed cached-only catalog/manifest snapshot and complete installed-portable owner/source/architecture/launcher evidence are required. No source connection, refresh, or agreement acceptance was attempted.';

export class WinGetReadOnlyObservationError extends DistributionError {
  constructor() {
    super(winGetReadOnlyObservationBlocker, 'implementation_missing');
    this.name = 'WinGetReadOnlyObservationError';
  }
}

export class ReleaseManifestValidationError extends DistributionError {
  constructor(message: string, readonly issues: readonly string[] = []) {
    super(message);
    this.name = 'ReleaseManifestValidationError';
  }
}

export class TargetNotSupportedError extends DistributionError {
  constructor(
    readonly target: string,
    readonly observedConstraint: string,
    readonly requiredConstraint: string
  ) {
    super(
      `Target "${target}" is not supported on this host: observed ${observedConstraint}, required floor ${requiredConstraint}.`,
      'unsupported_host'
    );
    this.name = 'TargetNotSupportedError';
  }
}

export class ReleaseChecksumMismatchError extends DistributionError {
  constructor(
    readonly expectedSha256: string,
    readonly observedSha256: string,
    readonly target: string
  ) {
    super(
      `Release checksum verification failed for ${target}: expected ${expectedSha256}, observed ${observedSha256}.`,
      'artifact_mismatch'
    );
    this.name = 'ReleaseChecksumMismatchError';
  }
}

export class InstallationOwnerMismatchError extends DistributionError {
  constructor(
    readonly expectedOwner: string,
    readonly observedOwner: string,
    readonly detail?: string
  ) {
    super(
      `Installation owner mismatch: expected ${expectedOwner}, observed ${observedOwner}.${detail ? ` ${detail}` : ''}`,
      'ownership_conflict'
    );
    this.name = 'InstallationOwnerMismatchError';
  }
}

export class MigrationPlanStaleError extends DistributionError {
  constructor(
    readonly reason: string,
    readonly expectedFingerprint: string,
    readonly observedFingerprint: string
  ) {
    super(
      `Installation migration plan is stale: ${reason}. Expected fingerprint ${expectedFingerprint}, observed ${observedFingerprint}.`,
      'stale_plan'
    );
    this.name = 'MigrationPlanStaleError';
  }
}

export class MigrationApprovalRequiredError extends DistributionError {
  constructor(readonly planFingerprint: string) {
    super(
      `Installation migration requires this exact --approve-plan ${planFingerprint}, or action-specific default-No terminal approval.`,
      'approval_required'
    );
    this.name = 'MigrationApprovalRequiredError';
  }
}

export class MigrationExecutionError extends DistributionError {
  constructor(
    readonly effectId: string,
    message: string,
    readonly exitCode?: number,
    readonly record?: InstallationMigrationRecord
  ) {
    super(`Migration failed at step "${effectId}": ${message}`, 'effect_failed');
    this.name = 'MigrationExecutionError';
  }
}

export class NativeCommandFailure extends DistributionError {
  constructor(operation: string, readonly exitCode: number | null, readonly signal: NodeJS.Signals | null, readonly timedOut: boolean,
    readonly toolErrorCode?: string, readonly settled?: boolean) {
    super(`${operation}: ${timedOut ? 'timed out' : toolErrorCode === 'ENOENT' ? 'tool could not start'
      : settled !== true ? 'process-tree settlement was not established'
        : signal ? `terminated by ${signal}` : `exited with status ${exitCode ?? 'unobserved'}`}.`,
    timedOut ? 'timeout' : toolErrorCode === 'ENOENT' ? 'tool_unavailable' : 'effect_failed');
    this.name = 'NativeCommandFailure';
  }
}

export class LockedFileHandoverError extends DistributionError {
  constructor(
    readonly lockedPath: string,
    readonly lockingPid?: number
  ) {
    super(
      `Launcher "${lockedPath}" cannot be handed over under current file-lock or permission conditions${lockingPid ? ` (observed process ${lockingPid})` : ''}. Close the affected instance or resolve owner permissions; no force replacement or unrelated process termination is authorized.`,
      'locked_handover'
    );
    this.name = 'LockedFileHandoverError';
  }
}

export class DirectReceiptValidationError extends DistributionError {
  constructor(message: string, readonly issues: readonly string[] = []) {
    super(message);
    this.name = 'DirectReceiptValidationError';
  }
}
import type { InstallationMigrationRecord } from './contracts.js';
