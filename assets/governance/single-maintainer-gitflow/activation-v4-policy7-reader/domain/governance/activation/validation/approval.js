import { canonicalPhaseGraph } from '../graph.js';
import { approvalEnvelopeSchemaVersion } from '../../policy/identity.js';
import { normalizeApprovalCostCeiling, normalizeApprovalDestinations, normalizeApprovalDestructiveScope, normalizeApprovalPermissions, normalizeApprovalPolicyExceptions, normalizeApprovalResources } from '../approvals.js';
                                                                                                                    
import { approvalGateKinds, phaseScope } from '../types.js';
import { phaseIdSet, hex64Pattern, record, exact, exactWithOptional, stringField, integerField, stringArray, enumValue, requireVersion, hexDigest, isoTimestamp, exactStringSet, assertNoDuplicateStrings, assertTimestampNotExpired } from './common.js';
import { validateActivationIdentity } from './identity.js';

export function validateApprovalResource(value         , path        )                                        {
  const resource = exact(value, ['type', 'identity'], path);
  return {
    type: stringField(resource, 'type', path),
    identity: stringField(resource, 'identity', path)
  };
}

export function validateApprovalDestination(value         , path        )                                           {
  const destination = exact(value, ['type', 'identity', 'repository', 'subscriptionId'], path);
  return {
    type: enumValue(destination.type, new Set(['repository', 'subscription', 'environment', 'tenant', 'local', 'external']), `${path}.type`),
    identity: stringField(destination, 'identity', path),
    repository: destination.repository === null ? null : stringField(destination, 'repository', path),
    subscriptionId: destination.subscriptionId === null ? null : stringField(destination, 'subscriptionId', path)
  };
}

export function identityMatches(left                    , right                    )          {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateApprovalEnvelope(
  value         ,
  options                                                                                    = {}
)                   {
  const envelope = exactWithOptional(value, [
    'schemaVersion',
    'id',
    'phaseId',
    'gateKind',
    'identity',
    'baselineSha',
    'planDigest',
    'resources',
    'destinations',
    'permissions',
    'costCeiling',
    'policyExceptions',
    'destructiveScope',
    'expiresAt',
    'approvedAt',
    'approver'
  ], ['scope', 'coveredPhases', 'operationDigests', 'phasePlanDigests'], 'approvalEnvelope');
  requireVersion(envelope.schemaVersion, approvalEnvelopeSchemaVersion, 'approvalEnvelope.schemaVersion');
  const cost = exact(envelope.costCeiling, [
    'currency',
    'fixedMonthlyCents',
    'usageMonthlyCents'
  ], 'approvalEnvelope.costCeiling');
  const baselineSha = stringField(envelope, 'baselineSha', 'approvalEnvelope');
  const planDigest = stringField(envelope, 'planDigest', 'approvalEnvelope');
  if (!hex64Pattern.test(baselineSha) || !hex64Pattern.test(planDigest)) {
    throw new Error('approvalEnvelope baselineSha and planDigest must be SHA-256 hex digests.');
  }
  const identity = validateActivationIdentity(envelope.identity);
  if (options.expectedIdentity && !identityMatches(identity, options.expectedIdentity)) {
    throw new Error('approvalEnvelope.identity does not match the active activation identity.');
  }
  const expiresAt = isoTimestamp(envelope.expiresAt, 'approvalEnvelope.expiresAt');
  const approvedAt = isoTimestamp(envelope.approvedAt, 'approvalEnvelope.approvedAt');
  if (Date.parse(approvedAt) >= Date.parse(expiresAt)) throw new Error('Approval requires approvedAt < expiresAt.');
  if (options.requireUnexpired) {
    assertTimestampNotExpired(expiresAt, 'approvalEnvelope.expiresAt', options.now ?? new Date());
    if (Date.parse(approvedAt) > (options.now ?? new Date()).getTime()) throw new Error('Approval approvedAt is in the future.');
  }
  const resources = Array.isArray(envelope.resources)
    ? normalizeApprovalResources(envelope.resources.map((entry, index) =>
      validateApprovalResource(entry, `approvalEnvelope.resources[${index}]`)
    ))
    : (() => { throw new Error('approvalEnvelope.resources must be an array.'); })();
  const destinations = Array.isArray(envelope.destinations)
    ? normalizeApprovalDestinations(envelope.destinations.map((entry, index) =>
      validateApprovalDestination(entry, `approvalEnvelope.destinations[${index}]`)
    ))
    : (() => { throw new Error('approvalEnvelope.destinations must be an array.'); })();
  const permissions = normalizeApprovalPermissions(stringArray(envelope.permissions, 'approvalEnvelope.permissions'));
  const policyExceptions = normalizeApprovalPolicyExceptions(stringArray(envelope.policyExceptions, 'approvalEnvelope.policyExceptions'));
  const destructiveScope = normalizeApprovalDestructiveScope(stringArray(envelope.destructiveScope, 'approvalEnvelope.destructiveScope'));
  const costCeiling = normalizeApprovalCostCeiling({
    currency: stringField(cost, 'currency', 'approvalEnvelope.costCeiling'),
    fixedMonthlyCents: integerField(cost, 'fixedMonthlyCents', 'approvalEnvelope.costCeiling'),
    usageMonthlyCents: integerField(cost, 'usageMonthlyCents', 'approvalEnvelope.costCeiling')
  });
  const phaseId = enumValue         (envelope.phaseId, phaseIdSet, 'approvalEnvelope.phaseId');
  const gateKind = enumValue                  (envelope.gateKind, new Set        (approvalGateKinds), 'approvalEnvelope.gateKind');
  const expectedGateKind = canonicalPhaseGraph.phases.find((phase) => phase.id === phaseId)?.approvalGate.kind;
  if (expectedGateKind !== gateKind) {
    throw new Error(`approvalEnvelope.gateKind ${gateKind} does not match phase ${phaseId} gate ${expectedGateKind}.`);
  }
  const coveredPhases = envelope.coveredPhases === undefined ? undefined : stringArray(envelope.coveredPhases, 'approvalEnvelope.coveredPhases')
    .map((id) => enumValue         (id, phaseIdSet, 'approvalEnvelope.coveredPhases'));
  const operationDigests = envelope.operationDigests === undefined ? undefined : stringArray(envelope.operationDigests, 'approvalEnvelope.operationDigests')
    .map((digest) => hexDigest(digest, 'approvalEnvelope.operationDigests'));
  if (coveredPhases) {
    assertNoDuplicateStrings(coveredPhases, 'approvalEnvelope.coveredPhases');
    if (!coveredPhases.includes(phaseId) || coveredPhases.some((id) =>
      phaseScope(id) !== phaseScope(phaseId) || canonicalPhaseGraph.phases.find((phase) => phase.id === id)?.approvalGate.kind !== gateKind)) {
      throw new Error('An approval bundle must contain its primary phase and only phases in the same scope and authority gate.');
    }
  }
  if (operationDigests) assertNoDuplicateStrings(operationDigests, 'approvalEnvelope.operationDigests');
  const phasePlanDigests                                   = {};
  if (envelope.phasePlanDigests !== undefined) {
    for (const [id, digest] of Object.entries(record(envelope.phasePlanDigests, 'approvalEnvelope.phasePlanDigests'))) {
      phasePlanDigests[enumValue         (id, phaseIdSet, 'approvalEnvelope.phasePlanDigests')] =
        hexDigest(digest, `approvalEnvelope.phasePlanDigests.${id}`);
    }
    exactStringSet(Object.keys(phasePlanDigests), coveredPhases ?? [phaseId], 'approvalEnvelope.phasePlanDigests');
  } else if ((coveredPhases?.length ?? 0) > 1) {
    throw new Error('An approval covering multiple phases requires every exact phase plan digest.');
  }
  return {
    schemaVersion: approvalEnvelopeSchemaVersion,
    id: stringField(envelope, 'id', 'approvalEnvelope'),
    phaseId,
    gateKind,
    identity,
    baselineSha,
    planDigest,
    resources,
    destinations,
    permissions,
    costCeiling,
    policyExceptions,
    destructiveScope,
    expiresAt,
    approvedAt,
    approver: stringField(envelope, 'approver', 'approvalEnvelope'),
    ...(envelope.scope === undefined ? {} : { scope: enumValue                 (envelope.scope, new Set([phaseScope(phaseId)]), 'approvalEnvelope.scope') }),
    ...(coveredPhases ? { coveredPhases } : {}),
    ...(operationDigests ? { operationDigests } : {}),
    ...(envelope.phasePlanDigests === undefined ? {} : { phasePlanDigests })
  };
}
