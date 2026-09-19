// Existing native receipts bind this exact tuple's canonical digest.
export const posixNativeStateProtocol = Object.freeze({
  version: 'opentofu-1.12.6-posix-fcntl' as const,
  tofuVersion: '1.12.6' as const,
  sourceCommit: 'b4305e5a5dd2fb79a27897ae30784a181d3a26cb',
  lockSource: 'internal/flock/filesystem_lock_unix.go',
  lockBlob: 'c396e445a0eede26b32b97068216fe3691070d9f',
  stateSource: 'internal/states/statemgr/filesystem.go',
  stateBlob: '3f01209ea1635c9cad5f499f4f08ce356aef9a4c',
  lockOperation: 'F_SETLK/F_WRLCK/start=0/length=0',
  writeOperation: 'seek/truncate/write/sync on the same open inode'
});

export const windowsNativeStateProtocol = Object.freeze({
  version: 'opentofu-1.12.6-windows-lockfileex' as const,
  tofuVersion: '1.12.6' as const,
  sourceCommit: posixNativeStateProtocol.sourceCommit,
  lockSource: 'internal/flock/filesystem_lock_windows.go',
  lockBlob: '676e1318c25b9d32aa50e86dc8edfcb204bab3f4',
  stateSource: posixNativeStateProtocol.stateSource,
  stateBlob: posixNativeStateProtocol.stateBlob,
  lockOperation: 'LockFileEx/flags=3/reserved=0/offsetLow=0/offsetHigh=0/lengthLow=0/lengthHigh=4294967295',
  writeOperation: 'seek/truncate/write/sync on the same locking handle',
  releaseOperation: 'close the locking handle; OpenTofu Unlock is a no-op'
});

const nativeStateWriteAudit = Object.freeze({
  initialTruncation: false,
  inPlace: true,
  syncErrorsPropagated: false,
  backupIsSeparate: true,
  lockInfoFileIsAuthority: false,
  zeroExitProvesDurability: false
} as const);

const posixLockAudit = Object.freeze({
  evidence: 'source-audit-only',
  nativeQualification: 'required',
  protocol: posixNativeStateProtocol,
  locking: Object.freeze({
    family: 'posix-process-associated-record-lock',
    lockType: 'F_WRLCK',
    whence: 'SEEK_SET',
    start: 0,
    length: 0,
    coversFutureGrowth: true,
    closeAnySameInodeDescriptorReleases: true,
    inheritedAcrossFork: false,
    ofdLockIsEquivalent: false,
    flockIsEquivalent: false
  }),
  writing: nativeStateWriteAudit
} as const);

const windowsLockAudit = Object.freeze({
  evidence: 'source-audit-only',
  nativeQualification: 'required',
  protocol: windowsNativeStateProtocol,
  locking: Object.freeze({
    family: 'windows-exclusive-byte-range-lock',
    flags: 3,
    reserved: 0,
    offsetLow: 0,
    offsetHigh: 0,
    lengthLow: 0,
    lengthHigh: 0xffffffff,
    release: 'handle-close',
    ioUsesLockingHandle: true,
    inheritedHandleGrantsChildAccess: false,
    secondHandleGrantsOwnerAccess: false,
    constrainsMappedViews: false
  }),
  writing: nativeStateWriteAudit
} as const);

export function nativeStateLockSourceAudit(platform: NodeJS.Platform, architecture: string) {
  if (architecture !== 'x64' && architecture !== 'arm64') {
    throw new StateMigrationError('unqualified-combination');
  }
  if (platform === 'darwin' || platform === 'linux') return posixLockAudit;
  if (platform === 'win32') return windowsLockAudit;
  throw new StateMigrationError('unsupported-native-platform');
}
import { StateMigrationError } from './stateful.js';
