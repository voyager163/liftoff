import {
  createInitialMigrationRecord, recordMigrationFailure, recordMigrationSuccess, updateRecordCheckpoint
} from '../../domain/distribution/migration-record.js';
import type { InstallationMigrationPlan, InstallationMigrationRecord } from '../../domain/distribution/contracts.js';
import { DistributionError, MigrationApprovalRequiredError, MigrationExecutionError, NativeCommandFailure } from '../../domain/distribution/errors.js';
import { isPlanFingerprint, requestMigrationApproval, type MigrationApprovalContext } from './approval.js';
import { assertDirectMigrationLauncher, assertManagerMigrationPaths, assertMigrationPlanCurrent, assertRetiredLegacy, migrationPlanState, type MigrationPlanState } from './plan-migration.js';
import { withInstallationLocks } from '../../adapters/distribution/installation-binding.js';
import type { StagedInstallResult } from '../../adapters/distribution/direct-installer-adapter.js';
import { observePathLaunchers } from '../../adapters/distribution/launcher-observation.js';
import { verifyManagerReplacement } from './verify-manager.js';

export interface ExecuteMigrationOptions {
  plan: InstallationMigrationPlan;
  approvePlan?: string;
  json?: boolean;
  approvalContext?: MigrationApprovalContext;
  onProgress?: (step: number, total: number, description: string) => void | Promise<void>;
}

function assertCurrentWindow(plan: InstallationMigrationPlan, state: MigrationPlanState): void {
  const now = state.now().getTime();
  if (!Number.isFinite(now) || !plan.expiresAt || now >= Date.parse(plan.expiresAt) || now < Date.parse(plan.createdAt)) {
    throw new DistributionError('The exact approved installation operation expired; remaining effects need fresh review.', 'stale_plan');
  }
}

async function verifyManagedReplacement(state: MigrationPlanState): Promise<void> {
  if (!state.ownerAdapter || !state.ownerSelection) throw new DistributionError('Native manager readback is not bound to a selected owner.', 'verification_failed');
  await verifyManagerReplacement(state.admission, state.detector, state.ownerAdapter, state.ownerSelection, state.candidate.provenanceDigest);
}

export { verifyManagedReplacement };

export async function executeInstallationMigration(options: ExecuteMigrationOptions): Promise<InstallationMigrationRecord> {
  if (Object.keys(options).some((key) => !['plan', 'approvePlan', 'json', 'approvalContext', 'onProgress'].includes(key)) ||
      options.json !== undefined && typeof options.json !== 'boolean' ||
      options.approvePlan !== undefined && !isPlanFingerprint(options.approvePlan)) {
    throw new DistributionError('Installation execution accepts only exact-plan or genuine terminal authorization; generic approval booleans and Yes flags grant no authority.', 'approval_required');
  }
  const { plan } = options;
  const state = migrationPlanState(plan);
  await assertMigrationPlanCurrent(plan);
  const approval = await requestMigrationApproval({
    fingerprint: plan.planFingerprint, approvePlan: options.approvePlan, json: options.json,
    message: `Retire the exact legacy Liftoff package and acquire ${plan.targetInstallation.targetPackage}@${plan.targetInstallation.targetVersion} through ${plan.targetInstallation.owner}?`
  }, options.approvalContext ?? { stderr: process.stderr });
  if (approval.status !== 'approved') {
    if (approval.status === 'mismatch') throw new DistributionError('The supplied approval does not match the current native installation plan.', 'stale_plan');
    if (approval.status === 'declined') throw new DistributionError('Installation migration was declined; no installation effects occurred.', 'approval_required');
    throw new MigrationApprovalRequiredError(plan.planFingerprint);
  }
  if (!plan.transactionRoot) throw new DistributionError('Native migration has no exact transaction boundary.', 'stale_plan');
  return withInstallationLocks([plan.transactionRoot, plan.legacyInstallation.prefix, state.receiptStore.homeDirectory], async (heldLease) => {
    const lease = { assertHeld: async () => { await heldLease.assertHeld(); assertCurrentWindow(plan, state); } };
    await assertMigrationPlanCurrent(plan);
    await state.receiptStore.assertNoPendingRecord(plan.recovery?.migrationId);
    let record = await state.receiptStore.saveMigrationRecord(createInitialMigrationRecord(plan));
    let staged: StagedInstallResult | undefined;
    let currentEffect = plan.orderedEffects[0].id;
    let retired = plan.recovery?.sourceRetired === true;
    try {
      for (const effect of plan.orderedEffects) {
        currentEffect = effect.id;
        await options.onProgress?.(effect.step, plan.orderedEffects.length, effect.description);
        await lease.assertHeld();
        assertCurrentWindow(plan, state);
        await state.admission.recheck(state.candidate);
        if (!retired && state.legacy) await state.detector.npmAdapter.recheck(state.legacy);
        const paths = await observePathLaunchers(state.detector.env, state.detector.cwd);
        if (paths.some((entry) => !plan.legacyInstallation.launcherPaths.includes(entry.path) && entry.path !== plan.targetInstallation.launcherPath)) {
          throw new DistributionError('A new unrelated PATH launcher invalidated the approved installation operation.', 'stale_plan');
        }
        if (state.ownerSelection && effect.id !== 'verify-target-installation') await state.ownerAdapter?.recheck(state.ownerSelection);
        if (effect.id !== 'verify-target-installation') await assertManagerMigrationPaths(plan, state, retired);
        record = await state.receiptStore.saveMigrationRecord({
          ...record, pendingEffectId: effect.id, processSettlement: 'unconfirmed', updatedAt: new Date().toISOString(),
          ...(effect.id === 'stage-target' && state.directSelection
            ? { retainedPaths: [...new Set([...(record.retainedPaths ?? []), state.candidate.bundleRoot, state.directSelection.versionRoot])] } : {})
        });
        switch (effect.id) {
          case 'recover-original-transaction': {
            if (!state.directInstaller || !plan.recovery) throw new DistributionError('Original installation recovery is not bound.', 'recovery_required');
            if (state.directSelection) {
              const outcome = await state.directInstaller.recoverSelection(state.directSelection, lease);
              record = { ...record, transaction: outcome };
              if (outcome.status !== 'rolled-back' || outcome.rollbackFailures.length || outcome.cleanupFailures.length) {
                throw new DistributionError('Original native transaction recovery remains incomplete; changed content was preserved.', 'recovery_required');
              }
            }
            else {
              await state.directInstaller.verifyOwnedInstallation(plan.targetInstallation.destinationDirectory, state.candidate.version, state.candidate.provenanceDigest);
              const outcome = await state.directInstaller.recoverOriginalTransaction(plan.transactionRoot, plan.recovery.originalPlanFingerprint);
              record = { ...record, transaction: outcome };
              if (!outcome.committed || outcome.cleanupFailures.length || outcome.rollbackFailures.length) {
                throw new DistributionError('Committed native transaction finalization remains incomplete.', 'recovery_required');
              }
            }
            record = updateRecordCheckpoint(record, record.checkpoint, effect.id);
            break;
          }
          case 'verify-unlinked-candidate':
            if (state.legacy && !retired) await state.detector.npmAdapter.recheck(state.legacy);
            await state.admission.probe(state.candidate);
            record = updateRecordCheckpoint(record, 'candidate-verified', effect.id);
            break;
          case 'stage-target':
            if (state.directInstaller && state.directSelection) staged = await state.directInstaller.stage(state.directSelection, lease);
            record = updateRecordCheckpoint(record, 'candidate-verified', effect.id);
            break;
          case 'retire-legacy-package':
            if (!state.legacy || retired) throw new DistributionError('Retirement is not authorized for an absent or already retired legacy package.', 'stale_plan');
            await assertDirectMigrationLauncher(state);
            await state.detector.npmAdapter.recheck(state.legacy);
            if (staged) await state.admission.recheck(staged.candidate);
            await state.detector.npmAdapter.retire(state.legacy);
            retired = true;
            record = updateRecordCheckpoint(record, 'legacy-retired', effect.id);
            break;
          case 'install-target-owner':
            await assertRetiredLegacy(plan.legacyInstallation, plan.targetInstallation.launcherPath, false);
            if (state.directInstaller && staged) {
              const outcome = await state.directInstaller.activate(staged, plan.planFingerprint, lease);
              record = { ...record, transaction: outcome };
              if (!outcome.committed || outcome.cleanupFailures.length || outcome.rollbackFailures.length) {
                if (outcome.committed) record = updateRecordCheckpoint(record, 'target-installed', effect.id);
                throw new DistributionError('Direct handover commit or guarded transaction finalization remains incomplete.', 'recovery_required');
              }
            } else if (state.ownerAdapter && state.ownerSelection) {
              await state.ownerAdapter.execute(state.ownerSelection);
            } else throw new DistributionError('Native target execution is not bound to an admitted owner.', 'trust_unregistered');
            record = updateRecordCheckpoint(record, 'target-installed', effect.id);
            break;
          case 'verify-target-installation':
            if (state.directInstaller && staged) await state.directInstaller.verifyInstallation(staged);
            else if (state.directInstaller && plan.recovery?.targetInstalled) {
              await state.directInstaller.verifyOwnedInstallation(plan.targetInstallation.destinationDirectory, state.candidate.version, state.candidate.provenanceDigest);
            }
            else await verifyManagedReplacement(state);
            record = updateRecordCheckpoint(record, 'verified', effect.id);
            record = recordMigrationSuccess(record, {
              explicitPathVerified: true, pathResolutionVerified: true, observedVersion: state.candidate.version, resourcesVerified: true
            });
            break;
          default: throw new DistributionError('Unregistered native migration effect.', 'stale_plan');
        }
        await lease.assertHeld();
        record = await state.receiptStore.saveMigrationRecord({ ...record, processSettlement: 'settled' });
      }
      return record;
    } catch (error) {
      if (currentEffect === 'retire-legacy-package' && state.legacy && await state.detector.npmAdapter.isRetired(state.legacy)) {
        record = updateRecordCheckpoint(record, 'legacy-retired', currentEffect);
      }
      const uncertain = currentEffect === 'retire-legacy-package' || currentEffect === 'install-target-owner';
      record = recordMigrationFailure({
        ...record,
        processSettlement: record.transaction?.processSettlement === 'unconfirmed' ||
          error instanceof NativeCommandFailure && error.settled !== true ? 'unconfirmed' : 'settled',
        uncertainEffects: uncertain && !record.completedEffects.includes(currentEffect)
          ? [...new Set([...(record.uncertainEffects ?? []), currentEffect])] : record.uncertainEffects ?? []
      }, {
        effectId: currentEffect,
        message: (error instanceof Error ? error.message : 'Installation effect failed.').replace(/[\u0000-\u001f\u007f]+/gu, ' ').slice(0, 4096),
        timestamp: new Date().toISOString(),
        ...(error instanceof NativeCommandFailure && error.exitCode !== null ? { exitCode: error.exitCode } : {})
      });
      try { return await state.receiptStore.saveMigrationRecord(record); }
      catch (storageError) {
        throw new MigrationExecutionError(currentEffect,
          `Effects are reported from observed state, but the final durable checkpoint could not be written: ${storageError instanceof Error ? storageError.message : 'storage failure'}`,
          undefined, record);
      }
    }
  }, plan.recovery?.recoverTransaction ? { recoveryRoot: plan.transactionRoot } : {});
}
