import type { ExternalCommand } from '../project/contracts.js';
import type {
  LinuxFamily,
  RemediationRecipe,
  RequirementSeverity,
  SupportedPlatform,
  WorkstationRequirementDefinition,
  WorkstationRequirementId
} from '../../workstation-catalog.js';
import type { VersionConstraint } from './constraints.js';

export type RequirementReasonCode =
  | 'compatible'
  | 'missing-executable'
  | 'observation-unavailable'
  | 'probe-failed'
  | 'version-unparseable'
  | 'unsupported-constraint'
  | 'below-minimum'
  | 'release-line-mismatch'
  | 'exact-version-mismatch'
  | 'incompatible-channel';

export type InstallationOrigin = 'brew' | 'winget' | 'npm' | 'uv' | 'standalone' | 'unknown';
export type RemediationOperation = 'install' | 'upgrade' | 'change-version' | 'change-channel';
export type WorkstationScope = 'initialization' | 'local' | 'activation' | 'migration' | 'lifecycle';

export interface ExecutableIdentity {
  executable: string;
  resolution: 'resolved' | 'missing' | 'not-observable';
  resolvedPath?: string;
  realPath?: string;
  kind?: 'executable' | 'shim';
  origin: InstallationOrigin;
  evidence: 'path-search' | 'version-probe' | 'documented-location' | 'unavailable';
}

export interface ToolProbeObservation {
  command: ExternalCommand;
  identity: ExecutableIdentity;
  status: number | null;
  timedOut: boolean;
  errorCode?: string;
  reasonCode: RequirementReasonCode;
  detectedVersion?: string;
}

export type RemediationProgress = 'ready' | 'improved' | 'unchanged' | 'changed' | 'indeterminate';

export interface RemediationAttempt {
  recipeId: string;
  inputFingerprint: string;
  outputFingerprint?: string;
  outcome: RemediationProgress | 'failed';
}

export interface NoProgressRemediationAttempt extends RemediationAttempt {
  outputFingerprint: string;
  outcome: 'unchanged';
}

export interface WorkstationNoProgressStore {
  find(recipeId: string, inputFingerprint: string): Promise<RemediationAttempt | null>;
  record(attempt: NoProgressRemediationAttempt): Promise<void>;
}

export interface ToolUpdateObservation {
  version: string;
  source: string;
}

export type RequirementState = 'ready' | 'missing' | 'outdated' | 'unhealthy' | 'not-observable';

export interface SelectedRequirement {
  id: WorkstationRequirementId;
  definition: WorkstationRequirementDefinition;
  severity: RequirementSeverity;
  reasons: string[];
  minimumVersion?: string;
  exactVersion?: string;
  releaseLine?: string;
  allowPrerelease?: boolean;
  scope?: WorkstationScope;
}

export interface ReadinessNotice {
  label: string;
  state: 'ready' | 'unhealthy' | 'not-observable' | 'notice';
  detail: string;
  remedy?: string;
  code?: 'preview-channel' | 'update-available' | 'authentication' | 'health';
}

export interface RequirementProbeResult {
  requirement: SelectedRequirement;
  state: RequirementState;
  detail: string;
  detectedVersion?: string;
  detectedBy?: string;
  remedy?: string;
  notices: ReadinessNotice[];
  reasonCode: RequirementReasonCode;
  identity: ExecutableIdentity;
  required: VersionConstraint;
  observations: ToolProbeObservation[];
  remediationAttempts?: RemediationAttempt[];
}

export interface HostEnvironment {
  platform: SupportedPlatform;
  linuxFamily: LinuxFamily;
}

export type InstallState =
  | 'installed'
  | 'declined'
  | 'manual'
  | 'failed'
  | 'restart-required'
  | 'unchanged'
  | 'unresolved'
  | 'not-needed';

export interface RemediationSelection {
  state: 'available' | 'manual' | 'not-needed';
  reasonCode: RequirementReasonCode;
  detail: string;
  remedy?: string;
  recipe?: RemediationRecipe;
}

export interface InstallResult {
  requirement: SelectedRequirement;
  state: InstallState;
  detail: string;
  command?: string;
  probe: RequirementProbeResult;
  remedy?: string;
  reasonCode: 'verified' | 'not-authorized' | 'recipe-unavailable' | 'manager-unavailable' |
    'review-required' | 'execution-failed' | 'no-progress' | 'verification-unresolved' | 'executable-discovery' |
    'history-storage-failed';
  historyError?: 'lookup' | 'record';
  progress?: RemediationProgress;
  attempt?: RemediationAttempt;
  recipe?: RemediationRecipe;
  discovery?: { checkedLocations: string[]; found: ExecutableIdentity[]; complete: boolean };
}
