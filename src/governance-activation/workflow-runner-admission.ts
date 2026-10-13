import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { githubRepository, positiveId } from '../adapters/github/activation-rest.js';
import type { PhaseAdapterExecutionInput } from './transition-ports.js';
import {
  assertWorkflowAuthority, captureWorkflowBinding, workflowFailure, workflowOperation,
  workflowRuntime, recordWorkflowCheckpoint
} from './workflow-runtime.js';

export interface WorkflowRunnerAdmissionBinding {
  repository: string;
  repositoryId: number;
  groupId: number;
  groupName: string;
  networkConfigurationId: string;
  beforeWorkflows: readonly string[];
  afterWorkflows: readonly string[];
}

export interface WorkflowRunnerAdmissionInput extends PhaseAdapterExecutionInput {
  runnerAdmissionIntent?: { bindingDigest: string; planDigest: string };
  recordRunnerAdmissionIntent?: (intent: { bindingDigest: string; planDigest: string }) => Promise<void>;
}

export async function admitReviewedRunnerWorkflows(
  input: WorkflowRunnerAdmissionInput, binding: WorkflowRunnerAdmissionBinding
): Promise<{ bindingDigest: string; observationDigest: string }> {
  binding = captureWorkflowBinding(binding);
  githubRepository(binding.repository);
  positiveId(binding.repositoryId); positiveId(binding.groupId);
  const organization = binding.repository.split('/')[0]!;
  const pattern = new RegExp(`^${binding.repository.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/\\.github/workflows/[A-Za-z0-9_-]+\\.ya?ml@refs/(?:heads/(?:develop|main|release/[A-Za-z0-9_./-]+|hotfix/[A-Za-z0-9_./-]+)|tags/liftoff-execution-[a-f0-9]{40})$`, 'u');
  if (!binding.groupName || !binding.networkConfigurationId ||
    !binding.afterWorkflows.length || binding.afterWorkflows.length > 32 ||
    new Set(binding.beforeWorkflows).size !== binding.beforeWorkflows.length ||
    new Set(binding.afterWorkflows).size !== binding.afterWorkflows.length ||
    [...binding.beforeWorkflows, ...binding.afterWorkflows].some((workflow) => !pattern.test(workflow)) ||
    binding.beforeWorkflows.some((workflow) => !binding.afterWorkflows.includes(workflow))) {
    return workflowFailure('workflow-runner-admission', 'Admission can only add exact workflows/refs in the qualified repository-owned private runner group; it cannot remove assignments, widen repositories, or create a runner.');
  }
  const operation = workflowOperation(input, 'github.workflow-source.admit-reviewed', binding);
  const bindingDigest = canonicalSha256(binding);
  const intent = input.runnerAdmissionIntent && captureWorkflowBinding(input.runnerAdmissionIntent);
  const expectedIntent = { bindingDigest, planDigest: input.plan.planDigest };
  if (intent && canonicalSha256(intent) !== canonicalSha256(expectedIntent)) {
    return workflowFailure('workflow-runner-admission', 'A restored runner admission intent cannot be reassigned to different source or reviewed authority.');
  }
  const runtime = workflowRuntime(input);
  const endpoint = `/orgs/${organization}/actions/runner-groups/${binding.groupId}`;
  async function observe() {
    const repository = await runtime.client.get(`/repos/${binding.repository}`);
    const group = await runtime.client.get(endpoint);
    const membership = await runtime.client.transport.request({
      method: 'GET', path: `/user/memberships/orgs/${organization}`
    });
    const scopes = membership.headers['x-oauth-scopes']?.split(',').map(scope => scope.trim()) ?? [];
    const repositories = await runtime.client.list(`${endpoint}/repositories`, 'repositories');
    if (repository.id !== binding.repositoryId || repository.full_name !== binding.repository ||
      group.id !== binding.groupId || group.name !== binding.groupName ||
      group.network_configuration_id !== binding.networkConfigurationId ||
      group.visibility !== 'selected' || group.allows_public_repositories !== false ||
      group.inherited !== false || group.workflow_restrictions_read_only !== false ||
      group.restricted_to_workflows !== true || !Array.isArray(group.selected_workflows) ||
      group.selected_workflows.some((workflow) => typeof workflow !== 'string') ||
      repositories.length !== 1 || repositories[0]!.id !== binding.repositoryId ||
      repositories[0]!.full_name !== binding.repository) {
      return workflowFailure('workflow-runner-admission', 'Independent group/network/repository readback differs from the exact selected private runner assignment. No organization-wide access change is permitted.');
    }
    if (membership.status !== 200 || !scopes.includes('admin:org') ||
      !isRecord(membership.data) || membership.data.state !== 'active' || membership.data.role !== 'admin' ||
      !isRecord(membership.data.organization) || membership.data.organization.login !== organization) {
      return workflowFailure('workflow-runner-permission', 'Runner workflow admission requires independently observed classic admin:org grants and active administrator membership. Unsupported or missing provider permission cannot be inferred from group visibility.');
    }
    return group.selected_workflows;
  }
  const current = await observe();
  const same = (left: readonly unknown[], right: readonly unknown[]) =>
    canonicalSha256([...left].sort()) === canonicalSha256([...right].sort());
  if (!same(current, binding.afterWorkflows)) {
    if (!same(current, binding.beforeWorkflows) || intent) {
      return workflowFailure('workflow-runner-admission', 'Runner admission changed or prior write acceptance is uncertain; do not repeat or overwrite another assignment.');
    }
    if (!input.recordRunnerAdmissionIntent) {
      return workflowFailure('workflow-runner-admission', 'Exact runner workflow admission requires durable engine intent.');
    }
    await assertWorkflowAuthority(input, operation);
    await recordWorkflowCheckpoint(input.recordRunnerAdmissionIntent, expectedIntent);
    await assertWorkflowAuthority(input, operation);
    await runtime.client.write('PATCH', endpoint, {
      name: binding.groupName, restricted_to_workflows: true, selected_workflows: [...binding.afterWorkflows]
    });
  }
  if (!same(await observe(), binding.afterWorkflows)) {
    return workflowFailure('workflow-runner-admission', 'Actual runner workflow admission did not match the reviewed after-set.');
  }
  return { bindingDigest, observationDigest: canonicalSha256({
    repositoryId: binding.repositoryId, groupId: binding.groupId, networkConfigurationId: binding.networkConfigurationId,
    selectedWorkflows: [...binding.afterWorkflows].sort()
  }) };
}
