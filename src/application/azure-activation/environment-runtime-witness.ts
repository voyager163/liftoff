import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { applicationUuid, CONTAINER_APP_API_VERSION, parseApplicationImageReference } from '../../adapters/azure/application-provisioning.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { SavedTransitionPlan, TransitionOperation } from '../../domain/governance/activation/types.js';
import type { PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import type { WorkflowPreparedCheckpoint } from '../repository-governance/workflow-checkpoints.js';
import {
  qualificationFailure, qualificationObject, qualificationText, qualificationTimestamp,
  type DisposableQualificationAuthority
} from './qualification-authority.js';
import { qualificationDigest } from './qualification-evidence.js';
import type { EnvironmentRuntimeInputs } from './environment-runtime-inputs.js';
import type { EnvironmentRuntimeArtifactReadback, EnvironmentRuntimeArtifactDescriptor, EnvironmentRuntimeVerifierSource } from './environment-runtime-artifact.js';
import type { EnvironmentRuntimeJobRunner } from './environment-runtime-workflow.js';
import { environmentRuntimeAssignmentObservation } from './environment-runtime-assignment.js';
import type { PrivateRunnerAssignmentObservation } from './private-runner-assignment.js';

export interface EnvironmentRuntimeResourceObservation {
  resourceId: string;
  revisionResourceId: string;
  revisionName: string;
  imageRef: string;
  fqdn: string;
  appRequestId: string;
  revisionRequestId: string;
  trafficWeight: 100;
  provisioningState: 'Succeeded';
  revisionProvisioningState: 'Provisioned';
  revisionHealthState: 'Healthy';
  revisionRunningState: 'Running';
  revisionActive: true;
  observedAt: string;
}

export interface EnvironmentRuntimeResponseWitness {
  resourceId: string;
  method: 'GET';
  apiVersion: typeof CONTAINER_APP_API_VERSION;
  requestId: string;
  responseBodyDigest: string;
  observedAt: string;
}

export interface EnvironmentRuntimeWitnessBinding {
  phaseId: 'dev-proof' | 'staging-qualified' | 'production-rehearsed';
  authority: DisposableQualificationAuthority;
  dispatchOperationDigest: string;
  readbackOperationDigest: string;
  checkpointDigest: string;
  workflow: EnvironmentRuntimeInputs['workflow'];
  verifierSource: EnvironmentRuntimeVerifierSource;
  runner: EnvironmentRuntimeJobRunner;
  runnerAssignment: EnvironmentRuntimeInputs['runnerAssignment'];
  assignmentObservationDigest: string;
  runId: number;
  runAttempt: number;
  jobId: number;
  checkRunId: number;
  jobCompletedAt: string;
  workflowEvidenceDigest: string;
  reportArtifact: EnvironmentRuntimeArtifactDescriptor;
  imageRef: string;
  applicationArtifactDigest: string;
  revisionName: string;
  fqdn: string;
}

export interface EnvironmentRuntimeReadbackWitness {
  schemaVersion: 1;
  kind: 'environment-runtime-readback-witness.v1';
  projectRoot: string;
  projectIdentity: WorkflowPreparedCheckpoint['projectIdentity'];
  activationIdentityDigest: string;
  binding: EnvironmentRuntimeWitnessBinding;
  observationDigest: string;
  assignmentObservation: PrivateRunnerAssignmentObservation;
  responses: { app: EnvironmentRuntimeResponseWitness; revision: EnvironmentRuntimeResponseWitness };
  resource: EnvironmentRuntimeResourceObservation;
  recordedAt: string;
}

export interface EnvironmentRuntimeWitnessDescriptor {
  recordKey: string;
  witnessDigest: string;
}

export interface EnvironmentRuntimeWitnessContext {
  binding: EnvironmentRuntimeWitnessBinding;
  checkpoint: WorkflowPreparedCheckpoint;
  observation: unknown;
  producedAt: string;
}

export function environmentRuntimeWitnessBinding(input: {
  plan: SavedTransitionPlan;
  authority: DisposableQualificationAuthority;
  dispatch: TransitionOperation;
  readback: TransitionOperation;
  checkpoint: WorkflowPreparedCheckpoint;
  config: EnvironmentRuntimeInputs;
  artifact: EnvironmentRuntimeArtifactReadback;
  assignmentObservation: PrivateRunnerAssignmentObservation;
}): EnvironmentRuntimeWitnessBinding {
  const { plan, authority, dispatch, readback, checkpoint, config, artifact, assignmentObservation } = input;
  if (plan.phaseId !== 'dev-proof' && plan.phaseId !== 'staging-qualified' && plan.phaseId !== 'production-rehearsed' ||
    authority.approval.planDigest !== plan.planDigest || authority.approval.savedPlanDigest !== canonicalSha256(plan) ||
    checkpoint.planDigest !== plan.planDigest || checkpoint.approvalEnvelopeHash !== authority.approval.envelopeHash ||
    checkpoint.operationDigest !== canonicalSha256(dispatch) || dispatch.phaseId !== plan.phaseId ||
    readback.phaseId !== plan.phaseId || config.workflow.sourceSha !== artifact.report.source.commitSha ||
    artifact.report.producer.runId !== artifact.run.runId || artifact.report.producer.jobId !== artifact.job.id) {
    qualificationFailure('environment-witness-binding', 'A runtime witness requires the exact admitted original phase, issued plan, dispatch checkpoint and actual source-bound report.');
  }
  return {
    phaseId: plan.phaseId, authority: structuredClone(authority),
    dispatchOperationDigest: canonicalSha256(dispatch), readbackOperationDigest: canonicalSha256(readback),
    checkpointDigest: canonicalSha256(checkpoint), workflow: structuredClone(config.workflow),
    verifierSource: structuredClone(artifact.verifierSource),
    runner: structuredClone(artifact.runner),
    runnerAssignment: structuredClone(config.runnerAssignment),
    assignmentObservationDigest: canonicalSha256(environmentRuntimeAssignmentObservation(assignmentObservation, config)),
    runId: artifact.run.runId, runAttempt: artifact.run.runAttempt, jobId: artifact.job.id, checkRunId: artifact.job.checkRunId,
    jobCompletedAt: artifact.job.completedAt,
    workflowEvidenceDigest: canonicalSha256({
      job: artifact.job, runId: artifact.run.runId, runAttempt: artifact.run.runAttempt,
      createdAt: artifact.run.createdAt, verifierSource: artifact.verifierSource, runner: artifact.runner
    }),
    reportArtifact: structuredClone(artifact.reportArtifact),
    imageRef: config.runtime.imageRef, applicationArtifactDigest: parseApplicationImageReference(config.runtime.imageRef).digest,
    revisionName: config.runtime.revisionName, fqdn: config.runtime.recipe.fqdn
  };
}

export function environmentRuntimeWitnessDescriptor(value: unknown): EnvironmentRuntimeWitnessDescriptor {
  const data = qualificationObject(value, ['recordKey', 'witnessDigest'], 'Private runtime readback witness reference');
  return {
    recordKey: qualificationDigest(data.recordKey, 'Private runtime witness key'),
    witnessDigest: qualificationDigest(data.witnessDigest, 'Private runtime witness content digest')
  };
}

export function environmentRuntimeWitnessKey(binding: EnvironmentRuntimeWitnessBinding, witnessDigest: string): string {
  return canonicalSha256({
    kind: 'environment-runtime-readback-witness-key.v1',
    planDigest: binding.authority.approval.planDigest,
    readbackOperationDigest: binding.readbackOperationDigest,
    checkpointDigest: binding.checkpointDigest,
    witnessDigest: qualificationDigest(witnessDigest, 'Private runtime witness content digest')
  });
}

function decodeResponse(
  value: unknown, resourceId: string, binding: EnvironmentRuntimeWitnessBinding, recordedAt: string
): EnvironmentRuntimeResponseWitness {
  const data = qualificationObject(value, [
    'resourceId', 'method', 'apiVersion', 'requestId', 'responseBodyDigest', 'observedAt'
  ], 'Original ARM response witness');
  const observedAt = qualificationTimestamp(data.observedAt, 'Original ARM response time');
  if (data.resourceId !== resourceId || data.method !== 'GET' || data.apiVersion !== CONTAINER_APP_API_VERSION ||
    Date.parse(observedAt) < Date.parse(binding.authority.executionWindow.notBefore) ||
    Date.parse(observedAt) < Date.parse(binding.jobCompletedAt) ||
    Date.parse(observedAt) >= Date.parse(binding.authority.executionWindow.expiresAt) ||
    Date.parse(observedAt) > Date.parse(recordedAt)) {
    qualificationFailure('environment-witness-response', 'The private witness must preserve the exact original native request, resource and approved execution interval.');
  }
  return {
    resourceId, method: 'GET', apiVersion: CONTAINER_APP_API_VERSION,
    requestId: applicationUuid(data.requestId, 'Actual witnessed provider request ID'),
    responseBodyDigest: qualificationDigest(data.responseBodyDigest, 'Actual provider response body digest'),
    observedAt
  };
}

/** Decodes an already private-read record. This function alone does not prove private issuance or record existence. */
export function decodeEnvironmentRuntimeWitness(
  value: unknown, descriptor: EnvironmentRuntimeWitnessDescriptor,
  context: EnvironmentRuntimeWitnessContext, now: Date
): EnvironmentRuntimeReadbackWitness {
  const reference = environmentRuntimeWitnessDescriptor(descriptor);
  const data = qualificationObject(value, [
    'schemaVersion', 'kind', 'projectRoot', 'projectIdentity', 'activationIdentityDigest',
    'binding', 'observationDigest', 'assignmentObservation', 'responses', 'resource', 'recordedAt'
  ], 'Immutable private runtime witness');
  const { binding, checkpoint } = context;
  const recordedAt = qualificationTimestamp(data.recordedAt, 'Original private witness time');
  const producedAt = qualificationTimestamp(context.producedAt, 'Original enclosing receipt time');
  if (data.schemaVersion !== 1 || data.kind !== 'environment-runtime-readback-witness.v1' ||
    data.projectRoot !== checkpoint.projectRoot ||
    canonicalSha256(data.projectIdentity) !== canonicalSha256(checkpoint.projectIdentity) ||
    data.activationIdentityDigest !== checkpoint.activationIdentityDigest ||
    canonicalSha256(data.binding) !== canonicalSha256(binding) ||
    data.observationDigest !== canonicalSha256(context.observation) ||
    canonicalSha256(value) !== reference.witnessDigest ||
    environmentRuntimeWitnessKey(binding, reference.witnessDigest) !== reference.recordKey ||
    !Number.isFinite(now.getTime()) || Date.parse(recordedAt) > now.getTime() ||
    Date.parse(recordedAt) > Date.parse(producedAt) || Date.parse(producedAt) > now.getTime() ||
    Date.parse(recordedAt) < Date.parse(checkpoint.preparedAt) ||
    Date.parse(recordedAt) < Date.parse(binding.authority.executionWindow.notBefore) ||
    Date.parse(recordedAt) >= Date.parse(binding.authority.executionWindow.expiresAt)) {
    qualificationFailure('environment-private-witness', 'Public receipt assertions do not match the immutable private project/plan/approval/run/artifact/principal/readback witness. Rehashing public evidence cannot mint one.');
  }
  const assignmentObservation = environmentRuntimeAssignmentObservation(data.assignmentObservation, binding);
  if (canonicalSha256(assignmentObservation) !== binding.assignmentObservationDigest ||
    Date.parse(assignmentObservation.observedAt) < Date.parse(binding.jobCompletedAt) ||
    Date.parse(assignmentObservation.observedAt) < Date.parse(binding.authority.executionWindow.notBefore) ||
    Date.parse(assignmentObservation.observedAt) >= Date.parse(binding.authority.executionWindow.expiresAt) ||
    Date.parse(assignmentObservation.observedAt) > Date.parse(recordedAt)) {
    qualificationFailure('environment-private-assignment', 'The private assignment observation must preserve its actual post-job readback inside the original effective approval window.');
  }
  const responses = qualificationObject(data.responses, ['app', 'revision'], 'Original native response inventory');
  const resourceId = binding.authority.target.resourceId;
  const revisionResourceId = `${resourceId}/revisions/${binding.revisionName}`;
  const app = decodeResponse(responses.app, resourceId, binding, recordedAt);
  const revision = decodeResponse(responses.revision, revisionResourceId, binding, recordedAt);
  const resourceData = qualificationObject(data.resource, [
    'resourceId', 'revisionResourceId', 'revisionName', 'imageRef', 'fqdn', 'appRequestId', 'revisionRequestId',
    'trafficWeight', 'provisioningState', 'revisionProvisioningState', 'revisionHealthState',
    'revisionRunningState', 'revisionActive', 'observedAt'
  ], 'Private normalized runtime observation');
  const resource: EnvironmentRuntimeResourceObservation = {
    resourceId, revisionResourceId, revisionName: binding.revisionName, imageRef: binding.imageRef, fqdn: binding.fqdn,
    appRequestId: app.requestId, revisionRequestId: revision.requestId, trafficWeight: 100,
    provisioningState: 'Succeeded', revisionProvisioningState: 'Provisioned', revisionHealthState: 'Healthy',
    revisionRunningState: 'Running', revisionActive: true,
    observedAt: qualificationTimestamp(resourceData.observedAt, 'Original normalized runtime observation time')
  };
  if (canonicalSha256(resourceData) !== canonicalSha256(resource) ||
    Date.parse(resource.observedAt) < Date.parse(app.observedAt) ||
    Date.parse(resource.observedAt) < Date.parse(revision.observedAt) ||
    Date.parse(resource.observedAt) > Date.parse(recordedAt)) {
    qualificationFailure('environment-private-resource', 'The normalized image, revision, traffic and request identities do not match the privately captured native observations.');
  }
  return {
    schemaVersion: 1, kind: 'environment-runtime-readback-witness.v1',
    projectRoot: qualificationText(data.projectRoot, 'Original project root'),
    projectIdentity: structuredClone(checkpoint.projectIdentity), activationIdentityDigest: checkpoint.activationIdentityDigest,
    binding: structuredClone(binding), observationDigest: qualificationDigest(data.observationDigest, 'Original observation digest'),
    assignmentObservation,
    responses: { app, revision }, resource, recordedAt
  };
}

/** Reads only registered private metadata; never probes ARM, dispatches, acquires leases or backfills a witness. */
export async function readEnvironmentRuntimeWitness(
  input: Pick<PhasePlanningInput, 'inspection' | 'adapters' | 'now'>,
  descriptor: EnvironmentRuntimeWitnessDescriptor, context: EnvironmentRuntimeWitnessContext
): Promise<EnvironmentRuntimeReadbackWitness> {
  const reference = environmentRuntimeWitnessDescriptor(descriptor);
  const record = await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', input.adapters?.githubActivation?.storage)
    .read(reference.recordKey);
  if (!record || record.projectRoot !== context.checkpoint.projectRoot) {
    qualificationFailure('environment-private-witness-missing', 'The original operation-specific private ARM readback witness is unavailable. Public resource/nativeQualification assertions cannot replace it.');
  }
  return decodeEnvironmentRuntimeWitness(record.value, reference, context, input.now);
}
