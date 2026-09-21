import { createHash } from 'node:crypto';
import { digest, SecurityEvidenceError, sha } from './evidence.ts';
import { parseNpmCandidate, type ReleaseAsset, type ReleaseObservation } from './npm-release.ts';

const repository = 'voyager163/liftoff';
const api = `https://api.github.com/repos/${repository}`;
const uploads = `https://uploads.github.com/repos/${repository}`;
const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const checksumName = 'SHA256SUMS';
function fail(code: string): never { throw new SecurityEvidenceError(`github-release-${code}`); }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('invalid-response');
  return value as Record<string, unknown>;
}
function positive(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 1 || value > maximum) return fail('invalid-number');
  return value;
}
function name(value: unknown): string {
  // GitHub rewrites some filenames; only exact stable release-asset names are accepted.
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/.test(value) || value.endsWith('.')) {
    return fail('unsafe-asset-name');
  }
  return value;
}

export function createReleaseChecksums(assets: ReadonlyMap<string, Uint8Array>): Uint8Array {
  if (assets.size < 1 || assets.size > 99 || assets.has(checksumName)) fail('invalid-checksum-inventory');
  const names = [...assets.keys()].map(name).sort();
  if (new Set(names.map(value => value.toLowerCase())).size !== names.length) fail('duplicate-asset');
  let total = 0;
  for (const value of assets.values()) {
    if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > 32 * 1024 * 1024) fail('asset-size');
    total += value.byteLength;
  }
  if (total > 64 * 1024 * 1024) fail('asset-size');
  return Buffer.from(names.map(name => `${hash(assets.get(name)!).slice(7)}  ${name}\n`).join(''));
}

export function verifyReleaseChecksums(assets: ReadonlyMap<string, Uint8Array>): void {
  const supplied = assets.get(checksumName);
  if (!supplied) fail('missing-checksum-asset');
  const expected = createReleaseChecksums(new Map([...assets].filter(([name]) => name !== checksumName)));
  if (hash(supplied) !== hash(expected)) fail('checksum-inventory-mismatch');
}

export interface GitHubAssetPage {
  url: string;
  status: number;
  next: string | null;
  body: unknown;
}

export function releaseAssetPageUrl(releaseId: number, page = 1): string {
  return `${api}/releases/${positive(releaseId)}/assets?per_page=100&page=${positive(page, 2)}`;
}

/**
 * Parse supplied native metadata only. Transport authentication, response
 * freshness and protected-source qualification remain separate obligations.
 * Inline release.assets can be truncated, so a complete paginated list is required.
 */
export function observeGitHubRelease(
  candidateValue: unknown, releaseResponse: unknown, resolvedTag: { name: string; commit: string },
  pages: readonly GitHubAssetPage[]
) {
  const candidate = parseNpmCandidate(candidateValue), release = object(releaseResponse);
  const releaseId = positive(release.id);
  if (resolvedTag.name !== candidate.releaseTag || sha(resolvedTag.commit) !== candidate.source.commit ||
      release.tag_name !== resolvedTag.name || release.url !== `${api}/releases/${releaseId}` ||
      release.assets_url !== `${api}/releases/${releaseId}/assets` ||
      release.upload_url !== `${uploads}/releases/${releaseId}/assets{?name,label}` ||
      typeof release.draft !== 'boolean' || typeof release.immutable !== 'boolean' ||
      release.prerelease !== (candidate.distTag === 'next') || release.draft && release.immutable) fail('readback-identity');
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 2) fail('incomplete-assets');
  const assets: ReleaseAsset[] = [], ids = new Set<number>();
  for (const [index, page] of pages.entries()) {
    if (page.url !== releaseAssetPageUrl(releaseId, index + 1) || page.status !== 200 ||
        page.next !== (index + 1 < pages.length ? releaseAssetPageUrl(releaseId, index + 2) : null) ||
        !Array.isArray(page.body) || page.body.length > 100) fail('incomplete-assets');
    for (const value of page.body) {
      const item = object(value), id = positive(item.id);
      if (ids.has(id)) fail('duplicate-asset');
      ids.add(id);
      if (item.state !== 'uploaded' || item.url !== `${api}/releases/assets/${id}`) fail('incomplete-asset');
      positive(item.size, 32 * 1024 * 1024);
      assets.push({ name: name(item.name), digest: digest(item.digest) });
    }
  }
  if (assets.length > 100 || new Set(assets.map(item => item.name.toLowerCase())).size !== assets.length) fail('duplicate-asset');
  const github: NonNullable<ReleaseObservation['github']> = {
    tag: resolvedTag.name, commit: resolvedTag.commit, state: release.draft ? 'draft' : 'published',
    immutable: release.immutable, assets
  };
  return {
    kind: 'supplied-native-release-readback' as const, releaseId, github,
    uploadUrl: `${uploads}/releases/${releaseId}/assets`,
    targetCommitishIsCommitProof: false, notesAndTitleImmutable: false,
    publisherAuthorityEstablished: false, qualificationEstablished: false
  };
}

/** REST request preparation only: no credentials, network client or activation path. */
export function prepareGitHubDraftRequest(
  candidateValue: unknown, resolvedTag: { name: string; commit: string }, notes: string
) {
  const candidate = parseNpmCandidate(candidateValue);
  if (candidate.source.dirty || resolvedTag.name !== candidate.releaseTag ||
      sha(resolvedTag.commit) !== candidate.source.commit) fail('qualified-existing-tag-required');
  if (typeof notes !== 'string' || Buffer.byteLength(notes) > 100_000 || notes.includes('\0')) fail('invalid-release-notes');
  return {
    kind: 'prepared-request-not-publication-authority' as const, method: 'POST' as const, url: `${api}/releases`,
    body: {
      tag_name: candidate.releaseTag, target_commitish: candidate.source.commit, name: candidate.releaseTag,
      body: notes, draft: true, prerelease: candidate.distTag === 'next', generate_release_notes: false, make_latest: 'false'
    },
    enabled: false, networkPerformed: false
  };
}

export function prepareGitHubAssetRequest(
  readback: ReturnType<typeof observeGitHubRelease>, asset: ReleaseAsset, bytes: Uint8Array
) {
  const releaseId = positive(readback.releaseId);
  if (readback.github.state !== 'draft' || readback.github.immutable ||
      readback.uploadUrl !== `${uploads}/releases/${releaseId}/assets` ||
      readback.github.assets.some(value => value.name.toLowerCase() === name(asset.name).toLowerCase()) ||
      !(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 32 * 1024 * 1024 ||
      hash(bytes) !== digest(asset.digest)) fail('asset-upload-precondition');
  return {
    kind: 'prepared-request-not-publication-authority' as const, method: 'POST' as const,
    url: `${readback.uploadUrl}?name=${encodeURIComponent(name(asset.name))}`,
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength) },
    body: Uint8Array.from(bytes), enabled: false, networkPerformed: false
  };
}
