import { canonicalDigest } from './admission.ts';
import { digest, parseIdentity, SecurityEvidenceError } from './evidence.ts';
import { securityWorkflowInvocation } from './workflow-invocation.ts';

export function packedAssessmentContext(
  source: { commit: string; dirty: boolean }, inventoryDigest: string,
  environment: NodeJS.ProcessEnv, now: Date
) {
  if (!Number.isSafeInteger(now.getTime()) || now.getTime() <= 0 || typeof source.dirty !== 'boolean') {
    throw new SecurityEvidenceError('packed-assessment-context-time-or-source');
  }
  const hosted = environment.GITHUB_ACTIONS === 'true';
  if (environment.GITHUB_ACTIONS !== undefined && !hosted ||
      !hosted && ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_EVENT_NAME', 'GITHUB_WORKFLOW_SHA']
        .some(name => environment[name] !== undefined)) {
    throw new SecurityEvidenceError('packed-assessment-incomplete-runner-context');
  }
  const invocation = hosted ? securityWorkflowInvocation(environment, { checkoutSha: source.commit }) : null;
  if (invocation && (invocation.event !== 'workflow_dispatch' || source.dirty ||
      !['true', 'false'].includes(environment.LIFTOFF_RELEASE_DRY_RUN ?? '') ||
      environment.LIFTOFF_RELEASE_DRY_RUN === 'false' && invocation.ref !== 'refs/heads/main')) {
    throw new SecurityEvidenceError('packed-assessment-release-source-context');
  }
  return {
    identity: parseIdentity({
      repository: 'voyager163/liftoff', event: invocation?.event ?? 'workflow_dispatch',
      sourceSha: source.commit, baseSha: invocation?.baseSha ?? source.commit,
      workflowSha: invocation?.workflowSha ?? source.commit,
      runId: invocation?.runId ?? String(now.getTime()), attempt: invocation?.attempt ?? 1,
      policyDigest: canonicalDigest('strict-local-no-exceptions-not-adopted-release-policy'),
      inventoryDigest: digest(inventoryDigest),
      configurationDigest: canonicalDigest('exact-packed-python-go-native-coordinate-only-assessment')
    }),
    invocation,
    provenance: invocation ? 'actual-runner-metadata-not-independent-producer-authentication' : 'local-observation-not-hosted-run',
    adoptedPolicyAuthority: false, independentlyAuthenticated: false, publicationQualified: false
  };
}
