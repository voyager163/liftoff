import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, readFile, unlink } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ExternalCommand } from '../../domain/project/contracts.js';
import type { CommandResult, RunCommandOptions } from '../../process-runner.js';
import { environmentValue } from '../../domain/workstation/executables.js';
import {
  windowsWorkingDirectoryErrorCode, windowsWorkingDirectoryFits, windowsWorkingDirectoryRemedy
} from '../../domain/execution/windows-working-directory.js';
import { resolvePackageFile } from '../packaged-assets/package-root.js';
import {
  defaultWindowsJobControllerId,
  deriveInvocationDigest,
  encodeWindowsEnvironmentBlock,
  formatWindowsArgvCommandLine,
  frameControlMessage,
  unframeControlMessages,
  WindowsJobAdmissionDeniedError,
  WindowsJobExecutionSession,
  type WindowsJobAdmittedInvocation,
  type WindowsJobControlAck,
  type WindowsJobControlReady,
  type WindowsJobControlResponse
} from './windows-job-protocol.js';

export const windowsJobControllerAssetPathParts = ['assets', 'repair', 'windows-job-controller.ps1'] as const;
export const windowsJobControllerAssetDigest = 'a7aa404d84d1e0a9188b8c9d487533cacee830b4d58172ef959d159895c2d909';

export type WindowsControllerSpawnFn = (
  executable: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    shell?: boolean | string;
    windowsHide?: boolean;
    stdio?: ['ignore', 'pipe', 'pipe'];
  }
) => ChildProcess;

export interface WindowsJobRunnerOptions {
  assetPath?: string;
  expectedDigest?: string;
  powershellPath?: string;
  skipAssetVerification?: boolean;
  spawnController?: WindowsControllerSpawnFn;
}

export async function verifyWindowsJobControllerAsset(customPath?: string, expectedDigest?: string): Promise<string> {
  const assetPath = customPath ?? resolvePackageFile(...windowsJobControllerAssetPathParts);
  const bytes = await readFile(assetPath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const targetDigest = expectedDigest ?? windowsJobControllerAssetDigest;
  if (digest !== targetDigest) {
    throw new Error(
      `Windows Job Object controller asset integrity failure: found ${digest}; expected ${targetDigest}.`
    );
  }
  return assetPath;
}

export function resolveWindowsPowerShellPath(customPath?: string): string {
  if (customPath) return customPath;
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export interface ResolvedTargetCommand {
  executable: string;
  args: readonly string[];
}

export function resolveTargetExecutableCommand(
  command: ExternalCommand,
  env: NodeJS.ProcessEnv = {},
  cwd: string = process.cwd()
): ResolvedTargetCommand | null {
  const targetPath = environmentValue(env, 'PATH', 'win32') ?? '';
  const searchDirs = [cwd, ...targetPath.split(path.delimiter).filter(Boolean)];

  if (command.executable === 'npm' || command.executable === 'npm.cmd') {
    // 1. Resolve npm distribution by searching PATH precedence for npm-cli.js
    let resolvedNpmCli: string | null = null;
    for (const dir of searchDirs) {
      const candidates = [
        path.resolve(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.resolve(dir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.resolve(dir, 'npm-cli.js')
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          resolvedNpmCli = candidate;
          break;
        }
      }
      if (resolvedNpmCli) break;
    }

    if (!resolvedNpmCli) {
      return null;
    }

    // 2. Resolve Node interpreter independently across admitted search scope
    let resolvedNode: string | null = null;
    for (const dir of searchDirs) {
      for (const nodeName of ['node.exe', 'node']) {
        const candidate = path.resolve(dir, nodeName);
        if (existsSync(candidate)) {
          resolvedNode = candidate;
          break;
        }
      }
      if (resolvedNode) break;
    }

    if (!resolvedNode) {
      return null;
    }

    return {
      executable: resolvedNode,
      args: [resolvedNpmCli, ...command.args]
    };
  }

  if (path.isAbsolute(command.executable) && existsSync(command.executable)) {
    return { executable: command.executable, args: command.args };
  }

  const isWin = process.platform === 'win32';
  const pathext = isWin
    ? (environmentValue(env, 'PATHEXT', 'win32') ?? '.EXE;.COM;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  // On Windows, prioritize binary executables (.exe, .com)
  const extensions = path.extname(command.executable)
    ? ['']
    : (isWin ? ['.exe', '.com', ...pathext.filter((e) => !/^\.(?:exe|com)$/i.test(e))] : ['']);

  for (const dir of searchDirs) {
    for (const ext of extensions) {
      const candidate = path.resolve(dir, `${command.executable}${ext}`);
      if (existsSync(candidate)) {
        return { executable: candidate, args: command.args };
      }
    }
  }

  return null;
}

export function buildWindowsControllerHostEnvironment(): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const windir = process.env.WINDIR ?? process.env.windir ?? systemRoot;
  const systemDrive = process.env.SystemDrive ?? process.env.SYSTEMDRIVE ?? (systemRoot.slice(0, 2) || 'C:');
  const comspec = process.env.COMSPEC ?? process.env.ComSpec ?? path.join(systemRoot, 'System32', 'cmd.exe');
  const controllerPathDirs = [
    path.dirname(process.execPath),
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    path.join(systemRoot, 'System32'),
    systemRoot,
    '/bin',
    '/usr/bin'
  ];
  const controllerPath = controllerPathDirs.join(path.delimiter);

  const env: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot,
    WINDIR: windir,
    SystemDrive: systemDrive,
    COMSPEC: comspec,
    PATH: controllerPath,
    PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS'
  };
  const tempDir = process.env.TEMP ?? process.env.TMP ?? tmpdir();
  if (tempDir) {
    env.TEMP = tempDir;
    env.TMP = tempDir;
  }
  if (process.env.USERPROFILE) {
    env.USERPROFILE = process.env.USERPROFILE;
  }
  // Preserve inherited process-scope execution policy preference so it is not accidentally relaxed
  if (process.env.PSExecutionPolicyPreference !== undefined) {
    env.PSExecutionPolicyPreference = process.env.PSExecutionPolicyPreference;
  }
  return env;
}

async function readBoundedLogFile(filePath: string, maxBytes: number, requiredAfterDispatch: boolean): Promise<Buffer> {
  if (maxBytes <= 0) return Buffer.alloc(0);
  let fileHandle;
  try {
    fileHandle = await open(filePath, 'r');
    const stat = await fileHandle.stat();
    if (!stat.isFile()) {
      throw new Error(`Execution log "${filePath}" is not a regular file; concurrent replacement or directory link detected.`);
    }
    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    if (bytesToRead > 0) {
      const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, 0);
      if (bytesRead !== bytesToRead) {
        throw new Error(`Incomplete read of execution log "${filePath}": expected ${bytesToRead} bytes, got ${bytesRead}.`);
      }
    }
    return buffer;
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code: unknown }).code : undefined;
    if (code === 'ENOENT' && !requiredAfterDispatch) {
      return Buffer.alloc(0);
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    await fileHandle?.close().catch(() => {});
  }
}

export async function runWindowsJobCommand(
  command: ExternalCommand,
  options: RunCommandOptions = {},
  runnerOptions: WindowsJobRunnerOptions = {}
): Promise<CommandResult> {
  const displayCommand = [command.executable, ...command.args].join(' ');
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  const effectiveCwd = path.resolve(options.cwd ?? process.cwd());

  if (options.signal?.aborted) {
    return {
      command,
      displayCommand,
      status: null,
      signal: 'SIGABRT',
      stdout: '',
      stderr: '',
      timedOut: false,
      processTreeSettled: false,
      processSpawned: false,
      errorCode: 'ABORTED',
      errorMessage: 'Command was aborted before execution.'
    };
  }

  if (process.platform === 'win32' && !windowsWorkingDirectoryFits(effectiveCwd)) {
    return {
      command, displayCommand, status: null, signal: null, stdout: '', stderr: '', timedOut: false,
      processTreeSettled: true, processSpawned: false,
      errorCode: windowsWorkingDirectoryErrorCode, errorMessage: windowsWorkingDirectoryRemedy
    };
  }

  let scriptPath: string;
  try {
    scriptPath = runnerOptions.skipAssetVerification
      ? (runnerOptions.assetPath ?? resolvePackageFile(...windowsJobControllerAssetPathParts))
      : await verifyWindowsJobControllerAsset(runnerOptions.assetPath, runnerOptions.expectedDigest);
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

  if (options.signal?.aborted) {
    return {
      command,
      displayCommand,
      status: null,
      signal: 'SIGABRT',
      stdout: '',
      stderr: '',
      timedOut: false,
      processTreeSettled: false,
      processSpawned: false,
      errorCode: 'ABORTED',
      errorMessage: 'Command was aborted before execution.'
    };
  }

  const powershellPath = resolveWindowsPowerShellPath(runnerOptions.powershellPath);
  if (!runnerOptions.spawnController && !existsSync(powershellPath)) {
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

  const tempLogPrefix = path.join(tmpdir(), `liftoff-job-${randomBytes(8).toString('hex')}`);
  const stdoutFile = `${tempLogPrefix}-stdout.log`;
  const stderrFile = `${tempLogPrefix}-stderr.log`;

  const envDigest = createHash('sha256').update(envBlock).digest('hex');
  const session = new WindowsJobExecutionSession();
  session.onControllerReady(defaultWindowsJobControllerId);

  const resolvedTarget = resolveTargetExecutableCommand(command, options.env, effectiveCwd);
  if (!resolvedTarget) {
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
      errorCode: 'ENOENT',
      errorMessage: `Executable "${command.executable}" could not be resolved against the admitted target environment PATH.`
    };
  }

  const invocation: WindowsJobAdmittedInvocation = {
    workspaceId,
    controllerId: defaultWindowsJobControllerId,
    executable: resolvedTarget.executable,
    args: resolvedTarget.args,
    cwd: effectiveCwd,
    envDigest,
    timeoutMs,
    maxOutputBytes,
    envBlockBase64: envBlock.toString('base64'),
    stdoutFile,
    stderrFile
  };

  session.admitScope(invocation, nonce);
  const invocationId = session.getInvocationId()!;

  return new Promise<CommandResult>((resolve) => {
    let clientSocket: net.Socket | null = null;
    let psProcess: ChildProcess | null = null;
    let psStderr = '';
    let connected = false;
    let authenticated = false;
    let spawnRequestDispatched = false;
    let settled = false;
    let incomingBuffer = Buffer.alloc(0);
    let startupTimer: NodeJS.Timeout | null = null;
    let dispatchAckTimer: NodeJS.Timeout | null = null;
    let commandTimer: NodeJS.Timeout | null = null;
    let abortHandler: (() => void) | null = null;

    const safeUnlink = async (file: string): Promise<boolean> => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await unlink(file);
          return true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
          if (attempt < 4) await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        }
      }
      return false;
    };

    const finish = async (result: Partial<CommandResult> & { processTreeSettled: boolean; processSpawned: boolean }) => {
      if (settled) return;
      settled = true;

      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      if (dispatchAckTimer) {
        clearTimeout(dispatchAckTimer);
        dispatchAckTimer = null;
      }
      if (commandTimer) {
        clearTimeout(commandTimer);
        commandTimer = null;
      }
      if (abortHandler && options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
        abortHandler = null;
      }

      try { clientSocket?.destroy(); } catch { /* ignore */ }
      try { server.close(); } catch { /* ignore */ }
      if (psProcess && !psProcess.killed && psProcess.exitCode === null) {
        try { psProcess.kill(); } catch { /* ignore */ }
        await new Promise<void>((r) => {
          const timer = setTimeout(r, 1000);
          psProcess?.once('exit', () => { clearTimeout(timer); r(); });
        });
      }

      let capturedStdout = result.stdout ?? '';
      let capturedStderr = result.stderr ?? '';
      let logReadError: Error | null = null;

      if (!capturedStdout && !capturedStderr) {
        try {
          const stdoutBuf = await readBoundedLogFile(stdoutFile, maxOutputBytes, spawnRequestDispatched);
          const remainingBytes = Math.max(0, maxOutputBytes - stdoutBuf.length);
          const stderrBuf = await readBoundedLogFile(stderrFile, remainingBytes, spawnRequestDispatched);

          const stdoutDecoder = new StringDecoder('utf8');
          capturedStdout = stdoutDecoder.write(stdoutBuf) + stdoutDecoder.end();

          const stderrDecoder = new StringDecoder('utf8');
          capturedStderr = stderrDecoder.write(stderrBuf) + stderrDecoder.end();
        } catch (err) {
          logReadError = err instanceof Error ? err : new Error(String(err));
        }
      }

      // Preserve potentially active output files on uncertain settlement.
      // Only delete exact attributable owned files after safe settlement.
      let cleanupFailed = false;
      const initialSettled = Boolean(result.processTreeSettled) && logReadError === null;
      if (initialSettled) {
        const stdoutCleaned = await safeUnlink(stdoutFile);
        const stderrCleaned = await safeUnlink(stderrFile);
        cleanupFailed = !stdoutCleaned || !stderrCleaned;
      }

      const determinedSpawned = spawnRequestDispatched || (result.processSpawned ?? (
        session.getState() === 'root-started' ||
        session.getState() === 'settled'
      ));

      const effectiveSettled = (cleanupFailed || logReadError !== null) ? false : result.processTreeSettled;
      const effectiveErrorCode = logReadError !== null
        ? (result.errorCode ?? 'LOG_READ_FAILED')
        : cleanupFailed
          ? (result.errorCode ?? 'LOG_CLEANUP_FAILED')
          : result.errorCode;
      const effectiveErrorMessage = logReadError !== null
        ? `${result.errorMessage ? `${result.errorMessage} ` : ''}Failed to read execution logs: ${logReadError.message}`
        : cleanupFailed
          ? `${result.errorMessage ? `${result.errorMessage} ` : ''}Failed to clean up temporary execution log files.`
          : result.errorMessage;

      resolve({
        command,
        displayCommand,
        status: result.status ?? null,
        signal: result.signal ?? null,
        stdout: capturedStdout,
        stderr: capturedStderr,
        timedOut: result.timedOut ?? false,
        processTreeSettled: effectiveSettled,
        processSpawned: determinedSpawned,
        ...(result.outputLimitExceeded !== undefined ? { outputLimitExceeded: result.outputLimitExceeded } : {}),
        ...(effectiveErrorCode ? { errorCode: effectiveErrorCode } : {}),
        ...(effectiveErrorMessage ? { errorMessage: effectiveErrorMessage } : {})
      });
    };

    if (options.signal) {
      abortHandler = () => {
        void finish({
          signal: 'SIGABRT',
          processTreeSettled: false,
          processSpawned: spawnRequestDispatched,
          errorCode: 'ABORTED',
          errorMessage: 'Command execution was aborted.'
        });
      };
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    const startupTimeoutMs = 30_000;
    startupTimer = setTimeout(() => {
      void finish({
        timedOut: true,
        processTreeSettled: false,
        processSpawned: false,
        errorCode: 'CONTROLLER_STARTUP_TIMEOUT',
        errorMessage: `Supervisor timeout: Windows PowerShell controller failed to start and authenticate within ${startupTimeoutMs}ms.`
      });
    }, startupTimeoutMs);

    const server = net.createServer((socket) => {
      if (connected) {
        socket.destroy();
        return;
      }
      connected = true;
      clientSocket = socket;

      socket.on('data', (chunk) => {
        try {
          incomingBuffer = Buffer.from(Buffer.concat([incomingBuffer, chunk]));
          const { messages, remainder } = unframeControlMessages(incomingBuffer);
          incomingBuffer = Buffer.from(remainder);

          for (const msg of messages) {
            handleIncomingMessage(msg);
          }
        } catch (err) {
          void finish({
            processTreeSettled: false,
            processSpawned: spawnRequestDispatched,
            errorCode: 'INVALID_CONTROL_FRAME',
            errorMessage: `Control protocol framing error: ${err instanceof Error ? err.message : String(err)}`
          });
        }
      });

      socket.on('error', () => {
        if (!settled) {
          void finish({
            processTreeSettled: false,
            processSpawned: spawnRequestDispatched,
            errorCode: 'CONTROL_PIPE_ERROR',
            errorMessage: 'Communication with Windows Job controller was interrupted.'
          });
        }
      });

      socket.on('close', () => {
        if (!settled) {
          void finish({
            processTreeSettled: false,
            processSpawned: spawnRequestDispatched,
            errorCode: 'CONTROL_PIPE_DISCONNECTED',
            errorMessage: 'Control pipe connection to Windows Job controller was closed unexpectedly.'
          });
        }
      });
    });

    server.maxConnections = 1;

    function handleIncomingMessage(raw: unknown) {
      if (typeof raw !== 'object' || raw === null) return;
      const r = raw as Record<string, unknown>;

      if (r.kind === 'ready') {
        if (spawnRequestDispatched) {
          void finish({
            processTreeSettled: false,
            processSpawned: true,
            errorCode: 'INVALID_CONTROL_FRAME',
            errorMessage: 'Unexpected ready frame received after spawn request was already dispatched.'
          });
          return;
        }

        try {
          session.authenticateControllerReady(r);
          authenticated = true;
          if (startupTimer) {
            clearTimeout(startupTimer);
            startupTimer = null;
          }
        } catch (err) {
          void finish({
            processTreeSettled: false,
            processSpawned: false,
            errorCode: 'AUTHENTICATION_FAILED',
            errorMessage: err instanceof Error ? err.message : String(err)
          });
          return;
        }

        try {
          // Controller is authenticated; send the spawn request now
          const spawnReq = session.requestRootStart();
          const framed = frameControlMessage(spawnReq);
          clientSocket?.write(framed);
          spawnRequestDispatched = true;

          const dispatchAckTimeoutMs = timeoutMs > 0 && Number.isFinite(timeoutMs) ? Math.min(timeoutMs, 15_000) : 15_000;
          dispatchAckTimer = setTimeout(() => {
            void finish({
              timedOut: true,
              processTreeSettled: false,
              processSpawned: true,
              errorCode: 'SUPERVISOR_TIMEOUT',
              errorMessage: `Supervisor timeout: Controller did not acknowledge root process start within ${dispatchAckTimeoutMs}ms.`
            });
          }, dispatchAckTimeoutMs);
        } catch (err) {
          void finish({
            processTreeSettled: false,
            processSpawned: false,
            errorCode: 'SPAWN_REQUEST_FAILED',
            errorMessage: err instanceof Error ? err.message : String(err)
          });
        }
      } else if (!authenticated) {
        void finish({
          processTreeSettled: false,
          processSpawned: spawnRequestDispatched,
          errorCode: 'AUTHENTICATION_FAILED',
          errorMessage: 'Control pipe client sent message before authenticating with ready frame.'
        });
      } else if (r.kind === 'ack') {
        if (dispatchAckTimer) {
          clearTimeout(dispatchAckTimer);
          dispatchAckTimer = null;
        }
        try {
          session.onRootStartAcknowledged(r as unknown as WindowsJobControlAck);
          const settlementGraceMs = options.settlementWaitMs ?? 5_000;
          const commandDeadlineMs = (timeoutMs > 0 && Number.isFinite(timeoutMs) ? timeoutMs : 120_000) + settlementGraceMs;
          commandTimer = setTimeout(() => {
            void finish({
              timedOut: true,
              processTreeSettled: false,
              processSpawned: true,
              errorCode: 'SUPERVISOR_TIMEOUT',
              errorMessage: `Supervisor timeout: Command execution in Windows Job Object exceeded ${timeoutMs}ms without reporting settlement within ${settlementGraceMs}ms grace.`
            });
          }, commandDeadlineMs);
        } catch (err) {
          if (err instanceof WindowsJobAdmissionDeniedError) {
            void finish({
              processTreeSettled: false,
              processSpawned: false,
              errorCode: 'ADMISSION_DENIED',
              errorMessage: err.message
            });
          } else {
            void finish({
              processTreeSettled: false,
              processSpawned: true,
              errorCode: 'INVALID_CONTROL_RESPONSE',
              errorMessage: err instanceof Error ? err.message : String(err)
            });
          }
        }
      } else if (r.kind === 'response') {
        if (commandTimer) {
          clearTimeout(commandTimer);
          commandTimer = null;
        }
        try {
          const validated = session.ingestResponse(r);
          const outputLimitExceeded = Boolean(validated.outputLimitExceeded);
          const timedOut = validated.phase === 'terminated' && validated.jobTerminated && !validated.error && !outputLimitExceeded;
          void finish({
            status: validated.status,
            signal: (validated.signal as NodeJS.Signals | null) ?? null,
            processTreeSettled: validated.settled,
            processSpawned: true,
            timedOut,
            outputLimitExceeded,
            ...(validated.error ? { errorCode: 'JOB_EXECUTION_ERROR', errorMessage: validated.error } : {})
          });
        } catch (err) {
          void finish({
            processTreeSettled: false,
            processSpawned: true,
            errorCode: 'INVALID_CONTROL_RESPONSE',
            errorMessage: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }

    server.listen(pipePath, () => {
      if (settled || options.signal?.aborted) {
        void finish({
          signal: 'SIGABRT',
          processTreeSettled: false,
          processSpawned: false,
          errorCode: 'ABORTED',
          errorMessage: 'Command was aborted before execution.'
        });
        return;
      }

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
      const spawnFn = runnerOptions.spawnController ?? spawn;
      psProcess = spawnFn(powershellPath, psArgs, {
        cwd: process.cwd(),
        env: hostEnv,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      psProcess.stderr?.on('data', (d) => {
        psStderr += d.toString('utf8');
      });

      psProcess.on('error', (err) => {
        void finish({
          processTreeSettled: false,
          processSpawned: false,
          errorCode: 'POWERSHELL_SPAWN_FAILED',
          errorMessage: `Failed to spawn Windows PowerShell: ${err.message}`
        });
      });

      psProcess.on('exit', (code) => {
        if (!settled) {
          // PowerShell exited before completing. Inspect stderr for causal admission blockers.
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
          } else if (connected) {
            errorCode = 'CONTROLLER_EXITED_UNEXPECTEDLY';
            errorMessage = `Windows PowerShell controller exited prematurely with code ${code}. Stderr: ${psStderr.trim()}`;
          }

          void finish({
            processTreeSettled: false,
            processSpawned: spawnRequestDispatched || session.getState() === 'root-started',
            errorCode,
            errorMessage
          });
        }
      });
    });

    server.on('error', (err) => {
      void finish({
        processTreeSettled: false,
        processSpawned: spawnRequestDispatched,
        errorCode: 'CONTROL_SERVER_ERROR',
        errorMessage: `Failed to start control pipe server: ${err.message}`
      });
    });
  });
}
