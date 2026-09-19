import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type {
  DirectInstallReceipt, ExecutableInspection, InstallationInspectionResult, InstallationOwnershipRecord, PathResolutionInspection
} from '../../domain/distribution/contracts.js';
import { DistributionError } from '../../domain/distribution/errors.js';
import { installedPackageRoot } from '../packaged-assets/package-root.js';
import { ReceiptStore, DIRECT_RECEIPT_FILENAME } from './receipt-store.js';
import { NativeAdmission, type AdmittedNativeCandidate, type NativeAdmissionOptions } from './native-admission.js';
import { hashNativeFile, ioCode, resolveNativeEntrypoint } from './native-files.js';
import { observePathLaunchers, type LauncherObservation } from './launcher-observation.js';
import { NpmInstallationAdapter, type ObservedNpmInstallation } from './npm-installation.js';
import type { NativeManagerInstallation, NativeOwnerAdapter } from './owner-adapter.js';
import { HomebrewAdapter } from './homebrew-adapter.js';
import { WinGetAdapter } from './winget-adapter.js';
import { assertDirectLauncherIdentity, assertWindowsDirectLayout, NATIVE_LAUNCHER_MAX_BYTES } from './native-launcher.js';

export interface InstallationDetectorDependencies extends NativeAdmissionOptions {
  entrypoint?: string;
  admission?: NativeAdmission;
  receiptStore?: ReceiptStore;
  npmAdapter?: NpmInstallationAdapter;
  ownerAdapters?: readonly NativeOwnerAdapter[];
}

export interface ObservedInstallation {
  result: InstallationInspectionResult;
  candidate?: AdmittedNativeCandidate;
  npm?: ObservedNpmInstallation;
  directReceipt?: DirectInstallReceipt;
  manager?: NativeManagerInstallation;
  pathLaunchers: readonly LauncherObservation[];
}

function unknownOwner(): InstallationOwnershipRecord {
  return { owner: 'unknown', isCask: false, isFormula: false, isNodeDependent: false };
}

export class InstallationDetector {
  readonly admission: NativeAdmission;
  readonly receiptStore: ReceiptStore;
  readonly npmAdapter: NpmInstallationAdapter;
  readonly ownerAdapters: readonly NativeOwnerAdapter[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly entrypoint: string;
  private readonly defaultManagerDiscovery: boolean;

  constructor(options: InstallationDetectorDependencies = {}) {
    this.admission = options.admission ?? new NativeAdmission(options);
    this.env = Object.freeze({ ...options.env ?? this.admission.env });
    this.cwd = path.resolve(options.cwd ?? this.admission.cwd);
    this.entrypoint = options.entrypoint ?? process.argv[1] ?? path.join(installedPackageRoot, 'dist', 'cli.js');
    this.receiptStore = options.receiptStore ?? new ReceiptStore({ env: this.env });
    this.npmAdapter = options.npmAdapter ?? new NpmInstallationAdapter({ ...options, env: this.env, cwd: this.cwd });
    this.defaultManagerDiscovery = options.ownerAdapters === undefined;
    this.ownerAdapters = options.ownerAdapters ?? (this.admission.host.os === 'darwin'
      ? [new HomebrewAdapter({ admission: this.admission, runner: options.runner, env: this.env, cwd: this.cwd })]
      : this.admission.host.os === 'win32'
        ? [new WinGetAdapter({ admission: this.admission, runner: options.runner, env: this.env, cwd: this.cwd })] : []);
  }

  async observeInstallation(candidatePath?: string): Promise<ObservedInstallation> {
    const selected = path.resolve(this.cwd, candidatePath ?? this.entrypoint);
    const selectedDetails = await lstat(selected);
    const entrypoint = selectedDetails.isDirectory() ? selected : await resolveNativeEntrypoint(selected, this.cwd);
    let bundleRoot = await this.admission.findBundleRoot(entrypoint);
    let selectedDirectReceipt: DirectInstallReceipt | undefined;
    if (!bundleRoot && this.admission.host.os === 'win32' && !selectedDetails.isDirectory() &&
        path.basename(entrypoint) === 'liftoff.exe' && path.basename(path.dirname(entrypoint)) === 'bin') {
      const directRoot = path.dirname(path.dirname(entrypoint));
      assertWindowsDirectLayout(directRoot, entrypoint);
      selectedDirectReceipt = await this.receiptStore.loadDirectReceipt(directRoot) ?? undefined;
      if (selectedDirectReceipt) {
        if (selectedDirectReceipt.launcherPath !== entrypoint) {
          throw new DistributionError('The selected stable PE differs from its private receipt-owned launcher.', 'ownership_conflict');
        }
        bundleRoot = await this.admission.findBundleRoot(selectedDirectReceipt.versionRoot);
        if (bundleRoot !== selectedDirectReceipt.versionRoot) {
          throw new DistributionError('The stable PE receipt does not select a complete exact native payload.', 'ownership_conflict');
        }
      }
    }
    let candidate: AdmittedNativeCandidate | undefined;
    let npm: ObservedNpmInstallation | undefined;
    let directReceipt: DirectInstallReceipt | undefined;
    let manager: NativeManagerInstallation | undefined;
    let ownershipIssue: string | undefined;
    let executable: ExecutableInspection = { resolvedPath: entrypoint, kind: 'unknown', isPrivateRuntime: false };
    let installation = unknownOwner();
    if (bundleRoot) {
      candidate = await this.admission.admitBundle(bundleRoot);
      const expectedEntrypoints = [candidate.provenance.entrypoints.launcher, candidate.provenance.entrypoints.cli]
        .map((entry) => path.join(bundleRoot, ...entry.split('/')));
      if (!selectedDetails.isDirectory() && !expectedEntrypoints.includes(entrypoint) && !selectedDirectReceipt) {
        throw new DistributionError('The selected executable is not a registered Liftoff bundle entrypoint.', 'ownership_unknown');
      }
      executable = {
        resolvedPath: selectedDetails.isDirectory() ? path.join(bundleRoot, ...candidate.provenance.entrypoints.launcher.split('/')) : entrypoint,
        kind: 'native', version: candidate.version, isPrivateRuntime: true, bundleRoot, identityDigest: candidate.identityDigest
      };
      const owners: InstallationOwnershipRecord[] = [];
      if (path.basename(path.dirname(bundleRoot)) === 'versions') {
        const root = path.dirname(path.dirname(bundleRoot));
        directReceipt = await this.receiptStore.loadDirectReceipt(root) ?? undefined;
        if (directReceipt) {
          if (directReceipt.versionRoot !== bundleRoot || directReceipt.version !== candidate.version ||
              directReceipt.sourceCommit !== candidate.sourceCommit || directReceipt.target !== candidate.target ||
              directReceipt.checksumSha256 !== candidate.archiveDigest ||
              directReceipt.authority?.manifestDigest !== candidate.release.manifestDigest ||
              directReceipt.authority.provenanceDigest !== candidate.provenanceDigest ||
              canonicalJson(directReceipt.runtime) !== canonicalJson(candidate.provenance.runtime) ||
              canonicalJson(directReceipt.authority.resources) !== canonicalJson(candidate.provenance.resources)) {
            throw new DistributionError('Direct receipt differs from the actual admitted native payload.', 'ownership_conflict');
          }
          const launcher = await hashNativeFile(path.dirname(directReceipt.launcherPath), [path.basename(directReceipt.launcherPath)], NATIVE_LAUNCHER_MAX_BYTES);
          const receiptFile = await hashNativeFile(root, [DIRECT_RECEIPT_FILENAME], 2 * 1024 * 1024);
          assertDirectLauncherIdentity(directReceipt, candidate.provenance, launcher);
          owners.push({
            owner: 'direct', packageName: 'liftoff', version: candidate.version, prefix: root,
            receiptPath: path.join(root, DIRECT_RECEIPT_FILENAME), isCask: false, isFormula: false, isNodeDependent: false,
            launcherPath: directReceipt.launcherPath, payloadRoot: bundleRoot, evidenceDigest: canonicalSha256({ receipt: directReceipt, receiptFile, launcher })
          });
        }
      }
      // Proven direct ownership does not depend on the unavailable default WinGet catalog observer.
      const managers = directReceipt && this.admission.host.os === 'win32' && this.defaultManagerDiscovery ? [] : this.ownerAdapters;
      for (const adapter of managers) {
        let observed: NativeManagerInstallation | undefined;
        try { observed = await adapter.observeInstallation(candidate); }
        catch (error) {
          if (error instanceof DistributionError && (error.reasonCode === 'tool_unavailable' || error.reasonCode === 'source_unavailable')) {
            ownershipIssue = error.message;
            continue;
          }
          throw error;
        }
        if (!observed) continue;
        manager = observed;
        owners.push({
          owner: observed.owner, packageName: observed.packageId, version: observed.version, prefix: observed.prefix,
          sourceId: observed.sourceId, launcherPath: observed.launcherPath, payloadRoot: observed.payloadRoot,
          isCask: observed.owner === 'homebrew-cask', isFormula: false, isNodeDependent: false, evidenceDigest: observed.evidenceDigest
        });
      }
      if (owners.length > 1) throw new DistributionError('Multiple exact owner records claim this native payload.', 'ownership_conflict');
      installation = owners[0] ?? (ownershipIssue ? unknownOwner()
        : { owner: 'unlinked', version: candidate.version, isCask: false, isFormula: false, isNodeDependent: false });
    } else if (!selectedDetails.isDirectory()) {
      try { npm = await this.npmAdapter.inspect(entrypoint); }
      catch (error) {
        if (!(error instanceof DistributionError) || error.reasonCode !== 'ownership_unknown') throw error;
        ownershipIssue = error.message;
      }
      if (npm) {
        executable = { resolvedPath: entrypoint, kind: 'node-script', version: npm.facts.installedVersion, isPrivateRuntime: false };
        installation = {
          owner: 'npm', packageName: npm.facts.packageName, version: npm.facts.installedVersion, prefix: npm.facts.prefix,
          receiptPath: path.join(npm.facts.packageRoot ?? '', 'package.json'), isCask: false, isFormula: false, isNodeDependent: true,
          launcherPath: npm.facts.launcherPath, evidenceDigest: npm.facts.evidenceDigest
        };
      }
    }
    const pathLaunchers = await observePathLaunchers(this.env, this.cwd);
    const effective = pathLaunchers[0];
    const resolvesToRunning = !!effective && (
      effective.state === 'link' && effective.resolved === executable.resolvedPath ||
      effective.path === installation.launcherPath ||
      effective.path === executable.resolvedPath
    );
    const pathResolution: PathResolutionInspection = {
      ...(effective ? { effectiveLauncher: effective.path } : {}), resolvesToRunning,
      pathLaunchers: pathLaunchers.map((entry) => entry.path),
      conflicts: pathLaunchers.filter((entry) => entry.path !== installation.launcherPath && entry.path !== executable.resolvedPath &&
        !(entry.state === 'link' && entry.resolved === executable.resolvedPath)).map((entry) => entry.path)
    };
    const status = installation.owner === 'unknown' ? 'ambiguous' : installation.owner === 'unlinked' ? 'unlinked-candidate'
      : installation.owner === 'npm' ? 'migration-required' : !resolvesToRunning || pathResolution.conflicts.length ? 'launcher-conflict' : 'healthy';
    const result: InstallationInspectionResult = {
      schemaVersion: 1, executable, installation, pathResolution, status,
      summary: status === 'healthy' ? 'The exact native owner, payload, and effective launcher agree.'
        : status === 'migration-required' ? 'Historical npm ownership is verified; native installation requires a separately approved handover.'
          : status === 'unlinked-candidate' ? 'This signed native bundle is unlinked; it has no replacement authority.'
            : status === 'ambiguous' ? ownershipIssue ?? 'Actual Liftoff installation ownership is not established; no path prefix or unknown bytes grant authority.'
              : 'The admitted installation is not the unique effective Liftoff command.',
      ...(status === 'healthy' ? {} : { remedy: 'Inspect exact owner receipts and PATH conflicts. Native handover requires installation migrate --to <owner>; project changes remain separately reviewed.' })
    };
    return { result, pathLaunchers, ...(candidate ? { candidate } : {}), ...(npm ? { npm } : {}),
      ...(directReceipt ? { directReceipt } : {}), ...(manager ? { manager } : {}) };
  }

  async observeLegacyInstallation(): Promise<ObservedNpmInstallation> {
    const launchers = await observePathLaunchers(this.env, this.cwd);
    const effective = launchers[0];
    if (!effective) throw new DistributionError('No effective legacy Liftoff command was observed in PATH.', 'ownership_unknown');
    let entrypoint = effective.state === 'link' ? effective.resolved : effective.path;
    if (process.platform === 'win32' && effective.state === 'file' && entrypoint.toLowerCase().endsWith('.cmd')) {
      entrypoint = path.join(path.dirname(entrypoint), 'node_modules', '@msn-control', 'liftoff', 'dist', 'cli.js');
    }
    const legacy = await this.npmAdapter.inspect(entrypoint);
    if (!legacy || !legacy.facts.launcherPaths?.includes(effective.path)) {
      throw new DistributionError('Ordinary command resolution does not select the exact registered legacy npm launcher.', 'ownership_unknown');
    }
    return legacy;
  }

  async inspectInstallation(candidatePath?: string): Promise<InstallationInspectionResult> {
    return (await this.observeInstallation(candidatePath)).result;
  }

  async inspectExecutable(targetPath: string): Promise<ExecutableInspection> {
    return (await this.inspectInstallation(targetPath)).executable;
  }

  async detectOwnership(targetPath: string): Promise<InstallationOwnershipRecord> {
    return (await this.inspectInstallation(targetPath)).installation;
  }

  async inspectPathResolution(currentExecutablePath: string): Promise<PathResolutionInspection> {
    const actual = await resolveNativeEntrypoint(currentExecutablePath, this.cwd);
    const launchers = await observePathLaunchers(this.env, this.cwd);
    const matches = (entry: LauncherObservation): boolean => entry.state === 'link' ? entry.resolved === actual : entry.path === actual;
    return {
      ...(launchers[0] ? { effectiveLauncher: launchers[0].path } : {}),
      resolvesToRunning: !!launchers[0] && matches(launchers[0]),
      pathLaunchers: launchers.map((entry) => entry.path), conflicts: launchers.filter((entry) => !matches(entry)).map((entry) => entry.path)
    };
  }
}
