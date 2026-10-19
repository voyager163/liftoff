import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import type {
  ModernApprovalEnvelope, ModernSavedTransitionPlan, ModernTransitionOperation
} from '../domain/governance/activation/modern-record-contracts.js';
import { createWorkflowSource5ControlStore, resolveUpdatePreviewLocation } from '../adapters/filesystem/update-previews.js';
import type { UpdatePreviewOptions } from '../adapters/filesystem/update-previews.js';
import type { ProjectMutationLease } from '../adapters/filesystem/project-lock.js';
import { captureWorkflowBinding, workflowFailure } from './workflow-binding.js';
import { source5WorkflowPlanInventory } from './workflow-source5-operations.js';
import { inspectModernInstalledActivation } from '../application/governance/modern-installed-preflight.js';
import { source5WorkflowOwnership } from './workflow-source5-ownership.js';
import {
  assertSource5WorkflowContext, assertSource5WorkflowLease, source5ApprovalHash, source5PreviewFingerprint,
  source5WorkflowOriginalPlanValue, source5WorkflowPhases
} from './workflow-source5-context.js';
import type { Source5WorkflowContext, Source5WorkflowPhase } from './workflow-source5-context.js';
export {
  assertSource5WorkflowContext, assertSource5WorkflowLease, createSource5WorkflowContext, source5ApprovalHash,
  source5PreviewFingerprint, source5WorkflowOriginalPlanValue, source5WorkflowPhases, withSource5WorkflowLease
} from './workflow-source5-context.js';
export type { Source5WorkflowContext, Source5WorkflowPhase } from './workflow-source5-context.js';
export interface Source5WorkflowAuthority {
  readonly kind: 'source5-workflow-issued-authority';
}
interface AuthorityBinding {
  context: Source5WorkflowContext;
  projectRoot: string;
  repositoryAnchor: string;
  plan: ModernSavedTransitionPlan;
  approval: ModernApprovalEnvelope;
  previewFingerprint: string;
  lease: ProjectMutationLease;
  storage?: UpdatePreviewOptions;
}
const authorities = new WeakMap<Source5WorkflowAuthority, AuthorityBinding & {
  owners: ReadonlyMap<string, Awaited<ReturnType<typeof source5WorkflowOwnership>>>;
  savedPlanDigest: string;
  operationDigestCounts: ReadonlyMap<string, number>;
  approvalValueDigest: string;
}>();
export function source5WorkflowAuthorityValue(binding: AuthorityBinding) {
  const { context, plan, approval, previewFingerprint, projectRoot, repositoryAnchor } = binding;
  return captureWorkflowBinding({
    schemaVersion: 1, kind: 'liftoff-source5-workflow-approval', projectRoot, repositoryAnchor,
    identity: context.records.identity, phaseId: plan.phaseId, graphHash: plan.graphHash,
    previewFingerprint, envelopeHash: source5ApprovalHash(context, approval), envelope: approval,
    operationDigests: plan.operations.map(operation => canonicalSha256(operation)),
    savedPlanDigest: canonicalSha256(plan), planDigest: plan.planDigest
  });
}
async function ownersFor(binding: AuthorityBinding, prepare: boolean) {
  const owners = new Map<string, Awaited<ReturnType<typeof source5WorkflowOwnership>>>();
  for (const operation of source5WorkflowPlanInventory(binding.plan).effects) {
    const owner = await source5WorkflowOwnership({ ...binding, operation });
    if (prepare) await owner.prepare(); else await owner.assertCurrent(false);
    owners.set(canonicalSha256(operation), owner);
  }
  return owners;
}
function validateBinding(binding: AuthorityBinding, now: Date, write: boolean): void {
  assertSource5WorkflowContext(binding.context);
  const { plan, approval, context } = binding;
  context.records.readPlan(plan, { approvals: [approval] });
  const { control } = source5WorkflowPlanInventory(plan);
  if (!source5WorkflowPhases.includes(plan.phaseId as Source5WorkflowPhase) || plan.scope !== 'activation' ||
    !plan.approval.required || plan.approval.evaluation.status !== 'reused' ||
    approval.id !== `source5-${control.controlKey}` ||
    plan.approval.envelopeId !== approval.id || plan.approval.envelopeHash !== source5ApprovalHash(context, approval) ||
    !/^[a-f0-9]{64}$/u.test(binding.previewFingerprint) ||
    binding.previewFingerprint !== source5PreviewFingerprint(binding.projectRoot, plan) ||
    control.repositoryAnchor !== binding.repositoryAnchor ||
    !/^local:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(binding.repositoryAnchor) ||
    !Number.isFinite(now.getTime()) || Date.parse(approval.approvedAt) > now.getTime() ||
    write && (Date.parse(plan.expiresAt) <= now.getTime() || Date.parse(approval.expiresAt) <= now.getTime())) {
    workflowFailure('workflow-source5-approval', 'Workflow effects require exact original current5 plan and independently issued unexpired approval; recorded observation never refreshes write authority.');
  }
}
async function assertObservedAuthorityScope(binding: AuthorityBinding): Promise<void> {
  await assertSource5WorkflowLease(binding.lease, binding.projectRoot);
  const location = await resolveUpdatePreviewLocation(binding.projectRoot, binding.storage);
  const observed = await inspectModernInstalledActivation(binding.projectRoot);
  const { control } = source5WorkflowPlanInventory(binding.plan);
  if (location.projectRoot !== binding.projectRoot || control.projectKey !== location.projectKey ||
    observed.status !== 'observed' || observed.snapshot.root !== location.projectRoot || !observed.current ||
    observed.current.state.repository.id !== binding.repositoryAnchor ||
    observed.current.state.repository.id !== control.repositoryAnchor ||
    canonicalSha256(observed.current.state) !== binding.plan.stateHash ||
    canonicalSha256(observed.current.state.identity) !== canonicalSha256(binding.context.records.identity)) {
    workflowFailure('workflow-source5-scope', 'Workflow authority requires independently read existing current5 state with the exact canonical root, project key, state digest and original local repository anchor. Missing or changed state cannot create or refresh permission.');
  }
}

export async function issueSource5WorkflowApproval(
  binding: AuthorityBinding, now: Date
): Promise<void> {
  binding = { ...binding, plan: captureWorkflowBinding(binding.plan), approval: captureWorkflowBinding(binding.approval) };
  validateBinding(binding, now, true);
  await assertObservedAuthorityScope(binding);
  const store = createWorkflowSource5ControlStore(binding.projectRoot, binding.storage);
  const { control } = source5WorkflowPlanInventory(binding.plan);
  const original = source5WorkflowOriginalPlanValue(binding.projectRoot, binding.plan, binding.approval);
  await store.measure('plan', control.controlKey, original);
  const previous = await store.read('plan', control.controlKey);
  if (!previous || canonicalSha256(previous.value) !== canonicalSha256(original)) {
    return workflowFailure('workflow-source5-original', 'The separately reviewed original plan must already be independently sealed and exact; issuance cannot create or recreate missing plan history.');
  }
  await ownersFor(binding, true);
  const value = source5WorkflowAuthorityValue(binding);
  await store.save('approval', canonicalSha256(value), value, null);
}

export async function restoreSource5WorkflowAuthority(
  binding: AuthorityBinding, now: Date
): Promise<Source5WorkflowAuthority> {
  binding = { ...binding, plan: captureWorkflowBinding(binding.plan), approval: captureWorkflowBinding(binding.approval) };
  validateBinding(binding, now, false);
  await assertObservedAuthorityScope(binding);
  const value = source5WorkflowAuthorityValue(binding);
  const approvalValueDigest = canonicalSha256(value);
  const stored = await createWorkflowSource5ControlStore(binding.projectRoot, binding.storage).read('approval', approvalValueDigest);
  if (!stored || stored.projectRoot !== binding.projectRoot || !isRecord(stored.value) ||
    canonicalSha256(stored.value) !== approvalValueDigest) {
    return workflowFailure('workflow-source5-unissued', 'The original workflow approval has no exact sealed project-local issuance; imported envelopes are not permission.');
  }
  const owners = await ownersFor(binding, false);
  const operationDigestCounts = new Map<string, number>();
  for (const digest of value.operationDigests) {
    operationDigestCounts.set(digest, (operationDigestCounts.get(digest) ?? 0) + 1);
  }
  const token = Object.freeze({ kind: 'source5-workflow-issued-authority' as const });
  authorities.set(token, { ...binding, owners, savedPlanDigest: value.savedPlanDigest,
    operationDigestCounts, approvalValueDigest });
  return token;
}

export async function assertSource5WorkflowAuthority(input: {
  authority: Source5WorkflowAuthority; plan: ModernSavedTransitionPlan;
  operation: ModernTransitionOperation; projectRoot: string; now: Date; write: boolean; lease?: ProjectMutationLease;
  clock?: () => Date;
}): Promise<void> {
  const binding = authorities.get(input.authority);
  if (!binding || binding.projectRoot !== input.projectRoot || input.lease !== undefined && input.lease !== binding.lease ||
    canonicalSha256(input.plan) !== binding.savedPlanDigest ||
    input.operation.phaseId !== binding.plan.phaseId ||
    binding.operationDigestCounts.get(canonicalSha256(input.operation)) !== 1) {
    return workflowFailure('workflow-source5-authority', 'Workflow capability is not the engine-issued exact root/plan/operation authority.');
  }
  validateBinding(binding, input.now, input.write);
  await assertObservedAuthorityScope(binding);
  const selected = binding.owners.get(canonicalSha256(input.operation));
  if (selected) await selected.assertCurrent(false);
  else if (!input.write && binding.plan.phaseId === 'green-red-proof') {
    const owners = [...binding.owners.values()];
    for (let start = 0; start < owners.length; start += 4) {
      const observations = await Promise.allSettled(owners.slice(start, start + 4)
        .map(owner => owner.assertCurrent(false)));
      for (const observation of observations) {
        if (observation.status === 'rejected') throw observation.reason;
      }
    }
  }
  else for (const owner of binding.owners.values()) await owner.assertCurrent(false);
  const phase = binding.context.records.graph.phases.find(phase => phase.id === binding.plan.phaseId)!;
  if ([input.operation, ...(input.operation.effects ?? [])].some(effect =>
    !phase.allowedMutations[effect.remote ? 'remote' : 'local'].includes(effect.mutationClass))) {
    return workflowFailure('workflow-source5-mutation', 'The exact effect is outside the unchanged current5 phase mutation inventory.');
  }
  const stored = await createWorkflowSource5ControlStore(binding.projectRoot, binding.storage).read('approval', binding.approvalValueDigest);
  if (!stored || canonicalSha256(stored.value) !== binding.approvalValueDigest) {
    workflowFailure('workflow-source5-unissued', 'Original workflow issuance changed or disappeared; no effect or authority refresh is permitted.');
  }
  validateBinding(binding, input.clock?.() ?? input.now, input.write);
}

export interface Source5WorkflowEntryAuthorityInput {
  authority: Source5WorkflowAuthority; projectRoot: string; plan: ModernSavedTransitionPlan;
  operation: ModernTransitionOperation; lease: ProjectMutationLease; firstIntent: boolean;
}
function entryOwner(input: Source5WorkflowEntryAuthorityInput) {
  const binding = authorities.get(input.authority);
  const owner = binding?.owners.get(canonicalSha256(input.operation));
  if (!binding || !owner || binding.projectRoot !== input.projectRoot || binding.lease !== input.lease ||
    canonicalSha256(binding.plan) !== canonicalSha256(input.plan)) {
    return workflowFailure('workflow-source5-owner', 'Only the original engine-issued exact entry authority can inspect or persist its ownership-bound progress.');
  }
  return owner;
}
export async function readSource5WorkflowEntryKey(input: Source5WorkflowEntryAuthorityInput): Promise<string> {
  const owner = entryOwner(input);
  await owner.assertCurrent(input.firstIntent);
  return owner.entryKey;
}
export async function assertSource5WorkflowEntryOwnership(input: Source5WorkflowEntryAuthorityInput): Promise<void> {
  // Acceptance/terminal writes retain original truth even when a later installed-state read would fail.
  await entryOwner(input).assertCurrent(input.firstIntent);
}
