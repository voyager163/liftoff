import {
  historyArray, historyBoolean, historyEnum, historyExact, historyFail, historyLiteral,
  historyRecordId, historyString, historyTimestamp, historicalV1Identity
} from './history-contracts.js';
import { historicalV1ActivationIdentity } from '../domain/governance/policy/identity.js';
import { historicalPhaseIds, historicalV1PhaseContractDigests } from './historical-v1-phase-contracts.js';
import { validateHistoricalV1CredentialPolicy } from './historical-credential-policy.js';
import { assertSafeHistoricalRecord } from './historical-safety.js';

export function validateHistoricalV1AuxiliaryRecord(value: unknown, kind: 'supersession' | 'reconciliation' | 'credential-policy'): void {
  const label = `historicalV1.${kind}`;
  assertSafeHistoricalRecord(value, label);
  if (kind === 'credential-policy') return validateHistoricalV1CredentialPolicy(value);
  if (kind === 'supersession') {
    const item = historyExact(value, ['schemaVersion', 'identity', 'supersededChangeId', 'supersedingChangeId', 'reason', 'approvedAt', 'approver'], label);
    historyLiteral(item.schemaVersion, 1, `${label}.schemaVersion`);
    historicalV1Identity(item.identity, `${label}.identity`);
    historyRecordId(item.supersededChangeId, `${label}.supersededChangeId`);
    historyRecordId(item.supersedingChangeId, `${label}.supersedingChangeId`);
    for (const key of ['reason', 'approvedAt', 'approver']) historyString(item[key], `${label}.${key}`);
    return;
  }
  const item = historyExact(value, ['schemaVersion', 'fromGraphHash', 'toGraphHash', 'fromIdentity', 'toIdentity', 'phaseMappings', 'reconciledAt', 'producer'], label);
  historyLiteral(item.schemaVersion, 1, `${label}.schemaVersion`);
  historicalV1Identity(item.fromIdentity, `${label}.fromIdentity`);
  historicalV1Identity(item.toIdentity, `${label}.toIdentity`);
  historyLiteral(item.fromGraphHash, historicalV1ActivationIdentity.phaseGraphHash, `${label}.fromGraphHash`);
  historyLiteral(item.toGraphHash, historicalV1ActivationIdentity.phaseGraphHash, `${label}.toGraphHash`);
  const seen = new Set<string>();
  for (const entry of historyArray(item.phaseMappings, `${label}.phaseMappings`)) {
    const mapping = historyExact(entry, ['phaseId', 'fromContractDigest', 'toContractDigest', 'preserveEvidence'], label);
    const id = historyEnum(mapping.phaseId, historicalPhaseIds, `${label}.phaseId`);
    if (seen.has(id)) historyFail(label, 'contains duplicate phase mappings.');
    seen.add(id);
    historyLiteral(mapping.fromContractDigest, historicalV1PhaseContractDigests[id], `${label}.fromContractDigest`);
    historyLiteral(mapping.toContractDigest, historicalV1PhaseContractDigests[id], `${label}.toContractDigest`);
    historyBoolean(mapping.preserveEvidence, `${label}.preserveEvidence`);
  }
  if (seen.size !== historicalPhaseIds.length) historyFail(label, 'requires the complete historical phase mapping.');
  historyTimestamp(item.reconciledAt, `${label}.reconciledAt`);
  historyString(item.producer, `${label}.producer`);
}
