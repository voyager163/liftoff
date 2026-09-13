import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { InteractivePrompter, type AgentCheckboxPrompt } from '../src/interactive.js';
import type { CommandRunner } from '../src/process-runner.js';
import type { CodingAgentId, ProjectOptions, SpecWorkflowId } from '../src/types.js';
import { CaptureStream } from './helpers.js';

const baseOptions: ProjectOptions = {
  projectName: 'Codex interactive',
  projectType: 'standard',
  apiStack: 'node',
  cloud: 'azure',
  region: 'eastus',
  includeFrontend: false,
  environments: ['dev'],
  governanceProfile: 'none',
  copilotCloud: false
};
const subsets: CodingAgentId[][] = [
  ['github-copilot'], ['claude'], ['github-copilot', 'claude'], ['codex'],
  ['github-copilot', 'codex'], ['claude', 'codex'], ['github-copilot', 'claude', 'codex']
];
const selections = subsets.flatMap((agents) => [
  { specWorkflow: 'openspec' as SpecWorkflowId, agents, defaultAgent: undefined },
  ...agents.map((defaultAgent) => ({ specWorkflow: 'spec-kit' as SpecWorkflowId, agents, defaultAgent }))
]);

describe('three-agent interactive selection', () => {
  it.each(selections)('selects $specWorkflow agents=$agents default=$defaultAgent', async ({
    specWorkflow, agents, defaultAgent
  }) => {
    const answers = [
      [...agents].reverse().join(','),
      ...(specWorkflow === 'spec-kit' && agents.length > 1 ? [String(agents.indexOf(defaultAgent!) + 1)] : [])
    ].join('\n') + '\n';
    const output = new CaptureStream();
    const prompter = new InteractivePrompter({ input: Readable.from([answers]), output });
    try {
      const options = await prompter.promptForInitOptions({ ...baseOptions, specWorkflow });
      expect(options.agents).toEqual(agents);
      expect(options.defaultAgent).toBe(defaultAgent);
      expect(output.text()).toContain('OpenAI Codex');
    } finally {
      prompter.close();
    }
  });

  it('rejects an empty comma list and normalizes repeated Codex aliases', async () => {
    const output = new CaptureStream();
    const prompter = new InteractivePrompter({
      input: Readable.from([', ,\nCODEX,OpenAI Codex,codex\n']),
      output
    });
    try {
      const options = await prompter.promptForInitOptions({ ...baseOptions, specWorkflow: 'openspec' });
      expect(options.agents).toEqual(['codex']);
      expect(output.text()).toContain('Please choose valid agent options');
    } finally {
      prompter.close();
    }
  });

  it.each(['openspec', 'spec-kit'] as const)('prefers configured Codex markers in the %s native selector', async (specWorkflow) => {
    const root = await mkdtemp(path.join(process.cwd(), '.codex-interactive-test-'));
    const skill = specWorkflow === 'openspec' ? 'openspec-apply-change' : 'speckit-specify';
    const marker = path.join(root, '.agents', 'skills', skill, 'SKILL.md');
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, '# Native Codex integration\n');
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    const output = Object.assign(new CaptureStream(), { isTTY: true });
    const probed: string[] = [];
    const runner: CommandRunner = {
      async run(command) {
        probed.push(command.executable);
        return {
          command, displayCommand: [command.executable, ...command.args].join(' '),
          status: command.executable === 'claude' ? 0 : 1, signal: null,
          stdout: '', stderr: '', timedOut: false
        };
      }
    };
    const checkboxPrompt: AgentCheckboxPrompt = async ({ choices, validate }) => {
      expect(choices).toEqual([
        { name: 'GitHub Copilot (not observable)', value: 'github-copilot', checked: false },
        { name: 'Claude Code (detected)', value: 'claude', checked: false },
        { name: 'OpenAI Codex (configured)', value: 'codex', checked: true }
      ]);
      expect(validate([])).toBe('Select at least one AI coding agent.');
      expect(validate(['codex'])).toBe(true);
      return ['codex'];
    };
    const prompter = new InteractivePrompter({
      input, output, runner, checkboxPrompt, cwd: root, configuredRoot: root
    });
    try {
      const options = await prompter.promptForInitOptions({ ...baseOptions, specWorkflow });
      expect(options.agents).toEqual(['codex']);
      expect(options.defaultAgent).toBe(specWorkflow === 'spec-kit' ? 'codex' : undefined);
      expect(probed).toHaveLength(3);
      expect(probed).toEqual(expect.arrayContaining(['copilot', 'claude', 'codex']));
    } finally {
      input.end();
      prompter.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
