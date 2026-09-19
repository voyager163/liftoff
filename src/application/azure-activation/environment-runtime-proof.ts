import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { ExternalOperationState, TransitionOperation } from '../../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import { githubPorts } from '../../governance-activation/github-ports.js';
import { bindGovernanceTransitionContext } from '../../governance-activation/transition-context.js';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { clientFor } from '../../governance-activation/github-config.js';
import { createAzureCliArmTransport, type AzureArmBinding } from '../../adapters/azure/activation-rest.js';
import { applicationUuid, CONTAINER_APP_API_VERSION, parseApplicationImageReference } from '../../adapters/azure/application-provisioning.js';
import { GitHubActivationClient, object } from '../../adapters/github/activation-rest.js';
import type { WorkflowRunBinding } from '../../adapters/github/workflow-dispatch.js';
import { assertAzurePhaseAuthority } from './authority.js';
import {
  qualificationFailure, requireDisposableQualificationAuthority, requireEnvironmentActivationScope, type DisposableQualificationAuthority
} from './qualification-authority.js';
import { qualificationOperationFromCheckpoint, readQualificationCheckpoints } from './qualification-checkpoints.js';
import { environmentRuntimeInputs, environmentRuntimeReadbackOperation } from './environment-runtime-inputs.js';
import {
  environmentRuntimeArtifactReference, observeEnvironmentRuntimeArtifact,
  type EnvironmentRuntimeArtifactDescriptor, type EnvironmentRuntimeArtifactReadback
} from './environment-runtime-artifact.js';
import type { EnvironmentRuntimeReport } from './environment-runtime-workflow.js';
import { readEnvironmentRuntimeRunnerAssignment } from './environment-runtime-assignment.js';
import type { PrivateRunnerAssignmentObservation } from './private-runner-assignment.js';
import {
  environmentRuntimeWitnessBinding, environmentRuntimeWitnessKey, readEnvironmentRuntimeWitness,
  type EnvironmentRuntimeReadbackWitness, type EnvironmentRuntimeResourceObservation,
  type EnvironmentRuntimeResponseWitness, type EnvironmentRuntimeWitnessDescriptor
} from './environment-runtime-witness.js';

export { environmentRuntimeInputs, type EnvironmentRuntimeInputs } from './environment-runtime-inputs.js';

export interface EnvironmentRuntimeObservationBase {
  kind: 'environment-runtime-observation.v1';
  executionSourceSha: string;
  artifactDigest: string;
  imageRef: string;
  authority: DisposableQualificationAuthority;
  workflow: WorkflowRunBinding & { producerSourceSha: string };
  operation: ExternalOperationState;
  checkpointDigest: string;
  reportArtifact: EnvironmentRuntimeArtifactDescriptor;
  assignmentObservation: PrivateRunnerAssignmentObservation;
  workflowEvidence: Pick<EnvironmentRuntimeArtifactReadback, 'job' | 'run' | 'verifierSource' | 'runner'>;
  report: EnvironmentRuntimeReport;
  resource: EnvironmentRuntimeResourceObservation;
}

export interface EnvironmentRuntimeObservation extends EnvironmentRuntimeObservationBase {
  nativeWitness: EnvironmentRuntimeWitnessDescriptor;
}

/** Observes an existing runtime run and persists its private ARM witness; never DAST, build-source or rollout/rollback proof. */
export async function readEnvironmentRuntimeProof(
  input: PhaseAdapterExecutionInput, dispatch: TransitionOperation
): Promise<EnvironmentRuntimeObservation> {
  requireEnvironmentActivationScope(input);
  input = { ...input, adapters: bindGovernanceTransitionContext({ adapters: input.adapters }).adapters };
  const config = environmentRuntimeInputs(dispatch.inputs);
  const environment = config.disposableTarget.target.environment;
  const readback = environmentRuntimeReadbackOperation(input.plan, config);
  const configDigest = canonicalSha256(config);
  const beforeAccess = async () => {
    if (canonicalSha256(environmentRuntimeInputs(dispatch.inputs)) !== configDigest) {
      qualificationFailure('environment-input-drift', 'The exact runtime source, artifact, target or actor changed during observation.');
    }
    const authority = await requireDisposableQualificationAuthority(input, environment, dispatch);
    await assertAzurePhaseAuthority(input, readback);
    return authority;
  };
  let authority = await beforeAccess();
  const records = await readQualificationCheckpoints(input, dispatch, config.workflow, config.dispatchInputs);
  if (!records) qualificationFailure('environment-pre-effect', 'A runtime report cannot be adopted without the released private pre-dispatch checkpoint.');
  const operation = qualificationOperationFromCheckpoint(records, dispatch, config.workflow, (input.clock?.() ?? input.now).toISOString());
  if (!operation || records.observed?.status !== 200) {
    qualificationFailure('environment-operation-uncertain', 'The existing dispatch has no independently observed provider run ID. Retain it and recover through the shared dispatcher; never dispatch or select a latest run here.');
  }
  const base = clientFor(input);
  const client = new GitHubActivationClient({ async request(request) {
    await beforeAccess();
    return base.transport.request(request);
  } });
  const [currentActor, currentRepository] = await Promise.all([
    client.get('/user'), client.get(`/repos/${config.workflow.repository}`)
  ]);
  if (currentActor.id !== config.workflow.actorId || currentRepository.id !== config.workflow.repositoryId ||
    currentRepository.full_name !== config.workflow.repository) {
    qualificationFailure('environment-reader-principal', 'Independent runtime readback must use the exact currently approved GitHub principal and repository, not merely a run that another account can read.');
  }
  const name = `liftoff-environment-${records.prepared.correlationId}`;
  const artifacts = (await client.list(`${operation.resourceId}/artifacts`, 'artifacts')).filter((artifact) => artifact.name === name);
  if (artifacts.length !== 1) qualificationFailure('environment-artifact-identity', 'Exactly one artifact from the recorded runtime run and correlation is required; no first or latest artifact is substituted.');
  const parsed = await observeEnvironmentRuntimeArtifact(client, {
    inputs: config, operation, correlationId: records.prepared.correlationId
  }, environmentRuntimeArtifactReference({
    artifactId: artifacts[0]!.id, name, archiveDigest: artifacts[0]!.digest
  }), input.clock?.() ?? input.now);
  if (parsed.archiveBytes !== artifacts[0]!.size_in_bytes) {
    qualificationFailure('environment-artifact-size', 'The actual runtime artifact byte length differs from its exact provider inventory or exceeds the registered report archive budget.');
  }
  const assignmentObservation = await readEnvironmentRuntimeRunnerAssignment(input, dispatch);
  const target = config.disposableTarget.target;
  const binding: AzureArmBinding = {
    subscriptionId: target.subscriptionId, tenantId: target.tenantId,
    principalId: config.disposableTarget.actor.azurePrincipalId
  };
  const transport = azurePorts(input).transport ?? createAzureCliArmTransport(input.runner, input.inspection.projectRoot, {
    now: () => (input.clock?.() ?? input.now).getTime()
  });
  const read = async (resourceId: string, type: string) => {
    authority = await beforeAccess();
    const response = await transport.request({ method: 'GET', resourceId, apiVersion: CONTAINER_APP_API_VERSION }, binding);
    if (response.status !== 200) qualificationFailure('environment-arm-readback', `Independent exact runtime readback failed (HTTP ${response.status}); no report assertion can replace it.`);
    const requestId = applicationUuid(response.requestId, 'Provider-issued ARM readback request');
    const data = object(structuredClone(response.data), 'Actual ARM runtime resource');
    if (typeof data.id !== 'string' || data.id.toLowerCase() !== resourceId.toLowerCase() ||
      typeof data.type !== 'string' || data.type.toLowerCase() !== type.toLowerCase()) {
      qualificationFailure('environment-arm-binding', 'Independent provider resource ID/type differs from the exact approved runtime target.');
    }
    const witness: EnvironmentRuntimeResponseWitness = {
      resourceId, method: 'GET', apiVersion: CONTAINER_APP_API_VERSION, requestId,
      responseBodyDigest: canonicalSha256(data), observedAt: (input.clock?.() ?? input.now).toISOString()
    };
    return { properties: object(data.properties), requestId, witness };
  };
  const app = await read(target.resourceId, 'Microsoft.App/containerApps');
  const properties = app.properties;
  const ingress = object(object(properties.configuration).ingress);
  const traffic = ingress.traffic;
  const revisionResourceId = `${target.resourceId}/revisions/${config.runtime.revisionName}`;
  if (properties.provisioningState !== 'Succeeded' || properties.latestReadyRevisionName !== config.runtime.revisionName ||
    ingress.fqdn !== config.runtime.recipe.fqdn || !Array.isArray(traffic) || traffic.length !== 1 ||
    object(traffic[0]).weight !== 100 || !(object(traffic[0]).revisionName === config.runtime.revisionName &&
      (object(traffic[0]).latestRevision === undefined || object(traffic[0]).latestRevision === false) ||
      object(traffic[0]).latestRevision === true && properties.latestRevisionName === config.runtime.revisionName &&
      (object(traffic[0]).revisionName === undefined || object(traffic[0]).revisionName === config.runtime.revisionName))) {
    qualificationFailure('environment-traffic-binding', 'The independently observed app must route all traffic to the exact approved ready revision, either explicitly or through a latest-revision selector resolved by the same readback; Running or HTTP 200 alone is insufficient.');
  }
  const revision = await read(revisionResourceId, 'Microsoft.App/containerApps/revisions');
  const containers = object(revision.properties.template).containers;
  if (revision.properties.active !== true || revision.properties.provisioningState !== 'Provisioned' ||
    revision.properties.healthState !== 'Healthy' || revision.properties.runningState !== 'Running' ||
    !Array.isArray(containers) || containers.length !== 1 || object(containers[0]).image !== config.runtime.imageRef) {
    qualificationFailure('environment-image-binding', 'The actual active healthy revision must run the exact immutable image; tags, unrelated containers and copied report digests do not prove artifact equality.');
  }
  authority = await beforeAccess();
  const observation: EnvironmentRuntimeObservationBase = {
    kind: 'environment-runtime-observation.v1', executionSourceSha: config.workflow.sourceSha,
    artifactDigest: parseApplicationImageReference(config.runtime.imageRef).digest, imageRef: config.runtime.imageRef,
    authority, workflow: config.workflow, operation: { ...operation, status: 'completed' },
    checkpointDigest: canonicalSha256(records.prepared),
    reportArtifact: parsed.reportArtifact,
    assignmentObservation,
    workflowEvidence: { job: parsed.job, run: parsed.run, verifierSource: parsed.verifierSource, runner: parsed.runner },
    report: parsed.report,
    resource: {
      resourceId: target.resourceId, revisionResourceId, revisionName: config.runtime.revisionName,
      imageRef: config.runtime.imageRef, fqdn: config.runtime.recipe.fqdn,
      appRequestId: app.requestId, revisionRequestId: revision.requestId, trafficWeight: 100,
      provisioningState: 'Succeeded', revisionProvisioningState: 'Provisioned',
      revisionHealthState: 'Healthy', revisionRunningState: 'Running', revisionActive: true,
      observedAt: (input.clock?.() ?? input.now).toISOString()
    }
  };
  const witnessBinding = environmentRuntimeWitnessBinding({
    plan: input.plan, authority, dispatch, readback, checkpoint: records.prepared, config, artifact: parsed, assignmentObservation
  });
  const witness: EnvironmentRuntimeReadbackWitness = {
    schemaVersion: 1, kind: 'environment-runtime-readback-witness.v1',
    projectRoot: records.prepared.projectRoot, projectIdentity: structuredClone(records.prepared.projectIdentity),
    activationIdentityDigest: records.prepared.activationIdentityDigest,
    binding: witnessBinding, observationDigest: canonicalSha256(observation),
    assignmentObservation,
    responses: { app: app.witness, revision: revision.witness }, resource: observation.resource,
    recordedAt: (input.clock?.() ?? input.now).toISOString()
  };
  const witnessDigest = canonicalSha256(witness);
  const descriptor: EnvironmentRuntimeWitnessDescriptor = {
    recordKey: environmentRuntimeWitnessKey(witnessBinding, witnessDigest), witnessDigest
  };
  await beforeAccess();
  await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', githubPorts(input).storage)
    .write(descriptor.recordKey, witness);
  await readEnvironmentRuntimeWitness({
    inspection: input.inspection, adapters: input.adapters, now: input.clock?.() ?? input.now
  }, descriptor, { binding: witnessBinding, checkpoint: records.prepared, observation, producedAt: witness.recordedAt });
  await beforeAccess();
  return { ...observation, nativeWitness: descriptor };
}
