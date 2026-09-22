import { parseIdentity, sha, SecurityEvidenceError } from './evidence.ts';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';

function fail(code: string): never { throw new SecurityEvidenceError(`workflow-invocation-${code}`); }
const emptyDigest = `sha256:${'0'.repeat(64)}`;

export function securityWorkflowInvocation(
  environment: NodeJS.ProcessEnv,
  observed: { checkoutSha: string; mergeParents?: readonly string[]; selectedRef?: { ref: string; sha: string } }
) {
  const event = (['pull_request', 'push', 'schedule', 'workflow_dispatch'] as const)
    .find(value => value === environment.GITHUB_EVENT_NAME);
  if (environment.GITHUB_ACTIONS !== 'true' || environment.GITHUB_REPOSITORY !== 'voyager163/liftoff' || !event) fail('context');
  if (!/^[1-9][0-9]{0,29}$/.test(environment.GITHUB_RUN_ID ?? '') ||
      !/^[1-9][0-9]{0,5}$/.test(environment.GITHUB_RUN_ATTEMPT ?? '')) fail('run-or-attempt');
  const checkout = sha(observed.checkoutSha), eventSha = sha(environment.GITHUB_SHA);
  const selected = environment.LIFTOFF_SCAN_REF ?? '';
  let base = checkout, ref = environment.GITHUB_REF, pullRequestHead: string | null = null;
  if (event === 'schedule') {
    if (!['develop', 'main'].includes(selected) || !observed.selectedRef ||
        observed.selectedRef.ref !== `refs/heads/${selected}` || sha(observed.selectedRef.sha) !== checkout ||
        !['refs/heads/develop', 'refs/heads/main'].includes(ref ?? '')) fail('scheduled-ref');
    ref = observed.selectedRef.ref;
  } else {
    if (selected || observed.selectedRef || checkout !== eventSha) fail('checkout');
    if (event === 'pull_request') {
      if (!/^refs\/pull\/[1-9][0-9]*\/merge$/.test(ref ?? '') ||
          !['develop', 'main'].includes(environment.GITHUB_BASE_REF ?? '')) fail('pull-request-ref');
      base = sha(environment.LIFTOFF_PR_BASE_SHA);
      pullRequestHead = sha(environment.LIFTOFF_PR_HEAD_SHA);
      if (!observed.mergeParents || observed.mergeParents.length !== 2 ||
          observed.mergeParents[0] !== base || observed.mergeParents[1] !== pullRequestHead) fail('merge-ancestry');
    } else if (event === 'push' && !['refs/heads/develop', 'refs/heads/main'].includes(ref ?? '') ||
        event === 'workflow_dispatch' && (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,149}$/.test(ref ?? '') ||
          ref!.includes('..') || ref!.endsWith('/') || ref!.endsWith('.lock'))) fail('protected-or-manual-ref');
  }

  const identity = parseIdentity({
    repository: environment.GITHUB_REPOSITORY, event, sourceSha: checkout, baseSha: base,
    workflowSha: environment.GITHUB_WORKFLOW_SHA, runId: environment.GITHUB_RUN_ID,
    attempt: Number(environment.GITHUB_RUN_ATTEMPT),
    policyDigest: emptyDigest, inventoryDigest: emptyDigest, configurationDigest: emptyDigest
  });
  return {
    repository: identity.repository, event, sourceSha: identity.sourceSha, baseSha: identity.baseSha,
    workflowSha: identity.workflowSha, runId: identity.runId, attempt: identity.attempt,
    ref: ref!, githubEventSha: eventSha, pullRequestHeadSha: pullRequestHead,
    sourceKind: event === 'pull_request' ? 'tested-merge' as const : 'checked-out-ref' as const,
    authentication: 'runner-metadata-and-local-git-not-independent-hosted-readback' as const
  };
}

export interface VerifiedPrExecution { readonly kind: 'verified-pr-execution'; }
const executions = new WeakMap<VerifiedPrExecution, {
  invocation: ReturnType<typeof securityWorkflowInvocation>; tree: string;
  baseRef: 'develop' | 'main';
  workflow: string; jobId: number; jobName: string; appId: 15368;
  jobConclusion: 'success' | 'failure'; observedAt: string;
}>();

/** Fixed GET readback; matching App metadata is not attestation of workflow contents or findings. */
export function verifyPrExecution(
  environment: NodeJS.ProcessEnv,
  observed: { checkoutSha: string; mergeParents: readonly string[]; tree: string },
  expected: { workflow: string; jobId: number; jobName: string },
  now: Date,
  execute: (command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string> = spawnSync
): VerifiedPrExecution {
  const invocation = securityWorkflowInvocation(environment, observed);
  if (invocation.event !== 'pull_request' || invocation.workflowSha !== invocation.sourceSha ||
      !/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(expected.workflow) ||
      !Number.isSafeInteger(expected.jobId) || expected.jobId < 1 ||
      typeof expected.jobName !== 'string' || !expected.jobName || expected.jobName.length > 200 ||
      /[\x00-\x1f\x7f]/.test(expected.jobName) || !Number.isFinite(now.getTime()) ||
      !/^[1-9][0-9]{0,14}$/.test(invocation.runId)) fail('hosted-execution-context');
  const tree = sha(observed.tree);
  const root = '/repos/voyager163/liftoff', pullNumber = invocation.ref.split('/')[2]!;
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('hosted-readback-shape');
    return value as Record<string, unknown>;
  };
  const get = (endpoint: string) => {
    let result: SpawnSyncReturns<string>;
    try {
      result = execute('gh', ['api', '--hostname', 'github.com', '--method', 'GET',
        '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint], {
        shell: false, windowsHide: true, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, GH_DEBUG: '', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', PAGER: 'cat',
          GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1' }
      });
    } catch { return fail('hosted-readback-unavailable'); }
    if (result.error || result.status !== 0 || result.signal !== null ||
        typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 1024 * 1024) fail('hosted-readback-unavailable');
    try { return object(JSON.parse(result.stdout)); } catch { return fail('hosted-readback-shape'); }
  };
  const pull = () => {
    const value = get(`${root}/pulls/${pullNumber}`), base = object(value.base), head = object(value.head);
    if (String(value.number) !== pullNumber || value.state !== 'open' || value.merged !== false ||
        base.ref !== environment.GITHUB_BASE_REF || base.sha !== invocation.baseSha ||
        object(base.repo).full_name !== invocation.repository || head.sha !== invocation.pullRequestHeadSha ||
        value.merge_commit_sha !== invocation.sourceSha) fail('hosted-pr-drift');
  };
  const run = () => {
    const value = get(`${root}/actions/runs/${invocation.runId}`);
    if (String(value.id) !== invocation.runId || value.run_attempt !== invocation.attempt ||
        value.event !== 'pull_request' || value.head_sha !== invocation.pullRequestHeadSha ||
        value.path !== expected.workflow || object(value.repository).full_name !== invocation.repository ||
        !['in_progress', 'completed'].includes(String(value.status)) ||
        value.status === 'completed' && !['success', 'failure'].includes(String(value.conclusion))) fail('hosted-run-drift');
  };
  pull(); run();
  const commit = get(`${root}/git/commits/${invocation.sourceSha}`);
  if (commit.sha !== invocation.sourceSha || object(commit.tree).sha !== tree ||
      !Array.isArray(commit.parents) || commit.parents.length !== 2 ||
      object(commit.parents[0]).sha !== invocation.baseSha || object(commit.parents[1]).sha !== invocation.pullRequestHeadSha) {
    fail('hosted-tested-tree');
  }
  const job = get(`${root}/actions/jobs/${expected.jobId}`);
  if (job.id !== expected.jobId || String(job.run_id) !== invocation.runId || job.run_attempt !== invocation.attempt ||
      job.head_sha !== invocation.pullRequestHeadSha || job.name !== expected.jobName || job.status !== 'completed' ||
      !['success', 'failure'].includes(String(job.conclusion)) || typeof job.check_run_url !== 'string') fail('hosted-job-origin');
  const checkId = /^https:\/\/api\.github\.com\/repos\/voyager163\/liftoff\/check-runs\/([1-9][0-9]{0,14})$/
    .exec(job.check_run_url)?.[1];
  if (!checkId) fail('hosted-job-origin');
  const check = get(`${root}/check-runs/${checkId}`);
  if (String(check.id) !== checkId || check.head_sha !== invocation.pullRequestHeadSha ||
      check.name !== expected.jobName || check.status !== 'completed' || check.conclusion !== job.conclusion ||
      object(check.app).id !== 15368 || object(check.app).slug !== 'github-actions') fail('hosted-check-origin');
  const completed = typeof job.completed_at === 'string' ? Date.parse(job.completed_at) : NaN;
  if (!Number.isFinite(completed) || completed > now.getTime() || now.getTime() - completed > 86_400_000) fail('hosted-job-stale');
  pull(); run();
  const handle: VerifiedPrExecution = Object.freeze({ kind: 'verified-pr-execution' });
  executions.set(handle, {
    invocation: structuredClone(invocation), tree, baseRef: environment.GITHUB_BASE_REF === 'main' ? 'main' : 'develop',
    workflow: expected.workflow, jobId: expected.jobId,
    jobName: expected.jobName, appId: 15368, jobConclusion: job.conclusion === 'success' ? 'success' : 'failure',
    observedAt: now.toISOString()
  });
  return handle;
}

export function verifiedPrExecutionIdentity(handle: VerifiedPrExecution, now: Date) {
  const value = executions.get(handle);
  if (!value) fail('unverified-hosted-execution');
  const age = now.getTime() - Date.parse(value.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > 300_000) fail('hosted-execution-stale');
  return { ...structuredClone(value), originAuthentication: 'current-pr-run-job-check-get-readback' as const,
    workflowContentsAttested: false as const,
    findingPolicyEvaluated: false as const, wholeAdmissionQualified: false as const };
}
