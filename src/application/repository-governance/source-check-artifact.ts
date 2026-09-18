import { createHash } from 'node:crypto';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { phaseScope, type ExternalOperationState, type TransitionOperation } from '../../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import { clientFor } from '../../governance-activation/github-config.js';
import { githubPorts } from '../../governance-activation/github-ports.js';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { GitHubActivationError, object, positiveId } from '../../adapters/github/activation-rest.js';
import {
  controlledSourceCheckFixtures, type RequiredWorkflowCheck
} from '../../adapters/github/workflow-check-recipes.js';
import {
  readBoundFailedWorkflowArtifact, resolveWorkflowArtifactName, FailedWorkflowArtifactPendingError,
  type FailedWorkflowArtifactRequest, type FailedWorkflowArtifactReadback
} from '../../adapters/github/workflow-failed-artifact.js';
import { extractWorkflowReport } from '../../adapters/github/workflow-report-archive.js';
import type { BoundRepositoryCheckFixture, ControlledNegativeCheckQualification } from '../../adapters/github/production-checks.js';
import { assertGitHubPhaseAuthority } from './workflow-authority.js';
import { admitFailedWorkflowArtifactOrigin, validateFailedWorkflowArtifactRequest } from './workflow-run-origin.js';
import { readWorkflowEffect } from './workflow-checkpoints.js';

export interface SourceCheckFixtureArtifactReadback {
  request: FailedWorkflowArtifactRequest;
  recordKey: string;
  checkpointDigest: string;
  sourceFileDigest: string;
  archiveDigest: string;
}

export class SourceCheckArtifactPendingError extends GitHubActivationError {
  readonly operation: ExternalOperationState;
  constructor(operation: ExternalOperationState) {
    super('check-fixture-artifact-pending',
      'The exact failed fixture run is recorded but its explicitly declared artifact has not appeared; retain the run and poll readback without dispatching again.');
    this.operation = structuredClone(operation);
  }
}

function fail(message: string): never {
  throw new GitHubActivationError('check-fixture-artifact', message);
}

/** The archive contains actual immutable fixture bytes, not a runtime assertion report or full-phase qualification. */
export async function readRepositorySourceCheckFailedArtifact(input: {
  execution: PhaseAdapterExecutionInput;
  operation: TransitionOperation;
  check: RequiredWorkflowCheck;
  fixture: BoundRepositoryCheckFixture;
  proof: Omit<ControlledNegativeCheckQualification, 'assertionExecution'>;
  request?: FailedWorkflowArtifactRequest;
}): Promise<SourceCheckFixtureArtifactReadback> {
  const { check, fixture, proof } = input;
  if (!check.fixtureArtifact || fixture.polarity !== 'negative' || proof.conclusion !== 'failure' ||
    proof.workflowId !== check.workflowId || proof.jobKey !== check.jobId || proof.context !== check.context ||
    proof.headSha !== fixture.publication.commitSha || proof.fixtureRef !== fixture.publication.featureBranch ||
    proof.pullRequestNumber !== fixture.pullRequestNumber || proof.validationStep.name !== check.validationStep) {
    fail('A source-check artifact must belong to its exact already observed negative fixture, validator and provider proof.');
  }
  const declared = check.fixtureArtifact;
  const runs = fixture.runs.filter((entry) => entry.binding.workflowId === check.workflowId &&
    entry.operation.operationId === String(proof.runId));
  const run = runs[0];
  if (runs.length !== 1 || !run || run.operation.status !== 'failed') fail('The exact original failed source-check run is missing.');
  const phaseId = run.operation.actionId === 'github.checks.repository-qualified' ? 'repository-checks-qualified' :
    run.operation.actionId === 'github.checks.green-red-proof' ? 'green-red-proof' : null;
  if (!phaseId || (input.execution.inspection.scope ?? 'activation') !== phaseScope(phaseId)) {
    fail('The original source-check phase and current reader scope must match; repository proof cannot become full qualification.');
  }
  const actionId = run.operation.actionId;
  const name = resolveWorkflowArtifactName(declared.name, {}, '', proof.runId, proof.runAttempt);
  await assertGitHubPhaseAuthority(input.execution, input.operation);
  const plans = [input.execution.plan, ...(input.execution.inspection.contexts[phaseId].reviewedPlans ?? [])]
    .filter((plan) => plan.planDigest === run.operation.planDigest && plan.phaseId === phaseId);
  const unique = [...new Map(plans.map((plan) => [canonicalSha256(plan), plan])).values()];
  if (unique.length !== 1) fail('The original negative fixture run plan is missing or ambiguous.');
  const plan = unique[0]!;
  const originalOperations = plan.operations.filter((entry) => entry.actionId === actionId);
  const originalOperation = originalOperations[0];
  if (originalOperations.length !== 1 || !originalOperation) fail('The exact original repository-check operation is missing.');
  const records = await readWorkflowEffect(input.execution, originalOperation, {
    repositoryId: run.binding.repositoryId, ref: `${run.binding.ref}:${run.binding.workflowId}`, purpose: 'check-fixture', step: 'dispatch'
  }, { binding: run.binding, fixtureDigest: canonicalSha256(fixture.publication) });
  if (!records?.observed || records.prepared.planDigest !== plan.planDigest ||
    records.prepared.approvalEnvelopeHash !== plan.approval.envelopeHash ||
    records.observed.providerId !== run.operation.operationId || records.observed.resourceId !== run.operation.resourceId) {
    fail('The exact original private source-check run custody is required before observing an artifact identity.');
  }
  const checkpointDigest = canonicalSha256(records.prepared);
  const recordKey = canonicalSha256({ kind: 'github-source-check-artifact-observed', checkpointDigest, jobKey: check.jobId, name });
  const store = createScopedUserLocalRecordStore(input.execution.inspection.projectRoot, 'governance-operation', githubPorts(input.execution).storage);
  const retained = await store.read(recordKey);
  let request = input.request ? structuredClone(input.request) : undefined;
  if (retained) {
    const saved = object(retained.value, 'Private source-check artifact observation');
    const originalRequest = saved.request as FailedWorkflowArtifactRequest;
    validateFailedWorkflowArtifactRequest(originalRequest);
    if (Object.keys(saved).sort().join(',') !== ['schemaVersion', 'kind', 'checkpointDigest', 'request', 'requestDigest', 'observedAt'].sort().join(',') ||
      saved.schemaVersion !== 1 || saved.kind !== 'github-source-check-artifact-observed' ||
      retained.projectRoot !== records.prepared.projectRoot || saved.checkpointDigest !== checkpointDigest ||
      saved.requestDigest !== canonicalSha256(originalRequest) ||
      typeof saved.observedAt !== 'string' || !Number.isFinite(Date.parse(saved.observedAt)) ||
      Date.parse(saved.observedAt) < Date.parse(records.observed.recordedAt) ||
      Date.parse(saved.observedAt) > (input.execution.clock?.() ?? input.execution.now).getTime() ||
      request && canonicalSha256(request) !== canonicalSha256(originalRequest)) {
      fail('The retained artifact provider ID, original run checkpoint or exact public reference changed; no replacement artifact is adopted.');
    }
    request = structuredClone(originalRequest);
  } else {
    if (request) fail('The retained source fixture artifact has no original project-bound private provider observation.');
    if (input.operation.actionId !== actionId || input.operation.phaseId !== phaseId ||
      canonicalSha256(input.operation) !== canonicalSha256(originalOperation) ||
      !Array.isArray(input.operation.inputs.fixtures) ||
      !input.operation.inputs.fixtures.some((entry) => canonicalSha256(entry) === canonicalSha256(fixture.publication))) {
      fail('A consuming phase must retain and approve the exact failed artifact request; only its original repository-check producer may first observe an artifact ID.');
    }
    const artifacts = await clientFor(input.execution).list(`${run.operation.resourceId}/artifacts`, 'artifacts');
    const matching = artifacts.filter((artifact) => artifact.name === name);
    if (!matching.length) throw new SourceCheckArtifactPendingError(run.operation);
    if (matching.length !== 1) fail('Multiple artifacts have the exact expected fixture name; no latest artifact is adopted.');
    const artifact = matching[0]!;
    const producer = object(artifact.workflow_run);
    if (producer.id !== proof.runId || producer.repository_id !== run.binding.repositoryId ||
      producer.head_repository_id !== run.binding.repositoryId || producer.head_sha !== run.binding.sourceSha ||
      producer.head_branch !== run.binding.ref || artifact.expired !== false ||
      typeof artifact.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest)) {
      fail('The first provider artifact observation does not identify the exact original source-check run and archive.');
    }
    request = {
      origin: { kind: 'check-fixture', phaseId, planDigest: plan.planDigest,
        savedPlanDigest: canonicalSha256(plan), operationDigest: canonicalSha256(input.operation),
        fixtureDigest: canonicalSha256(fixture.publication), pullRequestNumber: fixture.pullRequestNumber },
      binding: run.binding, operation: run.operation,
      job: { jobKey: check.jobId, name: check.context, jobId: proof.jobId, checkRunId: proof.checkRunId,
        appId: proof.appId, validationStep: check.validationStep, uploadStep: declared.uploadStep },
      artifact: { artifactId: positiveId(artifact.id), name, digest: String(artifact.digest) }
    };
    await admitFailedWorkflowArtifactOrigin(input.execution, input.operation, request);
    await store.write(recordKey, {
      schemaVersion: 1, kind: 'github-source-check-artifact-observed', checkpointDigest,
      request, requestDigest: canonicalSha256(request), observedAt: (input.execution.clock?.() ?? input.execution.now).toISOString()
    });
    await input.execution.lease!.assertHeld();
  }
  if (request.origin.kind !== 'check-fixture' || request.origin.fixtureDigest !== canonicalSha256(fixture.publication) ||
    request.origin.pullRequestNumber !== fixture.pullRequestNumber || request.artifact.name !== name ||
    canonicalSha256(request.binding) !== canonicalSha256(run.binding) ||
    request.operation.operationId !== run.operation.operationId || request.operation.resourceId !== run.operation.resourceId ||
    request.operation.planDigest !== run.operation.planDigest || request.job.jobKey !== check.jobId ||
    request.job.jobId !== proof.jobId || request.job.checkRunId !== proof.checkRunId || request.job.appId !== proof.appId ||
    request.job.validationStep !== check.validationStep || request.job.uploadStep !== declared.uploadStep) {
    fail('The retained failed-artifact request differs from this exact source-check fixture, job, run or original private plan.');
  }
  let artifact: FailedWorkflowArtifactReadback;
  try {
    artifact = await readBoundFailedWorkflowArtifact({ execution: input.execution, operation: input.operation, request });
  } catch (error) {
    if (error instanceof FailedWorkflowArtifactPendingError) throw new SourceCheckArtifactPendingError(run.operation);
    throw error;
  }
  const file = controlledSourceCheckFixtures([check], 'negative').find((entry) => entry.path === declared.path);
  if (!file || artifact.reportPath !== file.path) fail('The immutable upload does not select this registered negative fixture file.');
  const bytes = extractWorkflowReport(artifact.archive, { filename: file.path.split('/').at(-1)!, maxBytes: 64 * 1024 });
  if (!bytes.equals(Buffer.from(file.content))) fail('The actual failed-run archive does not contain the exact immutable controlled fixture bytes.');
  const finalRecord = await store.read(recordKey);
  if (!finalRecord || canonicalSha256(object(finalRecord.value).request) !== canonicalSha256(request) ||
    object(finalRecord.value).checkpointDigest !== checkpointDigest) {
    fail('The exact private artifact observation disappeared or changed during readback; retain the failed run without adopting another artifact.');
  }
  return {
    request, recordKey, checkpointDigest: artifact.checkpointDigest,
    sourceFileDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, archiveDigest: artifact.digest
  };
}
