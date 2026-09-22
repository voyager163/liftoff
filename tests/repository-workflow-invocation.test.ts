import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { securityWorkflowInvocation, verifyPrExecution, verifiedPrExecutionIdentity } from '../scripts/repository-security/workflow-invocation.ts';
import { fixtureGitEnvironment, fixtureGitOptions } from '../scripts/repository-security/gitleaks.ts';
import { createAdmissionGitFixture } from './fixtures/security-git.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40), merge = 'c'.repeat(40), workflow = 'd'.repeat(40);
function environment(): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'voyager163/liftoff',
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: merge, GITHUB_WORKFLOW_SHA: workflow,
    GITHUB_RUN_ID: '35578908402', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_REF: 'refs/pull/91/merge', GITHUB_BASE_REF: 'develop',
    LIFTOFF_PR_BASE_SHA: base, LIFTOFF_PR_HEAD_SHA: head, LIFTOFF_SCAN_REF: ''
  };
}
const observed = { checkoutSha: merge, mergeParents: [base, head] };

function hostedFixture() {
  const now = new Date('2026-09-22T12:00:00Z');
  const env: NodeJS.ProcessEnv = { ...environment(), GITHUB_WORKFLOW_SHA: merge };
  const tree = 'e'.repeat(40), root = '/repos/voyager163/liftoff';
  const expected = { workflow: '.github/workflows/codeql.yml', jobId: 123, jobName: 'Source analysis fixture' };
  const pull = { number: 91, state: 'open', merged: false, merge_commit_sha: merge,
    base: { ref: 'develop', sha: base, repo: { full_name: 'voyager163/liftoff' } }, head: { sha: head } };
  const run = { id: Number(env.GITHUB_RUN_ID), run_attempt: 1, event: 'pull_request', head_sha: head,
    path: expected.workflow, repository: { full_name: 'voyager163/liftoff' }, status: 'completed', conclusion: 'failure' };
  const commit = { sha: merge, tree: { sha: tree }, parents: [{ sha: base }, { sha: head }] };
  const job = { id: 123, run_id: run.id, run_attempt: 1, head_sha: head, name: expected.jobName, status: 'completed',
    conclusion: 'failure', completed_at: '2026-09-22T11:59:00Z', check_run_url: 'https://api.github.com/repos/voyager163/liftoff/check-runs/456' };
  const check = { id: 456, name: expected.jobName, head_sha: head, status: 'completed', conclusion: 'failure',
    app: { id: 15368, slug: 'github-actions' } };
  const records: Record<string, unknown> = {
    [`${root}/pulls/91`]: pull, [`${root}/actions/runs/${env.GITHUB_RUN_ID}`]: run,
    [`${root}/git/commits/${merge}`]: commit, [`${root}/actions/jobs/123`]: job, [`${root}/check-runs/456`]: check
  };
  const requested: string[][] = [];
  const execute: NonNullable<Parameters<typeof verifyPrExecution>[4]> = (_command, args, options) => {
    requested.push([...args]); expect(options.shell).toBe(false); expect(args).toContain('GET');
    const value = records[args.at(-1)!];
    if (!value) throw new Error('Unregistered fixture endpoint');
    const stdout = JSON.stringify(value);
    return { pid: 1, stdout, stderr: '', output: [null, stdout, ''], status: 0, signal: null };
  };
  return { now, env, tree, expected, pull, run, commit, job, check, execute, requested };
}

describe('independent hosted PR execution origin binding', () => {
  it('retains base/head/tested identities and a failed finding job without promoting it to analysis success', () => {
    const f = hostedFixture(), handle = verifyPrExecution(f.env, { ...observed, tree: f.tree }, f.expected, f.now, f.execute);
    const identity = verifiedPrExecutionIdentity(handle, f.now);
    expect(identity).toMatchObject({ invocation: { sourceSha: merge, baseSha: base, pullRequestHeadSha: head,
      workflowSha: merge, runId: f.env.GITHUB_RUN_ID, attempt: 1 }, tree: f.tree,
      jobConclusion: 'failure', workflowContentsAttested: false, findingPolicyEvaluated: false, wholeAdmissionQualified: false });
    expect(f.requested).toHaveLength(7);
    expect(() => verifiedPrExecutionIdentity(structuredClone(handle), f.now)).toThrow('unverified-hosted-execution');
    expect(() => verifiedPrExecutionIdentity(handle, new Date(f.now.getTime() + 300_001))).toThrow('hosted-execution-stale');
  });
  it.each(['stale-merge', 'wrong-base', 'wrong-head', 'wrong-checkout', 'wrong-parents', 'wrong-tree',
    'wrong-attempt', 'wrong-workflow', 'wrong-app', 'wrong-event', 'skipped-job'] as const)(
    'rejects %s before an origin handle can be issued', change => {
    const f = hostedFixture(), local = { ...observed, tree: f.tree };
    if (change === 'stale-merge') f.pull.merge_commit_sha = head;
    if (change === 'wrong-base') f.pull.base.sha = head;
    if (change === 'wrong-head') f.pull.head.sha = base;
    if (change === 'wrong-checkout') local.checkoutSha = head;
    if (change === 'wrong-parents') f.commit.parents.reverse();
    if (change === 'wrong-tree') f.commit.tree.sha = 'f'.repeat(40);
    if (change === 'wrong-attempt') f.run.run_attempt = 2;
    if (change === 'wrong-workflow') f.run.path = '.github/workflows/another.yml';
    if (change === 'wrong-app') f.check.app.id = 1;
    if (change === 'wrong-event') f.run.event = 'workflow_dispatch';
    if (change === 'skipped-job') f.job.conclusion = 'skipped';
    expect(() => verifyPrExecution(f.env, local, f.expected, f.now, f.execute)).toThrow();
  });
  it('rechecks drift rather than trusting a merge-looking first response', () => {
    const f = hostedFixture();
    const execute: NonNullable<Parameters<typeof verifyPrExecution>[4]> = (command, args, options) => {
      if (f.requested.length === 5) f.pull.head.sha = base;
      return f.execute(command, args, options);
    };
    expect(() => verifyPrExecution(f.env, { ...observed, tree: f.tree }, f.expected, f.now, execute)).toThrow('hosted-pr-drift');
  });
});
describe('actual workflow invocation versus local scan identity', () => {
  it('binds independently read real synthetic Git merge parents rather than caller labels alone', async () => {
    const fixture = await createAdmissionGitFixture();
    try {
      const first = await fixture.commit({ 'input.txt': 'Inert baseline.\n' });
      const second = await fixture.commit({ 'input.txt': 'Inert candidate.\n' });
      const owner = path.dirname(fixture.root);
      const git = (args: string[]) => execFileSync('git', [...fixtureGitOptions(owner), ...args], {
        cwd: fixture.root, encoding: 'utf8',
        env: { ...fixtureGitEnvironment(owner, path.join(owner, 'wrapper')), PATH: process.env.PATH }
      }).trim();
      const tree = git(['rev-parse', `${second}^{tree}`]);
      const tested = git(['commit-tree', tree, '-p', first, '-p', second, '-m', 'Synthetic tested merge']);
      const parents = git(['show', '--no-patch', '--format=%P', tested]).split(' ');
      const env = { ...environment(), GITHUB_SHA: tested, LIFTOFF_PR_BASE_SHA: first, LIFTOFF_PR_HEAD_SHA: second };
      expect(securityWorkflowInvocation(env, { checkoutSha: tested, mergeParents: parents })).toMatchObject({
        sourceSha: tested, baseSha: first, pullRequestHeadSha: second
      });
      expect(() => securityWorkflowInvocation(env, { checkoutSha: second, mergeParents: parents })).toThrow('checkout');
    } finally { await fixture.cleanup(); }
  });
  it('retains actual PR run, base, head, tested merge and workflow identities independently', () => {
    expect(securityWorkflowInvocation(environment(), observed)).toEqual({
      repository: 'voyager163/liftoff', event: 'pull_request', sourceSha: merge, baseSha: base,
      workflowSha: workflow, runId: '35578908402', attempt: 1, ref: 'refs/pull/91/merge',
      githubEventSha: merge, pullRequestHeadSha: head, sourceKind: 'tested-merge',
      authentication: 'runner-metadata-and-local-git-not-independent-hosted-readback'
    });
  });
  it.each([
    { GITHUB_REPOSITORY: 'another/repository' }, { GITHUB_ACTIONS: 'false' }, { GITHUB_RUN_ID: '' },
    { GITHUB_RUN_ID: 'invented-local-run' },
    { GITHUB_RUN_ATTEMPT: '01' }, { GITHUB_SHA: head }, { GITHUB_WORKFLOW_SHA: '' },
    { GITHUB_BASE_REF: 'unregistered' }, { LIFTOFF_PR_BASE_SHA: head }, { LIFTOFF_PR_HEAD_SHA: base },
    { GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_REF: 'refs/pull/91/head' }, { LIFTOFF_SCAN_REF: 'main' }
  ])('rejects changed or incomplete runner context %#', change => {
    expect(() => securityWorkflowInvocation({ ...environment(), ...change }, observed)).toThrow();
  });
  it.each([{ parents: [] }, { parents: [base] }, { parents: [head, base] }, { parents: [base, workflow] }])(
    'rejects incompatible or shallow merge ancestry %j', ({ parents }) => {
      expect(() => securityWorkflowInvocation(environment(), { checkoutSha: merge, mergeParents: parents })).toThrow('merge-ancestry');
  });
  it('binds a scheduled main checkout separately from the default-branch event SHA', () => {
    const env = { ...environment(), GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: 'refs/heads/develop', LIFTOFF_SCAN_REF: 'main' };
    const result = securityWorkflowInvocation(env, { checkoutSha: head, selectedRef: { ref: 'refs/heads/main', sha: head } });
    expect(result).toMatchObject({ sourceSha: head, baseSha: head, githubEventSha: merge, ref: 'refs/heads/main', event: 'schedule' });
    expect(() => securityWorkflowInvocation(env, { checkoutSha: head })).toThrow('scheduled-ref');
    expect(() => securityWorkflowInvocation(env, { checkoutSha: head, selectedRef: { ref: 'refs/heads/main', sha: merge } }))
      .toThrow('scheduled-ref');
  });
  it('accepts a bounded manual candidate branch without granting protected-source or release authority', () => {
    const env = { ...environment(), GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/candidate' };
    expect(securityWorkflowInvocation(env, { checkoutSha: merge })).toMatchObject({
      event: 'workflow_dispatch', sourceKind: 'checked-out-ref', pullRequestHeadSha: null
    });
    expect(() => securityWorkflowInvocation({ ...env, GITHUB_REF: 'refs/tags/v1.0.0' }, { checkoutSha: merge })).toThrow();
  });
});
