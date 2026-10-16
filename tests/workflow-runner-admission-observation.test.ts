import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { GitHubActivationClient } from '../src/adapters/github/activation-rest.js';
import type { GitHubActivationTransport, GitHubRequest } from '../src/adapters/github/activation-rest.js';
import {
  observeWorkflowRunnerAssignment, validateWorkflowRunnerAdmission
} from '../src/governance-activation/workflow-runner-admission-observation.js';
import type { WorkflowRunnerAdmissionBinding } from '../src/governance-activation/workflow-runner-admission-observation.js';

async function provider() {
  const before = 'owner/repo/.github/workflows/proof.yml@refs/heads/develop';
  const after = `owner/repo/.github/workflows/proof.yml@refs/tags/liftoff-execution-${'a'.repeat(40)}`;
  const binding: WorkflowRunnerAdmissionBinding = {
    repository: 'owner/repo', repositoryId: 123, groupId: 45,
    groupName: 'Exact private group', networkConfigurationId: 'network-id',
    beforeWorkflows: [before], afterWorkflows: [before, after]
  };
  const state = {
    repository: { id: 123, full_name: 'owner/repo' },
    group: {
      id: 45, name: binding.groupName, network_configuration_id: binding.networkConfigurationId,
      visibility: 'selected', allows_public_repositories: false, inherited: false,
      workflow_restrictions_read_only: false, restricted_to_workflows: true,
      selected_workflows: [before] as unknown
    },
    membership: { state: 'active', role: 'admin', organization: { login: 'owner' } } as unknown,
    repositories: [{ id: 123, full_name: 'owner/repo' }],
    scopes: 'admin:org', membershipStatus: 200, total: 1, paginationLimit: false
  };
  const calls: GitHubRequest[] = [];
  const server = createServer((request, reply) => {
    if (request.method !== 'GET') { reply.writeHead(405); reply.end(); return; }
    let data: unknown, status = 200;
    if (request.url === '/repos/owner/repo') data = state.repository;
    else if (request.url === '/orgs/owner/actions/runner-groups/45') data = state.group;
    else if (request.url === '/user/memberships/orgs/owner') {
      data = state.membership; status = state.membershipStatus;
    } else if (request.url?.startsWith('/orgs/owner/actions/runner-groups/45/repositories?')) {
      data = state.paginationLimit
        ? { total_count: 1001, repositories: Array.from({ length: 100 }, () => state.repositories[0]) }
        : { total_count: state.total, repositories: state.repositories };
    } else { reply.writeHead(404); reply.end(); return; }
    reply.writeHead(status, { 'content-type': 'application/json', 'x-oauth-scopes': state.scopes,
      ...(state.paginationLimit ? { link: '</next>; rel="next"' } : {}) });
    reply.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected isolated loopback listener.');
  const transport: GitHubActivationTransport = {
    async request(request) {
      calls.push(structuredClone(request));
      if (request.method !== 'GET') throw new Error('Assignment observation cannot submit provider effects.');
      const response = await fetch(`http://127.0.0.1:${address.port}${request.path}`, {
        method: 'GET', signal: AbortSignal.timeout(30_000)
      });
      return { status: response.status, headers: Object.fromEntries(response.headers.entries()),
        data: await response.json() };
    }
  };
  return { binding, calls, state, runtime: { client: new GitHubActivationClient(transport) },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

describe('neutral current runner assignment without writer or host authority', () => {
  it.each(['before', 'after'] as const)('reads the exact %s assignment without changing it', async selected => {
    const fixture = await provider();
    const expected = fixture.binding[selected === 'before' ? 'beforeWorkflows' : 'afterWorkflows'];
    fixture.state.group.selected_workflows = [...expected];
    try {
      expect(await observeWorkflowRunnerAssignment(fixture.runtime, fixture.binding)).toEqual(expected);
      expect(fixture.calls.map(call => [call.method, call.path])).toEqual([
        ['GET', '/repos/owner/repo'], ['GET', '/orgs/owner/actions/runner-groups/45'],
        ['GET', '/user/memberships/orgs/owner'],
        ['GET', '/orgs/owner/actions/runner-groups/45/repositories?per_page=100&page=1']
      ]);
      expect(fixture.state.group.selected_workflows).toEqual(expected);
    } finally { await fixture.close(); }
  });

  it.each([
    'repository-id', 'repository-name', 'group-id', 'group-name', 'network', 'visibility',
    'public', 'inherited', 'read-only', 'unrestricted', 'workflow-array', 'workflow-string',
    'repository-count', 'member-repository-id', 'member-repository-name', 'scope',
    'membership-status', 'membership-state', 'membership-role', 'membership-organization', 'membership-body'
  ] as const)('retains exact existing %s refusal using actual loopback responses', async fault => {
    const fixture = await provider();
    const { state } = fixture;
    if (fault === 'repository-id') state.repository.id++;
    if (fault === 'repository-name') state.repository.full_name = 'owner/other';
    if (fault === 'group-id') state.group.id++;
    if (fault === 'group-name') state.group.name = 'Other group';
    if (fault === 'network') state.group.network_configuration_id = 'other-network';
    if (fault === 'visibility') state.group.visibility = 'all';
    if (fault === 'public') state.group.allows_public_repositories = true;
    if (fault === 'inherited') state.group.inherited = true;
    if (fault === 'read-only') state.group.workflow_restrictions_read_only = true;
    if (fault === 'unrestricted') state.group.restricted_to_workflows = false;
    if (fault === 'workflow-array') state.group.selected_workflows = 'not-an-array';
    if (fault === 'workflow-string') state.group.selected_workflows = [123];
    if (fault === 'repository-count') { state.repositories.push({ id: 124, full_name: 'owner/other' }); state.total = 2; }
    if (fault === 'member-repository-id') state.repositories[0]!.id++;
    if (fault === 'member-repository-name') state.repositories[0]!.full_name = 'owner/other';
    if (fault === 'scope') state.scopes = 'repo, workflow';
    if (fault === 'membership-status') state.membershipStatus = 403;
    if (fault === 'membership-state') state.membership = { state: 'pending', role: 'admin', organization: { login: 'owner' } };
    if (fault === 'membership-role') state.membership = { state: 'active', role: 'member', organization: { login: 'owner' } };
    if (fault === 'membership-organization') state.membership = { state: 'active', role: 'admin', organization: { login: 'other' } };
    if (fault === 'membership-body') state.membership = null;
    try {
      await expect(observeWorkflowRunnerAssignment(fixture.runtime, fixture.binding)).rejects.toThrow(
        /Independent group|classic admin:org/);
      expect(fixture.calls).toHaveLength(4);
      expect(fixture.calls.every(call => call.method === 'GET')).toBe(true);
    } finally { await fixture.close(); }
  });

  it('refuses incomplete repository inventory rather than inferring exclusive assignment', async () => {
    const fixture = await provider();
    fixture.state.total = 2;
    try {
      await expect(observeWorkflowRunnerAssignment(fixture.runtime, fixture.binding)).rejects.toThrow(/incomplete inventory/);
      expect(fixture.calls).toHaveLength(4);
    } finally { await fixture.close(); }
  });

  it('retains the actual client 1,000-resource bound without writing provider state', async () => {
    const fixture = await provider();
    fixture.state.paginationLimit = true;
    try {
      await expect(observeWorkflowRunnerAssignment(fixture.runtime, fixture.binding)).rejects.toThrow(/1,000-resource bound/);
      expect(fixture.calls).toHaveLength(13);
      expect(fixture.calls.every(call => call.method === 'GET')).toBe(true);
    } finally { await fixture.close(); }
  });

  it('rejects removal or an unsupported ref selector before any provider read', async () => {
    const fixture = await provider();
    try {
      for (const afterWorkflows of [[], ['owner/repo/.github/workflows/proof.yml@refs/heads/ci/source']]) {
        const binding = { ...fixture.binding, afterWorkflows };
        expect(() => validateWorkflowRunnerAdmission(binding)).toThrow(/can only add exact/);
        await expect(observeWorkflowRunnerAssignment(fixture.runtime, binding)).rejects.toThrow(/can only add exact/);
      }
      expect(fixture.calls).toEqual([]);
    } finally { await fixture.close(); }
  });
});
