import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolvePackageFile } from '../adapters/packaged-assets/package-root.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import {
  historicalV1ActivationIdentity, historicalV2ActivationIdentity, historicalV3ActivationIdentity,
  isHistoricalV3ActivationIdentity, type HistoricalV3ActivationIdentity
} from '../domain/governance/policy/identity.js';
import type {
  ApprovalEnvelope, EvidenceHeader, LiveReadbackProof, PhaseEvidenceRecord, PhaseExecutionState,
  SavedTransitionPlan, UserActivationState
} from '../domain/governance/activation/types.js';
import type { ActivationInputSnapshot } from '../domain/governance/activation/inputs.js';
import {
  historyArray, historyDigest, historyExact, historyFail, historyLiteral, historyPathParts,
  historyRecord, historyRecordId, historyString, historyStrings
} from './history-contracts.js';
import { assertSafeHistoricalRecord } from './historical-safety.js';

export const historicalV3PhaseIds = [
  'seed-valid', 'seed-verified', 'seed-archived', 'committed', 'pushed', 'phase-0-complete',
  'activation-approved', 'bootstrap-workflow-source-ready', 'credential-ready', 'provider-ready',
  'state-path-selected', 'existing-private-path', 'bootstrap-local', 'runner-ready',
  'private-backend-proof', 'remote-import-verified', 'remote-ready', 'application-prerequisites-ready',
  'workflow-source-ready', 'application-artifact-ready', 'application-foundation', 'dev-proof',
  'staging-qualified', 'production-rehearsed', 'green-red-proof', 'enforcement-approved',
  'rulesets-applied', 'live-readback', 'bootstrap-state-disposed'
] as const;
export type HistoricalV3PhaseId = typeof historicalV3PhaseIds[number];
export type HistoricalV3ActivationState = Omit<UserActivationState, 'schemaVersion' | 'identity' | 'phases' | 'configurationBinding'> & {
  schemaVersion: 3;
  identity: HistoricalV3ActivationIdentity;
  phases: Record<HistoricalV3PhaseId, PhaseExecutionState>;
};
export type HistoricalV3EvidenceRecord = PhaseEvidenceRecord & {
  header: EvidenceHeader & { schemaVersion: 3; identity: HistoricalV3ActivationIdentity };
};
export type HistoricalV3ApprovalEnvelope = ApprovalEnvelope & { schemaVersion: 3; identity: HistoricalV3ActivationIdentity };
export type HistoricalV3SavedTransitionPlan = SavedTransitionPlan & { identity: HistoricalV3ActivationIdentity };

type LegacyValidators = Pick<typeof import('../domain/governance/activation/validators.js'),
  'validateUserActivationState' | 'validateEvidenceHeader' | 'validateLiveReadbackProof' |
  'validateApprovalEnvelope' | 'validateSavedTransitionPlan' | 'validateSupersessionRecord' |
  'validateGraphReconciliationRecord' | 'validateCredentialPolicy'>;
type LegacyApprovals = Pick<typeof import('../domain/governance/activation/approvals.js'),
  'canonicalApprovalEnvelopeHash' | 'savedPlanAuthorityDigest'>;
type LegacyOperations = Pick<typeof import('../domain/governance/activation/operations.js'), 'assertPlanOperationsAllowed'>;
const readerRoot = ['assets', 'governance', 'single-maintainer-gitflow', 'activation-v3-reader'] as const;
const readerIndexDigest = 'af1f70b00ad684dd36a94217b5c2fdf040a9734e554bb0c0a9b88aa0b7bc2aec';
let frozen: { validators: LegacyValidators; approvals: LegacyApprovals; operations: LegacyOperations; inputs: typeof import('../domain/governance/activation/inputs.js') } | undefined;

function readers() {
  if (frozen) return frozen;
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const bytes = readFileSync(resolvePackageFile(...readerRoot, 'index.json'));
  if (digest(bytes) !== readerIndexDigest) historyFail('packaged v3 reader', 'integrity index differs from the immutable release.', 'invalid-packaged-history');
  const index = JSON.parse(bytes.toString('utf8')) as { files: Array<{ path: string; digest: string }> };
  for (const file of index.files) {
    const parts = historyPathParts(file.path.split('/'), 'packaged v3 reader path');
    if (digest(readFileSync(resolvePackageFile(...readerRoot, ...parts))) !== file.digest) {
      historyFail('packaged v3 reader', 'a frozen read-only algorithm differs from its immutable release.', 'invalid-packaged-history');
    }
  }
  const require = createRequire(import.meta.url);
  const load = (name: string) => require(resolvePackageFile(...readerRoot, 'domain', 'governance', 'activation', `${name}.js`));
  frozen = { validators: load('validators'), approvals: load('approvals'), operations: load('operations'), inputs: load('inputs') };
  return frozen;
}

export function historicalV3PhaseGraph(): Record<string, unknown> {
  const graph = JSON.parse(readFileSync(resolvePackageFile('assets', 'governance', 'single-maintainer-gitflow', 'activation-v3-graph.json'), 'utf8'));
  if (canonicalSha256(graph) !== historicalV3ActivationIdentity.phaseGraphHash) {
    historyFail('packaged v3 graph', 'does not match the immutable 0.12.0 activation package.', 'invalid-packaged-history');
  }
  return graph;
}

export function historicalV3PhaseContractDigest(id: HistoricalV3PhaseId): string {
  const node = historyArray(historicalV3PhaseGraph().phases, 'historicalV3Graph.phases')
    .map((value) => historyRecord(value, 'historicalV3Graph.phase')).find((node) => node.id === id);
  if (!node) historyFail('historicalV3.phaseId', 'is not a released phase.');
  const { label: _label, ...behavior } = node;
  return canonicalSha256(behavior);
}

function validated<T>(value: unknown, label: string, reader: (value: unknown) => T): T {
  assertSafeHistoricalRecord(value, label);
  try { return reader(value); }
  catch (error) {
    historyFail(label, error instanceof Error ? error.message : 'Invalid immutable v3 record.');
  }
}

export function validateHistoricalV3ActivationState(value: unknown): HistoricalV3ActivationState {
  const state = validated(value, 'historicalV3ActivationState', readers().validators.validateUserActivationState) as HistoricalV3ActivationState;
  for (const value of historyArray(historicalV3PhaseGraph().phases, 'historicalV3Graph.phases')) {
    const phase = historyRecord(value, 'historicalV3Graph.phase');
    const stored = state.phases[phase.id as HistoricalV3PhaseId].state;
    if (['approved', 'verified', 'failed', 'inapplicable', 'retained', 'disposed'].includes(stored) &&
      !historyStrings(phase.terminalStates, 'historicalV3Graph.terminalStates').includes(stored)) {
      historyFail('historicalV3ActivationState', 'contains a terminal result not allowed by the released phase.');
    }
  }
  return state;
}

export function validateHistoricalV3ApprovalEnvelope(value: unknown): HistoricalV3ApprovalEnvelope {
  return validated(value, 'historicalV3ApprovalEnvelope', readers().validators.validateApprovalEnvelope) as HistoricalV3ApprovalEnvelope;
}

export function historicalV3ApprovalEnvelopeHash(value: HistoricalV3ApprovalEnvelope): string {
  return readers().approvals.canonicalApprovalEnvelopeHash(validateHistoricalV3ApprovalEnvelope(value));
}

export function validateHistoricalV3SavedTransitionPlan(value: unknown): HistoricalV3SavedTransitionPlan {
  const plan = validated(value, 'historicalV3TransitionPlan', readers().validators.validateSavedTransitionPlan) as HistoricalV3SavedTransitionPlan;
  const node = historyArray(historicalV3PhaseGraph().phases, 'historicalV3Graph.phases')
    .find((node) => historyRecord(node, 'historicalV3Graph.phase').id === plan.phaseId);
  const phase = node as Parameters<LegacyApprovals['savedPlanAuthorityDigest']>[1];
  validated(plan, 'historicalV3TransitionPlan', (value) => readers().operations.assertPlanOperationsAllowed(value as SavedTransitionPlan, phase));
  const approvalPlanDigest = readers().approvals.savedPlanAuthorityDigest(plan, phase);
  if (canonicalSha256(plan.mutationClasses) !== canonicalSha256(phase.allowedMutations) ||
      plan.planDigest !== canonicalSha256({ phaseId: plan.phaseId, transitionDigest: plan.transitionDigest, approvalPlanDigest, operations: plan.operations })) {
    historyFail('historicalV3TransitionPlan', 'does not bind its exact released operations and authority.', 'invalid-historical-reference');
  }
  return plan;
}

export function historicalV3InputDigest(id: HistoricalV3PhaseId, snapshot: ActivationInputSnapshot, state?: HistoricalV3ActivationState): string {
  return readers().inputs.phaseInputDigest(id, snapshot, state as UserActivationState | undefined);
}

export function validateHistoricalV3EvidenceRecord(value: unknown): HistoricalV3EvidenceRecord {
  const label = 'historicalV3EvidenceRecord';
  assertSafeHistoricalRecord(value, label);
  const record = historyExact(value, ['evidenceId', 'header'], label, ['payload', 'liveReadback']);
  const header = validated(record.header, `${label}.header`, readers().validators.validateEvidenceHeader);
  if (!isHistoricalV3ActivationIdentity(header.identity) ||
      header.phaseContractDigest !== historicalV3PhaseContractDigest(header.phaseId as HistoricalV3PhaseId)) {
    historyFail(label, 'does not match the exact released v3 phase contract.');
  }
  const phase = historyArray(historicalV3PhaseGraph().phases, 'historicalV3Graph.phases')
    .map((value) => historyRecord(value, 'historicalV3Graph.phase')).find((phase) => phase.id === header.phaseId)!;
  if (!historyStrings(phase.terminalStates, 'historicalV3Graph.terminalStates').includes(header.result)) {
    historyFail(label, 'terminal result is not allowed by the released phase.');
  }
  const liveReadback = record.liveReadback === undefined ? undefined : historyArray(record.liveReadback, `${label}.liveReadback`)
    .map((proof) => validated(proof, `${label}.liveReadback`, readers().validators.validateLiveReadbackProof));
  const normalized = [...(liveReadback ?? [])].sort((left, right) => canonicalSha256(left).localeCompare(canonicalSha256(right), 'en'));
  if (header.bodyDigest !== canonicalSha256({ payload: record.payload ?? null, liveReadback: normalized }) ||
      liveReadback?.some((proof) => proof.repositoryId !== header.repositoryId || proof.phaseId !== header.phaseId ||
        canonicalSha256(proof.transition) !== canonicalSha256(header.transition))) {
    historyFail(label, 'body digest or readback linkage differs from the released v3 record.', 'invalid-historical-reference');
  }
  return {
    evidenceId: historyRecordId(record.evidenceId, `${label}.evidenceId`),
    header: header as HistoricalV3EvidenceRecord['header'],
    ...(record.payload === undefined ? {} : { payload: record.payload }),
    ...(liveReadback === undefined ? {} : { liveReadback })
  };
}

export function validateHistoricalV3AuxiliaryRecord(value: unknown, kind: 'supersession' | 'reconciliation' | 'credential-policy'): void {
  const reader = kind === 'supersession' ? readers().validators.validateSupersessionRecord :
    kind === 'reconciliation' ? readers().validators.validateGraphReconciliationRecord : readers().validators.validateCredentialPolicy;
  validated<unknown>(value, `historicalV3.${kind}`, reader);
}

export function validateHistoricalV3Compatibility(value: unknown, label = 'historicalV3Compatibility'): void {
  assertSafeHistoricalRecord(value, label);
  const item = historyExact(value, ['schemaVersion', 'generatedBy', 'liftoffVersion', 'minimumLiftoffVersions', 'manifest', 'activation', 'managedCore'], label);
  historyLiteral(item.schemaVersion, 4, `${label}.schemaVersion`);
  historyLiteral(item.generatedBy, 'Mission Control Liftoff', `${label}.generatedBy`);
  historyLiteral(item.liftoffVersion, '0.12.0', `${label}.liftoffVersion`);
  const minimum = historyExact(item.minimumLiftoffVersions, ['manifestWriteVersion7', 'remedy'], `${label}.minimumLiftoffVersions`);
  historyLiteral(minimum.manifestWriteVersion7, '0.10.0', `${label}.minimumLiftoffVersions.manifestWriteVersion7`);
  historyString(minimum.remedy, `${label}.minimumLiftoffVersions.remedy`);
  const manifest = historyExact(item.manifest, ['readVersions', 'writeVersion', 'hashAuthority'], `${label}.manifest`);
  historyLiteral(manifest.writeVersion, 7, `${label}.manifest.writeVersion`);
  historyLiteral(manifest.hashAuthority, 'liftoff.manifest.json managedArtifacts[].contentHash', `${label}.manifest.hashAuthority`);
  if (canonicalSha256(manifest.readVersions) !== canonicalSha256([2, 3, 4, 5, 6, 7])) historyFail(label, 'has unsupported manifest readers.');
  const activation = historyExact(item.activation, ['currentCompatibleTuples', 'historicalReadability', 'recognizedGraphHashes', 'graphMappings', 'historicalStateMigrations', 'successorMigrations', 'unsupportedRemedy'], `${label}.activation`);
  const historical = historyExact(activation.historicalReadability, ['tuples', 'readers', 'execution', 'migration'], `${label}.historicalReadability`);
  const ancestors = [historicalV1ActivationIdentity, historicalV2ActivationIdentity];
  if (canonicalSha256(activation.currentCompatibleTuples) !== canonicalSha256([historicalV3ActivationIdentity]) ||
      canonicalSha256(activation.recognizedGraphHashes) !== canonicalSha256([historicalV3ActivationIdentity.phaseGraphHash]) ||
      canonicalSha256(activation.graphMappings) !== canonicalSha256([]) ||
      canonicalSha256(activation.historicalStateMigrations) !== canonicalSha256([]) ||
      canonicalSha256(historical.tuples) !== canonicalSha256(ancestors) ||
      canonicalSha256(historical.readers) !== canonicalSha256(['activation-v1', 'activation-v2']) ||
      canonicalSha256(activation.successorMigrations) !== canonicalSha256(ancestors.map((identity) => ({
        id: `activation-v${identity.activationContractVersion}-to-v3`, fromIdentity: identity, toIdentity: historicalV3ActivationIdentity,
        strategy: 'preserve-history-revalidate', historySchemaVersion: 1, journalSchemaVersion: 1
      })))) historyFail(label, 'contains an undeclared released identity or successor lane.');
  historyLiteral(historical.execution, 'diagnostic-only', `${label}.execution`);
  historyLiteral(historical.migration, 'explicit-successor-preserve-bytes', `${label}.migration`);
  historyString(activation.unsupportedRemedy, `${label}.unsupportedRemedy`);
  const core = historyExact(item.managedCore, ['logicalNameAllowlist', 'pathAllowlist', 'updateInventory', 'validation'], `${label}.managedCore`);
  const names = historyStrings(core.logicalNameAllowlist, `${label}.logicalNameAllowlist`);
  const paths = historyArray(core.pathAllowlist, `${label}.pathAllowlist`).map((parts) => historyPathParts(parts, `${label}.pathAllowlist`).join('/'));
  const entries = historyArray(core.updateInventory, `${label}.updateInventory`).map((value) => {
    const entry = historyExact(value, ['logicalName', 'pathParts', 'lifecycle', 'contentHashAuthority'], `${label}.updateInventory`);
    historyLiteral(entry.lifecycle, 'managed-core', `${label}.lifecycle`);
    historyLiteral(entry.contentHashAuthority, 'liftoff.manifest.json managedArtifacts[].contentHash', `${label}.contentHashAuthority`);
    return { name: historyString(entry.logicalName, `${label}.logicalName`), path: historyPathParts(entry.pathParts, `${label}.pathParts`).join('/') };
  });
  if (new Set(names).size !== names.length || new Set(paths.map((path) => path.normalize('NFC').toLowerCase())).size !== paths.length ||
      new Set(entries.map((entry) => entry.name)).size !== entries.length ||
      entries.length !== paths.length || entries.some((entry) => !names.includes(entry.name) || !paths.includes(entry.path)) ||
      canonicalSha256(core.validation) !== canonicalSha256({ strictJson: true, crossPlatformPathParts: true, noSetupSkillVersion: true, checkModeWritesBytes: 0 })) {
    historyFail(label, 'contains an inconsistent or unsafe released managed inventory.');
  }
}
