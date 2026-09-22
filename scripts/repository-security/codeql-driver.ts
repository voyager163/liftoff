import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, chmod, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureCodeqlFixtureOutput, CodeqlFixtureProcessError, codeqlFixturePin, createCodeqlFixtureArea, restoreCodeqlFixtureTool,
  sealCodeqlFixtureTool, verifyCodeqlFixtureTool,
  type CodeqlFixtureArea, type CodeqlFixtureExecution, type CodeqlRuntimeEnvironment, type CodeqlToolSeal
} from './codeql-fixture.ts';
import { normalizeCodeqlSarif, sourceCodeqlReportingPayload } from './codeql.ts';
import {
  digest, evaluateSecurityReport, identifier, parseIdentity, portableParts, SecurityEvidenceError,
  sha, type EvidenceIdentity, type SecurityReport
} from './evidence.ts';
import { reportRepositorySecurity, writeSecurityJobSummary, type ReportingExpectations, type ReportingProducerOutcome } from './reporting.ts';
import { codeqlWorkflowInvocation, createCodeqlReportingBundle, type SourceReportingInvocation } from './codeql-report-artifact.ts';
import {
  generatedSecurityCases, materializeSecurityCase, sourceRoots,
  type GeneratedArtifactInput, type GeneratedCase
} from './inventory.ts';
import { createSecurityWorkspace, type RegisteredWorkspace } from './workspace.ts';

export const codeqlProducerLanguages = Object.freeze({
  'javascript-typescript': {
    extractor: 'javascript', queries: '2.4.5', library: '2.10.1', buildMode: 'none',
    ancillary: ['js/diagnostics/extraction-errors', 'js/diagnostics/successfully-extracted-files',
      'js/summary/lines-of-code', 'js/summary/lines-of-user-code'],
    suiteDigest: 'sha256:426749a033eb71b9a7732f03f1ccf406da049f9fd1f06c81daef852321bb81e7',
    queryDigest: 'sha256:0079fa5a29821c6a14d47b0a6962242bace3e5a344ba57a82ca451ba85fa7647',
    coverage: `import javascript
from File file
where exists(TopLevel top | top.getFile() = file and not top.isExterns())
select file.getRelativePath(),
  count(TopLevel top | top.getFile() = file and not top.isExterns()),
  count(JSParseError error)
`
  },
  actions: {
    extractor: 'actions', queries: '0.6.35', library: '0.6.1', buildMode: 'none',
    ancillary: ['actions/diagnostics/successfully-extracted-files'],
    suiteDigest: 'sha256:f47263bda405b2be3145e0203c3b852ca4f4f786fef24ac782a847a28b57a184',
    queryDigest: 'sha256:529ce497c9b00bab250b05c35944818c46b6c76996d46915a271121578f8c079',
    coverage: `import actions
import codeql.actions.ast.internal.Yaml as Yaml
from Workflow workflow
select workflow.getLocation().getFile().getRelativePath(), 1, count(Yaml::YamlParseError error)
`
  },
  python: {
    extractor: 'python', queries: '1.8.10', library: '7.2.5', buildMode: 'none',
    ancillary: ['py/diagnostics/successfully-extracted-files', 'py/diagnostics/extraction-warnings',
      'py/summary/lines-of-code', 'py/summary/lines-of-user-code'],
    suiteDigest: 'sha256:08adff19665a65e55f2c696e08262915884ff6a8a929b17257ec9b2d78aab846',
    queryDigest: 'sha256:8e1ab5e2d4f020c40fee334e885e13584f9efba4b112097fab847d0994e244fb',
    coverage: `import python
from File file
where exists(Module parsed | parsed.getFile() = file) and exists(file.getRelativePath())
select file.getRelativePath(), count(Module parsed | parsed.getFile() = file), count(SyntaxError error)
`
  },
  go: {
    extractor: 'go', queries: '1.6.10', library: '7.3.1', buildMode: 'autobuild',
    ancillary: ['go/diagnostics/extraction-errors', 'go/diagnostics/successfully-extracted-files', 'go/summary/lines-of-code'],
    suiteDigest: 'sha256:8970c08e48221cc8cfd89b6ac9c8cd1e56f143a740b613da67d835f3cabf7c29',
    queryDigest: 'sha256:52528f63cc1759c92e6b16bc3acd12c3647cda96b23bf93377437f77ce186e3f',
    coverage: `import go
from GoFile file
where exists(file.getRelativePath())
select file.getRelativePath(), 1, count(Error error)
`
  }
});

export type CodeqlLanguage = keyof typeof codeqlProducerLanguages;
export const codeqlReportFormat = Object.freeze({
  format: 'sarifv2.1.0', ruleLayout: 'driver', groupRulesByPack: false
});
const importedResultDefinitions = new Map([
  ['js/incomplete-url-substring-sanitization', {
    module: 'IncompleteUrlSubstringSanitization', pack: 'javascript-queries', version: '2.4.5',
    parts: ['Security', 'CWE-020', 'IncompleteUrlSubstringSanitization.qll'],
    digest: 'sha256:6768296a7d3607562fae891eac1ab9467ec9dd45fd1f2602cf4818a9f902c273'
  }],
  ['js/incomplete-multi-character-sanitization', {
    module: 'semmle.javascript.security.IncompleteMultiCharacterSanitizationQuery',
    pack: 'javascript-all', version: '2.10.1',
    parts: ['semmle', 'javascript', 'security', 'IncompleteMultiCharacterSanitizationQuery.qll'],
    digest: 'sha256:97ed33564ac3177259dfcae8293aa57c29deb52ecfc242afa628af198987926c'
  }]
]);
interface Input {
  parts: string[];
  digest: string;
}
export interface CodeqlCategory {
  id: string;
  language: CodeqlLanguage;
  role: 'source-findings' | 'generated-findings';
  root: string;
  sources: Input[];
  inputs: Input[];
  inputDigest: string;
}
export interface CodeqlPlan {
  categories: CodeqlCategory[];
  inventoryDigest: string;
  workspace: RegisteredWorkspace;
  verify(): Promise<void>;
}
export interface CodeqlQueryIdentity {
  language: CodeqlLanguage;
  pack: string;
  library: string;
  suiteDigest: string;
  queryDigest: string;
  coverageDigest: string;
  rules: string[];
  bindings: {
    id: string; kind: 'problem' | 'path-problem' | 'diagnostic' | 'metric';
    pathParts: string[]; digest: string; resultSet: '#select' | 'problems';
    selectorDefinitionDigest?: string;
  }[];
  suite: string;
  coverage: string;
}
export interface CodeqlQueryExecution {
  id: string;
  queryDigest: string;
  resultDigest: string;
  resultSet: '#select' | 'problems';
  rows: number;
}
export interface CodeqlCategoryResult {
  category: string;
  language: CodeqlLanguage;
  status: 'complete' | 'error' | 'not-run';
  sourceCount: number;
  inputDigest: string;
  code?: string;
  failure?: { execution: CodeqlFixtureExecution; diagnostics: readonly string[] };
  queryCoverage?: CodeqlQueryCoverage;
  queryExecution?: CodeqlQueryExecution[];
  bqrsFailure?: CodeqlBqrsMetadataError['bqrsFailure'];
  report?: SecurityReport;
  passed?: boolean;
  blocking?: number;
  tracked?: number;
  sourceReporting?: ReturnType<typeof sourceCodeqlReportingPayload>;
}

interface CodeqlQueryCoverage {
  expectedSecurity: number;
  reported: number;
  missingSecurityIndexes: number[];
  ancillaryIndexes: number[];
  unregistered: number;
}

class CodeqlQueryCoverageError extends SecurityEvidenceError {
  readonly queryCoverage: CodeqlQueryCoverage;
  constructor(source: string, query: CodeqlQueryIdentity) {
    super('codeql-query-coverage-mismatch');
    const runs = object(json(source)).runs;
    if (!Array.isArray(runs) || runs.length !== 1) fail('codeql-producer-result-mismatch');
    const rules = object(object(object(runs[0]).tool).driver).rules;
    if (!Array.isArray(rules)) fail('codeql-producer-result-mismatch');
    const ids = rules.map(rule => identifier(object(rule).id, 'invalid-codeql-rule'));
    const ancillary = codeqlProducerLanguages[query.language].ancillary;
    this.queryCoverage = {
      expectedSecurity: query.rules.length, reported: ids.length,
      missingSecurityIndexes: query.rules.flatMap((rule, index) => ids.includes(rule) ? [] : [index]),
      ancillaryIndexes: ancillary.flatMap((rule, index) => ids.includes(rule) ? [index] : []),
      unregistered: ids.filter(rule => !query.rules.includes(rule) && !ancillary.includes(rule)).length
    };
  }
}

class CodeqlStageError extends SecurityEvidenceError {
  readonly failure: { execution: CodeqlFixtureExecution; diagnostics: readonly string[] };
  constructor(code: string, error: CodeqlFixtureProcessError) {
    super(code);
    this.failure = { execution: error.execution, diagnostics: error.diagnostics };
  }
}

function hash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
function fail(code: string): never { throw new SecurityEvidenceError(code); }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('codeql-producer-object');
  return value as Record<string, unknown>;
}
function json(source: string): unknown {
  try { return JSON.parse(source); } catch { return fail('codeql-producer-json'); }
}
function language(value: string): CodeqlLanguage {
  if (!Object.hasOwn(codeqlProducerLanguages, value)) fail('codeql-producer-unmapped-language');
  return value as CodeqlLanguage;
}
function sameSet(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length &&
    actual.every(value => expected.includes(value));
}
function inputDigest(inputs: Input[]): string {
  return hash(JSON.stringify(inputs.map(input => [input.parts.join('/'), digest(input.digest)]).sort()));
}
function expectedCategories(): { id: string; language: CodeqlLanguage; role: CodeqlCategory['role'] }[] {
  const sources = [...new Set(sourceRoots.map(root => root.language))].map(value => ({
    id: `source/${value}`, language: language(value), role: 'source-findings' as const
  }));
  const generated = generatedSecurityCases.flatMap(entry => entry.requiredLanguages.map(value => ({
    id: `generated/${entry.id}/${value}`, language: language(value), role: 'generated-findings' as const
  })));
  return [...sources, ...generated];
}

export function assertCodeqlMatrix(categories: readonly CodeqlCategory[]): void {
  const expected = expectedCategories();
  if (generatedSecurityCases.length !== 13 || !sameSet(categories.map(item => item.id), expected.map(item => item.id))) {
    fail('codeql-producer-category-coverage');
  }
  for (const entry of categories) {
    const required = expected.find(item => item.id === entry.id)!;
    if (entry.language !== required.language || entry.role !== required.role || !path.isAbsolute(entry.root) ||
        entry.sources.length === 0 || entry.sources.length > 10_000 || entry.inputs.length > 10_000 ||
        entry.inputs.length < entry.sources.length ||
        new Set(entry.inputs.map(input => portableParts(input.parts).join('/').toLowerCase())).size !== entry.inputs.length ||
        new Set(entry.sources.map(input => portableParts(input.parts).join('/').toLowerCase())).size !== entry.sources.length ||
        entry.sources.some(input => !entry.inputs.some(other =>
          JSON.stringify(other.parts) === JSON.stringify(input.parts) && other.digest === input.digest)) ||
        inputDigest(entry.inputs) !== entry.inputDigest) fail('codeql-producer-source-inventory');
  }
}

async function privateFile(root: string, parts: string[], limit = 4 * 1024 * 1024): Promise<string> {
  const safe = portableParts(parts), filename = path.join(root, ...safe);
  try {
    let current = root;
    for (let index = 0; index < safe.length; index++) {
      current = path.join(current, safe[index]!);
      const status = await lstat(current);
      if (status.isSymbolicLink() || index < safe.length - 1 && !status.isDirectory() ||
          index === safe.length - 1 && (!status.isFile() || status.size > limit)) throw new Error();
    }
    const bytes = await readFile(filename);
    if (bytes.length > limit) throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return fail('codeql-producer-file-unreadable'); }
}

const javascriptExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue']);
function sourceExtension(value: string, extension: string) {
  return value === 'actions' ? ['.yml', '.yaml'].includes(extension)
    : value === 'python' ? extension === '.py' : javascriptExtensions.has(extension);
}
async function sourceInventory(repository: string) {
  const selected: { parts: string[]; content: string; language: CodeqlLanguage }[] = [];
  let size = 0;
  for (const root of sourceRoots) {
    const selectedLanguage = language(root.language);
    const before = selected.length;
    async function visit(parts: string[]) {
      const target = path.join(repository, ...portableParts(parts));
      const status = await lstat(target);
      if (status.isSymbolicLink()) fail('codeql-producer-source-symlink');
      if (status.isDirectory()) {
        if (['.git', 'node_modules', '.venv', 'vendor'].includes(parts.at(-1)!)) {
          fail('codeql-producer-unregistered-source-directory');
        }
        for (const name of (await readdir(target)).sort()) await visit([...parts, name]);
        return;
      }
      if (!status.isFile()) fail('codeql-producer-source-filetype');
      const extension = path.extname(parts.at(-1)!);
      const applicable = sourceExtension(selectedLanguage, extension);
      if (!applicable) {
        if (['.py', '.go', '.rs', '.java', '.cs'].includes(extension) &&
            !sourceRoots.some(other => other !== root && sourceExtension(other.language, extension) &&
              other.pathParts.every((part, index) => parts[index] === part))) fail('codeql-producer-unregistered-source-language');
        return;
      }
      const content = await privateFile(repository, parts);
      size += Buffer.byteLength(content);
      if (size > 32 * 1024 * 1024 || selected.length >= 10_000) fail('codeql-producer-source-size');
      selected.push({ parts, content, language: selectedLanguage });
    }
    await visit(root.pathParts);
    if (selected.length === before) fail('codeql-producer-empty-source-root');
  }
  return selected;
}

export async function prepareCodeqlPlan(
  repository: string, area: CodeqlFixtureArea,
  generate: (entry: GeneratedCase) => Promise<GeneratedArtifactInput[]> | GeneratedArtifactInput[]
): Promise<CodeqlPlan> {
  await area.verify();
  const repositoryRoot = await realpath(repository);
  if (repositoryRoot !== path.resolve(repository) || area.root === repositoryRoot ||
      area.root.startsWith(`${repositoryRoot}${path.sep}`) || repositoryRoot.startsWith(`${area.root}${path.sep}`)) {
    fail('codeql-producer-repository-scope');
  }
  const workspace = await createSecurityWorkspace(area.slots.clean);
  const categories: CodeqlCategory[] = [];
  const originals: { parts: string[]; content: string }[] = [];
  const materialized: { parts: string[]; content: string }[] = [];
  const source = await sourceInventory(repository);
  for (const sourceLanguage of [...new Set(sourceRoots.map(root => language(root.language)))]) {
    const inputs: Input[] = [];
    const prefix = `source-${sourceLanguage}`;
    for (const item of source.filter(item => item.language === sourceLanguage)) {
      await workspace.write([prefix, ...item.parts], item.content);
      originals.push({ parts: item.parts, content: item.content });
      materialized.push({ parts: [prefix, ...item.parts], content: item.content });
      inputs.push({ parts: item.parts, digest: hash(item.content) });
    }
    categories.push({
      id: `source/${sourceLanguage}`, language: sourceLanguage, role: 'source-findings',
      root: path.join(workspace.root, prefix), sources: inputs, inputs, inputDigest: inputDigest(inputs)
    });
  }
  for (const entry of generatedSecurityCases) {
    const artifacts = await generate(entry);
    const inventory = await materializeSecurityCase(entry, artifacts, workspace);
    for (const artifact of artifacts) materialized.push({ parts: [entry.id, ...artifact.pathParts], content: artifact.content });
    for (const value of entry.requiredLanguages) {
      const selectedLanguage = language(value);
      const sources = inventory.filter(item => item.kind === value).map(item => ({ parts: item.pathParts, digest: item.digest }));
      const inputs = inventory.map(item => ({ parts: item.pathParts, digest: item.digest }));
      categories.push({
        id: `generated/${entry.id}/${value}`, language: selectedLanguage, role: 'generated-findings',
        root: path.join(workspace.root, entry.id), sources, inputs, inputDigest: inputDigest(inputs)
      });
    }
  }
  assertCodeqlMatrix(categories);
  return {
    categories, workspace,
    inventoryDigest: hash(JSON.stringify(categories.map(({ id, language, inputDigest, sources }) =>
      ({ id, language, inputDigest, count: sources.length })))),
    async verify() {
      for (const item of originals) {
        if (await privateFile(repository, item.parts) !== item.content) fail('codeql-producer-source-changed');
      }
      const fresh = await sourceInventory(repository);
      if (!sameSet(fresh.map(item => item.parts.join('/')), originals.map(item => item.parts.join('/')))) {
        fail('codeql-producer-source-membership-changed');
      }
      for (const item of materialized) await workspace.verify(item.parts, item.content);
    }
  };
}

export function parseCodeqlCoverage(source: string, expected: readonly Input[]): string[][] {
  if (Buffer.byteLength(source) > 4 * 1024 * 1024) fail('codeql-producer-coverage-size');
  const result = object(object(json(source))['#select']);
  const columns = result.columns;
  if (!Array.isArray(columns) ||
      JSON.stringify(columns.map(column => object(column).kind)) !== JSON.stringify(['String', 'Integer', 'Integer']) ||
      !Array.isArray(result.tuples) || result.tuples.length === 0 || result.tuples.length > 10_000) {
    fail('codeql-producer-coverage-schema');
  }
  const paths = result.tuples.map(value => {
    if (!Array.isArray(value) || value.length !== 3 || typeof value[0] !== 'string' ||
        !Number.isSafeInteger(value[1]) || value[1] < 1 || value[2] !== 0) {
      fail('codeql-producer-extraction-incomplete');
    }
    return portableParts(value[0].split('/'));
  });
  if (!sameSet(paths.map(parts => parts.join('/')), expected.map(input => input.parts.join('/')))) {
    fail('codeql-producer-extraction-coverage');
  }
  return paths;
}

async function command<T>(
  area: CodeqlFixtureArea, args: string[], consume: (source: string) => T,
  runtime: CodeqlRuntimeEnvironment = {}, timeout = 300_000
) {
  const result = await captureCodeqlFixtureOutput(area, path.join(area.slots.tool, 'codeql', 'codeql'), args,
    source => {
      try { return { ok: true as const, value: consume(source) }; }
      catch (error) { return { ok: false as const, code: safeCode(error) }; }
    }, timeout, 4 * 1024 * 1024, runtime);
  if (!result.value.ok) fail(result.value.code);
  return { execution: result.execution, value: result.value.value };
}

export async function resolveCodeqlQueries(area: CodeqlFixtureArea, seal: CodeqlToolSeal): Promise<CodeqlQueryIdentity[]> {
  await verifyCodeqlFixtureTool(area, seal);
  const found = await command(area, ['resolve', 'languages', '--format=json'], source => Object.keys(object(json(source))));
  const result: CodeqlQueryIdentity[] = [];
  for (const [name, pin] of Object.entries(codeqlProducerLanguages)) {
    if (!found.value.includes(pin.extractor)) fail('codeql-producer-missing-extractor');
    const selectedLanguage = language(name);
    const packRoot = path.join(area.slots.tool, 'codeql', 'qlpacks', 'codeql', `${pin.extractor}-queries`, pin.queries);
    const suiteParts = ['codeql-suites', `${pin.extractor}-security-extended.qls`];
    const suiteSource = await privateFile(packRoot, suiteParts);
    if (hash(suiteSource) !== pin.suiteDigest) fail('codeql-producer-suite-identity');
    const suite = path.join(packRoot, ...suiteParts);
    const resolved = await command(area, ['resolve', 'queries', suite, '--format=json'], source => {
      const queries = json(source);
      if (!Array.isArray(queries) || queries.length === 0 || queries.length > 1000 ||
          queries.some(query => typeof query !== 'string')) fail('codeql-producer-query-resolution');
      return queries as string[];
    });
    const rules: string[] = [], ancillary: string[] = [], queryInputs: string[][] = [];
    const bindings: CodeqlQueryIdentity['bindings'] = [];
    for (const query of resolved.value.sort()) {
      const relative = path.relative(packRoot, query);
      if (relative.startsWith('..') || path.isAbsolute(relative)) fail('codeql-producer-query-outside-pack');
      const content = await privateFile(packRoot, relative.split(path.sep));
      const id = content.match(/^\s*\*\s*@id\s+([A-Za-z0-9_./-]+)\s*$/m)?.[1];
      const severity = content.match(/^\s*\*\s*@security-severity\s+([0-9.]+)\s*$/m)?.[1];
      const kind = content.match(/^\s*\*\s*@kind\s+([a-z-]+)\s*$/m)?.[1];
      if (!id || (pin.ancillary.includes(id)
        ? !['diagnostic', 'metric'].includes(kind ?? '') || severity !== undefined
        : !severity || !['problem', 'path-problem'].includes(kind ?? '') ||
          !/^(?:[0-9](?:\.[0-9]+)?|10(?:\.0+)?)$/.test(severity))) {
        fail('codeql-producer-unmapped-query-severity');
      }
      if (!pin.ancillary.includes(id)) rules.push(identifier(id, 'codeql-producer-query-id'));
      else ancillary.push(id);
      queryInputs.push([relative.split(path.sep).join('/'), hash(content)]);
      const definition = importedResultDefinitions.get(id);
      const imported = definition ? {
        module: definition.module,
        source: await privateFile(path.join(area.slots.tool, 'codeql', 'qlpacks', 'codeql', definition.pack, definition.version), definition.parts),
        digest: definition.digest
      } : undefined;
      bindings.push({
        id, kind: kind as CodeqlQueryIdentity['bindings'][number]['kind'],
        pathParts: portableParts(relative.split(path.sep)), digest: hash(content),
        resultSet: resolveCodeqlResultSet(content, kind!, imported),
        ...(imported ? { selectorDefinitionDigest: imported.digest } : {})
      });
    }
    if (new Set(rules).size !== rules.length) fail('codeql-producer-duplicate-query');
    if (!sameSet(ancillary, pin.ancillary) || hash(JSON.stringify(queryInputs)) !== pin.queryDigest) {
      fail('codeql-producer-query-identity');
    }
    const coverageRoot = path.join(area.slots.coverage, pin.extractor);
    await mkdir(coverageRoot, { mode: 0o700 });
    const coverage = path.join(coverageRoot, 'coverage.ql');
    await writeFile(coverage, pin.coverage, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(coverageRoot, 'qlpack.yml'),
      `name: local/${pin.extractor}-coverage\nversion: 0.0.0\ndependencies:\n  codeql/${pin.extractor}-all: ${pin.library}\n`,
      { flag: 'wx', mode: 0o600 });
    try {
      await command(area, ['query', 'compile', coverage,
        `--additional-packs=${path.join(area.slots.tool, 'codeql', 'qlpacks')}`, '--threads=1', '--ram=1024'],
      () => undefined);
    } catch { fail(`codeql-producer-coverage-query-${pin.extractor}`); }
    result.push({
      language: selectedLanguage, pack: `codeql/${pin.extractor}-queries@${pin.queries}`,
      library: `codeql/${pin.extractor}-all@${pin.library}`, suiteDigest: hash(suiteSource),
      queryDigest: hash(JSON.stringify(queryInputs)), coverageDigest: hash(pin.coverage),
      rules: rules.sort(), bindings, suite, coverage
    });
  }
  return result;
}

export interface CodeqlObservation {
  category: string;
  inputDigest: string;
  toolVersion: string;
  pack: string;
  coverage: string;
  sarif: string;
  execution: CodeqlFixtureExecution;
  reportDigest: string;
  queryExecution: CodeqlQueryExecution[];
}

export function verifyCodeqlQueryExecution(query: CodeqlQueryIdentity, records: readonly CodeqlQueryExecution[]): void {
  if (!Array.isArray(query.bindings) || !query.bindings.length || !Array.isArray(records) ||
      new Set(query.bindings.map(item => item.id)).size !== query.bindings.length ||
      !sameSet(records.map(record => record.id), query.bindings.map(item => item.id)) ||
      !sameSet(query.rules, query.bindings.filter(item => item.kind === 'problem' || item.kind === 'path-problem').map(item => item.id))) {
    fail('codeql-producer-query-execution-coverage');
  }
  for (const item of query.bindings) {
    identifier(item.id, 'codeql-producer-query-id');
    portableParts(item.pathParts);
    if (item.selectorDefinitionDigest !== undefined) digest(item.selectorDefinitionDigest);
    if (!['problem', 'path-problem', 'diagnostic', 'metric'].includes(item.kind) ||
        !['#select', 'problems'].includes(item.resultSet) || item.resultSet === 'problems' && item.kind !== 'problem' ||
        !item.pathParts.at(-1)?.endsWith('.ql')) fail('codeql-producer-query-execution-coverage');
    const record = records.find(record => record.id === item.id)!;
    if (Object.keys(record).length !== 5 || Object.keys(record).some(key =>
      !['id', 'queryDigest', 'resultDigest', 'resultSet', 'rows'].includes(key)) ||
      record.resultSet !== item.resultSet ||
      digest(record.queryDigest) !== digest(item.digest) || !Number.isSafeInteger(record.rows) || record.rows < 0 ||
        record.rows > 100_000_000) fail('codeql-producer-query-execution-coverage');
    digest(record.resultDigest);
  }
}
export function evaluateCodeqlObservation(
  entry: CodeqlCategory, query: CodeqlQueryIdentity, identity: EvidenceIdentity, observation: CodeqlObservation,
  now = new Date()
): CodeqlCategoryResult {
  if (observation.category !== entry.id || observation.inputDigest !== entry.inputDigest ||
      observation.toolVersion !== codeqlFixturePin.version || observation.pack !== query.pack ||
      query.language !== entry.language) fail('codeql-producer-observation-mismatch');
  const unit = { id: entry.id, inputDigest: entry.inputDigest, count: entry.sources.length, platform: `${process.platform}-${process.arch}` };
  const tool = { name: 'CodeQL', version: codeqlFixturePin.version, database: query.pack };
  verifyCodeqlQueryExecution(query, observation.queryExecution);
  const scope = {
    category: `${entry.id}/`, identity, role: entry.role, tool, unit,
    sourcePaths: entry.sources.map(input => input.parts),
    inputPaths: entry.inputs.map(input => input.parts),
    extractedPaths: parseCodeqlCoverage(observation.coverage, entry.sources),
    nonSecurityRules: query.bindings.filter(item => item.kind === 'diagnostic' || item.kind === 'metric').map(item => item.id),
    expectedRules: query.rules,
    requireDriverRules: true,
    execution: {
      category: `${entry.id}/`, toolVersion: observation.toolVersion, reportDigest: observation.reportDigest,
      startedAt: observation.execution.startedAt, completedAt: observation.execution.completedAt,
      exitCode: observation.execution.exitCode
    }
  };
  let report: SecurityReport;
  try { report = normalizeCodeqlSarif(observation.sarif, scope); }
  catch (error) {
    if (error instanceof SecurityEvidenceError && error.code === 'codeql-query-coverage-mismatch') {
      throw new CodeqlQueryCoverageError(observation.sarif, query);
    }
    throw error;
  }
  const evaluated = evaluateSecurityReport(report, { identity, role: entry.role, tool, units: [unit] },
    { blockingRules: [], exceptions: [] }, now);
  return {
    category: entry.id, language: entry.language, status: 'complete', sourceCount: entry.sources.length,
    inputDigest: entry.inputDigest, report, passed: evaluated.passed, queryExecution: observation.queryExecution.map(item => ({ ...item })),
    blocking: evaluated.blocking.length, tracked: evaluated.tracked.length,
    ...(entry.role === 'source-findings' ? { sourceReporting: sourceCodeqlReportingPayload(observation.sarif, scope) } : {})
  };
}

export function summarizeCodeqlMatrix(categories: readonly CodeqlCategory[], outcomes: CodeqlCategoryResult[]) {
  assertCodeqlMatrix(categories);
  if (!sameSet(outcomes.map(item => item.category), categories.map(item => item.id))) {
    fail('codeql-producer-result-coverage');
  }
  for (const outcome of outcomes) {
    const entry = categories.find(item => item.id === outcome.category)!;
    if (outcome.language !== entry.language || outcome.sourceCount !== entry.sources.length ||
        outcome.inputDigest !== entry.inputDigest ||
        !['complete', 'error', 'not-run'].includes(outcome.status) ||
        outcome.status === 'complete' && (!outcome.report || typeof outcome.passed !== 'boolean' ||
          !Array.isArray(outcome.queryExecution) || outcome.queryExecution.length === 0) ||
        outcome.status !== 'complete' && (outcome.report !== undefined || outcome.passed !== undefined ||
          outcome.queryExecution !== undefined)) {
      fail('codeql-producer-result-mismatch');
    }
  }
  const analysisComplete = outcomes.every(item => item.status === 'complete');
  return {
    schemaVersion: 1, kind: 'local-codeql-producer', analysisComplete,
    findingsPassed: analysisComplete ? outcomes.every(item => item.passed === true) : null,
    expectedCategories: categories.length, completedCategories: outcomes.filter(item => item.status === 'complete').length,
    categories: outcomes,
    hostedQualification: false, sarifUpload: false
  };
}

export function reportCodeqlMatrix(
  categories: readonly CodeqlCategory[], queries: readonly CodeqlQueryIdentity[], identity: EvidenceIdentity,
  outcomes: CodeqlCategoryResult[], now = new Date()
) {
  const result = summarizeCodeqlMatrix(categories, outcomes);
  const expected: ReportingExpectations = {
    identity, controls: [], blockingRules: [],
    producers: categories.map(entry => {
      const query = queries.find(query => query.language === entry.language);
      if (!query) fail('codeql-producer-query-identity');
      return {
        id: entry.id, owner: 'voyager163', policy: 'repository-findings', identity, role: entry.role,
        tool: { name: 'CodeQL', version: codeqlFixturePin.version, database: query.pack },
        units: [{ id: entry.id, inputDigest: entry.inputDigest, count: entry.sources.length,
          platform: `${process.platform}-${process.arch}` }],
        previousFindingDigests: null
      };
    })
  };
  const producers: ReportingProducerOutcome[] = outcomes.map(outcome => {
    if (outcome.status !== 'complete') return {
      id: outcome.category, analysis: outcome.status === 'not-run' ? 'skipped' : 'error',
      identity, observedAt: now.toISOString()
    };
    const report = outcome.report;
    const producer = expected.producers.find(producer => producer.id === outcome.category);
    if (!report || !producer) fail('codeql-producer-result-mismatch');
    const verdict = evaluateSecurityReport(report, producer, { blockingRules: [], exceptions: [] }, now);
    if (verdict.passed !== outcome.passed || verdict.blocking.length !== outcome.blocking ||
        verdict.tracked.length !== outcome.tracked) fail('codeql-producer-result-mismatch');
    return {
      id: outcome.category, analysis: 'complete', report,
      assessment: { status: verdict.passed ? 'passed' : 'blocked',
        blocking: verdict.blocking, reviewed: verdict.reviewed,
        tracked: verdict.tracked.map(id => ({ id, owner: 'voyager163' })) }
    };
  });
  const reporting = reportRepositorySecurity(expected, { producers, capabilities: [], admission: null }, now);
  return { ...result, reporting: reporting.summary };
}

export async function prepareCodeqlNodeRuntime(area: CodeqlFixtureArea) {
  await area.verify();
  const bin = path.join(area.slots.home, 'bin');
  await mkdir(bin, { mode: 0o700, recursive: true });
  if ((await lstat(bin)).isSymbolicLink() || await realpath(bin) !== bin) fail('codeql-producer-runtime-path');
  const node = await realpath(process.execPath);
  await symlink(node, path.join(bin, 'node'));
  return captureCodeqlFixtureOutput(area, '/usr/bin/env', ['node', '--version'], source => {
    const version = /^v24\.(\d+)\.(\d+)\s*$/.exec(source);
    if (!version || Number(version[1]) < 20) fail('codeql-producer-node-version');
    return source.trim();
  }, 30_000, 4096);
}

export async function prepareCodeqlRuntimes(
  area: CodeqlFixtureArea, python: string, go: string
): Promise<CodeqlRuntimeEnvironment> {
  if (!path.isAbsolute(python) || !path.isAbsolute(go)) fail('codeql-producer-runtime-path');
  const bin = path.join(area.slots.home, 'bin');
  await prepareCodeqlNodeRuntime(area);
  await symlink(await realpath(python), path.join(bin, 'python3'));
  await symlink(await realpath(go), path.join(bin, 'go'));
  const goVersion = await captureCodeqlFixtureOutput(area, go, ['version'], source => {
    if (!/^go version go1\.27\.\d+ (?:darwin|linux)\/(?:arm64|amd64)\s*$/.test(source)) fail('codeql-producer-go-version');
    return undefined;
  }, 30_000, 4096, { GOTOOLCHAIN: 'local' });
  await captureCodeqlFixtureOutput(area, python, ['--version'], source => {
    if (!/^Python 3\.14\.\d+\s*$/.test(source)) fail('codeql-producer-python-version');
    return undefined;
  }, 30_000, 4096);
  if (goVersion.execution.exitCode !== 0) fail('codeql-producer-go-version');
  const runtime: CodeqlRuntimeEnvironment = {
    CODEQL_PYTHON: path.join(bin, 'python3'), GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off', CGO_ENABLED: '0',
    GOWORK: 'off', GOENV: 'off', GOAUTH: 'off', GOFLAGS: '-mod=readonly', GOVCS: '*:off',
    GOPATH: path.join(area.slots.home, 'go'), GOCACHE: path.join(area.slots.home, 'go-build'),
    GOMODCACHE: path.join(area.slots.home, 'go-mod')
  };
  for (const directory of [runtime.GOPATH!, runtime.GOCACHE!, runtime.GOMODCACHE!]) await mkdir(directory, { mode: 0o700 });
  return runtime;
}

export async function preflightCodeqlGo(area: CodeqlFixtureArea, plan: CodeqlPlan, runtime: CodeqlRuntimeEnvironment): Promise<void> {
  const entries = plan.categories.filter(entry => entry.language === 'go');
  for (const entry of entries) {
    const module = entry.inputs.filter(input => input.parts.at(-1) === 'go.mod');
    if (module.length !== 1 || !entry.inputs.some(input => input.parts.at(-1) === 'go.sum')) {
      fail('codeql-producer-go-module-coverage');
    }
    const moduleRoot = path.join(entry.root, ...module[0]!.parts.slice(0, -1));
    try {
      await captureCodeqlFixtureOutput(area, path.join(area.slots.home, 'bin', 'go'),
        ['-C', moduleRoot, 'mod', 'verify'], source => {
          if (source.trim() !== 'all modules verified') fail('codeql-producer-go-module-verification');
        }, 120_000, 1024 * 1024, runtime);
      // Offline dependency/type resolution is a whole-matrix precondition. This
      // does not run generated code, restore host caches, or download packages.
      await captureCodeqlFixtureOutput(area, path.join(area.slots.home, 'bin', 'go'), [
        '-C', moduleRoot, 'list', '-mod=readonly', '-deps', '-test', './...'
      ], () => undefined, 120_000, 1024 * 1024, runtime);
    } catch { fail('codeql-producer-go-offline-dependencies-unavailable'); }
  }
  await plan.verify();
}

interface GoModuleChecksum {
  module: string;
  version: string;
  archiveSum: string | null;
  goModSum: string | null;
}
export interface CodeqlGoRestore {
  category: string;
  qualified: boolean;
  exitCode: number;
  metadataUnchanged: boolean;
  goModDigest: string;
  goSumDigest: string;
  graphDigest: string;
  modules: GoModuleChecksum[];
  failedModules: number;
  reportValid: boolean;
  reportBytes: number;
  reportError?: string;
  missingChecksums: { module: string; version: string; kind: 'archive' | 'go.mod' }[];
}

function publicModule(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:github\.com|golang\.org|gopkg\.in|go\.uber\.org|go\.opentelemetry\.io|google\.golang\.org|go\.mongodb\.org)\/[A-Za-z0-9_./!+-]+$/.test(value) ||
      value.length > 200 || value.includes('..')) fail('codeql-producer-nonpublic-module');
  return value;
}

function goChecksum(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^h1:[A-Za-z0-9+/]{43}=$/.test(value)) fail('codeql-producer-go-checksum');
  return value;
}

function committedGoChecksums(committedSums: string): Map<string, string> {
  if (Buffer.byteLength(committedSums) > 1024 * 1024) fail('codeql-producer-go-report-size');
  const expected = new Map<string, string>();
  for (const line of committedSums.trim().split(/\r?\n/)) {
    const parts = line.split(' ');
    if (parts.length !== 3 || !/^v[0-9][A-Za-z0-9.+/-]*$/.test(parts[1]!)) fail('codeql-producer-go-sum-schema');
    const module = publicModule(parts[0]), sum = goChecksum(parts[2]);
    const key = `${module}\0${parts[1]}`;
    if (!sum || expected.has(key)) fail('codeql-producer-go-sum-schema');
    expected.set(key, sum);
  }
  if (expected.size > 400) fail('codeql-producer-go-report-size');
  return expected;
}

export function parseCodeqlGoDownloads(source: string, committedSums: string) {
  if (Buffer.byteLength(source) > 4 * 1024 * 1024) fail('codeql-producer-go-report-size');
  const expected = committedGoChecksums(committedSums);
  const values: Record<string, unknown>[] = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (start < 0) {
      if (/\s/.test(character)) continue;
      if (character !== '{') fail('codeql-producer-go-json');
      start = index;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') {
      if (++depth > 16) fail('codeql-producer-go-json');
    } else if (character === '}' || character === ']') {
      if (--depth < 0) fail('codeql-producer-go-json');
      if (depth === 0) {
        values.push(object(json(source.slice(start, index + 1))));
        start = -1;
      }
    }
    if (values.length > 2000) fail('codeql-producer-go-report-size');
  }
  if (start !== -1 || values.length === 0) fail('codeql-producer-go-json');
  const missingChecksums: CodeqlGoRestore['missingChecksums'] = [];
  let failedModules = 0;
  const modules = values.map(value => {
    const module = publicModule(value.Path);
    if (typeof value.Version !== 'string' || !/^v[0-9][A-Za-z0-9.+-]*$/.test(value.Version) ||
        value.Version.length > 150 || value.Replace !== undefined) fail('codeql-producer-go-version');
    const version = value.Version, archiveSum = goChecksum(value.Sum), goModSum = goChecksum(value.GoModSum);
    if (value.Error !== undefined || archiveSum === null || goModSum === null) failedModules++;
    for (const [kind, sum, suffix] of [['archive', archiveSum, ''], ['go.mod', goModSum, '/go.mod']] as const) {
      const committed = expected.get(`${module}\0${version}${suffix}`);
      if (committed === undefined) missingChecksums.push({ module, version, kind });
      else if (sum !== null && committed !== sum) fail('codeql-producer-go-checksum-mismatch');
    }
    return { module, version, archiveSum, goModSum };
  }).sort((a, b) => `${a.module}@${a.version}`.localeCompare(`${b.module}@${b.version}`));
  if (new Set(modules.map(item => `${item.module}@${item.version}`)).size !== modules.length) {
    fail('codeql-producer-go-duplicate-module');
  }
  return { modules, failedModules, missingChecksums, graphDigest: hash(JSON.stringify(modules)) };
}

export async function restoreCodeqlGoModules(
  area: CodeqlFixtureArea, plan: CodeqlPlan, runtime: CodeqlRuntimeEnvironment
): Promise<CodeqlGoRestore[]> {
  await area.verify();
  const results: CodeqlGoRestore[] = [];
  for (const entry of plan.categories.filter(entry => entry.language === 'go')) {
    const manifests = entry.inputs.filter(input => input.parts.at(-1) === 'go.mod');
    if (manifests.length !== 1) fail('codeql-producer-go-module-coverage');
    const parts = manifests[0]!.parts.slice(0, -1), root = path.join(entry.root, ...parts);
    const goMod = await privateFile(root, ['go.mod']), goSum = await privateFile(root, ['go.sum']);
    if (/^\s*(?:replace|exclude|toolchain|tool|godebug)\b/m.test(goMod)) fail('codeql-producer-go-unsupported-directive');
    committedGoChecksums(goSum);
    await chmod(path.join(root, 'go.mod'), 0o400);
    await chmod(path.join(root, 'go.sum'), 0o400);
    const restored = await captureCodeqlFixtureOutput(area, path.join(area.slots.home, 'bin', 'go'),
      ['-C', root, 'mod', 'download', '-json', 'all'],
      source => {
        try { return { data: parseCodeqlGoDownloads(source, goSum), error: null }; }
        catch (error) {
          return {
            data: null, error: error instanceof SecurityEvidenceError
              ? error.code : 'codeql-producer-go-report-invalid'
          };
        }
      }, 300_000, 4 * 1024 * 1024,
      { ...runtime, GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org' }, [0, 1]);
    const metadataUnchanged = await privateFile(root, ['go.mod']) === goMod && await privateFile(root, ['go.sum']) === goSum;
    const result = {
      category: entry.id, ...(restored.value.data ?? {
        modules: [], failedModules: 1, missingChecksums: [], graphDigest: hash('[]')
      }), exitCode: restored.execution.exitCode, metadataUnchanged,
      goModDigest: hash(goMod), goSumDigest: hash(goSum),
      reportValid: restored.value.data !== null, reportBytes: restored.execution.stdoutBytes,
      ...(restored.value.error === null ? {} : { reportError: restored.value.error }),
      qualified: restored.execution.exitCode === 0 && metadataUnchanged &&
        restored.value.data !== null && restored.value.data.failedModules === 0 && restored.value.data.missingChecksums.length === 0
    };
    results.push(result);
    // No baseline rewriting, checksum synthesis, or partial graph admission.
    if (!result.qualified) break;
  }
  if (results.every(result => result.qualified)) await plan.verify();
  return results;
}

const bqrsKinds = ['i', 's', 'b', 'f', 'e'] as const;

export function resolveCodeqlResultSet(
  source: string, kind: string, imported?: { module: string; source: string; digest: string }
): '#select' | 'problems' {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  if (imported) {
    if (kind !== 'problem' || code.trim() !== `import ${imported.module}` ||
        hash(imported.source) !== digest(imported.digest) ||
        [...imported.source.matchAll(/^\s*query\s+predicate\s+problems\s*(?:=|\()/gm)].length !== 1) {
      fail('codeql-producer-query-result-selector');
    }
    return 'problems';
  }
  const select = /(?:^|\s)select\b/m.test(code);
  const named = [...code.matchAll(/^\s*query\s+predicate\s+problems\s*(?:=|\()/gm)];
  if (select && named.length === 0) return '#select';
  if (!select && named.length === 1 && kind === 'problem') return 'problems';
  return fail('codeql-producer-query-result-selector');
}

export function inspectCodeqlBqrsMetadata(source: string) {
  let value: unknown;
  try { value = JSON.parse(source); } catch { value = null; }
  const document = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const sets = Array.isArray(document['result-sets']) ? document['result-sets'] : null;
  return {
    bytes: Buffer.byteLength(source), jsonObject: value !== null && typeof value === 'object' && !Array.isArray(value),
    resultSetCount: sets?.length ?? null,
    selectCount: sets?.filter(set => set !== null && typeof set === 'object' && set.name === '#select').length ?? 0,
    sets: (sets ?? []).slice(0, 8).map(value => {
      const set = value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
      const columns = Array.isArray(set.columns) ? set.columns : null;
      return {
        select: set.name === '#select', rowsType: typeof set.rows,
        rows: typeof set.rows === 'number' && Number.isSafeInteger(set.rows) && set.rows >= 0 && set.rows <= 100_000_000 ? set.rows : null,
        columnsPresent: columns !== null, columnCount: columns?.length ?? null,
        columnKinds: (columns ?? []).slice(0, 16).map(value => {
          const column = value !== null && typeof value === 'object' && !Array.isArray(value)
            ? value as Record<string, unknown> : {};
          return bqrsKinds.find(kind => kind === column.kind) ?? 'unregistered';
        })
      };
    })
  };
}

export class CodeqlBqrsMetadataError extends SecurityEvidenceError {
  readonly bqrsFailure: {
    queryIndex: number; id: string; kind: CodeqlQueryIdentity['bindings'][number]['kind'];
    queryDigest: string; resultDigest: string; resultSet: '#select' | 'problems';
    metadata: ReturnType<typeof inspectCodeqlBqrsMetadata>;
  };
  constructor(queryIndex: number, binding: CodeqlQueryIdentity['bindings'][number], resultDigest: string,
    metadata: ReturnType<typeof inspectCodeqlBqrsMetadata>) {
    super('codeql-producer-bqrs-metadata');
    this.bqrsFailure = { queryIndex, id: binding.id, kind: binding.kind, queryDigest: binding.digest,
      resultDigest, resultSet: binding.resultSet, metadata };
  }
}

export function parseCodeqlBqrsRows(source: string, resultSet: '#select' | 'problems' = '#select'): number {
  if (Buffer.byteLength(source) > 65_536) fail('codeql-producer-bqrs-metadata');
  if (resultSet !== '#select' && resultSet !== 'problems') fail('codeql-producer-query-result-selector');
  const sets = object(json(source))['result-sets'];
  if (!Array.isArray(sets) || sets.length === 0 || sets.length > 32) fail('codeql-producer-bqrs-metadata');
  const selected = sets.map(object).filter(set => set.name === resultSet);
  const rows = selected[0]?.rows;
  if (selected.length !== 1 || typeof rows !== 'number' || !Number.isSafeInteger(rows) || rows < 0 ||
      rows > 100_000_000 || !Array.isArray(selected[0]!.columns) || selected[0]!.columns.length === 0) {
    fail('codeql-producer-bqrs-metadata');
  }
  if (selected[0]!.columns.some(column => {
    const value = object(column);
    return !bqrsKinds.some(kind => kind === value.kind);
  })) fail('codeql-producer-bqrs-metadata');
  return rows;
}

function bqrsCandidates(database: string, query: CodeqlQueryIdentity, binding: CodeqlQueryIdentity['bindings'][number]) {
  const pin = codeqlProducerLanguages[query.language];
  const parts = portableParts(binding.pathParts);
  if (!parts.at(-1)?.endsWith('.ql')) fail('codeql-producer-query-result-missing');
  const result = [...parts.slice(0, -1), parts.at(-1)!.replace(/\.ql$/, '.bqrs')];
  const root = path.join(database, 'results', 'codeql', `${pin.extractor}-queries`);
  return [path.join(root, ...result), path.join(root, pin.queries, ...result)];
}

async function existingBqrs(candidates: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const file of candidates) {
    try {
      const status = await lstat(file);
      if (!status.isFile() || status.isSymbolicLink() || await realpath(file) !== file ||
          status.size < 1 || status.size > 256 * 1024 * 1024) fail('codeql-producer-query-result-invalid');
      found.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return found;
}

async function collectCodeqlQueryExecution(
  area: CodeqlFixtureArea, database: string, query: CodeqlQueryIdentity, runtime: CodeqlRuntimeEnvironment
): Promise<CodeqlQueryExecution[]> {
  const results: CodeqlQueryExecution[] = [];
  for (const [queryIndex, binding] of query.bindings.entries()) {
    const candidates = await existingBqrs(bqrsCandidates(database, query, binding));
    if (candidates.length !== 1) fail('codeql-producer-query-result-missing');
    const file = candidates[0]!, before = await lstat(file);
    const inputHash = createHash('sha256');
    for await (const bytes of createReadStream(file)) inputHash.update(bytes);
    let nativeFailure: ReturnType<typeof inspectCodeqlBqrsMetadata> | undefined;
    let metadata: { execution: CodeqlFixtureExecution; value: number };
    try {
      metadata = await command(area, ['bqrs', 'info', file, '--format=json'], source => {
        try { return parseCodeqlBqrsRows(source, binding.resultSet); }
        catch (error) { nativeFailure = inspectCodeqlBqrsMetadata(source); throw error; }
      }, runtime, 30_000);
    } catch (error) {
      if (nativeFailure) throw new CodeqlBqrsMetadataError(queryIndex, binding, `sha256:${inputHash.digest('hex')}`, nativeFailure);
      throw error;
    }
    const after = await lstat(file);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || after.isSymbolicLink()) fail('codeql-producer-query-result-invalid');
    results.push({ id: binding.id, queryDigest: binding.digest, resultSet: binding.resultSet,
      resultDigest: `sha256:${inputHash.digest('hex')}`, rows: metadata.value });
  }
  verifyCodeqlQueryExecution(query, results);
  return results;
}

export async function collectCodeqlObservation(
  area: CodeqlFixtureArea, entry: CodeqlCategory, query: CodeqlQueryIdentity, runtime: CodeqlRuntimeEnvironment
): Promise<CodeqlObservation> {
  const pin = codeqlProducerLanguages[entry.language];
  if (await privateFile(path.dirname(query.coverage), ['coverage.ql']) !== pin.coverage ||
      hash(await privateFile(path.dirname(query.suite), [path.basename(query.suite)])) !== pin.suiteDigest) {
    fail('codeql-producer-query-input-changed');
  }
  const directory = path.join(area.slots.insecure, entry.id.replaceAll('/', '-'));
  await mkdir(directory, { mode: 0o700 });
  const database = path.join(directory, 'database'), coverage = path.join(directory, 'coverage.bqrs');
  const stage = async <T>(code: string, operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof CodeqlFixtureProcessError) throw new CodeqlStageError(code, error);
      if (error instanceof SecurityEvidenceError &&
          ['codeql-fixture-timeout', 'codeql-fixture-output-limit'].includes(error.code)) throw error;
      return fail(code);
    }
  };
  await stage('codeql-producer-database-extraction-failed', () => command(area, [
    'database', 'create', database, `--language=${pin.extractor}`, `--build-mode=${pin.buildMode}`,
    `--source-root=${entry.root}`, '--threads=1', '--ram=1024',
    ...(entry.language === 'go' ? ['--extractor-option=go.extract_tests=true'] : [])
  ], () => undefined, runtime));
  await stage('codeql-producer-coverage-evaluation-failed', () => command(area, [
    'query', 'run', query.coverage, `--database=${database}`, `--output=${coverage}`,
    `--additional-packs=${path.join(area.slots.tool, 'codeql', 'qlpacks')}`, '--threads=1', '--ram=1024'
  ], () => undefined, runtime));
  const extracted = await stage('codeql-producer-extraction-coverage', () => command(area, ['bqrs', 'decode', coverage, '--format=json'], source => {
    parseCodeqlCoverage(source, entry.sources);
    return source;
  }, runtime));
  const report = path.join(directory, 'report.sarif');
  for (const binding of query.bindings) {
    if ((await existingBqrs(bqrsCandidates(database, query, binding))).length !== 0) fail('codeql-producer-stale-query-result');
  }
  const analysis = await stage('codeql-producer-analysis-failed', () => command(area, [
    'database', 'analyze', database, query.suite, `--format=${codeqlReportFormat.format}`, '--no-sarif-group-rules-by-pack',
    `--sarif-category=${entry.id}`,
    `--output=${report}`, '--threads=1', '--ram=1024', '--max-disk-cache=1024', '--rerun',
    '--no-download', '--no-database-extension-packs', '--no-database-threat-models'
  ], () => undefined, runtime));
  const queryExecution = await collectCodeqlQueryExecution(area, database, query, runtime);
  const sarif = await privateFile(directory, ['report.sarif']);
  return {
    category: entry.id, inputDigest: entry.inputDigest, toolVersion: codeqlFixturePin.version,
    pack: query.pack, coverage: extracted.value, sarif, reportDigest: hash(sarif), execution: analysis.execution, queryExecution
  };
}

export async function runCodeqlMatrix(
  plan: CodeqlPlan, queries: CodeqlQueryIdentity[], identity: EvidenceIdentity,
  preflight: () => Promise<void>,
  observe: (entry: CodeqlCategory, query: CodeqlQueryIdentity) => Promise<CodeqlObservation>
) {
  assertCodeqlMatrix(plan.categories);
  parseIdentity(identity);
  if (identity.inventoryDigest !== plan.inventoryDigest ||
      identity.configurationDigest !== await codeqlConfigurationDigest(queries) ||
      !sameSet(queries.map(query => query.language), Object.keys(codeqlProducerLanguages))) {
    fail('codeql-producer-plan-identity');
  }
  const outcomes: CodeqlCategoryResult[] = [];
  const deadline = Date.now() + 45 * 60_000;
  const unexecuted = (entry: CodeqlCategory, code: string): CodeqlCategoryResult => ({
    category: entry.id, language: entry.language, status: 'not-run',
    sourceCount: entry.sources.length, inputDigest: entry.inputDigest, code
  });
  try { await preflight(); await plan.verify(); }
  catch (error) {
    const code = safeCode(error);
    return reportCodeqlMatrix(plan.categories, queries, identity, plan.categories.map(entry => unexecuted(entry, code)));
  }
  let stopped = false;
  for (const entry of plan.categories) {
    if (Date.now() > deadline) {
      outcomes.push(unexecuted(entry, 'codeql-producer-matrix-timeout'));
      stopped = true;
      continue;
    }
    if (stopped) { outcomes.push(unexecuted(entry, 'codeql-producer-prior-analysis-error')); continue; }
    try {
      const query = queries.find(query => query.language === entry.language)!;
      const observation = await observe(entry, query);
      await plan.verify();
      outcomes.push(evaluateCodeqlObservation(entry, query, identity, observation));
    } catch (error) {
      outcomes.push({ ...unexecuted(entry, safeCode(error)), status: 'error',
        ...(error instanceof CodeqlBqrsMetadataError ? { bqrsFailure: error.bqrsFailure } : {}),
        ...(error instanceof CodeqlQueryCoverageError ? { queryCoverage: error.queryCoverage } : {}),
        ...(error instanceof CodeqlStageError ? { failure: error.failure } : {}) });
      stopped = true;
    }
  }
  return reportCodeqlMatrix(plan.categories, queries, identity, outcomes);
}

function safeCode(error: unknown): string {
  const allowed = [
    'codeql-producer-go-offline-dependencies-unavailable', 'codeql-producer-go-module-coverage',
    'codeql-producer-go-restore-unqualified',
    'codeql-producer-database-extraction-failed', 'codeql-producer-coverage-evaluation-failed',
    'codeql-producer-extraction-coverage', 'codeql-producer-analysis-failed',
    'codeql-query-coverage-mismatch', 'codeql-artifact-outside-scope', 'codeql-finding-outside-scope',
    'codeql-analysis-failed', 'codeql-category-mismatch', 'codeql-tool-mismatch', 'unmapped-codeql-severity',
    'codeql-producer-missing-extractor', 'codeql-producer-source-changed', 'codeql-producer-source-membership-changed',
    'codeql-producer-file-unreadable', 'codeql-producer-query-identity', 'codeql-producer-suite-identity',
    'codeql-producer-coverage-query-javascript', 'codeql-producer-coverage-query-actions',
    'codeql-producer-coverage-query-python', 'codeql-producer-coverage-query-go',
    'codeql-fixture-timeout', 'codeql-fixture-output-limit', 'codeql-fixture-tool-cache-changed',
    'codeql-fixture-process-failed', 'codeql-fixture-platform-unqualified', 'codeql-producer-usage',
    'codeql-producer-query-execution-coverage', 'codeql-producer-query-result-missing',
    'codeql-producer-query-result-invalid', 'codeql-producer-stale-query-result', 'codeql-producer-bqrs-metadata',
    'codeql-producer-query-result-selector',
    'codeql-fixture-output-invalid', 'codeql-rule-classification-mismatch', 'codeql-extension-mismatch',
    'codeql-rule-layout-mismatch',
    'unknown-codeql-component', 'unknown-codeql-rule', 'unapproved-sarif-suppression',
    'invalid-sarif-location', 'invalid-codeql-region', 'invalid-sarif-object', 'sarif-too-large',
    'codeql-producer-query-input-changed', 'incomplete-codeql-source-coverage'
  ];
  return error instanceof SecurityEvidenceError && allowed.includes(error.code)
    ? error.code : 'codeql-producer-execution-failed';
}

export function codeqlFailureSummary(error: unknown) {
  return {
    schemaVersion: 1, kind: 'local-codeql-producer', analysisComplete: false, findingsPassed: null,
    expectedCategories: expectedCategories().length, completedCategories: 0, inventoryEstablished: false,
    categories: expectedCategories().map(entry => ({
      category: entry.id, language: entry.language, status: 'not-run', code: safeCode(error)
    })), hostedQualification: false, sarifUpload: false
  };
}

export async function codeqlConfigurationDigest(queries: CodeqlQueryIdentity[]): Promise<string> {
  const implementation = [];
  for (const file of ['codeql-driver.ts', 'codeql.ts', 'codeql-fixture.ts', 'codeql-reporting.ts',
    'codeql-report-artifact.ts', 'reporting.ts', 'evidence.ts']) {
    implementation.push([file, hash(await readFile(fileURLToPath(new URL(file, import.meta.url)), 'utf8'))]);
  }
  return hash(JSON.stringify({
    bundle: codeqlFixturePin.digest, implementation, reportFormat: codeqlReportFormat,
    queries: queries.map(({ suite, coverage, ...rest }) => rest).sort((a, b) => a.language.localeCompare(b.language)),
    threads: 1, ram: 1024, goDependencies: 'canonical-public-checksum-restore-then-private-offline'
  }));
}

export async function executeLocalCodeqlProducer(
  repository: string, python: string, go: string, restorePublicGo = false,
  invocation?: SourceReportingInvocation & { baseSha: string }
) {
  const area = await createCodeqlFixtureArea(path.dirname(await realpath(repository)));
  try {
    await restoreCodeqlFixtureTool(area);
    const seal = await sealCodeqlFixtureTool(area);
    const queries = await resolveCodeqlQueries(area, seal);
    const runtime = await prepareCodeqlRuntimes(area, python, go);
    const { buildProjectPlan } = await import('../../dist/planner.js');
    const { buildArtifacts } = await import('../../dist/templates.js');
    const plan = await prepareCodeqlPlan(repository, area, entry =>
      buildArtifacts(buildProjectPlan(entry.options as Parameters<typeof buildProjectPlan>[0], { requireProjectName: true })));
    const head = await captureCodeqlFixtureOutput(area, '/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], source => {
      if (!/^[a-f0-9]{40}\s*$/.test(source)) fail('codeql-producer-source-head');
      return source.trim();
    }, 30_000, 1024);
    const configurationDigest = await codeqlConfigurationDigest(queries);
    if (invocation && invocation.sourceSha !== head.value) fail('codeql-producer-source-head');
    const identity = parseIdentity({
      repository: 'voyager163/liftoff', event: invocation?.event ?? 'workflow_dispatch',
      sourceSha: head.value, baseSha: invocation?.baseSha ?? head.value,
      workflowSha: invocation?.workflowSha ?? head.value, runId: invocation?.runId ?? String(Date.now()),
      attempt: invocation?.attempt ?? 1,
      policyDigest: hash(JSON.stringify({ blockingRules: [], exceptions: [] })),
      inventoryDigest: plan.inventoryDigest, configurationDigest
    });
    let goRestore: CodeqlGoRestore[] = [];
    const result = await runCodeqlMatrix(plan, queries, identity,
      async () => {
        if (restorePublicGo) {
          goRestore = await restoreCodeqlGoModules(area, plan, runtime);
          if (goRestore.some(result => !result.qualified)) fail('codeql-producer-go-restore-unqualified');
        }
        await preflightCodeqlGo(area, plan, runtime);
      },
      (entry, query) => collectCodeqlObservation(area, entry, query, runtime));
    await verifyCodeqlFixtureTool(area, seal);
    await plan.workspace.cleanup();
    return {
      ...result, identity, goRestore, provenance: 'working-tree-input-digests-with-HEAD-anchor-not-hosted-evidence',
      cleanup: { registeredRoot: path.basename(area.root), rawArtifactsRetained: 0, removed: true }
    };
  } catch (error) { throw new SecurityEvidenceError(safeCode(error)); }
  finally { await area.cleanup(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (![4, 5].includes(args.length) || args[0] !== '--python' || args[2] !== '--go' ||
        args.length === 5 && args[4] !== '--restore-public-go-modules') fail('codeql-producer-usage');
    const invocation = process.env.GITHUB_ACTIONS === 'true' ? codeqlWorkflowInvocation(process.env) : undefined;
    const result = await executeLocalCodeqlProducer(process.cwd(), path.resolve(args[1]!), path.resolve(args[3]!), args.length === 5,
      invocation ? { ...invocation, baseSha: invocation.event === 'pull_request'
        ? sha(process.env.LIFTOFF_PR_BASE_SHA) : invocation.sourceSha } : undefined);
    if (invocation && result.categories.filter(category => category.category.startsWith('source/')).every(category =>
      category.status === 'complete' && category.sourceReporting)) {
      const parent = process.env.RUNNER_TEMP, output = process.env.GITHUB_OUTPUT;
      if (!parent || !output || !path.isAbsolute(parent) || !path.isAbsolute(output)) fail('codeql-producer-reporting-location');
      const root = await realpath(parent), source = await realpath(process.cwd()), relative = path.relative(source, root);
      if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) fail('codeql-producer-reporting-location');
      const workspace = await createSecurityWorkspace(root);
      await workspace.write(['source-codeql.json'], createCodeqlReportingBundle(result.identity, result.categories, result.analysisComplete));
      await appendFile(output, `reporting-root=${workspace.root}\n`);
    }
    const output = JSON.stringify(result);
    if (Buffer.byteLength(output) > 4 * 1024 * 1024) fail('codeql-producer-summary-size');
    process.stdout.write(`${output}\n`);
    await writeSecurityJobSummary(result.reporting, 'codeql', process.env.GITHUB_STEP_SUMMARY);
    process.exitCode = result.analysisComplete ? result.findingsPassed ? 0 : 1 : 2;
  } catch (error) {
    process.stderr.write(`${JSON.stringify(codeqlFailureSummary(error))}\n`);
    try { await writeSecurityJobSummary(null, 'codeql', process.env.GITHUB_STEP_SUMMARY); }
    catch { process.stderr.write('Security job summary unavailable; analysis remains incomplete.\n'); }
    process.exitCode = 2;
  }
}
