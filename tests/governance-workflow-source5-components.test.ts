import { afterEach, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { stringify } from 'yaml';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import type { GitHubActivationTransport, GitHubRequest } from '../src/adapters/github/activation-rest.js';
import type { CommandRunner } from '../src/process-runner.js';
import type { ProjectMutationLease } from '../src/adapters/filesystem/project-lock.js';
import {
  issueSource5WorkflowApproval, restoreSource5WorkflowAuthority, source5WorkflowOriginalPlanValue, withSource5WorkflowLease
} from '../src/governance-activation/workflow-source5-authority.js';
import { openSource5WorkflowJournal } from '../src/governance-activation/workflow-source5-journal.js';
import {
  executeSource5WorkflowComponent, executeSource5WorkflowPlanComponents, observeSource5WorkflowPlanMatrix
} from '../src/governance-activation/workflow-source5-components.js';
import { workflowByteDigest } from '../src/governance-activation/workflow-binding.js';
import type { WorkflowContextBinding } from '../src/governance-activation/workflow-context-proof.js';
import type { Source5WorkflowOrigin } from '../src/governance-activation/workflow-source5-operations.js';
import { workflowPublicationGitRawInventory, workflowSource5JournalFixture } from './fixtures/workflow-source5-journal.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
type Review = ReturnType<Awaited<ReturnType<typeof workflowSource5JournalFixture>>['review']>;
function recipe() {
  return stringify({
    name: 'Isolated private validator', 'run-name': 'Liftoff context proof ${{ inputs.proof_id }}',
    on: { workflow_dispatch: { inputs: Object.fromEntries(['proof_id', 'protected_ref', 'source_sha']
      .map(key => [key, { type: 'string', required: true }])) } },
    permissions: { contents: 'read' },
    concurrency: { group: 'liftoff-context-proof-${{ inputs.proof_id }}', 'cancel-in-progress': false },
    jobs: { validate: {
      name: 'Required validation', if: '${{ github.sha == inputs.source_sha && github.run_attempt == 1 }}',
      'runs-on': 'ubuntu-latest', 'timeout-minutes': 5,
      steps: [
        { name: 'Checkout reviewed source', uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
          with: { ref: '${{ inputs.source_sha }}', clean: true, 'persist-credentials': false } },
        { name: 'Validate source', run: 'node --check backend/application.js' }
      ]
    } }
  });
}
async function seal(value: Review) {
  await value.store.save('plan', value.control.controlKey,
    source5WorkflowOriginalPlanValue(value.projectRoot, value.plan, value.approval), null);
  return value;
}
async function fixture(mode: 'green' | 'controlled-red' = 'green') {
  const seed = await workflowSource5JournalFixture(); roots.push(seed.root);
  const content = recipe(), sourceBinding = { ...seed.binding, files: [{ ...seed.binding.files[0]!, content, digest: workflowByteDigest(content) }] };
  const source = await seal({ ...seed.review({ phaseId: 'workflow-source-ready', effects: [
    { action: 'git.workflow-source.publish-reviewed', binding: sourceBinding }
  ] }), binding: sourceBinding });
  let origin: Source5WorkflowOrigin | undefined;
  await withSource5WorkflowLease(seed.projectRoot, async lease => {
    const journal = await openSource5WorkflowJournal({ ...source, lease, initialize: true });
    await issueSource5WorkflowApproval({ ...source, lease }, source.now);
    const base = { bindingDigest: canonicalSha256(sourceBinding), planDigest: source.plan.planDigest }, commitSha = 'c'.repeat(40);
    await journal.record(source.operation, 'publication-writing', { ...base, stage: 'writing' });
    await journal.record(source.operation, 'publication-commit-intent', base);
    await journal.record(source.operation, 'publication-commit-observed', { ...base, commitSha });
    await journal.record(source.operation, 'publication-committed', { ...base, stage: 'committed', commitSha });
    await journal.record(source.operation, 'publication-published', { ...base, stage: 'published', commitSha });
    const observed = { repository: sourceBinding.repository, repositoryId: sourceBinding.repositoryId,
      ref: sourceBinding.ref, parentSha: sourceBinding.parentSha, commitSha, treeSha: 'b'.repeat(40),
      files: sourceBinding.files.map(({ path, digest }) => ({ path, digest })) };
    const proof = { kind: 'workflow-source-publication.v1', ...observed, bindingDigest: base.bindingDigest,
      observedAt: source.now.toISOString(), observationDigest: canonicalSha256(observed) };
    await journal.record(source.operation, 'component-completed', { ...base, proof });
    origin = { planKey: source.control.controlKey, proofKey: journal.proofKey(source.operation),
      publicationDigest: canonicalSha256(proof), commitSha, treeSha: observed.treeSha };
  });
  const binding: WorkflowContextBinding = { repository: 'owner/repo', repositoryId: 123, family: 'develop', ref: 'develop',
    sourceSha: mode === 'green' ? 'c'.repeat(40) : 'd'.repeat(40), treeSha: 'b'.repeat(40),
    executionRef: `liftoff-execution-${(mode === 'green' ? 'c' : 'd').repeat(40)}`,
    workflowPath: sourceBinding.files[0]!.path, workflowDigest: workflowByteDigest(content),
    contexts: [{ jobId: 'validate', name: 'Required validation', validationStep: 'Validate source' }],
    mode, tokenSuppressedTrigger: true, ...(mode === 'controlled-red' ? { violation: {
      path: 'backend/application.js', parentSha: 'c'.repeat(40), beforeDigest: workflowByteDigest('export const valid = true;\n'),
      afterDigest: workflowByteDigest('export const valid = ;\n'), context: 'Required validation'
    } } : {}) };
  const value = await seal(seed.review({ phaseId: 'dev-proof', origin, effects: [{ action: 'github.checks.dev-proof', binding }] }));
  return { value, binding, source, origin: origin!, content, review: seed.review };
}
async function fields(value: Review, lease: ProjectMutationLease,
  runner: CommandRunner, transport: GitHubActivationTransport, initialize = true, now = value.now) {
  if (initialize) await issueSource5WorkflowApproval({ ...value, lease }, now);
  const authority = await restoreSource5WorkflowAuthority({ ...value, lease }, now);
  const phase = value.context.records.graph.phases.find(phase => phase.id === value.control.phaseId)!;
  return { projectRoot: value.projectRoot, plan: value.plan, operation: value.operation,
    phase: { ...phase, id: value.control.phaseId }, authority, lease, now,
    runner, transport, profile: value.plan.identity.profile };
}
function noGit(): CommandRunner {
  return { async run() { throw new Error('This isolated workflow component must not execute a process.'); } };
}
async function provider(f: Awaited<ReturnType<typeof fixture>>) {
  const calls: GitHubRequest[] = [];
  let dispatched = false, runReads = 0;
  const state = { status: 'completed', conclusion: f.binding.mode === 'green' ? 'success' : 'failure',
    driftOnSecondRun: false, checkName: 'Required validation', tagSha: f.binding.sourceSha,
    network: 'isolated-network' };
  const run = () => ({ id: 901, workflow_id: 90, check_suite_id: 911, run_attempt: 1,
    head_sha: state.driftOnSecondRun && runReads >= 2 ? 'f'.repeat(40) : f.binding.sourceSha,
    head_branch: f.binding.executionRef, path: f.binding.workflowPath,
    display_title: `Liftoff context proof ${canonicalSha256(f.binding)}`, event: 'workflow_dispatch',
    repository: { id: 123, full_name: 'owner/repo' }, created_at: f.value.now.toISOString(),
    status: state.status, conclusion: state.conclusion });
  function response(request: GitHubRequest): unknown {
    if (request.method === 'POST') {
      if (request.path !== '/repos/owner/repo/actions/workflows/90/dispatches' ||
        canonicalSha256(request.body) !== canonicalSha256({ ref: f.binding.executionRef, inputs: {
          source_sha: f.binding.sourceSha, protected_ref: 'refs/heads/develop', proof_id: canonicalSha256(f.binding) } })) {
        throw new Error('Unexpected isolated dispatch.');
      }
      dispatched = true;
      return { workflow_run_id: 901, run_url: 'https://api.github.com/repos/owner/repo/actions/runs/901',
        html_url: 'https://github.com/owner/repo/actions/runs/901' };
    }
    if (request.method !== 'GET') throw new Error('No other provider effect is authorized in this fixture.');
    if (request.path === '/user/memberships/orgs/owner') return {
      state: 'active', role: 'admin', organization: { login: 'owner' }
    };
    if (request.path.includes('/runner-groups/')) return request.path.includes('/repositories') ? {
      total_count: 1, repositories: [{ id: 123, full_name: 'owner/repo' }]
    } : { id: 72, name: 'Isolated private group', network_configuration_id: state.network,
      visibility: 'selected', inherited: false, workflow_restrictions_read_only: false,
      allows_public_repositories: false, restricted_to_workflows: true,
      selected_workflows: [`owner/repo/${f.binding.workflowPath}@refs/tags/${f.binding.executionRef}`] };
    if (request.path === '/repos/owner/repo') return { id: 123, full_name: 'owner/repo', permissions: { push: true } };
    if (request.path === '/apps/github-actions') return { id: 15368, slug: 'github-actions' };
    if (request.path.includes('/rulesets?')) return [{ id: 11, source_type: 'Repository', source: 'owner/repo' }];
    if (request.path.includes('/rulesets/')) return { id: 11, source_type: 'Repository', source: 'owner/repo',
      target: 'tag', enforcement: 'active', bypass_actors: [], conditions: { ref_name: {
        include: ['refs/tags/liftoff-execution-*'], exclude: [] } }, rules: [{ type: 'update' }, { type: 'deletion' }] };
    if (request.path.includes('/git/ref/tags/')) return { ref: `refs/tags/${f.binding.executionRef}`,
      object: { type: 'commit', sha: state.tagSha } };
    if (request.path.includes(`/git/ref/heads/${f.source.binding.ref}`)) return {
      ref: `refs/heads/${f.source.binding.ref}`, object: { sha: 'c'.repeat(40) }
    };
    if (request.path.includes('/git/ref/heads/')) return { ref: 'refs/heads/develop',
      object: { sha: f.binding.violation?.parentSha ?? f.binding.sourceSha } };
    if (request.path.includes('/git/commits/')) return { sha: f.binding.sourceSha, tree: { sha: f.binding.treeSha },
      parents: [{ sha: f.source.binding.parentSha }] };
    if (request.path.includes('/contents/')) {
      const file = request.path.split('/contents/')[1]!.split('?')[0]!;
      const content = file === f.binding.workflowPath ? f.content :
        request.path.endsWith(f.binding.violation!.parentSha) ? 'export const valid = true;\n' : 'export const valid = ;\n';
      return { type: 'file', path: file, encoding: 'base64', content: Buffer.from(content).toString('base64') };
    }
    if (request.path.includes('/compare/')) return { status: 'ahead', total_commits: 1, ahead_by: 1,
      commits: [{ sha: f.binding.sourceSha, parents: [{ sha: f.binding.violation!.parentSha }] }],
      files: [{ filename: f.binding.violation!.path, status: 'modified' }] };
    if (request.path.includes('/jobs')) return { total_count: 1, jobs: [{ id: 902, run_id: 901, run_attempt: 1,
      name: 'Required validation', check_run_url: 'https://api.github.com/repos/owner/repo/check-runs/903',
      status: 'completed', conclusion: f.binding.mode === 'green' ? 'success' : 'failure',
      steps: [{ name: 'Checkout reviewed source', status: 'completed', conclusion: 'success' },
        { name: 'Validate source', status: 'completed', conclusion: f.binding.mode === 'green' ? 'success' : 'failure' }] }] };
    if (request.path.includes('/check-runs')) return { total_count: 1, check_runs: [{ id: 903, head_sha: f.binding.sourceSha,
      name: state.checkName, status: 'completed', conclusion: f.binding.mode === 'green' ? 'success' : 'failure',
      app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 911 } }] };
    if (request.path.includes('/runs?')) return { total_count: dispatched ? 1 : 0, workflow_runs: dispatched ? [run()] : [] };
    if (request.path.includes('/workflows/')) return { id: 90, path: f.binding.workflowPath, state: 'active' };
    if (request.path.includes('/actions/runs/')) { runReads++; return run(); }
    throw new Error(`Unexpected isolated endpoint ${request.path}`);
  }
  const server = createServer(async (request, reply) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input: GitHubRequest = { method: request.method === 'POST' ? 'POST' : 'GET', path: request.url!,
      ...(chunks.length ? { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) } : {}) };
    calls.push(input);
    const data = response(input);
    reply.writeHead(200, { 'content-type': 'application/json', 'x-oauth-scopes': 'repo, workflow, admin:org' });
    reply.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected isolated loopback listener.');
  const transport: GitHubActivationTransport = { async request(request) {
    const result = await fetch(`http://127.0.0.1:${address.port}${request.path}`, {
      method: request.method, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.timeout(30_000)
    });
    return { status: result.status, headers: { 'x-oauth-scopes': result.headers.get('x-oauth-scopes') ?? '' },
      data: await result.json() };
  } };
  return { transport, calls, state, get runReads() { return runReads; },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

describe('private source5 original component orchestration', () => {
  it('refuses to relabel an individual phase as the independently current complete green/red matrix', async () => {
    const f = await fixture(), p = await provider(f);
    try {
      await withSource5WorkflowLease(f.value.projectRoot, async lease => {
        const journal = await openSource5WorkflowJournal({ ...f.value, lease, initialize: true });
        const { operation: _, ...input } = await fields(f.value, lease, noGit(), p.transport);
        const requirements = { profile: 'single-maintainer-gitflow' as const, sourceDigest: '0'.repeat(64), files: [],
          families: { develop: [], main: [], release: [], hotfix: [] },
          integrations: { develop: {}, main: {}, release: {}, hotfix: {} } };
        await expect(observeSource5WorkflowPlanMatrix(input, journal, requirements)).rejects.toThrow(/complete original green\/red plan/);
        expect(p.calls).toEqual([]);
        expect(await journal.events(f.value.operation)).toEqual([]);
      });
    } finally { await p.close(); }
  });

  it.each(['green', 'controlled-red'] as const)(
    'observes every original %s plan entry without claiming a completed phase or matrix', async mode => {
      const f = await fixture(mode), p = await provider(f);
      try {
        await withSource5WorkflowLease(f.value.projectRoot, async lease => {
          const journal = await openSource5WorkflowJournal({ ...f.value, lease, initialize: true });
          const { operation: _, ...input } = await fields(f.value, lease, noGit(), p.transport);
          const result = await executeSource5WorkflowPlanComponents(input, journal);
          expect(result).toMatchObject({
            status: 'components-observed', phaseComplete: false, matrixComplete: false,
            controlKey: f.value.control.controlKey, planDigest: f.value.plan.planDigest, unexecutedOperationDigests: [],
            observations: [{ operationDigest: canonicalSha256(f.value.operation), actionId: f.value.operation.actionId,
              result: { status: 'completed', proof: { runId: 901, conclusion: mode === 'green' ? 'success' : 'failure' } } }]
          });
          expect(result.observations).toHaveLength(1);
          expect(await journal.readFinalization()).toBeNull();
          expect(p.calls.filter(call => call.method === 'POST')).toHaveLength(1);
        });
      } finally { await p.close(); }
    });

  it('stops a whole plan at its original pending entry and exposes the untouched remaining inventory', async () => {
    const f = await fixture(), p = await provider(f);
    const value = await seal(f.review({ phaseId: 'dev-proof', origin: f.origin, effects: [
      { action: 'github.checks.dev-proof', binding: f.binding },
      { action: 'github.checks.dev-proof', binding: { ...f.binding, family: 'release', ref: 'release/fixture' } }
    ] }));
    p.state.status = 'queued';
    try {
      await withSource5WorkflowLease(value.projectRoot, async lease => {
        const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: true });
        const { operation: _, ...input } = await fields(value, lease, noGit(), p.transport);
        const result = await executeSource5WorkflowPlanComponents(input, journal);
        const later = value.plan.operations[1]!;
        expect(result).toMatchObject({
          status: 'pending', phaseComplete: false, matrixComplete: false,
          unexecutedOperationDigests: [canonicalSha256(later)],
          observations: [{ result: { status: 'pending', checkpoint: { runId: 901, stage: 'accepted' } } }]
        });
        expect(result.observations).toHaveLength(1);
        expect(await journal.events(later)).toEqual([]);
        expect(p.calls.filter(call => call.method !== 'GET')).toHaveLength(1);
      });
    } finally { await p.close(); }
  });

  it('validates a later original binding before submitting the first effect', async () => {
    const f = await fixture(), p = await provider(f);
    const value = await seal(f.review({ phaseId: 'dev-proof', origin: f.origin, effects: [
      { action: 'github.checks.dev-proof', binding: f.binding },
      { action: 'github.checks.dev-proof', binding: { ...f.binding, contexts: [] } }
    ] }));
    try {
      await withSource5WorkflowLease(value.projectRoot, async lease => {
        const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: true });
        const { operation: _, ...input } = await fields(value, lease, noGit(), p.transport);
        await expect(executeSource5WorkflowPlanComponents(input, journal)).rejects.toThrow();
        expect(p.calls).toEqual([]);
        expect(await journal.events(value.operation)).toEqual([]);
        expect(await journal.events(value.plan.operations[1]!)).toEqual([]);
      });
    } finally { await p.close(); }
  });

  it('retains an original failing terminal and never starts a later entry or fabricates finalization', async () => {
    const f = await fixture(), p = await provider(f);
    const value = await seal(f.review({ phaseId: 'dev-proof', origin: f.origin, effects: [
      { action: 'github.checks.dev-proof', binding: f.binding },
      { action: 'github.checks.dev-proof', binding: { ...f.binding, family: 'release', ref: 'release/fixture' } }
    ] }));
    p.state.conclusion = 'failure';
    try {
      await withSource5WorkflowLease(value.projectRoot, async lease => {
        const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: true });
        const { operation: _, ...input } = await fields(value, lease, noGit(), p.transport);
        await expect(executeSource5WorkflowPlanComponents(input, journal)).rejects.toThrow(/actual workflow did not reach/);
        expect((await journal.events(value.operation)).at(-1)).toMatchObject({
          stage: 'dispatch-terminal', data: { terminalConclusion: 'failure' }
        });
        expect(await journal.events(value.plan.operations[1]!)).toEqual([]);
        expect(await journal.readFinalization()).toBeNull();
        expect(p.calls.filter(call => call.method !== 'GET')).toHaveLength(1);
      });
    } finally { await p.close(); }
  });

  it.each(['operation', 'observationOnly', 'reviewedPlans', 'recordWorkflowDispatch'] as const)(
    'rejects whole-plan caller %s overrides before any provider call', async key => {
      const f = await fixture(), p = await provider(f);
      try {
        await withSource5WorkflowLease(f.value.projectRoot, async lease => {
          const journal = await openSource5WorkflowJournal({ ...f.value, lease, initialize: true });
          const { operation: _, ...input } = await fields(f.value, lease, noGit(), p.transport);
          Reflect.set(input, key, true);
          await expect(executeSource5WorkflowPlanComponents(input, journal)).rejects.toThrow(/closed own runtime fields/);
          expect(await journal.events(f.value.operation)).toEqual([]);
          expect(p.calls).toEqual([]);
        });
      } finally { await p.close(); }
    });

  it.each(['callback', 'accessor', 'symbol', 'prototype'] as const)(
    'rejects caller %s fields before callbacks, intent, carrier claim or provider calls', async fault => {
      const f = await fixture(), p = await provider(f);
      let invoked = 0;
      try {
        await withSource5WorkflowLease(f.value.projectRoot, async lease => {
          const journal = await openSource5WorkflowJournal({ ...f.value, lease, initialize: true });
          const input = await fields(f.value, lease, noGit(), p.transport);
          const invalid = fault === 'callback' ? { ...input, recordWorkflowDispatch: async () => { invoked++; } } :
            fault === 'accessor' ? { ...input, get operation() { invoked++; return input.operation; } } :
              fault === 'symbol' ? { ...input, [Symbol('unreviewed')]: true } :
                Object.setPrototypeOf({ ...input }, { foreign: true });
          await expect(executeSource5WorkflowComponent(invalid, journal)).rejects.toThrow(/closed own runtime fields/);
          expect(invoked).toBe(0);
          expect(await journal.events(f.value.operation)).toEqual([]);
          expect(p.calls).toEqual([]);
        });
      } finally { await p.close(); }
    });

  it('captures original operation and date before asynchronous inventory reads can observe caller mutation', async () => {
    const f = await fixture(), p = await provider(f);
    try {
      await withSource5WorkflowLease(f.value.projectRoot, async lease => {
        const journal = await openSource5WorkflowJournal({ ...f.value, lease, initialize: true });
        const input = await fields(f.value, lease, noGit(), p.transport);
        input.now = new Date(input.now.getTime());
        const execution = executeSource5WorkflowComponent(input, journal);
        input.operation = { ...input.operation, inputs: { ...input.operation.inputs, ref: 'main' } };
        input.now.setTime(Date.parse('2030-01-01T00:00:00.000Z'));
        expect(await execution).toMatchObject({ status: 'completed',
          proof: { binding: f.binding, dispatchedAt: f.value.now.toISOString() },
          currentObservedAt: f.value.now.toISOString() });
        expect((await journal.events(f.value.operation)).at(-1)?.data.proof).toMatchObject({ binding: f.binding });
        expect(p.calls.filter(call => call.method !== 'GET')).toHaveLength(1);
      });
    } finally { await p.close(); }
  });

  it.each(['green', 'controlled-red'] as const)('retains a %s component only after independently rereading actual jobs/checks/source through HTTP', async mode => {
    const f = await fixture(mode), p = await provider(f);
    try {
      await withSource5WorkflowLease(f.value.projectRoot, async lease => {
        const journal = await openSource5WorkflowJournal({ ...f.value, lease, initialize: true });
        const input = await fields(f.value, lease, noGit(), p.transport);
        const result = await executeSource5WorkflowComponent(input, journal);
        expect(result).toMatchObject({ status: 'completed', proof: { runId: 901, conclusion: mode === 'green' ? 'success' : 'failure' } });
        expect((await journal.events(f.value.operation)).map(event => event.stage))
          .toEqual(['dispatch-intent', 'dispatch-accepted', 'dispatch-terminal', 'component-completed']);
        expect(p.calls.filter(call => call.method === 'POST')).toHaveLength(1);
        expect(p.runReads).toBe(2);
        expect(p.calls.filter(call => call.path.includes('/check-runs'))).toHaveLength(2);
      });
    } finally { await p.close(); }
  });

  it('resumes accepted pending work with its original ID/time/plan, preserves completed bytes on later current observation, and never redispatches', async () => {
    const f = await fixture(), p = await provider(f);
    try {
      p.state.status = 'queued';
      await withSource5WorkflowLease(f.value.projectRoot, async lease => {
        const journal = await openSource5WorkflowJournal({ ...f.value, lease, initialize: true });
        const result = await executeSource5WorkflowComponent(await fields(f.value, lease, noGit(), p.transport), journal);
        expect(result).toMatchObject({ status: 'pending', checkpoint: { runId: 901, stage: 'accepted',
          dispatchedAt: f.value.now.toISOString(), planDigest: f.value.plan.planDigest } });
      });
      p.state.status = 'completed';
      let proofBytes: Buffer, proofTime: unknown;
      await withSource5WorkflowLease(f.value.projectRoot, async lease => {
        const journal = await openSource5WorkflowJournal({ ...f.value, lease, initialize: false });
        const result = await executeSource5WorkflowComponent(await fields(f.value, lease, noGit(), p.transport, false), journal);
        expect(result.status).toBe('completed');
        const component = (await journal.events(f.value.operation)).at(-1)!;
        proofTime = component.data.proof;
        proofBytes = await readFile((await f.value.store.read('proof', journal.proofKey(f.value.operation)))!.path);
      });
      await withSource5WorkflowLease(f.value.projectRoot, async lease => {
        const journal = await openSource5WorkflowJournal({ ...f.value, lease, initialize: false });
        const later = new Date(f.value.now.getTime() + 60_000);
        const result = await executeSource5WorkflowComponent(await fields(f.value, lease, noGit(), p.transport, false, later), journal);
        expect(result).toMatchObject({ status: 'completed', proof: proofTime, currentObservedAt: later.toISOString() });
        expect(await readFile((await f.value.store.read('proof', journal.proofKey(f.value.operation)))!.path)).toEqual(proofBytes!);
      });
      expect(p.calls.filter(call => call.method !== 'GET')).toHaveLength(1);
    } finally { await p.close(); }
  });

  it('retains terminal truth but withholds the component when its separate current run reread drifts', async () => {
    const f = await fixture(), p = await provider(f);
    try {
      p.state.driftOnSecondRun = true;
      await withSource5WorkflowLease(f.value.projectRoot, async lease => {
        const journal = await openSource5WorkflowJournal({ ...f.value, lease, initialize: true });
        await expect(executeSource5WorkflowComponent(await fields(f.value, lease, noGit(), p.transport), journal)).rejects.toThrow(/Actual workflow run/);
        const events = await journal.events(f.value.operation);
        expect(events.at(-1)).toMatchObject({ stage: 'dispatch-terminal', data: { runId: 901, terminalConclusion: 'success' } });
        expect(await f.value.store.read('proof', journal.proofKey(f.value.operation))).toBeNull();
        expect(p.calls.filter(call => call.method !== 'GET')).toHaveLength(1);
      });
    } finally { await p.close(); }
  });

  it('never reclassifies an original failing green terminal as success or repeats it on restart', async () => {
    const f = await fixture(), p = await provider(f);
    try {
      p.state.conclusion = 'failure';
      await withSource5WorkflowLease(f.value.projectRoot, async lease => {
        const journal = await openSource5WorkflowJournal({ ...f.value, lease, initialize: true });
        await expect(executeSource5WorkflowComponent(await fields(f.value, lease, noGit(), p.transport), journal)).rejects.toThrow(/actual workflow did not reach/);
        expect((await journal.events(f.value.operation)).at(-1)).toMatchObject({
          stage: 'dispatch-terminal', data: { terminalConclusion: 'failure' }
        });
      });
      p.state.conclusion = 'success';
      await withSource5WorkflowLease(f.value.projectRoot, async lease => {
        const journal = await openSource5WorkflowJournal({ ...f.value, lease, initialize: false });
        await expect(executeSource5WorkflowComponent(await fields(f.value, lease, noGit(), p.transport, false), journal)).rejects.toThrow(/actual terminal provider outcome/);
        expect(await f.value.store.read('proof', journal.proofKey(f.value.operation))).toBeNull();
      });
      expect(p.calls.filter(call => call.method !== 'GET')).toHaveLength(1);
    } finally { await p.close(); }
  });

  it('withholds current qualification after a completed original check drifts without changing its component receipt', async () => {
    const f = await fixture(), p = await provider(f);
    try {
      await withSource5WorkflowLease(f.value.projectRoot, async lease => {
        const journal = await openSource5WorkflowJournal({ ...f.value, lease, initialize: true });
        await executeSource5WorkflowComponent(await fields(f.value, lease, noGit(), p.transport), journal);
      });
      p.state.checkName = 'Foreign check';
      await withSource5WorkflowLease(f.value.projectRoot, async lease => {
        const journal = await openSource5WorkflowJournal({ ...f.value, lease, initialize: false });
        const original = (await f.value.store.read('proof', journal.proofKey(f.value.operation)))!, bytes = await readFile(original.path);
        await expect(executeSource5WorkflowComponent(await fields(f.value, lease, noGit(), p.transport, false), journal)).rejects.toThrow(/Required contexts must be actual/);
        expect(await readFile(original.path)).toEqual(bytes);
        expect((await journal.events(f.value.operation)).at(-1)!.stage).toBe('component-completed');
      });
      expect(p.calls.filter(call => call.method !== 'GET')).toHaveLength(1);
    } finally { await p.close(); }
  });

  it.each(['extra-binding', 'missing-job'] as const)('rejects coherently reapproved %s before an intent, carrier claim or provider call', async fault => {
    const f = await fixture(), p = await provider(f);
    try {
      const binding = fault === 'extra-binding' ? { ...f.binding, extra: 'not-reviewed-protocol' } :
        { ...f.binding, contexts: [{ name: 'Required validation', validationStep: 'Validate source' }] };
      const value = await seal(f.review({ phaseId: 'dev-proof', origin: f.origin,
        effects: [{ action: 'github.checks.dev-proof', binding }] }));
      await withSource5WorkflowLease(value.projectRoot, async lease => {
        const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: true });
        await expect(executeSource5WorkflowComponent(await fields(value, lease, noGit(), p.transport), journal)).rejects.toThrow(/closed exact original binding/);
        expect(await journal.events(value.operation)).toEqual([]);
        expect(p.calls).toEqual([]);
      });
    } finally { await p.close(); }
  });

  it.each(['execution-ref', 'runner'] as const)('independently observes the original %s before retaining a no-write component', async kind => {
    const f = await fixture(), p = await provider(f);
    try {
      const binding = kind === 'execution-ref' ? {
        repository: f.binding.repository, repositoryId: f.binding.repositoryId, sourceSha: f.binding.sourceSha,
        treeSha: f.binding.treeSha, executionRef: f.binding.executionRef
      } : { repository: f.binding.repository, repositoryId: f.binding.repositoryId, groupId: 72,
        groupName: 'Isolated private group', networkConfigurationId: 'isolated-network', beforeWorkflows: [],
        afterWorkflows: [`owner/repo/${f.binding.workflowPath}@refs/tags/${f.binding.executionRef}`] };
      const value = await seal(f.review({ phaseId: 'workflow-source-ready', origin: f.origin, effects: [{
        action: kind === 'execution-ref' ? 'github.workflow-source.bind-execution-ref' : 'github.workflow-source.admit-reviewed', binding
      }] }));
      await withSource5WorkflowLease(value.projectRoot, async lease => {
        const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: true });
        const result = await executeSource5WorkflowComponent(await fields(value, lease, noGit(), p.transport), journal);
        expect(result.status).toBe('completed');
        expect((await journal.events(value.operation)).map(event => event.stage)).toEqual(['component-completed']);
        expect(p.calls.filter(call => call.method !== 'GET')).toEqual([]);
      });
      if (kind === 'execution-ref') p.state.tagSha = 'f'.repeat(40); else p.state.network = 'foreign-network';
      await withSource5WorkflowLease(value.projectRoot, async lease => {
        const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: false });
        const original = (await value.store.read('proof', journal.proofKey(value.operation)))!, bytes = await readFile(original.path);
        await expect(executeSource5WorkflowComponent(await fields(value, lease, noGit(), p.transport, false), journal)).rejects.toThrow();
        expect(await readFile(original.path)).toEqual(bytes);
        expect(p.calls.filter(call => call.method !== 'GET')).toEqual([]);
      });
    } finally { await p.close(); }
  });

  it.each(['unchanged', 'executable', 'symlink', 'missing', 'extra', 'duplicate', 'truncated',
    'abbreviated-blob', 'wrong-blob', 'deletion', 'prior-mode'] as const)(
    'reobserves published original commit/parent/inventory/bytes without Git writes or changing immutable proof time: %s', async fault => {
    const f = await fixture(), p = await provider(f);
    let inventory = workflowPublicationGitRawInventory(f.source.binding.files);
    if (fault === 'executable') inventory = inventory.replace(' 100644 ', ' 100755 ');
    if (fault === 'symlink') inventory = inventory.replace(' 100644 ', ' 120000 ');
    if (fault === 'missing') inventory = '';
    if (fault === 'extra') inventory += workflowPublicationGitRawInventory([
      { ...f.source.binding.files[0]!, path: '.github/workflows/unreviewed.yml' }
    ]);
    if (fault === 'duplicate') inventory += inventory;
    if (fault === 'truncated') inventory = inventory.slice(0, -1);
    if (fault === 'abbreviated-blob') inventory = inventory.replace(/ [a-f0-9]{40} A/u, ' abc1234 A');
    if (fault === 'wrong-blob') inventory = inventory.replace(/ [a-f0-9]{40} A/u, ` ${'e'.repeat(40)} A`);
    if (fault === 'deletion') inventory = inventory.replace(' A\0', ' D\0');
    if (fault === 'prior-mode') inventory = inventory.replace(':000000 ', ':100755 ');
    const observedCommands: string[][] = [];
    const runner: CommandRunner = { async run(command) {
      const args = command.args!.slice(14); observedCommands.push(args);
      let stdout = '';
      if (args[0] === 'rev-parse') stdout = args[2] === 'HEAD' ? 'c'.repeat(40) : 'b'.repeat(40);
      else if (args[0] === 'rev-list') stdout = `${'c'.repeat(40)} ${f.source.binding.parentSha}`;
      else if (args[0] === 'diff-tree') stdout = inventory;
      else if (args[0] === 'show') stdout = f.content;
      else throw new Error('Only exact original literal Git reads are allowed.');
      return { command, displayCommand: 'isolated literal read', status: 0, signal: null, stdout, stderr: '', timedOut: false };
    } };
    try {
      await withSource5WorkflowLease(f.source.projectRoot, async lease => {
        const journal = await openSource5WorkflowJournal({ ...f.source, lease, initialize: false });
        const stored = (await f.source.store.read('proof', journal.proofKey(f.source.operation)))!, bytes = await readFile(stored.path);
        const later = new Date(f.source.now.getTime() + 60_000);
        const execution = executeSource5WorkflowComponent(await fields(f.source, lease, runner, p.transport, false, later), journal);
        if (fault === 'unchanged') {
          expect(await execution).toMatchObject({ status: 'completed', proof: { observedAt: f.source.now.toISOString(), commitSha: 'c'.repeat(40) },
            currentObservedAt: later.toISOString() });
        } else await expect(execution).rejects.toMatchObject({ code: 'workflow-publication-inventory' });
        expect(await readFile(stored.path)).toEqual(bytes);
        expect(observedCommands.map(args => args[0])).toEqual(fault === 'unchanged'
          ? ['rev-parse', 'rev-list', 'diff-tree', 'show', 'rev-parse'] : ['rev-parse', 'rev-list', 'diff-tree']);
        expect(p.calls.filter(call => call.method !== 'GET')).toEqual([]);
      });
    } finally { await p.close(); }
  });

  it('does not adopt target-shaped HEAD after original writing intent without a durable commit handle', async () => {
    const f = await fixture(), p = await provider(f);
    try {
      const value = await seal(f.review({ phaseId: 'workflow-source-ready', effects: [
        { action: 'git.workflow-source.publish-reviewed', binding: f.source.binding }
      ] }));
      await withSource5WorkflowLease(value.projectRoot, async lease => {
        const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: true });
        const input = await fields(value, lease, noGit(), p.transport);
        await journal.record(value.operation, 'publication-writing', { bindingDigest: canonicalSha256(f.source.binding),
          planDigest: value.plan.planDigest, stage: 'writing' });
        await expect(executeSource5WorkflowComponent(input, journal)).rejects.toThrow(/durably recorded exact commit/);
        expect((await journal.events(value.operation)).map(event => event.stage)).toEqual(['publication-writing']);
        expect(p.calls).toEqual([]);
      });
    } finally { await p.close(); }
  });
});
