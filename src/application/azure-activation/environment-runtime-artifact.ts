import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { ExternalOperationState } from '../../domain/governance/activation/types.js';
import { GitHubActivationClient, object } from '../../adapters/github/activation-rest.js';
import {
  readBoundWorkflowArtifact, readBoundWorkflowRun, type BoundWorkflowJob
} from '../../adapters/github/production-checks.js';
import { readbackWorkflowContent } from '../../adapters/github/production-workflows.js';
import {
  providerQualificationTimestamp, qualificationFailure, qualificationInteger, qualificationObject,
  qualificationText, qualificationTimestamp
} from './qualification-authority.js';
import { qualificationDigest } from './qualification-evidence.js';
import { environmentRuntimeInputs, type EnvironmentRuntimeInputs } from './environment-runtime-inputs.js';
import {
  readEnvironmentRuntimeArchive, renderEnvironmentRuntimeWorkflow, validateEnvironmentRuntimeReport,
  type EnvironmentRuntimeJobRunner, type EnvironmentRuntimeReport
} from './environment-runtime-workflow.js';

export interface EnvironmentRuntimeArtifactReference {
  artifactId: number;
  name: string;
  archiveDigest: string;
}

export interface EnvironmentRuntimeArtifactDescriptor extends EnvironmentRuntimeArtifactReference {
  reportDigest: string;
}

export interface EnvironmentRuntimeArtifactSource {
  inputs: EnvironmentRuntimeInputs;
  operation: ExternalOperationState;
  correlationId: string;
}

export interface EnvironmentRuntimeVerifierSource {
  producerSourceSha: string;
  executionSourceSha: string;
  workflowId: number;
  workflowPath: string;
  workflowDigest: string;
  workflowBlobSha: string;
}

export interface EnvironmentRuntimeArtifactReadback {
  kind: 'environment-runtime-artifact.v1';
  archiveBytes: number;
  reportArtifact: EnvironmentRuntimeArtifactDescriptor;
  report: EnvironmentRuntimeReport;
  verifierSource: EnvironmentRuntimeVerifierSource;
  runner: EnvironmentRuntimeJobRunner;
  job: BoundWorkflowJob & { startedAt: string; completedAt: string };
  run: { runId: number; runAttempt: number; createdAt: string; updatedAt: string };
}

function referenceFields(data: Record<string, unknown>): EnvironmentRuntimeArtifactReference {
  const name = qualificationText(data.name, 'Exact runtime report artifact name');
  const archiveDigest = qualificationText(data.archiveDigest, 'Provider ZIP digest');
  if (!/^liftoff-environment-[a-f0-9-]{36}$/u.test(name) || !/^sha256:[a-f0-9]{64}$/u.test(archiveDigest)) {
    qualificationFailure('environment-artifact-descriptor', 'The report artifact needs its actual correlation-bound name and provider ZIP SHA-256, distinct from the application OCI digest.');
  }
  return { artifactId: qualificationInteger(data.artifactId, 'Actual report artifact ID'), name, archiveDigest };
}

export function environmentRuntimeArtifactReference(value: unknown): EnvironmentRuntimeArtifactReference {
  return referenceFields(qualificationObject(value, ['artifactId', 'name', 'archiveDigest'], 'Runtime report artifact reference'));
}

export function environmentRuntimeArtifactDescriptor(value: unknown): EnvironmentRuntimeArtifactDescriptor {
  const data = qualificationObject(value, ['artifactId', 'name', 'archiveDigest', 'reportDigest'], 'Retained runtime report artifact descriptor');
  return { ...referenceFields(data), reportDigest: qualificationDigest(data.reportDigest, 'Raw runtime report byte digest') };
}

/**
 * Observes new report bytes under the caller's GitHub-read authority. Original plan,
 * issuance and checkpoint admission belong to the caller; this is runtime-only proof.
 */
export async function observeEnvironmentRuntimeArtifact(
  client: GitHubActivationClient, source: EnvironmentRuntimeArtifactSource,
  reference: EnvironmentRuntimeArtifactReference, now: Date
): Promise<EnvironmentRuntimeArtifactReadback> {
  qualificationObject(source, ['inputs', 'operation', 'correlationId'], 'Original runtime artifact source');
  const config = environmentRuntimeInputs(structuredClone(source.inputs));
  const operation = structuredClone(source.operation);
  const artifactRef = environmentRuntimeArtifactReference(reference);
  const correlationId = qualificationText(source.correlationId, 'Original dispatch correlation');
  const observedAt = new Date(now.getTime());
  const actions = {
    dev: 'github.checks.dev-proof', staging: 'github.checks.staging', prod: 'github.checks.production-rehearsal'
  };
  const preparedAt = qualificationTimestamp(operation.startedAt, 'Original operation start');
  const recordedAt = qualificationTimestamp(operation.observedAt, 'Original operation observation');
  qualificationDigest(operation.planDigest, 'Original operation plan digest');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(correlationId) ||
    artifactRef.name !== `liftoff-environment-${correlationId}` ||
    operation.actionId !== actions[config.disposableTarget.target.environment] ||
    !Number.isFinite(observedAt.getTime()) || Date.parse(recordedAt) < Date.parse(preparedAt) ||
    Date.parse(recordedAt) > observedAt.getTime()) {
    qualificationFailure('environment-artifact-source', 'Report readback needs the original exact phase operation, correlation, archive identity and unmodified timestamps.');
  }
  const readOnly = new GitHubActivationClient({ async request(request) {
    if (request.method !== 'GET') qualificationFailure('environment-read-only', 'Consuming runtime report admission permits GitHub reads only, never workflow dispatch or mutations.');
    return client.transport.request(request);
  } });
  const run = await readBoundWorkflowRun(readOnly, config.workflow, operation);
  if (run.conclusion !== 'success') qualificationFailure('environment-run-failed', 'Failed, cancelled, neutral and skipped runtime producers cannot establish observations.');
  const currentRef = await readOnly.get(`/repos/${config.workflow.repository}/git/ref/heads/${config.workflow.ref}`);
  if (currentRef.ref !== `refs/heads/${config.workflow.ref}` ||
    object(currentRef.object).type !== 'commit' || object(currentRef.object).sha !== config.workflow.sourceSha) {
    qualificationFailure('environment-source-ref', 'The consumed runtime source ref no longer names the exact reviewed commit.');
  }
  const workflowSource = await readbackWorkflowContent(readOnly, config.workflow.repository, config.workflow.workflowPath, config.workflow.sourceSha);
  const publishedSource = config.workflow.producerSourceSha === config.workflow.sourceSha ? workflowSource :
    await readbackWorkflowContent(readOnly, config.workflow.repository, config.workflow.workflowPath, config.workflow.producerSourceSha);
  if (workflowSource.digest !== config.workflow.workflowDigest ||
    workflowSource.content !== renderEnvironmentRuntimeWorkflow(config.runtime.recipe) ||
    publishedSource.digest !== workflowSource.digest || publishedSource.content !== workflowSource.content ||
    publishedSource.blobSha !== workflowSource.blobSha) {
    qualificationFailure('environment-source', 'The immutable provider workflow bytes are not the registered runtime observation program.');
  }
  const createdAt = providerQualificationTimestamp(run.providerRun.created_at, 'Actual provider run creation');
  const updatedAt = providerQualificationTimestamp(run.providerRun.updated_at, 'Actual provider run update');
  if (run.providerRun.display_title !== `liftoff-${correlationId}` ||
    Date.parse(preparedAt) < Date.parse(config.disposableTarget.notBefore) ||
    Date.parse(createdAt) < Date.parse(preparedAt) || Date.parse(updatedAt) < Date.parse(createdAt) ||
    Date.parse(updatedAt) > observedAt.getTime()) {
    qualificationFailure('environment-run-clock', 'The actual correlated runtime operation is outside its original recorded disposable execution interval.');
  }
  const jobs = await readOnly.list(`${operation.resourceId}/attempts/${config.workflow.runAttempt}/jobs`, 'jobs');
  if (jobs.length !== 1 || run.jobs.length !== 1 || jobs[0]!.id !== run.jobs[0]!.id) {
    qualificationFailure('environment-job-identity', 'The exact runtime job and independent provider check identity are missing or ambiguous.');
  }
  const startedAt = providerQualificationTimestamp(jobs[0]!.started_at, 'Actual provider job start');
  const completedAt = providerQualificationTimestamp(jobs[0]!.completed_at, 'Actual provider job completion');
  if (Date.parse(startedAt) < Date.parse(createdAt) || Date.parse(completedAt) < Date.parse(startedAt) ||
    Date.parse(completedAt) > Date.parse(updatedAt) || Date.parse(completedAt) >= Date.parse(config.disposableTarget.expiresAt)) {
    qualificationFailure('environment-run-clock', 'The actual runtime job is outside its original reviewed execution window; provider bookkeeping updates are not job completion.');
  }
  const archive = await readBoundWorkflowArtifact({
    client: readOnly, binding: config.workflow, operation, artifactId: artifactRef.artifactId,
    name: artifactRef.name, expectedDigest: artifactRef.archiveDigest
  });
  let bytes: Buffer | undefined;
  try {
    if (archive.size > 512 * 1024) qualificationFailure('environment-artifact-size', 'The actual runtime archive exceeds its registered bounded report budget.');
    bytes = readEnvironmentRuntimeArchive(archive.archive);
    const parsed = validateEnvironmentRuntimeReport(bytes, config.runtime.recipe, config.workflow, {
      runId: run.runId, correlationId, configurationDigest: config.dispatchInputs.qualification_digest,
      job: run.jobs[0]!, providerJob: jobs[0]!, now: observedAt
    });
    if (parsed.runner.runnerGroupId !== config.runnerAssignment.binding.groupId) {
      qualificationFailure('environment-runner-assignment', 'Actual provider job group identity differs from the separately reviewed assignment; a matching group name or hosted definition ID is not sufficient.');
    }
    if (Date.parse(parsed.report.observedAt) < Date.parse(createdAt) ||
      Date.parse(parsed.report.observedAt) > Date.parse(completedAt)) {
      qualificationFailure('environment-report-clock', 'The actual report was not produced during its bound provider run.');
    }
    return {
      kind: 'environment-runtime-artifact.v1',
      archiveBytes: archive.size,
      reportArtifact: { artifactId: archive.artifactId, name: archive.name, archiveDigest: archive.digest, reportDigest: parsed.reportDigest },
      report: parsed.report, runner: parsed.runner, job: { ...run.jobs[0]!, startedAt, completedAt },
      verifierSource: {
        producerSourceSha: config.workflow.producerSourceSha, executionSourceSha: config.workflow.sourceSha,
        workflowId: config.workflow.workflowId, workflowPath: config.workflow.workflowPath,
        workflowDigest: workflowSource.digest, workflowBlobSha: workflowSource.blobSha
      },
      run: { runId: run.runId, runAttempt: run.runAttempt, createdAt, updatedAt }
    };
  } finally { bytes?.fill(0); archive.archive.fill(0); }
}

/** Re-reads the exact retained descriptor; never substitutes a discovered/latest artifact or enforcing actor. */
export async function readEnvironmentRuntimeArtifact(
  client: GitHubActivationClient, source: EnvironmentRuntimeArtifactSource,
  descriptor: EnvironmentRuntimeArtifactDescriptor, now: Date
): Promise<EnvironmentRuntimeArtifactReadback> {
  const expected = environmentRuntimeArtifactDescriptor(descriptor);
  const result = await observeEnvironmentRuntimeArtifact(client, source, {
    artifactId: expected.artifactId, name: expected.name, archiveDigest: expected.archiveDigest
  }, now);
  if (canonicalSha256(result.reportArtifact) !== canonicalSha256(expected)) {
    qualificationFailure('environment-report-commitment', 'Actual report bytes do not match the descriptor committed by the original evidence body and header.');
  }
  return result;
}
