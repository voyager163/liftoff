import path from 'node:path';
import { canonicalSha256, isRecord } from '../governance/activation/canonical-json.js';
import { linuxNullProcessProfile, parseLinuxReadonlyNullProcessPlan, type LinuxReadonlyNullProcessPlan } from './linux-null-process.js';
import { freezeStateValue, stateAssert } from './stateful-invariants.js';
import { stateFailureCodes, type StateFailureCode } from './stateful.js';
import {
  managedLinuxKeystoreContract, managedLinuxKeystoreContractDigest,
  managedLinuxKeystoreKinds as kinds, managedLinuxKeystoreOperations as operations, managedLinuxKeystoreProvider as provider
} from './managed-linux-keystore-contract.js';

export interface ManagedLinuxKeystoreBinding {
  platform: 'linux';
  architecture: 'x64' | 'arm64';
  projectId: string;
  hostRef: string;
  principalUid: number;
  enrollmentId: string;
  storeId: string;
  scopeRoot: string;
  /** Exact nonsecret configuration; never a private-input verifier. */
  configurationDigest: string;
  software: {
    daemonSourceCommit: typeof managedLinuxKeystoreContract.daemonSourceCommit;
    libsecretSourceCommit: typeof managedLinuxKeystoreContract.libsecretSourceCommit;
    daemonDigest: string;
    dependencyInventoryDigest: string;
    clientDigest: string;
    restartProfile: typeof linuxNullProcessProfile;
    restartHelperDigest: string;
  };
}

interface RecordHeader {
  schemaVersion: 1;
  provider: typeof provider;
  contractDigest: string;
  authority: 'none';
  nativeAuthority: 'not-established';
  readiness: false;
  fingerprint: string;
}

/** An immutable enrollment intent/identity, not a successful-enrollment receipt. */
export interface ManagedLinuxEnrollmentRecord extends RecordHeader {
  kind: typeof kinds.enrollment;
  binding: ManagedLinuxKeystoreBinding;
  operation: typeof operations.enroll;
  operationId: string;
  /** References the exact nonsecret operation description, not approval. */
  operationDigest: string;
  createdAt: string;
}

export type ManagedLinuxKeyCreation = 'unknown' | 'no-dispatch' | 'possible-mutation' | 'returned-identity';
export interface ManagedLinuxKeyEffect {
  creation: ManagedLinuxKeyCreation;
  observedItemPaths: readonly string[];
}
export interface ManagedLinuxPersistedGeneration {
  format: 'gnome-keyring-binary-0.0';
  path: string;
  device: string;
  inode: string;
  birthtime: string;
  uid: number;
  mode: number;
  sha256: string;
  byteLength: number;
}
export type ManagedLinuxCheckpointStage =
  | 'pre-effect' | 'store-dispatched' | 'key-dispatched' | 'key-returned'
  | 'persisted-observed' | 'restart-observed' | 'blocked';

/** Observation references are unverified locators; none is a native capability. */
export interface ManagedLinuxRecoveryCheckpoint extends RecordHeader {
  kind: typeof kinds.checkpoint;
  enrollmentFingerprint: string;
  bindingDigest: string;
  sequence: number;
  previousFingerprint: string | null;
  operation: typeof operations.enroll | typeof operations.recover;
  operationId: string;
  operationDigest: string;
  at: string;
  stage: ManagedLinuxCheckpointStage;
  blocker: StateFailureCode | null;
  keyEffect: ManagedLinuxKeyEffect;
  generation: ManagedLinuxPersistedGeneration | null;
  keyBindingDigest: string | null;
  fileSyncObservationDigest: string | null;
  directorySyncObservationDigest: string | null;
  processSettlementObservationDigest: string | null;
  restartReadbackObservationDigest: string | null;
  restartPlan: LinuxReadonlyNullProcessPlan | null;
}

export interface ManagedLinuxKeyReference extends RecordHeader {
  kind: typeof kinds.keyReference;
  enrollmentFingerprint: string;
  checkpointFingerprint: string;
  bindingDigest: string;
  itemPath: string;
  persistedGenerationDigest: string;
  keyBindingDigest: string;
}

export type ManagedLinuxKeystoreRecord = ManagedLinuxEnrollmentRecord | ManagedLinuxRecoveryCheckpoint | ManagedLinuxKeyReference;
const header = ['schemaVersion', 'kind', 'provider', 'contractDigest', 'authority', 'nativeAuthority', 'readiness', 'fingerprint'];
const digestPattern = /^[a-f0-9]{64}$/u;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const collection = '/org/freedesktop/secrets/collection/login';
const creationRank: Record<ManagedLinuxKeyCreation, number> = {
  'no-dispatch': 0, unknown: 1, 'possible-mutation': 2, 'returned-identity': 3
};

function require(value: unknown): asserts value { stateAssert(value, 'artifact-integrity'); }
function exact(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  require(isRecord(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field)));
}
function digest(value: unknown): asserts value is string { require(typeof value === 'string' && digestPattern.test(value)); }
function uuid(value: unknown): asserts value is string { require(typeof value === 'string' && uuidPattern.test(value)); }
function time(value: unknown): asserts value is string {
  require(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
}
function nativePath(value: unknown): asserts value is string {
  require(typeof value === 'string' && Buffer.byteLength(value) <= 4095 && Buffer.from(value).toString() === value &&
    value !== '/' && path.posix.isAbsolute(value) && path.posix.normalize(value) === value &&
    !value.endsWith('/') && value.normalize('NFC') === value && !/[\\\u0000-\u001f\u007f]/u.test(value));
}
function unsigned(value: unknown): void { require(typeof value === 'string' && /^(?:0|[1-9][0-9]{0,31})$/u.test(value)); }
function objectPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && /^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/u.test(value);
}
function item(value: unknown): value is string {
  return objectPath(value) && value.startsWith(`${collection}/`) && /^[A-Za-z0-9_]{1,128}$/u.test(value.slice(collection.length + 1));
}
function record(value: unknown, kind: string, fields: readonly string[]): asserts value is Record<string, unknown> {
  exact(value, [...header, ...fields]);
  require(value.schemaVersion === 1 && value.kind === kind && value.provider === provider &&
    value.contractDigest === managedLinuxKeystoreContractDigest && value.authority === 'none' &&
    value.nativeAuthority === 'not-established' && value.readiness === false);
  digest(value.fingerprint);
  const { fingerprint, ...body } = value;
  require(fingerprint === canonicalSha256(body));
}
function seal<T>(body: T): T & { fingerprint: string } {
  return { ...body, fingerprint: canonicalSha256(body) };
}
const fixedHeader = Object.freeze({
  schemaVersion: 1 as const, provider, contractDigest: managedLinuxKeystoreContractDigest,
  authority: 'none' as const, nativeAuthority: 'not-established' as const, readiness: false as const
});

export function parseManagedLinuxKeystoreBinding(value: unknown): ManagedLinuxKeystoreBinding {
  exact(value, ['platform', 'architecture', 'projectId', 'hostRef', 'principalUid', 'enrollmentId', 'storeId', 'scopeRoot', 'configurationDigest', 'software']);
  require(value.platform === 'linux' && (value.architecture === 'x64' || value.architecture === 'arm64') &&
    typeof value.projectId === 'string' && /^[A-Za-z0-9_.:@/-]{1,256}$/u.test(value.projectId) &&
    typeof value.hostRef === 'string' && /^native-host:[a-f0-9]{64}$/u.test(value.hostRef) &&
    typeof value.principalUid === 'number' && Number.isSafeInteger(value.principalUid) && value.principalUid > 0 && value.principalUid <= 0xffffffff);
  uuid(value.enrollmentId); uuid(value.storeId); nativePath(value.scopeRoot); digest(value.configurationDigest);
  exact(value.software, ['daemonSourceCommit', 'libsecretSourceCommit', 'daemonDigest',
    'dependencyInventoryDigest', 'clientDigest', 'restartProfile', 'restartHelperDigest']);
  require(value.software.daemonSourceCommit === managedLinuxKeystoreContract.daemonSourceCommit &&
    value.software.libsecretSourceCommit === managedLinuxKeystoreContract.libsecretSourceCommit &&
    value.software.restartProfile === linuxNullProcessProfile);
  for (const field of ['daemonDigest', 'dependencyInventoryDigest', 'clientDigest', 'restartHelperDigest']) digest(value.software[field]);
  return freezeStateValue(structuredClone(value)) as unknown as ManagedLinuxKeystoreBinding;
}

export function parseManagedLinuxEnrollmentRecord(value: unknown): ManagedLinuxEnrollmentRecord {
  record(value, kinds.enrollment, ['binding', 'operation', 'operationId', 'operationDigest', 'createdAt']);
  parseManagedLinuxKeystoreBinding(value.binding);
  require(value.operation === operations.enroll);
  uuid(value.operationId); digest(value.operationDigest); time(value.createdAt);
  return freezeStateValue(structuredClone(value)) as unknown as ManagedLinuxEnrollmentRecord;
}

export function createManagedLinuxEnrollmentRecord(
  input: Pick<ManagedLinuxEnrollmentRecord, 'binding' | 'operationId' | 'operationDigest' | 'createdAt'>
): ManagedLinuxEnrollmentRecord {
  exact(input, ['binding', 'operationId', 'operationDigest', 'createdAt']);
  return parseManagedLinuxEnrollmentRecord(seal({ ...fixedHeader, kind: kinds.enrollment, operation: operations.enroll, ...input }));
}

export function parseManagedLinuxKeyEffect(value: unknown): ManagedLinuxKeyEffect {
  exact(value, ['creation', 'observedItemPaths']);
  require(typeof value.creation === 'string' && Object.hasOwn(creationRank, value.creation) &&
    Array.isArray(value.observedItemPaths) && value.observedItemPaths.length <= 32 &&
    value.observedItemPaths.every(objectPath) && new Set(value.observedItemPaths).size === value.observedItemPaths.length);
  if (value.creation === 'returned-identity') require(value.observedItemPaths.length > 0);
  return freezeStateValue(structuredClone(value)) as unknown as ManagedLinuxKeyEffect;
}

export function parseManagedLinuxPersistedGeneration(value: unknown): ManagedLinuxPersistedGeneration {
  exact(value, ['format', 'path', 'device', 'inode', 'birthtime', 'uid', 'mode', 'sha256', 'byteLength']);
  require(value.format === 'gnome-keyring-binary-0.0');
  nativePath(value.path);
  require(path.posix.basename(value.path) === 'login.keyring');
  for (const field of ['device', 'inode', 'birthtime']) unsigned(value[field]);
  require(typeof value.uid === 'number' && Number.isSafeInteger(value.uid) && value.uid > 0 && value.uid <= 0xffffffff &&
    (value.mode === 0o600 || value.mode === 0o400) &&
    typeof value.byteLength === 'number' && Number.isSafeInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= 1024 * 1024);
  digest(value.sha256);
  return freezeStateValue(structuredClone(value)) as unknown as ManagedLinuxPersistedGeneration;
}

export function mergeManagedLinuxKeyEffect(previous: unknown, next: unknown): ManagedLinuxKeyEffect {
  const before = parseManagedLinuxKeyEffect(previous), after = parseManagedLinuxKeyEffect(next);
  return parseManagedLinuxKeyEffect({
    creation: creationRank[after.creation] > creationRank[before.creation] ? after.creation : before.creation,
    observedItemPaths: [...new Set([...before.observedItemPaths, ...after.observedItemPaths])]
  });
}

const checkpointFields = ['enrollmentFingerprint', 'bindingDigest', 'sequence', 'previousFingerprint', 'operation',
  'operationId', 'operationDigest', 'at', 'stage', 'blocker', 'keyEffect', 'generation', 'keyBindingDigest',
  'fileSyncObservationDigest', 'directorySyncObservationDigest', 'processSettlementObservationDigest',
  'restartReadbackObservationDigest', 'restartPlan'];
export function parseManagedLinuxRecoveryCheckpoint(value: unknown): ManagedLinuxRecoveryCheckpoint {
  record(value, kinds.checkpoint, checkpointFields);
  digest(value.enrollmentFingerprint); digest(value.bindingDigest); uuid(value.operationId); digest(value.operationDigest); time(value.at);
  require(Number.isSafeInteger(value.sequence) && (value.sequence as number) >= 1 && (value.sequence as number) <= 64 &&
    (value.operation === operations.enroll || value.operation === operations.recover));
  if (value.sequence === 1) require(value.previousFingerprint === null); else digest(value.previousFingerprint);
  require(['pre-effect', 'store-dispatched', 'key-dispatched', 'key-returned', 'persisted-observed', 'restart-observed', 'blocked'].includes(value.stage as string));
  if (value.stage === 'blocked') require(typeof value.blocker === 'string' && stateFailureCodes.includes(value.blocker as StateFailureCode));
  else require(value.blocker === null);
  const effect = parseManagedLinuxKeyEffect(value.keyEffect);
  if (value.generation !== null) parseManagedLinuxPersistedGeneration(value.generation);
  for (const field of ['keyBindingDigest', 'fileSyncObservationDigest', 'directorySyncObservationDigest',
    'processSettlementObservationDigest', 'restartReadbackObservationDigest']) if (value[field] !== null) digest(value[field]);
  if (value.restartPlan !== null) parseLinuxReadonlyNullProcessPlan(value.restartPlan);
  if (value.stage === 'pre-effect') require(effect.creation === 'no-dispatch' && effect.observedItemPaths.length === 0 &&
    value.generation === null && value.keyBindingDigest === null && value.restartPlan === null);
  if (value.stage === 'key-dispatched') require(effect.creation === 'possible-mutation' || effect.creation === 'unknown');
  if (value.stage === 'key-returned') require(effect.creation === 'returned-identity');
  if (value.stage === 'persisted-observed' || value.stage === 'restart-observed') {
    require(effect.creation === 'returned-identity' && effect.observedItemPaths.length === 1 &&
      item(effect.observedItemPaths[0]) && value.generation !== null);
    digest(value.keyBindingDigest); digest(value.fileSyncObservationDigest); digest(value.directorySyncObservationDigest);
  }
  if (value.stage === 'restart-observed') {
    require(value.operation === operations.recover && value.restartPlan !== null);
    digest(value.processSettlementObservationDigest); digest(value.restartReadbackObservationDigest);
  }
  return freezeStateValue(structuredClone(value)) as unknown as ManagedLinuxRecoveryCheckpoint;
}

export function createManagedLinuxRecoveryCheckpoint(
  input: Omit<ManagedLinuxRecoveryCheckpoint, keyof RecordHeader | 'kind'>
): ManagedLinuxRecoveryCheckpoint {
  exact(input, checkpointFields);
  return parseManagedLinuxRecoveryCheckpoint(seal({ ...fixedHeader, kind: kinds.checkpoint, ...input }));
}

export function parseManagedLinuxKeyReference(value: unknown): ManagedLinuxKeyReference {
  record(value, kinds.keyReference, ['enrollmentFingerprint', 'checkpointFingerprint', 'bindingDigest',
    'itemPath', 'persistedGenerationDigest', 'keyBindingDigest']);
  for (const field of ['enrollmentFingerprint', 'checkpointFingerprint', 'bindingDigest', 'persistedGenerationDigest', 'keyBindingDigest']) digest(value[field]);
  require(item(value.itemPath));
  return freezeStateValue(structuredClone(value)) as unknown as ManagedLinuxKeyReference;
}

/** Checks metadata lineage only. Native observations and approvals remain mandatory. */
export function readManagedLinuxCheckpointChain(
  enrollmentValue: unknown, checkpointValues: readonly unknown[], expectedBinding: ManagedLinuxKeystoreBinding
): { enrollment: ManagedLinuxEnrollmentRecord; checkpoint: ManagedLinuxRecoveryCheckpoint } {
  const enrollment = parseManagedLinuxEnrollmentRecord(enrollmentValue);
  const binding = parseManagedLinuxKeystoreBinding(expectedBinding);
  stateAssert(canonicalSha256(enrollment.binding) === canonicalSha256(binding), 'stale-state');
  require(Array.isArray(checkpointValues) && checkpointValues.length > 0 && checkpointValues.length <= 64);
  let prior: ManagedLinuxRecoveryCheckpoint | undefined;
  let storeDispatched = false, keyDispatched = false;
  for (const raw of checkpointValues) {
    const checkpoint = parseManagedLinuxRecoveryCheckpoint(raw);
    require(checkpoint.enrollmentFingerprint === enrollment.fingerprint && checkpoint.bindingDigest === canonicalSha256(binding) &&
      checkpoint.sequence === (prior?.sequence ?? 0) + 1 && checkpoint.previousFingerprint === (prior?.fingerprint ?? null) &&
      Date.parse(checkpoint.at) >= Date.parse(prior?.at ?? enrollment.createdAt));
    if (!prior) require(checkpoint.stage === 'pre-effect');
    if (checkpoint.operation === operations.enroll)
      require(checkpoint.operationId === enrollment.operationId && checkpoint.operationDigest === enrollment.operationDigest);
    if (prior) {
      require(creationRank[checkpoint.keyEffect.creation] >= creationRank[prior.keyEffect.creation] &&
        prior.keyEffect.observedItemPaths.every((entry, index) => checkpoint.keyEffect.observedItemPaths[index] === entry));
    }
    if (checkpoint.stage === 'store-dispatched') {
      require(!storeDispatched && !keyDispatched && prior?.stage === 'pre-effect' &&
        prior.keyEffect.creation === 'no-dispatch');
      storeDispatched = true;
    }
    if (checkpoint.stage === 'key-dispatched') {
      require(storeDispatched && !keyDispatched && prior?.keyEffect.creation === 'no-dispatch');
      keyDispatched = true;
    }
    if (checkpoint.stage === 'key-returned' || checkpoint.stage === 'persisted-observed' || checkpoint.stage === 'restart-observed')
      require(keyDispatched);
    if (checkpoint.generation) {
      const relative = path.posix.relative(binding.scopeRoot, checkpoint.generation.path);
      require(relative !== '' && relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative) &&
        checkpoint.generation.uid === binding.principalUid);
      if (prior?.generation) require(canonicalSha256(checkpoint.generation) === canonicalSha256(prior.generation));
    } else require(!prior?.generation);
    if (prior?.keyBindingDigest) require(checkpoint.keyBindingDigest === prior.keyBindingDigest);
    if (checkpoint.restartPlan) {
      require(checkpoint.restartPlan.hostId === binding.hostRef && checkpoint.restartPlan.principalUid === binding.principalUid &&
        checkpoint.restartPlan.profile === binding.software.restartProfile &&
        checkpoint.restartPlan.helperDigest === binding.software.restartHelperDigest &&
        checkpoint.restartPlan.operationDigest === checkpoint.operationDigest);
    }
    prior = checkpoint;
  }
  return Object.freeze({ enrollment, checkpoint: prior! });
}

export function createManagedLinuxKeyReference(
  enrollment: ManagedLinuxEnrollmentRecord, checkpoints: readonly ManagedLinuxRecoveryCheckpoint[]
): ManagedLinuxKeyReference {
  const current = readManagedLinuxCheckpointChain(enrollment, checkpoints, enrollment.binding);
  require(current.checkpoint.stage === 'restart-observed' && current.checkpoint.generation && current.checkpoint.keyBindingDigest);
  return parseManagedLinuxKeyReference(seal({
    ...fixedHeader, kind: kinds.keyReference, enrollmentFingerprint: current.enrollment.fingerprint,
    checkpointFingerprint: current.checkpoint.fingerprint, bindingDigest: canonicalSha256(enrollment.binding),
    itemPath: current.checkpoint.keyEffect.observedItemPaths[0]!,
    persistedGenerationDigest: current.checkpoint.generation.sha256, keyBindingDigest: current.checkpoint.keyBindingDigest
  }));
}

export function managedLinuxKeyReferenceId(value: ManagedLinuxKeyReference): string {
  return `managed-linux-key:${parseManagedLinuxKeyReference(value).fingerprint}`;
}
