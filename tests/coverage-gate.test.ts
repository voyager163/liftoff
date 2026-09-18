import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { windowsJobControllerAssetDigest } from '../src/adapters/process/windows-job-runner.js';
import { nativeStatePythonVersionProbe } from '../src/adapters/state/native-system.js';
import { nativeHelpersForPlatform } from '../scripts/native-helper-inventory.mjs';
import {
  canonicalizeRepoPath,
  checkStrictThreshold,
  evaluatePackageCoverage,
  evaluateNativeHelperQualification,
  evaluateCoverageGate,
  evaluateCoverageReportsOnDisk,
  evaluateCoverageMeasurements,
  getCanonicalProductionInventory,
  getWindowsJobControllerDigest,
  formatCoverageGateReport,
  isSafeNonNegativeInteger,
  NATIVE_HELPER_INVENTORY,
  REQUIRED_METRICS,
  WINDOWS_JOB_CONTROLLER_DIGEST,
  CONTRIBUTOR_TOOLING_JUSTIFICATION
} from '../scripts/coverage-gate.mjs';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function repositoryFixture() {
  const root = fs.mkdtempSync(path.resolve('tests', '.coverage-gate-'));
  roots.push(root);
  for (const file of [
    'src/file1.ts', 'src/file2.ts', 'src/telemetry/contract.ts',
    'services/telemetry-ingest/src/handler.ts',
    'assets/governance/single-maintainer-gitflow/activation-v3-reader/identity.js',
    'assets/governance/single-maintainer-gitflow/activation-v4-policy7-reader/identity.js',
    'scripts/distribution/assembler.mjs', 'scripts/capture-activation-v3-baseline.mjs'
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'export {};\n');
  }
  fs.mkdirSync(path.join(root, 'assets', 'repair'));
  fs.copyFileSync(path.resolve('assets/repair/windows-job-controller.ps1'),
    path.join(root, 'assets', 'repair', 'windows-job-controller.ps1'));
  return { root, inventory: getCanonicalProductionInventory(root) };
}

function completeSummary(files: readonly string[], overrides: Partial<Record<string, number>> = {}) {
  const fileMetrics = () => Object.fromEntries(REQUIRED_METRICS.map((metric) =>
    [metric, { total: 100, covered: overrides[metric] ?? 85 }]));
  return {
    total: Object.fromEntries(REQUIRED_METRICS.map((metric) =>
      [metric, { total: files.length * 100, covered: files.length * (overrides[metric] ?? 85) }])),
    ...Object.fromEntries(files.map((file) => [file, fileMetrics()]))
  };
}

function writeSummary(root: string, relative: string, value: unknown) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

function validSummary(linesCovered = 85, branchesCovered = 85, funcsCovered = 85, stmtsCovered = 85) {
  const file1Lines = Math.floor(linesCovered / 2);
  const file2Lines = linesCovered - file1Lines;

  const file1Branches = Math.floor(branchesCovered / 2);
  const file2Branches = branchesCovered - file1Branches;

  const file1Funcs = Math.floor(funcsCovered / 2);
  const file2Funcs = funcsCovered - file1Funcs;

  const file1Stmts = Math.floor(stmtsCovered / 2);
  const file2Stmts = stmtsCovered - file1Stmts;

  return {
    total: {
      lines: { total: 100, covered: linesCovered },
      branches: { total: 100, covered: branchesCovered },
      functions: { total: 100, covered: funcsCovered },
      statements: { total: 100, covered: stmtsCovered }
    },
    'src/file1.ts': {
      lines: { total: 50, covered: file1Lines },
      branches: { total: 50, covered: file1Branches },
      functions: { total: 50, covered: file1Funcs },
      statements: { total: 50, covered: file1Stmts }
    },
    'src/file2.ts': {
      lines: { total: 50, covered: file2Lines },
      branches: { total: 50, covered: file2Branches },
      functions: { total: 50, covered: file2Funcs },
      statements: { total: 50, covered: file2Stmts }
    }
  };
}

function assertedHelperEvidence(controllerDigest = getWindowsJobControllerDigest()) {
  return {
    'windows-job-controller': {
      platform: 'win32',
      helperDigest: controllerDigest,
      nativeRunId: 'run-win-001',
      runnerHost: 'windows-2022-runner',
      passed: true,
      processTreeSettled: true,
      activeProcesses: 0,
      isFixtureOnly: false
    },
    'windows-launcher': {
      platform: 'win32',
      nativeRunId: 'run-win-pe-001',
      runnerHost: 'windows-2022-runner',
      passed: true,
      processTreeSettled: true,
      activeProcesses: 0,
      isFixtureOnly: false
    },
    'posix-launcher': {
      platform: 'posix',
      nativeRunId: 'run-posix-001',
      runnerHost: 'ubuntu-22.04-runner',
      passed: true,
      processTreeSettled: true,
      activeProcesses: 0,
      isFixtureOnly: false
    }
  };
}

describe('coverage gate - strict integer arithmetic and edge cases', () => {
  it('validates safe non-negative integer checker', () => {
    expect(isSafeNonNegativeInteger(0)).toBe(true);
    expect(isSafeNonNegativeInteger(100)).toBe(true);
    expect(isSafeNonNegativeInteger(Number.MAX_SAFE_INTEGER)).toBe(true);

    expect(isSafeNonNegativeInteger(-1)).toBe(false);
    expect(isSafeNonNegativeInteger(1.5)).toBe(false);
    expect(isSafeNonNegativeInteger(NaN)).toBe(false);
    expect(isSafeNonNegativeInteger(Infinity)).toBe(false);
    expect(isSafeNonNegativeInteger('100')).toBe(false);
    expect(isSafeNonNegativeInteger(null)).toBe(false);
    expect(isSafeNonNegativeInteger(undefined)).toBe(false);
  });

  it('enforces gate equality: exactly 80.00% FAILS strict inequality', () => {
    // 80 covered out of 100: 80 * 100 = 8000, 100 * 80 = 8000. 8000 is not > 8000!
    const result = checkStrictThreshold(80, 100);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('is not >');
    expect(result.displayPct).toBe('80.00');
  });

  it('accepts >80.00% when display rounds to 80.00%', () => {
    // 80001 out of 100000 is 80.001%, which formats as 80.00% to 2 decimals.
    // 80001 * 100 = 8000100 > 100000 * 80 = 8000000 -> PASSES!
    const result = checkStrictThreshold(80001, 100000);
    expect(result.passed).toBe(true);
    expect(result.displayPct).toBe('80.00');
    expect(result.error).toBeUndefined();
  });

  it('rejects <=80.00% when display rounds up to 80.00%', () => {
    // 79999 out of 100000 is 79.999%, which may display as 80.00% if rounded.
    // 79999 * 100 = 7999900 <= 100000 * 80 = 8000000 -> FAILS!
    const result = checkStrictThreshold(79999, 100000);
    expect(result.passed).toBe(false);
    expect(result.displayPct).toBe('80.00');
    expect(result.error).toContain('is not >');
  });

  it('calculates exact BigInt branch deficit: minRequired = floor(total*80/100)+1', () => {
    // Total 36499, covered 27733
    // minRequired = floor(36499 * 80 / 100) + 1 = 29199 + 1 = 29200
    // deficit = 29200 - 27733 = 1467
    const result = checkStrictThreshold(27733, 36499);
    expect(result.passed).toBe(false);
    expect(result.minRequired).toBe('29200');
    expect(result.deficit).toBe('1467');
  });

  it('handles large safe integer arithmetic accurately', () => {
    const total = 9_000_000_000;
    const coveredPass = 7_200_000_001;
    const coveredFail = 7_200_000_000;

    const passResult = checkStrictThreshold(coveredPass, total);
    expect(passResult.passed).toBe(true);

    const failResult = checkStrictThreshold(coveredFail, total);
    expect(failResult.passed).toBe(false);
  });

  it('rejects zero denominator and invalid counts', () => {
    const zeroDenom = checkStrictThreshold(0, 0);
    expect(zeroDenom.passed).toBe(false);
    expect(zeroDenom.error).toContain('Zero denominator');

    const negativeTotal = checkStrictThreshold(10, -5);
    expect(negativeTotal.passed).toBe(false);

    const negativeCovered = checkStrictThreshold(-1, 10);
    expect(negativeCovered.passed).toBe(false);

    const coveredExceedsTotal = checkStrictThreshold(101, 100);
    expect(coveredExceedsTotal.passed).toBe(false);
    expect(coveredExceedsTotal.error).toContain('exceeds total');
  });
});

describe('coverage gate - package evaluation and masking', () => {
  it('passes when all four metrics exceed 80% strictly with consistent totals', () => {
    const result = evaluatePackageCoverage({
      packageId: 'test-pkg',
      packageName: 'Test Package',
      coverageSummary: validSummary(81, 81, 81, 81),
      expectedFiles: ['src/file1.ts', 'src/file2.ts']
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
    for (const metric of REQUIRED_METRICS) {
      expect(result.metrics[metric].passed).toBe(true);
    }
  });

  it('fails when any single metric is at or below 80%', () => {
    const result = evaluatePackageCoverage({
      packageId: 'test-pkg',
      packageName: 'Test Package',
      coverageSummary: validSummary(95, 80, 95, 95), // branches exactly 80%
      expectedFiles: ['src/file1.ts', 'src/file2.ts']
    });

    expect(result.ok).toBe(false);
    expect(result.metrics.branches.passed).toBe(false);
    expect(result.issues.some((i) => i.includes('branches'))).toBe(true);
  });

  it('rejects fabricated totals where total summary does not match sum of file metrics', () => {
    const fabricated = validSummary(90, 90, 90, 90);
    fabricated.total.lines.covered = 100; // sum of files is 90, but total claims 100!

    const result = evaluatePackageCoverage({
      packageId: 'test-pkg',
      packageName: 'Test Package',
      coverageSummary: fabricated,
      expectedFiles: ['src/file1.ts', 'src/file2.ts']
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('Total summary inconsistency'))).toBe(true);
    expect(result.issues.some((i) => i.includes('Fabricated totals rejected'))).toBe(true);
  });

  it('rejects empty file objects in coverage report', () => {
    const emptyFileSummary = {
      total: {
        lines: { total: 50, covered: 45 },
        branches: { total: 50, covered: 45 },
        functions: { total: 50, covered: 45 },
        statements: { total: 50, covered: 45 }
      },
      'src/file1.ts': {} // empty file record!
    };

    const result = evaluatePackageCoverage({
      packageId: 'test-pkg',
      packageName: 'Test Package',
      coverageSummary: emptyFileSummary,
      expectedFiles: ['src/file1.ts']
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('Empty or invalid file record'))).toBe(true);
  });

  it('strictly rejects suffix matching: expects exact repo-relative canonical path', () => {
    const summary = {
      total: {
        lines: { total: 50, covered: 45 },
        branches: { total: 50, covered: 45 },
        functions: { total: 50, covered: 45 },
        statements: { total: 50, covered: 45 }
      },
      'other/nested/file1.ts': { // different directory!
        lines: { total: 50, covered: 45 },
        branches: { total: 50, covered: 45 },
        functions: { total: 50, covered: 45 },
        statements: { total: 50, covered: 45 }
      }
    };

    const result = evaluatePackageCoverage({
      packageId: 'test-pkg',
      packageName: 'Test Package',
      coverageSummary: summary,
      expectedFiles: ['src/file1.ts']
    });

    expect(result.ok).toBe(false);
    expect(result.inventory.missing).toContain('src/file1.ts');
  });

  it('rejects path escapes with null characters or parent directory traversal', () => {
    expect(() => canonicalizeRepoPath('../../secret.ts')).toThrow('Path escapes project root');
    expect(() => canonicalizeRepoPath('src/file\0.ts')).toThrow('Illegal null character');
    expect(() => canonicalizeRepoPath('')).toThrow('Invalid path');
  });

  it('allows legitimate zero counters for type-only modules without imposing per-file threshold', () => {
    const summaryWithTypes = {
      total: {
        lines: { total: 100, covered: 90 },
        branches: { total: 100, covered: 90 },
        functions: { total: 100, covered: 90 },
        statements: { total: 100, covered: 90 }
      },
      'src/file1.ts': {
        lines: { total: 100, covered: 90 },
        branches: { total: 100, covered: 90 },
        functions: { total: 100, covered: 90 },
        statements: { total: 100, covered: 90 }
      },
      'src/types.ts': { // legitimate type-only file with 0/0
        lines: { total: 0, covered: 0 },
        branches: { total: 0, covered: 0 },
        functions: { total: 0, covered: 0 },
        statements: { total: 0, covered: 0 }
      }
    };

    const result = evaluatePackageCoverage({
      packageId: 'test-pkg',
      packageName: 'Test Package',
      coverageSummary: summaryWithTypes,
      expectedFiles: ['src/file1.ts', 'src/types.ts']
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('rejects missing required source directory or missing source root', () => {
    const result = evaluatePackageCoverage({
      packageId: 'test-pkg',
      packageName: 'Test Package',
      coverageSummary: validSummary(90, 90, 90, 90),
      sourceDirectory: 'non-existent-source-root-directory'
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('Missing required source directory'))).toBe(true);
  });

  it('rejects empty production inventory', () => {
    const result = evaluatePackageCoverage({
      packageId: 'test-pkg',
      packageName: 'Test Package',
      coverageSummary: validSummary(90, 90, 90, 90),
      expectedFiles: [] // empty!
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('Empty production coverage inventory'))).toBe(true);
  });

  it('rejects missing or malformed report', () => {
    const missing = evaluatePackageCoverage({
      packageId: 'test-pkg',
      packageName: 'Test Package',
      coverageSummary: null
    });
    expect(missing.ok).toBe(false);
    expect(missing.issues[0]).toContain('Missing or invalid');

    const noTotal = evaluatePackageCoverage({
      packageId: 'test-pkg',
      packageName: 'Test Package',
      coverageSummary: {}
    });
    expect(noTotal.ok).toBe(false);
    expect(noTotal.issues[0]).toContain("lacks 'total'");
  });

  it('detects inventory omissions when production files are excluded from coverage', () => {
    const result = evaluatePackageCoverage({
      packageId: 'test-pkg',
      packageName: 'Test Package',
      coverageSummary: validSummary(90, 90, 90, 90),
      expectedFiles: ['src/file1.ts', 'src/file2.ts', 'src/unimported-production.ts']
    });

    expect(result.ok).toBe(false);
    expect(result.inventory.missing).toContain('src/unimported-production.ts');
    expect(result.issues.some((i) => i.includes('Coverage inventory omitted 1 production file(s)'))).toBe(true);
  });

  it('prevents package masking: CLI passing + Telemetry failing fails overall gate', () => {
    const { root, inventory } = repositoryFixture();

    const gate = evaluateCoverageGate({
      projectRoot: root,
      cliSummary: completeSummary(inventory.cli),
      telemetrySummary: completeSummary(inventory.telemetry, { branches: 80 })
    });

    expect(gate.cli.ok).toBe(true);
    expect(gate.telemetry.ok).toBe(false);
    expect(gate.ok).toBe(false);
    expect(gate.issues.some((i) => i.includes('@msn-control/liftoff-telemetry-ingest [branches]'))).toBe(true);
  });

  it('prevents package masking: Telemetry passing + CLI failing fails overall gate', () => {
    const { root, inventory } = repositoryFixture();

    const gate = evaluateCoverageGate({
      projectRoot: root,
      cliSummary: completeSummary(inventory.cli, { lines: 80 }),
      telemetrySummary: completeSummary(inventory.telemetry)
    });

    expect(gate.cli.ok).toBe(false);
    expect(gate.telemetry.ok).toBe(true);
    expect(gate.ok).toBe(false);
  });
});

describe('coverage gate - native helper disclosure and qualification', () => {
  it('pins the same exact controller bytes as runtime admission', () => {
    expect(WINDOWS_JOB_CONTROLLER_DIGEST).toBe(windowsJobControllerAssetDigest);
    expect(getWindowsJobControllerDigest()).toBe(WINDOWS_JOB_CONTROLLER_DIGEST);
    expect(NATIVE_HELPER_INVENTORY[0].expectedDigest).toBe(WINDOWS_JOB_CONTROLLER_DIGEST);
  });

  it('discloses all shipped native helpers and launchers without claiming V8 coverage', () => {
    expect(NATIVE_HELPER_INVENTORY).toHaveLength(8);
    const ids = NATIVE_HELPER_INVENTORY.map((h) => h.id);
    expect(ids).toEqual([
      'windows-job-controller', 'windows-launcher', 'posix-launcher',
      'darwin-state-system', 'darwin-posix-state-lock', 'linux-posix-state-lock', 'linux-readonly-process',
      'posix-state-python-probe'
    ]);
    expect(NATIVE_HELPER_INVENTORY.find((helper) => helper.id === 'windows-launcher')).toMatchObject({
      path: 'scripts/distribution/windows-launcher.go', finalBinary: 'bin/liftoff.exe', measurement: 'native-go-pe-binary'
    });
    expect(NATIVE_HELPER_INVENTORY.some((helper) => helper.path === 'bin/liftoff.cmd')).toBe(false);
    for (const helper of NATIVE_HELPER_INVENTORY) {
      expect(helper.v8Measured).toBe(false);
    }
  });

  it('discloses embedded Python execution separately from its measured TypeScript wrapper', () => {
    const helpers = NATIVE_HELPER_INVENTORY.filter((helper) => helper.programExport);
    expect(helpers.map((helper) => [helper.id, helper.programExport, helper.requiredPlatform])).toEqual([
      ['darwin-state-system', 'darwinStateSystemProgram', 'darwin'],
      ['darwin-posix-state-lock', 'posixStateLockProgram', 'darwin'],
      ['linux-posix-state-lock', 'linuxPosixStateLockProgram', 'linux'],
      ['linux-readonly-process', 'linuxReadonlyProcessProgram', 'linux'],
      ['posix-state-python-probe', 'nativeStatePythonVersionProbe', 'posix']
    ]);
    for (const helper of helpers) {
      expect(helper.v8Measured).toBe(false);
      expect(fs.readFileSync(helper.path, 'utf8')).toContain(`export const ${helper.programExport}`);
      const report = evaluateNativeHelperQualification([helper], {
        [helper.id]: { platform: helper.requiredPlatform, passed: true, processTreeSettled: true,
          activeProcesses: 0, nativeRunId: 'asserted-only' }
      });
      expect(report.ok).toBe(false);
      expect(report.helpers[0].evidenceType).toBe('unverified-native-report');
    }
    const linux = helpers.find((helper) => helper.id === 'linux-readonly-process')!;
    expect(evaluateNativeHelperQualification([linux], {
      [linux.id]: { platform: 'darwin', passed: true, processTreeSettled: true, activeProcesses: 0, nativeRunId: 'wrong-host' }
    }).helpers[0].evidenceType).toBe('wrong-platform');
  });

  it('keeps all embedded-helper wrappers in the V8 denominator without changing the Python inspection bytes', () => {
    const inventory = getCanonicalProductionInventory();
    for (const helper of NATIVE_HELPER_INVENTORY.filter((helper) => helper.programExport)) {
      expect(inventory.cli).toContain(helper.path);
      expect(helper.compiledPath).toBe(helper.path.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js'));
    }
    expect(nativeStatePythonVersionProbe).toBe(
      'import json,platform,sys; print(json.dumps({"implementation":platform.python_implementation(),"version":".".join(map(str,sys.version_info[:3]))}))'
    );
  });

  it('requires distinct exact host-helper inventories rather than qualifying every wrapper on any host', () => {
    expect(nativeHelpersForPlatform('darwin').map((helper) => helper.id)).toEqual([
      'posix-launcher', 'darwin-state-system', 'darwin-posix-state-lock', 'posix-state-python-probe'
    ]);
    expect(nativeHelpersForPlatform('linux').map((helper) => helper.id)).toEqual([
      'posix-launcher', 'linux-posix-state-lock', 'linux-readonly-process', 'posix-state-python-probe'
    ]);
    expect(nativeHelpersForPlatform('win32').map((helper) => helper.id)).toEqual(['windows-job-controller', 'windows-launcher']);
    expect(() => nativeHelpersForPlatform('freebsd')).toThrow(/Unsupported/);
  });

  it('fails when native helper qualification evidence is absent', () => {
    const result = evaluateNativeHelperQualification(NATIVE_HELPER_INVENTORY, {});
    expect(result.ok).toBe(false);
    expect(result.helpers[0].qualified).toBe(false);
    expect(result.helpers[0].evidenceType).toBe('none');
    expect(result.issues[0]).toContain('No qualification evidence recorded');
  });

  it('rejects fixture-based evidence from non-Windows platforms', () => {
    const result = evaluateNativeHelperQualification(NATIVE_HELPER_INVENTORY, {
      'windows-job-controller': {
        platform: 'darwin', // portable runner on macOS
        isFixtureOnly: true,
        passed: true,
        processTreeSettled: true
      }
    });

    expect(result.ok).toBe(false);
    expect(result.helpers[0].qualified).toBe(false);
    expect(result.helpers[0].evidenceType).toBe('fixture-based');
    expect(result.issues[0]).toContain('fixture-based/mocked evidence');
  });

  it('rejects mismatched helper byte digest (rejects tampered controller)', () => {
    const result = evaluateNativeHelperQualification([NATIVE_HELPER_INVENTORY[0]], {
      'windows-job-controller': {
        platform: 'win32',
        helperDigest: 'tampered-digest-00000000000000000000000000000000000000000000000000',
        nativeRunId: 'run-123',
        passed: true,
        processTreeSettled: true,
        activeProcesses: 0
      }
    });

    expect(result.ok).toBe(false);
    expect(result.helpers[0].evidenceType).toBe('mismatched-digest');
    expect(result.issues[0]).toContain('does not match expected digest');
  });

  it('rejects uncertain process settlement or active processes > 0 on native Windows', () => {
    const result = evaluateNativeHelperQualification([NATIVE_HELPER_INVENTORY[0]], {
      'windows-job-controller': {
        platform: 'win32',
        helperDigest: WINDOWS_JOB_CONTROLLER_DIGEST,
        nativeRunId: 'run-win-001',
        passed: true,
        processTreeSettled: false, // settlement proof failed!
        activeProcesses: 2
      }
    });

    expect(result.ok).toBe(false);
    expect(result.helpers[0].qualified).toBe(false);
    expect(result.helpers[0].evidenceType).toBe('failed-settlement');
    expect(result.issues[0]).toContain('failed or uncertain process settlement');
  });

  it('does not authenticate native Windows assertions even with matching digest, run ID and success flags', () => {
    const result = evaluateNativeHelperQualification([NATIVE_HELPER_INVENTORY[0]], {
      'windows-job-controller': {
        platform: 'win32',
        helperDigest: getWindowsJobControllerDigest(),
        nativeRunId: 'run-win-001',
        runnerHost: 'windows-2022-runner',
        passed: true,
        processTreeSettled: true,
        activeProcesses: 0
      }
    });

    expect(result.ok).toBe(false);
    expect(result.helpers[0].qualified).toBe(false);
    expect(result.helpers[0].evidenceType).toBe('unverified-native-report');
    expect(result.issues[0]).toContain('unauthenticated report');
  });

  it('inventories and justifies contributor-only tooling and qualification helpers', () => {
    expect(CONTRIBUTOR_TOOLING_JUSTIFICATION['scripts/clean-build.mjs']).toBeDefined();
    expect(CONTRIBUTOR_TOOLING_JUSTIFICATION['scripts/audit-template-dependencies.mjs']).toBeDefined();
    expect(CONTRIBUTOR_TOOLING_JUSTIFICATION['scripts/coverage-gate.mjs']).toBeDefined();
    expect(CONTRIBUTOR_TOOLING_JUSTIFICATION['scripts/release-gate.mjs']).toBeDefined();
    expect(CONTRIBUTOR_TOOLING_JUSTIFICATION['tests/helpers/api-routing.mjs']).toBeDefined();
  });

  it('formats human-readable coverage gate report', () => {
    const gate = evaluateCoverageGate({
      cliSummary: null,
      telemetrySummary: null
    });
    const report = formatCoverageGateReport(gate);
    expect(report).toContain('LIFTOFF V8 COVERAGE MEASUREMENT GATE');
    expect(report).toContain('Status: FAIL');
    expect(report).toContain('Threshold Rule: covered * 100 > total * 80');
    expect(report).toContain('windows-job-controller');
    expect(report).toContain('V8-measured: false');
  });
});

describe('canonical measurement scope and explicit report admission', () => {
  it('can pass only the V8 measurement scope without claiming complete native or release qualification', () => {
    const { root, inventory } = repositoryFixture();
    const result = evaluateCoverageGate({
      projectRoot: root,
      cliSummary: completeSummary(inventory.cli),
      telemetrySummary: completeSummary(inventory.telemetry),
      nativeHelperEvidence: assertedHelperEvidence(getWindowsJobControllerDigest(root))
    });
    expect(result).toMatchObject({
      schemaVersion: 1, scope: 'typescript-javascript-coverage', ok: true,
      completeReleaseQualification: false, nativeHelpers: { ok: false }
    });
    expect(result.nativeHelpers.helpers.every((helper) => !helper.qualified)).toBe(true);
    expect(result.qualificationBlockers).toHaveLength(NATIVE_HELPER_INVENTORY.length);
    expect(formatCoverageGateReport(result)).toContain('does not qualify a release');
  });

  it.each([
    ['cliExpectedFiles', []], ['telemetryExpectedFiles', []], ['expectedFiles', ['src/file1.ts']],
    ['sourceDirectories', []], ['nativeHelpers', []], ['cliSummaryPath', 'other.json'],
    ['threshold', 1], ['allowMissingCoverage', true]
  ])('rejects scope or evidence fallback override %s', (key, value) => {
    const { root, inventory } = repositoryFixture();
    const result = evaluateCoverageGate({
      projectRoot: root,
      cliSummary: completeSummary(inventory.cli),
      telemetrySummary: completeSummary(inventory.telemetry),
      [key]: value
    });
    expect(result.ok).toBe(false);
    expect(result.issues.join(' ')).toContain(key);
    expect(result.nativeHelpers.helpers).toHaveLength(NATIVE_HELPER_INVENTORY.length);
  });

  it('never loads cached reports in place of omitted or explicitly invalid measurements', () => {
    const { root, inventory } = repositoryFixture();
    writeSummary(root, 'coverage/coverage-summary.json', completeSummary(inventory.cli));
    writeSummary(root, 'services/telemetry-ingest/coverage/coverage-summary.json', completeSummary(inventory.telemetry));
    const read = vi.spyOn(fs, 'readSync');
    const result = evaluateCoverageGate({ projectRoot: root, cliSummary: null, telemetrySummary: null });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      'Missing required raw cliSummary report.', 'Missing required raw telemetrySummary report.'
    ]));
    expect(read).not.toHaveBeenCalled();
  });

  it('loads only the two explicit canonical report files through bounded immutable reads', () => {
    const { root, inventory } = repositoryFixture();
    writeSummary(root, 'coverage/coverage-summary.json', completeSummary(inventory.cli));
    writeSummary(root, 'services/telemetry-ingest/coverage/coverage-summary.json', completeSummary(inventory.telemetry));
    expect(evaluateCoverageReportsOnDisk(root)).toMatchObject({ ok: true, completeReleaseQualification: false });
    fs.writeFileSync(path.join(root, 'coverage', 'coverage-summary.json'), '{"token":"private-value", invalid}');
    const result = evaluateCoverageReportsOnDisk(root);
    expect(result.ok).toBe(false);
    expect(result.issues.join(' ')).toContain('CLI coverage report cannot be admitted');
    expect(result.issues.join(' ')).not.toContain('private-value');
  });

  it.each([
    'src/file1.ts',
    'assets/governance/single-maintainer-gitflow/activation-v3-reader/identity.js',
    'assets/governance/single-maintainer-gitflow/activation-v4-policy7-reader/identity.js',
    'scripts/distribution/assembler.mjs'
  ])('retains unimported source %s in the canonical denominator', (file) => {
    const { root, inventory } = repositoryFixture();
    const result = evaluateCoverageGate({
      projectRoot: root,
      cliSummary: completeSummary(inventory.cli.filter((entry) => entry !== file)),
      telemetrySummary: completeSummary(inventory.telemetry)
    });
    expect(result.ok).toBe(false);
    expect(result.cli.inventory.missing).toContain(file);
  });

  it('rejects missing source roots and missing required shared files rather than shrinking the inventory', () => {
    const { root, inventory } = repositoryFixture();
    const options = {
      projectRoot: root, cliSummary: completeSummary(inventory.cli), telemetrySummary: completeSummary(inventory.telemetry)
    };
    fs.renameSync(path.join(root, 'scripts', 'distribution'), path.join(root, 'scripts', 'moved-distribution'));
    expect(evaluateCoverageMeasurements(options).issues.join(' ')).toContain('Canonical production inventory is unavailable');
    fs.renameSync(path.join(root, 'scripts', 'moved-distribution'), path.join(root, 'scripts', 'distribution'));
    fs.unlinkSync(path.join(root, 'src', 'telemetry', 'contract.ts'));
    expect(evaluateCoverageMeasurements(options).ok).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('does not omit linked production code from measurement', () => {
    const { root, inventory } = repositoryFixture();
    fs.symlinkSync(path.join(root, 'src', 'file1.ts'), path.join(root, 'src', 'linked.ts'));
    const result = evaluateCoverageMeasurements({
      projectRoot: root, cliSummary: completeSummary(inventory.cli), telemetrySummary: completeSummary(inventory.telemetry)
    });
    expect(result.ok).toBe(false);
    expect(result.issues.join(' ')).toContain('Linked production source');
  });

  it('rejects empty helper scope and malformed option objects', () => {
    expect(evaluateNativeHelperQualification([], {})).toMatchObject({ ok: false });
    expect(evaluateNativeHelperQualification(NATIVE_HELPER_INVENTORY, [])).toMatchObject({ ok: false });
    for (const options of [null, [], 5, { projectRoot: '' }]) {
      const result = evaluateCoverageGate(options);
      expect(result.ok).toBe(false);
      expect(() => formatCoverageGateReport(result)).not.toThrow();
    }
  });
});

describe('pure raw coverage measurement evaluation (Astra API integration)', () => {
  it('discovers canonical production inventory and dynamically computes controller digest', async () => {
    const { getCanonicalProductionInventory, getWindowsJobControllerDigest } = await import('../scripts/coverage-gate.mjs');
    const inventory = getCanonicalProductionInventory(process.cwd());

    expect(inventory.cli.length).toBeGreaterThanOrEqual(480);
    expect(inventory.cli).toContain('src/cli.ts');
    expect(inventory.cli).toContain('assets/governance/single-maintainer-gitflow/activation-v3-reader/domain/governance/policy/identity.js');
    expect(inventory.cli).toContain('scripts/distribution/assemble-native-bundle.mjs');

    expect(inventory.telemetry.length).toBe(4);
    expect(inventory.telemetry).toContain('services/telemetry-ingest/src/handler.ts');
    expect(inventory.telemetry).toContain('src/telemetry/contract.ts');

    const digest = getWindowsJobControllerDigest(process.cwd());
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('evaluates raw measurements with no fallback to disk when reports omitted', async () => {
    const { evaluateCoverageMeasurements } = await import('../scripts/coverage-gate.mjs');

    const missingBoth = evaluateCoverageMeasurements({});
    expect(missingBoth.ok).toBe(false);
    expect(missingBoth.issues).toContain('Missing required raw cliSummary report.');
    expect(missingBoth.issues).toContain('Missing required raw telemetrySummary report.');

    const missingTel = evaluateCoverageMeasurements({
      cliSummary: { total: {} }
    });
    expect(missingTel.ok).toBe(false);
    expect(missingTel.issues).toContain('Missing required raw telemetrySummary report.');
  });

  it('fails closed when windows-job-controller.ps1 is missing or unreadable', async () => {
    const { getWindowsJobControllerDigest } = await import('../scripts/coverage-gate.mjs');
    expect(() => getWindowsJobControllerDigest('/nonexistent/project/root')).toThrow(
      'Missing native Windows controller helper'
    );
  });

  it('rejects caller override keys in evaluateCoverageMeasurements to prevent inventory narrowing', async () => {
    const { evaluateCoverageMeasurements } = await import('../scripts/coverage-gate.mjs');

    const result = evaluateCoverageMeasurements({
      cliSummary: { total: {} },
      telemetrySummary: { total: {} },
      cliExpectedFiles: ['src/only-one-file.ts'] // illegal override attempt!
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes("rejects caller override key 'cliExpectedFiles'"))).toBe(true);
  });
});
