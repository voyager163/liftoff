import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubActivationClient, type GitHubActivationTransport, type GitHubRequest } from '../src/adapters/github/activation-rest.js';
import {
  buildCanonicalGitFlowRulesets, productionRulesetSourceDigest, ProductionGitHubRulesetAdapter
} from '../src/adapters/github/production-rulesets.js';
import { areRulesetsSemanticallyEqual } from '../src/domain/governance/assessment/predicates.js';

vi.mock('../src/domain/governance/assessment/predicates.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/domain/governance/assessment/predicates.js')>();
  return { ...actual, areRulesetsSemanticallyEqual: vi.fn(() => true) };
});

beforeEach(() => vi.clearAllMocks());

function fixture() {
  const desired = structuredClone(buildCanonicalGitFlowRulesets()[0]!);
  const live: Record<string, unknown> = {
    ...structuredClone(desired), id: 17, node_id: 'ruleset-17', source_type: 'Repository', source: 'owner/repo'
  };
  const requests: GitHubRequest[] = [];
  const transport: GitHubActivationTransport = {
    async request(request) {
      requests.push(request);
      if (request.method !== 'GET') throw new Error('No provider writes are allowed in this admission regression.');
      return { status: 200, headers: {}, data: /\/rulesets\/[1-9]\d*(?:\?|$)/u.test(request.path) ? live : [live] };
    }
  };
  const adapter = new ProductionGitHubRulesetAdapter({
    client: new GitHubActivationClient(transport), desiredRulesets: [desired],
    ownedControls: [{ id: 17, name: desired.name }]
  });
  const sourceDigest = productionRulesetSourceDigest([desired]);
  const read = () => adapter.readRuleset({ repository: 'owner/repo', sourceDigest });
  return { desired, live, requests, sourceDigest, read };
}

function pullRequest(row: Record<string, unknown>): Record<string, unknown> {
  const rules = row.rules as Array<{ type: string; parameters: Record<string, unknown> }>;
  return rules.find((rule) => rule.type === 'pull_request')!.parameters;
}

describe('strict provider admission when semantic comparison is faulty', () => {
  it('rejects a one-sided allowed merge method even when the helper says matched', async () => {
    const f = fixture();
    pullRequest(f.live).allowed_merge_methods = ['squash'];
    await expect(f.read()).rejects.toThrow(/Independent ruleset readback digest differs/);
    expect(areRulesetsSemanticallyEqual).toHaveBeenCalled();
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('requires independent equality for changed meaningful review constraints', async () => {
    const f = fixture();
    pullRequest(f.live).required_approving_review_count = 1;
    await expect(f.read()).rejects.toThrow(/Independent ruleset readback digest differs/);
    expect(areRulesetsSemanticallyEqual).toHaveBeenCalled();
  });

  const invalid: Array<[string, (row: Record<string, unknown>) => void]> = [
    ['numeric string', (row) => { pullRequest(row).required_approving_review_count = '0'; }],
    ['negative count', (row) => { pullRequest(row).required_approving_review_count = -1; }],
    ['fractional count', (row) => { pullRequest(row).required_approving_review_count = 0.5; }],
    ['oversized count', (row) => { pullRequest(row).required_approving_review_count = 11; }],
    ['string boolean', (row) => { pullRequest(row).require_code_owner_review = 'false'; }],
    ['unknown enforcement', (row) => { pullRequest(row).unknown_review_requirement = true; }],
    ['malformed rules', (row) => { row.rules = {}; }],
    ['malformed actors', (row) => { row.bypass_actors = false; }],
    ['malformed refs', (row) => { row.conditions = { ref_name: { include: 'refs/heads/develop', exclude: [] } }; }],
    ['malformed reviewers', (row) => { pullRequest(row).required_reviewers = ''; }],
    ['malformed restriction', (row) => { pullRequest(row).dismissal_restriction = { enabled: 'false', allowed_actors: [] }; }]
  ];
  it.each(invalid)('rejects %s without treating it as empty/default policy', async (_label, corrupt) => {
    const f = fixture();
    corrupt(f.live);
    await expect(f.read()).rejects.toThrow(/unsupported enforcement/);
    expect(areRulesetsSemanticallyEqual).not.toHaveBeenCalled();
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it.each(['omitted', 'empty'] as const)('preserves %s optional dismissal actors during repeated readback', async (actors) => {
    const f = fixture();
    Object.assign(pullRequest(f.live), {
      dismissal_restriction: { enabled: false, ...(actors === 'empty' ? { allowed_actors: [] } : {}) },
      require_extra_approval_for_unattributed_changes: true,
      required_reviewers: []
    });
    const first = await f.read();
    expect(first.readbackDigest).toBe(f.sourceDigest);
    expect(await f.read()).toEqual(first);
    expect(pullRequest(f.live).require_extra_approval_for_unattributed_changes).toBe(true);
    expect(Object.hasOwn(pullRequest(f.live).dismissal_restriction as object, 'allowed_actors')).toBe(actors === 'empty');
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it.each(['source', 'id'] as const)('preserves foreign same-named controls with a different %s', async (field) => {
    const f = fixture();
    if (field === 'source') f.live.source = 'other/repository';
    else f.live.id = 99;
    await expect(f.read()).rejects.toThrow(/foreign and changed protections were preserved/);
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it.each(['always', 'pull_requests_only', 'exempt'])('does not hide a provider-observed %s actor bypass behind equal rule definitions', async (bypass) => {
    const f = fixture();
    f.live.current_user_can_bypass = bypass;
    await expect(f.read()).rejects.toThrow(/actor bypass capability/);
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  });
});
