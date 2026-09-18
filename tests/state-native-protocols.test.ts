import { describe, expect, it } from 'vitest';
import {
  nativeStateLockSourceAudit, posixNativeStateProtocol, windowsNativeStateProtocol
} from '../src/domain/repair/native-state-protocols.js';
import { stateObjectDigest } from '../src/domain/repair/stateful-invariants.js';
import { nativeLocalStateProtocol } from '../src/adapters/state/native-system.js';

describe('registered native state protocol preservation', () => {
  it('retains the original macOS protocol tuple and canonical digest', () => {
    expect(nativeLocalStateProtocol).toBe(posixNativeStateProtocol);
    expect(Object.isFrozen(nativeLocalStateProtocol)).toBe(true);
    expect(stateObjectDigest(nativeLocalStateProtocol))
      .toBe('fa280a11fdddfacf4d868f6d3275fd2e04630496a1dc31aba5bc75f3a81fc640');
    expect(JSON.parse(JSON.stringify(nativeLocalStateProtocol))).toEqual({
      version: 'opentofu-1.12.6-posix-fcntl',
      tofuVersion: '1.12.6',
      sourceCommit: 'b4305e5a5dd2fb79a27897ae30784a181d3a26cb',
      lockSource: 'internal/flock/filesystem_lock_unix.go',
      lockBlob: 'c396e445a0eede26b32b97068216fe3691070d9f',
      stateSource: 'internal/states/statemgr/filesystem.go',
      stateBlob: '3f01209ea1635c9cad5f499f4f08ce356aef9a4c',
      lockOperation: 'F_SETLK/F_WRLCK/start=0/length=0',
      writeOperation: 'seek/truncate/write/sync on the same open inode'
    });
  });

  it.each(['x64', 'arm64'])('keeps the audited Windows %s byte range distinct from POSIX EOF locking', (architecture) => {
    const audit = nativeStateLockSourceAudit('win32', architecture);
    expect(audit.protocol).toBe(windowsNativeStateProtocol);
    expect(audit.locking).toMatchObject({
      family: 'windows-exclusive-byte-range-lock', flags: 3,
      offsetLow: 0, offsetHigh: 0, lengthLow: 0, lengthHigh: 0xffffffff,
      ioUsesLockingHandle: true, release: 'handle-close',
      inheritedHandleGrantsChildAccess: false, secondHandleGrantsOwnerAccess: false,
      constrainsMappedViews: false
    });
    expect(windowsNativeStateProtocol.lockBlob).toBe('676e1318c25b9d32aa50e86dc8edfcb204bab3f4');
    expect(windowsNativeStateProtocol.version).not.toBe(posixNativeStateProtocol.version);
    expect(stateObjectDigest(windowsNativeStateProtocol)).not.toBe(stateObjectDigest(posixNativeStateProtocol));
  });

  it.each(['darwin', 'linux'] as const)('records exact POSIX custody consequences for %s without claiming native qualification', (platform) => {
    for (const architecture of ['x64', 'arm64']) {
      const audit = nativeStateLockSourceAudit(platform, architecture);
      expect(audit.protocol).toBe(posixNativeStateProtocol);
      expect(audit.locking).toMatchObject({
        lockType: 'F_WRLCK', whence: 'SEEK_SET', start: 0, length: 0,
        coversFutureGrowth: true, closeAnySameInodeDescriptorReleases: true,
        inheritedAcrossFork: false, ofdLockIsEquivalent: false, flockIsEquivalent: false
      });
    }
  });

  it.each(['darwin', 'linux', 'win32'] as const)('does not promote source or tool success to durability/host proof on %s', (platform) => {
    const audit = nativeStateLockSourceAudit(platform, 'x64');
    expect(audit).toMatchObject({
      evidence: 'source-audit-only', nativeQualification: 'required',
      writing: {
        initialTruncation: false, inPlace: true, syncErrorsPropagated: false,
        backupIsSeparate: true, lockInfoFileIsAuthority: false, zeroExitProvesDurability: false
      }
    });
    expect(Object.isFrozen(audit)).toBe(true);
    expect(Object.isFrozen(audit.locking)).toBe(true);
    expect(Object.isFrozen(audit.writing)).toBe(true);
  });

  it('rejects unaudited platform and architecture combinations', () => {
    expect(() => nativeStateLockSourceAudit('aix', 'x64')).toThrow('unsupported-native-platform');
    for (const architecture of ['ia32', 'arm', 'x86', '', 'future']) {
      expect(() => nativeStateLockSourceAudit('linux', architecture)).toThrow('unqualified-combination');
    }
  });
});
