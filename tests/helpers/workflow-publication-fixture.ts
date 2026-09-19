import { createHash } from 'node:crypto';
import type { GitHubActivationTransport, GitHubRequest, GitHubResponse } from '../../src/adapters/github/activation-rest.js';
import { treeWithFiles, type GitTreeEntry } from '../../src/adapters/github/workflow-git-objects.js';
import type { CommandRunner } from '../../src/process-runner.js';

export const workflowFixtureNow = '2026-09-15T00:00:00.000Z';
export const workflowFixturePath = '.github/workflows/verify.yml';
export const workflowFixtureSource = [
  'name: Repository source',
  'permissions:',
  '  contents: read',
  'on:',
  '  pull_request:',
  '    branches: [develop]',
  'jobs:',
  '  node-tests:',
  '    name: Node source validation',
  '    runs-on: ubuntu-24.04',
  '    timeout-minutes: 5',
  '    steps:',
  '      - name: Checkout',
  `        uses: actions/checkout@${'a'.repeat(40)}`,
  '      - name: Validate source',
  '        run: node --test',
  ''
].join('\n');

export const dispatchFixtureSource = [
  'name: Recorded workflow',
  'run-name: liftoff-${{ inputs.liftoff_operation_id }}',
  'on:',
  '  workflow_dispatch:',
  '    inputs:',
  '      liftoff_operation_id:',
  '        type: string',
  '        required: true',
  '      environment:',
  '        type: string',
  '        required: true',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  verify:',
  '    name: Node source validation',
  '    runs-on: ubuntu-24.04',
  '    timeout-minutes: 5',
  '    steps:',
  '      - name: Validate source',
  '        run: node --test',
  ''
].join('\n');

export function sourceCheckFailureLog(fixtureFile: string): string {
  fixtureFile = fixtureFile.replace(/^(?:backend|frontend)\//u, '');
  return fixtureFile.endsWith('.py') ?
    `_______________ test_reviewed_liftoff_source_validation_control ________________\nE       AssertionError: assert 'controlled-invalid' == 'valid'\n${fixtureFile}:2: AssertionError\nFAILED ${fixtureFile}::test_reviewed_liftoff_source_validation_control\n1 failed in 0.01s\n` :
    fixtureFile.endsWith('.go') ?
      '--- FAIL: TestReviewedLiftoffSourceValidationControl (0.00s)\n    validation_test.go:7: reviewed controlled-invalid source-validation control\nFAIL example/test/liftoffcheck 0.01s\n' :
      fixtureFile.endsWith('.ts') ?
        ` FAIL ${fixtureFile} > reviewed Liftoff source-validation control\nAssertionError: expected 'controlled-invalid' to be 'valid'\n Tests 1 failed | 1 passed (2)\n` :
        `not ok 1 - reviewed Liftoff source-validation control\n  location: '${fixtureFile}:4:1'\n  code: 'ERR_ASSERTION'\n  actual: 'controlled-invalid'\n  expected: 'valid'\n# fail 1\n`;
}

function objectHash(type: string, bytes: Buffer | string) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
}

export class WorkflowGitHubFixture implements GitHubActivationTransport {
  readonly requests: GitHubRequest[] = [];
  readonly baseSha: string;
  readonly mainSha = 'b'.repeat(40);
  readonly blobs = new Map<string, Buffer>();
  readonly trees = new Map<string, GitTreeEntry[]>();
  readonly commits = new Map<string, Record<string, unknown>>();
  readonly refs = new Map<string, string>();
  readonly pullRequests = new Map<number, Record<string, any>>();
  readonly runs = new Map<number, Record<string, any>>();
  readonly jobs = new Map<number, Record<string, any>[]>();
  readonly checks = new Map<number, Record<string, any>>();
  readonly jobLogs = new Map<number, string>();
  readonly artifacts = new Map<number, { metadata: Record<string, unknown>; bytes: Buffer }>();
  repositoryId = 42;
  actorId = 7;
  actorLogin = 'owner';
  controls: Record<string, unknown>[] = [];
  branchRules: Record<string, unknown>[] = [];
  workflowVisible = true;
  workflowState = 'active';
  autoChecks = false;
  runStatus = 'completed';
  loseResponseFor: string | null = null;
  rejectRequestFor: string | null = null;
  beforeRequest?: (request: GitHubRequest) => Promise<void>;
  private requestCounter = 0;

  constructor(workflow = workflowFixtureSource, extraFiles: readonly { path: string; content: string }[] = [],
    sourceSha = 'a'.repeat(40), private readonly firstRunId = 100) {
    this.baseSha = sourceSha;
    const initialFiles = [
      { path: workflowFixturePath, content: workflow },
      { path: 'README.md', content: 'Unrelated project-owned bytes.\n' },
      { path: 'test/existing.test.mjs', content: "import test from 'node:test';\ntest('existing business behavior', () => {});\n" },
      ...extraFiles
    ].map((file) => {
      const blobSha = objectHash('blob', file.content);
      this.blobs.set(blobSha, Buffer.from(file.content));
      return { path: file.path, blobSha };
    });
    const tree = treeWithFiles([], initialFiles);
    this.trees.set(tree.sha, tree.entries);
    for (const sha of [this.baseSha, this.mainSha]) this.commits.set(sha, { sha, tree: { sha: tree.sha }, parents: [] });
    this.refs.set('develop', this.baseSha);
    this.refs.set('main', this.mainSha);
  }

  readonly runner: CommandRunner = {
    run: async (command, options) => {
      if (command.executable !== 'gh' || command.args[0] !== 'api') throw new Error('Fixture forbids every non-scoped provider command.');
      const args = command.args;
      const request: GitHubRequest = {
        method: args[args.indexOf('--method') + 1] as GitHubRequest['method'],
        path: args.find((arg) => arg.startsWith('/repos/') || arg === '/user')!,
        ...(args.some((arg) => /\/actions\/jobs\/[1-9][0-9]*\/logs$/u.test(arg)) ? { text: true } : {}),
        ...(options?.stdin === undefined ? {} : { body: JSON.parse(String(options.stdin)) })
      };
      try {
        const response = await this.request(request);
        return { command, status: response.status >= 400 ? 1 : 0, signal: null, timedOut: false,
          stdout: `HTTP/2 ${response.status}\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n${request.text ? response.data : JSON.stringify(response.data)}`,
          stderr: '', displayCommand: 'fixture scoped GitHub protocol' };
      } catch {
        return { command, status: null, signal: null, timedOut: true, stdout: '', stderr: '', displayCommand: 'fixture lost response' };
      }
    }
  };

  async request(request: GitHubRequest): Promise<GitHubResponse> {
    this.requests.push(structuredClone(request));
    await this.beforeRequest?.(request);
    const key = `${request.method} ${request.path.split('?')[0]}`;
    if (this.rejectRequestFor === key) return {
      status: 403, headers: { 'x-github-request-id': `PROVIDER-${++this.requestCounter}` }, data: { message: 'fixture rejection' }
    };
    const response = this.respond(request);
    if (this.loseResponseFor === key) {
      this.loseResponseFor = null;
      throw new Error('Simulated response loss after provider effect.');
    }
    return response;
  }

  private respond(request: GitHubRequest): GitHubResponse {
    const url = new URL(`https://api.github.com${request.path}`);
    const endpoint = url.pathname;
    const root = '/repos/owner/repo';
    const body = request.body as Record<string, any>;
    const ok = (data: unknown, status = 200): GitHubResponse => ({
      status, headers: { 'x-github-request-id': `PROVIDER-${++this.requestCounter}` }, data
    });
    const missing = () => ok({ message: 'Not found in bounded local fixture' }, 404);
    if (request.method === 'GET') {
      if (endpoint === '/user') return ok({ id: this.actorId, login: this.actorLogin });
      if (endpoint === root) return ok({ id: this.repositoryId, full_name: 'owner/repo', default_branch: 'develop',
        archived: false, disabled: false, permissions: { admin: false, push: true } });
      if (endpoint === `${root}/rulesets`) return ok(this.controls);
      if (endpoint === `${root}/rules/branches/develop` || endpoint === `${root}/rules/branches/main`) return ok(this.branchRules);
      if (endpoint.startsWith(`${root}/rulesets/`)) return ok(this.controls.find((control) => control.id === Number(endpoint.split('/').at(-1))));
      if (endpoint.endsWith('/protection')) return missing();
      if (endpoint.startsWith(`${root}/git/ref/heads/`)) {
        const ref = endpoint.slice(`${root}/git/ref/heads/`.length);
        return this.refs.has(ref) ? ok({ ref: `refs/heads/${ref}`, node_id: `REF_${Buffer.from(ref).toString('base64url')}`,
          object: { type: 'commit', sha: this.refs.get(ref) } }) : missing();
      }
      if (endpoint.startsWith(`${root}/git/commits/`)) return this.commits.has(endpoint.split('/').at(-1)!) ?
        ok(this.commits.get(endpoint.split('/').at(-1)!)) : missing();
      if (endpoint.startsWith(`${root}/git/trees/`)) {
        const sha = endpoint.split('/').at(-1)!;
        return this.trees.has(sha) ? ok({ sha, truncated: false, tree: this.trees.get(sha) }) : missing();
      }
      if (endpoint.startsWith(`${root}/contents/`)) {
        const path = endpoint.slice(`${root}/contents/`.length);
        const commit = this.commits.get(url.searchParams.get('ref')!);
        const tree = commit ? this.trees.get((commit.tree as { sha: string }).sha) : undefined;
        const file = tree?.find((entry) => entry.path === path && entry.type === 'blob');
        const bytes = file ? this.blobs.get(file.sha) : undefined;
        return file && bytes ? ok({ type: 'file', path, sha: file.sha, encoding: 'base64', content: bytes.toString('base64'), size: bytes.length }) : missing();
      }
      if (endpoint === `${root}/pulls`) {
        const head = url.searchParams.get('head')?.split(':')[1];
        return ok([...this.pullRequests.values()].filter((pr) => !head || pr.head.ref === head));
      }
      if (endpoint.startsWith(`${root}/pulls/`)) return this.pullRequests.has(Number(endpoint.split('/').at(-1))) ?
        ok(this.pullRequests.get(Number(endpoint.split('/').at(-1)))) : missing();
      if (endpoint === `${root}/actions/workflows/verify.yml` || endpoint === `${root}/actions/workflows/4`) {
        return this.workflowVisible ? ok({ id: 4, path: workflowFixturePath, state: this.workflowState, name: 'Repository source' }) : missing();
      }
      if (endpoint === `${root}/actions/workflows/4/runs`) {
        const list = [...this.runs.values()].filter((run) =>
          (!url.searchParams.has('head_sha') || run.head_sha === url.searchParams.get('head_sha')) &&
          (!url.searchParams.has('event') || run.event === url.searchParams.get('event')) &&
          (!url.searchParams.has('branch') || run.head_branch === url.searchParams.get('branch')));
        return ok({ total_count: list.length, workflow_runs: list });
      }
      const jobs = /^\/repos\/owner\/repo\/actions\/runs\/(\d+)\/attempts\/1\/jobs$/u.exec(endpoint);
      if (jobs) return ok({ total_count: this.jobs.get(Number(jobs[1]))?.length ?? 0, jobs: this.jobs.get(Number(jobs[1])) ?? [] });
      const logs = /^\/repos\/owner\/repo\/actions\/jobs\/(\d+)\/logs$/u.exec(endpoint);
      if (logs && request.text) return this.jobLogs.has(Number(logs[1])) ? {
        ...ok(this.jobLogs.get(Number(logs[1]))!), headers: { 'content-type': 'text/plain' }
      } : missing();
      const run = /^\/repos\/owner\/repo\/actions\/runs\/(\d+)(?:\/attempts\/1)?$/u.exec(endpoint);
      if (run) return this.runs.has(Number(run[1])) ? ok(this.runs.get(Number(run[1]))) : missing();
      const check = /^\/repos\/owner\/repo\/check-runs\/(\d+)$/u.exec(endpoint);
      if (check) return this.checks.has(Number(check[1])) ? ok(this.checks.get(Number(check[1]))) : missing();
      const checkList = /^\/repos\/owner\/repo\/commits\/([a-f0-9]{40})\/check-runs$/u.exec(endpoint);
      if (checkList) {
        const list = [...this.checks.values()].filter((entry) => entry.head_sha === checkList[1]);
        return ok({ total_count: list.length, check_runs: list });
      }
      const artifact = /^\/repos\/owner\/repo\/actions\/artifacts\/(\d+)(\/zip)?$/u.exec(endpoint);
      if (artifact) {
        const value = this.artifacts.get(Number(artifact[1]));
        return value ? ok(artifact[2] ? value.bytes : value.metadata) : missing();
      }
      return missing();
    }
    if (request.method !== 'POST') throw new Error('Fixture forbids ref updates, merges, settings writes, deletes, releases and tags.');
    if (endpoint === `${root}/git/trees`) {
      const files = body.tree.map((entry: { path: string; content: string }) => {
        const sha = objectHash('blob', entry.content);
        this.blobs.set(sha, Buffer.from(entry.content));
        return { path: entry.path, blobSha: sha };
      });
      const tree = treeWithFiles(this.trees.get(body.base_tree)!, files);
      this.trees.set(tree.sha, tree.entries);
      return ok({ sha: tree.sha, tree: tree.entries }, 201);
    }
    if (endpoint === `${root}/git/commits`) {
      const signature = (who: Record<string, any>) => `${who.name} <${who.email}> ${Date.parse(who.date) / 1000} +0000`;
      const bytes = `tree ${body.tree}\n${body.parents.map((sha: string) => `parent ${sha}\n`).join('')}author ${signature(body.author)}\ncommitter ${signature(body.committer)}\n\n${body.message}`;
      const sha = objectHash('commit', bytes);
      const commit = { sha, tree: { sha: body.tree }, parents: body.parents.map((parent: string) => ({ sha: parent })) };
      this.commits.set(sha, commit);
      return ok(commit, 201);
    }
    if (endpoint === `${root}/git/refs`) {
      const ref = String(body.ref).slice('refs/heads/'.length);
      if (!/^(?:automation|feature)\//u.test(ref) || this.refs.has(ref)) return ok({}, 422);
      this.refs.set(ref, body.sha);
      return ok({ ref: body.ref, node_id: `REF_${Buffer.from(ref).toString('base64url')}`, object: { type: 'commit', sha: body.sha } }, 201);
    }
    if (endpoint === `${root}/pulls`) {
      const number = this.pullRequests.size + 1;
      const repo = { id: this.repositoryId, full_name: 'owner/repo' };
      const pr = { number, id: number + 100, state: 'open', merged: false, merge_commit_sha: null,
        draft: body.draft ?? false, user: { id: this.actorId, login: this.actorLogin }, body: body.body,
        head: { ref: body.head, sha: this.refs.get(body.head), repo },
        base: { ref: body.base, sha: this.refs.get(body.base), repo } };
      this.pullRequests.set(number, pr);
      if (this.autoChecks) this.addRun(body.head, 'pull_request', undefined, pr);
      return ok(pr, 201);
    }
    if (endpoint === `${root}/actions/workflows/4/dispatches`) {
      const run = this.addRun(body.ref, 'workflow_dispatch', body.inputs.liftoff_operation_id);
      return ok({ workflow_run_id: run.id, run_url: `https://api.github.com${root}/actions/runs/${run.id}`,
        html_url: `https://github.com/owner/repo/actions/runs/${run.id}` });
    }
    throw new Error(`Unimplemented or unsafe provider effect: ${endpoint}`);
  }

  addRun(ref: string, event = 'workflow_dispatch', correlationId?: string, pr?: Record<string, any>) {
    const id = this.firstRunId + this.runs.size;
    const sha = this.refs.get(ref)!;
    const tree = this.trees.get((this.commits.get(sha)!.tree as { sha: string }).sha)!;
    const fixtureFiles = tree.filter((entry) => /liftoff-repository-check\.test\.[mt]js|liftoff-repository-check\.test\.ts|test_liftoff_repository_check\.py|liftoffcheck\/validation_test\.go/u.test(entry.path));
    const negative = fixtureFiles.some((file) => /assert\.equal\('controlled-invalid'|expect\('controlled-invalid'|assert 'controlled-invalid'|if "controlled-invalid"/u.test(this.blobs.get(file.sha)!.toString()));
    const conclusion = negative ? 'failure' : 'success';
    const run: Record<string, any> = {
      id, run_attempt: 1, workflow_id: 4, path: workflowFixturePath, head_sha: sha, head_branch: ref, event,
      actor: { id: this.actorId }, triggering_actor: { id: this.actorId },
      repository: { id: this.repositoryId, full_name: 'owner/repo' },
      created_at: workflowFixtureNow, display_title: correlationId ? `liftoff-${correlationId}` : 'Repository source',
      status: this.runStatus, conclusion: this.runStatus === 'completed' ? conclusion : null,
      check_suite_id: id * 1000,
      pull_requests: pr ? [{ number: pr.number, head: { sha: pr.head.sha }, base: { sha: pr.base.sha } }] : []
    };
    const job = {
      id: id * 10, run_id: id, head_sha: sha, name: 'Node source validation', status: this.runStatus,
      conclusion: this.runStatus === 'completed' ? conclusion : null, runner_id: 22,
      check_run_url: `https://api.github.com/repos/owner/repo/check-runs/${id * 100}`,
      steps: [
        { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
        { number: 2, name: 'Checkout', status: 'completed', conclusion: 'success' },
        { number: 3, name: 'Validate source', status: 'completed', conclusion },
        { number: 4, name: 'Complete job', status: 'completed', conclusion: 'success' }
      ]
    };
    this.runs.set(id, run);
    this.jobs.set(id, [job]);
    const fixtureFile = fixtureFiles[0]?.path ?? '';
    this.jobLogs.set(job.id, negative ? sourceCheckFailureLog(fixtureFile) : 'All tests passed\n');
    this.checks.set(id * 100, { id: id * 100, name: job.name, head_sha: sha, status: 'completed', conclusion,
      app: { id: 15368, slug: 'github-actions' }, check_suite: { id: run.check_suite_id },
      output: { summary: negative ? 'ERR_ASSERTION controlled-invalid in reviewed Liftoff source-validation control' : 'All real tests passed' } });
    return run;
  }

  merge(number: number) {
    const pr = this.pullRequests.get(number)!;
    const head = this.commits.get(pr.head.sha)!;
    const sha = objectHash('commit', `fixture provider merge ${pr.base.sha} ${pr.head.sha}`);
    this.commits.set(sha, { sha, tree: head.tree, parents: [{ sha: pr.base.sha }, { sha: pr.head.sha }] });
    this.refs.set(pr.base.ref, sha);
    Object.assign(pr, { state: 'closed', merged: true, merged_by: { id: this.actorId }, merge_commit_sha: sha });
    return sha;
  }
}
