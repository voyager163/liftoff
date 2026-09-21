import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { securityWorkflowInvocation } from '../scripts/repository-security/workflow-invocation.ts';
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
