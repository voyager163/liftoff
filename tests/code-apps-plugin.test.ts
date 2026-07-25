import { describe, expect, it } from 'vitest';
import {
  codeAppsPluginGuidance,
  codeAppsPluginIdentity,
  probeCodeAppsPlugin
} from '../src/code-apps-plugin.js';
import { codeAppsPlugin, getCodingAgent } from '../src/catalogs.js';
import type {
  CommandResult,
  CommandRunner,
  RunCommandOptions
} from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';

function commandResult(
  command: ExternalCommand,
  values: Partial<CommandResult> = {}
): CommandResult {
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

class PluginRunner implements CommandRunner {
  calls: Array<{ command: ExternalCommand; options?: RunCommandOptions }> = [];

  constructor(
    private readonly handler: (command: ExternalCommand) => Partial<CommandResult>
  ) {}

  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push({ command, options });
    return commandResult(command, this.handler(command));
  }
}

function agent(id: 'github-copilot' | 'claude') {
  const definition = getCodingAgent(id);
  if (!definition) {
    throw new Error(`Missing test agent ${id}.`);
  }
  return definition;
}

describe('Code Apps plugin advisory', () => {
  it('keeps canonical preview metadata and targeted manual guidance', () => {
    expect(codeAppsPlugin).toMatchObject({
      id: 'code-apps-preview',
      version: '1.0.0',
      marketplace: 'power-platform-skills',
      repository: 'https://github.com/microsoft/power-platform-skills',
      path: 'plugins/code-apps',
      preview: true
    });
    expect(codeAppsPluginIdentity()).toBe('code-apps-preview@power-platform-skills');
    const guidance = codeAppsPluginGuidance(agent('github-copilot'));
    expect(guidance).toContain('/plugin marketplace add microsoft/power-platform-skills');
    expect(guidance).toContain('/plugin install code-apps-preview@power-platform-skills');
    expect(guidance).toContain('Do not run `/create-code-app`');
    expect(guidance).not.toContain('curl');
    expect(guidance).not.toContain('install.js');
  });

  it('reports selected hosts independently as ready or missing with allowlisted probes', async () => {
    const runner = new PluginRunner((command) => command.executable === 'copilot'
      ? { stdout: 'code-apps-preview 1.0.0 enabled\n' }
      : { stdout: '[]\n' });

    const probes = await probeCodeAppsPlugin(
      [agent('github-copilot'), agent('claude')],
      runner,
      '/workspace/app'
    );

    expect(probes.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: 'code-apps-plugin:github-copilot', state: 'ready' },
      { id: 'code-apps-plugin:claude', state: 'missing' }
    ]);
    expect(runner.calls).toEqual([
      {
        command: { executable: 'copilot', args: ['plugin', 'list'] },
        options: { cwd: '/workspace/app', timeoutMs: 15_000 }
      },
      {
        command: { executable: 'claude', args: ['plugin', 'list', '--json'] },
        options: { cwd: '/workspace/app', timeoutMs: 15_000 }
      }
    ]);
  });

  it('reports unavailable or failed host probes as non-blocking not-observable results', async () => {
    const missingRunner = new PluginRunner(() => ({
      status: null,
      errorCode: 'ENOENT',
      errorMessage: 'not found'
    }));
    const failedRunner = new PluginRunner(() => ({
      status: 2,
      stderr: 'plugin listing is unavailable\nmore detail'
    }));

    await expect(probeCodeAppsPlugin([agent('github-copilot')], missingRunner))
      .resolves.toMatchObject([{
        state: 'not-observable',
        detail: expect.stringContaining('unavailable'),
        remedy: expect.stringContaining('code-apps-preview@power-platform-skills')
      }]);
    await expect(probeCodeAppsPlugin([agent('claude')], failedRunner))
      .resolves.toMatchObject([{
        state: 'not-observable',
        detail: 'plugin listing is unavailable'
      }]);
  });
});
