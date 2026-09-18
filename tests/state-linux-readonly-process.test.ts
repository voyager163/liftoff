import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LinuxReadonlyProcessGuard, linuxReadonlyProcessContract, type LinuxReadonlyProcessRequest
} from '../src/adapters/state/linux-readonly-process.js';
import { linuxReadonlyProcessProgram } from '../src/adapters/state/linux-readonly-process-program.js';
import { captureStateExecutable, runPrivateStateProcess } from '../src/adapters/state/native-system.js';
import { OwnedPrivateStateProcessRunner } from '../src/adapters/state/owned-process.js';
import { stateDigest } from '../src/domain/repair/stateful-invariants.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function unusedRequest(): LinuxReadonlyProcessRequest {
  const missing = path.join(process.cwd(), 'tests', `.readonly-must-not-exist-${randomUUID()}`);
  return {
    python: { path: missing, sha256: '0'.repeat(64) }, executable: { path: missing, sha256: '0'.repeat(64) },
    args: [], scopeDirectory: missing, storeDirectory: path.join(missing, 'store'),
    writableDirectories: { control: path.join(missing, 'control'), runtime: path.join(missing, 'runtime'), scratch: path.join(missing, 'scratch') },
    timeoutMs: 5000, maximumBytes: 16_384
  };
}

describe('Linux read-only process source contract, not keystore admission', () => {
  it('requires ABI 3 with every filesystem mutation handled and only private leaves granted', () => {
    expect(linuxReadonlyProcessContract).toMatchObject({
      minimumAbi: 3, scope: 'newly-opened-files-and-directory-entries',
      metadataImmutability: false, networkIsolation: false, externalWriterExclusion: false, encryptedCustody: false
    });
    expect(linuxReadonlyProcessContract.helperDigest).toBe(stateDigest(linuxReadonlyProcessProgram));
    expect(linuxReadonlyProcessProgram).toContain('require(abi >= 3');
    expect(linuxReadonlyProcessProgram).toContain('WRITE_FILE | REMOVE_DIR | REMOVE_FILE | MAKE_CHAR | MAKE_DIR | MAKE_REG | MAKE_SOCK | MAKE_FIFO | MAKE_BLOCK | MAKE_SYM | REFER | TRUNCATE');
    expect(linuxReadonlyProcessProgram).toContain('PathBeneath(allowed, fd)');
    expect(linuxReadonlyProcessProgram).toContain('allowed = handled & ~(MAKE_CHAR | MAKE_BLOCK | REFER)');
    expect(linuxReadonlyProcessProgram).toContain('libc.prctl(38, 1, 0, 0, 0)');
    expect(linuxReadonlyProcessProgram).toContain('libc.syscall(ctypes.c_long(446)');
    expect(linuxReadonlyProcessProgram).not.toContain('chmod(');
    expect(linuxReadonlyProcessProgram).not.toContain('setuid(');
  });

  it('pins directory and executable FDs, closes inherited handles and never consumes private stdin', () => {
    expect(linuxReadonlyProcessProgram).toContain('os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC');
    expect(linuxReadonlyProcessProgram).toContain('os.closerange(3, maximum_fd)');
    expect(linuxReadonlyProcessProgram).toContain('require(not os.listdir(readable), "unsafe-path")');
    expect(linuxReadonlyProcessProgram).toContain('identity(observed) == item["identity"]');
    expect(linuxReadonlyProcessProgram).toContain('mount_id(fd) for fd in [scope_fd, store_fd] + writable_fds');
    expect(linuxReadonlyProcessProgram).toContain('os.execve(target_fd');
    expect(linuxReadonlyProcessProgram).toContain('len(os.listdir("/proc/self/task")) == 1');
    expect(linuxReadonlyProcessProgram).not.toMatch(/sys\.stdin|input\(|os\.read\(0|readline\(|print\(/);
    const restriction = linuxReadonlyProcessProgram.indexOf('libc.syscall(ctypes.c_long(446)');
    expect(linuxReadonlyProcessProgram.indexOf('for fd in retained:', restriction)).toBeGreaterThan(restriction);
    expect(linuxReadonlyProcessProgram.indexOf('os.execve(target_fd')).toBeGreaterThan(restriction);
  });

  it.runIf(process.platform !== 'linux')('refuses other native hosts without observing paths or forwarding input', async () => {
    const guard = new LinuxReadonlyProcessGuard(), request = unusedRequest();
    request.stdin = Buffer.from('NONSECRET_REFUSAL_FIXTURE');
    await expect(guard.run(request)).rejects.toMatchObject({ code: 'unsupported-native-platform' });
    await expect(lstat(request.scopeDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(Buffer.from(request.stdin).toString()).toBe('NONSECRET_REFUSAL_FIXTURE');
    await guard.quiesce();
  });
});

const native = process.env.LIFTOFF_LINUX_READONLY_PROCESS_TEST === '1';

describe.runIf(native)('opt-in Linux Landlock nonsecret fixtures', () => {
  async function fixture() {
    expect(process.platform, 'This opt-in requires a real Linux host, not emulation.').toBe('linux');
    expect(process.env.LIFTOFF_STATE_PYTHON, 'Explicit absolute registered CPython 3.14 path required.').toBeTruthy();
    const python = await captureStateExecutable(process.env.LIFTOFF_STATE_PYTHON!);
    const scope = path.join(await realpath(process.cwd()), 'tests', `.linux-readonly-${randomUUID()}`);
    await mkdir(scope, { mode: 0o700 });
    cleanups.push(() => rm(scope, { recursive: true, force: true }));
    const guard = new LinuxReadonlyProcessGuard();
    cleanups.push(() => guard.quiesce());
    const store = path.join(scope, 'store'), outside = path.join(scope, 'outside');
    const writable = { control: path.join(scope, 'control'), runtime: path.join(scope, 'runtime'), scratch: path.join(scope, 'scratch') };
    for (const directory of [store, outside, ...Object.values(writable)]) await mkdir(directory, { mode: 0o700 });
    const original = 'NONSECRET_PERSISTED_GENERATION\n', filename = path.join(store, 'persisted');
    await writeFile(filename, original, { mode: 0o600 });
    await mkdir(path.join(store, 'existing-directory'), { mode: 0o700 });
    const request: LinuxReadonlyProcessRequest = {
      python, executable: python, args: [], scopeDirectory: scope, storeDirectory: store, writableDirectories: writable,
      timeoutMs: 5000, maximumBytes: 16_384
    };
    const run = (program: string, change: Partial<LinuxReadonlyProcessRequest> = {}) => guard.run({
      ...request, args: ['-I', '-S', '-B', '-c', program, store, writable.control, writable.runtime, writable.scratch, outside], ...change
    });
    return { guard, scope, store, outside, writable, request, run, filename, original };
  }

  it('denies content/entry mutations, preserves the original generation and passes only private stdin', async () => {
    const f = await fixture();
    const input = Buffer.from('NONSECRET_STDIN_ONLY');
    const result = await f.run(String.raw`
import errno, json, os, sys
store, control, runtime, scratch, outside = sys.argv[1:]
original = os.path.join(store, "persisted")
def denied(action, errors=(errno.EACCES, errno.EPERM, errno.EXDEV)):
    try:
        action()
    except OSError as error:
        assert error.errno in errors, error.errno
        return
    raise RuntimeError("write unexpectedly admitted")
with open(original, "rb") as stream:
    assert stream.read() == b"NONSECRET_PERSISTED_GENERATION\n"
denied(lambda: os.open(original, os.O_WRONLY))
denied(lambda: os.open(original, os.O_RDWR))
denied(lambda: os.open(original, os.O_RDONLY | os.O_TRUNC))
denied(lambda: os.truncate(original, 0))
read_only = os.open(original, os.O_RDONLY)
try:
    denied(lambda: os.ftruncate(read_only, 0), (errno.EACCES, errno.EPERM, errno.EINVAL, errno.EBADF))
finally:
    os.close(read_only)
denied(lambda: os.open(os.path.join(store, "login.keyring"), os.O_WRONLY | os.O_CREAT, 0o600))
denied(lambda: os.mkdir(os.path.join(store, "new-directory"), 0o700))
denied(lambda: os.unlink(original))
denied(lambda: os.rmdir(os.path.join(store, "existing-directory")))
denied(lambda: os.rename(original, os.path.join(store, "renamed")))
denied(lambda: os.rename(original, os.path.join(runtime, "moved")))
denied(lambda: os.link(original, os.path.join(runtime, "hardlink")))
denied(lambda: os.symlink(original, os.path.join(store, "alias")))
denied(lambda: os.open(os.path.join(outside, "escape"), os.O_CREAT | os.O_WRONLY, 0o600))
denied(lambda: os.open(os.path.join(os.path.dirname(store), "escape"), os.O_CREAT | os.O_WRONLY, 0o600))
for directory in (control, runtime, scratch):
    filename = os.path.join(directory, "allowed")
    with open(filename, "wb") as stream:
        stream.write(b"owned-runtime")
    os.truncate(filename, 3)
    os.rename(filename, filename + ".renamed")
    os.unlink(filename + ".renamed")
alias = os.path.join(runtime, "outside-alias")
os.symlink(original, alias)
denied(lambda: os.open(alias, os.O_WRONLY))
os.unlink(alias)
assert sys.stdin.buffer.read() == b"NONSECRET_STDIN_ONLY"
assert not any("NONSECRET_STDIN_ONLY" in item for item in sys.argv)
assert not any("NONSECRET_STDIN_ONLY" in item for item in os.environ.values())
assert all(os.environ[name] == scratch for name in ("HOME", "TMPDIR", "TMP", "TEMP"))
assert os.environ["XDG_RUNTIME_DIR"] == runtime
assert "DBUS_SESSION_BUS_ADDRESS" not in os.environ
with open("/proc/self/status") as stream:
    assert "NoNewPrivs:\t1\n" in stream.read()
print(json.dumps({"denied": True, "runtime": True, "stdin": True}))
`, { stdin: input });
    try { expect(JSON.parse(Buffer.from(result.stdout).toString())).toEqual({ denied: true, runtime: true, stdin: true }); }
    finally { result.stdout.fill(0); input.fill(0); }
    expect(await readFile(f.filename, 'utf8')).toBe(f.original);
    expect((await readdir(f.store)).sort()).toEqual(['existing-directory', 'persisted']);
    expect(await readdir(f.outside)).toEqual([]);
  });

  it.each(['store-as-runtime', 'runtime-above-store', 'runtime-below-store', 'root', 'symlink', 'not-empty'] as const)(
    'refuses unsafe writable roots: %s', async (fault) => {
      const f = await fixture(), writable = { ...f.writable };
      if (fault === 'store-as-runtime') writable.runtime = f.store;
      if (fault === 'runtime-above-store') writable.runtime = f.scope;
      if (fault === 'runtime-below-store') writable.runtime = path.join(f.store, 'existing-directory');
      if (fault === 'root') writable.runtime = path.parse(f.scope).root;
      if (fault === 'symlink') {
        const alias = path.join(f.scope, 'alias');
        await symlink(f.writable.runtime, alias);
        writable.runtime = alias;
      }
      if (fault === 'not-empty') await writeFile(path.join(writable.runtime, 'foreign'), 'NONSECRET', { mode: 0o600 });
      await expect(f.run('raise RuntimeError("must not execute")', { writableDirectories: writable }))
        .rejects.toMatchObject({ code: 'unsafe-path' });
      expect(await readFile(f.filename, 'utf8')).toBe(f.original);
    }
  );

  it('refuses directory replacement between parent observation and helper enforcement', async () => {
    const f = await fixture();
    const run = OwnedPrivateStateProcessRunner.prototype.run;
    vi.spyOn(OwnedPrivateStateProcessRunner.prototype, 'run').mockImplementationOnce(async function (request) {
      await rename(f.writable.runtime, path.join(f.scope, 'retained-runtime'));
      await mkdir(f.writable.runtime, { mode: 0o700 });
      return run.call(this, request);
    });
    await expect(f.run('raise RuntimeError("must not execute")')).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(await readFile(f.filename, 'utf8')).toBe(f.original);
  });

  it('inherits denial in a descendant and cancels the owned process group without later writes', async () => {
    const f = await fixture(), controller = new AbortController();
    const running = f.run(String.raw`
import errno, os, signal, sys, time
store, control, runtime, scratch, outside = sys.argv[1:]
child = os.fork()
if child == 0:
    try:
        os.open(os.path.join(store, "descendant-write"), os.O_WRONLY | os.O_CREAT, 0o600)
    except OSError as error:
        assert error.errno in (errno.EACCES, errno.EPERM)
    else:
        os._exit(91)
    with open(os.path.join(runtime, "child-ready"), "w") as stream:
        stream.write(str(os.getpid()))
    time.sleep(2)
    with open(os.path.join(runtime, "late-write"), "w") as stream:
        stream.write("must never happen")
    os._exit(0)
def stopped(_signal, _frame):
    os.waitpid(child, 0)
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stopped)
with open(os.path.join(runtime, "parent-ready"), "w") as stream:
    stream.write(str(os.getpid()))
time.sleep(20)
`, { signal: controller.signal });
    // Attach immediately so cancellation cannot produce an unhandled rejection.
    const outcome = running.then(() => null, (error: unknown) => error);
    let pids: number[] = [];
    try {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const content = await Promise.all(['parent-ready', 'child-ready'].map((name) =>
          readFile(path.join(f.writable.runtime, name), 'utf8').catch(() => '')));
        if (content.every(Boolean)) { pids = content.map(Number); break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(pids).toHaveLength(2);
    } finally { controller.abort(); }
    expect(await outcome).toMatchObject({ code: 'cancelled' });
    await f.guard.quiesce();
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    await expect(readFile(path.join(f.writable.runtime, 'late-write'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(f.store, 'descendant-write'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(f.filename, 'utf8')).toBe(f.original);
  });

  it('withholds raw target diagnostics and rejects pre-aborted work', async () => {
    const f = await fixture();
    await expect(f.run('import sys; sys.stderr.write("PROTECTED_DIAGNOSTIC"); sys.exit(1)'))
      .rejects.toMatchObject({ code: 'native-command-failed', message: 'Protected state operation blocked: native-command-failed.' });
    const aborted = await fixture(), controller = new AbortController();
    controller.abort();
    await expect(aborted.run('raise RuntimeError("must not execute")', { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'cancelled' });
  });
});

it.runIf(process.env.LIFTOFF_READONLY_HELPER_SOURCE_TEST === '1')(
  'compiles the helper with registered CPython and refuses non-Linux without kernel emulation',
  async () => {
    expect(process.env.LIFTOFF_STATE_PYTHON).toBeTruthy();
    const python = await captureStateExecutable(process.env.LIFTOFF_STATE_PYTHON!);
    const cwd = await realpath(process.cwd());
    const syntax = await runPrivateStateProcess({
      executable: python, cwd, args: ['-I', '-S', '-B', '-c', 'import sys; compile(sys.argv[1], "<guard>", "exec")', linuxReadonlyProcessProgram]
    });
    try { expect(syntax.exitCode).toBe(0); } finally { syntax.stdout.fill(0); syntax.stderr.fill(0); }
    if (process.platform !== 'linux') {
      const result = await runPrivateStateProcess({
        executable: python, cwd, args: ['-I', '-S', '-B', '-c', linuxReadonlyProcessProgram, '{}']
      });
      try {
        expect(result.exitCode).toBe(125);
        expect(Buffer.from(result.stderr).toString()).toBe('liftoff-readonly:unsupported-native-platform\n');
        expect(result.stdout).toHaveLength(0);
      } finally { result.stdout.fill(0); result.stderr.fill(0); }
    }
  }
);
