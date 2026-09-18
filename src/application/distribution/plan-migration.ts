import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { compareSemver } from '../../semver.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { buildMigrationPlan, verifyPlanIntegrity } from '../../domain/distribution/migration-plan.js';
import type { InstallationMigrationPlan, InstallationMigrationRecord, LegacyInstallationFacts } from '../../domain/distribution/contracts.js';
import { DistributionError } from '../../domain/distribution/errors.js';
import { InstallationDetector, type InstallationDetectorDependencies } from '../../adapters/distribution/installation-detector.js';
import { NativeAdmission, type AdmittedNativeCandidate } from '../../adapters/distribution/native-admission.js';
import { DirectInstallerAdapter, type DirectInstallSelection } from '../../adapters/distribution/direct-installer-adapter.js';
import { ReceiptStore, unresolvedInstallationRecords } from '../../adapters/distribution/receipt-store.js';
import type { ObservedNpmInstallation } from '../../adapters/distribution/npm-installation.js';
import type { NativeManagerSelection, NativeOwnerAdapter } from '../../adapters/distribution/owner-adapter.js';
import {
  assertInstallationNotProjectOwned, assertInstallationPaths, assertNoInstallationTransaction, captureInstallationPath,
  installationTransactionRoot, within, type InstallationPathBinding
} from '../../adapters/distribution/installation-binding.js';
import { canonicalDestination, ioCode, nativeDirectorySnapshot } from '../../adapters/distribution/native-files.js';
import { observePathLaunchers } from '../../adapters/distribution/launcher-observation.js';
import { commandShellForPlatform, formatShellCommand } from '../../adapters/process/shell-command.js';
import { resolveTargetVersion } from './target-resolution.js';

export interface PlanMigrationOptions extends InstallationDetectorDependencies {
  toOwner: 'homebrew-cask' | 'winget' | 'direct';
  targetVersion?: string;
  candidatePath?: string;
  destinationDirectory?: string;
  launcherPath?: string;
  detector?: InstallationDetector;
  detectorDependencies?: InstallationDetectorDependencies;
  directInstaller?: DirectInstallerAdapter;
  now?: () => Date;
}

export interface MigrationPlanState {
  detector: InstallationDetector;
  admission: NativeAdmission;
  receiptStore: ReceiptStore;
  candidate: AdmittedNativeCandidate;
  legacy?: ObservedNpmInstallation;
  recoveryRecord?: InstallationMigrationRecord;
  directInstaller?: DirectInstallerAdapter;
  directSelection?: DirectInstallSelection;
  ownerAdapter?: NativeOwnerAdapter;
  ownerSelection?: NativeManagerSelection;
  managerPaths?: readonly InstallationPathBinding[];
  directLauncher?: InstallationPathBinding;
  pathDigest: string;
  now: () => Date;
}

const preparedPlans = new WeakMap<InstallationMigrationPlan, MigrationPlanState>();

export function migrationPlanState(plan: InstallationMigrationPlan): MigrationPlanState {
  const state = preparedPlans.get(plan);
  if (!state || !Object.isFrozen(plan) || !verifyPlanIntegrity(plan)) {
    throw new DistributionError('Migration execution requires the internally prepared immutable native plan, not caller-authored plan fields.', 'stale_plan');
  }
  return state;
}

export async function assertMigrationPlanCurrent(plan: InstallationMigrationPlan): Promise<void> {
  const state = migrationPlanState(plan);
  const now = state.now().getTime();
  if (!Number.isFinite(now) || !plan.expiresAt || now >= Date.parse(plan.expiresAt) || now < Date.parse(plan.createdAt)) {
    throw new DistributionError('The exact native migration review window expired or the clock changed.', 'stale_plan');
  }
  await state.admission.recheck(state.candidate);
  if (state.legacy) await state.detector.npmAdapter.recheck(state.legacy);
  else await assertRetiredLegacy(plan.legacyInstallation, plan.targetInstallation.launcherPath,
    plan.recovery?.targetInstalled === true || plan.recovery?.recoverTransaction === true);
  if (state.recoveryRecord && canonicalSha256(await state.receiptStore.loadMigrationRecord(state.recoveryRecord.migrationId)) !== plan.recovery?.recordDigest) {
    throw new DistributionError('The interrupted installation record changed after recovery review.', 'stale_plan');
  }
  if (state.recoveryRecord) {
    const active = unresolvedInstallationRecords(await state.receiptStore.listInstallationRecords());
    if (active.length !== 1 || 'operationId' in active[0] || active[0].migrationId !== state.recoveryRecord.migrationId) {
      throw new DistributionError('That interrupted migration has already been continued or replaced by another scoped record.', 'stale_plan');
    }
  }
  if (state.directSelection) await state.directInstaller?.recheck(state.directSelection);
  if (state.ownerSelection) await state.ownerAdapter?.recheck(state.ownerSelection);
  await assertManagerMigrationPaths(plan, state, plan.recovery?.sourceRetired === true);
  if (canonicalSha256(await observePathLaunchers(state.detector.env, state.detector.cwd)) !== state.pathDigest) {
    throw new DistributionError('Ordinary command resolution or a launcher conflict changed after review.', 'stale_plan');
  }
}

export async function assertManagerMigrationPaths(
  plan: InstallationMigrationPlan, state: MigrationPlanState, retired: boolean
): Promise<void> {
  if (!state.managerPaths) return;
  for (const binding of state.managerPaths) {
    if (retired && !plan.recovery?.targetInstalled && binding.path === plan.targetInstallation.launcherPath) {
      const current = await captureInstallationPath(binding.path);
      if (current.state !== 'absent' || canonicalSha256(current.directories) !== canonicalSha256(binding.directories)) {
        throw new DistributionError('The retired manager launcher destination changed or is occupied; no overwrite is authorized.', 'ownership_conflict');
      }
    } else await assertInstallationPaths([binding]);
  }
}

export async function assertDirectMigrationLauncher(state: MigrationPlanState): Promise<void> {
  const binding = state.directLauncher;
  if (!binding) return;
  const current = await captureInstallationPath(binding.path);
  if (current.state !== binding.state || canonicalSha256(current.launcher ?? null) !== canonicalSha256(binding.launcher ?? null)) {
    throw new DistributionError('The approved direct launcher changed before legacy retirement; no removal or overwrite is authorized.', 'stale_plan');
  }
  for (const directory of binding.directories) {
    if (canonicalSha256(await nativeDirectorySnapshot(directory.path)) !== canonicalSha256(directory)) {
      throw new DistributionError('The approved direct launcher directory changed before legacy retirement.', 'stale_plan');
    }
  }
}

export async function planInstallationMigration(options: PlanMigrationOptions): Promise<InstallationMigrationPlan> {
  if (options.toOwner !== 'direct' && options.toOwner !== 'homebrew-cask' && options.toOwner !== 'winget') {
    throw new DistributionError('Installation migration requires an exact supported --to owner.');
  }
  const detector = options.detector ?? new InstallationDetector({ ...options.detectorDependencies, ...options });
  const admission = detector.admission;
  const receiptStore = options.receiptStore ?? detector.receiptStore;
  const pending = unresolvedInstallationRecords(await receiptStore.listInstallationRecords());
  if (pending.length > 1 || pending[0] && 'operationId' in pending[0]) {
    throw new DistributionError('Another unfinished installation scope requires its original recovery; no record was discarded.', 'transaction_pending');
  }
  const recoveryRecord = pending[0];
  if (recoveryRecord?.processSettlement === 'unconfirmed') {
    throw new DistributionError('An earlier installation process has unconfirmed settlement. Preserve its payloads and records; close or resolve that exact owner operation before any retry.', 'recovery_required');
  }
  if (recoveryRecord && recoveryRecord.targetInstallation.owner !== options.toOwner) {
    throw new DistributionError('Installation recovery cannot change the recorded native owner.', 'ownership_conflict');
  }
  const selectedCandidate = options.candidatePath ?? recoveryRecord?.targetInstallation.candidatePath;
  const target = await resolveTargetVersion({ candidatePath: selectedCandidate, admission, entrypoint: detector.entrypoint });
  if (recoveryRecord && target.targetVersion !== recoveryRecord.targetInstallation.targetVersion) {
    throw new DistributionError('Installation recovery cannot substitute a different recorded native version.', 'ownership_conflict');
  }
  if (options.targetVersion !== undefined && options.targetVersion !== target.targetVersion) {
    throw new DistributionError('Caller target version differs from the authenticated native candidate.', 'artifact_mismatch');
  }
  const candidateInspection = await detector.observeInstallation(target.candidate.bundleRoot);
  if (candidateInspection.result.installation.owner !== 'unlinked') {
    throw new DistributionError('Migration requires a verified unlinked native candidate, not another registered owner’s payload.', 'ownership_conflict');
  }
  const candidate = candidateInspection.candidate;
  if (!candidate) throw new DistributionError('Unlinked native candidate is not admitted.', 'trust_unregistered');
  let legacy: ObservedNpmInstallation | undefined;
  let sourceRetired = false;
  if (recoveryRecord) {
    try { await lstat(recoveryRecord.legacyInstallation.packageRoot); }
    catch (error) { if (ioCode(error) === 'ENOENT') sourceRetired = true; else throw error; }
  }
  if (!sourceRetired) legacy = await detector.observeLegacyInstallation();
  const legacyFacts = legacy?.facts ?? recoveryRecord?.legacyInstallation;
  if (!legacyFacts) throw new DistributionError('No actual or sealed historical npm identity is available.', 'ownership_unknown');
  if (recoveryRecord && legacy && canonicalSha256(legacy.facts) !== canonicalSha256(recoveryRecord.legacyInstallation)) {
    throw new DistributionError('Legacy package or owner changed since the recorded interruption; no repeated removal is authorized.', 'ownership_conflict');
  }
  if (legacyFacts.launcherConflicts.length) {
    throw new DistributionError('Unapproved additional Liftoff PATH owners block automatic handover; review the exact launcher conflict first.', 'ownership_conflict');
  }
  if (compareSemver(candidate.version, legacyFacts.installedVersion) <= 0) {
    throw new DistributionError('Native handover target must be newer than the exact historical installation.', 'artifact_mismatch');
  }
  if (within(legacyFacts.packageRoot, candidate.bundleRoot) || within(candidate.bundleRoot, legacyFacts.packageRoot)) {
    throw new DistributionError('The native candidate is not independent of the legacy package being retired.', 'unsafe_path');
  }
  await admission.probe(candidate);
  let directInstaller: DirectInstallerAdapter | undefined;
  let directSelection: DirectInstallSelection | undefined;
  let ownerAdapter: NativeOwnerAdapter | undefined;
  let ownerSelection: NativeManagerSelection | undefined;
  let managerPaths: readonly InstallationPathBinding[] | undefined;
  let directLauncher: InstallationPathBinding | undefined;
  let destinationDirectory: string;
  let launcherPath: string;
  let transactionRoot: string;
  let sourceId: string;
  let sourceDigest: string;
  let targetPackage: string;
  let targetBinding: string;
  let targetInstalled = false;
  let recoverTransaction = false;
  let originalTransactionFingerprint = recoveryRecord?.planFingerprint;
  const destinationInput = options.destinationDirectory ?? recoveryRecord?.targetInstallation.destinationDirectory;
  const launcherInput = options.launcherPath ?? recoveryRecord?.targetInstallation.launcherPath;
  if (recoveryRecord && (
    destinationInput && await canonicalDestination(destinationInput, detector.cwd) !== recoveryRecord.targetInstallation.destinationDirectory ||
    launcherInput && await canonicalDestination(launcherInput, detector.cwd, true) !== recoveryRecord.targetInstallation.launcherPath
  )) throw new DistributionError('Recovery cannot acquire a different destination or launcher.', 'ownership_conflict');
  if (options.toOwner === 'direct') {
    if (!destinationInput || !launcherInput) {
      throw new DistributionError('Direct handover requires explicit --destination and --launcher paths; no system prefix is guessed.', 'ownership_unknown');
    }
    directInstaller = options.directInstaller ?? new DirectInstallerAdapter({ admission, receiptStore, runner: options.runner, env: detector.env, cwd: detector.cwd });
    if (recoveryRecord) {
      const transaction = await directInstaller.inspectRecovery(recoveryRecord.plan.transactionRoot);
      const permittedFingerprints = [recoveryRecord.planFingerprint, recoveryRecord.plan.recovery?.originalPlanFingerprint];
      if (transaction.status === 'blocked' || transaction.destinations.some((entry) => entry.disposition === 'changed') ||
          transaction.status !== 'absent' && !permittedFingerprints.includes(transaction.planFingerprint)) {
        throw new DistributionError('Original native transaction changed or cannot be safely inspected; preserve newer content and recovery records.', 'recovery_required');
      }
      recoverTransaction = transaction.status === 'interrupted' || transaction.status === 'committed';
      if (recoverTransaction) {
        if (!transaction.planFingerprint) throw new DistributionError('Original recovery fingerprint is missing.', 'recovery_required');
        originalTransactionFingerprint = transaction.planFingerprint;
      }
      if (transaction.status !== 'interrupted') {
        let receipt;
        try { receipt = await receiptStore.loadDirectReceipt(destinationInput); }
        catch (error) { if (ioCode(error) !== 'ENOENT') throw error; }
        if (receipt) {
          const observed = await detector.observeInstallation(receipt.versionRoot);
          if (observed.result.installation.owner !== 'direct' || observed.candidate?.provenanceDigest !== candidate.provenanceDigest ||
              observed.result.installation.launcherPath !== recoveryRecord.targetInstallation.launcherPath) {
            throw new DistributionError('A newer or different native owner replaced the interrupted target; it was preserved.', 'ownership_conflict');
          }
          targetInstalled = true;
        }
      }
    }
    if (!targetInstalled) directSelection = await directInstaller.select({
      candidate, installRoot: destinationInput, launcherPath: launcherInput, intent: 'migrate',
      ...(recoveryRecord ? { stageIdentity: canonicalSha256(recoveryRecord) } : {}),
      ...(recoverTransaction && originalTransactionFingerprint ? { recoveryFingerprint: originalTransactionFingerprint } : {})
    });
    destinationDirectory = directSelection?.installRoot ?? recoveryRecord!.targetInstallation.destinationDirectory;
    launcherPath = directSelection?.launcherPath ?? recoveryRecord!.targetInstallation.launcherPath;
    transactionRoot = directSelection?.transactionRoot ?? recoveryRecord!.plan.transactionRoot;
    const channel = (await admission.releaseClient.trustRegistration()).channels.find((entry) => entry.owner === 'direct');
    if (!channel) throw new DistributionError('Direct native source is not registered.', 'trust_unregistered');
    sourceId = channel.sourceId;
    sourceDigest = canonicalSha256({ channel, release: candidate.release.manifestDigest });
    targetPackage = channel.packageId;
    targetBinding = directSelection?.bindingDigest ?? canonicalSha256(await receiptStore.loadDirectReceipt(destinationDirectory));
    directLauncher = await captureInstallationPath(launcherPath);
    if (directLauncher.state !== 'absent' && !legacyFacts.launcherPaths.includes(launcherPath) && !targetInstalled && !recoverTransaction) {
      throw new DistributionError('Direct launcher is already occupied by an unapproved owner, including outside PATH.', 'ownership_conflict');
    }
  } else {
    ownerAdapter = detector.ownerAdapters.find((adapter) => adapter.owner === options.toOwner);
    if (!ownerAdapter) throw new DistributionError('The selected native manager is unavailable on this host.', 'tool_unavailable');
    ownerSelection = await ownerAdapter.select(candidate, 'install');
    destinationDirectory = ownerSelection.destinationDirectory;
    launcherPath = ownerSelection.launcherPath;
    if (options.destinationDirectory && await canonicalDestination(options.destinationDirectory, detector.cwd) !== destinationDirectory ||
        options.launcherPath && await canonicalDestination(options.launcherPath, detector.cwd, true) !== launcherPath) {
      throw new DistributionError('Requested target paths differ from the selected manager’s observed destinations.', 'ownership_conflict');
    }
    if (recoveryRecord && (destinationDirectory !== recoveryRecord.targetInstallation.destinationDirectory ||
        launcherPath !== recoveryRecord.targetInstallation.launcherPath ||
        ownerSelection.packageId !== recoveryRecord.targetInstallation.targetPackage ||
        ownerSelection.sourceId !== recoveryRecord.targetInstallation.sourceId)) {
      throw new DistributionError('Manager recovery cannot acquire a different recorded package, source, destination, or launcher.', 'ownership_conflict');
    }
    managerPaths = await Promise.all([destinationDirectory, launcherPath].map(captureInstallationPath));
    if (managerPaths[0].state !== 'absent') {
      if (!recoveryRecord || !sourceRetired || managerPaths[0].state !== 'directory') {
        throw new DistributionError('The manager destination is occupied outside this recorded recovery scope; legacy retirement is not authorized.', 'ownership_conflict');
      }
      const installedCandidate = await admission.admitBundle(destinationDirectory);
      if (installedCandidate.provenanceDigest !== candidate.provenanceDigest ||
          installedCandidate.release.manifestDigest !== candidate.release.manifestDigest) {
        throw new DistributionError('The recorded manager destination contains a different native release; it was preserved.', 'ownership_conflict');
      }
      await ownerAdapter.verify(installedCandidate, ownerSelection);
      targetInstalled = true;
    }
    if (managerPaths[1].state !== 'absent' && !targetInstalled && !legacyFacts.launcherPaths.includes(launcherPath)) {
      throw new DistributionError('The manager launcher is owned by an unapproved installation, including outside PATH; legacy retirement is not authorized.', 'ownership_conflict');
    }
    transactionRoot = await installationTransactionRoot([destinationDirectory, launcherPath]);
    sourceId = ownerSelection.sourceId;
    sourceDigest = ownerSelection.sourceDigest;
    targetPackage = ownerSelection.packageId;
    targetBinding = ownerSelection.bindingDigest;
  }
  for (const targetPath of [destinationDirectory, launcherPath]) await assertInstallationNotProjectOwned(targetPath, receiptStore.homeDirectory);
  if (sourceRetired) await assertRetiredLegacy(legacyFacts, launcherPath, targetInstalled || recoverTransaction);
  const observedPaths = await observePathLaunchers(detector.env, detector.cwd);
  if (observedPaths.some((entry) => !legacyFacts.launcherPaths.includes(entry.path) && entry.path !== launcherPath)) {
    throw new DistributionError('A new unrelated PATH installation blocks this exact recovery scope.', 'ownership_conflict');
  }
  for (const root of [transactionRoot, legacyFacts.prefix]) await assertNoInstallationTransaction(root, recoverTransaction && root === transactionRoot);
  const now = options.now ?? (() => new Date());
  const current = now().getTime();
  if (!Number.isFinite(current)) throw new DistributionError('The native review clock is invalid.');
  const windowStart = Math.floor(current / (30 * 60_000)) * (30 * 60_000);
  const createdAt = new Date(windowStart).toISOString();
  const expiresAt = new Date(windowStart + 30 * 60_000).toISOString();
  const pathDigest = canonicalSha256(await observePathLaunchers(detector.env, detector.cwd));
  const bindingDigest = canonicalSha256({
    candidate: candidate.identityDigest, legacy: legacyFacts.evidenceDigest, targetBinding, pathDigest,
    managerPaths: managerPaths ?? null,
    environment: Object.fromEntries(Object.entries(detector.env).filter(([, value]) => value !== undefined)),
    cwd: detector.cwd, transactionRoot, createdAt, expiresAt
  });
  const plan = buildMigrationPlan({
    platform: admission.host.os, architecture: admission.host.arch, legacyInstallation: legacyFacts,
    targetOwner: options.toOwner, targetPackage, targetVersion: candidate.version, candidatePath: candidate.bundleRoot,
    candidateIdentity: candidate.identityDigest, destinationDirectory, launcherPath, transactionRoot,
    sourceId, sourceDigest, bindingDigest, createdAt, expiresAt,
    recoveryCommand: formatShellCommand({
      executable: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund',
        `${legacyFacts.packageName}@${legacyFacts.installedVersion}`, '--prefix', legacyFacts.prefix]
    }, commandShellForPlatform(process.platform)),
    ...(recoveryRecord ? {
      recovery: {
        migrationId: recoveryRecord.migrationId, recordDigest: canonicalSha256(recoveryRecord), sourceRetired, targetInstalled,
        recoverTransaction, originalPlanFingerprint: originalTransactionFingerprint ?? recoveryRecord.planFingerprint
      }
    } : {})
  });
  preparedPlans.set(plan, {
    detector, admission, receiptStore, candidate, legacy, recoveryRecord, directInstaller, directSelection, ownerAdapter, ownerSelection,
    managerPaths, directLauncher, pathDigest, now
  });
  return plan;
}

export async function assertRetiredLegacy(
  facts: LegacyInstallationFacts, targetLauncher: string, allowRecordedTarget: boolean
): Promise<void> {
  for (const entry of [facts.packageRoot, ...facts.launcherPaths.filter((launcher) => launcher !== targetLauncher || !allowRecordedTarget)]) {
    try {
      await lstat(entry);
      throw new DistributionError('A legacy or newer owner reappeared after recorded retirement; no repeated removal or overwrite is authorized.', 'ownership_conflict');
    } catch (error) { if (ioCode(error) !== 'ENOENT') throw error; }
  }
}
