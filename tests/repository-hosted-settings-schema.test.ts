import { describe, expect, it } from 'vitest';
import {
  validateActionsPayload, validateBranchRulesetPayload, validateImmutableReleaseEnablement,
  type BranchPayloadExpectation
} from '../scripts/repository-security/hosted-settings-schema.ts';

function fixture() {
  const expected: BranchPayloadExpectation = {
    branch: 'main', checks: [{ context: 'synthetic-contract-check', integration_id: 123 }],
    mergeMethods: ['squash', 'rebase'], linearHistory: true,
    codeScanningTools: [{ tool: 'CodeQL', alerts_threshold: 'none', security_alerts_threshold: 'high_or_higher' }]
  };
  const payload = {
    name: 'Synthetic data only', target: 'branch', enforcement: 'active', bypass_actors: [],
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [
      { type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'required_linear_history' },
      { type: 'pull_request', parameters: {
        allowed_merge_methods: ['squash', 'rebase'], dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false, require_last_push_approval: false,
        required_approving_review_count: 0, required_review_thread_resolution: true
      } },
      { type: 'required_status_checks', parameters: {
        required_status_checks: structuredClone(expected.checks),
        strict_required_status_checks_policy: true, do_not_enforce_on_create: false
      } },
      { type: 'code_scanning', parameters: { code_scanning_tools: structuredClone(expected.codeScanningTools) } }
    ]
  };
  return { expected, payload };
}

describe('endpoint-specific data contracts without activation authority', () => {
  it('uses real POST/ruleset and bodyless PUT/immutable endpoint shapes, not the simulation registry as capability proof', () => {
    const f = fixture();
    expect(validateBranchRulesetPayload(f.payload, f.expected)).toMatchObject({
      method: 'POST', endpoint: '/repos/voyager163/liftoff/rulesets',
      applyAuthorized: false, capabilityQualified: false, checkBehaviorQualified: false, liveEffects: false
    });
    expect(validateImmutableReleaseEnablement(null)).toMatchObject({
      method: 'PUT', endpoint: '/repos/voyager163/liftoff/immutable-releases', payload: null, applyAuthorized: false
    });
    expect(() => validateImmutableReleaseEnablement({ enabled: true })).toThrow('bodyless');
  });
  it.each(['update', 'creation', 'required_signatures', 'merge_queue', 'unknown'])('rejects the %s branch rule rather than locking or expanding the contract', type => {
    const f = fixture(); f.payload.rules.push({ type });
    expect(() => validateBranchRulesetPayload(f.payload, f.expected)).toThrow('unsupported-or-locking-rule');
  });
  it.each([
    { require_code_owner_review: true }, { require_last_push_approval: true },
    { required_approving_review_count: 1 }, { required_review_thread_resolution: false },
    { allowed_merge_methods: ['merge'] }, { required_reviewers: [] }
  ])('rejects an additional review gate, lost conversation resolution or unsupported field', change => {
    const f = fixture();
    Object.assign(f.payload.rules.find(rule => rule.type === 'pull_request')!.parameters!, change);
    expect(() => validateBranchRulesetPayload(f.payload, f.expected)).toThrow();
  });
  it('rejects bypasses, wildcard targets, evaluate mode, duplicates and lost existing linear-history protection', () => {
    for (const change of [
      { bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' }] },
      { conditions: { ref_name: { include: ['~ALL'], exclude: [] } } },
      { enforcement: 'evaluate' }, { target: 'tag' }
    ]) {
      const f = fixture();
      expect(() => validateBranchRulesetPayload({ ...f.payload, ...change }, f.expected)).toThrow();
    }
    const f = fixture();
    expect(() => validateBranchRulesetPayload(f.payload, { ...f.expected, linearHistory: false })).toThrow();
    f.payload.rules.pop();
    expect(() => validateBranchRulesetPayload(f.payload, f.expected)).toThrow('incomplete-rule-set');
    f.payload.rules.push(f.payload.rules[0]!);
    expect(() => validateBranchRulesetPayload(f.payload, f.expected)).toThrow('duplicate-identity');
  });
  it.each([
    { required_status_checks: [{ context: 'synthetic-contract-check' }] },
    { required_status_checks: [{ context: 'synthetic-contract-check', integration_id: 456 }] },
    { required_status_checks: [] }, { strict_required_status_checks_policy: false }, { do_not_enforce_on_create: true }
  ])('rejects missing/wrong Apps, missing checks and relaxed strictness', change => {
    const f = fixture();
    Object.assign(f.payload.rules.find(rule => rule.type === 'required_status_checks')!.parameters!, change);
    expect(() => validateBranchRulesetPayload(f.payload, f.expected)).toThrow();
  });
  it.each(['none', 'critical', 'unknown'])('rejects %s as a weakening of the high/critical native finding contract', threshold => {
    const f = fixture();
    Object.assign(f.payload.rules.find(rule => rule.type === 'code_scanning')!.parameters!, {
      code_scanning_tools: [{ tool: 'CodeQL', alerts_threshold: 'none', security_alerts_threshold: threshold }]
    });
    expect(() => validateBranchRulesetPayload(f.payload, f.expected)).toThrow();
  });
  it('requires explicit selected full-SHA actions and read-only tokens without bot approval', () => {
    const action = `actions/checkout@${'a'.repeat(40)}`;
    expect(validateActionsPayload('permissions', { enabled: true, allowed_actions: 'selected', sha_pinning_required: true }).applyAuthorized).toBe(false);
    expect(validateActionsPayload('workflow', { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false }).liveEffects).toBe(false);
    expect(validateActionsPayload('selected-actions', {
      github_owned_allowed: false, verified_allowed: false, patterns_allowed: [action]
    }, [action]).capabilityQualified).toBe(false);
    for (const reference of ['actions/*', 'actions/checkout@v7', 'actions/checkout@*']) {
      expect(() => validateActionsPayload('selected-actions', {
        github_owned_allowed: false, verified_allowed: false, patterns_allowed: [reference]
      }, [reference])).toThrow();
    }
    expect(() => validateActionsPayload('workflow', { default_workflow_permissions: 'write', can_approve_pull_request_reviews: false })).toThrow();
    expect(() => validateActionsPayload('workflow', { default_workflow_permissions: 'read', can_approve_pull_request_reviews: true })).toThrow();
    expect(() => validateActionsPayload('selected-actions', {
      github_owned_allowed: true, verified_allowed: false, patterns_allowed: [action]
    }, [action])).toThrow();
  });
});
