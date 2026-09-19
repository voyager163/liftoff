import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { InstallationMigrationPlan } from '../../domain/distribution/contracts.js';
import { DistributionError } from '../../domain/distribution/errors.js';
import { InstallationDetector, type InstallationDetectorDependencies } from '../../adapters/distribution/installation-detector.js';
import { ReceiptStore, unresolvedInstallationRecords, type InstallationOperationRecord } from '../../adapters/distribution/receipt-store.js';
import { DirectInstallerAdapter } from '../../adapters/distribution/direct-installer-adapter.js';
import { ioCode } from '../../adapters/distribution/native-files.js';
import { observeLauncher } from '../../adapters/distribution/launcher-observation.js';
import { planInstallationMigration } from './plan-migration.js';
import type { AdmittedNativeCandidate } from '../../adapters/distribution/native-admission.js';
import { createStructuredContinuation, type StructuredContinuationV1 } from '../../protocol/continuation.js';

export interface RecoverMigrationOptions {
  migrationId?: string;
  receiptStore?: ReceiptStore;
  detector?: InstallationDetector;
  detectorDependencies?: InstallationDetectorDependencies;
  now?: () => Date;
  json?: boolean;
}

export interface MigrationRecoveryInspection {
  schemaVersion: 1;
  mode: 'recovery-inspection';
  operation: 'migration' | 'native-upgrade';
  recordId: string;
  record: InstallationOperationRecord;
  currentOwner: string;
  remainingEffects: string[];
  isRecoverable: boolean;
  legacyPackage: 'present' | 'absent' | 'not-applicable';
  launcher: 'absent' | 'original' | 'replacement' | 'changed';
  transaction: 'absent' | 'interrupted' | 'committed' | 'blocked';
  issues: string[];
  remedy: string;
  proposedPlan?: InstallationMigrationPlan;
  upgradeContinuation?: StructuredContinuationV1;
}

export async function inspectMigrationRecovery(options: RecoverMigrationOptions = {}): Promise<MigrationRecoveryInspection> {
  const detector = options.detector ?? new InstallationDetector(options.detectorDependencies);
  const store = options.receiptStore ?? detector.receiptStore;
  const records = await store.listInstallationRecords();
  const unfinished = unresolvedInstallationRecords(records);
  if (unfinished.length > 1) throw new DistributionError('Multiple installation scopes remain unfinished; all records were preserved.', 'transaction_pending');
  const record = options.migrationId ? await store.loadOperationRecord(options.migrationId)
    : unfinished[0] ?? records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!record) throw new DistributionError('No registered installation recovery record was found.', 'recovery_required');
  const upgrade = 'operationId' in record;
  const destination = upgrade ? record.destinationDirectory : record.targetInstallation.destinationDirectory;
  const launcherPath = upgrade ? record.launcherPath : record.targetInstallation.launcherPath;
  const targetOwner = upgrade ? record.owner : record.targetInstallation.owner;
  const targetVersion = upgrade ? record.targetVersion : record.targetInstallation.targetVersion;
  const root = upgrade ? record.transactionRoot : record.plan.transactionRoot;
  let legacyPackage: MigrationRecoveryInspection['legacyPackage'] = 'not-applicable';
  if (!upgrade) {
    legacyPackage = 'present';
    try { await lstat(record.legacyInstallation.packageRoot); }
    catch (error) { if (ioCode(error) === 'ENOENT') legacyPackage = 'absent'; else throw error; }
  }
  let launcher: MigrationRecoveryInspection['launcher'] = 'changed';
  const actual = await observeLauncher(launcherPath);
  if (actual.state === 'absent') launcher = 'absent';
  else if (!upgrade && actual.state === 'link' && actual.resolved === record.legacyInstallation.executablePath) launcher = 'original';
  let currentOwner = 'unknown';
  let ownedPayload: AdmittedNativeCandidate | undefined;
  const issues: string[] = [];
  if (actual.state !== 'absent') {
    try {
      const receipt = targetOwner === 'direct' ? await store.loadDirectReceipt(destination) : null;
      const observed = await detector.observeInstallation(receipt ? receipt.versionRoot : actual.state === 'link' ? actual.resolved : destination);
      currentOwner = observed.result.installation.owner;
      if (observed.result.installation.launcherPath === launcherPath && currentOwner === targetOwner) {
        if (observed.result.installation.version === targetVersion) launcher = 'replacement';
        else if (upgrade && observed.result.installation.version === record.previousVersion) launcher = 'original';
        if (receipt && observed.result.status === 'healthy' && observed.candidate?.bundleRoot === receipt.versionRoot) {
          ownedPayload = observed.candidate;
        }
      }
    } catch (error) {
      if (!(error instanceof DistributionError) && ioCode(error) !== 'ENOENT') throw error;
      issues.push(error instanceof Error ? error.message : 'Installation recovery observation failed.');
    }
  }
  const direct = new DirectInstallerAdapter({ admission: detector.admission, receiptStore: store, env: detector.env, cwd: detector.cwd });
  const transaction = await direct.inspectRecovery(root);
  if (transaction.status === 'blocked' || transaction.destinations.some((entry) => entry.disposition === 'changed')) {
    issues.push(transaction.reason ?? 'A recorded launcher or receipt changed; original guarded recovery cannot overwrite it.');
  }
  if (record.processSettlement !== 'settled') issues.push('An earlier process has unconfirmed settlement; its payload and record must remain retained.');
  const effects = upgrade ? ['stage-candidate', 'install-target-owner', 'verify-target-installation'] : record.plan.orderedEffects.map((effect) => effect.id);
  const remainingEffects = effects.filter((effect) => !record.completedEffects.includes(effect));
  let isRecoverable = record.status !== 'completed' && transaction.status !== 'blocked' && launcher !== 'changed' && issues.length === 0;
  let proposedPlan: InstallationMigrationPlan | undefined;
  if (!upgrade && isRecoverable) {
    try {
      proposedPlan = await planInstallationMigration({
        toOwner: record.targetInstallation.owner, candidatePath: record.targetInstallation.candidatePath,
        destinationDirectory: destination, launcherPath, detector, receiptStore: store, now: options.now
      });
    } catch (error) {
      isRecoverable = false;
      issues.push(error instanceof Error ? error.message : 'The original installation scope cannot be safely replanned.');
    }
  }
  const remedy = record.status === 'completed' ? 'The recorded installation operation completed; this inspection performed no mutation.'
    : issues.length || launcher === 'changed'
      ? 'Preserve both installations, changed owner/user content, and all recovery evidence. Resolve the causal blocker; no automatic restoration or payload cleanup is authorized.'
      : upgrade
        ? ownedPayload?.target.startsWith('win32-')
          ? 'Close the affected stable liftoff.exe instances, then invoke the exact receipt-owned versioned launcher below. It performs ordinary upgrade or guarded original-journal recovery without locking the stable PE. Every required new PE byte must actually replace the old image before success; check and this inspection do not mutate.'
          : 'The recorded native owner remains observable. A fresh explicit upgrade invocation can retry its exact validated owner-preserving operation; check and recovery inspection do not mutate.'
        : 'Review the fresh exact recovery plan and explicitly approve the normal installation migrate command. Already observed retirement is not repeated; historical npm restoration remains a separately reviewed owner conflict.';
  const upgradeContinuation = upgrade && isRecoverable && targetOwner === 'direct' && ownedPayload?.target.startsWith('win32-')
    ? createStructuredContinuation({
      executable: path.join(ownedPayload.bundleRoot, ...ownedPayload.provenance.entrypoints.launcher.split('/')),
      args: ['upgrade', ...options.json ? ['--json'] : []], cwd: root, scope: 'installation', targetScope: 'installation',
      userInstallTarget: destination, requiredAuthority: ['dedicated-owner-upgrade'],
      compatibilityIdentity: record.planFingerprint, platform: detector.admission.host.os
    }) : undefined;
  return {
    schemaVersion: 1, mode: 'recovery-inspection', operation: upgrade ? 'native-upgrade' : 'migration',
    recordId: upgrade ? record.operationId : record.migrationId, record, currentOwner, remainingEffects, isRecoverable,
    legacyPackage, launcher, transaction: transaction.status, issues, remedy, ...(proposedPlan ? { proposedPlan } : {}),
    ...(upgradeContinuation ? { upgradeContinuation } : {})
  };
}
