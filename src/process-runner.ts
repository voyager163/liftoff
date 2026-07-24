import spawn from 'cross-spawn';
import type { ExternalCommand } from './types.js';

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stream?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  redactArgIndices?: number[];
}

export interface CommandResult {
  command: ExternalCommand;
  displayCommand: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface CommandRunner {
  run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult>;
}

function displayArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@=+,-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function formatCommand(command: ExternalCommand, redactArgIndices: number[] = []): string {
  const redacted = new Set(redactArgIndices);
  return [
    displayArgument(command.executable),
    ...command.args.map((argument, index) => redacted.has(index) ? '<redacted>' : displayArgument(argument))
  ].join(' ');
}

export class NodeCommandRunner implements CommandRunner {
  async run(command: ExternalCommand, options: RunCommandOptions = {}): Promise<CommandResult> {
    const displayCommand = formatCommand(command, options.redactArgIndices);
    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      let stdout = '';
      let stderr = '';
      let errorCode: string | undefined;
      let errorMessage: string | undefined;
      const child = spawn(command.executable, command.args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });

      const finish = (status: number | null, signal: NodeJS.Signals | null) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        resolve({
          command,
          displayCommand,
          status,
          signal,
          stdout,
          stderr,
          timedOut,
          ...(errorCode ? { errorCode } : {}),
          ...(errorMessage ? { errorMessage } : {})
        });
      };

      child.stdout?.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString();
        stdout += text;
        if (options.stream) {
          (options.stdout ?? process.stdout).write(text);
        }
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString();
        stderr += text;
        if (options.stream) {
          (options.stderr ?? process.stderr).write(text);
        }
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        errorCode = error.code;
        errorMessage = error.message;
      });
      child.on('close', finish);

      const timer = options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
          }, options.timeoutMs)
        : undefined;
    });
  }
}
