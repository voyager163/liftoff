import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessGovernance } from '../src/governance-assessment/engine.js';
import * as liveModule from '../src/governance-assessment/live.js';
import { observed, source } from '../src/domain/governance/assessment/sanitize.js';
import type { AssessmentProfile, JsonValue } from '../src/governance-assessment/types.js';
import { effectiveProtectedRefs } from '../src/domain/governance/assessment/predicates.js';
import { freshManifestFixture, inventory } from './fixtures/manifest-update.js';

afterEach(() => vi.restoreAllMocks());

function classic(approvals: number, stronger = false, forcePush = false) {
  return {
    allow_force_pushes: { enabled: forcePush },
    allow_deletions: { enabled: false },
    required_status_checks: { strict: true, contexts: ['CI'], checks: [{ context: 'CI', app_id: 15368 }] },
    required_pull_request_reviews: {
      required_approving_review_count: approvals,
      require_code_owner_reviews: stronger,
      require_last_push_approval: stronger,
      dismiss_stale_reviews: true
    }
  };
}

function scopedRules(profile: AssessmentProfile): JsonValue {
  const rules: JsonValue = [{
    target: 'branch', enforcement: 'active', bypass_actors: [],
    conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
    rules: [
      { type: 'deletion' }, { type: 'non_fast_forward' },
      { type: 'pull_request', parameters: {
        required_approving_review_count: profile === 'team-gitflow' ? 1 : 0,
        require_code_owner_review: false, require_last_push_approval: false,
        dismiss_stale_reviews_on_push: true
      } },
      { type: 'required_status_checks', parameters: {
        strict_required_status_checks_policy: true, do_not_enforce_on_create: true,
        required_status_checks: [{ context: 'CI', integration_id: 15368 }]
      } }
    ]
  }];
  return rules;
}

function branches<T>(protection: T) {
  return ['main', 'develop'].map(name => ({
    name, protected: true, protectionObserved: true,
    protection: { classic: protection, effectiveRules: [] }
  }));
}

async function finding(profile: AssessmentProfile, protection: ReturnType<typeof classic>) {
  const project = await freshManifestFixture(profile, 'manual');
  const rules = scopedRules(profile);
  const observedBranches = branches(protection);
  const families = { complete: true, prefixes: ['release/', 'hotfix/'], refs: [] };
  const capturedAt = '2026-09-05T00:00:00.000Z';
  const origin = source('github', 'isolated protection observation', capturedAt, { rules, branches: observedBranches, families });
  const collector = vi.spyOn(liveModule, 'collectLiveAssessment').mockResolvedValue({
    observations: {
      'github.repository': observed({ defaultBranch: 'main' }, origin),
      'github.rulesets': observed(rules, origin),
      'github.branches': observed(observedBranches, origin),
      'github.ref-families': observed(families, origin)
    },
    diagnostics: [], refsStable: true
  });
  const before = await inventory(project.root);
  const report = await assessGovernance(project.root, {
    live: true, now: () => new Date(capturedAt),
    runner: { run: async () => { throw new Error('Injected protection must not execute provider commands.'); } }
  });
  expect(collector).toHaveBeenCalledOnce();
  expect(report.outcome).not.toBe('aligned');
  expect(report.coverage.unsupported).toBeGreaterThan(0);
  expect(await inventory(project.root)).toEqual(before);
  const target = report.findings.find(item => item.controlId === 'gitflow.protected-refs');
  expect(target).toBeDefined();
  return target?.observations.live;
}

describe('profile-bound classic protection assessment', () => {
  it('retains zero-review classic protection alongside scoped team rules', async () => {
    expect(await finding('team-gitflow', classic(0))).toMatchObject({ availability: 'observed', value: true });
  });
  it('accepts current team classic approval rather than applying the single-maintainer zero-review target', async () => {
    expect(await finding('team-gitflow', classic(1))).toMatchObject({ availability: 'observed', value: true });
  });
  it('preserves stronger team classic approval, code-owner and last-push protection', async () => {
    expect(await finding('team-gitflow', classic(2, true))).toMatchObject({ availability: 'observed', value: true });
  });
  it('retains the single-maintainer human-review contradiction', async () => {
    expect(await finding('single-maintainer-gitflow', classic(1))).toMatchObject({ availability: 'observed', value: false });
  });
  it('retains the team force-push contradiction', async () => {
    expect(await finding('team-gitflow', classic(2, true, true))).toMatchObject({ availability: 'observed', value: false });
  });

  it.each([
    ['deletion', { ...classic(2, true), allow_deletions: { enabled: true } }, false],
    ['empty checks', { ...classic(2, true), required_status_checks: { strict: true, contexts: [], checks: [] } }, false],
    ['non-strict checks', { ...classic(2, true), required_status_checks: { strict: false, contexts: ['CI'], checks: [] } }, null],
    ['stale approvals', { ...classic(2, true), required_pull_request_reviews: {
      ...classic(2, true).required_pull_request_reviews, dismiss_stale_reviews: false
    } }, false],
    ['missing review metadata', { ...classic(2, true), required_pull_request_reviews: {} }, null],
    ['absent review protection', { ...classic(2, true), required_pull_request_reviews: null }, false],
    ['fractional approval count', classic(0.5), null],
    ['negative approval count', classic(-1), null]
  ])('preserves the team %s refusal', (_name, protection, expected) => {
    expect(effectiveProtectedRefs(scopedRules('team-gitflow'), branches(protection), {
      complete: true, prefixes: ['release/', 'hotfix/'], refs: []
    }, 'main', 'team-gitflow').value).toBe(expected);
  });

  it('retains ruleset-only team protection when classic protection is absent', () => {
    expect(effectiveProtectedRefs(scopedRules('team-gitflow'), branches(null), {
      complete: true, prefixes: ['release/', 'hotfix/'], refs: []
    }, 'main', 'team-gitflow').value).toBe(true);
  });

  it('preserves the default single-maintainer zero-review behavior', () => {
    expect(effectiveProtectedRefs(scopedRules('single-maintainer-gitflow'), branches(classic(0)), {
      complete: true, prefixes: ['release/', 'hotfix/'], refs: []
    }, 'main').value).toBe(true);
    expect(effectiveProtectedRefs(scopedRules('single-maintainer-gitflow'), branches(classic(0, true)), {
      complete: true, prefixes: ['release/', 'hotfix/'], refs: []
    }, 'main').value).toBe(false);
  });

  it('does not treat stronger classic review as missing scoped team protection', () => {
    expect(effectiveProtectedRefs([], branches(classic(2, true)), {
      complete: true, prefixes: ['release/', 'hotfix/'], refs: []
    }, 'main', 'team-gitflow').value).toBe(false);
  });

  it('does not adopt incomplete team family enumeration', () => {
    expect(effectiveProtectedRefs(scopedRules('team-gitflow'), branches(classic(2, true)), {
      complete: false, prefixes: ['release/', 'hotfix/'], refs: []
    }, 'main', 'team-gitflow').value).toBeNull();
  });

  it('does not adopt incomplete effective team rules', () => {
    expect(effectiveProtectedRefs(scopedRules('team-gitflow'), branches(classic(2, true)).map(branch => ({
      ...branch, protection: { classic: classic(2, true) }
    })), {
      complete: true, prefixes: ['release/', 'hotfix/'], refs: []
    }, 'main', 'team-gitflow').value).toBeNull();
  });
});
