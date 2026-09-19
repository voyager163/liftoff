import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { operation, assertOperationAllowed } from '../../domain/governance/activation/operations.js';
import type { ExternalOperationState, TransitionOperation } from '../../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanningInput, PhasePlanBuild } from '../../governance-activation/transition-ports.js';
import { githubOperation, clientFor } from '../../governance-activation/github-config.js';
import { githubPorts } from '../../governance-activation/github-ports.js';
import { readbackProof } from '../../governance-activation/transition-records.js';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { dispatchApprovedWorkflowRun } from '../../adapters/github/production-checks.js';
import { GitHubActivationClient, safeGitHubFailure, object } from '../../adapters/github/activation-rest.js';
import { applicationUuid, parseApplicationImageReference } from '../../adapters/azure/application-provisioning.js';
import type { ApplicationPrivateAdapters } from '../../adapters/azure/application-private-runtime.js';
import { ApplicationPrivateError } from './application-private-contracts.js';
import { assertAzurePhaseAuthority, AzureActivationAdmissionError } from './authority.js';
import { planApplicationPrivateExecution, executeApplicationPrivatePlan } from './application-private-execution.js';
import {
  applicationPrivateStageOperation, readCompletedApplicationPrivateStage, type ApplicationPrivateStageReference
} from './application-private-receipt.js';
import {
  applicationStagingInputs, applicationStagingProtocol, stagingDevReadOperation, stagingTargetReadOperation
} from './application-staging-inputs.js';
import { createStagingPrivateAuthority } from './application-staging-authority.js';
import { requireQualificationEvidence } from './qualification-evidence.js';
import { qualificationFailure, requireDisposableQualificationAuthority } from './qualification-authority.js';
import { readQualificationCheckpoints, blockedQualificationOutcome } from './qualification-checkpoints.js';
import {
  assertPublishedStagingSecurityRecipe, stagingSecurityWorkflowDispatchInputs
} from './staging-security-workflow.js';
import { readStagingSecurityArtifact, stagingSecurityWorkflowBinding } from './staging-security-artifact.js';
import { readStagingRunnerAssignment } from './staging-runner-readback.js';
import { defaultAzureArmTransport } from './application-artifact-inputs.js';
import type { ApplicationRegistryCopyOptions } from '../../adapters/azure/application-registry-copy.js';
import { isRegistryPromotionPhase, planRegistryPromotionPhase, executeRegistryPromotionPhase } from './registry-promotion-phase.js';
import { environmentRuntimeRunnerReadEffects } from './environment-runtime-assignment.js';
import { validatePrivateRunnerAssignment } from './private-runner-assignment.js';
import { applicationPrivateBackendArtifact } from './application-private-artifacts.js';

function failure(error: unknown): string {
  if (error instanceof AzureActivationAdmissionError) return error.message;
  if (error instanceof ApplicationPrivateError) return `Staging private execution failed (${error.code}); preserve the original private records.`;
  return safeGitHubFailure(error);
}

async function planned(input: PhasePlanningInput) {
  const config = applicationStagingInputs(input);
  if (config.qualification.stage === 'deploy') {
    const native = await planApplicationPrivateExecution(input);
    if (native.blockers?.length) qualificationFailure('staging-private-plan', native.blockers.join(' '));
    return { config, operations: [...native.operations, stagingDevReadOperation(input, config), stagingTargetReadOperation(input, config)] };
  }
  const recipe = config.qualification.security!;
  assertPublishedStagingSecurityRecipe(recipe);
  const deployment: ApplicationPrivateStageReference = { phaseId: 'staging-qualified', review: config.qualification.deployment! };
  const receipt = await applicationPrivateStageOperation(input, deployment);
  const workflow = stagingSecurityWorkflowBinding(recipe);
  const dispatchInputs = stagingSecurityWorkflowDispatchInputs(recipe);
  const source = requireQualificationEvidence(input.inspection, 'workflow-source-ready', config.qualification.source!, input.now).record.payload;
  if (!isRecord(source) || typeof source.sourceSha !== 'string') qualificationFailure('staging-source', 'The original published source receipt is absent.');
  const runnerRecord = requireQualificationEvidence(input.inspection, 'runner-ready', config.qualification.runner!, input.now).record.payload;
  if (!isRecord(runnerRecord) || !isRecord(runnerRecord.assignment)) {
    qualificationFailure('staging-runner-source', 'The original exact dedicated runner assignment is required for resource-scoped read planning.');
  }
  const runnerReadEffects = environmentRuntimeRunnerReadEffects({
    runnerAssignment: { reference: config.qualification.runner!, binding: validatePrivateRunnerAssignment(runnerRecord.assignment.binding) }
  });
  const dispatch = githubOperation(input, 'github.checks.staging', 'github-workflow-dispatch', {
    workflow, dispatchInputs, disposableTarget: config.disposableTarget, security: recipe, deployment,
    source: config.qualification.source, runner: config.qualification.runner, producerSourceSha: source.sourceSha
  }, undefined, [{
    mutationClass: 'github-read', remote: true, destructive: false,
    destination: { type: 'repository', identity: workflow.repository, repository: workflow.repository }
  }, ...runnerReadEffects]);
  const app = config.privateExecution.targets.find((target) => target.resourceId === config.disposableTarget.target.resourceId)!;
  const environment = app.expected.container_app_environment_id;
  if (typeof environment !== 'string') qualificationFailure('staging-environment', 'The original staging plan must name its actual managed environment.');
  const original = input.inspection.contexts['staging-qualified'].reviewedPlans?.find((plan) => plan.planDigest === deployment.review.sourcePlanDigest);
  if (!original || config.privateExecution.mode !== 'recover' || !config.privateExecution.reviewed) {
    qualificationFailure('staging-deployment', 'A source-bound original private deployment review is required before qualification.');
  }
  const readback = operation({
    phaseId: 'staging-qualified', adapter: 'azure-opentofu', actionId: 'azure.staging.readback',
    mutationClass: 'azure-read', remote: true, destructive: false,
    destination: { type: 'subscription', identity: config.disposableTarget.target.resourceId,
      subscriptionId: config.disposableTarget.target.subscriptionId },
    inputs: { deployment, environment, imageRef: applicationPrivateBackendArtifact(config.privateExecution)!.imageRef, security: recipe },
    effects: [{ mutationClass: 'azure-read', remote: true, destructive: false,
      destination: { type: 'subscription', identity: environment, subscriptionId: config.disposableTarget.target.subscriptionId } }]
  });
  return { config, operations: [receipt, dispatch, readback] };
}

export async function planProductionStaging(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  if (isRegistryPromotionPhase(input)) return planRegistryPromotionPhase(input);
  try {
    const value = await planned(input);
    for (const selected of value.operations) assertOperationAllowed(input.phase, selected);
    return { operations: value.operations };
  } catch (error) { return { operations: [], blockers: [failure(error)] }; }
}

async function actualStagingResource(input: PhaseAdapterExecutionInput, readback: TransitionOperation, expectedRevision: string) {
  const config = applicationStagingInputs(input), recipe = config.qualification.security!;
  assertPublishedStagingSecurityRecipe(recipe);
  const transport = defaultAzureArmTransport(input);
  const get = async (resourceId: string) => {
    if (resourceId !== readback.destination.identity && resourceId !== readback.inputs.environment &&
      resourceId !== `${readback.destination.identity}/revisions/${expectedRevision}`) {
      qualificationFailure('staging-resource-scope', 'Staging readback cannot access a resource outside the exact original deployment.');
    }
    await assertAzurePhaseAuthority(input, readback);
    const response = await transport.request({ method: 'GET', resourceId, apiVersion: '2023-05-01' }, config.privateExecution.binding);
    const requestId = applicationUuid(response.requestId, 'Actual staging resource GET');
    if (response.status !== 200 || !isRecord(response.data) || response.data.id !== resourceId) {
      qualificationFailure('staging-resource-readback', 'The actual staging resource identity is absent or changed.');
    }
    return { body: response.data, requestId, bodyDigest: canonicalSha256(response.data) };
  };
  const app = await get(readback.destination.identity), properties = object(app.body.properties);
  const configuration = object(properties.configuration), ingress = object(configuration.ingress), template = object(properties.template);
  const containers = template.containers, traffic = ingress.traffic;
  if (app.body.type !== 'Microsoft.App/containerApps' || properties.provisioningState !== 'Succeeded' ||
    properties.runningStatus !== 'Running' || properties.latestRevisionName !== expectedRevision ||
    properties.latestReadyRevisionName !== expectedRevision || properties.managedEnvironmentId !== readback.inputs.environment ||
    ingress.fqdn !== recipe.target.fqdn || !Array.isArray(containers) || containers.length !== 1 ||
    object(containers[0]).image !== readback.inputs.imageRef || !Array.isArray(traffic) || traffic.length !== 1 ||
    object(traffic[0]).weight !== 100 || !(object(traffic[0]).revisionName === expectedRevision ||
      object(traffic[0]).latestRevision === true && properties.latestRevisionName === expectedRevision)) {
    qualificationFailure('staging-live-artifact', 'The actual ready staging application, immutable image, endpoint or exact revision traffic differs from the completed private deployment.');
  }
  const revision = await get(`${readback.destination.identity}/revisions/${expectedRevision}`);
  const state = object(revision.body.properties), revisionContainers = object(state.template).containers;
  if (revision.body.type !== 'Microsoft.App/containerApps/revisions' || state.active !== true ||
    state.provisioningState !== 'Provisioned' || state.healthState !== 'Healthy' || state.runningState !== 'Running' ||
    !Array.isArray(revisionContainers) || revisionContainers.length !== 1 ||
    object(revisionContainers[0]).image !== readback.inputs.imageRef) {
    qualificationFailure('staging-live-revision', 'Independent actual revision readback did not confirm the deployed healthy immutable artifact.');
  }
  const environment = await get(String(readback.inputs.environment)), environmentProperties = object(environment.body.properties);
  if (environment.body.type !== 'Microsoft.App/managedEnvironments' || environmentProperties.provisioningState !== 'Succeeded' ||
    recipe.target.privateIp !== null && (object(environmentProperties.vnetConfiguration).internal !== true ||
      environmentProperties.staticIp !== recipe.target.privateIp)) {
    qualificationFailure('staging-private-environment', 'The actual managed environment does not establish the requested private DAST endpoint.');
  }
  const confirmed = await get(readback.destination.identity);
  if (confirmed.bodyDigest !== app.bodyDigest) qualificationFailure('staging-readback-race', 'The staging application changed during independent observation.');
  return {
    resourceId: app.body.id, environmentId: environment.body.id, revisionResourceId: revision.body.id,
    revisionName: expectedRevision, imageRef: readback.inputs.imageRef, fqdn: recipe.target.fqdn,
    privateIp: recipe.target.privateIp, trafficWeight: 100,
    readbacks: [app, revision, environment, confirmed].map((entry) => ({
      resourceId: entry.body.id, requestId: entry.requestId, responseBodyDigest: entry.bodyDigest
    })), observedAt: (input.clock?.() ?? input.now).toISOString()
  };
}

export async function executeProductionStaging(
  input: PhaseAdapterExecutionInput, privateAdapters: ApplicationPrivateAdapters = {}, registryOptions: ApplicationRegistryCopyOptions = {}
): Promise<PhaseAdapterOutcome> {
  if (isRegistryPromotionPhase(input)) return executeRegistryPromotionPhase(input, registryOptions);
  const completed: TransitionOperation[] = [];
  let current: ExternalOperationState | undefined = input.inspection.state.phases['staging-qualified'].operation;
  try {
    const value = await planned({ ...input, now: input.clock?.() ?? input.now });
    if (canonicalSha256(input.plan.operations.filter((entry) => entry.remote)) !== canonicalSha256(value.operations)) {
      qualificationFailure('staging-operation-drift', 'Staging operations differ from the exact phase-specific reviewed plan.');
    }
    if (value.config.qualification.stage === 'deploy') {
      const authority = await createStagingPrivateAuthority(input);
      const actual = await executeApplicationPrivatePlan(input, privateAdapters, authority);
      const settled = actual.status === 'prepared' || actual.status === 'executed';
      if (!settled) return { status: 'blocked', blocker: actual.blocker ?? 'Staging native effects remain incomplete; retain and inspect their original checkpoint.',
        evidencePayload: { kind: 'staging-deployment-incomplete.v1', applicationPrivate: actual }, completedOperations: [] };
      return {
        status: 'review-required', completedOperations: value.operations,
        blocker: actual.status === 'prepared' ? 'Review the actual private saved staging plan in a separate apply approval.' :
          actual.additionalReview ? 'Staging dependencies are retained. Separately review the complete immutable application deployment.' :
            'The actual staging deployment is retained. Separately approve security/private-access qualification; deployment alone is not staging qualification.',
        review: { schemaVersion: 1, phaseId: 'staging-qualified', sourcePlanDigest: input.plan.planDigest, kind: 'application-private-plan',
          payload: { protocol: applicationStagingProtocol,
            stage: actual.status === 'prepared' ? 'staging-prepared' : actual.additionalReview ? 'staging-dependencies' : 'staging-deployed',
            result: actual } }
      };
    }
    const recipe = value.config.qualification.security!;
    assertPublishedStagingSecurityRecipe(recipe);
    const receipt = value.operations[0]!, dispatch = value.operations[1]!, readback = value.operations[2]!;
    const priorDigest = input.inspection.state.phases['staging-qualified'].executionPlanDigest;
    if (priorDigest && priorDigest !== input.plan.planDigest &&
      input.inspection.contexts['staging-qualified'].reviewedPlans?.some((plan) => plan.planDigest === priorDigest &&
        plan.operations.some((operation) => operation.actionId === 'github.checks.staging'))) {
      qualificationFailure('staging-original-dispatch', 'Recover the original exact security dispatch plan and checkpoint before changing its inputs; replacement plans cannot forget an unresolved run.');
    }
    const authority = await requireDisposableQualificationAuthority(input, 'staging', dispatch);
    const foundation = await readCompletedApplicationPrivateStage(input, { phaseId: 'staging-qualified',
      review: value.config.qualification.deployment! }, receipt, privateAdapters);
    completed.push(receipt);
    const app = foundation.observedResources.find((entry) => entry.resourceId === authority.target.resourceId);
    if (!app?.revisionName) qualificationFailure('staging-real-revision', 'The original native deployment did not retain its actual application revision identity.');
    const base = clientFor(input);
    const client = new GitHubActivationClient({ async request(request) {
      if (request.method !== 'GET') qualificationFailure('staging-proof-read-only', 'Independent qualification proof permits no hidden GitHub writes.');
      await requireDisposableQualificationAuthority(input, 'staging', dispatch);
      return base.transport.request(request);
    } });
    const authorizeRunnerRead = async () => { await requireDisposableQualificationAuthority(input, 'staging', dispatch); };
    const runner = await readStagingRunnerAssignment(input, client, recipe, value.config.qualification.runner!, authorizeRunnerRead);
    await actualStagingResource(input, readback, app.revisionName);
    const dispatched = await dispatchApprovedWorkflowRun(input, dispatch, stagingSecurityWorkflowBinding(recipe),
      stagingSecurityWorkflowDispatchInputs(recipe));
    current = dispatched.operation; completed.push(dispatch);
    if (dispatched.status === 'pending') return {
      status: 'pending', operation: current, completedOperations: completed,
      blocker: 'The exact staging security/private-access/DAST run is pending; retain its original provider ID and checkpoint without redispatch.'
    };
    if (dispatched.run.conclusion !== 'success') qualificationFailure('staging-security-failed', 'Actual staging security or DAST did not pass; retain diagnostics, not qualifying evidence.');
    const checkpoint = await readQualificationCheckpoints(input, dispatch, stagingSecurityWorkflowBinding(recipe),
      stagingSecurityWorkflowDispatchInputs(recipe));
    if (!checkpoint?.observed) qualificationFailure('staging-original-checkpoint', 'The actual security operation has no original privately retained dispatch readback.');
    const name = `liftoff-staging-security-${dispatched.correlationId}`;
    const artifacts = (await client.list(`${current.resourceId}/artifacts`, 'artifacts')).filter((artifact) => artifact.name === name);
    if (artifacts.length !== 1 || typeof artifacts[0]!.id !== 'number' || typeof artifacts[0]!.digest !== 'string' ||
      typeof dispatch.inputs.producerSourceSha !== 'string') qualificationFailure('staging-artifact', 'The exact same-run bounded security artifact is absent or ambiguous.');
    const security = await readStagingSecurityArtifact({
      client, recipe, producerSourceSha: dispatch.inputs.producerSourceSha, operation: current,
      correlationId: dispatched.correlationId, configurationDigest: stagingSecurityWorkflowDispatchInputs(recipe).qualification_digest!,
      artifact: { artifactId: artifacts[0]!.id, name, archiveDigest: artifacts[0]!.digest }, now: input.clock?.() ?? input.now
    });
    if (Date.parse(security.job.startedAt) < Date.parse(authority.executionWindow.notBefore) ||
      Date.parse(security.job.completedAt) >= Date.parse(authority.executionWindow.expiresAt)) {
      qualificationFailure('staging-execution-window', 'The actual security execution exceeded its original explicit disposable window.');
    }
    const resource = await actualStagingResource(input, readback, app.revisionName);
    const confirmedRunner = await readStagingRunnerAssignment(input, client, recipe, value.config.qualification.runner!, authorizeRunnerRead, current);
    if (canonicalSha256(runner.binding) !== canonicalSha256(confirmedRunner.binding) ||
      canonicalSha256(runner.sources) !== canonicalSha256(confirmedRunner.sources)) {
      qualificationFailure('staging-runner-race', 'The dedicated runner assignment or exact source changed during qualification.');
    }
    completed.push(readback);
    const observation = {
      kind: 'staging-security-observation.v1', authority, foundation, security, resource, runner: confirmedRunner,
      workflow: stagingSecurityWorkflowBinding(recipe), operation: current, checkpointDigest: canonicalSha256(checkpoint.prepared)
    };
    const witness = { schemaVersion: 1, kind: 'staging-security-native-witness.v1', projectRoot: input.inspection.projectRoot,
      repositoryId: input.inspection.state.repository.id, identity: input.inspection.state.identity,
      planDigest: input.plan.planDigest, savedPlanDigest: canonicalSha256(input.plan), observation };
    const witnessDigest = canonicalSha256(witness), recordKey = canonicalSha256({ kind: witness.kind, witnessDigest });
    await requireDisposableQualificationAuthority(input, 'staging', dispatch);
    const store = createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', githubPorts(input).storage);
    await store.write(recordKey, witness);
    if (canonicalSha256((await store.read(recordKey))?.value) !== witnessDigest) qualificationFailure('staging-private-witness', 'The actual private readback witness was not retained intact.');
    return {
      status: 'completed', resultState: 'verified', completedOperations: completed, operation: current,
      evidencePayload: { kind: 'staging-qualified.v1', recipe: applicationStagingProtocol, sourceSha: recipe.sourceSha,
        artifactDigest: recipe.image.digest, securityObservation: observation, nativeWitness: { recordKey, witnessDigest } },
      outputs: { values: { 'staging.sourceSha': recipe.sourceSha, 'staging.artifactDigest': recipe.image.digest,
        'staging.revisionName': app.revisionName, 'staging.securityRunId': current.operationId },
        resources: [{ provider: 'azure', resourceType: 'Microsoft.App/containerApps', resourceId: authority.target.resourceId }] },
      liveReadback: [
        readbackProof(input, 'github', 'workflow-run', current.resourceId, { security, runner }),
        readbackProof(input, 'azure', 'Microsoft.App/containerApps', authority.target.resourceId, resource),
        ...foundation.observedResources.filter((entry) => entry.resourceId !== authority.target.resourceId)
          .map((entry) => readbackProof(input, 'azure', entry.resourceType, entry.resourceId, entry))
      ]
    };
  } catch (error) {
    return { ...blockedQualificationOutcome(input, failure(error)), completedOperations: completed, ...(current ? { operation: current } : {}) };
  }
}
