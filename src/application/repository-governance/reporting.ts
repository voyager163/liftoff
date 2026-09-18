import { formatUpdateCommand } from '../update/command-guidance.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { approvalRequestForSavedPlan, canonicalApprovalEnvelopeHash, evaluateApprovalForTransitionPlan, transitionPlanForPhase } from '../../domain/governance/activation/approvals.js';
import type { ApprovalEnvelope, ApprovalEvaluation, PhaseGraphNode } from '../../domain/governance/activation/types.js';
import { phaseIds, phaseScope, phaseInScope } from '../../domain/governance/activation/types.js';
import { phaseCapabilities } from '../../domain/governance/activation/capabilities.js';
import { migrationRevalidationPhaseIds } from '../../governance-activation/history-contracts.js';
import type { GovernanceSubcommand, GovernanceInspection, GovernanceMigrationSummary } from './inspection-contracts.js';
import { verificationPhaseIds } from './progress.js';
import { governanceNextActions } from './continuation.js';
import { liftoffVersion } from '../../version.js';

export function approvalStatus(approval: ApprovalEnvelope, now = new Date()): 'valid' | 'expired' {
  return Date.parse(approval.expiresAt) > now.getTime() ? 'valid' : 'expired';
}

export function approvalEvaluationForPhase(
  phase: PhaseGraphNode,
  inspection: GovernanceInspection
): ApprovalEvaluation {
  const reviewed = inspection.contexts[phase.id].reviewedPlans?.filter((plan) => plan.phaseId === phase.id &&
    plan.inputDigest === inspection.contexts[phase.id].inputDigest && plan.baselineDigest === inspection.contexts[phase.id].baselineSha)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  const plan = reviewed ? approvalRequestForSavedPlan(reviewed, phase, inspection.state) : transitionPlanForPhase(
    phase,
    inspection.state,
    inspection.contexts[phase.id].transition,
    inspection.projectRoot,
    inspection.contexts[phase.id].publicationDestination
  );
  return evaluateApprovalForTransitionPlan(plan, inspection.approvals);
}

export function approvalEvaluationJson(evaluation: ApprovalEvaluation): Record<string, unknown> {
  return {
    questionKind: evaluation.questionKind,
    approvalRequired: evaluation.approvalRequired,
    status: evaluation.status,
    envelopeId: evaluation.envelopeId,
    envelopeHash: evaluation.envelopeHash,
    reasons: evaluation.reasons,
    expansionReasons: evaluation.expansionReasons
  };
}

export function summarizeMigration(inspection: GovernanceInspection): GovernanceMigrationSummary | null {
  const journal = inspection.migration;
  if (!journal) return null;
  const phases = migrationRevalidationPhaseIds.map((phaseId) =>
    journal.revalidation.phases.find((phase) => phase.phaseId === phaseId)!
  );
  const needsRevalidation = journal.revalidation.status !== 'complete' ||
    migrationRevalidationPhaseIds.some((phaseId) => inspection.readiness.phases[phaseId].state !== 'verified');
  const checkCommand = formatUpdateCommand(inspection.projectRoot, 'check');
  return {
    localCommit: journal.transaction,
    snapshot: {
      id: journal.snapshotId,
      indexPathParts: journal.historyIndexPathParts,
      indexDigest: journal.historyIndexDigest,
      linkage: 'validated',
      successor: journal.successor
    },
    revalidation: { ...journal.revalidation, phases },
    nextRecordedPhase: phases.find((phase) => phase.status !== 'complete')?.phaseId ?? null,
    currentProofRequired: true,
    remedy: needsRevalidation
      ? `Keep the committed v${journal.targetIdentity.activationContractVersion} successor and its preserved source and ancestor history. Repair the named blockers or stale current proof, run ${checkCommand} for a fresh preview, then explicitly approve the exact remaining local plan before retrying. Prior migration approval does not authorize new work.`
      : null
  };
}

export function statusJson(inspection: GovernanceInspection, command: GovernanceSubcommand): Record<string, unknown> {
  const blockers = verificationPhaseIds(inspection).flatMap((phaseId) =>
    inspection.readiness.phases[phaseId].blockers.map((message) => ({ phaseId, message }))
  );
  return {
    schemaVersion: 3,
    cli: { version: liftoffVersion, executable: 'liftoff' },
    scope: inspection.scope,
    command: `governance ${command}`,
    projectRoot: inspection.projectRoot,
    readOnly: command !== 'apply-next',
    stateSource: inspection.stateSource,
    activationDisabled: inspection.manifest.governance.profile === 'none',
    progress: inspection.readiness.completion,
    localComplete: inspection.readiness.completion.local,
    repositoryComplete: inspection.readiness.completion.repository,
    activationComplete: inspection.readiness.completion.activation,
    lifecycleComplete: inspection.readiness.completion.lifecycle,
    nextActions: governanceNextActions(inspection),
    blockerFingerprint: canonicalSha256({
      scope: inspection.scope, stateHash: inspection.loadedState?.contentHash ?? null,
      inputs: verificationPhaseIds(inspection).map((id) => [id, inspection.contexts[id].inputDigest]), blockers
    }),
    activationIdentity: inspection.state.identity,
    migration: inspection.migration,
    migrationSummary: summarizeMigration(inspection),
    taskProjectionAudit: inspection.state.taskProjection ?? null,
    historicalLifecycleObligations: inspection.historicalLifecycleObligations,
    executionAnchor: inspection.state.repository.id === 'unbound' ? null : inspection.state.repository.id,
    remoteBinding: inspection.state.remoteBinding ?? null,
    graphHash: inspection.graph.hash,
    graph: {
      source: inspection.graph.source,
      hash: inspection.graph.hash,
      schemaVersion: inspection.graph.graph.schemaVersion
    },
    activeChange: inspection.state.activeChange,
    activeSourceOfTruth: inspection.sourceOfTruth,
    credential: inspection.credential,
    phases: inspection.graph.graph.phases.map((phase) => ({
      id: phase.id,
      label: phase.label,
      state: inspection.readiness.phases[phase.id].state,
      storedState: inspection.state.phases[phase.id].state,
      scope: phaseScope(phase.id),
      plannable: inspection.readiness.phases[phase.id].plannable ?? false,
      externalOperation: inspection.state.phases[phase.id].operation ?? null,
      executionPlanDigest: inspection.state.phases[phase.id].executionPlanDigest ?? null,
      storedBlockers: inspection.state.phases[phase.id].blockers,
      retryable: phaseCapabilities[phase.id].retry === 'explicit-local' &&
        ['failed', 'blocked'].includes(inspection.state.phases[phase.id].state),
      capability: phaseCapabilities[phase.id],
      blockers: inspection.readiness.phases[phase.id].blockers,
      evidence: {
        schema: phase.evidence.schema,
        required: phase.evidence.required,
        freshness: inspection.evidenceFreshness[phase.id]
      },
      approvalGate: phase.approvalGate,
      approval: approvalEvaluationJson(approvalEvaluationForPhase(phase, inspection)),
      allowedMutations: phase.allowedMutations
    })),
    nextReadyPhase: inspection.readiness.nextReadyPhase,
    nextPlannablePhase: inspection.readiness.nextPlannablePhase,
    blockers,
    approvals: inspection.approvals.map((approval) => ({
      id: approval.id,
      phaseId: approval.phaseId,
      gateKind: approval.gateKind,
      status: approvalStatus(approval),
      envelopeHash: canonicalApprovalEnvelopeHash(approval),
      expiresAt: approval.expiresAt
    })),
    evidenceFreshness: phaseIds.map((phaseId) => inspection.evidenceFreshness[phaseId])
    , reviews: inspection.reviews ?? []
  };
}

export function planJson(inspection: GovernanceInspection): Record<string, unknown> {
  const scopedPhases = inspection.graph.graph.phases.filter((phase) => phaseInScope(phase.id, inspection.scope, true));
  const ready = scopedPhases
    .filter((phase) => inspection.readiness.phases[phase.id].state === 'ready')
    .map((phase) => planPhase(phase, inspection));
  const blocked = scopedPhases
    .filter((phase) => inspection.readiness.phases[phase.id].state === 'blocked')
    .map((phase) => ({
      ...planPhase(phase, inspection),
      blockers: inspection.readiness.phases[phase.id].blockers
    }));
  return {
    schemaVersion: 3,
    cli: { version: liftoffVersion, executable: 'liftoff' },
    scope: inspection.scope,
    command: 'governance plan',
    projectRoot: inspection.projectRoot,
    readOnly: true,
    noWrites: true,
    activationIdentity: inspection.state.identity,
    graphHash: inspection.graph.hash,
    activeChange: inspection.state.activeChange,
    activeSourceOfTruth: inspection.sourceOfTruth,
    credential: inspection.credential,
    progress: inspection.readiness.completion,
    nextReadyPhase: inspection.readiness.nextReadyPhase,
    nextPlannablePhase: inspection.readiness.nextPlannablePhase,
    nextActions: governanceNextActions(inspection),
    readyPhases: ready,
    blockedPhases: blocked
    , reviews: inspection.reviews ?? []
  };
}

export function planPhase(phase: PhaseGraphNode, inspection: GovernanceInspection): Record<string, unknown> {
  return {
    id: phase.id,
    label: phase.label,
    requiredEvidence: {
      schema: phase.evidence.schema,
      required: phase.evidence.required,
      liveReadbackProviders: phase.evidence.liveReadbackProviders
    },
    approvalGate: phase.approvalGate,
    approval: approvalEvaluationJson(approvalEvaluationForPhase(phase, inspection)),
    permittedMutations: phase.allowedMutations,
    costEnvelope: costEnvelope(phase),
    evidenceFreshness: inspection.evidenceFreshness[phase.id]
    ,
    ...(phase.id === 'credential-ready' && inspection.credential.applicable
      ? { credential: inspection.credential }
      : {})
  };
}

export function costEnvelope(phase: PhaseGraphNode): Record<string, unknown> {
  const relevant = phase.approvalGate.kind === 'infrastructure-cost' ||
    phase.allowedMutations.remote.some((entry) => entry.startsWith('azure-'));
  return {
    relevant,
    gate: phase.approvalGate.kind,
    reason: relevant
      ? 'Infrastructure approval may constrain resource classes, destinations, and cost ceilings.'
      : 'No infrastructure cost envelope is required for this phase.'
  };
}
