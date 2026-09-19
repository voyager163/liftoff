import type { LiftoffManifest } from '../../domain/project/contracts.js';
import { type LoadedActivationState } from '../../governance-activation/activation-state.js';
import { type PatEnrollmentGuidance } from '../../governance-activation/credentials.js';
import { type EvidenceFreshnessContext } from '../../domain/governance/activation/evidence.js';
import { type ReadinessResult } from '../../domain/governance/activation/readiness.js';
import { type GovernanceSourceOfTruthInspection } from '../../governance-activation/source-of-truth.js';
import { type ArchivedSeedIntegrity } from '../../governance-activation/seed-lifecycle.js';
import type { ApprovalEnvelope, EvidenceHeader, ManagedPhaseGraph, PhaseEvidenceRecord, PhaseId, CredentialPolicy, UserActivationState } from '../../domain/governance/activation/types.js';
import { type GovernanceScope, type ActivationConfiguration, type ActivationConfigurationBinding } from '../../domain/governance/activation/types.js';
import { type HistoricalLifecycleObligation } from '../../governance-activation/migration-history.js';
import { type MigrationJournal } from '../../governance-activation/history-contracts.js';
import { type StructuredContinuationV1 } from '../../protocol/continuation.js';
import type { PhaseReviewRequest } from '../../governance-activation/transition-ports.js';
import type { UpdatePreviewOptions } from '../../adapters/filesystem/update-previews.js';
import path from 'node:path';

export type GovernanceSubcommand = 'status' | 'plan' | 'approve' | 'apply-next' | 'credential-enroll' | 'recover' | 'resume' | 'verify';

export type GraphSource = 'packaged' | 'managed';

export type CheckStatus = 'passed' | 'failed' | 'skipped';

export interface LoadedGovernanceGraph {
  source: GraphSource;
  graph: ManagedPhaseGraph;
  hash: string;
}

export interface EvidenceFreshnessEntry {
  phaseId: PhaseId;
  status: 'fresh' | 'missing' | 'stale';
  selectedEvidenceId: string | null;
  selectedResult: EvidenceHeader['result'] | null;
  requiresLiveReadback: boolean;
  liveReadbackProviders: readonly string[];
  issues: readonly string[];
}

export interface GovernanceInspection {
  projectRoot: string;
  manifest: LiftoffManifest;
  graph: LoadedGovernanceGraph;
  loadedState?: LoadedActivationState;
  state: UserActivationState;
  stateSource: 'user' | 'not-started';
  approvals: readonly ApprovalEnvelope[];
  evidence: readonly PhaseEvidenceRecord[];
  reviews?: readonly PhaseReviewRequest[];
  contexts: Record<PhaseId, EvidenceFreshnessContext>;
  evidenceFreshness: Record<PhaseId, EvidenceFreshnessEntry>;
  readiness: ReadinessResult;
  sourceOfTruth: GovernanceSourceOfTruthInspection;
  credential: CredentialInspection;
  archivedSeedIntegrity: ArchivedSeedIntegrity;
  retryArchivedSeedBaseline: boolean;
  expectedActiveSeed: boolean;
  migration: MigrationJournal | null;
  scope: GovernanceScope;
  activationInputs?: ActivationConfiguration;
  configurationBinding?: ActivationConfigurationBinding;
  recoverPhase?: PhaseId;
  sensitivePathExclusions: readonly (readonly string[])[];
  historicalLifecycleObligations: readonly HistoricalLifecycleObligation[];
}

export interface CredentialInspection {
  applicable: boolean;
  readOnly: true;
  path: string;
  status: 'not-applicable' | 'missing' | 'valid' | 'invalid' | 'compromised' | 'not-ready';
  ready: boolean;
  guidance: PatEnrollmentGuidance | null;
  policy: CredentialPolicy | null;
  issues: readonly string[];
}

export interface VerificationCheck {
  id: string;
  status: CheckStatus;
  issues: readonly string[];
}

export interface GovernanceMigrationSummary {
  localCommit: MigrationJournal['transaction'];
  snapshot: {
    id: string;
    indexPathParts: readonly string[];
    indexDigest: string;
    linkage: 'validated';
    successor: MigrationJournal['successor'];
  };
  revalidation: MigrationJournal['revalidation'];
  nextRecordedPhase: PhaseId | null;
  currentProofRequired: true;
  remedy: string | null;
}

export type SetupCompletionStatus = 'not-started' | 'in-progress' | 'complete';

export interface GovernanceVerificationResult {
  schemaVersion: 3;
  cli: { version: string; executable: 'liftoff' };
  scope: GovernanceScope;
  command: 'governance verify';
  projectRoot: string;
  readOnly: true;
  ok: boolean;
  consistent: boolean;
  verificationStatus: 'consistent' | 'inconsistent';
  complete: boolean;
  setupStatus: SetupCompletionStatus;
  stateSource: GovernanceInspection['stateSource'];
  summary: string;
  activationIdentity: UserActivationState['identity'];
  migration: MigrationJournal | null;
  migrationSummary: GovernanceMigrationSummary | null;
  graphHash: string;
  activeChange: UserActivationState['activeChange'];
  activeSourceOfTruth: GovernanceSourceOfTruthInspection;
  nextReadyPhase: PhaseId | null;
  checks: readonly VerificationCheck[];
  progress: Record<GovernanceScope, boolean>;
  historicalLifecycleObligations: readonly HistoricalLifecycleObligation[];
  taskProjectionAudit: UserActivationState['taskProjection'] | null;
  nextActions: readonly GovernanceNextAction[];
}

export interface GovernanceInspectionOptions {
  scope?: GovernanceScope;
  command?: string;
  activationInputs?: ActivationConfiguration;
  configurationBinding?: ActivationConfigurationBinding;
  recoverPhase?: PhaseId;
  storage?: UpdatePreviewOptions;
}

export interface GovernanceNextAction extends StructuredContinuationV1 {
  continuation: StructuredContinuationV1;
  id: string;
  label: string;
  command: { executable: 'liftoff'; args: readonly string[] };
  cwd: string;
  scope: GovernanceScope;
  approvalRequired: boolean;
}
