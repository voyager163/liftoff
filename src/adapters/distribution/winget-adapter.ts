import path from 'node:path';
import { canonicalJson, canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { DistributionError, WinGetReadOnlyObservationError } from '../../domain/distribution/errors.js';
import { digest, freeze, object, publicHttpsUrl, stableVersion, text, timestamp } from '../../domain/distribution/validation.js';
import { type CommandRunner } from '../../process-runner.js';
import { NativeCommandRunner, assertNativeCommandInvocation } from './native-command-runner.js';
import { NativeAdmission, assertNativeCommandSucceeded, nativeProbeEnvironment, type AdmittedNativeArtifact, type AdmittedNativeCandidate } from './native-admission.js';
import { canonicalNativeRoot, hashNativeFile, nativePathParts, resolveNativeEntrypoint, type NativeFileSnapshot } from './native-files.js';
import { observeLauncher } from './launcher-observation.js';
import type { NativeManagerInstallation, NativeManagerSelection, NativeOwnerAdapter } from './owner-adapter.js';

/**
 * Supplied by the registered native WinGet observer, not `winget show` (which may
 * refresh sources). The observer must read the installed portable registry and
 * configured local catalog; exported or stale catalog files are not availability.
 */
export interface WinGetReadOnlyRecords {
  read(packageId: string, version: string): Promise<{
    source: unknown;
    package: unknown;
    installed: unknown;
    bindingFiles: readonly { root: string; pathParts: readonly string[] }[];
  }>;
}

export interface WinGetAdapterDependencies {
  runner?: CommandRunner;
  admission?: NativeAdmission;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  executable?: string;
  records?: WinGetReadOnlyRecords;
  now?: () => Date;
}

export function requireWinGetReadOnlyBindings(
  options: Pick<WinGetAdapterDependencies, 'records' | 'executable'>
): { records: WinGetReadOnlyRecords; executable: string } {
  if (!options.records) {
    throw new WinGetReadOnlyObservationError();
  }
  if (!options.executable) {
    throw new DistributionError('The selected WinGet executable has not been bound to this owner operation.', 'tool_unavailable');
  }
  return { records: options.records, executable: options.executable };
}

interface WinGetSnapshot {
  packageId: string;
  sourceId: string;
  sourceName: string;
  sourceDigest: string;
  bindingDigest: string;
  destinationDirectory: string;
  installLocation: string;
  launcherPath: string;
  executable: string;
  cwd: string;
  installed?: NativeManagerInstallation;
}

export function resolveWinGetPortableLayout(
  raw: unknown, archiveRoot: string, entrypoint: string
): { installLocation: string; bundleRoot: string; launcherPath: string } {
  const value = object(raw, [
    'InstallerType', 'NestedInstallerType', 'NestedInstallerFiles', 'InstallLocation', 'LauncherPath'
  ], 'WinGet portable ZIP layout');
  if (value.InstallerType !== 'zip' || value.NestedInstallerType !== 'portable' ||
      !Array.isArray(value.NestedInstallerFiles) || value.NestedInstallerFiles.length !== 1) {
    throw new DistributionError('WinGet requires one exact portable PE entrypoint inside its ZIP installer.', 'invalid_metadata');
  }
  const nested = object(value.NestedInstallerFiles[0], ['RelativeFilePath', 'PortableCommandAlias'], 'WinGet nested portable file');
  const relative = nativePathParts(text(nested.RelativeFilePath, 'WinGet nested file').replaceAll('\\', '/')).join('/');
  const launcher = nativePathParts(entrypoint).join('/');
  const prefix = archiveRoot ? nativePathParts(archiveRoot).join('/') : '';
  if (!launcher.endsWith('.exe') || relative !== [prefix, launcher].filter(Boolean).join('/') ||
      nested.PortableCommandAlias !== undefined && nested.PortableCommandAlias !== 'liftoff') {
    throw new DistributionError('WinGet nested entrypoint does not match the signed archive root and registered PE launcher.', 'ownership_conflict');
  }
  const absolute = (input: unknown, label: string): string => {
    const value = text(input, label);
    if (!path.win32.isAbsolute(value) || path.win32.normalize(value) !== value ||
        value === path.win32.parse(value).root || value.startsWith('\\\\?\\') || value.startsWith('\\\\.\\')) {
      throw new DistributionError('WinGet layout requires exact unambiguous native destinations.', 'unsafe_path');
    }
    return value;
  };
  const installLocation = absolute(value.InstallLocation, 'WinGet install location');
  const launcherPath = absolute(value.LauncherPath, 'WinGet launcher');
  if (path.win32.basename(launcherPath) !== 'liftoff.exe') {
    throw new DistributionError('WinGet command alias must identify the exact Liftoff PE launcher.', 'ownership_conflict');
  }
  return { installLocation, bundleRoot: prefix ? path.win32.join(installLocation, ...prefix.split('/')) : installLocation, launcherPath };
}

export class WinGetAdapter implements NativeOwnerAdapter {
  readonly owner = 'winget' as const;
  private readonly runner: CommandRunner;
  private readonly admission: NativeAdmission;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly executable?: string;
  private readonly records?: WinGetReadOnlyRecords;
  private readonly now: () => Date;
  private readonly selections = new WeakMap<NativeManagerSelection, { candidate: AdmittedNativeArtifact; mode: 'install' | 'upgrade' }>();

  constructor(options: WinGetAdapterDependencies = {}) {
    this.runner = options.runner ?? new NativeCommandRunner();
    this.admission = options.admission ?? new NativeAdmission(options);
    this.env = Object.freeze({ ...options.env ?? this.admission.env });
    this.cwd = options.cwd ?? this.admission.cwd;
    this.executable = options.executable;
    this.records = options.records;
    this.now = options.now ?? (() => new Date());
  }

  private async snapshot(candidate: AdmittedNativeArtifact): Promise<WinGetSnapshot> {
    this.admission.assertArtifact(candidate);
    if (this.admission.host.os !== 'win32' || !candidate.target.startsWith('win32-')) {
      throw new DistributionError('WinGet requires an admitted Windows native target.', 'unsupported_host');
    }
    const trust = await this.admission.releaseClient.trustRegistration();
    const channel = trust.channels.find((entry) => entry.owner === this.owner);
    if (!channel) throw new DistributionError('The WinGet publisher/package and source are not registered.', 'trust_unregistered');
    const bindingsSource = requireWinGetReadOnlyBindings({ records: this.records, executable: this.executable });
    const raw = await bindingsSource.records.read(channel.packageId, candidate.version);
    const source = object(raw.source, ['Identifier', 'Name', 'Argument', 'Type', 'ObservedAt', 'ExpiresAt', 'CatalogSha256', 'PolicyAllowsInstall'], 'WinGet source observation');
    const available = object(raw.package, [
      'PackageIdentifier', 'PackageVersion', 'Architecture', 'InstallerType', 'InstallerUrl', 'InstallerSha256',
      'NestedInstallerType', 'NestedInstallerFiles', 'InstallLocation', 'LauncherPath', 'SourceIdentifier', 'PackageDefinitionSha256'
    ], 'WinGet target catalog record');
    const layout = resolveWinGetPortableLayout({
      InstallerType: available.InstallerType, NestedInstallerType: available.NestedInstallerType,
      NestedInstallerFiles: available.NestedInstallerFiles, InstallLocation: available.InstallLocation, LauncherPath: available.LauncherPath
    }, candidate.archiveRoot, candidate.provenance.entrypoints.launcher);
    const observedAt = timestamp(source.ObservedAt, 'WinGet catalog observation');
    const expiresAt = timestamp(source.ExpiresAt, 'WinGet catalog expiry');
    const now = this.now().getTime();
    if (!Number.isFinite(now) || Date.parse(observedAt) > now || Date.parse(expiresAt) <= now ||
        Date.parse(expiresAt) - Date.parse(observedAt) > 60 * 60_000) {
      throw new DistributionError('Configured WinGet catalog knowledge is stale or not freshly observable. Refresh is a separate manual action.', 'source_stale');
    }
    const payload = candidate.release.manifest.targets[candidate.target];
    if (typeof source.PolicyAllowsInstall !== 'boolean') throw new DistributionError('WinGet source policy observation is incomplete.', 'invalid_metadata');
    if (!source.PolicyAllowsInstall) throw new DistributionError('Configured WinGet enterprise policy does not permit this package operation; policy was not changed.', 'policy_blocked');
    if (source.Identifier !== channel.sourceId || source.Argument !== channel.sourceUrl || source.Type !== 'Microsoft.PreIndexed.Package' ||
        source.PolicyAllowsInstall !== true || available.PackageIdentifier !== channel.packageId ||
        available.SourceIdentifier !== channel.sourceId || available.PackageVersion !== candidate.version ||
        available.Architecture !== candidate.target.split('-')[1] ||
        publicHttpsUrl(available.InstallerUrl, 'WinGet installer URL') !== payload.archiveUrl ||
        digest(available.InstallerSha256, 'WinGet final installer checksum') !== payload.checksumSha256) {
      throw new DistributionError('WinGet publisher, installed source policy, target architecture, or final artifact differs from the registered release.', 'ownership_conflict');
    }
    if (raw.bindingFiles.length < 2 || raw.bindingFiles.length > 32) {
      throw new DistributionError('WinGet observation lacks bounded installed-record and source/configuration file bindings.', 'ownership_unknown');
    }
    const bindings: NativeFileSnapshot[] = [];
    for (const binding of raw.bindingFiles) bindings.push(await hashNativeFile(await canonicalNativeRoot(binding.root), binding.pathParts));
    const catalogDigest = digest(source.CatalogSha256, 'WinGet local catalog identity');
    const definition = candidate.provenance.channelDefinitions?.find((entry) => entry.owner === this.owner);
    const definitionDigest = digest(available.PackageDefinitionSha256, 'WinGet package definition identity');
    if (!bindings.some((file) => file.sha256 === catalogDigest) || !bindings.some((file) => file.sha256 === definitionDigest) ||
        !definition || definition.packageId !== channel.packageId || definition.sourceId !== channel.sourceId || definition.sha256 !== definitionDigest) {
      throw new DistributionError('WinGet source/package observations do not match signed publisher-owned definitions and actual local catalog bytes.', 'ownership_conflict');
    }
    const executable = await resolveNativeEntrypoint(bindingsSource.executable, this.cwd);
    const cwd = await canonicalNativeRoot(path.dirname(executable));
    const tool = await hashNativeFile(cwd, [path.basename(executable)]);
    const sourceDigest = canonicalSha256({ channel, source, bindings });
    const destinationDirectory = layout.bundleRoot;
    const launcherPath = layout.launcherPath;
    let installed: NativeManagerInstallation | undefined;
    if (raw.installed !== null) {
      const record = object(raw.installed, [
        'WinGetPackageIdentifier', 'WinGetSourceIdentifier', 'DisplayVersion', 'InstallLocation', 'LauncherPath'
      ], 'WinGet installed portable record');
      if (record.WinGetPackageIdentifier !== channel.packageId || record.WinGetSourceIdentifier !== channel.sourceId ||
          record.InstallLocation !== layout.installLocation || record.LauncherPath !== launcherPath) {
        throw new DistributionError('WinGet installed package record names a different owner/source/destination.', 'ownership_conflict');
      }
      installed = {
        owner: this.owner, packageId: channel.packageId, version: stableVersion(record.DisplayVersion),
        prefix: layout.installLocation, payloadRoot: destinationDirectory, launcherPath,
        sourceId: channel.sourceId, evidenceDigest: canonicalSha256({ record, sourceDigest, bindings })
      };
    }
    return {
      packageId: channel.packageId, sourceId: channel.sourceId, sourceName: text(source.Name, 'WinGet configured source name', 128),
      sourceDigest, destinationDirectory, installLocation: layout.installLocation, launcherPath, executable, cwd, ...(installed ? { installed } : {}),
      bindingDigest: canonicalSha256({
        available, installed: raw.installed, sourceDigest, tool,
        env: Object.fromEntries(Object.entries(this.env).filter(([, value]) => value !== undefined))
      })
    };
  }

  async observeInstallation(candidate: AdmittedNativeCandidate): Promise<NativeManagerInstallation | undefined> {
    const snapshot = await this.snapshot(candidate);
    if (!snapshot.installed) return undefined;
    if (snapshot.installed.version !== candidate.version || await canonicalNativeRoot(snapshot.installed.payloadRoot) !== candidate.bundleRoot) {
      throw new DistributionError('WinGet installed record does not identify this admitted payload.', 'ownership_conflict');
    }
    const launcher = await observeLauncher(snapshot.launcherPath);
    const expected = path.join(candidate.bundleRoot, ...candidate.provenance.entrypoints.launcher.split('/'));
    if (launcher.state !== 'link' || launcher.resolved !== expected) {
      throw new DistributionError('WinGet portable launcher does not resolve into its exact admitted payload.', 'ownership_conflict');
    }
    return snapshot.installed;
  }

  async select(candidate: AdmittedNativeArtifact, mode: 'install' | 'upgrade'): Promise<NativeManagerSelection> {
    const snapshot = await this.snapshot(candidate);
    if (mode === 'install' && snapshot.installed) {
      if (snapshot.installed.version !== candidate.version) {
        throw new DistributionError('A different version is already owned by WinGet; npm handover cannot acquire its upgrade authority.', 'ownership_conflict');
      }
      await canonicalNativeRoot(snapshot.installed.payloadRoot);
    }
    for (const executable of [
      snapshot.launcherPath, path.win32.join(snapshot.destinationDirectory, ...candidate.provenance.entrypoints.launcher.split('/'))
    ]) assertNativeCommandInvocation({ executable, args: ['--version'] }, { cwd: snapshot.cwd }, 'win32');
    const selection: NativeManagerSelection = {
      owner: this.owner, packageId: snapshot.packageId, version: candidate.version,
      destinationDirectory: snapshot.destinationDirectory, launcherPath: snapshot.launcherPath,
      sourceId: snapshot.sourceId, sourceDigest: snapshot.sourceDigest, bindingDigest: snapshot.bindingDigest,
      command: {
        executable: snapshot.executable,
        args: [mode, '--id', snapshot.packageId, '--exact', '--version', candidate.version, '--source', snapshot.sourceName,
          '--disable-interactivity', ...(mode === 'install' ? ['--scope', 'user', '--location', snapshot.installLocation] : [])]
      }
    };
    freeze(selection);
    this.selections.set(selection, { candidate, mode });
    return selection;
  }

  async recheck(selection: NativeManagerSelection): Promise<void> {
    const state = this.selections.get(selection);
    if (!state || canonicalJson(await this.select(state.candidate, state.mode)) !== canonicalJson(selection)) {
      throw new DistributionError('WinGet owner, source, tool, target, or installed record changed after selection.', 'stale_plan');
    }
  }

  async execute(selection: NativeManagerSelection): Promise<void> {
    await this.recheck(selection);
    const result = await this.runner.run(selection.command, {
      cwd: path.dirname(selection.command.executable), env: nativeProbeEnvironment(this.env), timeoutMs: 300_000,
      maxOutputBytes: 64 * 1024, ensureProcessTreeSettled: true
    });
    assertNativeCommandSucceeded(result, 'Exact WinGet Liftoff operation');
  }

  async verify(candidate: AdmittedNativeCandidate, selection: NativeManagerSelection): Promise<NativeManagerInstallation> {
    const installed = await this.observeInstallation(candidate);
    if (!installed || installed.packageId !== selection.packageId || installed.version !== selection.version ||
        installed.sourceId !== selection.sourceId || installed.launcherPath !== selection.launcherPath) {
      throw new DistributionError('WinGet replacement did not read back as the exact selected owner and artifact.', 'verification_failed');
    }
    return installed;
  }
}
