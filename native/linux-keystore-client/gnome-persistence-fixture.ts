import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LinuxReadonlyProcessGuard } from '../../src/adapters/state/linux-readonly-process.js';
import { OwnedPrivateStateProcessRunner } from '../../src/adapters/state/owned-process.js';
import { captureStateExecutable, nativeStateHostId } from '../../src/adapters/state/native-system.js';
import { consumeLinuxKeyClientOutput, type LinuxKeyClientOutcome } from '../../src/adapters/state/linux-keystore-client-protocol.js';
import { inspectControlledGnomeBinary } from '../../src/adapters/state/gnome-persisted-format.js';
import {
  createManagedKeystoreKeyBinding, verifyManagedKeystoreKeyBinding,
  type ManagedKeystoreKeyBinding, type ManagedKeystoreKeyContext
} from '../../src/adapters/state/managed-keystore-key-binding.js';

const directory = path.resolve('native', 'linux-keystore-client');
const sourceCommit = 'da00f9621eaf263d5ed4236df9c22798ea8021d2';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const objectDigest = (value: unknown) => digest(Buffer.from(JSON.stringify(value)));
function requireFixture(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`gnome-source-fixture:${code}`);
}
interface Executable { path: string; sha256: string }
interface Dependency { library: string; sha256: string; stem: string }
interface Software {
  executable: Executable;
  dependencies: Record<string, Dependency>;
  libraryPath: string;
  sourceCommit: string;
}
interface StoreFile {
  device: string; inode: string; birthtime: string; sha256: string;
}
interface Report {
  kind: string;
  blocked: string | null;
  settled: boolean;
  clientExitCode: number | null;
  daemon: { pid: number; sid: number; start: string; owner: string } | null;
  generationChecked: boolean;
  loaderVerified: boolean;
}
interface SnapshotEntry { identity: string; sha256: string | null }
type Tree = Record<string, SnapshotEntry>;
function observationIssue(report: Report | null, client: LinuxKeyClientOutcome | null): string {
  const issue = report?.blocked ?? client?.issue ?? 'missing-native-observation';
  return /^[a-z-]{1,64}$/u.test(issue) ? issue : 'invalid-native-observation';
}
export function gnomeEnrollmentFailureObservation(client: LinuxKeyClientOutcome | null, settled: boolean) {
  const creation = client?.creation ?? 'unknown';
  return Object.freeze({
    schemaVersion: 1, kind: 'observed-gnome-source-enrollment-failure',
    helperStatus: client?.status ?? 'unobserved', creation,
    observedItemPaths: Object.freeze([...(client?.observedItemPaths ?? [])]),
    issue: client?.issue ?? (settled ? 'persisted-observation-failed' : 'process-unsettled'),
    preserveScope: !settled || creation !== 'no-dispatch', readiness: false
  });
}
const stem: Record<string, string> = {
  'libsecret-1': 'libsecret-1.so', 'glib-2.0': 'libglib-2.0.so',
  'gio-2.0': 'libgio-2.0.so', 'gobject-2.0': 'libgobject-2.0.so'
};

async function fileSnapshot(filename: string): Promise<StoreFile> {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true });
    requireFixture(info.isFile() && info.nlink === 1n && info.uid === BigInt(process.getuid!()) &&
      !(info.mode & 0o077n) && info.size <= 1024n * 1024n, 'private-persisted-file');
    const bytes = await handle.readFile();
    try {
      return { device: String(info.dev), inode: String(info.ino), birthtime: String(info.birthtimeNs), sha256: digest(bytes) };
    } finally { bytes.fill(0); }
  } finally { await handle.close(); }
}

async function treeSnapshot(root: string): Promise<Tree> {
  const result: Tree = {};
  async function visit(filename: string) {
    const info = await lstat(filename, { bigint: true });
    requireFixture(!info.isSymbolicLink() && (info.isDirectory() || info.isFile()) &&
      info.uid === BigInt(process.getuid!()) && !(info.mode & 0o077n), 'unexpected-persisted-object');
    const name = path.relative(root, filename) || '.';
    result[name] = {
      identity: [info.dev, info.ino, info.birthtimeNs, info.uid, info.mode, info.nlink, info.mtimeNs, info.ctimeNs].map(String).join(':'),
      sha256: null
    };
    if (info.isDirectory()) {
      for (const child of (await readdir(filename)).sort()) await visit(path.join(filename, child));
    } else result[name]!.sha256 = (await fileSnapshot(filename)).sha256;
  }
  await visit(root);
  return result;
}

async function syncFileAndDirectory(filename: string) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
  const parent = await open(path.dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}

export class GnomePersistenceFixture {
  readonly scope: string;
  readonly store: string;
  readonly filename: string;
  readonly #password: Buffer;
  readonly #runner = new OwnedPrivateStateProcessRunner();
  readonly #guard = new LinuxReadonlyProcessGuard();
  readonly #gnome: Software;
  readonly #client: Software;
  readonly #tools: Record<string, Executable>;
  readonly #python: Executable;
  readonly #node: Executable;
  readonly #enrollment = randomUUID();
  readonly #workspace = randomUUID();
  #original: StoreFile | undefined;
  #tree: Tree | undefined;
  #binding: ManagedKeystoreKeyBinding | undefined;
  #context: ManagedKeystoreKeyContext | undefined;
  #daemon: Report['daemon'];
  #preserve = false;
  #attempt = 0;

  private constructor(value: {
    scope: string; password: Buffer; gnome: Software; client: Software; tools: Record<string, Executable>; python: Executable; node: Executable;
  }) {
    this.scope = value.scope; this.store = path.join(value.scope, 'store');
    this.filename = path.join(this.store, 'data', 'keyrings', 'login.keyring');
    this.#password = value.password; this.#gnome = value.gnome; this.#client = value.client;
    this.#tools = value.tools; this.#python = value.python; this.#node = value.node; this.#daemon = null;
  }

  static async create(): Promise<GnomePersistenceFixture> {
    requireFixture(process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch) &&
      process.env.LIFTOFF_GNOME_PERSISTENCE_TEST === '1', 'explicit-native-authorization-required');
    requireFixture(process.env.LIFTOFF_STATE_PYTHON, 'registered-cpython-314-required');
    const daemon = JSON.parse(await readFile(path.join(directory, 'build', 'gnome-build-identity.json'), 'utf8'));
    const helper = JSON.parse(await readFile(path.join(directory, 'build', 'build-identity.json'), 'utf8'));
    requireFixture(daemon.platform === process.platform && daemon.architecture === process.arch &&
      daemon.sourceCommit === sourceCommit && helper.platform === process.platform && helper.architecture === process.arch &&
      helper.libsecretCommit === 'a5cd57f103038c06b64d5f6ebfd0e627bb40af4e', 'native-build-identity');
    requireFixture(digest(await readFile(path.join(directory, 'gnome-dependencies.json'))) === daemon.fixtureManifestSha256, 'fixture-manifest-identity');
    for (const [filename, sha256] of Object.entries(helper.sources))
      requireFixture(!path.isAbsolute(filename) && !filename.includes('..') &&
        digest(await readFile(path.join(directory, filename))) === sha256, 'helper-source-identity');
    const executable = await captureStateExecutable(path.join(directory, 'build', 'liftoff-linux-keystore-client'));
    requireFixture(executable.sha256 === helper.binarySha256, 'helper-executable-identity');
    const client: Software = {
      executable, sourceCommit: helper.libsecretCommit, libraryPath: helper.contractProbeLibraryPath,
      dependencies: Object.fromEntries(Object.entries(helper.dependencies).map(([name, value]) => [
        name, { ...value as Dependency, stem: stem[name] }
      ]))
    };
    for (const software of [daemon, client]) {
      requireFixture((await captureStateExecutable(software.executable.path)).sha256 === software.executable.sha256, 'registered-executable');
      for (const value of Object.values(software.dependencies) as Dependency[])
        requireFixture(value.stem && await realpath(value.library) === value.library &&
          digest(await readFile(value.library)) === value.sha256, 'primary-library-identity');
    }
    const python = await captureStateExecutable(process.env.LIFTOFF_STATE_PYTHON);
    const node = await captureStateExecutable(process.execPath);
    const parent = path.join(await realpath(process.cwd()), '.cache');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    requireFixture(await realpath(parent) === parent, 'scratch-parent-alias');
    const scope = path.join(parent, `gkr-${randomUUID().slice(0, 8)}`);
    await mkdir(scope, { mode: 0o700 });
    const password = randomBytes(48);
    for (let index = 0; index < password.length; index++) password[index] = 33 + password[index]! % 94;
    const fixture = new GnomePersistenceFixture({ scope, password, gnome: daemon, client, tools: daemon.tools, python, node });
    try {
      for (const parts of [[], ['home'], ['home', '.ssh'], ['data'], ['data', 'keyrings'], ['data', 'keystore'], ['config']])
        await mkdir(path.join(fixture.store, ...parts), { mode: 0o700 });
      return fixture;
    } catch {
      password.fill(0);
      await rm(scope, { recursive: true, force: true });
      throw new Error('gnome-source-fixture:scope-setup');
    }
  }

  async close(): Promise<void> {
    this.#password.fill(0);
    const settled = await Promise.allSettled([this.#runner.quiesce(), this.#guard.quiesce()]);
    if (settled.some((result) => result.status === 'rejected')) this.#preserve = true;
    if (!this.#preserve) await rm(this.scope, { recursive: true, force: true });
    requireFixture(settled.every((result) => result.status === 'fulfilled'), 'cleanup-uncertain');
  }

  async #execute(operation: 'enroll' | 'restart', fault = 'none', selectedPassword = this.#password, cancel = false) {
    const attempt = ++this.#attempt;
    const paths = {
      control: path.join(this.scope, `c${attempt}`), runtime: path.join(this.scope, `r${attempt}`), scratch: path.join(this.scope, `s${attempt}`)
    };
    for (const directory of Object.values(paths)) await mkdir(directory, { mode: 0o700 });
    const config = {
      operation, fault, scope: this.scope, store: this.store, ...paths,
      gnome: this.#gnome, client: this.#client, tools: this.#tools,
      expectedStore: this.#original ?? null,
      project: 'source-test/gnome@local', workspace: this.#workspace, enrollment: this.#enrollment,
      item: this.#context?.itemPath ?? null
    };
    const args = [path.join(directory, 'gnome-coordinator.mjs'), JSON.stringify(config)];
    const controller = new AbortController();
    const task = operation === 'restart' ? this.#guard.run({
      python: this.#python, executable: this.#node, args,
      scopeDirectory: this.scope, storeDirectory: this.store, writableDirectories: paths,
      stdin: selectedPassword, timeoutMs: 15000, maximumBytes: 16384, signal: controller.signal
    }) : this.#runner.run({
      executable: this.#python.path,
      args: ['-I', '-S', '-B', path.join(directory, 'gnome-enrollment-launch.py'), this.#node.path, ...args],
      cwd: paths.scratch,
      environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C', HOME: paths.scratch, TMPDIR: paths.scratch },
      stdin: selectedPassword, timeoutMs: 15000, maximumBytes: 16384, signal: controller.signal
    });
    const outcome = task.then((result) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }));
    if (cancel) {
      const deadline = Date.now() + 7000;
      let ready = false;
      try {
        while (Date.now() < deadline) {
          ready = await readFile(path.join(paths.runtime, 'ready.json'), 'utf8').then((text) => JSON.parse(text).ready === true, () => false);
          if (ready) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally { controller.abort(); }
      const completed = await outcome;
      const code = (completed.error as { code?: string } | undefined)?.code;
      if (code === 'process-tree-termination-unproven') this.#preserve = true;
      requireFixture(ready && ['cancelled', 'process-tree-termination-unproven'].includes(code ?? ''), 'cancellation-outcome');
      return { report: null, client: null, cancellation: code };
    }
    const completed = await outcome;
    if (completed.error) {
      if ((completed.error as { code?: string }).code === 'process-tree-termination-unproven') this.#preserve = true;
      const code = (completed.error as { code?: unknown }).code;
      throw new Error(`gnome-source-fixture:coordinator-failed:${typeof code === 'string' && /^[a-z-]{1,64}$/u.test(code) ? code : 'unclassified'}`);
    }
    const bytes = Buffer.from(completed.result!.stdout.buffer, completed.result!.stdout.byteOffset, completed.result!.stdout.byteLength);
    try {
      requireFixture(bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'GNF1', 'coordinator-frame');
      const metadata = bytes.readUInt32BE(4), payload = bytes.readUInt32BE(8);
      requireFixture(metadata <= 4096 && payload <= 6212 && bytes.length === 12 + metadata + payload, 'coordinator-frame-size');
      let report: Report;
      try { report = JSON.parse(bytes.subarray(12, 12 + metadata).toString()) as Report; }
      catch { throw new Error('gnome-source-fixture:coordinator-metadata'); }
      requireFixture(report.kind === 'actual-gnome-generated-data-source-fixture', 'coordinator-kind');
      if (!report.settled) {
        this.#preserve = true;
        return { report, client: null, cancellation: undefined };
      }
      let client: LinuxKeyClientOutcome | null = null;
      if (payload) {
        requireFixture(report.loaderVerified && Number.isSafeInteger(report.clientExitCode), 'client-observation');
        client = consumeLinuxKeyClientOutput(bytes.subarray(12 + metadata),
          operation === 'enroll' ? { operation: 'create' } : { operation: 'read', item: config.item! },
          { exitCode: report.clientExitCode, processTreeSettled: true });
      }
      return { report, client, cancellation: undefined };
    } finally {
      bytes.fill(0);
      if ('stderr' in completed.result!) completed.result!.stderr.fill(0);
    }
  }

  async enroll(): Promise<void> {
    requireFixture((await readdir(path.dirname(this.filename))).length === 0, 'fresh-keyring-scope');
    let report: Report | null = null;
    let client: LinuxKeyClientOutcome | null = null;
    try {
      ({ report, client } = await this.#execute('enroll'));
      requireFixture(report?.settled && !report.blocked && report.daemon && client?.status === 'completed' &&
        client.key && client.observedItemPaths.length === 1, `enrollment-incomplete:${observationIssue(report, client)}`);
      this.#daemon = report.daemon;
      await syncFileAndDirectory(this.filename);
      const bytes = await readFile(this.filename);
      try {
        const inspected = inspectControlledGnomeBinary(bytes);
        this.#original = await fileSnapshot(this.filename);
        requireFixture(inspected.sha256 === this.#original.sha256, 'persisted-readback');
      } finally { bytes.fill(0); }
      this.#tree = await treeSnapshot(this.store);
      this.#context = {
        projectId: 'source-test/gnome@local', hostRef: nativeStateHostId(), principalUid: process.getuid!(),
        enrollmentId: this.#enrollment, storeId: this.#workspace, itemPath: client.observedItemPaths[0]!,
        daemonDigest: this.#gnome.executable.sha256, helperDigest: this.#client.executable.sha256,
        dependencyInventoryDigest: objectDigest([this.#gnome.dependencies, this.#client.dependencies]),
        persistedGenerationDigest: this.#original.sha256
      };
      this.#binding = await createManagedKeystoreKeyBinding(client.key, this.#context);
      await writeFile(path.join(this.scope, 'encrypted-key-probe.json'), JSON.stringify(this.#binding), { mode: 0o600 });
    } catch (error) {
      const observation = gnomeEnrollmentFailureObservation(client, report?.settled === true);
      this.#preserve ||= observation.preserveScope;
      await writeFile(path.join(this.scope, 'enrollment-observation.json'), JSON.stringify(observation), { mode: 0o600 });
      console.info(JSON.stringify({
        kind: observation.kind, helperStatus: observation.helperStatus, creation: observation.creation,
        observedItemCount: observation.observedItemPaths.length, issue: observation.issue,
        preserveScope: this.#preserve, readiness: false
      }));
      throw error;
    } finally { client?.key?.release(); }
  }

  async restart(changedBinding = false): Promise<void> {
    requireFixture(this.#binding && this.#context && this.#tree && this.#daemon, 'enrollment-required');
    const { report, client } = await this.#execute('restart');
    try {
      requireFixture(report?.settled && report.generationChecked && !report.blocked && report.daemon &&
        report.daemon.pid !== this.#daemon.pid && report.daemon.sid !== this.#daemon.sid &&
        client?.status === 'completed' && client.key, `fresh-restart-incomplete:${observationIssue(report, client)}`);
      requireFixture(JSON.stringify(await treeSnapshot(this.store)) === JSON.stringify(this.#tree), 'persisted-tree-changed');
      const context = changedBinding ? { ...this.#context, projectId: 'different/project' } : this.#context;
      await verifyManagedKeystoreKeyBinding(client.key, this.#binding, context);
    } finally { client?.key?.release(); }
  }

  async negative(kind: 'missing' | 'substituted' | 'wrong-password' | 'cancelled' | 'unknown-settlement') {
    requireFixture(this.#original && this.#tree, 'enrollment-required');
    if (kind === 'missing') await rename(this.filename, path.join(path.dirname(this.filename), 'retained-original'));
    if (kind === 'substituted') {
      const bytes = await readFile(this.filename);
      try {
        const replacement = path.join(path.dirname(this.filename), 'substitute');
        await writeFile(replacement, bytes, { mode: 0o600 });
        await rename(replacement, this.filename);
      } finally { bytes.fill(0); }
    }
    const baseline = await treeSnapshot(this.store);
    const wrong = randomBytes(48);
    for (let i = 0; i < wrong.length; i++) wrong[i] = 33 + wrong[i]! % 94;
    const fault = kind === 'missing' ? 'missing-probe' : kind === 'cancelled' ? 'hold'
      : kind === 'unknown-settlement' ? 'withhold-settlement' : 'none';
    const result = await this.#execute('restart', fault, kind === 'wrong-password' ? wrong : this.#password, kind === 'cancelled')
      .finally(() => wrong.fill(0));
    try {
      requireFixture(JSON.stringify(await treeSnapshot(this.store)) === JSON.stringify(baseline), 'negative-case-mutated-store');
      if (kind === 'missing') {
        requireFixture(!await lstat(this.filename).then(() => true, () => false), 'missing-store-recreated');
        requireFixture(result.report?.settled && result.report.daemon && result.report.loaderVerified &&
          result.client?.status === 'failed' && result.client.key === null, 'missing-store-admitted');
      } else if (kind === 'substituted') {
        requireFixture(result.report?.settled && result.report.blocked === 'store-identity' &&
          result.report.daemon === null && result.client === null, 'substituted-store-admitted');
      } else if (kind === 'wrong-password') {
        requireFixture(result.report?.settled && result.client?.status === 'failed' && result.client.key === null, 'wrong-password-admitted');
      } else if (kind === 'unknown-settlement') {
        requireFixture(result.report?.settled === false && !result.report.blocked && result.report.daemon &&
          result.report.loaderVerified && this.#preserve && result.client === null, 'unknown-settlement-admitted');
      }
      return { sourceCase: kind, unchanged: true, readiness: false, scopePreserved: this.#preserve };
    } finally { result.client?.key?.release(); }
  }
}
