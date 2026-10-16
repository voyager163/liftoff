import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import {
  assertNativeReleaseCatalog, nativeEvidenceKinds, nativeReleaseAssetStem, nativeReleaseCatalogFilename,
  nativeReleaseTargets, type NativeReleaseCatalog
} from '../../distribution/native/native-release-catalog.mjs';
import { signedMaterial } from './native-stable-material.js';

export const nativeFixtureApi = 'https://api.github.com/repos/voyager163/liftoff';
export const nativeFixtureRelease = 'https://github.com/voyager163/liftoff/releases/download/v0.13.0/';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const jsonResponse = (value: unknown) => new Response(JSON.stringify(value));

export function nativeTransportFixture() {
  const signed = signedMaterial();
  const bodies = new Map<string, Buffer>();
  const subject = (filename: string, bytes: Buffer = Buffer.from('Unselected locator fixture; no qualification claim.')) => {
    bodies.set(filename, bytes);
    return { filename, bytes: bytes.length, sha256: hash(bytes) };
  };
  const catalog = {
    schemaVersion: 1, kind: 'liftoff-native-release-catalog', repository: signed.policy.repository,
    name: '@msn-control/liftoff', version: '0.13.0', commit: signed.record.commit, runId: signed.record.runId,
    tag: 'v0.13.0', distTag: 'latest',
    npm: subject('msn-control-liftoff-0.13.0.tgz'),
    npmRecord: subject('msn-control-liftoff-0.13.0.release.json'),
    targets: nativeReleaseTargets.map(target => {
      const stem = nativeReleaseAssetStem('0.13.0', target);
      return {
        target,
        manifest: subject(`${stem}.native-release.json`),
        qualification: subject(`${stem}.qualification.json`),
        signature: subject(`${stem}.qualification.sig`),
        publicKey: subject(`${stem}.qualification.pub`),
        files: [`${stem}.tar.gz`, 'sbom.cdx.json', 'provenance.json', 'NOTICE'].map((sourceFilename, index) =>
          ({ sourceFilename, ...subject(index === 0 ? sourceFilename : `${stem}.${sourceFilename}`) })),
        evidence: [...nativeEvidenceKinds, ...(target === 'darwin-arm64' ? ['notarization' as const] : [])]
          .map(kind => ({ kind, ...subject(`${stem}.evidence-${kind}.json`) })),
        archiveSignature: target.startsWith('linux-') ? subject(`${stem}.tar.gz.sig`) : null,
        archivePublicKey: target.startsWith('linux-') ? subject(`${stem}.tar.gz.pub`) : null,
        installer: target === 'win32-x64' ? subject(`${stem}-setup.exe`) : null,
        definitions: (target === 'darwin-arm64' ? ['fixture-liftoff.rb'] : target === 'win32-x64'
          ? ['Fixture.Liftoff.yaml', 'Fixture.Liftoff.locale.en-US.yaml', 'Fixture.Liftoff.installer.yaml'] : [])
          .map(sourceFilename => ({ sourceFilename, ...subject(`${stem}.${sourceFilename}`) }))
      };
    })
  } satisfies NativeReleaseCatalog;
  const selected = catalog.targets.find(item => item.target === 'linux-x64')!;
  const release = {
    id: 101, draft: false, prerelease: false, tag_name: catalog.tag, published_at: '2026-10-01T00:00:00Z',
    assets: [...bodies].map(([name, bytes], index) => ({
      id: index + 1, name, size: bytes.length, state: 'uploaded', digest: `sha256:${hash(bytes)}`,
      browser_download_url: `${nativeFixtureRelease}${name}`
    }))
  };
  const tag = { ref: 'refs/tags/v0.13.0', object: { type: 'commit', sha: signed.record.commit } };
  const main = { ref: 'refs/heads/main', object: { type: 'commit', sha: 'e'.repeat(40) } };
  const comparison = { status: 'ahead', behind_by: 0,
    base_commit: { sha: signed.record.commit }, merge_base_commit: { sha: signed.record.commit } };
  const run = { id: Number(signed.record.runId), head_sha: signed.record.commit, head_branch: catalog.tag,
    event: 'push', status: 'completed', conclusion: 'success',
    repository: { full_name: signed.policy.repository }, head_repository: { full_name: signed.policy.repository } };
  const refreshCatalog = () => {
    bodies.set(nativeReleaseCatalogFilename, Buffer.from(JSON.stringify(catalog)));
    release.assets = [...bodies].map(([name, bytes], index) => ({
      id: index + 1, name, size: bytes.length, state: 'uploaded', digest: `sha256:${hash(bytes)}`,
      browser_download_url: `${nativeFixtureRelease}${name}`
    }));
  };
  const refresh = () => {
    for (const [item, bytes] of [
      [selected.manifest, signed.material.record], [selected.qualification, signed.material.qualification],
      [selected.signature, signed.material.signature], [selected.publicKey, signed.material.publicKey]
    ] as const) Object.assign(item, subject(item.filename, bytes));
    for (const item of selected.files) Object.assign(item, subject(item.filename, signed.assets.get(item.sourceFilename)!));
    for (const item of selected.evidence) Object.assign(item, subject(item.filename, signed.platformEvidence.get(item.kind)!));
    Object.assign(selected.archiveSignature!, subject(selected.archiveSignature!.filename, signed.material.archiveSignature));
    Object.assign(selected.archivePublicKey!, subject(selected.archivePublicKey!.filename, signed.material.archivePublicKey));
    refreshCatalog();
  };
  refresh();
  assertNativeReleaseCatalog(catalog);
  const responses = new Map<string, () => Response | Promise<Response>>();
  const fetch = vi.fn<typeof globalThis.fetch>(async input => {
    const url = String(input);
    const override = responses.get(url);
    if (override) return override();
    if (url === `${nativeFixtureApi}/releases/latest`) return jsonResponse(release);
    if (url === `${nativeFixtureApi}/git/ref/tags/${catalog.tag}`) return jsonResponse(tag);
    if (url === `${nativeFixtureApi}/git/ref/heads/main`) return jsonResponse(main);
    if (url === `${nativeFixtureApi}/compare/${catalog.commit}...${main.object.sha}?per_page=1`) return jsonResponse(comparison);
    if (url === `${nativeFixtureApi}/actions/runs/${catalog.runId}`) return jsonResponse(run);
    if (url.startsWith(nativeFixtureRelease)) {
      const bytes = bodies.get(url.slice(nativeFixtureRelease.length));
      if (bytes) return new Response(new Uint8Array(bytes));
    }
    throw new Error(`Unexpected fixture-only GET: ${url}`);
  });
  return { ...signed, bodies, catalog, selected, release, tag, main, comparison, run, responses, fetch, refresh, refreshCatalog };
}
