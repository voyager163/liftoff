import { describe, expect, it } from 'vitest';
import {
  evaluateModernPullRequestGate,
  type ModernPullRequestGateInput,
  type ModernPullRequestReviewObservation
} from '../src/domain/governance/activation/modern-pull-request-gate.js';
import { modernActivationSourceContracts } from '../src/domain/governance/policy/identity.js';

const head = 'a'.repeat(40);
const previousHead = 'b'.repeat(40);

const teamRule = modernActivationSourceContracts().find(
  (source) => source.identity.profile === 'team-gitflow' && source.identity.workflow === 'openspec'
)!.graph.profileContract.pullRequestReview;
const singleRule = modernActivationSourceContracts().find(
  (source) => source.identity.profile === 'single-maintainer-gitflow' && source.identity.workflow === 'openspec'
)!.graph.profileContract.pullRequestReview;

function review(extra: Partial<ModernPullRequestReviewObservation> = {}): ModernPullRequestReviewObservation {
  return {
    id: 1,
    reviewer: 'reviewer',
    actorType: 'human',
    state: 'approved',
    reviewedHeadSha: head,
    submittedAt: '2026-01-01T00:00:00.000Z',
    ...extra
  };
}

function gate(
  reviews: readonly ModernPullRequestReviewObservation[],
  extra: Partial<ModernPullRequestGateInput> = {}
): ModernPullRequestGateInput {
  return {
    author: 'author',
    headSha: head,
    automatedChecks: {
      status: 'passed',
      headSha: head
    },
    reviews,
    ...extra
  };
}

describe('modern profile pull request gate', () => {
  it('accepts one current independent human approval plus exact-head checks', () => {
    const result = evaluateModernPullRequestGate(teamRule, gate([review()]));
    expect(result).toEqual({
      reviewKind: 'independent-human',
      requiredHumanApprovals: 1,
      automatedChecksSatisfied: true,
      humanReviewSatisfied: true,
      satisfied: true,
      qualifyingReviewers: ['reviewer'],
      rejectedApprovals: [],
      deploymentReviewers: 'not-required',
      reasons: []
    });
  });

  it.each([
    ['self', review({ reviewer: 'AUTHOR' }), 'self-review'],
    ['bot', review({ reviewer: 'liftoff[bot]', actorType: 'bot' }), 'bot-review'],
    ['bot login', review({ reviewer: 'liftoff[bot]' }), 'bot-review'],
    ['stale', review({ reviewedHeadSha: previousHead }), 'stale-review']
  ] as const)('rejects a %s approval even when automated checks pass', (_label, observed, reason) => {
    const result = evaluateModernPullRequestGate(teamRule, gate([observed]));
    expect(result.satisfied).toBe(false);
    expect(result.automatedChecksSatisfied).toBe(true);
    expect(result.humanReviewSatisfied).toBe(false);
    expect(result.rejectedApprovals).toEqual([{ reviewer: observed.reviewer, reason }]);
    expect(result.deploymentReviewers).toBe('not-required');
  });

  it('uses the latest decisive review from each human', () => {
    const result = evaluateModernPullRequestGate(
      teamRule,
      gate([
        review({ id: 1 }),
        review({
          id: 2,
          state: 'dismissed',
          submittedAt: '2026-01-01T00:01:00.000Z'
        })
      ])
    );
    expect(result.satisfied).toBe(false);
    expect(result.rejectedApprovals).toEqual([{ reviewer: 'reviewer', reason: 'not-approved' }]);
  });

  it('uses review id as the deterministic tie-breaker and accepts 64-character object ids', () => {
    const longHead = 'c'.repeat(64);
    const result = evaluateModernPullRequestGate(teamRule, gate([
      review({ id: 1, reviewedHeadSha: longHead }),
      review({ id: 2, state: 'changes-requested', reviewedHeadSha: longHead })
    ], {
      headSha: longHead,
      automatedChecks: { status: 'passed', headSha: longHead }
    }));
    expect(result.satisfied).toBe(false);
    expect(result.rejectedApprovals).toEqual([
      { reviewer: 'reviewer', reason: 'not-approved' }
    ]);
  });

  it('requires successful automated checks on the same current head', () => {
    for (const automatedChecks of [
      { status: 'failed' as const, headSha: head },
      { status: 'pending' as const, headSha: head },
      { status: 'passed' as const, headSha: previousHead },
      { status: 'not-observed' as const, headSha: null }
    ]) {
      const result = evaluateModernPullRequestGate(teamRule, gate([review()], { automatedChecks }));
      expect(result.humanReviewSatisfied).toBe(true);
      expect(result.automatedChecksSatisfied).toBe(false);
      expect(result.satisfied).toBe(false);
    }
  });

  it('preserves single-maintainer zero-human-review semantics', () => {
    const result = evaluateModernPullRequestGate(singleRule, gate([]));
    expect(result).toMatchObject({
      reviewKind: 'automated-only',
      requiredHumanApprovals: 0,
      automatedChecksSatisfied: true,
      humanReviewSatisfied: true,
      satisfied: true,
      qualifyingReviewers: [],
      rejectedApprovals: [],
      deploymentReviewers: 'not-required'
    });
    expect(evaluateModernPullRequestGate(singleRule, gate([], {
      automatedChecks: { status: 'failed', headSha: head }
    })).satisfied).toBe(false);
  });

  it('fails malformed or fabricated review observations closed', () => {
    expect(() => evaluateModernPullRequestGate(teamRule, gate([review({ reviewer: '', actorType: 'human' })]))).toThrow(
      /non-empty/
    );
    expect(() => evaluateModernPullRequestGate(teamRule, gate([review({ reviewedHeadSha: 'short' })]))).toThrow(
      /complete 40- or 64-character/
    );
    expect(() => evaluateModernPullRequestGate(teamRule, gate([
      review({ id: 0 })
    ]))).toThrow(/positive safe integer/);
    expect(() => evaluateModernPullRequestGate(teamRule, gate([
      review({ actorType: 'service' as never })
    ]))).toThrow(/actor type/);
    expect(() => evaluateModernPullRequestGate(teamRule, gate([
      review({ state: 'commented' as never })
    ]))).toThrow(/state is unsupported/);
    expect(() => evaluateModernPullRequestGate(teamRule, gate([
      review({ submittedAt: 'not-a-date' })
    ]))).toThrow(/valid timestamp/);
    expect(() => evaluateModernPullRequestGate(teamRule, gate([], {
      automatedChecks: { status: 'unknown' as never, headSha: head }
    }))).toThrow(/status is unsupported/);
    expect(() => evaluateModernPullRequestGate(teamRule, {
      ...gate([]),
      reviews: null as never
    })).toThrow(/must be an array/);
  });
});
