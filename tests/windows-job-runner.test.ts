import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

describe.runIf(process.platform === 'win32')('native Windows working-directory admission', () => {
  it.each([180, 320])('executes in an exact literal cwd of at least %i characters', async (minimumLength) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-native-cwd-'));
    tempDirs.push(root);
    let cwd = path.join(root, "project's $literal [directory]");
    while (cwd.length < minimumLength) cwd = path.join(cwd, 'nested-segment');
    await mkdir(cwd, { recursive: true });

    const observations = [];
    retainedDirs.add(root);
    for (const [kind, target] of [['canonical', cwd], ['internal-namespace', path.toNamespacedPath(cwd)]] as const) {
      const result = await runWindowsJobCommand({
        executable: process.execPath,
        args: ['-e', "require('node:fs').writeFileSync(process.argv[1], 'exact owned effect\\n'); console.log(process.cwd());", `${kind}.txt`]
      }, { cwd: target, timeoutMs: 5_000, maxOutputBytes: 2048 });
      observations.push({ kind, status: result.status, settled: result.processTreeSettled,
        code: result.errorCode, detail: result.errorMessage, cwdLength: target.length });
      if (result.status === 0 && result.processTreeSettled === true) {
        expect(await readFile(path.join(cwd, `${kind}.txt`), 'utf8')).toBe('exact owned effect\n');
        expect(path.toNamespacedPath(result.stdout.trim())).toBe(path.toNamespacedPath(cwd));
      }
    }
    if (observations.every((result) => result.settled === true)) retainedDirs.delete(root);
    expect(observations, JSON.stringify(observations)).toEqual([
      expect.objectContaining({ kind: 'canonical', status: 0, settled: true }),
      expect.objectContaining({ kind: 'internal-namespace', status: 0, settled: true })
    ]);
  }, 30_000);
});

describe('Windows Job Object controller asset integrity and host environment', () => {
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
