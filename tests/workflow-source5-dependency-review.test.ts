import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  observeSource5WorkflowDependencyReview
} from '../src/governance-activation/workflow-source5-dependency-review.js';
import { createWorkflowRequiredSourceFixture } from './fixtures/workflow-required-source.js';

function change(name = 'actual-package', changeType = 'added') {
  return { change_type: changeType, manifest: 'Source/backend/package-lock.json', ecosystem: 'npm',
    name, version: '1.2.3', package_url: `pkg:npm/${name}@1.2.3`, license: 'MIT',
    source_repository_url: null, scope: 'runtime', vulnerabilities: [] as unknown[] };
}

function advisory(severity = 'high') {
  return { severity, advisory_ghsa_id: 'GHSA-xxxx-xxxx-xxxx',
    advisory_summary: 'Provider-only advisory details must not escape into the result.',
    advisory_url: 'https://github.com/advisories/GHSA-xxxx-xxxx-xxxx' };
}

describe('actual bounded immutable dependency-review provider verdicts, not phase authority', () => {
  let root: string;
  beforeAll(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-dependency-review-'))); });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  async function fixture(workflow: 'manual' | 'openspec' | 'spec-kit' = 'manual',
    profile: 'single-maintainer-gitflow' | 'team-gitflow' = 'single-maintainer-gitflow') {
    const value = await createWorkflowRequiredSourceFixture(root, workflow, profile);
    const comparison = { repository: 'owner/repo', repositoryId: 123, baseSha: 'a'.repeat(40),
      baseTreeSha: 'b'.repeat(40), headSha: 'c'.repeat(40), headTreeSha: 'd'.repeat(40) };
    const prefix = '/repos/owner/repo';
    const comparePath = `${prefix}/compare/${comparison.baseSha}...${comparison.headSha}`;
    const diffPath = `${prefix}/dependency-graph/compare/${comparison.baseSha}...${comparison.headSha}`;
    const page = (number: number) => `${diffPath}?per_page=100&page=${number}`;
    const head = { sha: comparison.headSha, tree: { sha: comparison.headTreeSha } };
    const lineage = { status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1,
      base_commit: { sha: comparison.baseSha }, merge_base_commit: { sha: comparison.baseSha },
      commits: [{ sha: comparison.headSha }] };
    const entries = [change()];
    value.routes.set(`${prefix}/git/commits/${comparison.headSha}`, head);
    value.routes.set(comparePath, lineage);
    value.routes.set(page(1), entries);
    return { ...value, comparison, comparePath, diffPath, page, head, lineage, entries,
      request: () => observeSource5WorkflowDependencyReview({ context: value.context, runtime: value.runtime, comparison }) };
  }

  it.each([
    ['manual', 'single-maintainer-gitflow'], ['manual', 'team-gitflow'],
    ['openspec', 'single-maintainer-gitflow'], ['openspec', 'team-gitflow'],
    ['spec-kit', 'single-maintainer-gitflow'], ['spec-kit', 'team-gitflow']
  ] as const)('derives a stable actual GET-only diff for %s/%s without issuing current qualification', async (workflow, profile) => {
    const value = await fixture(workflow, profile);
    try {
      const result = await value.request();
      expect(result).toEqual({
        status: 'observed', comparison: value.comparison, graphHash: canonicalSha256(value.context.records.graph),
        diffDigest: canonicalSha256(value.entries), changes: { added: 1, removed: 0 },
        introducedVulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 },
        verdict: 'no-added-known-vulnerabilities', coverage: 'provider-dependency-diff-only',
        licensePolicy: 'not-evaluated', sourceRefCurrentness: 'not-observed', requiredContextSemantics: 'not-validated',
        prerequisiteSession: null, phaseProof: 'not-issued', execution: 'not-authorized'
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.comparison)).toBe(true);
      expect(Object.isFrozen(result.introducedVulnerabilities)).toBe(true);
      expect(value.processCalls()).toBe(0);
      expect(value.calls).toEqual([
        { method: 'GET', path: '/repos/owner/repo' },
        { method: 'GET', path: `/repos/owner/repo/git/commits/${value.comparison.baseSha}` },
        { method: 'GET', path: `/repos/owner/repo/git/commits/${value.comparison.headSha}` },
        { method: 'GET', path: value.comparePath }, { method: 'GET', path: value.page(1) },
        { method: 'GET', path: value.page(1) }, { method: 'GET', path: value.comparePath },
        { method: 'GET', path: '/repos/owner/repo' }
      ]);
    } finally { await value.close(); }
  });

  it.each(['critical', 'high', 'moderate', 'low'] as const)(
    'reports actual added %s advisories without threshold overrides or provider payload disclosure', async severity => {
      const value = await fixture();
      try {
        value.entries[0]!.vulnerabilities.push(advisory(severity));
        const result = await value.request();
        expect(result).toMatchObject({ verdict: 'added-known-vulnerabilities',
          introducedVulnerabilities: { [severity]: 1 }, phaseProof: 'not-issued', prerequisiteSession: null });
        expect(Object.values(result.introducedVulnerabilities).reduce((sum, count) => sum + count, 0)).toBe(1);
        expect(JSON.stringify(result)).not.toMatch(/Provider-only|GHSA-xxxx|actual-package|package-lock/);
      } finally { await value.close(); }
    });

  it('does not count removed vulnerabilities as introduced or silently ignore unknown dependency scopes', async () => {
    const value = await fixture();
    try {
      const removed = change('old-package', 'removed');
      removed.vulnerabilities.push(advisory('critical'));
      value.entries.push(removed);
      value.entries[0]!.scope = 'unknown';
      value.entries[0]!.vulnerabilities.push(advisory('low'));
      const result = await value.request();
      expect(result).toMatchObject({ verdict: 'added-known-vulnerabilities', changes: { added: 1, removed: 1 },
        introducedVulnerabilities: { critical: 0, high: 0, moderate: 0, low: 1 } });
    } finally { await value.close(); }
  });

  it('does not turn an empty stable diff into complete dependency coverage, license policy or context proof', async () => {
    const value = await fixture();
    try {
      value.entries.splice(0);
      expect(await value.request()).toMatchObject({
        verdict: 'no-added-known-vulnerabilities', changes: { added: 0, removed: 0 },
        coverage: 'provider-dependency-diff-only', licensePolicy: 'not-evaluated',
        requiredContextSemantics: 'not-validated', prerequisiteSession: null, phaseProof: 'not-issued'
      });
    } finally { await value.close(); }
  });

  it.each(['runtime', 'development', 'unknown'])('counts every added advisory occurrence in %s scope', async scope => {
    const value = await fixture();
    try {
      const second = change('another-package');
      second.scope = value.entries[0]!.scope = scope;
      second.vulnerabilities.push(advisory());
      value.entries[0]!.vulnerabilities.push(advisory());
      value.entries.push(second);
      expect(await value.request()).toMatchObject({
        verdict: 'added-known-vulnerabilities', introducedVulnerabilities: { high: 2 }, changes: { added: 2, removed: 0 }
      });
    } finally { await value.close(); }
  });

  it('preserves explicitly nullable provider metadata without claiming license or package-URL qualification', async () => {
    const value = await fixture();
    try {
      value.routes.set(value.page(1), [{ ...change(), package_url: null, license: null, source_repository_url: null }]);
      expect(await value.request()).toMatchObject({ verdict: 'no-added-known-vulnerabilities', licensePolicy: 'not-evaluated' });
    } finally { await value.close(); }
  });

  it.each([
    ['null', null], ['envelope', { changes: [] }],
    ['oversized', Array.from({ length: 101 }, (_, index) => change(`package-${index}`))]
  ])('refuses a %s diff page rather than assuming an empty inventory', async (_label, response) => {
      const value = await fixture();
      try {
        value.routes.set(value.page(1), response);
        await expect(value.request()).rejects.toMatchObject({ code: 'incomplete-pagination' });
      } finally { await value.close(); }
    });

  it('joins every literal bounded page and repeats the full inventory, including a short linked page', async () => {
    const value = await fixture();
    try {
      value.replyHeaders.set(value.page(1), {
        link: `<https://untrusted.invalid/not-a-request>; rel="next"`
      });
      const last = change('last-page');
      last.vulnerabilities.push(advisory());
      value.routes.set(value.page(2), [last]);
      expect(await value.request()).toMatchObject({
        verdict: 'added-known-vulnerabilities', changes: { added: 2, removed: 0 }, introducedVulnerabilities: { high: 1 }
      });
      expect(value.calls.filter(call => call.path.startsWith(value.diffPath)).map(call => call.path))
        .toEqual([value.page(1), value.page(2), value.page(1), value.page(2)]);
      expect(value.calls.every(call => call.method === 'GET' && call.path.startsWith('/repos/owner/repo'))).toBe(true);
    } finally { await value.close(); }
  });

  it('does not infer completeness from a full page lacking a next link', async () => {
    const value = await fixture();
    try {
      value.entries.splice(0, 1, ...Array.from({ length: 100 }, (_, index) => change(`package-${index}`)));
      value.routes.set(value.page(2), []);
      expect(await value.request()).toMatchObject({ changes: { added: 100, removed: 0 } });
      expect(value.calls.filter(call => call.path === value.page(2))).toHaveLength(2);
    } finally { await value.close(); }
  });

  it('retains the existing ten-page bound rather than accepting a potentially truncated thousand-row result', async () => {
    const value = await fixture();
    try {
      for (let page = 1; page <= 10; page++) value.routes.set(value.page(page),
        Array.from({ length: 100 }, (_, index) => change(`package-${page}-${index}`)));
      await expect(value.request()).rejects.toMatchObject({ code: 'incomplete-pagination' });
      expect(value.calls.filter(call => call.path.startsWith(value.diffPath))).toHaveLength(10);
    } finally { await value.close(); }
  });

  it.each(['first', 'later', 'reobserved'] as const)('refuses %s-page snapshot warnings without retry or decoding payloads into diagnostics', async position => {
    const value = await fixture();
    try {
      if (position === 'later') {
        value.replyHeaders.set(value.page(1), { link: '<https://api.github.com/next>; rel="next"' });
        value.routes.set(value.page(2), []);
      }
      const endpoint = position === 'later' ? value.page(2) : value.page(1);
      const warning = { 'x-github-dependency-graph-snapshot-warnings': Buffer.from('private provider warning').toString('base64') };
      if (position === 'reobserved') value.hooks.afterResponse = observed => {
        if (observed === endpoint) value.replyHeaders.set(endpoint, warning);
      };
      else value.replyHeaders.set(endpoint, warning);
      await expect(value.request()).rejects.toMatchObject({ code: 'workflow-dependency-review-snapshot' });
    } finally { await value.close(); }
  });

  it.each([401, 403, 404, 429, 500])('does not replace HTTP %s with an empty successful diff', async status => {
    const value = await fixture();
    try {
      value.replyStatuses.set(value.page(1), status);
      await expect(value.request()).rejects.toMatchObject({ code: 'provider-response', status });
      expect(value.calls.filter(call => call.path === value.page(1))).toHaveLength(1);
    } finally { await value.close(); }
  });

  it.each(['repository-id', 'repository-name', 'base-commit', 'base-tree', 'head-commit', 'head-tree'] as const)(
    'refuses actual %s substitution before diff inspection', async mutation => {
      const value = await fixture();
      try {
        if (mutation === 'repository-id') value.state.repository.id++;
        else if (mutation === 'repository-name') value.state.repository.full_name = 'other/repo';
        else if (mutation === 'base-commit') value.state.commit.sha = 'e'.repeat(40);
        else if (mutation === 'base-tree') value.state.commit.tree.sha = 'e'.repeat(40);
        else if (mutation === 'head-commit') value.head.sha = 'e'.repeat(40);
        else value.head.tree.sha = 'e'.repeat(40);
        await expect(value.request()).rejects.toMatchObject({
          code: mutation.startsWith('repository') ? 'workflow-dependency-review-repository' : 'workflow-dependency-review-commit'
        });
        expect(value.calls.some(call => call.path.startsWith(value.diffPath))).toBe(false);
      } finally { await value.close(); }
    });

  it.each(['diverged', 'merge-base', 'base', 'head', 'total', 'ahead', 'behind', 'duplicate', 'truncated'] as const)(
    'refuses %s lineage rather than silently comparing an alternate or incomplete range', async mutation => {
      const value = await fixture();
      try {
        if (mutation === 'diverged') value.lineage.status = 'diverged';
        else if (mutation === 'merge-base') value.lineage.merge_base_commit.sha = 'e'.repeat(40);
        else if (mutation === 'base') value.lineage.base_commit.sha = 'e'.repeat(40);
        else if (mutation === 'head') value.lineage.commits[0]!.sha = 'e'.repeat(40);
        else if (mutation === 'total') value.lineage.total_commits = 251;
        else if (mutation === 'ahead') value.lineage.ahead_by++;
        else if (mutation === 'behind') value.lineage.behind_by++;
        else if (mutation === 'duplicate') {
          value.lineage.commits.push({ sha: value.comparison.headSha });
          value.lineage.total_commits = value.lineage.ahead_by = 2;
        } else value.lineage.commits.splice(0);
        await expect(value.request()).rejects.toMatchObject({ code: 'workflow-dependency-review-lineage' });
      } finally { await value.close(); }
    });

  it.each([
    ['change_type', 'modified'], ['manifest', ''], ['ecosystem', null], ['name', 'bad\nname'], ['version', null],
    ['package_url', undefined], ['license', undefined], ['source_repository_url', undefined],
    ['scope', undefined], ['scope', 'production'], ['vulnerabilities', undefined], ['vulnerabilities', null],
    ['vulnerabilities', [{ ...advisory(), severity: 'unknown' }]],
    ['vulnerabilities', [{ ...advisory(), advisory_ghsa_id: 'unknown' }]],
    ['vulnerabilities', [{ ...advisory(), advisory_summary: '' }]],
    ['vulnerabilities', [{ ...advisory(), advisory_url: 'https://untrusted.invalid/advisory' }]],
    ['vulnerabilities', [advisory(), advisory()]]
  ])('refuses malformed or missing explicit %s metadata (%j)', async (key, replacement) => {
    const value = await fixture();
    try {
      value.routes.set(value.page(1), [{ ...change(), [String(key)]: replacement }]);
      await expect(value.request()).rejects.toMatchObject({ code: 'workflow-dependency-review-diff' });
    } finally { await value.close(); }
  });

  it('rejects repeated package-change identities across pages rather than double-counting or masking drift', async () => {
    const value = await fixture();
    try {
      value.replyHeaders.set(value.page(1), { link: '<https://api.github.com/next>; rel="next"' });
      value.routes.set(value.page(2), [change()]);
      await expect(value.request()).rejects.toMatchObject({ code: 'workflow-dependency-review-diff' });
    } finally { await value.close(); }
  });

  it.each(['diff', 'lineage', 'repository'] as const)('refuses %s drift on the final observation', async subject => {
    const value = await fixture();
    try {
      let count = 0;
      value.hooks.afterResponse = endpoint => {
        if (endpoint !== value.page(1)) return;
        count++;
        if (subject === 'diff' && count === 1) value.entries[0]!.vulnerabilities.push(advisory());
        else if (count === 2 && subject === 'lineage') {
          value.lineage.total_commits = value.lineage.ahead_by = 2;
          value.lineage.commits.unshift({ sha: 'e'.repeat(40) });
        } else if (count === 2 && subject === 'repository') value.state.repository.id++;
      };
      await expect(value.request()).rejects.toMatchObject({
        code: subject === 'repository' ? 'workflow-dependency-review-repository' : 'workflow-dependency-review-changed'
      });
    } finally { await value.close(); }
  });

  it('captures immutable comparison meaning before the first asynchronous provider observation', async () => {
    const value = await fixture();
    try {
      const original = { ...value.comparison };
      value.hooks.afterResponse = () => { value.comparison.headSha = 'e'.repeat(40); };
      expect((await value.request()).comparison).toEqual(original);
      expect(value.calls.some(call => call.path.includes('e'.repeat(40)))).toBe(false);
    } finally { await value.close(); }
  });

  it('rejects extra policy/report/command fields and input hooks without provider requests or hook execution', async () => {
    const value = await fixture(), hook = vi.fn(() => { throw new Error('Input hook must not execute.'); });
    try {
      const request = { context: value.context, runtime: value.runtime, comparison: value.comparison };
      const getter = { ...request }; Object.defineProperty(getter, 'comparison', { enumerable: true, get: hook });
      const hidden = { ...request }; Object.defineProperty(hidden, 'comparison', { enumerable: false });
      const comparisons = [
        { ...value.comparison, threshold: 'critical' }, { ...value.comparison, report: {} },
        { ...value.comparison, command: 'echo success' }, { ...value.comparison, baseSha: 'develop' },
        { ...value.comparison, headSha: value.comparison.baseSha }
      ];
      for (const candidate of [
        { ...request, proof: {} }, { ...request, reader: hook }, getter, hidden,
        new Proxy(request, { getPrototypeOf: hook }), Object.assign(Object.create({}), request)
      ]) await expect(observeSource5WorkflowDependencyReview(candidate)).rejects.toThrow();
      for (const comparison of comparisons) {
        await expect(observeSource5WorkflowDependencyReview({ ...request, comparison })).rejects.toThrow();
      }
      expect(hook).not.toHaveBeenCalled();
      expect(value.calls).toEqual([]);
    } finally { await value.close(); }
  });

  it('requires the original constructed context and read-only invocation namespace, never copied observations', async () => {
    const value = await fixture();
    try {
      await expect(observeSource5WorkflowDependencyReview({
        context: { ...value.context }, runtime: value.runtime, comparison: value.comparison
      })).rejects.toThrow();
      await expect(observeSource5WorkflowDependencyReview({
        context: value.context, runtime: { ...value.runtime }, comparison: value.comparison
      })).rejects.toMatchObject({ code: 'workflow-observation-runtime' });
      expect(value.calls).toEqual([]);
    } finally { await value.close(); }
  });

  it.each(['repository', 'repositoryId', 'baseSha', 'headTreeSha'] as const)('refuses invalid literal %s selectors before provider reads', async key => {
    const value = await fixture();
    try {
      const comparison = { ...value.comparison,
        ...key === 'repository' ? { repository: 'https://github.com/owner/repo' } :
          key === 'repositoryId' ? { repositoryId: 0 } : { [key]: 'main' } };
      await expect(observeSource5WorkflowDependencyReview({
        context: value.context, runtime: value.runtime, comparison
      })).rejects.toThrow();
      expect(value.calls).toEqual([]);
    } finally { await value.close(); }
  });

  it('retains the original absolute invocation cutoff across individually bounded successive reads', async () => {
    const value = await fixture();
    try {
      let now = Date.now() + 145_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      value.hooks.afterResponse = () => { now += 20_000; };
      await expect(value.request()).rejects.toMatchObject({ code: 'workflow-deadline' });
      expect(value.calls).toHaveLength(2);
      expect(value.calls.some(call => call.path.startsWith(value.diffPath))).toBe(false);
    } finally { await value.close(); }
  });

  it('rejects transport replacement during observation without issuing a partially observed verdict', async () => {
    const value = await fixture();
    try {
      value.hooks.afterResponse = () => { value.transport.request = async () => ({ status: 200, headers: {}, data: [] }); };
      await expect(value.request()).rejects.toMatchObject({ code: 'workflow-observation-runtime' });
      expect(value.calls).toHaveLength(1);
    } finally { await value.close(); }
  });
});
