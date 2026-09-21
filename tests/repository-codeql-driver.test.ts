import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import { generatedSecurityCases, sourceRoots } from '../scripts/repository-security/inventory.ts';
import {
  assertCodeqlMatrix, codeqlConfigurationDigest, codeqlFailureSummary, codeqlProducerLanguages, codeqlReportFormat,
  evaluateCodeqlObservation, inspectCodeqlBqrsMetadata, parseCodeqlBqrsRows, parseCodeqlCoverage, parseCodeqlGoDownloads, prepareCodeqlNodeRuntime,
  prepareCodeqlPlan, reportCodeqlMatrix, resolveCodeqlResultSet, runCodeqlMatrix, summarizeCodeqlMatrix, verifyCodeqlQueryExecution,
  type CodeqlCategory, type CodeqlCategoryResult, type CodeqlObservation, type CodeqlPlan, type CodeqlQueryIdentity
} from '../scripts/repository-security/codeql-driver.ts';
import {
  captureCodeqlFixtureOutput, codeqlFixturePin, createCodeqlFixtureArea, verifyCodeqlFixtureTool
} from '../scripts/repository-security/codeql-fixture.ts';
import { SecurityEvidenceError, type EvidenceIdentity } from '../scripts/repository-security/evidence.ts';
import { verifyWorkflowBoundaries } from '../scripts/repository-security/workflow-policy.ts';

const sentinel = 'PRIVATE_CODEQL_PRODUCER_SENTINEL';
const hash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const now = new Date('2026-09-20T12:00:00.000Z');

it.skipIf(process.platform === 'win32')('registers Node in the isolated extractor PATH before TypeScript analysis', async () => {
  const area = await createCodeqlFixtureArea(path.dirname(process.cwd()));
  vi.stubEnv('NODE_OPTIONS', '--nonfunctional-untrusted-option');
  try {
    const runtime = await prepareCodeqlNodeRuntime(area);
    expect(runtime.execution.exitCode).toBe(0);
    expect(runtime.value).toBe(process.version);
    const repeatedLookup = await captureCodeqlFixtureOutput(area, '/usr/bin/env', ['node', '--version'],
      value => value.trim(), 30_000, 4096);
    expect(repeatedLookup.value).toBe(process.version);
  } finally { vi.unstubAllEnvs(); await area.cleanup(); }
});

function categories(): CodeqlCategory[] {
  const entries = [
    ...[...new Set(sourceRoots.map(root => root.language))].map(value => ({ id: `source/${value}`, value, generated: false })),
    ...generatedSecurityCases.flatMap(entry => entry.requiredLanguages.map(value => ({
      id: `generated/${entry.id}/${value}`, value, generated: true
    })))
  ];
  return entries.map(entry => {
    const parts = ['fixture.txt'], digest = hash('fixed inert fixture');
    const inputs = [{ parts, digest }];
    return {
      id: entry.id, language: entry.value as CodeqlCategory['language'],
      role: entry.generated ? 'generated-findings' : 'source-findings',
      root: path.resolve('offline-not-a-scan', entry.id), sources: inputs, inputs,
      inputDigest: hash(JSON.stringify([[parts.join('/'), digest]]))
    };
  });
}
function queries(): CodeqlQueryIdentity[] {
  return Object.entries(codeqlProducerLanguages).map(([language, pin]) => ({
    language: language as CodeqlCategory['language'], pack: `codeql/${pin.extractor}-queries@${pin.queries}`,
    library: `codeql/${pin.extractor}-all@${pin.library}`, suiteDigest: pin.suiteDigest,
    queryDigest: pin.queryDigest, coverageDigest: hash(pin.coverage), rules: [`${pin.extractor}/fixture`],
    bindings: [{ id: `${pin.extractor}/fixture`, kind: 'problem',
      pathParts: ['Fixture.ql'], digest: hash(`${pin.extractor}/fixture`), resultSet: '#select' }],
    suite: 'not-executed', coverage: 'not-executed'
  }));
}
async function setup() {
  const entries = categories(), querySet = queries();
  const plan: CodeqlPlan = {
    categories: entries, inventoryDigest: hash('offline-inventory'), verify: vi.fn(async () => {}),
    workspace: { root: 'not-created', write: vi.fn(), verify: vi.fn(), cleanup: vi.fn() }
  };
  const identity: EvidenceIdentity = {
    repository: 'local/offline-simulation', event: 'pull_request', sourceSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40), workflowSha: 'c'.repeat(40), runId: '123', attempt: 1,
    inventoryDigest: plan.inventoryDigest, configurationDigest: await codeqlConfigurationDigest(querySet),
    policyDigest: hash('no-exceptions')
  };
  return { entries, querySet, plan, identity };
}
function observation(entry: CodeqlCategory, query: CodeqlQueryIdentity, negative = false): CodeqlObservation {
  const sarif = JSON.stringify({
    version: '2.1.0',
    runs: [{
      automationDetails: { id: `${entry.id}/` },
      tool: { driver: { name: 'CodeQL', semanticVersion: codeqlFixturePin.version,
        rules: query.rules.map(id => ({ id, properties: { 'security-severity': '7.8' } })) } },
      invocations: [{ executionSuccessful: true }],
      results: negative ? [{
        ruleId: query.rules[0], message: { text: sentinel },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'fixture.txt' }, region: { startLine: 1 } } }]
      }] : []
    }]
  });
  return {
    category: entry.id, inputDigest: entry.inputDigest, toolVersion: codeqlFixturePin.version, pack: query.pack,
    queryExecution: query.bindings.map(item => ({
      id: item.id, queryDigest: item.digest, resultDigest: hash('synthetic-bqrs'), resultSet: item.resultSet, rows: negative ? 1 : 0
    })),
    sarif, reportDigest: hash(sarif),
    coverage: JSON.stringify({ '#select': {
      columns: [{ kind: 'String' }, { kind: 'Integer' }, { kind: 'Integer' }], tuples: [['fixture.txt', 1, 0]]
    } }),
    execution: {
      startedAt: new Date(Date.now() - 1000).toISOString(), completedAt: new Date().toISOString(),
      exitCode: 0, stdoutBytes: 1, stderrBytes: 1
    }
  };
}

describe('CodeQL producer deterministic offline accounting, not native qualification', () => {
  it('emits owner-bound summaries from complete analysis without making reporting an admission receipt', async () => {
    const { entries, querySet, identity } = await setup();
    const outcomes = entries.map(entry => {
      const query = querySet.find(query => query.language === entry.language)!;
      return evaluateCodeqlObservation(entry, query, identity, observation(entry, query, entry === entries[0]));
    });
    const result = reportCodeqlMatrix(entries, querySet, identity, outcomes);
    expect(result.reporting.analysis.status).toBe('complete');
    expect(result.reporting.actualFindings.reportedStatus).toBe('blocked');
    expect(result.reporting.reportedAdmission).toBeNull();
    expect(result.reporting.notifications).toContainEqual(expect.objectContaining({
      owner: 'voyager163', reason: 'blocking-finding', delivery: 'not-sent'
    }));
    expect(result.reporting.authority.publicationAuthorization).toBe('none');
    expect(JSON.stringify(result.reporting)).not.toContain(sentinel);
    outcomes[0]!.passed = true;
    expect(() => reportCodeqlMatrix(entries, querySet, identity, outcomes)).toThrow('codeql-producer-result-mismatch');
  });

  it('keeps not-run/error producers visible and does not convert scheduled reports into release authority', async () => {
    const { entries, querySet, identity } = await setup();
    identity.event = 'schedule';
    const outcomes: CodeqlCategoryResult[] = entries.map((entry, index) => ({
      category: entry.id, language: entry.language, status: index === 0 ? 'error' : 'not-run',
      sourceCount: entry.sources.length, inputDigest: entry.inputDigest, code: 'codeql-producer-prior-analysis-error'
    }));
    const result = reportCodeqlMatrix(entries, querySet, identity, outcomes);
    expect(result.reporting.analysis).toMatchObject({ status: 'incomplete', completeCount: 0 });
    expect(result.reporting.actualFindings.reportedStatus).toBe('incomplete');
    expect(result.reporting.recurrence.status).toBe('owner-action-required');
    expect(result.reporting.notifications.filter(item => item.reason === 'scheduled-failure')).toHaveLength(entries.length);
    expect(result.reporting.recurrence.releaseRequirement).toBe('fresh-passing-exact-release-attempt-qualification-required');
  });
  it('pins the natively qualified flat representation independently of query execution coverage', () => {
    expect(codeqlReportFormat).toEqual({ format: 'sarifv2.1.0', ruleLayout: 'driver', groupRulesByPack: false });
    expect(Object.isFrozen(codeqlReportFormat)).toBe(true);
  });
  it('requires separate complete BQRS execution identities, including ancillary queries', () => {
    const query = queries()[0]!;
    query.bindings.push({ id: 'js/metric', kind: 'metric', pathParts: ['Metric.ql'], digest: hash('metric'), resultSet: '#select' });
    const records = query.bindings.map(item => ({
      id: item.id, queryDigest: item.digest, resultDigest: hash('bqrs'), resultSet: item.resultSet, rows: 0
    }));
    expect(() => verifyCodeqlQueryExecution(query, records)).not.toThrow();
    for (const candidate of [
      [], records.slice(0, 1), [...records, records[0]!],
      records.map(item => ({ ...item, queryDigest: hash('wrong-query') })),
      records.map(item => ({ ...item, rows: -1 })),
      records.map(item => ({ ...item, resultSet: 'problems' as const })),
      records.map(item => ({ ...item, raw: sentinel }))
    ]) expect(() => verifyCodeqlQueryExecution(query, candidate)).toThrow();
  });

  it('binds named result sets only through the independently pinned query definition', () => {
    expect(resolveCodeqlResultSet('from File f select f, ""', 'diagnostic')).toBe('#select');
    expect(resolveCodeqlResultSet('/* select is not executable here */\nquery predicate problems = Fixture::problem/4;', 'problem'))
      .toBe('problems');
    const definition = 'query predicate problems(int value) { value = 1 }\n';
    const imported = { module: 'FixtureQuery', source: definition, digest: hash(definition) };
    expect(resolveCodeqlResultSet('import FixtureQuery', 'problem', imported)).toBe('problems');
    expect(() => resolveCodeqlResultSet('import DifferentQuery', 'problem', imported)).toThrow('query-result-selector');
    expect(() => resolveCodeqlResultSet('import FixtureQuery', 'problem', { ...imported, digest: hash('different') }))
      .toThrow('query-result-selector');
    for (const [source, kind] of [
      ['query predicate unknown = Fixture::problem/4;', 'problem'],
      ['query predicate problems = Fixture::problem/4;', 'metric'],
      ['query predicate problems = Fixture::problem/4;\nselect 1', 'problem'],
      ['import Fixture', 'problem']
    ]) expect(() => resolveCodeqlResultSet(source!, kind!)).toThrow('codeql-producer-query-result-selector');
    const named = JSON.stringify({ 'result-sets': [{ name: 'problems', rows: 0,
      columns: [{ kind: 'e' }, { kind: 's' }, { kind: 'e' }, { kind: 's' }] }] });
    expect(() => parseCodeqlBqrsRows(named)).toThrow('codeql-producer-bqrs-metadata');
    expect(parseCodeqlBqrsRows(named, 'problems')).toBe(0);
    expect(() => parseCodeqlBqrsRows(named.replace('problems', 'candidate-controlled'), 'problems'))
      .toThrow('codeql-producer-bqrs-metadata');
  });

  it('projects only bounded row counts from BQRS metadata, never result data', () => {
    expect(parseCodeqlBqrsRows(JSON.stringify({
      'result-sets': [{ name: '#select', rows: 0, columns: [{ kind: 'i', name: sentinel }] }]
    }))).toBe(0);
    expect(parseCodeqlBqrsRows(JSON.stringify({
      'result-sets': [{ name: '#select', rows: 1, columns: ['i', 's', 'b', 'f', 'e'].map(kind => ({ kind })) }]
    }))).toBe(1);
    for (const value of [
      {}, { 'result-sets': [] },
      { 'result-sets': [{ name: '#select', rows: sentinel, columns: [{}] }] },
      { 'result-sets': [{ name: '#select', rows: -1, columns: [{}] }] },
      { 'result-sets': [{ name: '#select', rows: 0, columns: [] }] },
      { 'result-sets': [{ name: '#select', rows: 0, columns: [{ kind: 'String' }] }] },
      { 'result-sets': [{ name: '#select', rows: 0, columns: [{ kind: sentinel }] }] },
      { 'result-sets': [{ name: '#select', rows: 0, columns: [{}] }, { name: '#select', rows: 0, columns: [{}] }] }
    ]) expect(() => parseCodeqlBqrsRows(JSON.stringify(value))).toThrow('codeql-producer-bqrs-metadata');
    const inspected = inspectCodeqlBqrsMetadata(JSON.stringify({
      'result-sets': [{ name: sentinel, rows: sentinel, columns: [{ kind: sentinel, name: sentinel }] }]
    }));
    expect(JSON.stringify(inspected)).not.toContain(sentinel);
    expect(inspected).toMatchObject({ resultSetCount: 1, selectCount: 0,
      sets: [{ select: false, rowsType: 'string', rows: null, columnCount: 1, columnKinds: ['unregistered'] }] });
  });

  it('requires source JS/TS and Actions plus every language of all 13 generated cases', () => {
    const matrix = categories();
    expect(matrix).toHaveLength(25);
    expect(matrix.filter(entry => entry.role === 'generated-findings')).toHaveLength(22);
    expect(() => assertCodeqlMatrix(matrix)).not.toThrow();
    for (const changed of [matrix.slice(1), [...matrix, matrix[0]!], matrix.map((entry, index) =>
      index === 0 ? { ...entry, sources: [] } : entry)]) {
      expect(() => assertCodeqlMatrix(changed)).toThrow();
    }
    expect(() => assertCodeqlMatrix(matrix.map((entry, index) => index ? entry :
      { ...entry, language: 'unsupported' as CodeqlCategory['language'] }))).toThrow('source-inventory');
  });

  it('keeps an actual finding verdict blocked while all required analysis outcomes complete', async () => {
    const { plan, querySet, identity } = await setup();
    const observe = vi.fn(async (entry: CodeqlCategory, query: CodeqlQueryIdentity) =>
      observation(entry, query, entry.id === 'generated/standard-go/go'));
    const result = await runCodeqlMatrix(plan, querySet, identity, async () => {}, observe);
    expect(observe).toHaveBeenCalledTimes(25);
    expect(result.analysisComplete).toBe(true);
    expect(result.findingsPassed).toBe(false);
    expect(result.categories.filter(entry => entry.blocking === 1)).toHaveLength(1);
    expect(result.categories.filter(entry => entry.passed)).toHaveLength(24);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result.hostedQualification).toBe(false);
  });

  it('runs no scan when the whole-matrix Go capability precondition fails', async () => {
    const { plan, querySet, identity } = await setup();
    const observe = vi.fn();
    const result = await runCodeqlMatrix(plan, querySet, identity, async () => {
      throw new SecurityEvidenceError('codeql-producer-go-offline-dependencies-unavailable');
    }, observe);
    expect(observe).not.toHaveBeenCalled();
    expect(result.analysisComplete).toBe(false);
    expect(result.findingsPassed).toBeNull();
    expect(result.completedCategories).toBe(0);
    expect(result.categories).toHaveLength(25);
    expect(result.categories.every(entry => entry.status === 'not-run')).toBe(true);
  });

  it('does not replace missing, malformed or cancelled analysis with a clean report', async () => {
    const { plan, querySet, identity } = await setup();
    const observe = vi.fn(async () => { throw new Error(sentinel); });
    const result = await runCodeqlMatrix(plan, querySet, identity, async () => {}, observe);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(result.analysisComplete).toBe(false);
    expect(result.categories[0]!.status).toBe('error');
    expect(result.categories.slice(1).every(entry => entry.status === 'not-run')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(() => summarizeCodeqlMatrix(plan.categories, result.categories.slice(1))).toThrow('result-coverage');
  });

  it('rejects missing language/query identities and wrong expected configuration or inventory', async () => {
    const { plan, querySet, identity } = await setup();
    const observe = vi.fn();
    await expect(runCodeqlMatrix(plan, querySet.slice(1), identity, async () => {}, observe)).rejects.toThrow('plan-identity');
    for (const changed of [{ inventoryDigest: hash('other') }, { configurationDigest: hash('other') }]) {
      await expect(runCodeqlMatrix(plan, querySet, { ...identity, ...changed }, async () => {}, observe))
        .rejects.toThrow('plan-identity');
    }
    expect(observe).not.toHaveBeenCalled();
  });

  it('requires exact database-derived coverage and zero parser/extractor errors', () => {
    const entry = categories()[0]!, query = queries()[0]!, native = observation(entry, query);
    expect(parseCodeqlCoverage(native.coverage, entry.sources)).toEqual([['fixture.txt']]);
    for (const rows of [[], [['other.txt', 1, 0]], [['fixture.txt', 0, 0]], [['fixture.txt', 1, 1]],
      [['fixture.txt', 1, 0], ['fixture.txt', 1, 0]], [['../outside', 1, 0]]]) {
      const data = JSON.parse(native.coverage);
      data['#select'].tuples = rows;
      expect(() => parseCodeqlCoverage(JSON.stringify(data), entry.sources)).toThrow();
    }
    expect(() => parseCodeqlCoverage(sentinel, entry.sources)).toThrow('codeql-producer-json');
    expect(() => parseCodeqlCoverage(sentinel.repeat(200_000), entry.sources)).toThrow('coverage-size');
  });

  it('rejects report/source/query mismatches and never self-adopts candidate exceptions', async () => {
    const { entries, querySet, identity } = await setup();
    const entry = entries[0]!, query = querySet[0]!, native = observation(entry, query, true);
    native.execution.startedAt = '2026-09-20T11:00:00.000Z';
    native.execution.completedAt = '2026-09-20T11:01:00.000Z';
    const result = evaluateCodeqlObservation(entry, query, identity, {
      ...native, ...{ exceptions: [{ findingDigest: hash('self-approved') }] }
    }, now);
    expect(result.passed).toBe(false);
    expect(result.report!.findings[0]!.version).toBe(entry.inputDigest);
    for (const altered of [{ inputDigest: hash('other') }, { category: 'other' }, { pack: 'other' }, { toolVersion: '0' }]) {
      expect(() => evaluateCodeqlObservation(entry, query, identity, { ...native, ...altered }, now))
        .toThrow('observation-mismatch');
    }
    expect(() => evaluateCodeqlObservation(entry, query, identity, { ...native, sarif: sentinel }, now))
      .toThrow('invalid-sarif-json');
    expect(() => evaluateCodeqlObservation(entry, query, identity, { ...native, reportDigest: hash('other') }, now))
      .toThrow('codeql-execution-mismatch');
  });

  it('reports all required categories even when preparation fails, without echoing errors', () => {
    for (const error of [new Error(sentinel), new SecurityEvidenceError(sentinel),
      new SecurityEvidenceError('arbitrary-private-lowercase-value')]) {
      const result = codeqlFailureSummary(error);
      expect(result.expectedCategories).toBe(25);
      expect(result.inventoryEstablished).toBe(false);
      expect(result.categories.every(item => item.status === 'not-run')).toBe(true);
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(JSON.stringify(result)).not.toContain('arbitrary-private-lowercase-value');
    }
  });
});

describe('private CodeQL input preparation and output safety', () => {
  it('rejects scanner storage inside its declared source tree even if that directory could be ignored', async () => {
    const outer = await createCodeqlFixtureArea(path.dirname(process.cwd()));
    const area = await createCodeqlFixtureArea(outer.slots.clean);
    try {
      await expect(prepareCodeqlPlan(outer.slots.clean, area, () => [])).rejects.toThrow('repository-scope');
    } finally { await area.cleanup(); await outer.cleanup(); }
  });

  it('materializes all 13 real cases, freezes inputs and never executes generated code', async () => {
    const outer = await createCodeqlFixtureArea(path.dirname(process.cwd()));
    const repository = outer.slots.clean;
    const fixtures = [
      ['src/example.ts', `export const value = '${sentinel}';\n`],
      ['scripts/example.mjs', 'export const value = 1;\n'],
      ['scripts/repository-security/network.py', 'value = 1\n'],
      ['services/telemetry-ingest/src/example.ts', 'export const value = 1;\n'],
      ['.github/workflows/example.yml', 'name: Fixture\non: workflow_dispatch\njobs: {}\n']
    ];
    for (const [name, content] of fixtures) {
      await mkdir(path.dirname(path.join(repository, name!)), { recursive: true });
      await writeFile(path.join(repository, name!), content!);
    }
    const area = await createCodeqlFixtureArea(outer.slots.home);
    try {
      const generate = vi.fn(entry => buildArtifacts(buildProjectPlan(entry.options, { requireProjectName: true })));
      const plan = await prepareCodeqlPlan(repository, area, generate);
      expect(generate).toHaveBeenCalledTimes(13);
      expect(plan.categories).toHaveLength(25);
      expect(plan.categories.find(entry => entry.id === 'source/python')!.sources).toHaveLength(1);
      expect(plan.categories.find(entry => entry.id === 'source/javascript-typescript')!.sources.some(
        source => source.parts.at(-1)?.endsWith('.py'))).toBe(false);
      expect(plan.categories.every(entry => entry.sources.length > 0)).toBe(true);
      expect(JSON.stringify(plan)).not.toContain(sentinel);
      await plan.verify();
      await writeFile(path.join(repository, 'src/unregistered.py'), 'value = 1\n');
      await expect(plan.verify()).rejects.toThrow('codeql-producer-unregistered-source-language');
      await unlink(path.join(repository, 'src/unregistered.py'));
      await writeFile(path.join(repository, 'src/example.ts'), 'changed\n');
      await expect(plan.verify()).rejects.toThrow('codeql-producer-source-changed');
      await plan.workspace.cleanup();
    } finally { await area.cleanup(); await outer.cleanup(); }
  });

  it('does not follow source symlinks into an unrelated tree', async () => {
    const outer = await createCodeqlFixtureArea(path.dirname(process.cwd()));
    const area = await createCodeqlFixtureArea(outer.slots.home);
    try {
      await symlink(outer.slots.home, path.join(outer.slots.clean, 'src'));
      await expect(prepareCodeqlPlan(outer.slots.clean, area, () => [])).rejects.toThrow('source-symlink');
    } finally { await area.cleanup(); await outer.cleanup(); }
  });

  it('sanitizes parser callback failures and forbids credential/environment inheritance or cache escapes', async () => {
    const area = await createCodeqlFixtureArea(path.dirname(process.cwd()));
    try {
      await expect(captureCodeqlFixtureOutput(area, process.execPath,
        ['-e', `process.stdout.write('${sentinel}')`], () => { throw new Error(sentinel); }, 5000, 4096))
        .rejects.toThrow('codeql-fixture-output-invalid');
      await expect(captureCodeqlFixtureOutput(area, process.execPath, ['-e', ''], () => undefined, 5000, 4096,
        { GITHUB_TOKEN: sentinel } as never)).rejects.toThrow('runtime-environment');
      await expect(captureCodeqlFixtureOutput(area, process.execPath, ['-e', ''], () => undefined, 5000, 4096,
        { GOMODCACHE: `${area.slots.home}/../escape` })).rejects.toThrow('runtime-cache');
      await expect(captureCodeqlFixtureOutput(area, process.execPath, ['-e', ''], () => undefined, 5000, 4096,
        { GOPROXY: 'https://proxy.golang.org,direct' } as never)).rejects.toThrow('runtime-environment');
      await mkdir(path.join(area.slots.tool, 'codeql'));
      await writeFile(path.join(area.slots.tool, 'codeql', 'changed'), 'changed');
      await expect(verifyCodeqlFixtureTool(area, {
        bundleDigest: codeqlFixturePin.digest, treeDigest: hash('original'), files: 1
      })).rejects.toThrow('tool-cache-changed');
    } finally { await area.cleanup(); }
  });

  it('decodes an explicitly permitted failed restore exit without converting it to success or leaking diagnostics', async () => {
    const area = await createCodeqlFixtureArea(path.dirname(process.cwd()));
    try {
      const result = await captureCodeqlFixtureOutput(area, process.execPath,
        ['-e', `process.stdout.write(JSON.stringify({error:'${sentinel}'}));process.exit(1)`],
        source => ({ failed: Object.hasOwn(JSON.parse(source), 'error') }), 5000, 4096, {}, [0, 1]);
      expect(result.execution.exitCode).toBe(1);
      expect(result.value.failed).toBe(true);
      expect(JSON.stringify(result)).not.toContain(sentinel);
      const module = path.join(area.slots.home, 'readonly-module');
      await mkdir(module);
      await writeFile(path.join(module, 'source.txt'), 'inert', { mode: 0o444 });
      await chmod(module, 0o555);
    } finally { await area.cleanup(); }
  });

  it('keeps execution inactive and source reporting separate from read-only analysis', async () => {
    const source = await readFile('.github/workflows/codeql.yml', 'utf8');
    const workflow = parse(source);
    const actions = [
      ['actions/checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1'],
      ['actions/setup-node', '820762786026740c76f36085b0efc47a31fe5020'],
      ['actions/setup-python', '5fda3b95a4ea91299a34e894583c3862153e4b97'],
      ['actions/setup-go', 'b7ad1dad31e06c5925ef5d2fc7ad053ef454303e'],
      ['actions/upload-artifact', '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'],
      ['actions/download-artifact', '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c']
    ].map(([repository, commit]) => ({ repository: repository!, commit: commit! }));
    expect(() => verifyWorkflowBoundaries(workflow, {
      actions, reportingJobs: { pullRequest: 'report-pr', protectedRef: 'report-protected' }
    })).not.toThrow();
    expect(Object.keys(workflow.on)).toEqual(['pull_request', 'push', 'schedule', 'workflow_dispatch']);
    expect(workflow.jobs.producer.if).toBe("${{ vars.CODEQL_PRODUCER_EXECUTION_ENABLED == 'true' }}");
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs['report-pr'].permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs['report-protected'].permissions).toEqual({ contents: 'read', 'security-events': 'write' });
    expect(source).not.toContain('upload-sarif@');
    expect(source).toContain("vars.CODEQL_REPORTING_UPLOAD_ENABLED == 'true'");
    expect(source).not.toContain('pull_request_target');
  });

  describe('canonical public Go restore metadata, not baseline repair', () => {
    const module = 'github.com/example/inert';
    const sum = `h1:${Buffer.alloc(32).toString('base64')}`;
    const native = () => ({ Path: module, Version: 'v1.2.3', Sum: sum, GoModSum: sum });
    const checksums = `${module} v1.2.3 ${sum}\n${module} v1.2.3/go.mod ${sum}\n`;

    it('reconciles every downloaded archive and module checksum with frozen committed bytes', () => {
      const result = parseCodeqlGoDownloads(JSON.stringify(native()), checksums);
      expect(result.modules).toEqual([{ module, version: 'v1.2.3', archiveSum: sum, goModSum: sum }]);
      expect(result.missingChecksums).toEqual([]);
      expect(result.failedModules).toBe(0);
      expect(result.graphDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it('reports missing committed checksums rather than silently adopting sumdb or downloaded values', () => {
      const result = parseCodeqlGoDownloads(JSON.stringify(native()), `${module} v1.2.3/go.mod ${sum}\n`);
      expect(result.missingChecksums).toEqual([{ module, version: 'v1.2.3', kind: 'archive' }]);
      const absentArchive = { ...native(), Sum: undefined, Error: sentinel, Dir: sentinel, Zip: sentinel };
      const failed = parseCodeqlGoDownloads(JSON.stringify(absentArchive), checksums);
      expect(failed.failedModules).toBe(1);
      expect(JSON.stringify(failed)).not.toContain(sentinel);
    });

    it('rejects checksum drift, private/replaced modules, duplicates and malformed bounded reports', () => {
      for (const value of [
        { ...native(), Sum: `h1:${Buffer.alloc(32, 1).toString('base64')}` },
        { ...native(), Path: 'private.example/internal' },
        { ...native(), Replace: { Dir: sentinel } },
        { ...native(), Version: '../private' }
      ]) expect(() => parseCodeqlGoDownloads(JSON.stringify(value), checksums)).toThrow();
      const concatenated = `${JSON.stringify(native())}\n${JSON.stringify(native())}`;
      expect(() => parseCodeqlGoDownloads(concatenated, checksums)).toThrow('duplicate-module');
      for (const source of ['', sentinel, '{', '[{}]', `{"Error":"${sentinel}"}`]) {
        expect(() => parseCodeqlGoDownloads(source, checksums)).toThrow();
      }
      expect(() => parseCodeqlGoDownloads(sentinel.repeat(200_000), checksums)).toThrow('report-size');
    });
  });
});
