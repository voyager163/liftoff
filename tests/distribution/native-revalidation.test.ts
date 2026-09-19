import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as archives from '../../src/adapters/distribution/native-archive.js';
import { signedFixture, type SignedFixture } from './native-fixture.js';

const fixtures: SignedFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

describe('exact-byte native archive revalidation', () => {
  it('reuses only identical archive/provenance validation while rereading and authenticating the source', async () => {
    const value = await signedFixture('exact-archive-revalidation');
    fixtures.push(value);
    const inspect = vi.spyOn(archives, 'inspectNativeArchive');
    const release = await value.client.fetchVerifiedRelease('0.13.0');
    const payload = release.manifest.targets[value.provenance.target];
    const first = await value.admission.admitReleaseTarget(release);
    const second = await value.admission.admitReleaseTarget(release);
    expect(second).toEqual(first);
    expect(second === first).toBe(false);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(value.source.reads.filter((url) => url === payload.archiveUrl)).toHaveLength(2);
    expect(value.source.reads.filter((url) => url === payload.provenanceUrl)).toHaveLength(2);
    expect(value.source.reads.filter((url) => url === payload.signatureUrl)).toHaveLength(2);
    value.admission.assertArtifact(second);

    const archivePath = value.source.urls.get(payload.archiveUrl)!;
    const original = await readFile(archivePath);
    const changed = Buffer.from(original);
    changed[changed.length - 1] ^= 1;
    await writeFile(archivePath, changed);
    await expect(value.admission.admitReleaseTarget(release)).rejects.toMatchObject({ reasonCode: 'artifact_mismatch' });
    expect(inspect).toHaveBeenCalledTimes(1);
    await writeFile(archivePath, original);

    await writeFile(value.source.urls.get(payload.signatureUrl!)!, Buffer.alloc(64, 3));
    await expect(value.admission.admitReleaseTarget(release)).rejects.toThrow(/signature/i);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(value.runner.calls).toHaveLength(0);
  });

  it('rechecks signed file and auxiliary metadata bindings when provenance changes around the same archive', async () => {
    const value = await signedFixture('changed-archive-provenance');
    fixtures.push(value);
    const inspect = vi.spyOn(archives, 'inspectNativeArchive');
    const release = await value.client.fetchVerifiedRelease('0.13.0');
    await value.admission.admitReleaseTarget(release);
    await value.resignProvenance({
      ...value.provenance,
      files: value.provenance.files.map((file) => file.path === 'LICENSE' ? { ...file, sha256: '0'.repeat(64) } : file)
    });
    await expect(value.admission.admitReleaseTarget(release)).rejects.toMatchObject({ reasonCode: 'artifact_mismatch' });
    expect(inspect).toHaveBeenCalledTimes(2);
    await value.resignProvenance({ ...value.provenance, buildInfoSha256: '0'.repeat(64) });
    await expect(value.admission.admitReleaseTarget(release)).rejects.toMatchObject({ reasonCode: 'artifact_mismatch' });
    expect(inspect).toHaveBeenCalledTimes(3);
    await value.resignProvenance(value.provenance);
    await expect(value.admission.admitReleaseTarget(release)).resolves.toMatchObject({ archiveDigest: value.provenance.checksumSha256 });
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(value.runner.calls).toHaveLength(0);
  });

  it('still rereads installed files and refuses same-size changes after the archive is validated', async () => {
    const value = await signedFixture('revalidation-local-change');
    fixtures.push(value);
    const inspect = vi.spyOn(archives, 'inspectNativeArchive');
    const candidate = await value.admission.admitBundle(value.candidate);
    await value.admission.recheck(candidate);
    expect(inspect).toHaveBeenCalledTimes(1);
    const filename = path.join(value.candidate, 'LICENSE');
    const original = await readFile(filename);
    const changed = Buffer.from(original);
    changed[changed.length - 1] ^= 1;
    await writeFile(filename, changed);
    await expect(value.admission.recheck(candidate)).rejects.toMatchObject({ reasonCode: 'artifact_mismatch' });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(value.runner.calls).toHaveLength(0);
  });

  it('bounds validation reuse to two exact signed layouts without retaining expanded archive buffers', async () => {
    const value = await signedFixture('bounded-archive-layouts');
    fixtures.push(value);
    const inspect = vi.spyOn(archives, 'inspectNativeArchive');
    const release = await value.client.fetchVerifiedRelease('0.13.0');
    await value.admission.admitReleaseTarget(release);
    const { files, runtime, ...remaining } = value.provenance;
    await value.resignProvenance({ files, runtime, ...remaining });
    await value.admission.admitReleaseTarget(release);
    await value.resignProvenance({ runtime, files, ...remaining });
    await value.admission.admitReleaseTarget(release);
    expect(inspect).toHaveBeenCalledTimes(3);
    await value.resignProvenance(value.provenance);
    await value.admission.admitReleaseTarget(release);
    expect(inspect).toHaveBeenCalledTimes(4);
    expect(value.runner.calls).toHaveLength(0);
  });
});
