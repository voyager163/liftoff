import { afterEach, describe, expect, it } from 'vitest';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { executePrivateRunner, planPrivateRunner, privateRunnerPlanForInspection, privateRunnerReachabilityAction } from '../src/application/azure-activation/producer-runner.js';
import {
  observePrivateRunnerRun, privateRunnerWorkflowBinding, readPrivateReportArchive, renderPrivateRunnerWorkflow,
  validatePrivateRunnerReport, validatePrivateRunnerSource
} from '../src/application/azure-activation/private-runner-workflow.js';
import { planPrivateBackendProof } from '../src/application/azure-activation/private-backend-proof.js';
import { renderPrivateBackendWorkflow, type PrivateBackendWorkflowSource } from '../src/application/azure-activation/private-backend-workflow.js';
import { readWorkflowEffect } from '../src/application/repository-governance/workflow-checkpoints.js';
import { preparePrivateEffect, type PrivateEffectCheckpoint } from '../src/application/azure-activation/private-checkpoints.js';
import { createScopedUserLocalRecordStore, nodeUpdatePreviewFileSystem } from '../src/adapters/filesystem/update-previews.js';
import { dispatchApprovedWorkflowRun } from '../src/adapters/github/production-checks.js';
import { githubOperation } from '../src/governance-activation/github-config.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { fixtureTime, privateActivationFixture } from './helpers/private-activation-fixture.js';
import { bootstrapRunnerOutputs, privateRunnerHttpFixture, runnerSource, singleReportZip } from './helpers/private-runner-http-fixture.js';
import { backendSource } from './helpers/private-backend-http-fixture.js';

const fixtures: Awaited<ReturnType<typeof privateActivationFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

async function planningFixture(backend?: PrivateBackendWorkflowSource) {
  const source = runnerSource();
  const f = await privateActivationFixture('runner-ready', {
    organizationId: 7, actorId: 9, networkConfigurationName: 'repo-private-network',
    runnerGroupName: source.recipe.runnerGroupName, runnerName: source.recipe.runnerLabel,
    imageId: 'ubuntu-24.04', machineSize: '4-core', maxRunners: 2, source, expiresAt: '2026-09-15T00:30:00.000Z',
    ...(backend ? { backendSource: backend } : {})
  });
  fixtures.push(f);
  f.inspection.state.phases['bootstrap-local'].state = 'verified';
  f.inspection.state.phaseOutputs = { 'bootstrap-local': bootstrapRunnerOutputs() };
  return { f, source };
}

async function fixture(backend?: PrivateBackendWorkflowSource) {
  const { f, source } = await planningFixture(backend);
  const input = await f.execution(planPrivateRunner(f.planning()));
  const http = privateRunnerHttpFixture(source, backend);
  const execute = () => withProjectMutationLock(f.projectRoot, (lease) => executePrivateRunner({ ...input, lease }, { client: http.client }));
  const dispatchRecords = () => {
    const workflow = privateRunnerWorkflowBinding(source);
    const op = input.plan.operations.find((entry) => entry.actionId === privateRunnerReachabilityAction)!;
    return readWorkflowEffect({ ...input, adapters: {
      ...input.adapters, githubActivation: { transport: http.client.transport, storage: f.storage }
    } }, op, { repositoryId: workflow.repositoryId, ref: `${workflow.ref}:${workflow.workflowId}`, purpose: 'workflow-dispatch', step: 'dispatch' },
    { workflow, dispatchInputs: { configuration_digest: http.configurationDigest() } });
  };
  return { f, input, http, execute, dispatchRecords };
}

async function legacyFixture(checkpoint: boolean, workflowId?: number) {
  const { f, source } = await planningFixture();
  const originalSource = workflowId === undefined ? source : { ...source, workflowId };
  f.inspection.activationInputs!.phases['runner-ready']!.source = originalSource;
  const plan = privateRunnerPlanForInspection(f.planning());
  const op = githubOperation(f.planning(), 'github.runner.ensure-ready', 'github-write', {
    step: 'network-observation-run', plan
  }, undefined, [{
    mutationClass: 'github-workflow-dispatch', destination: { type: 'repository', identity: plan.repository, repository: plan.repository },
    remote: true, destructive: false
  }]);
  const legacy = await f.execution({ operations: [op] });
  let retained: PrivateEffectCheckpoint | undefined;
  if (checkpoint) retained = await withProjectMutationLock(f.projectRoot, (lease) => preparePrivateEffect({ ...legacy, lease }, op, {
    kind: 'runner-workflow-dispatch', step: 'network-observation', provider: 'github',
    resourceId: `/repos/${plan.repository}/actions/workflows/${originalSource.workflowId}/dispatches`,
    request: { method: 'POST', workflowSource: originalSource, configurationDigest: plan.configurationDigest }
  }));
  f.inspection.activationInputs!.phases['runner-ready']!.source = source;
  const input = await f.execution(planPrivateRunner(f.planning()));
  const http = privateRunnerHttpFixture(source);
  return { f, input, legacy, http, retained,
    execute: () => withProjectMutationLock(f.projectRoot, (lease) => executePrivateRunner({ ...input, lease }, { client: http.client })) };
}

describe('repository-dedicated private hosted runner producer', () => {
  it('finds an actually retained unindexed old-target dispatch before GitHub access without rewriting its original record', async () => {
    const f = await legacyFixture(true, 812);
    f.f.inspection.contexts['runner-ready'].reviewedPlans = [];
    delete f.f.inspection.state.phases['runner-ready'].operation;
    if (!f.retained) throw new Error('The original private fixture effect was not prepared.');
    const record = await createScopedUserLocalRecordStore(f.f.projectRoot, 'governance-operation', f.f.storage)
      .read(canonicalSha256({ key: f.retained.key, stage: 'prepared' }));
    if (!record) throw new Error('Missing actual old private metadata.');
    const before = await readFile(record.path);
    const first = await f.execute();
    expect(first.status).toBe('blocked');
    expect(first.blocker).toContain('earlier private-access dispatch checkpoint');
    expect((await f.execute()).status).toBe('blocked');
    expect(f.http.calls).toEqual([]);
    expect(await readFile(record.path)).toEqual(before);
    expect(record.value).toMatchObject({
      kind: 'private-access-prepared', actionId: 'github.runner.ensure-ready',
      intent: { resourceId: '/repos/owner/repo/actions/workflows/812/dispatches' }
    });
  });

  it('blocks new dispatch when the selected private filesystem cannot enumerate metadata', async () => {
    const f = await fixture();
    f.input.adapters.azureActivation = { storage: {
      ...f.f.storage, fileSystem: { ...nodeUpdatePreviewFileSystem, openDirectory: undefined }
    } };
    const result = await f.execute();
    expect(result.status).toBe('blocked');
    expect(result.blocker).toContain('inventory is unsupported');
    expect(f.http.calls).toEqual([]);
  });

  it('does not turn oversized or changed exact-namespace metadata into a new shared dispatch', async () => {
    const f = await fixture();
    const store = createScopedUserLocalRecordStore(f.f.projectRoot, 'governance-operation', f.f.storage);
    const record = await store.write(canonicalSha256('oversized-private-metadata'), { kind: 'fixture-metadata' });
    await writeFile(record.path, ' '.repeat(64 * 1024 + 1), { mode: 0o600 });
    expect((await f.execute()).status).toBe('blocked');
    expect(f.http.calls).toEqual([]);
  });

  it('blocks a changed namespace scan before any GitHub access', async () => {
    const f = await fixture();
    let changed = false;
    f.input.adapters.azureActivation = { storage: {
      ...f.f.storage, fileSystem: { ...nodeUpdatePreviewFileSystem, async openDirectory(directory) {
        const handle = await nodeUpdatePreviewFileSystem.openDirectory!(directory);
        return { ...handle, async readName() {
          const name = await handle.readName();
          if (!changed) {
            changed = true;
            await writeFile(`${directory}/another-namespace-inflight`, 'UNOPENED_FIXTURE_PAYLOAD', { mode: 0o600 });
          }
          return name;
        } };
      } }
    } };
    expect((await f.execute()).status).toBe('blocked');
    expect(f.http.calls).toEqual([]);
  });

  it('never issues a second POST when old unindexed custody survives loss of the public and shared pointers', async () => {
    const f = await fixture();
    expect((await f.execute()).status).toBe('completed');
    const approvals = structuredClone(f.f.inspection.approvals);
    const source = privateRunnerPlanForInspection(f.input).source;
    f.f.inspection.activationInputs!.phases['runner-ready']!.source = { ...source, workflowId: 812 };
    const oldPlan = privateRunnerPlanForInspection(f.f.planning());
    const oldOp = githubOperation(f.f.planning(), 'github.runner.ensure-ready', 'github-write', {
      step: 'network-observation-run', plan: oldPlan
    }, undefined, [{
      mutationClass: 'github-workflow-dispatch', destination: { type: 'repository', identity: 'owner/repo', repository: 'owner/repo' },
      remote: true, destructive: false
    }]);
    const original = await f.f.execution({ operations: [oldOp] });
    await withProjectMutationLock(f.f.projectRoot, (lease) => preparePrivateEffect({ ...original, lease }, oldOp, {
      kind: 'runner-workflow-dispatch', step: 'network-observation', provider: 'github',
      resourceId: '/repos/owner/repo/actions/workflows/812/dispatches',
      request: { method: 'POST', workflowSource: oldPlan.source, configurationDigest: oldPlan.configurationDigest }
    }));
    f.f.inspection.activationInputs!.phases['runner-ready']!.source = source;
    f.f.inspection.approvals = approvals;
    await f.f.refreshInputs();
    f.f.inspection.contexts['runner-ready'].reviewedPlans = [];
    delete f.f.inspection.state.phases['runner-ready'].operation;
    const store = createScopedUserLocalRecordStore(f.f.projectRoot, 'governance-operation', f.f.storage);
    for (const record of (await store.readAll()).records) {
      const value = record.value;
      if (value && typeof value === 'object' && 'kind' in value && typeof value.kind === 'string' &&
        value.kind.startsWith('github-workflow-effect-')) {
        if (!record.path.startsWith(f.f.home)) throw new Error('Fixture receipt was not owned.');
        await unlink(record.path);
      }
    }
    const calls = f.http.calls.length;
    const result = await withProjectMutationLock(f.f.projectRoot, (lease) => executePrivateRunner({ ...f.input, lease }, { client: f.http.client }));
    expect(result.status).toBe('blocked');
    expect(result.blocker).toContain('earlier private-access dispatch checkpoint');
    expect(f.http.calls).toHaveLength(calls);
    expect(f.http.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dispatches'))).toHaveLength(1);
  });

  it('blocks orphaned original private-access results rather than inventing their missing prepared record', async () => {
    const f = await fixture();
    await createScopedUserLocalRecordStore(f.f.projectRoot, 'governance-operation', f.f.storage)
      .write(canonicalSha256('orphaned-original-result'), {
        schemaVersion: 1, kind: 'private-access-returned', preparedDigest: 'a'.repeat(64),
        requestId: 'ABCD:1234:FFFF:1234', resourceId: '/repos/owner/repo/actions/runs/812', status: 200
      });
    const result = await f.execute();
    expect(result.status).toBe('blocked');
    expect(result.blocker).toContain('lost its original pre-effect metadata');
    expect(f.http.calls).toEqual([]);
  });

  it('blocks an unresolved private-access dispatch before entering an empty shared namespace or accessing GitHub', async () => {
    const f = await legacyFixture(true);
    const result = await f.execute();
    expect(result.status).toBe('blocked');
    expect(result.blocker).toContain('earlier private-access dispatch checkpoint');
    expect(f.http.calls).toEqual([]);
    expect(f.f.calls).toEqual([]);
  });

  it('does not treat a missing legacy receipt or changed workflow target as proof that a retained dispatch plan never ran', async () => {
    const f = await legacyFixture(false);
    f.f.inspection.contexts['runner-ready'].reviewedPlans = [f.legacy.plan];
    const result = await f.execute();
    expect(result.status).toBe('blocked');
    expect(result.blocker).toContain('retained legacy runner dispatch plan');
    expect(f.http.calls).toEqual([]);
  });

  it.each(['github.runner.ensure-ready', privateRunnerReachabilityAction])(
    'blocks a recorded %s run without original shared custody instead of sending a new dispatch', async (actionId) => {
      const f = await fixture();
      f.f.inspection.state.phases['runner-ready'].operation = {
        provider: 'github', actionId, operationId: '4321', resourceId: '/repos/owner/repo/actions/runs/4321',
        startedAt: f.f.now.toISOString(), observedAt: f.f.now.toISOString(), status: 'running', planDigest: f.input.plan.planDigest
      };
      const result = await f.execute();
      expect(result.status).toBe('blocked');
      expect(result.blocker).toContain('original shared dispatch custody');
      expect(f.http.calls).toEqual([]);
      expect(await f.dispatchRecords()).toBeNull();
    }
  );

  it('initially assigns both independently published network and backend sources without dispatching backend effects', async () => {
    const backend = backendSource();
    const { http, execute } = await fixture(backend);
    const result = await execute();
    expect(result.status).toBe('completed');
    const selected = [
      'owner/repo/.github/workflows/liftoff-bootstrap-private.yml@refs/heads/develop',
      'owner/repo/.github/workflows/liftoff-bootstrap-backend.yml@refs/heads/develop'
    ];
    expect(http.calls.find((call) => call.method === 'POST' && call.path === '/orgs/owner/actions/runner-groups')?.body)
      .toMatchObject({ selected_workflows: selected });
    expect(result.outputs?.values).toMatchObject({
      'runner.allowedWorkflowsDigest': canonicalSha256(selected), 'runner.backendWorkflowId': backend.workflowId,
      'runner.backendWorkflowDigest': backend.workflowDigest, 'runner.backendWorkflowSourceSha': backend.sourceSha,
      'runner.backendWorkflowPath': backend.recipe.workflowPath, 'runner.backendWorkflowRef': backend.ref,
      'runner.backendWorkflowActorId': backend.actorId
    });
    expect(http.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dispatches')).map((call) => call.path))
      .toEqual(['/repos/owner/repo/actions/workflows/15/dispatches']);
    expect(http.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('does not create or widen a runner assignment for unverified backend workflow bytes', async () => {
    const { http, execute } = await fixture(backendSource());
    http.state.backendSourceChanged = true;
    expect((await execute()).status).toBe('blocked');
    expect(http.calls.some((call) => call.method !== 'GET')).toBe(false);
  });

  it('does not admit a future backend source that targets a different private endpoint', async () => {
    const backend = backendSource();
    backend.recipe.target.endpointAddress = '10.60.2.5';
    backend.workflowDigest = canonicalSha256(renderPrivateBackendWorkflow(backend.recipe));
    const { f } = await planningFixture(backend);
    const result = planPrivateRunner(f.planning());
    expect(result.operations).toEqual([]);
    expect(result.blockers?.join(' ')).toContain('same dedicated runner and private network');
    expect(f.calls).toEqual([]);
  });

  it('sequentially creates exact network/group/runner objects, dispatches once and verifies actual routing/DNS/TLS/egress on the bound job', async () => {
    const { f, http, execute } = await fixture();
    const outcome = await execute();
    expect(outcome).toMatchObject({
      status: 'completed', evidencePayload: {
        kind: 'runner-ready.v1', repositoryId: 42, networkSettingsId: 'settings81', networkConfigurationId: 'ncfg81',
        runnerGroupId: 55, hostedRunnerDefinitionId: 300, runnerId: 900, runId: 4321, runAttempt: 1,
        scope: 'network-reachability-only'
      }
    });
    const writes = http.calls.filter((call) => call.method === 'POST');
    expect(writes.map((call) => call.path)).toEqual([
      '/orgs/owner/settings/network-configurations', '/orgs/owner/actions/runner-groups',
      '/orgs/owner/actions/hosted-runners', '/repos/owner/repo/actions/workflows/15/dispatches'
    ]);
    expect(writes[1]!.body).toMatchObject({ network_configuration_id: 'ncfg81', selected_repository_ids: [42],
      visibility: 'selected', restricted_to_workflows: true, allows_public_repositories: false });
    expect(writes[2]!.body).toMatchObject({ runner_group_id: 55, image: { id: 'ubuntu-24.04', source: 'github' }, maximum_runners: 2 });
    expect(writes[3]!.body).toEqual({
      ref: 'develop', inputs: { liftoff_operation_id: http.correlation(), configuration_digest: http.configurationDigest() }
    });
    expect(http.calls.some((call) => call.path.startsWith('/repos/owner/repo/actions/workflows/15/runs?'))).toBe(false);
    expect(http.calls.some((call) => call.method === 'DELETE' || call.method === 'PATCH' || call.method === 'PUT')).toBe(false);
    expect(f.calls).toEqual([]);
    expect(outcome.completedOperations).toHaveLength(5);
    expect((await execute()).status).toBe('completed');
    expect(http.calls.filter((call) => call.method === 'POST')).toHaveLength(4);
  });

  it('does not call a broad runner list ready: foreign repository access blocks before runner allocation', async () => {
    const { http, execute } = await fixture();
    http.state.groupRepositoryIds = [42, 43];
    const outcome = await execute();
    expect(outcome.status).toBe('blocked');
    expect(http.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
    expect(http.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('does not create resources for a mismatching independently observed network-settings subnet', async () => {
    const { http, execute } = await fixture();
    http.state.wrongSubnet = true;
    expect((await execute()).status).toBe('blocked');
    expect(http.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('preserves a foreign network-settings assignment instead of silently moving it into the new group', async () => {
    const { http, execute } = await fixture();
    http.state.foreignNetworkAssignment = true;
    expect((await execute()).status).toBe('blocked');
    expect(http.calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
  });

  it('retains all partial effects and refuses dispatch when the immutable source ref moved', async () => {
    const { http, execute } = await fixture();
    http.state.sourceMoved = true;
    const outcome = await execute();
    expect(outcome.status).toBe('blocked');
    expect(http.calls.filter((call) => call.method === 'POST')).toHaveLength(3);
    expect(outcome.completedOperations).toHaveLength(4);
  });

  it('never retries an unknown POST even when the created resource now appears by name', async () => {
    const { http, execute } = await fixture();
    http.state.unknownCreate = true;
    const first = await execute();
    expect(first.status).toBe('blocked');
    expect(JSON.stringify(first)).not.toContain('SYNTHETIC_SECRET_MUST_NOT_APPEAR');
    expect((await execute()).status).toBe('blocked');
    expect(http.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('retains the actual pending run ID and resumes exact attempt readback without duplicate dispatch', async () => {
    const { f, input, http, execute } = await fixture();
    http.state.workflowPending = true;
    const pending = await execute();
    expect(pending).toMatchObject({ status: 'pending', operation: {
      operationId: '4321', resourceId: '/repos/owner/repo/actions/runs/4321'
    } });
    if (!pending.operation) throw new Error('Missing actual pending workflow operation.');
    Object.assign(f.inspection.state.phases['runner-ready'], {
      state: 'running', operation: pending.operation, executionPlanDigest: input.plan.planDigest
    });
    http.state.workflowPending = false;
    expect((await execute()).status).toBe('completed');
    expect(http.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dispatches'))).toHaveLength(1);
  });

  it('retains the actual HTTP200 run ID while independent readback is not yet observable', async () => {
    const { http, execute, dispatchRecords } = await fixture();
    http.state.hiddenRun = true;
    expect(await execute()).toMatchObject({ status: 'pending', operation: {
      operationId: '4321', resourceId: '/repos/owner/repo/actions/runs/4321'
    } });
    expect((await dispatchRecords())?.response).toMatchObject({ providerId: '4321', resourceId: '/repos/owner/repo/actions/runs/4321' });
    http.state.hiddenRun = false;
    expect((await execute()).status).toBe('completed');
    expect(http.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dispatches'))).toHaveLength(1);
    expect(http.calls.some((call) => call.path.startsWith('/repos/owner/repo/actions/workflows/15/runs?'))).toBe(false);
  });

  it('recovers a lost response through one exact correlated provider run without inventing a dispatch response or resubmitting', async () => {
    const { http, execute, dispatchRecords } = await fixture();
    http.state.lostDispatch = true;
    const first = await execute();
    expect(first.status).toBe('blocked');
    expect(JSON.stringify(first)).not.toContain('SYNTHETIC_SECRET_MUST_NOT_APPEAR');
    expect((await execute()).status).toBe('completed');
    expect((await execute()).status).toBe('completed');
    expect(http.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dispatches'))).toHaveLength(1);
    const checkpoint = await dispatchRecords();
    expect(checkpoint?.response).toBeNull();
    expect(checkpoint?.observed).toMatchObject({ providerId: '4321', resourceId: '/repos/owner/repo/actions/runs/4321' });
  });

  it('keeps unobservable lost responses checkpointed without a new dispatch or fake run handle', async () => {
    const { http, execute } = await fixture();
    http.state.lostDispatch = true;
    http.state.hiddenRun = true;
    expect((await execute()).status).toBe('blocked');
    const second = await execute();
    expect(second.status).toBe('blocked');
    expect(second.operation).toBeUndefined();
    expect(http.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dispatches'))).toHaveLength(1);
    expect(http.calls.filter((call) => call.path.startsWith('/repos/owner/repo/actions/workflows/15/runs?'))).toHaveLength(1);
  });

  it('rejects ambiguous correlated runs rather than guessing the newest one after response loss', async () => {
    const { http, execute } = await fixture();
    http.state.lostDispatch = true;
    http.state.ambiguousRuns = true;
    expect((await execute()).status).toBe('blocked');
    expect((await execute()).status).toBe('blocked');
    expect(http.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dispatches'))).toHaveLength(1);
  });

  it('treats a legacy204 only as acknowledgement and requires exact run readback without another POST', async () => {
    const { http, execute } = await fixture();
    http.state.legacyDispatch = true;
    http.state.hiddenRun = true;
    expect((await execute()).status).toBe('blocked');
    http.state.hiddenRun = false;
    expect((await execute()).status).toBe('completed');
    expect(http.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dispatches'))).toHaveLength(1);
  });

  it('does not accept a HTTP200 run receipt whose URLs name another repository', async () => {
    const { http, execute } = await fixture();
    http.state.malformedDispatch = true;
    expect((await execute()).status).toBe('blocked');
    expect(http.calls.some((call) => call.path.includes('/owner/foreign/'))).toBe(false);
    expect(http.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dispatches'))).toHaveLength(1);
  });

  it.each(['wrongReportRunner', 'extraReportPayload', 'wrongJobGroup'] as const)('rejects %s even if the overall workflow says success', async (fault) => {
    const { http, execute } = await fixture();
    http.state[fault] = true;
    const outcome = await execute();
    expect(outcome.status).toBe('blocked');
    expect(outcome.evidencePayload).toBeUndefined();
    expect(JSON.stringify(outcome)).not.toContain('SYNTHETIC_SECRET_MUST_NOT_APPEAR');
  });

  it('keeps runner pool and actual ephemeral runner IDs distinct while provisioning is pending', async () => {
    const { f, input, http, execute } = await fixture();
    http.state.runnerPending = true;
    const pending = await execute();
    expect(pending).toMatchObject({ status: 'pending', operation: { operationId: '300' } });
    if (!pending.operation) throw new Error('Missing actual pending runner allocation.');
    Object.assign(f.inspection.state.phases['runner-ready'], {
      state: 'running', operation: pending.operation, executionPlanDigest: input.plan.planDigest
    });
    expect(http.calls.some((call) => call.method === 'POST' && call.path.endsWith('/dispatches'))).toBe(false);
    http.state.runnerPending = false;
    expect((await execute()).status).toBe('completed');
    expect(http.calls.filter((call) => call.method === 'POST')).toHaveLength(4);
  });

  it('does not reuse a network-only source as a backend lease challenge or authority', async () => {
    const f = await privateActivationFixture('private-backend-proof', { source: runnerSource() });
    fixtures.push(f);
    f.inspection.state.phases['runner-ready'].state = 'verified';
    f.inspection.state.phaseOutputs = { 'runner-ready': { values: {
      'runner.runId': 4321, 'runner.runAttempt': 1, 'runner.correlationId': 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'runner.configurationDigest': 'f'.repeat(64), 'runner.groupId': 55
    }, resources: [] } };
    const plan = planPrivateBackendProof(f.planning());
    expect(plan.operations).toEqual([]);
    expect(plan.blockers!.join(' ')).toContain('exact declared fields');
    expect(f.calls).toEqual([]);
  });
});

describe('published private-network report contract', () => {
  it('reproduces identical reviewed source after canonical private-plan persistence reorders object keys', () => {
    const source = runnerSource();
    const persisted = JSON.parse(canonicalJson(source));
    expect(renderPrivateRunnerWorkflow(persisted.recipe)).toBe(renderPrivateRunnerWorkflow(source.recipe));
    expect(validatePrivateRunnerSource(persisted)).toEqual(source);
  });

  it('renders a pinned, read-only workflow with no project checkout, state bytes or lease mutation', () => {
    const source = runnerSource();
    const rendered = renderPrivateRunnerWorkflow(source.recipe);
    const document = parse(rendered);
    expect(document['run-name']).toBe('liftoff-${{ inputs.liftoff_operation_id }}');
    expect(document.on.workflow_dispatch.inputs.liftoff_operation_id).toMatchObject({ required: true, type: 'string' });
    expect(document.on.workflow_dispatch.inputs.correlation_id).toBeUndefined();
    expect(document.jobs.private_network['runs-on']).toEqual({ group: source.recipe.runnerGroupName, labels: source.recipe.runnerLabel });
    expect(document.permissions).toEqual({ actions: 'read' });
    expect(document.jobs.private_network.steps).toHaveLength(2);
    expect(document.jobs.private_network.steps[1].uses).toBe(`actions/upload-artifact@${source.recipe.uploadArtifactActionSha}`);
    expect(rendered).not.toMatch(/actions\/checkout|azure\/login|id-token|lease-action|get-access-token|method:'HEAD'|method:'PUT'|expected\.backend|claims\.oid/);
    expect(rendered).toContain("from 'node:tls'");
    expect(validatePrivateRunnerSource(source)).toEqual(source);
    expect(() => validatePrivateRunnerSource({ ...source, workflowDigest: canonicalSha256(`${rendered}\n# edited`) })).toThrow();
    const legacy = structuredClone(source.recipe);
    Object.assign(legacy, { azureClientId: 'old-field' });
    expect(() => renderPrivateRunnerWorkflow(legacy)).toThrow();
  });

  it('independently reads actual Actions checks, runner assignment and the exact network-only report artifact', async () => {
    const f = privateRunnerHttpFixture();
    const identity = { runId: f.state.runId, runAttempt: 1, correlationId: f.correlation(), configurationDigest: f.configurationDigest() };
    const operation = {
      provider: 'github' as const, actionId: privateRunnerReachabilityAction, operationId: String(f.state.runId),
      resourceId: `/repos/owner/repo/actions/runs/${f.state.runId}`, startedAt: fixtureTime.toISOString(),
      observedAt: fixtureTime.toISOString(), status: 'completed' as const, planDigest: canonicalSha256('fixture retained dispatch')
    };
    const result = await observePrivateRunnerRun(f.client, f.source, identity, 55, f.source.recipe.runnerLabel, fixtureTime, operation);
    expect(result).toMatchObject({ status: 'verified', report: { kind: 'private-runner-reachability-report' } });
    expect(f.calls.some((call) => call.path === '/repos/owner/repo/check-runs/899')).toBe(true);
    expect(f.calls.some((call) => call.path === '/repos/owner/repo/actions/artifacts/987')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/principalId|blobRequestId|leaseStatus|backend/);
  });

  it('interoperates with the shared dispatcher under an already registered workflow authority without claiming backend proof', async () => {
    const source = runnerSource();
    const http = privateRunnerHttpFixture(source);
    const f = await privateActivationFixture('private-backend-proof', { source });
    fixtures.push(f);
    const workflow = privateRunnerWorkflowBinding(source);
    const dispatchInputs = { configuration_digest: canonicalSha256(f.inspection.activationInputs) };
    const op = githubOperation(f.planning(), 'github.runner.backend-proof', 'github-workflow-dispatch', { workflow, dispatchInputs });
    const input = await f.execution({ operations: [op] });
    const result = await withProjectMutationLock(f.projectRoot, async (lease) => {
      const execution = { ...input, lease, adapters: {
        ...input.adapters, githubActivation: { transport: http.client.transport, storage: f.storage }
      } };
      const dispatched = await dispatchApprovedWorkflowRun(execution, op, workflow, dispatchInputs);
      expect(dispatched.status).toBe('completed');
      const records = await readWorkflowEffect(execution, op, {
        repositoryId: workflow.repositoryId, ref: `${workflow.ref}:${workflow.workflowId}`, purpose: 'workflow-dispatch', step: 'dispatch'
      }, { workflow, dispatchInputs });
      if (!records) throw new Error('Shared dispatcher did not retain its actual checkpoint.');
      return observePrivateRunnerRun(http.client, source, {
        runId: Number(dispatched.operation.operationId), runAttempt: 1, correlationId: records.prepared.correlationId,
        configurationDigest: dispatchInputs.configuration_digest
      }, 55, source.recipe.runnerLabel, f.now, dispatched.operation);
    });
    expect(result).toMatchObject({ status: 'verified', report: { kind: 'private-runner-reachability-report' } });
    expect(http.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/principalId|blobRequestId|leaseStatus|backend/);
    expect(f.inspection.state.phases['private-backend-proof'].state).toBe('pending');
  });
});

describe('private runner operation registry boundary', () => {
  it('requires a real primary reachability-dispatch registration without adding Azure/backend effects or a fallback writer', async () => {
    const { f } = await planningFixture();
    const build = planPrivateRunner(f.planning());
    if (build.blockers?.length) {
      expect(build.operations).toEqual([]);
      expect(build.blockers.join(' ')).toContain('github.runner.reachability-dispatch');
    } else {
      const dispatch = build.operations.find((op) => op.actionId === privateRunnerReachabilityAction);
      expect(dispatch).toMatchObject({ mutationClass: 'github-workflow-dispatch', adapter: 'github' });
      expect(dispatch?.inputs).toHaveProperty('workflow');
      expect(dispatch?.inputs).toHaveProperty('dispatchInputs');
      expect(build.operations.flatMap((op) => op.effects ?? []).some((effect) =>
        ['azure-read', 'backend-state-read', 'backend-state-write'].includes(effect.mutationClass))).toBe(false);
    }
    expect(f.calls).toEqual([]);
  });

  it('decodes only one bounded, checksum-verified report and rejects unsafe names or trailing payloads', () => {
    const report = privateRunnerHttpFixture().report();
    expect(readPrivateReportArchive(singleReportZip(report))).toEqual(report);
    expect(() => readPrivateReportArchive(singleReportZip(report, '../state.json'))).toThrow();
    const corrupt = singleReportZip(report);
    corrupt[100] = corrupt[100]! ^ 0xff;
    expect(() => readPrivateReportArchive(corrupt)).toThrow();
    expect(() => readPrivateReportArchive(Buffer.concat([singleReportZip(report), Buffer.from('SYNTHETIC_STATE')]))).toThrow();
  });

  it('decodes another exact JSON basename without changing defaults or inventing private-runner proof semantics', () => {
    const filename = 'application-build-provenance.json';
    const provenance = { schemaVersion: 1, kind: 'application-build-provenance', sourceSha: 'a'.repeat(40) };
    const archive = singleReportZip(provenance, filename);
    expect(readPrivateReportArchive(archive, filename)).toEqual(provenance);
    expect(() => readPrivateReportArchive(archive)).toThrow();
    expect(() => readPrivateReportArchive(archive, 'different-report.json')).toThrow();
    const corrupted = Buffer.from(archive);
    corrupted[100] = corrupted[100]! ^ 0xff;
    expect(() => readPrivateReportArchive(corrupted, filename)).toThrow();
    expect(() => readPrivateReportArchive(singleReportZip({ value: 'x'.repeat(128 * 1024) }, filename), filename)).toThrow();
  });

  it.each(['', '../report.json', 'dir/report.json', 'C:\\report.json', '*.json', 'report?.json', 'report\u0000.json',
    '.hidden.json', 'a..json', 'report.txt', `${'a'.repeat(200)}.json`])('rejects unsafe expected JSON basename %j', (filename) => {
    expect(() => readPrivateReportArchive(singleReportZip({ value: 1 }, filename), filename)).toThrow();
  });

  it.each(['public-dns', 'wrong-route-source', 'wrong-egress', 'future-time', 'backend-assertion'])('rejects %s observations instead of accepting synthetic booleans', (fault) => {
    const f = privateRunnerHttpFixture();
    const report = f.report();
    if (fault === 'public-dns') report.network.connectedAddress = '192.0.2.1';
    if (fault === 'wrong-route-source') report.network.route.source = '10.90.0.5';
    if (fault === 'wrong-egress') report.egress[0]!.hostname = 'unrelated.example';
    if (fault === 'future-time') report.observedAt = '2026-10-15T00:00:00.000Z';
    if (fault === 'backend-assertion') Object.assign(report, { backend: { leaseAcquired: true } });
    expect(() => validatePrivateRunnerReport(report, f.source, {
      runId: f.state.runId, runAttempt: 1, correlationId: f.correlation(), configurationDigest: f.configurationDigest()
    }, f.job(), 55, f.source.recipe.runnerLabel, fixtureTime)).toThrow();
  });
});
