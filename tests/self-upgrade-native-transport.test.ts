import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeStableSource } from '../src/adapters/distribution/native-transport.js';
import { createNativeUpgradePort } from '../src/adapters/distribution/native.js';
import { authenticateNativeStableMetadata } from '../src/adapters/distribution/native-metadata.js';
import { nativeCatalogSubjects, nativeReleaseCatalogFilename } from '../distribution/native/native-release-catalog.mjs';
import { nativeInstallation } from './fixtures/native-stable-material.js';
import { jsonResponse, nativeFixtureApi, nativeFixtureRelease, nativeTransportFixture } from './fixtures/native-stable-transport.js';
import { upgradeWorld } from './fixtures/installer-upgrade.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const read = (world: ReturnType<typeof nativeTransportFixture>, signal = new AbortController().signal) =>
  createNativeStableSource(world.policy, { fetch: world.fetch }).readStable(nativeInstallation, signal);
const invalid = { reasonCode: 'native_invalid' };
const latest = `${nativeFixtureApi}/releases/latest`;

describe('bounded read-only native stable transport', () => {
  it('independently reobserves the signed Linux archive channel without creating a staging root or accepting an unverified owner', async () => {
    const world = nativeTransportFixture();
    vi.stubGlobal('fetch', world.fetch);
    const host = upgradeWorld();
    const port = createNativeUpgradePort({ ...host.dependencies, readJson: async () => world.policy }, { cask: undefined });
    const candidate = await port.stable(nativeInstallation, '/virtual/neutral');
    expect(candidate).toMatchObject({ version: '0.13.0', target: 'linux-x64', sourceCommit: world.record.commit });
    expect(candidate).not.toHaveProperty('bundleRoot');
    await expect(port.channel(nativeInstallation, candidate, '/virtual/neutral')).resolves.toMatchObject({
      status: 'available', version: candidate.version, artifactSha256: candidate.archiveSha256, exactApply: true
    });
    expect(world.fetch.mock.calls.filter(([url]) => String(url).endsWith('.tar.gz'))).toHaveLength(2);
    await expect(port.apply(nativeInstallation, candidate, '/virtual/neutral')).rejects.toMatchObject({
      reasonCode: 'native_invalid', effects: 'none'
    });
    expect(host.world.trace.filter(event => 'run' in event || 'installCommand' in event)).toEqual([]);
  });

  it('preserves an explicit Linux channel-reader disable instead of inferring availability', async () => {
    const world = nativeTransportFixture();
    vi.stubGlobal('fetch', world.fetch);
    const host = upgradeWorld();
    const port = createNativeUpgradePort({ ...host.dependencies, readJson: async () => world.policy }, { channel: undefined });
    const candidate = await port.stable(nativeInstallation, '/virtual/neutral');
    world.fetch.mockClear();
    await expect(port.channel(nativeInstallation, candidate, '/virtual/neutral'))
      .rejects.toMatchObject({ reasonCode: 'channel_unavailable' });
    expect(world.fetch).not.toHaveBeenCalled();
  });

  it.each(['offline', 'invalid', 'changed policy'] as const)('keeps a second Linux %s observation distinct from current', async kind => {
    const world = nativeTransportFixture();
    vi.stubGlobal('fetch', world.fetch);
    const host = upgradeWorld();
    const port = createNativeUpgradePort({ ...host.dependencies, readJson: async () => world.policy });
    const candidate = await port.stable(nativeInstallation, '/virtual/neutral');
    if (kind === 'offline') world.responses.set(latest, () => new Response('', { status: 503 }));
    if (kind === 'invalid') world.material.signature[0] ^= 1;
    if (kind === 'changed policy') world.policy.linux.archiveSigningKeySha256 = '0'.repeat(64);
    if (kind === 'invalid') world.refresh();
    await expect(port.channel(nativeInstallation, candidate, '/virtual/neutral')).rejects.toMatchObject({
      reasonCode: kind === 'offline' ? 'channel_unavailable' : kind === 'invalid' ? 'channel_invalid' : 'channel_changed'
    });
  });

  it('preserves an explicit stable-reader disable override', async () => {
    const world = nativeTransportFixture();
    vi.stubGlobal('fetch', world.fetch);
    const host = upgradeWorld();
    const port = createNativeUpgradePort({ ...host.dependencies, readJson: async () => world.policy }, { stable: undefined });
    await expect(port.stable(nativeInstallation, '/virtual/neutral')).rejects.toMatchObject({ reasonCode: 'native_unavailable' });
    expect(world.fetch).not.toHaveBeenCalled();
  });

  it('keeps the production default inert before HTTP while signing policy is null', async () => {
    const world = nativeTransportFixture();
    world.policy.approvedSigningKeySha256 = null;
    vi.stubGlobal('fetch', world.fetch);
    const host = upgradeWorld();
    const port = createNativeUpgradePort({ ...host.dependencies, readJson: async () => world.policy });
    await expect(port.stable(nativeInstallation, '/virtual/neutral')).rejects.toMatchObject({ reasonCode: 'native_unqualified' });
    expect(world.fetch).not.toHaveBeenCalled();
  });

  it('authenticates selected subjects, main ancestry and the successful tag run without supplying an install root or manager state', async () => {
    const world = nativeTransportFixture();
    const material = await read(world);
    expect(material.assets).toEqual(world.assets);
    expect(material.platformEvidence).toEqual(world.platformEvidence);
    expect(material.archiveSignature).toEqual(world.material.archiveSignature);
    expect(material.archivePublicKey).toEqual(world.material.archivePublicKey);
    expect(material).not.toHaveProperty('bundleRoot');
    expect(material).not.toHaveProperty('channel');
    await expect(authenticateNativeStableMetadata(material, nativeInstallation, world.policy)).resolves.toMatchObject({
      record: { commit: world.record.commit, runId: world.record.runId }
    });
    const selected = nativeCatalogSubjects({ ...world.catalog, targets: [world.selected] })
      .filter(item => item !== world.catalog.npm && item !== world.catalog.npmRecord);
    expect(world.fetch.mock.calls.map(([url]) => String(url)).filter(url => url.startsWith(nativeFixtureRelease)).sort())
      .toEqual([nativeReleaseCatalogFilename, ...selected.map(item => item.filename)]
        .map(name => `${nativeFixtureRelease}${name}`).sort());
    for (const [url, options] of world.fetch.mock.calls) {
      expect(options).toMatchObject({ credentials: 'omit', cache: 'no-store',
        redirect: String(url).startsWith(nativeFixtureRelease) ? 'manual' : 'error',
        headers: { 'accept-encoding': 'identity', 'cache-control': 'no-cache' } });
      expect(options?.headers).not.toHaveProperty('authorization');
      expect(options?.headers).not.toHaveProperty('cookie');
      expect(options?.method ?? 'GET').toBe('GET');
      expect(options?.body).toBeUndefined();
      expect(options?.signal?.aborted).toBe(true);
    }
  });

  it.each(['global', 'linux', 'mac', 'windows'] as const)('refuses missing %s authority before any HTTP request', async kind => {
    const world = nativeTransportFixture();
    const installation = { ...nativeInstallation };
    if (kind === 'global') world.policy.approvedSigningKeySha256 = null;
    if (kind === 'linux') world.policy.linux.archiveSigningKeySha256 = null;
    if (kind === 'mac') installation.target = 'darwin-arm64';
    if (kind === 'windows') installation.target = 'win32-x64';
    await expect(createNativeStableSource(world.policy, { fetch: world.fetch })
      .readStable(installation, new AbortController().signal)).rejects.toMatchObject({ reasonCode: 'native_unqualified' });
    expect(world.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'draft', change: { draft: true } },
    { name: 'prerelease', change: { prerelease: true } },
    { name: 'prerelease tag', change: { tag_name: 'v0.13.0-rc.1' } },
    { name: 'unprefixed tag', change: { tag_name: '0.13.0' } },
    { name: 'unknown publication', change: { published_at: '' } },
    { name: 'invalid release id', change: { id: 0 } },
    { name: 'non-object release', change: null },
    { name: 'missing asset array', change: { assets: {} } }
  ])('rejects $name release observations', async ({ change }) => {
    const world = nativeTransportFixture();
    world.responses.set(latest, () => jsonResponse(change === null ? [] : { ...world.release, ...change }));
    await expect(read(world)).rejects.toMatchObject(invalid);
    expect(world.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'duplicate', change: (world: ReturnType<typeof nativeTransportFixture>) =>
      [...world.release.assets, world.release.assets[0]] },
    { name: 'foreign URL', change: (world: ReturnType<typeof nativeTransportFixture>) =>
      world.release.assets.map(item => ({ ...item, browser_download_url: `https://foreign.invalid/${item.name}` })) },
    { name: 'unfinished upload', change: (world: ReturnType<typeof nativeTransportFixture>) =>
      world.release.assets.map(item => ({ ...item, state: 'new' })) },
    { name: 'invalid digest', change: (world: ReturnType<typeof nativeTransportFixture>) =>
      world.release.assets.map(item => ({ ...item, digest: 'sha256:invalid' })) },
    { name: 'unsafe name', change: (world: ReturnType<typeof nativeTransportFixture>) =>
      world.release.assets.map(item => ({ ...item, name: '../escape' })) }
  ])('rejects $name asset metadata', async ({ change }) => {
    const world = nativeTransportFixture();
    world.responses.set(latest, () => jsonResponse({ ...world.release, assets: change(world) }));
    await expect(read(world)).rejects.toMatchObject(invalid);
  });

  it.each([
    { name: 'catalog', filename: nativeReleaseCatalogFilename },
    { name: 'selected qualification', filename: 'liftoff-0.13.0-linux-x64.qualification.json' }
  ])('keeps missing $name distinct from invalid data', async ({ filename }) => {
    const world = nativeTransportFixture();
    world.release.assets = world.release.assets.filter(item => item.name !== filename);
    await expect(read(world)).rejects.toMatchObject({ reasonCode: 'native_unavailable' });
  });

  it.each([
    { name: 'source commit', change: (world: ReturnType<typeof nativeTransportFixture>) => { world.catalog.commit = 'a'.repeat(40); } },
    { name: 'run id', change: (world: ReturnType<typeof nativeTransportFixture>) => { world.catalog.runId = '999'; } },
    { name: 'unbounded run id', change: (world: ReturnType<typeof nativeTransportFixture>) => { world.catalog.runId = '9'.repeat(30); } },
    { name: 'dist tag', change: (world: ReturnType<typeof nativeTransportFixture>) => {
      Object.assign(world.catalog, { distTag: 'next' });
    } },
    { name: 'missing target', change: (world: ReturnType<typeof nativeTransportFixture>) => { world.catalog.targets.pop(); } },
    { name: 'subject escape', change: (world: ReturnType<typeof nativeTransportFixture>) => { world.selected.manifest.filename = '../manifest'; } }
  ])('refuses a catalog with mismatched $name', async ({ change }) => {
    const world = nativeTransportFixture();
    change(world);
    world.refreshCatalog();
    await expect(read(world)).rejects.toMatchObject(invalid);
  });

  it.each(['size', 'digest', 'bytes'] as const)('binds actual subject %s rather than an availability assertion', async kind => {
    const world = nativeTransportFixture();
    const asset = world.release.assets.find(item => item.name === world.selected.manifest.filename)!;
    if (kind === 'size') asset.size++;
    if (kind === 'digest') asset.digest = `sha256:${'0'.repeat(64)}`;
    if (kind === 'bytes') world.bodies.set(asset.name, Buffer.alloc(asset.size));
    await expect(read(world)).rejects.toMatchObject(invalid);
  });

  it('rejects a tampered qualification signature before requesting archives', async () => {
    const world = nativeTransportFixture();
    world.material.signature[0] ^= 1;
    world.refresh();
    await expect(read(world)).rejects.toMatchObject(invalid);
    expect(world.fetch.mock.calls.some(([url]) => String(url).endsWith('.tar.gz'))).toBe(false);
  });

  it('accepts absent optional API digests only after hashing every selected body', async () => {
    const world = nativeTransportFixture();
    world.responses.set(latest, () => jsonResponse({ ...world.release,
      assets: world.release.assets.map(item => ({ ...item, digest: null })) }));
    await expect(read(world)).resolves.toMatchObject({ record: world.material.record });
  });

  it('does not confuse catalog hashes with an independently approved qualification signer', async () => {
    const world = nativeTransportFixture();
    world.policy.approvedSigningKeySha256 = '0'.repeat(64);
    await expect(read(world)).rejects.toMatchObject(invalid);
    expect(world.fetch.mock.calls.some(([url]) => String(url).endsWith('.tar.gz'))).toBe(false);
  });

  it.each([
    { name: 'tag source', change: (world: ReturnType<typeof nativeTransportFixture>) => { world.tag.object.sha = 'a'.repeat(40); } },
    { name: 'main ref type', change: (world: ReturnType<typeof nativeTransportFixture>) => { world.main.object.type = 'tag'; } },
    { name: 'diverged ancestry', change: (world: ReturnType<typeof nativeTransportFixture>) => { world.comparison.status = 'diverged'; } },
    { name: 'behind ancestry', change: (world: ReturnType<typeof nativeTransportFixture>) => { world.comparison.behind_by = 1; } },
    { name: 'wrong comparison base', change: (world: ReturnType<typeof nativeTransportFixture>) => {
      world.comparison.base_commit.sha = 'a'.repeat(40);
    } },
    { name: 'failed run', change: (world: ReturnType<typeof nativeTransportFixture>) => { world.run.conclusion = 'failure'; } },
    { name: 'wrong event', change: (world: ReturnType<typeof nativeTransportFixture>) => { world.run.event = 'workflow_dispatch'; } },
    { name: 'wrong run source', change: (world: ReturnType<typeof nativeTransportFixture>) => { world.run.head_sha = 'a'.repeat(40); } },
    { name: 'wrong tag run', change: (world: ReturnType<typeof nativeTransportFixture>) => { world.run.head_branch = 'main'; } },
    { name: 'foreign head repository', change: (world: ReturnType<typeof nativeTransportFixture>) => {
      world.responses.set(`${nativeFixtureApi}/actions/runs/${world.catalog.runId}`,
        () => jsonResponse({ ...world.run, head_repository: { full_name: 'fixture/foreign' } }));
    } }
  ])('refuses $name without deployed archive reads', async ({ change }) => {
    const world = nativeTransportFixture();
    change(world);
    await expect(read(world)).rejects.toMatchObject(invalid);
    expect(world.fetch.mock.calls.some(([url]) => String(url).endsWith('.tar.gz'))).toBe(false);
  });

  it('peels bounded annotated tags and rechecks their original identity', async () => {
    const world = nativeTransportFixture();
    world.tag.object = { type: 'tag', sha: 'a'.repeat(40) };
    world.responses.set(`${nativeFixtureApi}/git/tags/${world.tag.object.sha}`,
      () => jsonResponse({ sha: world.tag.object.sha, object: { type: 'commit', sha: world.record.commit } }));
    await expect(read(world)).resolves.toMatchObject({ stableTag: 'v0.13.0' });
  });

  it('refuses an annotated tag cycle', async () => {
    const world = nativeTransportFixture();
    world.tag.object = { type: 'tag', sha: 'a'.repeat(40) };
    world.responses.set(`${nativeFixtureApi}/git/tags/${world.tag.object.sha}`,
      () => jsonResponse({ sha: world.tag.object.sha, object: world.tag.object }));
    await expect(read(world)).rejects.toMatchObject(invalid);
  });

  it('bounds distinct annotated tag depth', async () => {
    const world = nativeTransportFixture();
    const shas = ['1', '2', '3', '4', '5'].map(char => char.repeat(40));
    world.tag.object = { type: 'tag', sha: shas[0] };
    for (const [index, sha] of shas.entries()) {
      world.responses.set(`${nativeFixtureApi}/git/tags/${sha}`,
        () => jsonResponse({ sha, object: { type: 'tag', sha: shas[index + 1] ?? world.record.commit } }));
    }
    await expect(read(world)).rejects.toMatchObject(invalid);
    expect(world.fetch.mock.calls.filter(([url]) => String(url).includes('/git/tags/'))).toHaveLength(4);
  });

  it.each([
    { name: 'wrong ref', value: { ref: 'refs/tags/foreign', object: { type: 'commit', sha: 'd'.repeat(40) } } },
    { name: 'invalid commit', value: { ref: 'refs/tags/v0.13.0', object: { type: 'commit', sha: 'invalid' } } },
    { name: 'unsupported ref type', value: { ref: 'refs/tags/v0.13.0', object: { type: 'tree', sha: 'd'.repeat(40) } } }
  ])('rejects a $name source reference', async ({ value }) => {
    const world = nativeTransportFixture();
    world.responses.set(`${nativeFixtureApi}/git/ref/tags/v0.13.0`, () => jsonResponse(value));
    await expect(read(world)).rejects.toMatchObject(invalid);
  });

  it.each(['tag', 'main', 'release'] as const)('refuses changed final %s observations', async kind => {
    const world = nativeTransportFixture();
    let count = 0;
    const url = kind === 'release' ? latest : `${nativeFixtureApi}/git/ref/${kind === 'tag' ? 'tags/v0.13.0' : 'heads/main'}`;
    world.responses.set(url, () => {
      count++;
      if (kind === 'release') return jsonResponse({ ...world.release, id: count === 1 ? world.release.id : 102 });
      const current = kind === 'tag' ? world.tag : world.main;
      return jsonResponse({ ...current, object: { ...current.object, sha: count === 1 ? current.object.sha : 'f'.repeat(40) } });
    });
    await expect(read(world)).rejects.toMatchObject(invalid);
  });

  it('follows only bounded canonical release-asset CDN redirects', async () => {
    const world = nativeTransportFixture();
    const url = `${nativeFixtureRelease}${world.selected.manifest.filename}`;
    const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/fixture/file?token=fixture';
    world.responses.set(url, () => Response.redirect(cdn, 302));
    world.responses.set(cdn, () => new Response(new Uint8Array(world.material.record)));
    await expect(read(world)).resolves.toMatchObject({ record: world.material.record });
  });

  it.each([
    'http://release-assets.githubusercontent.com/github-production-release-asset/fixture/file',
    'https://foreign.invalid/github-production-release-asset/fixture/file',
    'https://user:secret@release-assets.githubusercontent.com/github-production-release-asset/fixture/file',
    'https://release-assets.githubusercontent.com:444/github-production-release-asset/fixture/file',
    'https://release-assets.githubusercontent.com/other/file',
    'https://objects.githubusercontent.com/github-production-release-asset/fixture/file#fragment'
  ])('rejects an unsafe asset redirect to %s', async target => {
    const world = nativeTransportFixture();
    world.responses.set(`${nativeFixtureRelease}${world.selected.manifest.filename}`, () => Response.redirect(target, 302));
    await expect(read(world)).rejects.toMatchObject(invalid);
    expect(world.fetch.mock.calls.some(([url]) => String(url) === target)).toBe(false);
  });

  it('cancels a rejected redirect body and never follows its target', async () => {
    const world = nativeTransportFixture();
    const cancel = vi.fn();
    world.responses.set(`${nativeFixtureRelease}${world.selected.manifest.filename}`, () =>
      new Response(new ReadableStream({ cancel }), { status: 302, headers: { location: 'https://foreign.invalid/asset' } }));
    await expect(read(world)).rejects.toMatchObject(invalid);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds redirect loops', async () => {
    const world = nativeTransportFixture();
    const cdn = 'https://objects.githubusercontent.com/github-production-release-asset/fixture/file';
    world.responses.set(`${nativeFixtureRelease}${world.selected.manifest.filename}`, () => Response.redirect(cdn, 302));
    world.responses.set(cdn, () => Response.redirect(cdn, 302));
    await expect(read(world)).rejects.toMatchObject(invalid);
    expect(world.fetch.mock.calls.filter(([url]) => String(url) === cdn)).toHaveLength(3);
  });

  it.each([
    { name: 'empty', response: () => new Response('') },
    { name: 'malformed JSON', response: () => new Response('{') },
    { name: 'impossible content length', response: () => new Response('{}', { headers: { 'content-length': '9000000' } }) },
    { name: 'nondecimal content length', response: () => new Response('{}', { headers: { 'content-length': '-1' } }) },
    { name: 'shorter than declared', response: () => new Response('{}', { headers: { 'content-length': '3' } }) },
    { name: 'encoded', response: () => new Response('{}', { headers: { 'content-encoding': 'gzip' } }) },
    { name: 'oversized stream', response: () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)) }
  ])('rejects $name metadata bodies', async ({ response }) => {
    const world = nativeTransportFixture();
    world.responses.set(latest, response);
    await expect(read(world)).rejects.toMatchObject(invalid);
  });

  it('keeps network failure indeterminate', async () => {
    const world = nativeTransportFixture();
    world.responses.set(latest, () => new Response('', { status: 503 }));
    await expect(read(world)).rejects.toMatchObject({ reasonCode: 'native_unavailable' });
  });

  it('rejects an oversized signature stream even without a content-length header', async () => {
    const world = nativeTransportFixture();
    world.responses.set(`${nativeFixtureRelease}${world.selected.signature.filename}`, () => new Response(new Uint8Array(65)));
    await expect(read(world)).rejects.toMatchObject(invalid);
  });

  it('releases an interrupted stream lock and reports indeterminate transport', async () => {
    const world = nativeTransportFixture();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error('Fixture-only interrupted response')); }
    });
    world.responses.set(latest, () => new Response(stream));
    await expect(read(world)).rejects.toMatchObject({ reasonCode: 'native_unavailable' });
    expect(stream.locked).toBe(false);
  });

  it('bounds a noncooperative fetch and aborts its signal', async () => {
    vi.useFakeTimers();
    const world = nativeTransportFixture();
    world.responses.set(latest, () => new Promise<Response>(() => {}));
    const result = expect(read(world)).rejects.toMatchObject({ reasonCode: 'native_timeout' });
    await vi.advanceTimersByTimeAsync(2000);
    await result;
    expect(world.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('honors an already aborted external signal without fetching', async () => {
    const world = nativeTransportFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(read(world, controller.signal)).rejects.toMatchObject({ reasonCode: 'native_unavailable' });
    expect(world.fetch).not.toHaveBeenCalled();
  });

  it('honors external cancellation during a noncooperative request', async () => {
    const world = nativeTransportFixture();
    const controller = new AbortController();
    world.responses.set(latest, () => {
      controller.abort();
      return new Promise<Response>(() => {});
    });
    await expect(read(world, controller.signal)).rejects.toMatchObject({ reasonCode: 'native_unavailable' });
  });

  it('refuses unsupported targets before fetching', async () => {
    const world = nativeTransportFixture();
    await expect(createNativeStableSource(world.policy, { fetch: world.fetch })
      .readStable({ ...nativeInstallation, target: 'darwin-x64' }, new AbortController().signal)).rejects.toMatchObject(invalid);
    expect(world.fetch).not.toHaveBeenCalled();
  });

  it('rejects a late result even when synchronous work delays the timeout callback', async () => {
    const world = nativeTransportFixture();
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(2001);
    await expect(read(world)).rejects.toMatchObject({ reasonCode: 'native_timeout' });
    expect(world.fetch.mock.calls.filter(([url]) => String(url) === latest)).toHaveLength(2);
  });
});
