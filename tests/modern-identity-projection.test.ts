import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { projectCatalog } from '../src/application/project/catalog.js';
import { createManifestV8ProjectReader } from '../src/domain/project/manifest/v8-project.js';
import { createModernActivationIdentityReader, type ModernIdentityCreationInput } from '../src/domain/governance/activation/modern-identity.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  modernActivationSourceContracts, readableModernActivationSourceContracts, modernActivationSourceIdentityTables
} from '../src/domain/governance/policy/identity.js';
import type {
  ModernActivationSelection, ModernGovernanceProfile, ModernWorkflow
} from '../src/domain/governance/activation/modern-record-contracts.js';
import { capturedV3Records } from './fixtures/activation-v3/fixture.js';
import { historyRecord } from '../src/governance-activation/history-contracts.js';

function context(profile: ModernGovernanceProfile, workflow: ModernWorkflow): ModernIdentityCreationInput {
  const manifest = historyRecord(capturedV3Records().manifest, 'manifest');
  const original = historyRecord(manifest.project, 'project');
  const project = {
    ...original, specWorkflow: workflow, agents: workflow === 'manual' ? [] : ['github-copilot', 'claude'],
    ...(workflow === 'spec-kit' ? { defaultAgent: 'github-copilot' } : {})
  };
  if (workflow !== 'spec-kit') Reflect.deleteProperty(project, 'defaultAgent');
  const framework = workflow === 'manual' ? { state: 'not-required' } :
    { state: 'initialized', adapter: workflow, contractVersion: '1.2.3' };
  const selection: ModernActivationSelection = {
    ...createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({ project, framework }), profile
  };
  return {
    sourceVersion: '0.13.0-dev.0', profile, policyVersion: profile === 'team-gitflow' ? '1' : '7',
    selection,
    pluginResolutionDigest: `sha256:${canonicalSha256({ unitOnly: 'independent plugin commitment' })}`,
    activeLayoutDigest: `sha256:${canonicalSha256({ unitOnly: 'independent layout commitment' })}`
  };
}

describe('identity-only source projection without authority or graph changes', () => {
  it('preserves current and historical table ordering without copying graph-bearing records', () => {
    const tables = modernActivationSourceIdentityTables();
    expect(tables.current).toEqual(modernActivationSourceContracts().map(source => source.identity));
    expect(tables.readable).toEqual(readableModernActivationSourceContracts().map(source => source.identity));
    for (const identity of [...tables.current, ...tables.readable]) {
      expect(identity).not.toHaveProperty('graph');
      expect(Object.values(identity).every(value => typeof value === 'string' || typeof value === 'number')).toBe(true);
    }
  });

  it('returns fresh frozen arrays and scalar rows without exposing the private source tables', () => {
    const first = modernActivationSourceIdentityTables();
    const second = modernActivationSourceIdentityTables();
    expect(first).not.toBe(second);
    expect(first.current).not.toBe(second.current);
    expect(first.readable).not.toBe(second.readable);
    expect(Object.isFrozen(first)).toBe(true);
    for (const name of ['current', 'readable'] as const) {
      expect(Object.isFrozen(first[name])).toBe(true);
      for (const [index, row] of first[name].entries()) {
        expect(row).not.toBe(second[name][index]);
        expect(Object.isFrozen(row)).toBe(true);
        expect(Reflect.set(row, 'policyVersion', 'changed')).toBe(false);
        expect(row).toEqual(second[name][index]);
      }
    }
  });

  it('preserves the original full-contract fresh-copy and deep-freeze interface', () => {
    const first = modernActivationSourceContracts();
    const second = modernActivationSourceContracts();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first[0].graph).not.toBe(second[0].graph);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0].graph)).toBe(true);
    expect(Reflect.set(first[0].identity, 'policyVersion', 'changed')).toBe(false);
  });

  it('does not clone full phase graphs that the identity reader never consumes', () => {
    const original = globalThis.structuredClone;
    let fullGraphClones = 0;
    const observe: typeof globalThis.structuredClone = (value, options) => {
      if (Array.isArray(value) && value.some((entry: unknown) =>
        typeof entry === 'object' && entry !== null && Object.hasOwn(entry, 'graph')
      )) fullGraphClones++;
      return original(value, options);
    };
    globalThis.structuredClone = observe;
    try {
      const reader = createModernActivationIdentityReader(projectCatalog);
      expect(reader.identityForSource(context('single-maintainer-gitflow', 'manual')).activationContractVersion).toBe(5);
    } finally {
      globalThis.structuredClone = original;
    }
    expect(fullGraphClones).toBe(0);
  });

  it('preserves every exact current and readable identity result and caller input', async () => {
    const reader = createModernActivationIdentityReader(projectCatalog);
    const current = modernActivationSourceContracts();
    const readable = readableModernActivationSourceContracts();
    const vectors = readable.map(source => {
      const request = structuredClone(context(source.identity.profile, source.identity.workflow));
      const before = structuredClone(request);
      const recordedIdentity = reader.identityForReadableSource({ ...request, phaseGraphHash: source.identity.phaseGraphHash });
      const { sourceVersion: _version, ...input } = request;
      const validated = reader.validateReadableModernActivationIdentity({ ...input, recordedIdentity });
      expect(recordedIdentity).toMatchObject(source.identity);
      expect(validated).toEqual(recordedIdentity);
      expect(Object.keys(validated)).toHaveLength(17);
      expect(Object.isFrozen(validated)).toBe(true);
      expect(request).toEqual(before);
      expect(Object.isFrozen(request.selection.project)).toBe(false);
      return { request, recordedIdentity, validated, current: reader.identityForSource(request) };
    });
    expect(current).toHaveLength(6);
    expect(readable).toHaveLength(18);
    const output = process.env.LIFTOFF_IDENTITY_PROJECTION_OUTPUT;
    if (output) await writeFile(output, JSON.stringify({
      currentIdentities: current.map(source => source.identity),
      readableIdentities: readable.map(source => source.identity),
      fullContractDigests: {
        current: canonicalSha256(current), readable: canonicalSha256(readable)
      },
      vectors
    }, null, 2) + '\n', { flag: 'wx' });
  });
});
