import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuthenticatedGitHubTransport } from '../src/adapters/github/activation-rest.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { workflowByteDigest } from '../src/governance-activation/workflow-binding.js';
import { createSource5WorkflowContext } from '../src/governance-activation/workflow-source5-context.js';
import { observeSource5WorkflowRequirementSource } from '../src/governance-activation/workflow-requirement-source-observation.js';
import { workflowObservationRuntime } from '../src/governance-activation/workflow-runtime.js';
import { writeModernInstalledProject } from './fixtures/modern-installed-project.js';

describe('actual immutable full ruleset inventory for canonical composition, not qualification', () => {
  let root: string;
  beforeAll(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-required-source-'))); });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  async function fixture(workflow: 'manual' | 'openspec' | 'spec-kit' = 'manual',
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
    const hooks: { afterResponse?: (path: string) => void } = {};
    const server = createServer((request, reply) => {
      try {
        calls.push({ method: request.method ?? '', path: request.url ?? '' });
        if (request.method !== 'GET') throw new Error('Required-source fixture permits no provider effects.');
        const endpoint = request.url ?? '';
        let data: unknown;
        if (endpoint === '/repos/owner/repo') data = state.repository;
        else if (endpoint === `/repos/owner/repo/git/commits/${'a'.repeat(40)}`) data = state.commit;
        else if (endpoint === `/repos/owner/repo/git/trees/${'b'.repeat(40)}?recursive=1`) data = state.tree;
        else {
          const file = state.files.find(file => endpoint === `/repos/owner/repo/contents/${file.path}?ref=${'a'.repeat(40)}`);
          if (!file) throw new Error('Unexpected immutable source endpoint.');
          data = { type: 'file', path: file.path, encoding: 'base64', content: Buffer.from(file.content).toString('base64') };
        }
        reply.writeHead(200, { 'content-type': 'application/json' }); reply.end(JSON.stringify(data));
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
    return { context, runtime, source, names, state, calls, hooks, transport,
      processCalls: () => processCalls,
      close: async () => {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        expect(errors).toEqual([]);
      } };
  }

  it.each([
    ['manual', 'single-maintainer-gitflow'], ['openspec', 'single-maintainer-gitflow'],
    ['spec-kit', 'single-maintainer-gitflow'], ['manual', 'team-gitflow'],
    ['openspec', 'team-gitflow'], ['spec-kit', 'team-gitflow']
  ] as const)('retains every actual full context/integration for the selected %s/%s graph', async (workflow, profile) => {
    const value = await fixture(workflow, profile);
    try {
      const observed = await observeSource5WorkflowRequirementSource({
        context: value.context, runtime: value.runtime, source: value.source
      });
      expect(Object.keys(observed).sort()).toEqual([
        'execution', 'graphHash', 'originalPlan', 'prerequisiteSession', 'requiredContextSemantics',
        'requirements', 'source', 'sourceRefCurrentness', 'status'
      ]);
      expect(observed).toMatchObject({
        status: 'observed', graphHash: canonicalSha256(value.context.records.graph), originalPlan: 'not-validated',
        sourceRefCurrentness: 'not-observed', requiredContextSemantics: 'not-validated',
        prerequisiteSession: null, execution: 'not-authorized'
      });
      expect(observed.requirements.profile).toBe(profile);
      for (const family of ['develop', 'main', 'release', 'hotfix'] as const) {
        expect(observed.requirements.families[family]).toEqual([...value.names].sort());
        value.names.forEach((name, index) => {
          expect(Object.getOwnPropertyDescriptor(observed.requirements.integrations[family], name))
            .toMatchObject({ value: 700 + index, enumerable: true });
        });
      }
      expect(observed.requirements.files).toEqual([...value.source.files].sort((a, b) => a.path.localeCompare(b.path)));
      expect(Object.isFrozen(observed.requirements.families)).toBe(true);
      expect(value.calls).toHaveLength(5);
      expect(value.calls.every(call => call.method === 'GET')).toBe(true);
      expect(value.processCalls()).toBe(0);
    } finally { await value.close(); }
  });

  it.each(['omitted', 'extra', 'nested', 'symlink', 'executable'] as const)(
    'refuses %s actual ruleset membership before reading selected source bytes', async variant => {
      const value = await fixture();
      if (variant === 'omitted') value.source.files.pop();
      else value.state.tree.tree.push({
        path: variant === 'nested' ? 'governance/rulesets/nested/extra.json' : 'governance/rulesets/extra.json',
        type: 'blob', mode: variant === 'symlink' ? '120000' : variant === 'executable' ? '100755' : '100644'
      });
      try {
        await expect(observeSource5WorkflowRequirementSource({
          context: value.context, runtime: value.runtime, source: value.source
        })).rejects.toThrow(/omitted|unsupported/);
        expect(value.calls.filter(call => call.path.includes('/contents/'))).toEqual([]);
        expect(value.processCalls()).toBe(0);
      } finally { await value.close(); }
    });

  it.each(['commit', 'tree', 'repository-id', 'repository-name', 'truncated', 'malformed'] as const)(
    'refuses actual %s readback mismatch', async variant => {
      const value = await fixture();
      if (variant === 'commit') value.state.commit.sha = 'c'.repeat(40);
      if (variant === 'tree') value.state.tree.sha = 'c'.repeat(40);
      if (variant === 'repository-id') value.state.repository.id++;
      if (variant === 'repository-name') value.state.repository.full_name = 'owner/foreign';
      if (variant === 'truncated') value.state.tree.truncated = true;
      if (variant === 'malformed') {
        // @ts-expect-error A malformed actual provider member must not disappear from the complete inventory.
        value.state.tree.tree.push({});
      }
      try {
        await expect(observeSource5WorkflowRequirementSource({
          context: value.context, runtime: value.runtime, source: value.source
        })).rejects.toThrow(/source tree|truncated|repository/);
        expect(value.processCalls()).toBe(0);
      } finally { await value.close(); }
    });

  it('refuses changed actual source bytes and the wrong selected-profile human review minimum', async () => {
    const value = await fixture();
    try {
      value.state.files[0]!.content += '\n';
      await expect(observeSource5WorkflowRequirementSource({
        context: value.context, runtime: value.runtime, source: value.source
      })).rejects.toThrow(/bytes|digest/);
      const ruleset = JSON.parse(value.state.files[0]!.content);
      ruleset.rules[1].parameters.required_approving_review_count = 1;
      value.state.files[0]!.content = JSON.stringify(ruleset);
      value.source.files[0]!.digest = workflowByteDigest(value.state.files[0]!.content);
      await expect(observeSource5WorkflowRequirementSource({
        context: value.context, runtime: value.runtime, source: value.source
      })).rejects.toThrow(/profile review minimum/);
    } finally { await value.close(); }
  });

  it('captures original source selectors before asynchronous observation', async () => {
    const value = await fixture(), original = structuredClone(value.source);
    value.hooks.afterResponse = endpoint => {
      if (endpoint === '/repos/owner/repo') { value.source.files.length = 0; value.source.sourceSha = 'c'.repeat(40); }
    };
    try {
      const observed = await observeSource5WorkflowRequirementSource({
        context: value.context, runtime: value.runtime, source: value.source
      });
      expect(observed.source).toEqual(original);
      expect(observed.requirements.files).toHaveLength(2);
    } finally { await value.close(); }
  });

  it('rejects copied context/runtime, source proof bags and extra request fields before any HTTP', async () => {
    const value = await fixture(), request = { context: value.context, runtime: value.runtime, source: value.source };
    try {
      for (const input of [
        { ...request, context: { records: value.context.records } }, { ...request, runtime: { ...value.runtime } },
        { ...request, source: { ...value.source, contexts: value.names } },
        { ...request, source: { ...value.source, sourceSha: ['a'.repeat(40)] } },
        { ...request, prerequisites: { currentness: 'current' } },
        { ...request, source: { ...value.source, files: value.source.files.map(file => ({ ...file, verified: true })) } }
      ]) await expect(Reflect.apply(observeSource5WorkflowRequirementSource, undefined, [input])).rejects.toThrow();
      const proxy = new Proxy(request, { getPrototypeOf: () => { throw new Error('Proxy trap must not execute'); } });
      await expect(observeSource5WorkflowRequirementSource(proxy)).rejects.toThrow(/accepts only/);
      const getter = { context: value.context, source: value.source };
      Object.defineProperty(getter, 'runtime', { enumerable: true, get() { throw new Error('Getter must not execute'); } });
      await expect(Reflect.apply(observeSource5WorkflowRequirementSource, undefined, [getter])).rejects.toThrow(/accepts only/);
      expect(value.calls).toEqual([]);
    } finally { await value.close(); }
  });

  it.each(['expiry', 'transport'] as const)('retains the original %s boundary across actual reads', async variant => {
    const value = await fixture(), now = Date.now();
    value.hooks.afterResponse = endpoint => {
      if (endpoint.includes('/git/trees/')) {
        if (variant === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(now + 180_001);
        else value.transport.request = async () => { throw new Error('Replacement transport must not execute'); };
      }
    };
    try {
      await expect(observeSource5WorkflowRequirementSource({
        context: value.context, runtime: value.runtime, source: value.source
      })).rejects.toMatchObject({ code: variant === 'expiry' ? 'workflow-deadline' : 'workflow-observation-runtime' });
      expect(value.calls.filter(call => call.path.includes('/contents/'))).toEqual([]);
    } finally { await value.close(); }
  });
});
