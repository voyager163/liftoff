import { readdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { InteractivePrompter } from '../src/interactive.js';
import { buildProjectPlan } from '../src/planner.js';
import { PresentationSession } from '../src/terminal.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

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
  it('handles defaults, invalid choices, disabled providers, ambiguous regions, and multi-agent selection', async () => {
    const { prompter, output } = scriptedPrompter(
      '\nlaunch-app\n\n99\n1\n2\n1\nkorea\n2\n\n2\n9\n1,2\n2\n\n'
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
        specWorkflow: 'spec-kit',
        agents: ['github-copilot', 'claude'],
        defaultAgent: 'claude',
        environments: ['dev', 'test', 'prod']
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

  it('handles the standard API branch and accepted default values', async () => {
    const { prompter, output } = scriptedPrompter(
      'n\n\n1\n\ny\n\n\ndev,prod\n'
    );
    try {
      const options = await prompter.promptForInitOptions({ projectName: 'standard-api' });

      expect(options).toMatchObject({
        projectType: 'standard',
        apiStack: 'python-fastapi',
        cloud: 'azure',
        region: 'eastus',
        includeFrontend: true,
        specWorkflow: 'openspec',
        agents: ['github-copilot'],
        environments: ['dev', 'prod']
      });
      expect(output.text()).toContain('Python / FastAPI');
      expect(output.text()).toContain('East US / eastus');
      expect(output.text()).toContain('GitHub Copilot');
    } finally {
      prompter.close();
    }
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
        requirement: 'required exactly 1.6.0',
        observed: 'missing - command not found',
        command: 'npm install -g @fission-ai/openspec@1.6.0'
      })).toBe(true);
      expect(toolPrompt.output.text()).toContain('selected spec-driven framework');
      expect(toolPrompt.output.text()).toContain('npm install -g @fission-ai/openspec@1.6.0');
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
});
