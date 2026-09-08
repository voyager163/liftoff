import type {
  PhaseAdapterExecutionInput, PhaseAdapterOutcome, GovernanceTransitionInspection,
  GovernanceTransitionAdapters, ApplyNextExecutionResult
} from './transition-ports.js';
import { executeSeedOperations } from './seed-lifecycle.js';
import { executeGitOperations } from './phase-publication.js';
import { discoverPhase0 } from './phase-discovery.js';
import { executeActivationApproval, executeCredentialReady, executeRulesetPhase } from './phase-governance.js';
import { remoteImportRetention, executeBootstrapStateDisposal } from './phase-bootstrap-state.js';
import type { PhaseId, PhaseEvidenceRecord, UserActivationState, SavedTransitionPlan, TransitionOperation } from '../domain/governance/activation/types.js';
import {
  phaseOrder, rollbackPlanFromCompletedOperations, phaseById, assertPlanOperationsAllowed,
  assertOperationAllowed, rollbackPlanForPhase
} from '../domain/governance/activation/operations.js';
import { type CommandRunner, NodeCommandRunner } from '../process-runner.js';
import { validateManifestActivationForExecution } from '../domain/governance/activation/validators.js';
import { withProjectMutationLock, type ProjectMutationLease } from '../adapters/filesystem/project-lock.js';
import {
  initializeExecutionAnchor, saveTransitionPlan, blockedState, writeOutcomeTransaction,
  safeTimestamp, evidenceHeaderFor, evidencePathParts, nextStateForOutcome, evidenceWriteOperation, stateWriteOperation
} from './transition-records.js';
import { canonicalJson, canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { buildSavedTransitionPlan, previewApplyNext, comparePlanFreshness } from './transition-planning.js';
import { readActivationInputSnapshot, phaseInputDigest, remoteBindingDigest } from './inputs.js';
import { activationStateContentHash } from './activation-state.js';
import { evidenceHeaderDigest, validateEvidenceFreshness } from '../domain/governance/activation/evidence.js';

export type * from './transition-ports.js';
export { governancePlanDirectoryPathParts, transitionPlanPathParts } from './transition-records.js';
export { buildSavedTransitionPlan, previewApplyNext } from './transition-planning.js';
export { rollbackPlanFromCompletedOperations, planDigestFor } from '../domain/governance/activation/operations.js';

type PhaseExecutor = (input: PhaseAdapterExecutionInput) => PhaseAdapterOutcome | null | Promise<PhaseAdapterOutcome | null>;

const builtInExecutors: Partial<Record<PhaseId, PhaseExecutor>> = {
  'seed-valid': executeSeedOperations,
  'seed-verified': executeSeedOperations,
  'seed-archived': executeSeedOperations,
  committed: executeGitOperations,
  pushed: executeGitOperations,
  'phase-0-complete': discoverPhase0,
  'activation-approved': executeActivationApproval,
  'credential-ready': executeCredentialReady,
  'remote-ready': remoteImportRetention,
  'bootstrap-state-disposed': executeBootstrapStateDisposal,
  'rulesets-applied': executeRulesetPhase,
  'live-readback': executeRulesetPhase
};

async function executeBuiltInPhase(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  const custom = input.adapters.phases?.[input.phase.id];
  if (custom) return await custom.execute(input);
  return await builtInExecutors[input.phase.id]?.(input) ?? {
    status: 'blocked',
    blocker: `No production adapter is configured for ${input.phase.id}; refusing success-shaped fallback.`,
    completedOperations: []
  };
}

function sourceOfTruthAllowsPhase(inspection: GovernanceTransitionInspection, phaseId: PhaseId): string | null {
  if (phaseOrder(phaseId) <= phaseOrder('phase-0-complete')) return null;
  const source = inspection.sourceOfTruth;
  if (phaseId === 'activation-approved' && (source.status === 'none' || source.status === 'selected')) return null;
  if (source.status === 'selected' && source.reconciliation.status === 'not-required') return null;
  if (source.status === 'seed-blocked' || source.status === 'ambiguous' || source.status === 'incompatible') return source.blockers.join('; ');
  if (source.status === 'none') return source.createPlan.reason;
  return 'Active governance source of truth is not ready.';
}

export async function executeApplyNext(input: {
  inspection: GovernanceTransitionInspection;
  reinspect: () => Promise<GovernanceTransitionInspection>;
  runner?: CommandRunner;
  adapters?: GovernanceTransitionAdapters;
  now?: Date;
}): Promise<ApplyNextExecutionResult> {
  validateManifestActivationForExecution(input.inspection.manifest);
  return withProjectMutationLock(input.inspection.projectRoot, async (lease) => {
    await lease.assertHeld();
    if (!input.inspection.loadedState && input.inspection.state.repository.id === 'unbound' &&
      input.inspection.readiness.nextReadyPhase?.startsWith('seed-')) {
      await initializeExecutionAnchor(input.inspection, input.now ?? new Date());
      input = { ...input, inspection: await input.reinspect() };
    }
    return executeApplyNextLocked(input, lease);
  });
}

async function executeApplyNextLocked(input: {
  inspection: GovernanceTransitionInspection;
  reinspect: () => Promise<GovernanceTransitionInspection>;
  runner?: CommandRunner;
  adapters?: GovernanceTransitionAdapters;
  now?: Date;
}, lease: ProjectMutationLease): Promise<ApplyNextExecutionResult> {
  const runner = input.runner ?? new NodeCommandRunner();
  const adapters = input.adapters ?? {};
  const now = input.now ?? new Date();
  const initialPlan = await buildSavedTransitionPlan({ inspection: input.inspection, runner, now });
  if (!initialPlan) {
    const preview = await previewApplyNext({ inspection: input.inspection, runner, now, execute: true });
    return {
      ...preview,
      applied: false,
      executedPhase: null,
      noWrites: false,
      executedOperations: [],
      evidence: null,
      stateHash: null,
      rollbackPlan: rollbackPlanFromCompletedOperations(input.inspection.readiness.nextReadyPhase ?? 'seed-valid', 'none', null, []),
      cleanupWarnings: []
    };
  }
  const phase = phaseById(input.inspection.graph, initialPlan.phaseId);
  assertPlanOperationsAllowed(initialPlan, phase);
  if (initialPlan.approval.evaluation.approvalRequired) {
    const preview = await previewApplyNext({ inspection: input.inspection, runner, now, execute: true });
    return {
      ...preview, applied: false, executedPhase: null, noWrites: false,
      executedOperations: [], evidence: null, stateHash: null, rollbackPlan: initialPlan.rollbackPlan, cleanupWarnings: []
    };
  }
  const saved = await saveTransitionPlan(input.inspection.projectRoot, initialPlan);
  const freshInspection = await input.reinspect();
  const freshPlan = await buildSavedTransitionPlan({ inspection: freshInspection, runner, now });
  const freshnessIssues = comparePlanFreshness(initialPlan, freshPlan);
  if (freshnessIssues.length > 0) {
    return {
      schemaVersion: 1, command: 'governance apply-next', projectRoot: input.inspection.projectRoot,
      execute: true, applied: false, authorized: false, reason: 'stale-after-plan-save', message: freshnessIssues.join(' '),
      selectedPhase: initialPlan.phaseId, executedPhase: null, nextReadyPhase: freshInspection.readiness.nextReadyPhase,
      approval: initialPlan.approval,
      proposedMutations: { local: initialPlan.mutationClasses.local, remote: initialPlan.mutationClasses.remote, operations: initialPlan.operations },
      savedPlan: saved, noWrites: false, blockers: freshnessIssues, executedOperations: [],
      evidence: null, stateHash: null, rollbackPlan: initialPlan.rollbackPlan, cleanupWarnings: []
    };
  }
  const sourceBlocker = sourceOfTruthAllowsPhase(freshInspection, initialPlan.phaseId);
  if (sourceBlocker) {
    const nextState = blockedState({ inspection: freshInspection, phase, plan: initialPlan, blocker: sourceBlocker, now });
    const write = await writeOutcomeTransaction({ projectRoot: freshInspection.projectRoot, plan: initialPlan, nextState });
    return executionBlockedResult(freshInspection, initialPlan, saved, sourceBlocker, [], write.stateHash);
  }
  await lease.assertHeld();
  const outcome = await executeBuiltInPhase({
    inspection: freshInspection, plan: initialPlan, phase, runner, adapters, now,
    clock: () => input.now ?? new Date(), lease
  });
  const completedOperations = outcome.completedOperations ?? [];
  for (const completed of completedOperations) {
    assertOperationAllowed(phase, completed);
    if (!initialPlan.operations.some((planned) => canonicalSha256(planned) === canonicalSha256(completed))) {
      throw new Error(`Completed operation ${completed.actionId} was not in the reviewed plan.`);
    }
  }
  for (const mutation of outcome.fileMutations ?? []) {
    const allowed = initialPlan.operations.some((operation) => {
      const prefix = operation.destination.pathParts;
      return !operation.remote && prefix && prefix.every((part, index) => mutation.pathParts[index] === part) &&
        ['write-seed-tasks', 'write-openspec-governance', 'write-workflows', 'write-ruleset-source', 'delete-local-state'].includes(operation.mutationClass) &&
        (mutation.type !== 'delete' || operation.destructive && prefix.length === mutation.pathParts.length);
    });
    if (!allowed) throw new Error(`Outcome file mutation ${mutation.pathParts.join('/')} is outside the reviewed plan destinations.`);
  }
  const postSnapshot = await readActivationInputSnapshot(freshInspection.projectRoot, freshInspection.manifest, runner);
  if (postSnapshot.baselineSha !== initialPlan.baselineDigest || phaseInputDigest(phase.id, postSnapshot) !== initialPlan.inputDigest) {
    return executionBlockedResult(freshInspection, initialPlan, saved,
      'Relevant project inputs changed during execution; no outcome was persisted.', completedOperations,
      freshInspection.loadedState?.contentHash ?? '', outcome.cleanupWarnings ?? [], false);
  }
  if (outcome.status === 'blocked') {
    const blocker = outcome.blocker ?? `Phase ${phase.id} blocked.`;
    if (outcome.retryableWithoutStateMutation) {
      const stateHash = freshInspection.loadedState?.contentHash ?? activationStateContentHash(canonicalJson(freshInspection.state));
      return executionBlockedResult(freshInspection, initialPlan, saved, blocker, completedOperations, stateHash, outcome.cleanupWarnings ?? [], false);
    }
    const nextState = blockedState({ inspection: freshInspection, phase, plan: initialPlan, blocker, now });
    const write = await writeOutcomeTransaction({ projectRoot: freshInspection.projectRoot, plan: initialPlan, nextState });
    return executionBlockedResult(freshInspection, initialPlan, saved, blocker, completedOperations, write.stateHash, outcome.cleanupWarnings ?? []);
  }
  const resultState = outcome.resultState ?? 'verified';
  if (!(phase.terminalStates as readonly string[]).includes(resultState)) {
    const blocker = `Phase adapter returned ${resultState}, which is not an allowed terminal state for ${phase.id}.`;
    const nextState = blockedState({ inspection: freshInspection, phase, plan: initialPlan, blocker, now });
    const write = await writeOutcomeTransaction({ projectRoot: freshInspection.projectRoot, plan: initialPlan, nextState });
    return executionBlockedResult(freshInspection, initialPlan, saved, blocker, completedOperations, write.stateHash, outcome.cleanupWarnings ?? []);
  }
  if (outcome.stateOverride && outcome.stateOverride.repository.id !== freshInspection.state.repository.id) {
    throw new Error('A phase outcome must not replace the immutable local execution anchor.');
  }
  if (outcome.stateOverride) {
    if (canonicalSha256(outcome.stateOverride.phases) !== canonicalSha256(freshInspection.state.phases)) {
      throw new Error('A phase adapter cannot rewrite authoritative phase history or unrelated phase states.');
    }
    if (phase.id !== 'phase-0-complete' &&
      canonicalSha256(outcome.stateOverride.remoteBinding ?? null) !== canonicalSha256(freshInspection.state.remoteBinding ?? null)) {
      throw new Error('Only verified Phase 0 discovery may establish a remote repository binding.');
    }
  }
  if (phase.approvalGate.required) {
    const finalInspection = await input.reinspect();
    const finalPlan = await buildSavedTransitionPlan({ inspection: finalInspection, runner, now: input.now ?? new Date() });
    if (!finalPlan || finalPlan.phaseId !== phase.id || finalPlan.approval.evaluation.approvalRequired ||
      finalPlan.approval.envelopeHash !== initialPlan.approval.envelopeHash) {
      return executionBlockedResult(freshInspection, initialPlan, saved,
        'Approval changed or expired before outcome persistence; no successful outcome was recorded.', completedOperations,
        freshInspection.loadedState?.contentHash ?? '', outcome.cleanupWarnings ?? [], false);
    }
  }
  const outcomeInspection = { ...freshInspection, state: outcome.stateOverride ?? freshInspection.state };
  const boundPayload = isRecord(outcome.evidencePayload)
    ? { ...outcome.evidencePayload, planDigest: initialPlan.planDigest, savedPlanDigest: canonicalSha256(initialPlan) }
    : outcome.evidencePayload;
  const outcomeNow = input.now ?? new Date();
  let evidenceRecord: PhaseEvidenceRecord | undefined;
  let evidenceParts: readonly string[] | undefined;
  let evidenceReference: UserActivationState['phases'][PhaseId]['evidence'][number] | undefined;
  if (resultState !== 'approved') {
    const evidenceId = `${phase.id}-${safeTimestamp(now.toISOString())}`;
    const header = evidenceHeaderFor({
      inspection: outcomeInspection, phase, plan: initialPlan, result: resultState, now: outcomeNow,
      payload: boundPayload, liveReadback: outcome.liveReadback
    });
    evidenceRecord = {
      evidenceId, header,
      ...(outcome.liveReadback ? { liveReadback: outcome.liveReadback } : {}),
      ...(boundPayload !== undefined ? { payload: boundPayload } : {})
    };
    evidenceParts = evidencePathParts(evidenceId);
    evidenceReference = { phaseId: phase.id, evidenceId, headerDigest: evidenceHeaderDigest(header), result: header.result };
    const validation = validateEvidenceFreshness(evidenceRecord, {
      ...freshInspection.contexts[phase.id],
      remoteBindingDigest: remoteBindingDigest(outcomeInspection.state.remoteBinding),
      evidenceReferences: [evidenceReference], reviewedPlans: [initialPlan],
      ...(phase.id === 'seed-archived' && postSnapshot.workflowSpecDigest ? { workflowSpecDigest: postSnapshot.workflowSpecDigest } : {}),
      now: outcomeNow
    });
    if (!validation.valid) {
      return executionBlockedResult(freshInspection, initialPlan, saved,
        `Completed outcome rejected: ${validation.issues.map((issue) => issue.message).join(' ')}`,
        completedOperations, freshInspection.loadedState?.contentHash ?? '', outcome.cleanupWarnings ?? [], false);
    }
  }
  const nextState = nextStateForOutcome({
    inspection: freshInspection, phase, plan: initialPlan, resultState,
    evidenceReference, override: outcome.stateOverride, now
  });
  const write = await writeOutcomeTransaction({
    projectRoot: freshInspection.projectRoot, plan: initialPlan, nextState, evidenceRecord,
    evidencePathParts: evidenceParts, fileMutations: outcome.fileMutations, filePreconditions: outcome.filePreconditions
  });
  const rollbackPlan = rollbackPlanForPhase(phase, completedOperations);
  return {
    schemaVersion: 1, command: 'governance apply-next', projectRoot: freshInspection.projectRoot,
    execute: true, applied: true, authorized: true, reason: 'phase-executed',
    message: `Executed one phase: ${phase.id}.`, selectedPhase: phase.id, executedPhase: phase.id,
    nextReadyPhase: phase.id, approval: initialPlan.approval,
    proposedMutations: { local: initialPlan.mutationClasses.local, remote: initialPlan.mutationClasses.remote, operations: initialPlan.operations },
    savedPlan: saved, noWrites: false, blockers: [],
    executedOperations: [...completedOperations, ...(evidenceParts ? [evidenceWriteOperation(phase, evidenceParts)] : []), stateWriteOperation(phase)],
    evidence: write.evidence, stateHash: write.stateHash, rollbackPlan,
    cleanupWarnings: [...rollbackPlan.cleanupWarnings, ...(outcome.cleanupWarnings ?? [])]
  };
}

function executionBlockedResult(
  inspection: GovernanceTransitionInspection,
  plan: SavedTransitionPlan,
  saved: { pathParts: readonly string[]; digest: string },
  blocker: string,
  completedOperations: readonly TransitionOperation[],
  stateHashValue: string,
  cleanupWarnings: readonly string[] = [],
  stateWritten = true
): ApplyNextExecutionResult {
  const phase = phaseById(inspection.graph, plan.phaseId);
  const rollbackPlan = rollbackPlanForPhase(phase, completedOperations);
  return {
    schemaVersion: 1, command: 'governance apply-next', projectRoot: inspection.projectRoot,
    execute: true, applied: false, authorized: false, reason: 'blocked', message: blocker,
    selectedPhase: plan.phaseId, executedPhase: null, nextReadyPhase: plan.phaseId, approval: plan.approval,
    proposedMutations: { local: plan.mutationClasses.local, remote: plan.mutationClasses.remote, operations: plan.operations },
    savedPlan: saved, noWrites: false, blockers: [blocker],
    executedOperations: [...completedOperations, ...(stateWritten ? [stateWriteOperation(phase)] : [])],
    evidence: null, stateHash: stateHashValue, rollbackPlan,
    cleanupWarnings: [...rollbackPlan.cleanupWarnings, ...cleanupWarnings]
  };
}
