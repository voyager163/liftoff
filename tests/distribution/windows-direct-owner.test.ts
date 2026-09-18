import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planInstallationMigration } from '../../src/application/distribution/plan-migration.js';
import { executeInstallationMigration } from '../../src/application/distribution/execute-migration.js';
import { InstallationDetector } from '../../src/adapters/distribution/installation-detector.js';
import { DistributionError } from '../../src/domain/distribution/errors.js';
import { signedFixture, type SignedFixture } from './native-fixture.js';

const fixtures: SignedFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

describe('default Windows owner-observer routing source fixture, not Windows execution', () => {
  it('does not let unavailable WinGet observation veto a privately proved direct owner, but retains explicit conflict checks', async () => {
    const value = await signedFixture('windows-direct-observer-routing');
    fixtures.push(value);
    const plan = await planInstallationMigration({
      toOwner: 'direct', detector: value.detector, receiptStore: value.store, runner: value.runner,
      candidatePath: value.candidate, destinationDirectory: value.installRoot, launcherPath: value.launcher,
      now: value.reviewNow
    });
    const installed = await executeInstallationMigration({ plan, approvePlan: plan.planFingerprint });
    expect(installed.status, installed.failure?.message).toBe('completed');
    const receipt = await value.store.loadDirectReceipt(value.installRoot);
    if (!receipt) throw new Error('The routing fixture must first establish real private direct authority.');
    const calls = value.runner.calls.length;

    // Only the default-observer choice is simulated; signed admission and filesystem receipt checks stay on the actual host.
    const observerHostView = new Proxy(value.admission, {
      get(target, property) {
        if (property === 'host') return Object.freeze({ ...target.host, os: 'win32', windowsBuild: 17763 });
        const member = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      }
    });
    const options = {
      admission: observerHostView, receiptStore: value.store, runner: value.runner, env: value.env, cwd: value.project,
      entrypoint: path.join(receipt.versionRoot, 'dist', 'cli.js'), npmAdapter: value.npmAdapter
    };
    const detector = new InstallationDetector(options);
    expect(detector.ownerAdapters.map((adapter) => adapter.owner)).toEqual(['winget']);
    const observer = vi.spyOn(detector.ownerAdapters[0], 'observeInstallation').mockRejectedValue(
      new DistributionError('Read-only WinGet observation is unavailable in this source-routing fixture.', 'implementation_missing')
    );
    expect((await detector.observeInstallation()).result).toMatchObject({ status: 'healthy', installation: { owner: 'direct' } });
    expect(observer).not.toHaveBeenCalled();
    expect(value.runner.calls).toHaveLength(calls);

    observer.mockResolvedValue({
      owner: 'winget', packageId: 'source-fixture-only', version: receipt.version, prefix: receipt.installRoot,
      payloadRoot: receipt.versionRoot, launcherPath: receipt.launcherPath, sourceId: 'source-fixture-only',
      evidenceDigest: 'a'.repeat(64)
    });
    const explicitObserver = new InstallationDetector({ ...options, ownerAdapters: detector.ownerAdapters });
    await expect(explicitObserver.observeInstallation()).rejects.toMatchObject({ reasonCode: 'ownership_conflict' });
    expect(observer).toHaveBeenCalledTimes(1);

    observer.mockRejectedValue(new DistributionError('Required read-only WinGet interface is absent.', 'implementation_missing'));
    const unlinked = new InstallationDetector({
      ...options, entrypoint: path.join(value.candidate, 'dist', 'cli.js')
    });
    const unlinkedObserver = vi.spyOn(unlinked.ownerAdapters[0], 'observeInstallation').mockRejectedValue(
      new DistributionError('Required read-only WinGet interface is absent.', 'implementation_missing')
    );
    await expect(unlinked.observeInstallation()).rejects.toMatchObject({ reasonCode: 'implementation_missing' });
    expect(unlinkedObserver).toHaveBeenCalledTimes(1);
    expect(value.runner.calls).toHaveLength(calls);
    expect(await value.store.loadDirectReceipt(value.installRoot)).toEqual(receipt);
  });
});
