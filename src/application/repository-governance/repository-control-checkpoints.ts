import { lstat, realpath } from 'node:fs/promises';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../../domain/governance/activation/graph.js';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { GitHubActivationError, positiveId, text } from '../../adapters/github/activation-rest.js';
import {
  registeredOwnedRulesetNames,
  type OwnedRepositoryControl, type RepositoryControlChange, type RepositoryControlCheckpoint,
  type RepositoryControlJournal, type RepositoryControlPlan, type RepositoryControlPrepared,
  type RepositoryControlResponse
} from '../../adapters/github/production-rulesets.js';
import {
  controlObservationDigest, type RepositoryControlBinding, type RepositoryControlObservation, type RepositoryControlSnapshot
} from '../../adapters/github/repository-control-observation.js';
import { githubPorts } from '../../governance-activation/github-ports.js';
import type { PhaseAdapterExecutionInput, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import type { ExternalOperationState, TransitionOperation } from '../../domain/governance/activation/types.js';
import { assertRepositoryControlAuthority } from './repository-control-authority.js';

type ControlInput = PhasePlanningInput | PhaseAdapterExecutionInput;
interface PreparedRecord {
  schemaVersion: 1;
  kind: 'github-repository-control-prepared';
  projectRoot: string;
  projectIdentity: { device: string; inode: string; birthtime: string };
  activationIdentityDigest: string;
  binding: RepositoryControlBinding;
  sequence: number;
  name: string;
  change: RepositoryControlChange;
  controlPlanDigest: string;
  operationDigest: string;
  planDigest: string;
  approvalEnvelopeId: string;
  approvalEnvelopeHash: string;
  priorObservationDigest: string;
  priorEtag: string | null;
  mainSha: string;
  preparedAt: string;
}

interface ResponseRecord {
  schemaVersion: 1;
  kind: 'github-repository-control-response';
  preparedDigest: string;
  response: RepositoryControlResponse;
}

interface SettledRecord {
  schemaVersion: 1;
  kind: 'github-repository-control-settled';
  preparedDigest: string;
  result: NonNullable<RepositoryControlCheckpoint['settled']>;
}

function key(repositoryId: number, name: string, sequence: number, stage: string): string {
  return canonicalSha256({ kind: 'github-repository-control', repositoryId, name, sequence, stage });
}

function store(input: ControlInput) {
  return createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', githubPorts(input).storage);
}

function invalid(): never {
  throw new GitHubActivationError('control-checkpoint', 'A private repository-control checkpoint is malformed, copied or unbound. Preserve it; no retry or rollback is authorized.');
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) invalid();
  return value;
}

function responseResource(value: unknown): boolean {
  return value === null || isRecord(value) && Object.keys(value).length === 5 &&
    Number.isSafeInteger(value.id) && Number(value.id) > 0 &&
    ['nodeId', 'name', 'sourceType', 'source'].every((field) => typeof value[field] === 'string' && value[field] !== '');
}

async function projectIdentity(input: ControlInput) {
  const stat = await lstat(input.inspection.projectRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
  return {
    projectRoot: await realpath(input.inspection.projectRoot),
    projectIdentity: { device: String(stat.dev), inode: String(stat.ino), birthtime: String(stat.birthtimeMs) }
  };
}

async function history(input: ControlInput, repositoryId: number, name: string) {
  const identity = await projectIdentity(input);
  const records = store(input);
  let ownership: OwnedRepositoryControl | null = null;
  let latest: { prepared: PreparedRecord; response: ResponseRecord | null; settled: SettledRecord | null; ownership: OwnedRepositoryControl | null } | null = null;
  for (let sequence = 0; sequence < 32; sequence++) {
    const prepared = await records.read(key(repositoryId, name, sequence, 'prepared'));
    const response = await records.read(key(repositoryId, name, sequence, 'response'));
    const settled = await records.read(key(repositoryId, name, sequence, 'settled'));
    if (!prepared) {
      if (response || settled) invalid();
      return latest;
    }
    if (latest && !latest.settled) invalid();
    const p = prepared.value;
    if (!isRecord(p) || p.schemaVersion !== 1 || p.kind !== 'github-repository-control-prepared' ||
      Object.keys(p).length !== 18 ||
      p.projectRoot !== identity.projectRoot || prepared.projectRoot !== identity.projectRoot ||
      canonicalSha256(p.projectIdentity) !== canonicalSha256(identity.projectIdentity) ||
      p.activationIdentityDigest !== canonicalSha256(currentActivationIdentity) ||
      !isRecord(p.binding) || p.binding.repositoryId !== repositoryId || p.sequence !== sequence || p.name !== name ||
      !isRecord(p.change) || p.change.name !== name ||
      typeof p.preparedAt !== 'string' || !Number.isFinite(Date.parse(p.preparedAt)) ||
      typeof p.mainSha !== 'string' || !/^[a-f0-9]{40}$/u.test(p.mainSha) ||
      !(p.priorEtag === null || typeof p.priorEtag === 'string') ||
      typeof p.approvalEnvelopeId !== 'string' || !p.approvalEnvelopeId) invalid();
    for (const field of ['controlPlanDigest', 'operationDigest', 'planDigest', 'approvalEnvelopeHash', 'priorObservationDigest']) hash(p[field]);
    const preparedRecord = p as unknown as PreparedRecord;
    let responseRecord: ResponseRecord | null = null;
    if (response) {
      const r = response.value;
      if (!isRecord(r) || r.schemaVersion !== 1 || r.kind !== 'github-repository-control-response' ||
        Object.keys(r).length !== 4 || r.preparedDigest !== canonicalSha256(p) || !isRecord(r.response) ||
        ![4, 5].includes(Object.keys(r.response).length) ||
        Object.keys(r.response).some((field) => !['status', 'requestId', 'control', 'resource', 'repository'].includes(field)) ||
        !Number.isSafeInteger(r.response.status) ||
        Number(r.response.status) < 100 || Number(r.response.status) > 599 ||
        !(r.response.requestId === null || typeof r.response.requestId === 'string' && /^[A-Za-z0-9:-]{1,160}$/u.test(r.response.requestId)) ||
        !(r.response.control === null || isRecord(r.response.control) && isRecord(r.response.control.definition)) ||
        !responseResource(r.response.resource) ||
        r.response.repository !== undefined && (!isRecord(r.response.repository) ||
          Object.keys(r.response.repository).length !== 3 || !Number.isSafeInteger(r.response.repository.id) ||
          Number(r.response.repository.id) <= 0 || typeof r.response.repository.nodeId !== 'string' ||
          typeof r.response.repository.name !== 'string')) invalid();
      responseRecord = r as unknown as ResponseRecord;
    }
    let settledRecord: SettledRecord | null = null;
    if (settled) {
      const s = settled.value;
      if (!isRecord(s) || s.schemaVersion !== 1 || s.kind !== 'github-repository-control-settled' ||
        Object.keys(s).length !== 4 || s.preparedDigest !== canonicalSha256(p) || !isRecord(s.result) ||
        Object.keys(s.result).length !== 2 || !['verified', 'mismatched', 'rejected', 'not-dispatched'].includes(String(s.result.outcome)) ||
        (s.result.outcome === 'verified' || s.result.outcome === 'mismatched'
          ? !responseRecord || ![200, 201, 204].includes(responseRecord.response.status) || !isRecord(s.result.observation) :
          s.result.observation !== null) ||
        s.result.outcome === 'rejected' && (!responseRecord?.response.requestId ||
          ![400, 401, 403, 404, 409, 412, 422].includes(responseRecord.response.status)) ||
        s.result.outcome === 'not-dispatched' && responseRecord !== null) invalid();
      settledRecord = s as unknown as SettledRecord;
    }
    if (preparedRecord.change.kind === 'ruleset' &&
      (settledRecord?.result.outcome === 'verified' || settledRecord?.result.outcome === 'mismatched')) {
      const resource = responseRecord?.response.resource;
      if (!resource || resource.name !== name || resource.sourceType !== 'Repository' ||
        resource.source.toLowerCase() !== preparedRecord.binding.repository.toLowerCase()) invalid();
      if (preparedRecord.change.mode === 'create') {
        if (ownership) invalid();
        const observation = settledRecord.result.observation;
        const observedIdentity = observation && Array.isArray(observation.rulesets) && observation.rulesets.some((entry) =>
          entry.definition.id === resource.id && entry.definition.node_id === resource.nodeId &&
          entry.definition.name === resource.name && entry.definition.source_type === resource.sourceType &&
          entry.definition.source === resource.source);
        if (observedIdentity && canonicalSha256(observation.binding) === canonicalSha256(preparedRecord.binding)) {
          ownership = { id: resource.id, nodeId: resource.nodeId, name, ownershipDigest: canonicalSha256(preparedRecord) };
        } else if (settledRecord.result.outcome === 'verified') invalid();
      } else if (!ownership || ownership.id !== resource.id || ownership.nodeId !== resource.nodeId) invalid();
    }
    latest = { prepared: preparedRecord, response: responseRecord, settled: settledRecord, ownership };
  }
  throw new GitHubActivationError('control-checkpoint-limit', 'Thirty-two immutable control revisions exhaust this bounded recovery lane; no history can be replaced.');
}

function preparedView(record: PreparedRecord): RepositoryControlPrepared {
  return {
    sequence: record.sequence, digest: canonicalSha256(record), planDigest: record.planDigest,
    approvalEnvelopeId: record.approvalEnvelopeId, approvalEnvelopeHash: record.approvalEnvelopeHash,
    preparedAt: record.preparedAt
  };
}

export async function readRepositoryControlCheckpoint(
  input: ControlInput, repositoryId: number, name: string
): Promise<RepositoryControlCheckpoint | null> {
  const current = await history(input, repositoryId, name);
  return current ? {
    prepared: preparedView(current.prepared), changeDigest: canonicalSha256(current.prepared.change),
    response: current.response?.response ?? null, settled: current.settled?.result ?? null
  } : null;
}

export async function readPrivateOwnedRepositoryControls(
  input: ControlInput, binding: RepositoryControlBinding, mode: 'current' | 'known-recovery' = 'current'
): Promise<readonly OwnedRepositoryControl[]> {
  const result: OwnedRepositoryControl[] = [];
  for (const name of registeredOwnedRulesetNames) {
    const current = await history(input, binding.repositoryId, name);
    if (!current) continue;
    if (current.prepared.binding.repositoryNodeId !== binding.repositoryNodeId ||
      current.prepared.binding.repository !== binding.repository || current.prepared.binding.ownerId !== binding.ownerId) invalid();
    if (!current.settled || mode === 'current' && current.settled.result.outcome !== 'verified') {
      throw new GitHubActivationError('control-recovery-required', 'An interrupted private control revision requires its original reviewed recovery plan, not adoption by name or a fresh unrelated plan.');
    }
    if (current.ownership) result.push(current.ownership);
  }
  const settings = await history(input, binding.repositoryId, 'repository-settings');
  if (settings && (!settings.settled || mode === 'current' && settings.settled.result.outcome !== 'verified')) {
    throw new GitHubActivationError('control-recovery-required', 'An unsettled settings attempt requires its retained original recovery boundary; a new control plan cannot bypass it.');
  }
  return result;
}

export async function readRepositoryControlOwnership(
  input: ControlInput, binding: RepositoryControlBinding
): Promise<readonly OwnedRepositoryControl[]> {
  const result: OwnedRepositoryControl[] = [];
  for (const name of registeredOwnedRulesetNames) {
    const current = await history(input, binding.repositoryId, name);
    if (!current?.ownership) continue;
    if (current.prepared.binding.repositoryNodeId !== binding.repositoryNodeId ||
      current.prepared.binding.repository !== binding.repository || current.prepared.binding.ownerId !== binding.ownerId) invalid();
    result.push(current.ownership);
  }
  return result;
}

export async function unresolvedRepositoryControlPlan(
  input: ControlInput, repositoryId: number
): Promise<string | null> {
  const plans = new Set<string>();
  for (const name of [...registeredOwnedRulesetNames, 'repository-settings']) {
    const current = await history(input, repositoryId, name);
    if (current && !current.settled) plans.add(current.prepared.planDigest);
  }
  if (plans.size > 1) {
    throw new GitHubActivationError('control-recovery', 'Multiple unresolved control plans require explicit inspection; none may be guessed or silently superseded.');
  }
  return [...plans][0] ?? null;
}

export async function verifiedRepositoryControlProgress(
  input: ControlInput, plan: RepositoryControlPlan
): Promise<RepositoryControlSnapshot | null> {
  let observed = plan.baseline;
  let progressed = false;
  for (const change of plan.changes) {
    const current = await history(input, plan.baseline.binding.repositoryId, change.name);
    if (!current || current.prepared.controlPlanDigest !== canonicalSha256(plan)) continue;
    if (current.settled?.result.outcome !== 'verified' || !current.settled.result.observation) return null;
    observed = current.settled.result.observation;
    progressed = true;
  }
  return progressed ? observed : null;
}
export function repositoryControlChangeOperation(
  plan: RepositoryControlPlan, change: RepositoryControlChange, operations: readonly TransitionOperation[]
): TransitionOperation {
  const expected = { repository: plan.baseline.binding.repository, controlPlanDigest: canonicalSha256(plan), change };
  const found = operations.filter((entry) => entry.actionId === (change.kind === 'settings' ? 'github.repository.settings.apply' : 'github.ruleset.apply') &&
    canonicalSha256(entry.inputs) === canonicalSha256(expected));
  if (found.length !== 1) throw new GitHubActivationError('control-plan', 'An exact per-control operation is missing or duplicated in the reviewed plan.');
  return found[0]!;
}

export async function repositoryControlOperationState(
  input: PhaseAdapterExecutionInput, plan: RepositoryControlPlan
): Promise<ExternalOperationState | undefined> {
  for (const change of [...plan.changes].reverse()) {
    const current = await history(input, plan.baseline.binding.repositoryId, change.name);
    if (!current || current.prepared.controlPlanDigest !== canonicalSha256(plan) || !current.response?.response.requestId) continue;
    const response = current.response.response;
    if (change.kind === 'ruleset' && !response.resource) continue;
    return {
      provider: 'github', actionId: change.kind === 'settings' ? 'github.repository.settings.apply' : 'github.ruleset.apply',
      operationId: response.requestId!, resourceId: change.kind === 'settings' ? `/repos/${plan.baseline.binding.repository}` :
        `/repos/${plan.baseline.binding.repository}/rulesets/${response.resource!.id}`,
      startedAt: current.prepared.preparedAt, observedAt: (input.clock?.() ?? input.now).toISOString(),
      status: current.settled?.result.outcome === 'verified' ? 'completed' : 'failed',
      planDigest: current.prepared.planDigest
    };
  }
  return undefined;
}

export function createRepositoryControlJournal(
  input: PhaseAdapterExecutionInput, plan: RepositoryControlPlan,
  readbackOperation: TransitionOperation, completed: TransitionOperation[],
  revalidate: () => Promise<void>
): RepositoryControlJournal {
  const forChange = (change: RepositoryControlChange) => repositoryControlChangeOperation(plan, change, input.plan.operations);
  const authorize = async (change: RepositoryControlChange | null) => {
    await assertRepositoryControlAuthority(input, change ? forChange(change) : readbackOperation);
    await input.lease!.assertHeld();
  };
  return {
    authorize,
    revalidate,
    async read(change) {
      const checkpoint = await readRepositoryControlCheckpoint(input, plan.baseline.binding.repositoryId, change.name);
      if (!checkpoint) return null;
      const current = await history(input, plan.baseline.binding.repositoryId, change.name);
      // A completed older revision establishes ownership, not execution of this new plan.
      if (current?.prepared.controlPlanDigest !== canonicalSha256(plan) && checkpoint.settled &&
        (checkpoint.settled.outcome === 'verified' || input.recovery && input.plan.recovery &&
          current?.prepared.approvalEnvelopeHash !== input.plan.approval.envelopeHash)) return null;
      return checkpoint;
    },
    async prepare(change, observed) {
      await authorize(change);
      const prior = await history(input, plan.baseline.binding.repositoryId, change.name);
      if (prior && (!prior.settled || prior.settled.result.outcome !== 'verified' &&
        (!input.recovery || prior.prepared.approvalEnvelopeHash === input.plan.approval.envelopeHash))) {
        throw new GitHubActivationError('control-recovery-required', 'A previous attempt has no known settlement and separate recovery authority; it cannot be replaced.');
      }
      if (change.kind === 'ruleset' && change.mode === 'update') {
        const owned = plan.ownedControls.find((entry) => entry.name === change.name);
        if (!owned || !prior?.ownership || canonicalSha256(owned) !== canonicalSha256(prior.ownership) ||
          change.prior?.definition.id !== owned.id || change.prior.definition.node_id !== owned.nodeId) {
          throw new GitHubActivationError('control-ownership', 'An update requires its exact retained provider-issued ownership receipt, not an approved name or guessed ID.');
        }
      }
      const identity = await projectIdentity(input);
      const prepared: PreparedRecord = {
        schemaVersion: 1, kind: 'github-repository-control-prepared', ...identity,
        activationIdentityDigest: canonicalSha256(currentActivationIdentity), binding: plan.baseline.binding,
        sequence: prior ? prior.prepared.sequence + 1 : 0, name: change.name, change,
        controlPlanDigest: canonicalSha256(plan), operationDigest: canonicalSha256(forChange(change)),
        planDigest: input.plan.planDigest, approvalEnvelopeId: text(input.plan.approval.envelopeId, 'Enforcement approval ID'),
        approvalEnvelopeHash: hash(input.plan.approval.envelopeHash), priorObservationDigest: controlObservationDigest(observed),
        priorEtag: change.kind === 'settings' ? observed.settingsEtag : change.mode === 'create' ? observed.collectionEtag :
          observed.rulesets.find((entry) => entry.definition.id === change.prior?.definition.id)?.etag ?? null,
        mainSha: observed.mainSha, preparedAt: (input.clock?.() ?? input.now).toISOString()
      };
      await store(input).write(key(plan.baseline.binding.repositoryId, change.name, prepared.sequence, 'prepared'), prepared);
      await input.lease!.assertHeld();
      return preparedView(prepared);
    },
    async response(change, prepared, response) {
      await store(input).write(key(plan.baseline.binding.repositoryId, change.name, prepared.sequence, 'response'), {
        schemaVersion: 1, kind: 'github-repository-control-response', preparedDigest: prepared.digest, response
      } satisfies ResponseRecord);
    },
    async settle(change, prepared, result) {
      await store(input).write(key(plan.baseline.binding.repositoryId, change.name, prepared.sequence, 'settled'), {
        schemaVersion: 1, kind: 'github-repository-control-settled', preparedDigest: prepared.digest, result
      } satisfies SettledRecord);
    },
    completed(change) {
      const operation = forChange(change);
      if (!completed.some((entry) => canonicalSha256(entry) === canonicalSha256(operation))) completed.push(operation);
    }
  };
}
