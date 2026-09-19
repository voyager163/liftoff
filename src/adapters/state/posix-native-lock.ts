import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import {
  StateMigrationError, stateFailureCodes,
  type NativeLocalStateLockProvider, type StateFailureCode, type StateRegisteredExecutable
} from '../../domain/repair/stateful.js';
import { stateAssert } from '../../domain/repair/stateful-invariants.js';
import { startPrivateStateProcess, nativeLocalStateProtocol } from './native-system.js';
import { linuxPosixStateLockProgram, posixStateLockProgram } from './posix-lock-program.js';
import { stopOwnedStateProcess } from './owned-process.js';

interface Reply { ok: boolean; code?: StateFailureCode; version?: string; digest?: string }

class PrivateLockSession {
  #closed = false;
  #buffer = '';
  #pending: { resolve: (value: Reply) => void; reject: (error: Error) => void } | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly timeoutMs: number) {
    child.stdout.on('data', (data: Buffer) => {
      this.#buffer += data.toString('utf8');
      if (this.#buffer.length > 8192) { this.fail('storage-limit'); return; }
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const pending = this.#pending;
      this.#pending = null;
      if (this.#timer) clearTimeout(this.#timer);
      try {
        const reply = JSON.parse(line) as Reply;
        if (!pending || typeof reply.ok !== 'boolean') { this.fail('operation-failed'); return; }
        if (!reply.ok) {
          const code = reply.code && stateFailureCodes.includes(reply.code) ? reply.code : 'operation-failed';
          this.#closed = true;
          pending.reject(new StateMigrationError(code));
        } else pending.resolve(reply);
      } catch { pending?.reject(new StateMigrationError('operation-failed')); this.fail('operation-failed'); }
    });
    child.stderr.on('data', (data: Buffer) => { if (data.length) this.fail('operation-failed'); });
    child.stdin.on('error', () => this.fail('lock-lost'));
    child.once('error', () => this.fail('tool-unavailable'));
    child.once('close', () => this.fail('lock-lost'));
  }
  private fail(code: StateFailureCode): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#pending?.reject(new StateMigrationError(code));
    this.#pending = null;
    this.child.stdin.end();
    this.child.kill('SIGTERM');
  }
  send(command: object): Promise<Reply> {
    const work = this.#queue.then(() => new Promise<Reply>((resolve, reject) => {
      if (this.#closed) { reject(new StateMigrationError('lock-lost')); return; }
      this.#pending = { resolve, reject };
      this.#timer = setTimeout(() => this.fail('timeout'), this.timeoutMs);
      this.#timer.unref();
      this.child.stdin.write(`${JSON.stringify(command)}\n`, (error) => { if (error) this.fail('lock-lost'); });
    }));
    this.#queue = work.catch(() => undefined);
    return work;
  }
  cancel(): void { this.fail('cancelled'); }
  async release(): Promise<void> {
    try { if (!this.#closed) await this.send({ action: 'release' }); }
    finally {
      this.#closed = true;
      this.child.stdin.end();
      if (this.#timer) clearTimeout(this.#timer);
      await stopOwnedStateProcess(this.child, { immediate: false });
    }
  }
}

interface PosixStateLockOptions {
  python: StateRegisteredExecutable;
  timeoutMs?: number;
}

class PosixStateLockProvider implements NativeLocalStateLockProvider {
  readonly capabilities = Object.freeze({
    protocol: nativeLocalStateProtocol.version, existingInPlace: true as const, createAbsent: false as const, remove: false as const
  });
  constructor(
    private readonly options: PosixStateLockOptions,
    private readonly platform: 'darwin' | 'linux',
    private readonly program: string
  ) {}

  async acquire(request: Parameters<NativeLocalStateLockProvider['acquire']>[0]): ReturnType<NativeLocalStateLockProvider['acquire']> {
    stateAssert(process.platform === this.platform, 'unsupported-native-platform');
    if (this.platform === 'linux') stateAssert(process.arch === 'x64' || process.arch === 'arm64', 'unqualified-combination');
    stateAssert((this.options.timeoutMs ?? 15_000) > 0 && (this.options.timeoutMs ?? 15_000) <= 120_000, 'invalid-binding');
    stateAssert(request.expectedVersion !== null, 'unsupported-local-state-operation');
    stateAssert(/^[a-f0-9]{64}$/.test(request.expectedVersion) && /^[a-f0-9-]{36}$/.test(request.operationId), 'invalid-binding');
    stateAssert(!request.signal?.aborted, 'cancelled');
    const child = await startPrivateStateProcess(this.options.python,
      ['-I', '-S', '-B', '-u', '-c', this.program], path.dirname(request.path), undefined, 'lease');
    const session = new PrivateLockSession(child, this.options.timeoutMs ?? 15_000);
    const abort = (): void => session.cancel();
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    try {
      await session.send({
        path: request.path, operationId: request.operationId, expectedVersion: request.expectedVersion, holdSeconds: 1800
      });
    } catch (error) {
      request.signal?.removeEventListener('abort', abort);
      session.cancel();
      await session.release();
      throw error;
    }

    // Cancellation of the native operation is not release authority. The
    // coordinator releases this lease only after native descendants stop.
    request.signal?.removeEventListener('abort', abort);
    return {
      assertHeld: async () => { await session.send({ action: 'assert' }); },
      replace: async (bytes, expectedVersion) => {
        stateAssert(expectedVersion !== null && bytes.byteLength <= 32 * 1024 * 1024, 'unsupported-local-state-operation');
        await session.send({ action: 'replace', expectedVersion, bytes: Buffer.from(bytes).toString('base64') });
      },
      remove: async () => { throw new StateMigrationError('unsupported-local-state-operation'); },
      release: async () => {
        request.signal?.removeEventListener('abort', abort);
        await session.release();
      }
    };
  }
}

export class DarwinPosixStateLockProvider extends PosixStateLockProvider {
  constructor(options: PosixStateLockOptions) {
    super(options, 'darwin', posixStateLockProgram);
  }
}

export class LinuxPosixStateLockProvider extends PosixStateLockProvider {
  constructor(options: PosixStateLockOptions) {
    super(options, 'linux', linuxPosixStateLockProgram);
  }
}
