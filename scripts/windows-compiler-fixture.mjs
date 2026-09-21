import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const compilerFixtureControllerDigest = 'c18efc9fd97d39b2cbde8a085138d4dd02e427bfc9b048d77fc71c747017d829';
const stages = ['script-started', 'command-resolution-started', 'command-resolution-ready', 'compile-started', 'compile-ready'];
const trivialDefinition = 'public static class LiftoffCompilerControl { public static int Value() { return 1; } }';
const hash = value => createHash('sha256').update(value).digest('hex');

export function exactControllerDefinition(asset) {
  if (!Buffer.isBuffer(asset) || hash(asset) !== compilerFixtureControllerDigest) throw Error('Compiler fixture controller identity mismatch.');
  const source = asset.toString('utf8');
  const matches = [...source.matchAll(/\$win32TypeDef = @"\n([\s\S]*?)\n"@/g)];
  if (matches.length !== 1 || !matches[0][1].startsWith('using System;\n')) throw Error('Compiler fixture definition is ambiguous.');
  return matches[0][1];
}

export function compilerFixtureSource(kind, binding, definition) {
  if (!['trivial', 'exact'].includes(kind) || !/^[a-f0-9]{64}$/.test(binding) ||
      typeof definition !== 'string' || !definition || definition.length > 32_768 || definition.includes('\n"@')) {
    throw Error('Invalid compiler fixture input.');
  }
  const selected = kind === 'exact' ? definition : trivialDefinition;
  return [
    "$ErrorActionPreference = 'Stop'",
    `function Mark([string]$Stage) { [Console]::WriteLine("LIFTOFF_COMPILE:${binding}:$Stage") }`,
    "Mark 'script-started'", 'try {',
    "    Mark 'command-resolution-started'",
    "    $compiler = Get-Command -Name Add-Type -CommandType Cmdlet -ErrorAction Stop",
    "    if ($compiler.ModuleName -ne 'Microsoft.PowerShell.Utility') { throw 'Unexpected compiler cmdlet.' }",
    "    Mark 'command-resolution-ready'",
    '$win32TypeDef = @"', selected, '"@',
    "    Mark 'compile-started'",
    '    & $compiler -TypeDefinition $win32TypeDef -ErrorAction Stop',
    "    Mark 'compile-ready'", '    exit 0',
    "} catch { Mark 'failed'; exit 2 }", ''
  ].join('\n');
}

export function compilerMarkerDecoder(binding) {
  if (!/^[a-f0-9]{64}$/.test(binding)) throw Error('Invalid compiler marker binding.');
  let pending = '', next = 0, rejected = false, failed = false;
  return {
    feed(chunk) {
      const observed = [];
      for (const character of chunk) {
        if (character === '\n') {
          const line = pending.replace(/\r$/, '');
          if (line === `LIFTOFF_COMPILE:${binding}:failed`) failed = true;
          else if (!failed && next < stages.length && line === `LIFTOFF_COMPILE:${binding}:${stages[next]}`) {
            observed.push(stages[next++]);
          } else rejected = true;
          pending = '';
        } else if (pending.length < 128) pending += character;
        else rejected = true;
      }
      return observed;
    },
    result() { return { complete: next === stages.length && !pending && !rejected && !failed, rejected, failed }; }
  };
}

export async function observeCompilerProcess({ executable, script, repository, env, binding }, launch = spawn) {
  const decoder = compilerMarkerDecoder(binding), events = [], started = performance.now();
  let outputBytes = 0, stderrBytes = 0, termination = 'not-requested', reason = null;
  const observation = await new Promise(resolve => {
    let complete = false, closed = false, exitCode = null, cleanupTimer;
    const child = launch(executable, ['-NoProfile', '-NonInteractive', '-File', script], {
      cwd: repository, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']
    });
    const finish = () => {
      if (complete) return;
      complete = true; clearTimeout(timer); clearTimeout(cleanupTimer);
      resolve({ closed, exitCode, termination, failure: reason, ...decoder.result() });
    };
    const stop = failure => {
      if (reason !== null || complete) return;
      reason = failure;
      cleanupTimer = setTimeout(finish, 5000);
      // Only this still-live, directly spawned child is eligible for tree termination.
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      termination = 'requested';
      const killer = launch(path.join(env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
        env, shell: false, windowsHide: true, stdio: 'ignore', timeout: 5000
      });
      killer.once('error', () => { termination = 'failed'; });
      killer.once('close', code => { termination = code === 0 ? 'completed' : 'failed'; });
    };
    const timer = setTimeout(() => stop('deadline'), 10_000);
    child.stdout?.on('data', chunk => {
      if (complete) return;
      outputBytes += chunk.length;
      if (outputBytes > 4096) { stop('output-limit'); return; }
      for (const phase of decoder.feed(chunk.toString('utf8'))) events.push({ phase, elapsedMs: Math.trunc(performance.now() - started) });
      if (decoder.result().rejected) stop('invalid-marker');
    });
    child.stderr?.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > 65_536) stop('stderr-limit');
    });
    child.once('error', () => { reason = 'spawn-error'; });
    child.once('close', code => { closed = true; exitCode = code; finish(); });
    if (!child.stdout || !child.stderr) stop('missing-stdio');
  });
  return { ...observation, events, outputBytes, stderrBytes };
}

export async function runWindowsCompilerFixture(kind, workspaceParent) {
  if (process.platform !== 'win32' || !['trivial', 'exact'].includes(kind) || !path.isAbsolute(workspaceParent ?? '')) {
    throw Error('An explicit external Windows compiler fixture workspace is required.');
  }
  const { buildWindowsControllerHostEnvironment, resolveWindowsPowerShellPath, verifyWindowsJobControllerAsset } =
    await import('../dist/adapters/process/windows-job-runner.js');
  const asset = await readFile(await verifyWindowsJobControllerAsset()), definition = exactControllerDefinition(asset);
  const env = buildWindowsControllerHostEnvironment();
  const allowed = new Set(['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir', 'SystemDrive', 'COMSPEC', 'ComSpec',
    'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'PSExecutionPolicyPreference']);
  if (Object.keys(env).some(key => !allowed.has(key))) throw Error('Unregistered controller environment field.');
  const parent = await realpath(workspaceParent), repository = await realpath(process.cwd());
  const relative = path.relative(repository, parent);
  if (!relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
    throw Error('Compiler fixture workspace must be external.');
  }
  const root = await mkdtemp(path.join(parent, 'liftoff-compiler-')), rootIdentity = await lstat(root);
  const binding = randomBytes(32).toString('hex'), source = compilerFixtureSource(kind, binding, definition);
  const script = path.join(root, 'compiler-fixture.ps1');
  await writeFile(script, source, { flag: 'wx', mode: 0o600 });
  const scriptIdentity = await lstat(script);
  const executable = resolveWindowsPowerShellPath();
  const executableDigest = hash(await readFile(executable));
  const observation = await observeCompilerProcess({ executable, script, repository, env, binding });
  const { complete: phasesComplete, ...processObservation } = observation;
  let cleanup = 'preserved-unsettled';
  if (observation.closed) {
    const currentRoot = await lstat(root), currentScript = await lstat(script);
    if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || currentRoot.dev !== rootIdentity.dev ||
        currentRoot.ino !== rootIdentity.ino || !currentScript.isFile() || currentScript.isSymbolicLink() ||
        currentScript.dev !== scriptIdentity.dev || currentScript.ino !== scriptIdentity.ino ||
        currentScript.nlink !== 1 || hash(await readFile(script)) !== hash(source)) throw Error('Compiler fixture cleanup identity changed.');
    await unlink(script);
    try { await rmdir(root); cleanup = 'completed'; }
    catch { cleanup = 'failed-owned-directory-not-empty-or-unavailable'; }
  }
  return {
    kind: 'isolated-windows-compiler-diagnostic', probe: kind,
    controllerAssetDigest: compilerFixtureControllerDigest, exactDefinitionDigest: hash(definition),
    compiledDefinitionDigest: hash(kind === 'exact' ? definition : trivialDefinition),
    compiledDefinition: kind === 'exact' ? 'exact-pinned-controller-definition' : 'nonwriting-trivial-control',
    powershellExecutableDigest: executableDigest,
    hostEnvironmentKeys: Object.keys(env).sort(), hostEnvironmentDigest: hash(JSON.stringify(Object.entries(env).sort())),
    inheritedExecutionPolicyPresent: env.PSExecutionPolicyPreference !== undefined,
    ...processObservation, phasesComplete, cleanup,
    compilationComplete: observation.closed && observation.exitCode === 0 && observation.complete && observation.failure === null,
    qualification: 'incomplete-descendant-settlement',
    passed: false,
    rawSourceRecorded: false, rawErrorsRecorded: false, rawEnvironmentRecorded: false,
    descendantSettlementIndependentlyEstablished: false,
    nativeMethodsInvoked: false, productionTimeoutsChanged: false, completeApplicationQualification: false
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw Error('Expected one registered compiler probe.');
    const result = await runWindowsCompilerFixture(process.argv[2], process.env.RUNNER_TEMP);
    console.log(JSON.stringify(result));
    if (!result.passed) process.exitCode = 1;
  } catch {
    console.error('Windows compiler fixture failed; raw compiler/environment diagnostics withheld.');
    process.exitCode = 1;
  }
}
