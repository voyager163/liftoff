import { randomUUID } from 'node:crypto';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { stateDigest } from '../../domain/repair/stateful-invariants.js';
import type {
  StateArtifactDescriptor, StateExecutionContext
} from '../../domain/repair/stateful.js';
import { StateMigrationError } from '../../domain/repair/stateful.js';
import { currentProjectMutationLease } from '../../adapters/filesystem/project-lock.js';
import { protectedStateScope } from '../../adapters/state/protected-workspace.js';
import { azureStateUrl, AzureBlobStateBackend } from '../../adapters/state/azure-blob.js';
import { AzureArmError } from '../../adapters/azure/activation-rest.js';
import {
  createApplicationPrivateRuntime, type ApplicationPrivateAdapters
} from '../../adapters/azure/application-private-runtime.js';
import { readbackProof } from '../../governance-activation/transition-records.js';
import type {
  PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput
} from '../../governance-activation/transition-ports.js';
import type { PhaseOutputBindings, TransitionOperation } from '../../domain/governance/activation/types.js';
import { assertAzurePhaseAuthority, AzureActivationAdmissionError } from './authority.js';
import {
  ApplicationPrivateError, applicationPrivateAssert as must,
  type ApplicationPrivateConfiguration, type ApplicationPrivateIntent,
  type ApplicationPrivateRuntime, type ApplicationPrivateSource
} from './application-private-contracts.js';
import {
  applicationPrivateContext, applicationPrivateInputs, applicationPrivateIntent,
  applicationPrivateIntentDigest, applicationPrivateReadResourceIds,
  applicationPrivateWindow, assertApplicationPrivateArtifact
} from './application-private-inputs.js';
import { inspectApplicationPrivateSource, verifyApplicationPrivateSource } from './application-private-source.js';
import { applicationPrivateState } from './application-private-plan.js';
import {
  applicationEmptyStateProtocol, ApplicationEmptyStateCheckpointStore,
  type ApplicationEmptyStateJournalHandle, type EmptyStateAuthority, type EmptyStateSlot
} from './application-empty-state-checkpoints.js';
import { validatePrivateCustody } from './private-custody.js';
import { qualificationObject, qualificationTimestamp } from './qualification-authority.js';
import { verifyApplicationRehearsalOriginalApproval } from './application-rehearsal-receipt.js';
import {
  applicationEmptyNativeRecipe, createCandidateEmptyState, readCandidateEmptyState
} from '../../adapters/azure/application-empty-state-native.js';
export {
  createCandidateEmptyState, readCandidateEmptyState, type CandidateEmptyState
} from '../../adapters/azure/application-empty-state-native.js';

export {
  applicationEmptyStateProtocol, ApplicationEmptyStateCheckpointStore,
  type ApplicationEmptyStateJournalHandle, type EmptyStateAuthority, type EmptyStateSlot
} from './application-empty-state-checkpoints.js';

export interface ApplicationEmptyStateConfiguration extends ApplicationPrivateIntent {
  mode: 'initialize';
}

function initializationRequest(input: Pick<PhasePlanningInput, 'inspection' | 'phase'>) {
  must(['application-prerequisites-ready', 'application-foundation'].includes(input.phase.id), 'empty-initialization-phase');
  const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  const phase = qualificationObject(configuration?.phases[input.phase.id], ['privateExecution', 'initialization'], 'Empty application state');
  const value = qualificationObject(phase.initialization, ['mode', 'checkpoint', 'readbackWindow'], 'Empty state initialization request');
  must(value.mode === 'create' || value.mode === 'readback', 'empty-initialization-mode');
  if (value.mode === 'create') {
    must(value.checkpoint === null && value.readbackWindow === null, 'empty-initialization-create');
    return { mode: 'create' as const, checkpoint: null, readbackWindow: null };
  }
  const checkpoint = qualificationObject(value.checkpoint, ['transactionId', 'journalRef'], 'Original empty-state checkpoint');
  must(typeof checkpoint.transactionId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(checkpoint.transactionId) &&
    typeof checkpoint.journalRef === 'string' && /^state-workspace:[a-f0-9-]{36}\/[a-f0-9-]{36}$/u.test(checkpoint.journalRef),
  'original-empty-state-checkpoint');
  const window = qualificationObject(value.readbackWindow, ['notBefore', 'expiresAt'], 'Readback-only initialization window');
  const notBefore = qualificationTimestamp(window.notBefore, 'Readback start'), expiresAt = qualificationTimestamp(window.expiresAt, 'Readback expiry');
  must(Date.parse(expiresAt) > Date.parse(notBefore) && Date.parse(expiresAt) - Date.parse(notBefore) <= 3600000, 'empty-readback-window');
  return { mode: 'readback' as const, checkpoint: { transactionId: checkpoint.transactionId, journalRef: checkpoint.journalRef },
    readbackWindow: { notBefore, expiresAt } };
}

export function isApplicationEmptyStateOperation(operation: TransitionOperation): boolean {
  return operation.actionId === 'azure.application-private.initialize';
}

export function applicationEmptyStateOperation(
  input: PhasePlanningInput | PhaseAdapterExecutionInput,
  config: ApplicationPrivateConfiguration | ApplicationEmptyStateConfiguration,
  source: ApplicationPrivateSource
): TransitionOperation {
  const destination = {
    type: 'subscription' as const,
    identity: azureStateUrl(config.backend.backend, 'blob'),
    subscriptionId: config.binding.subscriptionId
  };
  const reads = applicationPrivateReadResourceIds(config);
  const request = initializationRequest(input);
  return {
    phaseId: input.phase.id,
    adapter: 'azure-opentofu',
    actionId: 'azure.application-private.initialize',
    mutationClass: request.mode === 'create' ? 'backend-state-write' : 'backend-state-read',
    remote: true,
    destructive: false,
    destination,
    inputs: {
      applicationPrivate: {
        ...config,
        mode: 'initialize'
      },
      resourceSourceDigest: source.digest,
      protocol: applicationEmptyStateProtocol,
      initialization: request,
      nativeExecution: request.mode === 'create' ? applicationEmptyNativeRecipe : 'none',
      backendProtocol: 'absent-empty-conditional-create-cas',
      stateLeaseActions: [],
      statePublication: request.mode === 'create' ? 'initial-empty-state-conditional-create' : 'forbidden',
      resourceMutation: 'forbidden',
      lockingCapability: 'conditional-create-cas',
      acquiredExclusiveLease: false,
      intentDigest: applicationPrivateIntentDigest(input, config as ApplicationPrivateConfiguration)
    },
    effects: [
      ...(request.mode === 'create' ? [{ mutationClass: 'backend-state-read' as const, destination, remote: true, destructive: false }] : []),
      {
        mutationClass: 'write-local-state',
        destination: { type: 'external', identity: `state-workspace:${config.custody.workspaceId}` },
        remote: false,
        destructive: false
      },
      ...reads.map((identity) => ({
        mutationClass: 'azure-read' as const,
        destination: { ...destination, identity },
        remote: true,
        destructive: false
      }))
    ]
  };
}

function safeCode(error: unknown): string {
  return error instanceof ApplicationPrivateError ? error.code :
    error instanceof StateMigrationError ? error.code :
      error instanceof AzureArmError ? 'azure-observation-failed' : 'private-execution-incomplete';
}

function safeMessage(error: unknown): string {
  return new ApplicationPrivateError(safeCode(error)).message;
}

export type ApplicationEmptyStateOptions = ApplicationPrivateAdapters;

function resolveIntentAndSource(
  input: PhasePlanningInput | PhaseAdapterExecutionInput
): { config: ApplicationPrivateConfiguration; sourcePromise: () => Promise<ApplicationPrivateSource> } {
  const activationConfig = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  initializationRequest(input);
  const rawPhase = activationConfig?.phases?.[input.phase.id];
  const rawExecution = rawPhase && isRecord(rawPhase) ? (rawPhase.privateExecution as Record<string, unknown> | undefined) : undefined;
  if (rawExecution && rawExecution.mode === 'initialize') {
    const synthetic = structuredClone(rawExecution);
    synthetic.mode = 'prepare';
    const modifiedInput = {
      ...input,
      inspection: {
        ...input.inspection,
        activationInputs: {
          ...activationConfig!,
          phases: {
            ...activationConfig!.phases,
            [input.phase.id]: {
              privateExecution: synthetic
            }
          }
        }
      }
    };
    const config = applicationPrivateInputs(modifiedInput);
    const sourcePromise = () => inspectApplicationPrivateSource(input.inspection.projectRoot, input.inspection.manifest, config);
    return { config, sourcePromise };
  }
  must(false, 'explicit-empty-initialization-required');
}

export async function planApplicationEmptyState(
  input: PhasePlanningInput,
  options: ApplicationEmptyStateOptions = {}
): Promise<PhasePlanBuild> {
  try {
    const { config, sourcePromise } = resolveIntentAndSource(input);
    const source = await sourcePromise();
    if (config.scope === 'foundation' || config.scope === 'staging') {
      assertApplicationPrivateArtifact(input, config.artifact);
    }
    const window = initializationRequest(input).readbackWindow ?? applicationPrivateWindow(config);
    must(Date.parse(window.expiresAt) > input.now.getTime(), 'execution-window-expired');
    const op = applicationEmptyStateOperation(input, config, source);
    return { operations: [op] };
  } catch (error) {
    return { operations: [], blockers: [safeMessage(error)] };
  }
}

async function assertEmptyStatePhaseAuthority(
  input: PhaseAdapterExecutionInput,
  operation: TransitionOperation
): Promise<void> {
  await assertAzurePhaseAuthority(input, operation);
}

function emptyStateAuthorityFor(
  input: PhaseAdapterExecutionInput,
  config: ApplicationPrivateConfiguration,
  source: ApplicationPrivateSource,
): EmptyStateAuthority {
  const operation = applicationEmptyStateOperation(input, config, source);
  const configurationDigest = canonicalSha256(config);
  const planDigest = canonicalSha256(input.plan);
  const requestDigest = canonicalSha256(initializationRequest(input));
  const check = async () => {
    must(canonicalSha256(input.plan) === planDigest &&
      canonicalSha256(resolveIntentAndSource(input).config) === configurationDigest &&
      canonicalSha256(initializationRequest(input)) === requestDigest &&
      canonicalSha256(input.plan.operations.filter((entry) => entry.remote)) === canonicalSha256([operation]),
    'approved-input-changed');
    const held = await currentProjectMutationLease(input.inspection.projectRoot);
    must(held, 'real-project-mutation-lease-required');
    await held.assertHeld();
    await assertEmptyStatePhaseAuthority(input, operation);
    const now = (input.clock?.() ?? input.now).getTime();
    const request = initializationRequest(input);
    must(Boolean(input.recovery) === (request.mode === 'readback') && Boolean(input.plan.recovery) === (request.mode === 'readback'),
      'explicit-empty-state-recovery');
    const window = request.readbackWindow ?? applicationPrivateWindow(config);
    must(now >= Date.parse(window.notBefore) && now < Date.parse(window.expiresAt), 'execution-window-expired');
    await verifyApplicationPrivateSource(input.inspection.projectRoot, source);
    if (config.scope === 'foundation' || config.scope === 'staging') {
      assertApplicationPrivateArtifact(input, config.artifact);
    }
  };
  return { input, operation, assertCurrent: check };
}

function buildEmptyStateOutcome(params: {
  input: PhaseAdapterExecutionInput;
  config: ApplicationPrivateConfiguration;
  operation: TransitionOperation;
  transactionId: string;
  journalRef: string;
  etag: string;
  version: string;
  size: number;
  observedAt: number;
  readbackRequestId: string | null;
  providerRequestIds: readonly string[];
}): PhaseAdapterOutcome {
  const { input, config, operation, transactionId, journalRef, etag, version, size, observedAt, readbackRequestId, providerRequestIds } = params;
  const blobUrl = azureStateUrl(config.backend.backend, 'blob');
  const values: Record<string, string | number | boolean | null> = {
    'application.emptyState.status': 'initialized',
    'application.emptyState.transactionId': transactionId,
    'application.emptyState.journalRef': journalRef,
    'backend.id': config.backend.backend.id,
    'backend.emptyStateInitialized': true,
    'backend.exclusiveLeaseAcquired': false
  };
  const outputs: PhaseOutputBindings = {
    values,
    resources: [{ provider: 'azure', resourceType: 'empty-application-state', resourceId: blobUrl }]
  };
  const liveReadbackPayload = {
    kind: `${input.phase.id}.empty-state.v1`,
    protocol: applicationEmptyStateProtocol,
    transactionId,
    journalRef,
    backend: {
      id: config.backend.backend.id,
      exists: true,
      etag,
      version,
      size,
      observedAt
    },
    providerRequestIds,
    locking: {
      capability: 'conditional-create-cas',
      acquiredExclusiveLease: false
    },
    nextRequired: 'prepare'
  };
  return {
    status: 'review-required',
    blocker: 'Initial empty private state initialized with conditional-create CAS. Normal preparation and approval are required next; this state is not phase verified.',
    evidencePayload: liveReadbackPayload,
    outputs,
    liveReadback: [
      readbackProof(
        { ...input, clock: () => new Date(observedAt) },
        'azure',
        'empty-application-state',
        blobUrl,
        {
          ...(readbackRequestId ? { readbackRequestId } : {}),
          observedAt: new Date(observedAt).toISOString(),
          etag,
          version
        }
      )
    ],
    completedOperations: [operation],
    review: {
      schemaVersion: 1,
      kind: 'application-private-plan',
      phaseId: input.phase.id,
      sourcePlanDigest: input.plan.planDigest,
      payload: {
        nextMode: 'prepare',
        backendId: config.backend.backend.id,
        locator: {
          backendId: config.backend.backend.id,
          account: config.backend.backend.account,
          container: config.backend.backend.container,
          key: config.backend.backend.key
        },
        transactionId,
        journalRef
      }
    },
    cleanupWarnings: [
      `Retained initial empty state checkpoint ${journalRef}; next step requires separately approved normal prepare.`
    ]
  };
}

export async function executeApplicationEmptyState(
  supplied: PhaseAdapterExecutionInput,
  options: ApplicationEmptyStateOptions = {}
): Promise<PhaseAdapterOutcome> {
  const started = performance.now();
  const input: PhaseAdapterExecutionInput = {
    ...supplied,
    clock: supplied.clock ?? (() => new Date(supplied.now.getTime() + performance.now() - started))
  };
  let config: ApplicationPrivateConfiguration | undefined;
  let source: ApplicationPrivateSource | undefined;
  let operation: TransitionOperation | undefined;
  let slot: EmptyStateSlot | null = null;
  let journal: ApplicationEmptyStateJournalHandle | undefined;
  let candidateBytes: Uint8Array | undefined;
  try {
    const resolved = resolveIntentAndSource(input);
    config = resolved.config;
    source = await resolved.sourcePromise();
    operation = applicationEmptyStateOperation(input, config, source);
    const authority = emptyStateAuthorityFor(input, config, source);
    await authority.assertCurrent();

    validatePrivateCustody(config.custody);
    const context = applicationPrivateContext(input, config);

    const runtime: ApplicationPrivateRuntime = await createApplicationPrivateRuntime(
      input, applicationPrivateIntent(config), source, context,
      {
        input,
        operation,
        operations: [operation],
        assertCurrent: authority.assertCurrent,
        assertRelease: authority.assertCurrent
      },
      options
    );

    const store = new ApplicationEmptyStateCheckpointStore({
      authority,
      workspace: runtime.storage.workspace,
      context,
      backend: config.backend.backend
    });

    const previous = await store.find();
    slot = previous.slot;
    const isClosed = previous.closed;
    const request = initializationRequest(input);
    if (request.mode === 'readback') must(slot && request.checkpoint.transactionId === slot.transactionId &&
      request.checkpoint.journalRef === slot.journalRef, 'original-empty-state-checkpoint');

    if (slot && !isClosed) {
      must(request.mode === 'readback', 'explicit-empty-state-recovery');
      journal = await store.open(slot);
      await verifyApplicationRehearsalOriginalApproval(input, journal.value.governancePlan, slot.preparedAt);
      must(
        input.plan.approval.envelopeHash !== slot.approvalEnvelopeHash,
        'fresh-recovery-approval-required'
      );
      await journal.change((root) => {
        root.recoveryApprovalEnvelopeHash = input.plan.approval.envelopeHash ?? null;
      });
      must(journal.value.native.settled && journal.value.candidateRef, 'original-native-initialization-incomplete');

      const journalCandidate = await runtime.storage.workspace.get(
        journal.value.candidateRef!, 'candidate', protectedStateScope(context)
      );
      try {
        readCandidateEmptyState(journalCandidate);
        must(stateDigest(journalCandidate) === journal.value.candidateDigest, 'candidate-corrupted');
        const liveMetadata = await runtime.backend.metadata(context);
        if (!liveMetadata.exists) {
          await journal.event(
            'blocked',
            (input.clock?.() ?? input.now).toISOString(),
            { code: 'recovery-missing-final-output' }
          );
          return {
            status: 'blocked',
            blocker: 'Previous PUT outcome is missing from backend; recovery is read-only and no second PUT is permitted.',
            completedOperations: []
          };
        }
        must(
          liveMetadata.operationId === journal.value.operationId,
          'foreign-or-mismatched-state'
        );
        const liveBytes = await runtime.backend.readPrivate(liveMetadata, context);
        try {
          must(
            stateDigest(liveBytes) === journal.value.candidateDigest,
            'foreign-or-mismatched-state'
          );
          const parsed = applicationPrivateState(liveBytes, liveMetadata);
          must(parsed.snapshot.serial === journal.value.candidateSerial, 'empty-state-serial');
          must(parsed.snapshot.lineage === journal.value.candidateLineage, 'empty-state-lineage');
          must(parsed.resources.size === 0, 'empty-state-resources');
        } finally {
          liveBytes.fill(0);
        }

        const readbackAt = (input.clock?.() ?? input.now).getTime();
        await journal.change((root) => {
          root.putState = 'verified';
          root.final = 'completed';
          root.readback = {
            etag: liveMetadata.etag!,
            version: liveMetadata.version!,
            size: liveMetadata.size,
            observedAt: readbackAt,
            readbackRequestId: null
          };
        });
        await journal.event('state-readback', new Date(readbackAt).toISOString(), {
          backendId: liveMetadata.backendId,
          etag: liveMetadata.etag,
          version: liveMetadata.version
        });
        await journal.event('finished', (input.clock?.() ?? input.now).toISOString(), {
          disposition: 'completed'
        });
        await store.close(slot, 'completed');

        return buildEmptyStateOutcome({
          input,
          config,
          operation,
          transactionId: slot.transactionId,
          journalRef: slot.journalRef,
          etag: liveMetadata.etag!,
          version: liveMetadata.version!,
          size: liveMetadata.size,
          observedAt: readbackAt,
          readbackRequestId: null,
          providerRequestIds: journal.value.putRequestId ? [journal.value.putRequestId] : []
        });
      } finally {
        journalCandidate.fill(0);
      }
    }

    if (slot && isClosed) {
      journal = await store.open(slot);
      await verifyApplicationRehearsalOriginalApproval(input, journal.value.governancePlan, slot.preparedAt);
      must(journal.value.native.settled && journal.value.candidateRef, 'original-native-initialization-incomplete');
      const journalCandidate = await runtime.storage.workspace.get(
        journal.value.candidateRef!, 'candidate', protectedStateScope(context)
      );
      try {
        readCandidateEmptyState(journalCandidate);
        must(stateDigest(journalCandidate) === journal.value.candidateDigest, 'candidate-corrupted');
        const liveMetadata = await runtime.backend.metadata(context);
        must(liveMetadata.exists, 'empty-state-missing');
        must(liveMetadata.operationId === journal.value.operationId, 'foreign-operation-id');
        const liveBytes = await runtime.backend.readPrivate(liveMetadata, context);
        try {
          must(stateDigest(liveBytes) === journal.value.candidateDigest, 'foreign-state-digest');
          const parsed = applicationPrivateState(liveBytes, liveMetadata);
          must(parsed.snapshot.serial === journal.value.candidateSerial, 'empty-state-serial');
          must(parsed.snapshot.lineage === journal.value.candidateLineage, 'empty-state-lineage');
          must(parsed.resources.size === 0, 'empty-state-resources');
        } finally {
          liveBytes.fill(0);
        }
        return buildEmptyStateOutcome({
          input,
          config,
          operation,
          transactionId: slot.transactionId,
          journalRef: slot.journalRef,
          etag: liveMetadata.etag!,
          version: liveMetadata.version!,
          size: liveMetadata.size,
          observedAt: liveMetadata.observedAt,
          readbackRequestId: journal.value.readback?.readbackRequestId ?? null,
          providerRequestIds: journal.value.putRequestId ? [journal.value.putRequestId] : []
        });
      } finally {
        journalCandidate.fill(0);
      }
    }

    // Fresh execution path
    must(request.mode === 'create', 'original-empty-state-checkpoint');
    const initialMetadata = await runtime.backend.metadata(context);
    must(!initialMetadata.exists, 'backend-already-exists');

    const operationId = randomUUID();
    const created = await store.create({
      sequence: previous.next,
      operationId
    });
    slot = created.slot;
    journal = created.journal;
    const nativeJournal = journal;
    const directory = await runtime.createDirectory();
    await nativeJournal.change((root) => { root.native.directory = directory; });
    const candidate = await createCandidateEmptyState({
      directory, tools: config.custody.tools, maxCommandMs: config.maxCommandMs,
      assertDirectory: runtime.assertDirectory, authorize: authority.assertCurrent,
      started: () => nativeJournal.event('native-started', (input.clock?.() ?? input.now).toISOString(), {
        recipe: applicationEmptyNativeRecipe
      }),
      settled: () => nativeJournal.event('native-settled', (input.clock?.() ?? input.now).toISOString(), {}, (root) => {
        root.native.settled = true;
      })
    });
    candidateBytes = candidate.bytes;
    const candidateDescriptor = await runtime.storage.workspace.put(
      'candidate', protectedStateScope(context), candidate.bytes
    );
    await nativeJournal.event('candidate-preserved', (input.clock?.() ?? input.now).toISOString(), {}, (root) => {
      root.candidateRef = candidateDescriptor.ref;
      root.candidateDigest = candidate.digest;
      root.candidateLineage = candidate.lineage;
      root.candidateSerial = candidate.serial;
    });

    runtime.setBackendEffects(journal.backendRecorder(authority, config.backend.backend.id));

    must(runtime.backend instanceof AzureBlobStateBackend, 'empty-state-conditional-create-adapter-required');

    try {
      await runtime.backend.initializeEmptyPrivate({
        bytes: candidate.bytes,
        expected: initialMetadata,
        context,
        operationId
      });
    } finally {
      candidate.bytes.fill(0);
    }

    const postMetadata = await runtime.backend.metadata(context);
    must(postMetadata.exists, 'post-write-metadata-missing');
    must(postMetadata.operationId === operationId, 'post-write-operation-mismatch');

    const readbackBytes = await runtime.backend.readPrivate(postMetadata, context);
    try {
      must(stateDigest(readbackBytes) === candidate.digest, 'readback-digest-mismatch');
      const parsed = applicationPrivateState(readbackBytes, postMetadata);
      must(parsed.snapshot.serial === candidate.serial, 'empty-state-serial');
      must(parsed.snapshot.lineage === candidate.lineage, 'empty-state-lineage');
      must(parsed.resources.size === 0, 'empty-state-resources');
    } finally {
      readbackBytes.fill(0);
    }

    const readbackAt = (input.clock?.() ?? input.now).getTime();
    await journal.change((root) => {
      root.putState = 'verified';
      root.final = 'completed';
      root.readback = {
        etag: postMetadata.etag!,
        version: postMetadata.version!,
        size: postMetadata.size,
        observedAt: readbackAt,
        readbackRequestId: null
      };
    });
    await journal.event('state-readback', new Date(readbackAt).toISOString(), {
      backendId: postMetadata.backendId,
      etag: postMetadata.etag,
      version: postMetadata.version
    });
    await journal.event('finished', (input.clock?.() ?? input.now).toISOString(), {
      disposition: 'completed'
    });
    await store.close(slot, 'completed');

    return buildEmptyStateOutcome({
      input,
      config,
      operation,
      transactionId: slot.transactionId,
      journalRef: slot.journalRef,
      etag: postMetadata.etag!,
      version: postMetadata.version!,
      size: postMetadata.size,
      observedAt: readbackAt,
      readbackRequestId: null,
      providerRequestIds: journal.value.putRequestId ? [journal.value.putRequestId] : []
    });
  } catch (error) {
    const cleanupWarnings: string[] = [];
    if (journal) {
      try {
        await journal.event('blocked', (input.clock?.() ?? input.now).toISOString(), { code: safeCode(error) });
      } catch (journalError) {
        cleanupWarnings.push(`The failure checkpoint could not be persisted (${safeCode(journalError)}); retain the original private workspace and do not repeat initialization.`);
      }
    }
    return {
      status: 'blocked',
      blocker: safeMessage(error),
      completedOperations: [],
      ...(cleanupWarnings.length ? { cleanupWarnings } : {}),
      ...(slot ? {
        evidencePayload: {
          kind: `${input.phase.id}.empty-state.v1`,
          protocol: applicationEmptyStateProtocol,
          transactionId: slot.transactionId,
          journalRef: slot.journalRef,
          status: 'blocked',
          blocker: safeMessage(error),
          nativeSettled: journal?.value.native.settled ?? false,
          publication: journal?.value.putState ?? 'none'
        }
      } : {})
    };
  } finally {
    candidateBytes?.fill(0);
  }
}

export const applicationEmptyStateCoordinatorSeams = Object.freeze({
  actionId: 'azure.application-private.initialize' as const,
  mode: 'initialize' as const,
  protocol: applicationEmptyStateProtocol,
  plan: planApplicationEmptyState,
  execute: executeApplicationEmptyState,
  operation: applicationEmptyStateOperation,
  isOperation: isApplicationEmptyStateOperation,
  createCandidate: createCandidateEmptyState
});
