import { isUtf8 } from 'node:buffer';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from '../../domain/governance/activation/canonical-json.js';
import { parseStrictManifestJson } from '../../domain/project/manifest/json.js';
import { StateMigrationError, type StateRegisteredExecutable } from '../../domain/repair/stateful.js';
import { stateAssert, stateDigest } from '../../domain/repair/stateful-invariants.js';
import {
  decodeLinuxFscryptKeyStatus, decodeLinuxFscryptPolicy, linuxStorageInterfaceDigest,
  linuxStorageDirectoryProfile, parseLinuxStorageDirectoryObservation, type LinuxStorageDirectoryObservation
} from '../../domain/repair/linux-storage-observation.js';
import { nativeStateHostId, isolatedStateEnvironment, verifyStateExecutable } from './native-system.js';
import { OwnedPrivateStateProcessRunner } from './owned-process.js';
import { linuxStorageDirectoryProgram } from './linux-storage-program.js';

export const linuxStorageDirectoryHelperDigest = stateDigest(linuxStorageDirectoryProgram);
const nativeObservations = new WeakSet<LinuxStorageDirectoryObservation>();
const failures = [
  'unsupported-native-platform', 'unqualified-combination', 'invalid-binding', 'unsafe-path',
  'unsupported-encryption', 'ownership-mismatch', 'key-unavailable', 'stale-state',
  'access-denied', 'storage-limit', 'operation-failed'
] as const;

interface ReadbackContext {
  path: string;
  kind: 'directory';
  hostRef: string;
  principalUid: number;
  architecture: 'x64' | 'arm64';
  observedAt: number;
}

/** Parses metadata only; calling this does not create native observation provenance. */
export function decodeLinuxStorageDirectoryReadback(bytes: Uint8Array, context: ReadbackContext): LinuxStorageDirectoryObservation {
  stateAssert(bytes.byteLength <= 16384 && isUtf8(bytes), 'artifact-integrity');
  let value: unknown;
  try { value = parseStrictManifestJson(Buffer.from(bytes).toString('utf8'), 'Linux storage observation'); }
  catch { throw new StateMigrationError('artifact-integrity'); }
  stateAssert(isRecord(value), 'artifact-integrity');
  if (Object.keys(value).length === 1 && typeof value.blocked === 'string') {
    throw new StateMigrationError(failures.find((code) => code === value.blocked) ?? 'operation-failed');
  }
  stateAssert(Object.keys(value).sort().join(',') === 'ancestryDigest,filesystem,keyStatusHex,object,path,policyHex' &&
    value.path === context.path && isRecord(value.object) && value.object.kind === context.kind &&
    value.object.uid === context.principalUid && typeof value.policyHex === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.policyHex) && typeof value.keyStatusHex === 'string' &&
    /^[a-f0-9]{256}$/u.test(value.keyStatusHex), 'artifact-integrity');
  const policy = decodeLinuxFscryptPolicy(Buffer.from(value.policyHex, 'hex'));
  const key = decodeLinuxFscryptKeyStatus(Buffer.from(value.keyStatusHex, 'hex'), policy);
  return parseLinuxStorageDirectoryObservation({
    schemaVersion: 1, kind: linuxStorageDirectoryProfile, contractDigest: linuxStorageInterfaceDigest,
    helperDigest: linuxStorageDirectoryHelperDigest,
    hostRef: context.hostRef, principalUid: context.principalUid, architecture: context.architecture,
    path: value.path, object: value.object, filesystem: value.filesystem, ancestryDigest: value.ancestryDigest,
    policy, key, observedAt: context.observedAt,
    coverage: 'selected-existing-directory-policy-only', volumeEncryption: 'not-observed',
    backingDeviceLocality: 'not-observed', keyCustody: 'not-observed',
    inodeKeyUsability: 'not-observed',
    descendantCoverage: 'not-observed', authorization: 'none', nativeQualification: 'required', readiness: false
  });
}

/**
 * Invocation provenance only, not continued key presence, software qualification,
 * protected-volume authority, a lease, or permission to read/write private data.
 */
export function hasNativeLinuxStorageDirectoryProvenance(value: LinuxStorageDirectoryObservation): boolean {
  return process.platform === 'linux' && nativeObservations.has(value) &&
    value.hostRef === nativeStateHostId() && value.principalUid === process.getuid?.() &&
    value.architecture === process.arch && value.helperDigest === linuxStorageDirectoryHelperDigest;
}

export interface LinuxStorageDirectoryRequest {
  python: StateRegisteredExecutable;
  path: string;
  kind: 'directory';
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Read-only directory observer. Deliberately does not implement ProtectedVolumeAttestor. */
export class LinuxFscryptDirectoryObserver {
  readonly #runner = new OwnedPrivateStateProcessRunner();
  #generation = 0;
  quiesce(): Promise<void> {
    this.#generation++;
    return this.#runner.quiesce();
  }

  async observe(request: LinuxStorageDirectoryRequest): Promise<LinuxStorageDirectoryObservation> {
    stateAssert(process.platform === 'linux', 'unsupported-native-platform');
    stateAssert(process.arch === 'x64' || process.arch === 'arm64', 'unqualified-combination');
    const generation = this.#generation, principalUid = process.getuid!(), hostRef = nativeStateHostId();
    stateAssert(principalUid > 0, 'ownership-mismatch');
    stateAssert(isRecord(request) && Object.keys(request).every((field) =>
      ['python', 'path', 'kind', 'timeoutMs', 'signal'].includes(field)) &&
      isRecord(request.python) && Object.keys(request.python).sort().join(',') === 'path,sha256' &&
      typeof request.python.path === 'string' && typeof request.python.sha256 === 'string' &&
      /^[a-f0-9]{64}$/u.test(request.python.sha256) &&
      request.kind === 'directory' &&
      typeof request.path === 'string' && request.path !== '/' && path.isAbsolute(request.path) &&
      path.normalize(request.path) === request.path && request.path.normalize('NFC') === request.path &&
      !request.path.endsWith('/') && Buffer.byteLength(request.path) <= 4095 &&
      Buffer.from(request.path).toString() === request.path && !/[\u0000-\u001f\u007f\\]/u.test(request.path), 'invalid-binding');
    request = Object.freeze({ ...request, python: Object.freeze({ ...request.python }) });
    const timeoutMs = request.timeoutMs ?? 5000;
    stateAssert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 15000, 'invalid-binding');
    stateAssert(!request.signal?.aborted, 'cancelled');
    const deadline = Date.now() + timeoutMs;
    try {
      await verifyStateExecutable(request.python);
      stateAssert(await realpath(request.python.path) === request.python.path, 'tool-unavailable');
      const cwd = await realpath(process.cwd()), remaining = deadline - Date.now();
      stateAssert(remaining > 0, 'timeout');
      stateAssert(generation === this.#generation && !request.signal?.aborted, 'cancelled');
      const result = await this.#runner.run({
        executable: request.python.path,
        args: ['-I', '-S', '-B', '-c', linuxStorageDirectoryProgram, JSON.stringify({
          path: request.path, kind: request.kind, principalUid
        })],
        cwd, environment: isolatedStateEnvironment(cwd),
        timeoutMs: remaining, maximumBytes: 16384, signal: request.signal, captureStderr: false
      });
      try {
        stateAssert(result.exitCode === 0, 'native-command-failed');
        stateAssert(generation === this.#generation && !request.signal?.aborted, 'cancelled');
        stateAssert(hostRef === nativeStateHostId() && principalUid === process.getuid!(), 'ownership-mismatch');
        const observed = decodeLinuxStorageDirectoryReadback(result.stdout, {
          path: request.path, kind: request.kind, principalUid, hostRef,
          architecture: process.arch, observedAt: Date.now()
        });
        nativeObservations.add(observed);
        return observed;
      } finally { result.stdout.fill(0); result.stderr.fill(0); }
    } catch (error) {
      if (error instanceof StateMigrationError) throw error;
      throw new StateMigrationError('operation-failed');
    }
  }
}
