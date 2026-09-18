import type { CommandResult, CommandRunner } from '../process-runner.js';
import type { ExternalCommand } from '../domain/project/contracts.js';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function commandSucceeded(result: CommandResult): boolean {
  return result.status === 0 && !result.timedOut && !result.errorCode;
}

export function commandFailure(result: CommandResult): string {
  if (result.timedOut) return `${result.displayCommand} timed out`;
  if (result.errorCode || result.errorMessage) {
    return `${result.displayCommand}: ${[result.errorCode, result.errorMessage].filter(Boolean).join(': ')}`;
  }
  return `${result.displayCommand} exited ${result.status ?? 'unknown'}${result.stderr ? `: ${result.stderr.trim()}` : ''}`;
}

export async function runCommand(runner: CommandRunner, command: ExternalCommand, cwd: string): Promise<CommandResult> {
  return await runner.run(command, { cwd });
}

export async function runGit(runner: CommandRunner, projectRoot: string, args: string[]): Promise<CommandResult> {
  return await runCommand(runner, { executable: 'git', args }, projectRoot);
}
