import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectProjectLiveMetadata } from '../src/adapters/assessment/live.js';
import { inspectScopedLiveProject, ScopedLiveAssessmentError } from '../src/application/assessment/live-report.js';
import { providerAssessmentObservation } from '../src/domain/assessment/report.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { assessmentLimits } from '../src/domain/governance/assessment/types.js';
import {
  assembleProjectAssessmentReport as originalReport,
  projectAssessmentFinding as originalFinding
} from '../src/domain/assessment/report.js';
import { runCli, type CliTelemetryHooks } from '../src/cli.js';
import { runCommand } from '../src/cli/commands/dispatch.js';
import { CaptureStream } from './helpers.js';
import * as telemetryConfig from '../src/telemetry/config.js';
import { assessProject } from '../src/application/assessment/engine.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { buildCurrentArtifacts } from '../src/templates.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';

const roots: string[] = [];
const repository = 'example-org/assessment';
const base = `https://api.github.com/repos/${repository}`;
const head = 'a'.repeat(40);
const now = () => new Date('2026-10-05T00:00:00.000Z');
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function invokePrivateCli(argv: string[], root: string, runner: CommandRunner) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const hooks: CliTelemetryHooks = {
    beforeCommand: vi.fn().mockResolvedValue(true),
    afterCommand: vi.fn().mockResolvedValue(undefined),
    afterSemanticCommand: vi.fn().mockResolvedValue(undefined)
  };
  const code = await runCli({
    argv, cwd: root, stdout, stderr, env: {},
    execute: (parsed, context) => runCommand(parsed, { ...context, runner }),
    telemetry: hooks
  });
  expect(hooks.beforeCommand).not.toHaveBeenCalled();
  expect(hooks.afterCommand).not.toHaveBeenCalled();
  expect(hooks.afterSemanticCommand).not.toHaveBeenCalled();
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}
async function fixture(git = true) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'liftoff-live-prototype-'));
  roots.push(root);
  if (git) await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, 'untouched.txt'), 'original application\n');
  return root;
}

class FixtureRunner implements CommandRunner {
  readonly calls: { command: ExternalCommand; options: RunCommandOptions }[] = [];
  readonly providers: string[] = [];
  origin = `https://github.com/${repository}.git`;
  pushes = this.origin;
  afterOrigin: string | null = null;
  denied: { path: string; status: number } | null = null;
  failGit = false;
  incompleteGit: 'output-limit' | 'aborted' | 'signal' | 'unsettled' | null = null;
  pages = false;
  changeRefs = false;
  onProvider?: (endpoint: string) => Promise<void>;
  private branches = new Map<string, number>();

  constructor(readonly root: string, readonly realLocal = false) {}

  async run(command: ExternalCommand, options: RunCommandOptions = {}): Promise<CommandResult> {
    this.calls.push({ command, options });
    const result = (stdout: string, status = 0): CommandResult => ({
      command, displayCommand: 'isolated fixture', status, signal: null,
      stdout, stderr: '', timedOut: false
    });

    if (command.executable === 'git') {
      if (this.realLocal) return new NodeCommandRunner().run(command, options);
      if (this.incompleteGit) return {
        ...result(this.root), outputLimitExceeded: this.incompleteGit === 'output-limit',
        aborted: this.incompleteGit === 'aborted',
        signal: this.incompleteGit === 'signal' ? 'SIGTERM' : null,
        processTreeSettled: this.incompleteGit !== 'unsettled'
      };
      if (this.failGit) return result('', 1);
      const args = command.args;
      if (args.includes('--show-toplevel')) return result(this.root);
      if (args.includes('--verify')) return result(head);
      if (args.includes('--local')) return result(this.providers.length && this.afterOrigin !== null
        ? this.afterOrigin : this.origin);
      if (args.includes('--push')) return result(this.providers.length && this.afterOrigin !== null
        ? this.afterOrigin : this.pushes);
      throw new Error('Unexpected Git fixture command.');
    }
    if (command.executable !== 'gh') throw new Error('Only scoped Git/GitHub fixture reads are permitted.');
    const endpoint = command.args.at(-1);
    if (!endpoint) throw new Error('Missing literal provider endpoint.');
    this.providers.push(endpoint);
    await this.onProvider?.(endpoint);
    const url = new URL(endpoint);
    if (this.denied?.path === url.pathname) return result(
      `HTTP/2.0 ${this.denied.status} Fixture\r\n\r\n{"message":"not observed"}`, 1);
    const ok = (value: unknown) => result(`HTTP/2.0 200 Fixture\r\n\r\n${JSON.stringify(value)}`);
    if (endpoint === base) return ok({
      id: 42, node_id: 'R_fixture', full_name: repository, default_branch: 'develop',
      security_and_analysis: { secret_scanning: { status: 'enabled' } }
    });
    if (endpoint === 'https://api.github.com/apps/github-actions') return ok({ id: 7, slug: 'github-actions' });
    if (!endpoint.startsWith(`${base}/`)) throw new Error('Unexpected out-of-repository provider endpoint.');
    if (url.pathname.endsWith('/rulesets')) return ok([]);
    if (url.pathname.includes('/rules/branches/')) return ok([]);
    if (url.pathname.endsWith('/branches')) {
      const names = this.pages
        ? url.searchParams.get('page') === '1'
          ? Array.from({ length: 100 }, (_, index) => ({ name: `feature/${index}` }))
          : [{ name: 'release/1.0' }, { name: 'hotfix/1.0' }, { name: 'unrelated' }]
        : [{ name: 'main' }, { name: 'develop' }, { name: 'release/1.0' }, { name: 'hotfix/1.0' }, { name: 'unrelated' }];
      return ok(names);
    }
    const branch = /\/branches\/([^/]+)$/u.exec(url.pathname)?.[1];
    if (branch) {
      const count = (this.branches.get(branch) ?? 0) + 1;
      this.branches.set(branch, count);
      return ok({
        name: decodeURIComponent(branch), commit: { sha: this.changeRefs && count > 1 ? 'b'.repeat(40) : head },
        protected: false
      });
    }
    if (url.pathname.endsWith('/check-runs')) return ok({ total_count: 0, check_runs: [] });
    if (url.pathname.endsWith('/environments')) return ok({
      total_count: 3, environments: ['dev', 'staging', 'prod'].map((name, index) => ({
        id: index + 1, name, protection_rules: [],
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false }
      }))
    });
    if (url.pathname.endsWith('/actions/workflows')) return ok({ total_count: 0, workflows: [] });
    throw new Error('Unexpected fixture provider endpoint.');
  }
}

describe('private scoped live CLI integration prototype', () => {
  it('preserves actual local CLI output and avoids provider dispatch unless live is explicit', async () => {
    const root = await fixture(), runner = new FixtureRunner(root);
    const expected = await assessProject({ start: root, explicitRoot: true });
    const result = await invokePrivateCli(['assess', root, '--json'], root, runner);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(expected.exitCode);
    expect(JSON.parse(result.stdout)).toEqual(expected);
    expect(runner.calls).toEqual([]);
  });

  it('uses the real CLI dispatcher to emit first-class live provenance without telemetry, disclosure, enrollment or fetch', async () => {
    const root = await fixture(), runner = new FixtureRunner(root);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      scripts: { install: 'throw MUST_NOT_RUN', test: 'throw MUST_NOT_RUN' }
    }));
    const before = await readFile(path.join(root, 'package.json'));
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network seam'));
    const noticeRead = vi.spyOn(telemetryConfig, 'readTelemetryNoticeVersion').mockRejectedValue(new Error('Unexpected disclosure read'));
    const noticeWrite = vi.spyOn(telemetryConfig, 'recordTelemetryNotice').mockRejectedValue(new Error('Unexpected disclosure write'));
    const result = await invokePrivateCli(['assess', root, '--live', '--json'], root, runner);
    expect(result).toMatchObject({ code: 2, stderr: '' });
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ schemaVersion: 1, mode: 'live', readOnly: true, outcome: 'partial', exitCode: 2 });
    expect(report.findings.find((finding: { id: string }) => finding.id === 'live.github.repository')).toMatchObject({
      classification: 'not-observed', supported: false,
      observed: { availability: 'observed', source: { kind: 'github', location: base } }
    });
    expect(runner.providers.length).toBeGreaterThan(0);
    expect(runner.calls.every(call => ['git', 'gh'].includes(call.command.executable))).toBe(true);
    expect(await readFile(path.join(root, 'package.json'))).toEqual(before);
    expect(result.stdout).not.toContain('MUST_NOT_RUN');
    for (const spy of [fetch, noticeRead, noticeWrite]) expect(spy).not.toHaveBeenCalled();
  });

  it('reports actual provider access honestly when project metadata changes after collection', async () => {
    const root = await fixture(), runner = new FixtureRunner(root);
    runner.onProvider = async () => { await writeFile(path.join(root, 'liftoff.manifest.json'), '{}\n'); };
    const result = await invokePrivateCli(['assess', root, '--live', '--json'], root, runner);
    expect(result).toMatchObject({ code: 1, stderr: '' });
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ mode: 'live', outcome: 'error', exitCode: 1, snapshot: { inputsStable: false } });
    expect(runner.providers.length).toBeGreaterThan(0);
    expect(report.limitations.join(' ')).toContain('provider access was attempted');
    expect(report.limitations.join(' ')).not.toContain('No provider request');
    expect(report.limitations.join(' ')).not.toContain('network');
    expect(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')).toBe('{}\n');
  });

  it('distinguishes invalid pre-collection target selection without claiming attempted provider access', async () => {
    const root = await fixture(), runner = new FixtureRunner(root);
    const result = await invokePrivateCli(['assess', root, '--live', '--governance', 'invalid', '--json'], root, runner);
    expect(result).toMatchObject({ code: 1, stderr: '' });
    expect(JSON.parse(result.stdout).limitations).toContain('No provider request was dispatched.');
    expect(runner.calls).toEqual([]);
  });

  it('renders live scope and preserved uncertainty without claiming local-only/no-network operation', async () => {
    const root = await fixture(), runner = new FixtureRunner(root);
    const result = await invokePrivateCli(['assess', root, '--live', '--governance', 'none'], root, runner);
    expect(result).toMatchObject({ code: 2, stderr: '' });
    expect(result.stdout).toContain('Explicit scoped provider metadata');
    expect(result.stdout).toContain('No changes made');
    expect(result.stdout).not.toContain('Bounded local metadata; no network');
  });

  it.each([['assess', '--live', '--help'], ['assess', '--live', '--help', '--json'], ['help', 'assess']])(
    'keeps help %j entirely provider- and hook-free', async (...argv) => {
      const root = await fixture(), runner = new FixtureRunner(root);
      const result = await invokePrivateCli(argv, root, runner);
      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(runner.calls).toEqual([]);
    }
  );
});

describe('private scoped live metadata prototype', () => {
  it('uses only the exact project GitHub binding and declared environments without mutation or cloud discovery', async () => {
    const root = await fixture(), runner = new FixtureRunner(root);
    const environments = Object.freeze(['dev']);
    const result = await inspectProjectLiveMetadata({
      root, profile: 'single-maintainer-gitflow', environments, runner, now
    });
    expect(result.inputsStable).toBe(true);
    expect(result.observations['github.repository']).toMatchObject({
      availability: 'observed', source: { kind: 'github', location: base },
      value: { fullName: repository }
    });
    expect(result.observations['github.environments']?.value).toEqual([{
      name: 'dev', reviewers: 0,
      deploymentBranchPolicy: { protected_branches: true, custom_branch_policies: false }
    }]);
    expect(result.observations['github.branches']?.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'main' }), expect.objectContaining({ name: 'develop' }),
      expect.objectContaining({ name: 'release/1.0' }), expect.objectContaining({ name: 'hotfix/1.0' })
    ]));
    expect(JSON.stringify(result.observations['github.branches'])).not.toContain('unrelated');
    expect(result.observations['azure.resources']?.availability).toBe('not-observed');
    expect(result.observations['github.runner']?.availability).toBe('not-observed');
    expect(runner.providers.every(endpoint => endpoint === base || endpoint.startsWith(`${base}/`) ||
      endpoint === 'https://api.github.com/apps/github-actions')).toBe(true);
    expect(runner.calls.every(call => call.command.executable === 'git' || call.command.executable === 'gh')).toBe(true);
    expect(await readFile(path.join(root, 'untouched.txt'), 'utf8')).toBe('original application\n');
    expect(environments).toEqual(['dev']);
  });

  it.each(['none', 'single-maintainer-gitflow', 'team-gitflow'] as const)(
    'collects metadata without treating %s as legacy-policy qualification', async profile => {
      const root = await fixture(), runner = new FixtureRunner(root);
      const result = await inspectProjectLiveMetadata({ root, profile, environments: [], runner, now });
      expect(result.observations['github.repository']?.availability).toBe('observed');
      const branches = runner.providers.filter(endpoint => new URL(endpoint).pathname.includes('/branches'));
      expect(branches.length > 0).toBe(profile !== 'none');
      expect(result).not.toHaveProperty('outcome');
      expect(result).not.toHaveProperty('approval');
      expect(result).not.toHaveProperty('receipt');
    }
  );

  it.each(['absent', 'foreign-push', 'credential-origin', 'multiple-pushes', 'git-failure'] as const)(
    'withholds every provider read for %s project scope', async kind => {
      const root = await fixture(kind !== 'absent'), runner = new FixtureRunner(root);
      if (kind === 'foreign-push') runner.pushes = 'https://github.com/foreign/other.git';
      if (kind === 'credential-origin') runner.origin = 'https://private-token@github.com/example-org/assessment.git';
      if (kind === 'multiple-pushes') runner.pushes += '\nhttps://github.com/example-org/assessment.git';
      if (kind === 'git-failure') runner.failGit = true;
      const result = await inspectProjectLiveMetadata({
        root, profile: 'single-maintainer-gitflow', environments: ['prod'], runner, now
      });
      expect(runner.providers).toEqual([]);
      expect(result.observations['github.repository']?.availability).toBe('not-observed');
      expect(JSON.stringify(result)).not.toContain('private-token');
      expect(await readFile(path.join(root, 'untouched.txt'), 'utf8')).toBe('original application\n');
    }
  );

  it.each([403, 404])('preserves repository denial/masked absence %s and withholds dependent reads', async status => {
    const root = await fixture(), runner = new FixtureRunner(root);
    runner.denied = { path: `/repos/${repository}`, status };
    const result = await inspectProjectLiveMetadata({
      root, profile: 'single-maintainer-gitflow', environments: ['dev'], runner, now
    });
    expect(runner.providers).toEqual([base]);
    expect(result.observations['github.repository']?.availability).toBe('not-observed');
    expect(result.observations['github.environments']?.availability).toBe('not-observed');
    expect(result.observations['github.repository']?.source).toMatchObject({ kind: 'github', location: base });
  });

  it('enumerates only release/hotfix family metadata through bounded pagination', async () => {
    const root = await fixture(), runner = new FixtureRunner(root);
    runner.pages = true;
    const result = await inspectProjectLiveMetadata({
      root, profile: 'single-maintainer-gitflow', environments: [], runner, now
    });
    expect(result.observations['github.ref-families']).toMatchObject({
      availability: 'observed',
      value: { complete: true, prefixes: ['hotfix/', 'release/'], refs: ['hotfix/1.0', 'release/1.0'] }
    });
    expect(runner.providers.filter(endpoint => new URL(endpoint).pathname.endsWith('/branches'))).toHaveLength(2);
    expect(runner.providers.some(endpoint => new URL(endpoint).pathname.includes('feature'))).toBe(false);
  });

  it('invalidates facts when the exact GitHub binding changes during the read window', async () => {
    const root = await fixture(), runner = new FixtureRunner(root);
    runner.afterOrigin = 'https://github.com/foreign/after.git';
    const result = await inspectProjectLiveMetadata({
      root, profile: 'single-maintainer-gitflow', environments: [], runner, now
    });
    expect(result.inputsStable).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'live-project-git-changed' }));
    expect(runner.providers.some(endpoint => endpoint.includes('foreign'))).toBe(false);
  });

  it('preserves remote-ref drift independently of stable local Git metadata', async () => {
    const root = await fixture(), runner = new FixtureRunner(root);
    runner.changeRefs = true;
    const result = await inspectProjectLiveMetadata({
      root, profile: 'single-maintainer-gitflow', environments: [], runner, now
    });
    expect(result.refsStable).toBe(false);
    expect(result.inputsStable).toBe(false);
  });

  it('uses explicit GET and neutral provider selection with existing permissions only', async () => {
    vi.stubEnv('GH_REPO', 'foreign/other');
    vi.stubEnv('GH_HOST', 'foreign.example');
    vi.stubEnv('GH_DEBUG', 'api');
    const root = await fixture(), runner = new FixtureRunner(root);
    await inspectProjectLiveMetadata({ root, profile: 'none', environments: [], runner, now });
    for (const call of runner.calls.filter(call => call.command.executable === 'gh')) {
      expect(call.command.args.slice(0, 5)).toEqual(['api', '--method', 'GET', '--hostname', 'github.com']);
      expect(call.command.args.join(' ')).not.toMatch(/\b(?:POST|PUT|PATCH|DELETE|login|install|dispatch)\b/u);
      expect(call.options.env).toMatchObject({
        GH_REPO: '', GH_HOST: 'github.com', GH_DEBUG: '', GH_PROMPT_DISABLED: '1'
      });
    }
  });

  it.each(['output-limit', 'aborted', 'signal', 'unsettled'] as const)('rejects zero-exit %s Git output before provider access', async incomplete => {
    const root = await fixture(), runner = new FixtureRunner(root);
    runner.incompleteGit = incomplete;
    const result = await inspectProjectLiveMetadata({
      root, profile: 'single-maintainer-gitflow', environments: [], runner, now
    });
    expect(runner.providers).toEqual([]);
    expect(result.observations['github.repository']?.availability).toBe('not-observed');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'live-project-git-unobserved' }));
  });

  it('neutralizes Git execution/configuration selectors and caps each local metadata read', async () => {
    vi.stubEnv('GIT_DIR', '/foreign/repository');
    vi.stubEnv('GIT_WORK_TREE', '/foreign/worktree');
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'remote.origin.url');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://github.com/foreign/other');
    vi.stubEnv('GIT_TRACE', '/foreign/trace');
    const root = await fixture(), runner = new FixtureRunner(root);
    await inspectProjectLiveMetadata({ root, profile: 'none', environments: [], runner, now });
    for (const call of runner.calls.filter(call => call.command.executable === 'git')) {
      expect(call.options).toMatchObject({
        cwd: root, timeoutMs: 10_000, maxOutputBytes: 1024 * 1024,
        env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
      });
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_TRACE']) {
        expect(call.options.env?.[key]).toBeUndefined();
      }
    }
    expect(runner.providers[0]).toBe(base);
  });

  it('keeps actual local Git reads at the selected root despite foreign ambient selectors', async () => {
    const root = await fixture(), foreign = await fixture();
    const local = new NodeCommandRunner();
    for (const [directory, origin] of [
      [root, `https://github.com/${repository}.git`],
      [foreign, 'https://github.com/foreign/other.git']
    ]) {
      const environment: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(environment)) {
        if (key.toUpperCase().startsWith('GIT_')) environment[key] = undefined;
      }
      Object.assign(environment, {
        HOME: directory, XDG_CONFIG_HOME: directory, GIT_CONFIG_GLOBAL: devNull,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0'
      });
      for (const args of [
        ['-c', 'init.templateDir=', 'init', '--quiet', directory],
        ['config', '--local', 'remote.origin.url', origin]
      ]) {
        const result = await local.run({ executable: 'git', args }, {
          cwd: directory, env: environment, timeoutMs: 2000, maxOutputBytes: 1024 * 1024
        });
        expect(result).toMatchObject({ status: 0, timedOut: false, outputLimitExceeded: false });
      }
    }
    vi.stubEnv('GIT_DIR', path.join(foreign, '.git'));
    vi.stubEnv('GIT_WORK_TREE', root);
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'remote.origin.url');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://github.com/foreign/override.git');
    const runner = new FixtureRunner(root, true);
    const result = await inspectProjectLiveMetadata({ root, profile: 'none', environments: [], runner, now });
    expect(result.observations['github.repository']).toMatchObject({
      availability: 'observed', value: { fullName: repository }
    });
    expect(result.inputsStable).toBe(true);
    expect(runner.providers.some(endpoint => endpoint.includes('foreign'))).toBe(false);
    expect(await readFile(path.join(root, 'untouched.txt'), 'utf8')).toBe('original application\n');
  });

  it('composes actual ordinary-project reports without treating observed metadata as profile conformance', async () => {
    const root = await fixture(), runner = new FixtureRunner(root);
    await writeFile(path.join(root, 'package.json'), '{}');
    const inspectLocal = () => assessProject({ start: root, explicitRoot: true });
    const before = await inspectLocal();
    const result = await inspectScopedLiveProject({ inspectLocal, runner, now });
    expect(result).toMatchObject({ mode: 'live', readOnly: true, outcome: 'partial', exitCode: 2,
      snapshot: { inputsStable: true }, target: before.target });
    expect(result.findings.find(finding => finding.id === 'live.github.repository')).toMatchObject({
      classification: 'not-observed', supported: false,
      observed: {
        availability: 'observed', value: { fullName: repository },
        source: { kind: 'github', location: base }
      },
      remediation: { available: false, previewCommand: null }
    });
    expect(await inspectLocal()).toEqual(before);
    expect(result.coverage.notObserved).toBeGreaterThan(before.coverage.notObserved);
  });

  it('uses only actual declared current Manual environments and preserves original manifest bytes', async () => {
    const root = await fixture(), runner = new FixtureRunner(root);
    const plan = buildCurrentProjectPlan({
      projectName: 'Private live specimen', projectType: 'standard', apiStack: 'node',
      specWorkflow: 'manual', agents: [], governanceProfile: 'none', environments: ['dev']
    }, { requireProjectName: true });
    for (const artifact of buildCurrentArtifacts(plan)) {
      const file = path.join(root, ...artifact.pathParts);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, artifact.content);
    }
    const original = await readFile(path.join(root, 'liftoff.manifest.json'));
    const result = await inspectScopedLiveProject({
      inspectLocal: () => assessProject({ start: root, explicitRoot: true }), runner, now
    });
    expect(result.findings.find(finding => finding.id === 'live.github.environments')).toMatchObject({
      observed: {
        availability: 'observed',
        value: [{ name: 'dev', reviewers: 0, deploymentBranchPolicy: {
          protected_branches: true, custom_branch_policies: false
        } }]
      }
    });
    expect(await readFile(path.join(root, 'liftoff.manifest.json'))).toEqual(original);
  });

  it('rejects observed application declaration drift after collection without reverting the concurrent change', async () => {
    const root = await fixture(), runner = new FixtureRunner(root);
    await writeFile(path.join(root, 'package.json'), '{}');
    runner.onProvider = async endpoint => {
      if (endpoint === base) await writeFile(path.join(root, 'package.json'), '{"dependencies":{"concurrent":"1.0.0"}}');
    };
    await expect(inspectScopedLiveProject({
      inspectLocal: () => assessProject({ start: root, explicitRoot: true }), runner, now
    })).rejects.toThrow('inputs changed during live collection');
    expect(await readFile(path.join(root, 'package.json'), 'utf8')).toBe('{"dependencies":{"concurrent":"1.0.0"}}');
  });

  it('reobserves Git after final local checks without replaying provider collection', async () => {
    const root = await fixture(), runner = new FixtureRunner(root);
    let localCalls = 0;
    const result = await inspectScopedLiveProject({
      inspectLocal: async () => {
        const report = await assessProject({ start: root, explicitRoot: true });
        if (++localCalls === 2) runner.afterOrigin = 'https://github.com/foreign/after.git';
        return report;
      },
      runner, now
    });
    expect(result.snapshot.inputsStable).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'live-project-git-changed-after-local-verification'
    }));
    expect(runner.providers.filter(endpoint => endpoint === base)).toHaveLength(1);
    expect(localCalls).toBe(2);
  });

  it('retains denied provider availability without converting masked metadata into absence', async () => {
    const root = await fixture(), runner = new FixtureRunner(root);
    runner.denied = { path: `/repos/${repository}/rulesets`, status: 404 };
    const result = await inspectScopedLiveProject({
      inspectLocal: () => assessProject({ start: root, explicitRoot: true }), runner, now
    });
    expect(result.findings.find(finding => finding.id === 'live.github.rulesets')).toMatchObject({
      classification: 'not-observed', supported: false,
      observed: {
        availability: 'not-observed', value: null
      }
    });
    expect(result.outcome).toBe('partial');
    expect(result.exitCode).toBe(2);
  });

  it('keeps unbound Azure applicability unknown rather than asserting project deployment requirements', async () => {
    const root = await fixture(), runner = new FixtureRunner(root);
    const result = await inspectScopedLiveProject({
      inspectLocal: () => assessProject({ start: root, explicitRoot: true }), runner, now
    });
    expect(result.findings.find(finding => finding.id === 'live.azure.resources')).toMatchObject({
      applicability: 'unknown', classification: 'not-observed', supported: false
    });
    expect(runner.calls.some(call => call.command.executable === 'az')).toBe(false);
  });

  it('preserves first-class provider data and deterministic report identity without claiming conformance', async () => {
    const root = await fixture(), runner = new FixtureRunner(root);
    const inspectLocal = () => assessProject({ start: root, explicitRoot: true });
    const first = await inspectScopedLiveProject({ inspectLocal, runner, now });
    const second = await inspectScopedLiveProject({ inspectLocal, runner: new FixtureRunner(root), now });
    expect(second).toEqual(first);
    expect(first.resultDigest).toBe(canonicalSha256({ ...first, resultDigest: '' }));
    const provider = first.findings.find(finding => finding.id === 'live.github.repository');
    expect(provider?.observed).toMatchObject({
      availability: 'observed', source: {
        kind: 'github', location: base, capturedAt: now().toISOString(),
        digest: expect.any(String), revision: null, line: null
      }
    });
    expect(provider?.supported).toBe(false);
    expect(provider?.classification).toBe('not-observed');
    expect(first.coverage.fullyObserved).toBe((await inspectLocal()).coverage.fullyObserved);
  });

  it('does not falsely claim no provider access after post-collection inspection failure', async () => {
    const root = await fixture(), runner = new FixtureRunner(root);
    let calls = 0;
    const promise = inspectScopedLiveProject({
      inspectLocal: async () => {
        if (++calls === 2) throw new Error('Post-collection local inspection failed.');
        return assessProject({ start: root, explicitRoot: true });
      },
      runner, now
    });
    await expect(promise).rejects.toBeInstanceOf(ScopedLiveAssessmentError);
    await expect(promise).rejects.toMatchObject({
      providerAccessAttempted: true, message: 'Post-collection local inspection failed.'
    });
    expect(runner.providers.length).toBeGreaterThan(0);
  });

  it('distinguishes an actual pre-collection failure from attempted provider access', async () => {
    const root = await fixture(), runner = new FixtureRunner(root);
    const promise = inspectScopedLiveProject({
      inspectLocal: async () => { throw new Error('Local inspection failed before collection.'); },
      runner, now
    });
    await expect(promise).rejects.toMatchObject({ providerAccessAttempted: false });
    expect(runner.calls).toEqual([]);
  });

  it('preserves conservative access attribution even when the first provider dispatch throws', async () => {
    const root = await fixture(), runner = new FixtureRunner(root);
    runner.onProvider = async () => { throw new Error('Provider boundary threw.'); };
    const result = await inspectScopedLiveProject({
      inspectLocal: () => assessProject({ start: root, explicitRoot: true }), runner, now
    });
    expect(result.outcome).toBe('partial');
    expect(result.findings.find(finding => finding.id === 'live.github.repository')?.observed.availability).toBe('not-observed');
    expect(runner.providers).toEqual([base]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'live-transport-failed' }));
  });

  it.each(['file', 'package', 'git', 'evidence'] as const)(
    'refuses %s provenance being relabeled as a provider observation', kind => {
      expect(() => providerAssessmentObservation({
        availability: 'observed', value: true,
        source: { kind, location: base, capturedAt: now().toISOString(), digest: null, revision: null, line: null }
      })).toThrow('actual provider provenance');
    }
  );

  it('refuses an observed provider value with missing provenance instead of inventing source data', () => {
    expect(() => providerAssessmentObservation({
      availability: 'observed', value: true, source: null
    })).toThrow('complete provider provenance');
  });

  it('preserves missing and denied observations, original facts and original complete provider fields', () => {
    const source = {
      kind: 'github' as const, location: base, capturedAt: now().toISOString(),
      digest: canonicalSha256({ value: null }), revision: 'verified-provider-revision', line: 1
    };
    const denied = { availability: 'not-observed' as const, value: null, source, facts: { response: 'denied', supported: false } };
    const result = providerAssessmentObservation(denied);
    expect(result).toEqual(denied);
    expect(result.source).not.toBe(source);
    expect(result.facts).toBe(denied.facts);
    const missing = { availability: 'missing' as const, value: null, source };
    expect(providerAssessmentObservation(missing)).toEqual(missing);
    expect(() => providerAssessmentObservation({ ...missing, source: null })).toThrow('complete provider provenance');
  });

  it.each([
    { location: '' }, { capturedAt: '' }, { capturedAt: 'not-a-date' },
    { digest: 'sha256:invalid' }, { revision: '' }, { line: 0 }, { line: 1.5 }
  ])('refuses malformed provider provenance %j', override => {
    expect(() => providerAssessmentObservation({
      availability: 'observed', value: true,
      source: {
        kind: 'github', location: base, capturedAt: now().toISOString(),
        digest: null, revision: null, line: null, ...override
      }
    })).toThrow('complete, valid provider provenance');
  });
});

async function nativeRepository(origin = `https://github.com/${repository}.git`) {
  const root = await fixture(false);
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith('GIT_')) environment[key] = undefined;
  }
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_DATE: '2026-10-05T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-05T00:00:00Z'
  });
  const runner = new NodeCommandRunner();
  const git = async (args: string[]) => {
    const result = await runner.run({
      executable: 'git', args: [
        '--no-pager', '-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false',
        '-c', 'user.name=Assessment fixture', '-c', 'user.email=fixture@example.invalid', ...args
      ]
    }, { cwd: root, env: environment, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.errorCode).toBeUndefined();
    return result.stdout.trim();
  };
  await git(['init', '--quiet', '--initial-branch=develop']);
  await git(['config', '--local', 'remote.origin.url', origin]);
  await git(['commit', '--quiet', '--allow-empty', '--no-gpg-sign', '-m', 'Owned assessment fixture']);
  return { root, git };
}

describe('actual native Git reads with separately injected provider responses', () => {
  it('binds real repository metadata without executing project files or treating injected provider metadata as conformance', async () => {
    const { root, git } = await nativeRepository();
    const original = await readFile(path.join(root, 'untouched.txt'));
    const originalHead = await git(['rev-parse', 'HEAD']);
    const runner = new FixtureRunner(root, true);
    const result = await inspectProjectLiveMetadata({
      root, profile: 'single-maintainer-gitflow', environments: [], runner, now
    });
    expect(result.inputsStable).toBe(true);
    expect(result.gitMetadataDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.observations['github.repository'].availability).toBe('observed');
    expect(result.observations['github.repository'].source?.kind).toBe('github');
    expect(runner.providers[0]).toBe(base);
    expect(runner.calls.filter(call => call.command.executable === 'git').every(call => {
      const environment = call.options.env;
      return call.options.cwd === root && call.options.timeoutMs === 10_000 &&
        call.options.maxOutputBytes === assessmentLimits.fileBytes && environment?.GIT_CONFIG_GLOBAL === devNull &&
        environment.GIT_CONFIG_NOSYSTEM === '1' && environment.GIT_CONFIG_COUNT === '0' &&
        environment.GIT_OPTIONAL_LOCKS === '0' && environment.GIT_TERMINAL_PROMPT === '0';
    })).toBe(true);
    expect(await git(['rev-parse', 'HEAD'])).toBe(originalHead);
    expect(await readFile(path.join(root, 'untouched.txt'))).toEqual(original);
  });

  it('neutralizes actual ambient foreign Git/config bindings before choosing the provider namespace', async () => {
    const target = await nativeRepository(), foreign = await nativeRepository('https://github.com/foreign-org/foreign.git');
    vi.stubEnv('GIT_DIR', path.join(foreign.root, '.git'));
    vi.stubEnv('GIT_WORK_TREE', foreign.root);
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'remote.origin.url');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://github.com/injected-org/injected.git');
    const runner = new FixtureRunner(target.root, true);
    const result = await inspectProjectLiveMetadata({
      root: target.root, profile: 'single-maintainer-gitflow', environments: [], runner, now
    });
    expect(result.inputsStable).toBe(true);
    expect(runner.providers.length).toBeGreaterThan(0);
    expect(runner.providers.every(endpoint => endpoint === base || endpoint.startsWith(`${base}/`) ||
      endpoint === 'https://api.github.com/apps/github-actions')).toBe(true);
    expect(runner.calls.filter(call => call.command.executable === 'git').every(call =>
      call.options.env?.GIT_DIR === undefined && call.options.env?.GIT_WORK_TREE === undefined &&
      call.options.env?.GIT_CONFIG_KEY_0 === undefined && call.options.env?.GIT_CONFIG_VALUE_0 === undefined &&
      call.options.env?.GIT_CONFIG_COUNT === '0'
    )).toBe(true);
    expect(process.env.GIT_DIR).toBe(path.join(foreign.root, '.git'));
    expect(process.env.GIT_CONFIG_VALUE_0).toBe('https://github.com/injected-org/injected.git');
  });

  it('refuses an actual credential-bearing remote without provider dispatch or credential/disclosure/telemetry output', async () => {
    const credential = 'synthetic-private-origin-value';
    const { root } = await nativeRepository(`https://fixture:${credential}@github.com/${repository}.git`);
    const runner = new FixtureRunner(root, true);
    const noticeRead = vi.spyOn(telemetryConfig, 'readTelemetryNoticeVersion').mockRejectedValue(new Error('Unexpected disclosure read'));
    const noticeWrite = vi.spyOn(telemetryConfig, 'recordTelemetryNotice').mockRejectedValue(new Error('Unexpected disclosure write'));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const result = await invokePrivateCli(['assess', '--live', '--json', root], root, runner);
      expect(result.code).toBe(2);
      expect(result.stdout).not.toContain(credential);
      expect(result.stderr).not.toContain(credential);
      expect(result.stdout).not.toContain('fixture:');
      expect(runner.providers).toEqual([]);
      expect(noticeRead).not.toHaveBeenCalled();
      expect(noticeWrite).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      const report = JSON.parse(result.stdout);
      expect(report.outcome).toBe('partial');
      expect(report.findings.filter((finding: { id: string }) => finding.id.startsWith('live.')).every(
        (finding: { supported: boolean; classification: string; observed: { availability: string } }) =>
          !finding.supported && finding.classification === 'not-observed' && finding.observed.availability === 'not-observed'
      )).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it('preserves local findings, classification, coverage and digest under the independent unchanged public domain implementation', async () => {
  const root = await fixture(), runner = new FixtureRunner(root);
  const before = await assessProject({ start: root, explicitRoot: true });
  const findings = before.findings.map(finding => {
    const source = finding.observed.source;
    expect(['file', 'inventory', 'installed-source', undefined]).toContain(source?.kind);
    return originalFinding({ ...finding, observed: { ...finding.observed, source } });
  });
  expect(findings).toEqual(before.findings);
  const independent = originalReport({
    mode: before.mode, project: before.project, target: before.target, snapshot: before.snapshot,
    findings, diagnostics: before.diagnostics, limitations: before.limitations
  });
  const result = await invokePrivateCli(['assess', '--json', root], root, runner);
  expect(result.code).toBe(independent.exitCode);
  expect(JSON.parse(result.stdout)).toEqual(independent);
  expect(runner.calls).toEqual([]);
});

it.each(['missing-target', 'live-input', 'unstable-input', 'local-error'] as const)(
  'rejects %s local preparation before any Git or provider dispatch', async kind => {
    const root = await fixture(), runner = new FixtureRunner(root);
    const local = await assessProject({ start: root, explicitRoot: true });
    const prepared = originalReport({
      mode: kind === 'live-input' ? 'live' : 'local',
      project: local.project,
      target: kind === 'missing-target' ? null : local.target,
      snapshot: { ...local.snapshot, inputsStable: kind !== 'unstable-input' },
      findings: local.findings,
      diagnostics: kind === 'local-error'
        ? [{ code: 'local-preparation-failed', severity: 'error', message: 'Local preparation failed.' }] : local.diagnostics,
      limitations: local.limitations
    });
    await expect(inspectScopedLiveProject({
      inspectLocal: async () => prepared, runner, now
    })).rejects.toMatchObject({ providerAccessAttempted: false });
    expect(runner.calls).toEqual([]);
    expect(await readFile(path.join(root, 'untouched.txt'), 'utf8')).toBe('original application\n');
  }
);

it('preserves the original local error JSON limitations without provider requests', async () => {
  const root = await fixture(), runner = new FixtureRunner(root);
  const result = await invokePrivateCli(['assess', root, '--governance', 'invalid', '--json'], root, runner);
  expect(result).toMatchObject({ code: 1, stderr: '' });
  expect(JSON.parse(result.stdout).limitations).toEqual([
    'A trustworthy assessment could not be completed. No outer-root fallback, project mutation, script, network, enrollment or receipt was performed.'
  ]);
  expect(runner.calls).toEqual([]);
});

it('labels static-only limitations separately from dispatched live metadata', async () => {
  const root = await fixture(), runner = new FixtureRunner(root);
  const inspectLocal = () => assessProject({ start: root, explicitRoot: true });
  const local = await inspectLocal();
  const result = await inspectScopedLiveProject({ inspectLocal, runner, now });
  expect(runner.calls.some(call => call.command.executable === 'git')).toBe(true);
  expect(runner.providers.length).toBeGreaterThan(0);
  expect(result.limitations.slice(0, local.limitations.length)).toEqual(
    local.limitations.map(limitation => `Local observation scope: ${limitation}`)
  );
  expect(await inspectLocal()).toEqual(local);
});
