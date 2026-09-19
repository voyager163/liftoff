import type { HistoricalActivationIdentity } from '../domain/governance/policy/identity.js';
import { historicalPhaseIds, type HistoricalPhaseId } from './historical-v1-phase-contracts.js';
import { historicalV3PhaseIds } from './historical-v3.js';
import { historicalV4Policy7PhaseGraph } from './historical-v4-policy7.js';
import type { PhaseId } from '../domain/governance/activation/types.js';
import {
  historicalIdentity, historyArray, historyDigest, historyEnum, historyExact, historyFail, historyLiteral,
  historyRecordId, historyString, historyStrings, historyTimestamp
} from './history-contracts.js';
import { assertSafeHistoricalRecord } from './historical-safety.js';

export interface HistoricalGovernanceChangeMetadata {
  schemaVersion: 1;
  marker: 'liftoff-governance-source-of-truth';
  changeId: string;
  workflowKind: 'openspec' | 'spec-kit';
  activationIdentity: HistoricalActivationIdentity;
  phaseGraphHash: string;
  baselineSha: string;
  phaseTaskMapping: readonly {
    phaseId: PhaseId; taskId: string; marker: string; policy: 'evidence-projection-v1';
  }[];
  currentPolicy: {
    phaseAuthority: 'managed-phase-graph';
    taskCompletion: 'authoritative-evidence-projection';
    approvalPolicy: 'approval-envelope-required-for-gated-phases';
  };
  createdFrom: { kind: 'approved-phase-0-facts'; approvedFactDigest: string; evidenceIds: string[] };
  acknowledgedAt: string;
  owner: string;
}

export function validateHistoricalGovernanceChangeMetadata(value: unknown): HistoricalGovernanceChangeMetadata {
  const label = 'historicalGovernanceChange';
  assertSafeHistoricalRecord(value, label);
  const item = historyExact(value, [
    'schemaVersion', 'marker', 'changeId', 'workflowKind', 'activationIdentity', 'phaseGraphHash',
    'baselineSha', 'phaseTaskMapping', 'currentPolicy', 'createdFrom', 'acknowledgedAt', 'owner'
  ], label);
  const identity = historicalIdentity(item.activationIdentity, `${label}.activationIdentity`);
  const sourcePhaseIds = identity.activationContractVersion === 4 ? historicalV4Policy7PhaseGraph().phases.map((phase) => phase.id) :
    identity.activationContractVersion === 3 ? historicalV3PhaseIds : historicalPhaseIds;
  historyLiteral(item.phaseGraphHash, identity.phaseGraphHash, `${label}.phaseGraphHash`);
  const phases = new Set<string>();
  const tasks = new Set<string>();
  const mappings = historyArray(item.phaseTaskMapping, `${label}.phaseTaskMapping`).map((entry) => {
    const mapping = historyExact(entry, ['phaseId', 'taskId', 'marker', 'policy'], `${label}.phaseTaskMapping`);
    const phaseId = historyEnum(mapping.phaseId, sourcePhaseIds, `${label}.phaseId`);
    const taskId = historyString(mapping.taskId, `${label}.taskId`);
    if (phases.has(phaseId) || tasks.has(taskId)) historyFail(label, 'contains duplicate phase or task mappings.');
    phases.add(phaseId);
    tasks.add(taskId);
    return {
      phaseId, taskId,
      marker: historyLiteral(mapping.marker, `<!-- liftoff-phase: ${phaseId} -->`, `${label}.marker`),
      policy: historyLiteral(mapping.policy, 'evidence-projection-v1', `${label}.policy`)
    };
  });
  if (phases.size !== sourcePhaseIds.length) historyFail(label, 'requires every phase of the exact published historical family.');
  const policy = historyExact(item.currentPolicy, ['phaseAuthority', 'taskCompletion', 'approvalPolicy'], `${label}.currentPolicy`);
  const created = historyExact(item.createdFrom, ['kind', 'approvedFactDigest', 'evidenceIds'], `${label}.createdFrom`);
  return {
    schemaVersion: historyLiteral(item.schemaVersion, 1, `${label}.schemaVersion`),
    marker: historyLiteral(item.marker, 'liftoff-governance-source-of-truth', `${label}.marker`),
    changeId: historyRecordId(item.changeId, `${label}.changeId`),
    workflowKind: historyEnum(item.workflowKind, ['openspec', 'spec-kit'], `${label}.workflowKind`),
    activationIdentity: identity, phaseGraphHash: identity.phaseGraphHash,
    baselineSha: historyDigest(item.baselineSha, `${label}.baselineSha`), phaseTaskMapping: mappings,
    currentPolicy: {
      phaseAuthority: historyLiteral(policy.phaseAuthority, 'managed-phase-graph', `${label}.currentPolicy.phaseAuthority`),
      taskCompletion: historyLiteral(policy.taskCompletion, 'authoritative-evidence-projection', `${label}.currentPolicy.taskCompletion`),
      approvalPolicy: historyLiteral(policy.approvalPolicy, 'approval-envelope-required-for-gated-phases', `${label}.currentPolicy.approvalPolicy`)
    },
    createdFrom: {
      kind: historyLiteral(created.kind, 'approved-phase-0-facts', `${label}.createdFrom.kind`),
      approvedFactDigest: historyDigest(created.approvedFactDigest, `${label}.createdFrom.approvedFactDigest`),
      evidenceIds: historyStrings(created.evidenceIds, `${label}.createdFrom.evidenceIds`).map((id) => historyRecordId(id, `${label}.evidenceId`))
    },
    acknowledgedAt: historyTimestamp(item.acknowledgedAt, `${label}.acknowledgedAt`),
    owner: historyString(item.owner, `${label}.owner`)
  };
}
