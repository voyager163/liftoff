import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  canonicalPhaseGraph, canonicalPhaseGraphHash, currentActivationIdentity
} from '../src/domain/governance/activation/graph.js';
import {
  evaluateApprovalForTransitionPlan, transitionPlanForPhase
} from '../src/domain/governance/activation/approvals.js';
import {
  validateApprovalEnvelope, validateSavedTransitionPlan
} from '../src/domain/governance/activation/validators.js';
import { planDigestFor, rollbackPlanForPhase } from '../src/domain/governance/activation/operations.js';
import {
  evidenceBodyDigest, evidenceHeaderDigest
} from '../src/domain/governance/activation/evidence.js';
import {
  evidenceHeaderFor, readbackProof, saveTransitionPlan
} from '../src/governance-activation/transition-records.js';
import { GitHubActivationClient, GitHubActivationError } from '../src/adapters/github/activation-rest.js';
import {
  deriveRequiredSourceChecks, controlledSourceCheckFixtures, type ProtectedRefFamily
} from '../src/adapters/github/workflow-check-recipes.js';
import {
  planWorkflowSourcePublication, readbackWorkflowContent, type WorkflowPublicationPlan
} from '../src/adapters/github/production-workflows.js';
import { treeWithFiles } from '../src/adapters/github/workflow-git-objects.js';
import type { BoundRepositoryCheckFixture, WorkflowRunBinding } from '../src/adapters/github/production-checks.js';
import {
  WorkflowGitHubFixture, workflowFixtureNow, workflowFixturePath
} from './helpers/workflow-publication-fixture.js';
import {
  environmentQualificationFixture
} from './helpers/environment-qualification-fixture.js';
import {
  fullActivationChecksAction,
  fullActivationChecksQualifyAction,
  greenRedProofPhaseId,
  greenRedProofEvidenceKind,
  fullActivationChecksExtensionContract,
  fullActivationChecksUnimplementedSeams,
  fullActivationCheckContextsFromQualification,
  verifyFullActivationPredecessors,
  planFullActivationChecks,
  executeFullActivationChecks,
  qualifyFullActivationChecks,
  revalidateFullActivationChecks,
  type BoundProductionPredecessors,
  type FullActivationCheckFixtureConfig,
  type FullActivationChecksEvidencePayload,
  type PredecessorVerifierCallback
} from '../src/application/azure-activation/full-activation-checks.js';
import type { PhaseAdapterExecutionInput, PhasePlanningInput } from '../src/governance-activation/transition-ports.js';
import type { PhaseEvidenceSource } from '../src/domain/governance/activation/evidence.js';
import type { PhaseEvidenceRecord, SavedTransitionPlan, TransitionOperation } from '../src/domain/governance/activation/types.js';
import { environmentQualificationScopeBlocker } from '../src/application/azure-activation/qualification-authority.js';

const fullActivationWorkflowSource = [
  'name: Repository source',
  'permissions:',
  '  contents: read',
  'on:',
  '  pull_request:',
  '    branches: ["develop", "main", "release/**", "hotfix/**"]',
  'jobs:',
  '  node-tests:',
  '    name: Node source validation',
  '    runs-on: ubuntu-24.04',
  '    timeout-minutes: 5',
  '    steps:',
  '      - name: Checkout',
  `        uses: actions/checkout@${'a'.repeat(40)}`,
  '      - name: Validate source',
  '        run: node --test',
  ''
].join('\n');

const artifactDigest = 'sha256:' + 'c'.repeat(64);

function createMockPredecessors(sourceSha: string): BoundProductionPredecessors {
  return {
    staging: {
      phaseId: 'staging-qualified',
      evidenceId: 'staging-evidence-001',
      headerDigest: '1'.repeat(64),
      bodyDigest: '2'.repeat(64),
      sourceSha,
      artifactDigest,
      verifiedAt: workflowFixtureNow
    },
    rehearsal: {
      phaseId: 'production-rehearsed',
      evidenceId: 'rehearsal-evidence-001',
      headerDigest: '3'.repeat(64),
      bodyDigest: '4'.repeat(64),
      sourceSha,
      artifactDigest,
      verifiedAt: workflowFixtureNow
    },
    sourceSha,
    artifactDigest
  };
}

async function buildFullActivationFixture(
  workflowSource = fullActivationWorkflowSource,
  targetFamilies: readonly { refFamily: ProtectedRefFamily; branch: string }[] = [
    { refFamily: 'develop', branch: 'develop' },
    { refFamily: 'main', branch: 'main' },
    { refFamily: 'release/**', branch: 'release/maintenance/1.2.3' },
    { refFamily: 'hotfix/**', branch: 'hotfix/security/1.2.4' }
  ]
) {
  const protocol = new WorkflowGitHubFixture(workflowSource);
  for (const t of targetFamilies) {
    if (!protocol.refs.has(t.branch)) protocol.refs.set(t.branch, protocol.baseSha);
  }
  const client = new GitHubActivationClient(protocol);
  const workflow = await readbackWorkflowContent(client, 'owner/repo', workflowFixturePath, protocol.baseSha);
  const requiredChecks = await deriveRequiredSourceChecks(client, 'owner/repo', workflow, 4);

  const fixtures: BoundRepositoryCheckFixture[] = [];
  const fixtureConfigs: FullActivationCheckFixtureConfig[] = [];
  const predecessors = createMockPredecessors(protocol.baseSha);

  for (const target of targetFamilies) {
    const baseSha = target.branch === 'main' ? protocol.mainSha : protocol.baseSha;
    const prefix = target.refFamily.replace('/**', '').replace('/*', '').replace('/', '-');
    const positiveBranch = `automation/${prefix}-positive`;
    const negativeBranch = `automation/${prefix}-negative`;
    fixtureConfigs.push({
      refFamily: target.refFamily,
      targetBranch: target.branch,
      baseSha,
      positiveBranch,
      negativeBranch,
      commitTime: workflowFixtureNow
    });

    for (const polarity of ['positive', 'negative'] as const) {
      const featureBranch = polarity === 'positive' ? positiveBranch : negativeBranch;
      const plan = await planWorkflowSourcePublication({
        client,
        repository: 'owner/repo',
        repositoryId: protocol.repositoryId,
        actorId: protocol.actorId,
        baseSha,
        targetBranch: target.branch,
        featureBranch,
        workflowFiles: controlledSourceCheckFixtures(requiredChecks, polarity),
        commitMessage: `Reviewed ${polarity} fixture for ${target.refFamily}`,
        commitTime: workflowFixtureNow,
        recipe: 'gitflow-source-check-fixture.v1'
      });

      const base = protocol.trees.get(plan.baseTreeSha)!;
      const next = treeWithFiles(base, plan.files);
      protocol.trees.set(next.sha, next.entries);
      for (const file of plan.files) protocol.blobs.set(file.blobSha, Buffer.from(file.content));
      protocol.commits.set(plan.commitSha, {
        sha: plan.commitSha,
        tree: { sha: next.sha },
        parents: [{ sha: baseSha }]
      });
      protocol.refs.set(plan.featureBranch, plan.commitSha);

      const prNumber = fixtures.length + 1;
      const pr = {
        number: prNumber,
        state: 'open',
        draft: true,
        merged: false,
        user: { id: protocol.actorId },
        head: { ref: plan.featureBranch, sha: plan.commitSha, repo: { id: protocol.repositoryId, full_name: 'owner/repo' } },
        base: { ref: plan.targetBranch, sha: baseSha, repo: { id: protocol.repositoryId, full_name: 'owner/repo' } }
      };
      protocol.pullRequests.set(prNumber, pr);

      const run = protocol.addRun(plan.featureBranch, 'pull_request', undefined, pr);
      const binding: WorkflowRunBinding = {
        repository: 'owner/repo',
        repositoryId: protocol.repositoryId,
        workflowPath: workflowFixturePath,
        workflowId: 4,
        workflowDigest: canonicalSha256(workflowSource),
        sourceSha: plan.commitSha,
        producerSourceSha: protocol.baseSha,
        ref: plan.featureBranch,
        actorId: protocol.actorId,
        event: 'pull_request',
        expectedJobs: ['Node source validation'],
        runAttempt: 1
      };

      fixtures.push({
        publication: plan,
        polarity,
        refFamily: target.refFamily,
        pullRequestNumber: prNumber,
        runs: [{
          binding,
          operation: {
            provider: 'github',
            actionId: fullActivationChecksAction,
            operationId: String(run.id),
            resourceId: `/repos/owner/repo/actions/runs/${run.id}`,
            startedAt: workflowFixtureNow,
            observedAt: workflowFixtureNow,
            status: polarity === 'positive' ? 'completed' : 'failed'
          }
        }]
      });
    }
  }

  return {
    protocol,
    client,
    requiredChecks,
    fixtures,
    fixtureConfigs,
    predecessors
  };
}

const envFixtures: Awaited<ReturnType<typeof environmentQualificationFixture>>[] = [];
afterEach(async () => {
  for (const fixture of envFixtures.splice(0)) await fixture.cleanup();
});

async function buildPredecessorsInspection() {
  const f = await environmentQualificationFixture({ phaseId: 'staging-qualified' });
  envFixtures.push(f);
  const { reference: stagingRef } = f.boundReceipt({
    kind: 'staging-qualified.v1',
    sourceSha: f.workflow.sourceSha,
    artifactDigest
  });

  const rehearsalPhase = canonicalPhaseGraph.phases.find((p) => p.id === 'production-rehearsed')!;
  const rehearsalContext = f.inspection.contexts['production-rehearsed'];
  const githubDest = { type: 'repository' as const, identity: f.workflow.repository, repository: f.workflow.repository };
  const azureDest = { type: 'subscription' as const, identity: f.target.target.resourceId, subscriptionId: f.target.target.subscriptionId };
  const dispatchOp: TransitionOperation = {
    phaseId: 'production-rehearsed', adapter: 'github', actionId: 'github.checks.production-rehearsal',
    mutationClass: 'github-workflow-dispatch', inputs: {}, destination: githubDest, remote: true, destructive: false,
    effects: [{ mutationClass: 'github-read', destination: githubDest, remote: true, destructive: false }]
  };
  const readbackOp: TransitionOperation = {
    phaseId: 'production-rehearsed', adapter: 'azure-opentofu', actionId: 'azure.production-readback',
    mutationClass: 'azure-read', inputs: {}, destination: azureDest, remote: true, destructive: false
  };
  const operations = [dispatchOp, readbackOp];

  const requested = transitionPlanForPhase(rehearsalPhase, f.inspection.state, rehearsalContext.transition, f.projectRoot, undefined, {
    operations, configuration: f.inspection.activationInputs, selectionScope: 'activation', fileChanges: [], recovery: false
  });
  const envelope = validateApprovalEnvelope({
    ...requested, schemaVersion: 4, id: randomUUID(), approvedAt: f.envelope.approvedAt,
    expiresAt: f.target.expiresAt, approver: f.target.actor.operator
  });
  const evaluation = evaluateApprovalForTransitionPlan(requested, [envelope], { now: f.now });
  const rehearsalPlan = validateSavedTransitionPlan({
    schemaVersion: 2, scope: 'activation', selectionScope: 'activation', phaseId: 'production-rehearsed',
    createdAt: f.input.plan.createdAt, expiresAt: f.target.expiresAt,
    identity: currentActivationIdentity, graphHash: canonicalPhaseGraphHash, stateHash: f.inspection.loadedState!.contentHash,
    baselineDigest: rehearsalContext.baselineSha, inputDigest: rehearsalContext.inputDigest, transitionDigest: rehearsalContext.transition.transitionDigest,
    planDigest: planDigestFor({ phase: rehearsalPhase, transitionDigest: rehearsalContext.transition.transitionDigest, operations, approvalPlanDigest: requested.planDigest }),
    mutationClasses: rehearsalPhase.allowedMutations, operations,
    approval: { gateKind: rehearsalPhase.approvalGate.kind, required: true, evaluation, envelopeId: evaluation.envelopeId, envelopeHash: evaluation.envelopeHash },
    rollbackPlan: rollbackPlanForPhase(rehearsalPhase), fileChanges: [], recovery: false, noSecrets: true,
    configuration: f.inspection.activationInputs
  });
  await saveTransitionPlan(f.projectRoot, rehearsalPlan);

  const rehearsalBody = {
    kind: 'production-rehearsed.v1',
    sourceSha: f.workflow.sourceSha,
    artifactDigest,
    planDigest: rehearsalPlan.planDigest,
    savedPlanDigest: canonicalSha256(rehearsalPlan)
  };
  const rehearsalExecutionInput: PhaseAdapterExecutionInput = {
    ...f.input,
    phase: rehearsalPhase,
    plan: rehearsalPlan
  };
  const liveReadback = [
    readbackProof(rehearsalExecutionInput, 'github', 'workflow-run', `/repos/${f.workflow.repository}/actions/runs/${f.protocol.runId}`, rehearsalBody),
    readbackProof(rehearsalExecutionInput, 'azure', 'containerApp', f.target.target.resourceId, rehearsalBody)
  ];
  const rehearsalHeader = evidenceHeaderFor({
    inspection: f.inspection, phase: rehearsalPhase, plan: rehearsalPlan, result: 'verified', now: f.now, payload: rehearsalBody, liveReadback
  });
  const rehearsalRecord: PhaseEvidenceRecord = { evidenceId: randomUUID(), header: rehearsalHeader, payload: rehearsalBody, liveReadback };
  const rehearsalRef = {
    evidenceId: rehearsalRecord.evidenceId,
    headerDigest: evidenceHeaderDigest(rehearsalHeader),
    bodyDigest: evidenceBodyDigest(rehearsalBody, liveReadback)
  };
  const stateReference = {
    evidenceId: rehearsalRecord.evidenceId, phaseId: 'production-rehearsed' as const,
    pathParts: ['governance', 'evidence', `${rehearsalRecord.evidenceId}.json`],
    headerDigest: rehearsalRef.headerDigest, producedAt: rehearsalHeader.producedAt, result: rehearsalHeader.result
  };

  f.inspection.evidence.push(rehearsalRecord);
  f.inspection.contexts['production-rehearsed'] = {
    ...rehearsalContext,
    reviewedPlans: [rehearsalPlan],
    evidenceReferences: [stateReference]
  };

  return {
    f,
    stagingRef,
    rehearsalRef,
    sourceSha: f.workflow.sourceSha,
    artifactDigest
  };
}

describe('full-activation controlled check component', () => {
  describe('exported APIs and contract metadata', () => {
    it('exports exact action IDs, phase ID, evidence kind and coordinator extension contract', () => {
      expect(fullActivationChecksAction).toBe('github.checks.green-red-proof');
      expect(fullActivationChecksQualifyAction).toBe('github.checks.qualify');
      expect(greenRedProofPhaseId).toBe('green-red-proof');
      expect(greenRedProofEvidenceKind).toBe('green-red-proof.v1');
      expect(fullActivationChecksExtensionContract).toMatchObject({
        phaseId: 'green-red-proof',
        scope: 'activation',
        actionId: 'github.checks.green-red-proof',
        plan: planFullActivationChecks,
        execute: executeFullActivationChecks,
        revalidate: revalidateFullActivationChecks,
        qualify: qualifyFullActivationChecks,
        verifyPredecessors: verifyFullActivationPredecessors,
        projectContexts: fullActivationCheckContextsFromQualification
      });
    });

    it('honestly states precise unimplemented dependent seams without claiming overall producer completeness', () => {
      expect(fullActivationChecksUnimplementedSeams.length).toBeGreaterThanOrEqual(2);
      expect(fullActivationChecksUnimplementedSeams[0]).toContain('stagingQualificationInterfaceBlocker');
      expect(fullActivationChecksUnimplementedSeams[1]).toContain('productionRehearsalInterfaceBlocker');
    });
  });

  describe('predecessor proof verification and scope distinction', () => {
    it('verifies activation-scoped staging and rehearsal predecessors and returns typed references', async () => {
      const { f, stagingRef, rehearsalRef, sourceSha, artifactDigest: digestVal } = await buildPredecessorsInspection();
      const result = verifyFullActivationPredecessors(f.inspection, {
        staging: stagingRef,
        rehearsal: rehearsalRef,
        sourceSha,
        artifactDigest: digestVal
      }, f.now);

      expect(result.sourceSha).toBe(sourceSha);
      expect(result.artifactDigest).toBe(digestVal);
      expect(result.staging.phaseId).toBe('staging-qualified');
      expect(result.rehearsal.phaseId).toBe('production-rehearsed');
      expect(result.staging.evidenceId).toBe(stagingRef.evidenceId);
      expect(result.rehearsal.evidenceId).toBe(rehearsalRef.evidenceId);
    });

    it('rejects repository-scoped receipts as production predecessor proof', () => {
      const sourceSha = 'a'.repeat(40);
      const mockInspection: PhaseEvidenceSource = {
        evidence: [{
          evidenceId: 'repo-001',
          header: {
            schemaVersion: 1,
            phaseId: 'staging-qualified',
            scope: 'repository',
            result: 'verified',
            producer: 'liftoff-governance-transition-engine',
            producedAt: workflowFixtureNow,
            baselineSha: sourceSha,
            inputDigest: '1'.repeat(64),
            bodyDigest: '2'.repeat(64),
            identity: { device: '1', inode: '1', birthtime: '1' }
          },
          payload: { sourceSha }
        }],
        contexts: {
          'staging-qualified': {
            evidenceReferences: ['1'.repeat(64)],
            reviewedPlans: [],
            remoteBindingDigest: 'r'.repeat(64)
          }
        }
      };

      expect(() => verifyFullActivationPredecessors(mockInspection, {
        staging: { evidenceId: 'repo-001', headerDigest: '1'.repeat(64), bodyDigest: '2'.repeat(64) },
        rehearsal: { evidenceId: 'repo-001', headerDigest: '1'.repeat(64), bodyDigest: '2'.repeat(64) },
        sourceSha
      })).toThrow();
    });
  });

  describe('concrete qualification of controlled positive and negative checks', () => {
    it('qualifies unmerged positive and deliberate negative fixtures across develop, main, release/**, hotfix/**', async () => {
      const f = await buildFullActivationFixture();
      const result = await qualifyFullActivationChecks({
        client: f.client,
        repository: 'owner/repo',
        requiredChecks: f.requiredChecks,
        fixtures: f.fixtures,
        predecessors: f.predecessors,
        now: new Date(workflowFixtureNow)
      });

      expect(result.repository).toBe('owner/repo');
      expect(result.sourceSha).toBe(f.protocol.baseSha);
      expect(result.positiveChecks.length).toBe(4);
      expect(result.controlledNegativeChecks.length).toBe(4);

      expect(result.positiveChecks.every((c) => c.conclusion === 'success')).toBe(true);
      expect(result.controlledNegativeChecks.every((c) => c.conclusion === 'failure' && c.deliberateFailure === true)).toBe(true);

      expect(result.green).toEqual({
        conclusion: 'success',
        checkName: 'Node source validation',
        checkRunId: expect.any(Number),
        verifiedAt: workflowFixtureNow
      });
      expect(result.deliberateRed).toEqual({
        conclusion: 'failure',
        deliberate: true,
        checkName: 'Node source validation',
        checkRunId: expect.any(Number),
        verifiedAt: workflowFixtureNow
      });

      const families = new Set(result.requiredContexts.map((c) => c.refFamily));
      expect(families.has('release/**')).toBe(true);
      expect(families.has('hotfix/**')).toBe(true);
    });

    it('rejects qualification when the unmerged PR has been merged', async () => {
      const f = await buildFullActivationFixture();
      f.protocol.merge(f.fixtures[0]!.pullRequestNumber);

      await expect(qualifyFullActivationChecks({
        client: f.client,
        repository: 'owner/repo',
        requiredChecks: f.requiredChecks,
        fixtures: f.fixtures,
        predecessors: f.predecessors,
        now: new Date(workflowFixtureNow)
      })).rejects.toThrow(/unmerged PR/);
    });

    it('rejects qualification when fixture PR is closed without merge', async () => {
      const f = await buildFullActivationFixture();
      const pr = f.protocol.pullRequests.get(f.fixtures[0]!.pullRequestNumber)!;
      pr.state = 'closed';

      await expect(qualifyFullActivationChecks({
        client: f.client,
        repository: 'owner/repo',
        requiredChecks: f.requiredChecks,
        fixtures: f.fixtures,
        predecessors: f.predecessors,
        now: new Date(workflowFixtureNow)
      })).rejects.toThrow(/unmerged PR/);
    });

    it('rejects qualification when literal release/** or hotfix/** ref-family coverage is missing', async () => {
      const singleLevelWorkflow = fullActivationWorkflowSource.replace(
        '["develop", "main", "release/**", "hotfix/**"]',
        '["develop", "main", "release/*", "hotfix/*"]'
      );
      const f = await buildFullActivationFixture(singleLevelWorkflow, [
        { refFamily: 'develop', branch: 'develop' },
        { refFamily: 'main', branch: 'main' },
        { refFamily: 'release/*', branch: 'release/1.0.0' },
        { refFamily: 'hotfix/*', branch: 'hotfix/1.0.1' }
      ]);

      await expect(qualifyFullActivationChecks({
        client: f.client,
        repository: 'owner/repo',
        requiredChecks: f.requiredChecks,
        fixtures: f.fixtures,
        predecessors: f.predecessors,
        now: new Date(workflowFixtureNow)
      })).rejects.toThrow(/Full-activation green-red-proof requires literal release\/\*\* and hotfix\/\*\*/);
    });

    it('rejects qualification when validation step is missing or does not match expected name', async () => {
      const f = await buildFullActivationFixture();
      const runId = f.fixtures[0]!.runs[0]!.binding.workflowId;
      const job = f.protocol.jobs.get(100)![0]!;
      job.steps = [
        { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
        { number: 2, name: 'Checkout', status: 'completed', conclusion: 'success' },
        { number: 3, name: 'Unrelated step', status: 'completed', conclusion: 'success' }
      ];

      await expect(qualifyFullActivationChecks({
        client: f.client,
        repository: 'owner/repo',
        requiredChecks: f.requiredChecks,
        fixtures: f.fixtures,
        predecessors: f.predecessors,
        now: new Date(workflowFixtureNow)
      })).rejects.toThrow(/validation step/i);
    });

    it('rejects controlled negative when setup step before validation step fails', async () => {
      const f = await buildFullActivationFixture();
      const negativeFixture = f.fixtures.find((fx) => fx.polarity === 'negative')!;
      const runEntry = negativeFixture.runs[0]!;
      const runId = Number(runEntry.operation.operationId);
      const job = f.protocol.jobs.get(runId)![0]!;
      job.steps = [
        { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
        { number: 2, name: 'Checkout', status: 'completed', conclusion: 'failure' },
        { number: 3, name: 'Validate source', status: 'completed', conclusion: 'failure' }
      ];

      await expect(qualifyFullActivationChecks({
        client: f.client,
        repository: 'owner/repo',
        requiredChecks: f.requiredChecks,
        fixtures: f.fixtures,
        predecessors: f.predecessors,
        now: new Date(workflowFixtureNow)
      })).rejects.toThrow(/Only failure of the exact real validation step with successful setup proves a controlled negative/);
    });

    it('rejects qualification when actor identity conflicts with approved actor', async () => {
      const f = await buildFullActivationFixture();
      const pr = f.protocol.pullRequests.get(f.fixtures[0]!.pullRequestNumber)!;
      pr.user = { id: 999 };

      await expect(qualifyFullActivationChecks({
        client: f.client,
        repository: 'owner/repo',
        requiredChecks: f.requiredChecks,
        fixtures: f.fixtures,
        predecessors: f.predecessors,
        now: new Date(workflowFixtureNow)
      })).rejects.toThrow(/actor-owned/);
    });

    it('rejects qualification when run head SHA conflicts with fixture commit SHA', async () => {
      const f = await buildFullActivationFixture();
      const run = f.protocol.runs.get(100)!;
      run.head_sha = 'b'.repeat(40);

      await expect(qualifyFullActivationChecks({
        client: f.client,
        repository: 'owner/repo',
        requiredChecks: f.requiredChecks,
        fixtures: f.fixtures,
        predecessors: f.predecessors,
        now: new Date(workflowFixtureNow)
      })).rejects.toThrow(/Actual run, attempt, source, actor or final result does not match/);
    });

    it('rejects qualification when infrastructure error occurs during negative check', async () => {
      const f = await buildFullActivationFixture();
      const negativeFixture = f.fixtures.find((fx) => fx.polarity === 'negative')!;
      const runId = Number(negativeFixture.runs[0]!.operation.operationId);
      const checkRun = f.protocol.checks.get(runId * 100)!;
      checkRun.output = { summary: 'runner lost communication during step' };

      await expect(qualifyFullActivationChecks({
        client: f.client,
        repository: 'owner/repo',
        requiredChecks: f.requiredChecks,
        fixtures: f.fixtures,
        predecessors: f.predecessors,
        now: new Date(workflowFixtureNow)
      })).rejects.toThrow(/infrastructure failure/i);
    });
  });

  describe('context projection from qualification', () => {
    it('projects required contexts for valid green-red-proof.v1 evidence', async () => {
      const f = await buildFullActivationFixture();
      const qualification = await qualifyFullActivationChecks({
        client: f.client,
        repository: 'owner/repo',
        requiredChecks: f.requiredChecks,
        fixtures: f.fixtures,
        predecessors: f.predecessors,
        now: new Date(workflowFixtureNow)
      });

      const contexts = fullActivationCheckContextsFromQualification({
        ...qualification,
        kind: 'green-red-proof.v1',
        scope: 'activation'
      });

      expect(contexts.length).toBe(4);
      expect(contexts.map((c) => c.refFamily)).toContain('release/**');
      expect(contexts.map((c) => c.refFamily)).toContain('hotfix/**');
      expect(contexts.every((c) => c.appSlug === 'github-actions')).toBe(true);
    });

    it('rejects context projection if evidence kind is repository-checks-qualified or scope is repository', async () => {
      const f = await buildFullActivationFixture();
      const qualification = await qualifyFullActivationChecks({
        client: f.client,
        repository: 'owner/repo',
        requiredChecks: f.requiredChecks,
        fixtures: f.fixtures,
        predecessors: f.predecessors,
        now: new Date(workflowFixtureNow)
      });

      expect(() => fullActivationCheckContextsFromQualification({
        ...qualification,
        kind: 'repository-checks-qualified.v1',
        scope: 'activation'
      })).toThrow(/exact green-red-proof\.v1 evidence kind/);

      expect(() => fullActivationCheckContextsFromQualification({
        ...qualification,
        kind: 'green-red-proof.v1',
        scope: 'repository'
      })).toThrow(/requires activation scope/);
    });
  });

  describe('read-only revalidation', () => {
    it('revalidates previously qualified green-red-proof evidence in read-only mode without mutations', async () => {
      const f = await buildFullActivationFixture();
      const qualification = await qualifyFullActivationChecks({
        client: f.client,
        repository: 'owner/repo',
        requiredChecks: f.requiredChecks,
        fixtures: f.fixtures,
        predecessors: f.predecessors,
        now: new Date(workflowFixtureNow)
      });

      const evidencePayload: FullActivationChecksEvidencePayload = {
        kind: 'green-red-proof.v1',
        scope: 'activation',
        ...qualification,
        boundFixtures: f.fixtures
      };

      const revalidated = await revalidateFullActivationChecks({
        client: f.client,
        evidence: evidencePayload,
        predecessorVerifier: async () => f.predecessors,
        now: new Date(workflowFixtureNow)
      });

      expect(revalidated.repository).toBe('owner/repo');
      expect(revalidated.sourceSha).toBe(f.protocol.baseSha);
      expect(revalidated.positiveChecks.length).toBe(4);
      expect(revalidated.controlledNegativeChecks.length).toBe(4);

      const writeRequests = f.protocol.requests.filter((r) => r.method !== 'GET');
      expect(writeRequests.length).toBe(0);
    });

    it('forbids provider mutations during revalidation', async () => {
      const f = await buildFullActivationFixture();
      const qualification = await qualifyFullActivationChecks({
        client: f.client,
        repository: 'owner/repo',
        requiredChecks: f.requiredChecks,
        fixtures: f.fixtures,
        predecessors: f.predecessors,
        now: new Date(workflowFixtureNow)
      });

      const evidencePayload: FullActivationChecksEvidencePayload = {
        kind: 'green-red-proof.v1',
        scope: 'activation',
        ...qualification,
        boundFixtures: f.fixtures
      };

      const mutatingClient = new GitHubActivationClient({
        async request(request) {
          if (request.method !== 'GET') {
            throw new GitHubActivationError('check-read-only', 'Mutations are forbidden');
          }
          return f.client.transport.request(request);
        }
      });

      const revalidated = await revalidateFullActivationChecks({
        client: mutatingClient,
        evidence: evidencePayload,
        predecessorVerifier: async () => f.predecessors,
        now: new Date(workflowFixtureNow)
      });
      expect(revalidated.positiveChecks.length).toBe(4);
    });

    it('detects provider drift during revalidation if PR was merged', async () => {
      const f = await buildFullActivationFixture();
      const qualification = await qualifyFullActivationChecks({
        client: f.client,
        repository: 'owner/repo',
        requiredChecks: f.requiredChecks,
        fixtures: f.fixtures,
        predecessors: f.predecessors,
        now: new Date(workflowFixtureNow)
      });

      const evidencePayload: FullActivationChecksEvidencePayload = {
        kind: 'green-red-proof.v1',
        scope: 'activation',
        ...qualification,
        boundFixtures: f.fixtures
      };

      f.protocol.merge(f.fixtures[0]!.pullRequestNumber);

      await expect(revalidateFullActivationChecks({
        client: f.client,
        evidence: evidencePayload,
        predecessorVerifier: async () => f.predecessors,
        now: new Date(workflowFixtureNow)
      })).rejects.toThrow(/unmerged PR/);
    });
  });

  describe('planning fail-closed behavior', () => {
    it('successfully plans full-activation checks when given valid activation configuration and predecessors', async () => {
      const f = await buildFullActivationFixture();
      const planProtocol = new WorkflowGitHubFixture(fullActivationWorkflowSource);
      planProtocol.refs.set('release/maintenance/1.2.3', planProtocol.baseSha);
      planProtocol.refs.set('hotfix/security/1.2.4', planProtocol.baseSha);

      const planningInput = {
        inspection: {
          scope: 'activation',
          activationInputs: {
            phases: {
              'green-red-proof': {
                sourceSha: planProtocol.baseSha,
                workflowPaths: [workflowFixturePath],
                repositoryId: planProtocol.repositoryId,
                actorId: planProtocol.actorId,
                staging: { evidenceId: 'stg', headerDigest: '1'.repeat(64), bodyDigest: '2'.repeat(64) },
                rehearsal: { evidenceId: 'reh', headerDigest: '3'.repeat(64), bodyDigest: '4'.repeat(64) },
                fixtures: f.fixtureConfigs
              }
            },
            repository: { name: 'owner/repo', defaultBranch: 'develop' }
          },
          state: {
            remoteBinding: { id: String(planProtocol.repositoryId), name: 'owner/repo' },
            phases: { 'green-red-proof': {} }
          },
          contexts: { 'green-red-proof': {} },
          manifest: {}
        } as any,
        phase: { id: 'green-red-proof' } as any,
        now: new Date(workflowFixtureNow),
        runner: { run: async () => ({ status: 0, stdout: '', stderr: '' }) } as any,
        adapters: { githubActivation: { transport: planProtocol } } as any
      } as PhasePlanningInput;

      const plan = await planFullActivationChecks(planningInput, {
        predecessorVerifier: () => f.predecessors
      });

      expect(plan.blockers).toBeUndefined();
      expect(plan.operations.length).toBe(1);
      const op = plan.operations[0]!;
      expect(op.actionId).toBe(fullActivationChecksAction);
      expect(op.mutationClass).toBe('github-workflow-dispatch');
      expect(op.destination).toEqual({ type: 'repository', identity: 'owner/repo', repository: 'owner/repo' });

      // Planning never mutates provider
      const postRequests = planProtocol.requests.filter((r) => r.method === 'POST');
      expect(postRequests.length).toBe(0);
    });

    it('fails closed when positive and negative fixture branches collide', async () => {
      const f = await buildFullActivationFixture();
      const collidingConfigs = f.fixtureConfigs.map((cfg) => ({
        ...cfg,
        negativeBranch: cfg.positiveBranch
      }));

      const planningInput = {
        inspection: {
          scope: 'activation',
          activationInputs: {
            phases: {
              'green-red-proof': {
                sourceSha: f.protocol.baseSha,
                workflowPaths: [workflowFixturePath],
                repositoryId: f.protocol.repositoryId,
                actorId: f.protocol.actorId,
                staging: { evidenceId: 'stg', headerDigest: '1'.repeat(64), bodyDigest: '2'.repeat(64) },
                rehearsal: { evidenceId: 'reh', headerDigest: '3'.repeat(64), bodyDigest: '4'.repeat(64) },
                fixtures: collidingConfigs
              }
            },
            repository: { name: 'owner/repo' }
          },
          state: {
            remoteBinding: { id: String(f.protocol.repositoryId), name: 'owner/repo' },
            phases: { 'green-red-proof': {} }
          },
          contexts: { 'green-red-proof': {} }
        } as any,
        phase: { id: 'green-red-proof' } as any,
        now: new Date(workflowFixtureNow)
      } as PhasePlanningInput;

      const plan = await planFullActivationChecks(planningInput, {
        predecessorVerifier: () => f.predecessors
      });
      expect(plan.operations).toEqual([]);
      expect(plan.blockers?.[0]).toMatch(/check-fixtures|distinct unmerged positive\/negative branches/);
    });

    it('fails closed when scope is repository or local', async () => {
      const input = {
        inspection: { scope: 'repository' } as any,
        phase: { id: 'green-red-proof' } as any,
        now: new Date(workflowFixtureNow)
      } as PhasePlanningInput;

      const plan = await planFullActivationChecks(input);
      expect(plan.operations).toEqual([]);
      expect(plan.blockers).toEqual([expect.stringMatching(/requires activation scope/)]);
    });

    it('fails closed when phase is not green-red-proof', async () => {
      const input = {
        inspection: { scope: 'activation' } as any,
        phase: { id: 'dev-proof' } as any,
        now: new Date(workflowFixtureNow)
      } as PhasePlanningInput;

      const plan = await planFullActivationChecks(input);
      expect(plan.operations).toEqual([]);
      expect(plan.blockers[0]).toContain("handles only 'green-red-proof'");
    });
  });

  describe('narrow predecessor verifier callback', () => {
    it('invokes predecessor verifier callback and validates returned predecessors', async () => {
      const f = await buildFullActivationFixture();
      const callback: PredecessorVerifierCallback = (input) => {
        expect(input.sourceSha).toBe(f.protocol.baseSha);
        return createMockPredecessors(input.sourceSha);
      };

      const result = await qualifyFullActivationChecks({
        client: f.client,
        repository: 'owner/repo',
        requiredChecks: f.requiredChecks,
        fixtures: f.fixtures,
        predecessors: await callback({
          staging: { evidenceId: 'stg', headerDigest: '1'.repeat(64), bodyDigest: '2'.repeat(64) },
          rehearsal: { evidenceId: 'reh', headerDigest: '3'.repeat(64), bodyDigest: '4'.repeat(64) },
          sourceSha: f.protocol.baseSha,
          artifactDigest
        }),
        now: new Date(workflowFixtureNow)
      });

      expect(result.predecessors.staging.phaseId).toBe('staging-qualified');
      expect(result.predecessors.rehearsal.phaseId).toBe('production-rehearsed');
    });

    it('rejects predecessor verifier if returned source SHA does not match', async () => {
      const f = await buildFullActivationFixture();
      const badCallback: PredecessorVerifierCallback = (input) => {
        return createMockPredecessors('b'.repeat(40));
      };

      const predecessors = await badCallback({
        staging: { evidenceId: 'stg', headerDigest: '1'.repeat(64), bodyDigest: '2'.repeat(64) },
        rehearsal: { evidenceId: 'reh', headerDigest: '3'.repeat(64), bodyDigest: '4'.repeat(64) },
        sourceSha: f.protocol.baseSha
      });

      const qualificationPromise = qualifyFullActivationChecks({
        client: f.client,
        repository: 'owner/repo',
        requiredChecks: f.requiredChecks,
        fixtures: f.fixtures,
        predecessors,
        now: new Date(workflowFixtureNow)
      });

      expect(predecessors.sourceSha).not.toBe(f.protocol.baseSha);
    });
  });

  describe('checkpoint and recovery preservation', () => {
    it('rejects multiple ambiguous workflow runs for a single fixture event', async () => {
      const f = await buildFullActivationFixture();
      const targetFixture = f.fixtures[0]!;
      const duplicateRun = structuredClone(targetFixture.runs[0]!);
      targetFixture.runs = [...targetFixture.runs, duplicateRun];

      await expect(qualifyFullActivationChecks({
        client: f.client,
        repository: 'owner/repo',
        requiredChecks: f.requiredChecks,
        fixtures: f.fixtures,
        predecessors: f.predecessors,
        now: new Date(workflowFixtureNow)
      })).rejects.toThrow(/Every fixture needs one exact recorded provider run/);
    });

    it('returns blocked outcome when execution scope is repository or local', async () => {
      const execInput = {
        inspection: { scope: 'repository', state: { phases: { 'green-red-proof': {} } } } as any,
        phase: { id: 'green-red-proof' } as any,
        plan: { operations: [] } as any,
        now: new Date(workflowFixtureNow)
      } as PhaseAdapterExecutionInput;

      const outcome = await executeFullActivationChecks(execInput);
      expect(outcome.status).toBe('blocked');
      expect(outcome.blocker).toMatch(/requires activation scope/);
    });

    it('returns blocked outcome when green-red-proof operation is missing from plan', async () => {
      const execInput = {
        inspection: { scope: 'activation', state: { phases: { 'green-red-proof': {} } } } as any,
        phase: { id: 'green-red-proof' } as any,
        plan: { operations: [] } as any,
        now: new Date(workflowFixtureNow)
      } as PhaseAdapterExecutionInput;

      const outcome = await executeFullActivationChecks(execInput);
      expect(outcome.status).toBe('blocked');
      expect(outcome.blocker).toMatch(/no exact reviewed full-activation green-red-proof operation/);
    });
  });
});
