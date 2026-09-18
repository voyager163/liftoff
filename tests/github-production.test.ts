import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import type { GitHubActivationTransport, GitHubRequest, GitHubResponse } from '../src/adapters/github/activation-rest.js';
import { GitHubActivationClient } from '../src/adapters/github/activation-rest.js';
import {
  ProductionGitHubRulesetAdapter,
  buildCanonicalGitFlowRulesets,
  canonicalOwnedRulesetNames,
  productionRulesetSourceDigest
} from '../src/adapters/github/production-rulesets.js';

class MockTransport implements GitHubActivationTransport {
  public requests: GitHubRequest[] = [];
  public responses: Map<string, (req: GitHubRequest) => GitHubResponse> = new Map();

  on(key: string, fn: (req: GitHubRequest) => GitHubResponse): void {
    this.responses.set(key, fn);
  }

  async request(req: GitHubRequest): Promise<GitHubResponse> {
    this.requests.push(req);
    const key = `${req.method} ${req.path.split('?')[0]}`;
    const fn = this.responses.get(key);
    if (fn) return fn(req);
    return { status: 404, headers: {}, data: { message: `Not found: ${key}` } };
  }
}

describe('Production GitHub Ruleset Adapter', () => {
  it('generates canonical single-maintainer GitFlow rulesets', () => {
    const rulesets = buildCanonicalGitFlowRulesets();
    expect(rulesets.length).toBe(4);

    const names = rulesets.map((r) => r.name);
    expect(names).toContain('liftoff-gitflow-develop');
    expect(names).toContain('liftoff-gitflow-main');
    expect(names).toContain('liftoff-gitflow-releases');
    expect(names).toContain('liftoff-tags');

    // develop ruleset invariants
    const develop = rulesets.find((r) => r.name === 'liftoff-gitflow-develop')!;
    expect(develop.target).toBe('branch');
    expect(develop.enforcement).toBe('active');
    expect(develop.bypass_actors.length).toBe(0);

    const prRule = develop.rules.find((r) => r.type === 'pull_request')!;
    expect(prRule.parameters?.required_approving_review_count).toBe(0);
    expect(prRule.parameters?.require_code_owner_review).toBe(false);
    expect(prRule.parameters?.require_last_push_approval).toBe(false);
    expect(prRule.parameters?.dismiss_stale_reviews_on_push).toBe(true);

    const checksRule = develop.rules.find((r) => r.type === 'required_status_checks')!;
    expect(checksRule.parameters?.strict_required_status_checks_policy).toBe(true);
    expect(checksRule.parameters?.do_not_enforce_on_create).toBe(true);

    // tags ruleset
    const tags = rulesets.find((r) => r.name === 'liftoff-tags')!;
    expect(tags.target).toBe('tag');
    expect(tags.rules.some((r) => r.type === 'update')).toBe(true);
    expect(tags.rules.some((r) => r.type === 'deletion')).toBe(true);
  });

  it('refuses production writes without a complete exact owned-control plan and checkpoints', async () => {
    const transport = new MockTransport();
    let rulesetStore: Array<Record<string, unknown>> = [];

    // List rulesets
    transport.on('GET /repos/owner/repo/rulesets', () => ({
      status: 200,
      headers: {},
      data: rulesetStore
    }));

    // Create ruleset
    transport.on('POST /repos/owner/repo/rulesets', (req) => {
      const body = req.body as Record<string, unknown>;
      const id = rulesetStore.length + 1;
      const created = {
        id,
        node_id: `node-${id}`,
        name: body.name,
        target: body.target,
        enforcement: body.enforcement,
        source_type: 'Repository',
        source: 'owner/repo',
        conditions: body.conditions,
        bypass_actors: body.bypass_actors,
        rules: body.rules
      };
      rulesetStore.push(created);
      return { status: 201, headers: {}, data: created };
    });

    // Get specific ruleset
    for (let id = 1; id <= 10; id++) {
      transport.on(`GET /repos/owner/repo/rulesets/${id}`, () => {
        const found = rulesetStore.find((r) => r.id === id);
        return found
          ? { status: 200, headers: {}, data: found }
          : { status: 404, headers: {}, data: { message: 'not found' } };
      });
    }

    const client = new GitHubActivationClient(transport);
    const adapter = new ProductionGitHubRulesetAdapter({ client });

    await expect(adapter.applyRuleset({
      repository: 'owner/repo',
      sourceDigest: 'source-digest-v1',
      approvalEnvelopeId: 'approval-1'
    })).rejects.toThrow(/exact owned-ID\/control-payload plan and released pre-effect checkpoint authority/);
    expect(rulesetStore.length).toBe(0);
    const postRequests = transport.requests.filter((r) => r.method === 'POST');
    expect(postRequests.length).toBe(0);
  });

  it('performs repeat exact owned-ID readback without writes and preserves neutral provider defaults', async () => {
    const transport = new MockTransport();
    const rulesets = buildCanonicalGitFlowRulesets();
    const rulesetStore: Array<Record<string, unknown>> = structuredClone(rulesets).map((r, i) => ({
      id: i + 1,
      node_id: `node-${i + 1}`,
      name: r.name,
      target: r.target,
      enforcement: r.enforcement,
      source_type: 'Repository',
      source: 'owner/repo',
      conditions: r.conditions,
      bypass_actors: r.bypass_actors,
      rules: r.rules
    }));
    for (const ruleset of rulesetStore) {
      Object.assign(ruleset, {
        created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-15T00:00:00Z', current_user_can_bypass: 'never',
        _links: { self: { href: `https://api.github.com/repos/owner/repo/rulesets/${ruleset.id}` }, html: null }
      });
      for (const rule of ruleset.rules as Array<Record<string, unknown>>) {
        if (rule.type === 'pull_request') rule.parameters = {
          ...(rule.parameters as object),
          dismissal_restriction: { enabled: false, allowed_actors: [] },
          require_extra_approval_for_unattributed_changes: true,
          required_reviewers: []
        };
      }
    }

    transport.on('GET /repos/owner/repo/rulesets', () => ({
      status: 200,
      headers: {},
      data: rulesetStore
    }));

    for (let id = 1; id <= rulesetStore.length; id++) {
      transport.on(`GET /repos/owner/repo/rulesets/${id}`, () => {
        const found = rulesetStore.find((r) => r.id === id);
        return { status: 200, headers: {}, data: found };
      });
    }

    const client = new GitHubActivationClient(transport);
    const adapter = new ProductionGitHubRulesetAdapter({
      client, desiredRulesets: rulesets,
      ownedControls: rulesetStore.map((entry) => ({ id: Number(entry.id), name: String(entry.name) }))
    });

    const sourceDigest = productionRulesetSourceDigest(rulesets);
    const result = await adapter.readRuleset({
      repository: 'owner/repo',
      sourceDigest
    });
    expect(await adapter.readRuleset({ repository: 'owner/repo', sourceDigest })).toEqual(result);

    // Zero POST or PUT calls
    const writeRequests = transport.requests.filter((r) => r.method === 'POST' || r.method === 'PUT' || r.method === 'DELETE');
    expect(writeRequests.length).toBe(0);
    expect(result.readbackDigest).toBe(sourceDigest);
    expect(result.observationDigest).toBeDefined();
    expect(result.ownedControls).toHaveLength(4);
    rulesetStore[0]!.updated_at = '2026-09-15T00:01:00Z';
    const metadataChanged = await adapter.readRuleset({ repository: 'owner/repo', sourceDigest });
    expect(metadataChanged.readbackDigest).toBe(sourceDigest);
    expect(metadataChanged.observationDigest).not.toBe(result.observationDigest);
    expect(transport.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('preserves foreign and inherited rulesets intact without deleting them', async () => {
    const transport = new MockTransport();
    const foreignRuleset = {
      id: 99,
      node_id: 'node-99',
      name: 'org-enterprise-security-baseline',
      target: 'branch',
      enforcement: 'active',
      source_type: 'Organization',
      source: 'enterprise-org',
      conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
      bypass_actors: [],
      rules: [{ type: 'required_signatures' }]
    };

    const rulesetStore: Array<Record<string, unknown>> = [foreignRuleset];

    transport.on('GET /repos/owner/repo/rulesets', () => ({
      status: 200,
      headers: {},
      data: rulesetStore
    }));

    transport.on('POST /repos/owner/repo/rulesets', (req) => {
      const body = req.body as Record<string, unknown>;
      const id = rulesetStore.length + 1;
      const created = {
        id,
        node_id: `node-${id}`,
        name: body.name,
        target: body.target,
        enforcement: body.enforcement,
        source_type: 'Repository',
        source: 'owner/repo',
        conditions: body.conditions,
        bypass_actors: body.bypass_actors,
        rules: body.rules
      };
      rulesetStore.push(created);
      return { status: 201, headers: {}, data: created };
    });

    for (let id = 1; id <= 10; id++) {
      transport.on(`GET /repos/owner/repo/rulesets/${id}`, () => {
        const found = rulesetStore.find((r) => r.id === id);
        return found
          ? { status: 200, headers: {}, data: found }
          : { status: 404, headers: {}, data: { message: 'not found' } };
      });
    }

    const client = new GitHubActivationClient(transport);
    const adapter = new ProductionGitHubRulesetAdapter({ client });

    await expect(adapter.applyRuleset({
      repository: 'owner/repo',
      sourceDigest: 'source-digest-v1',
      approvalEnvelopeId: 'approval-1'
    })).rejects.toThrow(/exact owned-ID\/control-payload plan and released pre-effect checkpoint authority/);

    // Foreign ruleset is still present!
    expect(rulesetStore.some((r) => r.name === 'org-enterprise-security-baseline')).toBe(true);

    // No DELETE requests were made
    const deleteRequests = transport.requests.filter((r) => r.method === 'DELETE');
    expect(deleteRequests.length).toBe(0);
  });
});
