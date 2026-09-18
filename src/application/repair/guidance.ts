import { commandShellForPlatform, formatShellCommand } from '../../adapters/process/shell-command.js';
import type { LiftoffManifest } from '../../domain/project/contracts.js';
import { governanceAgentIntegrations } from '../../domain/project/catalog.js';
import { assessInfrastructureLayout } from '../../domain/project/infrastructure-layout.js';
import { createUpdateContinuation, formatUpdateCommand, type UpdateGuidanceContext } from '../update/command-guidance.js';
import type { RepairNextAction } from './report.js';
import { createStructuredContinuation } from '../../protocol/continuation.js';

interface RepairCommandActionInput {
  id: string;
  label: string;
  description: string;
  scope?: string;
  approvalRequired?: boolean;
  requiresInput?: string[];
  configPath?: string;
  configDigest?: string;
}

function repairAuthority(args: readonly string[]): string[] {
  if (args.includes('--verify-plan')) {
    return [
      'verification-plan-approval',
      ...(args.includes('--allow-dependency-preparation') ? ['dependency-preparation-consent'] : []),
      ...(args.includes('--allow-network') ? ['declared-network-consent'] : [])
    ];
  }
  if (args.includes('--approve-plan')) return ['file-plan-approval'];
  if (args.includes('--recover')) return ['original-recorded-effect-recovery'];
  if (args.includes('--live')) return ['live-metadata-consent', ...(args.includes('--check') ? [] : ['reviewed-plan'])];
  return args.some((arg) => ['--check', '--inspect-layout', '--capabilities'].includes(arg)) ? [] : ['reviewed-plan'];
}

export function repairCommandAction(
  projectRoot: string, args: string[], input: RepairCommandActionInput, platform: NodeJS.Platform = process.platform
): RepairNextAction {
  const command = { executable: 'liftoff', args: ['repair', projectRoot, ...args] };
  const requiredAuthority = repairAuthority(args);
  const continuation = input.requiresInput?.length ? undefined : createStructuredContinuation({
    ...command, cwd: projectRoot, project: projectRoot, scope: input.scope ?? 'repair',
    targetScope: 'project', requiredAuthority, compatibilityIdentity: 'repair-contract-v1',
    ...(input.configPath !== undefined ? { configPath: input.configPath } : {}),
    ...(input.configDigest !== undefined ? { configDigest: input.configDigest } : {}),
    platform
  });
  return {
    kind: 'command', id: input.id, label: input.label, description: input.description,
    scope: input.scope ?? 'repair', cwd: projectRoot, approvalRequired: input.approvalRequired === true || requiredAuthority.length > 0,
    command, displayCommand: continuation?.displayCommand ?? formatShellCommand(command, commandShellForPlatform(platform)),
    ...(continuation ? { continuation } : {}),
    ...(input.requiresInput ? { requiresInput: input.requiresInput } : {})
  };
}

export function repairCheckAction(projectRoot: string): RepairNextAction {
  return repairCommandAction(projectRoot, ['--check'], {
    id: 'repair-check', label: 'Check without changes',
    description: 'Checks do not run project scripts or apply a file transaction.'
  });
}

export function repairResumeActions(projectRoot: string, manifest: LiftoffManifest): RepairNextAction[] {
  const commands = [
    { id: 'update-check', label: 'Check managed updates', args: ['update', '--check', '--project', projectRoot],
      description: 'Managed update approval is separate from project repair.', scope: 'managed-update' },
    ...(manifest.governance.profile === 'none' || manifest.governance.profile === 'unspecified' ? [] : [
      { id: 'local-status', label: 'Inspect local setup', args: ['governance', 'status', '--project', projectRoot, '--scope', 'local'],
        description: 'Repair does not complete local baseline verification or cloud activation.', scope: 'localSetup' },
      { id: 'local-resume', label: 'Resume local readiness inspection', args: ['governance', 'resume', '--project', projectRoot, '--scope', 'local'],
        description: 'Resume reports remaining readiness; it does not fabricate evidence or execute a phase.', scope: 'localSetup' },
      { id: 'local-verify', label: 'Verify local setup', args: ['governance', 'verify', '--project', projectRoot, '--scope', 'local'],
        description: 'Use the selected agent setup operation for separately approved remaining execution.', scope: 'localSetup' }
    ])
  ];
  return commands.map(({ args, ...entry }): RepairNextAction => {
    const command = { executable: 'liftoff', args };
    const continuation = args[0] === 'update'
      ? createUpdateContinuation(projectRoot, 'check')
      : createStructuredContinuation({
        ...command, cwd: projectRoot, project: projectRoot, scope: 'local', targetScope: 'project',
        requiredAuthority: [], compatibilityIdentity: 'activation-v4'
      });
    return { ...entry, kind: 'command', command, cwd: projectRoot, approvalRequired: false,
      displayCommand: continuation.displayCommand, continuation };
  });
}

export function repairAgentActions(projectRoot: string, manifest: LiftoffManifest): RepairNextAction[] {
  return manifest.project.agents.map((agent): RepairNextAction => ({
    kind: 'agent', id: `native-repair-${agent}`, label: 'Open the project in a coding agent',
    agent, invocation: governanceAgentIntegrations[agent].repair.invocation,
    cwd: projectRoot, scope: 'guided-repair', approvalRequired: false,
    description: `Use the repair integration for actual application inventory and staged patch review. If unavailable, review ${formatUpdateCommand(projectRoot, 'check')}, then approve the matching ${formatUpdateCommand(projectRoot)}; never overwrite an unowned custom integration.`
  }));
}

export function formatRepairCommand(
  projectRoot: string,
  mode: 'check' | 'recover' = 'check',
  platform: NodeJS.Platform = process.platform,
  context?: UpdateGuidanceContext
): string {
  const root = context?.state === 'resolved' &&
    (projectRoot === context.projectRoot || projectRoot === context.requestedProjectRoot)
    ? context.projectRoot : projectRoot;
  return createStructuredContinuation({
    args: ['repair', root, `--${mode}`], cwd: root, project: root, scope: mode === 'recover' ? 'repair-recovery' : 'repair',
    requiredAuthority: repairAuthority([`--${mode}`]), compatibilityIdentity: 'repair-contract-v1', platform
  }).displayCommand;
}

export function infrastructureRepairGuidance(
  projectRoot: string,
  manifest: LiftoffManifest,
  context?: UpdateGuidanceContext,
  platform: NodeJS.Platform = process.platform
) {
  if (manifest.project.workload.kind === 'components') return null;
  const layout = assessInfrastructureLayout(manifest);
  if (layout.kind === 'independent') return null;
  const root = context?.state === 'resolved' &&
    (projectRoot === context.projectRoot || projectRoot === context.requestedProjectRoot)
    ? context.projectRoot : projectRoot;
  const continuation = (args: string[]) => createStructuredContinuation({
    args: ['repair', root, ...args], cwd: root, project: root, scope: 'repair',
    requiredAuthority: repairAuthority(args), compatibilityIdentity: 'repair-contract-v1', platform
  });
  const continuations = {
    check: continuation(['--check']),
    interactive: continuation([]),
    resume: createUpdateContinuation(root, 'check', platform)
  };
  const checkCommand = continuations.check.displayCommand;
  const resumeCommand = continuations.resume.displayCommand;
  const interactiveCommand = continuations.interactive.displayCommand;
  return {
    status: 'check-required' as const,
    layout: layout.kind,
    reason: layout.reason,
    checkCommand,
    interactiveCommand,
    resumeCommand,
    continuations,
    nextAction: `Review ${checkCommand}; run ${interactiveCommand} in a terminal for default-No approval of an eligible exact repair plan. No fingerprint copying is required. After repair, run ${resumeCommand} and review remaining local work.`,
    boundary: 'Update approval and --force do not authorize project-owned infrastructure repair. Ordinary repair check makes no cloud calls. Explicit live metadata checks require a selected subscription and existing authentication. Deployed, unknown, or unsupported transformations remain plan-only; the public stateful migration coordinator and agent installation are not implemented.'
  };
}
