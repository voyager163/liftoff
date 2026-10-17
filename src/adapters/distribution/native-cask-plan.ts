import { createHash } from 'node:crypto';
import path from 'node:path';
import { SelfUpgradeFailure, selfUpgradeProbeTimeoutMs } from '../../domain/distribution/liftoff-upgrade.js';
import type {
  CaskDestinationObservation, CaskInstallPreview, CaskPreparationPort, NativeReleasePolicy
} from '../../domain/distribution/native-upgrade.js';
import { createCaskFileObservation } from './native-cask-files.js';
import { authenticatedNativeCaskDefinition, lookupNativeStableCandidate, snapshotNativeStableMaterial,
  type NativeStableMaterial, type NativeStableSource } from './native-metadata.js';
import { createNativeStableSource } from './native-transport.js';
import { nativePolicy } from './native.js';
import type { SelfUpgradeDependencies } from './upgrade-host.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const invalid = () => new SelfUpgradeFailure('blocked', 'unsupported_installation');
const changed = () => new SelfUpgradeFailure('blocked', 'owner_changed');

export function createHomebrewCaskPreparation(
  dependencies: SelfUpgradeDependencies, policy: NativeReleasePolicy,
  source?: NativeStableSource
): CaskPreparationPort {
  const approved = structuredClone(nativePolicy(policy));
  const stable = source ?? createNativeStableSource(approved);
  const namespace = (prefix: string): {
    prefix: CaskDestinationObservation['prefix']; token: string; fullToken: string; repository: string;
  } => {
    const fullToken = approved.homebrew.cask;
    const repository = approved.homebrew.sourceRepository;
    if (!fullToken || !repository) {
      throw new SelfUpgradeFailure('blocked', 'native_unqualified');
    }
    if (dependencies.platform !== 'darwin' || dependencies.architecture !== 'arm64' ||
      prefix !== '/opt/homebrew' && prefix !== '/usr/local') throw invalid();
    return { prefix, token: fullToken.split('/')[2], fullToken, repository };
  };
  const bounded = async <T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const timeoutMs = dependencies.probeTimeoutMs ?? selfUpgradeProbeTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new SelfUpgradeFailure('failed', 'native_invalid');
    }
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const started = performance.now();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let interrupt = () => {};
    const aborted = new Promise<never>((_, reject) => {
      interrupt = () => reject(new SelfUpgradeFailure('failed', controller.signal.aborted ? 'native_timeout' : 'native_unavailable'));
      if (combined.aborted) interrupt();
      else combined.addEventListener('abort', interrupt, { once: true });
    });
    try {
      const result = await Promise.race([operation(combined), aborted]);
      combined.throwIfAborted();
      if (performance.now() - started >= timeoutMs) throw new SelfUpgradeFailure('failed', 'native_timeout');
      return result;
    } catch (error) {
      if (error instanceof SelfUpgradeFailure) throw error;
      throw new SelfUpgradeFailure('failed', 'native_unavailable');
    } finally {
      combined.removeEventListener('abort', interrupt);
      clearTimeout(timer);
      controller.abort();
    }
  };
  const observe = async (input: string, signal: AbortSignal): Promise<CaskDestinationObservation> => {
    const { prefix, token } = namespace(input);
    const files = createCaskFileObservation(dependencies, prefix, signal);
    const caskRoot = path.posix.join(prefix, 'Caskroom', token);
    const launcher = path.posix.join(prefix, 'bin', 'liftoff');
    await files.inspectDirectories(path.posix.dirname(caskRoot));
    await files.inspectDirectories(path.posix.dirname(launcher));
    const presence = async (filename: string): Promise<CaskDestinationObservation['cask']> => {
      files.checkSignal();
      try {
        const stat = await dependencies.lstat(filename);
        files.checkSignal();
        return { state: 'occupied', identity: digest(JSON.stringify([
          filename, stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs,
          stat.isDirectory(), stat.isFile(), stat.isSymbolicLink()
        ])) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return { state: 'absent', identity: digest(JSON.stringify([filename, 'absent'])) };
      }
    };
    const cask = await presence(caskRoot);
    const selectedLauncher = await presence(launcher);
    await files.recheck();
    if (JSON.stringify([await presence(caskRoot), await presence(launcher)]) !== JSON.stringify([cask, selectedLauncher])) throw changed();
    const result = { prefix, caskRoot, launcher, cask, selectedLauncher };
    return { ...result, identity: digest(JSON.stringify([result, files.identity()])) };
  };
  return {
    observeDestination: (prefix, signal) => bounded(signal, observed => observe(prefix, observed)),
    preview: (input, signal) => bounded(signal, async observed => {
      const { prefix, token, fullToken, repository } = namespace(input);
      if (!approved.approvedSigningKeySha256 || !approved.homebrew.developerTeamId) {
        throw new SelfUpgradeFailure('blocked', 'native_unqualified');
      }
      const destination = await observe(prefix, observed);
      let material: NativeStableMaterial | undefined;
      const candidate = await lookupNativeStableCandidate({ target: 'darwin-arm64' }, approved, {
        readStable: async (target, boundedSignal) => {
          material = snapshotNativeStableMaterial(await stable.readStable(target, AbortSignal.any([observed, boundedSignal])));
          return material;
        }
      });
      if (!material) throw new SelfUpgradeFailure('failed', 'native_unavailable');
      const definition = await authenticatedNativeCaskDefinition(material, candidate, approved);
      const target = { ...candidate };
      delete target.bundleRoot;
      const [owner, tap] = fullToken.split('/');
      const casks = path.posix.join(prefix, 'Library', 'Taps', owner, `homebrew-${tap}`, 'Casks');
      const files = createCaskFileObservation(dependencies, prefix, observed);
      const readSource = async (): Promise<CaskInstallPreview['source']> => {
        const found: Exclude<CaskInstallPreview['source'], { state: 'absent' }>[] = [];
        for (const filename of [path.posix.join(casks, `${token}.rb`), path.posix.join(casks, token[0], `${token}.rb`)]) {
          try {
            const bytes = await files.file(filename, 256 * 1024);
            if (!bytes.length) throw new SelfUpgradeFailure('failed', 'native_invalid');
            found.push({ state: 'observed', path: filename, bytes: bytes.length, sha256: digest(bytes), authority: 'unverified-local-bytes' });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        if (found.length > 1) throw invalid();
        return found[0] ?? { state: 'absent' };
      };
      const caskSource = await readSource();
      await files.recheck();
      if (JSON.stringify(await readSource()) !== JSON.stringify(caskSource) ||
        (await observe(prefix, observed)).identity !== destination.identity) throw changed();
      const versionRoot = path.posix.join(destination.caskRoot, target.version);
      const preview: Omit<CaskInstallPreview, 'identity'> = {
        schemaVersion: 1, kind: 'liftoff-homebrew-cask-install-preview', effects: 'none', target,
        cask: fullToken, expectedSourceRepository: repository,
        destination: { ...destination, versionRoot, stagedLauncher: path.posix.join(versionRoot, 'bin', 'liftoff') },
        source: caskSource, channel: { status: 'unknown' },
        releaseDefinition: {
          authority: 'authenticated-release-definition', filename: definition.filename,
          bytes: definition.bytes, sha256: definition.sha256, candidateIdentity: target.identity,
          selectedSource: caskSource.state === 'absent' ? 'absent' : caskSource.sha256 === definition.sha256 ? 'exact' : 'different'
        },
        preflight: { nativeAppleSilicon: true, canonicalDirectories: true,
          caskAbsent: destination.cask.state === 'absent', launcherAbsent: destination.selectedLauncher.state === 'absent',
          exactExecutionProven: false },
        execution: { status: 'blocked', reason: 'exact_cask_execution_unproven', command: null }
      };
      return { ...preview, identity: digest(JSON.stringify([preview, files.identity()])) };
    })
  };
}
