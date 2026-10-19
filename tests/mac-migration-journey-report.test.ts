import { describe, expect, it } from 'vitest';
import { assertMacMigrationJourneyReport, historicalMigrationClient } from '../scripts/mac-migration-journey-report.mjs';
import { nativeReport } from './helpers/native-report.js';

function fixture() {
  const manifest = { releaseReady: false, source: { dirty: false, commit: 'a'.repeat(40) },
    inventory: { sha256: 'b'.repeat(64) }, package: { version: '0.12.3' } };
  const cases = ['custom', 'homebrew-node', 'nvm', 'volta'].flatMap(manager =>
    ['DO_NOT_TRACK', 'LIFTOFF_TELEMETRY'].flatMap(optOut =>
      ['handover', 'settled-recovery'].map(outcome => ({
        ancestorTitles: ['actual historical npm and compiled native migration journeys', `${manager} ${optOut} ${outcome}`],
        title: 'preserves enrolled and unenrolled projects', status: 'passed',
        meta: { migrationClientJourney: { manager, optOut, outcome,
          historicalVersion: historicalMigrationClient.version, historicalArchiveSha256: historicalMigrationClient.sha256,
          nativeSourceCommit: manifest.source.commit, nativeSourceDirty: false,
          nativeManifestSha256: 'c'.repeat(64), nativeInventorySha256: manifest.inventory.sha256,
          nativeVersion: manifest.package.version, releaseReady: false, syntheticCaskAdmissionAndSettlement: true,
          realHostGlobalInstallationTouched: false, compiledClientFetchAttempts: 0, callerPreserved: true } }
      }))));
  return { manifest, report: nativeReport([{ name: '/fixture/tests/mac-migration-journey.test.ts', assertionResults: cases }]) };
}

describe('historical/native migration journey report admission', () => {
  it('requires all sixteen actual-client journeys without granting cask or public migration authority', () => {
    const { report, manifest } = fixture();
    expect(historicalMigrationClient).toEqual({
      version: '0.3.4', sha256: '05793480c44632b3fc01ac98a4f76a73313d8b273afcb30bde5c22de989d69c0'
    });

    expect(assertMacMigrationJourneyReport(report, manifest, 'c'.repeat(64))).toEqual({
      cases: 16, passed: 16, historicalVersion: '0.3.4', nativeSourceCommit: manifest.source.commit
    });
  });

  it('rejects ancillary file failure despite passing journey cases and coherent green counts', () => {
    const { report, manifest } = fixture(), ancillary = structuredClone(report.testResults[0]);
    ancillary.name = '/fixture/tests/ancillary.test.ts';
    ancillary.status = 'failed';
    report.testResults.push(ancillary);
    report.numTotalTests += 16;
    report.numPassedTests += 16;
    expect(() => assertMacMigrationJourneyReport(report, manifest, 'c'.repeat(64))).toThrow('test file');
  });

  it.each([
    'unsuccessful', 'failed-tests', 'failed-suites', 'missing-suite', 'duplicate-suite', 'wrong-suite',
    'empty', 'missing', 'duplicate', 'unexpected', 'wrong-title', 'skipped', 'failed', 'pending', 'todo',
    'missing-evidence', 'wrong-manager', 'wrong-archive', 'wrong-version', 'stale-source', 'dirty-source',
    'stale-manifest', 'stale-inventory', 'stale-version', 'release-authority', 'missing-synthetic-attribution',
    'global-installation', 'transport', 'changed-caller', 'dirty-bundle', 'release-bundle'
  ])('refuses incomplete or misattributed journey evidence: %s', fault => {
    const { report, manifest } = fixture(), suite = report.testResults[0];
    const test = suite.assertionResults[0], evidence = test.meta.migrationClientJourney;
    if (fault === 'unsuccessful') report.success = false;
    if (fault === 'failed-tests') report.numFailedTests = 1;
    if (fault === 'failed-suites') report.numFailedTestSuites = 1;
    if (fault === 'missing-suite') report.testResults = [];
    if (fault === 'duplicate-suite') report.testResults.push(suite);
    if (fault === 'wrong-suite') suite.name = '/fixture/tests/mac-migration-package.test.ts';
    if (fault === 'empty') suite.assertionResults = [];
    if (fault === 'missing') suite.assertionResults.pop();
    if (fault === 'duplicate') suite.assertionResults.push(test);
    if (fault === 'unexpected') test.ancestorTitles[1] = 'substitute case';
    if (fault === 'wrong-title') test.title = 'substitute case';
    if (['skipped', 'failed', 'pending', 'todo'].includes(fault)) test.status = fault;
    if (fault === 'missing-evidence') Reflect.deleteProperty(test.meta, 'migrationClientJourney');
    if (fault === 'wrong-manager') evidence.manager = 'different';
    if (fault === 'wrong-archive') evidence.historicalArchiveSha256 = 'd'.repeat(64);
    if (fault === 'wrong-version') evidence.historicalVersion = '0.12.3';
    if (fault === 'stale-source') evidence.nativeSourceCommit = 'd'.repeat(40);
    if (fault === 'dirty-source') evidence.nativeSourceDirty = true;
    if (fault === 'stale-manifest') evidence.nativeManifestSha256 = 'd'.repeat(64);
    if (fault === 'stale-inventory') evidence.nativeInventorySha256 = 'd'.repeat(64);
    if (fault === 'stale-version') evidence.nativeVersion = '0.0.0';
    if (fault === 'release-authority') evidence.releaseReady = true;
    if (fault === 'missing-synthetic-attribution') evidence.syntheticCaskAdmissionAndSettlement = false;
    if (fault === 'global-installation') evidence.realHostGlobalInstallationTouched = true;
    if (fault === 'transport') evidence.compiledClientFetchAttempts = 1;
    if (fault === 'changed-caller') evidence.callerPreserved = false;
    if (fault === 'dirty-bundle') manifest.source.dirty = true;
    if (fault === 'release-bundle') manifest.releaseReady = true;
    expect(() => assertMacMigrationJourneyReport(report, manifest, 'c'.repeat(64))).toThrow();
  });
});
