import spawn from 'cross-spawn';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { StateMigrationError, type StateFailureCode } from '../../domain/repair/stateful.js';
import { stateAssert } from '../../domain/repair/stateful-invariants.js';

interface OwnedGroup {
  ref: string;
  child: ChildProcessWithoutNullStreams;
  cwd: string;
  ready: Promise<void>;
  rootExited: boolean;
  streamsClosed: boolean;
  exitCode: number | null;
  spawnFailed: boolean;
  groupGone: boolean;
  role: 'command' | 'lease';
  terminating: Promise<{ forced: boolean }> | null;
}

const owned = new Map<ChildProcessWithoutNullStreams, OwnedGroup>();
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class StateProcessTerminationError extends StateMigrationError {
  constructor(readonly processRef: string) { super('process-tree-termination-unproven'); }
}

function groupAbsent(group: OwnedGroup): boolean {
  if (group.groupGone) return true;
  if (group.spawnFailed && group.child.pid === undefined) return true;
  if (group.child.pid === undefined) return false;
  try { process.kill(-group.child.pid, 0); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    group.groupGone = true;
    return true;
  }
}

function stopped(group: OwnedGroup): boolean {
  return groupAbsent(group) && (group.streamsClosed || group.spawnFailed);
}

function signalGroup(group: OwnedGroup, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (group.child.pid === undefined || group.groupGone) return;
  try { process.kill(-group.child.pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new StateProcessTerminationError(group.ref);
  }
}

async function waitStopped(group: OwnedGroup, duration: number): Promise<boolean> {
  const end = Date.now() + duration;
  do {
    if (stopped(group)) return true;
    await delay(20);
  } while (Date.now() < end);
  return stopped(group);
}

async function proveTermination(group: OwnedGroup, immediate: boolean, cleanupMs: number): Promise<{ forced: boolean }> {
  await group.ready;
  if (!immediate && await waitStopped(group, 100)) {
    owned.delete(group.child);
    return { forced: false };
  }
  let signalled = false;
  try { signalGroup(group, 'SIGTERM'); signalled = true; }
  catch { /* The final proof, not signal delivery, determines success. */ }
  if (await waitStopped(group, Math.min(200, cleanupMs))) {
    owned.delete(group.child);
    return { forced: signalled };
  }
  try { signalGroup(group, 'SIGKILL'); } catch { /* Retain the group if proof fails. */ }
  if (await waitStopped(group, cleanupMs)) {
    owned.delete(group.child);
    return { forced: true };
  }
  // Keep ownership and pipe observers alive for an explicit later quiescence
  // attempt. Closing inherited pipes here would manufacture a false proof.
  throw new StateProcessTerminationError(group.ref);
}

export function spawnOwnedStateProcess(request: {
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  role?: 'command' | 'lease';
}): ChildProcessWithoutNullStreams {
  stateAssert(process.platform === 'darwin' || process.platform === 'linux', 'unsupported-native-platform');
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  // As in process-runner.ts, setsid owns the inherited process group. Pipes and
  // the child remain referenced: this is not an unref'ed/background daemon.
  const child = spawn(request.executable, [...request.args], {
    cwd: request.cwd, env: { ...request.environment }, shell: false,
    detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  }) as ChildProcessWithoutNullStreams;
  const group: OwnedGroup = {
    ref: `state-process:${randomUUID()}`, child, cwd: path.resolve(request.cwd), ready: started,
    rootExited: false, streamsClosed: false, exitCode: null, spawnFailed: false, groupGone: false,
    role: request.role ?? 'command', terminating: null
  };
  owned.set(child, group);
  child.once('spawn', ready);
  child.once('error', () => { group.spawnFailed = true; group.rootExited = true; ready(); });
  child.once('exit', (code) => { group.rootExited = true; group.exitCode = code; });
  child.once('close', () => { group.streamsClosed = true; });
  return child;
}

export async function stopOwnedStateProcess(
  child: ChildProcessWithoutNullStreams, options: { immediate?: boolean; cleanupMs?: number } = {}
): Promise<{ forced: boolean }> {
  const group = owned.get(child);
  if (!group) return { forced: false };
  const cleanupMs = options.cleanupMs ?? 2_000;
  stateAssert(Number.isSafeInteger(cleanupMs) && cleanupMs >= 50 && cleanupMs <= 10_000, 'invalid-binding');
  if (group.terminating) return group.terminating;
  group.terminating = proveTermination(group, options.immediate ?? true, cleanupMs);
  try { return await group.terminating; } finally { group.terminating = null; }
}

export async function stopOwnedStateProcessesIn(directory: string, cleanupMs = 2_000): Promise<void> {
  const root = path.resolve(directory);
  const groups = [...owned.values()].filter((group) => {
    if (group.role !== 'command') return false;
    const relative = path.relative(root, group.cwd);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  });
  const results = await Promise.allSettled(groups.map((group) => stopOwnedStateProcess(group.child, { cleanupMs })));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

export async function cleanupOwnedStateScratch(directory: string, cleanup: () => Promise<void>): Promise<void> {
  await stopOwnedStateProcessesIn(directory);
  await cleanup();
}

export async function terminateRegisteredStateProcess(pid: number): Promise<void> {
  const group = [...owned.values()].find((entry) => entry.child.pid === pid);
  stateAssert(group, 'process-tree-termination-unproven');
  await stopOwnedStateProcess(group.child);
}

export class OwnedPrivateStateProcessRunner {
  #children = new Set<ChildProcessWithoutNullStreams>();
  #generation = 0;
  constructor(private readonly cleanupMs = 2_000) {}

  async quiesce(): Promise<void> {
    this.#generation++;
    const results = await Promise.allSettled([...this.#children].map(async (child) => {
      await stopOwnedStateProcess(child, { cleanupMs: this.cleanupMs });
      this.#children.delete(child);
    }));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  async run(request: {
    executable: string;
    args: readonly string[];
    cwd: string;
    environment: NodeJS.ProcessEnv;
    stdin?: Uint8Array;
    timeoutMs: number;
    maximumBytes: number;
    signal?: AbortSignal;
    captureStderr?: boolean;
    /** Private adapter only: synchronous bounded observation, never a public log callback. */
    observePrivateStdout?(bytes: Uint8Array): void;
  }): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }> {
    stateAssert(Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 && request.timeoutMs <= 300_000
      && Number.isSafeInteger(request.maximumBytes) && request.maximumBytes > 0, 'invalid-binding');
    stateAssert(!request.signal?.aborted, 'cancelled');
    if (this.#children.size) {
      throw new StateProcessTerminationError(owned.get([...this.#children][0])?.ref ?? 'state-process:unproven');
    }
    const generation = this.#generation;
    const child = spawnOwnedStateProcess(request);
    this.#children.add(child);
    return new Promise((resolve, reject) => {
      const stdout: Uint8Array[] = [];
      const stderr: Uint8Array[] = [];
      const input = request.stdin ? Buffer.from(request.stdin) : undefined;
      let bytes = 0;
      let failure: StateFailureCode | null = null;
      let exitCode: number | null = null;
      let finishing = false;
      let discarded = false;
      const discard = (): void => {
        discarded = true;
        for (const buffer of [...stdout, ...stderr]) buffer.fill(0);
        stdout.length = 0; stderr.length = 0;
        input?.fill(0);
      };
      const finish = async (immediate: boolean): Promise<void> => {
        if (finishing) return;
        finishing = true;
        try {
          const termination = await stopOwnedStateProcess(child, { immediate, cleanupMs: this.cleanupMs });
          this.#children.delete(child);
          if (!failure && termination.forced) failure = 'native-command-failed';
          if (failure) {
            discard();
            reject(new StateMigrationError(failure));
          } else {
            const result = { exitCode: exitCode ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
            discard();
            resolve(result);
          }
        } catch (error) {
          discard();
          reject(error instanceof StateProcessTerminationError ? error : new StateProcessTerminationError(`state-process:unproven`));
        } finally {
          clearTimeout(timer);
          request.signal?.removeEventListener('abort', abort);
        }
      };
      const stop = (code: StateFailureCode): void => {
        failure ??= code;
        discard();
        void finish(true);
      };
      const abort = (): void => stop('cancelled');
      const timer = setTimeout(() => stop('timeout'), request.timeoutMs);
      const collect = (buffers: Uint8Array[], chunk: Buffer, keep: boolean, observe = false): void => {
        bytes += chunk.length;
        if (discarded || failure || finishing && !owned.has(child)) { chunk.fill(0); return; }
        if (bytes > request.maximumBytes) { chunk.fill(0); stop('storage-limit'); return; }
        if (observe && request.observePrivateStdout) {
          const copy = Buffer.from(chunk);
          try { request.observePrivateStdout(copy); }
          catch { chunk.fill(0); stop('operation-failed'); return; }
          finally { copy.fill(0); }
        }
        if (keep) buffers.push(chunk);
        else chunk.fill(0);
      };
      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk, true, true));
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk, request.captureStderr !== false));
      child.once('error', () => stop('native-command-failed'));
      child.once('exit', (code) => { exitCode = code; void finish(false); });
      child.stdin.on('error', () => stop('native-command-failed'));
      request.signal?.addEventListener('abort', abort, { once: true });
      if (request.signal?.aborted || generation !== this.#generation) abort();
      if (!failure) child.stdin.end(input, () => input?.fill(0));
    });
  }
}
