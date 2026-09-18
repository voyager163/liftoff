import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { StateMigrationError, type StateFailureCode, type StateRegisteredExecutable } from '../../domain/repair/stateful.js';
import { stateAssert, stateDigest } from '../../domain/repair/stateful-invariants.js';
import { isolatedStateEnvironment, verifyStateExecutable } from './native-system.js';
import { OwnedPrivateStateProcessRunner } from './owned-process.js';
import { linuxReadonlyProcessProgram } from './linux-readonly-process-program.js';

/**
 * Denies ABI-3 filesystem content/entry mutations outside fresh writable trees.
 * Not full immutability: metadata, network/IPC, received FDs, external writers,
 * external alias/mount changes and unmediated operations are not protected.
 * The caller must independently own/quiesce this scope and admit the executable.
 * This is neither key custody nor an enrollment/restart/qualification receipt.
 */
export const linuxReadonlyProcessContract = Object.freeze({
  kind: 'linux-landlock-readonly-process/1',
  minimumAbi: 3,
  helperDigest: stateDigest(linuxReadonlyProcessProgram),
  scope: 'newly-opened-files-and-directory-entries',
  writableRoots: 'three-fresh-private-disjoint-same-mount-subtrees',
  metadataImmutability: false,
  networkIsolation: false,
  externalWriterExclusion: false,
  encryptedCustody: false
} as const);

interface DirectoryIdentity {
  device: string;
  inode: string;
  ctime: string;
  uid: number;
  mode: number;
}

interface DirectoryObservation {
  path: string;
  identity: DirectoryIdentity;
}

export interface LinuxReadonlyProcessRequest {
  python: StateRegisteredExecutable;
  executable: StateRegisteredExecutable;
  /** Public command arguments only. Private material belongs exclusively in stdin. */
  args: readonly string[];
  scopeDirectory: string;
  storeDirectory: string;
  writableDirectories: { control: string; runtime: string; scratch: string };
  /** Already-authorized private input; owned-process supervision copies and clears its copy. */
  stdin?: Uint8Array;
  timeoutMs: number;
  maximumBytes: number;
  signal?: AbortSignal;
}

function strictlyBelow(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function observeDirectory(directory: string): Promise<DirectoryObservation> {
  stateAssert(path.isAbsolute(directory) && path.normalize(directory) === directory
    && directory !== path.parse(directory).root && await realpath(directory) === directory, 'unsafe-path');
  const info = await lstat(directory, { bigint: true });
  stateAssert(info.isDirectory() && !info.isSymbolicLink() && info.uid === BigInt(process.getuid!())
    && (info.mode & 0o077n) === 0n, 'unsafe-path');
  return {
    path: directory,
    identity: { device: String(info.dev), inode: String(info.ino), ctime: String(info.ctimeNs),
      uid: Number(info.uid), mode: Number(info.mode & 0o7777n) }
  };
}

export class LinuxReadonlyProcessGuard {
  readonly #runner = new OwnedPrivateStateProcessRunner();
  #generation = 0;

  quiesce(): Promise<void> {
    this.#generation++;
    return this.#runner.quiesce();
  }

  /** stdout remains private; the caller must consume and clear the returned bytes. */
  async run(request: LinuxReadonlyProcessRequest): Promise<{ exitCode: 0; stdout: Uint8Array }> {
    stateAssert(process.platform === 'linux', 'unsupported-native-platform');
    stateAssert(process.arch === 'x64' || process.arch === 'arm64', 'unqualified-combination');
    stateAssert(Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 && request.timeoutMs <= 300_000
      && Number.isSafeInteger(request.maximumBytes) && request.maximumBytes > 0 && request.maximumBytes <= 32 * 1024 * 1024
      && (request.stdin?.byteLength ?? 0) <= 32 * 1024 * 1024, 'invalid-binding');
    stateAssert(!request.signal?.aborted, 'cancelled');
    const generation = this.#generation;
    const deadline = Date.now() + request.timeoutMs;
    try {
      const scope = await observeDirectory(request.scopeDirectory);
      const store = await observeDirectory(request.storeDirectory);
      const writable = await Promise.all([
        request.writableDirectories.control, request.writableDirectories.runtime, request.writableDirectories.scratch
      ].map(observeDirectory));
      const entries = [store, ...writable];
      stateAssert(entries.every((entry) => strictlyBelow(scope.path, entry.path)), 'unsafe-path');
      for (let index = 0; index < entries.length; index++) {
        for (const other of entries.slice(index + 1)) {
          const current = entries[index]!;
          stateAssert(current.path !== other.path && !strictlyBelow(current.path, other.path) && !strictlyBelow(other.path, current.path)
            && (current.identity.device !== other.identity.device || current.identity.inode !== other.identity.inode), 'unsafe-path');
        }
      }
      // Fresh leaves prevent preexisting hard-link/symlink aliases from obtaining write rights.
      for (const entry of writable) stateAssert((await readdir(entry.path)).length === 0, 'unsafe-path');
      stateAssert(request.args.length <= 128 && request.args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))
        && JSON.stringify(request.args).length <= 32_768, 'invalid-binding');
      await verifyStateExecutable(request.python);
      await verifyStateExecutable(request.executable);
      stateAssert(await realpath(request.python.path) === request.python.path
        && await realpath(request.executable.path) === request.executable.path, 'tool-unavailable');
      const target = await lstat(request.executable.path, { bigint: true });
      const executable = { ...request.executable, identity: {
        device: String(target.dev), inode: String(target.ino), ctime: String(target.ctimeNs),
        uid: Number(target.uid), mode: Number(target.mode & 0o7777n)
      } };
      const timeoutMs = deadline - Date.now();
      stateAssert(timeoutMs > 0, 'timeout');
      stateAssert(generation === this.#generation && !request.signal?.aborted, 'cancelled');
      const result = await this.#runner.run({
        executable: request.python.path,
        args: ['-I', '-S', '-B', '-c', linuxReadonlyProcessProgram, JSON.stringify({ scope, store, writable, executable, args: request.args })],
        cwd: writable[2]!.path,
        environment: {
          ...isolatedStateEnvironment(writable[2]!.path),
          XDG_RUNTIME_DIR: writable[1]!.path
        },
        stdin: request.stdin, timeoutMs, maximumBytes: request.maximumBytes, signal: request.signal
      });
      try {
        if (result.exitCode !== 0) {
          result.stdout.fill(0);
          const message = Buffer.from(result.stderr.buffer, result.stderr.byteOffset, result.stderr.byteLength);
          const codes: StateFailureCode[] = [
            'unsupported-native-platform', 'unqualified-combination', 'access-denied',
            'unsafe-path', 'tool-unavailable', 'invalid-binding', 'operation-failed'
          ];
          const code = result.exitCode === 125
            ? codes.find((value) => message.equals(Buffer.from(`liftoff-readonly:${value}\n`, 'ascii'))) : undefined;
          throw new StateMigrationError(code ?? 'native-command-failed');
        }
        return { exitCode: 0, stdout: result.stdout };
      } finally { result.stderr.fill(0); }
    } catch (error) {
      if (error instanceof StateMigrationError) throw error;
      throw new StateMigrationError('operation-failed');
    }
  }
}
