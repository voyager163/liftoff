import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { assertOperationAllowed, operation } from '../../domain/governance/activation/operations.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import type { PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import type { PhaseReviewReference } from '../../governance-activation/phase-reviews.js';
import { githubOperation, repositoryConfiguration, sourceSha } from '../../governance-activation/github-config.js';
import { parseApplicationImageReference } from '../../adapters/azure/application-provisioning.js';
import type { ApplicationPrivateConfiguration } from './application-private-contracts.js';
import { applicationPrivateInputs, applicationPrivateIntent } from './application-private-inputs.js';
import {
  configuredDisposableTarget, qualificationFailure, qualificationObject, requireEnvironmentActivationScope,
  type DisposableTargetConfig
} from './qualification-authority.js';
import {
  qualificationDigest, qualificationEvidenceReference, requireQualificationEvidence, type QualificationEvidenceReference
} from './qualification-evidence.js';
import {
  assertPublishedStagingSecurityRecipe, renderStagingSecurityWorkflow, stagingSecurityWorkflowRecipe,
  type StagingSecurityWorkflowRecipe
} from './staging-security-workflow.js';
import { devProofRecipeId } from './producer-dev-proof.js';
import { applicationPrivateBackendArtifact } from './application-private-artifacts.js';

export const applicationStagingProtocol = 'private-application-staging/1' as const;

export interface ApplicationStagingInputs {
  disposableTarget: DisposableTargetConfig;
  privateExecution: ApplicationPrivateConfiguration;
  qualification: {
    stage: 'deploy' | 'verify';
    dev: QualificationEvidenceReference;
    deployment: PhaseReviewReference | null;
    security: StagingSecurityWorkflowRecipe | null;
    source: QualificationEvidenceReference | null;
    runner: QualificationEvidenceReference | null;
  };
}

export function applicationStagingInputs(input: Pick<PhasePlanningInput, 'inspection' | 'phase' | 'now'>): ApplicationStagingInputs {
  requireEnvironmentActivationScope(input);
  if (input.phase.id !== 'staging-qualified') qualificationFailure('staging-phase', 'Staging requires its own registered phase.');
  const raw = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  const wrapper = qualificationObject(raw?.phases['staging-qualified'], ['privateExecution', 'disposableTarget', 'qualification'], 'Staging execution');
  const data = qualificationObject(wrapper.qualification, ['stage', 'dev', 'deployment', 'security', 'source', 'runner'], 'Staging qualification stages');
  const disposableTarget = configuredDisposableTarget(input, 'staging');
  const privateExecution = applicationPrivateInputs(input);
  if (data.stage !== 'deploy' && data.stage !== 'verify') qualificationFailure('staging-stage', 'Only declared deploy or verify stages are supported.');
  const dev = qualificationEvidenceReference(data.dev);
  const { record } = requireQualificationEvidence(input.inspection, 'dev-proof', dev, input.now);
  const payload = record.payload;
  if (!isRecord(payload) || payload.kind !== 'dev-proof.v1' || payload.recipe !== devProofRecipeId ||
    input.inspection.state.phases['dev-proof'].state !== 'verified' ||
    !isRecord(payload.runtimeObservation) || payload.runtimeObservation.kind !== 'environment-runtime-observation.v1' ||
    !isRecord(payload.runtimeObservation.nativeWitness) || !isRecord(payload.foundation) ||
    payload.foundation.kind !== 'completed-private-application-receipt.v1') {
    qualificationFailure('staging-dev-proof', 'Staging consumes the concrete private-foundation development producer and its original private runtime witness, not a source/check assertion.');
  }
  const backendArtifact = applicationPrivateBackendArtifact(privateExecution);
  const image = parseApplicationImageReference(backendArtifact?.imageRef ?? payload.runtimeObservation.imageRef);
  if (backendArtifact !== null && sourceSha(payload.sourceSha) !== backendArtifact.sourceSha ||
    payload.artifactDigest !== image.digest || privateExecution.binding.principalId !== disposableTarget.actor.azurePrincipalId ||
    privateExecution.binding.subscriptionId !== disposableTarget.target.subscriptionId ||
    privateExecution.binding.tenantId !== disposableTarget.target.tenantId) {
    qualificationFailure('staging-source-artifact', 'Staging must deploy the exact development source/artifact under the separately named Azure principal and disposable target.');
  }
  const group = `/subscriptions/${disposableTarget.target.subscriptionId}/resourceGroups/${disposableTarget.target.resourceGroup}`;
  if (privateExecution.targets.some((target) => target.resourceId !== group && !target.resourceId.startsWith(`${group}/`)) ||
    privateExecution.scope === 'staging' && !privateExecution.targets.some((target) =>
      target.type === 'azurerm_container_app' && target.resourceId === disposableTarget.target.resourceId)) {
    qualificationFailure('staging-targets', 'Every staging resource effect must be explicitly listed in the approved disposable resource group and include the declared application for complete deployment.');
  }
  let deployment: PhaseReviewReference | null = null;
  if (data.deployment !== null) {
    const reference = qualificationObject(data.deployment, ['sourcePlanDigest', 'reviewDigest'], 'Original deployment review');
    deployment = {
      sourcePlanDigest: qualificationDigest(reference.sourcePlanDigest, 'Original deployment plan'),
      reviewDigest: qualificationDigest(reference.reviewDigest, 'Original deployment review')
    };
  }
  const security = data.security === null ? null : stagingSecurityWorkflowRecipe(data.security);
  const source = data.source === null ? null : qualificationEvidenceReference(data.source);
  const runner = data.runner === null ? null : qualificationEvidenceReference(data.runner);
  if (data.stage === 'verify') {
    if (security) assertPublishedStagingSecurityRecipe(security);
    if (!deployment || !security || !source || !runner || privateExecution.scope !== 'staging' || privateExecution.mode !== 'recover' ||
      privateExecution.recovery !== 'inspect' || !privateExecution.reviewed || security.sourceSha !== payload.sourceSha ||
      security.workflowId === null || security.image.digest !== image.digest ||
      security.target.resourceId !== disposableTarget.target.resourceId ||
      security.repository !== repositoryConfiguration(input.inspection).name ||
      String(security.repositoryId) !== input.inspection.state.remoteBinding?.id ||
      security.actorId !== disposableTarget.actor.githubActorId || security.azure.principalId !== disposableTarget.actor.azurePrincipalId) {
      qualificationFailure('staging-verification-inputs', 'Verification needs the original closed deployment/private review and actual published security recipe, exact source/image/target/actors; it never applies a new plan.');
    }
    if (input.inspection.state.applicability.privateStagingDast && security.target.privateIp === null) {
      qualificationFailure('staging-private-dast', 'This profile requires actual same-job private DNS/TLS socket proof for DAST; generic runner readiness cannot substitute.');
    }
    if (privateExecution.artifactSet && privateExecution.targets.find((target) =>
      target.address === privateExecution.artifactSet!.deployments.backend.address)?.resourceId !== disposableTarget.target.resourceId) {
      qualificationFailure('staging-artifact-role', 'Staging API/security qualification must bind the declared backend role, while the private deployment retains every frontend role.');
    }
    const published = requireQualificationEvidence(input.inspection, 'workflow-source-ready', source, input.now).record.payload;
    const expectedDigest = canonicalSha256(renderStagingSecurityWorkflow(security));
    if (!isRecord(published) || published.kind !== 'workflow-source-ready.v1' || !Array.isArray(published.files) ||
      !published.files.some((file) => isRecord(file) && file.path === security.workflowPath && file.digest === expectedDigest) ||
      !Array.isArray(published.workflows) || !published.workflows.some((workflow) => isRecord(workflow) &&
        workflow.path === security.workflowPath && workflow.workflowId === security.workflowId && workflow.digest === expectedDigest)) {
      qualificationFailure('staging-published-source', 'Staging requires its exact registered workflow in the original reviewed GitFlow publication receipt.');
    }
    requireQualificationEvidence(input.inspection, 'runner-ready', runner, input.now);
    const originals = input.inspection.contexts['staging-qualified'].reviewedPlans?.filter((plan) =>
      plan.planDigest === deployment.sourcePlanDigest) ?? [];
    const original = originals[0];
    if (originals.length !== 1 || !original?.configuration) qualificationFailure('staging-original-deployment', 'The original exact deployment plan is required.');
    const prior = applicationPrivateInputs({ ...input, inspection: { ...input.inspection, activationInputs: original.configuration } });
    if (canonicalSha256(applicationPrivateIntent(prior)) !== canonicalSha256(applicationPrivateIntent(privateExecution)) ||
      prior.mode === 'prepare' || canonicalSha256(prior.reviewed) !== canonicalSha256(privateExecution.reviewed)) {
      qualificationFailure('staging-original-deployment', 'Verification preserves the exact original private deployment inputs, not substitute state or source bindings.');
    }
  } else if (deployment !== null || security !== null || source !== null || runner !== null) {
    qualificationFailure('staging-deployment-inputs', 'Deployment cannot attach caller-authored qualification or completed-stage proof; supply null until the actual deployment is retained.');
  }
  return { disposableTarget, privateExecution, qualification: { stage: data.stage, dev, deployment, security, source, runner } };
}

export function stagingDevReadOperation(input: PhasePlanningInput, config: ApplicationStagingInputs): TransitionOperation {
  const op = githubOperation(input, 'github.application-staging.dev-receipt', 'github-read', {
    protocol: applicationStagingProtocol, dev: config.qualification.dev, actorId: config.disposableTarget.actor.githubActorId
  });
  assertOperationAllowed(input.phase, op);
  return op;
}

export function stagingTargetReadOperation(input: PhasePlanningInput, config: ApplicationStagingInputs): TransitionOperation {
  const target = config.disposableTarget.target;
  const op = operation({
    phaseId: 'staging-qualified', adapter: 'azure-opentofu', actionId: 'azure.application-staging.target-read',
    mutationClass: 'azure-read', remote: true, destructive: false,
    destination: { type: 'subscription', identity: target.resourceId, subscriptionId: target.subscriptionId },
    inputs: { binding: config.privateExecution.binding, expectedResourceId: target.resourceId,
      permitAbsence: config.qualification.stage === 'deploy' }
  });
  assertOperationAllowed(input.phase, op);
  return op;
}
