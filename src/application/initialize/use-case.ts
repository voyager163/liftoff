import path from 'node:path';
import { withProjectMutationLock } from '../../adapters/filesystem/project-lock.js';
import { formatRequirementVersion } from '../../domain/workstation/constraints.js';
import {
  initializeFramework
} from '../../framework-adapters.js';
import {
  validateGeneratedProject
} from '../diagnose/generated-project.js';
import {
  InteractiveCancelledError,
  InteractivePrompter
} from '../../interactive.js';
import {
  applyMergePreflight,
  assertSafeInitTarget,
  authorizeMergePreflight,
  buildMergePreflight,
  discoverGitRoot,
  resolveInitTargetFromDiscovery,
  validateStagedTree,
  withStagingArea,
  writeStagedArtifacts,
  type MergeResult
} from '../../init-filesystem.js';
import {
  buildOpenSpecProfileWriteCommands,
  configureOpenSpecProfile,
  inspectOpenSpecProfile,
  OPEN_SPEC_DELIVERY,
  OPEN_SPEC_PROFILE,
  OPEN_SPEC_WORKFLOW_IDS
} from '../../openspec-profile.js';
import {
  buildProjectPlan
} from '../project/planning.js';
import {
  projectPlanEntries
} from '../../domain/project/planning.js';
import {
  buildDependencySetupPlan,
  dependencyResumeCommand,
  dependencyResumeShell,
  runDependencySetup
} from '../../project-dependencies.js';
import {
  formatCommand,
  NodeCommandRunner,
  type CommandRunner
} from '../../process-runner.js';
import {
  buildArtifacts,
  partitionGeneratedArtifacts
} from '../../templates.js';
import {
  PresentationSession
} from '../../terminal.js';
import type {
  ExecutionContext
} from '../context.js';
import type {
  ProjectOptions,
  ProjectPlan
} from '../../domain/project/contracts.js';
import {
  blockingReadinessFailures,
  detectHostEnvironment,
  installRequirement,
  probeWorkstation,
  selectWorkstationRequirements,
  type RequirementProbeResult
} from '../../workstation.js';
import { assertSupportedProjectOptions, hasMissingInitInputs } from './inputs.js';

export async function initializeProject(input: ProjectOptions, context: ExecutionContext): Promise<number> {
  const { presentation } = context;
  assertSupportedProjectOptions(input);
  const runner = context.runner ?? new NodeCommandRunner();
  let initial = input;
  presentation.stage('Discover project context');
  const git = await discoverGitRoot(context.cwd, runner);
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

    return await withProjectMutationLock(target.root, async () => {
      presentation.stage('Stage project files');
      const staged = await withStagingArea(async (area): Promise<
        { status: 'applied'; merge: MergeResult } | { status: 'authorization-required' | 'declined' }
      > => {
        const partition = partitionGeneratedArtifacts(buildArtifacts(plan));
        await writeStagedArtifacts(area, partition.liftoff, 'liftoff');
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
              : 'Deterministic setup generated; run /liftoff-setup next'
          }
        ],
        plan.governanceProfile.id === 'none'
          ? `liftoff validate ${JSON.stringify(target.root)}`
          : '/liftoff-setup'
      );
      return 0;
    });
  } finally {
    prompter?.close();
  }
}


interface WorkstationReadinessResult {
  ready: boolean;
  deferred: string[];
  probes: RequirementProbeResult[];
}

interface OpenSpecProfileReadinessResult {
  ready: boolean;
  changed: boolean;
}

export async function ensureWorkstationReady(
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
  const initialProbes = await probeWorkstation(requirements, runner, { cwd: commandCwd });
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
      const constraint = probe.requirement.exactVersion || probe.requirement.minimumVersion
        ? `required ${formatRequirementVersion(probe.requirement)}`
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
    return { ready: false, deferred: [], probes };
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
      ))
  ];
  return { ready: true, deferred, probes };
}

export async function ensureOpenSpecProfileReady(
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

export async function handleProjectDependencies(
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
        `${command.label} (${dependencyResumeShell()}): ${dependencyResumeCommand(command)}`
      )
    };
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
    presentation.status(
      'info',
      'Dependency metadata inspected',
      'Changed metadata is preserved for review; no uncertain edits were restored.'
    );
    presentation.warning(
      'Dependency scripts may have changed other project files; review the working tree before retrying.'
    );
    if (result.restoredMutations.length > 0) {
      presentation.warning(
        `Restored protected files: ${result.restoredMutations.join(', ')}`
      );
    }
    if (result.preservedMutations.length > 0) {
      presentation.warning(`Preserved metadata changes: ${result.preservedMutations.join(', ')}`);
    }
    if (result.resumeCommand) {
      presentation.status('info', 'Recovery shell', result.resumeShell ?? dependencyResumeShell());
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
