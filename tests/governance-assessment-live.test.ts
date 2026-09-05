import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';
import { collectLiveAssessment } from '../src/governance-assessment/live.js';
import { LiveTransport } from '../src/governance-assessment/live-transport.js';
import { assessmentLimits, type AzureAssessmentBinding, type LiveAssessmentScope } from '../src/governance-assessment/types.js';

const base = 'https://api.github.com/repos/octo-org/policy';
const actionsAppUrl = 'https://api.github.com/apps/github-actions';
const commit = 'a'.repeat(40);
const capturedAt = '2026-09-05T00:00:00.000Z';
const now = () => new Date(capturedAt);
const token = `github_pat_${'q'.repeat(40)}`;
const sub = '11111111-1111-1111-1111-111111111111';
const otherSub = '22222222-2222-2222-2222-222222222222';
const armRoot = `/subscriptions/${sub}/resourceGroups/foundation/providers`;

function scope(overrides: Partial<LiveAssessmentScope> = {}): LiveAssessmentScope {
  return {
    repository: { owner: 'octo-org', name: 'policy', id: 'R_fixture' },
    refs: ['develop'], environments: ['staging'], runner: null, azure: [], ...overrides
  };
}

function repository() {
  return {
    id: 42, node_id: 'R_fixture', full_name: 'octo-org/policy', default_branch: 'develop',
    security_and_analysis: {
      secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' }
    }
  };
}

function ruleset(rulesetId = 1) {
  return {
    id: rulesetId, name: `Protection ${rulesetId}`, target: 'branch', enforcement: 'active',
    source_type: 'Repository', source: 'octo-org/policy',
    conditions: { ref_name: { include: ['refs/heads/develop', 'refs/heads/main'], exclude: [] } },
    bypass_actors: [{ actor_id: 7, actor_type: 'Integration', bypass_mode: 'always' }],
    rules: [
      { type: 'deletion' },
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [{ context: 'Governance', integration_id: 7 }],
          strict_required_status_checks_policy: true, do_not_enforce_on_create: true
        }
      },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0, dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false, require_last_push_approval: false,
          required_review_thread_resolution: true, allowed_merge_methods: ['squash']
        }
      }
    ]
  };
}

function check(checkId = 1, name = 'Governance') {
  return {
    id: checkId, name, head_sha: commit, app: { id: 7, slug: 'github-actions' },
    status: 'completed', conclusion: 'success'
  };
}

function environment(name = 'staging') {
  return {
    id: name === 'staging' ? 1 : 2, name, protection_rules: [],
    deployment_branch_policy: { protected_branches: true, custom_branch_policies: false }
  };
}

function inventoryUrl(suffix: string, page = 1, parameters: Record<string, string> = {}): string {
  const url = new URL(`${base}${suffix}`);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  url.searchParams.set('per_page', '100');
  url.searchParams.set('page', String(page));
  return url.href;
}

const rulesetsUrl = (page = 1) => inventoryUrl('/rulesets', page, { includes_parents: 'true' });
const checksUrl = (page = 1) => inventoryUrl(`/commits/${commit}/check-runs`, page, { filter: 'latest' });
const environmentsUrl = (page = 1) => inventoryUrl('/environments', page);
const workflowsUrl = (page = 1) => inventoryUrl('/actions/workflows', page);
const branchUrl = `${base}/branches/develop`;

interface Reply {
  value?: unknown;
  httpStatus?: number;
  exitCode?: number | null;
  stderr?: string;
  raw?: string;
  timedOut?: boolean;
  outputLimitExceeded?: boolean;
  errorCode?: string;
  errorMessage?: string;
  headers?: Record<string, string>;
  thrown?: unknown;
}
type Handler = Reply | ((count: number) => Reply);

class FixtureRunner implements CommandRunner {
  calls: Array<{ command: ExternalCommand; options: RunCommandOptions; url: string }> = [];
  responses = new Map<string, Handler>();
  unexpected: string[] = [];
  onCall?: () => void;
  private counts = new Map<string, number>();

  set(url: string, handler: Handler): this {
    this.responses.set(url, handler);
    return this;
  }

  private defaults(url: URL): Reply {
    if (url.href === base) return { value: repository() };
    if (url.href === actionsAppUrl) return { value: { id: 7, slug: 'github-actions' } };
    if (url.pathname.endsWith('/rulesets')) return { value: [{ id: 1 }] };
    const ruleId = /\/rulesets\/(\d+)$/u.exec(url.pathname)?.[1];
    if (ruleId) return { value: ruleset(Number(ruleId)) };
    if (url.pathname.includes('/rules/branches/')) return { value: [] };
    const branch = /\/branches\/([^/]+)$/u.exec(url.pathname)?.[1];
    if (branch) return { value: { name: decodeURIComponent(branch), commit: { sha: commit }, protected: false } };
    if (url.pathname.endsWith('/check-runs')) return { value: { total_count: 1, check_runs: [check()] } };
    if (url.pathname.endsWith('/environments')) return { value: { total_count: 1, environments: [environment()] } };
    if (url.pathname.endsWith('/actions/workflows')) return {
      value: { total_count: 1, workflows: [{ id: 8, name: 'Governance', path: '.github/workflows/check.yml', state: 'active' }] }
    };
    this.unexpected.push(url.href);
    return { httpStatus: 500 };
  }

  async run(command: ExternalCommand, options: RunCommandOptions = {}): Promise<CommandResult> {
    const endpoint = command.executable === 'gh' ? command.args.at(-1)! : command.args[command.args.indexOf('--url') + 1]!;
    this.calls.push({ command, options, url: endpoint });
    this.onCall?.();
    const count = (this.counts.get(endpoint) ?? 0) + 1;
    this.counts.set(endpoint, count);
    const handler = this.responses.get(endpoint);
    const reply = typeof handler === 'function' ? handler(count) : handler ?? this.defaults(new URL(endpoint));
    if (reply.thrown !== undefined) throw reply.thrown;
    const httpStatus = reply.httpStatus ?? 200;
    const body = JSON.stringify(reply.value ?? { message: 'Fixture failure' });
    const headers = Object.entries(reply.headers ?? {}).map(([key, value]) => `${key}: ${value}\r\n`).join('');
    const stdout = reply.raw ?? (command.executable === 'gh'
      ? `HTTP/2.0 ${httpStatus} Fixture\r\n${headers}\r\n${body}` : body);
    return {
      command, displayCommand: 'fixture',
      status: reply.exitCode === undefined ? httpStatus >= 200 && httpStatus < 300 ? 0 : 1 : reply.exitCode,
      signal: null, stdout, stderr: reply.stderr ?? (httpStatus >= 300 ? `Fixture (HTTP ${httpStatus})` : ''),
      timedOut: reply.timedOut ?? false, outputLimitExceeded: reply.outputLimitExceeded,
      errorCode: reply.errorCode, errorMessage: reply.errorMessage
    };
  }
}

async function collect(input = scope(), runner = new FixtureRunner()) {
  const result = await collectLiveAssessment(input, { runner, now });
  expect(runner.unexpected).toEqual([]);
  return result;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('bounded, read-only GitHub assessment', () => {
  it('verifies repository identity first and returns only normalized metadata with provenance', async () => {
    const runner = new FixtureRunner();
    const result = await collect(scope(), runner);
    expect(runner.calls[0]!.url).toBe(base);
    expect(result.observations['github.repository']).toMatchObject({
      availability: 'observed', value: { id: 42, nodeId: 'R_fixture', fullName: 'octo-org/policy', defaultBranch: 'develop' },
      source: { kind: 'github', location: base, capturedAt, digest: expect.stringMatching(/^[a-f0-9]{64}$/u) }
    });
    expect(result.observations['github.actions-app']).toMatchObject({
      availability: 'observed', value: { id: 7, slug: 'github-actions' },
      source: { kind: 'github', location: actionsAppUrl, capturedAt }
    });
    expect(result.observations['github.rulesets']!.value).toEqual([{
      ...ruleset(), rules: expect.arrayContaining(ruleset().rules)
    }]);
    expect(result.observations['github.branches']!.value).toEqual([
      { name: 'develop', sha: commit, protected: false, protection: null, protectionObserved: true }
    ]);
    expect(result.observations['github.checks']!.value).toEqual([
      { ref: 'develop', name: 'develop', sha: commit, checks: [{ name: 'Governance', appId: 7, appSlug: 'github-actions', status: 'completed', conclusion: 'success' }] }
    ]);
    expect(result.observations['github.checks.develop']!.source?.revision).toBe(commit);
    expect(result.observations['github.environments']!.value).toEqual([{
      name: 'staging', reviewers: 0, deploymentBranchPolicy: { protected_branches: true, custom_branch_policies: false }
    }]);
    expect(result.observations['github.workflows']!.value).toEqual([
      { id: 8, name: 'Governance', path: '.github/workflows/check.yml', state: 'active' }
    ]);
    expect(result.observations['github.security']!.value).toEqual(repository().security_and_analysis);
    expect(runner.calls.filter((call) => call.url === branchUrl)).toHaveLength(2);
    expect(result.refsStable).toBe(true);
  });

  it('uses literal pinned GET commands, suppresses ambient repository/host selection and never mutates the input', async () => {
    vi.stubEnv('GH_REPO', 'foreign/other');
    vi.stubEnv('GH_HOST', 'foreign.example');
    vi.stubEnv('GH_DEBUG', 'api');
    const input = scope({ refs: ['refs/heads/develop', 'release/1.0'] });
    const before = JSON.stringify(input);
    Object.freeze(input.refs);
    Object.freeze(input.environments);
    Object.freeze(input.repository);
    Object.freeze(input);
    const runner = new FixtureRunner();
    await collect(input, runner);
    expect(JSON.stringify(input)).toBe(before);
    for (const { command, options, url } of runner.calls) {
      expect(command.executable).toBe('gh');
      expect(command.args.slice(0, 5)).toEqual(['api', '--method', 'GET', '--hostname', 'github.com']);
      expect(command.args).toContain('X-GitHub-Api-Version: 2022-11-28');
      expect(command.args).toContain('Accept: application/vnd.github+json');
      expect(command.args).toContain('--include');
      expect(command.args.join(' ')).not.toMatch(/--(?:field|raw-field|input)|\b(?:POST|PUT|PATCH|DELETE|login|install|dispatch)\b/u);
      expect(url.startsWith(`${base}/`) || url === base || url === actionsAppUrl).toBe(true);
      expect(new URL(url).origin).toBe('https://api.github.com');
      expect(new URL(url).pathname).not.toMatch(/^\/api\/v3(?:\/|$)/u);
      expect(options).toMatchObject({
        stream: false, maxOutputBytes: assessmentLimits.responseBytes,
        env: { GH_REPO: '', GH_HOST: 'github.com', GH_DEBUG: '', GH_PROMPT_DISABLED: '1' }
      });
      expect(options.timeoutMs).toBeGreaterThan(0);
      expect(options.timeoutMs).toBeLessThanOrEqual(assessmentLimits.requestTimeoutMs);
    }
    expect(runner.calls.some((call) => call.url.includes('/branches/release%2F1.0'))).toBe(true);
  });

  it.each([7, 981234])('resolves Actions application ID %s at runtime from only the fixed public endpoint', async (appId) => {
    const runner = new FixtureRunner().set(actionsAppUrl, {
      value: {
        id: appId, slug: 'github-actions', name: 'GitHub Actions', client_secret: token,
        html_url: 'https://foreign.example/another-app', external_url: 'https://hooks.slack.com/services/PRIVATE/SECRET'
      }
    });
    const result = await collect(scope(), runner);
    expect(result.observations['github.actions-app']).toMatchObject({
      availability: 'observed', value: { id: appId, slug: 'github-actions' },
      source: { location: actionsAppUrl, revision: null, capturedAt }
    });
    expect(runner.calls[0]!.url).toBe(base);
    const appCalls = runner.calls.filter((call) => new URL(call.url).pathname.startsWith('/apps/'));
    expect(appCalls).toHaveLength(1);
    expect(appCalls[0]!.command.args).toEqual([
      'api', '--method', 'GET', '--hostname', 'github.com',
      '--header', 'Accept: application/vnd.github+json',
      '--header', 'X-GitHub-Api-Version: 2022-11-28', '--include', actionsAppUrl
    ]);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('foreign.example');
  });

  it.each([
    { httpStatus: 403 },
    { httpStatus: 404 },
    { value: { id: 7, slug: 'other-application' } },
    { value: { id: 7 } },
    { value: { id: 0, slug: 'github-actions' } },
    { value: { id: 7, slug: token } },
    { raw: `HTTP/2.0 200 OK\r\n\r\n{"id":7,"slug":"${token}` },
    { value: { id: 7, slug: 'github-actions' }, headers: { Link: '<https://foreign.example/other>; rel="next"' } }
  ] satisfies Reply[])('leaves failed or mismatched Actions app identity unobserved without a hard-coded fallback: %j', async (reply) => {
    const runner = new FixtureRunner().set(actionsAppUrl, reply);
    const result = await collect(scope(), runner);
    expect(result.observations['github.actions-app']).toMatchObject({ availability: 'not-observed', value: null });
    expect(result.observations['github.checks']!.availability).toBe('observed');
    expect(result.diagnostics.some((entry) => entry.source === 'github.actions-app')).toBe(true);
    expect(runner.calls.filter((call) => call.url === actionsAppUrl)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('foreign.example');
  });

  it.each([
    { app: { id: 7 }, metadata: { appId: 7 } },
    { app: { id: 7, slug: null }, metadata: { appId: 7 } },
    { app: null, metadata: { appId: null } },
    { app: { id: 88, slug: 'other-ci' }, metadata: { appId: 88, appSlug: 'other-ci' } }
  ])('retains only an available check-run app slug without inferring GitHub Actions identity', async ({ app, metadata }) => {
    const runner = new FixtureRunner().set(checksUrl(), {
      value: { total_count: 1, check_runs: [{ ...check(), app }] }
    });
    const result = await collect(scope(), runner);
    expect(result.observations['github.checks']!.value).toEqual([{
      ref: 'develop', name: 'develop', sha: commit,
      checks: [{ name: 'Governance', ...metadata, status: 'completed', conclusion: 'success' }]
    }]);
  });

  it('withholds sensitive check-run app slugs without losing the independent public app observation', async () => {
    const runner = new FixtureRunner().set(checksUrl(), {
      value: { total_count: 1, check_runs: [{ ...check(), app: { id: 7, slug: token } }] }
    });
    const result = await collect(scope(), runner);
    expect(result.observations['github.checks']!.availability).toBe('not-observed');
    expect(result.observations['github.actions-app']!.availability).toBe('observed');
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it.each([
    { owner: 'octo-org', name: '../other', id: 'R_fixture' },
    { owner: 'other/../octo-org', name: 'policy', id: 'R_fixture' },
    { owner: 'https://foreign.example', name: 'policy', id: null },
    { owner: 'octo-org', name: 'policy?method=DELETE', id: 'R_fixture' },
    { owner: 'octo-org', name: 'policy', id: 'arbitrary-identity' }
  ])('rejects unsafe repository scope before invoking any tool: %j', async (repository) => {
    const runner = new FixtureRunner();
    const result = await collect(scope({ repository }), runner);
    expect(runner.calls).toHaveLength(0);
    expect(Object.values(result.observations).every((value) => value.availability === 'not-observed')).toBe(true);
  });

  it.each([
    { full_name: 'other/repository' }, { id: 999 }, { node_id: 'R_other' }
  ])('withholds all dependent reads when resolved identity disagrees: %j', async (mismatch) => {
    const runner = new FixtureRunner().set(base, { value: { ...repository(), ...mismatch } });
    const expected = 'id' in mismatch ? '42' : 'R_fixture';
    const result = await collect(scope({ repository: { owner: 'octo-org', name: 'policy', id: expected } }), runner);
    expect(runner.calls).toHaveLength(1);
    expect(result.observations['github.repository']!.availability).toBe('not-observed');
    expect(result.diagnostics.some((entry) => entry.code === 'live-repository-identity')).toBe(true);
  });

  it('accepts an exact numeric repository ID and omits unavailable security fields rather than fabricating disabled', async () => {
    const runner = new FixtureRunner().set(base, { value: { ...repository(), security_and_analysis: undefined } });
    const result = await collect(scope({ repository: { owner: 'octo-org', name: 'policy', id: '42' } }), runner);
    expect(result.observations['github.repository']!.availability).toBe('observed');
    expect(result.observations['github.security']!.availability).toBe('not-observed');
    expect(result.observations['github.rulesets']!.availability).toBe('observed');
  });

  it.each(['../main', 'main?method=DELETE', 'main#fragment', 'https://foreign.example', 'main%2f..', '--main', 'a//b', 'a.lock', 'refs/tags/v1', 'a@{1}', `secret=${token}`])(
    'refuses unsafe/unbound ref %s without interpolating it into a command', async (ref) => {
      const runner = new FixtureRunner();
      const result = await collect(scope({ refs: [ref] }), runner);
      expect(runner.calls.some((call) => /\/branches\/|\/check-runs/u.test(call.url))).toBe(false);
      expect(result.observations['github.branches']!.availability).toBe('not-observed');
      expect(result.observations['github.checks']!.availability).toBe('not-observed');
      expect(JSON.stringify(result)).not.toContain(token);
    }
  );

  it('collects both classic and effective protection without dropping enforcement parameters', async () => {
    const classic = {
      enforce_admins: { enabled: true },
      required_status_checks: { strict: true, contexts: ['Governance'], checks: [{ context: 'Governance', app_id: 7 }] },
      required_pull_request_reviews: {
        dismiss_stale_reviews: true, require_code_owner_reviews: false, required_approving_review_count: 0,
        require_last_push_approval: false, bypass_pull_request_allowances: { users: [], teams: [], apps: [] }
      },
      allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false }
    };
    const effective = { ...ruleset().rules[1], ruleset_id: 1, ruleset_source_type: 'Repository', ruleset_source: 'octo-org/policy' };
    const runner = new FixtureRunner()
      .set(branchUrl, { value: { name: 'develop', commit: { sha: commit }, protected: true } })
      .set(`${branchUrl}/protection`, { value: { ...classic, url: `https://hooks.slack.com/services/${token}` } })
      .set(inventoryUrl('/rules/branches/develop'), { value: [effective] });
    const result = await collect(scope(), runner);
    expect(result.observations['github.branches']!.value).toEqual([{
      name: 'develop', sha: commit, protected: true, protectionObserved: true,
      protection: { classic, effectiveRules: [effective] }
    }]);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('keeps a protection 404 unknown even when effective rules were readable', async () => {
    const runner = new FixtureRunner()
      .set(branchUrl, { value: { name: 'develop', commit: { sha: commit }, protected: true } })
      .set(`${branchUrl}/protection`, { httpStatus: 404 });
    const result = await collect(scope(), runner);
    const facts = { name: 'develop', sha: commit, protected: true, protection: null, protectionObserved: false };
    expect(result.observations['github.branches']).toMatchObject({
      availability: 'not-observed', value: null, facts: [facts]
    });
    expect(result.observations['github.branch.develop']).toMatchObject({
      availability: 'not-observed', value: null, facts, source: { revision: commit }
    });
    expect(result.observations['github.checks']!.availability).toBe('observed');
    expect(result.diagnostics.some((entry) => entry.code === 'live-masked-not-found')).toBe(true);
  });

  it('preserves develop/main ref, SHA and protected snapshots when classic protection is masked', async () => {
    const mainCommit = 'b'.repeat(40);
    const runner = new FixtureRunner()
      .set(branchUrl, { value: { name: 'develop', commit: { sha: commit }, protected: true } })
      .set(`${base}/branches/main`, { value: { name: 'main', commit: { sha: mainCommit }, protected: true } })
      .set(`${branchUrl}/protection`, { httpStatus: 404 })
      .set(`${base}/branches/main/protection`, { httpStatus: 404 })
      .set(inventoryUrl(`/commits/${mainCommit}/check-runs`, 1, { filter: 'latest' }), {
        value: { total_count: 1, check_runs: [{ ...check(), head_sha: mainCommit }] }
      });
    const result = await collect(scope({ refs: ['refs/heads/main', 'develop'] }), runner);
    expect(result.observations['github.branches']).toMatchObject({
      availability: 'not-observed', value: null, facts: [
        { name: 'develop', sha: commit, protected: true, protection: null, protectionObserved: false },
        { name: 'main', sha: mainCommit, protected: true, protection: null, protectionObserved: false }
      ]
    });
    expect(result.observations['github.checks']).toMatchObject({
      availability: 'observed', value: [{ ref: 'develop', sha: commit }, { ref: 'main', sha: mainCommit }]
    });
    expect(result.refsStable).toBe(true);
    expect(runner.calls.filter((call) => call.url === branchUrl)).toHaveLength(2);
    expect(runner.calls.filter((call) => call.url === `${base}/branches/main`)).toHaveLength(2);
    expect(Object.values(result.observations).some((entry) => entry.availability === 'missing')).toBe(false);
  });

  it.each([
    { source_type: 'Organization', source: 'octo-org' },
    { source_type: 'Enterprise', source: 'platform-enterprise' }
  ])('retains inherited ruleset origin without treating it as repository ownership: %j', async (origin) => {
    const runner = new FixtureRunner()
      .set(rulesetsUrl(), { value: [{ id: 1 }, { id: 2 }] })
      .set(`${base}/rulesets/2?includes_parents=true`, { value: { ...ruleset(2), ...origin } });
    const result = await collect(scope(), runner);
    expect(result.observations['github.rulesets']).toMatchObject({
      availability: 'observed',
      value: [
        { id: 1, source_type: 'Repository', source: 'octo-org/policy' },
        { id: 2, ...origin }
      ]
    });
    expect(runner.calls.some((call) => new URL(call.url).pathname.startsWith('/orgs/'))).toBe(false);
  });

  it('preserves source metadata from the authoritative ruleset inventory when omitted by detail responses', async () => {
    const runner = new FixtureRunner()
      .set(rulesetsUrl(), { value: [{ id: 1, source_type: 'Organization', source: 'octo-org' }] })
      .set(`${base}/rulesets/1?includes_parents=true`, {
        value: { ...ruleset(), source_type: undefined, source: undefined }
      });
    const result = await collect(scope(), runner);
    expect(result.observations['github.rulesets']).toMatchObject({
      availability: 'observed', value: [{ source_type: 'Organization', source: 'octo-org' }]
    });
  });

  it('rejects conflicting ruleset origin metadata rather than favoring repository ownership', async () => {
    const runner = new FixtureRunner()
      .set(rulesetsUrl(), { value: [{ id: 1, source_type: 'Organization', source: 'octo-org' }] });
    const result = await collect(scope(), runner);
    expect(result.observations['github.rulesets']).toMatchObject({ availability: 'not-observed', value: null });
    expect(result.diagnostics.some((entry) => entry.code === 'live-scope-mismatch')).toBe(true);
  });

  it('does not default rulesets without any authoritative origin metadata to repository-owned', async () => {
    const runner = new FixtureRunner()
      .set(`${base}/rulesets/1?includes_parents=true`, {
        value: { ...ruleset(), source_type: undefined, source: undefined }
      });
    const result = await collect(scope(), runner);
    expect(result.observations['github.rulesets']).toMatchObject({ availability: 'not-observed', value: null });
  });

  it('keeps different refs and commit SHAs in separate latest-check groups without pooling successes', async () => {
    const mainCommit = 'b'.repeat(40);
    const mainChecksUrl = inventoryUrl(`/commits/${mainCommit}/check-runs`, 1, { filter: 'latest' });
    const runner = new FixtureRunner()
      .set(`${base}/branches/main`, { value: { name: 'main', commit: { sha: mainCommit }, protected: false } })
      .set(checksUrl(), { value: { total_count: 1, check_runs: [check(1, 'Develop-only success')] } })
      .set(mainChecksUrl, {
        value: { total_count: 1, check_runs: [{ ...check(2, 'Main-only success'), head_sha: mainCommit }] }
      });
    const result = await collect(scope({ refs: ['refs/heads/main', 'refs/heads/develop'] }), runner);
    expect(result.observations['github.checks']).toMatchObject({
      availability: 'observed', value: [
        { ref: 'develop', name: 'develop', sha: commit, checks: [{ name: 'Develop-only success' }] },
        { ref: 'main', name: 'main', sha: mainCommit, checks: [{ name: 'Main-only success' }] }
      ]
    });
    expect(result.observations['github.checks.develop']!.source?.revision).toBe(commit);
    expect(result.observations['github.checks.main']!.source?.revision).toBe(mainCommit);
    const queries = runner.calls.filter((call) => new URL(call.url).pathname.endsWith('/check-runs'));
    expect(queries.map((call) => call.url)).toEqual([checksUrl(), mainChecksUrl]);
    expect(queries.every((call) => new URL(call.url).searchParams.get('filter') === 'latest')).toBe(true);
  });

  it('rejects continuation links that change a latest-check query to all historical runs', async () => {
    const next = checksUrl(2).replace('filter=latest', 'filter=all');
    const runner = new FixtureRunner().set(checksUrl(), {
      value: { total_count: 2, check_runs: [check()] },
      headers: { Link: `<${next}>; rel="next"` }
    });
    const result = await collect(scope(), runner);
    expect(result.observations['github.checks']).toMatchObject({ availability: 'not-observed', value: null });
    expect(runner.calls.some((call) => call.url === next)).toBe(false);
    expect(result.diagnostics.some((entry) => entry.code === 'live-unsafe-continuation')).toBe(true);
  });

  it('reads all ruleset, environment, workflow and check pages before publishing aggregate facts', async () => {
    const workflow = (id: number) => ({ id, name: `Workflow ${id}`, path: `.github/workflows/${id}.yml`, state: 'active' });
    const runner = new FixtureRunner()
      .set(rulesetsUrl(), { value: [{ id: 2 }], headers: { Link: `<${rulesetsUrl(2)}>; rel="next"` } })
      .set(rulesetsUrl(2), { value: [{ id: 1 }] })
      .set(checksUrl(), { value: { total_count: 2, check_runs: [check(2, 'Zeta')] }, headers: { Link: `<${checksUrl(2)}>; rel="next"` } })
      .set(checksUrl(2), { value: { total_count: 2, check_runs: [check(1)] } })
      .set(environmentsUrl(), { value: { total_count: 2, environments: [environment('prod')] }, headers: { Link: `<${environmentsUrl(2)}>; rel="next"` } })
      .set(environmentsUrl(2), { value: { total_count: 2, environments: [environment()] } })
      .set(workflowsUrl(), { value: { total_count: 2, workflows: [workflow(2)] }, headers: { Link: `<${workflowsUrl(2)}>; rel="next"` } })
      .set(workflowsUrl(2), { value: { total_count: 2, workflows: [workflow(1)] } });
    const result = await collect(scope({ environments: ['prod', 'staging'] }), runner);
    for (const key of ['github.rulesets', 'github.environments', 'github.workflows']) {
      expect(result.observations[key]!.availability).toBe('observed');
      expect(result.observations[key]!.value).toHaveLength(2);
    }
    expect(result.observations['github.checks']!.value).toMatchObject([{ checks: [{ name: 'Governance' }, { name: 'Zeta' }] }]);
    for (const url of [rulesetsUrl(2), checksUrl(2), environmentsUrl(2), workflowsUrl(2)]) {
      expect(runner.calls.some((call) => call.url === url)).toBe(true);
    }
  });

  it('verifies terminal pages on full bare-array inventories without a Link header', async () => {
    const runner = new FixtureRunner()
      .set(rulesetsUrl(), { value: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) })
      .set(rulesetsUrl(2), { value: [] });
    const result = await collect(scope({ refs: [], environments: [] }), runner);
    expect(result.observations['github.rulesets']!.value).toHaveLength(100);
    expect(runner.calls.some((call) => call.url === rulesetsUrl(2))).toBe(true);
  });

  it.each([
    { value: { total_count: 2, workflows: [] } },
    { value: { workflows: [] } },
    { value: { total_count: 1, workflows: 'truncated' } },
    { raw: 'HTTP/2.0 200 OK\r\n\r\n{"total_count":2,"workflows":[' },
    { raw: '{"total_count":0,"workflows":[]}' },
    { value: { total_count: 0, workflows: [], incomplete_results: true } },
    { value: { total_count: 0, workflows: [], nextLink: 'https://foreign.example/other' } },
    { value: { total_count: 0, workflows: [] }, headers: { 'Content-Length': '9999' } }
  ] satisfies Reply[])('does not publish incomplete/truncated inventory as empty: %j', async (reply) => {
    const runner = new FixtureRunner().set(workflowsUrl(), reply);
    const result = await collect(scope(), runner);
    expect(result.observations['github.workflows']).toMatchObject({ availability: 'not-observed', value: null });
    expect(result.observations['github.rulesets']!.availability).toBe('observed');
  });

  it.each([
    'https://foreign.example/repos/octo-org/policy/rulesets?includes_parents=true&per_page=100&page=2',
    'https://github.com/repos/octo-org/policy/rulesets?includes_parents=true&per_page=100&page=2',
    'https://api.github.com/api/v3/repos/octo-org/policy/rulesets?includes_parents=true&per_page=100&page=2',
    'http://api.github.com/repos/octo-org/policy/rulesets?includes_parents=true&per_page=100&page=2',
    'https://api.github.com/repos/foreign/repository/rulesets?includes_parents=true&per_page=100&page=2',
    'https://api.github.com/repos/octo-org/policy/actions/workflows?includes_parents=true&per_page=100&page=2',
    'https://api.github.com/repos/octo-org/policy/rulesets/1?includes_parents=true&per_page=100&page=2',
    'https://api.github.com/repos/octo-org/policy/../policy/rulesets?includes_parents=true&per_page=100&page=2',
    'https://user:password@api.github.com/repos/octo-org/policy/rulesets?includes_parents=true&per_page=100&page=2',
    `${rulesetsUrl(2)}#fragment`,
    rulesetsUrl(2).replace('includes_parents=true', 'includes_parents=false'),
    rulesetsUrl(2).replace('per_page=100', 'per_page=1000'),
    `${rulesetsUrl(2)}&method=DELETE`,
    `${rulesetsUrl(2)}&page=3`,
    rulesetsUrl(1),
    rulesetsUrl(3)
  ])('rejects untrusted continuation before invocation: %s', async (next) => {
    const runner = new FixtureRunner().set(rulesetsUrl(), { value: [{ id: 1 }], headers: { Link: `<${next}>; rel="next"` } });
    const result = await collect(scope(), runner);
    expect(result.observations['github.rulesets']!.availability).toBe('not-observed');
    expect(runner.calls.filter((call) => new URL(call.url).pathname.endsWith('/rulesets'))).toHaveLength(1);
    expect(result.diagnostics.some((entry) => entry.code === 'live-unsafe-continuation')).toBe(true);
  });

  it('rejects a foreign link even when it is advertised only as the last page', async () => {
    const runner = new FixtureRunner().set(rulesetsUrl(), {
      value: [{ id: 1 }],
      headers: { Link: `<${rulesetsUrl(2)}>; rel="next", <https://foreign.example/secret>; rel="last"` }
    });
    const result = await collect(scope(), runner);
    expect(result.observations['github.rulesets']!.availability).toBe('not-observed');
    expect(runner.calls.some((call) => call.url === rulesetsUrl(2))).toBe(false);
  });

  it.each([
    `<${rulesetsUrl(2)}>; rel="last"`,
    `<${rulesetsUrl(2)}>; rel="last", <${rulesetsUrl(1)}>; rel="first"`,
    `<${rulesetsUrl(2)}>; rel="next", <${rulesetsUrl(1)}>; rel="last"`,
    `<${rulesetsUrl(1)}>; rel="prev"`,
    `<${rulesetsUrl(2)}>; rel="first"`,
    `<${rulesetsUrl(2)}>; rel="next", <${rulesetsUrl(2)}>; rel="next"`
  ])('rejects incomplete or contradictory first-page relationships before claiming a short page complete: %s', async (link) => {
    const runner = new FixtureRunner().set(rulesetsUrl(), { value: [{ id: 1 }], headers: { Link: link } });
    const result = await collect(scope(), runner);
    expect(result.observations['github.rulesets']).toMatchObject({ availability: 'not-observed', value: null });
    expect(runner.calls.filter((call) => new URL(call.url).pathname.endsWith('/rulesets'))).toHaveLength(1);
    expect(runner.calls.some((call) => /\/rulesets\/\d+/u.test(call.url))).toBe(false);
  });

  it.each([
    undefined,
    `<${rulesetsUrl(3)}>; rel="last"`,
    `<${rulesetsUrl(3)}>; rel="next", <${rulesetsUrl(4)}>; rel="last"`,
    `<${rulesetsUrl(3)}>; rel="next", <${rulesetsUrl(2)}>; rel="last"`,
    `<${rulesetsUrl(3)}>; rel="next", <${rulesetsUrl(2)}>; rel="prev"`,
    `<${rulesetsUrl(3)}>; rel="next", <${rulesetsUrl(2)}>; rel="first"`
  ])('retains and validates final-page expectations on subsequent pages: %s', async (link) => {
    const runner = new FixtureRunner()
      .set(rulesetsUrl(), {
        value: [{ id: 1 }], headers: { Link: `<${rulesetsUrl(2)}>; rel="next", <${rulesetsUrl(3)}>; rel="last"` }
      })
      .set(rulesetsUrl(2), { value: [{ id: 2 }], ...(link === undefined ? {} : { headers: { Link: link } }) });
    const result = await collect(scope(), runner);
    expect(result.observations['github.rulesets']).toMatchObject({ availability: 'not-observed', value: null });
    expect(runner.calls.filter((call) => new URL(call.url).pathname.endsWith('/rulesets'))).toHaveLength(2);
  });

  it('accepts consistent next/last/prev/first relationships through the complete inventory', async () => {
    const runner = new FixtureRunner()
      .set(rulesetsUrl(), {
        value: [{ id: 1 }], headers: { Link: `<${rulesetsUrl(2)}>; rel="next", <${rulesetsUrl(3)}>; rel="last"` }
      })
      .set(rulesetsUrl(2), {
        value: [{ id: 2 }],
        headers: { Link: `<${rulesetsUrl(1)}>; rel="first", <${rulesetsUrl(1)}>; rel="prev", <${rulesetsUrl(3)}>; rel="next", <${rulesetsUrl(3)}>; rel="last"` }
      })
      .set(rulesetsUrl(3), {
        value: [{ id: 3 }], headers: { Link: `<${rulesetsUrl(1)}>; rel="first", <${rulesetsUrl(2)}>; rel="prev", <${rulesetsUrl(3)}>; rel="last"` }
      });
    const result = await collect(scope(), runner);
    expect(result.observations['github.rulesets']!.availability).toBe('observed');
    expect(result.observations['github.rulesets']!.value).toHaveLength(3);
  });

  it('uses an explicit consistent last-page link to finish a full bare-array page', async () => {
    const runner = new FixtureRunner().set(rulesetsUrl(), {
      value: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
      headers: { Link: `<${rulesetsUrl(1)}>; rel="first", <${rulesetsUrl(1)}>; rel="last"` }
    });
    const result = await collect(scope(), runner);
    expect(result.observations['github.rulesets']!.value).toHaveLength(100);
    expect(runner.calls.some((call) => call.url === rulesetsUrl(2))).toBe(false);
  });

  it('accepts an empty terminal probe that points back to the already collected last page', async () => {
    const runner = new FixtureRunner()
      .set(rulesetsUrl(), { value: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) })
      .set(rulesetsUrl(2), {
        value: [],
        headers: { Link: `<${rulesetsUrl(1)}>; rel="first", <${rulesetsUrl(1)}>; rel="prev", <${rulesetsUrl(1)}>; rel="last"` }
      });
    const result = await collect(scope(), runner);
    expect(result.observations['github.rulesets']!.value).toHaveLength(100);
    expect(runner.calls.some((call) => call.url === rulesetsUrl(3))).toBe(false);
  });

  it('rejects repeated entries and changing total counts', async () => {
    const runner = new FixtureRunner()
      .set(rulesetsUrl(), { value: [{ id: 1 }], headers: { Link: `<${rulesetsUrl(2)}>; rel="next"` } })
      .set(rulesetsUrl(2), { value: [{ id: 1 }] })
      .set(checksUrl(), { value: { total_count: 2, check_runs: [check(1)] }, headers: { Link: `<${checksUrl(2)}>; rel="next"` } })
      .set(checksUrl(2), { value: { total_count: 3, check_runs: [check(2)] } });
    const result = await collect(scope(), runner);
    expect(result.observations['github.rulesets']!.availability).toBe('not-observed');
    expect(result.observations['github.checks']!.availability).toBe('not-observed');
  });

  it('stops at the fixed page limit without fetching details from an incomplete inventory', async () => {
    const runner = new FixtureRunner();
    for (let page = 1; page <= 20; page += 1) {
      runner.set(rulesetsUrl(page), { value: [{ id: page }], headers: { Link: `<${rulesetsUrl(page + 1)}>; rel="next"` } });
    }
    const result = await collect(scope(), runner);
    expect(runner.calls.filter((call) => new URL(call.url).pathname.endsWith('/rulesets'))).toHaveLength(20);
    expect(runner.calls.some((call) => /\/rulesets\/\d+/u.test(call.url))).toBe(false);
    expect(result.observations['github.rulesets']!.availability).toBe('not-observed');
    expect(result.diagnostics.some((entry) => entry.code === 'live-page-limit')).toBe(true);
  });

  it('distinguishes authoritatively absent settings from denied or masked 404s', async () => {
    const runner = new FixtureRunner()
      .set(rulesetsUrl(), { value: [] })
      .set(environmentsUrl(), { value: { total_count: 0, environments: [] } })
      .set(checksUrl(), { value: { total_count: 0, check_runs: [] } });
    const result = await collect(scope(), runner);
    expect(result.observations['github.rulesets']).toMatchObject({ availability: 'observed', value: [] });
    expect(result.observations['github.environments']).toMatchObject({ availability: 'observed', value: [] });
    expect(result.observations['github.environment.staging']!.availability).toBe('missing');
    expect(result.observations['github.checks']!.value).toEqual([{ ref: 'develop', name: 'develop', sha: commit, checks: [] }]);
    for (const status of [401, 403, 404]) {
      const denied = await collect(scope(), new FixtureRunner().set(environmentsUrl(), { httpStatus: status }));
      expect(denied.observations['github.environments']).toMatchObject({ availability: 'not-observed', value: null });
      expect(denied.observations['github.environment.staging']).toBeUndefined();
    }
  });

  it('uses bounded complete deployment-policy pages for custom environment restrictions', async () => {
    const url = inventoryUrl('/environments/staging/deployment-branch-policies');
    const next = inventoryUrl('/environments/staging/deployment-branch-policies', 2);
    const runner = new FixtureRunner()
      .set(environmentsUrl(), { value: {
        total_count: 1, environments: [{
          ...environment(), protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 4 } }] }],
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
        }]
      } })
      .set(url, { value: { total_count: 2, branch_policies: [{ id: 2, name: 'v*', type: 'tag' }] }, headers: { Link: `<${next}>; rel="next"` } })
      .set(next, { value: { total_count: 2, branch_policies: [{ id: 1, name: 'main', type: 'branch' }] } });
    const result = await collect(scope(), runner);
    expect(result.observations['github.environments']!.value).toEqual([{
      name: 'staging', reviewers: 1,
      deploymentBranchPolicy: {
        protected_branches: false, custom_branch_policies: true,
        branchPolicies: [{ id: 1, name: 'main', type: 'branch' }, { id: 2, name: 'v*', type: 'tag' }]
      }
    }]);
  });

  it('matches environment names case-insensitively without declaring an existing environment absent', async () => {
    const runner = new FixtureRunner().set(environmentsUrl(), {
      value: { total_count: 1, environments: [environment('STAGING')] }
    });
    const result = await collect(scope({ environments: ['Staging', 'staging'] }), runner);
    expect(result.observations['github.environments']!.value).toMatchObject([{ name: 'staging', reviewers: 0 }]);
    expect(result.observations['github.environment.staging']!.availability).toBe('observed');
    expect(Object.values(result.observations).some((entry) => entry.availability === 'missing')).toBe(false);
  });

  it.each([
    { ...environment(), protection_rules: undefined },
    { ...environment(), protection_rules: [{ type: 'unrecognized_approval_gate' }] },
    { ...environment(), protection_rules: [{ type: 'required_reviewers', reviewers: ['invalid'] }] }
  ])('does not infer zero reviewers from incomplete environment protection metadata', async (payload) => {
    const runner = new FixtureRunner().set(environmentsUrl(), {
      value: { total_count: 1, environments: [payload] }
    });
    const result = await collect(scope(), runner);
    expect(result.observations['github.environments']!.availability).toBe('not-observed');
  });

  it('does not silently erase unknown rule parameters or missing bypass actors', async () => {
    for (const payload of [
      { ...ruleset(), bypass_actors: undefined },
      { ...ruleset(), enforcement: 'unknown_enforcement_state' },
      { ...ruleset(), rules: [{ type: 'unrecognized_rule' }] },
      { ...ruleset(), rules: [{ type: 'pull_request', parameters: { unknown_gate: true } }] }
    ]) {
      const runner = new FixtureRunner().set(`${base}/rulesets/1?includes_parents=true`, { value: payload });
      const result = await collect(scope(), runner);
      expect(result.observations['github.rulesets']).toMatchObject({ availability: 'not-observed', value: null });
    }
  });

  it('requires every check head SHA and branch name to match the requested snapshot', async () => {
    const wrongChecks = await collect(scope(), new FixtureRunner().set(checksUrl(), {
      value: { total_count: 1, check_runs: [{ ...check(), head_sha: 'b'.repeat(40) }] }
    }));
    expect(wrongChecks.observations['github.checks']!.availability).toBe('not-observed');
    const runner = new FixtureRunner().set(branchUrl, { value: { name: 'other', commit: { sha: commit }, protected: false } });
    const wrongBranch = await collect(scope(), runner);
    expect(wrongBranch.observations['github.branches']!.availability).toBe('not-observed');
    expect(runner.calls.some((call) => call.url.includes('/check-runs'))).toBe(false);
  });

  it.each(['moved', 'denied', 'protection-changed'] as const)('withholds mixed snapshots when final ref read is %s', async (mode) => {
    const runner = new FixtureRunner().set(branchUrl, (count) => count === 1
      ? { value: { name: 'develop', commit: { sha: commit }, protected: false } }
      : mode === 'denied' ? { httpStatus: 403 }
        : { value: { name: 'develop', commit: { sha: mode === 'moved' ? 'b'.repeat(40) : commit }, protected: mode === 'protection-changed' } });
    const result = await collect(scope(), runner);
    expect(result.refsStable).toBe(false);
    for (const key of ['github.branches', 'github.checks', 'github.branch.develop', 'github.checks.develop']) {
      expect(result.observations[key]).toMatchObject({ availability: 'not-observed', value: null });
      expect(result.observations[key]!.facts).toBeUndefined();
    }
    expect(result.observations['github.rulesets']!.availability).toBe('observed');
    expect(runner.calls.filter((call) => call.url.includes('/check-runs')).every((call) => call.url.includes(commit))).toBe(true);
  });

  it('discards retained partial branch facts if the ref subsequently moves', async () => {
    const runner = new FixtureRunner()
      .set(branchUrl, (count) => ({
        value: { name: 'develop', commit: { sha: count === 1 ? commit : 'b'.repeat(40) }, protected: true }
      }))
      .set(`${branchUrl}/protection`, { httpStatus: 404 });
    const result = await collect(scope(), runner);
    expect(result.refsStable).toBe(false);
    expect(result.observations['github.branches']!.facts).toBeUndefined();
    expect(result.observations['github.branch.develop']!.facts).toBeUndefined();
    expect(result.observations['github.checks']!.availability).toBe('not-observed');
    expect(result.observations['github.actions-app']!.availability).toBe('observed');
  });

  it('collects deterministic normalized values despite provider and input ordering', async () => {
    const first = new FixtureRunner().set(checksUrl(), { value: { total_count: 2, check_runs: [check(2, 'Zeta'), check(1)] } });
    const second = new FixtureRunner().set(checksUrl(), { value: { total_count: 2, check_runs: [check(1), check(2, 'Zeta')] } });
    const a = await collect(scope({ refs: ['main', 'develop'] }), first);
    const b = await collect(scope({ refs: ['develop', 'main'] }), second);
    expect(a).toEqual(b);
  });

  it('keeps absence provenance deterministic when complete environment inventories are reordered', async () => {
    const first = new FixtureRunner().set(environmentsUrl(), {
      value: { total_count: 2, environments: [environment('prod'), environment()] }
    });
    const second = new FixtureRunner().set(environmentsUrl(), {
      value: { total_count: 2, environments: [environment(), environment('prod')] }
    });
    const input = scope({ environments: ['dev', 'staging', 'prod'] });
    expect(await collect(input, first)).toEqual(await collect(input, second));
  });
});

describe('live limits, failure normalization and secret suppression', () => {
  it('does no discovery or tool execution when there is no repository or resource scope', async () => {
    const runner = new FixtureRunner();
    const result = await collect(scope({ repository: null, refs: [], environments: [] }), runner);
    expect(runner.calls).toHaveLength(0);
    expect(Object.keys(result.observations)).toHaveLength(11);
    expect(Object.values(result.observations).every((entry) => entry.availability === 'not-observed')).toBe(true);
    expect(result.diagnostics).toHaveLength(11);
  });

  it.each([
    { exitCode: null, errorCode: 'ENOENT', errorMessage: token },
    { httpStatus: 401, stderr: `gh auth login ${token}` },
    { httpStatus: 404, raw: `HTTP/2.0 404 Not Found\r\n\r\n${token}` },
    { thrown: new Error(`Request failed ${token}`) }
  ] satisfies Reply[])('reports expected transport failure without retaining its raw error: %j', async (reply) => {
    const runner = new FixtureRunner().set(base, reply);
    const result = await collect(scope(), runner);
    expect(runner.calls).toHaveLength(1);
    expect(result.observations['github.repository']!.availability).toBe('not-observed');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('retries transient reads exactly once but never retries denial', async () => {
    const retried = new FixtureRunner().set(base, (count) => count === 1 ? { httpStatus: 503 } : { value: repository() });
    const recovered = await collect(scope(), retried);
    expect(recovered.observations['github.repository']!.availability).toBe('observed');
    expect(recovered.diagnostics.some((entry) => entry.code === 'live-retried-request')).toBe(true);
    expect(retried.calls.filter((call) => call.url === base)).toHaveLength(2);
    const failed = new FixtureRunner().set(base, { httpStatus: 503 });
    expect((await collect(scope(), failed)).observations['github.repository']!.availability).toBe('not-observed');
    expect(failed.calls).toHaveLength(2);
    const denied = new FixtureRunner().set(base, { httpStatus: 403 });
    await collect(scope(), denied);
    expect(denied.calls).toHaveLength(1);
  });

  it('bounds request timeout retries and treats timeout output as unusable', async () => {
    const runner = new FixtureRunner().set(base, { value: repository(), timedOut: true });
    const result = await collect(scope(), runner);
    expect(runner.calls).toHaveLength(2);
    expect(result.observations['github.repository']!.availability).toBe('not-observed');
    expect(result.diagnostics.some((entry) => entry.code === 'live-request-timeout')).toBe(true);
  });

  it('does not hang when an injected transport ignores its timeout', async () => {
    vi.useFakeTimers();
    const run = vi.fn<CommandRunner['run']>(() => new Promise(() => {}));
    const pending = collectLiveAssessment(scope(), { runner: { run }, now });
    await vi.advanceTimersByTimeAsync(assessmentLimits.requestTimeoutMs * 2 + 1);
    const result = await pending;
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.observations['github.repository']!.availability).toBe('not-observed');
    for (const [, options] of run.mock.calls) {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options?.signal?.aborted).toBe(true);
      expect(getEventListeners(options!.signal!, 'abort')).toHaveLength(0);
    }
  });

  it('cancels an abort-aware command rather than accepting its late response after a timeout', async () => {
    vi.useFakeTimers();
    let aborted = 0;
    const fixture = new FixtureRunner();
    const run = vi.fn<CommandRunner['run']>((command, options) => new Promise((resolve) => {
      options!.signal!.addEventListener('abort', () => {
        aborted += 1;
        resolve(fixture.run(command));
      }, { once: true });
    }));
    const pending = collectLiveAssessment(scope(), { runner: { run }, now });
    await vi.advanceTimersByTimeAsync(assessmentLimits.requestTimeoutMs * 2 + 1);
    const result = await pending;
    expect(aborted).toBe(2);
    expect(result.observations['github.repository']).toMatchObject({ availability: 'not-observed', value: null });
    expect(result.diagnostics.some((entry) => entry.code === 'live-request-timeout')).toBe(true);
  });

  it('aborts every active command when the shared deadline expires, including earlier long-budget requests', async () => {
    vi.useFakeTimers();
    let elapsed = 0;
    const run = vi.fn<CommandRunner['run']>(() => new Promise(() => {}));
    const transport = new LiveTransport(
      { run }, () => new Date(Date.parse(capturedAt) + elapsed), scope(), new Set(), () => {}
    );
    const first = transport.github('repository');
    await Promise.resolve();
    elapsed = assessmentLimits.liveDeadlineMs - 50;
    const second = transport.github('repository');
    const outcomes = Promise.allSettled([first, second]);
    await vi.advanceTimersByTimeAsync(51);
    const results = await outcomes;

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]![1]!.timeoutMs).toBe(assessmentLimits.requestTimeoutMs);
    expect(run.mock.calls[1]![1]!.timeoutMs).toBeLessThanOrEqual(50);
    expect(results).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ code: 'deadline' }) },
      { status: 'rejected', reason: expect.objectContaining({ code: 'deadline' }) }
    ]);
    expect(run.mock.calls.every(([, options]) => options!.signal!.aborted)).toBe(true);
    elapsed = 0;
    await expect(transport.github('repository')).rejects.toMatchObject({ code: 'deadline' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('cancels active commands immediately when a clock check detects that the deadline has passed', async () => {
    let elapsed = 0;
    const run = vi.fn<CommandRunner['run']>(() => new Promise(() => {}));
    const transport = new LiveTransport(
      { run }, () => new Date(Date.parse(capturedAt) + elapsed), scope(), new Set(), () => {}
    );
    const first = transport.github('repository');
    const outcome = Promise.allSettled([first]);
    await Promise.resolve();
    elapsed = assessmentLimits.liveDeadlineMs + 1;
    await expect(transport.github('repository')).rejects.toMatchObject({ code: 'deadline' });
    expect(await outcome).toEqual([{ status: 'rejected', reason: expect.objectContaining({ code: 'deadline' }) }]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it('stops before additional reads when the total deadline is exceeded', async () => {
    let elapsed = 0;
    const runner = new FixtureRunner();
    runner.onCall = () => { elapsed += assessmentLimits.liveDeadlineMs + 1; };
    const result = await collectLiveAssessment(scope(), {
      runner, now: () => new Date(Date.parse(capturedAt) + elapsed)
    });
    expect(runner.calls).toHaveLength(1);
    expect(result.diagnostics.some((entry) => entry.code === 'live-deadline')).toBe(true);
  });

  it('shrinks request timeouts to the remaining total deadline', async () => {
    let elapsed = 0;
    const runner = new FixtureRunner();
    runner.onCall = () => { elapsed = 55_000; };
    const result = await collectLiveAssessment(scope(), {
      runner, now: () => new Date(Date.parse(capturedAt) + elapsed)
    });
    expect(result.observations['github.repository']!.availability).toBe('observed');
    expect(runner.calls.slice(1).every((call) => call.options.timeoutMs! <= 5_000)).toBe(true);
  });

  it.each(['raw', 'stderr', 'limit-flag'] as const)('discards oversized %s output, including secrets beyond truncation boundaries', async (mode) => {
    const huge = `${'é'.repeat(assessmentLimits.responseBytes / 2)}${token}`;
    const runner = new FixtureRunner().set(base, mode === 'raw' ? { raw: huge }
      : mode === 'stderr' ? { value: repository(), stderr: huge }
        : { value: repository(), outputLimitExceeded: true });
    const result = await collect(scope(), runner);
    expect(runner.calls).toHaveLength(1);
    expect(result.observations['github.repository']!.availability).toBe('not-observed');
    expect(result.diagnostics.some((entry) => entry.code === 'live-size-limit')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('drops non-allowlisted credentials, bodies, webhook URLs and private keys before returning metadata', async () => {
    const secrets = {
      token, connectionString: 'DefaultEndpointsProtocol=https;AccountKey=secret',
      webhook: 'https://hooks.slack.com/services/PRIVATE/SECRET',
      privateKey: '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----'
    };
    const runner = new FixtureRunner()
      .set(base, { value: { ...repository(), ...secrets } })
      .set(checksUrl(), { value: { total_count: 1, check_runs: [{ ...check(), output: secrets, details_url: secrets.webhook }] } })
      .set(workflowsUrl(), { value: { total_count: 1, workflows: [{ id: 8, name: 'Safe', path: '.github/workflows/safe.yml', state: 'active', ...secrets }] } });
    const result = await collect(scope(), runner);
    for (const value of Object.values(secrets)) expect(JSON.stringify(result)).not.toContain(value);
    expect(result.observations['github.checks']!.availability).toBe('observed');
    expect(result.observations['github.workflows']!.availability).toBe('observed');
  });

  it.each([
    token, 'https://discord.com/api/webhooks/secret', 'AccountKey=secret',
    'InstrumentationKey=11111111-1111-1111-1111-111111111111',
    'Server=private;Database=state;User Id=admin',
    '-----BEGIN PRIVATE KEY-----', `${'x'.repeat(3000)}${token}`
  ])(
    'withholds sensitive or unbounded allowlisted text rather than truncating it into a trusted fact', async (name) => {
      const runner = new FixtureRunner().set(checksUrl(), { value: { total_count: 1, check_runs: [check(1, name)] } });
      const result = await collect(scope(), runner);
      expect(result.observations['github.checks']!.availability).toBe('not-observed');
      expect(JSON.stringify(result)).not.toContain(name);
      expect(JSON.stringify(result)).not.toContain(token);
    }
  );
});

describe('bound hosted-runner metadata', () => {
  const runnerScope = { organization: 'octo-org', runnerId: 77, groupId: 9, networkConfigurationId: 'NC_fixture' };
  const runnerUrl = 'https://api.github.com/orgs/octo-org/actions/hosted-runners/77';
  const groupUrl = 'https://api.github.com/orgs/octo-org/actions/runner-groups/9';
  const networkUrl = 'https://api.github.com/orgs/octo-org/settings/network-configurations/NC_fixture';
  const assignmentUrl = 'https://api.github.com/orgs/octo-org/actions/runner-groups?visible_to_repository=policy&per_page=100&page=1';

  function fixture() {
    return new FixtureRunner()
      .set(runnerUrl, { value: {
        id: 77, name: 'private-staging', runner_group_id: 9,
        status: 'Ready', labels: [{ name: 'private-staging' }], maximum_runners: 1, public_ip_enabled: false,
        machine_size_details: { id: '4-core', cpu_cores: 4, memory_gb: 16, storage_gb: 150 }
      } })
      .set(groupUrl, { value: {
        id: 9, name: 'staging', visibility: 'selected', allows_public_repositories: false, network_configuration_id: 'NC_fixture',
        restricted_to_workflows: true, selected_workflows: ['octo-org/policy/.github/workflows/dast.yml@refs/heads/main'], inherited: false
      } })
      .set(networkUrl, { value: { id: 'NC_fixture', name: 'staging-network', compute_service: 'actions', network_settings_ids: ['NS_fixture'] } })
      .set(assignmentUrl, { value: { total_count: 2, runner_groups: [{ id: 10, name: token }, { id: 9 }] } });
  }

  it('reads only exact existing IDs and repository-filtered assignment, never all-org discovery', async () => {
    const runner = fixture();
    const result = await collect(scope({ runner: runnerScope }), runner);
    expect(result.observations['github.runner']).toMatchObject({
      availability: 'observed',
      value: {
        organization: 'octo-org', repository: 'octo-org/policy',
        runnerId: 77, groupId: 9, networkConfigurationId: 'NC_fixture', repositoryAssigned: true,
        runner: { labels: ['private-staging'], maximumRunners: 1, publicIpEnabled: false },
        group: { visibility: 'selected', restrictedToWorkflows: true },
        network: { id: 'NC_fixture', networkSettingsIds: ['NS_fixture'] }
      }
    });
    expect(runner.calls.filter((call) => call.url.includes('/orgs/')).map((call) => call.url))
      .toEqual([runnerUrl, groupUrl, networkUrl, assignmentUrl]);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('reports a proven unassigned group without inventing repository access', async () => {
    const runner = fixture().set(assignmentUrl, { value: { total_count: 0, runner_groups: [] } });
    const result = await collect(scope({ runner: runnerScope }), runner);
    expect(result.observations['github.runner']).toMatchObject({ availability: 'observed', value: { repositoryAssigned: false } });
  });

  it.each([
    null, { ...runnerScope, groupId: null }, { ...runnerScope, networkConfigurationId: null },
    { ...runnerScope, organization: 'unrelated-org' }, { ...runnerScope, runnerId: -1 },
    { ...runnerScope, networkConfigurationId: '../secrets?method=POST' }
  ])('does not discover missing or unsafe runner bindings: %j', async (bound) => {
    const runner = fixture();
    const result = await collect(scope({ runner: bound }), runner);
    expect(result.observations['github.runner']!.availability).toBe('not-observed');
    expect(runner.calls.some((call) => call.url.includes('/orgs/'))).toBe(false);
  });

  it('preserves permission denial and refuses mismatched runner IDs without broader discovery', async () => {
    for (const reply of [{ httpStatus: 403 }, { value: { id: 78, runner_group_id: 9, network_configuration_id: 'NC_fixture' } }]) {
      const runner = fixture().set(runnerUrl, reply);
      const result = await collect(scope({ runner: runnerScope }), runner);
      expect(result.observations['github.runner']!.availability).toBe('not-observed');
      expect(runner.calls.filter((call) => call.url.includes('/orgs/'))).toHaveLength(1);
    }
  });

  it('binds network configuration from the group response and refuses a mismatched group network', async () => {
    const runner = fixture().set(groupUrl, {
      value: { id: 9, network_configuration_id: 'NC_other' }
    });
    const result = await collect(scope({ runner: runnerScope }), runner);
    expect(result.observations['github.runner']!.availability).toBe('not-observed');
    expect(runner.calls.filter((call) => call.url.includes('/orgs/')).map((call) => call.url)).toEqual([runnerUrl, groupUrl]);
  });

  it('withholds runner assignment if its repository-filtered pagination is incomplete', async () => {
    const runner = fixture().set(assignmentUrl, {
      value: { total_count: 2, runner_groups: [{ id: 9 }] }
    });
    const result = await collect(scope({ runner: runnerScope }), runner);
    expect(result.observations['github.runner']!.availability).toBe('not-observed');
  });
});

describe('explicit Azure provider and resource metadata', () => {
  const storage: AzureAssessmentBinding = {
    subscriptionId: sub, environment: 'staging', resourceId: `${armRoot}/Microsoft.Storage/storageAccounts/state`,
    resourceType: 'Microsoft.Storage/storageAccounts', role: 'state'
  };
  const subnet: AzureAssessmentBinding = {
    subscriptionId: sub, environment: 'staging', resourceId: `${armRoot}/Microsoft.Network/virtualNetworks/private/subnets/runners`,
    resourceType: 'Microsoft.Network/virtualNetworks/subnets', role: 'runner-network'
  };
  const nat: AzureAssessmentBinding = {
    subscriptionId: sub, environment: 'staging', resourceId: `${armRoot}/Microsoft.Network/natGateways/egress`,
    resourceType: 'Microsoft.Network/natGateways', role: 'runner-network'
  };
  const dns: AzureAssessmentBinding = {
    subscriptionId: sub, environment: 'staging', resourceId: `${armRoot}/Microsoft.Network/privateDnsZones/internal.example/virtualNetworkLinks/runners`,
    resourceType: 'Microsoft.Network/privateDnsZones/virtualNetworkLinks', role: 'runner-network'
  };
  const network: AzureAssessmentBinding = {
    subscriptionId: sub, environment: 'staging', resourceId: `${armRoot}/GitHub.Network/networkSettings/actions`,
    resourceType: 'GitHub.Network/networkSettings', role: 'runner-network'
  };
  const resourceUrl = (binding: AzureAssessmentBinding) =>
    `https://management.azure.com${binding.resourceId}?api-version=${binding.resourceType.startsWith('Microsoft.Storage') ? '2023-05-01'
      : binding.resourceType.startsWith('GitHub.Network') ? '2024-04-02'
        : binding.resourceType.includes('privateDnsZones') ? '2020-06-01' : '2024-05-01'}`;
  const providerUrl = (namespace: string) => `https://management.azure.com/subscriptions/${sub}/providers/${namespace}?api-version=2021-04-01`;

  function fixture(bindings: AzureAssessmentBinding[]) {
    const runner = new FixtureRunner();
    for (const binding of bindings) {
      const namespace = binding.resourceType.split('/')[0]!;
      runner.set(providerUrl(namespace), {
        value: { namespace, id: `/subscriptions/${sub}/providers/${namespace}`, registrationState: 'Registered', resourceTypes: [{ credentials: token }] }
      });
      runner.set(resourceUrl(binding), { value: {
        id: binding.resourceId, type: binding.resourceType, sku: { name: binding === storage ? 'Standard_ZRS' : 'Standard', credential: token },
        properties: binding === storage ? {
          provisioningState: 'Succeeded', publicNetworkAccess: 'Disabled', allowSharedKeyAccess: false,
          allowBlobPublicAccess: false, supportsHttpsTrafficOnly: true, minimumTlsVersion: 'TLS1_2',
          networkAcls: { defaultAction: 'Deny', bypass: 'None', ipRules: [], virtualNetworkRules: [] },
          connectionString: 'AccountKey=do-not-retain', key: token,
          primaryEndpoints: { blob: 'https://state.blob.core.windows.net/' }
        } : binding === subnet ? {
          provisioningState: 'Succeeded', addressPrefix: '10.0.1.0/24', defaultOutboundAccess: false,
          natGateway: { id: nat.resourceId }, privateEndpointNetworkPolicies: 'Enabled',
          delegations: [{ name: 'actions', properties: { serviceName: 'GitHub.Network/networkSettings', actions: ['Microsoft.Network/virtualNetworks/subnets/join/action'] } }]
        } : binding === nat ? {
          provisioningState: 'Succeeded', idleTimeoutInMinutes: 4,
          publicIpAddresses: [{ id: `${armRoot}/Microsoft.Network/publicIPAddresses/egress` }]
        } : binding === dns ? {
          provisioningState: 'Succeeded', registrationEnabled: false,
          virtualNetwork: { id: `${armRoot}/Microsoft.Network/virtualNetworks/private` },
          virtualNetworkLinkState: 'Completed', resolutionPolicy: 'Default'
        } : { provisioningState: 'Succeeded', subnetId: subnet.resourceId, businessId: 42 }
      } });
    }
    return runner;
  }

  it('derives only bound namespaces and returns whitelisted storage, subnet, NAT, DNS and identity metadata', async () => {
    const bindings = [network, dns, nat, storage, subnet];
    const runner = fixture(bindings);
    const input = scope({ azure: bindings });
    const before = JSON.stringify(input);
    const result = await collect(input, runner);
    expect(JSON.stringify(input)).toBe(before);
    expect(result.observations['azure.providers']).toMatchObject({
      availability: 'observed', value: expect.arrayContaining([
        { subscriptionId: sub, namespace: 'Microsoft.Storage', registrationState: 'Registered' },
        { subscriptionId: sub, namespace: 'Microsoft.Network', registrationState: 'Registered' },
        { subscriptionId: sub, namespace: 'GitHub.Network', registrationState: 'Registered' }
      ])
    });
    expect(result.observations['azure.providers']!.value).toHaveLength(3);
    expect(result.observations['azure.resources']).toMatchObject({
      availability: 'observed', value: expect.arrayContaining([
        { ...storage, properties: expect.objectContaining({ publicNetworkAccess: 'Disabled', allowSharedKeyAccess: false }), sku: { name: 'Standard_ZRS' } },
        { ...subnet, properties: expect.objectContaining({ defaultOutboundAccess: false, natGateway: { id: nat.resourceId } }), sku: { name: 'Standard' } },
        { ...dns, properties: expect.objectContaining({ registrationEnabled: false }), sku: { name: 'Standard' } }
      ])
    });
    const calls = runner.calls.filter((call) => call.command.executable === 'az');
    expect(calls).toHaveLength(8);
    for (const { command, options, url } of calls) {
      expect(command.args).toEqual(['rest', '--method', 'GET', '--url', url, '--output', 'json', '--only-show-errors']);
      expect(url).toContain(`/subscriptions/${sub}/`);
      expect(options.env).toMatchObject({ AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no', AZURE_LOGGING_ENABLE_LOG_FILE: 'false' });
      expect(url).not.toMatch(/listKeys|\/blobs|SAS|register|\/tenants|roleAssignments/iu);
    }
    expect(calls.some((call) => call.url.includes('publicIPAddresses'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('AccountKey=');
    expect(JSON.stringify(result)).not.toContain('blob.core.windows.net');
  });

  it('records terminal and nonterminal provider states as facts without registering namespaces', async () => {
    const runner = fixture([storage]).set(providerUrl('Microsoft.Storage'), {
      value: { namespace: 'Microsoft.Storage', registrationState: 'Registering' }
    });
    const result = await collect(scope({ azure: [storage] }), runner);
    expect(result.observations['azure.providers']).toMatchObject({ availability: 'observed', value: [{ registrationState: 'Registering' }] });
    expect(runner.calls.filter((call) => call.command.executable === 'az')).toHaveLength(2);
  });

  it('includes the Network dependency of an explicitly bound GitHub networkSettings resource without discovering resources', async () => {
    const runner = fixture([network]).set(providerUrl('Microsoft.Network'), {
      value: { namespace: 'Microsoft.Network', registrationState: 'Registered' }
    });
    const result = await collect(scope({ azure: [network] }), runner);
    expect(result.observations['azure.providers']!.value).toHaveLength(2);
    expect(runner.calls.filter((call) => call.command.executable === 'az')).toHaveLength(3);
    expect(runner.calls.some((call) => call.url.includes('/virtualNetworks/'))).toBe(false);
  });

  it('does not fetch a resource with conflicting environment/role bindings', async () => {
    const runner = new FixtureRunner();
    const result = await collect(scope({ azure: [storage, { ...storage, role: 'application' }] }), runner);
    expect(result.observations['azure.resources']!.availability).toBe('not-observed');
    expect(result.observations['azure.providers']!.availability).toBe('not-observed');
    expect(runner.calls.some((call) => call.command.executable === 'az')).toBe(false);
  });

  it('retains normalized identity GUIDs but excludes non-allowlisted identity or SKU fields', async () => {
    const identityId = `${armRoot}/Microsoft.ManagedIdentity/userAssignedIdentities/runner`;
    const runner = fixture([storage]).set(resourceUrl(storage), { value: {
      id: storage.resourceId, type: storage.resourceType, properties: { provisioningState: 'Succeeded' },
      sku: { name: 'Standard_ZRS', arbitrary: token },
      identity: {
        type: 'SystemAssigned, UserAssigned', tenantId: sub, principalId: otherSub, clientSecret: token,
        userAssignedIdentities: { [identityId]: { clientId: sub, principalId: otherSub, clientSecret: token } }
      }
    } });
    const result = await collect(scope({ azure: [storage] }), runner);
    expect(result.observations['azure.resources']!.value).toMatchObject([{
      properties: {
        identity: {
          type: 'SystemAssigned, UserAssigned', tenantId: sub, principalId: otherSub,
          userAssignedIdentities: [{ id: identityId, clientId: sub, principalId: otherSub }]
        }
      }
    }]);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('caches an unavailable Azure CLI without installs, login, or repeated discovery', async () => {
    const runner = fixture([storage, subnet]).set(providerUrl('Microsoft.Network'), {
      exitCode: null, errorCode: 'ENOENT', errorMessage: token
    });
    const result = await collect(scope({ azure: [storage, subnet] }), runner);
    expect(result.observations['azure.resources']!.availability).toBe('not-observed');
    expect(runner.calls.filter((call) => call.command.executable === 'az')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it.each([
    { ...storage, subscriptionId: otherSub },
    { ...storage, subscriptionId: 'default' },
    { ...storage, resourceId: `${storage.resourceId}?api-version=latest` },
    { ...storage, resourceId: `${storage.resourceId}/listKeys`, resourceType: 'Microsoft.Storage/storageAccounts/listKeys' },
    { ...storage, resourceId: `${armRoot}/Microsoft.Compute/virtualMachines/unbound`, resourceType: 'Microsoft.Compute/virtualMachines' },
    { ...storage, resourceId: storage.resourceId.replace('/state', '/../state') },
    { ...storage, resourceId: storage.resourceId.replace('/state', '/%2e%2e') },
    { ...storage, resourceId: `https://foreign.example${storage.resourceId}` },
    { ...storage, environment: 'prod' as const },
    { ...storage, resourceType: 'Microsoft.Network/virtualNetworks' }
  ])('rejects invalid Azure binding without default subscription or tenant discovery: %j', async (binding) => {
    const runner = new FixtureRunner();
    const result = await collect(scope({ azure: [binding] }), runner);
    expect(runner.calls.some((call) => call.command.executable === 'az')).toBe(false);
    expect(result.observations['azure.resources']!.availability).toBe('not-observed');
    expect(result.observations['azure.providers']!.availability).toBe('not-observed');
  });

  it('preserves independently valid resource facts while withholding partial aggregates', async () => {
    const runner = fixture([storage, subnet]).set(resourceUrl(storage), { httpStatus: 404, stderr: `ResourceNotFound ${token}` });
    const result = await collect(scope({ azure: [storage, subnet] }), runner);
    expect(result.observations['azure.providers']!.availability).toBe('observed');
    expect(result.observations['azure.resources']).toMatchObject({ availability: 'not-observed', value: null });
    expect(result.observations[`azure.resource.staging.${subnet.resourceId}`]!.availability).toBe('observed');
    expect(result.observations[`azure.resource.staging.${storage.resourceId}`]!.availability).toBe('not-observed');
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('rejects resource or provider responses for another scope and never follows ARM continuation links', async () => {
    for (const value of [
      { id: storage.resourceId.replace(sub, otherSub), type: storage.resourceType, properties: { provisioningState: 'Succeeded' } },
      { id: storage.resourceId, type: subnet.resourceType, properties: { provisioningState: 'Succeeded' } },
      { id: storage.resourceId, type: storage.resourceType, properties: {}, nextLink: 'https://foreign.example/keys' }
    ]) {
      const runner = fixture([storage]).set(resourceUrl(storage), { value });
      const result = await collect(scope({ azure: [storage] }), runner);
      expect(result.observations['azure.resources']!.availability).toBe('not-observed');
      expect(runner.calls.filter((call) => call.command.executable === 'az')).toHaveLength(2);
    }
    const runner = fixture([storage]).set(providerUrl('Microsoft.Storage'), {
      value: { namespace: 'Microsoft.Storage', id: `/subscriptions/${otherSub}/providers/Microsoft.Storage`, registrationState: 'Registered' }
    });
    expect((await collect(scope({ azure: [storage] }), runner)).observations['azure.providers']!.availability).toBe('not-observed');
  });

  it('does not perform Azure reads before repository identity is verified', async () => {
    const runner = fixture([storage]).set(base, { value: { ...repository(), full_name: 'other/repository' } });
    const result = await collect(scope({ azure: [storage] }), runner);
    expect(runner.calls).toHaveLength(1);
    expect(result.observations['azure.resources']!.availability).toBe('not-observed');
  });
});
