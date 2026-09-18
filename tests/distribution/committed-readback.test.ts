import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeAdmission } from '../../src/adapters/distribution/native-admission.js';
import { InstallationDetector } from '../../src/adapters/distribution/installation-detector.js';
import { NpmInstallationAdapter } from '../../src/adapters/distribution/npm-installation.js';
import { DirectInstallerAdapter } from '../../src/adapters/distribution/direct-installer-adapter.js';
import { planInstallationMigration } from '../../src/application/distribution/plan-migration.js';
import { executeInstallationMigration } from '../../src/application/distribution/execute-migration.js';
import { parseNativeTransactionOutcome } from '../../src/domain/distribution/transaction-outcome.js';
import { signedFixture, type SignedFixture } from './native-fixture.js';

const fixtures: SignedFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

describe('native committed readback before journal cleanup', () => {
  it('retains the committed journal and actual outcome until the exact ordinary launcher verifies', async () => {
    const value = await signedFixture('committed-readback');
    fixtures.push(value);
    const higher = path.join(value.home, 'higher priority');
    const foreign = path.join(higher, 'liftoff');
    await mkdir(higher);
    const env = { ...value.env, PATH: `${higher}${path.delimiter}${value.env.PATH}` };
    const admission = new NativeAdmission({ releaseClient: value.client, env, cwd: value.project, runner: value.runner });
    const npmAdapter = new NpmInstallationAdapter({ env, cwd: value.project, runner: value.runner, npmExecutable: path.join(value.home, 'tools', 'npm') });
    const detector = new InstallationDetector({
      admission, env, cwd: value.project, runner: value.runner, npmAdapter,
      receiptStore: value.store, ownerAdapters: [], entrypoint: path.join(value.candidate, 'dist', 'cli.js')
    });
    const direct = new DirectInstallerAdapter({
      admission, env, cwd: value.project, runner: value.runner, receiptStore: value.store,
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.phase === 'committed') await writeFile(foreign, 'Unrelated launcher must not execute.\n', { mode: 0o755 });
      }
    });
    const plan = await planInstallationMigration({
      toOwner: 'direct', detector, directInstaller: direct, receiptStore: value.store, runner: value.runner,
      candidatePath: value.candidate, destinationDirectory: value.installRoot, launcherPath: value.launcher, now: value.reviewNow
    });
    const failed = await executeInstallationMigration({ plan, approvePlan: plan.planFingerprint });
    expect(failed.status).toBe('failed');
    expect(failed.checkpoint).toBe('target-installed');
    expect(failed.transaction).toMatchObject({ status: 'committed', committed: true, processSettlement: 'settled', rollbackFailures: [] });
    expect(failed.transaction?.cleanupFailures.join(' ')).toContain('ordinary PATH selects another launcher');
    expect((await value.store.loadMigrationRecord(failed.migrationId))?.transaction).toEqual(failed.transaction);
    expect((await direct.inspectRecovery(plan.transactionRoot)).status).toBe('committed');
    expect(value.runner.calls.some((call) => call.command.executable === foreign)).toBe(false);

    const blocked = await direct.recoverOriginalTransaction(plan.transactionRoot, plan.planFingerprint);
    expect(blocked).toMatchObject({ status: 'committed', committed: true });
    expect(blocked.cleanupFailures.length).toBeGreaterThan(0);
    expect((await direct.inspectRecovery(plan.transactionRoot)).status).toBe('committed');
    expect(await readFile(foreign, 'utf8')).toContain('Unrelated launcher');

    await unlink(foreign);
    const finalized = await direct.recoverOriginalTransaction(plan.transactionRoot, plan.planFingerprint);
    expect(finalized).toMatchObject({ status: 'committed', committed: true, rollbackFailures: [], cleanupFailures: [], processSettlement: 'settled' });
    expect((await direct.inspectRecovery(plan.transactionRoot)).status).toBe('absent');
    expect((await value.store.loadDirectReceipt(value.installRoot))?.version).toBe('0.13.0');
  });

  it('rejects inconsistent or unregistered transaction outcome facts', () => {
    const valid = { status: 'committed', committed: true, rollbackFailures: [], cleanupFailures: [], processSettlement: 'settled' };
    expect(parseNativeTransactionOutcome(valid).committed).toBe(true);
    expect(() => parseNativeTransactionOutcome({ ...valid, committed: false })).toThrow();
    expect(() => parseNativeTransactionOutcome({ ...valid, status: 'successful' })).toThrow();
    expect(() => parseNativeTransactionOutcome({ ...valid, status: 'rolled-back' })).toThrow();
    expect(() => parseNativeTransactionOutcome({ ...valid, processSettlement: 'assumed' })).toThrow();
    expect(() => parseNativeTransactionOutcome({ ...valid, cleanupFailures: 'none' })).toThrow();
  });
});
