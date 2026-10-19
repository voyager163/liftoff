#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyNativeBundle } from './native-bundle.mjs';
import { assertNativeTestReport } from './native-bundle-contract.mjs';

export const nativeLinuxUserspaceImages = Object.freeze({
  x64: 'docker.io/rockylinux/rockylinux@sha256:f5529992e67440c1a4ae7788244d4381c6909159a88eacd95b7523ae47ced82e',
  arm64: 'docker.io/rockylinux/rockylinux@sha256:f514765516176a9aa4729ee83964e5a1900df95fd4bc7182cca64c7199b7eec7'
});

export const nativePackageCommonCases = [
  'starts the pinned runtime and installed CLI from a foreign cwd with no global tools',
  'runs every installed plan and preserves literal arguments without ambient startup code',
  'resolves packaged templates and the exact controller from the installed boundary',
  'admits packaged private cask staging only on POSIX hosts without ambient tools',
  'refuses missing template, controller, HCL and host-policy material without checkout fallback',
  'rejects changed runtime and installer bytes even with a recomputed local inventory',
  'binds archived bytes, SBOM, notices and provenance to the exact clean source',
  'extracts the exact native archive and reverifies every filesystem entry without mode normalization'
];
export const nativePackagePlatformCases = {
  linux: ['installs and recovers the actual Linux bundle within an isolated private prefix',
    'authenticates Linux bootstrap input and still refuses unqualified public installation before prefix writes',
    'runs the actual Linux bundle and owned recovery in pinned glibc 2.28 userspace without public or minimum-kernel credit'],
  darwin: ['refuses public macOS installation while minimum-host and signing qualification remain absent'],
  win32: ['refuses replacement of a running Windows image and retains the original bytes',
    'runs the actual stable Windows launcher and refuses unsafe immutable version pointers',
    'settles an actual installed Windows controller job without changing execution policy']
};
export function assertNativePackageReport(report, platform = process.platform) {
  assert.ok(nativePackagePlatformCases[platform], 'Unsupported native report host.');
  assertNativeTestReport(report);
  const suites = report.testResults.filter(suite => suite.name.replaceAll('\\', '/').endsWith('/native-package-installed.test.ts'));
  assert.equal(suites.length, 1, 'Exactly one complete installed native package suite is required.');
  const cases = suites[0].assertionResults;
  const expected = [...nativePackageCommonCases, ...Object.values(nativePackagePlatformCases).flat()];
  assert.deepEqual(cases.map(test => test.title).sort(), expected.sort(), 'Native package cases are missing or duplicated.');
  const applicable = new Set([...nativePackageCommonCases, ...nativePackagePlatformCases[platform]]);
  for (const test of cases) {
    assert.equal(test.status, applicable.has(test.title) ? 'passed' : 'skipped',
      'Every applicable native package case must run and pass; only named foreign-host cases may be unrun.');
  }
  return { platform, passed: applicable.size, unrunForeignHostCases: expected.length - applicable.size };
}
async function main() {
  const [reportPath, bundlePath, ...extra] = process.argv.slice(2);
  assert.ok(reportPath && bundlePath && extra.length === 0, 'Usage: native-package-report.mjs <report.json> <bundle>');
  const manifest = await verifyNativeBundle(path.resolve(bundlePath));
  assert.equal(manifest.source.dirty, false, 'Native package qualification requires a clean source.');
  assert.deepEqual(manifest.platform, { platform: process.platform, architecture: process.arch });
  const result = assertNativePackageReport(JSON.parse(await readFile(reportPath, 'utf8')));
  console.log(JSON.stringify({ ...result, commit: manifest.source.commit, version: manifest.package.version,
    inventorySha256: manifest.inventory.sha256, releaseReady: false }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Native package evidence failed: ${error.message}`); process.exitCode = 1; });
}
