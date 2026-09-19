import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import {
  approvalRequestForSavedPlan, canonicalApprovalEnvelopeHash, evaluateApprovalForTransitionPlan
} from '../../domain/governance/activation/approvals.js';
import { canonicalPhaseGraph } from '../../domain/governance/activation/graph.js';
import type { PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { assertGovernanceApprovalIssued } from '../../governance-activation/authority-records.js';
import { githubPorts } from '../../governance-activation/github-ports.js';
import { sourceSha } from '../../governance-activation/github-config.js';
import { bindGovernanceTransitionContext } from '../../governance-activation/transition-context.js';
import { applicationImageDigest, parseApplicationImageReference } from '../../adapters/azure/application-provisioning.js';
import { object, type GitHubActivationClient } from '../../adapters/github/activation-rest.js';
import {
  providerQualificationTimestamp, qualificationExecutionWindow, qualificationFailure, qualificationObject, qualificationTimestamp,
  requireEnvironmentActivationScope
} from './qualification-authority.js';
import { requireQualificationEvidence, type QualificationEvidenceReference } from './qualification-evidence.js';
import { readQualificationCheckpoints, qualificationOperationFromCheckpoint } from './qualification-checkpoints.js';
import { environmentRuntimeInputs, environmentRuntimeReadbackOperation } from './environment-runtime-inputs.js';
import { environmentRuntimeAssignmentObservation } from './environment-runtime-assignment.js';
import {
  environmentRuntimeArtifactDescriptor, readEnvironmentRuntimeArtifact, type EnvironmentRuntimeArtifactReadback
} from './environment-runtime-artifact.js';
import {
  environmentRuntimeWitnessBinding, environmentRuntimeWitnessDescriptor, readEnvironmentRuntimeWitness,
  type EnvironmentRuntimeReadbackWitness
} from './environment-runtime-witness.js';

export interface EnvironmentRuntimeReceiptRequest {
  phaseId: 'dev-proof' | 'staging-qualified' | 'production-rehearsed';
  reference: QualificationEvidenceReference;
  /** Verifier identities only; this runtime fragment does not qualify application build source. */
  verifierSource: { producerSourceSha: string; executionSourceSha: string };
  artifactDigest: string;
}

export interface EnvironmentRuntimeReceiptReadback extends EnvironmentRuntimeArtifactReadback {
  nativeWitness: EnvironmentRuntimeReadbackWitness;
}

/** Admits only the runtime fragment. It never grants full native qualification or hold removal. */
export async function readEnvironmentRuntimeReceipt(
  input: PhasePlanningInput, client: GitHubActivationClient, requested: EnvironmentRuntimeReceiptRequest
): Promise<EnvironmentRuntimeReceiptReadback> {
  requireEnvironmentActivationScope(input);
  input = { ...input, adapters: bindGovernanceTransitionContext({ adapters: input.adapters }).adapters };
  qualificationObject(requested, ['phaseId', 'reference', 'verifierSource', 'artifactDigest'], 'Original runtime receipt request');
  const request = structuredClone(requested);
  if (request.phaseId !== 'dev-proof' && request.phaseId !== 'staging-qualified' && request.phaseId !== 'production-rehearsed') {
    qualificationFailure('environment-receipt-scope', 'Only an original activation environment receipt can supply this runtime fragment; repository checks and green/red fixtures are not substitutes.');
  }
  const verifierSource = qualificationObject(request.verifierSource, ['producerSourceSha', 'executionSourceSha'], 'Explicit runtime verifier source identities');
  const expectedProducerSource = sourceSha(verifierSource.producerSourceSha);
  const expectedExecutionSource = sourceSha(verifierSource.executionSourceSha);
  const expectedArtifact = applicationImageDigest(request.artifactDigest);
  const { record, plan } = requireQualificationEvidence(input.inspection, request.phaseId, request.reference, input.now);
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === request.phaseId);
  if (!phase) qualificationFailure('environment-receipt-phase', 'The original runtime phase is absent from the current registered graph.');
  const action = request.phaseId === 'dev-proof' ? 'github.checks.dev-proof' :
    request.phaseId === 'staging-qualified' ? 'github.checks.staging' : 'github.checks.production-rehearsal';
  const operations = plan.operations.filter((entry) => entry.actionId === action);
  const dispatch = operations[0];
  if (operations.length !== 1 || !dispatch) qualificationFailure('environment-receipt-plan', 'The original plan must contain one exact registered environment workflow operation.');
  const config = environmentRuntimeInputs(dispatch.inputs);
  const readback = environmentRuntimeReadbackOperation(plan, config);
  const environment = request.phaseId === 'dev-proof' ? 'dev' : request.phaseId === 'staging-qualified' ? 'staging' : 'prod';
  const workload = input.inspection.manifest.project.workload;
  const payload = object(record.payload, 'Original environment receipt body');
  const observation = object(payload.runtimeObservation, 'Original runtime observation fragment');
  if (workload.kind === 'components' || !workload.environments.includes(environment) ||
    config.disposableTarget.target.environment !== environment || config.workflow.sourceSha !== expectedExecutionSource ||
    config.workflow.producerSourceSha !== expectedProducerSource ||
    parseApplicationImageReference(config.runtime.imageRef).digest !== expectedArtifact ||
    canonicalSha256(plan.configuration?.phases[phase.id]?.disposableTarget ?? null) !== canonicalSha256(config.disposableTarget) ||
    payload.artifactDigest !== expectedArtifact ||
    observation.kind !== 'environment-runtime-observation.v1' || observation.executionSourceSha !== expectedExecutionSource ||
    observation.artifactDigest !== expectedArtifact || observation.imageRef !== config.runtime.imageRef ||
    canonicalSha256(observation.workflow ?? null) !== canonicalSha256(config.workflow)) {
    qualificationFailure('environment-receipt-binding', 'The original body must bind the same declared environment, immutable source, application artifact and exact approved workflow operation.');
  }
  const envelopes = input.inspection.approvals.filter((entry) => entry.id === plan.approval.envelopeId);
  const envelope = envelopes[0];
  if (envelopes.length !== 1 || !envelope || canonicalApprovalEnvelopeHash(envelope) !== plan.approval.envelopeHash) {
    qualificationFailure('environment-receipt-approval', 'The unique original producer approval is missing or changed.');
  }
  await assertGovernanceApprovalIssued(input.inspection.projectRoot, envelope, githubPorts(input).storage);
  // Original plan/phase are read data only; the current clock and reader authority are not replaced.
  const records = await readQualificationCheckpoints({
    inspection: input.inspection, phase, plan, runner: input.runner, adapters: input.adapters ?? {}, now: input.now
  }, dispatch, config.workflow, config.dispatchInputs);
  if (!records?.observed) qualificationFailure('environment-receipt-checkpoint', 'The exact original private pre-effect and observed provider-operation records are required; body metadata cannot manufacture them.');
  const preparedAt = new Date(records.prepared.preparedAt);
  const approval = evaluateApprovalForTransitionPlan(
    approvalRequestForSavedPlan(plan, phase, input.inspection.state), [envelope], { now: preparedAt }
  );
  const target = config.disposableTarget;
  const executionWindow = qualificationExecutionWindow(target, plan, envelope);
  const effects = plan.operations.flatMap((operation) => [operation, ...(operation.effects ?? [])]).filter((operation) => operation.remote);
  const mutations = [...new Set(effects.map((effect) => effect.mutationClass))].sort();
  const expectedAuthority = {
    ...target, executionWindow,
    approval: {
      envelopeId: envelope.id, envelopeHash: canonicalApprovalEnvelopeHash(envelope), approvedAt: envelope.approvedAt,
      planDigest: plan.planDigest, savedPlanDigest: canonicalSha256(plan)
    }
  };
  if (approval.approvalRequired || approval.envelopeId !== plan.approval.envelopeId ||
    approval.envelopeHash !== plan.approval.envelopeHash ||
    target.actor.operator !== envelope.approver || config.workflow.actorId !== target.actor.githubActorId ||
    canonicalSha256([...target.permittedEffects].sort()) !== canonicalSha256(mutations) ||
    mutations.some((effect) => !envelope.permissions.includes(effect)) ||
    !envelope.resources.some((resource) => resource.identity === target.target.resourceId) ||
    !effects.some((effect) => effect.destination.identity === target.target.resourceId &&
      effect.destination.subscriptionId === target.target.subscriptionId) ||
    preparedAt.getTime() < Date.parse(executionWindow.notBefore) || preparedAt.getTime() >= Date.parse(executionWindow.expiresAt) ||
    canonicalSha256(observation.authority ?? null) !== canonicalSha256(expectedAuthority) ||
    observation.checkpointDigest !== canonicalSha256(records.prepared)) {
    qualificationFailure('environment-receipt-approval', 'The recorded effect does not match its genuine original actor/resource/effect/spend/time authority and private checkpoint.');
  }
  const operation = qualificationOperationFromCheckpoint(records, dispatch, config.workflow, records.observed.recordedAt);
  if (!operation) qualificationFailure('environment-receipt-operation', 'The retained checkpoint has no actual provider operation ID.');
  const savedOperation = qualificationObject(observation.operation, [
    'provider', 'actionId', 'operationId', 'resourceId', 'startedAt', 'observedAt', 'status', 'planDigest'
  ], 'Original runtime operation');
  const savedObservedAt = qualificationTimestamp(savedOperation.observedAt, 'Original runtime operation observation');
  if (savedOperation.provider !== operation.provider || savedOperation.actionId !== operation.actionId ||
    savedOperation.operationId !== operation.operationId || savedOperation.resourceId !== operation.resourceId ||
    savedOperation.startedAt !== operation.startedAt || savedOperation.planDigest !== operation.planDigest ||
    savedOperation.status !== 'completed' || Date.parse(savedObservedAt) < Date.parse(records.observed.recordedAt) ||
    Date.parse(savedObservedAt) > Date.parse(record.header.producedAt)) {
    qualificationFailure('environment-receipt-operation', 'The original body does not preserve its actual recorded provider ID, plan and clock.');
  }
  const result = await readEnvironmentRuntimeArtifact(client, {
    inputs: config, operation, correlationId: records.prepared.correlationId
  }, environmentRuntimeArtifactDescriptor(observation.reportArtifact), input.now);
  if (Date.parse(result.run.createdAt) < Date.parse(executionWindow.notBefore) ||
    Date.parse(result.job.startedAt) < Date.parse(executionWindow.notBefore) ||
    Date.parse(result.job.completedAt) >= Date.parse(executionWindow.expiresAt) ||
    Date.parse(result.report.observedAt) >= Date.parse(executionWindow.expiresAt)) {
    qualificationFailure('environment-receipt-clock', 'The actual runtime effect or report is outside the effective original issued execution interval.');
  }
  const workflowEvidence = qualificationObject(observation.workflowEvidence, ['job', 'run', 'verifierSource', 'runner'], 'Original workflow evidence');
  const savedRun = qualificationObject(workflowEvidence.run, ['runId', 'runAttempt', 'createdAt', 'updatedAt'], 'Original provider run observation');
  const savedUpdatedAt = providerQualificationTimestamp(savedRun.updatedAt, 'Original provider run update');
  if (!isRecord(workflowEvidence.job) || canonicalSha256(workflowEvidence.job) !== canonicalSha256(result.job) ||
    savedRun.runId !== result.run.runId || savedRun.runAttempt !== result.run.runAttempt ||
    savedRun.createdAt !== result.run.createdAt ||
    Date.parse(savedUpdatedAt) < Date.parse(result.job.completedAt) ||
    Date.parse(savedUpdatedAt) > Date.parse(record.header.producedAt) ||
    Date.parse(result.job.completedAt) > Date.parse(record.header.producedAt) ||
    canonicalSha256(observation.report ?? null) !== canonicalSha256(result.report) ||
    canonicalSha256(workflowEvidence.runner) !== canonicalSha256(result.runner) ||
    canonicalSha256(workflowEvidence.verifierSource) !== canonicalSha256(result.verifierSource)) {
    qualificationFailure('environment-receipt-report', 'Original body/header commitments do not match the actual report bytes and same-attempt provider job/check/step/verifier-source/blob identities.');
  }
  const { nativeWitness: witnessReference, ...recordedObservation } = observation;
  const witness = await readEnvironmentRuntimeWitness(input, environmentRuntimeWitnessDescriptor(witnessReference), {
    binding: environmentRuntimeWitnessBinding({
      plan, authority: expectedAuthority, dispatch, readback, checkpoint: records.prepared, config, artifact: result,
      assignmentObservation: environmentRuntimeAssignmentObservation(observation.assignmentObservation, config)
    }),
    checkpoint: records.prepared, observation: recordedObservation, producedAt: record.header.producedAt
  });
  return { ...result, nativeWitness: witness };
}
