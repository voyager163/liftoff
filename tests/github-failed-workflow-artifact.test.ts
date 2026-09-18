import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  canonicalApprovalEnvelopeHash, evaluateApprovalForTransitionPlan, transitionPlanForPhase
} from '../src/domain/governance/activation/approvals.js';
import { canonicalPhaseGraph } from '../src/domain/governance/activation/graph.js';
import { planDigestFor, rollbackPlanForPhase } from '../src/domain/governance/activation/operations.js';
import { validateApprovalEnvelope, validateSavedTransitionPlan } from '../src/domain/governance/activation/validators.js';
import { writeGovernanceApprovalAuthority } from '../src/governance-activation/authority-records.js';
import type { TransitionOperation } from '../src/domain/governance/activation/types.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { GitHubActivationClient, type GitHubRequest } from '../src/adapters/github/activation-rest.js';
import {
  dispatchApprovedWorkflowRun, readBoundFailedWorkflowArtifact, readBoundWorkflowArtifact, FailedWorkflowArtifactPendingError,
  type FailedWorkflowArtifactRequest, type WorkflowRunBinding
} from '../src/adapters/github/production-checks.js';
import { readWorkflowEffect } from '../src/application/repository-governance/workflow-checkpoints.js';
import { workflowOperationFixture } from './helpers/workflow-operation-fixture.js';
import {
  WorkflowGitHubFixture, dispatchFixtureSource, workflowFixtureNow, workflowFixturePath
} from './helpers/workflow-publication-fixture.js';

const failedSource = `${dispatchFixtureSource}      - name: Upload failed validation\n        if: always()\n        uses: actions/upload-artifact@${'b'.repeat(40)}\n        with:\n          name: controlled-negative-\${{ github.run_id }}\n          path: controlled-negative.json\n          if-no-files-found: error\n`;
const archive = Buffer.from('{"classification":"fixture assertion failure, not live qualification"}\n');
const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
const fixtures: Awaited<ReturnType<typeof workflowOperationFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

class FailedArtifactProtocol extends WorkflowGitHubFixture {
  override addRun(...args: Parameters<WorkflowGitHubFixture['addRun']>) {
    const run = super.addRun(...args);
    Object.assign(run, { conclusion: 'failure', updated_at: workflowFixtureNow });
    const job = this.jobs.get(run.id)![0]!;
    Object.assign(job, { run_attempt: 1, conclusion: 'failure', started_at: workflowFixtureNow, completed_at: workflowFixtureNow });
    job.steps[2].conclusion = 'failure';
    job.steps.splice(3, 0, { number: 4, name: 'Upload failed validation', status: 'completed', conclusion: 'success' });
    job.steps[4].number = 5;
    this.checks.get(run.id * 100)!.conclusion = 'failure';
    return run;
  }

  override async request(request: GitHubRequest) {
    const match = /^\/repos\/owner\/repo\/actions\/jobs\/(\d+)$/u.exec(request.path.split('?')[0]!);
    if (request.method === 'GET' && match) {
      this.requests.push(structuredClone(request));
      await this.beforeRequest?.(request);
      const job = [...this.jobs.values()].flat().find((entry) => entry.id === Number(match[1]));
      return { status: job ? 200 : 404, headers: {}, data: job ?? { message: 'Missing exact fixture job' } };
    }
    return super.request(request);
  }
}

async function failedFixture(source = failedSource, window?: { notBefore: string; expiresAt: string }) {
  const protocol = new FailedArtifactProtocol(source);
  const binding: WorkflowRunBinding = {
    repository: 'owner/repo', repositoryId: 42, workflowPath: workflowFixturePath, workflowId: 4,
    workflowDigest: canonicalSha256(source), sourceSha: protocol.baseSha, producerSourceSha: protocol.baseSha,
    ref: 'develop', actorId: 7, event: 'workflow_dispatch', expectedJobs: ['Node source validation'], runAttempt: 1
  };
  const destination = { type: 'repository' as const, identity: 'owner/repo', repository: 'owner/repo' };
  const dispatchInputs = { environment: 'dev' };
  const operation: TransitionOperation = {
    phaseId: 'dev-proof', adapter: 'github', actionId: 'github.checks.dev-proof', mutationClass: 'github-workflow-dispatch',
    inputs: { workflow: binding, dispatchInputs }, destination, remote: true, destructive: false,
    effects: [{ mutationClass: 'github-read', destination, remote: true, destructive: false }]
  };
  const f = await workflowOperationFixture('dev-proof', [operation], protocol.runner, window ? {
    configuration: { schemaVersion: 1, repository: { name: 'owner/repo' }, phases: { 'dev-proof': { disposableTarget: window } } }
  } : {});
  fixtures.push(f);
  f.input.adapters.githubActivation!.transport = protocol;
  const dispatched = await withProjectMutationLock(f.projectRoot, (lease) =>
    dispatchApprovedWorkflowRun({ ...f.input, lease }, operation, binding, dispatchInputs));
  expect(dispatched.status).toBe('completed');
  expect(dispatched.operation.status).toBe('failed');
  protocol.artifacts.set(55, {
    metadata: { id: 55, name: 'controlled-negative-100', expired: false, digest, size_in_bytes: archive.length,
      created_at: workflowFixtureNow,
      workflow_run: { id: 100, repository_id: 42, head_repository_id: 42, head_sha: binding.sourceSha, head_branch: binding.ref } },
    bytes: Buffer.from(archive)
  });
  const request: FailedWorkflowArtifactRequest = {
    origin: { kind: 'workflow-dispatch', phaseId: 'dev-proof', planDigest: f.input.plan.planDigest,
      savedPlanDigest: canonicalSha256(f.input.plan), operationDigest: canonicalSha256(operation) },
    binding, operation: dispatched.operation,
    job: { jobKey: 'verify', name: 'Node source validation', jobId: 1000, checkRunId: 10000,
      appId: 15368, validationStep: 'Validate source', uploadStep: 'Upload failed validation' },
    artifact: { artifactId: 55, name: 'controlled-negative-100', digest }
  };
  const read = () => withProjectMutationLock(f.projectRoot, (lease) =>
    readBoundFailedWorkflowArtifact({ execution: { ...f.input, lease }, operation, request }));
  protocol.requests.length = 0;
  return { ...f, protocol, binding, operation, dispatchInputs, request, read };
}

async function separatelyApprovedReader(f: Awaited<ReturnType<typeof failedFixture>>) {
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'rulesets-applied')!;
  const originalPlan = structuredClone(f.input.plan);
  f.input.inspection.contexts['dev-proof'].reviewedPlans = [originalPlan];
  const now = new Date('2026-09-15T00:20:00.000Z'), expiresAt = '2026-09-15T00:35:00.000Z';
  const context = f.input.inspection.contexts[phase.id];
  const operation: TransitionOperation = {
    phaseId: phase.id, adapter: 'github', actionId: 'github.ruleset.readback', mutationClass: 'github-read',
    destination: f.operation.destination, remote: true, destructive: false,
    inputs: { failedWorkflowArtifacts: [structuredClone(f.request)] }
  };
  const requested = transitionPlanForPhase(phase, f.input.inspection.state, context.transition, f.projectRoot, undefined, {
    operations: [operation], selectionScope: 'activation', fileChanges: [], recovery: false
  });
  const envelope = validateApprovalEnvelope({ ...requested, schemaVersion: 4, id: randomUUID(),
    approvedAt: now.toISOString(), expiresAt, approver: 'isolated-failed-artifact-reader' });
  await writeGovernanceApprovalAuthority(f.projectRoot, canonicalSha256(requested), envelope, f.storage);
  f.input.inspection.approvals = [...f.input.inspection.approvals, envelope];
  const evaluation = evaluateApprovalForTransitionPlan(requested, [envelope], { now });
  const plan = validateSavedTransitionPlan({
    ...originalPlan, phaseId: phase.id, scope: 'activation', selectionScope: 'activation',
    createdAt: now.toISOString(), expiresAt, baselineDigest: context.baselineSha, inputDigest: context.inputDigest,
    transitionDigest: context.transition.transitionDigest, operations: [operation], mutationClasses: phase.allowedMutations,
    planDigest: planDigestFor({ phase, transitionDigest: context.transition.transitionDigest,
      operations: [operation], approvalPlanDigest: requested.planDigest }),
    approval: { gateKind: phase.approvalGate.kind, required: phase.approvalGate.required, evaluation,
      envelopeId: evaluation.envelopeId, envelopeHash: evaluation.envelopeHash },
    rollbackPlan: rollbackPlanForPhase(phase)
  });
  const execution = { ...f.input, phase, plan, now, clock: () => now };
  const read = () => withProjectMutationLock(f.projectRoot, (lease) =>
    readBoundFailedWorkflowArtifact({ execution: { ...execution, lease }, operation, request: f.request }));
  return { execution, operation, read };
}

describe('original failed qualification artifact readback', () => {
  it('returns the real failed conclusion and digest-verified bytes without redispatch or changing the success-only reader', async () => {
    const f = await failedFixture();
    const result = await f.read();
    expect(result).toMatchObject({
      artifactId: 55, name: 'controlled-negative-100', digest, archive, conclusion: 'failure', runId: 100, runAttempt: 1,
      origin: f.request.origin, checkpointDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      job: { id: 1000, checkRunId: 10000, appId: 15368, conclusion: 'failure' }, reportPath: 'controlled-negative.json'
    });
    expect(await f.read()).toMatchObject({ runId: 100, artifactId: 55, conclusion: 'failure' });
    await expect(readBoundWorkflowArtifact({
      client: new GitHubActivationClient(f.protocol), binding: f.binding, operation: f.request.operation,
      artifactId: 55, name: f.request.artifact.name, expectedDigest: digest
    })).rejects.toThrow(/failed producer run/);
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(f.protocol.runs.size).toBe(1);
  });

  it.each(['success', 'skipped', 'neutral', 'cancelled', 'timed_out'])('does not reinterpret %s as an original failed qualification', async (conclusion) => {
    const f = await failedFixture();
    f.protocol.runs.get(100)!.conclusion = conclusion;
    f.protocol.jobs.get(100)![0]!.conclusion = conclusion;
    f.protocol.checks.get(10000)!.conclusion = conclusion;
    await expect(f.read()).rejects.toThrow();
    expect(f.protocol.requests.some((request) => request.binary)).toBe(false);
  });

  it.each(['setup-failure', 'infra-output', 'validation-skipped', 'upload-skipped', 'upload-missing', 'unrelated-failure'] as const)(
    'rejects %s instead of admitting infrastructure or incomplete negative evidence', async (change) => {
      const f = await failedFixture();
      const job = f.protocol.jobs.get(100)![0]!;
      if (change === 'setup-failure') job.steps[0].conclusion = 'failure';
      if (change === 'infra-output') f.protocol.checks.get(10000)!.output.summary = 'runner lost communication; infrastructure error';
      if (change === 'validation-skipped') job.steps[2].conclusion = 'skipped';
      if (change === 'upload-skipped') job.steps[3].conclusion = 'skipped';
      if (change === 'upload-missing') job.steps.splice(3, 1);
      if (change === 'unrelated-failure') job.steps[4].conclusion = 'failure';
      await expect(f.read()).rejects.toThrow();
      expect(f.protocol.requests.some((request) => request.binary)).toBe(false);
    });

  it.each(['repository', 'actor', 'triggering-actor', 'source', 'ref', 'workflow', 'attempt', 'job', 'check', 'app', 'correlation'] as const)(
    'independently rejects actual %s drift', async (change) => {
      const f = await failedFixture();
      const run = f.protocol.runs.get(100)!;
      if (change === 'repository') run.repository.id = 43;
      if (change === 'actor') run.actor.id = 8;
      if (change === 'triggering-actor') run.triggering_actor.id = 8;
      if (change === 'source') run.head_sha = 'c'.repeat(40);
      if (change === 'ref') f.protocol.refs.set('develop', 'c'.repeat(40));
      if (change === 'workflow') run.workflow_id = 5;
      if (change === 'attempt') run.run_attempt = 2;
      if (change === 'job') f.protocol.jobs.get(100)![0]!.id = 1001;
      if (change === 'check') f.protocol.jobs.get(100)![0]!.check_run_url = 'https://api.github.com/repos/owner/repo/check-runs/10001';
      if (change === 'app') f.protocol.checks.get(10000)!.app.id = 88;
      if (change === 'correlation') run.display_title = 'An unrelated failed run';
      await expect(f.read()).rejects.toThrow();
      expect(f.protocol.requests.some((request) => request.binary)).toBe(false);
    });

  it.each(['id', 'name', 'digest', 'run', 'source', 'repository', 'expired', 'created-at', 'bytes'] as const)(
    'rejects an artifact with mismatched %s instead of finding a replacement', async (change) => {
      const f = await failedFixture();
      const artifact = f.protocol.artifacts.get(55)!;
      const producer = artifact.metadata.workflow_run as Record<string, unknown>;
      if (change === 'id') artifact.metadata.id = 56;
      if (change === 'name') artifact.metadata.name = 'some-other-report';
      if (change === 'digest') artifact.metadata.digest = `sha256:${'a'.repeat(64)}`;
      if (change === 'run') producer.id = 101;
      if (change === 'source') producer.head_sha = 'c'.repeat(40);
      if (change === 'repository') producer.repository_id = 43;
      if (change === 'expired') artifact.metadata.expired = true;
      if (change === 'created-at') artifact.metadata.created_at = '2026-09-14T23:59:59.000Z';
      if (change === 'bytes') artifact.bytes = Buffer.from('different downloaded bytes');
      await expect(f.read()).rejects.toThrow();
      expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
      expect(f.protocol.requests.some((request) => /\/runs\/\d+\/artifacts/u.test(request.path))).toBe(false);
    });

  it.each(['plan', 'saved-plan', 'operation', 'provider-id', 'phase', 'prepared', 'observed', 'issuance', 'private-home'] as const)(
    'rejects missing or wrong original %s authority before provider access', async (change) => {
      const f = await failedFixture();
      const original = await readWorkflowEffect(f.input, f.operation, {
        repositoryId: 42, ref: 'develop:4', purpose: 'workflow-dispatch', step: 'dispatch'
      }, { workflow: f.binding, dispatchInputs: f.dispatchInputs });
      if (change === 'plan') f.request.origin.planDigest = 'a'.repeat(64);
      if (change === 'saved-plan') f.request.origin.savedPlanDigest = 'a'.repeat(64);
      if (change === 'operation') f.request.origin.operationDigest = 'a'.repeat(64);
      if (change === 'provider-id') Object.assign(f.request.operation, { operationId: '101', resourceId: '/repos/owner/repo/actions/runs/101' });
      if (change === 'phase') f.request.origin.phaseId = 'staging-qualified';
      if (change === 'prepared' || change === 'observed') {
        const key = canonicalSha256({ intentDigest: original!.prepared.intentDigest, attempt: original!.prepared.attempt, stage: change });
        const record = await createScopedUserLocalRecordStore(f.projectRoot, 'governance-operation', f.storage).read(key);
        await rm(record!.path);
      }
      if (change === 'issuance') {
        const record = await createScopedUserLocalRecordStore(f.projectRoot, 'governance-approval', f.storage).read(canonicalApprovalEnvelopeHash(f.envelope));
        await rm(record!.path);
      }
      if (change === 'private-home') {
        const other = await failedFixture();
        f.input.adapters.githubActivation!.storage = other.storage;
      }
      await expect(f.read()).rejects.toThrow();
      expect(f.protocol.requests).toEqual([]);
    });

  it('requires the current actual lease and current unexpired phase authority even for readback', async () => {
    const f = await failedFixture();
    await expect(readBoundFailedWorkflowArtifact({ execution: f.input, operation: f.operation, request: f.request })).rejects.toThrow(/lease/);
    f.input.clock = () => new Date('2026-09-15T01:00:00.000Z');
    await expect(f.read()).rejects.toThrow(/expired/);
    expect(f.protocol.requests).toEqual([]);
  });

  it('stops subsequent provider reads when the current approval expires during observation', async () => {
    const f = await failedFixture();
    let now = f.input.now;
    f.input.clock = () => now;
    f.protocol.beforeRequest = async () => {
      now = new Date('2026-09-15T01:00:00.000Z');
      f.protocol.beforeRequest = undefined;
    };
    await expect(f.read()).rejects.toThrow(/expired/);
    expect(f.protocol.requests.some((request) => request.path.includes('/actions/runs/'))).toBe(false);
    expect(f.protocol.requests.some((request) => request.binary)).toBe(false);
  });

  it('keeps a known missing artifact explicitly pending with its exact request and no latest lookup', async () => {
    const f = await failedFixture();
    f.protocol.artifacts.delete(55);
    await expect(f.read()).rejects.toMatchObject({
      name: 'GitHubActivationError', code: 'failed-artifact-pending', request: f.request
    });
    await expect(f.read()).rejects.toBeInstanceOf(FailedWorkflowArtifactPendingError);
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(f.protocol.requests.some((request) => /\/runs\/\d+\/artifacts/u.test(request.path))).toBe(false);
  });

  it.each([0, 4 * 1024 * 1024 + 1, 0.5])('rejects the invalid provider archive size %s before downloading', async (size) => {
    const f = await failedFixture();
    f.protocol.artifacts.get(55)!.metadata.size_in_bytes = size;
    await expect(f.read()).rejects.toThrow(/independently bound/);
    expect(f.protocol.requests.some((request) => request.binary)).toBe(false);
  });

  it('accepts the exact four-MiB archive limit and rejects an actual oversized response independently', async () => {
    const f = await failedFixture();
    const artifact = f.protocol.artifacts.get(55)!;
    artifact.bytes = Buffer.alloc(4 * 1024 * 1024, 'x');
    artifact.metadata.size_in_bytes = artifact.bytes.length;
    artifact.metadata.digest = `sha256:${createHash('sha256').update(artifact.bytes).digest('hex')}`;
    f.request.artifact.digest = String(artifact.metadata.digest);
    expect((await f.read()).size).toBe(4 * 1024 * 1024);
    artifact.bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 'x');
    artifact.metadata.digest = `sha256:${createHash('sha256').update(artifact.bytes).digest('hex')}`;
    f.request.artifact.digest = String(artifact.metadata.digest);
    await expect(f.read()).rejects.toThrow(/bounded artifact bytes/);
  });

  it('admits an expired original producer only under a separate fresh exact read approval, without substituting its clock or phase', async () => {
    const f = await failedFixture();
    const reader = await separatelyApprovedReader(f);
    expect(Date.parse(f.input.plan.expiresAt)).toBeLessThan(reader.execution.now.getTime());
    expect(await reader.read()).toMatchObject({ conclusion: 'failure', archive, origin: f.request.origin });
    expect(reader.execution.phase.id).toBe('rulesets-applied');
    expect(reader.execution.now.toISOString()).toBe('2026-09-15T00:20:00.000Z');
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('accepts an ordinary approval later than the raw request start without rewriting either timestamp', async () => {
    const window = { notBefore: '2026-09-14T23:59:00.000Z', expiresAt: '2026-09-15T00:10:00.000Z' };
    const f = await failedFixture(failedSource, window);
    expect(f.envelope.approvedAt).toBe(workflowFixtureNow);
    expect(await f.read()).toMatchObject({ conclusion: 'failure', origin: f.request.origin });
    expect(f.input.plan.configuration!.phases['dev-proof']!.disposableTarget).toEqual(window);
    expect(f.envelope.approvedAt).toBe(workflowFixtureNow);
  });

  it.each([
    { notBefore: '2026-09-15T00:01:00.000Z', expiresAt: '2026-09-15T00:10:00.000Z' },
    { notBefore: '2026-09-14T23:58:00.000Z', expiresAt: '2026-09-14T23:59:00.000Z' }
  ])('rejects an original effect outside the raw request/plan/approval intersection %j', async (window) => {
    const f = await failedFixture(failedSource, window);
    await expect(f.read()).rejects.toThrow(/intersection of its raw request/);
    expect(f.protocol.requests).toEqual([]);
  });

  it.each(['reference', 'original-plan', 'original-approval', 'original-window'] as const)(
    'a new reader cannot replace the original %s', async (change) => {
      const f = await failedFixture();
      const reader = await separatelyApprovedReader(f);
      if (change === 'reference') f.request.artifact.artifactId = 56;
      if (change === 'original-plan') f.input.inspection.contexts['dev-proof'].reviewedPlans = [];
      if (change === 'original-approval') f.input.inspection.approvals = f.input.inspection.approvals.filter((entry) => entry.id !== f.envelope.id);
      if (change === 'original-window') {
        f.protocol.jobs.get(100)![0]!.completed_at = '2026-09-15T00:16:00.000Z';
        f.protocol.runs.get(100)!.updated_at = '2026-09-15T00:16:00.000Z';
      }
      await expect(reader.read()).rejects.toThrow();
      expect(f.protocol.requests.some((request) => request.binary)).toBe(false);
    });

  it.each(['attempt', 'job', 'issuance', 'checkpoint'] as const)('rejects %s drift during the download instead of returning stale bytes', async (change) => {
    const f = await failedFixture();
    f.protocol.beforeRequest = async (request) => {
      if (!request.binary) return;
      if (change === 'attempt') f.protocol.runs.get(100)!.run_attempt = 2;
      if (change === 'job') f.protocol.jobs.get(100)![0]!.id = 1001;
      if (change === 'issuance') {
        const record = await createScopedUserLocalRecordStore(f.projectRoot, 'governance-approval', f.storage).read(canonicalApprovalEnvelopeHash(f.envelope));
        await rm(record!.path);
      }
      if (change === 'checkpoint') {
        const records = await readWorkflowEffect(f.input, f.operation, {
          repositoryId: 42, ref: 'develop:4', purpose: 'workflow-dispatch', step: 'dispatch'
        }, { workflow: f.binding, dispatchInputs: f.dispatchInputs });
        const key = canonicalSha256({ intentDigest: records!.prepared.intentDigest, attempt: records!.prepared.attempt, stage: 'observed' });
        const record = await createScopedUserLocalRecordStore(f.projectRoot, 'governance-operation', f.storage).read(key);
        await rm(record!.path);
      }
      f.protocol.beforeRequest = undefined;
    };
    await expect(f.read()).rejects.toThrow();
  });

  it.each([
    ['mutable action', failedSource.replace(`upload-artifact@${'b'.repeat(40)}`, 'upload-artifact@v4')],
    ['skipped upload source', failedSource.replace('if: always()', "if: github.ref == 'refs/heads/main'")],
    ['missing-file success', failedSource.replace('if-no-files-found: error', 'if-no-files-found: ignore')],
    ['different report name', failedSource.replace('name: controlled-negative-', 'name: unrelated-')],
    ['escaping report path', failedSource.replace('path: controlled-negative.json', 'path: ../controlled-negative.json')]
  ])('rejects %s in the actual immutable upload recipe', async (_label, source) => {
    const f = await failedFixture(source);
    await expect(f.read()).rejects.toThrow();
    expect(f.protocol.requests.some((request) => request.binary)).toBe(false);
  });

  it('uses a copied request rather than mutable caller metadata during provider readback', async () => {
    const f = await failedFixture();
    f.protocol.beforeRequest = async () => {
      f.request.artifact.name = 'mutated caller name';
      f.protocol.beforeRequest = undefined;
    };
    expect(await f.read()).toMatchObject({ name: 'controlled-negative-100', conclusion: 'failure', archive });
  });

  it('retains the digest-verified download snapshot while subsequent provider readback continues', async () => {
    const f = await failedFixture();
    let downloaded = false;
    f.protocol.beforeRequest = async (request) => {
      if (request.binary) { downloaded = true; return; }
      if (downloaded) {
        f.protocol.artifacts.get(55)!.bytes.fill(0);
        f.protocol.beforeRequest = undefined;
      }
    };
    const result = await f.read();
    expect(result.archive).toEqual(archive);
    expect(`sha256:${createHash('sha256').update(result.archive).digest('hex')}`).toBe(result.digest);
  });
});
