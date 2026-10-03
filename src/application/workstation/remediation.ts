import {
  workstationRequirementCatalog,
  type InstallRecipe,
  type RemediationRecipe
} from '../../workstation-catalog.js';
import { formatCommand, type CommandRunner, type RunCommandOptions } from '../../process-runner.js';
import { compareVersions } from '../../domain/workstation/versions.js';
import {
  environmentValue,
  hostPath
} from '../../domain/workstation/executables.js';
import type {
  ExecutableIdentity,
  HostEnvironment,
  InstallResult,
  NoProgressRemediationAttempt,
  RemediationAttempt,
  RemediationSelection,
  RequirementProbeResult,
  SelectedRequirement,
  WorkstationNoProgressStore
} from '../../domain/workstation/contracts.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { ExternalCommand } from '../../domain/project/contracts.js';
import {
  requiredConstraint,
  safeDetail,
  unsupportedConstraint
} from '../../domain/workstation/probe-classification.js';
import {
  compareRequirementObservations,
  historyFailure,
  manualRemedy,
  observationFingerprint,
  pathRemedy,
  storedNoProgressAttempt
} from '../../domain/workstation/remediation.js';
import {
  executableObserver,
  observationContext,
  probeRequirement,
  registeredRequirement,
  runToolCommand,
  type WorkstationProbeOptions
} from './probe.js';

export interface InstallContext extends WorkstationProbeOptions {
  authorized: boolean;
  host: HostEnvironment;
  runner: CommandRunner;
  streamOptions?: Pick<RunCommandOptions, 'stdout' | 'stderr'>;
  approvedRemediationId?: string;
  previousAttempts?: readonly RemediationAttempt[];
  noProgressStore?: WorkstationNoProgressStore;
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

const attemptsByRunner = new WeakMap<CommandRunner, RemediationAttempt[]>();

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
