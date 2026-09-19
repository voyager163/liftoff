import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LinuxReadonlyNullProcessGuard, LinuxReadonlyProcessGuard, linuxReadonlyNullProcessContract,
  linuxReadonlyProcessContract, type LinuxReadonlyNullProcessRequest
} from '../src/adapters/state/linux-readonly-process.js';
import {
  linuxReadonlyNullProcessProgram, linuxReadonlyProcessProgram
} from '../src/adapters/state/linux-readonly-process-program.js';
import {
  createLinuxReadonlyNullProcessPlan, parseLinuxNullDeviceObservation, parseLinuxReadonlyNullProcessPlan,
  type LinuxNullDeviceObservation
} from '../src/domain/repair/linux-null-process.js';
import { captureStateExecutable } from '../src/adapters/state/native-system.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { stateDigest } from '../src/domain/repair/stateful-invariants.js';

const originalDigest = 'bb3a9080ca1c0d50113dc2f5cb0a379ae3c33d210a47411d1f0b55e2641475f2';
const observation = (): LinuxNullDeviceObservation => ({
  path: '/dev/null', kind: 'character-device', device: '5', inode: '6', ctime: '123',
  uid: 0, gid: 0, mode: 0o666, rdev: '259', major: 1, minor: 3
});
const planInput = () => ({
  helperDigest: linuxReadonlyNullProcessContract.helperDigest, hostId: `native-host:${'a'.repeat(64)}`,
  principalUid: 1000, operationDigest: 'b'.repeat(64), requestDigest: 'c'.repeat(64), nullDevice: observation()
});

describe('explicit Linux null-sink profile source contracts', () => {
  it('preserves the original helper bytes and registers an independently bound additional sink', () => {
    expect(stateDigest(linuxReadonlyProcessProgram)).toBe(originalDigest);
    expect(linuxReadonlyProcessContract.helperDigest).toBe(originalDigest);
    expect(linuxReadonlyProcessContract.kind).toBe('linux-landlock-readonly-process/1');
    expect(linuxReadonlyProcessProgram).not.toContain('observe_null_device');
    expect(linuxReadonlyProcessContract).not.toHaveProperty('additionalSink');
    expect(linuxReadonlyNullProcessContract).toMatchObject({
      kind: 'linux-landlock-readonly-process-null-sink/1', minimumAbi: 3,
      helperDigest: stateDigest(linuxReadonlyNullProcessProgram),
      additionalSink: { path: '/dev/null', kind: 'character-device', uid: 0, major: 1, minor: 3, rights: 'WRITE_FILE' },
      encryptedCustody: false, metadataImmutability: false, networkIsolation: false
    });
    expect(linuxReadonlyNullProcessContract.helperDigest).not.toBe(originalDigest);
    expect(Object.isFrozen(linuxReadonlyNullProcessContract.additionalSink)).toBe(true);
  });

  it('adds one fixed object rule, no device directory or writable descriptor bypass', () => {
    const program = linuxReadonlyNullProcessProgram;
    expect(program).toContain('os.open("null", os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)');
    expect(program).toContain('stat.S_ISCHR(s.st_mode) and s.st_uid == 0');
    expect(program).toContain('os.major(s.st_rdev) == 1 and os.minor(s.st_rdev) == 3');
    expect(program).toContain('null_rule = PathBeneath(WRITE_FILE, null_fd)');
    expect(program).not.toContain('PathBeneath(WRITE_FILE, parent)');
    expect(program).not.toContain('os.O_RDWR');
    expect(program).not.toMatch(/chmod\(|mknod\(|mount\(|sys\.stdin|os\.read\(0/);
    expect(program.match(/observe_null_device\(null_observation\)/gu)).toHaveLength(2);
    expect(program.indexOf('for fd in retained:', program.indexOf('libc.syscall(ctypes.c_long(446)')))
      .toBeLessThan(program.indexOf('os.execve(target_fd'));
  });

  it('binds exact nonsecret operation and device metadata without minting approval', () => {
    const input = planInput();
    const plan = createLinuxReadonlyNullProcessPlan(input);
    expect(parseLinuxReadonlyNullProcessPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(plan).toMatchObject({ execution: 'not-authorized', readiness: false });
    expect(Object.isFrozen(plan.nullDevice)).toBe(true);
    for (const changed of [
      { helperDigest: 'd'.repeat(64) }, { hostId: `native-host:${'d'.repeat(64)}` }, { principalUid: 1001 },
      { operationDigest: 'd'.repeat(64) }, { requestDigest: 'd'.repeat(64) },
      { nullDevice: { ...input.nullDevice, inode: '7' } }
    ]) {
      expect(createLinuxReadonlyNullProcessPlan({ ...input, ...changed }).fingerprint).not.toBe(plan.fingerprint);
      expect(() => parseLinuxReadonlyNullProcessPlan({ ...plan, ...changed })).toThrow('invalid-binding');
    }
  });

  it.each([
    null, {}, { path: '/tmp/null' }, { kind: 'regular-file' }, { uid: 1000 }, { major: 2 }, { minor: 5 },
    { rdev: '260' }, { gid: -1 }, { gid: 0x100000000 }, { mode: 0o10000 }, { mode: 1.5 },
    { device: '05' }, { inode: '-1' }, { ctime: 123 }, { secret: 'PRIVATE_INPUT' }
  ])('rejects unregistered device observations %#', (changed) => {
    const input = changed === null ? null : { ...observation(), ...changed };
    if (changed && Object.keys(changed).length === 0) {
      expect(() => parseLinuxNullDeviceObservation(changed)).toThrow('invalid-binding');
    } else expect(() => parseLinuxNullDeviceObservation(input)).toThrow('invalid-binding');
  });

  it.each([
    { schemaVersion: 2 }, { profile: 'linux-landlock-readonly-process/1' }, { kind: 'other' },
    { execution: 'authorized' }, { readiness: true }, { helperDigest: 'bad' }, { hostId: null },
    { principalUid: 0 }, { fingerprint: '0'.repeat(64) }, { devicePath: '/dev/zero' }
  ])('refuses implicit profile promotion or forged authority %#', (change) => {
    const plan = createLinuxReadonlyNullProcessPlan(planInput());
    expect(() => parseLinuxReadonlyNullProcessPlan({ ...plan, ...change })).toThrow('invalid-binding');
  });

  if (process.platform !== 'linux') {
    it('refuses other hosts without inspecting a device or receiving private input', async () => {
      const guard = new LinuxReadonlyNullProcessGuard();
      const request: LinuxReadonlyNullProcessRequest = {
        python: { path: '/not-inspected/python', sha256: '0'.repeat(64) },
        executable: { path: '/not-inspected/target', sha256: '0'.repeat(64) }, args: [],
        scopeDirectory: '/not-inspected', storeDirectory: '/not-inspected/store',
        writableDirectories: { control: '/not-inspected/control', runtime: '/not-inspected/runtime', scratch: '/not-inspected/scratch' },
        operationDigest: '0'.repeat(64), timeoutMs: 5000, maximumBytes: 4096, stdin: Buffer.from('PRIVATE_INPUT')
      };
      await expect(guard.plan(request)).rejects.toMatchObject({ code: 'unsupported-native-platform' });
      await expect(guard.run(request, createLinuxReadonlyNullProcessPlan(planInput())))
        .rejects.toMatchObject({ code: 'unsupported-native-platform' });
      expect(Buffer.from(request.stdin!).toString()).toBe('PRIVATE_INPUT');
      await guard.quiesce();
    });
  }
});

if (process.env.LIFTOFF_LINUX_READONLY_NULL_TEST === '1') {
  describe('opt-in Linux null-sink profile nonsecret fixtures', () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture(program: string) {
      expect(process.platform).toBe('linux');
      expect(process.env.LIFTOFF_STATE_PYTHON).toBeTruthy();
      const python = await captureStateExecutable(process.env.LIFTOFF_STATE_PYTHON!);
      const root = await mkdtemp(path.join(await realpath(process.cwd()), 'tests/.null-guard-'));
      const store = path.join(root, 'store');
      const writable = { control: path.join(root, 'control'), runtime: path.join(root, 'runtime'), scratch: path.join(root, 'scratch') };
      for (const directory of [store, ...Object.values(writable)]) await mkdir(directory, { mode: 0o700 });
      const filename = path.join(store, 'persisted');
      await writeFile(filename, 'UNCHANGED_GENERATION', { mode: 0o600 });
      const guard = new LinuxReadonlyNullProcessGuard();
      const strict = new LinuxReadonlyProcessGuard();
      cleanups.push(async () => {
        await guard.quiesce();
        await strict.quiesce();
        await rm(root, { recursive: true });
      });
      const request: LinuxReadonlyNullProcessRequest = {
        python, executable: python, args: ['-I', '-S', '-B', '-c', program, store, writable.runtime],
        scopeDirectory: root, storeDirectory: store, writableDirectories: writable,
        timeoutMs: 5000, maximumBytes: 16_384, operationDigest: canonicalSha256({ kind: 'nonsecret-null-profile-fixture', program })
      };
      const plan = await guard.plan(request);
      expect(plan).toMatchObject({
        profile: linuxReadonlyNullProcessContract.kind, helperDigest: linuxReadonlyNullProcessContract.helperDigest,
        nullDevice: { path: '/dev/null', kind: 'character-device', major: 1, minor: 3, uid: 0 },
        execution: 'not-authorized', readiness: false
      });
      return { guard, strict, request, plan, filename, root, writable };
    }

    it('opens only the fixed sink while preserving store, other-device and inherited-handle boundaries', async () => {
      const f = await fixture(String.raw`
import errno, json, os, sys
store, runtime = sys.argv[1:]
assert all("/dev/null" != os.readlink("/proc/self/fd/" + str(fd)) for fd in (0, 1, 2))
fd = os.open("/dev/null", os.O_RDWR)
assert os.write(fd, b"NONSECRET_DISCARDED") == 19
assert os.read(fd, 1) == b""
os.close(fd)
def denied(action):
    try:
        action()
    except OSError as error:
        assert error.errno in (errno.EACCES, errno.EPERM, errno.EXDEV), error.errno
        return
    raise RuntimeError("write unexpectedly admitted")
original = os.path.join(store, "persisted")
denied(lambda: os.open(original, os.O_RDWR))
denied(lambda: os.open(original, os.O_RDONLY | os.O_TRUNC))
denied(lambda: os.truncate(original, 0))
denied(lambda: os.unlink(original))
denied(lambda: os.open(os.path.join(store, "new"), os.O_CREAT | os.O_WRONLY, 0o600))
denied(lambda: os.open("/dev/zero", os.O_WRONLY))
denied(lambda: os.open(os.path.join(os.path.dirname(store), "escape"), os.O_CREAT | os.O_WRONLY, 0o600))
with open(original, "r") as stream:
    assert stream.read() == "UNCHANGED_GENERATION"
assert sys.stdin.buffer.read() == b"NONSECRET_PRIVATE_INPUT"
print(json.dumps({"nullOpened": True, "storeDenied": True, "otherDeviceDenied": True}))
`);
      f.request.stdin = Buffer.from('NONSECRET_PRIVATE_INPUT');
      expect(JSON.stringify(f.plan)).not.toContain('NONSECRET_PRIVATE_INPUT');
      const result = await f.guard.run(f.request, f.plan);
      try {
        expect(JSON.parse(Buffer.from(result.stdout).toString())).toEqual({
          nullOpened: true, storeDenied: true, otherDeviceDenied: true
        });
      } finally { result.stdout.fill(0); f.request.stdin.fill(0); }
      expect(await readFile(f.filename, 'utf8')).toBe('UNCHANGED_GENERATION');
    });

    it('keeps the original strict profile refusing the same device without automatic promotion', async () => {
      const f = await fixture(String.raw`
import errno, os
try:
    os.open("/dev/null", os.O_RDWR)
except OSError as error:
    assert error.errno in (errno.EACCES, errno.EPERM)
else:
    raise RuntimeError("strict profile widened")
print("strict-denial")
`);
      const { operationDigest: _operation, ...request } = f.request;
      const result = await f.strict.run(request);
      try { expect(Buffer.from(result.stdout).toString().trim()).toBe('strict-denial'); }
      finally { result.stdout.fill(0); }
    });

    it.each(['inode', 'ctime', 'mode'] as const)('refuses a changed %s observation before target execution', async (field) => {
      const f = await fixture('raise RuntimeError("must not execute")');
      const device = { ...f.plan.nullDevice };
      if (field === 'mode') device.mode ^= 0o001;
      else device[field] = String(BigInt(device[field]) + 1n);
      const changed = createLinuxReadonlyNullProcessPlan({
        helperDigest: f.plan.helperDigest, hostId: f.plan.hostId, principalUid: f.plan.principalUid,
        operationDigest: f.plan.operationDigest, requestDigest: f.plan.requestDigest, nullDevice: device
      });
      await expect(f.guard.run(f.request, changed)).rejects.toMatchObject({ code: 'unsafe-path' });
      expect(await readFile(f.filename, 'utf8')).toBe('UNCHANGED_GENERATION');
    });

    it('rejects changed operation, command, bounds, helper and directory identities', async () => {
      const f = await fixture('raise RuntimeError("must not execute")');
      for (const change of [
        { operationDigest: 'f'.repeat(64) }, { args: [...f.request.args, 'changed'] },
        { maximumBytes: f.request.maximumBytes + 1 }
      ]) await expect(f.guard.run({ ...f.request, ...change }, f.plan)).rejects.toMatchObject({ code: 'invalid-binding' });
      const wrongHelper = createLinuxReadonlyNullProcessPlan({ ...planInput(),
        hostId: f.plan.hostId, principalUid: f.plan.principalUid, operationDigest: f.plan.operationDigest,
        requestDigest: f.plan.requestDigest, nullDevice: f.plan.nullDevice, helperDigest: originalDigest });
      await expect(f.guard.run(f.request, wrongHelper)).rejects.toMatchObject({ code: 'invalid-binding' });
      await writeFile(path.join(f.writable.runtime, 'occupied'), 'NONSECRET', { mode: 0o600 });
      await expect(f.guard.run(f.request, f.plan)).rejects.toMatchObject({ code: 'unsafe-path' });
    });

    it('inherits the sink and denial in descendants and settles cancellation before cleanup', async () => {
      const f = await fixture(String.raw`
import errno, os, signal, sys, time
store, runtime = sys.argv[1:]
child = os.fork()
if child == 0:
    fd = os.open("/dev/null", os.O_RDWR)
    os.write(fd, b"NONSECRET")
    os.close(fd)
    try:
        os.open(os.path.join(store, "child-write"), os.O_CREAT | os.O_WRONLY, 0o600)
    except OSError as error:
        assert error.errno in (errno.EACCES, errno.EPERM)
    else:
        os._exit(91)
    with open(os.path.join(runtime, "child-ready"), "w") as stream:
        stream.write(str(os.getpid()))
    time.sleep(3)
    with open(os.path.join(runtime, "late-write"), "w") as stream:
        stream.write("must not happen")
    os._exit(0)
def stopped(_signal, _frame):
    os.waitpid(child, 0)
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stopped)
with open(os.path.join(runtime, "parent-ready"), "w") as stream:
    stream.write(str(os.getpid()))
time.sleep(20)
`);
      const controller = new AbortController();
      const running = f.guard.run({ ...f.request, signal: controller.signal }, f.plan)
        .then((result) => { result.stdout.fill(0); return null; }, (error: unknown) => error);
      const pids: number[] = [];
      try {
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
          const observed = await Promise.all(['parent-ready', 'child-ready'].map(async (name) => {
            try { return await readFile(path.join(f.writable.runtime, name), 'utf8'); }
            catch (error) {
              if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
              throw error;
            }
          }));
          if (observed.every((value) => value !== null)) { pids.push(...observed.map(Number)); break; }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(pids).toHaveLength(2);
      } finally { controller.abort(); }
      expect(await running).toMatchObject({ code: 'cancelled' });
      await f.guard.quiesce();
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      await expect(readFile(path.join(f.writable.runtime, 'late-write'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(path.join(f.request.storeDirectory, 'child-write'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(f.filename, 'utf8')).toBe('UNCHANGED_GENERATION');
    });
  });
}
