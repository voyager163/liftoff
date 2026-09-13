import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  StateMigrationError,
  type DarwinStateKeychainReference, type DarwinStateVolumeObservation,
  type DarwinStateStorageProfile, type DarwinStateStorageProfileOptions, type DarwinStateSystemBridge,
  type ProtectedVolumeAttestor, type StateEncryptionKeyProvider,
  type StateExecutionContext, type StateRegisteredExecutable
} from '../../domain/repair/stateful.js';
import { stateAssert, stateObjectDigest } from '../../domain/repair/stateful-invariants.js';
import { darwinStateSystemProgram } from './darwin-system-program.js';
import { nativeStateHostId, runPrivateStateProcess } from './native-system.js';
import { DarwinPosixStateLockProvider } from './posix-native-lock.js';
import { EncryptedStateWorkspace, FilesystemProtectedArtifactStorage } from './protected-workspace.js';

export type { DarwinStateSystemBridge } from '../../domain/repair/stateful.js';

export class PythonDarwinStateSystemBridge implements DarwinStateSystemBridge {
  constructor(private readonly python: StateRegisteredExecutable, private readonly workingDirectory: string) {}
  async request(operation: 'volume' | 'keychain-metadata' | 'keychain-secret', input: object, signal?: AbortSignal): Promise<Record<string, unknown>> {
    stateAssert(process.platform === 'darwin', 'unsupported-native-platform');
    const result = await runPrivateStateProcess({
      executable: this.python, args: ['-I', '-S', '-B', '-c', darwinStateSystemProgram],
      cwd: this.workingDirectory, stdin: Buffer.from(JSON.stringify({ ...input, operation })),
      timeoutMs: 40_000, maximumBytes: 32_768, signal
    });
    try {
      stateAssert(result.exitCode === 0, operation === 'volume' ? 'protected-workspace-required' : 'key-unavailable');
      const reply = JSON.parse(Buffer.from(result.stdout).toString('utf8')) as Record<string, unknown>;
      stateAssert(reply.ok === true, operation === 'volume' ? 'protected-workspace-required' : 'key-unavailable');
      return reply;
    } catch (error) {
      if (error instanceof StateMigrationError) throw error;
      throw new StateMigrationError(operation === 'volume' ? 'protected-workspace-required' : 'key-unavailable');
    } finally { result.stdout.fill(0); result.stderr.fill(0); }
  }
}

export async function observeDarwinStateVolume(
  bridge: DarwinStateSystemBridge, directory: string, signal?: AbortSignal
): Promise<DarwinStateVolumeObservation> {
  stateAssert(path.isAbsolute(directory) && await realpath(directory) === directory, 'unsafe-path');
  const observed = await bridge.request('volume', { directory }, signal);
  stateAssert(observed.canonicalDirectory === directory && typeof observed.volumeId === 'string'
    && /^[a-fA-F0-9-]{36}$/.test(observed.volumeId) && typeof observed.deviceNode === 'string'
    && /^\/dev\/disk[0-9]+(?:s[0-9]+)*$/.test(observed.deviceNode), 'protected-workspace-required');
  return {
    canonicalDirectory: directory, deviceNode: observed.deviceNode, volumeId: observed.volumeId,
    filesystem: typeof observed.filesystem === 'string' ? observed.filesystem : '',
    fileVault: observed.fileVault === true, encrypted: observed.encrypted === true, locked: observed.locked !== false,
    ownerUid: Number(observed.ownerUid), mode: Number(observed.mode), aclEntries: Number(observed.aclEntries),
    hostId: nativeStateHostId()
  };
}

export class DarwinFileVaultVolumeAttestor implements ProtectedVolumeAttestor {
  #cache = new Map<string, { observation: DarwinStateVolumeObservation; expiresAt: number; directoryStamp: string }>();
  constructor(private readonly options: {
    bridge: DarwinStateSystemBridge;
    root: string;
    volumeId: string;
    now?: () => number;
  }) {}
  async verify(directory: string, context: StateExecutionContext): ReturnType<ProtectedVolumeAttestor['verify']> {
    stateAssert(process.platform === 'darwin' && context.hostId === nativeStateHostId(), 'unsupported-native-platform');
    const relative = path.relative(this.options.root, directory);
    stateAssert(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)), 'unsafe-path');
    const current = await lstat(directory);
    stateAssert(current.isDirectory() && !current.isSymbolicLink() && current.uid === process.getuid?.()
      && (current.mode & 0o077) === 0 && await realpath(directory) === directory, 'unsafe-path');
    const now = this.options.now?.() ?? Date.now();
    const directoryStamp = stateObjectDigest({ dev: current.dev, ino: current.ino, mode: current.mode, ctime: current.ctimeMs });
    let cached = this.#cache.get(directory);
    if (!cached || cached.expiresAt <= now || cached.directoryStamp !== directoryStamp) {
      cached = { observation: await observeDarwinStateVolume(this.options.bridge, directory), expiresAt: now + 10_000, directoryStamp };
      this.#cache.set(directory, cached);
    }
    const observed = cached.observation;
    stateAssert(observed.volumeId === this.options.volumeId && observed.filesystem === 'apfs'
      && observed.fileVault && observed.encrypted && !observed.locked
      && observed.ownerUid === process.getuid?.() && (observed.mode & 0o077) === 0 && observed.aclEntries === 0, 'protected-workspace-required');
    return {
      canonicalDirectory: directory, hostId: nativeStateHostId(), encryptedVolume: true, privateAccess: true,
      storageClass: 'protected-state-workspace', expiresAt: cached.expiresAt
    };
  }
}

export function darwinStateKeyReferenceId(reference: DarwinStateKeychainReference): string {
  return `keychain:${stateObjectDigest(reference)}`;
}

export class DarwinKeychainStateKeyProvider implements StateEncryptionKeyProvider {
  readonly keyRef: string;
  constructor(private readonly reference: DarwinStateKeychainReference, private readonly bridge: DarwinStateSystemBridge) {
    stateAssert(path.isAbsolute(reference.keychainPath)
      && /^org\.liftoff\.state\.[a-zA-Z0-9_.:-]{1,160}$/.test(reference.service)
      && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(reference.account), 'key-unavailable');
    this.reference = Object.freeze(structuredClone(reference));
    this.keyRef = darwinStateKeyReferenceId(this.reference);
  }
  async describe(keyRef: string, context: StateExecutionContext): ReturnType<StateEncryptionKeyProvider['describe']> {
    stateAssert(keyRef === this.keyRef && context.projectId === this.reference.account && context.hostId === nativeStateHostId(), 'key-unavailable');
    const observed = await this.bridge.request('keychain-metadata', { reference: this.reference });
    stateAssert(observed.present === true && observed.uid === process.getuid?.(), 'key-unavailable');
    return { keyRef, ownerId: this.reference.account, hostId: nativeStateHostId(), storage: 'external-key-provider', algorithm: 'aes-256-gcm' };
  }
  async withKey<T>(keyRef: string, action: (key: Uint8Array) => Promise<T>): Promise<T> {
    stateAssert(keyRef === this.keyRef, 'key-unavailable');
    const observed = await this.bridge.request('keychain-secret', { reference: this.reference });
    stateAssert(observed.uid === process.getuid?.() && typeof observed.value === 'string', 'key-unavailable');
    const stored = Buffer.from(observed.value, 'base64');
    delete observed.value;
    try {
      const encoded = stored.toString('ascii').trim();
      stateAssert(/^[A-Za-z0-9+/]{43}=$/.test(encoded), 'key-unavailable');
      const key = Buffer.from(encoded, 'base64');
      try {
        stateAssert(key.length === 32, 'key-unavailable');
        return await action(key);
      } finally { key.fill(0); }
    } finally { stored.fill(0); }
  }
  toJSON(): { keyRef: string } { return { keyRef: this.keyRef }; }
}

export async function createDarwinStateStorageProfile(options: DarwinStateStorageProfileOptions): Promise<DarwinStateStorageProfile> {
  stateAssert(options.tools.hostId === nativeStateHostId(), 'unsupported-native-platform');
  const bridge = new PythonDarwinStateSystemBridge(options.tools.python, options.workspaceRoot);
  const observed = await observeDarwinStateVolume(bridge, options.workspaceRoot);
  stateAssert(observed.filesystem === 'apfs' && observed.fileVault && observed.encrypted && !observed.locked
    && observed.ownerUid === process.getuid?.() && (observed.mode & 0o077) === 0 && observed.aclEntries === 0, 'protected-workspace-required');
  stateAssert(options.keyReference.account === options.projectId, 'ownership-mismatch');
  const volume = new DarwinFileVaultVolumeAttestor({ bridge, root: options.workspaceRoot, volumeId: observed.volumeId });
  const keys = new DarwinKeychainStateKeyProvider(options.keyReference, bridge);
  const storage = new FilesystemProtectedArtifactStorage(options.workspaceRoot, volume);
  const workspace = new EncryptedStateWorkspace({
    workspaceId: options.workspaceId ?? randomUUID(), keyRef: keys.keyRef, ownerId: options.projectId, storage, keys
  });
  return { workspace, volume, keys, keyRef: keys.keyRef, locks: new DarwinPosixStateLockProvider({ python: options.tools.python }), hostId: nativeStateHostId() };
}
