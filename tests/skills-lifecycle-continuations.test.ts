import path from 'node:path';
import os from 'node:os';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { parseArgs } from '../src/cli/args/parser.js';
import { executeSkillsUseCase, type SkillsCommandResult } from '../src/application/skills/use-case.js';
import { validateSkillsCommandRequest, type SkillsCommandOptions } from '../src/application/skills/request.js';
import { skillsLifecycleFollowUps } from '../src/application/skills/continuations.js';
import { formatSkillsFollowUps } from '../src/application/skills/output.js';
import { validateStructuredContinuation } from '../src/protocol/continuation.js';
import { skillsFixture, terminalStreams } from './helpers/skills-fixture.js';
import { CaptureStream } from './helpers.js';

describe('Genuine skills lifecycle continuations and nonexecuting target guidance', () => {
  let fixture: Awaited<ReturnType<typeof skillsFixture>>;
  beforeEach(async () => { fixture = await skillsFixture(); });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture.cleanup();
  });

  function request(extra: SkillsCommandOptions = {}): SkillsCommandOptions {
    return {
      subcommand: 'install', hosts: ['claude'], skillId: 'assess',
      scope: 'project', project: fixture.project, json: true, ...extra
    };
  }

  function command(result: SkillsCommandResult) {
    expect(result.nextActions).toHaveLength(1);
    const action = result.nextActions![0];
    expect(validateStructuredContinuation(action)).toEqual(action);
    const parsed = parseArgs([...action.args]);
    expect(parsed.command).toBe('skills');
    return { action, request: validateSkillsCommandRequest(parsed) };
  }

  it('emits an exact project approval action and follows it from another cwd without switching targets', async () => {
    const project = path.join(fixture.project, "project space; $literal 'quoted'");
    const elsewhere = path.join(fixture.cwd, 'other cwd');
    await mkdir(project);
    await mkdir(elsewhere);
    const options = request({ project: path.relative(fixture.cwd, project), check: true });
    const preview = await executeSkillsUseCase(options, { cwd: fixture.cwd }, fixture.dependencies);
    expect(preview.outcome).toBe('planned');
    if (preview.outcome !== 'planned') throw new Error('Expected a real issued plan.');
    const next = command(preview);
    expect(next.action).toMatchObject({
      schemaVersion: 1, cwd: fixture.cwd, project, scope: 'project', targetScope: 'project',
      requiredAuthority: ['exact-skills-plan-approval'], compatibilityIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(next.action).not.toHaveProperty('userInstallTarget');
    expect(next.request).toMatchObject({
      subcommand: 'install', project, scope: 'project', hosts: ['claude'], skillId: 'assess',
      check: false, approvePlan: preview.result.fingerprint, json: true
    });
    expect(await readdir(project)).toEqual([]);
    const applied = await executeSkillsUseCase(next.request, { cwd: elsewhere }, fixture.dependencies);
    expect(applied).toMatchObject({ outcome: 'executed', result: { committed: true, verified: true } });
    expect(await readFile(path.join(project, '.claude', 'commands', 'liftoff-assess.md'), 'utf8')).toContain('liftoff-assess');
    expect(await readdir(elsewhere)).toEqual([]);
    const inspection = command(applied);
    expect(inspection.request).toMatchObject({ subcommand: 'inspect', project, scope: 'project' });
    expect(inspection.action.requiredAuthority).toEqual([]);
    expect(inspection.request.approvePlan).toBeUndefined();
    const inspected = await executeSkillsUseCase(inspection.request, { cwd: fixture.cwd }, fixture.dependencies);
    expect(inspected).toMatchObject({ outcome: 'inspected', ok: true, nextActions: [], nextActionGuidance: [] });
  });

  it('serializes and executes the actual public CLI nextAction without granting target switching', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(fixture.dependencies.now!());
    vi.spyOn(os, 'homedir').mockReturnValue(fixture.home);
    vi.stubEnv('XDG_STATE_HOME', path.join(fixture.home, 'state'));
    vi.stubEnv('LOCALAPPDATA', path.join(fixture.home, 'AppData', 'Local'));
    await mkdir(path.join(fixture.project, '.git'));
    const otherTarget = path.join(fixture.project, 'other-target');
    await mkdir(otherTarget);
    const invoke = async (argv: string[], cwd = fixture.cwd) => {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const code = await runCli({ argv, cwd, stdout, stderr, env: { ...process.env, LIFTOFF_TELEMETRY: '0' } });
      return { code, report: JSON.parse(stdout.text()) as SkillsCommandResult };
    };
    const preview = await invoke([
      'skills', 'install', '--host', 'claude', '--skill', 'assess', '--check', '--json',
      '--scope', 'project', '--project', path.relative(fixture.cwd, fixture.project)
    ]);
    expect(preview.code).toBe(2);
    const next = command(preview.report);
    expect(next.action.cwd).toBe(fixture.cwd);
    expect(next.action.project).toBe(fixture.project);
    expect(next.action.requiredAuthority).toEqual(['exact-skills-plan-approval']);
    const redirected = [...next.action.args];
    redirected[redirected.indexOf('--project') + 1] = otherTarget;
    expect((await invoke(redirected)).code).toBe(1);
    expect(await readdir(otherTarget)).toEqual([]);
    await expect(readFile(path.join(fixture.project, '.claude', 'commands', 'liftoff-assess.md')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const applied = await invoke([...next.action.args], otherTarget);
    expect(applied).toMatchObject({ code: 0, report: { outcome: 'executed', result: { committed: true, verified: true } } });
    expect(command(applied.report).request).toMatchObject({ subcommand: 'inspect', project: fixture.project });
    expect(await readdir(otherTarget)).toEqual([]);
  });

  it('preserves selected remove intent instead of turning a preview into install or update', async () => {
    expect((await fixture.apply(request())).ok).toBe(true);
    const preview = await executeSkillsUseCase(request({ subcommand: 'remove', check: true }), { cwd: fixture.cwd }, fixture.dependencies);
    expect(preview.outcome).toBe('planned');
    if (preview.outcome !== 'planned') throw new Error('Expected removal preview.');
    const next = command(preview);
    expect(next.request).toMatchObject({
      subcommand: 'remove', skillId: 'assess', hosts: ['claude'], project: fixture.project,
      approvePlan: preview.result.fingerprint
    });
    expect(next.action.args).not.toContain('--check');
    expect(next.action.args).not.toContain('--yes');
  });

  it('keeps the genuine human approval journey free of a manual fingerprint command', async () => {
    const streams = terminalStreams();
    const preview = await executeSkillsUseCase(request({ json: false, check: true }), {
      cwd: fixture.cwd, stdin: streams.stdin, stderr: streams.stderr
    }, fixture.dependencies);
    const next = command(preview);
    expect(next.request.subcommand).toBe('install');
    expect(next.action.args).not.toContain('--approve-plan');
    expect(next.action.args).not.toContain('--yes');
    expect(next.action.requiredAuthority).toEqual(['exact-skills-plan-approval']);
    expect(await readdir(fixture.project)).toEqual([]);
  });

  it('records an actual personal target as guidance, never as an executable or invented project', async () => {
    const options = request({ scope: 'user', project: undefined, check: true });
    const preview = await executeSkillsUseCase(options, { cwd: fixture.cwd }, fixture.dependencies);
    expect(preview).toMatchObject({ outcome: 'planned', nextActions: [] });
    expect(preview.nextActionGuidance).toHaveLength(1);
    const guidance = preview.nextActionGuidance![0];
    expect(guidance).toMatchObject({
      executable: null, reasonCode: 'user-target-not-addressable',
      context: {
        cwd: fixture.cwd, userInstallTarget: fixture.home, scope: 'user', targetScope: 'user',
        requiredAuthority: ['exact-skills-plan-approval']
      }
    });
    expect(guidance.context).not.toHaveProperty('project');
    expect(guidance.context).not.toHaveProperty('displayCommand');
    expect(guidance.context).not.toHaveProperty('executable');
    expect(guidance.context?.args).not.toContain('--home');
    expect(guidance.context?.args).not.toContain('--project');
    expect(validateSkillsCommandRequest(parseArgs([...guidance.context!.args])).scope).toBe('user');
    expect(() => validateStructuredContinuation(guidance)).toThrow();
    expect(formatSkillsFollowUps(preview)).toContain('Nonexecuting guidance');
    expect(formatSkillsFollowUps(preview)).toContain(fixture.home);
    expect(await readdir(fixture.home)).toEqual([]);
    expect(await readdir(fixture.project)).toEqual([]);
    expect(await readdir(fixture.cwd)).toEqual([]);
  });

  it('keeps successful personal post-install inspection nonexecuting and target-bound', async () => {
    const result = await fixture.apply({ json: true });
    expect(result).toMatchObject({ outcome: 'executed', ok: true, nextActions: [] });
    const context = result.nextActionGuidance?.[0]?.context;
    expect(context).toMatchObject({
      userInstallTarget: fixture.home, targetScope: 'user', scope: 'user', cwd: fixture.cwd,
      requiredAuthority: []
    });
    expect(context).not.toHaveProperty('project');
    expect(validateSkillsCommandRequest(parseArgs([...context!.args])).subcommand).toBe('inspect');
    expect(context?.args).not.toContain('--approve-plan');
  });

  it('does not issue a mutating continuation for a collision or repeat a declined decision', async () => {
    await mkdir(path.join(fixture.project, '.claude', 'commands'), { recursive: true });
    const file = path.join(fixture.project, '.claude', 'commands', 'liftoff-assess.md');
    await writeFile(file, 'unowned custom command');
    const blocked = await executeSkillsUseCase(request({ check: true }), { cwd: fixture.cwd }, fixture.dependencies);
    expect(blocked).toMatchObject({
      outcome: 'blocked-plan', nextActions: [],
      nextActionGuidance: [{ executable: null, reasonCode: 'operation-blocked' }]
    });
    expect(await readFile(file, 'utf8')).toBe('unowned custom command');

    const streams = terminalStreams();
    const declinedTarget = path.join(fixture.project, 'declined-target');
    await mkdir(declinedTarget);
    const declined = await executeSkillsUseCase(request({ project: declinedTarget, json: false }), {
      cwd: fixture.cwd, stdin: streams.stdin, stderr: streams.stderr, approveUpdatePlan: async () => false
    }, fixture.dependencies);
    expect(declined).toMatchObject({ outcome: 'executed', result: { outcome: 'declined' }, nextActions: [], nextActionGuidance: [] });
  });

  it('uses the original privately sealed selection for a real pending transaction action', async () => {
    const options = request();
    const preview = await executeSkillsUseCase({ ...options, check: true }, { cwd: fixture.cwd }, fixture.dependencies);
    if (preview.outcome !== 'planned') throw new Error('Expected an issued plan.');
    const prepared = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const applying = executeSkillsUseCase({ ...options, approvePlan: preview.result.fingerprint }, { cwd: fixture.cwd }, {
      ...fixture.dependencies,
      onCheckpoint: async ({ phase }) => {
        if (phase === 'prepared') {
          prepared.resolve();
          await resume.promise;
        }
      }
    });
    try {
      await Promise.race([
        prepared.promise,
        applying.then(() => { throw new Error('The transaction finished before reaching its prepared checkpoint.'); })
      ]);
      const inspection = await executeSkillsUseCase({
        subcommand: 'inspect', scope: 'project', project: fixture.project, json: true
      }, { cwd: fixture.cwd }, fixture.dependencies);
      expect(inspection.outcome).toBe('inspected');
      const next = command(inspection);
      expect(next.request).toMatchObject({
        subcommand: 'install', hosts: ['claude'], skillId: 'assess', scope: 'project',
        project: fixture.project, approvePlan: preview.result.fingerprint
      });
      expect(next.action.requiredAuthority).toEqual(['original-recorded-effect-recovery']);
      expect(next.action.args).not.toContain('--recover');
    } finally {
      resume.resolve();
      expect((await applying).ok).toBe(true);
    }
  });

  it('does not erase a real committed outcome when follow-up context cannot be admitted', async () => {
    const applied = await fixture.apply(request());
    expect(applied).toMatchObject({ outcome: 'executed', result: { committed: true, verified: true } });
    const followUps = skillsLifecycleFollowUps(applied, request(), {
      cwd: 'relative-cwd', targetRoot: fixture.project, scope: 'project', machine: true
    });
    expect(followUps).toMatchObject({
      nextActions: [], nextActionGuidance: [{ executable: null, reasonCode: 'context-not-admitted' }]
    });
    expect({ ...applied, ...followUps }).toMatchObject({
      outcome: 'executed', ok: true, result: { committed: true, verified: true }
    });
  });
});
