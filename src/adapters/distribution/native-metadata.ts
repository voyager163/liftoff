import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installedPackageRoot } from '../packaged-assets/package-root.js';
import { SelfUpgradeFailure } from '../../domain/distribution/liftoff-upgrade.js';
import type { NativeCandidate, NativeInstallation, NativeReleasePolicy } from '../../domain/distribution/native-upgrade.js';
import { isStableSemver, stableReleaseLookupTimeoutMs } from '../../stable-release.js';

interface ReleaseAdmission {
  verifyNativeEvidenceSignature(bytes: Buffer, signature: Buffer, publicKey: Buffer, expectedKeySha256: string): unknown;
  assertNativePublicationEvidence(record: unknown, evidence: unknown, policy: NativeReleasePolicy): unknown;
}

export interface NativeStableMaterial {
  record: Buffer;
  qualification: Buffer;
  signature: Buffer;
  publicKey: Buffer;
  /** Downloaded deployed asset bytes, not local existence or asserted availability. */
  assets: ReadonlyMap<string, Buffer>;
  platformEvidence: ReadonlyMap<string, Buffer>;
  stableTag: string;
  draft: boolean;
  prerelease: boolean;
  bundleRoot?: string;
}

export interface NativeStableSource {
  readStable(installation: NativeInstallation, signal: AbortSignal): Promise<NativeStableMaterial>;
}

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Native metadata must be an object.');
  return value as Record<string, unknown>;
};
const sha256 = /^[a-f0-9]{64}$/;

export async function admitNativeStableMaterial(
  material: NativeStableMaterial, installation: Pick<NativeInstallation, 'target'>, policy: NativeReleasePolicy
): Promise<NativeCandidate> {
  if (!policy.approvedSigningKeySha256) throw new SelfUpgradeFailure('blocked', 'native_unqualified');
  try {
    if (material.record.length === 0 || material.record.length > 8 * 1024 * 1024 ||
      material.qualification.length === 0 || material.qualification.length > 8 * 1024 * 1024 ||
      material.signature.length !== 64 || material.publicKey.length > 4096) throw new Error('Metadata size differs.');
    const record = object(JSON.parse(material.record.toString('utf8')));
    if (record.schemaVersion !== 1 || record.kind !== 'liftoff-native-release-candidate' ||
      record.repository !== policy.repository || !isStableSemver(record.version) ||
      record.target !== installation.target || typeof record.commit !== 'string' || !/^[a-f0-9]{40}$/.test(record.commit) ||
      typeof record.manifestSha256 !== 'string' || !sha256.test(record.manifestSha256) ||
      typeof record.inventorySha256 !== 'string' || !sha256.test(record.inventorySha256) ||
      material.stableTag !== `v${record.version}` || material.draft || material.prerelease || !Array.isArray(record.files)) {
      throw new Error('Stable release identity differs.');
    }
    const admission = await import(pathToFileURL(path.join(installedPackageRoot, 'distribution', 'native',
      'native-release-admission.mjs')).href) as ReleaseAdmission;
    const evidence = object(admission.verifyNativeEvidenceSignature(material.qualification, material.signature,
      material.publicKey, policy.approvedSigningKeySha256));
    admission.assertNativePublicationEvidence(record, evidence, policy);
    const names = [`liftoff-${record.version}-${record.target}.tar.gz`, 'sbom.cdx.json', 'provenance.json', 'NOTICE'];
    let windowsInstaller: NativeCandidate['windowsInstaller'];
    const releaseBase = `https://github.com/${policy.repository}/releases/download/v${record.version}/`;
    if (record.target === 'darwin-arm64' && evidence.artifactUrl !== `${releaseBase}${names[0]}`) {
      throw new Error('Qualified cask asset URL differs.');
    }
    if (record.target === 'win32-x64') {
      const installer = object(evidence.windowsInstaller);
      const filename = `liftoff-${record.version}-win32-x64-setup.exe`;
      const content = material.assets.get(filename);
      if (installer.filename !== filename || installer.url !== `${releaseBase}${filename}` ||
        installer.appId !== policy.winget.installerAppId || installer.publisher !== policy.winget.publisher ||
        installer.certificateSha256 !== policy.winget.certificateSha256 || installer.commandVerified !== true ||
        !content || content.length === 0 || content.length > 1024 * 1024 * 1024 ||
        installer.bytes !== content.length || installer.sha256 !== hash(content)) {
        throw new Error('Deployed signed Windows installer differs.');
      }
      windowsInstaller = { filename, sha256: hash(content), bytes: content.length };
    }
    if (JSON.stringify(record.files.map((file: unknown) => object(file).filename)) !== JSON.stringify(names) ||
      material.assets.size !== names.length + (windowsInstaller ? 1 : 0)) {
      throw new Error('Asset inventory differs.');
    }
    for (const file of record.files) {
      const asset = object(file);
      const content = material.assets.get(String(asset.filename));
      const maximum = asset.filename === names[0] ? 1024 * 1024 * 1024 : 8 * 1024 * 1024;
      if (!content || content.length === 0 || content.length > maximum ||
        asset.bytes !== content.length || asset.sha256 !== hash(content) || asset.mode !== 0o644) throw new Error('Deployed release asset differs.');
    }
    const platformEvidence = object(evidence.evidenceDigests);
    if (material.platformEvidence.size !== Object.keys(platformEvidence).length) throw new Error('Qualification evidence inventory differs.');
    for (const [name, expected] of Object.entries(platformEvidence)) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || name.includes('..')) throw new Error('Unsafe platform evidence name.');
      const content = material.platformEvidence.get(name);
      if (!content || content.length > 8 * 1024 * 1024 || expected !== hash(content)) throw new Error('Referenced platform evidence differs.');
    }
    const provenance = object(JSON.parse(material.assets.get('provenance.json')!.toString('utf8')));
    const archive = object(record.files.find((value: unknown) => !['sbom.cdx.json', 'provenance.json', 'NOTICE'].includes(String(object(value).filename))));
    if (provenance._type !== 'https://in-toto.io/Statement/v1' || provenance.predicateType !== 'https://slsa.dev/provenance/v1' ||
      JSON.stringify(provenance.subject) !== JSON.stringify([{ name: archive.filename, digest: { sha256: archive.sha256 } }])) {
      throw new Error('Native provenance subject differs.');
    }
    const build = object(object(provenance.predicate).buildDefinition);
    const [platform, architecture] = installation.target.split('-');
    if (JSON.stringify(build.externalParameters) !== JSON.stringify({
      repository: policy.repository, commit: record.commit, packageVersion: record.version, target: { platform, architecture }
    })) throw new Error('Native provenance source differs.');
    const sbom = object(JSON.parse(material.assets.get('sbom.cdx.json')!.toString('utf8')));
    if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.6' || !Array.isArray(sbom.components) ||
      sbom.components.length < 3 || object(sbom.components[0]).name !== '@msn-control/liftoff' ||
      object(sbom.components[0]).version !== record.version || !Array.isArray(sbom.properties) ||
      !sbom.properties.some(item => object(item).name === 'liftoff:sourceCommit' && object(item).value === record.commit) ||
      !sbom.properties.some(item => object(item).name === 'liftoff:inventorySha256' && object(item).value === record.inventorySha256)) {
      throw new Error('Native SBOM source differs.');
    }
    if (material.bundleRoot && (!path.isAbsolute(material.bundleRoot) || path.resolve(material.bundleRoot) !== material.bundleRoot)) {
      throw new Error('Candidate bundle must have a canonical absolute path.');
    }
    return {
      version: record.version, target: installation.target, sourceCommit: record.commit,
      manifestSha256: record.manifestSha256, inventorySha256: record.inventorySha256,
      identity: hash(Buffer.concat([material.record, material.qualification, material.signature, material.publicKey])),
      archiveSha256: String(archive.sha256),
      ...(windowsInstaller ? { windowsInstaller } : {}),
      ...(material.bundleRoot ? { bundleRoot: material.bundleRoot } : {})
    };
  } catch {
    throw new SelfUpgradeFailure('failed', 'native_invalid');
  }
}

export async function lookupNativeStableCandidate(
  installation: NativeInstallation, policy: NativeReleasePolicy, source: NativeStableSource,
  timeoutMs = stableReleaseLookupTimeoutMs
): Promise<NativeCandidate> {
  if (!policy.approvedSigningKeySha256) throw new SelfUpgradeFailure('blocked', 'native_unqualified');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new SelfUpgradeFailure('failed', 'native_invalid');
  const controller = new AbortController();
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SelfUpgradeFailure('failed', 'native_timeout'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      source.readStable(installation, controller.signal).then(async material => {
        const candidate = await admitNativeStableMaterial(material, installation, policy);
        if (controller.signal.aborted || performance.now() - started >= timeoutMs) {
          throw new SelfUpgradeFailure('failed', 'native_timeout');
        }
        return candidate;
      }),
      timeout
    ]);
  } catch (error) {
    if (error instanceof SelfUpgradeFailure) throw error;
    throw new SelfUpgradeFailure('failed', 'native_unavailable');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
