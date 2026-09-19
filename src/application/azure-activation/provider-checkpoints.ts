import { lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../../domain/governance/activation/graph.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import { AzureActivationAdmissionError, assertAzurePhaseAuthority } from './authority.js';
import { NIL_UUID, UUID_PATTERN } from '../../adapters/azure/production-adapter.js';
import type { AzureArmError, AzureProviderObservation } from '../../adapters/azure/activation-rest.js';

export interface ProviderPreparedCheckpoint {
  schemaVersion: 1;
  kind: 'azure-provider-registration-prepared';
  projectRoot: string;
  projectIdentity: { device: string; inode: string; birthtime: string };
  activationIdentityDigest: string;
  intentDigest: string;
  operationDigest: string;
  planDigest: string;
  approvalEnvelopeHash: string;
  namespace: string;
  attempt: number;
  clientRequestId: string;
  preparedAt: string;
}

export interface ProviderSubmittedCheckpoint {
  schemaVersion: 1;
  kind: 'azure-provider-registration-submitted';
  preparedDigest: string;
  requestId: string;
  submittedAt: string;
}

export interface ProviderSettledCheckpoint {
  schemaVersion: 1;
  kind: 'azure-provider-registration-settled';
  preparedDigest: string;
  outcome: 'registered' | 'not-dispatched' | 'rejected';
  requestId: string | null;
  status: number | null;
  observedAt: string;
}

function intent(operation: TransitionOperation): string {
  const { expected: _expected, ...inputs } = operation.inputs;
  return canonicalSha256({
    kind: 'azure-provider-registration', phaseId: operation.phaseId, actionId: operation.actionId,
    destination: operation.destination, inputs
  });
}

function key(operation: TransitionOperation, namespace: string, attempt: number, stage: string): string {
  return canonicalSha256({ intentDigest: intent(operation), namespace, attempt, stage });
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((name) => !Object.hasOwn(value, name))) {
    throw new AzureActivationAdmissionError('checkpoint-invalid', 'The immutable private provider checkpoint has unsupported or missing fields; no retry is authorized.');
  }
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value) || value === NIL_UUID) {
    throw new AzureActivationAdmissionError('checkpoint-invalid', 'The provider checkpoint has no valid exact request identity.');
  }
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new AzureActivationAdmissionError('checkpoint-invalid', 'The provider checkpoint has a malformed exact digest.');
  }
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new AzureActivationAdmissionError('checkpoint-invalid', 'The provider checkpoint has an invalid time binding.');
  return value;
}

export async function readProviderCheckpoints(input: PhaseAdapterExecutionInput, operation: TransitionOperation, namespace: string) {
  const store = createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', azurePorts(input).storage);
  const stat = await lstat(input.inspection.projectRoot);
  const root = await realpath(input.inspection.projectRoot);
  let latest: {
    prepared: ProviderPreparedCheckpoint;
    submitted: ProviderSubmittedCheckpoint | null;
    settled: ProviderSettledCheckpoint | null;
  } | null = null;
  for (let attempt = 0; attempt < 16; attempt++) {
    const preparedRecord = await store.read(key(operation, namespace, attempt, 'prepared'));
    const submittedRecord = await store.read(key(operation, namespace, attempt, 'submitted'));
    const settledRecord = await store.read(key(operation, namespace, attempt, 'settled'));
    if (!preparedRecord) {
      if (submittedRecord || settledRecord) throw new AzureActivationAdmissionError('checkpoint-invalid', 'Provider outcome has no matching immutable pre-effect record.');
      return latest;
    }
    if (latest && !latest.settled) throw new AzureActivationAdmissionError('checkpoint-invalid', 'A provider attempt was started before the previous attempt had a known outcome.');
    const p = record(preparedRecord.value, [
      'schemaVersion', 'kind', 'projectRoot', 'projectIdentity', 'activationIdentityDigest', 'intentDigest', 'operationDigest',
      'planDigest', 'approvalEnvelopeHash', 'namespace', 'attempt', 'clientRequestId', 'preparedAt'
    ]);
    const identity = record(p.projectIdentity, ['device', 'inode', 'birthtime']);
    if (p.schemaVersion !== 1 || p.kind !== 'azure-provider-registration-prepared' || p.attempt !== attempt ||
      p.projectRoot !== root || preparedRecord.projectRoot !== root || !stat.isDirectory() || stat.isSymbolicLink() ||
      identity.device !== String(stat.dev) || identity.inode !== String(stat.ino) || identity.birthtime !== String(stat.birthtimeMs) ||
      p.activationIdentityDigest !== canonicalSha256(currentActivationIdentity) || p.intentDigest !== intent(operation) ||
      p.namespace !== namespace) {
      throw new AzureActivationAdmissionError('checkpoint-mismatch', 'The private provider checkpoint belongs to another project creation identity or exact operation target.');
    }
    const prepared: ProviderPreparedCheckpoint = {
      schemaVersion: 1, kind: 'azure-provider-registration-prepared', projectRoot: root,
      projectIdentity: { device: String(stat.dev), inode: String(stat.ino), birthtime: String(stat.birthtimeMs) },
      activationIdentityDigest: canonicalSha256(currentActivationIdentity), intentDigest: intent(operation),
      operationDigest: hash(p.operationDigest), planDigest: hash(p.planDigest), approvalEnvelopeHash: hash(p.approvalEnvelopeHash),
      namespace, attempt, clientRequestId: uuid(p.clientRequestId), preparedAt: timestamp(p.preparedAt)
    };
    let submitted: ProviderSubmittedCheckpoint | null = null;
    if (submittedRecord) {
      const s = record(submittedRecord.value, ['schemaVersion', 'kind', 'preparedDigest', 'requestId', 'submittedAt']);
      if (s.schemaVersion !== 1 || s.kind !== 'azure-provider-registration-submitted' || s.preparedDigest !== canonicalSha256(prepared) ||
        Date.parse(timestamp(s.submittedAt)) < Date.parse(prepared.preparedAt)) {
        throw new AzureActivationAdmissionError('checkpoint-mismatch', 'Provider submission checkpoint is not bound to its exact pre-effect record.');
      }
      submitted = {
        schemaVersion: 1, kind: 'azure-provider-registration-submitted', preparedDigest: canonicalSha256(prepared),
        requestId: uuid(s.requestId), submittedAt: timestamp(s.submittedAt)
      };
    }
    let settled: ProviderSettledCheckpoint | null = null;
    if (settledRecord) {
      const s = record(settledRecord.value, ['schemaVersion', 'kind', 'preparedDigest', 'outcome', 'requestId', 'status', 'observedAt']);
      const outcome = s.outcome;
      const status = s.status;
      if ((outcome !== 'registered' && outcome !== 'not-dispatched' && outcome !== 'rejected') ||
        status !== null && (typeof status !== 'number' || !Number.isSafeInteger(status))) {
        throw new AzureActivationAdmissionError('checkpoint-invalid', 'Provider settlement has an unsupported outcome or HTTP status.');
      }
      if (s.schemaVersion !== 1 || s.kind !== 'azure-provider-registration-settled' || s.preparedDigest !== canonicalSha256(prepared) ||
        (outcome === 'not-dispatched' ? s.requestId !== null || status !== null || submitted !== null :
          typeof s.requestId !== 'string' || status === null ||
          (outcome === 'registered' ? status !== 200 : ![401, 403, 404, 422].includes(status))) ||
        Date.parse(timestamp(s.observedAt)) < Date.parse(prepared.preparedAt)) {
        throw new AzureActivationAdmissionError('checkpoint-invalid', 'Provider settlement is not an independently recorded terminal or undispatched outcome.');
      }
      settled = {
        schemaVersion: 1, kind: 'azure-provider-registration-settled', preparedDigest: canonicalSha256(prepared),
        outcome,
        requestId: s.requestId === null ? null : uuid(s.requestId),
        status, observedAt: timestamp(s.observedAt)
      };
    }
    if (!settled && prepared.operationDigest !== canonicalSha256(operation)) {
      throw new AzureActivationAdmissionError('checkpoint-mismatch', 'An unresolved provider attempt has a different exact reviewed precondition; it cannot be replaced by a new plan.');
    }
    latest = { prepared, submitted, settled };
  }
  throw new AzureActivationAdmissionError('checkpoint-limit', 'Sixteen retained registration attempts exhaust the supported recovery bound; no checkpoint may be silently replaced.');
}

export async function prepareProviderRegistration(input: PhaseAdapterExecutionInput, operation: TransitionOperation, namespace: string) {
  await assertAzurePhaseAuthority(input, operation);
  if (operation.inputs.namespace !== namespace || operation.mutationClass !== 'azure-provider-register') {
    throw new AzureActivationAdmissionError('checkpoint-operation', 'A provider pre-effect checkpoint must bind its exact reviewed namespace write.');
  }
  const previous = await readProviderCheckpoints(input, operation, namespace);
  if (previous && (!previous.settled || !input.recovery ||
    previous.prepared.approvalEnvelopeHash === input.plan.approval.envelopeHash)) {
    throw new AzureActivationAdmissionError('recovery-required', 'A previous provider attempt requires known settlement and a fresh separately approved recovery plan before another dispatch.');
  }
  const stat = await lstat(input.inspection.projectRoot);
  const root = await realpath(input.inspection.projectRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AzureActivationAdmissionError('checkpoint-target', 'Provider registration target must retain its original regular project directory.');
  const prepared: ProviderPreparedCheckpoint = {
    schemaVersion: 1, kind: 'azure-provider-registration-prepared', projectRoot: root,
    projectIdentity: { device: String(stat.dev), inode: String(stat.ino), birthtime: String(stat.birthtimeMs) },
    activationIdentityDigest: canonicalSha256(currentActivationIdentity), intentDigest: intent(operation),
    operationDigest: canonicalSha256(operation), planDigest: input.plan.planDigest,
    approvalEnvelopeHash: hash(input.plan.approval.envelopeHash), namespace, attempt: previous ? previous.prepared.attempt + 1 : 0,
    clientRequestId: randomUUID(), preparedAt: (input.clock?.() ?? input.now).toISOString()
  };
  await createScopedUserLocalRecordStore(root, 'governance-operation', azurePorts(input).storage)
    .write(key(operation, namespace, prepared.attempt, 'prepared'), prepared);
  await input.lease!.assertHeld();
  return prepared;
}

export async function submitProviderRegistration(
  input: PhaseAdapterExecutionInput, operation: TransitionOperation, prepared: ProviderPreparedCheckpoint, requestId: string
) {
  const submitted: ProviderSubmittedCheckpoint = {
    schemaVersion: 1, kind: 'azure-provider-registration-submitted', preparedDigest: canonicalSha256(prepared),
    requestId: uuid(requestId), submittedAt: (input.clock?.() ?? input.now).toISOString()
  };
  await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', azurePorts(input).storage)
    .write(key(operation, prepared.namespace, prepared.attempt, 'submitted'), submitted);
  return submitted;
}

export async function settleProviderRegistration(
  input: PhaseAdapterExecutionInput, operation: TransitionOperation, prepared: ProviderPreparedCheckpoint,
  result: AzureProviderObservation | AzureArmError
): Promise<'settled' | 'unsettled'> {
  const observed = 'namespace' in result;
  if (observed && (result.namespace !== prepared.namespace || result.state !== 'Registered')) {
    throw new AzureActivationAdmissionError('checkpoint-observation', 'Provider settlement requires an exact terminal Registered observation, not an inferred outcome.');
  }
  if (!observed && result.dispatched !== false && !(result.requestId && result.status && [401, 403, 404, 422].includes(result.status))) {
    return 'unsettled';
  }
  const settlement: ProviderSettledCheckpoint = {
    schemaVersion: 1, kind: 'azure-provider-registration-settled', preparedDigest: canonicalSha256(prepared),
    outcome: observed ? 'registered' : result.dispatched === false ? 'not-dispatched' : 'rejected',
    requestId: observed ? uuid(result.requestId) : result.dispatched === false ? null : uuid(result.requestId),
    status: observed ? 200 : result.dispatched === false ? null : result.status!,
    observedAt: (input.clock?.() ?? input.now).toISOString()
  };
  const store = createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', azurePorts(input).storage);
  const checkpointKey = key(operation, prepared.namespace, prepared.attempt, 'settled');
  const existing = await store.read(checkpointKey);
  if (existing) {
    await readProviderCheckpoints(input, operation, prepared.namespace);
    return 'settled';
  }
  await store.write(checkpointKey, settlement);
  return 'settled';
}
