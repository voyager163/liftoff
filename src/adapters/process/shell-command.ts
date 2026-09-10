import type { ExternalCommand } from '../../domain/project/contracts.js';

export type CommandShell = 'posix' | 'powershell';

export function commandShellForPlatform(platform: NodeJS.Platform): CommandShell {
  return platform === 'win32' ? 'powershell' : 'posix';
}

function literal(value: string, shell: CommandShell): string {
  return shell === 'powershell'
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, "'\"'\"'")}'`;
}

export function formatShellCommand(command: ExternalCommand, shell: CommandShell): string {
  const tokens = [command.executable, ...command.args].map((value) =>
    shell === 'posix' && /^[a-zA-Z0-9_./:@=-]+$/.test(value)
      ? value
      : literal(value, shell)
  );
  return `${shell === 'powershell' ? '& ' : ''}${tokens.join(' ')}`;
}

export function formatShellDirectoryCommand(
  command: ExternalCommand,
  cwd: string,
  shell: CommandShell
): string {
  return formatShellDirectoryCommands([command], cwd, shell);
}

export function formatShellDirectoryCommands(
  commands: readonly [ExternalCommand, ...ExternalCommand[]],
  cwd: string,
  shell: CommandShell
): string {
  const invocation = commands.map((command) => formatShellCommand(command, shell))
    .reduceRight((next, current) => shell === 'powershell'
      ? `${current}; if ($?) { ${next} }`
      : `${current} && ${next}`);
  return shell === 'powershell'
    ? `Set-Location -LiteralPath ${literal(cwd, shell)}; if ($?) { ${invocation} }`
    : `cd -- ${literal(cwd, shell)} && ${invocation}`;
}
