import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import { computePlanFingerprint, parseMigrationPlan, verifyPlanIntegrity } from '../../src/domain/distribution/migration-plan.js';
import { createInitialMigrationRecord, parseMigrationRecord, recordMigrationFailure, recordMigrationSuccess, updateRecordCheckpoint } from '../../src/domain/distribution/migration-record.js';
import { ReceiptStore } from '../../src/adapters/distribution/receipt-store.js';
import { validPlan } from './manifest-fixture.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function store() {
  const root = path.resolve('tests', `.native-record-${randomUUID()}`);
  roots.push(root);
  await mkdir(root, { mode: 0o700 });
  return new ReceiptStore({ env: { HOME: root }, homedir: root, baseDirectory: path.join(root, '.liftoff', 'installation') });
}

describe('independent immutable migration identity', () => {
  it('uses recursive canonical fingerprints including expiry and full nested effects', () => {
    const plan = validPlan();
    expect(verifyPlanIntegrity(plan)).toBe(true);
    expect(Object.isFrozen(plan.orderedEffects[0])).toBe(true);
    const { planFingerprint, ...fields } = plan;
    expect(computePlanFingerprint(fields)).toBe(planFingerprint);
    expect(computePlanFingerprint({ ...fields, expiresAt: '2026-09-14T00:29:00.000Z' })).not.toBe(planFingerprint);
    expect(canonicalJson({ nested: { z: 1, a: 2 } })).toBe(canonicalJson({ nested: { a: 2, z: 1 } }));
  });

  it.each(['targetInstallation', 'legacyInstallation', 'orderedEffects', 'legacyRecovery'] as const)('rejects altered registered %s', (field) => {
    const plan = validPlan();
    const modified = { ...plan, [field]: {} };
    expect(() => parseMigrationPlan(modified)).toThrow();
  });

  it('does not accept a rehashed arbitrary effect or lost historical identity', () => {
    const plan = validPlan();
    const { planFingerprint: _old, ...fields } = plan;
    const changed = { ...fields, orderedEffects: [{ step: 1, id: 'remove-node', critical: true, description: 'unsafe' }] };
    expect(() => parseMigrationPlan({ ...changed, planFingerprint: computePlanFingerprint(changed) })).toThrow(/registered ordered effects/);
    expect(() => parseMigrationPlan({ ...plan, legacyInstallation: { ...plan.legacyInstallation, installedVersion: undefined } })).toThrow();
  });

  it('keeps the last observed checkpoint on failure and refuses incomplete success claims', () => {
    const plan = validPlan();
    const initial = createInitialMigrationRecord(plan);
    const removed = updateRecordCheckpoint(initial, 'legacy-retired', 'retire-legacy-package');
    const failed = recordMigrationFailure(removed, { effectId: 'install-target-owner', message: 'failed', timestamp: new Date().toISOString() });
    expect(failed.checkpoint).toBe('legacy-retired');
    expect(failed.completedEffects).toEqual(['retire-legacy-package']);
    expect(() => recordMigrationSuccess(failed, { explicitPathVerified: true, pathResolutionVerified: false, resourcesVerified: true })).toThrow();
    expect(() => parseMigrationRecord({ ...failed, schemaVersion: 3 })).toThrow();
    expect(() => parseMigrationRecord({ ...failed, status: 'completed' })).toThrow();
  });
});

describe('durable private installation records', () => {
  it('appends sealed revisions and refuses changed or truncated record history', async () => {
    const value = await store();
    const initial = createInitialMigrationRecord(validPlan());
    const first = await value.saveMigrationRecord(initial);
    const second = await value.saveMigrationRecord(updateRecordCheckpoint(first, 'candidate-verified', 'verify-unlinked-candidate'));
    expect(second.revision).toBe(1);
    expect(second.previousDigest).toBe(canonicalSha256(first));
    expect(await value.loadMigrationRecord(initial.migrationId)).toEqual(second);
    const file = path.join(value.migrationRecordsDirectory, initial.migrationId, '000000.json');
    await writeFile(file, (await readFile(file, 'utf8')).replace('in_progress', 'failed'));
    await expect(value.loadMigrationRecord(initial.migrationId)).rejects.toThrow(/seal|chain/);
  });

  it('does not skip corrupt records or clear unfinished records for a new writer', async () => {
    const value = await store();
    const record = await value.saveMigrationRecord(createInitialMigrationRecord(validPlan()));
    await expect(value.assertNoPendingRecord()).rejects.toThrow(/unfinished/);
    const file = path.join(value.migrationRecordsDirectory, record.migrationId, '000000.json');
    const before = await readFile(file);
    await expect(value.loadMigrationRecord('../foreign')).rejects.toThrow(/UUID/);
    expect(await readFile(file)).toEqual(before);
    await writeFile(path.join(value.migrationRecordsDirectory, 'unknown.json'), '{}');
    await expect(value.loadLatestMigrationRecord()).rejects.toThrow(/unknown/);
    expect((await readdir(value.migrationRecordsDirectory))).toContain(record.migrationId);
  });
});
