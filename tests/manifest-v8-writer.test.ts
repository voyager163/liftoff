import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createManifestV8Candidate, type ManifestV8Candidate, type ManifestV8WriteRequest, type ManagedManifestDecision
} from '../src/application/project/manifest-writer.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { parseManifest, resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { composeModernManifestPlugins } from '../src/application/project/plugins.js';
import { createManifestV8ProjectReader, type ManifestV8ProjectLeaf } from '../src/domain/project/manifest/v8-project.js';
import { createManifestV8Reader } from '../src/domain/project/manifest/v8.js';
import { createManifestHistoryIndex, encodeManifestHistoryIndex } from '../src/domain/project/manifest/history.js';
import { canonicalJson } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraphJson } from '../src/domain/governance/activation/graph.js';
import { modernActivationSourceContracts } from '../src/domain/governance/policy/identity.js';
import { isRetiredManagedCoreLogicalName, retiredManagedCoreIdentities } from '../src/domain/project/artifact-lifecycle.js';
import { toSafeProjectName } from '../src/domain/project/planning.js';
import type { GeneratedArtifact } from '../src/domain/project/contracts.js';
import { liftoffVersion } from '../src/version.js';

const profiles = ['none', 'single-maintainer-gitflow', 'team-gitflow'] as const;
const workflows = ['openspec', 'spec-kit', 'manual'] as const;
const sha = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const rootReader = createManifestV8Reader({ catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract });
const leafReader = createManifestV8ProjectReader(projectCatalog);
const historyPath = (name: string) => `tests/fixtures/contract-baseline-0.12.3/manifests/${name}-standard-go.json`;
const historyRaw = (name: string): unknown => JSON.parse(readFileSync(historyPath(name), 'utf8'));
const retained = (candidate: ManifestV8Candidate): ManagedManifestDecision[] =>
  candidate.manifest.managedArtifacts.map(({ logicalName }) => ({ kind: 'retain', logicalName }));

function selection(
  profile: (typeof profiles)[number] = 'single-maintainer-gitflow',
  workflow: (typeof workflows)[number] = 'openspec',
  agents = ['github-copilot']
) {
  const leaf = leafReader.validateManifestV8Project({
    project: {
      name: 'Writer Candidate',
      workload: { kind: 'standard', apiStack: 'node-fastify', cloud: 'azure', region: 'eastus', frontend: true, environments: ['prod', 'dev'] },
      specWorkflow: workflow, agents,
      ...(workflow === 'spec-kit' && agents.length ? { defaultAgent: agents.at(-1) } : {})
    },
    framework: workflow === 'manual' ? { state: 'not-required' } : {
      state: agents.length ? 'initialized' : 'legacy', adapter: workflow,
      ...(agents.length ? { contractVersion: projectCatalog.getFrameworkDefinition(workflow).version } : {})
    }
  });
  return { ...leaf, profile };
}

function suppliedArtifacts(leaf: ManifestV8ProjectLeaf, profile: (typeof profiles)[number]): GeneratedArtifact[] {
  const workload = leaf.project.workload;
  const composition = composeModernManifestPlugins({
    workload: workload.kind, ...(workload.kind === 'genai' ? { variant: workload.pattern } : {}),
    stack: workload.apiStack, cloud: workload.cloud, workflow: leaf.project.specWorkflow,
    agents: leaf.project.agents, frontend: workload.frontend ? 'included' : 'omitted',
    governanceProfile: profile, environments: workload.environments
  }, { safeProjectName: toSafeProjectName(leaf.project.name) });
  const row = modernActivationSourceContracts().find((source) =>
    source.identity.profile === profile && source.identity.workflow === leaf.project.specWorkflow);
  return composition.expected.filter((entry) => entry.lifecycle !== 'manifest').map((entry): GeneratedArtifact => {
    // Non-static content is an explicitly supplied byte specimen, not a modern renderer qualification.
    const content = entry.logicalName === 'repository-governance-policy' && row
      ? readFileSync(path.join(...row.policyPathParts), 'utf8')
      : entry.logicalName === 'repository-governance-phase-graph' && row
        ? canonicalJson(row.graph) : `Supplied bytes for ${entry.logicalName}\n`;
    const common = { logicalName: entry.logicalName, category: entry.category, pathParts: [...entry.pathParts], content };
    if (entry.lifecycle === 'project') {
      if (!entry.provisioningGroup) throw new Error('Expected actual project provisioning identity.');
      return { ...common, lifecycle: 'project', provisioningGroup: entry.provisioningGroup };
    }
    return { ...common, lifecycle: entry.lifecycle };
  });
}

function fresh(
  profile: (typeof profiles)[number] = 'single-maintainer-gitflow',
  workflow: (typeof workflows)[number] = 'openspec',
  agents = ['github-copilot']
) {
  const selected = selection(profile, workflow, agents);
  return { origin: 'fresh' as const, selection: selected, generatedArtifacts: suppliedArtifacts(selected, profile) };
}

function historical(name = '0.12.3', profile: 'none' | 'single-maintainer-gitflow' = 'single-maintainer-gitflow') {
  const raw = historyRaw(name), parsed = parseManifest(raw);
  const leaf = leafReader.validateManifestV8Project({ project: parsed.project, framework: parsed.framework });
  const supplied = suppliedArtifacts(leaf, profile);
  const decisions: ManagedManifestDecision[] = supplied.filter((entry) => entry.lifecycle === 'managed-core')
    .map(({ logicalName, category, pathParts, content }) => ({ kind: 'bytes', logicalName, category, pathParts, content }));
  for (const entry of parsed.managedArtifacts) {
    if (isRetiredManagedCoreLogicalName(entry.logicalName)) decisions.push({ kind: 'retire-alias', logicalName: entry.logicalName });
  }
  const original = readFileSync(historyPath(name));
  const index = createManifestHistoryIndex({ artifactVersion: parsed.artifactVersion, digest: sha(original), bytes: original.length, mode: 0o644 });
  return {
    origin: 'historical-successor' as const, source: raw, profile,
    activeLayout: { schemaVersion: 1 as const, state: 'unresolved' as const, bindings: [] as const },
    sourceManifestHistory: { schemaVersion: 1 as const, kind: 'manifest-history' as const, snapshotId: index.snapshotId, indexDigest: encodeManifestHistoryIndex(index).indexDigest },
    managed: decisions
  };
}

function replaceDecision(value: ReturnType<typeof historical>, name: string, replacement: ManagedManifestDecision): void {
  const index = value.managed.findIndex((entry) => entry.logicalName === name);
  if (index < 0) throw new Error(`Missing fixture decision ${name}.`);
  value.managed[index] = replacement;
}

describe('fresh origin produces exact complete bytes without publication', () => {
  it('exports the concrete candidate and three-origin request types', () => {
    expectTypeOf(createManifestV8Candidate).parameter(0).toEqualTypeOf<unknown>();
    expectTypeOf(createManifestV8Candidate).returns.toEqualTypeOf<ManifestV8Candidate>();
    expectTypeOf<ManifestV8WriteRequest['origin']>().toEqualTypeOf<'fresh' | 'historical-successor' | 'maintenance'>();
    expectTypeOf<keyof ManifestV8Candidate>().toEqualTypeOf<'manifest' | 'content' | 'digest'>();
  });

  it.each(profiles.flatMap((profile) => workflows.map((workflow) => ({ profile, workflow }))))(
    'constructs actual complete $profile/$workflow metadata for supplied byte inventories', ({ profile, workflow }) => {
      const subsets = workflow === 'manual' ? [[], ['github-copilot'], ['claude', 'codex']] :
        [['github-copilot'], ['claude'], ['github-copilot', 'claude', 'codex']];
      for (const agents of subsets) {
        const input = fresh(profile, workflow, agents), before = structuredClone(input);
        const candidate = createManifestV8Candidate(input);
        expect(input).toEqual(before);
        expect(candidate.manifest).toEqual(rootReader.parseManifestV8(JSON.parse(candidate.content)));
        expect(candidate.content).toBe(`${JSON.stringify(candidate.manifest, null, 2)}\n`);
        expect(candidate.digest).toBe(sha(Buffer.from(candidate.content, 'utf8')));
        expect(candidate.digest).toMatch(/^[a-f0-9]{64}$/);
        expect(candidate.manifest.liftoffVersion).toBe(liftoffVersion);
        expect(candidate.manifest).not.toHaveProperty('sourceManifestHistory');
        expect(candidate.manifest.adoptionObservations).toEqual([]);
        expect(candidate.manifest.project).toEqual(input.selection.project);
        expect(candidate.manifest.framework).toEqual(input.selection.framework);
        for (const entry of input.generatedArtifacts) {
          if (entry.lifecycle === 'managed-core') {
            expect(candidate.manifest.managedArtifacts.find((record) => record.logicalName === entry.logicalName)?.contentHash)
              .toBe(`sha256:${sha(entry.content)}`);
          } else if (entry.lifecycle === 'project') {
            expect(candidate.manifest.projectArtifacts.find((record) => record.logicalName === entry.logicalName)).toEqual({
              logicalName: entry.logicalName, category: entry.category, pathParts: entry.pathParts,
              generatedBy: liftoffVersion, generationHash: `sha256:${sha(entry.content)}`, provisioningGroup: entry.provisioningGroup
            });
          } else {
            expect(candidate.manifest.managedArtifacts.some((record) => record.logicalName === entry.logicalName)).toBe(false);
            expect(candidate.manifest.projectArtifacts.some((record) => record.logicalName === entry.logicalName)).toBe(false);
          }
        }
        expect(candidate.manifest.activeLayout.bindings).toHaveLength(candidate.manifest.projectArtifacts.length);
        expect(createManifestV8Candidate(input)).toEqual(candidate);
        expect(Object.isFrozen(candidate)).toBe(true);
        expect(Object.isFrozen(candidate.manifest)).toBe(true);
        expect(Object.isFrozen(input)).toBe(false);
      }
    });

  it('hashes supplied UTF-8 and newline bytes exactly and never adds telemetry/clock data', () => {
    const input = fresh('none', 'manual', []);
    const entry = input.generatedArtifacts.find((entry) => entry.logicalName === 'root-readme')!;
    const hashes = new Set<string>();
    const clock = vi.spyOn(Date, 'now');
    const random = vi.spyOn(Math, 'random');
    try {
      for (const content of ['Café Ω\n', 'Café Ω\r\n', 'Café Ω', '']) {
        entry.content = content;
        const candidate = createManifestV8Candidate(input);
        const record = candidate.manifest.projectArtifacts.find((record) => record.logicalName === entry.logicalName)!;
        expect(record.generationHash).toBe(`sha256:${sha(Buffer.from(content, 'utf8'))}`);
        hashes.add(record.generationHash);
        expect(candidate.manifest).not.toHaveProperty('telemetryId');
        expect(candidate.manifest).not.toHaveProperty('createdAt');
        expect(createManifestV8Candidate(input)).toEqual(candidate);
      }
      expect(clock).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      random.mockRestore();
    }
    expect(hashes.size).toBe(4);
  });

  it.each([
    ...['python-fastapi', 'node-fastify', 'go-huma'].map((apiStack) => ({ kind: 'standard', apiStack })),
    ...projectCatalog.patterns.map(({ id }) => ({ kind: 'genai', apiStack: 'python-fastapi', pattern: id }))
  ])('writes exact selected project provenance for $kind/$apiStack/$pattern', (identity) => {
    const base = selection('none', 'manual', []);
    const leaf = leafReader.validateManifestV8Project({
      project: { ...base.project, workload: { ...base.project.workload, ...identity } }, framework: base.framework
    });
    const input = {
      origin: 'fresh', selection: { ...leaf, profile: 'none' },
      generatedArtifacts: suppliedArtifacts(leaf, 'none')
    };
    const candidate = createManifestV8Candidate(input);
    expect(candidate.manifest.project.workload).toEqual(leaf.project.workload);
    expect(candidate.manifest.projectArtifacts.map((entry) => entry.logicalName)).toEqual(
      input.generatedArtifacts.filter((entry) => entry.lifecycle === 'project').map((entry) => entry.logicalName));
    expect(candidate.manifest.activeLayout.bindings).toHaveLength(candidate.manifest.projectArtifacts.length);
  });

  it.each(['logicalName', 'category', 'pathParts', 'lifecycle', 'provisioningGroup'])('rejects wrong generated %s rather than emitting metadata ownership', (field) => {
    const input = fresh();
    const artifact = input.generatedArtifacts.find((entry) => entry.lifecycle === 'project')!;
    Reflect.set(artifact, field, field === 'pathParts' ? ['foreign'] : 'wrong');
    expect(() => createManifestV8Candidate(input)).toThrow();
  });

  it('rejects missing, duplicate, extra and manifest-override artifacts', () => {
    const missing = fresh();
    missing.generatedArtifacts = missing.generatedArtifacts.filter((entry) => entry.logicalName !== 'root-readme');
    expect(() => createManifestV8Candidate(missing)).toThrow('missing-artifact');
    const duplicate = fresh();
    duplicate.generatedArtifacts[0] = duplicate.generatedArtifacts[1];
    expect(() => createManifestV8Candidate(duplicate)).toThrow('duplicate identity');
    const extra = fresh();
    extra.generatedArtifacts.push({ logicalName: 'unowned', category: 'project', lifecycle: 'project',
      pathParts: ['unowned'], provisioningGroup: 'base', content: 'bytes' });
    expect(() => createManifestV8Candidate(extra)).toThrow('finite entry limit');
    const override = fresh();
    override.generatedArtifacts[0] = { logicalName: 'manifest', category: 'manifest', lifecycle: 'manifest', pathParts: ['liftoff.manifest.json'], content: '{}' };
    expect(() => createManifestV8Candidate(override)).toThrow('manifest override');
    const legacy = selection('none', 'openspec', []);
    expect(() => createManifestV8Candidate({ origin: 'fresh', selection: legacy, generatedArtifacts: [] })).toThrow('historical legacy');
  });

  it.each(['repository-governance-policy', 'repository-governance-phase-graph'])('rejects old static %s bytes in a fresh modern handoff', (logicalName) => {
    const input = fresh();
    input.generatedArtifacts.find((entry) => entry.logicalName === logicalName)!.content = logicalName.endsWith('policy')
      ? readFileSync('assets/governance/single-maintainer-gitflow/policy.md', 'utf8') : canonicalPhaseGraphJson;
    expect(() => createManifestV8Candidate(input)).toThrow(`${logicalName} bytes or retained hash`);
  });
});

describe('historical successor preserves original source identity and provenance', () => {
  it.each(['0.3.4', '0.4.1', '0.7.0', '0.8.0', '0.9.9', '0.10.0', '0.11.3', '0.12.3'])(
    'preserves authentic original %s source data without recapturing source history', (version) => {
      const input = historical(version), before = structuredClone(input), parsed = parseManifest(input.source);
      const candidate = createManifestV8Candidate(input);
      expect(input).toEqual(before);
      expect(candidate.manifest.project).toEqual(parsed.project);
      expect(candidate.manifest.framework).toEqual(parsed.framework);
      expect(candidate.manifest.projectArtifacts).toEqual(parsed.projectArtifacts);
      expect(candidate.manifest.sourceManifestHistory).toEqual(input.sourceManifestHistory);
      expect(candidate.manifest.sourceManifestHistory).not.toBe(input.sourceManifestHistory);
      expect(candidate.manifest.activeLayout).toEqual(input.activeLayout);
      expect(candidate.manifest.adoptionObservations).toEqual([]);
      expect(candidate.manifest.liftoffVersion).toBe(liftoffVersion);
      expect(candidate.manifest.managedArtifacts.some((entry) => isRetiredManagedCoreLogicalName(entry.logicalName))).toBe(false);
      if (version === '0.3.4') {
        expect(candidate.manifest.framework.state).toBe('legacy');
        expect(candidate.manifest.project.agents).toEqual([]);
        expect(candidate.manifest.project).not.toHaveProperty('defaultAgent');
      }
    });

  it('requires explicit resolution of old unspecified governance while preserving explicit none or single', () => {
    const old = historical('0.3.4', 'none');
    expect(createManifestV8Candidate(old).manifest.governance).toEqual({ profile: 'none', state: 'disabled' });
    const current = historical('0.12.3');
    Reflect.set(current, 'profile', 'none');
    expect(() => createManifestV8Candidate(current)).toThrow('cannot switch profile');
    for (const profile of ['team-gitflow', undefined, null]) {
      expect(() => createManifestV8Candidate({ ...old, profile })).toThrow('cannot switch profile');
    }
    const raw = historyRaw('0.12.3');
    if (typeof raw !== 'object' || raw === null) throw new Error('Expected fixture object.');
    Reflect.set(raw, 'governance', { profile: 'none', state: 'disabled' });
    Reflect.set(raw, 'managedArtifacts', []);
    const result = createManifestV8Candidate({ ...old, source: raw, profile: 'none', managed: [] });
    expect(result.manifest.governance).toEqual({ profile: 'none', state: 'disabled' });
  });

  it('requires original JSON rather than normalized v2 and cannot change history origin by omission', () => {
    const input = historical('0.3.4');
    expect(() => createManifestV8Candidate({ ...input, source: parseManifest(input.source) })).toThrow();
    const missing = { ...input };
    Reflect.deleteProperty(missing, 'sourceManifestHistory');
    expect(() => createManifestV8Candidate(missing)).toThrow('required fields');
    for (const sourceManifestHistory of [undefined, null, { ...input.sourceManifestHistory, verified: true }]) {
      expect(() => createManifestV8Candidate({ ...input, sourceManifestHistory })).toThrow();
    }
    const reference = { ...input.sourceManifestHistory, kind: 'activation-history' };
    expect(createManifestV8Candidate({ ...input, sourceManifestHistory: reference }).manifest.sourceManifestHistory).toEqual(reference);
  });

  it.each(['repository-governance-policy', 'repository-governance-phase-graph'])('rejects historical %s retained-hash laundering', (logicalName) => {
    const input = historical();
    replaceDecision(input, logicalName, { kind: 'retain', logicalName });
    expect(() => createManifestV8Candidate(input)).toThrow(`${logicalName} bytes or retained hash`);
  });

  it('retains exact source hashes for eligible non-static core and supports genuinely partial handoff', () => {
    const input = historical('0.12.3'), source = parseManifest(input.source);
    const name = 'repository-governance-guide';
    replaceDecision(input, name, { kind: 'retain', logicalName: name });
    expect(createManifestV8Candidate(input).manifest.managedArtifacts.find((entry) => entry.logicalName === name))
      .toEqual(source.managedArtifacts.find((entry) => entry.logicalName === name));
    const old = historical('0.3.4');
    old.managed = old.managed.filter((entry) => entry.logicalName !== 'repository-governance-guide');
    expect(createManifestV8Candidate(old).manifest.governance.state).toBe('handoff-partial');
  });

  it('requires every old managed identity and refuses unsupported retain or generic retirement', () => {
    const input = historical();
    input.managed = input.managed.filter((entry) => entry.logicalName !== 'repository-governance-context');
    expect(() => createManifestV8Candidate(input)).toThrow('requires an explicit disposition');
    const unowned = historical();
    unowned.managed.push({ kind: 'retain', logicalName: 'unowned' });
    expect(() => createManifestV8Candidate(unowned)).toThrow('existing source managed identity');
    const retired = historical('0.9.9');
    const alias = retiredManagedCoreIdentities[0].logicalName;
    replaceDecision(retired, alias, { kind: 'retain', logicalName: alias });
    expect(() => createManifestV8Candidate(retired)).toThrow('exact applicable target declaration');
    const notAlias = historical();
    replaceDecision(notAlias, 'repository-governance-guide', { kind: 'retire-alias', logicalName: 'repository-governance-guide' });
    expect(() => createManifestV8Candidate(notAlias)).toThrow('Only an exact existing historical setup alias');
    const invalidAlias = historical('0.9.9');
    invalidAlias.managed.push({ kind: 'retire-alias', logicalName: 'repository-governance-unknown-launcher' });
    expect(() => createManifestV8Candidate(invalidAlias)).toThrow('Only an exact existing historical setup alias');
  });

  it('does not infer bindings from historical generation paths', () => {
    const input = historical();
    const custom = {
      schemaVersion: 1, state: 'bound', bindings: [
        { kind: 'artifact', logicalName: 'go-backend-main', pathParts: ['Custom Source', 'main.go'] }
      ]
    };
    const candidate = createManifestV8Candidate({ ...input, activeLayout: custom });
    expect(candidate.manifest.activeLayout).toEqual(custom);
    expect(candidate.manifest.projectArtifacts).toEqual(parseManifest(input.source).projectArtifacts);
  });
});

describe('historical layout intake precedes digest calculation', () => {
  const paths = [
    'schemaVersion', 'state', 'bindings', 'binding-kind', 'binding-logicalName',
    'binding-pathParts', 'binding-index', 'path-index', 'binding-map', 'path-map'
  ];

  it.each((['single-maintainer-gitflow', 'none'] as const).flatMap((profile) =>
    paths.map((location) => ({ profile, location }))
  ))('rejects $profile layout accessor at $location without invoking it', ({ profile, location }) => {
    const input = historical('0.3.4', profile);
    const layout = {
      schemaVersion: 1, state: 'bound',
      bindings: [{ kind: 'artifact', logicalName: 'go-backend-main', pathParts: ['Custom Source', 'main.go'] }]
    };
    let object: object = layout;
    let property = location;
    if (location === 'binding-index' || location === 'binding-map') {
      object = layout.bindings;
      property = location === 'binding-index' ? '0' : 'map';
    } else if (location === 'path-index' || location === 'path-map') {
      object = layout.bindings[0].pathParts;
      property = location === 'path-index' ? '0' : 'map';
    } else if (location.startsWith('binding-')) {
      object = layout.bindings[0];
      property = location.slice('binding-'.length);
    }
    const hook = vi.fn(() => { throw new Error('Historical layout hook was invoked before validation.'); });
    Object.defineProperty(object, property, { enumerable: property !== 'map', configurable: true, get: hook });
    expect(() => createManifestV8Candidate({ ...input, activeLayout: layout })).toThrow();
    expect(hook).not.toHaveBeenCalled();
  });

  it.each(['single-maintainer-gitflow', 'none'] as const)('preserves valid %s layout data and uncertainty without mutating the caller', (profile) => {
    const input = historical('0.3.4', profile);
    const bound = {
      schemaVersion: 1, state: 'bound',
      bindings: [{ kind: 'artifact', logicalName: 'go-backend-main', pathParts: ['Custom Source', 'main.go'] }]
    };
    for (const activeLayout of [bound, input.activeLayout]) {
      const before = structuredClone(activeLayout);
      const candidate = createManifestV8Candidate({ ...input, activeLayout });
      expect(candidate.manifest.activeLayout).toEqual(before);
      expect(activeLayout).toEqual(before);
      expect(Object.isFrozen(activeLayout)).toBe(false);
      expect(Object.isFrozen(candidate.manifest.activeLayout)).toBe(true);
    }
  });
});

describe('same-contract maintenance has no origin overrides', () => {
  it.each(['manifest-history', 'activation-history', undefined])('preserves original %s reference or its absence', (kind) => {
    const initial = createManifestV8Candidate(fresh('team-gitflow', 'manual', ['codex']));
    const source = structuredClone(initial.manifest);
    if (kind) Reflect.set(source, 'sourceManifestHistory', { schemaVersion: 1, kind, snapshotId: 'a'.repeat(64), indexDigest: 'b'.repeat(64) });
    const before = structuredClone(source);
    const candidate = createManifestV8Candidate({ origin: 'maintenance', source, managed: retained(initial) });
    expect(source).toEqual(before);
    expect(candidate.manifest.project).toEqual(source.project);
    expect(candidate.manifest.framework).toEqual(source.framework);
    expect(candidate.manifest.projectArtifacts).toEqual(source.projectArtifacts);
    expect(candidate.manifest.adoptionObservations).toEqual(source.adoptionObservations);
    expect(candidate.manifest.activeLayout).toEqual(source.activeLayout);
    expect(candidate.manifest.sourceManifestHistory).toEqual(source.sourceManifestHistory);
    expect(Object.hasOwn(candidate.manifest, 'sourceManifestHistory')).toBe(Boolean(kind));
    expect(candidate.manifest.governance).toEqual(source.governance);
  });

  it('preserves actual current observations and original writer provenance while updating only final writer metadata', () => {
    const initial = createManifestV8Candidate(fresh('none', 'manual', []));
    const source = structuredClone(initial.manifest);
    Reflect.set(source, 'liftoffVersion', '0.1.0');
    Reflect.set(source, 'adoptionObservations', [{ logicalName: 'root-readme', pathParts: ['Earlier', 'README.md'], observedHash: `sha256:${sha('observed')}` }]);
    const output = createManifestV8Candidate({ origin: 'maintenance', source, managed: [] });
    expect(output.manifest.liftoffVersion).toBe(liftoffVersion);
    expect(output.manifest.projectArtifacts).toEqual(source.projectArtifacts);
    expect(output.manifest.adoptionObservations).toEqual(source.adoptionObservations);
    expect(output.manifest.activeLayout).toEqual(source.activeLayout);
  });

  it.each(['repository-governance-policy', 'repository-governance-phase-graph'])('rejects a structurally valid modern source with old %s retain hash', (logicalName) => {
    const initial = createManifestV8Candidate(fresh());
    const source = structuredClone(initial.manifest);
    const old = parseManifest(historyRaw('0.12.3')).managedArtifacts.find((entry) => entry.logicalName === logicalName)!;
    Reflect.set(source.managedArtifacts.find((entry) => entry.logicalName === logicalName)!, 'contentHash', old.contentHash);
    expect(() => rootReader.parseManifestV8(source)).not.toThrow();
    expect(() => createManifestV8Candidate({ origin: 'maintenance', source, managed: retained(initial) }))
      .toThrow(`${logicalName} bytes or retained hash`);
  });

  it.each(['project', 'framework', 'profile', 'plugins', 'activeLayout', 'sourceManifestHistory', 'projectArtifacts', 'adoptionObservations'])(
    'rejects %s override rather than generic fresh plus overwrite', (field) => {
      const initial = createManifestV8Candidate(fresh());
      expect(() => createManifestV8Candidate({
        origin: 'maintenance', source: initial.manifest, managed: retained(initial), [field]: {}
      })).toThrow('required fields');
    });

  it('rejects changed policy/plugin/layout/selection identities and a historical source under maintenance', () => {
    const initial = createManifestV8Candidate(fresh());
    const source = structuredClone(initial.manifest);
    Reflect.set(source.plugins, 'resolutionDigest', `sha256:${'0'.repeat(64)}`);
    expect(() => createManifestV8Candidate({ origin: 'maintenance', source, managed: retained(initial) })).toThrow();
    expect(() => createManifestV8Candidate({ origin: 'maintenance', source: historyRaw('0.12.3'), managed: [] })).toThrow();
    const layout = structuredClone(initial.manifest);
    Reflect.set(layout, 'activeLayout', { schemaVersion: 1, state: 'unresolved', bindings: [] });
    expect(() => createManifestV8Candidate({ origin: 'maintenance', source: layout, managed: retained(initial) })).toThrow('independently supplied context');
    const selection = structuredClone(initial.manifest);
    Reflect.set(selection.project, 'name', 'Different source');
    expect(() => createManifestV8Candidate({ origin: 'maintenance', source: selection, managed: retained(initial) })).toThrow('independently supplied context');
    expect(() => createManifestV8Candidate({
      origin: 'maintenance', source: initial.manifest, managed: [{ kind: 'retire-alias', logicalName: 'repository-governance-policy' }]
    })).toThrow('Only an exact existing historical setup alias');
  });
});

describe('bounded own-data writer intake', () => {
  it.each([undefined, null, {}, [], { origin: 'automatic' }, { origin: 'fresh', source: {} }].map((input) => ({ input })))(
    'rejects missing or unknown origin/input %#', ({ input }) => {
      expect(() => createManifestV8Candidate(input)).toThrow();
    });

  it('rejects missing, duplicate, unknown and acquired-path managed decisions', () => {
    const input = historical();
    input.managed.push(input.managed[0]);
    expect(() => createManifestV8Candidate(input)).toThrow('duplicate identity');
    const invalid = historical();
    Reflect.set(invalid.managed[0], 'kind', 'delete');
    expect(() => createManifestV8Candidate(invalid)).toThrow();
    const moved = historical();
    Reflect.set(moved.managed[0], 'pathParts', ['new-location']);
    expect(() => createManifestV8Candidate(moved)).toThrow('exact target declaration');
    const hashOnly = historical();
    Reflect.set(hashOnly.managed[0], 'contentHash', `sha256:${'0'.repeat(64)}`);
    expect(() => createManifestV8Candidate(hashOnly)).toThrow('required fields');
    expect(() => createManifestV8Candidate({ ...historical(), force: true })).toThrow('required fields');
    expect(() => createManifestV8Candidate({ ...fresh(), liftoffVersion: '99.0.0' })).toThrow('required fields');
  });

  it('does not invoke getters/coercion/toJSON/iterators on request, artifacts or decisions', () => {
    const hook = vi.fn(() => { throw new Error('untrusted hook invoked'); });
    for (const field of ['origin', 'selection', 'generatedArtifacts']) {
      const input = fresh();
      Object.defineProperty(input, field, { enumerable: true, get: hook });
      expect(() => createManifestV8Candidate(input)).toThrow();
    }
    const input = fresh();
    Object.defineProperty(input.generatedArtifacts[0], 'content', { enumerable: true, get: hook });
    expect(() => createManifestV8Candidate(input)).toThrow('own enumerable data field');
    const history = historical();
    Object.defineProperty(history.managed[0], 'logicalName', { enumerable: true, get: hook });
    expect(() => createManifestV8Candidate(history)).toThrow('own enumerable data field');
    const sparse = historical();
    Reflect.deleteProperty(sparse.managed, '0');
    expect(() => createManifestV8Candidate(sparse)).toThrow();
    const extra = historical();
    Reflect.set(extra.managed, Symbol.iterator, hook);
    expect(() => createManifestV8Candidate(extra)).toThrow();
    const wrongContent = fresh();
    Reflect.set(wrongContent.generatedArtifacts[0], 'content', { toJSON: hook, [Symbol.toPrimitive]: hook });
    expect(() => createManifestV8Candidate(wrongContent)).toThrow('content must be a string');
    expect(hook).not.toHaveBeenCalled();
  });

  it('sanitizes historical JSON through bounded own data before the old parser sees it', () => {
    const input = historical('0.3.4');
    const hook = vi.fn(() => { throw new Error('historical hook invoked'); });
    if (typeof input.source !== 'object' || input.source === null) throw new Error('Expected source object.');
    Object.defineProperty(input.source, 'unknown-v2-metadata', { enumerable: true, get: hook });
    expect(() => createManifestV8Candidate(input)).toThrow('own enumerable data fields');
    const original = historyRaw('0.3.4');
    if (typeof original !== 'object' || original === null) throw new Error('Expected source object.');
    for (const source of [Object.create(original), { ...original, toJSON: hook },
      { ...original, nested: { [Symbol.iterator]: hook } }]) {
      expect(() => createManifestV8Candidate({ ...historical('0.3.4'), source })).toThrow();
    }
    expect(hook).not.toHaveBeenCalled();
    const cyclic: Record<string, unknown> = {};
    cyclic.nested = cyclic;
    expect(() => createManifestV8Candidate({ ...historical('0.3.4'), source: cyclic })).toThrow('bounded JSON depth');
  });

  it('preserves valid historical unknown own JSON fields without prototype mutation or coercion', () => {
    const input = historical('0.3.4');
    const source: unknown = JSON.parse(JSON.stringify(input.source).replace(/^\{/, '{"__proto__":{"polluted":true},"unknown":[null,false,-0],'));
    expect(createManifestV8Candidate({ ...input, source }).manifest.project).toEqual(parseManifest(input.source).project);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('enforces the exact source JSON 8 MiB bound without changing the historical reader contract', () => {
    const input = historical('0.3.4');
    if (typeof input.source !== 'object' || input.source === null) throw new Error('Expected source object.');
    Reflect.set(input.source, 'unknown-padding', '');
    const remaining = 8 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(input.source), 'utf8');
    Reflect.set(input.source, 'unknown-padding', 'x'.repeat(remaining));
    expect(Buffer.byteLength(JSON.stringify(input.source), 'utf8')).toBe(8 * 1024 * 1024);
    expect(() => createManifestV8Candidate(input)).not.toThrow();
    Reflect.set(input.source, 'unknown-padding', 'x'.repeat(remaining + 1));
    expect(() => createManifestV8Candidate(input)).toThrow('8 MiB JSON input bound');
  });

  it('rejects oversized artifact content before candidate serialization', () => {
    const input = fresh('none', 'manual', []);
    input.generatedArtifacts[0].content = 'x'.repeat(8 * 1024 * 1024 + 1);
    expect(() => createManifestV8Candidate(input)).toThrow('per-file or 32 MiB aggregate bound');
    for (const artifact of input.generatedArtifacts.slice(0, 5)) artifact.content = 'x'.repeat(8 * 1024 * 1024);
    expect(() => createManifestV8Candidate(input)).toThrow('per-file or 32 MiB aggregate bound');
  });
});
