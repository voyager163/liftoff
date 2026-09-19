import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { SavedTransitionPlan, TransitionOperation } from '../../domain/governance/activation/types.js';
import { sourceSha } from '../../governance-activation/github-config.js';
import { parseApplicationImageReference } from '../../adapters/azure/application-provisioning.js';
import { validateWorkflowRunBinding, type WorkflowRunBinding } from '../../adapters/github/workflow-dispatch.js';
import {
  disposableTargetConfig, qualificationFailure, qualificationInteger, qualificationObject, qualificationText,
  type DisposableTargetConfig
} from './qualification-authority.js';
import {
  qualificationDigest, qualificationEvidenceReference, type QualificationEvidenceReference
} from './qualification-evidence.js';
import { validatePrivateRunnerAssignment, type PrivateRunnerAssignmentBinding } from './private-runner-assignment.js';
import {
  environmentRuntimeJob, environmentRuntimeJobTimeoutMinutes, environmentRuntimeRecipe, renderEnvironmentRuntimeWorkflow,
  type EnvironmentRuntimeRecipe
} from './environment-runtime-workflow.js';

export interface EnvironmentRuntimeInputs {
  workflow: WorkflowRunBinding & { producerSourceSha: string };
  disposableTarget: DisposableTargetConfig;
  /** Reviewed post-creation identities, not source fields or self-asserted creation authority. */
  runnerAssignment: { reference: QualificationEvidenceReference; binding: PrivateRunnerAssignmentBinding };
  runtime: { recipe: EnvironmentRuntimeRecipe; imageRef: string; revisionName: string };
  dispatchInputs: { qualification_digest: string };
}

export function environmentRuntimeReadbackOperation(plan: SavedTransitionPlan, config: EnvironmentRuntimeInputs): TransitionOperation {
  const environment = config.disposableTarget.target.environment;
  const action = environment === 'dev' ? 'azure.dev.readback' :
    environment === 'staging' ? 'azure.staging.readback' : 'azure.production-readback';
  const expectedPhase = environment === 'dev' ? 'dev-proof' :
    environment === 'staging' ? 'staging-qualified' : 'production-rehearsed';
  const matches = plan.operations.filter((operation) => operation.actionId === action);
  const readback = matches[0];
  if (plan.phaseId !== expectedPhase || matches.length !== 1 || !readback ||
    readback.destination.identity !== config.disposableTarget.target.resourceId ||
    readback.destination.subscriptionId !== config.disposableTarget.target.subscriptionId ||
    canonicalSha256(readback.inputs) !== canonicalSha256(config)) {
    qualificationFailure('environment-readback-authority', 'Independent runtime readback requires its separately registered exact Azure read operation and current phase authority; GitHub dispatch permission cannot hide ARM access or deployment.');
  }
  return readback;
}

export function environmentRuntimeInputs(value: unknown): EnvironmentRuntimeInputs {
  const data = qualificationObject(value, ['workflow', 'disposableTarget', 'runnerAssignment', 'runtime', 'dispatchInputs'], 'Runtime observation operation inputs');
  const w = qualificationObject(data.workflow, [
    'repository', 'repositoryId', 'workflowPath', 'workflowId', 'workflowDigest', 'sourceSha',
    'producerSourceSha', 'ref', 'actorId', 'event', 'expectedJobs', 'runAttempt'
  ], 'Exact runtime workflow');
  if (w.event !== 'workflow_dispatch' || w.runAttempt !== 1 ||
    canonicalSha256(w.expectedJobs) !== canonicalSha256([environmentRuntimeJob])) {
    qualificationFailure('environment-workflow-binding', 'The registered environment recipe requires its exact first dispatch attempt and one actual observation job.');
  }
  const workflow: WorkflowRunBinding & { producerSourceSha: string } = {
    repository: qualificationText(w.repository, 'Runtime repository'),
    repositoryId: qualificationInteger(w.repositoryId, 'Runtime repository ID'),
    workflowPath: qualificationText(w.workflowPath, 'Runtime workflow path'),
    workflowId: qualificationInteger(w.workflowId, 'Runtime workflow ID'),
    workflowDigest: qualificationDigest(w.workflowDigest, 'Runtime workflow digest'),
    sourceSha: sourceSha(w.sourceSha), producerSourceSha: sourceSha(w.producerSourceSha),
    ref: qualificationText(w.ref, 'Runtime workflow ref'), actorId: qualificationInteger(w.actorId, 'Actual runtime actor'),
    event: 'workflow_dispatch', expectedJobs: [environmentRuntimeJob], runAttempt: 1
  };
  validateWorkflowRunBinding(workflow);
  const request = disposableTargetConfig(data.disposableTarget);
  if (request.maxDurationMinutes < environmentRuntimeJobTimeoutMinutes ||
    Date.parse(request.expiresAt) - Date.parse(request.notBefore) < environmentRuntimeJobTimeoutMinutes * 60_000) {
    qualificationFailure('environment-time-authority', 'The registered five-minute runtime job must fit inside the exact separately approved disposable time ceiling and interval.');
  }
  const runtime = qualificationObject(data.runtime, ['recipe', 'imageRef', 'revisionName'], 'Runtime resource binding');
  const recipe = environmentRuntimeRecipe(runtime.recipe);
  const assignment = qualificationObject(data.runnerAssignment, ['reference', 'binding'], 'Reviewed runner assignment reference');
  const runnerAssignment = {
    reference: qualificationEvidenceReference(assignment.reference),
    binding: validatePrivateRunnerAssignment(assignment.binding)
  };
  const image = parseApplicationImageReference(runtime.imageRef);
  const revisionName = qualificationText(runtime.revisionName, 'Exact candidate revision');
  const imageRef = `${image.loginServer}/${image.repository}@${image.digest}`;
  if (workflow.workflowPath !== recipe.workflowPath ||
    workflow.workflowDigest !== canonicalSha256(renderEnvironmentRuntimeWorkflow(recipe)) ||
    workflow.actorId !== request.actor.githubActorId || request.target.environment !== recipe.environment ||
    request.target.resourceId !== recipe.resourceId ||
    !revisionName.startsWith(`${request.target.appName}--`) || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(revisionName)) {
    qualificationFailure('environment-workflow-binding', 'Runtime source must be the actual registered observation recipe, bound to the exact image, revision, environment and approved principal; arbitrary reviewed YAML is not a verifier.');
  }
  const binding = runnerAssignment.binding;
  if (binding.repository !== workflow.repository || binding.repositoryId !== workflow.repositoryId ||
    binding.runnerGroupName !== recipe.runner.group || binding.runnerName !== recipe.runner.label ||
    !binding.allowedWorkflows.includes(`${workflow.repository}/${recipe.workflowPath}@refs/heads/${workflow.ref}`)) {
    qualificationFailure('environment-runner-assignment', 'The separately reviewed assignment must name this exact repository, stable source routing and allowed workflow/ref. Numeric IDs alone do not grant creation custody or dispatch authority.');
  }
  const dispatchInputs = {
    qualification_digest: canonicalSha256({ workflow, disposableTarget: request, runnerAssignment, runtime: { recipe, imageRef, revisionName } })
  };
  if (canonicalSha256(qualificationObject(data.dispatchInputs, ['qualification_digest'], 'Runtime dispatch inputs')) !== canonicalSha256(dispatchInputs)) {
    qualificationFailure('environment-workflow-binding', 'Runtime dispatch must commit the complete exact reviewed source, artifact, target, actors and disposable authority.');
  }
  return { workflow, disposableTarget: request, runnerAssignment, runtime: { recipe, imageRef, revisionName }, dispatchInputs };
}
