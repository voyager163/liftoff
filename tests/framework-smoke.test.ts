import { describe, expect, it } from 'vitest';
import { initializeFramework } from '../src/framework-adapters.js';
import { withStagingArea } from '../src/init-filesystem.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { buildProjectPlan } from '../src/planner.js';

const smoke = process.env.LIFTOFF_FRAMEWORK_SMOKE === '1';

describe.skipIf(!smoke)('pinned framework integration smoke', () => {
  it.each([
    ['openspec', 'openspec', '1.6.0', undefined],
    ['spec-kit', 'specify', '0.14.1', 'claude']
  ] as const)('initializes %s in an isolated stage', async (workflow, executable, version, defaultAgent) => {
    const runner = new NodeCommandRunner();
    const versionResult = await runner.run({ executable, args: ['--version'] }, { timeoutMs: 15_000 });
    expect(`${versionResult.stdout}\n${versionResult.stderr}`).toContain(version);

    const plan = buildProjectPlan({
      projectName: 'Framework Smoke',
      pattern: 'rag',
      cloud: 'azure',
      specWorkflow: workflow,
      agents: ['copilot', 'claude'],
      ...(defaultAgent ? { defaultAgent } : {})
    }, { requireProjectName: true });
    await withStagingArea(async (area) => {
      const initialized = await initializeFramework(area, plan, runner);
      expect(initialized.changedPaths.length).toBeGreaterThan(0);
    });
  }, 120_000);
});
