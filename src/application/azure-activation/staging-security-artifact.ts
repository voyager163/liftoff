import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { ExternalOperationState } from '../../domain/governance/activation/types.js';
import { GitHubActivationClient, object, positiveId } from '../../adapters/github/activation-rest.js';
import { readBoundWorkflowArtifact, readBoundWorkflowRun, type WorkflowRunBinding } from '../../adapters/github/production-checks.js';
import { readbackWorkflowContent } from '../../adapters/github/production-workflows.js';
import { sourceSha } from '../../governance-activation/github-config.js';
import { providerQualificationTimestamp, qualificationFailure } from './qualification-authority.js';
import {
  assertPublishedStagingSecurityRecipe, assertStagingSecurityReportPassed, readStagingSecurityArchive,
  renderStagingSecurityWorkflow, stagingSecurityWorkflowJob, stagingSecurityWorkflowRecipe, validateStagingSecurityReport,
  type StagingSecurityReport, type StagingSecurityWorkflowRecipe
} from './staging-security-workflow.js';

export function stagingSecurityWorkflowBinding(value: StagingSecurityWorkflowRecipe): WorkflowRunBinding {
  const recipe = stagingSecurityWorkflowRecipe(value);
  assertPublishedStagingSecurityRecipe(recipe);
  return {
    repository: recipe.repository, repositoryId: recipe.repositoryId, workflowPath: recipe.workflowPath,
    workflowId: recipe.workflowId, workflowDigest: canonicalSha256(renderStagingSecurityWorkflow(recipe)),
    sourceSha: recipe.sourceSha, ref: recipe.ref, actorId: recipe.actorId, event: 'workflow_dispatch',
    expectedJobs: [stagingSecurityWorkflowJob], runAttempt: 1
  };
}

export interface StagingSecurityArtifactDescriptor {
  artifactId: number;
  name: string;
  archiveDigest: string;
  reportDigest: string;
}

export interface StagingSecurityArtifactReadback {
  kind: 'staging-security-artifact.v1';
  descriptor: StagingSecurityArtifactDescriptor;
  report: StagingSecurityReport;
  source: { producerSourceSha: string; executionSourceSha: string; workflowBlobSha: string; workflowDigest: string };
  run: { runId: number; runAttempt: number; createdAt: string; updatedAt: string };
  job: Awaited<ReturnType<typeof readBoundWorkflowRun>>['jobs'][number] & { startedAt: string; completedAt: string };
}

/** This primitive reads only provider bytes; original plan, approval and private checkpoint admission belong to the caller. */
export async function readStagingSecurityArtifact(input: {
  client: GitHubActivationClient;
  recipe: StagingSecurityWorkflowRecipe;
  producerSourceSha: string;
  operation: ExternalOperationState;
  correlationId: string;
  configurationDigest: string;
  artifact: Pick<StagingSecurityArtifactDescriptor, 'artifactId' | 'name' | 'archiveDigest'>;
  now: Date;
}): Promise<StagingSecurityArtifactReadback> {
  const recipe = stagingSecurityWorkflowRecipe(input.recipe);
  assertPublishedStagingSecurityRecipe(recipe);
  const binding = stagingSecurityWorkflowBinding(recipe);
  const producerSourceSha = sourceSha(input.producerSourceSha);
  if (input.operation.actionId !== 'github.checks.staging' || input.operation.provider !== 'github' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(input.correlationId) ||
    input.artifact.name !== `liftoff-staging-security-${input.correlationId}` ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.artifact.archiveDigest)) {
    qualificationFailure('staging-security-artifact', 'Security proof requires its exact original operation, correlation and named immutable archive.');
  }
  const client = new GitHubActivationClient({ async request(request) {
    if (request.method !== 'GET') qualificationFailure('staging-security-read-only', 'Security proof consumption cannot dispatch or mutate provider resources.');
    return input.client.transport.request(request);
  } });
  const run = await readBoundWorkflowRun(client, binding, input.operation);
  if (run.conclusion !== 'success' || run.providerRun.display_title !== `liftoff-${input.correlationId}`) {
    qualificationFailure('staging-security-run', 'The exact security job must actually pass; scanner findings, skipped steps or arbitrary workflow success do not qualify staging.');
  }
  const source = await readbackWorkflowContent(client, binding.repository, binding.workflowPath, binding.sourceSha);
  const published = producerSourceSha === binding.sourceSha ? source :
    await readbackWorkflowContent(client, binding.repository, binding.workflowPath, producerSourceSha);
  const ref = await client.get(`/repos/${binding.repository}/git/ref/heads/${binding.ref}`);
  if (source.content !== renderStagingSecurityWorkflow(recipe) || source.digest !== binding.workflowDigest ||
    source.digest !== published.digest || source.blobSha !== published.blobSha ||
    ref.ref !== `refs/heads/${binding.ref}` || object(ref.object).sha !== binding.sourceSha) {
    qualificationFailure('staging-security-source', 'The original published and executing verifier bytes/ref differ from the registered security program.');
  }
  const jobs = await client.list(`${input.operation.resourceId}/attempts/1/jobs`, 'jobs');
  if (jobs.length !== 1 || run.jobs.length !== 1 || jobs[0]!.id !== run.jobs[0]!.id) {
    qualificationFailure('staging-security-job', 'Staging requires one exact same-run private-access/security/DAST job and its independent check-run binding.');
  }
  const createdAt = providerQualificationTimestamp(run.providerRun.created_at, 'Actual security run creation');
  const updatedAt = providerQualificationTimestamp(run.providerRun.updated_at, 'Actual security run bookkeeping');
  const startedAt = providerQualificationTimestamp(jobs[0]!.started_at, 'Actual security job start');
  const completedAt = providerQualificationTimestamp(jobs[0]!.completed_at, 'Actual security job completion');
  if (Date.parse(createdAt) < Date.parse(input.operation.startedAt) || Date.parse(startedAt) < Date.parse(createdAt) ||
    Date.parse(completedAt) < Date.parse(startedAt) || Date.parse(updatedAt) < Date.parse(completedAt) ||
    Date.parse(updatedAt) > input.now.getTime()) {
    qualificationFailure('staging-security-clock', 'Security proof must preserve actual original run/job times, not treat later provider bookkeeping as a new execution.');
  }
  const archive = await readBoundWorkflowArtifact({
    client, binding, operation: input.operation, artifactId: positiveId(input.artifact.artifactId), name: input.artifact.name,
    expectedDigest: input.artifact.archiveDigest
  });
  let bytes: Buffer | undefined;
  try {
    bytes = readStagingSecurityArchive(archive.archive);
    const parsed = validateStagingSecurityReport(bytes, recipe, binding, {
      runId: run.runId, correlationId: input.correlationId, configurationDigest: input.configurationDigest,
      job: run.jobs[0]!, providerJob: jobs[0]!, now: input.now
    });
    assertStagingSecurityReportPassed(parsed);
    return {
      kind: 'staging-security-artifact.v1',
      descriptor: { artifactId: archive.artifactId, name: archive.name, archiveDigest: archive.digest, reportDigest: parsed.reportDigest },
      report: parsed.report, source: { producerSourceSha, executionSourceSha: binding.sourceSha,
        workflowBlobSha: source.blobSha, workflowDigest: source.digest },
      run: { runId: run.runId, runAttempt: run.runAttempt, createdAt, updatedAt },
      job: { ...run.jobs[0]!, startedAt, completedAt }
    };
  } finally { bytes?.fill(0); archive.archive.fill(0); }
}
