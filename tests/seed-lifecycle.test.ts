import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand, type CommandContext } from '../src/commands.js';
import { validateGeneratedProject, writeArtifacts, writeProjectFile } from '../src/file-system.js';
import {
  archiveGeneratedSeedForPhase,
  completeGeneratedSeedLifecycle,
  generatedSeedCapabilityId,
  generatedSeedChangeName,
  selectSeedBaselineChecks,
  verifyGeneratedSeedBaselineForPhase
} from '../src/governance-activation/seed-lifecycle.js';
import { validateUserActivationState } from '../src/governance-activation/validators.js';
import { liftoffPackageName } from '../src/package-identity.js';
import { buildProjectPlan } from '../src/planner.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import { formatCommand, NodeCommandRunner } from '../src/process-runner.js';
import { buildArtifacts } from '../src/templates.js';
import type { ExternalCommand, ProjectOptions, ProjectPlan } from '../src/types.js';
import { liftoffVersion } from '../src/version.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

const cleanups: string[] = [];
let workspaceCounter = 0;

afterEach(async () => {
  delete process.env.LIFTOFF_STAGING_ROOT;
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

async function testWorkspace(prefix: string): Promise<string> {
  workspaceCounter += 1;
  const root = path.join(process.cwd(), 'tmp', `${prefix}-${process.pid}-${workspaceCounter}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  cleanups.push(root);
  return root;
}

async function writeFrameworkMarkers(root: string, plan: ProjectPlan): Promise<void> {
  for (const marker of [
    ...plan.framework.baseMarkers,
    ...plan.agents.flatMap((agent) => plan.framework.agentMarkers[agent.id])
  ]) {
    await writeProjectFile(root, marker, 'fixture marker\n');
  }
}

async function fixtureProject(
  options: ProjectOptions,
  workspacePrefix = 'liftoff-seed'
): Promise<{ root: string; plan: ProjectPlan }> {
  const parent = await testWorkspace(workspacePrefix);
  const plan = buildProjectPlan(options, { requireProjectName: true });
  const root = path.join(parent, plan.safeProjectName);
  await writeArtifacts(root, buildArtifacts(plan));
  await writeFrameworkMarkers(root, plan);
  return { root, plan };
}

async function initFixtureProject(args: string[], safeProjectName: string): Promise<string> {
  const parent = await testWorkspace('liftoff-init-parent');
  process.env.LIFTOFF_STAGING_ROOT = await testWorkspace('liftoff-init-staging');
  const result = await runCli(args, parent);
  expect(result.code, `${result.out}${result.err}`).toBe(0);
  return path.join(parent, safeProjectName);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runCli(
  args: string[],
  cwd: string,
  context: Partial<Pick<
    CommandContext,
    'configuredRegistryTargetLookup' | 'stableReleaseLookup' | 'runner'
  >> = {}
): Promise<{ code: number; out: string; err: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(args), {
    cwd,
    stdout,
    stderr,
    runner: new ReadyInitRunner(),
    ...context
  });
  return { code, out: stdout.text(), err: stderr.text() };
}

async function archiveSeedChange(root: string, changeName: string): Promise<string> {
  const archiveRoot = path.join(root, 'openspec', 'changes', 'archive');
  const archiveName = `done-${changeName}`;
  await mkdir(archiveRoot, { recursive: true });
  await rename(
    path.join(root, 'openspec', 'changes', changeName),
    path.join(archiveRoot, archiveName)
  );
  return path.join(archiveRoot, archiveName);
}

class SeedLifecycleRunner implements CommandRunner {
  readonly calls: Array<{ command: ExternalCommand; cwd?: string }> = [];

  constructor(private readonly options: {
    failCommand?: (command: ExternalCommand) => boolean;
    archive?: boolean;
    failure?: Partial<Pick<CommandResult, 'stderr' | 'stdout' | 'errorCode' | 'errorMessage' | 'timedOut' | 'status'>>;
  } = {}) {}

  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push({ command, cwd: options?.cwd });
    if (this.options.failCommand?.(command)) {
      return this.result(command, {
        status: 1,
        stderr: 'configured failure\n',
        ...this.options.failure
      });
    }
    if (command.executable === 'openspec' && command.args[0] === 'archive') {
      if (this.options.archive === false) {
        return this.result(command, { status: 1, stderr: 'archive failed\n' });
      }
      const cwd = options?.cwd;
      const changeName = command.args[1];
      if (!cwd || !changeName) {
        return this.result(command, { status: 1, stderr: 'missing archive cwd or change name\n' });
      }
      const manifest = JSON.parse(
        await readFile(path.join(cwd, 'liftoff.manifest.json'), 'utf8')
      );
      const capabilityId = generatedSeedCapabilityId(manifest.project.workload);
      const delta = await readFile(
        path.join(cwd, 'openspec', 'changes', changeName, 'specs', capabilityId, 'spec.md'),
        'utf8'
      );
      await archiveSeedChange(cwd, changeName);
      const mainSpecRoot = path.join(cwd, 'openspec', 'specs', capabilityId);
      await mkdir(mainSpecRoot, { recursive: true });
      await writeFile(
        path.join(mainSpecRoot, 'spec.md'),
        `# ${capabilityId}\n\n${delta.replace(/^## ADDED Requirements/mu, '## Requirements')}`,
        'utf8'
      );
      return this.result(command, { stdout: '{"archived":true}\n' });
    }
    return this.result(command, { stdout: `${formatCommand(command)} ok\n` });
  }

  private result(command: ExternalCommand, values: Partial<CommandResult> = {}): CommandResult {
    return {
      command,
      displayCommand: formatCommand(command),
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      ...values
    };
  }
}

class RealOpenSpecSeedRunner extends SeedLifecycleRunner {
  private readonly openspec = new NodeCommandRunner();

  override async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    if (command.executable === 'openspec') {
      this.calls.push({ command, cwd: options?.cwd });
      return this.openspec.run(command, { ...options, timeoutMs: 30_000 });
    }
    return super.run(command, options);
  }
}

async function openspecAvailable(): Promise<boolean> {
  const result = await new NodeCommandRunner().run(
    { executable: 'openspec', args: ['--version'] },
    { cwd: process.cwd(), timeoutMs: 15_000 }
  );
  return result.status === 0 && !result.timedOut && !result.errorCode;
}

describe('seed artifact lifecycle', () => {
  it('writes seed files at create but records none of them in the manifest', async () => {
    const { root } = await fixtureProject({
      projectName: 'Seed App',
      pattern: 'prompt',
      cloud: 'azure',
      region: 'eastus',
      environments: ['dev'],
      specWorkflow: 'openspec',
      includeFrontend: false
    });
    const manifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
    const changeName = generatedSeedChangeName(manifest);
    const capability = generatedSeedCapabilityId(manifest.project.workload);

    await access(path.join(root, 'openspec', 'changes', changeName, 'proposal.md'));
    await access(path.join(root, 'openspec', 'changes', changeName, 'tasks.md'));
    await access(path.join(root, 'openspec', 'changes', changeName, 'specs', capability, 'spec.md'));

    const seedEntries = [...manifest.managedArtifacts, ...manifest.projectArtifacts].filter(
      (artifact: { logicalName: string; pathParts: string[] }) =>
        artifact.logicalName.startsWith('openspec-seed') || artifact.pathParts.includes(changeName)
    );
    expect(seedEntries).toEqual([]);
  });

  it('generates strict-valid complete bootstrap seeds for supported workloads', async () => {
    const cases: Array<{ args: string[]; safeProjectName: string }> = [
      {
        args: ['init', 'python-api-seed', '--no-genai', '--api', 'python', '--cloud', 'azure', '--region', 'eastus', '--spec', 'openspec', '--no-frontend', '--yes'],
        safeProjectName: 'python-api-seed'
      },
      {
        args: ['init', 'node-api-seed', '--no-genai', '--api', 'node', '--cloud', 'azure', '--region', 'eastus', '--spec', 'openspec', '--frontend', '--yes'],
        safeProjectName: 'node-api-seed'
      },
      {
        args: ['init', 'go-api-seed', '--no-genai', '--api', 'go', '--cloud', 'azure', '--region', 'eastus', '--spec', 'openspec', '--no-frontend', '--yes'],
        safeProjectName: 'go-api-seed'
      },
      {
        args: ['init', 'rag-worker-ui-seed', '--pattern', 'rag', '--cloud', 'azure', '--region', 'eastus', '--spec', 'openspec', '--frontend', '--yes'],
        safeProjectName: 'rag-worker-ui-seed'
      },
      {
        args: ['init', 'prompt-workerless-seed', '--pattern', 'prompt', '--cloud', 'azure', '--region', 'eastus', '--spec', 'openspec', '--no-frontend', '--yes'],
        safeProjectName: 'prompt-workerless-seed'
      },
      {
        args: ['init', 'power-apps-seed', '--type', 'power-apps-code-app', '--spec', 'openspec', '--yes'],
        safeProjectName: 'power-apps-seed'
      }
    ];
    const canRunOpenSpec = await openspecAvailable();

    for (const { args, safeProjectName } of cases) {
      const root = await initFixtureProject(args, safeProjectName);
      const manifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
      const changeName = generatedSeedChangeName(manifest);
      const capability = generatedSeedCapabilityId(manifest.project.workload);
      const changeRoot = path.join(root, 'openspec', 'changes', changeName);
      const proposal = await readFile(path.join(changeRoot, 'proposal.md'), 'utf8');
      const design = await readFile(path.join(changeRoot, 'design.md'), 'utf8');
      const tasks = await readFile(path.join(changeRoot, 'tasks.md'), 'utf8');
      const spec = await readFile(path.join(changeRoot, 'specs', capability, 'spec.md'), 'utf8');

      expect(proposal).toContain(`\`${capability}\``);
      expect(design).toMatch(/domain-specific product behavior/i);
      expect(tasks).toContain('deferred to follow-up OpenSpec changes');
      expect(tasks).not.toContain('replace placeholders with domain-specific requirements');
      expect(tasks).not.toMatch(/docker compose up|tofu plan|tofu apply/i);
      expect(spec).toContain('## ADDED Requirements');
      expect(spec).toMatch(/^## Purpose\n\n.{50,}\n\n## ADDED Requirements/m);
      expect(spec).toContain('Domain-specific');

      if (canRunOpenSpec) {
        const result = await new NodeCommandRunner().run(
          { executable: 'openspec', args: ['validate', changeName, '--strict'] },
          { cwd: root, timeoutMs: 30_000 }
        );
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
        expect(result.timedOut).toBe(false);
        expect(result.errorCode).toBeUndefined();
      }
    }
  });

  it('generates Spec Kit setup integrations only for selected agents and stops at the local seed gate', async () => {
    const cases: Array<{
      args: string[];
      safeProjectName: string;
      selected: readonly ('copilot' | 'claude')[];
    }> = [
      {
        args: ['init', 'spec-kit-node-api', '--no-genai', '--api', 'node', '--cloud', 'azure', '--region', 'eastus', '--spec', 'spec-kit', '--agents', 'copilot', '--no-frontend', '--yes'],
        safeProjectName: 'spec-kit-node-api',
        selected: ['copilot']
      },
      {
        args: ['init', 'spec-kit-generic-ui', '--pattern', 'generic', '--cloud', 'azure', '--region', 'eastus', '--spec', 'spec-kit', '--agents', 'copilot,claude', '--default-agent', 'copilot', '--frontend', '--yes'],
        safeProjectName: 'spec-kit-generic-ui',
        selected: ['copilot', 'claude']
      },
      {
        args: ['init', 'spec-kit-worker', '--pattern', 'workflow', '--cloud', 'azure', '--region', 'eastus', '--spec', 'spec-kit', '--agents', 'claude', '--no-frontend', '--yes'],
        safeProjectName: 'spec-kit-worker',
        selected: ['claude']
      },
      {
        args: ['init', 'spec-kit-power-apps', '--type', 'power-apps-code-app', '--spec', 'spec-kit', '--agents', 'copilot', '--yes'],
        safeProjectName: 'spec-kit-power-apps',
        selected: ['copilot']
      }
    ];

    for (const { args, safeProjectName, selected } of cases) {
      const root = await initFixtureProject(args, safeProjectName);
      const manifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
      const status = await runCli(['governance', 'status', '--json'], root);
      const body = JSON.parse(status.out);

      expect(manifest.project.specWorkflow).toBe('spec-kit');
      expect(await fileExists(path.join(root, 'openspec', 'changes', generatedSeedChangeName(manifest)))).toBe(false);
      expect(await fileExists(path.join(root, '.github', 'prompts', 'liftoff-setup.prompt.md')))
        .toBe(selected.includes('copilot'));
      expect(await fileExists(path.join(root, '.claude', 'commands', 'liftoff-setup.md')))
        .toBe(selected.includes('claude'));
      expect(status.code, `${status.out}${status.err}`).toBe(0);
      expect(body.schemaVersion).toBe(1);
      expect(body.nextReadyPhase).toBe('seed-valid');
      expect(body.activeSourceOfTruth.createPlan.status).toBe('blocked');
      expect(JSON.stringify(body)).not.toMatch(/setup[-_]?skillVersion|gh repo|az deployment|tofu apply/i);
    }
  });

  it('generated setup integration executes a ready approval-free phase and advances state', async () => {
    const { root } = await fixtureProject({
      projectName: 'Executable Setup Contract',
      projectType: 'standard',
      apiStack: 'node',
      cloud: 'azure',
      specWorkflow: 'openspec',
      agents: ['copilot', 'claude'],
      includeFrontend: false
    });
    for (const skillPath of [
      path.join(root, '.github', 'prompts', 'liftoff-setup.prompt.md'),
      path.join(root, '.claude', 'commands', 'liftoff-setup.md')
    ]) {
      const skill = await readFile(skillPath, 'utf8');
      expect(skill).toContain('liftoff governance apply-next --json');
      expect(skill).toContain('liftoff governance apply-next --json --execute');
      expect(skill).toContain('`selectedPhase`');
      expect(skill).toContain('`executedPhase`');
      expect(skill).toContain('not post-transition readiness');
      expect(skill).toContain('do not repeatedly retry an unchanged failure');
      expect(skill).toMatch(
        /Use `liftoff governance apply-next --json` only to preview[\s\S]+approval status is `not-required` or\s+`reused`[\s\S]+run\s+`liftoff governance apply-next --json --execute`/
      );
    }

    const preview = await runCli(['governance', 'apply-next', '--json'], root);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.out)).toMatchObject({
      applied: false,
      authorized: true,
      reason: 'execute-required',
      selectedPhase: 'seed-valid',
      nextReadyPhase: 'seed-valid',
      noWrites: true
    });

    const applied = await runCli(
      ['governance', 'apply-next', '--json', '--execute'],
      root
    );
    expect(applied.code, `${applied.out}${applied.err}`).toBe(0);
    expect(JSON.parse(applied.out)).toMatchObject({
      applied: true,
      reason: 'phase-executed',
      selectedPhase: 'seed-valid',
      executedPhase: 'seed-valid',
      nextReadyPhase: 'seed-valid',
      evidence: { result: 'verified' }
    });
    const state = JSON.parse(
      await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8')
    );
    expect(state.phases['seed-valid'].state).toBe('verified');
    expect(await readdir(path.join(root, 'governance', 'evidence')))
      .toContainEqual(expect.stringMatching(/^seed-valid-.*\.json$/));

    const status = await runCli(['governance', 'status', '--json'], root);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out).nextReadyPhase).toBe('seed-verified');

    const verify = await runCli(['governance', 'verify', '--json'], root);
    expect(verify.code).toBe(0);
    expect(JSON.parse(verify.out)).toMatchObject({
      ok: true,
      verificationStatus: 'consistent',
      setupStatus: 'in-progress',
      complete: false,
      stateSource: 'user'
    });
  });

  it('selects literal local baseline commands and records absent components inapplicable', async () => {
    const { root: apiRoot } = await fixtureProject({
      projectName: 'API Only',
      projectType: 'standard',
      apiStack: 'python',
      cloud: 'azure',
      includeFrontend: false,
      specWorkflow: 'openspec'
    });
    const apiManifest = JSON.parse(await readFile(path.join(apiRoot, 'liftoff.manifest.json'), 'utf8'));
    const apiChecks = selectSeedBaselineChecks(apiManifest);

    expect(apiChecks.find((check) => check.id === 'frontend-build')?.applicability)
      .toMatchObject({ applicable: false, reason: 'no generated frontend is present' });
    expect(apiChecks.find((check) => check.id === 'docker-compose-config')?.applicability)
      .toMatchObject({ applicable: true, command: { executable: 'docker', args: ['compose', 'config', '-q'] } });
    expect(apiChecks.find((check) => check.id === 'tofu-init')?.applicability)
      .toMatchObject({ applicable: true, command: { executable: 'tofu', args: ['init', '-backend=false'] } });

    const { root: powerRoot } = await fixtureProject({
      projectName: 'Power Only',
      projectType: 'power-apps-code-app',
      specWorkflow: 'openspec'
    });
    const powerManifest = JSON.parse(await readFile(path.join(powerRoot, 'liftoff.manifest.json'), 'utf8'));
    const powerChecks = selectSeedBaselineChecks(powerManifest);
    const inapplicable = powerChecks.filter((check) => !check.applicability.applicable);
    expect(inapplicable.map((check) => check.id)).toEqual([
      'backend-tests',
      'worker-tests',
      'docker-compose-config',
      'tofu-fmt',
      'tofu-init',
      'tofu-validate'
    ]);
    for (const check of powerChecks) {
      if (check.applicability.applicable) {
        expect(['bash', 'sh', 'cmd', 'powershell', 'true', 'echo']).not.toContain(check.applicability.command.executable);
        expect(check.applicability.command.args.join(' ')).not.toMatch(/&&|\|\||placeholder|success/i);
      }
    }
    for (const manifest of [apiManifest, powerManifest]) {
      const changeName = generatedSeedChangeName(manifest);
      const active = selectSeedBaselineChecks(manifest, changeName, 'active');
      const archived = selectSeedBaselineChecks(manifest, changeName, 'archived');
      expect(archived.filter((check) => check.id !== 'openspec-strict'))
        .toEqual(active.filter((check) => check.id !== 'openspec-strict'));
      expect(active.find((check) => check.id === 'openspec-strict')?.applicability)
        .toMatchObject({ command: { executable: 'openspec', args: ['validate', changeName, '--strict'] } });
      expect(archived.find((check) => check.id === 'openspec-strict')?.applicability)
        .toMatchObject({ command: { executable: 'openspec', args: ['validate', '--all', '--strict'] } });
    }
  });

  it('fails before archive and leaves the generated seed active when a check fails', async () => {
    const { root } = await fixtureProject({
      projectName: 'Failure Seed',
      pattern: 'prompt',
      cloud: 'azure',
      specWorkflow: 'openspec'
    });
    const runner = new SeedLifecycleRunner({
      failCommand: (command) => command.executable === 'uv'
    });
    const result = await completeGeneratedSeedLifecycle(root, runner);
    const manifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
    const changeName = generatedSeedChangeName(manifest);

    expect(result.status).toBe('blocked');
    expect(runner.calls.some((call) => call.command.executable === 'openspec' && call.command.args[0] === 'archive')).toBe(false);
    await access(path.join(root, 'openspec', 'changes', changeName));
    const tasks = await readFile(path.join(root, 'openspec', 'changes', changeName, 'tasks.md'), 'utf8');
    expect(tasks).toContain('- [ ] 1.1');
    expect(tasks).toContain('- [ ] 2.2');
  });

  it('checks deterministic seed tasks, uses archive for spec sync, and archives after success', async () => {
    const { root } = await fixtureProject({
      projectName: 'Archive Seed',
      projectType: 'power-apps-code-app',
      specWorkflow: 'openspec'
    });
    const runner = new SeedLifecycleRunner();
    const result = await completeGeneratedSeedLifecycle(root, runner);
    const manifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
    const changeName = generatedSeedChangeName(manifest);
    const archivedRoot = path.join(root, 'openspec', 'changes', 'archive', `done-${changeName}`);
    const archivedTasks = await readFile(path.join(archivedRoot, 'tasks.md'), 'utf8');

    expect(result.status).toBe('archived');
    expect(result.status === 'archived' ? result.archiveSyncBehavior : '').toContain('archive updates main specs');
    await expect(access(path.join(root, 'openspec', 'changes', changeName))).rejects.toThrow();
    expect(archivedTasks).not.toContain('- [ ]');
    expect(runner.calls.at(-2)?.command).toEqual({
      executable: 'openspec',
      args: ['archive', changeName, '--yes', '--json']
    });
    expect(runner.calls.at(-1)?.command).toEqual({
      executable: 'openspec',
      args: ['validate', '--all', '--strict']
    });
  });

  it('archives a generated capability with a concrete main-spec Purpose and strict-valid spec set', async () => {
    if (!(await openspecAvailable())) {
      return;
    }
    const { root } = await fixtureProject({
      projectName: 'Purpose Archive Seed',
      projectType: 'standard',
      apiStack: 'go',
      cloud: 'azure',
      specWorkflow: 'openspec',
      includeFrontend: false
    });
    const manifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
    const changeName = generatedSeedChangeName(manifest);
    const capability = generatedSeedCapabilityId(manifest.project.workload);

    const result = await archiveGeneratedSeedForPhase(root, new NodeCommandRunner());

    expect(result.status).toBe('archived');
    const mainSpec = await readFile(
      path.join(root, 'openspec', 'specs', capability, 'spec.md'),
      'utf8'
    );
    const purpose = mainSpec.match(
      /## Purpose\r?\n(?:\r?\n)?([^\r\n]+)\r?\n(?:\r?\n)?## Requirements/
    );
    expect(purpose).not.toBeNull();
    expect(purpose![1]!.length).toBeGreaterThan(50);
    expect(mainSpec).not.toContain('TBD - created by archiving change');
    const strict = await new NodeCommandRunner().run(
      { executable: 'openspec', args: ['validate', '--all', '--strict'] },
      { cwd: root, timeoutMs: 30_000 }
    );
    expect(strict.status, `${strict.stdout}${strict.stderr}`).toBe(0);
    expect(await fileExists(path.join(root, 'openspec', 'changes', changeName))).toBe(false);
  });

  it('activates an externally archived seed through the generated skill without rearchiving', async ({ skip }) => {
    if (!(await openspecAvailable())) {
      skip();
      return;
    }
    const { root } = await fixtureProject({
      projectName: 'Prearchived Go Baseline',
      projectType: 'standard',
      apiStack: 'go',
      cloud: 'azure',
      specWorkflow: 'openspec',
      agents: ['copilot', 'claude'],
      includeFrontend: true
    }, 'liftoff archived seed with spaces');
    const manifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
    const changeName = generatedSeedChangeName(manifest);
    const runner = new RealOpenSpecSeedRunner();
    const archived = await runner.run(
      { executable: 'openspec', args: ['archive', changeName, '--yes', '--json'] },
      { cwd: root }
    );
    expect(archived.status, `${archived.stdout}${archived.stderr}`).toBe(0);
    const archiveRoot = path.join(root, 'openspec', 'changes', 'archive');
    const archiveNames = await readdir(archiveRoot);
    const archiveFiles = [
      ['.openspec.yaml'], ['proposal.md'], ['design.md'], ['tasks.md'],
      ['specs', generatedSeedCapabilityId(manifest.project.workload), 'spec.md']
    ];
    const archiveContents = await Promise.all(archiveFiles.map((parts) =>
      readFile(path.join(archiveRoot, archiveNames[0]!, ...parts), 'utf8')
    ));
    expect(await fileExists(path.join(root, 'governance', 'activation-state.json'))).toBe(false);
    for (const parts of [
      ['.github', 'prompts', 'liftoff-setup.prompt.md'],
      ['.claude', 'commands', 'liftoff-setup.md']
    ]) {
      expect(await readFile(path.join(root, ...parts), 'utf8'))
        .toContain('`liftoff governance apply-next --json --execute`');
    }

    const resumed = await runCli(['governance', 'resume', '--json'], root, { runner });
    expect(JSON.parse(resumed.out)).toMatchObject({
      stateSource: 'not-started',
      nextReadyPhase: 'seed-valid',
      noWrites: true
    });
    for (const [phase, next] of [
      ['seed-valid', 'seed-verified'],
      ['seed-verified', 'seed-archived'],
      ['seed-archived', null]
    ] as const) {
      const preview = await runCli(['governance', 'apply-next', '--json'], root, { runner });
      expect(preview.code, preview.out).toBe(0);
      expect(JSON.parse(preview.out)).toMatchObject({
        applied: false,
        authorized: true,
        noWrites: true,
        nextReadyPhase: phase,
        selectedPhase: phase
      });
      const applied = await runCli(
        ['governance', 'apply-next', '--json', '--execute'], root, { runner }
      );
      expect(applied.code, `${applied.out}${applied.err}`).toBe(0);
      expect(JSON.parse(applied.out)).toMatchObject({
        applied: true,
        selectedPhase: phase,
        executedPhase: phase,
        evidence: { result: 'verified' }
      });
      const verified = await runCli(['governance', 'verify', '--json'], root, { runner });
      expect(verified.code, verified.out).toBe(0);
      expect(JSON.parse(verified.out)).toMatchObject({
        consistent: true,
        complete: false,
        nextReadyPhase: next
      });
    }

    const status = await runCli(['governance', 'status', '--json'], root, { runner });
    expect(JSON.parse(status.out).phases.find((phase: { id: string }) => phase.id === 'committed'))
      .toMatchObject({ state: 'blocked', approval: { status: 'approval-required' } });
    expect(runner.calls.filter(({ command }) => command.args[0] === 'archive')).toHaveLength(1);
    expect(runner.calls.filter(({ command }) => command.executable === 'openspec' && command.args[0] === 'validate')
      .map(({ command }) => command.args)).toEqual([
      ['validate', '--all', '--strict'],
      ['validate', '--all', '--strict']
    ]);
    for (const check of selectSeedBaselineChecks(manifest).filter((check) => check.id !== 'openspec-strict')) {
      if (check.applicability.applicable) {
        expect(runner.calls).toContainEqual({
          command: check.applicability.command,
          cwd: path.join(root, ...check.applicability.cwdPathParts)
        });
      }
    }
    expect(runner.calls.some(({ command }) => ['git', 'gh', 'az'].includes(command.executable))).toBe(false);
    expect(await readdir(archiveRoot)).toEqual(archiveNames);
    expect(await Promise.all(archiveFiles.map((parts) =>
      readFile(path.join(archiveRoot, archiveNames[0]!, ...parts), 'utf8')
    ))).toEqual(archiveContents);
    expect(await fileExists(path.join(root, 'openspec', 'changes', changeName))).toBe(false);
  }, 60_000);

  it.for(['fresh', 'seed-valid-completed'] as const)(
    'completes an active bootstrap without repeating completed seed validation (%s)',
    async (entryPoint, { skip }) => {
      if (!(await openspecAvailable())) {
        skip();
        return;
      }
      const { root } = await fixtureProject({
        projectName: `Active Seed ${entryPoint}`,
        projectType: 'standard',
        apiStack: 'go',
        cloud: 'azure',
        specWorkflow: 'openspec',
        includeFrontend: false
      });
      const runner = new RealOpenSpecSeedRunner();
      const manifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
      const changeName = generatedSeedChangeName(manifest);
      const statePath = path.join(root, 'governance', 'activation-state.json');
      const evidenceRoot = path.join(root, 'governance', 'evidence');
      let existingSeedPhase;
      let existingEvidence: string | undefined;
      if (entryPoint === 'seed-valid-completed') {
        const completed = await runCli(['governance', 'apply-next', '--json', '--execute'], root, { runner });
        expect(completed.code, completed.out).toBe(0);
        const state = validateUserActivationState(JSON.parse(await readFile(statePath, 'utf8')));
        existingSeedPhase = state.phases['seed-valid'];
        existingEvidence = await readFile(path.join(evidenceRoot, `${existingSeedPhase.evidence[0]!.evidenceId}.json`), 'utf8');
      }
      const resume = await runCli(['governance', 'resume', '--json'], root, { runner });
      expect(resume.code, resume.out).toBe(0);
      expect(JSON.parse(resume.out)).toMatchObject({
        stateSource: entryPoint === 'fresh' ? 'not-started' : 'user',
        nextReadyPhase: entryPoint === 'fresh' ? 'seed-valid' : 'seed-verified',
        noWrites: true
      });
      const initialVerify = await runCli(['governance', 'verify', '--json'], root, { runner });
      expect(initialVerify.code, initialVerify.out).toBe(0);
      expect(JSON.parse(initialVerify.out)).toMatchObject({ consistent: true, complete: false });
      const remaining = entryPoint === 'fresh'
        ? ['seed-valid', 'seed-verified', 'seed-archived']
        : ['seed-verified', 'seed-archived'];
      for (const phase of remaining) {
        const preview = await runCli(['governance', 'apply-next', '--json'], root, { runner });
        expect(preview.code, preview.out).toBe(0);
        expect(JSON.parse(preview.out)).toMatchObject({ selectedPhase: phase, noWrites: true });
        const applied = await runCli(['governance', 'apply-next', '--json', '--execute'], root, { runner });
        expect(applied.code, applied.out).toBe(0);
        expect(JSON.parse(applied.out)).toMatchObject({ executedPhase: phase, applied: true });
        const verify = await runCli(['governance', 'verify', '--json'], root, { runner });
        expect(verify.code, verify.out).toBe(0);
        expect(JSON.parse(verify.out)).toMatchObject({ consistent: true, complete: false });
      }
      const final = await runCli(['governance', 'status', '--json'], root, { runner });
      expect(JSON.parse(final.out).phases.find((phase: { id: string }) => phase.id === 'committed'))
        .toMatchObject({ state: 'blocked', approval: { status: 'approval-required' } });
      expect(JSON.parse(final.out).nextReadyPhase).toBeNull();
      const finalState = validateUserActivationState(JSON.parse(await readFile(statePath, 'utf8')));
      if (existingSeedPhase) {
        expect(finalState.phases['seed-valid']).toEqual(existingSeedPhase);
        expect(await readFile(path.join(evidenceRoot, `${existingSeedPhase.evidence[0]!.evidenceId}.json`), 'utf8'))
          .toBe(existingEvidence);
      }
      expect((await readdir(evidenceRoot)).filter((name) => name.startsWith('seed-valid-'))).toHaveLength(1);
      expect(runner.calls.filter(({ command }) => command.executable === 'openspec').map(({ command }) => command.args))
        .toEqual([
          ['validate', changeName, '--strict'],
          ['validate', changeName, '--strict'],
          ['archive', changeName, '--yes', '--json'],
          ['validate', '--all', '--strict']
        ]);
      expect(runner.calls.some(({ command }) => ['git', 'gh', 'az'].includes(command.executable))).toBe(false);
    },
    60_000
  );

  it.each(['missing-artifact', 'recorded-archive', 'overlapping-seed'] as const)(
    'does not hide a genuine active-seed inconsistency (%s)',
    async (fault) => {
      const { root } = await fixtureProject({
        projectName: 'Active Seed Integrity',
        projectType: 'power-apps-code-app',
        specWorkflow: 'openspec'
      });
      expect((await runCli(['governance', 'apply-next', '--json', '--execute'], root)).code).toBe(0);
      if (fault === 'missing-artifact') {
        await rm(path.join(root, 'openspec', 'changes', 'bootstrap-active-seed-integrity', 'design.md'));
      } else if (fault === 'overlapping-seed') {
        await mkdir(path.join(root, 'openspec', 'changes', 'bootstrap-unexpected'));
      } else {
        const statePath = path.join(root, 'governance', 'activation-state.json');
        const state = validateUserActivationState(JSON.parse(await readFile(statePath, 'utf8')));
        state.phases['seed-archived'].state = 'verified';
        await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      }
      const result = await runCli(['governance', 'verify', '--json'], root);
      expect(result.code, result.out).toBe(1);
      expect(JSON.parse(result.out)).toMatchObject({ consistent: false, complete: false });
      expect(JSON.parse(result.out).checks.find((check: { id: string }) => check.id === 'active-source-of-truth'))
        .toMatchObject({ status: 'failed' });
    }
  );

  it.each(['local-check', 'legacy-blocker'] as const)(
    'retries an archived baseline without changing state during reads (%s)',
    async (failureKind) => {
      const { root } = await fixtureProject({
        projectName: `Archived Retry ${failureKind}`,
        projectType: 'standard',
        apiStack: 'go',
        cloud: 'azure',
        specWorkflow: 'openspec',
        includeFrontend: false
      });
      const manifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
      const archived = await archiveGeneratedSeedForPhase(root, new SeedLifecycleRunner());
      expect(archived.status).toBe('archived');
      const first = await runCli(['governance', 'apply-next', '--json', '--execute'], root);
      expect(first.code, first.out).toBe(0);
      const statePath = path.join(root, 'governance', 'activation-state.json');
      const evidenceRoot = path.join(root, 'governance', 'evidence');
      const evidenceBefore = await readdir(evidenceRoot);

      if (failureKind === 'legacy-blocker') {
        const state = validateUserActivationState(JSON.parse(await readFile(statePath, 'utf8')));
        state.phases['seed-verified'] = {
          ...state.phases['seed-verified'],
          state: 'blocked',
          blockers: [
            `Run strict OpenSpec validation failed: openspec validate ${generatedSeedChangeName(manifest)} --strict (exit status 1)`
          ]
        };
        await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      } else {
        const failed = await runCli(
          ['governance', 'apply-next', '--json', '--execute'], root,
          { runner: new SeedLifecycleRunner({ failCommand: (command) => command.executable === 'go' }) }
        );
        expect(failed.code).toBe(1);
        expect(JSON.parse(failed.out)).toMatchObject({
          applied: false,
          executedPhase: null,
          selectedPhase: 'seed-verified',
          evidence: null
        });
      }
      const failureState = await readFile(statePath, 'utf8');
      const before = validateUserActivationState(JSON.parse(failureState));
      expect(before.phases['seed-verified']).toMatchObject({ state: 'blocked', evidence: [] });
      const plansBefore = await readdir(path.join(root, 'governance', 'plans'));
      const readsRunner = new SeedLifecycleRunner();
      for (const command of ['status', 'plan', 'resume', 'verify', 'apply-next']) {
        const read = await runCli(['governance', command, '--json'], root, { runner: readsRunner });
        expect(read.code, `${command}: ${read.out}`).toBe(0);
        if (command === 'resume') {
          expect(JSON.parse(read.out)).toMatchObject({
            nextReadyPhase: 'seed-verified',
            noWrites: true
          });
          expect(JSON.parse(read.out).phases.find((phase: { id: string }) => phase.id === 'seed-verified'))
            .toMatchObject({
              state: 'ready',
              storedState: 'blocked',
              storedBlockers: before.phases['seed-verified'].blockers,
              retryable: true
            });
        }
      }
      expect(readsRunner.calls).toEqual([]);
      expect(await readFile(statePath, 'utf8')).toBe(failureState);
      expect(await readdir(evidenceRoot)).toEqual(evidenceBefore);
      expect(await readdir(path.join(root, 'governance', 'plans'))).toEqual(plansBefore);

      const stillFailing = await runCli(
        ['governance', 'apply-next', '--json', '--execute'], root,
        { runner: new SeedLifecycleRunner({ failCommand: (command) => command.executable === 'go' }) }
      );
      expect(stillFailing.code).toBe(1);
      expect(JSON.parse(stillFailing.out).evidence).toBeNull();
      expect(await readdir(evidenceRoot)).toEqual(evidenceBefore);
      const fixedRunner = new SeedLifecycleRunner();
      const recovered = await runCli(
        ['governance', 'apply-next', '--json', '--execute'], root, { runner: fixedRunner }
      );
      expect(recovered.code, recovered.out).toBe(0);
      expect(JSON.parse(recovered.out)).toMatchObject({
        applied: true,
        executedPhase: 'seed-verified',
        evidence: { result: 'verified' }
      });
      expect(validateUserActivationState(JSON.parse(await readFile(statePath, 'utf8'))).phases['seed-verified'])
        .toMatchObject({ state: 'verified', blockers: [] });
      for (const check of selectSeedBaselineChecks(manifest, undefined, 'archived')) {
        if (check.applicability.applicable) {
          expect(fixedRunner.calls).toContainEqual({
            command: check.applicability.command,
            cwd: path.join(root, ...check.applicability.cwdPathParts)
          });
        }
      }
      expect(fixedRunner.calls.some(({ command }) => ['git', 'gh', 'az'].includes(command.executable))).toBe(false);
    }
  );

  it('repairs a strict-invalid archived spec and resumes the baseline through real OpenSpec', async ({ skip }) => {
    if (!(await openspecAvailable())) {
      skip();
      return;
    }
    const { root } = await fixtureProject({
      projectName: 'Archived Spec Repair',
      projectType: 'standard',
      apiStack: 'go',
      cloud: 'azure',
      specWorkflow: 'openspec',
      includeFrontend: false
    });
    const runner = new RealOpenSpecSeedRunner();
    expect((await archiveGeneratedSeedForPhase(root, runner)).status).toBe('archived');
    expect((await runCli(['governance', 'apply-next', '--json', '--execute'], root, { runner })).code).toBe(0);
    const specPath = path.join(root, 'openspec', 'specs', 'go-huma-application-baseline', 'spec.md');
    const validSpec = await readFile(specPath, 'utf8');
    await writeFile(specPath, validSpec.replaceAll('SHALL', 'should'), 'utf8');

    const failed = await runCli(['governance', 'apply-next', '--json', '--execute'], root, { runner });
    expect(failed.code, failed.out).toBe(1);
    expect(JSON.parse(failed.out)).toMatchObject({
      applied: false,
      selectedPhase: 'seed-verified',
      executedPhase: null,
      evidence: null,
      message: expect.stringContaining('openspec validate --all --strict')
    });
    expect(JSON.parse(failed.out).message).toContain('go-huma-application-baseline');
    await writeFile(specPath, validSpec, 'utf8');
    const resume = await runCli(['governance', 'resume', '--json'], root, { runner });
    expect(JSON.parse(resume.out).nextReadyPhase).toBe('seed-verified');
    for (const phase of ['seed-verified', 'seed-archived']) {
      const applied = await runCli(['governance', 'apply-next', '--json', '--execute'], root, { runner });
      expect(applied.code, applied.out).toBe(0);
      expect(JSON.parse(applied.out).executedPhase).toBe(phase);
      expect((await runCli(['governance', 'verify', '--json'], root, { runner })).code).toBe(0);
    }
    expect(runner.calls.filter(({ command }) => command.args[0] === 'archive')).toHaveLength(1);
  }, 60_000);

  it.each(['missing', 'fallback-purpose'] as const)(
    'does not verify an archived baseline with an invalid main capability (%s)',
    async (fault) => {
      const { root } = await fixtureProject({
        projectName: 'Archived Integrity Guard',
        projectType: 'power-apps-code-app',
        specWorkflow: 'openspec'
      });
      expect((await archiveGeneratedSeedForPhase(root, new SeedLifecycleRunner())).status).toBe('archived');
      const specPath = path.join(root, 'openspec', 'specs', 'power-apps-code-app-baseline', 'spec.md');
      if (fault === 'missing') {
        await rm(specPath);
      } else {
        await writeFile(specPath, '## Purpose\n\nTBD - created by archiving change bootstrap-archived-integrity-guard.\n\n## Requirements\n', 'utf8');
      }
      const runner = new SeedLifecycleRunner();
      const result = await verifyGeneratedSeedBaselineForPhase(root, runner);
      expect(result).toMatchObject({ status: 'blocked', checks: [] });
      expect(runner.calls).toEqual([]);
    }
  );

  it.each([
    { name: 'stderr', failure: { stderr: '\u001b[31mRequirement is missing SHALL\u001b[0m\u0000' }, expected: 'Requirement is missing SHALL' },
    { name: 'stdout', failure: { stderr: '', stdout: 'Unknown item: bootstrap-archived' }, expected: 'Unknown item: bootstrap-archived' },
    { name: 'truncation', failure: { stderr: 'Long diagnostic '.repeat(300) }, expected: '[truncated]' },
    { name: 'credential', failure: { stderr: `Output ${'github_pat_'}${'x'.repeat(40)}` }, expected: 'diagnostic withheld' },
    { name: 'credential beyond limit', failure: { stderr: `${'x'.repeat(3000)} AccountKey=sensitive-value;` }, expected: 'diagnostic withheld' },
    { name: 'credential in stdout', failure: { stderr: 'Validation failed', stdout: `ghp_${'y'.repeat(40)}` }, expected: 'diagnostic withheld' }
  ])('bounds and sanitizes OpenSpec failure diagnostics ($name)', async ({ failure, expected }) => {
    const { root } = await fixtureProject({
      projectName: 'Safe Diagnostics',
      projectType: 'power-apps-code-app',
      specWorkflow: 'openspec'
    });
    const failed = await runCli(['governance', 'apply-next', '--json', '--execute'], root, {
      runner: new SeedLifecycleRunner({
        failCommand: (command) => command.executable === 'openspec',
        failure
      })
    });
    expect(failed.code).toBe(1);
    const body = JSON.parse(failed.out);
    expect(body).toMatchObject({ applied: false, executedPhase: null, evidence: null });
    expect(body.message).toContain(expected);
    expect(body.message.length).toBeLessThan(2400);
    const state = await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8');
    for (const content of [failed.out, failed.err, state]) {
      expect(content).not.toMatch(/github_pat_|ghp_|AccountKey=|sensitive-value/u);
    }
    expect(body.message).not.toMatch(/[\u0000\u001b]/u);
  });

  it('blocks an archived seed until the synchronized main specs pass strict validation', async () => {
    const { root } = await fixtureProject({
      projectName: 'Post Archive Failure',
      projectType: 'power-apps-code-app',
      specWorkflow: 'openspec'
    });
    const failingRunner = new SeedLifecycleRunner({
      failCommand: (command) =>
        command.executable === 'openspec' &&
        command.args.join(' ') === 'validate --all --strict'
    });

    const failed = await completeGeneratedSeedLifecycle(root, failingRunner);

    expect(failed.status).toBe('blocked');
    expect(failed.status === 'blocked' ? failed.issues.join('\n') : '')
      .toContain('post-archive strict validation failed');
    expect(failingRunner.calls.some((call) => call.command.args[0] === 'archive')).toBe(true);

    const recovered = await completeGeneratedSeedLifecycle(root, new SeedLifecycleRunner());
    expect(recovered.status).toBe('already-archived');
    expect(recovered.status === 'already-archived' ? recovered.detail : '')
      .toContain('main specs remain strict-valid');
  });

  it('retries post-archive strict validation through the public governance command path', async () => {
    const { root } = await fixtureProject({
      projectName: 'Retry Archived Seed',
      projectType: 'power-apps-code-app',
      specWorkflow: 'openspec'
    });
    const readyRunner = new SeedLifecycleRunner();
    for (const phase of ['seed-valid', 'seed-verified']) {
      const applied = await runCli(
        ['governance', 'apply-next', '--json', '--execute'],
        root,
        { runner: readyRunner }
      );
      expect(applied.code, `${phase}: ${applied.out}${applied.err}`).toBe(0);
      expect(JSON.parse(applied.out)).toMatchObject({
        applied: true,
        nextReadyPhase: phase
      });
    }
    const failingRunner = new SeedLifecycleRunner({
      failCommand: (command) =>
        command.executable === 'openspec' &&
        command.args.join(' ') === 'validate --all --strict'
    });

    const failed = await runCli(
      ['governance', 'apply-next', '--json', '--execute'],
      root,
      { runner: failingRunner }
    );

    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.out)).toMatchObject({
      applied: false,
      reason: 'blocked',
      nextReadyPhase: 'seed-archived'
    });
    expect(JSON.parse(failed.out).blockers.join('\n'))
      .toContain('post-archive strict validation failed');
    expect(JSON.parse(failed.out).executedOperations.map(
      (operation: { actionId: string }) => operation.actionId
    )).not.toContain('governance.activation-state.write');
    const stateAfterFailure = JSON.parse(
      await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8')
    );
    expect(stateAfterFailure.phases['seed-archived']).toMatchObject({
      state: 'pending',
      blockers: []
    });
    const retryStatus = await runCli(['governance', 'status', '--json'], root);
    expect(JSON.parse(retryStatus.out).nextReadyPhase).toBe('seed-archived');

    const recovered = await runCli(
      ['governance', 'apply-next', '--json', '--execute'],
      root,
      { runner: new SeedLifecycleRunner() }
    );

    expect(recovered.code, recovered.out).toBe(0);
    expect(JSON.parse(recovered.out)).toMatchObject({
      applied: true,
      nextReadyPhase: 'seed-archived'
    });
    const finalState = JSON.parse(
      await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8')
    );
    expect(finalState.phases['seed-archived'].state).toBe('verified');
  });

  it('blocks previously verified archives whose synchronized capability is missing or has a fallback Purpose', async () => {
    const { root } = await fixtureProject({
      projectName: 'Legacy Invalid Archive',
      projectType: 'power-apps-code-app',
      specWorkflow: 'openspec'
    });
    const runner = new SeedLifecycleRunner();
    for (const phase of ['seed-valid', 'seed-verified', 'seed-archived']) {
      const applied = await runCli(
        ['governance', 'apply-next', '--json', '--execute'],
        root,
        { runner }
      );
      expect(applied.code, `${phase}: ${applied.out}${applied.err}`).toBe(0);
    }
    const manifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
    const capabilityId = generatedSeedCapabilityId(manifest.project.workload);
    const mainSpecPath = path.join(root, 'openspec', 'specs', capabilityId, 'spec.md');
    await writeFile(
      mainSpecPath,
      `# ${capabilityId}\n\n## Purpose\n\nTBD - created by archiving change bootstrap-legacy-invalid-archive. Update Purpose after archive.\n\n## Requirements\n`,
      'utf8'
    );

    const placeholder = await runCli(['governance', 'status', '--json'], root);
    expect(placeholder.code).toBe(0);
    expect(JSON.parse(placeholder.out).phases.find((phase: { id: string }) =>
      phase.id === 'seed-archived'
    )).toMatchObject({
      state: 'blocked',
      blockers: [expect.stringContaining('no concrete Purpose')]
    });
    const verify = await runCli(['governance', 'verify', '--json'], root);
    expect(verify.code).toBe(1);
    expect(JSON.parse(verify.out).checks.find((check: { id: string }) =>
      check.id === 'archived-seed-integrity'
    )).toMatchObject({ status: 'failed' });

    await rm(mainSpecPath);
    const missing = await runCli(['governance', 'status', '--json'], root);
    expect(JSON.parse(missing.out).phases.find((phase: { id: string }) =>
      phase.id === 'seed-archived'
    ).blockers).toContainEqual(expect.stringContaining('no synchronized main capability spec'));
  });

  it('keeps archived generated seeds clean for update, validate, and doctor', async () => {
    const { root } = await fixtureProject({
      projectName: 'Clean Archive Seed',
      pattern: 'prompt',
      cloud: 'azure',
      specWorkflow: 'openspec',
      includeFrontend: false
    });
    const runner = new SeedLifecycleRunner();
    const lifecycle = await completeGeneratedSeedLifecycle(root, runner);
    await writeFile(path.join(root, '.env'), await readFile(path.join(root, '.env.example'), 'utf8'));
    const stagingRoot = await testWorkspace('liftoff-staging');
    process.env.LIFTOFF_STAGING_ROOT = stagingRoot;
    const commandContext = {
      stableReleaseLookup: async () => ({
        name: liftoffPackageName,
        version: liftoffVersion
      }),
      configuredRegistryTargetLookup: async () => ({ status: 'available' as const, registryKind: 'canonical' as const })
    };

    expect(lifecycle.status).toBe('archived');

    const check = await runCli(['update', '--check'], root, commandContext);
    expect(check.code).toBe(0);
    expect(check.out).toContain('Liftoff core is current');

    const apply = await runCli(['update'], root, commandContext);
    expect(apply.code).toBe(0);

    const validate = await runCli(['validate'], root, commandContext);
    expect(validate.code).toBe(0);

    const doctor = await runCli(['doctor'], root, commandContext);
    expect(doctor.code, `${doctor.out}${doctor.err}`).toBe(0);
  });

  it('heals legacy manifests that recorded seed entries', async () => {
    const { root } = await fixtureProject({
      projectName: 'Legacy Seed App',
      pattern: 'prompt',
      cloud: 'azure',
      region: 'eastus',
      environments: ['dev'],
      specWorkflow: 'openspec',
      includeFrontend: false
    });
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const changeName = generatedSeedChangeName(manifest);
    manifest.artifactVersion = 5;
    delete manifest.governance.activationIdentity;
    manifest.artifacts = [
      ...manifest.managedArtifacts,
      ...manifest.projectArtifacts.map((artifact: {
        logicalName: string;
        category: string;
        pathParts: string[];
        generationHash: string;
      }) => ({
        logicalName: artifact.logicalName,
        category: artifact.category,
        pathParts: artifact.pathParts,
        contentHash: artifact.generationHash
      }))
    ];
    delete manifest.managedArtifacts;
    delete manifest.projectArtifacts;

    const seedFiles: Array<[string, string[]]> = [
      ['openspec-seed-change-metadata', ['.openspec.yaml']],
      ['openspec-seed-proposal', ['proposal.md']],
      ['openspec-seed-design', ['design.md']],
      ['openspec-seed-tasks', ['tasks.md']],
      ['openspec-seed-spec', ['specs', generatedSeedCapabilityId(manifest.project.workload), 'spec.md']]
    ];
    for (const [logicalName, fileName] of seedFiles) {
      const pathParts = ['openspec', 'changes', changeName, ...fileName];
      const bytes = await readFile(path.join(root, ...pathParts));
      manifest.artifacts.push({
        logicalName,
        category: 'governance',
        pathParts,
        contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      });
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await archiveSeedChange(root, changeName);

    const stagingRoot = await testWorkspace('liftoff-legacy-staging');
    process.env.LIFTOFF_STAGING_ROOT = stagingRoot;
    const check = await runCli(['update', '--check'], root);
    expect(check.code).toBe(2);
    expect(check.out).toContain('Manifest maintenance');

    const validate = await runCli(['validate'], root);
    expect(validate.code).toBe(0);

    await runCli(['update'], root);
    const rewritten = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(
      [...rewritten.managedArtifacts, ...rewritten.projectArtifacts].filter(
        (artifact: { logicalName: string }) => artifact.logicalName.startsWith('openspec-seed')
      )
    ).toEqual([]);
  });

  it('keeps the emitted migrate-to-liftoff change invisible after archiving', async () => {
    const parent = await testWorkspace('liftoff-seed-migrate');
    const source = path.join(parent, 'old-shop');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'requirements.txt'), 'fastapi==0.111.0\n');

    process.env.LIFTOFF_STAGING_ROOT = await testWorkspace('liftoff-migrate-staging');
    const migrated = await runCli(['migrate', source, '--pattern', 'prompt', '--region', 'eastus', '--yes'], parent);
    expect(migrated.code).toBe(0);
    const target = path.join(parent, 'old-shop-liftoff');

    await mkdir(path.join(target, 'openspec', 'changes', 'archive'), { recursive: true });
    await rename(
      path.join(target, 'openspec', 'changes', 'migrate-to-liftoff'),
      path.join(target, 'openspec', 'changes', 'archive', 'done-migrate-to-liftoff')
    );

    const check = await runCli(['update', '--check'], target);
    expect(check.code).toBe(0);
    expect(check.out).toContain('Liftoff core is current');

    const validate = await runCli(['validate'], target);
    expect(validate.code).toBe(0);
  });
});
