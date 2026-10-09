import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { types } from 'node:util';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { validateRepairExecutionIdentity } from '../../domain/repair/identity.js';
import { liftoffVersion } from '../../version.js';
import {
  RepairWorkspaceError, repairWorkspaceRoleNames,
  type AdoptionVerificationWorkspaceIdentity, type CreateVerificationWorkspaceOptions,
  type RepairWorkspaceActivity, type RepairWorkspaceFileIdentity,
  type VerificationWorkspaceRecord
} from './workspaces-types.js';

export const repairWorkspaceIndexKey = canonicalSha256('liftoff-repair-workspace-index-v1');
export const repairWorkspaceAuthorityKey = canonicalSha256('liftoff-repair-workspace-authority-v1');
export const maximumRepairWorkspaces = 256;

export interface RepairWorkspaceIndex {
  schemaVersion: 1;
  kind: 'liftoff-repair-workspace-index';
  projectRoot: string;
  revision: number;
  workspaces: string[];
}

export function workspaceRecordKey(workspaceId: string): string {
  workspaceDigest(workspaceId);
  return canonicalSha256({ kind: 'liftoff-repair-workspace-record', workspaceId });
}

export function workspaceDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new RepairWorkspaceError('invalid-request', 'Workspace bindings require complete lowercase SHA-256 digests.');
  }
}

function ownData(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string')) return null;
  const captured: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    captured[key] = descriptor.value;
  }
  return captured;
}

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const captured = ownData(value);
  if (captured === null || Object.keys(captured).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(captured, field))) {
    throw new RepairWorkspaceError('registry-invalid', 'Workspace metadata has missing or unsupported fields.');
  }
  return captured;
}

function ownDataArray(value: unknown, maximum: number): unknown[] {
  if (typeof value !== 'object' || value === null || types.isProxy(value) ||
      !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximum) {
    throw new RepairWorkspaceError('limits-exceeded', 'Workspace metadata has an invalid bounded inventory.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string') ||
      keys.length !== value.length + 1 ||
      !Object.hasOwn(descriptors, 'length')) {
    throw new RepairWorkspaceError('registry-invalid', 'Workspace metadata inventory must be dense own data.');
  }
  const captured: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new RepairWorkspaceError('registry-invalid', 'Workspace metadata inventory must be dense own data.');
    }
    captured.push(descriptor.value);
  }
  return captured;
}

function integer(value: unknown, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > 1_000_000) {
    throw new RepairWorkspaceError('registry-invalid', 'Workspace metadata has an invalid bounded counter.');
  }
}

function timestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new RepairWorkspaceError('registry-invalid', 'Workspace metadata has an invalid timestamp.');
  }
}

function nativePath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RepairWorkspaceError('unsafe-path', 'Workspace metadata requires a canonical native absolute path.');
  }
}

export function validateWorkspaceFileIdentity(value: unknown): RepairWorkspaceFileIdentity {
  const identity = exact(value, ['device', 'inode', 'birthtime']);
  for (const field of Object.values(identity)) {
    if (typeof field !== 'string' || !/^\d+$/u.test(field)) {
      throw new RepairWorkspaceError('registry-invalid', 'Workspace creation identity is invalid.');
    }
  }
  return identity as unknown as RepairWorkspaceFileIdentity;
}

export function sameWorkspaceFileIdentity(left: RepairWorkspaceFileIdentity, right: RepairWorkspaceFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.birthtime === right.birthtime;
}

function validateAdoptionIdentity(value: unknown): AdoptionVerificationWorkspaceIdentity {
  const identity = exact(value, [
    'schemaVersion', 'kind', 'cliVersion', 'adoptionVerificationContractVersion'
  ]);
  if (identity.schemaVersion !== 1 ||
      identity.kind !== 'liftoff-adoption-verification-execution' ||
      identity.cliVersion !== liftoffVersion ||
      identity.adoptionVerificationContractVersion !== 1) {
    throw new RepairWorkspaceError(
      'unsupported-record',
      'Workspace adoption-verification identity is not supported by this CLI.'
    );
  }
  return structuredClone(identity) as unknown as AdoptionVerificationWorkspaceIdentity;
}

export function validateWorkspaceRequest(value: unknown): CreateVerificationWorkspaceOptions {
  const captured = ownData(value);
  if (captured === null) {
    throw new RepairWorkspaceError('registry-invalid', 'Workspace metadata has missing or unsupported fields.');
  }
  const adoption = Object.hasOwn(captured, 'adoptionIdentity');
  const request = exact(captured, [
    'planFingerprint', adoption ? 'adoptionIdentity' : 'repairIdentity',
    'patchStagingRoot', 'bindings', 'approvedScopes'
  ]);
  workspaceDigest(request.planFingerprint);
  nativePath(request.patchStagingRoot);
  if (adoption) {
    validateAdoptionIdentity(request.adoptionIdentity);
  } else {
    let identity;
    try { identity = validateRepairExecutionIdentity(request.repairIdentity); }
    catch {
      throw new RepairWorkspaceError('unsupported-record', 'Workspace repair identity is not supported by this CLI.');
    }
    if (identity.cliVersion !== liftoffVersion) {
      throw new RepairWorkspaceError('unsupported-record', 'Workspace CLI identity is not supported by this implementation.');
    }
  }
  const bindings = exact(request.bindings, ['inputDigest', 'verificationPolicyDigest', 'providerDigest', 'toolchainDigest']);
  for (const digest of Object.values(bindings)) workspaceDigest(digest);
  const scopes = exact(request.approvedScopes, ['projectCode', 'dependencyPreparation', 'network', 'lifecycle']);
  if (Object.values(scopes).some((value) => typeof value !== 'boolean') || scopes.projectCode !== true) {
    throw new RepairWorkspaceError('permission-denied', 'Private verification requires explicit project-code scope and separate declared effect permissions.');
  }
  return structuredClone(request) as unknown as CreateVerificationWorkspaceOptions;
}

export function validateWorkspaceActivity(value: unknown, record: VerificationWorkspaceRecord): RepairWorkspaceActivity {
  const activity = exact(value, ['kind', 'commandDigest', 'network', 'lifecycle']);
  workspaceDigest(activity.commandDigest);
  if (!['preparation', 'verification'].includes(String(activity.kind)) ||
    typeof activity.network !== 'boolean' || typeof activity.lifecycle !== 'boolean') {
    throw new RepairWorkspaceError('invalid-request', 'Workspace activity must identify one exact supported command and its effects.');
  }
  if (activity.kind === 'preparation' && !record.approvedScopes.dependencyPreparation ||
    activity.network && !record.approvedScopes.network ||
    activity.lifecycle && !record.approvedScopes.lifecycle) {
    throw new RepairWorkspaceError('permission-denied', 'Workspace activity exceeds its separately approved effect scopes.');
  }
  return activity as unknown as RepairWorkspaceActivity;
}

export function validateWorkspaceIndex(value: unknown, projectRoot: string): RepairWorkspaceIndex {
  const index = exact(value, ['schemaVersion', 'kind', 'projectRoot', 'revision', 'workspaces']);
  if (index.schemaVersion !== 1 || index.kind !== 'liftoff-repair-workspace-index') {
    throw new RepairWorkspaceError('unsupported-record', 'Private workspace index schema is unsupported; preserve it for a compatible CLI.');
  }
  if (index.projectRoot !== projectRoot) {
    throw new RepairWorkspaceError('scope-mismatch', 'Private workspace index belongs to another project.');
  }
  integer(index.revision, 1);
  const workspaces = ownDataArray(index.workspaces, maximumRepairWorkspaces);
  for (const id of workspaces) workspaceDigest(id);
  if (new Set(workspaces).size !== workspaces.length) {
    throw new RepairWorkspaceError('registry-invalid', 'Private workspace index contains duplicate identities.');
  }
  return structuredClone({ ...index, workspaces }) as unknown as RepairWorkspaceIndex;
}

export function validateWorkspaceRecord(
  value: unknown,
  expected: { projectRoot: string; directory: (workspaceId: string) => string }
): VerificationWorkspaceRecord {
  const captured = ownData(value);
  if (captured === null) {
    throw new RepairWorkspaceError('registry-invalid', 'Workspace metadata has missing or unsupported fields.');
  }
  const adoption = captured.kind === 'liftoff-adoption-verification-workspace';
  const record = exact(captured, [
    'schemaVersion', 'kind', 'workspaceId', 'revision', 'projectRoot', 'projectIdentity',
    'patchStagingRoot', 'patchStagingIdentity', 'planFingerprint',
    adoption ? 'adoptionIdentity' : 'repairIdentity',
    'bindings', 'approvedScopes', 'directory', 'creationIdentity', 'roles', 'owner',
    'phase', 'lastCheckpoint', 'activities', 'cleanup', 'createdAt', 'updatedAt'
  ]);
  if (record.schemaVersion !== 1 ||
      !['liftoff-repair-workspace', 'liftoff-adoption-verification-workspace']
        .includes(String(record.kind))) {
    throw new RepairWorkspaceError('unsupported-record', 'Private workspace record schema is unsupported; no cleanup was authorized.');
  }
  workspaceDigest(record.workspaceId);
  integer(record.revision, 1);
  validateWorkspaceRequest(adoption ? {
    planFingerprint: record.planFingerprint,
    adoptionIdentity: record.adoptionIdentity,
    patchStagingRoot: record.patchStagingRoot,
    bindings: record.bindings,
    approvedScopes: record.approvedScopes
  } : {
    planFingerprint: record.planFingerprint,
    repairIdentity: record.repairIdentity,
    patchStagingRoot: record.patchStagingRoot,
    bindings: record.bindings,
    approvedScopes: record.approvedScopes
  });
  if (record.projectRoot !== expected.projectRoot || record.directory !== expected.directory(record.workspaceId)) {
    throw new RepairWorkspaceError('scope-mismatch', 'Private workspace location is not the exact registered project-bound location.');
  }
  validateWorkspaceFileIdentity(record.projectIdentity);
  validateWorkspaceFileIdentity(record.patchStagingIdentity);
  nativePath(record.directory);
  const phases = ['allocating', 'ready', 'copying', 'preparing', 'verifying', 'verified', 'failed', 'cleaning', 'cleanup-failed', 'cleaned'];
  if (typeof record.phase !== 'string' || !phases.includes(record.phase)) {
    throw new RepairWorkspaceError('unsupported-record', 'Private workspace phase is unsupported.');
  }
  if (typeof record.lastCheckpoint !== 'string' ||
    !['allocating', 'ready', 'copying', 'preparing', 'verifying', 'verified', 'failed'].includes(record.lastCheckpoint)) {
    throw new RepairWorkspaceError('unsupported-record', 'Private workspace checkpoint is unsupported.');
  }
  const incompleteCreation = !['ready', 'copying', 'preparing', 'verifying', 'verified'].includes(record.phase);
  if (record.creationIdentity === null) {
    if (!incompleteCreation) throw new RepairWorkspaceError('registry-invalid', 'Workspace creation identity is missing.');
  } else validateWorkspaceFileIdentity(record.creationIdentity);
  const roles = exact(record.roles, repairWorkspaceRoleNames);
  for (const role of repairWorkspaceRoleNames) {
    const entry = exact(roles[role], ['path', 'identity']);
    if (entry.path !== path.join(record.directory, role)) {
      throw new RepairWorkspaceError('scope-mismatch', 'Workspace role is not an exact fixed disposable location.');
    }
    if (entry.identity === null) {
      if (!incompleteCreation) throw new RepairWorkspaceError('registry-invalid', 'A workspace role lacks its creation identity.');
    } else validateWorkspaceFileIdentity(entry.identity);
  }
  const owner = exact(record.owner, ['tokenDigest', 'processId', 'state', 'release']);
  workspaceDigest(owner.tokenDigest);
  if (!Number.isSafeInteger(owner.processId) || (owner.processId as number) <= 0) {
    throw new RepairWorkspaceError('registry-invalid', 'Workspace owner diagnostic PID is invalid.');
  }
  if (!['active', 'released', 'uncertain'].includes(String(owner.state))) {
    throw new RepairWorkspaceError('unsupported-record', 'Workspace owner state is unsupported.');
  }
  const activities = exact(record.activities, ['started', 'settled', 'uncertain', 'inFlight']);
  for (const value of [activities.started, activities.settled, activities.uncertain]) integer(value);
  const inFlight = ownDataArray(activities.inFlight, 32);
  const ids = new Set<string>();
  for (const value of inFlight) {
    const activity = exact(value, ['id', 'kind', 'commandDigest', 'network', 'lifecycle']);
    workspaceDigest(activity.id);
    if (ids.has(activity.id)) throw new RepairWorkspaceError('registry-invalid', 'Duplicate workspace activity identity.');
    ids.add(activity.id);
    const { id: _id, ...request } = activity;
    validateWorkspaceActivity(request, record as unknown as VerificationWorkspaceRecord);
  }
  if ((activities.settled as number) + (activities.uncertain as number) + inFlight.length !== activities.started) {
    throw new RepairWorkspaceError('registry-invalid', 'Workspace activity counts do not match their registered inventory.');
  }
  if (owner.state === 'released') {
    const release = exact(owner.release, ['releasedAt', 'allKnownCommandsSettled']);
    timestamp(release.releasedAt);
    if (release.allKnownCommandsSettled !== true || inFlight.length || activities.uncertain !== 0) {
      throw new RepairWorkspaceError('owner-uncertain', 'Workspace release does not prove all known commands settled.');
    }
  } else if (owner.release !== null) {
    throw new RepairWorkspaceError('registry-invalid', 'An unreleased workspace cannot contain a release proof.');
  }
  const cleanup = exact(record.cleanup, ['removedEntries', 'complete']);
  integer(cleanup.removedEntries);
  if (typeof cleanup.complete !== 'boolean' || cleanup.complete !== (record.phase === 'cleaned') ||
    cleanup.complete && owner.state !== 'released') {
    throw new RepairWorkspaceError('registry-invalid', 'Workspace cleanup status is inconsistent with its authority.');
  }
  timestamp(record.createdAt);
  timestamp(record.updatedAt);
  if (record.updatedAt < record.createdAt) throw new RepairWorkspaceError('registry-invalid', 'Workspace progress predates its creation.');
  return structuredClone(record) as unknown as VerificationWorkspaceRecord;
}

export function workspaceSeal(payload: unknown, key: string): unknown {
  workspaceDigest(key);
  return {
    schemaVersion: 1,
    kind: 'liftoff-repair-workspace-seal',
    payload,
    mac: createHmac('sha256', Buffer.from(key, 'hex')).update(canonicalJson(payload)).digest('hex')
  };
}

export function adoptionWorkspaceResultSeal(
  payload: unknown, key: string, workspaceId: string, planFingerprint: string
): unknown {
  workspaceDigest(key);
  workspaceDigest(workspaceId);
  workspaceDigest(planFingerprint);
  const authenticated = { workspaceId, planFingerprint, payload };
  return {
    schemaVersion: 1,
    kind: 'liftoff-adoption-verification-result-seal',
    ...authenticated,
    mac: createHmac('sha256', Buffer.from(key, 'hex'))
      .update(canonicalJson(authenticated)).digest('hex')
  };
}

export function openAdoptionWorkspaceResultSeal(
  value: unknown, key: string, workspaceId: string, planFingerprint: string
): unknown {
  workspaceDigest(key);
  workspaceDigest(workspaceId);
  workspaceDigest(planFingerprint);
  const envelope = exact(value, [
    'schemaVersion', 'kind', 'workspaceId', 'planFingerprint', 'payload', 'mac'
  ]);
  if (envelope.schemaVersion !== 1 ||
      envelope.kind !== 'liftoff-adoption-verification-result-seal') {
    throw new RepairWorkspaceError(
      'unsupported-record',
      'Adoption verification result authentication schema is unsupported.'
    );
  }
  if (envelope.workspaceId !== workspaceId ||
      envelope.planFingerprint !== planFingerprint) {
    throw new RepairWorkspaceError(
      'scope-mismatch',
      'Adoption verification result belongs to another workspace or plan.'
    );
  }
  workspaceDigest(envelope.mac);
  const expected = createHmac('sha256', Buffer.from(key, 'hex')).update(canonicalJson({
    workspaceId, planFingerprint, payload: envelope.payload
  })).digest();
  if (!timingSafeEqual(expected, Buffer.from(envelope.mac, 'hex'))) {
    throw new RepairWorkspaceError(
      'unauthenticated-record',
      'Adoption verification result authentication failed.'
    );
  }
  return envelope.payload;
}

export function openWorkspaceSeal(value: unknown, key: string): unknown {
  const envelope = exact(value, ['schemaVersion', 'kind', 'payload', 'mac']);
  if (envelope.schemaVersion !== 1 || envelope.kind !== 'liftoff-repair-workspace-seal') {
    throw new RepairWorkspaceError('unsupported-record', 'Private workspace authentication schema is unsupported.');
  }
  workspaceDigest(envelope.mac);
  const expected = createHmac('sha256', Buffer.from(key, 'hex')).update(canonicalJson(envelope.payload)).digest();
  if (!timingSafeEqual(expected, Buffer.from(envelope.mac, 'hex'))) {
    throw new RepairWorkspaceError('unauthenticated-record', 'Private workspace authentication failed; no cleanup was authorized.');
  }
  return envelope.payload;
}

export function validateWorkspaceAuthority(value: unknown, projectRoot: string): string {
  const authority = exact(value, ['schemaVersion', 'kind', 'projectRoot', 'key']);
  if (authority.schemaVersion !== 1 || authority.kind !== 'liftoff-repair-workspace-authority') {
    throw new RepairWorkspaceError('unsupported-record', 'Private workspace authority schema is unsupported.');
  }
  if (authority.projectRoot !== projectRoot) throw new RepairWorkspaceError('scope-mismatch', 'Private workspace authority belongs to another project.');
  workspaceDigest(authority.key);
  return authority.key;
}
