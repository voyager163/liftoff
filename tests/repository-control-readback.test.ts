import { describe, expect, it } from 'vitest';
import { assertMatchingControlReadback } from '../src/application/repository-governance/control-readback.js';
import { executeRepositoryLiveReadback } from '../src/application/repository-governance/producer-rulesets.js';
import { executeRulesetPhase } from '../src/governance-activation/phase-governance.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, canonicalPhaseGraphHash, currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { evidenceBodyDigest, evidenceContextForPhase, validateEvidenceFreshness } from '../src/domain/governance/activation/evidence.js';
import { remoteBindingDigest } from '../src/domain/governance/activation/inputs.js';
import { phaseIds, type LiveReadbackProof, type PhaseEvidenceRecord, type PhaseId, type TransitionOperation, type UserActivationState } from '../src/domain/governance/activation/types.js';
import { planDigestFor } from '../src/domain/governance/activation/operations.js';
import { evaluateApprovalForTransitionPlan, transitionPlanForPhase } from '../src/domain/governance/activation/approvals.js';
import { validateSavedTransitionPlan } from '../src/domain/governance/activation/validators.js';
import type { GitHubRulesetWriteResult, PhaseAdapterExecutionInput } from '../src/governance-activation/transition-ports.js';
import { parseManifest } from '../src/application/project/manifest.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { buildManifest } from '../src/templates.js';

const sourceDigest = canonicalSha256('exact reviewed ruleset source');
const now = new Date('2026-09-15T00:00:00.000Z');
const matching = {
  resourceId: '/repos/owner/repo/rulesets/1', sourceDigest, readbackDigest: sourceDigest
};

function fixture(readback: GitHubRulesetWriteResult = matching) {
  const phaseId = 'repository-live-readback';
  const sourcePhase = 'repository-workflow-source-ready';
  const phase = canonicalPhaseGraph.phases.find((phase) => phase.id === phaseId)!;
  const state: UserActivationState = {
    schemaVersion: 4, identity: currentActivationIdentity,
    repository: { id: 'local:11111111-1111-4111-8111-111111111111', name: 'readback', defaultBranch: 'develop' },
    remoteBinding: { id: '42', name: 'owner/repo', defaultBranch: 'develop', pushUrl: 'https://github.com/owner/repo.git', verifiedAt: now.toISOString() },
    activeChange: null, applicability: { statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown' },
    phases: Object.fromEntries(phaseIds.map((id) => [id, {
      state: 'pending', updatedAt: now.toISOString(), evidence: [], approvals: [], blockers: []
    }])) as UserActivationState['phases'],
    createdAt: now.toISOString(), updatedAt: now.toISOString()
  };
  const contexts = Object.fromEntries(phaseIds.map((id) => [id, evidenceContextForPhase(id, {
    repositoryId: state.repository.id, baselineSha: canonicalSha256('baseline'), inputDigest: canonicalSha256(id),
    remoteBindingDigest: remoteBindingDigest(state.remoteBinding), now
  })])) as Record<PhaseId, ReturnType<typeof evidenceContextForPhase>>;
  const sourceContext = contexts[sourcePhase];
  const payload = { kind: `${sourcePhase}.v1`, rulesetSourceDigest: sourceDigest };
  const liveReadback: LiveReadbackProof[] = [{
    schemaVersion: 4, repositoryId: state.repository.id, identity: currentActivationIdentity,
    phaseGraphHash: canonicalPhaseGraphHash, phaseId: sourcePhase,
    baselineSha: sourceContext.baselineSha, inputDigest: sourceContext.inputDigest, transition: sourceContext.transition,
    observedAt: now.toISOString(), provider: 'github' as const, resourceType: 'workflow-source', resourceId: '/repos/owner/repo',
    sourceDigest, readbackDigest: sourceDigest, matches: true
  }];
  const source: PhaseEvidenceRecord = {
    evidenceId: 'current-source', payload, liveReadback,
    header: {
      schemaVersion: 4, repositoryId: state.repository.id, identity: currentActivationIdentity,
      phaseGraphHash: canonicalPhaseGraphHash, phaseId: sourcePhase, phaseContractDigest: sourceContext.phaseContractDigest,
      baselineSha: sourceContext.baselineSha, inputDigest: sourceContext.inputDigest, transition: sourceContext.transition,
      producedAt: now.toISOString(), producer: 'readback-regression-fixture', result: 'verified', scope: 'repository',
      bodyDigest: evidenceBodyDigest(payload, liveReadback), remoteBindingDigest: sourceContext.remoteBindingDigest
    }
  };
  state.phases[sourcePhase] = {
    state: 'verified', updatedAt: now.toISOString(), approvals: [], blockers: [],
    evidence: [{ phaseId: sourcePhase, evidenceId: source.evidenceId, result: 'verified', headerDigest: canonicalSha256(source.header) }]
  };
  sourceContext.evidenceReferences = state.phases[sourcePhase].evidence;
  const operation: TransitionOperation = {
    phaseId, adapter: 'github' as const, actionId: 'github.ruleset.readback', mutationClass: 'github-read' as const,
    inputs: { repository: 'owner/repo', sourceDigest }, destination: { type: 'repository' as const, identity: 'owner/repo', repository: 'owner/repo' },
    remote: true, destructive: false
  };
  const request = transitionPlanForPhase(phase, state, contexts[phaseId].transition, undefined, undefined, { operations: [operation] });
  const evaluation = evaluateApprovalForTransitionPlan(request, [], { now });
  const plan = validateSavedTransitionPlan({
    schemaVersion: 2, scope: 'repository', phaseId, identity: currentActivationIdentity, graphHash: canonicalPhaseGraphHash,
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), stateHash: canonicalSha256(state),
    baselineDigest: contexts[phaseId].baselineSha, inputDigest: contexts[phaseId].inputDigest,
    transitionDigest: contexts[phaseId].transition.transitionDigest,
    planDigest: planDigestFor({ phase, transitionDigest: contexts[phaseId].transition.transitionDigest, operations: [operation], approvalPlanDigest: request.planDigest }),
    mutationClasses: phase.allowedMutations, operations: [operation],
    approval: { gateKind: 'none', required: false, evaluation, envelopeId: null, envelopeHash: null },
    rollbackPlan: { phaseId, strategy: 'retain', target: null, operations: [], retained: [], cleanupWarnings: [] }, noSecrets: true
  });
  let reads = 0;
  const manifest = buildManifest(buildProjectPlan({
    projectName: 'readback', projectType: 'standard', apiStack: 'node-fastify', cloud: 'azure',
    region: 'eastus', environments: ['dev'], includeFrontend: false, specWorkflow: 'openspec', agents: ['github-copilot']
  }, { requireProjectName: true }), []);
  if (manifest.governance.profile !== 'none' && manifest.governance.profile !== 'unspecified') manifest.governance.state = 'handoff-partial';
  const input: PhaseAdapterExecutionInput = {
    phase, plan, now,
    inspection: {
      projectRoot: process.cwd(), manifest: parseManifest(manifest),
      graph: canonicalPhaseGraph, graphHash: canonicalPhaseGraphHash, scope: 'repository',
      state, approvals: [], evidence: [source], contexts,
      readiness: { nextReadyPhase: phaseId, phases: Object.fromEntries(phaseIds.map((id) => [id, { state: 'pending', blockers: [] }])) as PhaseAdapterExecutionInput['inspection']['readiness']['phases'] },
      sourceOfTruth: { status: 'none', selected: null, candidates: [], createPlan: { status: 'blocked', changeId: 'readback-only', workflowKind: 'openspec', reason: 'No mutation requested.', requiredFacts: [] } }
    },
    runner: { async run() { throw new Error('No process or live provider operation is allowed in this regression.'); } },
    adapters: { githubRulesets: {
      async applyRuleset() { throw new Error('Readback never grants write authority.'); },
      async readRuleset() { reads++; return readback; }
    } }
  };
  return { input, reads: () => reads };
}

describe('control readback admission independent of helper equality', () => {
  it.each([null, [], {}, { ...matching, sourceDigest: 'b'.repeat(64) }, { ...matching, readbackDigest: 'b'.repeat(64) },
    { ...matching, readbackDigest: true }, { ...matching, resourceId: '' },
    { ...matching, resourceId: '/repos/foreign/repo/rulesets/1' },
    { ...matching, resourceId: '/repos/owner/repo/rulesets/../other' }])('rejects malformed or mismatching result %#', (readback) => {
    expect(() => assertMatchingControlReadback(sourceDigest, readback, 'owner/repo')).toThrow(/semantic helper equality alone is not proof/);
  });

  it('does not admit a source-only injected result without its exact current owned-control receipt', async () => {
    const f = fixture({ ...matching, readbackDigest: 'b'.repeat(64) });
    const outcome = await executeRepositoryLiveReadback(f.input);
    expect(outcome).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('same-scope approved enforcement receipt') });
    expect(f.reads()).toBe(0);
    expect(outcome.liveReadback).toBeUndefined();
    expect(outcome.evidencePayload).toBeUndefined();
  });

  it('does not mistake source-only digest equality for control/settings/main-hold readback', async () => {
    const f = fixture();
    const outcome = await executeRepositoryLiveReadback(f.input);
    expect(outcome.status).toBe('blocked');
    expect(f.reads()).toBe(0);
    expect(outcome.liveReadback).toBeUndefined();
    expect(outcome.evidencePayload).toBeUndefined();
  });

  it('rejects a persisted mismatch even when its wrapper body and readback hashes agree', () => {
    const f = fixture();
    const phase = f.input.phase.id;
    const context = f.input.inspection.contexts[phase];
    const payload = {
      kind: `${phase}.v1`, sourceDigest, readbackDigest: 'b'.repeat(64), resourceId: matching.resourceId
    };
    const wrapperDigest = canonicalSha256(payload);
    const proof: LiveReadbackProof = {
      ...f.input.inspection.evidence[0]!.liveReadback![0]!,
      phaseId: phase, baselineSha: context.baselineSha, inputDigest: context.inputDigest, transition: context.transition,
      resourceType: 'ruleset', resourceId: matching.resourceId, sourceDigest: wrapperDigest, readbackDigest: wrapperDigest
    };
    const record: PhaseEvidenceRecord = {
      evidenceId: 'invalid-wrapper-proof', payload, liveReadback: [proof],
      header: {
        ...f.input.inspection.evidence[0]!.header,
        phaseId: phase, phaseContractDigest: context.phaseContractDigest,
        baselineSha: context.baselineSha, inputDigest: context.inputDigest, transition: context.transition,
        bodyDigest: evidenceBodyDigest(payload, [proof])
      }
    };
    const result = validateEvidenceFreshness(record, context);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues).toContainEqual(expect.objectContaining({
      field: 'payload', message: expect.stringContaining('matching reviewed source and independent readback digests')
    }));
  });

  it('refuses stale source evidence in both repository and compatibility consumers before provider access', async () => {
    const f = fixture();
    f.input.inspection.contexts['repository-workflow-source-ready'].inputDigest = canonicalSha256('changed source inputs');
    expect(await executeRepositoryLiveReadback(f.input)).toMatchObject({ status: 'blocked', completedOperations: [] });
    expect(await executeRulesetPhase(f.input)).toMatchObject({ status: 'blocked', completedOperations: [] });
    expect(f.reads()).toBe(0);
  });
});
