import { describe, expect, it } from 'vitest';
import {
  canonicalPhaseGraph, canonicalPhaseGraphHash, currentActivationIdentity, canonicalPhaseContractDigests
} from '../src/domain/governance/activation/graph.js';
import {
  validateActivationIdentity, validateActivationConfiguration, validateManagedPhaseGraph,
  validateUserActivationState, validateEvidenceHeader, validateApprovalEnvelope
} from '../src/domain/governance/activation/validators.js';
import {
  historicalV1ActivationIdentity, historicalV2ActivationIdentity
} from '../src/domain/governance/policy/identity.js';
import {
  phaseIds, phaseScope, type UserActivationState, type PhaseEvidenceRecord, type PhaseId
} from '../src/domain/governance/activation/types.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { phaseInputDigest, type ActivationInputSnapshot } from '../src/domain/governance/activation/inputs.js';
import { evidenceBodyDigest, evidenceContextForPhase } from '../src/domain/governance/activation/evidence.js';
import { calculatePhaseReadiness } from '../src/domain/governance/activation/readiness.js';
import { assertOperationAllowed } from '../src/domain/governance/activation/operations.js';
import { verifiedGitInputBinding } from '../src/governance-activation/transition-files.js';
import type { CommandRunner } from '../src/process-runner.js';
import {
  canonicalApprovalEnvelopeHash, transitionPlanForPhase, combineApprovalRequests, evaluateApprovalForTransitionPlan
} from '../src/domain/governance/activation/approvals.js';

const now = new Date('2026-05-01T10:00:00.000Z');
const digest = (value: string) => canonicalSha256(value);

function state(): UserActivationState {
  return {
    schemaVersion: currentActivationIdentity.activationStateSchemaVersion, identity: currentActivationIdentity,
    repository: { id: 'local:test', name: 'test', defaultBranch: 'develop' },
    activeChange: null,
    applicability: {
      statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown',
      cloudStateRequired: 'unknown', privateRunnerRequired: 'unknown'
    },
    phases: Object.fromEntries(phaseIds.map((id) => [id, {
      state: 'pending', updatedAt: now.toISOString(), evidence: [], approvals: [], blockers: []
    }])) as UserActivationState['phases'],
    createdAt: now.toISOString(), updatedAt: now.toISOString()
  };
}

function contexts() {
  return Object.fromEntries(phaseIds.map((id) => [id, evidenceContextForPhase(id, {
    repositoryId: 'local:test', baselineSha: digest('baseline'), inputDigest: digest(id), now
  })])) as Record<PhaseId, ReturnType<typeof evidenceContextForPhase>>;
}

function localEvidence(): PhaseEvidenceRecord[] {
  const current = contexts();
  return canonicalPhaseGraph.completionGroups.local.map((id) => {
    const payload = { kind: `${id}.v1`, ...(id === 'seed-verified' ? { checks: [{ id: 'baseline', status: 'passed' }] } : {}) };
    return {
      evidenceId: `${id}-receipt`,
      header: {
        schemaVersion: currentActivationIdentity.evidenceHeaderSchemaVersion, repositoryId: 'local:test', identity: currentActivationIdentity,
        phaseGraphHash: canonicalPhaseGraphHash, phaseId: id, phaseContractDigest: canonicalPhaseContractDigests[id],
        inputDigest: current[id].inputDigest, baselineSha: current[id].baselineSha, transition: current[id].transition,
        producedAt: now.toISOString(), producer: 'contract-fixture', bodyDigest: evidenceBodyDigest(payload),
        scope: 'local', result: 'verified'
      },
      payload
    };
  });
}

describe('current activation execution contracts', () => {
  it('uses the approved exact identity vector and a computed 35-phase graph', () => {
    expect(currentActivationIdentity).toMatchObject({
      liftoffVersion: '0.13.0', manifestArtifactVersion: 8, policyVersion: '8',
      activationContractVersion: 4, phaseGraphSchemaVersion: 3,
      activationStateSchemaVersion: 4, evidenceHeaderSchemaVersion: 4, approvalEnvelopeSchemaVersion: 4,
      supersessionSchemaVersion: 1, credentialPolicySchemaVersion: 2
    });
    expect(canonicalPhaseGraphHash).toBe(canonicalSha256(canonicalPhaseGraph));
    expect(phaseIds).toHaveLength(35);
    expect(validateManagedPhaseGraph(canonicalPhaseGraph)).toEqual(canonicalPhaseGraph);
    expect(() => validateActivationIdentity(historicalV1ActivationIdentity)).toThrow();
    expect(() => validateActivationIdentity(historicalV2ActivationIdentity)).toThrow();
    expect(() => validateActivationIdentity({ ...currentActivationIdentity, activationStateSchemaVersion: 2 })).toThrow();
  });

  it('rejects misleading completion groups and unsupported neighboring config', () => {
    expect(() => validateManagedPhaseGraph({
      ...canonicalPhaseGraph,
      completionGroups: { ...canonicalPhaseGraph.completionGroups, local: [...canonicalPhaseGraph.completionGroups.local, 'committed'] }
    })).toThrow(/completionGroups/);
    expect(() => validateActivationConfiguration({ schemaVersion: 1, phases: { unsupported: {} } })).toThrow();
    expect(() => validateActivationConfiguration({ schemaVersion: 1, phases: { 'credential-ready': { token: 'opaque-value' } } })).toThrow(/public activation inputs/);
    expect(() => validateActivationConfiguration({
      schemaVersion: 1, phases: {}, azure: { subscriptionId: 'discovered-subscription', tenantId: 'unknown', region: 'eastus' }
    })).toThrow(/concrete/);
    expect(validateUserActivationState(state()).identity).toEqual(currentActivationIdentity);
  });

  it('plans publication before approval without expanding local execution', () => {
    const activation = calculatePhaseReadiness({ state: state(), approvals: [], evidence: localEvidence(), transitionContexts: contexts(), scope: 'activation', now });
    expect(activation.completion.local).toBe(true);
    expect(activation.completion.activation).toBe(false);
    expect(activation.nextPlannablePhase).toBe('committed');
    expect(activation.nextReadyPhase).toBeNull();
    expect(activation.phases.committed).toMatchObject({ plannable: true, approvalRequired: true });
    const local = calculatePhaseReadiness({ state: state(), approvals: [], evidence: localEvidence(), transitionContexts: contexts(), scope: 'local', now });
    expect(local.nextPlannablePhase).toBeNull();
    expect(local.nextReadyPhase).toBeNull();
    expect(local.completion.local).toBe(true);
    expect(local.completion.lifecycle).toBe(false);
  });

  it('does not infer private backend inapplicability from absent DAST', () => {
    const current = state();
    current.applicability.privateStagingDast = false;
    const readiness = calculatePhaseReadiness({ state: current, approvals: [], evidence: [], transitionContexts: contexts(), now });
    expect(readiness.phases['provider-ready'].state).not.toBe('inapplicable');
    expect(readiness.phases['state-path-selected'].state).not.toBe('inapplicable');
  });

  it('binds expected before/after outputs rather than silently ignoring them', () => {
    const header = localEvidence()[0]!.header;
    const after = digest('after');
    expect(validateEvidenceHeader({
      ...header, inputDigest: after,
      inputBindings: {
        beforeDigest: header.inputDigest, afterDigest: after,
        files: [{ pathParts: ['seed', 'tasks.md'], beforeHash: digest('before-file'), afterHash: digest('after-file') }]
      }
    }).inputDigest).toBe(after);
    expect(() => validateEvidenceHeader({
      ...header, inputDigest: after,
      inputBindings: { beforeDigest: digest('unreviewed'), afterDigest: after, files: [] }
    })).toThrow(/before-input/);
    expect(() => validateEvidenceHeader({ ...header, scope: 'activation' })).toThrow();
  });

  it('keeps local checks stable while actual new publication payload and commits invalidate publication', () => {
    const snapshot: ActivationInputSnapshot = {
      schemaVersion: 2, project: { name: 'app' },
      files: [{ path: 'src/app.ts', digest: digest('source') }],
      git: { head: 'a'.repeat(40), branch: 'develop', pushUrls: ['https://github.com/owner/repo.git'] },
      baselineSha: digest('initial')
    };
    const workflow = {
      ...snapshot, baselineSha: digest('published'),
      files: [...snapshot.files, { path: '.github/workflows/liftoff-bootstrap.yml', digest: digest('workflow') }],
      git: { ...snapshot.git, head: 'b'.repeat(40) }
    };
    for (const id of ['seed-verified'] as const) {
      expect(phaseInputDigest(id, workflow)).toBe(phaseInputDigest(id, snapshot));
      expect(phaseInputDigest(id, { ...workflow, files: [{ path: 'src/app.ts', digest: digest('changed') }] })).not.toBe(phaseInputDigest(id, snapshot));
    }
    for (const id of ['committed', 'pushed'] as const) {
      expect(phaseInputDigest(id, workflow)).not.toBe(phaseInputDigest(id, snapshot));
    }
    expect(phaseInputDigest('bootstrap-workflow-source-ready', workflow)).not.toBe(phaseInputDigest('bootstrap-workflow-source-ready', snapshot));
  });

  it('rejects unknown effects rather than classifying action prefixes as reads', () => {
    const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'phase-0-complete')!;
    expect(() => assertOperationAllowed(phase, {
      adapter: 'github', actionId: 'github.phase0.discover', phaseId: phase.id,
      mutationClass: 'github-read', remote: true, destructive: false, inputs: {},
      destination: { type: 'repository', identity: 'owner/repo', repository: 'owner/repo' },
      effects: [{ mutationClass: 'github-write', remote: true, destructive: false,
        destination: { type: 'repository', identity: 'owner/repo', repository: 'owner/repo' } }]
    })).toThrow(/Delegated effect/);
    expect(phaseScope('bootstrap-state-disposed')).toBe('lifecycle');
  });

  it('commits scope, covered operations, and approval interval into authority hashes', () => {
    const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'committed')!;
    const request = transitionPlanForPhase(phase, state(), contexts().committed.transition);
    const envelope = {
      ...request, schemaVersion: currentActivationIdentity.approvalEnvelopeSchemaVersion, id: 'approval', approvedAt: now.toISOString(),
      expiresAt: '2026-05-01T11:00:00.000Z', approver: 'operator'
    };
    expect(canonicalApprovalEnvelopeHash(envelope)).not.toBe(canonicalApprovalEnvelopeHash({ ...envelope, scope: 'local' }));
    expect(canonicalApprovalEnvelopeHash(envelope)).not.toBe(canonicalApprovalEnvelopeHash({ ...envelope, operationDigests: [digest('other')] }));
    expect(canonicalApprovalEnvelopeHash(envelope)).not.toBe(canonicalApprovalEnvelopeHash({ ...envelope, expiresAt: '2026-05-01T12:00:00.000Z' }));
  });

  it('reuses an exact final-enforcement bundle without granting other operations or phases', () => {
    const current = state();
    current.repository.name = 'owner/repo';
    const approvalPhase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'enforcement-approved')!;
    const writePhase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'rulesets-applied')!;
    const first = transitionPlanForPhase(approvalPhase, current, contexts()['enforcement-approved'].transition,
      undefined, undefined, { operations: [], fileChanges: [] });
    const operations = [{
      adapter: 'github' as const, actionId: 'github.ruleset.apply', phaseId: 'rulesets-applied' as const,
      mutationClass: 'github-ruleset-write' as const, remote: true, destructive: false,
      inputs: { sourceDigest: digest('rulesets') },
      destination: { type: 'repository' as const, identity: 'owner/repo', repository: 'owner/repo' }
    }];
    const second = transitionPlanForPhase(writePhase, current, contexts()['rulesets-applied'].transition,
      undefined, undefined, { operations, fileChanges: [] });
    const bundle = combineApprovalRequests([first, second]);
    const envelope = validateApprovalEnvelope({
      ...bundle, schemaVersion: currentActivationIdentity.approvalEnvelopeSchemaVersion, id: 'enforcement-bundle', approvedAt: now.toISOString(),
      expiresAt: '2026-05-01T11:00:00.000Z', approver: 'operator'
    });
    expect(envelope.coveredPhases).toEqual(['enforcement-approved', 'rulesets-applied']);
    expect(evaluateApprovalForTransitionPlan(second, [envelope], { now }).approvalRequired).toBe(false);
    expect(evaluateApprovalForTransitionPlan(first, [envelope], { now }).approvalRequired).toBe(false);
    const changed = transitionPlanForPhase(writePhase, current, contexts()['rulesets-applied'].transition,
      undefined, undefined, { operations: [{ ...operations[0]!, inputs: { sourceDigest: digest('unreviewed rulesets') } }], fileChanges: [] });
    expect(evaluateApprovalForTransitionPlan(changed, [envelope], { now }).approvalRequired).toBe(true);
    expect(() => combineApprovalRequests([first, { ...second, scope: 'local' }])).toThrow(/one identity/);
    const { phasePlanDigests: _digests, ...unbound } = envelope;
    expect(() => validateApprovalEnvelope(unbound)).toThrow(/every exact phase plan digest/);
  });

  it('rejects unplanned Git changes while recording an approved descendant commit', async () => {
    const before = { head: 'a'.repeat(40), branch: 'develop', pushUrls: ['https://github.com/owner/repo.git'] };
    const after = { ...before, head: 'b'.repeat(40) };
    const runner: CommandRunner = {
      async run(command) {
        expect(command).toEqual({ executable: 'git', args: ['merge-base', '--is-ancestor', before.head, after.head] });
        return { command, displayCommand: 'git merge-base', status: 0, signal: null, stdout: '', stderr: '', timedOut: false };
      }
    };
    await expect(verifiedGitInputBinding(before, after, { operations: [] }, '/not-used', runner)).rejects.toThrow(/outside an approved/);
    const plan = { operations: [{
      adapter: 'git' as const, actionId: 'git.commit-reviewed', mutationClass: 'git-commit' as const,
      phaseId: 'committed' as const, inputs: {}, destination: { type: 'local' as const, identity: '/not-used' },
      remote: false, destructive: false
    }] };
    expect(await verifiedGitInputBinding(before, after, plan, '/not-used', runner)).toEqual({ before, after });
    await expect(verifiedGitInputBinding(before, { ...before, pushUrls: ['https://github.com/other/repo.git'] },
      plan, '/not-used', runner)).rejects.toThrow(/existing remotes are never replaced/);
  });
});
