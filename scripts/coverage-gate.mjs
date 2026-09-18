import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readJsonFile } from './release-evidence.mjs';

export const REQUIRED_METRICS = ['lines', 'branches', 'functions', 'statements'];
export const THRESHOLD_PERCENT = 80n;
export const THRESHOLD_MULTIPLIER = 100n;

export const WINDOWS_JOB_CONTROLLER_DIGEST = 'a7aa404d84d1e0a9188b8c9d487533cacee830b4d58172ef959d159895c2d909';

export const NATIVE_HELPER_INVENTORY = [
  {
    id: 'windows-job-controller',
    path: 'assets/repair/windows-job-controller.ps1',
    description: 'Win32 Job Object process-tree execution supervisor on Windows',
    measurement: 'native-powershell-process-controller',
    v8Measured: false,
    requiredPlatform: 'win32',
    expectedDigest: WINDOWS_JOB_CONTROLLER_DIGEST
  },
  {
    id: 'windows-launcher',
    path: 'scripts/distribution/windows-launcher.go',
    finalBinary: 'bin/liftoff.exe',
    description: 'Win32 Go PE native launcher executable (x64 and arm64)',
    measurement: 'native-go-pe-binary',
    v8Measured: false,
    requiredPlatform: 'win32'
  },
  {
    id: 'posix-launcher',
    path: 'bin/liftoff',
    description: 'Relocatable POSIX shell launcher for macOS and Linux',
    measurement: 'native-shell-launcher',
    v8Measured: false,
    requiredPlatform: 'posix'
  }
];

export const CONTRIBUTOR_TOOLING_JUSTIFICATION = {
  'scripts/clean-build.mjs': 'Build artifact cleanup before compilation (contributor/CI tooling)',
  'scripts/audit-template-dependencies.mjs': 'Canonical registry vulnerability audit runner (contributor/CI tooling)',
  'scripts/template-dependency-security.mjs': 'Policy and exception validator for template dependencies (contributor/CI tooling)',
  'scripts/supported-stack-freshness.mjs': 'Upstream runtime/package freshness inspection (contributor tooling)',
  'scripts/refresh-supported-stack-baseline.mjs': 'Supported stack baseline and lockfile synchronizer (contributor tooling)',
  'scripts/check-supported-stack-freshness.mjs': 'Advisory freshness policy verification (contributor/CI tooling)',
  'scripts/canonicalize-uv-lock.mjs': 'Deterministic Python uv.lock formatting normalizer (contributor tooling)',
  'scripts/verify-standard-node-templates.mjs': 'Generated Node template build/test verifier (contributor/CI tooling)',
  'scripts/verify-generated-containers.mjs': 'Container smoke and build verifier (contributor/CI tooling)',
  'scripts/verify-release-identity.mjs': 'Release commit/tag/package identity verifier (release tooling)',
  'scripts/verify-published-package.mjs': 'Historical npm package compatibility verifier (release tooling)',
  'scripts/capture-activation-v3-baseline.mjs': 'Developer fixture extraction for activation v3 reader (contributor tooling)',
  'scripts/generate-catalogs.mjs': 'Packaged template and profile resource digest generator (contributor tooling)',
  'scripts/qualify-docs-routing.mjs': 'API documentation routing qualification verifier (contributor tooling)',
  'scripts/coverage-gate.mjs': 'Strict coverage qualification gate (qualification tooling)',
  'scripts/release-gate.mjs': 'Coordinated publication release gate (qualification tooling)',
  'scripts/release-evidence.mjs': 'Release evidence validation and integrity engine (qualification tooling)',
  'scripts/release-evidence-github.mjs': 'GitHub release artifact and provenance verifier (qualification tooling)',
  'scripts/release-native-host.mjs': 'Authenticated native and minimum-host execution evidence admission (qualification tooling, not shipped runtime)',
  'scripts/collect-release-evidence.mjs': 'Pipeline release evidence collection runner (qualification tooling)',
  'scripts/produce-release-evidence.mjs': 'Authenticated explicit-dispatch approval signing inputs and read-only validated qualification aggregator (qualification tooling)',
  'scripts/release-qualification.mjs': 'Explicit canonical tuple/effect/plan and actual CI execution binding harness (qualification tooling)',
  'scripts/release-telemetry-gateway.mjs': 'Deployed gateway image/revision/provenance and candidate/historical contract compatibility verification (qualification tooling, not shipped runtime)',
  'scripts/release-evidence-archive.py': 'Bounded read-only ZIP/TAR archive inspection audit (qualification tooling)',
  'tests/helpers/api-routing.mjs': 'Shared OpenAPI schema and routing validation helper imported by scripts/qualify-docs-routing.mjs (qualification tooling helper)'
};

export function getWindowsJobControllerDigest(projectRoot = process.cwd()) {
  const controllerPath = path.join(projectRoot, 'assets', 'repair', 'windows-job-controller.ps1');
  if (!fs.existsSync(controllerPath)) {
    throw new Error(`Missing native Windows controller helper: ${controllerPath} does not exist.`);
  }
  try {
    const bytes = fs.readFileSync(controllerPath);
    return createHash('sha256').update(bytes).digest('hex');
  } catch (err) {
    throw new Error(`Unreadable native Windows controller helper at ${controllerPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function isSafeNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function canonicalizeRepoPath(filePath, projectRoot = process.cwd()) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('Invalid path: must be a non-empty string.');
  }
  if (filePath.includes('\0')) {
    throw new Error('Illegal null character in path.');
  }
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
  const relative = path.relative(projectRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes project root: ${filePath}`);
  }
  return relative.split(path.sep).join('/');
}

/**
 * Strict raw-count acceptance: covered * 100 > total * 80
 * Uses BigInt for exact large safe integer arithmetic.
 * Rejects zero-denominator, negative, non-integer, NaN, or covered > total.
 */
export function checkStrictThreshold(covered, total) {
  if (!isSafeNonNegativeInteger(covered)) {
    return {
      passed: false,
      error: `Invalid covered count (${typeof covered}). Must be a non-negative safe integer.`
    };
  }
  if (!isSafeNonNegativeInteger(total)) {
    return {
      passed: false,
      error: `Invalid total count (${typeof total}). Must be a non-negative safe integer.`
    };
  }
  if (total === 0) {
    return {
      passed: false,
      error: 'Zero denominator: total metric count cannot be zero.'
    };
  }
  if (covered > total) {
    return {
      passed: false,
      error: `Invalid metric counts: covered (${covered}) exceeds total (${total}).`
    };
  }

  const coveredBig = BigInt(covered);
  const totalBig = BigInt(total);
  const lhs = coveredBig * THRESHOLD_MULTIPLIER;
  const rhs = totalBig * THRESHOLD_PERCENT;
  const passed = lhs > rhs;

  const minRequiredBig = (totalBig * THRESHOLD_PERCENT) / THRESHOLD_MULTIPLIER + 1n;
  const deficitBig = minRequiredBig > coveredBig ? minRequiredBig - coveredBig : 0n;

  const rawRatio = Number(covered) / Number(total);
  const displayPct = (rawRatio * 100).toFixed(2);

  return {
    passed,
    covered,
    total,
    lhs: lhs.toString(),
    rhs: rhs.toString(),
    minRequired: minRequiredBig.toString(),
    deficit: deficitBig.toString(),
    rawRatio,
    displayPct,
    error: passed ? undefined : `Strict threshold failed: ${covered} * 100 (${lhs}) is not > ${total} * 80 (${rhs}). Exact ratio: ${(rawRatio * 100).toFixed(4)}%. Raw deficit: ${deficitBig.toString()} to strict >80%.`
  };
}

export function discoverProductionSourceFiles(
  directory,
  projectRoot = process.cwd(),
  extensionRegex = /\.(ts|js|tsx|jsx|mts|mjs|cts|cjs)$/
) {
  const results = [];
  const root = fs.lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(`Production source root is not an ordinary directory: ${directory}`);

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Linked production source cannot be omitted from measurement: ${fullPath}`);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git' || entry.name === 'coverage') {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        if (extensionRegex.test(entry.name) && !entry.name.endsWith('.d.ts')) {
          results.push(canonicalizeRepoPath(fullPath, projectRoot));
        }
      }
    }
  }

  walk(directory);
  return results.sort();
}

/**
 * Evaluates coverage for a single package.
 * CLI and telemetry MUST be evaluated separately.
 * Validates:
 * 1. Summary total metrics strictly exceed 80% (covered * 100 > total * 80).
 * 2. Exact inventory matching (no suffix matching or fuzzy aliases).
 * 3. Every individual file record must be non-empty with valid counts.
 * 4. Total consistency: sum of file metrics MUST exactly match summary total (rejects fabricated totals).
 * 5. Rejects empty inventories or missing source roots.
 */
export function evaluatePackageCoverage(options) {
  const {
    packageId,
    packageName,
    coverageSummary,
    sourceDirectory,
    sourceDirectories,
    projectRoot = process.cwd(),
    expectedFiles
  } = options;

  const issues = [];
  const metrics = {};

  if (!coverageSummary || typeof coverageSummary !== 'object') {
    return {
      ok: false,
      packageId,
      packageName,
      metrics: {},
      inventory: { total: 0, missing: [], present: 0 },
      issues: [`${packageName}: Missing or invalid coverage summary report.`]
    };
  }

  const totalSummary = coverageSummary.total;
  if (!totalSummary || typeof totalSummary !== 'object') {
    return {
      ok: false,
      packageId,
      packageName,
      metrics: {},
      inventory: { total: 0, missing: [], present: 0 },
      issues: [`${packageName}: Coverage summary lacks 'total' aggregation section.`]
    };
  }

  // 1. Evaluate total metrics
  let allMetricsPassed = true;
  for (const metricName of REQUIRED_METRICS) {
    const metricData = totalSummary[metricName];
    if (!metricData || typeof metricData !== 'object') {
      issues.push(`${packageName}: Missing required metric '${metricName}'.`);
      allMetricsPassed = false;
      continue;
    }

    const { covered, total } = metricData;
    const check = checkStrictThreshold(covered, total);
    metrics[metricName] = check;
    if (!check.passed) {
      allMetricsPassed = false;
      issues.push(`${packageName} [${metricName}]: ${check.error}`);
    }
  }

  // 2. Discover expected inventory
  const dirs = sourceDirectories ?? (sourceDirectory ? [sourceDirectory] : []);
  if (dirs.length === 0 && !expectedFiles) {
    issues.push(`${packageName}: No source directories declared. Missing required source root.`);
    allMetricsPassed = false;
  }
  const availableDirectories = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      issues.push(`${packageName}: Missing required source directory: ${d}`);
      allMetricsPassed = false;
    } else availableDirectories.push(d);
  }

  let resolvedExpectedFiles = expectedFiles;
  if (!resolvedExpectedFiles) {
    resolvedExpectedFiles = availableDirectories.flatMap((directory) => {
      try {
        return discoverProductionSourceFiles(directory, projectRoot);
      } catch (error) {
        issues.push(`${packageName}: Required source inventory could not be observed: ${error instanceof Error ? error.message : String(error)}`);
        allMetricsPassed = false;
        return [];
      }
    });
  } else {
    resolvedExpectedFiles = resolvedExpectedFiles.map((f) => canonicalizeRepoPath(f, projectRoot));
  }

  // Detect duplicates in expected inventory
  const expectedSet = new Set();
  for (const f of resolvedExpectedFiles) {
    if (expectedSet.has(f)) {
      issues.push(`${packageName}: Duplicate file in expected inventory: ${f}`);
      allMetricsPassed = false;
    }
    expectedSet.add(f);
  }

  if (resolvedExpectedFiles.length === 0) {
    issues.push(`${packageName}: Empty production coverage inventory. Package must contain production source files.`);
    allMetricsPassed = false;
  }

  // 3. Validate individual file entries and total consistency
  const reportKeys = Object.keys(coverageSummary).filter((k) => k !== 'total');
  const normalizedReportMap = new Map();

  const metricSums = {
    lines: { total: 0, covered: 0 },
    branches: { total: 0, covered: 0 },
    functions: { total: 0, covered: 0 },
    statements: { total: 0, covered: 0 }
  };

  for (const key of reportKeys) {
    if (key.trim() === '') {
      issues.push(`${packageName}: Empty file key in coverage report.`);
      allMetricsPassed = false;
      continue;
    }

    let canonicalKey;
    try {
      canonicalKey = canonicalizeRepoPath(key, projectRoot);
    } catch (err) {
      issues.push(`${packageName}: Invalid report path '${key}': ${err instanceof Error ? err.message : String(err)}`);
      allMetricsPassed = false;
      continue;
    }

    const fileRecord = coverageSummary[key];
    if (!fileRecord || typeof fileRecord !== 'object' || Object.keys(fileRecord).length === 0) {
      issues.push(`${packageName}: Empty or invalid file record for '${canonicalKey}'.`);
      allMetricsPassed = false;
      continue;
    }

    // Validate metrics on this file record
    let fileValid = true;
    for (const metric of REQUIRED_METRICS) {
      const data = fileRecord[metric];
      if (!data || typeof data !== 'object') {
        issues.push(`${packageName}: File record '${canonicalKey}' missing metric '${metric}'.`);
        fileValid = false;
        allMetricsPassed = false;
        continue;
      }
      if (!isSafeNonNegativeInteger(data.total) || !isSafeNonNegativeInteger(data.covered)) {
        issues.push(`${packageName}: File record '${canonicalKey}' has non-integer count for '${metric}'.`);
        fileValid = false;
        allMetricsPassed = false;
        continue;
      }
      if (data.covered > data.total) {
        issues.push(`${packageName}: File record '${canonicalKey}' covered exceeds total for '${metric}'.`);
        fileValid = false;
        allMetricsPassed = false;
        continue;
      }

      metricSums[metric].total += data.total;
      metricSums[metric].covered += data.covered;
    }

    if (fileValid) {
      normalizedReportMap.set(canonicalKey, fileRecord);
    }
  }

  // 4. Verify Total Consistency (Reject fabricated totals with mismatched sums)
  if (reportKeys.length > 0 && totalSummary) {
    for (const metric of REQUIRED_METRICS) {
      const expectedTotal = totalSummary[metric]?.total;
      const expectedCovered = totalSummary[metric]?.covered;
      if (typeof expectedTotal === 'number' && metricSums[metric].total !== expectedTotal) {
        issues.push(
          `${packageName}: Total summary inconsistency for '${metric}'. File records sum to total ${metricSums[metric].total}, but total summary claims ${expectedTotal}. Fabricated totals rejected.`
        );
        allMetricsPassed = false;
      }
      if (typeof expectedCovered === 'number' && metricSums[metric].covered !== expectedCovered) {
        issues.push(
          `${packageName}: Total summary inconsistency for '${metric}'. File records sum to covered ${metricSums[metric].covered}, but total summary claims ${expectedCovered}. Fabricated totals rejected.`
        );
        allMetricsPassed = false;
      }
    }
  }

  // 5. Exact inventory matching (No fuzzy suffix matching!)
  const missingFiles = [];
  for (const expected of resolvedExpectedFiles) {
    if (!normalizedReportMap.has(expected)) {
      missingFiles.push(expected);
    }
  }

  if (missingFiles.length > 0) {
    allMetricsPassed = false;
    issues.push(
      `${packageName}: Coverage inventory omitted ${missingFiles.length} production file(s): ${missingFiles.slice(0, 5).join(', ')}${missingFiles.length > 5 ? '...' : ''}`
    );
  }

  return {
    ok: allMetricsPassed && issues.length === 0,
    packageId,
    packageName,
    metrics,
    inventory: {
      total: resolvedExpectedFiles.length,
      present: resolvedExpectedFiles.length - missingFiles.length,
      missing: missingFiles
    },
    issues
  };
}

/**
 * Evaluates native helper qualification separately from V8.
 * Requires:
 * 1. Exact helper ID and path.
 * 2. Matching helper byte digest (rejects tampered or mismatched helper).
 * 3. Verified execution run ID on actual native OS runner.
 * 4. Process-tree settlement proof (activeProcesses === 0 and processTreeSettled === true).
 * 5. Rejects portable fixtures from non-target operating systems.
 */
export function evaluateNativeHelperQualification(helpers, qualificationEvidence = {}, projectRoot = process.cwd()) {
  const results = [];
  const issues = [];
  let allQualified = true;
  if (!Array.isArray(helpers) || helpers.length === 0) {
    return { ok: false, helpers: [], issues: ['The native helper inventory is missing; empty scope is not qualification.'] };
  }
  if (!qualificationEvidence || typeof qualificationEvidence !== 'object' || Array.isArray(qualificationEvidence)) {
    return {
      ok: false,
      helpers: helpers.map((helper) => ({
        ...helper, qualified: false, evidenceType: 'invalid-evidence', details: 'Native evidence assertions must be an object.'
      })),
      issues: ['Native evidence assertions must be an object.']
    };
  }

  for (const helper of helpers) {
    const evidence = qualificationEvidence[helper.id];
    const helperResult = {
      ...helper,
      qualified: false,
      evidenceType: 'none',
      details: ''
    };

    if (!evidence) {
      helperResult.details = `No qualification evidence recorded for native helper '${helper.id}' (${helper.path}).`;
      issues.push(helperResult.details);
      allQualified = false;
      results.push(helperResult);
      continue;
    }

    // Verify boolean flags strictly (no strings like "false" or "true")
    if (typeof evidence.passed !== 'boolean' || typeof evidence.processTreeSettled !== 'boolean') {
      helperResult.evidenceType = 'invalid-evidence';
      helperResult.details = `Helper '${helper.id}' evidence must contain strict booleans for 'passed' and 'processTreeSettled'.`;
      issues.push(helperResult.details);
      allQualified = false;
      results.push(helperResult);
      continue;
    }

    if (evidence.isFixtureOnly === true || evidence.mocked === true) {
      helperResult.evidenceType = 'fixture-based';
      helperResult.details = `Helper '${helper.id}' has fixture-based/mocked evidence, which cannot satisfy required native qualification.`;
      issues.push(helperResult.details);
      allQualified = false;
      results.push(helperResult);
      continue;
    }

    if (evidence.platform !== helper.requiredPlatform) {
      helperResult.evidenceType = 'wrong-platform';
      helperResult.details = `Helper '${helper.id}' report does not match its required native '${helper.requiredPlatform}' platform.`;
      issues.push(helperResult.details);
      allQualified = false;
      results.push(helperResult);
      continue;
    }

    // Byte digest verification
    const expectedDigest = helper.id === 'windows-job-controller'
      ? getWindowsJobControllerDigest(projectRoot)
      : helper.expectedDigest;

    if (expectedDigest) {
      if (evidence.helperDigest !== expectedDigest) {
        helperResult.evidenceType = 'mismatched-digest';
        helperResult.details = `Helper '${helper.id}' reported source digest does not match expected digest '${expectedDigest}'.`;
        issues.push(helperResult.details);
        allQualified = false;
        results.push(helperResult);
        continue;
      }
    }

    // A run label is not authenticated execution evidence.
    if (!evidence.nativeRunId || typeof evidence.nativeRunId !== 'string' || evidence.nativeRunId.trim() === '') {
      helperResult.evidenceType = 'missing-run-id';
      helperResult.details = `Helper '${helper.id}' report is missing its native execution run reference.`;
      issues.push(helperResult.details);
      allQualified = false;
      results.push(helperResult);
      continue;
    }

    // Kernel accounting / process settlement proof
    if (evidence.processTreeSettled !== true || evidence.activeProcesses !== 0 || evidence.passed !== true) {
      helperResult.evidenceType = 'failed-settlement';
      helperResult.details = `Helper '${helper.id}' reports failed or uncertain process settlement; successful native outcome, verified settlement and zero active processes are all required.`;
      issues.push(helperResult.details);
      allQualified = false;
      results.push(helperResult);
      continue;
    }

    allQualified = false;
    helperResult.evidenceType = 'unverified-native-report';
    helperResult.details = `Helper '${helper.id}' has an unauthenticated report. Run labels, source digests and success/settlement flags do not prove final installed-byte or native-host qualification; the separate release gate must verify their provenance and complete target cases.`;
    issues.push(helperResult.details);
    results.push(helperResult);
  }

  return {
    ok: allQualified,
    helpers: results,
    issues
  };
}

export function getCanonicalProductionInventory(projectRoot = process.cwd()) {
  for (const relative of ['scripts/capture-activation-v3-baseline.mjs', 'src/telemetry/contract.ts']) {
    const file = fs.lstatSync(path.join(projectRoot, relative));
    if (!file.isFile() || file.isSymbolicLink()) throw new Error(`Required production source is not an ordinary file: ${relative}`);
  }
  const cliFiles = [
    ...discoverProductionSourceFiles(path.join(projectRoot, 'src'), projectRoot),
    ...discoverProductionSourceFiles(path.join(projectRoot, 'assets', 'governance', 'single-maintainer-gitflow', 'activation-v3-reader'), projectRoot),
    ...discoverProductionSourceFiles(path.join(projectRoot, 'assets', 'governance', 'single-maintainer-gitflow', 'activation-v4-policy7-reader'), projectRoot),
    ...discoverProductionSourceFiles(path.join(projectRoot, 'scripts', 'distribution'), projectRoot),
    canonicalizeRepoPath('scripts/capture-activation-v3-baseline.mjs', projectRoot)
  ];

  const telemetryFiles = [
    ...discoverProductionSourceFiles(path.join(projectRoot, 'services', 'telemetry-ingest', 'src'), projectRoot),
    canonicalizeRepoPath('src/telemetry/contract.ts', projectRoot)
  ];

  return {
    cli: [...new Set(cliFiles)].sort(),
    telemetry: [...new Set(telemetryFiles)].sort()
  };
}

/**
 * Pure raw-package coverage evaluation using canonical source inventories.
 * Rejects if summaries are omitted (NO fallback to disk).
 * Rejects caller overrides of expectedFiles/sourceDirectories.
 * Returns separate CLI and telemetry evaluations.
 */
export function evaluateCoverageMeasurements(options = {}) {
  const issues = [];
  const failed = (problems) => {
    const packageFailure = (packageId, packageName) => ({
      ...evaluatePackageCoverage({ packageId, packageName, coverageSummary: null }),
      issues: [...problems]
    });
    return {
      ok: false,
      cli: packageFailure('cli', '@msn-control/liftoff'),
      telemetry: packageFailure('telemetry', '@msn-control/liftoff-telemetry-ingest'),
      inventory: { cli: [], telemetry: [] },
      issues: problems
    };
  };
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return failed(['Coverage measurement options must be an object.']);
  }
  const projectRoot = options.projectRoot ?? process.cwd();
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    return failed(['Coverage projectRoot must be an explicit nonempty directory path.']);
  }

  const forbiddenOverrideKeys = [
    'expectedFiles',
    'cliExpectedFiles',
    'telemetryExpectedFiles',
    'sourceDirectory',
    'sourceDirectories',
    'cliSourceDir',
    'cliSourceDirs',
    'telemetrySourceDir'
  ];

  for (const key of forbiddenOverrideKeys) {
    if (key in options && options[key] !== undefined) {
      issues.push(`evaluateCoverageMeasurements rejects caller override key '${key}'. Canonical source inventories are mandatory.`);
    }
  }
  for (const key of Object.keys(options)) {
    if (!['projectRoot', 'cliSummary', 'telemetrySummary', ...forbiddenOverrideKeys].includes(key)) {
      issues.push(`Unsupported coverage measurement option '${key}'.`);
    }
  }

  if (!options.cliSummary || typeof options.cliSummary !== 'object' || Array.isArray(options.cliSummary)) {
    issues.push('Missing required raw cliSummary report.');
  }
  if (!options.telemetrySummary || typeof options.telemetrySummary !== 'object' || Array.isArray(options.telemetrySummary)) {
    issues.push('Missing required raw telemetrySummary report.');
  }

  if (issues.length > 0) {
    return failed(issues);
  }

  let inventory;
  try {
    inventory = getCanonicalProductionInventory(projectRoot);
  } catch (error) {
    return failed([`Canonical production inventory is unavailable: ${error instanceof Error ? error.message : String(error)}`]);
  }

  const cliResult = evaluatePackageCoverage({
    packageId: 'cli',
    packageName: '@msn-control/liftoff',
    coverageSummary: options.cliSummary,
    projectRoot,
    expectedFiles: inventory.cli
  });

  const telemetryResult = evaluatePackageCoverage({
    packageId: 'telemetry',
    packageName: '@msn-control/liftoff-telemetry-ingest',
    coverageSummary: options.telemetrySummary,
    projectRoot,
    expectedFiles: inventory.telemetry
  });

  const allIssues = [
    ...cliResult.issues,
    ...telemetryResult.issues
  ];

  return {
    ok: cliResult.ok && telemetryResult.ok,
    cli: cliResult,
    telemetry: telemetryResult,
    inventory,
    issues: allIssues
  };
}

/**
 * Pure V8 measurement gate. Native assertions are disclosed, never authenticated here.
 */
export function evaluateCoverageGate(options = {}) {
  const validOptions = options !== null && typeof options === 'object' && !Array.isArray(options);
  const { nativeHelperEvidence, ...measurementOptions } = validOptions ? options : {};
  const measurement = evaluateCoverageMeasurements(validOptions ? measurementOptions : options);
  const projectRoot = typeof measurementOptions.projectRoot === 'string' && measurementOptions.projectRoot.trim() !== ''
    ? measurementOptions.projectRoot : process.cwd();
  const helperResult = evaluateNativeHelperQualification(
    NATIVE_HELPER_INVENTORY,
    nativeHelperEvidence ?? {},
    projectRoot
  );
  return {
    schemaVersion: 1,
    scope: 'typescript-javascript-coverage',
    ...measurement,
    completeReleaseQualification: false,
    thresholdFormula: 'covered * 100 > total * 80 (strict raw integer inequality)',
    nativeHelpers: helperResult,
    contributorToolingJustification: CONTRIBUTOR_TOOLING_JUSTIFICATION,
    qualificationBlockers: helperResult.issues
  };
}

export function evaluateCoverageReportsOnDisk(projectRoot = process.cwd()) {
  const inputIssues = [];
  const read = (relative, label) => {
    try {
      return readJsonFile(projectRoot, relative).value;
    } catch (error) {
      inputIssues.push(`${label} coverage report cannot be admitted: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
  const result = evaluateCoverageGate({
    projectRoot,
    cliSummary: read('coverage/coverage-summary.json', 'CLI'),
    telemetrySummary: read('services/telemetry-ingest/coverage/coverage-summary.json', 'Telemetry')
  });
  return { ...result, ok: result.ok && inputIssues.length === 0, issues: [...inputIssues, ...result.issues] };
}

export function formatCoverageGateReport(result) {
  const lines = [];
  lines.push('================================================================================');
  lines.push('                    LIFTOFF V8 COVERAGE MEASUREMENT GATE                       ');
  lines.push('================================================================================');
  lines.push(`Status: ${result.ok ? 'PASS' : 'FAIL'} (TypeScript/JavaScript measurements only)`);
  lines.push(`Threshold Rule: ${result.thresholdFormula}`);
  lines.push('');

  const renderPackage = (pkg) => {
    lines.push(`--- Package: ${pkg.packageName} (${pkg.packageId}) ---`);
    lines.push(`Status: ${pkg.ok ? 'PASS' : 'FAIL'}`);
    lines.push(`Production Inventory: ${pkg.inventory.present}/${pkg.inventory.total} files measured`);
    if (pkg.inventory.missing.length > 0) {
      lines.push(`  OMITTED FILES: ${pkg.inventory.missing.join(', ')}`);
    }
    lines.push('Metrics:');
    for (const metric of REQUIRED_METRICS) {
      const m = pkg.metrics[metric];
      if (!m) {
        lines.push(`  ${metric.padEnd(12)}: MISSING`);
      } else if (m.passed) {
        lines.push(`  ${metric.padEnd(12)}: PASS | covered: ${m.covered}/${m.total} (${m.displayPct}%) | ${m.lhs} > ${m.rhs}`);
      } else {
        lines.push(`  ${metric.padEnd(12)}: FAIL | covered: ${m.covered}/${m.total} (${m.displayPct}%) | ${m.error}`);
      }
    }
    lines.push('');
  };

  renderPackage(result.cli);
  renderPackage(result.telemetry);

  lines.push('--- Native Helper Inventory: Separate Qualification Required ---');
  for (const h of result.nativeHelpers.helpers) {
    lines.push(`  Helper: ${h.id} (${h.path})`);
    lines.push(`  Measurement: ${h.measurement} [V8-measured: ${h.v8Measured}]`);
    lines.push(`  Platform: ${h.requiredPlatform} floor | Qualified: ${h.qualified ? 'YES' : 'NO'} (${h.evidenceType})`);
    lines.push(`  Details: ${h.details}`);
  }
  lines.push('');
  lines.push('This measurement gate does not qualify a release. The release gate separately authenticates native artifacts, host runs, helper behavior and all other required evidence.');
  lines.push('');

  if (result.issues.length > 0) {
    lines.push('--- Gate Blocker Details ---');
    for (const issue of result.issues) {
      lines.push(`  [BLOCKER] ${issue}`);
    }
    lines.push('');
  }

  lines.push('================================================================================');
  return lines.join('\n');
}

// CLI entrypoint
const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectExecution) {
  const result = evaluateCoverageReportsOnDisk();
  process.stdout.write(formatCoverageGateReport(result) + '\n');
  if (!result.ok) {
    process.exitCode = 1;
  }
}
