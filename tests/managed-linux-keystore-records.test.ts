import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  managedLinuxKeystoreContract, managedLinuxKeystoreKinds as kinds, managedLinuxKeystoreOperations as operations
} from '../src/domain/repair/managed-linux-keystore-contract.js';
import {
  createManagedLinuxEnrollmentRecord, createManagedLinuxRecoveryCheckpoint, createManagedLinuxKeyReference,
  parseManagedLinuxEnrollmentRecord, parseManagedLinuxRecoveryCheckpoint, parseManagedLinuxKeyReference,
  managedLinuxKeyReferenceId, readManagedLinuxCheckpointChain,
  type ManagedLinuxKeystoreBinding, type ManagedLinuxRecoveryCheckpoint
} from '../src/domain/repair/managed-linux-keystore-records.js';
import {
  decodeManagedLinuxKeystoreRecord, encodeManagedLinuxKeystoreRecord, readManagedLinuxKeystoreReferences, readManagedLinuxRecoveryRecords,
  retainManagedLinuxClientEffect, consumeManagedLinuxPersistedGeneration, verifyManagedLinuxKeyReferenceBinding,
  maximumManagedLinuxRecordBytes
} from '../src/adapters/state/managed-linux-keystore-records.js';
import { createLinuxReadonlyNullProcessPlan, linuxNullProcessProfile } from '../src/domain/repair/linux-null-process.js';
import { createManagedKeystoreKeyBinding } from '../src/adapters/state/managed-keystore-key-binding.js';
import { PrivateLinuxKeySnapshot } from '../src/adapters/state/linux-keystore-client-protocol.js';
import { darwinStateKeyReferenceId, DarwinKeychainStateKeyProvider } from '../src/adapters/state/darwin-capabilities.js';

const hash = (name: string) => canonicalSha256(`NONSECRET_FIXTURE:${name}`);
const uuid = (tail: string) => `12345678-1234-4123-8123-${tail.padStart(12, '0')}`;
const itemPath = '/org/freedesktop/secrets/collection/login/42';
function binding(): ManagedLinuxKeystoreBinding {
  return {
    platform: 'linux', architecture: 'x64',
    projectId: 'project/workspace@fixture', hostRef: `native-host:${hash('host')}`, principalUid: 1001,
    enrollmentId: uuid('1'), storeId: uuid('2'), scopeRoot: '/private/managed-fixture', configurationDigest: hash('config'),
    software: {
      daemonSourceCommit: managedLinuxKeystoreContract.daemonSourceCommit,
      libsecretSourceCommit: managedLinuxKeystoreContract.libsecretSourceCommit,
      daemonDigest: hash('daemon'), dependencyInventoryDigest: hash('deps'), clientDigest: hash('client'),
      restartProfile: linuxNullProcessProfile, restartHelperDigest: hash('restart-helper')
    }
  };
}
function reseal<T extends { fingerprint: string }>(value: T): T {
  const { fingerprint: _fingerprint, ...body } = value;
  return { ...body, fingerprint: canonicalSha256(body) } as T;
}
function syntheticGeneration() {
  const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
  const bytes = Buffer.concat([
    Buffer.from('476e6f6d654b657972696e670a0d000a', 'hex'), Buffer.alloc(4),
    u32(5), Buffer.from('Login'), Buffer.alloc(16), u32(0), u32(0), u32(2048), Buffer.alloc(8),
    Buffer.alloc(16), u32(1), u32(42), u32(0), u32(0), u32(32), Buffer.alloc(32, 0xa5)
  ]);
  const generation = consumeManagedLinuxPersistedGeneration(bytes, {
    path: '/private/managed-fixture/data/keyrings/login.keyring',
    device: '1', inode: '2', birthtime: '3', uid: 1001, mode: 0o600
  });
  expect(bytes.every((byte) => byte === 0)).toBe(true);
  return generation;
}
async function fixture() {
  const selected = binding();
  const enrollment = createManagedLinuxEnrollmentRecord({
    binding: selected, operationId: uuid('3'), operationDigest: hash('enroll-operation'), createdAt: '2026-09-19T00:00:00.000Z'
  });
  const generation = syntheticGeneration();
  const encryptedBinding = await createManagedKeystoreKeyBinding(new PrivateLinuxKeySnapshot(Buffer.alloc(32, 0xa5)), {
    projectId: selected.projectId, hostRef: selected.hostRef, principalUid: selected.principalUid,
    enrollmentId: selected.enrollmentId, storeId: selected.storeId, itemPath,
    daemonDigest: selected.software.daemonDigest, dependencyInventoryDigest: selected.software.dependencyInventoryDigest,
    helperDigest: selected.software.clientDigest, persistedGenerationDigest: generation.sha256
  });
  const checkpoints: ManagedLinuxRecoveryCheckpoint[] = [];
  const append = (change: Partial<ManagedLinuxRecoveryCheckpoint>) => {
    const previous = checkpoints.at(-1);
    const checkpoint = createManagedLinuxRecoveryCheckpoint({
      enrollmentFingerprint: enrollment.fingerprint, bindingDigest: canonicalSha256(selected),
      sequence: checkpoints.length + 1, previousFingerprint: previous?.fingerprint ?? null,
      operation: operations.enroll, operationId: enrollment.operationId, operationDigest: enrollment.operationDigest,
      at: `2026-09-19T00:00:0${checkpoints.length}.000Z`, stage: 'pre-effect', blocker: null,
      keyEffect: previous?.keyEffect ?? { creation: 'no-dispatch', observedItemPaths: [] },
      generation: previous?.generation ?? null, keyBindingDigest: previous?.keyBindingDigest ?? null,
      fileSyncObservationDigest: previous?.fileSyncObservationDigest ?? null,
      directorySyncObservationDigest: previous?.directorySyncObservationDigest ?? null,
      processSettlementObservationDigest: null, restartReadbackObservationDigest: null, restartPlan: null,
      ...change
    });
    checkpoints.push(checkpoint);
    return checkpoint;
  };
  append({});
  append({ stage: 'store-dispatched' });
  append({ stage: 'key-dispatched', keyEffect: { creation: 'possible-mutation', observedItemPaths: [] } });
  append({ stage: 'key-returned', keyEffect: { creation: 'returned-identity', observedItemPaths: [itemPath] } });
  append({
    stage: 'persisted-observed', generation, keyBindingDigest: canonicalSha256(encryptedBinding),
    fileSyncObservationDigest: hash('file-sync-reference'), directorySyncObservationDigest: hash('dir-sync-reference')
  });
  const restartPlan = createLinuxReadonlyNullProcessPlan({
    helperDigest: selected.software.restartHelperDigest, hostId: selected.hostRef, principalUid: selected.principalUid,
    operationDigest: hash('restart-operation'), requestDigest: hash('restart-request'),
    nullDevice: {
      path: '/dev/null', kind: 'character-device', device: '4', inode: '5', ctime: '6',
      uid: 0, gid: 0, mode: 0o666, rdev: '259', major: 1, minor: 3
    }
  });
  append({
    stage: 'restart-observed', operation: operations.recover, operationId: uuid('4'), operationDigest: restartPlan.operationDigest,
    restartPlan, processSettlementObservationDigest: hash('settlement-reference'),
    restartReadbackObservationDigest: hash('fresh-readback-reference')
  });
  const reference = createManagedLinuxKeyReference(enrollment, checkpoints);
  const input = () => ({
    enrollment: encodeManagedLinuxKeystoreRecord(enrollment),
    checkpoints: checkpoints.map(encodeManagedLinuxKeystoreRecord),
    keyReference: encodeManagedLinuxKeystoreRecord(reference),
    expected: {
      binding: selected, enrollmentFingerprint: enrollment.fingerprint,
      checkpointFingerprint: checkpoints.at(-1)!.fingerprint, keyRef: managedLinuxKeyReferenceId(reference)
    }
  });
  return { selected, enrollment, checkpoints, reference, encryptedBinding, append, input };
}

describe('independent managed-Linux record registration, metadata only', () => {
  it('registers exact supported source interfaces and separates durability from provider success', () => {
    expect(managedLinuxKeystoreContract).toMatchObject({
      daemonSourceCommit: 'da00f9621eaf263d5ed4236df9c22798ea8021d2',
      libsecretSourceCommit: 'a5cd57f103038c06b64d5f6ebfd0e627bb40af4e',
      registration: 'source-audit-only', execution: 'not-authorized', readiness: false,
      interfaces: { prompts: 'refused', nativeWriter: { directorySync: 'not-provided', fileSync: 'HAVE_FSYNC-conditional-errors-propagated' } }
    });
    expect(new Set(Object.values(operations)).size).toBe(6);
    expect(Object.isFrozen(managedLinuxKeystoreContract.interfaces)).toBe(true);
    expect(managedLinuxKeystoreContract.remainingAdmission).toContain('native-protected-storage-contract-and-observation');
  });

  it('roundtrips all three explicit identities without creating native or approval authority', async () => {
    const f = await fixture();
    for (const value of [f.enrollment, ...f.checkpoints, f.reference]) {
      expect(decodeManagedLinuxKeystoreRecord(encodeManagedLinuxKeystoreRecord(value))).toEqual(value);
      expect(Object.isFrozen(value)).toBe(true);
      expect(value).toMatchObject({ authority: 'none', nativeAuthority: 'not-established', readiness: false });
    }
    const selected = readManagedLinuxKeystoreReferences(f.input());
    expect(selected).toMatchObject({
      evidence: 'metadata-binding-only', nativeAuthority: 'not-established', execution: 'not-authorized', readiness: false,
      recovery: {
        preserveScope: true, creationRetry: 'not-authorized', passwordReset: 'not-authorized',
        rekey: 'not-authorized', crossHostConversion: 'not-authorized', disposal: 'not-authorized'
      }
    });
    expect(managedLinuxKeyReferenceId(f.reference)).toMatch(/^managed-linux-key:[a-f0-9]{64}$/u);
    expect(selected.checkpoint.restartPlan).toMatchObject({ execution: 'not-authorized', readiness: false });
  });

  it.each(['architecture', 'projectId', 'hostRef', 'principalUid', 'enrollmentId', 'storeId', 'scopeRoot', 'configurationDigest'] as const)(
    'rejects stale/cross-scope %s even with otherwise valid records', async (field) => {
      const f = await fixture(), input = f.input();
      const values = {
        architecture: 'arm64',
        projectId: 'another-project', hostRef: `native-host:${hash('other-host')}`, principalUid: 1002,
        enrollmentId: uuid('8'), storeId: uuid('9'), scopeRoot: '/private/another-scope', configurationDigest: hash('changed')
      };
      input.expected.binding = { ...f.selected, [field]: values[field] } as ManagedLinuxKeystoreBinding;
      expect(() => readManagedLinuxKeystoreReferences(input)).toThrow('stale-state');
    }
  );

  it.each(['daemonDigest', 'dependencyInventoryDigest', 'clientDigest', 'restartHelperDigest'] as const)(
    'rejects changed software %s without upgrading old records', async (field) => {
      const f = await fixture(), input = f.input();
      input.expected.binding = { ...f.selected, software: { ...f.selected.software, [field]: hash('changed') } };
      expect(() => readManagedLinuxKeystoreReferences(input)).toThrow('stale-state');
    }
  );

  it.each([
    { provider: 'darwin-keychain' }, { schemaVersion: 2 }, { kind: 'private-bootstrap-custody' },
    { authority: 'approved' }, { nativeAuthority: 'verified' }, { readiness: true }, { rawKey: 'PRIVATE' },
    { masterPassword: 'PRIVATE' }, { passwordVerifier: hash('not-allowed') }
  ])('rejects unsupported identities, assertions or private fields %#', async (change) => {
    const f = await fixture();
    expect(() => parseManagedLinuxEnrollmentRecord(reseal({ ...f.enrollment, ...change } as typeof f.enrollment)))
      .toThrow('artifact-integrity');
  });

  it('rejects nested unknown fields and mismatched restart profiles rather than normalizing them', async () => {
    const f = await fixture();
    for (const bindingValue of [
      { ...f.selected, platform: 'darwin' },
      { ...f.selected, architecture: 'ia32' },
      { ...f.selected, encryptedVolume: true },
      { ...f.selected, software: { ...f.selected.software, restartProfile: 'linux-landlock-readonly-process/1' } },
      { ...f.selected, software: { ...f.selected.software, libsecretSourceCommit: '0'.repeat(40) } },
      { ...f.selected, software: { ...f.selected.software, keychainPath: '/somewhere' } }
    ]) expect(() => parseManagedLinuxEnrollmentRecord(reseal({ ...f.enrollment, binding: bindingValue } as typeof f.enrollment)))
      .toThrow('artifact-integrity');
    const current = f.checkpoints.at(-1)!;
    expect(() => parseManagedLinuxRecoveryCheckpoint(reseal({
      ...current, generation: { ...current.generation!, password: 'PRIVATE' }
    }))).toThrow('artifact-integrity');
  });

  it('rejects record tampering, duplicate/escaped JSON fields, invalid UTF-8 and unbounded data', async () => {
    const f = await fixture();
    const changed = { ...f.enrollment, createdAt: '2026-09-20T00:00:00.000Z' };
    expect(() => parseManagedLinuxEnrollmentRecord(changed)).toThrow('artifact-integrity');
    const original = canonicalJson(f.enrollment);
    for (const text of [
      original.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      original.replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1')
    ]) expect(() => decodeManagedLinuxKeystoreRecord(Buffer.from(text))).toThrow('artifact-integrity');
    expect(() => decodeManagedLinuxKeystoreRecord(Buffer.from([0xff]))).toThrow('artifact-integrity');
    expect(() => decodeManagedLinuxKeystoreRecord(Buffer.alloc(maximumManagedLinuxRecordBytes + 1))).toThrow('artifact-integrity');
  });

  it('rejects stale heads, missing checkpoints and references to a different generation', async () => {
    const f = await fixture(), input = f.input();
    expect(() => readManagedLinuxKeystoreReferences({ ...input, expected: { ...input.expected, checkpointFingerprint: hash('old') } }))
      .toThrow('stale-state');
    expect(() => readManagedLinuxKeystoreReferences({ ...input, checkpoints: input.checkpoints.slice(1) })).toThrow('artifact-integrity');
    const changed = reseal({ ...f.reference, persistedGenerationDigest: hash('new-generation') });
    expect(() => readManagedLinuxKeystoreReferences({
      ...input, keyReference: encodeManagedLinuxKeystoreRecord(changed),
      expected: { ...input.expected, keyRef: managedLinuxKeyReferenceId(changed) }
    })).toThrow('artifact-integrity');
  });

  it('retains uncertainty and all returned identities without reading or serializing the key', () => {
    const sentinel = new PrivateLinuxKeySnapshot(Buffer.alloc(32, 0xa5));
    try {
      const returned = retainManagedLinuxClientEffect({ creation: 'unknown', observedItemPaths: [] }, {
        status: 'incomplete', creation: 'returned-identity', observedItemPaths: [itemPath, '/foreign/item'],
        issue: 'process-unsettled', key: sentinel, readiness: false
      });

      const after = retainManagedLinuxClientEffect(returned, {
        status: 'failed', creation: 'no-dispatch', observedItemPaths: [], issue: 'provider-failure', key: null, readiness: false
      });
      expect(after).toEqual(returned);
      expect(Object.keys(after)).toEqual(['creation', 'observedItemPaths']);
      expect(() => JSON.stringify(after)).not.toThrow();
    } finally { sentinel.release(); }
  });

  it('reads a blocked partial history without issuing a key reference or retry/disposal authority', async () => {
    const f = await fixture();
    const prior = f.checkpoints[2]!;
    const blocked = reseal({
      ...prior, stage: 'blocked' as const, blocker: 'process-tree-termination-unproven' as const,
      sequence: 4, previousFingerprint: prior.fingerprint,
      operation: operations.recover, operationId: uuid('7'), operationDigest: hash('reconcile'), at: '2026-09-19T00:00:03.000Z'
    });
    const chain = [...f.checkpoints.slice(0, 3), blocked];
    const result = readManagedLinuxRecoveryRecords({
      enrollment: encodeManagedLinuxKeystoreRecord(f.enrollment), checkpoints: chain.map(encodeManagedLinuxKeystoreRecord),
      expected: { binding: f.selected, enrollmentFingerprint: f.enrollment.fingerprint, checkpointFingerprint: blocked.fingerprint }
    });
    expect(result).toMatchObject({
      checkpoint: { stage: 'blocked', keyEffect: { creation: 'possible-mutation' } },
      execution: 'not-authorized', readiness: false,
      recovery: { preserveScope: true, creationRetry: 'not-authorized', disposal: 'not-authorized' }
    });
    expect(() => createManagedLinuxKeyReference(f.enrollment, chain)).toThrow('artifact-integrity');
  });

  it('refuses creation retries, uncertainty downgrade, lost identities and implicit generation replacement', async () => {
    const f = await fixture();
    const previous = f.checkpoints.at(-1)!;
    for (const change of [
      { stage: 'key-dispatched', keyEffect: { creation: 'possible-mutation', observedItemPaths: [itemPath] } },
      { stage: 'store-dispatched' },
      { stage: 'blocked', blocker: 'recovery-conflict', keyEffect: { creation: 'unknown', observedItemPaths: [] } },
      { stage: 'blocked', blocker: 'stale-state', generation: { ...previous.generation!, sha256: hash('substituted') } }
    ] as const) {
      const next = createManagedLinuxRecoveryCheckpoint({
        ...Object.fromEntries(Object.entries(previous).filter(([key]) => !['schemaVersion', 'kind', 'provider', 'contractDigest',
          'authority', 'nativeAuthority', 'readiness', 'fingerprint'].includes(key))),
        ...change, sequence: previous.sequence + 1, previousFingerprint: previous.fingerprint
      } as Parameters<typeof createManagedLinuxRecoveryCheckpoint>[0]);
      expect(() => readManagedLinuxCheckpointChain(f.enrollment, [...f.checkpoints, next], f.selected)).toThrow('artifact-integrity');
    }
  });

  it('requires the exact restart host/principal/helper/operation binding even for recomputed plans', async () => {
    const f = await fixture(), current = f.checkpoints.at(-1)!;
    const original = current.restartPlan!;
    const plan = createLinuxReadonlyNullProcessPlan({
      helperDigest: original.helperDigest, hostId: `native-host:${hash('foreign')}`, principalUid: original.principalUid,
      operationDigest: original.operationDigest, requestDigest: original.requestDigest, nullDevice: original.nullDevice
    });
    const changed = reseal({ ...current, restartPlan: plan });
    expect(() => readManagedLinuxCheckpointChain(f.enrollment, [...f.checkpoints.slice(0, -1), changed], f.selected)).toThrow('artifact-integrity');
  });

  it('never parses or reinterprets existing macOS references, bytes or provider authority', async () => {
    const legacy = { keychainPath: '/fixture/legacy.keychain', service: 'org.liftoff.state.fixture', account: 'project' };
    const bytes = canonicalJson(legacy);
    expect(darwinStateKeyReferenceId(legacy)).toBe('keychain:082003a17ea99c3d0e00cc254a37b878c8a4600821f0aacf39c0f17d117b9dd7');
    expect(() => decodeManagedLinuxKeystoreRecord(Buffer.from(bytes))).toThrow('artifact-integrity');
    expect(canonicalJson(legacy)).toBe(bytes);
    const f = await fixture();
    const bridge = { request: vi.fn().mockRejectedValue(new Error('must not access a key store')) };
    const old = new DarwinKeychainStateKeyProvider(legacy, bridge);
    await expect(old.withKey(managedLinuxKeyReferenceId(f.reference), () => Promise.resolve())).rejects.toThrow('key-unavailable');
    expect(bridge.request).not.toHaveBeenCalled();
    expect(() => parseManagedLinuxKeyReference({ ...f.reference, kind: kinds.enrollment })).toThrow('artifact-integrity');
    const approval = Object.freeze({ kind: 'state-write', fingerprint: hash('legacy-approval'), expiresAt: 1_900_000_000_000 });
    const originalApproval = canonicalJson(approval);
    expect(() => decodeManagedLinuxKeystoreRecord(Buffer.from(originalApproval))).toThrow('artifact-integrity');
    expect(canonicalJson(approval)).toBe(originalApproval);
    expect(() => parseManagedLinuxEnrollmentRecord(reseal({ ...f.enrollment, approval }))).toThrow('artifact-integrity');
  });
});

describe('managed-Linux reference cryptographic binding is not native authority', () => {
  it('reuses and consumes the existing binding verifier without claiming fresh-process or readiness proof', async () => {
    const f = await fixture(), key = new PrivateLinuxKeySnapshot(Buffer.alloc(32, 0xa5));
    await expect(verifyManagedLinuxKeyReferenceBinding(f.input(), f.encryptedBinding, key)).resolves.toEqual({
      matched: true, evidence: 'key-binding-only', freshProcessVerified: false, readiness: false
    });
    await expect(key.consume(() => undefined)).rejects.toThrow('key-unavailable');
  });

  it.each(['wrong-key', 'changed-ciphertext', 'extra-private-field', 'stale-reference'] as const)(
    'clears a supplied snapshot and blocks %s', async (fault) => {
      const f = await fixture(), input = f.input();
      const key = new PrivateLinuxKeySnapshot(Buffer.alloc(32, fault === 'wrong-key' ? 0x5a : 0xa5));
      let probe: unknown = f.encryptedBinding;
      if (fault === 'changed-ciphertext') probe = { ...f.encryptedBinding, ciphertext: Buffer.alloc(64).toString('base64') };
      if (fault === 'extra-private-field') probe = { ...f.encryptedBinding, masterPassword: 'PRIVATE' };
      if (fault === 'stale-reference') input.expected.keyRef = `managed-linux-key:${hash('stale')}`;
      await expect(verifyManagedLinuxKeyReferenceBinding(input, probe, key)).rejects.toThrow();
      await expect(key.consume(() => undefined)).rejects.toThrow('key-unavailable');
    }
  );

  it('rejects a different valid encrypted probe rather than silently replacing the selected binding', async () => {
    const f = await fixture();
    const alternate = await createManagedKeystoreKeyBinding(new PrivateLinuxKeySnapshot(Buffer.alloc(32, 0xa5)), {
      projectId: f.selected.projectId, hostRef: f.selected.hostRef, principalUid: f.selected.principalUid,
      enrollmentId: f.selected.enrollmentId, storeId: f.selected.storeId, itemPath,
      daemonDigest: f.selected.software.daemonDigest, dependencyInventoryDigest: f.selected.software.dependencyInventoryDigest,
      helperDigest: f.selected.software.clientDigest, persistedGenerationDigest: f.reference.persistedGenerationDigest
    });
    const key = new PrivateLinuxKeySnapshot(Buffer.alloc(32, 0xa5));
    await expect(verifyManagedLinuxKeyReferenceBinding(f.input(), alternate, key)).rejects.toThrow('artifact-integrity');
    await expect(key.consume(() => undefined)).rejects.toThrow('key-unavailable');
  });
  it('clears malformed persisted bytes while refusing to fabricate a protected generation', () => {
    const bytes = Buffer.from('PRIVATE_INVALID_PERSISTED_BYTES');
    expect(() => consumeManagedLinuxPersistedGeneration(bytes, {
      path: '/private/managed-fixture/data/keyrings/login.keyring', device: '1', inode: '2', birthtime: '3', uid: 1001, mode: 0o600
    })).toThrow('artifact-integrity');
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });
});
