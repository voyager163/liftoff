import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import {
  assertWorkflowAuthority, captureWorkflowBinding, workflowFailure, workflowOperation,
  workflowRuntime, recordWorkflowCheckpoint, type WorkflowEffectInput
} from './workflow-runtime.js';
import { observeWorkflowRunnerAssignment, validateWorkflowRunnerAdmission } from './workflow-runner-admission-observation.js';
import type { WorkflowRunnerAdmissionBinding } from './workflow-runner-admission-observation.js';
export { validateWorkflowRunnerAdmission } from './workflow-runner-admission-observation.js';
export type { WorkflowRunnerAdmissionBinding } from './workflow-runner-admission-observation.js';

export type WorkflowRunnerAdmissionInput = WorkflowEffectInput & {
  runnerAdmissionIntent?: { bindingDigest: string; planDigest: string };
  recordRunnerAdmissionIntent?: (intent: { bindingDigest: string; planDigest: string }) => Promise<void>;
};

export async function admitReviewedRunnerWorkflows(
  input: WorkflowRunnerAdmissionInput, binding: WorkflowRunnerAdmissionBinding
): Promise<{ bindingDigest: string; observationDigest: string }> {
  binding = validateWorkflowRunnerAdmission(binding);
  const organization = binding.repository.split('/')[0]!;
  const operation = workflowOperation(input, 'github.workflow-source.admit-reviewed', binding);
  const bindingDigest = canonicalSha256(binding);
  const intent = input.runnerAdmissionIntent && captureWorkflowBinding(input.runnerAdmissionIntent);
  const expectedIntent = { bindingDigest, planDigest: input.plan.planDigest };
  if (intent && canonicalSha256(intent) !== canonicalSha256(expectedIntent)) {
    return workflowFailure('workflow-runner-admission', 'A restored runner admission intent cannot be reassigned to different source or reviewed authority.');
  }
  const runtime = workflowRuntime(input);
  const endpoint = `/orgs/${organization}/actions/runner-groups/${binding.groupId}`;
  const observe = () => observeWorkflowRunnerAssignment(runtime, binding);
  const current = await observe();
  const same = (left: readonly unknown[], right: readonly unknown[]) =>
    canonicalSha256([...left].sort()) === canonicalSha256([...right].sort());
  if (!same(current, binding.afterWorkflows)) {
    if (!same(current, binding.beforeWorkflows) || intent) {
      return workflowFailure('workflow-runner-admission', 'Runner admission changed or prior write acceptance is uncertain; do not repeat or overwrite another assignment.');
    }
    if (!input.recordRunnerAdmissionIntent) {
      return workflowFailure('workflow-runner-admission', 'Exact runner workflow admission requires durable engine intent.');
    }
    await assertWorkflowAuthority(input, operation);
    await recordWorkflowCheckpoint(input.recordRunnerAdmissionIntent, expectedIntent);
    await assertWorkflowAuthority(input, operation);
    await runtime.client.write('PATCH', endpoint, {
      name: binding.groupName, restricted_to_workflows: true, selected_workflows: [...binding.afterWorkflows]
    });
  }
  if (!same(await observe(), binding.afterWorkflows)) {
    return workflowFailure('workflow-runner-admission', 'Actual runner workflow admission did not match the reviewed after-set.');
  }
  return { bindingDigest, observationDigest: canonicalSha256({
    repositoryId: binding.repositoryId, groupId: binding.groupId, networkConfigurationId: binding.networkConfigurationId,
    selectedWorkflows: [...binding.afterWorkflows].sort()
  }) };
}
