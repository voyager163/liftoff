import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { observeSource5WorkflowCodeScanning } from '../src/governance-activation/workflow-source5-code-scanning.js';
import { createWorkflowRequiredSourceFixture } from './fixtures/workflow-required-source.js';

function analysis(id = 17, name = 'CodeQL') {
  return {
    id, ref: 'refs/heads/develop', commit_sha: 'a'.repeat(40),
    analysis_key: 'private-workflow-key', environment: '{"private":"provider environment"}',
    category: 'private-category', error: '', warning: '', created_at: '2026-01-01T00:00:00Z',
    results_count: 0, rules_count: 100, url: `https://api.github.com/repos/owner/repo/code-scanning/analyses/${id}`,
    sarif_id: 'private-original-upload-id', deletable: true,
    tool: { name, version: 'opaque-uploader-version', guid: null }
  };
}

describe('complete actual code-scanning metadata, never CodeQL or original-report authority', () => {
  let root: string;
  beforeAll(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-code-scanning-'))); });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  async function fixture(workflow: 'manual' | 'openspec' | 'spec-kit' = 'manual',
    profile: 'single-maintainer-gitflow' | 'team-gitflow' = 'single-maintainer-gitflow') {
    const value = await createWorkflowRequiredSourceFixture(root, workflow, profile);
    const source = { repository: value.source.repository, repositoryId: value.source.repositoryId,
      sourceSha: value.source.sourceSha, treeSha: value.source.treeSha, ref: 'develop' };
    const branchPath = '/repos/owner/repo/git/ref/heads/develop';
    const branch = { ref: 'refs/heads/develop', object: { type: 'commit', sha: source.sourceSha } };
    const listPath = '/repos/owner/repo/code-scanning/analyses?ref=refs/heads/develop';
    const page = (number: number) => `${listPath}&per_page=100&page=${number}`;
    const entries = [analysis()];
    value.routes.set(branchPath, branch); value.routes.set(page(1), entries);
    return { ...value, source, entries, branch, branchPath, listPath, page,
      request: () => observeSource5WorkflowCodeScanning({ context: value.context, runtime: value.runtime, source }) };
  }

  it.each([
    ['manual', 'single-maintainer-gitflow'], ['manual', 'team-gitflow'],
    ['openspec', 'single-maintainer-gitflow'], ['openspec', 'team-gitflow'],
    ['spec-kit', 'single-maintainer-gitflow'], ['spec-kit', 'team-gitflow']
  ] as const)('observes genuine GET-only metadata for %s/%s without qualifying a tool label', async (workflow, profile) => {
    const value = await fixture(workflow, profile);
    try {
      const result = await value.request();
      expect(result).toMatchObject({
        status: 'blocked', source: value.source, graphHash: canonicalSha256(value.context.records.graph),
        inventoryDigest: canonicalSha256(value.entries), selectedSourceAnalyses: 1,
        coverage: 'provider-analysis-metadata-only', sourceRefReadback: 'observed-during-this-invocation',
        authenticatedCodeQLProgram: null, authenticatedQuerySubjects: null, originalSarif: 'not-observed',
        completeLanguageAndQueryCoverage: 'not-validated', requiredContextSemantics: 'not-validated',
        prerequisiteSession: null, phaseProof: 'not-issued', execution: 'not-authorized'
      });
      expect(result.analyses).toEqual([{
        id: 17, commitSha: value.source.sourceSha, matchesSelectedSource: true,
        analysisKeyDigest: canonicalSha256(value.entries[0]!.analysis_key),
        environmentDigest: canonicalSha256(value.entries[0]!.environment),
        categoryDigest: canonicalSha256(value.entries[0]!.category),
        createdAt: value.entries[0]!.created_at, resultsCount: 0, rulesCount: 100,
        toolMetadataDigest: canonicalSha256(value.entries[0]!.tool),
        providerReportedError: false, providerReportedWarning: false, metadataDigest: canonicalSha256(value.entries[0])
      }]);
      expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.analyses[0])).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/private-|provider environment|opaque-uploader/);
      expect(value.processCalls()).toBe(0);
      expect(value.calls).toEqual([
        { method: 'GET', path: '/repos/owner/repo' },
        { method: 'GET', path: `/repos/owner/repo/git/commits/${value.source.sourceSha}` },
        { method: 'GET', path: value.branchPath }, { method: 'GET', path: value.page(1) },
        { method: 'GET', path: value.page(1) }, { method: 'GET', path: value.branchPath },
        { method: 'GET', path: `/repos/owner/repo/git/commits/${value.source.sourceSha}` },
        { method: 'GET', path: '/repos/owner/repo' }
      ]);
    } finally { await value.close(); }
  });
  it('retains CodeQL-named, unknown and __proto__ tools without filtering or authenticating any of them', async () => {
    const value = await fixture();
    try {
      value.entries.push(analysis(18, 'unknown uploader'), analysis(19, '__proto__'));
      value.entries[0]!.rules_count = 0;
      const result = await value.request();
      expect(result.analyses.map(item => item.id)).toEqual([17, 18, 19]);
      expect(result.analyses.map(item => item.toolMetadataDigest)).toEqual(value.entries.map(item => canonicalSha256(item.tool)));
      expect(result).toMatchObject({ status: 'blocked', authenticatedCodeQLProgram: null,
        selectedSourceAnalyses: 3, requiredContextSemantics: 'not-validated', prerequisiteSession: null });
      expect(value.calls.some(call => /tool_name|tool_guid|alerts|sarif/u.test(call.path))).toBe(false);
    } finally { await value.close(); }
  });
  it.each(['empty', 'historical', 'mixed', 'zero-rules', 'positive-results'] as const)(
    'preserves actual %s metadata without inventing source or query coverage', async kind => {
      const value = await fixture();
      try {
        if (kind === 'empty') value.entries.splice(0);
        if (kind === 'historical') value.entries[0]!.commit_sha = 'c'.repeat(40);
        if (kind === 'mixed') value.entries.push({ ...analysis(18), commit_sha: 'c'.repeat(40) });
        if (kind === 'zero-rules') value.entries[0]!.rules_count = 0;
        if (kind === 'positive-results') value.entries[0]!.results_count = 5;
        const result = await value.request();
        expect(result.status).toBe('blocked'); expect(result.analyses).toHaveLength(value.entries.length);
        expect(result.selectedSourceAnalyses).toBe(kind === 'empty' || kind === 'historical' ? 0 : 1);
        expect(result.blockers.some(item => item.code === 'workflow-code-scanning-source-analysis-unavailable'))
          .toBe(kind === 'empty' || kind === 'historical');
        expect(result).toMatchObject({ originalSarif: 'not-observed', completeLanguageAndQueryCoverage: 'not-validated',
          phaseProof: 'not-issued', prerequisiteSession: null });
      } finally { await value.close(); }
    });
  it.each(['error', 'warning'] as const)('retains actual %s refusal without disclosing provider diagnostic contents', async field => {
    const value = await fixture();
    try {
      value.entries[0]![field] = 'private-provider-diagnostic\nsecond line';
      const result = await value.request();
      expect(result.blockers.some(item => item.code === 'workflow-code-scanning-diagnostics')).toBe(true);
      expect(result.analyses[0]).toMatchObject({ [field === 'error' ? 'providerReportedError' : 'providerReportedWarning']: true });
      expect(JSON.stringify(result)).not.toContain('private-provider-diagnostic');
    } finally { await value.close(); }
  });
  it('distinguishes absent optional categories and explicit nullable tool subjects from invented defaults', async () => {
    const value = await fixture();
    try {
      const { category: _category, ...entry } = analysis();
      value.routes.set(value.page(1), [{ ...entry, tool: { name: 'CodeQL', version: null, guid: null } }]);
      const result = await value.request();
      expect(result.analyses[0]).not.toHaveProperty('categoryDigest');
      expect(result.analyses[0]!.toolMetadataDigest).toBe(canonicalSha256({ name: 'CodeQL', version: null, guid: null }));
      expect(result.authenticatedCodeQLProgram).toBeNull();
    } finally { await value.close(); }
  });
  it.each(['empty-analysis-key', 'empty-sarif-id', 'empty-category', 'missing-tool-fields', 'empty-tool-fields', 'empty-tool-object'] as const)(
    'retains documented %s metadata without requiring invented tool subjects', async kind => {
      const value = await fixture();
      try {
        const original = analysis();
        const entry = kind === 'empty-analysis-key' ? { ...original, analysis_key: '' }
          : kind === 'empty-sarif-id' ? { ...original, sarif_id: '' }
            : kind === 'empty-category' ? { ...original, category: '' }
              : { ...original, tool: kind === 'missing-tool-fields' ? { name: 'CodeQL' }
                : kind === 'empty-tool-fields' ? { name: '', version: '', guid: '' } : {} };
        value.routes.set(value.page(1), [entry]);
        const result = await value.request();
        expect(result).toMatchObject({ status: 'blocked', authenticatedCodeQLProgram: null,
          authenticatedQuerySubjects: null, originalSarif: 'not-observed', selectedSourceAnalyses: 1 });
        expect(result.analyses[0]!.metadataDigest).toBe(canonicalSha256(entry));
        expect(result.analyses[0]!.toolMetadataDigest).toBe(canonicalSha256(entry.tool));
      } finally { await value.close(); }
    });
  it.each([
    { id: 0 }, { id: 1.5 }, { id: '17' }, { ref: 'refs/heads/other' }, { commit_sha: 'main' },
    { analysis_key: null }, { environment: null }, { environment: 'line\nbreak' }, { category: null },
    { error: null }, { warning: undefined }, { created_at: 'not-a-date' },
    { results_count: -1 }, { rules_count: 1.5 }, { url: 'https://untrusted.invalid/private' },
    { sarif_id: null }, { deletable: 'true' }, { tool: null }, { tool: { name: 'CodeQL', version: 17 } },
    { tool: { name: 17, version: null, guid: null } }
  ])('refuses malformed or foreign analysis metadata %j without promoting a partial list', async patch => {
    const value = await fixture();
    try {
      value.routes.set(value.page(1), [{ ...analysis(), ...patch }]);
      await expect(value.request()).rejects.toMatchObject({ code: 'workflow-code-scanning-analysis' });
    } finally { await value.close(); }
  });
  it.each(['null', 'envelope', 'oversized', 'duplicate'] as const)('refuses %s inventory shape', async kind => {
    const value = await fixture();
    try {
      value.routes.set(value.page(1), kind === 'null' ? null : kind === 'envelope' ? { analyses: [] }
        : kind === 'oversized' ? Array.from({ length: 101 }, (_, index) => analysis(index + 1)) : [analysis(), analysis()]);
      await expect(value.request()).rejects.toMatchObject({
        code: kind === 'duplicate' ? 'workflow-code-scanning-analysis' : 'incomplete-pagination'
      });
    } finally { await value.close(); }
  });
  it('repeats every literal page and ignores a provider-controlled next URL', async () => {
    const value = await fixture();
    try {
      value.replyHeaders.set(value.page(1), { link: '<https://untrusted.invalid/private>; rel="next"' });
      value.routes.set(value.page(2), [analysis(18, 'unknown')]);
      expect((await value.request()).analyses.map(item => item.id)).toEqual([17, 18]);
      expect(value.calls.filter(call => call.path.startsWith(value.listPath)).map(call => call.path))
        .toEqual([value.page(1), value.page(2), value.page(1), value.page(2)]);
    } finally { await value.close(); }
  });
  it('does not infer a full page is complete or accept a potentially truncated thousand-row scope', async () => {
    const value = await fixture();
    try {
      value.routes.set(value.page(1), Array.from({ length: 100 }, (_, index) => analysis(index + 1)));
      value.routes.set(value.page(2), []);
      expect((await value.request()).analyses).toHaveLength(100);
      for (let page = 2; page <= 10; page++) value.routes.set(value.page(page),
        Array.from({ length: 100 }, (_, index) => analysis((page - 1) * 100 + index + 1)));
      await expect(value.request()).rejects.toMatchObject({ code: 'incomplete-pagination' });
    } finally { await value.close(); }
  });
  it.each([401, 403, 404, 429, 500])('retains HTTP%s instead of an empty successful scan', async status => {
    const value = await fixture();
    try {
      value.replyStatuses.set(value.page(1), status);
      await expect(value.request()).rejects.toMatchObject({ code: 'provider-response', status });
      expect(value.calls.filter(call => call.path === value.page(1))).toHaveLength(1);
    } finally { await value.close(); }
  });
  it.each(['repository-id', 'repository-name', 'commit', 'tree', 'ref-name', 'ref-type', 'ref-sha'] as const)(
    'refuses initial and late %s substitution without a readback fallback', async kind => {
      for (const late of [false, true]) {
        const value = await fixture();
        try {
          const mutate = () => {
            if (kind === 'repository-id') value.state.repository.id++;
            if (kind === 'repository-name') value.state.repository.full_name = 'other/repo';
            if (kind === 'commit') value.state.commit.sha = 'c'.repeat(40);
            if (kind === 'tree') value.state.commit.tree.sha = 'c'.repeat(40);
            if (kind === 'ref-name') value.branch.ref = 'refs/heads/other';
            if (kind === 'ref-type') value.branch.object.type = 'tag';
            if (kind === 'ref-sha') value.branch.object.sha = 'c'.repeat(40);
          };
          if (late) value.hooks.afterResponse = observed => { if (observed === value.page(1)) mutate(); };
          else mutate();
          await expect(value.request()).rejects.toMatchObject({ code: kind.startsWith('repository') ? 'workflow-code-scanning-repository'
            : kind.startsWith('ref') ? 'workflow-code-scanning-ref' : 'workflow-code-scanning-commit' });
        } finally { await value.close(); }
      }
    });
  it.each(['changed', 'added', 'removed', 'unknown-field'] as const)('refuses an actually %s reobserved inventory', async kind => {
    const value = await fixture();
    try {
      let count = 0;
      value.hooks.afterResponse = observed => {
        if (observed !== value.page(1) || ++count !== 1) return;
        if (kind === 'changed') value.entries[0]!.results_count++;
        if (kind === 'added') value.entries.push(analysis(18));
        if (kind === 'removed') value.entries.splice(0);
        if (kind === 'unknown-field') value.routes.set(value.page(1), [{ ...analysis(), opaque_future_metadata: 'changed' }]);
      };
      await expect(value.request()).rejects.toMatchObject({ code: 'workflow-code-scanning-changed' });
    } finally { await value.close(); }
  });
  it('captures the source selectors before awaits and refuses report/tool/command/authority inputs or hooks', async () => {
    const value = await fixture();
    try {
      const original = { ...value.source };
      value.hooks.afterResponse = observed => { if (observed === '/repos/owner/repo') value.source.ref = 'main'; };
      expect((await value.request()).source).toEqual(original);
      value.calls.splice(0);
      const request = { context: value.context, runtime: value.runtime, source: original }, hook = vi.fn();
      const getter = { ...request }; Object.defineProperty(getter, 'source', { enumerable: true, get: hook });
      for (const input of [null, [], { ...request, report: {} }, { ...request, tool: 'CodeQL' },
        { ...request, proof: {} }, { ...request, command: 'echo pass' }, getter,
        new Proxy(request, { getPrototypeOf: hook }), { ...request, context: { ...value.context } },
        { ...request, runtime: { ...value.runtime } }, { ...request, source: { ...original, observedAt: '2026-01-01' } },
        { ...request, source: { ...original, sourceSha: 'develop' } }]) {
        await expect(Reflect.apply(observeSource5WorkflowCodeScanning, undefined, [input])).rejects.toThrow();
      }
      expect(hook).not.toHaveBeenCalled(); expect(value.calls).toEqual([]); expect(value.processCalls()).toBe(0);
    } finally { await value.close(); }
  });
});
