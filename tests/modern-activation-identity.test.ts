import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { projectCatalog } from '../src/application/project/catalog.js';
import { createManifestV8ProjectReader } from '../src/domain/project/manifest/v8-project.js';
import { createModernActivationIdentityReader, type ModernIdentityCreationInput } from '../src/domain/governance/activation/modern-identity.js';
import type {
  ModernActivationSelection, ModernDigest, ModernGovernanceProfile, ModernWorkflow, ReadableModernActivationIdentity
} from '../src/domain/governance/activation/modern-record-contracts.js';
import { modernActivationSourceContracts, releasedV3ActivationIdentity } from '../src/domain/governance/policy/identity.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { capturedV3Records } from './fixtures/activation-v3/fixture.js';
import { historyRecord } from '../src/governance-activation/history-contracts.js';

const reader = createModernActivationIdentityReader(projectCatalog);
const projectReader = createManifestV8ProjectReader(projectCatalog);
// Opaque commitments exercise the pure validator's relations, not a qualified modern registry.
const unitPlugin: ModernDigest = `sha256:${canonicalSha256({ testOnly: 'independently supplied plugin commitment' })}`;
const unitLayout: ModernDigest = `sha256:${canonicalSha256({ testOnly: 'independently supplied layout commitment' })}`;
function context(profile: ModernGovernanceProfile = 'single-maintainer-gitflow', workflow: ModernWorkflow = 'openspec',
  state: 'initialized' | 'legacy' = 'initialized'): ModernIdentityCreationInput {
  const manifest = historyRecord(capturedV3Records().manifest, 'manifest'), original = historyRecord(manifest.project, 'project');
  const project = { ...original, specWorkflow: workflow,
    agents: workflow === 'manual' || state === 'legacy' ? [] : ['github-copilot', 'claude'],
    ...(workflow === 'spec-kit' && state === 'initialized' ? { defaultAgent: 'github-copilot' } : {}) };
  if (workflow !== 'spec-kit' || state === 'legacy') Reflect.deleteProperty(project, 'defaultAgent');
  const framework = workflow === 'manual' ? { state: 'not-required' } :
    state === 'legacy' ? { state, adapter: workflow } : { state, adapter: workflow, contractVersion: '1.2.3' };
  const selection: ModernActivationSelection = { ...projectReader.validateManifestV8Project({ project, framework }), profile };
  return { sourceVersion: '0.13.0-dev.0', profile, policyVersion: profile === 'team-gitflow' ? '1' : '7',
    selection, pluginResolutionDigest: unitPlugin, activeLayoutDigest: unitLayout };
}
function input(source = context()) {
  const { sourceVersion: _source, ...data } = source;
  return { recordedIdentity: reader.identityForSource(source), ...data };
}

describe('pure modern identity/context relations; full source registry qualification is separate', () => {
  it.each(modernActivationSourceContracts())('uses the actual $identity.profile/$identity.workflow row and complete M6 leaf', source => {
    const value = input(context(source.identity.profile, source.identity.workflow));
    const parsed = reader.validateReadableModernActivationIdentity(value);
    expectTypeOf(parsed).toEqualTypeOf<ReadableModernActivationIdentity>();
    expect(Object.keys(parsed)).toHaveLength(17);
    expect(parsed).toEqual(value.recordedIdentity);
    expect(parsed).toMatchObject(source.identity);
    expect(parsed.sourceSelectionDigest).toBe(`sha256:${canonicalSha256({
      kind: 'liftoff-activation-source-selection', schemaVersion: 1, profile: value.profile,
      project: value.selection.project, framework: value.selection.framework
    })}`);
    expect(parsed).not.toHaveProperty('compatible');
    expect(parsed).not.toHaveProperty('executable');
    expect(parsed).not.toHaveProperty('approved');
  });

  it.each(Object.keys(input().recordedIdentity))('rejects a substituted %s without comparing versions by order', field => {
    const value = input(), identity = { ...value.recordedIdentity };
    Reflect.set(identity, field, typeof Reflect.get(identity, field) === 'number' ? 99 : 'changed');
    expect(() => reader.validateReadableModernActivationIdentity({ ...value, recordedIdentity: identity })).toThrow();
  });

  it.each(['name', 'region', 'environments', 'framework-contract', 'default-agent'] as const)('binds %s omitted by a plugin-only digest', field => {
    let source = context('single-maintainer-gitflow', 'spec-kit');
    if (field === 'environments') {
      const project = { ...source.selection.project, workload: { ...source.selection.project.workload, environments: ['dev', 'staging', 'prod'] } };
      source = { ...source, selection: {
        ...projectReader.validateManifestV8Project({ project, framework: source.selection.framework }), profile: source.profile
      } };
    }
    const value = input(source);
    const selection = structuredClone(value.selection);
    if (field === 'name') Reflect.set(selection.project, 'name', 'another-recorded-project');
    if (field === 'region') Reflect.set(selection.project.workload, 'region',
      projectCatalog.listRegions('azure').find(region => region.slug !== selection.project.workload.region)!.slug);
    if (field === 'environments') Reflect.set(selection.project.workload, 'environments', [...selection.project.workload.environments].reverse());
    if (field === 'framework-contract') Reflect.set(selection.framework, 'contractVersion', '1.2.4');
    if (field === 'default-agent') Reflect.set(selection.project, 'defaultAgent', 'claude');
    expect(() => reader.validateReadableModernActivationIdentity({ ...value, selection })).toThrow(/complete source contract/);
  });

  it('retains external legacy uncertainty instead of inferring initialization, agents or versions', () => {
    const legacy = context('single-maintainer-gitflow', 'openspec', 'legacy'), value = input(legacy);
    expect(value.selection.framework).toEqual({ state: 'legacy', adapter: 'openspec' });
    expect(value.selection.project.agents).toEqual([]);
    expect(reader.validateReadableModernActivationIdentity(value)).toEqual(value.recordedIdentity);
    const initialized = input(context());
    expect(() => reader.validateReadableModernActivationIdentity({ ...initialized, selection: value.selection })).toThrow(/complete source contract/);
    const malformed = structuredClone(value);
    Reflect.set(malformed.selection.framework, 'contractVersion', '1.2.3');
    expect(() => reader.validateReadableModernActivationIdentity(malformed)).toThrow();
  });

  it('requires Manual not-required/no-framework/no-default while allowing explicit optional agents', () => {
    const source = context('team-gitflow', 'manual'), value = input(source);
    expect(value.selection.framework).toEqual({ state: 'not-required' });
    expect(value.selection.project.agents).toEqual([]);
    const agents = structuredClone(source);
    Reflect.set(agents.selection.project, 'agents', ['claude']);
    const selected = input(agents);
    expect(reader.validateReadableModernActivationIdentity(selected)).toEqual(selected.recordedIdentity);
    for (const [target, field, member] of [
      ['framework', 'adapter', 'openspec'], ['framework', 'contractVersion', '1.2.3'],
      ['project', 'defaultAgent', 'claude']
    ] as const) {
      const bad = structuredClone(selected);
      Reflect.set(bad.selection[target], field, member);
      expect(() => reader.validateReadableModernActivationIdentity(bad)).toThrow();
    }
  });

  it('does not admit legacy tuples, none-profile activation, future sources or cross-profile consent', () => {
    const single = input(), team = input(context('team-gitflow'));
    expect(() => reader.validateReadableModernActivationIdentity({ ...single, recordedIdentity: releasedV3ActivationIdentity })).toThrow();
    expect(() => reader.validateReadableModernActivationIdentity({ ...team, recordedIdentity: single.recordedIdentity })).toThrow();
    expect(() => reader.validateReadableModernActivationIdentity({ ...single, policyVersion: '6' })).toThrow();
    const none = structuredClone(single);
    Reflect.set(none, 'profile', 'none'); Reflect.set(none.selection, 'profile', 'none');
    expect(() => reader.validateReadableModernActivationIdentity(none)).toThrow();
    const future = structuredClone(context()); Reflect.set(future, 'sourceVersion', '0.13.0');
    expect(() => reader.identityForSource(future)).toThrow();
  });

  it.each(['pluginResolutionDigest', 'activeLayoutDigest'] as const)('uses independent %s rather than echoing the recorded identity', field => {
    const value = input();
    const changed: ModernDigest = `sha256:${canonicalSha256({ changed: field })}`;
    expect(() => reader.validateReadableModernActivationIdentity({ ...value, [field]: changed })).toThrow(/complete source contract/);
    const malformed = { ...value };
    Reflect.set(malformed, field, 'sha256:incomplete');
    expect(() => reader.validateReadableModernActivationIdentity(malformed)).toThrow(/complete prefixed/);
  });

  it('rejects hooks, extras, undefined fields and sparse arrays without running getters or toJSON', () => {
    const getter = vi.fn(() => { throw new Error('unexpected getter'); });
    const variants = [
      { ...input(), extra: undefined },
      { ...input(), recordedIdentity: { ...input().recordedIdentity, toJSON: getter } },
      { ...input(), activeLayoutDigest: undefined }
    ];
    for (const value of variants) expect(() => Reflect.apply(reader.validateReadableModernActivationIdentity, undefined, [value])).toThrow();
    const accessor = { ...input().recordedIdentity };
    Object.defineProperty(accessor, 'phaseGraphHash', { enumerable: true, get: getter });
    expect(() => reader.validateReadableModernActivationIdentity({ ...input(), recordedIdentity: accessor })).toThrow(/own enumerable data/);
    const selection = structuredClone(input().selection);
    Reflect.set(selection.project, 'agents', new Array(1));
    expect(() => reader.validateReadableModernActivationIdentity({ ...input(), selection })).toThrow(/dense/);
    expect(getter).not.toHaveBeenCalled();
  });

  it('copies/freeze outputs without freezing or normalizing the caller by mutation', () => {
    const value = structuredClone(input()), before = structuredClone(value);
    expect(Object.isFrozen(value.selection.project)).toBe(false);
    const parsed = reader.validateReadableModernActivationIdentity(value);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed).not.toBe(value.recordedIdentity);
    expect(value).toEqual(before);
    expect(Object.isFrozen(value.selection.project)).toBe(false);
  });
});
