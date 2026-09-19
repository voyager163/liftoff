import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { windowsWorkingDirectoryFits } from '../../domain/execution/windows-working-directory.js';
import { resolvePackageFile } from '../packaged-assets/package-root.js';
import { readBoundedPackagedFile } from '../packaged-assets/resource-file.js';
import { buildWindowsControllerHostEnvironment } from '../process/windows-job-runner.js';
import { formatWindowsArgvCommandLine } from '../process/windows-job-protocol.js';
import {
  WindowsPrivateProcessError, WindowsPrivateProtocolSession, windowsPrivateCleanupMs,
  windowsPrivateFrame, windowsPrivateMaximumInputBytes, windowsPrivateMaximumOutputBytes, windowsPrivateMessage,
  type WindowsPrivateFailure
} from './windows-private-protocol.js';

export { WindowsPrivateProcessError };
export const windowsPrivateProcessAssetPath = ['assets', 'repair', 'windows-private-process.ps1'] as const;
export const windowsPrivateProcessAssetDigest = 'c884ce3ac428ddfa29ae193bfdf3f2a9c8560aed45ba495891337ad87b881512';
export const windowsPrivateProcessContract = Object.freeze({
  kind: 'windows-private-job-pipes/1', helperDigest: windowsPrivateProcessAssetDigest,
  minimumWindowsBuild: 17763, powershell: '5.1-full-language-policy-permitted',
  maximumInputBytes: windowsPrivateMaximumInputBytes, maximumOutputBytes: windowsPrivateMaximumOutputBytes,
  cleanupMs: windowsPrivateCleanupMs, encryptedCustody: false, nativeQualification: 'not-established-by-source'
} as const);

export interface WindowsPrivateExecutable { path: string; sha256: string }
export interface WindowsPrivateOwnershipObservation {
  controllerPid: number;
  controllerCreated: string;
  parentPid: number;
  parentCreated: string;
  rootPid: number;
  rootCreated: string;
}
export interface WindowsPrivateProcessRequest {
  /** Exact independently selected executable identity; arguments must contain no private payload. */
  executable: WindowsPrivateExecutable;
  args: readonly string[];
  cwd: string;
  /** Ownership is transferred: this buffer is wiped even if admission fails. */
  stdin?: Uint8Array;
  timeoutMs: number;
  maximumBytes: number;
  signal?: AbortSignal;
  /** Synchronous private observation; borrowed bytes are wiped when the callback returns. */
  observePrivateStdout?(bytes: Uint8Array): void;
  /** Authenticated creation observations only, never settlement or custody qualification. */
  observeOwnership?(ownership: Readonly<WindowsPrivateOwnershipObservation>): void;
}
export interface WindowsPrivateProcessResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  dispose(): void;
}

function requireValue(condition: unknown, code: WindowsPrivateFailure = 'invalid-request'): asserts condition {
  if (!condition) throw new WindowsPrivateProcessError(code);
}

function localPath(filename: string): void {
  requireValue(typeof filename === 'string' && path.isAbsolute(filename) && !/[\u0000-\u001f]/u.test(filename));
  if (process.platform === 'win32') requireValue(/^[a-z]:[\\/]/iu.test(filename) && !filename.slice(2).includes(':'));
}

async function exactFile(filename: string, maximumBytes: number): Promise<string> {
  localPath(filename);
  const resolved = await realpath(filename);
  requireValue(resolved === filename && !(await lstat(filename)).isSymbolicLink(), 'executable-changed');
  const before = await lstat(filename, { bigint: true });
  requireValue(before.isFile() && before.size > 0n && before.size <= BigInt(maximumBytes), 'executable-changed');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const same = (other: typeof before) => other.isFile() && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs', 'nlink']
    .every((key) => other[key as keyof typeof before] === before[key as keyof typeof before]);
  const bytes = Buffer.alloc(64 * 1024);
  try {
    requireValue(same(await handle.stat({ bigint: true })), 'executable-changed');
    const hash = createHash('sha256');
    let total = 0;
    while (total <= Number(before.size)) {
      const { bytesRead } = await handle.read(bytes, 0, Math.min(bytes.length, Number(before.size) + 1 - total), null);
      if (!bytesRead) break;
      total += bytesRead;
      requireValue(total <= Number(before.size), 'executable-changed');
      hash.update(bytes.subarray(0, bytesRead));
    }
    requireValue(total === Number(before.size) && same(await handle.stat({ bigint: true })) &&
      same(await lstat(filename, { bigint: true })) && await realpath(filename) === filename, 'executable-changed');
    return hash.digest('hex');
  } finally { bytes.fill(0); await handle.close(); }
}

/** Observes bytes only. This does not grant executable, credential or storage authority. */
export async function captureWindowsPrivateExecutable(filename: string): Promise<WindowsPrivateExecutable> {
  localPath(filename);
  const resolved = await realpath(filename);
  return { path: resolved, sha256: await exactFile(resolved, 256 * 1024 * 1024) };
}

export async function verifyWindowsPrivateProcessAsset(selectedPath?: string): Promise<string> {
  const file = selectedPath ?? resolvePackageFile(...windowsPrivateProcessAssetPath);
  try {
    const bytes = readBoundedPackagedFile(path.dirname(file), [path.basename(file)], { maximumBytes: 128 * 1024 });
    try {
      requireValue(createHash('sha256').update(bytes).digest('hex') === windowsPrivateProcessAssetDigest, 'helper-unavailable');
    } finally { bytes.fill(0); }
    return file;
  } catch { throw new WindowsPrivateProcessError('helper-unavailable'); }
}

interface Invocation {
  ref: string;
  child: ChildProcessWithoutNullStreams;
  cancel(): void;
  finished: Promise<void>;
  settled: boolean;
}

/** Private binary I/O only; never a storage/custody capability or a public writer fallback. */
export class WindowsPrivateProcessRunner {
  #active?: Invocation;
  #pending?: { done: Promise<void>; finish(): void };
  #generation = 0;
  private readonly powershell: WindowsPrivateExecutable;
  constructor(powershell: WindowsPrivateExecutable) { this.powershell = Object.freeze({ ...powershell }); }

  async quiesce(): Promise<void> {
    this.#generation++;
    const current = this.#active, pending = this.#pending;
    current?.cancel();
    await pending?.done;
    await current?.finished;
    if (this.#active && !this.#active.settled) throw new WindowsPrivateProcessError('settlement-unproven', this.#active.ref);
  }

  async run(request: WindowsPrivateProcessRequest): Promise<WindowsPrivateProcessResult> {
    let input: Buffer | undefined;
    try {
      requireValue(!request.stdin || request.stdin.byteLength <= windowsPrivateMaximumInputBytes);
      input = Buffer.from(request.stdin ?? []);
    } finally { request.stdin?.fill(0); }
    let pending: { done: Promise<void>; finish(): void } | undefined;
    try {
      request = {
        ...request, executable: { ...request.executable },
        args: Array.isArray(request.args) ? Object.freeze([...request.args]) : request.args
      };
      requireValue(process.platform === 'win32', 'unsupported-host');
      requireValue(!this.#active && !this.#pending, 'settlement-unproven');
      requireValue(!request.signal?.aborted, 'cancelled');
      requireValue(Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 && request.timeoutMs <= 300_000 &&
        Number.isSafeInteger(request.maximumBytes) && request.maximumBytes > 0 && request.maximumBytes <= windowsPrivateMaximumOutputBytes &&
        Array.isArray(request.args) && request.args.length <= 256 && request.args.every((arg) => typeof arg === 'string' && !arg.includes('\0')));
      requireValue(formatWindowsArgvCommandLine({ executable: request.executable.path, args: request.args }).length < 32767);
      const generation = this.#generation;
      let finish!: () => void;
      pending = { done: new Promise<void>((resolve) => { finish = resolve; }), finish: () => finish() };
      this.#pending = pending;
      requireValue(path.isAbsolute(request.cwd) && windowsWorkingDirectoryFits(request.cwd), 'working-directory-too-long');
      localPath(request.cwd);
      requireValue(await realpath(request.cwd) === request.cwd && (await lstat(request.cwd)).isDirectory());
      for (const selected of [this.powershell, request.executable]) {
        requireValue(/\.exe$/i.test(selected.path) && /^[a-f0-9]{64}$/.test(selected.sha256));
        requireValue(await exactFile(selected.path, 256 * 1024 * 1024) === selected.sha256, 'executable-changed');
      }
      requireValue(path.basename(this.powershell.path).toLowerCase() === 'powershell.exe', 'unsupported-host');
      const helper = await verifyWindowsPrivateProcessAsset();
      requireValue(!request.signal?.aborted && this.#generation === generation, 'cancelled');
      return await this.#execute(request, input, helper);
    } catch (error) {
      throw error instanceof WindowsPrivateProcessError ? error : new WindowsPrivateProcessError('invalid-request');
    } finally {
      input.fill(0);
      pending?.finish();
      if (this.#pending === pending) this.#pending = undefined;
    }
  }

  #execute(request: WindowsPrivateProcessRequest, input: Buffer, helper: string): Promise<WindowsPrivateProcessResult> {
    const nonce = randomBytes(32).toString('hex');
    const child = spawn(this.powershell.path, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper, '-ParentProcessId', String(process.pid)
    ], { cwd: request.cwd, env: buildWindowsControllerHostEnvironment(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let release!: () => void;
    const invocation: Invocation = {
      ref: `windows-private-process:${randomUUID()}`, child,
      cancel: () => {}, settled: false, finished: new Promise<void>((resolve) => { release = resolve; })
    };
    this.#active = invocation;
    return new Promise((resolve, reject) => {
      let protocol: WindowsPrivateProtocolSession | undefined;
      let failure: WindowsPrivateFailure | undefined;
      let closed = false;
      let controllerExit: number | null | undefined;
      let controllerSignal: NodeJS.Signals | null | undefined;
      let returned = false;
      let dispatched = false;
      let finishTimer: NodeJS.Timeout | undefined;
      let commandTimer: NodeJS.Timeout | undefined;
      let dispatchTimer: NodeJS.Timeout | undefined;
      const queued = new Set<Buffer>();
      const send = (bytes: Buffer): void => {
        queued.add(bytes);
        child.stdin.write(bytes, (error) => {
          bytes.fill(0); queued.delete(bytes);
          if (error) stop('settlement-unproven');
        });
      };
      const complete = (uncertain = false): void => {
        if (returned || !closed && !uncertain) return;
        returned = true;
        clearTimeout(startupTimer); clearTimeout(dispatchTimer); clearTimeout(commandTimer); clearTimeout(finishTimer);
        request.signal?.removeEventListener('abort', abort);
        if (closed) {
          for (const bytes of queued) bytes.fill(0);
          queued.clear();
        }
        input.fill(0);
        const result = protocol?.completion;
        invocation.settled = closed && (!dispatched || result?.settled === true);
        if (invocation.settled) this.#active = undefined;
        release();
        if (!invocation.settled) failure = 'settlement-unproven';
        if (!failure && result?.reason) {
          failure = result.reason === 1 ? 'timeout' : result.reason === 2 ? 'cancelled' :
            result.reason === 4 ? 'output-limit' : 'native-command-failed';
        }
        if (!failure && (controllerExit !== 0 || controllerSignal !== null)) failure = 'native-command-failed';
        if (failure || !result) {
          protocol?.dispose();
          reject(new WindowsPrivateProcessError(failure ?? 'invalid-protocol', invocation.ref, result));
          return;
        }
        try {
          const output = protocol!.takeOutput();
          resolve({ exitCode: result.exitCode, ...output, dispose: () => { output.stdout.fill(0); output.stderr.fill(0); } });
        } catch {
          protocol?.dispose();
          reject(new WindowsPrivateProcessError('invalid-protocol', invocation.ref));
        }
      };
      const enforceClosure = (): void => {
        if (closed || returned) return;
        child.kill();
        complete(true);
      };
      const stop = (code: WindowsPrivateFailure): void => {
        failure ??= code;
        protocol?.discardOutput();
        if (closed || returned || finishTimer) return;
        if (protocol?.ready && child.stdin.writable) send(windowsPrivateMessage(4, { nonce }));
        // Only the retained controller is terminated; its exit alone never proves job settlement.
        finishTimer = setTimeout(enforceClosure, windowsPrivateCleanupMs);
      };
      const abort = (): void => stop('cancelled');
      invocation.cancel = abort;
      const startupTimer = setTimeout(() => stop('timeout'), 15_000);
      request.signal?.addEventListener('abort', abort, { once: true });
      child.once('spawn', () => {
        try {
          requireValue(child.pid !== undefined, 'helper-unavailable');
          protocol = new WindowsPrivateProtocolSession(nonce, child.pid, process.pid, request.maximumBytes, request.observePrivateStdout);
          if (request.signal?.aborted) { abort(); return; }
          send(windowsPrivateMessage(1, { schemaVersion: 1, nonce }));
        } catch { stop('helper-unavailable'); }
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (returned) { chunk.fill(0); return; }
        try {
          requireValue(protocol, 'invalid-protocol');
          protocol.feed(chunk, (event) => {
            if (event === 'ready') {
              clearTimeout(startupTimer);
              void verifyWindowsPrivateProcessAsset().then(() => {
                if (closed || returned || failure) return;
                dispatched = true;
                send(windowsPrivateMessage(2, {
                  nonce, ...protocol!.ready, executable: request.executable.path, executableSha256: request.executable.sha256,
                  args: request.args, cwd: request.cwd, timeoutMs: request.timeoutMs, maximumBytes: request.maximumBytes
                }));
                send(windowsPrivateFrame(3, input));
                input.fill(0);
                dispatchTimer = setTimeout(() => stop('timeout'), Math.min(request.timeoutMs, 15_000));
              }, () => stop('helper-unavailable'));
            } else if (event === 'assigned') {
              clearTimeout(dispatchTimer);
              if (!failure) {
                request.observeOwnership?.(Object.freeze({
                  controllerPid: child.pid!, ...protocol!.ready!, parentPid: process.pid,
                  rootPid: protocol!.assigned!.pid, rootCreated: protocol!.assigned!.created
                }));
                if (!failure) {
                  send(windowsPrivateMessage(5, { nonce, ...protocol!.assigned }));
                  commandTimer = setTimeout(() => stop('timeout'), request.timeoutMs);
                }
              }
            } else {
              clearTimeout(dispatchTimer); clearTimeout(commandTimer);
              child.stdin.end();
              finishTimer ??= setTimeout(enforceClosure, windowsPrivateCleanupMs);
            }
          });
        } catch (error) {
          chunk.fill(0);
          stop(error instanceof WindowsPrivateProcessError ? error.code : 'invalid-protocol');
        }
      });
      child.stderr.on('data', (chunk: Buffer) => { chunk.fill(0); stop('helper-unavailable'); });
      child.stdin.on('error', () => stop('settlement-unproven'));
      child.once('error', () => stop('helper-unavailable'));
      child.once('close', (code, signal) => {
        if (closed) return;
        closed = true;
        controllerExit = code; controllerSignal = signal;
        if (returned && !dispatched) {
          invocation.settled = true;
          if (this.#active === invocation) this.#active = undefined;
        }
        complete();
      });
    });
  }
}
