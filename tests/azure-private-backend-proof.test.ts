import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { assertAzurePhaseAuthority } from '../src/application/azure-activation/authority.js';
import {
  executePrivateBackendProof, planPrivateBackendProof, privateBackendLeaseActions
} from '../src/application/azure-activation/private-backend-proof.js';
import { readPrivateEffect, type PrivateEffectIntent } from '../src/application/azure-activation/private-checkpoints.js';
import { privateLeaseSteps } from '../src/application/azure-activation/private-backend-lease.js';
import { readWorkflowEffect } from '../src/application/repository-governance/workflow-checkpoints.js';
import { privateBackendWorkflowBinding, renderPrivateBackendWorkflow } from '../src/application/azure-activation/private-backend-workflow.js';
import { stateDigest } from '../src/domain/repair/stateful-invariants.js';
import type { PhaseAdapterExecutionInput } from '../src/governance-activation/transition-ports.js';
import type { TransitionOperation } from '../src/domain/governance/activation/types.js';
import { privateActivationFixture } from './helpers/private-activation-fixture.js';
import { backendAuditBinding, backendChallengeInput, backendHttpFixture, backendSource } from './helpers/private-backend-http-fixture.js';
import { syntheticStateValue } from './fixtures/state-migration/fakes.js';

const fixtures: Awaited<ReturnType<typeof privateActivationFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

function intent(op: TransitionOperation): PrivateEffectIntent {
  return { kind: 'backend-lease-proof', step: String(op.inputs.step), provider: 'azure', resourceId: op.destination.identity,
    request: { method: 'PUT', target: 'lease', ...op.inputs } };
}

async function planningFixture(source = backendSource()) {
  const f = await privateActivationFixture('private-backend-proof', {
    source, challenge: backendChallengeInput(), audit: backendAuditBinding()
  });
  fixtures.push(f);
  f.inspection.state.phases['runner-ready'].state = 'verified';
  f.inspection.state.phaseOutputs = { 'runner-ready': { values: {
    'runner.backendWorkflowId': source.workflowId, 'runner.backendWorkflowPath': source.recipe.workflowPath,
    'runner.backendWorkflowSourceSha': source.sourceSha, 'runner.backendWorkflowDigest': source.workflowDigest,
    'runner.backendWorkflowRef': source.ref, 'runner.backendWorkflowActorId': source.actorId,
    'runner.groupId': 55, 'runner.definitionId': 300, 'runner.networkConfigurationId': 'network81',
    'runner.networkSettingsId': 'settings81', 'runner.allowedWorkflowsDigest': canonicalSha256([
      'owner/repo/.github/workflows/liftoff-bootstrap-private.yml@refs/heads/develop',
      `owner/repo/${source.recipe.workflowPath}@refs/heads/${source.ref}`
    ])
  }, resources: [] } };
  return { f, source };
}

async function fixture(options: { issue?: boolean; approvalExpiresAt?: string; source?: ReturnType<typeof backendSource> } = {}) {
  const { f, source } = await planningFixture(options.source);
  const planned = planPrivateBackendProof(f.planning());
  const input = await f.execution(planned, options);
  const leaseOps = input.plan.operations.filter((op) => Object.values(privateBackendLeaseActions).some((id) => id === op.actionId));
  const checkpoints = (current = input) => Promise.all(leaseOps.map((op) => readPrivateEffect(current, op, intent(op))));
  let preEffectChecks = 0;
  const http = backendHttpFixture(source, {
    now: () => f.now.getTime(),
    async beforeLease(request) {
      const records = await checkpoints();
      expect(records).toHaveLength(4);
      for (let index = 0; index < records.length; index++) {
        expect(records[index]?.prepared).toMatchObject({
          planDigest: input.plan.planDigest, approvalEnvelopeHash: input.plan.approval.envelopeHash,
          clientRequestId: leaseOps[index]!.inputs.clientRequestId
        });
        expect(records[index]?.submitted).toBeNull();
      }
      expect(leaseOps.some((op) => op.inputs.clientRequestId === request.operationId)).toBe(true);
      preEffectChecks++;
    }
  });
  const executionInput = (current: PhaseAdapterExecutionInput) => ({
    ...current, adapters: { ...current.adapters, githubActivation: { transport: http.client.transport, storage: f.storage } }
  });
  const execute = (current = input) => withProjectMutationLock(f.projectRoot, async (lease) => {
    const execution = { ...executionInput(current), lease };
    const readOp = execution.plan.operations.find((op) => op.actionId === 'azure.remote-state.read')!;
    return executePrivateBackendProof(execution, {
      client: http.client, audit: http.audit(() => assertAzurePhaseAuthority(execution, readOp))
    });
  });
  const dispatchRecords = () => {
    const workflow = privateBackendWorkflowBinding(source);
    const op = input.plan.operations.find((entry) => entry.actionId === 'github.runner.backend-proof')!;
    return readWorkflowEffect(executionInput(input), op, {
      repositoryId: workflow.repositoryId, ref: `${workflow.ref}:${workflow.workflowId}`, purpose: 'workflow-dispatch', step: 'dispatch'
    }, { workflow, dispatchInputs: op.inputs.dispatchInputs });
  };
  return { f, input, planned, http, leaseOps, checkpoints, execute, dispatchRecords, preEffectChecks: () => preEffectChecks };
}

describe('privately approved backend lease phase (isolated provider fixtures, UNQUALIFIED)', () => {
  it('binds nested blob keys to the same canonical reviewed destination, provider receipt and independent audit URI', async () => {
    const source = backendSource();
    source.recipe.target.backend.key = 'environments/dev/network-v1.tfstate';
    source.workflowDigest = canonicalSha256(renderPrivateBackendWorkflow(source.recipe));
    const f = await fixture({ source });
    const expected = 'https://liftofffixture.blob.core.windows.net/tfstate/environments/dev/network-v1.tfstate';
    expect(f.leaseOps.every((op) => op.destination.identity === expected)).toBe(true);
    const delegated = f.planned.operations[0]!.effects ?? [];
    expect(delegated.map((effect) => effect.destination.identity)).toEqual([expected, expected]);
    expect((await f.execute()).status).toBe('completed');
    expect((await f.checkpoints()).every((record) => record?.submitted?.resourceId === expected)).toBe(true);
    expect(f.http.logRows.every((row) => row[12] === expected)).toBe(true);
    expect(f.http.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it.each(['state.tfstate?comp=lease', 'state.tfstate#fragment', 'state%2ftest.tfstate',
    'state value.tfstate', '../state.tfstate', 'env//state.tfstate'])('rejects the unadmitted blob key %j before effects', async (key) => {
    const source = backendSource();
    source.recipe.target.backend.key = key;
    const { f } = await planningFixture(source);
    const result = planPrivateBackendProof(f.planning());
    expect(result.operations).toEqual([]);
    expect(result.blockers?.length).toBeGreaterThan(0);
    expect(f.calls).toEqual([]);
  });

  it('plans and independently verifies four exact lease effects, durably prepared before any provider mutation', async () => {
    const f = await fixture();
    expect(f.planned.operations.map((op) => op.actionId)).toEqual([
      'github.runner.backend-proof', 'azure.remote-state.read', 'azure.private-backend.lease.acquire',
      'azure.private-backend.lease.acquire', 'azure.private-backend.lease.renew', 'azure.private-backend.lease.release'
    ]);
    expect(f.leaseOps.map((op) => op.inputs.step)).toEqual([...privateLeaseSteps]);
    const original = Buffer.from(f.http.blob.bytes!);
    const result = await f.execute();
    expect(result).toMatchObject({
      status: 'completed', resultState: 'verified', operation: { operationId: '9876', planDigest: f.input.plan.planDigest },
      outputs: { values: { 'backend.exclusiveLeaseAcquired': true, 'backend.leaseReleased': true } },
      evidencePayload: { statePayloadRead: false, stateContentWritten: false, atomicAcrossProviders: false }
    });
    expect(result.completedOperations).toHaveLength(6);
    expect(result.liveReadback?.map((proof) => proof.provider)).toEqual(['github', 'azure']);
    expect(f.preEffectChecks()).toBe(4);
    const records = await f.checkpoints();
    expect(records.map((entry) => entry?.submitted?.status)).toEqual([201, 409, 200, 200]);
    expect(new Set(records.map((entry) => entry?.submitted?.requestId)).size).toBe(4);
    expect(records.every((entry) => entry?.settled?.outcome === 'verified')).toBe(true);
    expect(records.every((entry) => entry?.submitted?.requestId !== entry?.prepared.clientRequestId)).toBe(true);
    expect(Buffer.from(f.http.blob.bytes!)).toEqual(original);
    expect(f.http.blob.leaseId).toBeNull();
    expect(f.http.blob.calls.every((call) => call.method === 'HEAD' || call.method === 'PUT' && call.target === 'lease')).toBe(true);
    expect(f.f.calls).toEqual([]);
    const text = JSON.stringify(result);
    expect(text).not.toContain(syntheticStateValue);
    expect(text).not.toContain(stateDigest(original));
    expect(text).not.toContain(f.http.token);
    for (const call of f.http.blob.calls) {
      for (const header of ['x-ms-lease-id', 'x-ms-proposed-lease-id']) {
        const id = call.headers?.[header];
        if (id) expect(text).not.toContain(id);
      }
    }
    expect((await f.execute()).status).toBe('completed');
    expect(f.preEffectChecks()).toBe(4);
    expect(f.http.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('requires private issuance, not just a syntactically valid public approval', async () => {
    const f = await fixture({ issue: false });
    expect((await f.execute()).status).toBe('blocked');
    expect(f.http.calls).toEqual([]);
    expect(f.http.blob.calls).toEqual([]);
    expect(f.http.azure.armCalls).toEqual([]);
  });

  it('requires the real project lease before any provider access', async () => {
    const f = await fixture();
    expect((await executePrivateBackendProof(f.input, {
      client: f.http.client, audit: f.http.audit(async () => { throw new Error('Not authorized'); })
    })).status).toBe('blocked');
    expect(f.http.calls).toEqual([]);
  });

  it('does not dispatch a cleanup window that outlives its actual privately issued approval', async () => {
    const f = await fixture({ approvalExpiresAt: '2026-09-15T00:03:30.000Z' });
    expect((await f.execute()).status).toBe('blocked');
    expect(f.http.calls).toEqual([]);
    expect(f.http.blob.calls).toEqual([]);
  });

  it('rejects runner source or assignment drift before dispatch or a lease write', async () => {
    const f = await fixture();
    f.http.states.groupMissingSource = true;
    expect((await f.execute()).status).toBe('blocked');
    expect(f.http.calls.some((call) => call.method !== 'GET')).toBe(false);
    expect(f.http.blob.calls).toEqual([]);
    expect((await f.checkpoints()).every((entry) => entry === null)).toBe(true);
  });

  it('requires independent existing private storage controls before dispatch', async () => {
    const f = await fixture();
    const target = f.http.target;
    const serviceId = `/subscriptions/${target.binding.subscriptionId}/resourceGroups/${target.backend.resourceGroup}` +
      `/providers/Microsoft.Storage/storageAccounts/${target.backend.account}/blobServices/default`;
    const service = f.http.azure.rows.get(serviceId);
    if (!service || !isRecord(service.properties)) throw new Error('The exact fixture blob service is missing.');
    service.properties.isVersioningEnabled = false;
    expect((await f.execute()).status).toBe('blocked');
    expect(f.http.calls.some((call) => call.method !== 'GET')).toBe(false);
    expect(f.http.blob.calls).toEqual([]);
  });

  it.each(['absent', 'foreign-lease', 'changed-version'] as const)('retains an actual %s diagnostic without claiming acquired locking', async (fault) => {
    const f = await fixture();
    if (fault === 'absent') f.http.blob.bytes = null;
    if (fault === 'foreign-lease') f.http.blob.leaseId = randomUUID();
    if (fault === 'changed-version') f.http.blob.version++;
    const result = await f.execute();
    expect(result.status).toBe('blocked');
    expect(result.outputs).toBeUndefined();
    expect(f.http.blob.calls.every((call) => call.method === 'HEAD')).toBe(true);
    expect((await f.checkpoints()).every((entry) => entry?.submitted === null && entry.settled?.outcome === 'not-dispatched')).toBe(true);
    expect((await f.execute()).status).toBe('blocked');
    expect(f.http.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it.each(['unknownAcquire', 'unknownRenew', 'unknownRelease'] as const)('retains %s and never retries its dispatch or lease effects', async (fault) => {
    const f = await fixture();
    f.http.states[fault] = true;
    const result = await f.execute();
    expect(result.status).toBe('blocked');
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET_RESPONSE');
    const index = fault === 'unknownAcquire' ? 0 : fault === 'unknownRenew' ? 2 : 3;
    expect((await f.checkpoints())[index]).toMatchObject({ submitted: null, settled: null });
    const mutations = f.http.blob.calls.filter((call) => call.target === 'lease').length;
    expect((await f.execute()).status).toBe('blocked');
    expect(f.http.blob.calls.filter((call) => call.target === 'lease')).toHaveLength(mutations);
    expect(f.http.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    if (fault === 'unknownAcquire') expect(f.http.blob.calls.some((call) => call.headers?.['x-ms-lease-action'] === 'release')).toBe(false);
  });

  it('retains a pending real provider run and verifies it later without dispatching again', async () => {
    const f = await fixture();
    f.http.states.workflowPending = true;
    expect(await f.execute()).toMatchObject({ status: 'pending', operation: { operationId: '9876' } });
    f.http.states.workflowPending = false;
    expect((await f.execute()).status).toBe('completed');
    expect(f.http.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('recovers an unknown dispatch only through the exact correlated provider run and original plan identity', async () => {
    const f = await fixture();
    f.http.states.lostDispatch = true;
    expect((await f.execute()).status).toBe('blocked');
    expect(await f.execute()).toMatchObject({ status: 'completed', operation: { operationId: '9876', planDigest: f.input.plan.planDigest } });
    const records = await f.dispatchRecords();
    expect(records?.response).toBeNull();
    expect(records?.observed?.providerId).toBe('9876');
    expect(f.http.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(f.preEffectChecks()).toBe(4);
  });

  it.each(['hiddenRun', 'ambiguousRuns'] as const)('keeps %s dispatch uncertainty without manufacturing a provider ID or sending another request', async (fault) => {
    const f = await fixture();
    f.http.states.lostDispatch = true;
    f.http.states[fault] = true;
    expect((await f.execute()).status).toBe('blocked');
    const result = await f.execute();
    expect(result.status).toBe('blocked');
    expect(result.operation).toBeUndefined();
    expect(f.http.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('does not adopt an independently submitted run after the checkpointed dispatch was explicitly rejected', async () => {
    const f = await fixture();
    f.http.states.rejectDispatch = true;
    expect((await f.execute()).status).toBe('blocked');
    await f.http.executeProbe();
    expect((await f.execute()).status).toBe('blocked');
    expect((await f.dispatchRecords())?.response?.status).toBe(403);
    expect((await f.dispatchRecords())?.observed).toBeNull();
    expect(f.http.calls.some((call) => call.path.includes('/runs?'))).toBe(false);
    expect(f.http.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it.each(['missingAudit', 'wrongAuditActor', 'wrongRunner', 'wrongActor', 'wrongSource', 'tamperReport'] as const)(
    'refuses %s even when a diagnostic workflow is green', async (fault) => {
      const f = await fixture();
      f.http.states[fault] = true;
      const result = await f.execute();
      expect(result.status).toBe('blocked');
      expect(result.outputs).toBeUndefined();
      expect(result.evidencePayload).toBeUndefined();
      expect((await f.checkpoints()).some((entry) => entry?.settled?.outcome === 'verified')).toBe(false);
    }
  );

  it('uses a fresh read-only recovery approval after effect expiry without extending the original challenge', async () => {
    const f = await fixture();
    f.http.states.missingAudit = true;
    expect((await f.execute()).status).toBe('blocked');
    f.http.states.missingAudit = false;
    f.f.now.setTime(f.f.now.getTime() + 5 * 60_000);
    f.f.inspection.recoverPhase = 'private-backend-proof';
    const planned = planPrivateBackendProof(f.f.planning());
    expect(planned.operations.map((op) => op.mutationClass)).toEqual(['github-read', 'azure-read']);
    const recovery = await f.f.execution(planned, { recovery: true });
    expect(recovery.plan.approval.envelopeHash).not.toBe(f.input.plan.approval.envelopeHash);
    expect(await f.execute(recovery)).toMatchObject({
      status: 'completed', operation: { operationId: '9876', planDigest: f.input.plan.planDigest }
    });
    expect(f.http.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(f.preEffectChecks()).toBe(4);
  });

  it('does not start new work from a read-only recovery plan without original custody', async () => {
    const { f } = await planningFixture();
    f.inspection.recoverPhase = 'private-backend-proof';
    const input = await f.execution(planPrivateBackendProof(f.planning()), { recovery: true });
    const http = backendHttpFixture();
    const result = await withProjectMutationLock(f.projectRoot, (lease) => executePrivateBackendProof({ ...input, lease }, {
      client: http.client, audit: http.audit(() => assertAzurePhaseAuthority({ ...input, lease }, input.plan.operations[1]!))
    }));
    expect(result.status).toBe('blocked');
    expect(http.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(http.blob.calls).toEqual([]);
  });

  it('blocks missing original pre-effect custody rather than recreating it or retrying', async () => {
    const f = await fixture();
    expect((await f.execute()).status).toBe('completed');
    const checkpoint = (await f.checkpoints())[0]!;
    const store = createScopedUserLocalRecordStore(f.f.projectRoot, 'governance-operation', f.f.storage);
    const prepared = await store.read(canonicalSha256({ key: checkpoint.key, stage: 'prepared' }));
    expect(prepared?.path.startsWith(f.f.home)).toBe(true);
    await unlink(prepared!.path);
    expect((await f.execute()).status).toBe('blocked');
    expect(f.preEffectChecks()).toBe(4);
    expect(f.http.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('rejects conflicting historical approval custody even if its public operation fields match', async () => {
    const f = await fixture();
    f.http.states.workflowPending = true;
    expect((await f.execute()).status).toBe('pending');
    const checkpoint = (await f.checkpoints())[0]!;
    const store = createScopedUserLocalRecordStore(f.f.projectRoot, 'governance-operation', f.f.storage);
    const prepared = await store.read(canonicalSha256({ key: checkpoint.key, stage: 'prepared' }));
    expect(prepared?.path.startsWith(f.f.home)).toBe(true);
    await writeFile(prepared!.path, JSON.stringify({ ...checkpoint.prepared, approvalEnvelopeHash: '0'.repeat(64) }));
    f.http.states.workflowPending = false;
    expect((await f.execute()).status).toBe('blocked');
    expect(f.http.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('does not overwrite a verified effect settlement when subsequent audit readback contradicts it', async () => {
    const f = await fixture();
    expect((await f.execute()).status).toBe('completed');
    f.http.logRows[0]![16] = randomUUID();
    expect((await f.execute()).status).toBe('blocked');
    expect(f.http.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(f.preEffectChecks()).toBe(4);
  });
});
