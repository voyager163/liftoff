import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { runnerPreflightSecretName, type ExternalOperationState, type TransitionOperation } from '../../domain/governance/activation/types.js';
import { GitHubActivationError } from '../github/activation-rest.js';
import { githubProviderRequestId } from './credential-checkpoints.js';
import { validateGitHubCredentialTarget, type CredentialEnrollmentResult, type GitHubCredentialTarget } from './github-enrollment.js';
import {
  credentialUsageActionId, credentialUsageWorkflowPath, credentialWorkflowRunBinding, parseCredentialUsageChallenge,
  type CredentialUsageChallenge, type CredentialUsageProof, type CredentialArtifactReference
} from './credential-usage-challenge.js';
import { credentialArtifactName } from './credential-usage-report.js';
import { credentialPermissionBoundary } from './credential-permissions.js';
import type { PhaseAdapterOutcome, PhaseReviewRequest } from '../../governance-activation/transition-ports.js';
import { WorkflowDispatchReadbackPendingError } from '../github/production-checks.js';
import type { WorkflowEffectCheckpoints } from '../../application/repository-governance/workflow-checkpoints.js';

export interface CredentialStageReview extends PhaseReviewRequest {
  schemaVersion: 1;
  kind: 'credential-usage' | 'credential-enrollment';
  phaseId: 'credential-ready';
  sourcePlanDigest: string;
  payload: Record<string, unknown>;
}

function invalid(): never {
  throw new GitHubActivationError('credential-stage-review', 'A credential review handoff requires an actual fully settled stage and exact public next-stage bindings; no running or invented result can supply it.');
}

function digest(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) invalid();
  return value;
}

export function credentialUsageFinalizationReview(
  sourcePlanDigest: string, target: GitHubCredentialTarget, challenge: CredentialUsageChallenge,
  operation: ExternalOperationState, proof: CredentialUsageProof
): CredentialStageReview {
  const selected = validateGitHubCredentialTarget(target);
  const run = parseCredentialUsageChallenge(challenge);
  const { runId: _runId, ...selection } = run;
  const workflow = credentialWorkflowRunBinding(selected, selection);
  if (selected.configuration.kind !== 'github-app' || selected.source === 'protected-input' ||
    operation.provider !== 'github' || operation.actionId !== credentialUsageActionId || operation.status !== 'completed' ||
    operation.operationId !== String(run.runId) || operation.resourceId !== `/repos/${selected.repository}/actions/runs/${run.runId}` ||
    !operation.planDigest || proof.kind !== 'github-stored-credential-use.v1' || proof.credentialKind !== 'github-app' ||
    proof.repository !== selected.repository || proof.repositoryId !== selected.repositoryId ||
    canonicalSha256(proof.principal) !== canonicalSha256(selected.principal) ||
    proof.protectedReference !== selected.protectedReference || proof.custodyVersion !== selected.custodyVersion ||
    proof.runId !== run.runId || proof.runAttempt !== run.runAttempt || proof.challengeId !== run.challengeId ||
    proof.sourceSha !== run.sourceSha || proof.workflowId !== run.workflowId || proof.ref !== run.ref || proof.actorId !== run.actorId ||
    proof.workflowPath !== credentialUsageWorkflowPath || proof.workflowDigest !== workflow.workflowDigest ||
    proof.permissionsDigest !== selected.metadata.permissionsDigest ||
    !Number.isSafeInteger(proof.artifact.id) || proof.artifact.id < 1 ||
    proof.artifact.name !== credentialArtifactName(run.challengeId, run.runAttempt) ||
    !/^sha256:[a-f0-9]{64}$/u.test(proof.artifact.zipDigest)) invalid();
  const artifact: CredentialArtifactReference = {
    id: proof.artifact.id, name: proof.artifact.name, zipDigest: proof.artifact.zipDigest,
    reportDigest: digest(proof.artifact.reportDigest)
  };
  return {
    schemaVersion: 1, kind: 'credential-usage', phaseId: 'credential-ready',
    sourcePlanDigest: digest(sourcePlanDigest),
    payload: {
      nextStage: 'verify',
      nextPhaseInputs: {
        mode: 'verify', credential: selected.configuration, principal: selected.principal, source: selected.source,
        protectedReference: selected.protectedReference, custodyVersion: selected.custodyVersion,
        policyAction: 'verify', challenge: run
      },
      originalDispatchPlanDigest: digest(operation.planDigest),
      originalOperationId: operation.operationId, originalOperationResourceId: operation.resourceId,
      artifact, workflowDigest: digest(proof.workflowDigest),
      permissionsDigest: digest(proof.permissionsDigest),
      permissionBoundary: credentialPermissionBoundary(selected.metadata.observedPermissions)
    }
  };
}

export function credentialEnrollmentChallengeReview(
  sourcePlanDigest: string, operation: TransitionOperation, result: CredentialEnrollmentResult
): CredentialStageReview {
  const target = validateGitHubCredentialTarget(result.target);
  if (operation.actionId !== 'github.credential.enroll-masked' || operation.phaseId !== 'credential-ready' ||
    operation.adapter !== 'github' || operation.mutationClass !== 'github-secret-write' || !operation.remote || operation.destructive ||
    operation.destination.repository !== target.repository || result.receipt.status !== 201 || result.receipt.providerVersion !== null ||
    result.receipt.providerRequestId === result.prepared.correlationId ||
    result.usage !== 'not-yet-proven' || result.prepared.target.repositoryId !== target.repositoryId ||
    result.prepared.target.repository !== target.repository || result.prepared.target.secretName !== runnerPreflightSecretName ||
    result.prepared.operationDigest !== canonicalSha256(operation)) invalid();
  return {
    schemaVersion: 1, kind: 'credential-enrollment', phaseId: 'credential-ready',
    sourcePlanDigest: digest(sourcePlanDigest),
    payload: {
      nextStage: 'challenge', enrollmentTarget: target,
      enrollmentReceipt: {
        provider: 'github', status: result.receipt.status, providerRequestId: githubProviderRequestId(result.receipt.providerRequestId),
        providerVersion: null, resourceId: `/repos/${target.repository}/actions/secrets/${runnerPreflightSecretName}`
      },
      preparedPlanDigest: digest(result.prepared.planDigest), preparedOperationDigest: digest(result.prepared.operationDigest),
      requiredNextStageInputs: [
        'Explicit existing stored-material representation',
        'Independently published exact workflow/source/ref and actual workflow ID',
        'Current actor, challenge identity and reviewed bounded time window'
      ]
    }
  };
}

export function credentialUsageStageReviewOutcome(
  sourcePlanDigest: string, operation: TransitionOperation, target: GitHubCredentialTarget,
  challenge: CredentialUsageChallenge, providerOperation: ExternalOperationState, proof: CredentialUsageProof
): PhaseAdapterOutcome {
  if (operation.actionId !== credentialUsageActionId || operation.phaseId !== 'credential-ready' ||
    operation.adapter !== 'github' || operation.mutationClass !== 'github-workflow-dispatch' || !operation.remote || operation.destructive ||
    operation.destination.repository !== target.repository) invalid();
  return {
    status: 'review-required', operation: providerOperation, completedOperations: [operation],
    review: credentialUsageFinalizationReview(sourcePlanDigest, target, challenge, providerOperation, proof),
    blocker: 'Stored credential usage is verified; a separate exact policy-finalization review is required.',
    cleanupWarnings: ['No policy was changed by dispatch. Original operation, private approval and verified artifact references are retained.']
  };
}

export function credentialEnrollmentStageReviewOutcome(
  sourcePlanDigest: string, operation: TransitionOperation, result: CredentialEnrollmentResult, observedAt: Date
): PhaseAdapterOutcome {
  const review = credentialEnrollmentChallengeReview(sourcePlanDigest, operation, result);
  if (!Number.isFinite(observedAt.getTime()) || !Number.isFinite(Date.parse(result.prepared.preparedAt)) ||
    observedAt.getTime() < Date.parse(result.prepared.preparedAt)) invalid();
  return {
    status: 'review-required', completedOperations: [operation], review,
    operation: {
      provider: 'github', actionId: operation.actionId, operationId: result.receipt.providerRequestId,
      resourceId: `/repos/${result.target.repository}/actions/secrets/${runnerPreflightSecretName}`,
      startedAt: result.prepared.preparedAt, observedAt: observedAt.toISOString(), status: 'completed',
      planDigest: result.prepared.planDigest
    },
    blocker: 'Enrollment was recorded, not usage; a separate exact published-source challenge review is required.',
    cleanupWarnings: ['The original policy remains unchanged. No credential value or secret hash is in the review.']
  };
}

function assertCredentialOperationHandle(operation: TransitionOperation, providerOperation: ExternalOperationState): void {
  if (operation.phaseId !== 'credential-ready' || operation.actionId !== credentialUsageActionId ||
    operation.adapter !== 'github' || operation.mutationClass !== 'github-workflow-dispatch' ||
    !operation.remote || operation.destructive || providerOperation.provider !== 'github' ||
    providerOperation.actionId !== operation.actionId || !/^[1-9][0-9]*$/u.test(providerOperation.operationId) ||
    !Number.isSafeInteger(Number(providerOperation.operationId)) ||
    providerOperation.resourceId !== `/repos/${operation.destination.repository}/actions/runs/${providerOperation.operationId}` ||
    !providerOperation.planDigest) invalid();
  digest(providerOperation.planDigest);
}

export function credentialRunReadbackPendingOutcome(
  operation: TransitionOperation, providerOperation: ExternalOperationState,
  correlationId: string, checkpoint: WorkflowEffectCheckpoints | null
): PhaseAdapterOutcome {
  assertCredentialOperationHandle(operation, providerOperation);
  const recorded = checkpoint?.observed ?? (checkpoint?.response?.status === 200 ? checkpoint.response : null);
  if (providerOperation.status !== 'running' || !checkpoint || !recorded ||
    recorded.providerId !== providerOperation.operationId || recorded.resourceId !== providerOperation.resourceId ||
    recorded.preparedDigest !== canonicalSha256(checkpoint.prepared) ||
    checkpoint.prepared.correlationId !== correlationId ||
    checkpoint.prepared.operationDigest !== canonicalSha256(operation) ||
    checkpoint.prepared.payloadDigest !== canonicalSha256({ workflow: operation.inputs.workflow, dispatchInputs: operation.inputs.dispatchInputs }) ||
    checkpoint.prepared.planDigest !== providerOperation.planDigest ||
    checkpoint.prepared.preparedAt !== providerOperation.startedAt) {
    throw new GitHubActivationError('credential-dispatch-record', 'Unavailable run readback requires the exact retained provider response/operation; no response-only identity is usage proof.');
  }
  return {
    status: 'pending', operation: providerOperation, completedOperations: [operation],
    blocker: 'The actual recorded credential run/attempt is not yet readable. Resume bounded readback of this provider ID; do not redispatch.',
    cleanupWarnings: ['No observed-run, artifact, credential-use or policy-completion proof was created from the response-only handle.']
  };
}

export function credentialTerminalReadbackBlockedOutcome(
  operation: TransitionOperation, error: WorkflowDispatchReadbackPendingError
): PhaseAdapterOutcome {
  assertCredentialOperationHandle(operation, error.operation);
  if (!['completed', 'failed'].includes(error.operation.status)) invalid();
  return {
    status: 'blocked', operation: error.operation, completedOperations: [operation],
    blocker: 'The credential run has a retained terminal state but its exact current readback is unavailable. Preserve the actual handle and recover by readback; do not fabricate running state or redispatch.',
    cleanupWarnings: ['Terminal provider state is retained, but no credential-use artifact or policy-finalization review was inferred.']
  };
}
