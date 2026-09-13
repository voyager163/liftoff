import { randomUUID } from 'node:crypto';
import { chmod, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeCommandRunner, type CommandResult, type CommandRunner } from '../src/process-runner.js';
import { workstationRequirementCatalog, type WorkstationRequirementId } from '../src/workstation-catalog.js';
import {
  executableCandidates,
  type ExecutableObservationContext
} from '../src/domain/workstation/executables.js';
import { nativeExecutableObserver } from '../src/adapters/filesystem/executables.js';
import {
  installRequirement,
  probeRequirement,
  type ExecutableObserver,
  type SelectedRequirement
} from '../src/workstation.js';
import type { ExternalCommand } from '../src/types.js';

function selected(id: WorkstationRequirementId): SelectedRequirement {
  const definition = workstationRequirementCatalog[id];
  return {
    id, definition, severity: 'blocking', reasons: ['test'],
    minimumVersion: definition.minimumVersion, exactVersion: definition.exactVersion,
    releaseLine: definition.releaseLine, allowPrerelease: definition.allowPrerelease ?? false
  };
}

const absent = { status: null, errorCode: 'ENOENT' } as const;
function runner(handler: (command: ExternalCommand) => Partial<CommandResult>): CommandRunner {
  return {
    async run(command) {
      return {
        command, displayCommand: [command.executable, ...command.args].join(' '),
        status: 0, signal: null, timedOut: false, stdout: '', stderr: '', ...handler(command)
      };
    }
  };
}

const missingObserver: ExecutableObserver = {
  async resolve(executable) {
    return { executable, resolution: 'missing', origin: 'unknown', evidence: 'unavailable' };
  },
  async inspect(executable) {
    return { executable, resolution: 'missing', origin: 'unknown', evidence: 'documented-location' };
  }
};

const host = { platform: 'darwin', linuxFamily: 'unknown' } as const;
const windowsHost = { platform: 'win32', linuxFamily: 'unknown' } as const;

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const relativeRoot = path.join('tests', `.workstation-executables-${randomUUID()}`);
  await mkdir(relativeRoot, { recursive: true });
  try {
    await run(path.resolve(relativeRoot));
  } finally {
    await rm(relativeRoot, { recursive: true, force: true });
  }
}

describe('portable executable observation', () => {
  it('keeps Windows paths, shim extensions, and PATH order native without shell expansion', () => {
    const context: ExecutableObservationContext = {
      platform: 'win32', cwd: 'C:\\Projects\\App With Spaces',
      env: { Path: '"C:\\Program Files\\nodejs";D:\\Tools $literal', PATHEXT: '.EXE;.CMD;.BAT;.PS1' },
      definition: workstationRequirementCatalog.codex
    };
    expect(executableCandidates('codex', context)).toEqual([
      'C:\\Projects\\App With Spaces\\codex.EXE',
      'C:\\Projects\\App With Spaces\\codex.CMD',
      'C:\\Projects\\App With Spaces\\codex.BAT',
      'C:\\Program Files\\nodejs\\codex.EXE',
      'C:\\Program Files\\nodejs\\codex.CMD',
      'C:\\Program Files\\nodejs\\codex.BAT',
      'D:\\Tools $literal\\codex.EXE',
      'D:\\Tools $literal\\codex.CMD',
      'D:\\Tools $literal\\codex.BAT'
    ]);
    expect(executableCandidates('C:\\Program Files\\nodejs\\codex.cmd', context))
      .toEqual(['C:\\Program Files\\nodejs\\codex.cmd']);
    expect(executableCandidates('\\\\server\\share space\\codex.cmd', context))
      .toEqual(['\\\\server\\share space\\codex.cmd']);
    expect(executableCandidates('codex; echo unsafe', context)).toEqual([]);
  });

  it('uses the actual Node executable observation with the production process runner', async () => {
    const probe = await probeRequirement(selected('node'), new NodeCommandRunner(), {
      env: { PATH: path.dirname(process.execPath) }, includeHealthNotices: false
    });
    expect(probe.detectedVersion).toBe(process.versions.node);
    expect(probe.identity).toMatchObject({
      resolution: 'resolved', evidence: 'path-search', realPath: await realpath(process.execPath)
    });
    expect(probe.identity.resolvedPath).toBeTruthy();
  });

  it.skipIf(process.platform === 'win32')('observes a symlinked npm tool without guessing from the launcher directory', async () => {
    await fixture(async (root) => {
      const target = path.join(root, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      const bin = path.join(root, 'bin With Spaces');
      await mkdir(path.dirname(target), { recursive: true });
      await mkdir(bin);
      await writeFile(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await symlink(target, path.join(bin, 'codex'));
      const identity = await nativeExecutableObserver.resolve('codex', {
        platform: process.platform === 'darwin' ? 'darwin' : 'linux',
        cwd: root, env: { PATH: bin }, definition: workstationRequirementCatalog.codex
      });
      expect(identity).toMatchObject({
        resolution: 'resolved', origin: 'npm', evidence: 'path-search',
        resolvedPath: path.join(bin, 'codex'), realPath: target
      });
    });
  });

  it('recognizes a bounded official npm Windows shim and rejects unrelated text as origin evidence', async () => {
    await fixture(async (root) => {
      const shim = path.join(root, 'codex.cmd');
      const context: ExecutableObservationContext = {
        platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
        cwd: root, env: {}, definition: workstationRequirementCatalog.codex
      };
      await writeFile(shim, '@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
      await chmod(shim, 0o755);
      expect(await nativeExecutableObserver.inspect(shim, context)).toMatchObject({
        resolution: 'resolved', kind: 'shim', origin: 'npm', resolvedPath: shim
      });
      await writeFile(shim, '@ECHO off\r\nECHO @openai/codex\r\n');
      expect(await nativeExecutableObserver.inspect(shim, context)).toMatchObject({ origin: 'unknown' });
    });
  });

  it('retains every Python launcher observation and chooses the compatible actual launcher', async () => {
    const observations: Array<{ executable: string; context: ExecutableObservationContext }> = [];
    const executableObserver: ExecutableObserver = {
      ...missingObserver,
      async resolve(executable, context) {
        observations.push({ executable, context });
        return executable === 'python' ? missingObserver.resolve(executable, context) : {
          executable, resolution: 'resolved', origin: 'winget', kind: 'executable', evidence: 'path-search',
          resolvedPath: `C:\\Program Files\\Python\\${executable}.exe`
        };
      }
    };
    const calls: ExternalCommand[] = [];
    const probe = await probeRequirement(selected('python'), runner((command) => {
      calls.push(command);
      return command.executable === 'python3' ? { stdout: 'Python 3.13.8' } :
        command.executable === 'python' ? absent : { stdout: 'Python 3.14.2' };
    }), { executableObserver, host: windowsHost, cwd: 'C:\\Projects\\App With Spaces' });
    expect(probe).toMatchObject({
      state: 'ready', detectedBy: 'py', detectedVersion: '3.14.2',
      identity: { resolvedPath: 'C:\\Program Files\\Python\\py.exe', origin: 'winget' }
    });
    expect(probe.observations.map((observation) => observation.reasonCode))
      .toEqual(['release-line-mismatch', 'missing-executable', 'compatible']);
    expect(calls).toEqual([
      { executable: 'python3', args: ['--version'] },
      { executable: 'python', args: ['--version'] },
      { executable: 'py', args: ['-3', '--version'] }
    ]);
    expect(observations.every((observation) => observation.context.cwd === 'C:\\Projects\\App With Spaces')).toBe(true);
  });

  it('does not equate a discovered shim with a successfully executing interpreter', async () => {
    const executableObserver: ExecutableObserver = {
      ...missingObserver,
      async resolve(executable) {
        return {
          executable, resolution: 'resolved', origin: 'npm', evidence: 'path-search', kind: 'shim',
          resolvedPath: 'C:\\Tools With Spaces\\openspec.cmd'
        };
      }
    };
    expect(await probeRequirement(selected('openspec'), runner(() => absent), { executableObserver, host: windowsHost }))
      .toMatchObject({ state: 'unhealthy', reasonCode: 'probe-failed', identity: { resolution: 'resolved', kind: 'shim' } });
  });

  it('uses successful probe evidence when the process adapter cannot safely inspect executable paths', async () => {
    const executableObserver: ExecutableObserver = {
      async resolve() { throw new Error('resolution denied'); },
      async inspect() { throw new Error('inspection denied'); }
    };
    expect(await probeRequirement(selected('openspec'), runner(() => ({ stdout: '1.11.0' })), { executableObserver }))
      .toMatchObject({ state: 'ready', identity: { resolution: 'resolved', origin: 'unknown', evidence: 'version-probe' } });
  });
});

describe('evidence-bound PATH guidance', () => {
  it('does not infer a restart from installer exit zero and a completed search with no executable candidate', async () => {
    const requirement = selected('openspec');
    const absentWithDetail = { ...absent, errorMessage: 'spawn openspec ENOENT after the reviewed remedy' };
    const before = await probeRequirement(requirement, runner(() => absentWithDetail), {
      executableObserver: missingObserver, host
    });
    const result = await installRequirement(requirement, before, {
      authorized: true, host, executableObserver: missingObserver,
      runner: runner((command) => command.executable === 'openspec' ? absentWithDetail : {
        stdout: command.args[0] === 'prefix' ? '/fixture/npm' : '12.0.2'
      })
    });
    expect(result).toMatchObject({
      state: 'unchanged', reasonCode: 'no-progress', progress: 'unchanged',
      probe: {
        state: 'missing', reasonCode: 'missing-executable',
        detail: 'spawn openspec ENOENT after the reviewed remedy'
      },
      discovery: { complete: true, checkedLocations: ['/fixture/npm/bin/openspec'], found: [] }
    });
    expect(result.detail).toContain('spawn openspec ENOENT');
    expect(result.detail).toContain('No executable candidate was observed');
    expect(result.detail).toContain('No file changes were verified');
    expect(result.remedy).not.toMatch(/PATH|restart|terminal/);
    expect(result.command).toBe('npm install -g @fission-ai/openspec@1.11.0');
  });

  it('checks native Windows alias locations before recommending a terminal refresh', async () => {
    const requirement = selected('node');
    const before = await probeRequirement(requirement, runner(() => absent), { executableObserver: missingObserver, host: windowsHost });
    const checked: string[] = [];
    const alias = 'C:\\Users\\User Name\\AppData\\Local\\Microsoft\\WinGet\\Links\\node.exe';
    const executableObserver: ExecutableObserver = {
      ...missingObserver,
      async inspect(candidate, context) {
        checked.push(candidate);
        return candidate === alias ? {
          executable: 'node', resolution: 'resolved', origin: 'winget', kind: 'executable',
          evidence: 'documented-location', resolvedPath: alias
        } : missingObserver.inspect(candidate, context);
      }
    };
    const result = await installRequirement(requirement, before, {
      authorized: true, host: windowsHost, executableObserver,
      env: { LOCALAPPDATA: 'C:\\Users\\User Name\\AppData\\Local' },
      runner: runner((command) => command.executable === 'node' ? absent : { stdout: 'v1.11.0' })
    });
    expect(result).toMatchObject({
      state: 'restart-required', reasonCode: 'executable-discovery',
      probe: { reasonCode: 'missing-executable' },
      discovery: { complete: true, found: [{ resolvedPath: alias }] }
    });
    expect(checked).toContain(alias);
    expect(checked).toContain('C:\\Users\\User Name\\AppData\\Local\\Microsoft\\WindowsApps\\node.cmd');
    expect(result.detail).toContain('does not prove the installer wrote them');
  });

  it('never diagnoses a resolving, unchanged incompatible Windows shim as PATH failure', async () => {
    const requirement = selected('openspec');
    let inspections = 0;
    const executableObserver: ExecutableObserver = {
      async resolve(executable) {
        return {
          executable, resolution: 'resolved', origin: 'npm', kind: 'shim', evidence: 'path-search',
          resolvedPath: `C:\\Tools With Spaces\\${executable}.cmd`
        };
      },
      async inspect(candidate, context) {
        inspections += 1;
        return missingObserver.inspect(candidate, context);
      }
    };
    const commandRunner = runner((command) => ({ stdout: command.executable === 'openspec' ? '1.10.9' : '12.0.2' }));
    const before = await probeRequirement(requirement, commandRunner, { executableObserver, host: windowsHost });
    const result = await installRequirement(requirement, before, {
      authorized: true, host: windowsHost, executableObserver, runner: commandRunner
    });
    expect(result).toMatchObject({
      state: 'unchanged', reasonCode: 'no-progress',
      probe: { reasonCode: 'release-line-mismatch', identity: { kind: 'shim', resolution: 'resolved' } }
    });
    expect(inspections).toBe(0);
    expect(result.remedy).not.toMatch(/PATH|terminal/);
  });

  it.each(['relative/bin', 'C:relative', '/fixture\nunexpected output', '', '/fixture\u001b[31m'])(
    'does not infer PATH or a location from untrusted manager output %j', async (location) => {
      const requirement = selected('openspec');
      const before = await probeRequirement(requirement, runner(() => absent), { executableObserver: missingObserver });
      const result = await installRequirement(requirement, before, {
        authorized: true, host, executableObserver: missingObserver,
        runner: runner((command) => command.executable === 'openspec' ? absent :
          { stdout: command.args[0] === 'prefix' ? location : '12.0.2' })
      });
      expect(result.state).not.toBe('restart-required');
      expect(result.discovery).toMatchObject({ complete: false, checkedLocations: [] });
      expect(result.remedy).not.toMatch(/Open a new terminal|add .*PATH/);
    }
  );

  it('keeps documented location spaces and metacharacters literal, and does not execute that path', async () => {
    const requirement = selected('openspec');
    const before = await probeRequirement(requirement, runner(() => absent), { executableObserver: missingObserver });
    const commands: ExternalCommand[] = [];
    const location = '/fixture Prefix With Spaces/$(literal)';
    const result = await installRequirement(requirement, before, {
      authorized: true, host, executableObserver: missingObserver,
      runner: runner((command) => {
        commands.push(command);
        return command.executable === 'openspec' ? absent :
          { stdout: command.args[0] === 'prefix' ? location : '12.0.2' };
      })
    });
    expect(result.discovery?.checkedLocations).toEqual([`${location}/bin/openspec`]);
    expect(result).toMatchObject({
      state: 'unchanged', reasonCode: 'no-progress', discovery: { complete: true, found: [] }
    });
    expect(result.remedy).not.toMatch(/PATH|restart|terminal/);
    expect(commands.map((command) => command.executable)).toEqual(['npm', 'npm', 'openspec', 'npm']);
    expect(commands.some((command) => command.executable.includes('$') || command.args.some((arg) => arg.includes('$')))).toBe(false);
  });
});
