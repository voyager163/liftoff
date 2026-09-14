import { createHash } from 'node:crypto';
import type { ExternalCommand } from '../../domain/project/contracts.js';

export const windowsJobProtocolVersion = 1 as const;
export const defaultWindowsJobControllerId = 'liftoff-windows-job-controller-v1' as const;
export const maximumEnvironmentBlockBytes = 64 * 1024;
export const maximumControlMessageBytes = 256 * 1024;
export const maximumWindowsCommandLineLength = 32_767;
export const maximumWindowsCommandLineStringLength = maximumWindowsCommandLineLength - 1;

const hex64Regex = /^[a-f0-9]{64}$/u;

export class WindowsJobAdmissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowsJobAdmissionDeniedError';
  }
}

/**
 * Standard Win32 CommandLineToArgvW argument escaping for CreateProcessW.
 * Does not emit cmd.exe shell escaping (^, %, &); produces literal argument bytes.
 * Rejects embedded NUL characters.
 */
export function quoteWindowsArgvArgument(arg: string): string {
  if (typeof arg !== 'string') {
    throw new TypeError('Command-line argument must be a string.');
  }
  if (arg.includes('\0')) {
    throw new Error('Command-line argument contains an invalid null character.');
  }
  if (arg.length === 0) return '""';
  if (!/[\s"\t\n\v]/.test(arg)) return arg;

  let result = '"';
  let backslashes = 0;

  for (let i = 0; i < arg.length; i++) {
    const char = arg[i];
    if (char === '\\') {
      backslashes++;
    } else if (char === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      if (backslashes > 0) {
        result += '\\'.repeat(backslashes);
        backslashes = 0;
      }
      result += char;
    }
  }

  if (backslashes > 0) {
    result += '\\'.repeat(backslashes * 2);
  }
  result += '"';
  return result;
}

/**
 * Formats an ExternalCommand into a literal Win32 command line suitable for CreateProcessW.
 * Rejects embedded NUL characters and enforces the 32,767 character Win32 command line limit.
 */
export function formatWindowsArgvCommandLine(command: { executable: string; args: readonly string[] }): string {
  if (typeof command.executable !== 'string' || command.executable.includes('\0')) {
    throw new Error('Executable path must be a string without null characters.');
  }
  const parts = [command.executable, ...command.args];
  const commandLine = parts.map(quoteWindowsArgvArgument).join(' ');
  if (commandLine.length > maximumWindowsCommandLineStringLength) {
    throw new Error(
      `Formatted Windows command line length including null terminator (${commandLine.length + 1}) exceeds Win32 limit of ${maximumWindowsCommandLineLength} characters.`
    );
  }
  return commandLine;
}

/**
 * Encodes an environment dictionary into a canonical UTF-16LE Win32 environment block:
 * null-separated sorted KEY=VALUE strings, terminated by a double null character.
 * Rejects duplicate case-insensitive keys, empty keys, '=' in keys, embedded NULs,
 * and sorts entries ordinally case-insensitively.
 */
export function encodeWindowsEnvironmentBlock(env: NodeJS.ProcessEnv): Buffer {
  const entries: string[] = [];
  const seenKeys = new Set<string>();

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.length === 0) {
      throw new Error('Environment key cannot be empty.');
    }
    if (key.includes('\0') || value.includes('\0')) {
      throw new Error('Environment key or value contains an invalid null character.');
    }
    if (key.includes('=')) {
      throw new Error(`Environment key contains an invalid '=' character: ${key}`);
    }

    const upperKey = key.toUpperCase();
    if (seenKeys.has(upperKey)) {
      throw new Error(`Duplicate case-insensitive environment key detected: ${key}`);
    }
    seenKeys.add(upperKey);
    entries.push(`${key}=${value}`);
  }

  // Windows requires deterministic ordinal sorting by variable name (case-insensitive).
  entries.sort((a, b) => {
    const keyA = a.slice(0, a.indexOf('=')).toUpperCase();
    const keyB = b.slice(0, b.indexOf('=')).toUpperCase();
    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
    return 0;
  });

  const rawString = entries.length ? `${entries.join('\0')}\0\0` : '\0\0';
  const buffer = Buffer.from(rawString, 'utf16le');
  if (buffer.byteLength > maximumEnvironmentBlockBytes) {
    throw new Error(`Encoded Windows environment block exceeds maximum size (${maximumEnvironmentBlockBytes} bytes).`);
  }
  return buffer;
}

/**
 * Decodes a UTF-16LE Win32 environment block into a null-prototype dictionary.
 * Strictly verifies even byte length, double-null termination, and valid KEY=VALUE structure.
 * Preserves '__proto__' as an own property without prototype pollution.
 */
export function decodeWindowsEnvironmentBlock(buffer: Buffer): Record<string, string> {
  if (buffer.byteLength > maximumEnvironmentBlockBytes) {
    throw new Error(`Raw Windows environment block size (${buffer.byteLength} bytes) exceeds maximum bound of ${maximumEnvironmentBlockBytes} bytes.`);
  }
  if (buffer.byteLength % 2 !== 0) {
    throw new Error('Windows environment block buffer length must be even (UTF-16LE).');
  }
  if (buffer.byteLength < 4) {
    throw new Error('Windows environment block must be at least 4 bytes for double null termination.');
  }

  // Verify double null termination: last two UTF-16 code units must be 0
  const lastCodeUnit = buffer.readUInt16LE(buffer.byteLength - 2);
  const secondLastCodeUnit = buffer.readUInt16LE(buffer.byteLength - 4);
  if (lastCodeUnit !== 0 || secondLastCodeUnit !== 0) {
    throw new Error('Windows environment block is not terminated with a double null character.');
  }

  // Decode content up to the double null terminator
  const contentBuffer = buffer.subarray(0, buffer.byteLength - 4);
  const text = contentBuffer.toString('utf16le');

  const result: Record<string, string> = Object.create(null);
  if (text.length === 0) {
    return result;
  }

  const entries = text.split('\0');
  const seenKeys = new Set<string>();
  for (const entry of entries) {
    if (entry.length === 0) {
      throw new Error('Malformed Windows environment block contains consecutive null characters.');
    }
    const equalsIndex = entry.indexOf('=');
    if (equalsIndex <= 0) {
      throw new Error(`Malformed Windows environment block entry without '=' delimiter: "${entry}".`);
    }
    const key = entry.slice(0, equalsIndex);
    const value = entry.slice(equalsIndex + 1);

    const upperKey = key.toUpperCase();
    if (seenKeys.has(upperKey)) {
      throw new Error(`Duplicate case-insensitive environment key detected in decode: ${key}`);
    }
    seenKeys.add(upperKey);
    result[key] = value;
  }
  return result;
}

export type WindowsJobControlKind = 'init' | 'spawn' | 'ack' | 'terminate' | 'poll' | 'response';
export type WindowsJobControlPhase = 'running' | 'completed' | 'terminated' | 'failed';

export interface WindowsJobAdmittedInvocation {
  workspaceId: string;
  controllerId?: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  envDigest: string;
  timeoutMs: number;
  maxOutputBytes: number;
  envBlockBase64?: string;
  stdoutFile?: string;
  stderrFile?: string;
}

export function deriveInvocationDigest(invocation: WindowsJobAdmittedInvocation): string {
  const canonical = {
    workspaceId: invocation.workspaceId,
    controllerId: invocation.controllerId ?? defaultWindowsJobControllerId,
    executable: invocation.executable,
    args: [...invocation.args],
    cwd: invocation.cwd,
    envDigest: invocation.envDigest,
    timeoutMs: invocation.timeoutMs,
    maxOutputBytes: invocation.maxOutputBytes
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface WindowsJobControlSpawnRequest {
  schemaVersion: 1;
  kind: 'spawn';
  controllerId: string;
  workspaceId: string;
  invocationId: string;
  nonce: string;
  sequence: number;
  executable: string;
  commandLine: string;
  cwd: string;
  envDigest: string;
  timeoutMs: number;
  maxOutputBytes: number;
  envBlockBase64?: string;
  stdoutFile?: string;
  stderrFile?: string;
}

export interface WindowsJobControlAck {
  schemaVersion: 1;
  kind: 'ack';
  controllerId: string;
  workspaceId: string;
  invocationId: string;
  nonce: string;
  sequence: number;
  admitted: boolean;
  error?: string;
}

export interface WindowsJobControlExpectedContext {
  nonce: string;
  sequence: number;
  workspaceId: string;
  invocationId: string;
  controllerId?: string;
}

export interface WindowsJobControlReady {
  schemaVersion: 1;
  kind: 'ready';
  controllerId: string;
  workspaceId: string;
  invocationId: string;
  nonce: string;
}

export interface WindowsJobControlResponse {
  schemaVersion: 1;
  kind: 'response';
  controllerId: string;
  workspaceId: string;
  invocationId: string;
  nonce: string;
  sequence: number;
  phase: WindowsJobControlPhase;
  status: number | null;
  signal: string | null;
  activeProcesses: number;
  jobTerminated: boolean;
  settled: boolean;
  outputLimitExceeded?: boolean;
  error?: string;
}

const recognizedResponseKeys = new Set([
  'schemaVersion', 'kind', 'controllerId', 'workspaceId', 'invocationId',
  'nonce', 'sequence', 'phase', 'status', 'signal',
  'activeProcesses', 'jobTerminated', 'settled', 'outputLimitExceeded', 'error'
]);

/**
 * Validates a Windows Job control protocol response against expected cryptographic nonce,
 * sequence number, and bound workspace/invocation scope.
 *
 * NOTE: This validates data structure, binding integrity, and settlement logic. Proof of genuine
 * kernel Job Object origin requires transporting these frames over the authenticated private control
 * channel (e.g. non-inherited named pipe), strictly isolated from project stdout/stderr.
 */
export function validateWindowsJobControlResponse(
  raw: unknown,
  expected: WindowsJobControlExpectedContext
): WindowsJobControlResponse {
  if (!expected || typeof expected !== 'object') {
    throw new Error('Expected control context must be provided; settlement proof is denied.');
  }
  if (!hex64Regex.test(expected.nonce)) {
    throw new Error('Expected nonce must be a complete 64-character lowercase hex string.');
  }
  if (!hex64Regex.test(expected.workspaceId)) {
    throw new Error('Expected workspaceId must be a complete 64-character lowercase hex string.');
  }
  if (!hex64Regex.test(expected.invocationId)) {
    throw new Error('Expected invocationId must be a complete 64-character lowercase hex string.');
  }
  if (!Number.isSafeInteger(expected.sequence) || expected.sequence < 0) {
    throw new Error('Expected sequence number must be a safe non-negative integer.');
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Control response is not a valid JSON object; settlement proof is denied.');
  }
  const r = raw as Record<string, unknown>;

  // Reject unknown keys to prevent schema smuggling
  for (const key of Object.keys(r)) {
    if (!recognizedResponseKeys.has(key)) {
      throw new Error(`Control response contains unexpected field "${key}"; settlement proof is denied.`);
    }
  }

  if (r.schemaVersion !== 1 || r.kind !== 'response') {
    throw new Error('Unsupported control response schema or kind; settlement proof is denied.');
  }

  const expectedController = expected.controllerId ?? defaultWindowsJobControllerId;
  if (typeof r.controllerId !== 'string' || r.controllerId !== expectedController) {
    throw new Error(`Mismatched controller identity "${String(r.controllerId)}"; settlement proof is denied.`);
  }
  if (typeof r.workspaceId !== 'string' || r.workspaceId !== expected.workspaceId) {
    throw new Error('Mismatched or unauthenticated workspace binding in control response; settlement proof is denied.');
  }
  if (typeof r.invocationId !== 'string' || r.invocationId !== expected.invocationId) {
    throw new Error('Mismatched or unauthenticated invocation binding in control response; settlement proof is denied.');
  }
  if (typeof r.nonce !== 'string' || r.nonce !== expected.nonce) {
    throw new Error('Mismatched or unauthenticated control response nonce; settlement proof is denied.');
  }
  if (!Number.isSafeInteger(r.sequence) || r.sequence !== expected.sequence) {
    throw new Error('Mismatched control response sequence number; settlement proof is denied.');
  }

  const validPhases: WindowsJobControlPhase[] = ['running', 'completed', 'terminated', 'failed'];
  if (typeof r.phase !== 'string' || !validPhases.includes(r.phase as WindowsJobControlPhase)) {
    throw new Error(`Invalid execution phase "${String(r.phase)}" in control response; settlement proof is denied.`);
  }
  const phase = r.phase as WindowsJobControlPhase;

  if (!Number.isSafeInteger(r.activeProcesses) || (r.activeProcesses as number) < 0) {
    throw new Error('Invalid active process count in control response; settlement proof is denied.');
  }
  const activeProcesses = r.activeProcesses as number;

  if (typeof r.settled !== 'boolean' || typeof r.jobTerminated !== 'boolean') {
    throw new Error('Invalid settlement or termination flags in control response; settlement proof is denied.');
  }

  if (r.status !== null && (typeof r.status !== 'number' || !Number.isSafeInteger(r.status))) {
    throw new Error('Invalid status in control response; must be a safe integer or null.');
  }
  const status = r.status as number | null;

  if (r.signal !== null && (typeof r.signal !== 'string' || r.signal.length === 0)) {
    throw new Error('Invalid signal in control response; must be a non-empty string or null.');
  }
  const signal = r.signal as string | null;

  if (r.outputLimitExceeded !== undefined && typeof r.outputLimitExceeded !== 'boolean') {
    throw new Error('Invalid outputLimitExceeded in control response; must be a boolean when provided.');
  }

  if (r.error !== undefined && (typeof r.error !== 'string' || r.error.length === 0)) {
    throw new Error('Invalid error in control response; must be a non-empty string when provided.');
  }
  const error = r.error as string | undefined;

  if (r.jobTerminated === true && phase === 'completed') {
    throw new Error('Contradictory settlement evidence: job is marked terminated but phase is "completed".');
  }
  if (r.jobTerminated === false && phase === 'terminated') {
    throw new Error('Contradictory settlement evidence: phase is "terminated" but jobTerminated is false.');
  }

  // Reject contradictory or invalid settlement claims:
  if (r.settled === true) {
    if (activeProcesses > 0) {
      throw new Error('Contradictory settlement evidence: active processes remain but settled was true.');
    }
    if (phase === 'running' || phase === 'failed') {
      throw new Error(`Contradictory settlement evidence: phase is "${phase}" but settled was true.`);
    }
    if (error !== undefined) {
      throw new Error('Contradictory settlement evidence: error is present but settled was true.');
    }
    if (status === null && signal === null) {
      throw new Error('Contradictory settlement evidence: neither status nor signal is recorded but settled was true.');
    }
  }

  // Model natural vs terminated settlement:
  // - Natural completion: activeProcesses === 0, phase === 'completed', status !== null, error === undefined.
  // - Terminated completion: activeProcesses === 0, phase === 'terminated', jobTerminated === true, error === undefined.
  const naturalSettled = phase === 'completed' && activeProcesses === 0 && status !== null && !error;
  const terminatedSettled = phase === 'terminated' && activeProcesses === 0 && r.jobTerminated === true && !error;
  const settled = r.settled && (naturalSettled || terminatedSettled);

  return {
    schemaVersion: 1,
    kind: 'response',
    controllerId: r.controllerId,
    workspaceId: r.workspaceId,
    invocationId: r.invocationId,
    nonce: r.nonce,
    sequence: r.sequence,
    phase,
    status,
    signal,
    activeProcesses,
    jobTerminated: r.jobTerminated,
    settled,
    ...(r.outputLimitExceeded !== undefined ? { outputLimitExceeded: Boolean(r.outputLimitExceeded) } : {}),
    ...(error ? { error } : {})
  };
}

export type WindowsJobSessionState =
  | 'uninitialized'
  | 'controller-ready'
  | 'scope-admitted'
  | 'root-requested'
  | 'root-started'
  | 'settled'
  | 'failed';

/**
 * Delivery-neutral execution session state machine.
 * Enforces the strict sequence: controller-ready -> scope-admitted -> root-requested -> root-started -> settled/failed.
 * Rejects settlement if the root process was never started or if sequence numbers are not monotonic.
 */
export class WindowsJobExecutionSession {
  private state: WindowsJobSessionState = 'uninitialized';
  private currentSequence = 0;
  private readonly expectedControllerId: string;
  private admittedInvocation: WindowsJobAdmittedInvocation | null = null;
  private invocationId: string | null = null;
  private nonce: string | null = null;

  constructor(expectedControllerId: string = defaultWindowsJobControllerId) {
    this.expectedControllerId = expectedControllerId;
  }

  getState(): WindowsJobSessionState {
    return this.state;
  }

  getSequence(): number {
    return this.currentSequence;
  }

  getInvocationId(): string | null {
    return this.invocationId;
  }

  onControllerReady(controllerId: string = defaultWindowsJobControllerId): void {
    if (this.state !== 'uninitialized') {
      throw new Error(`Invalid session state transition to controller-ready from "${this.state}".`);
    }
    if (controllerId !== this.expectedControllerId) {
      throw new Error(`Mismatched controller identity "${controllerId}"; expected "${this.expectedControllerId}".`);
    }
    this.state = 'controller-ready';
  }

  admitScope(invocation: WindowsJobAdmittedInvocation, nonce: string): string {
    if (this.state !== 'controller-ready') {
      throw new Error(`Cannot admit scope in session state "${this.state}"; controller must be ready first.`);
    }
    const controllerId = invocation.controllerId ?? this.expectedControllerId;
    if (controllerId !== this.expectedControllerId) {
      throw new Error(`Mismatched controller identity in invocation "${controllerId}"; expected "${this.expectedControllerId}".`);
    }
    if (typeof invocation.executable !== 'string' || invocation.executable.length === 0) {
      throw new Error('Invalid executable in invocation; must be a non-empty string.');
    }
    if (typeof invocation.cwd !== 'string' || invocation.cwd.length === 0) {
      throw new Error('Invalid cwd in invocation; must be a non-empty string.');
    }
    if (!Array.isArray(invocation.args)) {
      throw new Error('Invalid args in invocation; must be an array of strings.');
    }
    if (!hex64Regex.test(invocation.workspaceId)) {
      throw new Error('Invalid workspaceId in invocation; must be a 64-character lowercase hex string.');
    }
    if (!hex64Regex.test(invocation.envDigest)) {
      throw new Error('Invalid envDigest in invocation; must be a 64-character lowercase hex string.');
    }
    if (!hex64Regex.test(nonce)) {
      throw new Error('Invalid cryptographic nonce; must be a 64-character lowercase hex string.');
    }
    if (!Number.isSafeInteger(invocation.timeoutMs) || invocation.timeoutMs <= 0) {
      throw new Error('Invalid timeoutMs in invocation; must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(invocation.maxOutputBytes) || invocation.maxOutputBytes <= 0) {
      throw new Error('Invalid maxOutputBytes in invocation; must be a positive safe integer.');
    }

    this.admittedInvocation = Object.freeze({
      workspaceId: invocation.workspaceId,
      controllerId,
      executable: invocation.executable,
      args: Object.freeze([...invocation.args]),
      cwd: invocation.cwd,
      envDigest: invocation.envDigest,
      timeoutMs: invocation.timeoutMs,
      maxOutputBytes: invocation.maxOutputBytes,
      ...(invocation.envBlockBase64 ? { envBlockBase64: invocation.envBlockBase64 } : {}),
      ...(invocation.stdoutFile ? { stdoutFile: invocation.stdoutFile } : {}),
      ...(invocation.stderrFile ? { stderrFile: invocation.stderrFile } : {})
    });
    this.invocationId = deriveInvocationDigest(this.admittedInvocation);
    this.nonce = nonce;
    this.currentSequence = 0;
    this.state = 'scope-admitted';
    return this.invocationId;
  }

  authenticateControllerReady(rawReady: unknown): void {
    if (this.state !== 'scope-admitted' || !this.admittedInvocation || !this.invocationId || !this.nonce) {
      throw new Error(`Cannot authenticate controller ready in session state "${this.state}"; scope must be admitted first.`);
    }
    if (typeof rawReady !== 'object' || rawReady === null || Array.isArray(rawReady)) {
      this.state = 'failed';
      throw new Error('Invalid controller ready frame; authentication denied.');
    }
    const ready = rawReady as Record<string, unknown>;
    if (ready.schemaVersion !== 1 || ready.kind !== 'ready') {
      this.state = 'failed';
      throw new Error('Unsupported controller ready schema or kind; authentication denied.');
    }
    if (ready.controllerId !== this.admittedInvocation.controllerId) {
      this.state = 'failed';
      throw new Error(`Mismatched controller identity in ready frame "${String(ready.controllerId)}"; authentication denied.`);
    }
    if (ready.workspaceId !== this.admittedInvocation.workspaceId) {
      this.state = 'failed';
      throw new Error('Mismatched workspaceId in controller ready frame; authentication denied.');
    }
    if (ready.invocationId !== this.invocationId) {
      this.state = 'failed';
      throw new Error('Mismatched invocationId in controller ready frame; authentication denied.');
    }
    if (ready.nonce !== this.nonce) {
      this.state = 'failed';
      throw new Error('Mismatched cryptographic nonce in controller ready frame; authentication denied.');
    }
  }

  requestRootStart(): WindowsJobControlSpawnRequest {
    if (this.state !== 'scope-admitted' || !this.admittedInvocation || !this.invocationId || !this.nonce) {
      throw new Error(`Cannot request root start in session state "${this.state}"; scope must be admitted first.`);
    }
    const commandLine = formatWindowsArgvCommandLine({
      executable: this.admittedInvocation.executable,
      args: this.admittedInvocation.args
    });
    this.currentSequence = 1;
    this.state = 'root-requested';
    return {
      schemaVersion: 1,
      kind: 'spawn',
      controllerId: this.admittedInvocation.controllerId!,
      workspaceId: this.admittedInvocation.workspaceId,
      invocationId: this.invocationId,
      nonce: this.nonce,
      sequence: this.currentSequence,
      executable: this.admittedInvocation.executable,
      commandLine,
      cwd: this.admittedInvocation.cwd,
      envDigest: this.admittedInvocation.envDigest,
      timeoutMs: this.admittedInvocation.timeoutMs,
      maxOutputBytes: this.admittedInvocation.maxOutputBytes,
      ...(this.admittedInvocation.envBlockBase64 ? { envBlockBase64: this.admittedInvocation.envBlockBase64 } : {}),
      ...(this.admittedInvocation.stdoutFile ? { stdoutFile: this.admittedInvocation.stdoutFile } : {}),
      ...(this.admittedInvocation.stderrFile ? { stderrFile: this.admittedInvocation.stderrFile } : {})
    };
  }

  onRootStartAcknowledged(rawAck: unknown): void {
    if (this.state !== 'root-requested' || !this.admittedInvocation || !this.invocationId || !this.nonce) {
      throw new Error(`Cannot process root start acknowledgement in session state "${this.state}"; root start was not requested.`);
    }
    if (typeof rawAck !== 'object' || rawAck === null || Array.isArray(rawAck)) {
      this.state = 'failed';
      throw new Error('Invalid control acknowledgement frame; settlement proof is denied.');
    }
    const ack = rawAck as Record<string, unknown>;
    if (ack.schemaVersion !== 1 || ack.kind !== 'ack') {
      this.state = 'failed';
      throw new Error('Unsupported acknowledgement frame schema or kind; settlement proof is denied.');
    }
    if (ack.controllerId !== this.admittedInvocation.controllerId ||
        ack.workspaceId !== this.admittedInvocation.workspaceId ||
        ack.invocationId !== this.invocationId ||
        ack.nonce !== this.nonce ||
        ack.sequence !== this.currentSequence) {
      this.state = 'failed';
      throw new Error('Mismatched scope binding or sequence in root start acknowledgement.');
    }
    if (ack.error !== undefined && (typeof ack.error !== 'string' || ack.error.length === 0)) {
      this.state = 'failed';
      throw new Error('Invalid error in acknowledgement frame; must be a non-empty string when provided.');
    }
    if (ack.admitted === true && ack.error !== undefined) {
      this.state = 'failed';
      throw new Error('Contradictory acknowledgement frame: admitted is true but error is present.');
    }
    if (typeof ack.admitted !== 'boolean') {
      this.state = 'failed';
      throw new Error('Invalid or missing admitted flag in control acknowledgement frame; must be a boolean.');
    }
    if (ack.admitted === false) {
      this.state = 'failed';
      throw new WindowsJobAdmissionDeniedError(`Root process admission was denied by controller: ${String(ack.error ?? 'unknown error')}.`);
    }
    this.state = 'root-started';
  }

  ingestResponse(raw: unknown): WindowsJobControlResponse {
    if (this.state !== 'root-started') {
      throw new Error(`Cannot process execution response in session state "${this.state}": root start was not acknowledged by controller.`);
    }
    if (!this.admittedInvocation || !this.invocationId || !this.nonce) {
      throw new Error('No scope admitted in this execution session.');
    }

    const validated = validateWindowsJobControlResponse(raw, {
      controllerId: this.admittedInvocation.controllerId,
      workspaceId: this.admittedInvocation.workspaceId,
      invocationId: this.invocationId,
      nonce: this.nonce,
      sequence: this.currentSequence
    });

    if (validated.settled) {
      this.state = 'settled';
    } else if (validated.phase === 'failed' || validated.error) {
      this.state = 'failed';
    }

    this.currentSequence++;
    return validated;
  }
}

/**
 * Frames a JSON message with a 4-byte big-endian length header for stream transport.
 */
export function frameControlMessage(payload: unknown): Buffer {
  const json = JSON.stringify(payload);
  const bytes = Buffer.from(json, 'utf8');
  if (bytes.byteLength > maximumControlMessageBytes) {
    throw new Error(`Control message exceeds maximum size of ${maximumControlMessageBytes} bytes.`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.byteLength, 0);
  return Buffer.concat([header, bytes]);
}

/**
 * Unframes length-prefixed control messages from an incoming stream buffer.
 */
export function unframeControlMessages(buffer: Buffer): { messages: unknown[]; remainder: Buffer } {
  const messages: unknown[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.byteLength) {
    const length = buffer.readUInt32BE(offset);
    if (length > maximumControlMessageBytes) {
      throw new Error(`Incoming control message length ${length} exceeds maximum bound.`);
    }
    if (offset + 4 + length > buffer.byteLength) {
      break;
    }
    const payloadBytes = buffer.subarray(offset + 4, offset + 4 + length);
    const json = payloadBytes.toString('utf8');
    messages.push(JSON.parse(json));
    offset += 4 + length;
  }
  return { messages, remainder: buffer.subarray(offset) };
}
