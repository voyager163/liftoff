import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import {
  assertWorkflowAuthority, captureWorkflowBinding, workflowFailure, workflowOperation,
  workflowRuntime, recordWorkflowCheckpoint, type WorkflowEffectInput
} from './workflow-runtime.js';
import {
  observeExecutionCommit, observeImmutableWorkflowExecutionRef, observeWorkflowExecutionBarrier, observeWorkflowProviderAdmission
} from './workflow-execution-ref-observation.js';
import type { WorkflowExecutionRefBinding, ImmutableWorkflowExecutionRef } from './workflow-execution-ref-observation.js';
export {
  workflowExecutionRefName, observeImmutableWorkflowExecutionRef, observeWorkflowExecutionBarrier, observeWorkflowProviderAdmission
} from './workflow-execution-ref-observation.js';
export type { WorkflowExecutionRefBinding, ImmutableWorkflowExecutionRef } from './workflow-execution-ref-observation.js';

export type WorkflowExecutionRefInput = WorkflowEffectInput & {
  executionRefIntent?: { bindingDigest: string; planDigest: string };
  recordExecutionRefIntent?: (intent: { bindingDigest: string; planDigest: string }) => Promise<void>;
};

export async function bindImmutableWorkflowExecutionRef(
  input: WorkflowExecutionRefInput, binding: WorkflowExecutionRefBinding
): Promise<ImmutableWorkflowExecutionRef> {
  binding = captureWorkflowBinding(binding);
  const operation = workflowOperation(input, 'github.workflow-source.bind-execution-ref', binding);
  const runtime = workflowRuntime(input);
  await observeWorkflowExecutionBarrier(runtime, binding);
  await observeWorkflowProviderAdmission(runtime, binding, 'tag-create');
  await observeWorkflowProviderAdmission(runtime, binding, 'dispatch');
  await observeExecutionCommit(runtime, binding);
  if (!input.recordExecutionRefIntent) {
    return workflowFailure('workflow-execution-unavailable', 'Execution-ref creation requires its explicit successor authority and durable engine-owned intent.');
  }
  const digest = canonicalSha256(binding);
  if (input.executionRefIntent && (input.executionRefIntent.bindingDigest !== digest ||
    input.executionRefIntent.planDigest !== input.plan.planDigest)) {
    return workflowFailure('workflow-execution-intent', 'An execution-ref intent cannot be retagged for different source or authority.');
  }
  const current = await runtime.client.optional(`/repos/${binding.repository}/git/ref/tags/${binding.executionRef}`);
  if (!current) {
    if (input.executionRefIntent) {
      return workflowFailure('workflow-execution-uncertain', 'A prior tag-create intent is not visible; uncertain acceptance cannot cause an automatic repeated write.');
    }
    await assertWorkflowAuthority(input, operation);
    await recordWorkflowCheckpoint(input.recordExecutionRefIntent, { bindingDigest: digest, planDigest: input.plan.planDigest });
    await assertWorkflowAuthority(input, operation);
    await runtime.client.write('POST', `/repos/${binding.repository}/git/refs`, {
      ref: `refs/tags/${binding.executionRef}`, sha: binding.sourceSha
    });
  }
  return observeImmutableWorkflowExecutionRef(runtime, binding);
}
