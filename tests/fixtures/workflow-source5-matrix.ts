import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import { environmentValue } from '../../src/domain/workstation/executables.js';
import type { GitHubActivationTransport, GitHubRequest } from '../../src/adapters/github/activation-rest.js';
import { NodeCommandRunner } from '../../src/process-runner.js';
import type { CommandResult, CommandRunner } from '../../src/process-runner.js';
import type { ProjectMutationLease } from '../../src/adapters/filesystem/project-lock.js';
import {
  issueSource5WorkflowApproval, restoreSource5WorkflowAuthority, source5WorkflowOriginalPlanValue, withSource5WorkflowLease
} from '../../src/governance-activation/workflow-source5-authority.js';
import { openSource5WorkflowJournal } from '../../src/governance-activation/workflow-source5-journal.js';
import { createSource5WorkflowEffectInput } from '../../src/governance-activation/workflow-source5-ports.js';
import type { WorkflowContextBinding, WorkflowContextProof } from '../../src/governance-activation/workflow-context-proof.js';
import { observeImmutableWorkflowExecutionRef } from '../../src/governance-activation/workflow-execution-ref.js';
import { workflowObservationRuntime } from '../../src/governance-activation/workflow-runtime.js';
import { protectedWorkflowFamilies, requiredWorkflowContextsFromSource } from '../../src/governance-activation/workflow-requirements.js';
import { workflowByteDigest } from '../../src/governance-activation/workflow-binding.js';
import { source5WorkflowPlanInventory } from '../../src/governance-activation/workflow-source5-operations.js';
import { workflowSource5JournalFixture } from './workflow-source5-journal.js';

const contexts = [
  { jobId: 'validate', name: 'Required validation', validationStep: 'Validate source' },
  { jobId: 'package', name: 'Required packaging', validationStep: 'Validate package' }
] as const;
const valid = ['export const valid = true;\n', '{"name":"isolated"}\n'];
const invalid = ['export const valid = ;\n', '{broken}\n'];
const paths = ['backend/application.js', 'backend/package.json'];
const noGit: CommandRunner = { async run() { throw new Error('Matrix observation must not submit a process or Git effect.'); } };
type MatrixValidatorSelector = Pick<WorkflowContextBinding, 'family' | 'mode'> & { jobId: typeof contexts[number]['jobId'] };

export function matrixValidatorEnvironment(home: string, platform: NodeJS.Platform = process.platform,
  ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { HOME: home, NODE_OPTIONS: '' };
  if (platform !== 'win32') return environment;
  const systemRoot = environmentValue(ambient, 'SystemRoot', 'win32');
  if (!systemRoot) throw new Error('The owned Windows validator requires the actual host SystemRoot.');
  return { ...environment, SystemRoot: systemRoot };
}

export function matrixValidatorFailure(reason: 'settlement' | 'input-readback' | 'expectation',
  selector: MatrixValidatorSelector, result: CommandResult): Error {
  const message = reason === 'settlement' ? 'An isolated bounded validator did not settle.' :
    reason === 'input-readback' ? 'An original file-backed validator input changed during execution.' :
      `The isolated actual validator did not detect only its own reviewed violation: ${selector.family}/${selector.mode}/${selector.jobId}, status ${result.status}.`;
  return new Error(`${message}\nOwned matrix fixture diagnostic: ${JSON.stringify({
    fixture: { family: selector.family, mode: selector.mode, jobId: selector.jobId },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    result: { stdout: result.stdout, stderr: result.stderr, status: result.status, signal: result.signal,
      processSpawned: result.processSpawned ?? null, processTreeSettled: result.processTreeSettled ?? null,
      errorCode: result.errorCode ?? null, errorMessage: result.errorMessage ?? null,
      timedOut: result.timedOut, aborted: result.aborted ?? null, outputLimitExceeded: result.outputLimitExceeded ?? null }
  })}`);
}

export function matrixValidatorConclusion(selector: MatrixValidatorSelector, result: CommandResult,
  expectedRed: boolean): 'success' | 'failure' {
  const conclusion = result.status === 0 ? 'success' : 'failure';
  if (conclusion !== (expectedRed ? 'failure' : 'success') ||
      expectedRed && (result.status !== 1 || !/\bSyntaxError:/u.test(result.stderr))) {
    throw matrixValidatorFailure('expectation', selector, result);
  }
  return conclusion;
}

/** Original fixture provenance and loopback/process observations, not live workflow qualification. */
export async function workflowSource5MatrixFixture(options: {
  wrongRedIntegration?: boolean; omitLastRed?: boolean;
} = {}) {
  const seed = await workflowSource5JournalFixture();
  try { return await prepareMatrixFixture(seed, options); }
  catch (error) { await rm(seed.root, { recursive: true, force: true }); throw error; }
}

async function prepareMatrixFixture(seed: Awaited<ReturnType<typeof workflowSource5JournalFixture>>,
  options: NonNullable<Parameters<typeof workflowSource5MatrixFixture>[0]>) {
  const content = stringify({
    name: 'Isolated two-context proof', 'run-name': 'Liftoff context proof ${{ inputs.proof_id }}',
    on: { workflow_dispatch: { inputs: Object.fromEntries(['proof_id', 'protected_ref', 'source_sha']
      .map(key => [key, { type: 'string', required: true }])) } },
    permissions: { contents: 'read' },
    concurrency: { group: 'liftoff-context-proof-${{ inputs.proof_id }}', 'cancel-in-progress': false },
    jobs: Object.fromEntries(contexts.map((context, index) => [context.jobId, {
      name: context.name, if: '${{ github.sha == inputs.source_sha && github.run_attempt == 1 }}',
      'runs-on': 'ubuntu-latest', 'timeout-minutes': 5, steps: [
        { name: 'Checkout reviewed source', uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
          with: { ref: '${{ inputs.source_sha }}', clean: true, 'persist-credentials': false } },
        { name: context.validationStep, run: index === 0 ? 'node --check backend/application.js' :
          `node -e "JSON.parse(require('node:fs').readFileSync('backend/package.json', 'utf8'))"` }
      ]
    }]))
  });
  const ruleset = { target: 'branch', bypass_actors: [],
    conditions: { ref_name: { include: ['refs/heads/develop', 'refs/heads/main', 'refs/heads/release/**', 'refs/heads/hotfix/**'], exclude: [] } },
    rules: [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
      required_status_checks: contexts.map(context => ({ context: context.name, integration_id: 15368 })) } },
    { type: 'pull_request', parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: true } }] };
  const tagRules = { target: 'tag', bypass_actors: [],
    conditions: { ref_name: { include: ['refs/tags/liftoff-execution-*'], exclude: [] } },
    rules: [{ type: 'update' }, { type: 'deletion' }] };
  const files = [{ path: 'governance/rulesets/branches.json', content: Buffer.from(JSON.stringify(ruleset)) },
    { path: 'governance/rulesets/tags.json', content: Buffer.from(JSON.stringify(tagRules)) }];
  const sourceBinding = { ...seed.binding, files: [
    { path: seed.binding.files[0]!.path, content, digest: workflowByteDigest(content), beforeDigest: null },
    ...files.map(file => ({ path: file.path, content: file.content.toString('utf8'),
      digest: workflowByteDigest(file.content), beforeDigest: null }))
  ] };
  const source = seed.review({ phaseId: 'workflow-source-ready',
    effects: [{ action: 'git.workflow-source.publish-reviewed', binding: sourceBinding }] });
  await source.store.save('plan', source.control.controlKey,
    source5WorkflowOriginalPlanValue(source.projectRoot, source.plan, source.approval), null);
  const origin = await withSource5WorkflowLease(seed.projectRoot, async lease => {
    await issueSource5WorkflowApproval({ ...source, lease }, source.now);
    const journal = await openSource5WorkflowJournal({ ...source, lease, initialize: true });
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
    return { planKey: source.control.controlKey, proofKey: journal.proofKey(source.operation),
      publicationDigest: canonicalSha256(proof), commitSha, treeSha: observed.treeSha };
  });
  const bindings: WorkflowContextBinding[] = protectedWorkflowFamilies.flatMap((family, index) =>
    [null, 1, 0].map(red => {
      const sha = red === null ? 'c'.repeat(40) : String(index * 2 + red + 1).repeat(40);
      return { repository: 'owner/repo', repositoryId: 123, family,
        ref: ['develop', 'main', 'release/fixture', 'hotfix/fixture'][index]!,
        sourceSha: sha, treeSha: red === null ? 'b'.repeat(40) : sha,
        executionRef: `liftoff-execution-${sha}`, workflowPath: sourceBinding.files[0]!.path,
        workflowDigest: workflowByteDigest(content), contexts,
        mode: red === null ? 'green' : 'controlled-red', tokenSuppressedTrigger: true,
        ...(red === null ? {} : { violation: { path: paths[red]!, parentSha: 'c'.repeat(40),
          beforeDigest: workflowByteDigest(valid[red]!), afterDigest: workflowByteDigest(invalid[red]!),
          context: contexts[red]!.name } }) };
    }));
  if (options.omitLastRed) bindings.pop();
  const value = seed.review({ phaseId: 'green-red-proof', origin,
    effects: bindings.map(binding => ({ action: 'github.checks.green-red-proof', binding })) });
  await value.store.save('plan', value.control.controlKey,
    source5WorkflowOriginalPlanValue(value.projectRoot, value.plan, value.approval), null);
  const calls: GitHubRequest[] = [], errors: unknown[] = [];
  const state = { driftRunId: 0, driftCheckId: 0, extraRuleFile: false, truncated: false,
    workflowDrift: false, tagDrift: false, protectedRefDrift: false, rulesetDrift: false, treeDrift: false,
    rulesetDriftIndex: -1, invalidTagRulesetIndex: -1 };
  const validators = new NodeCommandRunner();
  const validatorRoot = await mkdtemp(path.join(seed.root, 'matrix-validator-inputs-'));
  const outcomes: ('success' | 'failure')[][] = [];
  for (const [bindingIndex, binding] of bindings.entries()) {
    const outcome: ('success' | 'failure')[] = [];
    for (const [index, context] of contexts.entries()) {
      const text = binding.violation?.context === context.name ? invalid[index]! : valid[index]!;
      const input = path.join(validatorRoot, `${bindingIndex}-${context.jobId}.${index === 0 ? 'mjs' : 'json'}`);
      await writeFile(input, text, { flag: 'wx', mode: 0o600 });
      const result = await validators.run({ executable: process.execPath, args: index === 0 ?
        ['--check', input] : ['-e', "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))", input] },
      { cwd: seed.root, env: matrixValidatorEnvironment(seed.storage.homedir),
        timeoutMs: 5000, maxOutputBytes: 4096, stream: false, ensureProcessTreeSettled: true });
      const selector = { family: binding.family, mode: binding.mode, jobId: context.jobId };
      if (result.timedOut || result.outputLimitExceeded || result.errorCode || result.aborted || result.status === null ||
          result.signal || result.processTreeSettled !== true) {
        throw matrixValidatorFailure('settlement', selector, result);
      }
      if (await readFile(input, 'utf8') !== text) {
        throw matrixValidatorFailure('input-readback', selector, result);
      }
      outcome.push(matrixValidatorConclusion(selector, result, binding.violation?.context === context.name));
    }
    outcomes.push(outcome);
  }
  const appId = (index: number) => options.wrongRedIntegration && index === 1 ? 17000 : 15368;
  const runId = (index: number) => 901 + index * 20;
  const run = (index: number) => {
    const binding = bindings[index]!;
    return { id: runId(index), workflow_id: 90, check_suite_id: runId(index) + 11, run_attempt: 1,
      head_sha: state.driftRunId === runId(index) ? 'f'.repeat(40) : binding.sourceSha,
      head_branch: binding.executionRef, path: binding.workflowPath,
      display_title: `Liftoff context proof ${canonicalSha256(binding)}`, event: 'workflow_dispatch',
      repository: { id: 123, full_name: 'owner/repo' }, created_at: value.now.toISOString(),
      status: 'completed', conclusion: outcomes[index]!.includes('failure') ? 'failure' : 'success' };
  };
  let onRead: ((request: GitHubRequest) => Promise<void> | void) | undefined;
  let onResponse: ((request: GitHubRequest, observedIndex: number) => Promise<void> | void) | undefined;
  function response(request: GitHubRequest, observedIndex: number): unknown {
    if (request.method !== 'GET') throw new Error('Matrix fixture permits no provider writes.');
    if (request.path === '/repos/owner/repo') return { id: 123, full_name: 'owner/repo', permissions: { push: true } };
    if (request.path === '/apps/github-actions') return { id: appId(observedIndex), slug: 'github-actions' };
    if (request.path.includes('/rulesets?')) return [{ id: 11, source_type: 'Repository', source: 'owner/repo' }];
    if (request.path.startsWith('/repos/owner/repo/rulesets/')) return { ...tagRules, id: 11, source_type: 'Repository', source: 'owner/repo', enforcement: 'active' };
    if (request.path.includes('/git/ref/tags/')) {
      const sha = request.path.split('liftoff-execution-')[1]!;
      return { ref: `refs/tags/liftoff-execution-${sha}`, object: { type: 'commit', sha: state.tagDrift ? 'f'.repeat(40) : sha } };
    }
    if (request.path.includes('/git/ref/heads/')) return {
      ref: `refs/heads/${request.path.split('/git/ref/heads/')[1]}`, object: { sha: state.protectedRefDrift ? 'f'.repeat(40) : 'c'.repeat(40) }
    };
    if (request.path.includes('/git/commits/')) {
      const sha = request.path.split('/git/commits/')[1]!;
      return { sha, tree: { sha: state.treeDrift ? 'f'.repeat(40) : sha === 'c'.repeat(40) ? 'b'.repeat(40) : sha } };
    }
    if (request.path.includes('/git/trees/')) return { sha: 'b'.repeat(40), truncated: state.truncated,
      tree: [...files.map(file => ({ path: file.path, type: 'blob', mode: '100644' })),
        ...(state.extraRuleFile ? [{ path: 'governance/rulesets/omitted.json', type: 'blob', mode: '100644' }] : [])] };
    if (request.path.includes('/contents/')) {
      const [file, sha] = request.path.split('/contents/')[1]!.split('?ref=');
      const index = paths.indexOf(file!), rule = files.find(rule => rule.path === file);
      if (file === 'governance/rulesets/tags.json' && state.invalidTagRulesetIndex === observedIndex) return [];
      const bytes = file === sourceBinding.files[0]!.path ? state.workflowDrift ? 'foreign workflow' : content :
        rule ? state.rulesetDrift || state.rulesetDriftIndex === observedIndex ? '{}\n' : rule.content.toString('utf8') :
          sha === 'c'.repeat(40) ? valid[index] : invalid[index];
      if (bytes === undefined) throw new Error('Unexpected exact fixture source path.');
      return { type: 'file', path: file, encoding: 'base64', content: Buffer.from(bytes).toString('base64') };
    }
    if (request.path.includes('/compare/')) {
      const sha = request.path.split('...')[1], binding = bindings.find(binding => binding.sourceSha === sha)!;
      return { status: 'ahead', total_commits: 1, ahead_by: 1, commits: [{ sha, parents: [{ sha: 'c'.repeat(40) }] }],
        files: [{ filename: binding.violation!.path, status: 'modified' }] };
    }
    if (request.path.includes('/check-runs')) {
      const sha = request.path.split('/commits/')[1]!.split('/')[0];
      const matches = bindings.flatMap((binding, index) => binding.sourceSha === sha ? contexts.map((context, job) => ({
        id: runId(index) + 3 + job, head_sha: sha, name: state.driftCheckId === runId(index) + 3 + job ? 'Foreign check' : context.name,
        status: 'completed', conclusion: outcomes[index]![job], app: { id: appId(index), slug: 'github-actions' },
        check_suite: { id: runId(index) + 11 }
      })) : []);
      return { total_count: matches.length, check_runs: matches };
    }
    if (request.path.includes('/actions/runs/')) {
      const id = Number(request.path.split('/actions/runs/')[1]!.split('/')[0]), index = bindings.findIndex((_, index) => runId(index) === id);
      if (index < 0) throw new Error('Foreign fixture run.');
      return request.path.includes('/jobs') ? { total_count: contexts.length, jobs: contexts.map((context, job) => ({
        id: id + 1 + job, run_id: id, run_attempt: 1, name: context.name,
        check_run_url: `https://api.github.com/repos/owner/repo/check-runs/${id + 3 + job}`,
        status: 'completed', conclusion: outcomes[index]![job], steps: [
          { name: 'Checkout reviewed source', status: 'completed', conclusion: 'success' },
          { name: context.validationStep, status: 'completed', conclusion: outcomes[index]![job] }
        ]
      })) } : run(index);
    }
    if (request.path.includes('/runs?')) return { total_count: 0, workflow_runs: [] };
    if (request.path.includes('/workflows/')) return { id: 90, path: sourceBinding.files[0]!.path, state: 'active' };
    throw new Error(`Unexpected fixture endpoint ${request.path}`);
  }
  const server = createServer(async (request, reply) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input: GitHubRequest = { method: request.method === 'GET' ? 'GET' : 'POST', path: request.url!,
        ...(chunks.length ? { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) } : {}) };
      calls.push(input); if (input.method === 'GET') await onRead?.(input);
      const contextIndex = Number(request.headers['x-liftoff-fixture-entry'] ?? 0);
      if (!Number.isInteger(contextIndex) || contextIndex < 0 || contextIndex >= bindings.length) {
        throw new Error('Unknown fixture observation entry.');
      }
      const data = response(input, contextIndex);
      reply.writeHead(200, { 'content-type': 'application/json', 'x-oauth-scopes': 'repo, workflow' });
      reply.end(JSON.stringify(data));
    } catch (error) {
      errors.push(error); reply.writeHead(500, { 'content-type': 'application/json' });
      reply.end(JSON.stringify({ error: 'Isolated fixture protocol failed.' }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback fixture.');
  const transportFor = (index: number): GitHubActivationTransport => ({ async request(request) {
    const result = await fetch(`http://127.0.0.1:${address.port}${request.path}`, { method: request.method,
      headers: { 'x-liftoff-fixture-entry': String(index) },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }), signal: AbortSignal.timeout(30_000) });
    const data = await result.json();
    await onResponse?.(request, index);
    return { status: result.status, headers: { 'x-oauth-scopes': result.headers.get('x-oauth-scopes') ?? '' }, data };
  } });
  const transport = transportFor(0);
  const proofs: WorkflowContextProof[] = [];
  async function fields(lease: ProjectMutationLease, now = value.now) {
    const authority = await restoreSource5WorkflowAuthority({ ...value, lease }, now);
    const phase = value.context.records.graph.phases.find(phase => phase.id === value.control.phaseId)!;
    return { projectRoot: value.projectRoot, plan: value.plan, phase: { ...phase, id: value.control.phaseId },
      authority, lease, now, runner: noGit, transport, profile: value.plan.identity.profile };
  }
  let originalPreparation: Promise<void> | undefined;
  let originalPrepared = false;
  async function prepareOriginalComponents() {
    if (originalPreparation) throw new Error('Never repeat attempted original matrix fixture preparation.');
    originalPreparation = withSource5WorkflowLease(value.projectRoot, async lease => {
      await issueSource5WorkflowApproval({ ...value, lease }, value.now);
      const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: true });
      const effects = source5WorkflowPlanInventory(value.plan).effects;
      for (const [index, operation] of effects.entries()) {
        const binding = bindings[index]!, base = { bindingDigest: canonicalSha256(binding), planDigest: value.plan.planDigest,
          dispatchedAt: value.now.toISOString(), workflowId: 90 };
        await journal.record(operation, 'dispatch-intent', { ...base, stage: 'dispatch-intent' });
        await journal.record(operation, 'dispatch-accepted', { ...base, stage: 'accepted', runId: runId(index) });
        const conclusion: 'success' | 'failure' = outcomes[index]!.includes('failure') ? 'failure' : 'success';
        await journal.record(operation, 'dispatch-terminal', { ...base, stage: 'terminal', runId: runId(index),
          terminalConclusion: conclusion, terminalConclusionDigest: canonicalSha256({ conclusion }) });
        const executionAdmission = await observeImmutableWorkflowExecutionRef(
          workflowObservationRuntime({ projectRoot: value.projectRoot, runner: noGit, transport }), binding);
        const observed = { runId: runId(index), workflowId: 90, attempt: 1 as const, conclusion,
          contexts: contexts.map((context, job) => ({ name: context.name, jobId: runId(index) + 1 + job,
            checkRunId: runId(index) + 3 + job, applicationId: appId(index),
            conclusion: outcomes[index]![job]!, validationStep: context.validationStep })), executionAdmission };
        const proof: WorkflowContextProof = { kind: 'workflow-context-proof.v1', binding, ...base, ...observed,
          observedAt: value.now.toISOString(), observationDigest: canonicalSha256(observed) };
        await journal.record(operation, 'component-completed', { bindingDigest: base.bindingDigest, planDigest: base.planDigest, proof });
        proofs.push(proof);
      }
    });
    await originalPreparation;
    originalPrepared = true;
    calls.splice(0);
  }
  calls.splice(0);
  return { ...value, source, bindings, proofs, files, state, calls, errors,
    requirements: requiredWorkflowContextsFromSource(files, 'single-maintainer-gitflow'),
    prepareOriginalComponents,
    onRead(callback: (request: GitHubRequest) => Promise<void> | void) { onRead = callback; },
    onResponse(callback: (request: GitHubRequest, observedIndex: number) => Promise<void> | void) { onResponse = callback; },
    async entries(lease: ProjectMutationLease, now = value.now) {
      if (!originalPrepared) throw new Error('Original matrix fixture components have not completed; do not issue observation carriers.');
      const journal = await openSource5WorkflowJournal({ ...value, lease, initialize: false }), input = await fields(lease, now);
      const entries = await Promise.all(source5WorkflowPlanInventory(value.plan).effects.map(async (operation, index) =>
        ({ input: await createSource5WorkflowEffectInput({ ...input, operation, transport: transportFor(index),
          kind: 'source5-workflow-effect.v1', reviewedPlans: [value.plan], observationOnly: true }, journal), proof: proofs[index]! })));
      return { entries, journal };
    },
    async close() {
      if (originalPreparation) await Promise.allSettled([originalPreparation]);
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}
