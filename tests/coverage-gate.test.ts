import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('assigns every inventoried Windows test file to exactly one project shard', () => {
    const selections = new Map<string, number>();
    for (const project of createRootConfig('win32').test.projects ?? []) {
      const exclude = 'exclude' in project.test ? project.test.exclude : undefined;
      for (const file of globSync(project.test.include, { cwd: repository, exclude })) {
        const name = file.split(path.sep).join('/');
        selections.set(name, (selections.get(name) ?? 0) + 1);
      }
    }
    expect([...selections].sort(([left], [right]) => left.localeCompare(right)))
      .toEqual(testInventory(coveragePackage('cli')).testFiles.map((file: string) => [file, 1])
        .sort(([left], [right]) => String(left).localeCompare(String(right))));
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

  it('rejects a below-floor count when Number multiplication rounds both products equal', () => {
    const covered = 7_206_660_123_718_266, total = 9_007_199_254_740_990;
    expect(Number.isSafeInteger(covered) && Number.isSafeInteger(total)).toBe(true);
    expect(covered * 10_000).toBe(total * 8001);
    expect(exceedsFloor(covered, total), JSON.stringify({
      covered, total, exactCoveredProduct: String(BigInt(covered) * 10_000n),
      exactFloorProduct: String(BigInt(total) * 8001n)
    })).toBe(false);
  });

  it.each([
    { label: 'below', covered: 7_200_899_999_999_999, expected: false },
    { label: 'at', covered: 7_200_900_000_000_000, expected: true },
    { label: 'above', covered: 7_200_900_000_000_001, expected: true }
  ])('judges large safe-integer counts $label the exact configured floor', ({ covered, expected }) => {
    expect(exceedsFloor(covered, 9_000_000_000_000_000)).toBe(expected);
  });

  it('fails every metric below the exact floor even when all input counts are safe integers', () => {
    const result = evaluate({
      'src/a.ts': metrics(7_206_660_123_718_266, 9_007_199_254_740_990),
      'src/entry.ts': metrics(0, 0)
    });
    expect(result.failures).toHaveLength(4);
    expect(Object.keys(result.metrics)).toEqual(coverageMetrics);
    for (const [metric, value] of Object.entries(result.metrics)) {
      expect(value).toMatchObject({ percent: '80.0099', passed: false });
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.stringMatching(new RegExp(`^Coverage metric ${metric} is 80\\.0099%`))
      ]));
    }
  });

  it('preserves exact threshold decisions across the upper safe-integer range', () => {
    for (let offset = 0; offset < 1024; offset++) {
      const total = Number.MAX_SAFE_INTEGER - offset;
      const minimum = Number((BigInt(total) * 8001n + 9999n) / 10_000n);
      expect(exceedsFloor(minimum - 1, total)).toBe(false);
      expect(exceedsFloor(minimum, total)).toBe(true);
      expect(exceedsFloor(minimum + 1, total)).toBe(true);
    }
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

  it.each([
    { label: 'null', record: null }, { label: 'boolean', record: true },
    { label: 'string', record: 'src/a.ts' }, { label: 'array', record: [] },
    { label: 'missing path', record: {} }, { label: 'numeric path', record: { path: 42 } }
  ])(
    'rejects a final source record without a valid payload path ($label)', ({ record }) => {
      const final = { ...finalFor(root, Object.keys(passing)), [path.join(root, 'src', 'a.ts')]: record };
      const result = evaluateCoverageReports({ summary: summaryFor(root, passing), final, inventory, root });
      expect(result.failures).toEqual(['coverage-final.json source record src/a.ts lacks a valid path identity.']);
      expect(result.metrics).toMatchObject({ lines: { covered: 99, total: 110, passed: true } });
    }
  );

  it('rejects a final source record whose payload names a different inventoried file', () => {
    const final = { ...finalFor(root, Object.keys(passing)), [path.join(root, 'src', 'a.ts')]: { path: 'src/entry.ts' } };
    expect(evaluateCoverageReports({ summary: summaryFor(root, passing), final, inventory, root }).failures)
      .toEqual(['coverage-final.json source record src/a.ts declares another source path: src/entry.ts']);
  });

  it('rejects an escaping final payload path independently of its valid report key', () => {
    const outside = path.resolve(root, '..', 'outside.ts');
    const final = { ...finalFor(root, Object.keys(passing)), [path.join(root, 'src', 'a.ts')]: { path: outside } };
    expect(evaluateCoverageReports({ summary: summaryFor(root, passing), final, inventory, root }).failures)
      .toEqual([`coverage-final.json source record src/a.ts has a path outside the repository: ${outside}`]);
  });

  it('preserves final report inputs and equivalent absolute or relative payload identities', () => {
    for (const payload of ['src/a.ts', path.join(root, 'src', 'a.ts'), `${root}/src/./a.ts`]) {
      const final = { ...finalFor(root, Object.keys(passing)), [path.join(root, 'src', 'a.ts')]: { path: payload } };
      const before = JSON.stringify(final);
      expect(evaluateCoverageReports({ summary: summaryFor(root, passing), final, inventory, root }).failures).toEqual([]);
      expect(JSON.stringify(final)).toBe(before);
    }
  });

  it('rejects normalized summary duplicates even when a later record hides uncovered counts', () => {
    const summary = { [`${root}/src/./a.ts`]: metrics(0, 100), ...summaryFor(root, passing) };
    const result = evaluateCoverageReports({ summary, final: finalFor(root, Object.keys(passing)), inventory, root });
    expect(result.failures).toEqual(['Coverage report contains duplicate source file record: src/a.ts']);
  });

  it('rejects normalized final duplicates even when every inventoried source is present', () => {
    const final = { [`${root}/src/./a.ts`]: { path: 'src/a.ts' }, ...finalFor(root, Object.keys(passing)) };
    const result = evaluate(passing, final);
    expect(result.failures).toEqual(['coverage-final.json contains duplicate source file record: src/a.ts']);
  });

  it('reports each repeated source member independently without mutating either raw report', () => {
    const summary = {
      [`${root}/src/./a.ts`]: metrics(0, 100),
      [`${root}/src/unused/../a.ts`]: metrics(1, 100),
      ...summaryFor(root, passing)
    };
    const final = {
      [`${root}/src/./a.ts`]: { path: 'src/a.ts' },
      [`${root}/src/unused/../a.ts`]: { path: 'src/a.ts' },
      ...finalFor(root, Object.keys(passing))
    };
    const rawBefore = JSON.stringify({ summary, final });
    const result = evaluateCoverageReports({ summary, final, inventory, root });
    expect(result.failures.filter(message => message === 'Coverage report contains duplicate source file record: src/a.ts'))
      .toHaveLength(2);
    expect(result.failures.filter(message => message === 'coverage-final.json contains duplicate source file record: src/a.ts'))
      .toHaveLength(2);
    expect(result.failures).toHaveLength(4);
    expect(JSON.stringify({ summary, final })).toBe(rawBefore);
  });

  it('rejects summary identity collisions in either member order', () => {
    const entries: [string, Counts][] = [
      [`${root}/src/./a.ts`, passing['src/a.ts']],
      [path.join(root, 'src', 'a.ts'), passing['src/a.ts']],
      [path.join(root, 'src', 'entry.ts'), passing['src/entry.ts']]
    ];
    for (const ordered of [entries, [...entries].reverse()]) {
      const summary = { total: summaryFor(root, passing).total, ...Object.fromEntries(ordered) };
      const result = evaluateCoverageReports({ summary, final: finalFor(root, Object.keys(passing)), inventory, root });
      expect(result.failures).toEqual(['Coverage report contains duplicate source file record: src/a.ts']);
    }
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
      numPendingTests: assertions.filter((assertion) => ['skipped', 'pending'].includes(assertion.status)).length,
      numTodoTests: assertions.filter((assertion) => assertion.status === 'todo').length,
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

  it('counts one failed file independently of two failed nested suites and a fully skipped file', () => {
    const files = [
      file('tests/a.test.ts', ['failed', 'failed']),
      file('tests/b.test.ts', ['passed']),
      file('tests/c.test.ts', ['skipped', 'skipped'])
    ];
    const verdict = evaluateTestResults({
      results: results(files, { numFailedTestSuites: 2 }),
      tests: { testFiles: [...tests.testFiles, 'tests/c.test.ts'] }, root
    });
    expect(verdict.summary).toMatchObject({ files: 3, total: 5, failed: 2, failedFiles: 1, skipped: 2 });
    expect(verdict.summary?.unrun).toHaveLength(2);
    expect(verdict.failures).toEqual(expect.arrayContaining([
      'Vitest reported 1 failed test file(s).',
      'Vitest reported 2 failed test suite(s).',
      'Test file failed: tests/a.test.ts'
    ]));
    expect(verdict.failures).not.toContain('Vitest reported 2 failed test file(s).');
  });

  it('counts two failed files even when three nested suites fail', () => {
    const verdict = evaluateTestResults({
      results: results([file('tests/a.test.ts', ['failed']), file('tests/b.test.ts', ['failed', 'failed'])],
        { numFailedTestSuites: 3 }), tests, root
    });
    expect(verdict.summary?.failedFiles).toBe(2);
    expect(verdict.failures).toEqual(expect.arrayContaining([
      'Vitest reported 2 failed test file(s).',
      'Vitest reported 3 failed test suite(s).'
    ]));
    expect(verdict.failures).not.toContain('Vitest reported 3 failed test file(s).');
  });

  it('counts a file collection failure even when it contains no failed assertions', () => {
    const failed = { ...file('tests/a.test.ts', []), status: 'failed' };
    const verdict = evaluateTestResults({
      results: results([failed, file('tests/b.test.ts', ['passed'])], { success: false }), tests, root
    });
    expect(verdict.summary).toMatchObject({ failed: 0, failedFiles: 1 });
    expect(verdict.failures).toEqual(expect.arrayContaining([
      'Vitest reported 1 failed test file(s).',
      'Test file failed: tests/a.test.ts'
    ]));
  });

  it('still fails a positive suite aggregate when no file status reports a failure', () => {
    const verdict = evaluateTestResults({
      results: results([file('tests/a.test.ts', ['passed']), file('tests/b.test.ts', ['passed'])],
        { numFailedTestSuites: 2 }), tests, root
    });
    expect(verdict.summary?.failedFiles).toBe(0);
    expect(verdict.failures).toEqual(['Vitest reported 2 failed test suite(s).']);
  });

  it.each([undefined, null, '1', 1.5])('still fails a missing or invalid suite aggregate (%s)', failedSuites => {
    const verdict = evaluateTestResults({
      results: results([file('tests/a.test.ts', ['passed']), file('tests/b.test.ts', ['passed'])],
        { numFailedTestSuites: failedSuites }), tests, root
    });
    expect(verdict.summary?.failedFiles).toBe(0);
    expect(verdict.failures).toEqual(['Vitest reported an unknown number of failed test suite(s).']);
  });

  it('rejects aggregate passed tests with no assertion records', () => {
    const verdict = evaluateTestResults({
      results: results([file('tests/a.test.ts', []), file('tests/b.test.ts', [])],
        { numTotalTests: 1, numPassedTests: 1 }), tests, root
    });
    expect(verdict.failures).toEqual([
      'Vitest test count total (1) does not equal its assertion-record count (0).',
      'Vitest test count passed (1) does not equal its assertion-record count (0).'
    ]);
  });

  it('rejects repeated passed file records instead of treating matching aggregate counts as proof', () => {
    const verdict = evaluateTestResults({
      results: results([file('tests/a.test.ts', ['passed']), file('tests/b.test.ts', ['passed']),
        file('tests/a.test.ts', ['passed'])]), tests, root
    });
    expect(verdict.summary).toMatchObject({ files: 3, total: 3, passed: 3 });
    expect(verdict.failures).toEqual(['Vitest reported duplicate test file record: tests/a.test.ts']);
  });

  it('checks duplicate file identities after path normalization', () => {
    const alias = { ...file('tests/a.test.ts', ['passed']), name: `${root}/tests/./a.test.ts` };
    const verdict = evaluateTestResults({
      results: results([file('tests/a.test.ts', ['passed']), file('tests/b.test.ts', ['passed']), alias]), tests, root
    });
    expect(verdict.failures).toEqual(['Vitest reported duplicate test file record: tests/a.test.ts']);
  });

  it('retains every failure in duplicate file records rather than silently discarding the repeated data', () => {
    const verdict = evaluateTestResults({
      results: results([file('tests/a.test.ts', ['failed']), file('tests/b.test.ts', ['passed']),
        file('tests/a.test.ts', ['failed'])]), tests, root
    });
    expect(verdict.summary).toMatchObject({ files: 3, total: 3, failed: 2, failedFiles: 2 });
    expect(verdict.failures).toContain('Vitest reported duplicate test file record: tests/a.test.ts');
    expect(verdict.failures.filter(message => message === 'Test failed: tests/a.test.ts > tests/a.test.ts case 0'))
      .toHaveLength(2);
  });

  it('retains unrun evidence in repeated file records while rejecting their identity ambiguity', () => {
    const verdict = evaluateTestResults({
      results: results([file('tests/a.test.ts', ['passed']), file('tests/b.test.ts', ['passed']),
        file('tests/a.test.ts', ['skipped'])]), tests, root
    });
    expect(verdict.failures).toEqual(['Vitest reported duplicate test file record: tests/a.test.ts']);
    expect(verdict.summary?.unrun).toEqual([{ file: 'tests/a.test.ts', test: 'tests/a.test.ts case 0', status: 'skipped' }]);
  });

  it.each([
    ['numTotalTests', 'total'],
    ['numPassedTests', 'passed'],
    ['numFailedTests', 'failed'],
    ['numPendingTests', 'skipped'],
    ['numTodoTests', 'todo']
  ].flatMap(([field, label]) => [undefined, null, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]
    .map(value => ({ field, label, value }))))
  ('rejects malformed $field ($value)', ({ field, label, value }) => {
    const verdict = evaluateTestResults({
      results: results([file('tests/a.test.ts', ['passed']), file('tests/b.test.ts', ['passed'])],
        { [field]: value }), tests, root
    });
    expect(verdict.failures).toContain(`Vitest test count ${label} must be a nonnegative safe integer.`);
  });

  it.each([
    ['numTotalTests', 'total', 3],
    ['numPassedTests', 'passed', 3],
    ['numFailedTests', 'failed', 1],
    ['numPendingTests', 'skipped', 1],
    ['numTodoTests', 'todo', 1]
  ])('rejects an inconsistent %s', (field, label, value) => {
    const verdict = evaluateTestResults({
      results: results([file('tests/a.test.ts', ['passed']), file('tests/b.test.ts', ['passed'])],
        { [field]: value }), tests, root
    });
    expect(verdict.failures).toEqual(expect.arrayContaining([
      expect.stringMatching(`^Vitest test count ${label} .* does not equal its assertion-record count`)
    ]));
  });

  it('keeps skipped, pending and todo assertion records as distinct unrun evidence', () => {
    const verdict = evaluateTestResults({
      results: results([file('tests/a.test.ts', ['passed', 'skipped', 'pending']), file('tests/b.test.ts', ['todo'])]),
      tests, root
    });
    expect(verdict.failures).toEqual([]);
    expect(verdict.summary).toMatchObject({ total: 4, passed: 1, failed: 0, skipped: 2, todo: 1 });
    expect(verdict.summary?.unrun.map((entry: { status: string }) => entry.status)).toEqual(['skipped', 'pending', 'todo']);
  });

  it.each([
    ['skipped'],
    ['todo'],
    ['pending'],
    ['skipped', 'todo'],
    ['skipped', 'pending', 'todo']
  ].map(statuses => ({ label: statuses.join('/'), statuses })))
  ('rejects a corpus with only unrun assertion statuses ($label)', ({ statuses }) => {
    const verdict = evaluateTestResults({
      results: results([file('tests/a.test.ts', statuses), file('tests/b.test.ts', [])]), tests, root
    });
    expect(verdict.failures).toContain('Vitest executed no tests; all registered assertion records are unrun.');
    expect(verdict.summary?.unrun.map((entry: { status: string }) => entry.status)).toEqual(statuses);
  });

  it.each([undefined, null, 'running', 'unrecognized'])('rejects an invalid assertion status (%s)', status => {
    const report = results([file('tests/a.test.ts', ['passed']), file('tests/b.test.ts', ['passed'])]);
    const verdict = evaluateTestResults({
      results: { ...report, testResults: report.testResults.map((entry, index) => index === 0
        ? { ...entry, assertionResults: entry.assertionResults.map(assertion => ({ ...assertion, status })) } : entry) },
      tests, root
    });
    expect(verdict.failures).toContain('Test has an invalid status: tests/a.test.ts > tests/a.test.ts case 0');
    expect(verdict.summary?.unrun.map((entry: { status: string }) => entry.status)[0]).toBe(String(status ?? 'unknown'));
  });

  it.each([undefined, null, {}])('rejects a missing or malformed assertion array (%s)', assertionResults => {
    const report = results([file('tests/a.test.ts', ['passed']), file('tests/b.test.ts', ['passed'])]);
    const verdict = evaluateTestResults({
      results: { ...report, testResults: report.testResults.map((entry, index) => index === 0
        ? { ...entry, assertionResults } : entry) }, tests, root
    });
    expect(verdict.failures).toContain('Test file has no assertion-results array: tests/a.test.ts');
  });

  it.each([undefined, null, 'running'])('rejects an invalid file status (%s)', status => {
    const report = results([file('tests/a.test.ts', ['passed']), file('tests/b.test.ts', ['passed'])]);
    const verdict = evaluateTestResults({
      results: { ...report, testResults: report.testResults.map((entry, index) => index === 0
        ? { ...entry, status } : entry) }, tests, root
    });
    expect(verdict.failures).toContain('Test file has an invalid status: tests/a.test.ts');
  });

  it.each([-1, Number.MAX_SAFE_INTEGER + 1])('rejects a negative or unsafe suite aggregate (%s)', failedSuites => {
    const verdict = evaluateTestResults({
      results: results([file('tests/a.test.ts', ['passed']), file('tests/b.test.ts', ['passed'])],
        { numFailedTestSuites: failedSuites }), tests, root
    });
    expect(verdict.failures).toEqual(['Vitest reported an unknown number of failed test suite(s).']);
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

  it('matches actual pinned-provider skipped and todo counts without treating them as passed', async () => {
    const root = await fixturePackage({
      sources: { 'src/covered.ts': 'export const covered = (value: number) => value > 0 ? value : -value;\n' },
      tests: {
        'tests/covered.test.ts': [
          "import { expect, it } from 'vitest';",
          "import { covered } from '../src/covered.ts';",
          "it('covers both branches', () => { expect(covered(2)).toBe(2); expect(covered(-3)).toBe(3); });",
          "it.skip('is host-gated elsewhere', () => {});",
          "it.todo('is not implemented elsewhere');",
          ''
        ].join('\n')
      }
    });
    const evidence = await gate(root);
    expect(evidence.result).toBe('passed');
    expect(evidence.tests).toMatchObject({ files: 1, total: 3, passed: 1, failed: 0, skipped: 1, todo: 1 });
    expect(evidence.tests.unrun.map((entry: { status: string }) => entry.status)).toEqual(['skipped', 'todo']);
    await expect(verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision }))
      .resolves.toMatchObject({ result: 'passed', failures: [] });
  }, 60_000);

  it('rejects an all-unrun pinned-provider fixture even when collection covers every source metric', async () => {
    const root = await fixturePackage({
      sources: {
        'src/covered.ts': [
          'export function covered(value: number): number {',
          '  return value > 0 ? value : -value;',
          '}',
          'export const observed = [covered(2), covered(-3)];',
          ''
        ].join('\n')
      },
      tests: {
        'tests/covered.test.ts': [
          "import { it } from 'vitest';",
          "import { observed } from '../src/covered.ts';",
          'void observed;',
          "it.skip('has not executed', () => {});",
          "it.todo('has not been implemented');",
          ''
        ].join('\n')
      }
    });
    const evidence = await gate(root);
    const report = JSON.parse(await readFile(path.join(root, 'coverage', 'fixture', 'test-results.json'), 'utf8'));
    expect(evidence.invocation.exitCode).toBe(0);
    expect(evidence.tests).toMatchObject({ total: 2, passed: 0, failed: 0, skipped: 1, todo: 1 });
    for (const metric of coverageMetrics) expect(evidence.metrics[metric].percent).toBe('100.0000');
    expect(evidence.result, JSON.stringify({
      invocation: evidence.invocation, tests: evidence.tests, metrics: evidence.metrics, rawTestResults: report
    })).toBe('failed');
    expect(evidence.failures).toContain('Vitest executed no tests; all registered assertion records are unrun.');
  }, 60_000);

  it('rejects saved passing evidence when raw aggregate totals outnumber its unchanged assertion records', async () => {
    const root = await fixturePackage();
    expect((await gate(root)).result).toBe('passed');
    const reportPath = path.join(root, 'coverage', 'fixture', 'test-results.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    report.numTotalTests += 1;
    report.numPassedTests += 1;
    await writeFile(reportPath, JSON.stringify(report));
    const evidence = await verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision });
    expect(evidence.result).toBe('failed');
    expect(evidence.failures).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Vitest test count total .* does not equal its assertion-record count/),
      expect.stringMatching(/^Vitest test count passed .* does not equal its assertion-record count/)
    ]));
  }, 60_000);

  it('rejects duplicated file records in saved evidence even when repeated assertions match the totals', async () => {
    const root = await fixturePackage();
    expect((await gate(root)).result).toBe('passed');
    const reportPath = path.join(root, 'coverage', 'fixture', 'test-results.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    expect(report.testResults.length).toBeGreaterThan(0);
    report.testResults.push(...structuredClone(report.testResults));
    for (const field of ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests']) {
      report[field] *= 2;
    }
    await writeFile(reportPath, JSON.stringify(report));
    const evidence = await verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision });
    expect(evidence.result, JSON.stringify({ failures: evidence.failures, rawTestResults: report }))
      .toBe('failed');
    expect(evidence.failures).toContain('Vitest reported duplicate test file record: tests/covered.test.ts');
  }, 60_000);

  it('rejects saved summary aliases that hide uncovered source records behind complete retained totals', async () => {
    const root = await fixturePackage();
    expect((await gate(root)).result).toBe('passed');
    const reportPath = path.join(root, 'coverage', 'fixture', 'coverage-summary.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    const name = Object.keys(report).find(key => key.replaceAll('\\', '/').endsWith('/src/covered.ts'));
    if (name === undefined) throw new Error('Fixture coverage summary lacks src/covered.ts.');
    const alias = name.replaceAll('\\', '/').replace('/src/covered.ts', '/src/./covered.ts');
    const ambiguous = { [alias]: metrics(0, 100), ...report };
    await writeFile(reportPath, JSON.stringify(ambiguous));
    const evidence = await verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision });
    expect(evidence.result, JSON.stringify({ failures: evidence.failures, rawCoverageSummary: ambiguous }))
      .toBe('failed');
    expect(evidence.failures).toContain('Coverage report contains duplicate source file record: src/covered.ts');
  }, 60_000);

  it('rejects saved final aliases even when source counts and retained evidence are unchanged', async () => {
    const root = await fixturePackage();
    expect((await gate(root)).result).toBe('passed');
    const reportPath = path.join(root, 'coverage', 'fixture', 'coverage-final.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    const name = Object.keys(report).find(key => key.replaceAll('\\', '/').endsWith('/src/covered.ts'));
    if (name === undefined) throw new Error('Fixture final coverage lacks src/covered.ts.');
    const alias = name.replaceAll('\\', '/').replace('/src/covered.ts', '/src/./covered.ts');
    await writeFile(reportPath, JSON.stringify({ [alias]: structuredClone(report[name]), ...report }));
    const evidence = await verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision });
    expect(evidence.result).toBe('failed');
    expect(evidence.failures).toContain('coverage-final.json contains duplicate source file record: src/covered.ts');
  }, 60_000);

  it('rejects a saved final source record whose payload path names another file', async () => {
    const root = await fixturePackage();
    expect((await gate(root)).result).toBe('passed');
    const file = path.join(root, 'coverage', 'fixture', 'coverage-final.json');
    const report = JSON.parse(await readFile(file, 'utf8'));
    const key = Object.keys(report).find(name => name.replaceAll('\\', '/').endsWith('/src/covered.ts'));
    if (key === undefined) throw new Error('Fixture final coverage lacks src/covered.ts.');
    const originalPayloadPath = report[key].path;
    report[key].path = path.join(root, 'src', 'entry.ts');
    await writeFile(file, JSON.stringify(report));
    const verdict = await verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision });
    expect(verdict.result, JSON.stringify({
      failures: verdict.failures, key, originalPayloadPath, changedPayloadPath: report[key].path
    })).toBe('failed');
    expect(verdict.failures).toContain('coverage-final.json source record src/covered.ts declares another source path: src/entry.ts');
  }, 60_000);

  it('rejects malformed saved final record payloads without mutating retained reports', async () => {
    const root = await fixturePackage();
    expect((await gate(root)).result).toBe('passed');
    const file = path.join(root, 'coverage', 'fixture', 'coverage-final.json');
    const original = await readFile(file, 'utf8');
    for (const record of [null, true, 'src/covered.ts', [], {}, { path: 42 }, { path: '' }]) {
      const report = JSON.parse(original);
      const key = Object.keys(report).find(name => name.replaceAll('\\', '/').endsWith('/src/covered.ts'));
      if (key === undefined) throw new Error('Fixture final coverage lacks src/covered.ts.');
      report[key] = record;
      const bytes = JSON.stringify(report);
      await writeFile(file, bytes);
      const verdict = await verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision });
      expect(verdict.result).toBe('failed');
      expect(verdict.failures).toContain('coverage-final.json source record src/covered.ts lacks a valid path identity.');
      expect(await readFile(file, 'utf8')).toBe(bytes);
    }
    await writeFile(file, original);
    await expect(verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision }))
      .resolves.toMatchObject({ result: 'passed', failures: [] });
  }, 60_000);

  it('rejects saved coverage whose final statement hits contradict its summary', async () => {
    const root = await fixturePackage();
    expect((await gate(root)).result).toBe('passed');
    const directory = path.join(root, 'coverage', 'fixture');
    const file = path.join(directory, 'coverage-final.json');
    const summaryBytes = await readFile(path.join(directory, 'coverage-summary.json'), 'utf8');
    const evidenceBytes = await readFile(path.join(directory, coverageEvidenceFile), 'utf8');
    const report = JSON.parse(await readFile(file, 'utf8'));
    const key = Object.keys(report).find(name => name.replaceAll('\\', '/').endsWith('/src/covered.ts'));
    if (key === undefined) throw new Error('Fixture final coverage lacks src/covered.ts.');
    const originalRecord = structuredClone(report[key]);
    expect(Object.keys(report[key].s).length).toBeGreaterThan(0);
    for (const id of Object.keys(report[key].s)) report[key].s[id] = 0;
    const changedBytes = JSON.stringify(report);
    await writeFile(file, changedBytes);
    const verdict = await verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision });
    expect(await readFile(path.join(directory, 'coverage-summary.json'), 'utf8')).toBe(summaryBytes);
    expect(await readFile(path.join(directory, coverageEvidenceFile), 'utf8')).toBe(evidenceBytes);
    expect(await readFile(file, 'utf8')).toBe(changedBytes);
    expect(verdict.result, JSON.stringify({
      verdict, key, originalRecord, changedRecord: report[key], unchangedSummary: JSON.parse(summaryBytes)
    })).toBe('failed');
    expect(verdict.failures).toEqual(expect.arrayContaining([
      expect.stringMatching(/^coverage-final\.json source record src\/covered\.ts statements counts .* do not match/),
      expect.stringMatching(/^coverage-final\.json source record src\/covered\.ts lines counts .* do not match/)
    ]));
  }, 60_000);

  it('rejects contradictory reports in a fresh gate from a fixture-local synthetic producer', async () => {
    const root = await fixturePackage();
    expect((await gate(root)).result).toBe('passed');
    const directory = path.join(root, 'coverage', 'fixture');
    const reports: Record<string, unknown> = {};
    for (const name of ['coverage-summary.json', 'coverage-final.json', 'test-results.json']) {
      reports[name] = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
    }
    const final = JSON.parse(await readFile(path.join(directory, 'coverage-final.json'), 'utf8'));
    const key = Object.keys(final).find(name => name.replaceAll('\\', '/').endsWith('/src/covered.ts'));
    if (key === undefined) throw new Error('Fixture final coverage lacks src/covered.ts.');
    for (const id of Object.keys(final[key].s)) final[key].s[id] = 0;
    reports['coverage-final.json'] = final;
    const localVitest = path.join(root, 'node_modules', 'vitest');
    await mkdir(localVitest, { recursive: true });
    await writeFile(path.join(localVitest, 'package.json'),
      await readFile(path.join(repository, 'node_modules', 'vitest', 'package.json'), 'utf8'));
    await writeFile(path.join(localVitest, 'vitest.mjs'), [
      "import { mkdir, writeFile } from 'node:fs/promises';",
      "import path from 'node:path';",
      `const reports = ${JSON.stringify(reports)};`,
      `const directory = ${JSON.stringify(directory)};`,
      'await mkdir(directory, { recursive: true });',
      'for (const [name, value] of Object.entries(reports)) {',
      '  await writeFile(path.join(directory, name), JSON.stringify(value));',
      '}', ''
    ].join('\n'));
    const verdict = await gate(root);
    expect(verdict.invocation.exitCode).toBe(0);
    expect(verdict.metrics.statements.percent).toBe('100.0000');
    expect(verdict.result).toBe('failed');
    expect(verdict.failures).toEqual(expect.arrayContaining([
      expect.stringMatching(/^coverage-final\.json source record src\/covered\.ts statements counts .* do not match/),
      expect.stringMatching(/^coverage-final\.json source record src\/covered\.ts lines counts .* do not match/)
    ]));
  }, 60_000);

  it.each(['functions', 'branches', 'lines'])(
    'rejects saved final %s counts that contradict the unchanged summary', async metric => {
      const root = await fixturePackage({
        sources: {
          'src/covered.ts': [
            'export function covered(value: number): number {',
            '  const magnitude = value > 0 ? value : -value;',
            '  return magnitude;',
            '}', ''
          ].join('\n'),
          'src/entry.ts': 'export function unimportedEntrypoint(): string { return "never imported by a test"; }\n'
        }
      });
      expect((await gate(root)).result).toBe('passed');
      const file = path.join(root, 'coverage', 'fixture', 'coverage-final.json');
      const report = JSON.parse(await readFile(file, 'utf8'));
      const key = Object.keys(report).find(name => name.replaceAll('\\', '/').endsWith('/src/covered.ts'));
      if (key === undefined) throw new Error('Fixture final coverage lacks src/covered.ts.');
      if (metric === 'functions') {
        for (const id of Object.keys(report[key].f)) report[key].f[id] = 0;
      } else if (metric === 'branches') {
        for (const id of Object.keys(report[key].b)) report[key].b[id] = report[key].b[id].map(() => 0);
      } else {
        const lines = Object.keys(report[key].statementMap).map(id => report[key].statementMap[id].start.line);
        expect(new Set(lines).size).toBeGreaterThan(1);
        for (const id of Object.keys(report[key].statementMap)) report[key].statementMap[id].start.line = lines[0];
      }
      const changedBytes = JSON.stringify(report);
      await writeFile(file, changedBytes);
      const verdict = await verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision });
      expect(verdict.result, JSON.stringify(verdict)).toBe('failed');
      expect(verdict.failures).toContainEqual(expect.stringMatching(new RegExp(
        `^coverage-final\\.json source record src/covered\\.ts ${metric} counts .* do not match`
      )));
      expect(await readFile(file, 'utf8')).toBe(changedBytes);
    }, 60_000
  );

  it('rejects malformed final hit maps and counters before provider summarization', async () => {
    const root = await fixturePackage();
    expect((await gate(root)).result).toBe('passed');
    const file = path.join(root, 'coverage', 'fixture', 'coverage-final.json');
    const original = await readFile(file, 'utf8');
    const originalReport = JSON.parse(original);
    const key = Object.keys(originalReport).find(name => name.replaceAll('\\', '/').endsWith('/src/covered.ts'));
    if (key === undefined) throw new Error('Fixture final coverage lacks src/covered.ts.');
    const statement = Object.keys(originalReport[key].s)[0];
    const fn = Object.keys(originalReport[key].f)[0];
    const branch = Object.keys(originalReport[key].b)[0];
    expect(statement).toBeDefined();
    expect(fn).toBeDefined();
    expect(branch).toBeDefined();
    const records = [];
    for (const value of [-1, 0.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
      for (const kind of ['s', 'f', 'b']) {
        const record = structuredClone(originalReport[key]);
        if (kind === 'b') record.b[branch][0] = value;
        else record[kind][kind === 's' ? statement : fn] = value;
        records.push(record);
      }
    }
    for (const kind of ['statementMap', 'fnMap', 'branchMap', 's', 'f', 'b']) {
      for (const value of [undefined, null, []]) {
        const record = structuredClone(originalReport[key]);
        if (value === undefined) delete record[kind];
        else record[kind] = value;
        records.push(record);
      }
    }
    for (const [kind, id] of [['statementMap', statement], ['fnMap', fn], ['branchMap', branch]]) {
      const record = structuredClone(originalReport[key]);
      delete record[kind][id];
      records.push(record);
    }
    const missingLocation = structuredClone(originalReport[key]);
    delete missingLocation.statementMap[statement].start;
    records.push(missingLocation);
    const invalidLine = structuredClone(originalReport[key]);
    invalidLine.statementMap[statement].start.line = 0;
    records.push(invalidLine);
    const shortBranch = structuredClone(originalReport[key]);
    shortBranch.b[branch].pop();
    records.push(shortBranch);
    const invalidFunction = structuredClone(originalReport[key]);
    invalidFunction.fnMap[fn] = null;
    records.push(invalidFunction);
    for (const record of records) {
      const bytes = JSON.stringify({ ...JSON.parse(original), [key]: record });
      await writeFile(file, bytes);
      const verdict = await verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision });
      expect(verdict.result, bytes).toBe('failed');
      expect(verdict.failures).toContain('coverage-final.json source record src/covered.ts has malformed hit maps or counters.');
      expect(await readFile(file, 'utf8')).toBe(bytes);
    }
    await writeFile(file, original);
    await expect(verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision }))
      .resolves.toMatchObject({ result: 'passed', failures: [] });
  }, 60_000);

  it('rejects summary counts changed consistently with saved evidence but not with final hits', async () => {
    const root = await fixturePackage();
    expect((await gate(root)).result).toBe('passed');
    const directory = path.join(root, 'coverage', 'fixture');
    const summaryFile = path.join(directory, 'coverage-summary.json');
    const evidenceFile = path.join(directory, coverageEvidenceFile);
    const finalBytes = await readFile(path.join(directory, 'coverage-final.json'), 'utf8');
    const summary = JSON.parse(await readFile(summaryFile, 'utf8'));
    const evidence = JSON.parse(await readFile(evidenceFile, 'utf8'));
    const key = Object.keys(summary).find(name => name.replaceAll('\\', '/').endsWith('/src/covered.ts'));
    if (key === undefined) throw new Error('Fixture coverage summary lacks src/covered.ts.');
    for (const metric of coverageMetrics) {
      summary[key][metric].covered += 1;
      summary[key][metric].total += 1;
      summary.total[metric].covered += 1;
      summary.total[metric].total += 1;
      evidence.metrics[metric].covered += 1;
      evidence.metrics[metric].total += 1;
    }
    await writeFile(summaryFile, JSON.stringify(summary));
    await writeFile(evidenceFile, JSON.stringify(evidence));
    const verdict = await verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision });
    expect(verdict.result).toBe('failed');
    expect(verdict.failures).toHaveLength(4);
    for (const metric of coverageMetrics) {
      expect(verdict.failures).toContainEqual(expect.stringMatching(new RegExp(
        `^coverage-final\\.json source record src/covered\\.ts ${metric} counts .* do not match`
      )));
    }
    expect(await readFile(path.join(directory, 'coverage-final.json'), 'utf8')).toBe(finalBytes);
  }, 60_000);

  it('preserves legitimate provider counts, large hit magnitudes and relative final identities', async () => {
    const root = await fixturePackage();
    expect((await gate(root)).result).toBe('passed');
    const file = path.join(root, 'coverage', 'fixture', 'coverage-final.json');
    const report = JSON.parse(await readFile(file, 'utf8'));
    for (const [key, record] of Object.entries(report)) {
      const source = report[key];
      source.path = path.relative(root, key);
      for (const kind of ['s', 'f']) {
        for (const id of Object.keys(source[kind])) {
          if (source[kind][id] > 0) source[kind][id] = Number.MAX_SAFE_INTEGER;
        }
      }
      for (const id of Object.keys(source.b)) {
        source.b[id] = source.b[id].map((hit: number) => hit > 0 ? Number.MAX_SAFE_INTEGER : 0);
      }
      expect(record).toBe(source);
    }
    const bytes = JSON.stringify(report);
    await writeFile(file, bytes);
    await expect(verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision }))
      .resolves.toMatchObject({ result: 'passed', failures: [] });
    expect(await readFile(file, 'utf8')).toBe(bytes);
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

  it('reports actual failed files rather than nested suites from a real pinned-provider failure', async () => {
    const root = await fixturePackage({
      tests: {
        'tests/covered.test.ts': [
          "import { describe, expect, it } from 'vitest';",
          "describe('first nested suite', () => it('fails first', () => expect(1).toBe(2)));",
          "describe('second nested suite', () => it('fails second', () => expect(3).toBe(4)));",
          ''
        ].join('\n'),
        'tests/entry.test.ts': "import { it } from 'vitest';\nit.skip('is entirely host-gated', () => {});\n"
      }
    });
    const evidence = await gate(root);
    const report = JSON.parse(await readFile(path.join(root, 'coverage', 'fixture', 'test-results.json'), 'utf8'));
    expect(report.numFailedTestSuites).toBeGreaterThan(1);
    expect(report.testResults.filter((entry: { status: string }) => entry.status === 'failed')).toHaveLength(1);
    expect(evidence.result).toBe('failed');
    expect(evidence.invocation.exitCode).toBe(1);
    expect(evidence.tests).toMatchObject({ files: 2, failed: 2, failedFiles: 1, skipped: 1 });
    expect(evidence.tests.unrun).toEqual([
      { file: 'tests/entry.test.ts', test: 'is entirely host-gated', status: 'skipped' }
    ]);
    expect(evidence.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('Vitest exited with 1;'),
      'Vitest reported 1 failed test file(s).',
      `Vitest reported ${report.numFailedTestSuites} failed test suite(s).`
    ]));
    expect(evidence.failures).not.toContain(`Vitest reported ${report.numFailedTestSuites} failed test file(s).`);
    expect(evidence.metrics).toEqual({});
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

  it('rejects saved coverage evidence whose recorded provider identity changed', async () => {
    const root = await fixturePackage();
    expect((await gate(root)).result).toBe('passed');
    const file = path.join(root, 'coverage', 'fixture', coverageEvidenceFile);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.tools.provider = 'istanbul';
    await writeFile(file, JSON.stringify(saved));
    const verdict = await verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision });
    expect(verdict.result, JSON.stringify({ failures: verdict.failures, savedTools: saved.tools })).toBe('failed');
    expect(verdict.failures).toContain('Saved evidence does not record the V8 coverage provider.');
  }, 60_000);

  it('rejects malformed saved runtime identities rather than accepting truthy data', async () => {
    const root = await fixturePackage();
    expect((await gate(root)).result).toBe('passed');
    const file = path.join(root, 'coverage', 'fixture', coverageEvidenceFile);
    const original = await readFile(file, 'utf8');
    for (const node of [true, {}, [], '', null, 'unknown']) {
      const saved = JSON.parse(original);
      saved.tools.node = node;
      await writeFile(file, JSON.stringify(saved));
      const verdict = await verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision });
      expect(verdict.result).toBe('failed');
      expect(verdict.failures).toContain('Saved evidence lacks a valid Node runtime version.');
    }
  }, 60_000);

  it('binds every recorded package version field and required descriptor to current pins', async () => {
    const root = await fixturePackage();
    expect((await gate(root)).result).toBe('passed');
    const file = path.join(root, 'coverage', 'fixture', coverageEvidenceFile);
    const original = await readFile(file, 'utf8');
    for (const name of ['vitest', '@vitest/coverage-v8', 'vite']) {
      for (const field of ['declared', 'locked', 'installed']) {
        const saved = JSON.parse(original);
        saved.tools.packages[name][field] = '0.0.0';
        await writeFile(file, JSON.stringify(saved));
        const verdict = await verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision });
        expect(verdict.result).toBe('failed');
        expect(verdict.failures).toContain(`Saved evidence ${name} ${field} version does not match the current pinned tool.`);
      }
      const missing = JSON.parse(original);
      delete missing.tools.packages[name];
      await writeFile(file, JSON.stringify(missing));
      const verdict = await verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision });
      expect(verdict.result).toBe('failed');
      for (const field of ['declared', 'locked', 'installed']) {
        expect(verdict.failures).toContain(`Saved evidence ${name} ${field} version does not match the current pinned tool.`);
      }
    }
  }, 60_000);

  it('rejects current installed provider drift even when saved metadata and project files are unchanged', async () => {
    const root = await fixturePackage();
    const provider = path.join(root, 'node_modules', '@vitest', 'coverage-v8');
    await cp(path.join(repository, 'node_modules', '@vitest', 'coverage-v8'), provider, { recursive: true });
    expect((await gate(root)).result).toBe('passed');
    const manifest = path.join(provider, 'package.json');
    const installed = JSON.parse(await readFile(manifest, 'utf8'));
    installed.version = '0.0.0';
    await writeFile(manifest, JSON.stringify(installed));
    const verdict = await verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision });
    expect(verdict.result).toBe('failed');
    expect(verdict.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('@vitest/coverage-v8 installed version "0.0.0" differs from the declared pin "5.0.0"')
    ]));
  }, 60_000);

  it('accepts reordered valid tool descriptors and nullable npm observations', async () => {
    const root = await fixturePackage();
    expect((await gate(root)).result).toBe('passed');
    const file = path.join(root, 'coverage', 'fixture', coverageEvidenceFile);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    const packages = saved.tools.packages;
    saved.tools.packages = Object.fromEntries(['vite', '@vitest/coverage-v8', 'vitest'].map(name => [name, {
      installed: packages[name].installed, locked: packages[name].locked, declared: packages[name].declared
    }]));
    saved.tools.npm = null;
    await writeFile(file, JSON.stringify(saved));
    await expect(verifyCoverageEvidence(fixtureDefinition(), { root, revision: fixedRevision }))
      .resolves.toMatchObject({ result: 'passed', failures: [] });
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
