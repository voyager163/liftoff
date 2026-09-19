import { lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../../domain/governance/activation/graph.js';
import { runnerPreflightSecretName, type TransitionOperation } from '../../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import { createScopedUserLocalRecordStore, type UpdatePreviewOptions } from '../filesystem/update-previews.js';
import { GitHubActivationError, githubRepository, positiveId } from '../github/activation-rest.js';
import { assertCredentialAuthority } from './credential-authority.js';

export interface CredentialCheckpointTarget {
  repository: string;
  repositoryId: number;
  secretName: typeof runnerPreflightSecretName;
}

export interface CredentialPreparedCheckpoint {
  schemaVersion: 1;
  kind: 'github-credential-prepared';
  projectRoot: string;
  projectIdentity: { device: string; inode: string; birthtime: string };
  activationIdentityDigest: string;
  target: CredentialCheckpointTarget;
  operationDigest: string;
  planDigest: string;
  approvalEnvelopeHash: string;
  attempt: number;
  correlationId: string;
  preparedAt: string;
}

export interface CredentialSettledCheckpoint {
  schemaVersion: 1;
  kind: 'github-credential-settled';
  preparedDigest: string;
  outcome: 'enrolled' | 'rejected' | 'not-dispatched';
  providerRequestId: string | null;
  /** GitHub Actions secrets are not versioned. Never substitute a timestamp or client UUID. */
  providerVersion: string | null;
  status: number | null;
  observedAt: string;
}

export interface CredentialResponseCheckpoint {
  schemaVersion: 1;
  kind: 'github-credential-response';
  preparedDigest: string;
  providerRequestId: string;
  providerVersion: null;
  status: number;
  observedAt: string;
}

export interface CredentialCheckpoints {
  prepared: CredentialPreparedCheckpoint;
  submitted: CredentialResponseCheckpoint | null;
  settled: CredentialSettledCheckpoint | null;
}

function invalid(): never {
  throw new GitHubActivationError('credential-checkpoint', 'Private credential checkpoint identity or settlement is invalid; preserve it and do not repeat enrollment.');
}

function targetIdentity(target: CredentialCheckpointTarget): CredentialCheckpointTarget {
  if (target.secretName !== runnerPreflightSecretName) invalid();
  return { repository: githubRepository(target.repository), repositoryId: positiveId(target.repositoryId), secretName: runnerPreflightSecretName };
}

function key(target: CredentialCheckpointTarget, attempt: number, stage: string): string {
  const validated = targetIdentity(target);
  return canonicalSha256({ kind: 'github-credential-enrollment', repositoryId: validated.repositoryId, secretName: validated.secretName, attempt, stage });
}

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) invalid();
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) invalid();
  return value;
}

function time(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}

export function githubProviderRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{2,127}$/u.test(value) ||
    /(?:github_pat_|gh[pousr]_)/u.test(value)) invalid();
  return value;
}

async function projectIdentity(projectRoot: string) {
  const stat = await lstat(projectRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
  return {
    projectRoot: await realpath(projectRoot),
    projectIdentity: { device: String(stat.dev), inode: String(stat.ino), birthtime: String(stat.birthtimeMs) }
  };
}

export async function readCredentialCheckpoints(
  input: PhaseAdapterExecutionInput, target: CredentialCheckpointTarget, storage?: UpdatePreviewOptions
): Promise<CredentialCheckpoints | null> {
  storage ??= input.adapters.githubActivation?.storage;
  const store = createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', storage);
  const identity = await projectIdentity(input.inspection.projectRoot);
  let latest: CredentialCheckpoints | null = null;
  for (let attempt = 0; attempt < 16; attempt++) {
    const prior = await store.read(key(target, attempt, 'prepared'));
    const response = await store.read(key(target, attempt, 'submitted'));
    const settlement = await store.read(key(target, attempt, 'settled'));
    if (!prior) {
      if (response || settlement) invalid();
      return latest;
    }
    if (latest && (!latest.settled || latest.settled.outcome === 'enrolled')) invalid();
    const p = exact(prior.value, [
      'schemaVersion', 'kind', 'projectRoot', 'projectIdentity', 'activationIdentityDigest', 'target', 'operationDigest',
      'planDigest', 'approvalEnvelopeHash', 'attempt', 'correlationId', 'preparedAt'
    ]);
    if (p.schemaVersion !== 1 || p.kind !== 'github-credential-prepared' || p.projectRoot !== identity.projectRoot ||
      prior.projectRoot !== identity.projectRoot || canonicalSha256(p.projectIdentity) !== canonicalSha256(identity.projectIdentity) ||
      p.activationIdentityDigest !== canonicalSha256(currentActivationIdentity) || p.attempt !== attempt ||
      canonicalSha256(p.target) !== canonicalSha256(targetIdentity(target)) ||
      typeof p.correlationId !== 'string' || !/^[a-f0-9-]{36}$/u.test(p.correlationId)) invalid();
    const prepared: CredentialPreparedCheckpoint = {
      schemaVersion: 1, kind: 'github-credential-prepared', ...identity,
      activationIdentityDigest: canonicalSha256(currentActivationIdentity), target: targetIdentity(target),
      operationDigest: hash(p.operationDigest), planDigest: hash(p.planDigest), approvalEnvelopeHash: hash(p.approvalEnvelopeHash),
      attempt, correlationId: p.correlationId, preparedAt: time(p.preparedAt)
    };
    let submitted: CredentialResponseCheckpoint | null = null;
    if (response) {
      const s = exact(response.value, ['schemaVersion', 'kind', 'preparedDigest', 'providerRequestId', 'providerVersion', 'status', 'observedAt']);
      if (s.schemaVersion !== 1 || s.kind !== 'github-credential-response' || s.preparedDigest !== canonicalSha256(prepared) ||
        s.providerVersion !== null || !Number.isSafeInteger(s.status) || Number(s.status) < 100 || Number(s.status) > 599 ||
        s.providerRequestId === prepared.correlationId || Date.parse(time(s.observedAt)) < Date.parse(prepared.preparedAt)) invalid();
      submitted = {
        schemaVersion: 1, kind: 'github-credential-response', preparedDigest: canonicalSha256(prepared),
        providerRequestId: githubProviderRequestId(s.providerRequestId), providerVersion: null,
        status: s.status as number, observedAt: time(s.observedAt)
      };
    }
    let settled: CredentialSettledCheckpoint | null = null;
    if (settlement) {
      const s = exact(settlement.value, [
        'schemaVersion', 'kind', 'preparedDigest', 'outcome', 'providerRequestId', 'providerVersion', 'status', 'observedAt'
      ]);
      if (s.schemaVersion !== 1 || s.kind !== 'github-credential-settled' || s.preparedDigest !== canonicalSha256(prepared) ||
        !['enrolled', 'rejected', 'not-dispatched'].includes(String(s.outcome)) ||
        s.providerVersion !== null || Date.parse(time(s.observedAt)) < Date.parse(prepared.preparedAt)) invalid();
      if (s.outcome === 'not-dispatched') {
        if (s.providerRequestId !== null || s.status !== null || submitted !== null) invalid();
      } else {
        githubProviderRequestId(s.providerRequestId);
        if (typeof s.status !== 'number' || !(s.outcome === 'enrolled' ? [201] : [401, 403, 404, 422]).includes(s.status) ||
          !submitted || submitted.providerRequestId !== s.providerRequestId || submitted.status !== s.status) invalid();
      }
      settled = {
        schemaVersion: 1, kind: 'github-credential-settled', preparedDigest: canonicalSha256(prepared),
        outcome: s.outcome as CredentialSettledCheckpoint['outcome'],
        providerRequestId: s.providerRequestId as string | null, providerVersion: null,
        status: s.status as number | null, observedAt: time(s.observedAt)
      };
    }
    latest = { prepared, submitted, settled };
  }
  return latest;
}

export async function recordCredentialEnrollmentResponse(
  input: PhaseAdapterExecutionInput, prepared: CredentialPreparedCheckpoint,
  response: { providerRequestId: string; status: number }, storage?: UpdatePreviewOptions
): Promise<CredentialResponseCheckpoint> {
  storage ??= input.adapters.githubActivation?.storage;
  const current = await readCredentialCheckpoints(input, prepared.target, storage);
  if (!current || canonicalSha256(current.prepared) !== canonicalSha256(prepared) ||
    response.providerRequestId === prepared.correlationId || !Number.isSafeInteger(response.status) ||
    response.status < 100 || response.status > 599) invalid();
  githubProviderRequestId(response.providerRequestId);
  if (current.submitted) {
    if (current.submitted.providerRequestId !== response.providerRequestId || current.submitted.status !== response.status) invalid();
    return current.submitted;
  }
  if (current.settled) invalid();
  const submitted: CredentialResponseCheckpoint = {
    schemaVersion: 1, kind: 'github-credential-response', preparedDigest: canonicalSha256(prepared),
    providerRequestId: response.providerRequestId, providerVersion: null, status: response.status,
    observedAt: (input.clock?.() ?? input.now).toISOString()
  };
  await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', storage)
    .write(key(prepared.target, prepared.attempt, 'submitted'), submitted);
  return submitted;
}

export async function prepareCredentialEnrollment(
  input: PhaseAdapterExecutionInput, operation: TransitionOperation, target: CredentialCheckpointTarget, storage?: UpdatePreviewOptions
): Promise<CredentialPreparedCheckpoint> {
  storage ??= input.adapters.githubActivation?.storage;
  await assertCredentialAuthority(input, operation, storage);
  if (operation.actionId !== 'github.credential.enroll-masked' || operation.mutationClass !== 'github-secret-write' ||
    operation.destination.repository !== target.repository) invalid();
  const previous = await readCredentialCheckpoints(input, target, storage);
  if (previous && previous.prepared.attempt >= 15) {
    throw new GitHubActivationError('credential-attempt-limit', 'Sixteen retained enrollment attempts exhaust the bounded recovery scope; prior outcomes remain readable.');
  }
  if (previous && (!previous.settled || previous.settled.outcome === 'enrolled' || !input.recovery || !input.plan.recovery ||
    previous.prepared.approvalEnvelopeHash === input.plan.approval.envelopeHash)) {
    throw new GitHubActivationError('credential-recovery-required', 'Prior enrollment is successful or uncertain, or needs a fresh separately approved recovery. Do not overwrite or retry it.');
  }
  const prepared: CredentialPreparedCheckpoint = {
    schemaVersion: 1, kind: 'github-credential-prepared', ...await projectIdentity(input.inspection.projectRoot),
    activationIdentityDigest: canonicalSha256(currentActivationIdentity), target: targetIdentity(target),
    operationDigest: canonicalSha256(operation), planDigest: input.plan.planDigest,
    approvalEnvelopeHash: hash(input.plan.approval.envelopeHash), attempt: previous ? previous.prepared.attempt + 1 : 0,
    correlationId: randomUUID(), preparedAt: (input.clock?.() ?? input.now).toISOString()
  };
  await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', storage)
    .write(key(target, prepared.attempt, 'prepared'), prepared);
  await input.lease!.assertHeld();
  return prepared;
}

export async function settleCredentialEnrollment(
  input: PhaseAdapterExecutionInput, prepared: CredentialPreparedCheckpoint,
  result: Pick<CredentialSettledCheckpoint, 'outcome' | 'providerRequestId' | 'status'>, storage?: UpdatePreviewOptions
): Promise<CredentialSettledCheckpoint> {
  storage ??= input.adapters.githubActivation?.storage;
  const current = await readCredentialCheckpoints(input, prepared.target, storage);
  if (!current || canonicalSha256(current.prepared) !== canonicalSha256(prepared)) invalid();
  if (current.settled) {
    if (current.settled.outcome !== result.outcome || current.settled.providerRequestId !== result.providerRequestId ||
      current.settled.status !== result.status) invalid();
    return current.settled;
  }
  const settled: CredentialSettledCheckpoint = {
    schemaVersion: 1, kind: 'github-credential-settled', preparedDigest: canonicalSha256(prepared),
    ...result, providerVersion: null, observedAt: (input.clock?.() ?? input.now).toISOString()
  };
  if (result.outcome === 'not-dispatched' ? result.providerRequestId !== null || result.status !== null :
    !result.providerRequestId || !(result.outcome === 'enrolled' ? [201] : [401, 403, 404, 422]).includes(result.status!)) invalid();
  if (result.providerRequestId) githubProviderRequestId(result.providerRequestId);
  if (result.outcome !== 'not-dispatched') {
    await recordCredentialEnrollmentResponse(input, prepared, {
      providerRequestId: result.providerRequestId!, status: result.status!
    }, storage);
  } else if (current.submitted) invalid();
  await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', storage)
    .write(key(prepared.target, prepared.attempt, 'settled'), settled);
  return settled;
}
