import { describe, expect, it } from 'vitest';
import {
  assertMacMigrationJourneyReport, assertMacMigrationPrereleaseRefusalReport,
  historicalMigrationClient, macMigrationJourneyLane
} from '../scripts/mac-migration-journey-report.mjs';
import { isStableSemver } from '../src/stable-release.js';

function fixture() {
  const manifest = { releaseReady: false, source: { dirty: false, commit: 'a'.repeat(40) },
    inventory: { sha256: 'b'.repeat(64) }, package: { version: '0.13.0-dev.0' } };
  const cases = ['custom', 'homebrew-node', 'nvm', 'volta'].flatMap(manager =>
    ['DO_NOT_TRACK', 'LIFTOFF_TELEMETRY'].flatMap(optOut =>
      ['preview', 'apply'].map(mode => ({
        ancestorTitles: ['actual historical npm and genuine native prerelease refusal', `${manager} ${optOut} ${mode}`],
        title: 'refuses the genuine prerelease before npm removal', status: 'passed',
        meta: { migrationPrereleaseRefusal: {
          manager, optOut, mode, outcome: 'prerelease-refusal', positiveMigrationQualified: false,
          historicalVersion: historicalMigrationClient.version, historicalArchiveSha256: historicalMigrationClient.sha256,
          nativeSourceCommit: manifest.source.commit, nativeSourceDirty: false,
          nativeManifestSha256: 'c'.repeat(64), nativeInventorySha256: manifest.inventory.sha256,
          nativeVersion: manifest.package.version, releaseReady: false, syntheticReleaseAdmissionContext: true,
          realHostGlobalInstallationTouched: false, compiledClientFetchAttempts: 0, callerPreserved: true,
          blockers: ['native-native_invalid'], effects: 'none', npmUninstallCalls: 0, caskDispatchCalls: 0,
          journalCreated: false, oldOwnerPreserved: true
        } }
      }))));
  return { manifest, report: { success: true, numFailedTests: 0, numFailedTestSuites: 0,
    testResults: [{ name: '/fixture/tests/mac-migration-prerelease.test.ts', assertionResults: cases }] } };
}

describe('migration journey version selection and prerelease report contract', () => {
  it.each(['0.12.3', '0.13.0', '1.0.0', '0.0.0'])('retains the stable-positive gate for %s', version => {
    expect(isStableSemver(version)).toBe(true);
    expect(macMigrationJourneyLane(version)).toBe('stable-handover');
  });
  it.each(['0.13.0-dev.0', '0.13.0-rc.1', '1.0.0-alpha', '1.0.0-0', '1.0.0-1a'])(
    'selects refusal without changing the production stable guard for %s', version => {
      expect(isStableSemver(version)).toBe(false);
      expect(macMigrationJourneyLane(version)).toBe('prerelease-refusal');
    });
  it.each(['', 'v0.13.0', ' 0.13.0', '0.13.0 ', '0.13.0\n', '01.13.0', '0.013.0', '0.13.00',
    '0.13', 'latest', '0.13.0-', '0.13.0-dev..0', '0.13.0-dev.01', '0.13.0+build', '0.13.0-dev.0+build'])(
    'refuses unsupported version selection rather than normalizing %j', version => {
      expect(() => macMigrationJourneyLane(version)).toThrow();
    });
  it('admits the complete refusal contract without positive migration credit', () => {
    const { report, manifest } = fixture();
    expect(assertMacMigrationPrereleaseRefusalReport(report, manifest, 'c'.repeat(64))).toEqual({
      cases: 16, passed: 16, historicalVersion: '0.3.4', nativeSourceCommit: manifest.source.commit,
      nativeVersion: '0.13.0-dev.0', outcome: 'prerelease-refusal', positiveMigrationQualified: false
    });
    expect(() => assertMacMigrationJourneyReport(report, manifest, 'c'.repeat(64))).toThrow();
  });
  it('does not relabel a stable manifest as genuine prerelease refusal', () => {
    const { report, manifest } = fixture();
    manifest.package.version = '0.13.0';
    for (const test of report.testResults[0].assertionResults) test.meta.migrationPrereleaseRefusal.nativeVersion = '0.13.0';
    expect(() => assertMacMigrationPrereleaseRefusalReport(report, manifest, 'c'.repeat(64))).toThrow();
  });
  it.each([
    'unsuccessful', 'failed-tests', 'failed-suites', 'missing-suite', 'duplicate-suite', 'wrong-suite',
    'empty', 'missing', 'duplicate', 'unexpected', 'wrong-title', 'skipped', 'failed', 'pending', 'todo',
    'missing-evidence', 'wrong-manager', 'wrong-mode', 'wrong-archive', 'wrong-old-version', 'stale-source',
    'dirty-source', 'stale-manifest', 'stale-inventory', 'stale-version', 'release-authority',
    'missing-synthetic-attribution', 'global-installation', 'transport', 'changed-caller',
    'dirty-bundle', 'release-bundle', 'positive-credit', 'wrong-outcome', 'wrong-blocker', 'extra-blocker',
    'possible-effects', 'npm-removal', 'cask-dispatch', 'journal-created', 'changed-old-owner',
    'malformed-source', 'malformed-inventory', 'malformed-manifest'
  ])('rejects incomplete or misattributed prerelease refusal: %s', fault => {
    const { report, manifest } = fixture(), suite = report.testResults[0];
    const test = suite.assertionResults[0], evidence = test.meta.migrationPrereleaseRefusal;
    if (fault === 'unsuccessful') report.success = false;
    if (fault === 'failed-tests') report.numFailedTests = 1;
    if (fault === 'failed-suites') report.numFailedTestSuites = 1;
    if (fault === 'missing-suite') report.testResults = [];
    if (fault === 'duplicate-suite') report.testResults.push(suite);
    if (fault === 'wrong-suite') suite.name = '/fixture/tests/mac-migration-journey.test.ts';
    if (fault === 'empty') suite.assertionResults = [];
    if (fault === 'missing') suite.assertionResults.pop();
    if (fault === 'duplicate') suite.assertionResults.push(test);
    if (fault === 'unexpected') test.ancestorTitles[1] = 'substitute case';
    if (fault === 'wrong-title') test.title = 'substitute case';
    if (['skipped', 'failed', 'pending', 'todo'].includes(fault)) test.status = fault;
    if (fault === 'missing-evidence') Reflect.deleteProperty(test.meta, 'migrationPrereleaseRefusal');
    if (fault === 'wrong-manager') evidence.manager = 'different';
    if (fault === 'wrong-mode') evidence.mode = 'recover';
    if (fault === 'wrong-archive') evidence.historicalArchiveSha256 = 'd'.repeat(64);
    if (fault === 'wrong-old-version') evidence.historicalVersion = '0.12.3';
    if (fault === 'stale-source') evidence.nativeSourceCommit = 'd'.repeat(40);
    if (fault === 'dirty-source') evidence.nativeSourceDirty = true;
    if (fault === 'stale-manifest') evidence.nativeManifestSha256 = 'd'.repeat(64);
    if (fault === 'stale-inventory') evidence.nativeInventorySha256 = 'd'.repeat(64);
    if (fault === 'stale-version') evidence.nativeVersion = '0.12.3';
    if (fault === 'release-authority') evidence.releaseReady = true;
    if (fault === 'missing-synthetic-attribution') evidence.syntheticReleaseAdmissionContext = false;
    if (fault === 'global-installation') evidence.realHostGlobalInstallationTouched = true;
    if (fault === 'transport') evidence.compiledClientFetchAttempts = 1;
    if (fault === 'changed-caller') evidence.callerPreserved = false;
    if (fault === 'dirty-bundle') manifest.source.dirty = true;
    if (fault === 'release-bundle') manifest.releaseReady = true;
    if (fault === 'positive-credit') evidence.positiveMigrationQualified = true;
    if (fault === 'wrong-outcome') evidence.outcome = 'handover';
    if (fault === 'wrong-blocker') evidence.blockers = ['exact-cask-unavailable'];
    if (fault === 'extra-blocker') evidence.blockers.push('exact-cask-unavailable');
    if (fault === 'possible-effects') evidence.effects = 'possible';
    if (fault === 'npm-removal') evidence.npmUninstallCalls = 1;
    if (fault === 'cask-dispatch') evidence.caskDispatchCalls = 1;
    if (fault === 'journal-created') evidence.journalCreated = true;
    if (fault === 'changed-old-owner') evidence.oldOwnerPreserved = false;
    if (fault === 'malformed-source') manifest.source.commit = 'unbound';
    if (fault === 'malformed-inventory') manifest.inventory.sha256 = 'unbound';
    expect(() => assertMacMigrationPrereleaseRefusalReport(report, manifest,
      fault === 'malformed-manifest' ? 'unbound' : 'c'.repeat(64))).toThrow();
  });
});
