import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createManifestV8Candidate } from '../src/application/project/manifest-writer.js';
import { resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { canonicalJson } from '../src/domain/governance/activation/canonical-json.js';
import { createManifestV8Reader } from '../src/domain/project/manifest/v8.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { liftoffVersion } from '../src/version.js';
import { adoptionFixture, type AdoptionRequest } from './fixtures/adoption.js';

const sha = (bytes: string | Uint8Array): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const stacks = ['python-fastapi', 'node-fastify', 'go-huma'] as const;
const profiles = ['none', 'single-maintainer-gitflow', 'team-gitflow'] as const;
const workflows = ['manual', 'openspec', 'spec-kit'] as const;
const reader = createManifestV8Reader({
  catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract
});

function request(
  stack: (typeof stacks)[number] = 'node-fastify',
  profile: (typeof profiles)[number] = 'none',
  workflow: (typeof workflows)[number] = 'manual'
): AdoptionRequest {
  return adoptionFixture(stack, profile, workflow).request;
}

describe('private adoption manifest candidates', () => {
  it('admits only byte decisions and imported observations, not a generated-artifact request', () => {
    expectTypeOf<AdoptionRequest['managed'][number]['kind']>().toEqualTypeOf<'bytes'>();
    expectTypeOf<AdoptionRequest>().not.toHaveProperty('generatedArtifacts');
    expectTypeOf<AdoptionRequest>().not.toHaveProperty('source');
    expectTypeOf<AdoptionRequest>().not.toHaveProperty('sourceManifestHistory');
  });

  it.each(stacks.flatMap(stack => profiles.flatMap(profile => workflows.map(workflow => ({ stack, profile, workflow })))))(
    'constructs honest $stack/$profile/$workflow metadata without claiming public adoption or compatibility',
    ({ stack, profile, workflow }) => {
      const input = request(stack, profile, workflow);
      const before = structuredClone(input);
      const candidate = createManifestV8Candidate(input);
      expect(input).toEqual(before);
      expect(candidate.manifest).toEqual(reader.parseManifestV8(JSON.parse(candidate.content)));
      expect(candidate.manifest.project).toEqual(input.selection.project);
      expect(candidate.manifest.framework).toEqual(input.selection.framework);
      expect(candidate.manifest.activeLayout).toEqual(input.activeLayout);
      expect(candidate.manifest.projectArtifacts).toEqual([]);
      expect(candidate.manifest.adoptionObservations).toEqual([...input.adoptionObservations]
        .sort((left, right) => left.logicalName < right.logicalName ? -1 : 1));
      expect(candidate.manifest.liftoffVersion).toBe(liftoffVersion);
      expect(candidate.manifest).not.toHaveProperty('sourceManifestHistory');
      expect(candidate.manifest).not.toHaveProperty('activationTargetHistory');
      expect(candidate.manifest).not.toHaveProperty('compatible');
      expect(candidate.manifest).not.toHaveProperty('telemetryId');
      expect(candidate.content).toBe(`${JSON.stringify(candidate.manifest, null, 2)}\n`);
      expect(`sha256:${candidate.digest}`).toBe(sha(candidate.content));
      for (const observation of candidate.manifest.adoptionObservations) {
        expect(Object.keys(observation).sort()).toEqual(['logicalName', 'observedHash', 'pathParts']);
        expect(observation).not.toHaveProperty('generationHash');
        expect(observation).not.toHaveProperty('generatedBy');
        expect(Object.isFrozen(observation.pathParts)).toBe(true);
      }
      expect(candidate.manifest.managedArtifacts).toEqual(input.managed.map(artifact => ({
        logicalName: artifact.logicalName, category: artifact.category,
        pathParts: artifact.pathParts, contentHash: sha(artifact.content)
      })));
      expect(Object.isFrozen(candidate.manifest)).toBe(true);
      expect(createManifestV8Candidate(input)).toEqual(candidate);
    });

  it('canonicalizes observation/binding order without changing exact hashes or caller data', () => {
    const original = request();
    const reordered = {
      ...original,
      activeLayout: { ...original.activeLayout, bindings: [...original.activeLayout.bindings].reverse() },
      adoptionObservations: [...original.adoptionObservations].reverse()
    };
    const before = structuredClone(reordered);
    expect(createManifestV8Candidate(reordered)).toEqual(createManifestV8Candidate(original));
    expect(reordered).toEqual(before);
  });

  it('preserves imported provenance and layout through ordinary managed maintenance', () => {
    const adopted = createManifestV8Candidate(request());
    const maintained = createManifestV8Candidate({
      origin: 'maintenance', source: adopted.manifest,
      managed: adopted.manifest.managedArtifacts.map(({ logicalName }) => ({ kind: 'retain', logicalName }))
    });
    expect(maintained.content).toBe(adopted.content);
    expect(maintained.manifest.projectArtifacts).toEqual([]);
    expect(maintained.manifest.adoptionObservations).toEqual(adopted.manifest.adoptionObservations);
    expect(maintained.manifest.activeLayout).toEqual(adopted.manifest.activeLayout);
    expect(canonicalJson(maintained.manifest.plugins)).toBe(canonicalJson(adopted.manifest.plugins));
  });

  it.each(['source', 'sourceManifestHistory', 'activationTargetHistory', 'projectArtifacts', 'generatedArtifacts', 'approvePlan'])(
    'rejects supplied %s rather than fabricating source history or authority', field => {
      expect(() => createManifestV8Candidate({ ...request(), [field]: [] })).toThrow('exactly the required fields');
    });

  it.each(['retain', 'retire-alias'])('rejects unsupported %s decisions without an original source', kind => {
    const input = request();
    expect(() => createManifestV8Candidate({
      ...input, managed: [{ kind, logicalName: input.managed[0].logicalName }]
    })).toThrow();
  });

  it('rejects duplicate, unselected, mismatched-category and wrong-path managed decisions', () => {
    const input = request(), first = input.managed[0];
    for (const managed of [
      [first, first], [{ ...first, logicalName: 'unselected-owned-file' }],
      [{ ...first, category: 'backend' }], [{ ...first, pathParts: ['foreign-control.json'] }]
    ]) expect(() => createManifestV8Candidate({ ...input, managed })).toThrow();
  });

  it.each(['repository-governance-policy', 'repository-governance-phase-graph'])(
    'requires actual current static %s bytes', logicalName => {
      const input = request('node-fastify', 'single-maintainer-gitflow');
      const managed = input.managed.map(entry => entry.logicalName === logicalName ? { ...entry, content: 'wrong\n' } : entry);
      expect(() => createManifestV8Candidate({ ...input, managed })).toThrow('actual modern static source');
    });

  it('does not turn missing managed handoff bytes into complete governance', () => {
    const input = request('node-fastify', 'single-maintainer-gitflow');
    const manifest = createManifestV8Candidate({ ...input, managed: [] }).manifest;
    expect(manifest.governance.state).toBe('handoff-partial');
    expect(manifest.managedArtifacts).toEqual([]);
    expect(manifest.projectArtifacts).toEqual([]);
    expect(manifest.adoptionObservations).toHaveLength(2);
  });

  it.each([
    { schemaVersion: 1, state: 'unresolved', bindings: [] },
    { schemaVersion: 1, state: 'bound', bindings: [{ kind: 'component', component: 'backend', pathParts: ['Custom'] }] }
  ])('rejects $state layout without exact imported artifact observation', activeLayout => {
    expect(() => createManifestV8Candidate({ ...request(), activeLayout, adoptionObservations: [] })).toThrow('Adoption requires');
  });

  it('rejects missing, duplicate, unbound and path-mismatched observations', () => {
    const input = request(), first = input.adoptionObservations[0], second = input.adoptionObservations[1];
    for (const adoptionObservations of [
      [], [first], [first, first], [first, { ...second, pathParts: ['Different', 'entry.ts'] }],
      [...input.adoptionObservations, { ...first, logicalName: 'node-backend-server', pathParts: ['unbound.ts'] }]
    ]) expect(() => createManifestV8Candidate({ ...input, adoptionObservations })).toThrow();
  });

  it.each([
    { label: 'short digest', change: { observedHash: 'sha256:bad' } },
    { label: 'uppercase digest', change: { observedHash: `sha256:${'A'.repeat(64)}` } },
    { label: 'missing digest prefix', change: { observedHash: '0'.repeat(64) } },
    { label: 'traversal path', change: { pathParts: ['..', 'outside'] } },
    { label: 'drive path', change: { pathParts: ['C:', 'outside'] } },
    { label: 'foreign identity', change: { logicalName: 'foreign-file' } },
    { label: 'invented generation hash', change: { generationHash: sha('invented generation') } },
    { label: 'invented generator', change: { generatedBy: liftoffVersion } }
  ])('rejects imported records with $label', ({ change }) => {
    const input = request();
    expect(() => createManifestV8Candidate({
      ...input, adoptionObservations: [{ ...input.adoptionObservations[0], ...change }, input.adoptionObservations[1]]
    })).toThrow();
  });

  it('rejects reserved, case-aliased and mismatched component paths', () => {
    const input = request();
    for (const pathParts of [['.git', 'README.md'], ['.liftoff', 'README.md'], ['readme.md'], ['Existing Services', 'elsewhere', 'README.md']]) {
      const activeLayout = {
        ...input.activeLayout, bindings: input.activeLayout.bindings.map(binding =>
          binding.kind === 'artifact' && binding.logicalName === 'root-readme' ? { ...binding, pathParts } : binding)
      };
      expect(() => createManifestV8Candidate({ ...input, activeLayout })).toThrow();
    }
  });

  it('rejects legacy framework uncertainty and missing or unsupported profiles', () => {
    const input = request('node-fastify', 'none', 'openspec');
    const legacy = {
      ...input.selection, project: { ...input.selection.project, agents: [] },
      framework: { state: 'legacy', adapter: 'openspec' }
    };
    expect(() => createManifestV8Candidate({ ...input, selection: legacy })).toThrow('historical legacy');
    expect(() => createManifestV8Candidate({
      ...input, selection: { ...input.selection, profile: undefined }
    })).toThrow('only plain own-data JSON values');
    for (const profile of [null, 'unrecognized']) {
      expect(() => createManifestV8Candidate({ ...input, selection: { ...input.selection, profile } })).toThrow('explicit supported profile');
    }
  });

  it.each(['selection', 'activeLayout', 'managed', 'adoptionObservations'] as const)(
    'rejects %s accessors and proxies without invoking caller hooks', field => {
      const input = request();
      const getter = vi.fn(() => input[field]);
      const accessor = { ...input };
      Object.defineProperty(accessor, field, { get: getter, enumerable: true });
      expect(() => createManifestV8Candidate(accessor)).toThrow('own enumerable data field');
      expect(getter).not.toHaveBeenCalled();
      const trap = vi.fn(() => { throw new Error('Caller proxy trap executed'); });
      const proxy = new Proxy(input[field], { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
      expect(() => createManifestV8Candidate({ ...input, [field]: proxy })).toThrow('proxies');
      expect(trap).not.toHaveBeenCalled();
    });

  it('rejects a root proxy and nested observation getters before executing their hooks', () => {
    const input = request();
    const trap = vi.fn(() => { throw new Error('Root proxy trap executed'); });
    expect(() => createManifestV8Candidate(new Proxy(input, {
      get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap
    }))).toThrow('proxy');
    expect(trap).not.toHaveBeenCalled();
    const getter = vi.fn(() => ['README.md']);
    const first = { ...input.adoptionObservations[0] };
    Object.defineProperty(first, 'pathParts', { get: getter, enumerable: true });
    expect(() => createManifestV8Candidate({
      ...input, adoptionObservations: [first, input.adoptionObservations[1]]
    })).toThrow('own enumerable data fields');
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects sparse or extra-property observations and cyclic or oversized copied values', () => {
    const input = request();
    const sparse = new Array(2);
    sparse[1] = input.adoptionObservations[1];
    const extra = [...input.adoptionObservations];
    Object.assign(extra, { authority: true });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const adoptionObservations of [sparse, extra, [cyclic], [{
      ...input.adoptionObservations[0], observedHash: 'x'.repeat(8 * 1024 * 1024)
    }]]) expect(() => createManifestV8Candidate({ ...input, adoptionObservations })).toThrow();
  });

  it('leaves actual existing files, modes and directory membership untouched and creates no manifest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'liftoff-adopt-writer-'));
    try {
      const content = Buffer.from('Existing customized application\r\n', 'utf8');
      const filename = path.join(root, 'README.md');
      await writeFile(filename, content, { mode: 0o640 });
      const before = await stat(filename);
      const members = await readdir(root);
      const input = request();
      const observations = input.adoptionObservations.map(entry => entry.logicalName === 'root-readme'
        ? { ...entry, observedHash: sha(content) } : entry);
      const clock = vi.spyOn(Date, 'now');
      const random = vi.spyOn(Math, 'random');
      try {
        const candidate = createManifestV8Candidate({ ...input, adoptionObservations: observations });
        expect(candidate.manifest.adoptionObservations.find(entry => entry.logicalName === 'root-readme')?.observedHash).toBe(sha(content));
        expect(clock).not.toHaveBeenCalled();
        expect(random).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
        random.mockRestore();
      }
      expect(await readFile(filename)).toEqual(content);
      const after = await stat(filename);
      expect({ mode: after.mode, ino: after.ino, dev: after.dev, mtimeMs: after.mtimeMs })
        .toEqual({ mode: before.mode, ino: before.ino, dev: before.dev, mtimeMs: before.mtimeMs });
      expect(await readdir(root)).toEqual(members);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
