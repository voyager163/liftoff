import { readFileSync } from 'node:fs';
import { resolvePackageFile } from '../adapters/packaged-assets/package-root.js';
import { canonicalJson, canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import {
  historicalV1ActivationIdentity, historicalV2ActivationIdentity,
  type HistoricalV2ActivationIdentity
} from '../domain/governance/policy/identity.js';
import type { PhaseExecutionState } from '../domain/governance/activation/types.js';
import {
  historicalPhaseIds, assertHistoricalPhasesComplete, readHistoricalApprovalFields,
  readHistoricalEvidenceReference, readHistoricalEvidenceTransition, readHistoricalSavedTransitionPlan,
  validateHistoricalBootstrapState, validateHistoricalEmbeddedPaths,
  type HistoricalActivationState, type HistoricalApprovalEnvelope,
  type HistoricalEvidenceHeader, type HistoricalLiveReadbackProof, type HistoricalSavedTransitionPlan
} from './historical-common.js';
import {
  historyArray, historyBoolean, historyDigest, historyEnum, historyExact, historyFail,
  historyLiteral, historyPathParts, historyRecord, historyRecordId, historyString, historyStrings,
  historyTimestamp, historicalV2Identity
} from './history-contracts.js';
import { assertSafeHistoricalRecord } from './historical-safety.js';
import { validateHistoricalV2CredentialPolicy } from './historical-credential-policy.js';

// This is the published 0.11.0 contract, not the mutable current graph/validators.
let frozenGraph: Record<string, unknown> | undefined;
export function historicalV2PhaseGraph(): Record<string, unknown> {
  if (!frozenGraph) {
    const value: unknown = JSON.parse(readFileSync(resolvePackageFile(
      'assets', 'governance', 'single-maintainer-gitflow', 'activation-v2-graph.json'
    ), 'utf8'));
    if (canonicalSha256(value) !== historicalV2ActivationIdentity.phaseGraphHash) {
      historyFail('packaged activation-v2-graph.json', 'does not match the published v2 graph.', 'invalid-packaged-history');
    }
    frozenGraph = historyRecord(value, 'historicalV2Graph');
  }
  return structuredClone(frozenGraph);
}

function historicalV2Phase(id: string): Record<string, unknown> {
  const phase = historyArray(historicalV2PhaseGraph().phases, 'historicalV2Graph.phases')
    .map((entry) => historyRecord(entry, 'historicalV2Graph.phase')).find((entry) => entry.id === id);
  if (!phase) historyFail('historicalV2.phaseId', 'does not name a published v2 phase.');
  return phase;
}

export function historicalV2PhaseContractDigest(id: string): string {
  const { label: _label, ...behavior } = historicalV2Phase(id);
  return canonicalSha256(behavior);
}

export interface HistoricalV2ActivationState extends Omit<HistoricalActivationState, 'schemaVersion' | 'identity' | 'applicability'> {
  schemaVersion: 2;
  identity: HistoricalV2ActivationIdentity;
  applicability: {
    statePath: 'existing-private' | 'bootstrap-local' | 'none';
    privateStagingDast: boolean | 'unknown';
    credentialRequired: boolean | 'unknown';
  };
  remoteBinding?: { id: string; name: string; defaultBranch: string; pushUrl: string; verifiedAt: string };
}

export type HistoricalV2EvidenceHeader = Omit<HistoricalEvidenceHeader, 'schemaVersion' | 'identity'> & {
  schemaVersion: 2;
  identity: HistoricalV2ActivationIdentity;
  bodyDigest: string;
  remoteBindingDigest?: string;
};
export type HistoricalV2LiveReadbackProof = Omit<HistoricalLiveReadbackProof, 'schemaVersion' | 'identity'> & {
  schemaVersion: 2;
  identity: HistoricalV2ActivationIdentity;
};
export interface HistoricalV2EvidenceRecord {
  evidenceId: string;
  header: HistoricalV2EvidenceHeader;
  payload?: unknown;
  liveReadback?: HistoricalV2LiveReadbackProof[];
}
export type HistoricalV2ApprovalEnvelope = Omit<HistoricalApprovalEnvelope, 'schemaVersion' | 'identity'> & {
  schemaVersion: 2;
  identity: HistoricalV2ActivationIdentity;
};
export type HistoricalV2SavedTransitionPlan = Omit<HistoricalSavedTransitionPlan, 'identity'> & {
  identity: HistoricalV2ActivationIdentity;
};

export function validateHistoricalV2ActivationState(value: unknown): HistoricalV2ActivationState {
  const label = 'historicalV2ActivationState';
  assertSafeHistoricalRecord(value, label);
  const item = historyExact(value, [
    'schemaVersion', 'identity', 'repository', 'activeChange', 'applicability', 'phases', 'createdAt', 'updatedAt'
  ], label, ['bootstrapState', 'remoteBinding']);
  historyLiteral(item.schemaVersion, 2, `${label}.schemaVersion`);
  const identity = historicalV2Identity(item.identity, `${label}.identity`);
  const repository = historyExact(item.repository, ['id', 'name', 'defaultBranch'], `${label}.repository`);
  const repositoryId = historyString(repository.id, `${label}.repository.id`);
  if (repositoryId === 'unbound') historyFail(`${label}.repository.id`, 'persisted v2 state requires an execution anchor.');
  const applicability = historyExact(item.applicability, ['statePath', 'privateStagingDast', 'credentialRequired'], `${label}.applicability`);
  const rawPhases = historyExact(item.phases, historicalPhaseIds, `${label}.phases`);
  const phases: Partial<Record<typeof historicalPhaseIds[number], PhaseExecutionState>> = {};
  for (const id of historicalPhaseIds) {
    const at = `${label}.phases.${id}`;
    const phase = historyExact(rawPhases[id], ['state', 'updatedAt', 'evidence', 'approvals', 'blockers'], at);
    const evidence = historyArray(phase.evidence, `${at}.evidence`).map((entry, index) =>
      readHistoricalEvidenceReference(entry, `${at}.evidence[${index}]`));
    const approvals = historyStrings(phase.approvals, `${at}.approvals`).map((entry) => historyRecordId(entry, `${at}.approvals`));
    if (evidence.some((entry) => entry.phaseId !== id) ||
      new Set(evidence.map((entry) => entry.evidenceId)).size !== evidence.length ||
      new Set(approvals).size !== approvals.length) historyFail(at, 'contains mismatched or duplicate record references.');
    phases[id] = {
      state: historyEnum(phase.state, ['pending', 'blocked', 'ready', 'approved', 'running', 'verified', 'failed', 'inapplicable', 'retained', 'disposed'], `${at}.state`),
      updatedAt: historyString(phase.updatedAt, `${at}.updatedAt`),
      evidence, approvals, blockers: historyStrings(phase.blockers, `${at}.blockers`)
    };
  }
  assertHistoricalPhasesComplete(phases);
  let activeChange: HistoricalV2ActivationState['activeChange'] = null;
  if (item.activeChange !== null) {
    const change = historyExact(item.activeChange, ['id', 'kind'], `${label}.activeChange`);
    activeChange = { id: historyRecordId(change.id, `${label}.activeChange.id`), kind: historyEnum(change.kind, ['openspec', 'spec-kit'], `${label}.activeChange.kind`) };
  }
  let remoteBinding: HistoricalV2ActivationState['remoteBinding'];
  if (Object.hasOwn(item, 'remoteBinding')) {
    const remote = historyExact(item.remoteBinding, ['id', 'name', 'defaultBranch', 'pushUrl', 'verifiedAt'], `${label}.remoteBinding`);
    remoteBinding = {
      id: historyString(remote.id, `${label}.remoteBinding.id`), name: historyString(remote.name, `${label}.remoteBinding.name`),
      defaultBranch: historyString(remote.defaultBranch, `${label}.remoteBinding.defaultBranch`),
      pushUrl: historyString(remote.pushUrl, `${label}.remoteBinding.pushUrl`),
      verifiedAt: historyTimestamp(remote.verifiedAt, `${label}.remoteBinding.verifiedAt`)
    };
    const destination = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(remoteBinding.pushUrl);
    if (!destination || destination[1].toLowerCase() !== remoteBinding.name.toLowerCase()) {
      historyFail(`${label}.remoteBinding`, 'does not match one credential-free historical GitHub destination.');
    }
  }
  return {
    schemaVersion: 2, identity,
    repository: { id: repositoryId, name: historyString(repository.name, `${label}.repository.name`), defaultBranch: historyString(repository.defaultBranch, `${label}.repository.defaultBranch`) },
    activeChange,
    applicability: {
      statePath: historyEnum(applicability.statePath, ['existing-private', 'bootstrap-local', 'none'], `${label}.applicability.statePath`),
      privateStagingDast: applicability.privateStagingDast === 'unknown' ? 'unknown' : historyBoolean(applicability.privateStagingDast, `${label}.applicability.privateStagingDast`),
      credentialRequired: applicability.credentialRequired === 'unknown' ? 'unknown' : historyBoolean(applicability.credentialRequired, `${label}.applicability.credentialRequired`)
    },
    ...(remoteBinding ? { remoteBinding } : {}),
    ...(Object.hasOwn(item, 'bootstrapState') ? { bootstrapState: validateHistoricalBootstrapState(item.bootstrapState, `${label}.bootstrapState`) } : {}),
    phases, createdAt: historyString(item.createdAt, `${label}.createdAt`), updatedAt: historyString(item.updatedAt, `${label}.updatedAt`)
  };
}

function proofFields(item: Record<string, unknown>, label: string) {
  const identity = historicalV2Identity(item.identity, `${label}.identity`);
  const phaseId = historyEnum(item.phaseId, historicalPhaseIds, `${label}.phaseId`);
  const baselineSha = historyDigest(item.baselineSha, `${label}.baselineSha`);
  const inputDigest = historyDigest(item.inputDigest, `${label}.inputDigest`);
  const transition = readHistoricalEvidenceTransition(item.transition, `${label}.transition`);
  historyLiteral(item.phaseGraphHash, identity.phaseGraphHash, `${label}.phaseGraphHash`);
  if (transition.phaseId !== phaseId || transition.baselineSha !== baselineSha || transition.inputDigest !== inputDigest) {
    historyFail(label, 'transition contradicts the recorded phase, baseline or inputs.');
  }
  return {
    schemaVersion: historyLiteral(item.schemaVersion, 2, `${label}.schemaVersion`),
    identity, phaseGraphHash: identity.phaseGraphHash, phaseId, baselineSha, inputDigest, transition,
    repositoryId: historyString(item.repositoryId, `${label}.repositoryId`)
  };
}

export function validateHistoricalV2EvidenceHeader(value: unknown): HistoricalV2EvidenceHeader {
  const label = 'historicalV2EvidenceHeader';
  assertSafeHistoricalRecord(value, label);
  const item = historyExact(value, [
    'schemaVersion', 'repositoryId', 'identity', 'phaseGraphHash', 'phaseId', 'phaseContractDigest',
    'inputDigest', 'baselineSha', 'transition', 'producedAt', 'producer', 'bodyDigest', 'result'
  ], label, ['remoteBindingDigest']);
  const common = proofFields(item, label);
  const phaseContractDigest = historyDigest(item.phaseContractDigest, `${label}.phaseContractDigest`);
  if (phaseContractDigest !== historicalV2PhaseContractDigest(common.phaseId)) historyFail(label, 'phase contract digest is not the published v2 behavior.');
  const result = historyEnum(item.result, ['verified', 'failed', 'inapplicable', 'retained', 'disposed'], `${label}.result`);
  if (!historyStrings(historicalV2Phase(common.phaseId).terminalStates, 'historicalV2Graph.terminalStates').includes(result)) {
    historyFail(label, 'terminal result is not permitted by the published phase.');
  }
  return {
    ...common, phaseContractDigest, result,
    producedAt: historyTimestamp(item.producedAt, `${label}.producedAt`),
    producer: historyString(item.producer, `${label}.producer`),
    bodyDigest: historyDigest(item.bodyDigest, `${label}.bodyDigest`),
    ...(Object.hasOwn(item, 'remoteBindingDigest') ? { remoteBindingDigest: historyDigest(item.remoteBindingDigest, `${label}.remoteBindingDigest`) } : {})
  };
}

export function validateHistoricalV2LiveReadback(value: unknown): HistoricalV2LiveReadbackProof {
  const label = 'historicalV2LiveReadback';
  assertSafeHistoricalRecord(value, label);
  const item = historyExact(value, [
    'schemaVersion', 'repositoryId', 'identity', 'phaseGraphHash', 'phaseId', 'baselineSha', 'inputDigest',
    'transition', 'observedAt', 'provider', 'resourceType', 'resourceId', 'sourceDigest', 'readbackDigest', 'matches'
  ], label);
  return {
    ...proofFields(item, label), observedAt: historyTimestamp(item.observedAt, `${label}.observedAt`),
    provider: historyEnum(item.provider, ['github', 'azure'], `${label}.provider`),
    resourceType: historyString(item.resourceType, `${label}.resourceType`),
    resourceId: historyString(item.resourceId, `${label}.resourceId`),
    sourceDigest: historyDigest(item.sourceDigest, `${label}.sourceDigest`),
    readbackDigest: historyDigest(item.readbackDigest, `${label}.readbackDigest`),
    matches: historyBoolean(item.matches, `${label}.matches`)
  };
}

export function historicalV2EvidenceBodyDigest(payload: unknown, liveReadback: readonly HistoricalV2LiveReadbackProof[] = []): string {
  const normalized = liveReadback.map(validateHistoricalV2LiveReadback)
    .sort((a, b) => canonicalSha256(a).localeCompare(canonicalSha256(b), 'en'));
  return canonicalSha256({ payload: payload ?? null, liveReadback: normalized });
}

export function validateHistoricalV2EvidenceRecord(value: unknown): HistoricalV2EvidenceRecord {
  const label = 'historicalV2EvidenceRecord';
  assertSafeHistoricalRecord(value, label);
  const item = historyExact(value, ['evidenceId', 'header'], label, ['payload', 'liveReadback']);
  const header = validateHistoricalV2EvidenceHeader(item.header);
  if (Object.hasOwn(item, 'payload')) validateHistoricalEmbeddedPaths(item.payload, `${label}.payload`);
  const liveReadback = Object.hasOwn(item, 'liveReadback')
    ? historyArray(item.liveReadback, `${label}.liveReadback`).map(validateHistoricalV2LiveReadback) : undefined;
  if (header.bodyDigest !== historicalV2EvidenceBodyDigest(item.payload, liveReadback)) {
    historyFail(label, 'recorded body does not match its historical body digest.', 'invalid-historical-reference');
  }
  if (liveReadback?.some((proof) => proof.repositoryId !== header.repositoryId || proof.phaseId !== header.phaseId ||
    canonicalSha256(proof.transition) !== canonicalSha256(header.transition))) {
    historyFail(label, 'live readback contradicts its enclosing historical record.', 'invalid-historical-reference');
  }
  return {
    evidenceId: historyRecordId(item.evidenceId, `${label}.evidenceId`), header,
    ...(Object.hasOwn(item, 'payload') ? { payload: item.payload } : {}),
    ...(liveReadback === undefined ? {} : { liveReadback })
  };
}

export function validateHistoricalV2ApprovalEnvelope(value: unknown): HistoricalV2ApprovalEnvelope {
  const label = 'historicalV2ApprovalEnvelope';
  const item = historyRecord(value, label);
  const fields = readHistoricalApprovalFields(value);
  if (Date.parse(fields.approvedAt) >= Date.parse(fields.expiresAt)) historyFail(label, 'requires approvedAt before expiresAt.');
  const gate = historyRecord(historicalV2Phase(fields.phaseId).approvalGate, 'historicalV2Graph.approvalGate');
  historyLiteral(fields.gateKind, historyString(gate.kind, 'historicalV2Graph.approvalGate.kind'), `${label}.gateKind`);
  return {
    ...fields, schemaVersion: historyLiteral(item.schemaVersion, 2, `${label}.schemaVersion`),
    identity: historicalV2Identity(item.identity, `${label}.identity`)
  };
}

export function historicalV2ApprovalEnvelopeHash(value: HistoricalV2ApprovalEnvelope): string {
  const { id: _id, approvedAt: _approvedAt, approver: _approver, ...scope } = validateHistoricalV2ApprovalEnvelope(value);
  return canonicalSha256(scope);
}

export function validateHistoricalV2SavedTransitionPlan(value: unknown): HistoricalV2SavedTransitionPlan {
  const plan = readHistoricalSavedTransitionPlan(value, historicalV2Identity);
  const node = historicalV2Phase(plan.phaseId);
  if (canonicalSha256(plan.mutationClasses) !== canonicalSha256(node.allowedMutations)) {
    historyFail('historicalV2TransitionPlan', 'mutation inventory differs from its published phase.');
  }
  const approvalPlanDigest = canonicalSha256({
    phaseId: plan.phaseId, gateKind: plan.approval.gateKind,
    transitionDigest: plan.transitionDigest, allowedMutations: plan.mutationClasses
  });
  if (plan.planDigest !== canonicalSha256({
    phaseId: plan.phaseId, transitionDigest: plan.transitionDigest, approvalPlanDigest, operations: plan.operations
  })) historyFail('historicalV2TransitionPlan', 'plan digest does not bind the recorded operation inventory.', 'invalid-historical-reference');
  for (const operation of plan.operations) {
    const allowed = operation.remote ? plan.mutationClasses.remote : plan.mutationClasses.local;
    if (!allowed.includes(operation.mutationClass)) historyFail('historicalV2TransitionPlan', 'operation exceeds its recorded historical phase scope.');
  }
  return { ...plan, identity: historicalV2Identity(plan.identity, 'historicalV2TransitionPlan.identity') };
}

export function validateHistoricalV2Compatibility(value: unknown, label = 'historicalV2Compatibility'): void {
  assertSafeHistoricalRecord(value, label);
  const item = historyExact(value, ['schemaVersion', 'generatedBy', 'liftoffVersion', 'minimumLiftoffVersions', 'manifest', 'activation', 'managedCore'], label);
  if (item.schemaVersion !== 2 && item.schemaVersion !== 3) historyFail(label, 'requires published compatibility schema 2 or 3.');
  historyLiteral(item.generatedBy, 'Mission Control Liftoff', `${label}.generatedBy`);
  historyLiteral(item.liftoffVersion, '0.11.0', `${label}.liftoffVersion`);
  const minimum = historyExact(item.minimumLiftoffVersions, ['manifestWriteVersion7', 'remedy'], `${label}.minimumLiftoffVersions`);
  historyLiteral(minimum.manifestWriteVersion7, '0.10.0', `${label}.minimumLiftoffVersions.manifestWriteVersion7`);
  historyString(minimum.remedy, `${label}.minimumLiftoffVersions.remedy`);
  const manifest = historyExact(item.manifest, ['readVersions', 'writeVersion', 'hashAuthority'], `${label}.manifest`);
  if (canonicalJson(manifest.readVersions) !== canonicalJson([2, 3, 4, 5, 6, 7])) historyFail(label, 'has unsupported manifest readers.');
  historyLiteral(manifest.writeVersion, 7, `${label}.manifest.writeVersion`);
  historyLiteral(manifest.hashAuthority, 'liftoff.manifest.json managedArtifacts[].contentHash', `${label}.manifest.hashAuthority`);
  const activation = historyExact(item.activation, [
    'currentCompatibleTuples', 'historicalReadability', 'recognizedGraphHashes', 'graphMappings', 'historicalStateMigrations',
    ...(item.schemaVersion === 3 ? ['successorMigrations'] : []), 'unsupportedRemedy'
  ], `${label}.activation`);
  if (canonicalSha256(activation.currentCompatibleTuples) !== canonicalSha256([historicalV2ActivationIdentity]) ||
    canonicalSha256(activation.recognizedGraphHashes) !== canonicalSha256([historicalV2ActivationIdentity.phaseGraphHash]) ||
    canonicalJson(activation.graphMappings) !== '[]\n' || canonicalJson(activation.historicalStateMigrations) !== '[]\n') {
    historyFail(label, 'contains an undeclared source identity or historical mapping.');
  }
  const historical = historyExact(activation.historicalReadability, [
    'tuples', 'activationContractVersion', 'activationStateSchemaVersion', 'evidenceHeaderSchemaVersion', 'execution', 'migration'
  ], `${label}.activation.historicalReadability`);
  if (canonicalSha256(historical.tuples) !== canonicalSha256([historicalV1ActivationIdentity])) historyFail(label, 'v1 diagnostic identity differs from the published contract.');
  for (const key of ['activationContractVersion', 'activationStateSchemaVersion', 'evidenceHeaderSchemaVersion']) historyLiteral(historical[key], 1, `${label}.historicalReadability.${key}`);
  historyLiteral(historical.execution, 'diagnostic-only', `${label}.historicalReadability.execution`);
  historyLiteral(historical.migration, item.schemaVersion === 2 ? 'unsupported-preserve-bytes' : 'explicit-successor-preserve-bytes', `${label}.historicalReadability.migration`);
  historyString(activation.unsupportedRemedy, `${label}.activation.unsupportedRemedy`);
  if (item.schemaVersion === 3 && canonicalSha256(activation.successorMigrations) !== canonicalSha256([{
    id: 'activation-v1-to-v2', fromIdentity: historicalV1ActivationIdentity, toIdentity: historicalV2ActivationIdentity,
    strategy: 'preserve-history-revalidate', historySchemaVersion: 1, journalSchemaVersion: 1
  }])) historyFail(label, 'contains an undeclared historical successor lane.');
  const core = historyExact(item.managedCore, ['logicalNameAllowlist', 'pathAllowlist', 'updateInventory', 'validation'], `${label}.managedCore`);
  const names = historyStrings(core.logicalNameAllowlist, `${label}.managedCore.logicalNameAllowlist`);
  const paths = historyArray(core.pathAllowlist, `${label}.managedCore.pathAllowlist`).map((entry) => historyPathParts(entry, label));
  const entries = historyArray(core.updateInventory, `${label}.managedCore.updateInventory`).map((entry) => {
    const file = historyExact(entry, ['logicalName', 'pathParts', 'lifecycle', 'contentHashAuthority'], label);
    historyLiteral(file.lifecycle, 'managed-core', `${label}.lifecycle`);
    historyLiteral(file.contentHashAuthority, 'liftoff.manifest.json managedArtifacts[].contentHash', `${label}.contentHashAuthority`);
    return { name: historyString(file.logicalName, `${label}.logicalName`), path: historyPathParts(file.pathParts, label) };
  });
  if (new Set(names).size !== names.length || new Set(paths.map((parts) => parts.join('/').normalize('NFC').toLowerCase())).size !== paths.length ||
    new Set(entries.map((entry) => entry.name)).size !== entries.length ||
    new Set(entries.map((entry) => entry.path.join('/').normalize('NFC').toLowerCase())).size !== entries.length ||
    entries.length !== paths.length || entries.some((entry) => !names.includes(entry.name) || !paths.some((parts) => canonicalJson(parts) === canonicalJson(entry.path)))) {
    historyFail(label, 'historical managed inventory has collisions or inconsistent allowlists.');
  }
  if (canonicalSha256(core.validation) !== canonicalSha256({
    strictJson: true, crossPlatformPathParts: true, noSetupSkillVersion: true, checkModeWritesBytes: 0
  })) historyFail(label, 'historical managed validation declaration is unsupported.');
}

export function validateHistoricalV2AuxiliaryRecord(value: unknown, kind: 'supersession' | 'reconciliation' | 'credential-policy'): void {
  const label = `historicalV2.${kind}`;
  assertSafeHistoricalRecord(value, label);
  if (kind === 'credential-policy') return validateHistoricalV2CredentialPolicy(value);
  if (kind === 'supersession') {
    const item = historyExact(value, ['schemaVersion', 'identity', 'supersededChangeId', 'supersedingChangeId', 'reason', 'approvedAt', 'approver'], label);
    historyLiteral(item.schemaVersion, 1, `${label}.schemaVersion`);
    historicalV2Identity(item.identity, `${label}.identity`);
    historyRecordId(item.supersededChangeId, `${label}.supersededChangeId`);
    historyRecordId(item.supersedingChangeId, `${label}.supersedingChangeId`);
    for (const key of ['reason', 'approvedAt', 'approver']) historyString(item[key], `${label}.${key}`);
    return;
  }
  const item = historyExact(value, ['schemaVersion', 'fromGraphHash', 'toGraphHash', 'fromIdentity', 'toIdentity', 'phaseMappings', 'reconciledAt', 'producer'], label);
  historyLiteral(item.schemaVersion, 2, `${label}.schemaVersion`);
  historicalV2Identity(item.fromIdentity, `${label}.fromIdentity`);
  historicalV2Identity(item.toIdentity, `${label}.toIdentity`);
  historyLiteral(item.fromGraphHash, historicalV2ActivationIdentity.phaseGraphHash, `${label}.fromGraphHash`);
  historyLiteral(item.toGraphHash, historicalV2ActivationIdentity.phaseGraphHash, `${label}.toGraphHash`);
  const seen = new Set<string>();
  for (const entry of historyArray(item.phaseMappings, `${label}.phaseMappings`)) {
    const mapping = historyExact(entry, ['phaseId', 'fromContractDigest', 'toContractDigest', 'preserveEvidence'], label);
    const id = historyEnum(mapping.phaseId, historicalPhaseIds, `${label}.phaseId`);
    if (seen.has(id)) historyFail(label, 'contains duplicate phase mappings.');
    seen.add(id);
    historyLiteral(mapping.fromContractDigest, historicalV2PhaseContractDigest(id), `${label}.fromContractDigest`);
    historyLiteral(mapping.toContractDigest, historicalV2PhaseContractDigest(id), `${label}.toContractDigest`);
    historyBoolean(mapping.preserveEvidence, `${label}.preserveEvidence`);
  }
  if (seen.size !== historicalPhaseIds.length) historyFail(label, 'requires the complete historical phase mapping.');
  historyTimestamp(item.reconciledAt, `${label}.reconciledAt`);
  historyString(item.producer, `${label}.producer`);
}
