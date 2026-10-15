import { createWorkflowSource5ControlStore } from '../adapters/filesystem/update-previews.js';
import { resolveUpdatePreviewLocation } from '../adapters/filesystem/update-previews.js';
import { captureProjectFileSnapshot } from '../adapters/filesystem/project-transaction.js';
import type { UpdatePreviewOptions, WorkflowSource5StoredControl } from '../adapters/filesystem/update-previews.js';
import type { ProjectMutationLease } from '../adapters/filesystem/project-lock.js';
import { canonicalJson, canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import type { ModernApprovalEnvelope, ModernSavedTransitionPlan, ModernTransitionOperation } from '../domain/governance/activation/modern-record-contracts.js';
import { captureWorkflowBinding, workflowFailure, workflowByteDigest } from './workflow-binding.js';
import { source5WorkflowPlanInventory } from './workflow-source5-operations.js';
import {
  assertSource5WorkflowContext, assertSource5WorkflowLease, source5PreviewFingerprint,
  source5WorkflowOriginalPlanValue, source5WorkflowAuthorityValue
} from './workflow-source5-authority.js';
import type { Source5WorkflowContext } from './workflow-source5-authority.js';
import { validateSource5WorkflowCheckpointData } from './workflow-source5-checkpoints.js';
import { inspectModernInstalledActivation } from '../application/governance/modern-installed-preflight.js';
import { source5WorkflowOwnership } from './workflow-source5-ownership.js';
import { describeSource5WorkflowOwnership, readSource5WorkflowOwnershipHistory } from './workflow-source5-ownership-description.js';
import { measureSource5WorkflowStorageInventory } from './workflow-source5-storage-inventory.js';
import type { Source5WorkflowStorageBound } from './workflow-source5-storage-inventory.js';
import type { ModernRelatedRecords } from '../domain/governance/activation/modern-records.js';

export const source5WorkflowStages = Object.freeze([
  'publication-writing', 'publication-commit-intent', 'publication-commit-observed', 'publication-committed',
  'publication-push-intent', 'publication-push-accepted', 'publication-published',
  'execution-ref-intent', 'execution-ref-accepted', 'runner-intent', 'runner-accepted',
  'dispatch-intent', 'dispatch-accepted', 'dispatch-terminal', 'component-completed'
] as const);
export type Source5WorkflowStage = typeof source5WorkflowStages[number];
const instances = new WeakSet<Source5WorkflowJournal>();
const journalWriters = new WeakMap<object, { journal: Source5WorkflowJournal; initialize: () => Promise<void> }>();
const maximumStageDataBytes = 32 * 1024;
export interface Source5WorkflowJournal {
  readonly projectRoot: string;
  readonly plan: ModernSavedTransitionPlan;
  readonly approval: ModernApprovalEnvelope;
  readonly controlKey: string;
  readonly lease: ProjectMutationLease;
  readonly assertInventory: () => Promise<void>;
  readonly wasAttempted: (operation: ModernTransitionOperation) => boolean;
  readonly events: (operation: ModernTransitionOperation) => Promise<readonly Source5WorkflowEvent[]>;
  readonly record: (operation: ModernTransitionOperation, stage: Source5WorkflowStage,
    data: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly proofKey: (operation: ModernTransitionOperation) => string;
  readonly saveFinalization: (value: Readonly<Record<string, unknown>>) => Promise<string>;
  readonly readFinalization: () => Promise<WorkflowSource5StoredControl | null>;
  readonly markFinalized: (proofKey: string) => Promise<void>;
}
export interface Source5WorkflowEvent {
  readonly schemaVersion: 1;
  readonly kind: 'workflow-source5-event';
  readonly controlKey: string;
  readonly planDigest: string;
  readonly savedPlanDigest: string;
  readonly operationDigest: string;
  readonly bindingDigest: string;
  readonly stage: Source5WorkflowStage;
  readonly previousEventDigest: string | null;
  readonly recordedAt: string;
  readonly data: Readonly<Record<string, unknown>>;
}
export function assertSource5WorkflowJournal(journal: Source5WorkflowJournal): void {
  if (!instances.has(journal)) workflowFailure('workflow-source5-journal', 'Structural checkpoint sinks are not engine-owned sealed workflow journals.');
}
interface Source5WorkflowJournalInput {
  projectRoot: string; plan: ModernSavedTransitionPlan; approval: ModernApprovalEnvelope;
  context: Source5WorkflowContext; lease: ProjectMutationLease; now: Date; storage?: UpdatePreviewOptions; initialize: boolean;
}
async function describeSource5WorkflowJournal(input: Source5WorkflowJournalInput) {
  assertSource5WorkflowContext(input.context);
  await assertSource5WorkflowLease(input.lease, input.projectRoot);
  const recordedAt = input.now.toISOString();
  input.context.records.readPlan(input.plan, { approvals: [input.approval] });
  const plan = captureWorkflowBinding(input.plan), approval = captureWorkflowBinding(input.approval);
  const { control, effects } = source5WorkflowPlanInventory(plan);
  const store = createWorkflowSource5ControlStore(input.projectRoot, input.storage);
  const common = { schemaVersion: 1, projectRoot: input.projectRoot, controlKey: control.controlKey,
    identity: plan.identity, phaseId: plan.phaseId, graphHash: plan.graphHash,
    repositoryAnchor: control.repositoryAnchor, planDigest: plan.planDigest, savedPlanDigest: canonicalSha256(plan),
    previewFingerprint: source5PreviewFingerprint(input.projectRoot, plan) };
  const operationKey = (operation: ModernTransitionOperation) =>
    canonicalSha256({ controlKey: control.controlKey, operationDigest: canonicalSha256(operation) });
  const stageKey = (operation: ModernTransitionOperation, stage: Source5WorkflowStage) =>
    canonicalSha256({ kind: 'workflow-source5-stage-key.v1', operationKey: operationKey(operation), stage });
  const finalizationKey = canonicalSha256({ kind: 'workflow-source5-finalization-key.v1', controlKey: control.controlKey });
  const manifestKey = canonicalSha256({ kind: 'workflow-source5-storage-inventory-key.v1', controlKey: control.controlKey });
  const loadedManifest = await store.read('proof', manifestKey);
  const stages = (operation: ModernTransitionOperation): readonly Source5WorkflowStage[] =>
    operation.actionId.startsWith('git.workflow-source.publish-reviewed:') ? [...source5WorkflowStages.slice(0, 7), 'component-completed'] :
      operation.actionId.startsWith('github.workflow-source.bind-execution-ref:') ? ['execution-ref-intent', 'execution-ref-accepted', 'component-completed'] :
        operation.actionId.startsWith('github.workflow-source.admit-reviewed:') ? ['runner-intent', 'runner-accepted', 'component-completed'] :
          ['dispatch-intent', 'dispatch-accepted', 'dispatch-terminal', 'component-completed'];
  const finalPaths = [
    ...new Set([control.controlKey, ...(control.origin ? [control.origin.planKey] : [])])
  ].flatMap(key => [`governance/plans/${key}.json`, `governance/approvals/source5-${key}.json`]);
  finalPaths.push(`governance/evidence/source5-${control.controlKey}.json`, 'governance/activation-state.json');
  const original = source5WorkflowOriginalPlanValue(input.projectRoot, plan, approval);
  const originalStored = await store.read('plan', control.controlKey);
  const loadedIndex = await store.read('journal', control.controlKey);
  if (!originalStored || canonicalSha256(originalStored.value) !== canonicalSha256(original)) {
    return workflowFailure('workflow-source5-original',
      'Opening a journal requires the exact separately sealed original review; missing or changed history cannot be created or recreated by initialization.');
  }
  if (!input.initialize && !loadedIndex) {
    return workflowFailure('workflow-source5-journal',
      'Recorded workflow index is missing; observation cannot create a manifest, reservation or execution permission.');
  }
  const reservationKey = canonicalSha256({ kind: 'workflow-source5-reservation-key.v1', controlKey: control.controlKey });
  const recoveryReservation = { ...common, kind: 'workflow-source5-reservation',
    operationKeys: effects.map(operationKey), stageDataBytes: maximumStageDataBytes,
    finalizationBytes: 16 * 1024 * 1024, maximumRevision: source5WorkflowStages.length };
  await store.measure('plan', control.controlKey, original);
  const exactContents = new Map([
    [`governance/plans/${control.controlKey}.json`, canonicalJson(plan)],
    [`governance/approvals/source5-${control.controlKey}.json`, canonicalJson(approval)]
  ]);
  const readDependencies: { namespace: 'plan' | 'proof' | 'operation' | 'journal'; key: string;
    rawDigest: string; encodedBytes: number; revision: number }[] = [];
  let originalPublication: Readonly<Record<string, unknown>> | undefined;
  const retainedReviews = [{ plan, approval }];
  if (control.origin) {
    const source = await store.read('plan', control.origin.planKey);
    if (!source || !isRecord(source.value) || source.value.kind !== 'workflow-source5-original-plan' ||
      source.value.projectRoot !== input.projectRoot || source.value.controlKey !== control.origin.planKey) {
      return workflowFailure('workflow-source5-original', 'Finalization requires the independently loaded exact original publication plan, not a same-sized estimate.');
    }
    const originalApproval = input.context.records.readApproval(source.value.approval);
    const originalPlan = input.context.records.readPlan(source.value.plan, { approvals: [originalApproval] });
    retainedReviews.push({ plan: originalPlan, approval: originalApproval });
    if (canonicalSha256(originalPlan.identity) !== canonicalSha256(plan.identity) ||
      canonicalSha256(source.value) !== canonicalSha256(source5WorkflowOriginalPlanValue(input.projectRoot, originalPlan, originalApproval))) {
      return workflowFailure('workflow-source5-original', 'Original publication metadata differs from the current exact source5 family.');
    }
    const sourceInventory = source5WorkflowPlanInventory(originalPlan);
    const sourceOperation = sourceInventory.effects[0];
    const expectedSourcePhase = ['bootstrap-workflow-source-ready', 'workflow-source-ready'].includes(plan.phaseId)
      ? plan.phaseId : 'workflow-source-ready';
    if (sourceInventory.control.reviewKind !== 'publication' || originalPlan.phaseId !== expectedSourcePhase ||
      sourceInventory.control.projectKey !== control.projectKey || sourceInventory.control.repositoryAnchor !== control.repositoryAnchor ||
      !sourceOperation || !sourceOperation.actionId.startsWith('git.workflow-source.publish-reviewed:')) {
      return workflowFailure('workflow-source5-original', 'Original source must be the exact same-root/anchor/phase publication review, never another bound or future-source plan.');
    }
    const sourceEvents = await events(sourceOperation, originalPlan);
    const sourceProof = sourceEvents.find(event => event.stage === 'component-completed');
    const sourceProofKey = canonicalSha256({ kind: 'workflow-source5-stage-key.v1', operationKey:
      canonicalSha256({ controlKey: control.origin.planKey, operationDigest: canonicalSha256(sourceOperation) }), stage: 'component-completed' });
    if (!sourceProof || !isRecord(sourceProof.data.proof) || control.origin.proofKey !== sourceProofKey ||
      canonicalSha256(sourceProof.data.proof) !== control.origin.publicationDigest ||
      sourceProof.data.proof.commitSha !== control.origin.commitSha || sourceProof.data.proof.treeSha !== control.origin.treeSha) {
      return workflowFailure('workflow-source5-original', 'The original immutable component chain does not bind this reviewed publication digest/commit/tree.');
    }
    originalPublication = sourceProof.data.proof;
    const sourceManifestKey = canonicalSha256({ kind: 'workflow-source5-storage-inventory-key.v1', controlKey: control.origin.planKey });
    const sourceReservationKey = canonicalSha256({ kind: 'workflow-source5-reservation-key.v1', controlKey: control.origin.planKey });
    const sourceManifest = await store.read('proof', sourceManifestKey);
    const sourceIndex = await store.read('journal', control.origin.planKey);
    const sourceReservation = await store.read('proof', sourceReservationKey);
    if (!sourceManifest || !isRecord(sourceManifest.value) || sourceManifest.value.kind !== 'workflow-source5-storage-inventory' ||
      sourceManifest.value.controlKey !== control.origin.planKey || sourceManifest.value.projectRoot !== input.projectRoot ||
      sourceManifest.value.savedPlanDigest !== canonicalSha256(originalPlan) || !Array.isArray(sourceManifest.value.objects) ||
      !sourceIndex || !isRecord(sourceIndex.value) || sourceIndex.value.manifestKey !== sourceManifestKey ||
      sourceIndex.value.manifestDigest !== canonicalSha256(sourceManifest.value) ||
      sourceIndex.value.reservationKey !== sourceReservationKey || sourceIndex.value.status !== 'active' ||
      !sourceReservation || !isRecord(sourceReservation.value) || sourceReservation.value.kind !== 'workflow-source5-reservation' ||
      sourceReservation.value.controlKey !== control.origin.planKey || sourceReservation.value.savedPlanDigest !== canonicalSha256(originalPlan)) {
      return workflowFailure('workflow-source5-original', 'The original publication needs its intact committed complete manifest/index/recovery ledger, not merely a component annotation.');
    }
    for (const operation of effects) {
      if (operation.inputs.repository !== originalPublication.repository || operation.inputs.repositoryId !== originalPublication.repositoryId ||
        !operation.actionId.startsWith('github.workflow-source.admit-reviewed:') &&
        expectedSourcePhase === plan.phaseId && (operation.inputs.sourceSha !== control.origin.commitSha ||
          operation.inputs.treeSha !== control.origin.treeSha || operation.inputs.executionRef !== `liftoff-execution-${control.origin.commitSha}`)) {
        return workflowFailure('workflow-source5-original', 'An exact source-bound operation differs from its independently sealed publication repository/commit/tree.');
      }
    }
    const sourceKeys = [{ namespace: 'plan' as const, key: control.origin.planKey },
      { namespace: 'proof' as const, key: sourceManifestKey }, { namespace: 'proof' as const, key: sourceReservationKey },
      { namespace: 'journal' as const, key: control.origin.planKey },
      { namespace: 'operation' as const, key: canonicalSha256({ controlKey: control.origin.planKey, operationDigest: canonicalSha256(sourceOperation) }) },
      ...sourceEvents.map(event => ({ namespace: 'proof' as const, key: canonicalSha256({
        kind: 'workflow-source5-stage-key.v1', operationKey: canonicalSha256({
          controlKey: control.origin!.planKey, operationDigest: canonicalSha256(sourceOperation) }), stage: event.stage }) }))];
    for (const entry of sourceKeys) {
      const receipt = await store.read(entry.namespace, entry.key);
      if (!receipt) return workflowFailure('workflow-source5-original', 'Original publication read dependencies cannot be reconstructed from a caller assertion.');
      const bound = sourceManifest.value.objects.find(bound => isRecord(bound) && bound.namespace === entry.namespace && bound.key === entry.key);
      if (!isRecord(bound) || typeof bound.maximumEncodedBytes !== 'number' || typeof bound.maximumRevisions !== 'number' ||
        receipt.encodedBytes > bound.maximumEncodedBytes || receipt.revision > bound.maximumRevisions) {
        return workflowFailure('workflow-source5-original', 'The original actual sealed publication dependency exceeds its committed concrete byte/revision inventory.');
      }
      readDependencies.push({ ...entry, rawDigest: receipt.rawDigest, encodedBytes: receipt.encodedBytes, revision: receipt.revision });
    }
    exactContents.set(`governance/plans/${control.origin.planKey}.json`, canonicalJson(originalPlan));
    exactContents.set(`governance/approvals/source5-${control.origin.planKey}.json`, canonicalJson(originalApproval));
  }
  const storedReservation = await store.read('proof', reservationKey);
  if ((storedReservation || loadedManifest) && !loadedIndex ||
    loadedIndex && (!storedReservation || !loadedManifest)) {
    return workflowFailure('workflow-source5-journal', 'Partial or lost original control metadata cannot recreate execution permission; retain the unresolved original records.');
  }
  if (!loadedIndex) {
    for (const operation of effects) {
      if (await store.read('operation', operationKey(operation))) {
        return workflowFailure('workflow-source5-journal', 'An existing progress pointer cannot recreate its lost complete original control ledger.');
      }
      for (const stage of stages(operation)) {
        if (await store.read('proof', stageKey(operation, stage))) {
          return workflowFailure('workflow-source5-journal', 'Retained intent/provider truth cannot recreate missing reservation/manifest/index permission.');
        }
      }
    }
  }
  type ReservedFile = { path: string; beforeHash: string | null; maximumContentBytes: number; exactContent: string | null };
  let reservedFiles: ReservedFile[];
  let baseline: { state: ReturnType<Source5WorkflowContext['records']['readState']>; records: ModernRelatedRecords };
  if (storedReservation) {
    const raw = storedReservation.value;
    if (!isRecord(raw) || !Array.isArray(raw.files) || !isRecord(raw.baseline) || !isRecord(raw.baseline.records) ||
      Object.keys(raw.baseline.records).some(key => !['plans', 'approvals', 'evidence'].includes(key)) ||
      Object.values(raw.baseline.records).some(value => !Array.isArray(value))) {
      return workflowFailure('workflow-source5-reservation', 'Original finalization metadata and baseline inventory are malformed.');
    }
    const rawRecords = raw.baseline.records;
    function recordsArray(name: 'plans' | 'approvals' | 'evidence') {
      const value = rawRecords[name];
      if (value === undefined) return [];
      if (!Array.isArray(value)) return workflowFailure('workflow-source5-reservation', 'A retained baseline record collection is malformed.');
      return value;
    }
    const records: ModernRelatedRecords = { plans: recordsArray('plans'), approvals: recordsArray('approvals'),
      evidence: recordsArray('evidence') };
    const state = input.context.records.readState(raw.baseline.state, records);
    if (canonicalSha256(state) !== plan.stateHash) {
      return workflowFailure('workflow-source5-reservation', 'The retained original baseline is not the reviewed modern state.');
    }
    baseline = { state, records };
    reservedFiles = raw.files.map(file => {
      if (!isRecord(file) || typeof file.path !== 'string' || !finalPaths.includes(file.path) ||
        !(file.beforeHash === null || typeof file.beforeHash === 'string' && /^[a-f0-9]{64}$/u.test(file.beforeHash)) ||
        typeof file.maximumContentBytes !== 'number' || !Number.isSafeInteger(file.maximumContentBytes) ||
        file.maximumContentBytes < 1 || file.maximumContentBytes > 8 * 1024 * 1024 ||
        !(file.exactContent === null || typeof file.exactContent === 'string') ||
        file.exactContent !== (exactContents.get(file.path) ?? null) ||
        canonicalSha256(Object.keys(file).sort()) !== canonicalSha256(['path', 'beforeHash', 'maximumContentBytes', 'exactContent'].sort())) {
        return workflowFailure('workflow-source5-reservation', 'The original bounded full finalization metadata or exact record bytes were changed.');
      }
      return { path: file.path, beforeHash: file.beforeHash, maximumContentBytes: file.maximumContentBytes, exactContent: file.exactContent };
    });
    if (canonicalSha256(reservedFiles.map(file => file.path).sort()) !== canonicalSha256([...finalPaths].sort())) {
      return workflowFailure('workflow-source5-reservation', 'The original complete finalization path inventory was changed.');
    }
  } else {
    if (loadedIndex) return workflowFailure('workflow-source5-reservation', 'The sealed original journal has no complete reservation; effects remain blocked.');
    const location = await resolveUpdatePreviewLocation(input.projectRoot, input.storage);
    const observed = await inspectModernInstalledActivation(input.projectRoot);
    if (location.projectRoot !== input.projectRoot || control.projectKey !== location.projectKey ||
      observed.status !== 'observed' || !observed.current ||
      observed.current.state.repository.id !== control.repositoryAnchor ||
      canonicalSha256(observed.current.state) !== plan.stateHash ||
      canonicalSha256(observed.current.state.identity) !== canonicalSha256(plan.identity)) {
      return workflowFailure('workflow-source5-reservation', 'Reservation requires independently read original current5 state and exact project/anchor scope.');
    }
    const originalState = observed.current.state;
    baseline = { state: originalState, records: observed.current.records };
    reservedFiles = await Promise.all(finalPaths.map(async filePath => {
      const snapshot = await captureProjectFileSnapshot(input.projectRoot, filePath.split('/'));
      const beforeHash = snapshot.content === undefined ? null : workflowByteDigest(snapshot.content);
      const exactContent = exactContents.get(filePath) ?? null;
      if (filePath !== 'governance/activation-state.json' && snapshot.content !== undefined &&
        (exactContent === null || !snapshot.content.equals(Buffer.from(exactContent)))) {
        return workflowFailure('workflow-source5-reservation', 'An exact inventoried metadata path is occupied by different bytes; no source effect or overwrite is permitted.');
      }
      const maximumContentBytes = exactContent !== null ? Buffer.byteLength(exactContent) :
        filePath === 'governance/activation-state.json' ? Buffer.byteLength(canonicalJson(originalState)) + 65536 :
          65536 + effects.length * maximumStageDataBytes;
      if (maximumContentBytes > 8 * 1024 * 1024) return workflowFailure('workflow-source5-reservation', 'The complete bounded completion record exceeds its supported control-string capacity.');
      return { path: filePath, beforeHash, maximumContentBytes, exactContent };
    }));
  }
  const reservationProjection = { ...common, kind: 'workflow-source5-finalization', files: reservedFiles.map(file =>
    ({ path: file.path, content: file.exactContent ?? '\\'.repeat(file.maximumContentBytes), beforeHash: file.beforeHash })) };
  const reservedFinalizationBytes = await store.measure('proof', finalizationKey, reservationProjection);
  const completeReservation = { ...recoveryReservation, files: reservedFiles, reservedFinalizationBytes, baseline };
  const reservationBytes = await store.measure('proof', reservationKey, completeReservation);
  const authorityValue = source5WorkflowAuthorityValue({ context: input.context, projectRoot: input.projectRoot,
    repositoryAnchor: control.repositoryAnchor, plan, approval, previewFingerprint: common.previewFingerprint,
    lease: input.lease, storage: input.storage });
  const indexBase = { ...common, kind: 'workflow-source5-journal', status: 'active',
    operationKeys: effects.map(operationKey), reservationKey, finalizationKey, finalProofKey: null,
    manifestKey, manifestDigest: 'f'.repeat(64) };
  const objects: Source5WorkflowStorageBound[] = [
    await store.issuerDescription(),
    { namespace: 'plan', key: control.controlKey, maximumEncodedBytes: await store.measure('plan', control.controlKey, original), maximumRevisions: 1 },
    { namespace: 'approval', key: canonicalSha256(authorityValue),
      maximumEncodedBytes: await store.measure('approval', canonicalSha256(authorityValue), authorityValue), maximumRevisions: 1 },
    { namespace: 'journal', key: control.controlKey, maximumEncodedBytes: await store.measure('journal', control.controlKey,
      { ...indexBase, status: 'finalized', finalProofKey: finalizationKey }, 2, 'f'.repeat(64)), maximumRevisions: 2 },
    { namespace: 'proof', key: reservationKey, maximumEncodedBytes: reservationBytes, maximumRevisions: 1 },
    { namespace: 'proof', key: finalizationKey, maximumEncodedBytes: reservedFinalizationBytes, maximumRevisions: 1 },
    ...readDependencies.map(entry => ({ namespace: entry.namespace, key: entry.key,
      maximumEncodedBytes: entry.encodedBytes, maximumRevisions: entry.revision }))
  ];
  for (const operation of effects) {
    const owner = await describeSource5WorkflowOwnership({ ...input, operation });
    for (const object of owner.inventory.objects) {
      if (!['operation', 'proof'].includes(object.namespace)) {
        return workflowFailure('workflow-source5-storage-inventory', 'Ownership cannot extend its closed operation/proof namespaces.');
      }
      objects.push({ ...object, namespace: object.namespace === 'operation' ? 'operation' : 'proof' });
    }
    const operationStages = stages(operation);
    const maximumPointerStage = operationStages.reduce((longest, stage) => stage.length > longest.length ? stage : longest);
    objects.push({ namespace: 'operation', key: operationKey(operation), maximumEncodedBytes: await store.measure('operation', operationKey(operation), {
      ...common, kind: 'workflow-source5-operation', operationDigest: canonicalSha256(operation),
      latestEventKey: 'f'.repeat(64), latestEventDigest: 'f'.repeat(64), stage: maximumPointerStage
    }, operationStages.length, 'f'.repeat(64)), maximumRevisions: operationStages.length });
    for (const stage of operationStages) {
      objects.push({ namespace: 'proof', key: stageKey(operation, stage), maximumEncodedBytes: await store.measure('proof', stageKey(operation, stage), {
        schemaVersion: 1, kind: 'workflow-source5-event', controlKey: control.controlKey,
        planDigest: plan.planDigest, savedPlanDigest: common.savedPlanDigest, operationDigest: canonicalSha256(operation),
        bindingDigest: canonicalSha256(operation.inputs), stage, previousEventDigest: 'f'.repeat(64),
        recordedAt: '9999-12-31T23:59:59.999Z', data: { reserved: 'x'.repeat(maximumStageDataBytes) }
      }), maximumRevisions: 1 });
    }
  }
  const manifest = await measureSource5WorkflowStorageInventory(store, manifestKey, {
    ...common, projectKey: control.projectKey, operationDigests: effects.map(operation => canonicalSha256(operation)), readDependencies
  }, objects);
  const index = { ...indexBase, manifestDigest: manifest.digest };
  async function assertReservedObject(namespace: Source5WorkflowStorageBound['namespace'], key: string, value: unknown,
    revision = 1, previousDigest: string | null = null) {
    const bound = manifest.value.objects.find(object => object.namespace === namespace && object.key === key);
    if (!bound || revision > bound.maximumRevisions ||
      await store.measure(namespace, key, value, revision, previousDigest) > bound.maximumEncodedBytes) {
      return workflowFailure('workflow-source5-storage-inventory', 'Actual complete sealed object/revision exceeds its exact original concrete reservation; existing truth remains retained.');
    }
  }
  if (loadedManifest && canonicalSha256(loadedManifest.value) !== manifest.digest) {
    return workflowFailure('workflow-source5-storage-inventory', 'The complete original closed key inventory or actual sealed footprint was changed.');
  }
  if (storedReservation && canonicalSha256(storedReservation.value) !== canonicalSha256(completeReservation)) {
    return workflowFailure('workflow-source5-reservation', 'Original full recovery/finalization reservation is absent or changed; no effect is permitted.');
  }
  if (loadedIndex && canonicalSha256(loadedIndex.value) !== canonicalSha256(index) &&
    canonicalSha256(loadedIndex.value) !== canonicalSha256({ ...index, status: 'finalized', finalProofKey: finalizationKey })) {
    return workflowFailure('workflow-source5-journal', 'The sealed workflow index differs from its exact original plan, reservation or finalization.');
  }
  async function assertInventory() {
    await assertSource5WorkflowLease(input.lease, input.projectRoot);
    const stored = await store.read('proof', manifestKey);
    const cursor = await store.read('journal', control.controlKey);
    const recovery = await store.read('proof', reservationKey);
    const retainedPlan = await store.read('plan', control.controlKey);
    for (const dependency of readDependencies) {
      const current = await store.read(dependency.namespace, dependency.key);
      if (!current || current.rawDigest !== dependency.rawDigest || current.encodedBytes !== dependency.encodedBytes ||
        current.revision !== dependency.revision) {
        return workflowFailure('workflow-source5-original', 'An independently sealed original publication dependency was lost or changed; effects and finalization remain blocked.');
      }
    }
    if (!stored || canonicalSha256(stored.value) !== manifest.digest || !cursor || !recovery || !retainedPlan ||
      canonicalSha256(recovery.value) !== canonicalSha256(completeReservation) ||
      canonicalSha256(retainedPlan.value) !== canonicalSha256(original) ||
      ![index, { ...index, status: 'finalized', finalProofKey: finalizationKey }].some(value => canonicalSha256(value) === canonicalSha256(cursor.value))) {
      return workflowFailure('workflow-source5-storage-inventory', 'The original full manifest/index is missing or changed; no intent or completion can be recreated.');
    }
  }
  async function events(operation: ModernTransitionOperation, selectedPlan = plan): Promise<readonly Source5WorkflowEvent[]> {
    const selectedInventory = source5WorkflowPlanInventory(selectedPlan);
    const selectedControl = selectedInventory.control;
    const selectedCommon = { ...common, controlKey: selectedControl.controlKey, identity: selectedPlan.identity,
      phaseId: selectedPlan.phaseId, graphHash: selectedPlan.graphHash, repositoryAnchor: selectedControl.repositoryAnchor,
      planDigest: selectedPlan.planDigest, savedPlanDigest: canonicalSha256(selectedPlan),
      previewFingerprint: source5PreviewFingerprint(input.projectRoot, selectedPlan) };
    const selectedOperationKey = canonicalSha256({ controlKey: selectedControl.controlKey, operationDigest: canonicalSha256(operation) });
    const selectedStageKey = (stage: Source5WorkflowStage) =>
      canonicalSha256({ kind: 'workflow-source5-stage-key.v1', operationKey: selectedOperationKey, stage });
    if (!selectedInventory.effects.some(entry => canonicalSha256(entry) === canonicalSha256(operation))) {
      return workflowFailure('workflow-source5-journal', 'An operation is outside the original journal inventory.');
    }
    const result: Source5WorkflowEvent[] = [];
    for (const stage of stages(operation)) {
      const stored = await store.read('proof', selectedStageKey(stage));
      if (!stored) continue;
      const raw = stored.value;
      if (selectedPlan === plan) {
        const bound = manifest.value.objects.find(bound => bound.namespace === 'proof' && bound.key === selectedStageKey(stage));
        if (!bound || stored.encodedBytes > bound.maximumEncodedBytes || stored.revision > bound.maximumRevisions) {
          return workflowFailure('workflow-source5-chain', 'Actual sealed event exceeds its original complete byte/revision reservation.');
        }
      }
      if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.kind !== 'workflow-source5-event' ||
        raw.controlKey !== selectedControl.controlKey || raw.planDigest !== selectedPlan.planDigest ||
        raw.savedPlanDigest !== selectedCommon.savedPlanDigest || raw.operationDigest !== canonicalSha256(operation) ||
        raw.bindingDigest !== canonicalSha256(operation.inputs) || raw.stage !== stage ||
        !(raw.previousEventDigest === null || typeof raw.previousEventDigest === 'string') ||
        raw.previousEventDigest !== (result.length ? canonicalSha256(result.at(-1)) : null) ||
        typeof raw.recordedAt !== 'string' || !Number.isFinite(Date.parse(raw.recordedAt)) ||
        Date.parse(raw.recordedAt) < Date.parse(selectedPlan.createdAt) ||
        result.length && Date.parse(raw.recordedAt) < Date.parse(result.at(-1)!.recordedAt) || !isRecord(raw.data) ||
        canonicalSha256(Object.keys(raw).sort()) !== canonicalSha256([
          'schemaVersion', 'kind', 'controlKey', 'planDigest', 'savedPlanDigest', 'operationDigest',
          'bindingDigest', 'stage', 'previousEventDigest', 'recordedAt', 'data'
        ].sort())) {
        return workflowFailure('workflow-source5-chain', 'Original workflow checkpoint chain is missing, reordered or contradicts its exact plan/binding.');
      }
      const event: Source5WorkflowEvent = { schemaVersion: 1, kind: 'workflow-source5-event', controlKey: selectedControl.controlKey,
        planDigest: selectedPlan.planDigest, savedPlanDigest: selectedCommon.savedPlanDigest, operationDigest: canonicalSha256(operation),
        bindingDigest: canonicalSha256(operation.inputs), stage, previousEventDigest: raw.previousEventDigest,
        recordedAt: raw.recordedAt, data: raw.data };
      if (Buffer.byteLength(canonicalJson(raw.data)) > maximumStageDataBytes) {
        return workflowFailure('workflow-source5-chain', 'Checkpoint data exceeds its original bounded complete protocol reservation.');
      }
      validateSource5WorkflowCheckpointData(operation, stage, raw.data, result, selectedPlan.planDigest);
      result.push(captureWorkflowBinding(event));
    }
    const pointer = await store.read('operation', selectedOperationKey);
    if (pointer) {
      if (selectedPlan === plan) {
        const bound = manifest.value.objects.find(bound => bound.namespace === 'operation' && bound.key === selectedOperationKey);
        if (!bound || pointer.encodedBytes > bound.maximumEncodedBytes || pointer.revision > bound.maximumRevisions) {
          return workflowFailure('workflow-source5-chain', 'Actual progress pointer exceeds its original complete byte/revision reservation.');
        }
      }
      const raw = pointer.value;
      const matched = isRecord(raw) && result.find(event => raw.latestEventKey === selectedStageKey(event.stage) &&
        raw.latestEventDigest === canonicalSha256(event));
      if (!matched || canonicalSha256(raw) !== canonicalSha256({ ...selectedCommon, kind: 'workflow-source5-operation',
        operationDigest: canonicalSha256(operation), latestEventKey: selectedStageKey(matched.stage),
        latestEventDigest: canonicalSha256(matched), stage: matched.stage })) {
        return workflowFailure('workflow-source5-chain', 'Workflow progress pointer contradicts its immutable event receipts.');
      }
      // A newer immutable receipt may precede a failed pointer CAS. It is still unresolved durable truth.
    }
    return result;
  }
  const attempted = new Set<string>();
  for (const operation of effects) {
    const recorded = await events(operation);
    if (recorded.length) attempted.add(operationKey(operation));
  }
  async function finalizationValue(value: Readonly<Record<string, unknown>>) {
    const captured = captureWorkflowBinding(value);
    if (captured.kind !== 'workflow-source5-finalization' || !Array.isArray(captured.files) ||
      canonicalSha256(Object.keys(captured).sort()) !== canonicalSha256(['files', 'kind']) ||
      canonicalSha256(captured.files.map(file => isRecord(file) ? file.path : null).sort()) !== canonicalSha256([...finalPaths].sort()) ||
      captured.files.some(file => {
        if (!isRecord(file) || typeof file.content !== 'string' ||
          canonicalSha256(Object.keys(file).sort()) !== canonicalSha256(['beforeHash', 'content', 'path'])) return true;
        const reserved = reservedFiles.find(reserved => reserved.path === file.path);
        return !reserved || file.beforeHash !== reserved.beforeHash ||
          Buffer.byteLength(file.content) > reserved.maximumContentBytes ||
          reserved.exactContent !== null && file.content !== reserved.exactContent;
      })) {
      return workflowFailure('workflow-source5-finalization', 'Finalization can write only the exact previously reserved plan/approval/evidence/state bytes and CAS paths.');
    }
    const decodedFiles = new Map<string, Readonly<Record<string, unknown>>>();
    for (const file of captured.files) {
      if (!isRecord(file) || typeof file.content !== 'string') {
        return workflowFailure('workflow-source5-finalization', 'Completion metadata has no bounded canonical record bytes.');
      }
      let decoded: unknown;
      try { decoded = JSON.parse(file.content); } catch {
        return workflowFailure('workflow-source5-finalization', 'Completion metadata must be unambiguous canonical public JSON records.');
      }
      if (!isRecord(decoded) || canonicalJson(captureWorkflowBinding(decoded)) !== file.content) {
        return workflowFailure('workflow-source5-finalization', 'Noncanonical, secret-bearing or non-record completion bytes are not reserved metadata.');
      }
      decodedFiles.set(String(file.path), decoded);
    }
    if (control.reviewKind === 'publication' || ['staging-qualified', 'production-rehearsed'].includes(plan.phaseId)) {
      return workflowFailure('workflow-source5-component-only',
        'Publication A retains only its component. Staging/production cannot finalize independent current Azure peer obligations through workflow metadata authority.');
    }
    const components = await Promise.all(effects.map(async operation => {
      const component = (await events(operation)).find(event => event.stage === 'component-completed');
      if (!component || !isRecord(component.data.proof)) {
        return workflowFailure('workflow-source5-finalization', 'Every original entry needs its independently retained complete component before finalization.');
      }
      return { operation, proof: component.data.proof, recordedAt: component.recordedAt };
    }));
    const originalApprovals = [...exactContents.entries()].filter(([key]) => key.startsWith('governance/approvals/'))
      .map(([, content]) => input.context.records.readApproval(JSON.parse(content)));
    const originalPlans = [...exactContents.entries()].filter(([key]) => key.startsWith('governance/plans/'))
      .map(([, content]) => input.context.records.readPlan(JSON.parse(content), { approvals: originalApprovals }));
    const records: ModernRelatedRecords = {
      plans: [...(baseline.records.plans ?? []), ...originalPlans].filter((record, index, values) =>
        values.findIndex(other => canonicalSha256(other) === canonicalSha256(record)) === index),
      approvals: [...(baseline.records.approvals ?? []), ...originalApprovals].filter((record, index, values) =>
        values.findIndex(other => canonicalSha256(other) === canonicalSha256(record)) === index),
      evidence: baseline.records.evidence
    };
    const evidence = input.context.records.readEvidence(decodedFiles.get(`governance/evidence/source5-${control.controlKey}.json`), records);
    if (evidence.evidenceId !== `source5-${control.controlKey}` || evidence.header.phaseId !== plan.phaseId ||
      evidence.header.repositoryId !== baseline.state.repository.id || evidence.header.result !== 'verified' ||
      !isRecord(evidence.payload) || evidence.payload.planDigest !== plan.planDigest ||
      evidence.payload.savedPlanDigest !== canonicalSha256(plan) ||
      components.some(component => Date.parse(component.recordedAt) > Date.parse(evidence.header.producedAt))) {
      return workflowFailure('workflow-source5-finalization', 'Successful completion must retain the exact original plan and components before its modern outcome receipt.');
    }
    if (['bootstrap-workflow-source-ready', 'workflow-source-ready'].includes(plan.phaseId)) {
      const execution = components.find(component => component.operation.actionId.startsWith('github.workflow-source.bind-execution-ref:'));
      const runner = components.find(component => component.operation.actionId.startsWith('github.workflow-source.admit-reviewed:'));
      if (!originalPublication || !execution || !runner ||
        canonicalSha256(evidence.payload.publication) !== canonicalSha256(originalPublication) ||
        canonicalSha256(evidence.payload.executionAdmission) !== canonicalSha256(execution.proof) ||
        canonicalSha256(evidence.payload.runnerAdmission) !== canonicalSha256(runner.proof)) {
        return workflowFailure('workflow-source5-finalization', 'Source B cannot substitute original publication, execution or runner components with a caller-shaped summary.');
      }
    } else if (canonicalSha256(evidence.payload.workflowProofs) !== canonicalSha256(components.map(component => component.proof))) {
      return workflowFailure('workflow-source5-finalization', 'Workflow completion must retain every original individual run proof in exact reviewed order, not aggregate or relabel provider identities.');
    }
    if (plan.phaseId === 'green-red-proof') {
      const matrix = evidence.payload.matrix;
      const digests = components.map(({ proof }) => canonicalSha256({
        bindingDigest: proof.bindingDigest, observationDigest: proof.observationDigest, planDigest: proof.planDigest
      }));
      if (!isRecord(matrix) || canonicalSha256(matrix.proofDigests) !== canonicalSha256(digests) ||
        matrix.observationDigest !== canonicalSha256(digests)) {
        return workflowFailure('workflow-source5-finalization', 'The matrix receipt must retain every independently current original component commitment; no synthetic pair substitutes for coverage.');
      }
    }
    const withEvidence = { ...records, evidence: [...(records.evidence ?? []), evidence] };
    const actualState = input.context.records.readState(decodedFiles.get('governance/activation-state.json'), withEvidence);
    const expectedState = input.context.records.stateAfterOutcome({ state: baseline.state, plan, phaseState: 'verified',
      updatedAt: evidence.header.producedAt, evidenceId: evidence.evidenceId }, withEvidence);
    if (canonicalSha256(actualState) !== canonicalSha256(expectedState)) {
      return workflowFailure('workflow-source5-finalization', 'Completion cannot change unrelated phases, outputs, history or custody; state must be the exact original-derived modern outcome.');
    }
    return { ...common, kind: 'workflow-source5-finalization', files: captured.files };
  }
  async function readFinalization(): Promise<WorkflowSource5StoredControl | null> {
    await assertInventory();
    const stored = await store.read('proof', finalizationKey);
    if (!stored) return null;
    if (!isRecord(stored.value)) return workflowFailure('workflow-source5-finalization', 'Original finalization metadata is malformed.');
    const expected = await finalizationValue({ kind: stored.value.kind, files: stored.value.files });
    if (canonicalSha256(stored.value) !== canonicalSha256(expected) ||
      await store.measure('proof', finalizationKey, expected) > reservedFinalizationBytes) {
      return workflowFailure('workflow-source5-finalization', 'Original completion bytes, scope or reservation were changed. No provider work may be repeated.');
    }
    return stored;
  }
  const journal: Source5WorkflowJournal = {
    projectRoot: input.projectRoot, plan, approval, controlKey: control.controlKey, lease: input.lease, assertInventory,
    wasAttempted: operation => attempted.has(operationKey(operation)), events,
    proofKey: operation => stageKey(operation, 'component-completed'),
    async record(operation, stage, rawData) {
      await assertInventory();
      const data = captureWorkflowBinding(rawData);
      if (!stages(operation).includes(stage) || Buffer.byteLength(canonicalJson(data)) > maximumStageDataBytes ||
        data.bindingDigest !== canonicalSha256(operation.inputs) || data.planDigest !== plan.planDigest) {
        return workflowFailure('workflow-source5-checkpoint', 'Workflow progress must fit the original reserved exact operation/plan protocol.');
      }
      const recorded = await events(operation), existing = recorded.find(event => event.stage === stage);
      if (existing) {
        if (canonicalSha256(existing.data) !== canonicalSha256(data)) {
          return workflowFailure('workflow-source5-regression', 'Known original acceptance/terminal/component truth cannot be replaced or relabelled.');
        }
        return;
      }
      validateSource5WorkflowCheckpointData(operation, stage, data, recorded, plan.planDigest);
      const allowed = stages(operation), prior = recorded.at(-1);
      if (prior && allowed.indexOf(prior.stage) >= allowed.indexOf(stage) ||
        stage.endsWith('-accepted') && !recorded.some(event => event.stage.endsWith('-intent')) ||
        stage === 'dispatch-terminal' && !recorded.some(event => event.stage === 'dispatch-accepted')) {
        return workflowFailure('workflow-source5-regression', 'Workflow progress cannot regress, omit original intent, or replace an accepted handle.');
      }
      const timestamp = recordedAt;
      if (Date.parse(timestamp) < Date.parse(plan.createdAt) || prior && Date.parse(timestamp) < Date.parse(prior.recordedAt)) {
        return workflowFailure('workflow-source5-checkpoint', 'Original progress cannot precede its reviewed invocation or retag a later accepted/terminal time.');
      }
      const event: Source5WorkflowEvent = { schemaVersion: 1, kind: 'workflow-source5-event', controlKey: control.controlKey,
        planDigest: plan.planDigest, savedPlanDigest: common.savedPlanDigest, operationDigest: canonicalSha256(operation),
        bindingDigest: canonicalSha256(operation.inputs), stage, previousEventDigest: prior ? canonicalSha256(prior) : null,
        recordedAt: timestamp, data };
      const eventKey = stageKey(operation, stage);
      attempted.add(operationKey(operation));
      await assertReservedObject('proof', eventKey, event);
      await store.save('proof', eventKey, event, null);
      const pointer = await store.read('operation', operationKey(operation));
      const value = { ...common, kind: 'workflow-source5-operation',
        operationDigest: canonicalSha256(operation), latestEventKey: eventKey,
        latestEventDigest: canonicalSha256(event), stage };
      await assertReservedObject('operation', operationKey(operation), value, (pointer?.revision ?? 0) + 1, pointer?.rawDigest ?? null);
      await store.save('operation', operationKey(operation), value, pointer?.rawDigest ?? null);
    },
    async saveFinalization(value) {
      await assertInventory();
      const complete = await finalizationValue(value);
      await assertReservedObject('proof', finalizationKey, complete);
      if (await store.measure('proof', finalizationKey, complete) > reservedFinalizationBytes) {
        return workflowFailure('workflow-source5-reservation', 'Completion exceeded its original fully encoded reservation; provider truth and unresolved intent remain retained.');
      }
      const existing = await readFinalization();
      if (existing) {
        if (canonicalSha256(existing.value) !== canonicalSha256(complete)) {
          return workflowFailure('workflow-source5-finalization', 'An original finalization cannot be rebuilt with different bytes after partial publication.');
        }
      } else await store.save('proof', finalizationKey, complete, null);
      return finalizationKey;
    },
    readFinalization,
    async markFinalized(proofKey) {
      await assertInventory();
      const proof = await readFinalization();
      if (proofKey !== finalizationKey || !proof || !isRecord(proof.value) || !Array.isArray(proof.value.files)) {
        return workflowFailure('workflow-source5-finalization', 'Finalized progress requires its original sealed exact-byte completion intent.');
      }
      await Promise.all(proof.value.files.map(async file => {
        if (!isRecord(file) || typeof file.path !== 'string' || typeof file.content !== 'string') {
          return workflowFailure('workflow-source5-finalization', 'Original finalization metadata is malformed.');
        }
        const actual = await captureProjectFileSnapshot(input.projectRoot, file.path.split('/'));
        if (!actual.content || !actual.content.equals(Buffer.from(file.content))) {
          return workflowFailure('workflow-source5-finalization', 'The exact reserved final project bytes are not independently observed; finalization remains unresolved.');
        }
      }));
      const before = await store.read('journal', control.controlKey);
      if (!before) return workflowFailure('workflow-source5-journal', 'The original control index disappeared during finalization.');
      const completed = { ...index, status: 'finalized', finalProofKey: proofKey };
      if (canonicalSha256(before.value) !== canonicalSha256(completed)) {
        if (canonicalSha256(before.value) !== canonicalSha256(index)) {
          return workflowFailure('workflow-source5-journal', 'Concurrent index changes cannot be overwritten with success-shaped finalization.');
        }
        await assertReservedObject('journal', control.controlKey, completed, before.revision + 1, before.rawDigest);
        await store.save('journal', control.controlKey, completed, before.rawDigest);
      }
    }
  };
  const description = { journal: Object.freeze({
    projectRoot: journal.projectRoot, plan, approval, controlKey: journal.controlKey,
    assertInventory, events, readFinalization
  }), index, finalizationKey, store: Object.freeze({ read: store.read, digest: store.digest }), effects, retainedReviews,
    manifestKey, reservationKey, manifest, completeReservation, baseline,
    assertReservedObject };
  journalWriters.set(description, { journal: Object.freeze(journal),
    async initialize() {
      if (!loadedManifest) await store.save('proof', manifestKey, manifest.value, null);
      if (!storedReservation) await store.save('proof', reservationKey, completeReservation, null);
      const reservation = await store.read('proof', reservationKey);
      if (!reservation || canonicalSha256(reservation.value) !== canonicalSha256(completeReservation)) {
        return workflowFailure('workflow-source5-reservation', 'Original full recovery/finalization reservation is absent or changed; no effect is permitted.');
      }
      if (!loadedIndex) await store.save('journal', control.controlKey, index, null);
    } });
  return description;
}
export async function openSource5WorkflowJournal(input: Source5WorkflowJournalInput): Promise<Source5WorkflowJournal> {
  input = { ...input, plan: captureWorkflowBinding(input.plan), approval: captureWorkflowBinding(input.approval),
    now: new Date(input.now) };
  const description = await describeSource5WorkflowJournal(input);
  for (const operation of description.effects) await source5WorkflowOwnership({ ...input, operation });
  const writer = journalWriters.get(description)!;
  await writer.initialize();
  instances.add(writer.journal);
  return writer.journal;
}

export interface Source5WorkflowFinalizationReader {
  readonly kind: 'source5-workflow-finalization-reader';
}
type FinalizationInput = Omit<Source5WorkflowJournalInput, 'now' | 'initialize'>;
type JournalDescription = Awaited<ReturnType<typeof describeSource5WorkflowJournal>>;
const finalizationReaders = new WeakMap<Source5WorkflowFinalizationReader, {
  input: FinalizationInput; description: JournalDescription; retainedDigest: string;
}>();

async function retainedFinalizationMaterial(input: FinalizationInput, description: JournalDescription) {
  await assertSource5WorkflowLease(input.lease, input.projectRoot);
  await description.journal.assertInventory();
  const proof = await description.journal.readFinalization();
  if (!proof || proof.revision !== 1 || proof.previousDigest !== null || !isRecord(proof.value) ||
    !Array.isArray(proof.value.files)) {
    return workflowFailure('workflow-source5-finalization', 'Terminal bookkeeping needs an existing immutable exact original finalization, not target-shaped bytes.');
  }
  await description.assertReservedObject('proof', description.finalizationKey, proof.value);
  const originalRecords = [];
  for (const entry of [
    { namespace: 'plan' as const, key: description.journal.controlKey,
      value: source5WorkflowOriginalPlanValue(input.projectRoot, input.plan, input.approval) },
    { namespace: 'proof' as const, key: description.manifestKey, value: description.manifest.value },
    { namespace: 'proof' as const, key: description.reservationKey, value: description.completeReservation }
  ]) {
    const original = await description.store.read(entry.namespace, entry.key);
    if (!original || original.revision !== 1 || original.previousDigest !== null ||
      original.rawDigest !== await description.store.digest(entry.namespace, entry.key, entry.value)) {
      return workflowFailure('workflow-source5-finalization', 'Original plan, manifest and reservation require immutable first revisions, not coherent retagging.');
    }
    await description.assertReservedObject(entry.namespace, entry.key, original.value);
    originalRecords.push(original);
  }
  const ownership = [];
  const reviews = new Map(description.retainedReviews.map(review => [canonicalSha256(review.plan), review]));
  for (const review of description.retainedReviews) {
    if (review.plan !== description.journal.plan) {
      const source = await describeSource5WorkflowJournal({ ...input, ...review,
        now: new Date(review.plan.createdAt), initialize: false });
      await source.journal.assertInventory();
      await finalizationIndex(source);
      for (const entry of [
        { namespace: 'plan' as const, key: source.journal.controlKey,
          value: source5WorkflowOriginalPlanValue(input.projectRoot, review.plan, review.approval) },
        { namespace: 'proof' as const, key: source.manifestKey, value: source.manifest.value },
        { namespace: 'proof' as const, key: source.reservationKey, value: source.completeReservation }
      ]) {
        const original = await source.store.read(entry.namespace, entry.key);
        if (!original || original.revision !== 1 || original.previousDigest !== null ||
          original.rawDigest !== await source.store.digest(entry.namespace, entry.key, entry.value)) {
          return workflowFailure('workflow-source5-finalization', 'Original publication ledger cannot be coherently retagged for terminal bookkeeping.');
        }
        await source.assertReservedObject(entry.namespace, entry.key, original.value);
        originalRecords.push(original);
      }
    }
    for (const operation of source5WorkflowPlanInventory(review.plan).effects) {
      const history = await readSource5WorkflowOwnershipHistory({ ...input, ...review, operation });
      ownership.push(history);
      for (const ancestor of history.description.lineage) reviews.set(canonicalSha256(ancestor.plan), ancestor);
    }
  }
  const issuances = [];
  for (const review of reviews.values()) {
    const { control } = source5WorkflowPlanInventory(review.plan);
    const value = source5WorkflowAuthorityValue({ ...input, ...review, repositoryAnchor: control.repositoryAnchor,
      previewFingerprint: source5PreviewFingerprint(input.projectRoot, review.plan) });
    const key = canonicalSha256(value), issued = await description.store.read('approval', key);
    if (!issued || issued.revision !== 1 || issued.previousDigest !== null ||
      canonicalSha256(issued.value) !== canonicalSha256(value)) {
      return workflowFailure('workflow-source5-unissued', 'Original independently sealed workflow issuance is required even for expired terminal bookkeeping.');
    }
    issuances.push(issued);
  }
  const components = await Promise.all(description.effects.map(operation => description.journal.events(operation)));
  await assertSource5WorkflowLease(input.lease, input.projectRoot);
  return { proof, files: proof.value.files,
    digest: canonicalSha256({ proof, originalRecords, ownership, issuances, components }) };
}

async function finalizationIndex(description: JournalDescription) {
  const { store, index, finalizationKey, journal } = description;
  const cursor = await store.read('journal', journal.controlKey);
  const activeDigest = await store.digest('journal', journal.controlKey, index);
  const completed = { ...index, status: 'finalized', finalProofKey: finalizationKey };
  if (!cursor || !(
    cursor.revision === 1 && cursor.previousDigest === null && cursor.rawDigest === activeDigest &&
      canonicalSha256(cursor.value) === canonicalSha256(index) ||
    cursor.revision === 2 && cursor.previousDigest === activeDigest &&
      cursor.rawDigest === await store.digest('journal', journal.controlKey, completed, 2, activeDigest) &&
      canonicalSha256(cursor.value) === canonicalSha256(completed))) {
    return workflowFailure('workflow-source5-finalization', 'Final index must retain its exact original revision, sealed predecessor and canonical projection.');
  }
  await description.assertReservedObject('journal', journal.controlKey, cursor.value, cursor.revision, cursor.previousDigest);
  return cursor;
}

export async function openSource5WorkflowFinalizationReader(raw: FinalizationInput): Promise<Source5WorkflowFinalizationReader> {
  const required = ['projectRoot', 'plan', 'approval', 'context', 'lease'];
  const allowed = [...required, 'storage'];
  if (!raw || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
    Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !allowed.includes(key)) ||
    required.some(key => !Object.hasOwn(raw, key)) ||
    Object.values(Object.getOwnPropertyDescriptors(raw)).some(field => !('value' in field))) {
    return workflowFailure('workflow-source5-finalization', 'Finalization reader accepts only closed own data fields, never executable substitutes or execution capabilities.');
  }
  const input = { ...raw, plan: captureWorkflowBinding(raw.plan), approval: captureWorkflowBinding(raw.approval),
    ...(raw.storage ? { storage: { ...raw.storage, ...(raw.storage.env ? { env: { ...raw.storage.env } } : {}) } } : {}) };
  assertSource5WorkflowContext(input.context);
  await assertSource5WorkflowLease(input.lease, input.projectRoot);
  const location = await resolveUpdatePreviewLocation(input.projectRoot, input.storage);
  const { control } = source5WorkflowPlanInventory(input.plan);
  if (location.projectRoot !== input.projectRoot || location.projectKey !== control.projectKey) {
    return workflowFailure('workflow-source5-finalization', 'Finalization reader requires the exact original canonical root and independently resolved project key.');
  }
  const description = await describeSource5WorkflowJournal({ ...input,
    now: new Date(input.plan.createdAt), initialize: false });
  const retained = await retainedFinalizationMaterial(input, description);
  await finalizationIndex(description);
  const reader = Object.freeze({ kind: 'source5-workflow-finalization-reader' as const });
  finalizationReaders.set(reader, { input, description, retainedDigest: retained.digest });
  return reader;
}

async function currentFinalization(reader: Source5WorkflowFinalizationReader) {
  const binding = finalizationReaders.get(reader);
  if (!binding) return workflowFailure('workflow-source5-finalization', 'Structural copies, journals and authority tokens are not branded terminal-bookkeeping readers.');
  const { input, description } = binding;
  const material = await retainedFinalizationMaterial(input, description);
  if (material.digest !== binding.retainedDigest) {
    return workflowFailure('workflow-source5-finalization', 'Retained original finalization inputs changed; reconciliation is unresolved, not permission to rebuild history.');
  }
  const files = await Promise.all(material.files.map(async (file: unknown) => {
    if (!isRecord(file) || typeof file.path !== 'string' || typeof file.content !== 'string') {
      return workflowFailure('workflow-source5-finalization', 'Exact original finalization file inventory is malformed.');
    }
    const actual = await captureProjectFileSnapshot(input.projectRoot, file.path.split('/'));
    const state = actual.content?.equals(Buffer.from(file.content)) ? 'recorded' :
      (actual.content === undefined ? null : workflowByteDigest(actual.content)) === file.beforeHash ? 'original' : 'different';
    return { path: file.path, state };
  }));
  const cursor = await finalizationIndex(description);
  if (files.every(file => file.state === 'recorded')) {
    const observed = await inspectModernInstalledActivation(input.projectRoot);
    if (observed.status !== 'observed' || !observed.current ||
      observed.snapshot.root !== input.projectRoot ||
      observed.current.state.repository.id !== source5WorkflowPlanInventory(input.plan).control.repositoryAnchor ||
      canonicalSha256(observed.current.state.identity) !== canonicalSha256(input.plan.identity)) {
      return workflowFailure('workflow-source5-finalization', 'Actual installed source, history and custody must remain independently readable in the original canonical scope.');
    }
    const decoded = material.files.map(file => {
      if (!isRecord(file) || typeof file.path !== 'string' || typeof file.content !== 'string') {
        return workflowFailure('workflow-source5-finalization', 'Original finalization file inventory is malformed.');
      }
      return { path: file.path, value: JSON.parse(file.content) as unknown };
    });
    if (canonicalSha256(observed.current.state) !==
      canonicalSha256(decoded.find(file => file.path === 'governance/activation-state.json')!.value) ||
      material.files.some(file => !isRecord(file) || typeof file.path !== 'string' || typeof file.content !== 'string' ||
        observed.snapshot.files.find(actual => actual.pathParts.join('/') === file.path)?.digest !== workflowByteDigest(file.content))) {
      return workflowFailure('workflow-source5-finalization', 'Independently captured installed target bytes changed during bookkeeping observation; the index remains unresolved.');
    }
    for (const collection of ['plans', 'approvals', 'evidence'] as const) {
      const expected = [...(description.baseline.records[collection] ?? []),
        ...decoded.filter(file => file.path.startsWith(`governance/${collection}/`)).map(file => file.value)]
        .map(record => canonicalSha256(record));
      if (canonicalSha256([...new Set(expected)].sort()) !==
        canonicalSha256((observed.current.records[collection] ?? []).map(record => canonicalSha256(record)).sort())) {
        return workflowFailure('workflow-source5-finalization', 'Unrelated original installed records cannot be added, removed or rewritten by final index bookkeeping.');
      }
    }
  }
  await assertSource5WorkflowLease(input.lease, input.projectRoot);
  if (cursor.revision === 2 && files.some(file => file.state !== 'recorded')) {
    return workflowFailure('workflow-source5-finalization', 'Finalized index contradicts independently observed exact original target bytes; retain the inconsistent ledger.');
  }
  return { binding, cursor, files };
}

export async function inspectSource5WorkflowFinalization(reader: Source5WorkflowFinalizationReader) {
  const { cursor, files } = await currentFinalization(reader);
  return captureWorkflowBinding({ status: files.every(file => file.state === 'recorded') ? 'recorded-bytes-present' :
    files.some(file => file.state === 'different') ? 'different-bytes' :
      files.some(file => file.state === 'recorded') ? 'partial-original-publication' : 'original-bytes',
    finalized: cursor.revision === 2, files });
}

export async function reconcileSource5WorkflowFinalization(reader: Source5WorkflowFinalizationReader): Promise<void> {
  const requireExact = async () => {
    const current = await currentFinalization(reader);
    if (current.files.some(file => file.state !== 'recorded')) {
      return workflowFailure('workflow-source5-finalization', 'Only already-written exact original target bytes permit terminal index bookkeeping; before, partial or different bytes remain blocked.');
    }
    return current;
  };
  const { binding, cursor } = await requireExact();
  if (cursor.revision === 2) return;
  const { description } = binding;
  await createWorkflowSource5ControlStore(binding.input.projectRoot, binding.input.storage)
    .finalizeJournal(description.journal.controlKey, description.index,
    description.finalizationKey, cursor.rawDigest, async () => {
      const current = await requireExact();
      if (current.cursor.revision !== 1 || current.cursor.rawDigest !== cursor.rawDigest) {
        return workflowFailure('workflow-source5-finalization', 'The original active index changed before atomic replacement; retain its current truth without another CAS.');
      }
    });
  const after = await requireExact();
  if (after.cursor.revision !== 2 || after.cursor.previousDigest !== cursor.rawDigest) {
    return workflowFailure('workflow-source5-finalization', 'Final index CAS was accepted without exact confirmation; retain unresolved original truth and never undo or recreate metadata.');
  }
}
