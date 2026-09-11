import {
  commandShellForPlatform,
  formatShellCommand,
  formatShellCommands,
  formatShellDirectoryCommands
} from '../../adapters/process/shell-command.js';
import type { ExternalCommand } from '../../domain/project/contracts.js';

export type UpdateCommandMode = 'normal' | 'force' | 'check';

export type UpdateGuidanceText = string | readonly (string | {
  readonly projectRoot: string;
  readonly mode?: UpdateCommandMode;
})[];

export interface ResolvedUpdateGuidanceContext {
  readonly state: 'resolved';
  readonly requestedProjectRoot: string;
  readonly projectRoot: string;
  readonly invocationDirectory: string;
  readonly implicitProjectRoot?: string;
}

export type UpdateGuidanceContext = ResolvedUpdateGuidanceContext | {
  readonly state: 'unresolved';
  readonly detail: string;
};

function targetsProject(
  projectRoot: string,
  context?: UpdateGuidanceContext
): context is ResolvedUpdateGuidanceContext {
  return context?.state === 'resolved' &&
    (projectRoot === context.projectRoot || projectRoot === context.requestedProjectRoot);
}

export function formatUpdateCommand(
  projectRoot: string,
  mode: UpdateCommandMode = 'normal',
  platform: NodeJS.Platform = process.platform,
  context?: UpdateGuidanceContext
): string {
  const implicit = targetsProject(projectRoot, context) &&
    context.implicitProjectRoot === context.projectRoot;
  return formatShellCommand({
    executable: 'liftoff',
    args: ['update', ...(mode === 'normal' ? [] : [`--${mode}`]),
      ...(implicit ? [] : ['--project', projectRoot])]
  }, commandShellForPlatform(platform));
}

export function formatUpdateGuidanceText(
  text: UpdateGuidanceText,
  context?: UpdateGuidanceContext,
  platform: NodeJS.Platform = process.platform
): string {
  return typeof text === 'string' ? text : text.map((part) =>
    typeof part === 'string' ? part : formatUpdateCommand(part.projectRoot, part.mode, platform, context)
  ).join('');
}

export function formatUpdateValidationCommands(
  projectRoot: string,
  platform: NodeJS.Platform = process.platform,
  context?: UpdateGuidanceContext
): string {
  const commands: readonly [ExternalCommand, ...ExternalCommand[]] = [
    { executable: 'liftoff', args: ['validate'] },
    { executable: 'liftoff', args: ['doctor'] }
  ];
  const shell = commandShellForPlatform(platform);
  return targetsProject(projectRoot, context) && context.invocationDirectory === context.projectRoot
    ? formatShellCommands(commands, shell)
    : formatShellDirectoryCommands(commands, projectRoot, shell);
}
