import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { NativeStableMaterial } from '../../src/adapters/distribution/native-metadata.js';
import type { NativeInstallation, NativeReleasePolicy } from '../../src/domain/distribution/native-upgrade.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

export const nativeInstallation: NativeInstallation = {
  owner: 'liftoff-native', version: '0.12.3', target: 'linux-x64', packageRoot: '/fixture/versions/old/application',
  bundleRoot: '/fixture/versions/old', launcher: '/fixture/versions/old/bin/liftoff',
  runtime: '/fixture/versions/old/runtime/node', prefix: '/fixture', current: 'versions/old',
  manifestSha256: 'a'.repeat(64), inventorySha256: 'b'.repeat(64), sourceCommit: 'c'.repeat(40), identity: 'fixture-local-owner'
};

export function signedMaterial(target = 'linux-x64') {
  const key = generateKeyPairSync('ed25519');
  const archiveKey = generateKeyPairSync('ed25519');
  const keyDigest = hash(key.publicKey.export({ type: 'spki', format: 'der' }));
  const archiveKeyDigest = hash(archiveKey.publicKey.export({ type: 'spki', format: 'der' }));
  const policy: NativeReleasePolicy = {
    schemaVersion: 1, repository: 'voyager163/liftoff', approvedSigningKeySha256: keyDigest,
    homebrew: target === 'darwin-arm64'
      ? { cask: 'fixture/tools/liftoff', sourceRepository: 'fixture/homebrew-tools', developerTeamId: 'ABCDEFGHIJ' }
      : { cask: null, sourceRepository: null, developerTeamId: null },
    winget: { packageIdentifier: null, publisher: null, installerAppId: null, certificateSha256: null },
    linux: { archiveSigningKeySha256: archiveKeyDigest }
  };
  const archive = `liftoff-0.13.0-${target}.tar.gz`;
  const assets = new Map<string, Buffer>([
    [archive, Buffer.from('fixture deployed archive')],
    ['sbom.cdx.json', json({ bomFormat: 'CycloneDX', specVersion: '1.6',
      components: [{ name: '@msn-control/liftoff', version: '0.13.0' }, { name: 'node' }, { name: 'fixture-dependency' }],
      properties: [{ name: 'liftoff:sourceCommit', value: 'd'.repeat(40) },
        { name: 'liftoff:inventorySha256', value: 'e'.repeat(64) }] })],
    ['NOTICE', Buffer.from('Fixture-only license notices')]
  ]);
  assets.set('provenance.json', json({
    _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: archive, digest: { sha256: hash(assets.get(archive)!) } }],
    predicate: { buildDefinition: { externalParameters: {
      repository: policy.repository, commit: 'd'.repeat(40), packageVersion: '0.13.0',
      target: { platform: target.split('-')[0], architecture: target.split('-')[1] }
    } } }
  }));
  const record = {
    schemaVersion: 1, kind: 'liftoff-native-release-candidate', repository: policy.repository, commit: 'd'.repeat(40),
    runId: '12345', version: '0.13.0', target, manifestSha256: 'f'.repeat(64), inventorySha256: 'e'.repeat(64),
    files: [archive, 'sbom.cdx.json', 'provenance.json', 'NOTICE'].map(filename => ({
      filename, bytes: assets.get(filename)!.length, sha256: hash(assets.get(filename)!), mode: 0o644
    }))
  };
  const platformEvidence = new Map(['minimumHost', 'installerOwnership', 'signing', 'packageNamespace', 'hclSourceCorrespondence',
    ...(target === 'darwin-arm64' ? ['notarization'] : [])]
    .map(name => [name, json({ fixtureOnly: true, name })]));
  const qualification = {
    ...record, qualification: Object.fromEntries([...platformEvidence.keys()].map(name => [name, true])),
    evidenceDigests: Object.fromEntries([...platformEvidence].map(([name, bytes]) => [name, hash(bytes)])),
    platformSigningIdentity: target === 'darwin-arm64' ? policy.homebrew.developerTeamId : archiveKeyDigest,
    ...(target === 'darwin-arm64' ? {
      channel: { id: policy.homebrew.cask, source: policy.homebrew.sourceRepository },
      artifactUrl: `https://github.com/${policy.repository}/releases/download/v0.13.0/${archive}`
    } : {})
  };
  const material: NativeStableMaterial = {
    record: json(record), qualification: json(qualification), signature: sign(null, json(qualification), key.privateKey),
    publicKey: Buffer.from(key.publicKey.export({ type: 'spki', format: 'pem' })), assets, platformEvidence,
    archiveSignature: sign(null, assets.get(archive)!, archiveKey.privateKey),
    archivePublicKey: Buffer.from(archiveKey.publicKey.export({ type: 'spki', format: 'pem' })),
    stableTag: 'v0.13.0', draft: false, prerelease: false,
    bundleRoot: path.resolve(os.tmpdir(), 'liftoff-virtual-candidate')
  };
  const resign = () => {
    material.record = json(record);
    material.qualification = json(qualification);
    material.signature = sign(null, material.qualification, key.privateKey);
  };
  return { material, policy, record, qualification, assets, platformEvidence, resign };
}
