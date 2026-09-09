import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import type { CommandContext } from '../src/application/context.js';
import { isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { governanceArtifactPaths } from '../src/repository-governance.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { writeProjectFile } from '../src/adapters/filesystem/project-files.js';
import { historicalActivationIdentities } from '../src/domain/governance/policy/identity.js';
import { readMigrationJournal } from '../src/governance-activation/migration-history.js';
import { readActivationEvidence } from '../src/governance-activation/read-only.js';
import { buildHistoricalV1Fixture } from './fixtures/activation-v1/fixture.js';
import { formatCommand, type CommandResult, type CommandRunner } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/domain/project/contracts.js';
import { CaptureStream, scriptedTtyInput, ttyCaptureStream } from './helpers.js';
import {
  cleanupUpdateTestRoots,
  createReviewedUpdateFixture,
  fingerprintUpdateTestProject,
  updateTestPreviewOptions
} from './reviewed-update-helpers.js';

afterEach(cleanupUpdateTestRoots);

async function fixture() {
  const root = await createReviewedUpdateFixture({
    projectName: 'Approved Update',
    projectType: 'standard',
    apiStack: 'go',
    cloud: 'azure',
    region: 'eastus',
    environments: ['dev'],
    specWorkflow: 'openspec',
    includeFrontend: false
  });
  const guide = path.join(root, ...governanceArtifactPaths.guide);
  const originalGuide = await readFile(guide);
  await rm(guide);
  return { root, guide, originalGuide };
}

async function run(root: string, args: string[], overrides: Partial<CommandContext> = {}) {
  const stdout = new CaptureStream();
  const stderr = overrides.stderr ?? new CaptureStream();
  const code = await runCommand(parseArgs(args), {
    cwd: root, stdout, stderr, updatePreview: updateTestPreviewOptions(root), ...overrides
  });
  const text = stdout.text();
  const report: unknown = JSON.parse(text);
  if (!isRecord(report) || !Array.isArray(report.plans)) throw new Error(`Invalid update report: ${text}`);
  const plans = report.plans.map((value) => {
    if (!isRecord(value) || (value.mode !== 'normal' && value.mode !== 'force') ||
      typeof value.fingerprint !== 'string') throw new Error('Invalid preview plan.');
    return { mode: value.mode, fingerprint: value.fingerprint };
  });
  return { code, report: { ...report, plans }, text, stderr };
}

async function preview(root: string, mode: 'normal' | 'force' = 'normal') {
  const result = await run(root, ['update', '--check', '--json']);
  expect(result.code, result.text).toBe(2);
  expect(result.report.schemaVersion).toBe(3);
  expect(result.report.scope).toBe('project-update');
  const selected = result.report.plans.find((plan) => plan.mode === mode);
  expect(selected).toBeDefined();
  return selected!.fingerprint;
}

async function historicalFixture() {
  const root = await createReviewedUpdateFixture({
    projectName: 'Flight Log', projectType: 'standard', apiStack: 'node',
    cloud: 'azure', region: 'eastus', environments: ['dev'],
    specWorkflow: 'openspec', agents: ['copilot'], includeFrontend: false
  });
  const manifest = await loadManifest(root);
  if (manifest.governance.profile === 'none' || manifest.governance.profile === 'unspecified') {
    throw new Error('Expected enabled fixture governance.');
  }
  manifest.governance.activationIdentity = historicalActivationIdentities[0];
  await writeProjectFile(root, ['liftoff.manifest.json'], `${JSON.stringify(manifest, null, 2)}\n`);
  const historical = buildHistoricalV1Fixture();
  for (const [name, bytes] of historical.files) {
    if (name === 'governance/activation-state.json' || name.startsWith('governance/evidence/') ||
      name.startsWith('governance/plans/') || name.startsWith('governance/approvals/')) {
      await writeProjectFile(root, name.split('/'), bytes);
    }
  }
  const seed = 'bootstrap-flight-log';
  const capability = 'node-fastify-application-baseline';
  const source = path.join(root, 'openspec', 'changes', seed);
  const archive = path.join(root, 'openspec', 'changes', 'archive', `2026-08-30-${seed}`);
  const delta = await readFile(path.join(source, 'specs', capability, 'spec.md'), 'utf8');
  await mkdir(path.dirname(archive), { recursive: true });
  await rename(source, archive);
  await writeProjectFile(root, ['openspec', 'specs', capability, 'spec.md'],
    `# Application baseline\n\n${delta.replace('## ADDED Requirements', '## Requirements')}`);
  await mkdir(path.join(root, 'backend', 'node_modules'), { recursive: true });
  await mkdir(path.join(root, 'infrastructure', 'opentofu', 'azure', 'environments', 'dev', '.terraform'), { recursive: true });
  return { root, originalState: historical.files.get('governance/activation-state.json')! };
}

class MigrationRunner implements CommandRunner {
  readonly calls: ExternalCommand[] = [];
  failBackend = false;

  async run(command: ExternalCommand): Promise<CommandResult> {
    this.calls.push(command);
    if (['gh', 'az'].includes(command.executable) ||
      command.args.some((arg) => ['install', 'init', 'archive', 'commit', 'push', 'apply'].includes(arg))) {
      throw new Error(`Unexpected migration side effect: ${formatCommand(command)}`);
    }
    const failed = this.failBackend && command.executable === 'npm' && command.args.includes('test');
    return {
      command, displayCommand: formatCommand(command), status: failed ? 1 : 0,
      stdout: '', stderr: failed ? 'Backend fixture failed.' : '', signal: null, timedOut: false
    };
  }
}

describe('reviewed update command integration', () => {
  it('requires a real prior preview before any apply writes', async () => {
    const { root, guide } = await fixture();
    const before = await fingerprintUpdateTestProject(root);
    const result = await run(root, ['update', '--json']);

    expect(result.code).toBe(1);
    expect(result.report.reasonCode).toBe('preview-missing');
    expect(await fingerprintUpdateTestProject(root)).toEqual(before);
    await expect(access(guide)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('issues a disclosed external receipt without changing project bytes', async () => {
    const { root } = await fixture();
    const before = await fingerprintUpdateTestProject(root);
    const result = await run(root, ['update', '--check', '--json']);

    expect(result.code, result.text).toBe(2);
    expect(result.report.receipt).toMatchObject({ status: 'issued' });
    expect(result.report.projectBytesWritten).toBe(0);
    expect(await fingerprintUpdateTestProject(root)).toEqual(before);
  });

  it('does not turn a receipt or JSON output into approval', async () => {
    const { root } = await fixture();
    await preview(root);
    const before = await fingerprintUpdateTestProject(root);
    const result = await run(root, ['update', '--json']);

    expect(result.code, result.text).toBe(1);
    expect(result.report.reasonCode).toBe('approval-required');
    expect(await fingerprintUpdateTestProject(root)).toEqual(before);
  });

  it('applies only the exact approved normal plan and consumes its receipt', async () => {
    const { root, guide, originalGuide } = await fixture();
    const fingerprint = await preview(root);
    const result = await run(root, ['update', '--json', '--approve-plan', fingerprint]);

    expect(result.code, result.text).toBe(0);
    expect(result.report.committed).toBe(true);
    expect(result.report.receipt).toMatchObject({ status: 'consumed' });
    expect(await readFile(guide)).toEqual(originalGuide);
    expect(result.report.written).toContain(path.posix.join(...governanceArtifactPaths.guide));
  });

  it('rejects changed protected inputs before writing', async () => {
    const { root, guide } = await fixture();
    const fingerprint = await preview(root);
    await writeFile(path.join(root, ...governanceArtifactPaths.policy), '# Changed after review\n');
    const before = await fingerprintUpdateTestProject(root);
    const result = await run(root, ['update', '--json', '--approve-plan', fingerprint]);

    expect(result.code, result.text).toBe(1);
    expect(result.report.reasonCode).toBe('preview-mismatch');
    expect(await fingerprintUpdateTestProject(root)).toEqual(before);
    await expect(access(guide)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never substitutes normal approval for the forced plan', async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, ...governanceArtifactPaths.policy), '# User-owned edit to managed policy\n');
    const fingerprint = await preview(root);
    const before = await fingerprintUpdateTestProject(root);
    const result = await run(root, ['update', '--force', '--json', '--approve-plan', fingerprint]);

    expect(result.code, result.text).toBe(1);
    expect(result.report.reasonCode).toBe('approval-mismatch');
    expect(await fingerprintUpdateTestProject(root)).toEqual(before);
  });

  it('rechecks the plan after interactive approval and before project writes', async () => {
    const { root, guide } = await fixture();
    await preview(root);
    const policy = path.join(root, ...governanceArtifactPaths.policy);
    const result = await run(root, ['update', '--json'], {
      stdin: scriptedTtyInput(''),
      stderr: ttyCaptureStream(),
      approveUpdatePlan: async () => {
        await writeFile(policy, '# Concurrent edit during approval\n');
        return true;
      }
    });

    expect(result.code, result.text).toBe(1);
    expect(result.report.committed).toBe(false);
    expect(await readFile(policy, 'utf8')).toBe('# Concurrent edit during approval\n');
    await expect(access(guide)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves maintained v1 history and establishes fresh local v2 proof', async () => {
    const { root, originalState } = await historicalFixture();
    const runner = new MigrationRunner();
    const checked = await run(root, ['update', '--check', '--json'], { runner });
    expect(checked.code, checked.text).toBe(2);
    const selected = checked.report.plans.find((entry) => entry.mode === 'normal')!;
    const result = await run(root, ['update', '--json', '--approve-plan', selected.fingerprint], { runner });

    expect(result.code, result.text).toBe(0);
    expect(result.report.activationMigration).toMatchObject({ status: 'committed' });
    expect(result.report.revalidation).toMatchObject({ status: 'complete', nextPhase: 'committed' });
    const journal = await readMigrationJournal(root);
    expect(journal).toBeDefined();
    const active = JSON.parse(await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8'));
    expect(active.schemaVersion).toBe(2);
    expect(active.phases.committed.state).toBe('pending');
    const history = path.join(root, 'governance', 'history');
    const { readdir } = await import('node:fs/promises');
    const snapshots = await readdir(history);
    expect(snapshots).toHaveLength(1);
    expect(await readFile(path.join(history, snapshots[0]!, 'files', 'governance', 'activation-state.json')))
      .toEqual(originalState);
    expect((await readActivationEvidence(root)).map((record) => record.header.schemaVersion)).toEqual([2, 2, 2]);
  }, process.platform === 'win32' ? 180_000 : 90_000);

  it('retains blocked v2 after revalidation failure and resumes after a new approval', async () => {
    const { root } = await historicalFixture();
    const runner = new MigrationRunner();
    runner.failBackend = true;
    const checked = await run(root, ['update', '--check', '--json'], { runner });
    expect(checked.code, checked.text).toBe(2);
    const first = checked.report.plans.find((entry) => entry.mode === 'normal')!;
    const applied = await run(root, ['update', '--json', '--approve-plan', first.fingerprint], { runner });
    expect(applied.code, applied.text).toBe(2);
    expect(applied.report.activationMigration).toMatchObject({ status: 'committed' });
    expect(applied.report.revalidation).toMatchObject({ status: 'blocked' });
    const initialState = JSON.parse(await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8'));

    runner.failBackend = false;
    const retry = await run(root, ['update', '--check', '--json'], { runner });
    expect(retry.code, retry.text).toBe(2);
    const next = retry.report.plans.find((entry) => entry.mode === 'normal')!;
    const resumed = await run(root, ['update', '--json', '--approve-plan', next.fingerprint], { runner });
    expect(resumed.code, resumed.text).toBe(0);
    expect(resumed.report.revalidation).toMatchObject({ status: 'complete' });
    const finalState = JSON.parse(await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8'));
    expect(finalState.repository.id).toBe(initialState.repository.id);
  }, process.platform === 'win32' ? 180_000 : 90_000);

  it('shows known local revalidation gaps in human preview and before approval', async () => {
    const { root } = await historicalFixture();
    await rm(path.join(root, 'backend', 'node_modules'), { recursive: true });
    const inspected = await run(root, ['update', '--check', '--json']);
    expect(inspected.code, inspected.text).toBe(2);
    const revalidation = inspected.report.revalidation;
    if (!isRecord(revalidation) || !Array.isArray(revalidation.issues)) throw new Error('Expected revalidation diagnostics.');
    const issues = revalidation.issues.filter((issue): issue is string => typeof issue === 'string');
    expect(issues.length).toBeGreaterThan(0);
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    expect(await runCommand(parseArgs(['update', '--check']), {
      cwd: root, stdout, stderr, updatePreview: updateTestPreviewOptions(root)
    })).toBe(2);
    for (const issue of issues) expect(stdout.text()).toContain(issue);

    const approvalOutput = ttyCaptureStream();
    const declined = await run(root, ['update', '--json'], {
      stdin: scriptedTtyInput(''), stderr: approvalOutput,
      approveUpdatePlan: async () => false
    });
    expect(declined.code).toBe(1);
    for (const issue of issues) expect(approvalOutput.text()).toContain(issue);
    expect(approvalOutput.text()).toContain('may commit v2');
  });

  it.each([
    ['scripts', 'test-backend.mjs'],
    ['tools', 'build', 'test-backend.mjs'],
    ['backend', 'dist', 'test-backend.mjs']
  ])('invalidates approval when project script %j changes after preview', async (...parts) => {
    const { root, originalState } = await historicalFixture();
    const script = path.join(root, ...parts);
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, 'export const reviewed = true;\n');
    const packagePath = path.join(root, 'backend', 'package.json');
    const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
    pkg.scripts.test = `node ${JSON.stringify(path.relative(path.join(root, 'backend'), script))}`;
    await writeFile(packagePath, JSON.stringify(pkg));
    const checked = await run(root, ['update', '--check', '--json']);
    expect(checked.code, checked.text).toBe(2);
    const fingerprint = checked.report.plans.find((entry) => entry.mode === 'normal')!.fingerprint;
    await writeFile(script, 'export const reviewed = false;\n');
    const runner = new MigrationRunner();
    const applied = await run(root, ['update', '--json', '--approve-plan', fingerprint], { runner });
    expect(applied.code, applied.text).toBe(1);
    expect(applied.report.reasonCode).toBe('preview-mismatch');
    expect(runner.calls).toEqual([]);
    expect(await readFile(path.join(root, 'governance', 'activation-state.json'))).toEqual(originalState);
  });

  it('rechecks root scripts changed during interactive migration approval', async () => {
    const { root, originalState } = await historicalFixture();
    const script = path.join(root, 'scripts', 'test-backend.mjs');
    await mkdir(path.dirname(script));
    await writeFile(script, 'export const beforeApproval = true;\n');
    await run(root, ['update', '--check', '--json']);
    const runner = new MigrationRunner();
    const applied = await run(root, ['update', '--json'], {
      runner, stdin: scriptedTtyInput(''), stderr: ttyCaptureStream(),
      approveUpdatePlan: async () => {
        await writeFile(script, 'export const beforeApproval = false;\n');
        return true;
      }
    });
    expect(applied.code, applied.text).toBe(1);
    expect(applied.report.committed).toBe(false);
    expect(runner.calls).toEqual([]);
    expect(await readFile(path.join(root, 'governance', 'activation-state.json'))).toEqual(originalState);
  });
});
