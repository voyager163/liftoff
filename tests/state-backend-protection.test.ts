import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EncryptedStateWorkspace, FilesystemProtectedArtifactStorage, assertPrivateStatePath, protectedStateScope
} from '../src/adapters/state/protected-workspace.js';
import { StateMigrationError } from '../src/domain/repair/stateful.js';
import { LocalStateBackend } from '../src/adapters/state/local.js';
import { validateStateBindings, stateDigest } from '../src/domain/repair/stateful-invariants.js';
import { binding, context, MemoryProtectedStorage, syntheticStateValue, workspace } from './fixtures/state-migration/fakes.js';

const scratch = path.join(process.cwd(), '.cache', `state-backend-protection-${process.pid}`);
afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });

describe('encrypted private state artifacts', () => {
  it('requires protected storage and an external usable 256-bit key before storing anything', async () => {
    const storage = new MemoryProtectedStorage();
    const vault = workspace(storage);
    await expect(vault.put('state', protectedStateScope(context()), Buffer.from(syntheticStateValue)))
      .rejects.toMatchObject({ code: 'protected-workspace-required' });
    storage.available = false;
    await expect(vault.assertAvailable(context())).rejects.toMatchObject({ code: 'protected-workspace-required' });
    expect(storage.files.size).toBe(0);
    storage.available = true;
    const missingKey = new EncryptedStateWorkspace({
      workspaceId: '11111111-1111-4111-a111-111111111111', keyRef: 'unavailable-key', ownerId: context().projectId, storage,
      keys: {
        async describe() { throw new Error(syntheticStateValue); },
        async withKey() { throw new Error(syntheticStateValue); }
      }
    });
    await expect(missingKey.assertAvailable(context())).rejects.toMatchObject({ code: 'key-unavailable' });
    expect(storage.files.size).toBe(0);
    expect(JSON.stringify(missingKey)).not.toContain(syntheticStateValue);
  });

  it('encrypts state and journals with independent nonces, verifies backups, and exposes opaque handles', async () => {
    const storage = new MemoryProtectedStorage();
    const vault = workspace(storage);
    await vault.assertAvailable(context());
    const scope = protectedStateScope(context());
    const first = await vault.put('backup', scope, Buffer.from(syntheticStateValue));
    const second = await vault.put('journal', scope, Buffer.from(syntheticStateValue));
    expect(first.ref).not.toBe(second.ref);
    const envelopes = [...storage.files.values()].map((value) => JSON.parse(Buffer.from(value).toString()));
    expect(envelopes.every((value) => value.version === 1 && Buffer.from(value.tag, 'base64').length === 16)).toBe(true);
    expect(envelopes[0].nonce).not.toBe(envelopes[1].nonce);
    expect(JSON.stringify(envelopes)).not.toContain(syntheticStateValue);
    expect(Buffer.from(await vault.get(first.ref, 'backup', scope)).toString()).toBe(syntheticStateValue);
    expect(await vault.describe(first.ref, 'backup', scope)).toEqual(first);
    expect(JSON.stringify(vault)).toBe(JSON.stringify({ workspaceRef: vault.workspaceRef }));
  });

  it('authenticates artifact identity, purpose, scope, key and ciphertext before returning bytes', async () => {
    const storage = new MemoryProtectedStorage();
    const vault = workspace(storage);
    await vault.assertAvailable(context());
    const scope = protectedStateScope(context());
    const artifact = await vault.put('backup', scope, Buffer.from(syntheticStateValue));
    await expect(vault.get(artifact.ref, 'state', scope)).rejects.toMatchObject({ code: 'artifact-integrity' });
    await expect(vault.get(artifact.ref, 'backup', stateDigest('other-project'))).rejects.toMatchObject({ code: 'artifact-integrity' });
    await expect(vault.get(`${vault.workspaceRef}/../../other`, 'backup', scope)).rejects.toMatchObject({ code: 'artifact-integrity' });
    const id = artifact.ref.split('/').at(-1)!;
    const envelope = JSON.parse(Buffer.from(storage.files.get(id)!).toString());
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    ciphertext[0] ^= 1;
    envelope.ciphertext = ciphertext.toString('base64');
    storage.files.set(id, Buffer.from(JSON.stringify(envelope)));
    await expect(vault.get(artifact.ref, 'backup', scope)).rejects.toMatchObject({ code: 'artifact-integrity' });
  });

  it('uses exact compare-exchange for journals and only removes the named authenticated artifact', async () => {
    const storage = new MemoryProtectedStorage();
    const vault = workspace(storage);
    await vault.assertAvailable(context());
    const scope = protectedStateScope(context());
    const journal = await vault.put('journal', scope, Buffer.from('first-checkpoint'));
    const other = await vault.put('backup', scope, Buffer.from(syntheticStateValue));
    const updated = await vault.replace(journal.ref, 'journal', scope, journal.digest, Buffer.from('second-checkpoint'));
    await expect(vault.replace(journal.ref, 'journal', scope, journal.digest, Buffer.from('stale-checkpoint')))
      .rejects.toMatchObject({ code: 'artifact-integrity' });
    await expect(vault.removeExact(journal)).rejects.toMatchObject({ code: 'artifact-integrity' });
    await vault.removeExact(updated);
    expect(await vault.describe(journal.ref, 'journal', scope)).toBeNull();
    expect(await vault.describe(other.ref, 'backup', scope)).toEqual(other);
  });

  it('bounds artifact and cumulative storage without plaintext fallback', async () => {
    const storage = new MemoryProtectedStorage();
    const vault = new EncryptedStateWorkspace({
      workspaceId: '11111111-1111-4111-a111-111111111111', keyRef: 'synthetic-test-key', ownerId: context().projectId,
      storage, maxArtifactBytes: 16, maxWrittenBytes: 24,
      keys: {
        async describe(keyRef, current) {
          return { keyRef, ownerId: current.projectId, hostId: current.hostId, storage: 'external-key-provider', algorithm: 'aes-256-gcm' };
        },
        async withKey(_ref, action) { return action(Buffer.alloc(32, 1)); }
      }
    });
    await vault.assertAvailable(context());
    await expect(vault.put('backup', protectedStateScope(context()), Buffer.alloc(17))).rejects.toMatchObject({ code: 'storage-limit' });
    await vault.put('backup', protectedStateScope(context()), Buffer.alloc(16));
    await expect(vault.put('backup', protectedStateScope(context()), Buffer.alloc(16))).rejects.toMatchObject({ code: 'storage-limit' });
    expect(storage.files.size).toBe(1);
  });
});

describe('real filesystem protection gates (synthetic paths only)', () => {
  const attestor = {
    async verify(directory: string, current: ReturnType<typeof context>) {
      return {
        canonicalDirectory: directory, hostId: current.hostId,
        encryptedVolume: true as const, privateAccess: true as const,
        storageClass: 'protected-state-workspace' as const, expiresAt: Date.now() + 60_000
      };
    }
  };

  it('does not accept a repository/cache/workflow directory as protected state storage', async () => {
    const directory = path.join(scratch, 'not-a-protected-volume');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const store = new FilesystemProtectedArtifactStorage(directory, attestor);
    await expect(store.assertAvailable(context())).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(JSON.stringify(store)).not.toContain(directory);
  });

  it('rejects project-contained paths and unsafe links before an encryption attestation can help', async () => {
    const directory = path.join(scratch, 'project');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await expect(assertPrivateStatePath(directory, { ...context(), projectRoot: directory }, attestor, true))
      .rejects.toMatchObject({ code: 'unsafe-path' });
    const linked = path.join(scratch, 'linked-protection');
    await symlink(directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(assertPrivateStatePath(linked, context(), attestor, true)).rejects.toMatchObject({ code: 'unsafe-path' });
  });

  it('rejects case aliases and traversals instead of giving a neighboring path state ownership', () => {
    const first = binding('first', 'local');
    const second = binding('second', 'local');
    if (first.kind !== 'local' || second.kind !== 'local') throw new Error('fixture');
    second.statePath = first.statePath.toUpperCase();
    expect(() => validateStateBindings([first, second])).toThrow(StateMigrationError);
    first.statePath = path.join(scratch, 'safe') + path.sep + '..' + path.sep + 'outside.tfstate';
    expect(() => validateStateBindings([first])).toThrow(StateMigrationError);
  });

  it('permits explicitly named existing project state only as a read/retire source, never as a write destination', async () => {
    const projectRoot = path.join(scratch, 'existing-project');
    await mkdir(projectRoot, { recursive: true, mode: 0o700 });
    const statePath = path.join(projectRoot, 'terraform.tfstate');
    await writeFile(statePath, '{"synthetic":"existing state metadata only"}', { mode: 0o600 });
    const backend = new LocalStateBackend({
      id: 'existing', kind: 'local', ownerId: context().projectId, format: 'opentofu-v4-json',
      statePath, readOnlySource: true
    }, { volume: attestor });
    const current = { ...context(), projectRoot };
    const metadata = await backend.metadata(current);
    expect(metadata.exists).toBe(true);
    expect(Buffer.from(await backend.readPrivate(metadata, current)).toString()).toContain('existing state metadata only');
    await expect(backend.writePrivate({} as any)).rejects.toMatchObject({ code: 'unsupported-state' });
    await expect(backend.assertAccess(current, true)).rejects.toMatchObject({ code: 'native-lock-provider-required' });
  });
});
