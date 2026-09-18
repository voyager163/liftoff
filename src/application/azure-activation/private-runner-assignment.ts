import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import {
  GitHubActivationClient, GitHubActivationError, object, positiveId, text, type GitHubResponse
} from '../../adapters/github/activation-rest.js';
import {
  readBoundWorkflowRun, validateWorkflowRunBinding, type RecordedWorkflowRunIdentity, type WorkflowRunBinding
} from '../../adapters/github/workflow-run-readback.js';
import type { ExternalOperationState } from '../../domain/governance/activation/types.js';
import { validatePrivateRunnerAssignment, type PrivateRunnerAssignmentBinding } from './private-runner-assignment-binding.js';
export {
  validatePrivateRunnerAssignment, privateRunnerNetworkId, type PrivateRunnerAssignmentBinding
} from './private-runner-assignment-binding.js';
import {
  assertPrivateApplicationWorkflowRouting, privateApplicationWorkflowJob, privateApplicationWorkflowSelector,
  readPrivateRunnerApplicationSource, validatePrivateRunnerApplicationSource,
  type PrivateRunnerApplicationSource, type PrivateRunnerApplicationSourceObservation
} from './private-runner-application-sources.js';

export interface PrivateRunnerAssignmentObservation {
  kind: 'private-runner-assignment-readback/1';
  binding: PrivateRunnerAssignmentBinding;
  requestIds: readonly string[];
  sources: readonly PrivateRunnerApplicationSourceObservation[];
  job: PrivateRunnerJobObservation | null;
  observedAt: string;
}

export interface PrivateRunnerJobObservation {
  workflowId: number;
  runId: number;
  runAttempt: number;
  jobId: number;
  jobName: string;
  checkRunId: number;
  runnerId: number;
  runnerName: string;
  runnerGroupId: number;
  runnerGroupName: string;
  labels: readonly string[];
  sourceSha: string;
  producerSourceSha: string;
  conclusion: 'success' | 'failure';
}

function require(value: unknown, message: string): asserts value {
  if (!value) throw new GitHubActivationError('private-runner-assignment', message);
}

export function privateRunnerRequestId(response: GitHubResponse): string {
  const id = response.headers['x-github-request-id'];
  require(typeof id === 'string' && /^[A-Fa-f0-9]{4}:[A-Fa-f0-9:]{4,100}$/u.test(id),
    'GitHub must return its actual request identity; no client correlation or guessed ID is substituted.');
  return id;
}

export async function readPrivateRunnerObject(client: GitHubActivationClient, path: string) {
  const response = await client.transport.request({ method: 'GET', path });
  require(response.status === 200, 'An exact private runner resource could not be independently read back.');
  return { value: object(response.data), requestId: privateRunnerRequestId(response) };
}

export function assertPrivateRunnerNetwork(
  value: Record<string, unknown>,
  expected: Pick<PrivateRunnerAssignmentBinding, 'networkConfigurationName' | 'networkSettingsId'>,
  id: string
): void {
  require(Object.keys(value).every((key) => ['id', 'name', 'compute_service', 'network_settings_ids',
    'failover_network_settings_ids', 'failover_network_enabled', 'created_on'].includes(key)),
  'Network configuration contains an unrecognized control field.');
  require(value.id === id && value.name === expected.networkConfigurationName && value.compute_service === 'actions' &&
    canonicalSha256(value.network_settings_ids) === canonicalSha256([expected.networkSettingsId]) &&
    (value.failover_network_enabled === undefined || value.failover_network_enabled === false) &&
    (value.failover_network_settings_ids === undefined || canonicalSha256(value.failover_network_settings_ids) === canonicalSha256([])),
  'Runner network configuration selects another network or an unreviewed failover.');
}

export async function assertPrivateRunnerGroup(
  client: GitHubActivationClient, value: Record<string, unknown>,
  expected: Pick<PrivateRunnerAssignmentBinding, 'repository' | 'repositoryId' | 'organization' | 'runnerGroupName'>,
  id: number, network: string, allowedWorkflows: readonly string[]
): Promise<void> {
  require(Object.keys(value).every((key) => ['id', 'name', 'visibility', 'default', 'selected_repositories_url',
    'selected_repository_ids', 'runners_url', 'hosted_runners_url', 'network_configuration_id', 'inherited',
    'inherited_allows_public_repositories', 'allows_public_repositories', 'workflow_restrictions_read_only',
    'restricted_to_workflows', 'selected_workflows'].includes(key)),
  'Runner group contains an unrecognized control field.');
  require(value.id === id && value.name === expected.runnerGroupName && value.visibility === 'selected' &&
    value.default === false && value.inherited === false && value.allows_public_repositories === false &&
    value.network_configuration_id === network && value.restricted_to_workflows === true &&
    canonicalSha256(value.selected_workflows) === canonicalSha256(allowedWorkflows),
  'The exact group is not bound exclusively to the reviewed network, repository and workflow allowlist.');
  const repositories = await client.list(`/orgs/${expected.organization}/actions/runner-groups/${id}/repositories`, 'repositories');
  require(repositories.length === 1 && repositories[0]!.id === expected.repositoryId &&
    repositories[0]!.full_name === expected.repository,
  'Another repository or broad group access cannot establish repository-dedicated assignment.');
}

export function assertPrivateHostedRunner(
  value: Record<string, unknown>,
  expected: Pick<PrivateRunnerAssignmentBinding, 'runnerName' | 'imageId' | 'machineSize' | 'maxRunners'>,
  id: number, groupId: number
): void {
  require(value.id === id && value.name === expected.runnerName && value.runner_group_id === groupId &&
    object(value.image_details).id === expected.imageId && object(value.image_details).source === 'github' &&
    object(value.machine_size_details).id === expected.machineSize && value.maximum_runners === expected.maxRunners &&
    value.public_ip_enabled === false && ['linux-x64', 'linux'].includes(String(value.platform)) &&
    (value.image_gen === undefined || value.image_gen === false),
  'The hosted definition differs from the exact reviewed group, image, machine or private networking.');
}

export async function verifyPrivateRunnerAssignment(
  client: GitHubActivationClient, value: PrivateRunnerAssignmentBinding,
  options: {
    authorize(): Promise<void>;
    now?: () => Date;
    sources?: readonly PrivateRunnerApplicationSource[];
    run?: { workflow: WorkflowRunBinding; operation: ExternalOperationState | RecordedWorkflowRunIdentity };
  }
): Promise<PrivateRunnerAssignmentObservation> {
  const binding = validatePrivateRunnerAssignment(value);
  require((options.sources?.length ?? 0) <= 4, 'Assignment readback admits at most four exact application workflow sources.');
  const checkedSources = (options.sources ?? []).map(validatePrivateRunnerApplicationSource);
  require(new Set(checkedSources.map((entry) => entry.workflowId)).size === checkedSources.length,
    'Assignment source readback cannot substitute duplicate workflow IDs.');
  for (const source of checkedSources) {
    assertPrivateApplicationWorkflowRouting(source, {
      repository: binding.repository, repositoryId: binding.repositoryId,
      groupName: binding.runnerGroupName, runnerName: binding.runnerName
    });
    require(binding.allowedWorkflows.includes(privateApplicationWorkflowSelector(source)),
      'The actual application workflow is not in this exact group allowlist.');
  }
  const runBinding = options.run ? structuredClone(options.run) : undefined;
  if (runBinding) {
    const { workflow, operation } = runBinding;
    validateWorkflowRunBinding(workflow);
    const runId = positiveId(Number(operation.operationId));
    require(operation.provider === 'github' && operation.operationId === String(runId) &&
      operation.resourceId === `/repos/${binding.repository}/actions/runs/${runId}`,
    'Job readback requires the actual canonical provider run identity in this exact repository.');
    const source = checkedSources.find((entry) => entry.workflowId === workflow.workflowId);
    require(source && workflow.repository === binding.repository && workflow.repositoryId === binding.repositoryId &&
      workflow.workflowPath === source.recipe.workflowPath && workflow.workflowDigest === source.workflowDigest &&
      workflow.ref === source.ref && workflow.actorId === source.actorId && workflow.event === 'workflow_dispatch' &&
      (workflow.producerSourceSha ?? workflow.sourceSha) === source.sourceSha &&
      canonicalSha256(workflow.expectedJobs) === canonicalSha256([privateApplicationWorkflowJob(source)]),
    'Job readback needs the exact published selected workflow binding; a definition ID is not a run or runner ID.');
  }
  const requestIds: string[] = [];
  const reads = new GitHubActivationClient({
    async request(request) {
      require(request.method === 'GET', 'Assignment verification is read-only and cannot reconcile controls or dispatch work.');
      await options.authorize();
      const response = await client.transport.request(request);
      requestIds.push(privateRunnerRequestId(response));
      return response;
    }
  });
  const repository = await reads.get(`/repos/${binding.repository}`);
  const organization = await reads.get(`/orgs/${binding.organization}`);
  require(repository.id === binding.repositoryId && repository.full_name === binding.repository &&
    repository.private === true && repository.archived === false && repository.disabled === false &&
    object(repository.owner).id === binding.organizationId && organization.id === binding.organizationId &&
    organization.type === 'Organization', 'The exact private repository or owning organization is not independently observed.');
  const base = `/orgs/${binding.organization}`;
  const group = await reads.get(`${base}/actions/runner-groups/${binding.groupId}`);
  await assertPrivateRunnerGroup(reads, group, binding, binding.groupId, binding.networkConfigurationId, binding.allowedWorkflows);
  const network = await reads.get(`${base}/settings/network-configurations/${binding.networkConfigurationId}`);
  assertPrivateRunnerNetwork(network, binding, binding.networkConfigurationId);
  const settings = await reads.get(`${base}/settings/network-settings/${binding.networkSettingsId}`);
  require(settings.id === binding.networkSettingsId && settings.subnet_id === binding.subnetId && settings.region === binding.region &&
    (settings.network_configuration_id === undefined || settings.network_configuration_id === binding.networkConfigurationId),
  'The provider network settings do not select the exact approved subnet and configuration.');
  const hosted = await reads.list(`${base}/actions/runner-groups/${binding.groupId}/hosted-runners`, 'runners');
  const selfHosted = await reads.list(`${base}/actions/runner-groups/${binding.groupId}/runners`, 'runners');
  require(hosted.length === 1 && hosted[0]!.id === binding.definitionId && selfHosted.length === 0,
    'A broad or mixed runner fleet cannot stand in for the exact repository-dedicated hosted definition.');
  const definition = await reads.get(`${base}/actions/hosted-runners/${binding.definitionId}`);
  assertPrivateHostedRunner(definition, binding, binding.definitionId, binding.groupId);
  require(definition.status === 'Ready', 'The exact hosted definition is not ready.');
  const sources: PrivateRunnerApplicationSourceObservation[] = [];
  for (const source of checkedSources) {
    sources.push(await readPrivateRunnerApplicationSource(reads, source,
      runBinding?.workflow.workflowId === source.workflowId ? { refSha: runBinding.workflow.sourceSha } : undefined));
  }
  let job: PrivateRunnerAssignmentObservation['job'] = null;
  if (runBinding) {
    const { workflow, operation } = runBinding;
    const run = await readBoundWorkflowRun(reads, workflow, operation);
    const jobs = await reads.list(`${operation.resourceId}/attempts/${workflow.runAttempt}/jobs`, 'jobs');
    const providerJob = jobs[0], boundJob = run.jobs[0];
    require(jobs.length === 1 && run.jobs.length === 1 && providerJob && boundJob &&
      providerJob.id === boundJob.id && providerJob.name === boundJob.name &&
      providerJob.run_id === run.runId && providerJob.head_sha === workflow.sourceSha &&
      providerJob.status === 'completed' && providerJob.conclusion === boundJob.conclusion &&
      providerJob.check_run_url === `https://api.github.com/repos/${binding.repository}/check-runs/${boundJob.checkRunId}` &&
      providerJob.runner_group_id === binding.groupId && providerJob.runner_group_name === binding.runnerGroupName &&
      Array.isArray(providerJob.steps) && providerJob.steps.length === boundJob.steps.length &&
      canonicalSha256(providerJob.steps.map((value) => {
        const step = object(value);
        return { number: step.number, name: step.name, status: step.status, conclusion: step.conclusion };
      })) === canonicalSha256(boundJob.steps),
    'Actual job readback changed its exact run, check, steps or dedicated group binding.');
    const runnerName = text(providerJob.runner_name, 'Actual provider-assigned runner name');
    const runnerGroupName = text(providerJob.runner_group_name, 'Actual provider-assigned runner group name');
    const rawLabels = providerJob.labels;
    require(Array.isArray(rawLabels) && rawLabels.length > 0 && rawLabels.length <= 100,
      'Actual provider-assigned runner labels must be present and bounded.');
    const labels = rawLabels.map((value) => text(value, 'Actual provider-assigned runner label'));
    require(runnerName.length <= 256 && runnerName.trim() === runnerName &&
      labels.every((value) => value.length <= 256 && value.trim() === value) &&
      new Set(labels).size === labels.length && labels.includes(binding.runnerName) &&
      (run.conclusion === 'success' || run.conclusion === 'failure'),
    'Actual job metadata does not prove the selected dedicated runner routing.');
    job = {
      workflowId: workflow.workflowId, runId: run.runId, runAttempt: run.runAttempt,
      jobId: boundJob.id, jobName: boundJob.name, checkRunId: boundJob.checkRunId,
      runnerId: positiveId(providerJob.runner_id), runnerName, runnerGroupId: binding.groupId, runnerGroupName, labels,
      sourceSha: workflow.sourceSha, producerSourceSha: workflow.producerSourceSha ?? workflow.sourceSha,
      conclusion: run.conclusion
    };
  }
  await options.authorize();
  return { kind: 'private-runner-assignment-readback/1', binding, requestIds, sources, job,
    observedAt: (options.now?.() ?? new Date()).toISOString() };
}
