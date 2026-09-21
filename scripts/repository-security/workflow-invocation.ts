import { parseIdentity, sha, SecurityEvidenceError } from './evidence.ts';

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
