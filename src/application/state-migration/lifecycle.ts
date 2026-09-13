import {
  type BuildStateDisposalPlanRequest,
  type DisposeRetainedStateRequest,
  type RetainedStateKeyBinding,
  type RetainedStateKeyProvider,
  type StateArtifactDescriptor,
  type StateDisposalPlan,
  type StateExecutionContext,
  type StateLifecycleResult,
  type StateMigrationDependencies,
  type StateMigrationJournal
} from '../../domain/repair/stateful.js';
import { stateAssert, stateFailure, stateObjectDigest } from '../../domain/repair/stateful-invariants.js';
import { StateMigrationRuntime, stateOperationId, statePlanFingerprint } from './runtime.js';

interface DisposalProgress {
  schemaVersion: 1;
  planFingerprint: string;
  intendedArtifact: string | null;
  intendedKey: string | null;
  removedArtifacts: string[];
  removedKeys: string[];
}

function result(): StateLifecycleResult {
  return {
    schemaVersion: 1, operationKind: 'state-lifecycle', status: 'blocked', executable: false,
    disposalRef: null, progressRef: null, fingerprint: null, artifactCount: 0, keyCount: 0,
    notBefore: null, expiresAt: null, blockers: []
  };
}

function ownedKey(key: RetainedStateKeyBinding, operationId: string, context: StateExecutionContext, artifacts: readonly StateArtifactDescriptor[]): void {
  const allowed = new Set(artifacts.map((artifact) => artifact.ref));
  stateAssert(key.ownerProjectId === context.projectId && key.operationId === operationId
    && typeof key.version === 'string' && key.version.length > 0 && key.version.length <= 256
    && key.exclusiveArtifactRefs.length > 0 && new Set(key.exclusiveArtifactRefs).size === key.exclusiveArtifactRefs.length
    && key.exclusiveArtifactRefs.every((ref) => allowed.has(ref)), 'ownership-mismatch');
}

export async function buildStateDisposalPlan(
  dependencies: StateMigrationDependencies,
  request: BuildStateDisposalPlanRequest,
  keys?: RetainedStateKeyProvider
): Promise<StateLifecycleResult> {
  const runtime = new StateMigrationRuntime(dependencies);
  const output = result();
  try {
    await runtime.available(request.context);
    const { value: journal, digest } = await runtime.load<StateMigrationJournal>(request.journalRef, 'journal', request.context);
    stateAssert(journal.schemaVersion === 1 && journal.completedAt !== null && Number.isFinite(journal.completedAt)
      && statePlanFingerprint(journal.plan) === journal.plan.fingerprint, 'recovery-required');
    stateAssert(journal.plan.context.projectId === request.context.projectId && journal.plan.context.projectRoot === request.context.projectRoot
      && journal.plan.context.hostId === request.context.hostId, 'ownership-mismatch');
    const notBefore = journal.completedAt + journal.plan.intent.retentionMs;
    output.notBefore = notBefore;
    output.artifactCount = journal.backups.length;
    output.keyCount = request.keyRefs?.length ?? 0;
    stateAssert(Number.isFinite(notBefore), 'artifact-integrity');
    if (runtime.now() < notBefore) return { ...output, status: 'retained', blockers: [{ code: 'not-due' }] };
    const signal = runtime.signal(request.signal);
    const keyBindings: RetainedStateKeyBinding[] = [];
    stateAssert(new Set(request.keyRefs ?? []).size === (request.keyRefs?.length ?? 0), 'invalid-binding');
    for (const keyRef of request.keyRefs ?? []) {
      stateAssert(keys && typeof keyRef === 'string' && keyRef.length <= 1024, 'key-unavailable');
      const key = await runtime.external(signal, (bounded) => keys.inspect(keyRef, request.context, bounded));
      stateAssert(key && key.keyRef === keyRef, 'key-unavailable');
      ownedKey(key, journal.operationId, request.context, journal.backups);
      keyBindings.push(key);
    }
    const plan: StateDisposalPlan = {
      schemaVersion: 1, context: structuredClone(request.context), journalRef: request.journalRef,
      journalDigest: digest, operationId: journal.operationId, artifacts: journal.backups,
      keys: keyBindings, notBefore, expiresAt: runtime.now() + runtime.ttl, fingerprint: ''
    };
    plan.fingerprint = statePlanFingerprint(plan);
    const saved = await runtime.save('recovery', request.context, plan);
    return {
      ...output, status: 'due', executable: true, disposalRef: saved.ref,
      fingerprint: plan.fingerprint, expiresAt: plan.expiresAt
    };
  } catch (error) { return { ...output, blockers: [{ code: stateFailure(error) }] }; }
}

export async function disposeRetainedState(
  dependencies: StateMigrationDependencies,
  request: DisposeRetainedStateRequest,
  keys?: RetainedStateKeyProvider
): Promise<StateLifecycleResult> {
  const runtime = new StateMigrationRuntime(dependencies);
  const output = result();
  try {
    stateAssert(request.approval?.kind === 'state-disposal', 'approval-mismatch');
    await runtime.available(request.context);
    const { value: plan } = await runtime.load<StateDisposalPlan>(request.disposalRef, 'recovery', request.context);
    stateAssert(plan.schemaVersion === 1 && statePlanFingerprint(plan) === plan.fingerprint, 'artifact-integrity');
    runtime.sameContext(plan.context, request.context);
    runtime.authority(request.approval, 'state-disposal', plan.fingerprint, plan.expiresAt);
    stateAssert(runtime.now() >= plan.notBefore, 'not-due');
    const { value: journal, digest } = await runtime.load<StateMigrationJournal>(plan.journalRef, 'journal', request.context);
    stateAssert(digest === plan.journalDigest && journal.completedAt !== null && journal.operationId === plan.operationId
      && journal.completedAt + journal.plan.intent.retentionMs === plan.notBefore
      && stateObjectDigest(journal.backups) === stateObjectDigest(plan.artifacts), 'artifact-integrity');
    Object.assign(output, {
      status: 'due', disposalRef: request.disposalRef, fingerprint: plan.fingerprint,
      artifactCount: plan.artifacts.length, keyCount: plan.keys.length,
      notBefore: plan.notBefore, expiresAt: plan.expiresAt
    });
    const signal = runtime.signal(request.signal);
    for (const artifact of plan.artifacts) {
      stateAssert(artifact.purpose === 'backup' && artifact.scope === runtime.scope(request.context), 'artifact-purpose');
      const actual = await dependencies.workspace.describe(artifact.ref, 'backup', artifact.scope);
      stateAssert(actual === null || stateObjectDigest(actual) === stateObjectDigest(artifact), 'artifact-integrity');
    }
    for (const key of plan.keys) {
      stateAssert(keys, 'key-unavailable');
      ownedKey(key, plan.operationId, request.context, plan.artifacts);
      const actual = await runtime.external(signal, (bounded) => keys.inspect(key.keyRef, request.context, bounded));
      stateAssert(actual === null || stateObjectDigest(actual) === stateObjectDigest(key), 'ownership-mismatch');
    }
    const id = stateOperationId(`disposal:${plan.fingerprint}`);
    output.progressRef = `${dependencies.workspace.workspaceRef}/${id}`;
    let progress: DisposalProgress = {
      schemaVersion: 1, planFingerprint: plan.fingerprint, intendedArtifact: null, intendedKey: null,
      removedArtifacts: [], removedKeys: []
    };
    let descriptor: StateArtifactDescriptor;
    try { descriptor = await runtime.save('journal', request.context, progress, id); }
    catch (error) {
      stateAssert(stateFailure(error) === 'recovery-required', stateFailure(error));
      const saved = await runtime.load<DisposalProgress>(output.progressRef, 'journal', request.context);
      stateAssert(saved.value.schemaVersion === 1 && saved.value.planFingerprint === plan.fingerprint, 'artifact-integrity');
      progress = saved.value;
      descriptor = { ref: output.progressRef, purpose: 'journal', scope: runtime.scope(request.context), digest: saved.digest };
    }
    const persist = async (): Promise<void> => { descriptor = await runtime.replace(descriptor, progress); };
    for (const artifact of plan.artifacts) {
      runtime.authority(request.approval, 'state-disposal', plan.fingerprint, plan.expiresAt);
      runtime.checkSignal(signal);
      await runtime.available(request.context);
      progress.intendedArtifact = artifact.ref;
      await persist();
      const actual = await dependencies.workspace.describe(artifact.ref, 'backup', artifact.scope);
      if (actual) {
        stateAssert(stateObjectDigest(actual) === stateObjectDigest(artifact), 'artifact-integrity');
        await dependencies.workspace.removeExact(artifact);
      }
      stateAssert(await dependencies.workspace.describe(artifact.ref, 'backup', artifact.scope) === null, 'verification-incomplete');
      if (!progress.removedArtifacts.includes(artifact.ref)) progress.removedArtifacts.push(artifact.ref);
      progress.intendedArtifact = null;
      await persist();
    }
    for (const key of plan.keys) {
      runtime.authority(request.approval, 'state-disposal', plan.fingerprint, plan.expiresAt);
      runtime.checkSignal(signal);
      progress.intendedKey = key.keyRef;
      await persist();
      const actual = await runtime.external(signal, (bounded) => keys!.inspect(key.keyRef, request.context, bounded));
      if (actual) {
        stateAssert(stateObjectDigest(actual) === stateObjectDigest(key), 'ownership-mismatch');
        await runtime.external(signal, (bounded) => keys!.destroy(key, request.context, bounded));
      }
      stateAssert(await runtime.external(signal, (bounded) => keys!.inspect(key.keyRef, request.context, bounded)) === null, 'verification-incomplete');
      if (!progress.removedKeys.includes(key.keyRef)) progress.removedKeys.push(key.keyRef);
      progress.intendedKey = null;
      await persist();
    }
    return { ...output, status: 'disposed', executable: false };
  } catch (error) { return { ...output, status: 'blocked', executable: false, blockers: [{ code: stateFailure(error) }] }; }
}
