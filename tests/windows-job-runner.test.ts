import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  windowsWorkingDirectoryErrorCode, windowsWorkingDirectoryFits, windowsWorkingDirectoryRemedy
} from '../src/domain/execution/windows-working-directory.js';
import {
  buildWindowsControllerHostEnvironment,
  runWindowsJobCommand,
  verifyWindowsJobControllerAsset,
  windowsJobControllerAssetDigest
} from '../src/adapters/process/windows-job-runner.js';
import {
  frameControlMessage,
  unframeControlMessages,
  type WindowsJobControlAck,
  type WindowsJobControlResponse
} from '../src/adapters/process/windows-job-protocol.js';

const tempDirs: string[] = [];
const retainedDirs = new Set<string>();
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    if (!retainedDirs.has(dir)) await rm(dir, { recursive: true, force: true });
  }
});

describe('Windows working-directory length contract', () => {
  it.each(['C:\\', '\\\\server\\share\\', '\\\\?\\C:\\'])('counts the complete %s path, separator and terminator', (root) => {
    const directory = root + 'x'.repeat(258 - root.length);
    expect(windowsWorkingDirectoryFits(directory)).toBe(true);
    expect(windowsWorkingDirectoryFits(`${directory}\\`)).toBe(true);
    expect(windowsWorkingDirectoryFits(`${directory}x`)).toBe(false);
    expect(windowsWorkingDirectoryFits(`${directory}x\\`)).toBe(false);
    expect(windowsWorkingDirectoryFits(`${directory}/`)).toBe(true);
  });

  it('counts UTF-16 code units rather than Unicode code points', () => {
    const directory = `C:\\${'\u{1f680}'.repeat(127)}`;
    expect(directory.length).toBe(257);
    expect(windowsWorkingDirectoryFits(`${directory}x`)).toBe(true);
    expect(windowsWorkingDirectoryFits(`${directory}\u{1f680}`)).toBe(false);
  });
});

describe.runIf(process.platform === 'win32')('native Windows working-directory admission', () => {
  async function nativeCwd(length: number) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-native-cwd-'));
    tempDirs.push(root);
    let cwd = path.join(root, "project's $literal [directory]");
    while (cwd.length + 16 < length) cwd = path.join(cwd, 'nested-segment');
    cwd = path.join(cwd, 'x'.repeat(length - cwd.length - 1));
    expect(cwd.length).toBe(length);
    await mkdir(cwd, { recursive: true });
    return { root, cwd };
  }

  it.each([180, 258])('executes in an exact literal cwd of %i UTF-16 code units', async (length) => {
    const { root, cwd } = await nativeCwd(length);
    retainedDirs.add(root);
    const started = performance.now();
    const result = await runWindowsJobCommand({
      executable: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync('effect.txt', 'exact owned effect\\n'); console.log(process.cwd());"]
    }, { cwd, env: { SystemRoot: process.env.SystemRoot }, timeoutMs: 5_000, maxOutputBytes: 2048 });
    if (result.processTreeSettled === true) retainedDirs.delete(root);
    expect({ status: result.status, settled: result.processTreeSettled }, JSON.stringify({
      code: result.errorCode, detail: result.errorMessage, stderr: result.stderr,
      cwdLength: cwd.length, elapsedMs: Math.round(performance.now() - started)
    })).toEqual({ status: 0, settled: true });
    expect(await readFile(path.join(cwd, 'effect.txt'), 'utf8')).toBe('exact owned effect\n');
    expect(path.toNamespacedPath(result.stdout.trim())).toBe(path.toNamespacedPath(cwd));
  }, 90_000);

  it.each([259, 320])('refuses a %i-code-unit cwd before any controller or target dispatch', async (length) => {
    const { cwd } = await nativeCwd(length);
    const spawnController = vi.fn(() => { throw new Error('Over-limit cwd must not launch a controller.'); });
    for (const target of [cwd, path.toNamespacedPath(cwd)]) {
      const result = await runWindowsJobCommand({
        executable: process.execPath,
        args: ['-e', "require('node:fs').writeFileSync('must-not-exist.txt', 'unapproved')"]
      }, { cwd: target, timeoutMs: 5_000 }, { spawnController });
      expect(result).toMatchObject({
        status: null, processSpawned: false, processTreeSettled: true, timedOut: false,
        errorCode: windowsWorkingDirectoryErrorCode, errorMessage: windowsWorkingDirectoryRemedy
      });
    }
    expect(spawnController).not.toHaveBeenCalled();
    expect(await readdir(cwd)).toEqual([]);
    const aborted = await runWindowsJobCommand({ executable: process.execPath, args: [] }, {
      cwd, signal: AbortSignal.abort()
    }, { spawnController });
    expect(aborted).toMatchObject({ errorCode: 'ABORTED', processSpawned: false });
    expect(spawnController).not.toHaveBeenCalled();
  });

  it('rejects a real controller with the wrong authentication nonce before target dispatch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-native-auth-'));
    tempDirs.push(root);
    const result = await runWindowsJobCommand({
      executable: process.execPath, args: ['-e', "require('node:fs').writeFileSync('unapproved.txt', 'unapproved')"]
    }, { cwd: root, env: { SystemRoot: process.env.SystemRoot }, timeoutMs: 5_000 }, {
      spawnController: (executable, args, options) => {
        const overridden = [...args];
        const nonceIndex = overridden.indexOf('-ExpectedNonce') + 1;
        expect(nonceIndex).toBeGreaterThan(0);
        overridden[nonceIndex] = '0'.repeat(64);
        return spawn(executable, overridden, options);
      }
    });
    expect(result).toMatchObject({
      status: null, errorCode: 'AUTHENTICATION_FAILED', timedOut: false, processSpawned: false
    });
    expect(await readdir(root)).toEqual([]);
  }, 90_000);

  it('reports real missing-directory admission without executing in a substitute cwd', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-native-absent-'));
    tempDirs.push(root);
    retainedDirs.add(root);
    const result = await runWindowsJobCommand({
      executable: process.execPath, args: ['-e', "require('node:fs').writeFileSync('unapproved.txt', 'unapproved')"]
    }, { cwd: path.join(root, 'absent'), env: { SystemRoot: process.env.SystemRoot }, timeoutMs: 5_000 });
    if (result.processTreeSettled === true) retainedDirs.delete(root);
    expect(result).toMatchObject({ status: null, errorCode: 'ADMISSION_DENIED', timedOut: false });
    expect(result.errorMessage).toContain('CreateProcessW failed with Win32 error 267');
    expect(await readdir(root)).toEqual([]);
  }, 90_000);

  it('records built-in module admission and interop startup separately', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-startup-'));
    tempDirs.push(root);
    let source = await readFile(await verifyWindowsJobControllerAsset(), 'utf8');
    for (const [anchor, label] of [
      ["$ErrorActionPreference = 'Stop'", 'script-entered'],
      ['# Define Win32 interop for Job Objects and CreateProcessW with STARTUPINFOEX', 'utility-loaded'],
      ['Add-Type -TypeDefinition $win32TypeDef -ErrorAction Stop', 'interop-compiled'],
      ['$pipe.Connect(30000)', 'pipe-connected'],
      ['# Read the spawn request from the parent', 'ready-sent'],
      ['# Acknowledge admission success', 'root-started']
    ]) {
      expect(source.split(anchor)).toHaveLength(2);
      source = source.replace(anchor, `${anchor}\n[Console]::Error.WriteLine('liftoff-startup:${label}')`);
    }
    source = source.replace('Add-Type -TypeDefinition $win32TypeDef -ErrorAction Stop',
      "[void](Get-Command Add-Type -ErrorAction Stop)\n[Console]::Error.WriteLine('liftoff-startup:interop-resolved')\n" +
      'Add-Type -TypeDefinition $win32TypeDef -ErrorAction Stop');
    const assetPath = path.join(root, 'instrumented-controller.ps1');
    await writeFile(assetPath, source);
    const stages: Array<{ stage: string; elapsedMs: number }> = [];
    const start = performance.now();
    retainedDirs.add(root);
    const result = await runWindowsJobCommand({
      executable: process.execPath, args: ['-e', "console.log('native-startup-probe')"]
    }, { cwd: root, env: { SystemRoot: process.env.SystemRoot }, timeoutMs: 5_000, maxOutputBytes: 2048 }, {
      assetPath, expectedDigest: createHash('sha256').update(source).digest('hex'),
      spawnController: (executable, args, options) => {
        const child = spawn(executable, args, options);
        let pending = '';
        child.stderr?.on('data', (chunk: Buffer) => {
          pending += chunk.toString('utf8');
          const lines = pending.split(/\r?\n/u);
          pending = lines.pop()!;
          for (const line of lines) {
            const match = /^liftoff-startup:([a-z-]+)$/u.exec(line);
            if (match) stages.push({ stage: match[1]!, elapsedMs: Math.round(performance.now() - start) });
          }
        });
        return child;
      }
    });
    if (result.processTreeSettled === true) retainedDirs.delete(root);
    console.info('Native controller built-in-module startup stages (instrumented diagnostic, not qualification):', JSON.stringify(stages));
    expect(result.status, JSON.stringify({ code: result.errorCode, detail: result.errorMessage, stderr: result.stderr, stages })).toBe(0);
    expect(result.processTreeSettled).toBe(true);
    expect(result.stdout.trim()).toBe('native-startup-probe');
    expect(stages.map((entry) => entry.stage)).toEqual([
      'script-entered', 'utility-loaded', 'interop-resolved', 'interop-compiled', 'pipe-connected', 'ready-sent', 'root-started'
    ]);
  }, 90_000);
});

describe.runIf(process.platform === 'win32')('native Win32 Job Object settlement', () => {
  async function ownedRoot() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-native-tree-'));
    tempDirs.push(root);
    retainedDirs.add(root);
    return root;
  }

  it('waits for an inherited descendant after the root exits', async () => {
    const root = await ownedRoot();
    const descendant = "setTimeout(() => { require('node:fs').writeFileSync('descendant.txt', 'settled'); console.log('descendant-settled'); }, 500);";
    const result = await runWindowsJobCommand({
      executable: process.execPath,
      args: ['-e', `
        const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],
          { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
        child.once('spawn', () => {
          require('node:fs').writeFileSync('root.txt', 'exited');
          child.unref();
          process.exit(0);
        });
      `]
    }, { cwd: root, env: { SystemRoot: process.env.SystemRoot }, timeoutMs: 5_000, maxOutputBytes: 2048 });
    if (result.processTreeSettled === true) retainedDirs.delete(root);
    expect(result, result.errorMessage).toMatchObject({
      status: 0, processSpawned: true, processTreeSettled: true, timedOut: false
    });
    expect(await readFile(path.join(root, 'root.txt'), 'utf8')).toBe('exited');
    expect(await readFile(path.join(root, 'descendant.txt'), 'utf8')).toBe('settled');
    expect(result.stdout).toContain('descendant-settled');
  }, 90_000);

  it.each(['timeout', 'output-limit'] as const)('settles the exact owned tree on %s without killing a neighbor', async (mode) => {
    const root = await ownedRoot();
    const neighbor = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], {
      cwd: root, env: { SystemRoot: process.env.SystemRoot }, stdio: 'ignore', windowsHide: true
    });
    const neighborExit = once(neighbor, 'exit');
    await once(neighbor, 'spawn');
    let settled = false;
    try {
      const descendant = `
        const fs = require('node:fs');
        fs.writeFileSync('descendant.txt', 'started');
        setInterval(() => fs.writeFileSync('heartbeat.txt', String(Date.now())), 25);
        ${mode === 'output-limit' ? "process.stdout.write('x'.repeat(4096));" : ''}
      `;
      const result = await runWindowsJobCommand({
        executable: process.execPath,
        args: ['-e', `
          require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],
            { stdio: ['ignore', 'inherit', 'inherit'] });
          setInterval(() => {}, 1000);
        `]
      }, { cwd: root, env: { SystemRoot: process.env.SystemRoot }, timeoutMs: 2_000, maxOutputBytes: 1024 });
      settled = result.processTreeSettled === true;
      expect(result, result.errorMessage).toMatchObject({
        status: null, processSpawned: true, processTreeSettled: true,
        timedOut: mode === 'timeout', outputLimitExceeded: mode === 'output-limit'
      });
      expect(await readFile(path.join(root, 'descendant.txt'), 'utf8')).toBe('started');
      const entries = await readdir(root);
      const heartbeat = entries.includes('heartbeat.txt') ? await readFile(path.join(root, 'heartbeat.txt')) : null;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await readdir(root)).toEqual(entries);
      if (heartbeat) expect(await readFile(path.join(root, 'heartbeat.txt'))).toEqual(heartbeat);
      expect(neighbor.exitCode).toBeNull();
      expect(neighbor.signalCode).toBeNull();
    } finally {
      if (neighbor.exitCode === null && neighbor.signalCode === null) neighbor.kill();
      await neighborExit;
      if (settled) retainedDirs.delete(root);
    }
  }, 90_000);

  it('retains uncertainty when cancellation interrupts an actually started tree', async () => {
    const root = await ownedRoot();
    const abort = new AbortController();
    const execution = runWindowsJobCommand({
      executable: process.execPath,
      args: ['-e', `
        require('node:child_process').spawn(process.execPath, ['-e',
          "require('node:fs').writeFileSync('started.txt', 'started'); setInterval(() => {}, 1000);"
        ], { stdio: ['ignore', 'inherit', 'inherit'] });
        setInterval(() => {}, 1000);
      `]
    }, { cwd: root, env: { SystemRoot: process.env.SystemRoot }, signal: abort.signal, timeoutMs: 10_000 });
    try {
      await vi.waitFor(async () => {
        expect(await readFile(path.join(root, 'started.txt'), 'utf8')).toBe('started');
      }, { timeout: 5_000, interval: 25 });
      abort.abort();
      const result = await execution;
      expect(result).toMatchObject({
        status: null, errorCode: 'ABORTED', processSpawned: true, processTreeSettled: false
      });
      expect(retainedDirs.has(root)).toBe(true);
      expect(await readFile(path.join(root, 'started.txt'), 'utf8')).toBe('started');
    } finally {
      abort.abort();
      await execution;
    }
  }, 90_000);
});

describe('Windows Job Object controller asset integrity and host environment', () => {
  it('loads only the built-in Utility module before cmdlet use without changing execution policy', async () => {
    const source = await readFile(await verifyWindowsJobControllerAsset(), 'utf8');
    const autoload = source.indexOf("$PSModuleAutoLoadingPreference = 'None'");
    const utility = source.indexOf("Import-Module -Name ([System.IO.Path]::Combine($PSHOME, 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop");
    const compile = source.indexOf('Add-Type -TypeDefinition $win32TypeDef -ErrorAction Stop');
    expect(autoload).toBeGreaterThan(0);
    expect(utility).toBeGreaterThan(autoload);
    expect(compile).toBeGreaterThan(utility);
    expect(source).not.toMatch(/Set-ExecutionPolicy|-ExecutionPolicy\s+(?:Bypass|Unrestricted)/iu);
  });

  it('verifies the packaged controller asset matches its exact pinned SHA-256 digest', async () => {
    const verifiedPath = await verifyWindowsJobControllerAsset();
    expect(verifiedPath).toContain(path.join('assets', 'repair', 'windows-job-controller.ps1'));
    const bytes = await readFile(verifiedPath);
    const hash = createHash('sha256').update(bytes).digest('hex');
    expect(hash).toBe(windowsJobControllerAssetDigest);
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
  it('detects Restricted execution policy from PowerShell exit and fails closed before target execution', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'liftoff-ps-policy-'));
    tempDirs.push(tempDir);

    const mockPs = path.join(tempDir, 'mock-policy.mjs');
    await writeFile(
      mockPs,
      `console.error("File C:\\\\repair\\\\windows-job-controller.ps1 cannot be loaded because running scripts is disabled on this system. For more information, see about_Execution_Policies at https:/go.microsoft.com/fwlink/?LinkID=135170.");\nprocess.exit(1);\n`
    );

    const result = await runWindowsJobCommand(
      { executable: process.execPath, args: ['--test'] },
      {},
      {
        skipAssetVerification: true,
        spawnController: (_cmd, args, opts) => spawn(process.execPath, [mockPs, ...args], opts)
      }
    );

    expect(result.processTreeSettled).toBe(false);
    expect(result.processSpawned).toBe(false);
    expect(result.errorCode).toBe('RESTRICTED_EXECUTION_POLICY');
    expect(result.errorMessage).toContain('Windows PowerShell execution policy');
  });

  it('detects ConstrainedLanguage / AppLocker from PowerShell exit and fails closed before target execution', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'liftoff-ps-lang-'));
    tempDirs.push(tempDir);

    const mockPs = path.join(tempDir, 'mock-lang.mjs');
    await writeFile(
      mockPs,
      `console.error("Cannot add type. Definition of new types is not supported in this language mode (ConstrainedLanguage / AppLocker).");\nprocess.exit(1);\n`
    );

    const result = await runWindowsJobCommand(
      { executable: process.execPath, args: ['--test'] },
      {},
      {
        skipAssetVerification: true,
        spawnController: (_cmd, args, opts) => spawn(process.execPath, [mockPs, ...args], opts)
      }
    );

    expect(result.processTreeSettled).toBe(false);
    expect(result.processSpawned).toBe(false);
    expect(result.errorCode).toBe('CONSTRAINED_LANGUAGE_MODE');
    expect(result.errorMessage).toContain('ConstrainedLanguage mode or restricted by AppLocker/WDAC');
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
import fs from 'node:fs';

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
          if (payload.stdoutFile) fs.writeFileSync(payload.stdoutFile, '');
          if (payload.stderrFile) fs.writeFileSync(payload.stderrFile, '');

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
      {
        skipAssetVerification: true,
        spawnController: (_cmd, args, opts) => spawn(process.execPath, [mockPs, ...args], opts)
      }
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
      {
        skipAssetVerification: true,
        spawnController: (_cmd, args, opts) => spawn(process.execPath, [mockPs, ...args], opts)
      }
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
      {
        skipAssetVerification: true,
        spawnController: (_cmd, args, opts) => spawn(process.execPath, [mockPs, ...args], opts)
      }
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
import fs from 'node:fs';

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
          if (payload.stdoutFile) fs.writeFileSync(payload.stdoutFile, '');
          if (payload.stderrFile) fs.writeFileSync(payload.stderrFile, '');

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
      {
        skipAssetVerification: true,
        spawnController: (_cmd, args, opts) => spawn(process.execPath, [mockPs, ...args], opts)
      }
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
      {
        skipAssetVerification: true,
        spawnController: (_cmd, args, opts) => spawn(process.execPath, [mockPs, ...args], opts)
      }
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
    const dummyPrep = {
      provider: 'npm-ci' as const,
      cwdPathParts: [],
      packageSource: 'public-default' as const,
      registry: 'https://registry.npmjs.org',
      network: false,
      lockPathParts: ['package-lock.json'],
      manifestPathParts: ['package.json']
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
    const cwdFailure = {
      command: { executable: 'node.exe', args: [] }, displayCommand: '',
      status: null, signal: null, stdout: '', stderr: 'PRIVATE_DIAGNOSTIC',
      timedOut: false, processSpawned: false, processTreeSettled: true,
      errorCode: windowsWorkingDirectoryErrorCode, errorMessage: 'PRIVATE_PATH'
    };
    expect(applicationCommandFailure(dummyCommand, cwdFailure)).toEqual({
      kind: 'execution-failed', message: windowsWorkingDirectoryRemedy, cleanupUnsafe: false
    });
    expect(applicationPreparationFailure(dummyPrep, dummyCommand, cwdFailure))
      .toEqual(applicationCommandFailure(dummyCommand, cwdFailure));
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
