import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { projectCatalog } from '../src/application/project/catalog.js';
import { parseManifest, resolveManifestV8SourceContract, resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { composeModernManifestPlugins } from '../src/application/project/plugins.js';
import { createModernActivationIdentityReader } from '../src/domain/governance/activation/modern-identity.js';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { canonicalJson } from '../src/domain/governance/activation/canonical-json.js';
import { createManifestV8ProjectReader } from '../src/domain/project/manifest/v8-project.js';
import { createManifestV8Reader, manifestV8ProvenanceMaximumEntries, type LiftoffManifestV8, type ManifestV8ReaderContext } from '../src/domain/project/manifest/v8.js';
import { manifestActiveLayoutDigest } from '../src/domain/project/manifest/layout.js';
import { readManifestPluginMetadata } from '../src/domain/project/manifest/plugins.js';
import { createManifestHistoryIndex, encodeManifestHistoryIndex } from '../src/domain/project/manifest/history.js';
import { retiredManagedCoreIdentities } from '../src/domain/project/artifact-lifecycle.js';
import { retiredFlatRootInfrastructureIdentities } from '../src/domain/project/infrastructure-layout.js';
import type { LiftoffManifest, HistoricalLiftoffManifest } from '../src/domain/project/contracts.js';
import type { PluginSelection } from '../src/plugins/contracts.js';
import { FileSystemError } from '../src/domain/project/errors.js';

const digest = (bytes: string | Uint8Array): `sha256:${string}` => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const context: ManifestV8ReaderContext = { catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract };
const { parseManifestV8 } = createManifestV8Reader(context);
const identityReader = createModernActivationIdentityReader(projectCatalog);
const leafReader = createManifestV8ProjectReader(projectCatalog);
const profiles = ['none', 'single-maintainer-gitflow', 'team-gitflow'] as const;
const workflows = ['openspec', 'spec-kit', 'manual'] as const;
const workloads: Array<{ kind: string; apiStack: string; pattern?: string }> = [
  ...['python-fastapi', 'node-fastify', 'go-huma'].map((apiStack) => ({ kind: 'standard', apiStack })),
  ...projectCatalog.patterns.map(({ id }) => ({ kind: 'genai', apiStack: 'python-fastapi', pattern: id }))
];
const agents = [
  [], ['github-copilot'], ['claude'], ['codex'], ['github-copilot', 'claude'],
  ['github-copilot', 'codex'], ['claude', 'codex'], ['github-copilot', 'claude', 'codex']
];

function rootFixture(
  profile: (typeof profiles)[number] = 'single-maintainer-gitflow',
  workflow: (typeof workflows)[number] = 'openspec',
  selectedAgents = ['github-copilot'],
  workload = workloads[1],
  activeLayout: unknown = { schemaVersion: 1, state: 'unresolved', bindings: [] }
) {
  const leaf = leafReader.validateManifestV8Project({
    project: {
      name: 'Root Contract', workload: { ...workload, cloud: 'azure', region: 'eastus', frontend: true, environments: ['prod', 'dev'] },
      specWorkflow: workflow, agents: selectedAgents,
      ...(workflow === 'spec-kit' && selectedAgents.length ? { defaultAgent: selectedAgents.at(-1) } : {})
    },
    framework: workflow === 'manual' ? { state: 'not-required' } : {
      state: selectedAgents.length ? 'initialized' : 'legacy', adapter: workflow,
      ...(selectedAgents.length ? { contractVersion: projectCatalog.getFrameworkDefinition(workflow).version } : {})
    }
  });
  const selection: PluginSelection = {
    workload: workload.kind, stack: workload.apiStack, ...(workload.pattern ? { variant: workload.pattern } : {}),
    cloud: 'azure', workflow, agents: selectedAgents, frontend: 'included',
    governanceProfile: profile, environments: ['prod', 'dev']
  };
  const composition = composeModernManifestPlugins(selection, { safeProjectName: 'root-contract' });
  const plugins = readManifestPluginMetadata({
    schemaVersion: 1, resolutionDigest: composition.resolution.digest, selections: composition.resolution.plugins
  }, { stack: workload.apiStack, cloud: 'azure', workflow, agents: selectedAgents });
  const source = resolveModernManifestV8SourceContract({ selection: { ...leaf, profile }, recordedPlugins: plugins });
  const activeLayoutDigest = manifestActiveLayoutDigest(activeLayout, source.layoutDescriptor);
  const governance = profile === 'none' ? { profile, state: 'disabled' } : (() => {
    if (!('identity' in source.governanceSource)) throw new Error('An enabled fixture needs an actual modern source.');
    const policyVersion = source.governanceSource.identity.policyVersion;
    return {
      profile, policyVersion, state: 'handoff-generated',
      activationIdentity: identityReader.identityForSource({
        sourceVersion: source.governanceSource.identity.liftoffVersion, profile, policyVersion,
        selection: { ...leaf, profile }, pluginResolutionDigest: plugins.resolutionDigest, activeLayoutDigest
      })
    };
  })();
  return structuredClone({
    artifactVersion: 8, generatedBy: 'Mission Control Liftoff', liftoffVersion: '0.13.0-dev.0',
    ...leaf, governance, plugins, activeLayout,
    // Recorded content hashes are fixture observations, not claims of a qualified modern renderer.
    managedArtifacts: source.managedArtifacts.map((entry) => ({
      ...entry, contentHash: digest(`Recorded fixture bytes for ${entry.logicalName}\n`)
    })),
    projectArtifacts: [],
    adoptionObservations: []
  });
}

function set(value: unknown, keys: readonly (string | number)[], replacement: unknown): void {
  let current = value;
  for (const key of keys.slice(0, -1)) {
    if (typeof current !== 'object' || current === null) throw new Error('Invalid fixture path.');
    current = Reflect.get(current, key);
  }
  if (typeof current !== 'object' || current === null) throw new Error('Invalid fixture destination.');
  Reflect.set(current, keys[keys.length - 1], replacement);
}

function get(value: unknown, keys: readonly (string | number)[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== 'object' || current === null) throw new Error('Invalid fixture path.');
    current = Reflect.get(current, key);
  }
  return current;
}

const generated = (logicalName = 'node-backend-server', pathParts = ['old', 'server.ts']) => ({
  logicalName, category: 'backend', pathParts, generatedBy: '0.12.3',
  generationHash: digest('Actual legacy fixture bytes\n'), provisioningGroup: 'base'
});
const adopted = (logicalName = 'node-backend-server', pathParts = ['original', 'entry.ts']) => ({
  logicalName, pathParts, observedHash: digest('Actual adopted fixture bytes\n')
});
const boundLayout = () => ({
  schemaVersion: 1, state: 'bound', bindings: [
    { kind: 'component', component: 'backend', pathParts: ['Services', 'API With Spaces'] },
    { kind: 'artifact', logicalName: 'node-backend-server', pathParts: ['Services', 'API With Spaces', 'main.ts'] }
  ]
});

describe('complete independent v8 source-root reader', () => {
  it('returns a complete readonly schema without widening historical public types or dispatch', () => {
    expectTypeOf(parseManifestV8).parameter(0).toEqualTypeOf<unknown>();
    expectTypeOf(parseManifestV8).returns.toEqualTypeOf<LiftoffManifestV8>();
    expectTypeOf<LiftoffManifest>().toEqualTypeOf<HistoricalLiftoffManifest>();
    expectTypeOf<LiftoffManifest['artifactVersion']>().toEqualTypeOf<2 | 3 | 4 | 5 | 6 | 7>();
    const root = rootFixture();
    expect(() => parseManifest(root)).toThrow('Unsupported manifest artifactVersion 8');
    expect(Object.keys(parseManifestV8(root)).sort()).toEqual([
      'activeLayout', 'adoptionObservations', 'artifactVersion', 'framework', 'generatedBy', 'governance',
      'liftoffVersion', 'managedArtifacts', 'plugins', 'project', 'projectArtifacts'
    ]);
  });

  it.each(workloads)('validates the whole real $kind/$apiStack/$pattern source for all profile/workflow variants', (workload) => {
    for (const profile of profiles) {
      for (const workflow of workflows) {
        for (const selectedAgents of [[], ['github-copilot', 'claude', 'codex']]) {
          const root = rootFixture(profile, workflow, selectedAgents, workload);
          const before = structuredClone(root);
          expect(parseManifestV8(root)).toEqual(before);
          expect(root).toEqual(before);
          expect(canonicalJson(parseManifestV8(root))).toBe(canonicalJson(parseManifestV8(root)));
        }
      }
    }
  });

  it.each(profiles.flatMap((profile) => workflows.map((workflow) => ({ profile, workflow }))))(
    'preserves every agent subset and actual partial layout under $profile/$workflow', ({ profile, workflow }) => {
      for (const selectedAgents of agents) {
        const root = rootFixture(profile, workflow, selectedAgents, workloads[1], boundLayout());
        const parsed = parseManifestV8(root);
        expect(parsed.project.agents).toEqual(selectedAgents);
        expect(parsed.activeLayout.state).toBe('bound');
        expect(parsed.activeLayout.bindings).toHaveLength(2);
        expect(parsed.projectArtifacts).toEqual([]);
        expect(parsed.adoptionObservations).toEqual([]);
        expect(parsed).not.toHaveProperty('complete');
        expect(parsed).not.toHaveProperty('executable');
        if (workflow === 'manual') {
          expect(parsed.framework).toEqual({ state: 'not-required' });
          expect(parsed.project).not.toHaveProperty('defaultAgent');
        } else if (!selectedAgents.length) {
          expect(parsed.framework).toEqual({ state: 'legacy', adapter: workflow });
        }
      }
    });

  it('preserves generation and adoption history independently of current or repurposed active paths', () => {
    const root = rootFixture('single-maintainer-gitflow', 'openspec', ['github-copilot'], workloads[1], boundLayout());
    const originalGeneration = generated();
    const observation = adopted();
    set(root, ['projectArtifacts'], [
      originalGeneration,
      generated('old-custom-entry', ['Services', 'API With Spaces', 'main.ts']),
      generated('past-doc', ['.liftoff', 'governance', 'policy.md']),
      ...retiredFlatRootInfrastructureIdentities.map((entry) => ({ ...generated(entry.logicalName, [...entry.pathParts]), category: entry.category }))
    ]);
    set(root, ['adoptionObservations'], [
      observation,
      adopted('root-readme', ['Services', 'API With Spaces', 'main.ts']),
      adopted('opentofu-main', ['infrastructure', 'opentofu', 'azure', 'main.tf'])
    ]);
    const parsed = parseManifestV8(root);
    expect(parsed.projectArtifacts).toEqual(root.projectArtifacts);
    expect(parsed.adoptionObservations).toEqual(root.adoptionObservations);
    expect(parsed.projectArtifacts[0]).toEqual(originalGeneration);
    expect(parsed.adoptionObservations[0]).toEqual(observation);
    expect(parsed.managedArtifacts.some((entry) => entry.logicalName === 'past-doc')).toBe(false);
    expect(parsed.activeLayout.bindings).toHaveLength(2);
  });

  it('allows same-identity generation/adoption observations without manufacturing generation for an adopted-only file', () => {
    const root = rootFixture();
    set(root, ['projectArtifacts'], [generated('root-readme', ['README.md'])]);
    set(root, ['adoptionObservations'], [adopted('root-readme', ['README.md']), adopted('node-backend-server', ['server.ts'])]);
    const parsed = parseManifestV8(root);
    expect(parsed.projectArtifacts).toHaveLength(1);
    expect(parsed.adoptionObservations).toHaveLength(2);
    for (const observation of parsed.adoptionObservations) {
      expect(Object.keys(observation).sort()).toEqual(['logicalName', 'observedHash', 'pathParts']);
      expect(observation).not.toHaveProperty('generationHash');
      expect(observation).not.toHaveProperty('generatedBy');
    }
  });

  it('treats both history reference kinds as syntax only and never infers fresh origin from absence', () => {
    const bytes = readFileSync('tests/fixtures/contract-baseline-0.12.3/manifests/0.12.3-standard-go.json');
    const history = createManifestHistoryIndex({
      artifactVersion: 7, digest: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, mode: 0o644
    });
    const encoded = encodeManifestHistoryIndex(history);
    for (const kind of ['manifest-history', 'activation-history']) {
      const reference = { schemaVersion: 1, kind, snapshotId: history.snapshotId, indexDigest: encoded.indexDigest };
      const root = { ...rootFixture(), sourceManifestHistory: reference };
      const parsed = parseManifestV8(root);
      expect(parsed.sourceManifestHistory).toEqual(reference);
      expect(parsed.sourceManifestHistory).not.toBe(reference);
      expect(Object.isFrozen(parsed.sourceManifestHistory)).toBe(true);
      expect(parsed.sourceManifestHistory).not.toHaveProperty('verified');
    }
    const absent = parseManifestV8(rootFixture('none'));
    expect(absent).not.toHaveProperty('sourceManifestHistory');
    expect(absent).not.toHaveProperty('fresh');
    expect(absent.governance).toEqual({ profile: 'none', state: 'disabled' });
  });

  it('requires the real handoff inventory for generated versus partial state', () => {
    const root = rootFixture();
    expect(() => parseManifestV8(root)).not.toThrow();
    root.managedArtifacts = root.managedArtifacts.filter((entry) => entry.logicalName !== 'repository-governance-guide');
    expect(() => parseManifestV8(root)).toThrow('handoff state');
    set(root, ['governance', 'state'], 'handoff-partial');
    expect(parseManifestV8(root).governance.state).toBe('handoff-partial');
    const noRepair = rootFixture();
    noRepair.managedArtifacts = noRepair.managedArtifacts.filter((entry) => entry.logicalName !== 'liftoff-repair-copilot');
    expect(parseManifestV8(noRepair).governance.state).toBe('handoff-generated');
    set(noRepair, ['governance', 'state'], 'handoff-partial');
    expect(() => parseManifestV8(noRepair)).toThrow('handoff state');
  });

  it('makes deeply immutable independent copies without freezing caller records', () => {
    const root = rootFixture('single-maintainer-gitflow', 'openspec', ['github-copilot'], workloads[1], boundLayout());
    set(root, ['projectArtifacts'], [generated()]);
    set(root, ['adoptionObservations'], [adopted()]);
    const before = structuredClone(root), parsed = parseManifestV8(root);
    const check = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const entry of Object.values(value)) check(entry);
    };
    check(parsed);
    expect(root).toEqual(before);
    expect(Object.isFrozen(root)).toBe(false);
    expect(Object.isFrozen(root.managedArtifacts[0].pathParts)).toBe(false);
    set(root, ['projectArtifacts', 0, 'generationHash'], digest('changed'));
    expect(parsed.projectArtifacts[0].generationHash).toBe(generated().generationHash);
  });
});

describe('complete source, activation and ownership relations fail closed', () => {
  it.each(['none', 'single-maintainer-gitflow', 'team-gitflow'])('rejects inapplicable managed ownership for %s', (profileValue) => {
    const profile = profiles.find((value) => value === profileValue)!;
    const root = rootFixture(profile, 'manual');
    root.managedArtifacts[0] = { ...root.managedArtifacts[0], logicalName: 'unknown-owned-file' };
    expect(() => parseManifestV8(root)).toThrow(/managed artifact/);
    const wrongCategory = rootFixture(profile);
    wrongCategory.managedArtifacts[0].category = 'project';
    expect(() => parseManifestV8(wrongCategory)).toThrow('exact applicable');
    const wrongPath = rootFixture(profile);
    Reflect.set(wrongPath.managedArtifacts[0], 'pathParts', ['unowned', 'moved.md']);
    expect(() => parseManifestV8(wrongPath)).toThrow('exact applicable');
    const retired = rootFixture(profile);
    retired.managedArtifacts[0] = { ...retiredManagedCoreIdentities[0], pathParts: [...retiredManagedCoreIdentities[0].pathParts], contentHash: digest('old') };
    Reflect.deleteProperty(retired.managedArtifacts[0], 'replacementLogicalName');
    expect(() => parseManifestV8(retired)).toThrow('exact applicable');
  });

  it('never admits a governance handoff under none, or unselected-agent ownership', () => {
    const none = rootFixture('none');
    const enabled = rootFixture();
    none.managedArtifacts[0] = enabled.managedArtifacts.find(entry => entry.logicalName === 'repository-governance-policy')!;
    expect(() => parseManifestV8(none)).toThrow('exact applicable');
    const otherAgents = rootFixture('single-maintainer-gitflow', 'openspec', ['claude']);
    enabled.managedArtifacts[0] = otherAgents.managedArtifacts.find((entry) => entry.logicalName === 'liftoff-setup-claude')!;
    expect(() => parseManifestV8(enabled)).toThrow('exact applicable');
  });

  it.each(['profile', 'policyVersion', 'workflow', 'policyDigest', 'phaseGraphHash', 'pluginResolutionDigest', 'activeLayoutDigest', 'sourceSelectionDigest',
    'liftoffVersion', 'activationContractVersion', 'phaseGraphSchemaVersion', 'activationStateSchemaVersion',
    'evidenceHeaderSchemaVersion', 'approvalEnvelopeSchemaVersion', 'credentialPolicySchemaVersion', 'supersessionSchemaVersion'])(
    'rejects a mixed or edited activation %s field', (field) => {
      const root = rootFixture();
      const current = get(root, ['governance', 'activationIdentity', field]);
      set(root, ['governance', 'activationIdentity', field], typeof current === 'number' ? current + 1 : 'tampered');
      expect(() => parseManifestV8(root)).toThrow();
    });

  it('rejects historical v3 identities and changed source context without retagging proof', () => {
    const root = rootFixture();
    set(root, ['governance', 'activationIdentity'], currentActivationIdentity);
    expect(() => parseManifestV8(root)).toThrow();
    for (const [path, value] of [
      [['project', 'name'], 'Changed name'],
      [['project', 'workload', 'region'], 'koreacentral'],
      [['project', 'workload', 'environments'], ['dev', 'prod']],
      [['framework', 'contractVersion'], '2.0.0']
    ] as const) {
      const changed = rootFixture();
      set(changed, path, value);
      expect(() => parseManifestV8(changed)).toThrow();
    }
    const changedLayout = rootFixture();
    set(changedLayout, ['activeLayout'], boundLayout());
    expect(() => parseManifestV8(changedLayout)).toThrow('independently supplied context');
    const badPolicy = rootFixture();
    set(badPolicy, ['governance', 'policyVersion'], '6');
    expect(() => parseManifestV8(badPolicy)).toThrow('policy/profile/workflow source');
    const kit = rootFixture('team-gitflow', 'spec-kit', ['github-copilot', 'claude']);
    set(kit, ['project', 'defaultAgent'], 'github-copilot');
    expect(() => parseManifestV8(kit)).toThrow('independently supplied context');
  });

  it('rejects wrong source resolution independently of syntactically recognizable plugin metadata', () => {
    const root = rootFixture();
    set(root, ['plugins', 'resolutionDigest'], digest('foreign'));
    expect(() => parseManifestV8(root)).toThrow('source contract');
    const changedRows = rootFixture();
    set(changedRows, ['plugins', 'selections', 0, 'contentVersion'], 9);
    expect(() => parseManifestV8(changedRows)).toThrow('source contract');
    const wrongResolver = createManifestV8Reader({
      catalog: projectCatalog,
      resolveSourceContract(input) {
        return { ...resolveModernManifestV8SourceContract(input), plugins: resolveManifestV8SourceContract(input).plugins };
      }
    });
    expect(() => wrongResolver.parseManifestV8(rootFixture())).toThrow('source contract');
  });

  it('rejects a trusted-context relation mismatch instead of returning an unchecked complete root', () => {
    const bad = createManifestV8Reader({
      catalog: projectCatalog,
      resolveSourceContract(input) {
        const actual = resolveModernManifestV8SourceContract(input);
        return { ...actual, plugins: { ...actual.plugins, resolutionDigest: digest('changed') } };
      }
    });
    expect(() => bad.parseManifestV8(rootFixture())).toThrow('complete resolved source contract');
    const none = createManifestV8Reader({
      catalog: projectCatalog,
      resolveSourceContract(input) {
        return { ...resolveModernManifestV8SourceContract(input), requiredHandoffLogicalNames: ['repository-governance-policy'] };
      }
    });
    expect(() => none.parseManifestV8(rootFixture('none'))).toThrow('no governance handoff');
  });

  it.each([
    { profile: 'unspecified', state: 'unspecified' },
    { profile: 'none', state: 'handoff-generated' },
    { profile: 'none', state: 'disabled', policyVersion: '7' },
    { profile: 'none', state: 'disabled', activationIdentity: {} },
    { profile: 'team-gitflow', state: 'enforced', policyVersion: '1', activationIdentity: {} }
  ])('rejects invalid governance envelope %j', (governance) => {
    expect(() => parseManifestV8({ ...rootFixture('none'), governance })).toThrow();
  });

  it('keeps current logical names out of generation/adoption provenance and denies invented adopted identities', () => {
    const root = rootFixture();
    set(root, ['projectArtifacts'], [generated('repository-governance-policy')]);
    expect(() => parseManifestV8(root)).toThrow('managed-core logical name');
    for (const logicalName of ['repository-governance-policy', 'repository-governance-copilot-launcher', 'invented-project-file']) {
      const observed = rootFixture();
      set(observed, ['adoptionObservations'], [adopted(logicalName)]);
      expect(() => parseManifestV8(observed)).toThrow('finite readable project identity');
    }
    const observation = rootFixture();
    set(observation, ['adoptionObservations'], [{ ...adopted(), generationHash: digest('invented'), generatedBy: '0.13.0-dev.0' }]);
    expect(() => parseManifestV8(observation)).toThrow('required fields');
  });

  it.each(['projectArtifacts', 'adoptionObservations'])('rejects duplicate, alias and file-prefix paths within %s only', (inventory) => {
    const entry = inventory === 'projectArtifacts' ? generated : adopted;
    for (const records of [
      [entry('root-readme', ['a']), entry('root-readme', ['b'])],
      [entry('root-readme', ['a']), entry('node-backend-server', ['A'])],
      [entry('root-readme', ['Dir', 'a']), entry('node-backend-server', ['dir', 'b'])],
      [entry('root-readme', ['a']), entry('node-backend-server', ['a', 'file'])]
    ]) {
      const root = rootFixture();
      set(root, [inventory], records);
      expect(() => parseManifestV8(root)).toThrow(/duplicate|alias|prefix/);
    }
  });

  it.each(['projectArtifacts', 'adoptionObservations'])('rejects unsafe %s paths without treating safe history as active ownership', (inventory) => {
    const entry = inventory === 'projectArtifacts' ? generated : adopted;
    for (const parts of [['..', 'file'], ['C:'], ['a\\b'], ['.g\u0131t', '..'], ['CON'], ['a '], ['cafe\u0301'], ['a'.repeat(256)]]) {
      const root = rootFixture();
      set(root, [inventory], [entry('root-readme', parts)]);
      expect(() => parseManifestV8(root)).toThrow();
    }
    const baseline = rootFixture();
    set(baseline, [inventory], [entry('root-readme', ['governance', 'activation-baseline.json'])]);
    expect(() => parseManifestV8(baseline)).toThrow('cannot be a manifest artifact');
  });

  it.each([
    [{ kind: 'artifact', logicalName: 'node-backend-server', pathParts: ['.liftoff', 'governance', 'policy.md'] }],
    [{ kind: 'component', component: 'backend', pathParts: ['.g\u0131t'] }],
    [{ kind: 'artifact', logicalName: 'opentofu-main', pathParts: ['historical', 'main.tf'] }],
    [
      { kind: 'artifact', logicalName: 'root-readme', pathParts: ['A'] },
      { kind: 'artifact', logicalName: 'node-backend-server', pathParts: ['a', 'entry.ts'] }
    ],
    [
      { kind: 'component', component: 'backend', pathParts: ['source'] },
      { kind: 'component', component: 'frontend', pathParts: ['source', 'ui'] }
    ]
  ].map((bindings) => ({ bindings })))('validates active binding authority/collisions independently of historical provenance %#', ({ bindings }) => {
    const root = rootFixture();
    set(root, ['activeLayout'], { schemaVersion: 1, state: 'bound', bindings });
    expect(() => parseManifestV8(root)).toThrow(/reserved|unknown or unselected|aliased|overlapping|prefix/);
  });

  it.each(['contentHash', 'generationHash', 'observedHash'])('rejects malformed %s without rewriting provenance', (field) => {
    const root = rootFixture();
    set(root, ['projectArtifacts'], [generated()]);
    set(root, ['adoptionObservations'], [adopted()]);
    const inventory = field === 'contentHash' ? 'managedArtifacts' : field === 'generationHash' ? 'projectArtifacts' : 'adoptionObservations';
    set(root, [inventory, 0, field], '0'.repeat(64));
    expect(() => parseManifestV8(root)).toThrow(/sha256-prefixed/);
    expect(get(root, [inventory, 0, field])).toBe('0'.repeat(64));
  });
});

describe('strict own-data intake and exact bounds', () => {
  it('preserves the exact 16384 provenance ceiling without borrowing operation/history budgets', () => {
    expect(manifestV8ProvenanceMaximumEntries).toBe(16_384);
    const root = rootFixture('none', 'manual', []);
    const records = Array.from({ length: 16_384 }, (_, index) => generated(`past-file-${index}`, ['past', `file-${index}`]));
    set(root, ['projectArtifacts'], records);
    const parsed = parseManifestV8(root);
    expect(parsed.projectArtifacts).toHaveLength(16_384);
    expect(parsed.projectArtifacts[16_383]).toEqual(records[16_383]);
    records.push(generated('one-too-many', ['one-too-many']));
    expect(() => parseManifestV8(root)).toThrow('finite entry limit of 16384');
  });

  it('applies adoption bound before contextual uniqueness and respects the smaller finite readable inventory', () => {
    const root = rootFixture('none', 'manual', []);
    set(root, ['adoptionObservations'], Array(16_384).fill(adopted('root-readme', ['README.md'])));
    expect(() => parseManifestV8(root)).toThrow('duplicate logical identity');
    set(root, ['adoptionObservations'], new Array(16_385));
    expect(() => parseManifestV8(root)).toThrow('finite entry limit of 16384');
    set(root, ['managedArtifacts'], new Array(1));
    expect(() => parseManifestV8(root)).toThrow('finite entry limit of 0');
  });

  it('rejects retired workload before governance/plugin/artifact getters or source resolution', () => {
    const resolveSourceContract = vi.fn(resolveModernManifestV8SourceContract);
    const reader = createManifestV8Reader({ ...context, resolveSourceContract });
    const hook = vi.fn(() => { throw new Error('untrusted getter'); });
    const root = { project: { workload: { kind: 'power-apps-code-app' } } };
    Object.defineProperty(root, 'governance', { enumerable: true, get: hook });
    expect(() => reader.parseManifestV8(root)).toThrow(/Power Apps.*retired/);
    expect(hook).not.toHaveBeenCalled();
    expect(resolveSourceContract).not.toHaveBeenCalled();
  });

  it.each(['latest', '0.13', 'v0.13.0', '01.0.0', '1.0.0-01', '', null, 1, undefined].map((value) => ({ value })))(
    'rejects a nonexact writer version %#', ({ value }) => {
      expect(() => parseManifestV8({ ...rootFixture(), liftoffVersion: value })).toThrow();
    });

  it.each([null, undefined, '8', 7, 9, 8.5].map((artifactVersion) => ({ artifactVersion })))(
    'rejects unsupported root version %#', ({ artifactVersion }) => {
      expect(() => parseManifestV8({ ...rootFixture(), artifactVersion })).toThrow('artifactVersion 8');
    });

  const nestedPaths: Array<{ label: string; path: (string | number)[] }> = [
    { label: 'root', path: [] },
    { label: 'project', path: ['project'] },
    { label: 'workload', path: ['project', 'workload'] },
    { label: 'framework', path: ['framework'] },
    { label: 'governance', path: ['governance'] },
    { label: 'activation identity', path: ['governance', 'activationIdentity'] },
    { label: 'plugins', path: ['plugins'] },
    { label: 'plugin row', path: ['plugins', 'selections', 0] },
    { label: 'layout', path: ['activeLayout'] },
    { label: 'binding', path: ['activeLayout', 'bindings', 0] },
    { label: 'managed', path: ['managedArtifacts', 0] },
    { label: 'generation', path: ['projectArtifacts', 0] },
    { label: 'adoption', path: ['adoptionObservations', 0] },
    { label: 'history reference', path: ['sourceManifestHistory'] }
  ];
  function specimen() {
    const root = rootFixture('single-maintainer-gitflow', 'openspec', ['github-copilot'], workloads[1], boundLayout());
    set(root, ['projectArtifacts'], [generated()]);
    set(root, ['adoptionObservations'], [adopted()]);
    return { ...root, sourceManifestHistory: { schemaVersion: 1, kind: 'manifest-history', snapshotId: 'a'.repeat(64), indexDigest: 'b'.repeat(64) } };
  }

  it.each(nestedPaths)('enforces closed own-data fields for $label without accessor evaluation', ({ path }) => {
    const root = specimen();
    const record = get(root, path);
    if (typeof record !== 'object' || record === null) throw new Error('Expected fixture object.');
    const hook = vi.fn(() => { throw new Error('getter invoked'); });
    Object.defineProperty(record, 'unknown', { enumerable: true, get: hook });
    expect(() => parseManifestV8(root)).toThrow();
    expect(hook).not.toHaveBeenCalled();
    const valid = get(specimen(), path);
    if (typeof valid !== 'object' || valid === null) throw new Error('Expected fixture object.');
    for (const field of Object.keys(valid)) {
      const fresh = specimen(), object = get(fresh, path);
      if (typeof object !== 'object' || object === null) throw new Error('Expected fixture object.');
      const getter = vi.fn(() => { throw new Error('field getter invoked'); });
      Object.defineProperty(object, field, { enumerable: true, get: getter });
      expect(() => parseManifestV8(fresh)).toThrow();
      expect(getter).not.toHaveBeenCalled();
    }
  });

  it.each(nestedPaths)('rejects null/array/inherited $label values rather than normalizing them', ({ path }) => {
    const original = get(specimen(), path);
    for (const value of [null, [], Object.create(typeof original === 'object' && original !== null ? original : null)]) {
      const root = specimen();
      if (path.length) {
        set(root, path, value);
        expect(() => parseManifestV8(root)).toThrow();
      } else expect(() => parseManifestV8(value)).toThrow();
    }
  });

  it.each([
    ['managedArtifacts'], ['projectArtifacts'], ['adoptionObservations'], ['activeLayout', 'bindings'],
    ['managedArtifacts', 0, 'pathParts'], ['projectArtifacts', 0, 'pathParts'], ['adoptionObservations', 0, 'pathParts'],
    ['activeLayout', 'bindings', 0, 'pathParts'], ['plugins', 'selections']
  ].map((path) => ({ path })))('rejects sparse/accessor/extra-property array at %j', ({ path }) => {
    for (const variant of ['sparse', 'getter', 'extra', 'symbol']) {
      const root = specimen();
      const value = get(root, path);
      if (!Array.isArray(value)) throw new Error('Expected fixture array.');
      const array = [...value], hook = vi.fn(() => { throw new Error('array hook invoked'); });
      if (variant === 'sparse') Reflect.deleteProperty(array, '0');
      if (variant === 'getter') Object.defineProperty(array, '0', { enumerable: true, get: hook });
      if (variant === 'extra') Object.defineProperty(array, 'extra', { enumerable: false, get: hook });
      if (variant === 'symbol') Reflect.set(array, Symbol.iterator, hook);
      set(root, path, array);
      expect(() => parseManifestV8(root)).toThrow();
      expect(hook).not.toHaveBeenCalled();
    }
  });

  it.each([null, undefined, { schemaVersion: 1, kind: 'manifest-history', snapshotId: `sha256:${'a'.repeat(64)}`, indexDigest: 'b'.repeat(64) },
    { schemaVersion: 1, kind: 'activation-history', snapshotId: 'a'.repeat(64), indexDigest: 'b'.repeat(64), pathParts: ['fake'] }].map((reference) => ({ reference })))(
    'rejects an invalid present history reference %# rather than dropping it', ({ reference }) => {
      expect(() => parseManifestV8({ ...rootFixture(), sourceManifestHistory: reference })).toThrow();
    });
});
