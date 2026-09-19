import { afterEach, describe, expect, it } from 'vitest';
import { access, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertMigrationPlanCurrent, planInstallationMigration } from '../../src/application/distribution/plan-migration.js';
import { executeInstallationMigration } from '../../src/application/distribution/execute-migration.js';
import { withUserScopeMutationLock } from '../../src/adapters/filesystem/project-lock.js';
import { signedFixture, type SignedFixture } from './native-fixture.js';

const fixtures: SignedFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });
async function fixture(name: string) { const value = await signedFixture(name); fixtures.push(value); return value; }
const options = (value: SignedFixture) => ({
  toOwner: 'direct' as const, detector: value.detector, receiptStore: value.store, runner: value.runner,
  candidatePath: value.candidate, destinationDirectory: value.installRoot, launcherPath: value.launcher, now: value.reviewNow
});

describe('exact native operation admission under cooperating locks', () => {
  it('rebuilds a stable review-window fingerprint and refuses caller approval booleans', async () => {
    const value = await fixture('approval');
    const first = await planInstallationMigration(options(value));
    const second = await planInstallationMigration(options(value));
    expect(second.planFingerprint).toBe(first.planFingerprint);
    const untrusted = { plan: first, approved: true };
    await expect(executeInstallationMigration(untrusted)).rejects.toThrow(/approval booleans/);
    await expect(executeInstallationMigration({ plan: first, approvePlan: 'a'.repeat(64) })).rejects.toThrow(/does not match/);
    await expect(executeInstallationMigration({ plan: { ...first }, approvePlan: first.planFingerprint })).rejects.toThrow(/internally prepared/);
    await access(value.legacyLauncher);
    await expect(access(value.store.baseDirectory)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('rejects stale npm metadata, exact tool bytes, and configured source before retirement', async () => {
    const value = await fixture('stale-tool-config');
    const first = await planInstallationMigration(options(value));
    const tool = path.join(value.home, 'tools', 'npm');
    const original = await readFile(tool);
    await writeFile(tool, Buffer.concat([original, Buffer.from('\n# changed tool\n')]));
    await expect(executeInstallationMigration({ plan: first, approvePlan: first.planFingerprint })).rejects.toThrow(/changed/);
    await writeFile(tool, original);
    const second = await planInstallationMigration(options(value));
    await writeFile(path.join(value.home, '.npmrc'), 'registry=https://approved.example/\n');
    await expect(executeInstallationMigration({ plan: second, approvePlan: second.planFingerprint })).rejects.toThrow(/changed/);
    expect(value.runner.calls.some((call) => call.command.args[0] === 'uninstall')).toBe(false);
  });

  it('invalidates directory identity and expiry rather than recomputing a different approved operation', async () => {
    const value = await fixture('stale-directory');
    let now = value.reviewNow();
    const first = await planInstallationMigration({ ...options(value), now: () => now });
    await chmod(path.dirname(value.launcher), 0o700);
    await expect(executeInstallationMigration({ plan: first, approvePlan: first.planFingerprint })).rejects.toThrow(/directory|mode/);
    const second = await planInstallationMigration({ ...options(value), now: () => now });
    now = new Date(Date.parse(second.expiresAt) - 1);
    await assertMigrationPlanCurrent(second);
    now = new Date(second.expiresAt);
    await expect(executeInstallationMigration({ plan: second, approvePlan: second.planFingerprint })).rejects.toThrow(/expired/);
    now = new Date(Date.parse(second.createdAt) - 1);
    await expect(executeInstallationMigration({ plan: second, approvePlan: second.planFingerprint })).rejects.toThrow(/clock/);
    now = new Date(Number.NaN);
    await expect(executeInstallationMigration({ plan: second, approvePlan: second.planFingerprint })).rejects.toThrow(/clock/);
    await access(value.legacyLauncher);
  });

  it('stops at exact expiry under the held lock after real staging and preserves the current installation', async () => {
    const value = await fixture('expiry-after-staging');
    let now = value.reviewNow();
    const plan = await planInstallationMigration({ ...options(value), now: () => now });
    const retirement = plan.orderedEffects.find((effect) => effect.id === 'retire-legacy-package');
    if (!retirement) throw new Error('The fixture plan must include exact legacy retirement.');
    const record = await executeInstallationMigration({
      plan, approvePlan: plan.planFingerprint,
      onProgress: async (step) => { if (step === retirement.step) now = new Date(plan.expiresAt); }
    });
    expect(record.status).toBe('failed');
    expect(record.failure?.message).toContain('expired');
    expect(record.completedEffects).toEqual(['verify-unlinked-candidate', 'stage-target']);
    expect(value.runner.calls.some((call) => call.command.args[0] === 'uninstall')).toBe(false);
    expect((await value.store.loadMigrationRecord(record.migrationId))?.completedEffects).toEqual(record.completedEffects);
    await access(value.packageRoot);
    await access(value.legacyLauncher);
    await expect(access(value.launcher)).rejects.toHaveProperty('code', 'ENOENT');
    expect(record.retainedPaths.length).toBeGreaterThan(1);
    for (const retained of record.retainedPaths) await access(retained);
  });

  it('preserves another writer’s lock and every cross-command unfinished record', async () => {
    const value = await fixture('lock-and-journal');
    const first = await planInstallationMigration(options(value));
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = withUserScopeMutationLock(value.home, async () => { entered(); await gate; });
    await started;
    try {
      await expect(executeInstallationMigration({ plan: first, approvePlan: first.planFingerprint })).rejects.toThrow(/mutation.*progress|mutation.*blocks/);
    } finally { release(); await held; }
    await mkdir(path.join(value.home, '.liftoff'), { recursive: true });
    for (const name of ['reviewed-update-transaction.json', 'reviewed-repair-transaction.json', 'reviewed-adoption-transaction.json', 'reviewed-skills-transaction.json']) {
      const file = path.join(value.home, '.liftoff', name);
      await writeFile(file, `original ${name}`);
      await expect(planInstallationMigration(options(value))).rejects.toThrow(/unfinished cooperating transaction/);
      expect(await readFile(file, 'utf8')).toBe(`original ${name}`);
      await rename(file, `${file}.retained`);
    }
    await access(value.legacyLauncher);
  });

  it.each(['before-preview', 'before-retirement'] as const)('preserves a non-PATH direct launcher conflict %s', async (when) => {
    const value = await fixture(`non-path-direct-${when}`);
    const launcher = path.join(value.home, 'not on PATH', 'liftoff');
    await mkdir(path.dirname(launcher));
    const foreign = () => writeFile(launcher, 'foreign owner\n', { mode: 0o755 });
    if (when === 'before-preview') {
      await foreign();
      await expect(planInstallationMigration({ ...options(value), launcherPath: launcher })).rejects.toThrow(/outside PATH/);
    } else {
      const plan = await planInstallationMigration({ ...options(value), launcherPath: launcher });
      const record = await executeInstallationMigration({
        plan, approvePlan: plan.planFingerprint,
        onProgress: async (step) => { if (step === 3) await foreign(); }
      });
      expect(record.status).toBe('failed');
      expect(record.failure?.message).toContain('before legacy retirement');
      expect(record.completedEffects).not.toContain('retire-legacy-package');
    }
    expect(await readFile(launcher, 'utf8')).toBe('foreign owner\n');
    expect(value.runner.calls.some((call) => call.command.args[0] === 'uninstall')).toBe(false);
    await access(value.legacyLauncher);
  });
});
