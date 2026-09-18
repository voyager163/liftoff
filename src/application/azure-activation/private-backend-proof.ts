import type {
  PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput
} from '../../governance-activation/transition-ports.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { assertOperationAllowed, operation, transitionDestination } from '../../domain/governance/activation/operations.js';
import { githubOperation, verifiedOutput } from '../../governance-activation/github-config.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import { readbackProof } from '../../governance-activation/transition-records.js';
import { dispatchApprovedWorkflowRun, type WorkflowRunBinding } from '../../adapters/github/production-checks.js';
import { readWorkflowEffect, recordWorkflowProviderResult, type WorkflowEffectIdentity } from '../repository-governance/workflow-checkpoints.js';
import { openPrivateRunnerGitHubSession } from '../../adapters/github/private-runner-session.js';
import { GitHubActivationClient, object, positiveId, safeGitHubFailure } from '../../adapters/github/activation-rest.js';
import { PrivateBackendAuditClient, validatePrivateBackendAuditBinding,
  type PrivateBackendAuditBinding, type PrivateBackendAuditObservation } from '../../adapters/azure/private-backend-audit.js';
import { safePrivateStateFailure, type AzurePrivateStatePath } from '../../adapters/azure/private-state-path.js';
import { azureStateUrl } from '../../adapters/state/azure-blob.js';
import { exactObject } from './private-resource-plans.js';
import { assertAzurePhaseAuthority, AzureActivationAdmissionError } from './authority.js';
import { privateBackendDispatchInputs, privateBackendWorkflowBinding, validatePrivateBackendSource,
  type PrivateBackendRunReport, type PrivateBackendWorkflowSource } from './private-backend-workflow.js';
import { privateLeaseChallenge, privateLeaseSteps, type PrivateLeaseChallenge, type PrivateLeaseStep } from './private-backend-lease.js';
import { readPrivateBackendReport } from './private-backend-report.js';
import { preparePrivateEffect, readPrivateEffect, settlePrivateEffect, submitPrivateEffect,
  type PrivateEffectCheckpoint, type PrivateEffectIntent } from './private-checkpoints.js';
import { stateAssert } from '../../domain/repair/stateful-invariants.js';
import { StateMigrationError, type StateBackendLease, type StateExecutionContext } from '../../domain/repair/stateful.js';
import type { ExternalOperationState, TransitionOperation } from '../../domain/governance/activation/types.js';

export const privateBackendLeaseActions = {
  acquire: 'azure.private-backend.lease.acquire', contend: 'azure.private-backend.lease.acquire',
  renew: 'azure.private-backend.lease.renew', release: 'azure.private-backend.lease.release'
} as const;
export const privateBackendLeaseContractGap =
  'The current private-backend-proof contract must explicitly permit exact backend lease acquire, competing acquire, renew and release writes under private issued approval. No read-only, absent-blob or conditional-create capability can stand in for acquired exclusive locking.';

interface BackendRunnerBinding {
  groupId: number;
  definitionId: number;
  networkConfigurationId: string;
  networkSettingsId: string;
  allowedWorkflowsDigest: string;
}

export interface PrivateBackendLeasePlan {
  schemaVersion: 1;
  recipe: 'private-backend-lease/1';
  source: PrivateBackendWorkflowSource;
  challenge: PrivateLeaseChallenge;
  audit: PrivateBackendAuditBinding;
  runner: BackendRunnerBinding;
  configurationDigest: string;
  planDigest: string;
}

export interface PrivateBackendProofPorts {
  client?: GitHubActivationClient;
  audit?: Pick<PrivateBackendAuditClient, 'inspect' | 'verify'>;
}

function failure(error: unknown): string {
  if (error instanceof AzureActivationAdmissionError) return error.message;
  if (error instanceof StateMigrationError) return safePrivateStateFailure(error);
  return safeGitHubFailure(error);
}

function mode(input: PhasePlanningInput): 'execute' | 'readback' {
  return input.inspection.recoverPhase === 'private-backend-proof' ? 'readback' : 'execute';
}

function leasePlan(input: PhasePlanningInput): PrivateBackendLeasePlan {
  const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  const value = exactObject(configuration?.phases['private-backend-proof'], ['source', 'challenge', 'audit'], 'Private backend lease proof');
  const source = validatePrivateBackendSource(value.source as PrivateBackendWorkflowSource);
  const target = source.recipe.target;
  stateAssert(String(source.recipe.repositoryId) === input.inspection.state.remoteBinding?.id &&
    configuration?.azure?.subscriptionId === target.binding.subscriptionId &&
    configuration.azure.tenantId === target.binding.tenantId && configuration.azure.region === target.region, 'ownership-mismatch');
  const read = (key: string) => verifiedOutput(input.inspection, 'runner-ready', key);
  stateAssert(read('runner.backendWorkflowId') === source.workflowId &&
    read('runner.backendWorkflowPath') === source.recipe.workflowPath && read('runner.backendWorkflowSourceSha') === source.sourceSha &&
    read('runner.backendWorkflowDigest') === source.workflowDigest && read('runner.backendWorkflowRef') === source.ref &&
    read('runner.backendWorkflowActorId') === source.actorId, 'configuration-changed');
  const audit = validatePrivateBackendAuditBinding(value.audit as PrivateBackendAuditBinding, target);
  const challenge = privateLeaseChallenge(value.challenge as Parameters<typeof privateLeaseChallenge>[0], canonicalSha256({ source, audit }));
  const runner: BackendRunnerBinding = {
    groupId: positiveId(Number(read('runner.groupId'))), definitionId: positiveId(Number(read('runner.definitionId'))),
    networkConfigurationId: String(read('runner.networkConfigurationId')), networkSettingsId: String(read('runner.networkSettingsId')),
    allowedWorkflowsDigest: String(read('runner.allowedWorkflowsDigest'))
  };
  stateAssert([runner.networkConfigurationId, runner.networkSettingsId].every((id) => /^[A-Za-z0-9_-]{1,100}$/u.test(id)) &&
    /^[a-f0-9]{64}$/u.test(runner.allowedWorkflowsDigest), 'invalid-binding');
  if (mode(input) === 'execute') stateAssert(Date.parse(challenge.activeUntil) > input.now.getTime() &&
    Date.parse(challenge.releaseUntil) <= input.now.getTime() + 5 * 60_000, 'expired');
  const body = {
    schemaVersion: 1 as const, recipe: 'private-backend-lease/1' as const,
    source, challenge, audit, runner, configurationDigest: canonicalSha256(configuration)
  };
  return { ...body, planDigest: canonicalSha256(body) };
}

function dispatchOperation(input: PhasePlanningInput, plan: PrivateBackendLeasePlan): TransitionOperation {
  return githubOperation(input, 'github.runner.backend-proof', 'github-workflow-dispatch', {
    leasePlan: plan, workflow: privateBackendWorkflowBinding(plan.source),
    dispatchInputs: privateBackendDispatchInputs(plan.challenge, plan.configurationDigest, plan.runner.groupId)
  }, undefined, [
    { mutationClass: 'backend-state-read', destination: transitionDestination('external', blobUrl(plan)), remote: true, destructive: false },
    { mutationClass: 'backend-state-write', destination: transitionDestination('external', blobUrl(plan)), remote: true, destructive: false }
  ]);
}

function blobUrl(plan: PrivateBackendLeasePlan): string {
  return azureStateUrl(plan.source.recipe.target.backend, 'blob');
}

function leaseOperation(input: PhasePlanningInput, plan: PrivateBackendLeasePlan, step: PrivateLeaseStep): TransitionOperation {
  return operation({
    adapter: 'azure-opentofu', phaseId: 'private-backend-proof', actionId: privateBackendLeaseActions[step],
    mutationClass: 'backend-state-write', remote: true, destructive: false,
    destination: transitionDestination('external', blobUrl(plan)),
    inputs: {
      leasePlanDigest: plan.planDigest, leaseIntentDigest: plan.challenge.intentDigest, target: plan.source.recipe.target,
      step, action: step === 'contend' ? 'acquire' : step, clientRequestId: plan.challenge.clientRequestIds[step],
      expectedEtag: plan.challenge.expectedEtag, expectedVersion: plan.challenge.expectedVersion,
      expectedStatus: step === 'acquire' ? 201 : step === 'contend' ? 409 : 200, leaseDurationSeconds: 60,
      ...(step === 'release' ? { cleanupOf: 'accepted-owned-lease-only' } : {}),
      expiresAt: step === 'release' ? plan.challenge.releaseUntil : plan.challenge.activeUntil
    }
  });
}

function effectIntent(op: TransitionOperation): PrivateEffectIntent {
  return { kind: 'backend-lease-proof', step: String(op.inputs.step), provider: 'azure', resourceId: op.destination.identity,
    request: { method: 'PUT', target: 'lease', ...op.inputs } };
}

export function planPrivateBackendProof(input: PhasePlanningInput): PhasePlanBuild {
  try {
    stateAssert(input.phase.id === 'private-backend-proof' && (input.inspection.scope ?? 'activation') === 'activation' &&
      input.inspection.state.applicability.statePath === 'bootstrap-local', 'approval-mismatch');
    const plan = leasePlan(input);
    const target = plan.source.recipe.target;
    const account = `/subscriptions/${target.binding.subscriptionId}/resourceGroups/${target.backend.resourceGroup}` +
      `/providers/Microsoft.Storage/storageAccounts/${target.backend.account}`;
    const read = operation({
      adapter: 'azure-opentofu', phaseId: 'private-backend-proof', actionId: 'azure.remote-state.read',
      mutationClass: 'azure-read', remote: true, destructive: false, inputs: { leasePlan: plan, mode: mode(input) },
      destination: transitionDestination('subscription', account, { subscriptionId: target.binding.subscriptionId })
    });
    const operations = mode(input) === 'readback' ? [
      githubOperation(input, 'github.runner.backend-proof', 'github-read', { leasePlan: plan, mode: 'readback' }), read
    ] : [dispatchOperation(input, plan), read, ...privateLeaseSteps.map((step) => leaseOperation(input, plan, step))];
    try { for (const op of operations) assertOperationAllowed(input.phase, op); }
    catch { return { operations: [], blockers: [privateBackendLeaseContractGap] }; }
    return { operations };
  } catch (error) { return { operations: [], blockers: [failure(error)] }; }
}

async function assignment(client: GitHubActivationClient, plan: PrivateBackendLeasePlan) {
  const source = plan.source;
  const org = source.recipe.repository.split('/')[0]!;
  const group = await client.get(`/orgs/${org}/actions/runner-groups/${plan.runner.groupId}`);
  stateAssert(group.id === plan.runner.groupId && group.name === source.recipe.runnerGroupName &&
    group.default === false && group.inherited === false && group.visibility === 'selected' &&
    group.allows_public_repositories === false && group.restricted_to_workflows === true &&
    group.network_configuration_id === plan.runner.networkConfigurationId &&
    canonicalSha256(group.selected_workflows) === plan.runner.allowedWorkflowsDigest &&
    Array.isArray(group.selected_workflows) &&
    group.selected_workflows.includes(`${source.recipe.repository}/${source.recipe.workflowPath}@refs/heads/${source.ref}`), 'ownership-mismatch');
  const repositories = await client.list(`/orgs/${org}/actions/runner-groups/${plan.runner.groupId}/repositories`, 'repositories');
  stateAssert(repositories.length === 1 && repositories[0]!.id === source.recipe.repositoryId &&
    repositories[0]!.full_name === source.recipe.repository, 'ownership-mismatch');
  const configuration = await client.get(`/orgs/${org}/settings/network-configurations/${plan.runner.networkConfigurationId}`);
  stateAssert(configuration.id === plan.runner.networkConfigurationId && configuration.compute_service === 'actions' &&
    canonicalSha256(configuration.network_settings_ids) === canonicalSha256([plan.runner.networkSettingsId]) &&
    configuration.failover_network_enabled !== true, 'ownership-mismatch');
  const network = await client.get(`/orgs/${org}/settings/network-settings/${plan.runner.networkSettingsId}`);
  stateAssert(network.id === plan.runner.networkSettingsId && network.subnet_id === source.recipe.runnerSubnetId &&
    network.region === source.recipe.target.region, 'ownership-mismatch');
  const runners = await client.list(`/orgs/${org}/actions/runner-groups/${plan.runner.groupId}/hosted-runners`, 'runners');
  const selfHosted = await client.list(`/orgs/${org}/actions/runner-groups/${plan.runner.groupId}/runners`, 'runners');
  stateAssert(selfHosted.length === 0 && runners.length === 1 && runners[0]!.id === plan.runner.definitionId &&
    runners[0]!.runner_group_id === plan.runner.groupId && runners[0]!.name === source.recipe.runnerLabel &&
    runners[0]!.status === 'Ready' && runners[0]!.public_ip_enabled === false, 'ownership-mismatch');
  return { groupId: plan.runner.groupId, definitionId: plan.runner.definitionId,
    networkConfigurationId: plan.runner.networkConfigurationId, networkSettingsId: plan.runner.networkSettingsId };
}

async function observeRecordedOperation(
  input: PhaseAdapterExecutionInput, client: GitHubActivationClient, original: TransitionOperation,
  binding: WorkflowRunBinding, dispatchInputs: Record<string, string>, identity: WorkflowEffectIdentity
) {
  const records = await readWorkflowEffect(input, original, identity, { workflow: binding, dispatchInputs });
  stateAssert(records, 'recovery-required');
  stateAssert(!records.response || [200, 204].includes(records.response.status), 'recovery-conflict');
  let id = records.observed?.providerId ?? records.response?.providerId;
  if (!id) {
    const candidates = await client.list(`/repos/${binding.repository}/actions/workflows/${binding.workflowId}/runs?branch=${binding.ref}&event=workflow_dispatch&head_sha=${binding.sourceSha}`, 'workflow_runs');
    const matches = candidates.filter((run) => run.workflow_id === binding.workflowId && run.head_sha === binding.sourceSha &&
      run.head_branch === binding.ref && run.path === binding.workflowPath && run.event === 'workflow_dispatch' &&
      run.run_attempt === 1 && object(run.actor).id === binding.actorId && object(run.triggering_actor).id === binding.actorId &&
      object(run.repository).id === binding.repositoryId &&
      run.display_title === `liftoff-${records.prepared.correlationId}` &&
      typeof run.created_at === 'string' && Date.parse(run.created_at) >= Math.floor(Date.parse(records.prepared.preparedAt) / 1000) * 1000);
    stateAssert(matches.length === 1, 'recovery-required');
    id = String(positiveId(matches[0]!.id));
  }
  const runId = positiveId(Number(id));
  const resourceId = `/repos/${binding.repository}/actions/runs/${runId}`;
  const response = await client.transport.request({ method: 'GET', path: resourceId });
  stateAssert(response.status === 200 && isRecord(response.data), 'incomplete-observation');
  const current = response.data;
  stateAssert(current.id === runId && current.run_attempt === 1 && current.head_sha === binding.sourceSha &&
    current.workflow_id === binding.workflowId && current.path === binding.workflowPath && current.head_branch === binding.ref &&
    object(current.actor).id === binding.actorId && object(current.triggering_actor).id === binding.actorId &&
    current.display_title === `liftoff-${records.prepared.correlationId}`, 'recovery-conflict');
  if (!records.observed) await recordWorkflowProviderResult(input, original, identity, records.prepared, 'observed', {
    status: 200, requestId: response.headers['x-github-request-id'] ?? null, providerId: String(runId), resourceId
  });
  const operation: ExternalOperationState = {
    provider: 'github', actionId: original.actionId, operationId: String(runId), resourceId,
    startedAt: records.prepared.preparedAt, observedAt: (input.clock?.() ?? input.now).toISOString(),
    status: current.status === 'completed' ? current.conclusion === 'success' ? 'completed' : 'failed' : 'running',
    planDigest: records.prepared.planDigest
  };
  return { records, operation };
}

export async function executePrivateBackendProof(
  input: PhaseAdapterExecutionInput, ports: PrivateBackendProofPorts = {}
): Promise<PhaseAdapterOutcome> {
  let close: (() => void) | null = null;
  let retainedOperation: ExternalOperationState | undefined;
  const completed: TransitionOperation[] = [];
  try {
    const planned = planPrivateBackendProof(input);
    const reviewed = input.plan.operations.filter((op) => ['github.runner.backend-proof', 'azure.remote-state.read',
      ...Object.values(privateBackendLeaseActions)].includes(op.actionId));
    if (planned.blockers?.length || canonicalSha256(planned.operations) !== canonicalSha256(reviewed)) return {
      status: 'blocked', blocker: planned.blockers?.join(' ') ?? 'The exact reviewed lease proof changed.', completedOperations: []
    };
    const plan = leasePlan(input);
    const githubOp = reviewed.find((op) => op.actionId === 'github.runner.backend-proof')!;
    const azureOp = reviewed.find((op) => op.actionId === 'azure.remote-state.read')!;
    const authorize = async () => {
      await assertAzurePhaseAuthority(input, githubOp);
      await assertAzurePhaseAuthority(input, azureOp);
    };
    await authorize();
    const activeAuthority = async () => {
      await authorize();
      const envelope = input.inspection.approvals.find((entry) => entry.id === input.plan.approval.envelopeId);
      stateAssert(envelope && (input.clock?.() ?? input.now).getTime() < Date.parse(plan.challenge.activeUntil) &&
        Date.parse(plan.challenge.releaseUntil) <= Date.parse(input.plan.expiresAt) &&
        Date.parse(plan.challenge.releaseUntil) <= Date.parse(envelope.expiresAt), 'expired');
    };
    if (mode(input) === 'execute') await activeAuthority();
    let client = ports.client;
    if (!client && input.adapters.githubActivation?.transport) client = new GitHubActivationClient(input.adapters.githubActivation.transport);
    if (!client) {
      const session = await openPrivateRunnerGitHubSession(input.runner, input.inspection.projectRoot, plan.source.actorId);
      client = session.client; close = session.close;
    }
    const execution: PhaseAdapterExecutionInput = { ...input, adapters: { ...input.adapters, githubActivation: {
      ...input.adapters.githubActivation, transport: client.transport,
      storage: input.adapters.githubActivation?.storage ?? azurePorts(input).storage
    } } };
    const audit = ports.audit ?? new PrivateBackendAuditClient({
      runner: input.runner, projectRoot: input.inspection.projectRoot, target: plan.source.recipe.target,
      binding: plan.audit, arm: azurePorts(input).transport, authorize,
      now: () => (input.clock?.() ?? input.now).getTime()
    });
    const runner = await assignment(client, plan);
    await audit.inspect();
    const workflow = privateBackendWorkflowBinding(plan.source);
    const dispatchInputs = privateBackendDispatchInputs(plan.challenge, plan.configurationDigest, plan.runner.groupId);
    const originalDispatch = dispatchOperation(input, plan);
    const identity: WorkflowEffectIdentity = {
      repositoryId: workflow.repositoryId, ref: `${workflow.ref}:${workflow.workflowId}`, purpose: 'workflow-dispatch', step: 'dispatch'
    };
    const workflowRecords = await readWorkflowEffect(execution, originalDispatch, identity, { workflow, dispatchInputs });
    const leaseOps = privateLeaseSteps.map((step) => leaseOperation(input, plan, step));
    const checkpoints: PrivateEffectCheckpoint[] = [];
    for (const op of leaseOps) {
      const checkpoint = await readPrivateEffect(input, op, effectIntent(op));
      if (checkpoint) checkpoints.push(checkpoint);
    }
    if (workflowRecords) {
      stateAssert(checkpoints.length === leaseOps.length && checkpoints.every((checkpoint, index) =>
        checkpoint.prepared.operationDigest === canonicalSha256(leaseOps[index]) &&
        checkpoint.prepared.planDigest === workflowRecords.prepared.planDigest &&
        checkpoint.prepared.approvalEnvelopeHash === workflowRecords.prepared.approvalEnvelopeHash &&
        checkpoint.prepared.clientRequestId === plan.challenge.clientRequestIds[privateLeaseSteps[index]!] &&
        Date.parse(checkpoint.prepared.preparedAt) <= Date.parse(workflowRecords.prepared.preparedAt)), 'recovery-required');
    }
    else {
      stateAssert(mode(input) === 'execute' && checkpoints.length === 0 &&
        !input.inspection.state.phases['private-backend-proof'].operation, 'recovery-required');
      for (const op of leaseOps) {
        await activeAuthority();
        checkpoints.push(await preparePrivateEffect(input, op, effectIntent(op), String(op.inputs.clientRequestId)));
      }
    }
    let external: ExternalOperationState;
    let correlationId: string;
    if (workflowRecords) {
      const observed = await observeRecordedOperation(execution, client, originalDispatch, workflow, dispatchInputs, identity);
      external = observed.operation; correlationId = observed.records.prepared.correlationId;
    } else {
      await activeAuthority();
      const result = await dispatchApprovedWorkflowRun(execution, githubOp, workflow, dispatchInputs);
      external = result.operation;
      const records = await readWorkflowEffect(execution, originalDispatch, identity, { workflow, dispatchInputs });
      stateAssert(records, 'recovery-required');
      correlationId = records.prepared.correlationId;
    }
    retainedOperation = external;
    if (external.status === 'running') return { status: 'pending', operation: external, completedOperations: [],
      blocker: 'The exact checkpointed backend lease workflow is still running; no lease effect is retried.' };
    stateAssert(external.status === 'completed', 'verification-incomplete');
    await authorize();
    const proof = await readPrivateBackendReport(client, {
      source: plan.source, operation: external, challenge: plan.challenge, correlationId,
      configurationDigest: plan.configurationDigest, runnerGroupId: plan.runner.groupId
    }, input.clock?.() ?? input.now);
    completed.push(githubOp);
    for (let index = 0; index < checkpoints.length; index++) {
      let checkpoint = checkpoints[index]!;
      const effect = proof.report.probe?.effects[index];
      if (!effect) continue;
      if (effect.outcome === 'returned') {
        stateAssert(effect.requestId && effect.status !== null &&
          (!checkpoint.settled || checkpoint.settled.outcome === 'verified'), 'verification-incomplete');
        if (checkpoint.submitted) stateAssert(checkpoint.submitted.requestId === effect.requestId &&
          checkpoint.submitted.status === effect.status && checkpoint.submitted.resourceId === blobUrl(plan), 'recovery-conflict');
        else checkpoint = await submitPrivateEffect(input, checkpoint, { requestId: effect.requestId, status: effect.status, resourceId: blobUrl(plan) });
      } else {
        stateAssert(!checkpoint.submitted && (!checkpoint.settled ||
          effect.outcome === 'not-attempted' && checkpoint.settled.outcome === 'not-dispatched'), 'recovery-conflict');
        if (effect.outcome === 'not-attempted' && !checkpoint.settled) checkpoint = await settlePrivateEffect(
          input, checkpoint, { outcome: 'not-dispatched', readbackRequestId: null, readbackDigest: null }
        );
      }
      checkpoints[index] = checkpoint;
    }
    if (proof.report.failure !== null || proof.report.probe?.outcome !== 'verified') return {
      status: 'blocked', completedOperations: completed, operation: external,
      blocker: 'The actual backend report did not prove acquired, exclusive, renewed and released locking. Unknown effects and original checkpoints are retained; no automatic retry or state creation is authorized.'
    };
    const independent: PrivateBackendAuditObservation = await audit.verify(proof.report, plan.challenge, plan.source.recipe.azureClientId);
    await assignment(client, plan);
    await authorize();
    for (let index = 0; index < checkpoints.length; index++) {
      const checkpoint = checkpoints[index]!;
      const effect = proof.report.probe.effects[index]!;
      const readbackDigest = canonicalSha256({ effect, audit: independent.records[index] });
      if (checkpoint.settled) stateAssert(checkpoint.settled.outcome === 'verified' &&
        checkpoint.settled.readbackRequestId === effect.requestId && checkpoint.settled.readbackDigest === readbackDigest, 'recovery-conflict');
      if (!checkpoint.settled) await settlePrivateEffect(input, checkpoint, {
        outcome: 'verified', readbackRequestId: effect.requestId, readbackDigest
      });
      if (mode(input) === 'execute') completed.push(leaseOps[index]!);
    }
    completed.push(azureOp);
    const payload = {
      kind: 'private-backend-proof.v1', leaseIntentDigest: plan.challenge.intentDigest,
      source: { workflowId: plan.source.workflowId, workflowPath: plan.source.recipe.workflowPath,
        workflowDigest: plan.source.workflowDigest, sourceSha: plan.source.sourceSha },
      runId: Number(external.operationId), runAttempt: 1, jobId: proof.jobId, checkRunId: proof.checkRunId,
      runner, report: proof.report, reportDigest: canonicalSha256(proof.report), artifactId: proof.artifactId,
      independentAudit: independent, statePayloadRead: false, stateContentWritten: false, atomicAcrossProviders: false
    };
    const backend = plan.source.recipe.target.backend;
    const resourceId = `/subscriptions/${backend.subscriptionId}/resourceGroups/${backend.resourceGroup}` +
      `/providers/Microsoft.Storage/storageAccounts/${backend.account}/blobServices/default/containers/${backend.container}`;
    return {
      status: 'completed', resultState: 'verified', evidencePayload: payload, completedOperations: completed, operation: external,
      liveReadback: [readbackProof(input, 'github', 'private-backend-workflow', external.resourceId, payload),
        readbackProof(input, 'azure', 'private-backend-lease', resourceId, { target: plan.source.recipe.target, report: proof.report, independent })],
      outputs: { values: {
        'backend.id': backend.id, 'backend.leaseProofIntentDigest': plan.challenge.intentDigest,
        'backend.leaseProofRunId': Number(external.operationId), 'backend.leaseProofReportDigest': canonicalSha256(proof.report),
        'backend.leaseProofAuditDigest': independent.digest, 'backend.exclusiveLeaseAcquired': true, 'backend.leaseReleased': true
      }, resources: [{ provider: 'azure', resourceType: 'private-backend-lease', resourceId },
        { provider: 'github', resourceType: 'workflow-run', resourceId: external.resourceId }] }
    };
  } catch (error) {
    return { status: 'blocked', blocker: failure(error), completedOperations: completed,
      ...(retainedOperation ? { operation: retainedOperation } : {}),
      cleanupWarnings: ['Private lease effect and workflow checkpoints are retained. No content mutation, forced unlock, replacement or cross-provider rollback was attempted.'] };
  } finally { close?.(); }
}

/** Standalone local verification still uses the released state adapter and separately admitted write recorder. */
export async function probeExclusivePrivateLease(
  path: AzurePrivateStatePath, context: StateExecutionContext, operationId: string,
  authorize: () => Promise<void>, signal?: AbortSignal
): Promise<{ backendId: string; leaseKind: 'blob-lease'; released: true }> {
  await authorize();
  const metadata = await path.backend.metadata(context, signal);
  stateAssert(metadata.exists, 'lock-unavailable');
  let lease: StateBackendLease | null = null;
  try {
    await authorize();
    lease = await path.backend.acquire(metadata, context, operationId, signal);
    stateAssert(lease.kind === 'blob-lease', 'lock-unavailable');
    await authorize();
    await lease.assertHeld(signal);
    const current = await path.backend.metadata(context, signal);
    stateAssert(current.etag === metadata.etag && current.version === metadata.version, 'stale-state');
  } finally {
    if (lease) { await authorize(); await lease.release(); }
  }
  return { backendId: path.target.backend.id, leaseKind: 'blob-lease', released: true };
}
