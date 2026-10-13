import { createWorkflowSource5ControlStore, resolveUpdatePreviewLocation } from '../adapters/filesystem/update-previews.js';
import type { UpdatePreviewOptions, WorkflowSource5StoredControl } from '../adapters/filesystem/update-previews.js';
import type { ProjectMutationLease } from '../adapters/filesystem/project-lock.js';
import { inspectModernInstalledActivation } from '../application/governance/modern-installed-preflight.js';
import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import type { ModernApprovalEnvelope, ModernSavedTransitionPlan, ModernTransitionOperation } from '../domain/governance/activation/modern-record-contracts.js';
import { captureWorkflowBinding, workflowFailure } from './workflow-binding.js';
import { assertSource5WorkflowContext, assertSource5WorkflowLease, source5ApprovalHash, source5WorkflowOriginalPlanValue } from './workflow-source5-context.js';
import type { Source5WorkflowContext } from './workflow-source5-context.js';
import { source5WorkflowPlanInventory } from './workflow-source5-operations.js';

export const source5OwnershipMaximumGeneration = 64;
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const same = (left: unknown, right: unknown) => canonicalSha256(left) === canonicalSha256(right);
const kinds = ['publication-writing', 'publication-commit-intent', 'publication-commit-observed', 'publication-committed',
  'publication-push-intent', 'publication-push-accepted', 'publication-published', 'execution-ref-intent',
  'execution-ref-accepted', 'runner-intent', 'runner-accepted', 'dispatch-intent', 'dispatch-accepted',
  'dispatch-terminal', 'component-completed'] as const;
export interface Source5WorkflowOwnershipInput {
  readonly context: Source5WorkflowContext;
  readonly projectRoot: string;
  readonly plan: ModernSavedTransitionPlan;
  readonly approval: ModernApprovalEnvelope;
  readonly operation: ModernTransitionOperation;
  readonly lease: ProjectMutationLease;
  readonly storage?: UpdatePreviewOptions;
}
interface Owner {
  generation: number;
  controlKey: string;
  planDigest: string;
  savedPlanDigest: string;
  approvalHash: string;
  rawSnapshotDigest: string;
}
export async function source5WorkflowOwnership(input: Source5WorkflowOwnershipInput) {
  input = { ...input, plan: captureWorkflowBinding(input.plan), approval: captureWorkflowBinding(input.approval),
    operation: captureWorkflowBinding(input.operation) };
  assertSource5WorkflowContext(input.context);
  await assertSource5WorkflowLease(input.lease, input.projectRoot);
  input.context.records.readPlan(input.plan, { approvals: [input.approval] });
  const inventory = source5WorkflowPlanInventory(input.plan), operationDigest = canonicalSha256(input.operation);
  if (!inventory.effects.some(operation => same(operation, input.operation))) {
    return workflowFailure('workflow-source5-owner', 'Only an exact inventoried workflow entry has ownership.');
  }
  const location = await resolveUpdatePreviewLocation(input.projectRoot, input.storage);
  const observed = await inspectModernInstalledActivation(input.projectRoot);
  if (location.projectRoot !== input.projectRoot || inventory.control.projectKey !== location.projectKey ||
    observed.status !== 'observed' || !observed.current ||
    observed.current.state.repository.id !== inventory.control.repositoryAnchor ||
    canonicalSha256(observed.current.state.identity) !== canonicalSha256(input.plan.identity) ||
    canonicalSha256(observed.current.state) !== input.plan.stateHash) {
    return workflowFailure('workflow-source5-owner', 'Ownership requires the independently observed exact current5 project/anchor/state scope.');
  }
  const rawSnapshotDigest = observed.binding;
  const store = createWorkflowSource5ControlStore(input.projectRoot, input.storage);
  const sealedCurrent = await store.read('plan', inventory.control.controlKey);
  if (!sealedCurrent || !same(sealedCurrent.value, source5WorkflowOriginalPlanValue(input.projectRoot, input.plan, input.approval))) {
    return workflowFailure('workflow-source5-owner', 'Ownership requires the complete independently sealed exact original reviewed plan and approval.');
  }
  const lineage = [{ plan: input.plan, approval: input.approval, control: inventory.control }];
  const visited = new Set([inventory.control.controlKey]);
  while (lineage.at(-1)!.control.remainingFrom) {
    const current = lineage.at(-1)!, reference = current.control.remainingFrom!;
    if (visited.has(reference.planKey) || visited.size >= source5OwnershipMaximumGeneration + 1) {
      return workflowFailure('workflow-source5-owner', 'Remaining-only entry ancestry is cyclic or exceeds its closed generation bound.');
    }
    visited.add(reference.planKey);
    const original = await store.read('plan', reference.planKey);
    if (!original || !isRecord(original.value) || original.value.kind !== 'workflow-source5-original-plan' ||
      original.value.projectRoot !== input.projectRoot || original.value.controlKey !== reference.planKey) {
      return workflowFailure('workflow-source5-owner', 'Remaining-only ownership needs the independently sealed exact original plan, not caller ancestry.');
    }
    const approval = input.context.records.readApproval(original.value.approval);
    const plan = input.context.records.readPlan(original.value.plan, { approvals: [approval] });
    const prior = source5WorkflowPlanInventory(plan);
    if (!same(original.value, source5WorkflowOriginalPlanValue(input.projectRoot, plan, approval)) ||
      !same(plan.identity, input.plan.identity) || plan.phaseId !== input.plan.phaseId ||
      prior.control.projectKey !== location.projectKey || prior.control.repositoryAnchor !== inventory.control.repositoryAnchor ||
      !same(prior.control.origin, inventory.control.origin) || !prior.effects.some(operation => same(operation, input.operation)) ||
      !same(reference.operationDigests.slice().sort(), source5WorkflowPlanInventory(current.plan).effects.map(operation => canonicalSha256(operation)).sort())) {
      return workflowFailure('workflow-source5-owner', 'Continuation scope or exact unstarted entries differ from their sealed original plan.');
    }
    lineage.push({ plan, approval, control: prior.control });
  }
  const original = lineage.at(-1)!;
  const scope = { schemaVersion: 1, projectRoot: input.projectRoot, projectKey: location.projectKey,
    repositoryAnchor: inventory.control.repositoryAnchor, identity: input.plan.identity, phaseId: input.plan.phaseId,
    originalPlanKey: original.control.controlKey, operationDigest };
  const entryKey = canonicalSha256({ kind: 'workflow-source5-original-entry-key.v1', ...scope });
  function generationKey(kind: 'reservation' | 'confirmation', generation: number) {
    if (!Number.isSafeInteger(generation) || generation < (kind === 'reservation' ? 1 : 0) ||
      generation > source5OwnershipMaximumGeneration) {
      return workflowFailure('workflow-source5-owner', 'The ownership key is outside its fixed inventoried generation range.');
    }
    return canonicalSha256({ kind: `workflow-source5-owner-${kind}-key.v1`, entryKey, generation });
  }
  const reservationKey = (generation: number) => generationKey('reservation', generation);
  const confirmationKey = (generation: number) => generationKey('confirmation', generation);
  const manifestKey = canonicalSha256({ kind: 'workflow-source5-owner-manifest-key.v1', entryKey });
  const desired = (generation: number): Owner => ({ generation, controlKey: inventory.control.controlKey,
    planDigest: input.plan.planDigest, savedPlanDigest: canonicalSha256(input.plan),
    approvalHash: source5ApprovalHash(input.context, input.approval), rawSnapshotDigest });
  function owner(raw: unknown): Owner {
    if (!isRecord(raw) || !Number.isSafeInteger(raw.generation) || typeof raw.generation !== 'number' ||
      raw.generation < 0 || raw.generation > source5OwnershipMaximumGeneration ||
      !hex(raw.controlKey) || !hex(raw.planDigest) || !hex(raw.savedPlanDigest) ||
      !hex(raw.approvalHash) || !hex(raw.rawSnapshotDigest) ||
      !same(Object.keys(raw).sort(), ['generation', 'controlKey', 'planDigest', 'savedPlanDigest', 'approvalHash', 'rawSnapshotDigest'].sort())) {
      return workflowFailure('workflow-source5-owner', 'The closed original-entry ownership record is malformed.');
    }
    return { generation: raw.generation, controlKey: raw.controlKey, planDigest: raw.planDigest,
      savedPlanDigest: raw.savedPlanDigest, approvalHash: raw.approvalHash, rawSnapshotDigest: raw.rawSnapshotDigest };
  }
  async function pointer(): Promise<{ record: WorkflowSource5StoredControl; owner: Owner } | null> {
    const record = await store.read('operation', entryKey);
    if (!record) return null;
    if (!isRecord(record.value)) return workflowFailure('workflow-source5-owner', 'Original entry ownership is malformed.');
    const selected = owner(record.value.owner);
    if (record.revision !== selected.generation + 1 ||
      (selected.generation === 0 && record.previousDigest !== null) ||
      !same(record.value, { ...scope, kind: 'workflow-source5-entry-owner', owner: selected })) {
      return workflowFailure('workflow-source5-owner', 'Ownership belongs to a foreign original entry or scope.');
    }
    return { record, owner: selected };
  }
  async function requireUnattempted(): Promise<void> {
    for (const ancestor of lineage) {
      const operationKey = canonicalSha256({ controlKey: ancestor.control.controlKey, operationDigest });
      if (await store.read('operation', operationKey)) {
        return workflowFailure('workflow-source5-owner-attempted', 'An original progress cursor exists; its entry cannot be transferred or repeated.');
      }
      for (const stage of kinds) {
        const key = canonicalSha256({ kind: 'workflow-source5-stage-key.v1', operationKey, stage });
        if (await store.read('proof', key)) {
          return workflowFailure('workflow-source5-owner-attempted', 'Durable intent, acceptance, terminal or component truth forbids remaining-only ownership.');
        }
      }
    }
  }
  const confirmation = (record: Pick<WorkflowSource5StoredControl, 'rawDigest'>, selected: Owner, previousReceiptDigest: string | null) =>
    ({ ...scope, kind: 'workflow-source5-owner-confirmed', owner: selected, pointerRawDigest: record.rawDigest,
      previousReceiptDigest });
  async function measureInventory() {
    const maximum = { generation: source5OwnershipMaximumGeneration, controlKey: 'f'.repeat(64),
      planDigest: 'f'.repeat(64), savedPlanDigest: 'f'.repeat(64), approvalHash: 'f'.repeat(64), rawSnapshotDigest: 'f'.repeat(64) };
    const operationBytes = await store.measure('operation', entryKey,
      { ...scope, kind: 'workflow-source5-entry-owner', owner: maximum }, source5OwnershipMaximumGeneration + 1, 'f'.repeat(64));
    const confirmationBytes = await store.measure('proof', confirmationKey(maximum.generation),
      confirmation({ rawDigest: 'f'.repeat(64) }, maximum, 'f'.repeat(64)));
    const receiptBytes = await store.measure('proof', reservationKey(maximum.generation),
      { ...scope, kind: 'workflow-source5-owner-reservation', previousOwner: maximum,
        previousPointerRawDigest: 'f'.repeat(64), previousConfirmationRawDigest: 'f'.repeat(64), newOwner: maximum });
    const objects = [
      { namespace: 'operation', key: entryKey, maximumEncodedBytes: operationBytes, maximumRevisions: source5OwnershipMaximumGeneration + 1 },
      ...Array.from({ length: source5OwnershipMaximumGeneration + 1 }, (_, generation) => [
        { namespace: 'proof', key: confirmationKey(generation), maximumEncodedBytes: confirmationBytes, maximumRevisions: 1 },
        ...(generation ? [{ namespace: 'proof', key: reservationKey(generation), maximumEncodedBytes: receiptBytes, maximumRevisions: 1 }] : [])
      ]).flat()
    ];
    const self = { namespace: 'proof', key: manifestKey, maximumEncodedBytes: 0, maximumRevisions: 1 };
    objects.push(self);
    const value = { ...scope, kind: 'workflow-source5-owner-manifest', entryKey,
      generationLimit: source5OwnershipMaximumGeneration, objects, maximumEncodedFootprint: 0 };
    for (let attempt = 0; ; attempt++) {
      value.maximumEncodedFootprint = objects.reduce((total, object) =>
        total + object.maximumEncodedBytes * object.maximumRevisions, 0);
      const measured = await store.measure('proof', manifestKey, value);
      if (measured === self.maximumEncodedBytes) break;
      if (attempt === 8) return workflowFailure('workflow-source5-owner', 'Complete sealed ownership inventory cannot be represented within its fixed bound.');
      self.maximumEncodedBytes = measured;
    }
    return captureWorkflowBinding(value);
  }
  async function manifest(initialize: boolean) {
    const value = await measureInventory();
    const existing = await store.read('proof', manifestKey);
    if (existing) {
      if (!same(existing.value, value)) return workflowFailure('workflow-source5-owner', 'Original concrete ownership inventory or complete sealed footprint was changed.');
    } else {
      if (!initialize) return workflowFailure('workflow-source5-owner', 'Original concrete ownership inventory is missing; no execution permission can be recreated.');
      await store.measure('proof', manifestKey, value);
      await store.save('proof', manifestKey, value, null);
    }
  }
  async function verifyHistory(selected: Owner, pointerRawDigest: string): Promise<void> {
    const originalPlan = lineage.find(ancestor => ancestor.control.controlKey === selected.controlKey);
    if (!originalPlan || selected.planDigest !== originalPlan.plan.planDigest ||
      selected.savedPlanDigest !== canonicalSha256(originalPlan.plan) ||
      selected.approvalHash !== source5ApprovalHash(input.context, originalPlan.approval) ||
      selected.rawSnapshotDigest !== originalPlan.plan.baselineDigest) {
      return workflowFailure('workflow-source5-owner', 'Ownership does not retain its independently sealed original plan, review and raw snapshot.');
    }
    const confirmed = await store.read('proof', confirmationKey(selected.generation));
    if (!confirmed || !isRecord(confirmed.value) ||
      (selected.generation === 0 ? confirmed.value.previousReceiptDigest !== null : !hex(confirmed.value.previousReceiptDigest))) {
      return workflowFailure('workflow-source5-owner', 'Exact original ownership readback was not durably confirmed.');
    }
    const previousReceiptDigest = confirmed.value.previousReceiptDigest === null ? null : String(confirmed.value.previousReceiptDigest);
    if (!same(confirmed.value, confirmation({ rawDigest: pointerRawDigest }, selected, previousReceiptDigest))) {
      return workflowFailure('workflow-source5-owner', 'Immutable ownership confirmation has foreign scope, extra fields or a different pointer.');
    }
    if (!selected.generation) return;
    const receipt = await store.read('proof', reservationKey(selected.generation));
    if (!receipt || receipt.rawDigest !== previousReceiptDigest || !isRecord(receipt.value) ||
      !hex(receipt.value.previousPointerRawDigest) || !hex(receipt.value.previousConfirmationRawDigest)) {
      return workflowFailure('workflow-source5-owner', 'Original ownership reservation history is missing or malformed.');
    }
    const previous = owner(receipt.value.previousOwner);
    if (previous.generation + 1 !== selected.generation ||
      !same(receipt.value, { ...scope, kind: 'workflow-source5-owner-reservation', previousOwner: previous,
        previousPointerRawDigest: receipt.value.previousPointerRawDigest,
        previousConfirmationRawDigest: receipt.value.previousConfirmationRawDigest, newOwner: selected })) {
      return workflowFailure('workflow-source5-owner', 'Ownership reservation has foreign scope, extra fields or a stale generation.');
    }
    const prior = await store.read('proof', confirmationKey(previous.generation));
    if (!prior || prior.rawDigest !== receipt.value.previousConfirmationRawDigest) {
      return workflowFailure('workflow-source5-owner', 'Original immutable ownership confirmation history disappeared or was changed.');
    }
    if (selected.controlKey === inventory.control.controlKey) {
      const current = await pointer();
      if (current?.record.rawDigest === pointerRawDigest && current.record.previousDigest !== receipt.value.previousPointerRawDigest) {
        return workflowFailure('workflow-source5-owner', 'The actual ownership CAS does not preserve its immutable previous-pointer commitment.');
      }
    }
    await verifyHistory(previous, receipt.value.previousPointerRawDigest);
  }
  async function assertCurrent(fresh: boolean): Promise<void> {
    await assertSource5WorkflowLease(input.lease, input.projectRoot);
    await manifest(false);
    const current = await pointer();
    if (!current || current.owner.controlKey !== inventory.control.controlKey ||
      current.owner.planDigest !== input.plan.planDigest || current.owner.savedPlanDigest !== canonicalSha256(input.plan) ||
      current.owner.approvalHash !== source5ApprovalHash(input.context, input.approval)) {
      return workflowFailure('workflow-source5-owner', 'No confirmed exact ownership exists for this current reviewed plan.');
    }
    const next = current.owner.generation < source5OwnershipMaximumGeneration
      ? await store.read('proof', reservationKey(current.owner.generation + 1)) : null;
    if (next) return workflowFailure('workflow-source5-owner-retired', 'A discoverable durable reservation retires this owner even if its CAS was lost or rejected.');
    await verifyHistory(current.owner, current.record.rawDigest);
    if (fresh) {
      await requireUnattempted();
      const latest = await inspectModernInstalledActivation(input.projectRoot);
      if (latest.status !== 'observed' || latest.binding !== current.owner.rawSnapshotDigest) {
        return workflowFailure('workflow-source5-owner-drift', 'Raw installed snapshot changed after the independently reviewed ownership reservation.');
      }
    }
  }
  async function prepare(): Promise<void> {
    await assertSource5WorkflowLease(input.lease, input.projectRoot);
    if (rawSnapshotDigest !== input.plan.baselineDigest) {
      return workflowFailure('workflow-source5-owner-drift', 'Ownership preparation requires the exact independently reviewed raw installed snapshot, not a caller-selected baseline.');
    }
    const current = await pointer();
    if (current?.owner.controlKey === inventory.control.controlKey) return assertCurrent(true);
    await requireUnattempted();
    if (!current) {
      if (lineage.length !== 1) return workflowFailure('workflow-source5-owner', 'An absent original owner is not permission for a continuation to create one.');
      if (await store.read('proof', manifestKey) ||
        await store.read('proof', confirmationKey(0)) || await store.read('proof', reservationKey(1))) {
        return workflowFailure('workflow-source5-owner', 'Partial original ownership metadata cannot recreate permission.');
      }
      await manifest(true);
      const selected = desired(0), value = { ...scope, kind: 'workflow-source5-entry-owner', owner: selected };
      await store.measure('operation', entryKey, value, source5OwnershipMaximumGeneration + 1, 'f'.repeat(64));
      await store.measure('proof', confirmationKey(0), confirmation({ rawDigest: 'f'.repeat(64) }, selected, null));
      const saved = await store.save('operation', entryKey, value, null);
      const readback = await pointer();
      if (!readback || readback.record.rawDigest !== saved.rawDigest || !same(readback.owner, selected)) {
        return workflowFailure('workflow-source5-owner', 'Initial ownership acceptance was not independently confirmed.');
      }
      await store.save('proof', confirmationKey(0), confirmation(readback.record, selected, null), null);
      return assertCurrent(true);
    }
    await manifest(false);
    if (inventory.control.remainingFrom?.planKey !== current.owner.controlKey ||
      current.owner.generation >= source5OwnershipMaximumGeneration) {
      return workflowFailure('workflow-source5-owner', 'Only the exact separately reviewed current unattempted owner can reserve a bounded continuation.');
    }
    const generation = current.owner.generation + 1;
    if (await store.read('proof', reservationKey(generation)) || await store.read('proof', confirmationKey(generation))) {
      return workflowFailure('workflow-source5-owner-retired', 'Outstanding reservation or uncertain ownership cannot be stolen or automatically compensated.');
    }
    const priorConfirmation = await store.read('proof', confirmationKey(current.owner.generation));
    if (!priorConfirmation) {
      return workflowFailure('workflow-source5-owner', 'The original current owner has no exact confirmed immutable history.');
    }
    await verifyHistory(current.owner, current.record.rawDigest);
    const selected = desired(generation);
    const receiptValue = { ...scope, kind: 'workflow-source5-owner-reservation', previousOwner: current.owner,
      previousPointerRawDigest: current.record.rawDigest, previousConfirmationRawDigest: priorConfirmation.rawDigest,
      newOwner: selected };
    await store.measure('proof', reservationKey(generation), receiptValue);
    await store.measure('operation', entryKey, { ...scope, kind: 'workflow-source5-entry-owner', owner: selected },
      source5OwnershipMaximumGeneration + 1, 'f'.repeat(64));
    await store.measure('proof', confirmationKey(generation), {
      ...scope, kind: 'workflow-source5-owner-confirmed', owner: selected, pointerRawDigest: 'f'.repeat(64),
      previousReceiptDigest: 'f'.repeat(64)
    });
    const receipt = await store.save('proof', reservationKey(generation), receiptValue, null);
    await requireUnattempted();
    const saved = await store.save('operation', entryKey, { ...scope, kind: 'workflow-source5-entry-owner', owner: selected }, current.record.rawDigest);
    const readback = await pointer();
    if (!readback || readback.record.rawDigest !== saved.rawDigest || !same(readback.owner, selected)) {
      return workflowFailure('workflow-source5-owner', 'Continuation ownership CAS/readback is unresolved; both owners stay blocked.');
    }
    await store.save('proof', confirmationKey(generation), confirmation(readback.record, selected, receipt.rawDigest), null);
    await assertCurrent(true);
  }
  return Object.freeze({ entryKey, originalPlanKey: original.control.controlKey,
    operationDigest, reservationKey, confirmationKey, prepare, assertCurrent, measureInventory,
    snapshotDigest: rawSnapshotDigest,
    inventory: captureWorkflowBinding({
      entryKey, operationNamespace: 'operation', generationLimit: source5OwnershipMaximumGeneration,
      manifestKey,
      proofKeys: Array.from({ length: source5OwnershipMaximumGeneration + 1 }, (_, generation) =>
        [confirmationKey(generation), ...(generation ? [reservationKey(generation)] : [])]).flat()
    }) });
}
