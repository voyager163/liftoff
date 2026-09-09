import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliTelemetryHooks } from '../src/cli.js';
import { runCommand } from '../src/commands.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { captureTreeState } from '../src/init-filesystem.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-cli-delivery-'));
  roots.push(root);
  return root;
}

const projectFlags = [
  '--type', 'standard', '--api', 'node', '--cloud', 'azure',
  '--region', 'eastus', '--environments', 'prod', '--no-frontend',
  '--spec', 'spec-kit', '--agents', 'copilot', '--yes'
];

async function invoke(
  argv: string[],
  cwd: string,
  runner: ReadyInitRunner,
  telemetry?: CliTelemetryHooks
) {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const workspaceRoot = roots.find((root) => {
    const relative = path.relative(root, cwd);
    return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
  });
  if (!workspaceRoot) throw new Error('CLI delivery tests require an isolated workspace.');
  const code = await runCli({
    argv, cwd, stdout, stderr, telemetry,
    env: { CI: 'true', DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0' },
    execute: (parsed, context) => runCommand(parsed, {
      ...context, runner, updatePreview: { homedir: path.join(workspaceRoot, 'receipt-home'), env: {} }
    })
  });
  return { code, out: stdout.text(), err: stderr.text() };
}

describe('public CLI delivery flows', () => {
  it('runs initialization, local setup, assessment and guarded maintenance through the entrypoint', async () => {
    const root = await workspace();
    const runner = new ReadyInitRunner();
    const initialized = await invoke(['init', 'delivered-app', ...projectFlags], root, runner);
    expect(initialized.code, initialized.out + initialized.err).toBe(0);
    const project = path.join(root, 'delivered-app');
    const checked = await invoke(['update', '--check', '--json'], project, runner);
    expect(checked.code, checked.out + checked.err).toBe(0);
    const valid = await invoke(['validate', '--json'], project, runner);
    expect(valid.code, valid.out + valid.err).toBe(0);
    expect(JSON.parse(valid.out).valid).toBe(true);

    for (const phase of ['seed-valid', 'seed-verified', 'seed-archived']) {
      const executed = await invoke(['governance', 'apply-next', '--execute', '--json'], project, runner);
      expect(executed.code, executed.out + executed.err).toBe(0);
      expect(JSON.parse(executed.out).executedPhase).toBe(phase);
    }
    const beforeInspection = await captureTreeState(project);
    const verified = await invoke(['governance', 'verify', '--json'], project, runner);
    expect(verified.code, verified.out + verified.err).toBe(0);
    expect(JSON.parse(verified.out)).toMatchObject({ consistent: true, complete: false });
    const telemetry = {
      beforeCommand: vi.fn<CliTelemetryHooks['beforeCommand']>().mockResolvedValue(true),
      afterCommand: vi.fn<CliTelemetryHooks['afterCommand']>().mockResolvedValue(undefined)
    };
    const assessed = await invoke(['governance', 'assess', '--json'], project, runner, telemetry);
    expect(assessed.code, assessed.out + assessed.err).toBe(2);
    expect(JSON.parse(assessed.out)).toMatchObject({ schemaVersion: 1, readOnly: true, outcome: 'partial' });
    expect(telemetry.beforeCommand).not.toHaveBeenCalled();
    expect(telemetry.afterCommand).not.toHaveBeenCalled();
    expect(await captureTreeState(project)).toEqual(beforeInspection);

    const manifest = await loadManifest(project);
    const application = manifest.projectArtifacts.find(artifact => artifact.logicalName === 'node-backend-app')!;
    const guide = manifest.managedArtifacts.find(artifact => artifact.logicalName === 'repository-governance-guide')!;
    const applicationPath = path.join(project, ...application.pathParts);
    const guidePath = path.join(project, ...guide.pathParts);
    const originalGuide = await readFile(guidePath, 'utf8');
    await writeFile(applicationPath, 'project-owned application edit\n');
    await writeFile(guidePath, 'managed guide edit\n');
    const maintenancePreview = await invoke(['update', '--check', '--json'], project, runner);
    expect(maintenancePreview.code, maintenancePreview.out + maintenancePreview.err).toBe(2);
    const maintenancePlan = JSON.parse(maintenancePreview.out).plans.find((entry: { mode: string }) => entry.mode === 'force');
    expect(maintenancePlan).toBeDefined();
    const maintained = await invoke([
      'update', '--force', '--json', '--approve-plan', maintenancePlan.fingerprint
    ], project, runner);
    expect(maintained.code, maintained.out + maintained.err).toBe(0);
    expect(await readFile(applicationPath, 'utf8')).toBe('project-owned application edit\n');
    expect(await readFile(guidePath, 'utf8')).toBe(originalGuide);
    expect(runner.calls.filter(command => command.executable === 'az').every(command =>
      command.args[0] === 'version' || command.args[0] === 'account' && command.args[1] === 'show'
    )).toBe(true);
    expect(runner.calls.some(command => command.executable === 'gh')).toBe(false);
    expect(runner.calls.some(command => command.executable === 'git' && ['commit', 'push'].includes(command.args[0]))).toBe(false);
  });

  it('migrates into a fresh target without changing source or hiding placement decisions', async () => {
    const root = await workspace();
    const source = path.join(root, 'legacy');
    await mkdir(source);
    await writeFile(path.join(source, 'package.json'), '{"dependencies":{"fastify":"5.0.0"}}\n');
    await writeFile(path.join(source, 'app.js'), 'export const legacy = true;\n');
    const before = await captureTreeState(source);
    const migrated = await invoke([
      'migrate', source, '--project', 'adopted-app', ...projectFlags, '--governance', 'none'
    ], root, new ReadyInitRunner());
    expect(migrated.code, migrated.out + migrated.err).toBe(0);
    expect(await captureTreeState(source)).toEqual(before);
    const target = path.join(root, 'adopted-app');
    expect(await readFile(path.join(target, 'migration', 'legacy', 'app.js'), 'utf8'))
      .toBe('export const legacy = true;\n');
    const checklist = await readFile(path.join(target, 'MIGRATION.md'), 'utf8');
    expect(checklist).toContain('app.js');
    expect(checklist.lastIndexOf('migration/legacy')).toBeGreaterThan(checklist.indexOf('npm ci'));
    const valid = await invoke(['validate', '--json'], target, new ReadyInitRunner());
    expect(valid.code, valid.out + valid.err).toBe(0);
  });
});
