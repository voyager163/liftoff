import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  captureTreeState,
  claimFrameworkChanges,
  InitFileSystemError,
  validateStagedTree,
  type StagingArea,
  type TreeStateEntry
} from './init-filesystem.js';
import {
  frameworkSelectionFromPlan,
  frameworkOutputPaths,
  validateFrameworkInitialization
} from './framework-validation.js';
import {
  OPEN_SPEC_DELIVERY,
  OPEN_SPEC_PROFILE,
  OPEN_SPEC_WORKFLOW_IDS
} from './openspec-profile.js';
import { formatCommand, type CommandRunner, type RunCommandOptions } from './process-runner.js';
import type { ExternalCommand, ProjectPlan } from './domain/project/contracts.js';

export interface FrameworkInitializationResult {
  commands: string[];
  changedPaths: string[];
}

export interface FrameworkInitializationOptions extends Pick<RunCommandOptions, 'env' | 'stdout' | 'stderr'> {
  onCommand?: (displayCommand: string) => void;
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
  const includesGitHubCopilot = plan.agents.some((agent) => agent.id === 'github-copilot');
  return {
    executable: plan.framework.executable,
    args: [
      'init',
      '--tools',
      plan.agents.map((agent) => agent.integrationIds.openspec).join(','),
      '--profile',
      OPEN_SPEC_PROFILE,
      ...(includesGitHubCopilot
        ? [plan.copilotCloud ? '--copilot-cloud' : '--no-copilot-cloud']
        : [])
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
      '--non-interactive',
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

function assertRegisteredFrameworkCommands(plan: ProjectPlan, commands: readonly ExternalCommand[]): void {
  const registered = frameworkAdapters[plan.specWorkflow.id].buildCommands(plan);
  if (plan.specWorkflow.id === 'spec-kit') {
    registered.push(...plan.agents.map((agent) => ({
      executable: plan.framework.executable,
      args: ['integration', 'install', agent.integrationIds['spec-kit'], '--force', ...specKitIntegrationArgs(agent)]
    })));
    registered.push({
      executable: plan.framework.executable,
      args: ['integration', 'use', plan.defaultAgent!.integrationIds['spec-kit']]
    });
  }
  for (const command of commands) {
    if (!registered.some((expected) => expected.executable === command.executable &&
        expected.args.length === command.args.length &&
        expected.args.every((argument, index) => argument === command.args[index]))) {
      throw new InitFileSystemError('Framework execution requires a registered official operation for the selected integrations.');
    }
  }
}

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

function assertSafeFrameworkTree(
  state: ReadonlyMap<string, TreeStateEntry>,
  inventory: readonly string[][]
): void {
  const expectedCase = new Map<string, string>();
  for (const parts of inventory) {
    for (let size = 1; size <= parts.length; size++) {
      const value = parts.slice(0, size).join('/');
      expectedCase.set(value.toLowerCase(), value);
    }
  }
  const observedCase = new Map<string, string>();
  for (const [name, entry] of state) {
    if (entry.type === 'symlink' || entry.type === 'other') {
      throw new InitFileSystemError(`Staged output contains a forbidden ${entry.type}: ${name}`);
    }
    const folded = name.toLowerCase();
    const expected = expectedCase.get(folded) ?? observedCase.get(folded);
    if (expected && expected !== name) {
      throw new InitFileSystemError(`Framework output has a case collision: ${name} and ${expected}`);
    }
    observedCase.set(folded, name);
  }
}

function assertInventoriedNativeChanges(
  before: ReadonlyMap<string, TreeStateEntry>,
  after: ReadonlyMap<string, TreeStateEntry>,
  inventory: readonly string[][]
): void {
  const files = new Set(inventory.map((parts) => parts.join('/')));
  const directories = new Set(inventory.flatMap((parts) =>
    parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('/'))
  ));
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(name);
    const next = after.get(name);
    if (previous?.type === next?.type &&
        previous?.contentHash === next?.contentHash &&
        previous?.mode === next?.mode) {
      continue;
    }
    const entry = next ?? previous!;
    if (!['.agents', '.codex'].includes(entry.pathParts[0])) {
      continue;
    }
    if (!(entry.type === 'directory' ? directories : files).has(name)) {
      throw new InitFileSystemError(`Framework initializer changed a path outside its explicit native inventory: ${name}`);
    }
  }
}

export async function withFrameworkExecutionEnvironment<T>(
  area: StagingArea,
  plan: ProjectPlan,
  environment: NodeJS.ProcessEnv | undefined,
  operation: (env: NodeJS.ProcessEnv) => Promise<T>
): Promise<T> {
  const home = await mkdtemp(path.join(path.dirname(path.resolve(area.root)), 'liftoff-framework-home-'));
  try {
    const config = path.join(home, 'config');
    const scratch = path.join(home, 'scratch');
    const overrides: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ''),
      HOMEPATH: home.slice(path.parse(home).root.replace(/[\\/]$/, '').length),
      APPDATA: path.join(home, 'appdata'),
      LOCALAPPDATA: path.join(home, 'localappdata'),
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: path.join(home, 'data'),
      XDG_CACHE_HOME: path.join(home, 'cache'),
      XDG_STATE_HOME: path.join(home, 'state'),
      CODEX_HOME: path.join(home, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
      GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
      GIT_CONFIG_SYSTEM: path.join(home, 'gitconfig-system'),
      GIT_CONFIG_NOSYSTEM: '1',
      OPENSPEC_TELEMETRY: '0',
      OPENSPEC_NO_UPDATE_CHECK: '1'
    };
    const env: NodeJS.ProcessEnv = { ...process.env, ...environment };
    for (const key of Object.keys(env)) {
      if (Object.hasOwn(overrides, key.toUpperCase())) {
        env[key] = overrides[key.toUpperCase()];
      }
    }
    Object.assign(env, overrides);
    await Promise.all([
      config, scratch, overrides.APPDATA!, overrides.LOCALAPPDATA!,
      overrides.XDG_DATA_HOME!, overrides.XDG_CACHE_HOME!, overrides.XDG_STATE_HOME!,
      overrides.CODEX_HOME!, overrides.CLAUDE_CONFIG_DIR!
    ].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
    if (plan.specWorkflow.id === 'openspec') {
      // Global-profile consent is checked by the caller; stage only its required public fields.
      const profileRoot = path.join(config, 'openspec');
      await mkdir(profileRoot, { recursive: true, mode: 0o700 });
      await writeFile(path.join(profileRoot, 'config.json'), `${JSON.stringify({
        profile: OPEN_SPEC_PROFILE,
        delivery: OPEN_SPEC_DELIVERY,
        workflows: OPEN_SPEC_WORKFLOW_IDS
      }, null, 2)}\n`, { mode: 0o600 });
    }
    return await operation(env);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export async function executeFrameworkCommands(
  area: StagingArea,
  plan: ProjectPlan,
  commands: readonly ExternalCommand[],
  runner: CommandRunner,
  options: FrameworkInitializationOptions = {}
): Promise<FrameworkInitializationResult> {
  assertRegisteredFrameworkCommands(plan, commands);
  const before = await captureTreeState(area.root);
  const inventory = frameworkOutputPaths(frameworkSelectionFromPlan(plan));
  assertSafeFrameworkTree(before, inventory);
  const displayed: string[] = [];
  await withFrameworkExecutionEnvironment(area, plan, options.env, async (env) => {
    for (const command of commands) {
      options.onCommand?.(formatCommand(command));
      const result = await runner.run(command, {
        cwd: area.root,
        env,
        timeoutMs: 5 * 60_000,
        stream: true,
        stdout: options.stdout,
        stderr: options.stderr
      });
      displayed.push(result.displayCommand);
      if (result.status !== 0 || result.timedOut) {
        const detail = result.timedOut
          ? 'command timed out'
          : result.stderr.trim().split(/\r?\n/)[0] || `exit status ${result.status}`;
        throw new InitFileSystemError(`Framework initializer failed: ${result.displayCommand}: ${detail}`);
      }
    }
  });

  await assertNoFrameworkGitMetadata(area.root);
  const after = await captureTreeState(area.root);
  assertSafeFrameworkTree(after, inventory);
  assertInventoriedNativeChanges(before, after, inventory);
  const changedPaths = await claimFrameworkChanges(area, before, plan.framework.allowedRoots);
  await validateStagedTree(area);
  const issues = await validateFrameworkInitialization(
    area.root,
    frameworkSelectionFromPlan(plan),
    plan.copilotCloud
  );
  if (issues.length > 0) {
    throw new InitFileSystemError(`Framework initialization did not produce the tested contract:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
  }
  return { commands: displayed, changedPaths };
}

export async function initializeFramework(
  area: StagingArea,
  plan: ProjectPlan,
  runner: CommandRunner,
  options: FrameworkInitializationOptions = {}
): Promise<FrameworkInitializationResult> {
  return executeFrameworkCommands(
    area, plan, frameworkAdapters[plan.specWorkflow.id].buildCommands(plan), runner, options
  );
}
