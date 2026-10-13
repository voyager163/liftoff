import { canonicalApprovalEnvelopeValues, normalizeApprovalScopeValues } from '../domain/governance/activation/source-values.js';
import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { createModernActivationRecordContract } from '../domain/governance/activation/modern-records.js';
import { modernActivationSourceContracts } from '../domain/governance/policy/identity.js';
import type { ManifestContractContext } from '../domain/project/manifest/context.js';
import type {
  ModernActivationSourceInput, ModernApprovalEnvelope, ModernSavedTransitionPlan, ModernTransitionOperation
} from '../domain/governance/activation/modern-record-contracts.js';
import { createWorkflowSource5ControlStore, resolveUpdatePreviewLocation } from '../adapters/filesystem/update-previews.js';
import type { UpdatePreviewOptions } from '../adapters/filesystem/update-previews.js';
import type { ProjectMutationLease } from '../adapters/filesystem/project-lock.js';
import { withProjectMutationLock } from '../adapters/filesystem/project-lock.js';
import { captureWorkflowBinding, workflowFailure } from './workflow-binding.js';
import { source5WorkflowPlanInventory } from './workflow-source5-operations.js';

export const source5WorkflowPhases = Object.freeze([
  'bootstrap-workflow-source-ready', 'workflow-source-ready', 'dev-proof',
  'staging-qualified', 'production-rehearsed', 'green-red-proof'
] as const);
export type Source5WorkflowPhase = typeof source5WorkflowPhases[number];
export interface Source5WorkflowContext {
  readonly records: ReturnType<typeof createModernActivationRecordContract>;
}
const contexts = new WeakSet<Source5WorkflowContext>();
export function createSource5WorkflowContext(
  catalog: ManifestContractContext['catalog'], input: ModernActivationSourceInput
): Source5WorkflowContext {
  const records = createModernActivationRecordContract(catalog, input);
  const current = modernActivationSourceContracts().find(row => row.identity.phaseGraphHash === records.identity.phaseGraphHash);
  if (!current || current.identity.activationContractVersion !== 5 ||
    Object.entries(current.identity).some(([key, value]) =>
      records.identity[key as keyof typeof records.identity] !== value)) {
    return workflowFailure('workflow-source5-family', 'The private workflow bridge accepts only the exact compiled current5 family; readable history is not execution authority.');
  }
  const context = Object.freeze({ records });
  contexts.add(context);
  return context;
}
export function assertSource5WorkflowContext(context: Source5WorkflowContext): void {
  if (!contexts.has(context)) workflowFailure('workflow-source5-context', 'Workflow context must be constructed by the current5 reader; structural objects are not authority.');
}
export function source5ApprovalHash(context: Source5WorkflowContext, envelope: ModernApprovalEnvelope): string {
  assertSource5WorkflowContext(context);
  const parsed = context.records.readApproval(envelope);
  return canonicalSha256(canonicalApprovalEnvelopeValues(parsed,
    normalizeApprovalScopeValues(parsed, context.records.graph.phases.map(phase => phase.id))));
}
export function source5PreviewFingerprint(projectRoot: string, plan: ModernSavedTransitionPlan): string {
  return canonicalSha256({ kind: 'workflow-source5-review.v1', projectRoot, plan: {
    ...plan, approval: { gateKind: plan.approval.gateKind, required: plan.approval.required }
  } });
}
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
const authorities = new WeakMap<Source5WorkflowAuthority, AuthorityBinding>();
const leaseRoots = new WeakMap<ProjectMutationLease, string>();
export async function withSource5WorkflowLease<T>(
  projectRoot: string, action: (lease: ProjectMutationLease) => Promise<T>
): Promise<T> {
  return withProjectMutationLock(projectRoot, async lease => {
    leaseRoots.set(lease, projectRoot);
    try { return await action(lease); } finally { leaseRoots.delete(lease); }
  });
}
function authorityValue(binding: AuthorityBinding) {
  const { context, plan, approval, previewFingerprint, projectRoot, repositoryAnchor } = binding;
  return captureWorkflowBinding({
    schemaVersion: 1, kind: 'liftoff-source5-workflow-approval', projectRoot, repositoryAnchor,
    identity: context.records.identity, phaseId: plan.phaseId, graphHash: plan.graphHash,
    previewFingerprint, envelopeHash: source5ApprovalHash(context, approval), envelope: approval,
    operationDigests: plan.operations.map(operation => canonicalSha256(operation)),
    savedPlanDigest: canonicalSha256(plan), planDigest: plan.planDigest
  });
}
function validateBinding(binding: AuthorityBinding, now: Date, write: boolean): void {
  assertSource5WorkflowContext(binding.context);
  const { plan, approval, context } = binding;
  context.records.readPlan(plan, { approvals: [approval] });
  source5WorkflowPlanInventory(plan);
  if (!source5WorkflowPhases.includes(plan.phaseId as Source5WorkflowPhase) || plan.scope !== 'activation' ||
    !plan.approval.required || plan.approval.evaluation.status !== 'reused' ||
    plan.approval.envelopeId !== approval.id || plan.approval.envelopeHash !== source5ApprovalHash(context, approval) ||
    !/^[a-f0-9]{64}$/u.test(binding.previewFingerprint) ||
    binding.previewFingerprint !== source5PreviewFingerprint(binding.projectRoot, plan) ||
    !/^local:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(binding.repositoryAnchor) ||
    leaseRoots.get(binding.lease) !== binding.projectRoot ||
    !Number.isFinite(now.getTime()) || Date.parse(approval.approvedAt) > now.getTime() ||
    write && (Date.parse(plan.expiresAt) <= now.getTime() || Date.parse(approval.expiresAt) <= now.getTime())) {
    workflowFailure('workflow-source5-approval', 'Workflow effects require exact original current5 plan and independently issued unexpired approval; recorded observation never refreshes write authority.');
  }
}

export async function issueSource5WorkflowApproval(
  binding: AuthorityBinding, now: Date
): Promise<void> {
  validateBinding(binding, now, true);
  await binding.lease.assertHeld();
  const location = await resolveUpdatePreviewLocation(binding.projectRoot, binding.storage);
  if (location.projectRoot !== binding.projectRoot) workflowFailure('workflow-source5-root', 'Authority requires the exact canonical project root.');
  const value = authorityValue(binding);
  await createWorkflowSource5ControlStore(binding.projectRoot, binding.storage)
    .save('approval', canonicalSha256(value), value, null);
}

export async function restoreSource5WorkflowAuthority(
  binding: AuthorityBinding, now: Date
): Promise<Source5WorkflowAuthority> {
  validateBinding(binding, now, false);
  await binding.lease.assertHeld();
  const value = authorityValue(binding);
  const stored = await createWorkflowSource5ControlStore(binding.projectRoot, binding.storage).read('approval', canonicalSha256(value));
  if (!stored || stored.projectRoot !== binding.projectRoot || !isRecord(stored.value) ||
    canonicalSha256(stored.value) !== canonicalSha256(value)) {
    return workflowFailure('workflow-source5-unissued', 'The original workflow approval has no exact sealed project-local issuance; imported envelopes are not permission.');
  }
  const token = Object.freeze({ kind: 'source5-workflow-issued-authority' as const });
  authorities.set(token, { ...binding, plan: captureWorkflowBinding(binding.plan), approval: captureWorkflowBinding(binding.approval) });
  return token;
}

export async function assertSource5WorkflowAuthority(input: {
  authority: Source5WorkflowAuthority; plan: ModernSavedTransitionPlan;
  operation: ModernTransitionOperation; projectRoot: string; now: Date; write: boolean;
}): Promise<void> {
  const binding = authorities.get(input.authority);
  if (!binding || binding.projectRoot !== input.projectRoot ||
    canonicalSha256(input.plan) !== canonicalSha256(binding.plan) ||
    input.operation.phaseId !== binding.plan.phaseId ||
    binding.plan.operations.filter(operation => canonicalSha256(operation) === canonicalSha256(input.operation)).length !== 1) {
    return workflowFailure('workflow-source5-authority', 'Workflow capability is not the engine-issued exact root/plan/operation authority.');
  }
  validateBinding(binding, input.now, input.write);
  await binding.lease.assertHeld();
  const phase = binding.context.records.graph.phases.find(phase => phase.id === binding.plan.phaseId)!;
  if ([input.operation, ...(input.operation.effects ?? [])].some(effect =>
    !phase.allowedMutations[effect.remote ? 'remote' : 'local'].includes(effect.mutationClass))) {
    return workflowFailure('workflow-source5-mutation', 'The exact effect is outside the unchanged current5 phase mutation inventory.');
  }
  const value = authorityValue(binding);
  const stored = await createWorkflowSource5ControlStore(binding.projectRoot, binding.storage).read('approval', canonicalSha256(value));
  if (!stored || canonicalSha256(stored.value) !== canonicalSha256(value)) {
    workflowFailure('workflow-source5-unissued', 'Original workflow issuance changed or disappeared; no effect or authority refresh is permitted.');
  }
}
