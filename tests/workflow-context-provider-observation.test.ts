import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import {
  createAuthenticatedGitHubTransport, createGitHubCliTransport, GitHubActivationClient
} from '../src/adapters/github/activation-rest.js';
import { NodeCommandRunner, type CommandRunner } from '../src/process-runner.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { workflowObservationRuntime } from '../src/governance-activation/workflow-runtime.js';
import {
  observeImmutableWorkflowExecutionRef
} from '../src/governance-activation/workflow-execution-ref-observation.js';
import {
  observeWorkflowContextProviderProof, type WorkflowContextBinding, type WorkflowContextProof
} from '../src/governance-activation/workflow-context-proof.js';

async function providerTransport(
  responseFor: (path: string) => unknown,
  headers: () => Record<string, string> = () => ({ 'x-oauth-scopes': 'repo, workflow' })
) {
  const calls: { method: string; path: string }[] = [];
  const hooks: { afterResponse?: (path: string) => void } = {};
  const server = createServer((request, reply) => {
    calls.push({ method: request.method ?? '', path: request.url ?? '' });
    if (request.method !== 'GET') { reply.writeHead(405); reply.end(); return; }
    const data = responseFor(request.url ?? '');
    reply.writeHead(data === undefined ? 404 : 200, {
      'content-type': 'application/json', ...headers()
    });
    reply.end(JSON.stringify(data ?? null));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected isolated loopback listener.');
  const transport = createAuthenticatedGitHubTransport(Buffer.from('isolated-fixture-not-a-credential'), (input, init) => {
    if (typeof input !== 'string') throw new Error('Expected literal provider URL.');
    const url = new URL(input);
    if (url.origin !== 'https://api.github.com') throw new Error('Unexpected provider origin.');
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init).then(response => {
      hooks.afterResponse?.(url.pathname);
      return response;
    });
  });
  return {
    calls, transport, hooks,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}

describe('actual bounded workflow provider transport', () => {
  it('uses the same GET-only route through a joined literal CLI process fixture', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'liftoff-workflow-cli-'));
    const script = path.join(root, 'fixture-gh.mjs');
    const expected = [
      'api', '--hostname', 'github.com', '--method', 'GET',
      '--header', 'X-GitHub-Api-Version: 2026-03-10',
      '--header', 'Accept: application/vnd.github+json', '--include', '/apps/github-actions'
    ];
    const body = 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{"id":706,"slug":"github-actions"}';
    await writeFile(script, [
      `if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(expected))}) throw new Error('Unexpected literal request.');`,
      `process.stdout.write(${JSON.stringify(body)});`
    ].join('\n'));
    let processCount = 0;
    const runner: CommandRunner = {
      run(command, options) {
        expect(command.executable).toBe('gh');
        processCount++;
        return new NodeCommandRunner().run({ executable: process.execPath, args: [script, ...command.args] }, options);
      }
    };
    const transport = createGitHubCliTransport(runner, root);
    try {
      expect(await transport.request({ method: 'GET', path: '/apps/github-actions' }))
        .toMatchObject({ status: 200, data: { id: 706, slug: 'github-actions' } });
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        await expect(transport.request({ method, path: '/apps/github-actions' }))
          .rejects.toMatchObject({ code: 'invalid-endpoint' });
      }
      expect(processCount).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reads the exact GitHub Actions application metadata used by proof observation', async () => {
    const fixture = await providerTransport(path => path === '/apps/github-actions'
      ? { id: 706, slug: 'github-actions' } : undefined);
    try {
      expect(await fixture.transport.request({ method: 'GET', path: '/apps/github-actions' }))
        .toMatchObject({ status: 200, data: { id: 706, slug: 'github-actions' } });
      expect(fixture.calls).toEqual([{ method: 'GET', path: '/apps/github-actions' }]);
    } finally { await fixture.close(); }
  });

  const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

  async function proofProvider(mode: WorkflowContextBinding['mode'] = 'green', ref = 'develop') {
    const root = await mkdtemp(path.join(tmpdir(), 'liftoff-workflow-provider-'));
    const contexts = [
      { jobId: 'backend', name: 'Repository checks / Backend behavioral tests', validationStep: 'Run backend behavioral tests' },
      { jobId: 'source', name: 'Repository checks / Source integrity', validationStep: 'Verify exact source integrity' }
    ];
    const before = 'export const twice = (n) => n * 2;\n';
    const after = 'export const twice = (n) => n * 3;\n';
    const workflow = Buffer.from(stringify({
      'run-name': 'Liftoff context proof ${{ inputs.proof_id }}',
      on: { workflow_dispatch: { inputs: Object.fromEntries(
        ['proof_id', 'protected_ref', 'source_sha'].map(name => [name, { required: true, type: 'string' }])
      ) } },
      permissions: { contents: 'read' },
      concurrency: { group: 'liftoff-context-proof-${{ inputs.proof_id }}', 'cancel-in-progress': false },
      jobs: Object.fromEntries(contexts.map((context, index) => [context.jobId, {
        name: context.name, if: '${{ github.sha == inputs.source_sha && github.run_attempt == 1 }}',
        'timeout-minutes': 3, 'runs-on': 'ubuntu-latest',
        steps: [
          { name: 'Checkout reviewed source', uses: `actions/checkout@${'1'.repeat(40)}`,
            with: { ref: '${{ inputs.source_sha }}', clean: true, 'persist-credentials': false } },
          { name: context.validationStep,
            run: `node dist/workflow-context-validator.js --validator ${index === 0 ? 'backend-tests' : 'source-integrity'} --source-sha "\${{ inputs.source_sha }}"` }
        ]
      }]))
    }));
    const binding: WorkflowContextBinding = {
      repository: 'owner/repo', repositoryId: 123,
      family: ref === 'develop' || ref === 'main' ? ref : ref.startsWith('release/') ? 'release' : 'hotfix',
      ref, sourceSha: (mode === 'green' ? 'a' : 'c').repeat(40), treeSha: 'b'.repeat(40),
      executionRef: `liftoff-execution-${(mode === 'green' ? 'a' : 'c').repeat(40)}`,
      workflowPath: '.github/workflows/proof.yml', workflowDigest: digest(workflow), contexts, mode,
      ...(mode === 'controlled-red' ? { violation: {
        path: 'backend/index.js', parentSha: 'a'.repeat(40), beforeDigest: digest(before),
        afterDigest: digest(after), context: contexts[0]!.name
      } } : {}),
      tokenSuppressedTrigger: true
    };
    const conclusion: WorkflowContextProof['conclusion'] = mode === 'green' ? 'success' : 'failure';
    const state = {
      repository: { id: 123, full_name: 'owner/repo', permissions: { push: true } },
      scopes: 'repo, workflow', workflow,
      run: { id: 701, workflow_id: 702, head_sha: binding.sourceSha, head_branch: binding.executionRef,
        path: binding.workflowPath, event: 'workflow_dispatch', run_attempt: 1,
        display_title: `Liftoff context proof ${canonicalSha256(binding)}`,
        repository: { id: 123, full_name: 'owner/repo' }, created_at: '2020-01-01T00:00:01.000Z',
        status: 'completed', conclusion: String(conclusion), check_suite_id: 703 },
      jobs: contexts.map((context, index) => ({
        id: 704 + 10 * index, name: context.name, run_id: 701, run_attempt: 1, status: 'completed',
        conclusion: mode === 'controlled-red' && index === 0 ? 'failure' : 'success',
        check_run_url: `https://api.github.com/repos/owner/repo/check-runs/${705 + 10 * index}`,
        steps: [
          { name: 'Checkout reviewed source', status: 'completed', conclusion: 'success' },
          { name: context.validationStep, status: 'completed',
            conclusion: mode === 'controlled-red' && index === 0 ? 'failure' : 'success' }
        ]
      })),
      checks: contexts.map((context, index) => ({
        id: 705 + 10 * index, head_sha: binding.sourceSha, name: context.name, status: 'completed',
        conclusion: mode === 'controlled-red' && index === 0 ? 'failure' : 'success',
        app: { id: 706, slug: 'github-actions' }, check_suite: { id: 703 }
      })),
      app: { id: 706, slug: 'github-actions' },
      ref: { ref: `refs/heads/${binding.ref}`, object: { sha: binding.violation?.parentSha ?? binding.sourceSha } },
      tag: { ref: `refs/tags/${binding.executionRef}`, object: { type: 'commit', sha: binding.sourceSha } },
      commit: { sha: binding.sourceSha, tree: { sha: binding.treeSha } },
      ruleset: {
        id: 10, source_type: 'Repository', source: 'owner/repo', target: 'tag', enforcement: 'active',
        bypass_actors: [] as { actor_id: number; actor_type: string; bypass_mode: string }[],
        conditions: { ref_name: { include: [`refs/tags/${binding.executionRef}`], exclude: [] as string[] } },
        rules: [{ type: 'update' }, { type: 'deletion' }]
      },
      difference: { status: 'ahead', total_commits: 1, ahead_by: 1,
        commits: [{ sha: binding.sourceSha, parents: [{ sha: binding.violation?.parentSha }] }],
        files: [{ filename: 'backend/index.js', status: 'modified' }] },
      totalJobs: 2, paginationLimit: false
    };
    const file = (filePath: string, bytes: Buffer | string) => ({
      type: 'file', path: filePath, encoding: 'base64', content: Buffer.from(bytes).toString('base64')
    });
    const provider = await providerTransport(url => {
      const [pathname] = url.split('?');
      if (pathname === '/repos/owner/repo') return state.repository;
      if (pathname === '/repos/owner/repo/actions/runs/701') return state.run;
      if (pathname === '/repos/owner/repo/actions/runs/701/attempts/1/jobs') return state.paginationLimit
        ? { total_count: 1001, jobs: Array.from({ length: 100 }, () => state.jobs[0]) }
        : { total_count: state.totalJobs, jobs: state.jobs };
      if (pathname === `/repos/owner/repo/commits/${binding.sourceSha}/check-runs`) {
        return { total_count: state.checks.length, check_runs: state.checks };
      }
      if (pathname === '/apps/github-actions') return state.app;
      if (pathname === `/repos/owner/repo/git/ref/heads/${binding.ref}`) return state.ref;
      if (pathname === `/repos/owner/repo/contents/${binding.workflowPath}`) return file(binding.workflowPath, state.workflow);
      if (pathname === '/repos/owner/repo/contents/backend/index.js') {
        return file('backend/index.js', url.includes(`ref=${binding.sourceSha}`) ? after : before);
      }
      if (pathname === '/repos/owner/repo/rulesets') return [{ id: 10, source_type: 'Repository', source: 'owner/repo' }];
      if (pathname === '/repos/owner/repo/rulesets/10') return state.ruleset;
      if (pathname === `/repos/owner/repo/git/commits/${binding.sourceSha}`) return state.commit;
      if (pathname === `/repos/owner/repo/git/ref/tags/${binding.executionRef}`) return state.tag;
      if (pathname === `/repos/owner/repo/compare/${binding.violation?.parentSha}...${binding.sourceSha}`) return state.difference;
      return undefined;
    }, () => ({ 'x-oauth-scopes': state.scopes }));
    let commandCount = 0;
    const runtime = workflowObservationRuntime({
      projectRoot: root, transport: provider.transport,
      runner: { async run() { commandCount++; throw new Error('Provider facts cannot run project or Git commands.'); } }
    });
    try {
      const executionAdmission = await observeImmutableWorkflowExecutionRef({
        client: new GitHubActivationClient(provider.transport)
      }, binding);
      const observed = {
        runId: 701, workflowId: 702, attempt: 1 as const, conclusion,
        contexts: contexts.map((context, index) => ({
          name: context.name, jobId: 704 + 10 * index, checkRunId: 705 + 10 * index, applicationId: 706,
          conclusion: mode === 'controlled-red' && index === 0 ? 'failure' as const : 'success' as const,
          validationStep: context.validationStep
        })),
        executionAdmission
      };
      const proof: WorkflowContextProof = {
        kind: 'workflow-context-proof.v1', binding: structuredClone(binding), bindingDigest: canonicalSha256(binding),
        planDigest: canonicalSha256({ fixture: 'retained-plan-not-owned' }), ...observed,
        observedAt: '2020-01-01T00:00:02.000Z', dispatchedAt: '2020-01-01T00:00:00.000Z',
        observationDigest: canonicalSha256(observed)
      };
      provider.calls.length = 0;
      return {
        ...provider, state, runtime, proof, commandCount: () => commandCount,
        close: async () => { await provider.close(); await rm(root, { recursive: true, force: true }); }
      };
    } catch (error) {
      await provider.close(); await rm(root, { recursive: true, force: true }); throw error;
    }
  }

  describe('independent workflow provider facts without plan or prerequisite authority', () => {
    it.each(['develop', 'main', 'release/1.0', 'hotfix/repair'])('reads retained %s metadata without refreshing authority', async ref => {
      const fixture = await proofProvider('green', ref);
      try {
        const report = await observeWorkflowContextProviderProof(fixture.runtime, fixture.proof);
        expect(report).toMatchObject({
          status: 'observed', originalPlan: 'not-validated', requiredContextSemantics: 'not-validated',
          prerequisiteSession: null, execution: 'not-authorized'
        });
        expect(report.proof).toEqual({ ...fixture.proof, observedAt: report.proof.observedAt });
        expect(report.proof.dispatchedAt).toBe('2020-01-01T00:00:00.000Z');
        expect(report.proof.contexts.map(context => context.name)).toEqual(fixture.proof.binding.contexts.map(context => context.name));
        expect(Object.isFrozen(report.proof.binding)).toBe(true);
        expect(fixture.calls).toHaveLength(13);
        expect(fixture.calls.every(call => call.method === 'GET')).toBe(true);
        expect(fixture.commandCount()).toBe(0);
      } finally { await fixture.close(); }
    });

    it('observes per-context red cause and the unchanged workflow without recording a new terminal checkpoint', async () => {
      const fixture = await proofProvider('controlled-red');
      try {
        const report = await observeWorkflowContextProviderProof(fixture.runtime, fixture.proof);
        expect(report.proof.conclusion).toBe('failure');
        expect(report.proof.contexts.map(context => context.conclusion)).toEqual(['failure', 'success']);
        expect(report.proof.observationDigest).toBe(fixture.proof.observationDigest);
        expect(fixture.calls).toHaveLength(17);
        expect(fixture.calls.every(call => call.method === 'GET')).toBe(true);
        expect(fixture.commandCount()).toBe(0);
      } finally { await fixture.close(); }
    });

    it.each([
      'run-sha', 'run-attempt', 'run-pending', 'run-conclusion', 'run-workflow', 'run-time',
      'job-missing', 'job-duplicate', 'job-check-url', 'check-app', 'check-suite', 'check-sha',
      'checkout-failure', 'validator-skipped', 'validator-missing', 'unrelated-failure',
      'repository', 'ref', 'workflow-bytes', 'commit-tree', 'tag', 'protection', 'oauth',
      'automation-token', 'incomplete-jobs'
    ] as const)('refuses actual provider %s drift without dispatch or project execution', async fault => {
      const fixture = await proofProvider();
      const { state } = fixture;
      if (fault === 'run-sha') state.run.head_sha = 'd'.repeat(40);
      if (fault === 'run-attempt') state.run.run_attempt = 2;
      if (fault === 'run-pending') state.run.status = 'queued';
      if (fault === 'run-conclusion') state.run.conclusion = 'cancelled';
      if (fault === 'run-workflow') state.run.workflow_id++;
      if (fault === 'run-time') state.run.created_at = '2020-01-01T00:03:00.001Z';
      if (fault === 'job-missing') { state.jobs.pop(); state.totalJobs--; }
      if (fault === 'job-duplicate') { state.jobs.push(structuredClone(state.jobs[0]!)); state.totalJobs++; }
      if (fault === 'job-check-url') state.jobs[0]!.check_run_url = 'https://api.github.com/repos/owner/other/check-runs/705';
      if (fault === 'check-app') state.checks[0]!.app.id++;
      if (fault === 'check-suite') state.checks[0]!.check_suite.id++;
      if (fault === 'check-sha') state.checks[0]!.head_sha = 'd'.repeat(40);
      if (fault === 'checkout-failure') state.jobs[0]!.steps[0]!.conclusion = 'failure';
      if (fault === 'validator-skipped') state.jobs[0]!.steps[1]!.conclusion = 'skipped';
      if (fault === 'validator-missing') state.jobs[0]!.steps.pop();
      if (fault === 'unrelated-failure') {
        state.jobs.push({ ...structuredClone(state.jobs[0]!), id: 800, name: 'Unrelated job', conclusion: 'failure' });
        state.totalJobs++;
      }
      if (fault === 'repository') state.repository.id++;
      if (fault === 'ref') state.ref.object.sha = 'd'.repeat(40);
      if (fault === 'workflow-bytes') state.workflow = Buffer.concat([state.workflow, Buffer.from('\nname: altered\n')]);
      if (fault === 'commit-tree') state.commit.tree.sha = 'd'.repeat(40);
      if (fault === 'tag') state.tag.object.sha = 'd'.repeat(40);
      if (fault === 'protection') state.ruleset.rules.pop();
      if (fault === 'oauth') state.scopes = 'repo';
      if (fault === 'automation-token') state.scopes = '';
      if (fault === 'incomplete-jobs') state.totalJobs++;
      try {
        await expect(observeWorkflowContextProviderProof(fixture.runtime, fixture.proof)).rejects.toThrow();
        expect(fixture.calls.length).toBeGreaterThan(0);
        expect(fixture.calls.every(call => call.method === 'GET')).toBe(true);
        expect(fixture.commandCount()).toBe(0);
      } finally { await fixture.close(); }
    });

    it.each(['setup-failure', 'wrong-file', 'multiple-files', 'multiple-parents'] as const)(
      'does not treat controlled-red %s as validator detection', async fault => {
        const fixture = await proofProvider('controlled-red');
        if (fault === 'setup-failure') fixture.state.jobs[0]!.steps[0]!.conclusion = 'failure';
        if (fault === 'wrong-file') fixture.state.difference.files[0]!.filename = '.github/workflows/proof.yml';
        if (fault === 'multiple-files') fixture.state.difference.files.push({ filename: 'backend/other.js', status: 'modified' });
        if (fault === 'multiple-parents') fixture.state.difference.commits[0]!.parents.push({ sha: 'd'.repeat(40) });
        try {
          await expect(observeWorkflowContextProviderProof(fixture.runtime, fixture.proof)).rejects.toThrow();
          expect(fixture.calls.every(call => call.method === 'GET')).toBe(true);
        } finally { await fixture.close(); }
      }
    );

    it('retains the actual client 1,000-job observation bound', async () => {
      const fixture = await proofProvider();
      fixture.state.paginationLimit = true;
      try {
        await expect(observeWorkflowContextProviderProof(fixture.runtime, fixture.proof)).rejects.toThrow(/1,000-resource bound/);
        expect(fixture.calls).toHaveLength(11);
        expect(fixture.calls.every(call => call.method === 'GET')).toBe(true);
      } finally { await fixture.close(); }
    });

    it('rejects copied runtimes and reader substitution before observing provider facts', async () => {
      const fixture = await proofProvider();
      try {
        await expect(observeWorkflowContextProviderProof({ ...fixture.runtime }, fixture.proof))
          .rejects.toMatchObject({ code: 'workflow-observation-runtime' });
        fixture.runtime.client = new GitHubActivationClient(fixture.transport);
        await expect(observeWorkflowContextProviderProof(fixture.runtime, fixture.proof))
          .rejects.toMatchObject({ code: 'workflow-observation-runtime' });
        expect(fixture.calls).toEqual([]);
      } finally { await fixture.close(); }
    });

    it('invalidates a changed underlying reader after issuance', async () => {
      const fixture = await proofProvider();
      const original = fixture.transport.request;
      fixture.transport.request = request => original(request);
      try {
        await expect(observeWorkflowContextProviderProof(fixture.runtime, fixture.proof))
          .rejects.toMatchObject({ code: 'workflow-observation-runtime' });
        expect(fixture.calls).toEqual([]);
      } finally { await fixture.close(); }
    });

    it('refuses imported authority fields or inconsistent retained facts before provider reads', async () => {
      const fixture = await proofProvider();
      try {
        for (const proof of [
          { ...fixture.proof, approval: 'not-an-issued-approval' },
          { ...fixture.proof, binding: { ...fixture.proof.binding, issuer: 'imported' } },
          { ...fixture.proof, binding: { ...fixture.proof.binding,
            contexts: [{ ...fixture.proof.binding.contexts[0]!, approval: true }] } },
          { ...fixture.proof, contexts: [{ ...fixture.proof.contexts[0]!, approval: true }] },
          { ...fixture.proof, executionAdmission: { ...fixture.proof.executionAdmission, approval: true } },
          { ...fixture.proof, contexts: [] },
          { ...fixture.proof, observedAt: 'invalid' },
          { ...fixture.proof, planDigest: 'not-a-digest' }
        ]) {
          await expect(observeWorkflowContextProviderProof(fixture.runtime, proof)).rejects.toThrow();
        }
        expect(fixture.calls).toEqual([]);
      } finally { await fixture.close(); }
    });

    it('captures the supplied reference before asynchronous provider observation', async () => {
      const fixture = await proofProvider();
      const original = structuredClone(fixture.proof);
      fixture.hooks.afterResponse = () => { fixture.proof.binding.sourceSha = 'd'.repeat(40); };
      try {
        const report = await observeWorkflowContextProviderProof(fixture.runtime, fixture.proof);
        expect(report.proof).toEqual({ ...original, observedAt: report.proof.observedAt });
        expect(fixture.proof.binding.sourceSha).toBe('d'.repeat(40));
      } finally { await fixture.close(); }
    });

    it('rechecks original runtime ownership after awaited provider responses', async () => {
      const fixture = await proofProvider();
      fixture.hooks.afterResponse = () => { fixture.runtime.client = new GitHubActivationClient(fixture.transport); };
      try {
        await expect(observeWorkflowContextProviderProof(fixture.runtime, fixture.proof))
          .rejects.toMatchObject({ code: 'workflow-observation-runtime' });
        expect(fixture.calls).toHaveLength(1);
      } finally { await fixture.close(); }
    });

    it('cannot refresh the original runtime cutoff when rereading retained terminal metadata', async () => {
      const now = Date.now();
      let clock = now;
      const date = vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const fixture = await proofProvider();
      fixture.hooks.afterResponse = () => { clock = now + 180_001; };
      try {
        await expect(observeWorkflowContextProviderProof(fixture.runtime, fixture.proof))
          .rejects.toMatchObject({ code: 'workflow-deadline' });
        expect(fixture.calls).toHaveLength(1);
        await expect(observeWorkflowContextProviderProof(fixture.runtime, fixture.proof))
          .rejects.toMatchObject({ code: 'workflow-deadline' });
        expect(fixture.calls).toHaveLength(1);
      } finally { date.mockRestore(); await fixture.close(); }
    });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('does not admit %s through the new metadata route', async method => {
    const fixture = await providerTransport(() => ({ id: 706, slug: 'github-actions' }));
    try {
      await expect(fixture.transport.request({ method, path: '/apps/github-actions' }))
        .rejects.toMatchObject({ code: 'invalid-endpoint' });
      expect(fixture.calls).toEqual([]);
    } finally { await fixture.close(); }
  });

  it.each([
    '/apps/other', '/apps/github-actions/extra', '/apps/github-actions?unexpected=true',
    '//apps/github-actions', '/apps/github-actions#fragment', '/apps/github-actions%2f'
  ])('keeps the unrelated endpoint %s outside the route', async path => {
    const fixture = await providerTransport(() => ({ id: 706, slug: 'github-actions' }));
    try {
      await expect(fixture.transport.request({ method: 'GET', path })).rejects.toMatchObject({ code: 'invalid-endpoint' });
      expect(fixture.calls).toEqual([]);
    } finally { await fixture.close(); }
  });
});
