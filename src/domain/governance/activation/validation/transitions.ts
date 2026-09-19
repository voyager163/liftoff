import { canonicalPhaseGraph, canonicalPhaseGraphHash } from '../graph.js';
import { activationStateSchemaVersion, supersessionSchemaVersion } from '../../policy/identity.js';
import type { ApprovalEvaluation, ApprovalGateKind, GovernanceScope, GraphReconciliationRecord, MutationClass, PhaseId, SavedTransitionPlan, RollbackKind, TransitionOperation, TransitionOperationDestination, TransitionRollbackPlan, SupersessionRecord } from '../types.js';
import { approvalGateKinds, mutationClasses, phaseIds, phaseScope, phaseInScope, rollbackKinds } from '../types.js';
import { phaseIdSet, governanceScopeSet, transitionAdapterIds, record, exact, exactWithOptional, stringField, booleanField, stringArray, safePathParts, publicJson, enumValue, requireVersion, hexDigest, isoTimestamp, assertNoDuplicateStrings } from './common.js';
import { validateActivationConfiguration, validateActivationConfigurationBinding } from './configuration.js';
import { validateActivationIdentityShape, validateActivationIdentity } from './identity.js';
import { validateFileChanges } from './bindings.js';

export function validateOperationDestination(value: unknown, path: string): TransitionOperationDestination {
  const destination = exactWithOptional(value, ['type', 'identity'], ['pathParts', 'repository', 'subscriptionId', 'ref'], path);
  const normalized: TransitionOperationDestination = {
    type: enumValue(destination.type, new Set(['local', 'repository', 'subscription', 'environment', 'tenant', 'external']), `${path}.type`),
    identity: stringField(destination, 'identity', path),
    ...(destination.pathParts !== undefined ? { pathParts: safePathParts(destination.pathParts, `${path}.pathParts`) } : {}),
    ...(destination.repository !== undefined ? { repository: stringField(destination, 'repository', path) } : {}),
    ...(destination.subscriptionId !== undefined ? { subscriptionId: stringField(destination, 'subscriptionId', path) } : {}),
    ...(destination.ref !== undefined ? { ref: stringField(destination, 'ref', path) } : {})
  };
  return normalized;
}

export function validateTransitionOperation(value: unknown, path: string): TransitionOperation {
  const operation = exactWithOptional(value, [
    'adapter',
    'actionId',
    'mutationClass',
    'phaseId',
    'inputs',
    'destination',
    'remote',
    'destructive'
  ], ['effects'], path);
  const effects = operation.effects === undefined ? undefined : (() => {
    if (!Array.isArray(operation.effects)) throw new Error(`${path}.effects must be an array.`);
    return operation.effects.map((entry, index) => {
      const effect = exact(entry, ['mutationClass', 'destination', 'remote', 'destructive'], `${path}.effects[${index}]`);
      return {
        mutationClass: enumValue<MutationClass>(effect.mutationClass, new Set<string>(mutationClasses), `${path}.effects[${index}].mutationClass`),
        destination: validateOperationDestination(effect.destination, `${path}.effects[${index}].destination`),
        remote: booleanField(effect, 'remote', `${path}.effects[${index}]`),
        destructive: booleanField(effect, 'destructive', `${path}.effects[${index}]`)
      };
    });
  })();
  return {
    adapter: enumValue(operation.adapter, transitionAdapterIds, `${path}.adapter`) as TransitionOperation['adapter'],
    actionId: stringField(operation, 'actionId', path),
    mutationClass: enumValue<MutationClass>(operation.mutationClass, new Set<string>(mutationClasses), `${path}.mutationClass`),
    phaseId: enumValue<PhaseId>(operation.phaseId, phaseIdSet, `${path}.phaseId`),
    inputs: record(publicJson(operation.inputs, `${path}.inputs`), `${path}.inputs`),
    destination: validateOperationDestination(operation.destination, `${path}.destination`),
    remote: booleanField(operation, 'remote', path),
    destructive: booleanField(operation, 'destructive', path),
    ...(effects ? { effects } : {})
  };
}

export function validateApprovalEvaluation(value: unknown, path: string): ApprovalEvaluation {
  const evaluation = exact(value, [
    'phaseId',
    'gateKind',
    'questionKind',
    'approvalRequired',
    'status',
    'envelopeId',
    'envelopeHash',
    'reasons',
    'expansionReasons'
  ], path);
  const question = evaluation.questionKind === null
    ? null
    : enumValue(evaluation.questionKind, new Set([
      'repository-creation-initial-commit-push',
      'credential-enrollment',
      'billed-infrastructure-policy-exception-cost-ceiling',
      'final-enforcement',
      'destructive-operation',
      'external-blocker'
    ]), `${path}.questionKind`);
  const envelopeHash = evaluation.envelopeHash === null
    ? null
    : hexDigest(evaluation.envelopeHash, `${path}.envelopeHash`);
  return {
    phaseId: enumValue<PhaseId>(evaluation.phaseId, phaseIdSet, `${path}.phaseId`),
    gateKind: enumValue<ApprovalGateKind>(evaluation.gateKind, new Set<string>(approvalGateKinds), `${path}.gateKind`),
    questionKind: question as ApprovalEvaluation['questionKind'],
    approvalRequired: booleanField(evaluation, 'approvalRequired', path),
    status: enumValue(evaluation.status, new Set(['not-required', 'approval-required', 'reused', 'expired', 'invalidated']), `${path}.status`),
    envelopeId: evaluation.envelopeId === null ? null : stringField(evaluation, 'envelopeId', path),
    envelopeHash,
    reasons: stringArray(evaluation.reasons, `${path}.reasons`),
    expansionReasons: stringArray(evaluation.expansionReasons, `${path}.expansionReasons`)
  };
}

export function validateRollbackPlan(value: unknown, path: string): TransitionRollbackPlan {
  const rollbackPlan = exact(value, [
    'phaseId',
    'strategy',
    'target',
    'operations',
    'retained',
    'cleanupWarnings'
  ], path);
  return {
    phaseId: enumValue<PhaseId>(rollbackPlan.phaseId, phaseIdSet, `${path}.phaseId`),
    strategy: enumValue<RollbackKind>(rollbackPlan.strategy, new Set<string>(rollbackKinds), `${path}.strategy`),
    target: rollbackPlan.target === null ? null : enumValue<PhaseId>(rollbackPlan.target, phaseIdSet, `${path}.target`),
    operations: Array.isArray(rollbackPlan.operations)
      ? rollbackPlan.operations.map((operation, index) => {
          const validated = validateTransitionOperation(operation, `${path}.operations[${index}]`);
          return {
            adapter: validated.adapter,
            actionId: validated.actionId,
            mutationClass: validated.mutationClass,
            phaseId: validated.phaseId,
            inputs: validated.inputs,
            destination: validated.destination,
            remote: validated.remote,
            destructive: validated.destructive
          };
        })
      : (() => { throw new Error(`${path}.operations must be an array.`); })(),
    retained: stringArray(rollbackPlan.retained, `${path}.retained`),
    cleanupWarnings: stringArray(rollbackPlan.cleanupWarnings, `${path}.cleanupWarnings`)
  };
}

export function validateSavedTransitionPlan(value: unknown): SavedTransitionPlan {
  const plan = exactWithOptional(value, [
    'schemaVersion',
    'scope',
    'phaseId',
    'createdAt',
    'expiresAt',
    'identity',
    'graphHash',
    'stateHash',
    'baselineDigest',
    'inputDigest',
    'transitionDigest',
    'planDigest',
    'mutationClasses',
    'operations',
    'approval',
    'rollbackPlan',
    'noSecrets'
  ], ['configuration', 'configurationBinding', 'selectionScope', 'fileChanges', 'recovery', 'approvalBundle'], 'transitionPlan');
  requireVersion(plan.schemaVersion, 2, 'transitionPlan.schemaVersion');
  const identity = validateActivationIdentity(plan.identity);
  const graphHash = hexDigest(plan.graphHash, 'transitionPlan.graphHash');
  if (graphHash !== identity.phaseGraphHash) {
    throw new Error('transitionPlan.graphHash must match identity.phaseGraphHash.');
  }
  const phaseId = enumValue<PhaseId>(plan.phaseId, phaseIdSet, 'transitionPlan.phaseId');
  const selectionScope = plan.selectionScope === undefined ? undefined :
    enumValue<GovernanceScope>(plan.selectionScope, governanceScopeSet, 'transitionPlan.selectionScope');
  if (selectionScope && !phaseInScope(phaseId, selectionScope, true)) {
    throw new Error('transitionPlan.selectionScope cannot select an unrelated phase.');
  }
  if (plan.configurationBinding !== undefined && plan.configuration === undefined) {
    throw new Error('A bound configuration file must also bind its normalized public configuration.');
  }
  const mutationClassesValue = exact(plan.mutationClasses, ['local', 'remote'], 'transitionPlan.mutationClasses');
  const approval = exact(plan.approval, [
    'gateKind',
    'required',
    'evaluation',
    'envelopeId',
    'envelopeHash'
  ], 'transitionPlan.approval');
  const operations = Array.isArray(plan.operations)
    ? plan.operations.map((operation, index) => validateTransitionOperation(operation, `transitionPlan.operations[${index}]`))
    : (() => { throw new Error('transitionPlan.operations must be an array.'); })();
  for (const operation of operations) {
    if (operation.phaseId !== phaseId) {
      throw new Error(`transitionPlan operation ${operation.actionId} phaseId must match ${phaseId}.`);
    }
  }
  const evaluation = validateApprovalEvaluation(approval.evaluation, 'transitionPlan.approval.evaluation');
  const envelopeHash = approval.envelopeHash === null
    ? null
    : hexDigest(approval.envelopeHash, 'transitionPlan.approval.envelopeHash');
  let approvalBundle: SavedTransitionPlan['approvalBundle'];
  if (plan.approvalBundle !== undefined) {
    if (!Array.isArray(plan.approvalBundle)) throw new Error('transitionPlan.approvalBundle must be an array.');
    approvalBundle = plan.approvalBundle.map((entry, index) => {
      const item = exact(entry, ['phaseId', 'inputDigest', 'transitionDigest', 'operations', 'fileChanges'], `transitionPlan.approvalBundle[${index}]`);
      const id = enumValue<PhaseId>(item.phaseId, phaseIdSet, 'transitionPlan.approvalBundle.phaseId');
      const node = canonicalPhaseGraph.phases.find((phase) => phase.id === id)!;
      if (id === phaseId || phaseScope(id) !== phaseScope(phaseId) || node.approvalGate.kind !== approval.gateKind) {
        throw new Error('A bundled phase must be distinct and share the primary phase scope and approval gate.');
      }
      if (!Array.isArray(item.operations)) throw new Error('Bundled operations must be an array.');
      const operations = item.operations.map((operation, operationIndex) =>
        validateTransitionOperation(operation, `transitionPlan.approvalBundle[${index}].operations[${operationIndex}]`));
      if (operations.some((operation) => operation.phaseId !== id)) throw new Error('Bundled operations must match their declared phase.');
      return {
        phaseId: id, inputDigest: hexDigest(item.inputDigest, 'approvalBundle.inputDigest'),
        transitionDigest: hexDigest(item.transitionDigest, 'approvalBundle.transitionDigest'),
        operations, fileChanges: validateFileChanges(item.fileChanges, 'approvalBundle.fileChanges')
      };
    });
    assertNoDuplicateStrings(approvalBundle.map((entry) => entry.phaseId), 'transitionPlan.approvalBundle');
  }
  return {
    schemaVersion: 2,
    scope: enumValue<GovernanceScope>(plan.scope, new Set([phaseScope(phaseId)]), 'transitionPlan.scope'),
    ...(selectionScope ? { selectionScope } : {}),
    phaseId,
    createdAt: isoTimestamp(plan.createdAt, 'transitionPlan.createdAt'),
    expiresAt: isoTimestamp(plan.expiresAt, 'transitionPlan.expiresAt'),
    identity,
    graphHash,
    stateHash: plan.stateHash === null ? null : hexDigest(plan.stateHash, 'transitionPlan.stateHash'),
    baselineDigest: hexDigest(plan.baselineDigest, 'transitionPlan.baselineDigest'),
    inputDigest: hexDigest(plan.inputDigest, 'transitionPlan.inputDigest'),
    transitionDigest: hexDigest(plan.transitionDigest, 'transitionPlan.transitionDigest'),
    planDigest: hexDigest(plan.planDigest, 'transitionPlan.planDigest'),
    mutationClasses: {
      local: stringArray(mutationClassesValue.local, 'transitionPlan.mutationClasses.local').map((entry) =>
        enumValue<MutationClass>(entry, new Set<string>(mutationClasses), 'transitionPlan.mutationClasses.local')
      ),
      remote: stringArray(mutationClassesValue.remote, 'transitionPlan.mutationClasses.remote').map((entry) =>
        enumValue<MutationClass>(entry, new Set<string>(mutationClasses), 'transitionPlan.mutationClasses.remote')
      )
    },
    operations,
    approval: {
      gateKind: enumValue<ApprovalGateKind>(approval.gateKind, new Set<string>(approvalGateKinds), 'transitionPlan.approval.gateKind'),
      required: booleanField(approval, 'required', 'transitionPlan.approval'),
      evaluation,
      envelopeId: approval.envelopeId === null ? null : stringField(approval, 'envelopeId', 'transitionPlan.approval'),
      envelopeHash
    },
    rollbackPlan: validateRollbackPlan(plan.rollbackPlan, 'transitionPlan.rollbackPlan'),
    ...(plan.configuration === undefined ? {} : { configuration: validateActivationConfiguration(plan.configuration) }),
    ...(plan.configurationBinding === undefined ? {} : { configurationBinding: validateActivationConfigurationBinding(plan.configurationBinding) }),
    ...(plan.fileChanges === undefined ? {} : { fileChanges: validateFileChanges(plan.fileChanges, 'transitionPlan.fileChanges') }),
    ...(plan.recovery === undefined ? {} : { recovery: booleanField(plan, 'recovery', 'transitionPlan') }),
    ...(approvalBundle ? { approvalBundle } : {}),
    noSecrets: plan.noSecrets === true ? true : (() => { throw new Error('transitionPlan.noSecrets must be true.'); })()
  };
}

export function validateSupersessionRecord(value: unknown): SupersessionRecord {
  const supersession = exact(value, [
    'schemaVersion',
    'identity',
    'supersededChangeId',
    'supersedingChangeId',
    'reason',
    'approvedAt',
    'approver'
  ], 'supersession');
  requireVersion(supersession.schemaVersion, supersessionSchemaVersion, 'supersession.schemaVersion');
  return {
    schemaVersion: supersessionSchemaVersion,
    identity: validateActivationIdentity(supersession.identity),
    supersededChangeId: stringField(supersession, 'supersededChangeId', 'supersession'),
    supersedingChangeId: stringField(supersession, 'supersedingChangeId', 'supersession'),
    reason: stringField(supersession, 'reason', 'supersession'),
    approvedAt: stringField(supersession, 'approvedAt', 'supersession'),
    approver: stringField(supersession, 'approver', 'supersession')
  };
}

export function validateGraphReconciliationRecord(
  value: unknown,
  recognizedGraphHashes: ReadonlySet<string> = new Set([canonicalPhaseGraphHash])
): GraphReconciliationRecord {
  const reconciliation = exact(value, [
    'schemaVersion',
    'fromGraphHash',
    'toGraphHash',
    'fromIdentity',
    'toIdentity',
    'phaseMappings',
    'reconciledAt',
    'producer'
  ], 'graphReconciliation');
  requireVersion(reconciliation.schemaVersion, activationStateSchemaVersion, 'graphReconciliation.schemaVersion');
  const fromGraphHash = hexDigest(reconciliation.fromGraphHash, 'graphReconciliation.fromGraphHash');
  const toGraphHash = hexDigest(reconciliation.toGraphHash, 'graphReconciliation.toGraphHash');
  if (!recognizedGraphHashes.has(fromGraphHash)) {
    throw new Error(`graphReconciliation.fromGraphHash is not a recognized graph hash: ${fromGraphHash}.`);
  }
  if (!recognizedGraphHashes.has(toGraphHash)) {
    throw new Error(`graphReconciliation.toGraphHash is not a recognized graph hash: ${toGraphHash}.`);
  }
  const fromIdentity = validateActivationIdentityShape(reconciliation.fromIdentity, 'graphReconciliation.fromIdentity');
  const toIdentity = validateActivationIdentityShape(reconciliation.toIdentity, 'graphReconciliation.toIdentity');
  if (fromIdentity.phaseGraphHash !== fromGraphHash) {
    throw new Error('graphReconciliation.fromIdentity.phaseGraphHash must match fromGraphHash.');
  }
  if (toIdentity.phaseGraphHash !== toGraphHash) {
    throw new Error('graphReconciliation.toIdentity.phaseGraphHash must match toGraphHash.');
  }
  if (!Array.isArray(reconciliation.phaseMappings)) {
    throw new Error('graphReconciliation.phaseMappings must be an array.');
  }
  const seen = new Set<PhaseId>();
  const phaseMappings = reconciliation.phaseMappings.map((entry, index) => {
    const mapping = exact(entry, [
      'phaseId',
      'fromContractDigest',
      'toContractDigest',
      'preserveEvidence'
    ], `graphReconciliation.phaseMappings[${index}]`);
    const phaseId = enumValue<PhaseId>(mapping.phaseId, phaseIdSet, `graphReconciliation.phaseMappings[${index}].phaseId`);
    if (seen.has(phaseId)) {
      throw new Error(`graphReconciliation.phaseMappings contains duplicate phase ${phaseId}.`);
    }
    seen.add(phaseId);
    const fromContractDigest = hexDigest(
      mapping.fromContractDigest,
      `graphReconciliation.phaseMappings[${index}].fromContractDigest`
    );
    const toContractDigest = hexDigest(
      mapping.toContractDigest,
      `graphReconciliation.phaseMappings[${index}].toContractDigest`
    );
    const preserveEvidence = booleanField(
      mapping,
      'preserveEvidence',
      `graphReconciliation.phaseMappings[${index}]`
    );
    if (preserveEvidence && fromContractDigest !== toContractDigest) {
      throw new Error(`graphReconciliation.phaseMappings[${index}] cannot preserve evidence for changed phase ${phaseId}.`);
    }
    return {
      phaseId,
      fromContractDigest,
      toContractDigest,
      preserveEvidence
    };
  });
  for (const phaseId of phaseIds) {
    if (!seen.has(phaseId)) {
      throw new Error(`graphReconciliation.phaseMappings.${phaseId} is required.`);
    }
  }
  return {
    schemaVersion: activationStateSchemaVersion,
    fromGraphHash,
    toGraphHash,
    fromIdentity,
    toIdentity,
    phaseMappings,
    reconciledAt: isoTimestamp(reconciliation.reconciledAt, 'graphReconciliation.reconciledAt'),
    producer: stringField(reconciliation, 'producer', 'graphReconciliation')
  };
}
