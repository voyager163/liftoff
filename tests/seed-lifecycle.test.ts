import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand, type CommandContext } from '../src/commands.js';
import { validateGeneratedProject, writeArtifacts, writeProjectFile } from '../src/file-system.js';
import {
  completeGeneratedSeedLifecycle,
  generatedSeedCapabilityId,
  generatedSeedChangeName,
  selectSeedBaselineChecks
} from '../src/governance-activation/seed-lifecycle.js';
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

async function fixtureProject(options: ProjectOptions): Promise<{ root: string; plan: ProjectPlan }> {
  const parent = await testWorkspace('liftoff-seed');
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
    'configuredRegistryTargetLookup' | 'stableReleaseLookup'
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
  } = {}) {}

  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push({ command, cwd: options?.cwd });
    if (this.options.failCommand?.(command)) {
      return this.result(command, {
        status: 1,
        stderr: 'configured failure\n'
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
      await archiveSeedChange(cwd, changeName);
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
    expect(runner.calls.at(-1)?.command).toEqual({
      executable: 'openspec',
      args: ['archive', changeName, '--yes', '--json']
    });
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
