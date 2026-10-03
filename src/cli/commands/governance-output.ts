import {
  type GovernanceInspection,
  type GovernanceMigrationSummary,
  approvalEvaluationForPhase,
  summarizeMigration
} from '../../application/governance/inspection.js';
import {
  type SetupCompletionStatus,
  type VerificationCheck,
  setupCompletion,
  verificationPhaseIds,
  verifyChecks
} from '../../application/governance/verification.js';
import { canonicalApprovalEnvelopeHash } from '../../domain/governance/activation/approvals.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { phaseCapabilities } from '../../domain/governance/activation/capabilities.js';
import {
  type ApprovalEnvelope,
  type ApprovalEvaluation,
  type GovernanceScope,
  type ManagedPhaseGraph,
  type PhaseGraphNode,
  type PhaseId,
  type SavedTransitionPlan,
  type UserActivationState,
  phaseIds,
  phaseScope
} from '../../domain/governance/activation/types.js';
import { detectCredentialLeaks } from '../../governance-activation/credentials.js';
import type { MigrationJournal } from '../../governance-activation/history-contracts.js';
import type { HistoricalLifecycleObligation } from '../../governance-activation/migration-history.js';
import type { GovernanceSourceOfTruthInspection } from '../../governance-activation/source-of-truth.js';
import { errorMessage } from '../../governance-activation/transition-process.js';
import type { ApplyNextExecutionResult, ApplyNextPreview } from '../../governance-activation/transitions.js';
import type { PresentationSession } from '../../terminal.js';
import { parseArgs } from '../args/parser.js';

export type GovernanceSubcommand = 'status' | 'plan' | 'approve' | 'apply-next' | 'credential-enroll' | 'recover' | 'resume' | 'verify';

interface GovernanceVerificationResult {
  schemaVersion: 2;
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

export function json(presentation: PresentationSession, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const scan = detectCredentialLeaks([{ source: 'generated-artifact', label: 'governance command output', text }]);
  if (scan.status === 'compromised') {
    throw new Error('Governance output contained credential-shaped data and was withheld; inspect the protected execution checkpoint.');
  }
  presentation.rawStdout(text);
}

function phaseMap(graph: ManagedPhaseGraph): Record<PhaseId, PhaseGraphNode> {
  return Object.fromEntries(graph.phases.map((phase) => [phase.id, phase])) as Record<PhaseId, PhaseGraphNode>;
}

function approvalStatus(approval: ApprovalEnvelope, now = new Date()): 'valid' | 'expired' {
  return Date.parse(approval.expiresAt) > now.getTime() ? 'valid' : 'expired';
}

function approvalEvaluationJson(evaluation: ApprovalEvaluation): Record<string, unknown> {
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

function renderMigrationHuman(
  summary: GovernanceMigrationSummary | null,
  presentation: PresentationSession
): void {
  if (!summary) return;
  presentation.definitions('Migration progress (journal)', [
    { label: 'Local migration', value: `${summary.localCommit.status} at ${summary.localCommit.committedAt}` },
    { label: 'History snapshot', value: summary.snapshot.id },
    { label: 'History index', value: summary.snapshot.indexPathParts.join('/') },
    { label: 'History index digest', value: summary.snapshot.indexDigest },
    { label: 'History linkage', value: `${summary.snapshot.linkage}; successor ${summary.snapshot.successor.repositoryId}` },
    { label: 'Recorded revalidation', value: summary.revalidation.status },
    { label: 'Next recorded phase', value: summary.nextRecordedPhase ?? 'none' }
  ]);
  presentation.table('Recorded local revalidation', ['Phase', 'Progress', 'Blockers'], summary.revalidation.phases.map((phase) => [
    phase.phaseId,
    phase.status,
    phase.blockers.join('; ') || 'none recorded'
  ]));
  if (summary.revalidation.nextAction) {
    presentation.status('pending', 'Recorded next action', summary.revalidation.nextAction);
  }
  presentation.status(
    'info',
    'Migration scope',
    'Journal progress is audit information, not current proof, governance completion, approval, or provider authority. Current readiness is evaluated separately from v3 evidence.'
  );
  if (summary.remedy) presentation.remedy(summary.remedy);
}

export function statusJson(inspection: GovernanceInspection, command: GovernanceSubcommand): Record<string, unknown> {
  const blockers = verificationPhaseIds(inspection).flatMap((phaseId) =>
    inspection.readiness.phases[phaseId].blockers.map((message) => ({ phaseId, message }))
  );
  return {
    schemaVersion: 2,
    scope: inspection.scope,
    command: `governance ${command}`,
    projectRoot: inspection.projectRoot,
    readOnly: command !== 'apply-next',
    stateSource: inspection.stateSource,
    activationDisabled: inspection.manifest.governance.profile === 'none',
    progress: inspection.readiness.completion,
    localComplete: inspection.readiness.completion.local,
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
  };
}

interface GovernanceNextAction {
  id: string;
  label: string;
  command: { executable: 'liftoff'; args: readonly string[] };
  cwd: string;
  scope: GovernanceScope;
  approvalRequired: boolean;
}

function governanceAction(
  inspection: GovernanceInspection,
  subcommand: GovernanceSubcommand,
  scope: GovernanceScope,
  extras: readonly string[] = [],
  approvalRequired = false
): GovernanceNextAction {
  const args = ['governance', subcommand, '--project', inspection.projectRoot, '--scope', scope, ...extras, '--json'];
  parseArgs(args);
  return {
    id: `governance-${subcommand}-${scope}`, label: `${subcommand} ${scope} governance`,
    command: { executable: 'liftoff', args }, cwd: inspection.projectRoot, scope, approvalRequired
  };
}

export function governanceNextActions(
  inspection: GovernanceInspection,
  preview?: { fingerprint: string; plan: SavedTransitionPlan }
): GovernanceNextAction[] {
  if (inspection.manifest.governance.profile === 'none' && inspection.scope === 'activation') return [];
  if (inspection.readiness.completion[inspection.scope]) {
    if (inspection.scope === 'local') return [governanceAction(inspection, 'plan', 'activation')];
    if (inspection.scope === 'activation' && !inspection.readiness.completion.lifecycle) {
      return [governanceAction(inspection, 'status', 'lifecycle')];
    }
    return [];
  }
  if (preview) {
    const planArgs = ['--plan', preview.fingerprint];
    if (preview.plan.approval.evaluation.approvalRequired) {
      return [governanceAction(inspection, 'approve', preview.plan.scope, planArgs, true)];
    }
    const subcommand = preview.plan.recovery ? 'recover' : 'apply-next';
    return [governanceAction(inspection, subcommand, preview.plan.scope,
      [...(inspection.stateSource === 'not-started' ? [] : planArgs), '--execute'])];
  }
  const interrupted = phaseIds.find((id) => phaseScope(id) === inspection.scope && inspection.readiness.phases[id].recoveryRequired);
  if (interrupted) return [governanceAction(inspection, 'plan', inspection.scope, ['--recover-phase', interrupted])];
  if (inspection.scope !== 'local' && !inspection.readiness.completion.local) {
    return [governanceAction(inspection, 'plan', 'local')];
  }
  return [governanceAction(inspection, 'plan', inspection.scope)];
}

export function renderStatusHuman(inspection: GovernanceInspection, command: GovernanceSubcommand): void {
  const presentation = inspectionPresentation(inspection);
  presentation.commandIdentity(`governance ${command}`, 'Deterministic activation status');
  presentation.definitions('Activation identity', [
    { label: 'Project', value: inspection.projectRoot },
    { label: 'Scope', value: inspection.scope },
    { label: 'State', value: inspection.stateSource },
    { label: 'Policy', value: inspection.state.identity.policyVersion },
    { label: 'Contract', value: String(inspection.state.identity.activationContractVersion) },
    { label: 'Graph hash', value: inspection.graph.hash },
    { label: 'Active change', value: inspection.state.activeChange?.id ?? 'none' },
    {
      label: 'Active source',
      value: inspection.sourceOfTruth.status === 'selected'
        ? inspection.sourceOfTruth.selected.changeId
        : inspection.sourceOfTruth.status
    }
  ]);
  renderMigrationHuman(summarizeMigration(inspection), presentation);
  if (inspection.sourceOfTruth.status === 'seed-blocked') {
    presentation.status('error', 'Seed blocker', inspection.sourceOfTruth.blockers.join('; '));
  } else if (inspection.sourceOfTruth.status === 'ambiguous' || inspection.sourceOfTruth.status === 'incompatible') {
    presentation.status('error', 'Active source blocked', inspection.sourceOfTruth.blockers.join('; '));
  } else if (inspection.sourceOfTruth.status === 'selected') {
    presentation.status(
      inspection.sourceOfTruth.reconciliation.status === 'not-required' ? 'success' : 'pending',
      'Source acknowledgment',
      inspection.sourceOfTruth.reconciliation.status
    );
  } else {
    presentation.status('pending', 'Governance change plan', inspection.sourceOfTruth.createPlan.reason);
  }
  if (inspection.credential.applicable) {
    presentation.status(
    inspection.credential.ready ? 'success' : inspection.credential.status === 'compromised' ? 'error' : 'pending',
    'Credential policy',
    inspection.credential.ready
      ? 'credential-ready metadata has verified payload-free readback'
      : inspection.credential.issues[0] ?? 'deterministic credential enrollment required'
    );
  }
  const next = inspection.readiness.nextReadyPhase ?? 'none';
  if (inspection.retryArchivedSeedBaseline) {
    presentation.status(
      'pending',
      'Archived baseline retry',
      `The prior baseline failure is preserved. Explicit execution reruns all local checks: ${inspection.state.phases['seed-verified'].blockers.join('; ')}`
    );
  }
  presentation.status(next === 'none' ? 'info' : 'pending', 'Next ready phase', next);
  if (inspection.readiness.nextReadyPhase) {
    const phase = phaseMap(inspection.graph.graph)[inspection.readiness.nextReadyPhase];
    const approval = approvalEvaluationForPhase(phase, inspection);
    presentation.status(
      approval.approvalRequired ? 'pending' : 'success',
      'Approval',
      `${approval.questionKind ?? 'none'}; ${approval.status}; ${approval.reasons.join('; ')}`
    );
  }
  const blockerRows = phaseIds
    .filter((phaseId) => inspection.readiness.phases[phaseId].blockers.length > 0)
    .slice(0, 6)
    .map((phaseId) => [
      phaseId,
      inspection.readiness.phases[phaseId].state,
      inspection.readiness.phases[phaseId].blockers[0] ?? ''
    ]);
  if (blockerRows.length > 0) {
    presentation.table('Current blockers', ['Phase', 'State', 'Reason'], blockerRows);
  }
}

function inspectionPresentation(inspection: GovernanceInspection): PresentationSession {
  return (inspection as GovernanceInspection & { presentation?: PresentationSession }).presentation!;
}

export function planJson(inspection: GovernanceInspection): Record<string, unknown> {
  const scopedPhases = inspection.scope === 'local'
    ? inspection.graph.graph.phases.filter((phase) => phaseScope(phase.id) === 'local')
    : inspection.scope === 'lifecycle'
      ? inspection.graph.graph.phases.filter((phase) => phaseScope(phase.id) === 'lifecycle')
      : inspection.graph.graph.phases.filter((phase) => phaseScope(phase.id) !== 'lifecycle');
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
    schemaVersion: 2,
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
  };
}

function planPhase(phase: PhaseGraphNode, inspection: GovernanceInspection): Record<string, unknown> {
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

function costEnvelope(phase: PhaseGraphNode): Record<string, unknown> {
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

export function renderPlanHuman(inspection: GovernanceInspection, presentation: PresentationSession): void {
  presentation.commandIdentity('governance plan', `Project-read-only ${inspection.scope} transition plan`);
  const scopedPhases = inspection.scope === 'local'
    ? inspection.graph.graph.phases.filter((phase) => phaseScope(phase.id) === 'local')
    : inspection.scope === 'lifecycle'
      ? inspection.graph.graph.phases.filter((phase) => phaseScope(phase.id) === 'lifecycle')
      : inspection.graph.graph.phases.filter((phase) => phaseScope(phase.id) !== 'lifecycle');
  const ready = scopedPhases.filter((phase) => inspection.readiness.phases[phase.id].state === 'ready');
  const blocked = scopedPhases.filter((phase) => inspection.readiness.phases[phase.id].state === 'blocked');
  presentation.status('info', 'Project-read-only', 'No project or provider data is changed; any external preview receipt is disclosed separately.');
  presentation.table('Ready phases', ['Phase', 'Evidence', 'Question', 'Approval', 'Mutations'], ready.map((phase) => {
    const approval = approvalEvaluationForPhase(phase, inspection);
    return [
    phase.id,
    phase.evidence.schema,
    approval.questionKind ?? 'none',
    phase.approvalGate.required ? phase.approvalGate.kind : 'none',
    `local=${phase.allowedMutations.local.join(',')} remote=${phase.allowedMutations.remote.join(',')}`
    ];
  }));
  presentation.table('Blocked phases', ['Phase', 'Reason'], blocked.slice(0, 12).map((phase) => [
    phase.id,
    inspection.readiness.phases[phase.id].blockers.join('; ')
  ]));
}

export async function verifyJson(inspection: GovernanceInspection): Promise<GovernanceVerificationResult> {
  const checks = await verifyChecks(inspection);
  const consistent = checks.every((check) => check.status !== 'failed');
  const completion = setupCompletion(inspection);
  const summary = consistent
    ? completion.summary
    : 'Verification found inconsistent governance state; setup is not complete.';
  const setupStatus = consistent || completion.status === 'not-started'
    ? completion.status
    : 'in-progress';
  return {
    schemaVersion: 2,
    scope: inspection.scope,
    command: 'governance verify',
    projectRoot: inspection.projectRoot,
    readOnly: true,
    ok: consistent,
    consistent,
    verificationStatus: consistent ? 'consistent' : 'inconsistent',
    complete: consistent && completion.complete,
    setupStatus,
    stateSource: inspection.stateSource,
    summary,
    activationIdentity: inspection.state.identity,
    migration: inspection.migration,
    migrationSummary: summarizeMigration(inspection),
    graphHash: inspection.graph.hash,
    activeChange: inspection.state.activeChange,
    activeSourceOfTruth: inspection.sourceOfTruth,
    nextReadyPhase: inspection.readiness.nextReadyPhase,
    progress: inspection.readiness.completion,
    nextActions: governanceNextActions(inspection),
    checks,
    historicalLifecycleObligations: inspection.historicalLifecycleObligations,
    taskProjectionAudit: inspection.state.taskProjection ?? null
  };
}

export async function renderVerifyHuman(inspection: GovernanceInspection, presentation: PresentationSession): Promise<number> {
  const result = await verifyJson(inspection);
  const checks = result.checks;
  presentation.commandIdentity('governance verify', 'Read-only activation verification');
  presentation.status(
    result.complete ? 'success' : result.consistent ? 'pending' : 'error',
    'setup-completion',
    result.summary
  );
  renderMigrationHuman(result.migrationSummary, presentation);
  for (const check of checks) {
    presentation.status(check.status === 'failed' ? 'error' : check.status === 'skipped' ? 'info' : 'success', check.id, check.issues[0]);
  }
  return result.ok === true ? 0 : 1;
}

export function renderInspectionFailure(
  subcommand: GovernanceSubcommand,
  projectRoot: string,
  error: unknown,
  presentation: PresentationSession,
  jsonMode: boolean,
  scope: GovernanceScope = 'activation'
): number {
  const result = {
    schemaVersion: 2,
    scope,
    command: `governance ${subcommand}`,
    projectRoot,
    readOnly: true,
    ok: false,
    nextActions: [],
    ...(subcommand === 'verify'
      ? {
          consistent: false,
          verificationStatus: 'inconsistent',
          complete: false,
          setupStatus: 'indeterminate',
          stateSource: 'unavailable',
          summary: 'Verification could not inspect governance state; setup completion is indeterminate.'
        }
      : {}),
    checks: [{
      id: 'inspection',
      status: 'failed',
      issues: [errorMessage(error)]
    }]
  };
  if (jsonMode) {
    json(presentation, result);
  } else {
    presentation.error(errorMessage(error), 'Fix the malformed governance file or restore it from version control, then rerun verification.');
  }
  return 1;
}

export function attachPresentation<T extends GovernanceInspection>(inspection: T, presentation: PresentationSession): T {
  (inspection as T & { presentation?: PresentationSession }).presentation = presentation;
  return inspection;
}

export function renderApplyNextHuman(
  result: ApplyNextPreview | ApplyNextExecutionResult,
  presentation: PresentationSession
): void {
  presentation.commandIdentity('governance apply-next', 'Controlled activation transition');
  presentation.status(
    result.applied ? 'success' : result.authorized ? 'pending' : 'error',
    result.reason,
    result.message
  );
  if (result.selectedPhase) {
    presentation.status('info', 'Selected phase', result.selectedPhase);
  }
  presentation.table('Proposed operations', ['Adapter', 'Action', 'Mutation', 'Remote', 'Destructive'], result.proposedMutations.operations.map((op) => [
    op.adapter,
    op.actionId,
    op.mutationClass,
    String(op.remote),
    String(op.destructive)
  ]));
  if ('executedOperations' in result) {
    presentation.table('Executed operations', ['Adapter', 'Action', 'Mutation'], result.executedOperations.map((op) => [
      op.adapter,
      op.actionId,
      op.mutationClass
    ]));
    if (result.savedPlan) {
      presentation.status('info', 'Saved plan', `${result.savedPlan.pathParts.join('/')} (${result.savedPlan.digest})`);
    }
    if (result.evidence) {
      presentation.status('info', 'Evidence', `${result.evidence.pathParts.join('/')} (${result.evidence.headerDigest})`);
    }
    if (result.stateHash) {
      presentation.status('info', 'State hash', result.stateHash);
    }
    if (result.executedPhase) {
      presentation.status(
        'info',
        'Next phase',
        'Run governance verify or status for post-transition readiness.'
      );
    }
  } else {
    presentation.status('info', 'Preview only', 'No writes occurred; rerun with --execute to execute at most one phase.');
  }
}
