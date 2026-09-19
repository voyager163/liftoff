import type { PresentationSession } from '../../terminal.js';
import { detectCredentialLeaks } from '../../governance-activation/credentials.js';
import { type ApplyNextExecutionResult, type ApplyNextPreview, type PhaseReviewRequest } from '../../governance-activation/transitions.js';
import { phaseInScope, runnerPreflightProviderReadDisclosure, type GovernanceScope, type SavedTransitionPlan } from '../../domain/governance/activation/types.js';
import type { GovernanceSubcommand, GovernanceInspection, GovernanceMigrationSummary } from '../../application/repository-governance/inspection-contracts.js';
import { errorMessage, phaseMap } from '../../application/repository-governance/inspection.js';
import { verificationPhaseIds } from '../../application/repository-governance/progress.js';
import { approvalEvaluationForPhase, summarizeMigration } from '../../application/repository-governance/reporting.js';
import { verifyJson } from '../../application/repository-governance/verification.js';

function publicOutputText(value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const scan = detectCredentialLeaks([{ source: 'generated-artifact', label: 'governance command output', text }]);
  if (scan.status === 'compromised') {
    throw new Error('Governance output contained credential-shaped data and was withheld; inspect the protected execution checkpoint.');
  }
  return text;
}

export function json(presentation: PresentationSession, value: unknown): void {
  presentation.rawStdout(publicOutputText(value));
}

function renderPhaseReviewsHuman(reviews: readonly PhaseReviewRequest[], presentation: PresentationSession): void {
  if (!reviews.length) return;
  publicOutputText(reviews);
  presentation.table('Settled stages awaiting review', ['Phase', 'Review', 'Original plan'], reviews.map((review) => [
    review.phaseId, review.kind, review.sourcePlanDigest
  ]));
  presentation.status(
    'pending',
    'Phase incomplete',
    'The stage is settled, not the phase. Use --json to inspect its retained public review payload. Supply the next-stage inputs, request a fresh plan, and approve that exact plan; prior-stage approval does not authorize it.'
  );
}

export function renderMigrationHuman(
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

export function renderStatusHuman(inspection: GovernanceInspection, command: GovernanceSubcommand, presentation: PresentationSession): void {
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
  renderPhaseReviewsHuman(inspection.reviews ?? [], presentation);
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
  const blockerRows = verificationPhaseIds(inspection)
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

export function renderCredentialPermissionReview(plan: SavedTransitionPlan, presentation: PresentationSession): void {
  if (plan.phaseId !== 'credential-ready') return;
  const operations = publicOutputText(plan.operations);
  presentation.status('pending', 'Broader provider read scope',
    `${runnerPreflightProviderReadDisclosure.permission} includes ${runnerPreflightProviderReadDisclosure.readCategories.join(', ')} reads, not hosted-runners-only access. Only the exact reviewed endpoints and resources may be used.`);
  presentation.definitions('Exact credential review', [
    { label: 'Policy / credential schema', value: `${plan.identity.policyVersion} / ${plan.identity.credentialPolicySchemaVersion}` },
    { label: 'Plan', value: plan.planDigest },
    { label: 'Expires', value: plan.expiresAt },
    { label: 'Reviewed operations and grants', value: operations }
  ]);
  presentation.status('pending', 'Separate approval required',
    'This disclosure is not approval. Original policy or prior-stage approval cannot authorize these operations; approve this exact current plan separately.');
}

export function renderPlanHuman(inspection: GovernanceInspection, presentation: PresentationSession, plan?: SavedTransitionPlan): void {
  presentation.commandIdentity('governance plan', `Project-read-only ${inspection.scope} transition plan`);
  const scopedPhases = inspection.graph.graph.phases.filter((phase) => phaseInScope(phase.id, inspection.scope, true));
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
  renderPhaseReviewsHuman(inspection.reviews ?? [], presentation);
  if (plan) renderCredentialPermissionReview(plan, presentation);
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
  return result.consistent ? result.complete ? 0 : 2 : 1;
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
    schemaVersion: 3,
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

export function renderApplyNextHuman(
  result: ApplyNextPreview | ApplyNextExecutionResult,
  presentation: PresentationSession
): void {
  publicOutputText(result);
  presentation.commandIdentity('governance apply-next', 'Controlled activation transition');
  presentation.status(
    result.reason === 'phase-review-required' ? 'pending' : result.applied ? 'success' : result.authorized ? 'pending' : 'error',
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
    if (result.review) {
      renderPhaseReviewsHuman([result.review], presentation);
    }
    if (result.executedPhase && result.phaseComplete !== false) {
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
