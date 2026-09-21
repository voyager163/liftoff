import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { normalizeCodeqlSarif, sourceCodeqlReportingPayload, type CodeqlScope } from '../scripts/repository-security/codeql.ts';
import { planCodeqlReporting, prepareSourceCodeqlUpload, proposedNativeCodeqlProtection } from '../scripts/repository-security/codeql-reporting.ts';
import { evaluateSecurityReport, findingDigest } from '../scripts/repository-security/evidence.ts';

const hash = `sha256:${'a'.repeat(64)}`;
const scope: CodeqlScope = {
  category: 'source/javascript-typescript', role: 'source-findings',
  identity: {
    repository: 'voyager163/liftoff', event: 'pull_request', sourceSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40), workflowSha: 'c'.repeat(40), runId: '123', attempt: 1,
    policyDigest: hash, inventoryDigest: hash, configurationDigest: hash
  },
  tool: { name: 'CodeQL', version: '2.0.0', database: 'fixture-query-pack' },
  unit: { id: 'source', inputDigest: hash, count: 1, platform: 'all' },
  sourcePaths: [['src', 'example.ts']], extractedPaths: [['src', 'example.ts']], nonSecurityRules: []
};

function sarif() {
  return {
    version: '2.1.0',
    runs: [{
      automationDetails: { id: scope.category },
      tool: { driver: { name: 'CodeQL', semanticVersion: '2.0.0',
        rules: [{ id: 'js/fixture', properties: { 'security-severity': '8.0' } }] } },
      invocations: [{ executionSuccessful: true, startTimeUtc: '2026-09-20T11:00:00Z', endTimeUtc: '2026-09-20T11:01:00Z' }],
      artifacts: [{ location: { uri: 'src/example.ts' } }],
      results: [{
        ruleId: 'js/fixture', message: { text: 'PRIVATE_SOURCE_SENTINEL' },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'src/example.ts' }, region: { startLine: 10 } } }]
      }]
    }]
  };
}

describe('CodeQL finding evaluation independent of analysis success', () => {
  it('rebuilds source reporting from validated locations without source messages, snippets or code flows', () => {
    const data = sarif();
    Object.assign(data.runs[0]!.results[0]!, {
      codeFlows: [{ threadFlows: [{ locations: [{ location: { message: { text: 'PRIVATE_SOURCE_SENTINEL' } } }] }] }]
    });
    const value = sourceCodeqlReportingPayload(JSON.stringify(data), scope);
    const uploaded = JSON.parse(value.sarif);
    expect(value.findingCount).toBe(1);
    expect(uploaded.runs[0].results[0]).toMatchObject({
      ruleId: 'js/fixture', locations: [{ physicalLocation: {
        artifactLocation: { uri: 'src/example.ts' }, region: { startLine: 10 }
      } }]
    });
    expect(value.sarif).not.toContain('PRIVATE_SOURCE_SENTINEL');
    expect(value.sarif).not.toContain('codeFlows');
    expect(value).toMatchObject({ findingsEvaluated: false, uploadPerformed: false, hostedProtectionQualified: false });
    expect(() => sourceCodeqlReportingPayload(JSON.stringify(data), { ...scope, role: 'generated-findings' }))
      .toThrow('source-only');
    const trailing = structuredClone(data);
    trailing.runs[0]!.automationDetails.id += '/';
    expect(sourceCodeqlReportingPayload(JSON.stringify(trailing), { ...scope, category: `${scope.category}/` }).findingCount).toBe(1);
  });

  it('keeps fork/Dependabot reporting unprivileged and never substitutes upload for local findings', () => {
    for (const [fork, dependabot] of [[true, false], [false, true], [false, false]]) {
      const result = planCodeqlReporting({ identity: scope.identity, ref: 'refs/pull/1/merge', fork, dependabot });
      expect(result).toMatchObject({
        permissions: { contents: 'read' }, localAnalysisRequired: true, localFindingEvaluationRequired: true,
        privilegedFallback: false, publisherAuthority: false, findingStatusChangedByUpload: false,
        candidateCodeExecutionInReportingJob: true
      });
      expect(result.permissions).not.toHaveProperty('security-events');
    }
    expect(() => planCodeqlReporting({
      identity: scope.identity, ref: 'refs/pull/1/merge', fork: true, dependabot: false, nativeUploadQualified: true
    })).toThrow('context');
    expect(proposedNativeCodeqlProtection).toMatchObject({
      setup: 'advanced', defaultSetupDependabotExempt: true, mergeQueueGroupsExempt: true,
      diffLocationsRequiredByNativeProtection: true, hostedMutationPerformed: false, observedRequiredContexts: []
    });
  });

  it('prepares only the documented source-bound API body without credentials, raw source or network effects', () => {
    const result = prepareSourceCodeqlUpload(JSON.stringify(sarif()), scope, {
      ref: 'refs/pull/1/merge', fork: true, dependabot: false
    });
    expect(Object.keys(result.request.body).sort()).toEqual(['commit_sha', 'ref', 'sarif', 'tool_name', 'validate']);
    expect(result.request.body.commit_sha).toBe(scope.identity.sourceSha);
    const decoded = gunzipSync(Buffer.from(result.request.body.sarif, 'base64')).toString();
    expect(decoded).not.toContain('PRIVATE_SOURCE_SENTINEL');
    expect(JSON.parse(decoded).runs[0].results).toHaveLength(1);
    expect(result).toMatchObject({ readyForLiveUpload: false, networkPerformed: false, findingVerdictChanged: false });
    expect(() => prepareSourceCodeqlUpload(JSON.stringify(sarif()), {
      ...scope, identity: { ...scope.identity, repository: 'different/repository' }
    }, { ref: 'refs/pull/1/merge', fork: true, dependabot: false })).toThrow('reporting-repository');
  });

  it('retains only supported native line fingerprints and supplies required static rule help without inventing precision', () => {
    const input = sarif();
    Object.assign(input.runs[0]!.results[0]!, {
      partialFingerprints: { primaryLocationLineHash: '1234567890abcdef:1', privateMetadata: 'PRIVATE_SOURCE_SENTINEL' }
    });
    const result = sourceCodeqlReportingPayload(JSON.stringify(input), scope), data = JSON.parse(result.sarif);
    expect(result.nativeFingerprintCount).toBe(1);
    expect(data.runs[0].results[0].partialFingerprints.primaryLocationLineHash).toBe('1234567890abcdef:1');
    expect(data.runs[0].tool.driver.rules[0]).toMatchObject({
      fullDescription: { text: 'Source security finding detected by CodeQL.' },
      help: { text: 'Consult the matching local finding-policy assessment and the identified CodeQL rule.' },
      properties: { tags: ['security'], 'security-severity': '8.0' }
    });
    expect(data.runs[0].tool.driver.rules[0].properties).not.toHaveProperty('precision');
    expect(result.sarif).not.toContain('PRIVATE_SOURCE_SENTINEL');
    expect(sourceCodeqlReportingPayload(JSON.stringify(sarif()), scope).nativeFingerprintCount).toBe(0);
  });

  it('keeps finding comparison identity independent of commit/run provenance', () => {
    const first = normalizeCodeqlSarif(JSON.stringify(sarif()), scope);
    const changed = sarif();
    Object.assign(changed.runs[0]!.results[0]!, { guid: 'per-run-guid', correlationGuid: 'per-run-correlation' });
    const second = normalizeCodeqlSarif(JSON.stringify(changed), {
      ...scope, identity: {
        ...scope.identity, sourceSha: 'd'.repeat(40), baseSha: 'e'.repeat(40), runId: '456', attempt: 2,
        policyDigest: `sha256:${'f'.repeat(64)}`
      }
    });
    expect(second.identity).not.toEqual(first.identity);
    expect(second.findings).toEqual(first.findings);
    expect(findingDigest(second.findings[0]!)).toBe(findingDigest(first.findings[0]!));
    expect(second.findings[0]!.version).toBe(scope.unit.inputDigest);
    for (const changedScope of [
      { ...scope, unit: { ...scope.unit, inputDigest: `sha256:${'d'.repeat(64)}` } },
      { ...scope, identity: { ...scope.identity, configurationDigest: `sha256:${'d'.repeat(64)}` } },
      { ...scope, tool: { ...scope.tool, database: 'other-query-pack' } }
    ]) {
      expect(normalizeCodeqlSarif(JSON.stringify(sarif()), changedScope).findings[0]!.id)
        .not.toBe(first.findings[0]!.id);
    }
  });

  it('requires the entire independently resolved query set when supplied', () => {
    expect(normalizeCodeqlSarif(JSON.stringify(sarif()), { ...scope, expectedRules: ['js/fixture'] }).complete).toBe(true);
    for (const expectedRules of [[], ['js/missing'], ['js/fixture', 'js/missing'], ['js/fixture', 'js/fixture']]) {
      expect(() => normalizeCodeqlSarif(JSON.stringify(sarif()), { ...scope, expectedRules }))
        .toThrow('codeql-query-coverage-mismatch');
    }
  });

  it('separates known ancillary descriptors from complete security-rule representation', () => {
    const data = sarif();
    const extended = { ...data, runs: [{ ...data.runs[0], tool: { driver: {
      ...data.runs[0]!.tool.driver, rules: [...data.runs[0]!.tool.driver.rules,
        { id: 'js/summary/lines-of-code', properties: { tags: ['summary'] } }]
    } } }] };
    const selected = { ...scope, expectedRules: ['js/fixture'], nonSecurityRules: ['js/summary/lines-of-code'] };
    expect(normalizeCodeqlSarif(JSON.stringify(extended), selected).findings).toHaveLength(1);
    expect(() => normalizeCodeqlSarif(JSON.stringify(extended), { ...selected, requireDriverRules: true }))
      .not.toThrow();
    expect(normalizeCodeqlSarif(JSON.stringify(data), selected).findings).toHaveLength(1);
    expect(() => normalizeCodeqlSarif(JSON.stringify(extended), { ...selected, nonSecurityRules: [] }))
      .toThrow('codeql-query-coverage-mismatch');
    expect(() => normalizeCodeqlSarif(JSON.stringify(data), { ...selected, nonSecurityRules: ['js/fixture'] }))
      .toThrow('codeql-rule-classification-mismatch');
  });

  it('resolves extension rule indexes within their exact pinned tool component', () => {
    const data = sarif(), run = data.runs[0]!;
    const selected = { ...scope, tool: { ...scope.tool, database: 'codeql/javascript-queries@2.4.5' },
      expectedRules: ['js/fixture'] };
    const extended = { ...data, runs: [{ ...run,
      tool: { driver: { ...run.tool.driver, rules: [] }, extensions: [
        { name: 'codeql/javascript-queries', version: '2.4.5', rules: run.tool.driver.rules }
      ] },
      results: [{ ...run.results[0], rule: { index: 0, toolComponent: { index: 0, name: 'codeql/javascript-queries' } } }]
    }] };
    expect(normalizeCodeqlSarif(JSON.stringify(extended), selected).findings).toHaveLength(1);
    expect(() => normalizeCodeqlSarif(JSON.stringify(extended), { ...selected, requireDriverRules: true }))
      .toThrow('codeql-rule-layout-mismatch');
    for (const mutate of [
      (value: typeof extended) => { value.runs[0]!.tool.extensions[0]!.version = '2.4.6'; },
      (value: typeof extended) => { value.runs[0]!.results[0]!.rule.index = 1; },
      (value: typeof extended) => { value.runs[0]!.results[0]!.rule.toolComponent.index = 1; },
      (value: typeof extended) => { value.runs[0]!.results[0]!.rule.toolComponent.name = 'other'; }
    ]) {
      const changed = structuredClone(extended); mutate(changed);
      expect(() => normalizeCodeqlSarif(JSON.stringify(changed), selected)).toThrow();
    }
    const topLevelIndex = { ...extended, runs: [{ ...extended.runs[0],
      results: extended.runs[0]!.results.map(result => ({ ...result, ruleIndex: 0 })) }] };
    expect(() => normalizeCodeqlSarif(JSON.stringify(topLevelIndex), selected)).toThrow('unknown-codeql-rule');
  });

  it('handles standard unspecified indexes without changing the selected component', () => {
    const data = sarif();
    const result = data.runs[0]!.results[0]!;
    for (const toolComponent of [{ name: 'CodeQL' }, { name: 'CodeQL', index: -1 }, { index: -1 }]) {
      const value = { ...data, runs: [{ ...data.runs[0],
        results: [{ ...result, ruleIndex: -1, rule: { id: 'js/fixture', index: -1, toolComponent } }] }] };
      expect(normalizeCodeqlSarif(JSON.stringify(value), scope).findings).toHaveLength(1);
    }
    for (const toolComponent of [{ name: 'unknown', index: -1 }, { name: 'CodeQL', index: -2 }]) {
      const value = { ...data, runs: [{ ...data.runs[0],
        results: [{ ...result, rule: { id: 'js/fixture', toolComponent } }] }] };
      expect(() => normalizeCodeqlSarif(JSON.stringify(value), scope)).toThrow('unknown-codeql-component');
    }
  });

  it('does not confuse empty dependency-pack metadata with a rule-bearing component', () => {
    const data = sarif(), run = data.runs[0]!;
    const extended = { ...data, runs: [{ ...run, tool: {
      ...run.tool, extensions: [{ name: 'PRIVATE_SOURCE_SENTINEL', version: '2.0.0', rules: [] }]
    } }] };
    const result = normalizeCodeqlSarif(JSON.stringify(extended), scope);
    expect(result.findings).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SOURCE_SENTINEL');
    const missingRule = { ...extended, runs: [{ ...extended.runs[0],
      results: [{ ...run.results[0], ruleIndex: -1, rule: { index: 0, toolComponent: { index: 0 } } }] }] };
    expect(() => normalizeCodeqlSarif(JSON.stringify(missingRule), scope)).toThrow('unknown-codeql-rule');
    const hiddenRule = { ...extended, runs: [{ ...extended.runs[0], tool: {
      ...extended.runs[0]!.tool, extensions: [{ name: 'unregistered', version: '2.0.0', rules: run.tool.driver.rules }]
    } }] };
    expect(() => normalizeCodeqlSarif(JSON.stringify(hiddenRule), scope)).toThrow('codeql-extension-mismatch');
  });

  it('accepts native omitted times only with matching independently captured execution', () => {
    const data = sarif();
    const native = JSON.stringify({
      ...data, runs: [{ ...data.runs[0], invocations: [{ executionSuccessful: true }] }]
    });
    const execution = {
      category: scope.category, toolVersion: scope.tool.version,
      reportDigest: `sha256:${createHash('sha256').update(native).digest('hex')}`,
      startedAt: '2026-09-20T11:00:00.000Z', completedAt: '2026-09-20T11:01:00.000Z', exitCode: 0
    };
    expect(() => normalizeCodeqlSarif(native, scope)).toThrow('missing-sarif-time');
    const report = normalizeCodeqlSarif(native, { ...scope, execution });
    expect(report.generatedAt).toBe(execution.startedAt);
    expect(report.completedAt).toBe(execution.completedAt);
    for (const changed of [
      { exitCode: 1 }, { category: 'other' }, { toolVersion: '0.0.0' },
      { reportDigest: `sha256:${'0'.repeat(64)}` }
    ]) {
      expect(() => normalizeCodeqlSarif(native, { ...scope, execution: { ...execution, ...changed } }))
        .toThrow('codeql-execution-mismatch');
    }
    expect(() => normalizeCodeqlSarif(native, {
      ...scope, execution: { ...execution, completedAt: '2026-09-20T10:00:00.000Z' }
    })).toThrow('codeql-execution-time-order');
  });

  it('never overwrites contradictory native execution fields with wrapper success', () => {
    for (const invocation of [
      { executionSuccessful: false },
      { executionSuccessful: true, exitCode: 2 },
      { executionSuccessful: true, startTimeUtc: null },
      { executionSuccessful: true, startTimeUtc: '2026-09-19T11:00:00Z' },
      { executionSuccessful: true, toolExecutionNotifications: [{ level: 'error' }] }
    ]) {
      const data = sarif();
      const native = JSON.stringify({ ...data, runs: [{ ...data.runs[0], invocations: [invocation] }] });
      expect(() => normalizeCodeqlSarif(native, {
        ...scope, execution: {
          category: scope.category, toolVersion: scope.tool.version,
          reportDigest: `sha256:${createHash('sha256').update(native).digest('hex')}`,
          startedAt: '2026-09-20T11:00:00.000Z', completedAt: '2026-09-20T11:01:00.000Z', exitCode: 0
        }
      })).toThrow();
    }
  });

  it('keeps distinct same-line regions and result identities without duplicating equivalent results', () => {
    const data = sarif();
    const original = data.runs[0]!.results[0]!;
    const atColumn = (column: number) => ({
      ...original, partialFingerprints: { 'primaryLocationLineHash/v1': 'same-line' },
      locations: [{ physicalLocation: {
        artifactLocation: { uri: 'src/example.ts' },
        region: { startLine: 10, startColumn: column, endLine: 10, endColumn: column + 1 }
      } }]
    });
    const first = atColumn(1), second = atColumn(20);
    const differentResult = { ...first, message: { text: 'Distinct flow without a unique location fingerprint.' } };
    const input = { ...data, runs: [{ ...data.runs[0], results: [first, second, first, differentResult] }] };
    const normalized = normalizeCodeqlSarif(JSON.stringify(input), scope);
    expect(normalized.findings).toHaveLength(3);
    expect(new Set(normalized.findings.map(finding => finding.id)).size).toBe(3);
    expect(JSON.stringify(normalized)).not.toContain('Distinct flow');
    const reverseKeys = { ...first, partialFingerprints: { beta: 'two', alpha: 'one' } };
    const orderedKeys = { ...first, partialFingerprints: { alpha: 'one', beta: 'two' } };
    expect(normalizeCodeqlSarif(JSON.stringify({
      ...data, runs: [{ ...data.runs[0], results: [reverseKeys, orderedKeys] }]
    }), scope).findings).toHaveLength(1);
  });

  it('blocks a high finding despite successful analysis and excludes raw message content', () => {
    const report = normalizeCodeqlSarif(JSON.stringify(sarif()), scope);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_SOURCE_SENTINEL');
    const result = evaluateSecurityReport(report, {
      identity: scope.identity, role: scope.role, tool: scope.tool, units: [scope.unit]
    }, { blockingRules: [], exceptions: [] }, new Date('2026-09-20T12:00:00Z'));
    expect(result.passed).toBe(false);
    expect(result.blocking).toHaveLength(1);
  });

  it('does not require a PR-diff location and accepts an actually empty finding set only with coverage', () => {
    const data = sarif();
    const report = normalizeCodeqlSarif(JSON.stringify(data), scope);
    expect(report.findings[0]?.location).toEqual(['src', 'example.ts']);
    data.runs[0]!.results = [];
    expect(normalizeCodeqlSarif(JSON.stringify(data), scope).findings).toEqual([]);
    data.runs[0]!.artifacts = [];
    expect(normalizeCodeqlSarif(JSON.stringify(data), scope).findings).toEqual([]);
    expect(() => normalizeCodeqlSarif(JSON.stringify(data), { ...scope, extractedPaths: [] }))
      .toThrow('incomplete-codeql-source-coverage');
  });

  it('binds supporting inputs separately without inflating executable extraction coverage', () => {
    const data = sarif();
    data.runs[0]!.artifacts.push({ location: { uri: 'package.json' } });
    const inputs = { ...scope, inputPaths: [...scope.sourcePaths, ['package.json']] };
    expect(() => normalizeCodeqlSarif(JSON.stringify(data), scope)).toThrow('codeql-artifact-outside-scope');
    expect(normalizeCodeqlSarif(JSON.stringify(data), inputs).units[0]!.count).toBe(1);
    data.runs[0]!.results[0]!.locations[0]!.physicalLocation.artifactLocation.uri = 'package.json';
    expect(normalizeCodeqlSarif(JSON.stringify(data), inputs).findings[0]!.location).toEqual(['package.json']);
    expect(() => normalizeCodeqlSarif(JSON.stringify(data), { ...inputs, extractedPaths: [] }))
      .toThrow('incomplete-codeql-source-coverage');
    expect(() => normalizeCodeqlSarif(JSON.stringify(data), { ...inputs, inputPaths: [['package.json']] }))
      .toThrow('invalid-codeql-input-inventory');
    const unregistered = structuredClone(data);
    unregistered.runs[0]!.artifacts.push({ location: { uri: 'unregistered.json' } });
    expect(() => normalizeCodeqlSarif(JSON.stringify(unregistered), inputs)).toThrow('codeql-artifact-outside-scope');
  });

  it('rejects failed analysis, absent category, omitted source and unknown severities', () => {
    const failed = sarif();
    failed.runs[0]!.invocations[0]!.executionSuccessful = false;
    expect(() => normalizeCodeqlSarif(JSON.stringify(failed), scope)).toThrow('codeql-analysis-failed');
    const contradictory = sarif();
    const run = contradictory.runs[0]!;
    expect(() => normalizeCodeqlSarif(JSON.stringify({
      ...contradictory,
      runs: [{ ...run, invocations: [{ ...run.invocations[0], exitCode: 2 }] }]
    }), scope)).toThrow('codeql-analysis-failed');
    expect(() => normalizeCodeqlSarif(JSON.stringify({
      ...contradictory,
      runs: [{ ...run, invocations: [{ ...run.invocations[0], toolExecutionNotifications: [{ level: 'error' }] }] }]
    }), scope)).toThrow('codeql-analysis-failed');
    expect(() => normalizeCodeqlSarif(JSON.stringify(sarif()), { ...scope, category: 'python' })).toThrow('codeql-category-mismatch');
    expect(() => normalizeCodeqlSarif(JSON.stringify(sarif()), { ...scope, sourcePaths: [['other.ts']] })).toThrow('incomplete-codeql-source-coverage');
    const unknown = sarif();
    unknown.runs[0]!.tool.driver.rules[0]!.properties['security-severity'] = 'unknown';
    expect(() => normalizeCodeqlSarif(JSON.stringify(unknown), scope)).toThrow('unmapped-codeql-severity');
  });

  it('rejects candidate suppression, unsafe locations and malformed parser content without echoing it', () => {
    const data = sarif();
    const suppressed = { ...data, runs: [{ ...data.runs[0], results: [{ ...data.runs[0]!.results[0], suppressions: [{ status: 'accepted' }] }] }] };
    expect(() => normalizeCodeqlSarif(JSON.stringify(suppressed), scope)).toThrow('unapproved-sarif-suppression');
    data.runs[0]!.results[0]!.locations[0]!.physicalLocation.artifactLocation.uri = '../outside.ts';
    expect(() => normalizeCodeqlSarif(JSON.stringify(data), scope)).toThrow('unsafe-location');
    expect(() => normalizeCodeqlSarif('PRIVATE_PARSER_SENTINEL', scope)).toThrow('invalid-sarif-json');
  });
});
