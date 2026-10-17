#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const historicalMigrationClient = {
  version: '0.3.4',
  sha256: '05793480c44632b3fc01ac98a4f76a73313d8b273afcb30bde5c22de989d69c0'
};

export function assertMacMigrationJourneyReport(report, manifest, manifestSha256) {
  assert.equal(report.success, true, 'Historical/native migration journeys must succeed.');
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numFailedTestSuites, 0);
  assert.equal(manifest.releaseReady, false);
  assert.equal(manifest.source.dirty, false, 'Journey qualification requires a clean-source development bundle.');
  assert.match(manifest.source.commit, /^[a-f0-9]{40}$/);
  assert.match(manifest.inventory.sha256, /^[a-f0-9]{64}$/);
  assert.match(manifestSha256, /^[a-f0-9]{64}$/);
  const suites = report.testResults.filter(suite =>
    suite.name.replaceAll('\\', '/').endsWith('/tests/mac-migration-journey.test.ts'));
  assert.equal(suites.length, 1, 'Exactly one complete historical/native migration journey suite is required.');
  const cases = suites[0].assertionResults;
  const expected = ['custom', 'homebrew-node', 'nvm', 'volta'].flatMap(manager =>
    ['DO_NOT_TRACK', 'LIFTOFF_TELEMETRY'].flatMap(optOut =>
      ['handover', 'settled-recovery'].map(outcome => `${manager} ${optOut} ${outcome}`)));
  assert.deepEqual(cases.map(test => test.ancestorTitles.at(-1)).sort(), expected.sort(),
    'Journey cases are missing, duplicated or unexpected.');
  for (const test of cases) {
    assert.equal(test.title, 'preserves enrolled and unenrolled projects');
    assert.equal(test.status, 'passed', 'Every journey must run and pass; skipped cases are not qualification.');
    const evidence = test.meta?.migrationClientJourney;
    assert.ok(evidence, 'Actual historical/native journey evidence is required.');
    assert.equal(`${evidence.manager} ${evidence.optOut} ${evidence.outcome}`, test.ancestorTitles.at(-1));
    assert.equal(evidence.historicalVersion, historicalMigrationClient.version);
    assert.equal(evidence.historicalArchiveSha256, historicalMigrationClient.sha256);
    assert.equal(evidence.nativeSourceCommit, manifest.source.commit);
    assert.equal(evidence.nativeSourceDirty, false);
    assert.equal(evidence.nativeInventorySha256, manifest.inventory.sha256);
    assert.equal(evidence.nativeVersion, manifest.package.version);
    assert.equal(evidence.nativeManifestSha256, manifestSha256);
    assert.equal(evidence.releaseReady, false);
    assert.equal(evidence.syntheticCaskAdmissionAndSettlement, true);
    assert.equal(evidence.realHostGlobalInstallationTouched, false);
    assert.equal(evidence.compiledClientFetchAttempts, 0);
    assert.equal(evidence.callerPreserved, true);
  }
  return { cases: cases.length, passed: cases.length, historicalVersion: historicalMigrationClient.version,
    nativeSourceCommit: manifest.source.commit };
}

async function main() {
  const [reportPath, bundleRoot, ...extra] = process.argv.slice(2);
  assert.ok(reportPath && bundleRoot && extra.length === 0,
    'Usage: mac-migration-journey-report.mjs <report.json> <native-development-bundle>');
  const bytes = await readFile(path.resolve(bundleRoot, 'bundle.json'));
  const result = assertMacMigrationJourneyReport(JSON.parse(await readFile(path.resolve(reportPath), 'utf8')),
    JSON.parse(bytes.toString()), createHash('sha256').update(bytes).digest('hex'));
  console.log(JSON.stringify({ ...result, releaseReady: false, publicMigrationQualified: false,
    syntheticCaskAdmissionAndSettlement: true }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Historical/native migration journey evidence failed: ${error.message}`); process.exitCode = 1; });
}
