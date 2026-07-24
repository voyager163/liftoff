import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  workstationRequirementCatalog,
  type InstallRecipe,
  type LinuxFamily,
  type RequirementSeverity,
  type SupportedPlatform,
  type WorkstationRequirementDefinition,
  type WorkstationRequirementId
} from './workstation-catalog.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from './process-runner.js';
import type {
  ApiStackId,
  CodingAgentId,
  ExternalCommand,
  ProviderId,
  ProjectPlan,
  SpecWorkflowId
} from './types.js';

export type RequirementState = 'ready' | 'missing' | 'outdated' | 'unhealthy' | 'not-observable';

export interface SelectedRequirement {
  id: WorkstationRequirementId;
  definition: WorkstationRequirementDefinition;
  severity: RequirementSeverity;
  reasons: string[];
  minimumVersion?: string;
  exactVersion?: string;
}

export interface ReadinessNotice {
  label: string;
  state: 'ready' | 'unhealthy' | 'not-observable';
  detail: string;
  remedy?: string;
}

export interface RequirementProbeResult {
  requirement: SelectedRequirement;
  state: RequirementState;
  detail: string;
  detectedVersion?: string;
  detectedBy?: string;
  remedy?: string;
  notices: ReadinessNotice[];
}

export interface WorkstationRequirementSelection {
  apiStack: { id: ApiStackId };
  specWorkflow: { id: SpecWorkflowId };
  framework: { version: string };
  provider: { id: ProviderId };
  agents: Array<{ id: CodingAgentId; label: string }>;
}

export interface RequirementSelectionOptions {
  includeFramework?: boolean;
}

export interface HostEnvironment {
  platform: SupportedPlatform;
  linuxFamily: LinuxFamily;
}

export type InstallState =
  | 'installed'
  | 'declined'
  | 'manual'
  | 'failed'
  | 'restart-required';

export interface InstallResult {
  requirement: SelectedRequirement;
  state: InstallState;
  detail: string;
  command?: string;
  probe: RequirementProbeResult;
  remedy?: string;
}

const REQUIREMENT_ORDER: WorkstationRequirementId[] = [
  'node',
  'python',
  'go',
  'uv',
  'docker',
  'opentofu',
  'azure-cli',
  'openspec',
  'spec-kit',
  'github-copilot',
  'claude'
];

const MISSING_ERROR_CODES = new Set(['ENOENT', 'UNKNOWN']);

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function extractVersion(output: string): string | undefined {
  return output.match(/(?:^|[^0-9])v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)(?:[^0-9]|$)/)?.[1];
}

export function selectLiftoffRuntimeRequirements(): SelectedRequirement[] {
  const definition = workstationRequirementCatalog.node;
  return [{
    id: 'node',
    definition,
    severity: definition.severity,
    reasons: ['Liftoff runtime'],
    minimumVersion: '20.19.0'
  }];
}

export function selectWorkstationRequirements(
  plan: ProjectPlan | WorkstationRequirementSelection,
  options: RequirementSelectionOptions = {}
): SelectedRequirement[] {
  const selected = new Map<WorkstationRequirementId, SelectedRequirement>();
  const add = (
    id: WorkstationRequirementId,
    reason: string,
    overrides: { severity?: RequirementSeverity; minimumVersion?: string; exactVersion?: string } = {}
  ) => {
    const definition = workstationRequirementCatalog[id];
    const existing = selected.get(id);
    const minimumVersion = overrides.minimumVersion ?? definition.minimumVersion;
    const exactVersion = overrides.exactVersion ?? definition.exactVersion;
    if (existing) {
      existing.reasons.push(reason);
      if (minimumVersion && (!existing.minimumVersion || compareVersions(minimumVersion, existing.minimumVersion) > 0)) {
        existing.minimumVersion = minimumVersion;
      }
      return;
    }
    selected.set(id, {
      id,
      definition,
      severity: overrides.severity ?? definition.severity,
      reasons: [reason],
      ...(minimumVersion ? { minimumVersion } : {}),
      ...(exactVersion ? { exactVersion } : {})
    });
  };

  add('node', 'Liftoff runtime', { minimumVersion: '20.19.0' });
  if (plan.apiStack.id === 'python-fastapi') {
    add('python', 'selected Python API stack', { minimumVersion: '3.12.0' });
  } else if (plan.apiStack.id === 'go-huma') {
    add('go', 'selected Go API stack', { minimumVersion: '1.23.0' });
  }

  if (plan.specWorkflow.id === 'openspec') {
    add('node', 'OpenSpec runtime', { minimumVersion: '20.19.0' });
    if (options.includeFramework !== false) {
      add('openspec', 'selected spec-driven framework', { exactVersion: plan.framework.version });
    }
  } else {
    add('python', 'Spec Kit runtime', { minimumVersion: '3.11.0' });
    add('uv', 'Spec Kit installer and launcher');
    if (options.includeFramework !== false) {
      add('spec-kit', 'selected spec-driven framework', { exactVersion: plan.framework.version });
    }
  }

  add('docker', 'generated local development stack');
  add('opentofu', 'generated infrastructure');
  if (plan.provider.id === 'azure') {
    add('azure-cli', 'selected Azure cloud');
  }
  for (const agent of plan.agents) {
    add(agent.id, `selected ${agent.label} coding agent`);
  }

  return REQUIREMENT_ORDER.flatMap((id) => {
    const requirement = selected.get(id);
    return requirement ? [requirement] : [];
  });
}

function missingResult(requirement: SelectedRequirement, detail = 'command not found'): RequirementProbeResult {
  return {
    requirement,
    state: 'missing',
    detail,
    remedy: `Install ${requirement.definition.label}.`,
    notices: []
  };
}

function commandMissing(result: CommandResult): boolean {
  return result.errorCode !== undefined && MISSING_ERROR_CODES.has(result.errorCode);
}

async function probeCommandCandidates(
  requirement: SelectedRequirement,
  runner: CommandRunner,
  options: Pick<RunCommandOptions, 'cwd'>
): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const command of requirement.definition.probes) {
    const result = await runner.run(command, { timeoutMs: 15_000, ...options });
    if (!commandMissing(result)) {
      results.push(result);
    }
  }
  return results;
}

async function copilotFallback(
  requirement: SelectedRequirement,
  runner: CommandRunner,
  options: Pick<RunCommandOptions, 'cwd'>
): Promise<RequirementProbeResult> {
  const result = await runner.run(
    { executable: 'code', args: ['--list-extensions'] },
    { timeoutMs: 15_000, ...options }
  );
  if (commandMissing(result)) {
    return {
      requirement,
      state: 'not-observable',
      detail: 'Copilot CLI and the VS Code CLI are unavailable, so agent presence cannot be observed.',
      remedy: 'Install the Copilot CLI, or verify that GitHub.copilot or GitHub.copilot-chat is enabled in VS Code.',
      notices: []
    };
  }
  if (result.status !== 0) {
    return {
      requirement,
      state: 'unhealthy',
      detail: result.stderr.trim() || 'VS Code extension discovery failed.',
      remedy: 'Run `code --list-extensions` and repair the VS Code CLI before retrying.',
      notices: []
    };
  }
  const extensions = result.stdout.toLowerCase().split(/\r?\n/);
  const installed = extensions.some((id) => id === 'github.copilot' || id === 'github.copilot-chat');
  return installed
    ? {
        requirement,
        state: 'ready',
        detail: 'GitHub Copilot is installed as a VS Code extension.',
        detectedBy: 'code --list-extensions',
        notices: [{
          label: 'GitHub Copilot authentication',
          state: 'not-observable',
          detail: 'Authentication is managed by the selected editor or agent.',
          remedy: 'Open GitHub Copilot and sign in if prompted.'
        }]
      }
    : missingResult(requirement, 'GitHub Copilot CLI and supported VS Code extensions were not found.');
}

function classifyVersion(
  requirement: SelectedRequirement,
  command: ExternalCommand,
  result: CommandResult
): RequirementProbeResult {
  if (result.timedOut) {
    return {
      requirement,
      state: 'unhealthy',
      detail: `${command.executable} version probe timed out.`,
      remedy: `Repair ${requirement.definition.label} and retry.`,
      notices: []
    };
  }
  if (result.status !== 0) {
    return {
      requirement,
      state: 'unhealthy',
      detail: result.stderr.trim() || result.errorMessage || `${command.executable} exited with status ${result.status}.`,
      remedy: `Repair ${requirement.definition.label} and retry.`,
      notices: []
    };
  }
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const version = extractVersion(output);
  if ((requirement.minimumVersion || requirement.exactVersion) && !version) {
    return {
      requirement,
      state: 'unhealthy',
      detail: `Unable to parse a version from: ${output || '(empty output)'}`,
      remedy: `Verify ${requirement.definition.label} manually and reinstall it if necessary.`,
      notices: []
    };
  }
  if (version && requirement.exactVersion && compareVersions(version, requirement.exactVersion) !== 0) {
    return {
      requirement,
      state: 'outdated',
      detail: `Found ${version}; Liftoff tested this integration with exactly ${requirement.exactVersion}.`,
      detectedVersion: version,
      detectedBy: command.executable,
      remedy: `Install ${requirement.definition.label} ${requirement.exactVersion}.`,
      notices: []
    };
  }
  if (version && requirement.minimumVersion && compareVersions(version, requirement.minimumVersion) < 0) {
    return {
      requirement,
      state: 'outdated',
      detail: `Found ${version}; version ${requirement.minimumVersion} or newer is required.`,
      detectedVersion: version,
      detectedBy: command.executable,
      remedy: `Upgrade ${requirement.definition.label} to ${requirement.minimumVersion} or newer.`,
      notices: []
    };
  }
  return {
    requirement,
    state: 'ready',
    detail: version ? `Version ${version}` : 'Available',
    ...(version ? { detectedVersion: version } : {}),
    detectedBy: command.executable,
    notices: []
  };
}

async function healthNotices(
  requirement: SelectedRequirement,
  runner: CommandRunner,
  options: Pick<RunCommandOptions, 'cwd'>
): Promise<ReadinessNotice[]> {
  let command: ExternalCommand | undefined;
  let label: string | undefined;
  let remedy: string | undefined;
  switch (requirement.id) {
    case 'docker':
      command = { executable: 'docker', args: ['info', '--format', '{{.ServerVersion}}'] };
      label = 'Docker daemon';
      remedy = 'Start Docker Desktop or the Docker daemon.';
      break;
    case 'azure-cli':
      command = { executable: 'az', args: ['account', 'show', '--output', 'none', '--only-show-errors'] };
      label = 'Azure authentication';
      remedy = 'Run `az login`.';
      break;
    case 'claude':
      command = { executable: 'claude', args: ['doctor'] };
      label = 'Claude Code doctor';
      remedy = 'Run `claude doctor` and resolve the reported setup or authentication issue.';
      break;
    case 'github-copilot':
      return [{
        label: 'GitHub Copilot authentication',
        state: 'not-observable',
        detail: 'Liftoff does not automate or persist Copilot credentials.',
        remedy: 'Run `copilot` and sign in if prompted.'
      }];
    default:
      return [];
  }
  const result = await runner.run(command, { timeoutMs: 20_000, ...options });
  if (result.status === 0) {
    return [{ label, state: 'ready', detail: result.stdout.trim().split(/\r?\n/)[0] || 'Healthy' }];
  }
  return [{
    label,
    state: 'unhealthy',
    detail: result.timedOut ? 'Health probe timed out.' : result.stderr.trim().split(/\r?\n/)[0] || 'Health probe failed.',
    remedy
  }];
}

export async function probeRequirement(
  requirement: SelectedRequirement,
  runner: CommandRunner,
  options: Pick<RunCommandOptions, 'cwd'> = {}
): Promise<RequirementProbeResult> {
  const candidates = await probeCommandCandidates(requirement, runner, options);
  if (candidates.length === 0) {
    return requirement.id === 'github-copilot'
      ? copilotFallback(requirement, runner, options)
      : missingResult(requirement);
  }
  const classified = candidates.map((candidate) =>
    classifyVersion(requirement, candidate.command, candidate)
  );
  const ready = classified.find((result) => result.state === 'ready');
  if (ready) {
    ready.notices = await healthNotices(requirement, runner, options);
    return ready;
  }
  if (requirement.id === 'github-copilot') {
    const fallback = await copilotFallback(requirement, runner, options);
    if (fallback.state === 'ready') {
      return fallback;
    }
  }
  return classified.find((result) => result.state === 'outdated') ?? classified[0]!;
}

export async function probeWorkstation(
  requirements: SelectedRequirement[],
  runner: CommandRunner,
  options: Pick<RunCommandOptions, 'cwd'> = {}
): Promise<RequirementProbeResult[]> {
  return Promise.all(requirements.map((requirement) => probeRequirement(requirement, runner, options)));
}

export function parseLinuxFamily(osRelease: string): LinuxFamily {
  const values = Object.fromEntries(
    osRelease.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      return match ? [[match[1], match[2].replace(/^"|"$/g, '').toLowerCase()]] : [];
    })
  );
  const identity = `${values.ID ?? ''} ${values.ID_LIKE ?? ''}`;
  if (/\b(debian|ubuntu|mint)\b/.test(identity)) {
    return 'debian';
  }
  if (/\b(fedora|rhel|centos|rocky|alma)\b/.test(identity)) {
    return 'fedora';
  }
  if (/\b(arch|manjaro)\b/.test(identity)) {
    return 'arch';
  }
  return 'unknown';
}

export async function detectHostEnvironment(
  platform: NodeJS.Platform = process.platform,
  osReleasePath = '/etc/os-release'
): Promise<HostEnvironment> {
  if (platform === 'darwin' || platform === 'win32') {
    return { platform, linuxFamily: 'unknown' };
  }
  let osRelease = '';
  try {
    osRelease = await readFile(osReleasePath, 'utf8');
  } catch {
    // The exact distribution is optional; unknown still yields a safe manual remedy.
  }
  return { platform: 'linux', linuxFamily: parseLinuxFamily(osRelease) };
}

function installRecipe(
  requirement: SelectedRequirement,
  host: HostEnvironment
): InstallRecipe | undefined {
  const recipe = requirement.definition.install[host.platform];
  if (host.platform !== 'linux') {
    return recipe;
  }
  return recipe && (recipe.manager === 'npm' || recipe.manager === 'uv') ? recipe : undefined;
}

async function managerAvailable(
  recipe: InstallRecipe,
  runner: CommandRunner,
  options: Pick<RunCommandOptions, 'cwd'>
): Promise<boolean> {
  const result = await runner.run(
    { executable: recipe.command.executable, args: ['--version'] },
    { timeoutMs: 10_000, ...options }
  );
  return !commandMissing(result) && result.status === 0;
}

function pathRemedy(recipe: InstallRecipe, requirement: SelectedRequirement): string {
  const executable = requirement.definition.probes[0]?.executable ?? requirement.id;
  switch (recipe.manager) {
    case 'brew':
      return `Run \`brew --prefix\`, ensure its bin directory is on PATH, open a new terminal, then retry ${executable}.`;
    case 'winget':
      return `Open a new terminal and retry ${executable}; if it is still missing, inspect the WinGet package installation and PATH aliases.`;
    case 'npm':
      return `Run \`npm prefix -g\`, add that installation's bin directory to PATH, open a new terminal, then retry ${executable}.`;
    case 'uv':
      return `Run \`uv tool dir --bin\`, add that directory to PATH, open a new terminal, then retry ${executable}.`;
  }
}

async function documentedInstallLocations(
  recipe: InstallRecipe,
  requirement: SelectedRequirement,
  context: {
    host: HostEnvironment;
    runner: CommandRunner;
    cwd?: string;
  }
): Promise<string[]> {
  let binDirectories: string[] = [];
  if (recipe.manager === 'winget') {
    if (process.env.LOCALAPPDATA) {
      binDirectories = [path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps')];
    }
  } else {
    const locationCommand: ExternalCommand = recipe.manager === 'npm'
      ? { executable: recipe.command.executable, args: ['prefix', '-g'] }
      : recipe.manager === 'uv'
        ? { executable: recipe.command.executable, args: ['tool', 'dir', '--bin'] }
        : { executable: recipe.command.executable, args: ['--prefix'] };
    const location = await context.runner.run(locationCommand, {
      cwd: context.cwd,
      timeoutMs: 10_000
    });
    if (location.status === 0 && location.stdout.trim()) {
      const root = location.stdout.trim().split(/\r?\n/)[0];
      binDirectories = recipe.manager === 'npm' && context.host.platform !== 'win32'
        ? [path.join(root, 'bin')]
        : recipe.manager === 'brew'
          ? [path.join(root, 'bin')]
          : [root];
    }
  }

  const extensions = context.host.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  const candidates = new Set<string>();
  for (const directory of binDirectories) {
    for (const probe of requirement.definition.probes) {
      for (const extension of extensions) {
        candidates.add(path.join(directory, `${probe.executable}${extension}`));
      }
    }
  }
  const found: string[] = [];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      found.push(candidate);
    } catch {
      // Candidate locations are best-effort diagnostics after a successful installer.
    }
  }
  return found;
}

function manualRemedy(requirement: SelectedRequirement, host: HostEnvironment): string {
  return host.platform === 'linux'
    ? requirement.definition.linuxRemedies[host.linuxFamily]
    : `Install ${requirement.definition.label} manually and retry.`;
}

export async function installRequirement(
  requirement: SelectedRequirement,
  currentProbe: RequirementProbeResult,
  context: {
    authorized: boolean;
    host: HostEnvironment;
    runner: CommandRunner;
    cwd?: string;
    streamOptions?: Pick<RunCommandOptions, 'stdout' | 'stderr'>;
  }
): Promise<InstallResult> {
  if (!context.authorized) {
    return {
      requirement,
      state: 'declined',
      detail: 'Installation was not authorized.',
      probe: currentProbe,
      remedy: currentProbe.remedy
    };
  }

  const recipe = installRecipe(requirement, context.host);
  if (!recipe) {
    return {
      requirement,
      state: 'manual',
      detail: `Liftoff does not automate ${requirement.definition.label} installation on this host.`,
      probe: currentProbe,
      remedy: manualRemedy(requirement, context.host)
    };
  }
  if (!await managerAvailable(recipe, context.runner, { cwd: context.cwd })) {
    return {
      requirement,
      state: 'manual',
      detail: `${recipe.manager} is unavailable and Liftoff does not bootstrap package managers.`,
      probe: currentProbe,
      remedy: `Install ${recipe.manager} through its official instructions, then retry.`
    };
  }

  const result = await context.runner.run(recipe.command, {
    cwd: context.cwd,
    timeoutMs: 10 * 60_000,
    stream: true,
    ...context.streamOptions
  });
  if (result.status !== 0 || result.timedOut) {
    return {
      requirement,
      state: 'failed',
      detail: result.timedOut
        ? `${requirement.definition.label} installation timed out.`
        : result.stderr.trim().split(/\r?\n/)[0] || `Installer exited with status ${result.status}.`,
      command: result.displayCommand,
      probe: currentProbe,
      remedy: manualRemedy(requirement, context.host)
    };
  }

  const nextProbe = await probeRequirement(requirement, context.runner, { cwd: context.cwd });
  if (nextProbe.state !== 'ready') {
    const foundLocations = await documentedInstallLocations(recipe, requirement, context);
    return {
      requirement,
      state: 'restart-required',
      detail: foundLocations.length > 0
        ? `The installer succeeded and wrote ${foundLocations.join(', ')}, but the command is not ready on PATH in this process.`
        : 'The installer succeeded, but the required command is not ready in this process after checking its documented install location.',
      command: result.displayCommand,
      probe: nextProbe,
      remedy: pathRemedy(recipe, requirement)
    };
  }
  return {
    requirement,
    state: 'installed',
    detail: `${requirement.definition.label} is ready.`,
    command: result.displayCommand,
    probe: nextProbe
  };
}

export function blockingReadinessFailures(results: RequirementProbeResult[]): RequirementProbeResult[] {
  return results.filter((result) =>
    result.requirement.severity === 'blocking' && result.state !== 'ready'
  );
}
