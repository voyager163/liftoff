import {
  type InspectedState,
  type StateArtifactDescriptor,
  type ExecuteStateMigrationRequest,
  type StateBackendBinding,
  type StateBackendLease,
  type StateCheckpoint,
  type StateMigrationDependencies,
  type StateMigrationJournal,
  type StateMigrationPlan,
  type StateMigrationResult,
  type StateSnapshot
} from '../../domain/repair/stateful.js';
import {
  freezeStateValue, inspectStateBytes, isStateDigest, stateAssert, stateContentMatches, stateDigest, stateFailure,
  stateObjectDigest, stateOpaqueRef, stateSnapshotMatches, verifyStateAccounting
} from '../../domain/repair/stateful-invariants.js';
import { loadApprovedStatePlan } from './planning.js';
import { StateMigrationRuntime, stateOperationId, statePlanFingerprint } from './runtime.js';

const quarantinedOperations = new Map<string, StateMigrationProtocol>();

export function hasQuarantinedStateOperation(operationId: string): boolean {
  return quarantinedOperations.has(operationId);
}

export function migrationResult(
  runtime: StateMigrationRuntime,
  journal: StateMigrationJournal | null,
  journalRef: string | null,
  fingerprint: string,
  code?: ReturnType<typeof stateFailure>,
  recovery = false
): StateMigrationResult {
  const complete = !code && journal?.completedAt !== null && journal?.completedAt !== undefined;
  const compensated = complete && journal?.compensated === true;
  const progressed = journal?.checkpoints.some((entry) => entry.kind !== 'started' && entry.kind !== 'blocked')
    || code === 'recovery-required';
  const retained = journal?.completedAt !== null && journal?.completedAt !== undefined;
  return {
    schemaVersion: 1, operationKind: recovery ? 'state-recovery' : 'stateful-migration',
    status: complete ? (compensated ? 'compensated' : 'verified') : journal && progressed ? 'incomplete' : 'rejected',
    exitCode: complete ? 0 : journal && progressed ? 2 : 1, operationRef: journal?.operationId ?? null,
    journalRef, planFingerprint: isStateDigest(fingerprint) ? fingerprint : '',
    workspaceRef: runtime.deps.workspace.workspaceRef, repairScopeComplete: complete && !compensated,
    atomicAcrossBackends: false,
    checkpoints: (journal?.checkpoints ?? []).map((entry) => ({
      sequence: entry.sequence, kind: entry.kind, ...(entry.backendId ? { backendRef: stateOpaqueRef(entry.backendId) } : {})
    })),
    blockers: code ? [{ code }] : [],
    lifecycle: {
      status: retained ? 'retained' : 'not-started',
      notBefore: retained ? journal!.completedAt! + journal!.plan.intent.retentionMs : null,
      artifactCount: journal?.backups.length ?? 0
    }
  };
}

export class StateMigrationProtocol {
  #descriptor: StateArtifactDescriptor;
  #leases = new Map<string, StateBackendLease>();
  #expected: Map<string, StateSnapshot>;
  #configurationAfter = false;

  constructor(
    readonly runtime: StateMigrationRuntime,
    readonly journal: StateMigrationJournal,
    descriptor: StateArtifactDescriptor,
    expected: readonly InspectedState[],
    private readonly authorize: () => void,
    private readonly signal: AbortSignal
  ) {
    this.#descriptor = descriptor;
    this.journal.plan = freezeStateValue(this.journal.plan);
    this.#expected = new Map(expected.map((state) => [state.snapshot.backendId, freezeStateValue(state.snapshot)]));
  }

  get descriptor(): StateArtifactDescriptor { return this.#descriptor; }
  private get plan(): StateMigrationPlan { return this.journal.plan; }
  private binding(id: string): StateBackendBinding {
    const binding = this.plan.inspection.bindings.find((entry) => entry.id === id);
    stateAssert(binding, 'mapping-incomplete');
    return binding;
  }

  async checkpoint(kind: StateCheckpoint['kind'], fields: Omit<Partial<StateCheckpoint>, 'sequence' | 'kind' | 'at'> = {}): Promise<void> {
    stateAssert(this.journal.checkpoints.length < 512, 'storage-limit');
    this.journal.checkpoints = [...this.journal.checkpoints, {
      sequence: this.journal.checkpoints.length + 1, kind, at: this.runtime.now(), ...fields
    }];
    this.#descriptor = await this.runtime.replace(this.#descriptor, this.journal);
  }

  private async configuration(): Promise<void> {
    const actual = await this.runtime.writers.inspectConfiguration(this.plan.context, this.signal);
    const expected = this.#configurationAfter ? this.plan.intent.targetConfigurationDigest : this.plan.context.configurationDigest;
    stateAssert(actual === expected, 'configuration-changed');
  }

  private async guard(): Promise<void> {
    stateAssert(statePlanFingerprint(this.plan) === this.plan.fingerprint, 'artifact-integrity');
    this.authorize();
    this.runtime.checkSignal(this.signal);
    await this.runtime.available(this.plan.context, this.signal);
    stateAssert(this.journal.writerHandle, 'writers-not-quiesced');
    await this.runtime.writers.assertQuiesced(this.journal.writerHandle, this.plan.intent.writerInventoryDigest, this.signal);
    await this.configuration();
    for (const lease of this.#leases.values()) await this.runtime.external(this.signal, (signal) => lease.assertHeld(signal));
  }

  private async current(id: string): Promise<InspectedState> {
    const expected = this.#expected.get(id);
    stateAssert(expected, 'mapping-incomplete');
    return this.runtime.checkState(this.binding(id), this.plan.context, expected, this.#leases.get(id), this.signal);
  }

  private async allCurrent(): Promise<Record<string, InspectedState>> {
    const current: Record<string, InspectedState> = {};
    for (const binding of this.plan.inspection.bindings) current[binding.id] = await this.current(binding.id);
    return current;
  }

  async acquire(recovering: boolean): Promise<void> {
    this.authorize();
    const previous = quarantinedOperations.get(this.journal.operationId);
    if (recovering && previous && previous !== this) await previous.release();
    await this.runtime.quiesceNative();
    await this.runtime.available(this.plan.context, this.signal);
    const actualConfiguration = await this.runtime.writers.inspectConfiguration(this.plan.context, this.signal);
    if (actualConfiguration === this.plan.intent.targetConfigurationDigest && recovering) {
      stateAssert(this.journal.checkpoints.some((entry) => entry.kind === 'configuration-intent'), 'configuration-changed');
      this.#configurationAfter = true;
    }
    await this.configuration();
    for (const binding of this.plan.inspection.bindings) {
      await this.runtime.backend(binding).assertAccess(this.plan.context, true, this.signal);
      await this.runtime.checkState(binding, this.plan.context, this.#expected.get(binding.id)!, undefined, this.signal);
    }
    await this.checkpoint('writers-pause-intent');
    this.journal.writerHandle = await this.runtime.writers.quiesce({
      operationId: this.journal.operationId, context: this.plan.context,
      backendIds: this.plan.inspection.bindings.map((binding) => binding.id),
      writerInventoryDigest: this.plan.intent.writerInventoryDigest, signal: this.signal
    });
    stateAssert(typeof this.journal.writerHandle === 'string' && this.journal.writerHandle.length > 0, 'writers-not-quiesced');
    await this.checkpoint('writers-paused');
    const ordered = [...this.plan.inspection.bindings].sort((a, b) => a.id.localeCompare(b.id, 'en'));
    for (const binding of ordered) {
      await this.guard();
      const expected = this.#expected.get(binding.id)!;
      this.#leases.set(binding.id, await this.runtime.backend(binding).acquire(expected, this.plan.context, this.journal.operationId, this.signal));
    }
    await this.guard();
    await this.allCurrent();
  }

  async release(): Promise<void> {
    try { await this.runtime.quiesceNative(); }
    catch (error) {
      if (this.#leases.size) quarantinedOperations.set(this.journal.operationId, this);
      throw error;
    }
    let failure: unknown;
    for (const [id, lease] of [...this.#leases.entries()].reverse()) {
      try { await this.runtime.external(undefined, () => lease.release()); this.#leases.delete(id); }
      catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
    quarantinedOperations.delete(this.journal.operationId);
  }

  private async backups(): Promise<void> {
    if (this.journal.checkpoints.some((entry) => entry.kind === 'backups-verified')) {
      await this.verifyBackups();
      return;
    }
    stateAssert(!this.journal.prepared, 'artifact-integrity');
    this.journal.backups = [];
    for (const binding of this.plan.inspection.bindings) {
      await this.guard();
      const current = await this.current(binding.id);
      const bytes = current.stateRef
        ? await this.runtime.deps.workspace.get(current.stateRef, 'state', this.runtime.scope(this.plan.context))
        : Buffer.from(JSON.stringify({ exists: false, snapshot: current.snapshot }));
      try {
        const backup = await this.runtime.deps.workspace.put('backup', this.runtime.scope(this.plan.context), bytes);
        this.journal.backups = [...this.journal.backups, backup];
        this.#descriptor = await this.runtime.replace(this.#descriptor, this.journal);
      } finally { bytes.fill(0); }
    }
    await this.checkpoint('backups-verified');
  }

  private async verifyBackups(): Promise<void> {
    stateAssert(this.journal.backups.length === this.plan.inspection.states.length, 'artifact-integrity');
    for (const backup of this.journal.backups) {
      const actual = await this.runtime.deps.workspace.describe(backup.ref, 'backup', backup.scope);
      stateAssert(actual?.digest === backup.digest, 'artifact-integrity');
    }
  }

  private async prepared(): Promise<void> {
    await this.guard();
    if (!this.journal.prepared) {
      this.journal.prepared = freezeStateValue(await this.runtime.native.prepare(this.plan, this.signal));
      stateAssert(isStateDigest(this.journal.prepared.verificationDigest), 'verification-incomplete');
    }
    const source = this.plan.inspection.states.find((entry) => entry.snapshot.backendId === this.plan.intent.sourceBackendId)!;
    verifyStateAccounting(this.plan.intent, source, this.journal.prepared.candidates, false);
    for (const [id, candidate] of Object.entries(this.journal.prepared.candidates)) {
      stateAssert(candidate.stateRef && candidate.snapshot.digest && candidate.snapshot.backendId === id
        && candidate.snapshot.bindingDigest === this.#expected.get(id)?.bindingDigest, 'artifact-integrity');
      const bytes = await this.runtime.deps.workspace.get(candidate.stateRef, 'candidate', this.runtime.scope(this.plan.context));
      try {
        const inspected = inspectStateBytes(candidate.snapshot, bytes);
        stateAssert(stateContentMatches(inspected.snapshot, candidate.snapshot)
          && stateObjectDigest(inspected.instances) === stateObjectDigest(candidate.instances), 'artifact-integrity');
      } finally { bytes.fill(0); }
      if (id === source.snapshot.backendId) {
        stateAssert(candidate.snapshot.lineage === source.snapshot.lineage
          && candidate.snapshot.serial! >= source.snapshot.serial!, 'stale-state');
      }
    }
    await this.checkpoint('prepared');
    await this.guard();
    await this.allCurrent();
  }

  private async publish(id: string, sourceRetirement = false): Promise<void> {
    await this.guard();
    await this.verifyBackups();
    const candidate = this.journal.prepared!.candidates[id];
    stateAssert(candidate?.stateRef, 'mapping-incomplete');
    const before = await this.current(id);
    if (stateContentMatches(before.snapshot, candidate.snapshot)) return;
    const bytes = await this.runtime.deps.workspace.get(candidate.stateRef, 'candidate', this.runtime.scope(this.plan.context));
    try {
      stateAssert(stateDigest(bytes) === candidate.snapshot.digest, 'artifact-integrity');
      await this.checkpoint(sourceRetirement ? 'source-retirement-intent' : 'write-intent', { backendId: id, snapshot: before.snapshot });
      await this.guard();
      const metadata = await this.runtime.backend(this.binding(id)).writePrivate({
        bytes, expected: before.snapshot, lease: this.#leases.get(id)!, context: this.plan.context,
        operationId: this.journal.operationId, signal: this.signal
      });
      const current = await this.runtime.readState(this.binding(id), this.plan.context, metadata, this.#leases.get(id), this.signal);
      stateAssert(stateContentMatches(current.snapshot, candidate.snapshot), 'verification-incomplete');
      this.#expected.set(id, freezeStateValue(current.snapshot));
      await this.checkpoint(sourceRetirement ? 'source-retired' : 'destination-written', { backendId: id, snapshot: current.snapshot });
    } finally { bytes.fill(0); }
  }

  private async retireSource(): Promise<void> {
    if (this.plan.intent.recipe === 'address-refactor') return;
    const id = this.plan.intent.sourceBackendId;
    if (this.journal.prepared!.candidates[id]) {
      await this.publish(id, true);
      return;
    }
    await this.guard();
    await this.verifyBackups();
    const current = await this.current(id);
    if (!current.snapshot.exists) return;
    await this.checkpoint('source-retirement-intent', { backendId: id, snapshot: current.snapshot });
    await this.guard();
    const metadata = await this.runtime.backend(this.binding(id)).remove({
      expected: current.snapshot, lease: this.#leases.get(id)!, context: this.plan.context,
      operationId: this.journal.operationId, signal: this.signal
    });
    const absent = await this.runtime.readState(this.binding(id), this.plan.context, metadata, this.#leases.get(id), this.signal);
    stateAssert(!absent.snapshot.exists, 'verification-incomplete');
    this.#expected.set(id, freezeStateValue(absent.snapshot));
    await this.checkpoint('source-retired', { backendId: id, snapshot: absent.snapshot });
  }

  private async verifyFinal(): Promise<string> {
    await this.guard();
    const final = await this.allCurrent();
    const source = this.plan.inspection.states.find((entry) => entry.snapshot.backendId === this.plan.intent.sourceBackendId)!;
    verifyStateAccounting(this.plan.intent, source, final, false);
    for (const [id, state] of Object.entries(final)) {
      const expected = this.journal.prepared!.candidates[id];
      stateAssert(expected ? stateContentMatches(state.snapshot, expected.snapshot) : !state.snapshot.exists, 'verification-incomplete');
    }
    const proof = await this.runtime.native.verify(this.plan, final, this.signal);
    stateAssert(isStateDigest(proof), 'verification-incomplete');
    await this.guard();
    await this.allCurrent();
    return proof;
  }

  async forward(): Promise<void> {
    await this.backups();
    await this.prepared();
    for (const id of this.plan.intent.destinationBackendIds) await this.publish(id);
    await this.guard();
    const destinations: Record<string, InspectedState> = {};
    for (const id of this.plan.intent.destinationBackendIds) {
      const current = await this.current(id);
      stateAssert(stateContentMatches(current.snapshot, this.journal.prepared!.candidates[id].snapshot), 'verification-incomplete');
      destinations[id] = current;
    }
    const destinationProof = await this.runtime.native.verifyDestinations(this.plan, destinations, this.signal);
    stateAssert(isStateDigest(destinationProof), 'verification-incomplete');
    await this.guard();
    await this.allCurrent();
    await this.checkpoint('destinations-verified');
    await this.retireSource();
    await this.verifyFinal();
    if (!this.#configurationAfter) {
      await this.checkpoint('configuration-intent');
      await this.guard();
      await this.runtime.writers.commitConfiguration({
        operationId: this.journal.operationId, writerHandle: this.journal.writerHandle!,
        beforeDigest: this.plan.context.configurationDigest, afterDigest: this.plan.intent.targetConfigurationDigest,
        mappingDigest: stateObjectDigest(this.plan.intent.mappings), signal: this.signal
      });
      this.#configurationAfter = true;
      await this.configuration();
      await this.checkpoint('configuration-committed');
    }
    const nativeProof = await this.verifyFinal();
    const cutoverProof = await this.runtime.writers.verifyCutover({
      operationId: this.journal.operationId, writerHandle: this.journal.writerHandle!,
      configurationDigest: this.plan.intent.targetConfigurationDigest,
      mappingDigest: stateObjectDigest(this.plan.intent.mappings), signal: this.signal
    });
    stateAssert(isStateDigest(cutoverProof), 'verification-incomplete');
    await this.checkpoint('cutover-verified');
    await this.guard();
    await this.checkpoint('inventory-intent');
    await this.runtime.writers.publishInventory({
      operationId: this.journal.operationId, planFingerprint: this.plan.fingerprint,
      inventoryDigest: this.plan.intent.targetInventoryDigest,
      verificationDigest: stateObjectDigest({ nativeProof, cutoverProof }), signal: this.signal
    });
    await this.checkpoint('inventory-published');
    await this.release();
    this.authorize();
    await this.configuration();
    await this.runtime.writers.resume({
      operationId: this.journal.operationId, writerHandle: this.journal.writerHandle!,
      configurationDigest: this.plan.intent.targetConfigurationDigest, signal: this.signal
    });
    await this.checkpoint('writers-resumed');
    const resumed = await this.runtime.writers.verifyCutover({
      operationId: this.journal.operationId, writerHandle: this.journal.writerHandle!,
      configurationDigest: this.plan.intent.targetConfigurationDigest,
      mappingDigest: stateObjectDigest(this.plan.intent.mappings), signal: this.signal
    });
    stateAssert(isStateDigest(resumed), 'verification-incomplete');
    this.journal.completedAt = this.runtime.now();
    await this.checkpoint('verified');
  }

  async compensate(): Promise<void> {
    stateAssert(!this.#configurationAfter && this.plan.intent.recovery.includes('remove-new-destinations')
      && this.plan.intent.recipe !== 'address-refactor' && this.journal.prepared, 'recovery-conflict');
    const original = this.plan.inspection.states.find((state) => state.snapshot.backendId === this.plan.intent.sourceBackendId)!;
    stateAssert(stateSnapshotMatches((await this.current(original.snapshot.backendId)).snapshot, original.snapshot), 'recovery-conflict');
    for (const id of this.plan.intent.destinationBackendIds) {
      await this.guard();
      const current = await this.current(id);
      if (!current.snapshot.exists) continue;
      const before = this.plan.inspection.states.find((entry) => entry.snapshot.backendId === id)!;
      const candidate = this.journal.prepared.candidates[id];
      const acknowledged = this.journal.checkpoints.some((entry) => entry.kind === 'destination-written'
        && entry.backendId === id && entry.snapshot && stateSnapshotMatches(entry.snapshot, current.snapshot));
      stateAssert(!before.snapshot.exists && candidate && stateContentMatches(candidate.snapshot, current.snapshot)
        && (current.snapshot.operationId === this.journal.operationId || acknowledged), 'ownership-mismatch');
      await this.checkpoint('compensation-intent', { backendId: id, snapshot: current.snapshot });
      await this.guard();
      const metadata = await this.runtime.backend(this.binding(id)).remove({
        expected: current.snapshot, lease: this.#leases.get(id)!, context: this.plan.context,
        operationId: this.journal.operationId, signal: this.signal
      });
      const absent = await this.runtime.readState(this.binding(id), this.plan.context, metadata, this.#leases.get(id), this.signal);
      stateAssert(!absent.snapshot.exists, 'verification-incomplete');
      this.#expected.set(id, freezeStateValue(absent.snapshot));
      await this.checkpoint('compensated', { backendId: id, snapshot: absent.snapshot });
    }
    await this.guard();
    const final = await this.allCurrent();
    stateAssert(stateSnapshotMatches(final[original.snapshot.backendId].snapshot, original.snapshot)
      && this.plan.intent.destinationBackendIds.every((id) => !final[id].snapshot.exists), 'verification-incomplete');
    await this.runtime.native.review({
      context: this.plan.context, inspection: { ...this.plan.inspection, states: Object.values(final) },
      intent: this.plan.intent, signal: this.signal
    });
    await this.guard();
    await this.release();
    await this.runtime.writers.resume({
      operationId: this.journal.operationId, writerHandle: this.journal.writerHandle!,
      configurationDigest: this.plan.context.configurationDigest, signal: this.signal
    });
    this.journal.compensated = true;
    this.journal.completedAt = this.runtime.now();
    await this.checkpoint('compensated');
  }
}

export async function executeStateMigration(
  dependencies: StateMigrationDependencies,
  request: ExecuteStateMigrationRequest
): Promise<StateMigrationResult> {
  const runtime = new StateMigrationRuntime(dependencies);
  let journal: StateMigrationJournal | null = null;
  let journalRef: string | null = null;
  let protocol: StateMigrationProtocol | null = null;
  let fingerprint = request.approval?.fingerprint ?? '';
  let failure: ReturnType<typeof stateFailure> | undefined;
  try {
    const plan = await loadApprovedStatePlan(runtime, request);
    fingerprint = plan.fingerprint;
    const operationId = stateOperationId(plan.fingerprint);
    const initial: StateMigrationJournal = {
      schemaVersion: 1, operationId, planRef: request.planRef, plan,
      writerHandle: null, backups: [], prepared: null, checkpoints: [],
      completedAt: null, compensated: false
    };
    journalRef = `${dependencies.workspace.workspaceRef}/${operationId}`;
    let descriptor: StateArtifactDescriptor;
    try { descriptor = await runtime.save('journal', request.context, initial, operationId); }
    catch (error) {
      if (stateFailure(error) === 'recovery-required') {
        journal = (await runtime.load<StateMigrationJournal>(journalRef, 'journal', request.context)).value;
      }
      throw error;
    }
    journal = initial;
    const authorize = (): void => runtime.authority(request.approval, 'state-write', plan.fingerprint, plan.expiresAt);
    protocol = new StateMigrationProtocol(runtime, journal, descriptor, plan.inspection.states, authorize, runtime.signal(request.signal));
    await protocol.checkpoint('started');
    await protocol.acquire(false);
    await protocol.forward();
  } catch (error) {
    failure = stateFailure(error);
    if (protocol) {
      try { await protocol.checkpoint('blocked', { code: failure }); } catch { /* The last durable intent remains the recovery boundary. */ }
    }
  } finally {
    try { await protocol?.release(); }
    catch (error) {
      const code = stateFailure(error);
      if (code === 'process-tree-termination-unproven') failure = code;
      else failure ??= code;
    }
  }
  return migrationResult(runtime, journal, journalRef, fingerprint, failure);
}
