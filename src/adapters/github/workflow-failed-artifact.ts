import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import { clientFor } from '../../governance-activation/github-config.js';
import { assertGitHubPhaseAuthority } from '../../application/repository-governance/workflow-authority.js';
import {
  admitFailedWorkflowArtifactOrigin, type FailedWorkflowArtifactRequest, type WorkflowRunOriginReference
} from '../../application/repository-governance/workflow-run-origin.js';
import { GitHubActivationClient, GitHubActivationError, object, positiveId, text } from './activation-rest.js';
import { readWorkflowArtifactBytes, type WorkflowArtifactReadback } from './workflow-artifact-readback.js';
import { readBoundWorkflowRun, type BoundWorkflowJob } from './workflow-run-readback.js';
import { readbackWorkflowContent } from './workflow-source-readback.js';
import { decodeWorkflow } from './workflow-check-recipes.js';

export type { FailedWorkflowArtifactRequest, WorkflowRunOriginReference } from '../../application/repository-governance/workflow-run-origin.js';

export interface FailedWorkflowArtifactReadback extends WorkflowArtifactReadback {
  conclusion: 'failure';
  runAttempt: 1;
  origin: WorkflowRunOriginReference;
  checkpointDigest: string;
  job: BoundWorkflowJob & { startedAt: string; completedAt: string };
  reportPath: string;
}

export class FailedWorkflowArtifactPendingError extends GitHubActivationError {
  readonly request: FailedWorkflowArtifactRequest;
  constructor(request: FailedWorkflowArtifactRequest) {
    super('failed-artifact-pending',
      'The exact recorded failed-run artifact is not visible yet. Preserve its provider ID and original custody; retry only bounded readback, never dispatch or substitute another artifact.', 404);
    this.request = structuredClone(request);
  }
}

function fail(message: string): never {
  throw new GitHubActivationError('failed-artifact-binding', message);
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('The actual failed run/job observation has a missing or malformed timestamp.');
  return Date.parse(value);
}

export function resolveWorkflowArtifactName(
  value: unknown, dispatchInputs: Readonly<Record<string, unknown>>, correlationId: string, runId: number, runAttempt: number
): string {
  const template = text(value, 'Immutable artifact name');
  const name = template.replace(/\$\{\{\s*(inputs\.[A-Za-z_][A-Za-z0-9_-]*|github\.run_id|github\.run_attempt)\s*\}\}/gu, (_match, key: string) => {
    const replacement = key === 'github.run_id' ? String(runId) : key === 'github.run_attempt' ? String(runAttempt) :
      key === 'inputs.liftoff_operation_id' ? correlationId : dispatchInputs[key.slice('inputs.'.length)];
    if (typeof replacement !== 'string') fail('An immutable artifact name references an input absent from the original private-bound dispatch.');
    return replacement;
  });
  if (!name || name.length > 200 || name.includes('${{') || /[\u0000-\u001f\u007f]/u.test(name)) {
    fail('Artifact names permit only literal bytes and exact recorded dispatch/run substitutions, never dynamic or latest selection.');
  }
  return name;
}

function artifactSource(
  content: string, request: FailedWorkflowArtifactRequest, dispatchInputs: Readonly<Record<string, unknown>>, correlationId: string
): string {
  const document = decodeWorkflow(content);
  const jobs = object(document.jobs);
  const selected = object(jobs[request.job.jobKey]);
  if (Object.keys(jobs).length > 32 || (selected.name ?? request.job.jobKey) !== request.job.name ||
    selected.strategy !== undefined || selected.uses !== undefined ||
    selected['continue-on-error'] !== undefined && selected['continue-on-error'] !== false ||
    !Array.isArray(selected.steps) || !selected.steps.length || selected.steps.length > 100) {
    fail('Failed-artifact production requires the exact literal non-matrix source job and steps.');
  }
  const steps = selected.steps.map((step) => object(step));
  const validation = steps.filter((step) => step.name === request.job.validationStep);
  const uploads = steps.filter((step) => step.name === request.job.uploadStep);
  const upload = uploads[0];
  if (validation.length !== 1 || !validation[0] || typeof validation[0].run !== 'string' || !validation[0].run ||
    validation[0].uses !== undefined || validation[0].if !== undefined ||
    validation[0]['continue-on-error'] !== undefined && validation[0]['continue-on-error'] !== false ||
    uploads.length !== 1 || !upload || typeof upload.uses !== 'string' ||
    !/^actions\/upload-artifact@[a-f0-9]{40}$/u.test(upload.uses) ||
    !['always()', 'failure()', '${{ always() }}', '${{ failure() }}'].includes(String(upload.if)) ||
    upload.run !== undefined || upload['continue-on-error'] !== undefined ||
    steps.indexOf(upload) <= steps.indexOf(validation[0])) {
    fail('The immutable workflow must run the actual validator and then its exact pinned failure-capable artifact upload; skipped/setup actions are not negative proof.');
  }
  const options = object(upload.with);
  const path = text(options.path, 'Exact failed-report source path');
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/u.test(path) ||
    path.split('/').some((part) => !part || part.startsWith('.')) ||
    options['if-no-files-found'] !== 'error' || options.overwrite !== undefined && options.overwrite !== false ||
    options['include-hidden-files'] !== undefined && options['include-hidden-files'] !== false ||
    resolveWorkflowArtifactName(options.name, dispatchInputs, correlationId, Number(request.operation.operationId), 1) !== request.artifact.name) {
    fail('The artifact upload source must name this exact immutable artifact and one explicit non-hidden report path without overwrite or missing-file success.');
  }
  let matches = 0;
  for (const raw of Object.values(jobs)) {
    const job = object(raw);
    if (!Array.isArray(job.steps) || job.steps.length > 100) fail('All source upload producers must have a bounded explicit step inventory.');
    for (const rawStep of job.steps) {
      const step = object(rawStep);
      if (typeof step.uses !== 'string' || !step.uses.startsWith('actions/upload-artifact@')) continue;
      if (resolveWorkflowArtifactName(object(step.with).name, dispatchInputs, correlationId, Number(request.operation.operationId), 1) === request.artifact.name) matches++;
    }
  }
  if (matches !== 1) fail('Another workflow job can produce the same artifact name; run-level metadata cannot establish the selected job.');
  return path;
}

/**
 * A different reader phase must approve the exact request in operation.inputs.failedWorkflowArtifacts.
 * Original private issuance is evaluated at the original prepared time, under the current reader's actual lease.
 * Returns failure and opaque bytes only; report/assertion classification and full-phase proof remain independent.
 */
export async function readBoundFailedWorkflowArtifact(input: {
  execution: PhaseAdapterExecutionInput;
  operation: TransitionOperation;
  request: FailedWorkflowArtifactRequest;
}): Promise<FailedWorkflowArtifactReadback> {
  const request = structuredClone(input.request);
  const reader = structuredClone(input.operation);
  const original = await admitFailedWorkflowArtifactOrigin(input.execution, reader, request);
  const transport = clientFor(input.execution).transport;
  const client = new GitHubActivationClient({ async request(read) {
    if (read.method !== 'GET' || read.path !== '/user' && !read.path.startsWith(`/repos/${request.binding.repository}/`) &&
      read.path !== `/repos/${request.binding.repository}`) fail('Failed qualification consumption is bounded same-repository GitHub readback only.');
    await assertGitHubPhaseAuthority(input.execution, reader);
    return transport.request(read);
  } });
  const { binding } = request;
  const [repository, actor, ref, workflow] = await Promise.all([
    client.get(`/repos/${binding.repository}`), client.get('/user'),
    client.get(`/repos/${binding.repository}/git/ref/heads/${binding.ref}`),
    client.get(`/repos/${binding.repository}/actions/workflows/${binding.workflowId}`)
  ]);
  if (repository.id !== binding.repositoryId || repository.full_name !== binding.repository ||
    repository.archived !== false || repository.disabled !== false || actor.id !== binding.actorId ||
    ref.ref !== `refs/heads/${binding.ref}` || object(ref.object).type !== 'commit' || object(ref.object).sha !== binding.sourceSha ||
    workflow.id !== binding.workflowId || workflow.path !== binding.workflowPath || workflow.state !== 'active') {
    fail('Current repository, actor, exact source ref or active workflow registration differs from the original failed qualification.');
  }
  const run = await readBoundWorkflowRun(client, binding, request.operation);
  const job = run.jobs.find((entry) => entry.name === request.job.name);
  if (run.conclusion !== 'failure' || !job || job.conclusion !== 'failure' || job.id !== request.job.jobId ||
    job.checkRunId !== request.job.checkRunId || job.appId !== request.job.appId) {
    fail('Only the original actual failed run and exact failed job/check/App can supply this archive; successful or unrelated jobs are not substituted.');
  }
  const validation = job.steps.filter((step) => step.name === request.job.validationStep);
  const upload = job.steps.filter((step) => step.name === request.job.uploadStep);
  if (validation.length !== 1 || validation[0]!.status !== 'completed' || validation[0]!.conclusion !== 'failure' ||
    upload.length !== 1 || upload[0]!.status !== 'completed' || upload[0]!.conclusion !== 'success' ||
    upload[0]!.number <= validation[0]!.number ||
    job.steps.some((step) => step.number < validation[0]!.number && (step.status !== 'completed' || step.conclusion !== 'success') ||
      step.number !== validation[0]!.number && !['success', 'skipped'].includes(step.conclusion))) {
    fail('The exact validator must fail after successful setup and its independent upload must succeed; infrastructure, missing or skipped validation/upload is not admitted.');
  }
  const rawJob = await client.get(`/repos/${binding.repository}/actions/jobs/${job.id}`);
  const observedSteps = Array.isArray(rawJob.steps) ? rawJob.steps.map((value) => {
    const step = object(value);
    return { number: positiveId(step.number), name: text(step.name, 'Actual step name'),
      status: text(step.status, 'Actual step status'), conclusion: text(step.conclusion, 'Actual step conclusion') };
  }) : [];
  const createdAt = timestamp(run.providerRun.created_at), startedAt = timestamp(rawJob.started_at), completedAt = timestamp(rawJob.completed_at);
  if (rawJob.id !== job.id || rawJob.run_id !== run.runId || rawJob.run_attempt !== 1 || rawJob.head_sha !== binding.sourceSha ||
    rawJob.name !== job.name || rawJob.status !== 'completed' || rawJob.conclusion !== 'failure' ||
    rawJob.check_run_url !== `https://api.github.com/repos/${binding.repository}/check-runs/${job.checkRunId}` ||
    canonicalSha256(observedSteps) !== canonicalSha256(job.steps) ||
    createdAt < Math.max(original.notBefore, timestamp(original.checkpoints.prepared.preparedAt)) ||
    startedAt < createdAt || completedAt < startedAt || completedAt >= original.expiresAt ||
    completedAt > (input.execution.clock?.() ?? input.execution.now).getTime() ||
    timestamp(run.providerRun.updated_at) < completedAt ||
    timestamp(run.providerRun.updated_at) > (input.execution.clock?.() ?? input.execution.now).getTime()) {
    fail('The independently read failed job, steps or actual execution interval differs from its original private-bound run/approval.');
  }
  if (request.origin.kind === 'workflow-dispatch') {
    if (run.providerRun.display_title !== `liftoff-${original.checkpoints.prepared.correlationId}` ||
      createdAt > timestamp(original.checkpoints.prepared.preparedAt) + 5 * 60_000) {
      fail('The failed dispatch does not retain its exact original correlation and bounded run-creation window.');
    }
  } else {
    const publication = original.publication!;
    const pr = await client.get(`/repos/${binding.repository}/pulls/${request.origin.pullRequestNumber}`);
    const head = object(pr.head), base = object(pr.base);
    if (pr.number !== request.origin.pullRequestNumber || pr.state !== 'open' || pr.merged !== false ||
      object(pr.user).id !== binding.actorId || head.sha !== binding.sourceSha || head.ref !== binding.ref ||
      object(head.repo).id !== binding.repositoryId || object(head.repo).full_name !== binding.repository ||
      base.sha !== publication.baseSha || base.ref !== publication.targetBranch ||
      object(base.repo).id !== binding.repositoryId || object(base.repo).full_name !== binding.repository ||
      !Array.isArray(run.providerRun.pull_requests) || !run.providerRun.pull_requests.some((value) => {
        const entry = object(value);
        return entry.number === pr.number && object(entry.head).sha === head.sha && object(entry.base).sha === base.sha;
      })) fail('The failed artifact run no longer belongs to its exact original actor-owned unmerged fixture PR.');
  }
  const source = await readbackWorkflowContent(client, binding.repository, binding.workflowPath, binding.sourceSha);
  if (source.digest !== binding.workflowDigest) fail('The immutable source changed between failed-run and artifact-source readback.');
  const reportPath = artifactSource(source.content, request,
    original.publication ? {} : object(original.operation.inputs.dispatchInputs), original.checkpoints.prepared.correlationId);
  await assertGitHubPhaseAuthority(input.execution, reader);
  let artifact: WorkflowArtifactReadback;
  try {
    artifact = await readWorkflowArtifactBytes({
      client, binding, runId: run.runId, artifactId: request.artifact.artifactId, name: request.artifact.name,
      expectedDigest: request.artifact.digest, creationWindow: { notBefore: startedAt, notAfter: completedAt }
    });
  } catch (error) {
    if (error instanceof GitHubActivationError && error.status === 404) throw new FailedWorkflowArtifactPendingError(request);
    throw error;
  }
  const finalRun = await readBoundWorkflowRun(client, binding, request.operation);
  if (finalRun.conclusion !== run.conclusion || canonicalSha256(finalRun.jobs) !== canonicalSha256(run.jobs)) {
    fail('The exact failed run/job/check/step observation changed while its artifact was downloaded.');
  }
  await admitFailedWorkflowArtifactOrigin(input.execution, reader, request);
  return {
    ...artifact, conclusion: 'failure', runAttempt: 1, origin: request.origin,
    checkpointDigest: canonicalSha256(original.checkpoints.prepared),
    job: { ...job, startedAt: String(rawJob.started_at), completedAt: String(rawJob.completed_at) }, reportPath
  };
}
