import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  nativeTrustRootDigest, nativeTrustRootPathParts, parseNativeTrustRoot,
  type ConfiguredNativeTrustRoot, type NativePublicationIndex, type NativePublicationIndexEntry
} from '../../src/domain/distribution/native-trust.js';
import { validManifest } from './manifest-fixture.js';

export const publicTrustSha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export async function publicTrustFixture() {
  const directory = await realpath(await mkdtemp(path.join(path.resolve('tests'), '.native-public-trust-')));
  const identity = await lstat(directory);
  await mkdir(path.join(directory, 'assets', 'distribution'), { recursive: true, mode: 0o700 });
  const filename = path.join(directory, ...nativeTrustRootPathParts);
  const keys = generateKeyPairSync('ed25519');
  const otherKeys = generateKeyPairSync('ed25519');
  const parsed = parseNativeTrustRoot({
    schemaVersion: 1, product: 'liftoff', repository: 'voyager163/liftoff', state: 'configured',
    signers: [{ id: 'isolated-public-root-only', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
    publicationIndex: {
      url: 'https://github.com/voyager163/liftoff/releases/download/isolated-index-fixture/stable.json',
      signatureUrl: 'https://github.com/voyager163/liftoff/releases/download/isolated-index-fixture/stable.sig',
      signerId: 'isolated-public-root-only', minimumSequence: 1
    },
    channels: [{
      owner: 'direct', packageId: 'liftoff', sourceId: 'isolated-public-root-only',
      sourceUrl: 'https://github.com/voyager163/liftoff/releases'
    }]
  });
  if (parsed.state !== 'configured') throw new Error('Public trust fixture requires a configured test-only root.');
  const root: Readonly<ConfiguredNativeTrustRoot> = parsed;
  await writeFile(filename, JSON.stringify(root), { mode: 0o644 });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: '@msn-control/liftoff', version: '0.13.0', type: 'module', private: true
  }));
  let clock = Date.parse('2026-09-16T00:00:00.000Z');
  const responses = new Map<string, Buffer>();
  const requests: Array<{ url: string; options?: RequestInit }> = [];
  const publications: NativePublicationIndexEntry[] = [];
  let sequence = 0;
  let currentIndex: NativePublicationIndex;
  let beforeFetch: ((url: string) => Promise<void>) | undefined;
  let activeFetches = 0;
  const now = () => new Date(clock);
  const writeRoot = async (value: unknown) => writeFile(filename, JSON.stringify(value));
  const writeIndex = (value: unknown, key: KeyObject = keys.privateKey) => {
    const bytes = Buffer.from(JSON.stringify(value));
    responses.set(root.publicationIndex.url, bytes);
    responses.set(root.publicationIndex.signatureUrl, sign(null, bytes, key));
  };
  const publish = (version: string, sourceCommit = version === '0.13.0' ? '7'.repeat(40) : '8'.repeat(40)) => {
    const manifest = validManifest();
    manifest.version = version;
    manifest.sourceCommit = sourceCommit;
    manifest.publishedAt = new Date(clock - 60_000).toISOString();
    const base = `https://github.com/voyager163/liftoff/releases/download/v${version}/`;
    for (const [target, payload] of Object.entries(manifest.targets)) {
      payload.archiveUrl = `${base}${target}.${payload.archiveFormat}`;
      payload.signatureUrl = `${base}${target}.sig`;
      payload.provenanceUrl = `${base}${target}.provenance.json`;
    }
    const manifestUrl = `${base}manifest.json`;
    const signatureUrl = `${base}manifest.sig`;
    const bytes = Buffer.from(JSON.stringify(manifest));
    responses.set(manifestUrl, bytes);
    responses.set(signatureUrl, sign(null, bytes, keys.privateKey));
    const publication: NativePublicationIndexEntry = {
      version, sourceCommit, manifestUrl, signatureUrl,
      signerId: root.publicationIndex.signerId, manifestSha256: publicTrustSha(bytes)
    };
    publications.push(publication);
    currentIndex = {
      schemaVersion: 1, product: 'liftoff', repository: 'voyager163/liftoff',
      rootDigest: nativeTrustRootDigest(root), sequence: ++sequence,
      issuedAt: new Date(clock - 1000).toISOString(), expiresAt: new Date(clock + 60_000).toISOString(),
      stableVersion: version, publications: publications.map((entry) => ({ ...entry }))
    };
    writeIndex(currentIndex);
    return { manifest, publication };
  };
  const first = publish('0.13.0');
  const rewriteManifest = (raw: unknown, publication = first.publication, key: KeyObject = keys.privateKey) => {
    const bytes = Buffer.from(JSON.stringify(raw));
    responses.set(publication.manifestUrl, bytes);
    responses.set(publication.signatureUrl, sign(null, bytes, key));
    const changed = { ...publication, manifestSha256: publicTrustSha(bytes) };
    currentIndex = {
      ...currentIndex,
      publications: currentIndex.publications.map((entry) => entry.version === publication.version ? changed : entry)
    };
    writeIndex(currentIndex);
  };
  const fetchFn: typeof fetch = async (input, options) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, options });
    activeFetches++;
    try {
      await beforeFetch?.(url);
      const bytes = responses.get(url);
      if (!bytes) throw new Error('Test-only public transport has no registered response.');
      return new Response(Uint8Array.from(bytes));
    } finally { activeFetches--; }
  };
  return {
    directory, filename, root, keys, otherKeys, responses, requests, fetchFn, now,
    first, publish, writeRoot, writeIndex, rewriteManifest,
    index: () => currentIndex,
    setNow: (value: number) => { clock = value; },
    beforeFetch: (callback: (url: string) => Promise<void>) => { beforeFetch = callback; },
    cleanup: async () => {
      const current = await lstat(directory);
      if (activeFetches || await realpath(directory) !== directory || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error('Preserve this exact public trust fixture: work is active or its created root identity changed.');
      }
      await rm(directory, { recursive: true });
    }
  };
}

export type PublicTrustFixture = Awaited<ReturnType<typeof publicTrustFixture>>;
