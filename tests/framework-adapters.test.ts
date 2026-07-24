import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildOpenSpecInitCommand,
  buildSpecKitInitCommands,
  initializeFramework
} from '../src/framework-adapters.js';
import { loadManifest, validateGeneratedProject } from '../src/file-system.js';
import { validateFrameworkInstallation } from '../src/framework-validation.js';
import { validateStagedTree, withStagingArea, writeStagedArtifacts } from '../src/init-filesystem.js';
import type {
  CommandResult,
  CommandRunner,
  RunCommandOptions
} from '../src/process-runner.js';
import { buildProjectPlan } from '../src/planner.js';
import { reconcileProject } from '../src/reconcile.js';
import { buildArtifacts, partitionGeneratedArtifacts } from '../src/templates.js';
import type { ExternalCommand, ProjectPlan } from '../src/types.js';

class FrameworkRunner implements CommandRunner {
  calls: ExternalCommand[] = [];
  private defaultIntegration?: string;
  private installed: string[] = [];

  constructor(private readonly behavior: 'success' | 'fail' | 'outside' | 'git' | 'symlink' | 'empty' = 'success') {}

  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push(command);
    const cwd = options?.cwd;
    if (this.behavior === 'fail') {
      return commandResult(command, { status: 1, stderr: 'initializer failed' });
    }
    if (!cwd || this.behavior === 'empty') {
      return commandResult(command);
    }
    if (this.behavior === 'outside') {
      await writeFile(path.join(cwd, 'OUTSIDE.md'), 'forbidden\n');
      return commandResult(command);
    }
    if (this.behavior === 'git') {
      await mkdir(path.join(cwd, '.git'));
      return commandResult(command);
    }
    if (this.behavior === 'symlink') {
      await write(path.join(cwd, '.github', 'target.md'), 'target\n');
      await symlink(path.join(cwd, '.github', 'target.md'), path.join(cwd, '.github', 'linked.md'));
      return commandResult(command);
    }
    if (command.executable === 'openspec') {
      await this.writeOpenSpec(cwd, command);
    } else {
      await this.writeSpecKit(cwd, command);
    }
    return commandResult(command);
  }

  private async writeOpenSpec(cwd: string, command: ExternalCommand): Promise<void> {
    const tools = command.args[command.args.indexOf('--tools') + 1]?.split(',') ?? [];
    await write(path.join(cwd, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
    if (tools.includes('github-copilot')) {
      await write(path.join(cwd, '.github', 'skills', 'openspec-apply-change', 'SKILL.md'), 'copilot\n');
    }
    if (tools.includes('claude')) {
      await write(path.join(cwd, '.claude', 'skills', 'openspec-apply-change', 'SKILL.md'), 'claude\n');
    }
  }

  private async writeSpecKit(cwd: string, command: ExternalCommand): Promise<void> {
    if (command.args[0] === 'init') {
      this.defaultIntegration = command.args[command.args.indexOf('--integration') + 1];
      this.installed = [this.defaultIntegration];
      await write(path.join(cwd, '.specify', 'init-options.json'), '{}\n');
      await write(path.join(cwd, '.specify', 'templates', 'spec-template.md'), 'official spec\n');
      await write(path.join(cwd, '.specify', 'templates', 'plan-template.md'), 'official plan\n');
    } else {
      const integration = command.args[2];
      if (!this.installed.includes(integration)) {
        this.installed.push(integration);
      }
    }
    for (const integration of this.installed) {
      if (integration === 'copilot') {
        await write(path.join(cwd, '.github', 'skills', 'speckit-specify', 'SKILL.md'), 'copilot\n');
      } else if (integration === 'claude') {
        await write(path.join(cwd, '.claude', 'skills', 'speckit-specify', 'SKILL.md'), 'claude\n');
      }
    }
    await write(path.join(cwd, '.specify', 'integration.json'), `${JSON.stringify({
      integration_state_schema: 1,
      integration: this.defaultIntegration,
      default_integration: this.defaultIntegration,
      installed_integrations: this.installed,
      integration_settings: {}
    }, null, 2)}\n`);
  }
}

async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

function commandResult(command: ExternalCommand, values: Partial<CommandResult> = {}): CommandResult {
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

function plan(values: Partial<Parameters<typeof buildProjectPlan>[0]> = {}): ProjectPlan {
  return buildProjectPlan({
    projectName: 'Framework App',
    pattern: 'rag',
    cloud: 'azure',
    ...values
  }, { requireProjectName: true });
}

describe('official framework commands', () => {
  it('maps every selected agent into one pinned OpenSpec core initialization', () => {
    expect(buildOpenSpecInitCommand(plan({ agents: ['claude', 'copilot'] }))).toEqual({
      executable: 'openspec',
      args: ['init', '--tools', 'github-copilot,claude', '--profile', 'core']
    });
  });

  it('keeps the Spec Kit default primary and installs secondary Copilot in skills mode', () => {
    expect(buildSpecKitInitCommands(plan({
      specWorkflow: 'spec-kit',
      agents: ['copilot', 'claude'],
      defaultAgent: 'claude'
    }))).toEqual([
      {
        executable: 'specify',
        args: ['init', '--here', '--force', '--ignore-agent-tools', '--integration', 'claude']
      },
      {
        executable: 'specify',
        args: ['integration', 'install', 'copilot', '--force', '--integration-options=--skills']
      }
    ]);
  });
});

describe('framework adapter lifecycle', () => {
  it.each([
    ['openspec', ['copilot'], undefined],
    ['openspec', ['claude'], undefined],
    ['openspec', ['copilot', 'claude'], undefined],
    ['spec-kit', ['copilot'], 'copilot'],
    ['spec-kit', ['claude'], 'claude'],
    ['spec-kit', ['copilot', 'claude'], 'copilot'],
    ['spec-kit', ['copilot', 'claude'], 'claude']
  ] as const)('initializes and validates %s with agents %j and default %s', async (workflow, agents, defaultAgent) => {
    const selectedPlan = plan({
      specWorkflow: workflow,
      agents: [...agents],
      ...(defaultAgent ? { defaultAgent } : {})
    });
    const runner = new FrameworkRunner();
    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [{
        logicalName: 'readme',
        category: 'test',
        pathParts: ['README.md'],
        content: 'durable\n'
      }], 'liftoff');
      const initialized = await initializeFramework(area, selectedPlan, runner);
      const files = await validateStagedTree(area);

      expect(initialized.commands).toHaveLength(workflow === 'openspec' || agents.length === 1 ? 1 : 2);
      expect(files.filter((file) => file.origin === 'framework').length).toBeGreaterThan(0);
      expect(await validateFrameworkInstallation(area.root, {
        workflow,
        agents: selectedPlan.agents.map((agent) => agent.id),
        ...(selectedPlan.defaultAgent ? { defaultAgent: selectedPlan.defaultAgent.id } : {})
      })).toEqual([]);
    });
  });

  it.each([
    ['fail', /initializer failed/],
    ['outside', /outside its approved roots/],
    ['git', /forbidden \.git metadata/],
    ['symlink', /forbidden symlink/],
    ['empty', /did not produce the tested contract/]
  ] as const)('rejects %s framework output before destination writes', async (behavior, expected) => {
    await withStagingArea(async (area) => {
      await expect(initializeFramework(area, plan(), new FrameworkRunner(behavior))).rejects.toThrow(expected);
    });
  });
});

describe('framework ownership boundaries', () => {
  it('excludes official framework files and one-time overlays from Liftoff hashes', () => {
    const specKitArtifacts = buildArtifacts(plan({ specWorkflow: 'spec-kit', agents: ['copilot'] }));
    const partition = partitionGeneratedArtifacts(specKitArtifacts);
    const manifest = JSON.parse(partition.manifest.content) as {
      artifacts: Array<{ pathParts: string[] }>;
    };

    expect(partition.framework.map((item) => item.logicalName)).toEqual([
      'spec-kit-spec-template',
      'spec-kit-plan-template'
    ]);
    expect(partition.seed.map((item) => item.logicalName)).toEqual([
      'spec-kit-constitution',
      'specs-placeholder'
    ]);
    expect(manifest.artifacts.some((item) => item.pathParts[0] === '.specify')).toBe(false);
    expect(manifest.artifacts.some((item) => item.pathParts[0] === 'specs')).toBe(false);

    const openSpecPartition = partitionGeneratedArtifacts(buildArtifacts(plan()));
    const openSpecManifest = JSON.parse(openSpecPartition.manifest.content) as {
      artifacts: Array<{ pathParts: string[] }>;
    };
    expect(openSpecPartition.seed.map((item) => item.logicalName)).toContain('openspec-config');
    expect(openSpecManifest.artifacts.some((item) => item.pathParts[0] === 'openspec')).toBe(false);
  });

  it('validates durable artifacts plus official framework markers in a completed stage', async () => {
    const selectedPlan = plan({ agents: ['copilot', 'claude'] });
    const partition = partitionGeneratedArtifacts(buildArtifacts(selectedPlan));
    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, partition.durable, 'liftoff');
      await initializeFramework(area, selectedPlan, new FrameworkRunner());
      await writeStagedArtifacts(area, partition.seed, 'seed');
      await writeStagedArtifacts(area, [partition.manifest], 'liftoff');

      expect(await validateGeneratedProject(area.root)).toEqual([]);

      const marker = selectedPlan.framework.agentMarkers['github-copilot'][0];
      await writeFile(path.join(area.root, ...marker), 'framework upgraded this file\n');
      const reconciliation = await reconcileProject(
        await loadManifest(area.root),
        buildArtifacts(selectedPlan),
        area.root
      );
      expect(reconciliation.some((entry) => entry.pathParts.join('/') === marker.join('/'))).toBe(false);
    });
  });
});
