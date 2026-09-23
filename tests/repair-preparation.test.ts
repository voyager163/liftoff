import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectApplicationLayout, inspectApplicationPatch, applicationCandidateDigest, verifyApplicationPatch } from '../src/application/repair/application-patch.js';
import { applicationPreparationSupport } from '../src/application/repair/application-preparation-policy.js';
import { parseApplicationPreparation } from '../src/application/repair/application-preparation-inputs.js';
import { NodeCommandRunner, type CommandResult, type CommandRunner } from '../src/process-runner.js';
import { applicationVerificationFixtureContext, putApplicationFixtureFile } from './fixtures/repair-application.js';
import { createPreparationFixture, type PreparationFixture } from './fixtures/repair-preparation.js';
import type { ApplicationPatchCandidate } from '../src/application/repair/application-types.js';

const roots: string[] = [];
async function fixture(options: Parameters<typeof createPreparationFixture>[1] = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lf prep ')));
  roots.push(root);
  return createPreparationFixture(root, options);
}
async function save(f: PreparationFixture, refresh = false) {
  if (refresh) {
    const inspected = await inspectApplicationLayout(f.root, f.manifest);
    expect(inspected.report.blockers).toEqual([]);
    f.document.inspectionDigest = inspected.report.inspectionDigest;
    f.document.targetLayoutDigest = inspected.report.target!.digest;
  }
  await putApplicationFixtureFile(f.stage, ['patch.json'], `${JSON.stringify(f.document, null, 2)}\n`, 0o600);
}
const successful = (command: CommandResult['command'], stdout = ''): CommandResult => ({
  command, displayCommand: '', status: 0, signal: null, stdout, stderr: '', timedOut: false, processTreeSettled: true
});
function executionRunner(candidate: ApplicationPatchCandidate, execute: CommandRunner['run']): CommandRunner {
  return { run: vi.fn(async (command, options) => {
    const probe = candidate.verificationPolicy.toolchain.find((tool) =>
      tool.probe.executable === command.executable && JSON.stringify(tool.probe.args) === JSON.stringify(command.args));
    if (probe) return successful(command, probe.id === 'go' ? `go version go${probe.version} ${process.platform}/${process.arch}` :
      probe.id === 'python' ? `Python ${probe.version}` : probe.id === 'uv' ? `uv ${probe.version}` : probe.version);
    return execute(command, options);
  }) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 2 })));
});

describe('registered locked preparation input and tool contracts', () => {
  it('publishes a static explicit provider/source/tool matrix and treats absence as none', () => {
    expect(parseApplicationPreparation(undefined)).toEqual([]);
    expect(parseApplicationPreparation([])).toEqual([]);
    expect(applicationPreparationSupport.providers.map((item) => [item.id, item.version])).toEqual([
      ['npm-ci', 1], ['uv-locked-sync', 1], ['go-mod-download', 1]
    ]);
    expect(applicationPreparationSupport.frontendQualification).toBe('build-only-unless-the-project-declares-tests');
    expect(applicationPreparationSupport.providers.find((item) => item.id === 'go-mod-download')?.inputs).toEqual(['go.mod', 'go.sum']);
  });

  it('binds actual generated Node/backend and Vue inputs plus canonical installed launcher/interpreter identities', async () => {
    const f = await fixture({ frontend: true });
    const runner = new NodeCommandRunner(), spy = vi.spyOn(runner, 'run');
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath, { runner });
    expect(candidate.blockers).toEqual([]);
    expect(candidate.verificationPolicy.effects).toMatchObject({ preparation: true, network: true, lifecycle: false, securitySandbox: false });
    expect(candidate.networkRequired).toBe(true);
    expect(candidate.verificationPolicy.preparation.map((item) => item.component.logicalName)).toEqual(['node-backend-package', 'frontend-package']);
    for (const tool of candidate.verificationPolicy.toolchain) {
      expect(path.isAbsolute(tool.executablePath)).toBe(true);
      expect(tool.files.every((file) => /^[a-f0-9]{64}$/u.test(file.digest) && file.bytes > 0)).toBe(true);
    }
    const npm = candidate.verificationPolicy.toolchain.find((tool) => tool.id === 'npm')!;
    const node = candidate.verificationPolicy.toolchain.find((tool) => tool.id === 'node')!;
    expect(npm.executablePath).toBe(node.executablePath);
    expect(npm.prefixArgs[0]).toMatch(/npm-cli\.js$/u);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [command, options] of spy.mock.calls) {
      expect(command.args.at(-1)).toBe('--version');
      expect(options?.cwd).not.toBe(f.root);
      expect(options?.cwd).not.toBe(f.stage);
      expect(options?.env?.HOME).not.toBe(process.env.HOME);
      expect(options?.env?.npm_config_ignore_scripts).toBe('true');
      expect(options?.env?.GOTOOLCHAIN).toBe('local');
    }
  });

  it('does not probe tools during capabilities-style matrix reads, inventory, or a no-preparation patch inspection', async () => {
    const f = await fixture();
    delete f.document.verification.preparation;
    await save(f);
    const runner: CommandRunner = { run: vi.fn(async (command) => successful(command, 'must not run')) };
    const inventory = await inspectApplicationLayout(f.root, f.manifest);
    expect(inventory.report.complete).toBe(true);
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath, { runner });
    expect(candidate.blockers).toEqual([]);
    expect(candidate.verificationPolicy.preparation).toEqual([]);
    expect(candidate.verificationPolicy.toolchain).toEqual([]);
    expect(candidate.verificationPolicy.effects.preparation).toBe(false);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown provider', { provider: 'npm-install' }],
    ['unknown provider version', { version: 2 }],
    ['unregistered source', { packageSource: 'https://private.invalid/token' }],
    ['lifecycle enabling', { lifecycle: 'enabled' }],
    ['arbitrary installer args', { args: ['install', '--global'] }],
    ['workspace cwd', { cwdPathParts: ['..', 'outside'] }]
  ])('rejects %s before any metadata probe or preparation', async (_name, changes) => {
    const f = await fixture();
    Object.assign(f.document.verification.preparation![0]!, changes);
    await save(f);
    const runner: CommandRunner = { run: vi.fn(async (command) => successful(command)) };
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath, { runner });
    expect(candidate.blockers.length).toBeGreaterThan(0);
    expect(candidate.mutations).toEqual([]);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it.each(['missing lock', 'mismatched lock', 'workspace', 'local source', 'authenticated URL', 'queried URL', 'escaping URL', 'linked package'])(
    'rejects %s without installing or probing tools', async (kind) => {
      const f = await fixture();
      const packagePath = path.join(f.root, 'backend', 'package.json'), lockPath = path.join(f.root, 'backend', 'package-lock.json');
      const project = JSON.parse(await readFile(packagePath, 'utf8'));
      const lock = JSON.parse(await readFile(lockPath, 'utf8'));
      const dependency = Object.values(lock.packages).find((entry: unknown) =>
        typeof entry === 'object' && entry !== null && 'integrity' in entry) as Record<string, unknown>;
      if (kind === 'missing lock') await rm(lockPath);
      if (kind === 'mismatched lock') project.dependencies.fastify = '^99.0.0';
      if (kind === 'workspace') project.workspaces = ['packages/*'];
      if (kind === 'local source') {
        project.dependencies.fastify = 'file:../../PRIVATE_SOURCE';
        lock.packages[''].dependencies.fastify = project.dependencies.fastify;
      }
      if (kind === 'authenticated URL') dependency.resolved = 'https://PRIVATE_USER:PRIVATE_TOKEN@registry.npmjs.org/pkg/-/pkg.tgz';
      if (kind === 'queried URL') dependency.resolved = 'https://registry.npmjs.org/pkg/-/pkg.tgz?token=PRIVATE_TOKEN';
      if (kind === 'escaping URL') dependency.resolved = 'https://registry.npmjs.org/pkg/../PRIVATE_SOURCE.tgz';
      if (kind === 'linked package') dependency.link = true;
      await putApplicationFixtureFile(f.root, ['backend', 'package.json'], JSON.stringify(project));
      if (kind !== 'missing lock') await putApplicationFixtureFile(f.root, ['backend', 'package-lock.json'], JSON.stringify(lock));
      await save(f, true);
      const runner: CommandRunner = { run: vi.fn(async (command) => successful(command)) };
      const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath, { runner });
      expect(candidate.blockers.length).toBeGreaterThan(0);
      expect(JSON.stringify(candidate.report)).not.toContain('PRIVATE_');
      expect(runner.run).not.toHaveBeenCalled();
    }
  );

  it('reports missing installed tools rather than installing them', async () => {
    const f = await fixture();
    const runner: CommandRunner = { run: vi.fn(async (command) => successful(command)) };
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath, { runner, env: { PATH: '', Path: '' } });
    expect(candidate.blockers.join(' ')).toContain('[missing-tool]');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('rejects a project PATH shim even when it prints the expected version', async () => {
    const f = await fixture();
    await putApplicationFixtureFile(f.root, ['tools', process.platform === 'win32' ? 'node.cmd' : 'node'], '#!/bin/sh\necho v24.21.0\n', 0o755);
    await save(f, true);
    const runner: CommandRunner = { run: vi.fn(async (command) => successful(command, '24.21.0')) };
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath, { runner, env: { PATH: path.join(f.root, 'tools') } });
    expect(candidate.blockers.join(' ')).toMatch(/missing-tool|untrusted-tool/u);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('refuses a linked external PATH alias into project tool shims before running it', async () => {
    const f = await fixture();
    await putApplicationFixtureFile(f.root, ['tools', process.platform === 'win32' ? 'node.exe' : 'node'], 'not a real binary', 0o755);
    const alias = path.join(f.directory, 'tool-alias');
    await symlink(path.join(f.root, 'tools'), alias, 'junction');
    await save(f, true);
    const runner: CommandRunner = { run: vi.fn(async (command) => successful(command, '24.21.0')) };
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath, { runner, env: { PATH: alias } });
    expect(candidate.blockers.join(' ')).toContain('untrusted-tool');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('rejects changed installed executable bytes despite unchanged advertised version text', async () => {
    const f = await fixture();
    const tools = path.join(f.directory, 'private-test-tools');
    await mkdir(tools);
    const node = path.join(tools, process.platform === 'win32' ? 'node.exe' : 'node');
    await copyFile(process.execPath, node);
    await chmod(node, 0o755);
    const env = { ...process.env, PATH: [tools, process.env.PATH ?? ''].join(path.delimiter) };
    const baseline = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(baseline.blockers).toEqual([]);
    const probes: CommandRunner = { run: vi.fn(async (command) => successful(command,
      command.args.some((arg) => arg.endsWith('npm-cli.js'))
        ? baseline.verificationPolicy.toolchain.find((tool) => tool.id === 'npm')!.version
        : baseline.verificationPolicy.toolchain.find((tool) => tool.id === 'node')!.version)) };
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath, { env, runner: probes });
    expect(candidate.blockers).toEqual([]);
    const context = await applicationVerificationFixtureContext(f.root, candidate,
      { projectCode: true, dependencyPreparation: true, network: true }, { env });
    const before = await readFile(node);
    await putApplicationFixtureFile(tools, [path.basename(node)], Buffer.concat([before, Buffer.from('\n')]), 0o755);
    const runner: CommandRunner = { run: vi.fn(async (command) => successful(command, '24.21.0')) };
    const verified = await verifyApplicationPatch(f.root, candidate, runner, context);
    expect(verified.status).toBe('blocked');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it.each(['projectCode', 'dependencyPreparation', 'network'] as const)('requires independent %s permission before registered effects', async (permission) => {
    const f = await fixture();
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(candidate.blockers).toEqual([]);
    const permissions = { projectCode: true, dependencyPreparation: true, network: true, [permission]: false };
    const context = await applicationVerificationFixtureContext(f.root, candidate, permissions);
    const runner: CommandRunner = { run: vi.fn(async (command) => successful(command)) };
    const verified = await verifyApplicationPatch(f.root, candidate, runner, context);
    expect(verified.status).toBe('blocked');
    expect(verified.workspaceId).toBeUndefined();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('cannot use a caller-invented fingerprint instead of the real saved preview', async () => {
    const f = await fixture();
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(candidate.blockers).toEqual([]);
    const context = await applicationVerificationFixtureContext(f.root, candidate, { projectCode: true, dependencyPreparation: true, network: true });
    context.preview = { ...context.preview, fingerprint: applicationCandidateDigest(candidate) };
    const runner: CommandRunner = { run: vi.fn(async (command) => successful(command)) };
    const verified = await verifyApplicationPatch(f.root, candidate, runner, context);
    expect(verified.status).toBe('blocked');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('blocks lock mutations by a preparation command before project checks and keeps originals intact', async () => {
    const f = await fixture();
    const before = await readFile(path.join(f.root, 'backend', 'package-lock.json'));
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(candidate.blockers).toEqual([]);
    const context = await applicationVerificationFixtureContext(f.root, candidate, { projectCode: true, dependencyPreparation: true, network: true });
    const runner = executionRunner(candidate, async (command, options) => {
      await putApplicationFixtureFile(options!.cwd!, ['package-lock.json'], '{"PRIVATE_MODIFIED_LOCK":true}');
      return successful(command);
    });
    const verified = await verifyApplicationPatch(f.root, candidate, runner, context);
    expect(verified.status).toBe('failed');
    expect(verified.blockers.join(' ')).toContain('changed-candidate-input');
    expect(verified.commands).toEqual([]);
    expect(JSON.stringify(verified)).not.toContain('PRIVATE_');
    expect(await readFile(path.join(f.root, 'backend', 'package-lock.json'))).toEqual(before);
  });

  it('does not claim frontend tests that the generated package does not declare', async () => {
    const f = await fixture({ frontend: true });
    f.document.verification.commands.push({
      executable: 'npm', args: ['test', '--ignore-scripts'], cwdPathParts: ['frontend'],
      timeoutMs: 10_000, maxOutputBytes: 16_384, network: false
    });
    await save(f);
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(candidate.blockers.join(' ')).toContain('missing-check');
    expect(candidate.mutations).toEqual([]);
  });

  it('detects unref descendant in process group with real NodeCommandRunner, blocks release and retains workspace', async () => {
    const f = await fixture();
    const scriptPath = ['backend', 'test', 'spawn-descendant.cjs'];
    const scriptContent = `
      const { spawn } = require('node:child_process');
      const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'ignore' });
      descendant.unref();
      process.exit(0);
    `;
    await putApplicationFixtureFile(f.root, scriptPath, scriptContent);
    f.document.verification.commands = [{
      executable: 'node', args: ['backend/test/spawn-descendant.cjs'], cwdPathParts: [],
      timeoutMs: process.platform === 'win32' ? 2_000 : 10_000, maxOutputBytes: 16_384, network: false
    }];
    delete f.document.verification.preparation;
    await save(f, true);
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(candidate.blockers).toEqual([]);
    const context = await applicationVerificationFixtureContext(f.root, candidate, {
      projectCode: true, dependencyPreparation: false, network: false
    });
    const runner = new NodeCommandRunner();
    const verified = await verifyApplicationPatch(f.root, candidate, runner, context);
    expect(verified.status).toBe('failed');
    if (process.platform === 'win32') {
      expect(verified.commands[0]?.timedOut).toBe(true);
      expect(verified.cleanupComplete).toBe(true);
      expect(verified.retainedWorkspace).toBeUndefined();
    } else {
      expect(verified.cleanupComplete).toBe(false);
      expect(verified.retainedWorkspace).toBeDefined();
      expect(verified.blockers.join(' ')).toContain('[workspace-cleanup] Registered workspace cleanup is blocked or incomplete');
    }
  }, 30_000);

  it.each([
    ['node', ['--eval=console.log(123)//.js']],
    ['node', ['--test', '--eval=console.log(123)//.js']],
    ['node', ['--require=./tests/quote.test.mjs']],
    ['python', ['-I', '-c=print(123)//.py']],
    ['python', ['-m', 'pytest', '-o=rootdir=test.py']]
  ])('rejects leading-option %s script operands %j at preview', async (executable, args) => {
    const f = await fixture({ stack: executable === 'python' ? 'python-fastapi' : 'node-fastify' });
    f.document.verification.commands = [{
      executable, args: [...args],
      cwdPathParts: [], timeoutMs: 10_000, maxOutputBytes: 16_384, network: false
    }];
    delete f.document.verification.preparation;
    await save(f);
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(candidate.blockers.join(' ')).toContain('Verification must invoke an exact inspected or staged local check file');
  });

  it('rejects Go module mode overrides during verification checks', async () => {
    const f = await fixture({ stack: 'go-huma' });
    f.document.verification.commands = [{
      executable: 'go', args: ['test', '-mod=mod', './...'],
      cwdPathParts: ['backend'], timeoutMs: 10_000, maxOutputBytes: 16_384, network: false
    }];
    delete f.document.verification.preparation;
    await save(f);
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(candidate.blockers.join(' ')).toContain('Go verification cannot override executors, module files, working roots, or output locations');
  });

  it('preserves legitimate explicit relative paths starting with dot-slash and dash', async () => {
    const f = await fixture({ stack: 'node-fastify' });
    await putApplicationFixtureFile(f.root, ['backend', 'test', '-dash-test.cjs'], 'console.log("ok");\n');
    f.document.verification.commands = [{
      executable: 'node', args: ['./backend/test/-dash-test.cjs'],
      cwdPathParts: [], timeoutMs: 10_000, maxOutputBytes: 16_384, network: false
    }];
    delete f.document.verification.preparation;
    await save(f, true);
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(candidate.blockers).toEqual([]);
  });

  it.each([
    ['node-fastify', 'npm_config_offline', 'true'],
    ['python-fastapi', 'PIP_NO_INDEX', '1'],
    ['python-fastapi', 'UV_OFFLINE', '1'],
    ['go-huma', 'GOPROXY', 'off'],
    ['go-huma', 'GOSUMDB', 'off']
  ] as const)('forces PM offline/no-index during check for %s (%s=%s) even with check network authorized', async (stack, envKey, expectedValue) => {
    const f = await fixture({ stack: stack as any });
    delete f.document.verification.preparation;
    f.document.verification.commands[0]!.network = true;
    await save(f, true);
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(candidate.blockers).toEqual([]);
    const runnerCalls: { env?: NodeJS.ProcessEnv }[] = [];
    const runner: CommandRunner = {
      run: vi.fn(async (command, options) => {
        runnerCalls.push({ env: options?.env });
        return successful(command);
      })
    };
    const context = await applicationVerificationFixtureContext(f.root, candidate, {
      projectCode: true, dependencyPreparation: false, network: true
    });
    const verified = await verifyApplicationPatch(f.root, candidate, runner, context);
    expect(verified.status).toBe('passed');
    const checkEnv = runnerCalls.find((call) => call.env?.[envKey] !== undefined)?.env;
    expect(checkEnv?.[envKey]).toBe(expectedValue);
    expect(checkEnv?.LIFTOFF_APPLICATION_NETWORK).toBe('declared-allowed');
  });

  it('enables package source network fetching only during approved preparation commands', async () => {
    const f = await fixture({ frontend: false });
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(candidate.blockers).toEqual([]);
    const prepCalls: { env?: NodeJS.ProcessEnv }[] = [];
    const checkCalls: { env?: NodeJS.ProcessEnv }[] = [];
    const runner = executionRunner(candidate, async (command, options) => {
      if (command.args.includes('ci')) {
        prepCalls.push({ env: options?.env });
        await mkdir(path.join(options!.cwd!, 'node_modules'), { recursive: true, mode: 0o700 });
      } else {
        checkCalls.push({ env: options?.env });
      }
      return successful(command);
    });
    const context = await applicationVerificationFixtureContext(f.root, candidate, {
      projectCode: true, dependencyPreparation: true, network: true
    });
    const verified = await verifyApplicationPatch(f.root, candidate, runner, context);
    expect(verified.status).toBe('passed');
    expect(prepCalls[0]?.env?.npm_config_offline).toBe('false');
    expect(prepCalls[0]?.env?.npm_config_registry).toBeDefined();
    expect(checkCalls[0]?.env?.npm_config_offline).toBe('true');
  });

  it('fails closed when runner reports unsupported process-tree settlement, preserving workspace without effects', async () => {
    const f = await fixture();
    delete f.document.verification.preparation;
    await save(f, true);
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(candidate.blockers).toEqual([]);
    const runner: CommandRunner = {
      run: vi.fn(async (command) => ({
        command, displayCommand: '', status: null, signal: null, stdout: '', stderr: '',
        timedOut: false, processTreeSettled: false, errorCode: 'UNSUPPORTED_PROCESS_SETTLEMENT',
        errorMessage: 'Process-tree settlement verification is unsupported on Windows.'
      }))
    };
    const context = await applicationVerificationFixtureContext(f.root, candidate, {
      projectCode: true, dependencyPreparation: false, network: false
    });
    const verified = await verifyApplicationPatch(f.root, candidate, runner, context);
    expect(verified.status).toBe('failed');
    expect(verified.cleanupComplete).toBe(false);
    expect(verified.retainedWorkspace).toBeDefined();
    expect(verified.blockers.join(' ')).toContain('Process-tree settlement verification is unsupported');
  });

  it('safely releases and cleans workspace on definitive spawn error (ENOENT) allowing retry without orphan registry', async () => {
    const f = await fixture();
    delete f.document.verification.preparation;
    await putApplicationFixtureFile(f.root, ['backend', 'test', 'custom-check.mjs'], 'import test from "node:test"; test("ok", () => {});\n');
    f.document.verification.commands = [{
      executable: 'node',
      args: ['--test', 'backend/test/custom-check.mjs'],
      cwdPathParts: [],
      timeoutMs: 10_000,
      maxOutputBytes: 16_384,
      network: false
    }];
    await save(f, true);
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(candidate.blockers).toEqual([]);

    const runner = new NodeCommandRunner();
    const context = await applicationVerificationFixtureContext(f.root, candidate, {
      projectCode: true, dependencyPreparation: false, network: false
    }, { env: { PATH: '', Path: '' } });

    // 1. Initial verification fails due to ENOENT (no process spawned from sanitized empty PATH):
    const failed = await verifyApplicationPatch(f.root, candidate, runner, context);
    expect(failed.status).toBe('failed');
    expect(failed.cleanupComplete).toBe(true);
    expect(failed.retainedWorkspace).toBeUndefined();
    expect(failed.blockers.join(' ')).toContain('[missing-executable]');

    // 2. Retry with restored tool in PATH succeeds immediately with no orphan registry lock:
    const retryContext = await applicationVerificationFixtureContext(f.root, candidate, {
      projectCode: true, dependencyPreparation: false, network: false
    }, { env: process.env });

    const retried = await verifyApplicationPatch(f.root, candidate, runner, retryContext);
    expect(retried.status).toBe('passed');
    expect(retried.cleanupComplete).toBe(true);
    expect(retried.commands[0]?.passed).toBe(true);
  });
});
