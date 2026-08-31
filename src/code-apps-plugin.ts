import { codeAppsPlugin } from './catalogs.js';
import type { CommandRunner } from './process-runner.js';
import type { CodingAgentDefinition, CodingAgentId } from './types.js';

export type CodeAppsPluginState = 'ready' | 'missing' | 'not-observable';

export interface CodeAppsPluginProbe {
  agent: CodingAgentDefinition;
  id: `code-apps-plugin:${CodingAgentId}`;
  state: CodeAppsPluginState;
  detail: string;
  remedy?: string;
}

export function codeAppsPluginIdentity(): string {
  return `${codeAppsPlugin.id}@${codeAppsPlugin.marketplace}`;
}

export function codeAppsPluginGuidance(agent: CodingAgentDefinition): string {
  return [
    `Open ${agent.label} and add the marketplace with`,
    '`/plugin marketplace add microsoft/power-platform-skills`, then install',
    `\`/plugin install ${codeAppsPluginIdentity()}\`.`,
    'Do not run `/create-code-app` in this project; use the connector and deployment skills',
    'after Liftoff creates the application.'
  ].join(' ');
}

export async function probeCodeAppsPlugin(
  agents: CodingAgentDefinition[],
  runner: CommandRunner,
  cwd?: string
): Promise<CodeAppsPluginProbe[]> {
  return Promise.all(agents.map(async (agent): Promise<CodeAppsPluginProbe> => {
    const id = `code-apps-plugin:${agent.id}` as const;
    const command = codeAppsPlugin.probes[agent.id];
    if (!command) {
      return {
        agent,
        id,
        state: 'not-observable',
        detail: `${agent.label} has no allowlisted plugin-list probe.`,
        remedy: codeAppsPluginGuidance(agent)
      };
    }
    const result = await runner.run(command, { cwd, timeoutMs: 15_000 });
    if (result.errorCode === 'ENOENT' || result.errorCode === 'UNKNOWN') {
      return {
        agent,
        id,
        state: 'not-observable',
        detail: `${agent.label} is unavailable, so plugin state cannot be observed.`,
        remedy: codeAppsPluginGuidance(agent)
      };
    }
    if (result.status !== 0 || result.timedOut) {
      return {
        agent,
        id,
        state: 'not-observable',
        detail: result.timedOut
          ? `${agent.label} plugin-list probe timed out.`
          : (result.stderr || result.errorMessage || `${agent.label} does not expose plugin state through this command.`)
            .trim()
            .split(/\r?\n/)[0],
        remedy: codeAppsPluginGuidance(agent)
      };
    }
    const installed = `${result.stdout}\n${result.stderr}`
      .toLowerCase()
      .includes(codeAppsPlugin.id);
    return installed
      ? {
          agent,
          id,
          state: 'ready',
          detail: `${codeAppsPluginIdentity()} ${codeAppsPlugin.version} is reported by ${agent.label}.`
        }
      : {
          agent,
          id,
          state: 'missing',
          detail: `${codeAppsPluginIdentity()} is not listed by ${agent.label}.`,
          remedy: codeAppsPluginGuidance(agent)
        };
  }));
}
