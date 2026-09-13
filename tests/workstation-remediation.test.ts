import { describe, expect, it } from 'vitest';
import { workstationRequirementCatalog, type WorkstationRequirementId } from '../src/workstation-catalog.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';
import {
  installRequirement,
  probeRequirement,
  selectRemediation,
  type ExecutableObserver,
  type InstallationOrigin,
  type InstallContext,
  type SelectedRequirement
} from '../src/workstation.js';

function selected(id: WorkstationRequirementId): SelectedRequirement {
  const definition = workstationRequirementCatalog[id];
  return {
    id, definition, severity: 'blocking', reasons: ['test'],
    minimumVersion: definition.minimumVersion, exactVersion: definition.exactVersion,
    releaseLine: definition.releaseLine, allowPrerelease: definition.allowPrerelease ?? false
  };
}

class Runner implements CommandRunner {
  calls: Array<{ command: ExternalCommand; options?: RunCommandOptions }> = [];
  constructor(private handler: (command: ExternalCommand) => Partial<CommandResult>) {}
  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push({ command, options });
    return {
      command, displayCommand: [command.executable, ...command.args].join(' '),
      status: 0, signal: null, stdout: '', stderr: '', timedOut: false,
      ...this.handler(command)
    };
  }
}

const absent = { status: null, errorCode: 'ENOENT', errorMessage: 'command not found' } as const;
const host = { platform: 'darwin', linuxFamily: 'unknown' } as const;

function observer(origin: InstallationOrigin = 'unknown', resolved = true): ExecutableObserver {
  return {
    async resolve(executable) {
      return {
        executable, origin, evidence: resolved ? 'path-search' : 'unavailable',
        resolution: resolved ? 'resolved' : 'missing',
        ...(resolved ? { resolvedPath: `/fixture With Spaces/bin/${executable}`, realPath: `/fixture With Spaces/bin/${executable}`, kind: 'executable' } as const : {})
      };
    },
    async inspect(executable) {
      return { executable, origin: 'unknown', evidence: 'documented-location', resolution: 'missing' };
    }
  };
}

async function probe(id: WorkstationRequirementId, output: string, origin: InstallationOrigin = 'unknown') {
  return probeRequirement(selected(id), new Runner(() => ({ stdout: output })), {
    executableObserver: observer(origin), includeHealthNotices: false, host
  });
}

async function missing(id: WorkstationRequirementId) {
  return probeRequirement(selected(id), new Runner(() => absent), {
    executableObserver: observer('unknown', false), host
  });
}

function installContext(runner: CommandRunner, origin: InstallationOrigin = 'unknown'): InstallContext {
  return { authorized: true, host, runner, executableObserver: observer(origin) };
}

describe('registered causal remedies', () => {
  it('uses upgrade rather than the missing-tool installer for an older Homebrew runtime', async () => {
    const before = await probe('node', 'v24.19.0', 'brew');
    const selection = selectRemediation(before.requirement, before, host);
    expect(selection).toMatchObject({
      state: 'available', reasonCode: 'below-minimum',
      recipe: { operation: 'upgrade', command: { executable: 'brew', args: ['upgrade', 'node@24'] } }
    });
    const runner = new Runner((command) => command.executable === 'node' ? { stdout: 'v24.20.0' } : { stdout: 'Homebrew 5.0.0' });
    const result = await installRequirement(before.requirement, before, installContext(runner, 'brew'));
    expect(result).toMatchObject({ state: 'installed', reasonCode: 'verified', progress: 'ready', probe: { reasonCode: 'compatible' } });
    expect(runner.calls[1].command).toEqual(selection.recipe?.command);
    expect(runner.calls.some(({ command }) => command.args[0] === 'install')).toBe(false);
  });

  it('uses the exact pinned npm target to upgrade a known older OpenSpec installation', async () => {
    const before = await probe('openspec', '1.10.9', 'npm');
    const selection = selectRemediation(before.requirement, before, host);
    expect(selection).toMatchObject({
      state: 'available',
      recipe: { operation: 'upgrade', command: { executable: 'npm', args: ['install', '-g', '@fission-ai/openspec@1.11.0'] } }
    });
    const runner = new Runner((command) => ({ stdout: command.executable === 'openspec' ? '1.11.0' : '12.0.2' }));
    expect(await installRequirement(before.requirement, before, installContext(runner, 'npm')))
      .toMatchObject({ state: 'installed', probe: { detectedVersion: '1.11.0' } });
  });

  it('uses the uv upgrade operation instead of a no-op tool install for Spec Kit', async () => {
    const before = await probe('spec-kit', 'specify-cli 1.0.0', 'uv');
    const selection = selectRemediation(before.requirement, before, { platform: 'linux', linuxFamily: 'debian' });
    expect(selection).toMatchObject({
      state: 'available', recipe: {
        operation: 'upgrade',
        command: { executable: 'uv', args: ['tool', 'install', '--upgrade', 'specify-cli==1.0.1'] }
      }
    });
  });

  it.each(['1.11.0-1', '1.12.0'])('requires exact recipe review before replacing channel/version %s', async (version) => {
    const before = await probe('openspec', version, 'npm');
    const runner = new Runner((command) => ({ stdout: command.executable === 'openspec' ? '1.11.0' : '12.0.2' }));
    const selection = selectRemediation(before.requirement, before, host);
    expect(selection.recipe?.requiresExplicitReview).toBe(true);
    expect(await installRequirement(before.requirement, before, installContext(runner, 'npm'))).toMatchObject({
      state: 'manual', reasonCode: 'review-required'
    });
    expect(runner.calls).toEqual([]);
    expect(await installRequirement(before.requirement, before, {
      ...installContext(runner, 'npm'), approvedRemediationId: selection.recipe!.id
    })).toMatchObject({ state: 'installed', reasonCode: 'verified' });
    expect(runner.calls.every(({ command }) => !command.args.includes('uninstall') && !command.args.includes('--force'))).toBe(true);
  });

  it.each([
    ['node', 'v25.0.0', 'brew'],
    ['node', 'v24.20.0-rc.1', 'brew'],
    ['openspec', '1.10.9', 'unknown'],
    ['openspec', '1.10.9', 'standalone']
  ] as const)('discloses an unsupported %s cause/origin rather than blindly reinstalling', async (id, output, origin) => {
    const before = await probe(id, output, origin);
    const runner = new Runner(() => { throw new Error('No command is authorized for this causal limitation.'); });
    const result = await installRequirement(before.requirement, before, installContext(runner, origin));
    expect(result.state).toBe('manual');
    expect(result.reasonCode).toBe('recipe-unavailable');
    expect(result.probe.reasonCode).toBe(before.reasonCode);
    expect(result.detail).not.toMatch(/PATH|restart/);
    expect(runner.calls).toEqual([]);
  });

  it('does not use a registered pin to claim a different requested pin can be installed', async () => {
    const original = await probe('openspec', '1.10.9', 'npm');
    const requirement = { ...original.requirement, exactVersion: '1.10.8' };
    const before = { ...original, requirement };
    expect(selectRemediation(requirement, before, host)).toMatchObject({ state: 'manual' });
  });

  it('does nothing for compatible agents, including previews, even if installation was authorized', async () => {
    for (const [id, output] of [
      ['github-copilot', 'GitHub Copilot CLI 1.0.84-5.'],
      ['claude', '2.1.10-beta.1 (Claude Code)'],
      ['codex', 'codex-cli 0.107.0-alpha.12']
    ] as const) {
      const before = await probe(id, output);
      const runner = new Runner(() => { throw new Error('A ready agent must not be changed.'); });
      expect(await installRequirement(before.requirement, before, installContext(runner))).toMatchObject({ state: 'not-needed' });
      expect(runner.calls).toEqual([]);
    }
  });

  it('preserves independent per-tool consent', async () => {
    const openspec = await missing('openspec');
    const codex = await missing('codex');
    const runner = new Runner((command) => ({ stdout: command.executable === 'openspec' ? '1.11.0' : '12.0.2' }));
    await installRequirement(openspec.requirement, openspec, installContext(runner));
    const count = runner.calls.length;
    expect(await installRequirement(codex.requirement, codex, {
      ...installContext(runner), authorized: false
    })).toMatchObject({ state: 'declined', reasonCode: 'not-authorized' });
    expect(runner.calls).toHaveLength(count);
  });

  it.each(['11.9.0', '13.0.0', '12.0.2-rc.1', 'unexpected output'])('does not use an incompatible npm %s to install a tool', async (version) => {
    const before = await missing('openspec');
    const runner = new Runner(() => ({ stdout: version }));
    expect(await installRequirement(before.requirement, before, installContext(runner))).toMatchObject({
      state: 'manual', reasonCode: 'manager-unavailable'
    });
    expect(runner.calls.map(({ command }) => command.args)).toEqual([['--version']]);
  });
});

describe('verified installer outcomes and no-progress guards', () => {
  it('retains unchanged incompatibility, claims no writes, and suppresses an identical retry', async () => {
    const before = await probe('node', 'v24.19.0', 'brew');
    const runner = new Runner((command) => ({ stdout: command.executable === 'node' ? 'v24.19.0' : 'already installed' }));
    const context = installContext(runner, 'brew');
    const result = await installRequirement(before.requirement, before, context);
    expect(result).toMatchObject({
      state: 'unchanged', reasonCode: 'no-progress', progress: 'unchanged',
      probe: { state: 'outdated', reasonCode: 'below-minimum', detectedVersion: '24.19.0' }
    });
    expect(result.detail).toContain('no progress');
    expect(result.detail).not.toMatch(/wrote|PATH|restart/);
    expect(runner.calls.some(({ command }) => command.args.includes('--prefix'))).toBe(false);
    const count = runner.calls.length;
    expect(await installRequirement(before.requirement, result.probe, context)).toMatchObject({ state: 'unchanged', reasonCode: 'no-progress' });
    expect(await installRequirement(before.requirement, before, context)).toMatchObject({ state: 'unchanged', reasonCode: 'no-progress' });
    expect(runner.calls).toHaveLength(count);
  });

  it('allows a changed executable/version observation but not a replay of retained no-progress evidence', async () => {
    const before = await probe('node', 'v24.19.0', 'brew');
    const runner = new Runner((command) => ({ stdout: command.executable === 'node' ? 'v24.19.0' : 'already installed' }));
    const result = await installRequirement(before.requirement, before, installContext(runner, 'brew'));
    const freshRunner = new Runner((command) => ({ stdout: command.executable === 'node' ? 'v24.20.0' : 'Homebrew 5.0.0' }));
    const context = { ...installContext(freshRunner, 'brew'), previousAttempts: [result.attempt!] };
    expect(await installRequirement(before.requirement, before, context)).toMatchObject({ state: 'unchanged' });
    expect(freshRunner.calls).toEqual([]);
    const changed = await probe('node', 'v24.19.1', 'brew');
    expect(await installRequirement(changed.requirement, changed, context)).toMatchObject({ state: 'installed' });
  });

  it('distinguishes improvement from satisfying the constraint', async () => {
    const before = await probe('node', 'v24.19.0', 'brew');
    const runner = new Runner((command) => ({ stdout: command.executable === 'node' ? 'v24.19.1' : 'Homebrew 5.0.0' }));
    expect(await installRequirement(before.requirement, before, installContext(runner, 'brew'))).toMatchObject({
      state: 'unresolved', progress: 'improved', reasonCode: 'verification-unresolved',
      probe: { reasonCode: 'below-minimum', detectedVersion: '24.19.1' }
    });
  });

  it('retains an unchanged stable-channel failure after a reviewed no-op correction', async () => {
    const before = await probe('openspec', '1.11.0-1', 'npm');
    const selection = selectRemediation(before.requirement, before, host);
    expect(selection.recipe?.operation).toBe('change-channel');
    const commandRunner = new Runner((command) => ({ stdout: command.executable === 'openspec' ? '1.11.0-1' : '12.0.2' }));
    const result = await installRequirement(before.requirement, before, {
      ...installContext(commandRunner, 'npm'), approvedRemediationId: selection.recipe!.id
    });
    expect(result).toMatchObject({
      state: 'unchanged', reasonCode: 'no-progress', progress: 'unchanged',
      probe: { reasonCode: 'incompatible-channel', detectedVersion: '1.11.0-1', identity: { resolution: 'resolved' } }
    });
    expect(commandRunner.calls.some(({ command }) => command.args[0] === 'prefix')).toBe(false);
    expect(result.remedy).not.toMatch(/PATH|terminal/);
  });

  it.each([
    { status: 1, stderr: 'probe is broken' },
    { stdout: 'not a supported version' },
    { stdout: '1.11.0-1' },
    { stdout: '1.12.0' }
  ])('never converts a resolving failed/incompatible post-install probe into PATH guidance: %j', async (post) => {
    const before = await missing('openspec');
    const runner = new Runner((command) => command.executable === 'openspec' ? post : { stdout: '12.0.2' });
    const result = await installRequirement(before.requirement, before, installContext(runner, 'npm'));
    expect(result.state).toBe('unresolved');
    expect(result.probe.identity.resolution).toBe('resolved');
    expect(result.detail).not.toMatch(/PATH|restart|wrote/);
    expect(result.discovery).toBeUndefined();
    expect(runner.calls.some(({ command }) => command.args[0] === 'prefix')).toBe(false);
  });

  it.each([
    { status: 9, stderr: 'registry unavailable' },
    { status: 0, timedOut: true },
    { status: 0, outputLimitExceeded: true },
    { status: 0, aborted: true }
  ])('does not treat a failed or incomplete installer as success: %j', async (failure) => {
    const before = await missing('openspec');
    const runner = new Runner((command) => command.args[0] === '--version' ? { stdout: '12.0.2' } : failure);
    expect(await installRequirement(before.requirement, before, installContext(runner))).toMatchObject({
      state: 'failed', reasonCode: 'execution-failed', progress: 'indeterminate',
      probe: { reasonCode: 'missing-executable' }
    });
    expect(runner.calls.some(({ command }) => command.executable === 'openspec')).toBe(false);
  });

  it('does not convert an unknown process failure into missing-tool installation', async () => {
    const requirement = selected('openspec');
    const before = await probeRequirement(requirement, new Runner(() => ({ status: null, errorCode: 'UNKNOWN' })));
    expect(before).toMatchObject({ state: 'unhealthy', reasonCode: 'probe-failed' });
    const runner = new Runner(() => { throw new Error('A failure is not proof of a missing executable.'); });
    expect(await installRequirement(requirement, before, installContext(runner))).toMatchObject({ state: 'manual' });
    expect(runner.calls).toEqual([]);
  });

  it('preserves an unavailable runner as a failed probe, not permission to install', async () => {
    const requirement = selected('openspec');
    const before = await probeRequirement(requirement, new Runner(() => { throw new Error('transport unavailable'); }));
    expect(before).toMatchObject({
      state: 'unhealthy', reasonCode: 'probe-failed', detail: 'transport unavailable'
    });
    expect(selectRemediation(requirement, before, host).state).toBe('manual');
  });

  it('returns an honest failed outcome when an installer adapter throws', async () => {
    const before = await missing('openspec');
    const commandRunner = new Runner((command) => {
      if (command.args[0] === '--version') return { stdout: '12.0.2' };
      throw new Error('installer transport unavailable');
    });
    expect(await installRequirement(before.requirement, before, installContext(commandRunner))).toMatchObject({
      state: 'failed', reasonCode: 'execution-failed', progress: 'indeterminate',
      detail: 'installer transport unavailable'
    });
  });
});

describe('Codex platform remedies and elevated-bootstrap restrictions', () => {
  it.each([
    ['darwin', 'brew', ['install', '--cask', 'codex']],
    ['win32', 'npm', ['install', '-g', '@openai/codex']],
    ['linux', 'npm', ['install', '-g', '@openai/codex']]
  ] as const)('registers the official Codex recipe on %s', async (platform, executable, args) => {
    const before = await missing('codex');
    const selection = selectRemediation(before.requirement, before, { platform, linuxFamily: 'unknown' });
    expect(selection.recipe).toMatchObject({
      command: { executable, args }, sourceUrl: 'https://github.com/openai/codex#installing-and-running-codex-cli'
    });
  });

  it('installs Codex through npm on Linux without an elevated system installer', async () => {
    const before = await missing('codex');
    const runner = new Runner((command) => ({ stdout: command.executable === 'codex' ? 'codex-cli 0.107.0-alpha.12' : '12.0.2' }));
    const result = await installRequirement(before.requirement, before, {
      ...installContext(runner, 'npm'), host: { platform: 'linux', linuxFamily: 'debian' }
    });
    expect(result.state).toBe('installed');
    expect(result.probe.notices.some((notice) => notice.code === 'preview-channel')).toBe(true);
    expect(runner.calls.map(({ command }) => command.executable)).toEqual(['npm', 'npm', 'codex']);
    expect(runner.calls[1].command.args).toEqual(['install', '-g', '@openai/codex']);
  });

  it('can select the separately reviewed official npm alternative on macOS', async () => {
    const before = await missing('codex');
    const runner = new Runner((command) => ({ stdout: command.executable === 'codex' ? 'codex-cli 0.107.0' : '12.0.2' }));
    expect(await installRequirement(before.requirement, before, {
      ...installContext(runner, 'npm'), approvedRemediationId: 'codex:darwin:npm:install'
    })).toMatchObject({ state: 'installed', recipe: { manager: 'npm' } });
    expect(runner.calls.some(({ command }) => command.executable === 'brew')).toBe(false);
  });

  it.each(['node', 'python', 'go', 'uv', 'docker', 'opentofu', 'azure-cli', 'github-copilot', 'claude', 'github-cli'] as const)(
    'never bootstraps the Linux system package manager for %s', async (id) => {
      const before = await missing(id);
      const runner = new Runner(() => { throw new Error('No system package operation may run.'); });
      expect(await installRequirement(before.requirement, before, {
        ...installContext(runner), host: { platform: 'linux', linuxFamily: 'fedora' }
      })).toMatchObject({ state: 'manual' });
      expect(runner.calls).toEqual([]);
    }
  );
});
