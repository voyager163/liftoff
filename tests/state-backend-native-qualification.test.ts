import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { qualifyNativeLocalState, isActualNativeLocalQualification } from '../src/adapters/state/local-qualification.js';
import { nativeLocalStateProtocol } from '../src/adapters/state/native-system.js';
import { posixStateLockProgram } from '../src/adapters/state/posix-lock-program.js';
import { PythonDarwinStateSystemBridge, observeDarwinStateVolume } from '../src/adapters/state/darwin-capabilities.js';

describe('pinned native locking qualification contract', () => {
  it('pins the actual upstream POSIX fcntl protocol rather than BSD flock or rename', () => {
    expect(nativeLocalStateProtocol.tofuVersion).toBe('1.12.6');
    expect(nativeLocalStateProtocol.sourceCommit).toBe('b4305e5a5dd2fb79a27897ae30784a181d3a26cb');
    expect(nativeLocalStateProtocol.lockOperation).toBe('F_SETLK/F_WRLCK/start=0/length=0');
    expect(posixStateLockProgram).toContain('fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB');
    expect(posixStateLockProgram).not.toContain('fcntl.flock(');
    expect(posixStateLockProgram).not.toContain('os.rename(');
    expect(posixStateLockProgram).not.toContain('os.replace(');
    expect(posixStateLockProgram).toContain('os.pread(fd');
    expect(posixStateLockProgram).toContain('os.pwrite(fd');
    expect(posixStateLockProgram.match(/os\.open\(target/g)).toHaveLength(1);
    expect(posixStateLockProgram).not.toContain('with open(target');
  });

  it.runIf(process.platform === 'darwin' && process.env.LIFTOFF_NATIVE_STATE_QUALIFICATION === '1')(
    'qualifies the actual installed pinned OpenTofu on disposable synthetic state, not Azure resources',
    async () => {
      const scratch = path.join(process.cwd(), '.cache', `state-native-lane-${process.pid}`);
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      try {
        const { tools, result } = await qualifyNativeLocalState({
          pythonPath: process.env.LIFTOFF_STATE_PYTHON ?? '/opt/homebrew/bin/python3',
          tofuPath: process.env.LIFTOFF_TOFU_EXECUTABLE ?? '/opt/homebrew/bin/tofu',
          scratchParent: scratch
        });
        expect(result.status).toBe('verified');
        expect(result.stateScope).toBe('synthetic-disposable-only');
        expect(result.azureLiveQualification).toBe('not-performed');
        expect(result.atomicStateReplacement).toBe(false);
        expect(result.checks).toEqual(expect.arrayContaining([
          'acquisition-preserves-exact-pre-acquire-metadata',
          'native-exclusion-survives-in-place-publication',
          'native-writer-can-lock-a-replaced-inode',
          'native-pending-apply-can-lock-an-unlinked-path',
          'new-native-lock-metadata-preserved'
        ]));
        expect(isActualNativeLocalQualification(result, tools)).toBe(true);
        expect(isActualNativeLocalQualification(structuredClone(result), tools)).toBe(false);
        console.info(JSON.stringify(result));
        const volume = await observeDarwinStateVolume(new PythonDarwinStateSystemBridge(tools.python, scratch), scratch);
        console.info(JSON.stringify({
          kind: 'observed-native-volume', filesystem: volume.filesystem, fileVault: volume.fileVault,
          encrypted: volume.encrypted, locked: volume.locked, ownerOnly: (volume.mode & 0o077) === 0 && volume.aclEntries === 0
        }));
      } finally { await rm(scratch, { recursive: true, force: true }); }
    },
    120_000
  );
});
