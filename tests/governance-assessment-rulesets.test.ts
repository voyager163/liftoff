import { describe, expect, it } from 'vitest';
import {
  normalizeDismissalActor,
  normalizeDismissalRestriction,
  normalizeRequiredReviewer,
  normalizeRequiredReviewerActor,
  normalizeRule,
  normalizeRuleset
} from '../src/domain/governance/assessment/live-normalize.js';
import {
  arePullRequestParametersSemanticallyEqual,
  areRulesSemanticallyEqual,
  areRulesetsSemanticallyEqual,
  comparePullRequestParameters,
  isDismissalRestrictionNeutral,
  isExtraApprovalNeutral,
  isRequiredReviewersNeutral,
  reconcileRulesetSemantics,
  singleMaintainer,
  zeroReviewers
} from '../src/domain/governance/assessment/predicates.js';
import { LiveFailure } from '../src/domain/governance/assessment/errors.js';

// --- Sanitized Provider Fixtures ---

const baseSingleMaintainerParameters = {
  required_approving_review_count: 0,
  dismiss_stale_reviews_on_push: true,
  require_code_owner_review: false,
  require_last_push_approval: false,
  required_review_thread_resolution: true,
  allowed_merge_methods: ['squash']
};

/** All three GitHub defaults returned together */
const parametersAllDefaultsTogether = {
  ...baseSingleMaintainerParameters,
  dismissal_restriction: {
    enabled: false,
    allowed_actors: []
  },
  require_extra_approval_for_unattributed_changes: true,
  required_reviewers: []
};

/** Each field returned individually */
const parametersOnlyDismissalRestrictionDefault = {
  ...baseSingleMaintainerParameters,
  dismissal_restriction: {
    enabled: false,
    allowed_actors: []
  }
};

const parametersOnlyExtraApprovalDefault = {
  ...baseSingleMaintainerParameters,
  require_extra_approval_for_unattributed_changes: true
};

const parametersOnlyRequiredReviewersDefault = {
  ...baseSingleMaintainerParameters,
  required_reviewers: []
};

/** Older response omitting all optional additions */
const parametersOlderOmitted = {
  ...baseSingleMaintainerParameters
};

/** Meaningful values */
const parametersMeaningfulDismissalRestriction = {
  ...baseSingleMaintainerParameters,
  dismissal_restriction: {
    enabled: true,
    allowed_actors: [
      { id: 42, type: 'User' },
      { id: 101, type: 'Team' }
    ]
  }
};

const parametersMeaningfulRequiredReviewers = {
  ...baseSingleMaintainerParameters,
  required_reviewers: [
    {
      reviewer: { id: 77, type: 'Team' },
      minimum_approvals: 2,
      file_patterns: ['src/**/*.ts', '!src/generated/**']
    }
  ]
};

const parametersVisibilityOnlyRequiredReviewers = {
  ...baseSingleMaintainerParameters,
  required_reviewers: [
    {
      reviewer: { id: 88, type: 'Team' },
      minimum_approvals: 0,
      file_patterns: ['docs/**']
    }
  ]
};

function buildPullRequestRule(parameters: Record<string, unknown>) {
  return {
    type: 'pull_request',
    parameters
  };
}

function buildRuleset(rules: unknown[]) {
  return {
    id: 1,
    name: 'liftoff-gitflow-develop',
    target: 'branch',
    enforcement: 'active',
    source_type: 'Repository',
    source: 'octo-org/governed-repo',
    conditions: {
      ref_name: {
        include: ['refs/heads/develop'],
        exclude: []
      }
    },
    bypass_actors: [],
    rules
  };
}

describe('modernize-liftoff-platform Task 10.2: Supported pull-request field decoding for issue #82', () => {
  it('preserves the documented optional actor-list omission without inventing observations', () => {
    const omitted = { ...baseSingleMaintainerParameters, dismissal_restriction: { enabled: false } };
    expect(normalizeDismissalRestriction({ enabled: false })).toEqual({ enabled: false });
    expect(normalizeRule(buildPullRequestRule(omitted))).toEqual(buildPullRequestRule(omitted));
    expect(zeroReviewers(buildPullRequestRule(omitted))).toBe(true);
    expect(arePullRequestParametersSemanticallyEqual(omitted, parametersAllDefaultsTogether)).toBe(true);
    expect(zeroReviewers(buildPullRequestRule({
      ...baseSingleMaintainerParameters, dismissal_restriction: { enabled: true }
    }))).toBe(false);
  });

  it.each([-1, 0.5, 11, Number.MAX_SAFE_INTEGER, '0', null])(
    'rejects invalid top-level approval count %j in either comparison input',
    (count) => {
      const invalid = { ...baseSingleMaintainerParameters, required_approving_review_count: count };
      expect(() => normalizeRule(buildPullRequestRule(invalid))).toThrow(LiveFailure);
      expect(() => comparePullRequestParameters(invalid, baseSingleMaintainerParameters)).toThrow(LiveFailure);
      expect(() => comparePullRequestParameters(baseSingleMaintainerParameters, invalid)).toThrow(LiveFailure);
    }
  );

  it.each([
    { allowed_merge_methods: ['unregistered'] },
    { allowed_merge_methods: ['squash', 1] },
    { update_allows_fetch_and_merge: true },
    { dismissal_restriction: { enabled: false, allowed_actors: null } }
  ])('rejects unsupported PR parameter shapes without neutral defaults: %j', (extra) => {
    const invalid = { ...baseSingleMaintainerParameters, ...extra };
    expect(() => normalizeRule(buildPullRequestRule(invalid))).toThrow(LiveFailure);
    expect(() => comparePullRequestParameters(invalid, invalid)).toThrow(LiveFailure);
    expect(zeroReviewers(buildPullRequestRule(invalid))).toBeNull();
  });

  it('does not discard an unknown enclosing shape to compare only nested parameters', () => {
    const wrapped = { parameters: baseSingleMaintainerParameters, unrecognized_enforcement: true };
    expect(() => comparePullRequestParameters(wrapped, wrapped)).toThrow(LiveFailure);
  });

  it('compares merge-method sets without rewriting the observed order', () => {
    const observed = { ...baseSingleMaintainerParameters, allowed_merge_methods: ['squash', 'merge'] };
    const desired = { ...baseSingleMaintainerParameters, allowed_merge_methods: ['merge', 'squash'] };
    expect(comparePullRequestParameters(desired, observed).matches).toBe(true);
    expect(observed.allowed_merge_methods).toEqual(['squash', 'merge']);
    expect(normalizeRule(buildPullRequestRule(observed))).toEqual(buildPullRequestRule(desired));
  });

  it('does not disguise unexpected implementation failures as unobserved policy', () => {
    const error = new Error('unexpected getter failure');
    const input = Object.defineProperty({}, 'type', {
      enumerable: true,
      get() { throw error; }
    });
    expect(() => zeroReviewers(input)).toThrow(error);
  });

  it('normalizes all three supported defaults returned together and preserves observed values', () => {
    const raw = buildPullRequestRule(parametersAllDefaultsTogether);
    const normalized = normalizeRule(raw) as Record<string, unknown>;
    expect(normalized.type).toBe('pull_request');

    const params = normalized.parameters as Record<string, unknown>;
    expect(params.required_approving_review_count).toBe(0);
    expect(params.dismiss_stale_reviews_on_push).toBe(true);
    expect(params.require_code_owner_review).toBe(false);
    expect(params.require_last_push_approval).toBe(false);
    expect(params.require_extra_approval_for_unattributed_changes).toBe(true);
    expect(params.dismissal_restriction).toEqual({
      enabled: false,
      allowed_actors: []
    });
    expect(params.required_reviewers).toEqual([]);
  });

  it('normalizes each of the three supported additions returned individually', () => {
    // Only dismissal_restriction
    const rule1 = normalizeRule(buildPullRequestRule(parametersOnlyDismissalRestrictionDefault)) as Record<string, unknown>;
    const p1 = rule1.parameters as Record<string, unknown>;
    expect(p1.dismissal_restriction).toEqual({ enabled: false, allowed_actors: [] });
    expect(p1.require_extra_approval_for_unattributed_changes).toBeUndefined();
    expect(p1.required_reviewers).toBeUndefined();

    // Only require_extra_approval_for_unattributed_changes
    const rule2 = normalizeRule(buildPullRequestRule(parametersOnlyExtraApprovalDefault)) as Record<string, unknown>;
    const p2 = rule2.parameters as Record<string, unknown>;
    expect(p2.dismissal_restriction).toBeUndefined();
    expect(p2.require_extra_approval_for_unattributed_changes).toBe(true);
    expect(p2.required_reviewers).toBeUndefined();

    // Only required_reviewers
    const rule3 = normalizeRule(buildPullRequestRule(parametersOnlyRequiredReviewersDefault)) as Record<string, unknown>;
    const p3 = rule3.parameters as Record<string, unknown>;
    expect(p3.dismissal_restriction).toBeUndefined();
    expect(p3.require_extra_approval_for_unattributed_changes).toBeUndefined();
    expect(p3.required_reviewers).toEqual([]);
  });

  it('preserves absence when an older response omits all optional additions without inventing values', () => {
    const rule = normalizeRule(buildPullRequestRule(parametersOlderOmitted)) as Record<string, unknown>;
    const params = rule.parameters as Record<string, unknown>;
    expect(params.dismissal_restriction).toBeUndefined();
    expect(params.require_extra_approval_for_unattributed_changes).toBeUndefined();
    expect(params.required_reviewers).toBeUndefined();
    expect(params.required_approving_review_count).toBe(0);
    expect(params.dismiss_stale_reviews_on_push).toBe(true);
  });

  it('decodes and preserves meaningful dismissal restriction with enabled state and permitted actors', () => {
    const rule = normalizeRule(buildPullRequestRule(parametersMeaningfulDismissalRestriction)) as Record<string, unknown>;
    const params = rule.parameters as Record<string, unknown>;
    const dismissal = params.dismissal_restriction as { enabled: boolean; allowed_actors: { id: number; type: string }[] };
    expect(dismissal.enabled).toBe(true);
    expect(dismissal.allowed_actors).toEqual([
      { id: 101, type: 'Team' },
      { id: 42, type: 'User' }
    ]);
  });

  it('decodes and preserves meaningful required reviewers with counts and file pattern conditions', () => {
    const rule = normalizeRule(buildPullRequestRule(parametersMeaningfulRequiredReviewers)) as Record<string, unknown>;
    const params = rule.parameters as Record<string, unknown>;
    const reviewers = params.required_reviewers as Array<{
      reviewer: { id: number; type: string };
      minimum_approvals: number;
      file_patterns: string[];
    }>;
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0]!.reviewer).toEqual({ id: 77, type: 'Team' });
    expect(reviewers[0]!.minimum_approvals).toBe(2);
    // Patterns preserve sequential fnmatch order for meaningful path conditions
    expect(reviewers[0]!.file_patterns).toEqual(['src/**/*.ts', '!src/generated/**']);
  });

  it('decodes and preserves visibility-only required reviewers with zero required approvals', () => {
    const rule = normalizeRule(buildPullRequestRule(parametersVisibilityOnlyRequiredReviewers)) as Record<string, unknown>;
    const params = rule.parameters as Record<string, unknown>;
    const reviewers = params.required_reviewers as Array<{
      reviewer: { id: number; type: string };
      minimum_approvals: number;
      file_patterns: string[];
    }>;
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0]!.minimum_approvals).toBe(0);
    expect(reviewers[0]!.reviewer).toEqual({ id: 88, type: 'Team' });
    expect(reviewers[0]!.file_patterns).toEqual(['docs/**']);
  });

  it.each([
    {
      label: 'dismissal_restriction is not an object',
      parameters: { ...baseSingleMaintainerParameters, dismissal_restriction: 'none' },
      expectedError: LiveFailure
    },
    {
      label: 'dismissal_restriction.enabled is not boolean',
      parameters: { ...baseSingleMaintainerParameters, dismissal_restriction: { enabled: 'false', allowed_actors: [] } },
      expectedError: LiveFailure
    },
    {
      label: 'dismissal_restriction.allowed_actors is not an array',
      parameters: { ...baseSingleMaintainerParameters, dismissal_restriction: { enabled: false, allowed_actors: 'all' } },
      expectedError: LiveFailure
    },
    {
      label: 'dismissal_restriction.allowed_actors contains negative id',
      parameters: { ...baseSingleMaintainerParameters, dismissal_restriction: { enabled: false, allowed_actors: [{ id: -1, type: 'User' }] } },
      expectedError: LiveFailure
    },
    {
      label: 'dismissal_restriction.allowed_actors contains empty type',
      parameters: { ...baseSingleMaintainerParameters, dismissal_restriction: { enabled: false, allowed_actors: [{ id: 1, type: '' }] } },
      expectedError: LiveFailure
    },
    {
      label: 'dismissal_restriction missing enabled',
      parameters: { ...baseSingleMaintainerParameters, dismissal_restriction: { allowed_actors: [] } },
      expectedError: LiveFailure
    },
    {
      label: 'require_extra_approval_for_unattributed_changes is a string',
      parameters: { ...baseSingleMaintainerParameters, require_extra_approval_for_unattributed_changes: 'true' },
      expectedError: LiveFailure
    },
    {
      label: 'require_extra_approval_for_unattributed_changes is a number',
      parameters: { ...baseSingleMaintainerParameters, require_extra_approval_for_unattributed_changes: 1 },
      expectedError: LiveFailure
    },
    {
      label: 'required_reviewers is not an array',
      parameters: { ...baseSingleMaintainerParameters, required_reviewers: 'team-leads' },
      expectedError: LiveFailure
    },
    {
      label: 'required_reviewers minimum_approvals is negative',
      parameters: {
        ...baseSingleMaintainerParameters,
        required_reviewers: [{ reviewer: { id: 1, type: 'Team' }, minimum_approvals: -1, file_patterns: ['*'] }]
      },
      expectedError: LiveFailure
    },
    {
      label: 'required_reviewers minimum_approvals is a floating-point number',
      parameters: {
        ...baseSingleMaintainerParameters,
        required_reviewers: [{ reviewer: { id: 1, type: 'Team' }, minimum_approvals: 1.5, file_patterns: ['*'] }]
      },
      expectedError: LiveFailure
    },
    {
      label: 'required_reviewers minimum_approvals exceeds provider bound of 10',
      parameters: {
        ...baseSingleMaintainerParameters,
        required_reviewers: [{ reviewer: { id: 1, type: 'Team' }, minimum_approvals: 11, file_patterns: ['*'] }]
      },
      expectedError: LiveFailure
    },
    {
      label: 'required_reviewers collection exceeds provider bound of 15',
      parameters: {
        ...baseSingleMaintainerParameters,
        required_reviewers: Array.from({ length: 16 }, (_, i) => ({
          reviewer: { id: i + 1, type: 'Team' },
          minimum_approvals: 1,
          file_patterns: ['*']
        }))
      },
      expectedError: LiveFailure
    },
    {
      label: 'required_reviewers reviewer id is zero',
      parameters: {
        ...baseSingleMaintainerParameters,
        required_reviewers: [{ reviewer: { id: 0, type: 'Team' }, minimum_approvals: 1, file_patterns: ['*'] }]
      },
      expectedError: LiveFailure
    },
    {
      label: 'required_reviewers file_patterns contains empty string',
      parameters: {
        ...baseSingleMaintainerParameters,
        required_reviewers: [{ reviewer: { id: 1, type: 'Team' }, minimum_approvals: 1, file_patterns: [''] }]
      },
      expectedError: LiveFailure
    },
    {
      label: 'required_reviewers missing reviewer',
      parameters: {
        ...baseSingleMaintainerParameters,
        required_reviewers: [{ minimum_approvals: 1, file_patterns: ['*'] }]
      },
      expectedError: LiveFailure
    },
    {
      label: 'required_reviewers missing minimum_approvals',
      parameters: {
        ...baseSingleMaintainerParameters,
        required_reviewers: [{ reviewer: { id: 1, type: 'Team' }, file_patterns: ['*'] }]
      },
      expectedError: LiveFailure
    },
    {
      label: 'required_reviewers missing file_patterns',
      parameters: {
        ...baseSingleMaintainerParameters,
        required_reviewers: [{ reviewer: { id: 1, type: 'Team' }, minimum_approvals: 1 }]
      },
      expectedError: LiveFailure
    }
  ])('fails closed with invalid-response on malformed field shape: $label', ({ parameters, expectedError }) => {
    expect(() => normalizeRule(buildPullRequestRule(parameters))).toThrow(expectedError);
  });

  it.each([
    {
      label: 'unknown outer parameter in ruleParameters',
      parameters: { ...baseSingleMaintainerParameters, unexpected_parameter: true }
    },
    {
      label: 'unknown nested field in dismissal_restriction',
      parameters: { ...baseSingleMaintainerParameters, dismissal_restriction: { enabled: false, allowed_actors: [], unexpected_field: 'val' } }
    },
    {
      label: 'unknown nested field in dismissal actor',
      parameters: { ...baseSingleMaintainerParameters, dismissal_restriction: { enabled: false, allowed_actors: [{ id: 1, type: 'Team', extra_prop: 1 }] } }
    },
    {
      label: 'unknown nested field in required_reviewers item',
      parameters: {
        ...baseSingleMaintainerParameters,
        required_reviewers: [{ reviewer: { id: 1, type: 'Team' }, minimum_approvals: 0, file_patterns: ['*'], unexpected_key: true }]
      }
    },
    {
      label: 'unknown nested field in reviewer identity object',
      parameters: {
        ...baseSingleMaintainerParameters,
        required_reviewers: [{ reviewer: { id: 1, type: 'Team', unexpected_identity_prop: 99 }, minimum_approvals: 0, file_patterns: ['*'] }]
      }
    }
  ])('fails closed with unsupported-response on unknown enforcement field: $label', ({ parameters }) => {
    expect(() => normalizeRule(buildPullRequestRule(parameters))).toThrow(LiveFailure);
    try {
      normalizeRule(buildPullRequestRule(parameters));
    } catch (error) {
      expect((error as LiveFailure).code).toBe('unsupported-response');
    }
  });

  it('normalizes full ruleset containing pull_request rule with the additions', () => {
    const rawRuleset = buildRuleset([
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      buildPullRequestRule(parametersAllDefaultsTogether)
    ]);
    const normalized = normalizeRuleset(rawRuleset) as Record<string, unknown>;
    expect(normalized.name).toBe('liftoff-gitflow-develop');
    expect(normalized.rules).toHaveLength(3);
    const prRule = (normalized.rules as Array<Record<string, unknown>>).find((r) => r.type === 'pull_request');
    expect(prRule).toBeDefined();
    expect((prRule!.parameters as Record<string, unknown>).require_extra_approval_for_unattributed_changes).toBe(true);
  });
});

describe('modernize-liftoff-platform Task 10.3: Effective review-policy predicates for issue #82', () => {
  it('evaluates true extra-approval flag as neutral when top-level required approvals is zero', () => {
    const rules = [buildRuleset([
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      buildPullRequestRule(parametersAllDefaultsTogether),
      {
        type: 'required_status_checks',
        parameters: { strict_required_status_checks_policy: true, do_not_enforce_on_create: true, required_status_checks: [{ context: 'Verify' }] }
      }
    ])];

    const result = singleMaintainer(rules);
    expect(result.value).toBe(true);
    expect(result.reason).toBe('Observed pull request rules use zero required human reviewers.');
    expect(zeroReviewers(buildPullRequestRule(parametersAllDefaultsTogether))).toBe(true);
  });

  it('evaluates visibility-only reviewers (minimum_approvals === 0) as neutral under zero-review policy', () => {
    const rule = buildPullRequestRule(parametersVisibilityOnlyRequiredReviewers);
    expect(zeroReviewers(rule)).toBe(true);

    const rules = [buildRuleset([
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      rule,
      {
        type: 'required_status_checks',
        parameters: { strict_required_status_checks_policy: true, do_not_enforce_on_create: true, required_status_checks: [{ context: 'Verify' }] }
      }
    ])];
    expect(singleMaintainer(rules).value).toBe(true);
  });

  it('retains meaningful positive conditional reviewer requirement as requiring human approval (fails zero-review policy)', () => {
    const rule = buildPullRequestRule(parametersMeaningfulRequiredReviewers);
    expect(zeroReviewers(rule)).toBe(false);

    const rules = [buildRuleset([
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      rule,
      {
        type: 'required_status_checks',
        parameters: { strict_required_status_checks_policy: true, do_not_enforce_on_create: true, required_status_checks: [{ context: 'Verify' }] }
      }
    ])];
    const result = singleMaintainer(rules);
    expect(result.value).toBe(false);
    expect(result.reason).toBe('A pull request rule requires a human or code-owner approval.');
  });

  it('retains meaningful enabled review dismissal restriction as failing zero-review policy', () => {
    const rule = buildPullRequestRule(parametersMeaningfulDismissalRestriction);
    expect(zeroReviewers(rule)).toBe(false);

    const rules = [buildRuleset([
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      rule,
      {
        type: 'required_status_checks',
        parameters: { strict_required_status_checks_policy: true, do_not_enforce_on_create: true, required_status_checks: [{ context: 'Verify' }] }
      }
    ])];
    const result = singleMaintainer(rules);
    expect(result.value).toBe(false);
    expect(result.reason).toBe('A pull request rule requires a human or code-owner approval.');
  });

  it('honors older responses that omit the additions completely as conforming to single-maintainer', () => {
    const rule = buildPullRequestRule(parametersOlderOmitted);
    expect(zeroReviewers(rule)).toBe(true);

    const rules = [buildRuleset([
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      rule,
      {
        type: 'required_status_checks',
        parameters: { strict_required_status_checks_policy: true, do_not_enforce_on_create: true, required_status_checks: [{ context: 'Verify' }] }
      }
    ])];
    expect(singleMaintainer(rules).value).toBe(true);
  });

  it('returns false when top-level required approving review count is greater than zero regardless of extra-approval', () => {
    const ruleWithOneApproval = buildPullRequestRule({
      ...parametersAllDefaultsTogether,
      required_approving_review_count: 1
    });
    expect(zeroReviewers(ruleWithOneApproval)).toBe(false);

    const rules = [buildRuleset([ruleWithOneApproval])];
    expect(singleMaintainer(rules).value).toBe(false);
  });

  it('fails closed (returns null) on malformed or unknown fields during predicate evaluation', () => {
    // Malformed dismissal_restriction
    expect(zeroReviewers(buildPullRequestRule({
      ...baseSingleMaintainerParameters,
      dismissal_restriction: 'invalid'
    }))).toBeNull();

    // Malformed required_reviewers
    expect(zeroReviewers(buildPullRequestRule({
      ...baseSingleMaintainerParameters,
      required_reviewers: [{ minimum_approvals: -1 }]
    }))).toBeNull();
    expect(zeroReviewers(buildPullRequestRule({
      ...baseSingleMaintainerParameters,
      required_reviewers: [{ minimum_approvals: 11 }]
    }))).toBeNull();

    // Unknown parameter
    expect(zeroReviewers(buildPullRequestRule({
      ...baseSingleMaintainerParameters,
      unexpected_field: true
    }))).toBeNull();

    const rulesWithUnknown = [buildRuleset([
      buildPullRequestRule({ ...baseSingleMaintainerParameters, unexpected_field: true })
    ])];
    const result = singleMaintainer(rulesWithUnknown);
    expect(result.value).toBeNull();
    expect(result.reason).toBe('Review settings are incomplete.');
  });

  it('tests neutral predicate classification helpers directly', () => {
    expect(isDismissalRestrictionNeutral(undefined)).toBe(true);
    expect(isDismissalRestrictionNeutral(null)).toBe(true);
    expect(isDismissalRestrictionNeutral({ enabled: false, allowed_actors: [] })).toBe(true);
    expect(isDismissalRestrictionNeutral({ enabled: true, allowed_actors: [] })).toBe(false);
    expect(isDismissalRestrictionNeutral({ enabled: false, allowed_actors: [{ id: 1, type: 'Team' }] })).toBe(false);

    expect(isRequiredReviewersNeutral(undefined)).toBe(true);
    expect(isRequiredReviewersNeutral(null)).toBe(true);
    expect(isRequiredReviewersNeutral([])).toBe(true);
    expect(isRequiredReviewersNeutral([{ minimum_approvals: 0 }])).toBe(true);
    expect(isRequiredReviewersNeutral([{ minimum_approvals: 1 }])).toBe(false);

    expect(isExtraApprovalNeutral(true, 0)).toBe(true);
    expect(isExtraApprovalNeutral(false, 0)).toBe(true);
    expect(isExtraApprovalNeutral(true, 1)).toBe(false);
    expect(isExtraApprovalNeutral(false, 1)).toBe(true);
    expect(isExtraApprovalNeutral(undefined, 1)).toBe(true);
  });
});

describe('modernize-liftoff-platform Task 10.4: Normalization consistency across assessment, planning, and readback', () => {
  it('yields zero-write reconciliation when live GitHub ruleset includes neutral defaults omitted by desired plan', () => {
    const desiredRuleset = buildRuleset([
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      buildPullRequestRule(parametersOlderOmitted) // omits the three new fields
    ]);

    const liveObservedRuleset = buildRuleset([
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      buildPullRequestRule(parametersAllDefaultsTogether) // has the 3 neutral defaults
    ]);

    // Semantic comparison verifies they are equivalent under GitHub semantics
    expect(areRulesetsSemanticallyEqual(desiredRuleset, liveObservedRuleset)).toBe(true);

    const reconciliation = reconcileRulesetSemantics(desiredRuleset, liveObservedRuleset);
    expect(reconciliation.requiresWrite).toBe(false);
    expect(reconciliation.differences).toHaveLength(0);
  });

  it('detects drift and requires write when live ruleset has meaningful dismissal restrictions', () => {
    const desiredRuleset = buildRuleset([
      { type: 'deletion' },
      buildPullRequestRule(parametersOlderOmitted)
    ]);

    const liveRulesetWithDismissal = buildRuleset([
      { type: 'deletion' },
      buildPullRequestRule(parametersMeaningfulDismissalRestriction)
    ]);

    expect(areRulesetsSemanticallyEqual(desiredRuleset, liveRulesetWithDismissal)).toBe(false);

    const reconciliation = reconcileRulesetSemantics(desiredRuleset, liveRulesetWithDismissal);
    expect(reconciliation.requiresWrite).toBe(true);
    expect(reconciliation.differences.some((d) => d.includes('dismissal_restriction'))).toBe(true);
  });

  it('detects drift and requires write when live ruleset has positive conditional reviewer requirement', () => {
    const desiredRuleset = buildRuleset([
      { type: 'deletion' },
      buildPullRequestRule(parametersOlderOmitted)
    ]);

    const liveRulesetWithReviewers = buildRuleset([
      { type: 'deletion' },
      buildPullRequestRule(parametersMeaningfulRequiredReviewers)
    ]);

    expect(areRulesetsSemanticallyEqual(desiredRuleset, liveRulesetWithReviewers)).toBe(false);

    const reconciliation = reconcileRulesetSemantics(desiredRuleset, liveRulesetWithReviewers);
    expect(reconciliation.requiresWrite).toBe(true);
    expect(reconciliation.differences.some((d) => d.includes('required_reviewers'))).toBe(true);
  });

  it('detects drift when top-level required approving reviews differ', () => {
    const desiredRuleset = buildRuleset([
      buildPullRequestRule(parametersOlderOmitted) // count = 0
    ]);

    const liveRuleset = buildRuleset([
      buildPullRequestRule({ ...parametersOlderOmitted, required_approving_review_count: 2 })
    ]);

    expect(areRulesetsSemanticallyEqual(desiredRuleset, liveRuleset)).toBe(false);

    const reconciliation = reconcileRulesetSemantics(desiredRuleset, liveRuleset);
    expect(reconciliation.requiresWrite).toBe(true);
    expect(reconciliation.differences.some((d) => d.includes('required_approving_review_count'))).toBe(true);
  });

  it('compares pull request parameters directly and details exact differences', () => {
    const desired = parametersOlderOmitted;
    const observedMatching = parametersAllDefaultsTogether;
    expect(arePullRequestParametersSemanticallyEqual(desired, observedMatching)).toBe(true);
    expect(comparePullRequestParameters(desired, observedMatching)).toEqual({
      matches: true,
      differences: []
    });

    const observedDiffering = {
      ...parametersAllDefaultsTogether,
      dismiss_stale_reviews_on_push: false,
      require_code_owner_review: true
    };
    const diffResult = comparePullRequestParameters(desired, observedDiffering);
    expect(diffResult.matches).toBe(false);
    expect(diffResult.differences).toContain('dismiss_stale_reviews_on_push: desired true, observed false');
    expect(diffResult.differences).toContain('require_code_owner_review: desired false, observed true');
  });

  it('preserves historical observation serialization meaning without retagging or injecting fields', () => {
    const olderRule = buildPullRequestRule(parametersOlderOmitted);
    const normalizedOlder = normalizeRule(olderRule) as Record<string, unknown>;

    // Serialized output must not contain injected keys
    const serializedOlder = JSON.stringify(normalizedOlder);
    expect(serializedOlder).not.toContain('dismissal_restriction');
    expect(serializedOlder).not.toContain('require_extra_approval_for_unattributed_changes');
    expect(serializedOlder).not.toContain('required_reviewers');

    // New observation retains all three
    const currentRule = buildPullRequestRule(parametersAllDefaultsTogether);
    const normalizedCurrent = normalizeRule(currentRule) as Record<string, unknown>;
    const serializedCurrent = JSON.stringify(normalizedCurrent);
    expect(serializedCurrent).toContain('dismissal_restriction');
    expect(serializedCurrent).toContain('require_extra_approval_for_unattributed_changes');
    expect(serializedCurrent).toContain('required_reviewers');
  });

  it('fails closed and blocks plans/readback when desired or observed is unknown or malformed', () => {
    const valid = parametersAllDefaultsTogether;
    const unknownParam = { ...baseSingleMaintainerParameters, future_gate: true };
    const malformedParam = { ...baseSingleMaintainerParameters, required_approving_review_count: -1 };

    // comparePullRequestParameters blocks on unknown/malformed desired
    expect(() => comparePullRequestParameters(unknownParam, valid)).toThrow(LiveFailure);
    expect(() => comparePullRequestParameters(malformedParam, valid)).toThrow(LiveFailure);

    // comparePullRequestParameters blocks on unknown/malformed observed
    expect(() => comparePullRequestParameters(valid, unknownParam)).toThrow(LiveFailure);
    expect(() => comparePullRequestParameters(valid, malformedParam)).toThrow(LiveFailure);

    // areRulesSemanticallyEqual blocks
    expect(() => areRulesSemanticallyEqual(buildPullRequestRule(unknownParam), buildPullRequestRule(valid))).toThrow(LiveFailure);
    expect(() => areRulesSemanticallyEqual(buildPullRequestRule(valid), buildPullRequestRule(unknownParam))).toThrow(LiveFailure);
    expect(() => areRulesSemanticallyEqual(buildPullRequestRule(malformedParam), buildPullRequestRule(valid))).toThrow(LiveFailure);

    // areRulesetsSemanticallyEqual blocks
    const validRuleset = buildRuleset([buildPullRequestRule(valid)]);
    const unknownRuleset = buildRuleset([buildPullRequestRule(unknownParam)]);
    const malformedRuleset = buildRuleset([buildPullRequestRule(malformedParam)]);
    const unknownEnforceRuleset = { ...validRuleset, enforcement: 'unknown_enforce' };
    expect(() => areRulesetsSemanticallyEqual(unknownRuleset, validRuleset)).toThrow(LiveFailure);
    expect(() => areRulesetsSemanticallyEqual(validRuleset, unknownRuleset)).toThrow(LiveFailure);
    expect(() => areRulesetsSemanticallyEqual(malformedRuleset, validRuleset)).toThrow(LiveFailure);
    expect(() => areRulesetsSemanticallyEqual(unknownEnforceRuleset, validRuleset)).toThrow(LiveFailure);

    // reconcileRulesetSemantics blocks on invalid/unknown, never guess-repairs with requiresWrite: true
    expect(() => reconcileRulesetSemantics(unknownRuleset, validRuleset)).toThrow(LiveFailure);
    expect(() => reconcileRulesetSemantics(validRuleset, unknownRuleset)).toThrow(LiveFailure);
    expect(() => reconcileRulesetSemantics(malformedRuleset, validRuleset)).toThrow(LiveFailure);
    expect(() => reconcileRulesetSemantics(unknownEnforceRuleset, validRuleset)).toThrow(LiveFailure);
  });

  it('detects differences when allowed_merge_methods is supplied by only one side', () => {
    const withMethods = { ...baseSingleMaintainerParameters, allowed_merge_methods: ['squash'] };
    const { allowed_merge_methods: _, ...withoutMethods } = baseSingleMaintainerParameters;

    // Desired has it, observed omits it
    const diff1 = comparePullRequestParameters(withMethods, withoutMethods);
    expect(diff1.matches).toBe(false);
    expect(diff1.differences.some((d) => d.includes('allowed_merge_methods'))).toBe(true);

    // Observed has it, desired omits it
    const diff2 = comparePullRequestParameters(withoutMethods, withMethods);
    expect(diff2.matches).toBe(false);
    expect(diff2.differences.some((d) => d.includes('allowed_merge_methods'))).toBe(true);
  });

  it('strictly validates mandatory pull_request fields and rejects missing fields', () => {
    // Missing required_approving_review_count
    const { required_approving_review_count: _1, ...noCount } = baseSingleMaintainerParameters;
    expect(() => normalizeRule(buildPullRequestRule(noCount))).toThrow(LiveFailure);

    // Missing dismiss_stale_reviews_on_push
    const { dismiss_stale_reviews_on_push: _2, ...noStale } = baseSingleMaintainerParameters;
    expect(() => normalizeRule(buildPullRequestRule(noStale))).toThrow(LiveFailure);

    // Missing require_code_owner_review
    const { require_code_owner_review: _3, ...noOwner } = baseSingleMaintainerParameters;
    expect(() => normalizeRule(buildPullRequestRule(noOwner))).toThrow(LiveFailure);

    // Missing require_last_push_approval
    const { require_last_push_approval: _4, ...noPush } = baseSingleMaintainerParameters;
    expect(() => normalizeRule(buildPullRequestRule(noPush))).toThrow(LiveFailure);

    // pull_request rule missing parameters object completely
    expect(() => normalizeRule({ type: 'pull_request' })).toThrow(LiveFailure);
  });

  it('rejects count values that are negative, fractional, or exceed bounds', () => {
    // required_approving_review_count negative
    expect(() => normalizeRule(buildPullRequestRule({
      ...baseSingleMaintainerParameters,
      required_approving_review_count: -1
    }))).toThrow(LiveFailure);

    // required_approving_review_count fractional
    expect(() => normalizeRule(buildPullRequestRule({
      ...baseSingleMaintainerParameters,
      required_approving_review_count: 2.5
    }))).toThrow(LiveFailure);

    // minimum_approvals negative
    expect(() => normalizeRule(buildPullRequestRule({
      ...baseSingleMaintainerParameters,
      required_reviewers: [{ reviewer: { id: 1, type: 'Team' }, minimum_approvals: -1, file_patterns: ['*'] }]
    }))).toThrow(LiveFailure);

    // minimum_approvals fractional
    expect(() => normalizeRule(buildPullRequestRule({
      ...baseSingleMaintainerParameters,
      required_reviewers: [{ reviewer: { id: 1, type: 'Team' }, minimum_approvals: 0.5, file_patterns: ['*'] }]
    }))).toThrow(LiveFailure);

    // minimum_approvals > 10 (exceeds provider bound)
    expect(() => normalizeRule(buildPullRequestRule({
      ...baseSingleMaintainerParameters,
      required_reviewers: [{ reviewer: { id: 1, type: 'Team' }, minimum_approvals: 11, file_patterns: ['*'] }]
    }))).toThrow(LiveFailure);
  });

  it('rejects unknown nested actor types outside authoritative documented schemas', () => {
    // dismissal actor type outside ["User", "Team", "IntegrationInstallation", "RepositoryRole"]
    expect(() => normalizeRule(buildPullRequestRule({
      ...baseSingleMaintainerParameters,
      dismissal_restriction: { enabled: true, allowed_actors: [{ id: 1, type: 'Robot' }] }
    }))).toThrow(LiveFailure);

    // reviewer type outside ["Team"]
    expect(() => normalizeRule(buildPullRequestRule({
      ...baseSingleMaintainerParameters,
      required_reviewers: [{ reviewer: { id: 1, type: 'User' }, minimum_approvals: 1, file_patterns: ['*'] }]
    }))).toThrow(LiveFailure);
  });

  it('rejects PR parameters on non-PR rules (fail closed)', () => {
    // deletion rule with dismissal_restriction
    expect(() => normalizeRule({
      type: 'deletion',
      parameters: { dismissal_restriction: { enabled: false, allowed_actors: [] } }
    })).toThrow(LiveFailure);

    // deletion rule with require_extra_approval_for_unattributed_changes
    expect(() => normalizeRule({
      type: 'deletion',
      parameters: { require_extra_approval_for_unattributed_changes: true }
    })).toThrow(LiveFailure);

    // required_status_checks rule with required_reviewers
    expect(() => normalizeRule({
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: true,
        required_status_checks: [{ context: 'CI' }],
        required_reviewers: []
      }
    })).toThrow(LiveFailure);

    // non_fast_forward rule with dismissal_restriction
    expect(() => normalizeRule({
      type: 'non_fast_forward',
      parameters: { dismissal_restriction: { enabled: true, allowed_actors: [{ id: 1, type: 'Team' }] } }
    })).toThrow(LiveFailure);
  });

  it('covers all semantic comparison branches and edge cases', () => {
    // comparePullRequestParameters invalid inputs
    expect(() => comparePullRequestParameters(null, {})).toThrow(LiveFailure);
    expect(() => comparePullRequestParameters({}, null)).toThrow(LiveFailure);

    // required_review_thread_resolution differs
    const resDiff = comparePullRequestParameters(
      { ...baseSingleMaintainerParameters, required_review_thread_resolution: true },
      { ...baseSingleMaintainerParameters, required_review_thread_resolution: false }
    );
    expect(resDiff.matches).toBe(false);
    expect(resDiff.differences).toContain('required_review_thread_resolution: desired true, observed false');

    // allowed_merge_methods differ
    const mergeDiff = comparePullRequestParameters(
      { ...baseSingleMaintainerParameters, allowed_merge_methods: ['merge'] },
      { ...baseSingleMaintainerParameters, allowed_merge_methods: ['squash'] }
    );
    expect(mergeDiff.matches).toBe(false);
    expect(mergeDiff.differences.some((d) => d.includes('allowed_merge_methods'))).toBe(true);

    // extra approval differs when required approvals > 0
    const extraDiff = comparePullRequestParameters(
      { ...baseSingleMaintainerParameters, required_approving_review_count: 1, require_extra_approval_for_unattributed_changes: true },
      { ...baseSingleMaintainerParameters, required_approving_review_count: 1, require_extra_approval_for_unattributed_changes: false }
    );
    expect(extraDiff.matches).toBe(false);
    expect(extraDiff.differences).toContain('require_extra_approval_for_unattributed_changes: desired true, observed false');

    // dismissal_restriction enabled differs when both non-neutral
    const disEnDiff = comparePullRequestParameters(
      { ...baseSingleMaintainerParameters, dismissal_restriction: { enabled: true, allowed_actors: [{ id: 1, type: 'Team' }] } },
      { ...baseSingleMaintainerParameters, dismissal_restriction: { enabled: false, allowed_actors: [{ id: 1, type: 'Team' }] } }
    );
    expect(disEnDiff.matches).toBe(false);
    expect(disEnDiff.differences).toContain('dismissal_restriction.enabled: desired true, observed false');

    // dismissal_restriction allowed_actors differ
    const disActorDiff = comparePullRequestParameters(
      { ...baseSingleMaintainerParameters, dismissal_restriction: { enabled: true, allowed_actors: [{ id: 1, type: 'Team' }] } },
      { ...baseSingleMaintainerParameters, dismissal_restriction: { enabled: true, allowed_actors: [{ id: 2, type: 'Team' }] } }
    );
    expect(disActorDiff.matches).toBe(false);
    expect(disActorDiff.differences.some((d) => d.includes('dismissal_restriction.allowed_actors'))).toBe(true);

    // required_reviewers differ when both non-empty
    const revDiff = comparePullRequestParameters(
      { ...baseSingleMaintainerParameters, required_reviewers: [{ reviewer: { id: 1, type: 'Team' }, minimum_approvals: 1, file_patterns: ['*'] }] },
      { ...baseSingleMaintainerParameters, required_reviewers: [{ reviewer: { id: 2, type: 'Team' }, minimum_approvals: 1, file_patterns: ['*'] }] }
    );
    expect(revDiff.matches).toBe(false);
    expect(revDiff.differences.some((d) => d.includes('required_reviewers'))).toBe(true);

    // areRulesSemanticallyEqual non-record inputs fail closed
    expect(() => areRulesSemanticallyEqual(null, {})).toThrow(LiveFailure);
    expect(() => areRulesSemanticallyEqual({}, null)).toThrow(LiveFailure);
    expect(areRulesSemanticallyEqual({ type: 'deletion' }, { type: 'non_fast_forward' })).toBe(false);

    // areRulesSemanticallyEqual non-PR rules
    expect(areRulesSemanticallyEqual({ type: 'deletion' }, { type: 'deletion' })).toBe(true);
    expect(areRulesSemanticallyEqual(
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'CI', integration_id: null }] } },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'CI', integration_id: null }] } }
    )).toBe(true);
    expect(areRulesSemanticallyEqual(
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'CI', integration_id: null }] } },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Security', integration_id: null }] } }
    )).toBe(false);

    // areRulesetsSemanticallyEqual edge cases
    expect(() => areRulesetsSemanticallyEqual(null, {})).toThrow(LiveFailure);
    expect(() => areRulesetsSemanticallyEqual({}, null)).toThrow(LiveFailure);
    const baseR = buildRuleset([{ type: 'deletion' }]);
    expect(areRulesetsSemanticallyEqual(baseR, { ...baseR, name: 'other-name' })).toBe(false);
    expect(areRulesetsSemanticallyEqual(baseR, { ...baseR, target: 'tag' })).toBe(false);
    expect(areRulesetsSemanticallyEqual(baseR, { ...baseR, enforcement: 'disabled' })).toBe(false);
    expect(areRulesetsSemanticallyEqual(baseR, { ...baseR, conditions: { ref_name: { include: ['~ALL'], exclude: [] } } })).toBe(false);
    expect(areRulesetsSemanticallyEqual(baseR, { ...baseR, bypass_actors: [{ actor_id: 1, actor_type: 'Integration', bypass_mode: 'always' }] })).toBe(false);
    expect(areRulesetsSemanticallyEqual(baseR, { ...baseR, rules: [] })).toBe(false);
    expect(areRulesetsSemanticallyEqual(baseR, { ...baseR, rules: [{ type: 'non_fast_forward' }] })).toBe(false);

    // reconcileRulesetSemantics edge cases
    expect(() => reconcileRulesetSemantics(null, {})).toThrow(LiveFailure);
    expect(() => reconcileRulesetSemantics({}, null)).toThrow(LiveFailure);

    // PR rule presence differs
    const withPR = buildRuleset([buildPullRequestRule(baseSingleMaintainerParameters)]);
    const withoutPR = buildRuleset([{ type: 'deletion' }]);
    expect(reconcileRulesetSemantics(withPR, withoutPR)).toEqual({
      requiresWrite: true,
      differences: ['pull_request rule presence differs']
    });

    // Non-PR rule differs while PR rule matches
    const rA = buildRuleset([{ type: 'deletion' }, buildPullRequestRule(baseSingleMaintainerParameters)]);
    const rB = buildRuleset([{ type: 'non_fast_forward' }, buildPullRequestRule(baseSingleMaintainerParameters)]);
    const diffNonPR = reconcileRulesetSemantics(rA, rB);
    expect(diffNonPR.requiresWrite).toBe(true);
    expect(diffNonPR.differences).toContain('Ruleset target, enforcement, conditions, bypass actors, or non-PR rules differ');
  });
});
