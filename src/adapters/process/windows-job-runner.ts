import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, existsSync, type BigIntStats } from 'node:fs';
import { lstat, mkdtemp, open, readFile, rm, unlink, writeFile, type FileHandle } from 'node:fs/promises';
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
export const windowsJobControllerAssetDigest = '943f27f794a8161a7486aa6b02fa467788f0c3ab633ca340b214e8bb3d0f4125';
const controllerStartupTimeoutMs = 15_000;
const controllerSettlementGraceMs = 5_000;
const controllerInteropAssemblyMaximumBytes = 1024 * 1024;
const controllerAdmissionStages = [
  'frame-header-read', 'frame-payload-read', 'frame-json', 'frame-returned',
  'environment-decode', 'environment-digest', 'environment-allocate', 'environment-verified',
  'job-create', 'job-configure', 'job-configured', 'stdio-open', 'stdio-configured',
  'attributes-initialize', 'attributes-job', 'attributes-handles', 'attributes-configured',
  'startup-info', 'executable-check', 'launch-enter', 'create-process', 'create-process-returned',
  'job-membership', 'job-membership-verified', 'resume-thread', 'resume-thread-returned', 'launch-returned',
  'ack-write', 'ack-written'
] as const;

export interface WindowsJobInteropAssemblyIdentity {
  controllerAssetDigest: string;
  powershellPath: string;
}

export type WindowsJobInteropAssemblyReservation =
  | { kind: 'producer'; publish(bytes: Buffer): void; fail(error: Error): void }
  | { kind: 'consumer'; bytes: Buffer };

type WindowsJobInteropAssemblyResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; error: Error };

type WindowsJobInteropAssemblyEntry =
  | {
      state: 'preparing';
      identity: string;
      result: Promise<WindowsJobInteropAssemblyResult>;
      resolve(result: WindowsJobInteropAssemblyResult): void;
    }
  | { state: 'ready'; identity: string; bytes: Buffer };

function windowsJobInteropAssemblyIdentity(identity: WindowsJobInteropAssemblyIdentity): string {
  return createHash('sha256').update(JSON.stringify([
    'liftoff-windows-job-interop-v1',
    identity.controllerAssetDigest,
    identity.powershellPath
  ])).digest('hex');
}

function verifiedWindowsJobInteropAssembly(bytes: Buffer): Buffer {
  if (bytes.length < 2 || bytes.length > controllerInteropAssemblyMaximumBytes ||
    bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error('Windows Job controller produced an invalid bounded interop assembly.');
  }
  return Buffer.from(bytes);
}

export class WindowsJobInteropAssemblyCache {
  private entry: WindowsJobInteropAssemblyEntry | null = null;

  async reserve(identity: WindowsJobInteropAssemblyIdentity): Promise<WindowsJobInteropAssemblyReservation> {
    const exactIdentity = windowsJobInteropAssemblyIdentity(identity);
    if (this.entry?.identity !== exactIdentity) {
      if (this.entry?.state === 'preparing') {
        throw new Error('Windows Job interop preparation identity changed while the original producer was active.');
      }
      this.entry = null;
    }
    if (this.entry?.state === 'ready') {
      return { kind: 'consumer', bytes: Buffer.from(this.entry.bytes) };
    }
    if (this.entry?.state === 'preparing') {
      const result = await this.entry.result;
      if (!result.ok) throw result.error;
      return { kind: 'consumer', bytes: Buffer.from(result.bytes) };
    }

    let resolve!: (result: WindowsJobInteropAssemblyResult) => void;
    const result = new Promise<WindowsJobInteropAssemblyResult>((complete) => { resolve = complete; });
    const preparing: WindowsJobInteropAssemblyEntry = { state: 'preparing', identity: exactIdentity, result, resolve };
    this.entry = preparing;
    let active = true;
    return {
      kind: 'producer',
      publish: (bytes) => {
        if (!active || this.entry !== preparing) throw new Error('Windows Job interop producer is no longer current.');
        try {
          const verified = verifiedWindowsJobInteropAssembly(bytes);
          this.entry = { state: 'ready', identity: exactIdentity, bytes: verified };
          active = false;
          resolve({ ok: true, bytes: Buffer.from(verified) });
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          this.entry = null;
          active = false;
          resolve({ ok: false, error: failure });
          throw failure;
        }
      },
      fail: (error) => {
        if (!active || this.entry !== preparing) return;
        this.entry = null;
        active = false;
        resolve({ ok: false, error });
      }
    };
  }
}

const windowsJobInteropAssemblyCache = new WindowsJobInteropAssemblyCache();

class WindowsJobInteropPreparationStoppedError extends Error {
  constructor(readonly reason: 'timeout' | 'aborted') {
    super(reason === 'timeout'
      ? 'Windows Job interop preparation exceeded the controller startup deadline.'
      : 'Windows Job interop preparation was aborted.');
  }
}

export interface WindowsJobInteropPreparationOperations {
  createPrivateDirectory(prefix: string): Promise<string>;
  writePrivateFile(filePath: string, bytes: Buffer, signal: AbortSignal): Promise<void>;
  removePrivateDirectory(directory: string): Promise<boolean>;
}

const windowsJobInteropPreparationOperations: WindowsJobInteropPreparationOperations = {
  createPrivateDirectory: (prefix) => mkdtemp(prefix),
  writePrivateFile: async (filePath, bytes, signal) => {
    await writeFile(filePath, bytes, { flag: 'wx', mode: 0o600, signal });
  },
  removePrivateDirectory: async (directory) => {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
      return true;
    } catch {
      return false;
    }
  }
};

export type WindowsJobInteropPreparationResult =
  | {
      ok: true;
      reservation: WindowsJobInteropAssemblyReservation;
      directory: string;
      assemblyPath: string;
      remainingStartupMs: number;
      cleanup(): Promise<boolean>;
    }
  | {
      ok: false;
      reason: 'timeout' | 'aborted' | 'failed';
      cleanupStatus: 'complete' | 'failed' | 'pending';
      cleanup: Promise<boolean>;
    };

export async function prepareWindowsJobInteropAssembly(options: {
  identity: WindowsJobInteropAssemblyIdentity;
  startupTimeoutMs: number;
  signal?: AbortSignal;
  cache?: WindowsJobInteropAssemblyCache;
  operations?: WindowsJobInteropPreparationOperations;
}): Promise<WindowsJobInteropPreparationResult> {
  const cache = options.cache ?? windowsJobInteropAssemblyCache;
  const operations = options.operations ?? windowsJobInteropPreparationOperations;
  const deadline = performance.now() + options.startupTimeoutMs;
  const operationAbort = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let directory: string | null = null;
  let reservation: WindowsJobInteropAssemblyReservation | null = null;
  let stopped: WindowsJobInteropPreparationStoppedError | null = null;
  let timeout: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  let rejectStopped!: (error: WindowsJobInteropPreparationStoppedError) => void;
  const stoppedPromise = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  void stoppedPromise.catch(() => {});

  const stop = (reason: 'timeout' | 'aborted') => {
    if (stopped) return;
    stopped = new WindowsJobInteropPreparationStoppedError(reason);
    operationAbort.abort();
    rejectStopped(stopped);
  };
  timeout = setTimeout(() => stop('timeout'), Math.max(0, options.startupTimeoutMs));
  if (options.signal) {
    abortHandler = () => stop('aborted');
    if (options.signal.aborted) abortHandler();
    else options.signal.addEventListener('abort', abortHandler, { once: true });
  }

  const disposeStopWatch = () => {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    if (abortHandler && options.signal) options.signal.removeEventListener('abort', abortHandler);
    abortHandler = undefined;
  };
  const runOperation = async <T>(start: () => Promise<T>, observe?: (value: T) => void): Promise<T> => {
    if (stopped) throw stopped;
    const observed = start().then((value) => {
      observe?.(value);
      return value;
    });
    pending.add(observed);
    observed.then(() => pending.delete(observed), () => pending.delete(observed));
    const value = await Promise.race([observed, stoppedPromise]);
    if (stopped) throw stopped;
    return value;
  };
  const cleanup = async (): Promise<boolean> => {
    await Promise.allSettled([...pending]);
    return directory ? operations.removePrivateDirectory(directory) : true;
  };

  try {
    reservation = await runOperation(
      () => cache.reserve(options.identity),
      (acquired) => {
        reservation = acquired;
        if (stopped && acquired.kind === 'producer') {
          acquired.fail(new Error('Windows Job interop preparation stopped before producer acquisition completed.'));
        }
      }
    );
    directory = await runOperation(
      () => operations.createPrivateDirectory(path.join(tmpdir(), 'liftoff-job-interop-')),
      (created) => { directory = created; }
    );
    const assemblyPath = path.join(directory, 'Win32JobNative.dll');
    if (reservation.kind === 'consumer') {
      const consumerBytes = reservation.bytes;
      await runOperation(() => operations.writePrivateFile(
        assemblyPath,
        consumerBytes,
        operationAbort.signal
      ));
    }
    const remainingStartupMs = Math.floor(deadline - performance.now());
    if (remainingStartupMs <= 0) {
      stop('timeout');
      throw stopped;
    }
    disposeStopWatch();
    return {
      ok: true,
      reservation,
      directory,
      assemblyPath,
      remainingStartupMs,
      cleanup
    };
  } catch (error) {
    operationAbort.abort();
    if (reservation?.kind === 'producer') {
      reservation.fail(new Error('Windows Job interop preparation did not reach authenticated readiness.'));
    }
    const cleanupPending = pending.size > 0;
    const cleanupPromise = cleanup();
    let cleanupStatus: 'complete' | 'failed' | 'pending' = 'pending';
    try {
      if (!cleanupPending) {
        if (!directory) cleanupStatus = 'complete';
        else {
          cleanupStatus = await Promise.race([
            cleanupPromise.then((cleaned): 'complete' | 'failed' => cleaned ? 'complete' : 'failed'),
            stoppedPromise
          ]);
        }
      }
    } catch (cleanupError) {
      if (!(cleanupError instanceof WindowsJobInteropPreparationStoppedError)) throw cleanupError;
    } finally {
      disposeStopWatch();
    }
    return {
      ok: false,
      reason: error instanceof WindowsJobInteropPreparationStoppedError ? error.reason : 'failed',
      cleanupStatus,
      cleanup: cleanupPromise
    };
  }
}

export interface WindowsJobInteropReadableFile {
  stat(): Promise<BigIntStats>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface WindowsJobInteropCaptureOperations {
  lstat(filePath: string): Promise<BigIntStats>;
  open(filePath: string): Promise<WindowsJobInteropReadableFile>;
}

const windowsJobInteropCaptureOperations: WindowsJobInteropCaptureOperations = {
  lstat: (filePath) => lstat(filePath, { bigint: true }),
  open: async (filePath) => {
    const handle: FileHandle = await open(filePath, constants.O_RDONLY);
    return {
      stat: () => handle.stat({ bigint: true }),
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: () => handle.close()
    };
  }
};

function sameInteropPhysicalFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

export async function captureWindowsJobInteropAssembly(
  filePath: string,
  signal?: AbortSignal,
  operations: WindowsJobInteropCaptureOperations = windowsJobInteropCaptureOperations
): Promise<Buffer> {
  const throwIfAborted = () => {
    if (signal?.aborted) throw new Error('Windows Job interop capture was aborted.');
  };
  throwIfAborted();
  const pathStat = await operations.lstat(filePath);
  throwIfAborted();
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1n) {
    throw new Error('Windows Job controller interop assembly is not a private regular file.');
  }
  if (pathStat.size < 2n || pathStat.size > BigInt(controllerInteropAssemblyMaximumBytes)) {
    throw new Error('Windows Job controller interop assembly exceeds the bounded capture size.');
  }

  let file: WindowsJobInteropReadableFile | null = null;
  try {
    file = await operations.open(filePath);
    throwIfAborted();
    const openedStat = await file.stat();
    if (!openedStat.isFile() || openedStat.nlink !== 1n || !sameInteropPhysicalFile(pathStat, openedStat)) {
      throw new Error('Windows Job controller interop assembly changed before bounded capture.');
    }
    const size = Number(openedStat.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      throwIfAborted();
      const { bytesRead } = await file.read(bytes, offset, size - offset, offset);
      if (bytesRead <= 0) throw new Error('Windows Job controller interop assembly ended during bounded capture.');
      offset += bytesRead;
    }
    // Windows can retain unchanged timestamps while an open file is modified in place.
    const readback = Buffer.alloc(Math.min(size, 64 * 1024));
    let checked = 0;
    while (checked < size) {
      throwIfAborted();
      const { bytesRead } = await file.read(readback, 0, Math.min(readback.length, size - checked), checked);
      if (bytesRead <= 0 || !readback.subarray(0, bytesRead).equals(bytes.subarray(checked, checked + bytesRead))) {
        throw new Error('Windows Job controller interop assembly changed during bounded capture.');
      }
      checked += bytesRead;
    }
    throwIfAborted();
    const overflow = Buffer.alloc(1);
    const overflowRead = await file.read(overflow, 0, 1, size);
    const capturedStat = await file.stat();
    throwIfAborted();
    if (overflowRead.bytesRead !== 0 || !sameInteropPhysicalFile(openedStat, capturedStat)) {
      throw new Error('Windows Job controller interop assembly changed during bounded capture.');
    }
    return verifiedWindowsJobInteropAssembly(bytes);
  } finally {
    await file?.close();
  }
}

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

  let interopReservation: WindowsJobInteropAssemblyReservation | null = null;
  let interopAssemblyPath: string | null = null;
  let interopCleanup: (() => Promise<boolean>) | null = null;
  let controllerStartupBudgetMs = controllerStartupTimeoutMs;
  if (process.platform === 'win32' &&
    !runnerOptions.assetPath &&
    !runnerOptions.powershellPath &&
    !runnerOptions.skipAssetVerification) {
    const preparation = await prepareWindowsJobInteropAssembly({
      identity: {
        controllerAssetDigest: windowsJobControllerAssetDigest,
        powershellPath
      },
      startupTimeoutMs: controllerStartupTimeoutMs,
      signal: options.signal
    });
    if (!preparation.ok) {
      if (preparation.cleanupStatus === 'pending') {
        void preparation.cleanup.then((cleaned) => {
          if (!cleaned) {
            process.emitWarning(
              'Windows Job interop preparation cleanup failed after the startup operation was cancelled.'
            );
          }
        });
      }
      const cleanupSuffix = preparation.cleanupStatus === 'failed'
        ? ' Failed to clean up temporary Windows Job interop preparation files.'
        : preparation.cleanupStatus === 'pending'
          ? ' Late preparation work was quarantined; cleanup remains pending and will be reported if it fails.'
          : '';
      if (preparation.reason === 'aborted') {
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
          errorMessage: `Command was aborted during Windows Job controller preparation.${cleanupSuffix}`
        };
      }
      const timedOut = preparation.reason === 'timeout';
      return {
        command,
        displayCommand,
        status: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut,
        processTreeSettled: false,
        processSpawned: false,
        errorCode: timedOut ? 'SUPERVISOR_TIMEOUT' : 'CONTROLLER_LAUNCH_FAILED',
        errorMessage: timedOut
          ? `Supervisor timeout: Windows Job Object controller exceeded ${controllerStartupTimeoutMs}ms during startup without reporting settlement (controller=not-reported, admission=not-reported, connected=false, authenticated=false, state=${session.getState()}).${cleanupSuffix}`
          : `Failed to prepare the verified Windows Job interop assembly before target execution.${cleanupSuffix}`
      };
    }
    interopReservation = preparation.reservation;
    interopAssemblyPath = preparation.assemblyPath;
    interopCleanup = preparation.cleanup;
    controllerStartupBudgetMs = preparation.remainingStartupMs;
    if (options.signal?.aborted) {
      if (interopReservation.kind === 'producer') {
        interopReservation.fail(new Error('Windows Job interop preparation was aborted before controller launch.'));
      }
      const cleaned = await interopCleanup();
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
        errorMessage: cleaned
          ? 'Command was aborted before Windows Job controller launch.'
          : 'Command was aborted before Windows Job controller launch. Failed to clean up temporary Windows Job interop preparation files.'
      };
    }
  }

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
    let interopPublished = interopReservation?.kind !== 'producer';
    let interopCleanupFailed = false;
    const interopCaptureAbort = new AbortController();

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
      interopCaptureAbort.abort();
      if (interopReservation?.kind === 'producer' && !interopPublished) {
        interopReservation.fail(new Error('Windows Job interop producer stopped before authenticated readiness.'));
      }

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
      if (interopCleanup) {
        interopCleanupFailed = !(await interopCleanup());
        interopCleanup = null;
        interopAssemblyPath = null;
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
      const cleanupFailed = !stdoutCleaned || !stderrCleaned || interopCleanupFailed;

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
        ? `${result.errorMessage ? `${result.errorMessage} ` : ''}Failed to clean up temporary execution files.`
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

    function armSupervisor(budgetMs: number, phase: 'startup' | 'execution') {
      if (settled || !(timeoutMs > 0 && Number.isFinite(timeoutMs))) return;
      if (supervisorTimer) clearTimeout(supervisorTimer);
      supervisorTimer = setTimeout(() => {
        const controllerStage = [...psStderr.matchAll(/^LIFTOFF_CONTROLLER_STAGE: (loading-compiler|compiling|loading-interop|connecting|connected|ready-serialize|ready-encode|ready-write|ready-flush|ready-written)\r?$/gmu)].at(-1)?.[1] ?? 'not-reported';
        const controllerAdmissionCandidate = [...psStderr.matchAll(/^LIFTOFF_CONTROLLER_ADMISSION: ([^\r\n]*)\r?$/gmu)].at(-1)?.[1];
        const controllerAdmissionStage = controllerAdmissionStages.find(stage => stage === controllerAdmissionCandidate) ?? 'not-reported';
        const reportedBudgetMs = phase === 'startup' ? controllerStartupTimeoutMs : budgetMs;
        void finish({
          timedOut: true,
          processTreeSettled: false,
          processSpawned: spawnRequestDispatched,
          errorCode: 'SUPERVISOR_TIMEOUT',
          errorMessage: `Supervisor timeout: Windows Job Object controller exceeded ${reportedBudgetMs}ms during ${phase} without reporting settlement (controller=${controllerStage}, admission=${controllerAdmissionStage}, connected=${connected}, authenticated=${authenticated}, state=${session.getState()}).`
        });
      }, budgetMs);
    }
    armSupervisor(controllerStartupBudgetMs, 'startup');

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
            void handleIncomingMessage(msg);
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

    async function handleIncomingMessage(raw: unknown) {
      if (settled) return;
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

        if (interopReservation?.kind === 'producer' && !interopPublished) {
          try {
            if (!interopAssemblyPath) throw new Error('Missing private interop assembly path.');
            const bytes = await captureWindowsJobInteropAssembly(
              interopAssemblyPath,
              interopCaptureAbort.signal
            );
            if (settled || interopCaptureAbort.signal.aborted) return;
            interopReservation.publish(bytes);
            interopPublished = true;
          } catch {
            if (settled) return;
            void finish({
              processTreeSettled: false,
              processSpawned: false,
              errorCode: 'CONTROLLER_LAUNCH_FAILED',
              errorMessage: 'Windows Job controller did not produce the expected bounded interop assembly.'
            });
            return;
          }
        }

        if (settled) return;
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
          // PowerShell/C# startup must not consume the target's runtime or settlement budget.
          armSupervisor(timeoutMs + controllerSettlementGraceMs, 'execution');
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
        invocationId,
        ...(interopAssemblyPath ? ['-InteropAssemblyPath', interopAssemblyPath] : [])
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
