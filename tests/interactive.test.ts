import { mkdir, readdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import {
  InteractiveCancelledError,
  InteractivePrompter,
  isInteractiveTerminal,
  type AgentCheckboxPrompt
} from '../src/interactive.js';
import { buildProjectPlan } from '../src/planner.js';
import {
  PresentationSession,
  stripAnsi,
  type TerminalLayout
} from '../src/terminal.js';
import {
  CaptureStream,
  ReadyInitRunner,
  scriptedTtyInput,
  ttyCaptureStream
} from './helpers.js';

function scriptedPrompter(answers: string): {
  prompter: InteractivePrompter;
  output: CaptureStream;
} {
  const output = new CaptureStream();
  const presentation = new PresentationSession({
    stdout: output,
    stderr: output,
    snapshot: true,
    columns: 100
  });
  return {
    prompter: new InteractivePrompter({
      input: Readable.from([answers]),
      output,
      presentation
    }),
    output
  };
}

describe('interactive presentation', () => {
  it('requires TTY input and output without requiring raw mode for line prompts', () => {
    const input = scriptedTtyInput('');
    const output = ttyCaptureStream();

    expect(isInteractiveTerminal(input, output)).toBe(true);
    expect(isInteractiveTerminal(Readable.from([]), output)).toBe(false);
    expect(isInteractiveTerminal(input, new CaptureStream())).toBe(false);
  });

  it('handles defaults, invalid choices, disabled providers, ambiguous regions, and multi-agent selection', async () => {
    const { prompter, output } = scriptedPrompter(
      '\nlaunch-app\n\n99\n2\n2\n1\nkorea\n2\n\n\n\n2\n9\n1,2\n2\n'
    );
    try {
      const options = await prompter.promptForInitOptions({});

      expect(options).toMatchObject({
        projectName: 'launch-app',
        projectType: 'genai',
        pattern: 'rag',
        apiStack: 'python-fastapi',
        cloud: 'azure',
        region: 'koreasouth',
        includeFrontend: false,
        governanceProfile: 'single-maintainer-gitflow',
        specWorkflow: 'spec-kit',
        agents: ['github-copilot', 'claude'],
        defaultAgent: 'claude',
        environments: ['dev', 'staging', 'prod']
      });

      expect(output.text()).toContain('Project name is required');
      expect(output.text()).toContain('Please choose a valid option');
      expect(output.text()).toContain('AWS - planned is not available in V1');
      expect(output.text()).toContain('Matching Azure regions');
      expect(output.text()).toContain('Please choose valid agent options');
    } finally {
      prompter.close();
    }
  });

  it('defaults an undecided GenAI project to the generic starter', async () => {
    const { prompter, output } = scriptedPrompter('\n');
    try {
      const options = await prompter.promptForInitOptions({
        projectName: 'generic-app',
        projectType: 'genai',
        cloud: 'azure',
        region: 'eastus',
        includeFrontend: false,
        environments: ['dev'],
        governanceProfile: 'none',
        specWorkflow: 'openspec',
        agents: ['github-copilot'],
        copilotCloud: false
      });

      expect(options.pattern).toBe('generic');
      expect(output.text()).toContain(
        "I'm not sure yet - Generic GenAI starter (foundation)"
      );
    } finally {
      prompter.close();
    }
  });

  it('handles the standard API branch and accepted default values', async () => {
    const { prompter, output } = scriptedPrompter(
      '2\n\n1\n\ny\ndev,prod\n\n\n\n\n'
    );
    try {
      const options = await prompter.promptForInitOptions({ projectName: 'standard-api' });

      expect(options).toMatchObject({
        projectType: 'standard',
        apiStack: 'python-fastapi',
        cloud: 'azure',
        region: 'eastus',
        includeFrontend: true,
        governanceProfile: 'single-maintainer-gitflow',
        specWorkflow: 'openspec',
        agents: ['github-copilot'],
        copilotCloud: false,
        environments: ['dev', 'prod']
      });
      expect(output.text()).toContain('Python / FastAPI');
      expect(output.text()).toContain('East US / eastus');
      expect(output.text()).toContain('GitHub Copilot');
      expect(output.text()).toContain('GitHub-hosted Copilot coding agent');
    } finally {
      prompter.close();
    }
  });

  it('routes Power Apps directly into the shared workflow and agent tail', async () => {
    const { prompter, output } = scriptedPrompter('3\ny\n\n\n1,2\n\n');
    try {
      const options = await prompter.promptForInitOptions({
        projectName: 'power-workspace'
      });

      expect(options).toMatchObject({
        projectType: 'power-apps-code-app',
        specWorkflow: 'openspec',
        agents: ['github-copilot', 'claude'],
        copilotCloud: false,
        codeAppsPlugin: true,
        governanceProfile: 'single-maintainer-gitflow'
      });

      expect(options.apiStack).toBeUndefined();
      expect(options.pattern).toBeUndefined();
      expect(options.cloud).toBeUndefined();
      expect(options.region).toBeUndefined();
      expect(options.includeFrontend).toBeUndefined();
      expect(options.environments).toBeUndefined();
      expect(output.text()).toContain('Power Apps code app');
      expect(output.text()).toContain('Microsoft Code Apps preview plugin guidance');
      expect(output.text()).not.toContain('Target cloud');
    } finally {
      prompter.close();
    }
  });

  it('allows an explicit interactive governance opt-out after architecture choices', async () => {
    const { prompter, output } = scriptedPrompter('n\n\n');
    try {
      const options = await prompter.promptForInitOptions({
        projectName: 'opt-out',
        projectType: 'standard',
        apiStack: 'node',
        cloud: 'azure',
        region: 'eastus',
        includeFrontend: false,
        environments: ['dev'],
        specWorkflow: 'openspec',
        agents: ['copilot']
      });
      expect(options.governanceProfile).toBe('none');
      expect(options.copilotCloud).toBe(false);
      expect(output.text()).toContain(
        'Generate the single-maintainer GitFlow governance handoff?'
      );
    } finally {
      prompter.close();
    }
  });

  it('uses configured markers before detected agents and resumes line input after the checkbox', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-agent-discovery-'));
    const marker = path.join(
      root,
      '.github',
      'skills',
      'openspec-apply-change',
      'SKILL.md'
    );
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, 'configured\n');
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      setRawMode: ReturnType<typeof vi.fn>;
    };
    input.isTTY = true;
    input.setRawMode = vi.fn();
    const output = new CaptureStream() as CaptureStream & { isTTY: boolean };
    output.isTTY = true;
    const runner = new ReadyInitRunner({ missing: ['copilot'] });
    const checkboxPrompt = vi.fn<AgentCheckboxPrompt>(async (config, context) => {
      expect(context).toMatchObject({ input, output });
      expect(config.required).toBe(true);
      expect(config.validate([])).toBe('Select at least one AI coding agent.');
      expect(config.choices).toEqual([
        expect.objectContaining({
          name: 'GitHub Copilot (configured)',
          value: 'github-copilot',
          checked: true
        }),
        expect.objectContaining({
          name: 'Claude Code (detected)',
          value: 'claude',
          checked: false
        })
      ]);
      setTimeout(() => input.end('n\n'), 0);
      return ['claude', 'github-copilot'];
    });
    const prompter = new InteractivePrompter({
      input,
      output,
      cwd: root,
      configuredRoot: root,
      runner,
      checkboxPrompt
    });
    try {
      setTimeout(() => input.write('configured-app\n'), 0);
      const options = await prompter.promptForInitOptions({
        projectType: 'power-apps-code-app',
        specWorkflow: 'openspec',
        governanceProfile: 'single-maintainer-gitflow',
        codeAppsPlugin: false
      });

      expect(options.agents).toEqual(['github-copilot', 'claude']);
      expect(options.codeAppsPlugin).toBe(false);
      expect(checkboxPrompt).toHaveBeenCalledOnce();
      expect(runner.calls).toHaveLength(2);
      expect(runner.calls).toEqual(expect.arrayContaining([
        { executable: 'copilot', args: ['--version'] },
        { executable: 'claude', args: ['--version'] }
      ]));
    } finally {
      prompter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not treat general .github or .claude directories as configured integrations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-agent-unconfigured-'));
    await mkdir(path.join(root, '.github'), { recursive: true });
    await mkdir(path.join(root, '.claude'), { recursive: true });
    await writeFile(path.join(root, '.github', 'README.md'), 'general GitHub configuration\n');
    await writeFile(path.join(root, '.claude', 'settings.json'), '{}\n');
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      setRawMode: ReturnType<typeof vi.fn>;
    };
    input.isTTY = true;
    input.setRawMode = vi.fn();
    const output = new CaptureStream() as CaptureStream & { isTTY: boolean };
    output.isTTY = true;
    const runner = new ReadyInitRunner({ missing: ['copilot', 'claude'] });
    const checkboxPrompt = vi.fn<AgentCheckboxPrompt>(async (config) => {
      expect(config.choices).toEqual([
        expect.objectContaining({
          name: 'GitHub Copilot (not observable)',
          value: 'github-copilot',
          checked: true
        }),
        expect.objectContaining({
          name: 'Claude Code (not observable)',
          value: 'claude',
          checked: false
        })
      ]);
      setTimeout(() => input.end('n\n'), 0);
      return ['github-copilot'];
    });
    const prompter = new InteractivePrompter({
      input,
      output,
      cwd: root,
      configuredRoot: root,
      runner,
      checkboxPrompt
    });
    try {
      setTimeout(() => input.write('unconfigured-app\n'), 0);
      const options = await prompter.promptForInitOptions({
        projectType: 'power-apps-code-app',
        specWorkflow: 'openspec',
        governanceProfile: 'single-maintainer-gitflow',
        codeAppsPlugin: false
      });

      expect(options.agents).toEqual(['github-copilot']);
      expect(checkboxPrompt).toHaveBeenCalledOnce();
    } finally {
      prompter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bypasses discovery and selectors when agents are already configured', async () => {
    const runner = new ReadyInitRunner();
    const checkboxPrompt = vi.fn<AgentCheckboxPrompt>();
    const prompter = new InteractivePrompter({
      input: Readable.from([]),
      output: new CaptureStream(),
      runner,
      checkboxPrompt
    });
    try {
      const options = await prompter.promptForInitOptions({
        projectName: 'configured-options',
        projectType: 'power-apps-code-app',
        specWorkflow: 'openspec',
        agents: ['claude'],
        codeAppsPlugin: false,
        governanceProfile: 'single-maintainer-gitflow'
      });

      expect(options.agents).toEqual(['claude']);
      expect(runner.calls).toEqual([]);
      expect(checkboxPrompt).not.toHaveBeenCalled();
    } finally {
      prompter.close();
    }
  });

  it('normalizes checkbox cancellation and line-input EOF', async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      setRawMode: ReturnType<typeof vi.fn>;
    };
    input.isTTY = true;
    input.setRawMode = vi.fn();
    const output = new CaptureStream() as CaptureStream & { isTTY: boolean };
    output.isTTY = true;
    const exitError = new Error('User force closed the prompt');
    exitError.name = 'ExitPromptError';
    const checkboxPrompt: AgentCheckboxPrompt = async () => {
      throw exitError;
    };
    const ttyPrompter = new InteractivePrompter({
      input,
      output,
      checkboxPrompt
    });
    await expect(ttyPrompter.promptForInitOptions({
      projectName: 'cancelled-app',
      projectType: 'power-apps-code-app',
      specWorkflow: 'openspec',
      governanceProfile: 'single-maintainer-gitflow',
      codeAppsPlugin: false
    })).rejects.toBeInstanceOf(InteractiveCancelledError);
    ttyPrompter.close();

    const eofPrompter = new InteractivePrompter({
      input: Readable.from([]),
      output: new CaptureStream()
    });
    await expect(eofPrompter.promptForInitOptions({}))
      .rejects.toThrow(/Interactive input closed before answering: Project name/);
    eofPrompter.close();
  });

  it('accepts Windows Terminal navigation, Space, and Enter through the real checkbox', async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      setRawMode: ReturnType<typeof vi.fn>;
    };
    input.isTTY = true;
    input.setRawMode = vi.fn();
    const output = new CaptureStream() as CaptureStream & {
      isTTY: boolean;
      columns: number;
    };
    output.isTTY = true;
    output.columns = 100;
    const prompter = new InteractivePrompter({ input, output });
    try {
      const pending = prompter.promptForInitOptions({
        projectName: 'keyboard-app',
        projectType: 'power-apps-code-app',
        specWorkflow: 'openspec',
        codeAppsPlugin: false,
        copilotCloud: false,
        governanceProfile: 'single-maintainer-gitflow'
      });
      setTimeout(() => input.write('\u001B[B \r'), 50);

      const options = await pending;

      expect(options.agents).toEqual(['github-copilot', 'claude']);
      expect(input.setRawMode).toHaveBeenCalledWith(true);
      expect(input.setRawMode).toHaveBeenLastCalledWith(false);
      expect(output.text()).toContain('Select one or more AI coding agents');
    } finally {
      input.end();
      prompter.close();
    }
  });

  it('restores raw mode when Ctrl+C cancels the real checkbox', async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      setRawMode: ReturnType<typeof vi.fn>;
    };
    input.isTTY = true;
    input.setRawMode = vi.fn();
    const output = new CaptureStream() as CaptureStream & {
      isTTY: boolean;
      columns: number;
    };
    output.isTTY = true;
    output.columns = 100;
    const prompter = new InteractivePrompter({ input, output });
    try {
      const pending = prompter.promptForInitOptions({
        projectName: 'cancel-keyboard-app',
        projectType: 'power-apps-code-app',
        specWorkflow: 'openspec',
        codeAppsPlugin: false,
        copilotCloud: false,
        governanceProfile: 'single-maintainer-gitflow'
      });
      setTimeout(() => input.write('\u0003'), 50);

      await expect(pending).rejects.toBeInstanceOf(InteractiveCancelledError);
      expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    } finally {
      input.end();
      prompter.close();
    }
  });

  it('keeps fallback agent selection stable across terminal layouts and NO_COLOR', async () => {
    const render = async (layout: TerminalLayout, noColor = false) => {
      const output = new CaptureStream();
      const presentation = new PresentationSession({
        stdout: output,
        stderr: output,
        layout,
        columns: layout === 'full' ? 100 : 72,
        snapshot: !noColor,
        color: true,
        env: noColor ? { NO_COLOR: '1' } : {}
      });
      const prompter = new InteractivePrompter({
        input: Readable.from(['\n']),
        output,
        presentation
      });
      try {
        await prompter.promptForInitOptions({
          projectName: 'layout-app',
          projectType: 'power-apps-code-app',
          specWorkflow: 'openspec',
          codeAppsPlugin: false,
          copilotCloud: false,
          governanceProfile: 'single-maintainer-gitflow'
        });
        return output.text();
      } finally {
        prompter.close();
      }
    };

    const snapshots = {
      rich: await render('full'),
      compact: await render('compact'),
      plain: await render('plain'),
      noColor: await render('compact', true)
    };

    expect(snapshots).toMatchInlineSnapshot(`
      {
        "compact": "Select one or more AI coding agents
      ───────────────────────────────────
      ● GitHub Copilot (not observable) (github-copilot) [default]
      2. Claude Code (not observable) (claude)

      ? Select comma-separated options [1]: ",
        "noColor": "Select one or more AI coding agents
      ───────────────────────────────────
      ● GitHub Copilot (not observable) (github-copilot) [default]
      2. Claude Code (not observable) (claude)

      ? Select comma-separated options [1]: ",
        "plain": "Select one or more AI coding agents
      ● GitHub Copilot (not observable) (github-copilot) [default]
      2. Claude Code (not observable) (claude)

      ? Select comma-separated options [1]: ",
        "rich": "┌─ Select one or more AI coding agents ────────────────────────────────────────────────────────┐
      │ ● 1. GitHub Copilot (not observable) (github-copilot) [default]                              │
      │ ○ 2. Claude Code (not observable) (claude)                                                   │
      └──────────────────────────────────────────────────────────────────────────────────────────────┘
      ? Select comma-separated options [1]: ",
      }
    `);
    expect(stripAnsi(snapshots.noColor)).toBe(snapshots.noColor);
  });

  it('renders independent plan, file, machine-tool, and dependency consent details', async () => {
    const plan = buildProjectPlan({
      projectName: 'consent-app',
      pattern: 'rag',
      cloud: 'azure',
      region: 'eastus'
    }, { requireProjectName: true });

    const planPrompt = scriptedPrompter('n\n');
    try {
      expect(await planPrompt.prompter.confirmPlan(plan)).toBe(false);
      expect(planPrompt.output.text()).toContain('Resolved project plan');
      expect(planPrompt.output.text()).toContain('Initialize project?');
    } finally {
      planPrompt.prompter.close();
    }

    const filesPrompt = scriptedPrompter('n\n');
    try {
      expect(await filesPrompt.prompter.confirmFileReplacements([
        'README.md',
        'backend/package.json'
      ])).toBe(false);
      expect(filesPrompt.output.text()).toContain('README.md');
      expect(filesPrompt.output.text()).toContain('backend/package.json');
    } finally {
      filesPrompt.prompter.close();
    }

    const toolPrompt = scriptedPrompter('y\n');
    try {
      expect(await toolPrompt.prompter.confirmToolInstallation({
        label: 'OpenSpec',
        severity: 'blocking',
        purpose: 'selected spec-driven framework',
        requirement: 'required exactly 1.11.0',
        observed: 'missing - command not found',
        command: 'npm install -g @fission-ai/openspec@1.11.0'
      })).toBe(true);
      expect(toolPrompt.output.text()).toContain('selected spec-driven framework');
      expect(toolPrompt.output.text()).toContain('npm install -g @fission-ai/openspec@1.11.0');
    } finally {
      toolPrompt.prompter.close();
    }

    const dependencyPrompt = scriptedPrompter('n\n');
    try {
      expect(await dependencyPrompt.prompter.confirmDependencyInstallation([{
        id: 'node-backend',
        label: 'Install backend Node.js dependencies',
        cwd: 'C:\\workspace\\consent-app\\backend',
        command: { executable: 'npm.cmd', args: ['ci'] }
      }])).toBe(false);
      expect(dependencyPrompt.output.text()).toContain('C:\\workspace\\consent-app\\backend');
      expect(dependencyPrompt.output.text()).toContain('npm.cmd ci');
    } finally {
      dependencyPrompt.prompter.close();
    }

    const profilePrompt = scriptedPrompter('y\n');
    try {
      expect(await profilePrompt.prompter.confirmOpenSpecProfileConfiguration({
        observed: [
          { label: 'Profile', value: 'core' },
          { label: 'Delivery', value: 'skills' },
          { label: 'Workflows', value: 'propose, apply' }
        ],
        required: [
          { label: 'Profile', value: 'custom' },
          { label: 'Delivery', value: 'both' },
          { label: 'Workflows', value: 'all 12' }
        ],
        differences: ['profile "core" -> "custom"'],
        commands: ['openspec config set profile custom']
      })).toBe(true);
      expect(profilePrompt.output.text()).toContain('Observed global OpenSpec profile');
      expect(profilePrompt.output.text()).toContain('Required global OpenSpec profile');
      expect(profilePrompt.output.text()).toContain('openspec config set profile custom');
    } finally {
      profilePrompt.prompter.close();
    }
  });

  it('cancels init through the shared status without changing the destination', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-interactive-cancel-'));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    try {
      const code = await runCommand(parseArgs([
        'init',
        'cancel-app',
        '--pattern',
        'rag',
        '--cloud',
        'azure',
        '--region',
        'eastus',
        '--spec',
        'openspec',
        '--agents',
        'copilot',
        '--no-copilot-cloud',
        '--no-frontend',
        '--environments',
        'dev'
      ]), {
        cwd: root,
        stdin: Readable.from(['n\n']),
        stdout,
        stderr,
        runner: new ReadyInitRunner()
      });

      expect(code).toBe(0);
      expect(stdout.text()).toContain('Liftoff - Initialize the project');
      expect(stdout.text()).toContain('[info] Cancelled');
      expect(await readdir(root)).toEqual([]);
      expect(stderr.text()).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats interactive EOF as cancellation before destination writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-interactive-eof-'));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    try {
      const code = await runCommand(parseArgs(['init']), {
        cwd: root,
        stdin: Readable.from([]),
        stdout,
        stderr,
        runner: new ReadyInitRunner()
      });

      expect(code).toBe(0);
      expect(stdout.text()).toContain('[info] Cancelled');
      expect(await readdir(root)).toEqual([]);
      expect(stderr.text()).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
