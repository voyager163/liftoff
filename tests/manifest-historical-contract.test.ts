import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { projectCatalog } from '../src/application/project/catalog.js';
import { parseManifest } from '../src/application/project/manifest.js';
import type { LiftoffManifest, ManifestManagedArtifact } from '../src/domain/project/contracts.js';
import { managedCoreArtifactPaths, retiredManagedCoreIdentities } from '../src/domain/project/artifact-lifecycle.js';
import { governanceAgentIntegrations } from '../src/domain/project/catalog.js';
import { createManifestReader } from '../src/domain/project/manifest/reader.js';
import { createManifestGovernanceReader } from '../src/domain/project/manifest/governance.js';
import { validateReadableActivationIdentity } from '../src/domain/governance/activation/validators.js';
import { interpretManifest } from '../scripts/contract-baseline.mjs';

const baselineRoot = new URL('./fixtures/contract-baseline-0.12.3/', import.meta.url);
const readBaseline = (file: string) => readFileSync(new URL(file, baselineRoot));
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const defectFixtures = [
  ['0.8.0-standard-go', 'fe21bf9833fce14d74a1cfd83affb3aac9ff693933f4072ef0aafe2abf1a3d3c'],
  ['0.8.0-genai-rag', 'c3b75523cb93749e1d452f8262f584d2e93f170bef191c8fa657fcbd779030a6'],
  ['0.9.9-standard-go', '8ad07fd1693d726cce549dc6bac8e9daadd73fabccb41457e3515590054f9523'],
  ['0.9.9-genai-rag', '1d80a15c516608afc30b5f8891939593e0d72e53abef448e3403484c14402317']
] as const;
// Derived from the immutable source records and historical lifecycle rules,
// not recaptured from the current renderer or reader.
const correctedInterpretations = [
  ['0.8.0-standard-go', 5, '0.8.0', 26,
    'eb347a81527088cdb2ce7fd38ca94dde03564fc42d27e1f11a1affdc6977aac0',
    'b369a3971f41e775adaf8cb347c13adeeb15c6e8c301ca4dacbdf48d83fa15a7'],
  ['0.8.0-genai-rag', 5, '0.8.0', 72,
    '72ae2698c459fd00e888fa7f76aff8ea54797b39fd41e023f387c34f13b28d84',
    'c217b541f5553e94cc659ba134ffb56284960baed4a2e0c4ca76fa9a74358f60'],
  ['0.9.9-standard-go', 6, '0.9.9', 26,
    'f766aa0e812ce866516d11bd1a15b62aa5b575346e3db058122a0479c4b752dd',
    'f421c5c90de817f3f1f409f5827c14dcb53ca75bda7cf9282ce75ae8ee9504cb'],
  ['0.9.9-genai-rag', 6, '0.9.9', 72,
    '782f0ed1bcde274a88ebf10cfb49c885e5cbdda5d79a6a4a6ac9c2fc2d7780e6',
    'b781d26a2d3472517fc663eaade7507df01d8e06335cfb677121cad04b755670']
] as const;
const historicalCommon = [
  'repository-governance-policy',
  'repository-governance-context',
  'repository-governance-guide'
];
const activationCommon = [
  'repository-governance-phase-graph',
  'repository-governance-compatibility',
  'repository-governance-credential-policy-schema'
];
const copilotAlias = retiredManagedCoreIdentities[0];
const claudeAlias = retiredManagedCoreIdentities[1];

type Fixture = Omit<LiftoffManifest, 'managedArtifacts'> & {
  managedArtifacts?: ManifestManagedArtifact[];
  artifacts?: ManifestManagedArtifact[];
};

function fixture(name = '0.9.9-standard-go'): Fixture {
  return JSON.parse(readBaseline(`manifests/${name}.json`).toString('utf8')) as Fixture;
}

function inventory(value: Fixture): ManifestManagedArtifact[] {
  const entries = value.artifactVersion < 6 ? value.artifacts : value.managedArtifacts;
  if (!entries) throw new Error('The fixture has no recorded artifact inventory.');
  return entries;
}

function removeArtifact(value: Fixture, name: string): void {
  const entries = inventory(value);
  entries.splice(entries.findIndex((entry) => entry.logicalName === name), 1);
}

function enabled(value: Fixture) {
  if (value.governance.profile === 'none' || value.governance.profile === 'unspecified') {
    throw new Error('The fixture must record enabled governance.');
  }
  return value.governance;
}

function context(policyVersion = '6') {
  return {
    catalog: projectCatalog,
    policyVersion,
    minimumLiftoffVersion: '0.10.0',
    validateActivationIdentity: validateReadableActivationIdentity,
    governanceArtifactPaths: managedCoreArtifactPaths
  };
}

function currentArtifact(logicalName: string): ManifestManagedArtifact {
  const entry = inventory(fixture('0.12.3-standard-go')).find((artifact) => artifact.logicalName === logicalName);
  if (!entry) throw new Error(`The frozen v7 fixture lacks ${logicalName}.`);
  return entry;
}

describe('authentic historical manifest contracts', () => {
  it.each(correctedInterpretations)('matches the source-derived normalized observation for %s',
    (name, artifactVersion, liftoffVersion, projectArtifacts, generationHashes, interpretationSha256) => {
      expect(interpretManifest({ fileSystem: { parseManifest } },
        readBaseline(`manifests/${name}.json`).toString('utf8'))).toEqual({
        ok: true, artifactVersion, liftoffVersion, managedArtifacts: 4, projectArtifacts,
        generationHashes, interpretationSha256
      });
    });

  it.each(defectFixtures)('reads %s without changing original identity, bytes or generation hashes', (name, sha256) => {
    const bytes = readBaseline(`manifests/${name}.json`);
    expect(digest(bytes)).toBe(sha256);
    const raw = fixture(name);
    const original = structuredClone(raw);
    const parsed = parseManifest(raw);
    expect(raw).toEqual(original);
    expect(parsed.artifactVersion).toBe(raw.artifactVersion);
    expect(parsed.liftoffVersion).toBe(raw.liftoffVersion);
    expect(parsed.project).toEqual(raw.project);
    expect(parsed.framework).toEqual(raw.framework);
    expect(parsed.governance).toEqual(raw.governance);
    expect(parsed.governance).not.toHaveProperty('activationIdentity');
    expect(parsed).not.toHaveProperty('plugins');
    expect(parsed).not.toHaveProperty('activeLayout');
    expect(parsed.managedArtifacts).toEqual(inventory(raw).filter((entry) =>
      [...historicalCommon, copilotAlias.logicalName].includes(entry.logicalName)));
    if (raw.artifactVersion === 6) {
      expect(parsed.projectArtifacts).toEqual(raw.projectArtifacts);
    } else {
      expect(parsed.projectArtifacts.length).toBeGreaterThan(0);
      for (const artifact of parsed.projectArtifacts) {
        const recorded = inventory(raw).find((entry) => entry.logicalName === artifact.logicalName);
        expect(recorded).toBeDefined();
        expect(artifact).toMatchObject({
          category: recorded!.category,
          pathParts: recorded!.pathParts,
          generationHash: recorded!.contentHash,
          generatedBy: raw.liftoffVersion
        });
      }
    }
    expect(readBaseline(`manifests/${name}.json`)).toEqual(bytes);
  });

  it('preserves every other frozen reader interpretation exactly', () => {
    const baseline = JSON.parse(readBaseline('manifest-readers.json').toString('utf8')) as {
      capturedManifests: { file: string }[];
      existingFixtures: Record<string, string>;
      interpretations: Record<string, unknown>;
    };
    const corrected = new Set(defectFixtures.map(([name]) => `manifests/${name}.json`));
    for (const { file } of baseline.capturedManifests) {
      if (corrected.has(file)) continue;
      expect(interpretManifest({ fileSystem: { parseManifest } }, readBaseline(file).toString('utf8')), file)
        .toEqual(baseline.interpretations[file]);
    }
    for (const [file, sha256] of Object.entries(baseline.existingFixtures)) {
      const text = readFileSync(file, 'utf8');
      expect(digest(text.replace(/\r\n/g, '\n'))).toBe(sha256);
      expect(interpretManifest({ fileSystem: { parseManifest } }, text), file)
        .toEqual(baseline.interpretations[file]);
    }
  });

  it.each(['0.8.0-standard-go', '0.9.9-standard-go'])('requires every historical common member in %s', (name) => {
    for (const logicalName of historicalCommon) {
      const raw = fixture(name);
      removeArtifact(raw, logicalName);
      expect(() => parseManifest(raw), logicalName).toThrow(`missing artifact ${logicalName}`);
    }
  });

  it.each(['0.8.0-standard-go', '0.9.9-standard-go'])('requires the selected historical launcher in %s', (name) => {
    const raw = fixture(name);
    removeArtifact(raw, copilotAlias.logicalName);
    expect(() => parseManifest(raw)).toThrow(/missing artifact .*copilot/);
  });

  it.each(['path', 'category'] as const)('rejects wrong historical common %s', (field) => {
    for (const name of ['0.8.0-standard-go', '0.9.9-standard-go']) {
      for (const logicalName of historicalCommon) {
        const raw = fixture(name);
        const entry = inventory(raw).find((artifact) => artifact.logicalName === logicalName)!;
        if (field === 'path') entry.pathParts = ['unowned', `${logicalName}.md`];
        else entry.category = 'project';
        expect(() => parseManifest(raw)).toThrow(`${logicalName} has invalid identity`);
      }
    }
  });

  it.each(['path', 'category', 'name'] as const)('rejects a non-exact retired launcher %s', (field) => {
    const raw = fixture();
    const entry = inventory(raw).find((artifact) => artifact.logicalName === copilotAlias.logicalName)!;
    if (field === 'path') entry.pathParts = ['.github', 'prompts', 'custom.prompt.md'];
    else if (field === 'category') entry.category = 'project';
    else entry.logicalName = 'repository-governance-unknown-launcher';
    expect(() => parseManifest(raw)).toThrow(/invalid identity|unknown retired/);
  });

  it('rejects a retired launcher placed in project provenance', () => {
    const raw = fixture();
    const entry = inventory(raw).find((artifact) => artifact.logicalName === copilotAlias.logicalName)!;
    removeArtifact(raw, entry.logicalName);
    raw.projectArtifacts.push({
      logicalName: entry.logicalName, category: entry.category, pathParts: entry.pathParts,
      generatedBy: raw.liftoffVersion, generationHash: entry.contentHash, provisioningGroup: 'base'
    });
    expect(() => parseManifest(raw)).toThrow('cannot contain a retired managed-core logical name');
  });

  it('validates the selected Claude historical launcher without granting adjacent path authority', () => {
    const raw = fixture();
    raw.project.agents = ['claude'];
    const entry = inventory(raw).find((artifact) => artifact.logicalName === copilotAlias.logicalName)!;
    entry.logicalName = claudeAlias.logicalName;
    entry.pathParts = [...claudeAlias.pathParts];
    expect(parseManifest(raw).managedArtifacts).toContainEqual(entry);
    entry.pathParts = ['.claude', 'commands', 'custom.md'];
    expect(() => parseManifest(raw)).toThrow('invalid identity');
  });

  it('rejects unselected historical launchers instead of declaring a complete handoff', () => {
    const raw = fixture();
    inventory(raw).push({
      logicalName: claudeAlias.logicalName, category: claudeAlias.category,
      pathParts: [...claudeAlias.pathParts], contentHash: `sha256:${'a'.repeat(64)}`
    });
    expect(() => parseManifest(raw)).toThrow(/inapplicable.*launcher/);
  });

  it.each(['setup', 'assessment', 'repair'] as const)('rejects an unselected %s integration', (kind) => {
    const raw = fixture();
    const integration = governanceAgentIntegrations.claude[kind];
    inventory(raw).push({
      logicalName: integration.logicalName, category: 'governance',
      pathParts: [...integration.pathParts], contentHash: `sha256:${'b'.repeat(64)}`
    });
    expect(() => parseManifest(raw)).toThrow(/inapplicable|missing artifact/);
    const current = fixture('0.12.3-standard-go');
    inventory(current).push(inventory(raw).at(-1)!);
    expect(() => parseManifest(current)).toThrow(`inapplicable ${kind} integration`);
  });

  it.each([...activationCommon, 'liftoff-setup-copilot', 'liftoff-governance-assess-copilot', 'liftoff-repair-copilot'])(
    'does not mistake mixed historical/current %s for a complete historical handoff', (logicalName) => {
      const raw = fixture();
      inventory(raw).push(currentArtifact(logicalName));
      expect(() => parseManifest(raw)).toThrow(/missing artifact/);
    }
  );

  it('does not accept a policy-6 handoff without the activation-era inventory', () => {
    const raw = fixture();
    enabled(raw).policyVersion = '6';
    expect(() => parseManifest(raw)).toThrow('missing artifact repository-governance-phase-graph');
  });

  it('rejects activation identity on a pre-v7 source rather than retagging it', () => {
    const raw = fixture();
    enabled(raw).activationIdentity = enabled(fixture('0.12.3-standard-go')).activationIdentity;
    expect(() => parseManifest(raw)).toThrow(/unknown field.*activationIdentity/);
  });
});

describe('historical policy validation is independent of current release policy', () => {
  it.each(['0.3.4-standard-go', '0.4.1-standard-go', '0.7.0-standard-go', '0.10.0-standard-go', '0.11.3-standard-go', '0.12.3-standard-go'])(
    'preserves %s interpretation when injected policy advances', (name) => {
      const raw: unknown = JSON.parse(readBaseline(`manifests/${name}.json`).toString('utf8'));
      expect(createManifestReader(context('7')).parseManifest(raw)).toEqual(parseManifest(raw));
    }
  );

  it.each([5, 6] as const)('preserves supported policy 1-6 for v%s without accepting policy 7', (version) => {
    const reader = createManifestGovernanceReader(context('7'));
    for (const policyVersion of ['1', '2', '3', '4', '5', '6']) {
      const governance = { profile: 'single-maintainer-gitflow', state: 'handoff-generated', policyVersion };
      expect(reader.normalizeManifestGovernance(governance, version)).toEqual(governance);
    }
    expect(() => reader.normalizeManifestGovernance({
      profile: 'single-maintainer-gitflow', state: 'handoff-generated', policyVersion: '7'
    }, version)).toThrow(/policyVersion.*7/);
  });

  it('rejects fabricated team governance before interpreting historical proof', () => {
    expect(() => createManifestGovernanceReader(context()).normalizeManifestGovernance({
      profile: 'team-gitflow',
      state: 'handoff-generated',
      policyVersion: '1'
    }, 7)).toThrow(/requires manifest v8/u);
  });

  it('rejects v7 policy 7 before an injected future identity validator can admit it', () => {
    const raw = fixture('0.12.3-standard-go');
    const originalIdentity = enabled(raw).activationIdentity!;
    const futureIdentity = { ...originalIdentity, policyVersion: '7' };
    const validateActivationIdentity = vi.fn(() => futureIdentity);
    const reader = createManifestReader({ ...context('7'), validateActivationIdentity });
    enabled(raw).policyVersion = '7';
    enabled(raw).activationIdentity = futureIdentity;
    expect(() => reader.parseManifest(raw)).toThrow(/policyVersion.*7/);
    expect(validateActivationIdentity).not.toHaveBeenCalled();
  });

  it.each(['1', '5', '7', '01', '0', 'future'])('rejects v7 policy %s', (policyVersion) => {
    const raw = fixture('0.12.3-standard-go');
    enabled(raw).policyVersion = policyVersion;
    expect(() => parseManifest(raw)).toThrow(/policyVersion/);
  });

  it('rejects mixed v7 policy/activation identities', () => {
    const raw = fixture('0.12.3-standard-go');
    const mixed = { ...enabled(raw).activationIdentity!, policyVersion: '5' };
    const reader = createManifestReader({ ...context(), validateActivationIdentity: () => mixed });
    expect(() => reader.parseManifest(raw)).toThrow('activationIdentity.policyVersion must match policyVersion');
  });

  it.each([2, 3, 4])('does not invent governance for historical v%s', (version) => {
    const reader = createManifestGovernanceReader(context('7'));
    expect(reader.normalizeManifestGovernance(undefined, version)).toEqual({ profile: 'unspecified', state: 'unspecified' });
  });
});

describe('existing complete, partial and retired v7 behavior stays unchanged', () => {
  it.each(['setup', 'assessment', 'repair'] as const)('checks the exact selected v7 %s category and path', (kind) => {
    for (const field of ['category', 'path']) {
      const raw = fixture('0.12.3-standard-go');
      const integration = governanceAgentIntegrations['github-copilot'][kind];
      const artifact = inventory(raw).find((entry) => entry.logicalName === integration.logicalName)!;
      if (field === 'category') artifact.category = 'project';
      else artifact.pathParts = ['unowned', 'custom.md'];
      expect(() => parseManifest(raw)).toThrow(`${integration.logicalName} has invalid identity`);
    }
  });

  it.each([...activationCommon, 'liftoff-setup-copilot'])('still requires v7 %s', (logicalName) => {
    const raw = fixture('0.12.3-standard-go');
    removeArtifact(raw, logicalName);
    expect(() => parseManifest(raw)).toThrow(`missing artifact ${logicalName}`);
  });

  it('does not substitute a retired launcher for the v7 setup integration', () => {
    const raw = fixture('0.10.0-standard-go');
    removeArtifact(raw, 'liftoff-setup-copilot');
    expect(() => parseManifest(raw)).toThrow('missing artifact liftoff-setup-copilot');
  });

  it.each([5, 6] as const)('retains already accepted activation-era inventories recorded as v%s', (version) => {
    const raw = fixture('0.12.3-standard-go');
    const recorded = inventory(raw);
    raw.artifactVersion = version;
    delete enabled(raw).activationIdentity;
    if (version === 5) {
      raw.artifacts = [
        ...recorded,
        ...raw.projectArtifacts.map(({ logicalName, category, pathParts, generationHash }) =>
          ({ logicalName, category, pathParts, contentHash: generationHash }))
      ];
      delete raw.managedArtifacts;
      Reflect.deleteProperty(raw, 'projectArtifacts');
    }
    for (const policyVersion of ['1', '2', '3', '4', '5', '6']) {
      enabled(raw).policyVersion = policyVersion;
      expect(parseManifest(raw).governance).toEqual(raw.governance);
    }
  });

  it('preserves partial historical handoffs without inventing missing members', () => {
    const raw = fixture();
    enabled(raw).state = 'handoff-partial';
    removeArtifact(raw, 'repository-governance-context');
    expect(parseManifest(raw).managedArtifacts).toEqual(raw.managedArtifacts);
    expect(parseManifest(raw).governance).toEqual(raw.governance);
  });

  it('accepts v7 partial only with genuine missing inventory or protected retirement debt', () => {
    const raw = fixture('0.12.3-standard-go');
    enabled(raw).state = 'handoff-partial';
    expect(() => parseManifest(raw)).toThrow('handoff-partial requires');
    inventory(raw).push({
      logicalName: copilotAlias.logicalName, category: copilotAlias.category,
      pathParts: [...copilotAlias.pathParts], contentHash: `sha256:${'c'.repeat(64)}`
    });
    expect(parseManifest(raw).managedArtifacts).toEqual(raw.managedArtifacts);
    removeArtifact(raw, copilotAlias.logicalName);
    removeArtifact(raw, 'repository-governance-guide');
    expect(parseManifest(raw).managedArtifacts).toEqual(raw.managedArtifacts);
  });

  it('keeps governance none and independent repair ownership distinct', () => {
    const raw = fixture('0.12.3-standard-go');
    raw.governance = { profile: 'none', state: 'disabled' };
    raw.managedArtifacts = [currentArtifact('liftoff-repair-copilot')];
    expect(parseManifest(raw).governance).toEqual(raw.governance);
    inventory(raw).push(currentArtifact('repository-governance-policy'));
    expect(() => parseManifest(raw)).toThrow('Disabled manifest governance cannot own');
  });
});
