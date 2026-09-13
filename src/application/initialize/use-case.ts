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
  detectHostEnvironment,
  installRequirement,
  probeWorkstation,
  selectRemediation,
  selectWorkstationRequirements,
  workstationScopeReadiness,
  type RequirementProbeResult,
  type InstallResult
} from '../../workstation.js';
import { assertSupportedProjectOptions, hasMissingInitInputs } from './inputs.js';
import { governanceAgentIntegrations, openSpecDeliveryDescription } from '../../domain/project/catalog.js';
import { createWorkstationNoProgressStore } from '../../adapters/filesystem/workstation-attempts.js';

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

      const setupInvocations = [...new Set(plan.agents.map((agent) => governanceAgentIntegrations[agent.id].setup.invocation))];
      presentation.bullets('Configured integrations', [
        `${plan.specWorkflow.label} ${plan.framework.version}`,
        ...plan.agents.map((agent) =>
          `${agent.label}${plan.defaultAgent?.id === agent.id ? ' (default)' : ''}`
        ),
        ...(plan.specWorkflow.id === 'openspec'
          ? [
              `OpenSpec global profile: ${profileReadiness.changed ? 'configured' : 'verified'}; ` +
                `${OPEN_SPEC_WORKFLOW_IDS.length} workflows; ${openSpecDeliveryDescription(plan.agents)}`,
              ...(plan.agents.some((agent) => agent.id === 'github-copilot')
                ? [`GitHub Copilot cloud agent: ${plan.copilotCloud ? 'enabled' : 'disabled'}`]
                : [])
            ]
          : []),
        plan.governanceProfile.id === 'none'
          ? 'Repository governance: disabled'
          : `Repository governance: ${plan.governanceProfile.label} policy ${plan.governanceProfile.policyVersion}; local handoff generated, live activation deferred`,
        ...(plan.governanceProfile.id !== 'none' && setupInvocations.length > 1
          ? plan.agents.map((agent) => `${agent.label} setup: ${governanceAgentIntegrations[agent.id].setup.invocation}`)
          : [])
      ]);
      if (readiness.deferred.length > 0) {
        presentation.bullets('Deferred advisory checks', readiness.deferred);
      }
      if (dependencyPhase.deferred.length > 0) {
        presentation.bullets('Deferred project dependencies', dependencyPhase.deferred);
      }
      const setupInvocation = setupInvocations.length === 1
        ? setupInvocations[0]!
        : 'Use the setup invocation shown above for your selected agent';
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
              : setupInvocations.length === 1
                ? `Deterministic setup generated; run ${setupInvocation} next`
                : 'Deterministic setup generated; use the agent-specific invocation shown above'
          }
        ],
        plan.governanceProfile.id === 'none'
          ? `liftoff validate ${JSON.stringify(target.root)}`
          : setupInvocation
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
  const requirements = selectWorkstationRequirements(plan, { scope: 'initialization' });
  const probeOptions = { ...context.workstationProbe, cwd: commandCwd ?? context.cwd, env: context.env ?? context.workstationProbe?.env };
  const initialProbes = await probeWorkstation(requirements, runner, probeOptions);
  let probes = initialProbes;
  presentation.table(
    'Workstation readiness',
    ['Requirement', 'Level', 'State', 'Cause', 'Executable', 'Detail'],
    probes.map((probe) => [
      probe.requirement.definition.label,
      probe.requirement.severity,
      probe.state,
      probe.reasonCode,
      probe.identity.resolvedPath ?? probe.identity.executable,
      probe.detail
    ])
  );
  const actionable = probes.filter((probe) => probe.state !== 'ready' || probe.reasonCode !== 'compatible');
  const host = context.workstationProbe?.host ?? await detectHostEnvironment();
  const installInstruction = (probe: RequirementProbeResult): string => {
    const selected = selectRemediation(probe.requirement, probe, host);
    return selected.recipe ? formatCommand(selected.recipe.command) :
      selected.remedy ?? probe.remedy ?? selected.detail;
  };
  const authorizedInstallations = new Set<string>();
  const reviewedRemedies = new Map<string, string>();
  const installationResults = new Map<string, InstallResult>();
  if (options.installTools === true) {
    for (const probe of actionable) {
      authorizedInstallations.add(probe.requirement.id);
    }
  }
  if (
    options.installTools === undefined &&
    options.yes !== true &&
    actionable.length > 0 &&
    prompter !== undefined
  ) {
    for (const probe of actionable) {
      const selection = selectRemediation(probe.requirement, probe, host);
      const recipe = selection.recipe;
      if (!recipe) continue;
      const constraint = probe.requirement.exactVersion || probe.requirement.minimumVersion
        ? `required ${formatRequirementVersion(probe.requirement)}`
        : 'required to be available';
      if (await prompter.confirmToolInstallation({
        label: probe.requirement.definition.label,
        severity: probe.requirement.severity,
        purpose: probe.requirement.reasons.join('; '),
        requirement: constraint,
        observed: `${probe.state} - ${probe.detail}`,
        command: formatCommand(recipe.command)
      })) {
        authorizedInstallations.add(probe.requirement.id);
        reviewedRemedies.set(probe.requirement.id, recipe.id);
      }
    }
  }

  if (authorizedInstallations.size > 0) {
    const noProgressStore = context.workstationNoProgressStore ?? createWorkstationNoProgressStore(context.cwd, {
      ...context.updatePreview,
      env: context.env ?? context.updatePreview?.env
    });
    const updates = new Map<string, RequirementProbeResult>();
    for (const probe of actionable) {
      if (!authorizedInstallations.has(probe.requirement.id)) {
        continue;
      }
      const selection = selectRemediation(probe.requirement, probe, host);
      const recipe = selection.recipe;
      if (recipe?.requiresExplicitReview && !reviewedRemedies.has(probe.requirement.id) &&
        prompter && options.yes !== true) {
        if (await prompter.confirmToolInstallation({
          label: probe.requirement.definition.label,
          severity: probe.requirement.severity,
          purpose: `Separate review of ${recipe.operation}; generic tool-install consent does not authorize version or channel replacement.`,
          requirement: formatRequirementVersion(probe.requirement),
          observed: `${probe.reasonCode} - ${probe.detail}`,
          command: formatCommand(recipe.command)
        })) reviewedRemedies.set(probe.requirement.id, recipe.id);
      }
      presentation.stage(`Remediate ${probe.requirement.definition.label}`, `${probe.reasonCode} - ${probe.detail}`);
      if (recipe && (!recipe.requiresExplicitReview || reviewedRemedies.has(probe.requirement.id))) {
        presentation.command(formatCommand(recipe.command));
      }
      const installation = await installRequirement(probe.requirement, probe, {
        ...probeOptions,
        authorized: true,
        host,
        runner,
        approvedRemediationId: reviewedRemedies.get(probe.requirement.id),
        noProgressStore,
        streamOptions: presentation.childStreams()
      });
      installationResults.set(probe.requirement.id, installation);
      updates.set(probe.requirement.id, installation.probe);
      const kind = installation.state === 'installed' || installation.state === 'not-needed'
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

  const blockers = workstationScopeReadiness(probes, 'initialization').toolFailures;
  if (blockers.length > 0) {
    for (const blocker of blockers) {
      presentation.error(
        `${blocker.requirement.definition.label}: ${blocker.detail}`,
        installationResults.get(blocker.requirement.id)?.remedy ?? installInstruction(blocker)
      );
    }
    presentation.error(
      'Workstation readiness is incomplete.',
      [...installationResults.values()].some((result) => result.state === 'restart-required')
        ? `Follow the named executable-discovery remedy, then rerun \`${resumeInvocation}\` with the same project options.`
        : options.installTools
          ? `Resolve the named compatibility or installation cause before retrying \`${resumeInvocation}\`. Use --install-tools only for a reviewed registered remedy; unchanged attempts will not be repeated.`
          : `Resume with \`${resumeInvocation} --install-tools\` plus the same project options after reviewing the commands.`
    );
    return { ready: false, deferred: [], probes };
  }

  const deferred = [
    ...probes
      .filter((probe) => probe.requirement.severity === 'advisory' && probe.state !== 'ready')
      .map((probe) =>
        `${probe.requirement.definition.label}: ${probe.detail} Remedy: ${installationResults.get(probe.requirement.id)?.remedy ?? installInstruction(probe)}`
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
