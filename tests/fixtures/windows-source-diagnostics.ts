import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createApplicationEnvironment } from '../../src/application/repair/application-environment.js';
import {
  assertApplicationToolsCurrent, captureInstalledApplicationToolFile, resolveApplicationPreparationTools
} from '../../src/application/repair/application-toolchain.js';
import { canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import { environmentValue } from '../../src/domain/workstation/executables.js';
import { NodeCommandRunner, type CommandResult, type CommandRunner } from '../../src/process-runner.js';

export async function ownedDiagnosticRoot() {
  await mkdir('.cache', { recursive: true });
  const root = await realpath(await mkdtemp(path.resolve('.cache/wfx-')));
  const identity = await lstat(root, { bigint: true });
  const native = new NodeCommandRunner();
  let active = 0, uncertain = false;
  const runner: CommandRunner = {
    async run(command, options) {
      active++;
      try {
        const result = await native.run(command, { ...options, ensureProcessTreeSettled: true });
        uncertain ||= result.processTreeSettled !== true && result.processSpawned !== false;
        return result;
      } catch (error) { uncertain = true; throw error; }
      finally { active--; }
    }
  };
  return {
    root, runner,
    async cleanup() {
      assert.equal(active, 0, 'Retain diagnostic scope: owned work is active');
      assert.equal(uncertain, false, 'Retain diagnostic scope: settlement is uncertain');
      const current = await lstat(root, { bigint: true });
      assert.ok(current.isDirectory() && !current.isSymbolicLink());
      assert.equal(await realpath(root), root);
      assert.equal(current.dev, identity.dev);
      assert.equal(current.ino, identity.ino);
      await rm(root, { recursive: true });
    }
  };
}

function requireSuccess(result: CommandResult) {
  assert.deepEqual({
    status: result.status, timedOut: result.timedOut, settled: result.processTreeSettled,
    spawned: result.processSpawned, signal: result.signal, outputLimit: result.outputLimitExceeded ?? false,
    error: result.errorCode ?? null, aborted: result.aborted ?? false
  }, { status: 0, timedOut: false, settled: true, spawned: true, signal: null, outputLimit: false, error: null, aborted: false });
}

export async function syntheticNpmSourceFixture(owner: Awaited<ReturnType<typeof ownedDiagnosticRoot>>) {
  const { root, runner } = owner;
  const source = path.join(root, 'source'), stage = path.join(root, 'stage'), workspace = path.join(root, 'workspace');
  const prefix = path.join(root, 'prefix'), packs = path.join(root, 'packs');
  for (const directory of [source, stage, workspace, prefix, packs]) await mkdir(directory, { mode: 0o700 });
  const tools = await resolveApplicationPreparationTools(source, stage, [], { env: process.env, runner }, ['node', 'npm']);
  const npm = tools.find((tool) => tool.id === 'npm');
  assert.ok(npm && npm.prefixArgs.length === 1);
  const npmRoot = path.dirname(path.dirname(npm.prefixArgs[0]));
  const requireFromBinLinks = createRequire(path.join(npmRoot, 'node_modules/bin-links/lib/shim-bin.js'));
  const generatorRoot = path.dirname(requireFromBinLinks.resolve('cmd-shim/package.json'));
  assert.ok(generatorRoot.startsWith(`${npmRoot}${path.sep}`), 'Generator must belong to the admitted npm installation');
  const generatorFiles = await Promise.all(['package.json', 'lib/index.js'].map((file) =>
    captureInstalledApplicationToolFile(path.join(generatorRoot, file), source, stage, false)));
  const generator = JSON.parse(await readFile(path.join(generatorRoot, 'package.json'), 'utf8'));
  assert.equal(generator.name, 'cmd-shim');
  assert.match(generator.version, /^\d+\.\d+\.\d+$/u);
  const env = await createApplicationEnvironment(process.env, source, stage, workspace);
  env.npm_config_prefix = prefix;
  await writeFile(path.join(source, 'package.json'), JSON.stringify({
    name: '@msn-control/liftoff', version: '0.12.3', private: true,
    description: 'Synthetic NONSECRET source fixture; not a released baseline or owner-channel qualification.',
    bin: { liftoff: 'cli.js' }, files: ['cli.js'], scripts: {}, dependencies: {}
  }));
  await writeFile(path.join(source, 'cli.js'), '#!/usr/bin/env node\nconsole.log("synthetic-source-fixture");\n');
  const common = ['--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--logs-max=0', '--no-update-notifier'];
  const run = async (args: string[], cwd: string) => {
    await assertApplicationToolsCurrent(source, stage, tools);
    const result = await runner.run({ executable: npm.executablePath, args: [...npm.prefixArgs, ...args, ...common] }, {
      cwd, env, timeoutMs: 15_000, maxOutputBytes: 64 * 1024
    });
    requireSuccess(result);
    await assertApplicationToolsCurrent(source, stage, tools);
    return result.stdout;
  };
  const packed = JSON.parse(await run(['pack', '--json', '--pack-destination', packs], source));
  assert.deepEqual(Object.keys(packed), ['@msn-control/liftoff']);
  const artifact = packed['@msn-control/liftoff'];
  assert.equal(artifact.filename, 'msn-control-liftoff-0.12.3.tgz');
  assert.deepEqual(artifact.files.map((file: { path: string }) => file.path).sort(), ['cli.js', 'package.json']);
  assert.deepEqual(artifact.bundled, []);
  const tarball = path.join(packs, artifact.filename);
  await run(['install', '--global', '--prefix', prefix, '--install-links', tarball], workspace);
  const globalRoot = path.join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules');
  const packageRoot = path.join(globalRoot, '@msn-control', 'liftoff');
  const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(metadata.description, 'Synthetic NONSECRET source fixture; not a released baseline or owner-channel qualification.');
  assert.deepEqual(metadata.dependencies, {});
  assert.deepEqual(metadata.scripts, {});
  assert.equal(await readFile(path.join(packageRoot, 'cli.js'), 'utf8'), await readFile(path.join(source, 'cli.js'), 'utf8'));
  const integrity = `sha512-${createHash('sha512').update(await readFile(tarball)).digest('base64')}`;
  assert.equal(artifact.integrity, integrity);
  let lockBytes: string | null;
  try { lockBytes = await readFile(path.join(globalRoot, '.package-lock.json'), 'utf8'); }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
    lockBytes = null;
  }
  if (lockBytes !== null) {
    const lock = JSON.parse(lockBytes);
    const record = lock.packages['node_modules/@msn-control/liftoff'] ?? lock.packages['@msn-control/liftoff'];
    assert.ok(record && record.version === '0.12.3' && record.link !== true);
    assert.equal(record.integrity, integrity);
    assert.equal(new URL(record.resolved).protocol, 'file:');
  }
  const shimNames = process.platform === 'win32' ? ['liftoff', 'liftoff.cmd', 'liftoff.ps1'] : ['bin/liftoff'];
  const shimDigests: Record<string, string> = {};
  for (const name of shimNames) {
    const file = path.join(prefix, name);
    const details = await lstat(file);
    if (process.platform === 'win32') assert.ok(details.isFile() && !details.isSymbolicLink());
    else assert.ok(details.isSymbolicLink());
    shimDigests[name] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  const after = await Promise.all(['package.json', 'lib/index.js'].map((file) =>
    captureInstalledApplicationToolFile(path.join(generatorRoot, file), source, stage, false)));
  assert.deepEqual(after, generatorFiles);
  return {
    classification: 'synthetic-local-npm-source-fixture-not-owner-qualification',
    platform: process.platform, architecture: process.arch, nodeVersion: process.versions.node, npmVersion: npm.version,
    generator: { name: generator.name, version: generator.version, digest: canonicalSha256({ npm: npm.digest, files: generatorFiles }) },
    shimDigests, inputArtifact: 'local-synthetic-tarball', installedBytesMatch: true, artifactIntegrityMatches: true,
    installedLock: lockBytes === null ? 'absent' : 'present', installedOrigin: lockBytes === null ? null : 'file:',
    ownerAdmission: lockBytes === null ? 'blocked-missing-installed-lock' : 'blocked-local-artifact-origin',
    ownerObserverInvoked: false, blockerSource: 'observer-installed-lock-and-https-origin-contract',
    releasedBaselineQualification: 'not-performed'
  };
}

export interface KernelFileObservation {
  mode: 'managed' | 'kernel'; processId: number; handleValid: boolean;
  volumeSerial: number; fileIndex: string; links: number; size: number;
  finalNameMatchesRequested: boolean; requestedAccess: number; requestedShare: number;
  secondRequestedAccess: number; secondRequestedShare: number; secondFlags: number;
  secondOpenError: number; secondOpenSameFile: boolean | null;
}

export function parseKernelObservation(value: unknown): KernelFileObservation {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  const record = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), [
    'mode', 'processId', 'handleValid', 'volumeSerial', 'fileIndex', 'links', 'size',
    'finalNameMatchesRequested', 'requestedAccess', 'requestedShare', 'secondRequestedAccess',
    'secondRequestedShare', 'secondFlags', 'secondOpenError', 'secondOpenSameFile'
  ].sort());
  assert.ok(record.mode === 'managed' || record.mode === 'kernel');
  const uint = (number: unknown) => {
    assert.ok(typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 && number <= 0xffffffff);
    return number;
  };
  assert.ok(Number(record.processId) > 0);
  assert.equal(record.handleValid, true);
  assert.ok(typeof record.finalNameMatchesRequested === 'boolean');
  assert.equal(record.requestedAccess, 2147483648);
  assert.equal(record.requestedShare, 0);
  assert.equal(record.secondRequestedAccess, 0x120089);
  assert.equal(record.secondRequestedShare, 7);
  assert.equal(record.secondFlags, 0x02000080);
  assert.ok(typeof record.fileIndex === 'string' && /^[1-9]\d{0,19}$/u.test(record.fileIndex) && BigInt(record.fileIndex) <= 0xffffffffffffffffn);
  assert.ok(record.secondOpenSameFile === null || typeof record.secondOpenSameFile === 'boolean');
  assert.ok(record.secondOpenError === 0 ? typeof record.secondOpenSameFile === 'boolean' : record.secondOpenSameFile === null);
  return {
    mode: record.mode, processId: uint(record.processId), handleValid: true,
    volumeSerial: uint(record.volumeSerial), fileIndex: record.fileIndex,
    links: uint(record.links), size: uint(record.size), finalNameMatchesRequested: record.finalNameMatchesRequested,
    requestedAccess: 2147483648, requestedShare: 0, secondOpenError: uint(record.secondOpenError),
    secondRequestedAccess: 0x120089, secondRequestedShare: 7, secondFlags: 0x02000080,
    secondOpenSameFile: record.secondOpenSameFile
  };
}

async function readKernelMarker(file: string) {
  let handle;
  try { handle = await open(file, 'r'); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    assert.ok(before.isFile() && before.size > 0n && before.size <= 2048n);
    const bytes = Buffer.alloc(Number(before.size));
    try {
      const read = await handle.read(bytes, 0, bytes.length, 0);
      assert.equal(read.bytesRead, bytes.length);
      const after = await handle.stat({ bigint: true });
      assert.equal(after.size, before.size);
      assert.equal(after.mtimeNs, before.mtimeNs);
      return parseKernelObservation(JSON.parse(bytes.toString('utf8')));
    } finally { bytes.fill(0); }
  } finally { await handle.close(); }
}

export async function fileSharingSourceProbe(owner: Awaited<ReturnType<typeof ownedDiagnosticRoot>>, mode: 'managed' | 'kernel') {
  assert.equal(process.platform, 'win32', 'Actual Windows required');
  const { root, runner } = owner;
  const file = path.join(root, 'nonsecret-input.txt'), ready = path.join(root, 'ready.json');
  const release = path.join(root, 'release'), done = path.join(root, 'done.json');
  const canary = Buffer.from('NONSECRET_SOURCE_FILE_SHARING_CANARY\n');
  await writeFile(file, canary, { flag: 'wx', mode: 0o600 });
  const expected = await lstat(file, { bigint: true });
  const workspace = path.join(root, 'work'), staging = path.join(root, 'staging');
  await mkdir(workspace); await mkdir(staging);
  const env = await createApplicationEnvironment(process.env, root, staging, workspace);
  Object.assign(env, { LIFTOFF_SOURCE_FILE: file, LIFTOFF_SOURCE_MODE: mode,
    LIFTOFF_SOURCE_READY: ready, LIFTOFF_SOURCE_RELEASE: release, LIFTOFF_SOURCE_DONE: done });
  const systemRoot = environmentValue(process.env, 'SystemRoot', 'win32');
  assert.ok(systemRoot);
  const powershell = path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = path.resolve('tests/fixtures/windows-file-sharing.ps1');
  let finished = false, commandError: unknown;
  const execution = runner.run({ executable: powershell, args: ['-NoProfile', '-NonInteractive', '-File', script] }, {
    cwd: root, env, timeoutMs: 15_000, maxOutputBytes: 16 * 1024
  }).then((result) => { finished = true; return result; }, (error: unknown) => { finished = true; commandError = error; return undefined; });
  let before: KernelFileObservation | null = null;
  let directRead: { errorCode: string | null; bytes: number | null; canaryMatches: boolean | null } | undefined;
  let openedRead: typeof directRead;
  let nodeIdentityMatches: boolean | null = null;
  const safeCode = (error: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    assert.ok(typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code), 'Unclassified Node read failure');
    return code;
  };
  const failures: unknown[] = [];
  let after: KernelFileObservation | null = null;
  try {
    const deadline = performance.now() + 8000;
    while (!(before = await readKernelMarker(ready))) {
      assert.ok(!finished && performance.now() < deadline, 'Native file sharing readiness unavailable');
      await pause(20);
    }
    assert.equal(before.mode, mode);
    assert.equal(before.volumeSerial.toString(), expected.dev.toString());
    assert.equal(before.fileIndex, expected.ino.toString());
    assert.equal(before.links, 1);
    assert.equal(before.size, canary.length);
    assert.equal(before.finalNameMatchesRequested, true);
    try {
      const bytes = await readFile(file);
      try { directRead = { errorCode: null, bytes: bytes.length, canaryMatches: bytes.equals(canary) }; }
      finally { bytes.fill(0); }
    } catch (error) { directRead = { errorCode: safeCode(error), bytes: null, canaryMatches: null }; }
    try {
      const handle = await open(file, 'r');
      try {
        const identity = await handle.stat({ bigint: true });
        nodeIdentityMatches = identity.dev === expected.dev && identity.ino === expected.ino;
        const bytes = Buffer.alloc(canary.length);
        try {
          const read = await handle.read(bytes, 0, bytes.length, 0);
          openedRead = { errorCode: null, bytes: read.bytesRead, canaryMatches: bytes.equals(canary) };
        } finally { bytes.fill(0); }
      } finally { await handle.close(); }
    } catch (error) { openedRead = { errorCode: safeCode(error), bytes: null, canaryMatches: null }; }
  } catch (error) { failures.push(error); }
  finally {
    try { await writeFile(release, 'release\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { failures.push(error); }
    const result = await execution;
    if (commandError) failures.push(commandError);
    try {
      assert.ok(result, 'Native command result unavailable');
      requireSuccess(result);
      after = await readKernelMarker(done);
      assert.ok(before && after);
      assert.deepEqual(after, before);
      const current = await lstat(file, { bigint: true });
      assert.equal(current.dev, expected.dev);
      assert.equal(current.ino, expected.ino);
    } catch (error) { failures.push(error); }
    canary.fill(0);
  }
  if (failures.length) throw new AggregateError(failures, 'Native NONSECRET sharing observation incomplete; no denial inferred');
  assert.ok(before && after && directRead && openedRead);
  if (directRead.errorCode === null) assert.equal(directRead.canaryMatches, true);
  if (openedRead.errorCode === null) { assert.equal(openedRead.canaryMatches, true); assert.equal(nodeIdentityMatches, true); }
  return {
    classification: 'native-nonsecret-file-sharing-observation-not-custody-proof',
    platform: process.platform, architecture: process.arch, before, after, directRead, openedRead, nodeIdentityMatches,
    readDenialObserved: before.secondOpenError === 32 &&
      [directRead.errorCode, openedRead.errorCode].every((code) => code !== null && ['EACCES', 'EPERM', 'EBUSY'].includes(code)),
    settlement: 'proven', baselineUnreadabilityQualification: 'not-performed'
  };
}
