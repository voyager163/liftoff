import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import type { ExternalCommand } from '../../domain/project/contracts.js';
import type { CommandResult, RunCommandOptions } from '../../process-runner.js';
import { resolvePackageFile } from '../packaged-assets/package-root.js';
import {
  defaultWindowsJobControllerId,
  deriveInvocationDigest,
  encodeWindowsEnvironmentBlock,
  formatWindowsArgvCommandLine,
  frameControlMessage,
  unframeControlMessages,
  WindowsJobExecutionSession,
  type WindowsJobAdmittedInvocation,
  type WindowsJobControlAck,
  type WindowsJobControlResponse
} from './windows-job-protocol.js';

export const windowsJobControllerAssetPathParts = ['assets', 'repair', 'windows-job-controller.ps1'] as const;
export const windowsJobControllerAssetDigest = 'de00ceba4283e0c43eb29cedfe90da849b37af10e3bc7224470ed7fd25bf529e';

export interface WindowsJobRunnerOptions {
  assetPath?: string;
  powershellPath?: string;
  skipAssetVerification?: boolean;
}

export async function verifyWindowsJobControllerAsset(customPath?: string): Promise<string> {
  const assetPath = customPath ?? resolvePackageFile(...windowsJobControllerAssetPathParts);
  const bytes = await readFile(assetPath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== windowsJobControllerAssetDigest) {
    throw new Error(
      `Windows Job Object controller asset integrity failure: found ${digest}; expected ${windowsJobControllerAssetDigest}.`
    );
  }
  return assetPath;
}

export function resolveWindowsPowerShellPath(customPath?: string): string {
  if (customPath) return customPath;
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function buildWindowsControllerHostEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    WINDIR: process.env.WINDIR ?? 'C:\\Windows',
    PATH: process.env.PATH ?? 'C:\\Windows\\System32;C:\\Windows',
    PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS'
  };
  // Preserve inherited process-scope execution policy preference so it is not accidentally relaxed
  if (process.env.PSExecutionPolicyPreference !== undefined) {
    env.PSExecutionPolicyPreference = process.env.PSExecutionPolicyPreference;
  }
  return env;
}

export async function runWindowsJobCommand(
  command: ExternalCommand,
  options: RunCommandOptions = {},
  runnerOptions: WindowsJobRunnerOptions = {}
): Promise<CommandResult> {
  const displayCommand = [command.executable, ...command.args].join(' ');
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;

  let scriptPath: string;
  try {
    scriptPath = runnerOptions.skipAssetVerification
      ? (runnerOptions.assetPath ?? resolvePackageFile(...windowsJobControllerAssetPathParts))
      : await verifyWindowsJobControllerAsset(runnerOptions.assetPath);
  } catch (error) {
    return {
      command,
      displayCommand,
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      processTreeSettled: false,
      processSpawned: false,
      errorCode: 'CORRUPTED_CONTROLLER_ASSET',
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }

  const powershellPath = resolveWindowsPowerShellPath(runnerOptions.powershellPath);
  if (!existsSync(powershellPath)) {
    return {
      command,
      displayCommand,
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      processTreeSettled: false,
      processSpawned: false,
      errorCode: 'UNSUPPORTED_PROCESS_SETTLEMENT',
      errorMessage: 'Windows PowerShell 5.1 is required for Windows process-tree settlement verification.'
    };
  }
  const nonce = randomBytes(32).toString('hex');
  const workspaceId = randomBytes(32).toString('hex');
  const pipeName = `liftoff-job-${randomUUID()}`;
  const pipePath = process.platform === 'win32'
    ? `\\\\.\\pipe\\${pipeName}`
    : path.join(process.env.TMPDIR ?? '/tmp', `${pipeName}.sock`);

  let envBlock: Buffer;
  try {
    envBlock = encodeWindowsEnvironmentBlock(options.env ?? {});
  } catch (error) {
    return {
      command,
      displayCommand,
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      processTreeSettled: false,
      processSpawned: false,
      errorCode: 'INVALID_ENVIRONMENT_BLOCK',
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }

  const envDigest = createHash('sha256').update(envBlock).digest('hex');
  const session = new WindowsJobExecutionSession();
  session.onControllerReady(defaultWindowsJobControllerId);

  const invocation: WindowsJobAdmittedInvocation = {
    workspaceId,
    controllerId: defaultWindowsJobControllerId,
    executable: command.executable,
    args: command.args,
    cwd: options.cwd ?? process.cwd(),
    envDigest,
    timeoutMs,
    maxOutputBytes
  };

  session.admitScope(invocation, nonce);
  const invocationId = session.getInvocationId()!;

  return new Promise<CommandResult>((resolve) => {
    let clientSocket: net.Socket | null = null;
    let psProcess: ChildProcess | null = null;
    let psStderr = '';
    let connected = false;
    let settled = false;
    let incomingBuffer = Buffer.alloc(0);

    const finish = (result: Partial<CommandResult> & { processTreeSettled: boolean; processSpawned: boolean }) => {
      if (settled) return;
      settled = true;

      try { clientSocket?.destroy(); } catch { /* ignore */ }
      try { server.close(); } catch { /* ignore */ }
      if (psProcess && !psProcess.killed) {
        try { psProcess.kill(); } catch { /* ignore */ }
      }

      resolve({
        command,
        displayCommand,
        status: result.status ?? null,
        signal: result.signal ?? null,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        timedOut: result.timedOut ?? false,
        processTreeSettled: result.processTreeSettled,
        processSpawned: result.processSpawned,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        ...(result.errorMessage ? { errorMessage: result.errorMessage } : {})
      });
    };

    const server = net.createServer((socket) => {
      connected = true;
      clientSocket = socket;

      socket.on('data', (chunk) => {
        incomingBuffer = Buffer.from(Buffer.concat([incomingBuffer, chunk]));
        const { messages, remainder } = unframeControlMessages(incomingBuffer);
        incomingBuffer = Buffer.from(remainder);

        for (const msg of messages) {
          handleIncomingMessage(msg);
        }
      });

      socket.on('error', () => {
        if (!settled) {
          finish({
            processTreeSettled: false,
            processSpawned: session.getState() === 'root-started',
            errorCode: 'CONTROL_PIPE_ERROR',
            errorMessage: 'Communication with Windows Job controller was interrupted.'
          });
        }
      });

      // Send the spawn request once connected
      try {
        const spawnReq = session.requestRootStart();
        const framed = frameControlMessage(spawnReq);
        socket.write(framed);
      } catch (err) {
        finish({
          processTreeSettled: false,
          processSpawned: false,
          errorCode: 'SPAWN_REQUEST_FAILED',
          errorMessage: err instanceof Error ? err.message : String(err)
        });
      }
    });

    function handleIncomingMessage(raw: unknown) {
      if (typeof raw !== 'object' || raw === null) return;
      const r = raw as Record<string, unknown>;

      if (r.kind === 'ack') {
        try {
          session.onRootStartAcknowledged(r as unknown as WindowsJobControlAck);
        } catch (err) {
          finish({
            processTreeSettled: false,
            processSpawned: false,
            errorCode: 'ADMISSION_DENIED',
            errorMessage: err instanceof Error ? err.message : String(err)
          });
        }
      } else if (r.kind === 'response') {
        try {
          const validated = session.ingestResponse(r);
          finish({
            status: validated.status,
            signal: (validated.signal as NodeJS.Signals | null) ?? null,
            processTreeSettled: validated.settled,
            processSpawned: true,
            timedOut: validated.phase === 'terminated' && validated.jobTerminated && !validated.error,
            ...(validated.error ? { errorCode: 'JOB_EXECUTION_ERROR', errorMessage: validated.error } : {})
          });
        } catch (err) {
          finish({
            processTreeSettled: false,
            processSpawned: true,
            errorCode: 'INVALID_CONTROL_RESPONSE',
            errorMessage: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }

    server.listen(pipePath, () => {
      const psArgs = [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        scriptPath,
        '-ControlPipeName',
        process.platform === 'win32' ? pipeName : pipePath,
        '-ExpectedNonce',
        nonce,
        '-WorkspaceId',
        workspaceId,
        '-InvocationId',
        invocationId
      ];

      const hostEnv = buildWindowsControllerHostEnvironment();
      psProcess = spawn(powershellPath, psArgs, {
        cwd: options.cwd ?? process.cwd(),
        env: hostEnv,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      psProcess.stderr?.on('data', (d) => {
        psStderr += d.toString('utf8');
      });

      psProcess.on('error', (err) => {
        finish({
          processTreeSettled: false,
          processSpawned: false,
          errorCode: 'POWERSHELL_SPAWN_FAILED',
          errorMessage: `Failed to spawn Windows PowerShell: ${err.message}`
        });
      });

      psProcess.on('exit', (code) => {
        if (!connected && !settled) {
          // PowerShell exited before connecting to the pipe. Inspect stderr for causal admission blockers.
          let errorCode = 'CONTROLLER_LAUNCH_FAILED';
          let errorMessage = `Windows PowerShell controller exited with code ${code}. Stderr: ${psStderr.trim()}`;

          if (/about_Execution_Policies|running scripts is disabled|execution policy/iu.test(psStderr)) {
            errorCode = 'RESTRICTED_EXECUTION_POLICY';
            errorMessage =
              'Windows PowerShell execution policy (e.g. Restricted or AllSigned) prevents running the controller script. Adjust execution policy (e.g. Set-ExecutionPolicy RemoteSigned -Scope CurrentUser) to permit script execution; Liftoff does not bypass execution policies.';
          } else if (/ConstrainedLanguage|not supported in this language mode|AppLocker/iu.test(psStderr)) {
            errorCode = 'CONSTRAINED_LANGUAGE_MODE';
            errorMessage =
              'Windows PowerShell is in ConstrainedLanguage mode or restricted by AppLocker/WDAC. Win32 Job Object creation requires FullLanguage mode.';
          }

          finish({
            processTreeSettled: false,
            processSpawned: false,
            errorCode,
            errorMessage
          });
        }
      });
    });

    server.on('error', (err) => {
      finish({
        processTreeSettled: false,
        processSpawned: false,
        errorCode: 'CONTROL_SERVER_ERROR',
        errorMessage: `Failed to start control pipe server: ${err.message}`
      });
    });
  });
}
