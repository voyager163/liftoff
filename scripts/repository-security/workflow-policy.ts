import { SecurityEvidenceError } from './evidence.ts';

interface WorkflowPolicy {
  actions: readonly { repository: string; commit: string }[];
  publisherJob?: string;
  publicationJobs?: readonly string[];
  readbackJob?: string;
  reportingJobs?: { pullRequest: string; protectedRef: string };
}

const PUBLICATION_CONDITION = "${{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.dry_run == false && needs.qualification.outputs.publication-authorized == 'true' }}";
export const CODEQL_PR_REPORT_CONDITION = "${{ always() && github.event_name == 'pull_request' && vars.CODEQL_PRODUCER_EXECUTION_ENABLED == 'true' && needs.producer.outputs.artifact-id != '' }}";
export const CODEQL_PROTECTED_REPORT_CONDITION = "${{ always() && github.event_name != 'pull_request' && (github.ref == 'refs/heads/develop' || github.ref == 'refs/heads/main') && vars.CODEQL_PRODUCER_EXECUTION_ENABLED == 'true' && vars.CODEQL_REPORTING_UPLOAD_ENABLED == 'true' && needs.producer.outputs.artifact-id != '' }}";

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SecurityEvidenceError('invalid-workflow-object');
  return value as Record<string, unknown>;
}

function readonlyPermissions(value: unknown, publisher: boolean, sourceReporter = false, readback = false): void {
  const permissions = object(value);
  const expected = publisher ? { contents: 'read', 'id-token': 'write' }
    : sourceReporter ? { contents: 'read', 'security-events': 'write' }
      : readback ? { contents: 'read', actions: 'read' } : { contents: 'read' };
  if (Object.keys(permissions).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, value]) => permissions[key] !== value)) {
    throw new SecurityEvidenceError('excess-workflow-permissions');
  }
}

function usesSecretContext(value: unknown): boolean {
  if (typeof value === 'string') {
    let offset = 0;
    while ((offset = value.indexOf('${{', offset)) !== -1) {
      let quoted = false, expression = '', closed = false;
      for (offset += 3; offset < value.length; offset++) {
        if (value[offset] === "'") {
          if (quoted && value[offset + 1] === "'") { offset++; continue; }
          quoted = !quoted;
          expression += ' ';
        } else if (!quoted && value.slice(offset, offset + 2) === '}}') {
          offset += 2;
          closed = true;
          break;
        } else if (!quoted) {
          expression += value[offset];
        }
      }
      if (!closed) throw new SecurityEvidenceError('invalid-workflow-expression');
      if (/(?:^|[^\w.])secrets\b/i.test(expression.replace(/\s*\.\s*/g, '.'))) return true;
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(usesSecretContext);
  if (value !== null && typeof value === 'object') return Object.values(value).some(usesSecretContext);
  return false;
}

export function verifyWorkflowBoundaries(value: unknown, policy: WorkflowPolicy): void {
  const workflow = object(value);
  readonlyPermissions(workflow.permissions, false);
  const events = object(workflow.on);
  if (Object.keys(events).length === 0 || Object.keys(events).some(event => !['pull_request', 'push', 'workflow_dispatch', 'schedule'].includes(event))) {
    throw new SecurityEvidenceError('unapproved-workflow-event');
  }
  if (policy.publisherJob && (events.pull_request !== undefined || 'pull_request' in events || 'schedule' in events)) {
    throw new SecurityEvidenceError('untrusted-publisher-event');
  }
  if (usesSecretContext(workflow)) throw new SecurityEvidenceError('untrusted-secret-access');
  if (policy.publicationJobs?.length) {
    if (!policy.publisherJob || !policy.publicationJobs.includes(policy.publisherJob) ||
        Object.keys(events).length !== 1 || !('workflow_dispatch' in events)) {
      throw new SecurityEvidenceError('untrusted-publisher-event');
    }
    const input = object(object(object(events.workflow_dispatch).inputs).dry_run);
    if (input.type !== 'boolean' || input.default !== true || input.required !== true) {
      throw new SecurityEvidenceError('unsafe-publication-default');
    }
  }
  const concurrency = object(workflow.concurrency);
  if (typeof concurrency.group !== 'string' || concurrency.group.length === 0 ||
      concurrency['cancel-in-progress'] !== !policy.publisherJob) throw new SecurityEvidenceError('invalid-workflow-concurrency');
  const jobs = object(workflow.jobs);
  if (Object.keys(jobs).length === 0 || policy.publisherJob && !(policy.publisherJob in jobs)) {
    throw new SecurityEvidenceError('missing-workflow-job');
  }
  if (policy.reportingJobs && (policy.publisherJob ||
      policy.reportingJobs.pullRequest === policy.reportingJobs.protectedRef ||
      ![policy.reportingJobs.pullRequest, policy.reportingJobs.protectedRef].every(name => name in jobs))) {
    throw new SecurityEvidenceError('invalid-reporting-job-registration');
  }
  if (policy.readbackJob && (!policy.publicationJobs?.length || !(policy.readbackJob in jobs) ||
      policy.publicationJobs.includes(policy.readbackJob))) throw new SecurityEvidenceError('invalid-readback-job-registration');
  for (const [jobId, value] of Object.entries(jobs)) {
    const job = object(value);
    const publisher = jobId === policy.publisherJob;
    const publication = policy.publicationJobs?.includes(jobId) ?? false;
    const prReporter = policy.reportingJobs?.pullRequest === jobId;
    const protectedReporter = policy.reportingJobs?.protectedRef === jobId;
    const reporter = prReporter || protectedReporter;
    const readback = policy.readbackJob === jobId;
    if (job.permissions !== undefined) readonlyPermissions(job.permissions, publisher, protectedReporter, readback);
    else if (publisher || reporter || readback) throw new SecurityEvidenceError('missing-publisher-permissions');
    if (readback && (job.environment !== undefined || job.needs !== 'validate')) throw new SecurityEvidenceError('unbound-readback-job');
    if (reporter && (job.if !== (prReporter ? CODEQL_PR_REPORT_CONDITION : CODEQL_PROTECTED_REPORT_CONDITION) ||
        job.needs !== 'producer' || job.environment !== undefined)) throw new SecurityEvidenceError('unbound-source-reporting-job');
    if (job.environment !== undefined && (!publication || job.environment !== 'npm-publisher')) {
      throw new SecurityEvidenceError('unqualified-publisher-environment');
    }
    if (publication && (job.environment !== 'npm-publisher' || job.if !== PUBLICATION_CONDITION ||
        !Array.isArray(job.needs) || !job.needs.includes('qualification'))) {
      throw new SecurityEvidenceError('unbound-publication-job');
    }
    if (job['continue-on-error'] !== undefined && job['continue-on-error'] !== false) {
      throw new SecurityEvidenceError('ignored-workflow-failure');
    }
    if (typeof job['timeout-minutes'] !== 'number' || !Number.isSafeInteger(job['timeout-minutes']) ||
        job['timeout-minutes'] <= 0 || job['timeout-minutes'] > 60) throw new SecurityEvidenceError('unbounded-workflow-job');
    if (!['ubuntu-latest', 'macos-latest', 'windows-latest'].includes(String(job['runs-on']))) {
      if (job['runs-on'] !== '${{ matrix.os }}') throw new SecurityEvidenceError('unapproved-runner');
      const os = object(object(job.strategy).matrix).os;
      if (!Array.isArray(os) || os.length === 0 ||
          os.some(value => !['ubuntu-latest', 'macos-latest', 'windows-latest'].includes(value))) {
        throw new SecurityEvidenceError('unapproved-runner-matrix');
      }
    }
    if (!Array.isArray(job.steps) || job.steps.length === 0) throw new SecurityEvidenceError('missing-workflow-steps');
    for (const value of job.steps) {
      const step = object(value);
      if (step['continue-on-error'] !== undefined && step['continue-on-error'] !== false) {
        throw new SecurityEvidenceError('ignored-workflow-failure');
      }
      if (publication && step.run !== undefined &&
          step.run !== `node scripts/release-coordinator.mjs ${publisher ? 'npm' : jobId}`) {
        throw new SecurityEvidenceError('privileged-candidate-execution');
      }
      if (reporter && step.run !== undefined && step.run !== 'node scripts/report-codeql-source.mjs') {
        throw new SecurityEvidenceError('reporter-candidate-execution');
      }
      if (step.uses === undefined) continue;
      if (typeof step.uses !== 'string' ||
          !policy.actions.some(action => step.uses === `${action.repository}@${action.commit}` &&
            /^[a-f0-9]{40}$/.test(action.commit))) throw new SecurityEvidenceError('unapproved-action-reference');
      if (step.uses.startsWith('actions/checkout@') && object(step.with)['persist-credentials'] !== false) {
        throw new SecurityEvidenceError('persisted-checkout-credentials');
      }
      if (publication && step.uses.startsWith('actions/checkout@') && object(step.with).ref !== '${{ github.sha }}') {
        throw new SecurityEvidenceError('unbound-publisher-checkout');
      }
      if (reporter && step.uses.startsWith('actions/checkout@') && object(step.with).ref !== '${{ github.sha }}') {
        throw new SecurityEvidenceError('untrusted-reporting-checkout');
      }
      const actionReference = step.uses;
      if (reporter && !['actions/checkout@', 'actions/setup-node@', 'actions/download-artifact@'].some(prefix => actionReference.startsWith(prefix))) {
        throw new SecurityEvidenceError('unapproved-reporting-action');
      }
      if (step.uses.startsWith('actions/setup-node@') &&
          (object(step.with).cache !== undefined || object(step.with)['package-manager-cache'] !== false)) {
        throw new SecurityEvidenceError('workflow-cache-not-isolated');
      }
      if (step.uses.startsWith('actions/setup-go@') && object(step.with).cache !== false ||
          step.uses.startsWith('actions/setup-python@') && object(step.with).cache !== undefined) {
        throw new SecurityEvidenceError('workflow-cache-not-isolated');
      }
      if (step.uses.startsWith('actions/download-artifact@')) {
        const inputs = object(step.with);
        const producer = typeof inputs['artifact-ids'] === 'string'
          ? /^\$\{\{ needs\.([a-z][a-z-]*)\.outputs\.artifact-id }}$/.exec(inputs['artifact-ids'])?.[1] : undefined;
        const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
        if (!producer || !needs.includes(producer) || !(producer in jobs) ||
            ['name', 'pattern', 'github-token', 'repository', 'run-id'].some(key => key in inputs) ||
            typeof inputs.path !== 'string' || !/^\$\{\{ runner\.temp }}\/[a-z][a-z-]*$/.test(inputs.path)) {
          throw new SecurityEvidenceError('unbound-workflow-artifact');
        }
      }
      if (step.uses.startsWith('actions/upload-artifact@')) {
        const inputs = object(step.with);
        if (inputs.overwrite !== false || inputs['if-no-files-found'] !== 'error' ||
            !Number.isInteger(inputs['retention-days']) || Number(inputs['retention-days']) < 1 ||
            Number(inputs['retention-days']) > 7 || typeof inputs.name !== 'string' ||
            !inputs.name.endsWith('${{ github.run_id }}-${{ github.run_attempt }}')) {
          throw new SecurityEvidenceError('unbound-workflow-artifact');
        }
      }
    }
  }
}
