import { describe, expect, it } from 'vitest';
import {
  createReleaseChecksums, observeGitHubRelease, prepareGitHubAssetRequest, prepareGitHubDraftRequest,
  releaseAssetPageUrl, verifyReleaseChecksums, type GitHubAssetPage
} from '../scripts/repository-security/github-release.ts';
import { artifactHashes, planReleaseRetry, type NpmCandidate } from '../scripts/repository-security/npm-release.ts';

const bytes = Buffer.from('Nonfunctional transport fixture, not a real package.');
const candidate: NpmCandidate = {
  schemaVersion: 1, kind: 'npm-release-candidate',
  source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), inputsDigest: `sha256:${'a'.repeat(64)}`, dirty: false },
  artifact: { name: '@msn-control/liftoff', version: '0.12.3', filename: 'msn-control-liftoff-0.12.3.tgz',
    size: bytes.length, ...artifactHashes(bytes) },
  releaseTag: 'v0.12.3', distTag: 'latest', createdAt: '2026-09-20T11:00:00.000Z'
};
const tag = { name: candidate.releaseTag, commit: candidate.source.commit };
const api = 'https://api.github.com/repos/voyager163/liftoff';
const upload = 'https://uploads.github.com/repos/voyager163/liftoff';
const asset = { name: candidate.artifact.filename, digest: candidate.artifact.sha256 };

function fixture(draft = true) {
  const release = {
    id: 123, tag_name: candidate.releaseTag, target_commitish: 'develop',
    url: `${api}/releases/123`, assets_url: `${api}/releases/123/assets`,
    upload_url: `${upload}/releases/123/assets{?name,label}`,
    draft, immutable: false, prerelease: false,
    body: 'NONFUNCTIONAL_DO_NOT_ECHO_RELEASE_BODY', name: 'Editable release title', assets: []
  };
  const nativeAsset = {
    id: 456, name: asset.name, url: `${api}/releases/assets/456`, digest: asset.digest,
    size: bytes.length, state: 'uploaded',
    uploader: { login: 'NONFUNCTIONAL_DO_NOT_ECHO_UPLOADER' }
  };
  const pages: GitHubAssetPage[] = [{ url: releaseAssetPageUrl(123), status: 200, next: null, body: [nativeAsset] }];
  return { release, nativeAsset, pages };
}

describe('draft-first native REST preparation, never a live transport', () => {
  it('requires a pre-existing exact tag and explicit draft creation without relying on target_commitish', () => {
    const request = prepareGitHubDraftRequest(candidate, tag, 'Reviewed fixture release notes.');
    expect(request).toMatchObject({
      method: 'POST', url: `${api}/releases`, enabled: false, networkPerformed: false,
      body: { target_commitish: tag.commit, tag_name: tag.name, draft: true, generate_release_notes: false, make_latest: 'false' }
    });
    expect(() => prepareGitHubDraftRequest(candidate, { ...tag, commit: 'c'.repeat(40) }, '')).toThrow();
    expect(() => prepareGitHubDraftRequest({ ...candidate, source: { ...candidate.source, dirty: true } }, tag, '')).toThrow();
    expect(request.body).not.toHaveProperty('discussion_category_name');
  });

  it('derives source from the resolved tag and lists assets separately from inline metadata', () => {
    const { release, pages } = fixture();
    const result = observeGitHubRelease(candidate, release, tag, pages);
    expect(result.github).toEqual({ tag: tag.name, commit: tag.commit, state: 'draft', immutable: false, assets: [asset] });
    expect(result.targetCommitishIsCommitProof).toBe(false);
    expect(result.notesAndTitleImmutable).toBe(false);
    expect(result.qualificationEstablished).toBe(false);
    expect(JSON.stringify(result)).not.toContain('NONFUNCTIONAL_DO_NOT_ECHO');
    release.body = 'Changed notes are not an asset substitution.';
    release.name = 'Changed editable title.';
    expect(observeGitHubRelease(candidate, release, tag, pages)).toEqual(result);
  });

  it.each([
    { immutable: undefined }, { immutable: true }, { tag_name: 'v0.12.4' }, { prerelease: true },
    { url: 'https://invalid.example/releases/123' }, { upload_url: `${upload}/releases/other/assets{?name,label}` }
  ])('rejects incomplete or mismatched release identity %#', change => {
    const { release, pages } = fixture();
    expect(() => observeGitHubRelease(candidate, { ...release, ...change }, tag, pages)).toThrow();
  });

  it('does not reinterpret a historic mutable published release as immutable', () => {
    const { release, pages } = fixture(false);
    const result = observeGitHubRelease(candidate, release, tag, pages);
    expect(result.github.immutable).toBe(false);
    expect(planReleaseRetry(candidate, [asset], { tag, npm: null, github: result.github })).toMatchObject({
      state: 'blocked', reason: 'published-github-incomplete-or-mutable-forward-correction-required'
    });
    release.immutable = true;
    expect(observeGitHubRelease(candidate, release, tag, pages).github.immutable).toBe(true);
  });

  it.each([
    { digest: null }, { digest: `sha256:${'b'.repeat(64)}` }, { state: 'starter' }, { state: 'open' },
    { size: 0 }, { name: '../escape' }, { name: 'rewritten name.tgz' },
    { url: `${api}/releases/assets/789` }
  ])('rejects absent, unsafe, incomplete or substituted asset identities %#', change => {
    const { release, nativeAsset, pages } = fixture();
    pages[0]!.body = [{ ...nativeAsset, ...change }];
    if (change.digest === `sha256:${'b'.repeat(64)}`) {
      const actual = observeGitHubRelease(candidate, release, tag, pages);
      expect(planReleaseRetry(candidate, [asset], { tag, npm: null, github: actual.github }).state).toBe('blocked');
    } else expect(() => observeGitHubRelease(candidate, release, tag, pages)).toThrow();
  });

  it('fails unavailable/truncated/duplicate asset listings without reading inline fallback assets', () => {
    const { release, pages, nativeAsset } = fixture();
    for (const altered of [
      [], [{ ...pages[0]!, status: 403 }], [{ ...pages[0]!, status: 404 }],
      [{ ...pages[0]!, next: releaseAssetPageUrl(123, 2) }],
      [{ ...pages[0]!, url: releaseAssetPageUrl(789) }],
      [{ ...pages[0]!, body: [nativeAsset, nativeAsset] }]
    ]) expect(() => observeGitHubRelease(candidate, release, tag, altered)).toThrow();
  });

  it('prepares only missing draft assets with exact binary bytes and no overwrite/delete fallback', () => {
    const { release, pages } = fixture();
    const readback = observeGitHubRelease(candidate, release, tag, [{ ...pages[0]!, body: [] }]);
    const request = prepareGitHubAssetRequest(readback, asset, bytes);
    expect(request).toMatchObject({
      method: 'POST', url: `${upload}/releases/123/assets?name=${asset.name}`,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) },
      body: Uint8Array.from(bytes), enabled: false, networkPerformed: false
    });
    expect(() => prepareGitHubAssetRequest(readback, asset, Buffer.from('Substitution'))).toThrow();
    expect(() => prepareGitHubAssetRequest(observeGitHubRelease(candidate, release, tag, pages), asset, bytes)).toThrow();
    readback.github.state = 'published';
    expect(() => prepareGitHubAssetRequest(readback, asset, bytes)).toThrow();
  });
});

describe('explicit exact release checksum inventory', () => {
  it('hashes every registered asset once, without recursive self-hashing or path discovery', () => {
    const assets = new Map<string, Uint8Array>([[asset.name, bytes], ['security.json', Buffer.from('{"fixture":true}')]]);
    const checksum = createReleaseChecksums(assets);
    expect(Buffer.from(checksum).toString('utf8')).toContain(`${candidate.artifact.sha256.slice(7)}  ${asset.name}\n`);
    expect(Buffer.from(checksum).toString('utf8')).not.toContain('SHA256SUMS');
    assets.set('SHA256SUMS', Buffer.from(checksum));
    expect(() => verifyReleaseChecksums(assets)).not.toThrow();
    assets.set('security.json', Buffer.from('{"fixture":false}'));
    expect(() => verifyReleaseChecksums(assets)).toThrow('checksum-inventory-mismatch');
  });

  it('rejects omitted/extra/aliased or unsafe assets rather than matching patterns', () => {
    expect(() => createReleaseChecksums(new Map())).toThrow();
    expect(() => createReleaseChecksums(new Map([['../escape', bytes]]))).toThrow();
    expect(() => createReleaseChecksums(new Map([['asset', bytes], ['ASSET', bytes]]))).toThrow();
    expect(() => verifyReleaseChecksums(new Map([[asset.name, bytes]]))).toThrow('missing-checksum-asset');
    const assets = new Map([[asset.name, bytes]]);
    const checksum = createReleaseChecksums(assets);
    assets.set('SHA256SUMS', Buffer.from(checksum));
    assets.set('extra.json', Buffer.from('{}'));
    expect(() => verifyReleaseChecksums(assets)).toThrow('checksum-inventory-mismatch');
  });
});
