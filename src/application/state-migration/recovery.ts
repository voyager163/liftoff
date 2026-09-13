import {
  type BuildStateRecoveryPlanRequest,
  type ExecuteStateRecoveryRequest,
  type InspectStateMigrationRequest,
  type StateArtifactDescriptor,
  type StateExecutionContext,
  type StateInspectionRecord,
  type StateMigrationDependencies,
  type StateMigrationJournal,
  type StateMigrationResult,
  type StateRecoveryPlan,
  type StateRecoveryResult
} from '../../domain/repair/stateful.js';
import {
  stateAssert, stateContentMatches, stateFailure, stateObjectDigest, stateSnapshotMatches
} from '../../domain/repair/stateful-invariants.js';
import { hasQuarantinedStateOperation, migrationResult, StateMigrationProtocol } from './execution.js';
import { StateMigrationRuntime, statePlanFingerprint } from './runtime.js';

export function validateStateRecoveryObservation(
  journal: StateMigrationJournal,
  inspection: StateInspectionRecord,
  context: StateExecutionContext,
  mode: StateRecoveryPlan['mode']
): void {
  const plan = journal.plan;
  stateAssert(!journal.checkpoints.some((entry) => entry.code === 'process-tree-termination-unproven')
    || hasQuarantinedStateOperation(journal.operationId), 'recovery-required');
  stateAssert(journal.schemaVersion === 1 && journal.completedAt === null
    && statePlanFingerprint(plan) === plan.fingerprint, 'recovery-conflict');
  stateAssert(plan.intent.recovery.includes(mode) && (mode === 'forward' || mode === 'remove-new-destinations'), 'approval-mismatch');
  stateAssert(stateObjectDigest({ ...context, configurationDigest: plan.context.configurationDigest }) === stateObjectDigest(plan.context), 'configuration-changed');
  stateAssert(context.configurationDigest === plan.context.configurationDigest
    || context.configurationDigest === plan.intent.targetConfigurationDigest, 'configuration-changed');
  stateAssert(inspection.schemaVersion === 1 && inspection.live && stateObjectDigest(inspection.context) === stateObjectDigest(context)
    && stateObjectDigest(inspection.bindings) === stateObjectDigest(plan.inspection.bindings)
    && inspection.states.length === plan.inspection.states.length, 'approval-mismatch');
  const seen = new Set<string>();
  for (const state of inspection.states) {
    const id = state.snapshot.backendId;
    stateAssert(!seen.has(id), 'mapping-conflict');
    seen.add(id);
    const before = plan.inspection.states.find((entry) => entry.snapshot.backendId === id);
    stateAssert(before, 'mapping-conflict');
    if (stateSnapshotMatches(before.snapshot, state.snapshot)) continue;
    const candidate = journal.prepared?.candidates[id];
    const intended = journal.checkpoints.some((entry) => entry.backendId === id
      && (entry.kind === 'write-intent' || entry.kind === 'source-retirement-intent' || entry.kind === 'compensation-intent'));
    stateAssert(intended && journal.prepared, 'recovery-conflict');
    const isRetiredSource = id === plan.intent.sourceBackendId && !candidate && !state.snapshot.exists;
    const isCompensatedDestination = mode === 'remove-new-destinations' && id !== plan.intent.sourceBackendId && !state.snapshot.exists;
    stateAssert(isRetiredSource || isCompensatedDestination || (candidate && stateContentMatches(candidate.snapshot, state.snapshot)), 'recovery-conflict');
  }
  if (mode === 'remove-new-destinations') {
    const source = inspection.states.find((entry) => entry.snapshot.backendId === plan.intent.sourceBackendId)!;
    const before = plan.inspection.states.find((entry) => entry.snapshot.backendId === plan.intent.sourceBackendId)!;
    stateAssert(journal.prepared && plan.intent.recipe !== 'address-refactor'
      && context.configurationDigest === plan.context.configurationDigest
      && stateSnapshotMatches(source.snapshot, before.snapshot), 'recovery-conflict');
    for (const state of inspection.states) {
      if (state.snapshot.backendId === plan.intent.sourceBackendId || !state.snapshot.exists) continue;
      const acknowledged = journal.checkpoints.some((entry) => entry.kind === 'destination-written'
        && entry.backendId === state.snapshot.backendId && entry.snapshot && stateSnapshotMatches(entry.snapshot, state.snapshot));
      stateAssert(state.snapshot.operationId === journal.operationId || acknowledged, 'ownership-mismatch');
    }
  }
}

export async function buildStateRecoveryPlan(
  dependencies: StateMigrationDependencies,
  request: BuildStateRecoveryPlanRequest
): Promise<StateRecoveryResult> {
  const runtime = new StateMigrationRuntime(dependencies);
  const result: StateRecoveryResult = {
    schemaVersion: 1, operationKind: 'state-recovery-plan', executable: false,
    recoveryRef: null, fingerprint: null, mode: request.mode, blockers: [], expiresAt: runtime.now()
  };
  try {
    await runtime.available(request.context);
    const { value: journal, digest: journalDigest } = await runtime.load<StateMigrationJournal>(request.journalRef, 'journal', request.context);
    const { value: inspection } = await runtime.load<StateInspectionRecord>(request.inspectionRef, 'inspection', request.context);
    stateAssert(inspection.expiresAt > runtime.now(), 'expired');
    validateStateRecoveryObservation(journal, inspection, request.context, request.mode);
    const signal = runtime.signal(request.signal);
    stateAssert(await runtime.writers.inspectConfiguration(request.context, signal) === request.context.configurationDigest, 'configuration-changed');
    for (const binding of inspection.bindings) {
      await runtime.checkState(binding, request.context, inspection.states.find((state) => state.snapshot.backendId === binding.id)!.snapshot, undefined, signal);
    }
    const plan: StateRecoveryPlan = {
      schemaVersion: 1, journalRef: request.journalRef, journalDigest, inspection,
      mode: request.mode, context: structuredClone(request.context), fingerprint: '',
      expiresAt: Math.min(inspection.expiresAt, runtime.now() + runtime.ttl)
    };
    plan.fingerprint = statePlanFingerprint(plan);
    const saved = await runtime.save('recovery', request.context, plan);
    return { ...result, executable: true, recoveryRef: saved.ref, fingerprint: plan.fingerprint, expiresAt: plan.expiresAt };
  } catch (error) { return { ...result, blockers: [{ code: stateFailure(error) }] }; }
}

export async function executeStateRecovery(
  dependencies: StateMigrationDependencies,
  request: ExecuteStateRecoveryRequest
): Promise<StateMigrationResult> {
  const runtime = new StateMigrationRuntime(dependencies);
  let journal: StateMigrationJournal | null = null;
  let journalRef: string | null = null;
  let fingerprint = request.approval?.fingerprint ?? '';
  let protocol: StateMigrationProtocol | null = null;
  let failure: ReturnType<typeof stateFailure> | undefined;
  try {
    stateAssert(request.approval?.kind === 'state-recovery', 'approval-mismatch');
    await runtime.available(request.context);
    const { value: plan } = await runtime.load<StateRecoveryPlan>(request.recoveryRef, 'recovery', request.context);
    stateAssert(plan.schemaVersion === 1 && statePlanFingerprint(plan) === plan.fingerprint, 'artifact-integrity');
    runtime.sameContext(plan.context, request.context);
    runtime.authority(request.approval, 'state-recovery', plan.fingerprint, plan.expiresAt);
    const loaded = await runtime.load<StateMigrationJournal>(plan.journalRef, 'journal', request.context);
    stateAssert(loaded.digest === plan.journalDigest, 'recovery-conflict');
    validateStateRecoveryObservation(loaded.value, plan.inspection, request.context, plan.mode);
    journal = loaded.value;
    journalRef = plan.journalRef;
    fingerprint = journal.plan.fingerprint;
    const descriptor: StateArtifactDescriptor = {
      ref: journalRef, digest: loaded.digest, purpose: 'journal', scope: runtime.scope(request.context)
    };
    protocol = new StateMigrationProtocol(
      runtime, journal, descriptor, plan.inspection.states,
      () => runtime.authority(request.approval, 'state-recovery', plan.fingerprint, plan.expiresAt),
      runtime.signal(request.signal)
    );
    await protocol.acquire(true);
    if (plan.mode === 'forward') await protocol.forward();
    else await protocol.compensate();
  } catch (error) {
    failure = stateFailure(error);
    if (protocol) {
      try { await protocol.checkpoint('blocked', { code: failure }); } catch { /* Preserve the last durable intent. */ }
    }
  } finally {
    try { await protocol?.release(); }
    catch (error) {
      const code = stateFailure(error);
      if (code === 'process-tree-termination-unproven') failure = code;
      else failure ??= code;
    }
  }
  return migrationResult(runtime, journal, journalRef, fingerprint, failure, true);
}

export async function inspectStateMigration(
  dependencies: StateMigrationDependencies,
  request: InspectStateMigrationRequest
): Promise<StateMigrationResult> {
  const runtime = new StateMigrationRuntime(dependencies);
  try {
    await runtime.available(request.context);
    const { value: journal } = await runtime.load<StateMigrationJournal>(request.journalRef, 'journal', request.context);
    stateAssert(journal.schemaVersion === 1 && statePlanFingerprint(journal.plan) === journal.plan.fingerprint, 'artifact-integrity');
    // A historical checkpoint is not current backend/resource verification.
    return migrationResult(runtime, journal, request.journalRef, journal.plan.fingerprint, 'verification-incomplete');
  } catch (error) { return migrationResult(runtime, null, null, '', stateFailure(error)); }
}
