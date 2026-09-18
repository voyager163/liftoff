import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { GitHubActivationClient, type GitHubActivationTransport, type GitHubRequest } from '../src/adapters/github/activation-rest.js';
import { observeOrPollWorkflowRun } from '../src/adapters/github/production-checks.js';
import { githubSourceFixture } from './helpers/github-source-fixture.js';

function fixture() {
  const head = 'a'.repeat(40);
  const workflow = 'name: Verify\non: workflow_dispatch\njobs:\n  verify:\n    runs-on: ubuntu-latest\n';
  const requests: GitHubRequest[] = [];
  const run = {
    id: 17, run_attempt: 1, workflow_id: 4, actor: { id: 7 }, repository: { full_name: 'owner/repo' },
    path: '.github/workflows/verify.yml', head_branch: 'feature/qualification', head_sha: head,
    event: 'workflow_dispatch', status: 'completed', conclusion: 'success'
  };
  const job = { id: 71, run_id: 17, head_sha: head, name: 'verify', status: 'completed', conclusion: 'success' };
  let source = workflow;
  const transport: GitHubActivationTransport = {
    async request(request) {
      requests.push(request);
      expect(request.method).toBe('GET');
      const path = request.path.split('?')[0];
      const data = path?.endsWith('/attempts/1/jobs') ? { total_count: 1, jobs: [job] } :
        path?.endsWith('/attempts/1') ? run :
          path?.includes('/contents/') ? githubSourceFixture('.github/workflows/verify.yml', source) :
            null;
      return { status: data ? 200 : 404, headers: {}, data };
    }
  };
  const input = {
    client: new GitHubActivationClient(transport), repository: 'owner/repo', workflowFileName: 'verify.yml',
    expectedHeadSha: head, expectedEvent: 'workflow_dispatch', expectedRef: 'feature/qualification',
    expectedActorId: 7, expectedWorkflowId: 4, expectedWorkflowDigest: canonicalSha256(workflow), expectedJobs: ['verify'],
    pendingOperation: {
      provider: 'github' as const, actionId: 'github.checks.dev-proof', operationId: '17',
      resourceId: '/repos/owner/repo/actions/runs/17', startedAt: '2026-09-01T00:00:00.000Z',
      observedAt: '2026-09-01T00:00:00.000Z', status: 'running' as const
    }
  };
  return { input, requests, run, job, changeSource: () => { source += '\n# Changed source\n'; } };
}

describe('provider-issued workflow operation readback', () => {
  it('does not adopt the latest unrelated workflow or dispatch a replacement without a bound operation', async () => {
    const f = fixture();
    await expect(observeOrPollWorkflowRun({ ...f.input, pendingOperation: undefined })).rejects.toThrow(/provider-issued run ID/);
    expect(f.requests).toEqual([]);
  });

  it('reads the exact run attempt, source and required job without writing or dispatching', async () => {
    const f = fixture();
    expect(await observeOrPollWorkflowRun(f.input)).toMatchObject({
      runId: 17, workflowId: 4, headSha: 'a'.repeat(40), conclusion: 'success',
      jobs: [{ id: 71, name: 'verify', conclusion: 'success' }]
    });
    expect(f.requests.some((request) => request.path.includes('/actions/runs?'))).toBe(false);
    expect(f.requests).toHaveLength(3);
  });

  it.each(['actor', 'head', 'ref', 'workflow', 'attempt'] as const)('rejects changed %s rather than copying expected identity into proof', async (change) => {
    const f = fixture();
    if (change === 'actor') f.run.actor.id = 8;
    if (change === 'head') f.run.head_sha = 'b'.repeat(40);
    if (change === 'ref') f.run.head_branch = 'main';
    if (change === 'workflow') f.run.workflow_id = 5;
    if (change === 'attempt') f.run.run_attempt = 2;
    await expect(observeOrPollWorkflowRun(f.input)).rejects.toThrow(/differs from the reviewed operation/);
  });

  it('requires source byte readback and settled non-skipped required jobs', async () => {
    const source = fixture();
    source.changeSource();
    await expect(observeOrPollWorkflowRun(source.input)).rejects.toThrow(/workflow bytes differ/);
    const job = fixture();
    job.job.conclusion = 'skipped';
    await expect(observeOrPollWorkflowRun(job.input)).rejects.toThrow(/Required job identity or result/);
  });
});
