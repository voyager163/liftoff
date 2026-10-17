import type { InstallationOwner, UpgradeHandoff } from './liftoff-upgrade.js';

export interface NativeReleasePolicy {
  schemaVersion: 1;
  repository: 'voyager163/liftoff';
  approvedSigningKeySha256: string | null;
  homebrew: { cask: string | null; sourceRepository: string | null; developerTeamId: string | null };
  winget: { packageIdentifier: string | null; publisher: string | null; certificateSha256: string | null; installerAppId: string | null };
  linux: { archiveSigningKeySha256: string | null };
}

export interface NativeBundleInventory {
  packageRoot: string;
  bundleRoot: string;
  launcher: string;
  runtime: string;
  version: string;
  target: string;
  manifestSha256: string;
  inventorySha256: string;
  sourceCommit: string;
  /** Local inventory identity, not manager or publisher authority; never emitted publicly. */
  identity: string;
  /** Receipt/pointer attribution only; does not establish WinGet ownership or a trusted signer. */
  windowsInstaller?: WindowsInstallerLayout;
}

export interface WindowsInstallerLayout {
  installRoot: string;
  stableLauncher: string;
  receiptSha256: string;
  currentSha256: string;
  stableLauncherSha256: string;
  policySha256: string;
  identity: string;
}

export interface NativeInstallation extends NativeBundleInventory {
  owner: Exclude<InstallationOwner, 'npm' | 'unknown'>;
  prefix?: string;
  current?: string;
  managerId?: string;
  managerSource?: string;
  managerScope?: 'user';
  recovery?: { journalSha256: string; staleLockOwnerSha256?: string };
  locked?: boolean;
}

export interface NativeCandidate {
  version: string;
  target: string;
  sourceCommit: string;
  manifestSha256: string;
  inventorySha256: string;
  /** Authenticated full release/channel observation, not a version-only comparison. */
  identity: string;
  archiveSha256?: string;
  windowsInstaller?: { filename: string; sha256: string; bytes: number };
  bundleRoot?: string;
}

export type NativeChannelObservation =
  | { status: 'available'; version: string; identity: string; exactApply: boolean; artifactSha256?: string }
  | { status: 'absent' }
  | { status: 'lagging'; version: string };

export interface NativeUpgradePort {
  inspect(packageRoot: string, version: string, neutralDirectory: string): Promise<NativeInstallation | null>;
  stable(installation: NativeInstallation, neutralDirectory: string): Promise<NativeCandidate>;
  channel(installation: NativeInstallation, candidate: NativeCandidate, neutralDirectory: string, signal?: AbortSignal): Promise<NativeChannelObservation>;
  apply(installation: NativeInstallation, candidate: NativeCandidate, neutralDirectory: string): Promise<{ effects: 'possible' | 'installed' }>;
  verify(installation: NativeInstallation, candidate: NativeCandidate, neutralDirectory: string): Promise<void>;
  recover?(installation: NativeInstallation, selection: { journalSha256: string; staleLockOwnerSha256?: string },
    neutralDirectory: string): Promise<void>;
}

export interface CaskDestinationObservation {
  prefix: '/opt/homebrew' | '/usr/local';
  caskRoot: string;
  launcher: string;
  cask: { state: 'absent' | 'occupied'; identity: string };
  selectedLauncher: { state: 'absent' | 'occupied'; identity: string };
  /** Local path observation only, never installation or removal authority. */
  identity: string;
}

export interface CaskInstallPreview {
  schemaVersion: 1;
  kind: 'liftoff-homebrew-cask-install-preview';
  effects: 'none';
  target: NativeCandidate;
  cask: string;
  expectedSourceRepository: string;
  destination: CaskDestinationObservation & { versionRoot: string; stagedLauncher: string };
  source: { state: 'absent' } | {
    state: 'observed';
    path: string;
    bytes: number;
    sha256: string;
    authority: 'unverified-local-bytes';
  };
  /** Signed release-derived content comparison only; does not establish tap/channel or effect authority. */
  releaseDefinition?: {
    authority: 'authenticated-release-definition';
    filename: string;
    bytes: number;
    sha256: string;
    candidateIdentity: string;
    selectedSource: 'exact' | 'different' | 'absent';
  };
  channel: { status: 'unknown' };
  preflight: {
    nativeAppleSilicon: true;
    canonicalDirectories: true;
    caskAbsent: boolean;
    launcherAbsent: boolean;
    exactExecutionProven: false;
  };
  execution: {
    status: 'blocked';
    reason: 'exact_cask_execution_unproven';
    command: null;
  };
  /** Binds the preview's facts, not permission for a later effect. */
  identity: string;
}

export interface CaskPreparationPort {
  observeDestination(prefix: string, signal: AbortSignal): Promise<CaskDestinationObservation>;
  preview(prefix: string, signal: AbortSignal): Promise<CaskInstallPreview>;
}

export function nativeManagerHandoff(installation: NativeInstallation, version: string): UpgradeHandoff | undefined {
  if (installation.owner === 'winget' && installation.managerId && installation.managerSource && installation.managerScope === 'user') {
    return {
      executable: 'winget',
      args: ['upgrade', '--id', installation.managerId, '--exact', '--version', version,
        '--source', installation.managerSource, '--scope', 'user', '--disable-interactivity']
    };
  }
  // Homebrew upgrade cannot bind a version; do not emit an unbound command as exact authority.
  return undefined;
}
