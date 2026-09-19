import { canonicalSha256, isRecord } from '../governance/activation/canonical-json.js';
import { freezeStateValue, stateAssert } from './stateful-invariants.js';

export const linuxNullProcessProfile = 'linux-landlock-readonly-process-null-sink/1';

export interface LinuxNullDeviceObservation {
  path: '/dev/null';
  kind: 'character-device';
  device: string;
  inode: string;
  ctime: string;
  uid: 0;
  gid: number;
  mode: number;
  rdev: '259';
  major: 1;
  minor: 3;
}

export interface LinuxReadonlyNullProcessPlan {
  schemaVersion: 1;
  kind: 'linux-null-sink-execution-plan';
  profile: typeof linuxNullProcessProfile;
  helperDigest: string;
  hostId: string;
  principalUid: number;
  operationDigest: string;
  requestDigest: string;
  nullDevice: LinuxNullDeviceObservation;
  execution: 'not-authorized';
  readiness: false;
  fingerprint: string;
}

function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  stateAssert(isRecord(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)), 'invalid-binding');
}

function digest(value: unknown): asserts value is string {
  stateAssert(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'invalid-binding');
}

function unsigned(value: unknown): string {
  stateAssert(typeof value === 'string' && /^(?:0|[1-9][0-9]{0,31})$/u.test(value), 'invalid-binding');
  return value;
}

/** Validates observation shape only; the native guard must reobserve the object. */
export function parseLinuxNullDeviceObservation(value: unknown): LinuxNullDeviceObservation {
  exact(value, ['path', 'kind', 'device', 'inode', 'ctime', 'uid', 'gid', 'mode', 'rdev', 'major', 'minor']);
  const device = unsigned(value.device), inode = unsigned(value.inode), ctime = unsigned(value.ctime);
  stateAssert(value.path === '/dev/null' && value.kind === 'character-device' && value.uid === 0 &&
    value.rdev === '259' && value.major === 1 && value.minor === 3 &&
    typeof value.gid === 'number' && Number.isSafeInteger(value.gid) && value.gid >= 0 && value.gid <= 0xffffffff &&
    typeof value.mode === 'number' && Number.isSafeInteger(value.mode) && value.mode >= 0 && value.mode <= 0o7777,
  'invalid-binding');
  return Object.freeze({
    path: '/dev/null', kind: 'character-device', device, inode, ctime,
    uid: 0, gid: value.gid, mode: value.mode, rdev: '259', major: 1, minor: 3
  });
}

/** A bound execution description, never approval or native qualification authority. */
export function createLinuxReadonlyNullProcessPlan(input: {
  helperDigest: string; hostId: string; principalUid: number; operationDigest: string;
  requestDigest: string; nullDevice: LinuxNullDeviceObservation;
}): LinuxReadonlyNullProcessPlan {
  exact(input, ['helperDigest', 'hostId', 'principalUid', 'operationDigest', 'requestDigest', 'nullDevice']);
  for (const field of ['helperDigest', 'operationDigest', 'requestDigest'] as const) digest(input[field]);
  stateAssert(typeof input.hostId === 'string' && /^native-host:[a-f0-9]{64}$/u.test(input.hostId) &&
    Number.isSafeInteger(input.principalUid) && input.principalUid > 0 && input.principalUid <= 0xffffffff,
  'invalid-binding');
  const body = {
    schemaVersion: 1 as const, kind: 'linux-null-sink-execution-plan' as const, profile: linuxNullProcessProfile,
    helperDigest: input.helperDigest, hostId: input.hostId, principalUid: input.principalUid,
    operationDigest: input.operationDigest, requestDigest: input.requestDigest,
    nullDevice: parseLinuxNullDeviceObservation(input.nullDevice),
    execution: 'not-authorized' as const, readiness: false as const
  } satisfies Omit<LinuxReadonlyNullProcessPlan, 'fingerprint'>;
  return freezeStateValue({ ...body, fingerprint: canonicalSha256(body) });
}

export function parseLinuxReadonlyNullProcessPlan(value: unknown): LinuxReadonlyNullProcessPlan {
  exact(value, ['schemaVersion', 'kind', 'profile', 'helperDigest', 'hostId', 'principalUid',
    'operationDigest', 'requestDigest', 'nullDevice', 'execution', 'readiness', 'fingerprint']);
  stateAssert(value.schemaVersion === 1 && value.kind === 'linux-null-sink-execution-plan' &&
    value.profile === linuxNullProcessProfile && value.execution === 'not-authorized' && value.readiness === false &&
    typeof value.hostId === 'string' && typeof value.principalUid === 'number', 'invalid-binding');
  digest(value.helperDigest); digest(value.operationDigest); digest(value.requestDigest); digest(value.fingerprint);
  const plan = createLinuxReadonlyNullProcessPlan({
    helperDigest: value.helperDigest, hostId: value.hostId, principalUid: value.principalUid,
    operationDigest: value.operationDigest, requestDigest: value.requestDigest,
    nullDevice: parseLinuxNullDeviceObservation(value.nullDevice)
  });
  stateAssert(plan.fingerprint === value.fingerprint, 'invalid-binding');
  return plan;
}
