import {
  chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadAdoptionDestinationPlan, prepareAdoptionDestinationPlan, saveAdoptionDestinationPlan
} from '../src/application/adoption/destination-plan.js';
import {
  createAdoptionReview, saveAdoptionPreview
} from '../src/application/adoption/preview.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { buildModernManagedCore } from '../src/application/project/modern-managed-core.js';
import { adoptionFixture } from './fixtures/adoption.js';

const roots: string[] = [];
const now = new Date('2026-10-07T10:45:00.000Z');
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(
  stack: 'python-fastapi' | 'node-fastify' | 'go-huma' = 'node-fastify',
  profile: 'none' | 'single-maintainer-gitflow' = 'none',
  workflow: 'manual' | 'openspec' | 'spec-kit' = 'manual'
) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'adoption-plan-owned-')));
  roots.push(directory);
  const root = path.join(directory, 'Existing Project With Spaces');
  const home = path.join(directory, 'Private Home');
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
  const review = await createAdoptionReview(root, source, now);
  const storage = { homedir: home, env: {}, clock: () => new Date(now) };
  return { root, home, filename, source, review, storage };
}

async function write(root: string, pathParts: readonly string[], content: string | Buffer, mode?: number) {
  const filename = path.join(root, ...pathParts);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content, mode === undefined ? {} : { mode });
  return filename;
}

describe('exact read-only adoption destination plan without transaction authority', () => {
  const combinations = (['python-fastapi', 'node-fastify', 'go-huma'] as const).flatMap(stack =>
    (['none', 'single-maintainer-gitflow'] as const).flatMap(profile =>
      (['manual', 'openspec', 'spec-kit'] as const).map(workflow => ({ stack, profile, workflow }))));
  it.each(combinations)('plans absent $stack/$profile/$workflow destinations without writing them', async selected => {
    const { root, filename, source, review } = await fixture(selected.stack, selected.profile, selected.workflow);
    const application = await readFile(filename), applicationStat = await stat(filename);
    const before = await readdir(root);
    const plan = await prepareAdoptionDestinationPlan(review.preview, source, now);
    const managed = buildModernManagedCore(source);
    expect(plan.report).toMatchObject({
      schemaVersion: 1, kind: 'liftoff-adoption-destination-plan', readOnly: true,
      projectRoot: root, reviewFingerprint: review.preview.fingerprint,
      candidateDigest: review.candidate?.digest, status: 'ready-for-independent-verification',
      blockers: [], verification: 'not-performed', approval: 'not-requested', publication: 'not-authorized'
    });
    expect(plan.report.destinations).toHaveLength(managed.length + 1);
    expect(plan.report.destinations.every(destination => destination.status === 'absent')).toBe(true);
    expect(plan.mutations).toHaveLength(managed.length + 1);
    expect(plan.mutations.at(-1)?.pathParts).toEqual(['liftoff.manifest.json']);
    expect(plan.preconditions.some(snapshot => snapshot.pathParts.join('/') ===
      source.activeLayout.bindings.find(binding => binding.kind === 'artifact' &&
        binding.logicalName !== 'root-readme')?.pathParts.join('/'))).toBe(true);
    expect(plan.report.requiredPermissions).toEqual([
      'dependency-preparation', 'project-code-execution', 'declared-network', 'file-transaction'
    ]);
    expect(Object.keys(plan)).toEqual(['report']);
    expect(JSON.stringify(plan)).not.toContain('PRIVATE_ACTUAL');
    expect(JSON.stringify(plan)).not.toContain('"mutations":');
    expect(JSON.stringify(plan)).not.toContain('"preconditions":');
    expect(await readdir(root)).toEqual(before);
    expect(await readFile(filename)).toEqual(application);
    expect(await stat(filename)).toMatchObject({
      dev: applicationStat.dev, ino: applicationStat.ino, mode: applicationStat.mode,
      mtimeMs: applicationStat.mtimeMs, ctimeMs: applicationStat.ctimeMs
    });
    expect(await readdir(root)).not.toContain('liftoff.manifest.json');
  });

  it('produces the same plan fingerprint for the same review and unchanged destination observations', async () => {
    const { source, review } = await fixture('node-fastify', 'single-maintainer-gitflow', 'openspec');
    const first = await prepareAdoptionDestinationPlan(review.preview, source, now);
    const second = await prepareAdoptionDestinationPlan(review.preview, source, now);
    expect(second.report).toEqual(first.report);
    expect(second.mutations).toEqual(first.mutations);
    expect(second.preconditions).toEqual(first.preconditions);
  });

  it('returns frozen public metadata and defensive private effect/snapshot copies', async () => {
    const { source, review } = await fixture('node-fastify', 'single-maintainer-gitflow', 'openspec');
    const plan = await prepareAdoptionDestinationPlan(review.preview, source, now);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.report)).toBe(true);
    expect(Object.isFrozen(plan.report.destinations)).toBe(true);
    const mutation = plan.mutations[0]!;
    Reflect.set(mutation.pathParts, 0, 'CHANGED');
    expect(plan.mutations[0]?.pathParts[0]).not.toBe('CHANGED');
    const snapshot = plan.preconditions.find(entry => entry.content !== undefined)!;
    const expected = Buffer.from(snapshot.content!);
    Reflect.set(snapshot.pathParts, 0, 'CHANGED');
    snapshot.content!.fill(0);
    const current = plan.preconditions.find(entry => entry.content?.equals(expected));
    expect(current).toBeDefined();
    expect(current?.pathParts[0]).not.toBe('CHANGED');
  });

  it('keeps byte-identical existing managed content explicitly unowned and out of proposed writes', async () => {
    const { root, source } = await fixture('node-fastify', 'single-maintainer-gitflow', 'openspec');
    const artifact = buildModernManagedCore(source)[0]!;
    const filename = await write(root, artifact.pathParts, artifact.content, 0o640);
    const identity = await stat(filename);
    const review = await createAdoptionReview(root, source, now);
    const plan = await prepareAdoptionDestinationPlan(review.preview, source, now);
    expect(plan.report.status).toBe('ready-for-independent-verification');
    expect(plan.report.destinations.find(destination => destination.logicalName === artifact.logicalName)).toMatchObject({
      status: 'matching-unowned', observedMode: identity.mode & 0o7777,
      observedDigest: plan.report.destinations.find(destination => destination.logicalName === artifact.logicalName)?.candidateDigest
    });
    expect(plan.mutations.some(mutation => mutation.pathParts.join('/') === artifact.pathParts.join('/'))).toBe(false);
    expect(plan.preconditions.find(snapshot => snapshot.pathParts.join('/') === artifact.pathParts.join('/'))?.content)
      .toEqual(Buffer.from(artifact.content));
    expect(await readFile(filename, 'utf8')).toBe(artifact.content);
  });

  it('blocks the complete mutation inventory for one different unowned destination', async () => {
    const { root, source } = await fixture('node-fastify', 'single-maintainer-gitflow', 'openspec');
    const artifact = buildModernManagedCore(source)[0]!;
    const filename = await write(root, artifact.pathParts, 'PRIVATE_EXISTING_UNOWNED_CONTENT\n');
    const before = await readFile(filename), beforeStat = await stat(filename);
    const review = await createAdoptionReview(root, source, now);
    const plan = await prepareAdoptionDestinationPlan(review.preview, source, now);
    expect(plan.report.status).toBe('blocked');
    expect(plan.report.blockers).toEqual([{
      code: 'unowned-destination-conflict', logicalName: artifact.logicalName, pathParts: artifact.pathParts
    }]);
    expect(plan.report.destinations.find(destination => destination.logicalName === artifact.logicalName)?.status)
      .toBe('conflict');
    expect(plan.mutations).toEqual([]);
    expect(await readFile(filename)).toEqual(before);
    expect(await stat(filename)).toMatchObject({
      dev: beforeStat.dev, ino: beforeStat.ino, mode: beforeStat.mode,
      mtimeMs: beforeStat.mtimeMs, ctimeMs: beforeStat.ctimeMs
    });
    expect(await readdir(root)).not.toContain('liftoff.manifest.json');
  });

  it('preserves all conflicts and never converts a partial safe subset into executable mutations', async () => {
    const { root, source } = await fixture('node-fastify', 'single-maintainer-gitflow', 'openspec');
    const artifacts = buildModernManagedCore(source).slice(0, 2);
    for (const [index, artifact] of artifacts.entries()) {
      await write(root, artifact.pathParts, `PRIVATE_CONFLICT_${index}\n`);
    }
    const review = await createAdoptionReview(root, source, now);
    const plan = await prepareAdoptionDestinationPlan(review.preview, source, now);
    expect(plan.report.blockers).toHaveLength(2);
    expect(plan.report.blockers.map(blocker => blocker.logicalName).sort())
      .toEqual(artifacts.map(artifact => artifact.logicalName).sort());
    expect(plan.mutations).toEqual([]);
  });

  it('keeps an incomplete application candidate blocked without inspecting or proposing destinations', async () => {
    const { root, filename, source } = await fixture('node-fastify', 'single-maintainer-gitflow', 'openspec');
    await rm(filename);
    const review = await createAdoptionReview(root, source, now);
    const plan = await prepareAdoptionDestinationPlan(review.preview, source, now);
    expect(plan.report).toMatchObject({
      status: 'blocked', candidateDigest: null, destinations: [],
      verification: 'not-performed', approval: 'not-requested', publication: 'not-authorized'
    });
    expect(plan.report.blockers).toEqual([{
      code: 'candidate-incomplete',
      logicalName: expect.any(String),
      pathParts: expect.any(Array)
    }]);
    expect(plan.mutations).toEqual([]);
    expect(await readdir(root)).not.toContain('liftoff.manifest.json');
  });

  it.each(['application-bytes', 'new-member', 'source'] as const)(
    'refuses stale reviewed %s before proposing any destination write', async change => {
      const { root, filename, source, review } = await fixture();
      let current: unknown = source;
      if (change === 'application-bytes') await writeFile(filename, 'PRIVATE_CONCURRENT_EDIT\n');
      if (change === 'new-member') await writeFile(path.join(root, 'new-source.ts'), 'PRIVATE_NEW_MEMBER\n');
      if (change === 'source') current = adoptionFixture('python-fastapi').source;
      await expect(prepareAdoptionDestinationPlan(review.preview, current, now)).rejects.toThrow(/stale/);
      expect(await readdir(root)).not.toContain('liftoff.manifest.json');
    });

  it.skipIf(process.platform === 'win32')(
    'refuses stale reviewed application-mode before proposing any destination write', async () => {
      const { root, filename, source, review } = await fixture();
      await chmod(filename, 0o600);
      await expect(prepareAdoptionDestinationPlan(review.preview, source, now)).rejects.toThrow(/stale/);
      expect((await stat(filename)).mode & 0o777).toBe(0o600);
      expect(await readdir(root)).not.toContain('liftoff.manifest.json');
    });

  it('rejects a proxied source before reading it to derive destinations', async () => {
    const { source, review } = await fixture();
    const hook = vi.fn(() => {
      throw new Error('Destination planning must not invoke a Proxy source.');
    });
    const malicious = new Proxy(source, {
      get: hook, ownKeys: hook, getPrototypeOf: hook, getOwnPropertyDescriptor: hook
    });
    await expect(prepareAdoptionDestinationPlan(review.preview, malicious, now)).rejects.toThrow();
    expect(hook).not.toHaveBeenCalled();
  });

  it.each(['manifest', 'transaction-directory', 'initialization-lock'] as const)(
    'refuses a concurrent %s control boundary before destination planning', async value => {
      const { root, source, review } = await fixture();
      const name = value === 'manifest' ? 'liftoff.manifest.json' :
        value === 'transaction-directory' ? '.liftoff' : '.liftoff-init.lock';
      const filename = path.join(root, name);
      if (value === 'transaction-directory') await mkdir(filename);
      else await writeFile(filename, 'PRIVATE_CONCURRENT_CONTROL\n');
      await expect(prepareAdoptionDestinationPlan(review.preview, source, now)).rejects.toThrow(/control\/transaction/);
      if (value !== 'transaction-directory') expect(await readFile(filename, 'utf8')).toBe('PRIVATE_CONCURRENT_CONTROL\n');
    });

  it.each(['directory', 'oversized'] as const)('rejects an unsafe %s managed destination without effects', async kind => {
    const { root, source } = await fixture('node-fastify', 'single-maintainer-gitflow', 'openspec');
    const artifact = buildModernManagedCore(source)[0]!;
    const filename = path.join(root, ...artifact.pathParts);
    await mkdir(path.dirname(filename), { recursive: true });
    if (kind === 'directory') await mkdir(filename);
    else await writeFile(filename, Buffer.alloc(1024 * 1024 + 1, 0x61));
    await expect((async () => {
      const review = await createAdoptionReview(root, source, now);
      return prepareAdoptionDestinationPlan(review.preview, source, now);
    })())
      .rejects.toThrow(kind === 'directory' ? /not a regular file/ : /size limit/);
    expect((await stat(filename)).isDirectory()).toBe(kind === 'directory');
    expect(await readdir(root)).not.toContain('liftoff.manifest.json');
  });

  it.skipIf(process.platform === 'win32')('rejects a hard-linked managed destination without removing either link', async () => {
    const { root, source } = await fixture('node-fastify', 'single-maintainer-gitflow', 'openspec');
    const artifact = buildModernManagedCore(source)[0]!;
    const outside = await write(root, ['outside-owned.txt'], artifact.content);
    const destination = path.join(root, ...artifact.pathParts);
    await mkdir(path.dirname(destination), { recursive: true });
    await link(outside, destination);
    await expect((async () => {
      const review = await createAdoptionReview(root, source, now);
      return prepareAdoptionDestinationPlan(review.preview, source, now);
    })()).rejects.toThrow(/hard-linked|singly linked/);
    expect((await stat(outside)).nlink).toBe(2);
    expect((await stat(destination)).nlink).toBe(2);
  });

  it('rejects case-aliased destination ancestry without renaming or replacing it', async () => {
    const { root, source } = await fixture('node-fastify', 'single-maintainer-gitflow', 'openspec');
    const artifact = buildModernManagedCore(source).find(entry => entry.pathParts.length > 1)!;
    const alias = artifact.pathParts[0]!.toUpperCase() === artifact.pathParts[0]
      ? artifact.pathParts[0]!.toLowerCase() : artifact.pathParts[0]!.toUpperCase();
    await mkdir(path.join(root, alias));
    await expect((async () => {
      const review = await createAdoptionReview(root, source, now);
      return prepareAdoptionDestinationPlan(review.preview, source, now);
    })()).rejects.toThrow(/case or Unicode collision/);
    expect(await readdir(root)).toContain(alias);
    expect(await readdir(root)).not.toContain('liftoff.manifest.json');
  });

  it('binds actual destination mode and bytes into a different plan fingerprint', async () => {
    const { root, source, review } = await fixture('node-fastify', 'single-maintainer-gitflow', 'openspec');
    const first = await prepareAdoptionDestinationPlan(review.preview, source, now);
    const artifact = buildModernManagedCore(source)[0]!;
    const filename = await write(root, artifact.pathParts, artifact.content, 0o600);
    const currentReview = await createAdoptionReview(root, source, now);
    const second = await prepareAdoptionDestinationPlan(currentReview.preview, source, now);
    expect(second.report.fingerprint).not.toBe(first.report.fingerprint);
    expect(second.report.destinations.find(destination => destination.logicalName === artifact.logicalName)?.observedMode)
      .toBe((await stat(filename)).mode & 0o7777);
    expect(second.report.verification).toBe('not-performed');
    expect(second.report.approval).toBe('not-requested');
  });

  it('saves only a fresh ready report and rebuilds private effects from current observations when loading', async () => {
    const { root, home, source, review, storage } = await fixture(
      'node-fastify', 'single-maintainer-gitflow', 'openspec');
    await saveAdoptionPreview(review.preview, now, storage);
    const before = await readdir(root);
    const saved = await saveAdoptionDestinationPlan(
      root, review.preview.fingerprint, source, now, storage);
    expect(path.relative(home, saved.path).startsWith('..')).toBe(false);
    expect(path.basename(saved.path)).toMatch(/^adoption-destination-plan-/);
    expect(Object.keys(saved.plan)).toEqual(['report']);
    const loaded = await loadAdoptionDestinationPlan(
      root, review.preview.fingerprint, saved.plan.report.fingerprint, source, now, storage);
    expect(loaded.report).toEqual(saved.plan.report);
    expect(loaded.mutations).toEqual(saved.plan.mutations);
    expect(loaded.preconditions).toEqual(saved.plan.preconditions);
    expect((await saveAdoptionDestinationPlan(
      root, review.preview.fingerprint, source, now, storage)).path).toBe(saved.path);
    expect(await readdir(root)).toEqual(before);
    const text = await readFile(saved.path, 'utf8');
    expect(text).not.toContain('PRIVATE_ACTUAL');
    expect(text).not.toContain('"mutations":');
    expect(text).not.toContain('"preconditions":');
    expect(loaded.report.verification).toBe('not-performed');
    expect(loaded.report.approval).toBe('not-requested');
    expect(loaded.report.publication).toBe('not-authorized');
    expect(await createScopedUserLocalRecordStore(
      root, 'repair-verification', storage).read(saved.plan.report.fingerprint)).toBeNull();
    if (process.platform !== 'win32') expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
  });

  it('does not persist a blocked destination report as a verification input', async () => {
    const { root, home, source, review, storage } = await fixture(
      'node-fastify', 'single-maintainer-gitflow', 'openspec');
    const artifact = buildModernManagedCore(source)[0]!;
    await write(root, artifact.pathParts, 'PRIVATE_CONFLICT\n');
    const current = await createAdoptionReview(root, source, now);
    await saveAdoptionPreview(current.preview, now, storage);
    await expect(saveAdoptionDestinationPlan(
      root, current.preview.fingerprint, source, now, storage)).rejects.toThrow(/Blocked/);
    expect((await readdir(home, { recursive: true })).map(String)
      .some(name => name.includes('adoption-destination-plan-'))).toBe(false);
    expect(await readFile(path.join(root, ...artifact.pathParts), 'utf8')).toBe('PRIVATE_CONFLICT\n');
    expect(review.preview.fingerprint).not.toBe(current.preview.fingerprint);
  });

  it.each(['application', 'destination', 'source', 'expired'] as const)(
    'refuses a saved destination plan after %s changes without exposing old private effects', async change => {
      const { root, filename, source, review, storage } = await fixture(
        'node-fastify', 'single-maintainer-gitflow', 'openspec');
      await saveAdoptionPreview(review.preview, now, storage);
      const saved = await saveAdoptionDestinationPlan(
        root, review.preview.fingerprint, source, now, storage);
      let current: unknown = source;
      let clock = now;
      if (change === 'application') await writeFile(filename, 'PRIVATE_CHANGED_APPLICATION\n');
      if (change === 'destination') {
        const artifact = buildModernManagedCore(source)[0]!;
        await write(root, artifact.pathParts, 'PRIVATE_NEW_DESTINATION\n');
      }
      if (change === 'source') current = adoptionFixture('python-fastapi').source;
      if (change === 'expired') clock = new Date(now.getTime() + 15 * 60_000);
      await expect(loadAdoptionDestinationPlan(
        root, review.preview.fingerprint, saved.plan.report.fingerprint, current, clock, storage))
        .rejects.toThrow();
      expect(await readdir(root)).not.toContain('liftoff.manifest.json');
    });

  it('does not load another namespace, another project or a forged plan key', async () => {
    const first = await fixture(), second = await fixture();
    await saveAdoptionPreview(first.review.preview, now, first.storage);
    const prepared = await prepareAdoptionDestinationPlan(first.review.preview, first.source, now);
    await createScopedUserLocalRecordStore(
      first.root, 'repair-verification', first.storage).write(prepared.report.fingerprint, prepared.report);
    await expect(loadAdoptionDestinationPlan(
      first.root, first.review.preview.fingerprint, prepared.report.fingerprint,
      first.source, now, first.storage)).rejects.toThrow(/No matching/);
    const saved = await saveAdoptionDestinationPlan(
      first.root, first.review.preview.fingerprint, first.source, now, first.storage);
    await expect(loadAdoptionDestinationPlan(
      second.root, first.review.preview.fingerprint, saved.plan.report.fingerprint,
      first.source, now, first.storage)).rejects.toThrow();
    await expect(loadAdoptionDestinationPlan(
      first.root, first.review.preview.fingerprint, 'partial',
      first.source, now, first.storage)).rejects.toThrow(/complete/);
  });

  it('reports a changed saved report without repairing or trusting its metadata', async () => {
    const { root, source, review, storage } = await fixture();
    await saveAdoptionPreview(review.preview, now, storage);
    const saved = await saveAdoptionDestinationPlan(
      root, review.preview.fingerprint, source, now, storage);
    const changed = JSON.stringify({ ...saved.plan.report, verification: 'performed' });
    await writeFile(saved.path, changed);
    await expect(loadAdoptionDestinationPlan(
      root, review.preview.fingerprint, saved.plan.report.fingerprint, source, now, storage))
      .rejects.toThrow(/invalid|stale|different/);
    expect(await readFile(saved.path, 'utf8')).toBe(changed);
    expect(await readdir(root)).not.toContain('liftoff.manifest.json');
  });
});
