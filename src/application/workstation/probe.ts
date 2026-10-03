import {
  workstationRequirementCatalog,
  type WorkstationRequirementId
} from '../../workstation-catalog.js';
import { formatCommand, NodeCommandRunner, type CommandResult, type CommandRunner, type RunCommandOptions } from '../../process-runner.js';
import {
  compareVersionCores,
  compareVersions,
  extractVersion
} from '../../domain/workstation/versions.js';
import {
  unavailableExecutableObserver,
  type ExecutableObservationContext,
  type ExecutableObserver
} from '../../domain/workstation/executables.js';
import { nativeExecutableObserver } from '../../adapters/filesystem/executables.js';
import type {
  ExecutableIdentity,
  HostEnvironment,
  ReadinessNotice,
  RequirementProbeResult,
  SelectedRequirement,
  ToolUpdateObservation
} from '../../domain/workstation/contracts.js';
import {
  classifyVersion,
  commandMissing,
  missingResult,
  observed,
  resultWithCause,
  safeDetail,
  unsupportedConstraint
} from '../../domain/workstation/probe-classification.js';
import type { ExternalCommand } from '../../domain/project/contracts.js';

export interface WorkstationProbeOptions extends Pick<RunCommandOptions, 'cwd' | 'env'> {
  host?: HostEnvironment;
  executableObserver?: ExecutableObserver;
  includeHealthNotices?: boolean;
  availableUpdates?: Partial<Record<WorkstationRequirementId, ToolUpdateObservation>>;
}

export function registeredRequirement(requirement: SelectedRequirement): SelectedRequirement {
  const definition = workstationRequirementCatalog[requirement.id];
  const requestedMinimum = requirement.minimumVersion ?? definition.minimumVersion;
  const minimumVersion = requestedMinimum && definition.minimumVersion &&
    extractVersion(requestedMinimum) === requestedMinimum && compareVersionCores(requestedMinimum, definition.minimumVersion) < 0
    ? definition.minimumVersion : requestedMinimum;
  return {
    ...requirement, definition, minimumVersion,
    exactVersion: requirement.exactVersion ?? definition.exactVersion,
    releaseLine: requirement.releaseLine ?? definition.releaseLine,
    allowPrerelease: definition.allowPrerelease === true && requirement.allowPrerelease !== false
  };
}

export function observationContext(
  requirement: SelectedRequirement,
  options: WorkstationProbeOptions
): ExecutableObservationContext {
  return {
    platform: options.host?.platform ?? (process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'),
    cwd: options.cwd ?? process.cwd(),
    env: options.env ? { ...process.env, ...options.env } : process.env,
    definition: requirement.definition
  };
}

export function executableObserver(runner: CommandRunner, options: WorkstationProbeOptions): ExecutableObserver {
  return options.executableObserver ??
    (runner instanceof NodeCommandRunner ? nativeExecutableObserver : unavailableExecutableObserver);
}

export async function runToolCommand(
  runner: CommandRunner,
  command: ExternalCommand,
  options: RunCommandOptions
): Promise<CommandResult> {
  try {
    return await runner.run(command, options);
  } catch (error) {
    const errorCode = error && typeof error === 'object' && 'code' in error &&
      typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
      ? error.code : 'COMMAND_RUNNER_ERROR';
    return {
      command, displayCommand: formatCommand(command), status: null, signal: null,
      stdout: '', stderr: '', timedOut: false, errorCode,
      errorMessage: error instanceof Error ? safeDetail(error.message) : 'The command runner could not complete the observation.'
    };
  }
}

async function runObservedProbe(
  requirement: SelectedRequirement,
  command: ExternalCommand,
  runner: CommandRunner,
  options: WorkstationProbeOptions
): Promise<{ result: CommandResult; identity: ExecutableIdentity }> {
  let identity: ExecutableIdentity;
  try {
    identity = await executableObserver(runner, options)
      .resolve(command.executable, observationContext(requirement, options));
  } catch {
    identity = {
      executable: command.executable, resolution: 'not-observable',
      origin: 'unknown', evidence: 'unavailable'
    };
  }
  const result = await runToolCommand(runner, command, {
    timeoutMs: 15_000, maxOutputBytes: 16_384, cwd: options.cwd, env: options.env
  });
  if (!commandMissing(result) && result.status === 0 && !result.timedOut &&
      !result.outputLimitExceeded && !result.aborted && !result.errorCode && !result.signal) {
    identity = {
      ...identity,
      resolution: 'resolved',
      evidence: identity.resolvedPath ? identity.evidence : 'version-probe'
    };
  }
  return { result, identity };
}

async function probeCommandCandidates(
  requirement: SelectedRequirement,
  runner: CommandRunner,
  options: WorkstationProbeOptions
): Promise<RequirementProbeResult[]> {
  const results: RequirementProbeResult[] = [];
  for (const command of requirement.definition.probes) {
    const { result, identity } = await runObservedProbe(requirement, command, runner, options);
    results.push(observed(classifyVersion(requirement, command, result, identity), command, result));
  }
  return results;
}

async function copilotFallback(
  requirement: SelectedRequirement,
  runner: CommandRunner,
  options: WorkstationProbeOptions
): Promise<RequirementProbeResult> {
  const command = { executable: 'code', args: ['--list-extensions'] };
  const { result, identity } = await runObservedProbe(requirement, command, runner, options);
  if (commandMissing(result) && identity.resolution !== 'resolved') {
    return observed(resultWithCause(requirement, identity, 'observation-unavailable',
      'Copilot CLI and the VS Code CLI are unavailable, so agent presence cannot be observed.', {
        remedy: 'Install the Copilot CLI, or verify that GitHub.copilot or GitHub.copilot-chat is enabled in VS Code.'
      }), command, result);
  }
  if (result.status !== 0 || result.timedOut || result.outputLimitExceeded || result.aborted || result.errorCode || result.signal) {
    return observed(resultWithCause(requirement, identity, 'probe-failed',
      safeDetail(result.stderr) || 'VS Code extension discovery failed.', {
        remedy: 'Run `code --list-extensions` and repair the VS Code CLI before retrying.'
      }), command, result);
  }
  const extensions = result.stdout.toLowerCase().split(/\r?\n/).map((line) => line.trim());
  const installed = extensions.some((id) => id === 'github.copilot' || id === 'github.copilot-chat');
  return observed(installed
    ? resultWithCause(requirement, identity, 'compatible', 'GitHub Copilot is installed as a VS Code extension.', {
        detectedBy: 'code --list-extensions',
        notices: [{
          label: 'GitHub Copilot authentication',
          code: 'authentication',
          state: 'not-observable',
          detail: 'Authentication is managed by the selected editor or agent.',
          remedy: 'Open GitHub Copilot and sign in if prompted.'
        }]
      })
    : missingResult(requirement, identity, 'GitHub Copilot CLI and supported VS Code extensions were not found.'),
  command, result);
}

async function healthNotices(
  requirement: SelectedRequirement,
  runner: CommandRunner,
  options: WorkstationProbeOptions
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
        code: 'authentication',
        state: 'not-observable',
        detail: 'Liftoff does not automate or persist Copilot credentials.',
        remedy: 'Run `copilot` and sign in if prompted.'
      }];
    case 'codex':
      return [{
        label: 'OpenAI Codex authentication',
        code: 'authentication',
        state: 'not-observable',
        detail: 'Authentication remains owned by Codex; Liftoff does not collect or persist credentials.',
        remedy: 'Run `codex` and sign in if prompted.'
      }];
    case 'github-cli':
      command = { executable: 'gh', args: ['auth', 'status'] };
      label = 'GitHub authentication';
      remedy = 'Run `gh auth login` with the required account and scope.';
      break;
    default:
      return [];
  }
  const result = await runToolCommand(runner, command, {
    timeoutMs: 20_000, maxOutputBytes: 16_384, cwd: options.cwd, env: options.env
  });
  const code = requirement.id === 'azure-cli' || requirement.id === 'github-cli' ? 'authentication' : 'health';
  if (result.status === 0 && !result.timedOut && !result.outputLimitExceeded && !result.aborted && !result.errorCode && !result.signal) {
    return [{ label, code, state: 'ready', detail: 'Health probe succeeded.' }];
  }
  return [{
    label,
    code,
    state: 'unhealthy',
    detail: result.timedOut ? 'Health probe timed out.' : safeDetail(result.stderr) || 'Health probe failed.',
    remedy
  }];
}

export async function probeRequirement(
  requirement: SelectedRequirement,
  runner: CommandRunner,
  options: WorkstationProbeOptions = {}
): Promise<RequirementProbeResult> {
  requirement = registeredRequirement(requirement);
  const unsupported = unsupportedConstraint(requirement);
  if (unsupported) {
    return resultWithCause(requirement, {
      executable: requirement.definition.probes[0]?.executable ?? requirement.id,
      resolution: 'not-observable', origin: 'unknown', evidence: 'unavailable'
    }, 'unsupported-constraint', unsupported, {
      remedy: 'Use the registered tested tool constraints; no installation or PATH change can repair an unsupported requirement.'
    });
  }
  const candidates = await probeCommandCandidates(requirement, runner, options);
  const ready = candidates.find((result) => result.state === 'ready');
  if (ready) {
    if (options.includeHealthNotices !== false) {
      ready.notices.push(...await healthNotices(requirement, runner, options));
    }
    const update = options.availableUpdates?.[requirement.id];
    const updateVersion = update ? extractVersion(update.version) : undefined;
    if (update && updateVersion && ready.detectedVersion &&
        compareVersions(updateVersion, ready.detectedVersion) > 0) {
      ready.notices.push({
        code: 'update-available',
        label: `${requirement.definition.label} update`,
        state: 'notice',
        detail: `Version ${updateVersion} is available (${safeDetail(update.source)}); installed ${ready.detectedVersion} remains compatible.`
      });
    }
    ready.observations = candidates.flatMap((candidate) => candidate.observations);
    return ready;
  }
  let fallback: RequirementProbeResult | undefined;
  if (requirement.id === 'github-copilot') {
    fallback = await copilotFallback(requirement, runner, options);
    if (fallback.state === 'ready' || candidates.every((candidate) => candidate.reasonCode === 'missing-executable')) {
      fallback.observations = [...candidates.flatMap((candidate) => candidate.observations), ...fallback.observations];
      return fallback;
    }
  }
  const selected = candidates.find((candidate) => candidate.state === 'outdated') ??
    candidates.find((candidate) => candidate.reasonCode !== 'missing-executable') ?? candidates[0];
  if (!selected) {
    return resultWithCause(requirement, {
      executable: requirement.id, resolution: 'not-observable', origin: 'unknown', evidence: 'unavailable'
    }, 'observation-unavailable', 'No registered version probe is available.');
  }
  selected.observations = [...candidates.flatMap((candidate) => candidate.observations), ...(fallback?.observations ?? [])];
  return selected;
}

export async function probeWorkstation(
  requirements: SelectedRequirement[],
  runner: CommandRunner,
  options: WorkstationProbeOptions = {}
): Promise<RequirementProbeResult[]> {
  return Promise.all(requirements.map((requirement) => probeRequirement(requirement, runner, options)));
}
