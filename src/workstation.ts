import { readFile } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { packagedSupportedStack as supportedStack } from './adapters/packaged-assets/supported-stack.js';
import {
  workstationRequirementCatalog,
  type InstallRecipe,
  type LinuxFamily,
  type RequirementSeverity,
  type SupportedPlatform,
  type WorkstationRequirementDefinition,
  type WorkstationRequirementId,
  type RemediationRecipe
} from './workstation-catalog.js';
import { formatCommand, NodeCommandRunner, type CommandResult, type CommandRunner, type RunCommandOptions } from './process-runner.js';
import {
  compareVersionCores,
  compareVersions,
  extractVersion,
  isPrereleaseVersion,
  matchesReleaseLine
} from './domain/workstation/versions.js';
import {
  environmentValue,
  hostPath,
  unavailableExecutableObserver,
  type ExecutableObservationContext,
  type ExecutableObserver
} from './domain/workstation/executables.js';
import { nativeExecutableObserver } from './adapters/filesystem/executables.js';
import type { VersionConstraint } from './domain/workstation/constraints.js';
import type {
  ExecutableIdentity,
  NoProgressRemediationAttempt,
  RemediationAttempt,
  RemediationProgress,
  RequirementReasonCode,
  ToolProbeObservation,
  ToolUpdateObservation,
  WorkstationScope,
  WorkstationNoProgressStore
} from './domain/workstation/contracts.js';
import { canonicalSha256 } from './domain/governance/activation/canonical-json.js';
import type {
  ApiStackId,
  CodingAgentId,
  ExternalCommand,
  ProviderId,
  ProjectPlan,
  SpecWorkflowId
} from './domain/project/contracts.js';

export { extractVersion } from './domain/workstation/versions.js';
export { nativeExecutableObserver } from './adapters/filesystem/executables.js';
export type { ExecutableObserver, ExecutableObservationContext } from './domain/workstation/executables.js';
export type { RemediationRecipe } from './workstation-catalog.js';
export type {
  ExecutableIdentity,
  InstallationOrigin,
  NoProgressRemediationAttempt,
  RemediationAttempt,
  RemediationOperation,
  RemediationProgress,
  RequirementReasonCode,
  ToolProbeObservation,
  ToolUpdateObservation,
  WorkstationScope,
  WorkstationNoProgressStore
} from './domain/workstation/contracts.js';

export type RequirementState = 'ready' | 'missing' | 'outdated' | 'unhealthy' | 'not-observable';

export interface SelectedRequirement {
  id: WorkstationRequirementId;
  definition: WorkstationRequirementDefinition;
  severity: RequirementSeverity;
  reasons: string[];
  minimumVersion?: string;
  exactVersion?: string;
  releaseLine?: string;
  allowPrerelease?: boolean;
  scope?: WorkstationScope;
}

export interface ReadinessNotice {
  label: string;
  state: 'ready' | 'unhealthy' | 'not-observable' | 'notice';
  detail: string;
  remedy?: string;
  code?: 'preview-channel' | 'update-available' | 'authentication' | 'health';
}

export interface RequirementProbeResult {
  requirement: SelectedRequirement;
  state: RequirementState;
  detail: string;
  detectedVersion?: string;
  detectedBy?: string;
  remedy?: string;
  notices: ReadinessNotice[];
  reasonCode: RequirementReasonCode;
  identity: ExecutableIdentity;
  required: VersionConstraint;
  observations: ToolProbeObservation[];
  remediationAttempts?: RemediationAttempt[];
}

export type WorkstationWorkloadSelection =
  | {
      kind: 'genai' | 'standard';
      apiStack: { id: ApiStackId };
      provider: { id: ProviderId };
      frontend?: boolean;
    }
  | {
      kind: 'components';
      components?: Array<{
        id: string;
        profileId?: string;
      }>;
      provider?: { id: ProviderId };
    };

export interface WorkstationRequirementSelection {
  workload: WorkstationWorkloadSelection;
  specWorkflow: { id: SpecWorkflowId };
  framework: { version: string };
  agents: Array<{ id: CodingAgentId; label: string }>;
}

export interface RequirementSelectionOptions {
  includeFramework?: boolean;
  scope?: WorkstationScope;
  requiredTools?: readonly WorkstationRequirementId[];
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
  | 'restart-required'
  | 'unchanged'
  | 'unresolved'
  | 'not-needed';

export interface WorkstationProbeOptions extends Pick<RunCommandOptions, 'cwd' | 'env'> {
  host?: HostEnvironment;
  executableObserver?: ExecutableObserver;
  includeHealthNotices?: boolean;
  availableUpdates?: Partial<Record<WorkstationRequirementId, ToolUpdateObservation>>;
}

export interface RemediationSelection {
  state: 'available' | 'manual' | 'not-needed';
  reasonCode: RequirementReasonCode;
  detail: string;
  remedy?: string;
  recipe?: RemediationRecipe;
}

export interface InstallContext extends WorkstationProbeOptions {
  authorized: boolean;
  host: HostEnvironment;
  runner: CommandRunner;
  streamOptions?: Pick<RunCommandOptions, 'stdout' | 'stderr'>;
  approvedRemediationId?: string;
  previousAttempts?: readonly RemediationAttempt[];
  noProgressStore?: WorkstationNoProgressStore;
}

export interface InstallResult {
  requirement: SelectedRequirement;
  state: InstallState;
  detail: string;
  command?: string;
  probe: RequirementProbeResult;
  remedy?: string;
  reasonCode: 'verified' | 'not-authorized' | 'recipe-unavailable' | 'manager-unavailable' |
    'review-required' | 'execution-failed' | 'no-progress' | 'verification-unresolved' | 'executable-discovery' |
    'history-storage-failed';
  historyError?: 'lookup' | 'record';
  progress?: RemediationProgress;
  attempt?: RemediationAttempt;
  recipe?: RemediationRecipe;
  discovery?: { checkedLocations: string[]; found: ExecutableIdentity[]; complete: boolean };
}

const REQUIREMENT_ORDER: WorkstationRequirementId[] = [
  'node',
  'npm',
  'python',
  'go',
  'uv',
  'docker',
  'opentofu',
  'azure-cli',
  'openspec',
  'spec-kit',
  'github-copilot',
  'claude',
  'codex',
  'github-cli'
];

const MISSING_ERROR_CODES = new Set(['ENOENT']);

export function selectLiftoffRuntimeRequirements(): [SelectedRequirement] {
  const definition = workstationRequirementCatalog.node;
  return [{
    id: 'node',
    definition,
    severity: definition.severity,
    reasons: ['Liftoff runtime'],
    minimumVersion: definition.minimumVersion,
    releaseLine: definition.releaseLine,
    allowPrerelease: definition.allowPrerelease ?? false
  }];
}

export function observeLiftoffRuntime(): RequirementProbeResult {
  const [requirement] = selectLiftoffRuntimeRequirements();
  const identity: ExecutableIdentity = {
    executable: process.execPath, resolvedPath: process.execPath, resolution: 'resolved',
    kind: 'executable', origin: 'unknown', evidence: 'documented-location'
  };
  const version = extractVersion(process.versions.node, 'node');
  if (!version) {
    return resultWithCause(requirement, identity, 'version-unparseable',
      'The running CLI process has no interpretable Node runtime version.');
  }
  const result = classifyVersionValue(requirement, version, process.execPath, identity);
  return {
    ...result,
    detail: result.state === 'ready'
      ? `Running CLI Node ${version}; this is not a project toolchain probe`
      : `Running CLI Node ${version}: ${result.detail}`,
    ...(result.state === 'ready' ? {} : {
      remedy: 'Use a supported Liftoff bundle or its declared contributor runtime; native runtime replacement is owner-specific.'
    })
  };
}

export function selectWorkstationRequirements(
  plan: ProjectPlan | WorkstationRequirementSelection,
  options: RequirementSelectionOptions = {}
): SelectedRequirement[] {
  const scope = options.scope ?? 'initialization';
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
      if (overrides.severity === 'blocking') existing.severity = 'blocking';
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
      ...(exactVersion ? { exactVersion } : {}),
      ...(definition.releaseLine ? { releaseLine: definition.releaseLine } : {}),
      allowPrerelease: definition.allowPrerelease ?? false,
      scope
    });
  };

  if (typeof plan.workload === 'object' && plan.workload.kind === 'components') {
    add('node', 'Liftoff runtime', {
      minimumVersion: supportedStack.runtimes.node.minimumVersion
    });
    const components = plan.workload.components ?? [];
    const hasVue = components.some((c) =>
      c.profileId === 'vue-component' || c.profileId === 'frontend' || c.id === 'frontend' || c.id === 'vue'
    );
    const hasPython = components.some((c) =>
      c.profileId === 'python-fastapi' || (c.profileId?.startsWith('genai-') ?? false)
    );
    const hasGo = components.some((c) => c.profileId === 'go-huma');
    const hasNodeApi = components.some((c) => c.profileId === 'node-fastify');

    if (hasVue || hasNodeApi || components.length === 0) {
      add('npm', 'selected frontend dependency manager');
    }
    if (hasPython) {
      add('python', 'selected Python component stack', {
        minimumVersion: supportedStack.runtimes.python.minimumVersion
      });
      add('uv', 'locked Python dependency manager');
    }
    if (hasGo) {
      add('go', 'selected Go component stack', {
        minimumVersion: supportedStack.runtimes.go.minimumVersion
      });
    }

    if (plan.specWorkflow.id === 'openspec') {
      add('npm', 'OpenSpec installer and launcher');
      add('node', 'OpenSpec runtime', {
        minimumVersion: supportedStack.runtimes.node.minimumVersion
      });
      if (options.includeFramework !== false) {
        add('openspec', 'selected spec-driven framework', { exactVersion: plan.framework.version });
      }
    } else {
      add('python', 'Spec Kit runtime', {
        minimumVersion: supportedStack.runtimes.python.minimumVersion
      });
      add('uv', 'Spec Kit installer and launcher');
      if (options.includeFramework !== false) {
        add('spec-kit', 'selected spec-driven framework', { exactVersion: plan.framework.version });
      }
    }

    if (plan.workload.provider?.id === 'azure') {
      add('azure-cli', 'selected Azure cloud');
    }
    for (const agent of plan.agents) {
      add(agent.id, `selected ${agent.label} coding agent`);
    }
    for (const id of options.requiredTools ?? []) add(id, `required ${scope} operation`, { severity: 'blocking' });

    return REQUIREMENT_ORDER.flatMap((id) => {
      const requirement = selected.get(id);
      return requirement ? [requirement] : [];
    });
  }

  const workload = typeof plan.workload === 'string'
    ? {
        kind: plan.workload,
        apiStack: { id: plan.apiStack.id },
        provider: { id: plan.provider.id }
      }
    : plan.workload;
  const includeFrontend = typeof plan.workload === 'string'
    ? plan.includeFrontend
    : plan.workload.frontend ?? false;
  add('node', 'Liftoff runtime', {
    minimumVersion: supportedStack.runtimes.node.minimumVersion
  });
  if (scope === 'activation' || scope === 'migration' || scope === 'lifecycle') {
    if (scope !== 'lifecycle') add('opentofu', `${scope} infrastructure operations`, { severity: 'blocking' });
    if (scope === 'activation') {
      add('github-cli', 'approved GitHub activation operations', { severity: 'blocking' });
      if (workload.provider.id === 'azure') add('azure-cli', 'approved Azure activation operations', { severity: 'blocking' });
    }
    for (const id of options.requiredTools ?? []) add(id, `required ${scope} operation`, { severity: 'blocking' });
    return REQUIREMENT_ORDER.flatMap((id) => selected.has(id) ? [selected.get(id)!] : []);
  }
  if (workload.apiStack.id === 'node-fastify') {
    add('npm', 'selected Node.js API dependency manager');
  }
  if (includeFrontend) {
    add('npm', 'selected frontend dependency manager');
  }
  if (workload.apiStack.id === 'python-fastapi') {
    add('python', 'selected Python API stack', {
      minimumVersion: supportedStack.runtimes.python.minimumVersion
    });
    add('uv', 'locked Python dependency manager');
  } else if (workload.apiStack.id === 'go-huma') {
    add('go', 'selected Go API stack', {
      minimumVersion: supportedStack.runtimes.go.minimumVersion
    });
  }

  if (plan.specWorkflow.id === 'openspec') {
    add('npm', 'OpenSpec installer and launcher');
    add('node', 'OpenSpec runtime', {
      minimumVersion: supportedStack.runtimes.node.minimumVersion
    });
    if (options.includeFramework !== false) {
      add('openspec', 'selected spec-driven framework', { exactVersion: plan.framework.version });
    }
  } else {
    add('python', 'Spec Kit runtime', {
      minimumVersion: supportedStack.runtimes.python.minimumVersion
    });
    add('uv', 'Spec Kit installer and launcher');
    if (options.includeFramework !== false) {
      add('spec-kit', 'selected spec-driven framework', { exactVersion: plan.framework.version });
    }
  }

  add('docker', scope === 'local' ? 'local Docker Compose configuration check' : 'generated local development stack',
    { severity: scope === 'local' ? 'blocking' : 'advisory' });
  add('opentofu', scope === 'local' ? 'local backend-disabled infrastructure checks' : 'generated infrastructure',
    { severity: scope === 'local' ? 'blocking' : 'advisory' });
  if (scope === 'initialization' && workload.provider.id === 'azure') {
    add('azure-cli', 'selected Azure cloud');
  }
  for (const agent of plan.agents) {
    add(agent.id, `selected ${agent.label} coding agent`);
  }
  for (const id of options.requiredTools ?? []) add(id, `required ${scope} operation`, { severity: 'blocking' });

  return REQUIREMENT_ORDER.flatMap((id) => {
    const requirement = selected.get(id);
    return requirement ? [requirement] : [];
  });
}

function commandMissing(result: CommandResult): boolean {
  return result.errorCode !== undefined && MISSING_ERROR_CODES.has(result.errorCode);
}

function requiredConstraint(requirement: SelectedRequirement): VersionConstraint {
  return {
    ...(requirement.minimumVersion ? { minimumVersion: requirement.minimumVersion } : {}),
    ...(requirement.exactVersion ? { exactVersion: requirement.exactVersion } : {}),
    ...(requirement.releaseLine ? { releaseLine: requirement.releaseLine } : {}),
    allowPrerelease: requirement.allowPrerelease ?? false
  };
}

function registeredRequirement(requirement: SelectedRequirement): SelectedRequirement {
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

function unsupportedConstraint(requirement: SelectedRequirement): string | undefined {
  for (const field of ['minimumVersion', 'exactVersion'] as const) {
    if (requirement[field] !== undefined && extractVersion(requirement[field]!) !== requirement[field]) {
      return `The requested ${field} is not a supported version constraint.`;
    }
  }
  if (requirement.definition.exactVersion && requirement.exactVersion !== requirement.definition.exactVersion) {
    return `The registered ${requirement.definition.label} pin is ${requirement.definition.exactVersion}; another requested pin is unsupported.`;
  }
  if (requirement.releaseLine !== undefined && (!/^\d+(?:\.\d+)*$/.test(requirement.releaseLine) ||
      (requirement.definition.releaseLine && requirement.releaseLine !== requirement.definition.releaseLine))) {
    return `The requested release line does not match the registered ${requirement.definition.label} constraint.`;
  }
  return undefined;
}

function observationContext(
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

function executableObserver(runner: CommandRunner, options: WorkstationProbeOptions): ExecutableObserver {
  return options.executableObserver ??
    (runner instanceof NodeCommandRunner ? nativeExecutableObserver : unavailableExecutableObserver);
}

function safeDetail(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, '<redacted>')
    .replace(/\b(?:authorization|password|secret|token)\s*[:=]\s*\S+/gi, '<redacted>')
    .split(/\r?\n/, 1)[0]!.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 600);
}

async function runToolCommand(
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

function resultWithCause(
  requirement: SelectedRequirement,
  identity: ExecutableIdentity,
  reasonCode: RequirementReasonCode,
  detail: string,
  fields: Partial<Pick<RequirementProbeResult, 'detectedBy' | 'detectedVersion' | 'remedy' | 'notices'>> = {}
): RequirementProbeResult {
  const states: Record<RequirementReasonCode, RequirementState> = {
    compatible: 'ready',
    'missing-executable': 'missing',
    'observation-unavailable': 'not-observable',
    'probe-failed': 'unhealthy',
    'version-unparseable': 'unhealthy',
    'unsupported-constraint': 'not-observable',
    'below-minimum': 'outdated',
    'release-line-mismatch': 'outdated',
    'exact-version-mismatch': 'outdated',
    'incompatible-channel': 'outdated'
  };
  return {
    requirement,
    state: states[reasonCode],
    reasonCode,
    detail,
    identity,
    required: requiredConstraint(requirement),
    observations: [],
    notices: [],
    ...fields
  };
}

function missingResult(
  requirement: SelectedRequirement,
  identity: ExecutableIdentity,
  detail = 'command not found'
): RequirementProbeResult {
  return resultWithCause(requirement, identity, 'missing-executable', detail, {
    remedy: requirement.definition.missingRemedy ?? `Install ${requirement.definition.label}.`
  });
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

function observed(
  classified: RequirementProbeResult,
  command: ExternalCommand,
  result: CommandResult
): RequirementProbeResult {
  classified.observations = [{
    command,
    identity: classified.identity,
    status: result.status,
    timedOut: result.timedOut,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    reasonCode: classified.reasonCode,
    ...(classified.detectedVersion ? { detectedVersion: classified.detectedVersion } : {})
  }];
  return classified;
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

function classifyVersion(
  requirement: SelectedRequirement,
  command: ExternalCommand,
  result: CommandResult,
  identity: ExecutableIdentity
): RequirementProbeResult {
  if (commandMissing(result) && identity.resolution !== 'resolved') {
    return missingResult(requirement, { ...identity, resolution: 'missing' },
      safeDetail(result.stderr || result.errorMessage || '') || 'command not found');
  }
  if (result.timedOut) {
    return resultWithCause(requirement, identity, 'probe-failed', `${command.executable} version probe timed out.`, {
      remedy: `Repair ${requirement.definition.label} and retry.`
    });
  }
  if (result.status !== 0 || result.outputLimitExceeded || result.aborted || result.errorCode || result.signal) {
    return resultWithCause(requirement, identity, 'probe-failed',
      result.outputLimitExceeded ? `${command.executable} version probe exceeded the output limit.` :
        safeDetail(result.stderr || result.errorMessage || '') || `${command.executable} exited with status ${result.status}.`, {
        remedy: `Repair ${requirement.definition.label} and retry.`
      });
  }
  const output = requirement.id === 'azure-cli' ? result.stdout.trim() : `${result.stdout}\n${result.stderr}`.trim();
  const version = extractVersion(output, requirement.id);
  if (!version) {
    return resultWithCause(requirement, identity, 'version-unparseable',
      `Unable to parse a supported ${requirement.definition.label} version from the successful probe output.`, {
        detectedBy: command.executable,
        remedy: `Verify the ${requirement.definition.label} executable and its version output before selecting a remedy.`
      });
  }
  return classifyVersionValue(requirement, version, command.executable, identity);
}

function classifyVersionValue(
  requirement: SelectedRequirement,
  version: string,
  executable: string,
  identity: ExecutableIdentity
): RequirementProbeResult {
  const detected = { detectedVersion: version, detectedBy: executable };
  if (
    version &&
    !requirement.allowPrerelease &&
    isPrereleaseVersion(version)
  ) {
    return resultWithCause(requirement, identity, 'incompatible-channel',
      `Found prerelease ${version}; a stable release is required.`, {
      ...detected,
      remedy: requirement.exactVersion
        ? `Install ${requirement.definition.label} ${requirement.exactVersion}.`
        : `Install a stable ${requirement.definition.label} release${requirement.releaseLine ? ` in the supported ${requirement.releaseLine} line` : ''}.`
    });
  }
  if (
    version &&
    requirement.releaseLine &&
    !matchesReleaseLine(version, requirement.releaseLine)
  ) {
    return resultWithCause(requirement, identity, 'release-line-mismatch',
      `Found ${version}; the supported release line is ${requirement.releaseLine}.`, {
      ...detected,
      remedy: requirement.exactVersion
        ? `Install ${requirement.definition.label} ${requirement.exactVersion}.`
        : `Install ${requirement.definition.label} ${requirement.releaseLine}.x at or above ${requirement.minimumVersion}.`
    });
  }
  if (requirement.exactVersion && compareVersionCores(version, requirement.exactVersion) !== 0) {
    return resultWithCause(requirement, identity, 'exact-version-mismatch',
      `Found ${version}; Liftoff tested this integration with exactly ${requirement.exactVersion}.`, {
      ...detected, remedy: `Install ${requirement.definition.label} ${requirement.exactVersion}.`
    });
  }
  if (requirement.minimumVersion && compareVersionCores(version, requirement.minimumVersion) < 0) {
    return resultWithCause(requirement, identity, 'below-minimum',
      `Found ${version}; version ${requirement.minimumVersion} or newer is required.`, {
      ...detected, remedy: `Upgrade ${requirement.definition.label} to ${requirement.minimumVersion} or newer.`
    });
  }
  return resultWithCause(requirement, identity, 'compatible', `Version ${version}`, {
    ...detected,
    notices: isPrereleaseVersion(version) ? [{
      code: 'preview-channel',
      label: `${requirement.definition.label} release channel`,
      state: 'notice',
      detail: `Compatible preview ${version}; a stable-channel downgrade is not required.`
    }] : []
  });
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

export function selectRemediation(
  requirement: SelectedRequirement,
  probe: RequirementProbeResult,
  host: HostEnvironment,
  requestedRecipeId?: string
): RemediationSelection {
  requirement = registeredRequirement(requirement);
  const definition = workstationRequirementCatalog[requirement.id];
  const matchingRequirement = probe.requirement.id === requirement.id &&
    JSON.stringify(requiredConstraint(probe.requirement)) === JSON.stringify(requiredConstraint(requirement)) &&
    !unsupportedConstraint(requirement);
  if (matchingRequirement && probe.state === 'ready' && probe.reasonCode === 'compatible') {
    return { state: 'not-needed', reasonCode: 'compatible', detail: `${requirement.definition.label} is already compatible.` };
  }
  const recipes = matchingRequirement && requirement.exactVersion === definition.exactVersion
    ? definition.remedies ?? []
    : [];
  const recipe = recipes.find((candidate) =>
    (!requestedRecipeId || candidate.id === requestedRecipeId) &&
    candidate.platforms.includes(host.platform) &&
    candidate.causes.includes(probe.reasonCode) &&
    candidate.origins.includes(probe.identity?.origin ?? 'unknown') &&
    (host.platform !== 'linux' || candidate.manager === 'npm' || candidate.manager === 'uv') &&
    !(candidate.operation === 'upgrade' && requirement.exactVersion &&
      (!probe.detectedVersion || compareVersions(probe.detectedVersion, requirement.exactVersion) >= 0))
  );
  if (recipe) {
    return {
      state: 'available',
      reasonCode: probe.reasonCode,
      detail: `${recipe.operation} ${definition.label} using its registered ${recipe.manager} recipe.`,
      recipe
    };
  }
  return {
    state: 'manual',
    reasonCode: probe.reasonCode,
    detail: `No safe automatic ${definition.label} remedy is registered for ${probe.reasonCode ?? 'an unknown cause'} ` +
      `from ${probe.identity?.origin ?? 'an unobserved installation origin'} on ${host.platform}.`,
    remedy: `${probe.remedy ? `${probe.remedy} ` : ''}${manualRemedy(requirement, host)} ` +
      'Review the installation origin and required version/channel; Liftoff will not uninstall, downgrade, or repeat a missing-tool installer to guess a repair.'
  };
}

async function managerAvailable(
  recipe: InstallRecipe,
  runner: CommandRunner,
  options: WorkstationProbeOptions
): Promise<boolean> {
  if (recipe.manager === 'npm' || recipe.manager === 'uv') {
    const definition = workstationRequirementCatalog[recipe.manager];
    const probe = await probeRequirement({
      id: definition.id, definition, severity: 'blocking', reasons: ['registered remedy prerequisite'],
      minimumVersion: definition.minimumVersion, releaseLine: definition.releaseLine,
      allowPrerelease: definition.allowPrerelease ?? false
    }, runner, { ...options, includeHealthNotices: false });
    return probe.state === 'ready';
  }
  const result = await runToolCommand(runner,
    { executable: recipe.command.executable, args: ['--version'] },
    { timeoutMs: 10_000, maxOutputBytes: 16_384, cwd: options.cwd, env: options.env }
  );
  return !result.errorCode && result.status === 0 && !result.timedOut &&
    !result.outputLimitExceeded && !result.aborted && !result.signal;
}

function pathRemedy(recipe: InstallRecipe, requirement: SelectedRequirement): string {
  const executable = requirement.definition.probes[0]?.executable ?? requirement.id;
  switch (recipe.manager) {
    case 'brew':
      return `Run \`brew --prefix${requirement.definition.packageIdentities?.brew?.includes('@') ? ` ${requirement.definition.packageIdentities.brew}` : ''}\`, ensure its bin directory is on PATH, open a new terminal, then retry ${executable}.`;
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
  context: InstallContext
): Promise<NonNullable<InstallResult['discovery']>> {
  const nativePath = hostPath(context.host.platform);
  const observerContext = observationContext(requirement, context);
  const observer = executableObserver(context.runner, context);
  let binDirectories: string[] = [];
  if (recipe.manager === 'winget') {
    const localAppData = environmentValue(observerContext.env, 'LOCALAPPDATA', context.host.platform);
    if (localAppData && !/[\u0000-\u001f\u007f]/.test(localAppData) && nativePath.isAbsolute(localAppData)) {
      binDirectories = [
        nativePath.join(localAppData, 'Microsoft', 'WindowsApps'),
        nativePath.join(localAppData, 'Microsoft', 'WinGet', 'Links')
      ];
    }
  } else {
    const locationCommand: ExternalCommand = recipe.manager === 'npm'
      ? { executable: recipe.command.executable, args: ['prefix', '-g'] }
      : recipe.manager === 'uv'
        ? { executable: recipe.command.executable, args: ['tool', 'dir', '--bin'] }
        : {
            executable: recipe.command.executable,
            args: [
              '--prefix',
              ...(requirement.definition.packageIdentities?.brew?.includes('@') ? [requirement.definition.packageIdentities.brew] : [])
            ]
          };
    const location = await runToolCommand(context.runner, locationCommand, {
      cwd: context.cwd,
      env: context.env,
      timeoutMs: 10_000,
      maxOutputBytes: 16_384
    });
    const root = location.stdout.trim();
    if (location.status === 0 && !location.timedOut && !location.outputLimitExceeded &&
        !location.aborted && !location.errorCode && !location.signal &&
        !/[\u0000-\u001f\u007f]/.test(root) && nativePath.isAbsolute(root)) {
      binDirectories = recipe.manager === 'brew' || (recipe.manager === 'npm' && context.host.platform !== 'win32')
        ? [nativePath.join(root, 'bin')]
        : [root];
    }
  }

  const extensions = context.host.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com'] : [''];
  const candidates = new Set<string>();
  for (const directory of binDirectories) {
    for (const probe of requirement.definition.probes) {
      for (const extension of extensions) {
        candidates.add(nativePath.join(directory, `${probe.executable}${extension}`));
      }
    }
  }
  const found: ExecutableIdentity[] = [];
  let complete = candidates.size > 0;
  for (const candidate of candidates) {
    try {
      const identity = await observer.inspect(candidate, observerContext);
      if (identity.resolution === 'resolved') found.push(identity);
      else if (identity.resolution === 'not-observable') complete = false;
    } catch {
      complete = false;
    }
  }
  return { checkedLocations: [...candidates], found, complete };
}

function manualRemedy(requirement: SelectedRequirement, host: HostEnvironment): string {
  return host.platform === 'linux'
    ? requirement.definition.linuxRemedies[host.linuxFamily]
    : `Install ${requirement.definition.label} manually and retry.`;
}

const attemptsByRunner = new WeakMap<CommandRunner, RemediationAttempt[]>();

function fingerprintIdentity(identity: ExecutableIdentity) {
  return {
    executable: identity.executable, resolution: identity.resolution,
    resolvedPath: identity.resolvedPath ?? null, realPath: identity.realPath ?? null,
    kind: identity.kind ?? null, origin: identity.origin, evidence: identity.evidence
  };
}

function observationFingerprint(probe: RequirementProbeResult): string {
  return canonicalSha256({
    id: probe.requirement.id,
    required: requiredConstraint(probe.requirement),
    state: probe.state,
    reasonCode: probe.reasonCode,
    identity: fingerprintIdentity(probe.identity),
    detectedVersion: probe.detectedVersion ?? null,
    observations: probe.observations.map((observation) => ({
      command: { executable: observation.command.executable, args: observation.command.args },
      identity: fingerprintIdentity(observation.identity),
      status: observation.status,
      timedOut: observation.timedOut,
      errorCode: observation.errorCode ?? null,
      reasonCode: observation.reasonCode,
      detectedVersion: observation.detectedVersion ?? null
    }))
  });
}

function attemptFingerprint(
  probe: RequirementProbeResult,
  recipe: RemediationRecipe,
  context: InstallContext
): string {
  const observation = observationContext(probe.requirement, context);
  const managerVariables: Record<InstallRecipe['manager'], readonly string[]> = {
    brew: ['HOMEBREW_PREFIX', 'HOMEBREW_CELLAR', 'HOMEBREW_CASKROOM'],
    winget: [],
    npm: ['npm_config_prefix', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_USERCONFIG', 'npm_config_userconfig'],
    uv: ['UV_TOOL_DIR', 'UV_TOOL_BIN_DIR', 'UV_PYTHON_INSTALL_DIR']
  };
  const locationVariables = [
    'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    ...managerVariables[recipe.manager]
  ];
  // Cwd, PWD, temporary-directory names, and credentials are not progress. Actual resolved launchers retain path identity.
  return canonicalSha256({
    schemaVersion: 1,
    observation: observationFingerprint(probe),
    recipeId: recipe.id,
    command: { executable: recipe.command.executable, args: recipe.command.args },
    host: { platform: context.host.platform, linuxFamily: context.host.linuxFamily },
    environment: Object.fromEntries(locationVariables.map((name) =>
      [name, environmentValue(observation.env, name, observation.platform) ?? null]
    ))
  });
}

function storedNoProgressAttempt(
  attempt: RemediationAttempt,
  recipeId: string,
  inputFingerprint: string
): NoProgressRemediationAttempt {
  if (attempt.recipeId !== recipeId || attempt.inputFingerprint !== inputFingerprint ||
      attempt.outputFingerprint !== inputFingerprint || attempt.outcome !== 'unchanged') {
    throw new Error('Stored no-progress history does not match the current recipe and unchanged observation binding.');
  }
  return { recipeId, inputFingerprint, outputFingerprint: inputFingerprint, outcome: 'unchanged' };
}

function historyFailure(
  requirement: SelectedRequirement,
  probe: RequirementProbeResult,
  recipe: RemediationRecipe,
  operation: 'lookup' | 'record',
  error: unknown,
  attempt?: RemediationAttempt,
  command?: string
): InstallResult {
  const detail = error instanceof Error ? safeDetail(error.message) : 'The private no-progress store is unavailable.';
  return {
    requirement, probe, recipe, state: 'failed', reasonCode: 'history-storage-failed', historyError: operation,
    progress: operation === 'record' ? 'unchanged' : 'indeterminate',
    ...(attempt ? { attempt } : {}),
    ...(command ? { command } : {}),
    detail: operation === 'lookup'
      ? `Workstation no-progress history could not be read. No remedy command was run. ${detail}`
      : `The authorized remedy exited zero and the independent probe is unchanged, but its no-progress receipt could not be preserved. ${detail}`,
    remedy: 'Resolve the private workstation remediation history error before retrying; history is not silently ignored or replaced.'
  };
}

export function compareRequirementObservations(
  before: RequirementProbeResult,
  after: RequirementProbeResult
): RemediationProgress {
  if (after.state === 'ready' && after.reasonCode === 'compatible') return 'ready';
  if (observationFingerprint(before) === observationFingerprint(after)) return 'unchanged';
  const discovery = new Set<RequirementReasonCode>(['missing-executable', 'observation-unavailable']);
  if ((discovery.has(before.reasonCode) && !discovery.has(after.reasonCode)) ||
      (before.reasonCode === 'version-unparseable' && Boolean(after.detectedVersion)) ||
      (before.reasonCode === 'incompatible-channel' && after.reasonCode !== 'incompatible-channel' && Boolean(after.detectedVersion)) ||
      (before.reasonCode === 'below-minimum' && after.reasonCode === 'below-minimum' &&
        before.detectedVersion && after.detectedVersion && compareVersions(after.detectedVersion, before.detectedVersion) > 0)) {
    return 'improved';
  }
  return 'changed';
}

export async function installRequirement(
  requirement: SelectedRequirement,
  currentProbe: RequirementProbeResult,
  context: InstallContext
): Promise<InstallResult> {
  requirement = registeredRequirement(requirement);
  const selection = selectRemediation(requirement, currentProbe, context.host, context.approvedRemediationId);
  if (selection.state === 'not-needed') {
    return { requirement, state: 'not-needed', reasonCode: 'verified', detail: selection.detail, probe: currentProbe, progress: 'ready' };
  }
  if (!context.authorized) {
    return {
      requirement,
      state: 'declined',
      reasonCode: 'not-authorized',
      detail: 'Tool remediation was not authorized.',
      probe: currentProbe,
      remedy: currentProbe.remedy
    };
  }

  const recipe = selection.recipe;
  if (!recipe) {
    return {
      requirement,
      state: 'manual',
      reasonCode: 'recipe-unavailable',
      detail: selection.detail,
      probe: currentProbe,
      remedy: selection.remedy
    };
  }
  if (recipe.requiresExplicitReview && context.approvedRemediationId !== recipe.id) {
    return {
      requirement, state: 'manual', reasonCode: 'review-required', recipe, probe: currentProbe,
      detail: `The ${recipe.operation} recipe requires separate review because it can replace the installed version or channel.`,
      remedy: `Review ${formatCommand(recipe.command)} and explicitly approve remedy ${recipe.id}; generic tool-install consent does not authorize a downgrade or channel change.`
    };
  }
  const inputFingerprint = attemptFingerprint(currentProbe, recipe, context);
  let persisted: NoProgressRemediationAttempt | undefined;
  if (context.noProgressStore) {
    try {
      const stored = await context.noProgressStore.find(recipe.id, inputFingerprint);
      if (stored) persisted = storedNoProgressAttempt(stored, recipe.id, inputFingerprint);
    } catch (error) {
      return historyFailure(requirement, currentProbe, recipe, 'lookup', error);
    }
  }
  const history = [
    ...(context.previousAttempts ?? []),
    ...(currentProbe.remediationAttempts ?? []),
    ...(attemptsByRunner.get(context.runner) ?? []),
    ...(persisted ? [persisted] : [])
  ];
  if (history.some((attempt) => attempt.recipeId === recipe.id &&
      attempt.inputFingerprint === inputFingerprint && attempt.outcome === 'unchanged')) {
    return {
      requirement, state: 'unchanged', reasonCode: 'no-progress', progress: 'unchanged', recipe, probe: currentProbe,
      ...(persisted ? { attempt: persisted } : {}),
      detail: `The same ${recipe.id} remedy already made no progress for this executable and constraint; it was not run again.`,
      remedy: 'Reinspect after the installation or environment changes, or review a different registered remedy. Do not repeat the unchanged command.'
    };
  }
  if (!await managerAvailable(recipe, context.runner, context)) {
    return {
      requirement,
      state: 'manual',
      reasonCode: 'manager-unavailable',
      recipe,
      detail: `${recipe.manager} is unavailable, incompatible, or unhealthy; Liftoff does not bootstrap package managers.`,
      probe: currentProbe,
      remedy: `Prepare a compatible ${recipe.manager} through its official instructions, then retry.`
    };
  }

  const result = await runToolCommand(context.runner, recipe.command, {
    cwd: context.cwd,
    env: context.env,
    timeoutMs: 10 * 60_000,
    maxOutputBytes: 1_048_576,
    stream: true,
    ...context.streamOptions
  });
  if (result.status !== 0 || result.timedOut || result.outputLimitExceeded || result.aborted || result.errorCode || result.signal) {
    const attempt: RemediationAttempt = { recipeId: recipe.id, inputFingerprint, outcome: 'failed' };
    return {
      requirement,
      state: 'failed',
      reasonCode: 'execution-failed',
      recipe,
      attempt,
      progress: 'indeterminate',
      detail: result.timedOut
        ? `${requirement.definition.label} installation timed out.`
        : safeDetail(result.stderr || result.errorMessage || '') || `Remedy exited with status ${result.status}.`,
      command: result.displayCommand,
      probe: currentProbe,
      remedy: `The ${recipe.operation} failed; no successful installation or rollback is inferred. ${manualRemedy(requirement, context.host)}`
    };
  }

  const nextProbe = await probeRequirement(requirement, context.runner, context);
  const observedProgress = compareRequirementObservations(currentProbe, nextProbe);
  const outputFingerprint = attemptFingerprint(nextProbe, recipe, context);
  const progress = observedProgress === 'unchanged' && inputFingerprint !== outputFingerprint ? 'changed' : observedProgress;
  const attempt: RemediationAttempt = {
    recipeId: recipe.id,
    inputFingerprint,
    outputFingerprint,
    outcome: progress
  };
  const ownHistory = [...(currentProbe.remediationAttempts ?? []), attempt];
  nextProbe.remediationAttempts = ownHistory;
  attemptsByRunner.set(context.runner, [...(attemptsByRunner.get(context.runner) ?? []), attempt].slice(-100));
  if (context.noProgressStore && progress === 'unchanged') {
    try {
      await context.noProgressStore.record({ ...attempt, outcome: 'unchanged', outputFingerprint });
    } catch (error) {
      return historyFailure(requirement, nextProbe, recipe, 'record', error, attempt, result.displayCommand);
    }
  }
  if (nextProbe.state === 'ready' && nextProbe.reasonCode === 'compatible') {
    return {
      requirement, state: 'installed', reasonCode: 'verified', recipe, progress, attempt,
      detail: `${requirement.definition.label} is ready after verification; installer file changes were not observed.`,
      command: result.displayCommand, probe: nextProbe
    };
  }
  const discoveryFailed = nextProbe.reasonCode === 'missing-executable' ||
    (nextProbe.reasonCode === 'observation-unavailable' &&
      nextProbe.observations.some((observation) => observation.command.executable === requirement.definition.probes[0]?.executable &&
        observation.reasonCode === 'missing-executable'));
  if (discoveryFailed) {
    const discovery = await documentedInstallLocations(recipe, requirement, context);
    if (discovery.complete && discovery.found.length > 0) {
      return {
        requirement, state: 'restart-required', reasonCode: 'executable-discovery', recipe, progress, attempt, discovery,
        detail: `The remedy exited zero, but ${nextProbe.detail} Existing executable candidates were observed at ${discovery.found.map((item) => safeDetail(item.resolvedPath ?? item.executable)).join(', ')}; this does not prove the installer wrote them.`,
        command: result.displayCommand, probe: nextProbe, remedy: pathRemedy(recipe, requirement)
      };
    }
    const discoveryDetail = discovery.complete
      ? 'No executable candidate was observed in the documented install locations.'
      : 'Documented install locations could not be fully observed.';
    return {
      requirement, state: progress === 'unchanged' ? 'unchanged' : 'unresolved',
      reasonCode: progress === 'unchanged' ? 'no-progress' : 'verification-unresolved',
      recipe, progress, attempt, discovery, command: result.displayCommand, probe: nextProbe,
      detail: `The remedy exited zero, but ${nextProbe.detail} ${discoveryDetail} No file changes were verified.`,
      remedy: 'Inspect the installation and its documented executable location before selecting another remedy.'
    };
  }
  return {
    requirement, state: progress === 'unchanged' ? 'unchanged' : 'unresolved',
    reasonCode: progress === 'unchanged' ? 'no-progress' : 'verification-unresolved',
    recipe, progress, attempt, command: result.displayCommand, probe: nextProbe,
    detail: `The remedy exited zero${progress === 'unchanged' ? ' with no progress' : ''}; ${nextProbe.detail} No installer file changes were verified.`,
    remedy: `${nextProbe.remedy ?? 'Inspect the failed version or health probe.'} ` +
      'Review the installation origin and supported version/channel operation instead of repeating the same installer.'
  };
}

export function blockingReadinessFailures(results: RequirementProbeResult[]): RequirementProbeResult[] {
  return results.filter((result) =>
    result.requirement.severity === 'blocking' && (result.state !== 'ready' || result.reasonCode !== 'compatible')
  );
}

export interface WorkstationScopeReadiness {
  scope: WorkstationScope;
  ready: boolean;
  toolFailures: RequirementProbeResult[];
  authenticationFailures: Array<{ requirementId: WorkstationRequirementId; notice: ReadinessNotice }>;
}

/** Workstation prerequisites only; provider permissions, private access, and protected state remain separate gates. */
export function workstationScopeReadiness(
  results: RequirementProbeResult[],
  scope: WorkstationScope
): WorkstationScopeReadiness {
  const toolFailures = blockingReadinessFailures(results);
  const authenticationFailures: WorkstationScopeReadiness['authenticationFailures'] = [];
  if (scope === 'activation' || scope === 'migration' || scope === 'lifecycle') {
    for (const result of results) {
      if (result.requirement.severity !== 'blocking' || result.state !== 'ready' ||
          (result.requirement.id !== 'azure-cli' && result.requirement.id !== 'github-cli')) continue;
      const notice = result.notices.find((item) => item.code === 'authentication') ?? {
        code: 'authentication',
        label: `${result.requirement.definition.label} authentication`,
        state: 'not-observable',
        detail: 'The required authentication capability has not been observed.'
      };
      if (notice.state !== 'ready') authenticationFailures.push({ requirementId: result.requirement.id, notice });
    }
  }
  return { scope, ready: toolFailures.length === 0 && authenticationFailures.length === 0, toolFailures, authenticationFailures };
}
