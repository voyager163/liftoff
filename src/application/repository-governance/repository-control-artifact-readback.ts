import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { phaseScope, type ExternalOperationState, type TransitionOperation } from '../../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { GitHubActivationError } from '../../adapters/github/activation-rest.js';
import {
  FailedWorkflowArtifactPendingError, readBoundFailedWorkflowArtifact,
  type FailedWorkflowArtifactReadback, type FailedWorkflowArtifactRequest,
  type OriginalCheckFixturePlanReference, type RepositoryChecksEvidencePayload
} from '../../adapters/github/production-checks.js';
import { validateFailedWorkflowArtifactRequest } from './workflow-run-origin.js';
import { SourceCheckArtifactPendingError } from './source-check-artifact.js';
import { assertGitHubPhaseAuthority } from './workflow-authority.js';

export interface RepositoryControlArtifactReadback {
  execution: PhaseAdapterExecutionInput;
  operation: TransitionOperation;
}

export async function assertEnforcementReadAuthority(
  input: PhasePlanningInput, readback: RepositoryControlArtifactReadback | undefined
): Promise<void> {
  if (!readback || readback.execution.inspection.projectRoot !== input.inspection.projectRoot ||
    readback.execution.inspection.scope !== input.inspection.scope || readback.execution.phase.id !== input.phase.id ||
    readback.operation.adapter !== 'github' || readback.operation.mutationClass !== 'github-read' ||
    readback.operation.remote !== true) {
    fail('Enforcement evidence requires the actual current project/scope/phase GitHub-read operation and its own privately issued authority.');
  }
  await assertGitHubPhaseAuthority(readback.execution, readback.operation);
}

function fail(message: string): never {
  throw new GitHubActivationError('control-artifact-authority', message);
}

function assertRequest(value: unknown): asserts value is FailedWorkflowArtifactRequest {
  validateFailedWorkflowArtifactRequest(value as FailedWorkflowArtifactRequest);
}

export function declaredEnforcementArtifactRequests(operation: TransitionOperation): readonly FailedWorkflowArtifactRequest[] {
  const declared = operation.inputs.failedWorkflowArtifacts;
  if (declared === undefined) return [];
  if (!Array.isArray(declared) || declared.length > 32) fail('The current artifact read inventory must be bounded and explicit.');
  const requests = declared.map((value: unknown) => {
    assertRequest(value);
    return structuredClone(value);
  });
  if (new Set(requests.map((request) => canonicalSha256(request))).size !== requests.length) {
    fail('The current artifact read inventory cannot contain repeated requests.');
  }
  return requests;
}

/** Declares future approved reads; this inventory alone is not artifact readback. */
export function repositoryCheckArtifactRequests(evidence: RepositoryChecksEvidencePayload): readonly FailedWorkflowArtifactRequest[] {
  return sourceCheckArtifactRequests(evidence, 'repository-checks-qualified');
}

export function sourceCheckArtifactRequests(
  evidence: Pick<RepositoryChecksEvidencePayload, 'repository' | 'repositoryId' | 'actorId' | 'sourceSha' | 'requiredChecks' | 'controlledNegativeChecks'>,
  phaseId: 'repository-checks-qualified' | 'green-red-proof'
): readonly FailedWorkflowArtifactRequest[] {
  const requests: FailedWorkflowArtifactRequest[] = [];
  for (const proof of evidence.controlledNegativeChecks) {
    const checks = evidence.requiredChecks.filter((check) => check.workflowId === proof.workflowId && check.jobId === proof.jobKey);
    if (checks.length !== 1) fail('Every retained failed artifact needs its unique original required workflow/job descriptor.');
    const check = checks[0]!;
    if (!check.fixtureArtifact) {
      if (proof.fixtureArtifact !== undefined) fail('An undeclared failed artifact cannot be added to the original source qualification.');
      continue;
    }
    const observed = proof.fixtureArtifact;
    if (!isRecord(observed) || !isRecord(observed.request) ||
      !/^[a-f0-9]{64}$/u.test(observed.recordKey) || !/^[a-f0-9]{64}$/u.test(observed.checkpointDigest) ||
      !/^sha256:[a-f0-9]{64}$/u.test(observed.sourceFileDigest) || !/^sha256:[a-f0-9]{64}$/u.test(observed.archiveDigest)) {
      fail('A declared failed artifact requires its original complete private-custody reference and exact byte commitments.');
    }
    const request = structuredClone(observed.request);
    validateFailedWorkflowArtifactRequest(request);
    if (request.origin.kind !== 'check-fixture' || request.origin.phaseId !== phaseId ||
      request.origin.pullRequestNumber !== proof.pullRequestNumber ||
      request.binding.repository !== evidence.repository || request.binding.repositoryId !== evidence.repositoryId ||
      request.binding.actorId !== evidence.actorId || request.binding.producerSourceSha !== evidence.sourceSha ||
      request.binding.workflowId !== check.workflowId || request.binding.workflowPath !== check.workflowPath ||
      request.binding.workflowDigest !== check.workflowDigest || request.binding.sourceSha !== proof.headSha ||
      request.binding.ref !== proof.fixtureRef || request.operation.operationId !== String(proof.runId) ||
      request.job.jobKey !== check.jobId || request.job.name !== proof.context ||
      request.job.jobId !== proof.jobId || request.job.checkRunId !== proof.checkRunId || request.job.appId !== proof.appId ||
      request.job.validationStep !== check.validationStep || request.job.uploadStep !== check.fixtureArtifact.uploadStep ||
      request.artifact.digest !== observed.archiveDigest) {
      fail('The retained artifact request differs from its original repository, fixture, workflow, actor, failed job or archive.');
    }
    requests.push(request);
  }
  if (requests.length > 32 ||
    new Set(requests.map((request) => canonicalSha256(request))).size !== requests.length ||
    new Set(requests.map((request) => `${request.binding.repositoryId}:${request.artifact.artifactId}`)).size !== requests.length) {
    fail('Failed-artifact reads require a bounded unique inventory of exact original provider artifacts.');
  }
  return requests;
}

export function originalFixtureReferences(
  requests: readonly FailedWorkflowArtifactRequest[]
): readonly OriginalCheckFixturePlanReference[] {
  const references = new Map<string, OriginalCheckFixturePlanReference>();
  for (const request of requests) {
    validateFailedWorkflowArtifactRequest(request);
    const origin = request.origin;
    if (origin.kind !== 'check-fixture') continue;
    if (origin.phaseId !== 'repository-checks-qualified' && origin.phaseId !== 'green-red-proof') {
      fail('Fixture custody can reference only an actual original source-check fixture phase.');
    }
    const reference = { phaseId: origin.phaseId, planDigest: origin.planDigest,
      savedPlanDigest: origin.savedPlanDigest, operationDigest: origin.operationDigest };
    references.set(canonicalSha256(reference), reference);
  }
  if (references.size > 8) fail('Original fixture reads require at most eight exact performed-plan references.');
  return [...references.values()];
}

export async function assertRepositoryArtifactReadback(
  input: PhasePlanningInput, readback: RepositoryControlArtifactReadback | undefined,
  requests: readonly FailedWorkflowArtifactRequest[]
): Promise<void> {
  if (!requests.length) {
    if (readback?.operation.inputs.failedWorkflowArtifacts !== undefined &&
      canonicalSha256(readback.operation.inputs.failedWorkflowArtifacts) !== canonicalSha256([])) {
      fail('The current read operation declares artifacts absent from the exact original qualification.');
    }
    return;
  }
  if (!readback || readback.execution.inspection.projectRoot !== input.inspection.projectRoot ||
    readback.execution.inspection.scope !== input.inspection.scope || readback.execution.phase.id !== input.phase.id ||
    readback.operation.adapter !== 'github' || readback.operation.mutationClass !== 'github-read' ||
    readback.operation.remote !== true ||
    !Array.isArray(readback.operation.inputs.failedWorkflowArtifacts) ||
    canonicalSha256(readback.operation.inputs.failedWorkflowArtifacts) !== canonicalSha256(requests)) {
    fail('Failed-artifact consumption requires its exact retained request inventory in the actual current GitHub-read operation, not planning or original producer authority.');
  }
  await assertEnforcementReadAuthority(input, readback);
}

/** Opaque full-origin artifact fragments only; no assertion, predecessor or full-phase qualification is granted. */
export async function readFullControlFailedArtifacts(
  input: PhasePlanningInput, readback: RepositoryControlArtifactReadback | undefined,
  requests: readonly FailedWorkflowArtifactRequest[]
): Promise<readonly FailedWorkflowArtifactReadback[]> {
  if (input.inspection.scope !== 'activation' || !['rulesets-applied', 'live-readback'].includes(input.phase.id)) {
    fail('Full failed-artifact inspection requires the actual full enforcement reader phase and scope.');
  }
  for (const request of requests) {
    validateFailedWorkflowArtifactRequest(request);
    if (phaseScope(request.origin.phaseId) !== 'activation') {
      fail('Repository fixture archives cannot supply full enforcement qualification fragments.');
    }
  }
  await assertRepositoryArtifactReadback(input, readback, requests);
  if (!requests.length) return [];
  if (!readback) fail('Full artifact reads require the actual current privately issued read operation and lease.');
  const fragments: FailedWorkflowArtifactReadback[] = [];
  for (const request of requests) {
    fragments.push(await readBoundFailedWorkflowArtifact({
      execution: readback.execution, operation: readback.operation, request
    }));
  }
  return fragments;
}

export function pendingRepositoryArtifactOperation(error: unknown): ExternalOperationState | undefined {
  if (error instanceof SourceCheckArtifactPendingError) return structuredClone(error.operation);
  if (error instanceof FailedWorkflowArtifactPendingError) return structuredClone(error.request.operation);
  return undefined;
}
