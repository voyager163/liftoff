import {
  commandShellForPlatform,
  formatShellCommand,
  formatShellDirectoryCommands
} from '../../adapters/process/shell-command.js';

export function formatUpdateCommand(
  projectRoot: string,
  mode: 'normal' | 'force' | 'check' = 'normal',
  platform: NodeJS.Platform = process.platform
): string {
  return formatShellCommand({
    executable: 'liftoff',
    args: ['update', ...(mode === 'normal' ? [] : [`--${mode}`]), '--project', projectRoot]
  }, commandShellForPlatform(platform));
}

export function formatUpdateValidationCommands(
  projectRoot: string,
  platform: NodeJS.Platform = process.platform
): string {
  return formatShellDirectoryCommands([
    { executable: 'liftoff', args: ['validate'] },
    { executable: 'liftoff', args: ['doctor'] }
  ], projectRoot, commandShellForPlatform(platform));
}
