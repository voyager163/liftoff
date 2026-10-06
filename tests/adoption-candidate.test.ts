import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectAdoptionCandidate } from '../src/application/adoption/candidate.js';
import { inspectAdoptionLayout } from '../src/application/adoption/inventory.js';
import * as writer from '../src/application/project/manifest-writer.js';
import { buildModernManagedCore } from '../src/application/project/modern-managed-core.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { assertModernRecordData } from '../src/domain/governance/activation/source-values.js';
import { adoptionFixture } from './fixtures/adoption.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(
  stack: 'python-fastapi' | 'node-fastify' | 'go-huma' = 'node-fastify',
  profile: 'none' | 'single-maintainer-gitflow' = 'none',
  workflow: 'manual' | 'openspec' | 'spec-kit' = 'manual'
) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'adoption-candidate-owned-')));
  roots.push(root);
  const value = adoptionFixture(stack, profile, workflow);
  const backend = value.source.activeLayout.bindings.find(binding =>
    binding.kind === 'artifact' && binding.logicalName !== 'root-readme');
  if (!backend || backend.kind !== 'artifact') throw new Error('Actual selected source has no backend fixture binding.');
  const filename = path.join(root, ...backend.pathParts);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, 'PRIVATE_UNREPLACED_APPLICATION\r\n', { mode: 0o640 });
  await writeFile(path.join(root, 'README.md'), 'PRIVATE_UNREPLACED_DOCUMENTATION\n', { mode: 0o640 });
  return { root, filename, backend, ...value };
}

describe('actual observed adoption candidate without authority', () => {
  const combinations = (['python-fastapi', 'node-fastify', 'go-huma'] as const).flatMap(stack =>
    (['none', 'single-maintainer-gitflow'] as const).flatMap(profile =>
      (['manual', 'openspec', 'spec-kit'] as const).map(workflow => ({ stack, profile, workflow }))));
  it.each(combinations)('joins actual $stack observations with $profile/$workflow source without writes or verification', async selected => {
    const { root, filename, source } = await fixture(selected.stack, selected.profile, selected.workflow);
    const original = await readFile(filename), originalStat = await stat(filename);
    const before = await readdir(root);
    const result = await inspectAdoptionCandidate(root, source);
    expect(result.report).toMatchObject({
      schemaVersion: 1, kind: 'liftoff-adoption-candidate-inspection', readOnly: true,
      sourceDigest: canonicalSha256(source), status: 'candidate-observed-unverified', blockers: [],
      verification: 'not-performed', publication: 'not-authorized',
      inventory: { manifest: 'observed-absent', compatibility: 'not-verified', deployment: 'planning-only' }
    });
    expect(result.candidate).not.toBeNull();
    expect(result.report.candidateDigest).toBe(result.candidate?.digest);
    expect(result.candidate?.manifest.projectArtifacts).toEqual([]);
    expect(result.candidate?.manifest.adoptionObservations).toEqual(
      [...result.report.inventory.adoptionObservations].sort((left, right) => left.logicalName.localeCompare(right.logicalName, 'en'))
    );
    expect(result.candidate?.manifest.activeLayout).toEqual(source.activeLayout);
    expect(result.candidate?.manifest.project).toEqual(source.selection.project);
    expect(result.candidate?.manifest.sourceManifestHistory).toBeUndefined();
    expect(result.candidate?.manifest.activationTargetHistory).toBeUndefined();
    expect(result.report.managedSource.map(entry => entry.logicalName)).toEqual(
      buildModernManagedCore(source).map(artifact => artifact.logicalName)
    );
    expect(result.report.requiredChecks).toHaveLength(5);
    expect(await readdir(root)).toEqual(before);
    expect(await readFile(filename)).toEqual(original);
    expect(await stat(filename)).toMatchObject({
      ino: originalStat.ino, dev: originalStat.dev, mode: originalStat.mode,
      mtimeMs: originalStat.mtimeMs, ctimeMs: originalStat.ctimeMs
    });
    const serialized = JSON.stringify(result);
    expect(Object.keys(result)).toEqual(['report']);
    expect(serialized).not.toContain('PRIVATE_UNREPLACED');
    expect(serialized).not.toContain('"candidate":');
    expect(serialized).not.toContain('"snapshots":');
    expect(result.snapshots.some(snapshot => snapshot.content?.equals(original))).toBe(true);
    for (const boundary of ['liftoff.manifest.json', '.liftoff', '.github', '.claude', 'openspec', '.specify']) {
      expect(await readdir(root)).not.toContain(boundary);
    }
  });

  it.each(['backend', 'readme', 'both'] as const)('blocks missing actual %s files without constructing a fictitious candidate', async missing => {
    const { root, filename, source, backend } = await fixture();
    if (missing !== 'readme') await rm(filename);
    if (missing !== 'backend') await rm(path.join(root, 'README.md'));
    const construct = vi.spyOn(writer, 'createManifestV8Candidate');
    const before = await readdir(root);
    const result = await inspectAdoptionCandidate(root, source);
    expect(result.report.status).toBe('blocked');
    expect(result.report.candidateDigest).toBeNull();
    expect(result.candidate).toBeNull();
    expect(result.report.blockers.map(entry => entry.logicalName).sort()).toEqual(
      (missing === 'both' ? [backend.logicalName, 'root-readme'] :
        [missing === 'backend' ? backend.logicalName : 'root-readme']).sort()
    );
    expect(result.report.blockers.every(entry => entry.code === 'binding-unobserved')).toBe(true);
    expect(construct).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(before);
  });

  it('captures validated source data before the first asynchronous root observation', async () => {
    const { root, source } = await fixture();
    const mutable = {
      ...source,
      selection: { ...source.selection, project: { ...source.selection.project } },
      activeLayout: {
        ...source.activeLayout, bindings: source.activeLayout.bindings.map(binding =>
          ({ ...binding, pathParts: [...binding.pathParts] }))
      }
    };
    const expected = canonicalSha256(mutable);
    const pending = inspectAdoptionCandidate(root, mutable);
    mutable.selection.project.name = 'Changed after admission';
    const binding = mutable.activeLayout.bindings[0];
    if (!binding) throw new Error('Actual fixture has no initial component binding.');
    binding.pathParts[0] = 'Changed after admission';
    const result = await pending;
    expect(result.report.sourceDigest).toBe(expected);
    expect(result.candidate?.manifest.project.name).toBe(source.selection.project.name);
    expect(result.candidate?.manifest.activeLayout).toEqual(source.activeLayout);
  });

  it('produces byte-identical comparison candidates from unchanged actual inputs without random identities', async () => {
    const { root, source } = await fixture('node-fastify', 'single-maintainer-gitflow');
    const first = await inspectAdoptionCandidate(root, source);
    const second = await inspectAdoptionCandidate(root, source);
    expect(second.report).toEqual(first.report);
    expect(second.candidate?.content).toBe(first.candidate?.content);
    expect(second.candidate?.manifest).not.toHaveProperty('telemetry');
    expect(second.candidate?.manifest).not.toHaveProperty('activation');
  });

  it('changes imported observations for actual edited application bytes without relabeling them generation history', async () => {
    const { root, filename, source } = await fixture();
    const before = await inspectAdoptionCandidate(root, source);
    await writeFile(filename, 'PRIVATE_ACTUAL_REVIEW_EDIT\n');
    const after = await inspectAdoptionCandidate(root, source);
    expect(after.report.sourceDigest).toBe(before.report.sourceDigest);
    expect(after.report.inventory.inspectionDigest).not.toBe(before.report.inventory.inspectionDigest);
    expect(after.report.candidateDigest).not.toBe(before.report.candidateDigest);
    expect(after.candidate?.manifest.projectArtifacts).toEqual([]);
    expect(await readFile(filename, 'utf8')).toBe('PRIVATE_ACTUAL_REVIEW_EDIT\n');
    expect(after.report.verification).toBe('not-performed');
    expect(after.report.publication).toBe('not-authorized');
  });

  it.each(['liftoff.manifest.json', '.liftoff', '.liftoff-init.lock'])('refuses existing %s boundaries and never creates a comparison manifest', async boundary => {
    const { root, source } = await fixture();
    await writeFile(path.join(root, boundary), 'PRIVATE_EXISTING_CONTROL');
    const construct = vi.spyOn(writer, 'createManifestV8Candidate');
    await expect(inspectAdoptionCandidate(root, source)).rejects.toThrow(/control\/transaction/);
    expect(construct).not.toHaveBeenCalled();
    expect(await readFile(path.join(root, boundary), 'utf8')).toBe('PRIVATE_EXISTING_CONTROL');
  });

  it('preserves existing Git payloads and unselected agent integrations without making them managed evidence', async () => {
    const { root, source } = await fixture();
    for (const parts of [['.git', 'HEAD'], ['.claude', 'commands', 'custom.md']]) {
      await mkdir(path.join(root, ...parts.slice(0, -1)), { recursive: true });
      await writeFile(path.join(root, ...parts), 'PRIVATE_UNSELECTED_CONTROL');
    }
    const gitBefore = await stat(path.join(root, '.git', 'HEAD'));
    const result = await inspectAdoptionCandidate(root, source);
    expect(result.report.status).toBe('candidate-observed-unverified');
    expect(result.report.managedSource).toEqual([]);
    expect(result.report.inventory.files.some(file => ['.git', '.claude'].includes(file.pathParts[0]))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_UNSELECTED_CONTROL');
    expect(await readFile(path.join(root, '.git', 'HEAD'), 'utf8')).toBe('PRIVATE_UNSELECTED_CONTROL');
    expect(await readFile(path.join(root, '.claude', 'commands', 'custom.md'), 'utf8')).toBe('PRIVATE_UNSELECTED_CONTROL');
    expect(await stat(path.join(root, '.git', 'HEAD'))).toMatchObject({
      ino: gitBefore.ino, mode: gitBefore.mode, mtimeMs: gitBefore.mtimeMs, ctimeMs: gitBefore.ctimeMs
    });
  });

  it.each(['accessor', 'proxy'] as const)('rejects a %s source before its hooks or any candidate constructor run', async kind => {
    const { root, source } = await fixture();
    const hook = vi.fn(() => source.selection);
    const malicious = kind === 'accessor'
      ? Object.defineProperty({ ...source }, 'selection', { enumerable: true, get: hook })
      : new Proxy(source, { get: hook, ownKeys: vi.fn(() => { hook(); return Reflect.ownKeys(source); }) });
    const construct = vi.spyOn(writer, 'createManifestV8Candidate');
    const before = await readdir(root);
    await expect(inspectAdoptionCandidate(root, malicious)).rejects.toThrow();
    expect(hook).not.toHaveBeenCalled();
    expect(construct).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(before);
  });

  it('rejects an altered installed plugin identity rather than building from current-template defaults', async () => {
    const { root, source } = await fixture();
    const construct = vi.spyOn(writer, 'createManifestV8Candidate');
    await expect(inspectAdoptionCandidate(root, {
      ...source, plugins: { ...source.plugins, resolutionDigest: `sha256:${'a'.repeat(64)}` }
    })).rejects.toThrow();
    expect(construct).not.toHaveBeenCalled();
    expect(await readdir(root)).not.toContain('liftoff.manifest.json');
  });

  it('does not treat a nonempty component binding as observed artifact coverage', async () => {
    const { root, source } = await fixture();
    await expect(inspectAdoptionCandidate(root, {
      ...source,
      activeLayout: {
        ...source.activeLayout,
        bindings: source.activeLayout.bindings.filter(binding => binding.kind === 'component')
      }
    })).rejects.toThrow(/artifact/);
    expect(await readdir(root)).not.toContain('liftoff.manifest.json');
  });

  it.each(['root', 'nested', 'array', 'revoked'] as const)(
    'rejects actual %s proxies at the shared modern data boundary before any reflection hook', location => {
      const hook = vi.fn(() => { throw new Error('Proxy hook must not execute.'); });
      const target = location === 'array' ? [] : {};
      const handler: ProxyHandler<object> = {
        get: hook, ownKeys: hook, getPrototypeOf: hook, getOwnPropertyDescriptor: hook
      };
      const proxy = location === 'revoked' ? Proxy.revocable(target, handler) : null;
      const value = proxy?.proxy ?? new Proxy(target, handler);
      proxy?.revoke();
      expect(() => assertModernRecordData(location === 'nested' || location === 'array' ? { nested: value } : value))
        .toThrow(/plain JSON data/);
      expect(hook).not.toHaveBeenCalled();
    }
  );

  it.each(['inventory', 'managed-content'] as const)(
    'protects the existing actual %s producer with the same early Proxy rejection', async operation => {
      const { root, source } = await fixture();
      const hook = vi.fn(() => { throw new Error('Source reflection must not invoke a Proxy.'); });
      const malicious = new Proxy(source, { get: hook, ownKeys: hook, getPrototypeOf: hook });
      if (operation === 'inventory') await expect(inspectAdoptionLayout(root, malicious)).rejects.toThrow(/plain JSON data/);
      else expect(() => buildModernManagedCore(malicious)).toThrow(/plain JSON data/);
      expect(hook).not.toHaveBeenCalled();
      expect(await readdir(root)).not.toContain('liftoff.manifest.json');
    }
  );
});
