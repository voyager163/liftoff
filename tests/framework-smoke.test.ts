import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildOpenSpecInitCommand,
  initializeFramework
} from '../src/framework-adapters.js';
import { captureTreeState, withStagingArea } from '../src/init-filesystem.js';
import {
  configureOpenSpecProfile,
  inspectOpenSpecProfile
} from '../src/openspec-profile.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { buildProjectPlan } from '../src/planner.js';

const smoke = process.env.LIFTOFF_FRAMEWORK_SMOKE === '1';

describe.skipIf(!smoke)('pinned framework integration smoke', () => {
  it.each([
    ['openspec', 'openspec', '1.11.0', undefined],
    ['spec-kit', 'specify', '1.0.1', 'claude']
  ] as const)('initializes %s in an isolated stage', async (workflow, executable, version, defaultAgent) => {
    const runner = new NodeCommandRunner();
    const configRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-openspec-smoke-'));
    const env = workflow === 'openspec'
      ? {
          XDG_CONFIG_HOME: configRoot,
          XDG_DATA_HOME: path.join(configRoot, 'data'),
          CODEX_HOME: path.join(configRoot, 'codex'),
          OPENSPEC_TELEMETRY: '0',
          OPENSPEC_NO_UPDATE_CHECK: '1'
        }
      : undefined;
    try {
      const versionResult = await runner.run(
        { executable, args: ['--version'] },
        { timeoutMs: 15_000, env }
      );
      expect(`${versionResult.stdout}\n${versionResult.stderr}`).toContain(version);
      if (workflow === 'openspec') {
        await expect(inspectOpenSpecProfile(executable, runner, { env })).resolves.toMatchObject({
          compatible: false,
          state: { profile: 'core', delivery: 'both', workflows: [] }
        });
        await configureOpenSpecProfile(executable, runner, { env });
      }

      const plan = buildProjectPlan({
        projectName: 'Framework Smoke',
        pattern: 'rag',
        cloud: 'azure',
        specWorkflow: workflow,
        agents: ['copilot', 'claude'],
        ...(defaultAgent ? { defaultAgent } : {})
      }, { requireProjectName: true });
      await withStagingArea(async (area) => {
        const initialized = await initializeFramework(area, plan, runner, { env });
        expect(initialized.changedPaths.length).toBeGreaterThan(0);
        if (workflow === 'openspec') {
          const before = await captureTreeState(area.root);
          const rerun = await runner.run(buildOpenSpecInitCommand(plan), {
            cwd: area.root,
            env,
            timeoutMs: 60_000
          });
          expect(rerun.status).toBe(0);
          expect(await captureTreeState(area.root)).toEqual(before);
        }
      });
    } finally {
      await rm(configRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
