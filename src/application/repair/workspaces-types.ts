import type { UpdatePreviewOptions } from '../../adapters/filesystem/update-previews.js';
import type { RepairExecutionIdentity } from '../../domain/repair/identity.js';

export const repairWorkspaceSchemaVersion = 1 as const;
export const repairWorkspaceRoleNames = ['project', 'home', 'cache', 'scratch'] as const;
export type RepairWorkspaceRole = (typeof repairWorkspaceRoleNames)[number];
export type RepairWorkspacePhase =
  | 'allocating' | 'ready' | 'copying' | 'preparing' | 'verifying' | 'verified'
  | 'failed' | 'cleaning' | 'cleanup-failed' | 'cleaned';
export type RepairWorkspaceCheckpoint = 'copying' | 'preparing' | 'verifying' | 'verified' | 'failed';

export interface RepairWorkspaceBindings {
  inputDigest: string;
  verificationPolicyDigest: string;
  providerDigest: string;
  toolchainDigest: string;
}

export interface RepairWorkspaceApprovedScopes {
  projectCode: boolean;
  dependencyPreparation: boolean;
  network: boolean;
  lifecycle: boolean;
}

export interface CreateRepairVerificationWorkspaceOptions {
  planFingerprint: string;
  repairIdentity: RepairExecutionIdentity;
  patchStagingRoot: string;
  bindings: RepairWorkspaceBindings;
  approvedScopes: RepairWorkspaceApprovedScopes;
}

export interface RepairWorkspaceActivity {
  kind: 'preparation' | 'verification';
  commandDigest: string;
  network: boolean;
  lifecycle: boolean;
}

export interface RepairWorkspaceIssue {
  code:
    | 'invalid-request' | 'registry-unavailable' | 'registry-busy' | 'registry-invalid'
    | 'unsupported-record' | 'unauthenticated-record' | 'scope-mismatch'
    | 'owner-active' | 'owner-uncertain' | 'identity-changed' | 'unsafe-path'
    | 'workspace-missing' | 'cleanup-failed' | 'limits-exceeded' | 'permission-denied';
  message: string;
}

export class RepairWorkspaceError extends Error {
  constructor(readonly code: RepairWorkspaceIssue['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RepairWorkspaceError';
  }
}

export interface RepairWorkspaceFileIdentity {
  device: string;
  inode: string;
  birthtime: string;
}

export interface RepairWorkspaceRecord {
  schemaVersion: 1;
  kind: 'liftoff-repair-workspace';
  workspaceId: string;
  revision: number;
  projectRoot: string;
  projectIdentity: RepairWorkspaceFileIdentity;
  patchStagingRoot: string;
  patchStagingIdentity: RepairWorkspaceFileIdentity;
  planFingerprint: string;
  repairIdentity: RepairExecutionIdentity;
  bindings: RepairWorkspaceBindings;
  approvedScopes: RepairWorkspaceApprovedScopes;
  directory: string;
  creationIdentity: RepairWorkspaceFileIdentity | null;
  roles: Record<RepairWorkspaceRole, { path: string; identity: RepairWorkspaceFileIdentity | null }>;
  owner: {
    tokenDigest: string;
    processId: number;
    state: 'active' | 'released' | 'uncertain';
    release: { releasedAt: string; allKnownCommandsSettled: true } | null;
  };
  phase: RepairWorkspacePhase;
  lastCheckpoint: 'allocating' | 'ready' | RepairWorkspaceCheckpoint;
  activities: {
    started: number;
    settled: number;
    uncertain: number;
    inFlight: Array<RepairWorkspaceActivity & { id: string }>;
  };
  cleanup: { removedEntries: number; complete: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface RepairWorkspaceSummary {
  workspaceId: string;
  directory: string;
  planFingerprint: string;
  phase: RepairWorkspacePhase;
  /** Diagnostic owner progress, not a verification receipt or conformance claim. */
  lastCheckpoint: RepairWorkspaceRecord['lastCheckpoint'];
  owner: 'active' | 'released' | 'uncertain';
  commandsStarted: number;
  commandsSettled: number;
  uncertainCommands: number;
  cleanupComplete: boolean;
  issues: RepairWorkspaceIssue[];
}

export interface RepairWorkspaceInspection {
  schemaVersion: 1;
  kind: 'liftoff-repair-workspaces';
  projectRoot: string;
  status: 'absent' | 'retained' | 'blocked';
  workspaces: RepairWorkspaceSummary[];
  issues: RepairWorkspaceIssue[];
}

export interface RepairWorkspaceCleanupResult {
  workspaceId: string;
  status: 'cleaned' | 'blocked' | 'incomplete';
  /** Disposal completion only; does not prove preparation, checks, file repair or activation. */
  cleanupComplete: boolean;
  /** Confirmed removals in this cleanup attempt, not an inferred lifetime count. */
  removedEntries: number;
  retained: boolean;
  issues: RepairWorkspaceIssue[];
}

export interface RepairWorkspaceRecoveryResult {
  schemaVersion: 1;
  kind: 'liftoff-repair-workspace-recovery';
  projectRoot: string;
  status: 'absent' | 'complete' | 'blocked' | 'partial';
  cleanupComplete: boolean;
  results: RepairWorkspaceCleanupResult[];
  retained: RepairWorkspaceSummary[];
  issues: RepairWorkspaceIssue[];
}

export interface RepairVerificationWorkspace {
  readonly workspaceId: string;
  readonly directory: string;
  readonly roles: Readonly<Record<RepairWorkspaceRole, string>>;
  checkpoint(phase: RepairWorkspaceCheckpoint): Promise<void>;
  /** The caller's owned-process controller must prove settlement, not merely root PID exit or elapsed time. */
  runOwned<T>(
    activity: RepairWorkspaceActivity,
    operation: () => Promise<{ value: T; allKnownCommandsSettled: boolean }>
  ): Promise<T>;
  releaseOwner(): Promise<void>;
  cleanup(): Promise<RepairWorkspaceCleanupResult>;
}

export interface RepairWorkspaceStorageOptions extends UpdatePreviewOptions {
  /** Trusted adapter/test seam, never a project-document callback or a supplied cleanup path. */
  beforeWorkspaceOperation?: (
    operation: 'mkdir' | 'scan' | 'unlink' | 'rmdir',
    absolutePath: string
  ) => Promise<void>;
}
