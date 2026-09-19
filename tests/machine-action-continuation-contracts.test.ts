import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import type { CommandContext } from '../src/application/context.js';
import type { StructuredContinuationV1 } from '../src/protocol/continuation.js';
import { validateStructuredContinuation } from '../src/protocol/continuation.js';
import { formatNativeSafeCommandLine } from '../src/domain/execution/continuation.js';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { createFixtureProject } from '../src/application/initialize/fixture.js';
import { inspectAdoption } from '../src/application/project-evolution/adoption/planning.js';
import type { AdoptionProposal } from '../src/application/project-evolution/adoption/proposal.js';
import { inspectGovernanceTransition } from '../src/application/repository-governance/inspection.js';
import { executeApplyNext } from '../src/governance-activation/transitions.js';
import { executeSkillsUseCase, type SkillsUseCaseDependencies } from '../src/application/skills/use-case.js';
import { validateSkillsCommandRequest } from '../src/application/skills/request.js';
import { assertGovernanceConfigurationBinding } from '../src/application/repository-governance/configuration.js';
import { loadManifest } from '../src/application/project/manifest.js';
import type { CommandRunner } from '../src/process-runner.js';
import type { SelfUpgradeExecutor } from '../src/self-upgrade.js';
import { liftoffVersion } from '../src/version.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';
import { createApplicationRepairFixture, stageApplicationRepairFixture } from './fixtures/repair-application.js';
import { createLegacyInfrastructureFixture } from './fixtures/repair-infrastructure.js';
import { signedFixture, type SignedFixture } from './distribution/native-fixture.js';
import { InstallationDetector } from '../src/adapters/distribution/installation-detector.js';
import type { InstallationCommandContext } from '../src/cli/commands/installation.js';

interface OwnedRoot {
  path: string; device: number; inode: number; mode: number; birthtimeMs: number;
}
const roots: OwnedRoot[] = [];
const native: Array<{ fixture: SignedFixture; pending: number; uncertain: boolean }> = [];
let active = 0;

afterEach(async () => {
  vi.restoreAllMocks();
  const current = roots.splice(0), installations = native.splice(0);
  if (active || installations.some((owner) => owner.pending || owner.uncertain)) {
    throw new Error(`Retaining active/uncertain continuation fixtures: ${JSON.stringify([
      ...current.map((root) => root.path), ...installations.map((owner) => owner.fixture.root)
    ])}`);
  }
  for (const owner of installations) await owner.fixture.cleanup();
  for (const root of current) {
    const identity = await lstat(root.path);
    if (!identity.isDirectory() || identity.isSymbolicLink() || await realpath(root.path) !== root.path ||
        identity.dev !== root.device || identity.ino !== root.inode ||
        identity.mode !== root.mode || identity.birthtimeMs !== root.birthtimeMs) {
      throw new Error(`Continuation fixture creation identity changed; preserving ${root.path}`);
    }
    await rm(root.path, { recursive: true });
  }
});

async function own(directory: string): Promise<string> {
  const root = await realpath(directory), identity = await lstat(root);
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error('Expected a newly created owned fixture directory.');
  roots.push({ path: root, device: identity.dev, inode: identity.ino, mode: identity.mode, birthtimeMs: identity.birthtimeMs });
  return root;
}

async function scoped<T>(operation: (f: {
  parent: string; project: string; elsewhere: string; home: string; staging: string;
  now: Date; storage: (root: string) => NonNullable<CommandContext['updatePreview']>;
}) => Promise<T>): Promise<T> {
  active++;
  try {
    const parent = await own(await mkdtemp(path.join(os.tmpdir(), "liftoff machine actions's ")));
    const project = path.join(parent, 'project'), elsewhere = path.join(parent, 'other cwd');
    const home = path.join(parent, 'private home'), staging = path.join(parent, 'external inputs');
    for (const directory of [project, elsewhere, home, staging]) await mkdir(directory);
    const now = new Date();
    return await operation({
      parent, project, elsewhere, home, staging, now,
      storage: (root) => ({ homedir: home, repositoryRoot: root, env: {}, clock: () => now })
    });
  } finally { active--; }
}

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const noProcesses = (): CommandRunner => ({ run: vi.fn(async () => { throw new Error('This continuation has no process authority.'); }) });

async function invoke(cwd: string, args: readonly string[], extra: Partial<CommandContext> = {}) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const code = await runCommand(parseArgs([...args]), {
    cwd, stdout, stderr, runner: noProcesses(), terminal: { color: false, layout: 'plain' }, ...extra
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

function machine(value: unknown): StructuredContinuationV1 {
  const action = validateStructuredContinuation(value);
  const platform = /^[A-Za-z]:\\/u.test(action.cwd) || action.cwd.startsWith('\\\\') ? 'win32' : 'linux';
  expect(action.displayCommand).toBe(formatNativeSafeCommandLine(action.executable, action.args, platform));
  expect(action.requiredAuthority).toBeDefined();
  expect(Array.isArray(action.requiredAuthority)).toBe(true);
  expect(action.args.length).toBeGreaterThan(0);
  parseArgs([...action.args]);
  return action;
}

function without(args: readonly string[], flag: string, value = false): string[] {
  const result = [...args], index = result.indexOf(flag);
  if (index < 0) throw new Error(`Fixture action did not contain ${flag}.`);
  result.splice(index, value ? 2 : 1);
  return result;
}

async function vue(root: string) {
  await writeFile(path.join(root, 'package.json'), '{"name":"existing-view","private":true,"type":"module","dependencies":{"vue":"^3.5.0"}}\n');
  await writeFile(path.join(root, 'App.vue'), '<template><main>Original customer dashboard</main></template>\n');
}

async function generated(governance = false, spec: 'openspec' | 'spec-kit' = 'openspec') {
  const root = await createFixtureProject({
    projectName: 'Machine continuation target', projectType: 'standard', apiStack: 'node',
    specWorkflow: spec, agents: [spec === 'spec-kit' ? 'codex' : 'copilot'],
    ...(spec === 'spec-kit' ? { defaultAgent: 'codex' } : {}),
    environments: ['dev'], governanceProfile: governance ? 'single-maintainer-gitflow' : 'none'
  });
  await own(path.dirname(root));
  return await realpath(root);
}

describe('actual emitted project machine actions', () => {
  it('replays an actual assessment adoption recommendation from another cwd without initializing the wrong directory', async () => scoped(async (f) => {
    await vue(f.project);
    const result = await invoke(f.parent, ['assess', '--project', f.project, '--profile', 'vue-component', '--json']);
    expect(result.code).toBe(2);
    const report = JSON.parse(result.stdout);
    const recommendation = report.recommendations.find((entry: { capabilityId: string; continuation?: unknown }) =>
      entry.capabilityId === 'project-adoption' && entry.continuation);
    expect(recommendation).toBeDefined();
    const action = machine(recommendation.continuation);
    expect(action).toMatchObject({
      project: f.project, targetScope: 'project', requiredAuthority: ['separate-preview-invocation']
    });
    const replay = await invoke(f.elsewhere, action.args, { updatePreview: f.storage(f.project), updateNow: () => f.now });
    expect(replay.code, replay.stderr || replay.stdout).toBe(2);
    expect(JSON.parse(replay.stdout)).toMatchObject({ schemaVersion: 1, command: 'adopt', projectRoot: f.project, committed: false });
    expect(await readdir(f.elsewhere)).toEqual([]);
    expect(await readdir(f.project)).not.toContain('liftoff.manifest.json');
  }));

  it('retains captured assessment configuration as nonexecuting guidance when the next command cannot consume it', async () => scoped(async (f) => {
    await vue(f.project);
    const config = path.join(f.staging, 'public settings.json'), bytes = '{"schemaVersion":1,"phases":{}}\n';
    await writeFile(config, bytes);
    const report = JSON.parse((await invoke(f.parent, [
      'assess', '--project', f.project, '--profile', 'vue-component',
      '--inputs', path.relative(f.parent, config), '--json'
    ])).stdout);
    expect(report.capturedInputs.reference).toBe(config);
    expect(report.capturedInputs.digest.replace(/^sha256:/u, '')).toBe(sha(bytes));
    expect(report.recommendations.length).toBeGreaterThan(0);
    for (const recommendation of report.recommendations) {
      expect(recommendation).toMatchObject({ executable: null, args: [], status: 'blocked' });
      expect(recommendation.continuation).toBeUndefined();
      expect(recommendation.inputs.reference).toBe(config);
    }
  }));

  it('replays actual adoption check/file actions with the same external proposal and refuses missing authority or changed bytes', async () => scoped(async (f) => {
    await vue(f.project);
    const inspected = await inspectAdoption({ project: f.project, profile: 'vue-component', now: f.now });
    const proposal: AdoptionProposal = {
      schemaVersion: 1, kind: 'liftoff-adoption-proposal', projectRoot: f.project,
      inspectionDigest: inspected.inventory.inspectionDigest, projectName: 'existing-view', profile: 'vue-component',
      componentRootPathParts: [], framework: { workflow: 'openspec', agents: [], initialize: false, copilotCloud: false },
      governanceProfile: 'none', dynamicReferencesReviewed: true, patch: null, additions: [],
      verification: { commands: [], preparation: [] }
    };
    const filename = path.join(f.staging, 'proposal with spaces.json'), bytes = `${JSON.stringify(proposal, null, 2)}\n`;
    await writeFile(filename, bytes, { mode: 0o600 });
    const report = JSON.parse((await invoke(f.parent, [
      'adopt', '--project', f.project, '--proposal', path.relative(f.parent, filename), '--check', '--json'
    ], { updatePreview: f.storage(f.project), updateNow: () => f.now })).stdout);
    expect(report.status).toBe('planned');
    const actions = report.nextActions.map(machine);
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      expect(action).toMatchObject({ project: f.project, cwd: f.project, configPath: filename, configDigest: sha(bytes), scope: 'project-adoption' });
    }
    const check = actions.find((action: StructuredContinuationV1) => action.args.includes('--check'))!;
    const apply = actions.find((action: StructuredContinuationV1) => action.args.includes('--approve-plan'))!;
    expect(check.requiredAuthority).toEqual([]);
    expect(apply.requiredAuthority).toContain('exact-file-transaction');
    expect((await invoke(f.elsewhere, check.args, { updatePreview: f.storage(f.project), updateNow: () => f.now })).code).toBe(2);
    const denied = await invoke(f.elsewhere, without(apply.args, '--approve-plan', true), { updatePreview: f.storage(f.project), updateNow: () => f.now });
    expect(denied.code).toBe(2);
    expect(await readdir(f.project)).not.toContain('liftoff.manifest.json');
    await writeFile(filename, `${bytes}\n`);
    expect((await invoke(f.elsewhere, apply.args, { updatePreview: f.storage(f.project), updateNow: () => f.now })).code).toBe(1);
    expect(await readdir(f.project)).not.toContain('liftoff.manifest.json');
    expect(await readdir(f.elsewhere)).toEqual([]);
  }));

  it('keeps update schema 3 and actual emitted check/apply targets when replayed from another cwd', async () => scoped(async (f) => {
    const root = await generated(false);
    await mkdir(path.join(root, '.git'));
    const manifest = await loadManifest(root);
    const managed = manifest.managedArtifacts.find((entry) => !['liftoff.config.json', 'liftoff.manifest.json'].includes(entry.pathParts.at(-1)!))!;
    const guide = path.join(root, ...managed.pathParts);
    await unlink(guide);
    const preview = await invoke(f.parent, ['update', '--check', '--project', root, '--json'], {
      updatePreview: f.storage(root), updateNow: () => f.now
    });
    expect(preview.code, preview.stderr || preview.stdout).toBe(2);
    const report = JSON.parse(preview.stdout);
    expect(report.schemaVersion).toBe(3);
    const actions = report.continuations.map(machine);
    const check = actions.find((action: StructuredContinuationV1) => action.args.includes('--check'))!;
    const apply = actions.find((action: StructuredContinuationV1) => !action.args.includes('--check') && !action.args.includes('--force'))!;
    expect(check).toMatchObject({ project: root, cwd: root, scope: 'project-update', requiredAuthority: [] });
    expect(apply.requiredAuthority).toEqual(['reviewed-plan']);
    const checked = await invoke(f.elsewhere, check.args, { updatePreview: f.storage(root), updateNow: () => f.now });
    expect(checked.code, checked.stderr + checked.stdout).toBe(2);
    const denied = await invoke(f.elsewhere, apply.args, { updatePreview: f.storage(root), updateNow: () => f.now });
    expect(denied.code).toBe(1);
    expect(denied.stderr + denied.stdout).toMatch(/approval|approve/i);
    await expect(lstat(guide)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(f.elsewhere)).toEqual([]);
  }));

  it('keeps real repair proposal bindings and separate verification/network/file authority after cwd changes', async () => scoped(async (f) => {
    const app = await createApplicationRepairFixture(path.join(f.parent, 'application fixture'));
    const staged = await stageApplicationRepairFixture(app.root, app.stage, app.manifest);
    staged.document.verification.commands[0]!.network = true;
    await writeFile(staged.patchPath, `${JSON.stringify(staged.document, null, 2)}\n`);
    const patchBytes = await readFile(staged.patchPath), runner = noProcesses();
    const report = JSON.parse((await invoke(f.parent, [
      'repair', '--project', app.root, '--check', '--application-patch', path.relative(f.parent, staged.patchPath), '--json'
    ], { updatePreview: f.storage(app.root), updateNow: () => f.now, runner })).stdout);
    expect(report).toMatchObject({ schemaVersion: 2, status: 'available', committed: false });
    const actions = report.nextActions.filter((entry: { kind: string; requiresInput?: string[]; continuation?: unknown }) =>
      entry.kind === 'command' && !entry.requiresInput?.length && entry.continuation).map((entry: { continuation: unknown }) => machine(entry.continuation));
    const interactive = actions.find((action: StructuredContinuationV1) => action.args.includes('--application-patch'))!;
    const verify = actions.find((action: StructuredContinuationV1) => action.args.includes('--verify-plan'))!;
    const apply = actions.find((action: StructuredContinuationV1) => action.args.includes('--approve-plan'))!;
    expect(interactive).toMatchObject({ project: app.root, configPath: staged.patchPath, configDigest: sha(patchBytes) });
    expect(verify.requiredAuthority).toContain('verification-plan-approval');
    expect(verify.requiredAuthority).toContain('declared-network-consent');
    expect(apply.requiredAuthority).toEqual(['file-plan-approval']);
    const denied = await invoke(f.elsewhere, without(verify.args, '--allow-network'), {
      updatePreview: f.storage(app.root), updateNow: () => f.now, runner
    });
    expect(denied.code).toBe(2);
    expect(denied.stdout + denied.stderr).toMatch(/network.*consent|network.*approval/i);
    expect(runner.run).not.toHaveBeenCalled();
    await writeFile(staged.patchPath, `${patchBytes.toString()}\n`);
    const stale = await invoke(f.elsewhere, verify.args, { updatePreview: f.storage(app.root), updateNow: () => f.now, runner });
    expect(stale.code).toBe(1);
    expect(stale.stdout + stale.stderr).toMatch(/changed|fresh/i);
    expect(runner.run).not.toHaveBeenCalled();
    expect(await readdir(f.elsewhere)).toEqual([]);
  }));

  it('keeps actual requiresInput repair templates outside executable continuation admission', async () => scoped(async (f) => {
    const root = f.project;
    await mkdir(path.join(root, '.git'));
    const manifest = await createLegacyInfrastructureFixture(root, ['dev']);
    if (manifest.project.workload.kind === 'components') throw new Error('Expected the real legacy infrastructure fixture.');
    const workload = manifest.project.workload;
    await writeFile(path.join(root, 'liftoff.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(root, 'liftoff.config.json'), JSON.stringify({
      projectName: manifest.project.name, projectType: workload.kind, apiStack: workload.apiStack,
      cloud: workload.cloud, region: workload.region, includeFrontend: workload.frontend, environments: workload.environments,
      specWorkflow: manifest.project.specWorkflow, agents: manifest.project.agents, governanceProfile: 'none'
    }));
    const preview = await invoke(f.parent, ['update', '--project', root, '--check', '--json'], {
      updatePreview: f.storage(root), updateNow: () => f.now
    });
    expect(preview.code, preview.stderr || preview.stdout).toBe(2);
    const fingerprint = JSON.parse(preview.stdout).plans.find((plan: { mode: string }) => plan.mode === 'normal').fingerprint;
    const applied = await invoke(f.parent, ['update', '--project', root, '--approve-plan', fingerprint, '--json'], {
      updatePreview: f.storage(root), updateNow: () => f.now
    });
    expect(applied.code, applied.stderr || applied.stdout).toBe(0);
    const report = JSON.parse((await invoke(f.parent, ['repair', '--project', root, '--check', '--json'], {
      updatePreview: f.storage(root), updateNow: () => f.now
    })).stdout);
    const templates = report.nextActions.filter((entry: { requiresInput?: string[] }) => entry.requiresInput?.length);
    expect(templates.length, JSON.stringify({ status: report.status, message: report.message, blockers: report.blockers })).toBeGreaterThan(0);
    for (const template of templates) {
      expect(template.continuation).toBeUndefined();
      expect(() => validateStructuredContinuation(template)).toThrow();
      expect(template.requiresInput).toContain('subscription-id');
    }
  }));
});

describe('actual skills actions and source-contract tamper refusal', () => {
  async function skills(f: Parameters<Parameters<typeof scoped>[0]>[0]) {
    const dependencies: SkillsUseCaseDependencies = {
      homeDirectory: f.home, now: () => f.now, approvalStorage: f.storage(f.project), workspaceStorage: f.storage(f.project)
    };
    const result = await executeSkillsUseCase({
      subcommand: 'install', hosts: ['claude'], scope: 'project', project: f.project,
      skillId: 'assess', check: true, json: true
    }, { cwd: f.parent }, dependencies);
    expect(result.outcome).toBe('planned');
    return { dependencies, result, action: machine(result.nextActions![0]) };
  }
  it('replays exact project delivery then its emitted inspection without altering another cwd', async () => scoped(async (f) => {
    const { dependencies, action } = await skills(f);
    expect(action).toMatchObject({ project: f.project, targetScope: 'project', scope: 'project', requiredAuthority: ['exact-skills-plan-approval'] });
    const applied = await executeSkillsUseCase(validateSkillsCommandRequest(parseArgs([...action.args])), { cwd: f.elsewhere }, dependencies);
    expect(applied).toMatchObject({ outcome: 'executed', result: { committed: true, verified: true } });
    const inspection = machine(applied.nextActions![0]);
    expect(inspection.requiredAuthority).toEqual([]);
    expect((await executeSkillsUseCase(validateSkillsCommandRequest(parseArgs([...inspection.args])), { cwd: f.elsewhere }, dependencies)).outcome).toBe('inspected');
    expect(await readFile(path.join(f.project, '.claude', 'commands', 'liftoff-assess.md'), 'utf8')).toContain('liftoff-assess');
    expect(await readdir(f.elsewhere)).toEqual([]);
  }));
  it('rejects altered target metadata in an actually emitted project skills action', async () => scoped(async (f) => {
    const { action } = await skills(f);
    expect(() => validateStructuredContinuation({ ...action, project: f.elsewhere })).toThrow();
    const args = [...action.args], index = args.indexOf('--project');
    args.splice(index, 2, `--project=${path.relative(action.cwd, f.project)}`);
    const inline = { ...action, args, displayCommand: formatNativeSafeCommandLine(action.executable, args, process.platform) };
    expect(machine(inline).project).toBe(f.project);
    expect(() => validateStructuredContinuation({ ...inline, project: f.elsewhere })).toThrow();
  }));

  it('binds implicit project skills targets to cwd instead of accepting stale project metadata', async () => scoped(async (f) => {
    const { action } = await skills(f);
    const args = without(action.args, '--project', true);
    expect(parseArgs(args).flags.scope).toBe('project');
    const implicit = { ...action, cwd: f.project, args, displayCommand: formatNativeSafeCommandLine(action.executable, args, process.platform) };
    expect(machine(implicit).project).toBe(f.project);
    expect(() => validateStructuredContinuation({ ...implicit, cwd: f.elsewhere })).toThrow();
    const userArgs = without(args, '--scope', true);
    expect(() => validateStructuredContinuation({
      ...implicit, args: userArgs,
      displayCommand: formatNativeSafeCommandLine(action.executable, userArgs, process.platform)
    })).toThrow();
  }));

  it('keeps personal delivery explicitly nonexecuting when no user-home selector exists', async () => scoped(async (f) => {
    const dependencies: SkillsUseCaseDependencies = {
      homeDirectory: f.home, now: () => f.now, approvalStorage: f.storage(f.project), workspaceStorage: f.storage(f.project)
    };
    const result = await executeSkillsUseCase({
      subcommand: 'install', hosts: ['claude'], scope: 'user', skillId: 'assess', check: true, json: true
    }, { cwd: f.parent }, dependencies);
    expect(result.nextActions).toEqual([]);
    expect(result.nextActionGuidance).toContainEqual(expect.objectContaining({
      executable: null, reasonCode: 'user-target-not-addressable',
      context: expect.objectContaining({ userInstallTarget: f.home, targetScope: 'user' })
    }));
    expect(() => validateStructuredContinuation(result.nextActionGuidance![0])).toThrow();
  }));
});

describe('actual governance configuration continuations', () => {
  it('retains normalized inputs through status/plan/verify/resume and refuses changed configuration on the emitted approved action', async () => scoped(async (f) => {
    const root = await generated(true, 'spec-kit'), runner = new ReadyInitRunner();
    const storage = f.storage(root);
    for (const phase of ['seed-valid', 'seed-verified', 'seed-archived']) {
      const inspect = () => inspectGovernanceTransition(root, { runner, scope: 'local', storage });
      const result = await executeApplyNext({ inspection: await inspect(), reinspect: inspect, runner, storage });
      expect(result.applied, result.message).toBe(true);
      expect(result.executedPhase).toBe(phase);
    }
    const config = path.join(f.staging, 'governance inputs.json'), bytes = '{"schemaVersion":1,"phases":{}}\n';
    await writeFile(config, bytes, { mode: 0o600 });
    let plan: StructuredContinuationV1 | undefined;
    for (const subcommand of ['status', 'plan', 'verify', 'resume']) {
      const response = await invoke(f.parent, [
        'governance', subcommand, '--project', root, '--scope', 'activation',
        '--inputs', path.relative(f.parent, config), '--json'
      ], { updatePreview: storage, runner });
      expect([0, 2]).toContain(response.code);
      const report = JSON.parse(response.stdout);
      expect(report.schemaVersion).toBe(3);
      expect(report.nextActions.length).toBeGreaterThan(0);
      for (const next of report.nextActions) {
        const action = machine(next.continuation);
        expect(action).toMatchObject({
          project: root, cwd: root, scope: 'activation', configPath: config, configDigest: sha(bytes),
          compatibilityIdentity: canonicalSha256(currentActivationIdentity)
        });
        if (subcommand === 'status') plan = action;
      }
    }
    expect(plan).toBeDefined();
    const planned = await invoke(f.elsewhere, plan!.args, { updatePreview: storage, runner });
    expect(planned.code, planned.stderr || planned.stdout).toBe(0);
    const approval = machine(JSON.parse(planned.stdout).nextActions[0].continuation);
    expect(approval.requiredAuthority).toContain('exact-governance-plan');
    expect(parseArgs([...approval.args]).subcommand).toBe('approve');
    expect(() => parseArgs(without(approval.args, '--plan', true))).toThrow(/requires --plan/);
    const approved = await invoke(f.elsewhere, approval.args, { updatePreview: storage, runner });
    expect(approved.code, approved.stderr || approved.stdout).toBe(0);
    const execution = machine(JSON.parse(approved.stdout).nextActions[0].continuation);
    expect(execution.requiredAuthority).toEqual(['exact-governance-plan-execution']);
    expect(execution.configPath).toBe(config);
    const wrongScope = [...execution.args];
    wrongScope[wrongScope.indexOf('--scope') + 1] = 'repository';
    expect((await invoke(f.elsewhere, wrongScope, { updatePreview: storage, runner })).code).toBe(1);
    const wrongTarget = [...execution.args];
    wrongTarget[wrongTarget.indexOf('--project') + 1] = f.project;
    expect((await invoke(f.elsewhere, wrongTarget, { updatePreview: storage, runner })).code).toBe(1);
    await writeFile(config, `${bytes}\n`);
    await expect(assertGovernanceConfigurationBinding({
      schemaVersion: 1, reference: execution.configPath!, digest: execution.configDigest!
    })).rejects.toThrow(/changed/);
    const blocked = await invoke(f.elsewhere, execution.args, { updatePreview: storage, runner });
    expect(blocked.code).toBe(1);
    expect(blocked.stderr + blocked.stdout).toMatch(/configuration.*changed|input.*changed|bytes.*changed/i);
    expect(runner.calls.some((command) => command.executable === 'git' &&
      ['init', 'add', 'commit', 'push'].includes(command.args[0]))).toBe(false);
    expect(await readdir(f.elsewhere)).toEqual([]);
  }), 30_000);
});

describe('native installation and invocation-only upgrade actions', () => {
  async function installation() {
    const fixture = await signedFixture("machine action's $literal targets");
    const owner = { fixture, pending: 0, uncertain: false };
    native.push(owner);
    const target = fixture.provenance.target;
    const payload = fixture.manifest.targets[target];
    expect(fixture.runtimeExecution).toBe('current-host');
    expect(target).toBe(`${process.platform}-${process.arch}`);
    expect(payload.archiveFormat).toBe(process.platform === 'win32' ? 'zip' : 'tar.gz');
    const archive = await fixture.source.readBytes(payload.archiveUrl, 512 * 1024 * 1024);
    const { inspectNativeArchive } = await import('../src/adapters/distribution/native-archive.js');
    expect(inspectNativeArchive(archive, fixture.provenance, payload.archiveFormat).files.length)
      .toBe(fixture.provenance.files.length);
    const run = fixture.runner.run.bind(fixture.runner);
    fixture.runner.run = async (command, options) => {
      owner.pending++;
      try {
        const result = await run(command, { ...options, ensureProcessTreeSettled: true });
        owner.uncertain ||= result.processTreeSettled !== true;
        return result;
      } catch (error) { owner.uncertain = true; throw error; }
      finally { owner.pending--; }
    };
    return fixture;
  }
  async function withInstallation<T>(operation: (fixture: SignedFixture) => Promise<T>): Promise<T> {
    active++;
    try { return await operation(await installation()); }
    finally { active--; }
  }
  async function nativeInvoke(fixture: SignedFixture, cwd: string, args: readonly string[]) {
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    const context: CommandContext & Pick<InstallationCommandContext, 'installationDetector' | 'receiptStore' | 'installationNow'> = {
      cwd, stdout, stderr, env: fixture.env, runner: fixture.runner, receiptStore: fixture.store,
      installationDetector: new InstallationDetector({
        entrypoint: path.join(fixture.candidate, 'dist', 'cli.js'), admission: fixture.admission,
        env: fixture.env, cwd, receiptStore: fixture.store, npmAdapter: fixture.npmAdapter, ownerAdapters: []
      }),
      installationNow: fixture.reviewNow
    };
    const code = await runCommand(parseArgs([...args]), context);
    return { code, report: JSON.parse(stdout.text()), stderr: stderr.text() };
  }
  it('emits an admitted exact installation action and preserves its original cwd/targets during nonexecuting reinspection', async () => withInstallation(async (f) => {
    const planned = await nativeInvoke(f, f.project, [
      'installation', 'migrate', '--to', 'direct', '--candidate', f.candidate,
      '--destination', f.installRoot, '--launcher', f.launcher, '--check', '--json'
    ]);
    expect(planned.code, planned.stderr || JSON.stringify(planned.report)).toBe(0);
    const action = machine(planned.report.nextActions[0]);
    expect(action).toMatchObject({
      executable: path.join(f.candidate, f.provenance.entrypoints.launcher), cwd: f.project,
      scope: 'installation', targetScope: 'installation', userInstallTarget: f.installRoot,
      requiredAuthority: ['exact-installation-plan']
    });
    const elsewhere = path.join(f.root, 'other cwd');
    await mkdir(elsewhere);
    const withheld = without(action.args, '--approve-plan', true);
    const replan = await nativeInvoke(f, action.cwd, withheld);
    expect(replan.code).toBe(0);
    expect(replan.report.plan.planFingerprint).toBe(planned.report.plan.planFingerprint);
    const tampered = [...action.args];
    tampered[tampered.indexOf('--approve-plan') + 1] = 'f'.repeat(64);
    const rejected = await nativeInvoke(f, elsewhere, tampered);
    expect(rejected.code).toBe(1);
    expect(f.runner.calls.some((entry) => entry.command.args[0] === 'uninstall')).toBe(false);
    await expect(lstat(f.launcher)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(f.project, 'liftoff.manifest.json'), 'utf8')).toBe('{"schemaVersion":7,"version":"historical"}\n');
  }), 90_000);
  it('rejects contradictory installation destination metadata before replaying a real emitted action', async () => withInstallation(async (f) => {
    const planned = await nativeInvoke(f, f.project, [
      'installation', 'migrate', '--to', 'direct', '--candidate', f.candidate,
      '--destination', f.installRoot, '--launcher', f.launcher, '--check', '--json'
    ]);
    expect(planned.code).toBe(0);
    const action = machine(planned.report.nextActions[0]);
    expect(() => validateStructuredContinuation({
      ...action, userInstallTarget: path.join(f.home, 'different destination')
    })).toThrow();
    const args = [...action.args], index = args.indexOf('--destination');
    args.splice(index, 2, `--destination=${path.relative(action.cwd, f.installRoot)}`);
    const inline = { ...action, args, displayCommand: formatNativeSafeCommandLine(action.executable, args, process.platform) };
    expect(machine(inline).userInstallTarget).toBe(f.installRoot);
    expect(() => validateStructuredContinuation({ ...inline, userInstallTarget: path.join(f.home, 'different destination') })).toThrow();
  }), 90_000);
  it('does not invent an upgrade approval flag or machine action from ordinary upgrade prose', async () => scoped(async (f) => {
    const owner = vi.fn<SelfUpgradeExecutor>(async (request) => ({
      schemaVersion: 1, mode: request.mode, status: 'current', currentVersion: liftoffVersion, reasonCode: 'current'
    }));
    const result = await invoke(f.elsewhere, ['upgrade', '--json'], { selfUpgrade: owner });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ schemaVersion: 1, mode: 'apply', status: 'current' });
    expect(report.nextActions).toBeUndefined();
    expect(owner.mock.calls[0]![0]).not.toHaveProperty('approvePlan');
    expect(() => parseArgs(['upgrade', '--approve-plan', 'a'.repeat(64)])).toThrow();
  }));
});

describe('source-only native-path consistency', () => {
  it('refuses mixed native targets and renderer substitution on actual emitted adoption actions', async () => scoped(async (f) => {
    await vue(f.project);
    const report = JSON.parse((await invoke(f.parent, ['adopt', '--project', f.project, '--profile', 'vue-component', '--check', '--json'], {
      updatePreview: f.storage(f.project), updateNow: () => f.now
    })).stdout);
    const action = machine(report.nextActions[0]);
    const windows = /^[A-Za-z]:\\/u.test(action.cwd) || action.cwd.startsWith('\\\\');
    const nativePath = windows ? path.win32 : path.posix;
    for (const mutation of [
      { cwd: windows ? '/other/invocation' : 'C:\\Other\\Invocation' },
      { project: nativePath.join(nativePath.dirname(action.project!), 'different-project-target') },
      { displayCommand: 'liftoff upgrade' }, { requiredAuthority: ['approval', 'approval'] }
    ]) {
      expect(canonicalSha256({ ...action, ...mutation })).not.toBe(canonicalSha256(action));
      expect(() => validateStructuredContinuation({ ...action, ...mutation })).toThrow();
    }
  }));
});
