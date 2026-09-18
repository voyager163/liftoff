import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../governance/activation/canonical-json.js';
import type {
  InstallationMigrationPlan, InstallationMigrationRecord, MigrationCheckpoint, MigrationFailureFacts, MigrationVerificationFacts
} from './contracts.js';
import { DistributionError } from './errors.js';
import { parseMigrationPlan } from './migration-plan.js';
import { digest, integer, object, text, timestamp, uuidPattern } from './validation.js';
import { parseNativeTransactionOutcome } from './transaction-outcome.js';

export function createInitialMigrationRecord(plan: InstallationMigrationPlan, migrationId = randomUUID()): InstallationMigrationRecord {
  parseMigrationPlan(plan);
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, migrationId, planFingerprint: plan.planFingerprint, status: 'in_progress', checkpoint: 'initial',
    startedAt: now, updatedAt: now, revision: 0, plan,
    legacyInstallation: plan.legacyInstallation, targetInstallation: plan.targetInstallation,
    completedEffects: [], uncertainEffects: [], retainedPaths: [], legacyRecovery: plan.legacyRecovery,
    processSettlement: 'settled'
  };
}

export function updateRecordCheckpoint(
  record: InstallationMigrationRecord, checkpoint: MigrationCheckpoint, completedEffectId?: string
): InstallationMigrationRecord {
  const { pendingEffectId: _pending, ...previous } = record;
  return {
    ...previous, checkpoint,
    completedEffects: completedEffectId && !record.completedEffects.includes(completedEffectId)
      ? [...record.completedEffects, completedEffectId] : [...record.completedEffects],
    updatedAt: new Date().toISOString()
  };
}

export function recordMigrationFailure(record: InstallationMigrationRecord, failure: MigrationFailureFacts): InstallationMigrationRecord {
  return { ...record, status: 'failed', failure, updatedAt: new Date().toISOString() };
}

export function recordMigrationSuccess(record: InstallationMigrationRecord, verification: MigrationVerificationFacts): InstallationMigrationRecord {
  if (!verification.explicitPathVerified || !verification.pathResolutionVerified || !verification.resourcesVerified ||
      verification.observedVersion !== record.targetInstallation.targetVersion) {
    throw new DistributionError('Migration cannot complete without exact independent owner, resource, and launcher readback.', 'verification_failed');
  }
  const { pendingEffectId: _pending, failure: _failure, ...previous } = record;
  const now = new Date().toISOString();
  return { ...previous, status: 'completed', checkpoint: 'verified', verification, updatedAt: now, completedAt: now, uncertainEffects: [] };
}

export function parseMigrationRecord(raw: unknown): InstallationMigrationRecord {
  const value = object(raw, [
    'schemaVersion', 'migrationId', 'planFingerprint', 'status', 'checkpoint', 'startedAt', 'updatedAt', 'completedAt',
    'legacyInstallation', 'targetInstallation', 'completedEffects', 'failure', 'verification', 'legacyRecovery',
    'revision', 'previousDigest', 'plan', 'pendingEffectId', 'uncertainEffects', 'retainedPaths', 'processSettlement', 'transaction'
  ], 'Installation migration record');
  if (value.schemaVersion !== 1 || typeof value.migrationId !== 'string' || !uuidPattern.test(value.migrationId) ||
      (value.status !== 'in_progress' && value.status !== 'failed' && value.status !== 'completed') ||
      (value.processSettlement !== 'settled' && value.processSettlement !== 'unconfirmed') ||
      !['initial', 'candidate-verified', 'legacy-retired', 'target-installed', 'launcher-activated', 'verified', 'failed'].includes(String(value.checkpoint))) {
    throw new DistributionError('Unknown installation record schema, ID, status, or checkpoint.');
  }
  const plan = parseMigrationPlan(value.plan);
  const strings = (input: unknown, label: string): string[] => {
    if (!Array.isArray(input) || input.length > 128) throw new DistributionError(`Invalid ${label} inventory.`);
    const values = input.map((entry) => text(entry, label));
    if (new Set(values).size !== values.length) throw new DistributionError(`Duplicate ${label} inventory.`);
    return values;
  };
  const completedEffects = strings(value.completedEffects, 'completed effect');
  const uncertainEffects = strings(value.uncertainEffects, 'uncertain effect');
  const retainedPaths = strings(value.retainedPaths, 'retained path');
  if ([...completedEffects, ...uncertainEffects, ...value.pendingEffectId ? [value.pendingEffectId] : []]
    .some((id) => !plan.orderedEffects.some((effect) => effect.id === id)) ||
      canonicalJson(value.legacyInstallation) !== canonicalJson(plan.legacyInstallation) ||
      canonicalJson(value.targetInstallation) !== canonicalJson(plan.targetInstallation) ||
      canonicalJson(value.legacyRecovery) !== canonicalJson(plan.legacyRecovery) ||
      value.planFingerprint !== plan.planFingerprint) {
    throw new DistributionError('Installation record differs from its original approved scope.');
  }
  const checkpoint = value.checkpoint;
  if (checkpoint !== 'initial' && checkpoint !== 'candidate-verified' && checkpoint !== 'legacy-retired' &&
      checkpoint !== 'target-installed' && checkpoint !== 'launcher-activated' && checkpoint !== 'verified' && checkpoint !== 'failed') {
    throw new DistributionError('Unknown installation checkpoint.');
  }
  let failure: MigrationFailureFacts | undefined;
  if (value.failure !== undefined) {
    const entry = object(value.failure, ['effectId', 'message', 'exitCode', 'timestamp'], 'Migration failure');
    failure = {
      effectId: text(entry.effectId, 'Failed effect'), message: text(entry.message, 'Failure message', 4096),
      timestamp: timestamp(entry.timestamp, 'Failure time'),
      ...(entry.exitCode !== undefined ? { exitCode: integer(entry.exitCode, 'Effect exit code', -2147483648, 4294967295) } : {})
    };
  }
  let verification: MigrationVerificationFacts | undefined;
  if (value.verification !== undefined) {
    const entry = object(value.verification, ['explicitPathVerified', 'pathResolutionVerified', 'observedVersion', 'resourcesVerified'], 'Migration verification');
    if (typeof entry.explicitPathVerified !== 'boolean' || typeof entry.pathResolutionVerified !== 'boolean' ||
        typeof entry.resourcesVerified !== 'boolean') throw new DistributionError('Invalid migration verification facts.');
    verification = {
      explicitPathVerified: entry.explicitPathVerified, pathResolutionVerified: entry.pathResolutionVerified,
      resourcesVerified: entry.resourcesVerified,
      ...(entry.observedVersion !== undefined ? { observedVersion: text(entry.observedVersion, 'Observed native version', 64) } : {})
    };
  }
  const record: InstallationMigrationRecord = {
    schemaVersion: 1, migrationId: value.migrationId, planFingerprint: digest(value.planFingerprint, 'Approved migration fingerprint'),
    status: value.status, checkpoint, startedAt: timestamp(value.startedAt, 'Migration start'), updatedAt: timestamp(value.updatedAt, 'Migration checkpoint time'),
    revision: integer(value.revision, 'Migration revision', 0, 1024), plan,
    legacyInstallation: plan.legacyInstallation, targetInstallation: plan.targetInstallation, legacyRecovery: plan.legacyRecovery,
    completedEffects, uncertainEffects, retainedPaths, processSettlement: value.processSettlement,
    ...(value.previousDigest !== undefined ? { previousDigest: digest(value.previousDigest, 'Previous migration revision') } : {}),
    ...(value.pendingEffectId !== undefined ? { pendingEffectId: text(value.pendingEffectId, 'Pending effect') } : {}),
    ...(value.completedAt !== undefined ? { completedAt: timestamp(value.completedAt, 'Migration completion') } : {}),
    ...(failure ? { failure } : {}), ...(verification ? { verification } : {}),
    ...(value.transaction !== undefined ? { transaction: parseNativeTransactionOutcome(value.transaction) } : {})
  };
  if (record.status === 'completed' && (record.checkpoint !== 'verified' || !record.verification?.explicitPathVerified ||
      !record.verification.pathResolutionVerified || !record.verification.resourcesVerified ||
      record.verification.observedVersion !== record.targetInstallation.targetVersion ||
      record.pendingEffectId || record.uncertainEffects?.length || record.processSettlement !== 'settled' ||
      record.completedEffects.length !== plan.orderedEffects.length ||
      record.transaction && (record.transaction.status !== 'committed' || !record.transaction.committed ||
        record.transaction.cleanupFailures.length || record.transaction.rollbackFailures.length ||
        record.transaction.processSettlement !== 'settled'))) {
    throw new DistributionError('Completed installation record lacks complete, exact readback.');
  }
  return record;
}
