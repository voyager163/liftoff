import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const simulation = vi.hoisted(() => ({
  current: undefined as undefined | import('./fixtures/state-adapter-coverage/native-local-state.js').SimulatedNativeLocalState
}));

// Native qualification runs against an offline simulated OpenTofu/fcntl host: no real
// executable, credential, project, backend or statefile is reached from this suite.
vi.mock('../src/adapters/state/native-system.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/adapters/state/native-system.js')>();
  const active = () => {
    if (!simulation.current) throw new Error('No simulated native host is active for this test.');
    return simulation.current;
  };
  return {
    ...actual,
    inspectNativeLocalStateTools: (request: Parameters<typeof actual.inspectNativeLocalStateTools>[0]) =>
      active().inspect(request),
    runPrivateStateProcess: (request: Parameters<typeof actual.runPrivateStateProcess>[0]) => active().run(request),
    startPrivateStateProcess: (
      executable: Parameters<typeof actual.startPrivateStateProcess>[0],
      args: readonly string[],
      cwd: string
    ) => active().start(executable, args, cwd)
  };
});

vi.mock('../src/adapters/state/posix-native-lock.js', () => ({
  DarwinPosixStateLockProvider: class {
    constructor(options: { python: import('../src/domain/repair/stateful.js').StateRegisteredExecutable }) {
      if (!simulation.current) throw new Error('No simulated native host is active for this test.');
      return simulation.current.lockProvider(options);
    }
  }
}));

vi.mock('../src/adapters/state/owned-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/adapters/state/owned-process.js')>();
  return {
    ...actual,
    stopOwnedStateProcess: (
      child: Parameters<typeof actual.stopOwnedStateProcess>[0],
      options?: Parameters<typeof actual.stopOwnedStateProcess>[1]
    ) => {
      const active = simulation.current;
      return active?.processes.includes(child as never)
        ? active.stop(child as never)
        : actual.stopOwnedStateProcess(child, options);
    },
    stopOwnedStateProcessesIn: async (directory: string, cleanupMs?: number) => {
      await simulation.current?.stopWithin(directory);
      await actual.stopOwnedStateProcessesIn(directory, cleanupMs);
    }
  };
});

import { isActualNativeLocalQualification, qualifyNativeLocalState } from '../src/adapters/state/local-qualification.js';
import { nativeLocalStateProtocol, nativeStateHostId } from '../src/adapters/state/native-system.js';
import { posixStateLockProgram } from '../src/adapters/state/posix-lock-program.js';
import {
  EncryptedStateWorkspace,
  FilesystemProtectedArtifactStorage,
  assertExistingStateSourcePath,
  assertPrivateStatePath,
  protectedStateScope
} from '../src/adapters/state/protected-workspace.js';
import {
  StateMigrationError,
  type ProtectedArtifactStorage,
  type StateArtifactPurpose,
  type StateExecutionContext
} from '../src/domain/repair/stateful.js';
import { stateDigest, stateObjectDigest } from '../src/domain/repair/stateful-invariants.js';
import {
  SimulatedNativeLocalState,
  type SimulatedNativeFaults
} from './fixtures/state-adapter-coverage/native-local-state.js';
import {
  ExternalKeyProvider,
  ProtectedVolumeProof,
  RecordingArtifactStorage,
  executionContext,
  privateTemporaryDirectory,
  syntheticSecretState
} from './fixtures/state-adapter-coverage/protected-workspace.js';

type ArtifactId = ReturnType<typeof randomUUID>;

const posix = process.platform !== 'win32';
const superuser = process.getuid?.() === 0;
const userLocalVariables = [
  'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA'
] as const;
const temporaryRoots: string[] = [];
let isolatedHome: string;

async function ownedDirectory(prefix: string): Promise<string> {
  const directory = await privateTemporaryDirectory(`liftoff-state-adapter-${prefix}-`);
  temporaryRoots.push(directory);
  return directory;
}

async function privateDirectory(...parts: string[]): Promise<string> {
  const directory = path.join(...parts);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(() => true, () => false);
}

function failureOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

function directoryLink(target: string, alias: string): Promise<void> {
  return symlink(target, alias, posix ? 'dir' : 'junction');
}

beforeAll(async () => {
  isolatedHome = await privateTemporaryDirectory('liftoff-state-adapter-home-');
});

beforeEach(() => {
  // Every user-local default resolves into an owned temporary home, never the real one.
  for (const name of userLocalVariables) vi.stubEnv(name, isolatedHome);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

afterAll(async () => {
  // Neither adapter creates user-local records as a side effect.
  expect(await readdir(isolatedHome)).toEqual([]);
  await rm(isolatedHome, { recursive: true, force: true });
});

const projectId = 'synthetic-state-adapter-project';
const workspaceContext = executionContext(path.join(path.sep, 'synthetic-state-adapter-project'));
const scope = protectedStateScope(workspaceContext);
const secret = Buffer.from(syntheticSecretState);

function vault(
  storage: ProtectedArtifactStorage = new RecordingArtifactStorage(),
  keys = new ExternalKeyProvider(),
  overrides: Partial<ConstructorParameters<typeof EncryptedStateWorkspace>[0]> = {}
): EncryptedStateWorkspace {
  return new EncryptedStateWorkspace({
    workspaceId: randomUUID(), keyRef: keys.keyRef, ownerId: projectId, storage, keys, ...overrides
  });
}

async function readyVault(
  storage: ProtectedArtifactStorage = new RecordingArtifactStorage(),
  keys = new ExternalKeyProvider(),
  overrides: Partial<ConstructorParameters<typeof EncryptedStateWorkspace>[0]> = {}
): Promise<EncryptedStateWorkspace> {
  const workspace = vault(storage, keys, overrides);
  await workspace.assertAvailable(workspaceContext);
  return workspace;
}

function envelopeOf(storage: RecordingArtifactStorage, ref: string): Record<string, unknown> {
  const stored = storage.files.get(ref.split('/').at(-1)!);
  if (!stored) throw new Error('Expected a stored synthetic envelope.');
  return JSON.parse(Buffer.from(stored).toString('utf8')) as Record<string, unknown>;
}

describe('encrypted protected state workspace', () => {
  it('rejects workspace identities that are not canonical random UUIDs', () => {
    for (const workspaceId of [
      '', 'workspace', '6F0F7D6C-3D1A-4F7E-9D6B-2B6F5F7C1A01', '6f0f7d6c-3d1a-1f7e-9d6b-2b6f5f7c1a01',
      '6f0f7d6c-3d1a-4f7e-7d6b-2b6f5f7c1a01', '../6f0f7d6c-3d1a-4f7e-9d6b-2b6f5f7c1a01'
    ]) {
      expect(failureOf(() => vault(undefined, undefined, { workspaceId }))).toMatchObject({ code: 'protected-workspace-required' });
    }
  });

  it('stores nothing before availability is proven and serializes only an opaque handle', async () => {
    const storage = new RecordingArtifactStorage();
    const workspace = vault(storage);
    await expect(workspace.put('state', scope, secret)).rejects.toMatchObject({ code: 'protected-workspace-required' });
    await expect(workspace.describe(`${workspace.workspaceRef}/${randomUUID()}`, 'state', scope))
      .rejects.toMatchObject({ code: 'protected-workspace-required' });
    expect(storage.files.size).toBe(0);
    expect(JSON.stringify(workspace)).toBe(JSON.stringify({ workspaceRef: workspace.workspaceRef }));
    expect(workspace.workspaceRef).toMatch(/^state-workspace:[a-f0-9-]{36}$/);
  });

  it('bounds an unresponsive availability check and rejects invalid time bounds', async () => {
    const storage = new RecordingArtifactStorage();
    storage.availability = 'unresponsive';
    const hanging = vault(storage, undefined, { timeoutMs: 20 });
    await expect(hanging.assertAvailable(workspaceContext)).rejects.toMatchObject({ code: 'timeout' });
    await expect(hanging.put('state', scope, secret)).rejects.toMatchObject({ code: 'protected-workspace-required' });
    for (const timeoutMs of [0, -1, 120_001]) {
      await expect(vault(new RecordingArtifactStorage(), undefined, { timeoutMs }).assertAvailable(workspaceContext))
        .rejects.toMatchObject({ code: 'invalid-binding' });
    }
    expect(storage.files.size).toBe(0);
  });

  it('passes storage refusals through and redacts opaque availability failures', async () => {
    const storage = new RecordingArtifactStorage();
    storage.availability = 'unavailable';
    await expect(vault(storage).assertAvailable(workspaceContext)).rejects.toMatchObject({ code: 'protected-workspace-required' });
    storage.availability = 'opaque-failure';
    const failure = await vault(storage).assertAvailable(workspaceContext).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StateMigrationError);
    expect(failure).toMatchObject({ code: 'key-unavailable' });
    expect(String((failure as Error).message)).not.toContain(syntheticSecretState);
  });

  it.each([
    ['a different key reference', { keyRef: 'another-external-key' }],
    ['another owner', { ownerId: 'another-project' }],
    ['another host', { hostId: 'another-host' }],
    ['in-process key storage', { storage: 'process-memory' }],
    ['a different algorithm', { algorithm: 'aes-128-gcm' }]
  ])('refuses a key described for %s before requesting key material', async (_name, overrides) => {
    const storage = new RecordingArtifactStorage();
    const keys = new ExternalKeyProvider();
    keys.descriptorOverrides = overrides;
    await expect(vault(storage, keys).assertAvailable(workspaceContext)).rejects.toMatchObject({ code: 'key-unavailable' });
    expect(keys.withKeyCalls).toBe(0);
    expect(storage.files.size).toBe(0);
  });

  it('requires the external provider to supply exactly 256 bits of key material', async () => {
    for (const keyBytes of [16, 31, 33]) {
      const keys = new ExternalKeyProvider();
      keys.keyBytes = keyBytes;
      await expect(vault(new RecordingArtifactStorage(), keys).assertAvailable(workspaceContext))
        .rejects.toMatchObject({ code: 'key-unavailable' });
    }
    const locked = new ExternalKeyProvider();
    locked.locked = true;
    const failure = await vault(new RecordingArtifactStorage(), locked).assertAvailable(workspaceContext)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'key-unavailable' });
    expect(String((failure as Error).message)).not.toContain(syntheticSecretState);
  });

  it('forgets proven availability after a later failed check', async () => {
    const storage = new RecordingArtifactStorage();
    const keys = new ExternalKeyProvider();
    const workspace = await readyVault(storage, keys);
    await workspace.put('journal', scope, secret);
    keys.locked = true;
    await expect(workspace.assertAvailable(workspaceContext)).rejects.toMatchObject({ code: 'key-unavailable' });
    keys.locked = false;
    await expect(workspace.put('journal', scope, secret)).rejects.toMatchObject({ code: 'protected-workspace-required' });
    expect(storage.files.size).toBe(1);
  });

  it('seals each artifact under a fresh nonce and never stores its plaintext', async () => {
    const storage = new RecordingArtifactStorage();
    const workspace = await readyVault(storage);
    const first = await workspace.put('backup', scope, secret);
    const second = await workspace.put('backup', scope, secret);
    expect(first).toEqual({ ref: first.ref, digest: stateDigest(secret), purpose: 'backup', scope });
    expect(first.ref.startsWith(`${workspace.workspaceRef}/`)).toBe(true);
    expect(second.ref).not.toBe(first.ref);
    const [one, two] = [envelopeOf(storage, first.ref), envelopeOf(storage, second.ref)];
    expect(one).toMatchObject({ version: 1, keyRef: 'synthetic-external-key' });
    expect(Buffer.from(String(one.nonce), 'base64')).toHaveLength(12);
    expect(Buffer.from(String(one.tag), 'base64')).toHaveLength(16);
    expect(one.nonce).not.toBe(two.nonce);
    expect(one.ciphertext).not.toBe(two.ciphertext);
    for (const stored of storage.files.values()) {
      expect(Buffer.from(stored).toString('utf8')).not.toContain(syntheticSecretState);
    }
    expect(Buffer.from(await workspace.get(first.ref, 'backup', scope)).toString('utf8')).toBe(syntheticSecretState);
  });

  it('binds ciphertext to its workspace, artifact reference, purpose, scope and owner', async () => {
    const storage = new RecordingArtifactStorage();
    const keys = new ExternalKeyProvider();
    const workspaceId = randomUUID();
    const workspace = await readyVault(storage, keys, { workspaceId });
    const saved = await workspace.put('journal', scope, secret);
    const id = saved.ref.split('/').at(-1)!;

    await expect(workspace.get(saved.ref, 'backup', scope)).rejects.toMatchObject({ code: 'artifact-integrity' });
    await expect(workspace.get(saved.ref, 'journal', stateDigest('another-scope'))).rejects.toMatchObject({ code: 'artifact-integrity' });
    const substitute = randomUUID();
    storage.files.set(substitute, storage.files.get(id)!);
    await expect(workspace.get(`${workspace.workspaceRef}/${substitute}`, 'journal', scope))
      .rejects.toMatchObject({ code: 'artifact-integrity' });

    const neighbour = await readyVault(storage, keys);
    await expect(neighbour.get(`${neighbour.workspaceRef}/${id}`, 'journal', scope)).rejects.toMatchObject({ code: 'artifact-integrity' });
    const otherOwnerContext = executionContext(workspaceContext.projectRoot, { projectId: 'another-project' });
    const otherOwner = vault(storage, keys, { workspaceId, ownerId: 'another-project' });
    await otherOwner.assertAvailable(otherOwnerContext);
    await expect(otherOwner.get(saved.ref, 'journal', scope)).rejects.toMatchObject({ code: 'artifact-integrity' });
    expect(Buffer.from(await workspace.get(saved.ref, 'journal', scope)).toString('utf8')).toBe(syntheticSecretState);
  });

  it.each([
    ['non-JSON bytes', () => 'not an envelope'],
    ['an unknown envelope version', (envelope: Record<string, unknown>) => ({ ...envelope, version: 2 })],
    ['another key reference', (envelope: Record<string, unknown>) => ({ ...envelope, keyRef: 'another-external-key' })],
    ['a missing nonce', ({ nonce: _nonce, ...envelope }: Record<string, unknown>) => envelope],
    ['a short nonce', (envelope: Record<string, unknown>) => ({ ...envelope, nonce: Buffer.alloc(11).toString('base64') })],
    ['a truncated tag', (envelope: Record<string, unknown>) => ({ ...envelope, tag: Buffer.alloc(15).toString('base64') })],
    ['altered ciphertext', (envelope: Record<string, unknown>) => {
      const ciphertext = Buffer.from(String(envelope.ciphertext), 'base64');
      ciphertext[0] ^= 1;
      return { ...envelope, ciphertext: ciphertext.toString('base64') };
    }]
  ])('rejects %s as an integrity failure without returning plaintext', async (_name, tamper) => {
    const storage = new RecordingArtifactStorage();
    const workspace = await readyVault(storage);
    const saved = await workspace.put('state', scope, secret);
    const tampered = tamper(envelopeOf(storage, saved.ref));
    storage.files.set(saved.ref.split('/').at(-1)!, Buffer.from(typeof tampered === 'string' ? tampered : JSON.stringify(tampered)));
    await expect(workspace.get(saved.ref, 'state', scope)).rejects.toMatchObject({ code: 'artifact-integrity' });
    await expect(workspace.describe(saved.ref, 'state', scope)).rejects.toMatchObject({ code: 'artifact-integrity' });
  });

  it('refuses an oversized stored envelope before decrypting it', async () => {
    const storage = new RecordingArtifactStorage();
    const workspace = await readyVault(storage, undefined, { maxArtifactBytes: 16 });
    const saved = await workspace.put('state', scope, Buffer.from('small-state'));
    storage.files.set(saved.ref.split('/').at(-1)!, Buffer.alloc(16 * 2 + 4097, 0x7b));
    await expect(workspace.get(saved.ref, 'state', scope)).rejects.toMatchObject({ code: 'storage-limit' });
  });

  it('reports key loss during decryption as key-unavailable rather than tampering', async () => {
    const keys = new ExternalKeyProvider();
    const workspace = await readyVault(new RecordingArtifactStorage(), keys);
    const saved = await workspace.put('recovery', scope, secret);
    keys.locked = true;
    await expect(workspace.get(saved.ref, 'recovery', scope)).rejects.toMatchObject({ code: 'key-unavailable' });
    await expect(workspace.describe(saved.ref, 'recovery', scope)).rejects.toMatchObject({ code: 'key-unavailable' });
  });

  it('refuses purposes and scopes outside the artifact contract', async () => {
    const storage = new RecordingArtifactStorage();
    const workspace = await readyVault(storage);
    await expect(workspace.put('secrets' as StateArtifactPurpose, scope, secret)).rejects.toMatchObject({ code: 'artifact-purpose' });
    for (const badScope of ['', 'project-a', scope.toUpperCase(), `${scope}0`]) {
      await expect(workspace.put('state', badScope, secret)).rejects.toMatchObject({ code: 'artifact-purpose' });
    }
    expect(storage.files.size).toBe(0);
  });

  it('resolves only UUID artifact references inside this workspace', async () => {
    const workspace = await readyVault();
    const foreign = `state-workspace:${randomUUID()}/${randomUUID()}`;
    for (const ref of [foreign, `${workspace.workspaceRef}/../${randomUUID()}`, `${workspace.workspaceRef}/${randomUUID().toUpperCase()}`]) {
      await expect(workspace.get(ref, 'state', scope)).rejects.toMatchObject({ code: 'artifact-integrity' });
    }
    await expect(workspace.put('state', scope, secret, 'not-a-uuid' as ArtifactId)).rejects.toMatchObject({ code: 'artifact-integrity' });
  });

  it('never overwrites an existing artifact and passes other storage failures through unchanged', async () => {
    const storage = new RecordingArtifactStorage();
    const workspace = await readyVault(storage);
    const id = randomUUID();
    const saved = await workspace.put('backup', scope, secret, id);
    const envelope = Buffer.from(storage.files.get(id)!);
    await expect(workspace.put('backup', scope, Buffer.from('replacement'), id)).rejects.toMatchObject({ code: 'recovery-required' });
    expect(Buffer.from(storage.files.get(id)!).equals(envelope)).toBe(true);
    expect(Buffer.from(await workspace.get(saved.ref, 'backup', scope)).toString('utf8')).toBe(syntheticSecretState);

    storage.createFailure = new StateMigrationError('storage-limit');
    await expect(workspace.put('backup', scope, secret)).rejects.toMatchObject({ code: 'storage-limit' });
    const diskFailure = Object.assign(new Error('synthetic disk failure'), { code: 'EIO' });
    storage.createFailure = diskFailure;
    await expect(workspace.put('backup', scope, secret)).rejects.toBe(diskFailure);
    expect(storage.files.size).toBe(1);
  });

  it('verifies each write by reading it back and leaves an unverifiable copy visible', async () => {
    const storage = new RecordingArtifactStorage();
    storage.corruptStoredCopies = true;
    const workspace = await readyVault(storage);
    await expect(workspace.put('candidate', scope, secret)).rejects.toMatchObject({ code: 'artifact-integrity' });
    expect(storage.files.size).toBe(1);
  });

  it('bounds each artifact and the cumulative plaintext written through the workspace', async () => {
    const storage = new RecordingArtifactStorage();
    const workspace = await readyVault(storage, undefined, { maxArtifactBytes: 16, maxWrittenBytes: 40 });
    await expect(workspace.put('backup', scope, Buffer.alloc(17))).rejects.toMatchObject({ code: 'storage-limit' });
    const first = await workspace.put('backup', scope, Buffer.alloc(16, 1));
    await workspace.put('backup', scope, Buffer.alloc(16, 2));
    await expect(workspace.replace(first.ref, 'backup', scope, first.digest, Buffer.alloc(16, 3)))
      .rejects.toMatchObject({ code: 'storage-limit' });
    expect(Buffer.from(await workspace.get(first.ref, 'backup', scope))).toEqual(Buffer.alloc(16, 1));
    expect(storage.exchanges).toHaveLength(0);
  });

  it('describes present artifacts, reports absent ones as null and propagates other read failures', async () => {
    const storage = new RecordingArtifactStorage();
    const workspace = await readyVault(storage);
    const saved = await workspace.put('inspection', scope, secret);
    expect(await workspace.describe(saved.ref, 'inspection', scope)).toEqual(saved);
    await expect(workspace.describe(saved.ref, 'plan', scope)).rejects.toMatchObject({ code: 'artifact-integrity' });
    const denied = Object.assign(new Error('synthetic permission failure'), { code: 'EACCES' });
    storage.readFailure = denied;
    await expect(workspace.describe(saved.ref, 'inspection', scope)).rejects.toBe(denied);
    storage.readFailure = null;
    storage.files.delete(saved.ref.split('/').at(-1)!);
    expect(await workspace.describe(saved.ref, 'inspection', scope)).toBeNull();
  });

  it('replaces only from the exact prior plaintext, exchanging the exact prior envelope', async () => {
    const storage = new RecordingArtifactStorage();
    const workspace = await readyVault(storage);
    const saved = await workspace.put('journal', scope, Buffer.from('first-checkpoint'));
    const id = saved.ref.split('/').at(-1)!;
    const priorEnvelope = Buffer.from(storage.files.get(id)!);

    await expect(workspace.replace(saved.ref, 'journal', scope, stateDigest('another-checkpoint'), Buffer.from('forged')))
      .rejects.toMatchObject({ code: 'artifact-integrity' });
    expect(storage.exchanges).toHaveLength(0);
    const updated = await workspace.replace(saved.ref, 'journal', scope, saved.digest, Buffer.from('second-checkpoint'));
    expect(updated).toEqual({ ref: saved.ref, digest: stateDigest('second-checkpoint'), purpose: 'journal', scope });
    expect(storage.exchanges).toEqual([{ id, previousDigest: stateDigest(priorEnvelope) }]);
    expect(Buffer.from(await workspace.get(saved.ref, 'journal', scope)).toString('utf8')).toBe('second-checkpoint');
    await expect(workspace.removeExact(saved)).rejects.toMatchObject({ code: 'artifact-integrity' });
  });

  it('removes only the authenticated artifact whose descriptor still matches', async () => {
    const storage = new RecordingArtifactStorage();
    const workspace = await readyVault(storage);
    const target = await workspace.put('backup', scope, secret);
    const neighbour = await workspace.put('backup', scope, secret);
    const id = target.ref.split('/').at(-1)!;
    const envelope = Buffer.from(storage.files.get(id)!);

    await expect(workspace.removeExact({ ...target, digest: stateDigest('another-backup') }))
      .rejects.toMatchObject({ code: 'artifact-integrity' });
    await expect(workspace.removeExact({ ...target, purpose: 'plan' })).rejects.toMatchObject({ code: 'artifact-integrity' });
    expect(storage.removals).toHaveLength(0);
    await workspace.removeExact(target);
    expect(storage.removals).toEqual([{ id, expectedDigest: stateDigest(envelope) }]);
    expect(await workspace.describe(target.ref, 'backup', scope)).toBeNull();
    expect(await workspace.describe(neighbour.ref, 'backup', scope)).toEqual(neighbour);
  });

  it('proves availability before lending protected scratch space', async () => {
    const storage = new RecordingArtifactStorage();
    storage.availability = 'unavailable';
    const action = vi.fn(async (directory: string) => `used ${directory}`);
    await expect(vault(storage).withScratch(workspaceContext, action)).rejects.toMatchObject({ code: 'protected-workspace-required' });
    expect(action).not.toHaveBeenCalled();
    expect(storage.scratchRuns).toBe(0);
    storage.availability = 'ready';
    expect(await vault(storage).withScratch(workspaceContext, action)).toBe(`used ${path.join(path.sep, 'synthetic-protected-scratch')}`);
    expect(storage.scratchRuns).toBe(1);
  });
});

async function privateLayout(prefix: string): Promise<{
  root: string; store: string; project: string; context: StateExecutionContext; attestor: ProtectedVolumeProof;
}> {
  const root = await ownedDirectory(prefix);
  const store = await privateDirectory(root, 'store');
  const project = await privateDirectory(root, 'project');
  return { root, store, project, context: executionContext(project), attestor: new ProtectedVolumeProof() };
}

describe('private state path protection', () => {
  it('accepts an owner-only directory outside the project once the attestor proves protection', async () => {
    const { store, context, attestor } = await privateLayout('private-accept');
    await expect(assertPrivateStatePath(store, context, attestor, true)).resolves.toBeUndefined();
    const statePath = path.join(store, 'destination.tfstate');
    await expect(assertPrivateStatePath(statePath, context, attestor, false)).resolves.toBeUndefined();
    await writeFile(statePath, '{}', { mode: 0o600 });
    await expect(assertPrivateStatePath(statePath, context, attestor, false)).resolves.toBeUndefined();
    expect(attestor.verified).toEqual([store, store, store]);
  });

  it.each([
    ['a relative path', (_store: string, _project: string) => 'store'],
    ['a non-normalized path', (store: string) => `${store}${path.sep}..${path.sep}store`],
    ['the project root', (_store: string, project: string) => project],
    ['a path inside the project', (_store: string, project: string) => path.join(project, 'state')],
    ['a case variant inside the project', (_store: string, project: string) => path.join(project.toUpperCase(), 'state')]
  ])('rejects %s before consulting the attestor', async (_name, select) => {
    const { store, project, context, attestor } = await privateLayout('private-shape');
    await expect(assertPrivateStatePath(select(store, project), context, attestor, true)).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(attestor.verified).toEqual([]);
  });

  it('rejects missing, linked and non-directory locations', async () => {
    const { root, store, context, attestor } = await privateLayout('private-kind');
    const file = path.join(root, 'plain-file');
    await writeFile(file, 'not a directory', { mode: 0o600 });
    const alias = path.join(root, 'linked-store');
    await directoryLink(store, alias);
    for (const [target, directory] of [
      [path.join(root, 'missing'), true], [file, true], [path.join(file, 'state.tfstate'), false],
      [alias, true], [path.join(alias, 'state.tfstate'), false]
    ] as const) {
      await expect(assertPrivateStatePath(target, context, attestor, directory)).rejects.toMatchObject({ code: 'unsafe-path' });
    }
    expect(attestor.verified).toEqual([]);
  });

  it.each([
    ['a Git directory', async (checkout: string) => { await mkdir(path.join(checkout, '.git')); }],
    ['a linked-worktree .git file', async (checkout: string) => {
      await writeFile(path.join(checkout, '.git'), 'gitdir: /synthetic/worktree\n', { mode: 0o600 });
    }]
  ])('rejects protected storage anywhere inside a checkout with %s', async (_name, mark) => {
    const { root, context, attestor } = await privateLayout('private-git');
    const checkout = await privateDirectory(root, 'checkout');
    await mark(checkout);
    const nested = await privateDirectory(checkout, 'nested', 'state');
    await expect(assertPrivateStatePath(nested, context, attestor, true)).rejects.toMatchObject({ code: 'unsafe-path' });
    await expect(assertPrivateStatePath(path.join(nested, 'state.tfstate'), context, attestor, false))
      .rejects.toMatchObject({ code: 'unsafe-path' });
    expect(attestor.verified).toEqual([]);
  });

  it('rejects a non-canonical alias of the protected directory', async () => {
    const { root, context, attestor } = await privateLayout('private-alias');
    await expect(assertPrivateStatePath(path.join(root, 'STORE'), context, attestor, true)).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(attestor.verified).toEqual([]);
  });

  it.skipIf(!posix)('rejects group- or world-accessible protected directories', async () => {
    const { store, context, attestor } = await privateLayout('private-mode');
    for (const mode of [0o750, 0o705, 0o770]) {
      await chmod(store, mode);
      await expect(assertPrivateStatePath(store, context, attestor, true)).rejects.toMatchObject({ code: 'unsafe-path' });
    }
    await chmod(store, 0o700);
    expect(attestor.verified).toEqual([]);
  });

  it.skipIf(!posix || superuser)('rejects a directory whose Git marker cannot be inspected', async () => {
    const { store, context, attestor } = await privateLayout('private-unsearchable');
    await chmod(store, 0o600);
    try {
      await expect(assertPrivateStatePath(store, context, attestor, true)).rejects.toMatchObject({ code: 'unsafe-path' });
    } finally {
      await chmod(store, 0o700);
    }
    expect(attestor.verified).toEqual([]);
  });

  it.each([
    ['the same canonical directory', (root: string) => ({ canonicalDirectory: path.join(root, 'elsewhere') })],
    ['the executing host', () => ({ hostId: 'another-host' })],
    ['an encrypted volume', () => ({ encryptedVolume: false })],
    ['private access', () => ({ privateAccess: false })],
    ['the protected storage class', () => ({ storageClass: 'shared-cache' })],
    ['an unexpired attestation', () => ({ expiresAt: 1_000 })]
  ])('requires the attestation to prove %s', async (_name, overrides) => {
    const { root, store, context, attestor } = await privateLayout('private-proof');
    attestor.proofOverrides = overrides(root);
    await expect(assertPrivateStatePath(store, context, attestor, true, 1_000))
      .rejects.toMatchObject({ code: 'protected-workspace-required' });
    attestor.proofOverrides = { expiresAt: 1_001 };
    await expect(assertPrivateStatePath(store, context, attestor, true, 1_000)).resolves.toBeUndefined();
  });

  it('accepts only an absent or single-link regular state file', async () => {
    const { root, store, context, attestor } = await privateLayout('private-file');
    const directoryTarget = await privateDirectory(store, 'directory.tfstate');
    const original = path.join(store, 'original.tfstate');
    await writeFile(original, '{}', { mode: 0o600 });
    const linked = path.join(store, 'hard-linked.tfstate');
    await link(original, linked);
    for (const target of [directoryTarget, original, linked]) {
      await expect(assertPrivateStatePath(target, context, attestor, false)).rejects.toMatchObject({ code: 'unsafe-path' });
    }
    await rm(linked);
    await expect(assertPrivateStatePath(original, context, attestor, false)).resolves.toBeUndefined();
    expect(await readFile(original, 'utf8')).toBe('{}');
    expect(await exists(root)).toBe(true);
  });

  it.skipIf(!posix)('rejects shared, symlinked or unresolvable state file names', async () => {
    const { store, context, attestor } = await privateLayout('private-file-posix');
    const shared = path.join(store, 'shared.tfstate');
    await writeFile(shared, '{}', { mode: 0o640 });
    const target = path.join(store, 'target.tfstate');
    await writeFile(target, '{}', { mode: 0o600 });
    const symbolic = path.join(store, 'symbolic.tfstate');
    await symlink(target, symbolic);
    for (const candidate of [shared, symbolic, path.join(store, `${'n'.repeat(300)}.tfstate`)]) {
      await expect(assertPrivateStatePath(candidate, context, attestor, false)).rejects.toMatchObject({ code: 'unsafe-path' });
    }
    expect(await readFile(target, 'utf8')).toBe('{}');
  });
});

describe('existing project state source protection', () => {
  async function sourceLayout(prefix: string): Promise<{ root: string; project: string; context: StateExecutionContext }> {
    const root = await ownedDirectory(prefix);
    const project = await privateDirectory(root, 'project');
    await privateDirectory(project, 'infra', 'env');
    return { root, project, context: executionContext(project) };
  }

  it('accepts an absent or owner-only single-link state file below the project', async () => {
    const { project, context } = await sourceLayout('source-accept');
    const statePath = path.join(project, 'infra', 'env', 'terraform.tfstate');
    await expect(assertExistingStateSourcePath(statePath, context)).resolves.toBeUndefined();
    await writeFile(statePath, '{"synthetic":"existing"}', { mode: 0o600 });
    await expect(assertExistingStateSourcePath(statePath, context)).resolves.toBeUndefined();
    expect(await readFile(statePath, 'utf8')).toBe('{"synthetic":"existing"}');
  });

  it.each([
    ['a relative path', () => path.join('infra', 'terraform.tfstate')],
    ['a non-normalized path', (project: string) => `${project}${path.sep}infra${path.sep}..${path.sep}terraform.tfstate`],
    ['a path outside the project', (project: string) => path.join(path.dirname(project), 'terraform.tfstate')],
    ['the project root itself', (project: string) => project],
    ['a Git directory entry', (project: string) => path.join(project, '.git', 'terraform.tfstate')],
    ['a case variant of a nested Git directory', (project: string) => path.join(project, 'infra', '.GIT', 'terraform.tfstate')]
  ])('rejects %s', async (_name, select) => {
    const { project, context } = await sourceLayout('source-shape');
    await expect(assertExistingStateSourcePath(select(project), context)).rejects.toMatchObject({ code: 'unsafe-path' });
  });

  it('rejects a project root that is not its canonical path', async () => {
    const { root, project } = await sourceLayout('source-root-alias');
    const alias = path.join(root, 'project-alias');
    await directoryLink(project, alias);
    await expect(assertExistingStateSourcePath(path.join(alias, 'infra', 'terraform.tfstate'), executionContext(alias)))
      .rejects.toMatchObject({ code: 'unsafe-path' });
  });

  it('rejects a linked directory between the state file and the project root', async () => {
    const { root, project, context } = await sourceLayout('source-link');
    const outside = await privateDirectory(root, 'outside');
    await writeFile(path.join(outside, 'terraform.tfstate'), '{"outside":true}', { mode: 0o600 });
    await directoryLink(outside, path.join(project, 'infra', 'linked'));
    await expect(assertExistingStateSourcePath(path.join(project, 'infra', 'linked', 'terraform.tfstate'), context))
      .rejects.toMatchObject({ code: 'unsafe-path' });
    expect(await readFile(path.join(outside, 'terraform.tfstate'), 'utf8')).toBe('{"outside":true}');
  });

  it('rejects linked or directory state sources', async () => {
    const { project, context } = await sourceLayout('source-file');
    const original = path.join(project, 'infra', 'terraform.tfstate');
    await writeFile(original, '{}', { mode: 0o600 });
    await link(original, path.join(project, 'infra', 'env', 'terraform.tfstate'));
    await privateDirectory(project, 'infra', 'directory.tfstate');
    for (const target of [original, path.join(project, 'infra', 'directory.tfstate')]) {
      await expect(assertExistingStateSourcePath(target, context)).rejects.toMatchObject({ code: 'unsafe-path' });
    }
  });

  it.skipIf(!posix)('rejects group-readable, symlinked or unresolvable state sources', async () => {
    const { root, project, context } = await sourceLayout('source-file-posix');
    const shared = path.join(project, 'infra', 'shared.tfstate');
    await writeFile(shared, '{}', { mode: 0o644 });
    const outside = path.join(root, 'outside.tfstate');
    await writeFile(outside, '{}', { mode: 0o600 });
    await symlink(outside, path.join(project, 'infra', 'symbolic.tfstate'));
    for (const target of [shared, path.join(project, 'infra', 'symbolic.tfstate'), path.join(project, 'infra', `${'n'.repeat(300)}.tfstate`)]) {
      await expect(assertExistingStateSourcePath(target, context)).rejects.toMatchObject({ code: 'unsafe-path' });
    }
  });

  it('fails closed when an intermediate directory is missing', async () => {
    const { project, context } = await sourceLayout('source-missing');
    await expect(assertExistingStateSourcePath(path.join(project, 'absent', 'terraform.tfstate'), context)).rejects.toThrow();
  });
});

describe('filesystem protected artifact storage', () => {
  async function storageLayout(prefix: string, maxStoredBytes?: number) {
    const layout = await privateLayout(prefix);
    const storage = new FilesystemProtectedArtifactStorage(layout.store, layout.attestor, maxStoredBytes);
    return { ...layout, storage };
  }

  it('stores owner-only artifacts durably, reads back exact bytes and never exposes its location', async () => {
    const { store, context, storage } = await storageLayout('store-roundtrip');
    await storage.assertAvailable(context);
    const id = randomUUID();
    await storage.create(id, Buffer.from('sealed-synthetic-envelope'));
    expect(Buffer.from(await storage.read(id)).toString('utf8')).toBe('sealed-synthetic-envelope');
    expect(await readdir(store)).toEqual([`${id}.sealed`]);
    if (posix) expect((await stat(path.join(store, `${id}.sealed`))).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(storage)).toBe(JSON.stringify({ storage: 'protected-external' }));
    expect(JSON.stringify(storage)).not.toContain(store);
  });

  it('resolves artifact files only after availability and only for UUID identities', async () => {
    const { context, storage } = await storageLayout('store-identity');
    await expect(storage.read(randomUUID())).rejects.toMatchObject({ code: 'artifact-integrity' });
    await storage.assertAvailable(context);
    for (const id of ['artifact', `..${path.sep}${randomUUID()}`, randomUUID().toUpperCase()]) {
      await expect(storage.create(id, Buffer.from('x'))).rejects.toMatchObject({ code: 'artifact-integrity' });
    }
  });

  it('refuses to replace an existing artifact through create, which the workspace reports as recovery', async () => {
    const { store, context, storage } = await storageLayout('store-exclusive');
    await storage.assertAvailable(context);
    const id = randomUUID();
    await storage.create(id, Buffer.from('first-envelope'));
    await expect(storage.create(id, Buffer.from('second-envelope'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path.join(store, `${id}.sealed`), 'utf8')).toBe('first-envelope');

    const workspace = await readyVault(storage);
    const saved = await workspace.put('backup', scope, secret);
    const savedId = saved.ref.split('/').at(-1)! as ArtifactId;
    await expect(workspace.put('backup', scope, Buffer.from('replacement'), savedId)).rejects.toMatchObject({ code: 'recovery-required' });
    expect(Buffer.from(await workspace.get(saved.ref, 'backup', scope)).toString('utf8')).toBe(syntheticSecretState);
    expect((await readdir(store)).sort()).toEqual([`${id}.sealed`, `${savedId}.sealed`].sort());
  });

  it('enforces the store quota across artifacts and protected scratch contents', async () => {
    const { store, context, storage } = await storageLayout('store-quota', 100);
    await storage.assertAvailable(context);
    await expect(storage.create(randomUUID(), Buffer.alloc(101))).rejects.toMatchObject({ code: 'storage-limit' });
    await storage.create(randomUUID(), Buffer.alloc(60));
    const rejected = randomUUID();
    await expect(storage.create(rejected, Buffer.alloc(41))).rejects.toMatchObject({ code: 'storage-limit' });
    expect(await exists(path.join(store, `${rejected}.sealed`))).toBe(false);
    await storage.withScratch(context, async (directory) => {
      await writeFile(path.join(directory, 'native-output'), Buffer.alloc(40), { mode: 0o600 });
      await expect(storage.create(randomUUID(), Buffer.alloc(1))).rejects.toMatchObject({ code: 'storage-limit' });
    });
    await storage.create(randomUUID(), Buffer.alloc(40));
    expect(await exists(path.join(store, '.liftoff-state-store.guard'))).toBe(false);
  });

  it('refuses allocation while another writer holds the store guard and leaves that guard intact', async () => {
    const { store, context, storage } = await storageLayout('store-guard');
    await storage.assertAvailable(context);
    const guard = path.join(store, '.liftoff-state-store.guard');
    await writeFile(guard, 'held by another synthetic writer', { mode: 0o600 });
    const id = randomUUID();
    await expect(storage.create(id, Buffer.from('envelope'))).rejects.toMatchObject({ code: 'lock-unavailable' });
    expect(await readFile(guard, 'utf8')).toBe('held by another synthetic writer');
    expect(await exists(path.join(store, `${id}.sealed`))).toBe(false);
  });

  it('exchanges only the expected envelope and leaves no staging or guard files', async () => {
    const { store, context, storage } = await storageLayout('store-exchange');
    await storage.assertAvailable(context);
    const id = randomUUID();
    await storage.create(id, Buffer.from('first-envelope'));
    await expect(storage.compareExchange(id, stateDigest('another-envelope'), Buffer.from('forged-envelope')))
      .rejects.toMatchObject({ code: 'artifact-integrity' });
    expect(await readFile(path.join(store, `${id}.sealed`), 'utf8')).toBe('first-envelope');
    await storage.compareExchange(id, stateDigest('first-envelope'), Buffer.from('second-envelope'));
    expect(Buffer.from(await storage.read(id)).toString('utf8')).toBe('second-envelope');
    expect(await readdir(store)).toEqual([`${id}.sealed`]);
  });

  it('refuses writers while another holds the artifact guard and leaves that guard intact', async () => {
    const { store, context, storage } = await storageLayout('store-artifact-guard');
    await storage.assertAvailable(context);
    const id = randomUUID();
    await storage.create(id, Buffer.from('first-envelope'));
    const guard = path.join(store, `${id}.sealed.guard`);
    await writeFile(guard, 'held', { mode: 0o600 });
    await expect(storage.compareExchange(id, stateDigest('first-envelope'), Buffer.from('second-envelope')))
      .rejects.toMatchObject({ code: 'lock-unavailable' });
    await expect(storage.remove(id, stateDigest('first-envelope'))).rejects.toMatchObject({ code: 'lock-unavailable' });
    expect(await readFile(path.join(store, `${id}.sealed`), 'utf8')).toBe('first-envelope');
    expect(await readFile(guard, 'utf8')).toBe('held');
    expect((await readdir(store)).sort()).toEqual([`${id}.sealed`, `${id}.sealed.guard`].sort());
  });

  it('removes an artifact only when its envelope digest still matches', async () => {
    const { store, context, storage } = await storageLayout('store-remove');
    await storage.assertAvailable(context);
    const id = randomUUID();
    await storage.create(id, Buffer.from('envelope'));
    await expect(storage.remove(id, stateDigest('another-envelope'))).rejects.toMatchObject({ code: 'artifact-integrity' });
    expect(await exists(path.join(store, `${id}.sealed`))).toBe(true);
    await storage.remove(id, stateDigest('envelope'));
    expect(await readdir(store)).toEqual([]);
  });

  it('refuses hard-linked or oversized artifact files', async () => {
    const { root, store, context, storage } = await storageLayout('store-files', 32);
    await storage.assertAvailable(context);
    const linkedId = randomUUID();
    await storage.create(linkedId, Buffer.from('envelope'));
    await link(path.join(store, `${linkedId}.sealed`), path.join(root, 'outside-link'));
    await expect(storage.read(linkedId)).rejects.toMatchObject({ code: 'unsafe-path' });
    const oversizedId = randomUUID();
    await writeFile(path.join(store, `${oversizedId}.sealed`), Buffer.alloc(33), { mode: 0o600 });
    await expect(storage.read(oversizedId)).rejects.toMatchObject({ code: 'artifact-integrity' });
  });

  it('lends a private scratch directory and removes it after success or failure', async () => {
    const { store, context, storage } = await storageLayout('store-scratch');
    let lent = '';
    const value = await storage.withScratch(context, async (directory) => {
      lent = directory;
      expect(path.dirname(directory)).toBe(store);
      expect(path.basename(directory)).toMatch(/^native-[a-f0-9-]{36}$/);
      if (posix) expect((await stat(directory)).mode & 0o777).toBe(0o700);
      await writeFile(path.join(directory, 'native-output'), 'synthetic', { mode: 0o600 });
      return 'native-result';
    });
    expect(value).toBe('native-result');
    expect(await exists(lent)).toBe(false);
    const failure = new Error('synthetic native failure');
    await expect(storage.withScratch(context, async (directory) => {
      lent = directory;
      throw failure;
    })).rejects.toBe(failure);
    expect(await exists(lent)).toBe(false);
    expect(await readdir(store)).toEqual([]);
  });

  it('retains scratch whose native process termination is unproven', async () => {
    const { context, storage } = await storageLayout('store-unproven');
    let lent = '';
    await expect(storage.withScratch(context, async (directory) => {
      lent = directory;
      await writeFile(path.join(directory, 'native-output'), 'synthetic', { mode: 0o600 });
      throw new StateMigrationError('process-tree-termination-unproven');
    })).rejects.toMatchObject({ code: 'process-tree-termination-unproven' });
    expect(await readFile(path.join(lent, 'native-output'), 'utf8')).toBe('synthetic');
  });

  it.skipIf(!posix)('refuses to delete through a scratch directory swapped for a link', async () => {
    const { root, context, storage } = await storageLayout('store-swap');
    const sentinel = await privateDirectory(root, 'sentinel');
    await writeFile(path.join(sentinel, 'keep'), 'must survive', { mode: 0o600 });
    let lent = '';
    await expect(storage.withScratch(context, async (directory) => {
      lent = directory;
      await rename(directory, path.join(root, 'moved-scratch'));
      await symlink(sentinel, directory);
      return 'native-result';
    })).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(await readFile(path.join(sentinel, 'keep'), 'utf8')).toBe('must survive');
    expect((await lstat(lent)).isSymbolicLink()).toBe(true);
  });

  it.skipIf(!posix)('bounds the quota scan to ten thousand entries', async () => {
    const { store, context, storage } = await storageLayout('store-entries');
    await storage.assertAvailable(context);
    const names = Array.from({ length: 10_001 }, (_, index) => path.join(store, `entry-${index}`));
    for (let index = 0; index < names.length; index += 500) {
      await Promise.all(names.slice(index, index + 500).map((name) => writeFile(name, '', { mode: 0o600 })));
    }
    const id = randomUUID();
    await expect(storage.create(id, Buffer.from('envelope'))).rejects.toMatchObject({ code: 'storage-limit' });
    expect(await exists(path.join(store, `${id}.sealed`))).toBe(false);
    expect(await exists(path.join(store, '.liftoff-state-store.guard'))).toBe(false);
  }, 60_000);
});

describe('protected state scope', () => {
  it('derives one stable scope per project root, project identity and host', () => {
    const base = executionContext(path.join(path.sep, 'synthetic', 'project'));
    const scopeDigest = protectedStateScope(base);
    expect(scopeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(scopeDigest).toBe(stateObjectDigest({ projectId: base.projectId, projectRoot: base.projectRoot, hostId: base.hostId }));
    expect(protectedStateScope({ ...base, configurationDigest: stateDigest('changed'), principalId: 'another-principal' }))
      .toBe(scopeDigest);
    for (const changed of [
      { ...base, projectId: 'another-project' },
      { ...base, projectRoot: path.join(path.sep, 'synthetic', 'another-project') },
      { ...base, hostId: 'another-host' }
    ]) {
      expect(protectedStateScope(changed)).not.toBe(scopeDigest);
    }
  });
});

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

function presentPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

const expectedChecks = [
  'exact-installed-tofu-1.12.6', 'registered-cpython-3.14', 'verified-pinned-fcntl-source',
  'acquisition-preserves-exact-pre-acquire-metadata',
  'native-tofu-blocked-by-fcntl-holder', 'observer-fd-close-preserves-holder-lock',
  'fcntl-holder-blocked-by-native-tofu-console',
  'actual-native-module-address-move', 'same-lineage-and-resource-identity', 'actual-native-no-change-plan',
  'native-exclusion-survives-in-place-publication',
  'native-writer-can-lock-a-replaced-inode', 'newer-native-write-preserved-after-lock-loss',
  'native-pending-apply-can-lock-an-unlinked-path', 'new-native-lock-metadata-preserved',
  'inode-preserving-conditional-publication', 'stale-publication-rejected', 'absent-destination-unsupported',
  'unlink-retirement-unsupported', 'uncoordinated-inode-replacement-detected'
];

// Each row is a protocol property the qualification exists to prove; a host or helper
// that violates it must never yield a verified result.
const protocolViolations: Array<[string, SimulatedNativeFaults, string]> = [
  ['the installed tools are not the pinned combination', { toolsRejected: 'unqualified-combination' }, 'unqualified-combination'],
  ['native initialisation fails', { failingCommand: 'init' }, 'native-command-failed'],
  ['the fixture apply fails', { failingCommand: 'apply' }, 'native-command-failed'],
  ['the fixture apply creates an unexpected resource', { extraFixtureResource: true }, 'verification-incomplete'],
  ['acquiring the holder changes state metadata', { acquisitionTouchesState: true }, 'verification-incomplete'],
  ['a native writer ignores the holder lock', { observerIgnoresHolderLock: true }, 'verification-incomplete'],
  ['a native refusal is not a lock refusal', { denialWithoutLockMessage: true }, 'verification-incomplete'],
  ['releasing the holder leaves its lock metadata', { releaseLeavesMarker: true }, 'verification-incomplete'],
  ['the native console exits before locking', { consoleExitsBeforeLocking: true }, 'native-command-failed'],
  ['the holder ignores a native console lock', { holderIgnoresNativeLock: true }, 'verification-incomplete'],
  ['the holder refuses a native lock with another failure', { holderDenial: 'stale-state' }, 'verification-incomplete'],
  ['the holder refuses a native lock without a state failure code', { holderDenial: 'untyped' }, 'verification-incomplete'],
  ['the native console fails after its input', { consoleExitCode: 1 }, 'verification-incomplete'],
  ['the native console is terminated by a signal', { consoleExitCode: null }, 'verification-incomplete'],
  ['a module move changes lineage', { moveDrift: 'lineage' }, 'verification-incomplete'],
  ['a module move changes resource identity', { moveDrift: 'id' }, 'verification-incomplete'],
  ['a module move does not advance the serial', { moveDrift: 'serial' }, 'verification-incomplete'],
  ['a module move lands at another address', { moveDrift: 'address' }, 'verification-incomplete'],
  ['the saved plan reports changes by exit code', { planExitCode: 2 }, 'native-command-failed'],
  ['the saved plan contains a resource change', { planShowsChange: true }, 'resource-change'],
  ['publication replaces the state inode', { publicationRenames: true }, 'verification-incomplete'],
  ['publication drops native exclusion', { publishedWriteUnlocked: true }, 'verification-incomplete'],
  ['the holder permits state removal', { holderAllowsRemove: true }, 'verification-incomplete'],
  ['the holder refuses removal with another failure', { removeDenial: 'lock-lost' }, 'verification-incomplete'],
  ['the holder refuses removal without a state failure code', { removeDenial: 'untyped' }, 'verification-incomplete'],
  ['the holder accepts a stale publication', { holderAcceptsStaleReplace: true }, 'verification-incomplete'],
  ['the holder misses an uncoordinated inode replacement', { holderMissesInodeChange: true }, 'verification-incomplete'],
  ['a pending native apply is accepted', { pendingApplyAccepted: true }, 'verification-incomplete'],
  ['an absent destination is refused with another failure', { absentDenial: 'lock-unavailable' }, 'verification-incomplete'],
  ['an absent destination is refused without a state failure code', { absentDenial: 'untyped' }, 'verification-incomplete']
];

// The protocol is macOS-only; POSIX CI hosts are presented as darwin so the orchestration
// runs against the simulated host. Windows lacks the POSIX open-inode semantics simulated here.
describe.skipIf(!posix)('native local-state qualification on a simulated POSIX host', () => {
  let scratch: string;
  let native: SimulatedNativeLocalState;

  function start(faults: SimulatedNativeFaults = {}): SimulatedNativeLocalState {
    native = new SimulatedNativeLocalState(nativeStateHostId(), faults);
    simulation.current = native;
    return native;
  }

  function qualify(signal?: AbortSignal) {
    return qualifyNativeLocalState({ pythonPath: native.pythonPath, tofuPath: native.tofuPath, scratchParent: scratch, signal });
  }

  async function expectSettled(): Promise<void> {
    expect(await readdir(scratch)).toEqual([]);
    expect(native.leases.size).toBe(0);
    expect(native.activeLocks).toBe(0);
    expect(native.runningProcesses).toEqual([]);
    expect(native.stoppedDirectories).toEqual(native.scratchRoot ? [native.scratchRoot] : []);
  }

  beforeEach(async () => {
    if (process.platform !== 'darwin') presentPlatform('darwin');
    scratch = await ownedDirectory('native');
  });

  afterEach(async () => {
    const active = simulation.current;
    simulation.current = undefined;
    await active?.dispose();
    Object.defineProperty(process, 'platform', platformDescriptor);
    expect(active?.backgroundFailures ?? []).toEqual([]);
  });

  it('qualifies the pinned lock protocol using only disposable synthetic state', async () => {
    start();
    const { tools, result } = await qualify();
    const root = native.scratchRoot!;
    expect(tools).toBe(native.tools);
    expect(result).toEqual({
      schemaVersion: 1, kind: 'native-local-state-qualification', status: 'verified', platform: 'darwin',
      hostRef: nativeStateHostId(), tofuVersion: '1.12.6',
      tofuBinaryDigest: native.tools.tofu.sha256, pythonBinaryDigest: native.tools.python.sha256,
      protocolDigest: stateObjectDigest({ protocol: nativeLocalStateProtocol, helper: stateDigest(posixStateLockProgram) }),
      sourceCommit: nativeLocalStateProtocol.sourceCommit, observedAt: expect.any(Number), checks: expectedChecks,
      stateScope: 'synthetic-disposable-only', azureLiveQualification: 'not-performed', atomicStateReplacement: false
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.checks)).toBe(true);
    expect(isActualNativeLocalQualification(result, tools)).toBe(true);

    // Every native effect stayed inside one fresh disposable root with isolated provider installation.
    expect(path.dirname(root)).toBe(scratch);
    expect(path.basename(root)).toMatch(/^state-native-qualification-[a-f0-9-]{36}$/);
    expect(native.isolatedInitialisations).toEqual([true, true, true]);
    for (const command of [...native.commands, ...native.processes]) {
      expect(isWithin(root, command.cwd)).toBe(true);
      for (const arg of command.args) {
        const target = /^-(?:state|out)=(.*)$/.exec(arg)?.[1];
        if (target) expect(isWithin(root, target)).toBe(true);
      }
    }
    const approved = native.commands.filter((command) => command.args.includes('-auto-approve'));
    expect(approved).toEqual([{ args: ['apply', '-input=false', '-no-color', '-auto-approve'], cwd: root }]);
    for (const command of [...native.commands.filter((entry) => entry.args[0] === 'state'), ...native.processes]) {
      expect(command.args).toEqual(expect.arrayContaining(['-lock=true', '-lock-timeout=0s']));
    }
    expect(native.processes.map((child) => [child.args[0], child.input, child.exitCode])).toEqual([
      ['console', '1 + 1\n', 0],
      ['apply', 'no\n', 1]
    ]);
    expect(native.acquisitions.at(-1)).toEqual({ path: path.join(root, 'absent.tfstate'), expectedVersion: null });

    // Disposable state is removed, every lease and native process is settled, and native output is scrubbed.
    await expectSettled();
    expect(native.outputs.length).toBeGreaterThan(0);
    for (const output of [...native.outputs, ...native.emitted]) {
      expect(Buffer.from(output).every((byte) => byte === 0)).toBe(true);
    }
  });

  it('recognises only the exact qualification object issued for the same tools and host', async () => {
    start();
    const { tools, result } = await qualify();
    expect(isActualNativeLocalQualification(structuredClone(result), tools)).toBe(false);
    expect(isActualNativeLocalQualification(Object.freeze({ ...result }), tools)).toBe(false);
    expect(isActualNativeLocalQualification(result, { ...tools, hostId: 'native-host:another' })).toBe(false);
    expect(isActualNativeLocalQualification(result, { ...tools, tofu: { ...tools.tofu, sha256: stateDigest('another-tofu') } }))
      .toBe(false);
    expect(isActualNativeLocalQualification(result, { ...tools, python: { ...tools.python, sha256: stateDigest('another-python') } }))
      .toBe(false);
  });

  it('treats a pending apply killed while prompting as declined rather than approved', async () => {
    start({ pendingApplyKilled: true });
    const { result } = await qualify();
    expect(result.status).toBe('verified');
    expect(native.processes.map((child) => [child.args[0], child.exitCode, child.signalCode])).toEqual([
      ['console', 0, null],
      ['apply', null, 'SIGKILL']
    ]);
    await expectSettled();
  });

  it.each(protocolViolations)('fails closed when %s', async (_name, faults, code) => {
    start(faults);
    const failure = await qualify().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StateMigrationError);
    expect(failure).toMatchObject({ code });
    await expectSettled();
  });

  it('fails closed when a stale holder deletes the new native owner lock metadata', async () => {
    start({ releaseRemovesForeignMarker: true });
    await expect(qualify()).rejects.toThrow();
    expect(native.stoppedProcesses.map((child) => child.args[0])).toEqual(['apply']);
    await expectSettled();
  });

  it('stops waiting for a native lock when the qualification is cancelled', async () => {
    const controller = new AbortController();
    start({ abortWhenConsoleStarts: controller });
    await expect(qualify(controller.signal)).rejects.toMatchObject({ code: 'native-command-failed' });
    expect(native.stoppedProcesses.map((child) => child.args[0])).toEqual(['console']);
    await expectSettled();
  });

  it('honours cancellation before running any native command', async () => {
    start();
    const controller = new AbortController();
    controller.abort();
    await expect(qualify(controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(native.commands).toEqual([]);
    await expectSettled();
  });

  it.each(['linux', 'win32'] as const)('refuses %s hosts before creating scratch state or inspecting tools', async (platform) => {
    start();
    presentPlatform(platform);
    await expect(qualify()).rejects.toMatchObject({ code: 'unsupported-native-platform' });
    expect(await readdir(scratch)).toEqual([]);
    expect(native.scratchRoot).toBeNull();
  });

  it('requires the scratch parent to be an existing real directory', async () => {
    start();
    const file = path.join(scratch, 'not-a-directory');
    await writeFile(file, '', { mode: 0o600 });
    const target = await privateDirectory(scratch, 'target');
    const alias = path.join(scratch, 'alias');
    await symlink(target, alias);
    for (const scratchParent of [file, alias]) {
      await expect(qualifyNativeLocalState({ pythonPath: native.pythonPath, tofuPath: native.tofuPath, scratchParent }))
        .rejects.toMatchObject({ code: 'unsafe-path' });
    }
    await expect(qualifyNativeLocalState({
      pythonPath: native.pythonPath, tofuPath: native.tofuPath, scratchParent: path.join(scratch, 'missing')
    })).rejects.toThrow();
    expect((await readdir(scratch)).sort()).toEqual(['alias', 'not-a-directory', 'target']);
    expect(await readdir(target)).toEqual([]);
    expect(native.scratchRoot).toBeNull();
  });
});
