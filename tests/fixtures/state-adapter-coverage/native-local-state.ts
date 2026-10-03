import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstat, open, readFile, rename, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  StateMigrationError,
  type NativeLocalStateLockProvider,
  type NativeLocalStateTools,
  type StateFailureCode,
  type StateRegisteredExecutable
} from '../../../src/domain/repair/stateful.js';
import { stateDigest, stateObjectDigest } from '../../../src/domain/repair/stateful-invariants.js';

/**
 * An offline stand-in for the pinned OpenTofu CLI and the fcntl lock helper used by
 * native local-state qualification. It follows the POSIX record-lock semantics the
 * qualification asserts (locks follow the open inode, OpenTofu writes in place,
 * lock-info markers are advisory metadata) inside a disposable directory only.
 * Each fault models one way a real host or helper could violate that protocol.
 */
export interface SimulatedNativeFaults {
  toolsRejected?: StateFailureCode;
  failingCommand?: 'init' | 'apply';
  extraFixtureResource?: boolean;
  acquisitionTouchesState?: boolean;
  observerIgnoresHolderLock?: boolean;
  denialWithoutLockMessage?: boolean;
  releaseLeavesMarker?: boolean;
  consoleExitsBeforeLocking?: boolean;
  consoleExitCode?: number | null;
  holderIgnoresNativeLock?: boolean;
  holderDenial?: StateFailureCode | 'untyped';
  moveDrift?: 'lineage' | 'id' | 'serial' | 'address';
  planExitCode?: number;
  planShowsChange?: boolean;
  publicationRenames?: boolean;
  publishedWriteUnlocked?: boolean;
  holderAllowsRemove?: boolean;
  removeDenial?: StateFailureCode | 'untyped';
  holderAcceptsStaleReplace?: boolean;
  holderMissesInodeChange?: boolean;
  releaseRemovesForeignMarker?: boolean;
  pendingApplyAccepted?: boolean;
  pendingApplyKilled?: boolean;
  absentDenial?: StateFailureCode | 'untyped';
  abortWhenConsoleStarts?: AbortController;
}

interface NativeOutcome {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

interface LockHolder {
  kind: 'lease' | 'native';
  id: string;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function lockInfoPath(statePath: string): string {
  const name = path.basename(statePath);
  return path.join(path.dirname(statePath), `.${name.startsWith('.') ? name.slice(1) : name}.lock.info`);
}

async function inodeKey(handle: FileHandle): Promise<string> {
  const info = await handle.stat({ bigint: true });
  return `${info.dev}:${info.ino}`;
}

async function handleVersion(handle: FileHandle): Promise<string> {
  const info = await handle.stat({ bigint: true });
  return stateObjectDigest({
    dev: String(info.dev), ino: String(info.ino), size: String(info.size),
    mtime: String(info.mtimeNs), ctime: String(info.ctimeNs)
  });
}

async function readWhole(handle: FileHandle): Promise<Buffer> {
  const { size } = await handle.stat();
  const bytes = Buffer.alloc(size);
  if (size > 0) await handle.read(bytes, 0, size, 0);
  return bytes;
}

async function writeInPlace(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  await handle.truncate(0);
  await handle.write(bytes, 0, bytes.byteLength, 0);
  await handle.sync();
}

function flagValue(args: readonly string[], name: string): string | undefined {
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resourceAddress(resource: { module?: string; type: string; name: string }): string {
  return `${resource.module ? `${resource.module}.` : ''}${resource.type}.${resource.name}`;
}

function parseAddress(address: string): { module?: string; type: string; name: string } {
  const parts = address.split('.');
  const [type, name] = parts.slice(-2);
  const module = parts.slice(0, -2).join('.');
  return module ? { module, type, name } : { type, name };
}

export class SimulatedNativeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  input = '';
  finished = false;
  release: (() => Promise<void>) | null = null;
  readonly #inputEnded: Promise<string>;

  constructor(readonly args: readonly string[], readonly cwd: string, readonly emitted: Buffer[]) {
    super();
    this.#inputEnded = new Promise((resolve) => {
      this.stdin.on('data', (chunk: Buffer) => { this.input += chunk.toString('utf8'); });
      this.stdin.once('end', () => resolve(this.input));
    });
  }

  readInput(): Promise<string> { return this.#inputEnded; }

  write(stream: 'stdout' | 'stderr', text: string): void {
    const bytes = Buffer.from(text);
    this.emitted.push(bytes);
    this[stream].write(bytes);
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.finished) return;
    this.finished = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('close', code, signal));
  }
}

export class SimulatedLease {
  closed = false;

  constructor(
    private readonly native: SimulatedNativeLocalState,
    readonly statePath: string,
    readonly operationId: string,
    private readonly handle: FileHandle,
    private readonly key: string,
    private readonly marker: Buffer | null,
    private digest: string
  ) {}

  private async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const faults = this.native.faults;
    const infoPath = lockInfoPath(this.statePath);
    if (faults.releaseRemovesForeignMarker) {
      await unlink(infoPath).catch(() => undefined);
    } else if (this.marker && !faults.releaseLeavesMarker) {
      const current = await readFile(infoPath).catch(() => null);
      if (current?.equals(this.marker)) await unlink(infoPath);
    }
    this.native.unlock(this.key, this.operationId);
    await this.handle.close();
    this.native.leases.delete(this);
  }

  private async assertPath(): Promise<void> {
    if (this.native.faults.holderMissesInodeChange) return;
    const observed = await lstat(this.statePath, { bigint: true }).catch(() => null);
    const current = await readFile(lockInfoPath(this.statePath)).catch(() => null);
    const held = await this.handle.stat({ bigint: true });
    if (!observed || observed.dev !== held.dev || observed.ino !== held.ino || !this.marker || !current?.equals(this.marker)) {
      await this.close();
      throw new StateMigrationError('lock-lost');
    }
  }

  async assertHeld(): Promise<void> {
    if (this.closed) throw new StateMigrationError('lock-lost');
    await this.assertPath();
  }

  async replace(bytes: Uint8Array, expectedVersion: string | null): Promise<void> {
    if (expectedVersion === null || bytes.byteLength > 32 * 1024 * 1024) {
      throw new StateMigrationError('unsupported-local-state-operation');
    }
    if (this.closed) throw new StateMigrationError('lock-lost');
    await this.assertPath();
    const faults = this.native.faults;
    if (!faults.holderAcceptsStaleReplace) {
      if (await handleVersion(this.handle) !== expectedVersion || stateDigest(await readWhole(this.handle)) !== this.digest) {
        await this.close();
        throw new StateMigrationError('stale-state');
      }
    }
    if (faults.publicationRenames) {
      const staged = path.join(path.dirname(this.statePath), `.${randomUUID()}.staged`);
      await writeFile(staged, bytes, { mode: 0o600 });
      await rename(staged, this.statePath);
    } else {
      await writeInPlace(this.handle, bytes);
    }
    if (faults.publishedWriteUnlocked) this.native.unlock(this.key, this.operationId);
    this.digest = stateDigest(bytes);
  }

  async remove(_expectedVersion: string): Promise<void> {
    const faults = this.native.faults;
    if (faults.holderAllowsRemove) {
      await unlink(this.statePath);
      return;
    }
    if (faults.removeDenial === 'untyped') throw new Error('simulated helper failure without a state failure code');
    throw new StateMigrationError(faults.removeDenial ?? 'unsupported-local-state-operation');
  }

  async release(): Promise<void> { await this.close(); }
}

export class SimulatedNativeLocalState {
  readonly pythonPath = path.join(path.sep, 'simulated-native', 'bin', 'python3.14');
  readonly tofuPath = path.join(path.sep, 'simulated-native', 'bin', 'tofu');
  readonly tools: NativeLocalStateTools;
  readonly commands: Array<{ args: readonly string[]; cwd: string }> = [];
  readonly processes: SimulatedNativeProcess[] = [];
  readonly isolatedInitialisations: boolean[] = [];
  readonly outputs: Uint8Array[] = [];
  readonly emitted: Buffer[] = [];
  readonly leases = new Set<SimulatedLease>();
  readonly acquisitions: Array<{ path: string; expectedVersion: string | null }> = [];
  readonly stoppedProcesses: SimulatedNativeProcess[] = [];
  readonly stoppedDirectories: string[] = [];
  readonly backgroundFailures: unknown[] = [];
  scratchRoot: string | null = null;
  readonly #locks = new Map<string, LockHolder[]>();
  readonly #pending = new Set<Promise<void>>();

  constructor(hostId: string, readonly faults: SimulatedNativeFaults = {}) {
    this.tools = Object.freeze({
      python: Object.freeze({ path: this.pythonPath, sha256: stateDigest('simulated-cpython-3.14.2') }),
      tofu: Object.freeze({ path: this.tofuPath, sha256: stateDigest('simulated-opentofu-1.12.6') }),
      pythonVersion: '3.14.2',
      tofuVersion: '1.12.6',
      hostId
    });
  }

  get activeLocks(): number {
    return [...this.#locks.values()].reduce((count, holders) => count + holders.length, 0);
  }

  get runningProcesses(): SimulatedNativeProcess[] {
    return this.processes.filter((child) => !child.finished);
  }

  unlock(key: string, id: string): void {
    const holders = (this.#locks.get(key) ?? []).filter((holder) => holder.id !== id);
    if (holders.length) this.#locks.set(key, holders);
    else this.#locks.delete(key);
  }

  #lock(key: string, holder: LockHolder): void {
    this.#locks.set(key, [...(this.#locks.get(key) ?? []), holder]);
  }

  #locked(key: string): boolean {
    return (this.#locks.get(key)?.length ?? 0) > 0;
  }

  #assertExecutable(executable: StateRegisteredExecutable, expected: StateRegisteredExecutable): void {
    if (executable.path !== expected.path || executable.sha256 !== expected.sha256) {
      throw new Error('The simulated host only runs its registered executables.');
    }
  }

  async inspect(request: { pythonPath: string; tofuPath: string; workingDirectory: string }): Promise<NativeLocalStateTools> {
    if (request.pythonPath !== this.pythonPath || request.tofuPath !== this.tofuPath) {
      throw new StateMigrationError('tool-unavailable');
    }
    this.scratchRoot = request.workingDirectory;
    if (this.faults.toolsRejected) throw new StateMigrationError(this.faults.toolsRejected);
    return this.tools;
  }

  async run(request: {
    executable: StateRegisteredExecutable;
    args: readonly string[];
    cwd: string;
    signal?: AbortSignal;
  }): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }> {
    this.#assertExecutable(request.executable, this.tools.tofu);
    if (request.signal?.aborted) throw new StateMigrationError('cancelled');
    this.commands.push({ args: [...request.args], cwd: request.cwd });
    const outcome = await this.#tofu(request.args, request.cwd);
    const result = {
      exitCode: outcome.exitCode,
      stdout: Buffer.from(outcome.stdout ?? ''),
      stderr: Buffer.from(outcome.stderr ?? '')
    };
    this.outputs.push(result.stdout, result.stderr);
    return result;
  }

  async start(executable: StateRegisteredExecutable, args: readonly string[], cwd: string): Promise<SimulatedNativeProcess> {
    this.#assertExecutable(executable, this.tools.tofu);
    const child = new SimulatedNativeProcess([...args], cwd, this.emitted);
    this.processes.push(child);
    const statePath = flagValue(args, '-state');
    if (!statePath) throw new Error('The simulated host requires an explicit state path.');
    if (args[0] === 'console') {
      this.faults.abortWhenConsoleStarts?.abort();
      this.#background(child, this.#runConsole(child, statePath));
    } else if (args[0] === 'apply') {
      this.#background(child, this.#runPendingApply(child, statePath));
    } else {
      throw new Error(`Unsupported simulated long-running command: ${args[0]}`);
    }
    return child;
  }

  // A stopped process abandons its work like a killed one; any other failure is a fixture defect.
  #background(child: SimulatedNativeProcess, task: Promise<void>): void {
    const tracked = task.catch((error: unknown) => {
      if (!child.finished) this.backgroundFailures.push(error);
    });
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }

  async stop(child: SimulatedNativeProcess): Promise<{ forced: boolean }> {
    this.stoppedProcesses.push(child);
    if (child.finished) return { forced: false };
    child.finish(null, 'SIGTERM');
    await child.release?.();
    return { forced: true };
  }

  async stopWithin(directory: string): Promise<void> {
    this.stoppedDirectories.push(directory);
    for (const child of this.runningProcesses) {
      if (isWithin(directory, child.cwd)) await this.stop(child);
    }
  }

  lockProvider(options: { python: StateRegisteredExecutable }): NativeLocalStateLockProvider {
    this.#assertExecutable(options.python, this.tools.python);
    return {
      capabilities: Object.freeze({
        protocol: 'opentofu-1.12.6-posix-fcntl', existingInPlace: true, createAbsent: false, remove: false
      }),
      acquire: (request) => this.#acquire(request)
    };
  }

  async dispose(): Promise<void> {
    for (const child of this.runningProcesses) await this.stop(child);
    for (const child of this.processes) child.stdin.end();
    await Promise.allSettled([...this.#pending]);
    for (const lease of [...this.leases]) await lease.release();
  }

  async #acquire(request: {
    path: string;
    operationId: string;
    expectedVersion: string | null;
    signal?: AbortSignal;
  }): Promise<SimulatedLease> {
    this.acquisitions.push({ path: request.path, expectedVersion: request.expectedVersion });
    if (request.expectedVersion === null) {
      if (this.faults.absentDenial === 'untyped') throw new Error('simulated helper failure without a state failure code');
      throw new StateMigrationError(this.faults.absentDenial ?? 'unsupported-local-state-operation');
    }
    if (request.signal?.aborted) throw new StateMigrationError('cancelled');
    const before = await lstat(request.path).catch(() => null);
    if (!before) throw new StateMigrationError('unsupported-local-state-operation');
    if (!before.isFile() || before.nlink !== 1 || (process.platform !== 'win32' && (before.mode & 0o077) !== 0)) {
      throw new StateMigrationError('unsafe-path');
    }
    const handle = await open(request.path, 'r+');
    let marker: Buffer | null = null;
    try {
      const key = await inodeKey(handle);
      const ignoreNative = this.faults.holderIgnoresNativeLock === true;
      if (this.#locked(key) && !ignoreNative) {
        if (this.faults.holderDenial === 'untyped') throw new Error('simulated helper failure without a state failure code');
        throw new StateMigrationError(this.faults.holderDenial ?? 'lock-unavailable');
      }
      if (await handleVersion(handle) !== request.expectedVersion) throw new StateMigrationError('stale-state');
      const digest = stateDigest(await readWhole(handle));
      if (!ignoreNative) {
        marker = Buffer.from(JSON.stringify({
          ID: request.operationId, Operation: 'liftoff-state-migration', Version: '1.12.6', Path: request.path
        }));
        const created = await writeFile(lockInfoPath(request.path), marker, { flag: 'wx', mode: 0o600 })
          .then(() => true, () => false);
        if (!created) throw new StateMigrationError('lock-unavailable');
      }
      this.#lock(key, { kind: 'lease', id: request.operationId });
      if (this.faults.acquisitionTouchesState) {
        const moment = new Date(Date.now() + 60_000);
        await handle.utimes(moment, moment);
      }
      const lease = new SimulatedLease(this, request.path, request.operationId, handle, key, marker, digest);
      this.leases.add(lease);
      return lease;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async #tofu(args: readonly string[], cwd: string): Promise<NativeOutcome> {
    switch (args[0]) {
      case 'init': return this.#init(args, cwd);
      case 'apply': return this.#applyFixture(args, cwd);
      case 'state': return this.#stateMove(args);
      case 'plan': return this.#plan(args);
      case 'show': return this.#show(args);
      default: return { exitCode: 1, stderr: `Error: unsupported simulated command ${args[0]}` };
    }
  }

  async #init(_args: readonly string[], cwd: string): Promise<NativeOutcome> {
    const configuration = await readFile(path.join(cwd, 'liftoff.private.tfrc'), 'utf8').catch(() => '');
    const mirror = /filesystem_mirror \{ path = ("[^"]*") \}/.exec(configuration)?.[1];
    const mirrorPath = mirror ? JSON.parse(mirror) as string : undefined;
    const mirrorInfo = mirrorPath ? await lstat(mirrorPath).catch(() => null) : null;
    this.isolatedInitialisations.push(configuration.startsWith('disable_checkpoint = true\n')
      && mirrorPath !== undefined && isWithin(this.scratchRoot ?? cwd, mirrorPath) && mirrorInfo?.isDirectory() === true);
    if (this.faults.failingCommand === 'init') {
      return { exitCode: 1, stdout: 'Initializing the backend...\n', stderr: 'Error: simulated initialisation failure' };
    }
    return { exitCode: 0, stdout: 'OpenTofu has been successfully initialized!\n' };
  }

  async #applyFixture(args: readonly string[], cwd: string): Promise<NativeOutcome> {
    if (!args.includes('-auto-approve') || this.faults.failingCommand === 'apply') {
      return { exitCode: 1, stderr: 'Error: simulated apply failure' };
    }
    const configuration = await readFile(path.join(cwd, 'main.tf'), 'utf8');
    const backend = /backend "local" \{ path = ("[^"]*") \}/.exec(configuration)?.[1];
    if (!backend) return { exitCode: 1, stderr: 'Error: no local backend path' };
    const statePath = JSON.parse(backend) as string;
    const resource = (name: string) => ({
      mode: 'managed', type: 'terraform_data', name, provider: 'provider["terraform.io/builtin/terraform"]',
      instances: [{
        schema_version: 0,
        attributes: { id: randomUUID(), input: { value: 'liftoff-synthetic-native-qualification', type: 'string' }, triggers_replace: null }
      }]
    });
    const state = {
      version: 4, terraform_version: '1.12.6', serial: 1, lineage: randomUUID(), outputs: {},
      resources: this.faults.extraFixtureResource ? [resource('fixture'), resource('unexpected')] : [resource('fixture')],
      check_results: null
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
    return { exitCode: 0, stdout: 'Apply complete! Resources: 1 added, 0 changed, 0 destroyed.\n' };
  }

  async #stateMove(args: readonly string[]): Promise<NativeOutcome> {
    const statePath = flagValue(args, '-state');
    const [from, to] = args.slice(-2);
    if (args[1] !== 'mv' || !statePath || !args.includes('-lock=true') || !args.includes('-lock-timeout=0s')) {
      return { exitCode: 1, stderr: 'Error: the simulated host requires an explicit locked state move' };
    }
    const handle = await open(statePath, 'r+');
    try {
      const key = await inodeKey(handle);
      if (this.#locked(key) && !this.faults.observerIgnoresHolderLock) {
        return this.faults.denialWithoutLockMessage
          ? { exitCode: 1, stderr: 'Error: simulated native failure' }
          : { exitCode: 1, stderr: 'Error: Error acquiring the state lock\n\nresource temporarily unavailable\n' };
      }
      const nativeId = randomUUID();
      const infoPath = lockInfoPath(statePath);
      this.#lock(key, { kind: 'native', id: nativeId });
      // OpenTofu overwrites its lock-info metadata rather than creating it exclusively.
      await writeFile(infoPath, JSON.stringify({ ID: nativeId, Operation: 'OperationTypeInvalid', Version: '1.12.6', Path: statePath }));
      try {
        const state = JSON.parse((await readWhole(handle)).toString('utf8'));
        const resource = state.resources.find((entry: { module?: string; type: string; name: string }) => resourceAddress(entry) === from);
        if (!resource) return { exitCode: 1, stderr: `Error: Invalid source address ${from}` };
        const target = parseAddress(to);
        if (target.module) resource.module = target.module;
        else delete resource.module;
        resource.type = target.type;
        resource.name = target.name;
        state.serial += 1;
        if (from === 'terraform_data.fixture' && to === 'module.moved.terraform_data.fixture') {
          if (this.faults.moveDrift === 'lineage') state.lineage = randomUUID();
          if (this.faults.moveDrift === 'id') resource.instances[0].attributes.id = randomUUID();
          if (this.faults.moveDrift === 'serial') state.serial -= 1;
          if (this.faults.moveDrift === 'address') resource.module = 'module.unexpected';
        }
        await writeInPlace(handle, Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
      } finally {
        this.unlock(key, nativeId);
        await unlink(infoPath).catch(() => undefined);
      }
      return { exitCode: 0, stdout: `Move "${from}" to "${to}"\nSuccessfully moved 1 object(s).\n` };
    } finally {
      await handle.close();
    }
  }

  async #plan(args: readonly string[]): Promise<NativeOutcome> {
    const planPath = flagValue(args, '-out');
    if (!planPath || !args.includes('-detailed-exitcode')) return { exitCode: 1, stderr: 'Error: unsaved plan' };
    await writeFile(planPath, 'simulated-saved-plan', { mode: 0o600 });
    return { exitCode: this.faults.planExitCode ?? 0, stdout: 'No changes. Your infrastructure matches the configuration.\n' };
  }

  async #show(args: readonly string[]): Promise<NativeOutcome> {
    const planPath = args.at(-1);
    if (args[1] !== '-json' || !planPath || await readFile(planPath, 'utf8').catch(() => null) !== 'simulated-saved-plan') {
      return { exitCode: 1, stderr: 'Error: no saved plan' };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        format_version: '1.2', terraform_version: '1.12.6', complete: true, errored: false,
        resource_changes: [{
          address: 'module.moved.terraform_data.fixture', module_address: 'module.moved', mode: 'managed',
          type: 'terraform_data', name: 'fixture', change: { actions: [this.faults.planShowsChange ? 'update' : 'no-op'] }
        }]
      })
    };
  }

  async #runConsole(child: SimulatedNativeProcess, statePath: string): Promise<void> {
    await delay(40);
    if (child.finished) return;
    if (this.faults.consoleExitsBeforeLocking) {
      child.write('stderr', 'Error: simulated console start failure\n');
      child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      child.finish(1);
      return;
    }
    await this.#holdNativeLock(child, statePath, false, async (input) => {
      child.write('stdout', input.trim() === '1 + 1' ? '2\n' : '\n');
      return this.faults.consoleExitCode === undefined ? 0 : this.faults.consoleExitCode;
    });
  }

  async #runPendingApply(child: SimulatedNativeProcess, statePath: string): Promise<void> {
    await delay(40);
    if (child.finished) return;
    // OpenTofu warns on stderr that -state is a legacy option for apply.
    child.write('stderr', 'Warning: The -state option is deprecated.\n');
    await this.#holdNativeLock(child, statePath, true, async (input) => {
      if (this.faults.pendingApplyKilled) {
        // Killed while prompting: delivering the reply then fails with EPIPE.
        child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        return null;
      }
      const approved = input.trim() === 'yes' || this.faults.pendingApplyAccepted === true;
      child.write('stdout', approved ? 'Apply complete!\n' : 'Apply cancelled.\n');
      return approved ? 0 : 1;
    });
  }

  async #holdNativeLock(
    child: SimulatedNativeProcess,
    statePath: string,
    createAbsent: boolean,
    respond: (input: string) => Promise<number | null>
  ): Promise<void> {
    // OpenTofu creates an absent local state file before it locks that new inode.
    const handle = await open(statePath, createAbsent ? 'a+' : 'r');
    const nativeId = randomUUID();
    const infoPath = lockInfoPath(statePath);
    let key: string | null = null;
    let released = false;
    child.release = async () => {
      if (released) return;
      released = true;
      if (key) {
        this.unlock(key, nativeId);
        // OpenTofu removes its lock metadata when it unlocks.
        await unlink(infoPath).catch(() => undefined);
      }
      await handle.close();
    };
    if (child.finished) {
      await child.release();
      return;
    }
    const candidate = await inodeKey(handle);
    if (child.finished) return;
    if (this.#locked(candidate)) {
      await child.release();
      child.write('stderr', 'Error: Error acquiring the state lock\n');
      child.finish(1);
      return;
    }
    key = candidate;
    this.#lock(key, { kind: 'native', id: nativeId });
    // OpenTofu truncates and then writes its lock metadata, so readers can observe it empty.
    await writeFile(infoPath, '');
    await delay(50);
    if (child.finished) return;
    await writeFile(infoPath, JSON.stringify({ ID: nativeId, Operation: 'OperationTypeInvalid', Version: '1.12.6', Path: statePath }));
    if (child.finished) {
      await unlink(infoPath).catch(() => undefined);
      return;
    }
    child.write('stdout', createAbsent ? 'Do you want to perform these actions?\n  Enter a value: ' : '> ');
    const input = await child.readInput();
    if (child.finished) return;
    const code = await respond(input);
    await child.release();
    child.finish(code, code === null ? 'SIGKILL' : null);
  }
}
