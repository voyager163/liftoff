import { afterEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectProjectUpdate } from '../src/application/update/inspection.js';
import { buildUpdateReport } from '../src/application/update/output.js';
import type { ProjectOptions } from '../src/domain/project/contracts.js';
import {
  cleanupUpdateTestRoots, createReviewedUpdateFixture, fingerprintUpdateTestProject
} from './reviewed-update-helpers.js';

afterEach(cleanupUpdateTestRoots);

async function project(options: ProjectOptions = {}) {
  return createReviewedUpdateFixture({
    projectName: 'Separate agent intent', projectType: 'standard', apiStack: 'node',
    agents: ['copilot'], ...options
  });
}

async function configure(root: string, changes: Record<string, unknown>) {
  const file = path.join(root, 'liftoff.config.json');
  const config = JSON.parse(await readFile(file, 'utf8'));
  const text = `${JSON.stringify({ ...config, ...changes }, null, 2)}\n`;
  await writeFile(file, text);
  return text;
}

describe('separate agent intent during metadata update', () => {
  it('does not block core inspection or install Codex when configuration requests an additive repair', async () => {
    const root = await project();
    const desired = await configure(root, { agents: ['copilot', 'codex'] });
    const before = await fingerprintUpdateTestProject(root);
    const inspection = await inspectProjectUpdate(root);
    expect(inspection.plan.agents.map((agent) => agent.id)).toEqual(['github-copilot', 'codex']);
    expect(inspection.renderPlan.agents.map((agent) => agent.id)).toEqual(['github-copilot']);
    expect(inspection.render.some((artifact) => artifact.logicalName === 'liftoff-setup-codex')).toBe(false);
    expect(inspection.deferredAgentRepair).toMatchObject({
      status: 'separate-repair-required', addAgents: ['codex'], changesDefault: false,
      executable: false, limitation: expect.stringContaining('not implemented')
    });
    expect(inspection.deferredAgentRepair).not.toHaveProperty('command');
    expect(await readFile(path.join(root, 'liftoff.config.json'), 'utf8')).toBe(desired);
    const report = buildUpdateReport({
      mode: 'check', status: 'partial', reasonCode: 'agent-repair-required', projectRoot: root
    }, inspection);
    expect(report.deferredAgentRepair?.requestedAgents).toEqual(['github-copilot', 'codex']);
    expect(report.deferredAgentRepair).toEqual(inspection.deferredAgentRepair);
    expect(JSON.stringify(report)).not.toContain('--add-agents');
    expect(report.projectBytesWritten).toBe(0);
    expect(await fingerprintUpdateTestProject(root)).toEqual(before);
  });

  it('preserves the recorded Spec Kit default during a separately requested default switch', async () => {
    const root = await project({ specWorkflow: 'spec-kit', agents: ['copilot', 'claude'], defaultAgent: 'copilot' });
    const desired = await configure(root, { defaultAgent: 'claude' });
    const before = await fingerprintUpdateTestProject(root);
    const inspection = await inspectProjectUpdate(root);
    expect(inspection.renderPlan.defaultAgent?.id).toBe('github-copilot');
    expect(inspection.deferredAgentRepair).toMatchObject({
      addAgents: [], recordedDefaultAgent: 'github-copilot', requestedDefaultAgent: 'claude', changesDefault: true,
      executable: false, limitation: expect.stringContaining('framework default changes are not implemented')
    });
    expect(inspection.deferredAgentRepair).not.toHaveProperty('command');
    expect(await readFile(path.join(root, 'liftoff.config.json'), 'utf8')).toBe(desired);
    expect(await fingerprintUpdateTestProject(root)).toEqual(before);
  });

  it('does not reinterpret agent removal as an additive repair', async () => {
    const root = await project({ agents: ['copilot', 'codex'] });
    await configure(root, { agents: ['codex'] });
    await expect(inspectProjectUpdate(root)).rejects.toThrow(/Removing a recorded agent/);
  });
});
