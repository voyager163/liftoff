import { commandShellForPlatform, formatShellCommand } from '../../adapters/process/shell-command.js';
import type { LiftoffManifest } from '../../domain/project/contracts.js';
import { governanceAgentIntegrations } from '../../domain/project/catalog.js';
import { assessInfrastructureLayout } from '../../domain/project/infrastructure-layout.js';
import { formatUpdateCommand, type UpdateGuidanceContext } from '../update/command-guidance.js';
import type { RepairNextAction } from './report.js';

export function repairCommandAction(
  projectRoot: string, args: string[], input: {
    id: string; label: string; description: string; scope?: string; approvalRequired?: boolean; requiresInput?: string[];
  }, platform: NodeJS.Platform = process.platform
): RepairNextAction {
  const command = { executable: 'liftoff', args: ['repair', projectRoot, ...args] };
  return {
    kind: 'command', id: input.id, label: input.label, description: input.description,
    scope: input.scope ?? 'repair', cwd: projectRoot, approvalRequired: input.approvalRequired ?? false,
    command, displayCommand: formatShellCommand(command, commandShellForPlatform(platform)),
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
    return { ...entry, kind: 'command', command, cwd: projectRoot, approvalRequired: false,
      displayCommand: formatShellCommand(command, commandShellForPlatform(process.platform)) };
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
  const implicit = context?.state === 'resolved' &&
    (projectRoot === context.projectRoot || projectRoot === context.requestedProjectRoot) &&
    context.implicitProjectRoot === context.projectRoot;
  return formatShellCommand({
    executable: 'liftoff',
    args: ['repair', ...(implicit ? [] : [projectRoot]), `--${mode}`]
  }, commandShellForPlatform(platform));
}

export function infrastructureRepairGuidance(
  projectRoot: string,
  manifest: LiftoffManifest,
  context?: UpdateGuidanceContext,
  platform: NodeJS.Platform = process.platform
) {
  const layout = assessInfrastructureLayout(manifest);
  if (layout.kind === 'independent') return null;
  const checkCommand = formatRepairCommand(projectRoot, 'check', platform, context);
  const resumeCommand = formatUpdateCommand(projectRoot, 'check', platform, context);
  const interactiveCommand = formatShellCommand({
    executable: 'liftoff', args: ['repair', projectRoot]
  }, commandShellForPlatform(platform));
  return {
    status: 'check-required' as const,
    layout: layout.kind,
    reason: layout.reason,
    checkCommand,
    interactiveCommand,
    resumeCommand,
    nextAction: `Review ${checkCommand}; run ${interactiveCommand} in a terminal for default-No approval of an eligible exact repair plan. No fingerprint copying is required. After repair, run ${resumeCommand} and review remaining local work.`,
    boundary: 'Update approval and --force do not authorize project-owned infrastructure repair. Ordinary repair check makes no cloud calls. Explicit live metadata checks require a selected subscription and existing authentication. Deployed, unknown, or unsupported transformations remain plan-only; the public stateful migration coordinator and agent installation are not implemented.'
  };
}
