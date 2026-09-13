import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import { inspectProjectUpdate } from '../src/application/update/inspection.js';
import { buildUpdateReport } from '../src/application/update/output.js';
import type { ProjectOptions } from '../src/domain/project/contracts.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function project(options: ProjectOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-update-agent-intent-'));
  roots.push(root);
  const plan = buildProjectPlan({
    projectName: 'Separate agent intent', projectType: 'standard', apiStack: 'node',
    agents: ['copilot'], ...options
  }, { requireProjectName: true });
  for (const artifact of buildArtifacts(plan)) {
    const target = path.join(root, ...artifact.pathParts);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, artifact.content);
  }
  return root;
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
    const inspection = await inspectProjectUpdate(root);
    expect(inspection.plan.agents.map((agent) => agent.id)).toEqual(['github-copilot', 'codex']);
    expect(inspection.renderPlan.agents.map((agent) => agent.id)).toEqual(['github-copilot']);
    expect(inspection.render.some((artifact) => artifact.logicalName === 'liftoff-setup-codex')).toBe(false);
    expect(inspection.deferredAgentRepair).toMatchObject({
      status: 'separate-repair-required', addAgents: ['codex'], changesDefault: false
    });
    expect(inspection.deferredAgentRepair?.command.args).toContain('--add-agents');
    expect(await readFile(path.join(root, 'liftoff.config.json'), 'utf8')).toBe(desired);
    const report = buildUpdateReport({
      mode: 'check', status: 'partial', reasonCode: 'agent-repair-required', projectRoot: root
    }, inspection);
    expect(report.deferredAgentRepair?.requestedAgents).toEqual(['github-copilot', 'codex']);
    expect(report.projectBytesWritten).toBe(0);
  });

  it('preserves the recorded Spec Kit default during a separately requested default switch', async () => {
    const root = await project({ specWorkflow: 'spec-kit', agents: ['copilot', 'claude'], defaultAgent: 'copilot' });
    await configure(root, { defaultAgent: 'claude' });
    const inspection = await inspectProjectUpdate(root);
    expect(inspection.renderPlan.defaultAgent?.id).toBe('github-copilot');
    expect(inspection.deferredAgentRepair).toMatchObject({
      addAgents: [], recordedDefaultAgent: 'github-copilot', requestedDefaultAgent: 'claude', changesDefault: true
    });
  });

  it('does not reinterpret agent removal as an additive repair', async () => {
    const root = await project({ agents: ['copilot', 'codex'] });
    await configure(root, { agents: ['codex'] });
    await expect(inspectProjectUpdate(root)).rejects.toThrow(/Removing a recorded agent/);
  });
});
