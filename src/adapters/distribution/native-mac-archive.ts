import { deepStrictEqual } from 'node:assert';
import type { NativeCandidate, NativeReleasePolicy } from '../../domain/distribution/native-upgrade.js';
import { SelfUpgradeFailure, selfUpgradeInstallTimeoutMs } from '../../domain/distribution/liftoff-upgrade.js';
import { verifyNativeArchiveInventory, type NativeArchiveContract, type NativeArchiveInventory } from './native-archive.js';
import { admitNativeStableMaterial, snapshotNativeStableMaterial, type NativeStableMaterial } from './native-metadata.js';

/** Authenticated archive inventory, not installed ownership, freshness or permission to execute. */
export async function verifyAuthenticatedMacCandidateArchive(options: {
  material: NativeStableMaterial;
  candidate: NativeCandidate;
  policy: NativeReleasePolicy;
  contract: Pick<NativeArchiveContract, 'bundlePath' | 'nativeBundleLimits'>;
  signal: AbortSignal;
}): Promise<Readonly<{ candidate: Readonly<NativeCandidate> } & NativeArchiveInventory>> {
  const started = performance.now();
  const deadline = new AbortController();
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  const timeout = () => new SelfUpgradeFailure('failed', 'native_timeout');
  const check = () => {
    if (signal.aborted || performance.now() - started >= selfUpgradeInstallTimeoutMs) throw timeout();
  };
  const timer = setTimeout(() => deadline.abort(), selfUpgradeInstallTimeoutMs);
  let interrupt = () => {};
  const aborted = new Promise<never>((_, reject) => {
    interrupt = () => reject(timeout());
    if (signal.aborted) interrupt();
    else signal.addEventListener('abort', interrupt, { once: true });
  });
  try {
    return await Promise.race([aborted, (async () => {
      check();
      if (options.candidate.target !== 'darwin-arm64') throw new SelfUpgradeFailure('failed', 'native_invalid');
      if (!options.policy.approvedSigningKeySha256 || !options.policy.homebrew.cask ||
        !options.policy.homebrew.sourceRepository || !options.policy.homebrew.developerTeamId) {
        throw new SelfUpgradeFailure('blocked', 'native_unqualified');
      }
      const archiveName = `liftoff-${options.candidate.version}-darwin-arm64.tar.gz`;
      const archive = options.material.assets.get(archiveName);
      if (!archive || archive.length === 0 || archive.length > 256 * 1024 * 1024) {
        throw new SelfUpgradeFailure('failed', 'native_invalid');
      }
      const candidate = structuredClone(options.candidate), policy = structuredClone(options.policy);
      const macMaterial = { ...options.material };
      delete macMaterial.archiveSignature;
      delete macMaterial.archivePublicKey;
      const material = snapshotNativeStableMaterial(macMaterial);
      const contract = { bundlePath: options.contract.bundlePath,
        nativeBundleLimits: Object.freeze({ ...options.contract.nativeBundleLimits }) };
      const admitted = await admitNativeStableMaterial(material, { target: 'darwin-arm64' }, policy);
      check();
      deepStrictEqual(admitted, candidate);
      const verified = await verifyNativeArchiveInventory({
        archive: material.assets.get(archiveName)!, candidate: admitted, contract, signal
      });
      check();
      const subject = { ...admitted };
      delete subject.bundleRoot;
      return Object.freeze({ ...verified, candidate: Object.freeze(subject) });
    })()]);
  } catch (error) {
    if (error instanceof SelfUpgradeFailure) throw error;
    check();
    throw new SelfUpgradeFailure('failed', 'native_invalid');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', interrupt);
    deadline.abort();
  }
}
