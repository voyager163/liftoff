import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { formatCommand, type CommandRunner } from './process-runner.js';
import { readProjectFile, writeProjectFile } from './file-system.js';
import type { ExternalCommand, ProjectPlan } from './types.js';
import type { RequirementProbeResult } from './workstation.js';

export interface DependencyCommandPlan {
  id: string;
  label: string;
  command: ExternalCommand;
  cwd: string;
}

export interface DependencySetupPlan {
  commands: DependencyCommandPlan[];
  protectedPaths: string[][];
}

export interface DependencySetupResult {
  success: boolean;
  completed: DependencyCommandPlan[];
  failed?: DependencyCommandPlan;
  detail?: string;
  restoredMutations: string[];
  resumeCommand?: string;
}

function npmExecutable(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function pythonCommand(probes: RequirementProbeResult[]): { executable: string; prefixArgs: string[] } {
  const python = probes.find((probe) => probe.requirement.id === 'python' && probe.state === 'ready');
  const executable = python?.detectedBy ?? (process.platform === 'win32' ? 'py' : 'python3');
  return {
    executable,
    prefixArgs: executable === 'py' ? ['-3'] : []
  };
}

export function buildDependencySetupPlan(
  plan: ProjectPlan,
  projectRoot: string,
  probes: RequirementProbeResult[],
  platform: NodeJS.Platform = process.platform
): DependencySetupPlan {
  const commands: DependencyCommandPlan[] = [];
  const protectedPaths: string[][] = [];
  if (plan.apiStack.id === 'python-fastapi') {
    const python = pythonCommand(probes);
    const virtualPython = platform === 'win32'
      ? path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
      : path.join(projectRoot, '.venv', 'bin', 'python');
    commands.push({
      id: 'python-venv',
      label: 'Create project Python virtual environment',
      command: {
        executable: python.executable,
        args: [...python.prefixArgs, '-m', 'venv', '.venv']
      },
      cwd: projectRoot
    }, {
      id: 'python-backend',
      label: 'Install backend Python dependencies',
      command: {
        executable: virtualPython,
        args: ['-m', 'pip', 'install', '-e', './backend[test]']
      },
      cwd: projectRoot
    });
    protectedPaths.push(['backend', 'pyproject.toml']);
    if (plan.projectType.id === 'genai' && plan.pattern?.worker) {
      const requirements = ['functions', `${plan.pattern.id}-worker`, 'requirements.txt'];
      commands.push({
        id: 'python-function-worker',
        label: 'Install Function worker Python dependencies',
        command: {
          executable: virtualPython,
          args: ['-m', 'pip', 'install', '-r', requirements.join('/')]
        },
        cwd: projectRoot
      });
      protectedPaths.push(requirements);
    }
  } else if (plan.apiStack.id === 'node-fastify') {
    commands.push({
      id: 'node-backend',
      label: 'Install backend Node.js dependencies',
      command: { executable: npmExecutable(platform), args: ['ci'] },
      cwd: path.join(projectRoot, 'backend')
    });
    protectedPaths.push(['backend', 'package.json'], ['backend', 'package-lock.json']);
  } else {
    commands.push({
      id: 'go-backend',
      label: 'Download backend Go modules',
      command: { executable: 'go', args: ['mod', 'download'] },
      cwd: path.join(projectRoot, 'backend')
    });
    protectedPaths.push(['backend', 'go.mod'], ['backend', 'go.sum']);
  }
  if (plan.includeFrontend) {
    commands.push({
      id: 'node-frontend',
      label: 'Install frontend Node.js dependencies',
      command: { executable: npmExecutable(platform), args: ['ci'] },
      cwd: path.join(projectRoot, 'frontend')
    });
    protectedPaths.push(['frontend', 'package.json'], ['frontend', 'package-lock.json']);
  }
  return { commands, protectedPaths };
}

interface ProtectedSnapshot {
  pathParts: string[];
  content: Buffer;
  hash: string;
}

function contentHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function captureProtectedFiles(
  projectRoot: string,
  protectedPaths: string[][]
): Promise<ProtectedSnapshot[]> {
  const snapshots: ProtectedSnapshot[] = [];
  for (const pathParts of protectedPaths) {
    const content = await readProjectFile(projectRoot, pathParts);
    if (!content) {
      throw new Error(`Dependency setup cannot protect missing file ${pathParts.join('/')}.`);
    }
    snapshots.push({ pathParts, content, hash: contentHash(content) });
  }
  return snapshots;
}

async function restoreMutations(
  projectRoot: string,
  snapshots: ProtectedSnapshot[]
): Promise<string[]> {
  const restored: string[] = [];
  for (const snapshot of snapshots) {
    const current = await readProjectFile(projectRoot, snapshot.pathParts);
    if (!current || contentHash(current) !== snapshot.hash) {
      await writeProjectFile(projectRoot, snapshot.pathParts, snapshot.content.toString('utf8'));
      restored.push(snapshot.pathParts.join('/'));
    }
  }
  return restored;
}

export function dependencyResumeCommand(
  command: DependencyCommandPlan,
  platform: NodeJS.Platform = process.platform
): string {
  const changeDirectory = platform === 'win32'
    ? `cd /d ${JSON.stringify(command.cwd)}`
    : `cd ${JSON.stringify(command.cwd)}`;
  return `${changeDirectory} && ${formatCommand(command.command)}`;
}

export async function runDependencySetup(
  setup: DependencySetupPlan,
  projectRoot: string,
  runner: CommandRunner,
  streams: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }
): Promise<DependencySetupResult> {
  const snapshots = await captureProtectedFiles(projectRoot, setup.protectedPaths);
  const completed: DependencyCommandPlan[] = [];
  for (const command of setup.commands) {
    const result = await runner.run(command.command, {
      cwd: command.cwd,
      timeoutMs: 15 * 60_000,
      stream: true,
      stdout: streams.stdout,
      stderr: streams.stderr
    });
    if (result.status !== 0 || result.timedOut) {
      const restoredMutations = await restoreMutations(projectRoot, snapshots);
      return {
        success: false,
        completed,
        failed: command,
        detail: result.timedOut
          ? 'dependency command timed out'
          : result.stderr.trim().split(/\r?\n/)[0] || `exit status ${result.status}`,
        restoredMutations,
        resumeCommand: dependencyResumeCommand(command)
      };
    }
    completed.push(command);
    const restoredMutations = await restoreMutations(projectRoot, snapshots);
    if (restoredMutations.length > 0) {
      return {
        success: false,
        completed,
        failed: command,
        detail: `dependency command modified protected files: ${restoredMutations.join(', ')}`,
        restoredMutations,
        resumeCommand: dependencyResumeCommand(command)
      };
    }
  }
  return { success: true, completed, restoredMutations: [] };
}

export async function verifyDependencyLockPair(
  packagePath: string,
  lockPath: string
): Promise<boolean> {
  const [packageJson, lockJson] = await Promise.all([
    readFile(packagePath, 'utf8').then((value) => JSON.parse(value) as { name?: unknown }),
    readFile(lockPath, 'utf8').then((value) => JSON.parse(value) as {
      name?: unknown;
      packages?: Record<string, { name?: unknown }>;
    })
  ]);
  return packageJson.name === lockJson.name && packageJson.name === lockJson.packages?.['']?.name;
}
