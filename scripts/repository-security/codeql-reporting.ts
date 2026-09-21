import { parseIdentity, record, SecurityEvidenceError } from './evidence.ts';
import { gzipSync } from 'node:zlib';
import { sourceCodeqlReportingPayload, type CodeqlScope } from './codeql.ts';

/** Plans reporting authority only; it never authenticates a workflow or uploads a report. */
export function planCodeqlReporting(value: unknown) {
  const input = record(value, ['identity', 'ref', 'fork', 'dependabot'], 'codeql-reporting-context');
  const identity = parseIdentity(input.identity);
  if (typeof input.fork !== 'boolean' || typeof input.dependabot !== 'boolean' ||
      typeof input.ref !== 'string') {
    throw new SecurityEvidenceError('codeql-reporting-context');
  }
  const pr = identity.event === 'pull_request';
  if (pr ? !/^refs\/pull\/[1-9][0-9]*\/merge$/.test(input.ref)
    : !['push', 'schedule', 'workflow_dispatch'].includes(identity.event) ||
      !['refs/heads/develop', 'refs/heads/main'].includes(input.ref) || input.fork || input.dependabot) {
    throw new SecurityEvidenceError('codeql-reporting-event-boundary');
  }
  return {
    kind: 'source-reporting-plan', identity, ref: input.ref,
    permissions: pr ? { contents: 'read' } : { contents: 'read', 'security-events': 'write' },
    uploadMode: 'unqualified-retain-local-result', capabilityEvidenceRequired: true,
    localAnalysisRequired: true, localFindingEvaluationRequired: true,
    findingStatusChangedByUpload: false, generatedReportsUploaded: false,
    untrustedCheckoutInReportingJob: pr, candidateCodeExecutionInReportingJob: pr,
    privilegedFallback: false, publisherAuthority: false,
    hostedQualification: false
  };
}

export const proposedNativeCodeqlProtection = Object.freeze({
  kind: 'not-an-api-payload', activation: 'disabled-until-capability-and-real-check-qualification',
  analyzer: 'CodeQL', setup: 'advanced', securityFindingThreshold: 'high-or-higher',
  completeAnalysisRequired: true, explicitOutsideDiffFindingEvaluationRequired: true,
  defaultSetupDependabotExempt: true, mergeQueueGroupsExempt: true, diffLocationsRequiredByNativeProtection: true,
  forkAndDependabotQualificationRequired: true, maintenanceCannotBypassNativeRules: true,
  observedRequiredContexts: [], hostedMutationPerformed: false
});

export function prepareSourceCodeqlUpload(
  nativeSarif: string, scope: CodeqlScope, context: { ref: string; fork: boolean; dependabot: boolean }
) {
  if (scope.identity.repository !== 'voyager163/liftoff') throw new SecurityEvidenceError('codeql-reporting-repository');
  const plan = planCodeqlReporting({ identity: scope.identity, ...context });
  const payload = sourceCodeqlReportingPayload(nativeSarif, scope);
  return {
    kind: 'prepared-source-codeql-upload-not-authority', plan,
    request: {
      method: 'POST', url: 'https://api.github.com/repos/voyager163/liftoff/code-scanning/sarifs',
      body: {
        commit_sha: scope.identity.sourceSha, ref: context.ref,
        sarif: gzipSync(Buffer.from(payload.sarif)).toString('base64'),
        tool_name: 'CodeQL', validate: true
      }
    },
    reportingDigest: payload.reportingDigest, sourceReportDigest: payload.sourceReportDigest,
    credentialRequired: 'separately-qualified-native-reporting-context',
    readyForLiveUpload: false, networkPerformed: false, findingVerdictChanged: false
  };
}
