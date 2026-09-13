import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  StateMigrationError,
  stateFailureCodes,
  type InspectedState,
  type StateBackendBinding,
  type StateBackendMetadata,
  type StateExecutionContext,
  type StateFailureCode,
  type StateInstance,
  type StateMigrationIntent,
  type StateSnapshot
} from './stateful.js';

export function stateDigest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalStateValue(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new StateMigrationError('artifact-integrity');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalStateValue).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStateValue((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

export function stateObjectDigest(value: unknown): string {
  return stateDigest(canonicalStateValue(value));
}

export function freezeStateValue<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freezeStateValue(entry);
    Object.freeze(value);
  }
  return value;
}

export function stateAssert(condition: unknown, code: StateFailureCode): asserts condition {
  if (!condition) throw new StateMigrationError(code);
}

export function stateFailure(error: unknown): StateFailureCode {
  try {
    const code = error instanceof StateMigrationError ? error.code : 'operation-failed';
    return stateFailureCodes.includes(code) ? code : 'operation-failed';
  } catch { return 'operation-failed'; }
}

export function isStateDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function stateOpaqueRef(value: string): string {
  return stateDigest(value);
}

export function validateStateContext(context: StateExecutionContext): void {
  stateAssert(path.isAbsolute(context.projectRoot) && path.resolve(context.projectRoot) === context.projectRoot
    && !/[\x00-\x1f]/.test(context.projectRoot), 'unsafe-path');
  stateAssert([context.configurationDigest, context.artifactDigest, context.cliDigest].every(isStateDigest), 'configuration-changed');
  stateAssert([context.projectId, context.hostId, context.principalId].every((id) => typeof id === 'string' && /^[a-zA-Z0-9_.:@/-]{1,256}$/.test(id)), 'invalid-binding');
}

export function validateStateBinding(binding: StateBackendBinding): void {
  stateAssert(binding && typeof binding === 'object', 'invalid-binding');
  stateAssert(/^[a-zA-Z0-9_-]{1,80}$/.test(binding.id) && /^[a-zA-Z0-9_.:@/-]{1,256}$/.test(binding.ownerId), 'invalid-binding');
  stateAssert(binding.format === 'opentofu-v4-json', 'unsupported-encryption');
  if (binding.kind === 'local') {
    stateAssert(Object.keys(binding).every((key) => ['id', 'kind', 'ownerId', 'format', 'statePath', 'readOnlySource'].includes(key)), 'invalid-binding');
    stateAssert(typeof binding.statePath === 'string' && path.isAbsolute(binding.statePath) && !/[\x00-\x1f]/.test(binding.statePath), 'unsafe-path');
    stateAssert(path.normalize(binding.statePath) === binding.statePath, 'unsafe-path');
    stateAssert(binding.readOnlySource === undefined || typeof binding.readOnlySource === 'boolean', 'invalid-binding');
  } else if (binding.kind === 'azurerm') {
    stateAssert(Object.keys(binding).every((key) => ['id', 'kind', 'ownerId', 'format', 'tenantId', 'subscriptionId', 'resourceGroup', 'account', 'container', 'key', 'network'].includes(key)), 'invalid-binding');
    const uuid = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
    stateAssert(uuid.test(binding.tenantId) && uuid.test(binding.subscriptionId), 'invalid-binding');
    stateAssert(/^[a-z0-9]{3,24}$/.test(binding.account), 'invalid-binding');
    stateAssert(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(binding.container) && !binding.container.includes('--'), 'invalid-binding');
    stateAssert(/^[a-zA-Z0-9_.()-]{1,90}$/.test(binding.resourceGroup), 'invalid-binding');
    stateAssert(typeof binding.key === 'string' && binding.key.length <= 1024 && binding.key.split('/').every((part) => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '.' && part !== '..'), 'invalid-binding');
    stateAssert(binding.network === 'private' || binding.network === 'public', 'invalid-binding');
  } else {
    throw new StateMigrationError('unsupported-backend');
  }
}

export function stateBindingDigest(binding: StateBackendBinding): string {
  validateStateBinding(binding);
  return stateObjectDigest(binding);
}

export function validateStateBindings(bindings: readonly StateBackendBinding[]): void {
  stateAssert(bindings.length > 0 && bindings.length <= 32, 'invalid-binding');
  const ids = new Set<string>();
  const locations = new Set<string>();
  for (const binding of bindings) {
    validateStateBinding(binding);
    const location = binding.kind === 'local'
      ? `local:${path.resolve(binding.statePath).normalize('NFC').toLowerCase()}`
      : `azurerm:${binding.account}/${binding.container}/${binding.key}`;
    stateAssert(!ids.has(binding.id) && !locations.has(location), 'duplicate-binding');
    ids.add(binding.id);
    locations.add(location);
  }
}

export function stateMetadataMatches(left: StateBackendMetadata, right: StateBackendMetadata): boolean {
  return left.backendId === right.backendId && left.bindingDigest === right.bindingDigest
    && left.exists === right.exists && left.version === right.version && left.etag === right.etag && left.size === right.size;
}

export function stateSnapshotMatches(left: StateSnapshot, right: StateSnapshot): boolean {
  return stateMetadataMatches(left, right) && stateContentMatches(left, right);
}

export function stateContentMatches(left: StateSnapshot, right: StateSnapshot): boolean {
  return left.exists === right.exists && left.digest === right.digest && left.serial === right.serial
    && left.lineage === right.lineage && left.inventoryDigest === right.inventoryDigest;
}

const identifier = '[A-Za-z_][A-Za-z0-9_-]*';
const index = '(?:\\[(?:0|[1-9][0-9]*|"(?:[^"\\\\\\x00-\\x1f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*")\\])?';
const addressPattern = new RegExp(`^(?:module\\.${identifier}${index}\\.)*(data\\.)?(${identifier})\\.(${identifier})${index}$`);

export function stateAddressKind(address: string): { mode: 'managed' | 'data'; type: string } {
  stateAssert(typeof address === 'string' && address.length <= 4096, 'mapping-conflict');
  const match = addressPattern.exec(address);
  stateAssert(match, 'mapping-conflict');
  return { mode: match[1] ? 'data' : 'managed', type: match[2] };
}

function record(value: unknown): Record<string, unknown> {
  stateAssert(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid-state');
  return value as Record<string, unknown>;
}

export function inspectStateBytes(
  metadata: StateBackendMetadata,
  bytes: Uint8Array | null,
  maxBytes = 32 * 1024 * 1024
): { snapshot: StateSnapshot; instances: StateInstance[] } {
  if (!metadata.exists) {
    stateAssert(bytes === null && metadata.version === null && metadata.etag === null && metadata.size === 0, 'incomplete-observation');
    return { snapshot: { ...metadata, lineage: null, serial: null, digest: null, inventoryDigest: stateObjectDigest([]) }, instances: [] };
  }
  stateAssert(bytes && bytes.byteLength > 0 && bytes.byteLength <= maxBytes && bytes.byteLength === metadata.size, 'invalid-state');
  let root: Record<string, unknown>;
  try { root = record(JSON.parse(Buffer.from(bytes).toString('utf8'))); }
  catch { throw new StateMigrationError('invalid-state'); }
  stateAssert(root.version === 4 && !('encrypted_data' in root) && !('encryption_version' in root), 'unsupported-state');
  stateAssert(typeof root.lineage === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(root.lineage), 'invalid-state');
  stateAssert(Number.isSafeInteger(root.serial) && (root.serial as number) >= 0, 'invalid-state');
  stateAssert(Array.isArray(root.resources) && root.resources.length <= 100_000, 'invalid-state');
  const instances: StateInstance[] = [];
  for (const value of root.resources) {
    const resource = record(value);
    stateAssert(resource.mode === 'managed' || resource.mode === 'data', 'unsupported-state');
    stateAssert(typeof resource.type === 'string' && /^azurerm_[a-z0-9_]+$/.test(resource.type), 'unsupported-state');
    stateAssert(typeof resource.name === 'string' && new RegExp(`^${identifier}$`).test(resource.name), 'invalid-state');
    stateAssert(typeof resource.provider === 'string' && /^(?:module\.[A-Za-z0-9_.-]+\.)?provider\["registry\.(?:opentofu|terraform)\.org\/hashicorp\/azurerm"\](?:\.[A-Za-z0-9_-]+)?$/.test(resource.provider), 'unsupported-state');
    stateAssert(resource.module === undefined || typeof resource.module === 'string', 'invalid-state');
    stateAssert(Array.isArray(resource.instances), 'invalid-state');
    for (const value of resource.instances) {
      const instance = record(value);
      stateAssert(instance.deposed === undefined && instance.status !== 'tainted', 'unsupported-state');
      stateAssert(instance.index_key === undefined || typeof instance.index_key === 'string'
        || (Number.isSafeInteger(instance.index_key) && (instance.index_key as number) >= 0), 'invalid-state');
      const attributes = record(instance.attributes);
      stateAssert(typeof attributes.id === 'string' && attributes.id.length > 0, 'unsupported-state');
      const address = `${resource.module ? `${resource.module}.` : ''}${resource.mode === 'data' ? 'data.' : ''}${resource.type}.${resource.name}${instance.index_key === undefined ? '' : `[${JSON.stringify(instance.index_key)}]`}`;
      const kind = stateAddressKind(address);
      stateAssert(kind.type === resource.type && kind.mode === resource.mode, 'invalid-state');
      instances.push({
        address, mode: resource.mode, type: resource.type, provider: resource.provider,
        identityDigest: stateDigest(attributes.id),
        valueDigest: stateObjectDigest({ attributes, private: instance.private ?? null, schema: instance.schema_version ?? null })
      });
    }
  }
  instances.sort((a, b) => a.address.localeCompare(b.address, 'en'));
  stateAssert(new Set(instances.map((instance) => instance.address)).size === instances.length, 'invalid-state');
  return {
    snapshot: {
      ...metadata, lineage: root.lineage, serial: root.serial as number,
      digest: stateDigest(bytes), inventoryDigest: stateObjectDigest(instances)
    },
    instances
  };
}

export function validateStateMappings(intent: StateMigrationIntent, states: readonly InspectedState[]): void {
  stateAssert(['address-refactor', 'backend-relocation', 'state-partition'].includes(intent.recipe), 'unsupported-state');
  stateAssert(Number.isSafeInteger(intent.retentionMs) && intent.retentionMs >= 0 && intent.retentionMs <= 366 * 86_400_000, 'invalid-binding');
  stateAssert([intent.targetConfigurationDigest, intent.targetInventoryDigest, intent.writerInventoryDigest].every(isStateDigest), 'invalid-binding');
  stateAssert(intent.recovery.length > 0 && new Set(intent.recovery).size === intent.recovery.length
    && intent.recovery.every((mode) => mode === 'forward' || mode === 'remove-new-destinations'), 'invalid-binding');
  const source = states.find((state) => state.snapshot.backendId === intent.sourceBackendId);
  stateAssert(source?.snapshot.exists && source.instances.length > 0, 'mapping-incomplete');
  const managed = source.instances.filter((instance) => instance.mode === 'managed');
  stateAssert(new Set(managed.map((instance) => `${instance.type}:${instance.identityDigest}`)).size === managed.length, 'mapping-conflict');
  const destinationIds = new Set(intent.destinationBackendIds);
  stateAssert(destinationIds.size === intent.destinationBackendIds.length && destinationIds.size > 0, 'mapping-conflict');
  stateAssert(states.length === new Set([intent.sourceBackendId, ...destinationIds]).size, 'mapping-conflict');
  for (const state of states) {
    const id = state.snapshot.backendId;
    stateAssert(id === intent.sourceBackendId || destinationIds.has(id), 'mapping-conflict');
    if (id !== intent.sourceBackendId) stateAssert(!state.snapshot.exists, 'destination-conflict');
  }
  const seenSource = new Set<string>();
  const seenDestination = new Set<string>();
  const usedDestinations = new Set<string>();
  for (const mapping of intent.mappings) {
    const instance = source.instances.find((item) => item.address === mapping.sourceAddress);
    stateAssert(instance && !seenSource.has(mapping.sourceAddress), 'mapping-incomplete');
    stateAssert(mapping.disposition === 'move' || mapping.disposition === 'preserve', 'mapping-conflict');
    stateAssert(destinationIds.has(mapping.destinationBackendId) || mapping.destinationBackendId === intent.sourceBackendId, 'mapping-conflict');
    const destination = `${mapping.destinationBackendId}\0${mapping.destinationAddress}`;
    stateAssert(!seenDestination.has(destination), 'mapping-conflict');
    const kind = stateAddressKind(mapping.destinationAddress);
    stateAssert(kind.mode === instance.mode && kind.type === instance.type, 'mapping-conflict');
    if (mapping.disposition === 'preserve') {
      stateAssert(mapping.destinationBackendId === intent.sourceBackendId && mapping.destinationAddress === instance.address, 'mapping-conflict');
    }
    if (mapping.destinationBackendId === intent.sourceBackendId && mapping.destinationAddress !== instance.address) {
      stateAssert(!source.instances.some((entry) => entry.address === mapping.destinationAddress), 'mapping-conflict');
    }
    seenSource.add(instance.address);
    seenDestination.add(destination);
    usedDestinations.add(mapping.destinationBackendId);
  }
  stateAssert(seenSource.size === source.instances.length, 'mapping-incomplete');
  stateAssert([...destinationIds].every((id) => usedDestinations.has(id)), 'mapping-incomplete');
  stateAssert([...usedDestinations].every((id) => typeof intent.targetConfigurationRefs[id] === 'string' && intent.targetConfigurationRefs[id].length > 0), 'mapping-incomplete');
  if (intent.recipe === 'address-refactor') {
    stateAssert(destinationIds.size === 1 && destinationIds.has(intent.sourceBackendId), 'mapping-conflict');
    stateAssert(intent.mappings.some((mapping) => mapping.sourceAddress !== mapping.destinationAddress), 'mapping-conflict');
  } else if (intent.recipe === 'backend-relocation') {
    stateAssert(destinationIds.size === 1 && !destinationIds.has(intent.sourceBackendId) && usedDestinations.size === 1, 'mapping-conflict');
    stateAssert(intent.mappings.every((item) => item.disposition === 'move' && item.sourceAddress === item.destinationAddress), 'mapping-conflict');
  } else {
    stateAssert(usedDestinations.size >= 2 && !destinationIds.has(intent.sourceBackendId), 'mapping-conflict');
  }
}

export function validateStatePlanBindings(intent: StateMigrationIntent, bindings: readonly StateBackendBinding[]): void {
  for (const binding of bindings) {
    if (binding.kind !== 'local' || !binding.readOnlySource) continue;
    stateAssert(binding.id === intent.sourceBackendId && intent.recipe !== 'address-refactor'
      && intent.mappings.every((mapping) => mapping.destinationBackendId !== binding.id), 'unsupported-state');
  }
}

export function verifyStateAccounting(
  intent: StateMigrationIntent,
  source: InspectedState,
  final: Readonly<Record<string, InspectedState>>,
  preserveValues: boolean
): void {
  const expected = new Map(intent.mappings.map((mapping) => [`${mapping.destinationBackendId}\0${mapping.destinationAddress}`, mapping]));
  const observed = new Set<string>();
  for (const [backendId, state] of Object.entries(final)) {
    stateAssert(state.snapshot.backendId === backendId, 'mapping-conflict');
    for (const instance of state.instances) {
      const key = `${backendId}\0${instance.address}`;
      const mapping = expected.get(key);
      stateAssert(mapping && !observed.has(key), 'mapping-conflict');
      const prior = source.instances.find((item) => item.address === mapping.sourceAddress);
      stateAssert(prior && prior.identityDigest === instance.identityDigest && prior.mode === instance.mode
        && prior.type === instance.type && prior.provider === instance.provider
        && (!preserveValues || prior.valueDigest === instance.valueDigest), 'resource-identity-changed');
      observed.add(key);
    }
  }
  stateAssert(observed.size === expected.size, 'mapping-incomplete');
}

export function assertNoResourceChanges(plan: unknown, requireNoChanges = false): void {
  const root = record(plan);
  stateAssert(root.errored !== true && root.complete !== false, 'verification-incomplete');
  stateAssert(root.action_invocations === undefined || (Array.isArray(root.action_invocations) && root.action_invocations.length === 0), 'resource-change');
  stateAssert(root.resource_changes === undefined || Array.isArray(root.resource_changes), 'invalid-state');
  for (const value of (root.resource_changes ?? []) as unknown[]) {
    const item = record(value);
    stateAssert(item.mode === 'managed' || item.mode === 'data', 'unsupported-state');
    const change = record(item.change);
    stateAssert(Array.isArray(change.actions), 'invalid-state');
    stateAssert(change.actions.length === 1 && (change.actions[0] === 'no-op'
      || (!requireNoChanges && item.mode === 'data' && change.actions[0] === 'read')), 'resource-change');
    stateAssert(item.action_reason === undefined || !String(item.action_reason).includes('replace'), 'resource-change');
    stateAssert(change.importing === undefined, 'resource-change');
  }
  stateAssert(root.deferred_changes === undefined || (Array.isArray(root.deferred_changes) && root.deferred_changes.length === 0), 'verification-incomplete');
  if (requireNoChanges && root.output_changes !== undefined) {
    for (const value of Object.values(record(root.output_changes))) {
      const output = record(value);
      stateAssert(Array.isArray(output.actions) && output.actions.length === 1 && output.actions[0] === 'no-op', 'verification-incomplete');
    }
  }
}
