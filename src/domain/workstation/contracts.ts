import type { ExternalCommand } from '../project/contracts.js';

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
