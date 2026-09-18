import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSavedTransitionPlan } from '../src/governance-activation/transition-planning.js';
import { executeApplyNext } from '../src/governance-activation/transitions.js';
import { executeGitHubPhase } from '../src/governance-activation/phase-github.js';
import {
  stagingQualificationInterfaceBlocker, greenRedQualificationInterfaceBlocker,
  readQualificationCheckpoints
} from '../src/application/azure-activation/producer-qualification.js';
import { environmentQualificationFixture } from './helpers/environment-qualification-fixture.js';

const fixtures: Awaited<ReturnType<typeof environmentQualificationFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

async function fixture() {
  const f = await environmentQualificationFixture();
  fixtures.push(f);
  return f;
}

describe('default environment planning, execution and retained-operation boundary', () => {
  it.each([
    ['dev-proof', /Development proof requires exactly its registered fields/],
    ['staging-qualified', /Staging execution requires exactly/],
    ['production-rehearsed', /Private application execution blocked \(rehearsal-budget\)/],
    ['green-red-proof', /Configured sourceSha is absent or invalid/]
  ] as const)('does not manufacture an approvable generic %s plan when the required producer inputs are absent', async (phaseId, blocker) => {
    const f = await fixture();
    await expect(buildSavedTransitionPlan({
      inspection: f.inspection, phaseId, runner: f.input.runner, adapters: f.input.adapters, now: f.now
    })).rejects.toThrow(blocker);
    expect(f.protocol.requests).toEqual([]);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it('rejects default apply/recovery at the real producer boundary without rewriting the actual private checkpoint or project state', async () => {
    const f = await fixture();
    f.protocol.pending = true;
    const dispatched = await f.dispatchRun();
    expect(dispatched.status).toBe('pending');
    f.inspection.state.phases['staging-qualified'].operation = dispatched.operation;
    f.inspection.state.phases['staging-qualified'].executionPlanDigest = dispatched.operation.planDigest;
    f.inspection.contexts['staging-qualified'].reviewedPlans = [f.input.plan];
    const checkpoint = await readQualificationCheckpoints(f.input, f.dispatch, f.workflow, f.dispatchInputs);
    const statePath = path.join(f.projectRoot, 'governance', 'activation-state.json');
    const before = await readFile(statePath);
    f.protocol.requests.length = 0;
    await expect(executeApplyNext({
      inspection: f.inspection, reinspect: async () => f.inspection, reviewedPlan: f.input.plan,
      runner: f.input.runner, adapters: f.input.adapters, storage: f.storage, now: f.now, recovery: true
    })).rejects.toThrow(/Staging execution requires exactly/);
    expect(await readQualificationCheckpoints(f.input, f.dispatch, f.workflow, f.dispatchInputs)).toEqual(checkpoint);
    expect(await readFile(statePath)).toEqual(before);
    expect(f.protocol.requests).toEqual([]);
    expect(f.protocol.armRequests).toEqual([]);
  });

  it('does not discard a real retained operation when the shared GitHub route handles the environment phase', async () => {
    const f = await fixture();
    f.protocol.pending = true;
    const dispatched = await f.dispatchRun();
    f.inspection.state.phases['staging-qualified'].operation = dispatched.operation;
    f.protocol.requests.length = 0;
    const outcome = await executeGitHubPhase(f.input);
    if (outcome !== null) {
      expect(outcome).toMatchObject({ status: 'blocked', operation: dispatched.operation, completedOperations: [] });
      expect(outcome).not.toHaveProperty('evidencePayload');
      expect(outcome).not.toHaveProperty('resultState');
    }
    expect(f.protocol.requests).toEqual([]);
    expect(f.protocol.armRequests).toEqual([]);
  });
});
