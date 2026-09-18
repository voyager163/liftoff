import type { NativeInstallationTransactionOutcome } from './transaction-outcome.js';

export const nativeDistributionSchemaVersion = 1 as const;

export type NativeOs = 'darwin' | 'win32' | 'linux';
export type NativeArch = 'x64' | 'arm64';
export type NativeTarget = `${NativeOs}-${NativeArch}`;

export const allNativeTargets: readonly NativeTarget[] = [
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64',
  'linux-x64',
  'linux-arm64'
] as const;

export const nativeTargetFloors = {
  linux: {
    // Liftoff policy remains stricter than Node v24.20's glibc >= 2.28 baseline.
    minimumGlibc: '2.31',
    minimumKernelVersion: '4.18.0'
  },
  darwin: {
    // Node v24.20 BUILDING.md targets macOS 13.5; Apple's macos-135 XNU reports 22.6.0.
    minimumHostVersion: '13.5.0',
    minimumDarwinRelease: '22.6.0'
  },
  win32: {
    // Liftoff policy, not a precise minimum build asserted by Node's platform table.
    minimumHostVersion: '10.0.17763',
    minimumBuild: 17763
  }
} as const;

export const canonicalProductName = 'liftoff' as const;
export const canonicalRepository = 'voyager163/liftoff' as const;
export const canonicalHomebrewCask = 'voyager163/liftoff/liftoff' as const;
export const canonicalWinGetId = 'voyager163.liftoff' as const;
export const legacyNpmPackageName = '@msn-control/liftoff' as const;
export const lastHistoricalNpmVersion = '0.12.3' as const;

export interface NativeTargetRuntimeConstraints {
  nodeVersion: string;
  minimumGlibc?: string;
  minimumKernelVersion?: string;
  minimumHostVersion?: string;
  minimumDarwinRelease?: string;
  minimumBuild?: number;
}

export interface NativeTargetResources {
  inventoryHash: string;
  count: number;
}

export interface NativeTargetPayload {
  os: NativeOs;
  arch: NativeArch;
  archiveUrl: string;
  archiveFormat: 'tar.gz' | 'zip';
  checksumSha256: string;
  signatureUrl?: string;
  provenanceUrl?: string;
  runtime: NativeTargetRuntimeConstraints;
  resources: NativeTargetResources;
}

export interface NativeReleaseManifest {
  $schema?: string;
  schemaVersion: typeof nativeDistributionSchemaVersion;
  product: typeof canonicalProductName;
  version: string;
  sourceCommit: string;
  publishedAt: string;
  targets: Record<NativeTarget, NativeTargetPayload>;
}

export type InstallationOwner =
  | 'homebrew-cask'
  | 'winget'
  | 'direct'
  | 'npm'
  | 'unlinked'
  | 'unknown';

export interface ExecutableInspection {
  resolvedPath: string;
  kind: 'native' | 'node-script' | 'unlinked' | 'unknown';
  version?: string;
  isPrivateRuntime: boolean;
  bundleRoot?: string;
  identityDigest?: string;
}

export interface InstallationOwnershipRecord {
  owner: InstallationOwner;
  packageName?: string;
  version?: string;
  prefix?: string;
  receiptPath?: string;
  isCask: boolean;
  isFormula: boolean;
  isNodeDependent: boolean;
  evidenceDigest?: string;
  sourceId?: string;
  launcherPath?: string;
  payloadRoot?: string;
}

export interface PathResolutionInspection {
  effectiveLauncher?: string;
  resolvesToRunning: boolean;
  pathLaunchers: string[];
  conflicts: string[];
}

export type InstallationInspectionStatus =
  | 'healthy'
  | 'migration-required'
  | 'unlinked-candidate'
  | 'launcher-conflict'
  | 'ambiguous'
  | 'unsupported';

export interface InstallationInspectionResult {
  schemaVersion: typeof nativeDistributionSchemaVersion;
  executable: ExecutableInspection;
  installation: InstallationOwnershipRecord;
  pathResolution: PathResolutionInspection;
  status: InstallationInspectionStatus;
  summary: string;
  remedy?: string;
}

export interface LegacyInstallationFacts {
  owner: 'npm';
  packageName: typeof legacyNpmPackageName;
  installedVersion: string;
  executablePath: string;
  prefix: string;
  launcherPath: string;
  launcherConflicts: string[];
  packageRoot: string;
  integrity: string;
  evidenceDigest: string;
  launcherPaths: string[];
}

export interface TargetInstallationFacts {
  owner: 'homebrew-cask' | 'winget' | 'direct';
  targetPackage: string;
  targetVersion: string;
  candidatePath: string;
  destinationDirectory: string;
  launcherPath: string;
  candidateIdentity: string;
  sourceId: string;
  sourceDigest: string;
}

export interface OrderedMigrationEffect {
  step: number;
  id: string;
  description: string;
  command?: string;
  critical: boolean;
}

export interface LegacyRecoveryFacts {
  packageName: typeof legacyNpmPackageName;
  packageVersion: string;
  prefix: string;
  recoveryCommand: string;
}

export interface InstallationMigrationPlan {
  schemaVersion: typeof nativeDistributionSchemaVersion;
  planFingerprint: string;
  createdAt: string;
  expiresAt: string;
  bindingDigest: string;
  transactionRoot: string;
  platform: NativeOs;
  architecture: NativeArch;
  legacyInstallation: LegacyInstallationFacts;
  targetInstallation: TargetInstallationFacts;
  orderedEffects: OrderedMigrationEffect[];
  legacyRecovery: LegacyRecoveryFacts;
  recovery?: {
    migrationId: string;
    recordDigest: string;
    sourceRetired: boolean;
    targetInstalled: boolean;
    recoverTransaction: boolean;
    originalPlanFingerprint: string;
  };
}

export type MigrationCheckpoint =
  | 'initial'
  | 'candidate-verified'
  | 'legacy-retired'
  | 'target-installed'
  | 'launcher-activated'
  | 'verified'
  | 'failed';

export interface MigrationFailureFacts {
  effectId: string;
  message: string;
  exitCode?: number;
  timestamp: string;
}

export interface MigrationVerificationFacts {
  explicitPathVerified: boolean;
  pathResolutionVerified: boolean;
  observedVersion?: string;
  resourcesVerified: boolean;
}

export interface InstallationMigrationRecord {
  schemaVersion: typeof nativeDistributionSchemaVersion;
  migrationId: string;
  planFingerprint: string;
  status: 'in_progress' | 'completed' | 'failed';
  checkpoint: MigrationCheckpoint;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  legacyInstallation: LegacyInstallationFacts;
  targetInstallation: TargetInstallationFacts;
  completedEffects: string[];
  failure?: MigrationFailureFacts;
  verification?: MigrationVerificationFacts;
  legacyRecovery: LegacyRecoveryFacts;
  revision: number;
  previousDigest?: string;
  plan: InstallationMigrationPlan;
  pendingEffectId?: string;
  uncertainEffects: string[];
  retainedPaths: string[];
  processSettlement: 'settled' | 'unconfirmed';
  transaction?: NativeInstallationTransactionOutcome;
}

export interface DirectInstallReceipt {
  schemaVersion: typeof nativeDistributionSchemaVersion;
  product: typeof canonicalProductName;
  version: string;
  target: NativeTarget;
  installedAt: string;
  sourceCommit: string;
  installRoot: string;
  versionRoot: string;
  launcherPath: string;
  runtime: NativeTargetRuntimeConstraints;
  checksumSha256: string;
  authority?: {
    id: string;
    manifestDigest: string;
    provenanceDigest: string;
    launcherSha256: string;
    resources: NativeTargetResources;
    transactionRoot: string;
  };
}

export function isNonExecutingInstallationCommand(parsed: {
  command?: string;
  subcommand?: string;
  flags: Record<string, string | boolean>;
}): boolean {
  if (parsed.command !== 'installation') {
    return false;
  }
  // `installation inspect` is strictly read-only and non-mutating
  if (parsed.subcommand === 'inspect') {
    return true;
  }
  // `installation migrate` with --check, --recover, or without --approve-plan is a non-executing preview
  if (parsed.subcommand === 'migrate') {
    if (parsed.flags.check === true || parsed.flags.recover === true) {
      return true;
    }
    if (!parsed.flags['approve-plan']) {
      return true;
    }
    return false;
  }
  return true;
}

export function canPersistInstallationTelemetryNotice(parsed: {
  command?: string;
  subcommand?: string;
  flags: Record<string, string | boolean>;
}): boolean {
  return !isNonExecutingInstallationCommand(parsed);
}
