import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommandRunner } from './process-runner.js';
import {
  captureProjectFileSnapshot
} from './adapters/filesystem/project-transaction.js';
import { withProjectMutationLock } from './adapters/filesystem/project-lock.js';
import type { ExternalCommand, ProjectPlan } from './domain/project/contracts.js';
import type { RequirementProbeResult } from './workstation.js';
import {
  commandShellForPlatform,
  formatShellDirectoryCommand
} from './adapters/process/shell-command.js';

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
  preservedMutations: string[];
  resumeCommand?: string;
  resumeShell?: string;
}

export interface DependencySetupExecutionOptions {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  onCommand?: (command: DependencyCommandPlan) => void;
}

function npmExecutable(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function buildDependencySetupPlan(
  plan: ProjectPlan,
  projectRoot: string,
  _probes: RequirementProbeResult[],
  platform: NodeJS.Platform = process.platform
): DependencySetupPlan {
  const commands: DependencyCommandPlan[] = [];
  const protectedPaths: string[][] = [];
  if (plan.apiStack.id === 'python-fastapi') {
    commands.push({
      id: 'python-backend',
      label: 'Synchronize locked Python dependencies',
      command: {
        executable: 'uv',
        args: [
          'sync',
          '--frozen',
          '--project',
          'backend',
          '--extra',
          'test',
          ...(plan.workload === 'genai' && plan.pattern.worker
            ? ['--extra', 'functions']
            : [])
        ]
      },
      cwd: projectRoot
    });
    protectedPaths.push(['backend', 'pyproject.toml'], ['backend', 'uv.lock']);
    if (plan.workload === 'genai' && plan.pattern.worker) {
      const requirements = ['functions', `${plan.pattern.id}-worker`, 'requirements.txt'];
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
  hash: string;
  mode?: number;
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
    const { content, mode } = await captureProjectFileSnapshot(projectRoot, pathParts);
    if (!content) {
      throw new Error(`Dependency setup cannot protect missing file ${pathParts.join('/')}.`);
    }
    snapshots.push({ pathParts, hash: contentHash(content), mode });
  }
  return snapshots;
}

async function changedProtectedPaths(
  projectRoot: string,
  snapshots: ProtectedSnapshot[]
): Promise<string[]> {
  const changed: string[] = [];
  for (const snapshot of snapshots) {
    const current = await captureProjectFileSnapshot(projectRoot, snapshot.pathParts);
    if (
      current.content === undefined ||
      contentHash(current.content) !== snapshot.hash ||
      current.mode !== snapshot.mode
    ) {
      changed.push(snapshot.pathParts.join('/'));
    }
  }
  return changed;
}

export function dependencyResumeShell(platform: NodeJS.Platform = process.platform): string {
  return commandShellForPlatform(platform) === 'powershell' ? 'PowerShell' : 'POSIX shell';
}

export function dependencyResumeCommand(
  command: DependencyCommandPlan,
  platform: NodeJS.Platform = process.platform
): string {
  return formatShellDirectoryCommand(command.command, command.cwd, commandShellForPlatform(platform));
}

export async function runDependencySetup(
  setup: DependencySetupPlan,
  projectRoot: string,
  runner: CommandRunner,
  options: DependencySetupExecutionOptions
): Promise<DependencySetupResult> {
  return withProjectMutationLock(projectRoot, async (lease) => {
    const snapshots = await captureProtectedFiles(projectRoot, setup.protectedPaths);
    const completed: DependencyCommandPlan[] = [];
    for (const command of setup.commands) {
      await lease.assertHeld();
      const before = await changedProtectedPaths(projectRoot, snapshots);
      if (before.length) {
        return {
          success: false,
          completed,
          failed: command,
          detail: `Dependency metadata changed before execution and was preserved for review: ${before.join(', ')}`,
          restoredMutations: [],
          preservedMutations: before,
          resumeCommand: dependencyResumeCommand(command),
          resumeShell: dependencyResumeShell()
        };
      }
      options.onCommand?.(command);
      const result = await runner.run(command.command, {
        cwd: command.cwd,
        timeoutMs: 15 * 60_000,
        stream: true,
        stdout: options.stdout,
        stderr: options.stderr
      });
      await lease.assertHeld();
      const preservedMutations = await changedProtectedPaths(projectRoot, snapshots);
      if (result.status !== 0 || result.timedOut || result.errorCode) {
        return {
          success: false,
          completed,
          failed: command,
          detail: result.timedOut
            ? 'dependency command timed out'
            : result.errorMessage || result.stderr.trim().split(/\r?\n/)[0] || `exit status ${result.status}`,
          restoredMutations: [],
          preservedMutations,
          resumeCommand: dependencyResumeCommand(command),
          resumeShell: dependencyResumeShell()
        };
      }
      if (preservedMutations.length > 0) {
        return {
          success: false,
          completed,
          failed: command,
          detail: `Dependency metadata changed during setup and was preserved for review: ${preservedMutations.join(', ')}`,
          restoredMutations: [],
          preservedMutations,
          resumeCommand: dependencyResumeCommand(command),
          resumeShell: dependencyResumeShell()
        };
      }
      completed.push(command);
    }
    return { success: true, completed, restoredMutations: [], preservedMutations: [] };
  });
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
