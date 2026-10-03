import { describe, expect, it, vi } from 'vitest';
import { projectCatalog } from '../src/application/project/catalog.js';
import { composeModernManifestPlugins } from '../src/application/project/plugins.js';
import { resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { renderGovernanceSourceFiles } from '../src/application/governance/source-rendering.js';
import { readManifestPluginMetadata } from '../src/domain/project/manifest/plugins.js';
import { manifestActiveLayoutDigest } from '../src/domain/project/manifest/layout.js';
import { createManifestV8ProjectReader } from '../src/domain/project/manifest/v8-project.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { createModernActivationIdentityReader } from '../src/domain/governance/activation/modern-identity.js';
import { createModernGovernanceSourceContract } from '../src/domain/governance/activation/modern-source-metadata.js';
import type { ModernGovernanceProfile, ModernWorkflow } from '../src/domain/governance/activation/modern-record-contracts.js';
import { validateGovernanceChangeMetadata } from '../src/governance-activation/source-of-truth.js';
import { capturedV3Records } from './fixtures/activation-v3/fixture.js';

function context(workflow: ModernWorkflow = 'openspec', profile: ModernGovernanceProfile = 'single-maintainer-gitflow') {
  const agents = workflow === 'manual' ? [] : ['github-copilot'];
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({
    project: { name: 'source-fixture', workload: { kind: 'standard', apiStack: 'node-fastify', cloud: 'azure',
      region: 'eastus', frontend: false, environments: ['dev'] }, specWorkflow: workflow, agents,
      ...(workflow === 'spec-kit' ? { defaultAgent: 'github-copilot' } : {}) },
    framework: workflow === 'manual' ? { state: 'not-required' } :
      { state: 'initialized', adapter: workflow, contractVersion: '1.2.3' }
  });
  const composition = composeModernManifestPlugins({ workload: 'standard', stack: 'node-fastify', cloud: 'azure',
    workflow, agents, frontend: 'omitted', environments: ['dev'], governanceProfile: profile }, { safeProjectName: 'source-fixture' });
  const plugins = readManifestPluginMetadata({ schemaVersion: 1, resolutionDigest: composition.resolution.digest,
    selections: composition.resolution.plugins }, { stack: 'node-fastify', cloud: 'azure', workflow, agents });
  const selection = { ...leaf, profile };
  const source = resolveModernManifestV8SourceContract({ selection, recordedPlugins: plugins });
  if (!('identity' in source.governanceSource)) throw new Error('Expected an actual enabled source.');
  const input = { profile, policyVersion: source.governanceSource.identity.policyVersion, selection,
    pluginResolutionDigest: plugins.resolutionDigest,
    activeLayoutDigest: manifestActiveLayoutDigest({ schemaVersion: 1, state: 'unresolved', bindings: [] }, source.layoutDescriptor) };
  return { ...input, recordedIdentity: createModernActivationIdentityReader(projectCatalog).identityForSource({
    ...input, sourceVersion: source.governanceSource.identity.liftoffVersion
  }) };
}

const input = {
  changeId: 'governance-source-fixture', baselineSha: 'a'.repeat(64),
  createdFrom: { kind: 'approved-phase-0-facts' as const, approvedFactDigest: 'b'.repeat(64), evidenceIds: ['phase-0-observation'] },
  acknowledgedAt: '2026-10-03T00:00:00.000Z', owner: 'synthetic-reviewer'
};
const api = () => createModernGovernanceSourceContract(projectCatalog, context());
const metadata = () => api().create(input);
const tasks = (value = metadata()) => value.phaseTaskMapping
  .map(mapping => `- [ ] ${mapping.taskId} Current phase ${mapping.marker}\r\n`).join('') + '- [X] user-note Leave this alone.\r\n';
const pending = (contract = api()) => Object.fromEntries(contract.graph.phases.map(phase => [phase.id, 'pending']));

describe('private modern source metadata values', () => {
  it.each([
    ['openspec', 'single-maintainer-gitflow'], ['openspec', 'team-gitflow'],
    ['spec-kit', 'single-maintainer-gitflow'], ['spec-kit', 'team-gitflow']
  ] as const)('deterministically binds the actual %s/%s source without runtime authority', (workflow, profile) => {
    const contract = createModernGovernanceSourceContract(projectCatalog, context(workflow, profile));
    const before = structuredClone(input), first = contract.create(input), second = contract.create(input);
    expect(contract.encode(first)).toBe(contract.encode(second));
    expect(contract.read(JSON.parse(contract.encode(first)))).toEqual(first);
    expect(first.schemaVersion).toBe(2);
    expect(first.activationIdentity).toEqual(contract.identity);
    expect(first.phaseGraphHash).toBe(canonicalSha256(contract.graph));
    expect(first.phaseTaskMapping.map(mapping => mapping.phaseId)).toEqual(contract.graph.phases.map(phase => phase.id));
    expect(Object.isFrozen(first.phaseTaskMapping[0])).toBe(true);
    expect(Object.keys(first)).not.toContain('projectId');
    expect(contract.graph.phases.some(phase => phase.allowedMutations.local.includes('project-governance-tasks'))).toBe(false);
    const facts = { repositoryName: 'synthetic/source-fixture', approvedFacts: [] };
    const files = renderGovernanceSourceFiles(first, facts);
    expect(files).toEqual(renderGovernanceSourceFiles(second, facts));
    expect(files).toHaveLength(workflow === 'openspec' ? 6 : 4);
    expect(files.every(file => file.pathParts[0] === (workflow === 'openspec' ? 'openspec' : 'specs'))).toBe(true);
    const serialized = files.find(file => file.pathParts.at(-1) === 'liftoff-governance.json');
    expect(serialized?.content).toBe(contract.encode(first));
    const taskSource = files.find(file => file.pathParts.at(-1) === 'tasks.md')!.content;
    expect(contract.projectTasks(taskSource, first, pending(contract)).markdown).toBe(taskSource);
    expect(input).toEqual(before);
  });

  it.each(['single-maintainer-gitflow', 'team-gitflow'] as const)('refuses Manual metadata under %s', profile => {
    expect(() => createModernGovernanceSourceContract(projectCatalog, context('manual', profile))).toThrow(/Manual has no external/);
  });

  it('keeps schema1 records and readers separate and unchanged', () => {
    const original = capturedV3Records().metadata, before = canonicalJson(original);
    expect(validateGovernanceChangeMetadata(original).schemaVersion).toBe(1);
    expect(() => api().read(original)).toThrow(/schema 2/);
    expect(() => validateGovernanceChangeMetadata(metadata())).toThrow();
    expect(canonicalJson(original)).toBe(before);
  });

  it.each(Object.keys(metadata().activationIdentity))('rejects a changed or absent complete identity field %s', key => {
    const value = metadata(), changed = { ...value.activationIdentity }, missing = { ...value.activationIdentity };
    Reflect.set(changed, key, 'not-the-selected-source');
    Reflect.deleteProperty(missing, key);
    expect(() => api().read({ ...value, activationIdentity: changed })).toThrow(/identity|selected/);
    expect(() => api().read({ ...value, activationIdentity: missing })).toThrow(/identity/);
  });

  it.each([
    { schemaVersion: 1 }, { schemaVersion: 3 }, { marker: 'different' }, { workflowKind: 'manual' },
    { workflowKind: 'spec-kit' }, { phaseGraphHash: 'c'.repeat(64) }, { baselineSha: 'invalid' },
    { acknowledgedAt: 'yesterday' }, { acknowledgedAt: '2026-99-99T00:00:00Z' },
    { owner: '' }, { owner: 'two\nlines' }, { owner: '\u00e9'.repeat(129) }, { extra: true }
  ])('refuses malformed source metadata %#', change => {
    expect(() => api().read({ ...metadata(), ...change })).toThrow();
  });

  it.each(['../escape', 'C:', 'NUL', 'archive', 'bootstrap-review', '000-liftoff-bootstrap', 'MixedCase', 'x.y', 'x'.repeat(161)])(
    'refuses unsafe or noncanonical change ID %s', changeId => {
      expect(() => api().create({ ...input, changeId })).toThrow();
    }
  );

  it('rejects changed authority and fact provenance rather than silently normalizing them', () => {
    const value = metadata();
    expect(() => api().read({ ...value, currentPolicy: { ...value.currentPolicy, taskCompletion: 'checkboxes' } })).toThrow(/authority/);
    expect(() => api().read({ ...value, createdFrom: { ...value.createdFrom, kind: 'copied-history' } })).toThrow(/provenance/);
    expect(() => api().read({ ...value, createdFrom: { ...value.createdFrom, approvedFactDigest: 'unknown' } })).toThrow(/digest/);
    expect(() => api().read({ ...value, owner: `ghp_${'x'.repeat(32)}` })).toThrow(/sensitive/);
  });

  it.each(['change', 'evidence'])('rejects credential-shaped %s text before a path diagnostic can echo it', field => {
    const secretFixture = `../ghp_${'x'.repeat(32)}`;
    const value = field === 'change' ? { ...input, changeId: secretFixture } :
      { ...input, createdFrom: { ...input.createdFrom, evidenceIds: [secretFixture] } };
    expect(() => api().create(value)).toThrow(new Error('Modern governance source contains prohibited sensitive control-record content.'));
  });

  it.each([[], ['duplicate', 'duplicate'], ['../foreign'], ['x'.repeat(129)], Array.from({ length: 129 }, (_, i) => `e-${i}`)]
    .map(evidenceIds => ({ evidenceIds })))(
    'refuses invalid or unbounded evidence references %#', ({ evidenceIds }) => {
      expect(() => api().create({ ...input, createdFrom: { ...input.createdFrom, evidenceIds } })).toThrow();
    }
  );

  it('accepts the exact evidence reference cap without interpreting it as verified proof', () => {
    const evidenceIds = Array.from({ length: 128 }, (_, i) => `e-${i}`);
    expect(api().create({ ...input, createdFrom: { ...input.createdFrom, evidenceIds } }).createdFrom.evidenceIds).toEqual(evidenceIds);
  });

  it.each(['audit:result', 'audit?result', 'audit|result', 'conin$', '\uff26acts'])(
    'refuses non-portable evidence reference %s', evidenceId => {
      expect(() => api().create({ ...input, createdFrom: { ...input.createdFrom, evidenceIds: [evidenceId] } })).toThrow(/portable/);
    }
  );

  it.each([{ evidenceIds: ['fact', 'FACT'] }, { evidenceIds: ['\u03c3', '\u03c2'] }])(
    'refuses native-aliased evidence references %#', ({ evidenceIds }) => {
      expect(() => api().create({ ...input, createdFrom: { ...input.createdFrom, evidenceIds } })).toThrow(/distinct/);
    }
  );

  it('accepts the exact UTF-8 field limits and rejects an overlong task ID', () => {
    const contract = api(), value = contract.create({ ...input, changeId: 'x'.repeat(160), owner: '\u00e9'.repeat(128),
      createdFrom: { ...input.createdFrom, evidenceIds: ['e'.repeat(128)] } });
    expect(value.changeId).toHaveLength(160);
    expect(Buffer.byteLength(value.owner)).toBe(256);
    const mappings = value.phaseTaskMapping.map(mapping => ({ ...mapping }));
    mappings[0].taskId = 't'.repeat(128);
    expect(contract.read({ ...value, phaseTaskMapping: mappings }).phaseTaskMapping[0].taskId).toHaveLength(128);
    mappings[0].taskId += 't';
    expect(() => contract.read({ ...value, phaseTaskMapping: mappings })).toThrow(/bounded/);
  });

  it.each(['missing', 'extra', 'unknown', 'duplicate-phase', 'duplicate-task', 'marker', 'policy', 'task-id', 'sparse'] as const)(
    'requires complete exact phase mappings: %s', kind => {
      const value = metadata(), mappings = value.phaseTaskMapping.map(mapping => ({ ...mapping }));
      if (kind === 'missing') mappings.pop();
      if (kind === 'extra') mappings.push({ ...mappings[0] });
      if (kind === 'unknown') Reflect.set(mappings[0], 'phaseId', 'seed-valid');
      if (kind === 'duplicate-phase') mappings[1] = { ...mappings[0], taskId: 'different' };
      if (kind === 'duplicate-task') mappings[1].taskId = mappings[0].taskId;
      if (kind === 'marker') Reflect.set(mappings[0], 'marker', '<!-- other -->');
      if (kind === 'policy') Reflect.set(mappings[0], 'policy', 'checkboxes');
      if (kind === 'task-id') mappings[0].taskId = 'two tasks';
      if (kind === 'sparse') Reflect.deleteProperty(mappings, '0');
      expect(() => api().read({ ...value, phaseTaskMapping: mappings })).toThrow();
    }
  );

  it('never evaluates metadata, construction or array-entry hooks', () => {
    const hook = vi.fn(() => 'synthetic');
    const value = metadata(), changed = { ...value }, creation = { ...input };
    Object.defineProperty(changed, 'owner', { enumerable: true, get: hook });
    Object.defineProperty(creation, 'owner', { enumerable: true, get: hook });
    const mappings = [...value.phaseTaskMapping];
    Object.defineProperty(mappings, '0', { enumerable: true, get: hook });
    expect(() => api().read(changed)).toThrow(/data field/);
    expect(() => api().create(creation)).toThrow(/data field/);
    expect(() => api().read({ ...value, phaseTaskMapping: mappings })).toThrow(/data entry/);
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('modern exact task projection values', () => {
  it('changes only mapped checkbox bytes while preserving CRLF, prose and metadata', () => {
    const contract = api(), value = contract.create(input), markdown = tasks(value), before = contract.encode(value);
    const first = value.phaseTaskMapping[0], states = pending(contract);
    states[first.phaseId] = 'verified';
    const projected = contract.projectTasks(markdown, value, states);
    expect(projected.markdown).toBe(markdown.replace(`- [ ] ${first.taskId} `, `- [x] ${first.taskId} `));
    expect(projected.changes).toEqual([{ phaseId: first.phaseId, taskId: first.taskId, fromChecked: false, toChecked: true, state: 'verified' }]);
    expect(contract.taskLayoutHash(projected.markdown, value)).toBe(contract.taskLayoutHash(markdown, value));
    expect(projected.markdown).toContain('- [X] user-note Leave this alone.\r\n');
    expect(contract.encode(value)).toBe(before);
  });

  it('supports calculated state records and clears identity-incompatible old checkboxes', () => {
    const contract = api(), value = metadata(), markdown = tasks(value).replaceAll('- [ ]', '- [x]');
    const states = Object.fromEntries(contract.graph.phases.map(phase => [phase.id, { state: 'identity-incompatible' }]));
    expect(contract.projectTasks(markdown, value, states).markdown).toBe(tasks(value));
  });

  it.each(['missing', 'extra', 'unknown', 'extra-state-fields', 'hook'] as const)('rejects incomplete or non-data calculated states: %s', kind => {
    const contract = api(), value = metadata(), states: Record<string, unknown> = pending(contract);
    const first = value.phaseTaskMapping[0].phaseId, hook = vi.fn(() => 'verified');
    if (kind === 'missing') delete states[first];
    if (kind === 'extra') states['seed-valid'] = 'verified';
    if (kind === 'unknown') states[first] = 'historically-complete';
    if (kind === 'extra-state-fields') states[first] = { state: 'verified', approval: true };
    if (kind === 'hook') Object.defineProperty(states, first, { enumerable: true, get: hook });
    expect(() => contract.projectTasks(tasks(value), value, states)).toThrow();
    expect(hook).not.toHaveBeenCalled();
  });

  it.each(['missing-marker', 'duplicate-marker', 'duplicate-task'] as const)('rejects ambiguous task source: %s', kind => {
    const contract = api(), value = metadata(), first = value.phaseTaskMapping[0];
    const original = tasks(value);
    const markdown = kind === 'missing-marker' ? original.replace(first.marker, '') :
      kind === 'duplicate-marker' ? original + first.marker : original + `- [ ] ${first.taskId} Duplicate\r\n`;
    expect(() => contract.projectTasks(markdown, value, pending(contract))).toThrow(/registered phase marker/);
  });

  it('enforces the exact UTF-8 task-source byte limit', () => {
    const contract = api(), value = metadata(), original = tasks(value);
    const maximum = original + 'a'.repeat(262_144 - Buffer.byteLength(original));
    expect(contract.projectTasks(maximum, value, pending(contract)).markdown).toBe(maximum);
    expect(() => contract.projectTasks(maximum + 'a', value, pending(contract))).toThrow(/256-KiB/);
    expect(() => contract.projectTasks(maximum.slice(0, -1) + '\u00e9', value, pending(contract))).toThrow(/256-KiB/);
  });
});
