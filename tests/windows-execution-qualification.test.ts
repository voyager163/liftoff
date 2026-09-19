import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runWindowsJobCommand,
  verifyWindowsJobControllerAsset,
  windowsJobControllerAssetDigest,
  buildWindowsControllerHostEnvironment
} from '../src/adapters/process/windows-job-runner.js';
import { nativeExecutableObserver } from '../src/adapters/filesystem/executables.js';
import { resolveApplicationPreparationTools } from '../src/application/repair/application-toolchain.js';
import { workstationRequirementCatalog } from '../src/workstation-catalog.js';
import { ApplicationInspectionError } from '../src/application/repair/application-files.js';
import { NodeCommandRunner, type CommandRunner } from '../src/process-runner.js';
import { applicationSearchEnvironment } from '../src/application/repair/application-environment.js';

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTemp(prefix: string): Promise<string> {
  const dir = path.resolve(`.test-win-qual-${prefix}-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

describe('Windows execution qualification: Controller startup, command, and settlement deadlines (Task 3.1)', () => {
  it('separates controller startup deadline from command execution deadline and allows full execution time', async () => {
    const tempDir = await makeTemp('deadlines');

    // Mock controller that introduces an artificial 300ms delay during startup before sending ready,
    // then successfully executes command
    const mockControllerScript = path.join(tempDir, 'delayed-startup-controller.mjs');
    await writeFile(
      mockControllerScript,
      `
import net from 'node:net';
import fs from 'node:fs';

const pipeArg = process.argv[process.argv.indexOf('-ControlPipeName') + 1];
const nonce = process.argv[process.argv.indexOf('-ExpectedNonce') + 1];
const workspaceId = process.argv[process.argv.indexOf('-WorkspaceId') + 1];
const invocationId = process.argv[process.argv.indexOf('-InvocationId') + 1];

// Introduce startup delay before connecting
setTimeout(() => {
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
}, 300);
`
    );

    const result = await runWindowsJobCommand(
      { executable: process.execPath, args: ['--test'] },
      { timeoutMs: 5_000 },
      {
        skipAssetVerification: true,
        spawnController: (_cmd, args, opts) => spawn(process.execPath, [mockControllerScript, ...args], opts)
      }
    );

    expect(result.processTreeSettled).toBe(true);
    expect(result.processSpawned).toBe(true);
    expect(result.status).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('bounds ready-without-ack dispatch with SUPERVISOR_TIMEOUT and marks processSpawned: true to preserve workspace', async () => {
    const tempDir = await makeTemp('ready-no-ack');

    // A mock controller that connects and sends ready, but NEVER acknowledges the spawn request
    const mockControllerScript = path.join(tempDir, 'ready-no-ack-controller.mjs');
    await writeFile(
      mockControllerScript,
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

  // Keep socket and process alive listening for spawn, but do NOT send ack frame
  socket.on('data', () => {});
  const keepAlive = setInterval(() => {}, 1000);
  socket.on('close', () => clearInterval(keepAlive));
});
`
    );

    const result = await runWindowsJobCommand(
      { executable: process.execPath, args: ['--test'] },
      { timeoutMs: 300 },
      {
        skipAssetVerification: true,
        spawnController: (_cmd, args, opts) => spawn(process.execPath, [mockControllerScript, ...args], opts)
      }
    );

    expect(result.timedOut).toBe(true);
    // MUST report processSpawned: true to ensure active workspace is retained rather than cleaned
    expect(result.processSpawned).toBe(true);
    expect(result.processTreeSettled).toBe(false);
    expect(result.errorCode).toBe('SUPERVISOR_TIMEOUT');
    expect(result.errorMessage).toContain('Controller did not acknowledge');
  });
});

describe('Windows execution qualification: Tool identity, PATH precedence, and malicious shim rejection (Task 3.2)', () => {
  it('selects a compatible tool later in PATH when an earlier PATH directory contains an incompatible version', async () => {
    const tempDir = await makeTemp('tool-precedence');

    const projectRoot = path.join(tempDir, 'project');
    const stagingRoot = path.join(tempDir, 'staging');
    await mkdir(projectRoot);
    await mkdir(stagingRoot);

    // Directory 1: Outdated npm (version 11.19.0)
    const dir1 = path.join(tempDir, 'outdated-node');
    const dir1NpmModules = path.join(dir1, 'node_modules', 'npm');
    await mkdir(path.join(dir1NpmModules, 'bin'), { recursive: true });
    await writeFile(path.join(dir1, process.platform === 'win32' ? 'npm.cmd' : 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(path.join(dir1NpmModules, 'bin', 'npm-cli.js'), 'console.log("11.19.0");\n', { mode: 0o755 });
    await writeFile(path.join(dir1NpmModules, 'package.json'), JSON.stringify({ name: 'npm', version: '11.19.0' }));

    // Directory 2: Supported npm (version 12.0.2)
    const dir2 = path.join(tempDir, 'compatible-npm');
    const dir2NpmModules = path.join(dir2, 'node_modules', 'npm');
    await mkdir(path.join(dir2NpmModules, 'bin'), { recursive: true });
    await writeFile(path.join(dir2, process.platform === 'win32' ? 'npm.cmd' : 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(path.join(dir2NpmModules, 'bin', 'npm-cli.js'), 'console.log("12.0.2");\n', { mode: 0o755 });
    await writeFile(path.join(dir2NpmModules, 'package.json'), JSON.stringify({ name: 'npm', version: '12.0.2' }));

    // Node directory
    const dirNode = path.join(tempDir, 'node-bin');
    await mkdir(dirNode);
    const nodeExe = path.join(dirNode, process.platform === 'win32' ? 'node.exe' : 'node');
    const nodeScript = await readFile(process.execPath);
    await writeFile(nodeExe, nodeScript, { mode: 0o755 });

    const customEnv: NodeJS.ProcessEnv = {
      PATH: [dir1, dir2, dirNode].join(path.delimiter)
    };

    const mockRunner: CommandRunner = {
      async run(command) {
        if (command.args.some((a) => a.includes('compatible-npm'))) {
          return {
            command, displayCommand: 'npm probe', status: 0, signal: null,
            stdout: '12.0.2\n', stderr: '', timedOut: false
          };
        }
        if (command.args.some((a) => a.includes('outdated-node'))) {
          return {
            command, displayCommand: 'npm probe', status: 0, signal: null,
            stdout: '11.19.0\n', stderr: '', timedOut: false
          };
        }
        return {
          command, displayCommand: 'node probe', status: 0, signal: null,
          stdout: `${process.versions.node}\n`, stderr: '', timedOut: false
        };
      }
    };

    const preparation = [{ provider: 'npm-ci' as const, cwdPathParts: [], tools: ['node' as const, 'npm' as const] }];
    const resolved = await resolveApplicationPreparationTools(
      projectRoot,
      stagingRoot,
      preparation,
      { env: customEnv, runner: mockRunner }
    );

    const npmTool = resolved.find((t) => t.id === 'npm');
    expect(npmTool).toBeDefined();
    expect(npmTool?.version).toBe('12.0.2');
    expect(npmTool?.launcherPath).toContain('compatible-npm');
  });

  it('fails closed with [incompatible-tool] when only an incompatible version is installed on PATH', async () => {
    const tempDir = await makeTemp('tool-incompat');

    const projectRoot = path.join(tempDir, 'project');
    const stagingRoot = path.join(tempDir, 'staging');
    await mkdir(projectRoot);
    await mkdir(stagingRoot);

    const dir1 = path.join(tempDir, 'outdated-node');
    const dir1NpmModules = path.join(dir1, 'node_modules', 'npm');
    await mkdir(path.join(dir1NpmModules, 'bin'), { recursive: true });
    await writeFile(path.join(dir1, process.platform === 'win32' ? 'npm.cmd' : 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(path.join(dir1NpmModules, 'bin', 'npm-cli.js'), 'console.log("11.19.0");\n', { mode: 0o755 });
    await writeFile(path.join(dir1NpmModules, 'package.json'), JSON.stringify({ name: 'npm', version: '11.19.0' }));

    const dirNode = path.join(tempDir, 'node-bin');
    await mkdir(dirNode);
    const nodeExe = path.join(dirNode, process.platform === 'win32' ? 'node.exe' : 'node');
    await writeFile(nodeExe, await readFile(process.execPath), { mode: 0o755 });

    const customEnv: NodeJS.ProcessEnv = {
      PATH: [dir1, dirNode].join(path.delimiter)
    };

    const mockRunner: CommandRunner = {
      async run(command) {
        return {
          command, displayCommand: 'probe', status: 0, signal: null,
          stdout: command.executable.includes('node') ? `${process.versions.node}\n` : '11.19.0\n',
          stderr: '', timedOut: false
        };
      }
    };

    const preparation = [{ provider: 'npm-ci' as const, cwdPathParts: [], tools: ['node' as const, 'npm' as const] }];
    await expect(
      resolveApplicationPreparationTools(projectRoot, stagingRoot, preparation, { env: customEnv, runner: mockRunner })
    ).rejects.toThrow(/\[incompatible-tool\]/);
  });

  it('rejects malicious tool shims inside project or staging directory with [untrusted-tool]', async () => {
    const tempDir = await makeTemp('tool-malicious');

    const projectRoot = path.join(tempDir, 'project');
    const stagingRoot = path.join(tempDir, 'staging');
    await mkdir(projectRoot);
    await mkdir(stagingRoot);

    const maliciousTools = path.join(projectRoot, 'tools');
    await mkdir(maliciousTools);
    await writeFile(path.join(maliciousTools, process.platform === 'win32' ? 'node.cmd' : 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    // Link an external PATH entry into the project tools to verify symlink / junction detection
    const externalAlias = path.join(tempDir, 'tool-alias');
    const { symlink } = await import('node:fs/promises');
    await symlink(maliciousTools, externalAlias, 'junction');

    const customEnv: NodeJS.ProcessEnv = {
      PATH: externalAlias
    };

    const preparation = [{ provider: 'npm-ci' as const, cwdPathParts: [], tools: ['node' as const] }];
    await expect(
      resolveApplicationPreparationTools(projectRoot, stagingRoot, preparation, { env: customEnv })
    ).rejects.toThrow(/\[untrusted-tool\]/);
  });

  it('propagates [untrusted-tool] when first candidate resolves in project scope without skipping to later good candidate', async () => {
    const tempDir = await makeTemp('untrusted-precedes-good');

    const projectRoot = path.join(tempDir, 'project');
    const stagingRoot = path.join(tempDir, 'staging');
    await mkdir(projectRoot);
    await mkdir(stagingRoot);

    // Candidate 1: malicious shim inside project root
    const maliciousTools = path.join(projectRoot, 'tools');
    await mkdir(maliciousTools);
    await writeFile(path.join(maliciousTools, process.platform === 'win32' ? 'node.cmd' : 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const externalAlias = path.join(tempDir, 'external-alias');
    const { symlink } = await import('node:fs/promises');
    await symlink(maliciousTools, externalAlias, 'junction');

    // Candidate 2: good compatible Node
    const goodNodeDir = path.join(tempDir, 'good-node');
    await mkdir(goodNodeDir);
    const goodNodeExe = path.join(goodNodeDir, process.platform === 'win32' ? 'node.exe' : 'node');
    await writeFile(goodNodeExe, await readFile(process.execPath), { mode: 0o755 });

    const customEnv: NodeJS.ProcessEnv = {
      PATH: [externalAlias, goodNodeDir].join(path.delimiter)
    };

    const preparation = [{ provider: 'npm-ci' as const, cwdPathParts: [], tools: ['node' as const] }];
    // MUST fail closed with [untrusted-tool], must NOT silently skip to good-node!
    await expect(
      resolveApplicationPreparationTools(projectRoot, stagingRoot, preparation, { env: customEnv })
    ).rejects.toThrow(/\[untrusted-tool\]/);
  });

  it('propagates [tool-probe-*] when first candidate probe fails without skipping to later candidate', async () => {
    const tempDir = await makeTemp('failing-probe-precedes-good');

    const projectRoot = path.join(tempDir, 'project');
    const stagingRoot = path.join(tempDir, 'staging');
    await mkdir(projectRoot);
    await mkdir(stagingRoot);

    // Candidate 1
    const dir1 = path.join(tempDir, 'node-1');
    await mkdir(dir1);
    const node1 = path.join(dir1, process.platform === 'win32' ? 'node.exe' : 'node');
    await writeFile(node1, await readFile(process.execPath), { mode: 0o755 });

    // Candidate 2
    const dir2 = path.join(tempDir, 'node-2');
    await mkdir(dir2);
    const node2 = path.join(dir2, process.platform === 'win32' ? 'node.exe' : 'node');
    await writeFile(node2, await readFile(process.execPath), { mode: 0o755 });

    const customEnv: NodeJS.ProcessEnv = {
      PATH: [dir1, dir2].join(path.delimiter)
    };

    const mockRunner: CommandRunner = {
      async run(command) {
        if (command.executable.includes('node-1')) {
          // Probe fails with exit code 1
          return {
            command, displayCommand: 'probe 1', status: 1, signal: null,
            stdout: '', stderr: 'Internal error', timedOut: false
          };
        }
        return {
          command, displayCommand: 'probe 2', status: 0, signal: null,
          stdout: `${process.versions.node}\n`, stderr: '', timedOut: false
        };
      }
    };

    const preparation = [{ provider: 'npm-ci' as const, cwdPathParts: [], tools: ['node' as const] }];
    // MUST fail closed with probe failure, not skip to node-2!
    await expect(
      resolveApplicationPreparationTools(projectRoot, stagingRoot, preparation, { env: customEnv, runner: mockRunner })
    ).rejects.toThrow(/\[tool-probe-check-failed\]/);
  });

  it('recognizes Windows official npm shims with %~dp0 and %dp0% patterns', async () => {
    const tempDir = await makeTemp('npm-shim');

    const shimWithTilde = path.join(tempDir, 'npm-tilde.cmd');
    await writeFile(shimWithTilde, '@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n', { mode: 0o755 });

    const shimStandard = path.join(tempDir, 'npm-std.cmd');
    await writeFile(shimStandard, '@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n', { mode: 0o755 });

    const context = {
      platform: process.platform as 'darwin' | 'win32' | 'linux',
      cwd: tempDir,
      env: {},
      definition: {
        ...workstationRequirementCatalog.npm,
        packageIdentities: { npm: 'npm' }
      }
    };

    const identityTilde = await nativeExecutableObserver.inspect(shimWithTilde, context);
    expect(identityTilde.origin).toBe('npm');
    expect(identityTilde.kind).toBe('shim');

    const identityStd = await nativeExecutableObserver.inspect(shimStandard, context);
    expect(identityStd.origin).toBe('npm');
    expect(identityStd.kind).toBe('shim');
  });

  it('normalizes environment PATH and deduplicates case-insensitive aliases', () => {
    const isWin = process.platform === 'win32';
    const testPath = isWin ? 'C:\\Tools;C:\\Windows' : '/tools:/usr/bin';
    const envWithAliases: NodeJS.ProcessEnv = {
      PATH: testPath,
      Path: testPath,
      SystemRoot: 'C:\\Windows',
      SYSTEMROOT: 'C:\\Windows'
    };

    const normalized = applicationSearchEnvironment(
      envWithAliases,
      isWin ? 'C:\\project' : '/project',
      isWin ? 'C:\\staging' : '/staging',
      isWin ? 'C:\\cwd' : '/cwd'
    );
    expect(normalized.PATH).toBe(testPath);
    expect(normalized.Path).toBeUndefined();
    expect(normalized.SystemRoot).toBe('C:\\Windows');
    if (isWin) {
      expect(normalized.SystemDrive).toBe('C:');
    }
  });
});

describe('Windows execution qualification: Controller launch, auth, and Win32 Job Object settlement (Tasks 3.3, 3.4, 3.5)', () => {
  it('fails closed when controller reports uncertain settlement (activeProcesses > 0)', async () => {
    const tempDir = await makeTemp('uncertain-settle');

    const mockPs = path.join(tempDir, 'mock-controller-uncertain.mjs');
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

          // Send response with activeProcesses: 2 and settled: false (orphan processes still alive)
          const resp = {
            schemaVersion: 1,
            kind: 'response',
            controllerId: 'liftoff-windows-job-controller-v1',
            workspaceId,
            invocationId,
            nonce,
            sequence: 1,
            phase: 'failed',
            status: 1,
            signal: null,
            activeProcesses: 2,
            jobTerminated: false,
            settled: false,
            error: 'Orphan descendant processes remain active in Job Object.'
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
      { timeoutMs: 5_000 },
      {
        skipAssetVerification: true,
        spawnController: (_cmd, args, opts) => spawn(process.execPath, [mockPs, ...args], opts)
      }
    );

    expect(result.processTreeSettled).toBe(false);
    expect(result.processSpawned).toBe(true);
    expect(result.errorCode).toBe('JOB_EXECUTION_ERROR');
    expect(result.errorMessage).toContain('Orphan descendant processes remain active');
  });

  it('rejects corrupted controller assets with CORRUPTED_CONTROLLER_ASSET without executing', async () => {
    const tempDir = await makeTemp('corrupt');

    const corruptedAsset = path.join(tempDir, 'windows-job-controller.ps1');
    await writeFile(corruptedAsset, '# corrupted asset\n');

    await expect(verifyWindowsJobControllerAsset(corruptedAsset)).rejects.toThrow(/integrity failure/);

    const result = await runWindowsJobCommand(
      { executable: process.execPath, args: ['--test'] },
      {},
      { assetPath: corruptedAsset }
    );

    expect(result.processTreeSettled).toBe(false);
    expect(result.processSpawned).toBe(false);
    expect(result.errorCode).toBe('CORRUPTED_CONTROLLER_ASSET');
  });

  it('verifies the real packaged controller asset matches the pinned digest', async () => {
    const assetPath = await verifyWindowsJobControllerAsset();
    expect(assetPath).toBeDefined();
    const bytes = await readFile(assetPath);
    const hash = createHash('sha256').update(bytes).digest('hex');
    expect(hash).toBe(windowsJobControllerAssetDigest);
  });

  it('admits signed helper identities with a bound expectedDigest from build resource manifests', async () => {
    const tempDir = await makeTemp('signed-helper');
    const signedAsset = path.join(tempDir, 'signed-windows-job-controller.ps1');
    const baseBytes = await readFile(await verifyWindowsJobControllerAsset());
    const signedBytes = Buffer.concat([baseBytes, Buffer.from('\n# SIG # Begin signature block\n# dummy signature\n')]);
    await writeFile(signedAsset, signedBytes);

    const signedDigest = createHash('sha256').update(signedBytes).digest('hex');

    // Without expectedDigest, fails because digest != unsigned source digest
    await expect(verifyWindowsJobControllerAsset(signedAsset)).rejects.toThrow(/integrity failure/);

    // With expectedDigest bound by resource manifest, admits signed bytes
    const admittedPath = await verifyWindowsJobControllerAsset(signedAsset, signedDigest);
    expect(admittedPath).toBe(signedAsset);
  });

  it('detects CONTROLLER_EXITED_UNEXPECTEDLY when controller process exits after connecting', async () => {
    const tempDir = await makeTemp('controller-crash');

    // A mock controller that connects, sends ready, but exits before completing
    const mockPs = path.join(tempDir, 'mock-crash.mjs');
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
  socket.write(Buffer.concat([h0, readyBytes]), () => {
    // Premature crash
    setTimeout(() => {
      process.exit(42);
    }, 50);
  });
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
    expect(['CONTROLLER_EXITED_UNEXPECTEDLY', 'CONTROL_PIPE_DISCONNECTED']).toContain(result.errorCode);
  });

  it('fails with [changed-tool] when an approved tool launcher or bytes change before effects', async () => {
    const { assertApplicationToolsCurrent } = await import('../src/application/repair/application-toolchain.js');
    const tempDir = await makeTemp('tool-changed-pre-effect');

    const projectRoot = path.join(tempDir, 'project');
    const stagingRoot = path.join(tempDir, 'staging');
    await mkdir(projectRoot);
    await mkdir(stagingRoot);

    const toolsDir = path.join(tempDir, 'tools');
    await mkdir(toolsDir);
    const toolExe = path.join(toolsDir, process.platform === 'win32' ? 'node.exe' : 'node');
    await writeFile(toolExe, await readFile(process.execPath), { mode: 0o755 });

    // Use toolchain toolFile to capture authentic file identity
    const { resolveApplicationPreparationTools } = await import('../src/application/repair/application-toolchain.js');
    const mockRunner: CommandRunner = {
      async run(command) {
        return {
          command, displayCommand: 'probe', status: 0, signal: null,
          stdout: `${process.versions.node}\n`, stderr: '', timedOut: false
        };
      }
    };
    const preparation = [{ provider: 'npm-ci' as const, cwdPathParts: [], tools: ['node' as const] }];
    const resolved = await resolveApplicationPreparationTools(projectRoot, stagingRoot, preparation, {
      env: { PATH: toolsDir }, runner: mockRunner
    });
    const mockTool = resolved.find((t) => t.id === 'node')!;

    // Case 1: Unchanged -> succeeds
    await expect(assertApplicationToolsCurrent(projectRoot, stagingRoot, [mockTool])).resolves.toBeUndefined();

    // Case 2: Modified bytes before effect -> throws [changed-tool]
    await writeFile(toolExe, Buffer.concat([await readFile(toolExe), Buffer.from('\n')]));
    await expect(assertApplicationToolsCurrent(projectRoot, stagingRoot, [mockTool])).rejects.toThrow(/\[changed-tool\]/);
  });

  it('preserves potentially active output files on disk when settlement is uncertain', async () => {
    const tempDir = await makeTemp('uncertain-preserve-logs');
    let capturedStdoutFile = '';

    const mockPs = path.join(tempDir, 'mock-uncertain-files.mjs');
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
          // Write log outputs that must be preserved on disk
          fs.writeFileSync(payload.stdoutFile, 'active stdout data');
          fs.writeFileSync(payload.stderrFile, 'active stderr data');

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
            phase: 'failed',
            status: 1,
            signal: null,
            activeProcesses: 1,
            jobTerminated: false,
            settled: false,
            error: 'Active descendant process remained'
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
      { timeoutMs: 5_000 },
      {
        skipAssetVerification: true,
        spawnController: (_cmd, args, opts) => spawn(process.execPath, [mockPs, ...args], opts)
      }
    );

    expect(result.processTreeSettled).toBe(false);
    expect(result.errorCode).toBe('JOB_EXECUTION_ERROR');

    // The output files must NOT have been unlinked because settlement was uncertain
    expect(result.stdout).toBe('active stdout data');
    expect(result.stderr).toBe('active stderr data');
  });

  it('detects concurrent log replacement when output log is replaced with a directory', async () => {
    const tempDir = await makeTemp('dir-log-replacement');

    const mockPs = path.join(tempDir, 'mock-dir-replacement.mjs');
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
          // Replace stdoutFile with a directory to test non-regular file detection
          fs.mkdirSync(payload.stdoutFile);
          fs.writeFileSync(payload.stderrFile, '');

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
      { timeoutMs: 5_000 },
      {
        skipAssetVerification: true,
        spawnController: (_cmd, args, opts) => spawn(process.execPath, [mockPs, ...args], opts)
      }
    );

    expect(result.processTreeSettled).toBe(false);
    expect(result.errorCode).toBe('LOG_READ_FAILED');
    expect(result.errorMessage).toContain('concurrent replacement or directory link detected');
  });

  it('surfaces LOG_READ_FAILED when execution log file is missing after dispatch', async () => {
    const tempDir = await makeTemp('missing-log-after-dispatch');

    const mockPs = path.join(tempDir, 'mock-missing-log.mjs');
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
          // Do NOT create stdoutFile or stderrFile, leaving them missing after dispatch

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
      { timeoutMs: 5_000 },
      {
        skipAssetVerification: true,
        spawnController: (_cmd, args, opts) => spawn(process.execPath, [mockPs, ...args], opts)
      }
    );

    expect(result.processTreeSettled).toBe(false);
    expect(result.errorCode).toBe('LOG_READ_FAILED');
    expect(result.errorMessage).toContain('Failed to read execution logs');
  });
});
