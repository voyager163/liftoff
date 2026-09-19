import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { nodeUpdatePreviewFileSystem } from '../src/adapters/filesystem/update-previews.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { governanceNextActions } from '../src/application/repository-governance/continuation.js';
import { inspectGovernance } from '../src/application/repository-governance/inspection.js';
import { json, renderApplyNextHuman } from '../src/cli/governance/presentation.js';
import { approvalRequestForSavedPlan, canonicalApprovalEnvelopeHash } from '../src/domain/governance/activation/approvals.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { validateSavedTransitionPlan } from '../src/domain/governance/activation/validators.js';
import { writeGovernanceApprovalAuthority } from '../src/governance-activation/authority-records.js';
import { governanceCommand } from '../src/governance-activation/commands.js';
import { readPhaseReviews, storePhaseReview } from '../src/governance-activation/phase-reviews.js';
import { generatedSeedChangeName } from '../src/governance-activation/seed-lifecycle.js';
import { nextStateForOutcome, saveTransitionPlan, writeOutcomeTransaction } from '../src/governance-activation/transition-records.js';
import type { ApplyNextExecutionResult, PhaseAdapterOutcome } from '../src/governance-activation/transition-ports.js';
import * as transitions from '../src/governance-activation/transitions.js';
import type { CommandRunner } from '../src/process-runner.js';
import { renderCanonicalGovernancePolicy } from '../src/repository-governance.js';
import { PresentationSession } from '../src/terminal.js';
import { fixturePlan, writeBootstrapFixture } from './governance-activation-fixtures.js';
import { CaptureStream } from './helpers.js';
import { activationProducerFixture } from './helpers/activation-producer-fixture.js';

const fixtures: Awaited<ReturnType<typeof activationProducerFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

function presentation() {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  return {
    stdout, stderr,
    session: new PresentationSession({ stdout, stderr, color: false, layout: 'plain', columns: 120 })
  };
}

async function settledFixture() {
  const runner: CommandRunner = {
    async run(command) {
      if (command.executable !== 'git') throw new Error('This command boundary fixture permits only local Git observation.');
      return { status: 128, stdout: '', stderr: 'not a git repository', displayCommand: 'fixture Git observation' };
    }
  };
  const f = await activationProducerFixture('credential-ready', {}, runner);
  fixtures.push(f);
  await mkdir(path.join(f.projectRoot, '.liftoff', 'governance'), { recursive: true });
  await writeFile(path.join(f.projectRoot, '.liftoff', 'governance', 'policy.md'), renderCanonicalGovernancePolicy());
  await writeBootstrapFixture(f.projectRoot, generatedSeedChangeName(f.inspection.manifest).slice('bootstrap-'.length), false);
  await f.refreshInputs();
  const phase = f.inspection.graph.phases.find((entry) => entry.id === 'credential-ready')!;
  const plan = validateSavedTransitionPlan({
    ...fixturePlan(f.inspection.contexts[phase.id], f.inspection.state, f.now.toISOString(), {}, f.projectRoot),
    stateHash: f.inspection.loadedState!.contentHash
  });
  const envelope = {
    ...approvalRequestForSavedPlan(plan, phase, f.inspection.state),
    schemaVersion: 4 as const, id: plan.approval.envelopeId!, approver: 'fixture-owner',
    approvedAt: plan.createdAt, expiresAt: plan.expiresAt
  };
  expect(canonicalApprovalEnvelopeHash(envelope)).toBe(plan.approval.envelopeHash);
  const openFile = vi.fn(nodeUpdatePreviewFileSystem.openFile);
  const storage = { ...f.storage, fileSystem: { ...nodeUpdatePreviewFileSystem, openFile } };
  await writeGovernanceApprovalAuthority(f.projectRoot, canonicalSha256({ fixture: 'settled-stage' }), envelope, storage);
  await mkdir(path.join(f.projectRoot, 'governance', 'approvals'));
  await writeFile(path.join(f.projectRoot, 'governance', 'approvals', `${envelope.id}.json`), canonicalJson(envelope));
  f.inspection.approvals = [envelope];
  const savedPlan = await saveTransitionPlan(f.projectRoot, plan);
  const outcome: PhaseAdapterOutcome = {
    status: 'review-required',
    completedOperations: [],
    review: {
      schemaVersion: 1, kind: 'credential-enrollment', phaseId: phase.id, sourcePlanDigest: plan.planDigest,
      payload: { nextStage: 'challenge', fixture: 'Public stage result, not provider qualification.' }
    }
  };
  const nextState = nextStateForOutcome({
    inspection: f.inspection, phase, plan, resultState: 'pending', now: f.now,
    blocker: 'The stage is settled; review the exact next-stage inputs.'
  });
  const { review, written } = await withProjectMutationLock(f.projectRoot, async () => ({
    review: await storePhaseReview(f.inspection, plan, outcome, f.now, storage),
    written: await writeOutcomeTransaction({ projectRoot: f.projectRoot, plan, nextState })
  }));
  const reviewKey = canonicalSha256({ kind: 'liftoff-phase-review', phaseId: phase.id, sourcePlanDigest: plan.planDigest });
  const result: ApplyNextExecutionResult = {
    schemaVersion: 3, scope: 'activation', command: 'governance apply-next', projectRoot: f.projectRoot,
    execute: true, applied: false, authorized: true, reason: 'phase-review-required',
    message: 'The stage is settled; separately review the next exact plan. This phase is not complete.',
    selectedPhase: phase.id, executedPhase: phase.id, nextReadyPhase: null,
    approval: plan.approval,
    proposedMutations: { local: plan.mutationClasses.local, remote: plan.mutationClasses.remote, operations: plan.operations },
    savedPlan, noWrites: false, blockers: [], executedOperations: [plan.operations.at(-1)!],
    evidence: null, stateHash: written.stateHash, rollbackPlan: plan.rollbackPlan, cleanupWarnings: [],
    review, phaseComplete: false
  };
  openFile.mockClear();
  return { ...f, storage, openFile, reviewKey, review, nextState, plan, result };
}

describe('settled-stage public command boundary', () => {
  it.each(['status', 'plan', 'resume', 'verify'])('reads the retained review from the selected private store in %s', async (subcommand) => {
    const f = await settledFixture();
    const p = presentation();
    const before = await readFile(path.join(f.projectRoot, 'governance', 'activation-state.json'));
    const code = await governanceCommand(parseArgs(['governance', subcommand, '--json']), {
      cwd: f.projectRoot, presentation: p.session, runner: f.runner, storage: f.storage
    });
    const body = JSON.parse(p.stdout.text());
    expect(f.openFile.mock.calls.some(([file, access]) => access === 'read' && file.includes(f.reviewKey))).toBe(true);
    if (subcommand === 'verify') {
      expect(code, p.stdout.text() + p.stderr.text()).toBe(2);
      expect(body).toMatchObject({ consistent: true, complete: false });
    } else {
      expect(code, p.stdout.text() + p.stderr.text()).toBe(0);
      expect(body.reviews).toEqual([f.review]);
    }
    expect(await readFile(path.join(f.projectRoot, 'governance', 'activation-state.json'))).toEqual(before);
    expect(body.nextActions[0].command.args).toContain(f.projectRoot);
    const otherHome = path.join(f.root, 'other-private-home');
    await mkdir(otherHome, { mode: 0o700 });
    expect(await readPhaseReviews(f.projectRoot, f.nextState, [f.plan], { ...f.storage, homedir: otherHome })).toEqual([]);
  });

  it.each([true, false])('returns a non-error pending result for a settled stage (new execution: %s)', async (executed) => {
    const f = await settledFixture();
    const result = executed ? f.result : {
      ...f.result, authorized: false, executedPhase: null, executedOperations: [], savedPlan: null, noWrites: true
    };
    const execute = vi.spyOn(transitions, 'executeApplyNext').mockResolvedValue(result);
    const p = presentation();
    const code = await governanceCommand(parseArgs(['governance', 'apply-next', '--execute', '--json']), {
      cwd: f.projectRoot, presentation: p.session, runner: f.runner, storage: f.storage
    });
    expect(code, p.stdout.text() + p.stderr.text()).toBe(0);
    expect(execute).toHaveBeenCalledOnce();
    expect(JSON.parse(p.stdout.text())).toMatchObject({
      reason: 'phase-review-required', phaseComplete: false, applied: false, evidence: null,
      review: f.review, noWrites: !executed, executedOperations: result.executedOperations
    });
    expect(f.openFile.mock.calls.filter(([file, access]) => access === 'read' && file.includes(f.reviewKey)).length).toBeGreaterThanOrEqual(2);
  });

  it('retains settled effects and reports indeterminate readiness if the post-stage private read fails', async () => {
    const f = await settledFixture();
    vi.spyOn(transitions, 'executeApplyNext').mockImplementation(async () => {
      f.openFile.mockImplementation(async (file, access, mode) => {
        if (access === 'read' && file.includes(f.reviewKey)) throw new Error('The protected review became unreadable.');
        return nodeUpdatePreviewFileSystem.openFile(file, access, mode);
      });
      return f.result;
    });
    const p = presentation();
    const code = await governanceCommand(parseArgs(['governance', 'apply-next', '--execute', '--json']), {
      cwd: f.projectRoot, presentation: p.session, runner: f.runner, storage: f.storage
    });
    expect(code).toBe(2);
    expect(JSON.parse(p.stdout.text())).toMatchObject({
      readinessStatus: 'indeterminate', progress: null, nextReadyPhase: null,
      executedOperations: f.result.executedOperations, review: f.review, phaseComplete: false
    });
  });

  it('does not issue approval or execution continuations for an already-settled exact plan', async () => {
    const f = await settledFixture();
    const inspection = await inspectGovernance(f.projectRoot, f.runner, f.now, { storage: f.storage });
    for (const approvalRequired of [true, false]) {
      const plan = { ...f.plan, approval: { ...f.plan.approval,
        evaluation: { ...f.plan.approval.evaluation, approvalRequired } } };
      const actions = governanceNextActions(inspection, { fingerprint: canonicalSha256(plan), plan });
      expect(actions).toHaveLength(1);
      expect(actions[0]!.command.args).toContain('plan');
      expect(actions[0]!.command.args).not.toContain('--plan');
      expect(actions[0]!.command.args).not.toContain('--execute');
      expect(actions[0]!.continuation.requiredAuthority).toEqual([]);
    }
  });

  it.each([true, false])('renders settled stages as pending, never as completed phases (authorized: %s)', async (authorized) => {
    const f = await settledFixture();
    const p = presentation();
    const status = vi.spyOn(p.session, 'status');
    renderApplyNextHuman({ ...f.result, authorized }, p.session);
    expect(status).toHaveBeenCalledWith('pending', 'phase-review-required', f.result.message);
    expect(status.mock.calls.some(([, label]) => label === 'Next phase')).toBe(false);
    expect(p.stdout.text()).toContain('Phase incomplete');
    expect(p.stdout.text()).toContain('credential-enrollment');
    expect(p.stdout.text()).toContain('prior-stage approval does not authorize it');
  });

  it.each(['human', 'json'])('withholds credential-shaped review data before any %s output', async (format) => {
    const f = await settledFixture();
    const p = presentation();
    const result = { ...f.result, review: { ...f.review, payload: { credential: `ghp_${'a'.repeat(36)}` } } };
    expect(() => format === 'json' ? json(p.session, result) : renderApplyNextHuman(result, p.session)).toThrow(/withheld/);
    expect(p.stdout.text()).toBe('');
    expect(p.stderr.text()).toBe('');
  });
});
