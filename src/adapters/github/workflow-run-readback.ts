import type { ExternalOperationState } from '../../domain/governance/activation/types.js';
import { sourceSha } from '../../governance-activation/github-config.js';
import {
  GitHubActivationError, githubRef, githubRepository, object, positiveId, text, type GitHubActivationClient
} from './activation-rest.js';
import { readbackWorkflowContent } from './workflow-source-readback.js';
import type { WorkflowPublicationPlan } from './production-workflows.js';
import type { RequiredWorkflowCheck } from './workflow-check-recipes.js';

/** Recorded provider identity only: no current run status, conclusion or qualification is implied. */
export interface RecordedWorkflowRunIdentity {
  provider: 'github';
  actionId: string;
  operationId: string;
  resourceId: string;
  startedAt: string;
  observedAt: string;
  planDigest: string;
}

export interface WorkflowRunBinding {
  repository: string;
  repositoryId: number;
  workflowPath: string;
  workflowId: number;
  workflowDigest: string;
  sourceSha: string;
  producerSourceSha?: string;
  ref: string;
  actorId: number;
  event: 'workflow_dispatch' | 'pull_request' | 'push';
  expectedJobs: readonly string[];
  runAttempt: number;
}

export function validateWorkflowRunBinding(binding: WorkflowRunBinding): void {
  githubRepository(binding.repository); githubRef(binding.ref); sourceSha(binding.sourceSha);
  if (binding.producerSourceSha) sourceSha(binding.producerSourceSha);
  positiveId(binding.repositoryId); positiveId(binding.workflowId); positiveId(binding.actorId);
  if (!/^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml$/u.test(binding.workflowPath) ||
    !/^[a-f0-9]{64}$/u.test(binding.workflowDigest) || binding.runAttempt !== 1 ||
    !['workflow_dispatch', 'pull_request', 'push'].includes(binding.event) ||
    !binding.expectedJobs.length || binding.expectedJobs.length > 32 ||
    binding.expectedJobs.some((name) => typeof name !== 'string' || !name || name.length > 200 || /[\u0000-\u001f]/u.test(name)) ||
    new Set(binding.expectedJobs).size !== binding.expectedJobs.length) {
    throw new GitHubActivationError('workflow-binding', 'A bounded workflow operation requires exact immutable source, first attempt, real jobs, actor and repository IDs.');
  }
}

export function sourceCheckFixtureWorkflowBinding(
  publication: WorkflowPublicationPlan, checks: readonly RequiredWorkflowCheck[], workflowId: number
): WorkflowRunBinding {
  const selected = checks.filter((check) => check.workflowId === workflowId);
  const first = selected[0];
  if (!first || selected.some((check) => check.workflowPath !== first.workflowPath ||
    check.workflowDigest !== first.workflowDigest || check.producerSourceSha !== first.producerSourceSha)) {
    throw new GitHubActivationError('fixture-workflow-binding', 'One fixture run must bind one exact immutable workflow producer and complete literal job set.');
  }
  const binding: WorkflowRunBinding = {
    repository: publication.repository, repositoryId: publication.repositoryId, workflowPath: first.workflowPath, workflowId,
    workflowDigest: first.workflowDigest, sourceSha: publication.commitSha, producerSourceSha: first.producerSourceSha,
    ref: publication.featureBranch, actorId: publication.actorId, event: 'pull_request',
    expectedJobs: selected.map((check) => check.context), runAttempt: 1
  };
  validateWorkflowRunBinding(binding);
  return binding;
}

export interface BoundWorkflowJob {
  id: number;
  name: string;
  conclusion: 'success' | 'failure';
  checkRunId: number;
  appId: number;
  appSlug: string;
  steps: readonly { number: number; name: string; status: string; conclusion: string }[];
}

export async function readBoundWorkflowRun(
  client: GitHubActivationClient, binding: WorkflowRunBinding, operation: ExternalOperationState | RecordedWorkflowRunIdentity
) {
  validateWorkflowRunBinding(binding);
  const runId = positiveId(Number(operation.operationId), 'Recorded workflow run ID');
  if (operation.provider !== 'github' || operation.resourceId !== `/repos/${binding.repository}/actions/runs/${runId}`) {
    throw new GitHubActivationError('workflow-run-binding', 'The provider-issued operation belongs to another exact workflow repository.');
  }
  const [run, current] = await Promise.all([
    client.get(`${operation.resourceId}/attempts/${binding.runAttempt}`), client.get(operation.resourceId)
  ]);
  if (current.id !== runId || current.run_attempt !== binding.runAttempt ||
    object(current.actor).id !== binding.actorId || object(current.triggering_actor).id !== binding.actorId) {
    throw new GitHubActivationError('workflow-attempt-drift', 'Actual run attempt or triggering actor changed; an earlier attempt cannot supply current check or artifact proof.');
  }
  if (run.id !== runId || object(run.repository).id !== binding.repositoryId ||
    object(run.repository).full_name !== binding.repository || run.head_sha !== binding.sourceSha ||
    run.workflow_id !== binding.workflowId || run.path !== binding.workflowPath || run.event !== binding.event ||
    run.head_branch !== binding.ref || object(run.actor).id !== binding.actorId || run.run_attempt !== binding.runAttempt ||
    run.status !== 'completed' || !['success', 'failure'].includes(String(run.conclusion))) {
    throw new GitHubActivationError('workflow-run-binding', 'Actual run, attempt, source, actor or final result does not match the independently bound operation.');
  }
  const source = await readbackWorkflowContent(client, binding.repository, binding.workflowPath, binding.sourceSha);
  if (source.digest !== binding.workflowDigest) throw new GitHubActivationError('workflow-source-binding', 'Actual workflow source differs from the reviewed bytes.');
  if (binding.producerSourceSha && binding.producerSourceSha !== binding.sourceSha) {
    const producer = await readbackWorkflowContent(client, binding.repository, binding.workflowPath, binding.producerSourceSha);
    if (producer.digest !== source.digest) throw new GitHubActivationError('workflow-producer-binding', 'Workflow producer and execution sources differ.');
  }
  const raw = await client.list(`${operation.resourceId}/attempts/${binding.runAttempt}/jobs`, 'jobs');
  const jobs: BoundWorkflowJob[] = [];
  for (const name of binding.expectedJobs) {
    const matches = raw.filter((job) => job.name === name);
    const job = matches[0];
    if (matches.length !== 1 || !job || job.run_id !== runId || job.head_sha !== binding.sourceSha ||
      job.status !== 'completed' || !['success', 'failure'].includes(String(job.conclusion)) ||
      !Array.isArray(job.steps) || !job.steps.length || job.steps.length > 100) {
      throw new GitHubActivationError('workflow-job-binding', 'Required job identity, step observation or terminal non-skipped result is absent.');
    }
    const prefix = `https://api.github.com/repos/${binding.repository}/check-runs/`;
    if (typeof job.check_run_url !== 'string' || !job.check_run_url.startsWith(prefix) ||
      !/^[1-9]\d*$/u.test(job.check_run_url.slice(prefix.length))) {
      throw new GitHubActivationError('workflow-check-binding', 'The job has no exact provider check-run identity in this repository.');
    }
    const checkRunId = positiveId(Number(job.check_run_url.slice(prefix.length)));
    const check = await client.get(`/repos/${binding.repository}/check-runs/${checkRunId}`);
    const app = object(check.app);
    if (check.id !== checkRunId || check.name !== name || check.head_sha !== binding.sourceSha ||
      check.status !== 'completed' || check.conclusion !== job.conclusion ||
      object(check.check_suite).id !== positiveId(run.check_suite_id) ||
      app.slug !== 'github-actions' ||
      /runner lost communication|infrastructure error|runner.*(?:offline|unavailable)|job was not acquired/iu.test(JSON.stringify(check.output ?? {}))) {
      throw new GitHubActivationError('workflow-check-binding', 'The actual check is synthetic, unrelated, incomplete or an infrastructure failure; it cannot qualify the required workflow job.');
    }
    if (check.conclusion === 'failure' &&
      /ERR_MODULE_NOT_FOUND|Cannot find module|ModuleNotFoundError|ImportError|error collecting|build failed|compilation failed/iu.test(JSON.stringify(check.output ?? {}))) {
      throw new GitHubActivationError('workflow-check-execution', 'Dependency, collection or build failures cannot provide source-bound controlled assertion execution.');
    }
    const steps = job.steps.map((value) => {
      const step = object(value);
      return { number: positiveId(step.number, 'Workflow step number'), name: text(step.name, 'Workflow step name'),
        status: text(step.status, 'Workflow step status'), conclusion: text(step.conclusion, 'Workflow step conclusion') };
    });
    if (new Set(steps.map((step) => step.number)).size !== steps.length ||
      run.conclusion === 'success' && job.conclusion !== 'success') {
      throw new GitHubActivationError('workflow-job-binding', 'Workflow step identities or required successful job results conflict.');
    }
    jobs.push({ id: positiveId(job.id), name, conclusion: job.conclusion as 'success' | 'failure',
      checkRunId, appId: positiveId(app.id), appSlug: 'github-actions', steps });
  }
  return { runId, runAttempt: binding.runAttempt, headSha: binding.sourceSha, workflowId: binding.workflowId,
    conclusion: String(run.conclusion), jobs, providerRun: run };
}

/** Reads only an already recorded exact provider operation; it never dispatches or adopts a latest run. */
export async function observeOrPollWorkflowRun(input: {
  client: GitHubActivationClient;
  repository: string;
  workflowFileName: string;
  expectedHeadSha?: string;
  expectedEvent?: string;
  expectedRef?: string;
  expectedActorId?: number;
  expectedWorkflowId?: number;
  expectedWorkflowDigest?: string;
  expectedJobs?: readonly string[];
  expectedRunAttempt?: number;
  pendingOperation?: ExternalOperationState;
  maxAttempts?: number;
  pollDelayMs?: number;
  now?: Date;
}): Promise<{
  runId: number;
  status: string;
  conclusion: string;
  headSha: string;
  workflowId: number;
  jobs: readonly { id: number; name: string; conclusion: string }[];
}> {
  const repo = githubRepository(input.repository);
  const maxAttempts = input.maxAttempts ?? 1;
  const runAttempt = input.expectedRunAttempt ?? 1;
  const expectedPath = input.workflowFileName.startsWith('.github/workflows/')
    ? input.workflowFileName : `.github/workflows/${input.workflowFileName}`;
  if (!input.pendingOperation || input.pendingOperation.provider !== 'github' ||
    !/^[1-9]\d*$/u.test(input.pendingOperation.operationId) ||
    !input.expectedHeadSha || !input.expectedEvent || !input.expectedRef ||
    !Number.isSafeInteger(input.expectedActorId) || Number(input.expectedActorId) < 1 ||
    !Number.isSafeInteger(input.expectedWorkflowId) || Number(input.expectedWorkflowId) < 1 ||
    !/^[a-f0-9]{64}$/u.test(input.expectedWorkflowDigest ?? '') ||
    !input.expectedJobs?.length || input.expectedJobs.length > 32 ||
    new Set(input.expectedJobs).size !== input.expectedJobs.length ||
    !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5 ||
    !Number.isSafeInteger(runAttempt) || runAttempt < 1 ||
    !Number.isSafeInteger(input.pollDelayMs ?? 0) || (input.pollDelayMs ?? 0) < 0 || (input.pollDelayMs ?? 0) > 5000) {
    throw new GitHubActivationError('workflow-run-binding-required',
      'A provider-issued run ID and exact source/ref/actor/workflow/jobs are required. Dispatch and full recovery remain unavailable; the latest unrelated run is never substituted.');
  }
  const runId = positiveId(Number(input.pendingOperation.operationId), 'Workflow operation ID');
  const expectedSha = sourceSha(input.expectedHeadSha);
  if (input.pendingOperation.resourceId !== `/repos/${repo}/actions/runs/${runId}` ||
    !/^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml$/u.test(expectedPath)) {
    throw new GitHubActivationError('workflow-run-binding', 'The recorded operation or workflow path belongs to another reviewed target.');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const run = await input.client.get(`/repos/${repo}/actions/runs/${runId}/attempts/${runAttempt}`);
    if (run.id !== runId || run.head_sha !== expectedSha || run.event !== input.expectedEvent ||
      run.head_branch !== input.expectedRef || run.workflow_id !== input.expectedWorkflowId ||
      object(run.actor).id !== input.expectedActorId || run.path !== expectedPath || run.run_attempt !== runAttempt ||
      object(run.repository).full_name !== repo) {
      throw new GitHubActivationError('workflow-run-binding', 'Actual workflow run/attempt, actor, source or ref differs from the reviewed operation.');
    }
    {
      const status = text(run.status, 'Workflow run status');
      const conclusion = run.conclusion !== null ? text(run.conclusion, 'Workflow run conclusion') : null;

      if (status === 'completed' && conclusion !== null) {
        const source = await readbackWorkflowContent(input.client, repo, expectedPath, expectedSha);
        if (source.digest !== input.expectedWorkflowDigest) {
          throw new GitHubActivationError('workflow-source-binding', 'The actual workflow bytes differ from the reviewed source.');
        }
        const rawJobs = await input.client.list(`/repos/${repo}/actions/runs/${runId}/attempts/${runAttempt}/jobs`, 'jobs');
        const jobs = input.expectedJobs.map((name) => {
          const matching = rawJobs.filter((job) => job.name === name);
          const j = matching[0];
          if (matching.length !== 1 || !j || j.run_id !== runId || j.head_sha !== expectedSha ||
            j.status !== 'completed' || !['success', 'failure'].includes(String(j.conclusion)) ||
            conclusion === 'success' && j.conclusion !== 'success') {
            throw new GitHubActivationError('workflow-job-binding', 'Required job identity or result is absent, skipped, stale or belongs to another run.');
          }
          return {
            id: positiveId(j.id, 'Job ID'),
            name: text(j.name, 'Job name'),
            conclusion: text(j.conclusion, 'Job conclusion')
          };
        });
        if (conclusion === 'failure' && jobs.every((job) => job.conclusion !== 'failure')) {
          throw new GitHubActivationError('workflow-job-binding', 'An unrelated infrastructure failure is not failure of a required validation job.');
        }

        return {
          runId,
          status,
          conclusion,
          headSha: sourceSha(run.head_sha),
          workflowId: positiveId(run.workflow_id, 'Workflow ID'),
          jobs
        };
      }
    }

    if (attempt < maxAttempts && input.pollDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, input.pollDelayMs));
    }
  }

  throw new GitHubActivationError(
    'workflow-run-not-settled',
    `Workflow run for '${input.workflowFileName}' did not complete within the bounded observation window.`
  );
}
