import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { globSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import rootConfig, { cliCoverage, coverageFloorPercent, createRootConfig, userStateIsolationSetup } from '../vitest.config.js';
import gatewayConfig, { gatewayCoverage } from '../services/telemetry-ingest/vitest.config.js';
import { checkWorkflow, coverageGateJobs } from '../scripts/check-repository-policy.mjs';
import {
  CoverageGateError,
  configurationInventory,
  coverageEvidenceFile,
  coverageFloorPercent as gateFloorPercent,
  coverageMetrics,
  coveragePackage,
  coverageTestEnvironment,
  defaultMaxWorkers,
  evaluateCoverageReports,
  evaluateTestResults,
  exceedsFloor,
  formatPercent,
  runCoverageGate,
  sourceInventory,
  targetedInvocation,
  testInventory,
  toolVersions,
  verifyCoverageEvidence,
  vitestInvocation
} from '../scripts/coverage-gate.mjs';

type Definition = ReturnType<typeof coveragePackage>;
type Counts = Record<string, { covered: number; total: number }>;

const repository = process.cwd();
const fixtures: string[] = [];
const fixedRevision = () => ({ commit: 'a'.repeat(40), dirty: false, changedPathCount: 0, changedPaths: [] });

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fixtureDefinition(): Definition {
  return {
    id: 'fixture',
    description: 'Coverage gate fixture package',
    rootParts: [],
    reportParts: ['coverage', 'fixture'],
    testParts: [['tests']],
    requiredSources: ['src/covered.ts'],
    separatelyQualified: []
  } as unknown as Definition;
}

function metrics(covered: number, total: number): Counts {
  return Object.fromEntries(coverageMetrics.map((metric: string) => [metric, { covered, total }]));
}

function summaryFor(root: string, files: Record<string, Counts>) {
  const total = Object.fromEntries(coverageMetrics.map((metric: string) => {
    const values = Object.values(files).map((entry) => entry[metric]);
    const covered = values.reduce((sum, value) => sum + value.covered, 0);
    const count = values.reduce((sum, value) => sum + value.total, 0);
    return [metric, { covered, total: count, skipped: 0, pct: count ? Math.floor((covered * 10_000) / count) / 100 : 100 }];
  }));
  return {
    total,
    ...Object.fromEntries(Object.entries(files).map(([file, value]) => [path.join(root, ...file.split('/')), value]))
  };
}

function finalFor(root: string, files: string[]) {
  return Object.fromEntries(files.map((file) => [path.join(root, ...file.split('/')), { path: file }]));
}

// Fixtures live below the repository so Node resolves the pinned Vitest and
// provider from the checkout's own node_modules without symlinks or installs.
async function fixturePackage(options: {
  coverage?: Record<string, unknown>;
  tests?: Record<string, string>;
  sources?: Record<string, string>;
} = {}) {
  const cache = path.join(repository, '.cache');
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(path.join(cache, 'coverage gate fixture '));
  fixtures.push(root);
  const versions = { vitest: '5.0.0', '@vitest/coverage-v8': '5.0.0', vite: '8.2.2' };
  const coverage = options.coverage ?? {
    provider: 'v8',
    include: ['src/**/*.ts'],
    exclude: [],
    thresholds: Object.fromEntries(coverageMetrics.map((metric: string) => [metric, gateFloorPercent]))
  };
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify({ name: 'coverage-gate-fixture', version: '1.0.0', type: 'module', devDependencies: versions }, null, 2)}\n`,
    'package-lock.json': `${JSON.stringify({
      lockfileVersion: 3,
      packages: Object.fromEntries(Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, { version }]))
    }, null, 2)}\n`,
    'tsconfig.json': `${JSON.stringify({ include: ['src/**/*.ts'] })}\n`,
    'vitest.config.ts': `export default ${JSON.stringify({
      test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        coverage: { ...coverage, reportsDirectory: './coverage/fixture', reporter: ['json-summary', 'json'] }
      }
    })};\n`,
    ...(options.sources ?? {
      'src/covered.ts': 'export function covered(value: number): number {\n  return value > 0 ? value : -value;\n}\n',
      'src/entry.ts': 'export function unimportedEntrypoint(): string {\n  return "never imported by a test";\n}\n'
    }),
    ...(options.tests ?? {
      'tests/covered.test.ts': [
        "import { expect, it } from 'vitest';",
        "import { covered } from '../src/covered.ts';",
        "it('covers both branches', () => {",
        '  expect(covered(2)).toBe(2);',
        '  expect(covered(-3)).toBe(3);',
        '});',
        "it.skip('is host-gated elsewhere', () => {});",
        ''
      ].join('\n'),
      'tests/entry.test.ts': [
        "import { expect, it } from 'vitest';",
        "import { unimportedEntrypoint } from '../src/entry.ts';",
        "it('covers the entrypoint', () => expect(unimportedEntrypoint()).toContain('never'));",
        ''
      ].join('\n')
    })
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

async function gate(root: string) {
  return runCoverageGate(fixtureDefinition(), { root, quiet: true, revision: fixedRevision });
}

describe('pinned source-complete coverage configuration', () => {
  it('declares the exact Vitest-compatible V8 provider in both independent packages', async () => {
    for (const manifestPath of ['package.json', path.join('services', 'telemetry-ingest', 'package.json')]) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const lock = JSON.parse(await readFile(manifestPath.replace('package.json', 'package-lock.json'), 'utf8'));
      expect(manifest.devDependencies['@vitest/coverage-v8']).toBe('5.0.0');
      expect(manifest.devDependencies['@vitest/coverage-v8']).toBe(manifest.devDependencies.vitest);
      expect(lock.packages['node_modules/@vitest/coverage-v8'].version).toBe('5.0.0');
      expect(lock.packages['']?.devDependencies?.['@vitest/coverage-v8']).toBe('5.0.0');
    }
    for (const id of ['cli', 'gateway']) {
      const { failures, tools } = toolVersions(coveragePackage(id));
      expect(failures).toEqual([]);
      expect(Object.entries(tools.packages)).toContainEqual([
        '@vitest/coverage-v8', { declared: '5.0.0', locked: '5.0.0', installed: '5.0.0' }
      ]);
    }
  });

  it('keeps ordinary runs unchanged and enables coverage only through the gate', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8'));
    expect(manifest.scripts.test).toBe('vitest run');
    expect(manifest.scripts['coverage:cli']).toBe('node scripts/coverage-gate.mjs run cli');
    expect(manifest.scripts['coverage:gateway']).toBe('node scripts/coverage-gate.mjs run gateway');
    const service = JSON.parse(await readFile(path.join('services', 'telemetry-ingest', 'package.json'), 'utf8'));
    expect(service.scripts.test).toBe('vitest run');
    expect(service.scripts.coverage).toBe('node ../../scripts/coverage-gate.mjs run gateway');
    expect(rootConfig.test?.coverage).toBe(cliCoverage);
    expect(gatewayConfig.test?.coverage).toBe(gatewayCoverage);
    for (const coverage of [cliCoverage, gatewayCoverage]) {
      expect(coverage.enabled).toBe(false);
      expect(coverage.provider).toBe('v8');
      expect(coverage.exclude).toEqual([]);
      expect(coverage.reportOnFailure).toBe(false);
      expect(coverage.clean).toBe(true);
      expect(coverage.reporter).toEqual(expect.arrayContaining(['json-summary', 'json']));
    }
  });

  it('configures the CLI and gateway source inventories without exclusions', () => {
    expect(cliCoverage.include).toEqual(['src/**/*.ts']);
    expect(cliCoverage.reportsDirectory).toBe('./coverage/cli');
    expect(gatewayCoverage.include).toEqual(['src/**/*.ts', '**/src/telemetry/contract.ts']);
    expect(gatewayCoverage.allowExternal).toBe(true);
    expect(gatewayCoverage.reportsDirectory).toBe('../../coverage/gateway');
  });

  it('configures an 80.01% floor for each metric separately in both packages', () => {
    expect(coverageFloorPercent).toBe(80.01);
    expect(gateFloorPercent).toBe(80.01);
    for (const coverage of [cliCoverage, gatewayCoverage]) {
      expect(coverage.thresholds).toEqual({
        statements: 80.01, branches: 80.01, functions: 80.01, lines: 80.01
      });
      expect(coverage.thresholds).not.toHaveProperty('perFile');
      expect(coverage.thresholds).not.toHaveProperty('autoUpdate');
      expect(coverage.thresholds).not.toHaveProperty('100');
    }
  });

  it('adds coverage and user-state isolation only at the root, never inside Windows test projects', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const config = createRootConfig(platform);
      expect(config.test.coverage).toBe(cliCoverage);
      expect(config.test.globalSetup).toEqual([userStateIsolationSetup]);
      for (const project of config.test.projects ?? []) {
        expect(project.test).not.toHaveProperty('coverage');
        expect(project.test).not.toHaveProperty('globalSetup');
        expect(project.test).not.toHaveProperty('setupFiles');
      }
    }
    expect(path.isAbsolute(userStateIsolationSetup)).toBe(true);
    expect(path.relative(repository, userStateIsolationSetup).split(path.sep).join('/')).toBe('tests/setup/user-state-isolation.ts');
    expect(rootConfig.test?.globalSetup).toEqual([userStateIsolationSetup]);
    expect(createRootConfig('win32').test.maxWorkers).toBe(2);
  });

  it('runs one bounded, unfiltered, telemetry-free invocation per package', () => {
    const invocation = vitestInvocation(coveragePackage('cli'), path.join(repository, 'coverage', 'cli'), defaultMaxWorkers);
    expect(defaultMaxWorkers).toBe(2);
    expect(invocation.cwd).toBe(repository);
    expect(invocation.portable).toEqual([
      'node', 'node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.ts', '--coverage.enabled',
      '--maxWorkers=2', '--allowOnly=false', '--reporter=default', '--reporter=json',
      '--outputFile.json=coverage/cli/test-results.json'
    ]);
    const gatewayInvocation = vitestInvocation(coveragePackage('gateway'), path.join(repository, 'coverage', 'gateway'), 2);
    expect(gatewayInvocation.cwd).toBe(path.join(repository, 'services', 'telemetry-ingest'));
    expect(gatewayInvocation.portable[1]).toBe('services/telemetry-ingest/node_modules/vitest/vitest.mjs');
    expect(coverageTestEnvironment).toEqual({ CI: 'true', LIFTOFF_TELEMETRY: '0', DO_NOT_TRACK: '1' });
  });

  it('labels targeted diagnostics as non-qualifying and keeps them out of gate reports', () => {
    const targeted = targetedInvocation(coveragePackage('gateway'), {
      sources: ['src/telemetry/contract.ts', path.join('services', 'telemetry-ingest', 'src', 'server.ts')],
      tests: ['tests/server.test.ts']
    });
    expect(targeted.directory).toBe(path.join(repository, 'coverage', 'targeted', 'gateway'));
    expect(targeted.args).toEqual(expect.arrayContaining([
      '--coverage.include=**/src/telemetry/contract.ts', '--coverage.include=src/server.ts',
      '--coverage.thresholds.statements=0', '--coverage.thresholds.branches=0',
      '--coverage.thresholds.functions=0', '--coverage.thresholds.lines=0'
    ]));
    expect(() => targetedInvocation(coveragePackage('cli'), { sources: [], tests: ['tests/x.test.ts'] }))
      .toThrow(CoverageGateError);
  });
});

describe('coverage source inventories', () => {
  it('measures every CLI build input, including files no test imports', () => {
    const inventory = sourceInventory(coveragePackage('cli'));
    const expected = globSync('src/**/*.ts').map((file) => file.split(path.sep).join('/')).sort();
    expect(inventory.includes).toEqual(['src/**/*.ts']);
    expect(inventory.files.map((entry: { path: string }) => entry.path)).toEqual(expected);
    expect(inventory.files.map((entry: { path: string }) => entry.path)).toContain('src/cli.ts');
    expect(inventory.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('measures the gateway runtime plus the whole shared contract it compiles', () => {
    const inventory = sourceInventory(coveragePackage('gateway'));
    const files = inventory.files.map((entry: { path: string }) => entry.path);
    expect(inventory.includes).toEqual(['src/**/*.ts', '../../src/telemetry/contract.ts']);
    expect(files).toEqual([
      ...globSync('services/telemetry-ingest/src/**/*.ts').map((file) => file.split(path.sep).join('/')).sort(),
      'src/telemetry/contract.ts'
    ].sort());
    expect(files).toContain('services/telemetry-ingest/src/index.ts');
  });

  it('fails when the shared contract disappears from the gateway build input', async () => {
    await mkdir(path.join(repository, '.cache'), { recursive: true });
    const root = await mkdtemp(path.join(repository, '.cache', 'coverage gateway inventory '));
    fixtures.push(root);
    const service = path.join(root, 'services', 'telemetry-ingest');
    await mkdir(path.join(service, 'src'), { recursive: true });
    await writeFile(path.join(service, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'] }));
    await writeFile(path.join(service, 'src', 'index.ts'), 'export {};\n');
    expect(() => sourceInventory(coveragePackage('gateway'), root)).toThrow(/src\/telemetry\/contract\.ts/);
    await writeFile(path.join(service, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'], exclude: ['src/index.ts'] }));
    expect(() => sourceInventory(coveragePackage('gateway'), root)).toThrow(/files\/exclude/);
  });

  it('tracks test, configuration and gate bytes as separate evidence digests', () => {
    const tests = testInventory(coveragePackage('cli'));
    expect(tests.testFiles).toContain('tests/coverage-gate.test.ts');
    expect(tests.files.some((entry: { path: string }) => entry.path.startsWith('tests/fixtures/'))).toBe(true);
    const configuration = configurationInventory(coveragePackage('gateway'));
    expect(configuration.files.map((entry: { path: string }) => entry.path)).toEqual([
      'services/telemetry-ingest/package-lock.json', 'services/telemetry-ingest/package.json',
      'services/telemetry-ingest/tsconfig.json', 'services/telemetry-ingest/vitest.config.ts',
      'scripts/coverage-gate.mjs'
    ]);
  });
});

describe('fail-closed coverage evaluation', () => {
  const root = path.join(repository, '.cache', 'synthetic-coverage-root');
  const inventory = {
    files: ['src/a.ts', 'src/entry.ts'].map((file) => ({ path: file, sha256: '0'.repeat(64), bytes: 1 }))
  };
  const passing = { 'src/a.ts': metrics(90, 100), 'src/entry.ts': metrics(9, 10) };

  function evaluate(files: Record<string, Counts>, final = finalFor(root, Object.keys(files))) {
    return evaluateCoverageReports({ summary: summaryFor(root, files), final, inventory, root });
  }

  it('passes only a complete report above the floor for every metric', () => {
    const result = evaluate(passing);
    expect(result.failures).toEqual([]);
    expect(Object.entries(result.metrics)).toContainEqual([
      'statements', { covered: 99, total: 110, percent: '90.0000', passed: true }
    ]);
  });

  it('fails a missing report', () => {
    const result = evaluateCoverageReports({ summary: undefined, final: undefined, inventory, root });
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('Missing coverage-summary.json'),
      expect.stringContaining('Missing coverage-final.json')
    ]));
  });

  it('fails an empty report', () => {
    const empty = { total: metrics(0, 0) };
    const result = evaluateCoverageReports({ summary: empty, final: {}, inventory, root });
    expect(result.failures).toEqual(expect.arrayContaining([
      'Coverage report is empty: it lists no source files.',
      expect.stringContaining('omits 2 inventoried source file(s)'),
      expect.stringContaining('Coverage metric statements is empty')
    ]));
  });

  it('fails when an unimported entrypoint is omitted even if the rest exceeds the floor', () => {
    const result = evaluate({ 'src/a.ts': metrics(100, 100) });
    expect(result.metrics).toMatchObject({ lines: { passed: true } });
    expect(result.failures).toEqual([expect.stringContaining('including unimported entrypoints: src/entry.ts')]);
  });

  it('fails a stale report that still lists removed paths', () => {
    const result = evaluate({ ...passing, 'src/removed.ts': metrics(10, 10) });
    expect(result.failures).toEqual([
      expect.stringContaining('outside the current source inventory (stale or foreign report): src/removed.ts')
    ]);
  });

  it.each([
    ['exactly 80%', 80, 100],
    ['80.009%', 80_009, 100_000],
    ['76.41% branches from the exploration report', 7641, 10_000]
  ])('fails a metric at or below the floor: %s', (_label, covered, total) => {
    const files = {
      'src/a.ts': { ...metrics(95, 100), branches: { covered, total } },
      'src/entry.ts': { ...metrics(10, 10), branches: { covered: 0, total: 0 } }
    };
    const result = evaluate(files);
    expect(result.metrics).toMatchObject({ statements: { passed: true }, branches: { passed: false } });
    expect(result.failures).toEqual([expect.stringMatching(/^Coverage metric branches is .* it must exceed 80%/)]);
  });

  it('passes the configured floor exactly and judges integer counts, not rounded percentages', () => {
    expect(exceedsFloor(8001, 10_000)).toBe(true);
    expect(exceedsFloor(8000, 10_000)).toBe(false);
    expect(exceedsFloor(80_009, 100_000)).toBe(false);
    expect(exceedsFloor(0, 0)).toBe(false);
    expect(formatPercent(80_009, 100_000)).toBe('80.0090');
    expect(formatPercent(2, 3)).toBe('66.6666');
  });

  it('rejects tampered totals, disagreeing final reports and paths outside the repository', () => {
    const tampered = summaryFor(root, passing);
    tampered.total.functions = { ...tampered.total.functions, covered: tampered.total.functions.total };
    expect(evaluateCoverageReports({ summary: tampered, final: finalFor(root, Object.keys(passing)), inventory, root }).failures)
      .toEqual([expect.stringContaining('total.functions')]);
    expect(evaluate(passing, finalFor(root, ['src/a.ts'])).failures)
      .toEqual([expect.stringContaining('disagree about: src/entry.ts')]);
    const outside = { ...summaryFor(root, passing), [path.resolve(root, '..', '..', 'elsewhere.ts')]: metrics(1, 1) };
    expect(evaluateCoverageReports({ summary: outside, final: finalFor(root, Object.keys(passing)), inventory, root }).failures)
      .toEqual(expect.arrayContaining([expect.stringContaining('outside the repository')]));
  });

  it('never lets a passing CLI report satisfy or mask the gateway', () => {
    const cliRoot = repository;
    const cli = sourceInventory(coveragePackage('cli'));
    const gateway = sourceInventory(coveragePackage('gateway'));
    const cliFiles = Object.fromEntries(cli.files.map((entry: { path: string }) => [entry.path, metrics(99, 100)]));
    const gatewayFiles = Object.fromEntries(gateway.files.map((entry: { path: string }) => [entry.path, metrics(70, 100)]));
    const cliResult = evaluateCoverageReports({
      summary: summaryFor(cliRoot, cliFiles), final: finalFor(cliRoot, Object.keys(cliFiles)), inventory: cli, root: cliRoot
    });
    const gatewayResult = evaluateCoverageReports({
      summary: summaryFor(cliRoot, gatewayFiles), final: finalFor(cliRoot, Object.keys(gatewayFiles)), inventory: gateway, root: cliRoot
    });
    expect(cliResult.failures).toEqual([]);
    expect(gatewayResult.failures).toHaveLength(4);
    const merged = { ...cliFiles, ...gatewayFiles };
    const aggregate = evaluateCoverageReports({
      summary: summaryFor(cliRoot, merged), final: finalFor(cliRoot, Object.keys(merged)), inventory: gateway, root: cliRoot
    });
    expect(aggregate.failures).toEqual(expect.arrayContaining([expect.stringContaining('stale or foreign report')]));
  });
});

describe('fail-closed test results', () => {
  const root = path.join(repository, '.cache', 'synthetic-results-root');
  const tests = { testFiles: ['tests/a.test.ts', 'tests/b.test.ts'] };
  const file = (name: string, statuses: string[]) => ({
    name: path.join(root, ...name.split('/')),
    status: statuses.includes('failed') ? 'failed' : 'passed',
    assertionResults: statuses.map((status, index) => ({ status, fullName: `${name} case ${index}` }))
  });
  const results = (files: ReturnType<typeof file>[], overrides: Record<string, unknown> = {}) => {
    const assertions = files.flatMap((entry) => entry.assertionResults);
    return {
      success: assertions.every((assertion) => assertion.status !== 'failed'),
      numTotalTests: assertions.length,
      numPassedTests: assertions.filter((assertion) => assertion.status === 'passed').length,
      numFailedTests: assertions.filter((assertion) => assertion.status === 'failed').length,
      numPendingTests: assertions.filter((assertion) => assertion.status === 'skipped').length,
      numTodoTests: 0,
      numFailedTestSuites: files.filter((entry) => entry.status === 'failed').length,
      testResults: files,
      ...overrides
    };
  };

  it('records skipped host-gated tests as unrun evidence without counting them as proof', () => {
    const verdict = evaluateTestResults({
      results: results([file('tests/a.test.ts', ['passed', 'skipped']), file('tests/b.test.ts', ['passed'])]), tests, root
    });
    expect(verdict.failures).toEqual([]);
    expect(verdict.summary?.unrun).toEqual([{ file: 'tests/a.test.ts', test: 'tests/a.test.ts case 1', status: 'skipped' }]);
  });

  it.each([
    ['missing results', undefined, 'Missing test-results.json'],
    ['a failing test', results([file('tests/a.test.ts', ['failed']), file('tests/b.test.ts', ['passed'])]), 'Test failed: tests/a.test.ts'],
    ['an unsuccessful run', results([file('tests/a.test.ts', ['passed']), file('tests/b.test.ts', ['passed'])], { success: false }), 'unsuccessful run'],
    ['no executed tests', results([], { numTotalTests: 0 }), 'executed no tests'],
    ['a filtered test file', results([file('tests/a.test.ts', ['passed'])]), 'not executed (filtered, excluded or not collected): tests/b.test.ts']
  ])('fails %s', (_label, value, message) => {
    expect(evaluateTestResults({ results: value, tests, root }).failures)
      .toEqual(expect.arrayContaining([expect.stringContaining(message)]));
  });
});

describe('real pinned-provider gate runs', () => {
  it('passes a complete fixture and records revision, inventory, tools, invocation and unrun tests', async () => {
    const root = await fixturePackage();
    const evidence = await gate(root);
    expect(evidence.failures).toEqual([]);
    expect(evidence.result).toBe('passed');
    expect(evidence.revision.commit).toBe('a'.repeat(40));
    expect(evidence.sourceInventory.files.map((entry: { path: string }) => entry.path)).toEqual(['src/covered.ts', 'src/entry.ts']);
    expect(evidence.tools.packages.vitest).toEqual({ declared: '5.0.0', locked: '5.0.0', installed: '5.0.0' });
    expect(evidence.tools.node).toBe(process.version);
    expect(evidence.invocation.command).toContain('--coverage.enabled');
    expect(evidence.invocation.environmentOverrides).toEqual(coverageTestEnvironment);
    expect(evidence.tests.unrun).toEqual([
      { file: 'tests/covered.test.ts', test: 'is host-gated elsewhere', status: 'skipped' }
    ]);
    const saved = JSON.parse(await readFile(path.join(root, 'coverage', 'fixture', coverageEvidenceFile), 'utf8'));
    expect(saved).toEqual(evidence);
    await expect(verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision }))
      .resolves.toMatchObject({ result: 'passed', failures: [] });
  }, 60_000);

  it('fails when coverage omits an unimported entrypoint', async () => {
    const root = await fixturePackage({
      coverage: { provider: 'v8', thresholds: { statements: 80.01, branches: 80.01, functions: 80.01, lines: 80.01 } },
      tests: {
        'tests/covered.test.ts': "import { expect, it } from 'vitest';\nimport { covered } from '../src/covered.ts';\nit('covers', () => { expect(covered(1)).toBe(1); expect(covered(-1)).toBe(1); });\n"
      }
    });
    const evidence = await gate(root);
    expect(evidence.result).toBe('failed');
    expect(evidence.failures).toEqual([expect.stringContaining('including unimported entrypoints: src/entry.ts')]);
  }, 60_000);

  it('fails a deliberately lowered threshold that Vitest itself would accept', async () => {
    const root = await fixturePackage({
      coverage: { provider: 'v8', include: ['src/**/*.ts'], thresholds: { statements: 0, branches: 0, functions: 0, lines: 0 } },
      tests: {
        'tests/covered.test.ts': "import { expect, it } from 'vitest';\nimport { covered } from '../src/covered.ts';\nit('covers one branch', () => expect(covered(1)).toBe(1));\n"
      }
    });
    const evidence = await gate(root);
    expect(evidence.invocation.exitCode).toBe(0);
    expect(evidence.result).toBe('failed');
    expect(evidence.failures).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Coverage metric functions is 50\.0000% \(1\/2\)/)
    ]));
  }, 60_000);

  it('fails with a missing report when a test fails', async () => {
    const root = await fixturePackage({
      tests: { 'tests/covered.test.ts': "import { expect, it } from 'vitest';\nit('fails', () => expect(1).toBe(2));\n" }
    });
    const evidence = await gate(root);
    expect(evidence.result).toBe('failed');
    expect(evidence.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('Vitest exited with 1'),
      expect.stringContaining('Missing coverage-summary.json'),
      expect.stringContaining('Test failed: tests/covered.test.ts')
    ]));
  }, 60_000);

  it('fails an empty coverage report', async () => {
    const root = await fixturePackage({
      coverage: { provider: 'v8', include: ['nothing/**/*.ts'], thresholds: { statements: 0, branches: 0, functions: 0, lines: 0 } }
    });
    const evidence = await gate(root);
    expect(evidence.result).toBe('failed');
    expect(evidence.failures.join('\n')).toMatch(/Missing coverage-summary\.json|Coverage report is empty/);
    expect(evidence.failures.join('\n')).toContain('src/entry.ts');
  }, 60_000);

  it('rejects a saved passing report once the source or test inventory changes', async () => {
    const root = await fixturePackage();
    expect((await gate(root)).result).toBe('passed');
    await writeFile(path.join(root, 'src', 'added.ts'), 'export const added = 1;\n');
    const stale = await verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision });
    expect(stale.result).toBe('failed');
    expect(stale.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('Saved report is stale: source inventory changed'),
      expect.stringContaining('including unimported entrypoints: src/added.ts')
    ]));
    await rm(path.join(root, 'src', 'added.ts'));
    await writeFile(path.join(root, 'tests', 'entry.test.ts'), `${await readFile(path.join(root, 'tests', 'entry.test.ts'), 'utf8')}// edited\n`);
    const edited = await verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision });
    expect(edited.failures).toEqual([expect.stringContaining('test inventory changed')]);
    const moved = await verifyCoverageEvidence(fixtureDefinition(), {
      root, revision: () => ({ ...fixedRevision(), commit: 'b'.repeat(40) })
    });
    expect(moved.failures).toEqual(expect.arrayContaining([expect.stringContaining('revision changed')]));
  }, 60_000);

  it('does not let a saved passed verdict override contradictory execution metadata', async () => {
    const root = await fixturePackage();
    expect((await gate(root)).result).toBe('passed');
    const file = path.join(root, 'coverage', 'fixture', coverageEvidenceFile);
    const original = await readFile(file, 'utf8');
    const verify = () => verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision });
    const cases: Array<[string, (evidence: Record<string, any>) => void, string]> = [
      ['nonzero exit', (evidence) => { evidence.invocation.exitCode = 1; }, 'Vitest exit 1, not 0'],
      ['unknown exit', (evidence) => { evidence.invocation.exitCode = null; }, 'Vitest exit null, not 0'],
      ['termination signal', (evidence) => { evidence.invocation.signal = 'SIGTERM'; }, 'termination signal "SIGTERM"'],
      ['missing invocation', (evidence) => { delete evidence.invocation; }, 'lacks complete invocation metadata'],
      ['filtered invocation', (evidence) => { evidence.invocation.command.splice(2, 0, 'tests/covered.test.ts'); }, 'not the unfiltered source-complete gate command'],
      ['recorded failures', (evidence) => { evidence.failures = ['Coverage metric branches is 76.4197%']; }, 'empty failure list'],
      ['lowered floor', (evidence) => { evidence.threshold.configuredFloorPercent = 80; }, 'is not the configured 80.01%'],
      ['telemetry-enabled run', (evidence) => { evidence.invocation.environmentOverrides = {}; }, 'telemetry-free CI test environment'],
      ['foreign package', (evidence) => { evidence.package.id = 'cli'; }, 'belongs to "cli"']
    ];
    for (const [label, mutate, message] of cases) {
      const evidence = JSON.parse(original);
      mutate(evidence);
      await writeFile(file, JSON.stringify(evidence));
      const verdict = await verify();
      expect(verdict.result, label).toBe('failed');
      expect(verdict.failures, label).toEqual(expect.arrayContaining([expect.stringContaining(message)]));
    }
    await rm(file);
    expect((await verify()).failures).toEqual(expect.arrayContaining([expect.stringContaining(`Missing ${coverageEvidenceFile}`)]));
    await writeFile(file, original);
    await expect(verify()).resolves.toMatchObject({ result: 'passed' });
  }, 60_000);
});

describe('independent CI and release coverage gates', () => {
  type Step = { name?: string; id?: string; run?: string; uses?: string; if?: string; with?: Record<string, unknown> };
  type Job = { name?: string; if?: string; needs?: unknown; 'runs-on'?: string; steps: Step[]; permissions?: unknown };
  type Workflow = { jobs: Record<string, Job>; permissions?: unknown };
  const workflow = async (name: string): Promise<Workflow> =>
    parseYaml(await readFile(path.join('.github', 'workflows', name), 'utf8')) as Workflow;
  const runs = (job: Job) => job.steps.map((step) => step.run).filter(Boolean);

  it('runs each package gate once in its own unconditional Linux CI job with separate evidence', async () => {
    const ci = await workflow('ci.yml');
    expect(coverageGateJobs).toEqual({ 'coverage-cli': 'npm run coverage:cli', 'coverage-gateway': 'npm run coverage:gateway' });
    for (const [id, command] of Object.entries(coverageGateJobs)) {
      const job = ci.jobs[id];
      const report = id === 'coverage-cli' ? 'coverage/cli/' : 'coverage/gateway/';
      expect(job['runs-on']).toBe('ubuntu-latest');
      expect(job.if).toBeUndefined();
      expect(job.needs).toBeUndefined();
      expect(job.permissions).toBeUndefined();
      expect(runs(job).filter((run) => run === command)).toHaveLength(1);
      const upload = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
      expect(upload?.if).toBe('${{ !cancelled() }}');
      expect(upload?.with).toMatchObject({ path: report, 'if-no-files-found': 'error' });
    }
    const gates = Object.values(ci.jobs).flatMap((job) => runs(job).filter((run) => /coverage:(?:cli|gateway)/.test(run!)));
    expect(gates.sort()).toEqual(['npm run coverage:cli', 'npm run coverage:gateway']);
    expect(ci.permissions).toEqual({ contents: 'read' });
  });

  it('measures the CLI on the same pinned toolchain as the platform test lane', async () => {
    const ci = await workflow('ci.yml');
    const pins = (job: Job) => job.steps.filter((step) =>
      step.uses && !step.uses.startsWith('actions/upload-artifact@') || /npm@|uv==/.test(step.run ?? '')
    ).map((step) => ({
      uses: step.uses, with: step.with && Object.fromEntries(Object.entries(step.with).filter(([key]) => /version/.test(key))), run: step.run
    }));
    expect(pins(ci.jobs['coverage-cli']))
      .toEqual(pins(ci.jobs['test-shards']).filter((step) => step.uses || /npm@12\.0\.2|uv==0\.12\.7/.test(step.run ?? ''))
        .filter((step) => step.run === undefined || !step.run.includes('RUNNER_TEMP')));
    expect(runs(ci.jobs['coverage-cli'])).toEqual(expect.arrayContaining([
      'npm ci', 'npm ci --prefix services/telemetry-ingest'
    ]));
  });

  it('qualifies both packages before the exact release artifact is packed', async () => {
    const release = await workflow('release.yml');
    const steps = release.jobs.qualify.steps;
    const index = (predicate: (step: Step) => boolean) => steps.findIndex(predicate);
    const cli = index((step) => step.run === 'npm run coverage:cli');
    const gateway = index((step) => step.run === 'npm run coverage:gateway');
    const bundle = index((step) => step.id === 'bundle');
    const upload = index((step) => step.id === 'upload');
    expect(cli).toBeGreaterThan(index((step) => step.run === 'npm run check'));
    expect(gateway).toBeGreaterThan(cli);
    expect(steps[cli].if).toBeUndefined();
    expect(steps[gateway].if).toBe('${{ !cancelled() }}');
    expect(steps[gateway - 1]).toMatchObject({ run: 'npm ci --prefix services/telemetry-ingest', if: '${{ !cancelled() }}' });
    expect(bundle).toBeGreaterThan(gateway);
    expect(steps[bundle].if).toBeUndefined();
    const evidence = steps.find((step) => step.name === 'Store coverage evidence');
    expect(evidence?.with?.name).toBe('liftoff-coverage-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(steps[upload].with?.name).toBe('liftoff-release-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(steps[upload].with?.path).toBe('${{ runner.temp }}/liftoff-release/');
    expect(release.jobs.publish.needs).toBe('qualify');
    expect(release.jobs.publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(release.jobs.qualify.permissions).toBeUndefined();
    expect(release.permissions).toEqual({ contents: 'read' });
  });

  it.each([
    ['a removed CI gate job', 'ci.yml', (value: Workflow) => { delete value.jobs['coverage-gateway']; }],
    ['a skipped CI gate job', 'ci.yml', (value: Workflow) => { value.jobs['coverage-cli'].if = 'false'; }],
    ['a CI gate replaced by ordinary tests', 'ci.yml', (value: Workflow) => {
      value.jobs['coverage-cli'].steps = value.jobs['coverage-cli'].steps.map((step) =>
        step.run === 'npm run coverage:cli' ? { ...step, run: 'npm test' } : step);
    }],
    ['a gateway gate that only runs after CLI success', 'release.yml', (value: Workflow) => {
      const step = value.jobs.qualify.steps.find((item) => item.run === 'npm run coverage:gateway')!;
      step.if = '${{ success() }}';
    }],
    ['a gateway gate with its independent condition deleted', 'release.yml', (value: Workflow) => {
      delete value.jobs.qualify.steps.find((item) => item.run === 'npm run coverage:gateway')!.if;
    }],
    ['a gateway install that is skipped after a CLI failure', 'release.yml', (value: Workflow) => {
      delete value.jobs.qualify.steps.find((item) => item.run === 'npm ci --prefix services/telemetry-ingest')!.if;
    }],
    ['a gateway install moved after its gate', 'release.yml', (value: Workflow) => {
      const steps = value.jobs.qualify.steps;
      const install = steps.splice(steps.findIndex((item) => item.run === 'npm ci --prefix services/telemetry-ingest'), 1)[0];
      steps.splice(steps.findIndex((item) => item.run === 'npm run coverage:gateway') + 1, 0, install);
    }],
    ['coverage after packing', 'release.yml', (value: Workflow) => {
      const steps = value.jobs.qualify.steps;
      const gate = steps.splice(steps.findIndex((item) => item.run === 'npm run coverage:cli'), 1)[0];
      steps.push(gate);
    }],
    ['a pack step that ignores failed gates', 'release.yml', (value: Workflow) => {
      value.jobs.qualify.steps.find((item) => item.id === 'bundle')!.if = '${{ always() }}';
    }]
  ])('rejects %s in the repository policy', async (_label, name, mutate) => {
    const value = await workflow(name);
    expect(() => checkWorkflow(name, value)).not.toThrow();
    mutate(value);
    expect(() => checkWorkflow(name, value)).toThrow(/coverage|Packing|dependency install/);
  });
});
