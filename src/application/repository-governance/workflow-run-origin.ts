import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import {
  type ExternalOperationState, type SavedTransitionPlan, type TransitionOperation
} from '../../domain/governance/activation/types.js';
import {
  validateWorkflowPublicationPlan, type WorkflowPublicationPlan
} from '../../adapters/github/production-workflows.js';
import { GitHubActivationError, object, positiveId } from '../../adapters/github/activation-rest.js';
import { validateWorkflowRunBinding, type WorkflowRunBinding } from '../../adapters/github/workflow-run-readback.js';
import type { WorkflowArtifactDescriptor } from '../../adapters/github/workflow-artifact-readback.js';
import { isProtectedRefFamily, matchesProtectedRefFamily } from '../../adapters/github/workflow-check-recipes.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import { assertGitHubPhaseAuthority } from './workflow-authority.js';
import { readWorkflowEffect, type WorkflowEffectCheckpoints } from './workflow-checkpoints.js';
import { workflowOriginAuthority, type WorkflowOriginPhase } from './workflow-origin-authority.js';

export type WorkflowRunOriginReference = {
  phaseId: WorkflowOriginPhase;
  planDigest: string;
  savedPlanDigest: string;
  operationDigest: string;
} & (
  { kind: 'workflow-dispatch' } |
  { kind: 'check-fixture'; fixtureDigest: string; pullRequestNumber: number }
);

export interface FailedWorkflowArtifactRequest {
  origin: WorkflowRunOriginReference;
  binding: WorkflowRunBinding;
  operation: ExternalOperationState;
  job: {
    jobKey: string;
    name: string;
    jobId: number;
    checkRunId: number;
    appId: number;
    validationStep: string;
    uploadStep: string;
  };
  artifact: WorkflowArtifactDescriptor;
}

function fail(message: string): never {
  throw new GitHubActivationError('failed-artifact-authority', message);
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail('An exact original plan, operation or fixture digest is required.');
  return value;
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('An original workflow timestamp is missing or malformed.');
  return Date.parse(value);
}

function records(value: unknown, maximum: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.length || value.length > maximum || value.some((entry) => !isRecord(entry))) {
    fail('The original bounded workflow/fixture inventory is missing.');
  }
  return value;
}

function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  const record = object(value);
  if (Object.keys(record).length !== names.length || names.some((name) => !Object.hasOwn(record, name))) {
    fail('Failed-run readback requires its exact original reference and provider descriptor, not authority flags.');
  }
  return record;
}

export function validateFailedWorkflowArtifactRequest(request: FailedWorkflowArtifactRequest): void {
  fields(request, ['origin', 'binding', 'operation', 'job', 'artifact']);
  const origin = object(request.origin);
  fields(origin, ['phaseId', 'planDigest', 'savedPlanDigest', 'operationDigest', 'kind',
    ...(origin.kind === 'check-fixture' ? ['fixtureDigest', 'pullRequestNumber'] : [])]);
  if (!['repository-checks-qualified', 'green-red-proof', 'dev-proof', 'staging-qualified', 'production-rehearsed'].includes(String(origin.phaseId)) ||
    origin.kind !== 'workflow-dispatch' && origin.kind !== 'check-fixture') fail('Only an original registered qualification workflow can supply failed-run readback.');
  hash(origin.planDigest); hash(origin.savedPlanDigest); hash(origin.operationDigest);
  if (origin.kind === 'check-fixture') { hash(origin.fixtureDigest); positiveId(origin.pullRequestNumber); }
  validateWorkflowRunBinding(request.binding);
  if (!request.binding.producerSourceSha) fail('Failed-run readback must separately name its immutable workflow producer source.');
  fields(request.operation, ['provider', 'actionId', 'operationId', 'resourceId', 'startedAt', 'observedAt', 'status', 'planDigest']);
  if (request.operation.provider !== 'github' || request.operation.status !== 'failed' ||
    !/^[1-9]\d*$/u.test(request.operation.operationId) ||
    request.operation.resourceId !== `/repos/${request.binding.repository}/actions/runs/${positiveId(Number(request.operation.operationId))}` ||
    request.operation.planDigest !== origin.planDigest ||
    timestamp(request.operation.observedAt) < timestamp(request.operation.startedAt)) {
    fail('The original failed provider operation, exact run ID or plan reference is missing; success and latest runs are not substitutes.');
  }
  fields(request.job, ['jobKey', 'name', 'jobId', 'checkRunId', 'appId', 'validationStep', 'uploadStep']);
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(request.job.jobKey) ||
    [request.job.name, request.job.validationStep, request.job.uploadStep].some((name) =>
      typeof name !== 'string' || !name || name.length > 200 || /[\u0000-\u001f\u007f]/u.test(name)) ||
    !request.binding.expectedJobs.includes(request.job.name) || request.job.validationStep === request.job.uploadStep) {
    fail('The exact source job, failed validation step and independent artifact upload step are required.');
  }
  positiveId(request.job.jobId); positiveId(request.job.checkRunId); positiveId(request.job.appId);
  fields(request.artifact, ['artifactId', 'name', 'digest']);
  positiveId(request.artifact.artifactId);
  if (typeof request.artifact.name !== 'string' || !request.artifact.name || request.artifact.name.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(request.artifact.name) || !/^sha256:[a-f0-9]{64}$/u.test(request.artifact.digest)) {
    fail('An exact provider artifact ID, name and archive digest are mandatory; no latest artifact is selected.');
  }
}

/** Original issuance is evaluated at its own prepared time; it never replaces the current reader's authority. */
export async function admitFailedWorkflowArtifactOrigin(
  input: PhaseAdapterExecutionInput, reader: TransitionOperation, request: FailedWorkflowArtifactRequest
): Promise<{
  plan: SavedTransitionPlan;
  operation: TransitionOperation;
  checkpoints: WorkflowEffectCheckpoints;
  notBefore: number;
  expiresAt: number;
  publication?: WorkflowPublicationPlan;
}> {
  validateFailedWorkflowArtifactRequest(request);
  await assertGitHubPhaseAuthority(input, reader);
  const { origin, binding } = request;
  if (reader.adapter !== 'github' || ![reader, ...(reader.effects ?? [])].some((effect) =>
    effect.remote && effect.mutationClass === 'github-read' && effect.destination.repository === binding.repository)) {
    fail('The current exact phase operation must independently authorize GitHub readback for this repository.');
  }
  const originalAuthority = workflowOriginAuthority(input, origin.phaseId);
  const { phase } = originalAuthority;
  const plan = originalAuthority.planFor(origin.planDigest, origin.savedPlanDigest);
  const operations = plan.operations.filter((operation) => canonicalSha256(operation) === origin.operationDigest);
  const operation = operations[0];
  if (operations.length !== 1 || !operation || operation.phaseId !== origin.phaseId || operation.adapter !== 'github' ||
    operation.mutationClass !== 'github-workflow-dispatch' || operation.destination.repository !== binding.repository ||
    operation.actionId !== request.operation.actionId) fail('The original exact approved workflow operation is missing or belongs to another effect.');
  const requestedReads = reader.inputs.failedWorkflowArtifacts;
  const ownProducer = reader.phaseId === origin.phaseId && canonicalSha256(reader) === canonicalSha256(operation);
  if (!ownProducer && (!Array.isArray(requestedReads) || !requestedReads.length || requestedReads.length > 32 ||
    requestedReads.filter((entry) => canonicalSha256(entry) === canonicalSha256(request)).length !== 1)) {
    fail('A different consuming phase must approve this exact failedWorkflowArtifacts descriptor under its own current GitHub-read operation.');
  }
  const readInput = { ...input, phase, plan };
  let publication: WorkflowPublicationPlan | undefined;
  let dispatchInputs: Record<string, unknown> | undefined;
  if (origin.kind === 'workflow-dispatch') {
    if (binding.event !== 'workflow_dispatch' || canonicalSha256(operation.inputs.workflow ?? null) !== canonicalSha256(binding)) {
      fail('The immutable workflow differs from the actual original dispatch inputs.');
    }
    dispatchInputs = object(operation.inputs.dispatchInputs);
    if (Object.keys(dispatchInputs).length > 24 || Object.hasOwn(dispatchInputs, 'liftoff_operation_id') ||
      Object.values(dispatchInputs).some((value) => typeof value !== 'string')) fail('The original dispatch dictionary is not the bounded shared-dispatch recipe.');
  } else {
    if (binding.event !== 'pull_request' || !['repository-checks-qualified', 'green-red-proof'].includes(origin.phaseId)) {
      fail('Original fixture custody belongs only to its exact PR-triggered source qualification phase.');
    }
    const fixtures = records(operation.inputs.fixtures, 12).filter((fixture) => canonicalSha256(fixture) === origin.fixtureDigest);
    if (fixtures.length !== 1) fail('The exact original negative fixture is missing from its issued operation.');
    publication = fixtures[0] as unknown as WorkflowPublicationPlan;
    validateWorkflowPublicationPlan(publication);
    const selections = records(operation.inputs.fixtureBindings, 12).filter((selection) => selection.featureBranch === publication!.featureBranch);
    const selection = selections[0];
    if (selections.length !== 1 || !selection || selection.polarity !== 'negative' || !isProtectedRefFamily(selection.refFamily) ||
      !matchesProtectedRefFamily(publication.targetBranch, selection.refFamily) ||
      publication.recipe !== 'gitflow-source-check-fixture.v1' && publication.recipe !== 'gitflow-node-test-fixture.v1' ||
      publication.repository !== binding.repository || publication.repositoryId !== binding.repositoryId ||
      publication.actorId !== binding.actorId || publication.featureBranch !== binding.ref || publication.commitSha !== binding.sourceSha ||
      operation.inputs.repository !== binding.repository || operation.inputs.repositoryId !== binding.repositoryId ||
      operation.inputs.actorId !== binding.actorId || operation.inputs.sourceSha !== binding.producerSourceSha) {
      fail('The retained workflow is not the exact original negative fixture, repository, actor or source/ref family.');
    }
    const checks = records(operation.inputs.requiredChecks, 32).filter((check) =>
      check.workflowId === binding.workflowId && Array.isArray(check.refFamilies) && check.refFamilies.includes(selection.refFamily));
    if (!checks.length || checks.some((check) => check.workflowPath !== binding.workflowPath ||
      check.workflowDigest !== binding.workflowDigest || check.producerSourceSha !== binding.producerSourceSha) ||
      canonicalSha256(checks.map((check) => check.context)) !== canonicalSha256(binding.expectedJobs) ||
      !checks.some((check) => check.jobId === request.job.jobKey && check.context === request.job.name &&
        check.validationStep === request.job.validationStep)) fail('The original negative fixture workflow/job/validation inventory differs.');
    const configured = records(plan.configuration?.phases[origin.phaseId]?.fixtures, 6).filter((fixture) => fixture.refFamily === selection.refFamily);
    if (configured.length !== 1 || configured[0]!.negativeBranch !== publication.featureBranch ||
      configured[0]!.targetBranch !== publication.targetBranch || configured[0]!.baseSha !== publication.baseSha ||
      configured[0]!.commitTime !== publication.commitTime) fail('The original fixture publication differs from its reviewed public configuration.');
  }
  const checkpoints = await readWorkflowEffect(readInput, operation, {
    repositoryId: binding.repositoryId, ref: `${binding.ref}:${binding.workflowId}`,
    purpose: publication ? 'check-fixture' : 'workflow-dispatch', step: 'dispatch'
  }, publication ? { binding, fixtureDigest: canonicalSha256(publication) } : { workflow: binding, dispatchInputs });
  if (!checkpoints?.observed || checkpoints.prepared.planDigest !== plan.planDigest ||
    checkpoints.prepared.approvalEnvelopeHash !== plan.approval.envelopeHash ||
    checkpoints.observed.providerId !== request.operation.operationId || checkpoints.observed.resourceId !== request.operation.resourceId ||
    checkpoints.prepared.preparedAt !== request.operation.startedAt ||
    timestamp(checkpoints.observed.recordedAt) > timestamp(request.operation.observedAt) ||
    timestamp(request.operation.observedAt) > (input.clock?.() ?? input.now).getTime()) {
    fail('The failed run lacks its exact original private pre-effect/observed provider record, plan, approval or clock.');
  }
  const interval = await originalAuthority.admitAt(plan, checkpoints.prepared.preparedAt);
  if (publication && origin.kind === 'check-fixture') {
    await originalAuthority.readPublication(plan, operation, publication, origin.pullRequestNumber, checkpoints.prepared.preparedAt);
  }
  await assertGitHubPhaseAuthority(input, reader);
  return { plan, operation, checkpoints, ...interval, ...(publication ? { publication } : {}) };
}
