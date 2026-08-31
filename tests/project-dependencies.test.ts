import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildDependencySetupPlan,
  dependencyResumeCommand,
  runDependencySetup,
  verifyPowerAppsPackageMetadata,
  verifyDependencyLockPair,
  type DependencySetupPlan
} from '../src/project-dependencies.js';
import { writeArtifacts } from '../src/file-system.js';
import type {
  CommandResult,
  CommandRunner,
  RunCommandOptions
} from '../src/process-runner.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import type { ExternalCommand } from '../src/types.js';
import {
  selectWorkstationRequirements,
  type RequirementProbeResult
} from '../src/workstation.js';
import { CaptureStream } from './helpers.js';

function result(command: ExternalCommand, values: Partial<CommandResult> = {}): CommandResult {
  return {
    command,
    displayCommand: [command.executable, ...command.args].join(' '),
    status: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...values
  };
}

class DependencyRunner implements CommandRunner {
  calls: Array<{ command: ExternalCommand; options?: RunCommandOptions }> = [];

  constructor(
    private readonly handler: (
      command: ExternalCommand,
      options: RunCommandOptions | undefined,
      call: number
    ) => Promise<Partial<CommandResult>> | Partial<CommandResult> = () => ({})
  ) {}

  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push({ command, options });
    return result(command, await this.handler(command, options, this.calls.length));
  }
}

function readyProbes(
  plan: ReturnType<typeof buildProjectPlan>,
  detected: Record<string, string> = {}
): RequirementProbeResult[] {
  return selectWorkstationRequirements(plan).map((requirement) => ({
    requirement,
    state: 'ready',
    detail: 'ready',
    notices: [],
    detectedBy: detected[requirement.id] ?? requirement.definition.probes[0]?.executable
  }));
}

describe('project dependency setup', () => {
  it('builds deterministic Python, Node.js, Go, and frontend command plans', () => {
    const root = path.resolve('/workspace/project');
    const python = buildProjectPlan({
      projectName: 'python-app',
      pattern: 'rag',
      cloud: 'azure',
      includeFrontend: true
    }, { requireProjectName: true });
    const node = buildProjectPlan({
      projectName: 'node-app',
      projectType: 'standard',
      apiStack: 'node',
      cloud: 'azure',
      includeFrontend: false
    }, { requireProjectName: true });
    const go = buildProjectPlan({
      projectName: 'go-app',
      projectType: 'standard',
      apiStack: 'go',
      cloud: 'azure',
      includeFrontend: false
    }, { requireProjectName: true });

    const pythonSetup = buildDependencySetupPlan(
      python,
      root,
      readyProbes(python, { python: 'python' }),
      'linux'
    );
    expect(pythonSetup.commands.map((item) => item.id)).toEqual([
      'python-backend',
      'node-frontend'
    ]);
    expect(pythonSetup.commands[0]?.command).toEqual({
      executable: 'uv',
      args: [
        'sync',
        '--frozen',
        '--project',
        'backend',
        '--extra',
        'test',
        '--extra',
        'functions'
      ]
    });
    expect(pythonSetup.protectedPaths).toContainEqual(['backend', 'uv.lock']);
    expect(pythonSetup.protectedPaths).toContainEqual(['functions', 'rag-worker', 'requirements.txt']);

    const nodeSetup = buildDependencySetupPlan(node, root, readyProbes(node), 'win32');
    expect(nodeSetup.commands).toMatchObject([{
      id: 'node-backend',
      command: { executable: 'npm.cmd', args: ['ci'] },
      cwd: path.join(root, 'backend')
    }]);

    const goSetup = buildDependencySetupPlan(go, root, readyProbes(go), 'linux');
    expect(goSetup.commands).toMatchObject([{
      id: 'go-backend',
      command: { executable: 'go', args: ['mod', 'download'] },
      cwd: path.join(root, 'backend')
    }]);

    const powerApps = buildProjectPlan({
      projectName: 'code-app',
      projectType: 'power-apps-code-app'
    }, { requireProjectName: true });
    const powerAppsSetup = buildDependencySetupPlan(
      powerApps,
      root,
      readyProbes(powerApps),
      'win32'
    );
    expect(powerAppsSetup).toEqual({
      commands: [{
        id: 'power-apps-root',
        label: 'Install Power Apps code app dependencies',
        command: { executable: 'npm.cmd', args: ['ci'] },
        cwd: root
      }],
      protectedPaths: [['package.json'], ['package-lock.json']]
    });
    expect(dependencyResumeCommand(powerAppsSetup.commands[0]!, 'win32'))
      .toBe(`cd /d ${JSON.stringify(root)} && npm.cmd ci`);
  });

  it('runs commands in order with streaming and the planned working directories', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-dependencies-success-'));
    const protectedFile = path.join(tempRoot, 'backend', 'package.json');
    try {
      await mkdir(path.dirname(protectedFile), { recursive: true });
      await writeFile(protectedFile, '{"name":"app"}\n');
      const setup: DependencySetupPlan = {
        commands: [
          {
            id: 'backend',
            label: 'Install backend',
            command: { executable: 'npm', args: ['ci'] },
            cwd: path.join(tempRoot, 'backend')
          },
          {
            id: 'frontend',
            label: 'Install frontend',
            command: { executable: 'npm', args: ['ci'] },
            cwd: path.join(tempRoot, 'frontend')
          }
        ],
        protectedPaths: [['backend', 'package.json']]
      };
      const runner = new DependencyRunner();

      const setupResult = await runDependencySetup(setup, tempRoot, runner, {
        stdout: new CaptureStream(),
        stderr: new CaptureStream()
      });

      expect(setupResult).toMatchObject({ success: true, restoredMutations: [] });
      expect(setupResult.completed.map((item) => item.id)).toEqual(['backend', 'frontend']);
      expect(runner.calls.map((call) => call.options)).toMatchObject([
        { cwd: path.join(tempRoot, 'backend'), stream: true, timeoutMs: 900_000 },
        { cwd: path.join(tempRoot, 'frontend'), stream: true, timeoutMs: 900_000 }
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('preserves the scaffold and reports a cwd-aware resume command after failure', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-dependencies-failure-'));
    try {
      await mkdir(path.join(tempRoot, 'backend'), { recursive: true });
      await writeFile(path.join(tempRoot, 'backend', 'package.json'), '{"name":"app"}\n');
      await writeFile(path.join(tempRoot, 'README.md'), 'scaffold\n');
      const command = {
        id: 'backend',
        label: 'Install backend',
        command: { executable: 'npm', args: ['ci'] },
        cwd: path.join(tempRoot, 'backend')
      };
      const runner = new DependencyRunner(() => ({ status: 1, stderr: 'registry unavailable\nmore detail\n' }));

      const setupResult = await runDependencySetup({
        commands: [command],
        protectedPaths: [['backend', 'package.json']]
      }, tempRoot, runner, {
        stdout: new CaptureStream(),
        stderr: new CaptureStream()
      });

      expect(setupResult).toMatchObject({
        success: false,
        failed: command,
        detail: 'registry unavailable',
        restoredMutations: []
      });
      expect(setupResult.resumeCommand).toBe(
        `cd${process.platform === 'win32' ? ' /d' : ''} ${JSON.stringify(path.join(tempRoot, 'backend'))} && npm ci`
      );
      expect(await readFile(path.join(tempRoot, 'README.md'), 'utf8')).toBe('scaffold\n');
      expect(await readFile(path.join(tempRoot, 'backend', 'package.json'), 'utf8')).toBe('{"name":"app"}\n');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('restores and rejects protected-file mutations even when the command exits successfully', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-dependencies-mutation-'));
    const packageFile = path.join(tempRoot, 'backend', 'package.json');
    try {
      await mkdir(path.dirname(packageFile), { recursive: true });
      await writeFile(packageFile, '{"name":"original"}\n');
      const runner = new DependencyRunner(async () => {
        await writeFile(packageFile, '{"name":"mutated"}\n');
        return {};
      });

      const setupResult = await runDependencySetup({
        commands: [{
          id: 'backend',
          label: 'Install backend',
          command: { executable: 'npm', args: ['ci'] },
          cwd: path.dirname(packageFile)
        }],
        protectedPaths: [['backend', 'package.json']]
      }, tempRoot, runner, {
        stdout: new CaptureStream(),
        stderr: new CaptureStream()
      });

      expect(setupResult).toMatchObject({
        success: false,
        detail: 'dependency command modified protected files: backend/package.json',
        restoredMutations: ['backend/package.json']
      });
      expect(await readFile(packageFile, 'utf8')).toBe('{"name":"original"}\n');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('formats Windows resume commands and validates packaged npm lock pairs', async () => {
    expect(dependencyResumeCommand({
      id: 'frontend',
      label: 'Install frontend',
      command: { executable: 'npm.cmd', args: ['ci'] },
      cwd: 'C:\\workspace\\app\\frontend'
    }, 'win32')).toBe('cd /d "C:\\\\workspace\\\\app\\\\frontend" && npm.cmd ci');

    for (const directory of ['node-backend', 'frontend']) {
      expect(await verifyDependencyLockPair(
        path.resolve('assets', 'locks', directory, 'package.json'),
        path.resolve('assets', 'locks', directory, 'package-lock.json')
      )).toBe(true);
    }
  });

  it('validates the Power Apps SDK, Vite plugin, CLI, and lock identity', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-power-apps-metadata-'));
    try {
      const plan = buildProjectPlan({
        projectName: 'Metadata App',
        projectType: 'power-apps-code-app'
      }, { requireProjectName: true });
      await writeArtifacts(tempRoot, buildArtifacts(plan));
      expect(await verifyPowerAppsPackageMetadata(tempRoot)).toEqual([]);

      const packagePath = path.join(tempRoot, 'package.json');
      const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
        dependencies: Record<string, string>;
      };
      delete packageJson.dependencies['@microsoft/power-apps'];
      await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
      expect(await verifyPowerAppsPackageMetadata(tempRoot)).toContain(
        'package.json must declare @microsoft/power-apps.'
      );

      const lockPath = path.join(tempRoot, 'package-lock.json');
      const lockJson = JSON.parse(await readFile(lockPath, 'utf8')) as {
        name: string;
        packages: Record<string, {
          name?: string;
          bin?: Record<string, string>;
        }>;
      };
      lockJson.name = 'different-project';
      delete lockJson.packages['node_modules/@microsoft/power-apps-cli']?.bin?.['power-apps'];
      await writeFile(lockPath, `${JSON.stringify(lockJson, null, 2)}\n`);
      const issues = await verifyPowerAppsPackageMetadata(tempRoot);
      expect(issues).toContain('package.json and package-lock.json must record the same project name.');
      expect(issues).toContain(
        'package-lock.json must include the project-local power-apps CLI declaration.'
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
