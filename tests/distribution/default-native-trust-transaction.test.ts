import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setPackageRootOverride } from '../../src/adapters/packaged-assets/package-root.js';
import { NativeReleaseClient } from '../../src/adapters/distribution/native-release-client.js';
import { NativeAdmission } from '../../src/adapters/distribution/native-admission.js';
import { InstallationDetector } from '../../src/adapters/distribution/installation-detector.js';
import { planInstallationMigration } from '../../src/application/distribution/plan-migration.js';
import { executeInstallationMigration } from '../../src/application/distribution/execute-migration.js';
import { runNativeOwnerUpgrade } from '../../src/application/distribution/native-upgrade.js';
import { readTree, sha, signedFixture, type SignedFixture } from './native-fixture.js';
import { CaptureStream } from '../helpers.js';

const fixtures: SignedFixture[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  setPackageRootOverride(undefined);
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function snapshot(root: string) {
  return (await readTree(root)).map((entry) => ({ path: entry.path, sha256: sha(entry.bytes), mode: entry.mode }));
}

describe('real native transactions using default public-root authority', () => {
  it('migrates, reopens installed trust, and discovers/upgrades a later signed stable version without replacing that root', async () => {
    const value = await signedFixture('default-public-root-cutover');
    fixtures.push(value);
    await value.publishIndex('0.13.0', 1, value.reviewNow());
    const requests: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      const filename = value.source.urls.get(url);
      if (!filename) throw new Error('Test-only default HTTP transport has no registered public artifact.');
      return new Response(Uint8Array.from(await readFile(filename)));
    };
    vi.stubGlobal('fetch', fetchFn);
    setPackageRootOverride(value.candidate);
    const admission = new NativeAdmission({
      releaseClient: new NativeReleaseClient({ now: value.reviewNow }),
      runner: value.runner, env: value.env, cwd: value.project
    });
    const detector = new InstallationDetector({
      admission, runner: value.runner, env: value.env, cwd: value.project,
      entrypoint: path.join(value.candidate, 'dist', 'cli.js'),
      npmAdapter: value.npmAdapter, receiptStore: value.store, ownerAdapters: []
    });
    const projectBefore = await snapshot(value.project);
    const plan = await planInstallationMigration({
      toOwner: 'direct', detector, receiptStore: value.store, runner: value.runner,
      candidatePath: value.candidate, destinationDirectory: value.installRoot, launcherPath: value.launcher,
      now: value.reviewNow
    });
    const migrated = await executeInstallationMigration({ plan, approvePlan: plan.planFingerprint });
    expect(migrated.status, migrated.failure?.message).toBe('completed');
    const original = await value.store.loadDirectReceipt(value.installRoot);
    if (!original) throw new Error('Default public-root migration must establish its private receipt.');
    const installedTrustPath = path.join(original.versionRoot, 'assets', 'distribution', 'native-trust.json');
    const installedRootBytes = await readFile(installedTrustPath);
    const installedPackageBytes = await readFile(path.join(original.versionRoot, 'package.json'));

    setPackageRootOverride(original.versionRoot);
    const installedAdmission = new NativeAdmission({
      releaseClient: new NativeReleaseClient({ now: value.reviewNow }),
      runner: value.runner, env: value.env, cwd: value.project
    });
    const installedDetector = new InstallationDetector({
      admission: installedAdmission, runner: value.runner, env: value.env, cwd: value.project,
      entrypoint: path.join(original.versionRoot, 'dist', 'cli.js'),
      npmAdapter: value.npmAdapter, receiptStore: value.store, ownerAdapters: []
    });
    expect((await installedDetector.inspectInstallation()).status).toBe('healthy');
    await value.registerRelease('0.14.0');
    await value.publishIndex('0.14.0', 2, value.reviewNow());
    const recordsBefore = await snapshot(value.store.baseDirectory);
    const request = (mode: 'check' | 'apply') => ({
      mode, currentVersion: '0.13.0', stdout: new CaptureStream(), stderr: new CaptureStream(), json: true
    });
    const dependencies = {
      detector: installedDetector, receiptStore: value.store, runner: value.runner, now: value.reviewNow
    };
    const checked = await runNativeOwnerUpgrade(request('check'), dependencies);
    expect(checked).toMatchObject({ status: 'update-available', owner: 'direct', targetVersion: '0.14.0' });
    expect(await snapshot(value.store.baseDirectory)).toEqual(recordsBefore);
    expect(await readFile(installedTrustPath)).toEqual(installedRootBytes);
    expect(await readFile(path.join(original.versionRoot, 'package.json'))).toEqual(installedPackageBytes);
    const upgraded = await runNativeOwnerUpgrade(request('apply'), dependencies);
    expect(upgraded).toMatchObject({ status: 'upgraded', targetVersion: '0.14.0', recoveryRequired: false });
    expect((await value.store.loadDirectReceipt(value.installRoot))?.version).toBe('0.14.0');
    expect(await snapshot(value.project)).toEqual(projectBefore);
    expect(value.runner.calls.filter((call) => call.command.args[0] === 'uninstall')).toHaveLength(1);
    expect(requests.some((url) => url.includes('/isolated-fixture-index/'))).toBe(true);
    expect(requests.some((url) => url.includes('qualification') || url.includes('npmjs'))).toBe(false);
  }, 120_000);
});
