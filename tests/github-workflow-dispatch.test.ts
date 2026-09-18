import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalApprovalEnvelopeHash } from '../src/domain/governance/activation/approvals.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { GitHubActivationClient } from '../src/adapters/github/activation-rest.js';
import {
  dispatchApprovedWorkflowRun, readBoundWorkflowArtifact, WorkflowDispatchReadbackPendingError, type WorkflowRunBinding
} from '../src/adapters/github/production-checks.js';
import { readWorkflowEffect } from '../src/application/repository-governance/workflow-checkpoints.js';
import type { TransitionOperation } from '../src/domain/governance/activation/types.js';
import { workflowOperationFixture } from './helpers/workflow-operation-fixture.js';
import { WorkflowGitHubFixture, dispatchFixtureSource, workflowFixturePath } from './helpers/workflow-publication-fixture.js';

const fixtures: Awaited<ReturnType<typeof workflowOperationFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

async function dispatchFixture() {
  const protocol = new WorkflowGitHubFixture(dispatchFixtureSource);
  const binding: WorkflowRunBinding = {
    repository: 'owner/repo', repositoryId: 42, workflowPath: workflowFixturePath, workflowId: 4,
    workflowDigest: canonicalSha256(dispatchFixtureSource), sourceSha: protocol.baseSha, ref: 'develop',
    actorId: 7, event: 'workflow_dispatch', expectedJobs: ['Node source validation'], runAttempt: 1
  };
  const dispatchInputs = { environment: 'dev' };
  const operation: TransitionOperation = {
    phaseId: 'dev-proof', adapter: 'github', actionId: 'github.checks.dev-proof', mutationClass: 'github-workflow-dispatch',
    inputs: { workflow: binding, dispatchInputs }, destination: { type: 'repository', identity: 'owner/repo', repository: 'owner/repo' },
    remote: true, destructive: false
  };
  const f = await workflowOperationFixture('dev-proof', [operation], protocol.runner);
  fixtures.push(f);
  const execute = () => withProjectMutationLock(f.projectRoot, (lease) =>
    dispatchApprovedWorkflowRun({ ...f.input, lease }, operation, binding, dispatchInputs));
  return { ...f, protocol, binding, operation, dispatchInputs, execute };
}

describe('recorded real GitHub workflow dispatch', () => {
  it('persists private authority and pre-effect correlation before the real adapter request, retaining only returned provider IDs', async () => {
    const f = await dispatchFixture();
    let correlation = '';
    f.protocol.beforeRequest = async (request) => {
      if (request.method !== 'POST') return;
      const checkpoint = await readWorkflowEffect(f.input, f.operation, {
        repositoryId: 42, ref: 'develop:4', purpose: 'workflow-dispatch', step: 'dispatch'
      }, { workflow: f.binding, dispatchInputs: f.dispatchInputs });
      correlation = checkpoint!.prepared.correlationId;
      expect(request.body).toEqual({ ref: 'develop', inputs: { environment: 'dev', liftoff_operation_id: correlation } });
      expect(checkpoint!.response).toBeNull();
    };
    const outcome = await f.execute();
    expect(outcome).toMatchObject({ status: 'completed', operation: {
      operationId: '100', resourceId: '/repos/owner/repo/actions/runs/100', status: 'completed'
    }, run: { runId: 100, headSha: f.protocol.baseSha, conclusion: 'success' } });
    const checkpoint = await readWorkflowEffect(f.input, f.operation, {
      repositoryId: 42, ref: 'develop:4', purpose: 'workflow-dispatch', step: 'dispatch'
    }, { workflow: f.binding, dispatchInputs: f.dispatchInputs });
    expect(checkpoint!.response).toMatchObject({ status: 200, providerId: '100', requestId: expect.stringMatching(/^PROVIDER-/) });
    expect(checkpoint!.response!.requestId).not.toBe(correlation);
    expect(outcome.correlationId).toBe(correlation);
    expect(outcome.operation.operationId).not.toBe(correlation);
    expect(await f.execute()).toMatchObject({ correlationId: correlation, operation: { operationId: '100' } });
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('returns bounded pending and never dispatches a second run during continuation', async () => {
    const f = await dispatchFixture();
    f.protocol.runStatus = 'queued';
    const pending = await f.execute();
    expect(pending).toMatchObject({ status: 'pending', correlationId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      operation: { operationId: '100', status: 'running' } });
    expect(pending.correlationId).not.toBe(pending.operation.operationId);
    expect(await f.execute()).toMatchObject({ status: 'pending', correlationId: pending.correlationId });
    f.protocol.runs.get(100)!.status = 'completed';
    f.protocol.runs.get(100)!.conclusion = 'success';
    f.protocol.jobs.get(100)![0]!.status = 'completed';
    f.protocol.jobs.get(100)![0]!.conclusion = 'success';
    expect(await f.execute()).toMatchObject({ status: 'completed', correlationId: pending.correlationId, operation: { operationId: '100' } });
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it.each(['attempt', 'current', 'both'] as const)('retains the actual HTTP-200 run ID while %s readback is 404, without an observed proof or another dispatch', async (missing) => {
    const f = await dispatchFixture();
    f.protocol.runStatus = 'queued';
    const original = f.protocol.request.bind(f.protocol);
    let invisible = true;
    f.protocol.request = async (request) => {
      if (invisible && request.method === 'GET' && (
        (missing === 'attempt' || missing === 'both') && request.path === '/repos/owner/repo/actions/runs/100/attempts/1' ||
        (missing === 'current' || missing === 'both') && request.path === '/repos/owner/repo/actions/runs/100')) {
        f.protocol.requests.push(structuredClone(request));
        return { status: 404, headers: {}, data: { message: 'Exact recorded run is not visible yet' } };
      }
      return original(request);
    };
    const first = await f.execute();
    expect(first).toMatchObject({ status: 'pending', pendingReason: 'run-readback-unavailable',
      operation: { operationId: '100', resourceId: '/repos/owner/repo/actions/runs/100', planDigest: f.input.plan.planDigest } });
    expect(first).not.toHaveProperty('run');
    expect(await f.execute()).toMatchObject({ status: 'pending', correlationId: first.correlationId, operation: { operationId: '100' } });
    const records = await readWorkflowEffect(f.input, f.operation, {
      repositoryId: 42, ref: 'develop:4', purpose: 'workflow-dispatch', step: 'dispatch'
    }, { workflow: f.binding, dispatchInputs: f.dispatchInputs });
    expect(records!.response).toMatchObject({ status: 200, providerId: '100', requestId: expect.stringMatching(/^PROVIDER-/u) });
    expect(records!.observed).toBeNull();
    invisible = false;
    Object.assign(f.protocol.runs.get(100)!, { status: 'completed', conclusion: 'success' });
    Object.assign(f.protocol.jobs.get(100)![0]!, { status: 'completed', conclusion: 'success' });
    expect(await f.execute()).toMatchObject({ status: 'completed', operation: { operationId: '100' } });
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(f.protocol.requests.some((request) => request.path.includes('/actions/workflows/4/runs?'))).toBe(false);
  });

  it('bounds direct-ID visibility polling and admits an observed record only after both exact readers succeed', async () => {
    const f = await dispatchFixture();
    f.input.adapters.githubActivation!.pollAttempts = 3;
    const original = f.protocol.request.bind(f.protocol);
    let lookups = 0;
    f.protocol.request = async (request) => {
      if (request.method === 'GET' && request.path === '/repos/owner/repo/actions/runs/100/attempts/1' && ++lookups < 3) {
        f.protocol.requests.push(structuredClone(request));
        return { status: 404, headers: {}, data: { message: 'Not visible yet' } };
      }
      return original(request);
    };
    expect(await f.execute()).toMatchObject({ status: 'completed', operation: { operationId: '100' } });
    expect(lookups).toBe(4);
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('does not hide a visible actor mismatch behind another reader returning 404', async () => {
    const f = await dispatchFixture();
    const original = f.protocol.request.bind(f.protocol);
    f.protocol.request = async (request) => {
      if (request.path === '/repos/owner/repo/actions/runs/100/attempts/1') {
        return { status: 404, headers: {}, data: { message: 'Not visible' } };
      }
      if (request.path === '/repos/owner/repo/actions/runs/100') f.protocol.runs.get(100)!.actor.id = 8;
      return original(request);
    };
    await expect(f.execute()).rejects.toThrow(/Actual dispatched run/);
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('preserves a visible failed terminal result as an explicit readback exception, never a fabricated running handle', async () => {
    const f = await dispatchFixture();
    const original = f.protocol.request.bind(f.protocol);
    f.protocol.request = async (request) => {
      if (request.path === '/repos/owner/repo/actions/runs/100/attempts/1') {
        f.protocol.runs.get(100)!.conclusion = 'failure';
        return { status: 404, headers: {}, data: { message: 'Exact attempt unavailable' } };
      }
      return original(request);
    };
    await expect(f.execute()).rejects.toBeInstanceOf(WorkflowDispatchReadbackPendingError);
    await expect(f.execute()).rejects.toMatchObject({ code: 'dispatch-readback-pending',
      operation: { operationId: '100', status: 'failed', planDigest: f.input.plan.planDigest } });
    const records = await readWorkflowEffect(f.input, f.operation, {
      repositoryId: 42, ref: 'develop:4', purpose: 'workflow-dispatch', step: 'dispatch'
    }, { workflow: f.binding, dispatchInputs: f.dispatchInputs });
    expect(records!.observed).toBeNull();
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('recovers a lost response only by matching the recorded correlation and exact provider source/run identity', async () => {
    const f = await dispatchFixture();
    f.protocol.loseResponseFor = 'POST /repos/owner/repo/actions/workflows/4/dispatches';
    await expect(f.execute()).rejects.toThrow(/bounded execution window/);
    const recorded = await readWorkflowEffect(f.input, f.operation, {
      repositoryId: 42, ref: 'develop:4', purpose: 'workflow-dispatch', step: 'dispatch'
    }, { workflow: f.binding, dispatchInputs: f.dispatchInputs });
    expect(await f.execute()).toMatchObject({
      status: 'completed', correlationId: recorded!.prepared.correlationId, operation: { operationId: '100' }
    });
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('does not replace an uncertain request with a latest run or fabricate an operation ID', async () => {
    const f = await dispatchFixture();
    f.protocol.loseResponseFor = 'POST /repos/owner/repo/actions/workflows/4/dispatches';
    await expect(f.execute()).rejects.toThrow();
    f.protocol.runs.get(100)!.display_title = 'An unrelated provider run';
    await expect(f.execute()).rejects.toThrow(/no unique exact provider run identity/);
    f.protocol.runs.delete(100);
    await expect(f.execute()).rejects.toThrow(/no unique exact provider run identity/);
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('refuses uncertain recovery with multiple matching runs', async () => {
    const f = await dispatchFixture();
    f.protocol.loseResponseFor = 'POST /repos/owner/repo/actions/workflows/4/dispatches';
    await expect(f.execute()).rejects.toThrow();
    f.protocol.runs.set(101, { ...f.protocol.runs.get(100), id: 101 });
    await expect(f.execute()).rejects.toThrow(/no unique exact provider run identity/);
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('rejects an invalid polling bound and refuses approval mutation during final dispatch preconditions', async () => {
    const bound = await dispatchFixture();
    bound.input.adapters.githubActivation!.pollAttempts = 6;
    await expect(bound.execute()).rejects.toThrow(/before any dispatch/);
    expect(bound.protocol.requests).toEqual([]);
    const changed = await dispatchFixture();
    changed.protocol.beforeRequest = async (request) => {
      if (request.method !== 'GET' || !request.path.includes('/contents/')) return;
      const record = await readWorkflowEffect(changed.input, changed.operation, {
        repositoryId: 42, ref: 'develop:4', purpose: 'workflow-dispatch', step: 'dispatch'
      }, { workflow: changed.binding, dispatchInputs: changed.dispatchInputs });
      if (record) changed.input.plan.operations[0]!.inputs.dispatchInputs = { environment: 'production' };
    };
    await expect(changed.execute()).rejects.toThrow();
    expect(changed.protocol.requests.filter((request) => request.method === 'POST')).toEqual([]);
  });

  it('uses an immutable copy of approved inputs even if caller-owned arguments change during readback', async () => {
    const f = await dispatchFixture();
    f.protocol.beforeRequest = async (request) => {
      if (request.method !== 'GET' || !request.path.includes('/contents/')) return;
      f.dispatchInputs.environment = 'production';
      f.protocol.beforeRequest = undefined;
    };
    expect(await f.execute()).toMatchObject({ status: 'completed' });
    const dispatched = f.protocol.requests.find((request) => request.method === 'POST')!;
    expect(dispatched.body).toMatchObject({ inputs: { environment: 'dev' } });
  });

  it.each(['actor', 'ref', 'lease', 'expiry', 'issuance', 'phase', 'inputs'] as const)(
    'requires exact current %s authority before dispatch', async (field) => {
      const f = await dispatchFixture();
      if (field === 'actor') f.protocol.actorId = 8;
      if (field === 'ref') f.protocol.refs.set('develop', 'c'.repeat(40));
      if (field === 'expiry') f.input.clock = () => new Date('2026-09-16T00:00:00.000Z');
      if (field === 'issuance') {
        const authority = await createScopedUserLocalRecordStore(f.projectRoot, 'governance-approval', f.storage)
          .read(canonicalApprovalEnvelopeHash(f.envelope));
        await rm(authority!.path);
      }
      if (field === 'phase') f.input.plan.phaseId = 'staging-qualified';
      if (field === 'inputs') f.dispatchInputs.environment = 'production';
      if (field === 'lease') {
        await expect(dispatchApprovedWorkflowRun(f.input, f.operation, f.binding, f.dispatchInputs)).rejects.toThrow(/lease/);
      } else await expect(f.execute()).rejects.toThrow();
      expect(f.protocol.requests.filter((request) => request.method === 'POST')).toEqual([]);
    });

  it('binds an artifact to independent provider/run/source metadata and actual downloaded bytes', async () => {
    const f = await dispatchFixture();
    const dispatch = await f.execute();
    const archive = Buffer.from('fixture archive bytes, not a production qualification artifact');
    const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
    const metadata = { id: 55, name: 'application-result', expired: false, digest, size_in_bytes: archive.length,
      workflow_run: { id: 100, repository_id: 42, head_repository_id: 42, head_sha: f.binding.sourceSha, head_branch: 'develop' } };
    f.protocol.artifacts.set(55, { metadata, bytes: archive });
    const input = { client: new GitHubActivationClient(f.protocol), binding: f.binding, operation: dispatch.operation,
      artifactId: 55, name: 'application-result', expectedDigest: digest };
    expect(await readBoundWorkflowArtifact(input)).toMatchObject({ artifactId: 55, runId: 100, sourceSha: f.binding.sourceSha, digest, archive });
    metadata.workflow_run.head_repository_id = 43;
    await expect(readBoundWorkflowArtifact(input)).rejects.toThrow(/independently bound/);
    metadata.workflow_run.head_repository_id = 42;
    f.protocol.artifacts.get(55)!.bytes = Buffer.from('changed downloaded bytes');
    await expect(readBoundWorkflowArtifact(input)).rejects.toThrow(/provider committed digest/);
    f.protocol.artifacts.get(55)!.bytes = archive;
    f.protocol.runs.get(100)!.run_attempt = 2;
    await expect(readBoundWorkflowArtifact(input)).rejects.toThrow(/earlier attempt cannot supply current/);
  });
});
