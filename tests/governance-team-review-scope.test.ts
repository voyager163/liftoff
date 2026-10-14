import { mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { singleMaintainer, teamReview } from '../src/domain/governance/assessment/predicates.js';
import { assessGovernance } from '../src/governance-assessment/engine.js';
import * as liveModule from '../src/governance-assessment/live.js';
import { observed, source } from '../src/domain/governance/assessment/sanitize.js';
import { freshManifestFixture, inventory, write } from './fixtures/manifest-update.js';

afterEach(() => vi.restoreAllMocks());

function reviewRule(include: string[], approvals = 1, exclude: string[] = []) {
  return {
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include, exclude } },
    rules: [{
      type: 'pull_request',
      parameters: {
        required_approving_review_count: approvals,
        require_code_owner_review: false,
        require_last_push_approval: false,
        dismiss_stale_reviews_on_push: true
      }
    }]
  };
}

describe('team-review protected-ref scope', () => {
  it('retains a current approval rule covering every protected family', () => {
    expect(teamReview([reviewRule(['~ALL'])]).value).toBe(true);
  });

  it('does not borrow a review requirement from an unrelated branch', () => {
    expect(teamReview([
      reviewRule(['~ALL'], 0),
      reviewRule(['refs/heads/topic/reviewed'])
    ]).value).toBe(false);
  });

  it('does not treat main-only approvals as protection for every family', () => {
    expect(teamReview([reviewRule(['refs/heads/main'])]).value).toBe(false);
  });

  it('does not claim full-family review when a protected hotfix is excluded', () => {
    expect(teamReview([reviewRule(['~ALL'], 1, ['refs/heads/hotfix/unreviewed'])]).value).toBeNull();
  });

  it('accepts separate current approval rules for all four families', () => {
    expect(teamReview(['develop', 'main', 'release/**', 'hotfix/**'].map(
      ref => reviewRule([`refs/heads/${ref}`])
    )).value).toBe(true);
  });

  it('retains stronger approvals, code-owner and last-push requirements', () => {
    const rule = reviewRule(['~ALL'], 2);
    Object.assign(rule.rules[0].parameters, {
      require_code_owner_review: true,
      require_last_push_approval: true
    });
    expect(teamReview([rule]).value).toBe(true);
  });

  it('preserves single-maintainer zero-review semantics while refusing them for team', () => {
    const rule = reviewRule(['~ALL'], 0);
    expect(singleMaintainer([rule]).value).toBe(true);
    expect(teamReview([rule]).value).toBe(false);
  });

  it('requires stale-review dismissal within the scoped current approval rule', () => {
    const rule = reviewRule(['~ALL']);
    rule.rules[0].parameters.dismiss_stale_reviews_on_push = false;
    expect(teamReview([rule]).value).toBe(false);
  });

  it.each(['disabled', 'evaluate'])('does not use %s review rules', enforcement => {
    expect(teamReview([{ ...reviewRule(['~ALL']), enforcement }]).value).toBe(false);
  });

  it('does not use a tag rule for branch review', () => {
    expect(teamReview([{ ...reviewRule(['~ALL']), target: 'tag' }]).value).toBe(false);
  });

  it.each([
    { name: 'unsupported wildcard', rule: reviewRule(['refs/heads/*']) },
    { name: 'missing conditions', rule: { ...reviewRule(['~ALL']), conditions: undefined } },
    { name: 'missing rule details', rule: { ...reviewRule(['~ALL']), rules: undefined } }
  ])('keeps $name unobserved', ({ rule }) => {
    expect(teamReview([rule]).value).toBeNull();
  });

  it('keeps incomplete current-review settings unobserved', () => {
    const rule = reviewRule(['~ALL']);
    Object.assign(rule.rules[0].parameters, { dismiss_stale_reviews_on_push: undefined });
    expect(teamReview([rule]).value).toBeNull();
  });

  it('binds default-branch rules without borrowing coverage for other families', () => {
    const rules = [
      reviewRule(['~DEFAULT_BRANCH']),
      ...['develop', 'release/**', 'hotfix/**'].map(ref => reviewRule([`refs/heads/${ref}`]))
    ];
    expect(teamReview(rules, 'main').value).toBe(true);
    expect(teamReview(rules, 'develop').value).toBe(false);
    expect(teamReview(rules).value).toBeNull();
  });

  it('keeps the actual declared team finding scoped and project bytes unchanged', async () => {
    const project = await freshManifestFixture('team-gitflow', 'manual');
    const directory = path.join(project.root, 'governance', 'rulesets');
    await mkdir(directory, { recursive: true });
    for (const name of await readdir(directory)) {
      if (name.endsWith('.json')) await unlink(path.join(directory, name));
    }
    await write(project.root, ['governance', 'rulesets', 'scoped-review.json'], JSON.stringify(
      reviewRule(['refs/heads/topic/reviewed'])
    ));
    const before = await inventory(project.root);
    const report = await assessGovernance(project.root, {
      now: () => new Date('2026-09-05T00:00:00.000Z'),
      runner: { run: async () => { throw new Error('Scoped declared assessment must not execute commands.'); } }
    });
    const finding = report.findings.find(item => item.controlId === 'governance.team-review');
    expect(finding?.observations.declared).toMatchObject({
      availability: 'missing',
      value: null,
      reason: expect.stringContaining('refs/heads/develop')
    });
    expect(await inventory(project.root)).toEqual(before);
  });

  it.each([
    { defaultBranch: 'main', expected: true },
    { defaultBranch: 'develop', expected: false },
    { defaultBranch: null, expected: null }
  ])('uses observed default branch $defaultBranch in the live finding', async ({ defaultBranch, expected }) => {
    const project = await freshManifestFixture('team-gitflow', 'manual');
    const rules = [
      reviewRule(['~DEFAULT_BRANCH']),
      ...['develop', 'release/**', 'hotfix/**'].map(ref => reviewRule([`refs/heads/${ref}`]))
    ];
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
      live: true,
      now: () => new Date(capturedAt),
      runner: { run: async () => { throw new Error('Injected observation must not execute provider commands.'); } }
    });
    expect(collector).toHaveBeenCalledOnce();
    const finding = report.findings.find(item => item.controlId === 'governance.team-review');
    expect(finding?.observations.live?.value).toEqual(expected === null ? rules : expected === false ? null : true);
    expect(finding?.observations.live?.availability).toBe(expected === null ? 'not-observed' : expected === false ? 'missing' : 'observed');
    expect(finding?.observations.live?.facts).toEqual(expected === null ? undefined : rules);
    expect(report.coverage.unsupported).toBeGreaterThan(0);
    expect(report.outcome).not.toBe('aligned');
    expect(await inventory(project.root)).toEqual(before);
  });
});
