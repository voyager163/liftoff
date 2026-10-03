#!/usr/bin/env node
// Source-complete coverage gate for the Liftoff CLI and the telemetry ingestion
// gateway. Each package is measured and judged independently; nothing here
// merges packages, excludes low-covered sources or reuses an older report.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const coverageFloorPercent = 80.01;
export const coverageMetrics = ['statements', 'branches', 'functions', 'lines'];
export const coverageEvidenceSchemaVersion = 1;
export const coverageEvidenceFile = 'coverage-evidence.json';
export const defaultMaxWorkers = 2;
export const coverageTestEnvironment = Object.freeze({ CI: 'true', LIFTOFF_TELEMETRY: '0', DO_NOT_TRACK: '1' });

const floorBasisPoints = Math.round(coverageFloorPercent * 100);
const pinnedToolPackages = ['vitest', '@vitest/coverage-v8', 'vite'];
const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export const coverageLimits = Object.freeze([
  'Measures V8 in-process coverage of the listed source inventory during this exact invocation only.',
  'Child processes, installed packages, generated applications and live providers are not measured by this report; they need their own native, package, generated-project or live qualification evidence.',
  'Tests listed under tests.unrun were skipped or host-gated in this run and are not evidence of the behavior they cover.',
  'Build, clean, packaging, release and smoke scripts are repository tooling outside the runtime inventory; their own tests and smoke checks are their evidence.'
]);

export const coveragePackages = Object.freeze({
  cli: Object.freeze({
    id: 'cli',
    description: 'Liftoff CLI (published @msn-control/liftoff runtime compiled from tsconfig.json include)',
    rootParts: [],
    reportParts: ['coverage', 'cli'],
    testParts: [['tests']],
    requiredSources: ['src/cli.ts'],
    separatelyQualified: [
      'assets/repair/windows-job-controller.ps1 (packaged PowerShell helper; Windows native CI lanes)',
      'Installed npm package and exact release tarball (npm run smoke:package)',
      'Generated applications and containers (npm run verify:generated-containers, verify:standard-node-templates)',
      'Pinned OpenSpec/Spec Kit, native OpenTofu and locked dependency preparation (host-gated CI steps)'
    ]
  }),
  gateway: Object.freeze({
    id: 'gateway',
    description: 'Telemetry ingestion gateway (deployed runtime compiled from services/telemetry-ingest/tsconfig.json include)',
    rootParts: ['services', 'telemetry-ingest'],
    reportParts: ['coverage', 'gateway'],
    testParts: [['services', 'telemetry-ingest', 'tests']],
    requiredSources: ['services/telemetry-ingest/src/index.ts', 'src/telemetry/contract.ts'],
    separatelyQualified: [
      'Runtime container image (npm run smoke:container --prefix services/telemetry-ingest)',
      'Telemetry OpenTofu configuration (tofu fmt/validate and tests/telemetry-infrastructure.test.ts)',
      'Live Azure managed-identity ingestion (operator-approved deployment only)'
    ]
  })
});

export class CoverageGateError extends Error {}

function fail(message) {
  throw new CoverageGateError(message);
}

export function coveragePackage(id) {
  const definition = Object.hasOwn(coveragePackages, id) ? coveragePackages[id] : undefined;
  if (!definition) fail(`Unknown coverage package ${JSON.stringify(id)}; expected one of ${Object.keys(coveragePackages).join(', ')}.`);
  return definition;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function portablePath(root, file) {
  const relative = path.relative(root, path.resolve(root, file));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`Path escapes the repository: ${file}`);
  }
  return relative.split(path.sep).join('/');
}

export function digestEntries(entries) {
  const hash = createHash('sha256');
  // Code-point order keeps digests identical across host locales.
  for (const entry of [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))) {
    hash.update(`${entry.path}\0${entry.sha256}\n`);
  }
  return `sha256:${hash.digest('hex')}`;
}

function describeFiles(root, files) {
  const entries = [...new Set(files)].sort().map((file) => {
    const bytes = readFileSync(path.join(root, ...file.split('/')));
    return { path: file, sha256: sha256(bytes), bytes: bytes.length };
  });
  return { fileCount: entries.length, digest: digestEntries(entries), files: entries };
}

function readJsonFile(file, label) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

export function packageRoot(definition, root = repositoryRoot) {
  return path.join(root, ...definition.rootParts);
}

// The runtime inventory is the TypeScript build input: every .ts file matched by
// tsconfig include, imported by a test or not. Declaration files hold no code.
export function sourceInventory(definition, root = repositoryRoot) {
  const base = packageRoot(definition, root);
  const tsconfig = readJsonFile(path.join(base, 'tsconfig.json'), `${definition.id} tsconfig.json`);
  const patterns = tsconfig?.include;
  if (!Array.isArray(patterns) || patterns.length === 0 || !patterns.every((item) => typeof item === 'string' && item)) {
    fail(`${definition.id} tsconfig.json must declare a non-empty include inventory.`);
  }
  if (tsconfig.files !== undefined || tsconfig.exclude !== undefined) {
    fail(`${definition.id} tsconfig.json files/exclude would change the build inventory; extend the coverage gate first.`);
  }
  const files = patterns.flatMap((pattern) => globSync(pattern, { cwd: base })
    .map((file) => path.join(base, file))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts') && statSync(file).isFile())
    .map((file) => portablePath(root, file)));
  if (files.length === 0) fail(`${definition.id} source inventory is empty.`);
  const inventory = describeFiles(root, files);
  for (const required of definition.requiredSources) {
    if (!inventory.files.some((entry) => entry.path === required)) {
      fail(`${definition.id} source inventory no longer contains required runtime source ${required}.`);
    }
  }
  return { includes: [...patterns], ...inventory };
}

function filesBelow(root, directoryParts) {
  const directory = path.join(root, ...directoryParts);
  if (!existsSync(directory)) return [];
  return globSync('**/*', { cwd: directory })
    .map((file) => path.join(directory, file))
    .filter((file) => statSync(file).isFile())
    .map((file) => portablePath(root, file));
}

export function testInventory(definition, root = repositoryRoot) {
  const files = definition.testParts.flatMap((parts) => filesBelow(root, parts));
  if (files.length === 0) fail(`${definition.id} test inventory is empty.`);
  const inventory = describeFiles(root, files);
  const base = packageRoot(definition, root);
  const testFiles = globSync('tests/**/*.test.ts', { cwd: base })
    .map((file) => portablePath(root, path.join(base, file)))
    .sort();
  return { ...inventory, testFiles };
}

export function configurationInventory(definition, root = repositoryRoot) {
  const base = packageRoot(definition, root);
  const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts']
    .map((name) => portablePath(root, path.join(base, name)));
  const inventory = describeFiles(root, files);
  // The gate's own bytes are part of the invocation identity.
  const gate = readFileSync(fileURLToPath(import.meta.url));
  const entries = [...inventory.files, { path: 'scripts/coverage-gate.mjs', sha256: sha256(gate), bytes: gate.length }];
  return { fileCount: entries.length, digest: digestEntries(entries), files: entries };
}

function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root, encoding: 'utf8', shell: false, timeout: 60_000, maxBuffer: 32 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    fail(`Unable to identify the measured revision: git ${args.join(' ')} failed (${result.error?.message ?? result.stderr?.trim() ?? result.status}).`);
  }
  return result.stdout;
}

export function repositoryRevision(root = repositoryRoot) {
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) fail(`Unexpected revision identity: ${commit}`);
  const entries = git(root, ['status', '--porcelain=v1', '--untracked-files=all', '-z']).split('\0');
  const changed = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    changed.push(entry.slice(3));
    // Renames and copies are followed by their source path in -z output.
    if (/^[RC]|^.[RC]/.test(entry)) {
      if (entries[index + 1]) changed.push(entries[index + 1]);
      index += 1;
    }
  }
  const sorted = [...new Set(changed)].sort();
  return { commit, dirty: sorted.length > 0, changedPathCount: sorted.length, changedPaths: sorted.slice(0, 2000) };
}

function exactVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
}

// Resolves an installed tool the way Node would from the package root.
function installedPackageFile(base, name) {
  try {
    return createRequire(path.join(base, 'package.json')).resolve(`${name}/package.json`);
  } catch {
    return undefined;
  }
}

function installedVersion(base, name) {
  const file = installedPackageFile(base, name);
  return file ? readJsonFile(file, `${name} package.json`)?.version : undefined;
}

export function vitestEntry(base) {
  const file = installedPackageFile(base, 'vitest');
  if (!file) fail(`Vitest is not installed for ${base}; run npm ci.`);
  return path.join(path.dirname(file), 'vitest.mjs');
}

export function toolVersions(definition, root = repositoryRoot, env = process.env) {
  const base = packageRoot(definition, root);
  const manifest = readJsonFile(path.join(base, 'package.json'), `${definition.id} package.json`) ?? {};
  const lock = readJsonFile(path.join(base, 'package-lock.json'), `${definition.id} package-lock.json`) ?? {};
  const failures = [];
  const packages = {};
  for (const name of pinnedToolPackages) {
    const declared = manifest.devDependencies?.[name];
    const locked = lock.packages?.[`node_modules/${name}`]?.version;
    const installed = installedVersion(base, name);
    packages[name] = { declared: declared ?? null, locked: locked ?? null, installed: installed ?? null };
    if (!exactVersion(declared)) failures.push(`${name} must be an exact pinned devDependency; found ${JSON.stringify(declared ?? null)}.`);
    if (locked !== declared) failures.push(`${name} lockfile version ${JSON.stringify(locked ?? null)} differs from the declared pin ${JSON.stringify(declared ?? null)}.`);
    if (installed !== declared) failures.push(`${name} installed version ${JSON.stringify(installed ?? null)} differs from the declared pin ${JSON.stringify(declared ?? null)}; run npm ci.`);
  }
  if (packages['@vitest/coverage-v8'].declared !== packages.vitest.declared) {
    failures.push('@vitest/coverage-v8 must use the exact Vitest version it supports.');
  }
  const npm = /(?:^|\s)npm\/(\S+)/.exec(env.npm_config_user_agent ?? '')?.[1] ?? null;
  return {
    failures,
    tools: {
      node: process.version,
      npm,
      provider: 'v8',
      packages
    }
  };
}

function reportPath(root, file) {
  return portablePath(root, file);
}

function metricRecord(value) {
  if (!value || !Number.isSafeInteger(value.total) || !Number.isSafeInteger(value.covered) ||
      value.total < 0 || value.covered < 0 || value.covered > value.total) {
    return undefined;
  }
  return { covered: value.covered, total: value.total };
}

export function formatPercent(covered, total) {
  if (total === 0) return '0.0000';
  const scaled = (BigInt(covered) * 1_000_000n) / BigInt(total);
  const integer = scaled / 10_000n;
  const fraction = (scaled % 10_000n).toString().padStart(4, '0');
  return `${integer}.${fraction}`;
}

export function exceedsFloor(covered, total) {
  return total > 0 && covered * 10_000 >= floorBasisPoints * total;
}

// Judges one package's saved V8 summary/final reports against its current source
// inventory. Every metric is judged on its own exact integer counts.
export function evaluateCoverageReports({ summary, final, inventory, root = repositoryRoot }) {
  const failures = [];
  const metrics = {};
  if (summary === undefined) failures.push('Missing coverage-summary.json; a fresh coverage run is required.');
  if (final === undefined) failures.push('Missing coverage-final.json; a fresh coverage run is required.');
  if (summary !== undefined && (typeof summary !== 'object' || summary === null || Array.isArray(summary))) {
    failures.push('coverage-summary.json must be an object report.');
  }
  if (failures.length) return { failures, metrics };

  const expected = new Set(inventory.files.map((entry) => entry.path));
  const reported = new Map();
  for (const [key, value] of Object.entries(summary)) {
    if (key === 'total') continue;
    let file;
    try {
      file = reportPath(root, key);
    } catch {
      failures.push(`Coverage report contains a path outside the repository: ${key}`);
      continue;
    }
    reported.set(file, value);
  }
  const finalFiles = new Set();
  if (typeof final === 'object' && final !== null && !Array.isArray(final)) {
    for (const key of Object.keys(final)) {
      try {
        finalFiles.add(reportPath(root, key));
      } catch {
        failures.push(`coverage-final.json contains a path outside the repository: ${key}`);
      }
    }
  } else {
    failures.push('coverage-final.json must be an object report.');
  }
  if (reported.size === 0) failures.push('Coverage report is empty: it lists no source files.');
  const omitted = [...expected].filter((file) => !reported.has(file)).sort();
  const foreign = [...reported.keys()].filter((file) => !expected.has(file)).sort();
  if (omitted.length) failures.push(`Coverage report omits ${omitted.length} inventoried source file(s), including unimported entrypoints: ${omitted.join(', ')}`);
  if (foreign.length) failures.push(`Coverage report lists ${foreign.length} path(s) outside the current source inventory (stale or foreign report): ${foreign.join(', ')}`);
  const finalMismatch = [...new Set([...finalFiles, ...reported.keys()])]
    .filter((file) => finalFiles.has(file) !== reported.has(file)).sort();
  if (finalMismatch.length) failures.push(`coverage-final.json and coverage-summary.json disagree about: ${finalMismatch.join(', ')}`);

  for (const metric of coverageMetrics) {
    const total = metricRecord(summary.total?.[metric]);
    if (!total) {
      failures.push(`Coverage summary total.${metric} is missing or malformed.`);
      continue;
    }
    let covered = 0;
    let count = 0;
    let malformed = false;
    for (const [file, value] of reported) {
      const entry = metricRecord(value?.[metric]);
      if (!entry) {
        failures.push(`Coverage summary ${file}.${metric} is missing or malformed.`);
        malformed = true;
        continue;
      }
      covered += entry.covered;
      count += entry.total;
    }
    if (!malformed && (covered !== total.covered || count !== total.total)) {
      failures.push(`Coverage summary total.${metric} (${total.covered}/${total.total}) does not equal its per-file sum (${covered}/${count}).`);
    }
    const passed = exceedsFloor(total.covered, total.total);
    metrics[metric] = { covered: total.covered, total: total.total, percent: formatPercent(total.covered, total.total), passed };
    if (total.total === 0) {
      failures.push(`Coverage metric ${metric} is empty (0 measurable items); an empty report cannot pass.`);
    } else if (!passed) {
      failures.push(`Coverage metric ${metric} is ${metrics[metric].percent}% (${total.covered}/${total.total}); it must exceed 80% with the configured ${coverageFloorPercent}% floor.`);
    }
  }
  return { failures, metrics };
}

function assertionName(entry) {
  if (typeof entry?.fullName === 'string' && entry.fullName) return entry.fullName;
  const ancestors = Array.isArray(entry?.ancestorTitles) ? entry.ancestorTitles.filter((item) => typeof item === 'string') : [];
  return [...ancestors, typeof entry?.title === 'string' ? entry.title : '(unnamed)'].join(' > ');
}

// Judges the Vitest JSON result: failed, empty, partial or filtered runs fail.
export function evaluateTestResults({ results, tests, root = repositoryRoot }) {
  const failures = [];
  if (results === undefined) {
    return { failures: ['Missing test-results.json; the tests did not produce a result.'], summary: undefined };
  }
  if (typeof results !== 'object' || results === null || !Array.isArray(results.testResults)) {
    return { failures: ['test-results.json is not a Vitest JSON report.'], summary: undefined };
  }
  const count = (name) => (Number.isSafeInteger(results[name]) ? results[name] : undefined);
  const summary = {
    success: results.success === true,
    files: results.testResults.length,
    total: count('numTotalTests'),
    passed: count('numPassedTests'),
    failed: count('numFailedTests'),
    skipped: count('numPendingTests'),
    todo: count('numTodoTests'),
    failedFiles: count('numFailedTestSuites'),
    unrun: []
  };
  if (!summary.success) failures.push('Vitest reported an unsuccessful run.');
  if (!summary.total) failures.push('Vitest executed no tests.');
  if (summary.failed !== 0) failures.push(`Vitest reported ${summary.failed ?? 'an unknown number of'} failed test(s).`);
  if (summary.failedFiles !== 0) failures.push(`Vitest reported ${summary.failedFiles ?? 'an unknown number of'} failed test file(s).`);
  const executed = new Set();
  for (const file of results.testResults) {
    let name;
    try {
      name = reportPath(root, String(file?.name ?? ''));
    } catch {
      failures.push(`Vitest reported a test file outside the repository: ${file?.name}`);
      continue;
    }
    executed.add(name);
    if (file?.status === 'failed') failures.push(`Test file failed: ${name}`);
    for (const assertion of Array.isArray(file?.assertionResults) ? file.assertionResults : []) {
      if (assertion?.status === 'failed') {
        failures.push(`Test failed: ${name} > ${assertionName(assertion)}`);
      } else if (assertion?.status !== 'passed') {
        summary.unrun.push({ file: name, test: assertionName(assertion), status: String(assertion?.status ?? 'unknown') });
      }
    }
  }
  const notExecuted = tests.testFiles.filter((file) => !executed.has(file));
  const unexpected = [...executed].filter((file) => !tests.testFiles.includes(file)).sort();
  if (notExecuted.length) failures.push(`Test files were not executed (filtered, excluded or not collected): ${notExecuted.join(', ')}`);
  if (unexpected.length) failures.push(`Vitest executed test files outside the current test inventory: ${unexpected.join(', ')}`);
  return { failures, summary };
}

function sameInventory(left, right) {
  return left.digest === right.digest && left.fileCount === right.fileCount;
}

function compareInputs(label, before, after) {
  const failures = [];
  if (!sameInventory(before.source, after.source)) failures.push(`${label}: source inventory changed (${before.source.digest} -> ${after.source.digest}); a fresh run is required.`);
  if (!sameInventory(before.tests, after.tests)) failures.push(`${label}: test inventory changed (${before.tests.digest} -> ${after.tests.digest}); a fresh run is required.`);
  if (!sameInventory(before.configuration, after.configuration)) failures.push(`${label}: coverage configuration changed (${before.configuration.digest} -> ${after.configuration.digest}); a fresh run is required.`);
  if (before.revision.commit !== after.revision.commit) failures.push(`${label}: revision changed (${before.revision.commit} -> ${after.revision.commit}); a fresh run is required.`);
  return failures;
}

export function collectInputs(definition, { root = repositoryRoot, revision = repositoryRevision } = {}) {
  return {
    source: sourceInventory(definition, root),
    tests: testInventory(definition, root),
    configuration: configurationInventory(definition, root),
    revision: revision(root)
  };
}

function reportDirectory(definition, root) {
  return path.join(root, ...definition.reportParts);
}

async function readReports(directory) {
  return {
    summary: readJsonFile(path.join(directory, 'coverage-summary.json'), 'coverage-summary.json'),
    final: readJsonFile(path.join(directory, 'coverage-final.json'), 'coverage-final.json'),
    results: readJsonFile(path.join(directory, 'test-results.json'), 'test-results.json')
  };
}

function displayPath(root, file) {
  try {
    return portablePath(root, file);
  } catch {
    return `<outside repository>/${path.basename(file)}`;
  }
}

export function vitestInvocation(definition, directory, maxWorkers, root = repositoryRoot) {
  const base = packageRoot(definition, root);
  const results = path.join(directory, 'test-results.json');
  const entry = vitestEntry(base);
  const args = [
    entry,
    'run',
    '--config', 'vitest.config.ts',
    '--coverage.enabled',
    `--maxWorkers=${maxWorkers}`,
    '--allowOnly=false',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${results}`
  ];
  const portable = [
    displayPath(root, entry),
    ...args.slice(1, -1),
    `--outputFile.json=${displayPath(root, results)}`
  ];
  return { executable: process.execPath, args, cwd: base, portable: ['node', ...portable] };
}

// Targeted diagnostics for contributors: selected tests and sources only, with
// thresholds disabled. The result is never written as qualifying evidence.
export function targetedInvocation(definition, { sources, tests, root = repositoryRoot }) {
  const base = packageRoot(definition, root);
  if (sources.length === 0 || tests.length === 0) {
    fail('Targeted coverage needs at least one --source and one test file after --.');
  }
  const directory = path.join(root, 'coverage', 'targeted', definition.id);
  const include = sources.map((source) => {
    const absolute = path.resolve(root, source);
    const relative = portablePath(root, absolute);
    if (!existsSync(absolute)) fail(`Targeted source does not exist: ${relative}`);
    const local = path.relative(base, absolute).split(path.sep).join('/');
    // Files compiled from outside the package root are matched by absolute path.
    return local.startsWith('../') ? `**/${relative}` : local;
  });
  const args = [
    vitestEntry(base),
    'run',
    ...tests,
    '--config', 'vitest.config.ts',
    '--coverage.enabled',
    ...include.map((pattern) => `--coverage.include=${pattern}`),
    ...coverageMetrics.map((metric) => `--coverage.thresholds.${metric}=0`),
    '--coverage.reporter=text',
    '--coverage.reporter=json-summary',
    `--coverage.reportsDirectory=${directory}`,
    `--maxWorkers=${defaultMaxWorkers}`
  ];
  return { executable: process.execPath, args, cwd: base, directory };
}

function runProcess({ executable, args, cwd }, env, stdio = 'inherit') {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, env, stdio, shell: false });
    child.once('error', (error) => resolve({ exitCode: null, signal: null, error: error.message }));
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal, error: null }));
  });
}

function evidenceFor({ definition, root, inputs, tools, invocation, execution, coverage, tests, failures, startedAt, finishedAt }) {
  const pkg = readJsonFile(path.join(packageRoot(definition, root), 'package.json'), 'package.json') ?? {};
  return {
    schemaVersion: coverageEvidenceSchemaVersion,
    kind: 'liftoff-coverage-evidence',
    qualifying: true,
    result: failures.length === 0 ? 'passed' : 'failed',
    failures,
    package: {
      id: definition.id,
      description: definition.description,
      name: pkg.name ?? null,
      version: pkg.version ?? null,
      root: definition.rootParts.join('/') || '.'
    },
    threshold: {
      configuredFloorPercent: coverageFloorPercent,
      rule: 'Each metric independently: covered * 10000 >= 8001 * total, with total > 0 (strictly greater than 80%).',
      metrics: coverageMetrics
    },
    metrics: coverage.metrics,
    revision: inputs.revision,
    sourceInventory: inputs.source,
    testInventory: { fileCount: inputs.tests.fileCount, digest: inputs.tests.digest, testFiles: inputs.tests.testFiles },
    configuration: inputs.configuration,
    tools,
    invocation: {
      command: invocation.portable,
      cwd: definition.rootParts.join('/') || '.',
      environmentOverrides: { ...coverageTestEnvironment },
      host: { platform: process.platform, arch: process.arch },
      startedAt,
      finishedAt,
      exitCode: execution.exitCode,
      signal: execution.signal
    },
    tests,
    limits: [...coverageLimits],
    separatelyQualified: [...definition.separatelyQualified]
  };
}

function printSummary(evidence) {
  const lines = [`\nCoverage gate (${evidence.package.id}): ${evidence.result.toUpperCase()} at ${evidence.revision?.commit ?? 'unknown revision'}${evidence.revision?.dirty ? ' with uncommitted changes' : ''}`];
  lines.push(`Sources: ${evidence.sourceInventory?.fileCount ?? 0} files ${evidence.sourceInventory?.digest ?? ''}`);
  for (const metric of coverageMetrics) {
    const value = evidence.metrics?.[metric];
    lines.push(value
      ? `  ${metric.padEnd(10)} ${`${value.covered}/${value.total}`.padStart(13)}  ${value.percent.padStart(8)}%  ${value.passed ? 'pass' : 'FAIL'} (> 80%, floor ${coverageFloorPercent}%)`
      : `  ${metric.padEnd(10)} unavailable`);
  }
  if (evidence.tests) {
    lines.push(`Tests: ${evidence.tests.passed ?? '?'} passed, ${evidence.tests.failed ?? '?'} failed, ${evidence.tests.skipped ?? '?'} skipped, ${evidence.tests.todo ?? '?'} todo in ${evidence.tests.files} files; unrun tests are listed in the evidence and are not proof.`);
  }
  for (const failure of evidence.failures) lines.push(`  - ${failure}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function resolveDefinition(target) {
  return typeof target === 'string' ? coveragePackage(target) : target;
}

export async function runCoverageGate(target, {
  root = repositoryRoot, maxWorkers = defaultMaxWorkers, revision = repositoryRevision, quiet = false
} = {}) {
  const definition = resolveDefinition(target);
  const directory = reportDirectory(definition, root);
  const before = collectInputs(definition, { root, revision });
  const { failures: toolFailures, tools } = toolVersions(definition, root);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const invocation = vitestInvocation(definition, directory, maxWorkers, root);
  const startedAt = new Date().toISOString();
  const execution = toolFailures.length
    ? { exitCode: null, signal: null, error: 'Not started: pinned tool verification failed.' }
    : await runProcess(invocation, { ...process.env, ...coverageTestEnvironment }, quiet ? 'ignore' : 'inherit');
  const finishedAt = new Date().toISOString();
  const after = collectInputs(definition, { root, revision });
  const reports = await readReports(directory);
  const coverage = evaluateCoverageReports({ summary: reports.summary, final: reports.final, inventory: after.source, root });
  const tests = evaluateTestResults({ results: reports.results, tests: after.tests, root });
  const failures = [
    ...toolFailures,
    ...(execution.error ? [`Vitest could not run: ${execution.error}`] : []),
    ...(execution.exitCode !== 0 && !execution.error ? [`Vitest exited with ${execution.exitCode ?? execution.signal}; failed tests or unmet thresholds block the gate.`] : []),
    ...compareInputs('Inputs changed during the run', before, after),
    ...tests.failures,
    ...coverage.failures
  ];
  const evidence = evidenceFor({
    definition, root, inputs: after, tools, invocation, execution, coverage, tests: tests.summary, failures, startedAt, finishedAt
  });
  await writeFile(path.join(directory, coverageEvidenceFile), `${JSON.stringify(evidence, null, 2)}\n`);
  if (!quiet) printSummary(evidence);
  return evidence;
}

// A saved verdict is only as good as the recorded qualifying process: it must be
// the unfiltered gate invocation and it must have exited 0 without a signal.
function savedInvocationFailures(definition, directory, root, invocation) {
  const failures = [];
  const complete = invocation && Array.isArray(invocation.command) && invocation.command.length > 0 &&
    invocation.command.every((part) => typeof part === 'string') && typeof invocation.cwd === 'string' &&
    typeof invocation.startedAt === 'string' && typeof invocation.finishedAt === 'string' &&
    !Number.isNaN(Date.parse(invocation.startedAt)) && !Number.isNaN(Date.parse(invocation.finishedAt));
  if (!complete) return ['Saved evidence lacks complete invocation metadata.'];
  if (invocation.exitCode !== 0) failures.push(`Saved evidence records Vitest exit ${JSON.stringify(invocation.exitCode ?? null)}, not 0.`);
  if (invocation.signal !== null) failures.push(`Saved evidence records termination signal ${JSON.stringify(invocation.signal ?? 'missing')}.`);
  const workers = /^--maxWorkers=(\d+)$/.exec(invocation.command.find((part) => part.startsWith('--maxWorkers=')) ?? '')?.[1];
  const count = Number(workers);
  const expected = Number.isSafeInteger(count) && count >= 1 && count <= 64
    ? vitestInvocation(definition, directory, count, root).portable
    : undefined;
  if (!expected || JSON.stringify(invocation.command) !== JSON.stringify(expected)) {
    failures.push('Saved evidence invocation is not the unfiltered source-complete gate command.');
  }
  if (invocation.cwd !== (definition.rootParts.join('/') || '.')) failures.push('Saved evidence ran from another package root.');
  if (JSON.stringify(invocation.environmentOverrides ?? null) !== JSON.stringify(coverageTestEnvironment)) {
    failures.push('Saved evidence did not use the telemetry-free CI test environment.');
  }
  return failures;
}

// Re-judges a saved report against the current checkout; it never trusts the
// saved verdict, and any revision, inventory or configuration drift is stale.
export async function verifyCoverageEvidence(target, { root = repositoryRoot, revision = repositoryRevision } = {}) {
  const definition = resolveDefinition(target);
  const directory = reportDirectory(definition, root);
  const saved = readJsonFile(path.join(directory, coverageEvidenceFile), coverageEvidenceFile);
  const current = collectInputs(definition, { root, revision });
  const reports = await readReports(directory);
  const failures = [];
  if (saved === undefined) {
    failures.push(`Missing ${coverageEvidenceFile}; a fresh coverage run is required.`);
  } else {
    if (saved.schemaVersion !== coverageEvidenceSchemaVersion || saved.kind !== 'liftoff-coverage-evidence' || saved.qualifying !== true) {
      failures.push('Saved evidence is not a qualifying coverage evidence record.');
    }
    if (saved.package?.id !== definition.id) failures.push(`Saved evidence belongs to ${JSON.stringify(saved.package?.id)}, not ${definition.id}.`);
    if (saved.result !== 'passed') failures.push('Saved evidence records a failed gate.');
    if (!Array.isArray(saved.failures) || saved.failures.length !== 0) failures.push('Saved evidence does not record an empty failure list.');
    if (saved.threshold?.configuredFloorPercent !== coverageFloorPercent) {
      failures.push(`Saved evidence floor ${JSON.stringify(saved.threshold?.configuredFloorPercent ?? null)} is not the configured ${coverageFloorPercent}%.`);
    }
    failures.push(...savedInvocationFailures(definition, directory, root, saved.invocation));
    if (!saved.tools?.packages?.['@vitest/coverage-v8']?.installed || !saved.tools?.node) {
      failures.push('Saved evidence lacks the provider and runtime versions.');
    }
    const savedInputs = {
      source: saved.sourceInventory ?? {},
      tests: saved.testInventory ?? {},
      configuration: saved.configuration ?? {},
      revision: saved.revision ?? {}
    };
    failures.push(...compareInputs('Saved report is stale', savedInputs, current));
    if (saved.revision?.dirty !== current.revision.dirty ||
        JSON.stringify(saved.revision?.changedPaths ?? null) !== JSON.stringify(current.revision.changedPaths)) {
      failures.push('Saved report is stale: the uncommitted change set differs; a fresh run is required.');
    }
  }
  const coverage = evaluateCoverageReports({ summary: reports.summary, final: reports.final, inventory: current.source, root });
  const tests = evaluateTestResults({ results: reports.results, tests: current.tests, root });
  failures.push(...tests.failures, ...coverage.failures);
  for (const metric of coverageMetrics) {
    const recorded = saved?.metrics?.[metric];
    const measured = coverage.metrics[metric];
    if (measured && (recorded?.covered !== measured.covered || recorded?.total !== measured.total)) {
      failures.push(`Saved evidence ${metric} counts do not match the saved report.`);
    }
  }
  return { result: failures.length === 0 ? 'passed' : 'failed', failures, metrics: coverage.metrics };
}

function parseArguments(argv) {
  const [operation, id, ...rest] = argv;
  if (!['run', 'verify', 'inventory', 'inspect'].includes(operation) || !id) {
    fail('Usage: node scripts/coverage-gate.mjs <run|verify|inventory> <cli|gateway> [--max-workers <n>]\n' +
      '       node scripts/coverage-gate.mjs inspect <cli|gateway> --source <file>... -- <test file>...');
  }
  let maxWorkers = defaultMaxWorkers;
  const sources = [];
  let tests = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--max-workers' && operation === 'run') {
      const value = Number(rest[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 64) fail('--max-workers must be an integer from 1 to 64.');
      maxWorkers = value;
      index += 1;
    } else if (rest[index] === '--source' && operation === 'inspect' && rest[index + 1]) {
      sources.push(rest[index + 1]);
      index += 1;
    } else if (rest[index] === '--' && operation === 'inspect') {
      tests = rest.slice(index + 1);
      break;
    } else {
      fail(`Unexpected coverage gate argument: ${rest[index]}. Source-complete runs accept no test filters.`);
    }
  }
  return { operation, id, maxWorkers, sources, tests };
}

async function main() {
  const { operation, id, maxWorkers, sources, tests } = parseArguments(process.argv.slice(2));
  const definition = coveragePackage(id);
  if (operation === 'inventory') {
    process.stdout.write(`${JSON.stringify(sourceInventory(definition), null, 2)}\n`);
    return;
  }
  if (operation === 'inspect') {
    const invocation = targetedInvocation(definition, { sources, tests });
    await rm(invocation.directory, { recursive: true, force: true });
    process.stdout.write('Targeted coverage is diagnostic only: it is not qualifying evidence and does not replace the source-complete gate.\n');
    const execution = await runProcess(invocation, { ...process.env, ...coverageTestEnvironment });
    process.stdout.write(`Targeted report: ${portablePath(repositoryRoot, invocation.directory)} (not qualifying)\n`);
    if (execution.exitCode !== 0) process.exitCode = 1;
    return;
  }
  if (operation === 'verify') {
    const verdict = await verifyCoverageEvidence(id);
    for (const failure of verdict.failures) process.stdout.write(`  - ${failure}\n`);
    process.stdout.write(`Saved coverage evidence (${id}): ${verdict.result.toUpperCase()}\n`);
    if (verdict.result !== 'passed') process.exitCode = 1;
    return;
  }
  const evidence = await runCoverageGate(id, { maxWorkers });
  if (evidence.result !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Coverage gate failed: ${error.message}`);
    process.exitCode = 1;
  });
}
