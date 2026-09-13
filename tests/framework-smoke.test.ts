import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { initializeFramework } from '../src/framework-adapters.js';
import { frameworkIntegrationPaths } from '../src/framework-validation.js';
import { captureTreeState, writeStagedArtifacts, type StagingArea } from '../src/init-filesystem.js';
import {
  configureOpenSpecProfile,
  inspectOpenSpecProfile
} from '../src/openspec-profile.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { buildProjectPlan } from '../src/planner.js';
import type { CodingAgentId, SpecWorkflowId } from '../src/types.js';

const smoke = process.env.LIFTOFF_FRAMEWORK_SMOKE === '1';
const agentSubsets: CodingAgentId[][] = [
  ['github-copilot'], ['claude'], ['github-copilot', 'claude'], ['codex'],
  ['github-copilot', 'codex'], ['claude', 'codex'], ['github-copilot', 'claude', 'codex']
];
const cases = agentSubsets.flatMap((agents) => [
  { workflow: 'openspec' as SpecWorkflowId, executable: 'openspec', version: '1.11.0', agents, defaultAgent: undefined },
  ...agents.map((defaultAgent) => ({
    workflow: 'spec-kit' as SpecWorkflowId, executable: 'specify', version: '1.0.1', agents, defaultAgent
  }))
]);

describe.skipIf(!smoke)('pinned framework integration smoke', () => {
  it.each(cases)('initializes $workflow agents=$agents default=$defaultAgent without changing operator files', async ({
    workflow, executable, version, agents, defaultAgent
  }) => {
    const runner = new NodeCommandRunner();
    const root = await mkdtemp(path.join(process.cwd(), '.codex-framework-smoke-'));
    const configRoot = path.join(root, 'operator home');
    const stage = path.join(root, 'project with spaces');
    await mkdir(stage);
    await mkdir(configRoot);
    const env = {
      HOME: configRoot,
      USERPROFILE: configRoot,
      APPDATA: path.join(configRoot, 'appdata'),
      LOCALAPPDATA: path.join(configRoot, 'localappdata'),
      XDG_CONFIG_HOME: configRoot,
      XDG_DATA_HOME: path.join(configRoot, 'data'),
      XDG_CACHE_HOME: path.join(configRoot, 'cache'),
      CODEX_HOME: path.join(configRoot, 'codex'),
      OPENSPEC_TELEMETRY: '0',
      OPENSPEC_NO_UPDATE_CHECK: '1'
    };
    const quiet = new Writable({ write(_chunk, _encoding, done) { done(); } });
    try {
      for (const prompt of [
        path.join(configRoot, '.codex', 'prompts', 'opsx-propose.md'),
        path.join(env.CODEX_HOME, 'prompts', 'opsx-apply.md'),
        path.join(env.CODEX_HOME, 'config.toml'),
        path.join(env.CODEX_HOME, 'auth.json')
      ]) {
        await mkdir(path.dirname(prompt), { recursive: true });
        await writeFile(prompt, 'operator-owned sentinel, never copied or changed\n');
      }
      const versionResult = await runner.run(
        { executable, args: ['--version'] },
        { timeoutMs: 15_000, env }
      );
      expect(
        versionResult.status,
        `${executable}: ${versionResult.errorMessage ?? versionResult.stderr}`
      ).toBe(0);
      expect(`${versionResult.stdout}\n${versionResult.stderr}`).toContain(version);
      if (workflow === 'openspec') {
        await expect(inspectOpenSpecProfile(executable, runner, { env })).resolves.toMatchObject({
          compatible: false,
          state: { profile: 'core', delivery: 'both', workflows: [] }
        });
        await configureOpenSpecProfile(executable, runner, { env, stdout: quiet, stderr: quiet });
      }
      const operatorBefore = await captureTreeState(configRoot);

      const plan = buildProjectPlan({
        projectName: 'Framework Smoke',
        pattern: 'rag',
        cloud: 'azure',
        specWorkflow: workflow,
        agents,
        ...(defaultAgent ? { defaultAgent } : {})
      }, { requireProjectName: true });
      const area: StagingArea = { root: stage, origins: new Map(), frameworkAllowedRoots: new Set() };
      const neighboring = [
        { logicalName: 'custom-skill', pathParts: ['.agents', 'skills', 'my-custom-skill', 'SKILL.md'], content: '# Preserve custom skill\n' },
        { logicalName: 'custom-codex-config', pathParts: ['.codex', 'config.toml'], content: '# Preserve project preferences\nsandbox_mode = "read-only"\n' }
      ];
      await writeStagedArtifacts(area, neighboring.map((artifact) => ({
        ...artifact, category: 'fixture', lifecycle: 'seed'
      })), 'seed');
      const initialized = await initializeFramework(area, plan, runner, { env, stdout: quiet, stderr: quiet });
      expect(initialized.changedPaths.length).toBeGreaterThan(0);
      for (const agent of plan.agents) {
        for (const parts of frameworkIntegrationPaths(workflow, agent.id)) {
          expect((await readFile(path.join(area.root, ...parts), 'utf8')).length).toBeGreaterThan(0);
        }
      }
      if (agents.includes('codex')) {
        expect(frameworkIntegrationPaths(workflow, 'codex')).toHaveLength(workflow === 'openspec' ? 12 : 10);
      }
      if (workflow === 'openspec') {
        const before = await captureTreeState(area.root);
        await initializeFramework(area, plan, runner, { env, stdout: quiet, stderr: quiet });
        expect(await captureTreeState(area.root)).toEqual(before);
      }
      for (const artifact of neighboring) {
        expect(await readFile(path.join(area.root, ...artifact.pathParts), 'utf8')).toBe(artifact.content);
        expect(initialized.changedPaths).not.toContain(artifact.pathParts.join('/'));
      }
      expect(await captureTreeState(configRoot)).toEqual(operatorBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
