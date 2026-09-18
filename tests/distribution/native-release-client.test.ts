import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpNativeArtifactSource, NativeReleaseClient } from '../../src/adapters/distribution/native-release-client.js';
import { signedManifestTransport } from './manifest-fixture.js';
import { setPackageRootOverride } from '../../src/adapters/packaged-assets/package-root.js';
import { publicTrustFixture, type PublicTrustFixture } from './public-trust-fixture.js';

const publicFixtures: PublicTrustFixture[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllEnvs(); setPackageRootOverride(undefined);
  for (const fixture of publicFixtures.splice(0)) await fixture.cleanup();
});

describe('registered signed native source', () => {
  it('verifies actual detached cryptography and immutable source registration', async () => {
    const fixture = signedManifestTransport();
    const client = new NativeReleaseClient(fixture);
    const release = await client.fetchVerifiedRelease();
    expect(release.manifest.version).toBe('0.13.0');
    client.assertAdmitted(release);
    expect(() => client.assertAdmitted({ ...release })).toThrow(/not admitted/);
    expect(fixture.requests).toHaveLength(2);
  });

  it('blocks the unpublished production candidate without reading an environment-selected URL', async () => {
    const fixture = await publicTrustFixture();
    publicFixtures.push(fixture);
    await fixture.writeRoot({ schemaVersion: 1, product: 'liftoff', repository: 'voyager163/liftoff', state: 'unconfigured' });
    setPackageRootOverride(fixture.directory);
    vi.stubEnv('LIFTOFF_NATIVE_MANIFEST_URL', 'https://untrusted.invalid/manifest.json');
    const fetchFn = vi.fn();
    await expect(new NativeReleaseClient({ fetchFn }).fetchReleaseManifest()).rejects.toMatchObject({ reasonCode: 'trust_unconfigured' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects altered final manifest bytes before JSON can authorize a target', async () => {
    const fixture = signedManifestTransport();
    fixture.responses.set(fixture.manifestUrl, Buffer.from('{"version":"99.0.0"}'));
    await expect(new NativeReleaseClient(fixture).fetchReleaseManifest()).rejects.toMatchObject({ kind: 'signature_invalid' });
  });

  it('does not treat valid signatures for a different source as publication authorization', async () => {
    const fixture = signedManifestTransport();
    const bytes = Buffer.from(JSON.stringify({ ...JSON.parse(fixture.responses.get(fixture.manifestUrl)!.toString()), sourceCommit: '8'.repeat(40) }));
    fixture.responses.set(fixture.manifestUrl, bytes);
    fixture.responses.set(fixture.signatureUrl, fixture.sign(bytes));
    await expect(new NativeReleaseClient(fixture).fetchReleaseManifest()).rejects.toThrow(/source or version/);
  });

  it('rejects malformed signed JSON and missing publication permission', async () => {
    const fixture = signedManifestTransport();
    const bytes = Buffer.from('{');
    fixture.responses.set(fixture.manifestUrl, bytes);
    fixture.responses.set(fixture.signatureUrl, fixture.sign(bytes));
    await expect(new NativeReleaseClient(fixture).fetchReleaseManifest()).rejects.toMatchObject({ kind: 'invalid_manifest' });
    expect(() => new NativeReleaseClient({
      ...fixture, trust: { ...fixture.trust, publications: fixture.trust.publications.map((entry) => ({ ...entry, publicationAuthorized: false })) }
    })).toThrow(/not been authorized/);
  });

  it('accepts canonical base64 signatures but rejects short or foreign signatures', async () => {
    const fixture = signedManifestTransport();
    fixture.responses.set(fixture.signatureUrl, Buffer.from(fixture.responses.get(fixture.signatureUrl)!.toString('base64')));
    expect((await new NativeReleaseClient(fixture).fetchReleaseManifest()).version).toBe('0.13.0');
    fixture.responses.set(fixture.signatureUrl, Buffer.alloc(63));
    await expect(new NativeReleaseClient(fixture).fetchReleaseManifest()).rejects.toMatchObject({ kind: 'signature_invalid' });
  });
});

describe('bounded read-only native transport', () => {
  const url = 'https://github.com/voyager163/liftoff/releases/download/v0.13.0/manifest.json';

  it('enforces body limits and never follows an unregistered redirect', async () => {
    const fetchFn = vi.fn(async () => new Response('12345'));
    await expect(new HttpNativeArtifactSource(fetchFn).readBytes(url, 4)).rejects.toMatchObject({ kind: 'invalid_manifest' });
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ redirect: 'manual', credentials: 'omit' });
  });

  it('retains the deadline while reading a stalled body', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull() {} })));
    const result = new HttpNativeArtifactSource(fetchFn, 20).readBytes(url, 100);
    const assertion = expect(result).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
  });

  it('distinguishes HTTP and transport failure without exposing private source details', async () => {
    await expect(new HttpNativeArtifactSource(async () => new Response('', { status: 503 })).readBytes(url, 10))
      .rejects.toThrow('HTTP 503');
    await expect(new HttpNativeArtifactSource(async () => { throw new Error('secret-token=hidden'); }).readBytes(url, 10))
      .rejects.toThrow('Native source transport failed.');
    expect(() => new HttpNativeArtifactSource(undefined, 0)).toThrow();
  });
});
