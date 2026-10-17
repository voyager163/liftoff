import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import type { ModernSavedTransitionPlan, ModernTransitionOperation } from '../domain/governance/activation/modern-record-contracts.js';
import type { TransitionOperation } from '../domain/governance/activation/types.js';
import { workflowPlannedOperation } from './workflow-operations.js';
import { captureWorkflowBinding, workflowFailure } from './workflow-binding.js';
import type { Source5WorkflowPhase } from './workflow-source5-authority.js';

export const source5WorkflowActions = Object.freeze({
  'bootstrap-workflow-source-ready': ['git.workflow-source.publish-reviewed', 'github.workflow-source.bind-execution-ref', 'github.workflow-source.admit-reviewed'],
  'workflow-source-ready': ['git.workflow-source.publish-reviewed', 'github.workflow-source.bind-execution-ref', 'github.workflow-source.admit-reviewed'],
  'dev-proof': ['github.checks.dev-proof'],
  'staging-qualified': ['github.checks.staging'],
  'production-rehearsed': ['github.checks.production-rehearsal'],
  'green-red-proof': ['github.checks.green-red-proof']
} as const);
export type Source5WorkflowAction = typeof source5WorkflowActions[Source5WorkflowPhase][number];
export const source5MaximumEffectEntries = 272;
export function source5WorkflowLogicalEntries(operations: readonly ModernTransitionOperation[]): number {
  const entries = operations.reduce((total, operation) => total + 1 + (operation.effects?.length ?? 0), 0);
  if (entries > source5MaximumEffectEntries) {
    return workflowFailure('workflow-source5-inventory', 'The complete logical operation and nested-effect inventory exceeds 272 entries.');
  }
  return entries;
}
export function source5WorkflowOperation(
  phaseId: Source5WorkflowPhase, base: Source5WorkflowAction, binding: unknown
): TransitionOperation & { readonly phaseId: Source5WorkflowPhase } {
  if (!(source5WorkflowActions[phaseId] as readonly string[] | undefined)?.includes(base)) {
    return workflowFailure('workflow-source5-action', 'The indexed workflow base is not permitted in this exact phase; proof phases cannot create refs or admit groups.');
  }
  const captured = captureWorkflowBinding(binding);
  const operation = workflowPlannedOperation(phaseId, base, captured);
  return captureWorkflowBinding({ ...operation, phaseId, actionId: `${base}:${canonicalSha256(captured)}` });
}
export interface Source5WorkflowOrigin {
  readonly planKey: string;
  readonly proofKey: string;
  readonly publicationDigest: string;
  readonly commitSha: string;
  readonly treeSha: string;
}
export interface Source5WorkflowControlBinding {
  readonly schemaVersion: 1;
  readonly kind: 'workflow-source5-control.v1';
  readonly executionId: string;
  readonly repositoryAnchor: string;
  readonly projectKey: string;
  readonly phaseId: Source5WorkflowPhase;
  readonly reviewKind: 'publication' | 'bound-source' | 'remaining-only';
  readonly controlKey: string;
  readonly origin: Source5WorkflowOrigin | null;
  readonly remainingFrom: { readonly planKey: string; readonly operationDigests: readonly string[] } | null;
}
function controlShape(value: unknown): value is Source5WorkflowControlBinding {
  const hex = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
  const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
  const origin = isRecord(value) ? value.origin : undefined;
  const remaining = isRecord(value) ? value.remainingFrom : undefined;
  return isRecord(value) && value.schemaVersion === 1 && value.kind === 'workflow-source5-control.v1' &&
    typeof value.phaseId === 'string' && Object.hasOwn(source5WorkflowActions, value.phaseId) &&
    typeof value.executionId === 'string' && typeof value.repositoryAnchor === 'string' &&
    typeof value.projectKey === 'string' && typeof value.controlKey === 'string' &&
    ['publication', 'bound-source', 'remaining-only'].includes(String(value.reviewKind)) &&
    (origin === null || isRecord(origin) && hex(origin.planKey) && hex(origin.proofKey) &&
      hex(origin.publicationDigest) && sha(origin.commitSha) && sha(origin.treeSha)) &&
    (remaining === null || isRecord(remaining) &&
      canonicalSha256(Object.keys(remaining).sort()) === canonicalSha256(['operationDigests', 'planKey']) &&
      hex(remaining.planKey) && Array.isArray(remaining.operationDigests) && remaining.operationDigests.every(hex));
}
export function source5WorkflowControlKey(input: Pick<Source5WorkflowControlBinding, 'projectKey' | 'repositoryAnchor' | 'phaseId' | 'executionId'>): string {
  return canonicalSha256({ kind: 'workflow-source5-journal-key.v1', ...input });
}
export function source5WorkflowCheckpointOperation(request: Source5WorkflowControlBinding): ModernTransitionOperation {
  const binding = captureWorkflowBinding(request);
  const keys = ['schemaVersion', 'kind', 'executionId', 'repositoryAnchor', 'projectKey', 'phaseId', 'reviewKind', 'controlKey', 'origin', 'remainingFrom'];
  if (!controlShape(binding) || canonicalSha256(Object.keys(binding).sort()) !== canonicalSha256(keys.sort()) ||
    binding.schemaVersion !== 1 || binding.kind !== 'workflow-source5-control.v1' ||
    !Object.hasOwn(source5WorkflowActions, binding.phaseId) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(binding.executionId) ||
    !/^local:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(binding.repositoryAnchor) ||
    !/^[a-f0-9]{64}$/u.test(binding.projectKey) ||
    binding.controlKey !== source5WorkflowControlKey({ executionId: binding.executionId, repositoryAnchor: binding.repositoryAnchor,
      projectKey: binding.projectKey, phaseId: binding.phaseId }) ||
    !['publication', 'bound-source', 'remaining-only'].includes(binding.reviewKind)) {
    return workflowFailure('workflow-source5-control', 'Workflow checkpoint authority must name one exact closed project/phase/execution control key, without self-digest slots or arbitrary directories.');
  }
  if (binding.origin !== null && (
    canonicalSha256(Object.keys(binding.origin).sort()) !== canonicalSha256(['planKey', 'proofKey', 'publicationDigest', 'commitSha', 'treeSha'].sort()) ||
    [binding.origin.planKey, binding.origin.proofKey, binding.origin.publicationDigest].some(value => !/^[a-f0-9]{64}$/u.test(value)) ||
    [binding.origin.commitSha, binding.origin.treeSha].some(value => !/^[a-f0-9]{40}$/u.test(value)))) {
    return workflowFailure('workflow-source5-origin', 'A separately reviewed source binding needs exact original publication/plan/commit/tree references; future SHA slots are prohibited.');
  }
  if (binding.reviewKind === 'publication' && binding.origin !== null ||
    binding.reviewKind === 'bound-source' && binding.origin === null ||
    binding.reviewKind === 'remaining-only' && (!binding.remainingFrom ||
      !/^[a-f0-9]{64}$/u.test(binding.remainingFrom.planKey) ||
      !binding.remainingFrom.operationDigests.length ||
      binding.remainingFrom.operationDigests.some(value => !/^[a-f0-9]{64}$/u.test(value)) ||
      new Set(binding.remainingFrom.operationDigests).size !== binding.remainingFrom.operationDigests.length) ||
    binding.reviewKind !== 'remaining-only' && binding.remainingFrom !== null) {
    return workflowFailure('workflow-source5-review', 'Publication, exact bound-source and remaining-only reviews are separate explicit plans, not authority refresh aliases.');
  }
  return { phaseId: binding.phaseId, adapter: 'local-state', actionId: 'governance.workflow-checkpoint.write',
    mutationClass: 'write-evidence', destination: { type: 'local', identity: `workflow-source5-journal:${binding.controlKey}`,
      pathParts: ['workflow-source5-journal', binding.controlKey] },
    inputs: { ...binding }, remote: false, destructive: false,
    effects: [...new Set([binding.controlKey, ...(binding.origin ? [binding.origin.planKey] : [])])].flatMap(key => [
      { mutationClass: 'write-evidence' as const, destination: { type: 'local' as const,
        identity: `governance/plans/${key}.json`, pathParts: ['governance', 'plans', `${key}.json`] }, remote: false, destructive: false },
      { mutationClass: 'write-evidence' as const, destination: { type: 'local' as const,
        identity: `governance/approvals/source5-${key}.json`, pathParts: ['governance', 'approvals', `source5-${key}.json`] }, remote: false, destructive: false }
    ]) };
}
export function source5WorkflowProjectOperations(control: Source5WorkflowControlBinding): readonly ModernTransitionOperation[] {
  const destinations = [
    { actionId: 'governance.evidence.write', mutationClass: 'write-evidence' as const,
      pathParts: ['governance', 'evidence', `source5-${control.controlKey}.json`] },
    { actionId: 'governance.activation-state.write', mutationClass: 'write-activation-state' as const,
      pathParts: ['governance', 'activation-state.json'] }
  ];
  return destinations.map(({ actionId, mutationClass, pathParts }) => ({
    phaseId: control.phaseId, adapter: 'local-state', actionId, mutationClass,
    destination: { type: 'local', identity: pathParts.join('/'), pathParts },
    inputs: { controlKey: control.controlKey }, remote: false, destructive: false
  }));
}
export function source5WorkflowPlanInventory(plan: ModernSavedTransitionPlan): {
  control: Source5WorkflowControlBinding; checkpoint: ModernTransitionOperation; effects: readonly ModernTransitionOperation[];
} {
  const checkpoints = plan.operations.filter(operation => operation.actionId === 'governance.workflow-checkpoint.write');
  if (checkpoints.length !== 1 || !isRecord(checkpoints[0]!.inputs)) {
    return workflowFailure('workflow-source5-inventory', 'A workflow plan requires exactly one inventoried local checkpoint action.');
  }
  const raw = checkpoints[0]!.inputs;
  if (!controlShape(raw)) return workflowFailure('workflow-source5-inventory', 'Unknown workflow control binding.');
  const control = raw;
  const checkpoint = source5WorkflowCheckpointOperation(control);
  if (canonicalSha256(checkpoints[0]) !== canonicalSha256(checkpoint) || control.phaseId !== plan.phaseId) {
    return workflowFailure('workflow-source5-inventory', 'The exact checkpoint operation or phase differs from its closed constructor.');
  }
  const persistence = source5WorkflowProjectOperations(control);
  const projectWrites = plan.operations.filter(operation => ['governance.evidence.write', 'governance.activation-state.write'].includes(operation.actionId));
  if (canonicalSha256(projectWrites) !== canonicalSha256(persistence)) {
    return workflowFailure('workflow-source5-inventory', 'Workflow final evidence/state writes must match their exact original inventoried destinations.');
  }
  const effects = plan.operations.filter(operation => operation !== checkpoints[0] && !projectWrites.includes(operation));
  source5WorkflowLogicalEntries(plan.operations);
  if (!effects.length ||
    new Set(effects.map(operation => operation.actionId)).size !== effects.length || plan.approvalBundle?.length) {
    return workflowFailure('workflow-source5-inventory', 'Workflow effects require one nonempty bounded unique exact phase inventory; approval bundles are not a bridge shortcut.');
  }
  for (const operation of effects) {
    const base = (source5WorkflowActions[control.phaseId] as readonly Source5WorkflowAction[]).find(base =>
      operation.actionId === `${base}:${canonicalSha256(operation.inputs)}`);
    if (!base || canonicalSha256(operation) !== canonicalSha256(source5WorkflowOperation(control.phaseId, base, operation.inputs))) {
      return workflowFailure('workflow-source5-inventory', 'Generic action suffixes, extra effects and caller-altered destinations are not indexed workflow authority.');
    }
  }
  const publication = effects.filter(operation => operation.actionId.startsWith('git.workflow-source.publish-reviewed:'));
  if (control.reviewKind === 'publication' && (effects.length !== 1 || publication.length !== 1) ||
    control.reviewKind !== 'publication' && publication.length) {
    return workflowFailure('workflow-source5-two-plan', 'Publishing source cannot approve its future commit; bound-source plans must use their exact independently observed original publication.');
  }
  return { control, checkpoint, effects };
}
