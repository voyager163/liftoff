import { lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { protectedStateScope } from '../../adapters/state/protected-workspace.js';
import type { PrivateStateEffectRecorder } from '../../adapters/azure/private-state-path.js';
import type { ProtectedStateWorkspace, StateArtifactDescriptor, StateExecutionContext } from '../../domain/repair/stateful.js';
import { stateDigest } from '../../domain/repair/stateful-invariants.js';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import {
  applicationPrivateAssert as must, applicationPrivateProtocol,
  type ApplicationPrivateAuthority, type ApplicationPrivateConfiguration, type ApplicationPrivateEvent,
  type ApplicationPrivateJournal, type ApplicationPrivatePhase, type ApplicationPrivateResourceIntent
} from './application-private-contracts.js';
import { applicationPrivateJson } from './application-private-plan.js';
import { applicationPrivateObject } from './application-private-inputs.js';

interface Slot {
  schemaVersion: 1;
  protocol: typeof applicationPrivateProtocol;
  projectRoot: string;
  projectIdentity: { device: string; inode: string; birthtime: string };
  sequence: number;
  backendKey: string;
  transactionId: string;
  journalRef: string;
  workspaceRef: string;
  phaseId: ApplicationPrivatePhase;
  approvalEnvelopeHash: string;
  preparedAt: string;
}

export function applicationPrivateArtifactId(value: unknown): string {
  const hash = canonicalSha256(value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function projectIdentity(root: string) {
  const info = await lstat(root);
  must(info.isDirectory() && !info.isSymbolicLink() && await realpath(root) === root, 'checkpoint-project');
  return { device: String(info.dev), inode: String(info.ino), birthtime: String(info.birthtimeMs) };
}

/**
 * Immutable per-backend indices are in the existing project-bound operation
 * store. Private state/plan/effect bodies use the existing encrypted workspace.
 * Changing a source, approval, workspace or phase cannot forget an open slot.
 */
export class ApplicationPrivateCheckpointStore {
  readonly #store;
  readonly #backendKey: string;
  constructor(private readonly options: {
    authority: ApplicationPrivateAuthority;
    workspace: ProtectedStateWorkspace;
    context: StateExecutionContext;
    configuration: ApplicationPrivateConfiguration;
  }) {
    const backend = options.configuration.backend.backend;
    this.#backendKey = canonicalSha256({
      protocol: applicationPrivateProtocol, tenantId: backend.tenantId.toLowerCase(),
      subscriptionId: backend.subscriptionId.toLowerCase(), account: backend.account.toLowerCase(),
      container: backend.container.toLowerCase(), key: backend.key
    });
    this.#store = createScopedUserLocalRecordStore(options.context.projectRoot, 'governance-operation', azurePorts(options.authority.input).storage);
  }

  private key(sequence: number, kind: string) {
    return canonicalSha256({ protocol: applicationPrivateProtocol, backend: this.#backendKey, sequence, kind });
  }

  private async entries(): Promise<readonly { slot: Slot; closed: boolean }[]> {
    const identity = await projectIdentity(this.options.context.projectRoot);
    let selected: Slot | null = null;
    let closed = false;
    const entries: { slot: Slot; closed: boolean }[] = [];
    for (let index = 0; index < 32; index++) {
      const started = await this.#store.read(this.key(index, 'started'));
      const final = await this.#store.read(this.key(index, 'closed'));
      if (!started) {
        must(!final, 'checkpoint-index-incomplete');
        return entries;
      }
      must(!selected || closed, 'checkpoint-open-predecessor');
      const value = applicationPrivateObject(started.value, ['schemaVersion', 'protocol', 'projectRoot', 'projectIdentity',
        'sequence', 'backendKey', 'transactionId', 'journalRef', 'workspaceRef', 'phaseId', 'approvalEnvelopeHash', 'preparedAt']);
      must(value.schemaVersion === 1 && value.protocol === applicationPrivateProtocol &&
        value.projectRoot === this.options.context.projectRoot && started.projectRoot === this.options.context.projectRoot &&
        canonicalSha256(value.projectIdentity) === canonicalSha256(identity) &&
        value.sequence === index && value.backendKey === this.#backendKey &&
        typeof value.transactionId === 'string' && /^[a-f0-9-]{36}$/u.test(value.transactionId) &&
        typeof value.journalRef === 'string' && typeof value.workspaceRef === 'string' &&
        typeof value.approvalEnvelopeHash === 'string' && /^[a-f0-9]{64}$/u.test(value.approvalEnvelopeHash), 'checkpoint-index-binding');
      selected = value as unknown as Slot;
      closed = final !== null;
      if (final) {
        const closure = applicationPrivateObject(final.value, ['schemaVersion', 'protocol', 'slotDigest', 'disposition', 'closedAt']);
        must(closure.schemaVersion === 1 && closure.protocol === applicationPrivateProtocol &&
          closure.slotDigest === canonicalSha256(selected) &&
          ['completed', 'partial-published', 'closed-unapplied'].includes(String(closure.disposition)), 'checkpoint-closure');
      }
      entries.push({ slot: selected, closed });
      if (!closed) return entries;
    }
    must(false, 'retained-transaction-bound');
  }

  async find(): Promise<{ slot: Slot | null; closed: boolean; next: number }> {
    const entries = await this.entries();
    return { slot: entries.at(-1)?.slot ?? null, closed: entries.at(-1)?.closed ?? false, next: entries.length };
  }

  async readCompleted(
    reference: { journalRef: string; transactionId: string }, phaseId: ApplicationPrivatePhase
  ): Promise<ApplicationPrivateJournalHandle> {
    const entries = await this.entries();
    const matches = entries.filter((entry) => entry.slot.journalRef === reference.journalRef &&
      entry.slot.transactionId === reference.transactionId);
    const entry = matches[0];
    must(matches.length === 1 && entry?.closed && entry.slot.phaseId === phaseId &&
      entry.slot.workspaceRef === this.options.workspace.workspaceRef, 'completed-original-checkpoint-required');
    const bytes = await this.options.workspace.get(entry.slot.journalRef, 'journal', protectedStateScope(this.options.context));
    try {
      const value = applicationPrivateJson(bytes);
      assertJournal(value, this.options.context, entry.slot.transactionId);
      must(value.phaseId === phaseId && value.final === 'completed' && value.nativeStarted && value.processSettled &&
        value.candidate && value.applyGovernancePlan && value.original && value.originalSnapshot, 'completed-private-execution-required');
      return new ApplicationPrivateJournalHandle(this.options.workspace, this.options.context, entry.slot.journalRef, value);
    } finally { bytes.fill(0); }
  }

  async create(sequence: number): Promise<{ slot: Slot; journal: ApplicationPrivateJournalHandle }> {
    await this.options.authority.assertCurrent();
    const { context, workspace, authority } = this.options;
    const transactionId = randomUUID();
    const value: ApplicationPrivateJournal = {
      schemaVersion: 1, protocol: applicationPrivateProtocol, transactionId,
      phaseId: authority.input.phase.id as ApplicationPrivatePhase, context,
      intentDigest: context.configurationDigest,
      originalApprovalEnvelopeHash: authority.input.plan.approval.envelopeHash!,
      originalGovernancePlan: structuredClone(authority.input.plan), applyGovernancePlan: null,
      prepareOperationDigest: canonicalSha256(authority.operations),
      original: null, originalSnapshot: null, directory: null, planRef: null, effectIntents: [],
      nativeStarted: false, processSettled: false, nativeExitCode: null, candidate: null, candidateSnapshot: null,
      observations: [], publication: 'none', publicationCorrelationId: null, applyApprovalEnvelopeHash: null,
      final: null, events: []
    };
    const bytes = Buffer.from(canonicalJson(value));
    let descriptor: StateArtifactDescriptor;
    try { descriptor = await workspace.put('journal', protectedStateScope(context), bytes); }
    finally { bytes.fill(0); }
    const slot: Slot = {
      schemaVersion: 1, protocol: applicationPrivateProtocol, projectRoot: context.projectRoot,
      projectIdentity: await projectIdentity(context.projectRoot), sequence, backendKey: this.#backendKey,
      transactionId, journalRef: descriptor.ref, workspaceRef: workspace.workspaceRef, phaseId: value.phaseId,
      approvalEnvelopeHash: value.originalApprovalEnvelopeHash,
      preparedAt: (authority.input.clock?.() ?? authority.input.now).toISOString()
    };
    await this.#store.write(this.key(sequence, 'started'), slot);
    await authority.input.lease!.assertHeld();
    return { slot, journal: new ApplicationPrivateJournalHandle(workspace, context, descriptor.ref, value) };
  }

  async open(slot: Slot): Promise<ApplicationPrivateJournalHandle> {
    must(slot.workspaceRef === this.options.workspace.workspaceRef && slot.phaseId === this.options.authority.input.phase.id,
      'original-workspace-or-phase-required');
    const bytes = await this.options.workspace.get(slot.journalRef, 'journal', protectedStateScope(this.options.context));
    try {
      const value = applicationPrivateJson(bytes);
      assertJournal(value, this.options.context, slot.transactionId);
      return new ApplicationPrivateJournalHandle(this.options.workspace, this.options.context, slot.journalRef, value);
    } finally { bytes.fill(0); }
  }

  async close(slot: Slot, disposition: NonNullable<ApplicationPrivateJournal['final']>): Promise<void> {
    await this.options.authority.assertCurrent();
    await this.#store.write(this.key(slot.sequence, 'closed'), {
      schemaVersion: 1, protocol: applicationPrivateProtocol, slotDigest: canonicalSha256(slot), disposition,
      closedAt: (this.options.authority.input.clock?.() ?? this.options.authority.input.now).toISOString()
    });
  }
}

function assertJournal(value: unknown, context: StateExecutionContext, transactionId: string): asserts value is ApplicationPrivateJournal {
  must(isRecord(value) && value.schemaVersion === 1 && value.protocol === applicationPrivateProtocol &&
    value.transactionId === transactionId && canonicalSha256(value.context) === canonicalSha256(context) &&
    value.intentDigest === context.configurationDigest && Array.isArray(value.events) && value.events.length <= 2048 &&
    Array.isArray(value.effectIntents) && typeof value.nativeStarted === 'boolean' && typeof value.processSettled === 'boolean',
  'original-private-journal-binding');
  must(value.events.every((event, index) => isRecord(event) && event.sequence === index && typeof event.kind === 'string' &&
    typeof event.at === 'string' && isRecord(event.details)), 'private-journal-sequence');
}

export class ApplicationPrivateJournalHandle {
  #tail: Promise<void> = Promise.resolve();
  constructor(
    readonly workspace: ProtectedStateWorkspace, readonly context: StateExecutionContext, readonly ref: string,
    private current: ApplicationPrivateJournal
  ) {}

  get value(): ApplicationPrivateJournal { return structuredClone(this.current); }
  get scope(): string { return protectedStateScope(this.context); }

  async change(action: (value: ApplicationPrivateJournal) => void): Promise<void> {
    const next = this.#tail.then(async () => {
      const descriptor = await this.workspace.describe(this.ref, 'journal', this.scope);
      must(descriptor, 'original-journal-missing');
      const bytes = await this.workspace.get(this.ref, 'journal', this.scope);
      let value: ApplicationPrivateJournal;
      try {
        must(stateDigest(bytes) === descriptor.digest, 'private-journal-concurrent-change');
        const parsed = applicationPrivateJson(bytes);
        assertJournal(parsed, this.context, this.current.transactionId);
        value = parsed;
      } finally { bytes.fill(0); }
      action(value);
      assertJournal(value, this.context, this.current.transactionId);
      const updated = Buffer.from(canonicalJson(value));
      try { await this.workspace.replace(this.ref, 'journal', this.scope, descriptor.digest, updated); }
      finally { updated.fill(0); }
      this.current = structuredClone(value);
    });
    this.#tail = next.catch(() => undefined);
    await next;
  }

  async event(kind: ApplicationPrivateEvent['kind'], at: string, details: Readonly<Record<string, unknown>>,
    change?: (value: ApplicationPrivateJournal) => void): Promise<void> {
    await this.change((value) => {
      must(value.events.length < 2048, 'private-event-bound');
      value.events = [...value.events, { sequence: value.events.length, kind, at, details: structuredClone(details) }];
      change?.(value);
    });
  }

  async resourceIntent(intent: ApplicationPrivateResourceIntent): Promise<StateArtifactDescriptor> {
    const id = applicationPrivateArtifactId({ transactionId: intent.transactionId, address: intent.address, kind: intent.kind });
    const ref = `${this.workspace.workspaceRef}/${id}`;
    const bytes = Buffer.from(canonicalJson(intent));
    try {
      const prior = await this.workspace.describe(ref, 'journal', this.scope);
      if (prior) {
        must(prior.digest === stateDigest(bytes), 'resource-intent-already-owned');
        return prior;
      }
      return await this.workspace.put('journal', this.scope, bytes, id);
    } finally { bytes.fill(0); }
  }

  backendRecorder(authority: ApplicationPrivateAuthority, config: ApplicationPrivateConfiguration): PrivateStateEffectRecorder {
    const at = () => (authority.input.clock?.() ?? authority.input.now).toISOString();
    return {
      before: async (effect) => {
        if (effect.action === 'release') await authority.assertRelease();
        else await authority.assertCurrent();
        must(effect.backendId === config.backend.backend.id && effect.method === 'PUT' &&
          ['acquire', 'renew', 'release', 'write'].includes(effect.action), 'backend-effect-scope');
        if (effect.action === 'write') {
          must((config.mode === 'apply' || config.mode === 'recover' && config.recovery === 'publish-retained') &&
            this.current.publication === 'intent' && this.current.publicationCorrelationId === effect.operationId &&
            this.current.processSettled && this.current.candidate && this.current.originalSnapshot &&
            effect.expectedEtag === this.current.originalSnapshot.etag, 'unapproved-state-publication');
        }
        const key = randomUUID();
        await this.event('backend-intent', at(), {
          key, effect, governancePlanDigest: authority.input.plan.planDigest,
          approvalEnvelopeHash: authority.input.plan.approval.envelopeHash,
          operationDigest: canonicalSha256(authority.operation)
        });
        return key;
      },
      returned: async (key, response) => {
        const prepared = this.current.events.find((event) => event.kind === 'backend-intent' && event.details.key === key);
        must(prepared && isRecord(prepared.details.effect) && prepared.details.effect.operationId !== response.requestId &&
          /^[a-f0-9-]{36}$/iu.test(response.requestId) && response.requestId !== '00000000-0000-0000-0000-000000000000',
        'backend-response-identity');
        await this.event('backend-returned', at(), { key, ...response });
      },
      uncertain: async (key) => {
        must(this.current.events.some((event) => event.kind === 'backend-intent' && event.details.key === key), 'backend-response-intent');
        await this.event('backend-uncertain', at(), { key });
      }
    };
  }
}
