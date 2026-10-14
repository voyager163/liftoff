import { afterEach, describe, expect, it, vi } from 'vitest';
import { singleMaintainer } from '../src/domain/governance/assessment/predicates.js';
import { assessGovernance } from '../src/governance-assessment/engine.js';
import * as liveModule from '../src/governance-assessment/live.js';
import { observed, source } from '../src/domain/governance/assessment/sanitize.js';
import { freshManifestFixture, inventory, write } from './fixtures/manifest-update.js';

afterEach(() => vi.restoreAllMocks());

function reviewRule(include: string[], approvals = 0, exclude: string[] = []) {
  return {
    target: 'branch', enforcement: 'active', bypass_actors: [],
    conditions: { ref_name: { include, exclude } },
    rules: [{
      type: 'pull_request',
      parameters: {
        required_approving_review_count: approvals,
        require_code_owner_review: false, require_last_push_approval: false,
        dismiss_stale_reviews_on_push: true
      }
    }]
  };
}

describe('single-maintainer protected-ref review scope', () => {
  it('retains zero-review settings covering every protected family', () => {
    expect(singleMaintainer([reviewRule(['~ALL'])]).value).toBe(true);
  });

  it('preserves the policy refusal of human-review requirements anywhere', () => {
    expect(singleMaintainer([
      reviewRule(['~ALL']),
      reviewRule(['refs/heads/topic/reviewed'], 1)
    ]).value).toBe(false);
  });

  it('does not borrow a zero-review rule from an unrelated branch', () => {
    expect(singleMaintainer([reviewRule(['refs/heads/topic/reviewed'])]).value).toBe(false);
  });

  it('does not treat main-only zero-review rules as coverage of every family', () => {
    expect(singleMaintainer([reviewRule(['refs/heads/main'])]).value).toBe(false);
  });

  it('does not claim complete review coverage when a hotfix is excluded', () => {
    expect(singleMaintainer([reviewRule(['~ALL'], 0, ['refs/heads/hotfix/unreviewed'])]).value).toBeNull();
  });

  it('accepts separate zero-review rules for each protected family', () => {
    expect(singleMaintainer(['develop', 'main', 'release/**', 'hotfix/**'].map(
      ref => reviewRule([`refs/heads/${ref}`])
    )).value).toBe(true);
  });

  it.each([
    { name: 'approval count', settings: { required_approving_review_count: 1 } },
    { name: 'code-owner review', settings: { require_code_owner_review: true } },
    { name: 'last-push review', settings: { require_last_push_approval: true } }
  ])('retains refusal of $name', ({ settings }) => {
    const rule = reviewRule(['~ALL']);
    Object.assign(rule.rules[0].parameters, settings);
    expect(singleMaintainer([rule]).value).toBe(false);
  });

  it('retains stale-review dismissal even with zero approval count', () => {
    const rule = reviewRule(['~ALL']);
    rule.rules[0].parameters.dismiss_stale_reviews_on_push = false;
    expect(singleMaintainer([rule]).value).toBe(false);
  });

  it('does not fill missing review settings with the zero-review default', () => {
    const rule = reviewRule(['~ALL']);
    Object.assign(rule.rules[0].parameters, { dismiss_stale_reviews_on_push: undefined });
    expect(singleMaintainer([rule]).value).toBeNull();
  });

  it.each(['disabled', 'evaluate'])('does not apply the %s human-review requirement', enforcement => {
    expect(singleMaintainer([
      reviewRule(['~ALL']), { ...reviewRule(['~ALL'], 1), enforcement }
    ]).value).toBe(true);
  });

  it('does not apply a tag rule as a branch human-review requirement', () => {
    expect(singleMaintainer([
      reviewRule(['~ALL']), { ...reviewRule(['~ALL'], 1), target: 'tag' }
    ]).value).toBe(true);
  });

  it('retains known full coverage when another uncertain-scope rule also has complete zero-review settings', () => {
    expect(singleMaintainer([
      reviewRule(['~ALL']), reviewRule(['refs/heads/*'])
    ]).value).toBe(true);
  });

  it('does not dismiss a known human-review requirement because its scope is uncertain', () => {
    expect(singleMaintainer([
      reviewRule(['~ALL']), reviewRule(['refs/heads/*'], 1)
    ]).value).toBe(false);
  });

  it('binds the default branch without supplying review coverage for another family', () => {
    const rules = [
      reviewRule(['~DEFAULT_BRANCH']),
      ...['develop', 'release/**', 'hotfix/**'].map(ref => reviewRule([`refs/heads/${ref}`]))
    ];
    expect(singleMaintainer(rules, 'main').value).toBe(true);
    expect(singleMaintainer(rules, 'develop').value).toBe(false);
    expect(singleMaintainer(rules).value).toBeNull();
  });

  it('reports the missing declared family and leaves project bytes unchanged', async () => {
    const project = await freshManifestFixture('single-maintainer-gitflow', 'manual');
    await write(project.root, ['governance', 'rulesets', 'scoped-review.json'], JSON.stringify(
      reviewRule(['refs/heads/topic/reviewed'])
    ));
    const before = await inventory(project.root);
    const report = await assessGovernance(project.root, {
      now: () => new Date('2026-09-05T00:00:00.000Z'),
      runner: { run: async () => { throw new Error('Declared assessment must not execute commands.'); } }
    });
    expect(report.findings.find(item => item.controlId === 'governance.single-maintainer')?.observations.declared)
      .toMatchObject({ availability: 'missing', value: null });
    expect(await inventory(project.root)).toEqual(before);
  });

  it.each([
    { defaultBranch: 'main', expected: true },
    { defaultBranch: 'develop', expected: false },
    { defaultBranch: null, expected: null }
  ])('uses observed default branch $defaultBranch in the actual live finding', async ({ defaultBranch, expected }) => {
    const rules = [
      reviewRule(['~DEFAULT_BRANCH']),
      ...['develop', 'release/**', 'hotfix/**'].map(ref => reviewRule([`refs/heads/${ref}`]))
    ];
    const observation = await liveFinding(rules, defaultBranch);
    expect(observation?.availability).toBe(expected === null ? 'not-observed' : expected === false ? 'missing' : 'observed');
    expect(observation?.value).toEqual(expected === null ? rules : expected === false ? null : true);
    expect(observation?.facts).toEqual(expected === null ? undefined : rules);
  });

  it('retains the actual live human-review conflict even for an unrelated branch', async () => {
    const rules = [reviewRule(['~ALL']), reviewRule(['refs/heads/topic/reviewed'], 1)];
    const observation = await liveFinding(rules, 'main');
    expect(observation).toMatchObject({ availability: 'observed', value: false, facts: rules });
  });
});

async function liveFinding(rules: ReturnType<typeof reviewRule>[], defaultBranch: string | null) {
  const project = await freshManifestFixture('single-maintainer-gitflow', 'manual');
  const capturedAt = '2026-09-05T00:00:00.000Z';
  const collector = vi.spyOn(liveModule, 'collectLiveAssessment').mockResolvedValue({
    observations: {
      'github.rulesets': observed(rules, source('github', 'isolated ruleset observation', capturedAt, rules)),
      ...(defaultBranch === null ? {} : {
        'github.repository': observed({ defaultBranch }, source('github', 'isolated repository observation', capturedAt, { defaultBranch }))
      })
    },
    diagnostics: [],
    refsStable: true
  });
  const before = await inventory(project.root);
  const report = await assessGovernance(project.root, {
    live: true, now: () => new Date(capturedAt),
    runner: { run: async () => { throw new Error('Injected observation must not execute provider commands.'); } }
  });
  expect(collector).toHaveBeenCalledOnce();
  expect(report.coverage.unsupported).toBeGreaterThan(0);
  expect(report.outcome).not.toBe('aligned');
  expect(await inventory(project.root)).toEqual(before);
  return report.findings.find(item => item.controlId === 'governance.single-maintainer')?.observations.live;
}
