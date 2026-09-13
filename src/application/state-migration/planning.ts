import {
  statefulRecipeVersion,
  type BuildStateMigrationPlanRequest,
  type InspectApprovedStateRequest,
  type ObserveStateMetadataRequest,
  type StateBlocker,
  type StateInspectionRecord,
  type StateInspectionResult,
  type StateMetadataResult,
  type StateMigrationDependencies,
  type StateMigrationPlan,
  type StatePlanResult,
  type ValidateStateMigrationPlanRequest
} from '../../domain/repair/stateful.js';
import {
  freezeStateValue, isStateDigest, stateAssert, stateFailure, stateObjectDigest, stateOpaqueRef,
  validateStateBindings, validateStateContext, validateStateMappings, validateStatePlanBindings
} from '../../domain/repair/stateful-invariants.js';
import { StateMigrationRuntime, statePlanFingerprint } from './runtime.js';

function discoveryFingerprint(result: Omit<StateMetadataResult, 'fingerprint'>): string {
  return stateObjectDigest(result);
}

export async function observeStateMetadata(
  dependencies: StateMigrationDependencies,
  request: ObserveStateMetadataRequest
): Promise<StateMetadataResult> {
  const runtime = new StateMigrationRuntime(dependencies);
  validateStateContext(request.context);
  validateStateBindings(request.bindings);
  const observations: StateMetadataResult['observations'][number][] = [];
  const blockers: StateBlocker[] = [];
  const signal = runtime.signal(request.signal);
  for (const binding of request.bindings) {
    if (binding.kind === 'azurerm' && !request.live) {
      blockers.push({ code: 'live-scope-required', backendRef: stateOpaqueRef(binding.id) });
      continue;
    }
    try { observations.push(await runtime.observe(binding, request.context, signal)); }
    catch (error) { blockers.push({ code: stateFailure(error), backendRef: stateOpaqueRef(binding.id) }); }
  }
  const result: Omit<StateMetadataResult, 'fingerprint'> = {
    schemaVersion: 1, operationKind: 'state-metadata', contextDigest: stateObjectDigest(request.context),
    bindingsDigest: stateObjectDigest(request.bindings), observations, expiresAt: runtime.now() + runtime.ttl, blockers
  };
  return { ...result, fingerprint: discoveryFingerprint(result) };
}

export async function inspectApprovedState(
  dependencies: StateMigrationDependencies,
  request: InspectApprovedStateRequest
): Promise<StateInspectionResult> {
  const runtime = new StateMigrationRuntime(dependencies);
  validateStateBindings(request.bindings);
  validateStateContext(request.context);
  const { fingerprint, ...body } = request.discovery;
  stateAssert(discoveryFingerprint(body) === fingerprint && request.discovery.schemaVersion === 1
    && request.discovery.operationKind === 'state-metadata' && request.discovery.blockers.length === 0
    && request.discovery.contextDigest === stateObjectDigest(request.context)
    && request.discovery.bindingsDigest === stateObjectDigest(request.bindings)
    && request.discovery.observations.length === request.bindings.length, 'approval-mismatch');
  runtime.authority(request.approval, 'state-read', fingerprint, request.discovery.expiresAt);
  stateAssert(request.live || request.bindings.every((binding) => binding.kind === 'local'), 'live-scope-required');
  await runtime.available(request.context);
  const signal = runtime.signal(request.signal);
  const states: StateInspectionRecord['states'][number][] = [];
  for (const binding of request.bindings) {
    const metadata = request.discovery.observations.find((observation) => observation.backendId === binding.id);
    stateAssert(metadata, 'incomplete-observation');
    runtime.publicMetadata(metadata, binding);
    states.push(await runtime.readState(binding, request.context, metadata, undefined, signal));
  }
  const inspection: StateInspectionRecord = {
    schemaVersion: 1, context: structuredClone(request.context), bindings: structuredClone(request.bindings),
    states, readFingerprint: fingerprint, live: request.live,
    expiresAt: Math.min(request.discovery.expiresAt, request.approval.expiresAt)
  };
  const saved = await runtime.save('inspection', request.context, inspection);
  return {
    schemaVersion: 1, operationKind: 'state-inspection', inspectionRef: saved.ref,
    fingerprint: saved.digest, workspaceRef: dependencies.workspace.workspaceRef, expiresAt: inspection.expiresAt,
    states: states.map((state) => ({
      backendRef: stateOpaqueRef(state.snapshot.backendId), exists: state.snapshot.exists,
      stateDigest: state.snapshot.digest, inventoryDigest: state.snapshot.inventoryDigest,
      instanceCount: state.instances.length, serial: state.snapshot.serial,
      lineageDigest: state.snapshot.lineage ? stateOpaqueRef(state.snapshot.lineage) : null
    }))
  };
}

export async function buildStateMigrationPlan(
  dependencies: StateMigrationDependencies,
  request: BuildStateMigrationPlanRequest
): Promise<StatePlanResult> {
  const runtime = new StateMigrationRuntime(dependencies);
  const result: StatePlanResult = {
    schemaVersion: 1, operationKind: 'stateful-migration', executable: false, planRef: null, fingerprint: null,
    recipe: request.intent.recipe, recipeVersion: statefulRecipeVersion, authority: 'state-write',
    workspaceRef: dependencies.workspace.workspaceRef, mappingDigest: stateObjectDigest(request.intent.mappings),
    sourceRef: stateOpaqueRef(request.intent.sourceBackendId),
    destinationRefs: request.intent.destinationBackendIds.map(stateOpaqueRef), instanceCount: request.intent.mappings.length,
    expiresAt: runtime.now(), blockers: []
  };
  try {
    await runtime.available(request.context);
    const { value: inspection } = await runtime.load<StateInspectionRecord>(request.inspectionRef, 'inspection', request.context);
    stateAssert(inspection.schemaVersion === 1, 'artifact-integrity');
    runtime.sameContext(inspection.context, request.context);
    stateAssert(inspection.expiresAt > runtime.now(), 'expired');
    stateAssert(inspection.live, 'live-scope-required');
    validateStateBindings(inspection.bindings);
    validateStateMappings(request.intent, inspection.states);
    validateStatePlanBindings(request.intent, inspection.bindings);
    const signal = runtime.signal(request.signal);
    for (const binding of inspection.bindings) {
      await runtime.backend(binding).assertAccess(request.context, true, signal);
      await runtime.checkState(binding, request.context, inspection.states.find((state) => state.snapshot.backendId === binding.id)!.snapshot, undefined, signal);
    }
    const review = await runtime.native.review({ context: request.context, inspection, intent: request.intent, signal });
    stateAssert(review.configurationDigest === request.context.configurationDigest && isStateDigest(review.contractDigest)
      && review.savedPlanRefs.length > 0 && review.savedPlanRefs.length <= 64 && review.savedPlanRefs.length === review.savedPlanDigests.length
      && review.savedPlanDigests.every(isStateDigest)
      && Object.values(request.intent.targetConfigurationRefs).every((ref) => isStateDigest(review.configurationDigests[ref])), 'verification-incomplete');
    for (let index = 0; index < review.savedPlanRefs.length; index++) {
      const actual = await dependencies.workspace.describe(review.savedPlanRefs[index], 'plan', runtime.scope(request.context));
      stateAssert(actual?.digest === review.savedPlanDigests[index], 'artifact-integrity');
    }
    const plan: StateMigrationPlan = {
      schemaVersion: 1, recipeVersion: statefulRecipeVersion, context: structuredClone(request.context),
      inspectionRef: request.inspectionRef, inspection, intent: structuredClone(request.intent), review,
      fingerprint: '', expiresAt: Math.min(inspection.expiresAt, runtime.now() + runtime.ttl)
    };
    plan.fingerprint = statePlanFingerprint(plan);
    const saved = await runtime.save('plan', request.context, plan);
    return { ...result, executable: true, planRef: saved.ref, fingerprint: plan.fingerprint, expiresAt: plan.expiresAt };
  } catch (error) { return { ...result, blockers: [{ code: stateFailure(error) }] }; }
}

export async function validateStateMigrationPlan(
  dependencies: StateMigrationDependencies,
  request: ValidateStateMigrationPlanRequest
): Promise<readonly StateBlocker[]> {
  const runtime = new StateMigrationRuntime(dependencies);
  try {
    await loadApprovedStatePlan(runtime, request);
    return [];
  } catch (error) { return [{ code: stateFailure(error) }]; }
}

export async function loadApprovedStatePlan(
  runtime: StateMigrationRuntime,
  request: ValidateStateMigrationPlanRequest
): Promise<StateMigrationPlan> {
  stateAssert(request.approval?.kind === 'state-write', 'approval-mismatch');
  await runtime.available(request.context);
  const { value: plan } = await runtime.load<StateMigrationPlan>(request.planRef, 'plan', request.context);
  stateAssert(plan.schemaVersion === 1 && plan.recipeVersion === statefulRecipeVersion
    && statePlanFingerprint(plan) === plan.fingerprint, 'artifact-integrity');
  runtime.authority(request.approval, 'state-write', plan.fingerprint, plan.expiresAt);
  runtime.sameContext(plan.context, request.context);
  runtime.sameContext(plan.inspection.context, request.context);
  validateStateBindings(plan.inspection.bindings);
  validateStateMappings(plan.intent, plan.inspection.states);
  validateStatePlanBindings(plan.intent, plan.inspection.bindings);
  stateAssert(plan.inspection.expiresAt > runtime.now(), 'expired');
  stateAssert(plan.inspection.live, 'live-scope-required');
  stateAssert(plan.review.configurationDigest === plan.context.configurationDigest
    && plan.review.savedPlanRefs.length > 0 && plan.review.savedPlanRefs.length <= 64
    && plan.review.savedPlanRefs.length === plan.review.savedPlanDigests.length, 'artifact-integrity');
  for (let index = 0; index < plan.review.savedPlanRefs.length; index++) {
    const actual = await runtime.deps.workspace.describe(plan.review.savedPlanRefs[index], 'plan', runtime.scope(request.context));
    stateAssert(actual?.digest === plan.review.savedPlanDigests[index], 'artifact-integrity');
  }
  return freezeStateValue(plan);
}
