import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  StateMigrationError,
  type ProtectedArtifactStorage,
  type ProtectedStateWorkspace,
  type ProtectedVolumeAttestor,
  type StateArtifactDescriptor,
  type StateArtifactPurpose,
  type StateEncryptionKeyProvider,
  type StateExecutionContext
} from '../../domain/repair/stateful.js';
import { stateAssert, stateDigest, stateObjectDigest } from '../../domain/repair/stateful-invariants.js';
import { boundedStateOperation } from '../../domain/repair/stateful-bounded.js';
import { cleanupOwnedStateScratch } from './owned-process.js';

export type { ProtectedArtifactStorage, ProtectedVolumeAttestor, StateEncryptionKeyProvider } from '../../domain/repair/stateful.js';

interface Envelope {
  version: 1;
  keyRef: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}

const artifactId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const purposes = new Set<StateArtifactPurpose>(['inspection', 'state', 'plan', 'journal', 'backup', 'candidate', 'recovery']);

export class EncryptedStateWorkspace implements ProtectedStateWorkspace {
  readonly workspaceRef: string;
  #ready = false;
  #writtenBytes = 0;

  constructor(private readonly options: {
    workspaceId: string;
    keyRef: string;
    ownerId: string;
    storage: ProtectedArtifactStorage;
    keys: StateEncryptionKeyProvider;
    maxArtifactBytes?: number;
    maxWrittenBytes?: number;
    timeoutMs?: number;
  }) {
    stateAssert(artifactId.test(options.workspaceId), 'protected-workspace-required');
    this.workspaceRef = `state-workspace:${options.workspaceId}`;
  }

  toJSON(): { workspaceRef: string } { return { workspaceRef: this.workspaceRef }; }

  private bounded<T>(action: () => Promise<T>): Promise<T> {
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    stateAssert(timeoutMs > 0 && timeoutMs <= 120_000, 'invalid-binding');
    return boundedStateOperation(AbortSignal.timeout(timeoutMs), action);
  }

  async assertAvailable(context: StateExecutionContext): Promise<void> {
    this.#ready = false;
    try {
      await this.bounded(() => this.options.storage.assertAvailable(context));
      const key = await this.bounded(() => this.options.keys.describe(this.options.keyRef, context));
      stateAssert(key.keyRef === this.options.keyRef && key.ownerId === this.options.ownerId && key.hostId === context.hostId
        && key.storage === 'external-key-provider' && key.algorithm === 'aes-256-gcm', 'key-unavailable');
      await this.key(async () => undefined);
      this.#ready = true;
    } catch (error) {
      if (error instanceof StateMigrationError) throw error;
      throw new StateMigrationError('key-unavailable');
    }
  }

  private async key<T>(action: (key: Buffer) => Promise<T>): Promise<T> {
    let supplied = false;
    try {
      return await this.bounded(() => this.options.keys.withKey(this.options.keyRef, async (provided) => {
        stateAssert(provided.byteLength === 32, 'key-unavailable');
        const key = Buffer.from(provided);
        supplied = true;
        try { return await action(key); } finally { key.fill(0); }
      }));
    } catch (error) {
      if (error instanceof StateMigrationError) throw error;
      if (supplied) throw error;
      throw new StateMigrationError('key-unavailable');
    }
  }

  private id(ref: string): string {
    const prefix = `${this.workspaceRef}/`;
    stateAssert(ref.startsWith(prefix) && artifactId.test(ref.slice(prefix.length)), 'artifact-integrity');
    return ref.slice(prefix.length);
  }

  private aad(ref: string, purpose: StateArtifactPurpose, scope: string): Buffer {
    stateAssert(this.#ready, 'protected-workspace-required');
    stateAssert(purposes.has(purpose) && /^[a-f0-9]{64}$/.test(scope), 'artifact-purpose');
    return Buffer.from(JSON.stringify([this.workspaceRef, ref, purpose, scope, this.options.ownerId]));
  }

  private async seal(ref: string, purpose: StateArtifactPurpose, scope: string, bytes: Uint8Array): Promise<Uint8Array> {
    stateAssert(bytes.byteLength <= (this.options.maxArtifactBytes ?? 64 * 1024 * 1024), 'storage-limit');
    stateAssert(this.#writtenBytes + bytes.byteLength <= (this.options.maxWrittenBytes ?? 512 * 1024 * 1024), 'storage-limit');
    const aad = this.aad(ref, purpose, scope);
    const sealed = await this.key(async (key) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      const envelope: Envelope = {
        version: 1, keyRef: this.options.keyRef, nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64')
      };
      return Buffer.from(JSON.stringify(envelope));
    });
    this.#writtenBytes += bytes.byteLength;
    return sealed;
  }

  private async unseal(ref: string, purpose: StateArtifactPurpose, scope: string, bytes: Uint8Array): Promise<Uint8Array> {
    stateAssert(bytes.byteLength <= (this.options.maxArtifactBytes ?? 64 * 1024 * 1024) * 2 + 4096, 'storage-limit');
    const aad = this.aad(ref, purpose, scope);
    try {
      const envelope = JSON.parse(Buffer.from(bytes).toString('utf8')) as Envelope;
      stateAssert(envelope.version === 1 && envelope.keyRef === this.options.keyRef, 'artifact-integrity');
      stateAssert(typeof envelope.nonce === 'string' && typeof envelope.tag === 'string' && typeof envelope.ciphertext === 'string', 'artifact-integrity');
      const nonce = Buffer.from(envelope.nonce, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      stateAssert(nonce.length === 12 && tag.length === 16, 'artifact-integrity');
      return await this.key(async (key) => {
        const cipher = createDecipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(aad);
        cipher.setAuthTag(tag);
        return Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'base64')), cipher.final()]);
      });
    } catch (error) {
      if (error instanceof StateMigrationError && error.code === 'key-unavailable') throw error;
      throw new StateMigrationError('artifact-integrity');
    }
  }

  async put(purpose: StateArtifactPurpose, scope: string, bytes: Uint8Array, id = randomUUID()): Promise<StateArtifactDescriptor> {
    stateAssert(artifactId.test(id), 'artifact-integrity');
    const ref = `${this.workspaceRef}/${id}`;
    try {
      const sealed = await this.seal(ref, purpose, scope, bytes);
      await this.bounded(() => this.options.storage.create(id, sealed));
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new StateMigrationError('recovery-required');
      throw error;
    }
    const verified = await this.get(ref, purpose, scope);
    try { stateAssert(stateDigest(verified) === stateDigest(bytes), 'artifact-integrity'); }
    finally { verified.fill(0); }
    return { ref, digest: stateDigest(bytes), purpose, scope };
  }

  async get(ref: string, purpose: StateArtifactPurpose, scope: string): Promise<Uint8Array> {
    const id = this.id(ref);
    return this.unseal(ref, purpose, scope, await this.bounded(() => this.options.storage.read(id)));
  }

  async describe(ref: string, purpose: StateArtifactPurpose, scope: string): Promise<StateArtifactDescriptor | null> {
    const id = this.id(ref);
    this.aad(ref, purpose, scope);
    const envelope = await this.bounded(() => this.options.storage.read(id)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!envelope) return null;
    const bytes = await this.unseal(ref, purpose, scope, envelope);
    try { return { ref, digest: stateDigest(bytes), purpose, scope }; }
    finally { bytes.fill(0); }
  }

  async replace(ref: string, purpose: StateArtifactPurpose, scope: string, previousDigest: string, bytes: Uint8Array): Promise<StateArtifactDescriptor> {
    const id = this.id(ref);
    const priorEnvelope = await this.bounded(() => this.options.storage.read(id));
    const prior = await this.unseal(ref, purpose, scope, priorEnvelope);
    try { stateAssert(stateDigest(prior) === previousDigest, 'artifact-integrity'); }
    finally { prior.fill(0); }
    const sealed = await this.seal(ref, purpose, scope, bytes);
    await this.bounded(() => this.options.storage.compareExchange(id, stateDigest(priorEnvelope), sealed));
    const verified = await this.get(ref, purpose, scope);
    try { stateAssert(stateDigest(verified) === stateDigest(bytes), 'artifact-integrity'); }
    finally { verified.fill(0); }
    return { ref, digest: stateDigest(bytes), purpose, scope };
  }

  async removeExact(descriptor: StateArtifactDescriptor): Promise<void> {
    const id = this.id(descriptor.ref);
    const envelope = await this.bounded(() => this.options.storage.read(id));
    const bytes = await this.unseal(descriptor.ref, descriptor.purpose, descriptor.scope, envelope);
    try { stateAssert(stateDigest(bytes) === descriptor.digest, 'artifact-integrity'); }
    finally { bytes.fill(0); }
    await this.bounded(() => this.options.storage.remove(id, stateDigest(envelope)));
  }

  async withScratch<T>(context: StateExecutionContext, action: (directory: string) => Promise<T>): Promise<T> {
    await this.assertAvailable(context);
    return this.options.storage.withScratch(context, action);
  }
}

function isUnder(root: string, candidate: string): boolean {
  const relative = path.relative(root.toLowerCase(), candidate.toLowerCase());
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function assertPrivateStatePath(
  target: string,
  context: StateExecutionContext,
  attestor: ProtectedVolumeAttestor,
  directory: boolean,
  now = Date.now()
): Promise<void> {
  stateAssert(path.isAbsolute(target) && path.normalize(target) === target && !isUnder(context.projectRoot, target), 'unsafe-path');
  const parent = directory ? target : path.dirname(target);
  let current = parent;
  while (true) {
    const info = await lstat(current).catch(() => { throw new StateMigrationError('unsafe-path'); });
    stateAssert(info.isDirectory() && !info.isSymbolicLink(), 'unsafe-path');
    const git = await lstat(path.join(current, '.git')).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw new StateMigrationError('unsafe-path');
    });
    stateAssert(!git, 'unsafe-path');
    const next = path.dirname(current);
    if (current === next) break;
    current = next;
  }
  stateAssert(await realpath(parent) === parent, 'unsafe-path');
  const info = await stat(parent);
  if (process.platform !== 'win32') {
    stateAssert((info.mode & 0o077) === 0 && (process.getuid === undefined || info.uid === process.getuid()), 'unsafe-path');
  }
  const proof = await attestor.verify(parent, context);
  stateAssert(proof.canonicalDirectory === parent && proof.hostId === context.hostId && proof.encryptedVolume === true
    && proof.privateAccess === true && proof.storageClass === 'protected-state-workspace' && proof.expiresAt > now, 'protected-workspace-required');
  if (!directory) {
    const file = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw new StateMigrationError('unsafe-path');
    });
    stateAssert(!file || (file.isFile() && !file.isSymbolicLink() && file.nlink === 1
      && (process.platform === 'win32' || ((file.mode & 0o077) === 0 && (process.getuid === undefined || file.uid === process.getuid())))), 'unsafe-path');
  }
}

export async function assertExistingStateSourcePath(target: string, context: StateExecutionContext): Promise<void> {
  stateAssert(path.isAbsolute(target) && path.normalize(target) === target
    && isUnder(context.projectRoot, target) && target !== context.projectRoot
    && !path.relative(context.projectRoot, target).split(path.sep).some((part) => part.toLowerCase() === '.git'), 'unsafe-path');
  stateAssert(await realpath(context.projectRoot) === context.projectRoot, 'unsafe-path');
  let directory = path.dirname(target);
  while (true) {
    const info = await lstat(directory);
    stateAssert(info.isDirectory() && !info.isSymbolicLink(), 'unsafe-path');
    if (directory === context.projectRoot) break;
    const parent = path.dirname(directory);
    stateAssert(parent !== directory && isUnder(context.projectRoot, parent), 'unsafe-path');
    directory = parent;
  }
  const file = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw new StateMigrationError('unsafe-path');
  });
  stateAssert(!file || (file.isFile() && !file.isSymbolicLink() && file.nlink === 1
    && (process.platform === 'win32' || ((file.mode & 0o077) === 0 && (process.getuid === undefined || file.uid === process.getuid())))), 'unsafe-path');
}

export class FilesystemProtectedArtifactStorage implements ProtectedArtifactStorage {
  #context: StateExecutionContext | null = null;

  constructor(private readonly root: string, private readonly attestor: ProtectedVolumeAttestor, private readonly maxStoredBytes = 768 * 1024 * 1024) {}

  toJSON(): { storage: string } { return { storage: 'protected-external' }; }

  async assertAvailable(context: StateExecutionContext): Promise<void> {
    await assertPrivateStatePath(this.root, context, this.attestor, true);
    this.#context = context;
  }

  private async filename(id: string): Promise<string> {
    stateAssert(artifactId.test(id) && this.#context, 'artifact-integrity');
    const filename = path.join(this.root, `${id}.sealed`);
    await assertPrivateStatePath(filename, this.#context, this.attestor, false);
    return filename;
  }

  private async durableCreate(filename: string, bytes: Uint8Array): Promise<void> {
    const file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  }

  private async syncDirectory(): Promise<void> {
    if (process.platform === 'win32') return;
    const directory = await open(this.root, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private async allocate(bytes: number, action: () => Promise<void>): Promise<void> {
    stateAssert(this.#context, 'protected-workspace-required');
    await assertPrivateStatePath(this.root, this.#context, this.attestor, true);
    const guardPath = path.join(this.root, '.liftoff-state-store.guard');
    const guard = await open(guardPath, 'wx', 0o600).catch(() => { throw new StateMigrationError('lock-unavailable'); });
    try {
      let used = 0;
      let entries = 0;
      const directories = [this.root];
      while (directories.length) {
        const directory = directories.pop()!;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          stateAssert(++entries <= 10_000, 'storage-limit');
          const filename = path.join(directory, entry.name);
          const info = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (!info) continue;
          if (info.isDirectory() && !info.isSymbolicLink()) directories.push(filename);
          else used += info.size;
          stateAssert(used + bytes <= this.maxStoredBytes, 'storage-limit');
        }
      }
      await action();
    } finally { await guard.close(); await unlink(guardPath); }
  }

  async create(id: string, bytes: Uint8Array): Promise<void> {
    stateAssert(bytes.byteLength <= this.maxStoredBytes, 'storage-limit');
    const filename = await this.filename(id);
    await this.allocate(bytes.byteLength, () => this.durableCreate(filename, bytes));
    await this.syncDirectory();
  }

  async read(id: string): Promise<Uint8Array> {
    const file = await open(await this.filename(id), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      stateAssert(info.isFile() && info.nlink === 1 && info.size <= Math.min(this.maxStoredBytes, 128 * 1024 * 1024 + 4096), 'artifact-integrity');
      return await file.readFile();
    } finally { await file.close(); }
  }

  private async guarded(id: string, previousDigest: string, action: (filename: string) => Promise<void>): Promise<void> {
    const filename = await this.filename(id);
    const guard = `${filename}.guard`;
    const lock = await open(guard, 'wx', 0o600).catch(() => { throw new StateMigrationError('lock-unavailable'); });
    try {
      stateAssert(stateDigest(await this.read(id)) === previousDigest, 'artifact-integrity');
      await action(filename);
      await this.syncDirectory();
    } finally {
      await lock.close();
      await unlink(guard);
    }
  }

  async compareExchange(id: string, previousDigest: string, bytes: Uint8Array): Promise<void> {
    stateAssert(bytes.byteLength <= this.maxStoredBytes, 'storage-limit');
    await this.allocate(bytes.byteLength, () => this.guarded(id, previousDigest, async (filename) => {
      const staging = path.join(this.root, `${randomUUID()}.sealed`);
      await this.durableCreate(staging, bytes);
      try { await rename(staging, filename); }
      finally { await unlink(staging).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
    }));
  }

  async remove(id: string, expectedDigest: string): Promise<void> {
    await this.guarded(id, expectedDigest, (filename) => unlink(filename));
  }

  async withScratch<T>(context: StateExecutionContext, action: (directory: string) => Promise<T>): Promise<T> {
    await this.assertAvailable(context);
    const directory = path.join(this.root, `native-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    let terminationUnproven = false;
    try { return await action(directory); }
    catch (error) {
      terminationUnproven = error instanceof StateMigrationError && error.code === 'process-tree-termination-unproven';
      throw error;
    }
    finally {
      if (!terminationUnproven) {
        await cleanupOwnedStateScratch(directory, async () => {
          const info = await lstat(directory);
          stateAssert(info.isDirectory() && !info.isSymbolicLink() && await realpath(directory) === directory, 'unsafe-path');
          await rm(directory, { recursive: true });
        });
      }
    }
  }
}

export function protectedStateScope(context: StateExecutionContext): string {
  return stateObjectDigest({ projectId: context.projectId, projectRoot: context.projectRoot, hostId: context.hostId });
}
