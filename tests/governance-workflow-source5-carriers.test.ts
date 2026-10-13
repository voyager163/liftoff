import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import type { GitHubActivationTransport, GitHubRequest } from '../src/adapters/github/activation-rest.js';
import { NodeCommandRunner, type CommandRunner } from '../src/process-runner.js';
import type { ProjectMutationLease } from '../src/adapters/filesystem/project-lock.js';
import {
  issueSource5WorkflowApproval, restoreSource5WorkflowAuthority, source5WorkflowOriginalPlanValue,
  withSource5WorkflowLease
} from '../src/governance-activation/workflow-source5-authority.js';
import { openSource5WorkflowJournal } from '../src/governance-activation/workflow-source5-journal.js';
import {
  assertSource5WorkflowIntent, createSource5WorkflowEffectInput, recordSource5WorkflowStage
} from '../src/governance-activation/workflow-source5-ports.js';
import { workflowObservationRuntime, workflowRuntime } from '../src/governance-activation/workflow-runtime.js';
import { executeWorkflowSourcePublication } from '../src/governance-activation/workflow-publication.js';
import { workflowSource5JournalFixture } from './fixtures/workflow-source5-journal.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
type Review = ReturnType<Awaited<ReturnType<typeof workflowSource5JournalFixture>>['review']>;
async function fixture(options?: Parameters<typeof workflowSource5JournalFixture>[0]) {
  const value = await workflowSource5JournalFixture(options); roots.push(value.root);
  return value;
}
async function journal(value: Review, lease: ProjectMutationLease, initialize = true) {
  if (initialize) await value.store.save('plan', value.control.controlKey,
    source5WorkflowOriginalPlanValue(value.projectRoot, value.plan, value.approval), null);
  return openSource5WorkflowJournal({ ...value, lease, initialize });
}
async function fields(value: Review, lease: ProjectMutationLease,
  runner: CommandRunner, transport: GitHubActivationTransport, observationOnly = false, initialIssuance = true) {
  if (initialIssuance) await issueSource5WorkflowApproval({ ...value, lease }, value.now);
  const authority = await restoreSource5WorkflowAuthority({ ...value, lease }, value.now);
  const phase = value.context.records.graph.phases.find(phase => phase.id === value.control.phaseId)!;
  return { kind: 'source5-workflow-effect.v1' as const, projectRoot: value.projectRoot,
    plan: value.plan, operation: value.operation, phase: { ...phase, id: value.control.phaseId }, authority, lease,
    now: value.now, runner, transport, observationOnly, profile: 'single-maintainer-gitflow' as const,
    reviewedPlans: [value.plan] };
}
async function publication(value: Awaited<ReturnType<typeof fixture>>, lease: ProjectMutationLease) {
  const original = await journal(value, lease);
  const base = { bindingDigest: canonicalSha256(value.binding), planDigest: value.plan.planDigest };
  const commitSha = 'c'.repeat(40), treeSha = 'b'.repeat(40);
  await original.record(value.operation, 'publication-writing', { ...base, stage: 'writing' });
  await original.record(value.operation, 'publication-commit-intent', base);
  await original.record(value.operation, 'publication-commit-observed', { ...base, commitSha });
  await original.record(value.operation, 'publication-committed', { ...base, stage: 'committed', commitSha });
  await original.record(value.operation, 'publication-published', { ...base, stage: 'published', commitSha });
  const observed = { repository: value.binding.repository, repositoryId: value.binding.repositoryId, ref: value.binding.ref,
    parentSha: value.binding.parentSha, commitSha, treeSha,
    files: value.binding.files.map(({ path, digest }) => ({ path, digest })) };
  const proof = { kind: 'workflow-source-publication.v1', ...observed, bindingDigest: base.bindingDigest,
    observedAt: value.now.toISOString(), observationDigest: canonicalSha256(observed) };
  await original.record(value.operation, 'component-completed', { ...base, proof });
  return { origin: { planKey: value.control.controlKey, proofKey: original.proofKey(value.operation),
    publicationDigest: canonicalSha256(proof), commitSha, treeSha },
  binding: { repository: value.binding.repository, repositoryId: value.binding.repositoryId,
    sourceSha: commitSha, treeSha, executionRef: `liftoff-execution-${commitSha}` } };
}
function services() {
  const commands: { args: readonly string[]; options: unknown }[] = [], requests: GitHubRequest[] = [];
  const runner: CommandRunner = { async run(command, options) {
    commands.push({ args: command.args ?? [], options });
    return { command, displayCommand: 'isolated command', status: 0, signal: null,
      stdout: 'isolated process acceptance', stderr: '', timedOut: false };
  } };
  const transport: GitHubActivationTransport = { async request(request) {
    requests.push(request); return { status: 200, headers: {}, data: {} };
  } };
  return { runner, transport, commands, requests };
}

describe('engine-owned source5 carriers and exact intent effects', () => {
  it('rejects caller callbacks/structural copies and duplicate original carriers before any effect', async () => {
    const value = await fixture(), service = services();
    let released: Awaited<ReturnType<typeof createSource5WorkflowEffectInput>> | undefined;
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const log = await journal(value, lease), input = await fields(value, lease, service.runner, service.transport);
      await expect(createSource5WorkflowEffectInput({ ...input,
        // @ts-expect-error caller-owned checkpoint callbacks never mint a capability
        recordWorkflowPublication: async () => undefined
      }, log)).rejects.toThrow(/caller checkpoint/);
      const carrier = await createSource5WorkflowEffectInput(input, log);
      released = carrier;
      expect(() => workflowRuntime({ ...carrier })).toThrow(/Structural runtime/);
      await expect(createSource5WorkflowEffectInput(input, log)).rejects.toThrow(/duplicate effect carrier/);
      await expect(assertSource5WorkflowIntent(carrier, 'source-write')).rejects.toThrow(/intent/);
      expect(service.commands).toHaveLength(0); expect(service.requests).toHaveLength(0);
    });
    await expect(workflowRuntime(released!).client.get('/repos/owner/repo')).rejects.toThrow();
    await expect(workflowRuntime(released!).git(['rev-parse', '--verify', 'HEAD'])).rejects.toThrow();
    expect(service.commands).toHaveLength(0); expect(service.requests).toHaveLength(0);
  });

  it('requires original intent and executes each exact source/Git effect at most once across runtimes', async () => {
    const value = await fixture(), service = services();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const log = await journal(value, lease);
      const carrier = await createSource5WorkflowEffectInput(await fields(value, lease, service.runner, service.transport), log);
      await carrier.recordWorkflowPublication({ bindingDigest: canonicalSha256(value.binding),
        planDigest: value.plan.planDigest, stage: 'writing' });
      await assertSource5WorkflowIntent(carrier, 'source-write');
      await expect(assertSource5WorkflowIntent(carrier, 'source-write')).rejects.toThrow(/already attempted/);
      const command = ['--literal-pathspecs', 'add', '--', value.binding.files[0]!.path];
      const submitted = workflowRuntime(carrier).git(command);
      command.push('foreign-file');
      await submitted;
      command.pop();
      await expect(workflowRuntime(carrier).git(command)).rejects.toThrow(/literal reviewed Git|literal Git/);
      await expect(workflowRuntime(carrier).git(['push', '--force', 'origin', 'HEAD'])).rejects.toThrow();
      expect(service.commands).toHaveLength(1);
      expect(service.commands[0]!.options).toMatchObject({
        cwd: value.projectRoot, maxOutputBytes: 1024 * 1024, stream: false,
        env: { GIT_TERMINAL_PROMPT: '0', GIT_TRACE: '', GIT_TRACE_CURL: '' }
      });
      expect(service.requests).toHaveLength(0);
      await expect(createSource5WorkflowEffectInput(await fields(value, lease, service.runner, service.transport, false, false), log)).rejects.toThrow(/attempted/);
    });
  });

  it('keeps observation-only intent and provider/Git writes closed while permitting bounded literal reads', async () => {
    const value = await fixture(), service = services();
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const log = await journal(value, lease);
      const carrier = await createSource5WorkflowEffectInput(await fields(value, lease, service.runner, service.transport, true), log);
      await expect(carrier.recordWorkflowPublication({ bindingDigest: canonicalSha256(value.binding),
        planDigest: value.plan.planDigest, stage: 'writing' })).rejects.toThrow(/cannot introduce/);
      const runtime = workflowRuntime(carrier);
      await expect(runtime.client.transport.request({ method: 'POST', path: '/repos/owner/repo/git/refs', body: {} })).rejects.toThrow();
      await expect(runtime.git(['--literal-pathspecs', 'add', '--', value.binding.files[0]!.path])).rejects.toThrow();
      await runtime.git(['rev-parse', '--verify', 'HEAD']);
      expect(service.requests).toHaveLength(0); expect(service.commands).toHaveLength(1);
      expect(await log.events(value.operation)).toEqual([]);
      const observer = workflowObservationRuntime({ ...service, projectRoot: value.projectRoot });
      await expect(observer.client.transport.request({ method: 'PATCH', path: '/repos/owner/repo' })).rejects.toThrow(/cannot write/);
      await expect(observer.git(['config', 'user.name', 'forbidden'])).rejects.toThrow(/literal Git reads/);
      expect(service.commands).toHaveLength(1);
    });
  });

  it('retains actual HTTP201 tag acceptance before fallible readback and never repeats it after restart', async () => {
    const value = await fixture(), service = services();
    let posts = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      expect(request.method).toBe('POST'); posts++;
      expect(request.url).toBe('/repos/owner/repo/git/refs');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ref: body.ref, url: `https://api.github.com/repos/owner/repo/git/refs/${body.ref.slice(5)}`,
        object: { type: 'commit', sha: body.sha } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected isolated TCP fixture.');
    const transport: GitHubActivationTransport = { async request(request) {
      if (request.method === 'GET') throw new Error('isolated fallible readback; no repeat allowed');
      const result = await fetch(`http://127.0.0.1:${address.port}${request.path}`, {
        method: request.method, body: JSON.stringify(request.body), headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(30_000)
      });
      return { status: result.status, headers: {}, data: await result.json() };
    } };
    try {
      let reviewed: Review | undefined;
      await withSource5WorkflowLease(value.projectRoot, async lease => {
        const source = await publication(value, lease);
        reviewed = value.review({ origin: source.origin,
          effects: [{ action: 'github.workflow-source.bind-execution-ref', binding: source.binding }] });
        const log = await journal(reviewed, lease);
        const carrier = await createSource5WorkflowEffectInput(await fields(reviewed, lease, service.runner, transport), log);
        const request: GitHubRequest = { method: 'POST', path: '/repos/owner/repo/git/refs',
          body: { ref: `refs/tags/${source.binding.executionRef}`, sha: source.binding.sourceSha } };
        await carrier.recordExecutionRefIntent({ bindingDigest: canonicalSha256(source.binding), planDigest: reviewed.plan.planDigest });
        const first = workflowRuntime(carrier).client.transport.request(request);
        const second = workflowRuntime(carrier).client.transport.request({ ...request });
        request.path = '/repos/foreign/repo/git/refs'; request.body = { sha: 'f'.repeat(40) };
        const competing = await Promise.allSettled([first, second]);
        expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(competing.filter(result => result.status === 'rejected')).toHaveLength(1);
        expect((await log.events(reviewed.operation)).map(event => event.stage)).toEqual(['execution-ref-intent', 'execution-ref-accepted']);
        await expect(workflowRuntime(carrier).client.get(`/repos/owner/repo/git/ref/tags/${source.binding.executionRef}`)).rejects.toThrow();
        await expect(workflowRuntime(carrier).client.transport.request(request)).rejects.toThrow();
      });
      await withSource5WorkflowLease(value.projectRoot, async lease => {
        const log = await journal(reviewed!, lease, false);
        const carrier = await createSource5WorkflowEffectInput(await fields(reviewed!, lease, service.runner, transport, true, false), log);
        expect(carrier.executionRefIntent).toEqual({
          bindingDigest: canonicalSha256(reviewed!.operation.inputs), planDigest: reviewed!.plan.planDigest
        });
        await expect(workflowRuntime(carrier).client.transport.request({ method: 'POST', path: '/repos/owner/repo/git/refs' })).rejects.toThrow();
        expect((await log.events(reviewed!.operation)).at(-1)!.stage).toBe('execution-ref-accepted');
      });
      expect(posts).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each(['runner', 'dispatch'] as const)('retains exact original %s acceptance before a later read failure', async kind => {
    const seed = await fixture(), service = services();
    const value = kind === 'dispatch' ? { ...seed, ...seed.review({ phaseId: 'workflow-source-ready' }) } : seed;
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const source = await publication(value, lease);
      const binding = kind === 'runner' ? {
        repository: 'owner/repo', repositoryId: 123, groupId: 7, groupName: 'isolated-private',
        networkConfigurationId: 'isolated-network', beforeWorkflows: [],
        afterWorkflows: [`owner/repo/${value.binding.files[0]!.path}@refs/tags/${source.binding.executionRef}`]
      } : { ...source.binding, family: 'develop', ref: 'develop', workflowPath: value.binding.files[0]!.path,
        workflowDigest: value.binding.files[0]!.digest, contexts: [{ name: 'isolated-context', validationStep: 'Validate source' }],
        mode: 'green', tokenSuppressedTrigger: true };
      const reviewed = value.review({ origin: source.origin, phaseId: kind === 'runner' ? 'bootstrap-workflow-source-ready' : 'dev-proof',
        effects: [{ action: kind === 'runner' ? 'github.workflow-source.admit-reviewed' : 'github.checks.dev-proof', binding }] });
      let writes = 0;
      const transport: GitHubActivationTransport = { async request(request) {
        if (request.method === 'GET') throw new Error('isolated read failure after acceptance');
        writes++;
        return { status: 200, headers: {}, data: kind === 'runner' ? {
          id: 7, name: 'isolated-private', selected_workflows: 'afterWorkflows' in binding ? binding.afterWorkflows : []
        } : { workflow_run_id: 901, run_url: 'https://api.github.com/repos/owner/repo/actions/runs/901',
          html_url: 'https://github.com/owner/repo/actions/runs/901' } };
      } };
      const log = await journal(reviewed, lease);
      const carrier = await createSource5WorkflowEffectInput(await fields(reviewed, lease, service.runner, transport), log);
      const base = { bindingDigest: canonicalSha256(binding), planDigest: reviewed.plan.planDigest };
      if (kind === 'runner') await carrier.recordRunnerAdmissionIntent(base);
      else await carrier.recordWorkflowDispatch({ ...base, workflowId: 90, dispatchedAt: value.now.toISOString(), stage: 'dispatch-intent' });
      const request: GitHubRequest = kind === 'runner' ? {
        method: 'PATCH', path: '/orgs/owner/actions/runner-groups/7',
        body: { name: 'isolated-private', restricted_to_workflows: true,
          selected_workflows: 'afterWorkflows' in binding ? binding.afterWorkflows : [] }
      } : { method: 'POST', path: '/repos/owner/repo/actions/workflows/90/dispatches',
        body: { ref: source.binding.executionRef, inputs: { source_sha: source.binding.sourceSha,
          protected_ref: 'refs/heads/develop', proof_id: base.bindingDigest } } };
      await workflowRuntime(carrier).client.transport.request(request);
      await expect(workflowRuntime(carrier).client.get('/repos/owner/repo')).rejects.toThrow();
      await expect(workflowRuntime(carrier).client.transport.request(request)).rejects.toThrow();
      expect(writes).toBe(1);
      const accepted = (await log.events(reviewed.operation)).at(-1)!;
      expect(accepted.stage).toBe(`${kind}-accepted`);
      if (kind === 'dispatch') expect(accepted.data).toMatchObject({
        planDigest: reviewed.plan.planDigest, workflowId: 90, runId: 901, dispatchedAt: value.now.toISOString(),
        runUrl: 'https://api.github.com/repos/owner/repo/actions/runs/901'
      });

    });
  });

  it.each(['complete', 'parent-read-fails', 'remote-read-fails'] as const)(
    'links publication intents to exact file/Git effects and retains earliest commit/push truth: %s', async fault => {
      const value = await fixture(), commitSha = 'c'.repeat(40), treeSha = 'b'.repeat(40);
      let head = value.binding.parentSha, pushed = false, commits = 0, pushes = 0;
      const runner: CommandRunner = { async run(command, options) {
        expect(command.executable).toBe('git'); expect(options?.cwd).toBe(value.projectRoot);
        const args = command.args!.slice(14);
        let stdout = '';
        if (args[0] === 'remote') stdout = 'https://github.com/owner/repo.git\n';
        else if (args[0] === 'symbolic-ref') stdout = value.binding.ref;
        else if (args[0] === 'rev-parse') stdout = args[2]!.endsWith('^{tree}') ? treeSha : head;
        else if (args[0] === 'rev-list') {
          if (fault === 'parent-read-fails') throw new Error('isolated post-commit parent read failure');
          stdout = `${commitSha} ${value.binding.parentSha}`;
        } else if (args.includes('commit')) { commits++; head = commitSha; }
        else if (args[0] === 'diff-tree') stdout = `${value.binding.files[0]!.path}\0`;
        else if (args[0] === 'show') stdout = (await readFile(path.join(value.projectRoot, value.binding.files[0]!.path))).toString();
        else if (args[0] === 'push') { pushes++; pushed = true; stdout = 'isolated push acceptance'; }
        return { command, displayCommand: 'isolated command', status: 0, signal: null, stdout, stderr: '', timedOut: false };
      } };
      const transport: GitHubActivationTransport = { async request(request) {
        if (request.path === '/repos/owner/repo') return { status: 200, headers: {}, data: { id: 123, full_name: 'owner/repo' } };
        if (fault === 'remote-read-fails' && pushed) throw new Error('isolated post-push provider read failure');
        if (request.path.includes('/git/ref/heads/')) return { status: 200, headers: {}, data: {
          ref: `refs/heads/${value.binding.ref}`, object: { sha: pushed ? commitSha : value.binding.parentSha }
        } };
        if (request.path.includes('/git/commits/')) return { status: 200, headers: {}, data: {
          sha: commitSha, tree: { sha: treeSha }, parents: [{ sha: value.binding.parentSha }]
        } };
        if (request.path.includes('/contents/')) return { status: 200, headers: {}, data: {
          type: 'file', path: value.binding.files[0]!.path, encoding: 'base64',
          content: Buffer.from(value.binding.files[0]!.content).toString('base64')
        } };
        throw new Error('Unexpected isolated publication request');
      } };
      await withSource5WorkflowLease(value.projectRoot, async lease => {
        const log = await journal(value, lease);
        const carrier = await createSource5WorkflowEffectInput(await fields(value, lease, runner, transport), log);
        const execution = executeWorkflowSourcePublication(carrier, value.binding);
        if (fault === 'complete') {
          const proof = await execution;
          expect(proof.commitSha).toBe(commitSha); expect(proof.treeSha).toBe(treeSha);
          await recordSource5WorkflowStage(carrier, 'component-completed', { proof });
        } else await expect(execution).rejects.toThrow();
        const stages = (await log.events(value.operation)).map(event => event.stage);
        expect(stages.slice(0, 3)).toEqual(['publication-writing', 'publication-commit-intent', 'publication-commit-observed']);
        expect(stages).toContain(fault === 'parent-read-fails' ? 'publication-commit-observed' : 'publication-push-accepted');
        expect(commits).toBe(1); expect(pushes).toBe(fault === 'parent-read-fails' ? 0 : 1);
        await expect(createSource5WorkflowEffectInput(await fields(value, lease, runner, transport, false, false), log)).rejects.toThrow(/attempted/);
        expect(commits).toBe(1); expect(pushes).toBe(fault === 'parent-read-fails' ? 0 : 1);
      });

    });

  it('runs the once-only guarded literal Git effect in an isolated real process', async () => {
    const service = services(), actual = new NodeCommandRunner();
    let env: NodeJS.ProcessEnv = {};
    const value = await fixture({ async initializeProject(projectRoot, fixtureRoot) {
      env = { GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: path.join(fixtureRoot, 'isolated-global.gitconfig'),
        GIT_CONFIG_SYSTEM: path.join(fixtureRoot, 'isolated-system.gitconfig') };
      const initialized = await actual.run({ executable: 'git', args: ['init', '--quiet', '--initial-branch=fixture'] },
        { cwd: projectRoot, env, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024, stream: false });
      expect(initialized.status).toBe(0);
    } });
    let effects = 0;
    const runner: CommandRunner = { async run(command, options) {
      effects++;
      return actual.run(command, { ...options, env: { ...options?.env, ...env } });
    } };
    await withSource5WorkflowLease(value.projectRoot, async lease => {
      const log = await journal(value, lease);
      const carrier = await createSource5WorkflowEffectInput(await fields(value, lease, runner, service.transport), log);
      await carrier.recordWorkflowPublication({ bindingDigest: canonicalSha256(value.binding),
        planDigest: value.plan.planDigest, stage: 'writing' });
      await assertSource5WorkflowIntent(carrier, 'source-write');
      await mkdir(path.join(value.projectRoot, '.github', 'workflows'), { recursive: true });
      await writeFile(path.join(value.projectRoot, value.binding.files[0]!.path), value.binding.files[0]!.content);
      const args = ['--literal-pathspecs', 'add', '--', value.binding.files[0]!.path];
      await workflowRuntime(carrier).git(args);
      await expect(workflowRuntime(carrier).git(args)).rejects.toThrow();
      expect(effects).toBe(1);
      const staged = await actual.run({ executable: 'git', args: ['diff', '--cached', '--name-only'] },
        { cwd: value.projectRoot, env, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024, stream: false });
      expect(staged.status).toBe(0); expect(staged.stdout.trim()).toBe(value.binding.files[0]!.path);
    });
  });
});
