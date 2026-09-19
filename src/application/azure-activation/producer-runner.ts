import {
  GitHubActivationClient, GitHubActivationError, githubName, object, positiveId, safeGitHubFailure,
} from '../../adapters/github/activation-rest.js';
import { readbackWorkflowContent } from '../../adapters/github/production-workflows.js';
import { openPrivateRunnerGitHubSession } from '../../adapters/github/private-runner-session.js';
import { dispatchApprovedWorkflowRun, readBoundWorkflowRun } from '../../adapters/github/production-checks.js';
import type { RecordedWorkflowRunIdentity, WorkflowRunBinding } from '../../adapters/github/workflow-run-readback.js';
import { readWorkflowEffect } from '../repository-governance/workflow-checkpoints.js';
import { assertGitHubPhaseAuthority } from '../repository-governance/workflow-authority.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, canonicalPhaseGraphHash } from '../../domain/governance/activation/graph.js';
import { privateRunnerCreatedResources } from '../../domain/governance/activation/runner-evidence.js';
import { assertOperationAllowed, assertPlanOperationsAllowed } from '../../domain/governance/activation/operations.js';
import { approvalRequestForSavedPlan, evaluateApprovalForTransitionPlan } from '../../domain/governance/activation/approvals.js';
import { validateApprovalEnvelope, validateSavedTransitionPlan } from '../../domain/governance/activation/validators.js';
import type { ExternalOperationState, SavedTransitionPlan, TransitionOperation } from '../../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { clientFor, githubOperation, repositoryConfiguration, verifiedOutput } from '../../governance-activation/github-config.js';
import { readbackProof } from '../../governance-activation/transition-records.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import { createScopedUserLocalRecordStore, type UpdatePreviewOptions } from '../../adapters/filesystem/update-previews.js';
import { currentProjectMutationLease } from '../../adapters/filesystem/project-lock.js';
import { assertGovernanceApprovalIssued } from '../../governance-activation/authority-records.js';
import { assertAzurePhaseAuthority, AzureActivationAdmissionError } from './authority.js';
import { exactObject, privateDigest, privateName } from './private-resource-plans.js';
import {
  assertNoLegacyRunnerDispatchCustody, preparePrivateEffect, readPrivateEffect, readPrivateRunnerCustodyMetadata,
  settlePrivateEffect, submitPrivateEffect,
  type PrivateEffectCheckpoint, type PrivateEffectIntent
} from './private-checkpoints.js';
import {
  observePrivateRunnerRun, privateRunnerWorkflowBinding, renderPrivateRunnerWorkflow, validatePrivateRunnerSource, type PrivateRunnerWorkflowSource
} from './private-runner-workflow.js';
import { renderPrivateBackendWorkflow, validatePrivateBackendSource, type PrivateBackendWorkflowSource } from './private-backend-workflow.js';
import {
  assertPrivateApplicationWorkflowRouting, privateApplicationWorkflowSelector, readPrivateRunnerApplicationSource,
  validatePrivateRunnerApplicationSource, type PrivateRunnerApplicationSource
} from './private-runner-application-sources.js';
import {
  assertPrivateHostedRunner as checkRunner, assertPrivateRunnerGroup, assertPrivateRunnerNetwork as checkNetwork,
  privateRunnerRequestId as requestId, readPrivateRunnerObject as exactGet, validatePrivateRunnerAssignment,
  verifyPrivateRunnerAssignment, type PrivateRunnerAssignmentBinding, type PrivateRunnerAssignmentObservation
} from './private-runner-assignment.js';
import { requireQualificationEvidence, type QualificationEvidenceReference } from './qualification-evidence.js';
export { planRunnerArmResources } from './private-resource-plans.js';
export {
  verifyPrivateRunnerAssignment, type PrivateRunnerAssignmentBinding, type PrivateRunnerAssignmentObservation,
  type PrivateRunnerJobObservation
} from './private-runner-assignment.js';
export { validatePrivateRunnerApplicationSource, type PrivateRunnerApplicationSource } from './private-runner-application-sources.js';
export const privateRunnerReachabilityAction = 'github.runner.reachability-dispatch';

export interface PrivateRunnerReconciliation {
  originPlanDigest: string;
  groupId: number;
  definitionId: number;
  networkConfigurationId: string;
  expectedWorkflows: readonly string[];
}

export interface PrivateRunnerPlan {
  schemaVersion: 1;
  recipe: 'repository-private-hosted-runner/1';
  repository: string;
  repositoryId: number;
  organization: string;
  organizationId: number;
  actorId: number;
  networkSettingsId: string;
  networkSettingsResourceId: string;
  subnetId: string;
  region: string;
  networkConfigurationName: string;
  runnerGroupName: string;
  runnerName: string;
  imageId: string;
  machineSize: string;
  maxRunners: number;
  source: PrivateRunnerWorkflowSource;
  backendSource?: PrivateBackendWorkflowSource;
  applicationSources?: readonly PrivateRunnerApplicationSource[];
  reconciliation?: PrivateRunnerReconciliation;
  expiresAt: string;
  configurationDigest: string;
  planDigest: string;
}

type RunnerStep = 'read-capabilities' | 'network-configuration' | 'runner-group' | 'hosted-runner' | 'network-observation-run';
const steps: readonly RunnerStep[] = ['read-capabilities', 'network-configuration', 'runner-group', 'hosted-runner', 'network-observation-run'];

function require(value: unknown, message: string): asserts value {
  if (!value) throw new GitHubActivationError('private-runner-plan', message);
}

function networkId(value: unknown): string {
  require(typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(value), 'Use the actual provider-issued GitHub network ID; it cannot be inferred from an Azure resource name.');
  return value;
}

export function privateRunnerPlanForInspection(input: PhasePlanningInput): PrivateRunnerPlan {
  const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  const raw = configuration?.phases['runner-ready'];
  const config = exactObject(raw, [
    'organizationId', 'actorId', 'networkConfigurationName', 'runnerGroupName', 'runnerName',
    'imageId', 'machineSize', 'maxRunners', 'source', 'expiresAt',
    ...['backendSource', 'applicationSources', 'reconciliation'].filter((key) => raw && Object.hasOwn(raw, key))
  ], 'Private runner inputs');
  const repository = repositoryConfiguration(input.inspection).name;
  const source = validatePrivateRunnerSource(config.source as PrivateRunnerWorkflowSource);
  const backendSource = config.backendSource === undefined ? undefined : validatePrivateBackendSource(config.backendSource as PrivateBackendWorkflowSource);
  const rawRepositoryId = input.inspection.state.remoteBinding?.id;
  require(typeof rawRepositoryId === 'string' && /^[1-9][0-9]*$/u.test(rawRepositoryId), 'The private runner needs a canonical actual repository ID, not an inferred numeric alias.');
  const repositoryId = positiveId(Number(rawRepositoryId));
  const organization = githubName(repository.split('/')[0]);
  const organizationId = positiveId(config.organizationId), actorId = positiveId(config.actorId);
  const settingsId = networkId(verifiedOutput(input.inspection, 'bootstrap-local', 'runner.networkSettingsId'));
  const settingsResourceId = verifiedOutput(input.inspection, 'bootstrap-local', 'runner.networkSettingsResourceId');
  const subnetId = verifiedOutput(input.inspection, 'bootstrap-local', 'runner.subnetId');
  const subnetPrefix = verifiedOutput(input.inspection, 'bootstrap-local', 'runner.subnetPrefix');
  const region = verifiedOutput(input.inspection, 'bootstrap-local', 'runner.region');
  const businessId = verifiedOutput(input.inspection, 'bootstrap-local', 'runner.githubBusinessId');
  require(typeof settingsResourceId === 'string' && typeof subnetId === 'string' && typeof region === 'string' &&
    businessId === String(organizationId), 'The current bootstrap proof must bind the exact organization, Azure network settings and dedicated subnet.');
  const runnerGroupName = privateName(config.runnerGroupName, 'Repository-dedicated runner group');
  const runnerName = privateName(config.runnerName, 'Private hosted runner');
  const networkConfigurationName = privateName(config.networkConfigurationName, 'Hosted network configuration');
  let reconciliation: PrivateRunnerReconciliation | undefined;
  if (config.reconciliation !== undefined) {
    const value = exactObject(config.reconciliation, [
      'originPlanDigest', 'groupId', 'definitionId', 'networkConfigurationId', 'expectedWorkflows'
    ], 'Exact owned runner assignment reconciliation');
    require(Array.isArray(value.expectedWorkflows) && value.expectedWorkflows.every((entry) => typeof entry === 'string'),
      'Reconciliation needs the exact previously observed workflow allowlist.');
    reconciliation = {
      originPlanDigest: privateDigest(value.originPlanDigest, 'Original runner creation plan'),
      groupId: positiveId(value.groupId), definitionId: positiveId(value.definitionId),
      networkConfigurationId: networkId(value.networkConfigurationId), expectedWorkflows: value.expectedWorkflows
    };
  }
  let applicationSources: readonly PrivateRunnerApplicationSource[] | undefined;
  if (config.applicationSources !== undefined) {
    require(Array.isArray(config.applicationSources) && config.applicationSources.length > 0 && config.applicationSources.length <= 4,
      'Additional private runner access requires one through four exact published application workflow sources.');
    applicationSources = config.applicationSources.map(validatePrivateRunnerApplicationSource);
    for (const application of applicationSources) assertPrivateApplicationWorkflowRouting(application, {
      repository, repositoryId, groupName: runnerGroupName, runnerName
    });
  }
  if (backendSource) require(backendSource.recipe.repository === repository && backendSource.recipe.repositoryId === repositoryId &&
    backendSource.recipe.runnerGroupName === runnerGroupName && backendSource.recipe.runnerLabel === runnerName &&
    backendSource.recipe.runnerSubnetId === subnetId && backendSource.recipe.runnerSubnetPrefix === subnetPrefix &&
    backendSource.recipe.target.region === region && backendSource.recipe.workflowPath !== source.recipe.workflowPath &&
    `${backendSource.recipe.target.backend.account}.blob.core.windows.net` === source.recipe.target.hostname &&
    backendSource.recipe.target.endpointAddress === source.recipe.target.endpointAddress &&
    backendSource.recipe.target.privateEndpointId === source.recipe.target.privateEndpointId &&
    backendSource.recipe.target.subnetId === source.recipe.target.endpointSubnetId &&
    backendSource.recipe.target.virtualNetworkId === source.recipe.target.virtualNetworkId,
  'A backend lease workflow must be an exact separately published source for the same dedicated runner and private network.');
  const bootstrapResources = input.inspection.state.phaseOutputs?.['bootstrap-local']?.resources ?? [];
  for (const [resourceType, resourceId] of [
    ['Microsoft.Network/privateEndpoints', source.recipe.target.privateEndpointId],
    ['Microsoft.Network/virtualNetworks', source.recipe.target.virtualNetworkId],
    ['Microsoft.Network/virtualNetworks/subnets', source.recipe.target.endpointSubnetId]
  ]) {
    require(bootstrapResources.some((resource) => resource.provider === 'azure' &&
      resource.resourceType === resourceType && resource.resourceId === resourceId),
    'The private reachability target must belong to the exact current bootstrap resource readback, not an asserted network ID.');
  }
  require(source.recipe.repository === repository && source.recipe.repositoryId === repositoryId &&
    source.recipe.runnerGroupName === runnerGroupName && source.recipe.runnerLabel === runnerName &&
    source.recipe.runnerSubnetId === subnetId && source.recipe.runnerSubnetPrefix === subnetPrefix &&
    source.recipe.target.region === region && source.actorId === actorId &&
    typeof config.expiresAt === 'string' && Number.isFinite(Date.parse(config.expiresAt)) &&
    new Date(config.expiresAt).toISOString() === config.expiresAt && Date.parse(config.expiresAt) > input.now.getTime() &&
    Number.isSafeInteger(config.maxRunners) && Number(config.maxRunners) >= 1 && Number(config.maxRunners) <= 8 &&
    runnerName.length <= 64, 'Runner source, repository restriction, principal, supported concurrency or expiry does not match its exact reviewed plan.');
  const plan = {
    schemaVersion: 1 as const, recipe: 'repository-private-hosted-runner/1' as const,
    repository, repositoryId, organization, organizationId, actorId,
    networkSettingsId: settingsId, networkSettingsResourceId: settingsResourceId, subnetId, region,
    networkConfigurationName, runnerGroupName, runnerName,
    imageId: privateName(config.imageId, 'Exact supported GitHub runner image'), machineSize: privateName(config.machineSize, 'Exact supported machine size'),
    maxRunners: Number(config.maxRunners), source, expiresAt: config.expiresAt,
    ...(backendSource ? { backendSource } : {}),
    ...(applicationSources ? { applicationSources } : {}),
    ...(reconciliation ? { reconciliation } : {}),
    configurationDigest: canonicalSha256(configuration)
  };
  const selectors = selection(plan);
  const workflowIds = [source.workflowId, ...(backendSource ? [backendSource.workflowId] : []),
    ...(applicationSources ?? []).map((entry) => entry.workflowId)];
  require(new Set(selectors).size === selectors.length && new Set(workflowIds).size === workflowIds.length,
    'Runner access cannot contain duplicate or aliased workflow identities.');
  if (reconciliation) validatePrivateRunnerAssignment(assignmentBinding(plan, reconciliation, reconciliation.expectedWorkflows));
  return { ...plan, planDigest: canonicalSha256(plan) };
}

export function planPrivateRunner(input: PhasePlanningInput): PhasePlanBuild {
  try {
    require(input.phase.id === 'runner-ready' && (input.inspection.scope ?? 'activation') === 'activation' &&
      input.inspection.state.applicability.statePath === 'bootstrap-local', 'Private hosted runner assignment belongs only to its selected bootstrap activation phase.');
    const plan = privateRunnerPlanForInspection(input);
    if (plan.reconciliation) {
      const binding = assignmentBinding(plan, plan.reconciliation);
      const reads = privateRunnerCreatedResources.map((resource) => {
        const id = resource.field === 'groupId' ? binding.groupId :
          resource.field === 'hostedRunnerDefinitionId' ? binding.definitionId : binding.networkConfigurationId;
        return {
          mutationClass: 'github-read' as const, remote: true, destructive: false,
          destination: { type: 'external' as const, identity: `/orgs/${plan.organization}/${resource.collection}/${id}` }
        };
      });
      const operations = [
        githubOperation(input, 'github.runner.ensure-ready', 'github-read', { step: 'read-owned-assignment', plan }, undefined, reads),
        githubOperation(input, 'github.runner.ensure-ready', 'github-write', {
          step: 'reconcile-workflow-assignment', plan,
          groupId: plan.reconciliation.groupId,
          expectedWorkflows: plan.reconciliation.expectedWorkflows,
          selectedWorkflows: selection(plan)
        }, { type: 'external', identity: `/orgs/${plan.organization}/actions/runner-groups/${plan.reconciliation.groupId}` })
      ];
      for (const op of operations) assertOperationAllowed(input.phase, op);
      return { operations };
    }
    const operations = steps.map((step) => {
      if (step === 'network-observation-run') return githubOperation(input, privateRunnerReachabilityAction, 'github-workflow-dispatch', {
        step, plan, workflow: privateRunnerWorkflowBinding(plan.source),
        dispatchInputs: { configuration_digest: plan.configurationDigest }
      });
      const resource = privateRunnerCreatedResources.find((entry) => entry.step === step);
      return githubOperation(input, 'github.runner.ensure-ready', step === 'read-capabilities' ? 'github-read' : 'github-write', { step, plan },
        resource ? { type: 'external', identity: `/orgs/${plan.organization}/${resource.collection}` } : undefined);
    });
    try { assertOperationAllowed(input.phase, operations.at(-1)!); }
    catch {
      throw new GitHubActivationError('runner-dispatch-contract',
        'Operation registry gap: runner-ready requires github.runner.reachability-dispatch as a primary github-workflow-dispatch operation. No Azure/backend reads or relabeled delegated dispatch are permitted.');
    }
    return { operations };
  } catch (error) {
    return { operations: [], blockers: [error instanceof AzureActivationAdmissionError ? error.message : safeGitHubFailure(error)] };
  }
}

function selection(plan: Pick<PrivateRunnerPlan, 'repository' | 'source' | 'backendSource' | 'applicationSources'>): string[] {
  return [
    `${plan.repository}/${plan.source.recipe.workflowPath}@refs/heads/${plan.source.ref}`,
    ...(plan.backendSource ? [`${plan.repository}/${plan.backendSource.recipe.workflowPath}@refs/heads/${plan.backendSource.ref}`] : []),
    ...(plan.applicationSources ?? []).map(privateApplicationWorkflowSelector)
  ];
}

async function checkGroup(client: GitHubActivationClient, value: Record<string, unknown>, plan: PrivateRunnerPlan, id: number, network: string) {
  return assertPrivateRunnerGroup(client, value, plan, id, network, selection(plan));
}

function assignmentBinding(
  plan: Omit<PrivateRunnerPlan, 'planDigest'>,
  ids: { groupId: number; definitionId: number; networkConfigurationId: string },
  allowedWorkflows: readonly string[] = selection(plan)
): PrivateRunnerAssignmentBinding {
  return {
    schemaVersion: 1, repository: plan.repository, repositoryId: plan.repositoryId,
    organization: plan.organization, organizationId: plan.organizationId,
    groupId: ids.groupId, definitionId: ids.definitionId, networkConfigurationId: ids.networkConfigurationId,
    runnerGroupName: plan.runnerGroupName, runnerName: plan.runnerName, imageId: plan.imageId,
    machineSize: plan.machineSize, maxRunners: plan.maxRunners, networkConfigurationName: plan.networkConfigurationName,
    networkSettingsId: plan.networkSettingsId, subnetId: plan.subnetId, region: plan.region, allowedWorkflows
  };
}

function networkIntentFor(plan: PrivateRunnerPlan): PrivateEffectIntent {
  return {
    kind: 'runner-network-configuration', step: plan.networkConfigurationName, provider: 'github',
    resourceId: `/orgs/${plan.organization}/settings/network-configurations`,
    request: { method: 'POST', body: { name: plan.networkConfigurationName, compute_service: 'actions',
      network_settings_ids: [plan.networkSettingsId], failover_network_enabled: false } }
  };
}

function groupIntentFor(plan: PrivateRunnerPlan, networkConfigurationId: string): PrivateEffectIntent {
  return {
    kind: 'runner-group', step: plan.runnerGroupName, provider: 'github', resourceId: `/orgs/${plan.organization}/actions/runner-groups`,
    request: { method: 'POST', body: { name: plan.runnerGroupName, visibility: 'selected',
      selected_repository_ids: [plan.repositoryId], allows_public_repositories: false,
      restricted_to_workflows: true, selected_workflows: selection(plan), network_configuration_id: networkConfigurationId } }
  };
}

function runnerIntentFor(plan: PrivateRunnerPlan, groupId: number): PrivateEffectIntent {
  return {
    kind: 'runner-hosted-runner', step: plan.runnerName, provider: 'github',
    resourceId: `/orgs/${plan.organization}/actions/hosted-runners`,
    request: { method: 'POST', body: { name: plan.runnerName, image: { id: plan.imageId, source: 'github' },
      size: plan.machineSize, runner_group_id: groupId, maximum_runners: plan.maxRunners, enable_static_ip: false } }
  };
}

async function assertRunnerAdministrator(client: GitHubActivationClient, plan: PrivateRunnerPlan): Promise<void> {
  const repo = await client.get(`/repos/${plan.repository}`), org = await client.get(`/orgs/${plan.organization}`), actor = await client.get('/user');
  require(repo.id === plan.repositoryId && repo.full_name === plan.repository && repo.private === true &&
    repo.archived === false && repo.disabled === false && object(repo.owner).id === plan.organizationId &&
    object(repo.permissions).admin === true && org.id === plan.organizationId && org.type === 'Organization' &&
    actor.id === plan.actorId, 'The exact private repository, owning organization or authorized administrator is not currently verified.');
}

async function readRunnerSources(client: GitHubActivationClient, plan: PrivateRunnerPlan, exactRef: boolean) {
  const probes = [
    { source: plan.source, content: renderPrivateRunnerWorkflow(plan.source.recipe) },
    ...(plan.backendSource ? [{ source: plan.backendSource, content: renderPrivateBackendWorkflow(plan.backendSource.recipe) }] : [])
  ];
  for (const { source, content: expected } of probes) {
    const workflow = await client.get(`/repos/${plan.repository}/actions/workflows/${source.workflowId}`);
    const content = await readbackWorkflowContent(client, plan.repository, source.recipe.workflowPath, source.sourceSha);
    require(workflow.id === source.workflowId && workflow.path === source.recipe.workflowPath && workflow.state === 'active' &&
      content.digest === source.workflowDigest && content.content === expected,
    'The actual published private workflow is not its exact registered source.');
    if (exactRef) {
      const ref = await client.get(`/repos/${plan.repository}/git/ref/heads/${source.ref}`);
      require(ref.ref === `refs/heads/${source.ref}` && object(ref.object).sha === source.sourceSha && object(ref.object).type === 'commit',
        'The private workflow ref changed after assignment review.');
    }
  }
  for (const source of plan.applicationSources ?? []) await readPrivateRunnerApplicationSource(client, source);
}

function runnerPhase() {
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'runner-ready');
  require(phase, 'The canonical runner ownership phase is unavailable.');
  return phase;
}

function storedRunnerPlan(input: PhasePlanningInput, value: unknown) {
  const saved = validateSavedTransitionPlan(value);
  const phase = runnerPhase();
  require(saved.phaseId === 'runner-ready' && saved.scope === 'activation' && saved.configuration &&
    saved.graphHash === canonicalPhaseGraphHash && input.inspection.graphHash === canonicalPhaseGraphHash,
  'Runner ownership requires its original current-identity reviewed plan, not an asserted resource name.');
  assertPlanOperationsAllowed(saved, phase);
  const planning: PhasePlanningInput = {
    ...input, phase, now: new Date(saved.createdAt), inspection: {
      ...input.inspection, activationInputs: saved.configuration,
      state: { ...input.inspection.state, activationInputs: saved.configuration }
    }
  };
  const plan = privateRunnerPlanForInspection(planning);
  const build = planPrivateRunner(planning);
  const operations = saved.operations.filter((op) => op.actionId === 'github.runner.ensure-ready' || op.actionId === privateRunnerReachabilityAction);
  require(!build.blockers?.length && canonicalSha256(build.operations) === canonicalSha256(operations),
    'The original private runner operation cannot be reconstructed without changing its declared source or scope.');
  return { saved, plan, operations };
}

function retainedRunnerPlan(input: PhasePlanningInput, planDigest: string) {
  const retained = input.inspection.contexts['runner-ready'].reviewedPlans ?? [];
  require(retained.length <= 128, 'The exact runner custody plan inventory exceeds its bounded supported size.');
  const matches = retained.filter((entry) => entry.planDigest === planDigest);
  require(matches.length === 1, 'Exactly one original runner creation plan or assignment plan must remain in custody.');
  return storedRunnerPlan(input, matches[0]);
}

async function assertIssuedRunnerPlanAt(
  input: PhasePlanningInput, saved: SavedTransitionPlan, observedAt: string,
  storage: UpdatePreviewOptions | undefined = azurePorts(input).storage
): Promise<void> {
  require(Number.isFinite(Date.parse(observedAt)) && Date.parse(observedAt) >= Date.parse(saved.createdAt) &&
    Date.parse(observedAt) < Date.parse(saved.expiresAt), 'Original runner observation is outside its reviewed plan window.');
  const envelopeHash = privateDigest(saved.approval.envelopeHash, 'Original runner approval');
  const record = await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-approval', storage)
    .read(envelopeHash);
  require(record && isRecord(record.value) && record.value.kind === 'liftoff-governance-approval',
    'Original runner creation or reconciliation has no privately issued approval.');
  const envelope = validateApprovalEnvelope(record.value.envelope);
  const evaluation = evaluateApprovalForTransitionPlan(approvalRequestForSavedPlan(saved, runnerPhase(), input.inspection.state),
    [envelope], { now: new Date(observedAt) });
  require(!evaluation.approvalRequired && evaluation.envelopeHash === saved.approval.envelopeHash &&
    evaluation.envelopeId === saved.approval.envelopeId, 'Original runner approval does not authorize its recorded operation.');
  await assertGovernanceApprovalIssued(input.inspection.projectRoot, envelope, storage);
}

async function assertIssuedRunnerCheckpoint(
  input: PhasePlanningInput, saved: SavedTransitionPlan, op: TransitionOperation, checkpoint: PrivateEffectCheckpoint
): Promise<void> {
  require(checkpoint.prepared.planDigest === saved.planDigest && checkpoint.prepared.operationDigest === canonicalSha256(op) &&
    checkpoint.prepared.approvalEnvelopeHash === saved.approval.envelopeHash &&
    checkpoint.prepared.configurationDigest === canonicalSha256(saved.configuration ?? null) &&
    Date.parse(checkpoint.prepared.preparedAt) >= Date.parse(saved.createdAt) &&
    Date.parse(checkpoint.prepared.preparedAt) < Date.parse(saved.expiresAt),
  'Original runner custody is not bound to its actual prepared operation and approval window.');
  await assertIssuedRunnerPlanAt(input, saved, checkpoint.prepared.preparedAt);
}

async function assertPrivateRunnerCreationCustody(
  input: PhasePlanningInput, origin: ReturnType<typeof storedRunnerPlan>, binding: PrivateRunnerAssignmentBinding
): Promise<void> {
  require(!origin.plan.reconciliation &&
    canonicalSha256(assignmentBinding(origin.plan, binding, [])) === canonicalSha256({ ...binding, allowedWorkflows: [] }),
  'Assignment custody cannot rename, move or replace the original dedicated group, network or hosted definition.');
  const readStep = (step: RunnerStep) => {
    const op = origin.operations.find((entry) => entry.inputs.step === step);
    require(op, 'Original runner creation operation is missing.');
    return op;
  };
  const identities = [
    { op: readStep('network-configuration'), intent: networkIntentFor(origin.plan),
      path: `/orgs/${binding.organization}/settings/network-configurations/${binding.networkConfigurationId}` },
    { op: readStep('runner-group'), intent: groupIntentFor(origin.plan, binding.networkConfigurationId),
      path: `/orgs/${binding.organization}/actions/runner-groups/${binding.groupId}` },
    { op: readStep('hosted-runner'), intent: runnerIntentFor(origin.plan, binding.groupId),
      path: `/orgs/${binding.organization}/actions/hosted-runners/${binding.definitionId}` }
  ];
  for (const identity of identities) {
    const checkpoint = await readPrivateEffect(input, identity.op, identity.intent);
    require(checkpoint?.submitted?.status === 201 && checkpoint.submitted.resourceId === identity.path &&
      checkpoint.settled?.outcome === 'verified', 'The exact provider IDs have no independently settled private creation custody.');
    const actual = checkpoint.prepared.planDigest === origin.saved.planDigest ? origin : retainedRunnerPlan(input, checkpoint.prepared.planDigest);
    const actualOp = actual.operations.find((entry) => entry.inputs.step === identity.op.inputs.step);
    require(!actual.plan.reconciliation && actualOp &&
      canonicalSha256(assignmentBinding(actual.plan, binding, [])) === canonicalSha256(assignmentBinding(origin.plan, binding, [])),
    'Resumed runner resources require their own original creation plans; a later approval cannot replace that custody.');
    await assertIssuedRunnerCheckpoint(input, actual.saved, actualOp, checkpoint);
  }
}

async function readPrivateRunnerNetworkDispatchCustody(input: PhasePlanningInput, origin: ReturnType<typeof storedRunnerPlan>) {
  const workflow = privateRunnerWorkflowBinding(origin.plan.source);
  const op = origin.operations.find((entry) => entry.inputs.step === 'network-observation-run');
  require(op, 'Original runner network observation declaration is missing.');
  const shared: PhasePlanningInput = { ...input, adapters: { ...input.adapters, githubActivation: {
    ...input.adapters?.githubActivation, storage: input.adapters?.githubActivation?.storage ?? azurePorts(input).storage
  } } };
  const records = await readWorkflowEffect(shared, op, {
    repositoryId: workflow.repositoryId, ref: `${workflow.ref}:${workflow.workflowId}`, purpose: 'workflow-dispatch', step: 'dispatch'
  }, { workflow, dispatchInputs: { configuration_digest: origin.plan.configurationDigest } });
  const observed = records?.observed ?? records?.response;
  const id = observed?.providerId;
  require(records && observed && id && records.prepared.planDigest === origin.saved.planDigest &&
    records.prepared.approvalEnvelopeHash === origin.saved.approval.envelopeHash &&
    (!records.response || [200, 204].includes(records.response.status)),
    'Original network workflow custody is incomplete or unknown; assignment cannot replace it with a new dispatch.');
  await assertIssuedRunnerPlanAt(input, origin.saved, records.prepared.preparedAt, shared.adapters?.githubActivation?.storage);
  const runId = String(positiveId(Number(id)));
  const resourceId = `/repos/${origin.plan.repository}/actions/runs/${runId}`;
  require(id === runId && [records.response, records.observed].every((record) =>
    !record || (record.providerId === null || record.providerId === runId) &&
    (record.resourceId === null || record.resourceId === resourceId)),
  'Original network workflow custody cannot substitute another repository, run or provider identity.');
  const operation = {
    provider: 'github' as const, actionId: op.actionId, operationId: runId, resourceId,
    startedAt: records.prepared.preparedAt, observedAt: observed.recordedAt, planDigest: records.prepared.planDigest
  };
  return { workflow, operation };
}

async function readRunnerCreationOrigin(input: PhaseAdapterExecutionInput, client: GitHubActivationClient, plan: PrivateRunnerPlan) {
  require(plan.reconciliation, 'Only an explicit assignment reconciliation can read original group ownership.');
  const origin = retainedRunnerPlan(input, plan.reconciliation.originPlanDigest);
  await assertPrivateRunnerCreationCustody(input, origin, assignmentBinding(plan, plan.reconciliation));
  const { workflow, operation } = await readPrivateRunnerNetworkDispatchCustody(input, origin);
  const run = await readBoundWorkflowRun(client, workflow, operation);
  require(run.conclusion === 'success', 'Original network workflow is not settled successfully; no assignment handover is authorized.');
  return origin;
}

export function privateRunnerAssignmentIntent(plan: PrivateRunnerPlan, sequence: number): PrivateEffectIntent {
  require(plan.reconciliation, 'An exact owned group is required for assignment intent.');
  const selected = plan.reconciliation;
  return {
    kind: 'runner-group-assignment', step: `workflow-assignment:${sequence}`, provider: 'github',
    resourceId: `/orgs/${plan.organization}/actions/runner-groups/${selected.groupId}`,
    request: {
      method: 'PATCH', body: { name: plan.runnerGroupName, restricted_to_workflows: true, selected_workflows: selection(plan) },
      expectedWorkflows: selected.expectedWorkflows, originPlanDigest: selected.originPlanDigest,
      binding: assignmentBinding(plan, selected), sources: {
        network: plan.source, backend: plan.backendSource ?? null, application: plan.applicationSources ?? []
      }
    }
  };
}

function revisionKey(binding: Pick<PrivateRunnerAssignmentBinding, 'repositoryId' | 'organizationId' | 'groupId'>, sequence: number): string {
  return canonicalSha256({ kind: 'private-runner-group-revision/1', repositoryId: binding.repositoryId,
    organizationId: binding.organizationId, groupId: binding.groupId, sequence });
}

async function readRunnerAssignmentRevision(
  input: PhasePlanningInput,
  scope: { originPlanDigest: string; binding: PrivateRunnerAssignmentBinding },
  sequence: number, expectedWorkflows: readonly string[]
) {
  const record = await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', azurePorts(input).storage)
    .read(revisionKey(scope.binding, sequence));
  if (!record) return null;
  const value = exactObject(record.value, ['schemaVersion', 'kind', 'groupId', 'originPlanDigest', 'sequence', 'plan'], 'Private runner assignment revision');
  require(record.projectRoot === input.inspection.projectRoot && value.schemaVersion === 1 &&
    value.kind === 'private-runner-group-revision' && value.groupId === scope.binding.groupId &&
    value.originPlanDigest === scope.originPlanDigest && value.sequence === sequence,
  'Assignment revision belongs to another original group or sequence.');
  const prior = storedRunnerPlan(input, value.plan);
  require(prior.plan.reconciliation, 'A runner creation plan cannot be relabeled as an assignment revision.');
  const intent = privateRunnerAssignmentIntent(prior.plan, sequence);
  const operation = prior.operations.find((entry) => entry.inputs.step === 'reconcile-workflow-assignment');
  require(operation && prior.plan.reconciliation.originPlanDigest === scope.originPlanDigest &&
    canonicalSha256(assignmentBinding(prior.plan, prior.plan.reconciliation, [])) ===
      canonicalSha256({ ...scope.binding, allowedWorkflows: [] }) &&
    canonicalSha256(prior.plan.reconciliation.expectedWorkflows) === canonicalSha256(expectedWorkflows),
  'Assignment history cannot move an owned group or forget an earlier workflow transition.');
  const checkpoint = await readPrivateEffect(input, operation, intent);
  require(checkpoint, 'Original assignment revision lost its pre-effect custody; no new write is authorized.');
  await assertIssuedRunnerCheckpoint(input, prior.saved, operation, checkpoint);
  return { ...prior, intent, operation, checkpoint };
}

export interface PrivateRunnerAssignmentCustodyReference {
  reference: QualificationEvidenceReference;
  binding: PrivateRunnerAssignmentBinding;
  sources?: readonly PrivateRunnerApplicationSource[];
}

export type PrivateRunnerCustodyReadInput = PhasePlanningInput & Pick<PhaseAdapterExecutionInput, 'clock' | 'lease'>;

export async function assertPrivateRunnerAssignmentCustody(
  input: PrivateRunnerCustodyReadInput, expected: PrivateRunnerAssignmentCustodyReference,
  options: { authorize(): Promise<void> }
): Promise<void> {
  const deadline = performance.now() + 10_000;
  const authorize = async () => {
    require(performance.now() < deadline, 'Original runner custody admission exceeded its ten-second bound.');
    const held = await currentProjectMutationLease(input.inspection.projectRoot);
    require(held, 'Original runner custody admission requires the actual current project lease.');
    await held.assertHeld();
    await input.lease?.assertHeld();
    await options.authorize();
    require(performance.now() < deadline, 'Original runner custody admission exceeded its ten-second bound.');
    return held;
  };
  const lease = await authorize();
  require(azurePorts(input).storage !== undefined || input.adapters?.githubActivation?.storage === undefined,
    'A custom GitHub private store requires the original private runner metadata store to be selected explicitly; no default-home fallback is permitted.');
  const binding = validatePrivateRunnerAssignment(expected.binding);
  const { record, plan: saved } = requireQualificationEvidence(
    input.inspection, 'runner-ready', expected.reference, input.clock?.() ?? input.now
  );
  const declared = retainedRunnerPlan(input, saved.planDigest);
  const payload = record.payload;
  require(isRecord(payload) && payload.kind === 'runner-ready.v1' &&
    payload.scope === (declared.plan.reconciliation ? 'workflow-assignment-only' : 'network-reachability-only') &&
    isRecord(payload.assignment) && payload.assignment.kind === 'private-runner-assignment-readback/1' &&
    canonicalSha256(payload.assignment.binding) === canonicalSha256(binding) &&
    isRecord(payload.outputBindings) && isRecord(payload.outputBindings.values) &&
    canonicalSha256(assignmentBinding(declared.plan, binding)) === canonicalSha256(binding),
  'The exact original runner receipt and plan do not bind this assignment.');
  const originPlanDigest = privateDigest(payload.outputBindings.values['runner.creationPlanDigest'], 'Original runner creation plan');
  require(!declared.plan.reconciliation || declared.plan.reconciliation.originPlanDigest === originPlanDigest,
    'The original assignment receipt cannot substitute another creation plan.');
  require((expected.sources?.length ?? 0) <= 4, 'Original custody admits at most four exact application workflow sources.');
  const sources = (expected.sources ?? []).map(validatePrivateRunnerApplicationSource);
  require(new Set(sources.map((source) => source.workflowId)).size === sources.length,
    'Original source custody cannot contain duplicate workflow identities.');
  for (const source of sources) require(declared.plan.applicationSources?.filter((candidate) =>
    canonicalSha256(candidate) === canonicalSha256(source)).length === 1,
  'The original private assignment plan does not declare this exact published application source.');
  await assertIssuedRunnerPlanAt(input, declared.saved, record.header.producedAt);
  await authorize();
  const origin = retainedRunnerPlan(input, originPlanDigest);
  await assertPrivateRunnerCreationCustody(input, origin, binding);
  await readPrivateRunnerNetworkDispatchCustody(input, origin);
  await authorize();
  const timeoutMs = Math.floor(deadline - performance.now());
  require(timeoutMs > 0, 'Original runner custody admission exceeded its ten-second bound.');
  const inventory = await readPrivateRunnerCustodyMetadata({ ...input, lease }, { timeoutMs });
  const revisionRecords = inventory.filter(({ value }) => isRecord(value) &&
    value.kind === 'private-runner-group-revision' && value.groupId === binding.groupId &&
    value.originPlanDigest === originPlanDigest);
  require(revisionRecords.length <= 32, 'The complete original assignment inventory exceeds thirty-two retained revisions.');
  const groupPath = `/orgs/${binding.organization}/actions/runner-groups/${binding.groupId}`;
  const prepared = new Set<string>();
  let expectedWorkflows = selection(origin.plan), revisions = 0;
  let declaredRequestRetained = !declared.plan.reconciliation ||
    canonicalSha256(declared.plan.reconciliation.expectedWorkflows) === canonicalSha256(selection(declared.plan));
  for (; revisions < 32; revisions++) {
    await authorize();
    const prior = await readRunnerAssignmentRevision(input, { originPlanDigest, binding }, revisions, expectedWorkflows);
    if (!prior) break;
    const checkpoint = prior.checkpoint;
    require(checkpoint.settled, 'Original assignment custody has an unresolved provider effect; no application access or dispatch is admitted.');
    prepared.add(canonicalSha256(checkpoint.prepared));
    if (checkpoint.settled.outcome === 'verified') {
      require(checkpoint.submitted?.status === 200 && checkpoint.submitted.resourceId === groupPath,
        'A verified assignment requires its actual successful ID-addressed provider PATCH receipt.');
      expectedWorkflows = selection(prior.plan);
      if (declared.plan.reconciliation &&
        canonicalSha256(prior.intent.request) === canonicalSha256(privateRunnerAssignmentIntent(declared.plan, revisions).request)) {
        declaredRequestRetained = true;
      }
    } else if (checkpoint.settled.outcome === 'rejected') {
      require(checkpoint.submitted && [401, 403, 404, 422].includes(checkpoint.submitted.status),
        'An ambiguous provider outcome is not an independently known assignment rejection.');
    }
  }
  require(revisions === revisionRecords.length,
    'Original assignment revision inventory has a gap or an unindexed record; absent pointers cannot establish custody.');
  for (const { value } of inventory) {
    if (isRecord(value) && value.kind === 'private-access-prepared' && isRecord(value.intent) &&
      value.intent.kind === 'runner-group-assignment' && value.intent.resourceId === groupPath) {
      require(prepared.has(canonicalSha256(value)),
        'An original group assignment effect lost its revision index or lies outside the admitted chain; no new application dispatch is authorized.');
    }
  }
  require(declaredRequestRetained && canonicalSha256(expectedWorkflows) === canonicalSha256(binding.allowedWorkflows),
    'Current private assignment history does not retain the exact declared allowlist; a public receipt or matching group name cannot replace it.');
  await authorize();
}

export async function readPrivateRunnerAssignmentForConsumer(
  input: PrivateRunnerCustodyReadInput, client: GitHubActivationClient, expected: PrivateRunnerAssignmentCustodyReference,
  options: {
    authorize(): Promise<void>;
    run?: { workflow: WorkflowRunBinding; operation: ExternalOperationState | RecordedWorkflowRunIdentity };
  }
): Promise<PrivateRunnerAssignmentObservation> {
  const reference = structuredClone(expected);
  const run = options.run ? structuredClone(options.run) : undefined;
  const authorize = options.authorize;
  await assertPrivateRunnerAssignmentCustody(input, reference, { authorize });
  const observed = await verifyPrivateRunnerAssignment(client, reference.binding, {
    authorize, now: () => input.clock?.() ?? input.now, sources: reference.sources, ...(run ? { run } : {})
  });
  await assertPrivateRunnerAssignmentCustody(input, reference, { authorize });
  return observed;
}

async function executeRunnerReconciliation(
  input: PhaseAdapterExecutionInput, plan: PrivateRunnerPlan, reviewed: readonly TransitionOperation[],
  ports: { client?: GitHubActivationClient; pollAttempts?: number }
): Promise<PhaseAdapterOutcome> {
  const [readOp, patchOp] = reviewed;
  require(readOp && patchOp && reviewed.length === 2, 'The exact reconciliation read/write pair is required.');
  const attempts = ports.pollAttempts ?? 3;
  require(Number.isSafeInteger(attempts) && attempts >= 1 && attempts <= 5, 'Assignment readback requires one through five bounded observations.');
  const authorize = async () => {
    await assertAzurePhaseAuthority(input, readOp);
    await assertAzurePhaseAuthority(input, patchOp);
    require(Date.parse(plan.expiresAt) > (input.clock?.() ?? input.now).getTime(), 'The exact runner reconciliation window expired.');
  };
  await authorize();
  let close: (() => void) | null = null;
  let retainedOperation: ExternalOperationState | undefined;
  const completedOperations: TransitionOperation[] = [];
  try {
    let client = ports.client ?? (input.adapters.githubActivation?.transport ? clientFor(input) : undefined);
    if (!client) {
      const session = await openPrivateRunnerGitHubSession(input.runner, input.inspection.projectRoot, plan.actorId);
      client = session.client; close = session.close;
    }
    const selectedClient = client;
    client = new GitHubActivationClient({
      async request(request) {
        require(request.method === 'GET' || request.method === 'PATCH' &&
          request.path === `/orgs/${plan.organization}/actions/runner-groups/${plan.reconciliation!.groupId}`,
        'Assignment reconciliation cannot create resources, change another group or dispatch a workflow.');
        await authorize();
        return selectedClient.transport.request(request);
      }
    });
    await assertRunnerAdministrator(client, plan);
    const origin = await readRunnerCreationOrigin(input, client, plan);
    const selected = plan.reconciliation!, desired = selection(plan);
    const target = assignmentBinding(plan, selected);
    const groupPath = `/orgs/${plan.organization}/actions/runner-groups/${selected.groupId}`;
    const store = createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', azurePorts(input).storage);
    let expectedOwned = selection(origin.plan), next = 0;
    let active: { checkpoint: PrivateEffectCheckpoint; intent: PrivateEffectIntent; saved: SavedTransitionPlan } | null = null;
    let lastApproval: string | null = null;
    for (; next < 32; next++) {
      const prior = await readRunnerAssignmentRevision(input, { originPlanDigest: selected.originPlanDigest, binding: target }, next, expectedOwned);
      if (!prior) break;
      const { checkpoint, intent: priorRequest } = prior;
      lastApproval = checkpoint.prepared.approvalEnvelopeHash;
      if (!checkpoint.settled) {
        require(canonicalSha256(priorRequest.request) === canonicalSha256(privateRunnerAssignmentIntent(plan, next).request),
          'An unresolved group assignment cannot be evaded by selecting a new source or desired allowlist.');
        active = { checkpoint, intent: priorRequest, saved: prior.saved };
        break;
      }
      if (checkpoint.settled.outcome === 'verified') expectedOwned = selection(prior.plan);
      if (canonicalSha256(priorRequest.request) === canonicalSha256(privateRunnerAssignmentIntent(plan, next).request)) {
        active = { checkpoint, intent: priorRequest, saved: prior.saved };
      } else active = null;
    }
    require(next < 32 || active?.checkpoint.settled?.outcome === 'verified',
      'Thirty-two retained assignment revisions exhaust the supported bound; no history is replaced.');
    const retainOperation = (checkpoint: PrivateEffectCheckpoint) => {
      if (!checkpoint.submitted) return;
      retainedOperation = {
        provider: 'github', actionId: patchOp.actionId, operationId: checkpoint.submitted.requestId,
        resourceId: checkpoint.submitted.resourceId, startedAt: checkpoint.prepared.preparedAt,
        observedAt: (input.clock?.() ?? input.now).toISOString(),
        status: checkpoint.submitted.status === 200 ? checkpoint.settled?.outcome === 'verified' ? 'completed' : 'running' : 'failed',
        planDigest: checkpoint.prepared.planDigest
      };
    };
    if (active) retainOperation(active.checkpoint);
    if (active && !active.checkpoint.settled) require(active.checkpoint.submitted?.status === 200 &&
      active.checkpoint.submitted.resourceId === groupPath,
    'Assignment dispatch outcome is unknown or unconfirmed. Preserve the exact checkpoint; matching state or another GET request ID cannot authorize retry or fabricate the lost PATCH receipt.');
    await readRunnerSources(client, plan, true);
    completedOperations.push(readOp);
    const observe = (allowedWorkflows: readonly string[], sources = false) => verifyPrivateRunnerAssignment(client!, {
      ...target, allowedWorkflows
    }, { authorize, now: () => input.clock?.() ?? input.now, ...(sources ? { sources: plan.applicationSources } : {}) });
    const completed = async (disposition: string, mutationRequestId: string | null): Promise<PhaseAdapterOutcome> => {
      const assignment = await observe(desired, true);
      await readRunnerSources(client!, plan, true);
      return {
        status: 'completed', resultState: 'verified', completedOperations: [...reviewed],
        evidencePayload: { kind: 'runner-ready.v1', scope: 'workflow-assignment-only', disposition, mutationRequestId,
          organization: plan.organization, organizationId: plan.organizationId, repository: plan.repository, repositoryId: plan.repositoryId,
          groupId: selected.groupId, hostedRunnerDefinitionId: selected.definitionId, networkConfigurationId: selected.networkConfigurationId,
          assignment, applicationSources: plan.applicationSources ?? [], originPlanDigest: selected.originPlanDigest,
          networkReachability: 'not-reprobed', atomicAcrossClients: false },
        liveReadback: [
          readbackProof(input, 'github', 'runner-group', groupPath, assignment),
          readbackProof(input, 'github', 'private-runner', `/orgs/${plan.organization}/actions/hosted-runners/${selected.definitionId}`, assignment),
          readbackProof(input, 'github', 'runner-network-configuration', `/orgs/${plan.organization}/settings/network-configurations/${selected.networkConfigurationId}`, assignment)
        ],
        outputs: { values: {
          'runner.groupId': selected.groupId, 'runner.definitionId': selected.definitionId,
          'runner.networkConfigurationId': selected.networkConfigurationId, 'runner.networkSettingsId': plan.networkSettingsId,
          'runner.allowedWorkflowsDigest': canonicalSha256(desired), 'runner.creationPlanDigest': selected.originPlanDigest,
          'runner.applicationSourcesDigest': canonicalSha256(plan.applicationSources ?? []),
          ...(plan.backendSource ? {
            'runner.backendWorkflowId': plan.backendSource.workflowId, 'runner.backendWorkflowPath': plan.backendSource.recipe.workflowPath,
            'runner.backendWorkflowSourceSha': plan.backendSource.sourceSha, 'runner.backendWorkflowDigest': plan.backendSource.workflowDigest,
            'runner.backendWorkflowRef': plan.backendSource.ref, 'runner.backendWorkflowActorId': plan.backendSource.actorId
          } : {})
        }, resources: [
          { provider: 'github', resourceType: 'runner-group', resourceId: groupPath },
          { provider: 'github', resourceType: 'private-runner', resourceId: `/orgs/${plan.organization}/actions/hosted-runners/${selected.definitionId}` }
        ] },
        cleanupWarnings: ['Only the exact owned workflow allowlist was reconciled. No network/runner replacement, application dispatch, DAST qualification or cross-client atomic rollback is claimed.']
      };
    };
    if (active?.checkpoint.settled?.outcome === 'verified') return await completed('recorded-assignment-readback', active.checkpoint.submitted!.requestId);
    if (!active || active.checkpoint.settled) {
      require(canonicalSha256(selected.expectedWorkflows) === canonicalSha256(expectedOwned),
        'The reviewed before-state differs from the original private creation/reconciliation history.');
      await observe(selected.expectedWorkflows);
      if (canonicalSha256(selected.expectedWorkflows) === canonicalSha256(desired)) return await completed('already-matching', null);
      if (lastApproval) require(input.plan.approval.envelopeHash !== lastApproval,
        'A new assignment revision needs a fresh privately issued approval.');
      const intent = privateRunnerAssignmentIntent(plan, next);
      require(!await readPrivateEffect(input, patchOp, intent),
        'An assignment pre-effect checkpoint exists without its original revision index; no redispatch or namespace reset is authorized.');
      const checkpoint = await preparePrivateEffect(input, patchOp, intent);
      await store.write(revisionKey(target, next), {
        schemaVersion: 1, kind: 'private-runner-group-revision', groupId: selected.groupId,
        originPlanDigest: selected.originPlanDigest, sequence: next, plan: input.plan
      });
      active = { checkpoint, intent, saved: input.plan };
      try {
        await authorize();
        await readRunnerSources(client, plan, true);
        await observe(selected.expectedWorkflows);
        const fresh = await exactGet(client, groupPath);
        await assertPrivateRunnerGroup(client, fresh.value, plan, selected.groupId, selected.networkConfigurationId, selected.expectedWorkflows);
        require(fresh.value.workflow_restrictions_read_only !== true, 'The provider marks this group workflow restriction as read-only.');
      } catch (error) {
        active.checkpoint = await settlePrivateEffect(input, active.checkpoint, {
          outcome: 'not-dispatched', readbackRequestId: null, readbackDigest: null
        });
        throw error;
      }
      const response = await client.transport.request({ method: 'PATCH', path: groupPath, body: intent.request.body });
      const body = isRecord(response.data) ? response.data : {};
      const returnedPath = Number.isSafeInteger(body.id) && Number(body.id) > 0
        ? `/orgs/${plan.organization}/actions/runner-groups/${body.id}` : `/orgs/${plan.organization}/actions/runner-groups`;
      active.checkpoint = await submitPrivateEffect(input, active.checkpoint, {
        requestId: requestId(response), resourceId: returnedPath, status: response.status
      });
      retainOperation(active.checkpoint);
      if ([401, 403, 404, 422].includes(response.status)) {
        active.checkpoint = await settlePrivateEffect(input, active.checkpoint, {
          outcome: 'rejected', readbackRequestId: requestId(response), readbackDigest: canonicalSha256({ status: response.status })
        });
      }
      require(response.status === 200 && returnedPath === groupPath,
        'The provider did not confirm this exact group assignment. Its returned or uncertain outcome is retained, not retried.');
    }
    for (let attempt = 0; attempt < attempts; attempt++) {
      await authorize();
      const group = await exactGet(client, groupPath);
      if (canonicalSha256(group.value.selected_workflows) === canonicalSha256(desired)) {
        const observation = await observe(desired);
        active.checkpoint = await settlePrivateEffect(input, active.checkpoint, {
          outcome: 'verified', readbackRequestId: group.requestId, readbackDigest: canonicalSha256(observation)
        });
        retainOperation(active.checkpoint);
        completedOperations.push(patchOp);
        return await completed('reconciled-and-read-back', active.checkpoint.submitted!.requestId);
      }
      await assertPrivateRunnerGroup(client, group.value, plan, selected.groupId, selected.networkConfigurationId, selected.expectedWorkflows);
    }
    return {
      status: 'pending', blocker: 'The actual returned assignment is not yet independently visible; no PATCH is repeated.',
      completedOperations: [readOp],
      operation: { provider: 'github', actionId: patchOp.actionId, operationId: active.checkpoint.submitted!.requestId,
        resourceId: groupPath, startedAt: active.checkpoint.prepared.preparedAt, observedAt: (input.clock?.() ?? input.now).toISOString(),
        status: 'running', planDigest: active.checkpoint.prepared.planDigest }
    };
  } catch (error) {
    return {
      status: 'blocked', blocker: error instanceof AzureActivationAdmissionError ? error.message : safeGitHubFailure(error),
      completedOperations, ...(retainedOperation ? { operation: retainedOperation } : {}),
      cleanupWarnings: ['The exact owned group revision and any returned provider request are retained. No unknown PATCH is retried, foreign control is adopted, or rollback/deletion is attempted.']
    };
  } finally { close?.(); }
}

async function createRunnerObject(
  input: PhaseAdapterExecutionInput, client: GitHubActivationClient, op: TransitionOperation,
  intent: PrivateEffectIntent, resourcePath: (id: unknown) => string,
  verify: (value: Record<string, unknown>, path: string) => Promise<void>
): Promise<{ path: string; value: Record<string, unknown>; checkpoint: PrivateEffectCheckpoint }> {
  let checkpoint = await readPrivateEffect(input, op, intent);
  if (checkpoint && !checkpoint.submitted) throw new GitHubActivationError('private-runner-unknown',
    'A private runner POST has an unknown outcome. Its pre-effect checkpoint is retained; matching names are not ownership or redispatch authority.');
  if (checkpoint?.settled && checkpoint.settled.outcome !== 'verified') throw new GitHubActivationError('private-runner-recovery',
    'A prior private runner request failed. Do not create a replacement under the same checkpoint; inspect and separately review recovery.');
  if (!checkpoint) {
    checkpoint = await preparePrivateEffect(input, op, intent);
    await assertAzurePhaseAuthority(input, op);
    const response = await client.transport.request({ method: 'POST', path: intent.resourceId, body: intent.request.body });
    const returned = object(response.data ?? {});
    const path = returned.id === undefined ? intent.resourceId : resourcePath(returned.id);
    checkpoint = await submitPrivateEffect(input, checkpoint, {
      requestId: requestId(response), status: response.status, resourceId: path
    });
    if (response.status !== 201 || path === intent.resourceId) {
      await settlePrivateEffect(input, checkpoint, {
        outcome: 'rejected', readbackRequestId: requestId(response),
        readbackDigest: canonicalSha256({ status: response.status, resourceId: path })
      });
      throw new GitHubActivationError('private-runner-rejected', 'GitHub did not confirm creation with an actual resource ID; no further effects or rollback are attempted.');
    }
  }
  const path = checkpoint.submitted!.resourceId;
  require(path.startsWith(`${intent.resourceId}/`) && /^[A-Za-z0-9_-]+$/u.test(path.slice(intent.resourceId.length + 1)),
    'Returned private runner custody cannot redirect readback to another organization or provider endpoint.');
  const readback = await exactGet(client, path);
  await verify(readback.value, path);
  if (!checkpoint.settled) checkpoint = await settlePrivateEffect(input, checkpoint, {
    outcome: 'verified', readbackRequestId: readback.requestId, readbackDigest: canonicalSha256(readback.value)
  });
  return { path, value: readback.value, checkpoint };
}

async function collision(
  input: PhaseAdapterExecutionInput, client: GitHubActivationClient, op: TransitionOperation, intent: PrivateEffectIntent,
  collection: string, name: string
): Promise<void> {
  if (await readPrivateEffect(input, op, intent)) return;
  const values = await client.list(intent.resourceId, collection);
  require(!values.some((value) => value.name === name), 'A matching existing resource has no private creation custody. Names cannot authorize reuse, reassignment or replacement.');
}

export async function executePrivateRunner(
  input: PhaseAdapterExecutionInput, ports: { client?: GitHubActivationClient; pollAttempts?: number } = {}
): Promise<PhaseAdapterOutcome> {
  const completed: TransitionOperation[] = [];
  let closeSession: (() => void) | null = null;
  try {
    const current = planPrivateRunner(input);
    const reviewed = input.plan.operations.filter((entry) =>
      entry.actionId === 'github.runner.ensure-ready' || entry.actionId === privateRunnerReachabilityAction);
    if (current.blockers?.length || canonicalSha256(current.operations) !== canonicalSha256(reviewed)) return {
      status: 'blocked', blocker: current.blockers?.join(' ') ?? 'The exact dedicated runner plan changed after approval.', completedOperations: []
    };
    const plan = privateRunnerPlanForInspection(input);
    const admission = reviewed.find((entry) => entry.mutationClass === 'github-read');
    require(admission, 'Runner execution requires its exact reviewed read admission.');
    await assertAzurePhaseAuthority(input, admission);
    await assertNoLegacyRunnerDispatchCustody(input);
    if (plan.reconciliation) return await executeRunnerReconciliation(input, plan, reviewed, ports);
    const [readOp, networkOp, groupOp, runnerOp, workflowOp] = reviewed as [TransitionOperation, TransitionOperation, TransitionOperation, TransitionOperation, TransitionOperation];
    const attempts = ports.pollAttempts ?? 3;
    require(Number.isSafeInteger(attempts) && attempts >= 1 && attempts <= 5, 'Private runner polling must remain within one through five observations.');
    await assertAzurePhaseAuthority(input, readOp);
    const workflow = privateRunnerWorkflowBinding(plan.source);
    const dispatchInputs = { configuration_digest: plan.configurationDigest };
    const sharedInput: PhaseAdapterExecutionInput = {
      ...input, adapters: { ...input.adapters, githubActivation: {
        ...input.adapters.githubActivation, storage: input.adapters.githubActivation?.storage ?? azurePorts(input).storage
      } }
    };
    await assertGitHubPhaseAuthority(sharedInput, workflowOp);
    const priorPlans = input.inspection.contexts['runner-ready'].reviewedPlans ?? [];
    require(!priorPlans.some((prior) => prior.phaseId === 'runner-ready' && prior.operations.some((op) =>
      op.actionId === 'github.runner.ensure-ready' && (op.mutationClass === 'github-workflow-dispatch' ||
        op.effects?.some((effect) => effect.mutationClass === 'github-workflow-dispatch')))),
    'A retained legacy runner dispatch plan requires explicit original-custody recovery before shared dispatch, even when its checkpoint or workflow target is no longer present in the current inputs.');
    const dispatchPath = `/repos/${plan.repository}/actions/workflows/${plan.source.workflowId}/dispatches`;
    const legacyIntent: PrivateEffectIntent = {
      kind: 'runner-workflow-dispatch', step: 'network-observation', provider: 'github', resourceId: dispatchPath,
      request: { method: 'POST', workflowSource: plan.source, configurationDigest: plan.configurationDigest }
    };
    // Lookup only: existing custody must not become a fresh shared-namespace dispatch.
    const legacyOperation = githubOperation(input, 'github.runner.ensure-ready', 'github-write', {
      step: 'network-observation-run', plan
    }, undefined, [{
      mutationClass: 'github-workflow-dispatch', destination: { type: 'repository', identity: plan.repository, repository: plan.repository },
      remote: true, destructive: false
    }]);
    require(!await readPrivateEffect(input, legacyOperation, legacyIntent),
      'An earlier private-access dispatch checkpoint requires explicit recovery before switching to the shared dispatcher. It cannot be silently ignored or retagged into a new namespace.');
    const dispatchIdentity = {
      repositoryId: workflow.repositoryId, ref: `${workflow.ref}:${workflow.workflowId}`,
      purpose: 'workflow-dispatch' as const, step: 'dispatch' as const
    };
    const priorDispatch = await readWorkflowEffect(sharedInput, workflowOp, dispatchIdentity, { workflow, dispatchInputs });
    const priorOperation = input.inspection.state.phases['runner-ready'].operation;
    const pendingPool = priorOperation?.provider === 'github' && priorOperation.actionId === 'github.runner.ensure-ready' &&
      /^[1-9][0-9]*$/u.test(priorOperation.operationId) &&
      priorOperation.resourceId === `/orgs/${plan.organization}/actions/hosted-runners/${priorOperation.operationId}`;
    const priorRun = priorOperation && !pendingPool ? priorOperation : null;
    if (priorRun) {
      const recordedId = priorDispatch?.observed?.providerId ?? priorDispatch?.response?.providerId;
      require(priorRun.provider === 'github' && priorRun.actionId === privateRunnerReachabilityAction &&
        /^[1-9][0-9]*$/u.test(priorRun.operationId) &&
        priorRun.resourceId === `/repos/${plan.repository}/actions/runs/${priorRun.operationId}` &&
        priorDispatch && priorRun.planDigest === priorDispatch.prepared.planDigest &&
        (!recordedId || recordedId === priorRun.operationId) &&
        (!priorDispatch.response || [200, 204].includes(priorDispatch.response.status)),
      'The recorded runner workflow has no matching original shared dispatch custody. Preserve its known or unknown run; an empty namespace never authorizes another dispatch.');
    }
    let client = ports.client;
    if (!client && input.adapters.githubActivation?.transport) client = clientFor(input);
    if (!client) {
      const session = await openPrivateRunnerGitHubSession(input.runner, input.inspection.projectRoot, plan.actorId);
      client = session.client;
      closeSession = session.close;
    }
    await assertRunnerAdministrator(client, plan);
    const settings = await client.get(`/orgs/${plan.organization}/settings/network-settings/${plan.networkSettingsId}`);
    require(settings.id === plan.networkSettingsId && settings.subnet_id === plan.subnetId && settings.region === plan.region,
      'GitHub network settings do not independently confirm the exact Azure subnet and region established by bootstrap.');
    const images = await client.list(`/orgs/${plan.organization}/actions/hosted-runners/images/github-owned`, 'images');
    const sizes = await client.list(`/orgs/${plan.organization}/actions/hosted-runners/machine-sizes`, 'machine_sizes');
    require(images.filter((image) => image.id === plan.imageId && image.source === 'github' && ['linux-x64', 'linux'].includes(String(image.platform))).length === 1 &&
      sizes.filter((size) => size.id === plan.machineSize).length === 1, 'The exact larger Linux runner image/machine combination is unavailable to this organization.');
    await readRunnerSources(client, plan, false);
    completed.push(readOp);
    const orgBase = `/orgs/${plan.organization}`;
    const networkIntent = networkIntentFor(plan);
    if (settings.network_configuration_id !== undefined && settings.network_configuration_id !== null && settings.network_configuration_id !== '') {
      const owner = await readPrivateEffect(input, networkOp, networkIntent);
      require(owner?.submitted?.resourceId === `${orgBase}/settings/network-configurations/${networkId(settings.network_configuration_id)}`,
        'The Azure network settings are already assigned to a network configuration without this repository operation custody. No foreign assignment is changed.');
    }
    await collision(input, client, networkOp, networkIntent, 'network_configurations', plan.networkConfigurationName);
    const network = await createRunnerObject(input, client, networkOp, networkIntent,
      (id) => `${orgBase}/settings/network-configurations/${networkId(id)}`,
      async (value, path) => checkNetwork(value, plan, networkId(path.split('/').at(-1))));
    const networkConfigurationId = networkId(network.value.id);
    completed.push(networkOp);
    const groupIntent = groupIntentFor(plan, networkConfigurationId);
    await collision(input, client, groupOp, groupIntent, 'runner_groups', plan.runnerGroupName);
    const group = await createRunnerObject(input, client, groupOp, groupIntent,
      (id) => `${orgBase}/actions/runner-groups/${positiveId(id)}`,
      async (value, path) => checkGroup(client, value, plan, positiveId(Number(path.split('/').at(-1))), networkConfigurationId));
    const groupId = positiveId(group.value.id);
    completed.push(groupOp);
    const runnerIntent = runnerIntentFor(plan, groupId);
    await collision(input, client, runnerOp, runnerIntent, 'runners', plan.runnerName);
    const runner = await createRunnerObject(input, client, runnerOp, runnerIntent,
      (id) => `${orgBase}/actions/hosted-runners/${positiveId(id)}`,
      async (value, path) => checkRunner(value, plan, positiveId(Number(path.split('/').at(-1))), groupId));
    const runnerId = positiveId(runner.value.id);
    let runnerValue = runner.value;
    for (let poll = 1; runnerValue.status === 'Provisioning' && poll < attempts; poll++) {
      await assertAzurePhaseAuthority(input, readOp);
      runnerValue = (await exactGet(client, runner.path)).value;
      checkRunner(runnerValue, plan, runnerId, groupId);
    }
    if (runnerValue.status !== 'Ready') return {
      status: 'pending', blocker: 'The actual dedicated hosted runner is not ready; no substitute fleet is adopted.',
      completedOperations: completed,
      operation: { provider: 'github', actionId: runnerOp.actionId, operationId: String(runnerId), resourceId: runner.path,
        startedAt: runner.checkpoint.prepared.preparedAt, observedAt: (input.clock?.() ?? input.now).toISOString(),
        status: 'running', planDigest: input.plan.planDigest }
    };
    completed.push(runnerOp);
    const workflowInput: PhaseAdapterExecutionInput = {
      ...sharedInput, adapters: { ...sharedInput.adapters, githubActivation: {
        ...sharedInput.adapters.githubActivation, transport: client.transport, pollAttempts: attempts
      } }
    };
    const dispatched = await dispatchApprovedWorkflowRun(workflowInput, workflowOp, workflow, dispatchInputs);
    require(!priorRun || dispatched.operation.operationId === priorRun.operationId &&
      dispatched.operation.planDigest === priorRun.planDigest,
    'Current provider readback contradicts the original recorded runner workflow; no substitute run is adopted.');
    if (dispatched.status === 'pending') return {
      status: 'pending', blocker: 'The exact repository-dedicated network reachability workflow has not completed.',
      completedOperations: completed, operation: dispatched.operation
    };
    require(dispatched.run.conclusion === 'success', 'A settled failed private runner workflow does not establish network reachability.');
    const records = await readWorkflowEffect(workflowInput, workflowOp, dispatchIdentity, { workflow, dispatchInputs });
    require(records, 'The shared workflow dispatcher has no retained correlation checkpoint for this operation.');
    const runId = positiveId(Number(dispatched.operation.operationId));
    const proof = await observePrivateRunnerRun(client, plan.source, {
      runId, runAttempt: workflow.runAttempt, correlationId: records.prepared.correlationId,
      configurationDigest: plan.configurationDigest
    }, groupId, plan.runnerName, input.clock?.() ?? input.now, dispatched.operation);
    if (proof.status === 'pending') return {
      status: 'blocked', blocker: 'The settled provider run is no longer independently observable for current network proof.',
      completedOperations: completed, operation: dispatched.operation
    };
    await assertAzurePhaseAuthority(input, readOp);
    const finalNetwork = await exactGet(client, network.path), finalGroup = await exactGet(client, group.path), finalRunner = await exactGet(client, runner.path);
    checkNetwork(finalNetwork.value, plan, networkConfigurationId);
    await checkGroup(client, finalGroup.value, plan, groupId, networkConfigurationId);
    checkRunner(finalRunner.value, plan, runnerId, groupId);
    require(finalRunner.value.status === 'Ready', 'The exact runner stopped being ready during network proof.');
    const assignment = await verifyPrivateRunnerAssignment(client, assignmentBinding(plan, {
      groupId, definitionId: runnerId, networkConfigurationId
    }), {
      sources: plan.applicationSources, now: () => input.clock?.() ?? input.now,
      authorize: () => assertAzurePhaseAuthority(input, readOp)
    });
    completed.push(workflowOp);
    const payload = {
      kind: 'runner-ready.v1', planDigest: plan.planDigest,
      organization: plan.organization, organizationId: plan.organizationId, repository: plan.repository, groupId,
      repositoryId: plan.repositoryId, networkSettingsId: plan.networkSettingsId,
      networkConfigurationId, runnerGroupId: groupId, hostedRunnerDefinitionId: runnerId,
      runId, runAttempt: workflow.runAttempt, runnerId: proof.report.job.runnerId,
      artifactId: proof.artifactId, reportDigest: proof.reportDigest, report: proof.report,
      assignment,
      ...(plan.applicationSources ? { applicationSources: plan.applicationSources } : {}),
      scope: 'network-reachability-only'
    };
    return {
      status: 'completed', resultState: 'verified', completedOperations: completed, evidencePayload: payload,
      operation: dispatched.operation,
      liveReadback: [
        readbackProof(input, 'github', 'private-runner', runner.path, finalRunner.value),
        readbackProof(input, 'github', 'runner-group', group.path, finalGroup.value),
        readbackProof(input, 'github', 'runner-network-configuration', network.path, finalNetwork.value),
        readbackProof(input, 'github', 'workflow-run', dispatched.operation.resourceId, proof.report)
      ],
      outputs: {
        values: { 'runner.groupId': groupId, 'runner.definitionId': runnerId, 'runner.networkConfigurationId': networkConfigurationId,
          'runner.networkSettingsId': plan.networkSettingsId, 'runner.runId': runId, 'runner.runAttempt': workflow.runAttempt,
          'runner.correlationId': records.prepared.correlationId, 'runner.configurationDigest': plan.configurationDigest,
          'runner.reportDigest': proof.reportDigest, 'runner.allowedWorkflowsDigest': canonicalSha256(selection(plan)),
          'runner.creationPlanDigest': records.prepared.planDigest,
          ...(plan.applicationSources ? { 'runner.applicationSourcesDigest': canonicalSha256(plan.applicationSources) } : {}),
          ...(plan.backendSource ? {
            'runner.backendWorkflowId': plan.backendSource.workflowId, 'runner.backendWorkflowPath': plan.backendSource.recipe.workflowPath,
            'runner.backendWorkflowSourceSha': plan.backendSource.sourceSha, 'runner.backendWorkflowDigest': plan.backendSource.workflowDigest,
            'runner.backendWorkflowRef': plan.backendSource.ref, 'runner.backendWorkflowActorId': plan.backendSource.actorId
          } : {}) },
        resources: [
          { provider: 'github', resourceType: 'runner-group', resourceId: group.path },
          { provider: 'github', resourceType: 'private-runner', resourceId: runner.path },
          { provider: 'github', resourceType: 'workflow-run', resourceId: dispatched.operation.resourceId }
        ]
      }
    };
  } catch (error) {
    return {
      status: 'blocked', blocker: error instanceof AzureActivationAdmissionError ? error.message : safeGitHubFailure(error),
      completedOperations: completed,
      cleanupWarnings: ['Created or explicitly reconciled runner resources retain their private effect custody. No cross-provider rollback, unreviewed reassignment or automatic deletion is attempted.']
    };
  } finally { closeSession?.(); }
}
