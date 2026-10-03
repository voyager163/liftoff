import type { ManifestContractContext } from '../../project/manifest/context.js';
import type * as R from './record-contracts.js';
import type * as M from './modern-record-contracts.js';
import { modernActivationRecordValidators } from './record-validation.js';
import { createModernActivationIdentityReader } from './modern-identity.js';
import { modernActivationSourceContracts } from '../policy/identity.js';
import { freezeModernValue, modernPhaseContractDigests } from './modern-graph.js';
import { canonicalJson, canonicalSha256, isRecord, sha256Hex } from './canonical-json.js';
import {
  assertModernRecordData, assertSafeControlRecord, normalizeApprovalScopeValues, canonicalApprovalEnvelopeValues,
  transitionAuthorityValues, semanticPlanDigest, approvalBundleDigest, authorityOperationValues, approvalOperationDigests,
  outputBindingsMatch, outputResourcesMatch, validatePhasePayloadValues, projectionOperation, assertProjectionDestination,
  plannedApprovalMutations, plannedApprovalDestinations, plannedApprovalResources, approvalScopeExpansionReasons
} from './source-values.js';

export interface ModernRelatedRecords {
  readonly evidence?: readonly unknown[];
  readonly plans?: readonly unknown[];
  readonly approvals?: readonly unknown[];
}
export type ModernInitialStateInput = Pick<M.ModernActivationState, 'repository' | 'applicability' | 'createdAt'>;
export type ModernPlanInput = Omit<M.ModernSavedTransitionPlan,
  'schemaVersion' | 'identity' | 'graphHash' | 'scope' | 'planDigest' | 'mutationClasses'>;
export type ModernApprovalInput = Omit<M.ModernApprovalEnvelope, 'schemaVersion' | 'identity' | 'planDigest' | 'baselineSha' | 'phaseId' | 'gateKind' | 'scope' | 'coveredPhases' | 'phasePlanDigests' | 'operationDigests'> & {
  readonly plan: M.ModernSavedTransitionPlan;
};
export interface ModernEvidenceInput {
  readonly plan: M.ModernSavedTransitionPlan;
  readonly evidenceId: string;
  readonly repositoryId: string;
  readonly producedAt: string;
  readonly producer: string;
  readonly result: M.ModernEvidenceHeader['result'];
  readonly payload: Readonly<Record<string, unknown>>;
  readonly liveReadback?: readonly R.LiveReadbackProofFieldsV3<M.ReadableModernActivationIdentity, M.ModernPhaseId>[];
  readonly afterInputDigest?: string;
  readonly gitBinding?: R.InputTransitionBindingFieldsV1['git'];
}
export interface ModernOutcomeInput {
  readonly state: M.ModernActivationState;
  readonly plan: M.ModernSavedTransitionPlan;
  readonly phaseState: R.ReleasedPhaseStateV3;
  readonly updatedAt: string;
  readonly evidenceId?: string;
  readonly blocker?: string;
  readonly operation?: R.ExternalOperationStateFieldsV1;
  readonly outputs?: R.PhaseOutputBindingsFieldsV1;
}

/** Independent local record values. Neither this factory nor any returned record grants effects. */
export function createModernActivationRecordContract(
  catalog: ManifestContractContext['catalog'], context: M.ModernActivationSourceInput
) {
  const identity = createModernActivationIdentityReader(catalog).validateReadableModernActivationIdentity(context);
  const selected = modernActivationSourceContracts().find(source => source.identity.phaseGraphHash === identity.phaseGraphHash)!;
  const graph = selected.graph, phases = graph.phases.map(phase => phase.id);
  const digests = modernPhaseContractDigests(graph);
  const engine = modernActivationRecordValidators(catalog, context), decoder = engine.records;
  const clone = <T>(value: T): T => freezeModernValue(structuredClone(value));
  const same = (left: unknown, right: unknown) => canonicalSha256(left) === canonicalSha256(right);
  const phase = (id: M.ModernPhaseId) => {
    const found = graph.phases.find(phase => phase.id === id);
    if (!found) throw new Error(`Unknown modern phase ${id}.`);
    return found;
  };
  const scope = (id: M.ModernPhaseId): R.ReleasedGovernanceScopeV3 =>
    graph.completionGroups.local.includes(id) ? 'local' : graph.completionGroups.lifecycle.includes(id) ? 'lifecycle' : 'activation';
  function input(value: unknown, label: string): unknown {
    assertModernRecordData(value, label);
    assertSafeControlRecord(value, () => { throw new Error(`${label} contains prohibited sensitive control-record content.`); });
    return decoder.publicJson(value, label);
  }
  function exact(value: unknown, keys: readonly string[], label: string, optional: readonly string[] = []) {
    input(value, label);
    return decoder.exact(value, [...keys, ...optional.filter(key => isRecord(value) && Object.hasOwn(value, key))], label);
  }
  function timestamp(value: unknown, label: string): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new Error(`${label} must be a valid ISO timestamp.`);
    }
    return value;
  }
  function decodeApproval(value: unknown): M.ModernApprovalEnvelope {
    const approved = decoder.validateApprovalEnvelope(input(value, 'modern approval'));
    if (approved.phasePlanDigests && approved.planDigest !== approvalBundleDigest(approved.scope ?? scope(approved.phaseId), approved.phasePlanDigests)) {
      throw new Error('Modern approval bundle digest does not match its phase authorities.');
    }
    return approved;
  }
  function approvalHash(value: M.ModernApprovalEnvelope): string {
    return canonicalSha256(canonicalApprovalEnvelopeValues(value, normalizeApprovalScopeValues(value, phases)));
  }
  function authority(plan: Omit<M.ModernSavedTransitionPlan, 'planDigest'>) {
    const primary = transitionAuthorityValues({ phase: phase(plan.phaseId), transitionDigest: plan.transitionDigest,
      operations: plan.operations, configuration: plan.configuration, fileChanges: plan.fileChanges, recovery: plan.recovery }, scope(plan.phaseId));
    const phasePlanDigests = Object.fromEntries([[plan.phaseId, primary], ...(plan.approvalBundle ?? []).map(entry => [
      entry.phaseId, transitionAuthorityValues({ phase: phase(entry.phaseId), transitionDigest: entry.transitionDigest,
        operations: entry.operations, fileChanges: entry.fileChanges, configuration: plan.configuration }, scope(entry.phaseId))
    ])]);
    return { primary, phasePlanDigests, digest: plan.approvalBundle?.length
      ? approvalBundleDigest(scope(plan.phaseId), phasePlanDigests) : primary };
  }
  function projection(operations: readonly M.ModernTransitionOperation[]) {
    const operation = projectionOperation(operations);
    if (!operation) return undefined;
    if (identity.workflow === 'manual') throw new Error('Manual cannot project external framework tasks.');
    const contract = engine.validateGovernanceTaskProjectionContract(operation.inputs.projection);
    assertProjectionDestination(operation, contract);
    if (contract.workflowKind !== identity.workflow) throw new Error('Projection workflow contradicts its modern identity.');
    // Creating external modern source metadata requires the separately allocated source-metadata2 writer.
    if (contract.source === 'create') throw new Error('Modern creation projection requires the source-metadata2 contract; no legacy metadata substitute is supported.');
    return contract;
  }
  function requestedScope(plan: M.ModernSavedTransitionPlan) {
    const entries = [{ phaseId: plan.phaseId, operations: plan.operations }, ...(plan.approvalBundle ?? [])];
    const operations = entries.flatMap(entry => [...authorityOperationValues(entry.operations)]);
    const effects = operations.flatMap(operation => [operation, ...(operation.effects ?? [])]);
    const costRequired = ['activation-plan', 'infrastructure-cost'].includes(plan.approval.gateKind);
    const budget = plan.configuration?.budget;
    if (costRequired && !budget) throw new Error('Modern cost approval requires the actual retained budget; unavailable cost is not zero.');
    const destructive = effects.filter(effect => effect.destructive);
    if (plan.approval.gateKind === 'destructive-disposal' && destructive.length === 0) {
      throw new Error('Modern destructive approval requires the actual retained destructive destinations.');
    }
    const destructiveScope = destructive.map(effect => {
      if (!effect.remote && !effect.destination.pathParts?.length) throw new Error('Local destructive approval requires its exact retained path.');
      return effect.destination.pathParts?.join('/') ?? effect.destination.identity;
    });
    const exceptions = entries.flatMap(entry => {
      const config = plan.configuration?.phases[entry.phaseId];
      const sources = [config, ...entry.operations.map(operation => operation.inputs)];
      return sources.flatMap(source => source && Object.hasOwn(source, 'policyExceptions')
        ? decoder.stringArray(source.policyExceptions, 'requested policyExceptions') : []);
    });
    const distinct = <T>(values: readonly T[]): T[] => [...new Map(values.map(value => [canonicalJson(value), value])).values()];
    return normalizeApprovalScopeValues({
      phaseId: plan.phaseId, gateKind: plan.approval.gateKind, identity, scope: plan.scope,
      baselineSha: plan.baselineDigest, planDigest: authority(plan).digest,
      coveredPhases: entries.map(entry => entry.phaseId), operationDigests: approvalOperationDigests(operations),
      resources: plannedApprovalResources(effects), destinations: plannedApprovalDestinations(effects),
      permissions: plannedApprovalMutations(effects),
      costCeiling: costRequired && budget ? {
        currency: budget.currency, fixedMonthlyCents: budget.fixedMonthlyCents * entries.length,
        usageMonthlyCents: budget.usageMonthlyCents * entries.length
      } : { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 },
      policyExceptions: distinct(exceptions), destructiveScope: distinct(destructiveScope)
    }, phases);
  }
  function decodePlan(value: unknown): M.ModernSavedTransitionPlan {
    const plan = decoder.validateSavedTransitionPlan(input(value, 'modern plan'));
    const node = phase(plan.phaseId), approval = plan.approval, evaluation = approval.evaluation;
    if (approval.gateKind !== node.approvalGate.kind || approval.required !== node.approvalGate.required ||
      evaluation.phaseId !== plan.phaseId || evaluation.gateKind !== approval.gateKind ||
      evaluation.approvalRequired !== approval.required || evaluation.envelopeId !== approval.envelopeId ||
      evaluation.envelopeHash !== approval.envelopeHash || approval.envelopeId === null && approval.envelopeHash !== null ||
      plan.rollbackPlan.phaseId !== plan.phaseId || plan.rollbackPlan.strategy !== node.rollback.kind ||
      plan.rollbackPlan.target !== node.rollback.target || plan.rollbackPlan.operations.some(operation => operation.phaseId !== plan.phaseId)) {
      throw new Error('Modern plan approval, evaluation or rollback does not match its phase contract.');
    }
    if (!approval.required && (evaluation.status !== 'not-required' || approval.envelopeId !== null) ||
      approval.required && evaluation.status === 'not-required' ||
      evaluation.status === 'approval-required' && approval.envelopeId !== null ||
      evaluation.status === 'reused' && (approval.envelopeId === null || approval.envelopeHash === null) ||
      ['expired', 'invalidated'].includes(evaluation.status) && (approval.envelopeId === null || evaluation.reasons.length === 0) ||
      evaluation.status === 'invalidated' && approval.envelopeHash === null) {
      throw new Error('Modern plan must distinguish missing, reused, expired and invalidated approval observations.');
    }
    if (Date.parse(plan.createdAt) >= Date.parse(plan.expiresAt)) throw new Error('Modern plan requires createdAt before expiresAt.');
    for (const entry of [{ phaseId: plan.phaseId, operations: plan.operations }, ...(plan.approvalBundle ?? [])]) {
      const node = phase(entry.phaseId);
      for (const operation of entry.operations) for (const effect of [operation, ...(operation.effects ?? [])]) {
        if (!(effect.remote ? node.allowedMutations.remote : node.allowedMutations.local).includes(effect.mutationClass)) {
          throw new Error(`Modern plan mutation ${effect.mutationClass} is outside phase ${entry.phaseId}.`);
        }
      }
      projection(entry.operations);
    }
    const mutations = { local: [...new Set(plan.operations.flatMap(operation => [operation, ...(operation.effects ?? [])]).filter(effect => !effect.remote).map(effect => effect.mutationClass))],
      remote: [...new Set(plan.operations.flatMap(operation => [operation, ...(operation.effects ?? [])]).filter(effect => effect.remote).map(effect => effect.mutationClass))] };
    if (!same(plan.mutationClasses, mutations)) throw new Error('Modern plan mutation inventory contradicts its exact operations and effects.');
    if (plan.planDigest !== semanticPlanDigest({ phase: node, transitionDigest: plan.transitionDigest, operations: plan.operations,
      approvalPlanDigest: authority(plan).digest })) throw new Error('Modern plan semantic digest does not bind its original operations and authority.');
    return plan;
  }
  function bodyDigest(payload: unknown, proofs: readonly R.LiveReadbackProofFieldsV3<M.ReadableModernActivationIdentity, M.ModernPhaseId>[] = []): string {
    const liveReadback = [...proofs].map(proof => decoder.validateLiveReadbackProof(input(proof, 'modern readback')))
      .sort((a, b) => canonicalSha256(a).localeCompare(canonicalSha256(b), 'en'));
    return canonicalSha256({ payload: payload ?? null, liveReadback });
  }
  function decodeEvidence(value: unknown): M.ModernEvidenceRecord {
    const record = exact(value, ['evidenceId', 'header'], 'modern evidence', ['payload', 'liveReadback']);
    const header = decoder.validateEvidenceHeader(record.header);
    const evidenceId = decoder.stringField(record, 'evidenceId', 'modern evidence');
    decoder.safePathParts([evidenceId], 'modern evidenceId');
    const proofs = record.liveReadback === undefined ? undefined : (() => {
      if (!Array.isArray(record.liveReadback)) throw new Error('Modern evidence readback must be an array.');
      return record.liveReadback.map(proof => decoder.validateLiveReadbackProof(proof));
    })();
    if (header.phaseContractDigest !== digests[header.phaseId] || !phase(header.phaseId).terminalStates.includes(header.result) ||
      header.bodyDigest !== bodyDigest(record.payload, proofs)) throw new Error('Modern evidence phase, outcome or body commitment is inconsistent.');
    for (const proof of proofs ?? []) {
      if (proof.phaseId !== header.phaseId || proof.repositoryId !== header.repositoryId || proof.baselineSha !== header.baselineSha ||
        proof.inputDigest !== header.transition.inputDigest || !same(proof.transition, header.transition)) {
        throw new Error('Modern readback contradicts its enclosing original transition.');
      }
    }
    if (!['failed', 'inapplicable'].includes(header.result) &&
      (phase(header.phaseId).evidence.liveReadbackProviders.some(provider => !proofs?.some(proof => proof.provider === provider && proof.matches)) ||
        proofs?.some(proof => !proof.matches))) {
      throw new Error('A successful modern result requires every declared provider readback and no contradictory receipt.');
    }
    const result: M.ModernEvidenceRecord = { evidenceId, header,
      ...(Object.hasOwn(record, 'payload') ? { payload: record.payload } : {}), ...(proofs ? { liveReadback: proofs } : {}) };
    const issues = validatePhasePayloadValues(result);
    if (issues.length) throw new Error(issues.join(' '));
    if (header.result !== 'failed' && header.result !== 'inapplicable' && isRecord(result.payload)) {
      if (header.phaseId === 'local-baseline-verified' && (!Array.isArray(result.payload.checks) || !result.payload.checks.length ||
        result.payload.checks.some(check => !isRecord(check) || !['passed', 'inapplicable'].includes(String(check.status))))) {
        throw new Error('Modern local baseline requires actual applicable successful check observations.');
      }
      if (header.phaseId === 'local-complete') {
        const payload = result.payload;
        if (payload.schemaVersion !== 1 || payload.workflow !== identity.workflow ||
          payload.frameworkValidation !== (identity.workflow === 'manual' ? 'not-required' : 'verified') ||
          payload.frameworkFinalization !== (identity.workflow === 'manual' ? 'not-required' : identity.workflow === 'openspec' ? 'synced-archived' : 'finalized')) {
          throw new Error('Local completion must record its actual workflow protocol, never a fictional archive.');
        }
        decoder.hexDigest(payload.baselineHeaderDigest, 'local completion baselineHeaderDigest');
        decoder.stringField(payload, 'baselineEvidenceId', 'local completion');
      }
    }
    return result;
  }
  function related(records: ModernRelatedRecords = {}) {
    exact(records, [], 'modern related records', ['plans', 'approvals', 'evidence']);
    const list = (value: readonly unknown[] | undefined, label: string) => {
      if (value !== undefined && !Array.isArray(value)) throw new Error(`${label} must be an array.`);
      return value ?? [];
    };
    const plans = list(records.plans, 'plans').map(decodePlan), approvals = list(records.approvals, 'approvals').map(decodeApproval);
    const evidence = list(records.evidence, 'evidence').map(decodeEvidence);
    if (new Set(approvals.map(record => record.id)).size !== approvals.length ||
      new Set(evidence.map(record => record.evidenceId)).size !== evidence.length) throw new Error('Modern related records contain duplicate identities.');
    for (const plan of plans) checkApproval(plan, approvals);
    for (const proof of evidence) checkEvidence(proof, plans, evidence);
    return { plans, approvals, evidence };
  }
  function checkApproval(plan: M.ModernSavedTransitionPlan, approvals: readonly M.ModernApprovalEnvelope[]) {
    if (plan.approval.envelopeId === null) return;
    const envelope = approvals.find(approval => approval.id === plan.approval.envelopeId), expected = authority(plan);
    if (!envelope || plan.approval.envelopeHash !== null && approvalHash(envelope) !== plan.approval.envelopeHash) {
      throw new Error('Modern plan requires its exact stored approval and envelope hash.');
    }
    if (plan.approval.evaluation.status !== 'reused') return;
    if (envelope.baselineSha !== plan.baselineDigest ||
      envelope.gateKind !== plan.approval.gateKind || (envelope.scope ?? scope(envelope.phaseId)) !== plan.scope ||
      envelope.phaseId !== plan.phaseId && !envelope.coveredPhases?.includes(plan.phaseId) ||
      envelope.planDigest !== expected.digest && (plan.approvalBundle?.length || envelope.phasePlanDigests?.[plan.phaseId] !== expected.primary) ||
      plan.approvalBundle?.length && !same(envelope.phasePlanDigests, expected.phasePlanDigests)) {
      throw new Error('Modern plan requires its exact stored approval authority and envelope hash.');
    }
    for (const entry of [{ phaseId: plan.phaseId, operations: plan.operations }, ...(plan.approvalBundle ?? [])]) {
      if (envelope.phaseId !== entry.phaseId && !envelope.coveredPhases?.includes(entry.phaseId) ||
        envelope.operationDigests && approvalOperationDigests(authorityOperationValues(entry.operations)).some(digest => !envelope.operationDigests!.includes(digest))) {
        throw new Error('Modern approval omits a reviewed bundle phase or operation.');
      }
    }
    const expansions = approvalScopeExpansionReasons(normalizeApprovalScopeValues(envelope, phases), requestedScope(plan));
    if (expansions.length) throw new Error(`Modern approval scope does not cover the retained plan: ${expansions.join('; ')}.`);
  }
  function evidenceMatchesPlan(proof: M.ModernEvidenceRecord, plan: M.ModernSavedTransitionPlan): boolean {
    const payload = proof.payload, header = proof.header;
    return isRecord(payload) && plan.phaseId === header.phaseId && plan.transitionDigest === header.transition.transitionDigest &&
      plan.baselineDigest === header.baselineSha && plan.inputDigest === (header.inputBindings?.beforeDigest ?? header.transition.inputDigest) &&
      (!header.inputBindings || same(plan.fileChanges ?? [], header.inputBindings.files)) &&
      payload.planDigest === plan.planDigest && payload.savedPlanDigest === canonicalSha256(plan);
  }
  function checkEvidence(proof: M.ModernEvidenceRecord, plans: readonly M.ModernSavedTransitionPlan[], evidence: readonly M.ModernEvidenceRecord[]) {
    const payload = proof.payload, header = proof.header;
    if (!isRecord(payload) || !Object.hasOwn(payload, 'planDigest') || !Object.hasOwn(payload, 'savedPlanDigest')) {
      throw new Error('Modern runtime evidence requires both original reviewed plan commitments.');
    }
    decoder.hexDigest(payload.planDigest, 'payload.planDigest');
    decoder.hexDigest(payload.savedPlanDigest, 'payload.savedPlanDigest');
    const matched = plans.find(plan => evidenceMatchesPlan(proof, plan));
    if (!matched) {
        throw new Error('Modern evidence requires its exact original saved plan and input bindings.');
    }
    if (matched.approval.required && !['failed', 'inapplicable'].includes(header.result) &&
      matched.approval.evaluation.status !== 'reused') throw new Error('Successful modern evidence cannot claim a gated outcome from a pending or invalid approval.');
    if (header.phaseId === 'local-complete' && header.result === 'verified' && isRecord(payload) &&
      !evidence.some(record => record.evidenceId === payload.baselineEvidenceId && record.header.phaseId === 'local-baseline-verified' &&
        record.header.result === 'verified' && record.header.repositoryId === header.repositoryId &&
        record.header.baselineSha === header.baselineSha &&
        canonicalSha256(record.header) === payload.baselineHeaderDigest)) {
      throw new Error('Modern local completion requires its actual verified baseline evidence.');
    }
  }
  function readPlan(value: unknown, records: ModernRelatedRecords = {}): M.ModernSavedTransitionPlan {
    const plan = decodePlan(value), refs = related(records); checkApproval(plan, refs.approvals); return clone(plan);
  }
  function readEvidence(value: unknown, records: ModernRelatedRecords = {}): M.ModernEvidenceRecord {
    const proof = decodeEvidence(value), refs = related(records); checkEvidence(proof, refs.plans, refs.evidence); return clone(proof);
  }
  function readState(value: unknown, records: ModernRelatedRecords = {}): M.ModernActivationState {
    const state = decoder.validateUserActivationState(input(value, 'modern state')), refs = related(records);
    timestamp(state.createdAt, 'state.createdAt'); timestamp(state.updatedAt, 'state.updatedAt');
    if (!/^local:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(state.repository.id)) {
      throw new Error('Modern state requires an actual UUID v4 local execution anchor.');
    }
    if (Date.parse(state.updatedAt) < Date.parse(state.createdAt)) throw new Error('State update cannot precede construction.');
    if (identity.workflow === 'manual' && (state.activeChange !== null || state.taskProjection !== undefined) ||
      state.activeChange && state.activeChange.kind !== identity.workflow) throw new Error('Modern state framework fields contradict its workflow.');
    for (const id of phases) {
      const entry = state.phases[id]; timestamp(entry.updatedAt, `${id}.updatedAt`);
      if (Date.parse(entry.updatedAt) < Date.parse(state.createdAt) || Date.parse(entry.updatedAt) > Date.parse(state.updatedAt)) {
        throw new Error(`Modern phase ${id} timestamp is outside its recorded state interval.`);
      }
      if (new Set(entry.evidence.map(ref => ref.evidenceId)).size !== entry.evidence.length || new Set(entry.approvals).size !== entry.approvals.length ||
        entry.evidence.some(ref => ref.phaseId !== id || !refs.evidence.some(record => record.evidenceId === ref.evidenceId &&
          record.header.phaseId === id && record.header.repositoryId === state.repository.id && record.header.result === ref.result &&
          canonicalSha256(record.header) === ref.headerDigest)) ||
        entry.approvals.some(approvalId => !refs.approvals.some(record => record.id === approvalId &&
          (record.phaseId === id || record.coveredPhases?.includes(id))))) throw new Error(`Modern state ${id} has missing or contradictory record references.`);
      if (['verified', 'inapplicable', 'disposed', 'retained'].includes(entry.state) && !entry.evidence.some(ref => ref.result === entry.state) ||
        entry.state === 'approved' && entry.approvals.length === 0) throw new Error(`Modern terminal state ${id} lacks its original outcome reference.`);
      for (const digest of [entry.executionPlanDigest, entry.operation?.planDigest]) if (digest !== undefined &&
        !refs.plans.some(plan => plan.phaseId === id && plan.planDigest === digest)) throw new Error(`Modern state ${id} has a missing execution/dispatch plan.`);
      const evidenceOutcome = ['verified', 'inapplicable', 'disposed', 'retained'].includes(entry.state);
      if (evidenceOutcome || entry.state === 'approved') {
        const executionPlans = refs.plans.filter(plan => plan.phaseId === id && plan.planDigest === entry.executionPlanDigest);
        const bound = entry.state === 'approved'
          ? phase(id).terminalStates.includes('approved') && executionPlans.some(plan =>
            plan.approval.required && plan.approval.evaluation.status === 'reused' &&
            plan.approval.envelopeId !== null && entry.approvals.includes(plan.approval.envelopeId))
          : entry.evidence.some(reference => reference.result === entry.state && refs.evidence.some(proof =>
            proof.evidenceId === reference.evidenceId && executionPlans.some(plan => evidenceMatchesPlan(proof, plan))));
        if (!bound) throw new Error(`Modern terminal state ${id} lacks an outcome bound to its selected execution plan.`);
      }
      const outputs = state.phaseOutputs?.[id];
      if (outputs && !outputResourcesMatch(outputs, refs.evidence.find(proof => outputBindingsMatch(proof, id, entry.evidence, outputs)))) {
        throw new Error(`Modern phase ${id} outputs lack their referenced original resource receipt.`);
      }
    }
    if (state.bootstrapState) {
      const retention = state.bootstrapState;
      if (!refs.evidence.some(proof => proof.evidenceId === retention.remoteImportEvidenceId && proof.header.phaseId === 'remote-import-verified' &&
        canonicalSha256(proof.header) === retention.remoteImportEvidenceDigest && proof.header.repositoryId === state.repository.id) ||
        retention.deletionEvidenceId && !refs.evidence.some(proof => proof.evidenceId === retention.deletionEvidenceId &&
          proof.header.phaseId === 'bootstrap-state-disposed' && proof.header.repositoryId === state.repository.id)) throw new Error('Modern retention lacks its original evidence.');
    }
    if (state.taskProjection) {
      const audit = state.taskProjection;
      if (!refs.plans.some(plan => {
        if (plan.planDigest !== audit.planDigest || plan.phaseId !== audit.phaseId) return false;
        const contract = projection(plan.operations);
        return contract && canonicalSha256(contract) === audit.contractDigest && contract.metadataHash === audit.metadataHash &&
          contract.layoutHash === audit.layoutHash && same(contract.taskPathParts, audit.taskPathParts);
      })) throw new Error('Modern task audit lacks its retained projection contract.');
    }
    const activeChange = state.activeChange;
    if (identity.workflow === 'manual') return clone({ ...state, identity: { ...identity, workflow: 'manual' }, activeChange: null });
    if (identity.workflow === 'openspec') return clone({ ...state, identity: { ...identity, workflow: 'openspec' },
      activeChange: activeChange === null ? null : { id: activeChange.id, kind: 'openspec' } });
    return clone({ ...state, identity: { ...identity, workflow: 'spec-kit' },
      activeChange: activeChange === null ? null : { id: activeChange.id, kind: 'spec-kit' } });
  }
  function readApproval(value: unknown): M.ModernApprovalEnvelope { return clone(decodeApproval(value)); }
  function readCredentialPolicy(value: unknown): M.ModernCredentialPolicy {
    return clone(decoder.validateCredentialPolicy(input(value, 'modern credential policy')));
  }
  function readSupersession(value: unknown): M.ModernSupersessionRecord {
    if (identity.workflow === 'manual') throw new Error('Manual has no external framework change to supersede.');
    const record = decoder.validateSupersessionRecord(input(value, 'modern supersession'));
    decoder.safePathParts([record.supersededChangeId], 'supersededChangeId');
    decoder.safePathParts([record.supersedingChangeId], 'supersedingChangeId');
    return clone(record);
  }
  function createInitialState(value: ModernInitialStateInput): M.ModernActivationState {
    exact(value, ['repository', 'applicability', 'createdAt'], 'initial state');
    return readState({ ...value, schemaVersion: identity.activationStateSchemaVersion, identity, activeChange: null,
      phases: Object.fromEntries(phases.map(id => [id, { state: 'pending', updatedAt: value.createdAt, evidence: [], approvals: [], blockers: [] }])),
      updatedAt: value.createdAt });
  }
  function createPlan(value: ModernPlanInput, records: ModernRelatedRecords = {}): M.ModernSavedTransitionPlan {
    exact(value, ['phaseId', 'createdAt', 'expiresAt', 'stateHash', 'baselineDigest', 'inputDigest', 'transitionDigest', 'operations', 'approval', 'rollbackPlan', 'noSecrets'],
      'plan input', ['configuration', 'fileChanges', 'recovery', 'approvalBundle']);
    const effects = value.operations.flatMap(operation => [operation, ...(operation.effects ?? [])]);
    const draft: Omit<M.ModernSavedTransitionPlan, 'planDigest'> = { ...value, schemaVersion: selected.savedPlanSchemaVersion, identity,
      graphHash: identity.phaseGraphHash, scope: scope(value.phaseId),
      mutationClasses: { local: [...new Set(effects.filter(effect => !effect.remote).map(effect => effect.mutationClass))],
        remote: [...new Set(effects.filter(effect => effect.remote).map(effect => effect.mutationClass))] } };
    return readPlan({ ...draft, planDigest: semanticPlanDigest({ phase: phase(draft.phaseId), transitionDigest: draft.transitionDigest,
      operations: draft.operations, approvalPlanDigest: authority(draft).digest }) }, records);
  }
  function createApproval(value: ModernApprovalInput): M.ModernApprovalEnvelope {
    exact(value, ['plan', 'id', 'resources', 'destinations', 'permissions', 'costCeiling', 'policyExceptions', 'destructiveScope', 'expiresAt', 'approvedAt', 'approver'], 'approval input');
    const plan = decodePlan(value.plan), selectedAuthority = authority(plan);
    const { plan: _plan, ...fields } = value;
    const created = readApproval({ ...fields, schemaVersion: identity.approvalEnvelopeSchemaVersion, identity,
      phaseId: plan.phaseId, gateKind: plan.approval.gateKind, scope: plan.scope, baselineSha: plan.baselineDigest,
      planDigest: selectedAuthority.digest, coveredPhases: [plan.phaseId, ...(plan.approvalBundle ?? []).map(entry => entry.phaseId)],
      operationDigests: [...new Set([plan.operations, ...(plan.approvalBundle ?? []).map(entry => entry.operations)]
        .flatMap(operations => approvalOperationDigests(authorityOperationValues(operations))))],
      ...(plan.approvalBundle?.length ? { phasePlanDigests: selectedAuthority.phasePlanDigests } : {}) });
    const expansions = approvalScopeExpansionReasons(normalizeApprovalScopeValues(created, phases), requestedScope(plan));
    if (expansions.length) throw new Error(`Supplied approval scope does not cover the retained plan: ${expansions.join('; ')}.`);
    return created;
  }
  function createEvidence(value: ModernEvidenceInput, records: ModernRelatedRecords = {}): M.ModernEvidenceRecord {
    exact(value, ['plan', 'evidenceId', 'repositoryId', 'producedAt', 'producer', 'result', 'payload'], 'evidence input',
      ['liveReadback', 'afterInputDigest', 'gitBinding']);
    if ('planDigest' in value.payload || 'savedPlanDigest' in value.payload) throw new Error('Evidence plan commitments are derived, not caller overrides.');
    const plan = readPlan(value.plan, records), payload = { ...value.payload, planDigest: plan.planDigest, savedPlanDigest: canonicalSha256(plan) };
    if (plan.approval.required && !['failed', 'inapplicable'].includes(value.result) && plan.approval.evaluation.status !== 'reused') {
      throw new Error('A gated successful outcome requires the recorded matching approval, not a pending plan.');
    }
    if (value.afterInputDigest !== undefined && !plan.fileChanges?.length && !value.gitBinding &&
      value.afterInputDigest !== plan.inputDigest) throw new Error('Changed outcome inputs require an actual file or Git binding.');
    const binding = plan.fileChanges?.length || value.gitBinding;
    const header: M.ModernEvidenceHeader = {
      schemaVersion: identity.evidenceHeaderSchemaVersion, identity, repositoryId: value.repositoryId, phaseGraphHash: identity.phaseGraphHash,
      phaseId: plan.phaseId, phaseContractDigest: digests[plan.phaseId]!, baselineSha: plan.baselineDigest,
      inputDigest: binding ? value.afterInputDigest ?? plan.inputDigest : plan.inputDigest,
      transition: { phaseId: plan.phaseId, baselineSha: plan.baselineDigest, inputDigest: plan.inputDigest, transitionDigest: plan.transitionDigest },
      producedAt: value.producedAt, producer: value.producer, result: value.result, scope: plan.scope,
      bodyDigest: bodyDigest(payload, value.liveReadback),
      ...(binding ? { inputBindings: { beforeDigest: plan.inputDigest, afterDigest: value.afterInputDigest ?? plan.inputDigest,
        files: plan.fileChanges ?? [], ...(value.gitBinding ? { git: value.gitBinding } : {}) } } : {})
    };
    return readEvidence({ evidenceId: value.evidenceId, header, payload, ...(value.liveReadback ? { liveReadback: value.liveReadback } : {}) },
      { ...records, plans: [...(records.plans ?? []).filter(record => !same(record, plan)), plan] });
  }
  function createCredentialMetadata(value: Omit<M.ModernCredentialPolicy, 'schemaVersion' | 'identity'>): M.ModernCredentialPolicy {
    input(value, 'credential input');
    if ('schemaVersion' in value || 'identity' in value) throw new Error('Credential identity/version are derived.');
    return readCredentialPolicy({ ...value, schemaVersion: identity.credentialPolicySchemaVersion, identity });
  }
  function createSupersession(value: Omit<M.ModernSupersessionRecord, 'schemaVersion' | 'identity'>): M.ModernSupersessionRecord {
    exact(value, ['supersededChangeId', 'supersedingChangeId', 'reason', 'approvedAt', 'approver'], 'supersession input');
    return readSupersession({ ...value, schemaVersion: identity.supersessionSchemaVersion, identity });
  }
  function stateAfterOutcome(value: ModernOutcomeInput, records: ModernRelatedRecords = {}): M.ModernActivationState {
    exact(value, ['state', 'plan', 'phaseState', 'updatedAt'], 'outcome input', ['evidenceId', 'blocker', 'operation', 'outputs']);
    const prior = readState(value.state, records), plan = readPlan(value.plan, records), refs = related(records);
    const proof = value.evidenceId === undefined ? undefined : refs.evidence.find(record => record.evidenceId === value.evidenceId);
    if (value.evidenceId !== undefined && (!proof || proof.header.phaseId !== plan.phaseId || proof.header.result !== value.phaseState)) {
      throw new Error('Outcome requires the actual evidence for its phase and result.');
    }
    if (proof) checkEvidence(proof, [plan], refs.evidence);
    if (Date.parse(timestamp(value.updatedAt, 'outcome.updatedAt')) < Date.parse(prior.updatedAt)) throw new Error('Outcome cannot precede the recorded state.');
    if (value.phaseState === 'approved' && (plan.approval.evaluation.status !== 'reused' || !phase(plan.phaseId).terminalStates.includes('approved'))) {
      throw new Error('Approved outcome requires a matching approval-gated phase and stored consent.');
    }
    const old = prior.phases[plan.phaseId];
    const retainedOperation = value.operation ?? (['blocked', 'failed'].includes(value.phaseState) ? old.operation : undefined);
    return readState({ ...prior, updatedAt: value.updatedAt,
      baselineAnchor: prior.baselineAnchor ?? plan.baselineDigest,
      ...(plan.configuration ? { activationInputs: plan.configuration } : {}),
      phases: { ...prior.phases, [plan.phaseId]: {
      state: value.phaseState, updatedAt: value.updatedAt,
      evidence: proof ? [...old.evidence.filter(ref => ref.evidenceId !== proof.evidenceId), {
        evidenceId: proof.evidenceId, phaseId: proof.header.phaseId, headerDigest: canonicalSha256(proof.header), result: proof.header.result
      }] : old.evidence,
      approvals: plan.approval.envelopeId === null ? old.approvals : [...new Set([...old.approvals, plan.approval.envelopeId])],
      blockers: value.blocker === undefined ? [] : [value.blocker], executionPlanDigest: plan.planDigest,
      ...(retainedOperation ? { operation: retainedOperation } : {})
    } }, ...(value.outputs ? { phaseOutputs: { ...prior.phaseOutputs, [plan.phaseId]: value.outputs } } : {}) }, records);
  }
  function encodeRecord(value: M.ModernRuntimeRecord, records: ModernRelatedRecords = {}) {
    exact(value, ['kind', 'record'], 'record encoding');
    const record = value.kind === 'state' ? readState(value.record, records) : value.kind === 'evidence' ? readEvidence(value.record, records) :
      value.kind === 'approval' ? readApproval(value.record) : value.kind === 'plan' ? readPlan(value.record, records) :
        value.kind === 'credential-policy' ? readCredentialPolicy(value.record) : value.kind === 'supersession' ? readSupersession(value.record) :
          (() => { throw new Error('Unknown modern record kind.'); })();
    const text = canonicalJson(record);
    return Object.freeze({ content: new TextEncoder().encode(text), rawDigest: sha256Hex(text), recordDigest: canonicalSha256(record) });
  }
  return Object.freeze({ identity, graph, readState, readEvidence, readApproval, readPlan, readCredentialPolicy, readSupersession,
    createInitialState, createPlan, createEvidence, createApproval, createCredentialMetadata, createSupersession, stateAfterOutcome, encodeRecord });
}

export type ModernActivationRecordContract = ReturnType<typeof createModernActivationRecordContract>;
