import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectRepairVerificationWorkspaces } from '../src/application/repair/workspaces.js';
import {
  TemporaryDirectories, ScriptedRunner, backendNpmCi, commandResult, createCommandFlowFixture, isNpmCi,
  promptCancellation, repairHuman, repairJson, simulateNpmCi, snapshotTree, userRecordFiles, type CommandFlowFixture
} from './fixtures/repair-branches.js';

const directories = new TemporaryDirectories();
afterEach(async () => { await directories.cleanup(); });

const isCheck = (args: readonly string[]) => args.includes('--test');
const outside = (root: string, cwd: string | undefined) => cwd !== undefined && path.relative(root, cwd).startsWith('..');

async function fixture(options: Parameters<typeof createCommandFlowFixture>[1] = {}) {
  const f = await createCommandFlowFixture(await directories.make("lf cancel's "), options);
  return { f, project: await snapshotTree(f.root), staging: await snapshotTree(f.stage) };
}

async function expectNoProjectOrPrivateEffects(f: CommandFlowFixture, project: Record<string, string>, staging: Record<string, string>) {
  expect(await snapshotTree(f.root)).toEqual(project);
  expect(await snapshotTree(f.stage)).toEqual(staging);
  expect(await userRecordFiles(f.home, 'repair-verification')).toEqual([]);
  expect(await userRecordFiles(f.home, 'repair-backup')).toEqual([]);
  expect((await inspectRepairVerificationWorkspaces(f.root, { homedir: f.home, env: {} })).status).toBe('absent');
}

describe('consent cancellation before independently authorized effects', () => {
  it.each(['declined', 'cancelled'] as const)(
    'stops at %s dependency-preparation consent before preparation, checks, workspaces or receipts', async (answer) => {
      const { f, project, staging } = await fixture({ preparation: [backendNpmCi()] });
      const runner = new ScriptedRunner();
      const prompts: string[] = [];
      const result = await repairHuman(f.root, ['--application-patch', f.patch], { home: f.home, runner }, async (config) => {
        expect(config.default).toBe(false);
        prompts.push(config.message);
        if (answer === 'cancelled') throw promptCancellation();
        return false;
      });
      expect(result.code).toBe(2);
      expect(prompts).toEqual([expect.stringContaining('Restore locked dependencies in an isolated copy')]);
      expect(result.stdout).toContain(
        'Dependency preparation consent was declined or cancelled. No preparation, project command or application file transaction ran.');
      expect(runner.effects()).toEqual([]);
      expect(runner.calls.length).toBeGreaterThan(0);
      expect(runner.calls.every((call) => outside(f.root, call.options?.cwd))).toBe(true);
      await expectNoProjectOrPrivateEffects(f, project, staging);
    });

  it.each(['declined', 'cancelled'] as const)(
    'does not start granted preparation when the later verification consent is %s', async (answer) => {
      const { f, project, staging } = await fixture({ preparation: [backendNpmCi()] });
      const runner = new ScriptedRunner((call) => isNpmCi(call.command) ? simulateNpmCi(call) : undefined);
      const prompts: string[] = [];
      const result = await repairHuman(f.root, ['--application-patch', f.patch], { home: f.home, runner }, async (config) => {
        prompts.push(config.message);
        if (prompts.length === 1) return true;
        if (answer === 'cancelled') throw promptCancellation();
        return false;
      });
      expect(result.code).toBe(2);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('Run the displayed exact project verification commands');
      expect(result.stdout).toContain('Verification consent was declined or cancelled. No project command or application file transaction ran.');
      expect(runner.effects()).toEqual([]);
      await expectNoProjectOrPrivateEffects(f, project, staging);
    });

  it('stops at a cancelled network consent before any declared-network check runs', async () => {
    const { f, project, staging } = await fixture({ network: true });
    const runner = new ScriptedRunner();
    const prompts: string[] = [];
    const result = await repairHuman(f.root, ['--application-patch', f.patch], { home: f.home, runner }, async (config) => {
      prompts.push(config.message);
      if (prompts.length === 2) throw promptCancellation();
      return true;
    });
    expect(result.code).toBe(2);
    expect(prompts[1]).toContain('Additionally allow the displayed declared network effects');
    expect(result.stdout).toContain('Network consent was not granted. No verification command or application file transaction ran.');
    expect(runner.calls).toEqual([]);
    await expectNoProjectOrPrivateEffects(f, project, staging);
  });

  it('never treats piped input as dependency-preparation consent', async () => {
    const { f, project, staging } = await fixture({ preparation: [backendNpmCi()] });
    const runner = new ScriptedRunner();
    const prompt = async () => { throw new Error('A non-interactive stream must not reach an approval prompt.'); };
    const result = await repairHuman(f.root, ['--application-patch', f.patch], { home: f.home, runner }, prompt,
      Readable.from(['yes\nyes\nyes\n']));
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('No verification command or application file transaction has run.');
    expect(result.stdout).not.toContain('consent was declined or cancelled');
    expect(runner.effects()).toEqual([]);
    await expectNoProjectOrPrivateEffects(f, project, staging);
  });
});

describe('cancellation after independently authorized effects', () => {
  it('reports retained preparation/check effects after cancelled file consent and reuses only the exact receipt', async () => {
    const { f, project, staging } = await fixture({ preparation: [backendNpmCi()] });
    const runner = new ScriptedRunner((call) => isNpmCi(call.command) ? simulateNpmCi(call) : undefined);
    const preview = await repairJson(f.root, ['--check', '--application-patch', f.patch], { home: f.home, runner });
    expect(preview.report.status).toBe('available');
    const fingerprint = preview.report.fingerprint!;

    const cancelled = await repairHuman(f.root, ['--application-patch', f.patch], { home: f.home, runner }, async (config) => {
      if (config.message.includes('Apply the displayed exact application file changes')) throw promptCancellation();
      return true;
    });
    expect(cancelled.code).toBe(2);
    expect(cancelled.stdout).toContain('earlier separately authorized verifier effects are not rolled back');
    expect(cancelled.stdout).toContain('Locked dependency preparation was separately authorized in a private environment.');
    const effects = runner.effects();
    expect(effects.filter((call) => isNpmCi(call.command))).toHaveLength(1);
    expect(effects.filter((call) => isCheck(call.command.args))).toHaveLength(1);
    expect(effects.every((call) => outside(f.root, call.options?.cwd))).toBe(true);
    expect(await snapshotTree(f.root)).toEqual(project);
    expect(await snapshotTree(f.stage)).toEqual(staging);
    expect(await userRecordFiles(f.home, 'repair-preview')).toHaveLength(1);
    expect(await userRecordFiles(f.home, 'repair-verification')).toHaveLength(1);
    expect(await userRecordFiles(f.home, 'repair-backup')).toEqual([]);
    expect((await inspectRepairVerificationWorkspaces(f.root, { homedir: f.home, env: {} })).status).toBe('absent');

    const applied = await repairHuman(f.root, ['--approve-plan', fingerprint], { home: f.home, runner }, async () => {
      throw new Error('Exact automation must not prompt again.');
    });
    expect(applied.code, applied.stdout).toBe(0);
    expect(applied.stdout).toContain('Previously approved checks match this unchanged candidate; no verification command was rerun.');
    expect(runner.effects()).toHaveLength(effects.length);
    expect(await readFile(path.join(f.root, ...f.target), 'utf8')).toBe(f.sourceBytes);
    expect(await readFile(path.join(f.root, ...f.check), 'utf8')).toBe(f.newTest);
    await expect(lstat(path.join(f.root, ...f.source))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(f.root, 'backend', 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await userRecordFiles(f.home, 'repair-backup')).not.toEqual([]);
  });

  it('does not reuse a receipt for a later interactive review of the same bytes', async () => {
    const { f, project } = await fixture();
    const runner = new ScriptedRunner();
    let instant = new Date('2026-09-13T12:00:00Z');
    const first = await repairHuman(f.root, ['--application-patch', f.patch], { home: f.home, runner, clock: () => instant },
      async (config) => config.message.includes('Apply the displayed') ? false : true);
    expect(first.code).toBe(2);
    expect(runner.effects()).toHaveLength(1);
    instant = new Date(instant.getTime() + 60_000);
    const prompts: string[] = [];
    const second = await repairHuman(f.root, ['--application-patch', f.patch], { home: f.home, runner, clock: () => instant },
      async (config) => { prompts.push(config.message); return false; });
    expect(second.code).toBe(2);
    expect(prompts).toEqual([expect.stringContaining('Run the displayed exact project verification commands')]);
    expect(second.stdout).not.toContain('Previously approved checks match');
    expect(runner.effects()).toHaveLength(1);
    expect(await snapshotTree(f.root)).toEqual(project);
  });

  it.each([
    ['aborted runner result', { status: null, aborted: true, errorCode: 'ABORT_ERR' }],
    ['SIGINT termination', { status: null, signal: 'SIGINT' as const }]
  ])('reports an interrupted check (%s) as partial effects without a receipt or file transaction', async (_name, interruption) => {
    const { f, project, staging } = await fixture();
    const runner = new ScriptedRunner((call) => isCheck(call.command.args) ? commandResult(call.command, interruption) : undefined);
    const preview = await repairJson(f.root, ['--check', '--application-patch', f.patch], { home: f.home, runner });
    const fingerprint = preview.report.fingerprint!;
    const verified = await repairJson(f.root, ['--verify-plan', fingerprint], { home: f.home, runner });
    expect(verified.code).toBe(2);
    expect(verified.report).toMatchObject({ status: 'partial', committed: false, verification: 'incomplete' });
    expect(verified.report.verificationEffects).toMatchObject({ attempted: true, outcome: 'incomplete' });
    expect(verified.report.blockers.join(' ')).toContain('[interrupted]');
    expect(verified.report.blockers.join(' ')).toContain('Earlier verifier effects are not undone');
    expect(verified.report.verificationResult).toMatchObject({ status: 'failed', cleanupComplete: true, inspectedProjectUnchanged: true });
    expect(verified.report.verificationResult!.commands).toEqual([expect.objectContaining({ passed: false, status: null })]);
    expect(verified.report.verificationReceipt).toBeUndefined();

    const apply = await repairJson(f.root, ['--approve-plan', fingerprint], { home: f.home, runner });
    expect(apply.code).toBe(2);
    expect(apply.report).toMatchObject({ status: 'blocked', committed: false });
    expect(apply.report.message).toContain('File approval does not authorize project checks');
    expect(runner.effects()).toHaveLength(1);
    await expectNoProjectOrPrivateEffects(f, project, staging);
  });

  it('stops an interrupted frozen preparation before any project check and reports the actual attempt', async () => {
    const { f, project, staging } = await fixture({ preparation: [backendNpmCi()] });
    const runner = new ScriptedRunner((call) => isNpmCi(call.command)
      ? commandResult(call.command, { status: null, aborted: true, errorCode: 'ABORT_ERR', stderr: 'CANARY_REGISTRY_TOKEN' })
      : undefined);
    const preview = await repairJson(f.root, ['--check', '--application-patch', f.patch], { home: f.home, runner });
    const verified = await repairJson(f.root, ['--verify-plan', preview.report.fingerprint!, '--allow-dependency-preparation'], {
      home: f.home, runner
    });
    expect(verified.code).toBe(2);
    expect(verified.report).toMatchObject({ status: 'partial', committed: false });
    expect(verified.report.verificationEffects).toMatchObject({ attempted: true, dependencyPreparationAuthorized: true });
    const blockers = verified.report.blockers.join(' ');
    expect(blockers).toContain('Locked preparation:');
    expect(blockers).toContain('[interrupted]');
    expect(blockers).toContain('[preparation-failed]');
    expect(JSON.stringify(verified.report)).not.toContain('CANARY_');
    expect(verified.report.verificationResult!.preparation).toEqual([
      expect.objectContaining({ provider: 'npm-ci', status: 'failed', commands: [expect.objectContaining({ passed: false })] })
    ]);
    expect(verified.report.verificationResult!.commands).toEqual([]);
    expect(runner.effects().map((call) => isNpmCi(call.command))).toEqual([true]);
    await expectNoProjectOrPrivateEffects(f, project, staging);
  });
});
