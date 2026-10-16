import { randomUUID } from 'node:crypto';
import { access, realpath, symlink, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { defaultSelfUpgradeDependencies, resolveSelectedLiftoff, type SelfUpgradeDependencies } from '../../adapters/distribution/upgrade-host.js';
import { inspectNpmFiles } from '../../adapters/distribution/npm.js';
import { assertCaskOwnership, nativePolicy, createNativeUpgradePort } from '../../adapters/distribution/native.js';
import { admitNativeStableMaterial } from '../../adapters/distribution/native-metadata.js';
import type { MacMigrationCaskPort } from '../../adapters/distribution/mac-migration-cask.js';
import { createHomebrewCaskPreparation } from '../../adapters/distribution/native-cask-plan.js';
import {
  discoverMacNpmSelections, inspectMacNpmOwner, macMigrationHash, migrationDirectory, migrationEnvironment,
  migrationFileIdentity, migrationProbe, assertMigrationTools, assertMigrationOutsideOldScope
} from '../../adapters/distribution/mac-npm-owner.js';
import {
  captureMigrationTree, copyMigrationTree, MacMigrationJournalStore, migrationAbsent, migrationLauncher,
  migrationParentIdentities as parentIdentities, restoreMigrationTree, syncMigrationDirectory,
  assertMigrationRecoveryJournalBudget, migrationJournalUnsettled, type MigrationJournal, type MigrationTree
} from '../../adapters/distribution/mac-migration-state.js';
import { commandFailed } from '../../domain/distribution/liftoff-npm-installation.js';
import { SelfUpgradeFailure } from '../../domain/distribution/liftoff-upgrade.js';
import { installedPackageRoot } from '../../adapters/packaged-assets/package-root.js';
import {
  MacMigrationFailure, type MacMigrationBrew, type MacMigrationHost, type MacMigrationReport,
  type MacNpmOwner, type MacNpmSelection
} from '../../domain/distribution/mac-migration.js';
import type { CaskPreparationPort, NativeCandidate } from '../../domain/distribution/native-upgrade.js';

export interface MacMigrationRequest {
  selection?: MacNpmSelection;
  brew?: string;
  recovery?: string;
  apply?: { review: string; journalRoot: string };
  recover?: { journalRoot: string; journalSha256: string; deadLockSha256?: string };
}

export interface MacMigrationDependencies {
  upgrade: SelfUpgradeDependencies;
  host(): Promise<MacMigrationHost>;
  cask?: MacMigrationCaskPort;
  preparation?: Pick<CaskPreparationPort, 'preview'>;
}

async function bounded<T>(read: (signal: AbortSignal) => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController();
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new MacMigrationFailure('cask-observation-timeout')); }, timeoutMs);
    });
    const observed = await Promise.race([read(controller.signal), timeout]);
    if (controller.signal.aborted || performance.now() - started >= timeoutMs) {
      throw new MacMigrationFailure('cask-observation-timeout');
    }
    return observed;
  } finally { clearTimeout(timer); controller.abort(); }
}

function assertMacHost(host: MacMigrationHost): void {
  if (host.platform !== 'darwin' || host.architecture !== 'arm64' || host.nativeArchitecture !== 'arm64' ||
    host.appleSilicon !== '1' || !['', '0'].includes(host.translated)) throw new MacMigrationFailure('apple-silicon-only');
  const parts = host.osVersion.split('.').map(Number);
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(host.osVersion) || parts[0] < 13 || parts[0] === 13 && parts[1] < 5) {
    throw new MacMigrationFailure('unsupported-macos');
  }
}

async function brewObservation(executable: string | undefined, owner: MacNpmOwner,
  dependencies: SelfUpgradeDependencies, scratch: string): Promise<MacMigrationBrew> {
  if (!executable || !path.isAbsolute(executable)) throw new MacMigrationFailure('approved-existing-homebrew-required');
  const selected = await realpath(executable);
  assertMigrationOutsideOldScope(owner.packageRoot, [selected]);
  await access(selected, constants.X_OK);
  const prefix = await migrationProbe(dependencies, scratch, owner.node, selected, ['--prefix']);
  await migrationDirectory(prefix, true);
  await migrationDirectory(path.join(prefix, 'bin'), true);
  return { executable: selected, prefix, identity: macMigrationHash(JSON.stringify([
    await migrationFileIdentity(selected), await migrationDirectory(prefix), await migrationDirectory(path.join(prefix, 'bin'))
  ])) };
}

async function recoveryObservation(owner: MacNpmOwner, recovery: string | undefined, tree: MigrationTree,
  dependencies: SelfUpgradeDependencies, scratch: string): Promise<MigrationTree> {
  if (!recovery || !path.isAbsolute(recovery) || await realpath(recovery) !== recovery ||
    recovery === owner.packageRoot || recovery.startsWith(`${owner.prefix}/`)) throw new MacMigrationFailure('independent-offline-recovery-required');
  const observed = await captureMigrationTree(recovery);
  if (observed.content !== tree.content) throw new MacMigrationFailure('wrong-offline-recovery');
  const files = await inspectNpmFiles(recovery, owner.version, dependencies);
  if (await migrationProbe(dependencies, scratch, owner.node, owner.node, [files.binary, '--version']) !== `Liftoff ${owner.version}` ||
    (await captureMigrationTree(recovery)).physical !== observed.physical) throw new MacMigrationFailure('offline-recovery-verification-failed');
  return observed;
}

const selectedReport = (owner: MacNpmOwner) => ({
  manager: owner.manager, version: owner.version, packageRoot: owner.packageRoot, npm: owner.npm, prefix: owner.prefix
});
const targetReport = (cask: MacMigrationCaskPort, candidate: NativeCandidate) => ({
  cask: cask.policy.homebrew.cask!, version: candidate.version,
  manifestSha256: candidate.manifestSha256, inventorySha256: candidate.inventorySha256
});
async function verifyCask(journal: MigrationJournal, dependencies: MacMigrationDependencies, scratch: string):
  Promise<NonNullable<MacMigrationReport['verification']>> {
  const cask = dependencies.cask!;
  const observed = await bounded(signal => cask.installed(journal.brew, journal.candidate, signal));
  assertCaskOwnership(observed.ownership, observed.inventory, nativePolicy(cask.policy));
  const inventory = observed.inventory;
  if (inventory.version !== journal.candidate.version || inventory.manifestSha256 !== journal.candidate.manifestSha256 ||
    inventory.inventorySha256 !== journal.candidate.inventorySha256 || inventory.sourceCommit !== journal.candidate.sourceCommit ||
    inventory.target !== 'darwin-arm64') throw new MacMigrationFailure('cask-assets-mismatch');
  const port = createNativeUpgradePort({ ...dependencies.upgrade, execPath: inventory.runtime,
    runner: { run: (command, options) => dependencies.upgrade.runner.run(command, { ...options, inheritEnvironment: false }) },
    environment: migrationEnvironment(dependencies.upgrade, scratch, inventory.runtime),
    runningExecutable: path.join(inventory.packageRoot, 'dist/cli.js'), resolveLiftoff: async () => journal.destination }, {
    cask: async () => observed.ownership
  });
  const installed = await port.inspect(inventory.packageRoot, inventory.version, scratch);
  if (!installed || installed.owner !== 'homebrew-cask' || installed.manifestSha256 !== journal.candidate.manifestSha256 ||
    installed.inventorySha256 !== journal.candidate.inventorySha256) throw new MacMigrationFailure('cask-ownership-unverified');
  if (await migrationProbe(dependencies.upgrade, scratch, installed.runtime, installed.runtime,
    [path.join(installed.packageRoot, 'dist/cli.js'), '--version']) !== `Liftoff ${installed.version}` ||
    await migrationProbe(dependencies.upgrade, scratch, installed.runtime, journal.destination,
      ['--version']) !== `Liftoff ${installed.version}`) {
    throw new MacMigrationFailure('cask-version-verification-failed');
  }
  let selection: 'selected' | 'unresolved' = 'unresolved';
  try {
    const selected = await resolveSelectedLiftoff(dependencies.upgrade.environment, 'darwin');
    if (selected && await realpath(selected) === installed.launcher) selection = 'selected';
  } catch { /* A broken PATH entry is not proof that the separately verified cask failed. */ }
  return { owner: 'homebrew-cask', version: installed.version, assets: 'verified', path: selection, parentShell: 'not-observable' };
}

async function restore(journal: MigrationJournal, store: MacMigrationJournalStore,
  dependencies: MacMigrationDependencies, scratch: string): Promise<void> {
  if (!['npm-removed', 'link-removed', 'cask-settled', 'restore-intent', 'restored'].includes(journal.phase)) {
    throw new MacMigrationFailure('operation-settlement-unproven');
  }
  await assertMigrationTools(journal.owner);
  if (!dependencies.cask || macMigrationHash(JSON.stringify(nativePolicy(dependencies.cask.policy))) !== journal.policyIdentity ||
    (await brewObservation(journal.brew.executable, journal.owner, dependencies.upgrade, scratch)).identity !== journal.brew.identity) {
    throw new MacMigrationFailure('recovery-manager-changed');
  }
  if (!dependencies.cask || !await bounded(signal => dependencies.cask!.absent(journal.brew, journal.candidate, signal))) {
    throw new MacMigrationFailure('cask-absence-unproven');
  }
  const launcherAbsent = await migrationAbsent(journal.owner.launcher);
  const launcherAllowed = launcherAbsent || JSON.stringify(await migrationLauncher(journal.owner.launcher)) ===
    JSON.stringify(journal.restoration?.launcher ?? journal.launcher);
  if (JSON.stringify(await parentIdentities(journal.owner, journal.destination)) !== JSON.stringify(journal.parentIdentities) ||
    journal.destination !== journal.owner.launcher && !await migrationAbsent(journal.destination) ||
    !journal.restoration?.completed.length && !await migrationAbsent(journal.owner.packageRoot) ||
    !launcherAllowed) throw new MacMigrationFailure('recovery-destination-changed');
  const backup = path.join(store.root, 'old-package');
  const tree = await captureMigrationTree(backup);
  if (tree.content !== journal.tree.content || tree.physical !== journal.recoveryPhysical) throw new MacMigrationFailure('recovery-material-changed');
  await recoveryObservation(journal.owner, backup, journal.tree, dependencies.upgrade, scratch);
  journal.phase = 'restore-intent'; await store.save(journal);
  if (!journal.restoration?.completed.length && !await migrationAbsent(journal.owner.packageRoot) ||
    launcherAbsent !== await migrationAbsent(journal.owner.launcher) ||
    journal.destination !== journal.owner.launcher && !await migrationAbsent(journal.destination) ||
    JSON.stringify(await parentIdentities(journal.owner, journal.destination)) !== JSON.stringify(journal.parentIdentities)) {
    throw new MacMigrationFailure('recovery-destination-changed');
  }
  await restoreMigrationTree(backup, journal, store);
  if (launcherAbsent) {
    journal.restoration!.launcherPending = true; await store.save(journal);
    await symlink(journal.launcher.target, journal.owner.launcher);
    await syncMigrationDirectory(path.dirname(journal.owner.launcher));
    journal.restoration!.launcher = await migrationLauncher(journal.owner.launcher);
    if (journal.restoration!.launcher.metadata !== journal.launcher.metadata) throw new MacMigrationFailure('restored-launcher-metadata-mismatch');
    delete journal.restoration!.launcherPending; await store.save(journal);
  }
  if ((await captureMigrationTree(journal.owner.packageRoot)).content !== journal.tree.content ||
    await realpath(journal.owner.launcher) !== journal.owner.binary) throw new MacMigrationFailure('restore-verification-failed');
  if (await migrationProbe(dependencies.upgrade, scratch, journal.owner.node, journal.owner.node,
    [journal.owner.binary, '--version']) !== `Liftoff ${journal.owner.version}`) {
    throw new MacMigrationFailure('restore-version-verification-failed');
  }
  journal.phase = 'restored'; await store.save(journal);
}

export async function runMacMigration(request: MacMigrationRequest, dependencies: MacMigrationDependencies): Promise<MacMigrationReport> {
  const report: MacMigrationReport = { schemaVersion: 1, kind: 'liftoff-mac-npm-migration',
    mode: request.recover ? 'recover' : request.apply ? 'apply' : 'preview', status: 'blocked', effects: 'none', blockers: [] };
  let scratch: string | undefined;
  let store: MacMigrationJournalStore | undefined;
  let journal: MigrationJournal | undefined;
  let locked = false;
  try {
    const host = await dependencies.host();
    assertMacHost(host);
    if (request.apply && request.recover) throw new MacMigrationFailure('contradictory-mode');
    scratch = await dependencies.upgrade.makeNeutralDirectory();
    if (request.recover) {
      store = new MacMigrationJournalStore(request.recover.journalRoot);
      journal = await store.read(request.recover.journalSha256);
      report.selected = selectedReport(journal.owner);
      report.effects = 'possible'; report.status = 'partial';
      if (!dependencies.cask) throw new MacMigrationFailure('native-cask-provider-unqualified');
      if (request.recover.deadLockSha256) await store.selectDeadLock(request.recover.deadLockSha256);
      await store.lock(); locked = true;
      await restore(journal, store, dependencies, scratch);
      report.status = 'restored'; report.effects = 'old-restored';
      return report;
    }
    const selections = request.selection ? [request.selection] : await discoverMacNpmSelections(dependencies.upgrade.environment);
    const owners: MacNpmOwner[] = [];
    const unproven: string[] = [];
    for (const selection of selections) {
      try { owners.push(await inspectMacNpmOwner(selection, dependencies.upgrade, scratch)); }
      catch (error) { unproven.push(error instanceof MacMigrationFailure ? error.code :
        error instanceof SelfUpgradeFailure ? `npm-${error.reasonCode}` : 'unproven-npm-owner'); }
    }
    if (owners.length !== 1 || !request.selection && unproven.length) {
      report.blockers.push(...unproven);
      throw new MacMigrationFailure('explicit-unambiguous-owner-selection-required');
    }
    const owner = owners[0];
    report.selected = selectedReport(owner);
    assertMigrationOutsideOldScope(owner.packageRoot,
      [await realpath(installedPackageRoot), await realpath(dependencies.upgrade.execPath)]);
    const brew = await brewObservation(request.brew, owner, dependencies.upgrade, scratch);
    if (!dependencies.cask) {
      report.blockers.push('native-cask-provider-unqualified');
      const preparation = dependencies.preparation;
      if (preparation) {
        const prepared = await bounded(signal => preparation.preview(brew.prefix, signal));
        if (prepared.destination.prefix !== brew.prefix) throw new MacMigrationFailure('cask-preparation-destination-mismatch');
        report.preparation = prepared;
        report.target = { cask: prepared.cask, version: prepared.target.version,
          manifestSha256: prepared.target.manifestSha256, inventorySha256: prepared.target.inventorySha256 };
        report.blockers.push(prepared.execution.reason);
      }
      return report;
    }
    const cask = dependencies.cask;
    const policy = nativePolicy(cask.policy);
    if (!policy.approvedSigningKeySha256 || !policy.homebrew.cask || !policy.homebrew.sourceRepository ||
      !policy.homebrew.developerTeamId) throw new MacMigrationFailure('native-release-policy-unqualified');
    const packagedPolicy = nativePolicy(await dependencies.upgrade.readJson(
      path.join(installedPackageRoot, 'distribution/native/release-policy.json')));
    if (JSON.stringify(packagedPolicy) !== JSON.stringify(policy)) throw new MacMigrationFailure('packaged-native-policy-mismatch');
    await bounded(signal => cask.admitHost(host, signal));
    const material = await bounded(signal => cask.target(brew, signal));
    const candidate = await admitNativeStableMaterial(material, { target: 'darwin-arm64' }, policy);
    const channel = await bounded(signal => cask.channel(brew, candidate, signal));
    if (channel.status !== 'available' || channel.version !== candidate.version || !channel.exactApply ||
      !channel.identity || channel.artifactSha256 !== candidate.archiveSha256) throw new MacMigrationFailure('exact-cask-unavailable');
    const destination = await bounded(signal => cask.destination(brew, candidate, signal));
    if (destination !== path.join(brew.prefix, 'bin/liftoff')) throw new MacMigrationFailure('unapproved-cask-destination');
    if (destination !== owner.launcher && !await migrationAbsent(destination)) throw new MacMigrationFailure('cask-destination-collision');
    const parents = await parentIdentities(owner, destination);
    const preflight = await bounded(signal => cask.preflight(brew, candidate, owner, signal));
    if (!preflight.identity || preflight.permissions !== 'verified' || preflight.collisions !== 'clear') {
      throw new MacMigrationFailure('cask-scope-preflight-unproven');
    }
    const launcher = await migrationLauncher(owner.launcher);
    const launcherProbe = path.join(scratch, 'recovery-launcher-probe');
    await symlink(launcher.target, launcherProbe);
    const probe = await migrationLauncher(launcherProbe);
    if (JSON.stringify(await migrationLauncher(launcherProbe)) !== JSON.stringify(probe)) {
      throw new MacMigrationFailure('recovery-launcher-probe-changed');
    }
    await unlink(launcherProbe);
    if (probe.metadata !== launcher.metadata) throw new MacMigrationFailure('unrecoverable-launcher-metadata');
    const tree = await captureMigrationTree(owner.packageRoot);
    const recovery = await recoveryObservation(owner, request.recovery, tree, dependencies.upgrade, scratch);
    const policyIdentity = macMigrationHash(JSON.stringify(policy));
    const review = macMigrationHash(JSON.stringify([host, owner, brew, candidate, channel, preflight,
      policyIdentity, destination, parents, launcher, tree, request.recovery, recovery]));
    report.review = review; report.target = targetReport(cask, candidate);
    if (!request.apply) { report.status = 'ready'; return report; }
    if (request.apply.review !== review || !/^[a-f0-9]{64}$/.test(request.apply.review)) throw new MacMigrationFailure('stale-exact-review');
    const journalRoot = request.apply.journalRoot;
    if (!path.isAbsolute(journalRoot) || journalRoot.startsWith(`${owner.prefix}/`) ||
      journalRoot === owner.prefix || journalRoot.startsWith(`${request.recovery}/`)) throw new MacMigrationFailure('independent-journal-required');
    store = new MacMigrationJournalStore(journalRoot);
    await store.initialize(); locked = true;
    await copyMigrationTree(request.recovery!, path.join(store.root, 'old-package'), recovery);
    const backup = await captureMigrationTree(path.join(store.root, 'old-package'));
    await recoveryObservation(owner, path.join(store.root, 'old-package'), tree, dependencies.upgrade, scratch);
    journal = { schemaVersion: 1, kind: 'liftoff-mac-npm-migration-journal', root: store.root,
      rootIdentity: await migrationDirectory(store.root), scratch, operationId: randomUUID(), review, owner, brew, candidate,
      channelIdentity: channel.identity, policyIdentity, destination, parentIdentities: parents, tree,
      recoveryPhysical: backup.physical, launcher, phase: 'prepared' };
    await store.save(journal);
    assertMigrationRecoveryJournalBudget(journal);
    if ((await inspectMacNpmOwner(request.selection ?? owner, dependencies.upgrade, scratch)).identity !== owner.identity ||
      (await captureMigrationTree(owner.packageRoot)).physical !== tree.physical ||
      (await brewObservation(request.brew, owner, dependencies.upgrade, scratch)).identity !== brew.identity ||
      JSON.stringify(await parentIdentities(owner, destination)) !== JSON.stringify(parents) ||
      (await migrationLauncher(owner.launcher)).physical !== launcher.physical) throw new MacMigrationFailure('pre-uninstall-input-changed');
    const freshCandidate = await admitNativeStableMaterial(await bounded(signal => cask.target(brew, signal)), { target: 'darwin-arm64' }, policy);
    const freshChannel = await bounded(signal => cask.channel(brew, freshCandidate, signal));
    const freshPreflight = await bounded(signal => cask.preflight(brew, freshCandidate, owner, signal));
    if (JSON.stringify(freshCandidate) !== JSON.stringify(candidate) || JSON.stringify(freshChannel) !== JSON.stringify(channel) ||
      JSON.stringify(freshPreflight) !== JSON.stringify(preflight)) {
      throw new MacMigrationFailure('cask-review-changed');
    }
    const assertOldCurrent = async () => {
      if ((await inspectMacNpmOwner(request.selection ?? owner, dependencies.upgrade, scratch!)).identity !== owner.identity ||
        (await captureMigrationTree(owner.packageRoot)).physical !== tree.physical ||
        JSON.stringify(await parentIdentities(owner, destination)) !== JSON.stringify(parents) ||
        (await migrationLauncher(owner.launcher)).physical !== launcher.physical ||
        destination !== owner.launcher && !await migrationAbsent(destination)) throw new MacMigrationFailure('pre-uninstall-input-changed');
    };
    await assertOldCurrent();
    journal.phase = 'npm-intent'; await store.save(journal);
    await assertOldCurrent();
    report.effects = 'possible'; report.status = 'partial';
    const result = await dependencies.upgrade.runner.run({ executable: owner.node,
      args: [owner.npm, 'uninstall', '--global', '--prefix', owner.prefix, '--ignore-scripts', '--no-audit', '--no-fund', '@msn-control/liftoff'] }, {
      cwd: scratch, env: migrationEnvironment(dependencies.upgrade, scratch, owner.node),
      inheritEnvironment: false,
      timeoutMs: 120_000, maxOutputBytes: 64 * 1024, ensureProcessTreeSettled: true
    });
    if (result.processTreeSettled !== true || result.aborted || result.timedOut) {
      journal.phase = 'uncertain'; await store.save(journal); throw new MacMigrationFailure('npm-settlement-unproven');
    }
    if (!await migrationAbsent(owner.packageRoot)) throw new MacMigrationFailure('npm-uninstall-incomplete');
    journal.phase = 'npm-removed'; await store.save(journal); report.effects = 'npm-removed';
    if (commandFailed(result)) throw new MacMigrationFailure('npm-uninstall-failed');
    if (JSON.stringify(await parentIdentities(owner, destination)) !== JSON.stringify(parents)) throw new MacMigrationFailure('handover-parent-changed');
    if (!await migrationAbsent(owner.launcher)) {
      if ((await migrationLauncher(owner.launcher)).physical !== launcher.physical) throw new MacMigrationFailure('residual-launcher-changed');
      journal.phase = 'link-intent'; await store.save(journal);
      if ((await migrationLauncher(owner.launcher)).physical !== launcher.physical) throw new MacMigrationFailure('residual-launcher-changed');
      await unlink(owner.launcher);
      await syncMigrationDirectory(path.dirname(owner.launcher));
    }
    journal.phase = 'link-removed'; await store.save(journal);
    if (!await migrationAbsent(destination)) throw new MacMigrationFailure('cask-destination-collision');
    const dispatchCandidate = await admitNativeStableMaterial(await bounded(signal => cask.target(brew, signal)), { target: 'darwin-arm64' }, policy);
    const dispatchChannel = await bounded(signal => cask.channel(brew, dispatchCandidate, signal));
    const dispatchPreflight = await bounded(signal => cask.preflight(brew, dispatchCandidate, owner, signal));
    if (JSON.stringify(dispatchCandidate) !== JSON.stringify(candidate) || JSON.stringify(dispatchChannel) !== JSON.stringify(channel) ||
      JSON.stringify(dispatchPreflight) !== JSON.stringify(preflight) ||
      macMigrationHash(JSON.stringify(nativePolicy(cask.policy))) !== policyIdentity) throw new MacMigrationFailure('cask-review-changed');
    journal.phase = 'cask-intent'; await store.save(journal); report.effects = 'possible';
    await assertMigrationTools(owner);
    if (!await migrationAbsent(destination) || !await migrationAbsent(owner.packageRoot) ||
      JSON.stringify(await parentIdentities(owner, destination)) !== JSON.stringify(parents) ||
      (await brewObservation(request.brew, owner, dependencies.upgrade, scratch)).identity !== brew.identity) {
      throw new MacMigrationFailure('pre-cask-input-changed');
    }
    const operationId = journal.operationId;
    const installed = await bounded(signal => cask.installExact(brew, candidate, channel.identity, operationId,
      { signal, environment: migrationEnvironment(dependencies.upgrade, scratch!, owner.node), timeoutMs: 120_000 }), 120_000);
    if (!installed.settled) { journal.phase = 'uncertain'; await store.save(journal); throw new MacMigrationFailure('cask-settlement-unproven'); }
    journal.phase = 'cask-settled'; await store.save(journal);
    report.effects = installed.installed ? 'possible' : 'npm-removed';
    if (!installed.installed) throw new MacMigrationFailure('cask-install-failed');
    report.verification = await verifyCask(journal, dependencies, scratch);
    report.effects = 'cask-installed';
    journal.phase = 'verified'; await store.save(journal);
    report.status = 'installed';
    return report;
  } catch (error) {
    report.blockers.push(error instanceof MacMigrationFailure ? error.code :
      error instanceof SelfUpgradeFailure ? `native-${error.reasonCode}` : 'migration-observation-or-operation-failed');
    return report;
  } finally {
    const unsettled = store?.hasUnsettledOperation || journal && migrationJournalUnsettled(journal);
    if (store && journal) {
      try { report.journal = await store.descriptor(); }
      catch { report.blockers.push('journal-readback-failed'); report.status = 'partial'; }
    }
    if (store && locked && !unsettled) {
      try { await store.release(); } catch { report.blockers.push('migration-lock-retained'); report.status = 'partial'; }
    }
    if (store && locked && unsettled) report.blockers.push('migration-lock-retained');
    if (scratch && unsettled) { report.retainedScratch = scratch; report.blockers.push('observation-scratch-retained'); }
    if (scratch && !unsettled) {
      try { await dependencies.upgrade.removeNeutralDirectory(scratch); }
      catch { report.blockers.push('observation-scratch-retained'); if (report.status !== 'blocked') report.status = 'partial'; }
    }
  }
}

export function defaultMacMigrationDependencies(): MacMigrationDependencies {
  const upgrade = defaultSelfUpgradeDependencies();
  return {
    upgrade,
    preparation: {
      preview: async (prefix, signal) => {
        const policy = nativePolicy(await upgrade.readJson(
          path.join(installedPackageRoot, 'distribution/native/release-policy.json')));
        return createHomebrewCaskPreparation(upgrade, policy).preview(prefix, signal);
      }
    },
    host: async () => {
      if (process.platform !== 'darwin') return { platform: process.platform, architecture: process.arch,
        nativeArchitecture: '', appleSilicon: '', translated: '', osVersion: '', runtimeVersion: process.versions.node };
      const scratch = await upgrade.makeNeutralDirectory();
      try {
        const read = (executable: string, args: string[]) => migrationProbe(upgrade, scratch, process.execPath, executable, args);
        return { platform: process.platform, architecture: process.arch, runtimeVersion: process.versions.node,
          nativeArchitecture: await read('/usr/bin/uname', ['-m']), appleSilicon: await read('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']),
          translated: await read('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated']), osVersion: await read('/usr/bin/sw_vers', ['-productVersion']) };
      } finally { await upgrade.removeNeutralDirectory(scratch); }
    }
  };
}
