import { unlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executePrivateRunner, planPrivateRunner, privateRunnerAssignmentIntent, privateRunnerPlanForInspection,
  validatePrivateRunnerApplicationSource, verifyPrivateRunnerAssignment
} from '../src/application/azure-activation/producer-runner.js';
import { validatePrivateRunnerAssignment } from '../src/application/azure-activation/private-runner-assignment.js';
import { privateApplicationWorkflowContent, type PrivateRunnerApplicationSource } from '../src/application/azure-activation/private-runner-application-sources.js';
import { readPrivateEffect } from '../src/application/azure-activation/private-checkpoints.js';
import { assertAzurePhaseAuthority } from '../src/application/azure-activation/authority.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import type { PhaseAdapterExecutionInput } from '../src/governance-activation/transition-ports.js';
import type { RecordedWorkflowRunIdentity } from '../src/adapters/github/workflow-run-readback.js';
import { privateActivationFixture } from './helpers/private-activation-fixture.js';
import { bootstrapRunnerOutputs, privateRunnerHttpFixture, runnerSource } from './helpers/private-runner-http-fixture.js';
import { privateApplicationSourceFixture } from './helpers/private-runner-application-fixture.js';

const fixtures: Awaited<ReturnType<typeof privateActivationFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

async function fixture() {
  const source = runnerSource();
  const configuration = {
    organizationId: 7, actorId: 9, networkConfigurationName: 'repo-private-network',
    runnerGroupName: source.recipe.runnerGroupName, runnerName: source.recipe.runnerLabel,
    imageId: 'ubuntu-24.04', machineSize: '4-core', maxRunners: 2, source, expiresAt: '2026-09-15T00:30:00.000Z'
  };
  const f = await privateActivationFixture('runner-ready', configuration);
  fixtures.push(f);
  f.inspection.state.phases['bootstrap-local'].state = 'verified';
  f.inspection.state.phaseOutputs = { 'bootstrap-local': bootstrapRunnerOutputs() };
  const originInput = await f.execution(planPrivateRunner(f.planning()));
  const originalPlan = structuredClone(originInput.plan);
  let current = originInput, sequence = 0, preparedChecks = 0;
  const http = privateRunnerHttpFixture(source, undefined, {
    async beforePatch(request) {
      const op = current.plan.operations.find((entry) => entry.inputs.step === 'reconcile-workflow-assignment')!;
      const intent = privateRunnerAssignmentIntent(privateRunnerPlanForInspection(current), sequence);
      const checkpoint = await readPrivateEffect(current, op, intent);
      expect(checkpoint?.prepared).toMatchObject({
        planDigest: current.plan.planDigest, approvalEnvelopeHash: current.plan.approval.envelopeHash,
        operationDigest: canonicalSha256(op)
      });
      expect(checkpoint?.submitted).toBeNull();
      expect(request.path).toBe(intent.resourceId);
      expect(request.body).toEqual(intent.request.body);
      const revision = await createScopedUserLocalRecordStore(f.projectRoot, 'governance-operation', f.storage).read(canonicalSha256({
        kind: 'private-runner-group-revision/1', repositoryId: 42, organizationId: 7, groupId: 55, sequence
      }));
      expect(revision?.value).toMatchObject({ kind: 'private-runner-group-revision', sequence, plan: { planDigest: current.plan.planDigest } });
      preparedChecks++;
    }
  });
  const execute = (input = current, pollAttempts = 3) => withProjectMutationLock(f.projectRoot, (lease) =>
    executePrivateRunner({ ...input, lease }, { client: http.client, pollAttempts }));
  const created = await execute();
  if (created.status !== 'completed' || !isRecord(created.evidencePayload)) throw new Error('The exact fixture base runner was not established.');
  if (!isRecord(created.evidencePayload.assignment)) throw new Error('Missing actual assignment metadata.');
  const binding = validatePrivateRunnerAssignment(created.evidencePayload.assignment.binding);
  f.inspection.contexts['runner-ready'].reviewedPlans = [originalPlan];
  f.inspection.state.phases['runner-ready'].state = 'verified';
  const dev = privateApplicationSourceFixture(binding, 'environment-runtime');
  const start = async (sources: readonly PrivateRunnerApplicationSource[], options: { issue?: boolean; recovery?: boolean } = {}) => {
    for (const source of sources) http.publishApplication(source);
    const group = http.group();
    if (!group || !Array.isArray(group.selected_workflows)) throw new Error('The exact fixture group is missing.');
    f.inspection.activationInputs!.phases['runner-ready'] = {
      ...configuration, ...(sources.length ? { applicationSources: sources } : {}),
      reconciliation: {
        originPlanDigest: originalPlan.planDigest, groupId: binding.groupId, definitionId: binding.definitionId,
        networkConfigurationId: binding.networkConfigurationId, expectedWorkflows: [...group.selected_workflows]
      }
    };
    current = await f.execution(planPrivateRunner(f.planning()), options);
    return current;
  };
  const checkpoint = async () => {
    const op = current.plan.operations.find((entry) => entry.inputs.step === 'reconcile-workflow-assignment')!;
    return readPrivateEffect(current, op, privateRunnerAssignmentIntent(privateRunnerPlanForInspection(current), sequence));
  };
  const patches = () => http.calls.filter((call) => call.method === 'PATCH');
  return { f, http, binding, dev, originInput, originalPlan, start, execute, checkpoint, patches,
    get staging() { return privateApplicationSourceFixture(binding, 'staging-security'); },
    input: () => current, checks: () => preparedChecks, revision: (value: number) => { sequence = value; } };
}

describe('exact published private application runner assignment', () => {
  it.each(['environment-runtime', 'staging-security'] as const)(
    'includes a names-only published %s recipe in the initial allowlist without inventing future IDs', async (kind) => {
    const source = runnerSource();
    const application = privateApplicationSourceFixture({
      repository: 'owner/repo', repositoryId: 42, runnerGroupName: source.recipe.runnerGroupName, runnerName: source.recipe.runnerLabel
    }, kind);
    expect(application.recipe.runner).toEqual({ group: source.recipe.runnerGroupName, label: source.recipe.runnerLabel });
    const f = await privateActivationFixture('runner-ready', {
      organizationId: 7, actorId: 9, networkConfigurationName: 'repo-private-network',
      runnerGroupName: source.recipe.runnerGroupName, runnerName: source.recipe.runnerLabel,
      imageId: 'ubuntu-24.04', machineSize: '4-core', maxRunners: 2, source, applicationSources: [application],
      expiresAt: '2026-09-15T00:30:00.000Z'
    });
    fixtures.push(f);
    f.inspection.state.phases['bootstrap-local'].state = 'verified';
    f.inspection.state.phaseOutputs = { 'bootstrap-local': bootstrapRunnerOutputs() };
    const input = await f.execution(planPrivateRunner(f.planning()));
    const http = privateRunnerHttpFixture(source);
    http.publishApplication(application);
    const result = await withProjectMutationLock(f.projectRoot, (lease) => executePrivateRunner({ ...input, lease }, { client: http.client }));
    expect(result).toMatchObject({
      status: 'completed', evidencePayload: { assignment: { binding: { groupId: 55, definitionId: 300 } } }
    });
    expect(http.calls.find((call) => call.method === 'POST' && call.path === '/orgs/owner/actions/runner-groups')?.body)
      .toMatchObject({ selected_workflows: [
        'owner/repo/.github/workflows/liftoff-bootstrap-private.yml@refs/heads/develop',
        `owner/repo/${application.recipe.workflowPath}@refs/heads/develop`
      ] });
    expect(http.calls.some((call) => call.method === 'PATCH')).toBe(false);
    expect(http.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dispatches'))).toHaveLength(1);
  });

  it('plans a separate exact read/PATCH pair, then assigns published dev and staging sources without another dispatch', async () => {
    const f = await fixture();
    const before = f.http.calls.length;
    const input = await f.start([f.dev, f.staging]);
    expect(f.http.calls).toHaveLength(before);
    expect(input.plan.operations.map((op) => [op.actionId, op.mutationClass, op.inputs.step])).toEqual([
      ['github.runner.ensure-ready', 'github-read', 'read-owned-assignment'],
      ['github.runner.ensure-ready', 'github-write', 'reconcile-workflow-assignment']
    ]);
    const outcome = await f.execute();
    expect(outcome).toMatchObject({
      status: 'completed', evidencePayload: { scope: 'workflow-assignment-only', networkReachability: 'not-reprobed',
        disposition: 'reconciled-and-read-back', atomicAcrossClients: false },
      outputs: { values: { 'runner.groupId': 55, 'runner.definitionId': 300, 'runner.networkConfigurationId': 'ncfg81' } }
    });
    expect(f.patches()).toHaveLength(1);
    expect(f.patches()[0]!.body).toEqual({
      name: f.binding.runnerGroupName, restricted_to_workflows: true,
      selected_workflows: [
        ...f.binding.allowedWorkflows,
        'owner/repo/.github/workflows/liftoff-environment-dev.yml@refs/heads/develop',
        'owner/repo/.github/workflows/liftoff-staging-security.yml@refs/heads/develop'
      ]
    });
    expect(f.checks()).toBe(1);
    expect(await f.checkpoint()).toMatchObject({
      submitted: { requestId: f.http.lastPatchRequestId(), resourceId: '/orgs/owner/actions/runner-groups/55', status: 200 },
      settled: { outcome: 'verified' }
    });
    expect(f.http.calls.filter((call) => call.method === 'POST')).toHaveLength(4);
    expect(f.http.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dispatches')))
      .toHaveLength(1);
    const repeated = await f.execute();
    expect(repeated.status, repeated.blocker).toBe('completed');
    expect(f.patches()).toHaveLength(1);
  });

  it('supports a later separately approved revision without overwriting earlier private custody', async () => {
    const f = await fixture();
    await f.start([f.dev]);
    expect((await f.execute()).status).toBe('completed');
    const original = await f.checkpoint();
    f.revision(1);
    await f.start([f.dev, f.staging], { recovery: true });
    expect((await f.execute()).status).toBe('completed');
    expect(f.patches()).toHaveLength(2);
    expect((await f.checkpoint())?.prepared.approvalEnvelopeHash).not.toBe(original?.prepared.approvalEnvelopeHash);
    expect(f.http.calls.filter((call) => call.method === 'POST')).toHaveLength(4);
  });

  it('performs zero PATCH when the exact privately owned before-state already matches the reviewed assignment', async () => {
    const f = await fixture();
    await f.start([]);
    expect(await f.execute()).toMatchObject({
      status: 'completed', evidencePayload: { disposition: 'already-matching', mutationRequestId: null }
    });
    expect(f.patches()).toHaveLength(0);
    expect(f.http.calls.filter((call) => call.method === 'POST')).toHaveLength(4);
  });

  it('does not expand assignment from an unissued public approval or read-only operation', async () => {
    const f = await fixture();
    const before = f.http.calls.length;
    await f.start([f.dev], { issue: false });
    expect((await f.execute()).status).toBe('blocked');
    expect(f.http.calls).toHaveLength(before);
    const issued = await f.start([f.dev]);
    const readonly = await f.f.execution({ operations: [issued.plan.operations[0]!] });
    expect((await f.execute(readonly)).status).toBe('blocked');
    expect(f.patches()).toHaveLength(0);
  });

  it('requires the actual project lease before provider access', async () => {
    const f = await fixture();
    const input = await f.start([f.dev]);
    const before = f.http.calls.length;
    expect((await executePrivateRunner(input, { client: f.http.client })).status).toBe('blocked');
    expect(f.http.calls).toHaveLength(before);
  });

  it('refuses a matching group name when the exact original private creation plan is missing', async () => {
    const f = await fixture();
    await f.start([f.dev]);
    f.f.inspection.contexts['runner-ready'].reviewedPlans = [];
    const result = await f.execute();
    expect(result.status).toBe('blocked');
    expect(result.blocker).toContain('original runner creation plan');
    expect(f.patches()).toHaveLength(0);
  });

  it.each(['groupId', 'definitionId', 'networkConfigurationId'] as const)('refuses an asserted replacement %s despite a matching name', async (field) => {
    const f = await fixture();
    await f.start([f.dev]);
    const configuration = f.f.inspection.activationInputs!.phases['runner-ready']!;
    if (!isRecord(configuration.reconciliation)) throw new Error('Missing explicit reconciliation.');
    configuration.reconciliation[field] = field === 'networkConfigurationId' ? 'foreign-network' : 99;
    const input = await f.f.execution(planPrivateRunner(f.f.planning()));
    expect((await f.execute(input)).status).toBe('blocked');
    expect(f.patches()).toHaveLength(0);
    expect(f.http.calls.filter((call) => call.method === 'POST')).toHaveLength(4);
  });

  it('does not recreate lost original group custody from live name/ID presence', async () => {
    const f = await fixture();
    await f.start([f.dev]);
    const origin = f.originalPlan.operations.find((op) => op.inputs.step === 'runner-group')!;
    const base = canonicalSha256({
      kind: 'private-access-effects/1', phaseId: 'runner-ready', actionId: origin.actionId,
      destination: origin.destination, effect: 'runner-group', step: f.binding.runnerGroupName, provider: 'github',
      target: '/orgs/owner/actions/runner-groups'
    });
    const key = canonicalSha256({ intent: base, attempt: 0 });
    const store = createScopedUserLocalRecordStore(f.f.projectRoot, 'governance-operation', f.f.storage);
    const record = await store.read(canonicalSha256({ key, stage: 'prepared' }));
    if (!record || !record.path.startsWith(f.f.home)) throw new Error('Missing owned test checkpoint.');
    await unlink(record.path);
    expect((await f.execute()).status).toBe('blocked');
    expect(f.patches()).toHaveLength(0);
  });

  it.each(['groupRepositoryIds', 'wrongSubnet', 'foreignNetworkAssignment', 'extraHostedRunner', 'selfHostedRunner'] as const)(
    'preserves foreign or mismatched %s instead of changing it', async (fault) => {
      const f = await fixture();
      await f.start([f.dev]);
      if (fault === 'groupRepositoryIds') f.http.state.groupRepositoryIds = [42, 43];
      else f.http.state[fault] = true;
      expect((await f.execute()).status).toBe('blocked');
      expect(f.patches()).toHaveLength(0);
      expect(f.http.calls.filter((call) => call.method === 'POST')).toHaveLength(4);
    }
  );

  it.each(['applicationSourceChanged', 'applicationUnregistered', 'sourceMoved'] as const)(
    'refuses %s before any allowlist mutation', async (fault) => {
      const f = await fixture();
      await f.start([f.dev]);
      f.http.state[fault] = true;
      expect((await f.execute()).status).toBe('blocked');
      expect(f.patches()).toHaveLength(0);
    }
  );

  it('refuses provider-read-only controls instead of treating read authority as permission to widen', async () => {
    const f = await fixture();
    await f.start([f.dev]);
    f.http.state.assignmentReadOnly = true;
    expect((await f.execute()).status).toBe('blocked');
    expect(f.patches()).toHaveLength(0);
    expect((await f.checkpoint())?.settled?.outcome).toBe('not-dispatched');
  });

  it('retains a lost PATCH response and blocks both retry and target/source evasion', async () => {
    const f = await fixture();
    await f.start([f.dev]);
    f.http.state.assignmentLost = true;
    const failed = await f.execute();
    expect(failed.status).toBe('blocked');
    expect(JSON.stringify(failed)).not.toContain('SYNTHETIC_SECRET');
    expect((await f.checkpoint())?.submitted).toBeNull();
    expect((await f.execute()).status).toBe('blocked');
    await f.start([f.dev, f.staging], { recovery: true });
    expect((await f.execute()).status).toBe('blocked');
    expect(f.patches()).toHaveLength(1);
  });

  it('does not call a returned5xx a known rejection or retry it when the group now matches', async () => {
    const f = await fixture();
    await f.start([f.dev]);
    f.http.state.assignmentServerError = true;
    expect((await f.execute()).status).toBe('blocked');
    expect(await f.checkpoint()).toMatchObject({ submitted: { status: 500 }, settled: null });
    expect((await f.execute()).status).toBe('blocked');
    expect(f.patches()).toHaveLength(1);
  });

  it('allows a known rejection only through a fresh separately issued revision', async () => {
    const f = await fixture();
    await f.start([f.dev]);
    f.http.state.assignmentRejected = true;
    expect((await f.execute()).status).toBe('blocked');
    expect((await f.checkpoint())?.settled?.outcome).toBe('rejected');
    expect((await f.execute()).status).toBe('blocked');
    f.http.state.assignmentRejected = false;
    f.revision(1);
    await f.start([f.dev], { recovery: true });
    expect((await f.execute()).status).toBe('completed');
    expect(f.patches()).toHaveLength(2);
  });

  it('bounds propagation readback and continues the actual returned request without another PATCH', async () => {
    const f = await fixture();
    await f.start([f.dev]);
    f.http.state.assignmentPending = true;
    const pending = await f.execute();
    expect(pending).toMatchObject({ status: 'pending', operation: {
      operationId: f.http.lastPatchRequestId(), resourceId: '/orgs/owner/actions/runner-groups/55'
    } });
    expect((await f.execute()).status).toBe('pending');
    f.http.state.assignmentPending = false;
    expect((await f.execute()).status).toBe('completed');
    expect(f.patches()).toHaveLength(1);
  });

  it('retains a real returned effect when independent post-write ownership readback fails', async () => {
    const f = await fixture();
    await f.start([f.dev]);
    f.http.state.assignmentForeignAfter = true;
    expect((await f.execute()).status).toBe('blocked');
    expect(await f.checkpoint()).toMatchObject({ submitted: { status: 200 }, settled: null });
    expect(f.http.state.groupRepositoryIds).toEqual([42, 43]);
    expect(f.patches()).toHaveLength(1);
    f.http.state.groupRepositoryIds = [42];
    expect((await f.execute()).status).toBe('completed');
    expect(f.patches()).toHaveLength(1);
  });

  it('rejects invalid polling bounds before provider access', async () => {
    const f = await fixture();
    const input = await f.start([f.dev]);
    const before = f.http.calls.length;
    expect((await f.execute(input, 99)).status).toBe('blocked');
    expect(f.http.calls).toHaveLength(before);
  });

  it('exports read-only actual assignment/source verification without claiming application or DAST proof', async () => {
    const f = await fixture();
    const input = await f.start([f.dev, f.staging]);
    const result = await f.execute();
    if (!isRecord(result.evidencePayload) || !isRecord(result.evidencePayload.assignment)) throw new Error('No actual assignment readback.');
    const assignment = validatePrivateRunnerAssignment(result.evidencePayload.assignment.binding);
    const before = f.http.calls.length;
    const observation = await withProjectMutationLock(f.f.projectRoot, (lease) => verifyPrivateRunnerAssignment(f.http.client, assignment, {
      sources: [f.dev, f.staging], now: () => f.f.now,
      authorize: () => assertAzurePhaseAuthority({ ...input, lease }, input.plan.operations[0]!)
    }));
    expect(observation.binding).toMatchObject({ groupId: 55, definitionId: 300, subnetId: f.binding.subnetId });
    expect(observation.sources.map((source) => source.workflowId)).toEqual([31, 32]);
    expect(observation.job).toBeNull();
    expect(observation.requestIds.length).toBeGreaterThan(10);
    expect(f.http.calls.slice(before).every((call) => call.method === 'GET')).toBe(true);
  });

  it.each(['environment-runtime', 'staging-security'] as const)(
    'reads actual %s run/job/runner IDs without substituting the hosted definition ID or dispatching work', async (kind) => {
    const f = await fixture();
    const source = kind === 'environment-runtime' ? f.dev : f.staging;
    const input = await f.start([source]);
    const result = await f.execute();
    if (!isRecord(result.evidencePayload) || !isRecord(result.evidencePayload.assignment)) throw new Error('No actual assignment.');
    const assignment = validatePrivateRunnerAssignment(result.evidencePayload.assignment.binding);
    const run = f.http.observedApplicationRun(source.workflowId, 1900);
    const before = f.http.calls.length;
    const observed = await withProjectMutationLock(f.f.projectRoot, (lease) => verifyPrivateRunnerAssignment(f.http.client, assignment, {
      sources: [source], run, now: () => f.f.now,
      authorize: () => assertAzurePhaseAuthority({ ...input, lease }, input.plan.operations[0]!)
    }));
    expect(observed.job).toEqual({
      workflowId: source.workflowId, runId: 8000 + source.workflowId, runAttempt: 1, jobId: 8001 + source.workflowId,
      jobName: kind === 'environment-runtime' ? 'Liftoff environment runtime observation' : 'Liftoff staging security and DAST qualification',
      checkRunId: 8200 + source.workflowId,
      runnerId: 1900, runnerName: 'actual-application-runner', runnerGroupId: 55,
      runnerGroupName: f.binding.runnerGroupName, labels: ['self-hosted', f.binding.runnerName],
      sourceSha: source.sourceSha, producerSourceSha: source.sourceSha, conclusion: 'success'
    });
    expect(observed.job?.runnerId).not.toBe(observed.binding.definitionId);
    expect(observed.job?.runnerName).not.toBe(observed.binding.runnerName);
    expect(f.http.calls.slice(before).every((call) => call.method === 'GET')).toBe(true);
    expect(f.http.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dispatches'))).toHaveLength(1);
  });

  it('separates the immutable published workflow commit from the reviewed execution commit without following a moving ref', async () => {
    const f = await fixture();
    const input = await f.start([f.dev]);
    const result = await f.execute();
    if (!isRecord(result.evidencePayload) || !isRecord(result.evidencePayload.assignment)) throw new Error('No actual assignment.');
    const assignment = validatePrivateRunnerAssignment(result.evidencePayload.assignment.binding);
    const published = structuredClone(f.dev);
    const run = f.http.observedApplicationRun(f.dev.workflowId, 1900, 'e'.repeat(40));
    const before = f.http.calls.length;
    const observe = () => withProjectMutationLock(f.f.projectRoot, (lease) => verifyPrivateRunnerAssignment(f.http.client, assignment, {
      sources: [f.dev], run, now: () => f.f.now,
      authorize: () => assertAzurePhaseAuthority({ ...input, lease }, input.plan.operations[0]!)
    }));
    const observed = await observe();
    expect(observed.job).toMatchObject({ sourceSha: 'e'.repeat(40), producerSourceSha: published.sourceSha, runnerId: 1900 });
    expect(observed.sources).toEqual([{
      kind: 'environment-runtime', repository: 'owner/repo', repositoryId: 42, workflowId: 31,
      workflowPath: f.dev.recipe.workflowPath, workflowDigest: f.dev.workflowDigest,
      sourceSha: published.sourceSha, ref: 'develop', refSha: 'e'.repeat(40), blobSha: expect.stringMatching(/^[a-f0-9]{40}$/u)
    }]);
    const contentReads = f.http.calls.slice(before).filter((call) =>
      new URL(call.path, 'https://api.github.com').pathname === `/repos/owner/repo/contents/${f.dev.recipe.workflowPath}`);
    expect(new Set(contentReads.map((call) => new URL(call.path, 'https://api.github.com').searchParams.get('ref'))))
      .toEqual(new Set([published.sourceSha, 'e'.repeat(40)]));
    expect(f.dev).toEqual(published);
    f.http.setRefSha('f'.repeat(40));
    await expect(observe()).rejects.toThrow('branch ref or source bytes changed');
    expect(f.http.calls.slice(before).every((call) => call.method === 'GET')).toBe(true);
    expect(f.http.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dispatches'))).toHaveLength(1);
  });

  it('observes an original recorded run identity without supplying an asserted terminal status', async () => {
    const f = await fixture();
    const input = await f.start([f.dev]);
    const result = await f.execute();
    if (!isRecord(result.evidencePayload) || !isRecord(result.evidencePayload.assignment)) throw new Error('No actual assignment.');
    const assignment = validatePrivateRunnerAssignment(result.evidencePayload.assignment.binding);
    const run = f.http.observedApplicationRun(f.dev.workflowId, 1900);
    const value = run.operation;
    if (value.provider !== 'github' || !value.planDigest) throw new Error('No actual recorded fixture run.');
    const operation: RecordedWorkflowRunIdentity = {
      provider: value.provider, actionId: value.actionId, operationId: value.operationId, resourceId: value.resourceId,
      startedAt: value.startedAt, observedAt: value.observedAt, planDigest: value.planDigest
    };
    expect(operation).not.toHaveProperty('status');
    const before = f.http.calls.length;
    const observed = await withProjectMutationLock(f.f.projectRoot, (lease) => verifyPrivateRunnerAssignment(f.http.client, assignment, {
      sources: [f.dev], run: { workflow: run.workflow, operation }, now: () => f.f.now,
      authorize: () => assertAzurePhaseAuthority({ ...input, lease }, input.plan.operations[0]!)
    }));
    expect(observed.job).toMatchObject({ runId: 8031, runnerId: 1900, conclusion: 'success' });
    expect(f.http.calls.slice(before).every((call) => call.method === 'GET')).toBe(true);
    expect(f.http.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dispatches'))).toHaveLength(1);
  });

  it.each(['numeric-alias', 'foreign-repository'] as const)('rejects %s run identity before any provider read', async (fault) => {
    const f = await fixture();
    const input = await f.start([f.dev]);
    const result = await f.execute();
    if (!isRecord(result.evidencePayload) || !isRecord(result.evidencePayload.assignment)) throw new Error('No actual assignment.');
    const assignment = validatePrivateRunnerAssignment(result.evidencePayload.assignment.binding);
    const run = f.http.observedApplicationRun(f.dev.workflowId, 1900);
    if (fault === 'numeric-alias') run.operation.operationId = `0${run.operation.operationId}`;
    else run.operation.resourceId = '/repos/owner/foreign/actions/runs/8031';
    const before = f.http.calls.length;
    await expect(withProjectMutationLock(f.f.projectRoot, (lease) => verifyPrivateRunnerAssignment(f.http.client, assignment, {
      sources: [f.dev], run, authorize: () => assertAzurePhaseAuthority({ ...input, lease }, input.plan.operations[0]!)
    }))).rejects.toThrow('canonical provider run identity');
    expect(f.http.calls).toHaveLength(before);
  });

  it('refuses changed workflow bytes at the separately bound execution commit', async () => {
    const f = await fixture();
    const input = await f.start([f.dev]);
    const result = await f.execute();
    if (!isRecord(result.evidencePayload) || !isRecord(result.evidencePayload.assignment)) throw new Error('No actual assignment.');
    const assignment = validatePrivateRunnerAssignment(result.evidencePayload.assignment.binding);
    const run = f.http.observedApplicationRun(f.dev.workflowId, 1900, 'e'.repeat(40));
    f.http.state.applicationExecutionSourceChanged = true;
    const before = f.http.calls.length;
    await expect(withProjectMutationLock(f.f.projectRoot, (lease) => verifyPrivateRunnerAssignment(f.http.client, assignment, {
      sources: [f.dev], run, authorize: () => assertAzurePhaseAuthority({ ...input, lease }, input.plan.operations[0]!)
    }))).rejects.toThrow('branch ref or source bytes changed');
    expect(f.http.calls.slice(before).every((call) => call.method === 'GET')).toBe(true);
    expect(f.http.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dispatches'))).toHaveLength(1);
  });

  it.each(['missing-producer', 'wrong-producer', 'wrong-ref', 'wrong-event', 'wrong-workflow'] as const)(
    'refuses %s job admission before any GitHub read or dispatch', async (fault) => {
      const f = await fixture();
      const input = await f.start([f.dev]);
      const result = await f.execute();
      if (!isRecord(result.evidencePayload) || !isRecord(result.evidencePayload.assignment)) throw new Error('No actual assignment.');
      const assignment = validatePrivateRunnerAssignment(result.evidencePayload.assignment.binding);
      const run = f.http.observedApplicationRun(f.dev.workflowId, 1900, 'e'.repeat(40));
      if (fault === 'missing-producer') delete run.workflow.producerSourceSha;
      if (fault === 'wrong-producer') run.workflow.producerSourceSha = 'f'.repeat(40);
      if (fault === 'wrong-ref') run.workflow.ref = 'main';
      if (fault === 'wrong-event') run.workflow.event = 'push';
      if (fault === 'wrong-workflow') run.workflow.workflowId = 32;
      const before = f.http.calls.length;
      await expect(withProjectMutationLock(f.f.projectRoot, (lease) => verifyPrivateRunnerAssignment(f.http.client, assignment, {
        sources: [f.dev], run, authorize: () => assertAzurePhaseAuthority({ ...input, lease }, input.plan.operations[0]!)
      }))).rejects.toThrow('exact published selected workflow binding');
      expect(f.http.calls).toHaveLength(before);
    }
  );

  it.each([
    ['missing-runner-id', 'runner_id', null],
    ['non-provider-runner-id', 'runner_id', '1900'],
    ['zero-runner-id', 'runner_id', 0],
    ['missing-runner-name', 'runner_name', null],
    ['empty-runner-name', 'runner_name', ''],
    ['noncanonical-runner-name', 'runner_name', ' actual-application-runner '],
    ['oversized-runner-name', 'runner_name', 'r'.repeat(257)],
    ['control-runner-name', 'runner_name', 'runner\nname'],
    ['wrong-group-name', 'runner_group_name', 'different-group'],
    ['empty-labels', 'labels', []],
    ['duplicate-labels', 'labels', ['repo-private-linux', 'repo-private-linux']],
    ['missing-routing-label', 'labels', ['self-hosted']],
    ['non-string-label', 'labels', ['repo-private-linux', 42]],
    ['oversized-label', 'labels', ['repo-private-linux', 'r'.repeat(257)]],
    ['oversized-label-list', 'labels', ['repo-private-linux', ...Array.from({ length: 100 }, (_, i) => `label-${i}`)]]
  ] as const)('rejects actual %s instead of inventing job metadata from the hosted definition', async (_name, field, value) => {
    const f = await fixture();
    const input = await f.start([f.dev]);
    const result = await f.execute();
    if (!isRecord(result.evidencePayload) || !isRecord(result.evidencePayload.assignment)) throw new Error('No actual assignment.');
    const assignment = validatePrivateRunnerAssignment(result.evidencePayload.assignment.binding);
    const run = f.http.observedApplicationRun(f.dev.workflowId, 1900);
    f.http.changeApplicationJob((job) => { job[field] = value; });
    const before = f.http.calls.length;
    await expect(withProjectMutationLock(f.f.projectRoot, (lease) => verifyPrivateRunnerAssignment(f.http.client, assignment, {
      sources: [f.dev], run, authorize: () => assertAzurePhaseAuthority({ ...input, lease }, input.plan.operations[0]!)
    }))).rejects.toThrow();
    expect(f.http.calls.slice(before).every((call) => call.method === 'GET')).toBe(true);
    expect(f.http.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dispatches'))).toHaveLength(1);
  });

  it.each([
    ['changed-name', 'name', 'Another job'],
    ['changed-head', 'head_sha', 'e'.repeat(40)],
    ['changed-status', 'status', 'in_progress'],
    ['changed-conclusion', 'conclusion', 'failure'],
    ['changed-check', 'check_run_url', 'https://api.github.com/repos/owner/repo/check-runs/9999'],
    ['changed-steps', 'steps', [{ name: 'Skipped verifier', number: 1, status: 'completed', conclusion: 'skipped' }]]
  ] as const)('rejects %s between independent check verification and actual runner observation', async (_name, field, value) => {
    const f = await fixture();
    const input = await f.start([f.dev]);
    const result = await f.execute();
    if (!isRecord(result.evidencePayload) || !isRecord(result.evidencePayload.assignment)) throw new Error('No actual assignment.');
    const assignment = validatePrivateRunnerAssignment(result.evidencePayload.assignment.binding);
    const run = f.http.observedApplicationRun(f.dev.workflowId, 1900);
    f.http.changeApplicationJob((job, read) => { if (read === 2) job[field] = value; });
    const before = f.http.calls.length;
    await expect(withProjectMutationLock(f.f.projectRoot, (lease) => verifyPrivateRunnerAssignment(f.http.client, assignment, {
      sources: [f.dev], run, authorize: () => assertAzurePhaseAuthority({ ...input, lease }, input.plan.operations[0]!)
    }))).rejects.toThrow('changed its exact run, check, steps or dedicated group');
    expect(f.http.calls.slice(before).every((call) => call.method === 'GET')).toBe(true);
    expect(f.http.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dispatches'))).toHaveLength(1);
  });

  it.each(['applicationWrongJobGroup', 'applicationWrongRunActor'] as const)('refuses actual %s readback without a substitute run', async (fault) => {
    const f = await fixture();
    const input = await f.start([f.dev]);
    const result = await f.execute();
    if (!isRecord(result.evidencePayload) || !isRecord(result.evidencePayload.assignment)) throw new Error('No actual assignment.');
    const assignment = validatePrivateRunnerAssignment(result.evidencePayload.assignment.binding);
    const run = f.http.observedApplicationRun(f.dev.workflowId, 900);
    f.http.state[fault] = true;
    await expect(withProjectMutationLock(f.f.projectRoot, (lease) => verifyPrivateRunnerAssignment(f.http.client, assignment, {
      sources: [f.dev], run, now: () => f.f.now,
      authorize: () => assertAzurePhaseAuthority({ ...input, lease }, input.plan.operations[0]!)
    }))).rejects.toThrow();
    expect(f.http.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dispatches'))).toHaveLength(1);
  });

  it.each([
    ['runnerId', 1900], ['runnerId', null], ['runnerGroupId', 55], ['definitionId', 300]
  ] as const)('rejects source routing containing %s=%s rather than guessing future provider identity', async (field, value) => {
    const f = await fixture();
    const malformed = { ...f.dev, recipe: { ...f.dev.recipe, runner: { ...f.dev.recipe.runner, [field]: value } } };
    const before = f.http.calls.length;
    expect(() => validatePrivateRunnerApplicationSource(malformed)).toThrow();
    const old = f.f.inspection.activationInputs!.phases['runner-ready']!;
    f.f.inspection.activationInputs!.phases['runner-ready'] = { ...old, applicationSources: [malformed] };
    const result = planPrivateRunner(f.f.planning());
    expect(result.operations).toEqual([]);
    expect(result.blockers).toHaveLength(1);
    expect(f.http.calls).toHaveLength(before);
  });

  it.each([0, 3])('requires current read authority again after %s actual provider GETs', async (allowedReads) => {
    const f = await fixture();
    const before = f.http.calls.length;
    let checks = 0;
    await expect(verifyPrivateRunnerAssignment(f.http.client, f.binding, {
      authorize: async () => {
        if (checks++ >= allowedReads) throw new Error('Current assignment read authority expired.');
      }
    })).rejects.toThrow('Current assignment read authority expired.');
    expect(checks).toBe(allowedReads + 1);
    expect(f.http.calls.slice(before)).toHaveLength(allowedReads);
    expect(f.http.calls.slice(before).every((call) => call.method === 'GET')).toBe(true);
    expect(f.http.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dispatches'))).toHaveLength(1);
  });

  it('rejects another group, forged recipe digest or repository instead of authorizing a named workflow', async () => {
    const f = await fixture();
    const wrong = structuredClone(f.dev);
    wrong.recipe.runner.group = 'another-group';
    wrong.workflowDigest = canonicalSha256(privateApplicationWorkflowContent(wrong));
    await expect(f.start([wrong])).rejects.toThrow();
    expect(() => validatePrivateRunnerApplicationSource({ ...f.dev, workflowDigest: '0'.repeat(64) })).toThrow();
    await expect(f.start([{ ...f.dev, repository: 'other/repo' }])).rejects.toThrow('repository-dedicated runner group');
    expect(f.patches()).toHaveLength(0);
  });
});
