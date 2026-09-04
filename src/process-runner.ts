import spawn from 'cross-spawn';
import { StringDecoder } from 'node:string_decoder';
import type { ExternalCommand } from './types.js';

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  stream?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  redactArgIndices?: number[];
  redactValues?: readonly string[];
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

export function redactSensitiveText(value: string, sensitiveValues: readonly string[] = []): string {
  return sensitiveValues
    .filter((entry) => entry.length > 0)
    .reduce((current, entry) => current.split(entry).join('<redacted-sensitive-value>'), value);
}

function createStreamRedactor(sensitiveValues: readonly string[]) {
  const values = sensitiveValues.filter((entry) => entry.length > 0);
  let pending = '';
  return {
    push(chunk: string): string {
      if (values.length === 0) {
        return chunk;
      }
      pending += chunk;
      return '';
    },
    flush(): string {
      const emit = redactSensitiveText(pending, values);
      pending = '';
      return emit;
    }
  };
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
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      const stdoutRedactor = createStreamRedactor(options.redactValues ?? []);
      const stderrRedactor = createStreamRedactor(options.redactValues ?? []);
      const child = spawn(command.executable, command.args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        shell: false,
        stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      if (options.stdin !== undefined) {
        child.stdin?.end(options.stdin);
      }

      const finish = (status: number | null, signal: NodeJS.Signals | null) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        const stdoutEnd = stdoutDecoder.end();
        const stderrEnd = stderrDecoder.end();
        stdout += stdoutEnd;
        stderr += stderrEnd;
        if (options.stream && (options.redactValues?.length ?? 0) > 0) {
          const stdoutTail = `${stdoutRedactor.push(stdoutEnd)}${stdoutRedactor.flush()}`;
          const stderrTail = `${stderrRedactor.push(stderrEnd)}${stderrRedactor.flush()}`;
          if (stdoutTail) {
            (options.stdout ?? process.stdout).write(stdoutTail);
          }
          if (stderrTail) {
            (options.stderr ?? process.stderr).write(stderrTail);
          }
        }
        resolve({
          command,
          displayCommand,
          status,
          signal,
          stdout: redactSensitiveText(stdout, options.redactValues),
          stderr: redactSensitiveText(stderr, options.redactValues),
          timedOut,
          ...(errorCode ? { errorCode } : {}),
          ...(errorMessage ? { errorMessage: redactSensitiveText(errorMessage, options.redactValues) } : {})
        });
      };

      child.stdout?.on('data', (chunk: Buffer | string) => {
        const decoded = typeof chunk === 'string' ? chunk : stdoutDecoder.write(chunk);
        stdout += decoded;
        if (options.stream) {
          if ((options.redactValues?.length ?? 0) > 0) {
            const safe = stdoutRedactor.push(decoded);
            if (safe) {
              (options.stdout ?? process.stdout).write(safe);
            }
          } else {
            (options.stdout ?? process.stdout).write(chunk);
          }
        }
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        const decoded = typeof chunk === 'string' ? chunk : stderrDecoder.write(chunk);
        stderr += decoded;
        if (options.stream) {
          if ((options.redactValues?.length ?? 0) > 0) {
            const safe = stderrRedactor.push(decoded);
            if (safe) {
              (options.stderr ?? process.stderr).write(safe);
            }
          } else {
            (options.stderr ?? process.stderr).write(chunk);
          }
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
