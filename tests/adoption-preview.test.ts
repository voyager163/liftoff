import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import {
  AdoptionPreviewError, adoptionPreviewTtlMs, createAdoptionReview, loadAdoptionPreview,
  revalidateAdoptionPreview, saveAdoptionPreview, validateAdoptionPreview, type AdoptionPreview
} from '../src/application/adoption/preview.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { adoptionFixture } from './fixtures/adoption.js';

const roots: string[] = [];
const now = new Date('2026-10-06T00:00:00.000Z');
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(
  stack: 'python-fastapi' | 'node-fastify' | 'go-huma' = 'node-fastify',
  profile: 'none' | 'single-maintainer-gitflow' | 'team-gitflow' = 'none',
  workflow: 'manual' | 'openspec' | 'spec-kit' = 'manual'
) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'adoption-review-owned-')));
  roots.push(directory);
  const root = path.join(directory, 'Existing Project With Spaces'), home = path.join(directory, 'Private Home');
  await mkdir(root);
  await mkdir(home);
  const { source } = adoptionFixture(stack, profile, workflow);
  const backend = source.activeLayout.bindings.find(binding =>
    binding.kind === 'artifact' && binding.logicalName !== 'root-readme');
  if (!backend) throw new Error('Selected actual fixture has no backend artifact binding.');
  const filename = path.join(root, ...backend.pathParts);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, 'PRIVATE_ACTUAL_APPLICATION\r\n', { mode: 0o640 });
  await writeFile(path.join(root, 'README.md'), 'PRIVATE_ACTUAL_DOCUMENTATION\n');
  const storage = { homedir: home, env: {}, clock: () => new Date(now) };
  return { root, home, filename, source, storage };
}
function seal(value: Record<string, unknown>) {
  const { fingerprint: _fingerprint, ...body } = value;
  return { ...body, fingerprint: canonicalSha256(body) };
}
function altered(preview: AdoptionPreview, patch: Record<string, unknown>) {
  return seal({ ...preview, ...patch });
}

describe('distinct actual adoption comparison review without authority', () => {
  const combinations = (['python-fastapi', 'node-fastify', 'go-huma'] as const).flatMap(stack =>
    (['none', 'single-maintainer-gitflow'] as const).flatMap(profile =>
      (['manual', 'openspec', 'spec-kit'] as const).map(workflow => ({ stack, profile, workflow }))));
  it.each(combinations)('captures and re-observes actual $stack/$profile/$workflow without file writes or checks', async selected => {
    const { root, home, filename, source } = await fixture(selected.stack, selected.profile, selected.workflow);
    const original = await readFile(filename), identity = await stat(filename), entries = await readdir(root);
    const review = await createAdoptionReview(root, source, now);
    expect(review.preview).toMatchObject({
      schemaVersion: 1, kind: 'liftoff-adoption-preview', adoptionReviewContractVersion: 1,
      projectRoot: root, createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + adoptionPreviewTtlMs).toISOString(),
      sourceDigest: review.report.sourceDigest, inventoryDigest: review.report.inventory.inspectionDigest,
      candidateDigest: review.candidate?.digest, candidateStatus: 'candidate-observed-unverified',
      verification: 'not-performed', publication: 'not-authorized'
    });
    expect(Object.isFrozen(review.preview)).toBe(true);
    expect(validateAdoptionPreview(review.preview, now)).toEqual(review.preview);
    const current = await revalidateAdoptionPreview(review.preview, source, now);
    expect(current.report).toEqual(review.report);
    expect(current.candidate?.content).toBe(review.candidate?.content);
    expect(await readFile(filename)).toEqual(original);
    expect(await stat(filename)).toMatchObject({
      dev: identity.dev, ino: identity.ino, mode: identity.mode, mtimeMs: identity.mtimeMs, ctimeMs: identity.ctimeMs
    });
    expect(await readdir(root)).toEqual(entries);
    expect(await readdir(home)).toEqual([]);
    expect(Object.keys(review)).toEqual(['report', 'preview']);
    expect(JSON.stringify(review)).not.toContain('PRIVATE_ACTUAL');
    expect(JSON.stringify(review)).not.toContain('"snapshots":');
    expect(JSON.stringify(review)).not.toContain('"candidate":');
    expect(current.report.inventory.deployment).toBe('planning-only');
    expect(current.report.verification).toBe('not-performed');
    expect(current.report.publication).toBe('not-authorized');
  });

  const teamCombinations = (['python-fastapi', 'node-fastify', 'go-huma'] as const).flatMap(stack =>
    (['manual', 'openspec', 'spec-kit'] as const).map(workflow => ({ stack, workflow })));
  it.each(teamCombinations)('refuses unavailable $stack/team-gitflow/$workflow observation without storing a review', async selected => {
    const { root, home, filename, source } = await fixture(selected.stack, 'team-gitflow', selected.workflow);
    const original = await readFile(filename), entries = await readdir(root);
    await expect(createAdoptionReview(root, source, now)).rejects.toThrow(/team-profile repair is not available/);
    expect(await readFile(filename)).toEqual(original);
    expect(await readdir(root)).toEqual(entries);
    expect(await readdir(home)).toEqual([]);
  });

  it('is deterministic for the same observations and clock but binds the actual review interval', async () => {
    const { root, source } = await fixture();
    const first = await createAdoptionReview(root, source, now);
    expect((await createAdoptionReview(root, source, now)).preview).toEqual(first.preview);
    const later = await createAdoptionReview(root, source, new Date(now.getTime() + 1));
    expect(later.preview.fingerprint).not.toBe(first.preview.fingerprint);
    expect(later.preview.inventoryDigest).toBe(first.preview.inventoryDigest);
    expect(later.preview.candidateDigest).toBe(first.preview.candidateDigest);
  });

  it('retains an actually blocked candidate and detects newly supplied missing bytes as a different review', async () => {
    const { root, filename, source } = await fixture();
    await rm(filename);
    const review = await createAdoptionReview(root, source, now);
    expect(review.preview.candidateStatus).toBe('blocked');
    expect(review.preview.candidateDigest).toBeNull();
    expect((await revalidateAdoptionPreview(review.preview, source, now)).candidate).toBeNull();
    await writeFile(filename, 'PRIVATE_NEW_BOUND_INPUT');
    await expect(revalidateAdoptionPreview(review.preview, source, now)).rejects.toThrow(/stale/);
    expect(await readFile(filename, 'utf8')).toBe('PRIVATE_NEW_BOUND_INPUT');
    expect(await readdir(root)).not.toContain('liftoff.manifest.json');
  });

  it.each(['invalid', 'overflow'] as const)('rejects an actual %s clock before creating preview storage', async kind => {
    const { root, home, source } = await fixture();
    await expect(createAdoptionReview(root, source, new Date(kind === 'invalid' ? Number.NaN : 8.64e15)))
      .rejects.toBeInstanceOf(AdoptionPreviewError);
    expect(await readdir(home)).toEqual([]);
    expect(await readdir(root)).not.toContain('liftoff.manifest.json');
  });

  it.each(['application', 'documentation', 'new-file', 'source-name', 'profile', 'binding'] as const)(
    'rejects actually changed %s inputs rather than refreshing the old review', async change => {
      const { root, filename, source } = await fixture();
      const review = await createAdoptionReview(root, source, now);
      let currentSource: unknown = source;
      if (change === 'application') await writeFile(filename, 'PRIVATE_CONCURRENT_APPLICATION_EDIT');
      if (change === 'documentation') await writeFile(path.join(root, 'README.md'), 'PRIVATE_CONCURRENT_DOC_EDIT');
      if (change === 'new-file') await writeFile(path.join(root, 'new-reference.md'), 'Existing Services/API With Spaces\n');
      if (change === 'source-name') currentSource = {
        ...source, selection: { ...source.selection, project: { ...source.selection.project, name: 'Another Selection' } }
      };
      if (change === 'profile') currentSource = adoptionFixture('node-fastify', 'single-maintainer-gitflow').source;
      if (change === 'binding') currentSource = {
        ...source, activeLayout: {
          ...source.activeLayout, bindings: source.activeLayout.bindings.map(binding =>
            binding.kind === 'artifact' && binding.logicalName === 'root-readme'
              ? { ...binding, pathParts: ['UNOBSERVED.md'] } : binding)
        }
      };
      await expect(revalidateAdoptionPreview(review.preview, currentSource, now)).rejects.toThrow(/stale/);
      expect(review.preview.verification).toBe('not-performed');
      expect(review.preview.publication).toBe('not-authorized');
      expect(await readdir(root)).not.toContain('liftoff.manifest.json');
      if (change === 'application') expect(await readFile(filename, 'utf8')).toBe('PRIVATE_CONCURRENT_APPLICATION_EDIT');
    }
  );

  it.skipIf(process.platform === 'win32')('binds actual included file modes without reverting a concurrent mode edit', async () => {
    const { root, filename, source } = await fixture();
    const review = await createAdoptionReview(root, source, now);
    await chmod(filename, 0o600);
    await expect(revalidateAdoptionPreview(review.preview, source, now)).rejects.toThrow(/stale/);
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
  });

  it.each(['liftoff.manifest.json', '.liftoff', '.liftoff-init.lock'] as const)(
    'refuses a new actual %s control boundary without rewriting it', async boundary => {
      const { root, source } = await fixture();
      const review = await createAdoptionReview(root, source, now);
      const file = path.join(root, boundary);
      await writeFile(file, 'PRIVATE_CONCURRENT_CONTROL');
      await expect(revalidateAdoptionPreview(review.preview, source, now)).rejects.toThrow(/control\/transaction/);
      expect(await readFile(file, 'utf8')).toBe('PRIVATE_CONCURRENT_CONTROL');
    }
  );

  it('does not turn a successful bounded re-observation into knowledge of excluded secret payloads', async () => {
    const { root, source } = await fixture();
    await writeFile(path.join(root, '.env'), 'PRIVATE_SECRET_BEFORE');
    const review = await createAdoptionReview(root, source, now);
    await writeFile(path.join(root, '.env'), 'PRIVATE_SECRET_AFTER');
    const current = await revalidateAdoptionPreview(review.preview, source, now);
    expect(current.report.verification).toBe('not-performed');
    expect(current.report.inventory.exclusions.some(entry => entry.pathParts.join('/') === '.env')).toBe(true);
    expect(JSON.stringify(current)).not.toContain('PRIVATE_SECRET');
    expect(await readFile(path.join(root, '.env'), 'utf8')).toBe('PRIVATE_SECRET_AFTER');
  });

  it.each([
    ['schema', { schemaVersion: 2 }],
    ['kind', { kind: 'liftoff-update-preview' }],
    ['repair-kind', { kind: 'liftoff-repair-preview' }],
    ['contract', { adoptionReviewContractVersion: 2 }],
    ['cli', { cliVersion: '0.0.0' }],
    ['verification', { verification: 'passed' }],
    ['publication', { publication: 'authorized' }],
    ['candidate-state', { candidateStatus: 'verified' }],
    ['blocked-with-candidate', { candidateStatus: 'blocked' }],
    ['unverified-without-candidate', { candidateDigest: null }],
    ['malformed-digest', { sourceDigest: 'partial' }],
    ['malformed-candidate-digest', { candidateDigest: 'partial' }],
    ['unsupported-field', { approval: true }]
  ] as const)('rejects a re-fingerprinted %s forgery without allowing it to become authority', async (_kind, patch) => {
    const { root, home, source, storage } = await fixture();
    const review = await createAdoptionReview(root, source, now);
    const forged = altered(review.preview, patch);
    expect(() => validateAdoptionPreview(forged, now)).toThrow();
    await expect(saveAdoptionPreview(forged, now, storage)).rejects.toThrow();
    expect(await readdir(home)).toEqual([]);
    expect(await readdir(root)).not.toContain('liftoff.manifest.json');
  });

  it.each(['future', 'expired', 'interval', 'noncanonical', 'invalid-clock'] as const)(
    'rejects actual %s review dates even when the metadata is re-fingerprinted', async kind => {
      const { root, source } = await fixture();
      const { preview } = await createAdoptionReview(root, source, now);
      const patch = kind === 'future'
        ? { createdAt: new Date(now.getTime() + 1).toISOString(), expiresAt: new Date(now.getTime() + adoptionPreviewTtlMs + 1).toISOString() }
        : kind === 'interval' ? { expiresAt: new Date(now.getTime() + adoptionPreviewTtlMs + 1).toISOString() }
          : kind === 'noncanonical' ? { createdAt: '2026-10-06T00:00:00Z' } : {};
      const clock = kind === 'expired' ? new Date(now.getTime() + adoptionPreviewTtlMs) :
        kind === 'invalid-clock' ? new Date(Number.NaN) : now;
      expect(() => validateAdoptionPreview(altered(preview, patch), clock)).toThrow();
    }
  );

  it.each(['accessor', 'proxy', 'revoked'] as const)('rejects an executable %s review without invoking its hooks', async kind => {
    const { root, source } = await fixture();
    const { preview } = await createAdoptionReview(root, source, now);
    const hook = vi.fn(() => { throw new Error('Review data must not execute hooks.'); });
    const revoked = Proxy.revocable(preview, { ownKeys: hook, getPrototypeOf: hook });
    revoked.revoke();
    const value = kind === 'accessor' ? Object.defineProperty({ ...preview }, 'fingerprint', { get: hook, enumerable: true }) :
      kind === 'proxy' ? new Proxy(preview, { ownKeys: hook, getPrototypeOf: hook }) : revoked.proxy;
    expect(() => validateAdoptionPreview(value, now)).toThrow();
    expect(hook).not.toHaveBeenCalled();
  });

  it('rejects a stale or wrong-root fingerprint independently of its other valid fields', async () => {
    const { root, home, source } = await fixture();
    const { preview } = await createAdoptionReview(root, source, now);
    expect(() => validateAdoptionPreview({ ...preview, fingerprint: 'a'.repeat(64) }, now)).toThrow(/fingerprint/);
    expect(() => validateAdoptionPreview(preview, now, { fingerprint: 'a'.repeat(64) })).toThrow(/fingerprint/);
    expect(() => validateAdoptionPreview(preview, now, { projectRoot: home })).toThrow(/root/);
    expect(() => validateAdoptionPreview(altered(preview, { projectRoot: '.' }), now)).toThrow();
  });

  it('saves only private namespaced comparison metadata and loads it without granting approval', async () => {
    const { root, home, source, storage } = await fixture();
    const { preview } = await createAdoptionReview(root, source, now), entries = await readdir(root);
    const saved = await saveAdoptionPreview(preview, now, storage);
    expect(path.relative(home, saved.path).startsWith('..')).toBe(false);
    expect(path.basename(saved.path)).toMatch(/^adoption-preview-/);
    expect(await loadAdoptionPreview(root, preview.fingerprint, now, storage)).toEqual(preview);
    expect((await saveAdoptionPreview(preview, now, storage)).path).toBe(saved.path);
    expect(await readdir(root)).toEqual(entries);
    expect(await createScopedUserLocalRecordStore(root, 'repair-approval', storage).read(preview.fingerprint)).toBeNull();
    expect(await createScopedUserLocalRecordStore(root, 'governance-approval', storage).read(preview.fingerprint)).toBeNull();
    const text = await readFile(saved.path, 'utf8');
    expect(text).not.toContain('PRIVATE_ACTUAL');
    expect(text).not.toContain('"candidate":');
    expect(text).not.toContain('"snapshots":');
    expect(saved.preview.verification).toBe('not-performed');
    expect(saved.preview.publication).toBe('not-authorized');
    if (process.platform !== 'win32') expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
  });

  it('does not load another operation namespace or another project as an adoption review', async () => {
    const first = await fixture(), second = await fixture();
    const { preview } = await createAdoptionReview(first.root, first.source, now);
    await createScopedUserLocalRecordStore(first.root, 'repair-preview', first.storage).write(preview.fingerprint, preview);
    await expect(loadAdoptionPreview(first.root, preview.fingerprint, now, first.storage)).rejects.toThrow(/No matching/);
    await saveAdoptionPreview(preview, now, first.storage);
    await expect(loadAdoptionPreview(second.root, preview.fingerprint, now, first.storage)).rejects.toThrow(/No matching/);
    await expect(loadAdoptionPreview(first.root, 'partial', now, first.storage)).rejects.toThrow(/complete/);
  });

  it('rejects a re-fingerprinted native alias before saving metadata and does not load through that alias', async () => {
    const { root, home, source, storage } = await fixture();
    const { preview } = await createAdoptionReview(root, source, now);
    const alias = path.join(path.dirname(root), 'Alias With Spaces');
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(saveAdoptionPreview(altered(preview, { projectRoot: alias }), now, storage)).rejects.toThrow();
    expect(await readdir(home)).toEqual([]);
    await saveAdoptionPreview(preview, now, storage);
    await expect(loadAdoptionPreview(alias, preview.fingerprint, now, storage)).rejects.toThrow();
    expect(await loadAdoptionPreview(root, preview.fingerprint, now, storage)).toEqual(preview);
    expect(await readdir(root)).not.toContain('liftoff.manifest.json');
  });

  it.each(['malformed', 'wrong-kind', 'changed-digest'] as const)(
    'reports an actual %s saved-record edit rather than repairing or authorizing it', async kind => {
      const { root, source, storage } = await fixture();
      const { preview } = await createAdoptionReview(root, source, now);
      const saved = await saveAdoptionPreview(preview, now, storage);
      const content = kind === 'malformed' ? '{broken' :
        JSON.stringify({ ...preview, ...(kind === 'wrong-kind' ? { kind: 'liftoff-repair-preview' } : { inventoryDigest: 'a'.repeat(64) }) });
      await writeFile(saved.path, content);
      await expect(loadAdoptionPreview(root, preview.fingerprint, now, storage)).rejects.toThrow();
      expect(await readFile(saved.path, 'utf8')).toBe(content);
      expect(await readdir(root)).not.toContain('liftoff.manifest.json');
    }
  );
});
