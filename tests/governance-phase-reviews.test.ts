import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { privateActivationFixture } from './helpers/private-activation-fixture.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { readPhaseReviews, reviewMatchesPlan, storePhaseReview } from '../src/governance-activation/phase-reviews.js';
import { nextStateForOutcome, saveTransitionPlan, writeOutcomeTransaction } from '../src/governance-activation/transition-records.js';
import { assertPhaseOutputsBound } from '../src/domain/governance/activation/evidence.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import type { PhaseAdapterOutcome, PhaseReviewRequest } from '../src/governance-activation/transition-ports.js';
import type { TransitionOperation } from '../src/domain/governance/activation/types.js';

const fixtures: Awaited<ReturnType<typeof privateActivationFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

async function fixture() {
  const f = await privateActivationFixture('application-prerequisites-ready', {});
  fixtures.push(f);
  const operation: TransitionOperation = {
    phaseId: f.phase.id, actionId: 'azure.application-private.prepare', adapter: 'azure-opentofu',
    mutationClass: 'backend-state-write', remote: true, destructive: false,
    destination: { type: 'external', identity: 'https://fixture.blob.core.windows.net/state/app.tfstate' },
    inputs: { mode: 'isolated-review-boundary-fixture' }
  };
  const input = await f.execution({ operations: [operation] });
  await saveTransitionPlan(f.projectRoot, input.plan);
  const review: PhaseReviewRequest = {
    schemaVersion: 1, kind: 'application-private-plan', phaseId: f.phase.id,
    sourcePlanDigest: input.plan.planDigest,
    payload: { nextMode: 'apply', publicProjection: { scopedResources: ['declared-resource'], retainedPlanReference: 'opaque-review-reference' } }
  };
  const outcome: PhaseAdapterOutcome = { status: 'review-required', review, completedOperations: [operation] };
  return { ...f, input, review, outcome };
}

describe('settled stages require a new exact review, not fake phase completion', () => {
  it('persists the original private review and pending state without verified evidence, outputs or a fake running handle', async () => {
    const f = await fixture();
    const original = await readFile(path.join(f.projectRoot, 'governance', 'activation-state.json'));
    await withProjectMutationLock(f.projectRoot, async () => {
      expect(await storePhaseReview(f.inspection, f.input.plan, f.outcome, f.now, f.storage)).toEqual(f.review);
      const next = nextStateForOutcome({
        inspection: f.inspection, phase: f.phase, plan: f.input.plan, resultState: 'pending', now: f.now,
        blocker: 'Review the prepared next-stage plan.'
      });
      expect(next.phases[f.phase.id]).toMatchObject({ state: 'pending', evidence: [], executionPlanDigest: f.input.plan.planDigest });
      expect(next.phases[f.phase.id].operation).toBeUndefined();
      expect(next.phaseOutputs?.[f.phase.id]).toBeUndefined();
      expect(() => assertPhaseOutputsBound(next, [])).not.toThrow();
      await writeOutcomeTransaction({ projectRoot: f.projectRoot, plan: f.input.plan, nextState: next,
        expectedStateHash: f.inspection.loadedState!.contentHash });
      f.inspection.state = next;
    });
    expect(await readFile(path.join(f.projectRoot, 'governance', 'activation-state.json'))).not.toEqual(original);
    expect(await readPhaseReviews(f.projectRoot, f.inspection.state, [f.input.plan], f.storage)).toEqual([f.review]);
    expect(reviewMatchesPlan(f.review, f.input.plan, [f.input.plan])).toBe(true);
    expect(reviewMatchesPlan(f.review, { ...f.input.plan, inputDigest: canonicalSha256('new exact stage') }, [f.input.plan])).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it('requires the actual lease and original private issuance before recording any next-stage review', async () => {
    const f = await fixture();
    await expect(storePhaseReview(f.inspection, f.input.plan, f.outcome, f.now, f.storage)).rejects.toThrow(/actual project mutation lease/);
    await withProjectMutationLock(f.projectRoot, async () => {
      await expect(storePhaseReview({ ...f.inspection, approvals: [] }, f.input.plan, f.outcome, f.now, f.storage)).rejects.toThrow(/original privately issued/);
    });
  });

  it.each(['phase', 'plan', 'running', 'terminal', 'operation', 'secret'] as const)('rejects a %s mismatch rather than blessing or forgetting effects', async (fault) => {
    const f = await fixture();
    let outcome = f.outcome;
    if (fault === 'phase') outcome = { ...outcome, review: { ...f.review, phaseId: 'credential-ready' } };
    if (fault === 'plan') outcome = { ...outcome, review: { ...f.review, sourcePlanDigest: 'f'.repeat(64) } };
    if (fault === 'running') outcome = { ...outcome, operation: {
      provider: 'azure', actionId: 'azure.application-private.prepare', operationId: 'provider-request',
      resourceId: '/provider/resource', startedAt: f.now.toISOString(), observedAt: f.now.toISOString(), status: 'running'
    } };
    if (fault === 'terminal') outcome = { ...outcome, resultState: 'verified' };
    if (fault === 'operation') outcome = { ...outcome, completedOperations: [{ ...f.input.plan.operations[0]!, inputs: { different: true } }] };
    if (fault === 'secret') outcome = { ...outcome, review: { ...f.review, payload: { value: `github_pat_${'A'.repeat(80)}` } } };
    await withProjectMutationLock(f.projectRoot, async () => {
      await expect(storePhaseReview(f.inspection, f.input.plan, outcome, f.now, f.storage)).rejects.toThrow();
    });
    const key = canonicalSha256({ kind: 'liftoff-phase-review', phaseId: f.phase.id, sourcePlanDigest: f.input.plan.planDigest });
    expect(await createScopedUserLocalRecordStore(f.projectRoot, 'governance-operation', f.storage).read(key)).toBeNull();
  });

  it('refuses a copied review with no exact original plan instead of treating it as execution authority', async () => {
    const f = await fixture();
    await withProjectMutationLock(f.projectRoot, () => storePhaseReview(f.inspection, f.input.plan, f.outcome, f.now, f.storage));
    const state = nextStateForOutcome({ inspection: f.inspection, phase: f.phase, plan: f.input.plan, resultState: 'pending', now: f.now });
    await expect(readPhaseReviews(f.projectRoot, state, [], f.storage)).rejects.toThrow(/exact original saved plan/);
    expect(state.phases[f.phase.id].state).toBe('pending');
  });
});
