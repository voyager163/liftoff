import { chmod, mkdir, readFile, lstat, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GnomePersistenceFixture, gnomeEnrollmentFailureObservation
} from '../native/linux-keystore-client/gnome-persistence-fixture.js';
import { validateGnomePrivatePrefixOptions } from '../native/linux-keystore-client/gnome-build-contract.mjs';
import { captureStateExecutable } from '../src/adapters/state/native-system.js';
import { stateDigest } from '../src/domain/repair/stateful-invariants.js';

const directory = path.resolve('native', 'linux-keystore-client');
const coordinator = await readFile(path.join(directory, 'gnome-coordinator.mjs'), 'utf8');
const fixtureSource = await readFile(path.join(directory, 'gnome-persistence-fixture.ts'), 'utf8');
const enrollmentLauncher = await readFile(path.join(directory, 'gnome-enrollment-launch.py'), 'utf8');
const declaration = JSON.parse(await readFile(path.join(directory, 'gnome-dependencies.json'), 'utf8'));

describe('actual GNOME persistence fixture source boundaries', () => {
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

  it('creates bus/control descendants only after the restart guard, without detached children', () => {
    expect(fixtureSource).toContain('this.#guard.run({');
    expect(fixtureSource).toContain('writableDirectories: paths');
    expect(coordinator).toContain('detached: false');
    expect(coordinator).not.toContain('detached: true');
    expect(coordinator).not.toMatch(/setsid|--fork|standard_session_servicedirs|autostart/);
    expect(coordinator).toContain("HOME: path.join(config.store, 'home')");
    expect(coordinator).toContain("XDG_DATA_HOME: path.join(config.store, 'data')");
    expect(coordinator).toContain('DBUS_SYSTEM_BUS_ADDRESS:');
    expect(coordinator).toContain("GNOME_KEYRING_PARANOID: '1'");
    expect(coordinator).toContain('nested-session-escape');
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
