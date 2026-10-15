import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { GitHubActivationClient } from '../src/adapters/github/activation-rest.js';
import type { GitHubActivationTransport, GitHubRequest } from '../src/adapters/github/activation-rest.js';
import type { WorkflowExecutionRefBinding } from '../src/governance-activation/workflow-execution-ref-observation.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';

async function provider() {
  const binding: WorkflowExecutionRefBinding = {
    repository: 'owner/repo', repositoryId: 123, sourceSha: 'a'.repeat(40), treeSha: 'b'.repeat(40),
    executionRef: `liftoff-execution-${'a'.repeat(40)}`
  };
  const calls: GitHubRequest[] = [];
  const state = { inherited: false, protected: true, bypass: false, scopes: 'repo, workflow',
    treeSha: binding.treeSha, tagSha: binding.sourceSha, tagType: 'commit', repositoryId: 123 };
  const server = createServer((request, reply) => {
    if (request.method !== 'GET') {
      reply.writeHead(405); reply.end(); return;
    }
    let data: unknown;
    if (request.url === '/repos/owner/repo') data = {
      id: state.repositoryId, full_name: 'owner/repo', permissions: { push: true }
    };
    else if (request.url?.includes('/rulesets?')) data = state.protected ? [{
      id: 11, source_type: state.inherited ? 'Organization' : 'Repository', source: 'owner/repo'
    }] : [];
    else if (request.url === '/repos/owner/repo/rulesets/11') data = {
      id: 11, source_type: 'Repository', source: 'owner/repo', target: 'tag', enforcement: 'active',
      bypass_actors: state.bypass ? [{ actor_id: 1 }] : [],
      conditions: { ref_name: { include: ['refs/tags/liftoff-execution-*'], exclude: [] } },
      rules: [{ type: 'update' }, { type: 'deletion' }]
    };
    else if (request.url?.includes('/git/commits/')) data = { sha: binding.sourceSha, tree: { sha: state.treeSha } };
    else if (request.url?.includes('/git/ref/tags/')) data = {
      ref: `refs/tags/${binding.executionRef}`, object: { type: state.tagType, sha: state.tagSha }
    };
    else { reply.writeHead(404); reply.end(); return; }
    reply.writeHead(200, { 'content-type': 'application/json', 'x-oauth-scopes': state.scopes });
    reply.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected isolated loopback listener.');
  const transport: GitHubActivationTransport = {
    async request(request) {
      calls.push(structuredClone(request));
      if (request.method !== 'GET') throw new Error('Read-only observation cannot submit a provider effect.');
      const response = await fetch(`http://127.0.0.1:${address.port}${request.path}`, {
        method: 'GET', signal: AbortSignal.timeout(30_000)
      });
      return { status: response.status, headers: { 'x-oauth-scopes': response.headers.get('x-oauth-scopes') ?? '' },
        data: await response.json() };
    }
  };
  return {
    binding, calls, state, runtime: { client: new GitHubActivationClient(transport) },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}

describe('neutral exact execution-ref observation without writer authority', () => {
  it('observes actual bounded loopback responses through the client-only module', async () => {
    const neutral = await import('../src/governance-activation/workflow-execution-ref-observation.js');
    const fixture = await provider();
    try {
      const proof = await neutral.observeImmutableWorkflowExecutionRef(fixture.runtime, fixture.binding);
      expect(proof).toMatchObject({ kind: 'immutable-workflow-execution-ref.v1',
        binding: fixture.binding, protectingRulesetIds: [11] });
      expect(proof.observationDigest).toBe(canonicalSha256({
        binding: fixture.binding, barrierDigest: proof.barrierDigest, providerAdmissionDigest: proof.providerAdmissionDigest
      }));
      expect(fixture.calls).toHaveLength(6);
      expect(fixture.calls.every(call => call.method === 'GET')).toBe(true);
      expect(neutral.workflowExecutionRefName(fixture.binding.sourceSha)).toBe(fixture.binding.executionRef);
    } finally { await fixture.close(); }
  });

  it.each(['inherited', 'unprotected', 'bypass', 'scope', 'tree', 'tag', 'annotated', 'repository'] as const)(
    'still refuses %s without a tag write, dispatch or protection mutation', async fault => {
      const neutral = await import('../src/governance-activation/workflow-execution-ref-observation.js');
      const fixture = await provider();
      if (fault === 'inherited') fixture.state.inherited = true;
      if (fault === 'unprotected') fixture.state.protected = false;
      if (fault === 'bypass') fixture.state.bypass = true;
      if (fault === 'scope') fixture.state.scopes = 'repo';
      if (fault === 'tree') fixture.state.treeSha = 'c'.repeat(40);
      if (fault === 'tag') fixture.state.tagSha = 'c'.repeat(40);
      if (fault === 'annotated') fixture.state.tagType = 'tag';
      if (fault === 'repository') fixture.state.repositoryId = 124;
      try {
        await expect(neutral.observeImmutableWorkflowExecutionRef(fixture.runtime, fixture.binding)).rejects.toThrow();
        expect(fixture.calls.every(call => call.method === 'GET')).toBe(true);
      } finally { await fixture.close(); }
    });
});
