import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const compilerFixtureControllerDigest = '0dbc52703d58664d586ac21f25d6a44e1207bc7ad6a0fb3ad24ff4d721177a41';
export const compilerFixturePowerShellDigest = 'f1f0ba58b157a1e4509d67f49266be9c94c463636c76d368e375a235cbaeee1d';
export const compilerFixtureHostEnvironmentDigest = '1345cf3f71cbaa7a7083004a003e23c8ad0efc8a810117c87ae18bc662c74581';
const stages = [
  'script-started', 'module-root-verified', 'original-environment-recorded', 'module-scope-verified',
  'effective-environment-recorded', 'command-resolution-started', 'command-discovered', 'command-identity-recorded',
  'command-resolution-ready', 'compile-started', 'compile-ready'
];
const trivialDefinition = 'public static class LiftoffCompilerControl { public static int Value() { return 1; } }';
const childEnvironmentKeys = Object.freeze([
  'COMSPEC', 'ComSpec', 'PATH', 'PATHEXT', 'PSExecutionPolicyPreference', 'PSModulePath', 'Path',
  'SYSTEMROOT', 'SystemDrive', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR', 'windir'
]);
const hash = value => createHash('sha256').update(value).digest('hex');

export function exactControllerDefinition(asset) {
  if (!Buffer.isBuffer(asset) || hash(asset) !== compilerFixtureControllerDigest) throw Error('Compiler fixture controller identity mismatch.');
  const source = asset.toString('utf8');
  const matches = [...source.matchAll(/\$win32TypeDef = @"\n([\s\S]*?)\n"@/g)];
  if (matches.length !== 1 || !matches[0][1].startsWith('using System;\n')) throw Error('Compiler fixture definition is ambiguous.');
  return matches[0][1];
}

export function compilerFixtureSource(kind, binding, definition, { moduleScope, moduleRoot }) {
  if (!['trivial', 'exact'].includes(kind) || !/^[a-f0-9]{64}$/.test(binding) ||
      typeof definition !== 'string' || !definition || definition.length > 32_768 || definition.includes('\n"@') ||
      !['baseline', 'builtin-only'].includes(moduleScope) || typeof moduleRoot !== 'string' ||
      !/^[A-Za-z]:\\/.test(moduleRoot) || /['\0\r\n]/.test(moduleRoot) ||
      path.win32.normalize(moduleRoot) !== moduleRoot || path.win32.basename(moduleRoot) !== 'Modules') {
    throw Error('Invalid compiler fixture input.');
  }
  const selected = kind === 'exact' ? definition : trivialDefinition;
  return [
    "$ErrorActionPreference = 'Stop'",
    `function Mark([string]$Stage) { [Console]::WriteLine("LIFTOFF_COMPILE:${binding}:$Stage") }`,
    `function Mark-Digest([string]$Label, [string]$Digest) {`,
    `    [Console]::WriteLine("LIFTOFF_COMPILE:${binding}:\${Label}a:$($Digest.Substring(0,32))")`,
    `    [Console]::WriteLine("LIFTOFF_COMPILE:${binding}:\${Label}b:$($Digest.Substring(32,32))")`,
    '}',
    'function Hash-Text([string]$Text) {',
    '    $algorithm = [Security.Cryptography.SHA256]::Create()',
    "    try { return [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))).Replace('-','').ToLowerInvariant() }",
    '    finally { $algorithm.Dispose() }',
    '}',
    'function Environment-Identity {',
    `    $keys = [string[]]@(${childEnvironmentKeys.map(key => `'${key}'`).join(',')})`,
    '    $text = [Text.StringBuilder]::new()',
    '    foreach ($key in $keys) {',
    "        $value = [Environment]::GetEnvironmentVariable($key, 'Process')",
    '        [void]$text.Append($key).Append([char]0)',
    "        if ($null -eq $value) { [void]$text.Append('0') } else { [void]$text.Append('1').Append($value) }",
    '        [void]$text.Append([char]0)',
    '    }',
    '    return Hash-Text $text.ToString()',
    '}',
    'function Assert-LocalEntry([string]$Name, [bool]$Directory) {',
    "    if ($Name -notmatch '^[A-Za-z]:\\\\' -or -not [StringComparer]::OrdinalIgnoreCase.Equals($Name, [IO.Path]::GetFullPath($Name))) { throw 'Nonlocal or noncanonical entry.' }",
    '    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($Name))',
    "    if ($drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'Nonlocal drive.' }",
    '    $entry = if ($Directory) { [IO.DirectoryInfo]::new($Name) } else { [IO.FileInfo]::new($Name) }',
    "    if (-not $entry.Exists -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Missing or reparse entry.' }",
    '    $cursor = if ($Directory) { $entry } else { $entry.Directory }',
    '    while ($null -ne $cursor) {',
    "        if (-not $cursor.Exists -or ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reparse ancestor.' }",
    '        $cursor = $cursor.Parent',
    '    }',
    '    return $entry.FullName',
    '}',
    "Mark 'script-started'", 'try {',
    "    if (-not [Environment]::Is64BitProcess) { throw 'Unqualified architecture.' }",
    '    $windows = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)',
    "    $expectedHome = [IO.Path]::Combine($windows, 'System32', 'WindowsPowerShell', 'v1.0')",
    "    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($PSHOME, $expectedHome)) { throw 'Foreign PowerShell home.' }",
    "    $builtin = Assert-LocalEntry ([IO.Path]::Combine($PSHOME, 'Modules')) $true",
    `    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($builtin, '${moduleRoot}')) { throw 'Module root identity mismatch.' }`,
    "    Mark 'module-root-verified'",
    "    Mark-Digest 'o' (Environment-Identity)",
    "    Mark 'original-environment-recorded'",
    ...(moduleScope === 'builtin-only' ? [
      '    $Env:PSModulePath = $builtin',
      "    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($Env:PSModulePath, $builtin)) { throw 'Module scope mismatch.' }"
    ] : []),
    "    Mark 'module-scope-verified'",
    '    $effectiveEnvironment = Environment-Identity',
    "    Mark-Digest 'e' $effectiveEnvironment",
    "    Mark 'effective-environment-recorded'",
    "    Mark 'command-resolution-started'",
    "    $compiler = Get-Command -Name Add-Type -CommandType Cmdlet -ErrorAction Stop",
    "    Mark 'command-discovered'",
    "    $commandDescription = $compiler.Name + [char]0 + $compiler.ModuleName + [char]0 + $compiler.Module.Version.ToString() + [char]0 + $compiler.Module.Path + [char]0 + $compiler.ImplementingType.FullName",
    "    if ($commandDescription.Length -gt 2048) { throw 'Command identity bound.' }",
    "    Mark-Digest 'm' (Hash-Text $commandDescription)",
    "    Mark 'command-identity-recorded'",
    "    if ($compiler.Name -ne 'Add-Type' -or $compiler.ModuleName -ne 'Microsoft.PowerShell.Utility' -or $compiler.ImplementingType.FullName -ne 'Microsoft.PowerShell.Commands.AddTypeCommand') { throw 'Unexpected compiler cmdlet.' }",
    '    $moduleFile = Assert-LocalEntry $compiler.Module.Path $false',
    "    $manifest = [IO.Path]::Combine($builtin, 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')",
    "    $binary = [IO.Path]::Combine($PSHOME, 'Microsoft.PowerShell.Commands.Utility.dll')",
    "    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($moduleFile, $manifest) -and -not [StringComparer]::OrdinalIgnoreCase.Equals($moduleFile, $binary)) { throw 'Unqualified module identity.' }",
    "    if ((Environment-Identity) -ne $effectiveEnvironment) { throw 'Environment drift.' }",
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
  const parts = new Map();
  const metadataStages = { o: 'original-environment-recorded', e: 'effective-environment-recorded', m: 'command-identity-recorded' };
  return {
    feed(chunk) {
      const observed = [];
      for (const character of chunk) {
        if (character === '\n') {
          const line = pending.replace(/\r$/, '');
          const fragment = new RegExp(`^LIFTOFF_COMPILE:${binding}:([oem])([ab]):([a-f0-9]{32})$`).exec(line);
          if (fragment) {
            const [, kind, part, value] = fragment, key = kind + part;
            if (failed || metadataStages[kind] !== stages[next] || parts.has(key) || part === 'b' && !parts.has(kind + 'a')) rejected = true;
            else parts.set(key, value);
          } else if (line === `LIFTOFF_COMPILE:${binding}:failed`) failed = true;
          else if (!failed && next < stages.length && line === `LIFTOFF_COMPILE:${binding}:${stages[next]}`) {
            const metadata = Object.entries(metadataStages).find(([, stage]) => stage === stages[next])?.[0];
            if (metadata && (!parts.has(metadata + 'a') || !parts.has(metadata + 'b'))) rejected = true;
            else observed.push(stages[next++]);
          } else rejected = true;
          pending = '';
        } else if (pending.length < 128) pending += character;
        else rejected = true;
      }
      return observed;
    },
    result() {
      const assembled = kind => parts.has(kind + 'a') && parts.has(kind + 'b') ? parts.get(kind + 'a') + parts.get(kind + 'b') : null;
      return {
        complete: next === stages.length && !pending && !rejected && !failed, rejected, failed,
        originalEnvironmentDigest: assembled('o'), effectiveEnvironmentDigest: assembled('e'),
        resolvedCommandIdentityDigest: assembled('m')
      };
    }
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

export async function runWindowsCompilerFixture(kind, workspaceParent, moduleScope) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !['trivial', 'exact'].includes(kind) ||
      !['baseline', 'builtin-only'].includes(moduleScope) || !path.isAbsolute(workspaceParent ?? '')) {
    throw Error('An explicit external Windows compiler fixture workspace is required.');
  }
  const { buildWindowsControllerHostEnvironment, resolveWindowsPowerShellPath, verifyWindowsJobControllerAsset } =
    await import('../dist/adapters/process/windows-job-runner.js');
  const asset = await readFile(await verifyWindowsJobControllerAsset()), definition = exactControllerDefinition(asset);
  const executable = await realpath(resolveWindowsPowerShellPath()), executableDigest = hash(await readFile(executable));
  const executableIdentity = await lstat(executable);
  if (!executableIdentity.isFile() || executableIdentity.isSymbolicLink()) throw Error('Unsafe PowerShell executable.');
  if (executableDigest !== compilerFixturePowerShellDigest) throw Error('Unqualified PowerShell executable identity.');
  const moduleRoot = path.join(path.dirname(executable), 'Modules'), moduleIdentity = await lstat(moduleRoot);
  if (!moduleIdentity.isDirectory() || moduleIdentity.isSymbolicLink() ||
      !/^[A-Za-z]:\\/.test(moduleRoot) || (await realpath(moduleRoot)).toLowerCase() !== moduleRoot.toLowerCase()) {
    throw Error('Unsafe builtin module root.');
  }
  let ancestor = path.parse(moduleRoot).root;
  for (const part of moduleRoot.slice(ancestor.length).split(path.sep)) {
    ancestor = path.join(ancestor, part);
    const status = await lstat(ancestor);
    if (!status.isDirectory() || status.isSymbolicLink() || (await realpath(ancestor)).toLowerCase() !== ancestor.toLowerCase()) {
      throw Error('Unqualified builtin module ancestor.');
    }
  }
  const env = buildWindowsControllerHostEnvironment();
  const allowed = new Set(['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir', 'SystemDrive', 'COMSPEC', 'ComSpec',
    'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'PSExecutionPolicyPreference']);
  if (Object.keys(env).some(key => !allowed.has(key))) throw Error('Unregistered controller environment field.');
  if (hash(JSON.stringify(Object.entries(env).sort())) !== compilerFixtureHostEnvironmentDigest) {
    throw Error('Original controller host environment differs from the native comparison.');
  }
  const parent = await realpath(workspaceParent), repository = await realpath(process.cwd());
  const relative = path.relative(repository, parent);
  if (!relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
    throw Error('Compiler fixture workspace must be external.');
  }
  const root = await mkdtemp(path.join(parent, 'liftoff-compiler-')), rootIdentity = await lstat(root);
  const binding = randomBytes(32).toString('hex'), source = compilerFixtureSource(kind, binding, definition, { moduleScope, moduleRoot });
  const script = path.join(root, 'compiler-fixture.ps1');
  await writeFile(script, source, { flag: 'wx', mode: 0o600 });
  const scriptIdentity = await lstat(script);
  const observation = await observeCompilerProcess({ executable, script, repository, env, binding });
  const { complete: phasesComplete, ...processObservation } = observation;
  const finalModule = await lstat(moduleRoot), finalExecutable = await lstat(executable);
  if (!finalModule.isDirectory() || finalModule.isSymbolicLink() || finalModule.ino !== moduleIdentity.ino ||
      finalModule.dev !== moduleIdentity.dev || finalExecutable.ino !== executableIdentity.ino ||
      finalExecutable.dev !== executableIdentity.dev || hash(await readFile(executable)) !== executableDigest ||
      (await realpath(moduleRoot)).toLowerCase() !== moduleRoot.toLowerCase()) throw Error('Native fixture runtime identity drift.');
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
    kind: 'isolated-windows-compiler-diagnostic', probe: kind, moduleScope,
    controllerAssetDigest: compilerFixtureControllerDigest, exactDefinitionDigest: hash(definition),
    compiledDefinitionDigest: hash(kind === 'exact' ? definition : trivialDefinition),
    compiledDefinition: kind === 'exact' ? 'exact-pinned-controller-definition' : 'nonwriting-trivial-control',
    powershellExecutableDigest: executableDigest,
    moduleRootDigest: hash(moduleRoot.toLowerCase()),
    childEnvironmentDigestEncoding: 'ordered-allowlisted-key-NUL-presence-value-NUL-utf8-sha256-v1',
    childEnvironmentKeys,
    resolvedCommandIdentityQualified: observation.events.some(event => event.phase === 'command-resolution-ready'),
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
    if (process.argv.length !== 4) throw Error('Expected a registered compiler probe and module scope.');
    const result = await runWindowsCompilerFixture(process.argv[2], process.env.RUNNER_TEMP, process.argv[3]);
    console.log(JSON.stringify(result));
    if (!result.passed) process.exitCode = 1;
  } catch {
    console.error('Windows compiler fixture failed; raw compiler/environment diagnostics withheld.');
    process.exitCode = 1;
  }
}
