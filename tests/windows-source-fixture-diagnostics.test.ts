import { mkdir, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  fileSharingSourceProbe, ownedDiagnosticRoot, parseKernelObservation, syntheticNpmSourceFixture
} from './fixtures/windows-source-diagnostics.js';

const native = process.platform === 'win32' && process.env.LIFTOFF_WINDOWS_FIXTURE_DIAGNOSTICS === '1';
const roots: Awaited<ReturnType<typeof ownedDiagnosticRoot>>[] = [];
const observations: Array<Awaited<ReturnType<typeof fileSharingSourceProbe>> | Awaited<ReturnType<typeof syntheticNpmSourceFixture>>> = [];
async function fixture() {
  const value = await ownedDiagnosticRoot();
  roots.push(value);
  return value;
}
afterEach(async () => { for (const root of roots.splice(0)) await root.cleanup(); });
afterAll(async () => {
  if (!native) return;
  await mkdir('diagnostics', { recursive: true });
  await writeFile('diagnostics/windows-fixture-prerequisites.json', JSON.stringify({
    classification: 'native-nonsecret-fixture-diagnostics-not-owner-or-custody-qualification',
    platform: process.platform, architecture: process.arch,
    sourceCommit: process.env.GITHUB_SHA, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    observationsComplete: observations.length === 3, observations,
    productionQualified: false, ownerChannelQualification: 'not-performed',
    baselineUnreadabilityQualification: 'not-performed'
  }, null, 2) + '\n');
});

describe('bounded kernel observation schema, parser-only source cases', () => {
  const observation = {
    mode: 'managed', processId: 123, handleValid: true,
    volumeSerial: 1755169755, fileIndex: '41095346599807089', links: 1, size: 35,
    finalNameMatchesRequested: true, requestedAccess: 2147483648, requestedShare: 0,
    secondRequestedAccess: 0x120089, secondRequestedShare: 7, secondFlags: 0x02000080,
    secondOpenError: 32, secondOpenSameFile: null
  };
  it('preserves lossless kernel identity without treating names or child liveness as handle proof', () => {
    expect(parseKernelObservation(observation)).toEqual(observation);
    expect(parseKernelObservation({ ...observation, secondOpenError: 0, secondOpenSameFile: true }))
      .toMatchObject({ secondOpenError: 0, secondOpenSameFile: true });
  });
  it.each([
    { fileIndex: 41095346599807089 }, { fileIndex: '18446744073709551616' },
    { volumeSerial: -1 }, { processId: 0 }, { handleValid: false },
    { requestedShare: 7 }, { requestedAccess: 0 }, { secondOpenError: 0 },
    { secondRequestedShare: 0 }, { secondRequestedAccess: 0 }, { secondFlags: 0 },
    { secondOpenError: 32, secondOpenSameFile: true }, { mode: 'invented' },
    { rawPath: 'must-not-be-exported' }, { stderr: 'must-not-be-exported' }
  ])('rejects imprecise, inconsistent or unregistered metadata %#', (mutation) => {
    expect(() => parseKernelObservation({ ...observation, ...mutation })).toThrow();
  });
});

describe('native Windows fixture prerequisites, not owner or read-denial qualification', () => {
  it.runIf(native)('uses actual admitted npm to pack/install a local dependency-free fixture and observes its real generated shims', async () => {
    const report = await syntheticNpmSourceFixture(await fixture());
    expect(Object.keys(report.shimDigests).sort()).toEqual(['liftoff', 'liftoff.cmd', 'liftoff.ps1']);
    expect(report).toMatchObject({ platform: 'win32', inputArtifact: 'local-synthetic-tarball', installedBytesMatch: true });
    expect(report.ownerAdmission).toMatch(/^blocked-(?:missing-installed-lock|local-artifact-origin)$/u);
    observations.push(report);
    console.info(JSON.stringify(report));
  });
  it.runIf(native).each(['managed', 'kernel'] as const)('observes actual %s handle identity and independent read-sharing outcomes', async (mode) => {
    const report = await fileSharingSourceProbe(await fixture(), mode);
    expect(report).toMatchObject({ platform: 'win32', before: { mode, handleValid: true }, settlement: 'proven' });
    observations.push(report);
    console.info(JSON.stringify(report));
  });
});

it.runIf(process.platform !== 'win32' && process.env.LIFTOFF_SYNTHETIC_NPM_DIAGNOSTIC === '1')(
  'observes actual local tarball origin on this host without Windows shim qualification', async () => {
    const report = await syntheticNpmSourceFixture(await fixture());
    expect(report.inputArtifact).toBe('local-synthetic-tarball');
    expect(report.ownerAdmission).toMatch(/^blocked-(?:missing-installed-lock|local-artifact-origin)$/u);
    expect(report.platform).not.toBe('win32');
    console.info(JSON.stringify(report));
  }
);
