import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { applicationSearchEnvironment, createApplicationEnvironment } from '../src/application/repair/application-environment.js';
import {
  assertApplicationToolsCurrent, captureInstalledApplicationToolFile, resolveApplicationPreparationTools
} from '../src/application/repair/application-toolchain.js';
import { environmentValue } from '../src/domain/workstation/executables.js';
import { resolveTargetExecutableCommand } from '../src/adapters/process/windows-job-runner.js';
import { mergeWindowsCommandEnvironment, NodeCommandRunner, type CommandResult, type CommandRunner } from '../src/process-runner.js';

const fixtures: Array<{ root: string; settled: boolean }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.settled) await rm(fixture.root, { recursive: true, force: true });
  }
});

async function fixture() {
  await mkdir('.cache', { recursive: true });
  const root = path.resolve('.cache', `wt-${randomUUID().slice(0, 8)}`);
  await mkdir(root, { mode: 0o700 });
  const owned = { root, settled: true };
  fixtures.push(owned);
  const project = path.join(root, 'project $ & [literal]');
  const staging = path.join(root, 'staging');
  const workspace = path.join(root, 'private');
  for (const directory of [project, staging, workspace]) await mkdir(directory, { mode: 0o700 });
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const native = new NodeCommandRunner();
  const results: CommandResult[] = [];
  const runner: CommandRunner = {
    async run(command, options) {
      calls.push(command);
      const result = await native.run(command, { ...options, ensureProcessTreeSettled: true });
      if (result.processTreeSettled !== true && result.processSpawned !== false) owned.settled = false;
      results.push(result);
      return result;
    }
  };
  return { ...owned, project, staging, workspace, runner, calls, results };
}

describe('source boundaries for Windows tool environment selection', () => {
  it('removes undefined aliases that could shadow canonical variables during Windows child environment folding', () => {
    const search = path.dirname(process.execPath);
    const environment = applicationSearchEnvironment({
      PATH: search, Path: undefined,
      SystemRoot: 'C:\\Windows', SYSTEMROOT: undefined,
      SystemDrive: 'C:', SYSTEMDRIVE: undefined,
      WINDIR: 'C:\\Windows', windir: undefined,
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe', ComSpec: undefined
    }, path.resolve('project'), path.resolve('staging'), path.resolve('workspace'));
    const childEnvironment = mergeWindowsCommandEnvironment({}, environment);
    for (const name of ['PATH', 'SystemRoot', 'SystemDrive', 'WINDIR', 'COMSPEC']) {
      expect(Object.keys(childEnvironment).filter((key) => key.toLowerCase() === name.toLowerCase())).toHaveLength(1);
      expect(environmentValue(childEnvironment, name, 'win32')).toBe(environment[name]);
    }
    expect(environmentValue(childEnvironment, 'PATH', 'win32')).toBe(search);
  });

  it('resolves a mixed-case PATH in the Windows target resolver without an ambient fallback', async () => {
    const f = await fixture();
    const node = path.join(f.root, 'node.exe');
    await writeFile(node, 'source-only resolver fixture');
    expect(resolveTargetExecutableCommand({ executable: 'node.exe', args: ['--version'] }, {
      pAtH: f.root, PATH: undefined
    }, f.project)).toEqual({ executable: node, args: ['--version'] });
    expect(resolveTargetExecutableCommand({ executable: 'node.exe', args: [] }, { pAtH: '' }, f.project)).toBeNull();
  });

  it('rejects conflicting PATH aliases instead of choosing one target silently', () => {
    expect(() => resolveTargetExecutableCommand({ executable: 'node.exe', args: [] }, {
      PATH: 'first', pAtH: 'second'
    })).toThrow('Conflicting case-insensitive environment aliases');
  });

  it('replaces or clears inherited Windows aliases without resurrecting ambient values', () => {
    const environment = mergeWindowsCommandEnvironment({
      SYSTEMROOT: 'ambient-root', Path: 'ambient-path', ComSpec: 'ambient-shell', SECRET: 'not-forwarded'
    }, {
      SystemRoot: 'selected-root', pAtH: 'selected-path', COMSPEC: undefined, secret: undefined
    });
    expect(environmentValue(environment, 'SystemRoot', 'win32')).toBe('selected-root');
    expect(environmentValue(environment, 'PATH', 'win32')).toBe('selected-path');
    expect(environmentValue(environment, 'COMSPEC', 'win32')).toBeUndefined();
    expect(environmentValue(environment, 'SECRET', 'win32')).toBeUndefined();
    expect(Object.keys(environment)).toHaveLength(2);
    expect(() => mergeWindowsCommandEnvironment({ Path: 'ambient' }, { PATH: 'one', pAtH: 'two' }))
      .toThrow('Conflicting case-insensitive environment aliases');
  });
});

if (process.platform === 'win32') {
  describe('native supported Windows toolchain source acceptance', () => {
    let observedTools: Awaited<ReturnType<typeof resolveApplicationPreparationTools>> | undefined;
    let observedGit: { version: string; file: Awaited<ReturnType<typeof captureInstalledApplicationToolFile>> } | undefined;
    afterAll(async () => {
      if (process.env.LIFTOFF_WINDOWS_TOOLCHAIN_REPORT !== '1' || !observedTools || !observedGit) return;
      await mkdir('diagnostics', { recursive: true });
      await writeFile('diagnostics/windows-native-toolchain.json', JSON.stringify({
        classification: 'native-windows-source-tools-only', platform: process.platform, architecture: process.arch,
        sourceCommit: process.env.GITHUB_SHA, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        tools: observedTools.map((tool) => ({ id: tool.id, version: tool.version, executablePath: tool.executablePath, files: tool.files })),
        git: observedGit,
        installedArtifactQualification: 'not-performed', minimumHostQualification: 'not-performed', privateCustodyQualification: 'not-performed'
      }, null, 2) + '\n');
    });

    function selectedEnvironment(): NodeJS.ProcessEnv {
      const search = environmentValue(process.env, 'PATH', 'win32');
      const systemRoot = environmentValue(process.env, 'SystemRoot', 'win32');
      expect(search).toBeTruthy();
      expect(systemRoot).toBeTruthy();
      return {
        pAtH: search,
        sYsTeMrOoT: systemRoot,
        wInDiR: environmentValue(process.env, 'WINDIR', 'win32') ?? systemRoot,
        sYsTeMdRiVe: environmentValue(process.env, 'SystemDrive', 'win32') ?? systemRoot!.slice(0, 2),
        cOmSpEc: environmentValue(process.env, 'COMSPEC', 'win32') ?? path.join(systemRoot!, 'System32', 'cmd.exe'),
        PRIVATE_TEST_SENTINEL: 'must-not-reach-tool'
      };
    }

    async function nodeAndNpm(f: Awaited<ReturnType<typeof fixture>>, env = selectedEnvironment()) {
      return resolveApplicationPreparationTools(f.project, f.staging, [], { env, runner: f.runner }, ['node', 'npm']);
    }

    function settled(f: Awaited<ReturnType<typeof fixture>>) {
      expect(f.results.length).toBeGreaterThan(0);
      for (const result of f.results) {
        expect(result, result.errorCode ?? result.errorMessage).toMatchObject({
          status: 0, timedOut: false, processTreeSettled: true, processSpawned: true
        });
      }
    }

    it('honors mixed-case overrides and explicit clearing in actual Windows metadata child processes', async () => {
      const search = path.dirname(process.execPath);
      const result = await new NodeCommandRunner().run({
        executable: process.execPath,
        args: ['-e', 'console.log(JSON.stringify({path:process.env.PATH,profile:process.env.USERPROFILE??null}))']
      }, {
        cwd: process.cwd(), env: { pAtH: search, PATH: undefined, userprofile: undefined },
        timeoutMs: 15_000, maxOutputBytes: 8192
      });
      expect(result, result.errorMessage).toMatchObject({ status: 0, timedOut: false });
      expect(JSON.parse(result.stdout)).toEqual({ path: search, profile: null });
    });

    it('admits actual supported Node/npm using mixed environment aliases and literal Windows paths', async () => {
      const f = await fixture();
      const tools = await nodeAndNpm(f);
      const node = tools.find((tool) => tool.id === 'node')!;
      const npm = tools.find((tool) => tool.id === 'npm')!;
      expect(node.version).toBe(process.versions.node);
      expect(node.executablePath).toBe(await realpath(process.execPath));
      expect(npm.executablePath).toBe(node.executablePath);
      expect(npm.prefixArgs).toHaveLength(1);
      expect(path.basename(npm.prefixArgs[0])).toBe('npm-cli.js');
      expect(npm.files.every((file) => /^[a-f0-9]{64}$/.test(file.digest))).toBe(true);
      await assertApplicationToolsCurrent(f.project, f.staging, tools);
      const env = await createApplicationEnvironment(selectedEnvironment(), f.project, f.staging, f.workspace);
      const observed = await f.runner.run({
        executable: node.executablePath,
        args: ['-e', 'console.log(JSON.stringify({cwd:process.cwd(),systemRoot:process.env.SystemRoot,privateValue:process.env.PRIVATE_TEST_SENTINEL??null,args:process.argv.slice(1)}))', 'space & $ [literal]']
      }, { cwd: f.project, env, timeoutMs: 15_000, maxOutputBytes: 8192 });
      expect(JSON.parse(observed.stdout)).toEqual({
        cwd: f.project, systemRoot: environmentValue(process.env, 'SystemRoot', 'win32'),
        privateValue: null, args: ['space & $ [literal]']
      });
      settled(f);
      observedTools = tools;
    });

    it('observes and runs the actual Git executable read-only through literal Windows paths', async () => {
      const f = await fixture();
      const env = await createApplicationEnvironment(selectedEnvironment(), f.project, f.staging, f.workspace);
      const git = resolveTargetExecutableCommand({ executable: 'git', args: ['--version'] }, env, f.project);
      expect(git).not.toBeNull();
      const gitIdentity = await captureInstalledApplicationToolFile(git!.executable, f.project, f.staging, true);
      const version = await f.runner.run({ executable: git!.executable, args: [...git!.args] }, {
        cwd: f.project, env, timeoutMs: 15_000, maxOutputBytes: 8192
      });
      expect(version.stdout).toMatch(/^git version \d+\.\d+/);
      const root = await f.runner.run({
        executable: git!.executable, args: ['-C', f.project, 'rev-parse', '--show-toplevel']
      }, { cwd: f.workspace, env, timeoutMs: 15_000, maxOutputBytes: 8192 });
      expect(await realpath(root.stdout.trim())).toBe(await realpath(process.cwd()));
      expect(await captureInstalledApplicationToolFile(git!.executable, f.project, f.staging, true)).toEqual(gitIdentity);
      settled(f);
      observedGit = { version: version.stdout.trim(), file: gitIdentity };
    });

    it.each(['PATH', 'SystemRoot', 'SystemDrive', 'COMSPEC'])('rejects conflicting native %s aliases before any tool probe', async (name) => {
      const f = await fixture();
      const environment = selectedEnvironment();
      environment[name] = 'different-selection';
      await expect(nodeAndNpm(f, environment)).rejects.toThrow('[ambiguous-tool-environment]');
      expect(f.calls).toEqual([]);
    });

    it('rejects incompatible copied npm metadata without executing a fabricated version probe or installing another runtime', async () => {
      const f = await fixture();
      const installed = await nodeAndNpm(f);
      const npm = installed.find((tool) => tool.id === 'npm')!;
      const distribution = path.join(f.root, 'incompatible npm');
      const cli = path.join(distribution, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      await mkdir(path.dirname(cli), { recursive: true });
      await copyFile(npm.prefixArgs[0], cli);
      await copyFile(npm.launcherPath, path.join(distribution, 'npm.cmd'));
      const manifestFile = npm.files.find((file) => path.basename(file.path) === 'package.json')!;
      const manifest = JSON.parse(await readFile(manifestFile.path, 'utf8'));
      manifest.version = '0.0.0';
      await writeFile(path.join(path.dirname(path.dirname(cli)), 'package.json'), JSON.stringify(manifest));
      const nodeDirectory = path.join(f.root, 'isolated real Node');
      await mkdir(nodeDirectory);
      await copyFile(process.execPath, path.join(nodeDirectory, 'node.exe'));
      f.calls.length = 0;
      await expect(nodeAndNpm(f, {
        ...selectedEnvironment(), pAtH: [distribution, nodeDirectory].join(path.delimiter)
      })).rejects.toThrow('[incompatible-tool]');
      expect(f.calls.some((call) => call.args.includes(cli))).toBe(false);
      settled(f);
    });

    it('rejects a project-owned malicious shim reached through an external junction without executing it', async () => {
      const f = await fixture();
      const malicious = path.join(f.project, 'tools');
      const alias = path.join(f.root, 'outside alias');
      const marker = path.join(f.root, 'shim-executed');
      await mkdir(malicious);
      await writeFile(path.join(malicious, 'node.cmd'), `@echo off\r\necho unsafe>"${marker}"\r\n`);
      await symlink(malicious, alias, 'junction');
      await expect(resolveApplicationPreparationTools(f.project, f.staging, [], {
        env: { ...selectedEnvironment(), pAtH: alias }, runner: f.runner
      }, ['node'])).rejects.toThrow('[untrusted-tool]');
      expect(f.calls).toEqual([]);
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects changed actual Node executable bytes before further effects and leaves the installed executable untouched', async () => {
      const f = await fixture();
      const directory = path.join(f.root, 'selected Node copy');
      await mkdir(directory);
      const copy = path.join(directory, 'node.exe');
      await copyFile(process.execPath, copy);
      const original = createHash('sha256').update(await readFile(process.execPath)).digest('hex');
      const tools = await resolveApplicationPreparationTools(f.project, f.staging, [], {
        env: { ...selectedEnvironment(), pAtH: directory }, runner: f.runner
      }, ['node']);
      expect(tools[0].version).toBe(process.versions.node);
      settled(f);
      await assertApplicationToolsCurrent(f.project, f.staging, tools);
      await writeFile(copy, Buffer.concat([await readFile(copy), Buffer.from('\nchanged source fixture')]));
      await expect(assertApplicationToolsCurrent(f.project, f.staging, tools)).rejects.toThrow('[changed-tool]');
      expect(createHash('sha256').update(await readFile(process.execPath)).digest('hex')).toBe(original);
    });
  });
}
