import { isRecord } from './canonical-json.js';
import type { LiveReadbackProof, TransitionOperation } from './types.js';

export const privateRunnerCreatedResources = [
  { step: 'network-configuration', collection: 'settings/network-configurations', field: 'networkConfigurationId', type: 'runner-network-configuration' },
  { step: 'runner-group', collection: 'actions/runner-groups', field: 'groupId', type: 'runner-group' },
  { step: 'hosted-runner', collection: 'actions/hosted-runners', field: 'hostedRunnerDefinitionId', type: 'private-runner' }
] as const;

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const networkId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

export function privateRunnerPayloadIssues(record: {
  payload?: unknown;
  liveReadback?: readonly Pick<LiveReadbackProof, 'provider' | 'resourceType' | 'resourceId' | 'matches'>[];
}): string[] {
  const value = record.payload;
  if (!isRecord(value)) return ['Private runner evidence requires a structured payload.'];
  const assignment = value.assignment;
  const binding = isRecord(assignment) ? assignment.binding : undefined;
  if (typeof value.organization !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(value.organization) ||
    !positive(value.organizationId) || !positive(value.repositoryId) || typeof value.repository !== 'string' ||
    !positive(value.groupId) || !positive(value.hostedRunnerDefinitionId) || !networkId(value.networkConfigurationId) ||
    !isRecord(assignment) || assignment.kind !== 'private-runner-assignment-readback/1' || !isRecord(binding) ||
    binding.organization !== value.organization || binding.organizationId !== value.organizationId ||
    binding.repository !== value.repository || binding.repositoryId !== value.repositoryId ||
    binding.groupId !== value.groupId || binding.definitionId !== value.hostedRunnerDefinitionId ||
    binding.networkConfigurationId !== value.networkConfigurationId) {
    return ['Private runner evidence must distinguish its organization, hosted definition, group and exact assignment binding.'];
  }
  const issues: string[] = [];
  for (const resource of privateRunnerCreatedResources) {
    const id = `/orgs/${value.organization}/${resource.collection}/${value[resource.field]}`;
    if (!(record.liveReadback ?? []).some((proof) => proof.provider === 'github' &&
      proof.resourceType === resource.type && proof.resourceId === id && proof.matches)) {
      issues.push(`Private runner evidence lacks independent ${resource.type} readback for its exact resource.`);
    }
  }
  if (value.scope === 'network-reachability-only') {
    const report = value.report;
    const job = isRecord(report) ? report.job : undefined;
    if (!positive(value.runnerId) || !positive(value.runId) || !positive(value.runAttempt) ||
      !isRecord(report) || !isRecord(job) || report.kind !== 'private-runner-reachability-report' ||
      report.repository !== value.repository || report.repositoryId !== value.repositoryId ||
      report.runId !== value.runId || report.runAttempt !== value.runAttempt ||
      job.runnerId !== value.runnerId || job.runnerGroupId !== value.groupId ||
      !(record.liveReadback ?? []).some((proof) => proof.provider === 'github' && proof.resourceType === 'workflow-run' &&
        proof.resourceId === `/repos/${value.repository}/actions/runs/${value.runId}` && proof.matches)) {
      issues.push('Private network proof must bind the actual workflow/job runner separately from the hosted definition.');
    }
  } else if (value.scope !== 'workflow-assignment-only' || value.networkReachability !== 'not-reprobed' ||
    !digest(value.originPlanDigest) || assignment.job !== null || value.runnerId !== undefined || value.report !== undefined) {
    issues.push('Assignment-only readback cannot manufacture a new job or network-reachability proof.');
  }
  return issues;
}

export function matchesPrivateRunnerCreatedReadback(
  operation: TransitionOperation, proof: Pick<LiveReadbackProof, 'provider' | 'resourceType' | 'resourceId'>, payload: unknown
): boolean {
  if (operation.phaseId !== 'runner-ready' || operation.actionId !== 'github.runner.ensure-ready' ||
    operation.adapter !== 'github' || operation.mutationClass !== 'github-write' ||
    operation.destination.type !== 'external' || proof.provider !== 'github' || !isRecord(payload) ||
    payload.kind !== 'runner-ready.v1' || payload.scope !== 'network-reachability-only' ||
    !isRecord(operation.inputs.plan)) return false;
  const plan = operation.inputs.plan;
  if (plan.schemaVersion !== 1 || plan.recipe !== 'repository-private-hosted-runner/1' || plan.reconciliation !== undefined ||
    plan.organization !== payload.organization ||
    plan.organizationId !== payload.organizationId || plan.repository !== payload.repository ||
    plan.repositoryId !== payload.repositoryId) return false;
  return privateRunnerCreatedResources.some((resource) => {
    const id = payload[resource.field];
    const collection = `/orgs/${plan.organization}/${resource.collection}`;
    return operation.inputs.step === resource.step && operation.destination.identity === collection &&
      proof.resourceType === resource.type && (resource.field === 'networkConfigurationId' ? networkId(id) : positive(id)) &&
      proof.resourceId === `${collection}/${id}`;
  });
}
