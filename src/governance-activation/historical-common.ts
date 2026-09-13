import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import type {
  ApprovalEnvelope, ApprovalEvaluation, BootstrapStateRetention, EvidenceHeader,
  EvidenceReference, LiveReadbackProof, PhaseExecutionState, SavedTransitionPlan,
  TransitionOperation, TransitionOperationDestination, TransitionRollbackPlan
} from '../domain/governance/activation/types.js';
import type { HistoricalActivationIdentity } from '../domain/governance/policy/identity.js';
import {
  historicalIdentity, historyArray, historyBoolean, historyDigest, historyEnum, historyExact,
  historyFail, historyLiteral, historyPathParts, historyRecord, historyRecordId, historyString,
  historyStrings, historyTimestamp
} from './history-contracts.js';
import { assertSafeHistoricalRecord } from './historical-safety.js';
import { historicalPhaseIds, type HistoricalPhaseId } from './historical-v1-phase-contracts.js';
export { historicalPhaseIds, type HistoricalPhaseId };

export const historicalPhaseStates = [
  'pending', 'blocked', 'ready', 'approved', 'running', 'verified', 'failed', 'inapplicable', 'retained', 'disposed'
] as const;
export const historicalResults = ['verified', 'failed', 'inapplicable', 'retained', 'disposed'] as const;
export const historicalMutationClasses = [
  'none', 'read-worktree', 'write-activation-state', 'write-evidence', 'write-openspec-seed',
  'write-openspec-governance', 'write-local-state', 'delete-local-state', 'write-workflows',
  'write-ruleset-source', 'git-commit', 'git-push', 'github-read', 'github-write',
  'github-secret-write', 'azure-read', 'azure-provider-register', 'azure-network-provision',
  'azure-state-import', 'azure-resource-provision', 'github-ruleset-write'
] as const;
export const historicalGateKinds = [
  'none', 'repository-publish', 'activation-plan', 'credential-enrollment', 'infrastructure-cost',
  'enforcement', 'destructive-disposal', 'external-blocker'
] as const;
export const historicalQuestionKinds = [
  'repository-creation-initial-commit-push', 'credential-enrollment',
  'billed-infrastructure-policy-exception-cost-ceiling', 'final-enforcement',
  'destructive-operation', 'external-blocker'
] as const;
export const destinationTypes = ['local', 'repository', 'subscription', 'environment', 'tenant', 'external'] as const;
export const adapterIds = ['local-evidence', 'selected-spec-workflow', 'git', 'github', 'azure-opentofu', 'local-state'] as const;
export const historicalPhaseGates = {
  'seed-valid': 'none', 'seed-verified': 'none', 'seed-archived': 'none',
  committed: 'repository-publish', pushed: 'repository-publish', 'phase-0-complete': 'none',
  'activation-approved': 'activation-plan', 'credential-ready': 'credential-enrollment',
  'provider-ready': 'infrastructure-cost', 'state-path-selected': 'infrastructure-cost',
  'existing-private-path': 'none', 'bootstrap-local': 'infrastructure-cost',
  'runner-ready': 'infrastructure-cost', 'private-backend-proof': 'none',
  'remote-import-verified': 'infrastructure-cost', 'remote-ready': 'none',
  'application-foundation': 'infrastructure-cost', 'workflow-source-ready': 'none',
  'dev-proof': 'none', 'staging-qualified': 'none', 'production-rehearsed': 'none',
  'green-red-proof': 'none', 'enforcement-approved': 'enforcement', 'rulesets-applied': 'enforcement',
  'live-readback': 'none', 'bootstrap-state-disposed': 'destructive-disposal'
} as const;

export interface HistoricalActivationState {
  schemaVersion: 1;
  identity: HistoricalActivationIdentity;
  repository: { id: string; name: string; defaultBranch: string };
  activeChange: { id: string; kind: 'openspec' | 'spec-kit' } | null;
  applicability: {
    statePath: 'existing-private' | 'bootstrap-local' | 'none';
    privateStagingDast: boolean;
    credentialRequired: boolean;
  };
  bootstrapState?: BootstrapStateRetention;
  phases: Record<HistoricalPhaseId, PhaseExecutionState>;
  createdAt: string;
  updatedAt: string;
}

export type HistoricalEvidenceHeader = Pick<EvidenceHeader,
  'repositoryId' | 'phaseGraphHash' | 'phaseId' | 'phaseContractDigest' | 'inputDigest' |
  'baselineSha' | 'transition' | 'producedAt' | 'producer' | 'result'
> & {
  schemaVersion: 1;
  identity: HistoricalActivationIdentity;
};
export type HistoricalLiveReadbackProof = Omit<LiveReadbackProof, 'schemaVersion' | 'identity'> & {
  schemaVersion: 1;
  identity: HistoricalActivationIdentity;
};
export interface HistoricalEvidenceRecord {
  evidenceId: string;
  header: HistoricalEvidenceHeader;
  payload?: unknown;
  liveReadback?: HistoricalLiveReadbackProof[];
}
export type HistoricalApprovalEnvelope = Pick<ApprovalEnvelope,
  'id' | 'phaseId' | 'gateKind' | 'baselineSha' | 'planDigest' | 'resources' | 'destinations' |
  'permissions' | 'costCeiling' | 'policyExceptions' | 'destructiveScope' | 'expiresAt' | 'approvedAt' | 'approver'
> & {
  schemaVersion: 1;
  identity: HistoricalActivationIdentity;
};
export type HistoricalSavedTransitionPlan = Pick<SavedTransitionPlan,
  'phaseId' | 'createdAt' | 'expiresAt' | 'graphHash' | 'stateHash' | 'baselineDigest' | 'inputDigest' |
  'transitionDigest' | 'planDigest' | 'mutationClasses' | 'operations' | 'approval' | 'rollbackPlan' | 'noSecrets'
> & {
  schemaVersion: 1;
  identity: HistoricalActivationIdentity;
};

export function phaseId(value: unknown, label: string): HistoricalPhaseId {
  return historyEnum(value, historicalPhaseIds, label);
}

export function assertHistoricalPhasesComplete<T>(
  phases: Partial<Record<HistoricalPhaseId, T>>
): asserts phases is Record<HistoricalPhaseId, T> {
  for (const id of historicalPhaseIds) {
    if (phases[id] === undefined) historyFail(`phases.${id}`, 'is required.');
  }
}

export function readHistoricalEvidenceReference(value: unknown, label: string): EvidenceReference {
  const item = historyExact(value, ['phaseId', 'evidenceId', 'headerDigest', 'result'], label);
  return {
    phaseId: phaseId(item.phaseId, `${label}.phaseId`),
    evidenceId: historyRecordId(item.evidenceId, `${label}.evidenceId`),
    headerDigest: historyDigest(item.headerDigest, `${label}.headerDigest`),
    result: historyEnum(item.result, historicalResults, `${label}.result`)
  };
}

export function validateHistoricalBootstrapState(value: unknown, label: string): BootstrapStateRetention {
  const item = historyExact(value, [
    'status', 'remoteImportEvidenceId', 'remoteImportEvidenceDigest', 'retainedAt', 'disposeAfter',
    'encryptedStatePathParts', 'encryptionKeyPathParts'
  ], label, ['disposedAt', 'deletionEvidenceId', 'incompleteCleanup']);
  const status = historyEnum(item.status, ['retained', 'disposed'], `${label}.status`);
  const retainedAt = historyTimestamp(item.retainedAt, `${label}.retainedAt`);
  const disposeAfter = historyTimestamp(item.disposeAfter, `${label}.disposeAfter`);
  if (Date.parse(disposeAfter) - Date.parse(retainedAt) !== 30 * 24 * 60 * 60 * 1000) {
    historyFail(label, 'disposeAfter must be exactly 30 days after retainedAt.');
  }
  if (status === 'disposed' && !Object.hasOwn(item, 'disposedAt')) historyFail(label, 'disposedAt is required for disposed state.');
  return {
    status,
    remoteImportEvidenceId: historyRecordId(item.remoteImportEvidenceId, `${label}.remoteImportEvidenceId`),
    remoteImportEvidenceDigest: historyDigest(item.remoteImportEvidenceDigest, `${label}.remoteImportEvidenceDigest`),
    retainedAt, disposeAfter,
    encryptedStatePathParts: historyArray(item.encryptedStatePathParts, `${label}.encryptedStatePathParts`)
      .map((entry) => historyPathParts(entry, `${label}.encryptedStatePathParts`)),
    encryptionKeyPathParts: historyArray(item.encryptionKeyPathParts, `${label}.encryptionKeyPathParts`)
      .map((entry) => historyPathParts(entry, `${label}.encryptionKeyPathParts`)),
    ...(Object.hasOwn(item, 'disposedAt') ? { disposedAt: historyTimestamp(item.disposedAt, `${label}.disposedAt`) } : {}),
    ...(Object.hasOwn(item, 'deletionEvidenceId') ? { deletionEvidenceId: historyRecordId(item.deletionEvidenceId, `${label}.deletionEvidenceId`) } : {}),
    ...(Object.hasOwn(item, 'incompleteCleanup') ? { incompleteCleanup: historyStrings(item.incompleteCleanup, `${label}.incompleteCleanup`) } : {})
  };
}

export function readHistoricalEvidenceTransition(value: unknown, label: string): EvidenceHeader['transition'] {
  const item = historyExact(value, ['phaseId', 'baselineSha', 'inputDigest', 'transitionDigest'], label);
  return {
    phaseId: phaseId(item.phaseId, `${label}.phaseId`),
    baselineSha: historyDigest(item.baselineSha, `${label}.baselineSha`),
    inputDigest: historyDigest(item.inputDigest, `${label}.inputDigest`),
    transitionDigest: historyDigest(item.transitionDigest, `${label}.transitionDigest`)
  };
}

export function validateHistoricalEmbeddedPaths(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateHistoricalEmbeddedPaths(entry, `${label}[${index}]`));
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'pathParts' || key.endsWith('PathParts')) {
        const parts = historyArray(entry, `${label}.${key}`);
        if (parts.length === 0 && ['cwdPathParts', 'encryptedStatePathParts', 'encryptionKeyPathParts', 'deletedPathParts'].includes(key)) continue;
        if (parts.length > 0 && Array.isArray(parts[0])) parts.forEach((item) => historyPathParts(item, `${label}.${key}`));
        else historyPathParts(parts, `${label}.${key}`);
      } else validateHistoricalEmbeddedPaths(entry, `${label}.${key}`);
    }
  }
}

export function uniqueSorted<T>(values: T[], key: (value: T) => string, label: string): T[] {
  if (new Set(values.map(key)).size !== values.length) historyFail(label, 'contains duplicate scope entries.');
  return values.sort((a, b) => key(a).localeCompare(key(b), 'en'));
}

export function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : historyString(value, label);
}

export function readHistoricalApprovalFields(value: unknown): Omit<HistoricalApprovalEnvelope, 'schemaVersion' | 'identity'> {
  const label = 'historicalApprovalEnvelope';
  assertSafeHistoricalRecord(value, label);
  const item = historyExact(value, [
    'schemaVersion', 'id', 'phaseId', 'gateKind', 'identity', 'baselineSha', 'planDigest', 'resources',
    'destinations', 'permissions', 'costCeiling', 'policyExceptions', 'destructiveScope', 'expiresAt', 'approvedAt', 'approver'
  ], label);
  const id = phaseId(item.phaseId, `${label}.phaseId`);
  const gateKind = historyEnum(item.gateKind, historicalGateKinds, `${label}.gateKind`);
  if (gateKind !== historicalPhaseGates[id]) historyFail(label, 'approval gate does not match the historical phase.');
  const cost = historyExact(item.costCeiling, ['currency', 'fixedMonthlyCents', 'usageMonthlyCents'], `${label}.costCeiling`);
  const resources = historyArray(item.resources, `${label}.resources`).map((entry, index) => {
    const resource = historyExact(entry, ['type', 'identity'], `${label}.resources[${index}]`);
    return { type: historyString(resource.type, `${label}.resources[${index}].type`).toLowerCase(), identity: historyString(resource.identity, `${label}.resources[${index}].identity`) };
  });
  const destinations = historyArray(item.destinations, `${label}.destinations`).map((entry, index) => {
    const destination = historyExact(entry, ['type', 'identity', 'repository', 'subscriptionId'], `${label}.destinations[${index}]`);
    return {
      type: historyEnum(destination.type, destinationTypes, `${label}.destinations[${index}].type`),
      identity: historyString(destination.identity, `${label}.destinations[${index}].identity`),
      repository: nullableString(destination.repository, `${label}.destinations[${index}].repository`),
      subscriptionId: nullableString(destination.subscriptionId, `${label}.destinations[${index}].subscriptionId`)
    };
  });
  return {
    id: historyRecordId(item.id, `${label}.id`), phaseId: id, gateKind,
    baselineSha: historyDigest(item.baselineSha, `${label}.baselineSha`),
    planDigest: historyDigest(item.planDigest, `${label}.planDigest`),
    resources: uniqueSorted(resources, (entry) => `${entry.type}:${entry.identity}`, `${label}.resources`),
    destinations: uniqueSorted(destinations, (entry) => `${entry.type}:${entry.identity}`, `${label}.destinations`),
    permissions: uniqueSorted(historyStrings(item.permissions, `${label}.permissions`).map((entry) => entry.toLowerCase()), (entry) => entry, `${label}.permissions`),
    costCeiling: {
      currency: historyString(cost.currency, `${label}.costCeiling.currency`),
      fixedMonthlyCents: Math.max(0, Math.trunc(Number(cost.fixedMonthlyCents))),
      usageMonthlyCents: Math.max(0, Math.trunc(Number(cost.usageMonthlyCents)))
    },
    policyExceptions: uniqueSorted(historyStrings(item.policyExceptions, `${label}.policyExceptions`), (entry) => entry, `${label}.policyExceptions`),
    destructiveScope: uniqueSorted(historyStrings(item.destructiveScope, `${label}.destructiveScope`), (entry) => entry, `${label}.destructiveScope`),
    expiresAt: historyTimestamp(item.expiresAt, `${label}.expiresAt`),
    approvedAt: historyTimestamp(item.approvedAt, `${label}.approvedAt`),
    approver: historyString(item.approver, `${label}.approver`)
  };
}

export function operationDestination(value: unknown, label: string): TransitionOperationDestination {
  const item = historyExact(value, ['type', 'identity'], label, ['pathParts', 'repository', 'subscriptionId', 'ref']);
  return {
    type: historyEnum(item.type, destinationTypes, `${label}.type`),
    identity: historyString(item.identity, `${label}.identity`),
    ...(Object.hasOwn(item, 'pathParts') ? { pathParts: historyPathParts(item.pathParts, `${label}.pathParts`) } : {}),
    ...(Object.hasOwn(item, 'repository') ? { repository: historyString(item.repository, `${label}.repository`) } : {}),
    ...(Object.hasOwn(item, 'subscriptionId') ? { subscriptionId: historyString(item.subscriptionId, `${label}.subscriptionId`) } : {}),
    ...(Object.hasOwn(item, 'ref') ? { ref: historyString(item.ref, `${label}.ref`) } : {})
  };
}

export function operation(
  value: unknown, label: string,
  mutationClasses: readonly TransitionOperation['mutationClass'][] = historicalMutationClasses
): TransitionOperation {
  const item = historyExact(value, ['adapter', 'actionId', 'mutationClass', 'phaseId', 'inputs', 'destination', 'remote', 'destructive'], label);
  const inputs = historyRecord(item.inputs, `${label}.inputs`);
  validateHistoricalEmbeddedPaths(inputs, `${label}.inputs`);
  return {
    adapter: historyEnum(item.adapter, adapterIds, `${label}.adapter`),
    actionId: historyString(item.actionId, `${label}.actionId`),
    mutationClass: historyEnum(item.mutationClass, mutationClasses, `${label}.mutationClass`),
    phaseId: phaseId(item.phaseId, `${label}.phaseId`), inputs,
    destination: operationDestination(item.destination, `${label}.destination`),
    remote: historyBoolean(item.remote, `${label}.remote`), destructive: historyBoolean(item.destructive, `${label}.destructive`)
  };
}

export function evaluation(value: unknown, label: string): ApprovalEvaluation {
  const item = historyExact(value, [
    'phaseId', 'gateKind', 'questionKind', 'approvalRequired', 'status', 'envelopeId', 'envelopeHash', 'reasons', 'expansionReasons'
  ], label);
  return {
    phaseId: phaseId(item.phaseId, `${label}.phaseId`),
    gateKind: historyEnum(item.gateKind, historicalGateKinds, `${label}.gateKind`),
    questionKind: item.questionKind === null ? null : historyEnum(item.questionKind, historicalQuestionKinds, `${label}.questionKind`),
    approvalRequired: historyBoolean(item.approvalRequired, `${label}.approvalRequired`),
    status: historyEnum(item.status, ['not-required', 'approval-required', 'reused', 'expired', 'invalidated'], `${label}.status`),
    envelopeId: item.envelopeId === null ? null : historyRecordId(item.envelopeId, `${label}.envelopeId`),
    envelopeHash: item.envelopeHash === null ? null : historyDigest(item.envelopeHash, `${label}.envelopeHash`),
    reasons: historyStrings(item.reasons, `${label}.reasons`), expansionReasons: historyStrings(item.expansionReasons, `${label}.expansionReasons`)
  };
}

export function rollbackPlan(
  value: unknown, label: string,
  mutationClasses: readonly TransitionOperation['mutationClass'][] = historicalMutationClasses
): TransitionRollbackPlan {
  const item = historyExact(value, ['phaseId', 'strategy', 'target', 'operations', 'retained', 'cleanupWarnings'], label);
  return {
    phaseId: phaseId(item.phaseId, `${label}.phaseId`),
    strategy: historyEnum(item.strategy, ['none', 'retain', 'reverse-to', 'dispose'], `${label}.strategy`),
    target: item.target === null ? null : phaseId(item.target, `${label}.target`),
    operations: historyArray(item.operations, `${label}.operations`).map((entry, index) => operation(entry, `${label}.operations[${index}]`, mutationClasses)),
    retained: historyStrings(item.retained, `${label}.retained`), cleanupWarnings: historyStrings(item.cleanupWarnings, `${label}.cleanupWarnings`)
  };
}

export function readHistoricalSavedTransitionPlan(
  value: unknown, identityReader: typeof historicalIdentity
): HistoricalSavedTransitionPlan {
  const label = 'historicalTransitionPlan';
  assertSafeHistoricalRecord(value, label);
  const item = historyExact(value, [
    'schemaVersion', 'phaseId', 'createdAt', 'expiresAt', 'identity', 'graphHash', 'stateHash',
    'baselineDigest', 'inputDigest', 'transitionDigest', 'planDigest', 'mutationClasses', 'operations',
    'approval', 'rollbackPlan', 'noSecrets'
  ], label);
  const identity = identityReader(item.identity, `${label}.identity`);
  const allowedMutationClasses = identity.activationContractVersion === 1
    ? historicalMutationClasses : [...historicalMutationClasses, 'write-seed-tasks'] as const;
  const graphHash = historyDigest(item.graphHash, `${label}.graphHash`);
  if (graphHash !== identity.phaseGraphHash) historyFail(label, 'graphHash contradicts the historical identity.');
  const id = phaseId(item.phaseId, `${label}.phaseId`);
  const operations = historyArray(item.operations, `${label}.operations`).map((entry, index) => operation(entry, `${label}.operations[${index}]`, allowedMutationClasses));
  if (operations.some((entry) => entry.phaseId !== id)) historyFail(label, 'operation phase differs from its plan.');
  const mutations = historyExact(item.mutationClasses, ['local', 'remote'], `${label}.mutationClasses`);
  const approval = historyExact(item.approval, ['gateKind', 'required', 'evaluation', 'envelopeId', 'envelopeHash'], `${label}.approval`);
  const approvalEvaluation = evaluation(approval.evaluation, `${label}.approval.evaluation`);
  const gateKind = historyEnum(approval.gateKind, historicalGateKinds, `${label}.approval.gateKind`);
  const required = historyBoolean(approval.required, `${label}.approval.required`);
  const envelopeId = approval.envelopeId === null ? null : historyRecordId(approval.envelopeId, `${label}.approval.envelopeId`);
  const envelopeHash = approval.envelopeHash === null ? null : historyDigest(approval.envelopeHash, `${label}.approval.envelopeHash`);
  if (gateKind !== historicalPhaseGates[id] || required !== (gateKind !== 'none') ||
    approvalEvaluation.phaseId !== id || approvalEvaluation.gateKind !== gateKind ||
    approvalEvaluation.envelopeId !== envelopeId || approvalEvaluation.envelopeHash !== envelopeHash ||
    (envelopeId === null) !== (envelopeHash === null)) {
    historyFail(label, 'approval references or gate contradict the historical phase.');
  }
  const rollback = rollbackPlan(item.rollbackPlan, `${label}.rollbackPlan`, allowedMutationClasses);
  if (rollback.phaseId !== id) historyFail(label, 'rollback names another phase.');
  return {
    schemaVersion: historyLiteral(item.schemaVersion, 1, `${label}.schemaVersion`), phaseId: id,
    createdAt: historyTimestamp(item.createdAt, `${label}.createdAt`),
    expiresAt: historyTimestamp(item.expiresAt, `${label}.expiresAt`), identity, graphHash,
    stateHash: item.stateHash === null ? null : historyDigest(item.stateHash, `${label}.stateHash`),
    baselineDigest: historyDigest(item.baselineDigest, `${label}.baselineDigest`),
    inputDigest: historyDigest(item.inputDigest, `${label}.inputDigest`),
    transitionDigest: historyDigest(item.transitionDigest, `${label}.transitionDigest`),
    planDigest: historyDigest(item.planDigest, `${label}.planDigest`),
    mutationClasses: {
      local: historyStrings(mutations.local, `${label}.mutationClasses.local`).map((entry) => historyEnum(entry, allowedMutationClasses, `${label}.mutationClasses.local`)),
      remote: historyStrings(mutations.remote, `${label}.mutationClasses.remote`).map((entry) => historyEnum(entry, allowedMutationClasses, `${label}.mutationClasses.remote`))
    },
    operations,
    approval: { gateKind, required, evaluation: approvalEvaluation, envelopeId, envelopeHash },
    rollbackPlan: rollback,
    noSecrets: historyLiteral(item.noSecrets, true, `${label}.noSecrets`)
  };
}
