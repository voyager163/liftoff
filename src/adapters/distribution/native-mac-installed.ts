import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  bundleInventory, bundlePath, nativeBundleLimits, readBundleFile
} from '../../../distribution/native/native-bundle-contract.mjs';
import type { NativeBundleInventory, NativeCandidate, NativeReleasePolicy } from '../../domain/distribution/native-upgrade.js';
import { SelfUpgradeFailure } from '../../domain/distribution/liftoff-upgrade.js';
import { admitNativeStableMaterial, snapshotNativeStableMaterial, type NativeStableMaterial } from './native-metadata.js';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const invalid = () => new SelfUpgradeFailure('failed', 'native_invalid');
const timeout = () => new SelfUpgradeFailure('failed', 'native_timeout');
const metadataBytes = 8 * 1024 * 1024;
const timeoutMs = 10_000;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

/** Inert installed-byte consistency, not archive extraction, manager ownership or permission to execute. */
export async function inspectMacInstalledCandidate(options: {
  bundleRoot: string;
  material: NativeStableMaterial;
  candidate: NativeCandidate;
  policy: NativeReleasePolicy;
  signal: AbortSignal;
}, inventoryReader: typeof bundleInventory = bundleInventory): Promise<Readonly<NativeBundleInventory>> {
  const started = performance.now();
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const check = () => {
    if (signal.aborted || performance.now() - started >= timeoutMs) throw timeout();
  };
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let interrupt = () => {};
  const aborted = new Promise<never>((_, reject) => {
    interrupt = () => reject(timeout());
    if (signal.aborted) interrupt();
    else signal.addEventListener('abort', interrupt, { once: true });
  });
  try {
    return await Promise.race([aborted, (async () => {
      check();
      const bundleRoot = options.bundleRoot;
      const candidate = structuredClone(options.candidate), policy = structuredClone(options.policy);
      if (candidate.target !== 'darwin-arm64' || !path.isAbsolute(bundleRoot) ||
        path.resolve(bundleRoot) !== bundleRoot || options.material.assets.size !== 4 ||
        options.material.platformEvidence.size > nativeBundleLimits.entries) throw invalid();
      const contents = [options.material.record, options.material.qualification, options.material.signature,
        options.material.publicKey, ...options.material.assets.values(), ...options.material.platformEvidence.values()];
      let bytes = 0;
      for (const content of contents) {
        if (!Buffer.isBuffer(content) || content.length > 256 * 1024 * 1024 ||
          (bytes += content.length) > nativeBundleLimits.totalBytes) throw invalid();
      }
      const material = snapshotNativeStableMaterial({ ...options.material,
        archiveSignature: undefined, archivePublicKey: undefined });
      const admitted = await admitNativeStableMaterial(material, { target: 'darwin-arm64' }, policy);
      check();
      if (!isDeepStrictEqual(admitted, candidate)) throw invalid();
      if (!(await lstat(bundleRoot)).isDirectory() || await realpath(bundleRoot) !== bundleRoot) throw invalid();
      const manifestFile = path.join(bundleRoot, 'bundle.json');
      const saved = await readBundleFile(manifestFile, metadataBytes);
      check();
      if (saved.identity.sha256 !== candidate.manifestSha256) throw invalid();
      const manifest = object(JSON.parse(saved.content.toString('utf8')));
      const pkg = object(manifest.package), source = object(manifest.source), platform = object(manifest.platform);
      const expected = object(manifest.inventory);
      if (manifest.schemaVersion !== 1 || manifest.kind !== 'liftoff-native-development-bundle' ||
        typeof manifest.releaseReady !== 'boolean' || pkg.name !== '@msn-control/liftoff' ||
        pkg.version !== candidate.version || source.repository !== policy.repository || source.commit !== candidate.sourceCommit ||
        platform.platform !== 'darwin' || platform.architecture !== 'arm64' ||
        manifest.launcher !== 'bin/liftoff' || object(manifest.runtime).executable !== 'runtime/node' ||
        expected.sha256 !== candidate.inventorySha256 || !Array.isArray(expected.entries) ||
        expected.entries.length > nativeBundleLimits.entries ||
        !Number.isSafeInteger(expected.totalBytes) || Number(expected.totalBytes) < 0 ||
        Number(expected.totalBytes) > nativeBundleLimits.totalBytes ||
        hash(JSON.stringify(expected.entries)) !== candidate.inventorySha256) throw invalid();
      const entries = expected.entries.map((entry: unknown) => {
        const record = object(entry);
        const name = bundlePath(record.path);
        if (name.split('/').length > nativeBundleLimits.depth ||
          !['directory', 'file', 'symlink'].includes(String(record.kind))) throw invalid();
        if (record.kind === 'file' && (!Number.isSafeInteger(record.bytes) || Number(record.bytes) < 0 ||
          Number(record.bytes) > nativeBundleLimits.fileBytes)) throw invalid();
        return { name, kind: record.kind };
      });
      const names = new Set<string>();
      const directories = new Set<string>(['.']);
      for (const entry of entries) {
        const alias = entry.name.normalize('NFC').toLowerCase();
        if (names.has(alias) || !directories.has(path.posix.dirname(entry.name))) throw invalid();
        names.add(alias);
        if (entry.kind === 'directory') directories.add(entry.name);
      }
      for (const name of ['runtime/node', 'bin/liftoff', 'application/dist/cli.js',
        'installation/native-bundle-contract.mjs', 'installation/native-install.mjs',
        'installation/native-release-admission.mjs', 'installation/release-policy.json']) {
        const found = expected.entries.filter((entry: unknown) => object(entry).path === name);
        if (found.length !== 1 || object(found[0]).kind !== 'file' ||
          ['runtime/node', 'bin/liftoff'].includes(name) && object(found[0]).mode !== 0o755) throw invalid();
      }
      const physical = async (): Promise<string> => {
        const identities: string[][] = [];
        for (const entry of [{ name: '', kind: 'directory' }, { name: 'bundle.json', kind: 'file' }, ...entries]) {
          check();
          const file = path.join(bundleRoot, entry.name);
          const stat = await lstat(file, { bigint: true });
          check();
          if (entry.kind === 'directory' ? !stat.isDirectory() || await realpath(file) !== file :
            entry.kind === 'file' ? !stat.isFile() || stat.nlink !== 1n : !stat.isSymbolicLink()) throw invalid();
          identities.push([entry.name, ...(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const)
            .map(key => String(stat[key]))]);
        }
        return hash(JSON.stringify(identities));
      };
      const before = await physical();
      check();
      // The canonical callback has no AbortSignal; a timeout refuses its result, not settlement of its in-flight reads.
      const inventory = await inventoryReader(bundleRoot, nativeBundleLimits);
      check();
      if (!isDeepStrictEqual(inventory, expected)) throw invalid();
      if (await physical() !== before) throw invalid();
      const current = await readBundleFile(manifestFile, metadataBytes);
      check();
      if (!current.content.equals(saved.content) || JSON.stringify(current.identity) !== JSON.stringify(saved.identity)) throw invalid();
      return Object.freeze({
        packageRoot: path.join(bundleRoot, 'application'), bundleRoot, launcher: path.join(bundleRoot, 'bin/liftoff'),
        runtime: path.join(bundleRoot, 'runtime/node'), version: candidate.version, target: candidate.target,
        manifestSha256: candidate.manifestSha256, inventorySha256: candidate.inventorySha256,
        sourceCommit: candidate.sourceCommit, identity: hash(JSON.stringify([bundleRoot, candidate.manifestSha256,
          candidate.inventorySha256, before]))
      });
    })()]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', interrupt);
    controller.abort();
  }
}
