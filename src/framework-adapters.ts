import { lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  captureTreeState,
  claimFrameworkChanges,
  InitFileSystemError,
  validateStagedTree,
  type StagingArea
} from './init-filesystem.js';
import {
  frameworkSelectionFromPlan,
  validateFrameworkInstallation
} from './framework-validation.js';
import type { CommandRunner, RunCommandOptions } from './process-runner.js';
import type { ExternalCommand, ProjectPlan } from './types.js';

export interface FrameworkInitializationResult {
  commands: string[];
  changedPaths: string[];
}

export interface FrameworkAdapter {
  id: ProjectPlan['specWorkflow']['id'];
  buildCommands(plan: ProjectPlan): ExternalCommand[];
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

export function buildOpenSpecInitCommand(plan: ProjectPlan): ExternalCommand {
  return {
    executable: plan.framework.executable,
    args: [
      'init',
      '--tools',
      plan.agents.map((agent) => agent.integrationIds.openspec).join(','),
      '--profile',
      'core'
    ]
  };
}

function specKitIntegrationArgs(agent: ProjectPlan['agents'][number]): string[] {
  return agent.id === 'github-copilot' ? ['--integration-options=--skills'] : [];
}

export function buildSpecKitInitCommands(plan: ProjectPlan): ExternalCommand[] {
  if (!plan.defaultAgent) {
    throw new InitFileSystemError('Spec Kit initialization requires a default agent.');
  }
  const primary = plan.defaultAgent;
  const commands: ExternalCommand[] = [{
    executable: plan.framework.executable,
    args: [
      'init',
      '--here',
      '--force',
      '--ignore-agent-tools',
      '--integration',
      primary.integrationIds['spec-kit'],
      ...specKitIntegrationArgs(primary)
    ]
  }];
  for (const agent of plan.agents) {
    if (agent.id === primary.id) {
      continue;
    }
    commands.push({
      executable: plan.framework.executable,
      args: [
        'integration',
        'install',
        agent.integrationIds['spec-kit'],
        '--force',
        ...specKitIntegrationArgs(agent)
      ]
    });
  }
  return commands;
}

export const frameworkAdapters: Record<ProjectPlan['specWorkflow']['id'], FrameworkAdapter> = {
  openspec: {
    id: 'openspec',
    buildCommands: (plan) => [buildOpenSpecInitCommand(plan)]
  },
  'spec-kit': {
    id: 'spec-kit',
    buildCommands: buildSpecKitInitCommands
  }
};

async function assertNoFrameworkGitMetadata(root: string): Promise<void> {
  try {
    await lstat(path.join(root, '.git'));
    throw new InitFileSystemError('Framework initializer created forbidden .git metadata in staging.');
  } catch (error) {
    if (error instanceof InitFileSystemError) {
      throw error;
    }
    if (errorCode(error) !== 'ENOENT') {
      throw new InitFileSystemError(`Unable to inspect staged .git metadata: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export async function initializeFramework(
  area: StagingArea,
  plan: ProjectPlan,
  runner: CommandRunner,
  streamOptions: Pick<RunCommandOptions, 'stdout' | 'stderr'> = {}
): Promise<FrameworkInitializationResult> {
  const before = await captureTreeState(area.root);
  const commands = frameworkAdapters[plan.specWorkflow.id].buildCommands(plan);
  const displayed: string[] = [];
  for (const command of commands) {
    const result = await runner.run(command, {
      cwd: area.root,
      timeoutMs: 5 * 60_000,
      stream: true,
      ...streamOptions
    });
    displayed.push(result.displayCommand);
    if (result.status !== 0 || result.timedOut) {
      const detail = result.timedOut
        ? 'command timed out'
        : result.stderr.trim().split(/\r?\n/)[0] || `exit status ${result.status}`;
      throw new InitFileSystemError(`Framework initializer failed: ${result.displayCommand}: ${detail}`);
    }
  }

  await assertNoFrameworkGitMetadata(area.root);
  const changedPaths = await claimFrameworkChanges(area, before, plan.framework.allowedRoots);
  await validateStagedTree(area);
  const issues = await validateFrameworkInstallation(area.root, frameworkSelectionFromPlan(plan));
  if (issues.length > 0) {
    throw new InitFileSystemError(`Framework initialization did not produce the tested contract:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
  }
  return { commands: displayed, changedPaths };
}
