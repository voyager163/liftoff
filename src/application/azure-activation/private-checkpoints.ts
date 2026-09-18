import { lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  createScopedUserLocalRecordStore, ScopedMetadataEnumerationError, type ScopedMetadataEnumerationOptions,
  type ScopedUserLocalRecord
} from '../../adapters/filesystem/update-previews.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../../domain/governance/activation/graph.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import type { PhaseAdapterExecutionInput, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { assertAzurePhaseAuthority, AzureActivationAdmissionError } from './authority.js';

export type PrivateEffectKind =
  | 'bootstrap-arm-resource' | 'runner-network-configuration' | 'runner-group' | 'runner-hosted-runner'
  | 'runner-workflow-dispatch' | 'runner-group-assignment' | 'remote-state-effect' | 'backend-lease-proof';

export interface PrivateEffectIntent {
  kind: PrivateEffectKind;
  step: string;
  provider: 'azure' | 'github';
  resourceId: string;
  request: Readonly<Record<string, unknown>>;
}

export interface PrivateEffectPrepared {
  schemaVersion: 1;
  kind: 'private-access-prepared';
  identityDigest: string;
  projectRoot: string;
  projectIdentity: { device: string; inode: string; birthtime: string };
  phaseId: string;
  actionId: string;
  intent: PrivateEffectIntent;
  operationDigest: string;
  planDigest: string;
  approvalEnvelopeHash: string;
  configurationDigest: string;
  attempt: number;
  clientRequestId: string;
  preparedAt: string;
}

export interface PrivateEffectSubmission {
  schemaVersion: 1;
  kind: 'private-access-returned';
  preparedDigest: string;
  requestId: string;
  resourceId: string;
  status: number;
  operationUrl: string | null;
  returnedAt: string;
}

export interface PrivateEffectSettlement {
  schemaVersion: 1;
  kind: 'private-access-settled';
  preparedDigest: string;
  outcome: 'verified' | 'rejected' | 'not-dispatched';
  readbackRequestId: string | null;
  readbackDigest: string | null;
  settledAt: string;
}

export interface PrivateEffectCheckpoint {
  key: string;
  prepared: PrivateEffectPrepared;
  submitted: PrivateEffectSubmission | null;
  settled: PrivateEffectSettlement | null;
}

export interface PrivateRunBinding {
  preparedDigest: string;
  runId: number;
  runAttempt: number;
  requestId: string;
}

export type PrivateEffectReadInput = PhasePlanningInput & Partial<Pick<PhaseAdapterExecutionInput, 'plan' | 'recovery'>>;

export async function assertNoLegacyRunnerDispatchCustody(input: PhaseAdapterExecutionInput): Promise<void> {
  assert(input.phase.id === 'runner-ready' && input.lease,
    'Runner metadata admission requires its actual project lease and phase.');
  await readPrivateRunnerCustodyMetadata(input);
}

export async function readPrivateRunnerCustodyMetadata(
  input: PhasePlanningInput & Pick<PhaseAdapterExecutionInput, 'lease'>, options: ScopedMetadataEnumerationOptions = {}
): Promise<readonly ScopedUserLocalRecord[]> {
  assert(input.lease, 'Private runner custody reads require the current project lease.');
  await input.lease.assertHeld();
  let records: readonly ScopedUserLocalRecord[];
  try {
    records = (await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', azurePorts(input).storage)
      .readAll(options)).records;
  } catch (error) {
    if (error instanceof ScopedMetadataEnumerationError) {
      throw new AzureActivationAdmissionError('private-metadata-inventory',
        `The exact project private metadata inventory is ${error.reason}; incomplete inventory cannot authorize GitHub access or a new dispatch.`);
    }
    throw error;
  }
  const prepared = new Set<string>();
  for (const record of records) {
    assert(isRecord(record.value), 'Private metadata is not an exact record; no new dispatch is authorized.');
    const value = record.value;
    if (value.kind === 'private-access-prepared') {
      assert(isRecord(value.intent) && typeof value.intent.kind === 'string' &&
        typeof value.phaseId === 'string' && typeof value.actionId === 'string',
      'An original private-access record is incomplete; preserve it before any runner dispatch.');
      prepared.add(canonicalSha256(value));
      assert(value.intent.kind !== 'runner-workflow-dispatch',
        'An earlier private-access dispatch checkpoint requires explicit recovery before switching to the shared dispatcher. Its original target, action and key cannot be ignored or retagged even when public pointers are absent.');
    } else if (typeof value.kind === 'string' && value.kind.startsWith('private-access-')) {
      assert(value.kind === 'private-access-returned' || value.kind === 'private-access-settled',
        'An unsupported original private-access record prevents complete runner admission.');
    }
    const keys = Object.keys(value).sort().join(',');
    assert(keys !== 'preparedDigest,requestId,runAttempt,runId',
      'An original private runner run binding remains in private custody; it cannot be synthesized into a new shared dispatch.');
  }
  for (const record of records) {
    const value = record.value;
    if (isRecord(value) && (value.kind === 'private-access-returned' || value.kind === 'private-access-settled')) {
      assert(typeof value.preparedDigest === 'string' && prepared.has(value.preparedDigest),
        'A private-access result has lost its original pre-effect metadata; absence of public pointers cannot authorize dispatch.');
    }
  }
  await input.lease.assertHeld();
  return records;
}

const actions: Readonly<Record<PrivateEffectKind, readonly string[]>> = {
  'bootstrap-arm-resource': ['azure.bootstrap-local.apply'],
  'runner-network-configuration': ['github.runner.ensure-ready'],
  'runner-group': ['github.runner.ensure-ready'],
  'runner-hosted-runner': ['github.runner.ensure-ready'],
  'runner-group-assignment': ['github.runner.ensure-ready'],
  'runner-workflow-dispatch': ['github.runner.ensure-ready', 'github.runner.backend-proof'],
  'remote-state-effect': ['azure.remote-import.verify'],
  'backend-lease-proof': ['azure.private-backend.lease.acquire', 'azure.private-backend.lease.renew', 'azure.private-backend.lease.release']
};
const digest = /^[a-f0-9]{64}$/u;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new AzureActivationAdmissionError('private-checkpoint', message);
}

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  assert(isRecord(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(','),
    'Private access checkpoint is malformed; no new dispatch or replacement is permitted.');
  return value;
}

function time(value: unknown): string {
  assert(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    'Private access checkpoint has an invalid time binding.');
  return value;
}

function providerId(value: unknown, provider: PrivateEffectIntent['provider']): string {
  assert(typeof value === 'string' && (provider === 'azure'
    ? uuid.test(value) && value !== '00000000-0000-0000-0000-000000000000'
    : /^[A-Fa-f0-9]{4}:[A-Fa-f0-9:]{4,100}$/u.test(value)),
  'A real returned provider request ID is required; a client correlation ID is not a substitute.');
  return value;
}

function keyFor(operation: TransitionOperation, intent: PrivateEffectIntent): string {
  assert(actions[intent.kind]?.includes(operation.actionId) &&
    typeof intent.step === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/u.test(intent.step) &&
    typeof intent.resourceId === 'string' && intent.resourceId.length > 0 && intent.resourceId.length <= 2048 &&
    !/[\u0000-\u001f\u007f]/u.test(intent.resourceId) && isRecord(intent.request), 'Private checkpoint is outside its declared access-establishing operation.');
  return canonicalSha256({
    kind: 'private-access-effects/1', phaseId: operation.phaseId, actionId: operation.actionId,
    destination: operation.destination, effect: intent.kind, step: intent.step, provider: intent.provider, target: intent.resourceId
  });
}

function stageKey(key: string, stage: string): string { return canonicalSha256({ key, stage }); }

export async function privateAccessProjectIdentity(root: string) {
  const info = await lstat(root);
  const canonical = await realpath(root);
  assert(info.isDirectory() && !info.isSymbolicLink() && canonical === root, 'Private access execution requires the original regular canonical project directory.');
  return { projectRoot: canonical, projectIdentity: { device: String(info.dev), inode: String(info.ino), birthtime: String(info.birthtimeMs) } };
}

async function readPrivateEffectAttempt(
  input: PrivateEffectReadInput, operation: TransitionOperation, intent: PrivateEffectIntent, attempt: number
): Promise<PrivateEffectCheckpoint | null> {
  const key = canonicalSha256({ intent: keyFor(operation, intent), attempt });
  const store = createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', azurePorts(input).storage);
  const [p, s, t] = await Promise.all(['prepared', 'returned', 'settled'].map((stage) => store.read(stageKey(key, stage))));
  if (!p) { assert(!s && !t, 'Private access outcome has no immutable pre-effect checkpoint.'); return null; }
  const prepared = exact(p.value, [
    'schemaVersion', 'kind', 'identityDigest', 'projectRoot', 'projectIdentity', 'phaseId', 'actionId', 'intent',
    'operationDigest', 'planDigest', 'approvalEnvelopeHash', 'configurationDigest', 'attempt', 'clientRequestId', 'preparedAt'
  ]);
  const identity = await privateAccessProjectIdentity(input.inspection.projectRoot);
  assert(prepared.schemaVersion === 1 && prepared.kind === 'private-access-prepared' &&
    prepared.identityDigest === canonicalSha256(currentActivationIdentity) &&
    prepared.projectRoot === identity.projectRoot && p.projectRoot === identity.projectRoot &&
    canonicalSha256(prepared.projectIdentity) === canonicalSha256(identity.projectIdentity) &&
    prepared.phaseId === operation.phaseId && prepared.actionId === operation.actionId && prepared.attempt === attempt &&
    canonicalSha256(prepared.intent) === canonicalSha256(intent) &&
    [prepared.operationDigest, prepared.planDigest, prepared.approvalEnvelopeHash, prepared.configurationDigest].every((v) =>
      typeof v === 'string' && digest.test(v)) && typeof prepared.clientRequestId === 'string' && uuid.test(prepared.clientRequestId),
  'Private access checkpoint belongs to different source, target, project creation identity or reviewed request; effects cannot be forgotten.');
  time(prepared.preparedAt);
  let submitted: PrivateEffectSubmission | null = null;
  let settled: PrivateEffectSettlement | null = null;
  if (s) {
    const value = exact(s.value, ['schemaVersion', 'kind', 'preparedDigest', 'requestId', 'resourceId', 'status', 'operationUrl', 'returnedAt']);
    assert(value.schemaVersion === 1 && value.kind === 'private-access-returned' && value.preparedDigest === canonicalSha256(prepared) &&
      typeof value.status === 'number' && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 &&
      typeof value.resourceId === 'string' && value.resourceId.length > 0 &&
      (value.operationUrl === null || typeof value.operationUrl === 'string') &&
      Date.parse(time(value.returnedAt)) >= Date.parse(String(prepared.preparedAt)), 'Private access submission does not match its prepared effect.');
    providerId(value.requestId, intent.provider);
    submitted = value as unknown as PrivateEffectSubmission;
  }
  if (t) {
    const value = exact(t.value, ['schemaVersion', 'kind', 'preparedDigest', 'outcome', 'readbackRequestId', 'readbackDigest', 'settledAt']);
    const recoveredRun = !submitted && value.outcome === 'verified' && intent.kind === 'runner-workflow-dispatch'
      ? await readPrivateRunBinding(input, { key, prepared: prepared as unknown as PrivateEffectPrepared, submitted, settled: null }) : null;
    assert(value.schemaVersion === 1 && value.kind === 'private-access-settled' && value.preparedDigest === canonicalSha256(prepared) &&
      ['verified', 'rejected', 'not-dispatched'].includes(String(value.outcome)) &&
      Date.parse(time(value.settledAt)) >= Date.parse(String(prepared.preparedAt)) &&
      (value.outcome === 'not-dispatched' ? !submitted && value.readbackRequestId === null && value.readbackDigest === null
        : (submitted !== null || recoveredRun !== null) && typeof value.readbackRequestId === 'string' &&
          typeof value.readbackDigest === 'string' && digest.test(value.readbackDigest)),
    'Private access settlement is not an attributable returned outcome.');
    if (value.readbackRequestId !== null) providerId(value.readbackRequestId, intent.provider);
    settled = value as unknown as PrivateEffectSettlement;
  }
  assert(settled || prepared.operationDigest === canonicalSha256(operation) ||
    input.recovery && input.plan && submitted && prepared.approvalEnvelopeHash !== input.plan.approval.envelopeHash,
    'Unresolved private access effects cannot be replaced by a different reviewed operation.');
  return { key, prepared: prepared as unknown as PrivateEffectPrepared, submitted, settled };
}

export async function readPrivateEffect(
  input: PrivateEffectReadInput, operation: TransitionOperation, intent: PrivateEffectIntent
): Promise<PrivateEffectCheckpoint | null> {
  let previous: PrivateEffectCheckpoint | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await readPrivateEffectAttempt(input, operation, intent, attempt);
    if (!current) return previous;
    assert(!previous || previous.settled && previous.settled.outcome !== 'verified' &&
      previous.prepared.approvalEnvelopeHash !== current.prepared.approvalEnvelopeHash,
    'A private effect attempt cannot follow unresolved or verified work or reuse an earlier approval.');
    previous = current;
  }
  return previous;
}

export async function preparePrivateEffect(
  input: PhaseAdapterExecutionInput, operation: TransitionOperation, intent: PrivateEffectIntent, plannedClientRequestId?: string
): Promise<PrivateEffectCheckpoint> {
  await assertAzurePhaseAuthority(input, operation);
  if (plannedClientRequestId !== undefined) {
    assert(intent.kind === 'backend-lease-proof' && operation.inputs.clientRequestId === plannedClientRequestId &&
      uuid.test(plannedClientRequestId) && plannedClientRequestId !== '00000000-0000-0000-0000-000000000000',
    'Only the exact reviewed backend lease client correlation may be supplied to its pre-effect checkpoint.');
  }
  assert(input.phase.approvalGate.required && input.plan.approval.envelopeHash,
    'Private access mutation requires an issued phase-specific approval; read-only authority cannot acquire leases or create resources.');
  const previous = await readPrivateEffect(input, operation, intent);
  assert(!previous || previous.settled && previous.settled.outcome !== 'verified' &&
    input.recovery && input.plan.recovery === true && previous.prepared.approvalEnvelopeHash !== input.plan.approval.envelopeHash,
  'This exact private access effect already has a durable checkpoint. Inspect or separately approve recovery of a known rejected/undispatched attempt; never blindly dispatch it again.');
  const attempt = previous ? previous.prepared.attempt + 1 : 0;
  assert(attempt < 8, 'Eight retained private effect attempts exhaust the supported recovery bound; no history is replaced.');
  const key = canonicalSha256({ intent: keyFor(operation, intent), attempt });
  const identity = await privateAccessProjectIdentity(input.inspection.projectRoot);
  const prepared: PrivateEffectPrepared = {
    schemaVersion: 1, kind: 'private-access-prepared', identityDigest: canonicalSha256(currentActivationIdentity), ...identity,
    phaseId: operation.phaseId, actionId: operation.actionId, intent: structuredClone(intent),
    operationDigest: canonicalSha256(operation), planDigest: input.plan.planDigest,
    approvalEnvelopeHash: input.plan.approval.envelopeHash,
    configurationDigest: canonicalSha256(input.plan.configuration ?? null), attempt, clientRequestId: plannedClientRequestId ?? randomUUID(),
    preparedAt: (input.clock?.() ?? input.now).toISOString()
  };
  await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', azurePorts(input).storage)
    .write(stageKey(key, 'prepared'), prepared);
  await input.lease!.assertHeld();
  return { key, prepared, submitted: null, settled: null };
}

export async function submitPrivateEffect(
  input: PhaseAdapterExecutionInput, checkpoint: PrivateEffectCheckpoint,
  response: { requestId: string; resourceId: string; status: number; operationUrl?: string }
): Promise<PrivateEffectCheckpoint> {
  const submitted: PrivateEffectSubmission = {
    schemaVersion: 1, kind: 'private-access-returned', preparedDigest: canonicalSha256(checkpoint.prepared),
    requestId: providerId(response.requestId, checkpoint.prepared.intent.provider),
    resourceId: response.resourceId, status: response.status, operationUrl: response.operationUrl ?? null,
    returnedAt: (input.clock?.() ?? input.now).toISOString()
  };
  await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', azurePorts(input).storage)
    .write(stageKey(checkpoint.key, 'returned'), submitted);
  return { ...checkpoint, submitted };
}

export async function settlePrivateEffect(
  input: PhaseAdapterExecutionInput, checkpoint: PrivateEffectCheckpoint,
  result: Pick<PrivateEffectSettlement, 'outcome' | 'readbackRequestId' | 'readbackDigest'>
): Promise<PrivateEffectCheckpoint> {
  const recoveredRun = !checkpoint.submitted && result.outcome === 'verified' &&
    checkpoint.prepared.intent.kind === 'runner-workflow-dispatch' ? await readPrivateRunBinding(input, checkpoint) : null;
  assert(result.outcome === 'not-dispatched' ? !checkpoint.submitted : checkpoint.submitted || recoveredRun,
    'Private access settlement must preserve the actual submission state.');
  if (result.readbackRequestId !== null) providerId(result.readbackRequestId, checkpoint.prepared.intent.provider);
  const settled: PrivateEffectSettlement = {
    schemaVersion: 1, kind: 'private-access-settled', preparedDigest: canonicalSha256(checkpoint.prepared),
    ...result, settledAt: (input.clock?.() ?? input.now).toISOString()
  };
  await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', azurePorts(input).storage)
    .write(stageKey(checkpoint.key, 'settled'), settled);
  return { ...checkpoint, settled };
}

export async function readPrivateRunBinding(
  input: PrivateEffectReadInput, checkpoint: PrivateEffectCheckpoint
): Promise<PrivateRunBinding | null> {
  const record = await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', azurePorts(input).storage)
    .read(stageKey(checkpoint.key, 'run-binding'));
  if (!record) return null;
  const value = exact(record.value, ['preparedDigest', 'runId', 'runAttempt', 'requestId']);
  assert(checkpoint.prepared.intent.kind === 'runner-workflow-dispatch' &&
    (!checkpoint.submitted || [200, 204].includes(checkpoint.submitted.status)) &&
    value.preparedDigest === canonicalSha256(checkpoint.prepared) &&
    Number.isSafeInteger(value.runId) && Number(value.runId) > 0 &&
    Number.isSafeInteger(value.runAttempt) && Number(value.runAttempt) > 0, 'Recorded private workflow run has no matching dispatch custody.');
  providerId(value.requestId, 'github');
  return value as unknown as PrivateRunBinding;
}

export async function bindPrivateRun(
  input: PhaseAdapterExecutionInput, checkpoint: PrivateEffectCheckpoint,
  binding: Omit<PrivateRunBinding, 'preparedDigest'>
): Promise<PrivateRunBinding> {
  assert(checkpoint.prepared.intent.kind === 'runner-workflow-dispatch' &&
    (!checkpoint.submitted || [200, 204].includes(checkpoint.submitted.status)) &&
    Number.isSafeInteger(binding.runId) && binding.runId > 0 && Number.isSafeInteger(binding.runAttempt) &&
    binding.runAttempt > 0, 'A real private workflow run must be bound to its exact pre-effect dispatch custody, never to a rejected request.');
  providerId(binding.requestId, 'github');
  const value = { preparedDigest: canonicalSha256(checkpoint.prepared), ...binding };
  await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', azurePorts(input).storage)
    .write(stageKey(checkpoint.key, 'run-binding'), value);
  return value;
}
