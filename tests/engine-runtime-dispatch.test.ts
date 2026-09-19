import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import {
  composeApplicationEngines, composeExecutionContext, getRegisteredCapabilities
} from '../src/application/engine-composition.js';
import { assessProject } from '../src/application/standards-assessment/runner.js';
import { previewProject } from '../src/application/project-generation/plan.js';
import { initializeProject } from '../src/application/initialize/use-case.js';
import { migrateProject } from '../src/application/migrate/use-case.js';
import { adoptProject } from '../src/application/project-evolution/adoption/use-case.js';
import { updateProject } from '../src/application/update/use-case.js';
import { repairProject } from '../src/application/repair/use-case.js';
import { assessGovernance } from '../src/governance-assessment/engine.js';
import { upgradeLiftoff } from '../src/application/upgrade/use-case.js';
import { executeSkillsUseCase } from '../src/application/skills/use-case.js';
import { inspectGovernanceTransition } from '../src/application/repository-governance/inspection.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { buildArtifacts } from '../src/templates.js';
import { writeArtifacts } from '../src/adapters/filesystem/project-files.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { canonicalEngines, engineIds } from '../src/domain/execution/engines.js';
import type { CommandContext } from '../src/application/context.js';
import type { CommandRunner } from '../src/process-runner.js';
import type { SelfUpgradeExecutor } from '../src/self-upgrade.js';
import { liftoffVersion } from '../src/version.js';
import { PresentationSession } from '../src/terminal.js';
import { CaptureStream } from './helpers.js';

vi.mock('../src/application/engine-composition.js', async (original) => {
  const actual = await original<typeof import('../src/application/engine-composition.js')>();
  return { ...actual, composeExecutionContext: vi.fn(actual.composeExecutionContext) };
});
vi.mock('../src/application/standards-assessment/runner.js', async (original) => {
  const actual = await original<typeof import('../src/application/standards-assessment/runner.js')>();
  return { ...actual, assessProject: vi.fn(actual.assessProject) };
});
vi.mock('../src/application/project-generation/plan.js', async (original) => {
  const actual = await original<typeof import('../src/application/project-generation/plan.js')>();
  return { ...actual, previewProject: vi.fn(actual.previewProject) };
});
vi.mock('../src/application/initialize/use-case.js', async (original) => {
  const actual = await original<typeof import('../src/application/initialize/use-case.js')>();
  return { ...actual, initializeProject: vi.fn(actual.initializeProject) };
});
vi.mock('../src/application/migrate/use-case.js', async (original) => {
  const actual = await original<typeof import('../src/application/migrate/use-case.js')>();
  return { ...actual, migrateProject: vi.fn(actual.migrateProject) };
});
vi.mock('../src/application/project-evolution/adoption/use-case.js', async (original) => {
  const actual = await original<typeof import('../src/application/project-evolution/adoption/use-case.js')>();
  return { ...actual, adoptProject: vi.fn(actual.adoptProject) };
});
vi.mock('../src/application/update/use-case.js', async (original) => {
  const actual = await original<typeof import('../src/application/update/use-case.js')>();
  return { ...actual, updateProject: vi.fn(actual.updateProject) };
});
vi.mock('../src/application/repair/use-case.js', async (original) => {
  const actual = await original<typeof import('../src/application/repair/use-case.js')>();
  return { ...actual, repairProject: vi.fn(actual.repairProject) };
});
vi.mock('../src/governance-assessment/engine.js', async (original) => {
  const actual = await original<typeof import('../src/governance-assessment/engine.js')>();
  return { ...actual, assessGovernance: vi.fn(actual.assessGovernance) };
});
vi.mock('../src/application/upgrade/use-case.js', async (original) => {
  const actual = await original<typeof import('../src/application/upgrade/use-case.js')>();
  return { ...actual, upgradeLiftoff: vi.fn(actual.upgradeLiftoff) };
});
vi.mock('../src/application/skills/use-case.js', async (original) => {
  const actual = await original<typeof import('../src/application/skills/use-case.js')>();
  return { ...actual, executeSkillsUseCase: vi.fn(actual.executeSkillsUseCase) };
});

interface OwnedRoot {
  path: string;
  device: number;
  inode: number;
  mode: number;
  birthtimeMs: number;
}
const roots: OwnedRoot[] = [];
let activeWork = 0;

afterEach(async () => {
  vi.clearAllMocks();
  const current = roots.splice(0);
  if (activeWork) throw new Error(`Retaining active runtime-dispatch fixtures: ${current.map((root) => root.path).join(', ')}`);
  for (const root of current) {
    const actual = await lstat(root.path);
    if (!actual.isDirectory() || actual.isSymbolicLink() || await realpath(root.path) !== root.path ||
        actual.dev !== root.device || actual.ino !== root.inode ||
        actual.mode !== root.mode || actual.birthtimeMs !== root.birthtimeMs) {
      throw new Error(`Runtime-dispatch fixture identity changed; preserving ${root.path}`);
    }
    await rm(root.path, { recursive: true });
  }
});

async function withFixture<T>(operation: (fixture: {
  parent: string; root: string; home: string; storage: NonNullable<CommandContext['updatePreview']>;
}) => Promise<T>): Promise<T> {
  activeWork++;
  try {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-engine-runtime-')));
    const identity = await lstat(parent);
    roots.push({ path: parent, device: identity.dev, inode: identity.ino, mode: identity.mode, birthtimeMs: identity.birthtimeMs });
    const root = path.join(parent, 'project'), home = path.join(parent, 'private home');
    await mkdir(root);
    await mkdir(home);
    return await operation({ parent, root, home, storage: { homedir: home, repositoryRoot: root, env: {} } });
  } finally { activeWork--; }
}

const noProcesses = (): CommandRunner => ({
  run: vi.fn(async () => { throw new Error('No native process was authorized by this runtime-dispatch fixture.'); })
});

async function invoke(root: string, args: string[], overrides: Partial<CommandContext> = {}) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const code = await runCommand(parseArgs(args), {
    cwd: root, stdout, stderr, runner: noProcesses(), terminal: { layout: 'plain', color: false }, ...overrides
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

async function generatedProject(root: string, governance = false, gitMarker = true) {
  const plan = buildProjectPlan({
    projectName: 'Runtime composition', projectType: 'standard', apiStack: 'node',
    cloud: 'azure', region: 'eastus', environments: ['dev'], agents: ['copilot'],
    specWorkflow: 'openspec', includeFrontend: false,
    governanceProfile: governance ? 'single-maintainer-gitflow' : 'none'
  }, { requireProjectName: true });
  await writeArtifacts(root, buildArtifacts(plan));
  for (const marker of [...plan.framework.baseMarkers, ...plan.agents.flatMap((agent) => plan.framework.agentMarkers[agent.id])]) {
    const target = path.join(root, ...marker);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'test-owned initialized framework marker\n');
  }
  if (gitMarker) await mkdir(path.join(root, '.git'));
  return loadManifest(root);
}

describe('actual six-engine runtime composition', () => {
  it('composes concrete use cases once without changing canonical capability qualification', async () => {
    const capabilities = getRegisteredCapabilities().map((value) => structuredClone(value));
    const engines = await composeApplicationEngines();
    expect(Object.keys(engines)).toEqual(engineIds);
    expect(await composeApplicationEngines()).toBe(engines);
    for (const id of engineIds) expect(engines[id].descriptor).toBe(canonicalEngines[id]);
    expect(engines['standards-assessment'].assessProject).toBe(assessProject);
    expect(engines['project-generation'].previewProject).toBe(previewProject);
    expect(engines['project-evolution'].updateProject).toBe(updateProject);
    expect(engines['repository-governance'].assessGovernance).toBe(assessGovernance);
    expect(engines.distribution.upgradeLiftoff).toBe(upgradeLiftoff);
    expect(getRegisteredCapabilities()).toEqual(capabilities);
  });

  it('keeps help, version, and capability discovery outside runtime execution', async () => {
    for (const args of [
      ['--help'], ['--version'], ['capabilities', '--json'],
      ['init', '--help'], ['governance', '--help'], ['installation', 'migrate', '--help']
    ]) {
      const result = await invoke(process.cwd(), args);
      expect(result.code, result.stderr).toBe(0);
    }
    expect(composeExecutionContext).not.toHaveBeenCalled();
    expect(assessProject).not.toHaveBeenCalled();
    expect(updateProject).not.toHaveBeenCalled();
    expect(upgradeLiftoff).not.toHaveBeenCalled();
  });

  it('dispatches a real read-only assessment through Standards and Assessment', async () => withFixture(async (f) => {
    await writeFile(path.join(f.root, 'package.json'), '{"name":"existing-vue","dependencies":{"vue":"^3.5.0"}}');
    await writeFile(path.join(f.root, 'App.vue'), '<template><div>Retained business view</div></template>\n');
    const before = await readdir(f.root);
    const result = await invoke(f.root, ['assess', '--project', f.root, '--profile', 'vue-component', '--json'], { updatePreview: f.storage });
    expect(result.code, result.stderr || result.stdout).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ schemaVersion: 1, command: 'assess', target: { projectRoot: f.root, hasManifest: false } });
    expect(assessProject).toHaveBeenCalledOnce();
    expect(report.inventory.files.map((file: { path: string }) => file.path).sort()).toEqual(['App.vue', 'package.json']);
    expect(await readdir(f.root)).toEqual(before);
    expect(await readFile(path.join(f.root, 'App.vue'), 'utf8')).toContain('Retained business view');
  }));

  it('dispatches actual artifact planning through Project Generation without creating a project', async () => withFixture(async (f) => {
    const result = await invoke(f.root, ['plan', '--project', 'Composed project', '--type', 'standard', '--api', 'go', '--cloud', 'azure']);
    expect(result.code, result.stderr).toBe(0);
    expect(previewProject).toHaveBeenCalledOnce();
    expect(result.stdout).toContain('backend/go.mod');
    expect(result.stdout).toContain('Workstation requirements');
    expect(await readdir(f.root)).toEqual([]);
  }));

  it('preserves initialization admission in the Project Generation owner', async () => withFixture(async (f) => {
    const runner: CommandRunner = { run: vi.fn(async (command) => {
      expect(command).toEqual({ executable: 'git', args: ['rev-parse', '--show-toplevel'] });
      return { command, displayCommand: '', status: 128, stdout: '',
        stderr: 'fatal: not a git repository (or any of the parent directories): .git', signal: null, timedOut: false };
    }) };
    const result = await invoke(f.root, ['init', '--project', 'invalid', '--type', 'unsupported', '--yes'], { runner });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/unsupported/i);
    expect(initializeProject).toHaveBeenCalledOnce();
    expect(runner.run).toHaveBeenCalledOnce();
    expect(await readdir(f.root)).toEqual([]);
  }));

  it('keeps fresh-target migration and in-place adoption distinct in Project Evolution', async () => withFixture(async (f) => {
    const missing = path.join(f.root, 'absent-source');
    const migration = await invoke(f.root, ['migrate']);
    expect(migration.code).toBe(1);
    expect(migrateProject).toHaveBeenCalledOnce();
    expect(vi.mocked(migrateProject).mock.calls[0]![0].source).toBeUndefined();
    const adoption = await invoke(f.root, ['adopt', '--project', missing, '--check', '--json'], { updatePreview: f.storage });
    expect(adoption.code).toBe(1);
    expect(JSON.parse(adoption.stdout).committed).toBe(false);
    expect(adoptProject).toHaveBeenCalledOnce();
    expect(vi.mocked(adoptProject).mock.calls[0]![0]).toMatchObject({ project: missing, check: true });
    expect(await readdir(f.root)).toEqual([]);
  }));

  it('dispatches the real reviewed update transaction through Project Evolution without widening approval', async () => withFixture(async (f) => {
    const manifest = await generatedProject(f.root);
    const managed = manifest.managedArtifacts.find((entry) => entry.pathParts.at(-1) !== 'liftoff.config.json')!;
    const target = path.join(f.root, ...managed.pathParts);
    const original = await readFile(target);
    await unlink(target);
    const checked = await invoke(f.root, ['update', '--check', '--project', f.root, '--json'], { updatePreview: f.storage });
    expect(checked.code, checked.stderr || checked.stdout).toBe(2);
    const review = JSON.parse(checked.stdout);
    const fingerprint = review.plans.find((plan: { mode: string }) => plan.mode === 'normal').fingerprint;
    const unapproved = await invoke(f.root, ['update', '--project', f.root, '--json'], { updatePreview: f.storage });
    expect(unapproved.code).toBe(1);
    expect(JSON.parse(unapproved.stdout)).toMatchObject({ committed: false, approval: { status: 'required' } });
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    const applied = await invoke(f.root, ['update', '--project', f.root, '--approve-plan', fingerprint, '--json'], { updatePreview: f.storage });
    expect(applied.code, applied.stderr || applied.stdout).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ schemaVersion: 3, committed: true, status: 'applied', receipt: { status: 'consumed' } });
    expect(await readFile(target)).toEqual(original);
    expect(updateProject).toHaveBeenCalledTimes(3);
    const context = vi.mocked(updateProject).mock.calls.at(-1)![1];
    expect(context.engines!['project-evolution'].updateProject).toBe(updateProject);
    expect(context.updatePreview).toBe(f.storage);
  }));

  it('dispatches actual repair capability inspection without a project or additional execution authority', async () => withFixture(async (f) => {
    const result = await invoke(f.root, ['repair', '--capabilities', '--json'], { updatePreview: f.storage });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ repairContractVersion: 1, schemas: { report: 2, journal: 2 } });
    expect(repairProject).toHaveBeenCalledOnce();
    expect(await readdir(f.root)).toEqual([]);
  }));

  it('dispatches governance assessment through Repository Governance and retains bound private storage', async () => withFixture(async (f) => {
    await generatedProject(f.root, false, false);
    const before = await readFile(path.join(f.root, 'liftoff.manifest.json'));
    const result = await invoke(f.root, ['governance', 'assess', '--project', f.root, '--json'], { updatePreview: f.storage });
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'not-applicable', projectRoot: f.root });
    expect(assessGovernance).toHaveBeenCalledOnce();
    expect(vi.mocked(assessGovernance).mock.calls[0]![1]?.storage?.homedir).toBe(f.home);
    expect(await readFile(path.join(f.root, 'liftoff.manifest.json'))).toEqual(before);
  }));

  it('supplies actual repository and Azure owners without custom phase overrides or lost storage', async () => withFixture(async (f) => {
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    const presentation = new PresentationSession({ stdout, stderr });
    const github = { storage: f.storage };
    const context = await composeExecutionContext({
      cwd: f.root, stdout, stderr, updatePreview: f.storage, adapters: { githubActivation: github }
    }, presentation);
    expect(context.storage).toBe(f.storage);
    expect(context.updatePreview).toBe(f.storage);
    expect(context.adapters?.githubActivation).toBe(github);
    expect(context.adapters?.phases).toBeUndefined();
    const providers = context.adapters?.providerEngines;
    expect(providers?.repositoryGovernance).toBe(context.engines!['repository-governance']);
    expect(providers?.azureActivation).toBe(context.engines!['azure-activation']);
    await generatedProject(f.root, true, false);
    const runner = noProcesses();
    const inspection = await inspectGovernanceTransition(f.root, { runner, scope: 'repository', storage: f.storage });
    const phase = inspection.graph.phases.find((phase) => phase.id === 'provider-ready')!;
    expect(await providers!.azureActivation.planPhase({ inspection, phase, runner, now: new Date(), adapters: context.adapters })).toBeNull();
    expect(runner.run).not.toHaveBeenCalled();
  }));

  it('dispatches owner-preserving upgrade through Distribution with invocation-only authorization', async () => withFixture(async (f) => {
    const execute = vi.fn<SelfUpgradeExecutor>(async (request) => ({
      schemaVersion: 1, mode: request.mode, status: 'current', currentVersion: liftoffVersion, reasonCode: 'current'
    }));
    const result = await invoke(f.root, ['upgrade', '--json'], { selfUpgrade: execute, updatePreview: f.storage });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'current', mode: 'apply' });
    expect(upgradeLiftoff).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ mode: 'apply', json: true }));
    expect(execute.mock.calls[0]![0]).not.toHaveProperty('approvePlan');
    expect(await readdir(f.root)).toEqual([]);
  }));

  it('routes read-only skill catalog delivery through Distribution without initializing user or project state', async () => withFixture(async (f) => {
    const result = await invoke(f.root, ['skills', 'list', '--json'], { updatePreview: f.storage, env: {} });
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, command: 'skills', outcome: 'listed', exitCode: 0 });
    expect(executeSkillsUseCase).toHaveBeenCalledOnce();
    expect(await readdir(f.root)).toEqual([]);
  }));
});
