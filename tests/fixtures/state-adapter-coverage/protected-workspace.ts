import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  StateMigrationError,
  type ProtectedArtifactStorage,
  type ProtectedVolumeAttestor,
  type StateEncryptionKeyProvider,
  type StateExecutionContext
} from '../../../src/domain/repair/stateful.js';
import { stateDigest } from '../../../src/domain/repair/stateful-invariants.js';

// Synthetic plaintext that must never appear in stored envelopes or errors.
export const syntheticSecretState = 'SYNTHETIC_STATE_ADAPTER_SECRET_VALUE';

export function executionContext(projectRoot: string, overrides: Partial<StateExecutionContext> = {}): StateExecutionContext {
  return {
    projectRoot,
    projectId: 'synthetic-state-adapter-project',
    configurationDigest: stateDigest('synthetic-configuration'),
    artifactDigest: stateDigest('synthetic-artifact'),
    cliDigest: stateDigest('synthetic-cli'),
    hostId: 'synthetic-state-adapter-host',
    principalId: 'synthetic-state-adapter-principal',
    ...overrides
  };
}

// Owner-only (mkdtemp uses 0o700) and canonical, so symlinked temp roots such as
// macOS /var -> /private/var cannot hide an alias.
export async function privateTemporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(await realpath(tmpdir()), prefix));
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

export class RecordingArtifactStorage implements ProtectedArtifactStorage {
  readonly files = new Map<string, Uint8Array>();
  readonly exchanges: Array<{ id: string; previousDigest: string }> = [];
  readonly removals: Array<{ id: string; expectedDigest: string }> = [];
  availability: 'ready' | 'unavailable' | 'opaque-failure' | 'unresponsive' = 'ready';
  corruptStoredCopies = false;
  createFailure: Error | null = null;
  readFailure: NodeJS.ErrnoException | null = null;
  scratchRuns = 0;

  async assertAvailable(_context: StateExecutionContext): Promise<void> {
    if (this.availability === 'unavailable') throw new StateMigrationError('protected-workspace-required');
    if (this.availability === 'opaque-failure') throw new Error(`storage detail ${syntheticSecretState}`);
    if (this.availability === 'unresponsive') await new Promise<never>(() => undefined);
  }

  async create(id: string, bytes: Uint8Array): Promise<void> {
    if (this.createFailure) throw this.createFailure;
    if (this.files.has(id)) throw errno('EEXIST', 'synthetic artifact exists');
    const stored = Uint8Array.from(bytes);
    if (this.corruptStoredCopies) stored[stored.length - 3] ^= 1;
    this.files.set(id, stored);
  }

  async read(id: string): Promise<Uint8Array> {
    if (this.readFailure) throw this.readFailure;
    const stored = this.files.get(id);
    if (!stored) throw errno('ENOENT', 'synthetic artifact missing');
    return Uint8Array.from(stored);
  }

  async compareExchange(id: string, previousDigest: string, bytes: Uint8Array): Promise<void> {
    this.exchanges.push({ id, previousDigest });
    if (stateDigest(await this.read(id)) !== previousDigest) throw new StateMigrationError('artifact-integrity');
    this.files.set(id, Uint8Array.from(bytes));
  }

  async remove(id: string, expectedDigest: string): Promise<void> {
    this.removals.push({ id, expectedDigest });
    if (stateDigest(await this.read(id)) !== expectedDigest) throw new StateMigrationError('artifact-integrity');
    this.files.delete(id);
  }

  async withScratch<T>(_context: StateExecutionContext, action: (directory: string) => Promise<T>): Promise<T> {
    this.scratchRuns += 1;
    return action(path.join(path.sep, 'synthetic-protected-scratch'));
  }
}

type KeyDescriptor = Awaited<ReturnType<StateEncryptionKeyProvider['describe']>>;

export class ExternalKeyProvider implements StateEncryptionKeyProvider {
  descriptorOverrides: Partial<Record<keyof KeyDescriptor, unknown>> = {};
  keyBytes = 32;
  locked = false;
  withKeyCalls = 0;

  constructor(readonly keyRef = 'synthetic-external-key', private readonly fill = 91) {}

  async describe(keyRef: string, context: StateExecutionContext): Promise<KeyDescriptor> {
    return {
      keyRef, ownerId: context.projectId, hostId: context.hostId,
      storage: 'external-key-provider', algorithm: 'aes-256-gcm',
      ...this.descriptorOverrides
    } as KeyDescriptor;
  }

  async withKey<T>(_keyRef: string, action: (key: Uint8Array) => Promise<T>): Promise<T> {
    this.withKeyCalls += 1;
    if (this.locked) throw new Error(`key store locked ${syntheticSecretState}`);
    const key = Buffer.alloc(this.keyBytes, this.fill);
    try {
      return await action(key);
    } finally {
      key.fill(0);
    }
  }
}

type VolumeProof = Awaited<ReturnType<ProtectedVolumeAttestor['verify']>>;

export class ProtectedVolumeProof implements ProtectedVolumeAttestor {
  proofOverrides: Partial<Record<keyof VolumeProof, unknown>> = {};
  readonly verified: string[] = [];

  async verify(directory: string, context: StateExecutionContext): Promise<VolumeProof> {
    this.verified.push(directory);
    return {
      canonicalDirectory: directory, hostId: context.hostId, encryptedVolume: true, privateAccess: true,
      storageClass: 'protected-state-workspace', expiresAt: Date.now() + 60_000,
      ...this.proofOverrides
    } as VolumeProof;
  }
}
