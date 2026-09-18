import { isUtf8 } from 'node:buffer';
import { inspect } from 'node:util';
import { isRecord } from '../../domain/governance/activation/canonical-json.js';
import { parseStrictManifestJson } from '../../domain/project/manifest/json.js';
import { StateMigrationError } from '../../domain/repair/stateful.js';

export const linuxKeystoreClientProtocol = 'liftoff-linux-keystore-client/1';
export const maximumLinuxKeystoreOutputBytes = 6212;
const collection = '/org/freedesktop/secrets/collection/login';
const errorCodes = [
  'ok', 'invalid-arguments', 'unsupported-platform', 'memory-protection',
  'transport-unavailable', 'identity-changed', 'encrypted-session-required', 'locked',
  'item-mismatch', 'random-unavailable', 'provider-failure', 'cancelled-or-expired',
  'output-failed', 'protocol-limit'
] as const;
type NativeErrorCode = typeof errorCodes[number];
type CreationEffect = 'no-dispatch' | 'possible-mutation' | 'returned-identity';
type Event = 'before-create' | 'created-identity' | 'result';

interface Frame {
  event: Event;
  effect: CreationEffect;
  code: NativeErrorCode;
  item: string | null;
  keyBytes: number;
}

export class PrivateLinuxKeySnapshot {
  #bytes: Buffer | undefined;
  constructor(bytes: Uint8Array) {
    if (bytes.byteLength !== 32) throw new StateMigrationError('key-unavailable');
    this.#bytes = Buffer.from(bytes);
  }
  async consume<T>(action: (bytes: Uint8Array) => Promise<T> | T): Promise<T> {
    const bytes = this.#bytes;
    if (!bytes) throw new StateMigrationError('key-unavailable');
    this.#bytes = undefined;
    try { return await action(bytes); } finally { bytes.fill(0); }
  }
  release(): void { this.#bytes?.fill(0); this.#bytes = undefined; }
  toJSON(): never { throw new StateMigrationError('access-denied'); }
  [inspect.custom](): string { return '[PrivateLinuxKeySnapshot]'; }
}

export type LinuxKeyClientRequest =
  | { operation: 'create' }
  | { operation: 'read'; item: string };

export interface LinuxKeyClientOutcome {
  status: 'completed' | 'failed' | 'incomplete';
  /** Creation only; this never claims that no protected reads or session effects occurred. */
  creation: CreationEffect | 'unknown';
  /** Observed identities only; these do not grant read, retry, ownership or deletion authority. */
  observedItemPaths: readonly string[];
  issue: Exclude<NativeErrorCode, 'ok'> | 'invalid-output' | 'process-unsettled' | 'process-failed' | null;
  key: PrivateLinuxKeySnapshot | null;
  readiness: false;
}

function objectPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && /^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/u.test(value);
}

function admittedItem(value: string): boolean {
  return value.startsWith(`${collection}/`) && /^[A-Za-z0-9_]{1,128}$/u.test(value.slice(collection.length + 1));
}

function event(value: unknown): value is Event {
  return value === 'before-create' || value === 'created-identity' || value === 'result';
}

function effect(value: unknown): value is CreationEffect {
  return value === 'no-dispatch' || value === 'possible-mutation' || value === 'returned-identity';
}

function errorCode(value: unknown): value is NativeErrorCode {
  return typeof value === 'string' && errorCodes.some((code) => code === value);
}

function assertRequest(request: LinuxKeyClientRequest): void {
  if (!request || request.operation !== 'create' && request.operation !== 'read' ||
      request.operation === 'read' && (!objectPath(request.item) || !admittedItem(request.item))) {
    throw new StateMigrationError('invalid-binding');
  }
}

function metadata(bytes: Buffer, keyBytes: number): Frame | null {
  if (!isUtf8(bytes)) return null;
  let value: unknown;
  try { value = parseStrictManifestJson(bytes.toString('utf8'), 'Private native metadata'); }
  catch { return null; }
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'code,effect,event,item,keyBytes,protocol' ||
      value.protocol !== linuxKeystoreClientProtocol ||
      !event(value.event) || !effect(value.effect) || !errorCode(value.code) ||
      value.item !== null && !objectPath(value.item) || value.keyBytes !== keyBytes) return null;
  return {
    event: value.event, effect: value.effect, code: value.code, item: value.item, keyBytes
  };
}

/**
 * Consumes and clears owned private output. Decoding does not authenticate the
 * helper, authorize an operation, or prove keystore persistence/readiness.
 */
export function consumeLinuxKeyClientOutput(
  output: Uint8Array, request: LinuxKeyClientRequest,
  process: { exitCode: number | null; processTreeSettled: boolean }
): LinuxKeyClientOutcome {
  const bytes = Buffer.from(output.buffer, output.byteOffset, output.byteLength);
  const observed = new Set<string>();
  let creation: LinuxKeyClientOutcome['creation'] = 'unknown';
  const outcome = (
    status: LinuxKeyClientOutcome['status'], issue: LinuxKeyClientOutcome['issue'], key: PrivateLinuxKeySnapshot | null = null
  ): LinuxKeyClientOutcome => ({
    status, creation, observedItemPaths: Object.freeze([...observed]), issue, key, readiness: false
  });
  try {
    assertRequest(request);
    if (bytes.length > maximumLinuxKeystoreOutputBytes) return outcome('incomplete', 'invalid-output');
    let offset = 0, count = 0;
    let stage: 'initial' | 'dispatched' | 'returned' | 'terminal' = 'initial';
    let terminal: Frame | null = null;
    let keyBytes: Buffer | null = null;
    let sequenceValid = true;
    let returnedItem: string | null = null;
    while (offset < bytes.length) {
      if (++count > 3 || bytes.length - offset < 12 || bytes.toString('ascii', offset, offset + 4) !== 'LKC1') {
        return outcome('incomplete', 'invalid-output');
      }
      const length = bytes.readUInt32BE(offset + 4), keyLength = bytes.readUInt32BE(offset + 8);
      if (length < 1 || length > 2048 || ![0, 32].includes(keyLength) ||
          offset + 12 + length + keyLength > bytes.length) return outcome('incomplete', 'invalid-output');
      const frame = metadata(bytes.subarray(offset + 12, offset + 12 + length), keyLength);
      const payload = bytes.subarray(offset + 12 + length, offset + 12 + length + keyLength);
      offset += 12 + length + keyLength;
      if (!frame) return outcome('incomplete', 'invalid-output');
      if (frame.effect === 'returned-identity') {
        if (frame.item) {
          creation = 'returned-identity';
          observed.add(frame.item);
        } else if (creation !== 'returned-identity') creation = 'possible-mutation';
      } else if (frame.effect === 'possible-mutation' && creation !== 'returned-identity') {
        creation = 'possible-mutation';
      }
      if (stage === 'terminal') { sequenceValid = false; continue; }
      if (request.operation === 'read') {
        sequenceValid &&= stage === 'initial' && frame.event === 'result' && frame.effect === 'no-dispatch' &&
          (frame.code === 'ok'
            ? frame.item === request.item && keyLength === 32
            : frame.item === null && keyLength === 0);
        if (frame.item) observed.add(frame.item);
        stage = 'terminal'; terminal = frame; keyBytes = payload;
        continue;
      }
      if (frame.event === 'before-create') {
        sequenceValid &&= stage === 'initial' && frame.effect === 'possible-mutation' &&
          frame.code === 'ok' && frame.item === null && keyLength === 0;
        stage = 'dispatched';
      } else if (frame.event === 'created-identity') {
        sequenceValid &&= stage === 'dispatched' && frame.effect === 'returned-identity' &&
          frame.code === 'ok' && frame.item !== null && keyLength === 0;
        returnedItem = frame.item;
        stage = 'returned';
      } else {
        if (stage === 'initial') {
          sequenceValid &&= frame.effect === 'no-dispatch' && frame.code !== 'ok' && frame.item === null && keyLength === 0;
        } else if (stage === 'dispatched') {
          sequenceValid &&= frame.effect === 'possible-mutation' && frame.code !== 'ok' && frame.item === null && keyLength === 0;
        } else {
          sequenceValid &&= frame.effect === 'returned-identity' && frame.item === returnedItem &&
            (frame.code === 'ok' ? keyLength === 32 && frame.item !== null && admittedItem(frame.item) : keyLength === 0);
        }
        stage = 'terminal'; terminal = frame; keyBytes = payload;
      }
    }
    if (!sequenceValid || !terminal || stage !== 'terminal') return outcome('incomplete', 'invalid-output');
    if (process.processTreeSettled !== true) return outcome('incomplete', 'process-unsettled');
    if (!Number.isSafeInteger(process.exitCode) || process.exitCode === null ||
        process.exitCode < 0 || process.exitCode > 255) return outcome('incomplete', 'process-failed');
    if (terminal.code !== 'ok') {
      if (process.exitCode === 0) return outcome('incomplete', 'invalid-output');
      if (creation === 'unknown') creation = 'no-dispatch';
      return outcome('failed', terminal.code);
    }
    if (process.exitCode !== 0 || !keyBytes || keyBytes.length !== 32) return outcome('incomplete', 'process-failed');
    if (creation === 'unknown') creation = 'no-dispatch';
    return outcome('completed', null, new PrivateLinuxKeySnapshot(keyBytes));
  } finally { bytes.fill(0); }
}

export class LinuxKeyClientOutputCapture {
  #bytes = Buffer.alloc(0);
  #closed = false;
  #overflow = false;
  #creation: LinuxKeyClientOutcome['creation'] = 'unknown';
  #items = new Set<string>();
  readonly #request: LinuxKeyClientRequest;
  constructor(request: LinuxKeyClientRequest) {
    assertRequest(request);
    this.#request = Object.freeze({ ...request });
  }

  #remember(result: LinuxKeyClientOutcome): void {
    const rank = { unknown: 0, 'no-dispatch': 1, 'possible-mutation': 2, 'returned-identity': 3 };
    if (rank[result.creation] > rank[this.#creation]) this.#creation = result.creation;
    for (const item of result.observedItemPaths) this.#items.add(item);
  }

  append(chunk: Uint8Array): void {
    if (this.#closed) throw new StateMigrationError('invalid-binding');
    if (this.#overflow) return;
    if (this.#bytes.length + chunk.byteLength > maximumLinuxKeystoreOutputBytes) {
      const prefix = Buffer.concat([
        this.#bytes, chunk.subarray(0, maximumLinuxKeystoreOutputBytes - this.#bytes.length)
      ]);
      this.#remember(consumeLinuxKeyClientOutput(prefix, this.#request, { exitCode: null, processTreeSettled: false }));
      this.#bytes.fill(0);
      this.#bytes = Buffer.alloc(0);
      this.#overflow = true;
      return;
    }
    const next = Buffer.concat([this.#bytes, chunk]);
    this.#bytes.fill(0);
    this.#bytes = next;
    this.#remember(consumeLinuxKeyClientOutput(Buffer.from(next), this.#request, {
      exitCode: null, processTreeSettled: false
    }));
  }

  observed(): Pick<LinuxKeyClientOutcome, 'creation' | 'observedItemPaths'> {
    return { creation: this.#creation, observedItemPaths: Object.freeze([...this.#items]) };
  }

  finish(process: { exitCode: number | null; processTreeSettled: boolean }): LinuxKeyClientOutcome {
    if (this.#closed) throw new StateMigrationError('invalid-binding');
    this.#closed = true;
    try {
      const result: LinuxKeyClientOutcome = this.#overflow
        ? { status: 'incomplete', creation: 'unknown', observedItemPaths: [], issue: 'invalid-output', key: null, readiness: false }
        : consumeLinuxKeyClientOutput(this.#bytes, this.#request, process);
      this.#remember(result);
      return { ...result, ...this.observed() };
    } finally { this.#bytes.fill(0); this.#bytes = Buffer.alloc(0); }
  }

  release(): void { this.#closed = true; this.#bytes.fill(0); this.#bytes = Buffer.alloc(0); }
  toJSON(): never { throw new StateMigrationError('access-denied'); }
  [inspect.custom](): string { return '[LinuxKeyClientOutputCapture]'; }
}
