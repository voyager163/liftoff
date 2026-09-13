import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeFrameworkCommands, initializeFramework } from '../src/framework-adapters.js';
import {
  frameworkIntegrationPaths,
  frameworkMarkerIssue,
  frameworkSelectionFromPlan,
  OPEN_SPEC_CODEX_TARGET_PATH,
  validateFrameworkInstallation
} from '../src/framework-validation.js';
import { captureTreeState, writeStagedArtifacts, type StagingArea } from '../src/init-filesystem.js';
import { OPEN_SPEC_WORKFLOW_IDS } from '../src/openspec-profile.js';
import { buildProjectPlan } from '../src/planner.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand, ProjectPlan, SpecWorkflowId } from '../src/types.js';

function project(specWorkflow: SpecWorkflowId = 'openspec') {
  return buildProjectPlan({
    projectName: 'Native Safety',
    projectType: 'standard',
    apiStack: 'node',
    cloud: 'azure',
    agents: ['codex'],
    governanceProfile: 'none',
    specWorkflow
  }, { requireProjectName: true });
}

async function write(root: string, parts: readonly string[], content = 'fixture\n') {
  const file = path.join(root, ...parts);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function withWorkspace(operation: (area: StagingArea, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(process.cwd(), '.codex-framework-test-'));
  const stage = path.join(root, 'stage with spaces');
  await mkdir(stage);
  try {
    await operation({ root: stage, origins: new Map(), frameworkAllowedRoots: new Set() }, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

class NativeRunner implements CommandRunner {
  calls: Array<{ command: ExternalCommand; options: RunCommandOptions }> = [];

  constructor(
    private readonly plan: ProjectPlan,
    private readonly afterWrite?: (cwd: string, env: NodeJS.ProcessEnv) => Promise<void>,
    private readonly failure = false
  ) {}

  async run(command: ExternalCommand, options: RunCommandOptions = {}): Promise<CommandResult> {
    this.calls.push({ command, options });
    const cwd = options.cwd!;
    for (const marker of this.plan.framework.baseMarkers) await write(cwd, marker);
    for (const agent of this.plan.agents) {
      for (const marker of frameworkIntegrationPaths(this.plan.specWorkflow.id, agent.id)) {
        await write(cwd, marker);
      }
    }
    if (this.plan.specWorkflow.id === 'spec-kit') {
      await write(cwd, ['.specify', 'integration.json'], JSON.stringify({
        integration_state_schema: 1,
        integration: this.plan.defaultAgent!.integrationIds['spec-kit'],
        default_integration: this.plan.defaultAgent!.integrationIds['spec-kit'],
        installed_integrations: this.plan.agents.map((agent) => agent.integrationIds['spec-kit']),
        integration_settings: {}
      }));
    } else if (this.plan.agents.some((agent) => agent.id === 'codex')) {
      await write(cwd, OPEN_SPEC_CODEX_TARGET_PATH, 'codex\n');
    }
    await this.afterWrite?.(cwd, options.env!);
    return {
      command,
      displayCommand: [command.executable, ...command.args].join(' '),
      status: this.failure ? 1 : 0,
      signal: null,
      stdout: '',
      stderr: this.failure ? 'fixture initializer failed' : '',
      timedOut: false
    };
  }
}

describe('Codex framework execution isolation', () => {
  it('rejects global configuration and arbitrary commands before any execution', async () => {
    await withWorkspace(async (area) => {
      const runner = new NativeRunner(project());
      for (const command of [
        { executable: 'openspec', args: ['config', 'set', 'delivery', 'commands'] },
        { executable: 'node', args: ['--version'] },
        { executable: 'openspec', args: ['init', '--tools', 'codex', '--profile', 'custom', '--store', 'other'] }
      ]) {
        await expect(executeFrameworkCommands(area, project(), [command], runner)).rejects.toThrow(/registered official operation/);
      }
      expect(runner.calls).toEqual([]);
      expect((await captureTreeState(area.root)).size).toBe(0);
    });
  });

  it.each(['openspec', 'spec-kit'] as const)('preserves user configuration while running %s', async (workflow) => {
    await withWorkspace(async (area, root) => {
      const userHome = path.join(root, 'operator home');
      const codexHome = path.join(root, 'operator codex');
      const configHome = path.join(root, 'operator config');
      await write(userHome, ['.codex', 'prompts', 'opsx-propose.md'], 'legacy user prompt\n');
      await write(userHome, ['account-settings.json'], '{"fixture":"private preference"}\n');
      await write(codexHome, ['auth.json'], '{"fixture":"not a credential"}\n');
      await write(codexHome, ['prompts', 'opsx-apply.md'], 'keep this prompt\n');
      await write(configHome, ['openspec', 'config.json'], JSON.stringify({
        profile: 'custom', delivery: 'both', workflows: OPEN_SPEC_WORKFLOW_IDS,
        privatePreference: 'not copied'
      }));
      const before = await Promise.all([userHome, codexHome, configHome].map(captureTreeState));
      const parentHome = process.env.HOME;
      const plan = project(workflow);
      const runner = new NativeRunner(plan, async (_cwd, env) => {
        for (const key of [
          'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
          'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CODEX_HOME',
          'CLAUDE_CONFIG_DIR', 'TMPDIR', 'TMP', 'TEMP'
        ]) {
          const relative = path.relative(root, env[key]!);
          expect(path.isAbsolute(relative) || relative.startsWith('..')).toBe(false);
          expect([userHome, codexHome, configHome]).not.toContain(env[key]);
        }
        expect(env.codex_home).toBe(env.CODEX_HOME);
        expect(env.OPENSPEC_TELEMETRY).toBe('0');
        expect(env.OPENSPEC_NO_UPDATE_CHECK).toBe('1');
        await expect(readFile(path.join(env.CODEX_HOME!, 'auth.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(path.join(env.HOME!, 'account-settings.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        if (workflow === 'openspec') {
          expect(JSON.parse(await readFile(path.join(env.XDG_CONFIG_HOME!, 'openspec', 'config.json'), 'utf8'))).toEqual({
            profile: 'custom', delivery: 'both', workflows: OPEN_SPEC_WORKFLOW_IDS
          });
        }
        await write(env.CODEX_HOME!, ['prompts', 'opsx-apply.md'], 'isolated legacy cleanup\n');
        await rm(path.join(env.CODEX_HOME!, 'prompts', 'opsx-apply.md'));
        await write(env.HOME!, ['account-settings.json'], 'isolated changes only\n');
      });
      await initializeFramework(area, plan, runner, { env: {
        HOME: userHome, USERPROFILE: userHome, CODEX_HOME: codexHome,
        codex_home: codexHome, XDG_CONFIG_HOME: configHome
      } });
      expect(await Promise.all([userHome, codexHome, configHome].map(captureTreeState))).toEqual(before);
      expect(process.env.HOME).toBe(parentHome);
      await expect(lstat(runner.calls[0].options.env!.HOME!)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('removes only its isolated execution home after a failed initializer', async () => {
    await withWorkspace(async (area, root) => {
      const source = path.join(root, 'operator');
      await write(source, ['keep.md']);
      const before = await captureTreeState(source);
      const runner = new NativeRunner(project(), undefined, true);
      await expect(initializeFramework(area, project(), runner, { env: { HOME: source, CODEX_HOME: source } }))
        .rejects.toThrow(/initializer failed/);
      await expect(lstat(runner.calls[0].options.env!.HOME!)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await captureTreeState(source)).toEqual(before);
    });
  });
});

describe('explicit native output inventories', () => {
  it.each(['openspec', 'spec-kit'] as const)('preserves custom neighboring skills and project Codex config for %s', async (workflow) => {
    await withWorkspace(async (area) => {
      const custom = [
        { logicalName: 'custom-skill', pathParts: ['.agents', 'skills', 'custom-review', 'SKILL.md'], content: '# Custom review\n' },
        { logicalName: 'codex-preferences', pathParts: ['.codex', 'config.toml'], content: '# Keep my choices\nsandbox_mode = "read-only"\n' },
        { logicalName: 'liftoff-setup-codex', pathParts: ['.agents', 'skills', 'liftoff-setup', 'SKILL.md'], content: '# Separate Liftoff ownership\n' }
      ];
      await writeStagedArtifacts(area, custom.map((artifact) => ({
        ...artifact, category: 'fixture', lifecycle: 'seed'
      })), 'seed');
      const plan = project(workflow);
      const result = await initializeFramework(area, plan, new NativeRunner(plan));
      for (const artifact of custom) {
        expect(await readFile(path.join(area.root, ...artifact.pathParts), 'utf8')).toBe(artifact.content);
        expect(result.changedPaths).not.toContain(artifact.pathParts.join('/'));
        expect(area.origins.get(artifact.pathParts.join('/'))).toBe('seed');
      }
      expect(await validateFrameworkInstallation(area.root, frameworkSelectionFromPlan(plan))).toEqual([]);
    });
  });

  it.each(['write', 'delete'] as const)('rejects %s of an unlisted neighboring skill', async (effect) => {
    await withWorkspace(async (area) => {
      const custom = ['.agents', 'skills', 'custom-review', 'SKILL.md'];
      await writeStagedArtifacts(area, [{
        logicalName: 'custom', category: 'fixture', lifecycle: 'seed',
        pathParts: custom, content: 'preserve\n'
      }], 'seed');
      const runner = new NativeRunner(project(), async (cwd) => {
        if (effect === 'write') await write(cwd, custom, 'unapproved\n');
        else await rm(path.join(cwd, ...custom));
      });
      await expect(initializeFramework(area, project(), runner)).rejects.toThrow(/explicit native inventory/);
      expect(area.origins.get(custom.join('/'))).toBe('seed');
    });
  });

  it.each([
    ['openspec', ['.agents', 'settings.json']],
    ['openspec', ['.codex', 'prompts', 'opsx-propose.md']],
    ['spec-kit', ['.codex', 'auth.json']],
    ['spec-kit', ['.agents', 'skills', 'unregistered', 'SKILL.md']]
  ] as const)('rejects unlisted %s native output at %j', async (workflow, parts) => {
    await withWorkspace(async (area) => {
      const plan = project(workflow);
      await expect(initializeFramework(area, plan, new NativeRunner(plan, async (cwd) => write(cwd, parts))))
        .rejects.toThrow(/explicit native inventory/);
    });
  });

  it('accepts only the optional exact Spec Kit project configuration path', async () => {
    await withWorkspace(async (area) => {
      const plan = project('spec-kit');
      const result = await initializeFramework(area, plan, new NativeRunner(plan, async (cwd) => {
        await write(cwd, ['.codex', 'config.toml'], '# Specify event configuration\n');
      }));
      expect(result.changedPaths).toContain(['.codex', 'config.toml'].join('/'));
    });
  });

  it('does not grant the shared skills root to an unselected agent', async () => {
    await withWorkspace(async (area) => {
      const plan = buildProjectPlan({
        projectName: 'Claude only', projectType: 'standard', apiStack: 'node',
        cloud: 'azure', agents: ['claude'], governanceProfile: 'none'
      }, { requireProjectName: true });
      await expect(initializeFramework(area, plan, new NativeRunner(plan, async (cwd) => {
        await write(cwd, ['.agents', 'skills', 'openspec-propose', 'SKILL.md']);
      }))).rejects.toThrow(/explicit native inventory/);
    });
  });

  it('rejects linked native roots before executing a framework command', async () => {
    await withWorkspace(async (area, root) => {
      const outside = path.join(root, 'outside');
      await mkdir(outside);
      await symlink(outside, path.join(area.root, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
      const runner = new NativeRunner(project());
      await expect(initializeFramework(area, project(), runner)).rejects.toThrow(/forbidden symlink/);
      expect(runner.calls).toEqual([]);
      expect((await captureTreeState(outside)).size).toBe(0);
    });
  });

  it.each(['before', 'after'] as const)('rejects a native case alias %s framework execution', async (when) => {
    await withWorkspace(async (area) => {
      const collision = ['.agents', 'SKILLS', 'openspec-propose', 'SKILL.md'];
      if (when === 'before') await write(area.root, collision);
      const runner = new NativeRunner(project(), when === 'after'
        ? async (cwd) => {
          const directory = path.join(cwd, '.agents', 'skills', 'openspec-propose');
          await rename(path.join(directory, 'SKILL.md'), path.join(directory, 'skill.md'));
        }
        : undefined);
      await expect(initializeFramework(area, project(), runner)).rejects.toThrow(/case collision/);
      if (when === 'before') expect(runner.calls).toEqual([]);
    });
  });

  it.each(['openspec', 'spec-kit'] as const)('requires every selected native %s workflow, not just a representative marker', async (workflow) => {
    await withWorkspace(async (area) => {
      const plan = project(workflow);
      await initializeFramework(area, plan, new NativeRunner(plan));
      const markers = frameworkIntegrationPaths(workflow, 'codex');
      expect(markers).toHaveLength(workflow === 'openspec' ? 12 : 10);
      for (const marker of markers) {
        await rm(path.join(area.root, ...marker));
        expect(await validateFrameworkInstallation(area.root, frameworkSelectionFromPlan(plan)))
          .toContain(`Missing framework marker: ${marker.join('/')}`);
        await write(area.root, marker);
      }
    });
  });

  it('rejects empty skills and another OpenSpec shared target without requiring legacy prompts', async () => {
    await withWorkspace(async (area) => {
      const plan = project();
      await initializeFramework(area, plan, new NativeRunner(plan));
      const marker = frameworkIntegrationPaths('openspec', 'codex')[0];
      await write(area.root, marker, '');
      expect(await validateFrameworkInstallation(area.root, frameworkSelectionFromPlan(plan)))
        .toContain(`Framework marker is empty: ${marker.join('/')}`);
      await write(area.root, marker);
      await write(area.root, OPEN_SPEC_CODEX_TARGET_PATH, 'agents\n');
      expect(await validateFrameworkInstallation(area.root, frameworkSelectionFromPlan(plan)))
        .toContain('OpenSpec shared skills target does not identify the selected Codex integration.');
      await rm(path.join(area.root, ...OPEN_SPEC_CODEX_TARGET_PATH));
      expect(await validateFrameworkInstallation(area.root, frameworkSelectionFromPlan(plan))).toEqual([]);
    });
  });

  it('rejects conflicting Spec Kit default metadata', async () => {
    await withWorkspace(async (area) => {
      const plan = project('spec-kit');
      await initializeFramework(area, plan, new NativeRunner(plan));
      const statePath = path.join(area.root, '.specify', 'integration.json');
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      await writeFile(statePath, JSON.stringify({ ...state, integration: 'claude' }));
      expect(await validateFrameworkInstallation(area.root, frameworkSelectionFromPlan(plan)))
        .toContain('Spec Kit integration and default_integration disagree.');
    });
  });

  it('rejects linked ancestors during marker inspection without reading their targets', async () => {
    await withWorkspace(async (area, root) => {
      const linked = path.join(root, 'linked');
      await write(linked, ['skills', 'openspec-apply-change', 'SKILL.md']);
      await symlink(linked, path.join(area.root, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
      expect(await frameworkMarkerIssue(area.root, ['.agents', 'skills', 'openspec-apply-change', 'SKILL.md']))
        .toContain('forbidden symlink');
    });
  });
});
