import { describe, expect, it } from 'vitest';
import {
  canonicalApprovalEnvelopeHash,
  canonicalPhaseGraph,
  currentActivationIdentity,
  approvalEnvelopeV1Schema,
  determineHumanAuthorityQuestion,
  evaluateApprovalForTransitionPlan,
  evidenceContextForPhase,
  humanAuthorityQuestionKinds,
  transitionPlanForPhase,
  validateApprovalEnvelope
} from '../src/governance-activation/index.js';
import type {
  ApprovalEnvelope,
  ApprovalGateKind,
  ApprovalResourceScope,
  PhaseId,
  RequestedTransitionPlan,
  UserActivationState
} from '../src/governance-activation/index.js';

const future = '2030-01-01T00:00:00.000Z';
const now = new Date('2026-09-04T00:00:00.000Z');
const digest = 'b'.repeat(64);

function state(): UserActivationState {
  const phases = Object.fromEntries(canonicalPhaseGraph.phases.map((phase) => [phase.id, {
    state: 'pending',
    updatedAt: '2026-09-04T00:00:00.000Z',
    evidence: [],
    approvals: [],
    blockers: []
  }])) as UserActivationState['phases'];
  return {
    schemaVersion: currentActivationIdentity.activationStateSchemaVersion,
    identity: currentActivationIdentity,
    repository: {
      id: 'R_approval',
      name: 'owner/repo',
      defaultBranch: 'main'
    },
    activeChange: null,
    applicability: {
      statePath: 'bootstrap-local',
      privateStagingDast: true,
      credentialRequired: true
    },
    phases,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z'
  };
}

function planFor(phaseId: PhaseId): RequestedTransitionPlan {
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === phaseId)!;
  const activationState = state();
  const context = evidenceContextForPhase(phaseId, {
    repositoryId: activationState.repository.id,
    identity: currentActivationIdentity,
    phaseGraphHash: currentActivationIdentity.phaseGraphHash
  });
  return transitionPlanForPhase(phase, activationState, context.transition);
}

function envelope(
  plan: RequestedTransitionPlan,
  overrides: Partial<ApprovalEnvelope> = {}
): ApprovalEnvelope {
  return {
    schemaVersion: currentActivationIdentity.approvalEnvelopeSchemaVersion,
    id: `${plan.phaseId}-approval`,
    ...plan,
    expiresAt: future,
    approvedAt: '2026-09-04T00:00:00.000Z',
    approver: 'owner',
    ...overrides
  };
}

function expectApprovalRequired(
  requested: RequestedTransitionPlan,
  approved: ApprovalEnvelope,
  expected: RegExp
): void {
  const result = evaluateApprovalForTransitionPlan(requested, [approved], { now });
  expect(result.approvalRequired).toBe(true);
  expect(result.reasons.join('\n')).toMatch(expected);
}

describe('approval-envelope v1 validation and hashing', () => {
  it('exports a strict v1 JSON schema for the envelope shape', () => {
    expect(approvalEnvelopeV1Schema).toMatchObject({
      additionalProperties: false,
      properties: {
        schemaVersion: { const: 1 },
        costCeiling: {
          properties: {
            fixedMonthlyCents: { type: 'integer', minimum: 0 },
            usageMonthlyCents: { type: 'integer', minimum: 0 }
          }
        }
      }
    });
  });

  it('canonicalizes set order without hashing approval metadata', () => {
    const base = planFor('provider-ready');
    const first = validateApprovalEnvelope(envelope({
      ...base,
      resources: [
        { type: 'azure-provider-register', identity: 'provider/Microsoft.App' },
        { type: 'azure-read', identity: 'subscription/000' }
      ],
      permissions: ['Azure.Provider/Register', 'Azure.Subscription/Read'],
      policyExceptions: ['exception-b', 'exception-a']
    }));
    const reordered = validateApprovalEnvelope(envelope({
      ...base,
      resources: [
        { type: 'AZURE-READ', identity: 'subscription/000' },
        { type: 'azure-provider-register', identity: 'provider/Microsoft.App' }
      ],
      permissions: ['azure.subscription/read', 'azure.provider/register'],
      policyExceptions: ['exception-a', 'exception-b']
    }, {
      approvedAt: '2026-09-04T01:02:03.000Z',
      approver: 'another-owner'
    }));

    expect(canonicalApprovalEnvelopeHash(first)).toBe(canonicalApprovalEnvelopeHash(reordered));
  });

  it('rejects malformed shape, duplicates, invalid costs, currency, timestamps, expiry, and identity mismatch', () => {
    const base = envelope(planFor('provider-ready'));
    expect(() => validateApprovalEnvelope({ ...base, extra: true })).toThrow(/not allowed/);
    expect(() => validateApprovalEnvelope({ ...base, gateKind: 'enforcement' })).toThrow(/does not match phase/);
    expect(() => validateApprovalEnvelope({
      ...base,
      resources: [
        { type: 'azure-read', identity: 'subscription/000' },
        { type: 'AZURE-READ', identity: 'subscription/000' }
      ]
    })).toThrow(/duplicate/);
    expect(() => validateApprovalEnvelope({
      ...base,
      costCeiling: { currency: 'USD', fixedMonthlyCents: -1, usageMonthlyCents: 0 }
    })).toThrow(/non-negative/);
    expect(() => validateApprovalEnvelope({
      ...base,
      costCeiling: { currency: 'USD', fixedMonthlyCents: Number.POSITIVE_INFINITY, usageMonthlyCents: 0 }
    })).toThrow(/finite|safe integer|non-negative/);
    expect(() => validateApprovalEnvelope({
      ...base,
      costCeiling: { currency: 'usd', fixedMonthlyCents: 0, usageMonthlyCents: 0 }
    })).toThrow(/currency/);
    expect(() => validateApprovalEnvelope({ ...base, expiresAt: 'soon' })).toThrow(/ISO timestamp/);
    expect(() => validateApprovalEnvelope(
      { ...base, expiresAt: '2020-01-01T00:00:00.000Z' },
      { requireUnexpired: true, now }
    )).toThrow(/future/);
    expect(() => validateApprovalEnvelope(base, {
      expectedIdentity: { ...currentActivationIdentity, liftoffVersion: '0.10.1' }
    })).toThrow(/identity/);
  });
});

describe('human authority question classification', () => {
  it('exports the only allowed question kinds and maps gates deterministically', () => {
    expect(humanAuthorityQuestionKinds).toEqual([
      'repository-creation-initial-commit-push',
      'credential-enrollment',
      'billed-infrastructure-policy-exception-cost-ceiling',
      'final-enforcement',
      'destructive-operation',
      'external-blocker'
    ]);
    expect(determineHumanAuthorityQuestion(planFor('seed-valid'))).toBeNull();
    expect(determineHumanAuthorityQuestion(planFor('phase-0-complete'))).toBeNull();
    expect(determineHumanAuthorityQuestion(planFor('committed'))).toBe('repository-creation-initial-commit-push');
    expect(determineHumanAuthorityQuestion(planFor('credential-ready'))).toBe('credential-enrollment');
    expect(determineHumanAuthorityQuestion(planFor('provider-ready'))).toBe('billed-infrastructure-policy-exception-cost-ceiling');
    expect(determineHumanAuthorityQuestion(planFor('enforcement-approved'))).toBe('final-enforcement');
    expect(determineHumanAuthorityQuestion(planFor('bootstrap-state-disposed'))).toBe('destructive-operation');

    expect(() => determineHumanAuthorityQuestion({
      ...planFor('seed-valid'),
      costCeiling: { currency: 'USD', fixedMonthlyCents: 1, usageMonthlyCents: 0 }
    })).toThrow(/gate none/);
    expect(() => determineHumanAuthorityQuestion({
      ...planFor('provider-ready'),
      destructiveScope: ['local-key']
    })).toThrow(/destructive-disposal/);
  });
});

describe('approval reuse and expansion detection', () => {
  it('reuses exact retries inside unchanged approval scope', () => {
    const approvedPlan = {
      ...planFor('provider-ready'),
      costCeiling: { currency: 'USD', fixedMonthlyCents: 1000, usageMonthlyCents: 2000 }
    };
    const approved = envelope(approvedPlan);
    const retry = {
      ...approvedPlan,
      resources: [...approvedPlan.resources].reverse(),
      destinations: [...approvedPlan.destinations].reverse(),
      permissions: [...approvedPlan.permissions].reverse()
    };

    const result = evaluateApprovalForTransitionPlan(retry, [approved], { now });
    expect(result).toMatchObject({
      approvalRequired: false,
      status: 'reused',
      envelopeId: approved.id
    });
  });

  it('requires renewed approval for every material expansion dimension', () => {
    const approvedPlan = planFor('provider-ready');
    const approved = envelope(approvedPlan);
    const extraResource: ApprovalResourceScope = { type: 'azure-resource-provision', identity: 'resource/new' };

    const cases: Array<[string, RequestedTransitionPlan, RegExp]> = [
      ['resource type or identity', { ...approvedPlan, resources: [...approvedPlan.resources, extraResource] }, /resource scope expanded/],
      ['destination repository', {
        ...approvedPlan,
        destinations: [...approvedPlan.destinations, {
          type: 'repository',
          identity: 'owner/other',
          repository: 'owner/other',
          subscriptionId: null
        }]
      }, /destination scope expanded/],
      ['destination subscription', {
        ...approvedPlan,
        destinations: [...approvedPlan.destinations, {
          type: 'subscription',
          identity: 'subscription/111',
          repository: null,
          subscriptionId: 'subscription/111'
        }]
      }, /destination scope expanded/],
      ['permission', { ...approvedPlan, permissions: [...approvedPlan.permissions, 'azure.resource/write'] }, /permission scope expanded/],
      ['fixed cost', {
        ...approvedPlan,
        costCeiling: { currency: 'USD', fixedMonthlyCents: 1, usageMonthlyCents: 0 }
      }, /fixed monthly cost ceiling increased/],
      ['usage cost', {
        ...approvedPlan,
        costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 1 }
      }, /usage monthly cost ceiling increased/],
      ['policy exception', { ...approvedPlan, policyExceptions: ['temporary-exception'] }, /policy exception added/],
      ['destructive scope', {
        ...planFor('bootstrap-state-disposed'),
        destructiveScope: ['bootstrap-state-disposed:declared-disposal-scope', 'extra-key']
      }, /destructive scope expanded/]
    ];

    for (const [, requested, expected] of cases) {
      const matchingApproval = requested.phaseId === approved.phaseId ? approved : envelope(planFor(requested.phaseId));
      expectApprovalRequired(requested, matchingApproval, expected);
    }
  });

  it('invalidates expired, identity, baseline, gate, and plan-authority mismatches', () => {
    const approvedPlan = planFor('committed');
    const approved = envelope(approvedPlan);

    expect(evaluateApprovalForTransitionPlan(approvedPlan, [
      envelope(approvedPlan, { expiresAt: '2020-01-01T00:00:00.000Z' })
    ], { now })).toMatchObject({ approvalRequired: true, status: 'expired' });
    expectApprovalRequired(
      approvedPlan,
      envelope({ ...approvedPlan, identity: { ...currentActivationIdentity, liftoffVersion: '0.10.1' } }),
      /activation identity changed/
    );
    expectApprovalRequired({ ...approvedPlan, baselineSha: digest }, approved, /baseline SHA changed/);
    expectApprovalRequired({ ...approvedPlan, planDigest: digest }, approved, /plan authority digest changed/);
    expectApprovalRequired(
      { ...approvedPlan, gateKind: 'enforcement' as ApprovalGateKind },
      approved,
      /approval gate changed/
    );
  });
});
