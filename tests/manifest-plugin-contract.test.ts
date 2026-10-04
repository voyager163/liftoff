import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildProjectPlan } from '../src/application/project/planning.js';
import {
  parseManifest, resolveInstalledManifestBindingContext, resolveManifestLayoutDescriptor
} from '../src/application/project/manifest.js';
import { composeProjectPlugins } from '../src/application/project/plugins.js';
import type { ProjectOptions } from '../src/domain/project/contracts.js';
import {
  readManifestPluginMetadata, manifestPluginMetadataMatches
} from '../src/domain/project/manifest/plugins.js';
import { FileSystemError } from '../src/domain/project/errors.js';

const digest = (character = 'a') => `sha256:${character.repeat(64)}`;
const expected = () => ({ stack: 'node-fastify', cloud: 'azure', workflow: 'openspec', agents: ['github-copilot'] });
// Synthetic syntax records, deliberately not a release identity or installed resolution witness.
const row = (category = 'stack', id = 'node-fastify') =>
  ({ category, id, apiVersion: 1, contentVersion: 1, contentDigest: digest() });
const metadata = () => ({
  schemaVersion: 1, resolutionDigest: digest('b'),
  selections: [row(), row('cloud', 'azure'), row('workflow', 'openspec'), row('agent', 'github-copilot')]
});
const plan = (options: ProjectOptions = {}) => buildProjectPlan({
  projectName: 'Plugin Manifest', projectType: 'standard', apiStack: 'node-fastify',
  agents: ['github-copilot'], environments: ['dev'], ...options
}, { requireProjectName: true });
const expectationFromPlan = (value: ReturnType<typeof plan>) => ({
  stack: value.apiStack.id, cloud: value.provider.id, workflow: value.specWorkflow.id,
  agents: value.agents.map((agent) => agent.id)
});
const subsets = [
  [], ['github-copilot'], ['claude'], ['codex'],
  ['github-copilot', 'claude'], ['github-copilot', 'codex'], ['claude', 'codex'],
  ['github-copilot', 'claude', 'codex']
];
const workloads: { name: string; options: ProjectOptions }[] = [
  ...['python-fastapi', 'node-fastify', 'go-huma'].map((apiStack) =>
    ({ name: apiStack, options: { projectType: 'standard', apiStack } })),
  ...['generic', 'rag', 'chatbot', 'agent', 'prompt', 'multi-agent', 'fine-tuned', 'streaming', 'workflow']
    .map((pattern) => ({ name: pattern, options: { projectType: 'genai', apiStack: 'python-fastapi', pattern } }))
];

describe('one installed plugin and layout binding context', () => {
  it.each(workloads)('projects actual installed $name combinations without changing selections', ({ options }) => {
    for (const specWorkflow of ['openspec', 'spec-kit']) {
      for (const governanceProfile of ['none', 'single-maintainer-gitflow']) {
        for (const [index, agents] of subsets.entries()) {
          const selected = plan({
            ...options, specWorkflow, governanceProfile, agents: agents.length ? [...agents] : ['github-copilot'],
            ...(specWorkflow === 'spec-kit' && agents.length ? { defaultAgent: agents[0] } : {}),
            includeFrontend: index % 2 === 0,
            environments: index % 3 === 0 ? ['dev', 'staging', 'prod'] : ['dev']
          });
          if (!agents.length) {
            selected.agents = [];
            selected.defaultAgent = undefined;
          }
          const before = structuredClone(selected);
          const composition = composeProjectPlugins(selected);
          const result = resolveInstalledManifestBindingContext(selected);
          expect(selected).toEqual(before);
          expect(result.plugins).toEqual({
            schemaVersion: 1,
            resolutionDigest: composition.resolution.digest,
            selections: composition.resolution.plugins
          });
          expect(result.plugins.selections).not.toBe(composition.resolution.plugins);
          expect(result.plugins).toEqual(readManifestPluginMetadata(result.plugins, expectationFromPlan(selected)));
          expect(result.layoutDescriptor).toEqual(resolveManifestLayoutDescriptor(selected));
          expect(result.layoutDescriptor.artifacts.map((artifact) => artifact.logicalName)).toEqual(
            composition.expected.filter((artifact) => artifact.lifecycle === 'project')
              .map((artifact) => artifact.logicalName).sort());
          expect(result.plugins.selections.filter((plugin) => plugin.category === 'agent').map((plugin) => plugin.id))
            .toEqual([...agents].sort());
          expect(selected.agents.map((agent) => agent.id)).toEqual(agents);
          expect(result).toEqual(resolveInstalledManifestBindingContext(selected));
          expect(Object.keys(result).sort()).toEqual(['layoutDescriptor', 'plugins']);
          expect(Object.isFrozen(result)).toBe(true);
          expect(Object.isFrozen(result.plugins)).toBe(true);
          expect(Object.isFrozen(result.plugins.selections)).toBe(true);
          expect(result.plugins.selections.every(Object.isFrozen)).toBe(true);
        }
      }
    }
  });

  it('preserves distinct source-agent and registry-row orders', () => {
    const selected = plan({ agents: ['github-copilot', 'claude', 'codex'] });
    const context = resolveInstalledManifestBindingContext(selected);
    expect(selected.agents.map((agent) => agent.id)).toEqual(['github-copilot', 'claude', 'codex']);
    expect(context.plugins.selections.map(({ category, id }) => [category, id])).toEqual([
      ['stack', 'node-fastify'], ['cloud', 'azure'], ['workflow', 'openspec'],
      ['agent', 'claude'], ['agent', 'codex'], ['agent', 'github-copilot']
    ]);
    const expectation = expectationFromPlan(selected);
    const original = structuredClone(expectation);
    expect(readManifestPluginMetadata(context.plugins, expectation)).toEqual(context.plugins);
    expect(expectation).toEqual(original);
  });

  it('does not initialize composition during import, syntax recognition or historical reading', async () => {
    vi.resetModules();
    const selected = plan();
    const realComposition = composeProjectPlugins(selected);
    const compose = vi.fn(() => realComposition);
    vi.doMock('../src/application/project/plugins.js', () => ({ composeProjectPlugins: compose }));
    try {
      const application = await import('../src/application/project/manifest.js');
      const domain = await import('../src/domain/project/manifest/plugins.js');
      expect(compose).not.toHaveBeenCalled();
      expect(domain.readManifestPluginMetadata(metadata(), expected()).selections).toHaveLength(4);
      for (const name of ['0.3.4', '0.8.0', '0.9.9', '0.10.0', '0.12.3']) {
        const raw: unknown = JSON.parse(readFileSync(
          new URL(`./fixtures/contract-baseline-0.12.3/manifests/${name}-standard-go.json`, import.meta.url), 'utf8'));
        const parsed = application.parseManifest(raw);
        expect(parsed).toEqual(parseManifest(raw));
        expect(parsed).not.toHaveProperty('plugins');
        expect(parsed).not.toHaveProperty('activeLayout');
        expect(parsed).not.toHaveProperty('sourceManifestHistory');
      }
      expect(compose).not.toHaveBeenCalled();
      const context = application.resolveInstalledManifestBindingContext(selected);
      expect(compose).toHaveBeenCalledTimes(1);
      expect(context.plugins.resolutionDigest).toBe(realComposition.resolution.digest);
      compose.mockClear();
      expect(application.resolveManifestLayoutDescriptor(selected)).toEqual(context.layoutDescriptor);
      expect(compose).toHaveBeenCalledTimes(1);
      const failure = new Error('exact installed composition failure');
      compose.mockImplementation(() => { throw failure; });
      expect(() => application.resolveInstalledManifestBindingContext(selected)).toThrow(failure);
      expect(() => application.resolveManifestLayoutDescriptor(selected)).toThrow(failure);
    } finally {
      vi.doUnmock('../src/application/project/plugins.js');
      vi.resetModules();
    }
  });

  it('keeps v8 and fabricated Manual/team targets out of historical entrypoints', () => {
    const raw = JSON.parse(readFileSync(
      new URL('./fixtures/contract-baseline-0.12.3/manifests/0.12.3-standard-go.json', import.meta.url), 'utf8'));
    raw.artifactVersion = 8;
    expect(() => parseManifest(raw)).toThrow('Unsupported manifest artifactVersion 8');
    const manual = structuredClone(plan());
    Reflect.set(manual.specWorkflow, 'id', 'manual');
    Reflect.set(manual.framework, 'id', 'manual');
    expect(() => resolveInstalledManifestBindingContext(manual)).toThrow(/does not match/i);
    const team = structuredClone(plan());
    Reflect.set(team.governanceProfile, 'id', 'team-gitflow');
    expect(() => resolveInstalledManifestBindingContext(team)).toThrow(/unknown|unsupported|invalid/i);
  });
});

describe('recognition is not installed release verification', () => {
  it('recognizes positive future API/content versions and foreign digests without claiming a match', () => {
    const selected = plan();
    const installed = resolveInstalledManifestBindingContext(selected).plugins;
    const foreign = structuredClone(installed);
    Reflect.set(foreign.selections[0], 'apiVersion', Number.MAX_SAFE_INTEGER);
    Reflect.set(foreign.selections[0], 'contentVersion', Number.MAX_SAFE_INTEGER);
    Reflect.set(foreign.selections[0], 'contentDigest', digest('c'));
    Reflect.set(foreign, 'resolutionDigest', digest('d'));
    const recognized = readManifestPluginMetadata(foreign, expectationFromPlan(selected));
    expect(recognized).toEqual(foreign);
    expect(manifestPluginMetadataMatches(recognized, installed)).toBe(false);
    expect(Object.keys(recognized).sort()).toEqual(['resolutionDigest', 'schemaVersion', 'selections']);
    expect(recognized).not.toHaveProperty('verified');
    expect(recognized).not.toHaveProperty('executable');
  });

  it('compares all fields rather than trusting a copied resolution digest', () => {
    const selected = plan();
    const installed = resolveInstalledManifestBindingContext(selected).plugins;
    expect(manifestPluginMetadataMatches(installed, readManifestPluginMetadata(installed, expectationFromPlan(selected)))).toBe(true);
    for (const [field, value] of [
      ['apiVersion', 2], ['contentVersion', 2], ['contentDigest', digest('e')]
    ] as const) {
      const changed = structuredClone(installed);
      Reflect.set(changed.selections[0], field, value);
      const recognized = readManifestPluginMetadata(changed, expectationFromPlan(selected));
      expect(recognized.resolutionDigest).toBe(installed.resolutionDigest);
      expect(manifestPluginMetadataMatches(recognized, installed), field).toBe(false);
      expect(manifestPluginMetadataMatches(installed, recognized), field).toBe(false);
    }
    const changedStack = structuredClone(installed);
    Reflect.set(changedStack.selections[0], 'id', 'go-huma');
    expect(manifestPluginMetadataMatches(readManifestPluginMetadata(changedStack, {
      ...expected(), stack: 'go-huma'
    }), installed)).toBe(false);
    const noAgents = readManifestPluginMetadata({
      ...installed, selections: installed.selections.filter((plugin) => plugin.category !== 'agent')
    }, { ...expected(), agents: [] });
    expect(manifestPluginMetadataMatches(noAgents, installed)).toBe(false);
    const manual = structuredClone(installed);
    Reflect.set(manual.selections[2], 'id', 'manual');
    expect(manifestPluginMetadataMatches(readManifestPluginMetadata(manual, {
      ...expected(), workflow: 'manual'
    }), installed)).toBe(false);
  });

  it.each([
    { label: 'pattern', options: { projectType: 'genai', apiStack: 'python-fastapi', pattern: 'chatbot' } },
    { label: 'environments', options: { environments: ['dev', 'prod'] } },
    { label: 'frontend', options: { includeFrontend: true } },
    { label: 'profile', options: { governanceProfile: 'none' } }
  ])('retains the full installed resolution digest when only $label changes', ({ label, options }) => {
    const base = label === 'pattern'
      ? plan({ projectType: 'genai', apiStack: 'python-fastapi', pattern: 'rag' }) : plan();
    const target = plan(options);
    const oldContext = resolveInstalledManifestBindingContext(base);
    const newContext = resolveInstalledManifestBindingContext(target);
    expect(oldContext.plugins.selections).toEqual(newContext.plugins.selections);
    expect(oldContext.plugins.resolutionDigest).not.toBe(newContext.plugins.resolutionDigest);
    expect(newContext.plugins.resolutionDigest).toBe(composeProjectPlugins(target).resolution.digest);
    expect(manifestPluginMetadataMatches(oldContext.plugins, newContext.plugins)).toBe(false);
  });

  it('recognizes Manual syntax for all optional agent subsets without adding an installed descriptor', () => {
    for (const agents of subsets) {
      const input = {
        schemaVersion: 1, resolutionDigest: digest('f'),
        selections: [row(), row('cloud', 'azure'), row('workflow', 'manual'),
          ...[...agents].sort().map((id) => row('agent', id))]
      };
      const value = readManifestPluginMetadata(input, { ...expected(), workflow: 'manual', agents });
      expect(value).toEqual(input);
      expect(value.selections.some((plugin) => plugin.category === 'workflow' && plugin.id === 'manual')).toBe(true);
    }
    expect(() => readManifestPluginMetadata(undefined, expected())).toThrow(FileSystemError);
  });

  it('returns independent immutable values without reordering or changing the input', () => {
    const raw = metadata(), before = structuredClone(raw), selection = expected();
    const result = readManifestPluginMetadata(raw, selection);
    expect(raw).toEqual(before);
    expect(selection).toEqual(expected());
    expect(result).not.toBe(raw);
    expect(result.selections).not.toBe(raw.selections);
    expect(result.selections[0]).not.toBe(raw.selections[0]);
    raw.selections[0].id = 'go-huma';
    raw.resolutionDigest = digest('e');
    expect(result.selections[0].id).toBe('node-fastify');
    expect(result.resolutionDigest).toBe(digest('b'));
    for (const value of [result, result.selections, ...result.selections]) {
      expect(Object.isFrozen(value)).toBe(true);
      expect(Reflect.set(value, 'extra', true)).toBe(false);
    }
  });
});

describe('finite selection and ordering validation', () => {
  it.each([
    null, undefined, [], {}, 'selection',
    { ...expected(), stack: 'python' }, { ...expected(), stack: 'custom' },
    { ...expected(), cloud: 'aws' }, { ...expected(), cloud: 'Azure' },
    { ...expected(), workflow: 'Manual' }, { ...expected(), workflow: 'unknown' },
    { ...expected(), agents: ['copilot'] }, { ...expected(), agents: ['unknown'] },
    { ...expected(), agents: ['github-copilot', 'github-copilot'] },
    { ...expected(), agents: ['github-copilot', 'claude', 'codex', 'extra'] },
    { ...expected(), agents: null }, { ...expected(), agents: [null] },
    { ...expected(), agents: [1] }, { ...expected(), agents: new Array(1) },
    { ...expected(), extra: true }
  ].map((value) => ({ value })))('rejects malformed or unknown expectation %#', ({ value }) => {
    expect(() => readManifestPluginMetadata(metadata(), value)).toThrow(FileSystemError);
  });

  it.each([
    { category: 'unknown' }, { category: 'Stack' }, { category: null },
    { id: 'python' }, { id: 'azure' }, { id: null },
    { category: 'cloud', id: 'node-fastify' }, { category: 'cloud', id: 'aws' },
    { category: 'workflow', id: 'github-copilot' }, { category: 'agent', id: 'copilot' },
    { category: 'agent', id: 'manual' }
  ])('rejects unknown or wrong-category plugin identity %j', (change) => {
    const input = metadata();
    Object.assign(input.selections[0], change);
    expect(() => readManifestPluginMetadata(input, expected())).toThrow(/identity|category/);
  });

  it.each([
    { at: 0, id: 'python-fastapi' }, { at: 2, id: 'spec-kit' },
    { at: 2, id: 'manual' }, { at: 3, id: 'claude' }
  ])('rejects recognized but unselected identity $id', ({ at, id }) => {
    const input = metadata();
    input.selections[at].id = id;
    expect(() => readManifestPluginMetadata(input, expected())).toThrow('exact selection');
  });

  it('rejects duplicates, source-agent ordering in plugin rows, omitted and extra rows', () => {
    const selected = plan({ agents: ['github-copilot', 'claude', 'codex'] });
    const installed = resolveInstalledManifestBindingContext(selected).plugins;
    const original = installed.selections;
    const expectation = expectationFromPlan(selected);
    const misordered = [original[0], original[1], original[2], original[5], original[3], original[4]];
    const duplicate = [original[0], original[1], original[2], original[3], original[3], original[5]];
    const wrongCategories = [original[1], original[0], ...original.slice(2)];
    for (const selections of [misordered, duplicate, wrongCategories]) {
      expect(() => readManifestPluginMetadata({ ...installed, selections }, expectation)).toThrow('registry category and lexical-ID order');
    }
    for (const selections of [[], original.slice(1), [...original, original[0]]]) {
      expect(() => readManifestPluginMetadata({ ...installed, selections }, expectation)).toThrow(/exactly the selected|finite entry limit/);
    }
  });

  it.each([undefined, null, 0, 2, '1', NaN, true].map((value) => ({ value })))(
    'rejects unsupported or coerced metadata schema %#', ({ value }) => {
      expect(() => readManifestPluginMetadata({ ...metadata(), schemaVersion: value }, expected())).toThrow('schemaVersion must be 1');
    });

  it.each([0, -0, -1, 0.5, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, -Infinity, NaN, '1',
    null, undefined, {}, [], true, 1n].map((value) => ({ value })))('rejects invalid API/content version %#', ({ value }) => {
    for (const field of ['apiVersion', 'contentVersion']) {
      const input = metadata();
      Reflect.set(input.selections[0], field, value);
      expect(() => readManifestPluginMetadata(input, expected())).toThrow(`${field} must be a positive safe integer`);
    }
  });

  it('accepts exact positive-safe version thresholds and both digest alphabet endpoints as syntax', () => {
    const input = metadata();
    input.selections[0].apiVersion = 1;
    input.selections[0].contentVersion = Number.MAX_SAFE_INTEGER;
    input.selections[0].contentDigest = digest('0');
    input.resolutionDigest = digest('f');
    expect(readManifestPluginMetadata(input, expected())).toEqual(input);
  });

  it.each([
    '', 'a'.repeat(64), 'sha256:', digest('a').toUpperCase(), `sha256:${'A'.repeat(64)}`,
    `sha256:${'g'.repeat(64)}`, `sha256:${'a'.repeat(63)}`, `sha256:${'a'.repeat(65)}`,
    ` ${digest()}`, `${digest()}\n`, `${digest()}\0`, null, undefined, 1, {}, [], true
  ].map((value) => ({ value })))('rejects malformed prefixed digest %#', ({ value }) => {
    expect(() => readManifestPluginMetadata({ ...metadata(), resolutionDigest: value }, expected()))
      .toThrow('resolutionDigest must be a sha256-prefixed');
    const input = metadata();
    Reflect.set(input.selections[0], 'contentDigest', value);
    expect(() => readManifestPluginMetadata(input, expected())).toThrow('contentDigest must be a sha256-prefixed');
  });
});

describe('closed own-data plugin records and arrays', () => {
  const recordCases = [
    { label: 'metadata', sample: metadata, read: (value: unknown) => readManifestPluginMetadata(value, expected()) },
    { label: 'expectation', sample: expected, read: (value: unknown) => readManifestPluginMetadata(metadata(), value) },
    { label: 'plugin row', sample: row, read: (value: unknown) => readManifestPluginMetadata({
      ...metadata(), selections: [value, ...metadata().selections.slice(1)]
    }, expected()) }
  ];

  it.each(recordCases)('rejects non-record and inherited $label values', ({ sample, read }) => {
    for (const value of [null, undefined, [], new Array(1), 'object', true, 0, () => sample(), Object.create(sample())]) {
      expect(() => read(value)).toThrow(FileSystemError);
    }
    expect(read(Object.assign(Object.create(null), sample()))).toBeDefined();
  });

  it.each(recordCases)('requires closed own enumerable data fields for $label without invoking accessors', ({ sample, read }) => {
    for (const key of Object.keys(sample())) {
      const missing = sample();
      Reflect.deleteProperty(missing, key);
      expect(() => read(missing)).toThrow('required fields');
      const hidden = Object.defineProperty(sample(), key, { enumerable: false });
      expect(() => read(hidden)).toThrow('own enumerable data field');
      for (const getterOrSetter of ['get', 'set']) {
        const callback = vi.fn(() => { throw new Error('must not evaluate record accessor'); });
        const input = Object.defineProperty(sample(), key, { enumerable: true, [getterOrSetter]: callback });
        expect(() => read(input)).toThrow('own enumerable data field');
        expect(callback).not.toHaveBeenCalled();
      }
    }
    const callback = vi.fn(() => { throw new Error('must not evaluate extra accessor'); });
    expect(() => read(Object.defineProperty(sample(), 'extra', { enumerable: true, get: callback }))).toThrow('required fields');
    expect(callback).not.toHaveBeenCalled();
    for (const value of [
      { ...sample(), extra: true }, { ...sample(), [Symbol('extra')]: true },
      Object.defineProperty(sample(), 'extra', { value: true, enumerable: false })
    ]) expect(() => read(value)).toThrow('required fields');
    const toJSON = vi.fn(() => sample());
    expect(() => read({ ...sample(), toJSON })).toThrow('required fields');
    expect(toJSON).not.toHaveBeenCalled();
  });

  const arrays = [
    { label: 'agents', sample: () => expected().agents, read: (value: unknown) =>
      readManifestPluginMetadata(metadata(), { ...expected(), agents: value }), maximum: 3 },
    { label: 'selections', sample: () => metadata().selections, read: (value: unknown) =>
      readManifestPluginMetadata({ ...metadata(), selections: value }, expected()), maximum: 6 }
  ];

  it.each(arrays)('rejects sparse, accessor and extra-key $label arrays without invoking them', ({ sample, read, maximum }) => {
    for (const value of [null, undefined, {}, 'array', new Array(maximum + 1), new Array(1)]) {
      expect(() => read(value)).toThrow(FileSystemError);
    }
    const sparse = new Array(1);
    Object.defineProperty(sparse, 'extra', { value: sample()[0], enumerable: true });
    expect(() => read(sparse)).toThrow('own enumerable data entry');
    for (const getterOrSetter of ['get', 'set']) {
      const callback = vi.fn(() => { throw new Error('must not evaluate array accessor'); });
      const input = sample();
      Object.defineProperty(input, '0', { enumerable: true, [getterOrSetter]: callback });
      expect(() => read(input)).toThrow('own enumerable data entry');
      expect(callback).not.toHaveBeenCalled();
    }
    const hidden = sample();
    Object.defineProperty(hidden, '0', { enumerable: false });
    expect(() => read(hidden)).toThrow('own enumerable data entry');
    const extra = sample();
    Object.assign(extra, { extra: true });
    expect(() => read(extra)).toThrow('only dense array entries');
    const symbol = sample();
    Reflect.set(symbol, Symbol('extra'), true);
    expect(() => read(symbol)).toThrow('only dense array entries');
    const getter = vi.fn(() => { throw new Error('must not invoke array method'); });
    const method = sample();
    Object.defineProperty(method, 'map', { get: getter });
    expect(() => read(method)).toThrow('only dense array entries');
    expect(getter).not.toHaveBeenCalled();
    class InheritedArray extends Array<unknown> {}
    const inherited = new InheritedArray();
    inherited.push(...sample());
    expect(() => read(inherited)).toThrow('dense plain array');
  });

  it('does not coerce malformed identity/version/digest objects', () => {
    const coercion = vi.fn(() => 'node-fastify');
    const malicious = { toString: coercion, valueOf: coercion, [Symbol.toPrimitive]: coercion };
    for (const field of ['id', 'category', 'apiVersion', 'contentVersion', 'contentDigest']) {
      const input = metadata();
      Reflect.set(input.selections[0], field, malicious);
      expect(() => readManifestPluginMetadata(input, expected())).toThrow(FileSystemError);
    }
    expect(() => readManifestPluginMetadata({ ...metadata(), resolutionDigest: malicious }, expected())).toThrow(FileSystemError);
    expect(coercion).not.toHaveBeenCalled();
  });
});
