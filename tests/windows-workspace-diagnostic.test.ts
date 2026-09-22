import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  buildWindowsControllerHostEnvironment, createWindowsJobDiagnosticRecorder,
  readWindowsJobDiagnosticRecorder, runWindowsJobCommand, type WindowsJobDiagnosticRecorder
} from '../src/adapters/process/windows-job-runner.js';
import { createRepairVerificationWorkspace } from '../src/application/repair/workspaces.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { repairExecutionIdentity } from '../src/domain/repair/identity.js';
import { liftoffVersion } from '../src/version.js';

const nativeEnabled = process.platform === 'win32' && process.env.LIFTOFF_WINDOWS_WORKSPACE_DIAGNOSTIC === '1';
const targetArgs = ['-e', 'process.exit(0)'];
const timeoutMs = 10_000;
const codes = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'ENOTDIR', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  'SUPERVISOR_TIMEOUT', 'UNSUPPORTED_CONTROLLER_RUNTIME', 'UNSUPPORTED_PROCESS_SETTLEMENT',
  'ADMISSION_DENIED', 'JOB_EXECUTION_ERROR', 'CONTROL_PIPE_ERROR', 'CONTROL_PIPE_DISCONNECTED',
  'POWERSHELL_SPAWN_FAILED', 'CONTROLLER_LAUNCH_FAILED', 'owner-uncertain', 'identity-changed',
  'unsafe-path', 'scope-mismatch', 'permission-denied',
  'preview-storage', 'registry-unavailable', 'registry-invalid', 'invalid-request', 'unsupported-record'
]);
function boundedCode(value: unknown): string | null {
  return value === undefined || value === null ? null : typeof value === 'string' && codes.has(value) ? value : 'unclassified-failure';
}
function win32Code(message: string | undefined): number | null {
  const match = /^(?:Root process admission was denied by controller: )?CreateProcessW failed with Win32 error ([0-9]{1,5})\.?$/.exec(message ?? '');
  return match ? Number(match[1]) : null;
}
interface Outcome {
  status: number | null; errorCode: string | null; win32Code: number | null;
  spawned: boolean; rootClosed: boolean; treeSettled: boolean; timedOut: boolean;
}
interface Observation {
  transport: 'direct' | 'controller'; directory: 'short' | 'repair';
  phase: 'root-creation' | 'short-control-creation' | 'root-identities' | 'fixture-directories' | 'workspace-registration'
    | 'executable-inspection' | 'cwd-inspection' | 'registered' | 'launch' | 'result' | 'cleanup' | 'complete';
  rootsCreated: number; workspaceReturned: boolean;
  executable: { digest: string; pathDigest: string; exists: boolean; regular: boolean; reparse: boolean; unchanged: boolean | null } | null;
  environmentDigest: string; commandDigest: string;
  cwd: { length: number; digest: string; exists: boolean; directory: boolean; reparse: boolean } | null;
  result: Outcome | null; failureCode: string | null; causeCode: string | null; ownerCleanupComplete: boolean;
}
let active: { observation: Observation; recorder: WindowsJobDiagnosticRecorder | null } | undefined;

async function workspaceFixture(
  root: string, commandDigest: string, repositoryMarker = true,
  stage: (value: Observation['phase']) => void = () => {}
) {
  stage('fixture-directories');
  const repository = path.join(root, 'repository'), project = path.join(repository, 'Project with spaces');
  const staging = path.join(root, 'patch staging'), home = path.join(root, 'home');
  await Promise.all([
    mkdir(project, { recursive: true, mode: 0o700 }), mkdir(staging, { mode: 0o700 }), mkdir(home, { mode: 0o700 })
  ]);
  if (repositoryMarker) await mkdir(path.join(repository, '.git'), { mode: 0o700 });
  await writeFile(path.join(project, 'liftoff.manifest.json'), '{"diagnosticOnly":true}\n', { flag: 'wx' });
  stage('workspace-registration');
  return createRepairVerificationWorkspace(project, {
    planFingerprint: canonicalSha256('nonwriting-native-workspace-launch'),
    repairIdentity: repairExecutionIdentity(liftoffVersion, 'application-layout-patch'), patchStagingRoot: staging,
    bindings: {
      inputDigest: canonicalSha256('nonwriting-diagnostic-input'), verificationPolicyDigest: commandDigest,
      providerDigest: canonicalSha256(null), toolchainDigest: canonicalSha256(process.execPath)
    },
    approvedScopes: { projectCode: true, dependencyPreparation: false, network: false, lifecycle: false }
  }, { homedir: home, env: { XDG_STATE_HOME: undefined, LOCALAPPDATA: undefined } });
}

async function removeOwnedRoot(root: { name: string; device: bigint; inode: bigint }) {
  const current = await lstat(root.name, { bigint: true });
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== root.device || current.ino !== root.inode) {
    throw new Error('Owned diagnostic root identity changed; cleanup refused.');
  }
  await rm(root.name, { recursive: true });
}
afterEach(() => {
  if (!active) return;
  const value = active;
  active = undefined;
  console.log(JSON.stringify({
    kind: 'native-windows-workspace-launch-diagnostic', ...value.observation, timeoutMs,
    controller: value.recorder ? readWindowsJobDiagnosticRecorder(value.recorder) : null,
    rawPathsRecorded: false, processOutputRecorded: false, environmentValuesRecorded: false,
    completeApplicationQualification: false
  }));
});

function direct(executable: string, cwd: string, env: NodeJS.ProcessEnv): Promise<Outcome> {
  return new Promise(resolve => {
    let spawned = false, callbackSeen = false, closed = false, status: number | null = null;
    let errorCode: string | null = null, timedOut = false;
    const finish = () => {
      if (callbackSeen && closed) resolve({
        status, errorCode, win32Code: null, spawned, rootClosed: true, treeSettled: false, timedOut
      });
    };
    const child = execFile(executable, targetArgs, {
      cwd, env, timeout: timeoutMs, maxBuffer: 1024, windowsHide: true, shell: false
    }, error => {
      callbackSeen = true;
      errorCode = boundedCode(error?.code);
      timedOut = error?.killed === true;
      finish();
    });
    child.once('spawn', () => { spawned = true; });
    child.once('close', code => { status = code; closed = true; finish(); });
  });
}

it('keeps workspace diagnostic projections finite and rejects arbitrary error text', () => {
  expect(boundedCode('ENOENT')).toBe('ENOENT');
  expect(boundedCode('NONFUNCTIONAL_PRIVATE_DIAGNOSTIC')).toBe('unclassified-failure');
  expect(win32Code('CreateProcessW failed with Win32 error 267')).toBe(267);
  expect(win32Code('Root process admission was denied by controller: CreateProcessW failed with Win32 error 267.')).toBe(267);
  expect(win32Code('CreateProcessW failed with Win32 error 267 NONFUNCTIONAL_PRIVATE_DIAGNOSTIC')).toBeNull();
  expect(win32Code('CreateProcessW failed with Win32 error 123456')).toBeNull();
});

it('creates the actual paired fixture outside its nested repository and cleans only released owned scope without commands', async () => {
  const name = path.join(process.cwd(), `.repair-workspaces-fixture-${randomUUID()}`);
  await mkdir(name, { mode: 0o700 });
  await mkdir(path.join(name, '.git'), { mode: 0o700 });
  const identity = await lstat(name, { bigint: true });
  let released = false;
  try {
    const workspace = await workspaceFixture(name, canonicalSha256('no-command-setup-qualification'));
    expect((await lstat(workspace.roles.project)).isDirectory()).toBe(true);
    expect(workspace.roles.project.startsWith(path.join(name, 'home'))).toBe(true);
    await workspace.releaseOwner();
    expect((await workspace.cleanup()).cleanupComplete).toBe(true);
    released = true;
  } finally {
    if (released) await removeOwnedRoot({ name, device: identity.dev, inode: identity.ino });
  }
});

it('preserves the production storage rejection when a diagnostic omits its repository boundary', async () => {
  const name = path.join(process.cwd(), `.repair-workspaces-fixture-${randomUUID()}`);
  await mkdir(name, { mode: 0o700 });
  await mkdir(path.join(name, '.git'), { mode: 0o700 });
  const identity = await lstat(name, { bigint: true });
  let rejectedBeforeAllocation = false;
  try {
    await workspaceFixture(name, canonicalSha256('invalid-no-command-setup'), false);
    throw new Error('Missing repository boundary was not rejected.');
  } catch (error) {
    const cause = error !== null && typeof error === 'object' && 'cause' in error ? error.cause : error;
    rejectedBeforeAllocation = cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'preview-storage';
    expect(rejectedBeforeAllocation).toBe(true);
  } finally {
    if (rejectedBeforeAllocation) await removeOwnedRoot({ name, device: identity.dev, inode: identity.ino });
  }
});

it.runIf(nativeEnabled).each([
  ['direct', 'short'], ['direct', 'repair'], ['controller', 'short'], ['controller', 'repair']
] as const)('compares %s launch in the independently owned %s directory at the unchanged command budget', async (transport, directory) => {
  const host = buildWindowsControllerHostEnvironment();
  const env = { SystemRoot: host.SystemRoot, PATH: path.dirname(process.execPath), TEMP: os.tmpdir(), TMP: os.tmpdir() };
  const observation: Observation = {
    transport, directory, phase: 'root-creation', rootsCreated: 0, workspaceReturned: false,
    executable: null, environmentDigest: canonicalSha256(env),
    commandDigest: canonicalSha256({ executable: process.execPath, args: targetArgs, timeoutMs }),
    cwd: null, result: null, failureCode: null, causeCode: null, ownerCleanupComplete: false
  };
  const recorder = transport === 'controller' ? createWindowsJobDiagnosticRecorder() : null;
  active = { observation, recorder };
  const root = path.join(process.cwd(), `.repair-workspaces-fixture-${randomUUID()}`);
  const roots: { name: string; device: bigint; inode: bigint }[] = [];
  let cleanupAuthorized = false;
  try {
    await mkdir(root, { mode: 0o700 });
    observation.rootsCreated++;
    observation.phase = 'short-control-creation';
    const short = await mkdtemp(path.join(os.tmpdir(), 'lf-wd-'));
    observation.rootsCreated++;
    observation.phase = 'root-identities';
    for (const name of [root, short]) {
      const identity = await lstat(name, { bigint: true });
      roots.push({ name, device: identity.dev, inode: identity.ino });
    }
    const workspace = await workspaceFixture(root, observation.commandDigest, true, phase => { observation.phase = phase; });
    observation.workspaceReturned = true;
    observation.phase = 'executable-inspection';
    const cwd = directory === 'short' ? short : workspace.roles.project;
    const executable = await lstat(process.execPath, { bigint: true });
    if (executable.size < 1n || executable.size > 256n * 1024n * 1024n || !executable.isFile() || executable.isSymbolicLink()) {
      throw new Error('Unqualified diagnostic executable.');
    }
    observation.executable = {
      digest: createHash('sha256').update(await readFile(process.execPath)).digest('hex'),
      pathDigest: canonicalSha256(process.execPath), exists: true, regular: executable.isFile(), reparse: executable.isSymbolicLink(),
      unchanged: null
    };
    const verifyExecutable = async () => {
      const current = await lstat(process.execPath, { bigint: true });
      const unchanged = current.isFile() && !current.isSymbolicLink() &&
        (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const).every(field => current[field] === executable[field]) &&
        createHash('sha256').update(await readFile(process.execPath)).digest('hex') === observation.executable!.digest;
      observation.executable!.unchanged = unchanged;
      if (!unchanged) throw new Error('Diagnostic executable identity drift.');
    };
    await verifyExecutable();
    observation.phase = 'cwd-inspection';
    const target = await lstat(cwd);
    observation.cwd = { length: cwd.length, digest: canonicalSha256(cwd), exists: true, directory: target.isDirectory(), reparse: target.isSymbolicLink() };
    if (!observation.executable.regular || observation.executable.reparse || !observation.cwd.directory || observation.cwd.reparse) {
      throw new Error('Unqualified diagnostic file or directory.');
    }
    observation.phase = 'registered';
    await workspace.runOwned({
      kind: 'verification', commandDigest: observation.commandDigest, network: false, lifecycle: false
    }, async () => {
      observation.phase = 'launch';
      if (transport === 'direct') observation.result = await direct(process.execPath, cwd, env);
      else {
        const value = await runWindowsJobCommand({ executable: process.execPath, args: targetArgs },
          { cwd, env, timeoutMs, maxOutputBytes: 1024 }, { diagnosticRecorder: recorder! });
        observation.result = {
          status: value.status, errorCode: boundedCode(value.errorCode), win32Code: win32Code(value.errorMessage),
          spawned: value.processSpawned === true, rootClosed: value.processTreeSettled === true,
          treeSettled: value.processTreeSettled === true, timedOut: value.timedOut === true
        };
      }
      observation.phase = 'result';
      await verifyExecutable();
      return { value: observation.result, allKnownCommandsSettled: observation.result.treeSettled };
    });
    observation.phase = 'cleanup';
    await workspace.releaseOwner();
    const cleanup = await workspace.cleanup();
    observation.ownerCleanupComplete = cleanup.cleanupComplete;
    if (!cleanup.cleanupComplete) throw new Error('Owned workspace cleanup incomplete.');
    cleanupAuthorized = true;
    observation.phase = 'complete';
    expect(observation.result).toMatchObject({ status: 0, errorCode: null, spawned: true, treeSettled: true, timedOut: false });
  } catch (error) {
    observation.failureCode = boundedCode(error !== null && typeof error === 'object' && 'code' in error ? error.code : 'unclassified-failure');
    const cause = error !== null && typeof error === 'object' && 'cause' in error ? error.cause : null;
    observation.causeCode = boundedCode(cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : null);
    throw new Error('Native workspace launch remains unqualified; bounded observations and uncertain owned resources retained.');
  } finally {
    if (cleanupAuthorized) for (const root of roots) await removeOwnedRoot(root);
  }
}, 15_000);
