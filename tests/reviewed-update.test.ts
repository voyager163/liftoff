import { access, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import type { CommandContext } from '../src/application/context.js';
import { createUpdateTransactionApprovalStore, loadUpdatePreviewReceipt } from '../src/adapters/filesystem/update-previews.js';
import { applyReviewedUpdateTransaction, inspectReviewedUpdateTransaction } from '../src/adapters/filesystem/reviewed-update-transaction.js';
import { commandShellForPlatform, formatShellCommand } from '../src/adapters/process/shell-command.js';
import { formatUpdateCommand, formatUpdateValidationCommands } from '../src/application/update/command-guidance.js';
import { resolveUpdateGuidanceContext } from '../src/application/update/guidance-context.js';
import { UpdatePreviewError } from '../src/application/update/preview.js';
import { isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { validateEvidenceFreshness } from '../src/domain/governance/activation/evidence.js';
import { governanceArtifactPaths } from '../src/repository-governance.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { writeProjectFile } from '../src/adapters/filesystem/project-files.js';
import { historicalActivationIdentities } from '../src/domain/governance/policy/identity.js';
import { inspectGovernanceTransition } from '../src/governance-activation/commands.js';
import { readMigrationJournal } from '../src/governance-activation/migration-history.js';
import { readActivationEvidence } from '../src/governance-activation/read-only.js';
import { buildHistoricalV1Fixture } from './fixtures/activation-v1/fixture.js';
import { formatCommand, type CommandResult, type CommandRunner, type RunCommandOptions } from '../src/process-runner.js';
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

async function runRaw(root: string, args: string[], overrides: Partial<CommandContext> = {}) {
  const stdout = new CaptureStream();
  const capturedStderr = new CaptureStream();
  const stderr = overrides.stderr ?? capturedStderr;
  const code = await runCommand(parseArgs(args), {
    cwd: root, stdout, stderr, updatePreview: updateTestPreviewOptions(root),
    terminal: { layout: 'plain', color: false }, ...overrides
  });
  return { code, text: stdout.text(), err: capturedStderr.text(), stderr };
}

async function run(root: string, args: string[], overrides: Partial<CommandContext> = {}) {
  const { code, text, stderr } = await runRaw(root, args, overrides);
  const report: unknown = JSON.parse(text);
  if (!isRecord(report) || !Array.isArray(report.plans)) throw new Error(`Invalid update report: ${text}`);
  const plans = report.plans.map((value) => {
    if (!isRecord(value) || (value.mode !== 'normal' && value.mode !== 'force') ||
      typeof value.fingerprint !== 'string') throw new Error('Invalid preview plan.');
    return { mode: value.mode, fingerprint: value.fingerprint };
  });
  return { code, report: { ...report, plans }, text, stderr };
}

function implicitUpdate(mode: 'normal' | 'check' | 'force' = 'normal'): string {
  return formatShellCommand({
    executable: 'liftoff', args: ['update', ...(mode === 'normal' ? [] : [`--${mode}`])]
  }, commandShellForPlatform(process.platform));
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

async function historicalFixture(includeFrontend = false) {
  const root = await createReviewedUpdateFixture({
    projectName: 'Flight Log', projectType: 'standard', apiStack: 'node',
    cloud: 'azure', region: 'eastus', environments: ['dev'],
    specWorkflow: 'openspec', agents: ['copilot'], includeFrontend
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
  if (includeFrontend) await mkdir(path.join(root, 'frontend', 'node_modules'), { recursive: true });
  await mkdir(path.join(root, 'infrastructure', 'opentofu', 'azure', 'environments', 'dev', '.terraform'), { recursive: true });
  return { root, originalState: historical.files.get('governance/activation-state.json')! };
}

class MigrationRunner implements CommandRunner {
  readonly calls: ExternalCommand[] = [];
  failBackend = false;

  constructor(private readonly onRun?: (command: ExternalCommand, options?: RunCommandOptions) => Promise<void>) {}

  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push(command);
    if (['gh', 'az'].includes(command.executable) ||
      command.args.some((arg) => ['install', 'init', 'archive', 'commit', 'push', 'apply'].includes(arg))) {
      throw new Error(`Unexpected migration side effect: ${formatCommand(command)}`);
    }
    await this.onRun?.(command, options);
    const failed = this.failBackend && command.executable === 'npm' && command.args.includes('test');
    return {
      command, displayCommand: formatCommand(command), status: failed ? 1 : 0,
      stdout: '', stderr: failed ? 'Backend fixture failed.' : '', signal: null, timedOut: false
    };
  }
}

describe('reviewed update command integration', () => {
  it('retains the canonical explicit target when cwd is a leaf project symlink or junction', async () => {
    const { root, guide, originalGuide } = await fixture();
    const cwd = path.join(path.dirname(root), 'leaf project alias');
    await symlink(root, cwd, process.platform === 'win32' ? 'junction' : 'dir');
    const before = await fingerprintUpdateTestProject(root);
    const checked = await runRaw(root, ['update', '--check', '--project', root], { cwd });
    expect(checked.code, checked.err).toBe(2);
    expect(checked.text).toContain(formatUpdateCommand(root));
    expect(checked.text + checked.err).toContain('not a symlink or junction');
    const implicit = await runRaw(root, ['update'], { cwd });
    expect(implicit.code).toBe(1);
    expect(implicit.err).toContain('not a symlink or junction');
    expect(await fingerprintUpdateTestProject(root)).toEqual(before);

    const stored = await loadUpdatePreviewReceipt(root, updateTestPreviewOptions(root));
    const selected = stored.receipt.variants.find((entry) => entry.mode === 'normal');
    if (!selected) throw new Error('Expected a reviewed normal plan.');
    const applied = await runRaw(root, ['update', '--project', root, '--approve-plan', selected.fingerprint], { cwd });
    expect(applied.code, applied.err).toBe(0);
    expect(applied.text).toContain(formatUpdateValidationCommands(root));
    expect(await readFile(guide)).toEqual(originalGuide);
  });

  it.each(['root', 'subdirectory', 'another project'])('preserves bounded recovery guidance from %s', async (location) => {
    const { root, guide, originalGuide } = await fixture();
    let cwd = root;
    if (location === 'subdirectory') {
      cwd = path.join(root, 'backend', 'nested');
      await mkdir(cwd, { recursive: true });
    } else if (location === 'another project') {
      cwd = (await fixture()).root;
    }
    const previewOptions = updateTestPreviewOptions(root);
    const approvalStore = createUpdateTransactionApprovalStore(root, previewOptions);
    const committed = await applyReviewedUpdateTransaction(root, [{
      type: 'write', pathParts: [...governanceArtifactPaths.guide], content: originalGuide.toString('utf8')
    }], {
      planFingerprint: 'a'.repeat(64),
      approvalStore,
      onCheckpoint: async ({ phase }) => {
        if (phase === 'committed') throw new Error('Fixture interruption after commit.');
      }
    });
    expect(committed).toMatchObject({ committed: true, status: 'committed' });
    expect(committed.cleanupFailures).toContainEqual(expect.stringContaining('Fixture interruption'));
    const target = location === 'another project' ? ['--project', root] : [];
    const json = await run(root, ['update', '--check', '--json', ...target], { cwd });
    expect(json.code, json.text).toBe(1);
    expect(json.report).toMatchObject({ reasonCode: 'transaction-recovery-required', committed: true });
    expect(json.report.remedy).toContain(formatUpdateCommand(root));
    const guidance = await resolveUpdateGuidanceContext(cwd, root);
    const checked = await runRaw(root, ['update', '--check', ...target], { cwd });
    expect(checked.code, checked.err).toBe(1);
    expect(checked.err).toContain(formatUpdateCommand(root, 'normal', process.platform, guidance));
    expect(checked.err).toContain(formatUpdateCommand(root, 'check', process.platform, guidance));
    if (location !== 'another project') expect(checked.err).not.toContain('--project');
    await expect(loadUpdatePreviewReceipt(root, previewOptions)).rejects.toMatchObject({ code: 'preview-missing' });

    const recovered = await runRaw(root, ['update', ...target], { cwd });
    expect(recovered.code, recovered.err).toBe(2);
    expect(recovered.text).toContain('no new update was started');
    expect(recovered.text).toContain(formatUpdateCommand(root, 'check', process.platform, guidance));
    expect(await readFile(guide)).toEqual(originalGuide);
    expect(await inspectReviewedUpdateTransaction(root, { approvalStore })).toMatchObject({ status: 'absent' });
  });

  it.each(['root', 'subdirectory', 'ancestor alias'])(
    'guides the raw preview and approval sequence from the %s without a redundant project argument',
    async (location) => {
      const { root, guide, originalGuide } = await fixture();
      let cwd = root;
      if (location === 'subdirectory') {
        cwd = path.join(root, 'backend', 'nested directory');
        await mkdir(cwd, { recursive: true });
      } else if (location === 'ancestor alias') {
        const alias = path.join(path.dirname(path.dirname(root)), 'repository alias');
        await symlink(path.dirname(root), alias, process.platform === 'win32' ? 'junction' : 'dir');
        cwd = path.join(alias, path.basename(root));
      }
      const before = await fingerprintUpdateTestProject(root);
      const missing = await runRaw(root, ['update'], { cwd });
      expect(missing.code, missing.err).toBe(1);
      expect(missing.text).toContain(await realpath(root));
      expect(missing.err).toContain('No saved update preview was found');
      expect(missing.err).toContain('No new project update was performed');
      expect(missing.err).toContain(implicitUpdate('check'));
      expect(missing.err).not.toContain('preview-storage');
      expect(missing.err).not.toContain('--project');

      const checked = await runRaw(root, ['update', '--check'], { cwd });
      expect(checked.code, checked.err).toBe(2);
      expect(checked.text).toContain(implicitUpdate());
      expect(checked.text).not.toContain('--project');
      const stored = await loadUpdatePreviewReceipt(root, updateTestPreviewOptions(root));
      const selected = stored.receipt.variants.find((entry) => entry.mode === 'normal');
      if (!selected) throw new Error('Expected a reviewed normal plan.');

      const unapproved = await runRaw(root, ['update'], { cwd });
      expect(unapproved.code, unapproved.err).toBe(1);
      expect(unapproved.err).toContain('Explicit approval of this exact update plan is required.');
      expect(unapproved.err).not.toContain('--project');
      expect(await fingerprintUpdateTestProject(root)).toEqual(before);

      const applied = await runRaw(root, ['update', '--approve-plan', selected.fingerprint], { cwd });
      expect(applied.code, applied.err).toBe(0);
      const guidance = await resolveUpdateGuidanceContext(cwd, root);
      expect(applied.text).toContain(formatUpdateValidationCommands(root, process.platform, guidance));
      if (location !== 'subdirectory') {
        expect(applied.text).not.toContain('cd --');
        expect(applied.text).not.toContain('Set-Location');
      }
      expect(await readFile(guide)).toEqual(originalGuide);
      await expect(loadUpdatePreviewReceipt(root, updateTestPreviewOptions(root)))
        .rejects.toMatchObject({ code: 'preview-missing' });
    }
  );

  it.each([
    ['implicit', 'flag'],
    ['flag', 'implicit'],
    ['implicit', 'positional'],
    ['positional', 'implicit']
  ])('keeps receipt identity for %s check and %s apply targeting', async (checkTarget, applyTarget) => {
    const { root, guide, originalGuide } = await fixture();
    const cwd = path.join(root, 'backend', 'nested');
    await mkdir(cwd, { recursive: true });
    const target = (kind: string) => kind === 'implicit' ? [] : kind === 'flag' ? ['--project', root] : [root];
    const checked = await run(root, ['update', '--check', '--json', ...target(checkTarget)], { cwd });
    expect(checked.code, checked.text).toBe(2);
    const first = await loadUpdatePreviewReceipt(root, updateTestPreviewOptions(root));
    const rechecked = await run(root, ['update', '--check', '--json', ...target(applyTarget)], { cwd });
    expect(rechecked.code, rechecked.text).toBe(2);
    const second = await loadUpdatePreviewReceipt(root, updateTestPreviewOptions(root));
    expect(second.receipt.projectKey).toBe(first.receipt.projectKey);
    expect(rechecked.report.plans).toEqual(checked.report.plans);
    const selected = checked.report.plans.find((entry) => entry.mode === 'normal');
    if (!selected) throw new Error('Expected a reviewed normal plan.');

    const applied = await run(root, ['update', '--json', '--approve-plan', selected.fingerprint, ...target(applyTarget)], { cwd });
    expect(applied.code, applied.text).toBe(0);
    expect(applied.report).toMatchObject({
      schemaVersion: 3, scope: 'project-update', projectRoot: await realpath(root),
      reasonCode: 'approved-update-applied', committed: true
    });
    expect(applied.report).not.toHaveProperty('guidance');
    expect(applied.report).not.toHaveProperty('invocationDirectory');
    expect(await readFile(guide)).toEqual(originalGuide);
  });

  it.each(['another project', 'nested project', 'broken caller boundary'])(
    'keeps an explicit target when invoked from %s',
    async (location) => {
      const { root, guide, originalGuide } = await fixture();
      const other = await fixture();
      let cwd = other.root;
      if (location === 'nested project') {
        cwd = path.join(root, 'inner project');
        await rename(other.root, cwd);
      } else if (location === 'broken caller boundary') {
        cwd = path.join(other.root, 'unreadable context');
        await mkdir(path.join(cwd, 'liftoff.manifest.json'), { recursive: true });
        const failedImplicit = await runRaw(root, ['update'], { cwd });
        expect(failedImplicit.code).toBe(1);
        expect(failedImplicit.err).toContain('regular file');
      }
      const callerBefore = await fingerprintUpdateTestProject(cwd);
      const checked = await runRaw(root, ['update', '--check', '--project', root], { cwd });
      expect(checked.code, checked.err).toBe(2);
      expect(checked.text).toContain(formatUpdateCommand(root));
      if (location === 'broken caller boundary') {
        expect(checked.text + checked.err).toContain('invocation context could not be resolved');
      }
      const stored = await loadUpdatePreviewReceipt(root, updateTestPreviewOptions(root));
      const selected = stored.receipt.variants.find((entry) => entry.mode === 'normal');
      if (!selected) throw new Error('Expected a reviewed normal plan.');
      const applied = await runRaw(root, ['update', '--project', root, '--approve-plan', selected.fingerprint], { cwd });
      expect(applied.code, applied.err).toBe(0);
      expect(applied.text).toContain(formatUpdateValidationCommands(root));
      expect(await fingerprintUpdateTestProject(cwd)).toEqual(callerBefore);
      expect(await readFile(guide)).toEqual(originalGuide);
    }
  );

  it.each([
    ['preview-missing', 'review the proposed changes'],
    ['preview-mismatch', 'review the current plan'],
    ['preview-storage', 'Repair the reported preview-storage failure'],
    ['preview-invalid', 'Repair the reported invalid preview receipt'],
    ['preview-unsupported', 'preview-format incompatibility'],
    ['preview-busy', 'Wait for the other preview operation']
  ] as const)('renders typed %s failures with factual details and a specific remedy', async (code, remedy) => {
    const { root } = await fixture();
    const before = await fingerprintUpdateTestProject(root);
    const detail = `Reported ${code} diagnostic.`;
    for (const json of [false, true]) {
      const failed = await runRaw(root, ['update', '--check', ...(json ? ['--json'] : [])], {
        updatePreview: {
          ...updateTestPreviewOptions(root),
          clock: () => { throw new UpdatePreviewError(code, detail); }
        }
      });
      expect(failed.code, failed.text + failed.err).toBe(1);
      if (json) {
        const report: unknown = JSON.parse(failed.text);
        if (!isRecord(report)) throw new Error('Expected a structured failure report.');
        expect(report).toMatchObject({
          schemaVersion: 3, reasonCode: code, projectRoot: await realpath(root), committed: false,
          message: `${detail} No new project update was performed.`
        });
        expect(report.remedy).toContain(remedy);
        expect(report.remedy).toContain(formatUpdateCommand(root, 'check'));
      } else {
        expect(failed.err).toContain(detail);
        expect(failed.err).toContain(remedy);
        expect(failed.err).toContain(implicitUpdate('check'));
        expect(failed.err).not.toContain('--project');
      }
      expect(failed.text + failed.err).not.toContain('Repair any reported preview-storage issue');
      expect(await fingerprintUpdateTestProject(root)).toEqual(before);
    }
  });

  it('requires a real prior preview before any apply writes', async () => {
    const { root, guide } = await fixture();
    const before = await fingerprintUpdateTestProject(root);
    const result = await run(root, ['update', '--json']);

    expect(result.code).toBe(1);
    expect(result.report.reasonCode).toBe('preview-missing');
    expect(result.report.remedy).toContain(formatUpdateCommand(root, 'check'));
    expect(result.report.message).not.toContain('--project');
    expect(result.report.remedy).not.toContain('preview-storage');
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

  it('accepts approved command-generated outputs and completes fresh revalidation', async () => {
    const { root } = await historicalFixture(true);
    const generated: string[] = [];
    for (const component of ['backend', 'frontend']) {
      await writeProjectFile(root, [component, 'dist', 'existing.js'], 'export const generated = "before";\n');
    }
    const runner = new MigrationRunner(async (command, options) => {
      if (command.executable !== 'npm') return;
      const component = command.args.includes('test') ? 'backend' : 'frontend';
      expect(options?.cwd).toBe(path.join(root, component));
      expect(command.args).toEqual([
        '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
        ...(component === 'backend' ? ['test'] : ['run', 'build'])
      ]);
      await writeProjectFile(root, [component, 'dist', 'existing.js'], 'export const generated = "after";\n');
      await writeProjectFile(root, [component, 'dist', 'new.js'], 'export const created = true;\n');
      generated.push(component);
    });
    const checked = await run(root, ['update', '--check', '--json'], { runner });
    expect(checked.code, checked.text).toBe(2);
    expect(runner.calls).toEqual([]);
    expect(generated).toEqual([]);
    for (const component of ['backend', 'frontend']) {
      expect(await readFile(path.join(root, component, 'dist', 'existing.js'), 'utf8')).toBe('export const generated = "before";\n');
      await expect(access(path.join(root, component, 'dist', 'new.js'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(checked.report.revalidation).toMatchObject({ preview: {
        outputPolicy: expect.arrayContaining([expect.objectContaining({
          executable: 'npm', cwd: [component], outputs: expect.arrayContaining([[component, 'dist']])
        })]),
        phases: expect.arrayContaining([expect.objectContaining({
          phaseId: 'seed-verified',
          commands: expect.arrayContaining([expect.objectContaining({
            command: { executable: 'npm', args: [
              '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
              ...(component === 'backend' ? ['test'] : ['run', 'build'])
            ] },
            cwdPathParts: [component]
          })])
        })])
      } });
    }
    const selected = checked.report.plans.find((entry) => entry.mode === 'normal')!;
    const applied = await run(root, ['update', '--json', '--approve-plan', selected.fingerprint], { runner });

    expect(applied.code, applied.text).toBe(0);
    expect(applied.report.activationMigration).toMatchObject({ status: 'committed' });
    expect(applied.report.revalidation).toMatchObject({ status: 'complete', nextPhase: 'committed' });
    expect(generated).toEqual(['backend', 'frontend']);
    for (const component of generated) {
      expect(await readFile(path.join(root, component, 'dist', 'existing.js'), 'utf8')).toBe('export const generated = "after";\n');
      expect(await readFile(path.join(root, component, 'dist', 'new.js'), 'utf8')).toBe('export const created = true;\n');
    }
    expect(runner.calls.some((command) => command.executable === 'docker')).toBe(true);
    expect(runner.calls.filter((command) => command.executable === 'openspec')).toHaveLength(3);
    expect((await readMigrationJournal(root))?.revalidation.status).toBe('complete');
    const inspection = await inspectGovernanceTransition(root, { runner });
    const records = await readActivationEvidence(root);
    expect(records.map((record) => record.header.phaseId).sort()).toEqual(['seed-archived', 'seed-valid', 'seed-verified']);
    for (const record of records) {
      expect(record.header.schemaVersion).toBe(2);
      expect(record.header.result).toBe('verified');
      expect(validateEvidenceFreshness(record, inspection.contexts[record.header.phaseId]).valid).toBe(true);
      expect(inspection.readiness.phases[record.header.phaseId].state).toBe('verified');
    }
  }, process.platform === 'win32' ? 180_000 : 90_000);

  it('protects accepted generated outputs against external edits before a later command', async () => {
    const { root } = await historicalFixture();
    await mkdir(path.join(root, '.git'));
    const output = ['backend', 'dist', 'generated.js'];
    await writeProjectFile(root, output, 'export const generated = "before";\n');
    let generated = false;
    let metadataReads = 0;
    let edited = false;
    const runner = new MigrationRunner(async (command, options) => {
      if (command.executable === 'npm' && command.args.includes('test')) {
        expect(options?.cwd).toBe(path.join(root, 'backend'));
        await writeProjectFile(root, output, 'export const generated = "approved";\n');
        generated = true;
      } else if (generated && command.executable === 'git' &&
        command.args.join(' ') === 'rev-parse --show-toplevel' && ++metadataReads === 2) {
        // Let the command's post-output check finish before the next metadata boundary introduces an edit.
        expect(await readFile(path.join(root, ...output), 'utf8')).toBe('export const generated = "approved";\n');
        await writeProjectFile(root, output, 'export const generated = "external edit";\n');
        edited = true;
      }
    });
    const checked = await run(root, ['update', '--check', '--json'], { runner });
    expect(checked.code, checked.text).toBe(2);
    expect(generated).toBe(false);
    const selected = checked.report.plans.find((entry) => entry.mode === 'normal')!;
    const applied = await run(root, ['update', '--json', '--approve-plan', selected.fingerprint], { runner });

    expect(applied.code, applied.text).toBe(2);
    expect(applied.report.activationMigration).toMatchObject({ status: 'committed' });
    expect(applied.report.revalidation).toMatchObject({
      status: 'blocked',
      issues: expect.arrayContaining([expect.stringContaining(output.join('/'))])
    });
    expect(edited).toBe(true);
    expect(await readFile(path.join(root, ...output), 'utf8')).toBe('export const generated = "external edit";\n');
    expect(runner.calls.filter((command) => command.executable === 'npm')).toHaveLength(1);
    expect(runner.calls.some((command) => ['docker', 'tofu'].includes(command.executable))).toBe(false);
    expect(runner.calls.filter((command) => command.executable === 'openspec')).toHaveLength(1);
    expect((await readActivationEvidence(root)).map((record) => record.header.phaseId)).toEqual(['seed-valid']);
    expect((await readMigrationJournal(root))?.revalidation.status).toBe('blocked');
  }, process.platform === 'win32' ? 180_000 : 90_000);

  it('blocks disallowed sibling edits during an approved command without exempting build directories', async () => {
    const { root } = await historicalFixture();
    const siblings = [
      ['backend', 'dist-sibling', 'test-backend.mjs'],
      ['frontend', 'dist', 'test-backend.mjs'],
      ['build', 'test-backend.mjs'],
      ['dist', 'test-backend.mjs'],
      ['tools', 'build', 'test-backend.mjs']
    ];
    for (const parts of siblings) await writeProjectFile(root, parts, 'export const reviewed = true;\n');
    const output = ['backend', 'dist', 'generated.js'];
    const runner = new MigrationRunner(async (command, options) => {
      if (command.executable !== 'npm' || !command.args.includes('test')) return;
      expect(options?.cwd).toBe(path.join(root, 'backend'));
      await writeProjectFile(root, output, 'export const generated = true;\n');
      for (const parts of siblings) await writeProjectFile(root, parts, 'export const reviewed = false;\n');
    });
    const checked = await run(root, ['update', '--check', '--json'], { runner });
    expect(checked.code, checked.text).toBe(2);
    expect(runner.calls).toEqual([]);
    const selected = checked.report.plans.find((entry) => entry.mode === 'normal')!;
    const applied = await run(root, ['update', '--json', '--approve-plan', selected.fingerprint], { runner });

    expect(applied.code, applied.text).toBe(2);
    expect(applied.report.activationMigration).toMatchObject({ status: 'committed' });
    expect(applied.report.revalidation).toMatchObject({ status: 'blocked' });
    for (const parts of siblings) {
      expect(applied.report.revalidation).toMatchObject({
        issues: expect.arrayContaining([expect.stringContaining(parts.join('/'))])
      });
      expect(await readFile(path.join(root, ...parts), 'utf8')).toBe('export const reviewed = false;\n');
    }
    expect(await readFile(path.join(root, ...output), 'utf8')).toBe('export const generated = true;\n');
    expect(runner.calls.some((command) => ['docker', 'tofu'].includes(command.executable))).toBe(false);
    expect((await readActivationEvidence(root)).some((record) => record.header.phaseId === 'seed-verified')).toBe(false);
  }, process.platform === 'win32' ? 180_000 : 90_000);

  it('defers requested component expansion until a fresh preview after an eligible v1 migration', async () => {
    const { root } = await historicalFixture();
    const originalManifest = await loadManifest(root);
    const configPath = path.join(root, 'liftoff.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.includeFrontend = true;
    config.environments = ['dev', 'staging'];
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const desiredConfig = await readFile(configPath);
    const before = await fingerprintUpdateTestProject(root);
    const runner = new MigrationRunner();
    const checked = await run(root, ['update', '--check', '--json'], { runner });

    expect(checked.code, checked.text).toBe(2);
    expect(checked.report.activationMigration).toMatchObject({
      status: 'available', sourceIdentity: historicalActivationIdentities[0]
    });
    expect(checked.report.receipt).toMatchObject({ status: 'issued' });
    expect(checked.report.provisioning).toEqual(['frontend', 'environment:staging'].map((group) => ({
      group, status: 'blocked', entries: [],
      reason: 'Activation migration defers new component provisioning until a fresh post-migration preview.'
    })));
    expect(await fingerprintUpdateTestProject(root)).toEqual(before);
    const selected = checked.report.plans.find((entry) => entry.mode === 'normal')!;
    const applied = await run(root, ['update', '--json', '--approve-plan', selected.fingerprint], { runner });

    expect(applied.code, applied.text).toBe(0);
    expect(applied.report.activationMigration).toMatchObject({ status: 'committed' });
    expect(applied.report.revalidation).toMatchObject({ status: 'complete' });
    expect(applied.report.provisioning).toEqual(checked.report.provisioning);
    const migratedManifest = await loadManifest(root);
    expect(migratedManifest.project.workload).toEqual(originalManifest.project.workload);
    expect(migratedManifest.projectArtifacts).toEqual(originalManifest.projectArtifacts);
    expect(await readFile(configPath)).toEqual(desiredConfig);
    await expect(access(path.join(root, 'frontend'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(root, 'infrastructure', 'opentofu', 'azure', 'environments', 'staging')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const afterMigration = await fingerprintUpdateTestProject(root);
    const callsAfterMigration = [...runner.calls];
    const fresh = await run(root, ['update', '--check', '--json'], { runner });

    expect(fresh.code, fresh.text).toBe(2);
    expect(fresh.report.receipt).toMatchObject({ status: 'issued' });
    expect(fresh.report.activationMigration).toMatchObject({ status: 'committed' });
    const next = fresh.report.plans.find((entry) => entry.mode === 'normal');
    expect(next).toBeDefined();
    expect(next!.fingerprint).not.toBe(selected.fingerprint);
    const provisioning = fresh.report.provisioning;
    if (!Array.isArray(provisioning)) throw new Error('Expected separate post-migration provisioning.');
    expect(provisioning.map((group) => group.group)).toEqual(['frontend', 'environment:staging']);
    for (const group of provisioning) {
      expect(group.status).toBe('ready');
      expect(group.entries.length).toBeGreaterThan(0);
      for (const entry of group.entries) {
        expect(entry.status).toBe('create');
        await expect(access(path.join(root, ...entry.path.split('/')))).rejects.toMatchObject({ code: 'ENOENT' });
      }
    }
    expect(await fingerprintUpdateTestProject(root)).toEqual(afterMigration);
    expect(runner.calls).toEqual(callsAfterMigration);
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
