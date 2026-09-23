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
export const windowsJobControllerAssetDigest = '84294e17f22ed9405c8956b8d5cf96e1f394c4ba4152d83cf899df236c027b38';

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

export interface ResolvedTargetCommand {
  executable: string;
  args: readonly string[];
}

export function resolveTargetExecutableCommand(
  command: ExternalCommand,
  env: NodeJS.ProcessEnv = {},
  cwd: string = process.cwd()
): ResolvedTargetCommand | null {
  const targetPath = env.PATH ?? env.Path ?? '';
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
    ? (env.PATHEXT ?? env.PathExt ?? '.EXE;.COM;.CMD;.BAT').split(';').filter(Boolean)
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
  const systemDrive = process.env.SystemDrive ?? process.env.SYSTEMDRIVE ?? 'C:';
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
    SYSTEMROOT: systemRoot,
    WINDIR: windir,
    windir: windir,
    SystemDrive: systemDrive,
    COMSPEC: comspec,
    ComSpec: comspec,
    PATH: controllerPath,
    Path: controllerPath,
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
  for (const name of ['APPDATA', 'LOCALAPPDATA'] as const) {
    if (process.env[name]) env[name] = process.env[name];
  }
  // Preserve inherited process-scope execution policy preference so it is not accidentally relaxed
  if (process.env.PSExecutionPolicyPreference !== undefined) {
    env.PSExecutionPolicyPreference = process.env.PSExecutionPolicyPreference;
  }
  return env;
}

async function readBoundedFile(filePath: string, maxBytes: number): Promise<Buffer> {
  if (maxBytes <= 0) return Buffer.alloc(0);
  let fileHandle;
  try {
    fileHandle = await open(filePath, 'r');
    const stat = await fileHandle.stat();
    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    if (bytesToRead > 0) {
      await fileHandle.read(buffer, 0, bytesToRead, 0);
    }
    return buffer;
  } catch {
    return Buffer.alloc(0);
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

  const tempLogPrefix = path.join(tmpdir(), `liftoff-job-${randomBytes(8).toString('hex')}`);
  const stdoutFile = `${tempLogPrefix}-stdout.log`;
  const stderrFile = `${tempLogPrefix}-stderr.log`;

  const envDigest = createHash('sha256').update(envBlock).digest('hex');
  const session = new WindowsJobExecutionSession();
  session.onControllerReady(defaultWindowsJobControllerId);

  const effectiveCwd = options.cwd ?? process.cwd();
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
    let supervisorTimer: NodeJS.Timeout | null = null;
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

      if (supervisorTimer) {
        clearTimeout(supervisorTimer);
        supervisorTimer = null;
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

      if (!capturedStdout && !capturedStderr) {
        try {
          const stdoutBuf = await readBoundedFile(stdoutFile, maxOutputBytes);
          const remainingBytes = Math.max(0, maxOutputBytes - stdoutBuf.length);
          const stderrBuf = await readBoundedFile(stderrFile, remainingBytes);

          const stdoutDecoder = new StringDecoder('utf8');
          capturedStdout = stdoutDecoder.write(stdoutBuf) + stdoutDecoder.end();

          const stderrDecoder = new StringDecoder('utf8');
          capturedStderr = stderrDecoder.write(stderrBuf) + stderrDecoder.end();
        } catch { /* ignore */ }
      }

      const stdoutCleaned = await safeUnlink(stdoutFile);
      const stderrCleaned = await safeUnlink(stderrFile);
      const cleanupFailed = !stdoutCleaned || !stderrCleaned;

      const determinedSpawned = result.processSpawned ?? (
        session.getState() === 'root-started' ||
        session.getState() === 'settled' ||
        spawnRequestDispatched
      );

      const effectiveSettled = cleanupFailed ? false : result.processTreeSettled;
      const effectiveErrorCode = cleanupFailed
        ? (result.errorCode ?? 'LOG_CLEANUP_FAILED')
        : result.errorCode;
      const effectiveErrorMessage = cleanupFailed
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

    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      supervisorTimer = setTimeout(() => {
        const controllerStage = [...psStderr.matchAll(/LIFTOFF_CONTROLLER_STAGE: (compiling|connecting|connected)/gu)].at(-1)?.[1] ?? 'not-reported';
        void finish({
          timedOut: true,
          processTreeSettled: false,
          processSpawned: spawnRequestDispatched,
          errorCode: 'SUPERVISOR_TIMEOUT',
          errorMessage: `Supervisor timeout: Windows Job Object controller exceeded ${timeoutMs}ms without reporting settlement (controller=${controllerStage}, connected=${connected}, authenticated=${authenticated}, state=${session.getState()}).`
        });
      }, timeoutMs + 5000);
    }

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
        try {
          session.onRootStartAcknowledged(r as unknown as WindowsJobControlAck);
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
      psProcess = spawn(powershellPath, psArgs, {
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
