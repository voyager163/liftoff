import { describe, expect, it } from 'vitest';
import { assertMacMigrationPackageReport, macMigrationPackageCases } from '../scripts/mac-migration-package-report.mjs';
import { nativeReport } from './helpers/native-report.js';

function report() {
  return nativeReport([{
    name: '/fixture/tests/mac-migration-package.test.ts',
    assertionResults: macMigrationPackageCases.map(title => ({ title, status: 'passed' }))
  }]);
}

describe('standalone migration package report admission', () => {
  it('requires the exact five existing utility cases without granting public migration authority', () => {
    expect(macMigrationPackageCases).toEqual([
      'requires exact local inputs and never an installation or publishing command',
      'refuses unverified bundle input before output creation',
      'preserves the full licensed/runtime/asset inventory and runs direct/linked help without external Node/npm',
      'refuses existing/checkout outputs rather than overwriting them',
      'the real standalone entrypoint refuses unqualified apply on an isolated old npm fixture'
    ]);
    expect(assertMacMigrationPackageReport(report())).toEqual({ cases: 5, passed: 5 });
  });

  it('accepts the same exact suite through Windows paths and within a combined native report', () => {
    const selected = report();
    selected.testResults[0].name = 'C:\\fixture\\tests\\mac-migration-package.test.ts';
    selected.testResults.push({
      name: '/fixture/tests/native-package-installed.test.ts',
      status: 'passed',
      assertionResults: [{ title: 'foreign host case', status: 'skipped' }]
    });
    selected.numTotalTests++;
    selected.numPendingTests++;
    expect(assertMacMigrationPackageReport(selected)).toEqual({ cases: 5, passed: 5 });
  });

  it('rejects ancillary file failure even with passing required cases and coherent green counts', () => {
    const selected = report(), ancillary = structuredClone(selected.testResults[0]);
    ancillary.name = '/fixture/tests/ancillary.test.ts';
    ancillary.status = 'failed';
    selected.testResults.push(ancillary);
    selected.numTotalTests += macMigrationPackageCases.length;
    selected.numPassedTests += macMigrationPackageCases.length;
    expect(() => assertMacMigrationPackageReport(selected)).toThrow('test file');
  });

  it.each([
    'unsuccessful', 'failed-tests', 'failed-suites', 'missing-suite', 'duplicate-suite', 'wrong-suite',
    'empty', 'missing', 'duplicate', 'unexpected', 'skipped', 'failed', 'pending', 'todo'
  ])('refuses incomplete or unrun utility evidence: %s', fault => {
    const selected = report(), suite = selected.testResults[0];
    if (fault === 'unsuccessful') selected.success = false;
    if (fault === 'failed-tests') selected.numFailedTests = 1;
    if (fault === 'failed-suites') selected.numFailedTestSuites = 1;
    if (fault === 'missing-suite') selected.testResults = [];
    if (fault === 'duplicate-suite') selected.testResults.push(suite);
    if (fault === 'wrong-suite') suite.name = '/fixture/tests/mac-migration.test.ts';
    if (fault === 'empty') suite.assertionResults = [];
    if (fault === 'missing') suite.assertionResults.pop();
    if (fault === 'duplicate') suite.assertionResults.push(suite.assertionResults[0]);
    if (fault === 'unexpected') suite.assertionResults[0].title = 'unexpected substitute case';
    if (['skipped', 'failed', 'pending', 'todo'].includes(fault)) suite.assertionResults[0].status = fault;
    expect(() => assertMacMigrationPackageReport(selected)).toThrow();
  });
});
