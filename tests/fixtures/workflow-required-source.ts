import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';
import { createAuthenticatedGitHubTransport } from '../../src/adapters/github/activation-rest.js';
import { projectCatalog } from '../../src/application/project/catalog.js';
import { workflowByteDigest } from '../../src/governance-activation/workflow-binding.js';
import { createSource5WorkflowContext } from '../../src/governance-activation/workflow-source5-context.js';
import { workflowObservationRuntime } from '../../src/governance-activation/workflow-runtime.js';
import { writeModernInstalledProject } from './modern-installed-project.js';

export async function createWorkflowRequiredSourceFixture(root: string,
  workflow: 'manual' | 'openspec' | 'spec-kit' = 'manual',
  profile: 'single-maintainer-gitflow' | 'team-gitflow' = 'single-maintainer-gitflow') {
  const projectRoot = await mkdtemp(path.join(root, 'project-'));
  const value = await writeModernInstalledProject(projectRoot, workflow, profile);
  if (!value.api) throw new Error('Expected governed current5 source fixture.');
  const context = createSource5WorkflowContext(projectCatalog, {
    recordedIdentity: value.api.identity, profile, policyVersion: value.api.identity.policyVersion,
    selection: { ...value.input.selection, profile },
    pluginResolutionDigest: value.api.identity.pluginResolutionDigest,
    activeLayoutDigest: value.api.identity.activeLayoutDigest
  });
  const names = ['Repository workflows / Actual backend behavioral tests', 'Required external qualification / Unknown verifier', '__proto__'];
  const files = [
    { path: 'governance/rulesets/branches.json', content: JSON.stringify({
      target: 'branch', bypass_actors: [], conditions: { ref_name: {
        include: ['refs/heads/develop', 'refs/heads/main', 'refs/heads/release/**', 'refs/heads/hotfix/**'], exclude: []
      } }, rules: [
        { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
          required_status_checks: names.map((context, index) => ({ context, integration_id: 700 + index })) } },
        { type: 'pull_request', parameters: {
          required_approving_review_count: profile === 'single-maintainer-gitflow' ? 0 : 1,
          dismiss_stale_reviews_on_push: true
        } }
      ]
    }) },
    { path: 'governance/rulesets/tags.json', content: JSON.stringify({ target: 'tag', rules: [] }) }
  ];
  const source = { repository: 'owner/repo', repositoryId: 123, sourceSha: 'a'.repeat(40), treeSha: 'b'.repeat(40),
    files: files.map(file => ({ path: file.path, digest: workflowByteDigest(file.content) })) };
  const state = {
    repository: { id: 123, full_name: 'owner/repo' },
    commit: { sha: source.sourceSha, tree: { sha: source.treeSha } },
    tree: { sha: source.treeSha, truncated: false, tree: [
      ...files.map(file => ({ path: file.path, type: 'blob', mode: '100644' })),
      { path: 'backend/source.js', type: 'blob', mode: '100644' }
    ] }, files
  };
  const calls: { method: string; path: string }[] = [], errors: unknown[] = [];
  const acceptHeaders: Array<string | undefined> = [];
  const hooks: { afterResponse?: (path: string) => void } = {}, routes = new Map<string, unknown>();
  const replyHeaders = new Map<string, Record<string, string>>(), replyStatuses = new Map<string, number>();
  const server = createServer((request, reply) => {
    try {
      calls.push({ method: request.method ?? '', path: request.url ?? '' });
      acceptHeaders.push(request.headers.accept);
      if (request.method !== 'GET') throw new Error('Required-source fixture permits no provider effects.');
      const endpoint = request.url ?? '';
      let data: unknown;
      if (routes.has(endpoint)) data = routes.get(endpoint);
      else if (endpoint === '/repos/owner/repo') data = state.repository;
      else if (endpoint === `/repos/owner/repo/git/commits/${'a'.repeat(40)}`) data = state.commit;
      else if (endpoint === `/repos/owner/repo/git/trees/${'b'.repeat(40)}?recursive=1`) data = state.tree;
      else {
        const file = state.files.find(file => endpoint === `/repos/owner/repo/contents/${file.path}?ref=${'a'.repeat(40)}`);
        if (!file) throw new Error('Unexpected immutable source endpoint.');
        data = { type: 'file', path: file.path, encoding: 'base64', content: Buffer.from(file.content).toString('base64') };
      }
      reply.writeHead(replyStatuses.get(endpoint) ?? 200, {
        'content-type': 'application/json', ...replyHeaders.get(endpoint)
      }); reply.end(JSON.stringify(data));
    } catch (error) {
      errors.push(error); reply.writeHead(500, { 'content-type': 'application/json' }); reply.end('{}');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected actual isolated loopback listener.');
  const transport = createAuthenticatedGitHubTransport(Buffer.from('isolated-fixture-not-a-credential'), (input, init) => {
    if (typeof input !== 'string') throw new Error('Expected bounded literal REST URL.');
    const url = new URL(input);
    if (url.origin !== 'https://api.github.com') throw new Error('Unexpected provider origin.');
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init).then(response => {
      hooks.afterResponse?.(`${url.pathname}${url.search}`); return response;
    });
  });
  let processCalls = 0;
  const runtime = workflowObservationRuntime({ projectRoot, transport, runner: { async run() {
    processCalls++; throw new Error('Immutable source observation must not execute Git or project commands.');
  } } });
  return { context, runtime, source, names, state, calls, acceptHeaders, hooks, transport, routes, replyHeaders, replyStatuses,
    processCalls: () => processCalls,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      expect(errors).toEqual([]);
    } };
}
