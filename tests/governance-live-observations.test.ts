import { describe, expect, it } from 'vitest';
import {
  isLiveMetadataEvaluator, liveMetadataEvaluators, observeLiveGovernanceControl
} from '../src/domain/governance/assessment/live-observations.js';
import { notObserved, observed, source } from '../src/domain/governance/assessment/sanitize.js';
import type { AssessmentProfile, JsonValue, LiveAssessmentResult } from '../src/domain/governance/assessment/types.js';

const capturedAt = '2026-10-20T06:00:00.000Z';
const profiles = ['single-maintainer-gitflow', 'team-gitflow'] as const;
function fixture(profile: AssessmentProfile): LiveAssessmentResult {
  const rules: JsonValue[] = [
    { type: 'deletion' }, { type: 'non_fast_forward' },
    { type: 'pull_request', parameters: {
      required_approving_review_count: profile === 'team-gitflow' ? 1 : 0,
      require_code_owner_review: false, require_last_push_approval: false, dismiss_stale_reviews_on_push: true
    } },
    { type: 'required_status_checks', parameters: {
      strict_required_status_checks_policy: true, do_not_enforce_on_create: true,
      required_status_checks: [{ context: 'qualified-test', integration_id: 7 }]
    } }
  ];
  const branch = {
    target: 'branch', enforcement: 'active', bypass_actors: [], rules,
    conditions: { ref_name: { include: [
      'refs/heads/develop', 'refs/heads/main', 'refs/heads/release/**', 'refs/heads/hotfix/**'
    ], exclude: [] } }
  };
  const values: Record<string, JsonValue> = {
    'github.repository': { defaultBranch: 'develop' },
    'github.rulesets': [branch, {
      target: 'tag', enforcement: 'active',
      conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
      bypass_actors: [{ actor_type: 'Integration', actor_id: 7 }], rules: [{ type: 'creation' }]
    }, {
      target: 'tag', enforcement: 'active',
      conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
      bypass_actors: [], rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }]
    }],
    'github.branches': ['develop', 'main', 'release/1.0', 'hotfix/1.0'].map(name => ({
      name, protected: true, protectionObserved: true, protection: { classic: null, effectiveRules: branch.rules }
    })),
    'github.ref-families': { complete: true, prefixes: ['release/', 'hotfix/'], refs: ['release/1.0', 'hotfix/1.0'] },
    'github.actions-app': { id: 7, slug: 'github-actions' },
    'github.security': { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } },
    'github.environments': [{ name: 'dev', reviewers: 0 }]
  };
  return {
    observations: Object.fromEntries(Object.entries(values).map(([key, value]) =>
      [key, observed(value, source('github', `https://api.github.com/example/${key}`, capturedAt, value))])),
    diagnostics: [], refsStable: true
  };
}

describe('shared live governance metadata observations', () => {
  it('selects only the finite metadata evaluators, not execution or custody proof', () => {
    for (const evaluator of liveMetadataEvaluators) expect(isLiveMetadataEvaluator(evaluator)).toBe(true);
    for (const evaluator of ['evidence', 'runner', 'providers', 'unsupported', 'pipeline', '']) {
      expect(isLiveMetadataEvaluator(evaluator)).toBe(false);
    }
  });

  it.each(profiles)('evaluates complete %s metadata without changing original observations', profile => {
    const live = fixture(profile), original = structuredClone(live);
    const evaluators = liveMetadataEvaluators.filter(evaluator =>
      evaluator !== (profile === 'team-gitflow' ? 'single-maintainer' : 'team-review'));
    for (const evaluator of evaluators) {
      const result = observeLiveGovernanceControl(evaluator, profile, live, ['dev']);
      expect(result, evaluator).toMatchObject({
        availability: 'observed', value: evaluator === 'default-branch' ? 'develop' : true,
        source: { kind: 'github', capturedAt }
      });
    }
    expect(live).toEqual(original);
  });

  it.each(profiles)('does not substitute the opposite review policy for %s', profile => {
    const evaluator = profile === 'team-gitflow' ? 'single-maintainer' : 'team-review';
    expect(observeLiveGovernanceControl(evaluator, profile, fixture(profile), ['dev'])).toMatchObject({
      availability: 'observed', value: false
    });
  });

  it.each(liveMetadataEvaluators)('keeps absent %s metadata unobserved', evaluator => {
    expect(observeLiveGovernanceControl(evaluator, 'single-maintainer-gitflow', {
      observations: {}, diagnostics: [], refsStable: false
    }, ['dev']).availability).toBe('not-observed');
  });

  it.each(['protected-refs', 'single-maintainer', 'team-review', 'tag-controls'] as const)(
    'retains denied ruleset metadata for %s instead of proving absence', evaluator => {
      const live = fixture('single-maintainer-gitflow');
      live.observations['github.rulesets'] = notObserved('Masked or denied metadata.');
      expect(observeLiveGovernanceControl(evaluator, 'single-maintainer-gitflow', live, ['dev'])).toMatchObject({
        availability: 'not-observed', value: null
      });
    }
  );

  it.each(['github.branches', 'github.ref-families'] as const)(
    'requires complete %s for effective protected-ref evaluation', key => {
      const live = fixture('single-maintainer-gitflow');
      live.observations[key] = notObserved('Incomplete enumeration.');
      expect(observeLiveGovernanceControl('protected-refs', 'single-maintainer-gitflow', live, ['dev']))
        .toMatchObject({ availability: 'not-observed' });
    }
  );

  it('retains the complete rule, branch and family facts for a protected-ref verdict', () => {
    const live = fixture('single-maintainer-gitflow');
    expect(observeLiveGovernanceControl('protected-refs', 'single-maintainer-gitflow', live, ['dev']).facts)
      .toEqual({
        rulesets: live.observations['github.rulesets']!.value,
        branches: live.observations['github.branches']!.value,
        refFamilies: live.observations['github.ref-families']!.value
      });
  });

  it('requires the actual GitHub Actions app identity before evaluating tag bypasses', () => {
    const live = fixture('single-maintainer-gitflow');
    live.observations['github.actions-app'] = notObserved('The app was not observed.');
    expect(observeLiveGovernanceControl('tag-controls', 'single-maintainer-gitflow', live, ['dev']))
      .toMatchObject({ availability: 'not-observed' });
  });

  it('rejects a different tag-creation application instead of matching a plausible numeric ID', () => {
    const live = fixture('single-maintainer-gitflow');
    live.observations['github.actions-app'] = observed({ id: 8, slug: 'github-actions' },
      source('github', 'https://api.github.com/apps/github-actions', capturedAt));
    expect(observeLiveGovernanceControl('tag-controls', 'single-maintainer-gitflow', live, ['dev']))
      .toMatchObject({ availability: 'observed', value: false });
  });

  it('keeps omitted secret protection unknown and retains the original metadata', () => {
    const live = fixture('single-maintainer-gitflow');
    const value = { secret_scanning: { status: 'enabled' } };
    live.observations['github.security'] = observed(value, source('github', 'https://api.github.com/example/security', capturedAt));
    expect(observeLiveGovernanceControl('push-protection', 'single-maintainer-gitflow', live, ['dev']))
      .toMatchObject({ availability: 'not-observed', value });
  });

  it.each(profiles)('does not introduce deployment reviewers for %s', profile => {
    const live = fixture(profile);
    live.observations['github.environments'] = observed([{ name: 'dev', reviewers: 1 }],
      source('github', 'https://api.github.com/example/environments', capturedAt));
    expect(observeLiveGovernanceControl('environments', profile, live, ['dev']))
      .toMatchObject({ availability: 'observed', value: false });
  });

  it('distinguishes a missing selected environment from unknown reviewer metadata', () => {
    const live = fixture('single-maintainer-gitflow');
    expect(observeLiveGovernanceControl('environments', 'single-maintainer-gitflow', live, ['staging']))
      .toMatchObject({ availability: 'missing', value: null });
    live.observations['github.environments'] = observed([{ name: 'dev', reviewers: null }],
      source('github', 'https://api.github.com/example/environments', capturedAt));
    expect(observeLiveGovernanceControl('environments', 'single-maintainer-gitflow', live, ['dev']))
      .toMatchObject({ availability: 'not-observed', value: [{ name: 'dev', reviewers: null }] });
  });
});
