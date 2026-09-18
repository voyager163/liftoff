import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureStateExecutable, inspectLinuxLocalStateTools, inspectNativeLocalStateTools,
  nativeLocalStateProtocol, nativeStateHostId, runPrivateStateProcess
} from '../src/adapters/state/native-system.js';
import { linuxPosixStateLockProgram, posixStateLockProgram } from '../src/adapters/state/posix-lock-program.js';
import { DarwinPosixStateLockProvider, LinuxPosixStateLockProvider } from '../src/adapters/state/posix-native-lock.js';
import {
  isActualLinuxLocalQualification, isActualNativeLocalQualification,
  qualifyLinuxLocalState, qualifyNativeLocalState
} from '../src/adapters/state/local-qualification.js';
import { stopOwnedStateProcessesIn } from '../src/adapters/state/owned-process.js';
import { stateDigest, stateObjectDigest } from '../src/domain/repair/stateful-invariants.js';
import type { LinuxNativeLocalQualificationResult, NativeLocalQualificationResult } from '../src/domain/repair/stateful.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await stopOwnedStateProcessesIn(root);
    await rm(root, { recursive: true, force: true });
  }
});

async function scratch() {
  const root = path.join(await realpath(process.cwd()), 'tests', `.posix-state-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  roots.push(root);
  return root;
}

const hosts = [
  { platform: 'darwin', inspect: inspectNativeLocalStateTools, qualify: qualifyNativeLocalState, Provider: DarwinPosixStateLockProvider },
  { platform: 'linux', inspect: inspectLinuxLocalStateTools, qualify: qualifyLinuxLocalState, Provider: LinuxPosixStateLockProvider }
] as const;
const host = hosts.find((entry) => entry.platform === process.platform);
const hostTofuPlatform = `${process.platform}_${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
const historicalHelperDigest = '203c5f253fc9aada9b72f8a363c193d6b783060e330426fea2bcfba7c5569a5c';
const historicalProtocolDigest = 'bef6fcb34e93bd9029667de242273c653d95462da7da4ee75949ac127774a607';

describe('separate POSIX native host contracts', () => {
  it('preserves the historical Darwin helper bytes and qualification digest exactly', () => {
    expect(stateDigest(posixStateLockProgram)).toBe(historicalHelperDigest);
    expect(stateObjectDigest({ protocol: nativeLocalStateProtocol, helper: stateDigest(posixStateLockProgram) }))
      .toBe(historicalProtocolDigest);
    expect(linuxPosixStateLockProgram).toBe(posixStateLockProgram.replace('sys.platform != "darwin"', 'sys.platform != "linux"'));
    expect(stateDigest(linuxPosixStateLockProgram)).not.toBe(historicalHelperDigest);
    expect(stateObjectDigest({ protocol: nativeLocalStateProtocol, helper: stateDigest(linuxPosixStateLockProgram) }))
      .not.toBe(historicalProtocolDigest);
  });

  it.each([
    ['darwin', posixStateLockProgram],
    ['linux', linuxPosixStateLockProgram]
  ])('keeps %s locking on one fd using process-associated record locks and in-place writes', (platform, program) => {
    expect(program).toContain(`sys.platform != "${platform}"`);
    expect(program).toContain('sys.version_info[:2] != (3, 14)');
    expect(program).toContain('fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB, 0, 0, os.SEEK_SET)');
    expect(program.match(/os\.open\(target/g)).toHaveLength(1);
    expect(program).not.toMatch(/fcntl\.flock\(|F_OFD_SETLK|with open\(target|os\.rename\(|os\.replace\(/);
    expect(program).toContain('os.pread(fd');
    expect(program).toContain('os.pwrite(fd');
    expect(program).toContain('os.ftruncate(fd, 0)');
    expect(program).toContain('os.fsync(fd)');
    expect(program).toContain('version(observed) != command["expectedVersion"]');
    expect(program).toContain('(s.st_dev, s.st_ino) != (p.st_dev, p.st_ino)');
    expect(program).toContain('raise Blocked("unsupported-local-state-operation")');
  });

  it('refuses the other host before reading tools or creating qualification scratch', async () => {
    const root = await scratch();
    const nonexistent = path.join(root, 'must-not-be-created');
    for (const other of hosts.filter((entry) => entry.platform !== process.platform)) {
      await expect(other.inspect({ pythonPath: nonexistent, tofuPath: nonexistent, workingDirectory: nonexistent }))
        .rejects.toThrow('unsupported-native-platform');
      await expect(other.qualify({ pythonPath: nonexistent, tofuPath: nonexistent, scratchParent: nonexistent }))
        .rejects.toThrow('unsupported-native-platform');
      const provider = new other.Provider({ python: { path: nonexistent, sha256: '0'.repeat(64) } });
      await expect(provider.acquire({ path: nonexistent, expectedVersion: null, operationId: randomUUID() }))
        .rejects.toThrow('unsupported-native-platform');
    }
    await expect(readFile(nonexistent)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(hosts)('does not advertise absent creation or removal for $platform', ({ Provider }) => {
    expect(new Provider({ python: { path: process.execPath, sha256: '0'.repeat(64) } }).capabilities)
      .toEqual({ protocol: 'opentofu-1.12.6-posix-fcntl', existingInPlace: true, createAbsent: false, remove: false });
  });

  it.runIf(host !== undefined)('rejects absent creation without starting a native process on the real host', async () => {
    const root = await scratch(), absent = path.join(root, 'absent.tfstate');
    const provider = new host!.Provider({ python: { path: path.join(root, 'not-an-executable'), sha256: '0'.repeat(64) } });
    await expect(provider.acquire({ path: absent, expectedVersion: null, operationId: randomUUID() }))
      .rejects.toThrow('unsupported-local-state-operation');
    await expect(readFile(absent)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never accepts fabricated or serialized Linux qualification as either host authority', () => {
    const tools = {
      python: { path: process.execPath, sha256: 'a'.repeat(64) },
      tofu: { path: process.execPath, sha256: 'b'.repeat(64) },
      pythonVersion: '3.14.0', tofuVersion: '1.12.6' as const, hostId: nativeStateHostId()
    };
    const result: LinuxNativeLocalQualificationResult = Object.freeze({
      schemaVersion: 2, platform: 'linux', architecture: 'x64', kind: 'native-local-state-qualification', status: 'verified',
      hostRef: tools.hostId, tofuVersion: tools.tofuVersion, tofuBinaryDigest: tools.tofu.sha256,
      pythonBinaryDigest: tools.python.sha256, observedAt: Date.now(), checks: Object.freeze([]),
      sourceCommit: nativeLocalStateProtocol.sourceCommit,
      protocolDigest: stateObjectDigest({ protocol: nativeLocalStateProtocol, helper: stateDigest(linuxPosixStateLockProgram) }),
      stateScope: 'synthetic-disposable-only', azureLiveQualification: 'not-performed',
      encryptedCustodyQualification: 'not-performed', atomicStateReplacement: false
    });
    for (const candidate of [result, structuredClone(result), JSON.parse(JSON.stringify(result))]) {
      expect(isActualLinuxLocalQualification(candidate, tools)).toBe(false);
      expect(isActualNativeLocalQualification(candidate as unknown as NativeLocalQualificationResult, tools)).toBe(false);
    }
  });
});

describe.runIf(host !== undefined)('synthetic tool inspection on the actual POSIX host, not qualification', () => {
  async function toolsFixture(pythonInfo: object, tofuInfo: object) {
    const root = await scratch(), executable = await realpath(process.execPath);
    const pythonPath = path.join(root, 'python.mjs'), tofuPath = path.join(root, 'tofu.mjs');
    const script = (info: object, args: readonly string[]) => `#!${executable}
if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(args))}) process.exit(91);
process.stdout.write(${JSON.stringify(JSON.stringify(info))});
`;
    const python = script(pythonInfo, [
      '-I', '-S', '-B', '-c',
      'import json,platform,sys; print(json.dumps({"implementation":platform.python_implementation(),"version":".".join(map(str,sys.version_info[:3]))}))'
    ]);
    const tofu = script(tofuInfo, ['version', '-json']);
    await writeFile(pythonPath, python, { mode: 0o500 });
    await writeFile(tofuPath, tofu, { mode: 0o500 });
    return { request: { pythonPath, tofuPath, workingDirectory: root }, python, tofu };
  }

  it('binds exact executable bytes, versions and the real host without a platform override', async () => {
    const fixture = await toolsFixture(
      { implementation: 'CPython', version: '3.14.0' }, { terraform_version: '1.12.6', platform: hostTofuPlatform }
    );
    const tools = await host!.inspect(fixture.request);
    expect(tools).toEqual({
      python: { path: fixture.request.pythonPath, sha256: stateDigest(fixture.python) },
      tofu: { path: fixture.request.tofuPath, sha256: stateDigest(fixture.tofu) },
      pythonVersion: '3.14.0', tofuVersion: '1.12.6', hostId: nativeStateHostId()
    });
    expect(isActualNativeLocalQualification({} as NativeLocalQualificationResult, tools)).toBe(false);
    expect(isActualLinuxLocalQualification({} as LinuxNativeLocalQualificationResult, tools)).toBe(false);
  });

  it.each([
    [{ implementation: 'PyPy', version: '3.14.0' }, { terraform_version: '1.12.6', platform: hostTofuPlatform }, 'native-lock-provider-required'],
    [{ implementation: 'CPython', version: '3.13.9' }, { terraform_version: '1.12.6', platform: hostTofuPlatform }, 'native-lock-provider-required'],
    [{ implementation: 'CPython', version: '3.14.0' }, { terraform_version: '1.12.5', platform: hostTofuPlatform }, 'unqualified-combination'],
    [{ implementation: 'CPython', version: '3.14.0' }, { terraform_version: '1.12.6', platform: `${process.platform}_${process.arch === 'arm64' ? 'amd64' : 'arm64'}` }, 'unqualified-combination'],
    [{ implementation: 'CPython', version: '3.14.0' }, { terraform_version: '1.12.6', platform: `${process.platform === 'linux' ? 'darwin' : 'linux'}_${process.arch === 'arm64' ? 'arm64' : 'amd64'}` }, 'unqualified-combination']
  ])('refuses incompatible version or target metadata %#', async (pythonInfo, tofuInfo, code) => {
    const fixture = await toolsFixture(pythonInfo as object, tofuInfo as object);
    await expect(host!.inspect(fixture.request)).rejects.toThrow(String(code));
  });
});

describe('opt-in native POSIX lock qualification without encrypted storage or cloud access', () => {
  it.runIf(process.env.LIFTOFF_POSIX_NATIVE_LOCK_QUALIFICATION === '1')(
    'qualifies actual installed tools against synthetic builtin state on the current host',
    async () => {
      expect(host, 'Only native Darwin or Linux is admitted; no platform emulation is authorized.').toBeDefined();
      const pythonPath = process.env.LIFTOFF_STATE_PYTHON;
      const tofuPath = process.env.LIFTOFF_TOFU_EXECUTABLE;
      expect(pythonPath, 'Explicit absolute CPython 3.14 path required.').toBeTruthy();
      expect(tofuPath, 'Explicit absolute OpenTofu 1.12.6 path required.').toBeTruthy();
      const root = await scratch();
      const { tools, result } = await host!.qualify({ pythonPath: pythonPath!, tofuPath: tofuPath!, scratchParent: root });
      expect(await readdir(root)).toEqual([]);
      expect(result).toMatchObject({
        platform: process.platform, status: 'verified', stateScope: 'synthetic-disposable-only',
        azureLiveQualification: 'not-performed', atomicStateReplacement: false
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.checks)).toBe(true);
      expect(result.checks).toEqual(expect.arrayContaining([
        'exact-installed-tofu-1.12.6', 'registered-cpython-3.14', 'verified-pinned-fcntl-source',
        'acquisition-preserves-exact-pre-acquire-metadata', 'native-tofu-blocked-by-fcntl-holder',
        'observer-fd-close-preserves-holder-lock', 'fcntl-holder-blocked-by-native-tofu-console',
        'actual-native-module-address-move', 'same-lineage-and-resource-identity', 'actual-native-no-change-plan',
        'native-exclusion-survives-in-place-publication', 'inode-preserving-conditional-publication',
        'stale-publication-rejected', 'absent-destination-unsupported', 'unlink-retirement-unsupported',
        'uncoordinated-inode-replacement-detected', 'native-writer-can-lock-a-replaced-inode',
        'newer-native-write-preserved-after-lock-loss', 'native-pending-apply-can-lock-an-unlinked-path',
        'new-native-lock-metadata-preserved'
      ]));
      if (result.platform === 'linux') {
        expect(result).toMatchObject({ schemaVersion: 2, architecture: process.arch, encryptedCustodyQualification: 'not-performed' });
        expect(result.protocolDigest).toBe(stateObjectDigest({ protocol: nativeLocalStateProtocol, helper: stateDigest(linuxPosixStateLockProgram) }));
        expect(isActualLinuxLocalQualification(result, tools)).toBe(true);
        expect(isActualLinuxLocalQualification(structuredClone(result), tools)).toBe(false);
        expect(isActualLinuxLocalQualification(result, { ...tools, hostId: 'another-host' })).toBe(false);
        expect(isActualLinuxLocalQualification(result, { ...tools, tofu: { ...tools.tofu, sha256: '0'.repeat(64) } })).toBe(false);
        expect(isActualLinuxLocalQualification(result, { ...tools, python: { ...tools.python, sha256: '0'.repeat(64) } })).toBe(false);
        expect(isActualNativeLocalQualification(result as unknown as NativeLocalQualificationResult, tools)).toBe(false);
      } else {
        expect(result.schemaVersion).toBe(1);
        expect(result.protocolDigest).toBe(historicalProtocolDigest);
        expect(Object.keys(result).sort()).toEqual([
          'schemaVersion', 'kind', 'status', 'platform', 'hostRef', 'tofuVersion', 'tofuBinaryDigest',
          'pythonBinaryDigest', 'protocolDigest', 'sourceCommit', 'observedAt', 'checks',
          'stateScope', 'azureLiveQualification', 'atomicStateReplacement'
        ].sort());
        expect(isActualNativeLocalQualification(result, tools)).toBe(true);
        expect(isActualNativeLocalQualification(structuredClone(result), tools)).toBe(false);
        expect(isActualLinuxLocalQualification(result as unknown as LinuxNativeLocalQualificationResult, tools)).toBe(false);
      }
      const wrongHostProgram = process.platform === 'linux' ? posixStateLockProgram : linuxPosixStateLockProgram;
      const rejected = await runPrivateStateProcess({
        executable: await captureStateExecutable(pythonPath!), args: ['-I', '-S', '-B', '-u', '-c', wrongHostProgram], cwd: root
      });
      try {
        expect(rejected.exitCode).toBe(0);
        expect(JSON.parse(Buffer.from(rejected.stdout).toString())).toEqual({ ok: false, code: 'unsupported-native-platform' });
      } finally { rejected.stdout.fill(0); rejected.stderr.fill(0); }
      console.info(JSON.stringify(result));
    }
  );
});
