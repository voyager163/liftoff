import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadManifest } from '../src/application/project/manifest.js';
import { inspectApplicationPatch } from '../src/application/repair/application-patch.js';
import { createNodeFrameworkRepairFixture } from './fixtures/repair-framework-project.js';
import { runCommand } from '../src/commands.js';
import { parseArgs } from '../src/args.js';
import { CaptureStream } from './helpers.js';
import { NodeCommandRunner, type CommandRunner, type RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/domain/project/contracts.js';
import { frameworkFixtureStorage, frameworkProbeRecorder, frameworkStorageObservation } from './fixtures/framework-diagnostic.js';

const roots: string[] = [];
const now = new Date('2026-09-13T12:00:00Z');
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

class QualificationRunner implements CommandRunner {
  readonly calls: { command: ExternalCommand; options?: RunCommandOptions }[] = [];
  async run(command: ExternalCommand, options?: RunCommandOptions) {
    this.calls.push({ command, options });
    if (command.args.at(-1) === '--version') {
      if (command.args.some((arg) => typeof arg === 'string' && arg.endsWith('npm-cli.js'))) {
        return { command, displayCommand: '', status: 0, signal: null, stdout: '12.0.2\n', stderr: '', timedOut: false, processTreeSettled: true };
      }
      return { command, displayCommand: '', status: 0, signal: null, stdout: 'v24.21.0\n', stderr: '', timedOut: false, processTreeSettled: true };
    }
    if (command.args.includes('ci')) {
      if (options?.cwd) {
        await mkdir(path.join(options.cwd, 'node_modules'), { recursive: true, mode: 0o700 });
      }
      return { command, displayCommand: '', status: 0, signal: null, stdout: 'added 50 packages\n', stderr: '', timedOut: false, processTreeSettled: true };
    }
    if (command.args.includes('build')) {
      if (options?.cwd) {
        await mkdir(path.join(options.cwd, 'dist'), { recursive: true, mode: 0o700 });
      }
      return { command, displayCommand: '', status: 0, signal: null, stdout: 'built\n', stderr: '', timedOut: false, processTreeSettled: true };
    }
    return {
      command, displayCommand: `${command.executable} ${command.args.join(' ')}`,
      status: 0, signal: null, stdout: 'ok\n', stderr: '', timedOut: false, processTreeSettled: true
    };
  }
}

async function json(
  projectRoot: string, home: string, args: string[], runner: CommandRunner = new NodeCommandRunner(), clock = () => now
) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const code = await runCommand(parseArgs(['repair', projectRoot, ...args, '--json']), {
    cwd: path.dirname(projectRoot), stdout, stderr, runner, updateNow: clock,
    updatePreview: frameworkFixtureStorage(projectRoot, home)
  });
  return { code, report: JSON.parse(stdout.text()), stderr: stderr.text() };
}

describe('real framework repair fixture', () => {
  it('binds a real Node/Vue project with customized legacy source, tests and reviewed references', async () => {
    const fixture = await createNodeFrameworkRepairFixture();
    roots.push(fixture.parent);
    fixture.document.verification.preparation = [
      { provider: 'npm-ci', version: 1, cwdPathParts: ['backend'], packageSource: 'npmjs', network: true, lifecycle: 'disabled' },
      { provider: 'npm-ci', version: 1, cwdPathParts: ['frontend'], packageSource: 'npmjs', network: true, lifecycle: 'disabled' }
    ];
    await writeFile(fixture.patchPath, `${JSON.stringify(fixture.document, null, 2)}\n`);
    const diagnostic = process.platform === 'win32' ? frameworkProbeRecorder() : undefined;
    const candidate = await inspectApplicationPatch(fixture.root, await loadManifest(fixture.root), fixture.patchPath,
      diagnostic ? { runner: diagnostic.runner } : {});
    if (diagnostic) console.log(JSON.stringify({
      kind: 'native-framework-existing-probe-diagnostic',
      probes: diagnostic.snapshot(), storage: await frameworkStorageObservation(fixture, candidate.verificationPolicy),
      rawOutputRecorded: false, rawPathsRecorded: false, environmentRecorded: false,
      resultUnchanged: true, completeFrameworkQualification: false
    }));
    expect(candidate.blockers).toEqual([]);
    expect(candidate.report.status).toBe('proposed');
    expect(candidate.verificationPolicy.effects.preparation).toBe(true);
    expect(candidate.verificationPolicy.preparation).toHaveLength(2);
    expect(candidate.verificationPolicy.preparation.map((entry) => entry.provider)).toEqual(['npm-ci', 'npm-ci']);
    expect(candidate.mutations.some((entry) => entry.type === 'delete' && entry.pathParts[1] === 'legacy-src')).toBe(true);
    expect(candidate.report.effects.some((entry) => entry.targetPathParts.join('/') === path.posix.join('backend', 'test', 'health.test.ts'))).toBe(true);
    expect(candidate.report.effects.some((entry) => entry.targetPathParts.join('/') === path.posix.join('.github', 'workflows', 'application-check.yml'))).toBe(true);
    expect(candidate.verificationPolicy.commands.map((entry) => entry.args)).toEqual([
      ['run', 'build', '--ignore-scripts'], ['test', '--ignore-scripts'], ['run', 'build', '--ignore-scripts']
    ]);
    for (const original of fixture.protectedBytes) {
      expect(await readFile(path.join(fixture.root, ...original.pathParts))).toEqual(original.content);
    }
    expect([...fixture.expected.values()].some((content) => content.toString('utf8').includes('retainedRepairBusinessRule'))).toBe(true);
  });

  it('qualifies Node/Vue locked preparation, checks and approved patch commit via CLI flow', async () => {
    const fixture = await createNodeFrameworkRepairFixture();
    roots.push(fixture.parent);
    fixture.document.verification.preparation = [
      { provider: 'npm-ci', version: 1, cwdPathParts: ['backend'], packageSource: 'npmjs', network: true, lifecycle: 'disabled' },
      { provider: 'npm-ci', version: 1, cwdPathParts: ['frontend'], packageSource: 'npmjs', network: true, lifecycle: 'disabled' }
    ];
    await writeFile(fixture.patchPath, `${JSON.stringify(fixture.document, null, 2)}\n`);
    const runner = new QualificationRunner();

    // 1. Preview
    const preview = await json(fixture.root, fixture.home, ['--check', '--application-patch', fixture.patchPath], runner);
    expect(preview.code).toBe(2);
    expect(preview.report).toMatchObject({
      schemaVersion: 2, status: 'available', committed: false,
      identity: { recipe: { id: 'application-layout-patch', version: 1 } }
    });
    expect(preview.report.validationPolicy.preparation).toHaveLength(2);
    expect(preview.report.validationPolicy.effects).toMatchObject({
      preparation: true, network: true, lifecycle: false
    });
    const fingerprint = preview.report.fingerprint;

    // 2. Verification blocked without preparation permission
    const unpermittedPrep = await json(fixture.root, fixture.home, ['--verify-plan', fingerprint, '--allow-network'], runner);
    expect(unpermittedPrep.code).toBe(2);
    expect(unpermittedPrep.report.status).toBe('blocked');
    expect(unpermittedPrep.report.message).toContain('dependency preparation');

    // 3. Verification blocked without network permission
    const unpermittedNetwork = await json(fixture.root, fixture.home, ['--verify-plan', fingerprint, '--allow-dependency-preparation'], runner);
    expect(unpermittedNetwork.code).toBe(2);
    expect(unpermittedNetwork.report.status).toBe('blocked');
    expect(unpermittedNetwork.report.message).toContain('network');

    // 4. File approval blocked before matching verification
    const unverifiedApply = await json(fixture.root, fixture.home, ['--approve-plan', fingerprint], runner);
    expect(unverifiedApply.code).toBe(2);
    expect(unverifiedApply.report.status).toBe('blocked');
    expect(unverifiedApply.report.committed).toBe(false);

    // 5. Successful verification with both permissions
    const verified = await json(fixture.root, fixture.home, [
      '--verify-plan', fingerprint, '--allow-dependency-preparation', '--allow-network'
    ], runner);
    expect(verified.code).toBe(0);
    expect(verified.report).toMatchObject({
      status: 'verified', committed: false, repairScopeComplete: false, verification: 'passed'
    });
    expect(verified.report.verificationReceipt).toMatchObject({
      dependencyPreparationAuthorized: true, networkAuthorized: true, result: 'declared-checks-passed'
    });
    // Check that preparation ran before checks:
    const prepCalls = runner.calls.filter((c) => c.command.args.includes('ci'));
    const checkCalls = runner.calls.filter((c) => c.command.args.includes('build') || c.command.args.includes('test'));
    expect(prepCalls).toHaveLength(2);
    expect(checkCalls).toHaveLength(3);

    // 6. Successful file transaction application
    const applied = await json(fixture.root, fixture.home, ['--approve-plan', fingerprint], runner);
    expect(applied.code).toBe(0);
    expect(applied.report).toMatchObject({
      status: 'applied', committed: true, repairScopeComplete: true, verification: 'passed'
    });
    // Verify source moved from legacy-src to src:
    await expect(stat(path.join(fixture.root, 'backend', 'legacy-src', 'app.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    const appTs = await readFile(path.join(fixture.root, 'backend', 'src', 'app.ts'), 'utf8');
    expect(appTs).toContain('retainedRepairBusinessRule');
    // Verify protected manifests and locks are byte-identical:
    for (const original of fixture.protectedBytes) {
      expect(await readFile(path.join(fixture.root, ...original.pathParts))).toEqual(original.content);
    }
    // Verify immutable history exists:
    expect((await lstat(applied.report.historyPath)).isDirectory()).toBe(true);
    expect((await lstat(applied.report.backupPath)).isFile()).toBe(true);
  }, 120_000);

  const native = process.env.LIFTOFF_REPAIR_PREPARATION_NATIVE === '1';

  it.skipIf(!native)('qualifies real native Node/Vue npm preparation, build, Vitest tests and patch commit', async () => {
    const fixture = await createNodeFrameworkRepairFixture();
    roots.push(fixture.parent);
    fixture.document.verification.preparation = [
      { provider: 'npm-ci', version: 1, cwdPathParts: ['backend'], packageSource: 'npmjs', network: true, lifecycle: 'disabled' },
      { provider: 'npm-ci', version: 1, cwdPathParts: ['frontend'], packageSource: 'npmjs', network: true, lifecycle: 'disabled' }
    ];
    await writeFile(fixture.patchPath, `${JSON.stringify(fixture.document, null, 2)}\n`);
    const runner = new NodeCommandRunner();

    const preview = await json(fixture.root, fixture.home, ['--check', '--application-patch', fixture.patchPath], runner);
    expect(preview.code).toBe(2);
    expect(preview.report.status).toBe('available');
    const fingerprint = preview.report.fingerprint;

    const verified = await json(fixture.root, fixture.home, [
      '--verify-plan', fingerprint, '--allow-dependency-preparation', '--allow-network'
    ], runner);
    expect(verified.code).toBe(0);
    expect(verified.report.status).toBe('verified');
    expect(verified.report.verificationReceipt).toMatchObject({
      dependencyPreparationAuthorized: true, networkAuthorized: true, result: 'declared-checks-passed'
    });

    const applied = await json(fixture.root, fixture.home, ['--approve-plan', fingerprint], runner);
    expect(applied.code).toBe(0);
    expect(applied.report.status).toBe('applied');

    await expect(stat(path.join(fixture.root, 'backend', 'legacy-src', 'app.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    const appTs = await readFile(path.join(fixture.root, 'backend', 'src', 'app.ts'), 'utf8');
    expect(appTs).toContain('retainedRepairBusinessRule');

    for (const original of fixture.protectedBytes) {
      expect(await readFile(path.join(fixture.root, ...original.pathParts))).toEqual(original.content);
    }
    expect((await lstat(applied.report.historyPath)).isDirectory()).toBe(true);
    expect((await lstat(applied.report.backupPath)).isFile()).toBe(true);
  }, 720_000);
});
