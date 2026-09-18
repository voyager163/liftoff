import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  StateMigrationError,
  type LinuxNativeLocalQualificationResult, type NativeLocalQualificationResult,
  type NativeLocalStateTools, type StateRegisteredExecutable
} from '../../domain/repair/stateful.js';
import { assertNoResourceChanges, stateAssert, stateDigest, stateObjectDigest } from '../../domain/repair/stateful-invariants.js';
import {
  inspectLinuxLocalStateTools, inspectNativeLocalStateTools, nativeLocalStateProtocol, nativeStateHostId,
  runPrivateStateProcess, startPrivateStateProcess
} from './native-system.js';
import { DarwinPosixStateLockProvider, LinuxPosixStateLockProvider } from './posix-native-lock.js';
import { linuxPosixStateLockProgram, posixStateLockProgram } from './posix-lock-program.js';
import { stopOwnedStateProcess, stopOwnedStateProcessesIn } from './owned-process.js';

async function localVersion(filename: string): Promise<string> {
  const info = await lstat(filename, { bigint: true });
  return stateObjectDigest({
    dev: String(info.dev), ino: String(info.ino), size: String(info.size),
    mtime: String(info.mtimeNs), ctime: String(info.ctimeNs)
  });
}

async function native(
  executable: StateRegisteredExecutable, cwd: string, args: readonly string[], signal?: AbortSignal, allowed = [0]
): Promise<Uint8Array> {
  const result = await runPrivateStateProcess({ executable, args, cwd, signal, timeoutMs: 30_000, maximumBytes: 4 * 1024 * 1024 });
  result.stderr.fill(0);
  if (!allowed.includes(result.exitCode)) {
    result.stdout.fill(0);
    throw new StateMigrationError('native-command-failed');
  }
  return result.stdout;
}

async function nativeQuiet(executable: StateRegisteredExecutable, cwd: string, args: readonly string[], signal?: AbortSignal): Promise<void> {
  (await native(executable, cwd, args, signal)).fill(0);
}

function oneFixtureState(bytes: Uint8Array): { lineage: string; serial: number; id: string; address: string } {
  const root = JSON.parse(Buffer.from(bytes).toString('utf8'));
  stateAssert(root.version === 4 && typeof root.lineage === 'string' && Number.isSafeInteger(root.serial)
    && root.resources?.length === 1, 'verification-incomplete');
  const resource = root.resources[0];
  stateAssert(resource.mode === 'managed' && resource.type === 'terraform_data' && resource.name === 'fixture'
    && resource.instances?.length === 1 && typeof resource.instances[0].attributes?.id === 'string', 'verification-incomplete');
  return {
    lineage: root.lineage, serial: root.serial, id: resource.instances[0].attributes.id,
    address: `${resource.module ? `${resource.module}.` : ''}terraform_data.fixture`
  };
}

async function waitForNativeConsoleLock(filename: string, exited: () => boolean, signal?: AbortSignal, differentFrom?: string): Promise<void> {
  const end = Date.now() + 10_000;
  while (Date.now() < end && !signal?.aborted && !exited()) {
    const info = await readFile(filename, 'utf8').then((text) => {
      try { return JSON.parse(text) as { ID?: string }; } catch { return null; }
    }, () => null);
    if (typeof info?.ID === 'string' && info.ID.length > 0 && info.ID !== differentFrom) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new StateMigrationError('native-command-failed');
}

const nativeQualifications = new WeakSet<NativeLocalQualificationResult>();
const linuxQualifications = new WeakSet<LinuxNativeLocalQualificationResult>();

export function isActualNativeLocalQualification(
  result: NativeLocalQualificationResult, tools: NativeLocalStateTools
): boolean {
  return nativeQualifications.has(result) && result.hostRef === tools.hostId
    && result.tofuBinaryDigest === tools.tofu.sha256 && result.pythonBinaryDigest === tools.python.sha256;
}

export function isActualLinuxLocalQualification(
  result: LinuxNativeLocalQualificationResult, tools: NativeLocalStateTools
): boolean {
  return process.platform === 'linux' && linuxQualifications.has(result) && result.architecture === process.arch
    && result.hostRef === nativeStateHostId() && result.hostRef === tools.hostId
    && result.tofuBinaryDigest === tools.tofu.sha256 && result.pythonBinaryDigest === tools.python.sha256;
}

interface NativeLocalQualificationRequest {
  pythonPath: string;
  tofuPath: string;
  scratchParent: string;
  signal?: AbortSignal;
}

/**
 * Explicit, opt-in qualification. It creates only a fixed terraform_data
 * fixture in a fresh directory, with no cloud/provider credentials or downloads.
 * This is native/backend qualification, never Azure live-resource evidence.
 */
export async function qualifyNativeLocalState(
  request: NativeLocalQualificationRequest
): Promise<{ tools: NativeLocalStateTools; result: NativeLocalQualificationResult }> {
  const { tools, observation } = await qualifyPosixLocalState(request, 'darwin');
  const result: NativeLocalQualificationResult = Object.freeze({ schemaVersion: 1, platform: 'darwin', ...observation });
  nativeQualifications.add(result);
  return { tools, result };
}

/** Linux lock/tool qualification only; it grants no encrypted custody or producer authority. */
export async function qualifyLinuxLocalState(
  request: NativeLocalQualificationRequest
): Promise<{ tools: NativeLocalStateTools; result: LinuxNativeLocalQualificationResult }> {
  stateAssert(process.platform === 'linux', 'unsupported-native-platform');
  stateAssert(process.arch === 'x64' || process.arch === 'arm64', 'unqualified-combination');
  const { tools, observation } = await qualifyPosixLocalState(request, 'linux');
  const result: LinuxNativeLocalQualificationResult = Object.freeze({
    schemaVersion: 2, platform: 'linux', architecture: process.arch,
    encryptedCustodyQualification: 'not-performed', ...observation
  });
  linuxQualifications.add(result);
  return { tools, result };
}

async function qualifyPosixLocalState(request: NativeLocalQualificationRequest, platform: 'darwin' | 'linux') {
  stateAssert(process.platform === platform, 'unsupported-native-platform');
  const parent = await lstat(request.scratchParent);
  stateAssert(parent.isDirectory() && !parent.isSymbolicLink(), 'unsafe-path');
  const root = path.join(request.scratchParent, `state-native-qualification-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  const statePath = path.join(root, 'fixture.tfstate');
  const marker = path.join(root, '.fixture.tfstate.lock.info');
  const checks: string[] = [];
  let consoleProcess: Awaited<ReturnType<typeof startPrivateStateProcess>> | null = null;
  let currentLease: Awaited<ReturnType<DarwinPosixStateLockProvider['acquire']>> | null = null;
  try {
    const mirror = path.join(root, 'empty-provider-mirror');
    await mkdir(mirror, { mode: 0o700 });
    await writeFile(path.join(root, 'liftoff.private.tfrc'), `disable_checkpoint = true\nprovider_installation {\n filesystem_mirror { path = ${JSON.stringify(mirror)} }\n}\n`, { mode: 0o600 });
    const inspectTools = platform === 'darwin' ? inspectNativeLocalStateTools : inspectLinuxLocalStateTools;
    const tools = await inspectTools({
      pythonPath: request.pythonPath, tofuPath: request.tofuPath, workingDirectory: root, signal: request.signal
    });
    const provider = platform === 'darwin' ? new DarwinPosixStateLockProvider({ python: tools.python })
      : new LinuxPosixStateLockProvider({ python: tools.python });
    checks.push('exact-installed-tofu-1.12.6', 'registered-cpython-3.14', 'verified-pinned-fcntl-source');
    const backend = `terraform {\n backend "local" { path = ${JSON.stringify(statePath)} }\n}\n`;
    const fixture = 'resource "terraform_data" "fixture" {\n input = "liftoff-synthetic-native-qualification"\n}\n';
    await writeFile(path.join(root, 'main.tf'), backend + fixture, { mode: 0o600 });
    await nativeQuiet(tools.tofu, root, ['init', '-input=false', '-no-color', '-get=false'], request.signal);
    // This exact builtin fixture affects only disposable state. It has no
    // external provider, provisioner, program, credentials or cloud resources.
    await nativeQuiet(tools.tofu, root, ['apply', '-input=false', '-no-color', '-auto-approve'], request.signal);
    await chmod(statePath, 0o600);
    const original = await readFile(statePath);
    const before = oneFixtureState(original);
    stateAssert(before.address === 'terraform_data.fixture', 'verification-incomplete');
    const preAcquireVersion = await localVersion(statePath);
    currentLease = await provider.acquire({
      path: statePath, expectedVersion: preAcquireVersion, operationId: randomUUID(), signal: request.signal
    });
    stateAssert(await localVersion(statePath) === preAcquireVersion, 'verification-incomplete');
    checks.push('acquisition-preserves-exact-pre-acquire-metadata');
    // The observer is another process. Closing its fd must not release the
    // Python holder's POSIX process-associated record lock.
    (await readFile(statePath)).fill(0);
    const blocked = await runPrivateStateProcess({
      executable: tools.tofu, cwd: root,
      args: ['state', 'mv', '-lock=true', '-lock-timeout=0s', `-state=${statePath}`, 'terraform_data.fixture', 'terraform_data.unapproved'],
      signal: request.signal
    });
    stateAssert(blocked.exitCode !== 0 && /lock/i.test(Buffer.from(blocked.stderr).toString('utf8')), 'verification-incomplete');
    blocked.stdout.fill(0); blocked.stderr.fill(0);
    stateAssert(stateDigest(await readFile(statePath)) === stateDigest(original), 'verification-incomplete');
    checks.push('native-tofu-blocked-by-fcntl-holder', 'observer-fd-close-preserves-holder-lock');
    await currentLease.release();
    currentLease = null;
    stateAssert(!(await lstat(marker).then(() => true, () => false)), 'verification-incomplete');
    consoleProcess = await startPrivateStateProcess(tools.tofu,
      ['console', '-no-color', '-lock=true', '-lock-timeout=0s', `-state=${statePath}`], root);
    const consoleExit = new Promise<number>((resolve) => consoleProcess!.once('close', (code) => resolve(code ?? 1)));
    consoleProcess.stdout.on('data', (bytes: Buffer) => bytes.fill(0));
    consoleProcess.stderr.on('data', (bytes: Buffer) => bytes.fill(0));
    consoleProcess.stdin.on('error', () => undefined);
    await waitForNativeConsoleLock(marker, () => consoleProcess!.exitCode !== null, request.signal);
    let denied = false;
    try {
      const unexpected = await provider.acquire({
        path: statePath, expectedVersion: await localVersion(statePath), operationId: randomUUID(), signal: request.signal
      });
      await unexpected.release();
    } catch (error) { denied = error instanceof StateMigrationError && error.code === 'lock-unavailable'; }
    stateAssert(denied, 'verification-incomplete');
    consoleProcess.stdin.end('1 + 1\n');
    stateAssert(await consoleExit === 0, 'verification-incomplete');
    consoleProcess = null;
    checks.push('fcntl-holder-blocked-by-native-tofu-console');
    await mkdir(path.join(root, 'moved'), { mode: 0o700 });
    await writeFile(path.join(root, 'moved', 'main.tf'), fixture, { mode: 0o600 });
    await writeFile(path.join(root, 'main.tf'), backend + 'module "moved" {\n source = "./moved"\n}\n', { mode: 0o600 });
    await nativeQuiet(tools.tofu, root, ['init', '-input=false', '-no-color'], request.signal);
    await nativeQuiet(tools.tofu, root, [
      'state', 'mv', '-lock=true', '-lock-timeout=0s', `-state=${statePath}`,
      'terraform_data.fixture', 'module.moved.terraform_data.fixture'
    ], request.signal);
    const moved = await readFile(statePath);
    const after = oneFixtureState(moved);
    stateAssert(after.lineage === before.lineage && after.id === before.id && after.serial > before.serial
      && after.address === 'module.moved.terraform_data.fixture', 'verification-incomplete');
    const savedPlan = path.join(root, 'no-change.tfplan');
    await nativeQuiet(tools.tofu, root, ['plan', '-input=false', '-no-color', '-detailed-exitcode', `-out=${savedPlan}`], request.signal);
    const shown = await native(tools.tofu, root, ['show', '-json', savedPlan], request.signal);
    try { assertNoResourceChanges(JSON.parse(Buffer.from(shown).toString('utf8')), true); }
    finally { shown.fill(0); }
    checks.push('actual-native-module-address-move', 'same-lineage-and-resource-identity', 'actual-native-no-change-plan');
    const publication = path.join(root, 'publication.tfstate');
    await writeFile(publication, original, { mode: 0o600 });
    const inode = (await lstat(publication)).ino;
    const expected = await localVersion(publication);
    currentLease = await provider.acquire({ path: publication, expectedVersion: expected, operationId: randomUUID(), signal: request.signal });
    await currentLease.replace(moved, expected);
    stateAssert((await lstat(publication)).ino === inode && stateDigest(await readFile(publication)) === stateDigest(moved), 'verification-incomplete');
    await currentLease.assertHeld();
    const blockedAfterWrite = await runPrivateStateProcess({
      executable: tools.tofu, cwd: root,
      args: ['state', 'mv', '-lock=true', '-lock-timeout=0s', `-state=${publication}`,
        'module.moved.terraform_data.fixture', 'module.concurrent.terraform_data.fixture'],
      signal: request.signal
    });
    stateAssert(blockedAfterWrite.exitCode !== 0 && /lock/i.test(Buffer.from(blockedAfterWrite.stderr).toString('utf8')), 'verification-incomplete');
    blockedAfterWrite.stdout.fill(0); blockedAfterWrite.stderr.fill(0);
    stateAssert(stateDigest(await readFile(publication)) === stateDigest(moved), 'verification-incomplete');
    checks.push('native-exclusion-survives-in-place-publication');
    let removalRejected = false;
    try { await currentLease.remove(await localVersion(publication)); }
    catch (error) { removalRejected = error instanceof StateMigrationError && error.code === 'unsupported-local-state-operation'; }
    stateAssert(removalRejected, 'verification-incomplete');
    let stale = false;
    try { await currentLease.replace(original, expected); }
    catch (error) { stale = error instanceof StateMigrationError && error.code === 'stale-state'; }
    stateAssert(stale && stateDigest(await readFile(publication)) === stateDigest(moved), 'verification-incomplete');
    await currentLease.release();
    currentLease = null;
    currentLease = await provider.acquire({
      path: publication, expectedVersion: await localVersion(publication), operationId: randomUUID(), signal: request.signal
    });
    const replacement = path.join(root, 'uncoordinated-replacement.tfstate');
    await writeFile(replacement, moved, { mode: 0o600 });
    await rename(replacement, publication);
    // Deliberately demonstrate the unsafe alternative on a disposable file:
    // the native writer CAN lock the new inode while our holder has the old one.
    await nativeQuiet(tools.tofu, root, [
      'state', 'mv', '-lock=true', '-lock-timeout=0s', `-state=${publication}`,
      'module.moved.terraform_data.fixture', 'module.concurrent.terraform_data.fixture'
    ], request.signal);
    const concurrentBytes = await readFile(publication);
    const concurrent = oneFixtureState(concurrentBytes);
    stateAssert(concurrent.address === 'module.concurrent.terraform_data.fixture' && concurrent.id === after.id
      && concurrent.lineage === after.lineage && concurrent.serial > after.serial, 'verification-incomplete');
    let inodeChangeDetected = false;
    try { await currentLease.assertHeld(); }
    catch (error) { inodeChangeDetected = error instanceof StateMigrationError && error.code === 'lock-lost'; }
    stateAssert(inodeChangeDetected && stateDigest(await readFile(publication)) === stateDigest(concurrentBytes), 'verification-incomplete');
    await currentLease.release();
    currentLease = null;
    checks.push('native-writer-can-lock-a-replaced-inode', 'newer-native-write-preserved-after-lock-loss');

    const unlinkRoot = path.join(root, 'unlink-probe');
    await mkdir(unlinkRoot, { mode: 0o700 });
    await writeFile(path.join(unlinkRoot, 'liftoff.private.tfrc'),
      `disable_checkpoint = true\nprovider_installation {\n filesystem_mirror { path = ${JSON.stringify(mirror)} }\n}\n`, { mode: 0o600 });
    await writeFile(path.join(unlinkRoot, 'main.tf'),
      `terraform {\n backend "local" { path = ${JSON.stringify(publication)} }\n}\n${fixture}`, { mode: 0o600 });
    await nativeQuiet(tools.tofu, unlinkRoot, ['init', '-input=false', '-no-color', '-get=false'], request.signal);
    const unlinkOperation = randomUUID();
    const oldInode = (await lstat(publication)).ino;
    currentLease = await provider.acquire({
      path: publication, expectedVersion: await localVersion(publication), operationId: unlinkOperation, signal: request.signal
    });
    await unlink(publication);
    consoleProcess = await startPrivateStateProcess(tools.tofu,
      ['apply', '-input=true', '-no-color', '-lock=true', '-lock-timeout=0s', `-state=${publication}`], unlinkRoot);
    const recreatedExit = new Promise<number>((resolve) => consoleProcess!.once('close', (code) => resolve(code ?? 1)));
    consoleProcess.stdout.on('data', (bytes: Buffer) => bytes.fill(0));
    consoleProcess.stderr.on('data', (bytes: Buffer) => bytes.fill(0));
    consoleProcess.stdin.on('error', () => undefined);
    await waitForNativeConsoleLock(path.join(root, '.publication.tfstate.lock.info'),
      () => consoleProcess!.exitCode !== null, request.signal, unlinkOperation);
    stateAssert((await lstat(publication)).ino !== oldInode, 'verification-incomplete');
    let unlinkDetected = false;
    try { await currentLease.assertHeld(); }
    catch (error) { unlinkDetected = error instanceof StateMigrationError && error.code === 'lock-lost'; }
    stateAssert(unlinkDetected, 'verification-incomplete');
    await currentLease.release();
    currentLease = null;
    // Releasing the old holder must not remove the new native owner's metadata.
    const newOwner = JSON.parse(await readFile(path.join(root, '.publication.tfstate.lock.info'), 'utf8'));
    stateAssert(newOwner.ID && newOwner.ID !== unlinkOperation, 'verification-incomplete');
    // Decline the fixed builtin fixture proposal: observe its native lock,
    // but never approve or execute this proposed resource creation.
    consoleProcess.stdin.end('no\n');
    stateAssert(await recreatedExit !== 0, 'verification-incomplete');
    consoleProcess = null;
    checks.push('native-pending-apply-can-lock-an-unlinked-path', 'new-native-lock-metadata-preserved');
    let absentRejected = false;
    try { await provider.acquire({ path: path.join(root, 'absent.tfstate'), expectedVersion: null, operationId: randomUUID() }); }
    catch (error) { absentRejected = error instanceof StateMigrationError && error.code === 'unsupported-local-state-operation'; }
    stateAssert(absentRejected, 'verification-incomplete');
    stateAssert(!(await lstat(path.join(root, 'absent.tfstate')).then(() => true, () => false)), 'verification-incomplete');
    checks.push('inode-preserving-conditional-publication', 'stale-publication-rejected', 'absent-destination-unsupported',
      'unlink-retirement-unsupported', 'uncoordinated-inode-replacement-detected');
    original.fill(0); moved.fill(0); concurrentBytes.fill(0);
    return {
      tools,
      observation: {
        kind: 'native-local-state-qualification', status: 'verified',
        hostRef: nativeStateHostId(), tofuVersion: '1.12.6', tofuBinaryDigest: tools.tofu.sha256,
        pythonBinaryDigest: tools.python.sha256,
        protocolDigest: stateObjectDigest({
          protocol: nativeLocalStateProtocol,
          helper: stateDigest(platform === 'darwin' ? posixStateLockProgram : linuxPosixStateLockProgram)
        }),
        sourceCommit: nativeLocalStateProtocol.sourceCommit, observedAt: Date.now(), checks: Object.freeze(checks),
        stateScope: 'synthetic-disposable-only', azureLiveQualification: 'not-performed', atomicStateReplacement: false
      } as const
    };
  } finally {
    if (consoleProcess) {
      consoleProcess.stdin.end();
      await stopOwnedStateProcess(consoleProcess);
    }
    await stopOwnedStateProcessesIn(root);
    await currentLease?.release();
    await rm(root, { recursive: true, force: true });
  }
}
