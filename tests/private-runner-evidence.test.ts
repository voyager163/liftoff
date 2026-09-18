import { describe, expect, it } from 'vitest';
import { matchesPrivateRunnerCreatedReadback, privateRunnerPayloadIssues } from '../src/domain/governance/activation/runner-evidence.js';
import type { TransitionOperation } from '../src/domain/governance/activation/types.js';

function fixture() {
  const binding = {
    organization: 'example', organizationId: 7, repository: 'example/project', repositoryId: 42,
    groupId: 11, definitionId: 22, networkConfigurationId: 'network-33'
  };
  const payload = {
    kind: 'runner-ready.v1', scope: 'network-reachability-only',
    organization: binding.organization, organizationId: binding.organizationId,
    repository: binding.repository, repositoryId: binding.repositoryId,
    groupId: binding.groupId, hostedRunnerDefinitionId: binding.definitionId, networkConfigurationId: binding.networkConfigurationId,
    runnerId: 99, runId: 77, runAttempt: 1,
    assignment: { kind: 'private-runner-assignment-readback/1', binding, job: null },
    report: { kind: 'private-runner-reachability-report', repository: binding.repository, repositoryId: binding.repositoryId,
      runId: 77, runAttempt: 1, job: { runnerId: 99, runnerGroupId: binding.groupId } }
  };
  const liveReadback = [
    { provider: 'github' as const, resourceType: 'private-runner', resourceId: '/orgs/example/actions/hosted-runners/22', matches: true },
    { provider: 'github' as const, resourceType: 'runner-group', resourceId: '/orgs/example/actions/runner-groups/11', matches: true },
    { provider: 'github' as const, resourceType: 'runner-network-configuration', resourceId: '/orgs/example/settings/network-configurations/network-33', matches: true },
    { provider: 'github' as const, resourceType: 'workflow-run', resourceId: '/repos/example/project/actions/runs/77', matches: true }
  ];
  const operation: TransitionOperation = {
    adapter: 'github', phaseId: 'runner-ready', actionId: 'github.runner.ensure-ready',
    mutationClass: 'github-write', remote: true, destructive: false,
    destination: { type: 'external', identity: '/orgs/example/actions/hosted-runners' },
    inputs: { step: 'hosted-runner', plan: {
      schemaVersion: 1, recipe: 'repository-private-hosted-runner/1',
      organization: binding.organization, organizationId: binding.organizationId,
      repository: binding.repository, repositoryId: binding.repositoryId
    } }
  };
  return { header: { repositoryId: '42' }, payload, liveReadback, operation };
}

describe('current private runner evidence identity and created-resource scope', () => {
  it('keeps the provider-assigned job runner separate from the hosted definition', () => {
    const f = fixture();
    expect(f.payload.runnerId).not.toBe(f.payload.hostedRunnerDefinitionId);
    expect(privateRunnerPayloadIssues(f)).toEqual([]);
    expect(matchesPrivateRunnerCreatedReadback(f.operation, f.liveReadback[0]!, f.payload)).toBe(true);
  });

  it.each(['definition-as-job', 'wrong-group', 'wrong-org', 'wrong-network', 'wrong-repository', 'missing-readback', 'failed-readback'])(
    'rejects %s rather than accepting loosely matching runner metadata', (fault) => {
      const f = fixture();
      if (fault === 'definition-as-job') f.payload.runnerId = f.payload.hostedRunnerDefinitionId;
      if (fault === 'wrong-group') f.payload.groupId++;
      if (fault === 'wrong-org') f.payload.organization = 'other';
      if (fault === 'wrong-network') f.payload.networkConfigurationId = 'other';
      if (fault === 'wrong-repository') f.payload.repositoryId = 43;
      if (fault === 'missing-readback') f.liveReadback.splice(1, 1);
      if (fault === 'failed-readback') f.liveReadback[0]!.matches = false;
      expect(privateRunnerPayloadIssues(f).length).toBeGreaterThan(0);
    }
  );

  it('accepts only assignment readback without inventing a fresh reachability run', () => {
    const f = fixture();
    const { runnerId: _runnerId, report: _report, runId: _runId, runAttempt: _attempt, ...identity } = f.payload;
    const payload = { ...identity, scope: 'workflow-assignment-only', networkReachability: 'not-reprobed', originPlanDigest: 'a'.repeat(64) };
    expect(privateRunnerPayloadIssues({ ...f, payload })).toEqual([]);
    expect(privateRunnerPayloadIssues({ ...f, payload: { ...payload, runnerId: 99 } }).length).toBeGreaterThan(0);
    expect(privateRunnerPayloadIssues({ ...f, payload: { ...payload, networkReachability: 'verified' } }).length).toBeGreaterThan(0);
    expect(privateRunnerPayloadIssues({ ...f, payload: { ...payload, originPlanDigest: undefined } }).length).toBeGreaterThan(0);
  });

  it.each(['foreign-org', 'sibling-id', 'subresource', 'wrong-type', 'repo-only', 'read-only', 'another-action', 'another-phase', 'another-step', 'future-recipe', 'reconciliation'])(
    'does not expand collection creation into %s readback permission', (fault) => {
      const f = fixture();
      const proof = f.liveReadback[0]!;
      if (fault === 'foreign-org') proof.resourceId = '/orgs/other/actions/hosted-runners/22';
      if (fault === 'sibling-id') proof.resourceId = '/orgs/example/actions/hosted-runners/23';
      if (fault === 'subresource') proof.resourceId += '/other';
      if (fault === 'wrong-type') proof.resourceType = 'unrelated';
      if (fault === 'repo-only') f.operation.destination = { type: 'repository', identity: 'example/project', repository: 'example/project' };
      if (fault === 'read-only') f.operation.mutationClass = 'github-read';
      if (fault === 'another-action') f.operation.actionId = 'github.ruleset.apply';
      if (fault === 'another-phase') f.operation.phaseId = 'repository-rulesets-applied';
      if (fault === 'another-step') f.operation.inputs.step = 'runner-group';
      if (fault === 'future-recipe') f.operation.inputs.plan = { ...f.payload, recipe: 'repository-private-hosted-runner/2' };
      if (fault === 'reconciliation') f.operation.inputs.plan = { ...(f.operation.inputs.plan as Record<string, unknown>), reconciliation: {} };
      expect(matchesPrivateRunnerCreatedReadback(f.operation, proof, f.payload)).toBe(false);
    }
  );
});
