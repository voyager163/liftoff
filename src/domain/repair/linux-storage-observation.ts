import path from 'node:path';
import { canonicalSha256, isRecord } from '../governance/activation/canonical-json.js';
import { freezeStateValue, stateAssert } from './stateful-invariants.js';

export const linuxStorageDirectoryProfile = 'linux-ext4-fscrypt-v2-directory-observation/1';
export const linuxStorageInterfaceAudit = freezeStateValue({
  profile: linuxStorageDirectoryProfile,
  kernelSourceCommit: 'adc218676eef25575469234709c2d87185ca223a',
  kernelSourceTag: 'v6.12',
  platform: 'linux',
  architectures: ['x64', 'arm64'],
  ABI: 'little-endian-LP64',
  filesystem: 'ext4',
  blockSizes: [1024, 2048, 4096, 8192, 16384, 32768, 65536],
  policy: { version: 2, contentsMode: 1, filenamesMode: 4, allowedFlags: [0, 1, 2, 3], log2DataUnitSize: 0 },
  ioctls: {
    getPolicy: { name: 'FS_IOC_GET_ENCRYPTION_POLICY_EX', request: 0xc0096616, bufferBytes: 32, policyBytes: 24 },
    getKeyStatus: { name: 'FS_IOC_GET_ENCRYPTION_KEY_STATUS', request: 0xc080661a, bufferBytes: 128, identifierType: 2 }
  },
  topology: 'retained-component-fds-procfs-mount-id-and-ext4-fstatfs-rechecked',
  rejected: ['regular-files-and-special-files', 'legacy-policy', 'unknown-policy', 'test-dummy-encryption', 'subtree-bind-or-visible-device-alias',
    'non-ext4-or-overlay', 'absent-or-incompletely-removed-key', 'missing-current-fsuid-key-claim'],
  coverage: 'selected-existing-directory-policy-only',
  volumeEncryption: 'not-observed',
  backingDeviceLocality: 'not-observed',
  keyCustody: 'not-observed',
  inodeKeyUsability: 'not-observed',
  descendantCoverage: 'not-observed',
  metadataEncryption: 'not-provided-by-fscrypt',
  integrityProtection: 'not-provided-by-fscrypt',
  authorization: 'none',
  nativeQualification: 'required',
  readiness: false
} as const);

export interface LinuxFscryptPolicyObservation {
  version: 2;
  contentsMode: 1;
  filenamesMode: 4;
  flags: number;
  log2DataUnitSize: 0;
  keyIdentifier: string;
}
export interface LinuxFscryptKeyStatusObservation {
  status: 'present';
  addedByCurrentFsUid: true;
  userCount: number;
}
export interface LinuxStorageDirectoryIdentity {
  kind: 'directory';
  device: string;
  inode: string;
  ctime: string;
  size: string;
  uid: number;
  gid: number;
  mode: number;
  links: number;
  mountId: string;
}
export interface LinuxStorageDirectoryObservation {
  schemaVersion: 1;
  kind: typeof linuxStorageDirectoryProfile;
  contractDigest: string;
  helperDigest: string;
  hostRef: string;
  principalUid: number;
  architecture: 'x64' | 'arm64';
  path: string;
  object: LinuxStorageDirectoryIdentity;
  filesystem: {
    type: 'ext4'; magic: 61267; fsid: string; blockSize: number; readOnly: boolean;
    mountInfoDigest: string; mountRecordDigest: string; namespace: string;
  };
  ancestryDigest: string;
  policy: LinuxFscryptPolicyObservation;
  key: LinuxFscryptKeyStatusObservation;
  observedAt: number;
  coverage: 'selected-existing-directory-policy-only';
  volumeEncryption: 'not-observed';
  backingDeviceLocality: 'not-observed';
  keyCustody: 'not-observed';
  inodeKeyUsability: 'not-observed';
  descendantCoverage: 'not-observed';
  authorization: 'none';
  nativeQualification: 'required';
  readiness: false;
}

export const linuxStorageInterfaceDigest = canonicalSha256(linuxStorageInterfaceAudit);

function exact(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  stateAssert(isRecord(value) && Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field)), 'artifact-integrity');
}
function digest(value: unknown): void {
  stateAssert(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'artifact-integrity');
}
function unsigned(value: unknown): void {
  stateAssert(typeof value === 'string' && /^(?:0|[1-9][0-9]{0,31})$/u.test(value), 'artifact-integrity');
}

/** Decodes the actual GET_POLICY_EX output layout; there is no v1/flag fallback. */
export function decodeLinuxFscryptPolicy(bytes: Uint8Array): LinuxFscryptPolicyObservation {
  stateAssert(bytes.byteLength === 32, 'unsupported-encryption');
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  stateAssert(data.readBigUInt64LE(0) === 24n && data[8] === 2 && data[9] === 1 && data[10] === 4 &&
    data[11]! <= 3 && data[12] === 0 && data.subarray(13, 16).every((byte) => byte === 0), 'unsupported-encryption');
  return Object.freeze({
    version: 2, contentsMode: 1, filenamesMode: 4, flags: data[11]!, log2DataUnitSize: 0,
    keyIdentifier: data.subarray(16, 32).toString('hex')
  });
}

/** A current filesystem-keyring claim is not exclusive key custody or entropy proof. */
export function decodeLinuxFscryptKeyStatus(
  bytes: Uint8Array, policy: LinuxFscryptPolicyObservation
): LinuxFscryptKeyStatusObservation {
  stateAssert(bytes.byteLength === 128, 'key-unavailable');
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  stateAssert(data.readUInt32LE(0) === 2 && data.readUInt32LE(4) === 0 &&
    data.subarray(8, 24).toString('hex') === policy.keyIdentifier &&
    data.subarray(24, 64).every((byte) => byte === 0) &&
    data.subarray(76).every((byte) => byte === 0), 'artifact-integrity');
  stateAssert(data.readUInt32LE(64) === 2, 'key-unavailable');
  stateAssert(data.readUInt32LE(68) === 1 && data.readUInt32LE(72) >= 1, 'ownership-mismatch');
  return Object.freeze({ status: 'present', addedByCurrentFsUid: true, userCount: data.readUInt32LE(72) });
}

/** Shape/integrity only. Serialized observations are not native provenance. */
export function parseLinuxStorageDirectoryObservation(value: unknown): LinuxStorageDirectoryObservation {
  exact(value, ['schemaVersion', 'kind', 'contractDigest', 'helperDigest', 'hostRef', 'principalUid', 'architecture', 'path',
    'object', 'filesystem', 'ancestryDigest', 'policy', 'key', 'observedAt', 'coverage', 'volumeEncryption',
    'backingDeviceLocality', 'keyCustody', 'inodeKeyUsability', 'descendantCoverage', 'authorization', 'nativeQualification', 'readiness']);
  stateAssert(value.schemaVersion === 1 && value.kind === linuxStorageDirectoryProfile &&
    value.contractDigest === linuxStorageInterfaceDigest &&
    typeof value.hostRef === 'string' && /^native-host:[a-f0-9]{64}$/u.test(value.hostRef) &&
    Number.isSafeInteger(value.principalUid) && (value.principalUid as number) > 0 &&
    (value.principalUid as number) <= 0xffffffff && (value.architecture === 'x64' || value.architecture === 'arm64'),
  'artifact-integrity');
  digest(value.helperDigest); digest(value.ancestryDigest);
  stateAssert(typeof value.path === 'string' && value.path !== '/' && Buffer.byteLength(value.path) <= 4095 &&
    path.posix.isAbsolute(value.path) && path.posix.normalize(value.path) === value.path && !value.path.endsWith('/') &&
    value.path.normalize('NFC') === value.path && !/[\u0000-\u001f\u007f\\]/u.test(value.path), 'unsafe-path');
  exact(value.object, ['kind', 'device', 'inode', 'ctime', 'size', 'uid', 'gid', 'mode', 'links', 'mountId']);
  for (const field of ['device', 'inode', 'ctime', 'size', 'mountId']) unsigned(value.object[field]);
  stateAssert(value.object.kind === 'directory' &&
    value.object.uid === value.principalUid && Number.isSafeInteger(value.object.gid) &&
    (value.object.gid as number) >= 0 && (value.object.gid as number) <= 0xffffffff &&
    Number.isSafeInteger(value.object.links) && (value.object.links as number) >= 1 &&
    [0o500, 0o700].includes(value.object.mode as number), 'unsafe-path');
  exact(value.filesystem, ['type', 'magic', 'fsid', 'blockSize', 'readOnly', 'mountInfoDigest', 'mountRecordDigest', 'namespace']);
  stateAssert(value.filesystem.type === 'ext4' && value.filesystem.magic === 0xef53 &&
    typeof value.filesystem.fsid === 'string' && /^[a-f0-9]{16}$/u.test(value.filesystem.fsid) &&
    [1024, 2048, 4096, 8192, 16384, 32768, 65536].includes(value.filesystem.blockSize as number) && typeof value.filesystem.readOnly === 'boolean' &&
    typeof value.filesystem.namespace === 'string' && /^[0-9]+:[0-9]+$/u.test(value.filesystem.namespace), 'unsupported-encryption');
  digest(value.filesystem.mountInfoDigest); digest(value.filesystem.mountRecordDigest);
  exact(value.policy, ['version', 'contentsMode', 'filenamesMode', 'flags', 'log2DataUnitSize', 'keyIdentifier']);
  stateAssert(value.policy.version === 2 && value.policy.contentsMode === 1 && value.policy.filenamesMode === 4 &&
    [0, 1, 2, 3].includes(value.policy.flags as number) && value.policy.log2DataUnitSize === 0 &&
    typeof value.policy.keyIdentifier === 'string' && /^[a-f0-9]{32}$/u.test(value.policy.keyIdentifier), 'unsupported-encryption');
  exact(value.key, ['status', 'addedByCurrentFsUid', 'userCount']);
  stateAssert(value.key.status === 'present' && value.key.addedByCurrentFsUid === true &&
    Number.isSafeInteger(value.key.userCount) && (value.key.userCount as number) >= 1 &&
    (value.key.userCount as number) <= 0xffffffff, 'key-unavailable');
  stateAssert(Number.isSafeInteger(value.observedAt) && (value.observedAt as number) >= 0 &&
    value.coverage === 'selected-existing-directory-policy-only' && value.volumeEncryption === 'not-observed' &&
    value.backingDeviceLocality === 'not-observed' && value.keyCustody === 'not-observed' &&
    value.inodeKeyUsability === 'not-observed' &&
    value.descendantCoverage === 'not-observed' && value.authorization === 'none' &&
    value.nativeQualification === 'required' && value.readiness === false, 'artifact-integrity');
  return freezeStateValue(structuredClone(value)) as unknown as LinuxStorageDirectoryObservation;
}
