import type { LiftoffManifest } from '../domain/project/contracts.js';
import type {
  ManagedPhaseGraph, UserActivationState, ApprovalEnvelope, PhaseEvidenceRecord, PhaseId, EvidenceHeader,
  LiveReadbackProof, TransitionOperation, SavedTransitionPlan, PhaseGraphNode, MutationClass, TransitionRollbackPlan,
  GovernanceScope, ActivationConfiguration, ActivationConfigurationBinding, ExternalOperationState, PhaseOutputBindings
} from '../domain/governance/activation/types.js';
import type { LoadedActivationState } from './activation-state.js';
import type { EvidenceFreshnessContext } from '../domain/governance/activation/evidence.js';
import type { GovernanceSourceOfTruthInspection } from './source-of-truth.js';
import type { ProjectFileMutation, ProjectFileSnapshot } from '../adapters/filesystem/project-transaction.js';
import type { CommandRunner } from '../process-runner.js';
import type { ProjectMutationLease } from '../adapters/filesystem/project-lock.js';
import type { HistoricalLifecycleObligation } from './migration-history.js';
import type { GitHubActivationPorts } from './github-ports.js';
import type { AzureActivationPorts } from './azure-ports.js';

export interface GovernanceTransitionInspection {
  projectRoot: string;
  manifest: LiftoffManifest;
  graph: ManagedPhaseGraph;
  graphHash: string;
  scope?: GovernanceScope;
  activationInputs?: ActivationConfiguration;
  configurationBinding?: ActivationConfigurationBinding;
  recoverPhase?: PhaseId;
  sensitivePathExclusions?: readonly (readonly string[])[];
  historicalLifecycleObligations?: readonly HistoricalLifecycleObligation[];
  loadedState?: LoadedActivationState;
  state: UserActivationState;
  approvals: readonly ApprovalEnvelope[];
  evidence: readonly PhaseEvidenceRecord[];
  reviews?: readonly PhaseReviewRequest[];
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
  observationDigest?: string;
  ownedControls?: readonly { id: number; name: string }[];
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

export interface PhaseReviewRequest {
  schemaVersion: 1;
  kind: 'application-private-plan' | 'application-prerequisites-rbac' | 'credential-enrollment' | 'credential-usage';
  phaseId: PhaseId;
  sourcePlanDigest: string;
  payload: unknown;
}

export interface PhaseAdapterOutcome {
  status: 'completed' | 'blocked' | 'pending' | 'review-required';
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
  review?: PhaseReviewRequest;
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
  adapters?: GovernanceTransitionAdapters;
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

export interface GovernanceProviderEngine {
  planPhase(input: PhasePlanningInput): Promise<PhasePlanBuild | null>;
  executePhase(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null>;
}

export interface GovernanceTransitionAdapters {
  phases?: Partial<Record<PhaseId, GovernancePhaseAdapter>>;
  githubRulesets?: GitHubRulesetAdapter;
  githubActivation?: GitHubActivationPorts;
  azureActivation?: AzureActivationPorts;
  providerEngines?: {
    readonly repositoryGovernance: GovernanceProviderEngine;
    readonly azureActivation: GovernanceProviderEngine & {
      planCompositePhase(input: PhasePlanningInput): Promise<PhasePlanBuild | null>;
      executeCompositePhase(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null>;
    };
  };
}

export interface ApplyNextPreview {
  schemaVersion: 3;
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
  noWrites: boolean;
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
  readinessStatus?: 'observed' | 'indeterminate';
  inspectionFailure?: string;
  review?: PhaseReviewRequest;
  phaseComplete?: boolean;
}
