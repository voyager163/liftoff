import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { ExternalOperationState, TransitionOperation } from '../../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome } from '../../governance-activation/transition-ports.js';
import { validateWorkflowRunBinding, type WorkflowRunBinding } from '../../adapters/github/workflow-dispatch.js';
import { readWorkflowEffect, type WorkflowEffectCheckpoints } from '../repository-governance/workflow-checkpoints.js';
import { environmentQualificationScopeBlocker, qualificationFailure, qualificationInteger } from './qualification-authority.js';

export async function readQualificationCheckpoints(
  input: PhaseAdapterExecutionInput, operation: TransitionOperation,
  workflow: WorkflowRunBinding, dispatchInputs: Readonly<Record<string, string>>
): Promise<WorkflowEffectCheckpoints | null> {
  validateWorkflowRunBinding(workflow);
  if (operation.phaseId !== input.phase.id || operation.adapter !== 'github' ||
    operation.mutationClass !== 'github-workflow-dispatch' ||
    canonicalSha256(operation.inputs.workflow ?? null) !== canonicalSha256(workflow) ||
    canonicalSha256(operation.inputs.dispatchInputs ?? null) !== canonicalSha256(dispatchInputs)) {
    qualificationFailure('qualification-checkpoint', 'Environment recovery requires its exact registered workflow operation and public inputs, not a fabricated pending operation.');
  }
  const records = await readWorkflowEffect(input, operation, {
    repositoryId: workflow.repositoryId, ref: `${workflow.ref}:${workflow.workflowId}`,
    purpose: 'workflow-dispatch', step: 'dispatch'
  }, { workflow, dispatchInputs });
  if (records && (records.prepared.planDigest !== input.plan.planDigest ||
    records.prepared.approvalEnvelopeHash !== input.plan.approval.envelopeHash ||
    Date.parse(records.prepared.preparedAt) < Date.parse(input.plan.createdAt) ||
    Date.parse(records.prepared.preparedAt) >= Date.parse(input.plan.expiresAt))) {
    qualificationFailure('qualification-checkpoint', "Recover the original issued plan and clock. A replacement environment plan cannot adopt another plan's retained workflow effect.");
  }
  return records;
}

export function qualificationOperationFromCheckpoint(
  records: WorkflowEffectCheckpoints, operation: TransitionOperation, workflow: WorkflowRunBinding, observedAt: string
): ExternalOperationState | undefined {
  const observed = records.observed;
  if (!observed) return undefined;
  const runId = qualificationInteger(Number(observed.providerId), 'Recorded environment workflow run');
  const resourceId = `/repos/${workflow.repository}/actions/runs/${runId}`;
  if (observed.providerId !== String(runId) || observed.resourceId !== resourceId ||
    Date.parse(observed.recordedAt) > Date.parse(observedAt)) {
    qualificationFailure('qualification-checkpoint', 'The retained environment effect has conflicting provider IDs or readback time; preserve it without redispatch.');
  }
  return {
    provider: 'github', actionId: operation.actionId, operationId: String(runId), resourceId,
    startedAt: records.prepared.preparedAt, observedAt, status: 'running', planDigest: records.prepared.planDigest
  };
}

export function blockedQualificationOutcome(input: PhaseAdapterExecutionInput, blocker: string): PhaseAdapterOutcome {
  const operation = input.inspection.state.phases[input.phase.id].operation;
  return {
    status: 'blocked',
    blocker: (input.inspection.scope ?? 'activation') === 'activation' ? blocker : environmentQualificationScopeBlocker,
    completedOperations: [],
    ...(operation ? {
      operation: structuredClone(operation),
      cleanupWarnings: ['The original external operation is retained, not resumed, settled or rolled back by this unavailable qualification producer.']
    } : {})
  };
}
