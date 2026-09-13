import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  StateMigrationError,
  type InspectedState,
  type StateBackendAdapter,
  type StateBackendBinding,
  type StateBackendLease,
  type StateBackendMetadata,
  type StateExecutionContext,
  type StateMigrationDependencies,
  type StateMigrationIntent,
  type StateNativeDriver,
  type StateSnapshot,
  type StateWriterCoordinator
} from '../../../src/domain/repair/stateful.js';
import {
  inspectStateBytes, stateAssert, stateBindingDigest, stateDigest, stateMetadataMatches,
  stateObjectDigest, stateSnapshotMatches, verifyStateAccounting
} from '../../../src/domain/repair/stateful-invariants.js';
import {
  EncryptedStateWorkspace, protectedStateScope, type ProtectedArtifactStorage
} from '../../../src/adapters/state/protected-workspace.js';
import { cleanupOwnedStateScratch } from '../../../src/adapters/state/owned-process.js';

export const syntheticStateValue = 'SYNTHETIC_STATE_VALUE_NEVER_PUBLIC';
export const syntheticRoot = path.join(process.cwd(), '.cache', `state-migration-fixtures-${process.pid}`);
export const fixtureNow = 1_790_000_000_000;
export const digest = stateDigest;

export function context(): StateExecutionContext {
  return {
    projectRoot: path.join(syntheticRoot, 'project'), projectId: 'synthetic-project',
    configurationDigest: digest('before-configuration'), artifactDigest: digest('fixture-artifact'),
    cliDigest: digest('fixture-cli'), hostId: 'synthetic-host', principalId: 'synthetic-principal'
  };
}

export function binding(id: string, kind: StateBackendBinding['kind'] = 'azurerm'): StateBackendBinding {
  const base = { id, kind, ownerId: context().projectId, format: 'opentofu-v4-json' as const };
  return kind === 'local'
    ? { ...base, kind, statePath: path.join(syntheticRoot, 'protected-source', `${id}.tfstate`) }
    : {
      ...base, kind, tenantId: '11111111-1111-1111-1111-111111111111',
      subscriptionId: '22222222-2222-2222-2222-222222222222', resourceGroup: 'fixture-rg',
      account: 'liftoffsynthetic', container: 'state-fixtures', key: `${id}.tfstate`, network: 'private'
    };
}

export interface SyntheticInstance {
  address: string;
  id: string;
  value?: string;
}

export function stateBytes(instances: readonly SyntheticInstance[], lineage = 'fixture-source-lineage', serial = 7): Uint8Array {
  return Buffer.from(JSON.stringify({
    version: 4, serial, lineage, terraform_version: '1.11.0', outputs: {},
    resources: instances.map((instance) => {
      const match = /^(?:(.*)\.)?(azurerm_[a-z0-9_]+)\.([a-zA-Z0-9_-]+)(\[(.*)\])?$/.exec(instance.address)!;
      if (!match) throw new Error('Invalid synthetic fixture address');
      return {
        ...(match[1] ? { module: match[1] } : {}), mode: 'managed', type: match[2], name: match[3],
        provider: 'provider["registry.opentofu.org/hashicorp/azurerm"]',
        instances: [{
          schema_version: 0, ...(match[4] ? { index_key: JSON.parse(match[5]) } : {}),
          attributes: { id: instance.id, fixture_value: instance.value ?? syntheticStateValue }
        }]
      };
    })
  }));
}

export const sourceInstances: SyntheticInstance[] = [
  { address: 'azurerm_resource_group.dev', id: '/synthetic/resource-groups/dev' },
  { address: 'azurerm_resource_group.prod', id: '/synthetic/resource-groups/prod' }
];

export class MemoryProtectedStorage implements ProtectedArtifactStorage {
  files = new Map<string, Uint8Array>();
  available = true;
  failExchange = false;
  async assertAvailable(): Promise<void> {
    if (!this.available) throw new StateMigrationError('protected-workspace-required');
  }
  async create(id: string, bytes: Uint8Array): Promise<void> {
    if (this.files.has(id)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    this.files.set(id, Uint8Array.from(bytes));
  }
  async read(id: string): Promise<Uint8Array> {
    const value = this.files.get(id);
    if (!value) throw Object.assign(new Error('missing synthetic artifact'), { code: 'ENOENT' });
    return Uint8Array.from(value);
  }
  async compareExchange(id: string, prior: string, bytes: Uint8Array): Promise<void> {
    if (this.failExchange) throw new StateMigrationError('artifact-integrity');
    stateAssert(stateDigest(await this.read(id)) === prior, 'artifact-integrity');
    this.files.set(id, Uint8Array.from(bytes));
  }
  async remove(id: string, expected: string): Promise<void> {
    stateAssert(stateDigest(await this.read(id)) === expected, 'artifact-integrity');
    this.files.delete(id);
  }
  async withScratch<T>(_context: StateExecutionContext, action: (directory: string) => Promise<T>): Promise<T> {
    const root = path.join(syntheticRoot, randomUUID());
    await mkdir(root, { mode: 0o700, recursive: true });
    let terminationUnproven = false;
    try { return await action(root); }
    catch (error) {
      terminationUnproven = error instanceof StateMigrationError && error.code === 'process-tree-termination-unproven';
      throw error;
    }
    finally {
      if (!terminationUnproven) await cleanupOwnedStateScratch(root, () => rm(root, { recursive: true, force: true }));
    }
  }
}

export function workspace(storage = new MemoryProtectedStorage()): EncryptedStateWorkspace {
  return new EncryptedStateWorkspace({
    workspaceId: randomUUID(), keyRef: 'synthetic-external-key-reference', ownerId: context().projectId, storage,
    keys: {
      async describe(keyRef, current) {
        return { keyRef, ownerId: current.projectId, hostId: current.hostId, storage: 'external-key-provider', algorithm: 'aes-256-gcm' };
      },
      async withKey(_ref, action) {
        const key = Buffer.alloc(32, 37);
        try { return await action(key); } finally { key.fill(0); }
      }
    }
  });
}

export class FixtureEvents {
  events: string[] = [];
  failAt: string | null = null;
  onEvent: ((event: string) => void) | null = null;
  record(event: string): void {
    this.events.push(event);
    this.onEvent?.(event);
    if (this.failAt === event) {
      this.failAt = null;
      throw new StateMigrationError('operation-failed');
    }
  }
}

class FixtureLease implements StateBackendLease {
  kind = 'blob-lease' as const;
  released = false;
  lost = false;
  constructor(readonly backendId: string) {}
  async assertHeld(): Promise<void> { stateAssert(!this.released && !this.lost, 'lock-lost'); }
  async release(): Promise<void> { this.released = true; }
}

export class FixtureBackend implements StateBackendAdapter {
  bytes: Uint8Array | null;
  version = 1;
  operationId: string | undefined;
  metadataReads = 0;
  sensitiveReads = 0;
  writes = 0;
  deletes = 0;
  denied = false;
  incomplete = false;
  lastLease: FixtureLease | null = null;
  leases = new WeakSet<FixtureLease>();
  constructor(readonly binding: StateBackendBinding, bytes: Uint8Array | null, readonly events: FixtureEvents, readonly now: () => number) {
    this.bytes = bytes ? Uint8Array.from(bytes) : null;
  }
  async assertAccess(): Promise<void> { if (this.denied) throw new StateMigrationError('access-denied'); }
  async metadata(): Promise<StateBackendMetadata> {
    await this.assertAccess();
    this.metadataReads++;
    if (this.incomplete) throw new StateMigrationError('incomplete-observation');
    return {
      backendId: this.binding.id, bindingDigest: stateBindingDigest(this.binding),
      exists: this.bytes !== null, version: this.bytes ? `v${this.version}` : null,
      etag: this.bytes && this.binding.kind === 'azurerm' ? `"0x${this.version.toString(16)}"` : null,
      size: this.bytes?.byteLength ?? 0, observedAt: this.now(),
      ...(this.operationId ? { operationId: this.operationId } : {})
    };
  }
  async readPrivate(expected: StateBackendMetadata, _context: StateExecutionContext, lease?: StateBackendLease): Promise<Uint8Array> {
    this.sensitiveReads++;
    if (lease) await lease.assertHeld();
    stateAssert(this.bytes && stateMetadataMatches(expected, await this.metadata()), 'stale-state');
    return Uint8Array.from(this.bytes);
  }
  async acquire(expected: StateBackendMetadata): Promise<StateBackendLease> {
    this.events.record(`acquire:${this.binding.id}`);
    stateAssert(stateMetadataMatches(expected, await this.metadata()), 'stale-state');
    const lease = new FixtureLease(this.binding.id);
    this.lastLease = lease;
    this.leases.add(lease);
    return lease;
  }
  async current(): Promise<InspectedState> {
    return { ...inspectStateBytes(await this.metadata(), this.bytes), stateRef: null };
  }
  private async check(expected: StateSnapshot, lease: StateBackendLease): Promise<void> {
    stateAssert(lease instanceof FixtureLease && this.leases.has(lease), 'lock-lost');
    await lease.assertHeld();
    stateAssert(stateSnapshotMatches(expected, (await this.current()).snapshot), 'stale-state');
  }
  async writePrivate(request: Parameters<StateBackendAdapter['writePrivate']>[0]): Promise<StateBackendMetadata> {
    await this.check(request.expected, request.lease);
    this.events.record(`before-write:${this.binding.id}`);
    await this.check(request.expected, request.lease);
    this.bytes = Uint8Array.from(request.bytes);
    this.version++;
    this.writes++;
    this.operationId = request.operationId;
    this.events.record(`after-write:${this.binding.id}`);
    return this.metadata();
  }
  async remove(request: Parameters<StateBackendAdapter['remove']>[0]): Promise<StateBackendMetadata> {
    await this.check(request.expected, request.lease);
    this.events.record(`before-delete:${this.binding.id}`);
    await this.check(request.expected, request.lease);
    this.bytes = null;
    this.version++;
    this.deletes++;
    this.events.record(`after-delete:${this.binding.id}`);
    return this.metadata();
  }
}

export class FixtureWriters implements StateWriterCoordinator {
  configurationDigest = context().configurationDigest;
  paused = false;
  inventoryPublications = new Set<string>();
  constructor(readonly events: FixtureEvents) {}
  async inspectConfiguration(): Promise<string> { return this.configurationDigest; }
  async quiesce(request: Parameters<StateWriterCoordinator['quiesce']>[0]): Promise<string> {
    this.events.record('before-quiesce');
    this.paused = true;
    this.events.record('after-quiesce');
    return `fixture-writers:${request.operationId}`;
  }
  async assertQuiesced(): Promise<void> { stateAssert(this.paused, 'writers-not-quiesced'); }
  async commitConfiguration(request: Parameters<StateWriterCoordinator['commitConfiguration']>[0]): Promise<void> {
    this.events.record('before-configuration');
    stateAssert(this.paused && this.configurationDigest === request.beforeDigest, 'configuration-changed');
    this.configurationDigest = request.afterDigest;
    this.events.record('after-configuration');
  }
  async verifyCutover(request: Parameters<StateWriterCoordinator['verifyCutover']>[0]): Promise<string> {
    this.events.record('verify-cutover');
    stateAssert(this.configurationDigest === request.configurationDigest, 'verification-incomplete');
    return stateObjectDigest({ config: this.configurationDigest, mapping: request.mappingDigest });
  }
  async publishInventory(request: Parameters<StateWriterCoordinator['publishInventory']>[0]): Promise<void> {
    this.events.record('before-inventory');
    this.inventoryPublications.add(request.operationId);
    this.events.record('after-inventory');
  }
  async resume(request: Parameters<StateWriterCoordinator['resume']>[0]): Promise<void> {
    this.events.record('before-resume');
    stateAssert(this.configurationDigest === request.configurationDigest, 'configuration-changed');
    this.paused = false;
    this.events.record('after-resume');
  }
}

export function fixtureIntent(recipe: StateMigrationIntent['recipe'] = 'backend-relocation'): StateMigrationIntent {
  const destinations = recipe === 'address-refactor' ? ['source'] : recipe === 'state-partition' ? ['dev', 'prod'] : ['target'];
  return {
    recipe, sourceBackendId: 'source', destinationBackendIds: destinations,
    mappings: sourceInstances.map((instance, index) => ({
      sourceAddress: instance.address,
      destinationBackendId: recipe === 'state-partition' ? destinations[index] : destinations[0],
      destinationAddress: recipe === 'backend-relocation' ? instance.address : `module.application.${instance.address}`,
      disposition: 'move'
    })),
    sourceConfigurationRef: 'source-configuration',
    targetConfigurationRefs: Object.fromEntries(destinations.map((id) => [id, `${id}-configuration`])),
    targetConfigurationDigest: digest('after-configuration'),
    targetInventoryDigest: digest('after-inventory'), writerInventoryDigest: digest('known-writers'),
    retentionMs: 30 * 86_400_000, recovery: ['forward', 'remove-new-destinations']
  };
}

export function fixtureScenario(recipe: StateMigrationIntent['recipe'] = 'backend-relocation', kinds: StateBackendBinding['kind'][] = ['azurerm']): {
  deps: StateMigrationDependencies;
  storage: MemoryProtectedStorage;
  events: FixtureEvents;
  writers: FixtureWriters;
  backends: Map<string, FixtureBackend>;
  bindings: StateBackendBinding[];
  intent: StateMigrationIntent;
  now: { value: number };
} {
  const intent = fixtureIntent(recipe);
  const now = { value: fixtureNow };
  const events = new FixtureEvents();
  const ids = [...new Set(['source', ...intent.destinationBackendIds])];
  const bindings = ids.map((id, index) => binding(id, kinds[index % kinds.length]));
  const backends = new Map(bindings.map((entry) => [
    entry.id, new FixtureBackend(entry, entry.id === 'source' ? stateBytes(sourceInstances) : null, events, () => now.value)
  ]));
  const storage = new MemoryProtectedStorage();
  const vault = workspace(storage);
  const writers = new FixtureWriters(events);
  const native: StateNativeDriver = {
    async quiesce() {},
    async review(request) {
      events.record('native-review');
      const saved = await vault.put('plan', protectedStateScope(request.context), Buffer.from('SYNTHETIC_NATIVE_PLAN'));
      return {
        configurationDigest: request.context.configurationDigest, contractDigest: digest('fixture-contract'),
        configurationDigests: Object.fromEntries(Object.values(request.intent.targetConfigurationRefs).map((ref) => [ref, digest(ref)])),
        savedPlanRefs: [saved.ref], savedPlanDigests: [saved.digest]
      };
    },
    async prepare(plan) {
      events.record('native-prepare');
      const candidates: Record<string, InspectedState> = {};
      const source = plan.inspection.states.find((state) => state.snapshot.backendId === plan.intent.sourceBackendId)!;
      for (const id of [...new Set(plan.intent.mappings.map((mapping) => mapping.destinationBackendId))]) {
        const mapped = plan.intent.mappings.filter((mapping) => mapping.destinationBackendId === id);
        const instances = mapped.map((mapping) => {
          const original = sourceInstances.find((instance) => instance.address === mapping.sourceAddress)!;
          return { ...original, address: mapping.destinationAddress };
        });
        const existing = plan.inspection.states.find((state) => state.snapshot.backendId === id)!;
        const bytes = stateBytes(instances,
          id === 'source' || plan.intent.recipe === 'backend-relocation' ? source.snapshot.lineage! : `fixture-${id}-lineage`,
          id === 'source' ? source.snapshot.serial! + 1 : plan.intent.recipe === 'backend-relocation' ? source.snapshot.serial! : 1
        );
        const parsed = inspectStateBytes({ ...existing.snapshot, exists: true, size: bytes.byteLength }, bytes);
        const saved = await vault.put('candidate', protectedStateScope(plan.context), bytes);
        candidates[id] = { ...parsed, stateRef: saved.ref };
      }
      return { candidates, verificationDigest: digest('fixture-prepared-proof') };
    },
    async verifyDestinations(plan, states) {
      events.record('native-destinations');
      const source = plan.inspection.states.find((state) => state.snapshot.backendId === plan.intent.sourceBackendId)!;
      const mappings = plan.intent.mappings.filter((mapping) => plan.intent.destinationBackendIds.includes(mapping.destinationBackendId));
      verifyStateAccounting({ ...plan.intent, mappings }, source, states, false);
      return digest('fixture-destination-proof');
    },
    async verify(plan, states) {
      events.record('native-final');
      const source = plan.inspection.states.find((state) => state.snapshot.backendId === plan.intent.sourceBackendId)!;
      verifyStateAccounting(plan.intent, source, states, false);
      return digest('fixture-final-proof');
    }
  };
  return {
    deps: { workspace: vault, backend: (entry) => backends.get(entry.id)!, native, writers, now: () => now.value },
    storage, events, writers, backends, bindings, intent, now
  };
}
