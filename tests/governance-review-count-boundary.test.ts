import { mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeProtection, normalizeRule } from '../src/domain/governance/assessment/live-normalize.js';
import { effectiveProtectedRefs, singleMaintainer, teamReview } from '../src/domain/governance/assessment/predicates.js';
import { assessGovernance } from '../src/governance-assessment/engine.js';
import { collectLiveAssessment } from '../src/governance-assessment/live.js';
import type { CommandRunner } from '../src/process-runner.js';
import { freshManifestFixture, inventory, write } from './fixtures/manifest-update.js';

const capturedAt = '2026-09-05T00:00:00.000Z';

function review(count: number) {
  return {
    type: 'pull_request',
    parameters: {
      required_approving_review_count: count, dismiss_stale_reviews_on_push: true,
      require_code_owner_review: false, require_last_push_approval: false
    }
  };
}

function ruleset(count: number) {
  return {
    id: 1, name: 'Scoped review', target: 'branch', enforcement: 'active',
    source_type: 'Repository', source: 'owner/repo',
    conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
    bypass_actors: [], rules: [
      { type: 'deletion' }, { type: 'non_fast_forward' }, review(count),
      { type: 'required_status_checks', parameters: {
        strict_required_status_checks_policy: true, do_not_enforce_on_create: true,
        required_status_checks: [{ context: 'CI', integration_id: 7 }]
      } }
    ]
  };
}

function classic(count: number) {
  return {
    enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_status_checks: { strict: true, contexts: ['CI'], checks: [{ context: 'CI', app_id: 7 }] },
    required_pull_request_reviews: {
      required_approving_review_count: count, dismiss_stale_reviews: true,
      require_code_owner_reviews: false, require_last_push_approval: false
    }
  };
}

async function collect(count: number) {
  const calls: string[] = [];
  const runner: CommandRunner = {
    run: async command => {
      expect(command.executable).toBe('gh');
      expect(command.args).toContain('GET');
      const endpoint = new URL(command.args.at(-1)!);
      calls.push(endpoint.href);
      let value: unknown;
      if (endpoint.href === 'https://api.github.com/repos/owner/repo') {
        value = {
          id: 42, node_id: 'R_fixture', full_name: 'owner/repo', default_branch: 'main',
          security_and_analysis: { secret_scanning: { status: 'enabled' } }
        };
      } else if (endpoint.href === 'https://api.github.com/apps/github-actions') {
        value = { id: 7, slug: 'github-actions' };
      } else if (endpoint.pathname === '/repos/owner/repo/rulesets') {
        value = [{ id: 1, source_type: 'Repository', source: 'owner/repo' }];
      } else if (endpoint.pathname === '/repos/owner/repo/rulesets/1') {
        value = ruleset(count);
      } else if (endpoint.pathname === '/repos/owner/repo/environments') {
        value = { total_count: 0, environments: [] };
      } else if (endpoint.pathname === '/repos/owner/repo/actions/workflows') {
        value = { total_count: 0, workflows: [] };
      } else {
        throw new Error(`Unregistered isolated metadata request: ${endpoint.pathname}`);
      }
      return {
        command, displayCommand: 'isolated read-only metadata', status: 0, signal: null,
        stdout: `HTTP/2.0 200 Fixture\r\n\r\n${JSON.stringify(value)}`, stderr: '', timedOut: false
      };
    }
  };
  const result = await collectLiveAssessment({
    repository: { owner: 'owner', name: 'repo', id: 'R_fixture' },
    refs: [], environments: [], runner: null, azure: []
  }, { runner, now: () => new Date(capturedAt) });
  expect(calls[0]).toBe('https://api.github.com/repos/owner/repo');
  expect(calls.map(endpoint => new URL(endpoint).pathname)).toContain('/repos/owner/repo/rulesets/1');
  return result;
}

describe('integer approval-count assessment boundary', () => {
  it('refuses fractional ruleset approval counts before normalization', () => {
    expect(() => normalizeRule(review(1.5))).toThrow();
  });

  it('refuses fractional classic approval counts before normalization', () => {
    expect(() => normalizeProtection(classic(1.5))).toThrow();
  });

  it('does not treat fractional declared team approval as current review', () => {
    expect(teamReview([ruleset(1.5)]).value).toBeNull();
  });

  it('keeps malformed classic review counts unknown rather than an interpretable profile conflict', () => {
    expect(effectiveProtectedRefs([ruleset(1)], ['main', 'develop'].map(name => ({
      name, protected: true, protectionObserved: true,
      protection: { classic: classic(1.5), effectiveRules: [] }
    })), { complete: true, prefixes: ['release/', 'hotfix/'], refs: [] }, 'main', 'team-gitflow').value).toBeNull();
  });

  it('keeps the actual malformed declared review finding unobserved without changing project bytes', async () => {
    const project = await freshManifestFixture('team-gitflow', 'manual');
    const directory = path.join(project.root, 'governance', 'rulesets');
    await mkdir(directory, { recursive: true });
    for (const name of await readdir(directory)) {
      if (name.endsWith('.json')) await unlink(path.join(directory, name));
    }
    await write(project.root, ['governance', 'rulesets', 'scoped-review.json'], JSON.stringify(ruleset(1.5)));
    const before = await inventory(project.root);
    const report = await assessGovernance(project.root, {
      now: () => new Date(capturedAt),
      runner: { run: async () => { throw new Error('Declared assessment must not execute provider commands.'); } }
    });
    const finding = report.findings.find(item => item.controlId === 'governance.team-review');
    expect(finding).toBeDefined();
    expect(finding?.observations.declared).toMatchObject({ availability: 'not-observed', value: null });
    expect(report.outcome).not.toBe('aligned');
    expect(await inventory(project.root)).toEqual(before);
  });

  it('withholds the actual read-only collector ruleset observation and emits its malformed-response diagnostic', async () => {
    const result = await collect(1.5);
    expect(result.observations['github.rulesets']).toMatchObject({ availability: 'not-observed', value: null });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'live-invalid-response', source: 'github.rulesets', severity: 'warning'
    }));
  });

  it('preserves valid zero and stronger integer approval controls', async () => {
    expect(normalizeRule(review(0))).toMatchObject({ parameters: { required_approving_review_count: 0 } });
    expect(normalizeProtection(classic(2))).toMatchObject({ required_pull_request_reviews: { required_approving_review_count: 2 } });
    expect(teamReview([ruleset(2)]).value).toBe(true);
    expect((await collect(2)).observations['github.rulesets']?.availability).toBe('observed');
  });

  it.each([
    { name: 'negative', count: -1 },
    { name: 'fractional zero', count: 0.5 },
    { name: 'fractional review', count: 1.5 },
    { name: 'unsafe integer', count: Number.MAX_SAFE_INTEGER + 1 },
    { name: 'infinite', count: Infinity },
    { name: 'not-a-number', count: NaN },
    { name: 'string', count: '1' },
    { name: 'null', count: null },
    { name: 'boolean', count: true }
  ])('withholds $name review counts in both normalized formats and both raw profile evaluators', ({ count }) => {
    const rule = review(1);
    const protection = classic(1);
    Object.assign(rule.parameters, { required_approving_review_count: count });
    Object.assign(protection.required_pull_request_reviews, { required_approving_review_count: count });
    const scoped = { ...ruleset(1), rules: [rule] };
    expect(() => normalizeRule(rule)).toThrow();
    expect(() => normalizeProtection(protection)).toThrow();
    expect(teamReview([scoped]).value).toBeNull();
    expect(singleMaintainer([scoped]).value).toBeNull();
  });

  it.each(['single-maintainer-gitflow', 'team-gitflow'] as const)(
    'keeps malformed classic metadata unknown for %s', profile => {
      expect(effectiveProtectedRefs([ruleset(1)], ['main', 'develop'].map(name => ({
        name, protected: true, protectionObserved: true,
        protection: { classic: classic(Number.MAX_SAFE_INTEGER + 1), effectiveRules: [] }
      })), { complete: true, prefixes: ['release/', 'hotfix/'], refs: [] }, 'main', profile).value).toBeNull();
    }
  );

  it('preserves valid single-maintainer conflicts and team zero-review distinction', () => {
    expect(singleMaintainer([ruleset(0)]).value).toBe(true);
    expect(singleMaintainer([ruleset(1)]).value).toBe(false);
    expect(teamReview([ruleset(0)]).value).toBe(false);
    expect(teamReview([ruleset(2)]).value).toBe(true);
  });

  it('does not change unrelated numeric metadata decoding', () => {
    expect(normalizeRule({ type: 'max_file_size', parameters: { max_file_size: 0.5 } })).toMatchObject({
      parameters: { max_file_size: 0.5 }
    });
  });
});
