import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFixtureProject } from '../src/application/initialize/fixture.js';
import { validateGeneratedProject } from '../src/application/diagnose/generated-project.js';
import { runCommand } from '../src/commands.js';
import { parseArgs } from '../src/args.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';
import type { ExternalCommand } from '../src/domain/project/contracts.js';
import type { CommandResult, RunCommandOptions } from '../src/process-runner.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function result(command: ExternalCommand, status = 0, stderr = ''): CommandResult {
  return { command, displayCommand: [command.executable, ...command.args].join(' '),
    status, signal: null, stdout: '', stderr, timedOut: false };
}

class LocalRunner extends ReadyInitRunner {
  failTests = false;
  failureMessage = 'fixture backend check failed';
  override async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    if (command.executable === 'az' || command.executable === 'gh' ||
      command.executable === 'git' && ['init', 'commit', 'push'].includes(command.args[0])) {
      throw new Error('Local setup attempted an out-of-scope provider or publication operation.');
    }
    if (command.executable === 'liftoff' && command.args[0] === 'validate') {
      this.calls.push(command);
      const issues = await validateGeneratedProject(options!.cwd!);
      return result(command, issues.length ? 1 : 0, issues.join('\n'));
    }
    if (command.executable === 'npm' && command.args.includes('test')) {
      this.calls.push(command);
      return result(command, this.failTests ? 1 : 0, this.failTests ? this.failureMessage : '');
    }
    if (command.executable === 'openspec' && command.args[0] === 'archive') {
      this.calls.push(command);
      const root = options!.cwd!;
      const source = path.join(root, 'openspec', 'changes', command.args[1]);
      const specs = path.join(source, 'specs');
      for (const capability of await readdir(specs)) {
        const delta = await readFile(path.join(specs, capability, 'spec.md'), 'utf8');
        const target = path.join(root, 'openspec', 'specs', capability);
        await mkdir(target, { recursive: true });
        await writeFile(path.join(target, 'spec.md'),
          `# ${capability}\n\n## Purpose\n\nDescribe the verified generated application baseline.\n\n${delta.replace('## ADDED Requirements', '## Requirements')}`);
      }
      const archive = path.join(root, 'openspec', 'changes', 'archive');
      await mkdir(archive, { recursive: true });
      await rename(source, path.join(archive, `2026-09-04-${command.args[1]}`));
      return result(command);
    }
    return super.run(command, options);
  }
}

async function fixture(workflow: 'openspec' | 'spec-kit') {
  const root = await createFixtureProject({
    projectName: 'Local v3', projectType: 'standard', apiStack: 'node',
    specWorkflow: workflow, agents: ['codex'], ...(workflow === 'spec-kit' ? { defaultAgent: 'codex' } : {}),
    environments: ['dev'], includeFrontend: false
  });
  roots.push(path.dirname(root));
  return { root, runner: new LocalRunner() };
}

async function cli(root: string, runner: LocalRunner, command: string, extras: string[] = []) {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(['governance', command, '--scope', 'local', '--json', ...extras]), {
    cwd: root, stdout, stderr, runner
  });
  return { code, value: JSON.parse(stdout.text() || '{}'), text: stdout.text() + stderr.text() };
}

describe('v3 local setup boundary', () => {
  it.each(['openspec', 'spec-kit'] as const)('completes %s locally without publication, provider credentials, or lifecycle waiting', async (workflow) => {
    const { root, runner } = await fixture(workflow);
    const phases = ['seed-valid', 'seed-verified', 'seed-archived'];
    for (const [index, phase] of phases.entries()) {
      const executed = await cli(root, runner, 'apply-next', ['--execute']);
      expect(executed.code, executed.text).toBe(0);
      expect(executed.value).toMatchObject({
        schemaVersion: 2, scope: 'local', applied: true,
        executedPhase: phase, nextReadyPhase: phases[index + 1] ?? null
      });
    }
    const verified = await cli(root, runner, 'verify');
    expect(verified.code, verified.text).toBe(0);
    expect(verified.value).toMatchObject({
      scope: 'local', complete: true, consistent: true,
      progress: { local: true, activation: false, lifecycle: false },
      nextReadyPhase: null
    });
    expect(runner.calls.some((command) => ['az', 'gh'].includes(command.executable))).toBe(false);
    expect(runner.calls.some((command) => command.executable === 'openspec' && command.args[0] === 'archive')).toBe(workflow === 'openspec');
    await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
    await writeFile(path.join(root, '.github', 'workflows', 'later-activation.yml'), 'name: Later activation\non: workflow_dispatch\njobs: {}\n');
    expect((await cli(root, runner, 'verify')).value.complete).toBe(true);
    await writeFile(path.join(root, 'backend', 'changed-public-input.ts'), 'export const changed = true;\n');
    const changed = await cli(root, runner, 'verify');
    expect(changed.code).toBe(1);
    expect(changed.value.complete).toBe(false);
  });

  it('reruns a failed local baseline without deleting or manually resetting state', async () => {
    const { root, runner } = await fixture('spec-kit');
    expect((await cli(root, runner, 'apply-next', ['--execute'])).code).toBe(0);
    runner.failTests = true;
    const failed = await cli(root, runner, 'apply-next', ['--execute']);
    expect(failed.code, failed.text).toBe(1);
    expect(failed.value.applied).toBe(false);
    expect(failed.value.message).toContain('fixture backend check failed');
    const before = await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8');
    expect(JSON.parse(before).phases['seed-verified'].state).toBe('blocked');
    runner.failTests = false;
    const retried = await cli(root, runner, 'apply-next', ['--execute']);
    expect(retried.code, retried.text).toBe(0);
    expect(retried.value.executedPhase).toBe('seed-verified');
  });

  it('returns a scoped JSON verification error for malformed state rather than claiming local completion', async () => {
    const { root, runner } = await fixture('spec-kit');
    await mkdir(path.join(root, 'governance'), { recursive: true });
    await writeFile(path.join(root, 'governance', 'activation-state.json'), '{"schemaVersion":3,"schemaVersion":3}');
    const failed = await cli(root, runner, 'verify');
    expect(failed.code).toBe(1);
    expect(failed.value).toMatchObject({ schemaVersion: 2, scope: 'local', complete: false, consistent: false, nextActions: [] });
  });

  it('withholds sensitive diagnostics from a failed local command', async () => {
    const { root, runner } = await fixture('spec-kit');
    expect((await cli(root, runner, 'apply-next', ['--execute'])).code).toBe(0);
    runner.failTests = true;
    runner.failureMessage = 'Authorization: Bearer private-fixture-value';
    const failed = await cli(root, runner, 'apply-next', ['--execute']);
    expect(failed.code).toBe(1);
    expect(failed.value.message).toContain('diagnostic withheld');
    expect(failed.text).not.toContain('private-fixture-value');
    expect(await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8')).not.toContain('private-fixture-value');
  });

  it('defaults direct governance inspection to activation and returns an explicit local prerequisite action', async () => {
    const { root, runner } = await fixture('spec-kit');
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const code = await runCommand(parseArgs(['governance', 'status', '--json']), { cwd: root, stdout, stderr, runner });
    expect(code, stdout.text() + stderr.text()).toBe(0);
    const status = JSON.parse(stdout.text());
    expect(status.scope).toBe('activation');
    expect(status.nextReadyPhase).toBeNull();
    expect(status.nextActions[0]).toMatchObject({ scope: 'local', approvalRequired: false });
    expect(status.nextActions[0].command.args).toContain('local');
  });
});
