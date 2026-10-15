import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import {
  createWorkflowSource5ControlStore, nodeUpdatePreviewFileSystem, resolveUpdatePreviewLocation
} from '../src/adapters/filesystem/update-previews.js';
import type { GitHubActivationTransport, GitHubRequest } from '../src/adapters/github/activation-rest.js';
import type { CommandRunner } from '../src/process-runner.js';
import type { ProjectMutationLease } from '../src/adapters/filesystem/project-lock.js';
import {
  issueSource5WorkflowApproval, restoreSource5WorkflowAuthority, source5WorkflowAuthorityValue,
  source5WorkflowOriginalPlanValue, withSource5WorkflowLease
} from '../src/governance-activation/workflow-source5-authority.js';
import { openSource5WorkflowJournal } from '../src/governance-activation/workflow-source5-journal.js';
import { createSource5WorkflowEffectInput } from '../src/governance-activation/workflow-source5-ports.js';
import { workflowRuntime } from '../src/governance-activation/workflow-runtime.js';
import { executeWorkflowSourcePublication } from '../src/governance-activation/workflow-publication.js';
import { workflowByteDigest } from '../src/governance-activation/workflow-binding.js';
import { workflowSource5JournalFixture } from './fixtures/workflow-source5-journal.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
type Fault = 'unchanged' | 'approval-expired' | 'issuance-lost';
type Review = ReturnType<Awaited<ReturnType<typeof workflowSource5JournalFixture>>['review']>;
async function optionalBytes(file: string) {
  try { return await readFile(file); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}
async function fixture(fault: Fault) {
  const seed = await workflowSource5JournalFixture(); roots.push(seed.root);
  let now = seed.now;
  const hook = { path: '', issuancePath: '', armed: false, injected: false };
  async function inject(target: string) {
    if (!hook.armed || hook.injected || target !== hook.path || fault === 'unchanged') return;
    hook.injected = true;
    if (fault === 'approval-expired') now = new Date(seed.plan.expiresAt);
    else await unlink(hook.issuancePath);
  }
  const storage = { ...seed.storage, fileSystem: {
    ...nodeUpdatePreviewFileSystem,
    async replaceFile(source: string, target: string) {
      await nodeUpdatePreviewFileSystem.replaceFile(source, target);
      await inject(target);
    },
    async openFile(...args: Parameters<typeof nodeUpdatePreviewFileSystem.openFile>) {
      const handle = await nodeUpdatePreviewFileSystem.openFile(...args);
      return { ...handle, async readText(maximum: number) {
        const content = await handle.readText(maximum);
        await inject(args[0]);
        return content;
      } };
    }
  } };
  const location = await resolveUpdatePreviewLocation(seed.projectRoot, storage);
  const value = { ...seed, storage, store: createWorkflowSource5ControlStore(seed.projectRoot, storage) };
  const configured = (review: Review) => ({ ...review, storage,
    store: createWorkflowSource5ControlStore(review.projectRoot, storage) });
  const controlPath = (namespace: 'proof' | 'approval', key: string) =>
    path.join(location.directory, `workflow-source5-${namespace}-${location.projectKey}-${key}.json`);
  return { value, configured, hook, controlPath, clock: () => now,
    expire: () => { now = new Date(seed.plan.expiresAt); } };
}
async function seal(value: Review) {
  await value.store.save('plan', value.control.controlKey,
    source5WorkflowOriginalPlanValue(value.projectRoot, value.plan, value.approval), null);
}
async function carrier(value: Review, lease: ProjectMutationLease, runner: CommandRunner,
  transport: GitHubActivationTransport, clock: () => Date) {
  await seal(value);
  const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: true });
  await issueSource5WorkflowApproval({ ...value, lease }, value.now);
  const authority = await restoreSource5WorkflowAuthority({ ...value, lease }, value.now);
  const phase = value.context.records.graph.phases.find(phase => phase.id === value.control.phaseId)!;
  const input = await createSource5WorkflowEffectInput({ kind: 'source5-workflow-effect.v1',
    projectRoot: value.projectRoot, plan: value.plan, operation: value.operation,
    phase: { ...phase, id: value.control.phaseId }, authority, lease, now: value.now, clock, runner, transport,
    observationOnly: false, profile: value.plan.identity.profile, reviewedPlans: [value.plan] }, journal);
  return { input, journal, issuancePath: (await value.store.read('approval',
    canonicalSha256(source5WorkflowAuthorityValue({ ...value, lease }))))!.path };
}
function publicationServices(value: Review) {
  const commands: string[][] = [], requests: GitHubRequest[] = [], commitSha = 'c'.repeat(40), treeSha = 'b'.repeat(40);
  let head = value.binding.parentSha, pushed = false;
  const runner: CommandRunner = { async run(command, options) {
    expect(options?.cwd).toBe(value.projectRoot);
    const args = command.args!.slice(14);
    let stdout = '';
    if (args[0] === 'remote') stdout = 'https://github.com/owner/repo.git\n';
    else if (args[0] === 'symbolic-ref') stdout = value.binding.ref;
    else if (args[0] === 'rev-parse') stdout = args[2]!.endsWith('^{tree}') ? treeSha : head;
    else if (args[0] === 'rev-list') stdout = `${commitSha} ${value.binding.parentSha}`;
    else if (args.includes('commit')) { commands.push(args); head = commitSha; }
    else if (args.includes('add')) commands.push(args);
    else if (args[0] === 'diff-tree') stdout = `${value.binding.files.map(file => file.path).join('\0')}\0`;
    else if (args[0] === 'show') {
      const file = value.binding.files.find(file => args[1] === `${commitSha}:${file.path}`);
      if (!file) throw new Error('Unexpected isolated committed path.');
      stdout = await readFile(path.join(value.projectRoot, file.path), 'utf8');
    }
    else if (args[0] === 'push') { commands.push(args); pushed = true; stdout = 'isolated push acceptance'; }
    return { command, displayCommand: 'isolated literal Git fixture', status: 0, signal: null, stdout, stderr: '', timedOut: false };
  } };
  const transport: GitHubActivationTransport = { async request(request) {
    requests.push(request);
    let data: unknown;
    if (request.path === '/repos/owner/repo') data = { id: 123, full_name: 'owner/repo' };
    else if (request.path.includes('/git/ref/heads/')) data = {
      ref: `refs/heads/${value.binding.ref}`, object: { sha: pushed ? commitSha : value.binding.parentSha }
    };
    else if (request.path.includes('/git/commits/')) data = { sha: commitSha, tree: { sha: treeSha }, parents: [{ sha: value.binding.parentSha }] };
    else if (request.path.includes('/contents/')) {
      const file = value.binding.files.find(file =>
        request.path.split('?')[0] === `/repos/owner/repo/contents/${file.path}`);
      if (!file) throw new Error('Unexpected isolated publication path.');
      data = { type: 'file', path: file.path, encoding: 'base64', content: Buffer.from(file.content).toString('base64') };
    }
    else throw new Error('Unexpected isolated publication request.');
    return { status: 200, headers: {}, data };
  } };
  return { runner, transport, commands, requests };
}
async function refReview(f: Awaited<ReturnType<typeof fixture>>, lease: ProjectMutationLease) {
  const value = f.value; await seal(value);
  const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: true });
  const base = { bindingDigest: canonicalSha256(value.binding), planDigest: value.plan.planDigest }, commitSha = 'c'.repeat(40);
  await journal.record(value.operation, 'publication-writing', { ...base, stage: 'writing' });
  await journal.record(value.operation, 'publication-commit-intent', base);
  await journal.record(value.operation, 'publication-commit-observed', { ...base, commitSha });
  await journal.record(value.operation, 'publication-committed', { ...base, stage: 'committed', commitSha });
  await journal.record(value.operation, 'publication-published', { ...base, stage: 'published', commitSha });
  const observed = { repository: value.binding.repository, repositoryId: value.binding.repositoryId,
    ref: value.binding.ref, parentSha: value.binding.parentSha, commitSha, treeSha: 'b'.repeat(40),
    files: value.binding.files.map(({ path, digest }) => ({ path, digest })) };
  const proof = { kind: 'workflow-source-publication.v1', ...observed, bindingDigest: base.bindingDigest,
    observedAt: value.now.toISOString(), observationDigest: canonicalSha256(observed) };
  await journal.record(value.operation, 'component-completed', { ...base, proof });
  const binding = { repository: observed.repository, repositoryId: observed.repositoryId,
    sourceSha: commitSha, treeSha: observed.treeSha, executionRef: `liftoff-execution-${commitSha}` };
  const review = f.configured(value.review({ origin: { planKey: value.control.controlKey, proofKey: journal.proofKey(value.operation),
    publicationDigest: canonicalSha256(proof), commitSha, treeSha: observed.treeSha },
  effects: [{ action: 'github.workflow-source.bind-execution-ref', binding }] }));
  return { review, binding };
}

describe('source5 freshness at actual source and owned IO boundaries', () => {
  it.each(['unchanged', 'expires-after-first-file'] as const)(
    'guards both actual file mutations of one original publication after %s', async fault => {
      const f = await fixture('unchanged'), first = f.value.binding.files[0]!;
      const content = first.content.replace('Isolated source fixture', 'Isolated second source fixture');
      const binding = { ...f.value.binding, files: [first, {
        path: '.github/workflows/second-source-fixture.yml', beforeDigest: null,
        digest: workflowByteDigest(content), content
      }] };
      const value = { ...f.configured(f.value.review({
        effects: [{ action: 'git.workflow-source.publish-reviewed', binding }]
      })), binding }, service = publicationServices(value);
      const targets = binding.files.map(file => path.join(value.projectRoot, file.path));
      let now = value.now, sawActualFirstWrite = false;
      const clock = () => {
        if (fault === 'expires-after-first-file' && existsSync(targets[0]!)) {
          sawActualFirstWrite = true;
          now = new Date(value.plan.expiresAt);
        }
        return now;
      };
      await withSource5WorkflowLease(value.projectRoot, async lease => {
        const { input, journal } = await carrier(value, lease, service.runner, service.transport, clock);
        const execution = executeWorkflowSourcePublication(input, binding);
        if (fault === 'unchanged') {
          await execution;
          expect(await Promise.all(targets.map(target => readFile(target, 'utf8')))).toEqual(binding.files.map(file => file.content));
          expect(service.commands).toHaveLength(3);
        } else {
          await expect(execution).rejects.toThrow(/unexpired approval/);
          expect(sawActualFirstWrite).toBe(true);
          expect(clock().getTime()).toBe(Date.parse(value.plan.expiresAt));
          expect(targets.map(target => existsSync(target))).toEqual([false, false]);
          expect(service.commands).toEqual([]);
          expect((await journal.events(value.operation)).map(event => event.stage)).toEqual(['publication-writing']);
        }
        expect(service.requests.filter(request => request.method !== 'GET')).toEqual([]);
      });
    });

  it.each(['unchanged', 'approval-expired', 'issuance-lost'] as const)(
    'runs the actual publication producer without changing source after post-writing %s', async fault => {
      const f = await fixture(fault), value = f.value, service = publicationServices(value);
      await withSource5WorkflowLease(value.projectRoot, async lease => {
        const { input, journal, issuancePath } = await carrier(value, lease, service.runner, service.transport, f.clock);
        const operationKey = canonicalSha256({ controlKey: value.control.controlKey, operationDigest: canonicalSha256(value.operation) });
        f.hook.path = f.controlPath('proof', canonicalSha256({ kind: 'workflow-source5-stage-key.v1',
          operationKey, stage: 'publication-writing' }));
        f.hook.issuancePath = issuancePath; f.hook.armed = true;
        const target = path.join(value.projectRoot, value.binding.files[0]!.path);
        expect(await optionalBytes(target)).toBeNull();
        const original = (await value.store.read('plan', value.control.controlKey))!, originalBytes = await readFile(original.path);
        const execution = executeWorkflowSourcePublication(input, value.binding);
        if (fault === 'unchanged') {
          expect(await execution).toMatchObject({ commitSha: 'c'.repeat(40), treeSha: 'b'.repeat(40) });
          expect(await optionalBytes(target)).toEqual(Buffer.from(value.binding.files[0]!.content));
          expect(service.commands).toHaveLength(3);
        } else {
          await expect(execution).rejects.toThrow(fault === 'approval-expired' ? /unexpired approval/ : /issuance changed or disappeared/);
          expect(f.hook.injected).toBe(true);
          expect(await optionalBytes(target)).toBeNull();
          expect(service.commands).toEqual([]);
          expect((await journal.events(value.operation)).map(event => event.stage)).toEqual(['publication-writing']);
          expect(await optionalBytes(f.hook.path)).not.toBeNull();
          expect(await optionalBytes(issuancePath) === null).toBe(fault === 'issuance-lost');
        }
        expect(service.requests.filter(request => request.method !== 'GET')).toEqual([]);
        expect(await readFile(original.path)).toEqual(originalBytes);
      });
    });

  it.each([
    ['git', 'unchanged', 'inventory'], ['git', 'approval-expired', 'inventory'], ['git', 'issuance-lost', 'inventory'],
    ['provider', 'unchanged', 'inventory'], ['provider', 'approval-expired', 'inventory'], ['provider', 'issuance-lost', 'inventory'],
    ['git', 'approval-expired', 'authority-read'], ['provider', 'approval-expired', 'authority-read']
  ] as const)('rechecks %s submission after %s at asynchronous %s', async (kind, fault, boundary) => {
    const f = await fixture(fault), commands: string[][] = [], requests: GitHubRequest[] = [];
    const runner: CommandRunner = { async run(command) {
      commands.push(command.args!);
      return { command, displayCommand: 'isolated effect fixture', status: 0, signal: null, stdout: '', stderr: '', timedOut: false };
    } };
    const transport: GitHubActivationTransport = { async request(request) {
      requests.push(request);
      const body = request.body;
      if (!isRecord(body) || typeof body.ref !== 'string' || typeof body.sha !== 'string') {
        throw new Error('Expected the exact isolated tag request.');
      }
      return { status: 201, headers: {}, data: { ref: body.ref, object: { sha: body.sha },
        url: `https://api.github.com/repos/owner/repo/git/refs/${body.ref.slice(5)}` } };
    } };
    await withSource5WorkflowLease(f.value.projectRoot, async lease => {
      const selected = kind === 'provider' ? await refReview(f, lease) : null;
      const value = selected?.review ?? f.value;
      const { input, journal, issuancePath } = await carrier(value, lease, runner, transport, f.clock);
      const base = { bindingDigest: canonicalSha256(value.operation.inputs), planDigest: value.plan.planDigest };
      if (kind === 'git') await input.recordWorkflowPublication({ ...base, stage: 'writing' });
      else await input.recordExecutionRefIntent(base);
      f.hook.path = boundary === 'authority-read' ? issuancePath : f.controlPath('proof',
        canonicalSha256({ kind: 'workflow-source5-storage-inventory-key.v1', controlKey: value.control.controlKey }));
      f.hook.issuancePath = issuancePath; f.hook.armed = true;
      const runtime = workflowRuntime(input);
      const execution = kind === 'git' ? runtime.git(['--literal-pathspecs', 'add', '--', value.binding.files[0]!.path]) :
        runtime.client.transport.request({ method: 'POST', path: '/repos/owner/repo/git/refs',
          body: { ref: `refs/tags/${selected!.binding.executionRef}`, sha: selected!.binding.sourceSha } });
      if (fault === 'unchanged') {
        await execution;
        expect(commands).toHaveLength(kind === 'git' ? 1 : 0);
        expect(requests).toHaveLength(kind === 'provider' ? 1 : 0);
      } else {
        await expect(execution).rejects.toThrow();
        expect(f.hook.injected).toBe(true); expect(commands).toEqual([]); expect(requests).toEqual([]);
        expect((await journal.events(value.operation)).map(event => event.stage))
          .toEqual([kind === 'git' ? 'publication-writing' : 'execution-ref-intent']);
      }
    });
  });

  it.each(['approval-expired', 'issuance-lost'] as const)('still retains already accepted provider truth after %s', async fault => {
    const f = await fixture('unchanged');
    await withSource5WorkflowLease(f.value.projectRoot, async lease => {
      const selected = await refReview(f, lease), service = publicationServices(selected.review);
      let issuance = '', writes = 0;
      const transport: GitHubActivationTransport = { async request() {
        writes++;
        if (fault === 'approval-expired') f.expire(); else await unlink(issuance);
        return { status: 201, headers: {}, data: { ref: `refs/tags/${selected.binding.executionRef}`,
          object: { sha: selected.binding.sourceSha },
          url: `https://api.github.com/repos/owner/repo/git/refs/tags/${selected.binding.executionRef}` } };
      } };
      const { input, journal, issuancePath } = await carrier(selected.review, lease, service.runner, transport, f.clock);
      issuance = issuancePath;
      await input.recordExecutionRefIntent({ bindingDigest: canonicalSha256(selected.binding), planDigest: selected.review.plan.planDigest });
      await workflowRuntime(input).client.transport.request({ method: 'POST', path: '/repos/owner/repo/git/refs',
        body: { ref: `refs/tags/${selected.binding.executionRef}`, sha: selected.binding.sourceSha } });
      expect(writes).toBe(1);
      expect((await journal.events(selected.review.operation)).at(-1)).toMatchObject({ stage: 'execution-ref-accepted',
        data: { sha: selected.binding.sourceSha, planDigest: selected.review.plan.planDigest } });
    });
  });
});
