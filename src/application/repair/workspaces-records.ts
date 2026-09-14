import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { validateRepairExecutionIdentity } from '../../domain/repair/identity.js';
import { liftoffVersion } from '../../version.js';
import {
  RepairWorkspaceError, repairWorkspaceRoleNames,
  type CreateRepairVerificationWorkspaceOptions, type RepairWorkspaceActivity,
  type RepairWorkspaceFileIdentity, type RepairWorkspaceRecord
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

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))) {
    throw new RepairWorkspaceError('registry-invalid', 'Workspace metadata has missing or unsupported fields.');
  }
  return value;
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

export function validateWorkspaceRequest(value: unknown): CreateRepairVerificationWorkspaceOptions {
  const request = exact(value, ['planFingerprint', 'repairIdentity', 'patchStagingRoot', 'bindings', 'approvedScopes']);
  workspaceDigest(request.planFingerprint);
  nativePath(request.patchStagingRoot);
  let identity;
  try { identity = validateRepairExecutionIdentity(request.repairIdentity); }
  catch { throw new RepairWorkspaceError('unsupported-record', 'Workspace repair identity is not supported by this CLI.'); }
  if (identity.cliVersion !== liftoffVersion) {
    throw new RepairWorkspaceError('unsupported-record', 'Workspace CLI identity is not supported by this implementation.');
  }
  const bindings = exact(request.bindings, ['inputDigest', 'verificationPolicyDigest', 'providerDigest', 'toolchainDigest']);
  for (const digest of Object.values(bindings)) workspaceDigest(digest);
  const scopes = exact(request.approvedScopes, ['projectCode', 'dependencyPreparation', 'network', 'lifecycle']);
  if (Object.values(scopes).some((value) => typeof value !== 'boolean') || scopes.projectCode !== true) {
    throw new RepairWorkspaceError('permission-denied', 'Private verification requires explicit project-code scope and separate declared effect permissions.');
  }
  return structuredClone(request) as unknown as CreateRepairVerificationWorkspaceOptions;
}

export function validateWorkspaceActivity(value: unknown, record: RepairWorkspaceRecord): RepairWorkspaceActivity {
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
  if (!Array.isArray(index.workspaces) || index.workspaces.length > maximumRepairWorkspaces) {
    throw new RepairWorkspaceError('limits-exceeded', 'The bounded private workspace index is full or invalid.');
  }
  for (const id of index.workspaces) workspaceDigest(id);
  if (new Set(index.workspaces).size !== index.workspaces.length) {
    throw new RepairWorkspaceError('registry-invalid', 'Private workspace index contains duplicate identities.');
  }
  return structuredClone(index) as unknown as RepairWorkspaceIndex;
}

export function validateWorkspaceRecord(
  value: unknown,
  expected: { projectRoot: string; directory: (workspaceId: string) => string }
): RepairWorkspaceRecord {
  const record = exact(value, [
    'schemaVersion', 'kind', 'workspaceId', 'revision', 'projectRoot', 'projectIdentity',
    'patchStagingRoot', 'patchStagingIdentity', 'planFingerprint', 'repairIdentity',
    'bindings', 'approvedScopes', 'directory', 'creationIdentity', 'roles', 'owner',
    'phase', 'lastCheckpoint', 'activities', 'cleanup', 'createdAt', 'updatedAt'
  ]);
  if (record.schemaVersion !== 1 || record.kind !== 'liftoff-repair-workspace') {
    throw new RepairWorkspaceError('unsupported-record', 'Private workspace record schema is unsupported; no cleanup was authorized.');
  }
  workspaceDigest(record.workspaceId);
  integer(record.revision, 1);
  validateWorkspaceRequest({
    planFingerprint: record.planFingerprint, repairIdentity: record.repairIdentity,
    patchStagingRoot: record.patchStagingRoot, bindings: record.bindings, approvedScopes: record.approvedScopes
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
  if (!Array.isArray(activities.inFlight) || activities.inFlight.length > 32) {
    throw new RepairWorkspaceError('limits-exceeded', 'Workspace activity inventory exceeds its bound.');
  }
  const ids = new Set<string>();
  for (const value of activities.inFlight) {
    const activity = exact(value, ['id', 'kind', 'commandDigest', 'network', 'lifecycle']);
    workspaceDigest(activity.id);
    if (ids.has(activity.id)) throw new RepairWorkspaceError('registry-invalid', 'Duplicate workspace activity identity.');
    ids.add(activity.id);
    const { id: _id, ...request } = activity;
    validateWorkspaceActivity(request, record as unknown as RepairWorkspaceRecord);
  }
  if ((activities.settled as number) + (activities.uncertain as number) + activities.inFlight.length !== activities.started) {
    throw new RepairWorkspaceError('registry-invalid', 'Workspace activity counts do not match their registered inventory.');
  }
  if (owner.state === 'released') {
    const release = exact(owner.release, ['releasedAt', 'allKnownCommandsSettled']);
    timestamp(release.releasedAt);
    if (release.allKnownCommandsSettled !== true || activities.inFlight.length || activities.uncertain !== 0) {
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
  return structuredClone(record) as unknown as RepairWorkspaceRecord;
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
