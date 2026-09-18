import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { stateAssert } from '../../domain/repair/stateful-invariants.js';
import type { ExternalOperationState } from '../../domain/governance/activation/types.js';
import { readBoundWorkflowArtifact, readBoundWorkflowRun } from '../../adapters/github/production-checks.js';
import { readbackWorkflowContent } from '../../adapters/github/production-workflows.js';
import type { GitHubActivationClient } from '../../adapters/github/activation-rest.js';
import { exactObject } from './private-resource-plans.js';
import { assertPrivateNetworkObservation, readPrivateReportArchive } from './private-runner-workflow.js';
import {
  privateBackendArtifactPrefix, privateBackendJobName, privateBackendReportFilename,
  privateBackendWorkflowBinding, renderPrivateBackendWorkflow, validatePrivateBackendSource,
  type PrivateBackendRunReport, type PrivateBackendWorkflowSource
} from './private-backend-workflow.js';
import { privateLeaseSteps, type PrivateLeaseChallenge } from './private-backend-lease.js';

function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value) &&
    value !== '00000000-0000-0000-0000-000000000000';
}

function iso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function validatePrivateBackendReport(
  value: unknown,
  expected: {
    source: PrivateBackendWorkflowSource; operation: ExternalOperationState; challenge: PrivateLeaseChallenge;
    correlationId: string; configurationDigest: string; runnerGroupId: number;
  },
  job: Record<string, unknown>,
  now: Date
): PrivateBackendRunReport {
  const report = exactObject(value, [
    'schemaVersion', 'kind', 'repository', 'repositoryId', 'workflowPath', 'sourceSha', 'runId', 'runAttempt',
    'correlationId', 'configurationDigest', 'targetDigest', 'principalId', 'job', 'network', 'probe', 'failure', 'observedAt'
  ], 'Payload-free private backend report');
  const { source, challenge } = expected;
  const target = source.recipe.target;
  stateAssert(report.schemaVersion === 1 && report.kind === 'private-backend-lease-run-report' &&
    report.repository === source.recipe.repository && report.repositoryId === source.recipe.repositoryId &&
    report.workflowPath === source.recipe.workflowPath && report.sourceSha === source.sourceSha &&
    report.runId === Number(expected.operation.operationId) && report.runAttempt === 1 &&
    report.correlationId === expected.correlationId && uuid(report.correlationId) &&
    report.configurationDigest === expected.configurationDigest && report.targetDigest === canonicalSha256(target) &&
    (report.principalId === null || report.principalId === target.binding.principalId) &&
    (report.failure === null || report.failure === 'private-backend-observation-incomplete') &&
    iso(report.observedAt) && Date.parse(report.observedAt) <= now.getTime() &&
    now.getTime() - Date.parse(report.observedAt) <= 15 * 60_000, 'verification-incomplete');
  const reportObservedAt = report.observedAt;
  const runner = exactObject(report.job, ['id', 'name', 'runnerId', 'runnerGroupId', 'runnerName', 'labels'], 'Actual private backend runner');
  const jobStartedAt = job.started_at, jobCompletedAt = job.completed_at;
  stateAssert(runner.id === job.id && runner.name === privateBackendJobName &&
    runner.runnerId === job.runner_id && Number.isSafeInteger(runner.runnerId) && Number(runner.runnerId) > 0 &&
    runner.runnerGroupId === expected.runnerGroupId && job.runner_group_id === expected.runnerGroupId &&
    runner.runnerName === job.runner_name && canonicalSha256(runner.labels) === canonicalSha256(job.labels) &&
    Array.isArray(runner.labels) && runner.labels.includes(source.recipe.runnerLabel) &&
    typeof jobStartedAt === 'string' && typeof jobCompletedAt === 'string' &&
    Date.parse(reportObservedAt) >= Date.parse(jobStartedAt) && Date.parse(reportObservedAt) <= Date.parse(jobCompletedAt) &&
    Date.parse(jobCompletedAt) <= now.getTime(), 'verification-incomplete');
  if (report.network !== null) assertPrivateNetworkObservation(report.network, {
    hostname: `${target.backend.account}.blob.core.windows.net`, endpointAddress: target.endpointAddress
  }, source.recipe.runnerSubnetPrefix);
  if (report.probe === null) {
    stateAssert(report.failure !== null, 'verification-incomplete');
    return structuredClone(report) as unknown as PrivateBackendRunReport;
  }
  const probe = exactObject(report.probe, [
    'schemaVersion', 'kind', 'intentDigest', 'outcome', 'reason', 'leaseDurationSeconds', 'effects', 'metadata'
  ], 'Exact private lease protocol result');
  stateAssert(probe.schemaVersion === 1 && probe.kind === 'private-backend-lease-probe' &&
    probe.intentDigest === challenge.intentDigest && probe.leaseDurationSeconds === 60 &&
    ['verified', 'blocked', 'unknown'].includes(String(probe.outcome)) &&
    (probe.reason === null || typeof probe.reason === 'string' && /^[a-z-]{1,80}$/u.test(probe.reason)) &&
    Array.isArray(probe.effects) && probe.effects.length === privateLeaseSteps.length &&
    Array.isArray(probe.metadata) && probe.metadata.length <= 3, 'verification-incomplete');
  const effects = probe.effects.map((entry, index) => {
    const effect = exactObject(entry, [
      'step', 'action', 'clientRequestId', 'outcome', 'requestId', 'status', 'etag', 'errorCode', 'startedAt', 'observedAt'
    ], 'Actual private lease effect');
    const step = privateLeaseSteps[index]!;
    const startedAt = effect.startedAt, observedAt = effect.observedAt;
    stateAssert(effect.step === step && effect.action === (step === 'contend' ? 'acquire' : step) &&
      effect.clientRequestId === challenge.clientRequestIds[step] &&
      ['returned', 'unknown', 'not-attempted'].includes(String(effect.outcome)) &&
      [null, 'LeaseAlreadyPresent', 'BlobNotFound', 'ConditionNotMet', 'LeaseIdMismatchWithLeaseOperation',
        'AuthorizationPermissionMismatch', 'StorageError'].includes(effect.errorCode as string | null), 'verification-incomplete');
    if (effect.outcome === 'returned') {
      stateAssert(uuid(effect.requestId) && effect.requestId !== effect.clientRequestId &&
        typeof effect.status === 'number' && Number.isInteger(effect.status) && effect.status >= 100 && effect.status <= 599 &&
        (effect.etag === null || typeof effect.etag === 'string' && /^"0x[a-f0-9]+"$/iu.test(effect.etag)) &&
        iso(startedAt) && iso(observedAt) &&
        Date.parse(startedAt) >= Date.parse(jobStartedAt) &&
        Date.parse(startedAt) < Date.parse(step === 'release' ? challenge.releaseUntil : challenge.activeUntil) &&
        Date.parse(observedAt) >= Date.parse(startedAt) &&
        Date.parse(observedAt) <= Date.parse(reportObservedAt), 'verification-incomplete');
    } else {
      stateAssert(effect.requestId === null && effect.status === null && effect.etag === null && effect.errorCode === null &&
        observedAt === null &&
        (effect.outcome === 'not-attempted' ? startedAt === null : iso(startedAt) &&
          Date.parse(startedAt) >= Date.parse(jobStartedAt) &&
          Date.parse(startedAt) < Date.parse(step === 'release' ? challenge.releaseUntil : challenge.activeUntil) &&
          Date.parse(startedAt) <= Date.parse(reportObservedAt)), 'verification-incomplete');
    }
    return effect;
  });
  const stages = ['before', 'held', 'after'];
  const metadata = probe.metadata.map((entry) => {
    const observed = exactObject(entry, [
      'stage', 'requestId', 'status', 'etag', 'version', 'leaseStatus', 'leaseState', 'serverEncrypted', 'observedAt'
    ], 'Actual private lease metadata');
    stateAssert(stages.includes(String(observed.stage)) && uuid(observed.requestId) &&
      typeof observed.status === 'number' && Number.isInteger(observed.status) && observed.status >= 100 && observed.status <= 599 &&
      (observed.etag === null || typeof observed.etag === 'string' && /^"0x[a-f0-9]+"$/iu.test(observed.etag)) &&
      (observed.version === null || typeof observed.version === 'string' && observed.version.length <= 128) &&
      [null, 'locked', 'unlocked'].includes(observed.leaseStatus as string | null) &&
      [null, 'available', 'leased', 'expired', 'breaking', 'broken'].includes(observed.leaseState as string | null) &&
      typeof observed.serverEncrypted === 'boolean' && iso(observed.observedAt), 'verification-incomplete');
    return observed;
  });
  stateAssert(new Set(metadata.map((entry) => entry.stage)).size === metadata.length, 'verification-incomplete');
  const requestIds = [...effects.filter((effect) => effect.outcome === 'returned').map((effect) => effect.requestId),
    ...metadata.map((observed) => observed.requestId)];
  stateAssert(new Set(requestIds).size === requestIds.length, 'verification-incomplete');
  if (probe.outcome === 'verified') {
    stateAssert(report.failure === null && report.network !== null && report.principalId === target.binding.principalId &&
      probe.reason === null &&
      effects.every((effect, index) => effect.outcome === 'returned' && effect.status === [201, 409, 200, 200][index] &&
        (index === 1 ? effect.errorCode === 'LeaseAlreadyPresent' : effect.etag === challenge.expectedEtag && effect.errorCode === null)) &&
      metadata.length === 3 && metadata.every((observed, index) => observed.stage === stages[index] &&
        observed.status === 200 && observed.etag === challenge.expectedEtag && observed.version === challenge.expectedVersion &&
        observed.serverEncrypted === true && observed.leaseStatus === (index === 1 ? 'locked' : 'unlocked') &&
        (index === 0 ? ['available', 'expired', 'broken'].includes(String(observed.leaseState))
          : observed.leaseState === (index === 1 ? 'leased' : 'available'))), 'verification-incomplete');
    stateAssert(effects.slice(1).every((effect, index) => Date.parse(String(effect.startedAt)) >= Date.parse(String(effects[index]!.observedAt))) &&
      Date.parse(String(metadata[0]!.observedAt)) <= Date.parse(String(effects[0]!.startedAt)) &&
      Date.parse(String(metadata[1]!.observedAt)) >= Date.parse(String(effects[2]!.observedAt)) &&
      Date.parse(String(metadata[1]!.observedAt)) <= Date.parse(String(effects[3]!.startedAt)) &&
      Date.parse(String(metadata[2]!.observedAt)) >= Date.parse(String(effects[3]!.observedAt)) &&
      Date.parse(String(metadata[2]!.observedAt)) <= Date.parse(reportObservedAt), 'verification-incomplete');
  } else if (probe.outcome === 'unknown') {
    stateAssert(effects.some((effect) => effect.outcome === 'unknown'), 'verification-incomplete');
  } else stateAssert(probe.reason !== null, 'verification-incomplete');
  return structuredClone(report) as unknown as PrivateBackendRunReport;
}

export async function readPrivateBackendReport(
  client: GitHubActivationClient,
  expected: Parameters<typeof validatePrivateBackendReport>[1],
  now: Date
): Promise<{ report: PrivateBackendRunReport; artifactId: number; digest: string; jobId: number; checkRunId: number }> {
  const source = validatePrivateBackendSource(expected.source);
  const binding = privateBackendWorkflowBinding(source);
  const run = await readBoundWorkflowRun(client, binding, expected.operation);
  stateAssert(run.conclusion === 'success', 'verification-incomplete');
  const content = await readbackWorkflowContent(client, binding.repository, binding.workflowPath, binding.sourceSha);
  stateAssert(content.content === renderPrivateBackendWorkflow(source.recipe), 'configuration-changed');
  const jobs = await client.list(`${expected.operation.resourceId}/attempts/1/jobs`, 'jobs');
  stateAssert(jobs.length === 1 && run.jobs.length === 1 && jobs[0]!.id === run.jobs[0]!.id, 'verification-incomplete');
  const job = jobs[0]!;
  for (const name of ['Private backend lease probe', 'Retain backend lease report']) {
    stateAssert(Array.isArray(job.steps), 'verification-incomplete');
    const matching = job.steps.filter((entry) => isRecord(entry) && entry.name === name);
    stateAssert(matching.length === 1 && isRecord(matching[0]) && matching[0].status === 'completed' &&
      matching[0].conclusion === 'success', 'verification-incomplete');
  }
  const name = `${privateBackendArtifactPrefix}${expected.correlationId}`;
  const artifacts = await client.list(`${expected.operation.resourceId}/artifacts`, 'artifacts');
  const matching = artifacts.filter((artifact) => artifact.name === name);
  stateAssert(matching.length === 1 && Number.isSafeInteger(matching[0]!.id), 'verification-incomplete');
  const artifact = await readBoundWorkflowArtifact({
    client, binding, operation: expected.operation, artifactId: Number(matching[0]!.id), name
  });
  try {
    const value = readPrivateReportArchive(artifact.archive, privateBackendReportFilename);
    return { report: validatePrivateBackendReport(value, expected, job, now), artifactId: artifact.artifactId,
      digest: artifact.digest, jobId: Number(job.id), checkRunId: run.jobs[0]!.checkRunId };
  } finally { artifact.archive.fill(0); }
}
