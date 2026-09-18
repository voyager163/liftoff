import { afterEach, describe, expect, it } from 'vitest';
import { access, chmod, readFile, writeFile } from 'node:fs/promises';
import { nativeProbeEnvironment } from '../../src/adapters/distribution/native-admission.js';
import { assertNoConflictingTransactions, ConflictingTransactionError } from '../../src/application/execution/cross-writers.js';
import { writeFixtureFile } from './native-fixture.js';
import path from 'node:path';
import { planInstallationMigration } from '../../src/application/distribution/plan-migration.js';
import { executeInstallationMigration } from '../../src/application/distribution/execute-migration.js';
import { inspectMigrationRecovery } from '../../src/application/distribution/recover-migration.js';
import { signedFixture, readTree, type SignedFixture } from './native-fixture.js';

const fixtures: SignedFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });
async function fixture(name: string) { const value = await signedFixture(name); fixtures.push(value); return value; }
async function plan(value: SignedFixture) {
  return planInstallationMigration({
    toOwner: 'direct', detector: value.detector, receiptStore: value.store, runner: value.runner,
    candidatePath: value.candidate, destinationDirectory: value.installRoot, launcherPath: value.launcher, now: value.reviewNow
  });
}

describe('registered native filesystem handover', () => {
  it('admits and probes a real signed runtime only after final-byte and host checks', async () => {
    const value = await fixture('actual-probe');
    const candidate = await value.admission.admitBundle(value.candidate);
    expect(value.runner.calls).toHaveLength(0);
    await value.admission.probe(candidate);
    expect(value.runner.calls.map((call) => call.command.executable)).toEqual([
      path.join(value.candidate, 'runtime', 'node'), path.join(value.candidate, 'runtime', 'node'),
      path.join(value.candidate, 'bin', 'liftoff')
    ]);
  });

  it('executes an exact filesystem cutover and preserves project, dependencies, locks and history', async () => {
    const value = await fixture('actual-cutover');
    const before = await readTree(value.project);
    const reviewed = await plan(value);
    await expect(access(value.store.baseDirectory)).rejects.toHaveProperty('code', 'ENOENT');
    const record = await executeInstallationMigration({ plan: reviewed, approvePlan: reviewed.planFingerprint, json: true });
    expect(record.status, record.failure?.message).toBe('completed');
    expect(record.completedEffects).toContain('retire-legacy-package');
    expect(record.verification).toMatchObject({ explicitPathVerified: true, pathResolutionVerified: true, observedVersion: '0.13.0' });
    await expect(access(value.packageRoot)).rejects.toHaveProperty('code', 'ENOENT');
    expect(await readTree(value.project)).toEqual(before);
    expect(await readFile(value.launcher, 'utf8')).toContain('/runtime/node');
    expect((await value.store.loadDirectReceipt(value.installRoot))?.version).toBe('0.13.0');
    const recovery = await inspectMigrationRecovery({ receiptStore: value.store, detector: value.detector });
    expect(recovery.record.status).toBe('completed');
  });

  it('rejects changed candidate bytes and modes without retirement or records', async () => {
    const value = await fixture('changed-mode');
    const reviewed = await plan(value);
    await chmod(path.join(value.candidate, 'dist', 'cli.js'), 0o600);
    await expect(executeInstallationMigration({ plan: reviewed, approvePlan: reviewed.planFingerprint })).rejects.toThrow(/bytes|modes|inventory/);
    await access(value.legacyLauncher);
    await expect(access(value.store.baseDirectory)).rejects.toHaveProperty('code', 'ENOENT');
    expect(value.runner.calls.some((call) => call.command.args[0] === 'uninstall')).toBe(false);
  });

  it('rejects final signed archive byte changes before any candidate execution', async () => {
    const value = await fixture('final-byte-change');
    const url = value.manifest.targets[value.provenance.target].archiveUrl;
    await writeFile(value.source.urls.get(url)!, 'changed after signing');
    await expect(value.admission.admitBundle(value.candidate)).rejects.toThrow(/checksum/);
    expect(value.runner.calls).toHaveLength(0);
  });

  it('does not execute an alternate candidate launcher or inherit Node code-injection options', async () => {
    const value = await fixture('candidate-execution-boundary');
    const candidate = await value.admission.admitBundle(value.candidate);
    await expect(value.admission.probe(candidate, value.legacyLauncher)).rejects.toThrow(/outside the admitted payload/);
    expect(value.runner.calls).toHaveLength(0);
    const env = nativeProbeEnvironment({ PATH: value.env.PATH, NODE_OPTIONS: '--require malicious.js', NODE_PATH: '/outside' });
    expect(Object.hasOwn(env, 'NODE_OPTIONS')).toBe(true);
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
  });

  it('keeps a native journal blocking other execution-kernel writers without changing it', async () => {
    const value = await fixture('cross-kernel-journal');
    const journal = path.join(value.home, '.liftoff', 'reviewed-installation-transaction.json');
    await writeFixtureFile(journal, 'unresolved original native record', 0o600);
    const blocked = assertNoConflictingTransactions(value.home, { currentCommand: 'update' });
    await expect(blocked).rejects.toBeInstanceOf(ConflictingTransactionError);
    await expect(blocked).rejects.toMatchObject({
      details: {
        kind: 'transaction', transactionKind: 'installation', conflictingPath: journal, currentCommand: 'update',
        continuation: undefined, recoveryCommand: undefined
      }
    });
    expect(await readFile(journal, 'utf8')).toBe('unresolved original native record');
    await access(value.legacyLauncher);
  });
});
