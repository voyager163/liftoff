import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  getCommandHelp,
  getGeneralHelp,
  readBooleanFlag,
  readListFlag,
  readStringFlag
} from './args.js';
import {
  getCodingAgent,
  getFrameworkDefinition,
  getSpecWorkflow,
  listRegions,
  patterns,
  providers,
  searchRegions
} from './catalogs.js';
import {
  probeCodeAppsPlugin,
  type CodeAppsPluginProbe
} from './code-apps-plugin.js';
import { initializeFramework } from './framework-adapters.js';
import { validateFrameworkInstallation } from './framework-validation.js';
import {
  artifactPath,
  applyProjectFileTransaction,
  assertNewOrEmptyDirectory,
  captureProjectFileSnapshot,
  findProjectRoot,
  loadManifest,
  manifestHadFilteredLegacySeedOwnership,
  manifestDisplayPath,
  resolveProjectPath,
  resolveTargetRoot,
  validateGeneratedProject,
  writeArtifacts,
  writeProjectFile,
  type ProjectFileMutation,
  type ProjectFileSnapshot
} from './file-system.js';
import {
  InteractiveCancelledError,
  InteractivePrompter,
  isInteractiveTerminal
} from './interactive.js';
import {
  applyMergePreflight,
  assertSafeInitTarget,
  authorizeMergePreflight,
  buildMergePreflight,
  captureTreeState,
  discoverGitRoot,
  resolveInitTargetFromDiscovery,
  validateStagedTree,
  withStagingArea,
  writeStagedArtifacts,
  type MergeResult,
  type StagingArea
} from './init-filesystem.js';
import { renderMigrationChecklist, renderMigrationProposal, renderMigrationTasks, seedMigrationGroups } from './migrate-plan.js';
import {
  buildOpenSpecProfileWriteCommands,
  configureOpenSpecProfile,
  inspectOpenSpecProfile,
  OPEN_SPEC_DELIVERY,
  OPEN_SPEC_PROFILE,
  OPEN_SPEC_WORKFLOW_IDS
} from './openspec-profile.js';
import {
  buildProjectPlan,
  loadConfigOptions,
  mergeOptions,
  PlanValidationError,
  projectPlanEntries
} from './planner.js';
import {
  buildDependencySetupPlan,
  dependencyResumeCommand,
  runDependencySetup,
  verifyPowerAppsPackageMetadata
} from './project-dependencies.js';
import { formatCommand, NodeCommandRunner, type CommandRunner } from './process-runner.js';
import { scanDefaults, scanLegacyProject } from './scan.js';
import { hasDrift, reconcileProject } from './reconcile.js';
import type { ReconcileEntry } from './reconcile.js';
import { compareSemver } from './semver.js';
import {
  checkConfiguredRegistryTarget,
  runSelfUpgrade,
  selfUpgradeExitCode,
  selfUpgradeRemedy,
  selfUpgradeSummary,
  type ConfiguredRegistryTargetLookup,
  type SelfUpgradeExecutor,
  type SelfUpgradeResult
} from './self-upgrade.js';
import {
  canonicalManualInstallCommand,
  canonicalNpmRegistry,
} from './package-identity.js';
import {
  lookupStableRelease,
  type StableRelease
} from './stable-release.js';
import { supportedStack } from './supported-stack.js';
import { buildArtifacts, buildManifest, partitionGeneratedArtifacts } from './templates.js';
import {
  PresentationSession,
  type PresentationSessionOptions
} from './terminal.js';
import type {
  ApiStackId,
  ApiProjectPlan,
  GeneratedArtifact,
  LiftoffManifest,
  ParsedArgs,
  ProjectOptions,
  ProjectPlan
} from './types.js';
import { liftoffVersion } from './version.js';
import {
  blockingReadinessFailures,
  detectHostEnvironment,
  installRequirement,
  probeWorkstation,
  selectLiftoffRuntimeRequirements,
  selectWorkstationRequirements,
  type RequirementProbeResult,
  type WorkstationRequirementSelection
} from './workstation.js';

export interface CommandContext {
  cwd: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: Readable;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  selfUpgrade?: SelfUpgradeExecutor;
  stableReleaseLookup?: () => Promise<StableRelease>;
  configuredRegistryTargetLookup?: ConfiguredRegistryTargetLookup;
  terminal?: Pick<
    PresentationSessionOptions,
    'columns' | 'color' | 'snapshot' | 'env' | 'layout' | 'normalize'
  >;
}

interface ExecutionContext extends CommandContext {
  presentation: PresentationSession;
}

export async function runCommand(parsed: ParsedArgs, context: CommandContext): Promise<number> {
  const helpRequested = parsed.command !== undefined && readBooleanFlag(parsed.flags, 'help') === true;
  const jsonMode = !helpRequested && (
    parsed.command === 'doctor' ||
    parsed.command === 'update' ||
    parsed.command === 'upgrade' ||
    parsed.command === 'validate'
  ) &&
    readBooleanFlag(parsed.flags, 'json') === true;
  const presentation = new PresentationSession({
    stdout: context.stdout,
    stderr: context.stderr,
    ...context.terminal,
    json: jsonMode
  });
  const executionContext: ExecutionContext = { ...context, presentation };
  try {
    if (parsed.command && readBooleanFlag(parsed.flags, 'help')) {
      renderCommandHelp(parsed.command, presentation);
      return 0;
    }
    switch (parsed.command) {
      case undefined:
      case 'help':
      case '--help':
        if (parsed.positional[0]) {
          renderCommandHelp(parsed.positional[0], presentation);
        } else {
          renderGeneralHelp(presentation);
        }
        return 0;
      case 'version':
        presentation.rawStdout(`Liftoff ${liftoffVersion}\n`);
        return 0;
      case 'init':
        return await initCommand(parsed, executionContext);
      case 'plan':
        return await planCommand(parsed, executionContext);
      case 'patterns':
        return patternsCommand(executionContext);
      case 'providers':
        return providersCommand(executionContext);
      case 'regions':
        return regionsCommand(parsed, executionContext);
      case 'validate':
        return await validateCommand(parsed, executionContext);
      case 'update':
        return await updateCommand(parsed, executionContext);
      case 'upgrade':
        return await upgradeCommand(parsed, executionContext);
      case 'migrate':
        return await migrateCommand(parsed, executionContext);
      case 'doctor':
        return await doctorCommand(parsed, executionContext);
      case 'dev':
        return helperCommand(parsed, executionContext, 'docker compose');
      case 'infra':
        return helperCommand(parsed, executionContext, 'tofu');
      default:
        presentation.error(
          `Unknown command: ${parsed.command}`,
          'Run `liftoff help` to list available commands.'
        );
        return 1;
    }
  } catch (error) {
    if (error instanceof InteractiveCancelledError) {
      presentation.cancellation('Interactive operation stopped.');
      return 0;
    }
    if (error instanceof PlanValidationError) {
      presentation.error(
        error.issues.join('\n'),
        parsed.command ? `Run \`liftoff ${parsed.command} --help\` to review accepted values.` : undefined
      );
      return 1;
    }
    presentation.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function initCommand(parsed: ParsedArgs, context: ExecutionContext): Promise<number> {
  const { presentation } = context;
  presentation.identity('Initialize the project and prepare its workstation');
  const runner = context.runner ?? new NodeCommandRunner();
  presentation.stage('Discover project context');
  const git = await discoverGitRoot(context.cwd, runner);
  let initial = await optionsFromParsedArgs(parsed, context.cwd, true);
  if (!initial.projectName && git.exact && git.root) {
    initial = { ...initial, projectName: path.basename(git.root) };
  }
  const interactive = initial.yes !== true;
  const prompter = interactive
    ? new InteractivePrompter({
        input: context.stdin,
        output: context.stdout,
        presentation,
        cwd: context.cwd,
        configuredRoot: git.exact ? git.root : undefined,
        runner
      })
    : undefined;
  try {
    const needsPrompts = interactive && hasMissingInitInputs(initial);
    if (needsPrompts) {
      presentation.stage('Configure project');
    }
    let options: ProjectOptions;
    let plan: ProjectPlan;
    let confirmed: boolean;
    try {
      options = needsPrompts ? await prompter!.promptForInitOptions(initial) : initial;
      plan = buildProjectPlan(options, { requireProjectName: true });
      presentation.stage('Review resolved plan');
      confirmed = options.yes === true
        ? (presentation.definitions('Resolved project plan', projectPlanEntries(plan)), true)
        : await prompter!.confirmPlan(plan);
    } catch (error) {
      if (error instanceof InteractiveCancelledError) {
        presentation.cancellation('Initialization stopped; no destination files were changed.');
        return 0;
      }
      throw error;
    }
    if (!confirmed) {
      presentation.cancellation('Initialization stopped; no destination files were changed.');
      return 0;
    }

    presentation.stage('Resolve destination');
    const target = resolveInitTargetFromDiscovery(git, plan.safeProjectName);
    await assertSafeInitTarget(target, target.mode === 'named-child' ? git.canonicalCwd : undefined);

    presentation.stage('Check workstation readiness');
    const readiness = await ensureWorkstationReady(
      plan,
      options,
      context,
      runner,
      presentation,
      prompter
    );
    if (!readiness.ready) {
      return 1;
    }
    const profileReadiness = await ensureOpenSpecProfileReady(
      plan,
      options,
      context,
      runner,
      presentation,
      prompter
    );
    if (!profileReadiness.ready) {
      return 1;
    }

    presentation.stage('Stage project files');
    const staged = await withStagingArea(async (area): Promise<
      { status: 'applied'; merge: MergeResult } | { status: 'authorization-required' | 'declined' }
    > => {
      const partition = partitionGeneratedArtifacts(buildArtifacts(plan));
      await writeStagedArtifacts(area, partition.durable, 'liftoff');
      presentation.stage(
        'Initialize spec-driven framework',
        `${plan.specWorkflow.label} ${plan.framework.version}`
      );
      await initializeFramework(area, plan, runner, {
        env: context.env,
        ...presentation.childStreams(),
        onCommand: (command) => presentation.command(command)
      });
      await writeStagedArtifacts(area, partition.seed, 'seed');
      await writeStagedArtifacts(area, [partition.manifest], 'liftoff');
      presentation.stage('Validate staged project');
      await validateStagedTree(area);
      const stagedIssues = await validateGeneratedProject(area.root);
      if (stagedIssues.length > 0) {
        throw new Error(`Staged project validation failed:\n${stagedIssues.join('\n')}`);
      }

      const preflight = await buildMergePreflight(area, target.root);
      const authorized = await authorizeMergePreflight(
        preflight,
        options.force === true,
        interactive ? (paths) => prompter!.confirmFileReplacements(paths) : undefined
      );
      if (!authorized) {
        return {
          status: interactive ? 'declined' : 'authorization-required'
        };
      }
      presentation.stage('Merge staged project', target.root);
      return { status: 'applied', merge: await applyMergePreflight(authorized) };
    });

    if (staged.status === 'declined') {
      presentation.cancellation('No destination files were changed.');
      return 0;
    }
    if (staged.status === 'authorization-required') {
      presentation.error(
        'Existing regular-file conflicts require --force in non-interactive mode.',
        'Review the listed conflicts, then rerun with `--force` only if every replacement is intended.'
      );
      return 1;
    }

    const issues = await validateGeneratedProject(target.root);
    if (issues.length > 0) {
      presentation.error(`Initialized project validation failed:\n${issues.join('\n')}`);
      return 1;
    }

    const dependencyPhase = await handleProjectDependencies(
      plan,
      target.root,
      options,
      readiness.probes,
      context,
      runner,
      presentation,
      prompter
    );
    if (!dependencyPhase.success) {
      return 1;
    }

    presentation.bullets('Configured integrations', [
      `${plan.specWorkflow.label} ${plan.framework.version}`,
      ...plan.agents.map((agent) =>
        `${agent.label}${plan.defaultAgent?.id === agent.id ? ' (default)' : ''}`
      ),
      ...readiness.pluginProbes.map((probe) =>
        `Code Apps plugin for ${probe.agent.label}: ${probe.state}`
      ),
      ...(plan.specWorkflow.id === 'openspec'
        ? [
            `OpenSpec global profile: ${profileReadiness.changed ? 'configured' : 'verified'}; ` +
              `${OPEN_SPEC_WORKFLOW_IDS.length} workflows; skills and commands`,
            ...(plan.agents.some((agent) => agent.id === 'github-copilot')
              ? [`GitHub Copilot cloud agent: ${plan.copilotCloud ? 'enabled' : 'disabled'}`]
              : [])
          ]
        : []),
      plan.governanceProfile.id === 'none'
        ? 'Repository governance: disabled'
        : `Repository governance: ${plan.governanceProfile.label} policy ${plan.governanceProfile.policyVersion}; local handoff generated, live activation deferred`
    ]);
    if (readiness.deferred.length > 0) {
      presentation.bullets('Deferred advisory checks', readiness.deferred);
    }
    if (dependencyPhase.deferred.length > 0) {
      presentation.bullets('Deferred project dependencies', dependencyPhase.deferred);
    }
    presentation.completion(
      `Initialized ${plan.projectName}`,
      target.root,
      [
        { label: 'Target', value: target.root },
        { label: 'Spec workflow', value: plan.specWorkflow.label },
        { label: 'Coding agents', value: plan.agents.map((agent) => agent.label).join(', ') },
        {
          label: 'Repository governance',
          value: plan.governanceProfile.id === 'none'
            ? 'Disabled'
            : 'Handoff generated; commit and push before read-only Phase 0'
        }
      ],
      `liftoff validate ${JSON.stringify(target.root)}`
    );
    return 0;
  } finally {
    prompter?.close();
  }
}

async function planCommand(parsed: ParsedArgs, context: ExecutionContext): Promise<number> {
  const { presentation } = context;
  presentation.identity('Preview project decisions, artifacts, and workstation requirements');
  const options = await optionsFromParsedArgs(parsed, context.cwd, false);
  const plan = buildProjectPlan(options, { requireProjectName: false });
  const artifacts = buildArtifacts(plan);
  presentation.definitions('Project decisions', projectPlanEntries(plan));
  presentation.table(
    `Artifacts (${artifacts.length})`,
    ['Artifact', 'Path'],
    artifacts.map((artifact) => [artifact.logicalName, artifact.pathParts.join('/')])
  );
  const workstationRows = selectWorkstationRequirements(plan).map((requirement) => [
    requirement.definition.label,
    requirement.exactVersion
      ? `exactly ${requirement.exactVersion}`
      : requirement.minimumVersion
        ? `${requirement.minimumVersion}+`
        : 'available',
    requirement.severity
  ]);
  if (presentation.stdout.layout === 'plain') {
    presentation.section(
      'Workstation requirements',
      workstationRows.map(([label, version, severity]) => `${label}: ${version} [${severity}]`)
    );
  } else {
    presentation.table(
      'Workstation requirements',
      ['Requirement', 'Version', 'Level'],
      workstationRows
    );
  }
  return 0;
}

interface WorkstationReadinessResult {
  ready: boolean;
  deferred: string[];
  probes: RequirementProbeResult[];
  pluginProbes: CodeAppsPluginProbe[];
}

interface OpenSpecProfileReadinessResult {
  ready: boolean;
  changed: boolean;
}

async function ensureWorkstationReady(
  plan: ProjectPlan,
  options: ProjectOptions,
  context: ExecutionContext,
  runner: CommandRunner,
  presentation: PresentationSession,
  prompter?: InteractivePrompter,
  resumeInvocation = 'liftoff init',
  commandCwd?: string
): Promise<WorkstationReadinessResult> {
  const requirements = selectWorkstationRequirements(plan);
  const [initialProbes, pluginProbes] = await Promise.all([
    probeWorkstation(requirements, runner, { cwd: commandCwd }),
    plan.workload === 'power-apps-code-app' && plan.codeAppsPlugin
      ? probeCodeAppsPlugin(plan.agents, runner, commandCwd)
      : Promise.resolve([])
  ]);
  let probes = initialProbes;
  presentation.table(
    'Workstation readiness',
    ['Requirement', 'Level', 'State', 'Detail'],
    probes.map((probe) => [
      probe.requirement.definition.label,
      probe.requirement.severity,
      probe.state,
      probe.detail
    ])
  );
  if (pluginProbes.length > 0) {
    presentation.table(
      'Optional Code Apps plugin',
      ['Agent', 'State', 'Detail'],
      pluginProbes.map((probe) => [probe.agent.label, probe.state, probe.detail])
    );
  }

  const actionable = probes.filter((probe) => probe.state !== 'ready');
  const host = await detectHostEnvironment();
  const installInstruction = (probe: RequirementProbeResult): string => {
    const recipe = probe.requirement.definition.install[host.platform];
    const automatic = recipe && (
      host.platform !== 'linux' || recipe.manager === 'npm' || recipe.manager === 'uv'
    );
    if (automatic) {
      return formatCommand(recipe.command);
    }
    if (host.platform === 'linux') {
      return probe.requirement.definition.linuxRemedies[host.linuxFamily];
    }
    return `Install ${probe.requirement.definition.label} manually, then retry.`;
  };
  const authorizedInstallations = new Set<string>();
  if (options.installTools === true) {
    for (const probe of actionable) {
      authorizedInstallations.add(probe.requirement.id);
    }
  }
  if (
    options.installTools === undefined &&
    options.yes !== true &&
    actionable.length > 0
  ) {
    for (const probe of actionable) {
      const recipe = probe.requirement.definition.install[host.platform];
      const automatic = recipe && (
        host.platform !== 'linux' || recipe.manager === 'npm' || recipe.manager === 'uv'
      );
      const constraint = probe.requirement.exactVersion
        ? `required exactly ${probe.requirement.exactVersion}`
        : probe.requirement.minimumVersion
          ? `required ${probe.requirement.minimumVersion} or newer`
          : 'required to be available';
      if (await prompter!.confirmToolInstallation({
        label: probe.requirement.definition.label,
        severity: probe.requirement.severity,
        purpose: probe.requirement.reasons.join('; '),
        requirement: constraint,
        observed: `${probe.state} - ${probe.detail}`,
        ...(automatic
          ? { command: formatCommand(recipe.command) }
          : { remedy: installInstruction(probe) })
      })) {
        authorizedInstallations.add(probe.requirement.id);
      }
    }
  }

  if (authorizedInstallations.size > 0) {
    const updates = new Map<string, RequirementProbeResult>();
    for (const probe of actionable) {
      if (!authorizedInstallations.has(probe.requirement.id)) {
        continue;
      }
      presentation.stage(
        `Install ${probe.requirement.definition.label}`,
        `${probe.state} - ${probe.detail}`
      );
      const recipe = probe.requirement.definition.install[host.platform];
      if (recipe && (host.platform !== 'linux' || recipe.manager === 'npm' || recipe.manager === 'uv')) {
        presentation.command(formatCommand(recipe.command));
      }
      const installation = await installRequirement(probe.requirement, probe, {
        authorized: true,
        host,
        runner,
        cwd: commandCwd,
        streamOptions: presentation.childStreams()
      });
      updates.set(probe.requirement.id, installation.probe);
      const kind = installation.state === 'installed'
        ? 'success'
        : probe.requirement.severity === 'blocking'
          ? 'error'
          : 'warning';
      presentation.status(kind, probe.requirement.definition.label, installation.detail);
      if (installation.remedy) {
        presentation.command(installation.remedy);
      }
    }
    probes = probes.map((probe) => updates.get(probe.requirement.id) ?? probe);
  }

  const blockers = blockingReadinessFailures(probes);
  if (blockers.length > 0) {
    for (const blocker of blockers) {
      presentation.error(
        `${blocker.requirement.definition.label}: ${blocker.detail}`,
        installInstruction(blocker)
      );
    }
    presentation.error(
      'Workstation readiness is incomplete.',
      options.installTools
        ? `Open a new terminal if PATH changed, then rerun \`${resumeInvocation}\` with the same project options.`
        : `Resume with \`${resumeInvocation} --install-tools\` plus the same project options after reviewing the commands.`
    );
    return { ready: false, deferred: [], probes, pluginProbes };
  }

  const deferred = [
    ...probes
      .filter((probe) => probe.requirement.severity === 'advisory' && probe.state !== 'ready')
      .map((probe) =>
        `${probe.requirement.definition.label}: ${probe.detail} Remedy: ${installInstruction(probe)}`
      ),
    ...probes.flatMap((probe) => probe.notices
      .filter((notice) => notice.state !== 'ready')
      .map((notice) =>
        `${notice.label}: ${notice.detail}${notice.remedy ? ` Remedy: ${notice.remedy}` : ''}`
      )),
    ...pluginProbes
      .filter((probe) => probe.state !== 'ready')
      .map((probe) =>
        `${probe.agent.label} Code Apps plugin: ${probe.detail}${probe.remedy ? ` Remedy: ${probe.remedy}` : ''}`
      )
  ];
  return { ready: true, deferred, probes, pluginProbes };
}

async function ensureOpenSpecProfileReady(
  plan: ProjectPlan,
  options: ProjectOptions,
  context: ExecutionContext,
  runner: CommandRunner,
  presentation: PresentationSession,
  prompter?: InteractivePrompter,
  resumeInvocation = 'liftoff init'
): Promise<OpenSpecProfileReadinessResult> {
  if (plan.specWorkflow.id !== 'openspec') {
    return { ready: true, changed: false };
  }

  presentation.stage('Check OpenSpec global profile');
  const inspection = await inspectOpenSpecProfile(plan.framework.executable, runner, {
    cwd: context.cwd,
    env: context.env
  });
  if (inspection.compatible) {
    presentation.status(
      'success',
      'OpenSpec global profile',
      `${OPEN_SPEC_PROFILE}; ${OPEN_SPEC_DELIVERY}; ${OPEN_SPEC_WORKFLOW_IDS.length} workflows`
    );
    return { ready: true, changed: false };
  }

  const commands = buildOpenSpecProfileWriteCommands(plan.framework.executable);
  const authorized = options.configureOpenSpecProfile === true ||
    (
      options.configureOpenSpecProfile === undefined &&
      prompter !== undefined &&
      await prompter.confirmOpenSpecProfileConfiguration({
        observed: [
          { label: 'Profile', value: inspection.state.profile },
          { label: 'Delivery', value: inspection.state.delivery },
          {
            label: 'Workflows',
            value: inspection.state.workflows.length > 0
              ? inspection.state.workflows.join(', ')
              : '(none)'
          }
        ],
        required: [
          { label: 'Profile', value: OPEN_SPEC_PROFILE },
          { label: 'Delivery', value: OPEN_SPEC_DELIVERY },
          { label: 'Workflows', value: OPEN_SPEC_WORKFLOW_IDS.join(', ') }
        ],
        differences: inspection.differences,
        commands: commands.map((command) => formatCommand(command))
      })
    );

  if (!authorized) {
    presentation.error(
      'The global OpenSpec profile does not satisfy the Liftoff template contract.',
      `Run ${commands.map((command) => `\`${formatCommand(command)}\``).join(', then ')}, ` +
        `then rerun \`${resumeInvocation}\`; or authorize those commands with ` +
        '`--configure-openspec-profile`.'
    );
    return { ready: false, changed: false };
  }

  presentation.stage('Configure OpenSpec global profile');
  await configureOpenSpecProfile(plan.framework.executable, runner, {
    cwd: context.cwd,
    env: context.env,
    ...presentation.childStreams(),
    onCommand: (command) => presentation.command(formatCommand(command))
  });
  presentation.status(
    'success',
    'OpenSpec global profile',
    `${OPEN_SPEC_PROFILE}; ${OPEN_SPEC_DELIVERY}; ${OPEN_SPEC_WORKFLOW_IDS.length} workflows (configured)`
  );
  return { ready: true, changed: true };
}

async function handleProjectDependencies(
  plan: ProjectPlan,
  projectRoot: string,
  options: ProjectOptions,
  probes: RequirementProbeResult[],
  context: ExecutionContext,
  runner: CommandRunner,
  presentation: PresentationSession,
  prompter?: InteractivePrompter
): Promise<{ success: boolean; deferred: string[] }> {
  const dependencyPlan = buildDependencySetupPlan(plan, projectRoot, probes);
  let installDependencies = options.installDependencies === true;
  if (
    options.installDependencies === undefined &&
    options.yes !== true &&
    dependencyPlan.commands.length > 0
  ) {
    installDependencies = await prompter!.confirmDependencyInstallation(dependencyPlan.commands);
  }
  if (!installDependencies) {
    return {
      success: true,
      deferred: dependencyPlan.commands.map((command) =>
        `${command.label}: ${dependencyResumeCommand(command)}`
      )
    };
  }

  if (plan.workload === 'power-apps-code-app') {
    const issues = await verifyPowerAppsPackageMetadata(projectRoot);
    if (issues.length > 0) {
      presentation.error(
        'Power Apps dependency installation blocked',
        `${issues.join(' ')} Restore package.json and package-lock.json or run \`liftoff update\`.`
      );
      return { success: false, deferred: [] };
    }
  }

  presentation.stage('Install project dependencies');
  const result = await runDependencySetup(dependencyPlan, projectRoot, runner, {
    ...presentation.childStreams(),
    onCommand: (command) => {
      presentation.status('pending', command.label, command.cwd);
      presentation.command(formatCommand(command.command));
    }
  });
  if (!result.success) {
    presentation.error(
      'Project dependencies failed',
      `${result.failed?.label ?? 'dependency command'}: ${result.detail ?? 'unknown failure'}`
    );
    presentation.status('info', 'Scaffold preserved', projectRoot);
    if (result.restoredMutations.length > 0) {
      presentation.warning(
        `Restored protected files: ${result.restoredMutations.join(', ')}`
      );
    }
    if (result.resumeCommand) {
      presentation.command(result.resumeCommand);
    }
    return { success: false, deferred: [] };
  }
  presentation.status(
    'success',
    'Project dependencies',
    `${result.completed.length} command${result.completed.length === 1 ? '' : 's'} completed`
  );
  return { success: true, deferred: [] };
}

function patternsCommand(context: ExecutionContext): number {
  context.presentation.commandIdentity('patterns', 'Available GenAI application patterns');
  context.presentation.table(
    'Patterns',
    ['Identifier', 'Pattern', 'Scaffold'],
    patterns.map((pattern) => [pattern.id, pattern.label, pattern.scaffoldStatus])
  );
  return 0;
}

function providersCommand(context: ExecutionContext): number {
  context.presentation.commandIdentity('providers', 'Cloud provider availability');
  context.presentation.table(
    'Providers',
    ['Identifier', 'Provider', 'Availability'],
    providers.map((provider) => [provider.id, provider.label, provider.status])
  );
  return 0;
}

function regionsCommand(parsed: ParsedArgs, context: ExecutionContext): number {
  const cloud = readStringFlag(parsed.flags, 'cloud') ?? 'azure';
  context.presentation.commandIdentity('regions', 'Cloud deployment regions');
  if (cloud !== 'azure') {
    context.presentation.error(
      `${cloud} regions are not available until the provider adapter is implemented.`,
      'Run `liftoff providers` to review currently available providers.'
    );
    return 1;
  }

  const query = parsed.positional[0] ?? readStringFlag(parsed.flags, 'region');
  const regions = parsed.subcommand === 'search' && query ? searchRegions('azure', query) : listRegions('azure');
  if (regions.length === 0) {
    context.presentation.warning(`No Azure regions matched ${JSON.stringify(query ?? '')}.`);
    return 0;
  }
  context.presentation.table(
    query ? `Azure region matches for ${JSON.stringify(query)}` : 'Azure regions',
    ['Identifier', 'Region', 'Geography'],
    regions.map((region) => [region.slug, region.displayName, region.geography])
  );
  return 0;
}

async function validateCommand(parsed: ParsedArgs, context: ExecutionContext): Promise<number> {
  context.presentation.commandIdentity('validate', 'Validate a generated Liftoff project');
  const jsonMode = readBooleanFlag(parsed.flags, 'json') ?? false;
  const explicit = parsed.positional[0] ?? readStringFlag(parsed.flags, 'project');
  const projectRoot = explicit
    ? path.resolve(context.cwd, explicit)
    : (await findProjectRoot(context.cwd)) ?? context.cwd;
  const issues = await validateGeneratedProject(projectRoot);
  if (jsonMode) {
    context.presentation.rawStdout(
      `${JSON.stringify({
        schemaVersion: 1,
        projectRoot,
        valid: issues.length === 0,
        issues
      }, null, 2)}\n`
    );
    return issues.length === 0 ? 0 : 1;
  }
  if (issues.length > 0) {
    context.presentation.error(
      issues.join('\n'),
      'Restore invalid generated files or the manifest from version control, then rerun validation.'
    );
    return 1;
  }
  context.presentation.status('success', 'Generated project manifest is valid', projectRoot);
  return 0;
}

const STAGING_EXCLUDES = new Set(['.git', 'node_modules', 'vendor', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next']);

type MigrationSourceSnapshot = Map<string, string>;

async function snapshotMigrationSource(sourceRoot: string): Promise<MigrationSourceSnapshot> {
  const snapshot: MigrationSourceSnapshot = new Map();
  const visit = async (pathParts: string[]): Promise<void> => {
    const current = path.join(sourceRoot, ...pathParts);
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const childParts = [...pathParts, entry.name];
      const relativePath = childParts.join('/');
      const childPath = path.join(sourceRoot, ...childParts);
      const details = await lstat(childPath);
      if (details.isSymbolicLink()) {
        snapshot.set(relativePath, `symlink:${await readlink(childPath)}`);
      } else if (details.isDirectory()) {
        snapshot.set(relativePath, 'directory');
        await visit(childParts);
      } else if (details.isFile()) {
        const hash = createHash('sha256').update(await readFile(childPath)).digest('hex');
        snapshot.set(relativePath, `file:${hash}`);
      } else {
        snapshot.set(relativePath, 'other');
      }
    }
  };
  await visit([]);
  return snapshot;
}

function sourceSnapshotChanges(
  before: MigrationSourceSnapshot,
  after: MigrationSourceSnapshot
): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((key) => before.get(key) !== after.get(key))
    .sort();
}

async function withUnchangedMigrationSource<T>(
  sourceRoot: string,
  operation: () => Promise<T>
): Promise<T> {
  const before = await snapshotMigrationSource(sourceRoot);
  const assertUnchanged = async () => {
    const changes = sourceSnapshotChanges(before, await snapshotMigrationSource(sourceRoot));
    if (changes.length > 0) {
      throw new Error(
        `Migration source changed unexpectedly; refusing to continue:\n${changes.map((entry) => `- ${entry}`).join('\n')}`
      );
    }
  };
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    await assertUnchanged();
    throw error;
  }
  await assertUnchanged();
  return result;
}

async function stageMigrationSource(area: StagingArea, sourceRoot: string): Promise<void> {
  const destination = path.join(area.root, 'migration', 'legacy');
  await cp(sourceRoot, destination, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(sourceRoot, source);
      if (!relative) {
        return true;
      }
      return !relative.split(path.sep).some((part) => STAGING_EXCLUDES.has(part));
    }
  });
  for (const entry of (await captureTreeState(area.root)).values()) {
    if (
      entry.pathParts[0] === 'migration' &&
      entry.pathParts[1] === 'legacy' &&
      entry.type !== 'directory'
    ) {
      area.origins.set(entry.pathParts.join('/'), 'seed');
    }
  }
}

function migrationPlanArtifacts(
  plan: ApiProjectPlan,
  inventory: Awaited<ReturnType<typeof scanLegacyProject>>
): { artifacts: GeneratedArtifact[]; location: string } {
  const groups = seedMigrationGroups(inventory, plan);
  if (plan.specWorkflow.id === 'openspec') {
    return {
      artifacts: [
        {
          logicalName: 'migration-proposal',
          category: 'seed',
          pathParts: ['openspec', 'changes', 'migrate-to-liftoff', 'proposal.md'],
          content: renderMigrationProposal(plan, inventory)
        },
        {
          logicalName: 'migration-tasks',
          category: 'seed',
          pathParts: ['openspec', 'changes', 'migrate-to-liftoff', 'tasks.md'],
          content: renderMigrationTasks(groups)
        }
      ],
      location: 'openspec/changes/migrate-to-liftoff/ (run it with your agent workflow, e.g. /opsx:apply migrate-to-liftoff)'
    };
  }
  return {
    artifacts: [{
      logicalName: 'migration-checklist',
      category: 'seed',
      pathParts: ['MIGRATION.md'],
      content: renderMigrationChecklist(plan, inventory, groups)
    }],
    location: 'MIGRATION.md'
  };
}

async function executeMigration(
  parsed: ParsedArgs,
  context: ExecutionContext,
  sourceRoot: string
): Promise<number> {
  const { presentation } = context;
  presentation.stage('Scan legacy project', sourceRoot);
  const inventory = await scanLegacyProject(sourceRoot);
  const { options: defaults, provenance } = scanDefaults(inventory);
  if (presentation.stdout.layout === 'plain') {
    presentation.section(
      'Scan defaults (override in prompts or with flags)',
      provenance.map((item) =>
        `${item.field}: ${String(item.value)}  (detected: ${item.evidence})`
      )
    );
  } else {
    presentation.table(
      'Scan defaults (override in prompts or with flags)',
      ['Decision', 'Detected value', 'Evidence'],
      provenance.map((item) => [item.field, String(item.value), item.evidence])
    );
  }

  const flagOptions = await optionsFromParsedArgs(parsed, context.cwd, false);
  const initial = mergeOptions(defaults, flagOptions);
  if (flagOptions.pattern && flagOptions.projectType === undefined) {
    initial.projectType = 'genai';
    if (flagOptions.apiStack === undefined) {
      initial.apiStack = undefined;
    }
  } else if (flagOptions.apiStack && flagOptions.projectType === undefined) {
    initial.projectType = 'standard';
    initial.pattern = undefined;
  }
  if (flagOptions.projectType === 'standard' && flagOptions.pattern === undefined) {
    initial.pattern = undefined;
  }
  if (flagOptions.projectType === 'genai' && flagOptions.apiStack === undefined) {
    initial.apiStack = undefined;
  }
  const runner = context.runner ?? new NodeCommandRunner();
  const interactive = initial.yes !== true;
  const prompter = interactive
    ? new InteractivePrompter({
        input: context.stdin,
        output: context.stdout,
        presentation,
        cwd: context.cwd,
        runner
      })
    : undefined;
  try {
    const needsPrompts = interactive && hasMissingInitInputs(initial);
    if (needsPrompts) {
      presentation.stage('Configure migrated project');
    }
    const options = needsPrompts ? await prompter!.promptForInitOptions(initial) : initial;
    const plan = buildProjectPlan(options, { requireProjectName: true });
    if (plan.workload === 'power-apps-code-app') {
      presentation.error(
        'Power Apps code app migration is not supported.',
        'Initialize a fresh Power Apps code app, then move application changes intentionally.'
      );
      return 1;
    }
    presentation.stage('Review migration plan');
    const confirmed = options.yes === true
      ? (presentation.definitions('Resolved migration plan', projectPlanEntries(plan)), true)
      : await prompter!.confirmPlan(plan, undefined, 'Migrate project?');
    if (!confirmed) {
      presentation.cancellation('Migration stopped; the source and destination were not modified.');
      return 0;
    }

    presentation.stage('Resolve fresh migration target');
    const parentDir = path.dirname(sourceRoot);
    let targetRoot = path.resolve(parentDir, plan.safeProjectName);
    if (targetRoot === sourceRoot) {
      targetRoot = path.resolve(parentDir, `${plan.safeProjectName}-liftoff`);
    }
    const target = { root: targetRoot, mode: 'named-child' as const };
    await assertSafeInitTarget(target, parentDir);
    await assertNewOrEmptyDirectory(targetRoot);

    presentation.stage('Check workstation readiness');
    const readinessRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-migrate-readiness-'));
    const readiness = await (async () => {
      try {
        return await ensureWorkstationReady(
          plan,
          options,
          context,
          runner,
          presentation,
          prompter,
          `liftoff migrate ${JSON.stringify(sourceRoot)}`,
          readinessRoot
        );
      } finally {
        await rm(readinessRoot, { recursive: true, force: true });
      }
    })();
    if (!readiness.ready) {
      return 1;
    }
    const profileReadiness = await ensureOpenSpecProfileReady(
      plan,
      options,
      context,
      runner,
      presentation,
      prompter,
      `liftoff migrate ${JSON.stringify(sourceRoot)}`
    );
    if (!profileReadiness.ready) {
      return 1;
    }

    const migrationPlan = migrationPlanArtifacts(plan, inventory);
    presentation.stage('Stage fresh migration project');
    await withStagingArea(async (area) => {
      const partition = partitionGeneratedArtifacts(buildArtifacts(plan));
      await writeStagedArtifacts(area, partition.durable, 'liftoff');
      presentation.stage(
        'Initialize spec-driven framework',
        `${plan.specWorkflow.label} ${plan.framework.version}`
      );
      await initializeFramework(area, plan, runner, {
        env: context.env,
        ...presentation.childStreams(),
        onCommand: (command) => presentation.command(command)
      });
      await writeStagedArtifacts(area, partition.seed, 'seed');
      presentation.stage('Copy filtered legacy source', sourceRoot);
      await stageMigrationSource(area, sourceRoot);
      await writeStagedArtifacts(area, migrationPlan.artifacts, 'seed');
      await writeStagedArtifacts(area, [partition.manifest], 'liftoff');
      presentation.stage('Validate staged migration');
      await validateStagedTree(area);
      const stagedIssues = await validateGeneratedProject(area.root);
      if (stagedIssues.length > 0) {
        throw new Error(`Staged migration project validation failed:\n${stagedIssues.join('\n')}`);
      }

      const preflight = await buildMergePreflight(area, targetRoot);
      const existing = preflight.entries.filter((entry) => entry.destination.type !== 'missing');
      if (existing.length > 0) {
        throw new Error(
          `Migration target must remain new or empty; --force cannot replace existing content:\n` +
          existing.map((entry) => `- ${entry.relativePath}`).join('\n')
        );
      }
      const authorized = await authorizeMergePreflight(preflight, false);
      if (!authorized) {
        throw new Error('Migration target authorization failed.');
      }
      presentation.stage('Merge fresh migration target', targetRoot);
      await applyMergePreflight(authorized, { requireEmptyTarget: true });
    });

    const issues = await validateGeneratedProject(targetRoot);
    if (issues.length > 0) {
      presentation.error(`Migrated project validation failed:\n${issues.join('\n')}`);
      return 1;
    }

    const dependencyPhase = await handleProjectDependencies(
      plan,
      targetRoot,
      options,
      readiness.probes,
      context,
      runner,
      presentation,
      prompter
    );
    if (!dependencyPhase.success) {
      return 1;
    }

    presentation.bullets('Configured integrations', [
      `${plan.specWorkflow.label} ${plan.framework.version}`,
      ...plan.agents.map((agent) =>
        `${agent.label}${plan.defaultAgent?.id === agent.id ? ' (default)' : ''}`
      ),
      ...(plan.specWorkflow.id === 'openspec'
        ? [
            `OpenSpec global profile: ${profileReadiness.changed ? 'configured' : 'verified'}; ` +
              `${OPEN_SPEC_WORKFLOW_IDS.length} workflows; skills and commands`,
            ...(plan.agents.some((agent) => agent.id === 'github-copilot')
              ? [`GitHub Copilot cloud agent: ${plan.copilotCloud ? 'enabled' : 'disabled'}`]
              : [])
          ]
        : [])
    ]);
    if (readiness.deferred.length > 0) {
      presentation.bullets('Deferred advisory checks', readiness.deferred);
    }
    if (dependencyPhase.deferred.length > 0) {
      presentation.bullets('Deferred project dependencies', dependencyPhase.deferred);
    }
    presentation.bullets('Next steps', [
      `Optional - preserve history: copy the .git directory from ${sourceRoot} into ${targetRoot}, then commit the migration on top (git rename detection preserves file history).`,
      `Execute the migration plan: ${migrationPlan.location}`,
      'Verify compliance: liftoff validate && liftoff doctor'
    ]);
    presentation.completion(
      `Migrated ${plan.projectName}`,
      targetRoot,
      [
        { label: 'Target', value: targetRoot },
        { label: 'Source', value: `${sourceRoot} (not modified)` },
        { label: 'Rollback', value: `Delete ${targetRoot}` }
      ],
      'liftoff validate && liftoff doctor'
    );
    return 0;
  } finally {
    prompter?.close();
  }
}

async function migrateCommand(parsed: ParsedArgs, context: ExecutionContext): Promise<number> {
  const sourceArg = parsed.positional[0];
  if (!sourceArg) {
    context.presentation.error(
      'Usage: liftoff migrate <path-to-existing-project>',
      'Run `liftoff migrate --help` for accepted migration options.'
    );
    return 1;
  }
  const migrationOptions = await optionsFromParsedArgs(parsed, context.cwd, false);
  if (migrationOptions.projectType === 'power-apps-code-app') {
    context.presentation.error(
      'Power Apps code app migration is not supported.',
      'Initialize a fresh Power Apps code app with `liftoff init --type power-apps-code-app`, then move application changes intentionally.'
    );
    return 1;
  }
  const sourceRoot = path.resolve(context.cwd, sourceArg);
  let sourceDetails;
  try {
    sourceDetails = await stat(sourceRoot);
  } catch {
    context.presentation.error(`Source project not found: ${sourceRoot}`);
    return 1;
  }
  if (!sourceDetails.isDirectory()) {
    context.presentation.error(`Source path is not a directory: ${sourceRoot}`);
    return 1;
  }
  if (existsSync(path.join(sourceRoot, 'liftoff.manifest.json'))) {
    context.presentation.error(
      `${sourceRoot} is already a Liftoff project.`,
      'Use `liftoff update` instead.'
    );
    return 1;
  }
  context.presentation.identity('Migrate an existing application into a fresh Liftoff project');
  return withUnchangedMigrationSource(sourceRoot, () => executeMigration(parsed, context, sourceRoot));
}

interface UpdateSummary {
  new: number;
  missing: number;
  upgrade: number;
  conflict: number;
  moved: number;
  orphan: number;
  refresh: number;
  unchanged: number;
}

function summarizeEntries(entries: ReconcileEntry[]): UpdateSummary {
  const summary: UpdateSummary = { new: 0, missing: 0, upgrade: 0, conflict: 0, moved: 0, orphan: 0, refresh: 0, unchanged: 0 };
  for (const entry of entries) {
    if (entry.status === 'unchanged') {
      if (entry.refreshHash) {
        summary.refresh += 1;
      } else {
        summary.unchanged += 1;
      }
      continue;
    }
    if (entry.status === 'moved' && !entry.cleanMove) {
      summary.conflict += 1;
      continue;
    }
    summary[entry.status] += 1;
  }
  return summary;
}

function entryMarker(entry: ReconcileEntry): string {
  switch (entry.status) {
    case 'new':
    case 'missing':
      return '+';
    case 'upgrade':
      return '~';
    case 'conflict':
      return '!';
    case 'moved':
      return entry.cleanMove ? '>' : '!';
    case 'orphan':
      return '-';
    default:
      return '~';
  }
}

function entryDisplay(entry: ReconcileEntry): string {
  if (entry.status === 'moved' && entry.previousPathParts) {
    return `${manifestDisplayPath(entry.previousPathParts)} => ${manifestDisplayPath(entry.pathParts)}`;
  }
  return manifestDisplayPath(entry.pathParts);
}

function isDirtyGitWorktree(projectRoot: string): boolean {
  if (!existsSync(path.join(projectRoot, '.git'))) {
    return false;
  }
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim().length > 0;
}

async function preflightUpdate(
  projectRoot: string,
  entries: ReconcileEntry[],
  force: boolean
): Promise<void> {
  for (const entry of entries) {
    const writesDestination =
      entry.status === 'new' ||
      entry.status === 'missing' ||
      entry.status === 'upgrade' ||
      entry.status === 'moved' && (entry.cleanMove === true || force) ||
      entry.status === 'conflict' && force;
    if (writesDestination) {
      await resolveProjectPath(projectRoot, entry.pathParts);
    }
    if (
      entry.previousPathParts &&
      (entry.status === 'moved' && (entry.cleanMove === true || force) || entry.status === 'conflict' && force)
    ) {
      await resolveProjectPath(projectRoot, entry.previousPathParts);
    }
  }
  await resolveProjectPath(projectRoot, ['liftoff.manifest.json']);
}

function updateSnapshotKey(pathParts: readonly string[]): string {
  return pathParts.join('\0');
}

async function captureUpdateSnapshots(
  projectRoot: string,
  manifest: LiftoffManifest,
  render: readonly GeneratedArtifact[],
  initialSnapshots: readonly ProjectFileSnapshot[]
): Promise<ProjectFileSnapshot[]> {
  const snapshots = new Map(
    initialSnapshots.map((snapshot) => [updateSnapshotKey(snapshot.pathParts), snapshot])
  );
  const seenKeys = new Set(snapshots.keys());
  const candidates = [
    ...manifest.artifacts.map((artifact) => artifact.pathParts),
    ...render
      .filter((artifact) => artifact.category !== 'seed' && artifact.category !== 'framework')
      .map((artifact) => artifact.pathParts)
  ];
  const uncaptured: string[][] = [];
  for (const pathParts of candidates) {
    const key = updateSnapshotKey(pathParts);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      uncaptured.push(pathParts);
    }
  }
  for (const snapshot of await Promise.all(
    uncaptured.map((pathParts) => captureProjectFileSnapshot(projectRoot, pathParts))
  )) {
    snapshots.set(updateSnapshotKey(snapshot.pathParts), snapshot);
  }
  return [...snapshots.values()];
}

function selectUpdatePreconditions(
  snapshots: readonly ProjectFileSnapshot[],
  entries: readonly ReconcileEntry[],
  mutations: readonly ProjectFileMutation[]
): ProjectFileSnapshot[] {
  const requiredKeys = new Set([
    updateSnapshotKey(['liftoff.config.json']),
    ...mutations.map((mutation) => updateSnapshotKey(mutation.pathParts))
  ]);
  for (const entry of entries) {
    const adoptsExistingDestination =
      entry.status === 'moved' && entry.destinationMatches === true;
    if (
      !(entry.status === 'unchanged' && entry.refreshHash) &&
      !adoptsExistingDestination
    ) {
      continue;
    }
    requiredKeys.add(updateSnapshotKey(entry.pathParts));
    if (entry.previousPathParts) {
      requiredKeys.add(updateSnapshotKey(entry.previousPathParts));
    }
  }
  return snapshots.filter((snapshot) => requiredKeys.has(updateSnapshotKey(snapshot.pathParts)));
}

async function updateCommand(parsed: ParsedArgs, context: ExecutionContext): Promise<number> {
  const { presentation } = context;
  const check = readBooleanFlag(parsed.flags, 'check') ?? false;
  const force = readBooleanFlag(parsed.flags, 'force') ?? false;
  const jsonMode = readBooleanFlag(parsed.flags, 'json') ?? false;
  presentation.commandIdentity('update', 'Reconcile the project with current Liftoff templates');
  if (force && check) {
    presentation.error(
      '--force cannot be combined with --check.',
      'Run `liftoff update --check` to inspect drift or `liftoff update --force` to overwrite conflicts.'
    );
    return 1;
  }

  const explicit = parsed.positional[0] ?? readStringFlag(parsed.flags, 'project');
  const projectRoot = explicit ? path.resolve(context.cwd, explicit) : await findProjectRoot(context.cwd);
  if (!projectRoot) {
    presentation.error(
      `No liftoff.manifest.json found in ${context.cwd} or any parent directory.`,
      'Run this command inside a Liftoff project or provide its path explicitly.'
    );
    return 1;
  }

  const initialUpdateSnapshots = check
    ? []
    : await Promise.all([
        captureProjectFileSnapshot(projectRoot, ['liftoff.manifest.json']),
        captureProjectFileSnapshot(projectRoot, ['liftoff.config.json'])
      ]);
  const manifest = await loadManifest(projectRoot);
  if (compareSemver(manifest.liftoffVersion, liftoffVersion) > 0) {
    presentation.error(
      `This project was written by Liftoff ${manifest.liftoffVersion}, which is newer than this CLI (${liftoffVersion}).`,
      'Upgrade the CLI first.'
    );
    return 1;
  }

  const config = await loadConfigOptions('liftoff.config.json', projectRoot);
  const plan = buildProjectPlan(config, { requireProjectName: true });
  const recordedWorkload = manifest.project.workload;
  if (plan.workload !== recordedWorkload.kind) {
    const involvesPowerApps =
      plan.workload === 'power-apps-code-app' ||
      recordedWorkload.kind === 'power-apps-code-app';
    presentation.error(
      `Project type changes (${recordedWorkload.kind} -> ${plan.workload}) are not supported by update.`,
      involvesPowerApps
        ? 'Initialize a fresh project for the new workload.'
        : 'Run `liftoff migrate` instead.'
    );
    return 1;
  }
  if (plan.workload === 'power-apps-code-app' && recordedWorkload.kind === 'power-apps-code-app') {
    const recordedStarter = recordedWorkload.starter;
    const starterBaseline = supportedStack.upstreams['power-apps-code-app'];
    if (
      plan.starter.repository !== starterBaseline.repository ||
      plan.starter.path !== starterBaseline.path ||
      recordedStarter.repository !== starterBaseline.repository ||
      recordedStarter.path !== starterBaseline.path ||
      !starterBaseline.compatibleSourceCommits.includes(recordedStarter.commit)
    ) {
      presentation.error(
        'The Power Apps starter repository, path, or commit is not represented by this Liftoff release catalog.',
        'Restore the recorded source identity or use a Liftoff version that catalogs the transition.'
      );
      return 1;
    }
  } else if (plan.workload !== 'power-apps-code-app' && recordedWorkload.kind !== 'power-apps-code-app') {
    if (plan.apiStack.id !== recordedWorkload.apiStack) {
      presentation.error(
        `API stack changes (${recordedWorkload.apiStack} -> ${plan.apiStack.id}) are a migration, not an update.`,
        'Run `liftoff migrate` instead.'
      );
      return 1;
    }
    const recordedPattern = recordedWorkload.kind === 'genai' ? recordedWorkload.pattern : undefined;
    const desiredPattern = plan.workload === 'genai' ? plan.pattern.id : undefined;
    if (desiredPattern !== recordedPattern) {
      presentation.error(
        `Pattern changes (${recordedPattern ?? 'none'} -> ${desiredPattern ?? 'none'}) are a migration, not an update.`,
        'Run `liftoff migrate` instead.'
      );
      return 1;
    }
  }
  if (plan.specWorkflow.id !== manifest.project.specWorkflow) {
    presentation.error(
      `Spec workflow changes (${manifest.project.specWorkflow} -> ${plan.specWorkflow.id}) require official framework initialization and are not supported by liftoff update.`,
      'Restore the workflow recorded in liftoff.manifest.json or migrate into a fresh project.'
    );
    return 1;
  }
  const configuredAgents = plan.agents.map((agent) => agent.id);
  if (
    manifest.framework.state === 'initialized' && (
      configuredAgents.length !== manifest.project.agents.length ||
      configuredAgents.some((agent, index) => agent !== manifest.project.agents[index]) ||
      plan.defaultAgent?.id !== manifest.project.defaultAgent
    )
  ) {
    presentation.error(
      'AI agent or default-agent changes require official framework initialization and are not supported by liftoff update.',
      'Restore liftoff.config.json to the integrations recorded in liftoff.manifest.json.'
    );
    return 1;
  }

  const renderPlan = manifest.framework.state === 'legacy'
    ? { ...plan, agents: [], defaultAgent: undefined }
    : plan;
  const render = buildArtifacts(renderPlan);
  const updateSnapshots = check
    ? []
    : await captureUpdateSnapshots(projectRoot, manifest, render, initialUpdateSnapshots);
  const entries = await reconcileProject(manifest, render, projectRoot);
  const summary = summarizeEntries(entries);
  const manifestUpgradePending = manifest.artifactVersion !== 5;
  const starterUpgradePending =
    plan.workload === 'power-apps-code-app' &&
    recordedWorkload.kind === 'power-apps-code-app' &&
    recordedWorkload.starter.commit !== plan.starter.commit;
  const nonDurableNames = new Set(
    render
      .filter((artifact) => artifact.category === 'seed' || artifact.category === 'framework')
      .map((artifact) => artifact.logicalName)
  );
  const manifestOwnershipCleanupPending = manifest.artifacts.some((artifact) =>
    nonDurableNames.has(artifact.logicalName)
  ) || manifestHadFilteredLegacySeedOwnership(manifest);
  const manifestRewritePending =
    manifestUpgradePending ||
    manifestOwnershipCleanupPending ||
    starterUpgradePending;
  const drift = hasDrift(entries) || manifestRewritePending;
  const visible = entries.filter((entry) => entry.status !== 'unchanged' || entry.refreshHash);

  if (!drift) {
    if (jsonMode) {
      presentation.rawStdout(`${JSON.stringify(check ? {
        schemaVersion: 1,
        mode: 'check',
        cliVersion: liftoffVersion,
        projectVersion: manifest.liftoffVersion,
        entries: [],
        manifestUpgradePending,
        manifestOwnershipCleanupPending,
        summary
      } : {
        schemaVersion: 1,
        mode: 'apply',
        cliVersion: liftoffVersion,
        projectVersion: manifest.liftoffVersion,
        written: [],
        skipped: [],
        manifestUpgradePending,
        manifestOwnershipCleanupPending,
        summary
      }, null, 2)}\n`);
      return 0;
    }
    presentation.definitions('Project versions', [
      { label: 'Liftoff CLI', value: liftoffVersion },
      { label: 'Project generated by', value: manifest.liftoffVersion }
    ]);
    presentation.status(
      'success',
      'No drift',
      `${summary.unchanged} artifacts match the current templates and configuration`
    );
    return 0;
  }

  if (check) {
    if (jsonMode) {
      presentation.rawStdout(`${JSON.stringify({
        schemaVersion: 1,
        mode: 'check',
        cliVersion: liftoffVersion,
        projectVersion: manifest.liftoffVersion,
        entries: visible.map((entry) => ({
          logicalName: entry.logicalName,
          status: entry.status,
          path: manifestDisplayPath(entry.pathParts),
          previousPath: entry.previousPathParts ? manifestDisplayPath(entry.previousPathParts) : undefined,
          reason: entry.reason
        })),
        manifestUpgradePending,
        manifestOwnershipCleanupPending,
        summary
      }, null, 2)}\n`);
      return 2;
    }

    presentation.definitions('Project versions', [
      { label: 'Liftoff CLI', value: liftoffVersion },
      { label: 'Project generated by', value: manifest.liftoffVersion }
    ]);
    if (visible.length > 0) {
      if (presentation.stdout.layout === 'plain') {
        presentation.section(
          'Template drift',
          visible.map((entry) => `${entryMarker(entry)} ${entryDisplay(entry)}  ${entry.reason}`)
        );
      } else {
        presentation.table(
          'Template drift',
          ['Change', 'Artifact', 'Reason'],
          visible.map((entry) => [entryMarker(entry), entryDisplay(entry), entry.reason])
        );
      }
    }
    const manifestMaintenance = [
      manifestUpgradePending ? 'upgrade liftoff.manifest.json to schema v5' : undefined,
      manifestOwnershipCleanupPending
        ? 'remove obsolete seed or framework entries from durable manifest ownership'
        : undefined,
      starterUpgradePending
        ? `record the current packaged Power Apps starter ${plan.starter.commit}`
        : undefined
    ].filter((item): item is string => item !== undefined);
    if (manifestMaintenance.length > 0) {
      presentation.bullets('Manifest maintenance', manifestMaintenance);
    }
    const toWrite =
      summary.new +
      summary.missing +
      summary.upgrade +
      summary.moved +
      summary.refresh +
      (manifestRewritePending ? 1 : 0);
    presentation.status(
      'warning',
      'Drift detected',
      `${toWrite} to write, ${summary.conflict} conflict(s), ${summary.orphan} orphan(s), ${summary.unchanged} unchanged`
    );
    if (toWrite > 0) {
      presentation.command('liftoff update');
    }
    if (summary.conflict > 0) {
      presentation.command('liftoff update --force');
    }
    return 2;
  }

  if (isDirtyGitWorktree(projectRoot)) {
    const warning =
      'The project worktree has uncommitted changes; consider committing before applying.';
    if (jsonMode) {
      presentation.rawStderr(`Warning: ${warning}\n`);
    } else {
      presentation.warning(warning);
    }
  }
  presentation.stage('Apply safe template changes', projectRoot);
  await preflightUpdate(projectRoot, entries, force);

  const written: ReconcileEntry[] = [];
  const skipped: ReconcileEntry[] = [];
  const mutations: ProjectFileMutation[] = [];
  for (const entry of entries) {
    switch (entry.status) {
      case 'new':
      case 'missing':
      case 'upgrade':
        mutations.push({
          type: 'write',
          pathParts: entry.pathParts,
          content: entry.rendered!.content
        });
        written.push(entry);
        break;
      case 'moved':
        if (entry.cleanMove || force) {
          if (!entry.destinationMatches) {
            mutations.push({
              type: 'write',
              pathParts: entry.pathParts,
              content: entry.rendered!.content
            });
          }
          mutations.push({ type: 'delete', pathParts: entry.previousPathParts! });
          written.push(entry);
        } else {
          skipped.push(entry);
        }
        break;
      case 'conflict':
        if (force) {
          mutations.push({
            type: 'write',
            pathParts: entry.pathParts,
            content: entry.rendered!.content
          });
          if (entry.previousPathParts) {
            mutations.push({ type: 'delete', pathParts: entry.previousPathParts });
          }
          written.push(entry);
        } else {
          skipped.push(entry);
        }
        break;
      default:
        break;
    }
  }

  const oldByName = new Map(manifest.artifacts.map((artifact) => [artifact.logicalName, artifact]));
  const skippedByName = new Map(skipped.map((entry) => [entry.logicalName, entry]));
  const hasUnrecordedGovernanceConflict = skipped.some((entry) =>
    entry.status === 'conflict' &&
    entry.rendered?.category === 'governance' &&
    !oldByName.has(entry.logicalName)
  );
  const nextManifest = buildManifest(
    plan,
    render.filter((artifact) => artifact.logicalName !== 'manifest'),
    { frameworkState: manifest.framework.state }
  );
  nextManifest.framework = manifest.framework;
  nextManifest.project.specWorkflow = manifest.project.specWorkflow;
  nextManifest.project.agents = manifest.project.agents;
  if (manifest.project.defaultAgent) {
    nextManifest.project.defaultAgent = manifest.project.defaultAgent;
  } else {
    delete nextManifest.project.defaultAgent;
  }
  if (
    hasUnrecordedGovernanceConflict &&
    nextManifest.governance.profile !== 'none'
  ) {
    nextManifest.governance.state = 'handoff-partial';
  }
  nextManifest.artifacts = nextManifest.artifacts.flatMap((artifact) => {
    // config is user-owned after create: carry the recorded entry forward untouched
    if (artifact.logicalName === 'liftoff-config') {
      return [oldByName.get('liftoff-config') ?? artifact];
    }
    if (!skippedByName.has(artifact.logicalName)) {
      return [artifact];
    }
    const previous = oldByName.get(artifact.logicalName);
    if (!previous) {
      return [];
    }
    return [{ ...artifact, pathParts: previous.pathParts, contentHash: previous.contentHash }];
  });
  for (const entry of entries) {
    if (entry.status === 'orphan') {
      const previous = oldByName.get(entry.logicalName)!;
      if (
        plan.governanceProfile.id === 'none' &&
        previous.category === 'governance'
      ) {
        continue;
      }
      nextManifest.artifacts.push(previous);
    }
  }
  mutations.push({
    type: 'write',
    pathParts: ['liftoff.manifest.json'],
    content: `${JSON.stringify(nextManifest, null, 2)}\n`
  });
  await applyProjectFileTransaction(projectRoot, mutations, {
    preconditions: selectUpdatePreconditions(updateSnapshots, entries, mutations)
  });

  if (jsonMode) {
    presentation.rawStdout(`${JSON.stringify({
      schemaVersion: 1,
      mode: 'apply',
      cliVersion: liftoffVersion,
      projectVersion: manifest.liftoffVersion,
      written: written.map((entry) => manifestDisplayPath(entry.pathParts)),
      skipped: skipped.map((entry) => ({ path: manifestDisplayPath(entry.pathParts), reason: entry.reason })),
      manifestUpgradePending,
      manifestOwnershipCleanupPending,
      summary
    }, null, 2)}\n`);
    return 0;
  }

  if (written.length > 0) {
    presentation.bullets(
      'Applied changes',
      written.map((entry) => `wrote ${entryDisplay(entry)}`)
    );
  }
  if (skipped.length > 0) {
    presentation.bullets(
      'Skipped conflicts',
      skipped.map((entry) =>
        `skipped ${entryDisplay(entry)}  ${entry.reason}${force ? '' : ' (use --force to overwrite)'}`
      )
    );
  }
  const orphans = entries.filter((entry) => entry.status === 'orphan');
  if (orphans.length > 0) {
    presentation.bullets(
      'Orphaned artifacts',
      orphans.map((entry) => `orphan ${entryDisplay(entry)}  ${entry.reason}`)
    );
  }
  presentation.completion(
    'Updated project',
    `${written.length} written, ${skipped.length} skipped, ${summary.orphan} orphan(s)`,
    [{ label: 'Manifest version', value: liftoffVersion }],
    'liftoff validate && liftoff doctor'
  );
  return 0;
}

function renderSelfUpgradeResult(
  value: SelfUpgradeResult,
  presentation: PresentationSession
): void {
  const details = [
    { label: 'Current CLI', value: value.currentVersion },
    ...('targetVersion' in value && value.targetVersion
      ? [{ label: 'Canonical target', value: value.targetVersion }]
      : []),
    ...('registryKind' in value && value.registryKind
      ? [{ label: 'Delivery registry', value: value.registryKind }]
      : [])
  ];
  presentation.definitions('CLI upgrade result', details);
  switch (value.status) {
    case 'current':
      presentation.status('success', 'CLI is current', selfUpgradeSummary(value));
      return;
    case 'update-available':
      presentation.status('warning', 'CLI update available', selfUpgradeSummary(value));
      presentation.command('liftoff upgrade');
      return;
    case 'upgraded':
      presentation.completion(
        'Liftoff CLI upgraded',
        selfUpgradeSummary(value),
        [{ label: 'Installed version', value: value.targetVersion }],
        'liftoff update --check'
      );
      return;
    case 'blocked':
    case 'failed': {
      presentation.status(
        value.status === 'blocked' ? 'warning' : 'error',
        value.status === 'blocked' ? 'CLI upgrade blocked' : 'CLI upgrade failed',
        selfUpgradeSummary(value)
      );
      const remedy = selfUpgradeRemedy(value);
      if (remedy) {
        presentation.remedy(remedy);
      }
      return;
    }
    default: {
      const exhaustive: never = value;
      throw new Error(`Unhandled self-upgrade result: ${String(exhaustive)}`);
    }
  }
}

async function upgradeCommand(
  parsed: ParsedArgs,
  context: ExecutionContext
): Promise<number> {
  const mode = readBooleanFlag(parsed.flags, 'check') === true ? 'check' : 'apply';
  const json = readBooleanFlag(parsed.flags, 'json') === true;
  if (!json) {
    context.presentation.commandIdentity(
      'upgrade',
      'Replace the supported global Liftoff CLI installation'
    );
  }
  const execute = context.selfUpgrade ?? ((request) =>
    runSelfUpgrade(request, {
      environment: context.env ?? process.env
    }));
  let value: SelfUpgradeResult;
  try {
    value = await execute({
      mode,
      currentVersion: liftoffVersion,
      stdout: context.stdout,
      stderr: context.stderr,
      json,
      ...(!json
        ? {
            onStage: (stage: Parameters<NonNullable<Parameters<typeof runSelfUpgrade>[0]['onStage']>>[0], detail?: string) =>
              context.presentation.stage(stage, detail),
            onInstallCommand: (command: Parameters<NonNullable<Parameters<typeof runSelfUpgrade>[0]['onInstallCommand']>>[0]) =>
              context.presentation.command(formatCommand(command))
          }
        : {})
    });
  } catch {
    value = {
      schemaVersion: 1,
      mode,
      status: 'failed',
      currentVersion: liftoffVersion,
      reasonCode: 'verification_failed'
    };
  }
  if (json) {
    context.presentation.rawStdout(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    renderSelfUpgradeResult(value, context.presentation);
  }
  return selfUpgradeExitCode(value);
}

interface DoctorCheck {
  id?: string;
  label: string;
  severity: 'ok' | 'warn' | 'fail' | 'skipped';
  state?: string;
  requirementSeverity?: 'blocking' | 'advisory';
  detail: string;
  remedy?: string;
}

interface DoctorLayer {
  title: string;
  checks: DoctorCheck[];
}

function versionedBinaryCheck(
  label: string,
  command: string,
  args: string[],
  minimum: readonly [number, number],
  remedy: string
): DoctorCheck {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    return { label, severity: 'fail', detail: 'not found', remedy };
  }

  const output = (result.stdout || result.stderr).split('\n')[0].trim();
  const match = output.match(/(\d+)\.(\d+)/);
  if (!match) {
    return { label, severity: 'fail', detail: `unable to determine version from "${output}"`, remedy };
  }
  const found: readonly [number, number] = [Number(match[1]), Number(match[2])];
  if (found[0] < minimum[0] || found[0] === minimum[0] && found[1] < minimum[1]) {
    return { label, severity: 'fail', detail: `${output} is below ${minimum.join('.')}`, remedy };
  }
  return { label, severity: 'ok', detail: output };
}

function pythonRuntime(): { command: string; versionArgs: string[]; commandArgs: string[] } | undefined {
  const [major, minor] = (
    supportedStack.runtimes.python.minimumVersion ??
    supportedStack.runtimes.python.version
  ).split('.');
  const minimum: readonly [number, number] = [Number(major), Number(minor)];
  const candidates = process.platform === 'win32'
    ? [
      { command: 'py', versionArgs: ['-3', '--version'], commandArgs: ['-3'] },
      { command: 'python', versionArgs: ['--version'], commandArgs: [] },
      { command: 'python3', versionArgs: ['--version'], commandArgs: [] }
    ]
    : [
      { command: 'python3', versionArgs: ['--version'], commandArgs: [] },
      { command: 'python', versionArgs: ['--version'], commandArgs: [] }
    ];
  return candidates.find((candidate) =>
    versionedBinaryCheck(
      'python',
      candidate.command,
      candidate.versionArgs,
      minimum,
      `install Python ${major}.${minor} or newer`
    ).severity === 'ok'
  ) ?? candidates.find((candidate) => binaryPresent(candidate.command));
}

function doctorCheckFromProbe(probe: RequirementProbeResult): DoctorCheck {
  const severity = probe.state === 'ready'
    ? 'ok'
    : probe.requirement.severity === 'blocking'
      ? 'fail'
      : 'warn';
  return {
    id: probe.requirement.id,
    label: probe.requirement.id,
    severity,
    state: probe.state,
    requirementSeverity: probe.requirement.severity,
    detail: probe.detail,
    ...(probe.remedy ? { remedy: probe.remedy } : {})
  };
}

function noticeId(requirementId: string, label: string): string {
  const suffix = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${requirementId}:${suffix}`;
}

function workstationLayer(probes: RequirementProbeResult[]): DoctorLayer {
  const checks = probes.flatMap((probe): DoctorCheck[] => [
    doctorCheckFromProbe(probe),
    ...probe.notices.map((notice): DoctorCheck => ({
      id: noticeId(probe.requirement.id, notice.label),
      label: notice.label,
      severity: notice.state === 'ready' ? 'ok' : 'warn',
      state: notice.state,
      requirementSeverity: 'advisory',
      detail: notice.detail,
      ...(notice.remedy ? { remedy: notice.remedy } : {})
    }))
  ]);
  return { title: 'Environment', checks };
}

function workstationSelectionFromManifest(manifest: LiftoffManifest): WorkstationRequirementSelection {
  const framework = getFrameworkDefinition(manifest.project.specWorkflow);
  const workload = manifest.project.workload;
  return {
    workload: workload.kind === 'power-apps-code-app'
      ? { kind: 'power-apps-code-app' }
      : {
          kind: workload.kind,
          apiStack: { id: workload.apiStack },
          provider: { id: workload.cloud }
        },
    specWorkflow: { id: manifest.project.specWorkflow },
    framework: { version: framework.version },
    agents: manifest.framework.state === 'initialized'
      ? manifest.project.agents.map((id) => {
          const agent = getCodingAgent(id);
          if (!agent) {
            throw new Error(`Manifest references unknown coding agent ${id}.`);
          }
          return { id: agent.id, label: agent.label };
        })
      : []
  };
}

async function frameworkDoctorChecks(
  projectRoot: string,
  manifest: LiftoffManifest
): Promise<DoctorCheck[]> {
  if (manifest.framework.state === 'legacy') {
    return [{
      id: 'framework-legacy-state',
      label: 'framework state',
      severity: 'warn',
      state: 'not-observable',
      detail: `Legacy v${manifest.artifactVersion} manifest does not prove official ${manifest.framework.adapter} initialization or configured coding agents.`,
      remedy: 'Reinitialize the framework explicitly before recording a v3 initialized framework contract.'
    }];
  }

  const expected = getFrameworkDefinition(manifest.framework.adapter);
  const frameworkLabel = getSpecWorkflow(manifest.framework.adapter)?.label ?? manifest.framework.adapter;
  const contract = manifest.framework.contractVersion === expected.version
    ? {
        id: 'framework-contract',
        label: 'framework contract',
        severity: 'ok' as const,
        state: 'ready',
        detail: `${frameworkLabel} ${expected.version}`
      }
    : {
        id: 'framework-contract',
        label: 'framework contract',
        severity: 'fail' as const,
        state: 'outdated',
        detail: `Manifest records ${manifest.framework.contractVersion}; this Liftoff version requires ${expected.version}.`,
        remedy: `Install ${frameworkLabel} ${expected.version} and reinitialize its integrations.`
      };
  const markerIssues = await validateFrameworkInstallation(projectRoot, {
    workflow: manifest.framework.adapter,
    agents: manifest.project.agents,
    ...(manifest.project.defaultAgent ? { defaultAgent: manifest.project.defaultAgent } : {})
  });
  const markers: DoctorCheck = markerIssues.length === 0
    ? {
        id: 'framework-markers',
        label: 'framework markers',
        severity: 'ok',
        state: 'ready',
        detail: `${manifest.project.agents.length} selected integration${manifest.project.agents.length === 1 ? '' : 's'} verified`
      }
    : {
        id: 'framework-markers',
        label: 'framework markers',
        severity: 'fail',
        state: 'unhealthy',
        detail: `${markerIssues.length} issue(s): ${markerIssues[0]}`,
        remedy: `Run the official ${frameworkLabel} initializer for the selected integrations.`
      };
  return [
    contract,
    {
      id: 'selected-agents',
      label: 'selected agents',
      severity: 'ok',
      state: 'ready',
      detail: manifest.project.agents.join(', ')
    },
    markers
  ];
}

function stackProjectCheck(projectRoot: string, apiStack: ApiStackId): DoctorCheck {
  const requiredMetadata: Record<ApiStackId, string[]> = {
    'python-fastapi': ['backend/pyproject.toml', 'backend/uv.lock'],
    'node-fastify': ['backend/package.json', 'backend/package-lock.json'],
    'go-huma': ['backend/go.mod', 'backend/go.sum']
  };
  const missingMetadata = requiredMetadata[apiStack].find(
    (relativePath) => !existsSync(path.join(projectRoot, ...relativePath.split('/')))
  );
  if (missingMetadata) {
    return {
      label: `${apiStack} project`,
      severity: 'fail',
      detail: `missing locked dependency metadata: ${missingMetadata}`,
      remedy: `restore ${missingMetadata} or run liftoff update`
    };
  }
  if (apiStack === 'python-fastapi') {
    const pyproject = readFileSync(path.join(projectRoot, 'backend', 'pyproject.toml'), 'utf8');
    const lock = readFileSync(path.join(projectRoot, 'backend', 'uv.lock'), 'utf8');
    const projectName = pyproject.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
    const lockedProjectName = lock.match(
      /\[\[package\]\]\s+name\s*=\s*"([^"]+)"\s+version\s*=\s*"[^"]+"\s+source\s*=\s*\{\s*editable\s*=\s*"\."\s*\}/m
    )?.[1];
    if (!projectName || lockedProjectName !== projectName) {
      return {
        label: `${apiStack} project`,
        severity: 'fail',
        detail: 'pyproject.toml and uv.lock do not identify the same project',
        remedy: 'restore backend/pyproject.toml and backend/uv.lock or run liftoff update'
      };
    }
  }
  let result: { status: number | null; stdout: string; stderr: string };
  switch (apiStack) {
    case 'python-fastapi':
      {
        const python = pythonRuntime();
        if (!python) {
          return { label: 'python project', severity: 'skipped', detail: 'python is unavailable' };
        }

        result = runReadOnly(
          python.command,
          [...python.commandArgs, '-c', 'from pathlib import Path; p=Path("backend/apis/main.py"); compile(p.read_text(), str(p), "exec")'],
          projectRoot
        );
      }
      break;
    case 'node-fastify':
      result = runReadOnly(
        'node',
        ['-e', 'const f=require("fs"); JSON.parse(f.readFileSync("backend/package.json")); JSON.parse(f.readFileSync("backend/tsconfig.json"));'],
        projectRoot
      );
      break;
    case 'go-huma':
      if (!binaryPresent('go')) {
        return { label: 'go project', severity: 'skipped', detail: 'go is unavailable' };
      }
      result = runReadOnly('go', ['mod', 'edit', '-json'], path.join(projectRoot, 'backend'));
      break;
  }

  if (result.status === 0) {
    return { label: `${apiStack} project`, severity: 'ok', detail: 'stack configuration is valid' };
  }
  return {
    label: `${apiStack} project`,
    severity: 'fail',
    detail: (result.stderr || result.stdout || 'stack validation failed').split('\n')[0],
    remedy: `repair the generated ${apiStack} backend configuration`
  };
}

async function powerAppsProjectCheck(projectRoot: string): Promise<DoctorCheck> {
  const issues = await verifyPowerAppsPackageMetadata(projectRoot);
  if (issues.length === 0) {
    return {
      id: 'power-apps-project',
      label: 'Power Apps project',
      severity: 'ok',
      state: 'ready',
      detail: 'SDK, Vite plugin, and deterministic lockfile metadata are valid'
    };
  }
  return {
    id: 'power-apps-project',
    label: 'Power Apps project',
    severity: 'fail',
    state: 'unhealthy',
    detail: issues[0],
    remedy: 'restore package.json and package-lock.json or run liftoff update'
  };
}

function runReadOnly(command: string, args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function binaryPresent(command: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [command], { encoding: 'utf8' }).status === 0;
}

async function azureCloudChecks(runner: CommandRunner): Promise<DoctorCheck[]> {
  const auth = await runner.run(
    { executable: 'az', args: ['account', 'show', '-o', 'none', '--only-show-errors'] },
    { timeoutMs: 15_000 }
  );
  if (auth.errorCode === 'ENOENT') {
    return [{ label: 'az', severity: 'warn', detail: 'Azure CLI not found', remedy: 'install the Azure CLI' }];
  }
  if (auth.status === 0) {
    return [{ label: 'azure auth', severity: 'ok', detail: 'authenticated' }];
  }
  return [{ label: 'azure auth', severity: 'warn', detail: 'not authenticated', remedy: 'run az login' }];
}

// ponytail: provider-keyed map so aws/gcp checks slot in when their adapters land
const CLOUD_CHECKS: Record<string, (runner: CommandRunner) => Promise<DoctorCheck[]>> = {
  azure: azureCloudChecks
};

async function cloudLayer(cloud: string, runner: CommandRunner): Promise<DoctorLayer> {
  const checks = CLOUD_CHECKS[cloud]
    ? await CLOUD_CHECKS[cloud](runner)
    : [{ label: cloud, severity: 'skipped' as const, detail: `${cloud} provider checks are not available yet` }];
  return { title: `Cloud - ${cloud}`, checks };
}

async function cliLayer(
  releaseLookup: () => Promise<StableRelease>,
  configuredRegistryLookup: ConfiguredRegistryTargetLookup
): Promise<DoctorLayer> {
  const checks: DoctorCheck[] = [
    { label: 'version', severity: 'ok', detail: `Liftoff ${liftoffVersion}` }
  ];
  let latest: string;
  try {
    latest = (await releaseLookup()).version;
  } catch {
    return { title: 'CLI', checks };
  }

  if (compareSemver(latest, liftoffVersion) > 0) {
    let registryState: Awaited<ReturnType<ConfiguredRegistryTargetLookup>> = {
      status: 'unavailable'
    };
    try {
      registryState = await configuredRegistryLookup(latest);
    } catch {
      // Canonical freshness remains useful when local npm registry inspection fails.
    }
    const manual = canonicalManualInstallCommand(latest);
    checks.push({
      label: 'cli freshness',
      severity: 'warn',
      detail: registryState.status === 'stale'
        ? `Liftoff ${latest} is published, but the configured npm registry does not expose it`
        : `Liftoff ${latest} is published, this CLI is ${liftoffVersion}`,
      remedy: registryState.status === 'stale'
        ? 'ask the managed registry owner to synchronize the canonical target, then run liftoff upgrade --check'
        : `run liftoff upgrade --check, then liftoff upgrade; manual fallback where canonical npm is permitted: ${manual}`
    });
  } else {
    checks.push({
      label: 'cli freshness',
      severity: 'ok',
      detail: `running ${liftoffVersion}, latest stable ${latest}`
    });
  }
  return { title: 'CLI', checks };
}

async function projectLayer(projectRoot: string, manifest: LiftoffManifest): Promise<DoctorLayer> {
  const checks: DoctorCheck[] = [];

  const issues = await validateGeneratedProject(projectRoot);
  if (issues.length > 0) {
    checks.push({
      label: 'manifest',
      severity: 'fail',
      detail: `${issues.length} issue(s): ${issues[0]}${issues.length > 1 ? ' ...' : ''}`,
      remedy: 'restore missing artifacts or run liftoff update'
    });
  } else {
    checks.push({ label: 'manifest', severity: 'ok', detail: `valid, ${manifest.artifacts.length} artifacts present` });
  }

  if (compareSemver(manifest.liftoffVersion, liftoffVersion) > 0) {
    checks.push({
      label: 'version',
      severity: 'warn',
      detail: `project written by Liftoff ${manifest.liftoffVersion}, CLI is ${liftoffVersion}`,
      remedy: `run liftoff upgrade --check, then liftoff upgrade; manual fallback: ${canonicalManualInstallCommand(manifest.liftoffVersion)}`
    });
  } else {
    checks.push({ label: 'version', severity: 'ok', detail: `generated by ${manifest.liftoffVersion}, CLI ${liftoffVersion}` });
  }

  if (manifest.governance.profile === 'unspecified') {
    checks.push({
      id: 'repository-governance',
      label: 'repository governance',
      severity: 'warn',
      state: 'not-observable',
      detail: 'manifest predates local governance handoff state',
      remedy: 'run liftoff update --check to inspect default handoff adoption'
    });
  } else if (manifest.governance.profile === 'none') {
    checks.push({
      id: 'repository-governance',
      label: 'repository governance',
      severity: 'ok',
      state: 'disabled',
      detail: 'disabled; no local handoff or live-enforcement claim'
    });
  } else {
    const governanceIssue = issues.find((issue) =>
      /governance|repository-governance/i.test(issue)
    );
    const partialHandoff = manifest.governance.state === 'handoff-partial';
    const severity = governanceIssue ? 'fail' : partialHandoff ? 'warn' : 'ok';
    const detail = governanceIssue ??
      (partialHandoff
        ? `local ${manifest.governance.profile} policy ${manifest.governance.policyVersion} handoff is incomplete; one or more exact destinations remain outside Liftoff ownership`
        : `local ${manifest.governance.profile} policy ${manifest.governance.policyVersion} handoff is intact; live enforcement is not inferred`);
    const remedy = governanceIssue
      ? 'inspect with liftoff update --check; run liftoff update for safe repairs or use --force only after reviewing exact conflicts; neither activates GitHub governance'
      : partialHandoff
        ? 'inspect liftoff update --check; use liftoff update --force only after reviewing each governance conflict'
        : undefined;
    checks.push({
      id: 'repository-governance',
      label: 'repository governance',
      severity,
      state: governanceIssue ? 'unhealthy' : manifest.governance.state,
      detail,
      ...(remedy ? { remedy } : {})
    });
  }

  checks.push(...await frameworkDoctorChecks(projectRoot, manifest));
  if (manifest.project.workload.kind === 'power-apps-code-app') {
    const starter = manifest.project.workload.starter;
    checks.push({
      id: 'power-apps-starter',
      label: 'Power Apps starter',
      severity: 'ok',
      state: 'ready',
      detail: `${starter.repository}/${starter.path} @ ${starter.commit}`
    });
    checks.push(await powerAppsProjectCheck(projectRoot));
  } else {
    checks.push(stackProjectCheck(projectRoot, manifest.project.workload.apiStack));
  }

  try {
    const config = await loadConfigOptions('liftoff.config.json', projectRoot);
    const plan = buildProjectPlan(config, { requireProjectName: true });
    const render = buildArtifacts(plan);
    const entries = await reconcileProject(manifest, render, projectRoot);
    const driftCount = entries.filter((entry) => entry.status !== 'unchanged' || entry.refreshHash).length;
    if (driftCount > 0) {
      checks.push({
        label: 'scaffold drift',
        severity: 'warn',
        detail: `${driftCount} update(s) available`,
        remedy: 'run liftoff update'
      });
    } else {
      checks.push({ label: 'scaffold drift', severity: 'ok', detail: 'project matches the current templates' });
    }
  } catch (error) {
    checks.push({
      label: 'scaffold drift',
      severity: 'fail',
      detail: `liftoff.config.json could not be evaluated: ${(error as Error).message.split('\n')[0]}`,
      remedy: 'repair liftoff.config.json'
    });
  }

  return { title: 'Project', checks };
}

async function runtimeLayer(
  projectRoot: string,
  dockerAvailable: boolean,
  runner: CommandRunner,
  manifest: LiftoffManifest
): Promise<DoctorLayer> {
  const checks: DoctorCheck[] = [];
  if (manifest.project.workload.kind === 'power-apps-code-app') {
    if (!existsSync(path.join(projectRoot, 'node_modules'))) {
      checks.push({
        id: 'power-apps-cli',
        label: 'Power Apps CLI',
        severity: 'skipped',
        state: 'not-observable',
        detail: 'project dependencies are not installed',
        remedy: 'run npm ci, then rerun liftoff doctor'
      });
      return { title: 'Runtime', checks };
    }
    const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const result = await runner.run(
      { executable, args: ['--no-install', 'power-apps', '--version'] },
      { cwd: projectRoot, timeoutMs: 15_000 }
    );
    checks.push(result.status === 0
      ? {
          id: 'power-apps-cli',
          label: 'Power Apps CLI',
          severity: 'ok',
          state: 'ready',
          detail: result.stdout.trim() || 'local CLI is available'
        }
      : {
          id: 'power-apps-cli',
          label: 'Power Apps CLI',
          severity: 'fail',
          state: 'unhealthy',
          detail: (result.stderr || 'local CLI probe failed').trim().split('\n')[0],
          remedy: 'run npm ci and verify @microsoft/power-apps before binding the environment'
        });
    return { title: 'Runtime', checks };
  }

  if (existsSync(path.join(projectRoot, '.env.example'))) {
    if (existsSync(path.join(projectRoot, '.env'))) {
      checks.push({ label: '.env', severity: 'ok', detail: 'present' });
    } else {
      checks.push({ label: '.env', severity: 'fail', detail: 'missing', remedy: 'copy .env.example to .env' });
    }
  } else {
    checks.push({ label: '.env', severity: 'skipped', detail: 'no .env.example in this project' });
  }

  if (!existsSync(path.join(projectRoot, 'docker-compose.yml'))) {
    checks.push({ label: 'compose', severity: 'skipped', detail: 'no docker-compose.yml in this project' });
  } else if (!dockerAvailable) {
    checks.push({ label: 'compose', severity: 'skipped', detail: 'docker is not installed, compose config not checked' });
  } else {
    const result = await runner.run(
      { executable: 'docker', args: ['compose', 'config', '-q'] },
      { cwd: projectRoot, timeoutMs: 15_000 }
    );
    if (result.status === 0) {
      checks.push({ label: 'compose', severity: 'ok', detail: 'docker compose config is valid' });
    } else {
      checks.push({
        label: 'compose',
        severity: 'fail',
        detail: (result.stderr || 'docker compose config failed').split('\n')[0],
        remedy: 'fix docker-compose.yml'
      });
    }
  }

  return { title: 'Runtime', checks };
}

async function codeAppsPluginLayer(
  projectRoot: string,
  manifest: LiftoffManifest,
  runner: CommandRunner
): Promise<DoctorLayer> {
  const agents = manifest.project.agents.map((id) => {
    const agent = getCodingAgent(id);
    if (!agent) {
      throw new Error(`Manifest references unknown coding agent ${id}.`);
    }
    return agent;
  });
  const probes = await probeCodeAppsPlugin(agents, runner, projectRoot);
  return {
    title: 'Optional Code Apps plugin',
    checks: probes.map((probe): DoctorCheck => ({
      id: probe.id,
      label: probe.agent.label,
      severity: probe.state === 'ready' ? 'ok' : 'warn',
      state: probe.state,
      requirementSeverity: 'advisory',
      detail: probe.detail,
      ...(probe.remedy ? { remedy: probe.remedy } : {})
    }))
  };
}

function renderDoctorLayers(layers: DoctorLayer[], presentation: PresentationSession): void {
  const statusKind = {
    ok: 'success',
    warn: 'warning',
    fail: 'error',
    skipped: 'pending'
  } as const;
  for (const layer of layers) {
    presentation.section(layer.title, layer.checks.flatMap((check) => {
      const remedy = check.remedy ? ` - ${check.remedy}` : '';
      return presentation.stdout
        .status(statusKind[check.severity], check.label, `${check.detail}${remedy}`)
        .trimEnd()
        .split('\n');
    }));
  }
}

export function doctorExitCode(layers: DoctorLayer[]): number {
  return layers.some((layer) => layer.checks.some((check) => check.severity === 'fail')) ? 1 : 0;
}

async function doctorCommand(parsed: ParsedArgs, context: ExecutionContext): Promise<number> {
  const jsonMode = readBooleanFlag(parsed.flags, 'json') ?? false;
  const cloudOverride = readStringFlag(parsed.flags, 'cloud');
  const layers: DoctorLayer[] = [];
  context.presentation.commandIdentity('doctor', 'Inspect CLI, workstation, project, runtime, and cloud readiness');
  const runner = context.runner ?? new NodeCommandRunner();

  const projectRoot = await findProjectRoot(context.cwd);
  let manifest: LiftoffManifest | undefined;
  let manifestError: Error | undefined;
  if (projectRoot) {
    try {
      manifest = await loadManifest(projectRoot);
    } catch (error) {
      manifestError = error as Error;
    }
  }

  const releaseLookup = context.stableReleaseLookup ?? (() =>
    lookupStableRelease({
      registry: context.env?.LIFTOFF_REGISTRY ??
        process.env.LIFTOFF_REGISTRY ??
        canonicalNpmRegistry
    }));
  const configuredRegistryLookup =
    context.configuredRegistryTargetLookup ??
    ((targetVersion) => checkConfiguredRegistryTarget(targetVersion, {
      runner,
      environment: context.env ?? process.env
    }));
  layers.push(await cliLayer(releaseLookup, configuredRegistryLookup));
  const requirements = manifest
    ? selectWorkstationRequirements(
        workstationSelectionFromManifest(manifest),
        { includeFramework: manifest.framework.state === 'initialized' }
      )
    : selectLiftoffRuntimeRequirements();
  const probes = await probeWorkstation(requirements, runner);
  const environment = workstationLayer(probes);
  layers.push(environment);
  const dockerAvailable = probes.some((probe) => probe.requirement.id === 'docker' && probe.state === 'ready');

  if (projectRoot) {
    if (manifestError) {
      layers.push({
        title: 'Project',
        checks: [{ label: 'manifest', severity: 'fail', detail: manifestError.message, remedy: 'regenerate the project or use a matching CLI version' }]
      });
    }

    if (manifest) {
      layers.push(await projectLayer(projectRoot, manifest));
      layers.push(await runtimeLayer(projectRoot, dockerAvailable, runner, manifest));

      if (manifest.project.workload.kind === 'power-apps-code-app') {
        if (manifest.project.workload.codeAppsPlugin) {
          layers.push(await codeAppsPluginLayer(projectRoot, manifest, runner));
        }
      } else {
        const workload = manifest.project.workload;
        const cloud = cloudOverride ?? workload.cloud;
        const cloudChecks = await cloudLayer(cloud, runner);
        const pattern = workload.kind === 'genai'
          ? patterns.find((candidate) => candidate.id === workload.pattern)
          : undefined;
        if (pattern?.worker && cloud === 'azure') {
          cloudChecks.checks.push(
            binaryPresent('func')
              ? { label: 'functions tooling', severity: 'ok', detail: 'Azure Functions Core Tools installed' }
              : { label: 'functions tooling', severity: 'warn', detail: 'Azure Functions Core Tools not found', remedy: 'npm install -g azure-functions-core-tools@4' }
          );
        }
        layers.push(cloudChecks);
      }
    }
  } else if (cloudOverride) {
    layers.push(await cloudLayer(cloudOverride, runner));
  }

  const failures = layers.reduce((count, layer) => count + layer.checks.filter((check) => check.severity === 'fail').length, 0);
  const warnings = layers.reduce((count, layer) => count + layer.checks.filter((check) => check.severity === 'warn').length, 0);

  if (jsonMode) {
    context.presentation.rawStdout(
      `${JSON.stringify({ schemaVersion: 1, layers, summary: { failures, warnings } }, null, 2)}\n`
    );
  } else {
    renderDoctorLayers(layers, context.presentation);
    context.presentation.status(
      failures > 0 ? 'error' : warnings > 0 ? 'warning' : 'success',
      'Doctor summary',
      `${failures} failure(s), ${warnings} warning(s)`
    );
  }

  return doctorExitCode(layers);
}

async function helperCommand(
  parsed: ParsedArgs,
  context: ExecutionContext,
  tool: 'docker compose' | 'tofu'
): Promise<number> {
  const projectRoot = await findProjectRoot(context.cwd);
  if (projectRoot) {
    const manifest = await loadManifest(projectRoot);
    if (manifest.project.workload.kind === 'power-apps-code-app') {
      if (parsed.command === 'dev') {
        context.presentation.commandIdentity('dev', 'Power Apps local development');
        context.presentation.section(
          'Dependency prerequisite',
          ['Install the root lockfile before starting or after dependency changes.']
        );
        context.presentation.command('npm ci');
        context.presentation.section('Development server', []);
        context.presentation.command('npm run dev');
        return 0;
      }
      context.presentation.commandIdentity('infra', 'Power Apps hosting responsibility');
      context.presentation.status(
        'info',
        'Not applicable',
        'Power Apps code apps are hosted by Power Platform; Liftoff-managed OpenTofu infrastructure is not generated.'
      );
      return 0;
    }
  }

  const command = parsed.command === 'dev' ? buildDevCommand(parsed) : buildInfraCommand(parsed);
  context.presentation.commandIdentity(
    parsed.command ?? tool,
    `${tool} helper command`
  );
  context.presentation.section(`${tool} helper command`, []);
  context.presentation.command(command);
  return 0;
}

function buildDevCommand(parsed: ParsedArgs): string {
  switch (parsed.subcommand) {
    case 'down':
      return 'docker compose down';
    case 'logs':
      return 'docker compose logs -f';
    case 'reset':
      return 'docker compose down --volumes';
    case 'up':
    default: {
      const profile = readStringFlag(parsed.flags, 'profile');
      return profile ? `docker compose --profile ${profile} up --build` : 'docker compose up --build';
    }
  }
}

function buildInfraCommand(parsed: ParsedArgs): string {
  const env = readStringFlag(parsed.flags, 'env') ?? 'dev';
  switch (parsed.subcommand) {
    case 'apply':
      return `tofu apply -var-file=environments/${env}.tfvars`;
    case 'output':
      return 'tofu output';
    case 'init':
      return 'tofu init';
    case 'plan':
    default:
      return `tofu plan -var-file=environments/${env}.tfvars`;
  }
}

async function optionsFromParsedArgs(parsed: ParsedArgs, cwd: string, includeProjectName: boolean): Promise<ProjectOptions> {
  const configPath = readStringFlag(parsed.flags, 'config');
  const configOptions = configPath ? await loadConfigOptions(configPath, cwd) : {};
  const flagOptions: ProjectOptions = {
    projectName: includeProjectName ? parsed.positional[0] ?? readStringFlag(parsed.flags, 'project') : readStringFlag(parsed.flags, 'project'),
    projectType: readStringFlag(parsed.flags, 'type'),
    genai: readBooleanFlag(parsed.flags, 'genai'),
    apiStack: readStringFlag(parsed.flags, 'api'),
    pattern: readStringFlag(parsed.flags, 'pattern'),
    cloud: readStringFlag(parsed.flags, 'cloud'),
    region: readStringFlag(parsed.flags, 'region'),
    includeFrontend: readBooleanFlag(parsed.flags, 'frontend'),
    environments: readListFlag(parsed.flags, 'environments'),
    specWorkflow: readStringFlag(parsed.flags, 'spec'),
    agents: readListFlag(parsed.flags, 'agents'),
    defaultAgent: readStringFlag(parsed.flags, 'default-agent'),
    codeAppsPlugin: readBooleanFlag(parsed.flags, 'code-apps-plugin'),
    copilotCloud: readBooleanFlag(parsed.flags, 'copilot-cloud'),
    configureOpenSpecProfile: readBooleanFlag(parsed.flags, 'configure-openspec-profile'),
    governanceProfile: readStringFlag(parsed.flags, 'governance'),
    configPath,
    yes: readBooleanFlag(parsed.flags, 'yes') ?? false,
    force: readBooleanFlag(parsed.flags, 'force'),
    installTools: readBooleanFlag(parsed.flags, 'install-tools'),
    installDependencies: readBooleanFlag(parsed.flags, 'install-dependencies')
  };

  return mergeOptions(configOptions, flagOptions);
}

function hasMissingInitInputs(options: ProjectOptions): boolean {
  const projectType = options.projectType ??
    (options.genai === undefined ? undefined : options.genai ? 'genai' : 'standard') ??
    (options.pattern ? 'genai' : options.apiStack ? 'standard' : undefined);
  const missingTypeSpecific = projectType === 'genai'
    ? !options.pattern
    : projectType === 'standard'
      ? !options.apiStack
      : projectType === 'power-apps-code-app'
        ? options.codeAppsPlugin === undefined
        : true;
  const missingDefaultAgent = options.specWorkflow === 'spec-kit' &&
    (options.agents?.length ?? 0) > 1 &&
    !options.defaultAgent;
  const missingCopilotCloud = options.specWorkflow === 'openspec' &&
    options.agents?.some((agent) => getCodingAgent(agent)?.id === 'github-copilot') === true &&
    options.copilotCloud === undefined;
  return !options.projectName ||
    missingTypeSpecific ||
    projectType !== 'power-apps-code-app' && !options.cloud ||
    projectType !== 'power-apps-code-app' && options.includeFrontend === undefined ||
    !options.specWorkflow ||
    !options.agents ||
    !options.governanceProfile ||
    missingDefaultAgent ||
    missingCopilotCloud ||
    projectType !== 'power-apps-code-app' && !options.environments;
}

function renderGeneralHelp(presentation: PresentationSession): void {
  const help = getGeneralHelp(liftoffVersion);
  presentation.identity(`${help.title} - ${help.subtitle}`);
  presentation.section('Usage', [help.usage]);
  presentation.table(
    'Global options',
    ['Option', 'Description'],
    help.globalOptions.map((option) => [option.syntax, option.description])
  );
  for (const group of help.commandGroups) {
    presentation.table(
      group.title,
      ['Command', 'Description'],
      group.entries.map((entry) => [entry.syntax, entry.description])
    );
  }
  presentation.status('info', 'Tip', help.hint);
}

function renderCommandHelp(command: string, presentation: PresentationSession): void {
  const help = getCommandHelp(command);
  presentation.commandIdentity(help.command, help.description);
  presentation.section('Usage', [
    presentation.stdout.layout === 'plain' ? `Usage: ${help.usage}` : help.usage
  ]);
  if (help.arguments.length > 0) {
    presentation.table(
      'Arguments',
      ['Argument', 'Description'],
      help.arguments.map((argument) => [argument.syntax, argument.description])
    );
  }
  if (help.subcommands.length > 0) {
    presentation.bullets('Subcommands', help.subcommands);
  }
  for (const group of help.optionGroups) {
    presentation.table(
      group.title,
      ['Option', 'Description'],
      group.entries.map((entry) => [
        entry.syntax,
        `${entry.description}${entry.defaultValue ? ` (default: ${entry.defaultValue})` : ''}`
      ])
    );
  }
}

export async function createFixtureProject(options: ProjectOptions): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-'));
  const plan = buildProjectPlan(options, { requireProjectName: true });
  const target = artifactPath(tempRoot, [plan.safeProjectName]);
  await mkdir(target, { recursive: true });
  await assertNewOrEmptyDirectory(target);
  await rm(target, { recursive: true, force: true });
  await writeArtifacts(target, buildArtifacts(plan));
  for (const marker of [
    ...plan.framework.baseMarkers,
    ...plan.agents.flatMap((agent) => plan.framework.agentMarkers[agent.id])
  ]) {
    let content = 'fixture marker\n';
    if (marker.join('/') === '.specify/integration.json') {
      const installed = plan.agents.map((agent) => agent.integrationIds['spec-kit']);
      const defaultIntegration = plan.defaultAgent?.integrationIds['spec-kit'];
      content = `${JSON.stringify({
        integration_state_schema: 1,
        integration: defaultIntegration,
        default_integration: defaultIntegration,
        installed_integrations: installed,
        integration_settings: {}
      }, null, 2)}\n`;
    } else if (marker.join('/') === '.specify/init-options.json') {
      content = '{}\n';
    }
    await writeProjectFile(target, marker, content);
  }
  return target;
}