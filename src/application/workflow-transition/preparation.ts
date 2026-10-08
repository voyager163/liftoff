import {
  buildOpenSpecProfileWriteCommands,
  configureOpenSpecProfile,
  inspectOpenSpecProfile,
  OPEN_SPEC_DELIVERY,
  OPEN_SPEC_PROFILE,
  OPEN_SPEC_WORKFLOW_IDS
} from '../../openspec-profile.js';
import {
  formatCommand,
  type CommandRunner,
  type RunCommandOptions
} from '../../process-runner.js';
import type {
  CurrentProjectPlan,
  DevelopmentWorkflowId
} from '../../domain/project/contracts.js';
import type {
  RequirementProbeResult,
  SelectedRequirement,
  WorkstationNoProgressStore,
  WorkstationProbeOptions
} from '../../workstation.js';
import {
  detectHostEnvironment,
  installRequirement,
  probeWorkstation,
  selectCurrentWorkstationRequirements,
  selectRemediation
} from '../../workstation.js';

export interface WorkflowTransitionToolPreparation {
  readonly id: string;
  readonly state: RequirementProbeResult['state'];
  readonly reasonCode: RequirementProbeResult['reasonCode'];
  readonly detectedVersion: string | null;
  readonly executable: string;
  readonly resolution: RequirementProbeResult['identity']['resolution'];
  readonly resolvedPath: string | null;
  readonly realPath: string | null;
  readonly kind: RequirementProbeResult['identity']['kind'] | null;
  readonly origin: RequirementProbeResult['identity']['origin'];
  readonly evidence: RequirementProbeResult['identity']['evidence'];
  readonly minimumVersion: string | null;
  readonly exactVersion: string | null;
  readonly releaseLine: string | null;
  readonly installCommand: string | null;
}

export interface WorkflowTransitionProfilePreparation {
  readonly status: 'not-applicable' | 'unavailable' | 'ready' | 'configuration-required';
  readonly profile: string | null;
  readonly delivery: string | null;
  readonly workflows: readonly string[];
  readonly differences: readonly string[];
  readonly commands: readonly string[];
}

export interface WorkflowTransitionPreparationReport {
  readonly status: 'not-required' | 'ready' | 'required';
  readonly tools: readonly WorkflowTransitionToolPreparation[];
  readonly openSpecProfile: WorkflowTransitionProfilePreparation;
}

export interface WorkflowTransitionPreparationOptions {
  readonly runner: CommandRunner;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly workstationProbe?: WorkstationProbeOptions;
  readonly workstationNoProgressStore?: WorkstationNoProgressStore;
  readonly installTools?: boolean;
  readonly configureOpenSpecProfile?: boolean;
  readonly streamOptions?: Pick<RunCommandOptions, 'stdout' | 'stderr'>;
  readonly authorizeTool?: (
    probe: RequirementProbeResult,
    command: string | undefined,
    requiresExplicitReview: boolean
  ) => Promise<boolean>;
  readonly authorizeOpenSpecProfile?: (
    input: {
      readonly observed: {
        readonly profile: string;
        readonly delivery: string;
        readonly workflows: readonly string[];
      };
      readonly differences: readonly string[];
      readonly commands: readonly string[];
    }
  ) => Promise<boolean>;
  readonly onCommand?: (command: string) => void;
  readonly onMachineCommand?: (command: string) => void;
}

export interface WorkflowTransitionPreparationResult {
  readonly report: WorkflowTransitionPreparationReport;
  readonly machineChanges: readonly string[];
}

function requiredToolIds(
  workflow: Exclude<DevelopmentWorkflowId, 'manual'>
): readonly ('node' | 'npm' | 'python' | 'uv' | 'openspec' | 'spec-kit')[] {
  return workflow === 'openspec'
    ? ['node', 'npm', 'openspec']
    : ['python', 'uv', 'spec-kit'];
}

function requirements(plan: CurrentProjectPlan): SelectedRequirement[] {
  if (plan.specWorkflow.id === 'manual') return [];
  return selectCurrentWorkstationRequirements(plan, {
    scope: 'lifecycle',
    requiredTools: requiredToolIds(plan.specWorkflow.id)
  });
}

function toolReport(
  probe: RequirementProbeResult,
  installCommand: string | null
): WorkflowTransitionToolPreparation {
  return Object.freeze({
    id: probe.requirement.id,
    state: probe.state,
    reasonCode: probe.reasonCode,
    detectedVersion: probe.detectedVersion ?? null,
    executable: probe.identity.executable,
    resolution: probe.identity.resolution,
    resolvedPath: probe.identity.resolvedPath ?? null,
    realPath: probe.identity.realPath ?? null,
    kind: probe.identity.kind ?? null,
    origin: probe.identity.origin,
    evidence: probe.identity.evidence,
    minimumVersion: probe.requirement.minimumVersion ?? null,
    exactVersion: probe.requirement.exactVersion ?? null,
    releaseLine: probe.requirement.releaseLine ?? null,
    installCommand
  });
}

function notApplicableProfile(): WorkflowTransitionProfilePreparation {
  return Object.freeze({
    status: 'not-applicable',
    profile: null,
    delivery: null,
    workflows: Object.freeze([]),
    differences: Object.freeze([]),
    commands: Object.freeze([])
  });
}

function unavailableProfile(): WorkflowTransitionProfilePreparation {
  return Object.freeze({
    status: 'unavailable',
    profile: null,
    delivery: null,
    workflows: Object.freeze([]),
    differences: Object.freeze([
      'The exact OpenSpec tool chain must be ready before its global profile can be inspected.'
    ]),
    commands: Object.freeze([])
  });
}

function probeOptions(
  options: WorkflowTransitionPreparationOptions
): WorkstationProbeOptions {
  return {
    ...options.workstationProbe,
    cwd: options.cwd,
    env: options.env ?? options.workstationProbe?.env
  };
}

function ready(probe: RequirementProbeResult): boolean {
  return probe.state === 'ready' && probe.reasonCode === 'compatible';
}

async function prepareTools(
  plan: CurrentProjectPlan,
  options: WorkflowTransitionPreparationOptions
): Promise<{
  readonly probes: readonly RequirementProbeResult[];
  readonly installCommands: ReadonlyMap<string, string>;
  readonly machineChanges: readonly string[];
}> {
  const selected = requirements(plan);
  const observed = await probeWorkstation(
    selected,
    options.runner,
    probeOptions(options)
  );
  const probes = [...observed];
  const installCommands = new Map<string, string>();
  const machineChanges: string[] = [];
  const host = options.workstationProbe?.host ?? await detectHostEnvironment();
  for (const [index, current] of probes.entries()) {
    if (ready(current)) continue;
    const remediation = selectRemediation(
      current.requirement,
      current,
      host
    );
    const command = remediation.recipe
      ? formatCommand(remediation.recipe.command)
      : undefined;
    if (command) installCommands.set(current.requirement.id, command);
    const separatelyApproved = options.authorizeTool
      ? await options.authorizeTool(
          current,
          command,
          remediation.recipe?.requiresExplicitReview === true
        )
      : false;
    const authorized = remediation.recipe?.requiresExplicitReview
      ? separatelyApproved
      : options.installTools === true || separatelyApproved;
    if (!authorized) continue;
    if (command) {
      options.onCommand?.(command);
      options.onMachineCommand?.(command);
    }
    const installed = await installRequirement(
      current.requirement,
      current,
      {
        ...probeOptions(options),
        authorized: true,
        host,
        runner: options.runner,
        streamOptions: options.streamOptions,
        noProgressStore: options.workstationNoProgressStore,
        ...(remediation.recipe?.requiresExplicitReview
          ? { approvedRemediationId: remediation.recipe.id }
          : {})
      }
    );
    probes[index] = installed.probe;
    if (installed.command) {
      machineChanges.push(
        `${current.requirement.definition.label}: ${installed.state}; ${installed.command}`
      );
    }
  }
  return {
    probes: Object.freeze(probes),
    installCommands,
    machineChanges: Object.freeze(machineChanges)
  };
}

async function prepareOpenSpecProfile(
  plan: CurrentProjectPlan,
  probes: readonly RequirementProbeResult[],
  options: WorkflowTransitionPreparationOptions
): Promise<{
  readonly report: WorkflowTransitionProfilePreparation;
  readonly machineChanges: readonly string[];
}> {
  if (plan.specWorkflow.id !== 'openspec') {
    return { report: notApplicableProfile(), machineChanges: Object.freeze([]) };
  }
  if (!plan.framework || probes.some(probe => !ready(probe))) {
    return { report: unavailableProfile(), machineChanges: Object.freeze([]) };
  }
  let inspection = await inspectOpenSpecProfile(
    plan.framework.executable,
    options.runner,
    {
      cwd: options.cwd,
      env: options.env
    }
  );
  const commands = buildOpenSpecProfileWriteCommands(
    plan.framework.executable
  );
  const displayed = commands.map(command => formatCommand(command));
  if (!inspection.compatible) {
    const separatelyApproved = options.authorizeOpenSpecProfile
      ? await options.authorizeOpenSpecProfile({
          observed: {
            profile: inspection.state.profile,
            delivery: inspection.state.delivery,
            workflows: inspection.state.workflows
          },
          differences: inspection.differences,
          commands: displayed
        })
      : false;
    if (options.configureOpenSpecProfile === true || separatelyApproved) {
      for (const command of displayed) {
        options.onCommand?.(command);
        options.onMachineCommand?.(command);
      }
      inspection = await configureOpenSpecProfile(
        plan.framework.executable,
        options.runner,
        {
          cwd: options.cwd,
          env: options.env,
          ...options.streamOptions
        }
      );
      return {
        report: Object.freeze({
          status: 'ready',
          profile: inspection.state.profile,
          delivery: inspection.state.delivery,
          workflows: Object.freeze([...inspection.state.workflows].sort()),
          differences: Object.freeze([]),
          commands: Object.freeze(displayed)
        }),
        machineChanges: Object.freeze([
          `OpenSpec global profile: ${OPEN_SPEC_PROFILE}; ${OPEN_SPEC_DELIVERY}; ${OPEN_SPEC_WORKFLOW_IDS.length} workflows`
        ])
      };
    }
  }
  return {
    report: Object.freeze({
      status: inspection.compatible ? 'ready' : 'configuration-required',
      profile: inspection.state.profile,
      delivery: inspection.state.delivery,
      workflows: Object.freeze([...inspection.state.workflows].sort()),
      differences: Object.freeze([...inspection.differences].sort()),
      commands: Object.freeze(displayed)
    }),
    machineChanges: Object.freeze([])
  };
}

export async function prepareWorkflowTransitionEnvironment(
  plan: CurrentProjectPlan,
  options: WorkflowTransitionPreparationOptions
): Promise<WorkflowTransitionPreparationResult> {
  if (plan.specWorkflow.id === 'manual') {
    return Object.freeze({
      report: Object.freeze({
        status: 'not-required',
        tools: Object.freeze([]),
        openSpecProfile: notApplicableProfile()
      }),
      machineChanges: Object.freeze([])
    });
  }
  const toolPreparation = await prepareTools(plan, options);
  const profilePreparation = await prepareOpenSpecProfile(
    plan,
    toolPreparation.probes,
    options
  );
  const toolReports = toolPreparation.probes.map(probe => toolReport(
    probe,
    ready(probe)
      ? null
      : toolPreparation.installCommands.get(probe.requirement.id) ?? null
  ));
  const toolsReady = toolPreparation.probes.every(ready);
  const readyForStaging = toolsReady &&
    (profilePreparation.report.status === 'ready' ||
      profilePreparation.report.status === 'not-applicable');
  return Object.freeze({
    report: Object.freeze({
      status: readyForStaging ? 'ready' : 'required',
      tools: Object.freeze(toolReports),
      openSpecProfile: profilePreparation.report
    }),
    machineChanges: Object.freeze([
      ...toolPreparation.machineChanges,
      ...profilePreparation.machineChanges
    ])
  });
}
