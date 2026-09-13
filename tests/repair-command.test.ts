import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCommand } from '../src/commands.js';
import { parseArgs } from '../src/args.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import { loadManifest } from '../src/application/project/manifest.js';
import * as infrastructure from '../src/application/repair/infrastructure.js';
import {
  currentInfrastructureIdentities, retiredFlatRootInfrastructureIdentities, assessInfrastructureLayout
} from '../src/domain/project/infrastructure-layout.js';
import { captureProjectFileSnapshot } from '../src/adapters/filesystem/project-transaction.js';
import type { ProjectFileMutation } from '../src/adapters/filesystem/project-transaction.js';
import { NodeCommandRunner, type CommandRunner, type CommandResult, type RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/domain/project/contracts.js';
import { CaptureStream } from './helpers.js';
import { createLegacyInfrastructureFixture, repairRoot } from './fixtures/repair-infrastructure.js';
import { renderOpenTofuProviderLock, renderOpenTofuVersions } from '../src/opentofu-template-assets.js';

const roots: string[] = [];
const subscription = '11111111-2222-3333-4444-555555555555';
const oldMain = ['infrastructure', 'opentofu', 'azure', 'main.tf'];
const now = new Date('2026-09-13T01:00:00Z');
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const hash = (bytes: string | Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
async function folder(prefix: string) {
  const value = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(value); return value;
}
async function fixture() {
  const root = await folder('liftoff-repair-project with spaces-');
  const home = await folder('liftoff-repair-receipts-');
  const plan = buildProjectPlan({
    projectName: 'Repair fixture', projectType: 'standard', apiStack: 'node',
    agents: ['copilot'], environments: ['dev'], governanceProfile: 'none'
  }, { requireProjectName: true });
  const rendered = buildArtifacts(plan);
  for (const file of rendered) {
    await mkdir(path.dirname(path.join(root, ...file.pathParts)), { recursive: true });
    await writeFile(path.join(root, ...file.pathParts), file.content);
  }
  const targetManifest = await loadManifest(root);
  const identities = new Set(currentInfrastructureIdentities(['dev']).map((entry) => entry.logicalName));
  const targetFiles = rendered.filter((entry) => identities.has(entry.logicalName));
  const sourceManifest = {
    ...targetManifest,
    projectArtifacts: [
      ...targetManifest.projectArtifacts.filter((entry) => !identities.has(entry.logicalName)),
      ...retiredFlatRootInfrastructureIdentities.map((entry) => ({
        ...entry, pathParts: [...entry.pathParts], generatedBy: '0.10.0', generationHash: hash('legacy')
      }))
    ]
  };
  for (const file of targetFiles) await rm(path.join(root, ...file.pathParts));
  await writeFile(path.join(root, ...oldMain), 'legacy-source');
  await writeFile(path.join(root, 'liftoff.manifest.json'), `${JSON.stringify(sourceManifest, null, 2)}\n`);
  await writeFile(path.join(root, 'developer-notes.txt'), 'preserve business customizations');
  const before = await readFile(path.join(root, 'liftoff.manifest.json'));
  const recipe = vi.spyOn(infrastructure, 'inspectInfrastructureRepair').mockImplementation(async (selectedRoot, manifest) => {
    const current = assessInfrastructureLayout(manifest).kind === 'independent';
    const snapshots = await Promise.all([oldMain, ...targetFiles.map((file) => file.pathParts)]
      .map((parts) => captureProjectFileSnapshot(selectedRoot, [...parts])));
    const mutations: ProjectFileMutation[] = current ? [] : [
      ...targetFiles.map((file) => ({ type: 'write' as const, pathParts: file.pathParts, content: file.content })),
      { type: 'delete', pathParts: oldMain }
    ];
    return {
      layout: current ? 'independent' : 'legacy-shared', blockers: [], snapshots, mutations, directoryInventory: [],
      artifacts: targetManifest.projectArtifacts.filter((entry) => identities.has(entry.logicalName)),
      files: targetFiles.map(({ pathParts, content }) => ({ pathParts, content })),
      resourceGroups: [{ environment: 'dev', name: 'fixture-dev-rg' }], statePaths: [['terraform.tfstate']]
    };
  });
  return { root, home, before, recipe };
}
class Runner implements CommandRunner {
  calls: { command: ExternalCommand; options?: RunCommandOptions }[] = [];
  onValidation?: () => Promise<void>;
  failValidation = false;
  exists = false;
  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push({ command, options });
    let stdout = '';
    if (command.executable === 'az') {
      stdout = command.args[0] === 'account'
        ? JSON.stringify({ id: subscription, tenantId: 'tenant', state: 'Enabled' }) : String(this.exists);
    } else if (command.args[0] === '--version') {
      stdout = 'OpenTofu v1.12.6';
    } else if (command.args[0] === 'validate') {
      await this.onValidation?.();
      stdout = JSON.stringify({ valid: !this.failValidation, error_count: this.failValidation ? 1 : 0 });
    }
    return { command, displayCommand: '', stdout, stderr: '', status: 0, signal: null, timedOut: false };
  }
}
async function command(project: { root: string; home: string }, args: string[], runner = new Runner(), cwd = project.root) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const exitCode = await runCommand(parseArgs(['repair', ...args, '--json']), {
    cwd, stdout, stderr, runner, updateNow: () => now,
    updatePreview: { homedir: project.home, env: {} }
  });
  return { exitCode, report: JSON.parse(stdout.text()), stderr: stderr.text(), runner };
}
const check = ['--check', '--live', '--subscription', subscription];
describe('reviewed repair command coordinator', () => {
  it.runIf(process.env.LIFTOFF_REPAIR_NATIVE === '1')('validates a repaired candidate with native backend-disabled OpenTofu and no Azure calls', async () => {
    const root = await folder('liftoff-repair-native-'), home = await folder('liftoff-repair-home-');
    const manifest = await createLegacyInfrastructureFixture(root, ['dev']);
    await writeFile(path.join(root, 'liftoff.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(root, ...repairRoot, '.terraform.lock.hcl'), renderOpenTofuProviderLock());
    await writeFile(path.join(root, ...repairRoot, 'versions.tf'), renderOpenTofuVersions());
    await writeFile(path.join(root, ...repairRoot, 'main.tf'), `resource "azurerm_resource_group" "main" {
  name     = "rg-native-repair-\${var.environment}"
  location = var.location
}
`);
    await writeFile(path.join(root, ...repairRoot, 'outputs.tf'), `output "resource_group_name" {
  value = azurerm_resource_group.main.name
}
`);
    const native = new NodeCommandRunner();
    const formatted = await native.run({ executable: 'tofu', args: ['fmt', '-recursive'] }, {
      cwd: path.join(root, ...repairRoot), timeoutMs: 30_000, maxOutputBytes: 65536
    });
    expect(formatted.status).toBe(0);
    class NativeRunner extends Runner {
      native = new NodeCommandRunner();
      override async run(command: ExternalCommand, options?: RunCommandOptions) {
        if (command.executable === 'az') return super.run(command, options);
        this.calls.push({ command, options });
        return this.native.run(command, options);
      }
    }
    const runner = new NativeRunner();
    const first = await command({ root, home }, check, runner);
    expect(first.report.blockers).toEqual([]);
    const applied = await command({ root, home }, ['--approve-plan', first.report.fingerprint], runner);
    expect(applied.report.blockers).toEqual([]);
    expect(applied.report.status).toBe('applied');
    expect(applied.exitCode).toBe(0);
    expect(runner.calls.filter((entry) => entry.command.executable === 'tofu').map((entry) => entry.command.args[0]))
      .toEqual(['--version', 'fmt', 'init', 'validate']);
    const formatting = await native.run({ executable: 'tofu', args: ['fmt', '-check', '-recursive'] }, {
      cwd: path.join(root, ...repairRoot), timeoutMs: 30_000, maxOutputBytes: 65536
    });
    expect(formatting.stdout).toBe('');
    expect(formatting.status).toBe(0);
  }, 180_000);

  it('connects real legacy HCL inspection through approval and manifest publication', async () => {
    const root = await folder('liftoff-repair-real-source-'), home = await folder('liftoff-repair-home-');
    const manifest = await createLegacyInfrastructureFixture(root, ['dev']);
    await writeFile(path.join(root, 'liftoff.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const source = await readFile(path.join(root, ...repairRoot, 'main.tf'));
    const first = await command({ root, home }, check);
    expect(first.report.blockers).toEqual([]);
    expect(first.report.status).toBe('available');
    const applied = await command({ root, home }, ['--approve-plan', first.report.fingerprint]);
    expect(applied.report.blockers).toEqual([]);
    expect(applied.report.status).toBe('applied');
    expect(await readFile(path.join(root, ...repairRoot, 'modules', 'application', 'main.tf'))).toEqual(source);
    expect(assessInfrastructureLayout(await loadManifest(root)).kind).toBe('independent');
    const current = await command({ root, home }, ['--check']);
    expect(current.report.status).toBe('current');
  });

  it('previews without project writes and commits only separately approved scope', async () => {
    const project = await fixture(), runner = new Runner();
    const first = await command(project, check, runner);
    expect(first.exitCode).toBe(2);
    expect(first.report).toMatchObject({ status: 'available', committed: false, eligibility: { status: 'verified-undeployed' } });
    expect(await readFile(path.join(project.root, 'liftoff.manifest.json'))).toEqual(project.before);
    expect(runner.calls.every((entry) => entry.command.executable === 'az')).toBe(true);
    const applied = await command(project, ['--approve-plan', first.report.fingerprint], runner);
    expect(applied.report).toMatchObject({ status: 'applied', committed: true, repairScopeComplete: true, verification: 'passed' });
    expect(applied.exitCode).toBe(0);
    expect(assessInfrastructureLayout(await loadManifest(project.root)).kind).toBe('independent');
    expect(await readFile(path.join(applied.report.historyPath, 'manifest.json'))).toEqual(project.before);
    await expect(stat(path.join(project.root, ...oldMain))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(project.root, 'developer-notes.txt'), 'utf8')).toBe('preserve business customizations');
    expect(runner.calls.filter((entry) => entry.command.executable === 'az' && entry.command.args[0] === 'group')).toHaveLength(3);
    const repeat = await command(project, ['--check']);
    expect(repeat.exitCode).toBe(0);
    expect(repeat.report.status).toBe('current');
  });
  it('rejects changed source before validation or writes', async () => {
    const project = await fixture();
    const first = await command(project, check);
    await writeFile(path.join(project.root, ...oldMain), 'developer edit');
    const result = await command(project, ['--approve-plan', first.report.fingerprint]);
    expect(result.exitCode).toBe(1);
    expect(result.report.blockers.join(' ')).toContain('changed after preview');
    expect(result.runner.calls.every((entry) => entry.command.executable === 'az')).toBe(true);
    expect(await readFile(path.join(project.root, ...oldMain), 'utf8')).toBe('developer edit');
  });
  it('rejects newly occupied destinations and preserves them', async () => {
    const project = await fixture();
    const first = await command(project, check);
    const target = path.join(project.root, 'infrastructure', 'opentofu', 'azure', 'modules', 'application', 'main.tf');
    await writeFile(target, 'new developer module');
    const result = await command(project, ['--approve-plan', first.report.fingerprint]);
    expect(result.exitCode).toBe(1);
    expect(await readFile(target, 'utf8')).toBe('new developer module');
  });
  it('does not commit a candidate that fails isolated validation', async () => {
    const project = await fixture(), runner = new Runner();
    const first = await command(project, check, runner);
    runner.failValidation = true;
    const result = await command(project, ['--approve-plan', first.report.fingerprint], runner);
    expect(result.exitCode).toBe(1);
    expect(result.report.committed).toBe(false);
    expect(await readFile(path.join(project.root, 'liftoff.manifest.json'))).toEqual(project.before);
  });
  it('reobserves deployment and source changes under lock before commit', async () => {
    const project = await fixture(), runner = new Runner();
    const first = await command(project, check, runner);
    runner.onValidation = async () => { runner.exists = true; };
    const result = await command(project, ['--approve-plan', first.report.fingerprint], runner);
    expect(result.report.committed).toBe(false);
    expect(result.report.blockers.join(' ')).toContain('eligibility changed');
    expect(await readFile(path.join(project.root, 'liftoff.manifest.json'))).toEqual(project.before);
  });
  it('does not accept approval from another project and supports nested discovery', async () => {
    const project = await fixture();
    const first = await command(project, check);
    const other = await folder('liftoff-repair-other-');
    await writeFile(path.join(other, 'liftoff.manifest.json'), project.before);
    const wrong = await command(project, ['--project', other, '--approve-plan', first.report.fingerprint]);
    expect(wrong.exitCode).toBe(1);
    expect(wrong.report.blockers.join(' ')).toContain('No matching repair preview');
    const nested = path.join(project.root, 'nested directory');
    await mkdir(nested);
    const result = await command(project, ['--check'], new Runner(), nested);
    expect(result.report.projectRoot).toBe(project.root);
    expect(result.report.status).toBe('blocked');
    expect(result.runner.calls).toEqual([]);
  });
  it('does not initialize an ordinary directory', async () => {
    const root = await folder('liftoff-repair-empty-'), home = await folder('liftoff-repair-home-');
    const result = await command({ root, home }, ['--check']);
    expect(result.exitCode).toBe(1);
    expect(result.report.committed).toBe(false);
    await expect(stat(path.join(root, 'liftoff.manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
