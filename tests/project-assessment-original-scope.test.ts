import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessProject } from '../src/application/assessment/engine.js';
import { inspectScopedLiveProject } from '../src/application/assessment/live-report.js';
import { inspectProjectLiveMetadata } from '../src/adapters/assessment/live.js';
import { ApplicationFiles } from '../src/application/repair/application-files.js';
import type { ProjectAssessmentReport } from '../src/domain/assessment/report.js';
import type { CommandRunner, CommandResult, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';

const roots: string[] = [];
const repository = 'example-org/assessment';
const base = `https://api.github.com/repos/${repository}`;
const head = 'a'.repeat(40);
const observedAt = '2026-10-05T00:00:00.000Z';
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'assessment-original-scope-'));
  roots.push(root);
  await mkdir(path.join(root, '.git'));
  return root;
}

class ScopedRunner implements CommandRunner {
  readonly calls: { command: ExternalCommand; options: RunCommandOptions }[] = [];
  readonly providers: string[] = [];
  onFirstGit?: () => Promise<void>;
  onFirstProvider?: () => Promise<void>;
  origin = `https://github.com/${repository}.git`;
  private gitStarted = false;

  async run(command: ExternalCommand, options: RunCommandOptions = {}): Promise<CommandResult> {
    this.calls.push({ command: structuredClone(command), options: { ...options } });
    const result = (stdout: string): CommandResult => ({
      command, displayCommand: 'isolated scoped metadata fixture', status: 0, signal: null,
      stdout, stderr: '', timedOut: false
    });
    if (command.executable === 'git') {
      if (!this.gitStarted) { this.gitStarted = true; await this.onFirstGit?.(); }
      if (command.args.includes('--show-toplevel')) return result(options.cwd ?? '');
      if (command.args.includes('--verify')) return result(head);
      if (command.args.includes('--local') || command.args.includes('--push')) {
        return result(this.origin);
      }
      throw new Error('Unexpected Git metadata read.');
    }
    if (command.executable !== 'gh' || !command.args.includes('GET')) throw new Error('Only literal scoped metadata reads are permitted.');
    const endpoint = command.args.at(-1);
    if (!endpoint) throw new Error('Provider request omitted its endpoint.');
    this.providers.push(endpoint);
    if (this.providers.length === 1) await this.onFirstProvider?.();
    const url = new URL(endpoint);
    const ok = (value: unknown) => result(`HTTP/2.0 200 Fixture\r\n\r\n${JSON.stringify(value)}`);
    if (endpoint === base) return ok({
      id: 42, node_id: 'R_fixture', full_name: repository, default_branch: 'develop',
      security_and_analysis: { secret_scanning: { status: 'enabled' } }
    });
    if (endpoint === 'https://api.github.com/apps/github-actions') return ok({ id: 7, slug: 'github-actions' });
    if (!endpoint.startsWith(`${base}/`)) throw new Error('Provider read escaped the original repository.');
    if (url.pathname.endsWith('/rulesets') || url.pathname.includes('/rules/branches/')) return ok([]);
    if (url.pathname.endsWith('/branches')) return ok([{ name: 'main' }, { name: 'develop' }]);
    const branch = /\/branches\/([^/]+)$/u.exec(url.pathname)?.[1];
    if (branch) return ok({ name: decodeURIComponent(branch), commit: { sha: head }, protected: false });
    if (url.pathname.endsWith('/check-runs')) return ok({ total_count: 0, check_runs: [] });
    if (url.pathname.endsWith('/environments')) return ok({
      total_count: 2, environments: ['dev', 'prod'].map((name, index) => ({
        id: index + 1, name, protection_rules: [],
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false }
      }))
    });
    if (url.pathname.endsWith('/actions/workflows')) return ok({ total_count: 0, workflows: [] });
    throw new Error('Unexpected scoped provider endpoint.');
  }
}

async function localBoundary(
  mutate: (input: Parameters<typeof assessProject>[0]) => void,
  selection: Pick<Parameters<typeof assessProject>[0], 'governance'> = { governance: 'none' }
) {
  const root = await fixture();
  const input: Parameters<typeof assessProject>[0] = { start: root, explicitRoot: true, ...selection };
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const inventory = ApplicationFiles.prototype.inventory;
  let held = false;
  vi.spyOn(ApplicationFiles.prototype, 'inventory').mockImplementation(async function(
    this: ApplicationFiles, ...args: Parameters<typeof inventory>
  ) {
    const original = await inventory.apply(this, args);
    if (!held) { held = true; entered.resolve(); await resume.promise; }
    return original;
  });
  const pending = assessProject(input);
  await entered.promise;
  mutate(input);
  resume.resolve();
  return { input, report: await pending, root };
}

describe('assessment original requested scope', () => {
  it('keeps an unchanged explicitly selected comparison profile', async () => {
    const { report } = await localBoundary(() => {});
    expect(report.target).toMatchObject({ profile: 'none', profileSelection: 'explicit' });
    expect(report.outcome).toBe('partial');
    expect(report.exitCode).toBe(2);
  });

  it('cannot change its advisory comparison after actual directory observation', async () => {
    const observed = await localBoundary(input => { input.governance = 'team-gitflow'; });
    expect(observed.report.target).toMatchObject({ profile: 'none', profileSelection: 'explicit' });
    expect(observed.input.governance).toBe('team-gitflow');
  });

  it.each(['removed', 'invalid'] as const)('does not adopt a %s comparison after original validation', async kind => {
    const observed = await localBoundary(input => {
      if (kind === 'removed') delete input.governance;
      else Object.assign(input, { governance: 'not-a-profile' });
    });
    expect(observed.report.target).toMatchObject({ profile: 'none', profileSelection: 'explicit' });
    expect(observed.input.governance).toBe(kind === 'removed' ? undefined : 'not-a-profile');
  });

  it('cannot replace original implicit profile selection with a later explicit comparison', async () => {
    const observed = await localBoundary(input => { input.governance = 'none'; }, {});
    expect(observed.report.target).toMatchObject({ profile: 'single-maintainer-gitflow', profileSelection: 'default' });
    expect(observed.input.governance).toBe('none');
  });

  it('preserves its original local boundary and mode when the caller replaces the requested start and live flag', async () => {
    const other = await fixture();
    const observed = await localBoundary(input => { input.start = other; input.explicitRoot = false; input.live = true; });
    expect(observed.report.project.root).toBe(observed.root);
    expect(observed.report.mode).toBe('local');
    expect(observed.input).toMatchObject({ start: other, explicitRoot: false, live: true });
  });

  it('still rejects an invalid original comparison before filesystem observation', async () => {
    const inventory = vi.spyOn(ApplicationFiles.prototype, 'inventory');
    const input = { start: await fixture(), explicitRoot: true };
    Object.assign(input, { governance: 'not-a-profile' });
    await expect(assessProject(input)).rejects.toThrow();
    expect(inventory).not.toHaveBeenCalled();
  });

  it('retains original live root, profile, environment inventory and observation clock across the first Git await', async () => {
    const root = await fixture(), other = await fixture(), runner = new ScopedRunner();
    const input: Parameters<typeof inspectProjectLiveMetadata>[0] = {
      root, profile: 'none', environments: ['dev'], runner, now: () => new Date(observedAt)
    };
    runner.onFirstGit = async () => {
      input.root = other;
      input.profile = 'team-gitflow';
      Object.assign(input, { environments: ['prod'], now: () => new Date('2030-01-01T00:00:00.000Z') });
    };
    const report = await inspectProjectLiveMetadata(input);
    expect(runner.calls.filter(call => call.command.executable === 'git').every(call => call.options.cwd === root)).toBe(true);
    expect(runner.providers.some(endpoint => new URL(endpoint).pathname.includes('/branches'))).toBe(false);
    expect(report.observations['github.environments']?.value).toMatchObject([{ name: 'dev' }]);
    expect(report.observations['github.repository']?.source?.capturedAt).toBe(observedAt);
    expect(input.root).toBe(other);
    expect(input.profile).toBe('team-gitflow');
  });

  it.each(['root', 'profile', 'environments', 'clock'] as const)(
    'independently retains original live %s at the first Git read', async field => {
      const root = await fixture(), other = await fixture(), runner = new ScopedRunner(), environments = ['dev'];
      const input: Parameters<typeof inspectProjectLiveMetadata>[0] = {
        root, profile: 'none', environments, runner, now: () => new Date(observedAt)
      };
      runner.onFirstGit = async () => {
        if (field === 'root') input.root = other;
        if (field === 'profile') input.profile = 'team-gitflow';
        if (field === 'environments') environments.push('prod');
        if (field === 'clock') input.now = () => new Date('2030-01-01T00:00:00.000Z');
      };
      const report = await inspectProjectLiveMetadata(input);
      expect(report.inputsStable).toBe(true);
      expect(runner.calls.filter(call => call.command.executable === 'git').every(call => call.options.cwd === root)).toBe(true);
      expect(runner.providers.some(endpoint => new URL(endpoint).pathname.includes('/branches'))).toBe(false);
      expect(report.observations['github.environments']?.value).toMatchObject([{ name: 'dev' }]);
      expect(report.observations['github.repository']?.source?.capturedAt).toBe(observedAt);
      expect(runner.calls.every(call => call.command.executable === 'git' ||
        call.command.executable === 'gh' && call.command.args.includes('GET'))).toBe(true);
      if (field === 'environments') expect(environments).toEqual(['dev', 'prod']);
    }
  );

  it('keeps originally requested GitFlow refs when the caller later opts out', async () => {
    const root = await fixture(), runner = new ScopedRunner();
    const input: Parameters<typeof inspectProjectLiveMetadata>[0] = {
      root, profile: 'team-gitflow', environments: [], runner, now: () => new Date(observedAt)
    };
    runner.onFirstGit = async () => { input.profile = 'none'; };
    const report = await inspectProjectLiveMetadata(input);
    for (const ref of ['main', 'develop']) expect(runner.providers).toContain(`${base}/branches/${ref}`);
    expect(report.inputsStable).toBe(true);
    expect(input.profile).toBe('none');
  });

  it('does not acquire a replacement runner or an added clock after initial Git observation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(observedAt));
    const root = await fixture(), runner = new ScopedRunner(), replacement = vi.fn<CommandRunner['run']>();
    const input: Parameters<typeof inspectProjectLiveMetadata>[0] = { root, profile: 'none', environments: [], runner };
    runner.onFirstGit = async () => {
      input.runner = { run: replacement };
      input.now = () => new Date('2030-01-01T00:00:00.000Z');
    };
    const report = await inspectProjectLiveMetadata(input);
    expect(report.observations['github.repository']?.source?.capturedAt).toBe(observedAt);
    expect(replacement).not.toHaveBeenCalled();
    expect(input.runner?.run).toBe(replacement);
  });

  it('cannot relabel collected metadata through a caller-owned original local report', async () => {
    const root = await fixture(), other = await fixture(), runner = new ScopedRunner();
    let original: ProjectAssessmentReport | undefined;
    let expected: ProjectAssessmentReport | undefined;
    const inspectLocal = async () => {
      const report = await assessProject({ start: root, explicitRoot: true, governance: 'single-maintainer-gitflow' });
      if (!original) { original = report; expected = structuredClone(report); }
      return report;
    };
    runner.onFirstProvider = async () => {
      if (!original) throw new Error('Original local report unavailable.');
      original.project.root = other;
      if (!original.target) throw new Error('Original target unavailable.');
      original.target.profile = 'none';
      original.findings.splice(0);
      original.limitations.push('CALLER_ONLY_MUTATION');
    };
    const report = await inspectScopedLiveProject({ inspectLocal, runner, now: () => new Date(observedAt) });
    expect(expected).toBeDefined();
    expect(report.project).toEqual(expected?.project);
    expect(report.target).toEqual(expected?.target);
    expect(report.findings.filter(finding => !finding.id.startsWith('live.'))).toEqual(expected?.findings);
    expect(report.limitations.join(' ')).not.toContain('CALLER_ONLY_MUTATION');
    expect(original?.project.root).toBe(other);
    expect(original?.findings).toEqual([]);
    expect(report.outcome).toBe('partial');
    expect(report.exitCode).toBe(2);
  });

  it.each(['snapshot', 'diagnostics', 'finding'] as const)(
    'deeply retains original report %s while metadata reads suspend', async field => {
      const root = await fixture(), runner = new ScopedRunner();
      let original: ProjectAssessmentReport | undefined, expected: ProjectAssessmentReport | undefined;
      const inspectLocal = async () => {
        const report = await assessProject({ start: root, explicitRoot: true, governance: 'none' });
        if (!original) { original = report; expected = structuredClone(report); }
        return report;
      };
      runner.onFirstGit = async () => {
        if (!original) throw new Error('Original local report unavailable.');
        if (field === 'snapshot') original.snapshot.inventoryDigest = `sha256:${'b'.repeat(64)}`;
        if (field === 'diagnostics') original.diagnostics.push({
          code: 'caller-only', severity: 'error', message: 'CALLER_ONLY_MUTATION'
        });
        if (field === 'finding') original.findings[0].reason = 'CALLER_ONLY_MUTATION';
      };
      const report = await inspectScopedLiveProject({ inspectLocal, runner, now: () => new Date(observedAt) });
      expect(report.snapshot.inventoryDigest).toBe(expected?.snapshot.inventoryDigest);
      expect(report.findings.filter(finding => !finding.id.startsWith('live.'))).toEqual(expected?.findings);
      expect(report.diagnostics.some(diagnostic => diagnostic.code === 'caller-only')).toBe(false);
      expect(report.outcome).toBe('partial');
      expect(report.exitCode).toBe(2);
      expect(report.findings.filter(finding => finding.id.startsWith('live.')).every(finding => !finding.supported)).toBe(true);
    }
  );

  it('preserves already captured callbacks when the outer coordinator input is replaced', async () => {
    const root = await fixture(), runner = new ScopedRunner(), replacement = vi.fn<() => Promise<ProjectAssessmentReport>>();
    const input: Parameters<typeof inspectScopedLiveProject>[0] = {
      inspectLocal: () => assessProject({ start: root, explicitRoot: true, governance: 'none' }),
      runner, now: () => new Date(observedAt)
    };
    runner.onFirstProvider = async () => {
      input.inspectLocal = replacement;
      input.runner = { run: vi.fn<CommandRunner['run']>() };
      input.now = () => new Date('2030-01-01T00:00:00.000Z');
    };
    const report = await inspectScopedLiveProject(input);
    expect(report.outcome).toBe('partial');
    expect(replacement).not.toHaveBeenCalled();
    expect(input.inspectLocal).toBe(replacement);
    const source = report.findings.find(finding => finding.id === 'live.github.repository')?.observed.source;
    if (source?.kind !== 'github') throw new Error('Original GitHub provenance unavailable.');
    expect(source.capturedAt).toBe(observedAt);
  });

  it('keeps the original report root through its first and final Git read windows', async () => {
    const root = await fixture(), other = await fixture(), runner = new ScopedRunner();
    let original: ProjectAssessmentReport | undefined;
    runner.onFirstGit = async () => {
      if (!original) throw new Error('Original local report unavailable.');
      original.project.root = other;
    };
    const report = await inspectScopedLiveProject({
      inspectLocal: async () => {
        const observed = await assessProject({ start: root, explicitRoot: true, governance: 'none' });
        original ??= observed;
        return observed;
      },
      runner, now: () => new Date(observedAt)
    });
    expect(report.project.root).toBe(root);
    expect(runner.calls.filter(call => call.command.executable === 'git').every(call => call.options.cwd === root)).toBe(true);
    expect(original?.project.root).toBe(other);
  });

  it('still marks actual original Git binding drift as unstable without undoing it', async () => {
    const root = await fixture(), runner = new ScopedRunner();
    runner.onFirstProvider = async () => { runner.origin = 'https://github.com/other/changed.git'; };
    const report = await inspectProjectLiveMetadata({
      root, profile: 'none', environments: [], runner, now: () => new Date(observedAt)
    });
    expect(report.inputsStable).toBe(false);
    expect(report.diagnostics.some(diagnostic => diagnostic.code === 'live-project-git-changed')).toBe(true);
    expect(runner.origin).toBe('https://github.com/other/changed.git');
    expect(runner.providers.every(endpoint => endpoint.startsWith(base) ||
      endpoint === 'https://api.github.com/apps/github-actions')).toBe(true);
  });

  it.each(['local-request', 'live-request', 'local-report'] as const)(
    'does not acquire unrelated enumerable capabilities from a %s', async kind => {
      const root = await fixture(), runner = new ScopedRunner();
      const acquire = vi.fn(() => { throw new Error('Unrelated writer capability was acquired.'); });
      const withUnrelatedCapability = <T extends object>(value: T): T => {
        Object.defineProperty(value, 'writer', { enumerable: true, get: acquire });
        return value;
      };
      if (kind === 'local-request') {
        const report = await assessProject(withUnrelatedCapability({ start: root, explicitRoot: true }));
        expect(report.outcome).toBe('partial');
      } else if (kind === 'live-request') {
        const report = await inspectProjectLiveMetadata(withUnrelatedCapability({
          root, profile: 'none' as const, environments: [], runner, now: () => new Date(observedAt)
        }));
        expect(report.inputsStable).toBe(true);
      } else {
        const report = await inspectScopedLiveProject({
          inspectLocal: async () => withUnrelatedCapability(await assessProject({ start: root, explicitRoot: true })),
          runner, now: () => new Date(observedAt)
        });
        expect(report.outcome).toBe('partial');
      }
      expect(acquire).not.toHaveBeenCalled();
    }
  );
});
