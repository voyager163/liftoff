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
import { phaseScope } from '../domain/governance/activation/types.js';
import {
  phaseOrder, rollbackPlanFromCompletedOperations, phaseById, phaseUsesProvider, assertPlanOperationsAllowed,
  assertOperationAllowed, rollbackPlanForPhase, governanceTaskProjectionAction
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
import { executeAzurePhase } from './phase-azure.js';
import { executeGitHubPhase } from './phase-github.js';
import {
  assertOutcomeFileChanges, assertInputFileChanges, assertPlannedFilesAfter, snapshotWithPlannedWrites, verifiedGitInputBinding
} from './transition-files.js';
import { assertGovernanceApprovalIssued } from './authority-records.js';
import {
  approvalRequestForSavedPlan, authorityOperations, evaluateApprovalForTransitionPlan
} from '../domain/governance/activation/approvals.js';
import {
  blockedGovernanceTaskProjection, captureGovernanceTaskSource, prepareGovernanceTaskProjection,
  type CapturedGovernanceTaskSource
} from './task-writes.js';
import type { ActivationInputSnapshot } from '../domain/governance/activation/inputs.js';

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
  'enforcement-approved': () => ({ status: 'completed', resultState: 'approved', completedOperations: [] }),
  'credential-ready': executeCredentialReady,
  'remote-ready': remoteImportRetention,
  'bootstrap-state-disposed': executeBootstrapStateDisposal,
  'rulesets-applied': executeRulesetPhase,
  'live-readback': executeRulesetPhase
};

async function executeBuiltInPhase(input: PhaseAdapterExecutionInput, localRevalidation = false): Promise<PhaseAdapterOutcome> {
  if (localRevalidation) {
    const outcome = await executeSeedOperations(input, { localRevalidation: true });
    if (!outcome) throw new Error(`Local revalidation cannot execute ${input.phase.id}.`);
    return outcome;
  }
  const custom = input.adapters.phases?.[input.phase.id];
  if (custom) return await custom.execute(input);
  if (phaseScope(input.phase.id) === 'local') {
    const outcome = await executeSeedOperations(input);
    if (!outcome) throw new Error(`The local scope has no executor for ${input.phase.id}.`);
    return outcome;
  }
  const githubFirst = ['private-backend-proof', 'application-artifact-ready', 'staging-qualified', 'production-rehearsed'].includes(input.phase.id);
  const azurePhase = () => phaseUsesProvider(input.phase, 'azure') ? executeAzurePhase(input) : null;
  const githubPhase = () => phaseUsesProvider(input.phase, 'github') ? executeGitHubPhase(input) : null;
  const first = await (githubFirst ? githubPhase() : azurePhase());
  if (first && first.status !== 'completed') return first;
  const second = await (githubFirst ? azurePhase() : githubPhase());
  const azure = githubFirst ? second : first;
  const github = githubFirst ? first : second;
  if (azure || github) return combineProviderOutcomes(azure, github);
  return await builtInExecutors[input.phase.id]?.(input) ?? {
    status: 'blocked',
    blocker: `No production adapter is configured for ${input.phase.id}; refusing success-shaped fallback.`,
    completedOperations: []
  };
}

function combinePublicValues(left: unknown, right: unknown, path = 'provider outcome'): unknown {
  if (left === undefined) return right;
  if (right === undefined || canonicalSha256(left) === canonicalSha256(right)) return left;
  if (isRecord(left) && isRecord(right)) {
    return Object.fromEntries([...new Set([...Object.keys(left), ...Object.keys(right)])]
      .map((key) => [key, combinePublicValues(left[key], right[key], `${path}.${key}`)]));
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const combined = new Map<string, unknown>();
    for (const entry of [...left, ...right]) {
      const identity = isRecord(entry) && (typeof entry.id === 'string' || typeof entry.id === 'number')
        ? `id:${entry.id}` : canonicalSha256(entry);
      combined.set(identity, combined.has(identity)
        ? combinePublicValues(combined.get(identity), entry, `${path}[${identity}]`)
        : entry);
    }
    return [...combined.values()];
  }
  throw new Error(`Independent producers reported contradictory ${path}; no successful proof can be recorded.`);
}

function combineProviderOutcomes(azure: PhaseAdapterOutcome | null, github: PhaseAdapterOutcome | null): PhaseAdapterOutcome {
  if (!azure) return github!;
  if (!github) return azure;
  if (azure.stateOverride && github.stateOverride &&
    canonicalSha256(azure.stateOverride) !== canonicalSha256(github.stateOverride)) {
    throw new Error('Independent phase producers proposed conflicting activation state changes.');
  }
  if (azure.operation && github.operation) throw new Error('A phase cannot resume two independent external operations from one checkpoint.');
  if (azure.resultState && github.resultState && azure.resultState !== github.resultState) {
    throw new Error('Independent phase producers reported contradictory terminal results.');
  }
  const values = { ...azure.outputs?.values };
  for (const [key, value] of Object.entries(github.outputs?.values ?? {})) {
    if (Object.hasOwn(values, key) && values[key] !== value) {
      throw new Error(`Independent phase producers reported contradictory output binding ${key}.`);
    }
    values[key] = value;
  }
  return {
    status: azure.status === 'blocked' || github.status === 'blocked' ? 'blocked' :
      azure.status === 'pending' || github.status === 'pending' ? 'pending' : 'completed',
    resultState: github.resultState ?? azure.resultState,
    blocker: github.blocker ?? azure.blocker,
    evidencePayload: combinePublicValues(azure.evidencePayload, github.evidencePayload),
    liveReadback: [...azure.liveReadback ?? [], ...github.liveReadback ?? []],
    stateOverride: github.stateOverride ?? azure.stateOverride,
    operation: github.operation ?? azure.operation,
    outputs: azure.outputs && github.outputs ? {
      values,
      resources: [...azure.outputs.resources, ...github.outputs.resources]
    } : github.outputs ?? azure.outputs,
    completedOperations: [...azure.completedOperations ?? [], ...github.completedOperations ?? []],
    fileMutations: [...azure.fileMutations ?? [], ...github.fileMutations ?? []],
    filePreconditions: [...azure.filePreconditions ?? [], ...github.filePreconditions ?? []],
    cleanupWarnings: [...azure.cleanupWarnings ?? [], ...github.cleanupWarnings ?? []]
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

export interface ApplyNextExecutionInput {
  inspection: GovernanceTransitionInspection;
  reinspect: () => Promise<GovernanceTransitionInspection>;
  runner?: CommandRunner;
  adapters?: GovernanceTransitionAdapters;
  now?: Date;
  clock?: () => Date;
  localRevalidation?: boolean;
  assertReviewedPlan?: (plan: SavedTransitionPlan) => void | Promise<void>;
  assertProtectedInputs?: () => void | Promise<void>;
  reviewedPlan?: SavedTransitionPlan;
  recovery?: boolean;
  credentialEnrollment?: { protectedStdin: boolean };
}

export async function executeApplyNext(input: ApplyNextExecutionInput): Promise<ApplyNextExecutionResult> {
  validateManifestActivationForExecution(input.inspection.manifest);
  if (input.localRevalidation && (!input.inspection.loadedState || input.inspection.state.repository.id === 'unbound' ||
    !input.assertReviewedPlan || !input.assertProtectedInputs)) {
    throw new Error('Local revalidation requires a committed anchored v3 state and exact reviewed-plan/protected-input guards.');
  }
  return withProjectMutationLock(input.inspection.projectRoot, async (lease) => {
    await lease.assertHeld();
    await input.assertProtectedInputs?.();
    if (!input.inspection.loadedState && input.inspection.state.repository.id === 'unbound' &&
      input.inspection.readiness.nextReadyPhase?.startsWith('seed-')) {
      await initializeExecutionAnchor(input.inspection, input.now ?? input.clock?.() ?? new Date());
      input = { ...input, inspection: await input.reinspect() };
    }
    return executeApplyNextLocked(input, lease);
  });
}

async function executeApplyNextLocked(input: ApplyNextExecutionInput, lease: ProjectMutationLease): Promise<ApplyNextExecutionResult> {
  const runner = input.runner ?? new NodeCommandRunner();
  const adapters = input.adapters ?? {};
  const clock = () => input.now ?? input.clock?.() ?? new Date();
  const now = clock();
  const localRevalidation = input.localRevalidation ?? false;
  const initialPlan = await buildSavedTransitionPlan({
    inspection: input.inspection, runner, now, localRevalidation,
    ...(input.reviewedPlan ? { createdAt: input.reviewedPlan.createdAt } : {})
  });
  if (!initialPlan) {
    const preview = await previewApplyNext({ inspection: input.inspection, runner, now, execute: true, localRevalidation });
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
  if (input.reviewedPlan && (input.reviewedPlan.planDigest !== initialPlan.planDigest ||
    input.reviewedPlan.stateHash !== initialPlan.stateHash ||
    Date.parse(input.reviewedPlan.expiresAt) <= now.getTime())) {
    throw new Error('The reviewed preview expired or its inputs/operations changed; request a fresh plan before execution.');
  }
  const pendingOperation = input.inspection.state.phases[phase.id].operation;
  if (pendingOperation) {
    const checkpointDigest = pendingOperation.planDigest ?? input.inspection.state.phases[phase.id].executionPlanDigest;
    const dispatched = input.inspection.contexts[phase.id].reviewedPlans?.find((plan) => plan.planDigest === checkpointDigest);
    if (!dispatched || dispatched.phaseId !== phase.id || dispatched.scope !== initialPlan.scope ||
      (!input.recovery && canonicalSha256(authorityOperations(dispatched.operations)) !== canonicalSha256(authorityOperations(initialPlan.operations)))) {
      throw new Error('The pending external operation does not match this exact reviewed operation set; inspect and approve recovery.');
    }
  }
  if (initialPlan.approval.evaluation.approvalRequired) {
    const preview = await previewApplyNext({ inspection: input.inspection, runner, now, execute: true, localRevalidation });
    return {
      ...preview, applied: false, executedPhase: null, noWrites: false,
      executedOperations: [], evidence: null, stateHash: null, rollbackPlan: initialPlan.rollbackPlan, cleanupWarnings: []
    };
  }
  if (initialPlan.approval.required && initialPlan.approval.envelopeId) {
    const envelope = input.inspection.approvals.find((entry) => entry.id === initialPlan.approval.envelopeId);
    if (envelope) {
      await assertGovernanceApprovalIssued(input.inspection.projectRoot, envelope);
    }
  }
  await input.assertReviewedPlan?.(initialPlan);
  await input.assertProtectedInputs?.();
  const saved = await saveTransitionPlan(input.inspection.projectRoot, initialPlan);
  const freshInspection = await input.reinspect();
  const freshPlan = await buildSavedTransitionPlan({ inspection: freshInspection, runner, now, createdAt: initialPlan.createdAt, localRevalidation });
  const freshnessIssues = comparePlanFreshness(initialPlan, freshPlan);
  if (freshnessIssues.length > 0) {
    return {
      schemaVersion: 2, scope: input.inspection.scope, command: 'governance apply-next', projectRoot: input.inspection.projectRoot,
      execute: true, applied: false, authorized: false, reason: 'stale-after-plan-save', message: freshnessIssues.join(' '),
      selectedPhase: initialPlan.phaseId, executedPhase: null, nextReadyPhase: freshInspection.readiness.nextReadyPhase,
      approval: initialPlan.approval,
      proposedMutations: { local: initialPlan.mutationClasses.local, remote: initialPlan.mutationClasses.remote, operations: initialPlan.operations },
      savedPlan: saved, noWrites: false, blockers: freshnessIssues, executedOperations: [],
      evidence: null, stateHash: null, rollbackPlan: initialPlan.rollbackPlan, cleanupWarnings: []
    };
  }
  if (freshPlan) await input.assertReviewedPlan?.(freshPlan);
  await input.assertProtectedInputs?.();
  const taskSource = localRevalidation ? undefined : await captureGovernanceTaskSource(freshInspection, initialPlan);
  const sourceBlocker = sourceOfTruthAllowsPhase(freshInspection, initialPlan.phaseId);
  if (sourceBlocker) {
    const nextState = blockedState({ inspection: freshInspection, phase, plan: initialPlan, blocker: sourceBlocker, now });
    const write = await writeOutcomeTransaction({ projectRoot: freshInspection.projectRoot, plan: initialPlan, nextState });
    return executionBlockedResult(freshInspection, initialPlan, saved, sourceBlocker, [], write.stateHash);
  }
  await lease.assertHeld();
  const inputOptions = { sensitivePathExclusions: freshInspection.sensitivePathExclusions };
  const beforeSnapshot = await readActivationInputSnapshot(freshInspection.projectRoot, freshInspection.manifest, runner, inputOptions);
  let executionStateHash = initialPlan.stateHash;
  const readOnlyMutations = new Set(['none', 'read-worktree', 'github-read', 'azure-read', 'backend-state-read', 'write-evidence', 'write-activation-state', 'project-governance-tasks']);
  const executionStarted = phaseScope(phase.id) !== 'local' && initialPlan.operations.some((operation) =>
    (operation.remote || operation.effects?.some((effect) => effect.remote)) &&
    (!readOnlyMutations.has(operation.mutationClass) || operation.effects?.some((effect) => !readOnlyMutations.has(effect.mutationClass))));
  if (executionStarted) {
    const intent = nextStateForOutcome({
      inspection: freshInspection, phase, plan: initialPlan, resultState: 'running', now,
      ...(pendingOperation ? { operation: pendingOperation } : {})
    });
    executionStateHash = (await writeOutcomeTransaction({
      projectRoot: freshInspection.projectRoot, plan: initialPlan, nextState: intent
    })).stateHash;
    await lease.assertHeld();
  }
  const outcome = await executeBuiltInPhase({
    inspection: freshInspection, plan: initialPlan, phase, runner, adapters, now,
    clock, lease, recovery: input.recovery, credentialEnrollment: input.credentialEnrollment
  }, localRevalidation);
  await input.assertProtectedInputs?.();
  const completedOperations = outcome.completedOperations ?? [];
  if (outcome.operation && !initialPlan.operations.some((operation) => operation.actionId === outcome.operation!.actionId)) {
    throw new Error('The reported external operation has no corresponding action in the reviewed plan.');
  }
  for (const completed of completedOperations) {
    if (completed.actionId === governanceTaskProjectionAction) throw new Error('Adapters cannot claim the engine-owned post-outcome task projection.');
    assertOperationAllowed(phase, completed);
    if (!initialPlan.operations.some((planned) => canonicalSha256(planned) === canonicalSha256(completed))) {
      throw new Error(`Completed operation ${completed.actionId} was not in the reviewed plan.`);
    }
  }
  for (const mutation of outcome.fileMutations ?? []) {
    if (localRevalidation) throw new Error('Local revalidation cannot persist source, spec, or seed file mutations.');
    const allowed = initialPlan.operations.some((operation) => {
      const prefix = operation.destination.pathParts;
      return !operation.remote && prefix && prefix.every((part, index) => mutation.pathParts[index] === part) &&
        ['write-seed-tasks', 'write-openspec-governance', 'write-workflows', 'write-ruleset-source', 'write-credential-policy', 'delete-local-state'].includes(operation.mutationClass) &&
        (mutation.type !== 'delete' || operation.destructive && prefix.length === mutation.pathParts.length);
    });
    if (!allowed) throw new Error(`Outcome file mutation ${mutation.pathParts.join('/')} is outside the reviewed plan destinations.`);
  }
  assertOutcomeFileChanges(initialPlan, outcome.fileMutations ?? [], outcome.filePreconditions ?? []);
  const postSnapshot = await readActivationInputSnapshot(freshInspection.projectRoot, freshInspection.manifest, runner, inputOptions);
  try {
    assertInputFileChanges(beforeSnapshot, postSnapshot, initialPlan);
  } catch (error) {
    return executionBlockedResult(freshInspection, initialPlan, saved,
      'Relevant project inputs changed during execution; no outcome was persisted.', completedOperations,
      executionStateHash ?? '', outcome.cleanupWarnings ?? [], false);
  }
  const gitBinding = await verifiedGitInputBinding(beforeSnapshot.git, postSnapshot.git, initialPlan, freshInspection.projectRoot, runner);
  const effectiveSnapshot = snapshotWithPlannedWrites(postSnapshot, outcome.fileMutations ?? []);
  const afterInputDigest = phaseInputDigest(phase.id, effectiveSnapshot, freshInspection.state);
  if (outcome.status === 'pending') {
    if (!outcome.operation || outcome.operation.status !== 'running') {
      throw new Error('A pending phase must provide a concrete resumable external operation handle.');
    }
    const nextState = nextStateForOutcome({
      inspection: freshInspection, phase, plan: initialPlan, resultState: 'running', now: clock(),
      operation: { ...outcome.operation, planDigest: pendingOperation?.planDigest ?? initialPlan.planDigest }
    });
    const write = await persistWithTaskProjection({
      inspection: freshInspection, plan: initialPlan, nextState, source: taskSource, snapshot: postSnapshot, now: clock(),
      expectedStateHash: executionStateHash, projectCreation: false, fallbackState: nextState
    });
    return {
      ...executionBlockedResult(freshInspection, initialPlan, saved,
        outcome.blocker ?? `External operation ${outcome.operation.operationId} is running; resume polls this operation without redispatch.`,
        [...completedOperations, ...taskSource?.contract.source === 'existing' && !write.projectionFailure
          ? initialPlan.operations.filter((operation) => operation.actionId === governanceTaskProjectionAction) : []],
        write.stateHash, [...outcome.cleanupWarnings ?? [], ...(write.projectionFailure ? [write.projectionFailure] : [])]),
      reason: 'external-operation-pending', authorized: true, executedPhase: phase.id,
      nextReadyPhase: phase.id
    };
  }
  if (outcome.status === 'blocked') {
    const blocker = outcome.blocker ?? `Phase ${phase.id} blocked.`;
    if (outcome.retryableWithoutStateMutation) {
      if (outcome.operation || completedOperations.some((operation) =>
        operation.remote && !readOnlyMutations.has(operation.mutationClass) ||
        operation.effects?.some((effect) => effect.remote && !readOnlyMutations.has(effect.mutationClass)))) {
        throw new Error('A producer cannot request a state-free retry after reporting remote writes or an external operation handle.');
      }
      const stateHash = executionStarted
        ? (await writeOutcomeTransaction({
          projectRoot: freshInspection.projectRoot, plan: initialPlan, nextState: freshInspection.state,
          expectedStateHash: executionStateHash
        })).stateHash
        : executionStateHash ?? activationStateContentHash(canonicalJson(freshInspection.state));
      return executionBlockedResult(freshInspection, initialPlan, saved, blocker, completedOperations, stateHash, outcome.cleanupWarnings ?? [], executionStarted);
    }
    const nextState = blockedState({
      inspection: freshInspection, phase, plan: initialPlan, blocker, now,
      executionStarted, ...(outcome.operation ? {
        operation: { ...outcome.operation, planDigest: pendingOperation?.planDigest ?? initialPlan.planDigest }
      } : {})
    });
    const write = await persistWithTaskProjection({
      inspection: freshInspection, plan: initialPlan, nextState, source: taskSource, snapshot: postSnapshot, now: clock(),
      expectedStateHash: executionStateHash, projectCreation: false, fallbackState: nextState
    });
    return executionBlockedResult(freshInspection, initialPlan, saved, blocker,
      [...completedOperations, ...taskSource?.contract.source === 'existing' && !write.projectionFailure
        ? initialPlan.operations.filter((operation) => operation.actionId === governanceTaskProjectionAction) : []], write.stateHash,
      [...outcome.cleanupWarnings ?? [], ...(write.projectionFailure ? [write.projectionFailure] : [])]);
  }
  const resultState = outcome.resultState ?? 'verified';
  await assertPlannedFilesAfter(freshInspection.projectRoot, initialPlan, outcome.fileMutations ?? []);
  if (!(phase.terminalStates as readonly string[]).includes(resultState)) {
    const blocker = `Phase adapter returned ${resultState}, which is not an allowed terminal state for ${phase.id}.`;
    const nextState = blockedState({ inspection: freshInspection, phase, plan: initialPlan, blocker, now, executionStarted, operation: outcome.operation });
    const write = await writeOutcomeTransaction({ projectRoot: freshInspection.projectRoot, plan: initialPlan, nextState, expectedStateHash: executionStateHash });
    return executionBlockedResult(freshInspection, initialPlan, saved, blocker, completedOperations, write.stateHash, outcome.cleanupWarnings ?? []);
  }
  if (outcome.stateOverride && outcome.stateOverride.repository.id !== freshInspection.state.repository.id) {
    throw new Error('A phase outcome must not replace the immutable local execution anchor.');
  }
  if (outcome.stateOverride) {
    if (canonicalSha256(outcome.stateOverride.successorHistory ?? null) !== canonicalSha256(freshInspection.state.successorHistory ?? null) ||
      outcome.stateOverride.baselineAnchor !== freshInspection.state.baselineAnchor ||
      canonicalSha256(outcome.stateOverride.taskProjection ?? null) !== canonicalSha256(freshInspection.state.taskProjection ?? null)) {
      throw new Error('A phase adapter cannot replace immutable execution-baseline/successor-history bindings or engine-owned task-projection records.');
    }
    if (canonicalSha256(outcome.stateOverride.phases) !== canonicalSha256(freshInspection.state.phases)) {
      throw new Error('A phase adapter cannot rewrite authoritative phase history or unrelated phase states.');
    }
    if (phase.id !== 'phase-0-complete' && phase.id !== 'pushed' &&
      canonicalSha256(outcome.stateOverride.remoteBinding ?? null) !== canonicalSha256(freshInspection.state.remoteBinding ?? null)) {
      throw new Error('Only verified Phase 0 discovery or publication may establish a remote repository binding.');
    }
  }
  if (phase.approvalGate.required) {
    const finalInspection = await input.reinspect();
    const finalApproval = evaluateApprovalForTransitionPlan(
      approvalRequestForSavedPlan(initialPlan, phase, finalInspection.state), finalInspection.approvals, { now: clock() }
    );
    if (finalApproval.approvalRequired || finalApproval.envelopeHash !== initialPlan.approval.envelopeHash) {
      return executionBlockedResult(freshInspection, initialPlan, saved,
        'Approval changed or expired before outcome persistence; no successful outcome was recorded.', completedOperations,
        executionStateHash ?? '', outcome.cleanupWarnings ?? [], false);
    }
  }
  const outcomeInspection = { ...freshInspection, state: outcome.stateOverride ?? freshInspection.state };
  const boundPayload = isRecord(outcome.evidencePayload)
    ? { ...outcome.evidencePayload, planDigest: initialPlan.planDigest, savedPlanDigest: canonicalSha256(initialPlan),
      ...(outcome.outputs ? { outputBindings: outcome.outputs } : {}) }
    : outcome.evidencePayload;
  const outcomeNow = clock();
  let evidenceRecord: PhaseEvidenceRecord | undefined;
  let evidenceParts: readonly string[] | undefined;
  let evidenceReference: UserActivationState['phases'][PhaseId]['evidence'][number] | undefined;
  if (resultState !== 'approved') {
    const evidenceId = `${phase.id}-${safeTimestamp(now.toISOString())}`;
    const header = evidenceHeaderFor({
      inspection: outcomeInspection, phase, plan: initialPlan, result: resultState, now: outcomeNow,
      payload: boundPayload, liveReadback: outcome.liveReadback, afterInputDigest, gitBinding
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
      inputDigest: (initialPlan.fileChanges?.length || gitBinding) ? afterInputDigest : initialPlan.inputDigest,
      remoteBindingDigest: remoteBindingDigest(outcomeInspection.state.remoteBinding),
      evidenceReferences: [evidenceReference], reviewedPlans: [initialPlan],
      ...(phase.id === 'seed-archived' && postSnapshot.workflowSpecDigest ? { workflowSpecDigest: postSnapshot.workflowSpecDigest } : {}),
      now: outcomeNow
    });
    if (!validation.valid) {
      return executionBlockedResult(freshInspection, initialPlan, saved,
        `Completed outcome rejected: ${validation.issues.map((issue) => issue.message).join(' ')}`,
        completedOperations, executionStateHash ?? '', outcome.cleanupWarnings ?? [], false);
    }
  }
  const nextState = nextStateForOutcome({
    inspection: freshInspection, phase, plan: initialPlan, resultState,
    evidenceReference, override: outcome.stateOverride, now: outcomeNow, outputs: outcome.outputs
  });
  await input.assertProtectedInputs?.();
  const write = await persistWithTaskProjection({
    inspection: outcomeInspection, plan: initialPlan, nextState, source: taskSource, snapshot: effectiveSnapshot, now: outcomeNow,
    evidenceRecord, evidencePathParts: evidenceParts, fileMutations: outcome.fileMutations, filePreconditions: outcome.filePreconditions,
    expectedStateHash: executionStateHash, projectCreation: true,
    fallbackState: blockedState({
      inspection: freshInspection, phase, plan: initialPlan, blocker: 'Current task projection did not commit.',
      now: outcomeNow, executionStarted, operation: outcome.operation
    })
  });
  if (write.projectionFailure) {
    return executionBlockedResult(freshInspection, initialPlan, saved, write.projectionFailure,
      completedOperations, write.stateHash, [...outcome.cleanupWarnings ?? [], 'No successful phase or task projection was claimed; inspect and approve recovery of any completed external effects.']);
  }
  await input.assertProtectedInputs?.();
  const rollbackPlan = rollbackPlanForPhase(phase, completedOperations);
  const completedInspection = await input.reinspect();
  return {
    schemaVersion: 2, scope: freshInspection.scope, command: 'governance apply-next', projectRoot: freshInspection.projectRoot,
    execute: true, applied: true, authorized: true, reason: 'phase-executed',
    message: `Executed one phase: ${phase.id}.`, selectedPhase: phase.id, executedPhase: phase.id,
    nextReadyPhase: completedInspection.readiness.nextReadyPhase, approval: initialPlan.approval,
    proposedMutations: { local: initialPlan.mutationClasses.local, remote: initialPlan.mutationClasses.remote, operations: initialPlan.operations },
    savedPlan: saved, noWrites: false, blockers: [],
    executedOperations: [...completedOperations,
      ...(taskSource ? initialPlan.operations.filter((operation) => operation.actionId === governanceTaskProjectionAction) : []),
      ...(evidenceParts ? [evidenceWriteOperation(phase, evidenceParts)] : []), stateWriteOperation(phase)],
    evidence: write.evidence, stateHash: write.stateHash, rollbackPlan,
    cleanupWarnings: [...rollbackPlan.cleanupWarnings, ...(outcome.cleanupWarnings ?? [])]
  };
}

async function persistWithTaskProjection(input: {
  inspection: GovernanceTransitionInspection; plan: SavedTransitionPlan; nextState: UserActivationState;
  source?: CapturedGovernanceTaskSource; snapshot: ActivationInputSnapshot; now: Date;
  fallbackState: UserActivationState; expectedStateHash: string | null; projectCreation: boolean;
  evidenceRecord?: PhaseEvidenceRecord; evidencePathParts?: readonly string[];
  fileMutations?: Parameters<typeof writeOutcomeTransaction>[0]['fileMutations'];
  filePreconditions?: Parameters<typeof writeOutcomeTransaction>[0]['filePreconditions'];
}): Promise<Awaited<ReturnType<typeof writeOutcomeTransaction>> & { projectionFailure?: string }> {
  const write = {
    projectRoot: input.inspection.projectRoot, plan: input.plan, nextState: input.nextState,
    evidenceRecord: input.evidenceRecord, evidencePathParts: input.evidencePathParts,
    fileMutations: input.fileMutations, filePreconditions: input.filePreconditions,
    expectedStateHash: input.expectedStateHash
  };
  if (!input.source || input.source.contract.source === 'create' && !input.projectCreation) return writeOutcomeTransaction(write);
  try {
    const projection = await prepareGovernanceTaskProjection({ ...input, source: input.source });
    return await writeOutcomeTransaction({
      ...write, nextState: { ...input.nextState, taskProjection: projection.record }, taskProjection: projection
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const projectionFailure = `Current task/record projection was blocked: ${detail}`;
    const record = blockedGovernanceTaskProjection(input.plan, input.now, projectionFailure);
    const fallback = {
      ...input.fallbackState, taskProjection: record,
      phases: {
        ...input.fallbackState.phases,
        [input.plan.phaseId]: {
          ...input.fallbackState.phases[input.plan.phaseId],
          blockers: [...input.fallbackState.phases[input.plan.phaseId].blockers, projectionFailure]
        }
      }
    };
    try {
      return {
        ...await writeOutcomeTransaction({
          projectRoot: input.inspection.projectRoot, plan: input.plan,
          nextState: fallback, expectedStateHash: input.expectedStateHash
        }), projectionFailure
      };
    } catch (checkpointError) {
      throw new Error(`${projectionFailure} The execution checkpoint could not be persisted: ${checkpointError instanceof Error ? checkpointError.message : String(checkpointError)}. Preserve current files and inspect the reviewed operation before retrying.`);
    }
  }
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
    schemaVersion: 2, scope: inspection.scope, command: 'governance apply-next', projectRoot: inspection.projectRoot,
    execute: true, applied: false, authorized: false, reason: 'blocked', message: blocker,
    selectedPhase: plan.phaseId, executedPhase: null, nextReadyPhase: inspection.readiness.nextReadyPhase, approval: plan.approval,
    proposedMutations: { local: plan.mutationClasses.local, remote: plan.mutationClasses.remote, operations: plan.operations },
    savedPlan: saved, noWrites: false, blockers: [blocker],
    executedOperations: [...completedOperations, ...(stateWritten ? [stateWriteOperation(phase)] : [])],
    evidence: null, stateHash: stateHashValue, rollbackPlan,
    cleanupWarnings: [...rollbackPlan.cleanupWarnings, ...cleanupWarnings]
  };
}
