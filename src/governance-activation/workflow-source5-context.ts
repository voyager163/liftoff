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
const entryGates = new WeakMap<ProjectMutationLease, Map<string, Promise<void>>>();
const entryCarriers = new WeakMap<ProjectMutationLease, Set<string>>();
export interface Source5WorkflowEntryGate {
  readonly kind: 'source5-workflow-entry-gate';
}
const activeEntryGates = new WeakMap<Source5WorkflowEntryGate, {
  projectRoot: string; lease: ProjectMutationLease; entryKey: string;
}>();
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
    try { return await action(lease); } finally {
      leaseRoots.delete(lease);
      entryGates.delete(lease);
      entryCarriers.delete(lease);
    }
  });
}
export async function withSource5WorkflowEntryGate<T>(
  projectRoot: string, lease: ProjectMutationLease, entryKey: string,
  action: (gate: Source5WorkflowEntryGate) => Promise<T>
): Promise<T> {
  await assertSource5WorkflowLease(lease, projectRoot);
  if (!/^[a-f0-9]{64}$/u.test(entryKey)) {
    return workflowFailure('workflow-source5-entry-gate', 'Entry exclusion requires the exact stable original entry key.');
  }
  const gates = entryGates.get(lease) ?? new Map<string, Promise<void>>();
  entryGates.set(lease, gates);
  const previous = gates.get(entryKey);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  gates.set(entryKey, current);
  if (previous) await previous;
  const gate = Object.freeze({ kind: 'source5-workflow-entry-gate' as const });
  try {
    await assertSource5WorkflowLease(lease, projectRoot);
    activeEntryGates.set(gate, { projectRoot, lease, entryKey });
    return await action(gate);
  } finally {
    activeEntryGates.delete(gate);
    release();
    if (gates.get(entryKey) === current) gates.delete(entryKey);
  }
}
export async function claimSource5WorkflowEntryCarrier(gate: Source5WorkflowEntryGate): Promise<void> {
  const scope = activeEntryGates.get(gate);
  if (!scope) {
    return workflowFailure('workflow-source5-entry-gate', 'Carrier issuance requires the active engine-held exact original entry gate.');
  }
  const { projectRoot, lease, entryKey } = scope;
  await assertSource5WorkflowLease(lease, projectRoot);
  if (activeEntryGates.get(gate) !== scope) {
    return workflowFailure('workflow-source5-entry-gate', 'The original entry gate ended before carrier issuance.');
  }
  const entries = entryCarriers.get(lease) ?? new Set<string>();
  if (entries.has(entryKey)) {
    return workflowFailure('workflow-source5-effect-context', 'The held lease already issued this ORIGINAL entry; another plan cannot acquire a duplicate effect carrier.');
  }
  entries.add(entryKey);
  entryCarriers.set(lease, entries);
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
