import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { parseArgs } from '../../src/args.js';
import { installationCommand, type InstallationCommandContext } from '../../src/cli/commands/installation.js';
import { validateStructuredContinuation } from '../../src/protocol/continuation.js';
import { DirectInstallerAdapter } from '../../src/adapters/distribution/direct-installer-adapter.js';
import { PresentationSession } from '../../src/terminal.js';
import { CaptureStream } from '../helpers.js';
import { readTree, signedFixture, type SignedFixture } from './native-fixture.js';

const fixtures: SignedFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });
async function fixture(name: string) { const value = await signedFixture(name); fixtures.push(value); return value; }

function context(value: SignedFixture, tty = false) {
  const stdout = new CaptureStream();
  const stderr = Object.assign(new CaptureStream(), { isTTY: tty });
  const stdin = Object.assign(new PassThrough(), { isTTY: tty });
  const prompt = vi.fn(async () => false);
  const context: InstallationCommandContext = {
    cwd: value.project, stdout, stderr, stdin, env: value.env, runner: value.runner,
    installationDetector: value.detector, receiptStore: value.store, approveMigrationPlan: prompt,
    installationNow: value.reviewNow,
    presentation: new PresentationSession({ stdout, stderr, env: value.env, color: false })
  };
  return { context, stdout, stderr, stdin, prompt };
}

function migrateArgs(value: SignedFixture, tail: string[] = []) {
  return ['installation', 'migrate', '--to', 'direct', '--candidate', path.relative(value.project, value.candidate),
    '--destination', path.relative(value.project, value.installRoot), '--launcher', path.relative(value.project, value.launcher), ...tail];
}

describe('installation presentation and command-specific authorization', () => {
  it('emits one schema-1 inspection result without creating notice, receipt, or project state', async () => {
    const value = await fixture('cli-inspection');
    const output = context(value);
    expect(await installationCommand(parseArgs(['installation', 'inspect', '--json']), output.context)).toBe(0);
    const result = JSON.parse(output.stdout.text());
    expect(result).toMatchObject({ schemaVersion: 1, mode: 'inspect', status: 'unlinked-candidate' });
    expect(result.inspection.pathResolution.effectiveLauncher).toBe(value.legacyLauncher);
    expect(output.stdout.text().trim().split('\n')).toHaveLength(1);
    expect(output.stderr.text()).toBe('');
    expect(output.prompt).not.toHaveBeenCalled();
    await expect(access(value.store.baseDirectory)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('keeps JSON+TTY and bare non-TTY migration as preview-only, with cwd-relative targets bound exactly', async () => {
    const value = await fixture('json-tty-preview');
    const output = context(value, true);
    const code = await installationCommand(parseArgs(migrateArgs(value, ['--json'])), output.context);
    expect(code).toBe(0);
    const result = JSON.parse(output.stdout.text());
    expect(result.mode).toBe('migration-preview');
    expect(result.plan.targetInstallation.candidatePath).toBe(value.candidate);
    expect(result.plan.targetInstallation.destinationDirectory).toBe(value.installRoot);
    expect(result.nextActions).toHaveLength(1);
    const continuation = validateStructuredContinuation(result.nextActions[0]);
    expect(continuation).toMatchObject({
      executable: path.join(value.candidate, 'bin', 'liftoff'), cwd: value.project,
      scope: 'installation', targetScope: 'installation', userInstallTarget: value.installRoot,
      requiredAuthority: ['exact-installation-plan'], compatibilityIdentity: result.plan.planFingerprint
    });
    expect(continuation.project).toBeUndefined();
    expect(parseArgs([...continuation.args]).flags).toEqual({
      to: 'direct', candidate: value.candidate, destination: value.installRoot, launcher: value.launcher,
      'approve-plan': result.plan.planFingerprint, json: true
    });
    expect(output.prompt).not.toHaveBeenCalled();
    expect(output.stderr.text()).toBe('');
    expect(value.runner.calls.every((call) => call.options?.cwd !== value.project)).toBe(true);
    await access(value.legacyLauncher);
    await expect(access(value.store.baseDirectory)).rejects.toHaveProperty('code', 'ENOENT');
    const human = context(value);
    expect(await installationCommand(parseArgs(migrateArgs(value)), human.context)).toBe(0);
    expect(human.stdout.text()).toContain('Installation plan');
    expect(human.stdout.text()).toContain('Continuation working directory');
    expect(human.stdout.text()).toContain(path.join(value.candidate, 'bin', 'liftoff'));
    expect(human.prompt).not.toHaveBeenCalled();
    const checked = context(value, true);
    expect(await installationCommand(parseArgs(migrateArgs(value, ['--check', '--json'])), checked.context)).toBe(0);
    const checkedAction = validateStructuredContinuation(JSON.parse(checked.stdout.text()).nextActions[0]);
    expect(checkedAction.args).not.toContain('--check');
    expect(checkedAction.requiredAuthority).toEqual(['exact-installation-plan']);
    expect(checked.prompt).not.toHaveBeenCalled();
    await access(value.legacyLauncher);
    await expect(access(value.store.baseDirectory)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('rejects candidate, destination, or launcher changes when replaying an exact continuation', async () => {
    const value = await fixture('changed-continuation-target');
    const preview = context(value, true);
    expect(await installationCommand(parseArgs(migrateArgs(value, ['--json'])), preview.context)).toBe(0);
    const continuation = validateStructuredContinuation(JSON.parse(preview.stdout.text()).nextActions[0]);
    const otherCandidate = path.join(value.home, 'another signed candidate');
    await cp(value.candidate, otherCandidate, { recursive: true, errorOnExist: true, force: false });
    for (const [flag, replacement] of [
      ['--candidate', otherCandidate],
      ['--destination', path.join(value.home, 'another native destination')],
      ['--launcher', value.legacyLauncher]
    ]) {
      const args = [...continuation.args];
      const index = args.indexOf(flag);
      if (index === -1) throw new Error('The continuation must bind every installation path.');
      args[index + 1] = replacement;
      const output = context(value, true);
      expect(await installationCommand(parseArgs(args), output.context)).toBe(1);
      expect(JSON.parse(output.stdout.text())).toMatchObject({
        schemaVersion: 1, status: 'blocked', reasonCode: 'stale_plan'
      });
      expect(output.prompt).not.toHaveBeenCalled();
    }
    expect(value.runner.calls.some((call) => call.command.args[0] === 'uninstall')).toBe(false);
    await access(value.legacyLauncher);
    await expect(access(value.store.baseDirectory)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('renders the immutable plan before default-No terminal confirmation, and decline preserves every installation', async () => {
    const value = await fixture('tty-decline');
    const output = context(value, true);
    output.prompt.mockImplementation(async () => {
      expect(output.stdout.text()).toContain('Fingerprint');
      return false;
    });
    expect(await installationCommand(parseArgs(migrateArgs(value)), output.context)).toBe(1);
    expect(output.prompt).toHaveBeenCalledWith(expect.objectContaining({ default: false }), expect.objectContaining({ input: output.stdin }));
    await access(value.legacyLauncher);
    await expect(access(value.store.baseDirectory)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('captures malformed target resolution and recovery failures inside the single JSON result boundary', async () => {
    const value = await fixture('json-errors');
    await writeFile(path.join(value.candidate, 'build-info.json'), '{"version":"forged"}');
    const output = context(value, true);
    expect(await installationCommand(parseArgs(migrateArgs(value, ['--json'])), output.context)).toBe(1);
    expect(JSON.parse(output.stdout.text())).toMatchObject({ schemaVersion: 1, status: 'blocked' });
    expect(output.stdout.text().trim().split('\n')).toHaveLength(1);
    expect(output.stderr.text()).toBe('');
    expect(output.prompt).not.toHaveBeenCalled();
    const recovery = context(value);
    expect(await installationCommand(parseArgs(['installation', 'migrate', '--recover', '--json']), recovery.context)).toBe(1);
    expect(JSON.parse(recovery.stdout.text())).toMatchObject({ schemaVersion: 1, mode: 'recovery-inspection', status: 'blocked' });
    expect(recovery.stderr.text()).toBe('');
  });

  it('executes the exact JSON-approved plan through the real command handler without prompting or incidental stdout', async () => {
    const value = await fixture('cli-approved-cutover');
    const preview = context(value, true);
    expect(await installationCommand(parseArgs(migrateArgs(value, ['--json'])), preview.context)).toBe(0);
    const planned = JSON.parse(preview.stdout.text());
    const continuation = validateStructuredContinuation(planned.nextActions[0]);
    const apply = context(value, true);
    expect(await installationCommand(parseArgs([...continuation.args]), apply.context)).toBe(0);
    const result = JSON.parse(apply.stdout.text());
    expect(result).toMatchObject({ schemaVersion: 1, mode: 'migration-apply', status: 'completed' });
    expect(result.record.verification).toMatchObject({ explicitPathVerified: true, pathResolutionVerified: true });
    expect(result.record.planFingerprint).toBe(planned.plan.planFingerprint);
    expect(await value.store.loadMigrationRecord(result.record.migrationId)).toEqual(result.record);
    expect(result.nextActions).toHaveLength(1);
    expect(validateStructuredContinuation(result.nextActions[0])).toMatchObject({
      executable: value.launcher, args: ['installation', 'inspect', '--json'],
      targetScope: 'installation', userInstallTarget: value.installRoot, requiredAuthority: []
    });
    expect(result.nextActions[0].project).toBeUndefined();
    expect(apply.stdout.text().trim().split('\n')).toHaveLength(1);
    expect(apply.stderr.text()).toBe('');
    expect(apply.prompt).not.toHaveBeenCalled();
  });

  it('emits a separately approved normal migration only after read-only recovery admits the original remaining effects', async () => {
    const value = await fixture('recovery-continuation');
    const preview = context(value, true);
    expect(await installationCommand(parseArgs(migrateArgs(value, ['--json'])), preview.context)).toBe(0);
    const original = validateStructuredContinuation(JSON.parse(preview.stdout.text()).nextActions[0]);
    const apply = context(value, true);
    apply.context.directInstaller = new DirectInstallerAdapter({
      admission: value.admission, receiptStore: value.store, runner: value.runner, env: value.env, cwd: value.project,
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.phase === 'staged' && checkpoint.index === 1) throw new Error('Isolated handover interruption.');
      }
    });
    expect(await installationCommand(parseArgs([...original.args]), apply.context)).toBe(1);
    const failed = JSON.parse(apply.stdout.text());
    expect(failed).toMatchObject({ status: 'failed', nextActions: [] });
    expect(failed.record.completedEffects).toContain('retire-legacy-package');
    const recordBytes = await readTree(value.store.baseDirectory);

    const inspect = context(value, true);
    expect(await installationCommand(parseArgs(['installation', 'migrate', '--recover', '--json']), inspect.context)).toBe(0);
    const recovery = JSON.parse(inspect.stdout.text());
    expect(recovery.recovery.record).toEqual(failed.record);
    expect(recovery.recovery.proposedPlan.recovery).toMatchObject({
      migrationId: failed.record.migrationId, sourceRetired: true
    });
    expect(recovery.nextActions).toHaveLength(1);
    const retry = validateStructuredContinuation(recovery.nextActions[0]);
    expect(retry.args).not.toContain('--recover');
    expect(retry.requiredAuthority).toEqual(['exact-installation-plan']);
    expect(retry.compatibilityIdentity).not.toBe(original.compatibilityIdentity);
    expect(retry.userInstallTarget).toBe(value.installRoot);
    expect(retry.project).toBeUndefined();
    expect(await readTree(value.store.baseDirectory)).toEqual(recordBytes);
    expect(inspect.prompt).not.toHaveBeenCalled();

    const resumed = context(value, true);
    expect(await installationCommand(parseArgs([...retry.args]), resumed.context)).toBe(0);
    expect(JSON.parse(resumed.stdout.text()).status).toBe('completed');
    expect(await value.store.loadMigrationRecord(failed.record.migrationId)).toEqual(failed.record);
    expect(value.runner.calls.filter((call) => call.command.args[0] === 'uninstall')).toHaveLength(1);
    await value.store.assertNoPendingRecord();
  });
});
