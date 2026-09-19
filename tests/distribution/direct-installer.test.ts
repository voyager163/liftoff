import { afterEach, describe, expect, it } from 'vitest';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { planInstallationMigration } from '../../src/application/distribution/plan-migration.js';
import { executeInstallationMigration } from '../../src/application/distribution/execute-migration.js';
import { inspectMigrationRecovery } from '../../src/application/distribution/recover-migration.js';
import { DirectInstallerAdapter } from '../../src/adapters/distribution/direct-installer-adapter.js';
import { signedFixture, type SignedFixture } from './native-fixture.js';

const fixtures: SignedFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });
async function fixture(name: string) { const value = await signedFixture(name); fixtures.push(value); return value; }
const options = (value: SignedFixture, launcher = value.launcher) => ({
  toOwner: 'direct' as const, detector: value.detector, receiptStore: value.store, runner: value.runner,
  candidatePath: value.candidate, destinationDirectory: value.installRoot, launcherPath: launcher, now: value.reviewNow
});

describe('receipt-owned staged native replacement', () => {
  it('performs the real conflicting npm-link handover in approved order, not forced copying', async () => {
    const value = await fixture('conflicting-link');
    const plan = await planInstallationMigration(options(value, value.legacyLauncher));
    const record = await executeInstallationMigration({ plan, approvePlan: plan.planFingerprint });
    expect(record.status, record.failure?.message).toBe('completed');
    expect(await readFile(value.legacyLauncher, 'utf8')).toContain('#!/bin/sh');
    const uninstall = value.runner.calls.findIndex((call) => call.command.args[0] === 'uninstall');
    const newLauncher = value.runner.calls.findIndex((call) => call.command.executable === value.legacyLauncher);
    expect(uninstall).toBeGreaterThan(0);
    expect(newLauncher).toBeGreaterThan(uninstall);
    expect(value.runner.calls.some((call) => call.command.args.some((arg) => arg === '--force' || arg === 'sudo'))).toBe(false);
    await access(value.candidate);
    await access(path.join(value.home, 'tools', 'npm'));
  });

  it('records removal followed by setup conflict, and a separately approved retry never repeats removal', async () => {
    const value = await fixture('partial-retry');
    const plan = await planInstallationMigration(options(value));
    const record = await executeInstallationMigration({
      plan, approvePlan: plan.planFingerprint,
      onProgress: async (step) => { if (step === 4) await writeFile(value.launcher, 'new owner content\n', { mode: 0o755 }); }
    });
    expect(record.status).toBe('failed');
    expect(record.completedEffects).toContain('retire-legacy-package');
    expect(record.checkpoint).toBe('legacy-retired');
    expect(await readFile(value.launcher, 'utf8')).toBe('new owner content\n');
    await expect(access(value.packageRoot)).rejects.toHaveProperty('code', 'ENOENT');
    const recovery = await inspectMigrationRecovery({ detector: value.detector, receiptStore: value.store });
    expect(recovery).toMatchObject({ legacyPackage: 'absent', launcher: 'changed', isRecoverable: false });
    await expect(planInstallationMigration(options(value))).rejects.toThrow(/already owned|different|launcher|owner/);
    await unlink(value.launcher);
    const retry = await planInstallationMigration(options(value));
    expect(retry.planFingerprint).not.toBe(plan.planFingerprint);
    expect(retry.recovery).toMatchObject({ migrationId: record.migrationId, sourceRetired: true });
    expect(retry.orderedEffects.some((effect) => effect.id === 'retire-legacy-package')).toBe(false);
    const completed = await executeInstallationMigration({ plan: retry, approvePlan: retry.planFingerprint });
    expect(completed.status, completed.failure?.message).toBe('completed');
    expect(value.runner.calls.filter((call) => call.command.args[0] === 'uninstall')).toHaveLength(1);
    await value.store.assertNoPendingRecord();
    for (const retained of record.retainedPaths) await access(retained);
  });

  it('does not execute, stage, or overwrite using a caller-authored candidate object', async () => {
    const value = await fixture('forged-candidate');
    const admitted = await value.admission.admitBundle(value.candidate);
    const adapter = new DirectInstallerAdapter({ admission: value.admission, receiptStore: value.store });
    await expect(adapter.select({
      candidate: { ...admitted }, installRoot: value.installRoot, launcherPath: value.launcher, intent: 'migrate'
    })).rejects.toThrow(/trusted native admission/);
    await expect(access(value.installRoot)).rejects.toHaveProperty('code', 'ENOENT');
    await access(value.legacyLauncher);
  });
});
