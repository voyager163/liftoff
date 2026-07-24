import { describe, expect, it } from 'vitest';
import type {
  CommandResult,
  CommandRunner,
  RunCommandOptions
} from '../src/process-runner.js';
import { buildProjectPlan } from '../src/planner.js';
import type { ExternalCommand } from '../src/types.js';
import {
  blockingReadinessFailures,
  installRequirement,
  parseLinuxFamily,
  probeRequirement,
  selectWorkstationRequirements,
  type RequirementProbeResult,
  type SelectedRequirement
} from '../src/workstation.js';

const result = (
  command: ExternalCommand,
  values: Partial<CommandResult> = {}
): CommandResult => ({
  command,
  displayCommand: [command.executable, ...command.args].join(' '),
  status: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  ...values
});

class FakeRunner implements CommandRunner {
  calls: Array<{ command: ExternalCommand; options?: RunCommandOptions }> = [];

  constructor(
    private readonly handler: (command: ExternalCommand, call: number) => Partial<CommandResult>
  ) {}

  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push({ command, options });
    return result(command, this.handler(command, this.calls.length));
  }
}

function openspecRequirement(): SelectedRequirement {
  const plan = buildProjectPlan({
    projectName: 'Readiness',
    pattern: 'rag',
    cloud: 'azure'
  }, { requireProjectName: true });
  return selectWorkstationRequirements(plan).find((item) => item.id === 'openspec')!;
}

function missingProbe(requirement: SelectedRequirement): RequirementProbeResult {
  return {
    requirement,
    state: 'missing',
    detail: 'command not found',
    notices: []
  };
}

describe('workstation requirement graph', () => {
  it('selects deterministic blocking and advisory requirements from the full plan', () => {
    const plan = buildProjectPlan({
      projectName: 'Workstation',
      pattern: 'rag',
      cloud: 'azure',
      agents: ['claude', 'copilot']
    }, { requireProjectName: true });
    const requirements = selectWorkstationRequirements(plan);

    expect(requirements.map((item) => item.id)).toEqual([
      'node',
      'python',
      'docker',
      'opentofu',
      'azure-cli',
      'openspec',
      'github-copilot',
      'claude'
    ]);
    expect(requirements.find((item) => item.id === 'python')?.minimumVersion).toBe('3.12.0');
    expect(requirements.find((item) => item.id === 'openspec')?.exactVersion).toBe('1.6.0');
    expect(requirements.find((item) => item.id === 'docker')?.severity).toBe('advisory');
    expect(requirements.find((item) => item.id === 'claude')?.severity).toBe('blocking');
  });

  it('adds Spec Kit prerequisites without lowering a selected runtime floor', () => {
    const plan = buildProjectPlan({
      projectName: 'Kit',
      projectType: 'standard',
      apiStack: 'go',
      cloud: 'azure',
      specWorkflow: 'spec-kit',
      agents: ['claude']
    }, { requireProjectName: true });
    const requirements = selectWorkstationRequirements(plan);

    expect(requirements.map((item) => item.id)).toContain('python');
    expect(requirements.map((item) => item.id)).toContain('uv');
    expect(requirements.find((item) => item.id === 'python')?.minimumVersion).toBe('3.11.0');
    expect(requirements.find((item) => item.id === 'spec-kit')?.exactVersion).toBe('0.14.1');
  });

  it.each([
    ['1.6.0', 'ready'],
    ['1.5.9', 'outdated'],
    ['1.7.0', 'outdated']
  ])('classifies exact framework version %s as %s', async (version, state) => {
    const requirement = openspecRequirement();
    const runner = new FakeRunner(() => ({ stdout: version }));

    expect((await probeRequirement(requirement, runner)).state).toBe(state);
  });

  it('accepts a later compatible launcher when an earlier Python candidate is outdated', async () => {
    const plan = buildProjectPlan({
      projectName: 'Python fallback',
      projectType: 'standard',
      apiStack: 'python',
      cloud: 'azure'
    }, { requireProjectName: true });
    const requirement = selectWorkstationRequirements(plan).find((item) => item.id === 'python')!;
    const runner = new FakeRunner((command) => {
      if (command.executable === 'python3') {
        return { stdout: 'Python 3.10.14' };
      }
      if (command.executable === 'python') {
        return { status: null, errorCode: 'ENOENT', errorMessage: 'missing' };
      }
      return { stdout: 'Python 3.12.8' };
    });

    expect(await probeRequirement(requirement, runner)).toMatchObject({
      state: 'ready',
      detectedVersion: '3.12.8',
      detectedBy: 'py'
    });
  });

  it('detects Copilot through supported VS Code extension identifiers', async () => {
    const plan = buildProjectPlan({
      projectName: 'Copilot',
      pattern: 'rag',
      cloud: 'azure'
    }, { requireProjectName: true });
    const requirement = selectWorkstationRequirements(plan).find((item) => item.id === 'github-copilot')!;
    const runner = new FakeRunner((command) => command.executable === 'copilot'
      ? { status: null, errorCode: 'ENOENT', errorMessage: 'missing' }
      : { stdout: 'publisher.other\nGitHub.copilot-chat\n' });

    const probe = await probeRequirement(requirement, runner);
    expect(probe).toMatchObject({ state: 'ready', detectedBy: 'code --list-extensions' });
    expect(probe.notices[0]?.state).toBe('not-observable');
  });

  it('reports Copilot as not observable when neither discovery path exists', async () => {
    const plan = buildProjectPlan({
      projectName: 'Copilot',
      pattern: 'rag',
      cloud: 'azure'
    }, { requireProjectName: true });
    const requirement = selectWorkstationRequirements(plan).find((item) => item.id === 'github-copilot')!;
    const runner = new FakeRunner(() => ({ status: null, errorCode: 'ENOENT', errorMessage: 'missing' }));
    const probe = await probeRequirement(requirement, runner);

    expect(probe.state).toBe('not-observable');
    expect(blockingReadinessFailures([probe])).toEqual([probe]);
  });

  it('accepts a supported Copilot extension when the Copilot CLI probe fails', async () => {
    const plan = buildProjectPlan({
      projectName: 'Copilot fallback',
      pattern: 'rag',
      cloud: 'azure'
    }, { requireProjectName: true });
    const requirement = selectWorkstationRequirements(plan).find((item) => item.id === 'github-copilot')!;
    const runner = new FakeRunner((command) => command.executable === 'copilot'
      ? { status: 1, stderr: 'CLI setup is incomplete' }
      : { stdout: 'GitHub.copilot\n' });

    expect(await probeRequirement(requirement, runner)).toMatchObject({
      state: 'ready',
      detectedBy: 'code --list-extensions'
    });
  });

  it('keeps Claude doctor failures advisory after the CLI version is ready', async () => {
    const plan = buildProjectPlan({
      projectName: 'Claude',
      pattern: 'rag',
      cloud: 'azure',
      agents: ['claude']
    }, { requireProjectName: true });
    const requirement = selectWorkstationRequirements(plan).find((item) => item.id === 'claude')!;
    const runner = new FakeRunner((command) => command.args[0] === '--version'
      ? { stdout: 'Claude Code 1.0.0' }
      : { status: 1, stderr: 'not authenticated' });
    const probe = await probeRequirement(requirement, runner);

    expect(probe.state).toBe('ready');
    expect(probe.notices).toEqual([
      expect.objectContaining({ label: 'Claude Code doctor', state: 'unhealthy' })
    ]);
  });
});

describe('workstation installation', () => {
  it('runs only cataloged installers and verifies the command afterward', async () => {
    const requirement = openspecRequirement();
    const runner = new FakeRunner((command) => {
      if (command.executable === 'npm' && command.args[0] === '--version') {
        return { stdout: '10.0.0' };
      }
      if (command.executable === 'npm') {
        return { stdout: 'installed' };
      }
      return { stdout: '1.6.0' };
    });
    const installed = await installRequirement(requirement, missingProbe(requirement), {
      authorized: true,
      host: { platform: 'darwin', linuxFamily: 'unknown' },
      runner
    });

    expect(installed.state).toBe('installed');
    expect(runner.calls[1]?.command).toEqual({
      executable: 'npm',
      args: ['install', '-g', '@fission-ai/openspec@1.6.0']
    });
    expect(runner.calls[1]?.options?.stream).toBe(true);
  });

  it('surfaces installer failures and successful installs that still need PATH refresh', async () => {
    const requirement = openspecRequirement();
    const failedRunner = new FakeRunner((command) => command.args[0] === '--version'
      ? { stdout: '10.0.0' }
      : { status: 1, stderr: 'registry unavailable' });
    const failed = await installRequirement(requirement, missingProbe(requirement), {
      authorized: true,
      host: { platform: 'darwin', linuxFamily: 'unknown' },
      runner: failedRunner
    });
    expect(failed).toMatchObject({ state: 'failed', detail: 'registry unavailable' });

    const pathRunner = new FakeRunner((command) => {
      if (command.executable === 'npm' && command.args[0] === '--version') {
        return { stdout: '10.0.0' };
      }
      if (command.executable === 'npm') {
        return { stdout: 'installed' };
      }
      return { status: null, errorCode: 'ENOENT', errorMessage: 'missing' };
    });
    const restart = await installRequirement(requirement, missingProbe(requirement), {
      authorized: true,
      host: { platform: 'darwin', linuxFamily: 'unknown' },
      runner: pathRunner
    });
    expect(restart.state).toBe('restart-required');
    expect(restart.remedy).toContain('npm prefix -g');
    expect(restart.detail).toContain('after checking its documented install location');
    expect(pathRunner.calls.some(({ command }) =>
      command.executable === 'npm' &&
      command.args.join(' ') === 'prefix -g'
    )).toBe(true);
  });

  it('never automates Linux system packages or bootstraps package managers', async () => {
    const plan = buildProjectPlan({
      projectName: 'Linux',
      projectType: 'standard',
      apiStack: 'go',
      cloud: 'azure'
    }, { requireProjectName: true });
    const requirement = selectWorkstationRequirements(plan).find((item) => item.id === 'go')!;
    const runner = new FakeRunner(() => {
      throw new Error('runner should not be called');
    });
    const installation = await installRequirement(requirement, missingProbe(requirement), {
      authorized: true,
      host: { platform: 'linux', linuxFamily: 'debian' },
      runner
    });

    expect(installation.state).toBe('manual');
    expect(installation.remedy).toContain('Debian/Ubuntu');
    expect(runner.calls).toHaveLength(0);
  });

  it('classifies common Linux distributions for exact manual guidance', () => {
    expect(parseLinuxFamily('ID=ubuntu\nID_LIKE=debian\n')).toBe('debian');
    expect(parseLinuxFamily('ID="fedora"\n')).toBe('fedora');
    expect(parseLinuxFamily('ID=manjaro\nID_LIKE=arch\n')).toBe('arch');
    expect(parseLinuxFamily('ID=custom\n')).toBe('unknown');
  });
});
