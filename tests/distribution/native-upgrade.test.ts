import { afterEach, describe, expect, it } from 'vitest';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runNativeOwnerUpgrade, nativeUpgradeExitCode } from '../../src/application/distribution/native-upgrade.js';
import { planInstallationMigration } from '../../src/application/distribution/plan-migration.js';
import { executeInstallationMigration } from '../../src/application/distribution/execute-migration.js';
import { NativeReleaseClient } from '../../src/adapters/distribution/native-release-client.js';
import { NativeAdmission } from '../../src/adapters/distribution/native-admission.js';
import { InstallationDetector } from '../../src/adapters/distribution/installation-detector.js';
import { DirectInstallerAdapter, nativeHandoverError } from '../../src/adapters/distribution/direct-installer-adapter.js';
import { HomebrewAdapter } from '../../src/adapters/distribution/homebrew-adapter.js';
import { validateNativeBuildInfo } from '../../src/adapters/packaged-assets/build-info.js';
import { CaptureStream } from '../helpers.js';
import { readTree, sha, signedFixture, type SignedFixture, type SignedFixtureOptions } from './native-fixture.js';
import { homebrewFixture, signedHomebrewFixture } from './manager-fixture.js';

const fixtures: SignedFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });
async function fixture(name: string, options?: SignedFixtureOptions, create = signedFixture) {
  const value = await create(name, options); fixtures.push(value); return value;
}
function request(mode: 'check' | 'apply') {
  return { mode, currentVersion: '0.13.0', stdout: new CaptureStream(), stderr: new CaptureStream(), json: true };
}
async function install(value: SignedFixture) {
  const plan = await planInstallationMigration({
    toOwner: 'direct', detector: value.detector, receiptStore: value.store, runner: value.runner,
    candidatePath: value.candidate, destinationDirectory: value.installRoot, launcherPath: value.launcher, now: value.reviewNow
  });
  const record = await executeInstallationMigration({ plan, approvePlan: plan.planFingerprint });
  expect(record.status, record.failure?.message).toBe('completed');
  const receipt = await value.store.loadDirectReceipt(value.installRoot);
  if (!receipt) throw new Error('Fixture direct owner was not established.');
  return receipt;
}
async function newer(value: SignedFixture, entrypoint: string) {
  await value.registerRelease('0.14.0');
  value.trust.stableVersion = '0.14.0';
  const admission = new NativeAdmission({
    releaseClient: new NativeReleaseClient({ trust: value.trust, source: value.source }),
    runner: value.runner, env: value.env, cwd: value.project, host: value.admission.host
  });
  const detector = new InstallationDetector({
    admission, runner: value.runner, env: value.env, cwd: value.project, entrypoint,
    receiptStore: value.store, ownerAdapters: [], npmAdapter: value.npmAdapter
  });
  return { detector, runner: value.runner, receiptStore: value.store };
}
async function snapshot(root: string) {
  return (await readTree(root)).map((file) => ({ path: file.path, hash: sha(file.bytes), mode: file.mode }));
}

describe('dedicated owner-preserving native upgrade', () => {
  it('never falls back from npm or a verified unlinked candidate into npm replacement', async () => {
    const value = await fixture('upgrade-owner-boundary');
    const unlinked = await runNativeOwnerUpgrade(request('apply'), { detector: value.detector });
    expect(unlinked).toMatchObject({ distribution: 'native', status: 'blocked', owner: 'unlinked' });
    const npmDetector = new InstallationDetector({
      admission: value.admission, env: value.env, cwd: value.project, receiptStore: value.store,
      npmAdapter: value.npmAdapter, entrypoint: path.join(value.packageRoot, 'dist', 'cli.js'), ownerAdapters: []
    });
    const legacy = await runNativeOwnerUpgrade(request('apply'), { detector: npmDetector });
    expect(legacy).toMatchObject({ status: 'blocked', owner: 'npm', reasonCode: 'migration_required' });
    expect(value.runner.calls.some((call) => ['install', 'uninstall'].includes(call.command.args[0]))).toBe(false);
  });

  it('checks without state writes then upgrades exact verified bytes without a fingerprint or second Yes flag', async () => {
    const value = await fixture('owner-preserving-real-upgrade');
    const previous = await install(value);
    const dependencies = await newer(value, path.join(previous.versionRoot, 'dist', 'cli.js'));
    const before = await snapshot(value.store.baseDirectory);
    const project = await snapshot(value.project);
    const checked = await runNativeOwnerUpgrade(request('check'), dependencies);
    expect(checked).toMatchObject({ distribution: 'native', status: 'update-available', owner: 'direct', targetVersion: '0.14.0', completedEffects: [] });
    expect(nativeUpgradeExitCode(checked)).toBe(2);
    expect(await snapshot(value.store.baseDirectory)).toEqual(before);
    const upgraded = await runNativeOwnerUpgrade(request('apply'), dependencies);
    expect(upgraded).toMatchObject({ status: 'upgraded', currentVersion: '0.13.0', targetVersion: '0.14.0', recoveryRequired: false });
    expect(nativeUpgradeExitCode(upgraded)).toBe(0);
    const receipt = await value.store.loadDirectReceipt(value.installRoot);
    expect(receipt?.version).toBe('0.14.0');
    await access(previous.versionRoot);
    expect(await snapshot(value.project)).toEqual(project);
  }, 90_000);

  it('keeps the current usable launcher after false candidate admission and permits a fresh owner-preserving retry', async () => {
    const value = await fixture('upgrade-false-candidate');
    const previous = await install(value);
    const dependencies = await newer(value, path.join(previous.versionRoot, 'dist', 'cli.js'));
    const launcherBefore = await readFile(value.launcher);
    const failed = await runNativeOwnerUpgrade(request('apply'), { ...dependencies, candidatePath: value.candidate });
    expect(failed).toMatchObject({ status: 'failed', owner: 'direct', recoveryRequired: true, completedEffects: [] });
    expect(await readFile(value.launcher)).toEqual(launcherBefore);
    expect((await value.store.loadDirectReceipt(value.installRoot))?.version).toBe('0.13.0');
    const checked = await runNativeOwnerUpgrade(request('check'), dependencies);
    expect(checked).toMatchObject({ status: 'blocked', reasonCode: 'recovery_required' });
    const retried = await runNativeOwnerUpgrade(request('apply'), dependencies);
    expect(retried).toMatchObject({ status: 'upgraded', targetVersion: '0.14.0', recoveryRequired: false });
    await access(previous.versionRoot);
    await value.store.assertNoPendingRecord();
  });

  it('preserves usable current bytes and all payloads on a locked-file-style handover failure', async () => {
    const value = await fixture('locked-handover');
    const previous = await install(value);
    const dependencies = await newer(value, path.join(previous.versionRoot, 'dist', 'cli.js'));
    const originalLauncher = await readFile(value.launcher);
    const directInstaller = new DirectInstallerAdapter({
      admission: dependencies.detector.admission, receiptStore: value.store, runner: value.runner, env: value.env, cwd: value.project,
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.phase === 'staged' && checkpoint.index === 1) throw new Error('EPERM: launcher is in use');
      }
    });
    const result = await runNativeOwnerUpgrade(request('apply'), { ...dependencies, directInstaller });
    expect(result).toMatchObject({ status: 'failed', owner: 'direct', recoveryRequired: true });
    expect(await readFile(value.launcher)).toEqual(originalLauncher);
    expect((await value.store.loadDirectReceipt(value.installRoot))?.version).toBe('0.13.0');
    await access(previous.versionRoot);
    const classified = nativeHandoverError(new Error('EBUSY: launcher is in use'), 'win32', value.launcher);
    expect(classified).toMatchObject({ reasonCode: 'locked_handover' });
    expect(classified.message).toContain('no force replacement');
    expect(nativeHandoverError(new Error('EACCES: private authority storage unavailable'), 'win32', value.launcher))
      .toMatchObject({ reasonCode: 'policy_blocked' });
    expect(value.runner.calls.some((call) => /(?:taskkill|killall|pkill)/i.test(call.command.executable))).toBe(false);
  });

  it('recovers a committed direct upgrade only after exact independent readback and preserves the original operation lineage', async () => {
    const value = await fixture('direct-committed-upgrade-recovery');
    const previous = await install(value);
    const dependencies = await newer(value, path.join(previous.versionRoot, 'dist', 'cli.js'));
    const directInstaller = new DirectInstallerAdapter({
      admission: dependencies.detector.admission, receiptStore: value.store, runner: value.runner, env: value.env, cwd: value.project,
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.phase === 'committed') throw new Error('readback interrupted after actual commit');
      }
    });
    const failed = await runNativeOwnerUpgrade(request('apply'), { ...dependencies, directInstaller });
    expect(failed).toMatchObject({
      status: 'failed', recoveryRequired: true, completedEffects: ['stage-candidate', 'install-target-owner']
    });
    const selected = await value.store.loadDirectReceipt(value.installRoot);
    expect(selected?.version).toBe('0.14.0');
    const detector = new InstallationDetector({
      admission: dependencies.detector.admission, runner: value.runner, receiptStore: value.store, env: value.env, cwd: value.project,
      entrypoint: path.join(selected!.versionRoot, 'dist', 'cli.js'), ownerAdapters: []
    });
    const before = await snapshot(value.store.baseDirectory);
    expect(await runNativeOwnerUpgrade(request('check'), { ...dependencies, detector }))
      .toMatchObject({ status: 'blocked', reasonCode: 'recovery_required' });
    expect(await snapshot(value.store.baseDirectory)).toEqual(before);
    const recovered = await runNativeOwnerUpgrade(request('apply'), { ...dependencies, detector });
    expect(recovered).toMatchObject({
      status: 'upgraded', targetVersion: '0.14.0', recoveryRequired: false,
      completedEffects: ['stage-candidate', 'install-target-owner', 'verify-target-installation']
    });
    expect(await value.store.loadDirectReceipt(value.installRoot)).toEqual(selected);
    const records = (await value.store.listInstallationRecords()).filter((entry) => 'operationId' in entry);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'completed', transaction: { committed: true, cleanupFailures: [] } });
    await access(previous.versionRoot);
    await value.store.assertNoPendingRecord();
  });

  it('does not turn unconfirmed replacement-process settlement into an automatic recovery success', async () => {
    const value = await fixture('direct-unconfirmed-upgrade-readback');
    const previous = await install(value);
    const dependencies = await newer(value, path.join(previous.versionRoot, 'dist', 'cli.js'));
    value.runner.afterRun = async (command, result) => command.executable === value.launcher
      ? { ...result, processTreeSettled: false } : result;
    const failed = await runNativeOwnerUpgrade(request('apply'), dependencies);
    expect(failed).toMatchObject({
      status: 'failed', recoveryRequired: true, completedEffects: ['stage-candidate', 'install-target-owner'],
      uncertainEffects: ['verify-target-installation']
    });
    const record = (await value.store.listInstallationRecords()).find((entry) => 'operationId' in entry);
    expect(record).toMatchObject({ processSettlement: 'unconfirmed', transaction: { committed: true, processSettlement: 'unconfirmed' } });
    const selected = await value.store.loadDirectReceipt(value.installRoot);
    const detector = new InstallationDetector({
      admission: dependencies.detector.admission, runner: value.runner, receiptStore: value.store, env: value.env, cwd: value.project,
      entrypoint: path.join(selected!.versionRoot, 'dist', 'cli.js'), ownerAdapters: []
    });
    value.runner.afterRun = undefined;
    const calls = value.runner.calls.length;
    expect(await runNativeOwnerUpgrade(request('apply'), { ...dependencies, detector }))
      .toMatchObject({ status: 'blocked', reasonCode: 'recovery_required' });
    expect(value.runner.calls).toHaveLength(calls);
    expect((await value.store.listInstallationRecords()).find((entry) => 'operationId' in entry)).toEqual(record);
    await access(previous.versionRoot);
  });

  it('enforces the selected expiry through receipt/launcher activation rather than only before staging', async () => {
    const value = await fixture('direct-activation-expiry');
    const previous = await install(value);
    const dependencies = await newer(value, path.join(previous.versionRoot, 'dist', 'cli.js'));
    const originalLauncher = await readFile(value.launcher);
    let now = Date.parse('2026-09-14T00:10:00.000Z');
    const directInstaller = new DirectInstallerAdapter({
      admission: dependencies.detector.admission, receiptStore: value.store, runner: value.runner, env: value.env, cwd: value.project,
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.phase === 'after-mutation' && checkpoint.index === 0) now += 30 * 60_000;
      }
    });
    const result = await runNativeOwnerUpgrade(request('apply'), { ...dependencies, directInstaller, now: () => new Date(now) });
    expect(result).toMatchObject({ status: 'failed', recoveryRequired: true, completedEffects: ['stage-candidate'] });
    expect(await value.store.loadDirectReceipt(value.installRoot)).toEqual(previous);
    expect(await readFile(value.launcher)).toEqual(originalLauncher);
    await access(previous.versionRoot);
  });

  it('rechecks private receipt authority after the final explicit invocation and never restores over changed owner bytes', async () => {
    const value = await fixture('direct-final-receipt-authority-readback');
    const previous = await install(value);
    const dependencies = await newer(value, path.join(previous.versionRoot, 'dist', 'cli.js'));
    let explicitCalls = 0;
    const receiptFile = path.join(value.installRoot, 'liftoff-receipt.json');
    value.runner.afterRun = async (command, result) => {
      if (command.executable === value.launcher && ++explicitCalls === 2) {
        const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
        await writeFile(receiptFile, JSON.stringify({ ...receipt, installedAt: '2026-09-14T01:00:00.000Z' }));
      }
      return result;
    };
    const result = await runNativeOwnerUpgrade(request('apply'), dependencies);
    expect(result).toMatchObject({
      status: 'failed', recoveryRequired: true, completedEffects: ['stage-candidate', 'install-target-owner']
    });
    await expect(value.store.loadDirectReceipt(value.installRoot)).rejects.toThrow(/private installation authority/);
    expect(JSON.parse(await readFile(receiptFile, 'utf8')).installedAt).toBe('2026-09-14T01:00:00.000Z');
    await access(previous.versionRoot);
  });

  it('materializes and probes a signed manager target before any owner upgrade command', async () => {
    const value = await fixture('manager-runtime-preflight', {
      beforeSigning: async (bundleRoot) => {
        const info = validateNativeBuildInfo(JSON.parse(await readFile(path.join(bundleRoot, 'build-info.json'), 'utf8')));
        if (info.version === '0.14.0') {
          await writeFile(path.join(bundleRoot, 'dist', 'cli.js'), 'process.stdout.write("Liftoff 9.9.9\\n");\n');
        }
      }
    }, signedHomebrewFixture);
    const manager = await homebrewFixture(value);
    const plan = await planInstallationMigration({
      toOwner: 'homebrew-cask', detector: manager.detector, receiptStore: value.store, runner: value.runner,
      candidatePath: value.candidate, now: value.reviewNow
    });
    const installed = await executeInstallationMigration({ plan, approvePlan: plan.planFingerprint });
    expect(installed.status, installed.failure?.message).toBe('completed');
    const currentBytes = await snapshot(manager.targetRoot);
    const launcherBytes = await readFile(value.legacyLauncher);

    const next = await value.registerRelease('0.14.0');
    const payload = next.manifest.targets[next.provenance.target];
    const binary = `liftoff-v0.14.0-${next.provenance.target}/bin/liftoff`;
    const definition = `cask "liftoff" do\n  version "0.14.0"\n  sha256 "${payload.checksumSha256}"\n  url "${payload.archiveUrl}"\n  binary "${binary}"\nend\n`;
    await writeFile(manager.definitionPath, definition);
    await manager.rewriteCask({
      version: '0.14.0', installed: '0.13.0', url: payload.archiveUrl,
      sha256: payload.checksumSha256, artifacts: [{ binary: [binary] }]
    });
    await value.resignProvenance({
      ...next.provenance,
      channelDefinitions: [{ owner: 'homebrew-cask', packageId: manager.packageId, sourceId: manager.sourceId, sha256: sha(definition) }]
    });
    const admission = new NativeAdmission({
      releaseClient: new NativeReleaseClient({
        source: value.source,
        trust: {
          ...value.trust, stableVersion: '0.14.0',
          channels: [...value.trust.channels, {
            owner: 'homebrew-cask', packageId: manager.packageId, sourceId: manager.sourceId, sourceUrl: manager.sourceUrl
          }]
        }
      }),
      runner: value.runner, env: value.env, cwd: value.project, host: value.admission.host
    });
    const adapter = new HomebrewAdapter({
      admission, runner: value.runner, env: value.env, cwd: value.project,
      executable: path.join(value.prefix, 'bin', 'brew')
    });
    const detector = new InstallationDetector({
      admission, runner: value.runner, env: value.env, cwd: value.project,
      entrypoint: path.join(manager.targetRoot, 'dist', 'cli.js'), receiptStore: value.store,
      npmAdapter: value.npmAdapter, ownerAdapters: [adapter]
    });
    const result = await runNativeOwnerUpgrade(request('apply'), {
      detector, runner: value.runner, receiptStore: value.store, now: value.reviewNow
    });
    expect(result).toMatchObject({ status: 'failed', owner: 'homebrew-cask', targetVersion: '0.14.0', completedEffects: [] });
    expect(value.runner.calls.some((call) => call.command.args[0] === 'upgrade')).toBe(false);
    expect(value.runner.calls.some((call) => call.command.executable.startsWith(path.join(value.store.baseDirectory, 'candidates') + path.sep))).toBe(true);
    expect(await snapshot(manager.targetRoot)).toEqual(currentBytes);
    expect(await readFile(value.legacyLauncher)).toEqual(launcherBytes);
    const record = (await value.store.listInstallationRecords()).find((entry) => 'operationId' in entry);
    if (!record || !('operationId' in record)) throw new Error('The actual candidate staging failure must remain recorded.');
    expect(record).toMatchObject({ status: 'failed', pendingEffectId: 'stage-candidate', processSettlement: 'settled' });
    for (const retained of record.retainedPaths) await access(retained);
  }, 90_000);
});
