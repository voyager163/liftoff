import { githubRepository, positiveId } from '../adapters/github/activation-rest.js';
import type { GitHubActivationClient } from '../adapters/github/activation-rest.js';
import { isRecord } from '../domain/governance/activation/canonical-json.js';
import { captureWorkflowBinding, workflowFailure } from './workflow-control-values.js';

export interface WorkflowRunnerAdmissionBinding {
  repository: string;
  repositoryId: number;
  groupId: number;
  groupName: string;
  networkConfigurationId: string;
  beforeWorkflows: readonly string[];
  afterWorkflows: readonly string[];
}

export interface WorkflowRunnerObservationRuntime {
  readonly client: Pick<GitHubActivationClient, 'get' | 'list' | 'transport'>;
}

export function validateWorkflowRunnerAdmission(binding: WorkflowRunnerAdmissionBinding): WorkflowRunnerAdmissionBinding {
  binding = captureWorkflowBinding(binding);
  githubRepository(binding.repository);
  positiveId(binding.repositoryId); positiveId(binding.groupId);
  const pattern = new RegExp(`^${binding.repository.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/\\.github/workflows/[A-Za-z0-9_-]+\\.ya?ml@refs/(?:heads/(?:develop|main|release/[A-Za-z0-9_./-]+|hotfix/[A-Za-z0-9_./-]+)|tags/liftoff-execution-[a-f0-9]{40})$`, 'u');
  if (!binding.groupName || !binding.networkConfigurationId ||
    !binding.afterWorkflows.length || binding.afterWorkflows.length > 32 ||
    new Set(binding.beforeWorkflows).size !== binding.beforeWorkflows.length ||
    new Set(binding.afterWorkflows).size !== binding.afterWorkflows.length ||
    [...binding.beforeWorkflows, ...binding.afterWorkflows].some(workflow => !pattern.test(workflow)) ||
    binding.beforeWorkflows.some(workflow => !binding.afterWorkflows.includes(workflow))) {
    return workflowFailure('workflow-runner-admission', 'Admission can only add exact workflows/refs in the qualified repository-owned private runner group; it cannot remove assignments, widen repositories, or create a runner.');
  }
  return binding;
}

/** Reads the current assignment and classic administrator grant, not host qualification or write authority. */
export async function observeWorkflowRunnerAssignment(
  runtime: WorkflowRunnerObservationRuntime, binding: WorkflowRunnerAdmissionBinding
): Promise<readonly string[]> {
  binding = validateWorkflowRunnerAdmission(binding);
  const organization = binding.repository.split('/')[0]!;
  const endpoint = `/orgs/${organization}/actions/runner-groups/${binding.groupId}`;
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
    !group.selected_workflows.every((workflow): workflow is string => typeof workflow === 'string') ||
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
