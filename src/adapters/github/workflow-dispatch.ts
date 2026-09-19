import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { ExternalOperationState, TransitionOperation } from '../../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import { clientFor } from '../../governance-activation/github-config.js';
import { githubPorts } from '../../governance-activation/github-ports.js';
import { assertGitHubPhaseAuthority } from '../../application/repository-governance/workflow-authority.js';
import {
  prepareWorkflowEffect, readWorkflowEffect, recordWorkflowProviderResult,
  type WorkflowEffectIdentity
} from '../../application/repository-governance/workflow-checkpoints.js';
import {
  expectStatus, GitHubActivationError, object, positiveId, type GitHubActivationClient
} from './activation-rest.js';
import { readbackWorkflowContent } from './workflow-source-readback.js';
import { observeOrPollWorkflowRun, validateWorkflowRunBinding, type WorkflowRunBinding } from './workflow-run-readback.js';
import { decodeWorkflow } from './workflow-check-recipes.js';
export { validateWorkflowRunBinding, type WorkflowRunBinding } from './workflow-run-readback.js';

export type WorkflowDispatchResult = {
  /** Retained client correlation only; never a provider ID or execution authority. */
  correlationId: string;
} & (
  { status: 'pending'; operation: ExternalOperationState; run?: never; pendingReason?: 'run-readback-unavailable' } |
  { status: 'completed'; operation: ExternalOperationState; run: Awaited<ReturnType<typeof observeOrPollWorkflowRun>> }
);

export class WorkflowDispatchReadbackPendingError extends GitHubActivationError {
  readonly operation: ExternalOperationState;
  constructor(operation: ExternalOperationState, readonly correlationId: string) {
    super('dispatch-readback-pending',
      'The exact recorded run/attempt is not fully visible. Preserve its actual provider handle and known terminal state; only readback may resume, never another dispatch.', 404);
    this.operation = structuredClone(operation);
  }
}

async function assertDispatchPreconditions(
  client: GitHubActivationClient, binding: WorkflowRunBinding, dispatchInputs: Readonly<Record<string, string>>
) {
  validateWorkflowRunBinding(binding);
  const [repository, actor, ref, workflow, source] = await Promise.all([
    client.get(`/repos/${binding.repository}`), client.get('/user'),
    client.get(`/repos/${binding.repository}/git/ref/heads/${binding.ref}`),
    client.get(`/repos/${binding.repository}/actions/workflows/${binding.workflowId}`),
    readbackWorkflowContent(client, binding.repository, binding.workflowPath, binding.sourceSha)
  ]);
  if (repository.id !== binding.repositoryId || repository.full_name !== binding.repository ||
    actor.id !== binding.actorId || ref.ref !== `refs/heads/${binding.ref}` ||
    object(ref.object).sha !== binding.sourceSha || object(ref.object).type !== 'commit' ||
    workflow.id !== binding.workflowId || workflow.path !== binding.workflowPath || workflow.state !== 'active' ||
    source.digest !== binding.workflowDigest || binding.event !== 'workflow_dispatch') {
    throw new GitHubActivationError('workflow-precondition', 'The actual repository, actor, workflow source or exact dispatch ref changed after approval.');
  }
  if (binding.producerSourceSha && binding.producerSourceSha !== binding.sourceSha) {
    const producer = await readbackWorkflowContent(client, binding.repository, binding.workflowPath, binding.producerSourceSha);
    if (producer.digest !== binding.workflowDigest) throw new GitHubActivationError('workflow-producer-source', 'Workflow producer source differs from the separately bound execution source.');
  }
  const document = decodeWorkflow(source.content);
  const declaration = object(object(object(document.on).workflow_dispatch).inputs);
  const jobs = object(document.jobs, 'Actual dispatch workflow jobs');
  const jobNames = Object.entries(jobs).map(([id, value]) => object(value).name ?? id);
  const correlation = object(declaration.liftoff_operation_id);
  if (document['run-name'] !== 'liftoff-${{ inputs.liftoff_operation_id }}' ||
    correlation.type !== 'string' || correlation.required !== true ||
    Object.hasOwn(dispatchInputs, 'liftoff_operation_id') || Object.keys(dispatchInputs).length > 24 ||
    Object.entries(dispatchInputs).some(([name, value]) =>
      !/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/u.test(name) || !Object.hasOwn(declaration, name) ||
      typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) ||
    Object.entries(declaration).some(([name, value]) => name !== 'liftoff_operation_id' &&
      object(value).required === true && !Object.hasOwn(dispatchInputs, name)) ||
    binding.expectedJobs.some((name) => jobNames.filter((actual) => actual === name).length !== 1)) {
    throw new GitHubActivationError('workflow-recovery-recipe', 'A dispatch recipe must declare its exact public inputs and the required liftoff_operation_id run-name binding; no secret or command inputs are inferred.');
  }
}

function runMatches(run: Record<string, unknown>, binding: WorkflowRunBinding, correlationId: string, preparedAt: string): boolean {
  const created = typeof run.created_at === 'string' ? Date.parse(run.created_at) : NaN;
  return run.workflow_id === binding.workflowId && run.head_sha === binding.sourceSha &&
    run.head_branch === binding.ref && run.path === binding.workflowPath && run.event === binding.event &&
    run.run_attempt === binding.runAttempt && object(run.actor).id === binding.actorId &&
    object(run.triggering_actor).id === binding.actorId &&
    object(run.repository).id === binding.repositoryId && object(run.repository).full_name === binding.repository &&
    run.display_title === `liftoff-${correlationId}` && created >= Date.parse(preparedAt) &&
    created <= Date.parse(preparedAt) + 5 * 60_000;
}

export async function dispatchApprovedWorkflowRun(
  input: PhaseAdapterExecutionInput, approvedOperation: TransitionOperation,
  workflow: WorkflowRunBinding, approvedInputs: Record<string, string>
): Promise<WorkflowDispatchResult> {
  const operation = structuredClone(approvedOperation);
  const binding = structuredClone(workflow);
  const dispatchInputs = structuredClone(approvedInputs);
  const maxAttempts = githubPorts(input).pollAttempts ?? 1;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new GitHubActivationError('workflow-poll-bound', 'Workflow observation requires one to five bounded attempts before any dispatch.');
  }
  await assertGitHubPhaseAuthority(input, operation);
  validateWorkflowRunBinding(binding);
  if (operation.mutationClass !== 'github-workflow-dispatch' ||
    canonicalSha256(operation.inputs.workflow ?? null) !== canonicalSha256(binding) ||
    canonicalSha256(operation.inputs.dispatchInputs ?? null) !== canonicalSha256(dispatchInputs) ||
    operation.destination.repository !== binding.repository) {
    throw new GitHubActivationError('dispatch-authority', 'The exact workflow and public dispatch inputs are absent from this phase-specific approved operation.');
  }
  const client = clientFor(input);
  await assertDispatchPreconditions(client, binding, dispatchInputs);
  const identity: WorkflowEffectIdentity = {
    repositoryId: binding.repositoryId, ref: `${binding.ref}:${binding.workflowId}`, purpose: 'workflow-dispatch', step: 'dispatch'
  };
  const payload = { workflow: binding, dispatchInputs };
  let records = await readWorkflowEffect(input, operation, identity, payload);
  let prepared = records?.prepared;
  const retry = records?.response && [401, 403, 404, 422].includes(records.response.status) &&
    !records.observed && input.recovery && input.plan.recovery &&
    records.prepared.approvalEnvelopeHash !== input.plan.approval.envelopeHash;
  if (!records || retry) {
    prepared = await prepareWorkflowEffect(input, operation, identity, payload);
    await assertGitHubPhaseAuthority(input, operation);
    await assertDispatchPreconditions(client, binding, dispatchInputs);
    await assertGitHubPhaseAuthority(input, operation);
    const response = await client.transport.request({
      method: 'POST', path: `/repos/${binding.repository}/actions/workflows/${binding.workflowId}/dispatches`,
      body: { ref: binding.ref, inputs: { ...dispatchInputs, liftoff_operation_id: prepared.correlationId } }
    });
    const data = response.status === 200 ? object(response.data) : null;
    const id = data && Number.isSafeInteger(data.workflow_run_id) && Number(data.workflow_run_id) > 0 ?
      Number(data.workflow_run_id) : null;
    await recordWorkflowProviderResult(input, operation, identity, prepared, 'response', {
      status: response.status, requestId: response.headers['x-github-request-id'] ?? null,
      providerId: id === null ? null : String(id), resourceId: id === null ? null : `/repos/${binding.repository}/actions/runs/${id}`
    });
    expectStatus(response, [200, 204], 'Dispatch exact reviewed workflow');
    if (id !== null && (data!.run_url !== `https://api.github.com/repos/${binding.repository}/actions/runs/${id}` ||
      data!.html_url !== `https://github.com/${binding.repository}/actions/runs/${id}`)) {
      throw new GitHubActivationError('dispatch-response', 'The actual dispatch response contains an inconsistent provider run URL.');
    }
    records = await readWorkflowEffect(input, operation, identity, payload);
  }
  if (!prepared || !records) throw new GitHubActivationError('dispatch-checkpoint', 'Dispatch has no retained private pre-effect record.');
  let runId = records.observed?.providerId ?? records.response?.providerId;
  if (!runId) {
    const candidates = await client.list(`/repos/${binding.repository}/actions/workflows/${binding.workflowId}/runs?branch=${binding.ref}&event=${binding.event}&head_sha=${binding.sourceSha}`, 'workflow_runs');
    const matches = candidates.filter((run) => runMatches(run, binding, prepared.correlationId, prepared.preparedAt));
    if (matches.length !== 1) throw new GitHubActivationError('dispatch-uncertain',
      'The recorded dispatch has no unique exact provider run identity yet. Preserve its private checkpoint and recover by readback; never redispatch or substitute a latest run.');
    runId = String(positiveId(matches[0]!.id));
  }
  const numericId = positiveId(Number(runId));
  const resourceId = `/repos/${binding.repository}/actions/runs/${numericId}`;
  const external: ExternalOperationState = {
    provider: 'github', actionId: operation.actionId, operationId: String(numericId), resourceId,
    startedAt: prepared.preparedAt, observedAt: (input.clock?.() ?? input.now).toISOString(),
    status: 'running', planDigest: prepared.planDigest
  };
  let visible = false;
  let terminal: ExternalOperationState['status'] | undefined;
  const retained = input.inspection.state.phases[input.phase.id].operation;
  if (retained?.operationId === external.operationId && retained.resourceId === resourceId &&
    retained.planDigest === prepared.planDigest && retained.status !== 'running') terminal = retained.status;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await assertGitHubPhaseAuthority(input, operation);
    const observations = await Promise.allSettled([
      client.optional(`${resourceId}/attempts/${binding.runAttempt}`), client.optional(resourceId)
    ]);
    const available = observations.map((observation) => {
      if (observation.status === 'rejected') throw observation.reason;
      return observation.value;
    });
    for (const actual of available) {
      if (actual && (actual.id !== numericId || !runMatches(actual, binding, prepared.correlationId, prepared.preparedAt))) {
        throw new GitHubActivationError('dispatch-run-binding', 'Actual dispatched run, attempt, actor, correlation or immutable source differs from the recorded operation.');
      }
      if (actual?.status === 'completed' && typeof actual.conclusion === 'string') {
        const observedStatus = actual.conclusion === 'success' ? 'completed' : 'failed';
        if (terminal && terminal !== observedStatus) {
          throw new GitHubActivationError('dispatch-run-binding', 'The recorded terminal workflow result conflicts with actual provider readback.');
        }
        terminal = observedStatus;
      }
    }
    if (available.every((actual) => actual !== null)) { visible = true; break; }
    const recordedId = records.observed?.providerId ?? (records.response?.status === 200 ? records.response.providerId : null);
    const recordedResource = records.observed?.resourceId ?? records.response?.resourceId;
    if (recordedId !== external.operationId || recordedResource !== resourceId) {
      throw new GitHubActivationError('dispatch-uncertain',
        'A list candidate without a recorded provider response or exact run readback is not an operation handle. Preserve the original request; never adopt a latest run or redispatch.');
    }
  }
  if (!visible) {
    await assertDispatchPreconditions(client, binding, dispatchInputs);
    await assertGitHubPhaseAuthority(input, operation);
    external.observedAt = (input.clock?.() ?? input.now).toISOString();
    if (terminal) throw new WorkflowDispatchReadbackPendingError({ ...external, status: terminal }, prepared.correlationId);
    return { status: 'pending', pendingReason: 'run-readback-unavailable', correlationId: prepared.correlationId, operation: external };
  }
  if (!records.observed) await recordWorkflowProviderResult(input, operation, identity, prepared, 'observed', {
    status: 200, requestId: null, providerId: String(numericId), resourceId
  });
  try {
    const result = await observeOrPollWorkflowRun({
      client, repository: binding.repository, workflowFileName: binding.workflowPath,
      expectedHeadSha: binding.sourceSha, expectedEvent: binding.event, expectedRef: binding.ref,
      expectedActorId: binding.actorId, expectedWorkflowId: binding.workflowId, expectedWorkflowDigest: binding.workflowDigest,
      expectedJobs: binding.expectedJobs, expectedRunAttempt: binding.runAttempt, pendingOperation: external,
      maxAttempts
    });
    return { status: 'completed', correlationId: prepared.correlationId,
      operation: { ...external, status: result.conclusion === 'success' ? 'completed' : 'failed' }, run: result };
  } catch (error) {
    if (error instanceof GitHubActivationError && error.code === 'workflow-run-not-settled') {
      return { status: 'pending', correlationId: prepared.correlationId, operation: external };
    }
    throw error;
  }
}
