import { chmod, mkdir, readFile, lstat, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GnomePersistenceFixture, gnomeEnrollmentFailureObservation, assertGnomeCancellation
} from '../native/linux-keystore-client/gnome-persistence-fixture.js';
import {
  consumeBusStartupDiagnostic, safeBusDiagnostic
} from '../native/linux-keystore-client/gnome-bus-diagnostics.mjs';
import { validateGnomePrivatePrefixOptions } from '../native/linux-keystore-client/gnome-build-contract.mjs';
import { captureStateExecutable } from '../src/adapters/state/native-system.js';
import { stateDigest } from '../src/domain/repair/stateful-invariants.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  linuxReadonlyNullProcessContract, type LinuxReadonlyNullProcessRequest, type LinuxReadonlyNullProcessPlan
} from '../src/adapters/state/linux-readonly-process.js';
import { runGnomeNullRestart } from '../native/linux-keystore-client/gnome-restart-guard.js';

const directory = path.resolve('native', 'linux-keystore-client');
const coordinator = await readFile(path.join(directory, 'gnome-coordinator.mjs'), 'utf8');
const fixtureSource = await readFile(path.join(directory, 'gnome-persistence-fixture.ts'), 'utf8');
const enrollmentLauncher = await readFile(path.join(directory, 'gnome-enrollment-launch.py'), 'utf8');
const declaration = JSON.parse(await readFile(path.join(directory, 'gnome-dependencies.json'), 'utf8'));

describe('actual GNOME persistence fixture source boundaries', () => {
  it('does not reinterpret startup failure as a successful cancellation', () => {
    expect(() => assertGnomeCancellation(false, 'cancelled')).toThrow('cancellation-outcome');
    expect(() => assertGnomeCancellation(true, undefined)).toThrow('cancellation-outcome');
    expect(() => assertGnomeCancellation(true, 'native-command-failed')).toThrow('cancellation-outcome');
    expect(() => assertGnomeCancellation(true, 'cancelled')).not.toThrow();
    expect(fixtureSource).toContain('if (processFinished) break');
    expect(fixtureSource).toContain('cancellation-startup-unavailable');
  });
  it('distinguishes observed creation from pre-dispatch refusal without exposing key material', () => {
    const refused = gnomeEnrollmentFailureObservation({
      status: 'failed', creation: 'no-dispatch', observedItemPaths: [], issue: 'item-mismatch', key: null, readiness: false
    }, true);
    expect(refused).toMatchObject({ creation: 'no-dispatch', preserveScope: false, readiness: false });
    const created = gnomeEnrollmentFailureObservation({
      status: 'failed', creation: 'returned-identity', observedItemPaths: ['/org/freedesktop/secrets/collection/login/1'],
      issue: 'item-mismatch', key: null, readiness: false
    }, true);
    expect(created).toMatchObject({
      creation: 'returned-identity', preserveScope: true,
      observedItemPaths: ['/org/freedesktop/secrets/collection/login/1']
    });
    expect(Object.hasOwn(created, 'key')).toBe(false);
    expect(gnomeEnrollmentFailureObservation(null, false)).toMatchObject({ creation: 'unknown', preserveScope: true });
  });
  it('pins the source commit and disables unrelated startup components', () => {
    expect(declaration.sourceCommit).toBe('da00f9621eaf263d5ed4236df9c22798ea8021d2');
    expect(declaration.tagEquivalent).toBeNull();
    expect(declaration.mesonOptions).toEqual({
      'ssh-agent': false, pam: false, systemd: 'disabled', 'libcap-ng': 'disabled',
      selinux: 'disabled', 'debug-mode': false, manpage: false
    });
    expect(declaration.privatePrefixOptions).toEqual({
      'pkcs11-config': 'etc/pkcs11', 'pkcs11-modules': 'lib/pkcs11'
    });
    expect(coordinator).toContain("['--foreground', '--components=secrets', '--control-directory', config.control, '--unlock']");
    expect(coordinator).not.toMatch(/['"]--(?:start|replace|daemonize|login)['"]/u);
    expect(coordinator).not.toContain('InternalUnsupported');
    expect(declaration.qualification).toContain('not-encrypted-host-custody');
  });

  describe('bounded private bus startup diagnostics', () => {
    it('classifies the mandatory D-Bus /dev/null open failure without retaining stderr', () => {
      const bytes = Buffer.from('dbus-daemon: fatal error setting up standard fds: Failed to open /dev/null: Permission denied\n');
      const diagnostic = consumeBusStartupDiagnostic(bytes, {
        closed: true, exitCode: 1, addressObserved: false, nullReadWrite: 'EACCES'
      });
      expect(diagnostic).toMatchObject({
        stage: 'standard-fds', reason: 'dev-null-open', errno: 'EACCES',
        exitCode: 1, addressObserved: false, nullReadWrite: 'EACCES'
      });
      expect(bytes.every((byte) => byte === 0)).toBe(true);
      expect(coordinator.includes("fd = await open('/dev/null', 'r+')")).toBe(true);
      expect(coordinator.includes('await fd.close()')).toBe(true);
    });

    it.each([
      ['Failed to dup2 /dev/null onto a standard fd', 'Operation not permitted', 'dev-null-dup', 'EPERM'],
      ['Failed to open /dev/null', 'No such file or directory', 'dev-null-open', 'ENOENT']
    ])('preserves only allowlisted native stage/errno for %s', (operation, message, reason, errno) => {
      const bytes = Buffer.from(`dbus-daemon[123]: fatal error setting up standard fds: ${operation}: ${message}\n`);
      expect(consumeBusStartupDiagnostic(bytes, { closed: true, exitCode: 1 })).toMatchObject({
        stage: 'standard-fds', reason, errno
      });
    });

    it('separates exec failure and socket binding from standard-descriptor setup', () => {
      expect(consumeBusStartupDiagnostic(Buffer.alloc(0), { spawnError: 'EACCES', closed: true, exitCode: -1 }))
        .toMatchObject({ stage: 'spawn', reason: 'native-exec', errno: 'EACCES', exitCode: null });
      const bytes = Buffer.from('dbus-daemon[123]: Failed to start message bus: Failed to bind socket "/PRIVATE_SENTINEL": Address already in use\n');
      const result = consumeBusStartupDiagnostic(bytes, { closed: true, exitCode: 1 });
      expect(result).toMatchObject({ stage: 'socket-bind', reason: 'unix-bind', errno: 'EADDRINUSE' });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
      expect(bytes.every((byte) => byte === 0)).toBe(true);
    });

    it('never copies unclassified provider strings, paths, signals or additional fields into public diagnostics', () => {
      const bytes = Buffer.from('PRIVATE_SENTINEL unexpected native diagnostics\n');
      const result = consumeBusStartupDiagnostic(bytes, {
        closed: true, exitCode: 9999, signal: 'PRIVATE_SENTINEL', nullReadWrite: 'PRIVATE_SENTINEL'
      });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
      expect(JSON.stringify(safeBusDiagnostic({
        stage: 'PRIVATE_SENTINEL', reason: 'PRIVATE_SENTINEL', errno: 'PRIVATE_SENTINEL',
        key: 'PRIVATE_SENTINEL', path: '/PRIVATE_SENTINEL'
      }))).not.toContain('PRIVATE_SENTINEL');
      expect(result).toMatchObject({ stage: 'address-output', reason: 'early-exit', errno: 'unclassified', exitCode: null, signal: null });
      expect(bytes.every((byte) => byte === 0)).toBe(true);
    });
  });

  it('creates bus/control descendants only after the restart guard, without detached children', () => {
    expect(fixtureSource).toContain('new LinuxReadonlyNullProcessGuard()');
    expect(fixtureSource).toContain("operation === 'restart' ? runGnomeNullRestart(this.#restartGuard, {");
    expect(fixtureSource).not.toContain('new LinuxReadonlyProcessGuard()');
    expect(fixtureSource).toContain('writableDirectories: paths');
    expect(declaration.restartProfile).toMatchObject({
      kind: linuxReadonlyNullProcessContract.kind,
      selection: 'explicit-plan-then-run-no-fallback',
      privateInputBinding: 'excluded-no-password-or-key-verifier',
      readiness: false
    });
    expect(coordinator).toContain('detached: false');
    expect(coordinator).not.toContain('detached: true');
    expect(coordinator).not.toMatch(/setsid|--fork|standard_session_servicedirs|autostart/);
    expect(coordinator).toContain("HOME: path.join(config.store, 'home')");
    expect(coordinator).toContain("XDG_DATA_HOME: path.join(config.store, 'data')");
    expect(coordinator).toContain('DBUS_SYSTEM_BUS_ADDRESS:');
    expect(coordinator).toContain("GNOME_KEYRING_PARANOID: '1'");
    expect(coordinator).toContain('nested-session-escape');
  });

  describe('GNOME null-profile plan/run wiring, not native observation', () => {
    const metadata: Omit<LinuxReadonlyNullProcessRequest, 'operationDigest' | 'stdin'> = {
      python: { path: '/fixture/python3.14', sha256: 'a'.repeat(64) },
      executable: { path: '/fixture/node', sha256: 'b'.repeat(64) },
      args: ['/fixture/gnome-coordinator.mjs', '{"operation":"restart","fault":"none","item":"login/1"}'],
      scopeDirectory: '/fixture/scope', storeDirectory: '/fixture/scope/store',
      writableDirectories: {
        control: '/fixture/scope/control', runtime: '/fixture/scope/runtime', scratch: '/fixture/scope/scratch'
      },
      timeoutMs: 15000, maximumBytes: 16384
    };
    // Deliberately not a native plan: these spies test wiring only, never authority.
    const plan = { unitTestOnly: true } as unknown as LinuxReadonlyNullProcessPlan;
    afterEach(() => vi.useRealTimers());

    it('plans exactly once with nonsecret metadata, then supplies private stdin only to that planned run', async () => {
      const input = Buffer.from('NONSECRET_TEST_PASSWORD');
      const planCall = vi.fn().mockResolvedValue(plan);
      const runCall = vi.fn().mockResolvedValue({ exitCode: 0, stdout: Buffer.alloc(0) });
      await runGnomeNullRestart({ plan: planCall, run: runCall }, metadata, input);
      expect(planCall).toHaveBeenCalledTimes(1);
      expect(runCall).toHaveBeenCalledTimes(1);
      const planned = planCall.mock.calls[0]![0] as LinuxReadonlyNullProcessRequest;
      expect(Object.hasOwn(planned, 'stdin')).toBe(false);
      expect(JSON.stringify(planned)).not.toContain('NONSECRET_TEST_PASSWORD');
      expect(planned.operationDigest).toBe(canonicalSha256({
        kind: 'gnome-source-fixture-restart-operation/1',
        profile: linuxReadonlyNullProcessContract.kind, request: metadata
      }));
      expect(runCall.mock.calls[0]![0]).toEqual({ ...planned, stdin: input });
      expect(runCall.mock.calls[0]![1]).toBe(plan);
      expect(planCall.mock.invocationCallOrder[0]!).toBeLessThan(runCall.mock.invocationCallOrder[0]!);
      input.fill(0);
    });

    it('binds the exact operation/configuration but neither password bytes nor a password verifier', async () => {
      const planCall = vi.fn().mockResolvedValue(plan);
      const runCall = vi.fn().mockResolvedValue({ exitCode: 0, stdout: Buffer.alloc(0) });
      const first = Buffer.from('NONSECRET_FIRST_PASSWORD'), second = Buffer.from('NONSECRET_SECOND_PASSWORD');
      try {
        await runGnomeNullRestart({ plan: planCall, run: runCall }, metadata, first);
        await runGnomeNullRestart({ plan: planCall, run: runCall }, metadata, second);
        await runGnomeNullRestart({ plan: planCall, run: runCall }, {
          ...metadata, args: [metadata.args[0]!, '{"operation":"restart","fault":"missing-probe","item":"login/1"}']
        }, first);
        const digests = planCall.mock.calls.map((call) => (call[0] as LinuxReadonlyNullProcessRequest).operationDigest);
        expect(digests[0]).toBe(digests[1]);
        expect(digests[2]).not.toBe(digests[0]);
      } finally { first.fill(0); second.fill(0); }
    });

    it('rejects private/extra planning fields rather than hashing or passing them to the planner', async () => {
      const planCall = vi.fn(), runCall = vi.fn();
      const privateField = Buffer.from('NONSECRET_PRIVATE_FIELD');
      try {
        for (const value of [
          { ...metadata, stdin: privateField },
          { ...metadata, executable: { ...metadata.executable, password: privateField } },
          { ...metadata, writableDirectories: { ...metadata.writableDirectories, secret: privateField } }
        ]) {
          await expect(runGnomeNullRestart({ plan: planCall, run: runCall }, value as typeof metadata, Buffer.alloc(0)))
            .rejects.toThrow('nonsecret-restart-metadata-required');
        }
      } finally { privateField.fill(0); }
      expect(planCall).not.toHaveBeenCalled();
      expect(runCall).not.toHaveBeenCalled();
    });

    it.each(['plan', 'run'] as const)('does not retry or change profiles after %s failure', async (stage) => {
      const blocked = new Error('unit-native-profile-blocked');
      const planCall = stage === 'plan' ? vi.fn().mockRejectedValue(blocked) : vi.fn().mockResolvedValue(plan);
      const runCall = vi.fn().mockRejectedValue(blocked);
      await expect(runGnomeNullRestart({ plan: planCall, run: runCall }, metadata, Buffer.alloc(0))).rejects.toBe(blocked);
      expect(planCall).toHaveBeenCalledTimes(1);
      expect(runCall).toHaveBeenCalledTimes(stage === 'plan' ? 0 : 1);
    });

    it('includes planning in the original outer deadline rather than adding a second execution window', async () => {
      vi.useFakeTimers();
      const planned = Promise.withResolvers<LinuxReadonlyNullProcessPlan>();
      const planCall = vi.fn().mockReturnValue(planned.promise);
      const runCall = vi.fn().mockImplementation((request: LinuxReadonlyNullProcessRequest) =>
        new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new Error('unit-budget-expired')), { once: true })));
      const outcome = runGnomeNullRestart({ plan: planCall, run: runCall }, { ...metadata, timeoutMs: 1000 }, Buffer.alloc(0))
        .then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(750);
      planned.resolve(plan);
      await vi.advanceTimersByTimeAsync(0);
      expect(runCall).toHaveBeenCalledTimes(1);
      const request = runCall.mock.calls[0]![0] as LinuxReadonlyNullProcessRequest;
      await vi.advanceTimersByTimeAsync(249);
      expect(request.signal!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(request.signal!.aborted).toBe(true);
      expect(await outcome).toMatchObject({ message: 'unit-budget-expired' });
    });
  });

  it('keeps passwords in private stdin and retains only a consumed encrypted application-key binding', () => {
    expect(coordinator).toContain('secret = await password()');
    expect(coordinator).toContain('child.stdin.end(input, () => input?.fill(0))');
    expect(coordinator).toContain('secret?.fill(0)');
    expect(coordinator).not.toMatch(/writeFile\([^;]*\bsecret\b|console\.|JSON\.stringify\(secret/u);
    expect(enrollmentLauncher).toContain('resource.setrlimit(resource.RLIMIT_CORE, (0, 0))');
    expect(enrollmentLauncher).not.toContain('sys.stdin');
    expect(fixtureSource).toContain('createManagedKeystoreKeyBinding(client.key, this.#context)');
    expect(fixtureSource).toContain('verifyManagedKeystoreKeyBinding(client.key, this.#binding, context)');
    expect(fixtureSource).toContain('inspectControlledGnomeBinary(bytes)');
    expect(fixtureSource).toContain('await file.sync()');
    expect(fixtureSource).toContain('await parent.sync()');
  });

  it('retains uncertainty and bounds fixture operations within the 20-minute job', () => {
    expect(declaration.budgets).toEqual({
      jobMinutes: 20, coordinatorMs: 12000, parentMs: 15000, clientMs: 5000, startupMs: 5000, maximumPrivateOutputBytes: 16384
    });
    expect(fixtureSource).toContain('if (!this.#preserve) await rm(this.scope');
    expect(fixtureSource).toContain('process-tree-termination-unproven');
    expect(coordinator).toContain("config?.fault === 'withhold-settlement'");
    expect(coordinator).toContain('await loaded(daemon, config.gnome.dependencies)');
    expect(coordinator).toContain('await loaded(client, config.client.dependencies)');
    expect(coordinator.indexOf('await admitLoader(config.client.executable.path')).toBeLessThan(coordinator.indexOf('secret = await password()'));
  });

  it('admits the actual Node coordinator before creating fixture state or passwords', () => {
    const node = fixtureSource.indexOf('const node = await captureStateExecutable(process.execPath)');
    expect(node).toBeGreaterThan(0);
    expect(node).toBeLessThan(fixtureSource.indexOf("const parent = path.join(await realpath(process.cwd()), '.cache')"));
    expect(node).toBeLessThan(fixtureSource.indexOf('const password = randomBytes(48)'));
    expect(fixtureSource).toContain('executable: this.#node');
    expect(fixtureSource).not.toMatch(/chmod|fchmod|LIFTOFF_STATE_NODE/u);
  });

  if (process.platform !== 'linux') {
    it('refuses actual native execution on macOS/other hosts', async () => {
      await expect(GnomePersistenceFixture.create()).rejects.toThrow('explicit-native-authorization-required');
    });
  }
});

if (process.platform === 'darwin' || process.platform === 'linux') {
  describe('unchanged POSIX executable admission for the GNOME coordinator', () => {
    it.each([0o775, 0o757, 0o777, 0o644])('refuses unsafe mode %s without changing executable bytes or metadata', async (mode) => {
      const root = path.resolve('tests', `.gnome-executable-${randomUUID()}`);
      await mkdir(root, { mode: 0o700 });
      const filename = path.join(root, 'never-executed-fixture');
      const bytes = Buffer.from('NONSECRET_EXECUTABLE_ADMISSION_FIXTURE');
      try {
        await writeFile(filename, bytes, { mode: 0o600 });
        await chmod(filename, mode);
        const before = await lstat(filename, { bigint: true });
        await expect(captureStateExecutable(filename)).rejects.toMatchObject({ code: 'tool-unavailable' });
        const after = await lstat(filename, { bigint: true });
        expect([after.dev, after.ino, after.uid, after.gid, after.size, after.mode, after.mtimeNs, after.ctimeNs])
          .toEqual([before.dev, before.ino, before.uid, before.gid, before.size, before.mode, before.mtimeNs, before.ctimeNs]);
        expect(stateDigest(await readFile(filename))).toBe(stateDigest(bytes));
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('admits only the exact already-safe executable identity without running it', async () => {
      const root = path.resolve('tests', `.gnome-executable-${randomUUID()}`);
      await mkdir(root, { mode: 0o700 });
      const filename = path.join(root, 'never-executed-fixture');
      const bytes = Buffer.from('NONSECRET_EXECUTABLE_ADMISSION_FIXTURE');
      try {
        await writeFile(filename, bytes, { mode: 0o755 });
        const before = await lstat(filename, { bigint: true });
        expect(await captureStateExecutable(filename)).toEqual({ path: filename, sha256: stateDigest(bytes) });
        const after = await lstat(filename, { bigint: true });
        expect([after.dev, after.ino, after.mode, after.mtimeNs, after.ctimeNs])
          .toEqual([before.dev, before.ino, before.mode, before.mtimeNs, before.ctimeNs]);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });
}

describe('exact GNOME private Meson path admission', () => {
  // Actual Meson values printed by both hosts in run 35417453057 at d4d8210.
  const prefix = '/home/runner/work/_temp/liftoff-gnome-persistence-build/prefix';
  const observed = [
    { name: 'pkcs11-config', value: `${prefix}/share/p11-kit/modules` },
    { name: 'pkcs11-modules', value: `${prefix}/lib/pkcs11` }
  ];
  const corrected = [
    { name: 'pkcs11-config', value: `${prefix}/etc/pkcs11` },
    observed[1]!
  ];

  it('reproduces the hosted path mismatch and admits only the corrected exact CI values', () => {
    expect(() => validateGnomePrivatePrefixOptions(observed, prefix, declaration.privatePrefixOptions))
      .toThrow('gnome-private-pkcs11-path-required');
    expect(validateGnomePrivatePrefixOptions(corrected, prefix, declaration.privatePrefixOptions)).toEqual({
      'pkcs11-config': `${prefix}/etc/pkcs11`,
      'pkcs11-modules': `${prefix}/lib/pkcs11`
    });
  });

  it('keeps the CI command and recorder on the same exact private leaves', async () => {
    const workflow = await readFile(path.resolve('.github', 'workflows', 'ci.yml'), 'utf8');
    for (const [name, relative] of Object.entries(declaration.privatePrefixOptions))
      expect(workflow.includes(`-D${name}="$GNOME_PREFIX/${relative}"`)).toBe(true);
    const recorder = await readFile(path.join(directory, 'gnome-build-identity.mjs'), 'utf8');
    expect(recorder).toContain('validateGnomePrivatePrefixOptions(options, prefix, manifest.privatePrefixOptions)');
    expect(recorder.indexOf('validateGnomePrivatePrefixOptions(options')).toBeLessThan(recorder.indexOf('const executable ='));
  });

  it.each([
    ['pkcs11-config', ''],
    ['pkcs11-config', '/usr/share/p11-kit/modules'],
    ['pkcs11-config', `${prefix}/share/p11-kit/modules`],
    ['pkcs11-config', `${prefix}-other/etc/pkcs11`],
    ['pkcs11-config', `${prefix}/../outside/etc/pkcs11`],
    ['pkcs11-modules', '/usr/lib/pkcs11'],
    ['pkcs11-modules', `${prefix}/lib/pkcs11/`],
    ['pkcs11-modules', 'lib/pkcs11']
  ])('rejects mismatched %s rather than accepting a fallback: %s', (name, value) => {
    const changed = corrected.map((option) => option.name === name ? { ...option, value } : option);
    expect(() => validateGnomePrivatePrefixOptions(changed, prefix, declaration.privatePrefixOptions))
      .toThrow('gnome-private-pkcs11-path-required');
  });

  it.each(['pkcs11-config', 'pkcs11-modules'])('rejects missing %s observations', (name) => {
    expect(() => validateGnomePrivatePrefixOptions(corrected.filter((option) => option.name !== name),
      prefix, declaration.privatePrefixOptions)).toThrow('gnome-private-pkcs11-path-required');
  });
});

if (process.env.LIFTOFF_GNOME_PERSISTENCE_TEST === '1') {
  describe('opt-in actual pinned GNOME persistence with generated test data, not encrypted host custody', () => {
    const fixtures: GnomePersistenceFixture[] = [];
    afterEach(async () => {
      for (const fixture of fixtures.splice(0)) await fixture.close();
    });
    async function enrolled() {
      const fixture = await GnomePersistenceFixture.create();
      fixtures.push(fixture);
      await fixture.enroll();
      return fixture;
    }

    it('verifies a fresh daemon/key binding against independently synced unchanged persisted bytes', async () => {
      const fixture = await enrolled();
      await fixture.restart();
      console.info(JSON.stringify({
        kind: 'observed-gnome-persistence-source-test', platform: process.platform, architecture: process.arch,
        daemonSource: declaration.sourceCommit, generatedTestDataOnly: true,
        freshProcessKeyBindingMatched: true, persistedBytesPreserved: true,
        encryptedHostCustody: 'not-performed', readiness: false
      }));
    });

    it.each(['missing', 'substituted', 'wrong-password', 'cancelled'] as const)(
      'preserves the source fixture generation across %s restart failure', async (kind) => {
        const fixture = await enrolled();
        const result = await fixture.negative(kind);
        expect(result.unchanged).toBe(true);
        expect(result.readiness).toBe(false);
      }
    );

    it('rejects a changed key-binding context even when the real fresh daemon returned a key', async () => {
      const fixture = await enrolled();
      await expect(fixture.restart(true)).rejects.toMatchObject({ code: 'artifact-integrity' });
    });

    it('withholds readiness and preserves scope when the coordinator settlement report is lost', async () => {
      const fixture = await enrolled();
      const result = await fixture.negative('unknown-settlement');
      expect(result.scopePreserved).toBe(true);
      await fixture.close();
      expect((await lstat(fixture.scope)).isDirectory()).toBe(true);
    });
  });
}
