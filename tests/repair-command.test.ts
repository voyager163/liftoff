import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile, stat, realpath } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { runCommand as runProjectCommand } from '../src/commands.js';
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
import type { ExternalCommand, LiftoffManifest } from '../src/domain/project/contracts.js';
import { CaptureStream, scriptedTtyInput, ttyCaptureStream } from './helpers.js';
import { repairCommandAction } from '../src/application/repair/guidance.js';
import { inspectRepairVerificationWorkspaces } from '../src/application/repair/workspaces.js';
import { baselineValidationPolicy } from '../src/application/repair/baseline-validation.js';
import { createLegacyInfrastructureFixture, repairRoot } from './fixtures/repair-infrastructure.js';
import { renderOpenTofuProviderLock, renderOpenTofuVersions } from '../src/opentofu-template-assets.js';

interface OwnedFixtureRoot {
  path: string;
  device: number;
  inode: number;
  birthtimeMs: number;
  mode: number;
}

const roots: OwnedFixtureRoot[] = [];
const nativeRunners = new Set<NativeRunner>();
let activeInvocations = 0;
const subscription = '11111111-2222-3333-4444-555555555555';
const oldMain = ['infrastructure', 'opentofu', 'azure', 'main.tf'];
const now = new Date('2026-09-13T01:00:00Z');
async function cleanupOwnedFixtures(
  current: readonly OwnedFixtureRoot[], owners: readonly Pick<NativeRunner, 'pending' | 'uncertain'>[], invocations: number
): Promise<void> {
  if (invocations || owners.some((runner) => runner.pending || runner.uncertain)) {
    throw new Error(`Retaining exact infrastructure-repair fixtures with active or uncertain owned work: ${current.map((root) => root.path).join(', ')}`);
  }
  for (const root of current) {
    const identity = await lstat(root.path);
    if (!identity.isDirectory() || identity.isSymbolicLink() || await realpath(root.path) !== root.path ||
        identity.dev !== root.device || identity.ino !== root.inode ||
        identity.birthtimeMs !== root.birthtimeMs || identity.mode !== root.mode) {
      throw new Error(`Infrastructure-repair fixture creation identity changed; preserving ${root.path}`);
    }
    await rm(root.path, { recursive: true });
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  const current = roots.splice(0), owners = [...nativeRunners];
  nativeRunners.clear();
  if (owners.some((runner) => !runner.completed)) {
    throw new Error(`Retaining incomplete native repair fixtures: ${JSON.stringify({
      exactPaths: current.map((root) => root.path), activeInvocations,
      nativeOwners: owners.map((runner) => ({ pending: runner.pending, uncertain: runner.uncertain }))
    })}`);
  }
  await cleanupOwnedFixtures(current, owners, activeInvocations);
  if (owners.length) console.info('Native repair fixture cleanup:', JSON.stringify({
    removedExactPaths: current.map((root) => root.path), activeInvocations,
    pendingNativeCommands: owners.reduce((count, runner) => count + runner.pending, 0),
    uncertain: owners.some((runner) => runner.uncertain)
  }));
});

async function runCommand(...args: Parameters<typeof runProjectCommand>): Promise<number> {
  activeInvocations++;
  try { return await runProjectCommand(...args); }
  finally { activeInvocations--; }
}

const hash = (bytes: string | Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
async function folder(prefix: string) {
  const value = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  const identity = await lstat(value);
  roots.push({ path: value, device: identity.dev, inode: identity.ino, birthtimeMs: identity.birthtimeMs, mode: identity.mode });
  return value;
}
async function fixture() {
  const root = await folder('liftoff-repair-project with spaces-');
  const home = await folder('liftoff-repair-receipts-');
  await mkdir(path.join(root, '.git'));
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
  settled = true;
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
    return { command, displayCommand: '', stdout, stderr: '', status: 0, signal: null, timedOut: false, processTreeSettled: this.settled };
  }
}
class NativeRunner extends Runner {
  readonly native = new NodeCommandRunner();
  readonly nativeResults: { command: ExternalCommand; options?: RunCommandOptions; result: CommandResult }[] = [];
  pending = 0;
  uncertain = false;
  completed = false;

  constructor() { super(); nativeRunners.add(this); }

  override async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    if (command.executable === 'az') return super.run(command, options);
    this.calls.push({ command, options });
    this.pending++;
    try {
      const result = await this.native.run(command, options);
      this.uncertain ||= result.processTreeSettled !== true;
      this.nativeResults.push({ command, options, result });
      return result;
    } catch (error) {
      this.uncertain = true;
      throw error;
    } finally { this.pending--; }
  }
}
async function command(project: { root: string; home: string }, args: string[], runner = new Runner(), cwd = project.root) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const explicitProject = args.indexOf('--project');
  const selectedProject = explicitProject >= 0 ? path.resolve(cwd, args[explicitProject + 1]!) : project.root;
  const exitCode = await runCommand(parseArgs(['repair', ...args, '--json']), {
    cwd, stdout, stderr, runner, updateNow: () => now,
    updatePreview: { homedir: project.home, env: {}, repositoryRoot: selectedProject }
  });
  return { exitCode, report: JSON.parse(stdout.text()), stderr: stderr.text(), runner };
}

async function upgradeRepairFixtureMetadata(root: string, home: string, manifest: LiftoffManifest) {
  const workload = manifest.project.workload;
  if (workload.kind === 'components') throw new Error('Expected historical API fixture.');
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, 'liftoff.config.json'), `${JSON.stringify({
    projectName: manifest.project.name, projectType: workload.kind, apiStack: workload.apiStack,
    ...(workload.kind === 'genai' ? { pattern: workload.pattern } : {}),
    cloud: workload.cloud, region: workload.region, includeFrontend: workload.frontend, environments: workload.environments,
    specWorkflow: manifest.project.specWorkflow, agents: manifest.project.agents, governanceProfile: 'none'
  }, null, 2)}\n`);
  const run = async (flags: string[]) => {
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    const code = await runCommand(parseArgs(['update', '--project', root, '--json', ...flags]), {
      cwd: root, stdout, stderr, updateNow: () => now, updatePreview: { homedir: home, env: {}, repositoryRoot: root }
    });
    return { code, report: JSON.parse(stdout.text()) as { plans: Array<{ mode: string; fingerprint: string }>; message?: string } };
  };
  const preview = await run(['--check']);
  expect(preview.code, preview.report.message).toBe(2);
  const apply = await run(['--approve-plan', preview.report.plans.find((plan) => plan.mode === 'normal')!.fingerprint]);
  expect(apply.code, apply.report.message).toBe(0);
}

const check = ['--check', '--live', '--subscription', subscription];
describe('infrastructure-repair fixture cleanup ownership', () => {
  it.each([
    { invocations: 1, pending: 0, uncertain: false },
    { invocations: 0, pending: 1, uncertain: false },
    { invocations: 0, pending: 0, uncertain: true }
  ])('retains exact fixture roots while owned work is active or uncertain: %j', async (state) => {
    const root = await folder('liftoff-repair-cleanup-');
    const owner = roots.at(-1)!;
    await expect(cleanupOwnedFixtures([owner], [state], state.invocations)).rejects.toThrow(/active or uncertain/);
    expect((await lstat(root)).isDirectory()).toBe(true);
  });

  it('does not delete a path with mismatching creation identity', async () => {
    const root = await folder('liftoff-repair-cleanup-');
    const owner = roots.at(-1)!;
    await expect(cleanupOwnedFixtures([{ ...owner, inode: owner.inode + 1 }], [], 0)).rejects.toThrow(/creation identity changed/);
    expect((await lstat(root)).isDirectory()).toBe(true);
  });
});

describe('reviewed repair command coordinator', () => {
  it.runIf(process.env.LIFTOFF_REPAIR_NATIVE === '1')('validates a repaired candidate with native backend-disabled OpenTofu and no Azure calls', async () => {
    const root = await folder('liftoff-repair-native-'), home = await folder('liftoff-repair-home-');
    const manifest = await createLegacyInfrastructureFixture(root, ['dev']);
    await writeFile(path.join(root, 'liftoff.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await upgradeRepairFixtureMetadata(root, home, manifest);
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
    const runner = new NativeRunner();
    const bound = (await baselineValidationPolicy(root)).tool;
    const nativeExecutable = bound.file.path;
    const scratch = await folder('liftoff-repair-native-scratch-');
    const configuration = path.join(home, 'native-tofu.rc');
    await writeFile(configuration, '', { flag: 'wx', mode: 0o600 });
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of Object.keys(env)) {
      if (['TF_', 'TOFU_', 'OTF_', 'ARM_', 'AZURE_', 'AWS_', 'GOOGLE_'].some((prefix) => name.startsWith(prefix))) {
        env[name] = undefined;
      }
    }
    Object.assign(env, {
      HOME: home, USERPROFILE: home, APPDATA: home, XDG_CONFIG_HOME: home,
      TF_CLI_CONFIG_FILE: configuration, TF_IN_AUTOMATION: '1', TF_INPUT: '0', CHECKPOINT_DISABLE: '1',
      TMPDIR: scratch, TMP: scratch, TEMP: scratch
    });
    const formatted = await runner.run({ executable: nativeExecutable, args: ['fmt', '-recursive'] }, {
      cwd: path.join(root, ...repairRoot), timeoutMs: 30_000, maxOutputBytes: 65536,
      env, ensureProcessTreeSettled: true, stream: false
    });
    expect(formatted.status).toBe(0);
    expect(formatted.processTreeSettled).toBe(true);
    const beforeValidation = runner.nativeResults.length;
    const first = await command({ root, home }, check, runner);
    expect(first.report.blockers).toEqual([]);
    expect(first.report.validationSummary).toContain(`Installed OpenTofu: ${nativeExecutable}; SHA-256 ${bound.file.digest}.`);
    const applied = await command({ root, home }, ['--approve-plan', first.report.fingerprint], runner);
    expect(applied.report.blockers).toEqual([]);
    expect(applied.report.status).toBe('applied');
    expect(applied.exitCode).toBe(0);
    const validation = runner.nativeResults.slice(beforeValidation);
    expect(validation.map((entry) => entry.command.args[0])).toEqual(['--version', 'fmt', 'init', 'validate']);
    expect(validation.every((entry) => entry.command.executable === nativeExecutable &&
      entry.options?.ensureProcessTreeSettled === true && entry.result.processTreeSettled === true)).toBe(true);
    expect(validation[2]!.command.args).toContain('-backend=false');
    expect(validation[2]!.command.args).toContain('-lockfile=readonly');
    expect(JSON.parse(validation[3]!.result.stdout)).toMatchObject({ valid: true, error_count: 0 });
    const formatting = await runner.run({ executable: nativeExecutable, args: ['fmt', '-check', '-recursive'] }, {
      cwd: path.join(root, ...repairRoot), timeoutMs: 30_000, maxOutputBytes: 65536,
      env, ensureProcessTreeSettled: true, stream: false
    });
    expect(formatting.stdout).toBe('');
    expect(formatting.status).toBe(0);
    expect(formatting.processTreeSettled).toBe(true);
    const workspaces = await inspectRepairVerificationWorkspaces(root, { homedir: home, env: {}, repositoryRoot: root });
    expect(workspaces.status).toBe('absent');
    expect(runner.pending).toBe(0);
    expect(runner.uncertain).toBe(false);
    runner.completed = true;
    console.info('Native repair validation evidence:', JSON.stringify({
      executable: nativeExecutable, digest: bound.file.digest,
      version: validation[0]!.result.stdout.trim(), committed: applied.report.committed,
      verification: applied.report.verification, registeredWorkspaces: workspaces.status,
      nativeCommands: runner.nativeResults.map((entry) => ({
        args: entry.command.args, status: entry.result.status, processTreeSettled: entry.result.processTreeSettled,
        timedOut: entry.result.timedOut
      })),
      mockedAzureCalls: runner.calls.filter((entry) => entry.command.executable === 'az').map((entry) => entry.command.args)
    }));
  }, 180_000);

  it('connects real legacy HCL inspection through approval and manifest publication', async () => {
    const root = await folder('liftoff-repair-real-source-'), home = await folder('liftoff-repair-home-');
    const manifest = await createLegacyInfrastructureFixture(root, ['dev']);
    await writeFile(path.join(root, 'liftoff.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await upgradeRepairFixtureMetadata(root, home, manifest);
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
    expect(JSON.parse(await readFile(path.join(applied.report.historyPath, 'receipt.json'), 'utf8'))).toMatchObject({
      schemaVersion: 2, repairContractVersion: 1, recipe: { id: 'azure-local-layout', version: 1 }, activationEvidence: 'not-issued'
    });
    await expect(stat(path.join(project.root, ...oldMain))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(project.root, 'developer-notes.txt'), 'utf8')).toBe('preserve business customizations');
    expect(runner.calls.filter((entry) => entry.command.executable === 'az' && entry.command.args[0] === 'group')).toHaveLength(4);
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
  it('retains registered infrastructure workspaces when even a zero-exit tool has uncertain settlement', async () => {
    const project = await fixture(), runner = new Runner();
    const first = await command(project, check, runner);
    runner.settled = false;
    const result = await command(project, ['--approve-plan', first.report.fingerprint], runner);
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatchObject({
      committed: false, status: 'partial', verification: 'incomplete',
      verificationEffects: { attempted: true, outcome: 'incomplete' }
    });
    const storage = { homedir: project.home, env: {}, repositoryRoot: project.root };
    const workspaces = await inspectRepairVerificationWorkspaces(project.root, storage);
    expect(workspaces.status).toBe('blocked');
    expect(workspaces.workspaces[0]).toMatchObject({ owner: 'uncertain', cleanupComplete: false, commandsStarted: 1 });
    const retained = workspaces.workspaces[0]!.directory;
    expect((await stat(retained)).isDirectory()).toBe(true);
    expect((await command(project, ['--recover'], runner)).report.status).toBe('blocked');
    expect((await stat(retained)).isDirectory()).toBe(true);
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

describe('interactive repair and truthful command surfaces', () => {
  it('reports capabilities outside a project without probing tools or creating receipts', async () => {
    const root = await folder('liftoff-repair-capabilities-'), home = await folder('liftoff-repair-capabilities-home-');
    const stdout = new CaptureStream(), stderr = new CaptureStream(), runner = new Runner();
    const code = await runCommand(parseArgs(['repair', '--capabilities', '--json']), {
      cwd: root, stdout, stderr, runner, updatePreview: { homedir: home, env: {} }
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      schemaVersion: 1, kind: 'liftoff-repair-capabilities', repairContractVersion: 1,
      schemas: { report: 2, preview: 2, journal: 2 },
      modes: expect.arrayContaining(['interactive-repair', 'inspect-layout', 'application-patch'])
    });
    expect(runner.calls).toEqual([]);
    expect(await readdir(root)).toEqual([]);
    expect(await readdir(home)).toEqual([]);
  });

  it('reports absent or incompatible recovery journals without parsing or rewriting the active manifest', async () => {
    const project = await fixture();
    await writeFile(path.join(project.root, 'liftoff.manifest.json'), 'interrupted invalid manifest');
    const absent = await command(project, ['--recover']);
    expect(absent.exitCode).toBe(0);
    expect(absent.report).toMatchObject({ schemaVersion: 2, operationKind: 'recover', requestedScope: 'repair-recovery', committed: false });
    const journal = path.join(project.root, '.liftoff', 'reviewed-repair-transaction.json');
    await mkdir(path.dirname(journal), { recursive: true });
    const bytes = '{"schemaVersion":99,"untrusted":true}\n';
    await writeFile(journal, bytes, { mode: 0o600 });
    const blocked = await command(project, ['--check']);
    expect(blocked.exitCode).toBe(2);
    expect(blocked.report.status).toBe('blocked');
    expect(blocked.report.nextActions[0]).toMatchObject({
      command: { executable: 'liftoff', args: ['repair', project.root, '--recover'] }, cwd: project.root
    });
    expect((await command(project, ['--recover'])).report.status).toBe('blocked');
    expect(await readFile(journal, 'utf8')).toBe(bytes);
    expect(await readFile(path.join(project.root, 'liftoff.manifest.json'), 'utf8')).toBe('interrupted invalid manifest');
  });

  it.each([false, true])('binds a default-No TTY answer %s to the displayed infrastructure plan', async (answer) => {
    const project = await fixture(), runner = new Runner(), stdout = new CaptureStream(), stderr = ttyCaptureStream();
    const approveRepairPlan = vi.fn(async (config: { message: string; default: false }) => {
      expect(config.default).toBe(false);
      expect(config.message).not.toMatch(/[a-f0-9]{64}/u);
      expect(stdout.text()).toContain('Exact project file changes');
      expect(runner.calls.some((entry) => entry.command.executable !== 'az')).toBe(false);
      return answer;
    });
    const code = await runCommand(parseArgs(['repair', project.root, '--live', '--subscription', subscription]), {
      cwd: project.root, stdin: scriptedTtyInput(''), stdout, stderr, runner, approveRepairPlan,
      updateNow: () => now, updatePreview: { homedir: project.home, env: {}, repositoryRoot: project.root }
    });
    expect(approveRepairPlan).toHaveBeenCalledTimes(1);
    expect(code).toBe(answer ? 0 : 2);
    if (answer) expect(assessInfrastructureLayout(await loadManifest(project.root)).kind).toBe('independent');
    else {
      expect(await readFile(path.join(project.root, 'liftoff.manifest.json'))).toEqual(project.before);
      expect(runner.calls.some((entry) => entry.command.executable === 'tofu')).toBe(false);
    }
  });

  it('rejects source changes during TTY approval before running validation or starting the transaction', async () => {
    const project = await fixture(), runner = new Runner(), stdout = new CaptureStream(), stderr = ttyCaptureStream();
    const code = await runCommand(parseArgs(['repair', project.root, '--live', '--subscription', subscription]), {
      cwd: project.root, stdin: scriptedTtyInput(''), stdout, stderr, runner,
      approveRepairPlan: async () => { await writeFile(path.join(project.root, ...oldMain), 'concurrent developer edit'); return true; },
      updateNow: () => now, updatePreview: { homedir: project.home, env: {}, repositoryRoot: project.root }
    });
    expect(code).toBe(1);
    expect(stdout.text()).toContain('changed after preview');
    expect(runner.calls.some((entry) => entry.command.executable === 'tofu')).toBe(false);
    expect(await readFile(path.join(project.root, ...oldMain), 'utf8')).toBe('concurrent developer edit');
    expect(await readFile(path.join(project.root, 'liftoff.manifest.json'))).toEqual(project.before);
  });

  it.each(['cancel', 'eof', 'pipe', 'json'] as const)('does not turn %s input into repair consent', async (mode) => {
    const project = await fixture(), runner = new Runner(), stdout = new CaptureStream(), stderr = ttyCaptureStream();
    const stdin = mode === 'pipe' ? Readable.from(['yes\n']) : scriptedTtyInput('');
    if (mode === 'eof') for await (const _chunk of stdin) { /* Terminal EOF. */ }
    const approveRepairPlan = vi.fn(async () => {
      if (mode === 'cancel') throw Object.assign(new Error('cancelled'), { name: 'ExitPromptError' });
      return true;
    });
    const code = await runCommand(parseArgs(['repair', project.root, '--live', '--subscription', subscription, ...(mode === 'json' ? ['--json'] : [])]), {
      cwd: project.root, stdin, stdout, stderr, runner, approveRepairPlan,
      updateNow: () => now, updatePreview: { homedir: project.home, env: {}, repositoryRoot: project.root }
    });
    expect(code).toBe(2);
    expect(approveRepairPlan).toHaveBeenCalledTimes(mode === 'cancel' ? 1 : 0);
    if (mode === 'json') expect(JSON.parse(stdout.text())).toMatchObject({ schemaVersion: 2, status: 'available', committed: false });
    expect(runner.calls.some((entry) => entry.command.executable === 'tofu')).toBe(false);
    expect(await readFile(path.join(project.root, 'liftoff.manifest.json'))).toEqual(project.before);
  });

  it('formats every repair action as exact native arguments with safe Windows and POSIX quoting', () => {
    const project = path.win32.join('C:\\', 'Projects', "O'Brien & $build");
    const action = repairCommandAction(project, ['--approve-plan', 'a'.repeat(64)], {
      id: 'approve', label: 'Optional automation', description: 'Separate approval', approvalRequired: true
    }, 'win32');
    expect(action).toMatchObject({
      cwd: project, command: { executable: 'liftoff', args: ['repair', project, '--approve-plan', 'a'.repeat(64)] },
      displayCommand: `& 'liftoff' 'repair' 'C:\\Projects\\O''Brien & $build' '--approve-plan' '${'a'.repeat(64)}'`
    });
    const posixRoot = path.posix.join('/tmp', "O'Brien & $build");
    const posix = repairCommandAction(posixRoot, ['--recover'], { id: 'recover', label: 'Recover', description: 'Recorded scope' }, 'linux');
    expect(posix).toMatchObject({
      command: { executable: 'liftoff', args: ['repair', posixRoot, '--recover'] },
      displayCommand: `liftoff repair '/tmp/O'"'"'Brien & $build' --recover`
    });
  });

  it.each([
    ['--check', '--approve-plan', 'a'.repeat(64)],
    ['--verify-plan', 'a'.repeat(64), '--approve-plan', 'a'.repeat(64)],
    ['--capabilities', '--project', 'project'],
    ['--capabilities', '--check'],
    ['--inspect-layout', '--live', '--subscription', subscription],
    ['--application-patch', 'patch.json', '--recover'],
    ['--application-patch', 'patch.json', '--approve-plan', 'a'.repeat(64)],
    ['--check', '--allow-network'],
    ['--check', '--allow-dependency-preparation'],
    ['--check', '--allow-dependency-preparation=false'],
    ['--application-patch', 'patch.json', '--allow-dependency-preparation'],
    ['--approve-plan', 'a'.repeat(64), '--allow-dependency-preparation'],
    ['--yes'], ['--force']
  ])('rejects expanded or ambiguous authority %j', (flags) => {
    expect(() => parseArgs(['repair', ...flags])).toThrow();
  });
});
