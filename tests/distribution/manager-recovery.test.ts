import { access, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planInstallationMigration } from '../../src/application/distribution/plan-migration.js';
import { executeInstallationMigration } from '../../src/application/distribution/execute-migration.js';
import { inspectMigrationRecovery } from '../../src/application/distribution/recover-migration.js';
import { verifyManagerReplacement } from '../../src/application/distribution/verify-manager.js';
import { homebrewFixture } from './manager-fixture.js';
import { readTree, sha, signedFixture, type SignedFixture } from './native-fixture.js';

const fixtures: SignedFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });
async function fixture(name: string) {
  const value = await signedFixture(name);
  fixtures.push(value);
  const manager = await homebrewFixture(value);
  const plan = await planInstallationMigration({
    toOwner: 'homebrew-cask', detector: manager.detector, receiptStore: value.store,
    candidatePath: value.candidate, now: value.reviewNow
  });
  return { value, manager, plan };
}

describe('manager cutover recovery with actual local launcher execution', () => {
  it.each(['before-readback', 'manager-failure-after-install'] as const)(
    'reobserves %s and requires fresh approval without repeating completed owner effects',
    async (failure) => {
      const { value, manager, plan } = await fixture(`manager-recover-${failure}`);
      if (failure === 'manager-failure-after-install') {
        value.runner.afterRun = async (command, result) => command.args[0] === 'install'
          ? { ...result, status: 17 } : result;
      }
      const original = await executeInstallationMigration({
        plan, approvePlan: plan.planFingerprint,
        onProgress: async (step) => {
          if (failure === 'before-readback' && plan.orderedEffects[step - 1].id === 'verify-target-installation') {
            throw new Error('Interrupted before independent replacement readback.');
          }
        }
      });
      expect(original).toMatchObject({ status: 'failed', processSettlement: 'settled' });
      expect(original.completedEffects).toContain('retire-legacy-package');
      expect(original.verification).toBeUndefined();
      if (failure === 'manager-failure-after-install') expect(original.uncertainEffects).toContain('install-target-owner');
      value.runner.afterRun = undefined;
      const before = (await readTree(value.home)).map((entry) => ({ path: entry.path, sha: sha(entry.bytes), mode: entry.mode }));
      const inspection = await inspectMigrationRecovery({ detector: manager.detector, receiptStore: value.store, now: value.reviewNow });
      expect(inspection, inspection.issues.join('\n')).toMatchObject({
        isRecoverable: true, currentOwner: 'homebrew-cask', legacyPackage: 'absent', launcher: 'replacement'
      });
      expect((await readTree(value.home)).map((entry) => ({ path: entry.path, sha: sha(entry.bytes), mode: entry.mode }))).toEqual(before);
      const retry = inspection.proposedPlan!;
      expect(retry.recovery).toMatchObject({ sourceRetired: true, targetInstalled: true });
      expect(retry.orderedEffects.map((effect) => effect.id)).toEqual(['verify-unlinked-candidate', 'verify-target-installation']);
      await expect(executeInstallationMigration({ plan: retry, approvePlan: plan.planFingerprint })).rejects.toThrow(/does not match/);
      const completed = await executeInstallationMigration({ plan: retry, approvePlan: retry.planFingerprint });
      expect(completed.status, completed.failure?.message).toBe('completed');
      expect(value.runner.calls.filter((call) => ['install', 'uninstall'].includes(call.command.args[0]))
        .map((call) => call.command.args[0])).toEqual(['uninstall', 'install']);
      expect(value.runner.calls.filter((call) => call.command.executable === manager.launcherPath).length).toBe(2);
      expect(await value.store.loadMigrationRecord(original.migrationId)).toEqual(original);
    }
  );

  it('refuses a changed installed payload after interruption instead of reinstalling over it', async () => {
    const { value, manager, plan } = await fixture('manager-recovery-changed-payload');
    await executeInstallationMigration({
      plan, approvePlan: plan.planFingerprint,
      onProgress: async (step) => { if (step === 5) throw new Error('Interrupted before readback.'); }
    });
    const cli = path.join(manager.targetRoot, 'dist', 'cli.js');
    await writeFile(cli, 'changed owner content\n');
    const recovery = await inspectMigrationRecovery({ detector: manager.detector, receiptStore: value.store, now: value.reviewNow });
    expect(recovery.isRecoverable).toBe(false);
    expect(recovery.proposedPlan).toBeUndefined();
    expect(await readFile(cli, 'utf8')).toBe('changed owner content\n');
    expect(value.runner.calls.filter((call) => call.command.args[0] === 'install')).toHaveLength(1);
  });

  it('blocks an occupied manager destination before removing legacy Liftoff', async () => {
    const { value, manager } = await fixture('manager-occupied-destination');
    await mkdir(manager.targetRoot, { recursive: true });
    const foreign = path.join(manager.targetRoot, 'foreign');
    await writeFile(foreign, 'preserve\n');
    await expect(planInstallationMigration({
      toOwner: 'homebrew-cask', detector: manager.detector, candidatePath: value.candidate, now: value.reviewNow
    })).rejects.toThrow(/occupied/);
    expect(await readFile(foreign, 'utf8')).toBe('preserve\n');
    expect(value.runner.calls.some((call) => call.command.args[0] === 'uninstall')).toBe(false);
    await access(value.legacyLauncher);
  });

  it.each(['0.12.3', '0.13.0'])('preserves an existing manager owner claiming %s before npm retirement', async (installed) => {
    const { value, manager } = await fixture(`manager-existing-${installed}`);
    await manager.rewriteCask({ installed });
    await expect(planInstallationMigration({
      toOwner: 'homebrew-cask', detector: manager.detector, candidatePath: value.candidate, now: value.reviewNow
    })).rejects.toThrow();
    expect(value.runner.calls.some((call) => ['install', 'uninstall'].includes(call.command.args[0]))).toBe(false);
    await access(value.legacyLauncher);
  });

  it('blocks a non-PATH manager launcher conflict before legacy removal', async () => {
    const value = await signedFixture('manager-non-path-conflict');
    fixtures.push(value);
    const manager = await homebrewFixture(value, true, path.join(value.home, 'other manager prefix'));
    await writeFile(manager.launcherPath, 'foreign launcher\n', { mode: 0o755 });
    await expect(planInstallationMigration({
      toOwner: 'homebrew-cask', detector: manager.detector, candidatePath: value.candidate, now: value.reviewNow
    })).rejects.toThrow(/outside PATH/);
    expect(await readFile(manager.launcherPath, 'utf8')).toBe('foreign launcher\n');
    expect(value.runner.calls.some((call) => call.command.args[0] === 'uninstall')).toBe(false);
    await access(value.legacyLauncher);
  });

  it('rechecks an occupied destination immediately before retirement', async () => {
    const { value, manager, plan } = await fixture('manager-late-destination-conflict');
    const result = await executeInstallationMigration({
      plan, approvePlan: plan.planFingerprint,
      onProgress: async (step) => { if (step === 3) await mkdir(manager.targetRoot, { recursive: true }); }
    });
    expect(result.status).toBe('failed');
    expect(result.completedEffects).not.toContain('retire-legacy-package');
    expect(value.runner.calls.some((call) => call.command.args[0] === 'uninstall')).toBe(false);
    await access(value.legacyLauncher);
  });

  it('binds manager destination-directory identity into machine approval', async () => {
    const { value, manager, plan } = await fixture('manager-destination-fingerprint');
    await mkdir(path.dirname(manager.targetRoot), { recursive: true });
    const changed = await planInstallationMigration({
      toOwner: 'homebrew-cask', detector: manager.detector, candidatePath: value.candidate, now: value.reviewNow
    });
    expect(changed.planFingerprint).not.toBe(plan.planFingerprint);
    await expect(executeInstallationMigration({ plan: changed, approvePlan: plan.planFingerprint })).rejects.toThrow(/does not match/);
    expect(value.runner.calls.some((call) => call.command.args[0] === 'uninstall')).toBe(false);
    await access(value.legacyLauncher);
  });

  it('does not substitute successful payload execution for a failing owner launcher', async () => {
    const { value, manager, plan } = await fixture('manager-actual-launcher-failure');
    value.runner.afterRun = async (command, result) => command.executable === manager.launcherPath
      ? { ...result, stdout: 'Liftoff 0.12.3\n' } : result;
    const result = await executeInstallationMigration({ plan, approvePlan: plan.planFingerprint });
    expect(result.status).toBe('failed');
    expect(result.completedEffects).toContain('install-target-owner');
    expect(result.verification).toBeUndefined();
    expect(result.failure?.message).toContain('actual owner launcher');
  });

  it('refuses a different ordinary PATH installation without executing it', async () => {
    const { value, manager, plan } = await fixture('manager-path-substitution');
    const result = await executeInstallationMigration({ plan, approvePlan: plan.planFingerprint });
    expect(result.status, result.failure?.message).toBe('completed');
    const candidate = await manager.admission.admitBundle(value.candidate);
    const selection = await manager.adapter.select(candidate, 'install');
    await writeFile(value.launcher, '#!/bin/sh\nprintf "Liftoff 0.13.0\\n"\n', { mode: 0o755 });
    await expect(verifyManagerReplacement(manager.admission, manager.detector, manager.adapter, selection, candidate.provenanceDigest))
      .rejects.toThrow(/Ordinary command resolution/);
    expect(value.runner.calls.some((call) => call.command.executable === value.launcher)).toBe(false);
    await unlink(value.launcher);
  });

  it('rejects changed and escaped owner links without adopting their replacement', async () => {
    const { value, manager, plan } = await fixture('manager-link-race');
    const result = await executeInstallationMigration({ plan, approvePlan: plan.planFingerprint });
    expect(result.status, result.failure?.message).toBe('completed');
    const candidate = await manager.admission.admitBundle(manager.targetRoot);
    await writeFile(value.launcher, 'foreign payload\n', { mode: 0o755 });
    value.runner.afterRun = async (command, observed) => {
      if (command.executable === manager.launcherPath) {
        await unlink(manager.launcherPath);
        await symlink(value.launcher, manager.launcherPath);
      }
      return observed;
    };
    await expect(manager.admission.probeLinkedLauncher(candidate, manager.launcherPath)).rejects.toThrow(/actual owner launcher changed/);
    value.runner.afterRun = undefined;
    const calls = value.runner.calls.length;
    await expect(manager.admission.probeLinkedLauncher(candidate, manager.launcherPath)).rejects.toThrow(/exact admitted native entrypoint/);
    expect(value.runner.calls).toHaveLength(calls);
    expect(await readFile(value.launcher, 'utf8')).toBe('foreign payload\n');
  });
});
