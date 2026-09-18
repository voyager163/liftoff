import { describe, expect, it } from 'vitest';
import { controlledGnomeSourceCommit, planControlledGnomeLaunch } from '../src/domain/repair/controlled-keystore.js';

function input(operation: 'enroll' | 'restart' = 'enroll') {
  return {
    operation, projectId: 'fixture-project', projectRoot: '/work/project',
    hostId: `native-host:${'f'.repeat(64)}`, principalUid: 1000, scopeRoot: "/state/Liftoff's [key];$slot",
    daemon: { path: '/opt/gnome/bin/gnome-keyring-daemon', sha256: 'a'.repeat(64) },
    sourceCommit: controlledGnomeSourceCommit, dependencyInventoryDigest: 'b'.repeat(64)
  };
}

describe('controlled GNOME launch contract, without native effects', () => {
  it.each(['enroll', 'restart'] as const)('binds literal %s paths without desktop discovery, replacement or forking', (operation) => {
    const plan = planControlledGnomeLaunch(input(operation));
    expect(plan.request.args).toEqual([
      '--foreground', '--components=secrets', '--control-directory',
      "/state/Liftoff's [key];$slot/control", '--unlock'
    ]);
    expect(plan.request.cwd).toBe(input().scopeRoot);
    expect(plan.request.environment).toMatchObject({
      HOME: `${input().scopeRoot}/home`, XDG_DATA_HOME: `${input().scopeRoot}/data`,
      XDG_CONFIG_HOME: `${input().scopeRoot}/config`, XDG_RUNTIME_DIR: `${input().scopeRoot}/runtime`,
      GNOME_KEYRING_PARANOID: '1'
    });
    expect(decodeURIComponent(plan.request.environment.DBUS_SESSION_BUS_ADDRESS))
      .toBe(`unix:path=${input().scopeRoot}/runtime/bus`);
    expect(decodeURIComponent(plan.request.environment.DBUS_SYSTEM_BUS_ADDRESS))
      .toBe(`unix:path=${input().scopeRoot}/runtime/no-system-bus`);
    for (const variable of [
      'GNOME_KEYRING_CONTROL', 'GNOME_KEYRING_TEST_PATH', 'DBUS_STARTER_ADDRESS',
      'DBUS_STARTER_BUS_TYPE', 'XDG_SESSION_ID', 'DISPLAY', 'SSH_AUTH_SOCK', 'LD_PRELOAD'
    ]) expect(plan.request.environment).not.toHaveProperty(variable);
    for (const forbidden of ['--start', '--replace', '--daemonize', '--login'])
      expect(plan.request.args).not.toContain(forbidden);
  });

  it('requires write denial for restart because upstream unlock can create a missing store', () => {
    const enroll = planControlledGnomeLaunch(input());
    const restart = planControlledGnomeLaunch(input('restart'));
    expect(enroll.beforeDispatch).toContain('fresh-absence-bound-store-scope');
    expect(restart.beforeDispatch).toEqual(expect.arrayContaining([
      'original-enrollment-and-generation-binding', 'existing-store-required', 'persisted-store-write-denial'
    ]));
    expect(restart.fingerprint).not.toBe(enroll.fingerprint);
  });

  it('cannot turn a launch specification or daemon startup into authority or custody evidence', () => {
    const plan = planControlledGnomeLaunch(input());
    expect(plan).toMatchObject({
      observation: 'unperformed', execution: 'not-authorized', daemonStartupProvesReadiness: false,
      input: { kind: 'protected-master-password-stdin', maximumBytes: 4096, trim: false }
    });
    expect(plan.beforeReadiness).toContain('fresh-process-key-bound-readback');
    expect(plan.beforeReadiness).toContain('independent-durable-readback');
    expect(plan.beforeDispatch).toContain('private-bounded-stdio');
    expect(plan.beforeDispatch).toContain('private-owned-bus-and-socket-identity');
    expect(plan.beforeDispatch).toContain('all-native-slot-storage-confined');
    expect(plan.beforeDispatch).toContain('disabled-system-socket-absent');
    expect(plan.upstreamBehavior).toEqual({
      unlockCreatesMissingLoginCollection: true,
      unlockMayInitializeOtherNativeSlots: true,
      failedUnlockMayLeaveDaemonRunning: true,
      invalidControlDirectoryMayFallBack: true
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.request.args)).toBe(true);
    expect(Object.isFrozen(plan.request.environment)).toBe(true);
  });

  it.each(['masterPassword', 'secret', 'environment', 'approved', 'encrypted', 'readOnlyVerified'])(
    'rejects unregistered %s inputs rather than forwarding values or trusting assertions', (key) => {
      expect(() => planControlledGnomeLaunch({ ...input(), [key]: 'PRIVATE_INPUT' })).toThrow('invalid-binding');
      expect(() => planControlledGnomeLaunch({ ...input(), [key]: 'PRIVATE_INPUT' })).not.toThrow('PRIVATE_INPUT');
    }
  );

  it.each(['relative', '/', '/state/../key', '/state/key/', '/state/key\\other', '/state/\nkey', '/state/\0key', '/state/\ud800'])(
    'rejects ambiguous scope %j', (scopeRoot) => {
      expect(() => planControlledGnomeLaunch({ ...input(), scopeRoot })).toThrow('unsafe-path');
    }
  );

  it('rejects malformed operations, missing fields and oversized native paths', () => {
    expect(() => planControlledGnomeLaunch(null)).toThrow('invalid-binding');
    expect(() => planControlledGnomeLaunch({ ...input(), operation: 'unlock-any-store' })).toThrow('invalid-binding');
    expect(() => planControlledGnomeLaunch({ ...input(), principalUid: -1 })).toThrow('invalid-binding');
    expect(() => planControlledGnomeLaunch({ ...input(), hostId: 'claimed-host' })).toThrow('invalid-binding');
    expect(() => planControlledGnomeLaunch({ ...input(), daemon: null })).toThrow('invalid-binding');
    expect(() => planControlledGnomeLaunch({ ...input(), daemon: { ...input().daemon, sha256: 'x' } }))
      .toThrow('invalid-binding');
    expect(() => planControlledGnomeLaunch({ ...input(), projectRoot: `/${'p'.repeat(4095)}` }))
      .toThrow('unsafe-path');
  });

  it.each(['/work/project', '/work/project/keys', '/work'])('rejects project/store overlap at %s', (scopeRoot) => {
    expect(() => planControlledGnomeLaunch({ ...input(), scopeRoot })).toThrow('unsafe-path');
  });

  it.each(['/work/project/gnome', `${input().scopeRoot}/gnome`])('rejects a mutable-scope daemon at %s', (daemonPath) => {
    expect(() => planControlledGnomeLaunch({
      ...input(), daemon: { ...input().daemon, path: daemonPath }
    })).toThrow('tool-unavailable');
  });

  it('binds software identities and rejects an unaudited source without inferring a release tag', () => {
    const original = planControlledGnomeLaunch(input());
    expect(planControlledGnomeLaunch({ ...input(), dependencyInventoryDigest: 'c'.repeat(64) }).fingerprint)
      .not.toBe(original.fingerprint);
    expect(planControlledGnomeLaunch({ ...input(), daemon: { ...input().daemon, sha256: 'd'.repeat(64) } }).fingerprint)
      .not.toBe(original.fingerprint);
    expect(planControlledGnomeLaunch({ ...input(), principalUid: 1001 }).fingerprint).not.toBe(original.fingerprint);
    expect(planControlledGnomeLaunch({ ...input(), hostId: `native-host:${'e'.repeat(64)}` }).fingerprint)
      .not.toBe(original.fingerprint);
    expect(planControlledGnomeLaunch({ ...input(), projectId: 'another-project' }).fingerprint).not.toBe(original.fingerprint);
    expect(() => planControlledGnomeLaunch({ ...input(), sourceCommit: '51.0' })).toThrow('unqualified-combination');
    expect(() => planControlledGnomeLaunch({ ...input(), dependencyInventoryDigest: '' })).toThrow('invalid-binding');
    expect(() => planControlledGnomeLaunch({ ...input(), daemon: { ...input().daemon, secret: 'PRIVATE' } }))
      .toThrow('invalid-binding');
  });

  it('enforces decoded Unix socket byte bounds rather than URI or character lengths', () => {
    const tail = '/runtime/no-system-bus';
    const allowed = `/${'a'.repeat(106 - tail.length)}`;
    expect(Buffer.byteLength(`${allowed}${tail}`, 'utf8')).toBe(107);
    expect(() => planControlledGnomeLaunch({ ...input(), scopeRoot: allowed })).not.toThrow();
    expect(() => planControlledGnomeLaunch({ ...input(), scopeRoot: `${allowed}a` })).toThrow('unsafe-path');
    expect(() => planControlledGnomeLaunch({ ...input(), scopeRoot: `/${'\u00e9'.repeat(50)}` }))
      .toThrow('unsafe-path');
  });
});
