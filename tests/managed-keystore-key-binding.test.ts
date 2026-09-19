import { describe, expect, it, vi } from 'vitest';
import { PrivateLinuxKeySnapshot } from '../src/adapters/state/linux-keystore-client-protocol.js';
import {
  createManagedKeystoreKeyBinding, verifyManagedKeystoreKeyBinding,
  type ManagedKeystoreKeyContext
} from '../src/adapters/state/managed-keystore-key-binding.js';

function context(): ManagedKeystoreKeyContext {
  return {
    projectId: 'fixture-project', hostRef: `native-host:${'a'.repeat(64)}`, principalUid: 1000,
    enrollmentId: '12345678-1234-4123-8123-123456789abc', storeId: '12345678-1234-4123-8123-123456789abd',
    itemPath: '/org/freedesktop/secrets/collection/login/42',
    daemonDigest: 'b'.repeat(64), dependencyInventoryDigest: 'c'.repeat(64),
    helperDigest: 'd'.repeat(64), persistedGenerationDigest: 'e'.repeat(64)
  };
}
const snapshot = (byte = 0xa5) => new PrivateLinuxKeySnapshot(Buffer.alloc(32, byte));

describe('managed Linux key binding, not native custody or readiness', () => {
  it('consumes the original key and verifies only a separately supplied matching snapshot', async () => {
    const original = snapshot();
    const binding = await createManagedKeystoreKeyBinding(original, context());
    expect(binding).toMatchObject({ schemaVersion: 1, evidence: 'key-binding-only', readiness: false });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(JSON.stringify(binding)).not.toContain(Buffer.alloc(32, 0xa5).toString('base64'));
    await expect(original.consume(() => undefined)).rejects.toThrow('key-unavailable');
    const separate = snapshot();
    await expect(verifyManagedKeystoreKeyBinding(separate, binding, context())).resolves.toEqual({
      matched: true, evidence: 'key-binding-only', freshProcessVerified: false, readiness: false
    });
    await expect(separate.consume(() => undefined)).rejects.toThrow('key-unavailable');
  });

  it('uses fresh nonces for independent bindings without making native freshness claims', async () => {
    const first = await createManagedKeystoreKeyBinding(snapshot(), context());
    const second = await createManagedKeystoreKeyBinding(snapshot(), context());
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.contextDigest).toBe(second.contextDigest);
    await expect(verifyManagedKeystoreKeyBinding(snapshot(), second, context())).resolves.toMatchObject({ freshProcessVerified: false });
  });

  it('rejects the wrong key and clears the failed snapshot', async () => {
    const binding = await createManagedKeystoreKeyBinding(snapshot(), context());
    const wrong = snapshot(0x5a);
    await expect(verifyManagedKeystoreKeyBinding(wrong, binding, context())).rejects.toThrow('artifact-integrity');
    await expect(wrong.consume(() => undefined)).rejects.toThrow('key-unavailable');
  });

  it.each(Object.keys(context()) as Array<keyof ManagedKeystoreKeyContext>)('rejects changed %s before accepting key identity', async (field) => {
    const expected = context();
    const binding = await createManagedKeystoreKeyBinding(snapshot(), expected);
    const changed = { ...expected, [field]: field === 'principalUid' ? 1001 :
      field === 'itemPath' ? '/org/freedesktop/secrets/collection/login/99' :
      field === 'enrollmentId' || field === 'storeId' ? '12345678-1234-4123-8123-123456789abe' :
      field === 'hostRef' ? `native-host:${'f'.repeat(64)}` :
      field === 'projectId' ? 'other-project' : 'f'.repeat(64) };
    const key = snapshot();
    await expect(verifyManagedKeystoreKeyBinding(key, binding, changed)).rejects.toThrow('artifact-integrity');
    await expect(key.consume(() => undefined)).rejects.toThrow('key-unavailable');
  });

  it.each(['nonce', 'tag', 'ciphertext'] as const)('rejects changed or noncanonical %s bytes', async (field) => {
    const binding = await createManagedKeystoreKeyBinding(snapshot(), context());
    const altered = Buffer.from(binding[field], 'base64');
    altered[0] ^= 1;
    for (const value of [altered.toString('base64'), `${binding[field]}\n`, '', 1]) {
      await expect(verifyManagedKeystoreKeyBinding(snapshot(), { ...binding, [field]: value }, context()))
        .rejects.toThrow('artifact-integrity');
    }
  });

  it.each([
    { schemaVersion: 2 }, { kind: 'foreign-key-proof' }, { readiness: true },
    { evidence: 'native-qualified' }, { algorithm: 'unknown' }, { secret: 'PRIVATE_INPUT' }
  ])('rejects unknown, expanded or success-shaped binding fields %#', async (changed) => {
    const binding = await createManagedKeystoreKeyBinding(snapshot(), context());
    await expect(verifyManagedKeystoreKeyBinding(snapshot(), { ...binding, ...changed }, context()))
      .rejects.toThrow('artifact-integrity');
  });

  it('clears keys on malformed context and refuses reuse of the enrollment snapshot', async () => {
    const key = snapshot();
    await expect(createManagedKeystoreKeyBinding(key, { ...context(), principalUid: -1 })).rejects.toThrow('artifact-integrity');
    await expect(key.consume(() => undefined)).rejects.toThrow('key-unavailable');
    const used = snapshot();
    const binding = await createManagedKeystoreKeyBinding(used, context());
    await expect(verifyManagedKeystoreKeyBinding(used, binding, context())).rejects.toThrow('artifact-integrity');
  });

  it.each([
    null, {}, { ...context(), secret: 'PRIVATE_INPUT' },
    { ...context(), enrollmentId: null }, { ...context(), storeId: 1 },
    { ...context(), enrollmentId: { toString: () => context().enrollmentId } },
    { ...context(), principalUid: 0x100000000 }, { ...context(), principalUid: 1.5 },
    { ...context(), hostRef: 'another-host' }, { ...context(), projectId: 'invalid project' },
    { ...context(), itemPath: '/org/freedesktop/secrets/collection/other/42' },
    { ...context(), daemonDigest: 'B'.repeat(64) }
  ])('rejects malformed context without retaining key material %#', async (invalid) => {
    const malformed = invalid as ManagedKeystoreKeyContext;
    const original = snapshot();
    await expect(createManagedKeystoreKeyBinding(original, malformed)).rejects.toThrow('artifact-integrity');
    await expect(original.consume(() => undefined)).rejects.toThrow('key-unavailable');
    const binding = await createManagedKeystoreKeyBinding(snapshot(), context());
    const fresh = snapshot();
    await expect(verifyManagedKeystoreKeyBinding(fresh, binding, malformed)).rejects.toThrow('artifact-integrity');
    await expect(fresh.consume(() => undefined)).rejects.toThrow('key-unavailable');
  });

  it.each(['create', 'verify', 'wrong-key'] as const)('zeroes the consumed key bytes after %s', async (operation) => {
    const key = snapshot(operation === 'wrong-key' ? 0x5a : 0xa5);
    const consume = key.consume.bind(key);
    let observed: Uint8Array | undefined;
    vi.spyOn(key, 'consume').mockImplementation((action) => consume((bytes) => {
      observed = bytes;
      return action(bytes);
    }));
    if (operation === 'create') await createManagedKeystoreKeyBinding(key, context());
    else {
      const binding = await createManagedKeystoreKeyBinding(snapshot(), context());
      const verification = verifyManagedKeystoreKeyBinding(key, binding, context());
      if (operation === 'wrong-key') await expect(verification).rejects.toThrow('artifact-integrity');
      else await expect(verification).resolves.toMatchObject({ matched: true });
    }
    expect(observed?.byteLength).toBe(32);
    expect(observed?.every((byte) => byte === 0)).toBe(true);
  });
});
