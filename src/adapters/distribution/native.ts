import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installedPackageRoot } from '../packaged-assets/package-root.js';
import { commandFailed, comparisonPath, pathApiForPlatform, readOnlyEnvironment } from '../../domain/distribution/liftoff-npm-installation.js';
import { SelfUpgradeFailure, selfUpgradeInstallTimeoutMs, selfUpgradeProbeTimeoutMs, selfUpgradeVerificationTimeoutMs } from '../../domain/distribution/liftoff-upgrade.js';
import type { NativeBundleInventory, NativeCandidate, NativeChannelObservation, NativeInstallation, NativeReleasePolicy, NativeUpgradePort } from '../../domain/distribution/native-upgrade.js';
import { authenticatedNativeCaskDefinition, lookupNativeStableCandidate, snapshotNativeStableMaterial,
  type NativeStableMaterial, type NativeStableSource } from './native-metadata.js';
import type { SelfUpgradeDependencies } from './upgrade-host.js';
import { isStableSemver } from '../../stable-release.js';
import { compareSemver } from '../../semver.js';
import { readHomebrewCaskOwnership } from './native-cask.js';
import { createNativeStableSource } from './native-transport.js';
import { stageAuthenticatedNativeArchive } from './native-archive.js';
import { readWindowsInstallerLayout } from './native-windows.js';
import { bundleInventory, bundlePath, nativeBundleLimits } from '../../../distribution/native/native-bundle-contract.mjs';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sha256 = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const metadataLimit = 8 * 1024 * 1024;

export function nativePolicy(value: unknown): NativeReleasePolicy {
  const invalid = () => new SelfUpgradeFailure('blocked', 'native_invalid');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  const fields = ['schemaVersion', 'repository', 'approvedSigningKeySha256', 'homebrew', 'winget', 'linux'];
  if (Object.keys(record).sort().join() !== fields.sort().join() || record.schemaVersion !== 1 ||
    record.repository !== 'voyager163/liftoff') throw invalid();
  const nested = (key: string, shapes: Record<string, RegExp>) => {
    const item = record[key];
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid();
    const values = item as Record<string, unknown>;
    if (Object.keys(values).sort().join() !== Object.keys(shapes).sort().join()) throw invalid();
    for (const [name, pattern] of Object.entries(shapes)) {
      if (values[name] !== null && (typeof values[name] !== 'string' || !pattern.test(values[name]))) throw invalid();
    }
  };
  if (record.approvedSigningKeySha256 !== null &&
    (typeof record.approvedSigningKeySha256 !== 'string' || !sha256.test(record.approvedSigningKeySha256))) throw invalid();
  nested('homebrew', { cask: /^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/, sourceRepository: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, developerTeamId: /^[A-Z0-9]{10}$/ });
  nested('winget', { packageIdentifier: /^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+$/, publisher: /^[^"\u0000-\u001f]{1,128}$/,
    certificateSha256: sha256, installerAppId: /^[A-Za-z0-9{}._-]{1,128}$/ });
  nested('linux', { archiveSigningKeySha256: sha256 });
  return value as NativeReleasePolicy;
}

export interface CaskOwnershipObservation {
  fullToken: string;
  sourceRepository: string;
  installedVersion: string;
  bundleRoot: string;
  launcher: string;
  receiptSha256?: string;
  definitionSha256?: string;
  tapCommit?: string;
}

export interface WinGetOwnershipObservation {
  packageIdentifier: string;
  source: string;
  publisher: string;
  appId: string;
  installedVersion: string;
  installLocation: string;
  launcher: string;
  certificateSha256: string;
  /** Authenticode verification of the selected stable launcher's exact bytes, not certificate presence. */
  signatureStatus?: 'valid' | 'invalid' | 'unknown';
  scope: 'user' | 'machine';
  bundleRoot?: string;
  /** Independent HKCU uninstall-entry hashes, not values copied from the local receipt. */
  installerRegistration?: { receiptSha256: string; currentSha256: string; launcherSha256: string };
}

export function assertCaskOwnership(
  observation: CaskOwnershipObservation, installation: Pick<NativeInstallation, 'bundleRoot' | 'launcher' | 'version'>,
  policy: NativeReleasePolicy
): void {
  if (!policy.homebrew.cask || !policy.homebrew.sourceRepository) throw new SelfUpgradeFailure('blocked', 'native_unqualified');
  if (observation.fullToken !== policy.homebrew.cask || observation.sourceRepository !== policy.homebrew.sourceRepository ||
    observation.installedVersion !== installation.version || observation.bundleRoot !== installation.bundleRoot ||
    observation.launcher !== installation.launcher) throw new SelfUpgradeFailure('blocked', 'unsupported_installation');
}

export function assertWinGetOwnership(
  observation: WinGetOwnershipObservation,
  installation: Pick<NativeInstallation, 'bundleRoot' | 'launcher' | 'version' | 'windowsInstaller'>,
  policy: NativeReleasePolicy
): void {
  const selected = policy.winget;
  if (!selected.packageIdentifier || !selected.publisher || !selected.installerAppId || !selected.certificateSha256) {
    throw new SelfUpgradeFailure('blocked', 'native_unqualified');
  }
  const layout = installation.windowsInstaller;
  if (!layout) throw new SelfUpgradeFailure('blocked', 'unsupported_installation');
  const samePath = (left: string, right: string) => comparisonPath(left, 'win32') === comparisonPath(right, 'win32');
  if (observation.packageIdentifier !== selected.packageIdentifier || observation.publisher !== selected.publisher ||
    observation.appId !== selected.installerAppId || observation.certificateSha256 !== selected.certificateSha256 ||
    observation.installedVersion !== installation.version ||
    !samePath(observation.installLocation, layout.installRoot) ||
    !samePath(observation.launcher, layout.stableLauncher) || observation.scope !== 'user' ||
    observation.signatureStatus !== 'valid' ||
    !observation.bundleRoot || !samePath(observation.bundleRoot, installation.bundleRoot) ||
    observation.installerRegistration?.receiptSha256 !== layout.receiptSha256 ||
    observation.installerRegistration?.currentSha256 !== layout.currentSha256 ||
    observation.installerRegistration?.launcherSha256 !== layout.stableLauncherSha256 ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(observation.source)) {
    throw new SelfUpgradeFailure('blocked', 'unsupported_installation');
  }
}

export interface NativeOwnerReaders {
  cask?(installation: NativeBundleInventory, policy: NativeReleasePolicy, neutralDirectory: string, signal: AbortSignal): Promise<CaskOwnershipObservation>;
  winget?(installation: NativeBundleInventory, policy: NativeReleasePolicy, neutralDirectory: string, signal: AbortSignal): Promise<WinGetOwnershipObservation>;
  stable?: NativeStableSource;
  channel?: NativeUpgradePort['channel'];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SelfUpgradeFailure('blocked', 'native_invalid');
  return value as Record<string, unknown>;
}

export function createNativeUpgradePort(dependencies: SelfUpgradeDependencies, overrides: NativeOwnerReaders = {}): NativeUpgradePort {
  const readers: NativeOwnerReaders = {
    cask: (...args) => readHomebrewCaskOwnership(dependencies, ...args),
    ...overrides
  };
  const api = pathApiForPlatform(dependencies.platform);
  const probeTimeoutMs = dependencies.probeTimeoutMs ?? selfUpgradeProbeTimeoutMs;
  const admitted = new Map<string, {
    description: string;
    material: NativeStableMaterial;
    policy: string;
    source: NativeStableSource;
  }>();
  const observe = async <T>(read: (signal: AbortSignal) => Promise<T>, channel = false): Promise<T> => {
    if (!Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs <= 0 || probeTimeoutMs > 2_147_483_647) {
      throw new SelfUpgradeFailure('failed', channel ? 'channel_invalid' : 'native_invalid');
    }
    const controller = new AbortController();
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([read(controller.signal), new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new SelfUpgradeFailure('failed', channel ? 'channel_timeout' : 'native_timeout'));
        }, probeTimeoutMs);
      })]);
      if (controller.signal.aborted || performance.now() - started >= probeTimeoutMs) {
        throw new SelfUpgradeFailure('failed', channel ? 'channel_timeout' : 'native_timeout');
      }
      return result;
    } catch (error) {
      if (error instanceof SelfUpgradeFailure) throw error;
      throw new SelfUpgradeFailure('failed', channel ? 'channel_unavailable' : 'native_unavailable');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
  const bytes = async (file: string, maximum = metadataLimit) => {
    if (!dependencies.readBytes) throw new SelfUpgradeFailure('blocked', 'native_invalid');
    return dependencies.readBytes(file, maximum);
  };
  const policy = async () => nativePolicy(await dependencies.readJson(
    path.join(installedPackageRoot, 'distribution', 'native', 'release-policy.json')
  ));
  const readCandidate = async (installation: NativeInstallation, approved: NativeReleasePolicy, source: NativeStableSource) => {
    let snapshot: NativeStableMaterial | undefined;
    const candidate = await lookupNativeStableCandidate(installation, approved, {
      readStable: async (target, signal) => {
        const material = await source.readStable(target, signal);
        snapshot = snapshotNativeStableMaterial(material);
        return snapshot;
      }
    });
    if (!snapshot) throw new SelfUpgradeFailure('failed', 'native_unavailable');
    return { candidate, state: { description: JSON.stringify(candidate), material: snapshot,
      policy: JSON.stringify(approved), source } };
  };
  const run = async (runtime: string, args: string[], directory: string, timeoutMs: number) => {
    const result = await dependencies.runner.run({ executable: runtime, args }, {
      cwd: directory, env: readOnlyEnvironment(dependencies, directory), inheritEnvironment: false, timeoutMs, maxOutputBytes: metadataLimit,
      ensureProcessTreeSettled: true
    });
    if (commandFailed(result) || result.processTreeSettled === false) {
      throw new SelfUpgradeFailure('failed', result.timedOut ? 'native_timeout' : 'native_invalid');
    }
    return result.stdout;
  };
  const bundle = async (packageRoot: string, version: string, directory: string): Promise<NativeBundleInventory | null> => {
    if (api.basename(packageRoot) !== 'application') return null;
    const bundleRoot = api.dirname(packageRoot);
    let manifestBytes: Buffer;
    try { manifestBytes = await bytes(api.join(bundleRoot, 'bundle.json')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new SelfUpgradeFailure('blocked', 'native_invalid');
    }
    let manifest: Record<string, unknown>;
    try { manifest = object(JSON.parse(manifestBytes.toString('utf8'))); }
    catch { throw new SelfUpgradeFailure('blocked', 'native_invalid'); }
    const pkg = object(manifest.package);
    const source = object(manifest.source);
    const platform = object(manifest.platform);
    const runtime = object(manifest.runtime);
    const inventory = object(manifest.inventory);
    const windows = dependencies.platform === 'win32';
    const launcherName = windows ? 'bin/liftoff.exe' : 'bin/liftoff';
    const runtimeName = windows ? 'runtime/node.exe' : 'runtime/node';
    if (manifest.schemaVersion !== 1 || manifest.kind !== 'liftoff-native-development-bundle' ||
      typeof manifest.releaseReady !== 'boolean' || pkg.name !== '@msn-control/liftoff' || pkg.version !== version ||
      source.repository !== 'voyager163/liftoff' || typeof source.commit !== 'string' || !commit.test(source.commit) ||
      platform.platform !== dependencies.platform || !['x64', 'arm64'].includes(String(platform.architecture)) ||
      platform.architecture !== dependencies.architecture ||
      manifest.launcher !== launcherName || runtime.executable !== runtimeName ||
      typeof inventory.sha256 !== 'string' || !sha256.test(inventory.sha256) || !Array.isArray(inventory.entries)) {
      throw new SelfUpgradeFailure('blocked', 'native_invalid');
    }
    const runtimePath = api.join(bundleRoot, ...runtimeName.split('/'));
    const launcher = api.join(bundleRoot, ...launcherName.split('/'));
    if (await dependencies.realpath(bundleRoot) !== bundleRoot || await dependencies.realpath(packageRoot) !== packageRoot ||
      await dependencies.realpath(dependencies.execPath) !== runtimePath) {
      throw new SelfUpgradeFailure('blocked', 'unsupported_installation');
    }
    let selectedLauncher: string | null = null;
    try {
      if (dependencies.runningExecutable && await dependencies.realpath(dependencies.runningExecutable) !==
        api.join(packageRoot, 'dist', 'cli.js')) throw new Error('Running executable differs.');
      if (dependencies.resolveLiftoff) {
        const selected = await dependencies.resolveLiftoff();
        selectedLauncher = selected;
        if (!selected || !windows && await dependencies.realpath(selected) !== launcher) throw new Error('Selected launcher differs.');
      }
    } catch {
      throw new SelfUpgradeFailure('blocked', 'executable_selection');
    }
    const observed: NativeBundleInventory = {
      packageRoot, bundleRoot, launcher, runtime: runtimePath, version,
      target: `${platform.platform}-${platform.architecture}`, manifestSha256: digest(manifestBytes),
      inventorySha256: inventory.sha256, sourceCommit: source.commit,
      identity: JSON.stringify([bundleRoot, digest(manifestBytes), inventory.sha256])
    };
    if (windows) {
      const approved = await policy();
      observed.windowsInstaller = Object.freeze(await observe(signal =>
        readWindowsInstallerLayout(dependencies, observed, approved, selectedLauncher, signal)));
      observed.identity = JSON.stringify([observed.identity, observed.windowsInstaller.identity]);
    }
    if (dependencies.platform === 'linux') {
      const prefix = api.dirname(api.dirname(bundleRoot));
      const saved = object(await dependencies.readJson(api.join(prefix, 'receipts', `${api.basename(bundleRoot)}.json`)));
      if (api.basename(api.dirname(bundleRoot)) !== 'versions' ||
        api.basename(bundleRoot) !== `${version}-${digest(manifestBytes)}` ||
        saved.manifestSha256 !== digest(manifestBytes) || saved.inventorySha256 !== inventory.sha256 ||
        saved.prefixSha256 !== digest(Buffer.from(prefix))) {
        throw new SelfUpgradeFailure('blocked', 'native_invalid');
      }
    }
    const helpers = ['installation/native-bundle-contract.mjs', 'installation/native-install.mjs',
      'installation/native-release-admission.mjs', 'installation/release-policy.json'];
    for (const name of [runtimeName, launcherName, 'application/dist/cli.js', ...helpers]) {
      const entries = inventory.entries.filter(entry => object(entry).path === name);
      if (entries.length !== 1) throw new SelfUpgradeFailure('blocked', 'native_invalid');
      const entry = object(entries[0]);
      const material = await bytes(api.join(bundleRoot, ...name.split('/')), name === runtimeName ? 256 * 1024 * 1024 : metadataLimit);
      if (entry.kind !== 'file' || entry.sha256 !== digest(material) || entry.bytes !== material.length) {
        throw new SelfUpgradeFailure('blocked', 'native_invalid');
      }
    }
    const inspectCode = 'const {bundleInventory}=await import(process.argv[2]);' +
      'const actual=await bundleInventory(process.argv[3]);process.stdout.write(JSON.stringify(actual));';
    const inspected = await run(runtimePath, ['--input-type=module', '-e', inspectCode, 'liftoff-native-owner-probe',
      pathToFileURL(api.join(bundleRoot, 'installation', 'native-bundle-contract.mjs')).href, bundleRoot], directory, probeTimeoutMs);
    if (JSON.stringify(JSON.parse(inspected)) !== JSON.stringify(inventory)) throw new SelfUpgradeFailure('blocked', 'native_invalid');
    return Object.freeze(observed);
  };
  const inspect: NativeUpgradePort['inspect'] = async (packageRoot, version, directory) => {
    const installation = await bundle(packageRoot, version, directory);
    if (!installation) return null;
    const selected = await policy();
    if (installation.windowsInstaller?.policySha256 &&
      installation.windowsInstaller.policySha256 !== digest(Buffer.from(JSON.stringify(selected)))) {
      throw new SelfUpgradeFailure('blocked', 'owner_changed');
    }
    if (dependencies.platform === 'linux') {
      const prefix = api.dirname(api.dirname(installation.bundleRoot));
      const inspected = await run(installation.runtime, ['--input-type=module', '-e',
        'const {inspectOwnedInstallation}=await import(process.argv[2]);process.stdout.write(JSON.stringify(await inspectOwnedInstallation(process.argv[3])));',
        'liftoff-native-owner-probe', pathToFileURL(api.join(installation.bundleRoot, 'installation', 'native-install.mjs')).href,
        prefix], directory, probeTimeoutMs);
      const current: unknown = JSON.parse(inspected);
      if (typeof current !== 'string' || api.join(prefix, ...current.split('/')) !== installation.bundleRoot) {
        throw new SelfUpgradeFailure('blocked', 'unsupported_installation');
      }
      let recovery: NativeInstallation['recovery'];
      try {
        const journal = await bytes(api.join(prefix, '.native-install-transaction.json'));
        recovery = { journalSha256: digest(journal) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new SelfUpgradeFailure('blocked', 'native_invalid');
      }
      let locked = false;
      try {
        const owner = await bytes(api.join(prefix, '.native-install-lock', 'owner.json'), 4096);
        locked = true;
        if (recovery) recovery.staleLockOwnerSha256 = digest(owner);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new SelfUpgradeFailure('blocked', 'native_invalid');
        try {
          await dependencies.lstat(api.join(prefix, '.native-install-lock'));
          throw new SelfUpgradeFailure('blocked', 'native_invalid');
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code !== 'ENOENT') throw lockError;
        }
      }
      return { ...installation, owner: 'liftoff-native', prefix, current, ...(recovery ? { recovery } : {}), ...(locked ? { locked } : {}),
        identity: JSON.stringify([installation.identity, prefix, current, recovery, locked]) };
    }
    if (dependencies.platform === 'darwin') {
      if (!selected.homebrew.cask) throw new SelfUpgradeFailure('blocked', 'native_unqualified');
      if (!readers.cask) throw new SelfUpgradeFailure('blocked', 'native_unavailable');
      const observation = await observe(signal => readers.cask!(installation, selected, directory, signal));
      assertCaskOwnership(observation, installation, selected);
      return { ...installation, owner: 'homebrew-cask', managerId: observation.fullToken,
        managerSource: observation.sourceRepository, identity: JSON.stringify([installation.identity, observation]) };
    }
    if (dependencies.platform === 'win32') {
      if (!selected.winget.packageIdentifier) throw new SelfUpgradeFailure('blocked', 'native_unqualified');
      if (!readers.winget) throw new SelfUpgradeFailure('blocked', 'native_unavailable');
      const observation = await observe(signal => readers.winget!(installation, selected, directory, signal));
      assertWinGetOwnership(observation, installation, selected);
      const latestPolicy = await policy();
      if (!installation.windowsInstaller || installation.windowsInstaller.policySha256 !== digest(Buffer.from(JSON.stringify(latestPolicy)))) {
        throw new SelfUpgradeFailure('blocked', 'owner_changed');
      }
      try {
        const refreshed = await observe(async signal => readWindowsInstallerLayout(dependencies, installation, latestPolicy,
          await dependencies.resolveLiftoff?.() ?? null, signal));
        if (refreshed.identity !== installation.windowsInstaller.identity) throw new SelfUpgradeFailure('blocked', 'owner_changed');
      } catch (error) {
        if (error instanceof SelfUpgradeFailure && ['unsupported_installation', 'executable_selection'].includes(error.reasonCode)) {
          throw new SelfUpgradeFailure('blocked', 'owner_changed');
        }
        throw error;
      }
      return { ...installation, owner: 'winget', managerId: observation.packageIdentifier,
        managerSource: observation.source, managerScope: 'user', identity: JSON.stringify([installation.identity, observation]) };
    }
    throw new SelfUpgradeFailure('blocked', 'unsupported_installation');
  };
  return {
    inspect,
    stable: async (installation, directory) => {
      const approved = await policy();
      if (!approved.approvedSigningKeySha256 ||
        installation.owner === 'liftoff-native' && !approved.linux.archiveSigningKeySha256 ||
        installation.owner === 'homebrew-cask' && !approved.homebrew.developerTeamId ||
        installation.owner === 'winget' && !approved.winget.certificateSha256) {
        throw new SelfUpgradeFailure('blocked', 'native_unqualified');
      }
      const source = Object.hasOwn(overrides, 'stable') ? readers.stable : createNativeStableSource(approved);
      if (!source) throw new SelfUpgradeFailure('blocked', 'native_unavailable');
      const { candidate, state } = await readCandidate(installation, approved, source);
      admitted.set(candidate.identity, state);
      return Object.freeze(candidate);
    },
    channel: async (installation, candidate, directory) => {
      let observation: NativeChannelObservation;
      if (readers.channel) {
        observation = await observe(signal => readers.channel!(installation, candidate, directory, signal), true);
      } else {
        const state = admitted.get(candidate.identity);
        const cask = installation.owner === 'homebrew-cask' && installation.target === 'darwin-arm64';
        const linux = installation.owner === 'liftoff-native' && /^linux-(?:x64|arm64)$/.test(installation.target);
        if (Object.hasOwn(overrides, 'channel') || !linux && !cask || cask && !readers.cask || !state ||
          state.description !== JSON.stringify(candidate)) throw new SelfUpgradeFailure('blocked', 'channel_unavailable');
        const approved = await policy();
        if (JSON.stringify(approved) !== state.policy) throw new SelfUpgradeFailure('blocked', 'channel_changed');
        try {
          const fresh = await readCandidate(installation, approved, state.source);
          if (compareSemver(fresh.candidate.version, candidate.version) < 0) {
            return { status: 'lagging', version: fresh.candidate.version };
          }
          if (fresh.state.description !== state.description) throw new SelfUpgradeFailure('blocked', 'channel_changed');
          if (cask) {
            const definition = await authenticatedNativeCaskDefinition(fresh.state.material, candidate, approved);
            const owner = await observe(signal => readers.cask!(installation, approved, directory, signal), true);
            assertCaskOwnership(owner, installation, approved);
            if (!owner.definitionSha256 || !sha256.test(owner.definitionSha256) ||
              !owner.receiptSha256 || !sha256.test(owner.receiptSha256) || !owner.tapCommit || !commit.test(owner.tapCommit)) {
              throw new SelfUpgradeFailure('blocked', 'channel_unavailable');
            }
            if (owner.definitionSha256 !== definition.sha256 || JSON.stringify(await policy()) !== state.policy) {
              throw new SelfUpgradeFailure('blocked', 'channel_changed');
            }
            observation = { status: 'available', version: candidate.version, exactApply: false,
              artifactSha256: candidate.archiveSha256,
              identity: digest(Buffer.from(JSON.stringify(['homebrew-cask', candidate.identity, definition.sha256, owner]))) };
          } else {
            observation = { status: 'available', version: candidate.version, exactApply: true,
              artifactSha256: candidate.archiveSha256,
              identity: digest(Buffer.from(JSON.stringify(['liftoff-native', installation.target, candidate.identity, candidate.archiveSha256]))) };
          }
          admitted.set(candidate.identity, fresh.state);
        } catch (error) {
          if (error instanceof SelfUpgradeFailure) {
            if (error.reasonCode === 'native_timeout') throw new SelfUpgradeFailure('failed', 'channel_timeout');
            if (error.reasonCode === 'native_invalid') throw new SelfUpgradeFailure('failed', 'channel_invalid');
            if (error.reasonCode === 'native_unavailable') throw new SelfUpgradeFailure('failed', 'channel_unavailable');
            if (error.reasonCode === 'unsupported_installation' || error.reasonCode === 'owner_changed') {
              throw new SelfUpgradeFailure('blocked', 'channel_changed');
            }
          }
          throw error;
        }
      }
      if (!observation || !['available', 'lagging', 'absent'].includes(observation.status) ||
        observation.status !== 'absent' && !isStableSemver(observation.version) ||
        observation.status === 'lagging' && compareSemver(observation.version, candidate.version) >= 0) {
        throw new SelfUpgradeFailure('failed', 'channel_invalid');
      }
      if (observation.status === 'available') {
        const expected = installation.owner === 'winget' ? candidate.windowsInstaller?.sha256 : candidate.archiveSha256;
        if (observation.version !== candidate.version || typeof observation.identity !== 'string' ||
          !observation.identity || typeof observation.exactApply !== 'boolean' ||
          !expected || observation.artifactSha256 !== expected) throw new SelfUpgradeFailure('failed', 'channel_invalid');
      }
      return observation;
    },
    apply: async (installation, candidate, directory) => {
      let installStarted = false, installed = false;
      try {
        const state = admitted.get(candidate.identity);
        if (!state || state.description !== JSON.stringify(candidate)) throw new SelfUpgradeFailure('blocked', 'native_unqualified');
        if (installation.owner !== 'liftoff-native' || !installation.prefix || !installation.current ||
          dependencies.platform !== 'linux' || installation.target !== candidate.target) {
          throw new SelfUpgradeFailure('blocked', 'manual_handoff');
        }
        const approved = await policy();
        if (JSON.stringify(approved) !== state.policy) throw new SelfUpgradeFailure('blocked', 'owner_changed');
        let stage: Awaited<ReturnType<typeof stageAuthenticatedNativeArchive>> | undefined;
        let bundleRoot = candidate.bundleRoot;
        const started = performance.now();
        if (!bundleRoot) {
          const archive = state.material.assets.get(`liftoff-${candidate.version}-${candidate.target}.tar.gz`);
          if (!archive || !state.material.archiveSignature || !state.material.archivePublicKey ||
            !approved.linux.archiveSigningKeySha256) throw new SelfUpgradeFailure('blocked', 'native_unqualified');
          const current = await inspect(installation.packageRoot, installation.version, directory);
          if (!current || current.identity !== installation.identity || current.recovery || current.locked) {
            throw new SelfUpgradeFailure('blocked', 'owner_changed');
          }
          stage = await stageAuthenticatedNativeArchive({
            archive, signature: state.material.archiveSignature, publicKey: state.material.archivePublicKey,
            expectedKeySha256: approved.linux.archiveSigningKeySha256, candidate,
            contract: Object.freeze({ bundleInventory, bundlePath, nativeBundleLimits }), storage: dependencies,
            signal: AbortSignal.timeout(selfUpgradeInstallTimeoutMs)
          });
          bundleRoot = stage.bundleRoot;
          const finalOwner = await inspect(installation.packageRoot, installation.version, directory);
          if (!finalOwner || finalOwner.identity !== installation.identity || finalOwner.recovery || finalOwner.locked) {
            throw new SelfUpgradeFailure('blocked', 'owner_changed');
          }
        }
        const manifestBytes = await bytes(api.join(bundleRoot, 'bundle.json'));
        const manifest = object(JSON.parse(manifestBytes.toString('utf8')));
        const pkg = object(manifest.package);
        const source = object(manifest.source);
        const platform = object(manifest.platform);
        if (digest(manifestBytes) !== candidate.manifestSha256 || pkg.name !== '@msn-control/liftoff' ||
          pkg.version !== candidate.version || source.repository !== 'voyager163/liftoff' || source.commit !== candidate.sourceCommit ||
          `${platform.platform}-${platform.architecture}` !== candidate.target ||
          object(manifest.inventory).sha256 !== candidate.inventorySha256 || manifest.releaseReady !== true) {
          throw new SelfUpgradeFailure('blocked', 'native_invalid');
        }
        const remaining = stage ? Math.floor(selfUpgradeInstallTimeoutMs - (performance.now() - started)) : selfUpgradeInstallTimeoutMs;
        if (remaining <= 0) throw new SelfUpgradeFailure('failed', 'native_install_timeout');
        installStarted = true;
        await run(installation.runtime, [
          '--input-type=module', '-e',
          'const {installOwnedBundle}=await import(process.argv[2]);' +
          'const {assertNativeHost,observeNativeHost}=await import(process.argv[7]);await installOwnedBundle({' +
          'source:process.argv[3],prefix:process.argv[4],expectedManifestSha256:process.argv[5],expectedCurrent:process.argv[6],' +
          'admitHost:()=>assertNativeHost(observeNativeHost(),{publicInstallation:true})});',
          'liftoff-native-owner-probe', pathToFileURL(api.join(installation.bundleRoot, 'installation', 'native-install.mjs')).href,
          bundleRoot, installation.prefix, candidate.manifestSha256, installation.current,
          pathToFileURL(api.join(installation.bundleRoot, 'installation', 'host.mjs')).href
        ], directory, remaining);
        installed = true;
        await stage?.dispose();
        return { effects: 'installed' };
      } catch (error) {
        if (!installStarted) throw new SelfUpgradeFailure(
          error instanceof SelfUpgradeFailure ? error.status : 'failed',
          error instanceof SelfUpgradeFailure ? error.reasonCode : 'native_invalid', undefined, 'none');
        if (installed) throw new SelfUpgradeFailure('failed', 'cleanup_failed', undefined, 'installed');
        throw new SelfUpgradeFailure('failed', error instanceof SelfUpgradeFailure && error.reasonCode === 'native_timeout'
          ? 'native_install_timeout' : 'native_install_failed', undefined, 'possible');
      }
    },
    recover: async (installation, selection, directory) => {
      if (installation.owner !== 'liftoff-native' || !installation.prefix || !installation.recovery ||
        selection.journalSha256 !== installation.recovery.journalSha256 ||
        selection.staleLockOwnerSha256 !== installation.recovery.staleLockOwnerSha256 ||
        !sha256.test(selection.journalSha256)) throw new SelfUpgradeFailure('blocked', 'recovery_required');
      const current = await inspect(installation.packageRoot, installation.version, directory);
      if (!current || current.identity !== installation.identity) throw new SelfUpgradeFailure('blocked', 'owner_changed');
      await run(installation.runtime, ['--input-type=module', '-e',
        'const {recoverOwnedInstallation}=await import(process.argv[2]);' +
        'await recoverOwnedInstallation({prefix:process.argv[3],expectedJournalSha256:process.argv[4],' +
        'expectedStaleLockSha256:process.argv[5]||undefined});',
        'liftoff-native-owner-probe', pathToFileURL(api.join(installation.bundleRoot, 'installation', 'native-install.mjs')).href,
        installation.prefix,
        selection.journalSha256, selection.staleLockOwnerSha256 ?? ''], directory, selfUpgradeInstallTimeoutMs);
    },
    verify: async (installation, candidate, directory) => {
      if (!installation.prefix) throw new SelfUpgradeFailure('failed', 'verification_failed');
      const replacementRoot = api.join(installation.prefix, 'versions', `${candidate.version}-${candidate.manifestSha256}`, 'application');
      const replacementRuntime = api.join(api.dirname(replacementRoot), 'runtime', dependencies.platform === 'win32' ? 'node.exe' : 'node');
      const replacementPort = createNativeUpgradePort({ ...dependencies, execPath: replacementRuntime,
        runningExecutable: api.join(replacementRoot, 'dist', 'cli.js') }, readers);
      const replacement = await replacementPort.inspect(replacementRoot, candidate.version, directory);
      if (!replacement || replacement.owner !== installation.owner || replacement.manifestSha256 !== candidate.manifestSha256 ||
        replacement.inventorySha256 !== candidate.inventorySha256 || replacement.sourceCommit !== candidate.sourceCommit) {
        throw new SelfUpgradeFailure('failed', 'verification_failed');
      }
      const output = await run(replacement.runtime, [api.join(replacement.packageRoot, 'dist', 'cli.js'), '--version'],
        directory, selfUpgradeVerificationTimeoutMs);
      if (output.trim() !== `Liftoff ${candidate.version}`) throw new SelfUpgradeFailure('failed', 'verification_failed');
      if (dependencies.resolveLiftoff) {
        const selected = await dependencies.resolveLiftoff();
        if (!selected || await dependencies.realpath(selected) !== replacement.launcher) {
          throw new SelfUpgradeFailure('failed', 'executable_selection');
        }
      } else {
        const selected = api.join(installation.prefix, 'bin', 'liftoff');
        if (await dependencies.realpath(selected) !== replacement.launcher) throw new SelfUpgradeFailure('failed', 'executable_selection');
      }
    }
  };
}
