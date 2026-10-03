import { appendFile, chmod, lstat, mkdir, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectApplicationPatch, verifyApplicationPatch } from '../src/application/repair/application-patch.js';
import { applicationVerificationFixtureContext, putApplicationFixtureFile } from './fixtures/repair-application.js';
import { createPreparationFixture, type PreparationFixture } from './fixtures/repair-preparation.js';
import {
  TemporaryDirectories, ScriptedRunner, commandResult, externalToolCopies, isNpmCi, isToolProbe,
  simulateNpmCi, snapshotTree, type ProbeVersions, type RunnerScript
} from './fixtures/repair-branches.js';

const directories = new TemporaryDirectories();
afterEach(async () => { await directories.cleanup(); });
const posix = process.platform !== 'win32';
const exe = (name: string) => process.platform === 'win32' ? `${name}.exe` : name;
const searchPath = (...entries: string[]) => [...entries, process.env.PATH ?? process.env.Path ?? ''].filter(Boolean).join(path.delimiter);

async function fixture(): Promise<PreparationFixture> {
  return createPreparationFixture(await directories.make('lf tool '));
}

const probeRoots = async (f: PreparationFixture) =>
  (await readdir(f.directory)).filter((name) => name.startsWith('.liftoff-preparation-probe-'));

async function inspect(f: PreparationFixture, env: NodeJS.ProcessEnv | undefined, script?: RunnerScript, versions?: ProbeVersions) {
  const runner = new ScriptedRunner(script, versions);
  const project = await snapshotTree(f.root), staging = await snapshotTree(f.stage);
  const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath, { runner, ...(env ? { env } : {}) });
  expect(await snapshotTree(f.root)).toEqual(project);
  expect(await snapshotTree(f.stage)).toEqual(staging);
  expect(runner.effects()).toEqual([]);
  if (candidate.blockers.length) {
    expect(candidate.mutations).toEqual([]);
    expect(candidate.report.status).toBe('blocked');
  }
  return { candidate, runner };
}

/** A self-contained npm layout: bin/npm links to lib/node_modules/<package>/bin/npm-cli.js beside a native Node copy. */
async function npmDistribution(parent: string, options: { version?: string; name?: string; folder?: string; padding?: number } = {}) {
  const root = path.join(parent, 'npm distribution');
  const { directory: bin } = await externalToolCopies(root, ['node'], 'bin');
  const packageRoot = path.join(root, 'lib', 'node_modules', options.folder ?? 'npm');
  await mkdir(path.join(packageRoot, 'bin'), { recursive: true });
  await writeFile(path.join(packageRoot, 'bin', 'npm-cli.js'), '#!/usr/bin/env node\nrequire("../lib/cli.js")(process);\n', { mode: 0o755 });
  await writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify({
    name: options.name ?? 'npm', version: options.version ?? '12.0.2', ...(options.padding ? { description: 'x'.repeat(options.padding) } : {})
  })}\n`);
  await symlink(path.relative(bin, path.join(packageRoot, 'bin', 'npm-cli.js')), path.join(bin, 'npm'));
  return { bin, cli: path.join(packageRoot, 'bin', 'npm-cli.js') };
}

describe('installed tool files are identified before any probe', () => {
  it('rejects an external script shim named like the runtime before running it', async () => {
    const f = await fixture();
    const tools = path.join(f.directory, 'shim tools');
    const shim = posix ? path.join(tools, 'node') : path.join(tools, 'node.cmd');
    await mkdir(tools);
    await writeFile(shim, posix ? '#!/bin/sh\necho v24.21.0\n' : '@echo off\r\necho v24.21.0\r\n', { mode: 0o755 });
    const { candidate, runner } = await inspect(f, { PATH: tools });
    expect(candidate.blockers.join(' ')).toContain('[untrusted-tool] A runtime resolves to a script/shim');
    expect(runner.calls).toEqual([]);
    expect(await probeRoots(f)).toEqual([]);
  });

  it('rejects an empty installed runtime file', async () => {
    const f = await fixture();
    const tools = path.join(f.directory, 'empty tools');
    await mkdir(tools);
    await writeFile(path.join(tools, exe('node')), '', { mode: 0o755 });
    const { candidate, runner } = await inspect(f, { PATH: tools });
    expect(candidate.blockers.join(' ')).toContain('[untrusted-tool] A resolved tool is not a bounded installed regular file.');
    expect(runner.calls).toEqual([]);
  });

  it('refuses an external PATH alias that resolves into the user patch staging', async () => {
    const f = await fixture();
    await putApplicationFixtureFile(f.stage, ['tools', exe('node')], 'staged executable bytes', 0o755);
    const alias = path.join(f.directory, 'staging alias');
    await symlink(path.join(f.stage, 'tools'), alias, 'junction');
    const { candidate, runner } = await inspect(f, { PATH: alias });
    expect(candidate.blockers.join(' ')).toContain('[untrusted-tool] node resolves through project/staging executable scope.');
    expect(runner.calls).toEqual([]);
  });
});

describe.skipIf(!posix)('npm launcher and distribution identity (POSIX layout; Windows npm.cmd layouts are unrun here)', () => {
  it('binds a consistent installed npm distribution to its exact Node interpreter', async () => {
    const f = await fixture();
    const npm = await npmDistribution(f.directory);
    const { candidate } = await inspect(f, { PATH: npm.bin });
    expect(candidate.blockers).toEqual([]);
    const tool = candidate.verificationPolicy.toolchain.find((item) => item.id === 'npm')!;
    const node = candidate.verificationPolicy.toolchain.find((item) => item.id === 'node')!;
    expect(tool.version).toBe('12.0.2');
    expect(tool.executablePath).toBe(node.executablePath);
    expect(tool.prefixArgs).toEqual([await realpath(npm.cli)]);
    expect(tool.files.map((file) => path.basename(file.path))).toEqual(expect.arrayContaining(['npm-cli.js', 'package.json', 'node']));
  });

  it.each([
    ['a probe version different from the installed package identity', { version: '12.0.2' }, { npm: '12.0.9' }, '[incompatible-tool]'],
    ['a package identity for another tool', { name: 'not-npm' }, undefined, '[untrusted-tool] npm must resolve to an identifiable installed npm distribution'],
    ['a launcher outside an npm package', { folder: 'impostor' }, undefined, '[untrusted-tool] npm does not resolve to its registered installed JavaScript launcher.'],
    ['an oversized package identity', { padding: 70 * 1024 }, undefined, '[untrusted-tool] npm must resolve to an identifiable installed npm distribution']
  ])('rejects %s', async (_name, layout, versions, message) => {
    const f = await fixture();
    const npm = await npmDistribution(f.directory, layout);
    const { candidate, runner } = await inspect(f, { PATH: npm.bin }, undefined, versions);
    expect(candidate.blockers.join(' ')).toContain(message);
    expect(runner.calls.every((call) => isToolProbe(call.command))).toBe(true);
    expect(await probeRoots(f)).toEqual([]);
  });

  it('fails closed when an npm launcher has no inspectable JavaScript entry point', async () => {
    const f = await fixture();
    const { directory: bin } = await externalToolCopies(f.directory, ['node'], 'bare npm');
    await writeFile(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const { candidate } = await inspect(f, { PATH: bin });
    expect(candidate.blockers.join(' ')).toContain('[tool-inspection] Installed tool files could not be safely inspected or probed; no preparation was performed.');
    expect(await probeRoots(f)).toEqual([]);
  });
});

describe('probe outcomes are metadata, never installation or authority', () => {
  it.each([
    ['another release line', 'v25.0.0'],
    ['a version below the supported floor', 'v24.19.0'],
    ['an unapproved prerelease', 'v24.22.0-rc.1'],
    ['unparseable output', 'node version unknown']
  ])('rejects %s reported by the installed runtime', async (_name, version) => {
    const f = await fixture();
    const { candidate, runner } = await inspect(f, undefined, undefined, { node: version });
    expect(candidate.blockers.join(' ')).toContain('[incompatible-tool] Installed node must satisfy');
    expect(runner.calls).toHaveLength(1);
    expect(await probeRoots(f)).toEqual([]);
  });

  it.each([
    ['a failing probe', { status: 1, stderr: 'CANARY_PROBE_OUTPUT' }, '[tool-probe-check-failed]'],
    ['a probe timeout', { status: null, timedOut: true }, '[tool-probe-timed-out]'],
    ['a missing launch target', { status: null, errorCode: 'ENOENT' }, '[tool-probe-missing-executable]']
  ])('reports %s without preparing anything', async (_name, outcome, code) => {
    const f = await fixture();
    const { candidate } = await inspect(f, undefined, (call) => commandResult(call.command, outcome));
    expect(candidate.blockers.join(' ')).toContain(code);
    expect(candidate.blockers.join(' ')).not.toContain('CANARY_');
    expect(await probeRoots(f)).toEqual([]);
  });

  it('retains the probe workspace when probe termination cannot be confirmed', async () => {
    const f = await fixture();
    const { candidate } = await inspect(f, undefined, (call) => commandResult(call.command, {
      status: null, timedOut: true, errorCode: 'PROCESS_TREE_TERMINATION_FAILED'
    }));
    const [retained] = await probeRoots(f);
    expect(retained).toBeDefined();
    expect(candidate.blockers.join(' ')).toContain(
      `[tool-probe-cleanup] Tool probe termination is uncertain; probe workspace was retained at ${path.join(f.directory, retained!)}`);
    expect((await lstat(path.join(f.directory, retained!))).isDirectory()).toBe(true);
  });

  it('reports an unexpected runner exception generically without preparation', async () => {
    const f = await fixture();
    const { candidate } = await inspect(f, undefined, () => { throw new Error('CANARY_RUNNER_EXCEPTION'); });
    expect(candidate.blockers.join(' ')).toContain('[tool-inspection]');
    expect(candidate.blockers.join(' ')).not.toContain('CANARY_');
    expect(await probeRoots(f)).toEqual([]);
  });
});

describe('tool identity drift', () => {
  it('rejects runtime bytes that change while their probe runs', async () => {
    const f = await fixture();
    const tools = await externalToolCopies(f.directory, ['node']);
    const { candidate } = await inspect(f, { PATH: searchPath(tools.directory) }, async (call) => {
      if (call.command.executable === await realpath(tools.files.node!)) {
        await appendFile(tools.files.node!, Buffer.from([0]));
        return commandResult(call.command, { stdout: `${process.version}\n` });
      }
      return undefined;
    });
    expect(candidate.blockers.join(' ')).toContain('[changed-tool] Installed tool identity changed during its probe.');
    expect(await probeRoots(f)).toEqual([]);
  });

  it.skipIf(!posix)('rejects a launcher retargeted to identical bytes during its probe', async () => {
    const f = await fixture();
    const first = await externalToolCopies(f.directory, ['node'], 'runtime a');
    const second = await externalToolCopies(f.directory, ['node'], 'runtime b');
    const launchers = path.join(f.directory, 'launchers');
    await mkdir(launchers);
    const launcher = path.join(launchers, 'node');
    await symlink(first.files.node!, launcher);
    const { candidate } = await inspect(f, { PATH: searchPath(launchers) }, async (call) => {
      if (call.command.executable === first.files.node) {
        await unlink(launcher);
        await symlink(second.files.node!, launcher);
      }
      return undefined;
    });
    expect(candidate.blockers.join(' ')).toContain('[changed-tool] Installed launcher resolution changed during its probe.');
  });

  it.skipIf(!posix)('refuses verification after an approved launcher is retargeted to identical bytes', async () => {
    const f = await fixture();
    const first = await externalToolCopies(f.directory, ['node'], 'runtime a');
    const second = await externalToolCopies(f.directory, ['node'], 'runtime b');
    const launchers = path.join(f.directory, 'launchers');
    await mkdir(launchers);
    const launcher = path.join(launchers, 'node');
    await symlink(first.files.node!, launcher);
    const env = { PATH: searchPath(launchers) };
    const { candidate } = await inspect(f, env);
    expect(candidate.blockers).toEqual([]);
    const context = await applicationVerificationFixtureContext(f.root, candidate, { projectCode: true, dependencyPreparation: true, network: true }, { env });
    await unlink(launcher);
    await symlink(second.files.node!, launcher);
    const runner = new ScriptedRunner();
    const result = await verifyApplicationPatch(f.root, candidate, runner, context);
    expect(result.status).toBe('blocked');
    expect(result.workspaceId).toBeUndefined();
    expect(runner.calls).toEqual([]);
  });

  it('refuses to delete a probe workspace replaced during probing and preserves the replacement', async () => {
    const f = await fixture();
    let replaced = '';
    const { candidate } = await inspect(f, undefined, async (call) => {
      if (!replaced) {
        replaced = call.options!.cwd!;
        await rm(replaced, { recursive: true, force: true });
        await putApplicationFixtureFile(replaced, ['replacement-marker.txt'], 'not owned by the probe\n');
      }
      return undefined;
    });
    expect(candidate.blockers.join(' ')).toContain('[tool-probe-cleanup] Probe workspace identity changed; cleanup was refused.');
    expect(path.dirname(replaced)).toBe(f.directory);
    expect((await lstat(path.join(replaced, 'replacement-marker.txt'))).isFile()).toBe(true);
  });

  it('blocks registered effects when an approved tool reports a different version at execution time', async () => {
    const f = await fixture();
    const { candidate } = await inspect(f, undefined);
    expect(candidate.blockers).toEqual([]);
    const context = await applicationVerificationFixtureContext(f.root, candidate, { projectCode: true, dependencyPreparation: true, network: true });
    const project = await snapshotTree(f.root);
    const runner = new ScriptedRunner(undefined, { node: 'v24.99.0' });
    const result = await verifyApplicationPatch(f.root, candidate, runner, context);
    expect(result.status).toBe('failed');
    expect(result.blockers.join(' ')).toContain('[changed-tool] Approved installed tool/interpreter identity or version changed before effects.');
    expect(runner.effects()).toEqual([]);
    expect(result).toMatchObject({ commands: [], preparation: [], cleanupComplete: true });
    expect(await snapshotTree(f.root)).toEqual(project);
  });

  it('keeps the actual preparation effect and runs no checks when tool bytes drift after preparation', async () => {
    const f = await fixture();
    const tools = await externalToolCopies(f.directory, ['node']);
    const env = { PATH: searchPath(tools.directory) };
    const { candidate } = await inspect(f, env);
    expect(candidate.blockers).toEqual([]);
    expect(candidate.verificationPolicy.toolchain.find((tool) => tool.id === 'node')!.executablePath).toBe(await realpath(tools.files.node!));
    const context = await applicationVerificationFixtureContext(f.root, candidate, { projectCode: true, dependencyPreparation: true, network: true }, { env });
    const project = await snapshotTree(f.root);
    const runner = new ScriptedRunner(async (call) => {
      if (!isNpmCi(call.command)) return undefined;
      const outcome = await simulateNpmCi(call);
      await appendFile(tools.files.node!, Buffer.from([0]));
      return outcome;
    });
    const result = await verifyApplicationPatch(f.root, candidate, runner, context);
    expect(result.status).toBe('failed');
    expect(result.preparation).toEqual([expect.objectContaining({ commands: [expect.objectContaining({ passed: true })] })]);
    expect(result.commands).toEqual([]);
    expect(runner.effects().map((call) => isNpmCi(call.command))).toEqual([true]);
    expect(result.blockers.join(' ')).toMatch(/changed/iu);
    expect(result.cleanupComplete).toBe(true);
    expect(await snapshotTree(f.root)).toEqual(project);
  });

  it('refuses a mode-only drift of an approved runtime before creating a workspace', async () => {
    const f = await fixture();
    const tools = await externalToolCopies(f.directory, ['node']);
    const env = { PATH: searchPath(tools.directory) };
    const { candidate } = await inspect(f, env);
    expect(candidate.blockers).toEqual([]);
    const context = await applicationVerificationFixtureContext(f.root, candidate, { projectCode: true, dependencyPreparation: true, network: true }, { env });
    await chmod(tools.files.node!, posix ? 0o700 : 0o444);
    const runner = new ScriptedRunner();
    const result = await verifyApplicationPatch(f.root, candidate, runner, context);
    expect(result.status).toBe('blocked');
    expect(result.workspaceId).toBeUndefined();
    expect(runner.calls).toEqual([]);
  });
});
