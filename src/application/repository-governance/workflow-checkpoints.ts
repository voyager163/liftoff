import { lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../../domain/governance/activation/graph.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { GitHubActivationError } from '../../adapters/github/activation-rest.js';
import { githubPorts } from '../../governance-activation/github-ports.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import { assertGitHubPhaseAuthority } from './workflow-authority.js';

export type WorkflowEffectStep = 'tree' | 'commit' | 'ref' | 'pull-request' | 'dispatch';

export interface WorkflowEffectIdentity {
  repositoryId: number;
  ref: string;
  purpose: 'workflow-publication' | 'check-fixture' | 'workflow-dispatch';
  step: WorkflowEffectStep;
}

export interface WorkflowPreparedCheckpoint {
  schemaVersion: 1;
  kind: 'github-workflow-effect-prepared';
  projectRoot: string;
  projectIdentity: { device: string; inode: string; birthtime: string };
  activationIdentityDigest: string;
  intentDigest: string;
  operationDigest: string;
  payloadDigest: string;
  planDigest: string;
  approvalEnvelopeHash: string;
  attempt: number;
  correlationId: string;
  preparedAt: string;
}

export interface WorkflowProviderCheckpoint {
  schemaVersion: 1;
  kind: 'github-workflow-effect-response' | 'github-workflow-effect-observed';
  preparedDigest: string;
  status: number;
  requestId: string | null;
  providerId: string | null;
  resourceId: string | null;
  recordedAt: string;
}

export interface WorkflowEffectCheckpoints {
  prepared: WorkflowPreparedCheckpoint;
  response: WorkflowProviderCheckpoint | null;
  observed: WorkflowProviderCheckpoint | null;
}

function intent(operation: TransitionOperation, identity: WorkflowEffectIdentity): string {
  return canonicalSha256({ kind: 'github-workflow-effect', phaseId: operation.phaseId,
    actionId: operation.actionId, destination: operation.destination, identity });
}

function key(operation: TransitionOperation, identity: WorkflowEffectIdentity, attempt: number, stage: string): string {
  return canonicalSha256({ intentDigest: intent(operation, identity), attempt, stage });
}

function invalid(): never {
  throw new GitHubActivationError('workflow-checkpoint', 'The immutable private workflow checkpoint is malformed or belongs to another exact project, phase or effect. No redispatch is authorized.');
}

function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== names.length || names.some((name) => !Object.hasOwn(value, name))) invalid();
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) invalid();
  return value;
}

function date(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid();
  return value;
}

function identifier(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_=+/-]{1,200}$/u.test(value)) invalid();
  return value;
}

export async function readWorkflowEffect(
  input: Pick<PhaseAdapterExecutionInput, 'inspection'> & { adapters?: PhaseAdapterExecutionInput['adapters'] },
  operation: TransitionOperation, identity: WorkflowEffectIdentity, payload: unknown
): Promise<WorkflowEffectCheckpoints | null> {
  const store = createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', input.adapters?.githubActivation?.storage);
  const stat = await lstat(input.inspection.projectRoot);
  const root = await realpath(input.inspection.projectRoot);
  let latest: WorkflowEffectCheckpoints | null = null;
  for (let attempt = 0; attempt < 16; attempt++) {
    const [p, r, o] = await Promise.all(['prepared', 'response', 'observed'].map((stage) =>
      store.read(key(operation, identity, attempt, stage))));
    if (!p) {
      if (r || o) invalid();
      return latest;
    }
    if (latest && (!latest.response || ![401, 403, 404, 422].includes(latest.response.status) || latest.observed)) invalid();
    const prepared = fields(p.value, ['schemaVersion', 'kind', 'projectRoot', 'projectIdentity',
      'activationIdentityDigest', 'intentDigest', 'operationDigest', 'payloadDigest', 'planDigest',
      'approvalEnvelopeHash', 'attempt', 'correlationId', 'preparedAt']);
    const project = fields(prepared.projectIdentity, ['device', 'inode', 'birthtime']);
    if (prepared.schemaVersion !== 1 || prepared.kind !== 'github-workflow-effect-prepared' ||
      p.projectRoot !== root || prepared.projectRoot !== root || !stat.isDirectory() || stat.isSymbolicLink() ||
      project.device !== String(stat.dev) || project.inode !== String(stat.ino) || project.birthtime !== String(stat.birthtimeMs) ||
      prepared.activationIdentityDigest !== canonicalSha256(currentActivationIdentity) ||
      prepared.intentDigest !== intent(operation, identity) || prepared.operationDigest !== canonicalSha256(operation) ||
      prepared.payloadDigest !== canonicalSha256(payload) || prepared.attempt !== attempt ||
      typeof prepared.correlationId !== 'string' || !/^[a-f0-9-]{36}$/u.test(prepared.correlationId)) invalid();
    hash(prepared.planDigest); hash(prepared.approvalEnvelopeHash); date(prepared.preparedAt);
    const typed = prepared as unknown as WorkflowPreparedCheckpoint;
    const decode = (value: unknown, kind: WorkflowProviderCheckpoint['kind']): WorkflowProviderCheckpoint => {
      const record = fields(value, ['schemaVersion', 'kind', 'preparedDigest', 'status', 'requestId', 'providerId', 'resourceId', 'recordedAt']);
      if (record.schemaVersion !== 1 || record.kind !== kind || record.preparedDigest !== canonicalSha256(typed) ||
        !Number.isSafeInteger(record.status) || Number(record.status) < 100 || Number(record.status) > 599 ||
        Date.parse(date(record.recordedAt)) < Date.parse(typed.preparedAt)) invalid();
      identifier(record.requestId); identifier(record.providerId);
      if (record.resourceId !== null && (typeof record.resourceId !== 'string' ||
        !record.resourceId.startsWith(`/repos/${operation.destination.repository}/`) ||
        /[\s?#\\]/u.test(record.resourceId))) invalid();
      if (kind === 'github-workflow-effect-observed' &&
        (record.status !== 200 || !record.providerId || !record.resourceId)) invalid();
      return record as unknown as WorkflowProviderCheckpoint;
    };
    latest = { prepared: typed, response: r ? decode(r.value, 'github-workflow-effect-response') : null,
      observed: o ? decode(o.value, 'github-workflow-effect-observed') : null };
    if (latest.response?.providerId && latest.observed?.providerId &&
      latest.response.providerId !== latest.observed.providerId) invalid();
  }
  return latest;
}

export async function prepareWorkflowEffect(
  input: PhaseAdapterExecutionInput, operation: TransitionOperation, identity: WorkflowEffectIdentity, payload: unknown
): Promise<WorkflowPreparedCheckpoint> {
  await assertGitHubPhaseAuthority(input, operation);
  const previous = await readWorkflowEffect(input, operation, identity, payload);
  if (previous && (!input.recovery || !input.plan.recovery || previous.observed ||
    !previous.response || ![401, 403, 404, 422].includes(previous.response.status) ||
    previous.prepared.approvalEnvelopeHash === input.plan.approval.envelopeHash)) {
    throw new GitHubActivationError('workflow-recovery-required', 'An existing workflow request cannot be repeated without a known rejection and a fresh separately issued recovery approval.');
  }
  if (previous && previous.prepared.attempt >= 15) {
    throw new GitHubActivationError('workflow-checkpoint-limit', 'The sixteen retained workflow attempts exhaust the bounded recovery contract.');
  }
  const stat = await lstat(input.inspection.projectRoot);
  const root = await realpath(input.inspection.projectRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
  const prepared: WorkflowPreparedCheckpoint = {
    schemaVersion: 1, kind: 'github-workflow-effect-prepared', projectRoot: root,
    projectIdentity: { device: String(stat.dev), inode: String(stat.ino), birthtime: String(stat.birthtimeMs) },
    activationIdentityDigest: canonicalSha256(currentActivationIdentity), intentDigest: intent(operation, identity),
    operationDigest: canonicalSha256(operation), payloadDigest: canonicalSha256(payload), planDigest: input.plan.planDigest,
    approvalEnvelopeHash: hash(input.plan.approval.envelopeHash), attempt: previous ? previous.prepared.attempt + 1 : 0,
    correlationId: randomUUID(), preparedAt: (input.clock?.() ?? input.now).toISOString()
  };
  await createScopedUserLocalRecordStore(root, 'governance-operation', githubPorts(input).storage)
    .write(key(operation, identity, prepared.attempt, 'prepared'), prepared);
  await input.lease!.assertHeld();
  return prepared;
}

export async function recordWorkflowProviderResult(
  input: PhaseAdapterExecutionInput, operation: TransitionOperation, identity: WorkflowEffectIdentity,
  prepared: WorkflowPreparedCheckpoint, stage: 'response' | 'observed',
  result: Pick<WorkflowProviderCheckpoint, 'status' | 'requestId' | 'providerId' | 'resourceId'>
): Promise<void> {
  identifier(result.requestId); identifier(result.providerId);
  const value: WorkflowProviderCheckpoint = {
    schemaVersion: 1, kind: stage === 'response' ? 'github-workflow-effect-response' : 'github-workflow-effect-observed',
    preparedDigest: canonicalSha256(prepared), ...result, recordedAt: (input.clock?.() ?? input.now).toISOString()
  };
  await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', githubPorts(input).storage)
    .write(key(operation, identity, prepared.attempt, stage), value);
}
