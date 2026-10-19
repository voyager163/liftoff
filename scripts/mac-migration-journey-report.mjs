#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertNativeTestReport } from './native-bundle-contract.mjs';

export const historicalMigrationClient = {
  version: '0.3.4',
  sha256: '05793480c44632b3fc01ac98a4f76a73313d8b273afcb30bde5c22de989d69c0'
};

export function macMigrationJourneyLane(version) {
  assert.equal(typeof version, 'string', 'An actual verified bundle version is required.');
  const identifier = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
  const match = version.match(new RegExp(
    `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${identifier}(?:\\.${identifier})*))?$`));
  assert.ok(match, 'Unsupported bundle version; do not normalize or relabel it.');
  assert.equal(match[0], version, 'The entire bundle version must match without trailing characters.');
  return match[4] ? 'prerelease-refusal' : 'stable-handover';
}

function assertJourneyManifest(manifest, manifestSha256) {
  assert.equal(manifest.releaseReady, false);
  assert.equal(manifest.source.dirty, false, 'Journey qualification requires a clean-source development bundle.');
  assert.match(manifest.source.commit, /^[a-f0-9]{40}$/);
  assert.match(manifest.inventory.sha256, /^[a-f0-9]{64}$/);
  assert.match(manifestSha256, /^[a-f0-9]{64}$/);
}

function assertJourneyBinding(evidence, manifest, manifestSha256) {
  assert.ok(evidence, 'Actual historical/native journey evidence is required.');
  assert.equal(evidence.historicalVersion, historicalMigrationClient.version);
  assert.equal(evidence.historicalArchiveSha256, historicalMigrationClient.sha256);
  assert.equal(evidence.nativeSourceCommit, manifest.source.commit);
  assert.equal(evidence.nativeSourceDirty, false);
  assert.equal(evidence.nativeInventorySha256, manifest.inventory.sha256);
  assert.equal(evidence.nativeVersion, manifest.package.version);
  assert.equal(evidence.nativeManifestSha256, manifestSha256);
  assert.equal(evidence.releaseReady, false);
  assert.equal(evidence.realHostGlobalInstallationTouched, false);
  assert.equal(evidence.compiledClientFetchAttempts, 0);
  assert.equal(evidence.callerPreserved, true);
}

export function assertMacMigrationJourneyReport(report, manifest, manifestSha256) {
  assert.equal(macMigrationJourneyLane(manifest.package.version), 'stable-handover',
    'Prerelease refusal is not positive handover qualification.');
  assertNativeTestReport(report);
  assertJourneyManifest(manifest, manifestSha256);
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
    assertJourneyBinding(evidence, manifest, manifestSha256);
    assert.equal(`${evidence.manager} ${evidence.optOut} ${evidence.outcome}`, test.ancestorTitles.at(-1));
    assert.equal(evidence.syntheticCaskAdmissionAndSettlement, true);
  }
  return { cases: cases.length, passed: cases.length, historicalVersion: historicalMigrationClient.version,
    nativeSourceCommit: manifest.source.commit };
}

export function assertMacMigrationPrereleaseRefusalReport(report, manifest, manifestSha256) {
  assert.equal(macMigrationJourneyLane(manifest.package.version), 'prerelease-refusal');
  assertJourneyManifest(manifest, manifestSha256);
  assertNativeTestReport(report);
  const suites = report.testResults.filter(suite =>
    suite.name.replaceAll('\\', '/').endsWith('/tests/mac-migration-prerelease.test.ts'));
  assert.equal(suites.length, 1, 'Exactly one genuine prerelease-refusal suite is required.');
  const cases = suites[0].assertionResults;
  const expected = ['custom', 'homebrew-node', 'nvm', 'volta'].flatMap(manager =>
    ['DO_NOT_TRACK', 'LIFTOFF_TELEMETRY'].flatMap(optOut =>
      ['preview', 'apply'].map(mode => `${manager} ${optOut} ${mode}`)));
  assert.deepEqual(cases.map(test => test.ancestorTitles.at(-1)).sort(), expected.sort());
  for (const test of cases) {
    assert.equal(test.title, 'refuses the genuine prerelease before npm removal');
    assert.equal(test.status, 'passed', 'Unrun prerelease cases are not refusal qualification.');
    const evidence = test.meta?.migrationPrereleaseRefusal;
    assertJourneyBinding(evidence, manifest, manifestSha256);
    assert.equal(`${evidence.manager} ${evidence.optOut} ${evidence.mode}`, test.ancestorTitles.at(-1));
    assert.equal(evidence.outcome, 'prerelease-refusal');
    assert.equal(evidence.positiveMigrationQualified, false);
    assert.equal(evidence.syntheticReleaseAdmissionContext, true);
    assert.deepEqual(evidence.blockers, ['native-native_invalid']);
    assert.equal(evidence.effects, 'none');
    assert.equal(evidence.npmUninstallCalls, 0);
    assert.equal(evidence.caskDispatchCalls, 0);
    assert.equal(evidence.journalCreated, false);
    assert.equal(evidence.oldOwnerPreserved, true);
  }
  return { cases: cases.length, passed: cases.length, historicalVersion: historicalMigrationClient.version,
    nativeSourceCommit: manifest.source.commit, nativeVersion: manifest.package.version,
    outcome: 'prerelease-refusal', positiveMigrationQualified: false };
}

async function verifiedBundle(bundleRoot) {
  const { verifyNativeBundle } = await import('./native-bundle.mjs');
  const manifest = await verifyNativeBundle(bundleRoot);
  const bytes = await readFile(path.resolve(bundleRoot, 'bundle.json'));
  assert.deepEqual(JSON.parse(bytes.toString()), manifest, 'Verified bundle manifest changed.');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assertJourneyManifest(manifest, sha256);
  return { manifest, sha256 };
}

async function main() {
  const [reportPath, bundleRoot, lane, ...extra] = process.argv.slice(2);
  assert.ok(reportPath && bundleRoot && extra.length === 0,
    'Usage: mac-migration-journey-report.mjs select <bundle> | <report.json> <bundle> [stable-handover|prerelease-refusal]');
  const { manifest, sha256 } = await verifiedBundle(bundleRoot);
  const actualLane = macMigrationJourneyLane(manifest.package.version);
  if (reportPath === 'select') {
    assert.equal(lane, undefined);
    console.log(actualLane);
    return;
  }
  assert.equal(lane ?? 'stable-handover', actualLane, 'Report outcome must match the verified bundle version.');
  const report = JSON.parse(await readFile(path.resolve(reportPath), 'utf8'));
  const result = actualLane === 'stable-handover' ? assertMacMigrationJourneyReport(report, manifest, sha256) :
    assertMacMigrationPrereleaseRefusalReport(report, manifest, sha256);
  console.log(JSON.stringify({ ...result, releaseReady: false, publicMigrationQualified: false,
    outcome: actualLane, positiveMigrationQualified: actualLane === 'stable-handover',
    ...(actualLane === 'stable-handover' ? { syntheticCaskAdmissionAndSettlement: true } :
      { syntheticReleaseAdmissionContext: true }) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Historical/native migration journey evidence failed: ${error.message}`); process.exitCode = 1; });
}
