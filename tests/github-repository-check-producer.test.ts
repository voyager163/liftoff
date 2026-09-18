import { afterEach, describe, expect, it } from 'vitest';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { canonicalPhaseGraph } from '../src/domain/governance/activation/graph.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { GitHubActivationClient } from '../src/adapters/github/activation-rest.js';
import {
  revalidateRepositoryChecksQualification, type ProtectedRefFamily, type RepositoryChecksEvidencePayload
} from '../src/adapters/github/production-checks.js';
import { planRepositoryChecks, executeRepositoryChecks, type RepositoryChecksPlanPayload } from '../src/application/repository-governance/producer-checks.js';
import { readWorkflowEffect } from '../src/application/repository-governance/workflow-checkpoints.js';
import { workflowOperationFixture } from './helpers/workflow-operation-fixture.js';
import { WorkflowGitHubFixture, workflowFixtureNow, workflowFixturePath, workflowFixtureSource } from './helpers/workflow-publication-fixture.js';

const fixtures: Awaited<ReturnType<typeof workflowOperationFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });

async function producerFixture(
  target: { refFamily: ProtectedRefFamily; branch: string } = { refFamily: 'develop', branch: 'develop' }
) {
  const protocol = new WorkflowGitHubFixture(workflowFixtureSource.replace('[develop]', `["${target.refFamily}"]`));
  if (target.branch !== 'develop' && target.branch !== 'main') protocol.refs.set(target.branch, protocol.baseSha);
  protocol.autoChecks = true;
  const phase = canonicalPhaseGraph.phases.find((phase) => phase.id === 'repository-checks-qualified')!;
  const f = await workflowOperationFixture('repository-checks-qualified', async (inspection) => {
    const plan = await planRepositoryChecks({ inspection, phase, runner: protocol.runner, now: new Date(workflowFixtureNow) });
    if (plan.blockers?.length) throw new Error(plan.blockers.join(' '));
    return plan.operations;
  }, protocol.runner, {
    predecessorSourceSha: protocol.baseSha,
    configuration: { schemaVersion: 1, repository: { name: 'owner/repo' }, phases: {
      'repository-checks-qualified': {
        sourceSha: protocol.baseSha, repositoryId: 42, actorId: 7, workflowPaths: [workflowFixturePath],
        fixtures: [{ refFamily: target.refFamily, targetBranch: target.branch, baseSha: protocol.baseSha,
          positiveBranch: 'automation/reviewed-positive', negativeBranch: 'automation/reviewed-negative', commitTime: workflowFixtureNow }]
      }
    } }
  });
  fixtures.push(f);
  const execute = () => withProjectMutationLock(f.projectRoot, (lease) => executeRepositoryChecks({ ...f.input, lease }));
  return { ...f, protocol, execute };
}

describe('real repository-check producer fixture transactions', () => {
  it.each(['release', 'hotfix'] as const)('publishes and revalidates approved nested %s/** fixture PRs without changing their protected targets', async (prefix) => {
    const family = `${prefix}/**` as const;
    const target = `${prefix}/maintenance/1.2.3`;
    const f = await producerFixture({ refFamily: family, branch: target });
    const outcome = await f.execute();
    expect(outcome.status).toBe('completed');
    const evidence = outcome.evidencePayload as RepositoryChecksEvidencePayload;
    expect(evidence.requiredContexts[0]!.refFamily).toBe(family);
    expect(evidence.boundFixtures.every((fixture) => fixture.refFamily === family &&
      fixture.publication.targetBranch === target && fixture.publication.baseSha === f.protocol.baseSha)).toBe(true);
    expect(f.protocol.refs.get(target)).toBe(f.protocol.baseSha);
    expect([...f.protocol.pullRequests.values()].every((pr) => pr.base.ref === target && pr.state === 'open' && !pr.merged)).toBe(true);
    const writes = f.protocol.requests.filter((request) => request.method === 'POST').length;
    const current = await revalidateRepositoryChecksQualification({
      client: new GitHubActivationClient(f.protocol), evidence
    });
    expect(current.requiredContexts).toEqual(evidence.requiredContexts);
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(writes);
  });

  it('creates controlled unmerged fixtures under private approval, preserving permanent refs and observing exact checks', async () => {
    const f = await producerFixture();
    const op = f.input.plan.operations[0]!;
    const payload = op.inputs as unknown as RepositoryChecksPlanPayload;
    expect(payload.requiredChecks.map((check) => check.context)).toEqual(['Node source validation']);
    f.protocol.beforeRequest = async (request) => {
      if (request.method !== 'POST' || !request.path.endsWith('/pulls')) return;
      const branch = (request.body as { head: string }).head;
      const fixture = payload.fixtures.find((fixture) => fixture.featureBranch === branch)!;
      const check = payload.requiredChecks[0]!;
      const binding = { repository: 'owner/repo', repositoryId: 42, workflowPath: workflowFixturePath, workflowId: 4,
        workflowDigest: check.workflowDigest, sourceSha: fixture.commitSha, producerSourceSha: payload.sourceSha,
        ref: branch, actorId: 7, event: 'pull_request', expectedJobs: ['Node source validation'], runAttempt: 1 };
      const checkpoint = await readWorkflowEffect(f.input, op, {
        repositoryId: 42, ref: `${branch}:4`, purpose: 'check-fixture', step: 'dispatch'
      }, { binding, fixtureDigest: canonicalSha256(fixture) });
      expect(checkpoint?.prepared).toBeDefined();
      expect(checkpoint?.observed).toBeNull();
    };
    const result = await f.execute();
    expect(result).toMatchObject({ status: 'completed', resultState: 'verified',
      evidencePayload: { kind: 'repository-checks-qualified.v1', sourceSha: f.protocol.baseSha,
        positiveChecks: [{ runId: 100, checkRunId: 10000, conclusion: 'success' }],
        controlledNegativeChecks: [{ runId: 101, checkRunId: 10100, conclusion: 'failure' }] } });
    expect(result.liveReadback?.map((proof) => proof.resourceId)).toEqual([
      '/repos/owner/repo/check-runs/10000', '/repos/owner/repo/check-runs/10100'
    ]);
    expect([...f.protocol.pullRequests.values()].every((pr) => pr.state === 'open' && !pr.merged && pr.draft)).toBe(true);
    expect(f.protocol.refs.get('develop')).toBe(f.protocol.baseSha);
    expect(f.protocol.refs.get('main')).toBe(f.protocol.mainSha);
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(8);
    expect((await f.execute()).status).toBe('completed');
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(8);
  });

  it('returns the actual pending run ID and resumes the same PR/event without duplicate dispatch', async () => {
    const f = await producerFixture();
    f.protocol.runStatus = 'queued';
    expect(await f.execute()).toMatchObject({ status: 'pending', operation: { operationId: '100', resourceId: '/repos/owner/repo/actions/runs/100' } });
    expect(f.protocol.pullRequests.size).toBe(1);
    f.protocol.runStatus = 'completed';
    Object.assign(f.protocol.runs.get(100)!, { status: 'completed', conclusion: 'success' });
    Object.assign(f.protocol.jobs.get(100)![0]!, { status: 'completed', conclusion: 'success' });
    expect((await f.execute()).status).toBe('completed');
    expect(f.protocol.runs.size).toBe(2);
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(8);
  });

  it('recovers a lost PR response using recorded source, branch and actual PR/run IDs only', async () => {
    const f = await producerFixture();
    f.protocol.loseResponseFor = 'POST /repos/owner/repo/pulls';
    expect((await f.execute()).status).toBe('blocked');
    expect((await f.execute()).status).toBe('completed');
    expect(f.protocol.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/pulls'))).toHaveLength(2);
    expect(f.protocol.runs.size).toBe(2);
  });

  it('keeps a recorded PR pending if no exact workflow event appears and never creates another PR', async () => {
    const f = await producerFixture();
    f.protocol.autoChecks = false;
    expect(await f.execute()).toMatchObject({ status: 'pending', operation: { operationId: '1', resourceId: '/repos/owner/repo/pulls/1' } });
    expect(await f.execute()).toMatchObject({ status: 'pending', operation: { operationId: '1' } });
    expect(f.protocol.pullRequests.size).toBe(1);
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(4);
  });

  it('refuses changed required workflow IDs or current source before creating a fixture', async () => {
    const f = await producerFixture();
    const payload = f.input.plan.operations[0]!.inputs as unknown as RepositoryChecksPlanPayload;
    const changed = { ...payload.requiredChecks[0]!, workflowId: 99 };
    f.input.plan.operations[0]!.inputs = { ...payload, requiredChecks: [changed] };
    expect((await f.execute()).status).toBe('blocked');
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toEqual([]);
  });

  it('retains all fixtures while rejecting a purported red caused by infrastructure failure', async () => {
    const f = await producerFixture();
    expect((await f.execute()).status).toBe('completed');
    const job = f.protocol.jobs.get(101)![0]!;
    job.steps[0].conclusion = 'failure';
    job.steps[2].conclusion = 'skipped';
    const result = await f.execute();
    expect(result).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('exact real validation step') });
    expect(f.protocol.pullRequests.size).toBe(2);
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(8);
    expect(f.protocol.refs.get('main')).toBe(f.protocol.mainSha);
  });

  it('retains complete bound fixtures and independently revalidates them without new provider effects', async () => {
    const f = await producerFixture();
    const outcome = await f.execute();
    expect(outcome.status).toBe('completed');
    const evidence = outcome.evidencePayload as RepositoryChecksEvidencePayload;
    expect(evidence.boundFixtures).toMatchObject([
      { polarity: 'positive', refFamily: 'develop', pullRequestNumber: 1,
        publication: { featureBranch: 'automation/reviewed-positive', targetBranch: 'develop', baseSha: f.protocol.baseSha },
        runs: [{ operation: { operationId: '100', resourceId: '/repos/owner/repo/actions/runs/100' } }] },
      { polarity: 'negative', refFamily: 'develop', pullRequestNumber: 2,
        publication: { featureBranch: 'automation/reviewed-negative', targetBranch: 'develop', baseSha: f.protocol.baseSha },
        runs: [{ operation: { operationId: '101', resourceId: '/repos/owner/repo/actions/runs/101' } }] }
    ]);
    expect(evidence.controlledNegativeChecks[0]!.appId).toBe(15368);
    const original = canonicalSha256(evidence);
    f.protocol.requests.length = 0;
    const current = await revalidateRepositoryChecksQualification({
      client: new GitHubActivationClient(f.protocol), evidence, now: new Date('2026-09-15T00:01:00.000Z')
    });
    expect(current.requiredContexts).toEqual(evidence.requiredContexts);
    expect(current.qualifiedAt).toBe('2026-09-15T00:01:00.000Z');
    expect(canonicalSha256(evidence)).toBe(original);
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(f.protocol.pullRequests.size).toBe(2);
  });

  it.each(['closed', 'merged', 'head', 'base', 'job', 'check', 'step'] as const)(
    'rejects current %s drift when rereading retained fixture evidence', async (field) => {
      const f = await producerFixture();
      const outcome = await f.execute();
      expect(outcome.status).toBe('completed');
      const evidence = outcome.evidencePayload as RepositoryChecksEvidencePayload;
      const pr = f.protocol.pullRequests.get(2)!;
      if (field === 'closed') pr.state = 'closed';
      if (field === 'merged') pr.merged = true;
      if (field === 'head') pr.head.sha = 'c'.repeat(40);
      if (field === 'base') pr.base.sha = 'c'.repeat(40);
      if (field === 'job') f.protocol.jobs.get(101)![0]!.id = 9191;
      if (field === 'check') {
        const check = f.protocol.checks.get(10100)!;
        f.protocol.checks.set(9191, { ...check, id: 9191 });
        f.protocol.jobs.get(101)![0]!.check_run_url = 'https://api.github.com/repos/owner/repo/check-runs/9191';
      }
      if (field === 'step') f.protocol.jobs.get(101)![0]!.steps[2].number = 5;
      f.protocol.requests.length = 0;
      await expect(revalidateRepositoryChecksQualification({
        client: new GitHubActivationClient(f.protocol), evidence
      })).rejects.toThrow();
      expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
      expect(f.protocol.pullRequests.size).toBe(2);
    });

  it('cannot revalidate copied conclusions without their retained fixture/run binding', async () => {
    const f = await producerFixture();
    const outcome = await f.execute();
    const evidence = outcome.evidencePayload as RepositoryChecksEvidencePayload;
    f.protocol.requests.length = 0;
    await expect(revalidateRepositoryChecksQualification({
      client: new GitHubActivationClient(f.protocol), evidence: { ...evidence, boundFixtures: [] }
    })).rejects.toThrow(/not copied proof fields/);
    expect(f.protocol.requests).toEqual([]);
  });
});
