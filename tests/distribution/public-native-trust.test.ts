import { generateKeyPairSync } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installedPackageRoot, setPackageRootOverride } from '../../src/adapters/packaged-assets/package-root.js';
import { readBoundedPackagedFile } from '../../src/adapters/packaged-assets/resource-file.js';
import { NativeReleaseClient } from '../../src/adapters/distribution/native-release-client.js';
import {
  nativeTrustRootDigest, nativeTrustRootMaximumBytes, nativeTrustRootPathParts, parseNativeTrustRoot
} from '../../src/domain/distribution/native-trust.js';
import { publicTrustFixture, type PublicTrustFixture } from './public-trust-fixture.js';

const fixtures: PublicTrustFixture[] = [];
const unconfigured = { schemaVersion: 1, product: 'liftoff', repository: 'voyager163/liftoff', state: 'unconfigured' };
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setPackageRootOverride(undefined);
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function fixture() {
  const value = await publicTrustFixture();
  fixtures.push(value);
  setPackageRootOverride(value.directory);
  vi.stubGlobal('fetch', value.fetchFn);
  return value;
}

describe('actual default packaged public trust loading', () => {
  it('ships an explicit unconfigured public source root, not operational qualification data', () => {
    const bytes = readBoundedPackagedFile(installedPackageRoot, nativeTrustRootPathParts, { maximumBytes: nativeTrustRootMaximumBytes });
    expect(parseNativeTrustRoot(JSON.parse(bytes.toString('utf8')))).toEqual(unconfigured);
  });

  it('rejects an explicitly unconfigured public root before network and ignores operational approval flags', async () => {
    const value = await fixture();
    await value.writeRoot(unconfigured);
    await mkdir(path.join(value.directory, 'assets', 'qualification'));
    await writeFile(path.join(value.directory, 'assets', 'qualification', 'release-scope.json'),
      '{"candidate":{"publicationAuthorized":true},"verification":{"nativeSigning":{"workflow":"must-not-be-read"}}}');
    vi.stubEnv('LIFTOFF_NATIVE_MANIFEST_URL', 'https://unselected.example/manifest.json');
    await expect(new NativeReleaseClient({ now: value.now }).fetchVerifiedRelease())
      .rejects.toMatchObject({ kind: 'trust_unconfigured', reasonCode: 'trust_unconfigured' });
    expect(value.requests).toHaveLength(0);
  });

  it('distinguishes a confirmed missing public leaf from malformed package boundaries', async () => {
    const value = await fixture();
    await unlink(value.filename);
    await expect(new NativeReleaseClient({ now: value.now }).fetchVerifiedRelease())
      .rejects.toMatchObject({ kind: 'trust_missing', reasonCode: 'trust_missing' });
    await rename(path.dirname(value.filename), path.join(value.directory, 'retained-distribution'));
    await expect(new NativeReleaseClient({ now: value.now }).fetchVerifiedRelease())
      .rejects.toMatchObject({ kind: 'trust_invalid', reasonCode: 'invalid_metadata' });
    expect(value.requests).toHaveLength(0);
  });

  it.each(['json', 'duplicate', 'product', 'repository', 'boolean', 'pins', 'private-key', 'rsa', 'endpoint', 'extra'] as const)(
    'rejects malformed %s trust before network', async (failure) => {
      const value = await fixture();
      if (failure === 'json') await writeFile(value.filename, '{');
      else if (failure === 'duplicate') await writeFile(value.filename, '{"schemaVersion":1,"state":"unconfigured","state":"configured"}');
      else if (failure === 'product') await value.writeRoot({ ...value.root, product: 'another-product' });
      else if (failure === 'repository') await value.writeRoot({ ...value.root, repository: 'another/repository' });
      else if (failure === 'boolean') await value.writeRoot({ ...value.root, state: true });
      else if (failure === 'pins') await value.writeRoot({ schemaVersion: 1, version: '24.20.0', targets: {} });
      else if (failure === 'private-key') await value.writeRoot({
        ...value.root, signers: [{ id: value.root.signers[0].id, publicKeyPem: value.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }]
      });
      else if (failure === 'rsa') {
        const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
        await value.writeRoot({ ...value.root, signers: [{ id: value.root.signers[0].id, publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] });
      } else if (failure === 'endpoint') await value.writeRoot({
        ...value.root, publicationIndex: { ...value.root.publicationIndex, url: 'https://localhost/index.json' }
      });
      else await value.writeRoot({ ...value.root, publicationAuthorized: true });
      await expect(new NativeReleaseClient({ now: value.now }).fetchVerifiedRelease()).rejects.toMatchObject({ kind: 'trust_invalid' });
      expect(value.requests).toHaveLength(0);
    }
  );

  it('enforces the exact root byte limit and rejects linked or mutable trust files', async () => {
    const value = await fixture();
    const bytes = JSON.stringify(unconfigured);
    await writeFile(value.filename, bytes.padEnd(nativeTrustRootMaximumBytes, ' '));
    await expect(new NativeReleaseClient({ now: value.now }).fetchVerifiedRelease()).rejects.toMatchObject({ kind: 'trust_unconfigured' });
    await writeFile(value.filename, bytes.padEnd(nativeTrustRootMaximumBytes + 1, ' '));
    await expect(new NativeReleaseClient({ now: value.now }).fetchVerifiedRelease()).rejects.toMatchObject({ kind: 'trust_invalid' });
    await value.writeRoot(value.root);
    if (process.platform !== 'win32') {
      await chmod(value.filename, 0o666);
      await expect(new NativeReleaseClient({ now: value.now }).fetchVerifiedRelease()).rejects.toMatchObject({ kind: 'trust_invalid' });
    }
    await chmod(value.filename, 0o644);
    const retained = path.join(value.directory, 'retained-root.json');
    await rename(value.filename, retained);
    await symlink(retained, value.filename);
    await expect(new NativeReleaseClient({ now: value.now }).fetchVerifiedRelease()).rejects.toMatchObject({ kind: 'trust_invalid' });
    expect(value.requests).toHaveLength(0);
  });

  it('rejects hidden fields, getters and sparse registries at the public parser boundary', async () => {
    const value = await fixture();
    expect(() => parseNativeTrustRoot(Object.defineProperty({ ...unconfigured }, 'signers', { value: [] }))).toThrow();
    expect(() => parseNativeTrustRoot({ ...value.root, signers: new Array(1) })).toThrow();
    const signer = Object.defineProperty({ id: 'unexpected' }, 'publicKeyPem', {
      enumerable: true, get: () => { throw new Error('Accessor must not execute.'); }
    });
    expect(() => parseNativeTrustRoot({ ...value.root, signers: [signer] })).toThrow(/plain data/);
  });
});

describe('default signed native index and manifest protocol', () => {
  it('authenticates actual packaged root/index/manifest bytes and advances stable without rewriting the installed CLI', async () => {
    const value = await fixture();
    const rootBytes = await readFile(value.filename);
    const packageBytes = await readFile(path.join(value.directory, 'package.json'));
    const filesBefore = await readdir(value.directory, { recursive: true });
    const client = new NativeReleaseClient({ now: value.now });
    const first = await client.fetchVerifiedRelease();
    expect(first.manifest.version).toBe('0.13.0');
    expect(first.publication.manifestSha256).toBe(first.manifestDigest);
    client.assertAdmitted(first);
    expect(() => client.assertAdmitted({ ...first })).toThrow(/not admitted/);
    value.publish('0.14.0');
    const next = await client.fetchVerifiedRelease();
    expect(next.manifest.version).toBe('0.14.0');
    expect(next.manifest.sourceCommit).toBe('8'.repeat(40));
    expect((await client.fetchVerifiedRelease('0.13.0')).registrationDigest).toBe(first.registrationDigest);
    expect(await readFile(value.filename)).toEqual(rootBytes);
    expect(await readFile(path.join(value.directory, 'package.json'))).toEqual(packageBytes);
    expect(await readdir(value.directory, { recursive: true })).toEqual(filesBefore);
    expect(value.requests.every((request) => request.options?.redirect === 'manual' && request.options.credentials === 'omit')).toBe(true);
  });

  it('does not accept local approval fields as a default publication authority', async () => {
    const value = await fixture();
    const client = new NativeReleaseClient({ now: value.now });
    await expect(client.verifySignature(Buffer.from('{}'), Buffer.alloc(64), {
      ...value.first.publication, publicationAuthorized: true
    })).rejects.toMatchObject({ kind: 'trust_unregistered' });
    expect(value.requests).toHaveLength(0);
  });

  it('retains signature verification for publications obtained from its verified in-memory snapshot', async () => {
    const value = await fixture();
    const client = new NativeReleaseClient({ now: value.now });
    const trust = await client.trustRegistration();
    const publication = trust.publications[0];
    expect(Object.isFrozen(trust)).toBe(true);
    expect(Object.isFrozen(publication)).toBe(true);
    await client.verifySignature(
      value.responses.get(publication.manifestUrl)!,
      value.responses.get(publication.signatureUrl)!,
      publication
    );
    await expect(client.verifySignature(Buffer.from('{}'), Buffer.alloc(64), { ...publication }))
      .rejects.toMatchObject({ kind: 'trust_unregistered' });
  });

  it('rejects a wrong index key before manifest requests', async () => {
    const value = await fixture();
    value.writeIndex(value.index(), value.otherKeys.privateKey);
    await expect(new NativeReleaseClient({ now: value.now }).fetchVerifiedRelease()).rejects.toMatchObject({ kind: 'signature_invalid' });
    expect(value.requests).toHaveLength(2);
  });

  it.each(['repository', 'product', 'root', 'channel', 'approval', 'signer', 'version', 'source-url'] as const)(
    'rejects a signed index with wrong %s bindings', async (failure) => {
      const value = await fixture();
      const index = value.index();
      if (failure === 'repository') value.writeIndex({ ...index, repository: 'another/repository' });
      else if (failure === 'product') value.writeIndex({ ...index, product: 'other' });
      else if (failure === 'root') value.writeIndex({ ...index, rootDigest: 'f'.repeat(64) });
      else if (failure === 'channel') value.writeIndex({ ...index, channels: value.root.channels });
      else if (failure === 'approval') value.writeIndex({ ...index, publications: index.publications.map((entry) => ({ ...entry, publicationAuthorized: true })) });
      else if (failure === 'signer') value.writeIndex({ ...index, publications: index.publications.map((entry) => ({ ...entry, signerId: 'not-registered' })) });
      else if (failure === 'version') value.writeIndex({ ...index, stableVersion: '0.14.0-beta.1' });
      else value.writeIndex({ ...index, publications: index.publications.map((entry) => ({ ...entry, manifestUrl: 'https://github.com/another/repository/releases/download/v0.13.0/manifest.json' })) });
      await expect(new NativeReleaseClient({ now: value.now }).fetchVerifiedRelease()).rejects.toMatchObject({ kind: 'index_invalid' });
      expect(value.requests).toHaveLength(2);
    }
  );

  it.each(['version', 'sourceCommit', 'digest', 'key'] as const)('rejects signed manifest %s disagreement', async (failure) => {
    const value = await fixture();
    if (failure === 'version') value.rewriteManifest({ ...value.first.manifest, version: '0.14.0' });
    else if (failure === 'sourceCommit') value.rewriteManifest({ ...value.first.manifest, sourceCommit: '9'.repeat(40) });
    else if (failure === 'key') value.rewriteManifest(value.first.manifest, value.first.publication, value.otherKeys.privateKey);
    else value.responses.set(value.first.publication.manifestUrl, Buffer.from('{"changed":"after index signing"}'));
    await expect(new NativeReleaseClient({ now: value.now }).fetchVerifiedRelease())
      .rejects.toMatchObject({ kind: failure === 'key' ? 'signature_invalid' : 'invalid_manifest' });
  });

  it('binds exact owner-channel policy through the public-root digest', async () => {
    const value = await fixture();
    await value.writeRoot({
      ...value.root, channels: [{ ...value.root.channels[0], sourceId: 'different-reviewed-channel' }]
    });
    await expect(new NativeReleaseClient({ now: value.now }).fetchVerifiedRelease()).rejects.toMatchObject({ kind: 'index_invalid' });
    expect(value.requests).toHaveLength(2);
  });

  it('rechecks root bytes, modes and directories instead of using an unbound cache', async () => {
    const value = await fixture();
    const client = new NativeReleaseClient({ now: value.now });
    const release = await client.fetchVerifiedRelease();
    await chmod(value.filename, 0o400);
    await expect(client.assertCurrent(release)).rejects.toMatchObject({ kind: 'trust_invalid' });
    await chmod(value.filename, 0o644);
    const selected = await client.fetchVerifiedRelease();
    const parent = path.dirname(value.filename);
    const retained = path.join(value.directory, 'retained-distribution');
    await rename(parent, retained);
    await mkdir(parent);
    await copyFile(path.join(retained, 'native-trust.json'), value.filename);
    await expect(client.assertCurrent(selected)).rejects.toMatchObject({ kind: 'trust_invalid' });
  });

  it('rejects a root change during index transport before requesting a manifest', async () => {
    const value = await fixture();
    value.beforeFetch(async (url) => { if (url === value.root.publicationIndex.url) await value.writeRoot(unconfigured); });
    await expect(new NativeReleaseClient({ now: value.now }).fetchVerifiedRelease()).rejects.toMatchObject({ kind: 'trust_unconfigured' });
    expect(value.requests).toHaveLength(2);
  });

  it.each(['expired', 'future', 'lifetime', 'floor'] as const)('rejects the %s publication-index boundary', async (failure) => {
    const value = await fixture();
    const index = value.index();
    if (failure === 'expired') value.setNow(Date.parse(index.expiresAt));
    else if (failure === 'future') value.setNow(Date.parse(index.issuedAt) - 1);
    else if (failure === 'lifetime') value.writeIndex({ ...index, expiresAt: new Date(Date.parse(index.issuedAt) + 24 * 60 * 60_000 + 1).toISOString() });
    else {
      const rawRoot = { ...value.root, publicationIndex: { ...value.root.publicationIndex, minimumSequence: 2 } };
      await value.writeRoot(rawRoot);
      const parsed = parseNativeTrustRoot(rawRoot);
      if (parsed.state !== 'configured') throw new Error('Fixture root must be configured.');
      value.writeIndex({ ...index, rootDigest: nativeTrustRootDigest(parsed) });
    }
    await expect(new NativeReleaseClient({ now: value.now }).fetchVerifiedRelease())
      .rejects.toMatchObject({ kind: failure === 'lifetime' ? 'index_invalid' : failure === 'floor' ? 'index_replay' : 'index_stale' });
  });

  it('rejects sequence rollback, same-sequence equivocation, stable rollback and clock rollback', async () => {
    const value = await fixture();
    const client = new NativeReleaseClient({ now: value.now });
    const first = value.index();
    await client.fetchVerifiedRelease();
    value.publish('0.14.0');
    const current = value.index();
    await client.fetchVerifiedRelease();
    value.writeIndex(first);
    await expect(client.fetchVerifiedRelease()).rejects.toMatchObject({ kind: 'index_replay' });
    value.writeIndex({ ...current, expiresAt: new Date(Date.parse(current.expiresAt) + 1).toISOString() });
    await expect(client.fetchVerifiedRelease()).rejects.toMatchObject({ kind: 'index_replay' });
    value.writeIndex({ ...current, sequence: current.sequence + 1, stableVersion: '0.13.0' });
    await expect(client.fetchVerifiedRelease()).rejects.toMatchObject({ kind: 'index_replay' });
    value.writeIndex(current);
    value.setNow(value.now().getTime() - 1);
    await expect(client.fetchVerifiedRelease()).rejects.toMatchObject({ kind: 'index_replay' });
  });

  it('rejects immutable-publication substitution even under a higher signed sequence', async () => {
    const value = await fixture();
    const client = new NativeReleaseClient({ now: value.now });
    await client.fetchVerifiedRelease();
    const index = value.index();
    value.writeIndex({
      ...index, sequence: index.sequence + 1,
      publications: index.publications.map((entry) => ({ ...entry, manifestSha256: 'f'.repeat(64) }))
    });
    await expect(client.fetchVerifiedRelease()).rejects.toMatchObject({ kind: 'index_replay' });
  });

  it('refuses expired admitted authority and publication revocation without caller booleans', async () => {
    const value = await fixture();
    const client = new NativeReleaseClient({ now: value.now });
    const release = await client.fetchVerifiedRelease();
    value.setNow(Date.parse(value.index().expiresAt));
    expect(() => client.assertAdmitted(release)).toThrow(expect.objectContaining({ kind: 'index_stale' }));
    value.setNow(Date.parse(value.index().issuedAt) + 1000);
    value.publish('0.14.0');
    value.writeIndex({ ...value.index(), publications: value.index().publications.filter((entry) => entry.version === '0.14.0') });
    await expect(client.verifySignature(
      value.responses.get(value.first.publication.manifestUrl)!,
      value.responses.get(value.first.publication.signatureUrl)!,
      release.publication
    )).rejects.toMatchObject({ kind: 'trust_unregistered' });
  });

  it('enforces index and signature body bounds through the actual default HTTP reader', async () => {
    const value = await fixture();
    value.responses.set(value.root.publicationIndex.url, Buffer.alloc(1024 * 1024 + 1));
    await expect(new NativeReleaseClient({ now: value.now }).fetchVerifiedRelease()).rejects.toMatchObject({ kind: 'invalid_manifest' });
    value.writeIndex(value.index());
    value.responses.set(value.root.publicationIndex.signatureUrl, Buffer.alloc(1025));
    await expect(new NativeReleaseClient({ now: value.now }).fetchVerifiedRelease()).rejects.toMatchObject({ kind: 'invalid_manifest' });
  });
});
