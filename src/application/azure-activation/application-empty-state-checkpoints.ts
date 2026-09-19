import { lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { protectedStateScope } from '../../adapters/state/protected-workspace.js';
import type { PrivateStateEffectRecorder, PrivateStateEffect } from '../../adapters/azure/private-state-path.js';
import type {
  AzureBlobStateBinding, ProtectedStateWorkspace, StateArtifactDescriptor, StateExecutionContext
} from '../../domain/repair/stateful.js';
import { stateDigest } from '../../domain/repair/stateful-invariants.js';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import type { SavedTransitionPlan, TransitionOperation } from '../../domain/governance/activation/types.js';
import {
  ApplicationPrivateError, applicationPrivateAssert as must, type ApplicationPrivateDirectory
} from './application-private-contracts.js';
import { applicationPrivateObject } from './application-private-inputs.js';

export const applicationEmptyStateProtocol = 'opentofu-empty-application-state/2' as const;

export interface EmptyStateSlot {
  schemaVersion: 1;
  protocol: typeof applicationEmptyStateProtocol;
  projectRoot: string;
  projectIdentity: { device: string; inode: string; birthtime: string };
  sequence: number;
  backendKey: string;
  transactionId: string;
  journalRef: string;
  workspaceRef: string;
  phaseId: string;
  approvalEnvelopeHash: string;
  preparedAt: string;
}

export interface EmptyStateJournalEvent {
  sequence: number;
  kind: 'pre-effect' | 'native-started' | 'native-settled' | 'candidate-preserved' |
    'backend-intent' | 'backend-returned' | 'backend-uncertain' | 'state-readback' | 'finished' | 'blocked';
  at: string;
  details: Readonly<Record<string, unknown>>;
}

export interface EmptyStateJournal {
  schemaVersion: 1;
  protocol: typeof applicationEmptyStateProtocol;
  transactionId: string;
  phaseId: string;
  context: StateExecutionContext;
  backendKey: string;
  operationId: string;
  originalApprovalEnvelopeHash: string;
  recoveryApprovalEnvelopeHash: string | null;
  governancePlan: SavedTransitionPlan;
  operationDigest: string;
  native: { directory: ApplicationPrivateDirectory | null; settled: boolean };
  candidateRef: string | null;
  candidateDigest: string | null;
  candidateLineage: string | null;
  candidateSerial: number | null;
  putState: 'none' | 'intent' | 'returned' | 'uncertain' | 'verified';
  putRequestId: string | null;
  readback: {
    etag: string;
    version: string;
    size: number;
    observedAt: number;
    readbackRequestId: string | null;
  } | null;
  final: null | 'completed' | 'blocked';
  events: readonly EmptyStateJournalEvent[];
}

export async function emptyStateProjectIdentity(root: string) {
  const info = await lstat(root);
  must(info.isDirectory() && !info.isSymbolicLink() && await realpath(root) === root, 'checkpoint-project');
  return { device: String(info.dev), inode: String(info.ino), birthtime: String(info.birthtimeMs) };
}

export function emptyStateBackendKey(
  backend: Pick<AzureBlobStateBinding, 'tenantId' | 'subscriptionId' | 'account' | 'container' | 'key'>
): string {
  return backendKeyForProtocol(backend, applicationEmptyStateProtocol);
}

function backendKeyForProtocol(
  backend: Pick<AzureBlobStateBinding, 'tenantId' | 'subscriptionId' | 'account' | 'container' | 'key'>,
  protocol: string
): string {
  return canonicalSha256({
    protocol,
    tenantId: backend.tenantId.toLowerCase(),
    subscriptionId: backend.subscriptionId.toLowerCase(),
    account: backend.account.toLowerCase(),
    container: backend.container.toLowerCase(),
    key: backend.key
  });
}

function emptyStateJson(bytes: Uint8Array): Record<string, unknown> {
  must(bytes.byteLength > 0 && bytes.byteLength <= 32 * 1024 * 1024, 'private-json-bound');
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { must(false, 'private-json-format'); }
  must(isRecord(value), 'private-json-format');
  return value;
}

function assertEmptyStateJournal(
  value: unknown, context: StateExecutionContext, transactionId: string
): asserts value is EmptyStateJournal {
  must(isRecord(value) && value.schemaVersion === 1 && value.protocol === applicationEmptyStateProtocol &&
    value.transactionId === transactionId && canonicalSha256(value.context) === canonicalSha256(context) &&
    typeof value.backendKey === 'string' && /^[a-f0-9]{64}$/u.test(value.backendKey) &&
    typeof value.operationId === 'string' && /^[a-f0-9-]{36}$/u.test(value.operationId) &&
    isRecord(value.native) && (value.native.directory === null || isRecord(value.native.directory)) &&
    typeof value.native.settled === 'boolean' &&
    Array.isArray(value.events) && value.events.length <= 2048 &&
    ['none', 'intent', 'returned', 'uncertain', 'verified'].includes(String(value.putState)),
  'original-empty-state-journal-binding');
  must(value.candidateRef === null
    ? value.candidateDigest === null && value.candidateLineage === null && value.candidateSerial === null && value.putState === 'none'
    : typeof value.candidateRef === 'string' && typeof value.candidateDigest === 'string' &&
      /^[a-f0-9]{64}$/u.test(value.candidateDigest) && typeof value.candidateLineage === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value.candidateLineage) &&
      value.candidateSerial === 1 && value.native.settled === true && value.native.directory !== null,
  'original-native-candidate-binding');
  must(value.events.every((event, index) => isRecord(event) && event.sequence === index &&
    typeof event.kind === 'string' && typeof event.at === 'string' && isRecord(event.details)),
  'empty-state-journal-sequence');
}

export interface EmptyStateAuthority {
  input: PhaseAdapterExecutionInput;
  operation: TransitionOperation;
  assertCurrent(): Promise<void>;
}

export class ApplicationEmptyStateCheckpointStore {
  readonly #store;
  readonly #backendKey: string;

  constructor(private readonly options: {
    authority: EmptyStateAuthority;
    workspace: ProtectedStateWorkspace;
    context: StateExecutionContext;
    backend: AzureBlobStateBinding;
  }) {
    this.#backendKey = emptyStateBackendKey(options.backend);
    this.#store = createScopedUserLocalRecordStore(
      options.context.projectRoot, 'governance-operation', azurePorts(options.authority.input).storage
    );
  }

  get backendKey(): string {
    return this.#backendKey;
  }

  private key(sequence: number, kind: string): string {
    return canonicalSha256({ protocol: applicationEmptyStateProtocol, backend: this.#backendKey, sequence, kind });
  }

  async entries(): Promise<readonly { slot: EmptyStateSlot; closed: boolean }[]> {
    const legacyProtocol = 'opentofu-empty-application-state/1';
    const legacy = await this.#store.read(canonicalSha256({
      protocol: legacyProtocol, backend: backendKeyForProtocol(this.options.backend, legacyProtocol),
      sequence: 0, kind: 'started'
    }));
    must(!legacy, 'legacy-empty-initialization-requires-review');
    const identity = await emptyStateProjectIdentity(this.options.context.projectRoot);
    let selected: EmptyStateSlot | null = null;
    let closed = false;
    const entries: { slot: EmptyStateSlot; closed: boolean }[] = [];
    for (let index = 0; index < 32; index++) {
      const started = await this.#store.read(this.key(index, 'started'));
      const final = await this.#store.read(this.key(index, 'closed'));
      if (!started) {
        must(!final, 'checkpoint-index-incomplete');
        return entries;
      }
      must(!selected || closed, 'checkpoint-open-predecessor');
      const value = applicationPrivateObject(started.value, [
        'schemaVersion', 'protocol', 'projectRoot', 'projectIdentity',
        'sequence', 'backendKey', 'transactionId', 'journalRef', 'workspaceRef', 'phaseId',
        'approvalEnvelopeHash', 'preparedAt'
      ]);
      must(value.schemaVersion === 1 && value.protocol === applicationEmptyStateProtocol &&
        value.projectRoot === this.options.context.projectRoot && started.projectRoot === this.options.context.projectRoot &&
        canonicalSha256(value.projectIdentity) === canonicalSha256(identity) &&
        value.sequence === index && value.backendKey === this.#backendKey &&
        typeof value.transactionId === 'string' && /^[a-f0-9-]{36}$/u.test(value.transactionId) &&
        typeof value.journalRef === 'string' && typeof value.workspaceRef === 'string' &&
        typeof value.approvalEnvelopeHash === 'string' && /^[a-f0-9]{64}$/u.test(value.approvalEnvelopeHash),
      'checkpoint-index-binding');
      selected = value as unknown as EmptyStateSlot;
      closed = final !== null;
      if (final) {
        const closure = applicationPrivateObject(final.value, [
          'schemaVersion', 'protocol', 'slotDigest', 'disposition', 'closedAt'
        ]);
        must(closure.schemaVersion === 1 && closure.protocol === applicationEmptyStateProtocol &&
          closure.slotDigest === canonicalSha256(selected) &&
          ['completed', 'blocked'].includes(String(closure.disposition)),
        'checkpoint-closure');
      }
      entries.push({ slot: selected, closed });
      if (!closed) return entries;
    }
    must(false, 'retained-transaction-bound');
  }

  async find(): Promise<{
    slot: EmptyStateSlot | null;
    closed: boolean;
    next: number;
    entries: readonly { slot: EmptyStateSlot; closed: boolean }[];
  }> {
    const entries = await this.entries();
    return {
      slot: entries.at(-1)?.slot ?? null,
      closed: entries.at(-1)?.closed ?? false,
      next: entries.length,
      entries
    };
  }

  async create(params: {
    sequence: number;
    operationId: string;
  }): Promise<{ slot: EmptyStateSlot; journal: ApplicationEmptyStateJournalHandle }> {
    await this.options.authority.assertCurrent();
    const { context, workspace, authority } = this.options;
    const transactionId = randomUUID();
    const journalValue: EmptyStateJournal = {
      schemaVersion: 1,
      protocol: applicationEmptyStateProtocol,
      transactionId,
      phaseId: authority.input.phase.id,
      context,
      backendKey: this.#backendKey,
      operationId: params.operationId,
      originalApprovalEnvelopeHash: authority.input.plan.approval.envelopeHash!,
      recoveryApprovalEnvelopeHash: null,
      governancePlan: structuredClone(authority.input.plan),
      operationDigest: canonicalSha256(authority.operation),
      native: { directory: null, settled: false },
      candidateRef: null,
      candidateDigest: null,
      candidateLineage: null,
      candidateSerial: null,
      putState: 'none',
      putRequestId: null,
      readback: null,
      final: null,
      events: [{
        sequence: 0,
        kind: 'pre-effect',
        at: (authority.input.clock?.() ?? authority.input.now).toISOString(),
        details: {
          operationId: params.operationId,
          governancePlanDigest: authority.input.plan.planDigest,
          approvalEnvelopeHash: authority.input.plan.approval.envelopeHash
        }
      }]
    };
    const journalBytes = Buffer.from(canonicalJson(journalValue));
    let descriptor: StateArtifactDescriptor;
    try {
      descriptor = await workspace.put('journal', protectedStateScope(context), journalBytes);
    } finally {
      journalBytes.fill(0);
    }
    const slot: EmptyStateSlot = {
      schemaVersion: 1,
      protocol: applicationEmptyStateProtocol,
      projectRoot: context.projectRoot,
      projectIdentity: await emptyStateProjectIdentity(context.projectRoot),
      sequence: params.sequence,
      backendKey: this.#backendKey,
      transactionId,
      journalRef: descriptor.ref,
      workspaceRef: workspace.workspaceRef,
      phaseId: journalValue.phaseId,
      approvalEnvelopeHash: journalValue.originalApprovalEnvelopeHash,
      preparedAt: (authority.input.clock?.() ?? authority.input.now).toISOString()
    };
    await this.#store.write(this.key(params.sequence, 'started'), slot);
    if (authority.input.lease) {
      await authority.input.lease.assertHeld();
    }
    return {
      slot,
      journal: new ApplicationEmptyStateJournalHandle(workspace, context, descriptor.ref, journalValue)
    };
  }

  async open(slot: EmptyStateSlot): Promise<ApplicationEmptyStateJournalHandle> {
    must(slot.workspaceRef === this.options.workspace.workspaceRef &&
      slot.phaseId === this.options.authority.input.phase.id, 'original-workspace-or-phase-required');
    const bytes = await this.options.workspace.get(
      slot.journalRef, 'journal', protectedStateScope(this.options.context)
    );
    try {
      const value = emptyStateJson(bytes);
      assertEmptyStateJournal(value, this.options.context, slot.transactionId);
      return new ApplicationEmptyStateJournalHandle(this.options.workspace, this.options.context, slot.journalRef, value);
    } finally {
      bytes.fill(0);
    }
  }

  async close(slot: EmptyStateSlot, disposition: 'completed' | 'blocked'): Promise<void> {
    await this.options.authority.assertCurrent();
    await this.#store.write(this.key(slot.sequence, 'closed'), {
      schemaVersion: 1,
      protocol: applicationEmptyStateProtocol,
      slotDigest: canonicalSha256(slot),
      disposition,
      closedAt: (this.options.authority.input.clock?.() ?? this.options.authority.input.now).toISOString()
    });
  }
}

export class ApplicationEmptyStateJournalHandle {
  #tail: Promise<void> = Promise.resolve();

  constructor(
    readonly workspace: ProtectedStateWorkspace,
    readonly context: StateExecutionContext,
    readonly ref: string,
    private current: EmptyStateJournal
  ) {}

  get value(): EmptyStateJournal {
    return structuredClone(this.current);
  }

  get scope(): string {
    return protectedStateScope(this.context);
  }

  get transactionId(): string {
    return this.current.transactionId;
  }

  async change(action: (value: EmptyStateJournal) => void): Promise<void> {
    const next = this.#tail.then(async () => {
      const descriptor = await this.workspace.describe(this.ref, 'journal', this.scope);
      must(descriptor, 'original-journal-missing');
      const bytes = await this.workspace.get(this.ref, 'journal', this.scope);
      let value: EmptyStateJournal;
      try {
        must(stateDigest(bytes) === descriptor.digest, 'private-journal-concurrent-change');
        const parsed = emptyStateJson(bytes);
        assertEmptyStateJournal(parsed, this.context, this.current.transactionId);
        value = parsed;
      } finally {
        bytes.fill(0);
      }
      action(value);
      assertEmptyStateJournal(value, this.context, this.current.transactionId);
      const updated = Buffer.from(canonicalJson(value));
      try {
        await this.workspace.replace(this.ref, 'journal', this.scope, descriptor.digest, updated);
      } finally {
        updated.fill(0);
      }
      this.current = structuredClone(value);
    });
    this.#tail = next.catch(() => undefined);
    await next;
  }

  async event(
    kind: EmptyStateJournalEvent['kind'],
    at: string,
    details: Readonly<Record<string, unknown>>,
    change?: (value: EmptyStateJournal) => void
  ): Promise<void> {
    await this.change((value) => {
      must(value.events.length < 2048, 'private-event-bound');
      value.events = [
        ...value.events,
        { sequence: value.events.length, kind, at, details: structuredClone(details) }
      ];
      change?.(value);
    });
  }

  backendRecorder(
    authority: EmptyStateAuthority,
    backendId: string
  ): PrivateStateEffectRecorder {
    const at = () => (authority.input.clock?.() ?? authority.input.now).toISOString();
    return {
      before: async (effect: PrivateStateEffect) => {
        await authority.assertCurrent();
        must(effect.backendId === backendId && effect.method === 'PUT' && effect.action === 'write' &&
          effect.operationId === this.current.operationId && this.current.putState === 'none' &&
          this.current.native.settled && this.current.candidateRef !== null &&
          authority.operation.inputs.statePublication === 'initial-empty-state-conditional-create', 'backend-effect-scope');
        const key = randomUUID();
        await this.event('backend-intent', at(), {
          key,
          effect,
          governancePlanDigest: authority.input.plan.planDigest,
          approvalEnvelopeHash: authority.input.plan.approval.envelopeHash,
          operationDigest: canonicalSha256(authority.operation)
        }, (root) => {
          if (effect.action === 'write') {
            root.putState = 'intent';
          }
        });
        return key;
      },
      returned: async (key: string, response: {
        requestId: string;
        status: number;
        etag: string | null;
        versionId: string | null;
      }) => {
        const prepared = this.current.events.find(
          (event) => event.kind === 'backend-intent' && event.details.key === key
        );
        must(prepared && isRecord(prepared.details.effect) &&
          prepared.details.effect.operationId !== response.requestId &&
          /^[a-f0-9-]{36}$/iu.test(response.requestId) &&
          response.requestId !== '00000000-0000-0000-0000-000000000000',
        'backend-response-identity');
        await this.event('backend-returned', at(), { key, ...response }, (root) => {
          if (isRecord(prepared.details.effect) && prepared.details.effect.action === 'write') {
            root.putState = 'returned';
            root.putRequestId = response.requestId;
          }
        });
      },
      uncertain: async (key: string) => {
        const prepared = this.current.events.find(
          (event) => event.kind === 'backend-intent' && event.details.key === key
        );
        must(prepared, 'backend-response-intent');
        await this.event('backend-uncertain', at(), { key }, (root) => {
          if (isRecord(prepared.details.effect) && prepared.details.effect.action === 'write') {
            root.putState = 'uncertain';
          }
        });
      }
    };
  }
}
