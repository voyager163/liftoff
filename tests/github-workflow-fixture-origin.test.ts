import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalPhaseGraph } from '../src/domain/governance/activation/graph.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  approvalRequestForSavedPlan, canonicalApprovalEnvelopeHash, evaluateApprovalForTransitionPlan, transitionPlanForPhase
} from '../src/domain/governance/activation/approvals.js';
import { planDigestFor, rollbackPlanForPhase } from '../src/domain/governance/activation/operations.js';
import { validateApprovalEnvelope, validateSavedTransitionPlan } from '../src/domain/governance/activation/validators.js';
import type { TransitionOperation } from '../src/domain/governance/activation/types.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { GitHubActivationClient } from '../src/adapters/github/activation-rest.js';
import {
  readOriginalCheckFixtureCustody, readBoundWorkflowRun, qualifyRepositorySourceChecks, sourceCheckFixtureWorkflowBinding,
  type BoundRepositoryCheckFixture, type OriginalCheckFixturePlanReference, type ProtectedRefFamily
} from '../src/adapters/github/production-checks.js';
import { readWorkflowPublicationCheckpoints } from '../src/adapters/github/production-workflows.js';
import { executeRepositoryChecks, planRepositoryChecks } from '../src/application/repository-governance/producer-checks.js';
import { readWorkflowEffect } from '../src/application/repository-governance/workflow-checkpoints.js';
import { writeGovernanceApprovalAuthority } from '../src/governance-activation/authority-records.js';
import { workflowOperationFixture } from './helpers/workflow-operation-fixture.js';
import {
  WorkflowGitHubFixture, workflowFixtureNow, workflowFixturePath, workflowFixtureSource
} from './helpers/workflow-publication-fixture.js';

const fixtures: Awaited<ReturnType<typeof workflowOperationFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

async function originalFixture(
  family: ProtectedRefFamily = 'develop', target = 'develop', observeRuns = true
) {
  const protocol = new WorkflowGitHubFixture(workflowFixtureSource.replace('[develop]', `["${family}"]`));
  if (target !== 'develop' && target !== 'main') protocol.refs.set(target, protocol.baseSha);
  protocol.autoChecks = observeRuns;
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'repository-checks-qualified')!;
  const f = await workflowOperationFixture('repository-checks-qualified', async (inspection) => {
    const planned = await planRepositoryChecks({ inspection, phase, runner: protocol.runner, now: new Date(workflowFixtureNow) });
    if (planned.blockers?.length) throw new Error(planned.blockers.join(' '));
    return planned.operations;
  }, protocol.runner, {
    predecessorSourceSha: protocol.baseSha, configuration: {
      schemaVersion: 1, repository: { name: 'owner/repo' }, phases: {
        'repository-checks-qualified': {
          sourceSha: protocol.baseSha, workflowPaths: [workflowFixturePath], repositoryId: 42, actorId: 7,
          fixtures: [{ refFamily: family, targetBranch: target, baseSha: protocol.refs.get(target)!,
            positiveBranch: 'automation/original-positive', negativeBranch: 'automation/original-negative', commitTime: workflowFixtureNow }]
        }
      }
    }
  });
  fixtures.push(f);
  const operation = f.input.plan.operations[0]!;
  const outcome = await withProjectMutationLock(f.projectRoot, (lease) => executeRepositoryChecks({ ...f.input, lease }));
  expect(outcome.status).toBe(observeRuns ? 'completed' : 'pending');
  const reference: OriginalCheckFixturePlanReference = {
    phaseId: 'repository-checks-qualified', planDigest: f.input.plan.planDigest,
    savedPlanDigest: canonicalSha256(f.input.plan), operationDigest: canonicalSha256(operation)
  };
  const read = () => withProjectMutationLock(f.projectRoot, (lease) =>
    readOriginalCheckFixtureCustody({ execution: { ...f.input, lease }, operation, reference }));
  protocol.requests.length = 0;
  return { ...f, protocol, operation, reference, read };
}

async function fullReader(f: Awaited<ReturnType<typeof originalFixture>>, dispatchLabel = false) {
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === (dispatchLabel ? 'green-red-proof' : 'rulesets-applied'))!;
  const originalPlan = structuredClone(f.input.plan);
  const inspection = { ...f.input.inspection, scope: 'activation' as const, contexts: {
    ...f.input.inspection.contexts, 'repository-checks-qualified': {
      ...f.input.inspection.contexts['repository-checks-qualified'], reviewedPlans: [originalPlan]
    }
  } };
  const now = new Date('2026-09-15T00:20:00.000Z'), expiresAt = '2026-09-15T00:35:00.000Z';
  const context = inspection.contexts[phase.id];
  const operation: TransitionOperation = {
    phaseId: phase.id, adapter: 'github',
    actionId: dispatchLabel ? 'github.checks.green-red-proof' : 'github.ruleset.readback',
    mutationClass: dispatchLabel ? 'github-workflow-dispatch' : 'github-read',
    destination: f.operation.destination, remote: true, destructive: false,
    inputs: { originalFixturePlans: [structuredClone(f.reference)] },
    ...(dispatchLabel ? { effects: [{
      mutationClass: 'github-read' as const, destination: f.operation.destination, remote: true, destructive: false
    }] } : {})
  };
  const requested = transitionPlanForPhase(phase, inspection.state, context.transition, f.projectRoot, undefined, {
    operations: [operation], selectionScope: 'activation', fileChanges: [], recovery: false,
    configuration: inspection.activationInputs
  });
  const envelope = validateApprovalEnvelope({ ...requested, schemaVersion: 4, id: randomUUID(),
    approvedAt: now.toISOString(), expiresAt, approver: 'isolated-full-fixture-reader' });
  await writeGovernanceApprovalAuthority(f.projectRoot, canonicalSha256(requested), envelope, f.storage);
  inspection.approvals = [...inspection.approvals, envelope];
  const evaluation = evaluateApprovalForTransitionPlan(requested, [envelope], { now });
  const plan = validateSavedTransitionPlan({
    ...originalPlan, phaseId: phase.id, scope: 'activation', selectionScope: 'activation',
    createdAt: now.toISOString(), expiresAt, baselineDigest: context.baselineSha, inputDigest: context.inputDigest,
    transitionDigest: context.transition.transitionDigest, operations: [operation], mutationClasses: phase.allowedMutations,
    planDigest: planDigestFor({ phase, transitionDigest: context.transition.transitionDigest,
      operations: [operation], approvalPlanDigest: requested.planDigest }),
    approval: { gateKind: phase.approvalGate.kind, required: phase.approvalGate.required, evaluation,
      envelopeId: evaluation.envelopeId, envelopeHash: evaluation.envelopeHash },
    rollbackPlan: rollbackPlanForPhase(phase)
  });
  const execution = { ...f.input, inspection, phase, plan, now, clock: () => now };
  const read = () => withProjectMutationLock(f.projectRoot, (lease) =>
    readOriginalCheckFixtureCustody({ execution: { ...execution, lease }, operation, reference: f.reference }));
  return { execution, operation, read };
}

describe('original source-check fixture custody as data', () => {
  it('returns exact private provider PR/run identities without a repository receipt, current status or provider access', async () => {
    const f = await originalFixture();
    expect(f.input.inspection.evidence).toEqual([]);
    const custody = await f.read();
    expect(custody).toMatchObject({ reference: f.reference, repository: 'owner/repo', repositoryId: 42, actorId: 7,
      producerSourceSha: f.protocol.baseSha, fixtures: [
        { polarity: 'positive', pullRequestNumber: 1, runs: [{ identity: { operationId: '100', planDigest: f.input.plan.planDigest } }] },
        { polarity: 'negative', pullRequestNumber: 2, runs: [{ identity: { operationId: '101', planDigest: f.input.plan.planDigest } }] }
      ] });
    expect(custody).not.toHaveProperty('positiveChecks');
    expect(custody).not.toHaveProperty('qualifiedAt');
    for (const fixture of custody.fixtures) {
      expect(fixture.publicationStages.map((stage) => stage.step)).toEqual(['tree', 'commit', 'ref', 'pull-request']);
      expect(fixture.publicationStages.every((stage) => stage.planDigest === f.input.plan.planDigest &&
        stage.savedPlanDigest === canonicalSha256(f.input.plan) && stage.approvalEnvelopeHash === f.input.plan.approval.envelopeHash)).toBe(true);
      expect(fixture.runs[0]!.identity).not.toHaveProperty('status');
      expect(fixture.runs[0]!.identity).not.toHaveProperty('conclusion');
    }
    expect(f.protocol.requests).toEqual([]);
    const selected = custody.fixtures[1]!.runs[0]!;
    const checkpoint = await readWorkflowEffect({
      inspection: f.input.inspection, adapters: f.input.adapters
    }, f.operation, {
      repositoryId: 42, ref: `${selected.binding.ref}:${selected.binding.workflowId}`, purpose: 'check-fixture', step: 'dispatch'
    }, { binding: selected.binding, fixtureDigest: canonicalSha256(custody.fixtures[1]!.publication) });
    expect(checkpoint!.observed).toMatchObject({ providerId: '101', resourceId: '/repos/owner/repo/actions/runs/101' });
    expect(f.protocol.requests).toEqual([]);
    expect(await readBoundWorkflowRun(new GitHubActivationClient(f.protocol), selected.binding, selected.identity))
      .toMatchObject({ runId: 101, conclusion: 'failure', jobs: [{ checkRunId: 10100 }] });
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('admits original repository fixture custody under a fresh full-scope read approval without relabeling the original phase or clock', async () => {
    const f = await originalFixture();
    const reader = await fullReader(f);
    const current = canonicalSha256({ plan: reader.execution.plan, now: reader.execution.now.toISOString() });
    const custody = await reader.read();
    expect(custody.reference.phaseId).toBe('repository-checks-qualified');
    expect(reader.execution.inspection.scope).toBe('activation');
    expect(canonicalSha256({ plan: reader.execution.plan, now: reader.execution.now.toISOString() })).toBe(current);
    expect(Date.parse(f.input.plan.expiresAt)).toBeLessThan(reader.execution.now.getTime());
    expect(f.protocol.requests).toEqual([]);
  });

  it.each([
    ['release/**', 'release/maintenance/1.2.3'], ['hotfix/**', 'hotfix/security/1.2.3'],
    ['release/*', 'release/1.2.3'], ['hotfix/*', 'hotfix/1.2.3']
  ] as const)('retains literal %s scope and exact target %s without widening original proof', async (family, target) => {
    const f = await originalFixture(family, target);
    const custody = await f.read();
    expect(custody.fixtures.every((fixture) => fixture.refFamily === family && fixture.publication.targetBranch === target)).toBe(true);
    expect(custody.requiredChecks[0]!.refFamilies).toEqual([family]);
    expect(f.protocol.requests).toEqual([]);
  });

  it('does not let original custody promote an infrastructure failure during later actual source-check observation', async () => {
    const f = await originalFixture();
    const job = f.protocol.jobs.get(101)![0]!;
    job.steps[0].conclusion = 'failure';
    job.steps[2].conclusion = 'skipped';
    const custody = await (await fullReader(f)).read();
    expect(f.protocol.requests).toEqual([]);
    const client = new GitHubActivationClient(f.protocol);
    const bound: BoundRepositoryCheckFixture[] = [];
    for (const fixture of custody.fixtures) {
      const runs: BoundRepositoryCheckFixture['runs'][number][] = [];
      for (const run of fixture.runs) {
        const actual = await readBoundWorkflowRun(client, run.binding, run.identity);
        runs.push({ binding: run.binding, operation: { ...run.identity, status: actual.conclusion === 'success' ? 'completed' : 'failed' } });
      }
      bound.push({ publication: fixture.publication, polarity: fixture.polarity, refFamily: fixture.refFamily,
        pullRequestNumber: fixture.pullRequestNumber, runs });
    }
    await expect(qualifyRepositorySourceChecks({
      client, repository: custody.repository, requiredChecks: custody.requiredChecks, fixtures: bound
    })).rejects.toThrow(/exact real validation step/);
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it.each(['plan', 'saved-plan', 'operation', 'phase', 'approval', 'reader-reference'] as const)(
    'rejects missing or wrong original/current %s before provider access', async (change) => {
      const f = await originalFixture();
      const reader = await fullReader(f);
      if (change === 'plan') reader.execution.inspection.contexts['repository-checks-qualified'].reviewedPlans = [];
      if (change === 'saved-plan') f.reference.savedPlanDigest = 'f'.repeat(64);
      if (change === 'operation') f.reference.operationDigest = 'f'.repeat(64);
      if (change === 'phase') f.reference.phaseId = 'green-red-proof';
      if (change === 'approval') {
        const record = await createScopedUserLocalRecordStore(f.projectRoot, 'governance-approval', f.storage)
          .read(canonicalApprovalEnvelopeHash(f.envelope));
        await rm(record!.path);
      }
      if (change === 'reader-reference') reader.operation.inputs.originalFixturePlans = [];
      await expect(reader.read()).rejects.toThrow();
      expect(f.protocol.requests).toEqual([]);
    });

  it.each(['tree', 'commit', 'ref', 'pull-request'] as const)('requires actual original %s custody, not a public branch or PR assertion', async (step) => {
    const f = await originalFixture();
    const custody = await f.read();
    const publication = custody.fixtures[1]!.publication;
    const stages = await readWorkflowPublicationCheckpoints(f.input, f.operation, publication);
    const prepared = stages.find((entry) => entry.step === step)!.records!.prepared;
    const key = canonicalSha256({ intentDigest: prepared.intentDigest, attempt: prepared.attempt, stage: 'prepared' });
    const record = await createScopedUserLocalRecordStore(f.projectRoot, 'governance-operation', f.storage).read(key);
    await rm(record!.path);
    await expect(f.read()).rejects.toThrow(/private workflow checkpoint/);
    expect(f.protocol.requests).toEqual([]);
  });

  it('requires a privately observed run and never looks up a latest candidate to fill missing custody', async () => {
    const f = await originalFixture();
    const custody = await f.read();
    const fixture = custody.fixtures[1]!;
    const binding = sourceCheckFixtureWorkflowBinding(fixture.publication, custody.requiredChecks, 4);
    const checkpoints = await readWorkflowEffect(f.input, f.operation, {
      repositoryId: 42, ref: `${binding.ref}:4`, purpose: 'check-fixture', step: 'dispatch'
    }, { binding, fixtureDigest: canonicalSha256(fixture.publication) });
    const key = canonicalSha256({ intentDigest: checkpoints!.prepared.intentDigest, attempt: checkpoints!.prepared.attempt, stage: 'observed' });
    const record = await createScopedUserLocalRecordStore(f.projectRoot, 'governance-operation', f.storage).read(key);
    await rm(record!.path);
    await expect(f.read()).rejects.toThrow(/no observed private provider run identity/);
    expect(f.protocol.requests).toEqual([]);
  });

  it('cannot adopt an unobserved request even when a real-looking run exists at the provider', async () => {
    const f = await originalFixture('develop', 'develop', false);
    const pr = f.protocol.pullRequests.get(1)!;
    f.protocol.addRun(pr.head.ref, 'pull_request', undefined, pr);
    await expect(f.read()).rejects.toThrow(/no observed private provider run identity/);
    expect(f.protocol.requests).toEqual([]);
  });

  it('refuses a dispatch-labeled full-phase reader instead of bypassing the missing primary read action contract', async () => {
    const f = await originalFixture();
    await expect((await fullReader(f, true)).read()).rejects.toThrow(/registered primary GitHub-read action/);
    expect(f.protocol.requests).toEqual([]);
  });

  it('does not accept a repository qualification payload in place of the original plan reference', async () => {
    const f = await originalFixture();
    Object.assign(f.reference, { kind: 'repository-checks-qualified.v1', positiveChecks: [], controlledNegativeChecks: [] });
    await expect(f.read()).rejects.toThrow(/not a repository qualification receipt/);
    expect(f.protocol.requests).toEqual([]);
  });

  it('does not relabel retained fixture effects with a separately issued but unexecuted replacement approval', async () => {
    const f = await originalFixture();
    const requested = approvalRequestForSavedPlan(f.input.plan, f.input.phase, f.input.inspection.state);
    const replacementAt = new Date('2026-09-15T00:01:00.000Z');
    const replacement = validateApprovalEnvelope({ ...f.envelope, id: randomUUID(), approvedAt: replacementAt.toISOString() });
    await writeGovernanceApprovalAuthority(f.projectRoot, canonicalSha256(requested), replacement, f.storage);
    const evaluation = evaluateApprovalForTransitionPlan(requested, [replacement], { now: replacementAt });
    const unexecuted = validateSavedTransitionPlan({
      ...f.input.plan, approval: { ...f.input.plan.approval, evaluation,
        envelopeId: evaluation.envelopeId, envelopeHash: evaluation.envelopeHash }
    });
    f.reference.savedPlanDigest = canonicalSha256(unexecuted);
    const reader = await fullReader(f);
    reader.execution.inspection.contexts['repository-checks-qualified'].reviewedPlans = [f.input.plan, unexecuted];
    reader.execution.inspection.approvals = [...reader.execution.inspection.approvals, replacement];
    await expect(reader.read()).rejects.toThrow(/did not prepare any retained fixture effect/);
    expect(f.protocol.requests).toEqual([]);
  });
});
