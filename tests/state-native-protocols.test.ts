import { describe, expect, it } from 'vitest';
import { posixNativeStateProtocol } from '../src/domain/repair/native-state-protocols.js';
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
});
