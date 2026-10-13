import { createWorkflowSource5ControlStore, resolveUpdatePreviewLocation } from '../adapters/filesystem/update-previews.js';
import type { WorkflowSource5StoredControl } from '../adapters/filesystem/update-previews.js';
import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { captureWorkflowBinding, workflowFailure } from './workflow-binding.js';
import {
  assertSource5WorkflowContext, assertSource5WorkflowLease, source5WorkflowOriginalPlanValue, source5ApprovalHash
} from './workflow-source5-context.js';
import { source5WorkflowPlanInventory } from './workflow-source5-operations.js';
import type { Source5WorkflowOwnershipInput } from './workflow-source5-ownership.js';

export const source5OwnershipMaximumGeneration = 64;
const same = (left: unknown, right: unknown) => canonicalSha256(left) === canonicalSha256(right);

export async function describeSource5WorkflowOwnership(input: Source5WorkflowOwnershipInput) {
  input = { ...input, plan: captureWorkflowBinding(input.plan), approval: captureWorkflowBinding(input.approval),
    operation: captureWorkflowBinding(input.operation) };
  assertSource5WorkflowContext(input.context);
  await assertSource5WorkflowLease(input.lease, input.projectRoot);
  input.context.records.readPlan(input.plan, { approvals: [input.approval] });
  const inventory = source5WorkflowPlanInventory(input.plan), operationDigest = canonicalSha256(input.operation);
  const location = await resolveUpdatePreviewLocation(input.projectRoot, input.storage);
  if (location.projectRoot !== input.projectRoot || inventory.control.projectKey !== location.projectKey ||
    !inventory.effects.some(operation => same(operation, input.operation))) {
    return workflowFailure('workflow-source5-owner', 'Descriptive ownership inventory requires the exact canonical root, project key and original indexed entry.');
  }
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
  const scope = { schemaVersion: 1, projectRoot: input.projectRoot, projectKey: location.projectKey,
    repositoryAnchor: inventory.control.repositoryAnchor, identity: input.plan.identity, phaseId: input.plan.phaseId,
    originalPlanKey: lineage.at(-1)!.control.controlKey, operationDigest };
  const entryKey = canonicalSha256({ kind: 'workflow-source5-original-entry-key.v1', ...scope });
  const generationKey = (kind: 'reservation' | 'confirmation', generation: number) =>
    canonicalSha256({ kind: `workflow-source5-owner-${kind}-key.v1`, entryKey, generation });
  const manifestKey = canonicalSha256({ kind: 'workflow-source5-owner-manifest-key.v1', entryKey });
  const maximum = { generation: source5OwnershipMaximumGeneration, controlKey: 'f'.repeat(64),
    planDigest: 'f'.repeat(64), savedPlanDigest: 'f'.repeat(64), approvalHash: 'f'.repeat(64), rawSnapshotDigest: 'f'.repeat(64) };
  const operationBytes = await store.measure('operation', entryKey,
    { ...scope, kind: 'workflow-source5-entry-owner', owner: maximum }, source5OwnershipMaximumGeneration + 1, 'f'.repeat(64));
  const confirmationBytes = await store.measure('proof', generationKey('confirmation', maximum.generation),
    { ...scope, kind: 'workflow-source5-owner-confirmed', owner: maximum,
      pointerRawDigest: 'f'.repeat(64), previousReceiptDigest: 'f'.repeat(64) });
  const receiptBytes = await store.measure('proof', generationKey('reservation', maximum.generation),
    { ...scope, kind: 'workflow-source5-owner-reservation', previousOwner: maximum,
      previousPointerRawDigest: 'f'.repeat(64), previousConfirmationRawDigest: 'f'.repeat(64), newOwner: maximum });
  const objects = [
    { namespace: 'operation', key: entryKey, maximumEncodedBytes: operationBytes, maximumRevisions: source5OwnershipMaximumGeneration + 1 },
    ...Array.from({ length: source5OwnershipMaximumGeneration + 1 }, (_, generation) => [
      { namespace: 'proof', key: generationKey('confirmation', generation), maximumEncodedBytes: confirmationBytes, maximumRevisions: 1 },
      ...(generation ? [{ namespace: 'proof', key: generationKey('reservation', generation), maximumEncodedBytes: receiptBytes, maximumRevisions: 1 }] : [])
    ]).flat()
  ];
  const self = { namespace: 'proof', key: manifestKey, maximumEncodedBytes: 0, maximumRevisions: 1 };
  objects.push(self);
  const measured = { ...scope, kind: 'workflow-source5-owner-manifest', entryKey,
    generationLimit: source5OwnershipMaximumGeneration, objects, maximumEncodedFootprint: 0 };
  for (let attempt = 0; ; attempt++) {
    measured.maximumEncodedFootprint = objects.reduce((total, object) =>
      total + object.maximumEncodedBytes * object.maximumRevisions, 0);
    const bytes = await store.measure('proof', manifestKey, measured);
    if (bytes === self.maximumEncodedBytes) break;
    if (attempt === 8) return workflowFailure('workflow-source5-owner', 'Complete sealed ownership inventory cannot be represented within its fixed bound.');
    self.maximumEncodedBytes = bytes;
  }
  await assertSource5WorkflowLease(input.lease, input.projectRoot);
  return Object.freeze({ scope: captureWorkflowBinding(scope), entryKey,
    lineage: Object.freeze(lineage.map(entry => Object.freeze(entry))), inventory: captureWorkflowBinding(measured) });
}

export async function readSource5WorkflowOwnershipHistory(input: Source5WorkflowOwnershipInput) {
  const description = await describeSource5WorkflowOwnership(input);
  const { scope, entryKey, inventory, lineage } = description;
  const store = createWorkflowSource5ControlStore(input.projectRoot, input.storage);
  const retained: { namespace: string; key: string; record: WorkflowSource5StoredControl }[] = [];
  for (const object of inventory.objects) {
    const record = await store.read(object.namespace === 'operation' ? 'operation' : 'proof', object.key);
    if (!record) continue;
    if (record.encodedBytes > object.maximumEncodedBytes || record.revision > object.maximumRevisions ||
      object.maximumRevisions === 1 && (record.revision !== 1 || record.previousDigest !== null)) {
      return workflowFailure('workflow-source5-owner', 'Retained ownership history exceeds its original sealed byte/revision inventory.');
    }
    retained.push({ namespace: object.namespace, key: object.key, record });
  }
  const pointer = retained.find(entry => entry.key === entryKey)?.record;
  const manifestKey = canonicalSha256({ kind: 'workflow-source5-owner-manifest-key.v1', entryKey });
  const manifest = retained.find(entry => entry.key === manifestKey)?.record;
  if (!pointer || !manifest || !same(manifest.value, inventory) || !isRecord(pointer.value) ||
    !isRecord(pointer.value.owner) || !Number.isSafeInteger(pointer.value.owner.generation) ||
    typeof pointer.value.owner.generation !== 'number') {
    return workflowFailure('workflow-source5-owner', 'Exact original ownership pointer and full manifest must remain independently sealed.');
  }
  const generation = pointer.value.owner.generation;
  if (generation < 0 || generation > source5OwnershipMaximumGeneration || pointer.revision !== generation + 1 ||
    pointer.value.owner.controlKey !== source5WorkflowPlanInventory(input.plan).control.controlKey) {
    return workflowFailure('workflow-source5-owner', 'Terminal bookkeeping cannot transfer, retag or adopt a foreign original owner.');
  }
  const generationKey = (kind: 'reservation' | 'confirmation', selected: number) =>
    canonicalSha256({ kind: `workflow-source5-owner-${kind}-key.v1`, entryKey, generation: selected });
  const retainedKey = (key: string) => retained.find(entry => entry.key === key)?.record;
  let selected = pointer.value.owner, pointerDigest = pointer.rawDigest;
  const allowedKeys = new Set([entryKey, manifestKey]);
  for (let current = generation; current >= 0; current--) {
    const reviewed = lineage.find(entry => entry.control.controlKey === selected.controlKey);
    if (!reviewed || selected.generation !== current ||
      !same(Object.keys(selected).sort(),
        ['generation', 'controlKey', 'planDigest', 'savedPlanDigest', 'approvalHash', 'rawSnapshotDigest'].sort()) ||
      selected.planDigest !== reviewed.plan.planDigest || selected.savedPlanDigest !== canonicalSha256(reviewed.plan) ||
      selected.approvalHash !== source5ApprovalHash(input.context, reviewed.approval) ||
      selected.rawSnapshotDigest !== reviewed.plan.baselineDigest) {
      return workflowFailure('workflow-source5-owner', 'Original ownership lineage no longer retains its exact reviewed plan, approval and raw baseline.');
    }
    const confirmationKey = generationKey('confirmation', current);
    allowedKeys.add(confirmationKey);
    const confirmation = retainedKey(confirmationKey);
    const reservationKey = generationKey('reservation', current);
    const reservation = current ? retainedKey(reservationKey) : null;
    const previousDigest = reservation && isRecord(reservation.value) ? reservation.value.previousPointerRawDigest : null;
    if (current && (typeof previousDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(previousDigest)) ||
      await store.digest('operation', entryKey,
        { ...scope, kind: 'workflow-source5-entry-owner', owner: selected }, current + 1,
        typeof previousDigest === 'string' ? previousDigest : null) !== pointerDigest ||
      !confirmation || !same(confirmation.value, { ...scope, kind: 'workflow-source5-owner-confirmed',
        owner: selected, pointerRawDigest: pointerDigest, previousReceiptDigest: reservation?.rawDigest ?? null }) ||
      current === generation && pointer.previousDigest !== previousDigest) {
      return workflowFailure('workflow-source5-owner', 'Original ownership predecessor, revision or immutable confirmation is missing or contradictory.');
    }
    if (current) {
      allowedKeys.add(reservationKey);
      if (!reservation || !isRecord(reservation.value) || !isRecord(reservation.value.previousOwner) ||
        !same(reservation.value, { ...scope, kind: 'workflow-source5-owner-reservation',
          previousOwner: reservation.value.previousOwner, previousPointerRawDigest: previousDigest,
          previousConfirmationRawDigest: retainedKey(generationKey('confirmation', current - 1))?.rawDigest,
          newOwner: selected })) {
        return workflowFailure('workflow-source5-owner', 'Original ownership reservation or immutable predecessor confirmation is missing or changed.');
      }
      selected = reservation.value.previousOwner;
      pointerDigest = String(previousDigest);
    }
  }
  const pendingKey = generationKey('reservation', generation + 1);
  const pending = generation < source5OwnershipMaximumGeneration ? retainedKey(pendingKey) : null;
  const pendingPlans: WorkflowSource5StoredControl[] = [];
  if (pending) {
    allowedKeys.add(pendingKey);
    if (!isRecord(pending.value) || !isRecord(pending.value.newOwner) ||
      pending.value.newOwner.generation !== generation + 1 ||
      !same(Object.keys(pending.value.newOwner).sort(),
        ['generation', 'controlKey', 'planDigest', 'savedPlanDigest', 'approvalHash', 'rawSnapshotDigest'].sort()) ||
      typeof pending.value.newOwner.controlKey !== 'string' || !/^[a-f0-9]{64}$/u.test(pending.value.newOwner.controlKey) ||
      !same(pending.value, { ...scope, kind: 'workflow-source5-owner-reservation',
        previousOwner: pointer.value.owner, previousPointerRawDigest: pointer.rawDigest,
        previousConfirmationRawDigest: retainedKey(generationKey('confirmation', generation))?.rawDigest,
        newOwner: pending.value.newOwner })) {
      return workflowFailure('workflow-source5-owner', 'A retained retiring reservation must still bind its exact original pointer and confirmation.');
    }
    const next = await store.read('plan', pending.value.newOwner.controlKey);
    if (!next || next.revision !== 1 || next.previousDigest !== null || !isRecord(next.value)) {
      return workflowFailure('workflow-source5-owner', 'A retiring reservation cannot survive missing or retagged independently sealed continuation history.');
    }
    const approval = input.context.records.readApproval(next.value.approval);
    const plan = input.context.records.readPlan(next.value.plan, { approvals: [approval] });
    const candidate = source5WorkflowPlanInventory(plan);
    if (!same(next.value, source5WorkflowOriginalPlanValue(input.projectRoot, plan, approval)) ||
      candidate.control.remainingFrom?.planKey !== pointer.value.owner.controlKey ||
      candidate.control.controlKey !== pending.value.newOwner.controlKey ||
      candidate.control.projectKey !== scope.projectKey || candidate.control.repositoryAnchor !== scope.repositoryAnchor ||
      plan.phaseId !== scope.phaseId || !same(plan.identity, scope.identity) || plan.stateHash !== input.plan.stateHash ||
      !same(candidate.control.origin, source5WorkflowPlanInventory(input.plan).control.origin) ||
      !same(candidate.control.remainingFrom.operationDigests.slice().sort(),
        candidate.effects.map(operation => canonicalSha256(operation)).sort()) ||
      !candidate.effects.some(operation => canonicalSha256(operation) === scope.operationDigest) ||
      !same(pending.value.newOwner, { generation: generation + 1, controlKey: candidate.control.controlKey,
        planDigest: plan.planDigest, savedPlanDigest: canonicalSha256(plan),
        approvalHash: source5ApprovalHash(input.context, approval), rawSnapshotDigest: plan.baselineDigest })) {
      return workflowFailure('workflow-source5-owner', 'The retiring reservation differs from its exact separately reviewed unstarted continuation.');
    }
    pendingPlans.push(next);
  }
  if (retained.some(entry => !allowedKeys.has(entry.key))) {
    return workflowFailure('workflow-source5-owner', 'Unexplained ownership generations cannot be adopted during terminal bookkeeping.');
  }
  await assertSource5WorkflowLease(input.lease, input.projectRoot);
  const immutableRecord = (record: WorkflowSource5StoredControl) =>
    Object.freeze({ ...record, value: captureWorkflowBinding(record.value) });
  return Object.freeze({ description,
    retained: Object.freeze(retained.map(entry => Object.freeze({ ...entry, record: immutableRecord(entry.record) }))),
    pendingPlans: Object.freeze(pendingPlans.map(immutableRecord)) });
}
