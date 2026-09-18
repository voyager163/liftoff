import { generateKeyPairSync, sign } from 'node:crypto';
import type { NativeReleaseManifest, NativeTargetPayload } from '../../src/domain/distribution/contracts.js';
import type { NativeTrustRegistration } from '../../src/domain/distribution/native-trust.js';
import type { NativeArtifactSource } from '../../src/adapters/distribution/native-release-client.js';
import { buildMigrationPlan } from '../../src/domain/distribution/migration-plan.js';
import { nativeTargetFloors } from '../../src/domain/distribution/contracts.js';

export function validManifest(): NativeReleaseManifest {
  const base = 'https://github.com/voyager163/liftoff/releases/download/v0.13.0/';
  const payload = (os: 'darwin' | 'linux' | 'win32', arch: 'x64' | 'arm64'): NativeTargetPayload => ({
    os, arch, archiveUrl: `${base}${os}-${arch}.${os === 'win32' ? 'zip' : 'tar.gz'}`,
    archiveFormat: os === 'win32' ? 'zip' : 'tar.gz', checksumSha256: 'a'.repeat(64),
    signatureUrl: `${base}${os}-${arch}.sig`, provenanceUrl: `${base}${os}-${arch}.provenance.json`,
    runtime: {
      nodeVersion: '24.20.0',
      ...(os === 'darwin' ? nativeTargetFloors.darwin : {}),
      ...(os === 'linux' ? { minimumGlibc: '2.31', minimumKernelVersion: '4.18.0' } : {}),
      ...(os === 'win32' ? { minimumHostVersion: '10.0.17763', minimumBuild: 17763 } : {})
    },
    resources: { inventoryHash: 'b'.repeat(64), count: 3 }
  });
  return {
    schemaVersion: 1, product: 'liftoff', version: '0.13.0', sourceCommit: '7'.repeat(40), publishedAt: '2026-09-14T00:00:00.000Z',
    targets: {
      'darwin-x64': payload('darwin', 'x64'), 'darwin-arm64': payload('darwin', 'arm64'),
      'linux-x64': payload('linux', 'x64'), 'linux-arm64': payload('linux', 'arm64'),
      'win32-x64': payload('win32', 'x64'), 'win32-arm64': payload('win32', 'arm64')
    }
  };
}

export function signedManifestTransport(manifest = validManifest()) {
  const keys = generateKeyPairSync('ed25519');
  const manifestUrl = 'https://github.com/voyager163/liftoff/releases/download/v0.13.0/manifest.json';
  const signatureUrl = `${manifestUrl}.sig`;
  const trust: NativeTrustRegistration = {
    schemaVersion: 1, repository: 'voyager163/liftoff', stableVersion: '0.13.0',
    signers: [{ id: 'fixture', publicKeyPem: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString() }],
    publications: [{ version: '0.13.0', sourceCommit: '7'.repeat(40), manifestUrl, signatureUrl, signerId: 'fixture', publicationAuthorized: true }],
    channels: [{ owner: 'direct', packageId: 'liftoff', sourceId: 'fixture', sourceUrl: 'https://github.com/voyager163/liftoff/releases' }]
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const responses = new Map<string, Buffer>([[manifestUrl, bytes], [signatureUrl, sign(null, bytes, keys.privateKey)]]);
  const requests: string[] = [];
  const source: NativeArtifactSource = {
    async readBytes(url, maximum) {
      requests.push(url);
      const value = responses.get(url);
      if (!value || value.length > maximum) throw new Error('Fixture transport unavailable.');
      return value;
    }
  };
  return { trust, source, responses, requests, manifestUrl, signatureUrl, sign: (value: Buffer) => sign(null, value, keys.privateKey) };
}

export function validPlan() {
  return buildMigrationPlan({
    platform: 'linux', architecture: 'x64', targetOwner: 'direct', targetPackage: 'liftoff', targetVersion: '0.13.0',
    candidatePath: '/isolated/candidate', candidateIdentity: 'a'.repeat(64), destinationDirectory: '/isolated/native',
    launcherPath: '/isolated/bin/liftoff', transactionRoot: '/isolated', sourceId: 'fixture', sourceDigest: 'b'.repeat(64),
    bindingDigest: 'c'.repeat(64), createdAt: '2026-09-14T00:00:00.000Z', expiresAt: '2026-09-14T00:30:00.000Z',
    legacyInstallation: {
      owner: 'npm', packageName: '@msn-control/liftoff', installedVersion: '0.12.3', executablePath: '/isolated/npm/lib/node_modules/@msn-control/liftoff/dist/cli.js',
      prefix: '/isolated/npm', packageRoot: '/isolated/npm/lib/node_modules/@msn-control/liftoff',
      integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, evidenceDigest: 'd'.repeat(64),
      launcherPath: '/isolated/npm/bin/liftoff', launcherPaths: ['/isolated/npm/bin/liftoff'], launcherConflicts: []
    },
    recoveryCommand: "npm install --global --ignore-scripts --no-audit --no-fund '@msn-control/liftoff@0.12.3' --prefix '/isolated/npm'"
  });
}
