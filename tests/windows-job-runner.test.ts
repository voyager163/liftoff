import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationResolvedPreparation } from '../src/application/repair/application-preparation-types.js';
import { environmentValue } from '../src/domain/workstation/executables.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { matrixValidatorEnvironment } from './fixtures/workflow-source5-validator-environment.js';
import {
  buildWindowsControllerHostEnvironment,
  runWindowsJobCommand,
  verifyWindowsJobControllerAsset,
  WindowsJobInteropAssemblyCache,
  windowsJobControllerAssetDigest,
  type WindowsJobRunnerOptions
} from '../src/adapters/process/windows-job-runner.js';
import {
  frameControlMessage,
  unframeControlMessages,
  WindowsJobExecutionSession,
  type WindowsJobControlAck,
  type WindowsJobControlResponse
} from '../src/adapters/process/windows-job-protocol.js';

const tempDirs: string[] = [];
async function mockControllerLauncher(directory: string, script: string): Promise<WindowsJobRunnerOptions> {
  if (process.platform === 'win32') {
    const launcher = path.join(directory, 'mock-launcher.ps1');
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
    await writeFile(launcher, `& ${literal(process.execPath)} ${literal(script)} @args\nexit $LASTEXITCODE\n`);
    return { assetPath: launcher, skipAssetVerification: true };
  }
  const launcher = path.join(directory, 'mock-launcher.sh');
  const literal = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(launcher, `#!/bin/sh\nexec ${literal(process.execPath)} ${literal(script)} "$@"\n`, { mode: 0o755 });
  return { powershellPath: launcher, skipAssetVerification: true };
}

async function timedProtocolController(directory: string,
  mode: 'slow-ready' | 'no-ready' | 'no-ack' | 'no-result' | 'bad-ack' | 'duplicate-ack' | 'late-ack',
  admissionDiagnostics = '') {
  const script = path.join(directory, 'timed-protocol-controller.mjs');
  await writeFile(script, `
import net from 'node:net';
const mode = ${JSON.stringify(mode)};
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const common = { schemaVersion: 1, controllerId: 'liftoff-windows-job-controller-v1',
  workspaceId: arg('-WorkspaceId'), invocationId: arg('-InvocationId'), nonce: arg('-ExpectedNonce') };
const pipe = arg('-ControlPipeName');
const socket = net.connect(process.platform === 'win32' ? ('\\\\\\\\.\\\\pipe\\\\' + pipe) : pipe);
function frame(fields) {
  const bytes = Buffer.from(JSON.stringify({ ...common, ...fields })), header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length); return Buffer.concat([header, bytes]);
}
function send(...messages) {
  socket.write(Buffer.concat(messages.map(frame)));
}
socket.on('error', () => process.exit(0));
socket.on('close', () => process.exit(0));
socket.on('connect', () => {
  if (mode !== 'no-ready') setTimeout(() => send({ kind: 'ready' }), mode === 'slow-ready' ? 5500 : 0);
});
let pending = Buffer.alloc(0);
socket.on('data', chunk => {
  pending = Buffer.concat([pending, chunk]);
  if (pending.length < 4 || pending.length < 4 + pending.readUInt32BE(0)) return;
  const request = JSON.parse(pending.subarray(4, 4 + pending.readUInt32BE(0)).toString());
  if (request.kind !== 'spawn' || request.timeoutMs !== 50) process.exit(2);
  if (mode === 'no-ack') {
    process.stderr.write(${JSON.stringify(admissionDiagnostics)});
    return;
  }
  const ack = { kind: 'ack', sequence: 1, admitted: true };
  const response = { kind: 'response', sequence: 1, phase: 'completed', status: 0,
    signal: null, activeProcesses: 0, jobTerminated: false, settled: true };
  if (mode === 'bad-ack') send({ ...ack, nonce: 'not-the-bound-nonce' }, response);
  else if (mode === 'duplicate-ack') send(ack, ack, response);
  else if (mode === 'late-ack') send(ack, response, ack);
  else {
    send(ack);
    if (mode !== 'no-result') send(response);
  }
});
`);
  return mockControllerLauncher(directory, script);
}

function removeSourceRange(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(0, startIndex) + source.slice(endIndex);
}

function restorePreInteropReuseController(controller: string): string {
  const parameter = [
    '    [Parameter(Mandatory = $true)]',
    '    [string]$InvocationId,',
    '',
    '    [Parameter(Mandatory = $false)]',
    '    [string]$InteropAssemblyPath'
  ].join('\n');
  const originalParameter = [
    '    [Parameter(Mandatory = $true)]',
    '    [string]$InvocationId'
  ].join('\n');
  const branchStart = '    if ([string]::IsNullOrEmpty($InteropAssemblyPath)) {';
  const branchEnd = '} catch {';
  const compile = [
    "    $bootstrapStage = 'compile'",
    '    [Console]::Error.WriteLine("LIFTOFF_CONTROLLER_STAGE: compiling")',
    '    & $compilerCmdlet -TypeDefinition $win32TypeDef -ErrorAction Stop',
    ''
  ].join('\n');
  const restored = controller.replace(parameter, originalParameter);
  return removeSourceRange(restored, branchStart, branchEnd).replace(branchEnd, compile + branchEnd);
}

function restorePreInteropReuseRunner(runner: string): string {
  let restored = runner
    .replace("import { existsSync, readFileSync } from 'node:fs';", "import { existsSync } from 'node:fs';")
    .replace(
      "import { mkdtemp, open, readFile, rm, unlink, writeFile } from 'node:fs/promises';",
      "import { open, readFile, unlink } from 'node:fs/promises';"
    )
    .replace(windowsJobControllerAssetDigest, 'f12e941b5a1d053dd20bfefefdab40af7b0ccd9a380c4032310c51c5fbe53434')
    .replace('const controllerInteropAssemblyMaximumBytes = 1024 * 1024;\n', '');
  restored = removeSourceRange(
    restored,
    'export interface WindowsJobInteropAssemblyIdentity {',
    'export interface WindowsJobRunnerOptions {'
  );
  restored = removeSourceRange(
    restored,
    '  const controllerStartupStarted = performance.now();',
    '  return new Promise<CommandResult>((resolve) => {'
  );
  restored = restored
    .replace("    let interopPublished = interopReservation?.kind !== 'producer';\n", '')
    .replace('    let interopCleanupFailed = false;\n', '')
    .replace([
      "      if (interopReservation?.kind === 'producer' && !interopPublished) {",
      "        interopReservation.fail(new Error('Windows Job interop producer stopped before authenticated readiness.'));",
      '      }',
      ''
    ].join('\n'), '')
    .replace([
      '      if (interopAssemblyDirectory) {',
      '        try {',
      '          await rm(interopAssemblyDirectory, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });',
      '        } catch {',
      '          interopCleanupFailed = true;',
      '        }',
      '        interopAssemblyDirectory = null;',
      '        interopAssemblyPath = null;',
      '      }',
      ''
    ].join('\n'), '')
    .replace('      const cleanupFailed = !stdoutCleaned || !stderrCleaned || interopCleanupFailed;',
      '      const cleanupFailed = !stdoutCleaned || !stderrCleaned;')
    .replace('Failed to clean up temporary execution files.', 'Failed to clean up temporary execution log files.')
    .replace(
      '/LIFTOFF_CONTROLLER_STAGE: (loading-compiler|compiling|loading-interop|connecting|connected)/gu',
      '/LIFTOFF_CONTROLLER_STAGE: (loading-compiler|compiling|connecting|connected)/gu'
    )
    .replace("        const reportedBudgetMs = phase === 'startup' ? controllerStartupTimeoutMs : budgetMs;\n", '')
    .replace('${reportedBudgetMs}ms during ${phase}', '${budgetMs}ms during ${phase}')
    .replace("    armSupervisor(controllerStartupBudgetMs, 'startup');", "    armSupervisor(controllerStartupTimeoutMs, 'startup');");
  restored = removeSourceRange(
    restored,
    "        if (interopReservation?.kind === 'producer' && !interopPublished) {",
    '        try {\n          // Controller is authenticated; send the spawn request now'
  );
  return restored.replace([
    "        invocationId,",
    "        ...(interopAssemblyPath ? ['-InteropAssemblyPath', interopAssemblyPath] : [])"
  ].join('\n'), [
    "        invocationId"
  ].join('\n'));
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('Windows Job interop assembly reuse', () => {
  const identity = {
    controllerAssetDigest: windowsJobControllerAssetDigest,
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  };

  it('publishes authenticated producer bytes to waiting and later consumers without sharing mutable buffers', async () => {
    const cache = new WindowsJobInteropAssemblyCache();
    const producer = await cache.reserve(identity);
    expect(producer.kind).toBe('producer');
    if (producer.kind !== 'producer') throw new Error('Expected the first reservation to produce interop bytes.');

    const waitingConsumer = cache.reserve(identity);
    const original = Buffer.from([0x4d, 0x5a, 0x01, 0x02]);
    producer.publish(original);
    original[2] = 0xff;

    const first = await waitingConsumer;
    expect(first.kind).toBe('consumer');
    if (first.kind !== 'consumer') throw new Error('Expected a waiting interop consumer.');
    expect(first.bytes).toEqual(Buffer.from([0x4d, 0x5a, 0x01, 0x02]));
    first.bytes[3] = 0xff;

    const second = await cache.reserve(identity);
    expect(second.kind).toBe('consumer');
    if (second.kind !== 'consumer') throw new Error('Expected a cached interop consumer.');
    expect(second.bytes).toEqual(Buffer.from([0x4d, 0x5a, 0x01, 0x02]));
    expect(second.bytes).not.toBe(first.bytes);
  });

  it('fails closed on active producer identity changes and starts a fresh producer after failure', async () => {
    const cache = new WindowsJobInteropAssemblyCache();
    const producer = await cache.reserve(identity);
    expect(producer.kind).toBe('producer');
    if (producer.kind !== 'producer') throw new Error('Expected the first reservation to produce interop bytes.');

    await expect(cache.reserve({ ...identity, powershellPath: 'C:\\foreign\\powershell.exe' }))
      .rejects.toThrow('identity changed while the original producer was active');
    const waitingConsumer = cache.reserve(identity);
    producer.fail(new Error('compiler failed'));
    await expect(waitingConsumer).rejects.toThrow('compiler failed');
    await expect(cache.reserve(identity)).resolves.toMatchObject({ kind: 'producer' });
  });

  it('rejects malformed or oversized producer output without retaining it', async () => {
    for (const invalid of [
      Buffer.from('not-a-portable-executable'),
      Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(1024 * 1024)])
    ]) {
      const cache = new WindowsJobInteropAssemblyCache();
      const producer = await cache.reserve(identity);
      if (producer.kind !== 'producer') throw new Error('Expected the first reservation to produce interop bytes.');
      const waitingConsumer = cache.reserve(identity);
      expect(() => producer.publish(invalid)).toThrow('invalid bounded interop assembly');
      await expect(waitingConsumer).rejects.toThrow('invalid bounded interop assembly');
      await expect(cache.reserve(identity)).resolves.toMatchObject({ kind: 'producer' });
    }
  });

  it('requires a new authenticated producer when the verified source identity changes', async () => {
    const cache = new WindowsJobInteropAssemblyCache();
    const producer = await cache.reserve(identity);
    if (producer.kind !== 'producer') throw new Error('Expected the first reservation to produce interop bytes.');
    producer.publish(Buffer.from([0x4d, 0x5a, 0x01]));
    await expect(cache.reserve(identity)).resolves.toMatchObject({ kind: 'consumer' });
    await expect(cache.reserve({ ...identity, controllerAssetDigest: 'changed-source' }))
      .resolves.toMatchObject({ kind: 'producer' });
  });
});

describe('Windows Job Object controller asset integrity and host environment', () => {
  it('verifies the packaged controller asset matches its exact pinned SHA-256 digest', async () => {
    const verifiedPath = await verifyWindowsJobControllerAsset();
    expect(verifiedPath).toContain(path.join('assets', 'repair', 'windows-job-controller.ps1'));
    const bytes = await readFile(verifiedPath);
    const hash = createHash('sha256').update(bytes).digest('hex');
    expect(hash).toBe(windowsJobControllerAssetDigest);
  });

  it('binds the required built-in cmdlets directly without module import or command discovery', async () => {
    const controller = await readFile(await verifyWindowsJobControllerAsset(), 'utf8');
    expect(controller).toContain("$utilityAssemblyName = 'Microsoft.PowerShell.Commands.Utility, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35'");
    expect(controller).toContain('[System.Reflection.Assembly]::Load($utilityAssemblyName)');
    expect(controller).toContain('if ($utilityAssembly.FullName -cne $utilityAssemblyName)');
    expect(controller).not.toMatch(/LoadFrom|LoadWithPartialName|System\.IO\.Path.*Utility/u);
    for (const [command, type, variable] of [
      ['Add-Type', 'AddTypeCommand', 'compilerType'], ['New-Object', 'NewObjectCommand', 'newObjectType'],
      ['ConvertTo-Json', 'ConvertToJsonCommand', 'toJsonType'], ['ConvertFrom-Json', 'ConvertFromJsonCommand', 'fromJsonType'],
      ['Start-Sleep', 'StartSleepCommand', 'sleepType'], ['Write-Error', 'WriteErrorCommand', 'writeErrorType']
    ]) {
      expect(controller).toContain(`$${variable} = $utilityAssembly.GetType('Microsoft.PowerShell.Commands.${type}', $true)`);
      expect(controller).toContain(`[System.Management.Automation.CmdletInfo]::new('${command}', $${variable})`);
    }
    expect(controller).toContain('& $compilerCmdlet -TypeDefinition $win32TypeDef -ErrorAction Stop');
    expect(controller).toContain('& $compilerCmdlet -TypeDefinition $win32TypeDef -OutputAssembly $exactInteropAssemblyPath -OutputType Library -ErrorAction Stop');
    expect(controller).toContain('[System.Reflection.Assembly]::LoadFile($exactInteropAssemblyPath)');
    expect(controller).toContain("if ($nativeType.Assembly.Location -cne $exactInteropAssemblyPath)");
    expect(controller).toContain("throw 'Win32 interop assembly identity does not match the private invocation path.'");
    expect(controller).not.toMatch(/Import-Module|Get-Command|Microsoft\.PowerShell\.Utility\.psd1/u);
    expect(controller).toContain("if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage')");
    expect(controller.indexOf("$ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'"))
      .toBeLessThan(controller.indexOf('[System.Reflection.Assembly]::Load('));
    expect(controller.indexOf("throw 'ConstrainedLanguage mode does not permit Win32 Job API compilation.'"))
      .toBeLessThan(controller.indexOf('[Console]'));
    expect(controller.indexOf('$utilityAssembly.FullName -cne $utilityAssemblyName'))
      .toBeLessThan(controller.indexOf("[System.Management.Automation.CmdletInfo]::new('Add-Type'"));
    const bootstrap = controller.slice(controller.indexOf("$bootstrapStage = 'not-reported'"),
      controller.indexOf('# Connect to the private control pipe'));
    expect([...bootstrap.matchAll(/\$bootstrapStage = '([^']+)'/gu)].map(match => match[1])).toEqual([
      'not-reported', 'assembly-load', 'assembly-identity', 'compiler-type', 'compiler-cmdlet',
      'new-object-type', 'new-object-cmdlet', 'to-json-type', 'to-json-cmdlet',
      'from-json-type', 'from-json-cmdlet', 'sleep-type', 'sleep-cmdlet',
      'write-error-type', 'write-error-cmdlet', 'compile', 'interop-path',
      'compile', 'interop-load', 'interop-identity'
    ]);
    expect(bootstrap).not.toMatch(/\$_|\.Exception|\.Message/u);
  });

  it('keeps interop reuse source-bound, private, bounded and unavailable to custom controller overrides', async () => {
    const controller = await readFile(await verifyWindowsJobControllerAsset(), 'utf8');
    const runner = await readFile(path.join(process.cwd(), 'src/adapters/process/windows-job-runner.ts'), 'utf8');
    expect(controller).toContain('[string]$InteropAssemblyPath');
    expect(controller).toContain('[System.IO.Path]::IsPathRooted($InteropAssemblyPath)');
    expect(controller).toContain('[System.IO.Path]::GetFullPath($InteropAssemblyPath)');
    expect(controller).toContain('[System.IO.File]::Exists($exactInteropAssemblyPath)');
    expect(controller.indexOf('[System.Reflection.Assembly]::LoadFile($exactInteropAssemblyPath)'))
      .toBeLessThan(controller.indexOf('# Connect to the private control pipe'));
    expect(controller.indexOf("$interopAssembly.GetType('Win32JobNative', $true)"))
      .toBeLessThan(controller.indexOf('# Connect to the private control pipe'));
    expect(controller.indexOf('$nativeType.Assembly.Location -cne $exactInteropAssemblyPath'))
      .toBeLessThan(controller.indexOf('# Connect to the private control pipe'));
    expect(runner).toContain('bytes[0] !== 0x4d || bytes[1] !== 0x5a');
    expect(runner).toContain("path.join(tmpdir(), 'liftoff-job-interop-')");
    expect(runner).toContain("path.join(interopAssemblyDirectory, 'Win32JobNative.dll')");
    expect(runner).toContain("writeFile(interopAssemblyPath, interopReservation.bytes, { flag: 'wx', mode: 0o600 })");
    expect(runner).toContain('controllerAssetDigest: windowsJobControllerAssetDigest');
    expect(runner).toContain('powershellPath');
    expect(runner).toContain("process.platform === 'win32' &&");
    expect(runner).toContain('!runnerOptions.assetPath &&');
    expect(runner).toContain('!runnerOptions.powershellPath &&');
    expect(runner).toContain('!runnerOptions.skipAssetVerification');
    expect(runner).not.toMatch(/options\.(?:env|cwd).*InteropAssembly/gu);
  });

  it('limits private admission emissions and failure capture to the same finite literal enum', async () => {
    const controller = await readFile(await verifyWindowsJobControllerAsset(), 'utf8');
    const runner = await readFile(path.join(process.cwd(), 'src/adapters/process/windows-job-runner.ts'), 'utf8');
    const assertion = await readFile(path.join(process.cwd(), 'tests/repair-application.test.ts'), 'utf8');
    const stages = [
      'frame-header-read', 'frame-payload-read', 'frame-json', 'frame-returned',
      'environment-decode', 'environment-digest', 'environment-allocate', 'environment-verified',
      'job-create', 'job-configure', 'job-configured', 'stdio-open', 'stdio-configured',
      'attributes-initialize', 'attributes-job', 'attributes-handles', 'attributes-configured',
      'startup-info', 'executable-check', 'launch-enter', 'create-process', 'create-process-returned',
      'job-membership', 'job-membership-verified', 'resume-thread', 'resume-thread-returned', 'launch-returned',
      'ack-write', 'ack-written'
    ];
    const emissions = [...controller.matchAll(/^ +(?:\[Console\]::Error|Console\.Error)\.WriteLine\("LIFTOFF_CONTROLLER_ADMISSION: ([a-z-]+)"\);?$/gmu)];
    expect(new Set(emissions.map(match => match[1]))).toEqual(new Set(stages));
    expect(emissions).toHaveLength(stages.length + 1);
    expect(controller.match(/LIFTOFF_CONTROLLER_ADMISSION:/gu)).toHaveLength(emissions.length);
    for (const [source, name] of [[runner, 'controllerAdmissionStages'], [assertion, 'admissionStages']] as const) {
      const declaration = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`, 'u').exec(source)?.[1] ?? '';
      expect([...declaration.matchAll(/'([^']+)'/gu)].map(match => match[1])).toEqual(stages);
    }
  });

  it('restores exact pre-diagnostic C#, control, containment and supervisor bytes by removing only approved diagnostics', async () => {
    const controller = restorePreInteropReuseController(
      await readFile(await verifyWindowsJobControllerAsset(), 'utf8')
    );
    const ackHelper = [
      'function Write-AckAdmissionDiagnostic($frame, [bool]$completed) {',
      "    if ($frame.kind -eq 'ack') {",
      '        if ($completed) {',
      '            [Console]::Error.WriteLine("LIFTOFF_CONTROLLER_ADMISSION: ack-written")',
      '        } else {',
      '            [Console]::Error.WriteLine("LIFTOFF_CONTROLLER_ADMISSION: ack-write")',
      '        }',
      '    }',
      '}', '', ''
    ].join('\n');
    expect(controller).toContain(ackHelper);
    const originalController = controller.replace(ackHelper, '')
      .replace(/^ +(?:\[Console\]::Error|Console\.Error)\.WriteLine\("LIFTOFF_CONTROLLER_ADMISSION: [a-z-]+"\);?\n/gmu, '')
      .replace(/^ +Write-AckAdmissionDiagnostic \$obj \$(?:false|true)\n/gmu, '');
    expect(createHash('sha256').update(originalController).digest('hex'))
      .toBe('e6874bc3f9af08aa2655f1a52115e50f2cce99da695533c723c790b25fd21b5d');
    const runner = restorePreInteropReuseRunner(
      await readFile(path.join(process.cwd(), 'src/adapters/process/windows-job-runner.ts'), 'utf8')
    );
    const originalRunner = runner
      .replace('f12e941b5a1d053dd20bfefefdab40af7b0ccd9a380c4032310c51c5fbe53434',
        'e6874bc3f9af08aa2655f1a52115e50f2cce99da695533c723c790b25fd21b5d')
      .replace(/^const controllerAdmissionStages = \[\n(?: .*\n)+\] as const;\n/mu, '')
      .replace(/^ +const controllerAdmission(?:Candidate|Stage) = .+\n/gmu, '')
      .replace(', admission=${controllerAdmissionStage}', '');
    expect(createHash('sha256').update(originalRunner).digest('hex'))
      .toBe('09d043c32c3db5d133beb767ed1c63557377178b93c99a8923954cd2712ddd2d');
  });

  it('restores exact pre-reuse controller and runner bytes by removing only the bounded interop cache change', async () => {
    const controller = restorePreInteropReuseController(
      await readFile(await verifyWindowsJobControllerAsset(), 'utf8')
    );
    expect(createHash('sha256').update(controller).digest('hex'))
      .toBe('f12e941b5a1d053dd20bfefefdab40af7b0ccd9a380c4032310c51c5fbe53434');
    const runner = restorePreInteropReuseRunner(
      await readFile(path.join(process.cwd(), 'src/adapters/process/windows-job-runner.ts'), 'utf8')
    );
    expect(createHash('sha256').update(runner).digest('hex'))
      .toBe('bad89b5daddaff2f7c93290bc5567f805ad8c501312e7e5e40c7c2c0d82132bc');
  });

  it('places fixed stages around admission boundaries without preceding native error capture or weakening policy denial', async () => {
    const controller = await readFile(await verifyWindowsJobControllerAsset(), 'utf8');
    const frameReader = controller.slice(controller.indexOf('function Read-ControlFrame'), controller.indexOf('$hJob = [IntPtr]::Zero'));
    for (const [stage, operation] of [
      ['frame-header-read', '$stream.Read($header'], ['frame-payload-read', '$stream.Read($payload'],
      ['frame-json', 'return $json | & $fromJsonCmdlet']
    ]) {
      expect(frameReader.indexOf(`LIFTOFF_CONTROLLER_ADMISSION: ${stage}"`)).toBeLessThan(frameReader.indexOf(operation));
    }
    const body = controller.slice(controller.indexOf('# Read the spawn request'), controller.indexOf('# Begin asynchronous read'));
    const psStages = [
      'frame-returned', 'environment-decode', 'environment-digest', 'environment-allocate', 'environment-verified',
      'job-create', 'job-configure', 'job-configured', 'stdio-open', 'stdio-configured',
      'attributes-initialize', 'attributes-job', 'attributes-handles', 'attributes-configured',
      'startup-info', 'executable-check', 'launch-enter', 'launch-returned'
    ];
    expect([...body.matchAll(/LIFTOFF_CONTROLLER_ADMISSION: ([a-z-]+)"/gu)].map(match => match[1])).toEqual(psStages);
    const createFailure = controller.slice(controller.indexOf('if (!created)'), controller.indexOf('bool inJob = false'));
    expect(createFailure.indexOf('Marshal.GetLastWin32Error()'))
      .toBeLessThan(createFailure.indexOf('LIFTOFF_CONTROLLER_ADMISSION: create-process-returned'));
    for (const [stage, operation] of [
      ['create-process', 'bool created = CreateProcess('], ['job-membership', 'if (!IsProcessInJob('],
      ['resume-thread', 'ResumeThread(pi.hThread);']
    ]) {
      expect(controller.indexOf(`LIFTOFF_CONTROLLER_ADMISSION: ${stage}"`)).toBeLessThan(controller.indexOf(operation));
    }
    const send = controller.slice(controller.indexOf('function Send-ControlFrame'), controller.indexOf('function Read-ControlFrame'));
    expect(send.indexOf('Write-AckAdmissionDiagnostic $obj $false')).toBeLessThan(send.indexOf('$obj | & $toJsonCmdlet'));
    expect(send.indexOf('Write-AckAdmissionDiagnostic $obj $true')).toBeGreaterThan(send.indexOf('$stream.Flush()'));
    expect(controller.indexOf("throw 'ConstrainedLanguage mode does not permit Win32 Job API compilation.'"))
      .toBeLessThan(controller.indexOf('LIFTOFF_CONTROLLER_ADMISSION:'));
  });

  it('rejects a corrupted controller asset before launching any process', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'liftoff-bad-asset-'));
    tempDirs.push(tempDir);
    const corruptedPath = path.join(tempDir, 'corrupted-controller.ps1');
    await writeFile(corruptedPath, '# corrupted controller content\n');

    await expect(verifyWindowsJobControllerAsset(corruptedPath)).rejects.toThrow(
      /controller asset integrity failure/
    );

    const result = await runWindowsJobCommand(
      { executable: process.execPath, args: ['--test'] },
      {},
      { assetPath: corruptedPath }
    );
    expect(result.processTreeSettled).toBe(false);
    expect(result.processSpawned).toBe(false);
    expect(result.errorCode).toBe('CORRUPTED_CONTROLLER_ASSET');
  });

  it('builds a clean controller host environment preserving inherited PSExecutionPolicyPreference without target env', () => {
    const originalPolicy = process.env.PSExecutionPolicyPreference;
    try {
      process.env.PSExecutionPolicyPreference = 'Restricted';
      const hostEnv = buildWindowsControllerHostEnvironment();
      expect(hostEnv.PSExecutionPolicyPreference).toBe('Restricted');
      expect(hostEnv.SystemRoot).toBeDefined();
      expect(hostEnv.PATH).toBeDefined();
      // Ensure arbitrary caller/target environment keys are NOT inherited
      expect(hostEnv.UNTRUSTED_TARGET_ENV_VAR).toBeUndefined();
    } finally {
      if (originalPolicy !== undefined) {
        process.env.PSExecutionPolicyPreference = originalPolicy;
      } else {
        delete process.env.PSExecutionPolicyPreference;
      }
    }
  });

});

describe('Windows Job Runner protocol execution and policy admission blockers', () => {
  it('keeps a short target deadline separate from slow authenticated controller startup', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'liftoff-controller-clock-'));
    tempDirs.push(directory);
    const result = await runWindowsJobCommand({ executable: process.execPath, args: ['--test'] }, { timeoutMs: 50 },
      await timedProtocolController(directory, 'slow-ready'));
    expect(result, JSON.stringify({ errorCode: result.errorCode, errorMessage: result.errorMessage }))
      .toMatchObject({ status: 0, timedOut: false, processSpawned: true, processTreeSettled: true });
  });

  it.each([
    { mode: 'no-ready', diagnostic: 'absent', stderr: '', admissionStage: 'not-reported', controllerStage: 'not-reported' },
    { mode: 'no-ack', diagnostic: 'last closed enum', stderr: 'LIFTOFF_CONTROLLER_STAGE: loading-interop\r\nLIFTOFF_CONTROLLER_ADMISSION: frame-header-read\r\nLIFTOFF_CONTROLLER_ADMISSION: frame-json\r\n', admissionStage: 'frame-json', controllerStage: 'loading-interop' },
    { mode: 'no-ack', diagnostic: 'unknown enum', stderr: 'LIFTOFF_CONTROLLER_ADMISSION: PRIVATE_ENV_VALUE_PATH_ARG\n', admissionStage: 'not-reported', controllerStage: 'not-reported' },
    { mode: 'no-ack', diagnostic: 'forged suffix after a valid enum', stderr: 'LIFTOFF_CONTROLLER_ADMISSION: frame-json\nLIFTOFF_CONTROLLER_ADMISSION: ack-written PRIVATE_ENV_VALUE_PATH_ARG\n', admissionStage: 'not-reported', controllerStage: 'not-reported' },
    { mode: 'no-ack', diagnostic: 'forged prefix', stderr: 'PRIVATE_ENV_VALUE_PATH_ARG LIFTOFF_CONTROLLER_ADMISSION: ack-written\n', admissionStage: 'not-reported', controllerStage: 'not-reported' }
  ] as const)('retains a finite startup deadline with $mode/$diagnostic rather than granting execution time or disclosing stderr', async ({ mode, stderr, admissionStage, controllerStage }) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'liftoff-controller-startup-'));
    tempDirs.push(directory);
    const result = await runWindowsJobCommand({ executable: process.execPath, args: ['--test'] }, { timeoutMs: 50 },
      await timedProtocolController(directory, mode, stderr));
    expect(result).toMatchObject({ status: null, timedOut: true, processSpawned: mode === 'no-ack',
      processTreeSettled: false, errorCode: 'SUPERVISOR_TIMEOUT' });
    expect(result.errorMessage).toContain('exceeded 15000ms during startup');
    expect(result.errorMessage).toContain(`controller=${controllerStage},`);
    expect(result.errorMessage).toContain(`admission=${admissionStage},`);
    expect(result.errorMessage).not.toContain('PRIVATE_ENV_VALUE_PATH_ARG');
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('keeps the target deadline and existing settlement grace finite after a valid acknowledgement', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'liftoff-controller-execution-'));
    tempDirs.push(directory);
    const result = await runWindowsJobCommand({ executable: process.execPath, args: ['--test'] }, { timeoutMs: 50 },
      await timedProtocolController(directory, 'no-result'));
    expect(result).toMatchObject({ status: null, timedOut: true, processSpawned: true,
      processTreeSettled: false, errorCode: 'SUPERVISOR_TIMEOUT' });
    expect(result.errorMessage).toContain('exceeded 5050ms during execution');
  });

  it.each(['bad-ack', 'duplicate-ack'] as const)('rejects %s instead of extending the execution deadline or accepting later success', async mode => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'liftoff-controller-ack-'));
    tempDirs.push(directory);
    const result = await runWindowsJobCommand({ executable: process.execPath, args: ['--test'] }, { timeoutMs: 50 },
      await timedProtocolController(directory, mode));
    expect(result).toMatchObject({ status: null, timedOut: false, processSpawned: true,
      processTreeSettled: false, errorCode: 'INVALID_CONTROL_RESPONSE' });
  });

  it('ignores an acknowledgement queued after terminal settlement rather than reentering admission', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'liftoff-controller-late-ack-'));
    tempDirs.push(directory);
    const acknowledged = vi.spyOn(WindowsJobExecutionSession.prototype, 'onRootStartAcknowledged');
    const result = await runWindowsJobCommand({ executable: process.execPath, args: ['--test'] }, { timeoutMs: 50 },
      await timedProtocolController(directory, 'late-ack'));
    expect(result).toMatchObject({ status: 0, timedOut: false, processSpawned: true, processTreeSettled: true });
    expect(acknowledged).toHaveBeenCalledTimes(1);
  });

  it('detects Restricted execution policy from PowerShell exit and fails closed before target execution', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'liftoff-ps-policy-'));
    tempDirs.push(tempDir);

    const mockPs = path.join(tempDir, 'mock-powershell.mjs');
    await writeFile(
      mockPs,
      `process.stderr.write("The controller cannot be loaded because running scripts is disabled on this system. See about_Execution_Policies.\\n");\nprocess.exitCode = 1;\n`
    );

    const result = await runWindowsJobCommand(
      { executable: process.execPath, args: ['--test'] },
      {},
      await mockControllerLauncher(tempDir, mockPs)
    );

    expect(result.processTreeSettled).toBe(false);
    expect(result.processSpawned).toBe(false);
    expect(result.errorCode).toBe('RESTRICTED_EXECUTION_POLICY');
    expect(result.errorMessage).toContain('Windows PowerShell execution policy');
  });

  it('detects ConstrainedLanguage / AppLocker from PowerShell exit and fails closed before target execution', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'liftoff-ps-lang-'));
    tempDirs.push(tempDir);

    const mockPs = path.join(tempDir, 'mock-powershell-lang.mjs');
    await writeFile(
      mockPs,
      `process.stderr.write("Cannot add type. Definition of new types is not supported in this language mode (ConstrainedLanguage / AppLocker).\\n");\nprocess.exitCode = 1;\n`
    );

    const result = await runWindowsJobCommand(
      { executable: process.execPath, args: ['--test'] },
      {},
      await mockControllerLauncher(tempDir, mockPs)
    );

    expect(result.processTreeSettled).toBe(false);
    expect(result.processSpawned).toBe(false);
    expect(result.errorCode).toBe('CONSTRAINED_LANGUAGE_MODE');
    expect(result.errorMessage).toContain('ConstrainedLanguage mode or restricted by AppLocker/WDAC');
  });

  it.each(['missing-assembly', 'unexpected-identity', 'missing-type', 'constrained-language'] as const)(
    'fails closed before target dispatch for compiler bootstrap %s', async (mode) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'liftoff-controller-bootstrap-'));
    tempDirs.push(directory);
    let launcher: WindowsJobRunnerOptions;
    if (process.platform === 'win32') {
      const controller = await readFile(await verifyWindowsJobControllerAsset(), 'utf8');
      const assetPath = path.join(directory, 'missing-compiler.ps1');
      const negative = mode === 'missing-assembly'
        ? controller.replace('Microsoft.PowerShell.Commands.Utility, Version=', 'Liftoff.Missing.Compiler.Fixture, Version=')
        : mode === 'unexpected-identity'
          ? controller.replace('$utilityAssembly.FullName -cne $utilityAssemblyName', '$utilityAssembly.FullName -ceq $utilityAssemblyName')
          : mode === 'missing-type'
            ? controller.replace('Microsoft.PowerShell.Commands.AddTypeCommand', 'Microsoft.PowerShell.Commands.MissingCompilerFixture')
            : controller.replace("$ErrorActionPreference = 'Stop'",
              "$ErrorActionPreference = 'Stop'\n$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'");
      await writeFile(assetPath, negative);
      if (mode === 'constrained-language') {
        const denied = spawnSync('powershell.exe', [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-File', assetPath,
          '-ControlPipeName', 'liftoff-policy-test', '-ExpectedNonce', 'test-fixture',
          '-WorkspaceId', 'test-workspace', '-InvocationId', 'test-invocation'
        ], {
          env: buildWindowsControllerHostEnvironment(), encoding: 'utf8', windowsHide: true,
          timeout: 15_000, maxBuffer: 64 * 1024
        });
        expect(denied.error === undefined).toBe(true);
        expect(denied.status).toBe(1);
        expect(denied.stderr.includes('ConstrainedLanguage mode does not permit Win32 Job API compilation.')).toBe(true);
        expect(denied.stderr.includes('MethodInvocationNotSupportedInConstrainedLanguage')).toBe(false);
        expect(denied.stderr.includes('LIFTOFF_CONTROLLER_STAGE:')).toBe(false);
      }
      launcher = { assetPath, skipAssetVerification: true };
    } else {
      const script = path.join(directory, 'missing-compiler.mjs');
      const diagnostic = mode === 'constrained-language'
        ? 'ConstrainedLanguage mode does not permit Win32 Job API compilation.'
        : mode === 'unexpected-identity'
          ? 'LIFTOFF_CONTROLLER_BOOTSTRAP: assembly-identity\nFailed to load Win32 Job API definitions.'
          : `LIFTOFF_CONTROLLER_BOOTSTRAP: ${mode === 'missing-assembly' ? 'assembly-load' : 'compiler-type'}\nFailed to load Win32 Job API definitions.`;
      await writeFile(script, `process.stderr.write(${JSON.stringify(`${diagnostic}\n`)}); process.exitCode = 1;\n`);
      launcher = await mockControllerLauncher(directory, script);
    }
    const result = await runWindowsJobCommand({
      executable: process.execPath, args: ['--eval', 'process.stdout.write("UNEXPECTED_TARGET_EXECUTION")']
    }, { timeoutMs: 1000 }, launcher);
    expect({
      status: result.status, timedOut: result.timedOut, processSpawned: result.processSpawned,
      processTreeSettled: result.processTreeSettled, errorCode: result.errorCode
    }).toEqual({
      status: null, timedOut: false, processSpawned: false, processTreeSettled: false,
      errorCode: mode === 'constrained-language' ? 'CONSTRAINED_LANGUAGE_MODE' : 'CONTROLLER_LAUNCH_FAILED'
    });
    expect((result.errorMessage ?? '').includes(mode === 'constrained-language'
      ? 'ConstrainedLanguage' : 'Failed to load Win32 Job API definitions')).toBe(true);
    if (mode !== 'constrained-language') {
      expect((result.errorMessage ?? '').includes(`LIFTOFF_CONTROLLER_BOOTSTRAP: ${mode === 'missing-assembly'
        ? 'assembly-load' : mode === 'unexpected-identity' ? 'assembly-identity' : 'compiler-type'}`)).toBe(true);
    }
    expect(result.stdout.includes('UNEXPECTED_TARGET_EXECUTION')).toBe(false);
  });

  it('coordinates execution via control pipe with matching ack and verified settlement', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'liftoff-ps-mock-'));
    tempDirs.push(tempDir);

    // A mock controller script that connects to the control pipe, receives spawn request,
    // sends ack, and sends terminal response
    const mockPs = path.join(tempDir, 'mock-controller-runner.mjs');
    await writeFile(
      mockPs,
      `
import net from 'node:net';
import path from 'node:path';

const pipeArg = process.argv[process.argv.indexOf('-ControlPipeName') + 1];
const nonce = process.argv[process.argv.indexOf('-ExpectedNonce') + 1];
const workspaceId = process.argv[process.argv.indexOf('-WorkspaceId') + 1];
const invocationId = process.argv[process.argv.indexOf('-InvocationId') + 1];
const socket = net.connect(process.platform === 'win32' ? ('\\\\\\\\.\\\\pipe\\\\' + pipeArg) : pipeArg, () => {
  // Send ready authentication frame first
  const ready = {
    schemaVersion: 1,
    kind: 'ready',
    controllerId: 'liftoff-windows-job-controller-v1',
    workspaceId,
    invocationId,
    nonce
  };
  const readyBytes = Buffer.from(JSON.stringify(ready));
  const h0 = Buffer.alloc(4);
  h0.writeUInt32BE(readyBytes.length, 0);
  socket.write(Buffer.concat([h0, readyBytes]));

  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (buf.length >= 4 + len) {
        const payload = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
        if (payload.kind === 'spawn') {
          // Send ack
          const ack = {
            schemaVersion: 1,
            kind: 'ack',
            controllerId: 'liftoff-windows-job-controller-v1',
            workspaceId,
            invocationId,
            nonce,
            sequence: 1,
            admitted: true
          };
          const ackBytes = Buffer.from(JSON.stringify(ack));
          const h1 = Buffer.alloc(4);
          h1.writeUInt32BE(ackBytes.length, 0);
          socket.write(Buffer.concat([h1, ackBytes]));

          // Send terminal response
          const resp = {
            schemaVersion: 1,
            kind: 'response',
            controllerId: 'liftoff-windows-job-controller-v1',
            workspaceId,
            invocationId,
            nonce,
            sequence: 1,
            phase: 'completed',
            status: 0,
            signal: null,
            activeProcesses: 0,
            jobTerminated: false,
            settled: true
          };
          const respBytes = Buffer.from(JSON.stringify(resp));
          const h2 = Buffer.alloc(4);
          h2.writeUInt32BE(respBytes.length, 0);
          socket.write(Buffer.concat([h2, respBytes]), () => {
            setTimeout(() => { socket.end(); process.exit(0); }, 50);
          });
        }
      }
    }
  });
});
`
    );

    const result = await runWindowsJobCommand(
      { executable: process.execPath, args: ['--test'] },
      { timeoutMs: 10_000 },
      await mockControllerLauncher(tempDir, mockPs)
    );

    expect(result.processTreeSettled).toBe(true);
    expect(result.processSpawned).toBe(true);
    expect(result.status).toBe(0);
  });

  it('captures stdout and stderr from file paths with output bounding and cleans up files', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'liftoff-ps-stdio-'));
    tempDirs.push(tempDir);

    const mockPs = path.join(tempDir, 'mock-controller-stdio.mjs');
    await writeFile(
      mockPs,
      `
import net from 'node:net';
import fs from 'node:fs';

const pipeArg = process.argv[process.argv.indexOf('-ControlPipeName') + 1];
const nonce = process.argv[process.argv.indexOf('-ExpectedNonce') + 1];
const workspaceId = process.argv[process.argv.indexOf('-WorkspaceId') + 1];
const invocationId = process.argv[process.argv.indexOf('-InvocationId') + 1];

const socket = net.connect(process.platform === 'win32' ? ('\\\\\\\\.\\\\pipe\\\\' + pipeArg) : pipeArg, () => {
  // Send ready authentication frame
  const ready = {
    schemaVersion: 1,
    kind: 'ready',
    controllerId: 'liftoff-windows-job-controller-v1',
    workspaceId,
    invocationId,
    nonce
  };
  const readyBytes = Buffer.from(JSON.stringify(ready));
  const h0 = Buffer.alloc(4);
  h0.writeUInt32BE(readyBytes.length, 0);
  socket.write(Buffer.concat([h0, readyBytes]));

  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (buf.length >= 4 + len) {
        const payload = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
        if (payload.kind === 'spawn') {
          // Write test outputs to the paths delivered in the spawn request
          if (payload.stdoutFile) {
            fs.writeFileSync(payload.stdoutFile, 'hello windows stdout output that is longer than limit');
          }
          if (payload.stderrFile) {
            fs.writeFileSync(payload.stderrFile, 'warning windows stderr output');
          }

          const ack = {
            schemaVersion: 1,
            kind: 'ack',
            controllerId: 'liftoff-windows-job-controller-v1',
            workspaceId,
            invocationId,
            nonce,
            sequence: 1,
            admitted: true
          };
          const ackBytes = Buffer.from(JSON.stringify(ack));
          const h1 = Buffer.alloc(4);
          h1.writeUInt32BE(ackBytes.length, 0);
          socket.write(Buffer.concat([h1, ackBytes]));

          const resp = {
            schemaVersion: 1,
            kind: 'response',
            controllerId: 'liftoff-windows-job-controller-v1',
            workspaceId,
            invocationId,
            nonce,
            sequence: 1,
            phase: 'completed',
            status: 0,
            signal: null,
            activeProcesses: 0,
            jobTerminated: false,
            settled: true
          };
          const respBytes = Buffer.from(JSON.stringify(resp));
          const h2 = Buffer.alloc(4);
          h2.writeUInt32BE(respBytes.length, 0);
          socket.write(Buffer.concat([h2, respBytes]), () => {
            setTimeout(() => { socket.end(); process.exit(0); }, 50);
          });
        }
      }
    }
  });
});
`
    );

    const result = await runWindowsJobCommand(
      { executable: process.execPath, args: ['--test'] },
      { timeoutMs: 10_000, maxOutputBytes: 25 },
      await mockControllerLauncher(tempDir, mockPs)
    );

    expect(result.processTreeSettled).toBe(true);
    expect(result.processSpawned).toBe(true);
    expect(result.status).toBe(0);
    // Bounded aggregate output across stdout and stderr: max 25 bytes total
    expect(result.stdout).toBe('hello windows stdout outp'); // 25 bytes
    expect(result.stderr).toBe(''); // remaining budget 0
  });

  it('rejects unauthenticated pipe peer and refuses settlement manufacture', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'liftoff-ps-unauth-'));
    tempDirs.push(tempDir);

    const mockPs = path.join(tempDir, 'mock-unauth-peer.mjs');
    await writeFile(
      mockPs,
      `
import net from 'node:net';

const pipeArg = process.argv[process.argv.indexOf('-ControlPipeName') + 1];
const socket = net.connect(process.platform === 'win32' ? ('\\\\\\\\.\\\\pipe\\\\' + pipeArg) : pipeArg, () => {
  // An unauthenticated peer attempts to send an unauthenticated/fabricated response
  const fakeResp = {
    schemaVersion: 1,
    kind: 'response',
    controllerId: 'liftoff-windows-job-controller-v1',
    workspaceId: '0000000000000000000000000000000000000000000000000000000000000000',
    invocationId: '0000000000000000000000000000000000000000000000000000000000000000',
    nonce: '0000000000000000000000000000000000000000000000000000000000000000',
    sequence: 1,
    phase: 'completed',
    status: 0,
    signal: null,
    activeProcesses: 0,
    jobTerminated: false,
    settled: true
  };
  const bytes = Buffer.from(JSON.stringify(fakeResp));
  const h = Buffer.alloc(4);
  h.writeUInt32BE(bytes.length, 0);
  socket.write(Buffer.concat([h, bytes]));
});
`
    );

    const result = await runWindowsJobCommand(
      { executable: process.execPath, args: ['--test'] },
      { timeoutMs: 5_000 },
      await mockControllerLauncher(tempDir, mockPs)
    );

    expect(result.processTreeSettled).toBe(false);
    expect(result.processSpawned).toBe(false);
    expect(result.errorCode).toBe('AUTHENTICATION_FAILED');
  });

  it('propagates outputLimitExceeded and distinguishes it from timeout', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'liftoff-ps-overflow-'));
    tempDirs.push(tempDir);

    const mockPs = path.join(tempDir, 'mock-controller-overflow.mjs');
    await writeFile(
      mockPs,
      `
import net from 'node:net';

const pipeArg = process.argv[process.argv.indexOf('-ControlPipeName') + 1];
const nonce = process.argv[process.argv.indexOf('-ExpectedNonce') + 1];
const workspaceId = process.argv[process.argv.indexOf('-WorkspaceId') + 1];
const invocationId = process.argv[process.argv.indexOf('-InvocationId') + 1];

const socket = net.connect(process.platform === 'win32' ? ('\\\\\\\\.\\\\pipe\\\\' + pipeArg) : pipeArg, () => {
  const ready = {
    schemaVersion: 1,
    kind: 'ready',
    controllerId: 'liftoff-windows-job-controller-v1',
    workspaceId,
    invocationId,
    nonce
  };
  const readyBytes = Buffer.from(JSON.stringify(ready));
  const h0 = Buffer.alloc(4);
  h0.writeUInt32BE(readyBytes.length, 0);
  socket.write(Buffer.concat([h0, readyBytes]));

  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (buf.length >= 4 + len) {
        const payload = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
        if (payload.kind === 'spawn') {
          const ack = {
            schemaVersion: 1,
            kind: 'ack',
            controllerId: 'liftoff-windows-job-controller-v1',
            workspaceId,
            invocationId,
            nonce,
            sequence: 1,
            admitted: true
          };
          const ackBytes = Buffer.from(JSON.stringify(ack));
          const h1 = Buffer.alloc(4);
          h1.writeUInt32BE(ackBytes.length, 0);
          socket.write(Buffer.concat([h1, ackBytes]));

          const resp = {
            schemaVersion: 1,
            kind: 'response',
            controllerId: 'liftoff-windows-job-controller-v1',
            workspaceId,
            invocationId,
            nonce,
            sequence: 1,
            phase: 'terminated',
            status: null,
            signal: 'SIGKILL',
            activeProcesses: 0,
            jobTerminated: true,
            settled: true,
            outputLimitExceeded: true
          };
          const respBytes = Buffer.from(JSON.stringify(resp));
          const h2 = Buffer.alloc(4);
          h2.writeUInt32BE(respBytes.length, 0);
          socket.write(Buffer.concat([h2, respBytes]), () => {
            setTimeout(() => { socket.end(); process.exit(0); }, 50);
          });
        }
      }
    }
  });
});
`
    );

    const result = await runWindowsJobCommand(
      { executable: process.execPath, args: ['--test'] },
      { timeoutMs: 10_000 },
      await mockControllerLauncher(tempDir, mockPs)
    );

    expect(result.processTreeSettled).toBe(true);
    expect(result.processSpawned).toBe(true);
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('fails closed when aborted before execution starts', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runWindowsJobCommand(
      { executable: process.execPath, args: ['--test'] },
      { signal: controller.signal },
      { skipAssetVerification: true }
    );

    expect(result.processTreeSettled).toBe(false);
    expect(result.processSpawned).toBe(false);
    expect(result.signal).toBe('SIGABRT');
    expect(result.errorCode).toBe('ABORTED');
  });

  it('handles socket disconnect before response as CONTROL_PIPE_DISCONNECTED', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'liftoff-ps-disconnect-'));
    tempDirs.push(tempDir);

    const mockPs = path.join(tempDir, 'mock-controller-disconnect.mjs');
    await writeFile(
      mockPs,
      `
import net from 'node:net';

const pipeArg = process.argv[process.argv.indexOf('-ControlPipeName') + 1];
const socket = net.connect(process.platform === 'win32' ? ('\\\\\\\\.\\\\pipe\\\\' + pipeArg) : pipeArg, () => {
  // Immediately disconnect without sending anything
  socket.destroy();
  process.exit(0);
});
`
    );

    const result = await runWindowsJobCommand(
      { executable: process.execPath, args: ['--test'] },
      { timeoutMs: 5_000 },
      await mockControllerLauncher(tempDir, mockPs)
    );

    expect(result.processTreeSettled).toBe(false);
    expect(result.processSpawned).toBe(false);
    expect(['CONTROL_PIPE_DISCONNECTED', 'CONTROL_PIPE_ERROR']).toContain(result.errorCode);
  });

  it('maps Windows policy and admission failures to causal diagnostics', async () => {
    const { applicationCommandFailure } = await import('../src/application/repair/application-diagnostics.js');
    const dummyCommand = {
      index: 1,
      name: 'test',
      executable: 'node.exe',
      args: ['--test'],
      cwdPathParts: [],
      timeoutMs: 30000,
      maxOutputBytes: 65536,
      network: false
    };

    const policyFailure = applicationCommandFailure(dummyCommand, {
      command: { executable: 'node.exe', args: [] },
      displayCommand: 'node.exe',
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      processTreeSettled: false,
      processSpawned: false,
      errorCode: 'RESTRICTED_EXECUTION_POLICY'
    });
    expect(policyFailure?.kind).toBe('execution-failed');
    expect(policyFailure?.message).toContain('Windows PowerShell execution policy');

    const constrainedFailure = applicationCommandFailure(dummyCommand, {
      command: { executable: 'node.exe', args: [] },
      displayCommand: 'node.exe',
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      processTreeSettled: false,
      processSpawned: false,
      errorCode: 'CONSTRAINED_LANGUAGE_MODE'
    });
    expect(constrainedFailure?.kind).toBe('execution-failed');
    expect(constrainedFailure?.message).toContain('ConstrainedLanguage mode');

    // Locked preparation must also preserve these causal diagnostics
    const { applicationPreparationFailure } = await import('../src/application/repair/application-preparation-diagnostics.js');
    const dummyPrep: ApplicationResolvedPreparation = {
      schemaVersion: 1, provider: 'npm-ci', version: 1,
      component: { logicalName: 'node-backend-package', category: 'backend', pathParts: ['backend', 'package.json'],
        provisioningGroup: 'base', component: 'backend', componentRootPathParts: ['backend'] },
      cwdPathParts: [],
      packageSource: 'npmjs',
      registry: 'https://registry.npmjs.org',
      network: false, lifecycle: 'disabled', inputs: [], commands: [], tools: [], outputRoles: [],
      packageCount: 0, suppressedLifecyclePackages: 0, pythonExtras: [], toolRequirements: {}, digest: '0'.repeat(64)
    };
    const prepPolicyFailure = applicationPreparationFailure(dummyPrep, dummyCommand, {
      command: { executable: 'node.exe', args: [] },
      displayCommand: 'node.exe',
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      processTreeSettled: false,
      processSpawned: false,
      errorCode: 'RESTRICTED_EXECUTION_POLICY'
    });
    expect(prepPolicyFailure?.kind).toBe('execution-failed');
    expect(prepPolicyFailure?.message).toContain('Windows PowerShell execution policy');
  });

  it('resolves npm to node.exe and npm-cli.js within target environment PATH without launching shims', async () => {
    const { resolveTargetExecutableCommand } = await import('../src/adapters/process/windows-job-runner.js');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'liftoff-npm-res-'));
    tempDirs.push(tempDir);

    const nodeExe = path.join(tempDir, 'node.exe');
    const npmDir = path.join(tempDir, 'node_modules', 'npm', 'bin');
    await mkdir(npmDir, { recursive: true });
    const npmCli = path.join(npmDir, 'npm-cli.js');
    const npmShim = path.join(tempDir, 'npm'); // extensionless shell script

    await writeFile(nodeExe, 'mock-node');
    await writeFile(npmCli, 'mock-npm-cli');
    await writeFile(npmShim, '#!/bin/sh\n');

    const resolved = resolveTargetExecutableCommand(
      { executable: 'npm', args: ['test'] },
      { PATH: tempDir }
    );

    expect(resolved).not.toBeNull();
    expect(resolved?.executable).toBe(nodeExe);
    expect(resolved?.args).toEqual([npmCli, 'test']);
  });

  it('resolves npm when npm and Node occupy different PATH entries in target environment', async () => {
    const { resolveTargetExecutableCommand } = await import('../src/adapters/process/windows-job-runner.js');
    const globalNpmDir = await mkdtemp(path.join(os.tmpdir(), 'liftoff-global-npm-'));
    const nodeInstallDir = await mkdtemp(path.join(os.tmpdir(), 'liftoff-node-install-'));
    tempDirs.push(globalNpmDir, nodeInstallDir);

    // Global npm directory has npm-cli.js and an unlaunchable npm.cmd
    const globalNpmBin = path.join(globalNpmDir, 'node_modules', 'npm', 'bin');
    await mkdir(globalNpmBin, { recursive: true });
    const globalNpmCli = path.join(globalNpmBin, 'npm-cli.js');
    const globalNpmCmd = path.join(globalNpmDir, 'npm.cmd');
    await writeFile(globalNpmCli, 'global-npm-cli-content');
    await writeFile(globalNpmCmd, '@echo off\n');

    // Node directory has node.exe
    const nodeExe = path.join(nodeInstallDir, 'node.exe');
    await writeFile(nodeExe, 'node-binary-content');

    const multiPath = [globalNpmDir, nodeInstallDir].join(path.delimiter);
    const resolved = resolveTargetExecutableCommand(
      { executable: 'npm', args: ['ci'] },
      { PATH: multiPath }
    );

    expect(resolved).not.toBeNull();
    expect(resolved?.executable).toBe(nodeExe);
    expect(resolved?.args).toEqual([globalNpmCli, 'ci']);
  });

  it('fails closed before launch when executable is missing from admitted target PATH without ambient fallback', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'liftoff-no-exe-'));
    tempDirs.push(tempDir);

    const result = await runWindowsJobCommand(
      { executable: 'missing-tool-command', args: ['--flag'] },
      { env: { PATH: tempDir } },
      { powershellPath: process.execPath, skipAssetVerification: true }
    );

    expect(result.processTreeSettled).toBe(false);
    expect(result.processSpawned).toBe(false);
    expect(result.errorCode).toBe('ENOENT');
    expect(result.errorMessage).toContain('could not be resolved against the admitted target environment PATH');
  });

  it.runIf(process.platform === 'win32')('settles a real native Node command through the packaged Windows controller', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "liftoff native controller's "));
    tempDirs.push(directory);
    const result = await runWindowsJobCommand(
      { executable: process.execPath, args: ['-e', 'process.stdout.write("native controller ready")'] },
      {
        cwd: directory,
        timeoutMs: 10_000,
        env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(process.execPath), TEMP: directory, TMP: directory }
      }
    );
    expect(result, JSON.stringify({
      errorCode: result.errorCode, errorMessage: result.errorMessage,
      timedOut: result.timedOut, spawned: result.processSpawned
    })).toMatchObject({
      status: 0, processSpawned: true, processTreeSettled: true,
      timedOut: false, stdout: 'native controller ready'
    });
  });

  it.runIf(process.platform === 'win32')('runs supported native syntax and JSON green/red inputs without accepting initialization failure or changing target environment semantics', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'liftoff-native-validator-environment-'));
    tempDirs.push(directory);
    const controls = [
      { jobId: 'validate', mode: 'green', extension: 'mjs', text: 'export const valid = true;\n', status: 0 },
      { jobId: 'validate', mode: 'controlled-red', extension: 'mjs', text: 'export const valid = ;\n', status: 1 },
      { jobId: 'package', mode: 'green', extension: 'json', text: '{"name":"isolated"}\n', status: 0 },
      { jobId: 'package', mode: 'controlled-red', extension: 'json', text: '{broken}\n', status: 1 }
    ] as const;
    type Control = typeof controls[number];
    const input = (control: Control) => path.join(directory, `${control.jobId}-${control.mode}.${control.extension}`);
    for (const control of controls) await writeFile(input(control), control.text, { flag: 'wx', mode: 0o600 });
    const runner = new NodeCommandRunner(), run = vi.spyOn(runner, 'run');
    const execute = (control: Control, ambient: NodeJS.ProcessEnv = process.env) => runner.run({
      executable: process.execPath, args: control.jobId === 'validate' ? ['--check', input(control)] :
        ['-e', "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))", input(control)]
    }, {
      cwd: directory, env: matrixValidatorEnvironment(directory, 'win32', ambient),
      timeoutMs: 5000, maxOutputBytes: 4096,
      stream: false, ensureProcessTreeSettled: true
    });
    const systemRoot = matrixValidatorEnvironment(directory).SystemRoot;
    for (const ambient of [{}, { SystemRoot: '' }, { SystemRoot: systemRoot, SYSTEMROOT: 'conflicting-fixture-root' }]) {
      expect(() => execute(controls[0], ambient)).toThrow(/actual host SystemRoot|Conflicting case-insensitive environment aliases/);
    }
    expect(run).not.toHaveBeenCalled();
    for (const control of controls) {
      const result = await execute(control);
      console.info(`Bounded native validator regression: ${JSON.stringify({
        fixture: { jobId: control.jobId, mode: control.mode },
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        inputSha256: createHash('sha256').update(control.text).digest('hex'),
        result: { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
          processSpawned: result.processSpawned ?? null, processTreeSettled: result.processTreeSettled ?? null,
          timedOut: result.timedOut, outputLimitExceeded: result.outputLimitExceeded ?? null,
          aborted: result.aborted ?? null, errorCode: result.errorCode ?? null, errorMessage: result.errorMessage ?? null }
      })}`);
      expect(result.status, result.stderr).toBe(control.status);
      expect(result.signal).toBeNull();
      expect(result).toMatchObject({ processSpawned: true, processTreeSettled: true, timedOut: false });
      expect(result.errorCode).toBeUndefined();
      expect(result.aborted).not.toBe(true);
      expect(result.outputLimitExceeded).not.toBe(true);
      if (control.status === 1) expect(result.stderr).toMatch(/\bSyntaxError:/u);
      expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThanOrEqual(4096);
      expect(await readFile(input(control), 'utf8')).toBe(control.text);
    }
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('ensures environmentValue does not let undefined Path shadow valid PATH and rejects conflicting aliases', async () => {
    const { environmentValue } = await import('../src/domain/workstation/executables.js');

    // 1. Undefined Path must not shadow valid PATH
    const envWithUndefinedPath = { Path: undefined, PATH: 'C:\\valid\\node' };
    expect(environmentValue(envWithUndefinedPath, 'PATH', 'win32')).toBe('C:\\valid\\node');
    expect(environmentValue(envWithUndefinedPath, 'Path', 'win32')).toBe('C:\\valid\\node');

    // 2. Conflicting defined aliases must be rejected
    const conflictingEnv = { Path: 'C:\\first', PATH: 'C:\\second' };
    expect(() => environmentValue(conflictingEnv, 'PATH', 'win32')).toThrow(
      /Conflicting case-insensitive environment aliases detected/
    );

    // 3. Deliberately scrubbed PATH (only undefined) must not resurrect ambient PATH
    const scrubbedEnv = { Path: undefined };
    expect(environmentValue(scrubbedEnv, 'PATH', 'win32')).toBeUndefined();
  });
});
