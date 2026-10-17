import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  observeSource5WorkflowCodeScanning, observeSource5WorkflowCodeScanningSarif
} from '../src/governance-activation/workflow-source5-code-scanning.js';
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

  describe('fixed read-only provider SARIF subsets, never original-report or CodeQL authority', () => {
    async function sarifFixture(workflow: 'manual' | 'openspec' | 'spec-kit' = 'manual',
      profile: 'single-maintainer-gitflow' | 'team-gitflow' = 'single-maintainer-gitflow') {
      const value = await fixture(workflow, profile);
      const reportPath = '/repos/owner/repo/code-scanning/analyses/17';
      const report = {
        version: '2.1.0', $schema: 'https://untrusted.invalid/private-schema',
        runs: [{
          tool: { driver: { name: 'CodeQL', version: 'private-provider-version' } },
          results: [{ ruleId: 'private-rule', message: { text: 'private-source-snippet' },
            properties: { 'github/alertNumber': 23, 'github/alertUrl': 'https://github.com/owner/repo/security/code-scanning/23' } }],
          externalPropertyFileReferences: { results: [{ location: { uri: 'https://untrusted.invalid/private-results' } }] }
        }],
        private_future_field: 'opaque-provider-data'
      };
      value.routes.set(reportPath, report);
      return { ...value, reportPath, report,
        requestSarif: () => observeSource5WorkflowCodeScanningSarif({
          context: value.context, runtime: value.runtime, source: value.source
        }) };
    }

    it.each([
      ['manual', 'single-maintainer-gitflow'], ['manual', 'team-gitflow'],
      ['openspec', 'single-maintainer-gitflow'], ['openspec', 'team-gitflow'],
      ['spec-kit', 'single-maintainer-gitflow'], ['spec-kit', 'team-gitflow']
    ] as const)('reads actual SARIF HTTP subsets twice for %s/%s without granting report/tool authority', async (workflow, profile) => {
      const value = await sarifFixture(workflow, profile);
      try {
        const result = await value.requestSarif();
        expect(result).toMatchObject({
          status: 'blocked', source: value.source, inventoryDigest: canonicalSha256(value.entries),
          coverage: 'provider-analysis-metadata-and-sarif-subsets-only',
          authenticatedCodeQLProgram: null, authenticatedQuerySubjects: null, originalSarif: 'not-observed',
          completeLanguageAndQueryCoverage: 'not-validated', requiredContextSemantics: 'not-validated',
          prerequisiteSession: null, phaseProof: 'not-issued', execution: 'not-authorized',
          providerSarifSubsets: [{ analysisId: 17, analysisMetadataDigest: canonicalSha256(value.entries[0]),
            documentDigest: canonicalSha256(value.report), runCount: 1,
            readback: 'observed-twice-during-this-invocation' }]
        });
        expect(result.blockers.some(blocker => blocker.code === 'workflow-code-scanning-original-sarif-unavailable')).toBe(true);
        expect(JSON.stringify(result)).not.toMatch(/private-|opaque-provider|untrusted\.invalid|github\/alert/);
        expect(Object.isFrozen(result.providerSarifSubsets[0])).toBe(true);
        expect(value.calls).toHaveLength(18);
        expect(value.calls.slice(8, 10)).toEqual([
          { method: 'GET', path: value.reportPath }, { method: 'GET', path: value.reportPath }
        ]);
        for (const [index, call] of value.calls.entries()) {
          expect(call.method).toBe('GET');
          expect(value.acceptHeaders[index]).toBe(call.path === value.reportPath
            ? 'application/sarif+json' : 'application/vnd.github+json');
        }
        expect(value.processCalls()).toBe(0);
      } finally { await value.close(); }
    });

    it('retains all exact-source tool subsets but does not retrieve historical reports or external references', async () => {
      const value = await sarifFixture();
      try {
        value.entries.push(analysis(18, '__proto__'), { ...analysis(19, 'historical'), commit_sha: 'c'.repeat(40) });
        const other = { ...value.report, runs: [{ tool: { driver: { name: '__proto__' } } }] };
        const otherPath = '/repos/owner/repo/code-scanning/analyses/18';
        value.routes.set(otherPath, other);
        const result = await value.requestSarif();
        expect(result.analyses).toHaveLength(3);
        expect(result.providerSarifSubsets.map(report => report.analysisId)).toEqual([17, 18]);
        expect(result.providerSarifSubsets[1]!.documentDigest).toBe(canonicalSha256(other));
        expect(value.calls.filter(call => /^\/repos\/owner\/repo\/code-scanning\/analyses\//u.test(call.path))
          .map(call => call.path)).toEqual([value.reportPath, otherPath, value.reportPath, otherPath]);
        expect(value.calls.some(call => /tool_name|tool_guid|untrusted|analyses\/19/u.test(call.path))).toBe(false);
        expect(result.authenticatedCodeQLProgram).toBeNull();
      } finally { await value.close(); }
    });

    it.each(['empty', 'historical'] as const)('keeps %s inventory blocked without asserting a subset was observed', async kind => {
      const value = await sarifFixture();
      try {
        if (kind === 'empty') value.entries.splice(0);
        else value.entries[0]!.commit_sha = 'c'.repeat(40);
        const result = await value.requestSarif();
        expect(result).toMatchObject({ status: 'blocked', providerSarifSubsets: [],
          coverage: 'provider-analysis-metadata-only', originalSarif: 'not-observed' });
        expect(value.calls.some(call => call.path === value.reportPath)).toBe(false);
        expect(result.blockers.some(blocker => blocker.code === 'workflow-code-scanning-source-analysis-unavailable')).toBe(true);
      } finally { await value.close(); }
    });

    it('preserves an actual empty SARIF run array without turning it into successful scan coverage', async () => {
      const value = await sarifFixture();
      try {
        const report = { version: '2.1.0', runs: [] };
        value.routes.set(value.reportPath, report);
        expect(await value.requestSarif()).toMatchObject({ status: 'blocked', originalSarif: 'not-observed',
          completeLanguageAndQueryCoverage: 'not-validated',
          providerSarifSubsets: [{ analysisId: 17, documentDigest: canonicalSha256(report), runCount: 0 }] });
      } finally { await value.close(); }
    });

    it.each([
      analysis(), { version: '2.0', runs: [] }, { version: '2.1.0' }, { version: '2.1.0', runs: {} },
      { version: '2.1.0', runs: [null] }, { version: '2.1.0', runs: [{}] },
      { version: '2.1.0', runs: [{ tool: {} }] }, { version: '2.1.0', runs: [{ tool: { driver: { name: '' } } }] }
    ])('refuses metadata fallback or malformed SARIF envelopes %j', async report => {
      const value = await sarifFixture();
      try {
        value.routes.set(value.reportPath, report);
        await expect(value.requestSarif()).rejects.toMatchObject({ code: 'workflow-code-scanning-sarif' });
        expect(value.calls.filter(call => call.path === value.reportPath)).toHaveLength(1);
      } finally { await value.close(); }
    });

    it.each([401, 403, 404, 422, 429, 503])('retains SARIF HTTP%s without a JSON/metadata or empty-report fallback', async status => {
      const value = await sarifFixture();
      try {
        value.replyStatuses.set(value.reportPath, status);
        await expect(value.requestSarif()).rejects.toMatchObject({ code: 'provider-response', status });
        expect(value.calls.filter(call => call.path === value.reportPath)).toHaveLength(1);
      } finally { await value.close(); }
    });

    it.each(['result', 'unknown-field', 'run-count'] as const)('refuses an actually changed SARIF %s readback', async kind => {
      const value = await sarifFixture();
      try {
        let reads = 0;
        value.hooks.afterResponse = endpoint => {
          if (endpoint !== value.reportPath || ++reads !== 1) return;
          value.routes.set(value.reportPath, kind === 'result'
            ? { ...value.report, runs: [{ tool: { driver: { name: 'CodeQL' } }, results: [] }] }
            : kind === 'run-count' ? { ...value.report, runs: [] }
              : { ...value.report, private_future_field: 'changed-opaque-field' });
        };
        await expect(value.requestSarif()).rejects.toMatchObject({ code: 'workflow-code-scanning-sarif-changed' });
        expect(reads).toBe(2);
      } finally { await value.close(); }
    });

    it('refuses inventory rebinding around stable SARIF instead of accepting the second metadata snapshot', async () => {
      const value = await sarifFixture();
      try {
        value.hooks.afterResponse = endpoint => {
          if (endpoint === value.reportPath) value.entries[0]!.rules_count++;
        };
        await expect(value.requestSarif()).rejects.toMatchObject({ code: 'workflow-code-scanning-changed' });
      } finally { await value.close(); }
    });

    it.each(['repository', 'tree', 'ref'] as const)('rechecks the actual %s after SARIF reads', async kind => {
      const value = await sarifFixture();
      try {
        value.hooks.afterResponse = endpoint => {
          if (endpoint !== value.reportPath) return;
          if (kind === 'repository') value.state.repository.id++;
          if (kind === 'tree') value.state.commit.tree.sha = 'c'.repeat(40);
          if (kind === 'ref') value.branch.object.sha = 'c'.repeat(40);
        };
        await expect(value.requestSarif()).rejects.toMatchObject({ code: kind === 'tree'
          ? 'workflow-code-scanning-commit' : `workflow-code-scanning-${kind}` });
      } finally { await value.close(); }
    });

    it('keeps the original response size bound and withholds an oversized report', async () => {
      const value = await sarifFixture();
      try {
        value.routes.set(value.reportPath, { ...value.report, private_future_field: 'private-'.repeat(600_000) });
        const rejected = value.requestSarif();
        await expect(rejected).rejects.toMatchObject({ code: 'workflow-provider' });
        await expect(rejected).rejects.not.toThrow(/private-/);
      } finally { await value.close(); }
    });

    it('does not reset the original invocation deadline while reading subsets', async () => {
      const value = await sarifFixture(), now = Date.now();
      try {
        value.hooks.afterResponse = endpoint => {
          if (endpoint === value.reportPath) vi.spyOn(Date, 'now').mockReturnValue(now + 180_001);
        };
        await expect(value.requestSarif()).rejects.toMatchObject({ code: 'workflow-deadline' });
      } finally { vi.restoreAllMocks(); await value.close(); }
    });

    it('captures references before awaits and refuses caller reports, IDs, media, tools, hooks or substitute authority', async () => {
      const value = await sarifFixture();
      try {
        const original = { ...value.source };
        value.hooks.afterResponse = endpoint => { if (endpoint === '/repos/owner/repo') value.source.ref = 'main'; };
        expect((await value.requestSarif()).source).toEqual(original);
        value.calls.splice(0);
        const request = { context: value.context, runtime: value.runtime, source: original }, hook = vi.fn();
        const getter = { ...request }; Object.defineProperty(getter, 'source', { enumerable: true, get: hook });
        for (const input of [null, [], { ...request, report: value.report }, { ...request, analysisId: 17 },
          { ...request, representation: 'code-scanning-sarif' }, { ...request, tool: 'CodeQL' },
          { ...request, proof: {} }, getter, new Proxy(request, { getPrototypeOf: hook }),
          { ...request, context: { ...value.context } }, { ...request, runtime: { ...value.runtime } }]) {
          await expect(Reflect.apply(observeSource5WorkflowCodeScanningSarif, undefined, [input])).rejects.toThrow();
        }
        expect(hook).not.toHaveBeenCalled(); expect(value.calls).toEqual([]); expect(value.processCalls()).toBe(0);
      } finally { await value.close(); }
    });
  });
});
