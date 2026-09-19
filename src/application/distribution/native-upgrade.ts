import { randomUUID } from 'node:crypto';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { compareSemver } from '../../semver.js';
import type { SelfUpgradeRequest } from '../../self-upgrade.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import {
  DistributionError, LockedFileHandoverError, NativeCommandFailure, WinGetReadOnlyObservationError,
  winGetReadOnlyObservationBlocker, type DistributionReason
} from '../../domain/distribution/errors.js';
import type { InstallationOwner } from '../../domain/distribution/contracts.js';
import type { NativeUpgradeRecord } from '../../domain/distribution/upgrade-record.js';
import { InstallationDetector, type InstallationDetectorDependencies } from '../../adapters/distribution/installation-detector.js';
import { DirectInstallerAdapter, assertDirectHandoverImplementation, type StagedInstallResult } from '../../adapters/distribution/direct-installer-adapter.js';
import type { NativeManagerSelection, NativeOwnerAdapter } from '../../adapters/distribution/owner-adapter.js';
import { assertInstallationPaths, captureInstallationPath, installationTransactionRoot, withInstallationLocks } from '../../adapters/distribution/installation-binding.js';
import { ReceiptStore, unresolvedInstallationRecords } from '../../adapters/distribution/receipt-store.js';
import { assertNativeCommandInvocation } from '../../adapters/distribution/native-command-runner.js';
import { verifyManagerReplacement as verifyUpgradeManager } from './verify-manager.js';

export interface NativeUpgradeDependencies extends InstallationDetectorDependencies {
  detector?: InstallationDetector;
  directInstaller?: DirectInstallerAdapter;
  candidatePath?: string;
  now?: () => Date;
}

export interface NativeUpgradeResult {
  schemaVersion: 1;
  distribution: 'native';
  mode: 'check' | 'apply';
  status: 'current' | 'update-available' | 'upgraded' | 'blocked' | 'failed';
  currentVersion: string;
  targetVersion?: string;
  owner: InstallationOwner;
  upstreamAvailability: 'unknown' | 'current' | 'available' | 'older';
  ownerAvailability: 'unknown' | 'current' | 'available' | 'blocked';
  reasonCode: DistributionReason | 'current' | 'update_available' | 'upgrade_complete' | 'migration_required' | 'downgrade_refused';
  completedEffects: string[];
  uncertainEffects: string[];
  recoveryRequired: boolean;
  manualAction?: string;
  recordPersistence?: 'unconfirmed';
}

export function nativeUpgradeExitCode(result: NativeUpgradeResult): number {
  return result.status === 'update-available' ? 2 : result.status === 'current' || result.status === 'upgraded' ? 0 : 1;
}

export async function runNativeOwnerUpgrade(request: SelfUpgradeRequest, options: NativeUpgradeDependencies = {}): Promise<NativeUpgradeResult> {
  let value: NativeUpgradeResult = {
    schemaVersion: 1, distribution: 'native', mode: request.mode, status: 'blocked', currentVersion: request.currentVersion,
    owner: 'unknown', upstreamAvailability: 'unknown', ownerAvailability: 'unknown', reasonCode: 'ownership_unknown',
    completedEffects: [], uncertainEffects: [], recoveryRequired: false
  };
  let record: NativeUpgradeRecord | undefined;
  let receiptStore: ReceiptStore | undefined;
  try {
    if (request.mode !== 'check' && request.mode !== 'apply') throw new DistributionError('Native upgrade requires an explicit check or imperative apply mode.');
    const detector = options.detector ?? new InstallationDetector(options);
    const admission = detector.admission;
    receiptStore = options.receiptStore ?? detector.receiptStore;
    const pending = unresolvedInstallationRecords(await receiptStore.listInstallationRecords());
    if (pending.length > 1 || pending[0] && !('operationId' in pending[0])) {
      throw new DistributionError('An unfinished migration cannot acquire routine upgrade authorization; inspect its original installation recovery.', 'transaction_pending');
    }
    const prior = pending[0];
    if (prior) value = {
      ...value, targetVersion: prior.targetVersion, completedEffects: prior.completedEffects,
      uncertainEffects: prior.uncertainEffects, recoveryRequired: true
    };
    request.onStage?.('Inspect global installation');
    const current = await detector.observeInstallation();
    const owner = current.result.installation.owner;
    value = { ...value, owner, currentVersion: current.result.executable.version ?? request.currentVersion };
    if (owner === 'npm') return {
      ...value, reasonCode: 'migration_required', manualAction: 'Historical npm cannot discover native releases. Use an independently verified unlinked native bundle and separately approved installation migrate.'
    };
    if ((owner !== 'direct' && owner !== 'homebrew-cask' && owner !== 'winget') || !current.candidate ||
        current.result.status !== 'healthy' || !current.result.installation.evidenceDigest) {
      return { ...value, reasonCode: owner === 'unknown' || owner === 'unlinked' ? 'ownership_unknown' : 'ownership_conflict',
        manualAction: 'Inspect actual installation ownership and PATH resolution. Routine upgrade never acquires another owner or an unlinked bundle.' };
    }
    if (prior && (prior.owner !== owner || prior.processSettlement !== 'settled')) {
      throw new DistributionError('The previous native owner operation or process settlement is unresolved; retain its payload and recovery evidence.', 'recovery_required');
    }
    if (prior && request.mode === 'check') return {
      ...value, status: 'blocked', reasonCode: 'recovery_required', recoveryRequired: true,
      completedEffects: prior.completedEffects, uncertainEffects: prior.uncertainEffects,
      manualAction: 'Inspect the retained native upgrade record. Check mode never resumes or rewrites it.'
    };
    if (prior && owner === 'direct') {
      const direct = options.directInstaller ?? new DirectInstallerAdapter({
        admission, receiptStore, runner: options.runner, env: detector.env, cwd: detector.cwd
      });
      const journal = await direct.inspectRecovery(prior.transactionRoot);
      if (journal.status !== 'absent') {
        const recoveryNow = options.now ?? (() => new Date());
        const recoveryStarted = recoveryNow().getTime();
        if (!Number.isFinite(recoveryStarted)) throw new DistributionError('The direct recovery clock is invalid.', 'stale_plan');
        const identity = journal.installationIdentity;
        if (journal.status === 'blocked' || journal.planFingerprint !== prior.planFingerprint ||
            !identity || identity.intent !== 'upgrade' || identity.version !== prior.targetVersion ||
            path.join(prior.transactionRoot, ...identity.launcherPathParts) !== prior.launcherPath ||
            path.join(prior.transactionRoot, ...identity.receiptPathParts) !== path.join(prior.destinationDirectory, 'liftoff-receipt.json') ||
            journal.destinations.some((entry) => entry.disposition === 'changed') ||
            current.directReceipt?.installRoot !== prior.destinationDirectory ||
            current.directReceipt.launcherPath !== prior.launcherPath) {
          throw new DistributionError('Original direct upgrade recovery has changed identity or destinations; its evidence was preserved.', 'recovery_required');
        }
        const store = receiptStore;
        return await withInstallationLocks([prior.transactionRoot, store.homeDirectory], async (heldLease) => {
          const lease = { assertHeld: async () => {
            await heldLease.assertHeld();
            const currentTime = recoveryNow().getTime();
            if (!Number.isFinite(currentTime) || currentTime < recoveryStarted || currentTime >= recoveryStarted + 30 * 60_000) {
              throw new DistributionError('The bounded original direct recovery invocation expired.', 'stale_plan');
            }
          } };
          await lease.assertHeld();
          if (canonicalSha256(await store.loadOperationRecord(prior.operationId)) !== canonicalSha256(prior)) {
            throw new DistributionError('Original direct upgrade record changed before guarded recovery.', 'stale_plan');
          }
          record = await store.saveUpgradeRecord({
            ...prior, pendingEffectId: journal.committed ? 'verify-target-installation' : 'install-target-owner',
            processSettlement: 'unconfirmed', updatedAt: new Date().toISOString()
          });
          const outcome = await direct.recoverOriginalTransaction(prior.transactionRoot, prior.planFingerprint, lease);
          record = { ...record, transaction: outcome, processSettlement: outcome.processSettlement };
          await lease.assertHeld();
          if (outcome.cleanupFailures.length || outcome.rollbackFailures.length || outcome.processSettlement !== 'settled' ||
              outcome.status !== 'committed' && outcome.status !== 'rolled-back') {
            throw new DistributionError('Original direct upgrade recovery or independent readback remains incomplete.', 'recovery_required');
          }
          const { pendingEffectId: _pending, failure: _failure, ...settled } = record;
          record = await store.saveUpgradeRecord({
            ...settled, status: outcome.committed ? 'completed' : 'failed', uncertainEffects: [],
            completedEffects: outcome.committed
              ? prior.recovery?.action === 'verify-current' ? ['verify-target-installation']
                : ['stage-candidate', 'install-target-owner', 'verify-target-installation']
              : prior.completedEffects.filter((effect) => effect === 'stage-candidate'),
            updatedAt: new Date().toISOString()
          });
          return {
            ...value, targetVersion: prior.targetVersion,
            status: outcome.committed ? 'upgraded' : 'blocked',
            reasonCode: outcome.committed ? 'upgrade_complete' : 'recovery_required',
            completedEffects: record.completedEffects, uncertainEffects: [],
            recoveryRequired: !outcome.committed,
            ...(outcome.committed ? {} : {
              manualAction: 'The original sealed direct handover was safely rolled back. Invoke upgrade again from the verified owned payload to select a fresh exact target; no retained version was removed.'
            })
          };
        }, { recoveryRoot: prior.transactionRoot });
      }
    }
    request.onStage?.('Resolve canonical stable target');
    const release = await admission.releaseClient.fetchVerifiedRelease();
    const target = await admission.admitReleaseTarget(release);
    value = { ...value, targetVersion: target.version };
    const comparison = compareSemver(target.version, current.candidate.version);
    if (comparison < 0) return { ...value, upstreamAvailability: 'older', reasonCode: 'downgrade_refused' };
    if (comparison === 0 && !prior) return {
      ...value, status: 'current', upstreamAvailability: 'current', ownerAvailability: 'current', reasonCode: 'current'
    };
    value = { ...value, upstreamAvailability: 'available' };
    request.onStage?.('Verify configured registry parity');
    let manager: NativeOwnerAdapter | undefined;
    let selection: NativeManagerSelection | undefined;
    let root: string;
    let destination: string;
    let launcherPath: string;
    let packageId: string;
    let sourceDigest: string;
    if (owner === 'direct') {
      const receipt = current.directReceipt;
      const channel = (await admission.releaseClient.trustRegistration()).channels.find((entry) => entry.owner === 'direct');
      if (!receipt?.authority || !channel || channel.packageId !== 'liftoff') throw new DistributionError('The direct owner receipt and delivery source are not registered.', 'ownership_unknown');
      root = receipt.authority.transactionRoot;
      destination = receipt.installRoot;
      launcherPath = receipt.launcherPath;
      assertDirectHandoverImplementation(admission.host.os);
      assertNativeCommandInvocation({ executable: launcherPath, args: ['--version'] }, { cwd: root }, admission.host.os);
      packageId = channel.packageId;
      sourceDigest = canonicalSha256({ channel, release: release.manifestDigest });
      await access(destination, constants.W_OK);
      const next = await captureInstallationPath(path.join(destination, 'versions', `${target.version}-${target.provenanceDigest.slice(0, 16)}${prior ? `-${canonicalSha256(prior).slice(0, 16)}` : ''}`));
      if (next.state !== 'absent') throw new DistributionError('A retained or occupied native target version blocks replacement; no payload was cleaned.', 'ownership_conflict');
    } else {
      manager = detector.ownerAdapters.find((entry) => entry.owner === owner);
      if (!manager) throw new DistributionError('The current native owner adapter is unavailable.', 'tool_unavailable');
      selection = await manager.select(target, 'upgrade');
      root = await installationTransactionRoot([selection.destinationDirectory, selection.launcherPath]);
      destination = selection.destinationDirectory;
      launcherPath = selection.launcherPath;
      packageId = selection.packageId;
      sourceDigest = selection.sourceDigest;
    }
    value = { ...value, ownerAvailability: 'available' };
    if (request.mode === 'check') return { ...value, status: 'update-available', reasonCode: 'update_available' };
    const initialPaths = await Promise.all([destination, launcherPath].map(captureInstallationPath));
    const now = options.now ?? (() => new Date());
    const selectedAt = now();
    if (!Number.isFinite(selectedAt.getTime())) throw new DistributionError('The native upgrade clock is invalid.');
    const expiresAt = new Date(selectedAt.getTime() + 30 * 60_000).toISOString();
    const binding = canonicalSha256({
      owner: current.result.installation.evidenceDigest, sourceDigest, paths: initialPaths, release: release.manifestDigest,
      target: target.provenanceDigest, selection: selection?.bindingDigest ?? null, expiresAt
    });
    const store = receiptStore;
    const recheck = async (): Promise<void> => {
      const checkTime = now().getTime();
      if (!Number.isFinite(checkTime) || checkTime >= Date.parse(expiresAt) || checkTime < selectedAt.getTime()) throw new DistributionError('The selected native upgrade operation expired.', 'stale_plan');
      const fresh = await detector.observeInstallation();
      if (fresh.result.installation.evidenceDigest !== current.result.installation.evidenceDigest ||
          fresh.result.status !== 'healthy') throw new DistributionError('Current native owner or launcher changed after selection.', 'stale_plan');
      const authority = await admission.releaseClient.fetchVerifiedRelease();
      if (authority.manifestDigest !== release.manifestDigest || authority.registrationDigest !== release.registrationDigest) {
        throw new DistributionError('Native release or delivery authority changed after selection.', 'stale_plan');
      }
      await assertInstallationPaths(initialPaths);
      if (prior && canonicalSha256(await store.loadOperationRecord(prior.operationId)) !== canonicalSha256(prior)) {
        throw new DistributionError('The interrupted native upgrade record changed after selection.', 'stale_plan');
      }
      if (manager && selection) await manager.recheck(selection);
    };
    return await withInstallationLocks([root, store.homeDirectory], async (heldLease) => {
      const lease = { assertHeld: async () => {
        await heldLease.assertHeld();
        const checkTime = now().getTime();
        if (!Number.isFinite(checkTime) || checkTime >= Date.parse(expiresAt) || checkTime < selectedAt.getTime()) {
          throw new DistributionError('The selected native upgrade operation expired; remaining effects require a fresh invocation.', 'stale_plan');
        }
      } };
      await recheck();
      await store.assertNoPendingRecord(prior?.operationId);
      const operationId = randomUUID();
      const acquisition = path.join(store.baseDirectory, 'candidates', operationId);
      record = await store.saveUpgradeRecord({
        schemaVersion: 1, operation: 'native-upgrade', operationId, planFingerprint: binding, revision: 0,
        owner, packageId, previousVersion: current.candidate!.version, targetVersion: target.version,
        manifestDigest: release.manifestDigest, provenanceDigest: target.provenanceDigest, sourceDigest,
        ownerDigest: current.result.installation.evidenceDigest!, transactionRoot: root,
        destinationDirectory: destination, launcherPath, expiresAt, startedAt: selectedAt.toISOString(), updatedAt: selectedAt.toISOString(),
        status: 'in_progress', completedEffects: [], uncertainEffects: [], retainedPaths: [], processSettlement: 'settled',
        ...(prior ? { recovery: { operationId: prior.operationId, recordDigest: canonicalSha256(prior), action: comparison === 0 ? 'verify-current' : 'retry' } } : {})
      });
      let staged: StagedInstallResult | undefined;
      let direct: DirectInstallerAdapter | undefined;
      if (comparison === 0) {
        record = await store.saveUpgradeRecord({ ...record, pendingEffectId: 'verify-target-installation', processSettlement: 'unconfirmed' });
        if (owner === 'direct') {
          direct = options.directInstaller ?? new DirectInstallerAdapter({ admission, receiptStore: store, runner: options.runner, env: detector.env, cwd: detector.cwd });
          await direct.verifyOwnedInstallation(destination, target.version, target.provenanceDigest);
        } else if (manager && selection) await verifyUpgradeManager(admission, detector, manager, selection, target.provenanceDigest);
        else throw new DistributionError('Native recovery verification lacks its recorded owner.', 'ownership_unknown');
        const { pendingEffectId: _pending, ...verified } = record;
        record = await store.saveUpgradeRecord({ ...verified, status: 'completed', completedEffects: ['verify-target-installation'], processSettlement: 'settled' });
        return { ...value, status: 'current', reasonCode: 'current', completedEffects: record.completedEffects, uncertainEffects: [], recoveryRequired: false };
      }
      record = await store.saveUpgradeRecord({
        ...record, pendingEffectId: 'stage-candidate', processSettlement: 'unconfirmed',
        retainedPaths: [acquisition, current.candidate!.bundleRoot], updatedAt: new Date().toISOString()
      });
      const candidate = options.candidatePath
        ? await admission.admitBundle(options.candidatePath, release)
        : await admission.materializeArtifact(target, acquisition, lease);
      await admission.probe(candidate);
      await recheck();
      if (owner === 'direct') {
        direct = options.directInstaller ?? new DirectInstallerAdapter({ admission, receiptStore: store, runner: options.runner, env: detector.env, cwd: detector.cwd });
        const directSelection = await direct.select({
          candidate, installRoot: destination, launcherPath, intent: 'upgrade', currentReceipt: current.directReceipt,
          ...(prior ? { stageIdentity: canonicalSha256(prior) } : {})
        });
        record = await store.saveUpgradeRecord({ ...record, retainedPaths: [...record.retainedPaths, directSelection.versionRoot] });
        staged = await direct.stage(directSelection, lease);
      }
      record = await store.saveUpgradeRecord({
        ...record, completedEffects: ['stage-candidate'], pendingEffectId: 'install-target-owner', processSettlement: 'unconfirmed', updatedAt: new Date().toISOString()
      });
      await recheck();
      await lease.assertHeld();
      request.onStage?.('Install exact Liftoff release', target.version);
      if (direct && staged) {
        const outcome = await direct.activate(staged, binding, lease);
        record = { ...record, transaction: outcome };
        if (outcome.committed) {
          record = { ...record, completedEffects: ['stage-candidate', 'install-target-owner'], processSettlement: 'settled' };
          record = await store.saveUpgradeRecord(record);
        }
        if (!outcome.committed || outcome.cleanupFailures.length || outcome.rollbackFailures.length) {
          throw new DistributionError('Direct replacement transaction or its finalization is incomplete.', 'recovery_required');
        }
      } else if (manager && selection) {
        request.onInstallCommand?.({
          executable: owner === 'homebrew-cask' ? 'brew' : 'winget',
          args: owner === 'homebrew-cask'
            ? ['upgrade', '--cask', selection.packageId]
            : ['upgrade', '--id', selection.packageId, '--exact', '--version', selection.version]
        });
        await manager.execute(selection);
      } else throw new DistributionError('Native upgrade has no bound current-owner executor.', 'ownership_unknown');
      record = await store.saveUpgradeRecord({
        ...record, completedEffects: ['stage-candidate', 'install-target-owner'], pendingEffectId: 'verify-target-installation', processSettlement: 'unconfirmed', updatedAt: new Date().toISOString()
      });
      request.onStage?.('Verify replacement', target.version);
      if (direct && staged) await direct.verifyInstallation(staged);
      else if (manager && selection) await verifyUpgradeManager(admission, detector, manager, selection, target.provenanceDigest);
      await lease.assertHeld();
      const { pendingEffectId: _pending, ...complete } = record;
      record = await store.saveUpgradeRecord({
        ...complete, status: 'completed', completedEffects: ['stage-candidate', 'install-target-owner', 'verify-target-installation'],
        uncertainEffects: [], processSettlement: 'settled', updatedAt: new Date().toISOString()
      });
      return { ...value, status: 'upgraded', reasonCode: 'upgrade_complete', completedEffects: record.completedEffects, uncertainEffects: [], recoveryRequired: false };
    });
  } catch (error) {
    const reasonCode = error instanceof LockedFileHandoverError ? 'locked_handover'
      : error instanceof DistributionError ? error.reasonCode : 'verification_failed';
    if (record && receiptStore) {
      const pending = record.pendingEffectId;
      const unsettled = record.transaction?.processSettlement === 'unconfirmed' ||
        error instanceof NativeCommandFailure && error.settled !== true;
      const uncertainEffects = [...new Set([
        ...record.uncertainEffects,
        ...pending && !record.completedEffects.includes(pending) && (pending === 'install-target-owner' || unsettled) ? [pending] : [],
        ...unsettled && record.completedEffects.includes('install-target-owner') ? ['verify-target-installation'] : []
      ])];
      record = {
        ...record, status: 'failed', uncertainEffects,
        processSettlement: unsettled ? 'unconfirmed' : 'settled',
        failure: (error instanceof Error ? error.message : 'Native upgrade failed.').replace(/[\u0000-\u001f\u007f]+/gu, ' ').slice(0, 4096),
        updatedAt: new Date().toISOString()
      };
      let recordPersistence: NativeUpgradeResult['recordPersistence'];
      try { record = await receiptStore.saveUpgradeRecord(record); }
      catch { recordPersistence = 'unconfirmed'; }
      return {
        ...value, status: 'failed', reasonCode, completedEffects: record.completedEffects, uncertainEffects,
        recoveryRequired: true, ...(recordPersistence ? { recordPersistence } : {}), manualAction: reasonCode === 'locked_handover'
          ? 'Close the affected stable Liftoff launcher. Use installation migrate --recover to inspect the exact retained owner and its versioned-executable upgrade retry; no manual overwrite, unrelated process termination, or active-payload cleanup is authorized.'
          : unsettled
            ? 'An owned native process has unconfirmed settlement. Preserve every retained payload and the original recovery record; no automatic retry, cleanup, forced unlock, or unrelated process termination is authorized.'
            : 'Inspect the exact installation recovery record. Retained payloads are not cleaned and changed owner/user content is never overwritten by automatic restoration.'
      };
    }
    return {
      ...value, status: 'blocked', reasonCode, ownerAvailability: value.upstreamAvailability === 'available' ? 'blocked' : value.ownerAvailability,
      manualAction: error instanceof WinGetReadOnlyObservationError ? winGetReadOnlyObservationBlocker
        : reasonCode === 'trust_missing'
          ? 'The packaged public native trust root is missing. Preserve the installation; operational qualification files and Node runtime pins cannot replace publisher authority.'
        : reasonCode === 'trust_unconfigured'
          ? 'The packaged public native trust root is explicitly unconfigured. Reviewed public signer keys, a signed publication-index source, and owner channels are required; no publication approval is implied.'
        : reasonCode === 'trust_unregistered'
        ? 'Native signing, exact channels, and publication authorization remain unregistered. No production installation is admitted.'
        : reasonCode === 'implementation_missing'
          ? 'The required production owner-observation adapter is not implemented or wired. Do not treat release-download availability as manager installation authority.'
          : reasonCode === 'qualification_required'
            ? 'The selected Windows wrapper or launcher ownership contract has not been qualified. Native host proof is required; no cmd expansion, controller-integrity bypass, or policy bypass was attempted.'
            : 'Inspect the causal owner, source, host, or integrity blocker. No source refresh, channel switch, npm replacement, or elevation was attempted.'
    };
  }
}
