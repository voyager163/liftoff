import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { parse, stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildSavedTransitionPlan, canonicalPhaseGraph, canonicalSha256
} from '../src/governance-activation/index.js';
import { canonicalApprovalEnvelopeHash } from '../src/domain/governance/activation/approvals.js';
import { NodeCommandRunner, type CommandRunner, type RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';
import type { GitHubActivationTransport, GitHubRequest, GitHubResponse } from '../src/adapters/github/activation-rest.js';
import {
  executeWorkflowContextProof, validateContextWorkflow, validateWorkflowContextBinding,
  verifyProtectedWorkflowProofMatrix, type WorkflowContextBinding, type WorkflowContextExecutionInput,
  type WorkflowProofCheckpoint, type WorkflowContextProof
} from '../src/governance-activation/workflow-context-proof.js';
import {
  executeWorkflowSourcePublication, validateWorkflowPublication,
  type WorkflowPublicationBinding, type WorkflowPublicationInput, type WorkflowPublicationCheckpoint
} from '../src/governance-activation/workflow-publication.js';
import {
  workflowByteDigest, workflowObservationRuntime, workflowPlannedOperation, workflowRuntime
} from '../src/governance-activation/workflow-runtime.js';
import {
  bindImmutableWorkflowExecutionRef, workflowExecutionRefName,
  type WorkflowExecutionRefInput
} from '../src/governance-activation/workflow-execution-ref.js';
import {
  admitReviewedRunnerWorkflows, validateWorkflowRunnerAdmission, type WorkflowRunnerAdmissionInput
} from '../src/governance-activation/workflow-runner-admission.js';
import { validateWorkflowRunnerAdmission as neutralRunnerBinding } from '../src/governance-activation/workflow-runner-admission-observation.js';
import { executeGitHubPhase } from '../src/governance-activation/phase-github.js';
import {
  coverageNow, coverageState, coverageInspection, isolateUserLocalStorage, isolatedGitEnvironment,
  issuePriorApproval, resetDirectory, scratchDirectory, writeCoverageProject
} from './fixtures/governance-coverage/transition-project.js';
import type { PhaseAdapterExecutionInput } from '../src/governance-activation/transition-ports.js';
import { requiredWorkflowContextsFromSource } from '../src/governance-activation/workflow-requirements.js';
import { isRecord } from '../src/domain/governance/activation/canonical-json.js';

const scratch = scratchDirectory('workflow-producers');
let storage: Awaited<ReturnType<typeof isolateUserLocalStorage>>;
let environment: NodeJS.ProcessEnv;
let counter = 0;
beforeAll(async () => {
  await resetDirectory(scratch);
  storage = await isolateUserLocalStorage();
  environment = { ...await isolatedGitEnvironment(scratch),
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
});
afterAll(async () => { await storage.restore(); await rm(scratch, { recursive: true, force: true }); });

it('preserves owner observer and safe-control reexports as the same neutral function identities', async () => {
  const neutral = await import('../src/governance-activation/workflow-execution-ref-observation.js');
  const original = await import('../src/governance-activation/workflow-execution-ref.js');
  const values = await import('../src/governance-activation/workflow-control-values.js');
  const bindings = await import('../src/governance-activation/workflow-binding.js');
  expect(original.observeImmutableWorkflowExecutionRef).toBe(neutral.observeImmutableWorkflowExecutionRef);
  expect(original.observeWorkflowExecutionBarrier).toBe(neutral.observeWorkflowExecutionBarrier);
  expect(original.observeWorkflowProviderAdmission).toBe(neutral.observeWorkflowProviderAdmission);
  expect(original.workflowExecutionRefName).toBe(neutral.workflowExecutionRefName);
  expect(bindings.captureWorkflowBinding).toBe(values.captureWorkflowBinding);
  expect(bindings.workflowFailure).toBe(values.workflowFailure);
});

function recipe() {
  return stringify({
    name: 'Isolated actual validator', 'run-name': 'Liftoff context proof ${{ inputs.proof_id }}',
    on: { workflow_dispatch: { inputs: {
      proof_id: { type: 'string', required: true }, source_sha: { type: 'string', required: true },
      protected_ref: { type: 'string', required: true }
    } } }, permissions: { contents: 'read' },
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

function binding(): WorkflowContextBinding {
  return {
    repository: 'owner/repo', repositoryId: 123, family: 'develop', ref: 'develop', sourceSha: 'a'.repeat(40),
    treeSha: 'e'.repeat(40),
    executionRef: workflowExecutionRefName('a'.repeat(40)),
    workflowPath: '.github/workflows/proof.yml', workflowDigest: workflowByteDigest(recipe()),
    contexts: [{ jobId: 'validate', name: 'Required validation', validationStep: 'Validate source' }],
    mode: 'green', tokenSuppressedTrigger: true
  };
}

function rulesetSource(count = 0) {
  return [{ path: 'governance/rulesets/branches.json', content: Buffer.from(JSON.stringify({
    target: 'branch', bypass_actors: [],
    conditions: { ref_name: { include: ['refs/heads/develop', 'refs/heads/main', 'refs/heads/release/**', 'refs/heads/hotfix/**'], exclude: [] } },
    rules: [
      { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
        required_status_checks: [{ context: 'Required validation' }] } },
      { type: 'pull_request', parameters: { required_approving_review_count: count, dismiss_stale_reviews_on_push: true } }
    ]
  })) }];
}

it.each(['trailing-step', 'duplicate-validation', 'required-job-dependency', 'empty-validator', 'mixed-validator'] as const)(
  'refuses a %s recipe before an ordinary final validator can be misidentified', variant => {
    const value: unknown = parse(recipe());
    if (!isRecord(value) || !isRecord(value.jobs) || !isRecord(value.jobs.validate)) {
      throw new Error('Expected actual isolated recipe job.');
    }
    const job = value.jobs.validate;
    if (!Array.isArray(job.steps)) throw new Error('Expected actual isolated recipe steps.');
    const reviewed = binding();
    if (variant === 'required-job-dependency') {
      value.jobs.inspect = {
        ...job, name: 'Required configuration validation',
        steps: [...structuredClone(job.steps.slice(0, -1)), { name: 'Validate configuration', run: 'node --check backend/configuration.js' }]
      };
      reviewed.contexts = [...reviewed.contexts, {
        jobId: 'inspect', name: 'Required configuration validation', validationStep: 'Validate configuration'
      }];
      expect(() => validateContextWorkflow(Buffer.from(stringify(value)), reviewed)).not.toThrow();
      job.needs = 'inspect';
    }
    else if (variant === 'empty-validator' || variant === 'mixed-validator') {
      job.steps[job.steps.length - 1] = {
        name: 'Validate source', run: variant === 'empty-validator' ? ' ' : 'node --check backend/application.js',
        ...(variant === 'mixed-validator' ? { uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' } : {})
      };
    } else job.steps.push({
      name: variant === 'duplicate-validation' ? 'Validate source' : 'Inspect source after validation',
      run: 'node --check backend/application.js'
    });
    expect(() => validateContextWorkflow(Buffer.from(stringify(value)), reviewed)).toThrow(/validation|validator|recipe/);
  });

class WorkflowTransport implements GitHubActivationTransport {
  calls: GitHubRequest[] = [];
  binding = binding();
  workflow = recipe();
  before = 'export const healthy = true;\n';
  after = 'export const healthy = ;\n';
  dispatched = false;
  visible = true;
  ambiguous = false;
  runStatus = 'completed';
  runConclusion: string | undefined;
  runOverrides: Record<string, unknown> = {};
  jobOverrides: Record<string, unknown> = {};
  checkOverrides: Record<string, unknown> = {};
  refSha: string | undefined;
  rejectDispatch = false;
  protectionOverrides: Record<string, unknown> = {};
  executionOverrides: Record<string, unknown> = {};
  permissionScopes: string | undefined = 'repo, workflow';
  dispatchResponse: GitHubResponse | undefined;
  tagExists = true;
  tagInvisible = false;
  inheritedRule = false;
  groupWorkflows: string[] = [];
  groupOverrides: Record<string, unknown> = {};
  membershipRole = 'admin';
  membershipScopes = 'admin:org';
  treeTruncated = false;
  runId = 901;
  onSourceRead: (() => void) | undefined;
  run() {
    return { id: this.runId, workflow_id: 90, check_suite_id: this.runId + 10, run_attempt: 1,
      head_sha: this.binding.sourceSha, head_branch: this.binding.executionRef, path: this.binding.workflowPath,
      display_title: `Liftoff context proof ${canonicalSha256(this.binding)}`, event: 'workflow_dispatch',
      repository: { id: 123, full_name: 'owner/repo' }, created_at: coverageNow.toISOString(),
      status: this.runStatus, conclusion: this.runConclusion ?? (this.binding.mode === 'green' ? 'success' : 'failure'),
      ...this.runOverrides };
  }
  async request(request: GitHubRequest) {
    this.calls.push(request);
    let data: unknown;
    if (request.path === '/repos/owner/repo') data = { id: 123, full_name: 'owner/repo', permissions: { push: true } };
    else if (request.path === '/apps/github-actions') data = { id: 15368, slug: 'github-actions' };
    else if (request.path.includes('/rulesets?')) data = [{
      id: 11, source_type: this.inheritedRule ? 'Organization' : 'Repository',
      source: this.inheritedRule ? 'owner' : 'owner/repo'
    }];
    else if (request.path.startsWith('/repos/owner/repo/rulesets/')) data = {
      id: 11, source_type: 'Repository', source: 'owner/repo', target: 'tag', enforcement: 'active', bypass_actors: [],
      conditions: { ref_name: { include: ['refs/tags/liftoff-execution-*'], exclude: [] } },
      rules: [{ type: 'update' }, { type: 'deletion' }], ...this.protectionOverrides
    };
    else if (request.path.includes('/git/ref/tags/')) {
      if (!this.tagExists || this.tagInvisible) return { status: 404, headers: {}, data: null };
      data = { ref: `refs/tags/${this.binding.executionRef}`,
        object: { type: 'commit', sha: this.binding.sourceSha }, ...this.executionOverrides };
    }
    else if (request.path.includes('/git/ref/')) data = {
      ref: `refs/heads/${this.binding.ref}`, object: {
        sha: this.refSha ?? this.binding.violation?.parentSha ?? this.binding.sourceSha
      }
    };
    else if (request.path.includes('/git/commits/')) data = {
      sha: request.path.split('/').at(-1), tree: { sha: this.binding.treeSha }
    };
    else if (request.path.includes('/git/trees/')) data = {
      sha: this.binding.treeSha, truncated: this.treeTruncated,
      tree: [{ path: 'governance/rulesets/branches.json', type: 'blob', mode: '100644' }]
    };
    else if (request.path.includes('/contents/')) {
      this.onSourceRead?.();
      const file = request.path.split('/contents/')[1]!.split('?')[0]!;
      const content = file === this.binding.workflowPath ? this.workflow :
        file.startsWith('governance/rulesets/') ? rulesetSource()[0]!.content.toString('utf8') :
        request.path.endsWith(this.binding.violation?.parentSha ?? '') ? this.before : this.after;
      data = { type: 'file', path: file, encoding: 'base64', content: Buffer.from(content).toString('base64') };
    } else if (request.path.includes('/compare/')) data = {
      status: 'ahead', total_commits: 1, ahead_by: 1,
      commits: [{ sha: this.binding.sourceSha, parents: [{ sha: this.binding.violation!.parentSha }] }],
      files: [{ filename: this.binding.violation!.path, status: 'modified' }]
    };
    else if (request.path === '/user/memberships/orgs/owner') {
      return { status: 200, headers: { 'x-oauth-scopes': this.membershipScopes },
        data: { state: 'active', role: this.membershipRole, organization: { login: 'owner' } } };
    }
    else if (request.path.includes('/runner-groups/')) {
      if (request.method === 'PATCH') {
        this.groupWorkflows = [...(request.body as { selected_workflows: string[] }).selected_workflows];
      }
      data = request.path.includes('/repositories') ?
        { total_count: 1, repositories: [{ id: 123, full_name: 'owner/repo' }] } :
        { id: 72, name: 'Private qualified group', network_configuration_id: 'network-id',
          visibility: 'selected', inherited: false, workflow_restrictions_read_only: false,
          allows_public_repositories: false, restricted_to_workflows: true,
          selected_workflows: this.groupWorkflows, ...this.groupOverrides };
    }
    else if (request.method === 'POST' && request.path.endsWith('/git/refs')) {
      this.tagExists = true;
      if (this.rejectDispatch) throw new Error('sensitive uncertain tag diagnostics');
      return { status: 201, headers: {}, data: {} };
    }
    else if (request.method === 'POST') {
      this.dispatched = true;
      if (this.rejectDispatch) throw new Error('sensitive uncertain provider diagnostics');
      return this.dispatchResponse ?? { status: 204, headers: {}, data: null };
    } else if (request.path.includes('/jobs')) data = { total_count: 1, jobs: [{
      id: this.runId + 1, run_id: this.runId, run_attempt: 1, name: 'Required validation',
      check_run_url: `https://api.github.com/repos/owner/repo/check-runs/${this.runId + 2}`,
      status: 'completed', conclusion: this.binding.mode === 'green' ? 'success' : 'failure',
      steps: [
        { name: 'Checkout reviewed source', status: 'completed', conclusion: 'success' },
        { name: 'Validate source', status: 'completed', conclusion: this.binding.mode === 'green' ? 'success' : 'failure' }
      ],
      ...this.jobOverrides
    }] };
    else if (request.path.includes('/check-runs')) data = { total_count: 1, check_runs: [{
      id: this.runId + 2, head_sha: this.binding.sourceSha, name: 'Required validation', status: 'completed',
      conclusion: this.binding.mode === 'green' ? 'success' : 'failure',
      app: { id: 15368, slug: 'github-actions' }, check_suite: { id: this.runId + 10 }, ...this.checkOverrides
    }] };
    else if (request.path.includes('/runs?')) {
      const runs = this.dispatched && this.visible ? [this.run()] : [];
      if (this.ambiguous && runs.length) runs.push(this.run());
      data = { total_count: runs.length, workflow_runs: runs };
    } else if (request.path.includes('/workflows/')) data = { id: 90, path: this.binding.workflowPath, state: 'active' };
    else if (request.path.includes('/actions/runs/')) data = this.run();
    else throw new Error(`Unexpected isolated provider endpoint ${request.path}`);
    return { status: 200, headers: this.permissionScopes === undefined ? {} : { 'x-oauth-scopes': this.permissionScopes }, data };
  }
  get writes() { return this.calls.filter((call) => call.method !== 'GET'); }
}

class WorkflowRunner implements CommandRunner {
  calls: ExternalCommand[] = [];
  options: RunCommandOptions[] = [];
  private native = new NodeCommandRunner();
  async run(command: ExternalCommand, options?: RunCommandOptions) {
    this.calls.push(command); this.options.push(options ?? {});
    if (command.executable !== 'git' || command.args.includes('push') || command.args.includes('fetch')) {
      throw new Error('Provider/network process execution is forbidden in isolated fixtures.');
    }
    return this.native.run(command, { ...options, env: { ...options?.env, ...environment } });
  }
}

describe('workflow receipt-time bounds without timer scheduling assumptions', () => {
  const boundaries = [
    { startedAt: 0, completedAt: 29_999, accepted: true },
    { startedAt: 0, completedAt: 30_000, accepted: false },
    { startedAt: 0, completedAt: 30_001, accepted: false },
    { startedAt: 170_000, completedAt: 179_999, accepted: true },
    { startedAt: 170_000, completedAt: 180_000, accepted: false },
    { startedAt: 170_000, completedAt: 180_001, accepted: false }
  ];
  it.each(boundaries)('checks actual loopback provider receipt against %j', async boundary => {
    let elapsed = 0, received = false;
    const requests: GitHubRequest[] = [];
    const server = createServer((request, response) => {
      expect(request.method).toBe('GET');
      expect(request.url).toBe('/repos/owner/repo');
      elapsed = boundary.completedAt;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 123 }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected isolated TCP fixture.');
    const transport: GitHubActivationTransport = { async request(request) {
      requests.push(request);
      const response = await fetch(`http://127.0.0.1:${address.port}${request.path}`, {
        signal: AbortSignal.timeout(30_000)
      });
      const data: unknown = await response.json();
      received = true;
      return { status: response.status, headers: {}, data };
    } };
    const started = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => started + elapsed);
    try {
      const runtime = workflowObservationRuntime({ projectRoot: scratch, runner: new WorkflowRunner(), transport });
      elapsed = boundary.startedAt;
      const reading = runtime.client.get('/repos/owner/repo');
      if (boundary.accepted) await expect(reading).resolves.toEqual({ id: 123 });
      else await expect(reading).rejects.toMatchObject({ code: 'workflow-deadline' });
      expect(received).toBe(true);
      expect(requests).toEqual([{ method: 'GET', path: '/repos/owner/repo' }]);
    } finally {
      clock.mockRestore();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  it.each(boundaries)('checks settled literal Git receipt against %j', async boundary => {
    const root = await writeCoverageProject(path.join(scratch, `${++counter}`));
    const native = new WorkflowRunner();
    const gitEnvironment = { GIT_DIR: path.join(root, '.git'), GIT_WORK_TREE: root, GIT_CEILING_DIRECTORIES: root };
    const initialized = await native.run({
      executable: 'git', args: ['init', '--template=', '--initial-branch=fixture']
    }, { cwd: root, env: gitEnvironment, timeoutMs: 30_000, stream: false });
    expect(initialized.status).toBe(0);
    const configuration = await readFile(path.join(root, '.git', 'config'), 'utf8');
    expect(configuration).not.toMatch(/\[(?:remote|branch) /u);
    let elapsed = 0, settled = false;
    const runner: CommandRunner = { async run(command, options) {
      const result = await native.run(command, { ...options, env: { ...options?.env, ...gitEnvironment } });
      expect(result.status).toBe(0);
      expect(result.timedOut).toBe(false);
      elapsed = boundary.completedAt;
      settled = true;
      return result;
    } };
    const started = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => started + elapsed);
    try {
      const runtime = workflowObservationRuntime({ projectRoot: root, runner, transport: new WorkflowTransport() });
      elapsed = boundary.startedAt;
      const reading = runtime.git(['config', '--list', '--name-only']);
      if (boundary.accepted) await expect(reading).resolves.toEqual(expect.any(String));
      else await expect(reading).rejects.toMatchObject({ code: 'workflow-git' });
      expect(settled).toBe(true);
      expect(native.calls).toHaveLength(2);
      expect(native.options[1]!.timeoutMs).toBe(Math.min(30_000, 180_000 - boundary.startedAt));
      expect(await readFile(path.join(root, '.git', 'config'), 'utf8')).toBe(configuration);
    } finally { clock.mockRestore(); }
  });
  it('does not restart the provider budget after synchronous transport preparation', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const transport: GitHubActivationTransport = { async request() {
      vi.setSystemTime(started + 25_000);
      return new Promise(() => {});
    } };
    const runtime = workflowObservationRuntime({ projectRoot: scratch, runner: new WorkflowRunner(), transport });
    const refused = expect(runtime.client.get('/repos/owner/repo')).rejects.toMatchObject({ code: 'workflow-deadline' });
    try {
      expect(timers.mock.calls.at(-1)?.[1]).toBe(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      await refused;
    } finally {
      await vi.runAllTimersAsync();
      await refused;
      timers.mockRestore();
      vi.useRealTimers();
    }
  });
});

async function fixture() {
  const root = await writeCoverageProject(path.join(scratch, `${++counter}`));
  const runner = new WorkflowRunner();
  const state = coverageState();
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'dev-proof')!;
  const inspection = await coverageInspection({ root, phaseId: phase.id, state });
  const plan = (await buildSavedTransitionPlan({ inspection, phaseId: phase.id, runner, now: coverageNow }))!;
  const transport = new WorkflowTransport();
  const operation = workflowPlannedOperation(phase.id, 'github.checks.dev-proof', transport.binding);
  plan.operations = [operation];
  const approval = await issuePriorApproval(root, state, plan);
  inspection.approvals = [approval];
  plan.approval = { ...plan.approval, envelopeId: approval.id,
    envelopeHash: canonicalApprovalEnvelopeHash(approval) };
  const checkpoints: WorkflowProofCheckpoint[] = [];
  const input: WorkflowContextExecutionInput = {
    inspection, phase, runner, plan, now: coverageNow, clock: () => coverageNow,
    adapters: { githubActivation: { transport } },
    lease: { assertHeld: async () => {} },
    recordWorkflowDispatch: async (checkpoint) => { checkpoints.push(structuredClone(checkpoint)); input.workflowCheckpoint = checkpoint; }
  };
  return { input, root, runner, transport, checkpoints };
}

async function reapprove(f: Awaited<ReturnType<typeof fixture>>) {
  f.input.plan.operations = f.input.plan.operations.map(operation =>
    workflowPlannedOperation(f.input.phase.id, operation.actionId, f.transport.binding));
  const approval = await issuePriorApproval(f.root, f.input.inspection.state, f.input.plan);
  f.input.inspection.approvals = [approval];
  f.input.plan.approval.envelopeHash = canonicalApprovalEnvelopeHash(approval);
}

describe('bounded exact-commit workflow context production', () => {
  it('persists the documented 200 exact-repository handle before polling and never rediscovers or reposts it', async () => {
    const f = await fixture();
    f.transport.dispatchResponse = { status: 200, headers: {}, data: {
      workflow_run_id: 901, run_url: 'https://api.github.com/repos/owner/repo/actions/runs/901',
      html_url: 'https://github.com/owner/repo/actions/runs/901'
    } };
    f.transport.runStatus = 'queued'; f.transport.visible = false;
    expect(await executeWorkflowContextProof(f.input, f.transport.binding)).toMatchObject({
      status: 'pending', checkpoint: { stage: 'accepted', runId: 901,
        runUrl: 'https://api.github.com/repos/owner/repo/actions/runs/901' }
    });
    const accepted = f.checkpoints.at(-1)!;
    expect(accepted.dispatchedAt).toBe(coverageNow.toISOString());
    f.transport.runStatus = 'completed';
    expect(await executeWorkflowContextProof(f.input, f.transport.binding)).toMatchObject({ status: 'completed' });
    expect(f.transport.writes).toHaveLength(1);
    expect(f.transport.calls.filter(call => call.path.includes('/runs?'))).toHaveLength(1);
  });
  it.each([
    {}, { workflow_run_id: 0 }, {
      workflow_run_id: 901, run_url: 'https://api.github.com/repos/foreign/repo/actions/runs/901',
      html_url: 'https://github.com/owner/repo/actions/runs/901'
    }, {
      workflow_run_id: 901, run_url: 'https://api.github.com/repos/owner/repo/actions/runs/901',
      html_url: 'https://github.com/owner/repo/actions/runs/901?token=private'
    }
  ])('retains intent on malformed/foreign 200 handles without exposing their content', async data => {
    const f = await fixture(); f.transport.dispatchResponse = { status: 200, headers: {}, data };
    await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow('accepted dispatch response');
    expect(f.checkpoints.map(checkpoint => checkpoint.stage)).toEqual(['dispatch-intent']);
    expect(f.transport.writes).toHaveLength(1);
    expect(await executeWorkflowContextProof(f.input, f.transport.binding)).toMatchObject({ status: 'completed' });
    expect(f.transport.writes).toHaveLength(1);
  });
  it.each([undefined, 'repo', 'workflow'])('refuses unsupported provider grants %s before dispatch', async scopes => {
    const f = await fixture(); f.transport.permissionScopes = scopes;
    await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow('permission admission');
    expect(f.transport.writes).toEqual([]);
  });
  it('blocks unsupported inherited rule admission instead of silently excluding it', async () => {
    const f = await fixture(); f.transport.inheritedRule = true;
    await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow('inherited/organization');
    expect(f.transport.writes).toEqual([]);
  });
  it('dispatches explicitly with durable intent, then records real run/job/Actions check identities', async () => {
    const f = await fixture();
    const result = await executeWorkflowContextProof(f.input, f.transport.binding);
    expect(result).toMatchObject({ status: 'completed', proof: { runId: 901, workflowId: 90, conclusion: 'success' } });
    expect(f.checkpoints.map((entry) => entry.stage)).toEqual(['dispatch-intent', 'accepted', 'terminal']);
    expect(f.transport.writes).toEqual([{ method: 'POST',
      path: '/repos/owner/repo/actions/workflows/90/dispatches',
      body: { ref: workflowExecutionRefName('a'.repeat(40)), inputs: {
        source_sha: 'a'.repeat(40), protected_ref: 'refs/heads/develop', proof_id: canonicalSha256(f.transport.binding)
      } }
    }]);
    expect(f.transport.calls.some((call) => call.path.includes('/statuses'))).toBe(false);
  });

  async function authorizePrivateSource(
    f: Awaited<ReturnType<typeof fixture>>, actionId: string, source: unknown
  ) {
    const phase = canonicalPhaseGraph.phases.find(phase => phase.id === 'bootstrap-workflow-source-ready')!;
    f.input.phase = phase;
    f.input.plan = { ...f.input.plan, phaseId: phase.id,
      operations: [workflowPlannedOperation(phase.id, actionId, source)],
      approval: { ...f.input.plan.approval, gateKind: phase.approvalGate.kind }
    };
    const approval = await issuePriorApproval(f.root, f.input.inspection.state, f.input.plan);
    f.input.inspection.approvals = [approval];
    f.input.plan.approval = { ...f.input.plan.approval, envelopeId: approval.id,
      envelopeHash: canonicalApprovalEnvelopeHash(approval) };
  }

  describe('exact existing execution-ref and runner admission prerequisites', () => {
    it('reexports the same neutral runner binding validator without a second policy', () => {
      expect(validateWorkflowRunnerAdmission).toBe(neutralRunnerBinding);
    });
    it('creates only the approved commit/tree-named tag with intent, then observes without repeating', async () => {
      const f = await fixture();
      const { repository, repositoryId, sourceSha, treeSha, executionRef } = f.transport.binding;
      const source = { repository, repositoryId, sourceSha, treeSha, executionRef };
      await authorizePrivateSource(f, 'github.workflow-source.bind-execution-ref', source);
      f.transport.tagExists = false;
      const input: WorkflowExecutionRefInput = { ...f.input,
        recordExecutionRefIntent: async intent => { input.executionRefIntent = intent; }
      };
      expect(await bindImmutableWorkflowExecutionRef(input, source)).toMatchObject({
        kind: 'immutable-workflow-execution-ref.v1', protectingRulesetIds: [11], binding: source
      });
      expect(await bindImmutableWorkflowExecutionRef(input, source)).toHaveProperty('barrierDigest');
      expect(f.transport.writes).toEqual([{ method: 'POST', path: '/repos/owner/repo/git/refs',
        body: { ref: `refs/tags/${executionRef}`, sha: sourceSha } }]);
    });
    it('retains an uncertain invisible tag-create intent and does not repeat it', async () => {
      const f = await fixture();
      const { repository, repositoryId, sourceSha, treeSha, executionRef } = f.transport.binding;
      const source = { repository, repositoryId, sourceSha, treeSha, executionRef };
      await authorizePrivateSource(f, 'github.workflow-source.bind-execution-ref', source);
      f.transport.tagExists = false; f.transport.tagInvisible = true;
      const input: WorkflowExecutionRefInput = { ...f.input,
        recordExecutionRefIntent: async intent => { input.executionRefIntent = intent; }
      };
      await expect(bindImmutableWorkflowExecutionRef(input, source)).rejects.toThrow();
      await expect(bindImmutableWorkflowExecutionRef(input, source)).rejects.toThrow('automatic repeated');
      expect(f.transport.writes).toHaveLength(1);
      f.transport.tagInvisible = false;
      expect(await bindImmutableWorkflowExecutionRef(input, source)).toHaveProperty('observationDigest');
      expect(f.transport.writes).toHaveLength(1);
    });
    it.each(['network', 'membership', 'scope', 'inherited', 'readonly'] as const)(
      'blocks changed/missing runner %s before PATCH', async kind => {
        const f = await fixture();
        const source = { repository: 'owner/repo', repositoryId: 123, groupId: 72,
          groupName: 'Private qualified group', networkConfigurationId: 'network-id', beforeWorkflows: [],
          afterWorkflows: [`owner/repo/.github/workflows/proof.yml@refs/tags/${f.transport.binding.executionRef}`] };
        await authorizePrivateSource(f, 'github.workflow-source.admit-reviewed', source);
        if (kind === 'network') f.transport.groupOverrides.network_configuration_id = 'foreign';
        if (kind === 'membership') f.transport.membershipRole = 'member';
        if (kind === 'scope') f.transport.membershipScopes = 'repo';
        if (kind === 'inherited') f.transport.groupOverrides.inherited = true;
        if (kind === 'readonly') f.transport.groupOverrides.workflow_restrictions_read_only = true;
        const input: WorkflowRunnerAdmissionInput = { ...f.input,
          recordRunnerAdmissionIntent: async intent => { input.runnerAdmissionIntent = intent; }
        };
        await expect(admitReviewedRunnerWorkflows(input, source)).rejects.toThrow();
        expect(f.transport.writes).toEqual([]);
      });
    it('preserves existing selected workflows and repository/network assignment while adding the exact tag recipe', async () => {
      const f = await fixture();
      const before = ['owner/repo/.github/workflows/existing.yml@refs/heads/develop'];
      const source = { repository: 'owner/repo', repositoryId: 123, groupId: 72,
        groupName: 'Private qualified group', networkConfigurationId: 'network-id', beforeWorkflows: before,
        afterWorkflows: [...before, `owner/repo/.github/workflows/proof.yml@refs/tags/${f.transport.binding.executionRef}`] };
      f.transport.groupWorkflows = [...before];
      await authorizePrivateSource(f, 'github.workflow-source.admit-reviewed', source);
      const input: WorkflowRunnerAdmissionInput = { ...f.input,
        recordRunnerAdmissionIntent: async intent => { input.runnerAdmissionIntent = intent; }
      };
      expect(await admitReviewedRunnerWorkflows(input, source)).toHaveProperty('observationDigest');
      expect(await admitReviewedRunnerWorkflows(input, source)).toHaveProperty('bindingDigest');
      expect(f.transport.writes).toEqual([{ method: 'PATCH', path: '/orgs/owner/actions/runner-groups/72', body: {
        name: source.groupName, restricted_to_workflows: true, selected_workflows: source.afterWorkflows
      } }]);
    });
    it('returns explicit public/legacy workflow blockers instead of a null producer route', async () => {
      const f = await fixture();
      expect(await executeGitHubPhase(f.input)).toMatchObject({ status: 'blocked', completedOperations: [] });
      expect(f.transport.calls).toEqual([]);
    });
  });

  describe('complete independently current four-family proof matrix', () => {
    async function matrixFixture() {
      const entries: Awaited<ReturnType<typeof fixture>>[] = [];
      const proofs: WorkflowContextProof[] = [];
      const families = ['develop', 'main', 'release', 'hotfix'] as const;
      for (const [index, family] of families.entries()) {
        for (const red of [false, true]) {
          const f = await fixture();
          f.transport.binding.family = family;
          f.transport.binding.ref = ['develop', 'main', 'release/fixture', 'hotfix/fixture'][index]!;
          f.transport.runId = 901 + entries.length * 20;
          if (red) {
            f.transport.binding.sourceSha = String(index + 1).repeat(40);
            f.transport.binding.treeSha = String(index + 5).repeat(40);
            f.transport.binding.executionRef = workflowExecutionRefName(f.transport.binding.sourceSha);
            f.transport.binding.mode = 'controlled-red';
            f.transport.binding.violation = { path: 'backend/application.js', parentSha: 'a'.repeat(40),
              beforeDigest: workflowByteDigest(f.transport.before), afterDigest: workflowByteDigest(f.transport.after),
              context: 'Required validation' };
          }
          await reapprove(f);
          const result = await executeWorkflowContextProof(f.input, f.transport.binding);
          if (result.status !== 'completed') throw new Error('Isolated matrix setup failed.');
          entries.push(f); proofs.push(result.proof);
        }
      }
      const first = entries[0]!;
      first.input.inspection.contexts[first.input.phase.id].reviewedPlans = entries.map(entry => entry.input.plan);
      const multi: GitHubActivationTransport = {
        async request(request) {
          if (request.method !== 'GET') throw new Error('Independent matrix readback is read-only.');
          if (request.path.includes('/check-runs')) {
            const matches = entries.filter(entry => request.path.includes(entry.transport.binding.sourceSha));
            const checks = await Promise.all(matches.map(entry => entry.transport.request(request)));
            return { status: 200, headers: {}, data: { total_count: checks.length,
              check_runs: checks.flatMap(response => (response.data as { check_runs: unknown[] }).check_runs) } };
          }
          const run = entries.find(entry => request.path.includes(`/actions/runs/${entry.transport.runId}`));
          const ref = entries.find(entry => request.path.endsWith(`/git/ref/heads/${entry.transport.binding.ref}`));
          const compare = request.path.includes('/compare/') ?
            entries.find(entry => entry.transport.binding.sourceSha === request.path.split('...').at(-1)) : undefined;
          const sha = entries.find(entry => request.path.includes(entry.transport.binding.sourceSha));
          return (run ?? ref ?? compare ?? sha ?? first).transport.request(request);
        }
      };
      first.input.adapters = { githubActivation: { transport: multi } };
      return { entries, proofs, input: first.input,
        requirements: requiredWorkflowContextsFromSource(rulesetSource(), 'single-maintainer-gitflow') };
    }
    it('requires all real greens and separate validator-caused reds without moving protected refs or writing checks', async () => {
      const f = await matrixFixture();
      const matrix = await verifyProtectedWorkflowProofMatrix(f.input, f.requirements, f.proofs);
      expect(matrix.kind).toBe('green-red-required-contexts.v2');
      expect(matrix.proofDigests).toHaveLength(8);
      expect(matrix.observationDigest).toBe(canonicalSha256(matrix.proofDigests));
      expect(f.entries.flatMap(entry => entry.transport.writes).every(write => write.path.endsWith('/dispatches'))).toBe(true);
    });
    it('rejects incomplete/truncated actual source inventory after successful real job observation', async () => {
      const f = await matrixFixture(); f.entries[0]!.transport.treeTruncated = true;
      await expect(verifyProtectedWorkflowProofMatrix(f.input, f.requirements, f.proofs)).rejects.toThrow('truncated');
    });
    it('rejects missing family/context red instead of letting one generic failure qualify', async () => {
      const f = await matrixFixture();
      await expect(verifyProtectedWorkflowProofMatrix(f.input, f.requirements, f.proofs.slice(0, -1))).rejects.toThrow('Each required context');
    });
  });
  it('retains invisible dispatch acceptance and never repeats it on retry', async () => {
    const f = await fixture(); f.transport.visible = false;
    expect(await executeWorkflowContextProof(f.input, f.transport.binding)).toMatchObject({ status: 'pending' });
    f.input.workflowObservationOnly = true;
    expect(await executeWorkflowContextProof(f.input, f.transport.binding)).toMatchObject({ status: 'pending' });
    f.transport.visible = true;
    expect(await executeWorkflowContextProof(f.input, f.transport.binding)).toMatchObject({ status: 'completed' });
    expect(f.transport.writes).toHaveLength(1);
  });
  it('preserves pre-dispatch intent on an uncertain transport failure', async () => {
    const f = await fixture(); f.transport.rejectDispatch = true;
    await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow();
    expect(f.checkpoints).toHaveLength(1);
    f.transport.rejectDispatch = false;
    expect(await executeWorkflowContextProof(f.input, f.transport.binding)).toMatchObject({ status: 'completed' });
    expect(f.transport.writes).toHaveLength(1);
  });
  it('restores an actual accepted handle from disk after failed metadata reads without reposting', async () => {
    const f = await fixture(), checkpointPath = path.join(f.root, 'workflow-checkpoint.json');
    f.transport.dispatchResponse = { status: 200, headers: {}, data: {
      workflow_run_id: 901, run_url: 'https://api.github.com/repos/owner/repo/actions/runs/901',
      html_url: 'https://github.com/owner/repo/actions/runs/901'
    } };
    f.input.recordWorkflowDispatch = async checkpoint => {
      await writeFile(checkpointPath, JSON.stringify(checkpoint), { mode: 0o600 });
    };
    const original = f.transport.request.bind(f.transport);
    const request = vi.spyOn(f.transport, 'request').mockImplementation(async input => {
      if (input.path.endsWith('/actions/runs/901')) throw new Error('secret provider diagnostics');
      return original(input);
    });
    await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.not.toThrow('secret');
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as WorkflowProofCheckpoint;
    expect(checkpoint).toMatchObject({ stage: 'accepted', runId: 901 });
    request.mockRestore();
    f.input.workflowCheckpoint = checkpoint;
    f.input.workflowObservationOnly = true;
    expect(await executeWorkflowContextProof(f.input, f.transport.binding)).toMatchObject({ status: 'completed' });
    expect(f.transport.writes).toHaveLength(1);
  });
  it('observes documented API200 dispatch and actual proof readback through bounded localhost HTTP', async () => {
    const f = await fixture();
    f.transport.dispatchResponse = { status: 200, headers: {}, data: {
      workflow_run_id: 901, run_url: 'https://api.github.com/repos/owner/repo/actions/runs/901',
      html_url: 'https://github.com/owner/repo/actions/runs/901'
    } };
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const actual = await f.transport.request({
        method: request.method === 'POST' ? 'POST' : 'GET', path: request.url!,
        ...(bytes.length ? { body: JSON.parse(bytes.toString('utf8')) } : {})
      });
      response.writeHead(actual.status, { 'content-type': 'application/json', ...actual.headers });
      response.end(JSON.stringify(actual.data));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Isolated HTTP fixture did not bind.');
    f.input.adapters = { githubActivation: { transport: {
      async request(request) {
        return new Promise<GitHubResponse>((resolve, reject) => {
          const outgoing = httpRequest(`http://127.0.0.1:${address.port}${request.path}`, {
            method: request.method, signal: AbortSignal.timeout(1000), agent: false
          }, response => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on('error', reject);
            response.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 1024 * 1024) {
                response.destroy(new Error('The isolated HTTP fixture response exceeds its byte bound.'));
                return;
              }
              chunks.push(chunk);
            });
            response.on('end', () => {
              try {
                if (response.statusCode === undefined) throw new Error('The isolated HTTP fixture response has no status.');
                resolve({ status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers)
                  .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value ?? ''])),
                data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
              } catch (error) { reject(error); }
            });
          });
          outgoing.on('error', reject);
          outgoing.end(request.body === undefined ? undefined : JSON.stringify(request.body));
        });
      }
    } } };
    try {
      expect(await executeWorkflowContextProof(f.input, f.transport.binding)).toMatchObject({
        status: 'completed', checkpoint: { stage: 'terminal', runId: 901 }
      });
      expect(f.transport.writes).toHaveLength(1);
      expect(f.transport.writes[0]!.body).toMatchObject({ ref: f.transport.binding.executionRef });
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it.each(['dispatch-intent', 'accepted'] as const)('surfaces %s checkpoint failures without leaking diagnostics', async stage => {
    const f = await fixture();
    f.input.recordWorkflowDispatch = async checkpoint => {
      if (checkpoint.stage === stage) throw new Error('secret persistence diagnostics');
      f.input.workflowCheckpoint = checkpoint;
    };
    await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow('durably');
    expect(f.transport.writes).toHaveLength(stage === 'accepted' ? 1 : 0);
    if (stage === 'accepted') {
      f.input.recordWorkflowDispatch = async checkpoint => { f.input.workflowCheckpoint = checkpoint; };
      f.input.workflowObservationOnly = true;
      expect(await executeWorkflowContextProof(f.input, f.transport.binding)).toMatchObject({ status: 'completed' });
      expect(f.transport.writes).toHaveLength(1);
    }
  });
  it.each(['success', 'failure', 'cancelled', 'timed_out', 'neutral', 'skipped', 'action_required', 'unknown-outcome'])(
    'retains terminal provider %s before fallible proof inventory without repeat dispatch', async conclusion => {
      const f = await fixture();
      f.transport.runConclusion = conclusion;
      const original = f.transport.request.bind(f.transport);
      vi.spyOn(f.transport, 'request').mockImplementation(async input => {
        if (input.path.includes('/jobs')) throw new Error('secret jobs inventory diagnostics');
        return original(input);
      });
      await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow();
      const terminal = f.checkpoints.at(-1)!;
      expect(terminal).toMatchObject({
        stage: 'terminal', runId: 901, planDigest: f.input.plan.planDigest,
        terminalConclusion: conclusion === 'unknown-outcome' ? 'unknown' : conclusion,
        terminalConclusionDigest: canonicalSha256({ conclusion })
      });
      if (conclusion !== 'success') {
        expect(f.transport.calls.some(call => call.path.includes('/jobs'))).toBe(false);
      }
      f.input.workflowObservationOnly = true;
      await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow();
      expect(f.transport.writes).toHaveLength(1);
      expect(f.checkpoints.at(-1)).toEqual(terminal);
    });
  it('preserves actual terminal success when current source readback drifts', async () => {
    const f = await fixture();
    const original = f.transport.request.bind(f.transport);
    vi.spyOn(f.transport, 'request').mockImplementation(async input => {
      if (input.path.includes('/jobs')) f.transport.refSha = 'f'.repeat(40);
      return original(input);
    });
    await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow('ref moved');
    expect(f.checkpoints.at(-1)).toMatchObject({ stage: 'terminal', terminalConclusion: 'success', runId: 901 });
    f.input.workflowObservationOnly = true;
    await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow();
    expect(f.transport.writes).toHaveLength(1);
  });
  it.each(['missing-port', 'missing-lease', 'missing-authority', 'moved-ref', 'placeholder', 'changed-recipe'] as const)(
    'refuses %s before any provider write', async (reason) => {
      const f = await fixture();
      if (reason === 'missing-port') f.input.recordWorkflowDispatch = undefined;
      if (reason === 'missing-lease') f.input.lease = undefined;
      if (reason === 'missing-authority') f.input.inspection.approvals = [];
      if (reason === 'moved-ref') f.transport.refSha = 'f'.repeat(40);
      if (reason === 'placeholder') f.input.plan.operations[0]!.inputs = { repository: 'owner/repo' };
      if (reason === 'changed-recipe') f.transport.workflow += '# changed\n';
      await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow();
      expect(f.transport.writes).toEqual([]);
    });
  it.each(['skipped', 'neutral', 'cancelled', 'timed_out', 'action_required'])('does not accept %s as green', async (conclusion) => {
    const f = await fixture(); f.transport.runConclusion = conclusion;
    await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow('outcome');
  });
  it.each([
    { head_sha: 'f'.repeat(40) }, { head_branch: 'main' }, { run_attempt: 2 },
    { repository: { id: 456, full_name: 'elsewhere/repo' } }, { path: '.github/workflows/other.yml' },
    { created_at: '2020-01-01T00:00:00.000Z' }, { event: 'push' }
  ])('refuses foreign or stale actual run %j', async (overrides) => {
    const f = await fixture(); f.transport.runOverrides = overrides;
    await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow('identity');
  });
  it.each([
    { app: { id: 999, slug: 'caller-status-emitter' } }, { check_suite: { id: 999 } },
    { head_sha: 'f'.repeat(40) }, { name: 'Unrequired placeholder' }, { conclusion: 'neutral' }
  ])('refuses synthetic or unrelated check %j', async (overrides) => {
    const f = await fixture(); f.transport.checkOverrides = overrides;
    await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow('actual');
  });
  it('does not adopt ambiguous dispatches', async () => {
    const f = await fixture(); f.transport.ambiguous = true;
    await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow('Multiple');
    expect(f.checkpoints).toHaveLength(1);
    expect(f.transport.writes).toHaveLength(1);
  });
  it('proves controlled red with immutable unchanged recipe and the actual violated validator', async () => {
    const f = await fixture();
    f.transport.binding = { ...f.transport.binding, mode: 'controlled-red', violation: {
      path: 'backend/application.js', parentSha: 'b'.repeat(40),
      beforeDigest: workflowByteDigest(f.transport.before), afterDigest: workflowByteDigest(f.transport.after),
      context: 'Required validation'
    } };
    await reapprove(f);
    expect(await executeWorkflowContextProof(f.input, f.transport.binding)).toMatchObject({
      status: 'completed', proof: { conclusion: 'failure', contexts: [{ conclusion: 'failure', validationStep: 'Validate source' }] }
    });
  });
  it('rejects red caused by setup failure rather than the actual required validator', async () => {
    const f = await fixture();
    f.transport.binding = { ...f.transport.binding, mode: 'controlled-red', violation: {
      path: 'backend/application.js', parentSha: 'b'.repeat(40),
      beforeDigest: workflowByteDigest(f.transport.before), afterDigest: workflowByteDigest(f.transport.after), context: 'Required validation'
    } };
    f.transport.jobOverrides = { steps: [
      { name: 'Setup', status: 'completed', conclusion: 'failure' },
      { name: 'Validate source', status: 'completed', conclusion: 'skipped' }
    ] };
    await reapprove(f);
    await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow('validator');
  });
  it('requires every protected ref family rather than a single generic green/red pair', async () => {
    const f = await fixture();
    const result = await executeWorkflowContextProof(f.input, f.transport.binding);
    if (result.status !== 'completed') throw new Error('Fixture did not complete.');
    await expect(verifyProtectedWorkflowProofMatrix(f.input, {
      profile: 'single-maintainer-gitflow', sourceDigest: 'f'.repeat(64), files: [],
      integrations: { develop: {}, main: {}, release: {}, hotfix: {} },
      families: { develop: ['Required validation'], main: ['Required validation'], release: ['Required validation'], hotfix: ['Required validation'] }
    }, [result.proof])).rejects.toThrow();
  });
  it('applies a real observation deadline even to an injected hanging transport', async () => {
    const f = await fixture();
    f.input.adapters.githubActivation = { transport: { request: async () => new Promise(() => {}) } };
    vi.useFakeTimers();
    try {
      const rejected = expect(workflowRuntime(f.input).client.get('/repos/owner/repo')).rejects.toThrow('bounded');
      await vi.advanceTimersByTimeAsync(30_001);
      await rejected;
    } finally { vi.useRealTimers(); }
  });
  it.each(['develop', 'main', 'release', 'hotfix'] as const)('binds actual %s protected family, not a proof-only ref', (family) => {
    const ref = family === 'release' || family === 'hotfix' ? `${family}/1.2.3` : family;
    expect(validateWorkflowContextBinding({ ...binding(), family, ref }).family).toBe(family);
    expect(() => validateWorkflowContextBinding({ ...binding(), family, ref: 'ci/fake-proof' })).toThrow();
  });
  it('rejects fail-open recipes, mutable actions and omitted exact-SHA guards', () => {
    for (const change of [
      recipe().replace('timeout-minutes: 5', 'continue-on-error: true'),
      recipe().replace('run: node', 'if: false\n        run: node'),
      recipe().replace('github.sha == inputs.source_sha', 'true'),
      recipe().replace('run: node --check backend/application.js', 'uses: actions/checkout@main')
    ]) expect(() => validateContextWorkflow(Buffer.from(change), binding())).toThrow();
  });
  it.each(['missing-checkout', 'wrong-source', 'persisted-token', 'dirty-checkout', 'extra-job'] as const)(
    'blocks proof recipes with %s before dispatch', async scenario => {
      const f = await fixture(), value = JSON.parse(JSON.stringify({
        name: 'Other job', if: '${{ github.sha == inputs.source_sha && github.run_attempt == 1 }}'
      }));
      if (scenario === 'missing-checkout') f.transport.workflow = recipe().replace('name: Checkout reviewed source', 'name: Other setup');
      if (scenario === 'wrong-source') f.transport.workflow = recipe().replace('ref: ${{ inputs.source_sha }}', 'ref: main');
      if (scenario === 'persisted-token') f.transport.workflow = recipe().replace('persist-credentials: false', 'persist-credentials: true');
      if (scenario === 'dirty-checkout') f.transport.workflow = recipe().replace('clean: true', 'clean: false');
      if (scenario === 'extra-job') {
        f.transport.workflow = recipe() + stringify({ other: value }).split('\n').map(line => `  ${line}`).join('\n');
      }
      f.transport.binding.workflowDigest = workflowByteDigest(f.transport.workflow);
      await reapprove(f);
      await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow();
      expect(f.transport.writes).toEqual([]);
    });
  it.each([
    { rules: [{ type: 'update' }, { type: 'deletion' }, { type: 'unknown_rule' }] },
    { rules: [{ type: 'update' }, { type: 'deletion' }, null] },
    { conditions: { ref_name: { include: ['refs/tags/unknown-*'], exclude: [] } } }
  ])('does not hide incomplete effective admission behind a partial barrier %j', async change => {
    const f = await fixture(); f.transport.protectionOverrides = change;
    await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow();
    expect(f.transport.writes).toEqual([]);
  });
  it.each([
    { enforcement: 'evaluate' }, { bypass_actors: [{ actor_id: 15368, actor_type: 'Integration', bypass_mode: 'always' }] },
    { conditions: { ref_name: { include: ['refs/tags/liftoff-execution-*'], exclude: ['~ALL'] } } },
    { rules: [{ type: 'deletion' }] }
  ])('refuses dispatch without an actual immutable execution barrier %j', async (change) => {
    const f = await fixture(); f.transport.protectionOverrides = change;
    await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow('tag');
    expect(f.transport.writes).toEqual([]);
  });
  it('does not rely on a guarded original recipe when the execution tag points elsewhere', async () => {
    const f = await fixture(); f.transport.executionOverrides = { object: { type: 'commit', sha: 'f'.repeat(40) } };
    await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow('tag');
    expect(f.transport.writes).toEqual([]);
  });
  it('does not fall back to a mutable branch or undocumented SHA-dispatch support', async () => {
    const f = await fixture(); f.transport.binding.executionRef = 'develop';
    await expect(executeWorkflowContextProof(f.input, f.transport.binding)).rejects.toThrow();
    expect(f.transport.writes).toEqual([]);
  });
});

describe('per-file workflow source publication authority', () => {
  it('rejects directory-wide publication, protected pushes, changed bytes and secret-bearing source', () => {
    const publication: WorkflowPublicationBinding = {
      repository: 'owner/repo', repositoryId: 123, ref: 'ci/liftoff-workflows-reviewed',
      parentSha: 'a'.repeat(40), sourceTransmissionApproved: true,
      files: [{ path: '.github/workflows/proof.yml', beforeDigest: null,
        digest: workflowByteDigest(recipe()), content: recipe() }]
    };
    expect(validateWorkflowPublication(publication)).toEqual(publication);
    expect(() => validateWorkflowPublication({ ...publication, ref: 'develop' })).toThrow('Protected');
    expect(() => validateWorkflowPublication({ ...publication, files: [{ ...publication.files[0]!, path: '.github/workflows' }] })).toThrow();
    expect(() => validateWorkflowPublication({ ...publication, files: [{ ...publication.files[0]!, digest: 'f'.repeat(64) }] })).toThrow();
  });

  async function publicationFixture() {
    const f = await fixture();
    const branch = 'ci/liftoff-workflows-reviewed';
    const remote = path.join(scratch, `${counter}-bare.git`);
    const native = new NodeCommandRunner();
    async function git(args: string[], cwd = f.root) {
      const result = await native.run({ executable: 'git', args }, { cwd, env: environment, timeoutMs: 30_000 });
      if (result.status !== 0) throw new Error(`Isolated Git fixture failed: ${args[0]}`);
      return result.stdout;
    }
    await writeFile(path.join(f.root, '.gitignore'), 'governance/approvals/\n');
    await git(['init', `--initial-branch=${branch}`]);
    await git(['add', '.']); await git(['commit', '-m', 'Isolated source parent']);
    const parentSha = (await git(['rev-parse', 'HEAD'])).trim();
    await git(['init', '--bare', remote]);
    await git(['push', remote, `HEAD:refs/heads/${branch}`]);
    await git(['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
    const request: WorkflowPublicationBinding = {
      repository: 'owner/repo', repositoryId: 123, ref: branch, parentSha, sourceTransmissionApproved: true,
      files: [{ path: '.github/workflows/proof.yml', beforeDigest: null, digest: workflowByteDigest(recipe()), content: recipe() }]
    };
    const calls: ExternalCommand[] = [];
    let uncertainPush = false;
    const runner: CommandRunner = {
      async run(command, options) {
        calls.push(command);
        if (command.executable !== 'git') throw new Error('Only isolated literal Git fixture commands are allowed.');
        const args = command.args.includes('push')
          ? ['-c', `remote.origin.url=${remote}`, '-c', `remote.origin.pushurl=${remote}`, ...command.args] : command.args;
        const result = await native.run({ executable: 'git', args }, { ...options, env: { ...options?.env, ...environment } });
        if (uncertainPush && command.args.includes('push')) throw new Error('Uncertain isolated push acceptance');
        return result;
      }
    };
    const transport: GitHubActivationTransport = {
      async request(request) {
        let data: unknown;
        if (request.method !== 'GET') throw new Error('Publication HTTP readback is read-only.');
        if (request.path === '/repos/owner/repo') data = { id: 123, full_name: 'owner/repo' };
        else if (request.path.includes('/git/ref/')) data = {
          ref: `refs/heads/${branch}`, object: { sha: (await git(['--git-dir', remote, 'rev-parse', `refs/heads/${branch}`])).trim() }
        };
        else if (request.path.includes('/git/commits/')) {
          const sha = request.path.split('/').at(-1)!;
          const parents = (await git(['--git-dir', remote, 'rev-list', '--parents', '-n', '1', sha])).trim().split(' ').slice(1);
          data = { sha, parents: parents.map((sha) => ({ sha })),
            tree: { sha: (await git(['--git-dir', remote, 'rev-parse', `${sha}^{tree}`])).trim() } };
        } else if (request.path.includes('/contents/')) {
          const file = request.path.split('/contents/')[1]!.split('?')[0]!;
          const sha = new URL(`http://fixture${request.path}`).searchParams.get('ref')!;
          const content = await git(['--git-dir', remote, 'show', `${sha}:${file}`]);
          data = { type: 'file', path: file, encoding: 'base64', content: Buffer.from(content).toString('base64') };
        } else throw new Error('Unexpected publication endpoint.');
        return { status: 200, headers: {}, data };
      }
    };
    const server = createServer(async (incoming, response) => {
      try {
        const result = await transport.request({ method: 'GET', path: incoming.url! });
        response.writeHead(result.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result.data));
      } catch {
        response.writeHead(500); response.end('null');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local HTTP fixture did not start.');
    const phase = canonicalPhaseGraph.phases.find((phase) => phase.id === 'bootstrap-workflow-source-ready')!;
    const plan = { ...f.input.plan, phaseId: phase.id,
      operations: [workflowPlannedOperation(phase.id, 'git.workflow-source.publish-reviewed', request)]
    };
    const approval = await issuePriorApproval(f.root, f.input.inspection.state, plan);
    plan.approval = { ...plan.approval, gateKind: phase.approvalGate.kind, envelopeId: approval.id,
      envelopeHash: canonicalApprovalEnvelopeHash(approval) };
    const checkpoints: WorkflowPublicationCheckpoint[] = [];
    const input: WorkflowPublicationInput = {
      ...f.input, phase, plan, runner,
      inspection: { ...f.input.inspection, approvals: [approval] },
      adapters: { githubActivation: { transport: {
        async request(request) {
          const response = await fetch(`http://127.0.0.1:${address.port}${request.path}`, { redirect: 'error' });
          return { status: response.status, headers: {}, data: await response.json() };
        }
      } } },
      recordWorkflowPublication: async (checkpoint) => { checkpoints.push(checkpoint); input.publicationCheckpoint = checkpoint; }
    };
    return { input, request, calls, checkpoints, git, root: f.root,
      setUncertainPush() { uncertainPush = true; },
      close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
  }

  describe('actual bounded local Git and HTTP publication fixtures', () => {
    it('commits and fast-forward publishes only approved files and independently reads actual immutable bytes', async () => {
      const f = await publicationFixture();
      try {
        const proof = await executeWorkflowSourcePublication(f.input, f.request);
        expect(proof.parentSha).toBe(f.request.parentSha);
        expect(proof.commitSha).not.toBe(f.request.parentSha);
        expect(f.checkpoints.map((entry) => entry.stage)).toEqual(['writing', 'committed', 'push-intent', 'published']);
        expect(await readFile(path.join(f.root, '.github/workflows/proof.yml'), 'utf8')).toBe(recipe());
        expect(f.calls.filter((command) => command.args.includes('push'))).toHaveLength(1);
        expect(f.calls.some((command) => command.args.includes('--force'))).toBe(false);
      } finally { await f.close(); }
    });
    it('observes an uncertain accepted push without repeating any commit or push', async () => {
      const f = await publicationFixture();
      try {
        f.setUncertainPush();
        await expect(executeWorkflowSourcePublication(f.input, f.request)).rejects.toThrow();
        expect(f.input.publicationCheckpoint?.stage).toBe('push-intent');
        expect(await executeWorkflowSourcePublication(f.input, f.request)).toMatchObject({ kind: 'workflow-source-publication.v1' });
        expect(f.calls.filter((command) => command.args.includes('push'))).toHaveLength(1);
        expect(f.calls.filter((command) => command.args.includes('commit'))).toHaveLength(1);
      } finally { await f.close(); }
    });
    it('preserves developer-staged files without consuming them in a reviewed commit', async () => {
      const f = await publicationFixture();
      try {
        await writeFile(path.join(f.root, 'unrelated.txt'), 'developer-owned\n');
        await f.git(['add', '--', 'unrelated.txt']);
        await expect(executeWorkflowSourcePublication(f.input, f.request)).rejects.toThrow('unrelated');
        expect((await f.git(['diff', '--cached', '--name-only'])).trim()).toBe('unrelated.txt');
        expect(f.checkpoints).toEqual([]);
      } finally { await f.close(); }
    });
  });

  describe('source-derived protected context inventory', () => {
    it('preserves actual inherited-property context names and their pinned integrations as own data', () => {
      const source = rulesetSource();
      const ruleset = JSON.parse(source[0]!.content.toString('utf8'));
      const names = ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'];
      ruleset.rules[0].parameters.required_status_checks = names.map((context, index) => ({
        context, integration_id: 15368 + index
      }));
      source[0]!.content = Buffer.from(JSON.stringify(ruleset));
      const requirements = requiredWorkflowContextsFromSource(source, 'single-maintainer-gitflow');
      for (const family of ['develop', 'main', 'release', 'hotfix'] as const) {
        expect(requirements.families[family]).toEqual([...names].sort());
        expect(Object.keys(requirements.integrations[family]).sort()).toEqual([...names].sort());
        for (const [index, name] of names.entries()) {
          expect(Object.getOwnPropertyDescriptor(requirements.integrations[family], name))
            .toMatchObject({ value: 15368 + index, enumerable: true });
        }
      }
    });
    it.each(['toString', '__proto__'])('explicitly refuses inherited property %s as a protected ref pattern', pattern => {
      const source = rulesetSource();
      const ruleset = JSON.parse(source[0]!.content.toString('utf8'));
      ruleset.conditions.ref_name.include = [pattern];
      source[0]!.content = Buffer.from(JSON.stringify(ruleset));
      expect(() => requiredWorkflowContextsFromSource(source, 'single-maintainer-gitflow'))
        .toThrow('exact supported GitFlow families');
    });
    it('preserves zero-review single-maintainer and one-current-independent-human team minima', () => {
      expect(requiredWorkflowContextsFromSource(rulesetSource(), 'single-maintainer-gitflow').families.main).toEqual(['Required validation']);
      expect(() => requiredWorkflowContextsFromSource(rulesetSource(), 'team-gitflow')).toThrow('profile');
      expect(requiredWorkflowContextsFromSource(rulesetSource(1), 'team-gitflow').families.hotfix).toEqual(['Required validation']);
      expect(() => requiredWorkflowContextsFromSource(rulesetSource(2), 'team-gitflow')).toThrow('profile');
      expect(() => requiredWorkflowContextsFromSource(rulesetSource(1), 'single-maintainer-gitflow')).toThrow('profile');
    });
    it('refuses empty and malformed source rather than vacuously passing', () => {
      expect(() => requiredWorkflowContextsFromSource([], 'single-maintainer-gitflow')).toThrow();
      expect(() => requiredWorkflowContextsFromSource([{ path: 'governance/rulesets/branches.json',
        content: Buffer.from('{}') }], 'single-maintainer-gitflow')).toThrow();
    });
  });
  it('does not promote legacy local source authority into remote publication', async () => {
    const f = await fixture();
    const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'workflow-source-ready')!;
    const request: WorkflowPublicationBinding = {
      repository: 'owner/repo', repositoryId: 123, ref: 'ci/liftoff-workflows-reviewed',
      parentSha: 'a'.repeat(40), sourceTransmissionApproved: true,
      files: [{ path: '.github/workflows/proof.yml', beforeDigest: null, digest: workflowByteDigest(recipe()), content: recipe() }]
    };
    const input: WorkflowPublicationInput = { ...f.input, phase };
    await expect(executeWorkflowSourcePublication(input, request)).rejects.toThrow();
    expect(f.transport.writes).toEqual([]);
    expect(f.runner.calls.filter((command) => command.args.includes('commit') || command.args.includes('push'))).toEqual([]);
  });
});
