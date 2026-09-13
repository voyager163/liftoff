import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFixtureProject } from '../src/application/initialize/fixture.js';
import { inspectGovernanceTransition } from '../src/governance-activation/commands.js';
import { buildSavedTransitionPlan, executeApplyNext } from '../src/governance-activation/transitions.js';
import { approveGovernancePreview, loadGovernancePreview, saveGovernancePreview } from '../src/governance-activation/public-plans.js';
import { assertGovernanceApprovalIssued } from '../src/governance-activation/authority-records.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';
import { runCommand } from '../src/commands.js';
import { parseArgs } from '../src/args.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'liftoff-public-approval-home-'));
  roots.push(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('XDG_STATE_HOME', path.join(home, 'state'));
  vi.stubEnv('LOCALAPPDATA', path.join(home, 'local'));
  const root = await createFixtureProject({
    projectName: 'Public approval', projectType: 'standard', apiStack: 'node',
    specWorkflow: 'spec-kit', agents: ['codex'], defaultAgent: 'codex', environments: ['dev']
  });
  roots.push(path.dirname(root));
  const runner = new ReadyInitRunner();
  for (const phase of ['seed-valid', 'seed-verified', 'seed-archived']) {
    const inspect = () => inspectGovernanceTransition(root, { runner, scope: 'local' });
    const result = await executeApplyNext({ inspection: await inspect(), reinspect: inspect, runner });
    expect(result.applied, result.message).toBe(true);
    expect(result.executedPhase).toBe(phase);
  }
  return {
    root, runner,
    inspect: () => inspectGovernanceTransition(root, { runner, scope: 'activation' })
  };
}

describe('public exact governance approval', () => {
  it('previews a dependency-ready publication plan before approval and persists authority without executing it', async () => {
    const { root, runner, inspect } = await fixture();
    const inspection = await inspect();
    expect(inspection.readiness.nextPlannablePhase).toBe('committed');
    expect(inspection.readiness.nextReadyPhase).toBeNull();
    const stateBefore = await readFile(path.join(root, 'governance', 'activation-state.json'));
    const unapproved = await executeApplyNext({ inspection, reinspect: inspect, runner });
    expect(unapproved).toMatchObject({ applied: false, authorized: false, reason: 'approval-required', executedOperations: [] });
    expect(await readFile(path.join(root, 'governance', 'activation-state.json'))).toEqual(stateBefore);
    const saved = await saveGovernancePreview(inspection, { runner });
    expect(saved).not.toBeNull();
    expect(saved!.preview.plan.approval.evaluation.approvalRequired).toBe(true);
    expect(path.relative(root, saved!.path).startsWith('..')).toBe(true);
    expect(await readFile(path.join(root, 'governance', 'activation-state.json'))).toEqual(stateBefore);
    const approved = await approveGovernancePreview({
      projectRoot: root, fingerprint: saved!.preview.fingerprint, inspect, runner
    });
    await assertGovernanceApprovalIssued(root, approved.envelope);
    expect(await readFile(path.join(root, 'governance', 'activation-state.json'))).toEqual(stateBefore);
    expect(runner.calls.some((command) => command.executable === 'git' &&
      ['init', 'add', 'commit', 'push'].includes(command.args[0]))).toBe(false);
    const next = await buildSavedTransitionPlan({
      inspection: await inspect(), runner, createdAt: saved!.preview.plan.createdAt
    });
    expect(next?.planDigest).toBe(saved!.preview.plan.planDigest);
    expect(next?.approval.evaluation.approvalRequired).toBe(false);
  });

  it('rejects stale source and cross-project fingerprints before issuing an approval', async () => {
    const { root, runner, inspect } = await fixture();
    const saved = await saveGovernancePreview(await inspect(), { runner });
    expect(saved).not.toBeNull();
    const other = await mkdtemp(path.join(os.tmpdir(), 'liftoff-other-approval-'));
    roots.push(other);
    await expect(loadGovernancePreview(other, saved!.preview.fingerprint)).rejects.toThrow(/No matching/);
    await mkdir(path.join(root, 'backend', 'src'), { recursive: true });
    await writeFile(path.join(root, 'backend', 'src', 'changed.ts'), 'export const changed = true;\n');
    await expect(approveGovernancePreview({
      projectRoot: root, fingerprint: saved!.preview.fingerprint, inspect, runner
    })).rejects.toThrow(/changed after preview/);
  });

  it('exposes the public plan and approve commands with scoped actionable output', async () => {
    const { root, runner } = await fixture();
    const invoke = async (args: string[]) => {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const code = await runCommand(parseArgs(['governance', ...args, '--scope', 'activation', '--json']), {
        cwd: root, stdout, stderr, runner
      });
      expect(code, stdout.text() + stderr.text()).toBe(0);
      return JSON.parse(stdout.text());
    };
    const planned = await invoke(['plan']);
    expect(planned).toMatchObject({
      schemaVersion: 2, scope: 'activation', projectWrites: false,
      externalPreviewWritten: true, plan: { phaseId: 'committed' }
    });
    expect(planned.nextActions[0]).toMatchObject({ scope: 'activation', approvalRequired: true });
    const approved = await invoke(['approve', '--plan', planned.preview.fingerprint]);
    expect(approved).toMatchObject({ schemaVersion: 2, scope: 'activation', approved: true, executed: false });
    expect(approved.nextActions[0].command.args).toContain('apply-next');
    expect(approved.nextActions[0].approvalRequired).toBe(false);
    expect(runner.calls.some((command) => command.executable === 'git' &&
      ['init', 'add', 'commit', 'push'].includes(command.args[0]))).toBe(false);
  });
});
