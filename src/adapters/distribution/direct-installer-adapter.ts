import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { createDirectReceipt } from '../../domain/distribution/direct-receipt.js';
import type { DirectInstallReceipt } from '../../domain/distribution/contracts.js';
import { DistributionError, LockedFileHandoverError, NativeCommandFailure } from '../../domain/distribution/errors.js';
import { captureNativeTransactionOutcome, type NativeInstallationTransactionOutcome } from '../../domain/distribution/transaction-outcome.js';
import { digest, freeze } from '../../domain/distribution/validation.js';
import { type CommandRunner } from '../../process-runner.js';
import { NativeCommandRunner, assertNativeCommandInvocation } from './native-command-runner.js';
import type { ProjectMutationLease } from '../filesystem/project-lock.js';
import {
  applyReviewedUpdateTransaction, inspectReviewedUpdateTransaction, recoverReviewedUpdateTransaction,
  type ReviewedSkillsDirectorySnapshot, type ReviewedUpdateTransactionCheckpoint
} from '../filesystem/reviewed-update-transaction.js';
import { captureSkillFile } from '../skills/discovery.js';
import { getUpdatePreviewDirectory, nodeUpdatePreviewFileSystem } from '../filesystem/update-previews.js';
import {
  NativeAdmission, assertNativeCommandSucceeded, nativeProbeEnvironment, type AdmittedNativeCandidate
} from './native-admission.js';
import {
  canonicalDestination, canonicalNativeRoot, hashNativeFile, nativePathParts, nativeDirectorySnapshot
} from './native-files.js';
import {
  assertInstallationPaths, captureInstallationPath, installationTransactionRoot, within, type InstallationPathBinding
} from './installation-binding.js';
import { observePathLaunchers } from './launcher-observation.js';
import { ReceiptStore, DIRECT_RECEIPT_FILENAME, ensureNativeDirectory } from './receipt-store.js';
import {
  assertDirectLauncherIdentity, assertWindowsDirectLayout, assertWindowsLauncherAbi, captureNativeLauncher,
  NATIVE_LAUNCHER_MAX_BYTES, WINDOWS_DIRECT_LAUNCHER_ABI_ARGUMENT, windowsDirectLauncherBytes
} from './native-launcher.js';

export interface DirectInstallerOptions {
  receiptStore?: ReceiptStore;
  runner?: CommandRunner;
  admission?: NativeAdmission;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  platform?: NodeJS.Platform;
  onCheckpoint?: (checkpoint: ReviewedUpdateTransactionCheckpoint) => Promise<void>;
}

export interface DirectInstallSelection {
  candidate: AdmittedNativeCandidate;
  installRoot: string;
  launcherPath: string;
  versionRoot: string;
  transactionRoot: string;
  intent: 'migrate' | 'upgrade';
  bindingDigest: string;
  currentReceipt?: DirectInstallReceipt;
  recoveryFingerprint?: string;
}

export interface StagedInstallResult {
  selection: DirectInstallSelection;
  candidate: AdmittedNativeCandidate;
  receipt: DirectInstallReceipt;
  launcherContent: string | Buffer;
  stagedVersionRoot: string;
  receiptPath: string;
  launcherPath: string;
}

interface DirectSelectionState {
  bindings: readonly InstallationPathBinding[];
  recoveryCompleted?: boolean;
}

interface DirectStageState {
  bindings: readonly InstallationPathBinding[];
  launcherBytes: string;
}

export class DirectInstallerAdapter {
  readonly receiptStore: ReceiptStore;
  readonly admission: NativeAdmission;
  private readonly runner: CommandRunner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly platform: NodeJS.Platform;
  private readonly onCheckpoint?: DirectInstallerOptions['onCheckpoint'];
  private readonly selections = new WeakMap<DirectInstallSelection, DirectSelectionState>();
  private readonly stages = new WeakMap<StagedInstallResult, DirectStageState>();

  constructor(options: DirectInstallerOptions = {}) {
    this.admission = options.admission ?? new NativeAdmission(options);
    this.env = Object.freeze({ ...options.env ?? this.admission.env });
    this.cwd = options.cwd ?? this.admission.cwd;
    this.receiptStore = options.receiptStore ?? new ReceiptStore({ env: this.env });
    this.runner = options.runner ?? new NativeCommandRunner();
    this.platform = options.platform ?? process.platform;
    this.onCheckpoint = options.onCheckpoint;
  }

  async select(params: {
    candidate: AdmittedNativeCandidate; installRoot: string; launcherPath: string; intent: 'migrate' | 'upgrade'; currentReceipt?: DirectInstallReceipt;
    stageIdentity?: string; recoveryFingerprint?: string;
  }): Promise<DirectInstallSelection> {
    this.admission.assertAdmitted(params.candidate);
    if (this.platform !== this.admission.host.os || this.platform !== process.platform) {
      throw new DistributionError('Direct installation cannot substitute a different platform for its actual admitted host.', 'unsupported_host');
    }
    const trust = await this.admission.releaseClient.trustRegistration();
    if (!trust.channels.some((entry) => entry.owner === 'direct' && entry.packageId === 'liftoff')) {
      throw new DistributionError('The direct native delivery channel has not been registered.', 'trust_unregistered');
    }
    const installRoot = await canonicalDestination(params.installRoot, this.cwd);
    const launcherPath = await canonicalDestination(params.launcherPath, this.cwd, true);
    const expectedLauncher = directLauncherName(this.platform);
    if (path.basename(launcherPath) !== expectedLauncher) throw new DistributionError('Direct launcher must use the registered native command name.', 'unsafe_path');
    assertDirectHandoverImplementation(this.platform);
    if (this.platform === 'win32') assertWindowsDirectLayout(installRoot, launcherPath);
    assertNativeCommandInvocation({ executable: launcherPath, args: ['--version'] }, { cwd: this.cwd }, this.admission.host.os);
    if (params.stageIdentity) digest(params.stageIdentity, 'Reviewed recovery stage identity');
    const versionRoot = path.join(installRoot, 'versions', `${params.candidate.version}-${params.candidate.provenanceDigest.slice(0, 16)}${params.stageIdentity ? `-${params.stageIdentity.slice(0, 16)}` : ''}`);
    if (within(installRoot, params.candidate.bundleRoot) || within(params.candidate.bundleRoot, installRoot)) {
      throw new DistributionError('Unlinked candidate and destination payload must be distinct nonoverlapping roots.', 'unsafe_path');
    }
    for (const privateRoot of [this.receiptStore.baseDirectory, getUpdatePreviewDirectory(this.receiptStore.storageOptions)]) {
      if (within(installRoot, privateRoot) || within(privateRoot, installRoot) || within(privateRoot, launcherPath)) {
        throw new DistributionError('Installation destinations cannot overlap private transaction or verification storage.', 'unsafe_path');
      }
    }
    const bindings = await Promise.all([installRoot, versionRoot, launcherPath, path.join(installRoot, DIRECT_RECEIPT_FILENAME)].map(captureInstallationPath));
    let transactionRoot = params.currentReceipt?.authority?.transactionRoot ??
      await installationTransactionRoot([path.join(installRoot, DIRECT_RECEIPT_FILENAME), launcherPath]);
    if (transactionRoot === installRoot) transactionRoot = await canonicalNativeRoot(path.dirname(installRoot));
    if (await canonicalNativeRoot(transactionRoot) !== transactionRoot ||
        !within(transactionRoot, installRoot) || !within(transactionRoot, launcherPath)) {
      throw new DistributionError('Direct handover must retain its exact canonical receipt-owned transaction boundary.', 'unsafe_path');
    }
    if (params.recoveryFingerprint) {
      digest(params.recoveryFingerprint, 'Original sealed installation approval');
      const pending = await this.inspectRecovery(transactionRoot);
      if (params.intent !== 'migrate' || pending.status !== 'interrupted' ||
          pending.planFingerprint !== params.recoveryFingerprint || pending.installationIdentity?.intent !== 'migrate' ||
          pending.destinations.some((entry) => entry.disposition === 'changed')) {
        throw new DistributionError('Recovery cannot infer original direct-path ownership or replace a different journal.', 'recovery_required');
      }
    }
    if (bindings[1].state !== 'absent') throw new DistributionError('Versioned destination is already occupied; retained payloads are never overwritten or cleaned implicitly.', 'ownership_conflict');
    if (params.intent === 'upgrade') {
      const receipt = await this.receiptStore.loadDirectReceipt(installRoot);
      if (!receipt || !params.currentReceipt || canonicalJson(receipt) !== canonicalJson(params.currentReceipt) ||
          receipt.launcherPath !== launcherPath || bindings[2].state !== 'launcher' || bindings[2].launcher?.state !== 'file') {
        throw new DistributionError('Direct upgrade requires the exact current receipt-owned installation and launcher.', 'ownership_conflict');
      }
    } else if (bindings[3].state !== 'absent' && !params.recoveryFingerprint) {
      throw new DistributionError('An existing installation receipt cannot be acquired during npm handover.', 'ownership_conflict');
    }
    if (transactionRoot === path.parse(transactionRoot).root) throw new DistributionError('Direct destinations do not have a safely bounded installation transaction root.', 'unsafe_path');
    const selection: DirectInstallSelection = freeze({
      ...params, installRoot, launcherPath, versionRoot, transactionRoot,
      bindingDigest: canonicalSha256({ bindings, candidate: params.candidate.identityDigest, transactionRoot, intent: params.intent,
        receipt: params.currentReceipt ?? null })
    });
    this.selections.set(selection, { bindings });
    return selection;
  }

  async recheck(selection: DirectInstallSelection): Promise<void> {
    const state = this.selections.get(selection);
    if (!state) throw new DistributionError('Direct operation has no internally bound selection.', 'stale_plan');
    await this.admission.recheck(selection.candidate);
    await assertInstallationPaths(state.bindings);
    if (selection.currentReceipt && canonicalJson(await this.receiptStore.loadDirectReceipt(selection.installRoot)) !== canonicalJson(selection.currentReceipt)) {
      throw new DistributionError('Direct installation receipt changed after selection.', 'stale_plan');
    }
  }

  async stage(selection: DirectInstallSelection, lease: ProjectMutationLease): Promise<StagedInstallResult> {
    await lease.assertHeld();
    await this.recheck(selection);
    if (selection.recoveryFingerprint && !this.selections.get(selection)?.recoveryCompleted) {
      throw new DistributionError('The original sealed transaction must be recovered before staging its newly reviewed continuation.', 'recovery_required');
    }
    await ensureNativeDirectory(path.dirname(selection.versionRoot));
    await lease.assertHeld();
    await mkdir(selection.versionRoot, { mode: 0o700 });
    for (const file of selection.candidate.provenance.files) {
      await lease.assertHeld();
      const parts = nativePathParts(file.path);
      const destination = path.join(selection.versionRoot, ...parts);
      await ensureNativeDirectory(path.dirname(destination));
      await copyFile(path.join(selection.candidate.bundleRoot, ...parts), destination, constants.COPYFILE_EXCL);
      await chmod(destination, file.mode);
      const handle = await nodeUpdatePreviewFileSystem.openFile(destination, 'read', file.mode);
      try { await handle.sync(); } finally { await handle.close(); }
      await nodeUpdatePreviewFileSystem.syncDirectory(path.dirname(destination));
    }
    await this.admission.recheck(selection.candidate);
    const candidate = await this.admission.admitBundle(selection.versionRoot);
    await this.admission.probe(candidate);
    await lease.assertHeld();
    const launcherContent = await this.launcherContent(candidate);
    const receipt = createDirectReceipt({
      version: candidate.version, target: candidate.target, sourceCommit: candidate.sourceCommit,
      installRoot: selection.installRoot, versionRoot: selection.versionRoot, launcherPath: selection.launcherPath,
      runtime: candidate.provenance.runtime, checksumSha256: candidate.archiveDigest,
      authority: {
        id: randomUUID(), manifestDigest: candidate.release.manifestDigest, provenanceDigest: candidate.provenanceDigest,
        launcherSha256: createHash('sha256').update(launcherContent).digest('hex'),
        resources: candidate.provenance.resources, transactionRoot: selection.transactionRoot
      }
    });
    const staged: StagedInstallResult = freeze({
      selection, candidate, receipt, launcherContent, stagedVersionRoot: selection.versionRoot,
      receiptPath: path.join(selection.installRoot, DIRECT_RECEIPT_FILENAME), launcherPath: selection.launcherPath
    });
    this.stages.set(staged, {
      bindings: await Promise.all([
        selection.installRoot, path.dirname(selection.versionRoot), path.dirname(selection.launcherPath)
      ].map(captureInstallationPath)),
      launcherBytes: Buffer.from(launcherContent).toString('base64')
    });
    return staged;
  }

  async activate(stage: StagedInstallResult, planFingerprint: string, lease: ProjectMutationLease): Promise<NativeInstallationTransactionOutcome> {
    if (!this.stages.has(stage)) throw new DistributionError('Direct activation requires this adapter’s admitted staged payload.', 'stale_plan');
    const stagedState = this.stages.get(stage);
    if (!stagedState || Buffer.from(stage.launcherContent).toString('base64') !== stagedState.launcherBytes) {
      throw new DistributionError('Direct stage directory or exact launcher byte bindings changed.', 'stale_plan');
    }
    await assertInstallationPaths(stagedState.bindings);
    await this.admission.recheck(stage.candidate);
    await lease.assertHeld();
    const { selection } = stage;
    if (selection.intent === 'upgrade') {
      const original = this.selections.get(selection);
      if (!original) throw new DistributionError('Direct upgrade selection is no longer bound.', 'stale_plan');
      await assertInstallationPaths(original.bindings.filter((entry) => [selection.launcherPath, stage.receiptPath].includes(entry.path)));
    }
    const root = selection.transactionRoot;
    await ensureNativeDirectory(path.dirname(selection.launcherPath));
    await ensureNativeDirectory(path.join(root, '.liftoff'));
    const launcherParts = path.relative(root, selection.launcherPath).split(path.sep);
    const receiptParts = path.relative(root, stage.receiptPath).split(path.sep);
    const launcher = await captureNativeLauncher(root, launcherParts);
    const receipt = await captureSkillFile(root, receiptParts);
    if (selection.intent === 'migrate' && launcher.file ||
        selection.intent === 'upgrade' && (!launcher.file ||
          launcher.file.sha256 !== selection.currentReceipt?.authority?.launcherSha256) ||
        selection.intent === 'migrate' && receipt.observation.state !== 'absent' ||
        selection.intent === 'upgrade' && canonicalJson(await this.receiptStore.loadDirectReceipt(selection.installRoot)) !== canonicalJson(selection.currentReceipt)) {
      throw new DistributionError('Launcher or receipt is not in the exact approved owner state; no foreign content was replaced.', 'ownership_conflict');
    }
    const directories = await transactionDirectories(root, [launcherParts, receiptParts, ['.liftoff', 'reviewed-installation-transaction.json']]);
    await this.receiptStore.recordDirectAuthority(stage.receipt);
    let settlement: 'settled' | 'unconfirmed' = 'settled';
    try {
      const outcome = await applyReviewedUpdateTransaction(root, [
        { type: 'write', pathParts: receiptParts, content: `${JSON.stringify(stage.receipt)}\n`, mode: 0o600 },
        { type: 'write', pathParts: launcherParts, content: Buffer.from(stagedState.launcherBytes, 'base64'), mode: 0o755 }
      ], {
        transactionKind: 'installation', planFingerprint, approvalStore: this.receiptStore.approvalStore(root),
        installationIdentity: {
          schemaVersion: 1, recipe: 'native-direct-handover', intent: selection.intent, version: stage.candidate.version,
          candidateIdentity: stage.candidate.identityDigest, launcherPathParts: launcherParts, receiptPathParts: receiptParts
        },
        installationDirectories: directories,
        preconditions: [launcher.snapshot, receipt.snapshot],
        validatePlan: async () => { await lease.assertHeld(); await this.admission.recheck(stage.candidate); },
        onCheckpoint: async (checkpoint) => {
          await this.onCheckpoint?.(checkpoint);
          await lease.assertHeld();
          await this.admission.recheck(stage.candidate);
          if (!await this.receiptStore.verifyDirectAuthority(stage.receipt)) {
            throw new DistributionError('Private direct installation authority was lost; retain the staged payload and sealed recovery.', 'recovery_required');
          }
          if (checkpoint.phase === 'committed') {
            try { await this.verifyInstallation(stage); }
            catch (error) {
              if (error instanceof NativeCommandFailure && error.settled !== true) settlement = 'unconfirmed';
              throw error;
            }
          }
        }
      });
      return captureNativeTransactionOutcome(outcome, settlement);
    } catch (error) {
      throw nativeHandoverError(error, this.platform, selection.launcherPath);
    }
  }

  async verifyInstallation(stage: StagedInstallResult): Promise<void> {
    if (!this.stages.has(stage)) throw new DistributionError('Direct readback has no admitted stage.', 'stale_plan');
    const actual = await this.receiptStore.loadDirectReceipt(stage.selection.installRoot);
    if (canonicalJson(actual) !== canonicalJson(stage.receipt)) throw new DistributionError('Installed direct receipt differs from the selected replacement.', 'verification_failed');
    const launcher = await hashNativeFile(path.dirname(stage.launcherPath), [path.basename(stage.launcherPath)], NATIVE_LAUNCHER_MAX_BYTES);
    assertDirectLauncherIdentity(stage.receipt, stage.candidate.provenance, launcher);
    if (this.platform === 'win32') await this.probeWindowsLauncherAbi(stage.candidate);
    await this.admission.probe(stage.candidate);
    const probe = async (): Promise<void> => {
      const result = await this.runner.run({ executable: stage.launcherPath, args: ['--version'] }, {
        cwd: stage.selection.transactionRoot, env: nativeProbeEnvironment(this.env), timeoutMs: 15_000,
        maxOutputBytes: 4096, ensureProcessTreeSettled: true
      });
      assertNativeCommandSucceeded(result, 'Direct replacement launcher verification');
      if (result.stdout.trim() !== `Liftoff ${stage.candidate.version}` || result.stderr.trim()) {
        throw new DistributionError('Replacement launcher did not report the exact native product/version.', 'verification_failed');
      }
    };
    await probe();
    const ordinary = await observePathLaunchers(this.env, this.cwd);
    if (ordinary[0]?.path !== stage.launcherPath || ordinary[0]?.state !== 'file' ||
        ordinary[0].file.sha256 !== launcher.sha256) {
      throw new DistributionError('Explicit replacement verifies, but ordinary PATH selects another launcher; cutover remains incomplete.', 'verification_failed');
    }
    await probe();
    await this.admission.recheck(stage.candidate);
    if (canonicalJson(await this.receiptStore.loadDirectReceipt(stage.selection.installRoot)) !== canonicalJson(stage.receipt)) {
      throw new DistributionError('The exact direct receipt or private ownership authority changed during replacement readback.', 'verification_failed');
    }
    if (canonicalSha256(await hashNativeFile(path.dirname(stage.launcherPath), [path.basename(stage.launcherPath)], NATIVE_LAUNCHER_MAX_BYTES)) !== canonicalSha256(launcher)) {
      throw new DistributionError('Direct launcher changed during replacement readback.', 'verification_failed');
    }
    const finalOrdinary = await observePathLaunchers(this.env, this.cwd);
    if (canonicalSha256(finalOrdinary[0] ?? null) !== canonicalSha256(ordinary[0] ?? null)) {
      throw new DistributionError('Ordinary command resolution changed during direct replacement readback.', 'verification_failed');
    }
  }

  async inspectRecovery(root: string) {
    return inspectReviewedUpdateTransaction(root, { transactionKind: 'installation', approvalStore: this.receiptStore.approvalStore(root) });
  }

  async recoverSelection(selection: DirectInstallSelection, lease: ProjectMutationLease): Promise<NativeInstallationTransactionOutcome> {
    const state = this.selections.get(selection);
    if (!state || !selection.recoveryFingerprint) throw new DistributionError('No exact original recovery was selected.', 'recovery_required');
    await lease.assertHeld();
    await this.recheck(selection);
    const outcome = await this.recoverOriginalTransaction(selection.transactionRoot, selection.recoveryFingerprint, lease);
    if (outcome.status !== 'rolled-back' || outcome.rollbackFailures.length || outcome.cleanupFailures.length) {
      return outcome;
    }
    const receiptPath = path.join(selection.installRoot, DIRECT_RECEIPT_FILENAME);
    const updated = await Promise.all(state.bindings.map(async (original) => {
      if (original.path !== receiptPath && original.path !== selection.launcherPath) return original;
      const current = await captureInstallationPath(original.path);
      if (current.state !== 'absent') throw new DistributionError('Recovery did not restore the exact original absent native owner paths.', 'recovery_required');
      return current;
    }));
    state.bindings = updated;
    state.recoveryCompleted = true;
    return outcome;
  }

  async verifyOwnedInstallation(installRoot: string, expectedVersion: string, expectedProvenance: string): Promise<void> {
    const receipt = await this.receiptStore.loadDirectReceipt(installRoot);
    if (!receipt || !receipt.authority || receipt.version !== expectedVersion || receipt.authority.provenanceDigest !== expectedProvenance) {
      throw new DistributionError('Existing direct owner does not identify the exact recorded handover target.', 'ownership_conflict');
    }
    const candidate = await this.admission.admitBundle(receipt.versionRoot);
    if (candidate.provenanceDigest !== receipt.authority.provenanceDigest || candidate.release.manifestDigest !== receipt.authority.manifestDigest ||
        candidate.sourceCommit !== receipt.sourceCommit || candidate.target !== receipt.target || candidate.archiveDigest !== receipt.checksumSha256 ||
        canonicalJson(candidate.provenance.runtime) !== canonicalJson(receipt.runtime) ||
        canonicalJson(candidate.provenance.resources) !== canonicalJson(receipt.authority.resources)) {
      throw new DistributionError('Direct recovery readback differs from the exact signed receipt payload.', 'ownership_conflict');
    }
    const selection: DirectInstallSelection = freeze({
      candidate, installRoot, launcherPath: receipt.launcherPath, versionRoot: receipt.versionRoot,
      transactionRoot: receipt.authority.transactionRoot, intent: 'migrate', bindingDigest: canonicalSha256(receipt)
    });
    const launcherContent = await this.launcherContent(candidate);
    const stage: StagedInstallResult = freeze({
      selection, candidate, receipt, launcherContent,
      stagedVersionRoot: receipt.versionRoot, receiptPath: path.join(installRoot, DIRECT_RECEIPT_FILENAME), launcherPath: receipt.launcherPath
    });
    this.stages.set(stage, { bindings: [], launcherBytes: Buffer.from(launcherContent).toString('base64') });
    await this.verifyInstallation(stage);
  }

  async recoverOriginalTransaction(root: string, fingerprint: string, lease?: ProjectMutationLease): Promise<NativeInstallationTransactionOutcome> {
    let settlement: 'settled' | 'unconfirmed' = 'settled';
    const outcome = await recoverReviewedUpdateTransaction(root, {
      transactionKind: 'installation', approvalStore: this.receiptStore.approvalStore(root),
      validateRecovery: async (recorded) => {
        await lease?.assertHeld();
        if (recorded !== fingerprint) throw new DistributionError('Recovery fingerprint differs from the original sealed native transaction.', 'stale_plan');
      },
      onCommittedReadback: async () => {
        await lease?.assertHeld();
        const journal = await this.inspectRecovery(root);
        const identity = journal.installationIdentity;
        if (journal.status !== 'committed' || journal.planFingerprint !== fingerprint || !identity) {
          throw new DistributionError('Committed native recovery lacks its exact original identity.', 'recovery_required');
        }
        const receiptPath = path.join(root, ...identity.receiptPathParts);
        const receipt = await this.receiptStore.loadDirectReceipt(path.dirname(receiptPath));
        if (!receipt?.authority || receipt.launcherPath !== path.join(root, ...identity.launcherPathParts) ||
            receipt.version !== identity.version) {
          throw new DistributionError('Committed native recovery no longer has its original receipt and launcher.', 'ownership_conflict');
        }
        const candidate = await this.admission.admitBundle(receipt.versionRoot);
        if (candidate.identityDigest !== identity.candidateIdentity) {
          throw new DistributionError('Committed candidate bytes, directories, or authority changed before recovery readback.', 'stale_plan');
        }
        try { await this.verifyOwnedInstallation(receipt.installRoot, identity.version, receipt.authority.provenanceDigest); }
        catch (error) {
          if (error instanceof NativeCommandFailure && error.settled !== true) settlement = 'unconfirmed';
          throw error;
        }
        await lease?.assertHeld();
      }
    });
    return captureNativeTransactionOutcome(outcome, settlement);
  }

  private async launcherContent(candidate: AdmittedNativeCandidate): Promise<string | Buffer> {
    this.admission.assertAdmitted(candidate);
    if (this.platform !== 'win32') return directLauncherContent(candidate, this.platform);
    await this.probeWindowsLauncherAbi(candidate);
    const captured = await captureNativeLauncher(candidate.bundleRoot, nativePathParts(candidate.provenance.entrypoints.launcher));
    if (!captured.snapshot.content) throw new DistributionError('The admitted Windows launcher is missing.', 'artifact_mismatch');
    return windowsDirectLauncherBytes(captured.snapshot.content, candidate.provenance);
  }

  private async probeWindowsLauncherAbi(candidate: AdmittedNativeCandidate): Promise<void> {
    await this.admission.recheck(candidate);
    const result = await this.runner.run({
      executable: path.join(candidate.bundleRoot, ...nativePathParts(candidate.provenance.entrypoints.launcher)),
      args: [WINDOWS_DIRECT_LAUNCHER_ABI_ARGUMENT]
    }, {
      cwd: candidate.bundleRoot, env: nativeProbeEnvironment(this.env), timeoutMs: 15_000,
      maxOutputBytes: 4096, ensureProcessTreeSettled: true
    });
    assertNativeCommandSucceeded(result, 'Windows direct launcher ABI verification');
    if (result.stderr) throw new DistributionError('Windows launcher ABI verification emitted an unexpected diagnostic.', 'verification_failed');
    assertWindowsLauncherAbi(result.stdout, candidate.target);
    await this.admission.recheck(candidate);
  }
}

export function nativeHandoverError(error: unknown, platform: NodeJS.Platform, launcher: string): Error {
  if (platform === 'win32' && error instanceof Error && /\b(?:EPERM|EACCES|EBUSY)\b|file.*in use/iu.test(error.message)) {
    if (error.message.includes(launcher) || /(?:launcher|liftoff\.exe).*(?:in use|locked)|failed to write [^\r\n]*liftoff\.exe:/iu.test(error.message)) {
      return new LockedFileHandoverError(launcher);
    }
    return new DistributionError(
      'Direct installation storage or host file policy prevented handover. Preserve the exact recovery evidence; closing a launcher does not restore missing private authority or grant elevation.',
      'policy_blocked', { cause: error }
    );
  }
  return error instanceof Error ? error : new DistributionError('Direct native handover failed.', 'effect_failed', { cause: error });
}

export function directLauncherContent(candidate: AdmittedNativeCandidate, platform = process.platform): string {
  assertDirectHandoverImplementation(platform);
  if (platform === 'win32') {
    throw new DistributionError('Windows direct launchers require the exact admitted PE bytes and verified receipt ABI, never rendered script bytes.', 'artifact_mismatch');
  }
  const runtime = path.join(candidate.bundleRoot, ...nativePathParts(candidate.provenance.entrypoints.runtime));
  const cli = path.join(candidate.bundleRoot, ...nativePathParts(candidate.provenance.entrypoints.cli));
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  return `#!/bin/sh\nexec ${quote(runtime)} ${quote(cli)} "$@"\n`;
}

export function directLauncherName(platform: NodeJS.Platform): 'liftoff' | 'liftoff.exe' {
  if (platform === 'win32') return 'liftoff.exe';
  if (platform === 'darwin' || platform === 'linux') return 'liftoff';
  throw new DistributionError('Direct native installation requires a supported host.', 'unsupported_host');
}

export function assertDirectHandoverImplementation(platform: NodeJS.Platform): void {
  directLauncherName(platform);
}

async function transactionDirectories(root: string, paths: readonly string[][]): Promise<ReviewedSkillsDirectorySnapshot[]> {
  const parents = new Map<string, string[]>([['', []]]);
  for (const parts of paths) for (let count = 1; count < parts.length; count += 1) {
    const prefix = parts.slice(0, count);
    parents.set(prefix.join('/'), prefix);
  }
  const result: ReviewedSkillsDirectorySnapshot[] = [];
  for (const pathParts of parents.values()) {
    const identity = await nativeDirectorySnapshot(path.join(root, ...pathParts));
    result.push({ pathParts, state: 'directory', device: identity.device, inode: identity.inode, mode: identity.mode });
  }
  return result;
}
