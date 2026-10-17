#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const macMigrationPackageCases = [
  'requires exact local inputs and never an installation or publishing command',
  'refuses unverified bundle input before output creation',
  'preserves the full licensed/runtime/asset inventory and runs direct/linked help without external Node/npm',
  'refuses existing/checkout outputs rather than overwriting them',
  'the real standalone entrypoint refuses unqualified apply on an isolated old npm fixture'
];

export function assertMacMigrationPackageReport(report) {
  assert.equal(report.success, true, 'Standalone migration package qualification must succeed.');
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numFailedTestSuites, 0);
  const suites = report.testResults.filter(suite =>
    suite.name.replaceAll('\\', '/').endsWith('/tests/mac-migration-package.test.ts'));
  assert.equal(suites.length, 1, 'Exactly one complete standalone migration package suite is required.');
  const cases = suites[0].assertionResults;
  assert.deepEqual(cases.map(test => test.title).sort(), [...macMigrationPackageCases].sort(),
    'Standalone migration package cases are missing, duplicated or unexpected.');
  assert.ok(cases.every(test => test.status === 'passed'),
    'Every standalone migration package case must run and pass; skipped cases are not qualification.');
  return { cases: cases.length, passed: cases.length };
}

async function main() {
  const [reportPath, ...extra] = process.argv.slice(2);
  assert.ok(reportPath && extra.length === 0, 'Usage: mac-migration-package-report.mjs <report.json>');
  const result = assertMacMigrationPackageReport(JSON.parse(await readFile(path.resolve(reportPath), 'utf8')));
  console.log(JSON.stringify({ ...result, releaseReady: false, publicMigrationQualified: false }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Standalone migration package evidence failed: ${error.message}`); process.exitCode = 1; });
}
