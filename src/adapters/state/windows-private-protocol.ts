export const windowsPrivateMaximumInputBytes = 1024 * 1024;
export const windowsPrivateMaximumOutputBytes = 2 * 1024 * 1024;
export const windowsPrivateCleanupMs = 2_000;

export type WindowsPrivateFailure =
  | 'unsupported-host' | 'helper-unavailable' | 'executable-changed' | 'invalid-request'
  | 'working-directory-too-long' | 'authentication-failed' | 'invalid-protocol'
  | 'cancelled' | 'timeout' | 'output-limit' | 'native-command-failed' | 'settlement-unproven';

export class WindowsPrivateProcessError extends Error {
  constructor(readonly code: WindowsPrivateFailure, readonly processRef?: string) {
    super(`Windows private process refused: ${code}.`);
    this.name = 'WindowsPrivateProcessError';
  }
}

function requireValue(value: unknown, code: WindowsPrivateFailure = 'invalid-protocol'): asserts value {
  if (!value) throw new WindowsPrivateProcessError(code);
}

export function windowsPrivateFrame(type: number, bytes: Uint8Array): Buffer {
  requireValue(Number.isInteger(type) && type > 0 && type < 256 && bytes.length <= windowsPrivateMaximumInputBytes);
  const frame = Buffer.alloc(5 + bytes.length);
  frame[0] = type;
  frame.writeUInt32BE(bytes.length, 1);
  frame.set(bytes, 5);
  return frame;
}

export function windowsPrivateMessage(type: number, value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  try { return windowsPrivateFrame(type, bytes); } finally { bytes.fill(0); }
}

function metadata(bytes: Uint8Array): Record<string, unknown> {
  requireValue(bytes.length <= 8192);
  let result: unknown;
  try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new WindowsPrivateProcessError('invalid-protocol'); }
  requireValue(result !== null && typeof result === 'object' && !Array.isArray(result));
  return result as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  requireValue(Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field)));
}

function identity(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 0xffff_ffff;
}

function creation(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
}

export interface WindowsPrivateReady {
  controllerCreated: string;
  parentCreated: string;
}
export interface WindowsPrivateAssigned {
  pid: number;
  created: string;
}
export interface WindowsPrivateCompletion {
  settled: boolean;
  processSpawned: boolean;
  exitCode: number;
  reason: number;
}

/** A byte parser/state machine, not native execution or custody evidence by itself. */
export class WindowsPrivateProtocolSession {
  #pending = Buffer.alloc(0);
  #stdout: Buffer[] = [];
  #stderr: Buffer[] = [];
  #bytes = 0;
  #discard = false;
  #phase: 'ready' | 'assigned' | 'running' | 'finished' = 'ready';
  #controllerCreated = '';
  ready?: WindowsPrivateReady;
  assigned?: WindowsPrivateAssigned;
  completion?: WindowsPrivateCompletion;

  constructor(
    readonly nonce: string, readonly controllerPid: number, readonly parentPid: number, readonly maximumBytes: number,
    private readonly observePrivateStdout?: (bytes: Uint8Array) => void
  ) {
    requireValue(/^[a-f0-9]{64}$/.test(nonce) && identity(controllerPid) && identity(parentPid) &&
      controllerPid !== parentPid && Number.isSafeInteger(maximumBytes) && maximumBytes > 0 &&
      maximumBytes <= windowsPrivateMaximumOutputBytes, 'invalid-request');
  }

  feed(chunk: Buffer, onEvent: (event: 'ready' | 'assigned' | 'finished') => void): void {
    if (chunk.length > windowsPrivateMaximumOutputBytes + 8192) {
      chunk.fill(0); this.dispose();
      throw new WindowsPrivateProcessError('invalid-protocol');
    }
    const previous = this.#pending;
    this.#pending = Buffer.concat([previous, chunk]);
    previous.fill(0); chunk.fill(0);
    try {
      while (this.#pending.length >= 5) {
        const type = this.#pending[0]!;
        const size = this.#pending.readUInt32BE(1);
        requireValue(size <= 16384);
        if (this.#pending.length < size + 5) return;
        const body = this.#pending.subarray(5, size + 5);
        const event = this.#accept(type, body);
        const remaining = Buffer.from(this.#pending.subarray(size + 5));
        this.#pending.fill(0);
        this.#pending = remaining;
        if (event) onEvent(event);
      }
    } catch (error) { this.dispose(); throw error; }
  }

  #accept(type: number, bytes: Uint8Array): 'ready' | 'assigned' | 'finished' | undefined {
    requireValue(this.#phase !== 'finished');
    if (type === 13 || type === 14) {
      requireValue(this.#phase === 'running');
      if (this.#discard) return;
      this.#bytes += bytes.length;
      requireValue(this.#bytes <= this.maximumBytes, 'output-limit');
      (type === 13 ? this.#stdout : this.#stderr).push(Buffer.from(bytes));
      if (type === 13 && this.observePrivateStdout) {
        const borrowed = Uint8Array.from(bytes);
        try { this.observePrivateStdout(borrowed); } finally { borrowed.fill(0); }
      }
      return;
    }
    const value = metadata(bytes);
    requireValue(value.nonce === this.nonce, 'authentication-failed');
    if (type === 11) {
      exact(value, ['schemaVersion', 'nonce', 'controllerPid', 'controllerCreated', 'parentPid', 'parentCreated']);
      requireValue(this.#phase === 'ready' && value.schemaVersion === 1 && value.controllerPid === this.controllerPid &&
        value.parentPid === this.parentPid && creation(value.controllerCreated) && creation(value.parentCreated) &&
        BigInt(value.parentCreated) <= BigInt(value.controllerCreated), 'authentication-failed');
      this.#controllerCreated = value.controllerCreated;
      this.ready = { controllerCreated: value.controllerCreated, parentCreated: value.parentCreated };
      this.#phase = 'assigned';
      return 'ready';
    }
    if (type === 12) {
      exact(value, ['nonce', 'pid', 'created', 'assignedBeforeExecution']);
      requireValue(this.#phase === 'assigned' && value.assignedBeforeExecution === true && identity(value.pid) &&
        value.pid !== this.controllerPid && value.pid !== this.parentPid && creation(value.created) &&
        BigInt(value.created) >= BigInt(this.#controllerCreated), 'authentication-failed');
      this.assigned = { pid: value.pid, created: value.created };
      this.#phase = 'running';
      return 'assigned';
    }
    requireValue(type === 15 && this.#phase !== 'ready');
    exact(value, ['nonce', 'settled', 'activeProcesses', 'rootExited', 'processSpawned', 'exitCode', 'reason', 'inputDisposed']);
    requireValue(typeof value.settled === 'boolean' && typeof value.processSpawned === 'boolean' &&
      typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 0xffff_ffff &&
      typeof value.rootExited === 'boolean' && typeof value.inputDisposed === 'boolean' &&
      Number.isSafeInteger(value.activeProcesses) && Number(value.activeProcesses) >= 0 &&
      Number.isSafeInteger(value.reason) && Number(value.reason) >= 0 && Number(value.reason) <= 7);
    requireValue(value.processSpawned === Boolean(this.assigned) && (value.processSpawned || value.reason !== 0));
    const settled = value.settled === true && value.activeProcesses === 0 && value.rootExited === true && value.inputDisposed === true;
    this.completion = { settled, processSpawned: value.processSpawned, exitCode: Number(value.exitCode), reason: Number(value.reason) };
    this.#phase = 'finished';
    return 'finished';
  }

  takeOutput(): { stdout: Uint8Array; stderr: Uint8Array } {
    requireValue(!this.#discard && this.completion?.settled && this.completion.reason === 0 && this.#pending.length === 0);
    const output = { stdout: Buffer.concat(this.#stdout), stderr: Buffer.concat(this.#stderr) };
    this.dispose();
    return output;
  }

  dispose(): void {
    this.#pending.fill(0);
    this.discardOutput();
    this.#pending = Buffer.alloc(0);
  }

  discardOutput(): void {
    this.#discard = true;
    for (const bytes of [...this.#stdout, ...this.#stderr]) bytes.fill(0);
    this.#stdout.length = 0; this.#stderr.length = 0;
  }
}
