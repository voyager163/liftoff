import spawn from 'cross-spawn';
import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ExternalCommand } from './types.js';

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
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
  outputLimitExceeded?: boolean;
  aborted?: boolean;
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
    },
    discard(): void {
      pending = '';
    }
  };
}

function terminateProcessTree(child: ChildProcess, ownsProcessGroup: boolean): Promise<boolean> {
  if (child.pid === undefined) return Promise.resolve(true);
  if (process.platform !== 'win32') {
    try {
      if (ownsProcessGroup) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
      return Promise.resolve(true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return Promise.resolve(true);
      try { child.kill('SIGKILL'); } catch { /* The caller reports termination failure. */ }
      return Promise.resolve(false);
    }
  }
  // An exited Windows root PID may have been reused; never target its replacement.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(false);
  return new Promise((resolve) => {
    const killer = spawnProcess(
      path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      { shell: false, windowsHide: true, stdio: 'ignore' }
    );
    let settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!success) {
        try { child.kill('SIGKILL'); } catch { /* The caller reports termination failure. */ }
      }
      resolve(success);
    };
    const timer = setTimeout(() => {
      try { killer.kill('SIGKILL'); } catch { /* Settlement must remain bounded. */ }
      finish(false);
    }, 500);
    killer.once('error', () => finish(false));
    killer.once('close', (status) => finish(status === 0));
  });
}

export class NodeCommandRunner implements CommandRunner {
  async run(command: ExternalCommand, options: RunCommandOptions = {}): Promise<CommandResult> {
    if (options.maxOutputBytes !== undefined &&
        (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0)) {
      throw new RangeError('maxOutputBytes must be a positive safe integer.');
    }
    const displayCommand = formatCommand(command, options.redactArgIndices);
    if (options.signal?.aborted) {
      return {
        command, displayCommand, status: null, signal: null, stdout: '', stderr: '', timedOut: false,
        aborted: true, errorCode: 'ABORT_ERR', errorMessage: 'Command was cancelled before it started.',
        ...(options.maxOutputBytes === undefined ? {} : { outputLimitExceeded: false })
      };
    }
    return new Promise((resolve) => {
      let settled = false;
      let stopping = false;
      let timedOut = false;
      let outputLimitExceeded = false;
      let aborted = false;
      let discardOutput = false;
      let outputBytes = 0;
      let stdout = '';
      let stderr = '';
      let errorCode: string | undefined;
      let errorMessage: string | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      const stdoutRedactor = createStreamRedactor(options.redactValues ?? []);
      const stderrRedactor = createStreamRedactor(options.redactValues ?? []);
      const bounded = Boolean(options.timeoutMs && options.timeoutMs > 0) ||
        options.maxOutputBytes !== undefined || options.signal !== undefined;
      // A dedicated POSIX group contains inherited-pipe descendants without detaching their lifetime.
      const ownsProcessGroup = bounded && process.platform !== 'win32';
      const child = spawn(command.executable, command.args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        shell: false,
        detached: ownsProcessGroup,
        stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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
        options.signal?.removeEventListener('abort', cancel);
        const stdoutEnd = discardOutput ? '' : stdoutDecoder.end();
        const stderrEnd = discardOutput ? '' : stderrDecoder.end();
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
          ...(options.maxOutputBytes === undefined ? {} : { outputLimitExceeded }),
          ...(options.signal === undefined ? {} : { aborted }),
          ...(errorCode ? { errorCode } : {}),
          ...(errorMessage ? { errorMessage: redactSensitiveText(errorMessage, options.redactValues) } : {})
        });
      };

      const stop = () => {
        if (settled || stopping) return;
        stopping = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        discardOutput = outputLimitExceeded || (options.redactValues?.some((value) => value.length > 0) ?? false);
        if (discardOutput) {
          stdout = '';
          stderr = '';
          stdoutRedactor.discard();
          stderrRedactor.discard();
        }
        const completeStop = (terminated: boolean) => {
          for (const stream of [child.stdin, child.stdout, child.stderr]) {
            try { stream?.destroy(); } catch { terminated = false; }
          }
          if (!terminated) {
            errorCode = 'PROCESS_TREE_TERMINATION_FAILED';
            errorMessage = 'The complete command process tree could not be terminated.';
          }
          finish(null, 'SIGKILL');
        };
        try {
          void terminateProcessTree(child, ownsProcessGroup).then(completeStop, () => completeStop(false));
        } catch {
          completeStop(false);
        }
      };

      const cancel = () => {
        if (settled || stopping) return;
        aborted = true;
        errorCode = 'ABORT_ERR';
        errorMessage = 'Command was cancelled.';
        stop();
      };

      const acceptChunk = (chunk: Buffer | string): boolean => {
        if (settled || stopping) return false;
        outputBytes += Buffer.byteLength(chunk);
        if (options.maxOutputBytes === undefined || outputBytes <= options.maxOutputBytes) return true;
        outputLimitExceeded = true;
        errorCode = 'MAX_OUTPUT_BYTES_EXCEEDED';
        errorMessage = 'Child output exceeded the configured byte limit.';
        stop();
        return false;
      };

      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (!acceptChunk(chunk)) return;
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
        if (!acceptChunk(chunk)) return;
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
        if (settled || stopping) return;
        errorCode = error.code;
        errorMessage = error.message;
      });
      child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        if (settled || stopping) return;
        errorCode = error.code;
        errorMessage = error.message;
      });
      child.on('close', (status, signal) => {
        if (!stopping) finish(status, signal);
      });

      timer = options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            if (settled || stopping) return;
            timedOut = true;
            stop();
          }, options.timeoutMs)
        : undefined;
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
      if (!stopping && options.stdin !== undefined) child.stdin?.end(options.stdin);
    });
  }
}
