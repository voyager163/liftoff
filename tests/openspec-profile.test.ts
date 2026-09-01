import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildOpenSpecProfileReadCommand,
  buildOpenSpecProfileWriteCommands,
  compareOpenSpecProfile,
  configureOpenSpecProfile,
  inspectOpenSpecProfile,
  OPEN_SPEC_COPILOT_CLOUD_PATHS,
  OPEN_SPEC_DELIVERY,
  OPEN_SPEC_PROFILE,
  OPEN_SPEC_WORKFLOW_IDS,
  openSpecIntegrationPaths,
  type OpenSpecGlobalProfile
} from '../src/openspec-profile.js';
import type {
  CommandResult,
  CommandRunner,
  RunCommandOptions
} from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';

class ProfileRunner implements CommandRunner {
  calls: Array<{ command: ExternalCommand; options?: RunCommandOptions }> = [];
  state: OpenSpecGlobalProfile & { telemetry: { enabled: boolean }; future: string };

  constructor(
    state: Partial<OpenSpecGlobalProfile> = {},
    private readonly behavior:
      | 'success'
      | 'malformed'
      | 'read-failure'
      | 'read-timeout'
      | 'missing-workflows'
      | 'write-failure'
      | 'verify-mismatch' = 'success'
  ) {
    this.state = {
      profile: state.profile ?? 'core',
      delivery: state.delivery ?? 'skills',
      workflows: state.workflows ? [...state.workflows] : ['propose'],
      telemetry: { enabled: false },
      future: 'preserved'
    };
  }

  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push({ command, options });
    if (command.args[1] === 'list') {
      if (this.behavior === 'read-failure') {
        return result(command, { status: 1, stderr: 'unable to read config\n' });
      }
      if (this.behavior === 'read-timeout') {
        return result(command, { timedOut: true, status: null });
      }
      if (this.behavior === 'malformed') {
        return result(command, { stdout: '{not-json\n' });
      }
      if (this.behavior === 'missing-workflows') {
        const { workflows: _workflows, ...defaultConfig } = this.state;
        return result(command, { stdout: `${JSON.stringify(defaultConfig)}\n` });
      }
      return result(command, { stdout: `${JSON.stringify(this.state)}\n` });
    }
    if (this.behavior === 'write-failure' && command.args[2] === 'delivery') {
      return result(command, { status: 1, stderr: 'write failed\n' });
    }
    const key = command.args[2];
    const value = command.args[3];
    if (key === 'workflows') {
      this.state.workflows = JSON.parse(value) as string[];
    } else if (key === 'delivery') {
      this.state.delivery = value;
    } else if (key === 'profile' && this.behavior !== 'verify-mismatch') {
      this.state.profile = value;
    }
    return result(command, { stdout: `Set ${key}\n` });
  }
}

function result(command: ExternalCommand, values: Partial<CommandResult> = {}): CommandResult {
  return {
    command,
    displayCommand: [command.executable, ...command.args].join(' '),
    status: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...values
  };
}

describe('OpenSpec complete profile contract', () => {
  it('catalogs all OpenSpec 1.11 workflows and exact generated paths', () => {
    expect(OPEN_SPEC_PROFILE).toBe('custom');
    expect(OPEN_SPEC_DELIVERY).toBe('both');
    expect(OPEN_SPEC_WORKFLOW_IDS).toEqual([
      'propose',
      'explore',
      'new',
      'continue',
      'apply',
      'update',
      'ff',
      'sync',
      'archive',
      'bulk-archive',
      'verify',
      'onboard'
    ]);
    expect(openSpecIntegrationPaths('github-copilot')).toHaveLength(24);
    expect(openSpecIntegrationPaths('claude')).toHaveLength(24);
    expect(openSpecIntegrationPaths('github-copilot')).toContainEqual([
      '.github', 'skills', 'openspec-bulk-archive-change', 'SKILL.md'
    ]);
    expect(openSpecIntegrationPaths('github-copilot')).toContainEqual([
      '.github', 'prompts', 'opsx-bulk-archive.prompt.md'
    ]);
    expect(openSpecIntegrationPaths('claude')).toContainEqual([
      '.claude', 'commands', 'opsx', 'bulk-archive.md'
    ]);
    expect(OPEN_SPEC_COPILOT_CLOUD_PATHS.map((parts) => path.join(...parts))).toEqual([
      path.join('.github', 'workflows', 'copilot-setup-steps.yml'),
      path.join('.github', 'agents', 'openspec.agent.md')
    ]);
  });

  it('compares workflow membership independently of order and reports all drift', () => {
    expect(compareOpenSpecProfile({
      profile: 'custom',
      delivery: 'both',
      workflows: [...OPEN_SPEC_WORKFLOW_IDS].reverse()
    }).compatible).toBe(true);

    const mismatch = compareOpenSpecProfile({
      profile: 'core',
      delivery: 'skills',
      workflows: ['propose', 'propose', 'future']
    });
    expect(mismatch.compatible).toBe(false);
    expect(mismatch.differences.join('\n')).toMatch(/profile.*delivery.*add workflows.*remove workflows.*duplicate/s);
  });

  it('uses the machine-readable profile command and rejects unreadable output', async () => {
    const runner = new ProfileRunner({
      profile: 'custom',
      delivery: 'both',
      workflows: [...OPEN_SPEC_WORKFLOW_IDS]
    });
    await expect(inspectOpenSpecProfile('openspec', runner)).resolves.toMatchObject({
      compatible: true
    });
    expect(runner.calls[0]?.command).toEqual(buildOpenSpecProfileReadCommand());

    await expect(inspectOpenSpecProfile('openspec', new ProfileRunner({}, 'malformed')))
      .rejects.toThrow(/not valid JSON/);
    await expect(inspectOpenSpecProfile('openspec', new ProfileRunner({}, 'read-failure')))
      .rejects.toThrow(/unable to read config/);
    await expect(inspectOpenSpecProfile('openspec', new ProfileRunner({}, 'read-timeout')))
      .rejects.toThrow(/timed out/);

    await expect(inspectOpenSpecProfile(
      'openspec',
      new ProfileRunner({ profile: 'core', delivery: 'both' }, 'missing-workflows')
    )).resolves.toMatchObject({
      compatible: false,
      state: { profile: 'core', delivery: 'both', workflows: [] }
    });
  });

  it('sets workflows and delivery before profile, preserves unrelated state, and verifies', async () => {
    const runner = new ProfileRunner();
    await expect(configureOpenSpecProfile('openspec', runner, {
      cwd: '/workspace',
      env: { XDG_CONFIG_HOME: '/isolated' }
    })).resolves.toMatchObject({ compatible: true });

    expect(runner.calls.slice(0, 3).map(({ command }) => command)).toEqual(
      buildOpenSpecProfileWriteCommands()
    );
    expect(runner.calls.at(-1)?.command).toEqual(buildOpenSpecProfileReadCommand());
    expect(runner.state).toMatchObject({
      profile: 'custom',
      delivery: 'both',
      workflows: [...OPEN_SPEC_WORKFLOW_IDS],
      telemetry: { enabled: false },
      future: 'preserved'
    });
    expect(runner.calls.every(({ options }) =>
      options?.env?.XDG_CONFIG_HOME === '/isolated'
    )).toBe(true);
  });

  it('stops on a failed write and rejects a mismatched verification result', async () => {
    const failed = new ProfileRunner({}, 'write-failure');
    await expect(configureOpenSpecProfile('openspec', failed)).rejects.toThrow(/write failed/);
    expect(failed.calls.some(({ command }) => command.args.includes('profile'))).toBe(false);

    await expect(configureOpenSpecProfile(
      'openspec',
      new ProfileRunner({}, 'verify-mismatch')
    )).rejects.toThrow(/verification failed/);
  });
});
