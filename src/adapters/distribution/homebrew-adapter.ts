import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { DistributionError } from '../../domain/distribution/errors.js';
import { freeze, stableVersion } from '../../domain/distribution/validation.js';
import { type CommandRunner } from '../../process-runner.js';
import { NativeCommandRunner } from './native-command-runner.js';
import { NativeAdmission, assertNativeCommandSucceeded, nativeProbeEnvironment, type AdmittedNativeArtifact, type AdmittedNativeCandidate } from './native-admission.js';
import { canonicalNativeRoot, hashNativeFile, ioCode, nativeDirectorySnapshot, nativePathParts, readNativeJson, resolveNativeEntrypoint } from './native-files.js';
import { environmentValue, observeLauncher } from './launcher-observation.js';
import type { NativeManagerInstallation, NativeManagerSelection, NativeOwnerAdapter } from './owner-adapter.js';

export interface HomebrewAdapterDependencies {
  runner?: CommandRunner;
  admission?: NativeAdmission;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  executable?: string;
}

interface HomebrewSnapshot {
  packageId: string;
  prefix: string;
  caskRoot: string;
  installedVersion?: string;
  version: string;
  url: string;
  checksum: string;
  binaryRelativePath: string;
  sourceId: string;
  sourceDigest: string;
  definitionDigest: string;
  bindingDigest: string;
  tool: string;
  cwd: string;
}

export class HomebrewAdapter implements NativeOwnerAdapter {
  readonly owner = 'homebrew-cask' as const;
  private readonly runner: CommandRunner;
  private readonly admission: NativeAdmission;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly executable?: string;
  private readonly selections = new WeakMap<NativeManagerSelection, { candidate: AdmittedNativeArtifact; mode: 'install' | 'upgrade' }>();

  constructor(options: HomebrewAdapterDependencies = {}) {
    this.runner = options.runner ?? new NativeCommandRunner();
    this.admission = options.admission ?? new NativeAdmission(options);
    this.env = Object.freeze({ ...options.env ?? this.admission.env });
    this.cwd = options.cwd ?? this.admission.cwd;
    this.executable = options.executable;
  }

  private async tool(): Promise<string> {
    if (this.executable) return resolveNativeEntrypoint(this.executable, this.cwd);
    for (const directory of (environmentValue(this.env, 'PATH') ?? '').split(path.delimiter)) {
      if (!path.isAbsolute(directory)) continue;
      try { return await resolveNativeEntrypoint(path.join(directory, 'brew'), this.cwd); }
      catch (error) { if (ioCode(error) !== 'ENOENT' && ioCode(error) !== 'ENOTDIR') throw error; }
    }
    throw new DistributionError('The registered Homebrew owner tool is unavailable; no manager is bootstrapped.', 'tool_unavailable');
  }

  private managerEnv(): NodeJS.ProcessEnv {
    return {
      ...nativeProbeEnvironment(this.env), HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1',
      HOMEBREW_NO_INSTALL_FROM_API: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1'
    };
  }

  private async run(tool: string, args: string[], cwd: string): Promise<string> {
    const result = await this.runner.run({ executable: tool, args }, {
      cwd, env: this.managerEnv(), timeoutMs: 30_000, maxOutputBytes: 1024 * 1024, ensureProcessTreeSettled: true
    });
    assertNativeCommandSucceeded(result, 'Read-only Homebrew observation');
    return result.stdout.trim();
  }

  private async snapshot(candidate: AdmittedNativeArtifact): Promise<HomebrewSnapshot> {
    this.admission.assertArtifact(candidate);
    if (candidate.target !== `${this.admission.host.os}-${this.admission.host.arch}` || this.admission.host.os !== 'darwin') {
      throw new DistributionError('The registered Homebrew-cask channel requires its admitted macOS target.', 'unsupported_host');
    }
    const trust = await this.admission.releaseClient.trustRegistration();
    const channel = trust.channels.find((entry) => entry.owner === this.owner);
    if (!channel || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(channel.packageId) ||
        channel.sourceId !== channel.packageId.split('/').slice(0, 2).join('/')) {
      throw new DistributionError('The full Homebrew tap/cask and source have not been registered.', 'trust_unregistered');
    }
    const tool = await this.tool();
    const cwd = await canonicalNativeRoot(path.dirname(tool));
    const prefixText = await this.run(tool, ['--prefix'], cwd);
    const prefix = await canonicalNativeRoot(prefixText);
    const [infoText, tapText, rootText] = await Promise.all([
      this.run(tool, ['info', '--cask', channel.packageId, '--json=v2'], cwd),
      this.run(tool, ['tap-info', '--json', channel.sourceId], cwd),
      this.run(tool, ['--caskroom', channel.packageId], cwd)
    ]);
    let info: unknown;
    let tap: unknown;
    try { info = JSON.parse(infoText); tap = JSON.parse(tapText); }
    catch { throw new DistributionError('Homebrew returned malformed owner/source metadata.', 'invalid_metadata'); }
    if (!isRecord(info) || !Array.isArray(info.casks) || info.casks.length !== 1 || !isRecord(info.casks[0]) ||
        !Array.isArray(tap) || tap.length !== 1 || !isRecord(tap[0])) {
      throw new DistributionError('Homebrew did not return one unambiguous exact cask/source record.', 'ownership_unknown');
    }
    const cask = info.casks[0];
    const source = tap[0];
    if (cask.full_token !== channel.packageId || cask.tap !== channel.sourceId ||
        cask.token !== channel.packageId.split('/')[2] || source.name !== channel.sourceId ||
        source.remote !== channel.sourceUrl || typeof source.path !== 'string' || source.installed !== true ||
        !Array.isArray(cask.artifacts)) {
      throw new DistributionError('Homebrew owner/source differs from the registered publisher-owned tap/cask.', 'ownership_conflict');
    }
    const binaries = cask.artifacts.filter(isRecord).flatMap((entry) => Array.isArray(entry.binary) ? [entry.binary] : []);
    if (binaries.length !== 1 || typeof binaries[0][0] !== 'string' || binaries[0].length > 2) {
      throw new DistributionError('Homebrew cask does not declare exactly the registered Liftoff launcher.', 'ownership_unknown');
    }
    const binaryRelativePath = binaries[0][0];
    if (path.posix.isAbsolute(binaryRelativePath) || binaryRelativePath.split('/').some((part) => !part || part === '..' || part === '.')) {
      throw new DistributionError('Homebrew cask launcher escapes its payload.', 'unsafe_path');
    }
    const sourceRoot = await canonicalNativeRoot(source.path);
    const config = await hashNativeFile(sourceRoot, ['.git', 'config'], 2 * 1024 * 1024);
    const token = channel.packageId.split('/')[2];
    const definition = await hashNativeFile(sourceRoot, ['Casks', `${token}.rb`], 2 * 1024 * 1024);
    const toolFile = await hashNativeFile(cwd, [path.basename(tool)]);
    const sourceDigest = canonicalSha256({ channel, config, definition, root: await nativeDirectorySnapshot(sourceRoot) });
    if (cask.depends_on !== undefined && (!isRecord(cask.depends_on) ||
        Object.keys(cask.depends_on).some((key) => !['macos', 'arch'].includes(key)))) {
      throw new DistributionError('The registered standalone cask cannot install unrelated formulae, casks, or ambient runtimes.', 'ownership_conflict');
    }
    if (typeof cask.url !== 'string' || typeof cask.sha256 !== 'string' || typeof rootText !== 'string' ||
        !path.isAbsolute(rootText) || path.dirname(rootText) !== path.join(prefix, 'Caskroom')) {
      throw new DistributionError('Homebrew destination or artifact binding is not established.', 'ownership_unknown');
    }
    const installed = cask.installed;
    if (installed !== null && installed !== undefined && typeof installed !== 'string') {
      throw new DistributionError('Unsupported Homebrew installed-version record.', 'ownership_unknown');
    }
    return {
      packageId: channel.packageId, prefix, caskRoot: rootText, version: stableVersion(cask.version),
      ...(typeof installed === 'string' ? { installedVersion: stableVersion(installed) } : {}),
      url: cask.url, checksum: cask.sha256, binaryRelativePath, sourceId: channel.sourceId, sourceDigest, definitionDigest: definition.sha256, tool, cwd,
      bindingDigest: canonicalSha256({
        info, source, sourceDigest, toolFile, prefix: await nativeDirectorySnapshot(prefix),
        env: Object.fromEntries(Object.entries(this.managerEnv()).filter(([, value]) => value !== undefined))
      })
    };
  }

  async observeInstallation(candidate: AdmittedNativeCandidate): Promise<NativeManagerInstallation | undefined> {
    if (!(await this.admission.releaseClient.trustRegistration()).channels.some((entry) => entry.owner === this.owner)) return undefined;
    const snapshot = await this.snapshot(candidate);
    if (!snapshot.installedVersion) return undefined;
    const relative = path.relative(snapshot.caskRoot, candidate.bundleRoot);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      const launcher = await observeLauncher(path.join(snapshot.prefix, 'bin', 'liftoff'));
      if (launcher.state === 'link' && launcher.resolved === path.join(candidate.bundleRoot, ...candidate.provenance.entrypoints.launcher.split('/'))) {
        throw new DistributionError('Homebrew launcher points outside its recorded cask payload.', 'ownership_conflict');
      }
      return undefined;
    }
    if (snapshot.installedVersion !== candidate.version) throw new DistributionError('Homebrew installed-version record differs from this native payload.', 'ownership_conflict');
    const metadataRoot = await canonicalNativeRoot(path.join(snapshot.caskRoot, '.metadata', candidate.version));
    const stamps = await readdir(metadataRoot);
    if (stamps.length !== 1) throw new DistributionError('Homebrew has ambiguous installed cask metadata revisions.', 'ownership_conflict');
    const metadataPath = [stamps[0], 'Casks', `${snapshot.packageId.split('/')[2]}.json`];
    const installed = await readNativeJson(metadataRoot, metadataPath.join('/'));
    const payload = candidate.release.manifest.targets[candidate.target];
    if (!isRecord(installed) || installed.full_token !== snapshot.packageId || installed.tap !== snapshot.sourceId ||
        installed.version !== candidate.version || installed.sha256 !== payload.checksumSha256 || installed.url !== payload.archiveUrl ||
        !Array.isArray(installed.artifacts)) {
      throw new DistributionError('The installed Homebrew cask record does not identify the exact admitted release and source.', 'ownership_conflict');
    }
    const binaries = installed.artifacts.filter(isRecord).flatMap((entry) => Array.isArray(entry.binary) ? [entry.binary] : []);
    if (binaries.length !== 1 || typeof binaries[0][0] !== 'string') throw new DistributionError('Installed Homebrew cask has no exact launcher inventory.', 'ownership_unknown');
    const ownedRoot = path.join(snapshot.caskRoot, candidate.version);
    const launcher = path.join(ownedRoot, ...nativePathParts(binaries[0][0]));
    const resolved = await realpath(launcher);
    const expected = path.join(candidate.bundleRoot, ...candidate.provenance.entrypoints.launcher.split('/'));
    if (resolved !== expected || !(await lstat(ownedRoot)).isDirectory()) {
      throw new DistributionError('Homebrew installed payload differs from the admitted executable.', 'ownership_conflict');
    }
    const launcherPath = path.join(snapshot.prefix, 'bin', 'liftoff');
    const observation = await observeLauncher(launcherPath);
    if (observation.state !== 'link' || observation.resolved !== expected) {
      throw new DistributionError('Homebrew launcher does not identify its exact installed cask payload.', 'ownership_conflict');
    }
    return {
      owner: this.owner, packageId: snapshot.packageId, version: candidate.version, prefix: snapshot.prefix,
      payloadRoot: candidate.bundleRoot, launcherPath, sourceId: snapshot.sourceId,
      evidenceDigest: canonicalSha256({ snapshot, observation, installed: await hashNativeFile(metadataRoot, metadataPath) })
    };
  }

  async select(candidate: AdmittedNativeArtifact, mode: 'install' | 'upgrade'): Promise<NativeManagerSelection> {
    const snapshot = await this.snapshot(candidate);
    if (mode === 'install' && snapshot.installedVersion && snapshot.installedVersion !== candidate.version) {
      throw new DistributionError('A different version is already owned by the registered cask; npm handover cannot acquire its upgrade authority.', 'ownership_conflict');
    }
    const payload = candidate.release.manifest.targets[candidate.target];
    const definition = candidate.provenance.channelDefinitions?.find((entry) => entry.owner === this.owner);
    if (!definition || definition.packageId !== snapshot.packageId || definition.sourceId !== snapshot.sourceId ||
        definition.sha256 !== snapshot.definitionDigest) {
      throw new DistributionError('The configured cask definition is not the signed publisher-owned definition for this exact native target.', 'source_stale');
    }
    if (snapshot.version !== candidate.version || snapshot.url !== payload.archiveUrl || snapshot.checksum !== payload.checksumSha256) {
      throw new DistributionError('Upstream native target is not available as the same exact artifact in the configured Homebrew source. Refresh is a separate manual action.', 'source_stale');
    }
    const parts = snapshot.binaryRelativePath.split('/');
    const entryParts = candidate.provenance.entrypoints.launcher.split('/');
    if (snapshot.binaryRelativePath !== [candidate.archiveRoot, candidate.provenance.entrypoints.launcher].filter(Boolean).join('/') ||
        parts.slice(-entryParts.length).join('/') !== entryParts.join('/')) {
      throw new DistributionError('Cask launcher is not the exact admitted archive-root native entrypoint.', 'ownership_conflict');
    }
    const selected: NativeManagerSelection = freeze({
      owner: this.owner, packageId: snapshot.packageId, version: candidate.version,
      destinationDirectory: path.join(snapshot.caskRoot, candidate.version, ...parts.slice(0, -entryParts.length)),
      launcherPath: path.join(snapshot.prefix, 'bin', 'liftoff'), sourceId: snapshot.sourceId, sourceDigest: snapshot.sourceDigest,
      bindingDigest: snapshot.bindingDigest,
      command: { executable: snapshot.tool, args: [mode === 'upgrade' ? 'upgrade' : 'install', '--cask', snapshot.packageId] }
    });
    if (mode === 'install' && snapshot.installedVersion) await canonicalNativeRoot(selected.destinationDirectory);
    this.selections.set(selected, { candidate, mode });
    return selected;
  }

  async recheck(selection: NativeManagerSelection): Promise<void> {
    const state = this.selections.get(selection);
    if (!state) throw new DistributionError('Homebrew operation was not selected by this exact owner adapter.', 'stale_plan');
    const current = await this.select(state.candidate, state.mode);
    if (canonicalJson(current) !== canonicalJson(selection)) throw new DistributionError('Homebrew owner, source, target, tool, or destination changed.', 'stale_plan');
  }

  async execute(selection: NativeManagerSelection): Promise<void> {
    await this.recheck(selection);
    const result = await this.runner.run(selection.command, {
      cwd: path.dirname(selection.command.executable), env: this.managerEnv(), timeoutMs: 300_000,
      maxOutputBytes: 64 * 1024, ensureProcessTreeSettled: true
    });
    assertNativeCommandSucceeded(result, 'Exact Homebrew Liftoff cask operation');
  }

  async verify(candidate: AdmittedNativeCandidate, selection: NativeManagerSelection): Promise<NativeManagerInstallation> {
    const installed = await this.observeInstallation(candidate);
    if (!installed || installed.launcherPath !== selection.launcherPath || installed.packageId !== selection.packageId ||
        installed.version !== selection.version || installed.sourceId !== selection.sourceId) {
      throw new DistributionError('Homebrew replacement readback does not match the selected owner and target.', 'verification_failed');
    }
    return installed;
  }
}
