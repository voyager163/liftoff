import { canonicalApprovalEnvelopeValues, normalizeApprovalScopeValues } from '../domain/governance/activation/source-values.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { createModernActivationRecordContract } from '../domain/governance/activation/modern-records.js';
import { modernActivationSourceContracts } from '../domain/governance/policy/identity.js';
import type { ManifestContractContext } from '../domain/project/manifest/context.js';
import type { ModernActivationSourceInput, ModernApprovalEnvelope, ModernSavedTransitionPlan } from '../domain/governance/activation/modern-record-contracts.js';
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
const leaseRoots = new WeakMap<ProjectMutationLease, string>();
export async function assertSource5WorkflowLease(lease: ProjectMutationLease, projectRoot: string): Promise<void> {
  if (leaseRoots.get(lease) !== projectRoot) {
    return workflowFailure('workflow-source5-lease', 'A structural or foreign lease is not the live engine-held native project lease.');
  }
  await lease.assertHeld();
}
export async function withSource5WorkflowLease<T>(
  projectRoot: string, action: (lease: ProjectMutationLease) => Promise<T>
): Promise<T> {
  return withProjectMutationLock(projectRoot, async lease => {
    leaseRoots.set(lease, projectRoot);
    try { return await action(lease); } finally { leaseRoots.delete(lease); }
  });
}
export function source5WorkflowOriginalPlanValue(
  projectRoot: string, plan: ModernSavedTransitionPlan, approval: ModernApprovalEnvelope
) {
  const { control } = source5WorkflowPlanInventory(plan);
  return captureWorkflowBinding({ schemaVersion: 1, projectRoot, controlKey: control.controlKey,
    identity: plan.identity, phaseId: plan.phaseId, graphHash: plan.graphHash,
    repositoryAnchor: control.repositoryAnchor, planDigest: plan.planDigest, savedPlanDigest: canonicalSha256(plan),
    previewFingerprint: source5PreviewFingerprint(projectRoot, plan), kind: 'workflow-source5-original-plan', plan, approval });
}
