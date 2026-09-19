import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdir } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { skillsCommand } from '../src/cli/commands/skills.js';
import { validateSkillsCommandRequest } from '../src/application/skills/request.js';
import type { ExecutionContext } from '../src/application/context.js';
import type { ParsedArgs } from '../src/domain/project/contracts.js';
import { skillsFixture, terminalStreams } from './helpers/skills-fixture.js';

describe('Skills strict CLI handler and genuine plan approval', () => {
  let fixture: Awaited<ReturnType<typeof skillsFixture>>;
  beforeEach(async () => { fixture = await skillsFixture(); });
  afterEach(async () => { await fixture.cleanup(); });
  const text = (stream: PassThrough): string => stream.read()?.toString('utf8') ?? '';
  function context(terminal = false): ExecutionContext & { stdout: PassThrough; stderr: PassThrough } {
    const streams = terminal ? terminalStreams() : { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() };
    return { cwd: fixture.cwd, ...streams, presentation: {} as ExecutionContext['presentation'] };
  }
  function parsed(subcommand: string, flags: ParsedArgs['flags'] = {}): ParsedArgs {
    return { command: 'skills', subcommand, positional: [], flags };
  }

  it('uses parsed.subcommand and emits only the new schemaVersion-1 envelope', async () => {
    const ctx = context();
    expect(await skillsCommand(parsed('list', { json: true }), ctx, fixture.dependencies)).toBe(0);
    const result = JSON.parse(text(ctx.stdout));
    expect(result).toMatchObject({ schemaVersion: 1, command: 'skills', subcommand: 'list', outcome: 'listed', exitCode: 0 });
    expect(result.schema).toBeUndefined();
    expect(result.result.skills).toHaveLength(11);
    expect(await readdir(fixture.home)).toEqual([]);
  });

  it('rejects an unknown subcommand and extra positional arguments instead of silently listing', async () => {
    for (const input of [parsed('unknown'), { ...parsed('list'), positional: ['install'] }]) {
      const ctx = context();
      input.flags.json = true;
      expect(await skillsCommand(input, ctx, fixture.dependencies)).toBe(1);
      const result = JSON.parse(text(ctx.stdout));
      expect(result.outcome).toBe('invalid');
      expect(result.result.skills).toBeUndefined();
    }
  });

  it.each(['yes', 'force', 'apply', 'home', 'dry-run', 'plan-only', 'verify-plan'])('rejects --%s before any target effects', async (flag) => {
    const ctx = context();
    expect(await skillsCommand(parsed('install', { host: 'claude', [flag]: true, json: true }), ctx, fixture.dependencies)).toBe(1);
    expect(JSON.parse(text(ctx.stdout)).result.message).toContain(`--${flag}`);
    expect(await readdir(fixture.home)).toEqual([]);
  });

  it.each([
    {},
    { host: 'all' },
    { host: 'claude,,codex' },
    { host: 'copilot,github-copilot' },
    { host: ['claude', 'codex'] },
    { host: true },
    { host: 'claude', scope: 'unknown' },
    { host: 'claude', scope: 'user', project: 'some-project' },
    { host: 'claude', skill: 'custom' },
    { host: 'claude', 'approve-plan': 'A'.repeat(64) },
    { host: 'claude', 'approve-plan': 'a'.repeat(63) },
    { host: 'claude', 'approve-plan': 'a'.repeat(64), check: true }
  ] satisfies ParsedArgs['flags'][])('strictly rejects invalid hosts, scope, skills, and approval input: %j', (flags) => {
    expect(() => validateSkillsCommandRequest(parsed('install', flags))).toThrow();
  });

  it('keeps update/remove operation intent when --check requests a preview', async () => {
    expect((await fixture.apply()).ok).toBe(true);
    for (const subcommand of ['update', 'remove']) {
      const ctx = context();
      const code = await skillsCommand(parsed(subcommand, { host: 'claude', skill: 'assess', check: true, json: true }), ctx, fixture.dependencies);
      const result = JSON.parse(text(ctx.stdout));
      expect(code).toBe(subcommand === 'remove' ? 2 : 0);
      expect(result.outcome).toBe('planned');
      expect(result.subcommand).toBe(subcommand);
      expect(result.result.intent).toBe(subcommand);
      expect(result.result.actions[0].action).toBe(subcommand === 'remove' ? 'remove' : 'retain');
    }
  });

  it('renders install returned as preview rather than an undefined success-shaped count', async () => {
    const ctx = context();
    expect(await skillsCommand(parsed('install', { host: 'claude', skill: 'assess' }), ctx, fixture.dependencies)).toBe(2);
    const output = text(ctx.stdout);
    expect(output).toContain('Skills install Plan');
    expect(output).toContain('Preview only. No writes occurred');
    expect(output).not.toMatch(/Successfully|undefined/);
    expect(await readdir(fixture.home)).toEqual([]);
  });

  it('displays the immutable plan before a genuine default-No prompt without manual hash entry', async () => {
    const ctx = context(true);
    const prompt = vi.fn(async (config: { message: string; default: false }) => {
      const preview = text(ctx.stderr);
      expect(preview).toContain('Skills install Plan');
      expect(preview).toMatch(/Plan Fingerprint: [a-f0-9]{64}/);
      expect(config.default).toBe(false);
      expect(config.message).toContain('user-scope skills install');
      expect(await readdir(fixture.home)).toEqual([]);
      return true;
    });
    ctx.approveUpdatePlan = prompt;
    expect(await skillsCommand(parsed('install', { host: 'claude', skill: 'assess' }), ctx, fixture.dependencies)).toBe(0);
    expect(prompt).toHaveBeenCalledOnce();
    expect(text(ctx.stdout)).toContain('Applied and independently read back');
  });

  it.each(['json', 'input-not-tty', 'output-not-tty', 'destroyed-input', 'declined', 'cancelled'] as const)(
    'does not infer mutation authority from %s',
    async (mode) => {
      const ctx = context(true);
      const prompt = vi.fn(async () => {
        if (mode === 'cancelled') throw Object.assign(new Error('cancelled'), { name: 'ExitPromptError' });
        return false;
      });
      ctx.approveUpdatePlan = prompt;
      if (mode === 'input-not-tty') Object.assign(ctx.stdin!, { isTTY: false });
      if (mode === 'output-not-tty') Object.assign(ctx.stderr, { isTTY: false });
      if (mode === 'destroyed-input') ctx.stdin!.destroy();
      const code = await skillsCommand(parsed('install', {
        host: 'claude', skill: 'assess', ...(mode === 'json' ? { json: true } : {})
      }), ctx, fixture.dependencies);
      expect(code).toBe(2);
      expect(prompt).toHaveBeenCalledTimes(mode === 'declined' || mode === 'cancelled' ? 1 : 0);
      expect(await readdir(fixture.home)).toEqual([]);
      if (mode === 'json') {
        const result = JSON.parse(text(ctx.stdout));
        expect(result.outcome).toBe('planned');
        expect(text(ctx.stderr)).toBe('');
      }
    }
  );

  it('accepts only the exact complete machine fingerprint and never treats a mismatch as success', async () => {
    const rejected = context();
    expect(await skillsCommand(parsed('install', {
      host: 'claude', skill: 'assess', 'approve-plan': '0'.repeat(64), json: true
    }), rejected, fixture.dependencies)).toBe(1);
    expect(JSON.parse(text(rejected.stdout)).result.outcome).toBe('blocked');
    expect(await readdir(fixture.home)).toEqual([]);
    const plan = await fixture.preview();
    const approved = context();
    expect(await skillsCommand(parsed('install', {
      host: 'claude', skill: 'assess', 'approve-plan': plan.fingerprint, json: true
    }), approved, fixture.dependencies)).toBe(0);
    expect(JSON.parse(text(approved.stdout)).result).toMatchObject({ outcome: 'applied', committed: true, verified: true });
  });

  it('reports missing project ownership without a fabricated successful migration', async () => {
    const ctx = context();
    expect(await skillsCommand(parsed('migrate', { host: 'claude', project: fixture.project, check: true }), ctx, fixture.dependencies)).toBe(1);
    const output = text(ctx.stdout);
    expect(output).toContain('transport inspection is blocked');
    expect(output).toContain('requires a valid existing Liftoff manifest');
    expect(output).not.toContain('Migrated 0');
    expect(await readdir(fixture.project)).toEqual([]);
  });
});
