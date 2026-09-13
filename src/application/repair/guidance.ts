import { commandShellForPlatform, formatShellCommand } from '../../adapters/process/shell-command.js';
import type { LiftoffManifest } from '../../domain/project/contracts.js';
import { assessInfrastructureLayout } from '../../domain/project/infrastructure-layout.js';
import { formatUpdateCommand, type UpdateGuidanceContext } from '../update/command-guidance.js';

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
  return {
    status: 'check-required' as const,
    layout: layout.kind,
    reason: layout.reason,
    checkCommand,
    resumeCommand,
    nextAction: `Review ${checkCommand}; only an eligible repair with its own exact fingerprint can be applied. After repair, run ${resumeCommand} and review remaining local work.`,
    boundary: 'Update approval and --force do not authorize project-owned infrastructure repair. Ordinary repair check makes no cloud calls. Explicit live metadata checks require a selected subscription and existing authentication. Deployed, unknown, or unsupported transformations remain plan-only; the public stateful migration coordinator and agent installation are not implemented.'
  };
}
