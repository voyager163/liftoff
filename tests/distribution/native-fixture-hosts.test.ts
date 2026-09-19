import path from 'node:path';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeHost } from '../../src/domain/distribution/native-trust.js';
import { NativeAdmission } from '../../src/adapters/distribution/native-admission.js';
import { HomebrewAdapter } from '../../src/adapters/distribution/homebrew-adapter.js';
import { planInstallationMigration } from '../../src/application/distribution/plan-migration.js';
import { executeInstallationMigration } from '../../src/application/distribution/execute-migration.js';
import { signedFixture, type SignedFixture } from './native-fixture.js';
import { homebrewFixture, signedHomebrewFixture } from './manager-fixture.js';
import { ForeignHostRuntimeDouble } from './foreign-host-runtime-double.js';

const fixtures: SignedFixture[] = [];
afterEach(async () => { for (const value of fixtures.splice(0)) await value.cleanup(); });

function foreignHost(): NativeHost {
  if (process.arch !== 'x64' && process.arch !== 'arm64') throw new Error('Unsupported source-fixture architecture.');
  return process.platform === 'darwin'
    ? { os: 'linux', arch: process.arch, kernelRelease: '4.18.0', glibcVersion: '2.31' }
    : { os: 'darwin', arch: process.arch, kernelRelease: '22.6.0', darwinRelease: '22.6.0', hostVersion: '13.5.0' };
}

describe('explicit source-fixture host policy, not native platform qualification', () => {
  it.each(['darwin', 'linux'] as const)('keeps %s signing and admission coherent independently of the runner host', async (os) => {
    if (process.arch !== 'x64' && process.arch !== 'arm64') throw new Error('Unsupported source-fixture architecture.');
    const linuxHost: NativeHost = { os: 'linux', arch: process.arch, kernelRelease: '4.18.0', glibcVersion: '2.31' };
    const value = os === 'darwin'
      ? await signedHomebrewFixture('explicit-darwin-host')
      : await signedFixture('explicit-linux-host', { host: linuxHost });
    fixtures.push(value);
    const target = `${os}-${process.arch}`;
    const buildInfo = JSON.parse(await readFile(path.join(value.candidate, 'build-info.json'), 'utf8'));
    const buildManifest = JSON.parse(await readFile(path.join(value.candidate, 'liftoff-build-manifest.json'), 'utf8'));
    expect(buildInfo.target).toEqual({ os, arch: process.arch, platform: target });
    expect(buildManifest.target).toBe(target);
    expect(value.provenance.target).toBe(target);
    expect(value.admission.host.os).toBe(os);
    expect(value.runtimeExecution).toBe(os === process.platform ? 'current-host' : 'foreign-host-test-double');
    const candidate = await value.admission.admitBundle(value.candidate);
    expect(candidate.target).toBe(target);
    await value.admission.probe(candidate);
    expect(value.runner.calls.map(({ command }) => command.executable)).toEqual([
      path.join(value.candidate, 'runtime', 'node'), path.join(value.candidate, 'runtime', 'node'),
      path.join(value.candidate, 'bin', 'liftoff')
    ]);
    if (os !== process.platform) {
      const double = value.runner.runner as ForeignHostRuntimeDouble;
      expect(double).toBeInstanceOf(ForeignHostRuntimeDouble);
      expect(double.bridgedCommands).toHaveLength(3);
      expect(double.bridgedCommands.every(({ executed }) => executed.executable === process.execPath)).toBe(true);
    } else {
      expect(value.runner.runner).not.toBeInstanceOf(ForeignHostRuntimeDouble);
    }
    const calls = value.runner.calls.length;
    const otherHost: NativeHost = os === 'darwin' ? linuxHost
      : { os: 'darwin', arch: process.arch, kernelRelease: '22.6.0', darwinRelease: '22.6.0', hostVersion: '13.5.0' };
    const mismatched = new NativeAdmission({
      releaseClient: value.client, host: otherHost, runner: value.runner, env: value.env, cwd: value.project
    });
    await expect(mismatched.admitBundle(value.candidate)).rejects.toMatchObject({ reasonCode: 'unsupported_host' });
    expect(value.runner.calls).toHaveLength(calls);
    if (os === 'linux') {
      const adapter = new HomebrewAdapter({ admission: value.admission, runner: value.runner, env: value.env, cwd: value.project });
      await expect(adapter.select(candidate, 'install')).rejects.toMatchObject({ reasonCode: 'unsupported_host' });
      expect(value.runner.calls).toHaveLength(calls);
    }
  });

  it('rejects a genuinely signed real runtime relabeled as a foreign machine format before the execution port', async () => {
    const value = await signedFixture('signed-wrong-real-runtime-format', {
      host: foreignHost(),
      beforeSigning: (bundle) => copyFile(process.execPath, path.join(bundle, 'runtime', 'node'))
    });
    fixtures.push(value);
    const release = await value.client.fetchVerifiedRelease('0.13.0');
    await expect(value.admission.admitReleaseTarget(release)).rejects.toMatchObject({ reasonCode: 'artifact_mismatch' });
    await expect(value.admission.admitBundle(value.candidate)).rejects.toMatchObject({ reasonCode: 'artifact_mismatch' });
    expect(value.runner.calls).toHaveLength(0);
    expect((value.runner.runner as ForeignHostRuntimeDouble).bridgedCommands).toHaveLength(0);
  });

  it('executes the actual signed installed CLI bytes rather than manufacturing a successful foreign-host version', async () => {
    const value = await signedFixture('foreign-host-wrong-cli-version', {
      host: foreignHost(),
      beforeSigning: (bundle) => writeFile(path.join(bundle, 'dist', 'cli.js'), 'process.stdout.write("Liftoff 9.9.9\\n");\n')
    });
    fixtures.push(value);
    const candidate = await value.admission.admitBundle(value.candidate);
    await expect(value.admission.probe(candidate)).rejects.toMatchObject({ reasonCode: 'verification_failed' });
    expect((value.runner.runner as ForeignHostRuntimeDouble).bridgedCommands).toHaveLength(2);
  });

  it('preserves owner ordering and installed readback through the explicitly simulated Homebrew execution port', async () => {
    const value = await signedFixture('foreign-machine-homebrew-cutover', {
      host: {
        os: 'darwin', arch: process.arch === 'arm64' ? 'x64' : 'arm64',
        kernelRelease: '22.6.0', darwinRelease: '22.6.0', hostVersion: '13.5.0'
      }
    });
    fixtures.push(value);
    expect(value.runtimeExecution).toBe('foreign-host-test-double');
    const manager = await homebrewFixture(value);
    const plan = await planInstallationMigration({
      toOwner: 'homebrew-cask', detector: manager.detector, receiptStore: value.store, runner: value.runner,
      candidatePath: value.candidate, now: value.reviewNow
    });
    const record = await executeInstallationMigration({ plan, approvePlan: plan.planFingerprint, json: true });
    expect(record.status, record.failure?.message).toBe('completed');
    expect(record.verification).toMatchObject({
      explicitPathVerified: true, pathResolutionVerified: true, observedVersion: '0.13.0'
    });
    expect(value.runner.calls.filter(({ command }) => ['install', 'uninstall'].includes(command.args[0]))
      .map(({ command }) => command.args[0])).toEqual(['uninstall', 'install']);
    expect((await manager.detector.inspectInstallation(manager.targetRoot)).installation)
      .toMatchObject({ owner: 'homebrew-cask', version: '0.13.0', packageName: manager.packageId });
    const double = value.runner.runner as ForeignHostRuntimeDouble;
    expect(double.bridgedCommands.some(({ requested, executed }) =>
      requested.executable === manager.launcherPath &&
      executed.args[0] === path.join(manager.targetRoot, 'dist', 'cli.js'))).toBe(true);
  });
});
