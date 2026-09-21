import { canonicalDigest } from './admission.ts';
import { digest, identifier, parseIdentity, record, SecurityEvidenceError, type EvidenceIdentity } from './evidence.ts';

export const HOSTED_MIGRATION_LIMITS = Object.freeze({
  operations: 32, nodes: 100_000, bytes: 2 * 1024 * 1024, depth: 24,
  transportCalls: 2048, snapshotAgeMs: 86_400_000, consentWindowMs: 3_600_000
});
const repository = 'voyager163/liftoff' as const;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type MigrationJson = Json;

export interface MigrationEndpoint {
  id: string;
  readMethod: 'GET';
  writeMethod: 'PUT' | 'PATCH';
  path: string;
}

export interface MigrationRegistry {
  schemaVersion: 1;
  repository: typeof repository;
  ownerType: 'User';
  endpoints: readonly MigrationEndpoint[];
}

export interface MigrationOperation {
  id: string;
  endpointId: string;
  before: MigrationJson;
  after: MigrationJson;
  payload: { [key: string]: MigrationJson };
}

export interface MigrationProposal {
  identity: EvidenceIdentity;
  observedAt: string;
  registry: MigrationRegistry;
  operations: readonly MigrationOperation[];
}

/**
 * Supplied independently AFTER endpoint-specific schema, capability and
 * preservation validation (including no control removal, bypass grants or
 * status synthesis). Digests are comparison inputs, not authenticated receipts.
 * Opaque payload semantics cannot be established by this generic local engine.
 */
export interface MigrationExpectations {
  identity: EvidenceIdentity;
  proposalDigest: string;
  validatorDigest: string;
}

export interface LocalMigrationPlan { readonly kind: 'local-migration-plan'; }

export interface MigrationSimulationConsent {
  kind: 'simulation-only-migration-consent';
  id: string;
  owner: 'voyager163';
  identity: EvidenceIdentity;
  planDigest: string;
  registryDigest: string;
  beforeDigest: string;
  afterDigest: string;
  payloadDigest: string;
  approvedAt: string;
  expiresAt: string;
}

export interface InMemoryMigrationTransport { readonly kind: 'in-memory-migration-transport'; }

export type MigrationSimulationFault =
  | {
    call: number; kind: 'read-error' | 'write-error-before-effect' | 'write-error-after-effect';
    diagnostic: string;
  }
  | { call: number; kind: 'drift'; endpointId: string; value: MigrationJson };

type Phase = 'preflight' | 'precondition' | 'apply' | 'readback' | 'final-readback';
type Failure = 'drift' | 'read-error' | 'write-error' | 'write-precondition-rejected' | 'readback-mismatch';
type OperationMetadata = {
  id: string; endpointId: string; method: MigrationEndpoint['writeMethod'];
  beforeDigest: string; afterDigest: string; payloadDigest: string;
};
type OperationProgress = OperationMetadata & {
  write: 'not-attempted' | 'acknowledged' | 'uncertain' | 'precondition-rejected';
  verification: 'not-read' | 'before-matched' | 'after-matched' | 'mismatched' | 'read-error';
  observedDigest: string | null;
  noop: boolean;
};
type Trace = {
  call: number; endpointId: string; phase: Phase; method: 'GET' | 'PUT' | 'PATCH';
  conditionDigest: string | null; payloadDigest: string | null;
  result: 'read' | 'acknowledged' | 'error' | 'precondition-rejected';
};

export interface MigrationSimulationResult {
  kind: 'simulated-migration-result';
  status: 'completed' | 'blocked';
  planDigest: string;
  consentDigest: string;
  liveEffects: false;
  hostedQualification: false;
  operations: OperationProgress[];
  recovery: null | {
    reason: Failure; phase: Phase; operationId: string;
    acknowledged: string[]; verified: string[]; uncertain: string[]; unattempted: string[];
    action: 'stop-retain-effects-refresh-readback-revalidate-and-obtain-new-consent';
    automaticRollback: false; consentInvalidated: true;
  };
}

interface PlanState {
  proposal: MigrationProposal;
  metadata: {
    kind: 'local-migration-plan-description'; identity: EvidenceIdentity; observedAt: string;
    planDigest: string; proposalDigest: string; validatorDigest: string;
    registryDigest: string; beforeDigest: string; afterDigest: string; payloadDigest: string;
    productionEnabled: false; payloadValidation: 'independently-supplied-not-authenticated';
    operations: OperationMetadata[];
  };
  blocked: boolean;
  completed: boolean;
}
interface SimulationState {
  registryDigest: string;
  values: Map<string, Json>;
  faults: Map<number, MigrationSimulationFault>;
  trace: Trace[];
  consents: Map<string, { digest: string; status: 'completed' | 'blocked' }>;
}
const plans = new WeakMap<LocalMigrationPlan, PlanState>();
const simulations = new WeakMap<InMemoryMigrationTransport, SimulationState>();

function fail(code: string): never { throw new SecurityEvidenceError(`hosted-migration-${code}`); }
function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) fail('duplicate-identity');
}
function array(value: unknown, max: number = HOSTED_MIGRATION_LIMITS.operations): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('invalid-list');
  return value;
}
function time(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('invalid-time');
  return Date.parse(value);
}
function nowTime(now: Date): number {
  let stamp: number;
  try { stamp = Date.prototype.getTime.call(now); } catch { return fail('invalid-time'); }
  if (!Number.isFinite(stamp)) fail('invalid-time');
  return stamp;
}

/** Copy data without invoking accessors/serializers; never reflect an input or transport exception. */
function data(value: unknown): Json {
  let bytes = 0, nodes = 0;
  function copy(value: unknown, depth: number): Json {
    if (++nodes > HOSTED_MIGRATION_LIMITS.nodes || depth > HOSTED_MIGRATION_LIMITS.depth) fail('data-limit');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value);
      if (value.length > 65_536 || bytes > HOSTED_MIGRATION_LIMITS.bytes) fail('data-limit');
      return value;
    }
    if (typeof value !== 'object') return fail('invalid-data');
    const isArray = Array.isArray(value);
    if (!isArray && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('invalid-data');
    const keys = Reflect.ownKeys(value);
    if (keys.length > HOSTED_MIGRATION_LIMITS.nodes - nodes) fail('data-limit');
    if (isArray) {
      if (value.length > 10_000 || keys.length !== value.length + 1) fail('invalid-data');
      const result: Json[] = [];
      for (let index = 0; index < value.length; index++) {
        const property = Object.getOwnPropertyDescriptor(value, String(index));
        if (!property?.enumerable || !('value' in property)) fail('invalid-data');
        result.push(copy(property.value, depth + 1));
      }
      return result;
    }
    const result: { [key: string]: Json } = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || key.length > 200 || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('invalid-data');
      bytes += Buffer.byteLength(key);
      if (bytes > HOSTED_MIGRATION_LIMITS.bytes) fail('data-limit');
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property?.enumerable || !('value' in property)) fail('invalid-data');
      result[key] = copy(property.value, depth + 1);
    }
    return result;
  }
  try { return copy(value, 0); }
  catch { return fail('invalid-or-oversized-data'); }
}

function parseRegistry(value: unknown): MigrationRegistry {
  const item = record(value, ['schemaVersion', 'repository', 'ownerType', 'endpoints'], 'hosted-migration-registry');
  if (item.schemaVersion !== 1 || item.repository !== repository || item.ownerType !== 'User') fail('repository-scope');
  const endpoints = array(item.endpoints).map(value => {
    const entry = record(value, ['id', 'readMethod', 'writeMethod', 'path'], 'hosted-migration-endpoint');
    if (entry.readMethod !== 'GET' || !['PUT', 'PATCH'].includes(entry.writeMethod as string) ||
        typeof entry.path !== 'string') fail('endpoint-method');
    const root = `/repos/${repository}`;
    const suffix = entry.path.startsWith(root) ? entry.path.slice(root.length) : null;
    const supported = entry.writeMethod === 'PATCH' ? suffix === ''
      : suffix !== null && (
        /^\/branches\/(?:develop|main)\/protection$/.test(suffix) ||
        /^\/rulesets\/[1-9][0-9]{0,15}$/.test(suffix) ||
        /^\/actions\/permissions(?:\/selected-actions|\/workflow)?$/.test(suffix) ||
        /^\/environments\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(suffix)
      );
    if (!supported) fail('unsupported-endpoint');
    return {
      id: identifier(entry.id, 'hosted-migration-endpoint-id'), readMethod: 'GET' as const,
      writeMethod: entry.writeMethod as 'PUT' | 'PATCH', path: entry.path
    };
  });
  if (endpoints.length === 0) fail('empty-registry');
  unique(endpoints.map(endpoint => endpoint.id));
  unique(endpoints.map(endpoint => endpoint.path.toLowerCase()));
  return { schemaVersion: 1, repository, ownerType: 'User',
    endpoints: endpoints.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
}

function parseProposal(value: unknown): MigrationProposal {
  const item = record(value, ['identity', 'observedAt', 'registry', 'operations'], 'hosted-migration-proposal');
  const identity = parseIdentity(item.identity);
  if (identity.repository !== repository || identity.event === 'pull_request') fail('repository-scope');
  time(item.observedAt);
  const registry = parseRegistry(item.registry);
  const operations = array(item.operations).map(value => {
    const operation = record(value, ['id', 'endpointId', 'before', 'after', 'payload'], 'hosted-migration-operation');
    const endpointId = identifier(operation.endpointId, 'hosted-migration-endpoint-id');
    if (!registry.endpoints.some(endpoint => endpoint.id === endpointId)) fail('unregistered-endpoint');
    if (operation.payload === null || typeof operation.payload !== 'object' || Array.isArray(operation.payload)) fail('payload-shape');
    if (operation.before !== null && operation.after === null) fail('control-deletion-prohibited');
    return {
      id: identifier(operation.id, 'hosted-migration-operation-id'), endpointId,
      before: operation.before as Json, after: operation.after as Json, payload: operation.payload as { [key: string]: Json }
    };
  });
  if (operations.length !== registry.endpoints.length) fail('registry-coverage');
  unique(operations.map(operation => operation.id));
  unique(operations.map(operation => operation.endpointId));
  return { identity, observedAt: item.observedAt as string, registry, operations };
}

/**
 * No payload defaults or hosted policy interpretation. The supplied independent
 * digest must cover every exact registration, payload, before/after snapshot,
 * operation order, identity and observation time. The handle is simulation-only.
 */
export function prepareHostedMigration(
  proposalValue: MigrationProposal, expectedValue: MigrationExpectations, now: Date
): LocalMigrationPlan {
  const copied = record(data({ proposal: proposalValue, expected: expectedValue }), ['proposal', 'expected'], 'hosted-migration-input');
  const expected = record(copied.expected, ['identity', 'proposalDigest', 'validatorDigest'], 'hosted-migration-expectations');
  const identity = parseIdentity(expected.identity);
  if (canonicalDigest(copied.proposal) !== digest(expected.proposalDigest)) fail('unvalidated-proposal');
  const proposal = parseProposal(copied.proposal);
  if (canonicalDigest(proposal.identity) !== canonicalDigest(identity)) fail('identity-mismatch');
  const stamp = nowTime(now), observed = time(proposal.observedAt);
  if (observed > stamp || stamp - observed > HOSTED_MIGRATION_LIMITS.snapshotAgeMs) fail('stale-plan');
  const validatorDigest = digest(expected.validatorDigest);
  const operations = proposal.operations.map(operation => ({
    id: operation.id, endpointId: operation.endpointId,
    method: proposal.registry.endpoints.find(endpoint => endpoint.id === operation.endpointId)!.writeMethod,
    beforeDigest: canonicalDigest(operation.before), afterDigest: canonicalDigest(operation.after),
    payloadDigest: canonicalDigest(operation.payload)
  }));
  const bindings = {
    proposalDigest: digest(expected.proposalDigest), validatorDigest,
    registryDigest: canonicalDigest(proposal.registry),
    beforeDigest: canonicalDigest(operations.map(({ id, beforeDigest }) => ({ id, beforeDigest }))),
    afterDigest: canonicalDigest(operations.map(({ id, afterDigest }) => ({ id, afterDigest }))),
    payloadDigest: canonicalDigest(operations.map(({ id, payloadDigest }) => ({ id, payloadDigest })))
  };
  const handle: LocalMigrationPlan = Object.freeze({ kind: 'local-migration-plan' });
  plans.set(handle, {
    proposal, blocked: false, completed: false,
    metadata: {
      kind: 'local-migration-plan-description', identity, observedAt: proposal.observedAt, ...bindings,
      planDigest: canonicalDigest({ kind: 'simulation-only-migration-plan', identity, ...bindings }),
      productionEnabled: false, payloadValidation: 'independently-supplied-not-authenticated', operations
    }
  });
  return handle;
}

function planState(handle: LocalMigrationPlan): PlanState {
  return plans.get(handle) ?? fail('unrecognized-plan');
}
function simulationState(handle: InMemoryMigrationTransport, plan: PlanState): SimulationState {
  const state = simulations.get(handle);
  if (!state || state.registryDigest !== plan.metadata.registryDigest) fail('in-memory-transport-required');
  return state;
}

export function describeHostedMigration(handle: LocalMigrationPlan): PlanState['metadata'] {
  return structuredClone(planState(handle).metadata);
}

/**
 * The only transport constructor. No executable adapters, HTTP clients, callback
 * hooks or credentials are accepted. Faults affect this isolated memory only.
 * Writes install the supplied after snapshot; they do not model API payload semantics.
 */
export function createMigrationSimulation(input: {
  registry: MigrationRegistry;
  states: readonly { endpointId: string; value: MigrationJson }[];
  faults: readonly MigrationSimulationFault[];
}): InMemoryMigrationTransport {
  const item = record(data(input), ['registry', 'states', 'faults'], 'hosted-migration-simulation');
  const registry = parseRegistry(item.registry);
  const entries = array(item.states).map(value => {
    const state = record(value, ['endpointId', 'value'], 'hosted-migration-simulation-state');
    const id = identifier(state.endpointId, 'hosted-migration-endpoint-id');
    if (!registry.endpoints.some(endpoint => endpoint.id === id)) fail('unregistered-endpoint');
    return [id, state.value as Json] as const;
  });
  unique(entries.map(([id]) => id));
  if (entries.length !== registry.endpoints.length) fail('registry-coverage');
  const faults = array(item.faults, HOSTED_MIGRATION_LIMITS.transportCalls).map(value => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('simulation-fault');
    const drift = (value as Record<string, unknown>).kind === 'drift';
    const fault = record(value, drift ? ['call', 'kind', 'endpointId', 'value'] : ['call', 'kind', 'diagnostic'], 'hosted-migration-fault');
    if (!Number.isSafeInteger(fault.call) || (fault.call as number) < 1 ||
        (fault.call as number) > HOSTED_MIGRATION_LIMITS.transportCalls) fail('simulation-fault');
    if (drift) {
      const endpointId = identifier(fault.endpointId, 'hosted-migration-endpoint-id');
      if (!entries.some(([id]) => id === endpointId)) fail('unregistered-endpoint');
      return { call: fault.call as number, kind: 'drift' as const, endpointId, value: fault.value as Json };
    }
    if (!['read-error', 'write-error-before-effect', 'write-error-after-effect'].includes(fault.kind as string) ||
        typeof fault.diagnostic !== 'string' || fault.diagnostic.length > 4096) fail('simulation-fault');
    return { call: fault.call as number, kind: fault.kind as 'read-error' | 'write-error-before-effect' | 'write-error-after-effect',
      diagnostic: fault.diagnostic };
  });
  unique(faults.map(fault => String(fault.call)));
  const handle: InMemoryMigrationTransport = Object.freeze({ kind: 'in-memory-migration-transport' });
  simulations.set(handle, {
    registryDigest: canonicalDigest(registry), values: new Map(entries), faults: new Map(faults.map(fault => [fault.call, fault])),
    trace: [], consents: new Map()
  });
  return handle;
}

export function inspectMigrationSimulation(handle: InMemoryMigrationTransport) {
  const state = simulations.get(handle) ?? fail('in-memory-transport-required');
  return {
    kind: 'in-memory-simulation-inspection' as const, liveEffects: false as const,
    states: [...state.values].map(([endpointId, value]) => ({ endpointId, digest: canonicalDigest(value) }))
      .sort((a, b) => a.endpointId < b.endpointId ? -1 : a.endpointId > b.endpointId ? 1 : 0),
    trace: structuredClone(state.trace)
  };
}

function request(state: SimulationState, entry: Omit<Trace, 'call' | 'result'>) {
  if (state.trace.length >= HOSTED_MIGRATION_LIMITS.transportCalls) fail('simulation-call-limit');
  const trace: Trace = { ...entry, call: state.trace.length + 1, result: 'error' };
  state.trace.push(trace);
  const fault = state.faults.get(trace.call);
  if (fault?.kind === 'drift') state.values.set(fault.endpointId, fault.value);
  return { trace, fault };
}

function read(state: SimulationState, endpointId: string, phase: Phase): string {
  const { trace, fault } = request(state, { endpointId, phase, method: 'GET', conditionDigest: null, payloadDigest: null });
  if (fault && fault.kind !== 'drift') throw new Error(fault.diagnostic);
  const value = state.values.get(endpointId);
  if (value === undefined) fail('missing-simulation-state');
  trace.result = 'read';
  return canonicalDigest(value);
}

function write(
  state: SimulationState, operation: MigrationOperation, metadata: OperationMetadata,
  guards: readonly OperationMetadata[], current: ReadonlyMap<string, string>
): boolean {
  const { trace, fault } = request(state, {
    endpointId: operation.endpointId, phase: 'apply', method: metadata.method,
    conditionDigest: metadata.beforeDigest, payloadDigest: metadata.payloadDigest
  });
  if (fault && fault.kind !== 'drift' && fault.kind !== 'write-error-after-effect') throw new Error(fault.diagnostic);
  if (canonicalDigest(state.values.get(operation.endpointId)) !== metadata.beforeDigest ||
      guards.some(guard => canonicalDigest(state.values.get(guard.endpointId)) !== current.get(guard.id))) {
    trace.result = 'precondition-rejected';
    return false;
  }
  state.values.set(operation.endpointId, operation.after);
  if (fault?.kind === 'write-error-after-effect') throw new Error(fault.diagnostic);
  trace.result = 'acknowledged';
  return true;
}

function freshPlan(plan: PlanState, now: Date): void {
  const age = nowTime(now) - time(plan.proposal.observedAt);
  if (age < 0 || age > HOSTED_MIGRATION_LIMITS.snapshotAgeMs) fail('stale-plan');
}

export function diffHostedMigration(handle: LocalMigrationPlan, transport: InMemoryMigrationTransport, now: Date) {
  const plan = planState(handle), state = simulationState(transport, plan);
  freshPlan(plan, now);
  const operations = plan.metadata.operations.map(operation => {
    let observedDigest: string;
    try { observedDigest = read(state, operation.endpointId, 'preflight'); }
    catch { return { ...operation, observedDigest: null, state: 'read-error' as const }; }
    return {
      ...operation, observedDigest,
      state: observedDigest === operation.afterDigest ? 'already-matches' as const
        : observedDigest === operation.beforeDigest ? 'change-required' as const : 'drift' as const
    };
  });
  const blocked = operations.some(operation => operation.state === 'drift' || operation.state === 'read-error');
  if (blocked) plan.blocked = true;
  return {
    kind: 'simulated-read-only-migration-diff' as const, planDigest: plan.metadata.planDigest,
    productionEnabled: false as const, mutationCount: 0 as const,
    status: blocked ? 'blocked' as const : 'ready-for-simulation' as const,
    consentInvalidated: blocked,
    operations
  };
}

function consent(value: MigrationSimulationConsent, plan: PlanState, now: Date) {
  const item = record(data(value), [
    'kind', 'id', 'owner', 'identity', 'planDigest', 'registryDigest', 'beforeDigest', 'afterDigest',
    'payloadDigest', 'approvedAt', 'expiresAt'
  ], 'hosted-migration-consent');
  if (item.kind !== 'simulation-only-migration-consent' || item.owner !== 'voyager163') fail('simulation-consent-required');
  const identity = parseIdentity(item.identity);
  if (canonicalDigest(identity) !== canonicalDigest(plan.metadata.identity)) fail('consent-identity');
  for (const key of ['planDigest', 'registryDigest', 'beforeDigest', 'afterDigest', 'payloadDigest'] as const) {
    if (digest(item[key]) !== plan.metadata[key]) fail('consent-payload-mismatch');
  }
  const approved = time(item.approvedAt), expiry = time(item.expiresAt), stamp = nowTime(now);
  if (approved < time(plan.proposal.observedAt) || approved > stamp || expiry <= stamp ||
      expiry - approved > HOSTED_MIGRATION_LIMITS.consentWindowMs) fail('expired-consent');
  return { id: identifier(item.id, 'hosted-migration-consent-id'), digest: canonicalDigest(item) };
}

/**
 * Ordered simulation, not a production transport adapter. Every registered
 * endpoint is preflighted, rechecked before each write, conditionally updated,
 * read back immediately and checked again at the end. The CAS here is a fake
 * transport guarantee, NOT a claim that any hosted endpoint supports CAS.
 */
export function applyHostedMigrationSimulation(
  handle: LocalMigrationPlan, authorization: MigrationSimulationConsent,
  transport: InMemoryMigrationTransport, now: Date
): MigrationSimulationResult {
  const plan = planState(handle), state = simulationState(transport, plan);
  freshPlan(plan, now);
  const permit = consent(authorization, plan, now);
  const previous = state.consents.get(permit.id);
  if (plan.blocked || previous?.status === 'blocked') fail('consent-invalidated');
  if (previous && previous.digest !== permit.digest) fail('consent-id-reused');
  const operations: OperationProgress[] = plan.metadata.operations.map(operation => ({
    ...operation, write: 'not-attempted', verification: 'not-read', observedDigest: null, noop: false
  }));
  const result: MigrationSimulationResult = {
    kind: 'simulated-migration-result', status: 'blocked', planDigest: plan.metadata.planDigest,
    consentDigest: permit.digest, liveEffects: false, hostedQualification: false, operations, recovery: null
  };
  const stop = (reason: Failure, phase: Phase, operation: OperationProgress): MigrationSimulationResult => {
    plan.blocked = true;
    state.consents.set(permit.id, { digest: permit.digest, status: 'blocked' });
    result.recovery = {
      reason, phase, operationId: operation.id,
      acknowledged: operations.filter(item => item.write === 'acknowledged').map(item => item.id),
      verified: operations.filter(item => item.verification === 'after-matched').map(item => item.id),
      uncertain: operations.filter(item => item.write === 'uncertain' ||
        item.write === 'acknowledged' && item.verification !== 'after-matched').map(item => item.id),
      unattempted: operations.filter(item => item.write === 'not-attempted').map(item => item.id),
      action: 'stop-retain-effects-refresh-readback-revalidate-and-obtain-new-consent',
      automaticRollback: false, consentInvalidated: true
    };
    return result;
  };
  const observe = (operation: OperationProgress, phase: Phase): boolean => {
    try {
      operation.observedDigest = read(state, operation.endpointId, phase);
      operation.verification = operation.observedDigest === operation.afterDigest ? 'after-matched'
        : operation.observedDigest === operation.beforeDigest ? 'before-matched' : 'mismatched';
      return true;
    } catch {
      operation.observedDigest = null;
      operation.verification = 'read-error';
      return false;
    }
  };
  const current = new Map<string, string>();
  for (const operation of operations) {
    if (!observe(operation, 'preflight')) return stop('read-error', 'preflight', operation);
    if (operation.verification === 'mismatched' ||
        (plan.completed || previous?.status === 'completed') && operation.verification !== 'after-matched') {
      return stop('drift', 'preflight', operation);
    }
    operation.noop = operation.verification === 'after-matched';
    current.set(operation.id, operation.observedDigest!);
  }
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index]!;
    if (operation.noop) continue;
    for (const guard of operations) {
      if (!observe(guard, 'precondition')) return stop('read-error', 'precondition', guard);
      if (guard.observedDigest !== current.get(guard.id)) return stop('drift', 'precondition', guard);
    }
    // Once dispatched, a thrown transport error cannot prove whether a write took effect.
    operation.write = 'uncertain';
    operation.verification = 'not-read';
    operation.observedDigest = null;
    try {
      if (!write(state, plan.proposal.operations[index]!, operation, operations, current)) {
        operation.write = 'precondition-rejected';
        return stop('write-precondition-rejected', 'apply', operation);
      }
      operation.write = 'acknowledged';
    } catch { return stop('write-error', 'apply', operation); }
    if (!observe(operation, 'readback')) return stop('read-error', 'readback', operation);
    if (operation.observedDigest !== operation.afterDigest) return stop('readback-mismatch', 'readback', operation);
    current.set(operation.id, operation.afterDigest);
  }
  for (const operation of operations) {
    if (!observe(operation, 'final-readback')) return stop('read-error', 'final-readback', operation);
    if (operation.verification !== 'after-matched') return stop('readback-mismatch', 'final-readback', operation);
  }
  plan.completed = true;
  state.consents.set(permit.id, { digest: permit.digest, status: 'completed' });
  result.status = 'completed';
  return result;
}

export const hostedMigrationProductionBoundary = Object.freeze({
  enabled: false,
  requirements: Object.freeze([
    'independently-authenticated-current-repository-and-owner-scope',
    'independently-validated-endpoint-schemas-capabilities-and-protection-preservation',
    'independently-authenticated-exact-payload-bound-owner-authorization',
    'fresh-authenticated-before-after-readback-and-qualified-conditional-write-semantics',
    'separately-authorized-hosted-effects-and-behavioral-qualification'
  ])
});

/** No production entry, transport, receipt or caller-supplied flag can enable hosted effects. */
export function applyHostedMigrationProduction(): never {
  return fail('production-disabled-independent-authentication-required');
}
