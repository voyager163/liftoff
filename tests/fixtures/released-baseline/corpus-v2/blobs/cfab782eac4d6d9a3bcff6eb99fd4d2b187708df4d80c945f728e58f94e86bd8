import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../domain/governance/activation/graph.js';
import type {
  ApprovalEnvelope, ApprovalEvaluation, BootstrapStateRetention, EvidenceHeader,
  EvidenceReference, LiveReadbackProof, PhaseExecutionState, SavedTransitionPlan,
  TransitionOperation, TransitionOperationDestination, TransitionRollbackPlan
} from '../domain/governance/activation/types.js';
import type { HistoricalActivationIdentity } from '../domain/governance/policy/identity.js';
import type { ProjectFileSnapshot } from '../adapters/filesystem/project-transaction.js';
import { errorCode } from '../adapters/filesystem/errors.js';
import { parseManifest } from '../application/project/manifest.js';
import type { LiftoffManifest } from '../domain/project/contracts.js';
import {
  ActivationHistoryError, historicalIdentity, historyArray, historyBoolean, historyCaseKey,
  historyDigest, historyEnum, historyExact, historyFail, historyLiteral, historyPathKey,
  historyPathParts, historyRecord, historyRecordId, historyString, historyStrings, historyTimestamp,
  historicalActivationIdentity, historicalActivationStatePathParts, historicalManifestPathParts, historicalMetadataPathParts,
  parseHistoryJson, rawHistoryDigest, type HistoricalFileKind
} from './history-contracts.js';
import { FileSystemError } from '../domain/project/errors.js';
import { validateGovernanceCompatibilityMetadata } from './compatibility.js';

// Frozen from 57eba97^:src/governance-activation/{types,validators,graph}.ts.
// These schemas are historical readers, never current execution validators.
export const historicalPhaseIds = [
  'seed-valid', 'seed-verified', 'seed-archived', 'committed', 'pushed', 'phase-0-complete',
  'activation-approved', 'credential-ready', 'provider-ready', 'state-path-selected',
  'existing-private-path', 'bootstrap-local', 'runner-ready', 'private-backend-proof',
  'remote-import-verified', 'remote-ready', 'application-foundation', 'workflow-source-ready',
  'dev-proof', 'staging-qualified', 'production-rehearsed', 'green-red-proof',
  'enforcement-approved', 'rulesets-applied', 'live-readback', 'bootstrap-state-disposed'
] as const;
export type HistoricalPhaseId = typeof historicalPhaseIds[number];
const historicalPhaseStates = [
  'pending', 'blocked', 'ready', 'approved', 'running', 'verified', 'failed', 'inapplicable', 'retained', 'disposed'
] as const;
const historicalResults = ['verified', 'failed', 'inapplicable', 'retained', 'disposed'] as const;
const historicalMutationClasses = [
  'none', 'read-worktree', 'write-activation-state', 'write-evidence', 'write-openspec-seed',
  'write-openspec-governance', 'write-local-state', 'delete-local-state', 'write-workflows',
  'write-ruleset-source', 'git-commit', 'git-push', 'github-read', 'github-write',
  'github-secret-write', 'azure-read', 'azure-provider-register', 'azure-network-provision',
  'azure-state-import', 'azure-resource-provision', 'github-ruleset-write'
] as const;
const historicalGateKinds = [
  'none', 'repository-publish', 'activation-plan', 'credential-enrollment', 'infrastructure-cost',
  'enforcement', 'destructive-disposal', 'external-blocker'
] as const;
const historicalQuestionKinds = [
  'repository-creation-initial-commit-push', 'credential-enrollment',
  'billed-infrastructure-policy-exception-cost-ceiling', 'final-enforcement',
  'destructive-operation', 'external-blocker'
] as const;
const destinationTypes = ['local', 'repository', 'subscription', 'environment', 'tenant', 'external'] as const;
const adapterIds = ['local-evidence', 'selected-spec-workflow', 'git', 'github', 'azure-opentofu', 'local-state'] as const;
const historicalPhaseGates = {
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

export type HistoricalEvidenceHeader = Omit<EvidenceHeader, 'schemaVersion' | 'identity' | 'bodyDigest' | 'remoteBindingDigest'> & {
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
export type HistoricalApprovalEnvelope = Omit<ApprovalEnvelope, 'schemaVersion' | 'identity'> & {
  schemaVersion: 1;
  identity: HistoricalActivationIdentity;
};
export type HistoricalSavedTransitionPlan = Omit<SavedTransitionPlan, 'identity'> & {
  identity: HistoricalActivationIdentity;
};

function phaseId(value: unknown, label: string): HistoricalPhaseId {
  return historyEnum(value, historicalPhaseIds, label);
}

export function assertHistoricalPhasesComplete<T>(
  phases: Partial<Record<HistoricalPhaseId, T>>
): asserts phases is Record<HistoricalPhaseId, T> {
  for (const id of historicalPhaseIds) {
    if (phases[id] === undefined) historyFail(`phases.${id}`, 'is required.');
  }
}

function reference(value: unknown, label: string): EvidenceReference {
  const item = historyExact(value, ['phaseId', 'evidenceId', 'headerDigest', 'result'], label);
  return {
    phaseId: phaseId(item.phaseId, `${label}.phaseId`),
    evidenceId: historyRecordId(item.evidenceId, `${label}.evidenceId`),
    headerDigest: historyDigest(item.headerDigest, `${label}.headerDigest`),
    result: historyEnum(item.result, historicalResults, `${label}.result`)
  };
}

function retention(value: unknown, label: string): BootstrapStateRetention {
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

export function validateHistoricalActivationState(value: unknown): HistoricalActivationState {
  const label = 'historicalActivationState';
  const state = historyExact(value, [
    'schemaVersion', 'identity', 'repository', 'activeChange', 'applicability', 'phases', 'createdAt', 'updatedAt'
  ], label, ['bootstrapState']);
  historyLiteral(state.schemaVersion, 1, `${label}.schemaVersion`);
  const identity = historicalIdentity(state.identity, `${label}.identity`);
  const repository = historyExact(state.repository, ['id', 'name', 'defaultBranch'], `${label}.repository`);
  const applicability = historyExact(state.applicability, ['statePath', 'privateStagingDast', 'credentialRequired'], `${label}.applicability`);
  let activeChange: HistoricalActivationState['activeChange'] = null;
  if (state.activeChange !== null) {
    const change = historyExact(state.activeChange, ['id', 'kind'], `${label}.activeChange`);
    activeChange = {
      id: historyRecordId(change.id, `${label}.activeChange.id`),
      kind: historyEnum(change.kind, ['openspec', 'spec-kit'], `${label}.activeChange.kind`)
    };
  }
  const rawPhases = historyExact(state.phases, historicalPhaseIds, `${label}.phases`);
  const phases: Partial<Record<HistoricalPhaseId, PhaseExecutionState>> = {};
  for (const id of historicalPhaseIds) {
    const at = `${label}.phases.${id}`;
    const phase = historyExact(rawPhases[id], ['state', 'updatedAt', 'evidence', 'approvals', 'blockers'], at);
    const evidence = historyArray(phase.evidence, `${at}.evidence`).map((entry, index) => reference(entry, `${at}.evidence[${index}]`));
    if (evidence.some((entry) => entry.phaseId !== id)) historyFail(at, 'evidence reference names another phase.');
    const approvals = historyArray(phase.approvals, `${at}.approvals`).map((entry) => historyRecordId(entry, `${at}.approvals`));
    if (new Set(evidence.map((entry) => entry.evidenceId)).size !== evidence.length || new Set(approvals).size !== approvals.length) {
      historyFail(at, 'contains duplicate evidence or approval references.');
    }
    phases[id] = {
      state: historyEnum(phase.state, historicalPhaseStates, `${at}.state`),
      updatedAt: historyString(phase.updatedAt, `${at}.updatedAt`),
      evidence, approvals, blockers: historyStrings(phase.blockers, `${at}.blockers`)
    };
  }
  assertHistoricalPhasesComplete(phases);
  return {
    schemaVersion: 1, identity,
    repository: {
      id: historyString(repository.id, `${label}.repository.id`),
      name: historyString(repository.name, `${label}.repository.name`),
      defaultBranch: historyString(repository.defaultBranch, `${label}.repository.defaultBranch`)
    },
    activeChange,
    applicability: {
      statePath: historyEnum(applicability.statePath, ['existing-private', 'bootstrap-local', 'none'], `${label}.applicability.statePath`),
      privateStagingDast: historyBoolean(applicability.privateStagingDast, `${label}.applicability.privateStagingDast`),
      credentialRequired: historyBoolean(applicability.credentialRequired, `${label}.applicability.credentialRequired`)
    },
    ...(Object.hasOwn(state, 'bootstrapState') ? { bootstrapState: retention(state.bootstrapState, `${label}.bootstrapState`) } : {}),
    phases, createdAt: historyString(state.createdAt, `${label}.createdAt`),
    updatedAt: historyString(state.updatedAt, `${label}.updatedAt`)
  };
}

function transition(value: unknown, label: string): EvidenceHeader['transition'] {
  const item = historyExact(value, ['phaseId', 'baselineSha', 'inputDigest', 'transitionDigest'], label);
  return {
    phaseId: phaseId(item.phaseId, `${label}.phaseId`),
    baselineSha: historyDigest(item.baselineSha, `${label}.baselineSha`),
    inputDigest: historyDigest(item.inputDigest, `${label}.inputDigest`),
    transitionDigest: historyDigest(item.transitionDigest, `${label}.transitionDigest`)
  };
}

function historicalProofIdentity(item: Record<string, unknown>, label: string) {
  const identity = historicalIdentity(item.identity, `${label}.identity`);
  const graphHash = historyDigest(item.phaseGraphHash, `${label}.phaseGraphHash`);
  if (graphHash !== identity.phaseGraphHash) historyFail(label, 'graph hash contradicts the historical identity.');
  const id = phaseId(item.phaseId, `${label}.phaseId`);
  const baselineSha = historyDigest(item.baselineSha, `${label}.baselineSha`);
  const inputDigest = historyDigest(item.inputDigest, `${label}.inputDigest`);
  const proofTransition = transition(item.transition, `${label}.transition`);
  if (proofTransition.phaseId !== id || proofTransition.baselineSha !== baselineSha || proofTransition.inputDigest !== inputDigest) {
    historyFail(label, 'transition contradicts the proof phase, baseline or inputs.');
  }
  return {
    schemaVersion: historyLiteral(item.schemaVersion, 1, `${label}.schemaVersion`),
    identity, phaseGraphHash: graphHash, phaseId: id, baselineSha, inputDigest, transition: proofTransition,
    repositoryId: historyString(item.repositoryId, `${label}.repositoryId`)
  };
}

export function validateHistoricalEvidenceHeader(value: unknown): HistoricalEvidenceHeader {
  const label = 'historicalEvidenceHeader';
  const item = historyExact(value, [
    'schemaVersion', 'repositoryId', 'identity', 'phaseGraphHash', 'phaseId', 'phaseContractDigest',
    'inputDigest', 'baselineSha', 'transition', 'producedAt', 'producer', 'result'
  ], label);
  return {
    ...historicalProofIdentity(item, label),
    phaseContractDigest: historyDigest(item.phaseContractDigest, `${label}.phaseContractDigest`),
    producedAt: historyTimestamp(item.producedAt, `${label}.producedAt`),
    producer: historyString(item.producer, `${label}.producer`),
    result: historyEnum(item.result, historicalResults, `${label}.result`)
  };
}

export function validateHistoricalLiveReadback(value: unknown): HistoricalLiveReadbackProof {
  const label = 'historicalLiveReadback';
  const item = historyExact(value, [
    'schemaVersion', 'repositoryId', 'identity', 'phaseGraphHash', 'phaseId', 'baselineSha', 'inputDigest',
    'transition', 'observedAt', 'provider', 'resourceType', 'resourceId', 'sourceDigest', 'readbackDigest', 'matches'
  ], label);
  return {
    ...historicalProofIdentity(item, label),
    observedAt: historyTimestamp(item.observedAt, `${label}.observedAt`),
    provider: historyEnum(item.provider, ['github', 'azure'], `${label}.provider`),
    resourceType: historyString(item.resourceType, `${label}.resourceType`),
    resourceId: historyString(item.resourceId, `${label}.resourceId`),
    sourceDigest: historyDigest(item.sourceDigest, `${label}.sourceDigest`),
    readbackDigest: historyDigest(item.readbackDigest, `${label}.readbackDigest`),
    matches: historyBoolean(item.matches, `${label}.matches`)
  };
}

function validateEmbeddedPaths(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateEmbeddedPaths(entry, `${label}[${index}]`));
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'pathParts' || key.endsWith('PathParts')) {
        const parts = historyArray(entry, `${label}.${key}`);
        if (parts.length === 0 && ['cwdPathParts', 'encryptedStatePathParts', 'encryptionKeyPathParts', 'deletedPathParts'].includes(key)) continue;
        if (parts.length > 0 && Array.isArray(parts[0])) parts.forEach((item) => historyPathParts(item, `${label}.${key}`));
        else historyPathParts(parts, `${label}.${key}`);
      } else validateEmbeddedPaths(entry, `${label}.${key}`);
    }
  }
}

export function validateHistoricalEvidenceRecord(value: unknown, headerOnlyEvidenceId?: string): HistoricalEvidenceRecord {
  const label = 'historicalEvidenceRecord';
  const item = historyRecord(value, label);
  // Header-only JSON was an explicit v1 format in commands.ts, not an unversioned import.
  if (!Object.hasOwn(item, 'header')) {
    return {
      evidenceId: historyRecordId(headerOnlyEvidenceId, `${label}.registeredHeaderOnlyEvidenceId`),
      header: validateHistoricalEvidenceHeader(item)
    };
  }
  historyExact(item, ['evidenceId', 'header'], label, ['payload', 'liveReadback']);
  if (Object.hasOwn(item, 'payload')) validateEmbeddedPaths(item.payload, `${label}.payload`);
  const header = validateHistoricalEvidenceHeader(item.header);
  const liveReadback = Object.hasOwn(item, 'liveReadback')
    ? historyArray(item.liveReadback, `${label}.liveReadback`).map(validateHistoricalLiveReadback) : undefined;
  if (liveReadback?.some((proof) =>
    proof.repositoryId !== header.repositoryId || proof.phaseId !== header.phaseId ||
    canonicalSha256(proof.transition) !== canonicalSha256(header.transition))) {
    historyFail(label, 'live readback contradicts its enclosing evidence record.');
  }
  return {
    evidenceId: historyRecordId(item.evidenceId, `${label}.evidenceId`), header,
    ...(Object.hasOwn(item, 'payload') ? { payload: item.payload } : {}),
    ...(liveReadback === undefined ? {} : { liveReadback })
  };
}

function uniqueSorted<T>(values: T[], key: (value: T) => string, label: string): T[] {
  if (new Set(values.map(key)).size !== values.length) historyFail(label, 'contains duplicate scope entries.');
  return values.sort((a, b) => key(a).localeCompare(key(b), 'en'));
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : historyString(value, label);
}

export function validateHistoricalApprovalEnvelope(value: unknown): HistoricalApprovalEnvelope {
  const label = 'historicalApprovalEnvelope';
  const item = historyExact(value, [
    'schemaVersion', 'id', 'phaseId', 'gateKind', 'identity', 'baselineSha', 'planDigest', 'resources',
    'destinations', 'permissions', 'costCeiling', 'policyExceptions', 'destructiveScope', 'expiresAt', 'approvedAt', 'approver'
  ], label);
  const id = phaseId(item.phaseId, `${label}.phaseId`);
  const gateKind = historyEnum(item.gateKind, historicalGateKinds, `${label}.gateKind`);
  if (gateKind !== historicalPhaseGates[id]) historyFail(label, 'gate does not match its historical phase.');
  const resources = historyArray(item.resources, `${label}.resources`).map((entry, index) => {
    const at = `${label}.resources[${index}]`;
    const resource = historyExact(entry, ['type', 'identity'], at);
    return { type: historyString(resource.type, `${at}.type`).trim().toLowerCase(), identity: historyString(resource.identity, `${at}.identity`).trim() };
  });
  const destinations = historyArray(item.destinations, `${label}.destinations`).map((entry, index) => {
    const at = `${label}.destinations[${index}]`;
    const destination = historyExact(entry, ['type', 'identity', 'repository', 'subscriptionId'], at);
    return {
      type: historyEnum(destination.type, destinationTypes, `${at}.type`),
      identity: historyString(destination.identity, `${at}.identity`).trim(),
      repository: nullableString(destination.repository, `${at}.repository`)?.trim() ?? null,
      subscriptionId: nullableString(destination.subscriptionId, `${at}.subscriptionId`)?.trim() ?? null
    };
  });
  const cost = historyExact(item.costCeiling, ['currency', 'fixedMonthlyCents', 'usageMonthlyCents'], `${label}.costCeiling`);
  const currency = historyString(cost.currency, `${label}.costCeiling.currency`).trim();
  if (!/^[A-Z]{3}$/u.test(currency)) historyFail(label, 'cost currency must be a three-letter uppercase ISO currency.');
  const cents = (value: unknown, at: string): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) historyFail(at, 'must be non-negative safe integer cents.');
    return value;
  };
  const scopeStrings = (value: unknown, at: string, lower = false) =>
    uniqueSorted(historyStrings(value, at).map((entry) => lower ? entry.trim().toLowerCase() : entry.trim()), (entry) => entry, at);
  return {
    schemaVersion: historyLiteral(item.schemaVersion, 1, `${label}.schemaVersion`),
    id: historyRecordId(item.id, `${label}.id`), phaseId: id, gateKind,
    identity: historicalIdentity(item.identity, `${label}.identity`),
    baselineSha: historyDigest(item.baselineSha, `${label}.baselineSha`),
    planDigest: historyDigest(item.planDigest, `${label}.planDigest`),
    resources: uniqueSorted(resources, canonicalJson, `${label}.resources`),
    destinations: uniqueSorted(destinations, canonicalJson, `${label}.destinations`),
    permissions: scopeStrings(item.permissions, `${label}.permissions`, true),
    costCeiling: {
      currency, fixedMonthlyCents: cents(cost.fixedMonthlyCents, `${label}.costCeiling.fixedMonthlyCents`),
      usageMonthlyCents: cents(cost.usageMonthlyCents, `${label}.costCeiling.usageMonthlyCents`)
    },
    policyExceptions: scopeStrings(item.policyExceptions, `${label}.policyExceptions`),
    destructiveScope: scopeStrings(item.destructiveScope, `${label}.destructiveScope`),
    expiresAt: historyTimestamp(item.expiresAt, `${label}.expiresAt`),
    approvedAt: historyTimestamp(item.approvedAt, `${label}.approvedAt`),
    approver: historyString(item.approver, `${label}.approver`)
  };
}

export function historicalApprovalEnvelopeHash(envelope: HistoricalApprovalEnvelope): string {
  const { id: _id, approvedAt: _approvedAt, approver: _approver, ...scope } = validateHistoricalApprovalEnvelope(envelope);
  return canonicalSha256(scope);
}

function operationDestination(value: unknown, label: string): TransitionOperationDestination {
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

function operation(value: unknown, label: string): TransitionOperation {
  const item = historyExact(value, ['adapter', 'actionId', 'mutationClass', 'phaseId', 'inputs', 'destination', 'remote', 'destructive'], label);
  const inputs = historyRecord(item.inputs, `${label}.inputs`);
  validateEmbeddedPaths(inputs, `${label}.inputs`);
  return {
    adapter: historyEnum(item.adapter, adapterIds, `${label}.adapter`),
    actionId: historyString(item.actionId, `${label}.actionId`),
    mutationClass: historyEnum(item.mutationClass, historicalMutationClasses, `${label}.mutationClass`),
    phaseId: phaseId(item.phaseId, `${label}.phaseId`), inputs,
    destination: operationDestination(item.destination, `${label}.destination`),
    remote: historyBoolean(item.remote, `${label}.remote`), destructive: historyBoolean(item.destructive, `${label}.destructive`)
  };
}

function evaluation(value: unknown, label: string): ApprovalEvaluation {
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

function rollbackPlan(value: unknown, label: string): TransitionRollbackPlan {
  const item = historyExact(value, ['phaseId', 'strategy', 'target', 'operations', 'retained', 'cleanupWarnings'], label);
  return {
    phaseId: phaseId(item.phaseId, `${label}.phaseId`),
    strategy: historyEnum(item.strategy, ['none', 'retain', 'reverse-to', 'dispose'], `${label}.strategy`),
    target: item.target === null ? null : phaseId(item.target, `${label}.target`),
    operations: historyArray(item.operations, `${label}.operations`).map((entry, index) => operation(entry, `${label}.operations[${index}]`)),
    retained: historyStrings(item.retained, `${label}.retained`), cleanupWarnings: historyStrings(item.cleanupWarnings, `${label}.cleanupWarnings`)
  };
}

export function validateHistoricalSavedTransitionPlan(value: unknown): HistoricalSavedTransitionPlan {
  const label = 'historicalTransitionPlan';
  const item = historyExact(value, [
    'schemaVersion', 'phaseId', 'createdAt', 'expiresAt', 'identity', 'graphHash', 'stateHash',
    'baselineDigest', 'inputDigest', 'transitionDigest', 'planDigest', 'mutationClasses', 'operations',
    'approval', 'rollbackPlan', 'noSecrets'
  ], label);
  const identity = historicalIdentity(item.identity, `${label}.identity`);
  const graphHash = historyDigest(item.graphHash, `${label}.graphHash`);
  if (graphHash !== identity.phaseGraphHash) historyFail(label, 'graphHash contradicts the historical identity.');
  const id = phaseId(item.phaseId, `${label}.phaseId`);
  const operations = historyArray(item.operations, `${label}.operations`).map((entry, index) => operation(entry, `${label}.operations[${index}]`));
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
  const rollback = rollbackPlan(item.rollbackPlan, `${label}.rollbackPlan`);
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
      local: historyArray(mutations.local, `${label}.mutationClasses.local`).map((entry) => historyEnum(entry, historicalMutationClasses, `${label}.mutationClasses.local`)),
      remote: historyArray(mutations.remote, `${label}.mutationClasses.remote`).map((entry) => historyEnum(entry, historicalMutationClasses, `${label}.mutationClasses.remote`))
    },
    operations, approval: { gateKind, required, evaluation: approvalEvaluation, envelopeId, envelopeHash },
    rollbackPlan: rollback, noSecrets: historyLiteral(item.noSecrets, true, `${label}.noSecrets`)
  };
}

export function historicalTransitionPlanPathParts(plan: HistoricalSavedTransitionPlan): string[] {
  return historyPathParts([
    'governance', 'plans', `${plan.phaseId}-${plan.createdAt.replace(/[^0-9A-Za-z]/g, '')}-${plan.planDigest.slice(0, 12)}.json`
  ], 'historical transition plan path');
}

export interface HistoricalSourceFile {
  kind: HistoricalFileKind;
  pathParts: string[];
  content: Buffer;
  digest: string;
  mode: number;
}

export interface HistoricalActivationInventory {
  manifest: LiftoffManifest;
  state: HistoricalActivationState;
  files: HistoricalSourceFile[];
  unreviewedRecords: HistoricalSourceFile[];
  preconditions: ProjectFileSnapshot[];
}

export interface HistoricalInventoryOptions {
  reviewedUnreferencedPathParts?: readonly (readonly string[])[];
}

export async function resolveHistoryProjectPath(projectRoot: string, rawParts: readonly string[]): Promise<string> {
  const parts = historyPathParts(rawParts, 'history path');
  const root = path.resolve(projectRoot);
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) historyFail(root, 'project root must be a real directory.', 'unsafe-history-path');
  const canonicalRoot = await realpath(root);
  let cursor = canonicalRoot;
  for (let index = 0; index < parts.length; index += 1) {
    let names: string[];
    try { names = await readdir(cursor); }
    catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      return path.join(canonicalRoot, ...parts);
    }
    const part = parts[index];
    const matches = names.filter((name) => historyCaseKey([name]) === historyCaseKey([part]));
    if (matches.length > 1 || matches.length === 1 && matches[0] !== part) {
      historyFail(historyPathKey(parts), `case-colliding path segment ${JSON.stringify(part)}.`, 'history-path-collision');
    }
    cursor = path.join(cursor, part);
    let details;
    try { details = await lstat(cursor); }
    catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      return path.join(canonicalRoot, ...parts);
    }
    if (details.isSymbolicLink() || details.isFile() && details.nlink !== 1) {
      historyFail(historyPathKey(parts), 'symbolic links, junctions and hard-linked files are not historical migration targets.', 'unsafe-history-path');
    }
    if (index < parts.length - 1 && !details.isDirectory()) {
      historyFail(historyPathKey(parts), 'a parent is not a directory.', 'unsafe-history-path');
    }
  }
  return cursor;
}

export async function captureHistoryFile(projectRoot: string, parts: readonly string[]): Promise<ProjectFileSnapshot> {
  const pathParts = historyPathParts(parts, 'history file path');
  const target = await resolveHistoryProjectPath(projectRoot, pathParts);
  let details;
  try { details = await lstat(target); }
  catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    return { pathParts };
  }
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
    historyFail(historyPathKey(pathParts), 'must be a regular unlinked file.', 'unsafe-history-path');
  }
  const content = await readFile(target);
  const after = await lstat(target);
  if (after.ino !== details.ino || after.dev !== details.dev || after.mode !== details.mode ||
    after.size !== details.size || after.mtimeMs !== details.mtimeMs || after.nlink !== 1) {
    historyFail(historyPathKey(pathParts), 'changed while being read; obtain a fresh preview.', 'historical-source-changed');
  }
  return { pathParts, content, mode: details.mode & 0o7777 };
}

export function validateHistoricalSourceManifest(value: unknown): LiftoffManifest {
  const label = 'historicalSourceManifest';
  const raw = historyRecord(value, label);
  historyLiteral(raw.artifactVersion, 7, `${label}.artifactVersion`);
  const governance = historyRecord(raw.governance, `${label}.governance`);
  historicalIdentity(governance.activationIdentity, `${label}.governance.activationIdentity`);
  try {
    return parseManifest(raw);
  } catch (error) {
    if (!(error instanceof FileSystemError)) throw error;
    return historyFail(label, error.message, 'invalid-historical-manifest');
  }
}

function validateHistoricalCompatibility(value: unknown, label: string): void {
  const item = historyExact(value, [
    'schemaVersion', 'generatedBy', 'liftoffVersion', 'minimumLiftoffVersions', 'manifest', 'activation', 'managedCore'
  ], label);
  historyLiteral(item.schemaVersion, 1, `${label}.schemaVersion`);
  historyLiteral(item.generatedBy, 'Mission Control Liftoff', `${label}.generatedBy`);
  historyLiteral(item.liftoffVersion, historicalActivationIdentity.liftoffVersion, `${label}.liftoffVersion`);
  const minimum = historyExact(item.minimumLiftoffVersions, ['manifestWriteVersion7', 'remedy'], `${label}.minimumLiftoffVersions`);
  historyLiteral(minimum.manifestWriteVersion7, '0.10.0', `${label}.minimumLiftoffVersions.manifestWriteVersion7`);
  historyString(minimum.remedy, `${label}.minimumLiftoffVersions.remedy`);
  const manifest = historyExact(item.manifest, ['readVersions', 'writeVersion', 'hashAuthority'], `${label}.manifest`);
  if (canonicalJson(manifest.readVersions) !== canonicalJson([2, 3, 4, 5, 6, 7])) historyFail(label, 'has an unknown historical manifest reader declaration.');
  historyLiteral(manifest.writeVersion, 7, `${label}.manifest.writeVersion`);
  historyLiteral(manifest.hashAuthority, 'liftoff.manifest.json managedArtifacts[].contentHash', `${label}.manifest.hashAuthority`);
  const activation = historyExact(item.activation, [
    'currentCompatibleTuples', 'recognizedGraphHashes', 'graphMappings', 'historicalStateMigrations', 'unsupportedRemedy'
  ], `${label}.activation`);
  const tuples = historyArray(activation.currentCompatibleTuples, `${label}.activation.currentCompatibleTuples`);
  if (tuples.length !== 1) historyFail(label, 'requires the single registered historical activation tuple.');
  historicalIdentity(tuples[0], `${label}.activation.currentCompatibleTuples[0]`);
  if (canonicalJson(activation.recognizedGraphHashes) !== canonicalJson([historicalActivationIdentity.phaseGraphHash]) ||
    canonicalJson(activation.graphMappings) !== '[]\n' || canonicalJson(activation.historicalStateMigrations) !== '[]\n') {
    historyFail(label, 'contains an unknown historical graph or migration declaration.');
  }
  historyString(activation.unsupportedRemedy, `${label}.activation.unsupportedRemedy`);
  const core = historyExact(item.managedCore, ['logicalNameAllowlist', 'pathAllowlist', 'updateInventory', 'validation'], `${label}.managedCore`);
  const logicalNames = historyStrings(core.logicalNameAllowlist, `${label}.managedCore.logicalNameAllowlist`);
  const paths = historyArray(core.pathAllowlist, `${label}.managedCore.pathAllowlist`).map((entry) =>
    historyPathParts(entry, `${label}.managedCore.pathAllowlist`));
  const entries = historyArray(core.updateInventory, `${label}.managedCore.updateInventory`).map((entry, index) => {
    const at = `${label}.managedCore.updateInventory[${index}]`;
    const file = historyExact(entry, ['logicalName', 'pathParts', 'lifecycle', 'contentHashAuthority'], at);
    historyLiteral(file.lifecycle, 'managed-core', `${at}.lifecycle`);
    historyLiteral(file.contentHashAuthority, 'liftoff.manifest.json managedArtifacts[].contentHash', `${at}.contentHashAuthority`);
    return { logicalName: historyString(file.logicalName, `${at}.logicalName`), pathParts: historyPathParts(file.pathParts, `${at}.pathParts`) };
  });
  if (new Set(logicalNames).size !== logicalNames.length ||
    new Set(paths.map(historyCaseKey)).size !== paths.length ||
    new Set(entries.map((entry) => entry.logicalName)).size !== entries.length ||
    new Set(entries.map((entry) => historyCaseKey(entry.pathParts))).size !== entries.length ||
    entries.length !== paths.length ||
    entries.some((entry) => !logicalNames.includes(entry.logicalName) || !paths.some((parts) => historyPathKey(parts) === historyPathKey(entry.pathParts)))) {
    historyFail(label, 'managed inventory and exact allowlists disagree.');
  }
  const validation = historyExact(core.validation, ['strictJson', 'crossPlatformPathParts', 'noSetupSkillVersion', 'checkModeWritesBytes'], `${label}.managedCore.validation`);
  historyLiteral(validation.strictJson, true, `${label}.managedCore.validation.strictJson`);
  historyLiteral(validation.crossPlatformPathParts, true, `${label}.managedCore.validation.crossPlatformPathParts`);
  historyLiteral(validation.noSetupSkillVersion, true, `${label}.managedCore.validation.noSetupSkillVersion`);
  historyLiteral(validation.checkModeWritesBytes, 0, `${label}.managedCore.validation.checkModeWritesBytes`);
}

function validateHistoricalMetadata(file: HistoricalSourceFile): void {
  const label = historyPathKey(file.pathParts);
  if (!label.endsWith('.json')) return;
  const value = parseHistoryJson(file.content, label);
  // Managed metadata may have been maintained after v1 execution stopped.
  // It is preserved as source bytes, never used to authorize a migration lane.
  if (label === '.liftoff/governance/phase-graph.json') {
    const digest = canonicalSha256(value);
    if (digest !== historicalActivationIdentity.phaseGraphHash && digest !== currentActivationIdentity.phaseGraphHash) {
      historyFail(label, 'is neither the registered historical nor the installed current managed graph.', 'unsupported-historical-graph');
    }
  } else if (label === '.liftoff/governance/compatibility.json') {
    if (isRecord(value) && value.schemaVersion === 1) {
      validateHistoricalCompatibility(value, label);
    } else {
      try {
        const metadata = validateGovernanceCompatibilityMetadata(value);
        for (const parts of metadata.managedCore.pathAllowlist) historyPathParts(parts, `${label}.managedCore.pathAllowlist`);
        for (const entry of metadata.managedCore.updateInventory) historyPathParts(entry.pathParts, `${label}.managedCore.updateInventory.pathParts`);
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'Error') throw error;
        historyFail(label, error.message, 'invalid-managed-source-metadata');
      }
    }
  } else if (label === '.liftoff/governance/context.json') {
    const context = historyRecord(value, label);
    historyLiteral(context.schemaVersion, 1, `${label}.schemaVersion`);
    const policy = historyExact(context.policy, ['profile', 'version', 'state', 'liveEnforcement'], `${label}.policy`);
    historyLiteral(policy.profile, 'single-maintainer-gitflow', `${label}.policy.profile`);
    historyLiteral(policy.version, '6', `${label}.policy.version`);
    historyLiteral(policy.state, 'handoff-generated', `${label}.policy.state`);
    historyLiteral(policy.liveEnforcement, 'not-active', `${label}.policy.liveEnforcement`);
    const discovery = historyRecord(context.discovery, `${label}.discovery`);
    if (Object.values(discovery).some((entry) => entry !== 'undiscovered')) historyFail(label, 'context cannot assert live discovery.');
    if (historyArray(context.commands, `${label}.commands`).length === 0) historyFail(label, 'context must declare its generated commands.');
    historyRecord(context.generatedBoundaries, `${label}.generatedBoundaries`);
    validateEmbeddedPaths(context, label);
  } else if (label === '.liftoff/governance/credential-policy.schema.json') {
    const schema = historyRecord(value, label);
    historyString(schema.$schema, `${label}.$schema`);
    const properties = historyRecord(schema.properties, `${label}.properties`);
    const identity = historyRecord(properties.identity, `${label}.properties.identity`);
    const identityProperties = historyExact(identity.properties, Object.keys(historicalActivationIdentity), `${label}.properties.identity.properties`);
    const declaredIdentity = Object.fromEntries(Object.entries(identityProperties).map(([key, entry]) => {
      const declaration = historyExact(entry, ['const'], `${label}.properties.identity.properties.${key}`);
      return [key, declaration.const];
    }));
    const identityDigest = canonicalSha256(declaredIdentity);
    if (identityDigest !== canonicalSha256(historicalActivationIdentity) && identityDigest !== canonicalSha256(currentActivationIdentity)) {
      historyFail(label, 'credential schema must declare the exact historical or installed current activation identity.', 'invalid-managed-source-metadata');
    }
  } else {
    historyRecord(value, label);
  }
}

function sourceFile(snapshot: ProjectFileSnapshot, kind: HistoricalFileKind): HistoricalSourceFile {
  if (snapshot.content === undefined || snapshot.mode === undefined) {
    historyFail(historyPathKey(snapshot.pathParts), 'required historical source is missing.', 'missing-historical-record');
  }
  return {
    kind, pathParts: [...snapshot.pathParts], content: snapshot.content,
    digest: rawHistoryDigest(snapshot.content), mode: snapshot.mode
  };
}

export async function historicalActiveRecordPaths(projectRoot: string, directory: string): Promise<string[][]> {
  historyRecordId(directory, 'historical active collection');
  const parts = ['governance', directory];
  const target = await resolveHistoryProjectPath(projectRoot, parts);
  let entries;
  try { entries = await readdir(target, { withFileTypes: true }); }
  catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    return [];
  }
  return entries.filter((entry) => /\.json$/iu.test(entry.name)).map((entry) => [...parts, entry.name])
    .sort((a, b) => historyPathKey(a) < historyPathKey(b) ? -1 : 1);
}

function validateAt<T>(file: HistoricalSourceFile, validator: (value: unknown) => T): T {
  try { return validator(parseHistoryJson(file.content, historyPathKey(file.pathParts))); }
  catch (error) {
    if (!(error instanceof ActivationHistoryError)) throw error;
    return historyFail(historyPathKey(file.pathParts), error.message, error.code);
  }
}

export async function readHistoricalActivationInventory(
  projectRoot: string, options: HistoricalInventoryOptions = {}
): Promise<HistoricalActivationInventory> {
  const preconditions: ProjectFileSnapshot[] = [];
  const capture = async (parts: readonly string[]) => {
    const snapshot = await captureHistoryFile(projectRoot, parts);
    preconditions.push(snapshot);
    return snapshot;
  };
  const manifestFile = sourceFile(await capture(historicalManifestPathParts), 'manifest');
  const stateFile = sourceFile(await capture(historicalActivationStatePathParts), 'state');
  const manifest = validateAt(manifestFile, validateHistoricalSourceManifest);
  const state = validateAt(stateFile, validateHistoricalActivationState);
  if (state.activeChange !== null && state.activeChange.kind !== manifest.project.specWorkflow) {
    historyFail(historyPathKey(stateFile.pathParts), 'active change belongs to a different spec workflow.', 'historical-spec-ownership-conflict');
  }
  const files = [manifestFile, stateFile];
  for (const parts of historicalMetadataPathParts) {
    const snapshot = await capture(parts);
    if (snapshot.content === undefined) continue;
    const file = sourceFile(snapshot, 'metadata');
    validateHistoricalMetadata(file);
    files.push(file);
  }
  const evidence = new Map<string, { file: HistoricalSourceFile; record: HistoricalEvidenceRecord }>();
  const plans: Array<{ file: HistoricalSourceFile; record: HistoricalSavedTransitionPlan }> = [];
  const approvals = new Map<string, { file: HistoricalSourceFile; record: HistoricalApprovalEnvelope }>();
  for (const [directory, kind] of [['evidence', 'evidence'], ['plans', 'plan'], ['approvals', 'approval']] as const) {
    for (const parts of await historicalActiveRecordPaths(projectRoot, directory)) {
      const file = sourceFile(await capture(parts), kind);
      if (!parts[2].endsWith('.json')) historyFail(historyPathKey(parts), 'active record extension is not the registered lowercase .json layout.');
      if (kind === 'evidence') {
        const record = validateAt(file, (value) => validateHistoricalEvidenceRecord(value, parts[2].slice(0, -5)));
        if (record.header.repositoryId !== state.repository.id) historyFail(historyPathKey(parts), 'historical evidence belongs to another repository.', 'invalid-historical-reference');
        if (evidence.has(record.evidenceId)) historyFail(historyPathKey(parts), 'duplicates an evidence identity.');
        evidence.set(record.evidenceId, { file, record });
      } else if (kind === 'plan') {
        plans.push({ file, record: validateAt(file, validateHistoricalSavedTransitionPlan) });
      } else {
        const record = validateAt(file, validateHistoricalApprovalEnvelope);
        if (approvals.has(record.id)) historyFail(historyPathKey(parts), 'duplicates an approval identity.');
        approvals.set(record.id, { file, record });
      }
    }
  }
  for (const directory of ['supersessions', 'reconciliation']) {
    const records = await historicalActiveRecordPaths(projectRoot, directory);
    if (records.length > 0) historyFail(historyPathKey(records[0]), 'active historical auxiliary proof has no registered successor retirement contract; preserve it for explicit reconciliation.', 'unsupported-active-record');
  }
  for (const parts of [['governance', 'credentials', 'preflight-policy.json'], ['governance', 'activation-baseline.json']]) {
    if ((await capture(parts)).content !== undefined) {
      historyFail(historyPathKey(parts), 'active auxiliary proof has no registered v1 retirement contract; it cannot be silently carried forward.', 'unsupported-active-record');
    }
  }
  const selected = new Set<string>();
  const select = (file: HistoricalSourceFile) => selected.add(historyPathKey(file.pathParts));
  const requireApproval = (id: string, expectedPhase: string, expectedHash?: string) => {
    const found = approvals.get(id);
    if (!found) historyFail(`governance/approvals/${id}`, 'referenced historical approval is missing.', 'missing-historical-record');
    if (found.record.phaseId !== expectedPhase || expectedHash !== undefined && historicalApprovalEnvelopeHash(found.record) !== expectedHash) {
      historyFail(historyPathKey(found.file.pathParts), 'approval phase or scope hash contradicts its reference.', 'invalid-historical-reference');
    }
    select(found.file);
  };
  const selectPlan = (entry: typeof plans[number]) => {
    select(entry.file);
    if (entry.record.approval.envelopeId !== null) {
      if (entry.record.approval.envelopeHash === null) historyFail(historyPathKey(entry.file.pathParts), 'approval reference has no hash.');
      requireApproval(entry.record.approval.envelopeId, entry.record.phaseId, entry.record.approval.envelopeHash);
    }
  };
  const selectEvidence = (entry: { file: HistoricalSourceFile; record: HistoricalEvidenceRecord }) => {
    select(entry.file);
    const { header, payload, evidenceId } = entry.record;
    const matching = plans.filter((candidate) =>
      candidate.record.phaseId === header.phaseId && candidate.record.transitionDigest === header.transition.transitionDigest &&
      candidate.record.baselineDigest === header.baselineSha && candidate.record.inputDigest === header.inputDigest);
    const planDigest = isRecord(payload) && Object.hasOwn(payload, 'planDigest')
      ? historyDigest(payload.planDigest, `${evidenceId}.payload.planDigest`) : undefined;
    const savedPlanDigest = isRecord(payload) && Object.hasOwn(payload, 'savedPlanDigest')
      ? historyDigest(payload.savedPlanDigest, `${evidenceId}.payload.savedPlanDigest`) : undefined;
    const linked = matching.filter((candidate) =>
      (planDigest === undefined || candidate.record.planDigest === planDigest) &&
      (savedPlanDigest === undefined || canonicalSha256(candidate.record) === savedPlanDigest));
    if (linked.length === 0 && (planDigest !== undefined || savedPlanDigest !== undefined || header.producer === 'liftoff-governance-transition-engine')) {
      historyFail(historyPathKey(entry.file.pathParts), 'required reviewed historical transition plan is missing or inconsistent.', 'missing-historical-record');
    }
    linked.forEach(selectPlan);
  };
  for (const id of historicalPhaseIds) {
    const phase = state.phases[id];
    if (['verified', 'inapplicable', 'retained', 'disposed'].includes(phase.state) && phase.evidence.length === 0 ||
      phase.state === 'approved' && phase.approvals.length === 0) {
      historyFail(`governance/activation-state.json#phases.${id}`, 'terminal historical state has no required record references.', 'missing-historical-record');
    }
    for (const ref of phase.evidence) {
      const found = evidence.get(ref.evidenceId);
      if (!found) historyFail(`governance/evidence/${ref.evidenceId}.json`, 'referenced historical evidence is missing.', 'missing-historical-record');
      const header = found.record.header;
      if (header.phaseId !== id || header.result !== ref.result || canonicalSha256(header) !== ref.headerDigest) {
        historyFail(historyPathKey(found.file.pathParts), 'header digest, phase or result contradicts its state reference.', 'invalid-historical-reference');
      }
      selectEvidence(found);
    }
    for (const approvalId of phase.approvals) requireApproval(approvalId, id);
  }
  if (state.bootstrapState !== undefined) {
    const retained = evidence.get(state.bootstrapState.remoteImportEvidenceId);
    if (!retained || retained.record.header.phaseId !== 'remote-import-verified' ||
      canonicalSha256(retained.record.header) !== state.bootstrapState.remoteImportEvidenceDigest) {
      historyFail('governance/activation-state.json#bootstrapState', 'remote import evidence reference is missing or inconsistent.', 'invalid-historical-reference');
    }
    selectEvidence(retained);
    if (state.bootstrapState.deletionEvidenceId !== undefined) {
      const deletion = evidence.get(state.bootstrapState.deletionEvidenceId);
      if (!deletion || deletion.record.header.phaseId !== 'bootstrap-state-disposed') {
        historyFail('governance/activation-state.json#bootstrapState.deletionEvidenceId', 'referenced disposal evidence is missing or names another phase.', 'missing-historical-record');
      }
      selectEvidence(deletion);
    }
  }
  const allRecords = [...evidence.values(), ...plans, ...approvals.values()];
  const requested = new Set<string>();
  for (const raw of options.reviewedUnreferencedPathParts ?? []) {
    const key = historyPathKey(historyPathParts(raw, 'reviewed unreferenced path'));
    if (requested.has(key)) historyFail(key, 'duplicates a reviewed inventory entry.');
    requested.add(key);
    const found = allRecords.find((entry) => historyPathKey(entry.file.pathParts) === key);
    if (!found) historyFail(key, 'is not a recognized existing historical record.', 'unregistered-history-source');
    select(found.file);
    const plan = plans.find((entry) => entry.file === found.file);
    if (plan) selectPlan(plan);
    const proof = [...evidence.values()].find((entry) => entry.file === found.file);
    if (proof) selectEvidence(proof);
  }
  const unreviewedRecords: HistoricalSourceFile[] = [];
  for (const entry of allRecords) {
    if (selected.has(historyPathKey(entry.file.pathParts))) files.push(entry.file);
    else unreviewedRecords.push(entry.file);
  }
  files.sort((a, b) => historyPathKey(a.pathParts) < historyPathKey(b.pathParts) ? -1 : 1);
  return { manifest, state, files, unreviewedRecords, preconditions };
}
