import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildDependencySetupPlan,
  dependencyResumeCommand,
  dependencyResumeShell,
  runDependencySetup,
  verifyDependencyLockPair,
  type DependencySetupPlan
} from '../src/project-dependencies.js';
import type {
  CommandResult,
  CommandRunner,
  RunCommandOptions
} from '../src/process-runner.js';
import { buildProjectPlan } from '../src/planner.js';
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
      expect(setupResult.resumeCommand).toBe(dependencyResumeCommand(command));
      expect(setupResult.resumeShell).toBe(dependencyResumeShell());
      expect(await readFile(path.join(tempRoot, 'README.md'), 'utf8')).toBe('scaffold\n');
      expect(await readFile(path.join(tempRoot, 'backend', 'package.json'), 'utf8')).toBe('{"name":"app"}\n');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('preserves and reports metadata changes even when the command exits successfully', async () => {
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
        detail: 'Dependency metadata changed during setup and was preserved for review: backend/package.json',
        restoredMutations: [],
        preservedMutations: ['backend/package.json']
      });
      expect(await readFile(packageFile, 'utf8')).toBe('{"name":"mutated"}\n');
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
    }, 'win32')).toBe("Set-Location -LiteralPath 'C:\\workspace\\app\\frontend'; if ($?) { & 'npm.cmd' 'ci' }");

    for (const directory of ['node-backend', 'frontend']) {
      expect(await verifyDependencyLockPair(
        path.resolve('assets', 'locks', directory, 'package.json'),
        path.resolve('assets', 'locks', directory, 'package-lock.json')
      )).toBe(true);
    }
  });

  it('preserves a frontend edit made while backend installation runs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-dependencies-concurrent-'));
    try {
      for (const component of ['backend', 'frontend']) {
        await mkdir(path.join(root, component));
        await writeFile(path.join(root, component, 'package.json'), `${component}\n`);
      }
      const runner = new DependencyRunner(async () => {
        await writeFile(path.join(root, 'frontend', 'package.json'), 'developer edit\n');
        return {};
      });
      const setupResult = await runDependencySetup({
        commands: ['backend', 'frontend'].map((component) => ({
          id: component,
          label: `Install ${component}`,
          command: { executable: 'npm', args: ['ci'] },
          cwd: path.join(root, component)
        })),
        protectedPaths: [['backend', 'package.json'], ['frontend', 'package.json']]
      }, root, runner, { stdout: new CaptureStream(), stderr: new CaptureStream() });
      expect(setupResult).toMatchObject({
        success: false,
        restoredMutations: [],
        preservedMutations: ['frontend/package.json']
      });
      expect(runner.calls).toHaveLength(1);
      expect(await readFile(path.join(root, 'frontend', 'package.json'), 'utf8')).toBe('developer edit\n');
      expect(await readFile(path.join(root, 'backend', 'package.json'), 'utf8')).toBe('backend\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves a metadata deletion instead of recreating a file after failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-dependencies-deletion-'));
    try {
      const file = path.join(root, 'package.json');
      await writeFile(file, 'original');
      const runner = new DependencyRunner(async () => {
        await rm(file);
        return { status: 1, stderr: 'installation failed' };
      });
      const setupResult = await runDependencySetup({
        commands: [{ id: 'install', label: 'Install', command: { executable: 'npm', args: ['ci'] }, cwd: root }],
        protectedPaths: [['package.json']]
      }, root, runner, { stdout: new CaptureStream(), stderr: new CaptureStream() });
      expect(setupResult.preservedMutations).toEqual(['package.json']);
      expect(setupResult.restoredMutations).toEqual([]);
      await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('executes a POSIX recovery recipe with a literal quoted directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-recovery-shell-'));
    try {
      const cwd = path.join(root, "O'Brien $client [literal]");
      await mkdir(cwd);
      const command = dependencyResumeCommand({
        id: 'probe',
        label: 'Read working directory',
        command: { executable: process.execPath, args: ['-e', 'process.stdout.write(process.cwd())'] },
        cwd
      }, 'linux');
      const output = execFileSync('sh', ['-c', command], {
        encoding: 'utf8',
        env: { ...process.env, client: 'must-not-expand' }
      });
      expect(output).toBe(await realpath(cwd));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('quotes PowerShell paths and native arguments literally', () => {
    const command = dependencyResumeCommand({
      id: 'probe',
      label: 'Probe',
      command: { executable: 'npm.cmd', args: ['ci', '@scope/package', '$literal'] },
      cwd: String.raw`C:\work\O'Brien\$client[0]`
    }, 'win32');
    expect(dependencyResumeShell('win32')).toBe('PowerShell');
    expect(command).toContain(String.raw`-LiteralPath 'C:\work\O''Brien\$client[0]'`);
    expect(command).toContain("& 'npm.cmd' 'ci' '@scope/package' '$literal'");
  });

});
