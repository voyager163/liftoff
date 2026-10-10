import type { LiftoffManifest } from '../domain/project/contracts.js';
import type {
  ManagedPhaseGraph, UserActivationState, ApprovalEnvelope, PhaseEvidenceRecord, PhaseId, EvidenceHeader,
  LiveReadbackProof, TransitionOperation, SavedTransitionPlan, PhaseGraphNode, MutationClass, TransitionRollbackPlan,
  GovernanceScope, ActivationConfiguration, ExternalOperationState, PhaseOutputBindings
} from '../domain/governance/activation/types.js';
import type { LoadedActivationState } from './activation-state.js';
import type { EvidenceFreshnessContext } from '../domain/governance/activation/evidence.js';
import type { GovernanceSourceOfTruthInspection } from './source-of-truth.js';
import type { ProjectFileMutation, ProjectFileSnapshot } from '../adapters/filesystem/project-transaction.js';
import type { CommandRunner } from '../process-runner.js';
import type { ProjectMutationLease } from '../adapters/filesystem/project-lock.js';
import type { HistoricalLifecycleObligation } from './migration-history.js';
import type { GitHubActivationPorts } from './github-ports.js';

export interface ProtectedStateResourceMapping {
  resourceType: string;
  resourceId: string;
  disposition: 'import' | 'embedded' | 'retain-operation-record';
  stateAddress: string | null;
}

export interface ProtectedStateOperationRequest {
  schemaVersion: 1;
  phaseId: 'private-backend-proof' | 'remote-import-verified';
  bindingDigest: string;
  repository: string;
  defaultBranch: string;
  runner: {
    id: number;
    label: string;
    groupId: number;
    networkConfigurationId: string;
  };
  backend: {
    bindingDigest: string;
    subscriptionId: string;
    tenantId: string;
    resourceGroup: string;
    storageAccount: string;
    container: string;
    keyDigest: string;
    principalId: string;
  };
  bootstrap: {
    bindingDigest: string;
    deploymentResourceId: string;
    environment: string;
    egressMode: 'nat-gateway';
  };
  resources: readonly ProtectedStateResourceMapping[];
  requirements: {
    targetState: 'absent';
    locking: 'azure-blob-lease';
    backup: 'authenticated-encrypted';
    protectedStorage: 'encrypted-private';
    keyCustody: 'external-nonexporting';
    writerQuiescence: true;
    plaintextFallback: false;
    disposal: 'same-qualified-custody';
    completeMapping: true;
    noChangePlan: true;
    retentionDays: 30;
    preExistingStateMigration: false;
  };
  custody: ProtectedStateCustodyProof;
  previousOperation: ExternalOperationState | null;
}

export interface ProtectedStateOperationProgress {
  status: 'pending';
  operation: ExternalOperationState;
}

export interface ProtectedStateOperationFailure {
  status: 'blocked';
  reason:
    | 'capability-unavailable'
    | 'stale-binding'
    | 'ownership-unverified'
    | 'target-occupied'
    | 'locking-unavailable'
    | 'backup-unverified'
    | 'mapping-incomplete'
    | 'concurrency-conflict'
    | 'resource-change'
    | 'verification-failed'
    | 'operation-failed';
}

export interface ProtectedBackendProof {
  kind: 'private-backend-proof.v1';
  bindingDigest: string;
  workflowRunId: number;
  workflowJobId: number;
  headSha: string;
  runnerId: number;
  runnerLabel: string;
  backendBindingDigest: string;
  targetStateExists: false;
  locking: 'azure-blob-lease';
  custody: ProtectedStateCustodyProof;
  observationDigest: string;
}

export interface ProtectedStateBackup {
  artifactDigest: string;
  encryptedStateRef: string;
  encryptionKeyRef: string;
}

export interface ProtectedStateHandoverProof {
  kind: 'remote-import-verified.v1';
  bindingDigest: string;
  workflowRunId: number;
  workflowJobId: number;
  headSha: string;
  runnerId: number;
  runnerLabel: string;
  backendBindingDigest: string;
  mappingDigest: string;
  concurrencyDigest: string;
  remoteBackendDigest: string;
  noChangePlanDigest: string;
  locking: 'azure-blob-lease';
  targetStatePreviouslyExisted: false;
  plan: {
    add: 0;
    change: 0;
    destroy: 0;
  };
  mappings: readonly ProtectedStateResourceMapping[];
  backups: readonly ProtectedStateBackup[];
  custody: ProtectedStateCustodyProof;
}

export type ProtectedBackendProofResult =
  | ProtectedStateOperationProgress
  | ProtectedStateOperationFailure
  | {
    status: 'completed';
    operation: ExternalOperationState;
    proof: ProtectedBackendProof;
  };

export type ProtectedStateHandoverResult =
  | ProtectedStateOperationProgress
  | ProtectedStateOperationFailure
  | {
    status: 'completed';
    operation: ExternalOperationState;
    proof: ProtectedStateHandoverProof;
  };

export interface ProtectedStateHandoverPort {
  proveBackend(request: ProtectedStateOperationRequest): Promise<ProtectedBackendProofResult>;
  handover(request: ProtectedStateOperationRequest): Promise<ProtectedStateHandoverResult>;
}

export interface ProtectedStateCustodyProof {
  kind: 'protected-state-custody.v1';
  bindingDigest: string;
  runnerId: number;
  runnerLabel: string;
  runnerGroupId: number;
  networkConfigurationId: string;
  hostId: string;
  workspaceRef: string;
  storageRef: string;
  keyProviderRef: string;
  protectedStorage: 'encrypted-private';
  keyCustody: 'external-nonexporting';
  locking: 'azure-blob-lease';
  writerQuiesced: true;
  plaintextFallback: false;
  disposalSupported: true;
  observedAt: string;
  expiresAt: string;
  qualificationDigest: string;
}

export interface ProtectedStateCustodyRequest {
  schemaVersion: 1;
  bindingDigest: string;
  repository: string;
  runner: ProtectedStateOperationRequest['runner'];
  backendBindingDigest: string;
  bootstrapBindingDigest: string;
  retentionDays: 30;
}

export type ProtectedStateCustodyFailureReason =
  | 'capability-unavailable'
  | 'unsupported-host'
  | 'protected-storage-unavailable'
  | 'key-unavailable'
  | 'locking-unavailable'
  | 'writer-active'
  | 'disposal-unavailable'
  | 'stale-binding'
  | 'artifact-missing'
  | 'verification-failed';

export type ProtectedStateCustodyResult =
  | { status: 'blocked'; reason: ProtectedStateCustodyFailureReason }
  | { status: 'qualified'; proof: ProtectedStateCustodyProof };

export interface ProtectedStateDisposalRequest {
  schemaVersion: 1;
  repository: string;
  remoteImportEvidenceId: string;
  remoteImportEvidenceDigest: string;
  remoteBackendDigest: string;
  noChangePlanDigest: string;
  disposeAfter: string;
  requestedAt: string;
  custody: ProtectedStateCustodyProof;
  backups: readonly ProtectedStateBackup[];
}

export interface ProtectedStateDisposalProof {
  kind: 'protected-state-disposal.v1';
  remoteImportEvidenceId: string;
  remoteImportEvidenceDigest: string;
  custodyQualificationDigest: string;
  disposedAt: string;
  deletedArtifactRefs: readonly string[];
  deletedKeyRefs: readonly string[];
  payloadFree: true;
  disposalDigest: string;
}

export type ProtectedStateDisposalResult =
  | { status: 'blocked'; reason: ProtectedStateCustodyFailureReason }
  | { status: 'completed'; proof: ProtectedStateDisposalProof };

export interface ProtectedStateCustodyPort {
  qualify(request: ProtectedStateCustodyRequest): Promise<ProtectedStateCustodyResult>;
  dispose(request: ProtectedStateDisposalRequest): Promise<ProtectedStateDisposalResult>;
}

export interface GovernanceTransitionInspection {
  projectRoot: string;
  manifest: LiftoffManifest;
  graph: ManagedPhaseGraph;
  graphHash: string;
  scope?: GovernanceScope;
  activationInputs?: ActivationConfiguration;
  recoverPhase?: PhaseId;
  sensitivePathExclusions?: readonly (readonly string[])[];
  historicalLifecycleObligations?: readonly HistoricalLifecycleObligation[];
  loadedState?: LoadedActivationState;
  state: UserActivationState;
  approvals: readonly ApprovalEnvelope[];
  evidence: readonly PhaseEvidenceRecord[];
  contexts: Record<PhaseId, EvidenceFreshnessContext>;
  readiness: {
    nextReadyPhase: PhaseId | null;
    nextPlannablePhase?: PhaseId | null;
    phases: Record<PhaseId, { state: string; blockers: readonly string[]; plannable?: boolean }>;
  };
  sourceOfTruth: GovernanceSourceOfTruthInspection;
}

export interface GitRepositoryInspection {
  insideWorkTree: boolean;
  root: string | null;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  status: readonly GitStatusEntry[];
  remotes: readonly GitRemote[];
  issues: readonly string[];
}

export interface GitStatusEntry {
  index: string;
  worktree: string;
  path: string;
}

export interface GitRemote {
  name: string;
  url: string;
  pushUrls: readonly string[];
}

export interface Phase0DiscoveryFacts {
  repositoryId: string;
  repositoryName: string;
  defaultBranch: string;
  baselineDigest: string;
  privateStagingDast: boolean | 'unknown';
  credentialRequired: boolean | 'unknown';
  statePath: UserActivationState['applicability']['statePath'];
  approvedFacts: readonly { id: string; value: string | number | boolean | null }[];
}

export interface GitHubRulesetWriteResult {
  resourceId: string;
  sourceDigest: string;
  readbackDigest: string;
}

export interface GitHubRulesetAdapter {
  applyRuleset(input: {
    repository: string;
    sourceDigest: string;
    approvalEnvelopeId: string;
  }): Promise<GitHubRulesetWriteResult>;
  readRuleset(input: {
    repository: string;
    sourceDigest: string;
  }): Promise<GitHubRulesetWriteResult>;
}

export interface PhaseAdapterOutcome {
  status: 'completed' | 'blocked' | 'pending';
  resultState?: EvidenceHeader['result'] | 'approved';
  blocker?: string;
  evidencePayload?: unknown;
  liveReadback?: readonly LiveReadbackProof[];
  stateOverride?: UserActivationState;
  fileMutations?: readonly ProjectFileMutation[];
  filePreconditions?: readonly ProjectFileSnapshot[];
  completedOperations?: readonly TransitionOperation[];
  cleanupWarnings?: readonly string[];
  /** Local source finalization may already have happened; never permits forgetting remote effects. */
  retryableWithoutStateMutation?: boolean;
  operation?: ExternalOperationState;
  outputs?: PhaseOutputBindings;
}

export interface PhasePlanBuild {
  operations: readonly TransitionOperation[];
  fileMutations?: readonly ProjectFileMutation[];
  filePreconditions?: readonly ProjectFileSnapshot[];
  blockers?: readonly string[];
}

export interface PhasePlanningInput {
  inspection: GovernanceTransitionInspection;
  phase: PhaseGraphNode;
  runner: CommandRunner;
  now: Date;
}

export interface GovernancePhaseAdapter {
  phaseId: PhaseId;
  execute(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome>;
}

export interface PhaseAdapterExecutionInput {
  inspection: GovernanceTransitionInspection;
  plan: SavedTransitionPlan;
  phase: PhaseGraphNode;
  runner: CommandRunner;
  adapters: GovernanceTransitionAdapters;
  now: Date;
  clock?: () => Date;
  lease?: ProjectMutationLease;
  recovery?: boolean;
  credentialEnrollment?: { protectedStdin: boolean };
}

export interface GovernanceTransitionAdapters {
  phases?: Partial<Record<PhaseId, GovernancePhaseAdapter>>;
  githubRulesets?: GitHubRulesetAdapter;
  githubActivation?: GitHubActivationPorts;
  protectedStateHandover?: ProtectedStateHandoverPort;
  protectedStateCustody?: ProtectedStateCustodyPort;
  azureOperationPolling?: {
    maxAttempts: number;
    intervalMs: number;
    sleep(milliseconds: number): Promise<void>;
  };
}

export interface ApplyNextPreview {
  schemaVersion: 2;
  scope?: GovernanceScope;
  command: 'governance apply-next';
  projectRoot: string;
  execute: boolean;
  applied: false;
  authorized: boolean;
  reason: string;
  message: string;
  selectedPhase: PhaseId | null;
  nextReadyPhase: PhaseId | null;
  approval: SavedTransitionPlan['approval'] | null;
  proposedMutations: {
    local: readonly MutationClass[];
    remote: readonly MutationClass[];
    operations: readonly TransitionOperation[];
  };
  savedPlan: null | {
    pathParts: readonly string[];
    digest: string;
  };
  noWrites: boolean;
  blockers: readonly string[];
}

export interface ApplyNextExecutionResult extends Omit<ApplyNextPreview, 'applied' | 'savedPlan' | 'noWrites'> {
  applied: boolean;
  executedPhase: PhaseId | null;
  savedPlan: {
    pathParts: readonly string[];
    digest: string;
  } | null;
  noWrites: false;
  executedOperations: readonly TransitionOperation[];
  evidence: {
    evidenceId: string;
    pathParts: readonly string[];
    headerDigest: string;
    result: EvidenceHeader['result'];
  } | null;
  stateHash: string | null;
  rollbackPlan: TransitionRollbackPlan;
  cleanupWarnings: readonly string[];
}
