import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { projectCatalog } from '../src/application/project/catalog.js';
import { parseManifest, resolveInstalledManifestBindingContext } from '../src/application/project/manifest.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { createManifestProjectReader } from '../src/domain/project/manifest/project-identity.js';
import {
  createManifestV8ProjectReader, type ManifestV8ProjectLeaf, type ManifestV8WorkflowId
} from '../src/domain/project/manifest/v8-project.js';
import type { CodingAgentId, SpecWorkflowId } from '../src/domain/project/contracts.js';
import { FileSystemError } from '../src/domain/project/errors.js';

const { validateManifestV8Project: validate } = createManifestV8ProjectReader(projectCatalog);
const historical = createManifestProjectReader(projectCatalog);
const workloads = [
  ...['python-fastapi', 'node-fastify', 'go-huma'].map((apiStack) => ({ kind: 'standard', apiStack })),
  ...projectCatalog.patterns.map(({ id }) => ({ kind: 'genai', apiStack: 'python-fastapi', pattern: id }))
];
const agentSets = [
  [], ['github-copilot'], ['claude'], ['codex'], ['github-copilot', 'claude'],
  ['github-copilot', 'codex'], ['claude', 'codex'], ['github-copilot', 'claude', 'codex']
];
const envSets = [
  ['dev'], ['staging'], ['prod'], ['dev', 'staging'], ['dev', 'prod'], ['staging', 'prod'], ['dev', 'staging', 'prod']
];
const workload = () => ({
  kind: 'standard', apiStack: 'node-fastify', cloud: 'azure', region: 'eastus', frontend: false, environments: ['dev']
});
const project = () => ({
  name: 'Project Identity', workload: workload(), specWorkflow: 'openspec', agents: ['github-copilot']
});
const framework = () => ({
  state: 'initialized', adapter: 'openspec', contractVersion: projectCatalog.getFrameworkDefinition('openspec').version
});
const leaf = () => ({ project: project(), framework: framework() });
const manual = () => ({ project: { ...project(), specWorkflow: 'manual', agents: [] }, framework: { state: 'not-required' } });

describe('independent v8 project identity leaf', () => {
  it('exports a leaf with independent workflow types and precise framework states', () => {
    expectTypeOf(validate).parameter(0).toEqualTypeOf<unknown>();
    expectTypeOf(validate).returns.toEqualTypeOf<ManifestV8ProjectLeaf>();
    expectTypeOf<ManifestV8WorkflowId>().toEqualTypeOf<'openspec' | 'spec-kit' | 'manual'>();
    expectTypeOf<SpecWorkflowId>().toEqualTypeOf<'openspec' | 'spec-kit'>();
    expectTypeOf<keyof ManifestV8ProjectLeaf>().toEqualTypeOf<'project' | 'framework'>();
    type Native = Extract<ManifestV8ProjectLeaf, { framework: { state: 'not-required' } }>;
    expectTypeOf<Native['project']['specWorkflow']>().toEqualTypeOf<'manual'>();
    expectTypeOf<Native['project']['agents']>().toEqualTypeOf<readonly CodingAgentId[]>();
    expectTypeOf<keyof Native['framework']>().toEqualTypeOf<'state'>();
    type Legacy = Extract<ManifestV8ProjectLeaf, { framework: { state: 'legacy' } }>;
    expectTypeOf<Legacy['project']['agents']>().toEqualTypeOf<readonly []>();
    type Kit = Extract<ManifestV8ProjectLeaf, { framework: { state: 'initialized'; adapter: 'spec-kit' } }>;
    expectTypeOf<Kit['project']['defaultAgent']>().toEqualTypeOf<CodingAgentId>();
    expectTypeOf<Kit['project']['agents']>().toEqualTypeOf<readonly [CodingAgentId, ...CodingAgentId[]]>();
  });

  it.each(workloads)('retains $kind/$apiStack/$pattern across external, legacy and Manual representations', (identity) => {
    for (const [index, agents] of agentSets.entries()) {
      for (const selectedWorkflow of ['openspec', 'spec-kit', 'manual'] as const) {
        const state = selectedWorkflow === 'manual' ? 'not-required' : agents.length ? 'initialized' : 'legacy';
        const projectInput = {
          ...project(),
          workload: { ...workload(), ...identity, frontend: index % 2 === 0, environments: envSets[index % envSets.length] },
          specWorkflow: selectedWorkflow, agents: [...agents],
          ...(selectedWorkflow === 'spec-kit' && agents.length ? { defaultAgent: agents.at(-1) } : {})
        };
        const frameworkInput = selectedWorkflow === 'manual' ? { state } : {
          state, adapter: selectedWorkflow,
          ...(state === 'initialized' ? { contractVersion: projectCatalog.getFrameworkDefinition(selectedWorkflow).version } : {})
        };
        const input = { project: projectInput, framework: frameworkInput };
        const before = structuredClone(input);
        const result = validate(input);
        expect(result).toEqual(before);
        expect(input).toEqual(before);
        expect(result.project.workload.environments).not.toBe(projectInput.workload.environments);
        expect(result.project.agents).not.toBe(projectInput.agents);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.project)).toBe(true);
        expect(Object.isFrozen(result.project.workload)).toBe(true);
        expect(Object.isFrozen(result.project.workload.environments)).toBe(true);
        expect(Object.isFrozen(result.project.agents)).toBe(true);
        expect(Object.isFrozen(result.framework)).toBe(true);
        expect(Object.keys(result)).toEqual(['project', 'framework']);
        expect(result).not.toHaveProperty('artifactVersion');
        expect(result).not.toHaveProperty('governance');
        expect(result).not.toHaveProperty('plugins');
        expect(result).not.toHaveProperty('activeLayout');
        if (selectedWorkflow !== 'manual') {
          expect(result.project).toEqual(historical.normalizeManifestProject(projectInput, 7));
          expect(result.framework).toEqual(historical.normalizeManifestFramework(
            frameworkInput, 7, historical.normalizeManifestProject(projectInput, 7)
          ));
        }
      }
    }
  });

  it('preserves every actual Azure region and supported environment subset without sorting source intent', () => {
    for (const region of projectCatalog.listRegions('azure')) {
      const input = leaf();
      input.project.workload.region = region.slug;
      expect(validate(input).project.workload.region).toBe(region.slug);
    }
    for (const environments of [...envSets, ['prod', 'dev', 'staging']]) {
      const input = leaf();
      input.project.workload.environments = environments;
      expect(validate(input).project.workload.environments).toEqual(environments);
    }
  });

  it('preserves recorded external framework contracts rather than an observed or new installed version', () => {
    for (const contractVersion of ['1.0.0', '1.11.0', '0.0.1-dev.0', '2.0.0+recorded']) {
      const input = leaf();
      input.framework.contractVersion = contractVersion;
      expect(validate(input).framework).toEqual(input.framework);
    }
  });

  it.each(['openspec', 'spec-kit'])('preserves explicit %s legacy uncertainty without agents or a fake Manual state', (workflow) => {
    const input = { project: { ...project(), specWorkflow: workflow, agents: [] }, framework: { state: 'legacy', adapter: workflow } };
    expect(validate(input)).toEqual(input);
    expect(validate(input).project).not.toHaveProperty('defaultAgent');
    expect(validate(input).framework).not.toHaveProperty('contractVersion');
    expect(() => validate({ project: input.project, framework: undefined })).toThrow(FileSystemError);
  });

  it.each(['0.3.4', '0.4.1', '0.7.0', '0.8.0', '0.9.9', '0.10.0', '0.11.3', '0.12.3'])(
    'agrees with authentic historical normalized %s project leaves without changing raw source bytes', (version) => {
      const url = new URL(`./fixtures/contract-baseline-0.12.3/manifests/${version}-standard-go.json`, import.meta.url);
      const bytes = readFileSync(url);
      const raw: unknown = JSON.parse(bytes.toString('utf8'));
      const parsed = parseManifest(raw);
      expect(validate({ project: parsed.project, framework: parsed.framework })).toEqual({
        project: parsed.project, framework: parsed.framework
      });
      expect(readFileSync(url)).toEqual(bytes);
      expect(parsed).not.toHaveProperty('plugins');
      expect(parsed).not.toHaveProperty('activeLayout');
    });

  it('does not widen historical workflows, public v8 acceptance or actual installed Manual capability', () => {
    expect(projectCatalog.getSpecWorkflow('manual')).toBeUndefined();
    expect(() => historical.normalizeManifestProject(manual().project, 7)).toThrow('specWorkflow');
    const raw = JSON.parse(readFileSync(
      new URL('./fixtures/contract-baseline-0.12.3/manifests/0.12.3-standard-go.json', import.meta.url), 'utf8'));
    raw.artifactVersion = 8;
    expect(() => parseManifest(raw)).toThrow('Unsupported manifest artifactVersion 8');
    const selection = {
      projectName: 'External', projectType: 'standard', apiStack: 'node-fastify', cloud: 'azure',
      region: 'eastus', specWorkflow: 'openspec', agents: ['github-copilot'], environments: ['dev']
    };
    expect(() => buildProjectPlan({ ...selection, specWorkflow: 'manual' }, { requireProjectName: true }))
      .toThrow(/workflow|manual/i);
    const selected = structuredClone(buildProjectPlan(selection, { requireProjectName: true }));
    Reflect.set(selected.specWorkflow, 'id', 'manual');
    Reflect.set(selected.framework, 'id', 'manual');
    expect(() => resolveInstalledManifestBindingContext(selected)).toThrow(/unknown|unsupported|invalid/i);
  });

  it('makes independent frozen copies without freezing caller data or rewriting names', () => {
    const input = leaf();
    input.project.name = 'Café API with spaces';
    const output = validate(input);
    expect(input.project.name).toBe('Café API with spaces');
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.project.workload.environments)).toBe(false);
    input.project.workload.environments.push('prod');
    input.project.agents.push('claude');
    input.project.name = 'Changed';
    input.framework.contractVersion = '99.0.0';
    expect(output.project.name).toBe('Café API with spaces');
    expect(output.project.workload.environments).toEqual(['dev']);
    expect(output.project.agents).toEqual(['github-copilot']);
    expect(output.framework).toEqual(framework());
  });
});

describe('workload and integration consistency', () => {
  it.each([
    { kind: 'unknown' }, { kind: 'GenAI' }, { kind: undefined }, { apiStack: 'node' },
    { apiStack: 'unknown' }, { apiStack: 1 }, { cloud: 'aws' }, { cloud: 'gcp' }, { cloud: 'Azure' },
    { region: 'not-a-region' }, { region: 'East US' }, { region: '' },
    { frontend: 'false' }, { frontend: 0 }, { frontend: null },
    { environments: [] }, { environments: ['test'] }, { environments: ['Dev'] },
    { environments: ['dev', 'dev'] }, { pattern: 'rag' },
    { kind: 'genai', apiStack: 'node-fastify', pattern: 'rag' },
    { kind: 'genai', apiStack: 'go-huma', pattern: 'rag' },
    { kind: 'genai', apiStack: 'python-fastapi', pattern: 'unknown' },
    { kind: 'genai', apiStack: 'python-fastapi' }
  ])('rejects contradictory or unsupported workload %j', (change) => {
    const input = leaf();
    Object.assign(input.project.workload, change);
    expect(() => validate(input)).toThrow(FileSystemError);
  });

  it('rejects retired workloads before calling workload catalogs or interpreting framework state', () => {
    const getApiStack = vi.fn(projectCatalog.getApiStack);
    const local = createManifestV8ProjectReader({ ...projectCatalog, getApiStack }).validateManifestV8Project;
    const getFramework = vi.fn(() => { throw new Error('framework accessor invoked'); });
    const input = { ...leaf(), project: { ...project(), workload: { kind: 'power-apps-code-app' } } };
    Object.defineProperty(input.framework, 'state', { get: getFramework, enumerable: true });
    expect(() => local(input)).toThrow(/Power Apps.*retired/);
    expect(getApiStack).not.toHaveBeenCalled();
    expect(getFramework).not.toHaveBeenCalled();
  });

  it.each(['', ' ', null, 1, undefined].map((value) => ({ value })))('rejects invalid project name %#', ({ value }) => {
    expect(() => validate({ ...leaf(), project: { ...project(), name: value } })).toThrow(FileSystemError);
  });

  it.each(['Manual', 'OPENSpec', '', 'none', undefined, null, 1].map((value) => ({ value })))(
    'rejects missing or aliased workflow %# rather than defaulting', ({ value }) => {
      expect(() => validate({ ...manual(), project: { ...manual().project, specWorkflow: value } })).toThrow(FileSystemError);
    });

  it.each([['copilot'], ['unknown'], ['none'], ['github-copilot', 'none'], ['claude', 'github-copilot'],
    ['codex', 'claude'], ['github-copilot', 'github-copilot']].map((agents) => ({ agents })))(
    'rejects alias, none sentinel, duplicate or unordered agent identities %j', ({ agents }) => {
      expect(() => validate({ ...manual(), project: { ...manual().project, agents } })).toThrow(/agent|canonical/);
    });

  it.each([
    { state: 'initialized' }, { state: 'legacy' }, { state: 'not-required', adapter: 'manual' },
    { state: 'not-required', contractVersion: '0.0.0' }, { state: 'not-required', executable: 'none' },
    { state: 'not-required', markers: [] }, { state: 'not-required', available: true }, { state: 'NOT-REQUIRED' }
  ])('rejects fictional Manual framework metadata %j', (value) => {
    expect(() => validate({ ...manual(), framework: value })).toThrow(FileSystemError);
  });

  it.each([undefined, null, '', 'github-copilot', 'claude', 'none'].map((value) => ({ value })))(
    'rejects any explicit Manual default agent %#', ({ value }) => {
      expect(() => validate({
        ...manual(), project: { ...manual().project, agents: ['github-copilot'], defaultAgent: value }
      })).toThrow(FileSystemError);
    });

  it.each(['openspec', 'spec-kit'])('rejects mixed %s framework identity/state combinations', (workflow) => {
    const projectInput = { ...project(), specWorkflow: workflow, ...(workflow === 'spec-kit' ? { defaultAgent: 'github-copilot' } : {}) };
    for (const value of [
      { state: 'not-required' }, { state: 'legacy', adapter: workflow },
      { state: 'initialized', adapter: workflow }, { state: 'initialized', adapter: 'manual', contractVersion: '1.0.0' },
      { state: 'initialized', adapter: workflow === 'openspec' ? 'spec-kit' : 'openspec', contractVersion: '1.0.0' }
    ]) expect(() => validate({ project: projectInput, framework: value })).toThrow(FileSystemError);
    const initialized = { state: 'initialized', adapter: workflow, contractVersion: '1.0.0' };
    expect(() => validate({ project: { ...projectInput, agents: [] }, framework: initialized })).toThrow(FileSystemError);
    const legacyProject = { ...project(), specWorkflow: workflow, agents: [] };
    expect(() => validate({
      project: legacyProject, framework: { state: 'legacy', adapter: workflow, contractVersion: '1.0.0' }
    })).toThrow('required fields');
    expect(() => validate({
      project: { ...legacyProject, defaultAgent: 'github-copilot' }, framework: { state: 'legacy', adapter: workflow }
    })).toThrow(FileSystemError);
  });

  it.each(['', 'latest', '1', '1.0', 'v1.0.0', '01.2.3', undefined, null, 1].map((value) => ({ value })))(
    'rejects absent or invalid initialized contract version %#', ({ value }) => {
      expect(() => validate({ ...leaf(), framework: { ...framework(), contractVersion: value } })).toThrow(FileSystemError);
    });

  it('requires an actually selected Spec Kit default and never defaults it from first agent', () => {
    const kit = { project: { ...project(), specWorkflow: 'spec-kit', agents: ['github-copilot', 'claude'] },
      framework: { ...framework(), adapter: 'spec-kit' } };
    expect(() => validate(kit)).toThrow('selected defaultAgent');
    for (const defaultAgent of ['github-copilot', 'claude']) {
      expect(validate({ ...kit, project: { ...kit.project, defaultAgent } }).project).toEqual({ ...kit.project, defaultAgent });
    }
    for (const defaultAgent of ['codex', 'copilot', 'none', '', undefined, null]) {
      expect(() => validate({ ...kit, project: { ...kit.project, defaultAgent } })).toThrow(FileSystemError);
    }
    expect(() => validate({ ...leaf(), project: { ...project(), defaultAgent: 'github-copilot' } })).toThrow('OpenSpec manifests cannot');
  });
});

describe('closed own-data v8 leaf boundaries', () => {
  const records = [
    { label: 'leaf', sample: leaf, read: (value: unknown) => validate(value) },
    { label: 'project', sample: project, read: (value: unknown) => validate({ ...leaf(), project: value }) },
    { label: 'workload', sample: workload, read: (value: unknown) => validate({ ...leaf(), project: { ...project(), workload: value } }) },
    { label: 'framework', sample: framework, read: (value: unknown) => validate({ ...leaf(), framework: value }) },
    { label: 'Manual framework', sample: () => manual().framework, read: (value: unknown) => validate({ ...manual(), framework: value }) }
  ];

  it.each(records)('rejects non-record and inherited $label data without evaluating it', ({ sample, read }) => {
    for (const value of [undefined, null, false, 1, '', [], new Array(1), new Date(0), () => sample(), Object.create(sample())]) {
      expect(() => read(value)).toThrow(FileSystemError);
    }
    const input: object = Object.assign(Object.create(null), sample());
    expect(() => read(input)).not.toThrow();
  });

  it.each(records)('requires closed own fields for $label and never invokes getters/setters', ({ sample, read }) => {
    for (const key of Object.keys(sample())) {
      const missing = sample();
      Reflect.deleteProperty(missing, key);
      expect(() => read(missing)).toThrow(FileSystemError);
      const hidden = Object.defineProperty(sample(), key, { enumerable: false });
      expect(() => read(hidden)).toThrow('own enumerable data field');
      for (const kind of ['get', 'set']) {
        const hook = vi.fn(() => { throw new Error('getter/setter invoked'); });
        const input = Object.defineProperty(sample(), key, { enumerable: true, [kind]: hook });
        expect(() => read(input)).toThrow(FileSystemError);
        expect(hook).not.toHaveBeenCalled();
      }
    }
    const hook = vi.fn(() => { throw new Error('extra getter invoked'); });
    expect(() => read(Object.defineProperty(sample(), 'extra', { enumerable: true, get: hook }))).toThrow('required fields');
    expect(hook).not.toHaveBeenCalled();
    for (const extra of [
      { extra: true }, { governance: {} }, { pluginIdentity: {} }, { telemetryId: 'random' },
      { sourceManifestHistory: {} }, { toJSON: hook }, { [Symbol.iterator]: hook }
    ]) expect(() => read({ ...sample(), ...extra })).toThrow('required fields');
    expect(() => read(Object.defineProperty(sample(), 'extra', { value: true, enumerable: false }))).toThrow('required fields');
    expect(hook).not.toHaveBeenCalled();
  });

  it('requires an explicit default to be an own data field and does not invoke it', () => {
    const hook = vi.fn(() => 'github-copilot');
    const input = Object.defineProperty(project(), 'defaultAgent', { enumerable: true, get: hook });
    expect(() => validate({ ...leaf(), project: input })).toThrow('own enumerable data field');
    expect(hook).not.toHaveBeenCalled();
  });

  const arrays = [
    { label: 'agents', sample: () => ['github-copilot'], read: (value: unknown) =>
      validate({ ...manual(), project: { ...manual().project, agents: value } }) },
    { label: 'environments', sample: () => ['dev'], read: (value: unknown) =>
      validate({ ...leaf(), project: { ...project(), workload: { ...workload(), environments: value } } }) }
  ];

  it.each(arrays)('rejects non-string, sparse, extra-property and accessor $label arrays', ({ sample, read }) => {
    for (const value of [undefined, null, 'array', {}, [undefined], [null], [1], [{}], [false], new Array(1), new Array(4)]) {
      expect(() => read(value)).toThrow(FileSystemError);
    }
    for (const kind of ['get', 'set']) {
      const hook = vi.fn(() => { throw new Error('array getter/setter invoked'); });
      const input = Object.defineProperty(sample(), '0', { enumerable: true, [kind]: hook });
      expect(() => read(input)).toThrow('own enumerable string data entry');
      expect(hook).not.toHaveBeenCalled();
    }
    const hidden = Object.defineProperty(sample(), '0', { enumerable: false });
    expect(() => read(hidden)).toThrow('own enumerable string data entry');
    const sparse = new Array(1);
    Object.assign(sparse, { extra: 'x' });
    expect(() => read(sparse)).toThrow('own enumerable string data entry');
    const hook = vi.fn(() => { throw new Error('array method invoked'); });
    const input = Object.defineProperty(sample(), 'map', { get: hook });
    expect(() => read(input)).toThrow('at most three dense entries');
    expect(hook).not.toHaveBeenCalled();
    expect(() => read(Object.assign(sample(), { extra: true }))).toThrow('at most three dense entries');
    const symbol = sample();
    Reflect.set(symbol, Symbol('extra'), true);
    expect(() => read(symbol)).toThrow('at most three dense entries');
    class Subclass extends Array<string> {}
    const inherited = new Subclass();
    inherited.push(...sample());
    expect(() => read(inherited)).toThrow('dense plain string array');
  });

  it('does not coerce field objects through primitive, toJSON or catalog lookup hooks', () => {
    const hook = vi.fn(() => 'node-fastify');
    const malicious = { toString: hook, valueOf: hook, toJSON: hook, [Symbol.toPrimitive]: hook };
    for (const field of ['name', 'specWorkflow', 'defaultAgent']) {
      expect(() => validate({ ...leaf(), project: { ...project(), [field]: malicious } })).toThrow(FileSystemError);
    }
    for (const field of ['kind', 'apiStack', 'cloud', 'region', 'frontend']) {
      expect(() => validate({ ...leaf(), project: { ...project(), workload: { ...workload(), [field]: malicious } } }))
        .toThrow(FileSystemError);
    }
    for (const field of ['state', 'adapter', 'contractVersion']) {
      expect(() => validate({ ...leaf(), framework: { ...framework(), [field]: malicious } })).toThrow(FileSystemError);
    }
    expect(hook).not.toHaveBeenCalled();
  });
});
