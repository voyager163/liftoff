import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildModernManagedCore, resolveModernManagedCoreInput, type ModernManagedCoreArtifact
} from '../src/application/project/modern-managed-core.js';
import {
  findModernActiveArtifactBinding, findModernActiveComponentBinding, resolveModernProjectSourceContext
} from '../src/application/project/source-context.js';
import { createManifestV8Candidate, type ManagedManifestDecision } from '../src/application/project/manifest-writer.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { parseManifest, resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { composeModernManifestPlugins } from '../src/application/project/plugins.js';
import { createManifestV8ProjectReader, type ManifestV8ProjectLeaf } from '../src/domain/project/manifest/v8-project.js';
import { readManifestPluginMetadata } from '../src/domain/project/manifest/plugins.js';
import { createManifestV8Reader } from '../src/domain/project/manifest/v8.js';
import { createManifestHistoryIndex, encodeManifestHistoryIndex } from '../src/domain/project/manifest/history.js';
import { manifestActiveLayoutDigest, validateManifestActiveLayout } from '../src/domain/project/manifest/layout.js';
import { createModernGovernanceContextContract } from '../src/domain/governance/policy/modern-context.js';
import { renderCredentialPolicySchema, renderModernCredentialPolicySchema } from '../src/domain/governance/activation/credential-policy-schema.js';
import { createModernCompatibilityContract } from '../src/governance-activation/modern-compatibility.js';
import { createModernActivationRecordContract } from '../src/domain/governance/activation/modern-records.js';
import { validateHistoricalV3CredentialPolicy } from '../src/governance-activation/historical-v3.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { governanceAgentIntegrations } from '../src/domain/project/catalog.js';
import { isRetiredManagedCoreLogicalName } from '../src/domain/project/artifact-lifecycle.js';
import { nativeIntegrationHeader, renderRepairInstructions, renderRepairIntegration } from '../src/generators/governance/integrations.js';
import { renderModernGovernanceGuide, renderModernGovernanceIntegration } from '../src/generators/governance/modern-handoff.js';
import { toSafeProjectName } from '../src/domain/project/planning.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { buildArtifacts } from '../src/templates.js';
import { modernSourceRegistry } from '../src/application/project/modern-plugins.js';
import { capturedV3Records } from './fixtures/activation-v3/fixture.js';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const contracts = { catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract };
const contexts = createModernGovernanceContextContract(contracts);
const compatibility = createModernCompatibilityContract(contracts);
const rootReader = createManifestV8Reader(contracts);
const projectReader = createManifestV8ProjectReader(projectCatalog);
const workflows = ['openspec', 'spec-kit', 'manual'] as const;
const profiles = ['none', 'single-maintainer-gitflow', 'team-gitflow'] as const;
const agentSets = [
  [], ['github-copilot'], ['claude'], ['codex'], ['github-copilot', 'claude'],
  ['github-copilot', 'codex'], ['claude', 'codex'], ['github-copilot', 'claude', 'codex']
];
const variants = [
  ...['python-fastapi', 'node-fastify', 'go-huma'].map((apiStack) => ({ kind: 'standard', apiStack })),
  ...projectCatalog.patterns.map(({ id }) => ({ kind: 'genai', apiStack: 'python-fastapi', pattern: id }))
];
const text = (files: readonly ModernManagedCoreArtifact[], name: string) => {
  const found = files.find((file) => file.logicalName === name);
  if (!found) throw new Error(`Missing rendered ${name}.`);
  return found.content;
};

function fromLeaf(leaf: ManifestV8ProjectLeaf, profile: (typeof profiles)[number], activeLayout: unknown) {
  const workload = leaf.project.workload;
  const composition = composeModernManifestPlugins({
    workload: workload.kind, ...(workload.kind === 'genai' ? { variant: workload.pattern } : {}),
    stack: workload.apiStack, cloud: workload.cloud, workflow: leaf.project.specWorkflow,
    agents: leaf.project.agents, frontend: workload.frontend ? 'included' : 'omitted',
    governanceProfile: profile, environments: workload.environments
  }, { safeProjectName: toSafeProjectName(leaf.project.name) });
  const plugins = readManifestPluginMetadata({
    schemaVersion: 1, resolutionDigest: composition.resolution.digest, selections: composition.resolution.plugins
  }, { stack: workload.apiStack, cloud: workload.cloud, workflow: leaf.project.specWorkflow, agents: leaf.project.agents });
  return { selection: { ...leaf, profile }, plugins, activeLayout };
}

function fixture(
  workflow: (typeof workflows)[number] = 'openspec',
  profile: (typeof profiles)[number] = 'single-maintainer-gitflow',
  agents = ['github-copilot'],
  workload: { kind: string; apiStack: string; pattern?: string } = variants[1],
  activeLayout: unknown = { schemaVersion: 1, state: 'unresolved', bindings: [] }
) {
  const leaf = projectReader.validateManifestV8Project({
    project: {
      name: 'Managed Core Source', workload: { ...workload, cloud: 'azure', region: 'eastus', frontend: true, environments: ['prod', 'dev'] },
      specWorkflow: workflow, agents, ...(workflow === 'spec-kit' && agents.length ? { defaultAgent: agents.at(-1) } : {})
    },
    framework: workflow === 'manual' ? { state: 'not-required' } : {
      state: agents.length ? 'initialized' : 'legacy', adapter: workflow,
      ...(agents.length ? { contractVersion: projectCatalog.getFrameworkDefinition(workflow).version } : {})
    }
  });
  return fromLeaf(leaf, profile, activeLayout);
}

describe('real modern managed-core inventory and content', () => {
  it.each(variants)('produces complete $kind/$apiStack/$pattern managed bytes for all source contexts', (workload) => {
    for (const workflow of workflows) {
      for (const profile of profiles) {
        for (const [index, agents] of agentSets.entries()) {
          const layout = index % 2 === 0 ? { schemaVersion: 1, state: 'unresolved', bindings: [] } :
            { schemaVersion: 1, state: 'bound', bindings: [{ kind: 'component', component: 'backend', pathParts: ['Services', 'Custom API'] }] };
          const input = fixture(workflow, profile, [...agents], workload, layout);
          const before = structuredClone(input);
          const files = buildModernManagedCore(input);
          const source = resolveModernManifestV8SourceContract({ selection: input.selection, recordedPlugins: input.plugins });
          expect(input).toEqual(before);
          expect(files.map(({ logicalName, category, pathParts, lifecycle }) => ({ logicalName, category, pathParts, lifecycle })))
            .toEqual(source.managedArtifacts.map((entry) => ({ ...entry, lifecycle: 'managed-core' })));
          expect(files).toHaveLength(profile === 'none' ? agents.length * 2 : 6 + agents.length * 4);
          expect(Object.isFrozen(files)).toBe(true);
          expect(files.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.pathParts) && entry.content.length > 0)).toBe(true);
          expect(files.some((entry) => entry.logicalName === 'manifest' || entry.logicalName === 'liftoff-config')).toBe(false);
          if (profile !== 'none') {
            if (!('identity' in source.governanceSource)) throw new Error('Expected actual enabled source.');
            const row = source.governanceSource;
            expect(text(files, 'repository-governance-policy')).toBe(readFileSync(path.join(...row.policyPathParts), 'utf8'));
            expect(`sha256:${sha(text(files, 'repository-governance-policy'))}`).toBe(row.identity.policyDigest);
            expect(text(files, 'repository-governance-phase-graph')).toBe(canonicalJson(row.graph));
            const context = contexts.validateModernGovernanceContext(JSON.parse(text(files, 'repository-governance-context')));
            expect(context.project).toEqual(input.selection.project);
            expect(context.framework).toEqual(input.selection.framework);
            expect(context.activeLayout).toEqual(layout);
            expect(context.governance.liveEnforcement).toBe('not-observed');
            expect(context.execution).toBe('source-contract-only');
            expect(context.sourceInterpretation).toEqual({
              filesystemObservation: 'not-performed', generationProvenance: 'not-inferred',
              localVerification: 'requires-reviewed-operation', externalDiscovery: 'not-performed'
            });
            expect(context).not.toHaveProperty('commands');
            expect(context).not.toHaveProperty('generatedBoundaries');
            expect(context).not.toHaveProperty('supportedStack');
            expect(text(files, 'repository-governance-compatibility')).toBe(
              canonicalJson(compatibility.buildModernCompatibilityMetadataForSource(input)));
            const schema = JSON.parse(text(files, 'repository-governance-credential-policy-schema'));
            expect(schema.properties.schemaVersion).toEqual({ const: 2 });
            expect(schema.properties.identity.required).toHaveLength(17);
            expect(schema.properties.identity.properties).toEqual(Object.fromEntries(
              Object.entries(context.governance.activationIdentity).map(([field, value]) => [field, { const: value }])));
          } else {
            expect(files.every((entry) => /^liftoff-(?:repair|assess)-/u.test(entry.logicalName))).toBe(true);
          }
          if (index === 0) expect(buildModernManagedCore(input)).toEqual(files);
        }
      }
    }
  }, 60_000);

  it('renders truthful Manual, legacy and profile guidance without claiming public availability', () => {
    for (const workflow of workflows) {
      for (const profile of ['single-maintainer-gitflow', 'team-gitflow'] as const) {
        const input = fixture(workflow, profile, []), files = buildModernManagedCore(input);
        const guide = text(files, 'repository-governance-guide');
        expect(guide).toContain('source-contract-only');
        expect(guide).toContain('Live enforcement: **not observed**');
        expect(guide).toContain('liftoff governance status --scope local --json');
        expect(guide).toContain('unsupported manifest or identity, STOP');
        expect(guide).toContain('Modern external source-metadata2 creation and task projection are not supplied');
        expect(guide).toContain('Context2 is managed interpretation, not activation source-metadata2');
        expect(guide).toContain('No checks or native completion evidence have been produced');
        expect(guide).toContain('Historical generation/adoption paths are provenance');
        expect(guide).toContain('Preserve existing CODEOWNERS and stronger controls');
        expect(guide).toContain('Pre-existing deployment and OpenTofu state changes remain planning-only');
        expect(guide).not.toContain('--execute');
        expect(guide).not.toContain('liftoff capabilities');
        expect(guide).toContain(profile === 'team-gitflow' ? 'one independent human approval' : 'zero additional human PR approvals');
        if (workflow === 'manual') {
          expect(guide).toContain('external framework as not-required');
          expect(guide).toContain('Manual remains CLI-only');
          expect(guide).toContain('no replacement specification framework');
        } else {
          expect(guide).toContain('legacy framework uncertainty');
          expect(guide).toContain('no recorded contract version and no configured agents');
        }
      }
    }
  });

  it('keeps exact native headers/paths and selected setup, assessment and repair boundaries', () => {
    const input = fixture('manual', 'team-gitflow', ['github-copilot', 'claude', 'codex']);
    const files = buildModernManagedCore(input);
    for (const agent of input.selection.project.agents) {
      for (const operation of ['setup', 'assessment', 'repair'] as const) {
        const integration = governanceAgentIntegrations[agent][operation];
        const artifact = files.find((entry) => entry.logicalName === integration.logicalName)!;
        expect(artifact.pathParts).toEqual(integration.pathParts);
        expect(artifact.content.startsWith(nativeIntegrationHeader(agent, operation))).toBe(true);
        expect(artifact.content).toContain('Only a CLI that actually accepts this exact source');
        expect(artifact.content).toContain('No executable, framework version, marker, seed, constitution, task bundle or archive is required or created');
        if (operation === 'repair') {
          expect(artifact.content).toContain(renderRepairInstructions('application-active-layout-patch'));
          expect(artifact.content).toContain('currentApplication.manifestVersion: 8');
          expect(artifact.content).toContain('Conditional repair protocol');
          expect(renderRepairIntegration(agent)).toBe(`${nativeIntegrationHeader(agent, operation)}${renderRepairInstructions()}`);
        } else if (operation === 'assessment') {
          expect(artifact.content).toContain('Stop after explaining the report');
          expect(artifact.content).toContain('not an\nassessment result or activation evidence');
        } else {
          expect(artifact.content).toContain('source-metadata2/task-projection creation is unavailable');
          expect(artifact.content).not.toContain('--execute');
        }
      }
    }
    const none = buildModernManagedCore(fixture('manual', 'none', ['codex']));
    expect(none.map((entry) => entry.logicalName)).toEqual(['liftoff-assess-codex', 'liftoff-repair-codex']);
    expect(text(none, 'liftoff-repair-codex')).toContain('Governance none stays disabled');
    expect(buildModernManagedCore(fixture('manual', 'none', []))).toEqual([]);
    expect(() => renderModernGovernanceIntegration('claude', 'repair', fixture('manual', 'none', ['codex']).selection)).toThrow('not applicable');
    expect(() => renderModernGovernanceIntegration('codex', 'setup', fixture('manual', 'none', ['codex']).selection)).toThrow('not applicable');
  });

  it('is deterministic without clocks, random values or any generated live observations', () => {
    const input = fixture('spec-kit', 'team-gitflow', ['claude']);
    const clock = vi.spyOn(Date, 'now'), random = vi.spyOn(Math, 'random');
    try {
      const first = buildModernManagedCore(input), second = buildModernManagedCore(input);
      expect(second).toEqual(first);
      expect(clock).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
      const context = JSON.parse(text(first, 'repository-governance-context'));
      expect(context).not.toHaveProperty('timestamp');
      expect(context).not.toHaveProperty('repository');
      expect(context).not.toHaveProperty('providerStatus');
      expect(context).not.toHaveProperty('telemetryId');
    } finally {
      clock.mockRestore();
      random.mockRestore();
    }
  });
});

describe('real W1/CP1 and credential2 integration', () => {
  it.each(profiles.flatMap((profile) => workflows.map((workflow) => ({ profile, workflow }))))(
    'validates generated $profile/$workflow core after W1 completes an actual candidate', ({ profile, workflow }) => {
      const input = fixture(workflow, profile, workflow === 'manual' ? [] : ['github-copilot']);
      const core = buildModernManagedCore(input);
      const source = resolveModernManifestV8SourceContract({ selection: input.selection, recordedPlugins: input.plugins });
      // Reuse actual stable workload producers without claiming this is public modern fresh generation.
      const oldPlan = buildProjectPlan({
        projectName: input.selection.project.name, projectType: 'standard', apiStack: 'node-fastify', cloud: 'azure', region: 'eastus',
        agents: ['github-copilot'], specWorkflow: workflow === 'manual' ? 'openspec' : workflow,
        includeFrontend: true, environments: ['prod', 'dev']
      }, { requireProjectName: true });
      const nonCore = buildArtifacts(oldPlan).filter((entry) => entry.lifecycle !== 'managed-core' && entry.lifecycle !== 'manifest' &&
        (workflow !== 'manual' || entry.lifecycle !== 'framework' && entry.lifecycle !== 'seed'));
      const canonicalLayout = {
        schemaVersion: 1, state: 'bound',
        bindings: nonCore.filter((entry) => entry.lifecycle === 'project').map((entry) =>
          ({ kind: 'artifact', logicalName: entry.logicalName, pathParts: entry.pathParts }))
      };
      const boundInput = { ...input, activeLayout: canonicalLayout };
      const boundCore = buildModernManagedCore(boundInput);
      const generatedArtifacts = [...nonCore, ...boundCore.map((entry) => ({ ...entry, pathParts: [...entry.pathParts] }))];
      const candidate = createManifestV8Candidate({ origin: 'fresh', selection: input.selection, generatedArtifacts });
      expect(candidate.manifest).toEqual(rootReader.parseManifestV8(JSON.parse(candidate.content)));
      expect(candidate.manifest.managedArtifacts.map((entry) => entry.logicalName).sort())
        .toEqual(source.managedArtifacts.map((entry) => entry.logicalName).sort());
      for (const artifact of boundCore) {
        expect(candidate.manifest.managedArtifacts.find((entry) => entry.logicalName === artifact.logicalName)?.contentHash)
          .toBe(`sha256:${sha(artifact.content)}`);
      }
      if (profile !== 'none') {
        const actualCompatibility = JSON.parse(text(boundCore, 'repository-governance-compatibility'));
        expect(compatibility.validateModernCompatibilityMetadata(actualCompatibility, candidate.manifest)).toEqual(actualCompatibility);
        expect(canonicalJson(compatibility.buildModernCompatibilityMetadata(candidate.manifest)))
          .toBe(text(boundCore, 'repository-governance-compatibility'));
        expect(text(core, 'repository-governance-context')).not.toBe(text(boundCore, 'repository-governance-context'));
      }
    });

  it.each(['0.3.4', '0.8.0', '0.9.9', '0.12.3'])('supports actual historical %s byte decisions and same-contract maintenance with unchanged history', (version) => {
    const bytes = readFileSync(`tests/fixtures/contract-baseline-0.12.3/manifests/${version}-standard-go.json`);
    const raw: unknown = JSON.parse(bytes.toString('utf8')), historical = parseManifest(raw);
    const leaf = projectReader.validateManifestV8Project({ project: historical.project, framework: historical.framework });
    const activeLayout = { schemaVersion: 1, state: 'unresolved', bindings: [] };
    const input = fromLeaf(leaf, 'single-maintainer-gitflow', activeLayout);
    const core = buildModernManagedCore(input);
    const managed: ManagedManifestDecision[] = core.map(({ logicalName, category, pathParts, content }) =>
      ({ kind: 'bytes', logicalName, category, pathParts, content }));
    for (const entry of historical.managedArtifacts) if (isRetiredManagedCoreLogicalName(entry.logicalName)) {
      managed.push({ kind: 'retire-alias', logicalName: entry.logicalName });
    }
    const history = createManifestHistoryIndex({ artifactVersion: historical.artifactVersion, digest: sha(bytes), bytes: bytes.length, mode: 0o644 });
    const reference = { schemaVersion: 1, kind: 'manifest-history', snapshotId: history.snapshotId, indexDigest: encodeManifestHistoryIndex(history).indexDigest };
    const candidate = createManifestV8Candidate({
      origin: 'historical-successor', source: raw, profile: 'single-maintainer-gitflow',
      activeLayout, sourceManifestHistory: reference, managed
    });
    expect(candidate.manifest.projectArtifacts).toEqual(historical.projectArtifacts);
    expect(candidate.manifest.sourceManifestHistory).toEqual(reference);
    expect(compatibility.buildModernCompatibilityMetadata(candidate.manifest)).toEqual(
      JSON.parse(text(core, 'repository-governance-compatibility')));
    const maintenance = createManifestV8Candidate({
      origin: 'maintenance', source: candidate.manifest,
      managed: candidate.manifest.managedArtifacts.map(({ logicalName }) => ({ kind: 'retain', logicalName }))
    });
    expect(maintenance.manifest).toEqual(candidate.manifest);
    expect(maintenance.content).toBe(candidate.content);
  });

  it.each((['single-maintainer-gitflow', 'team-gitflow'] as const).flatMap((profile) =>
    workflows.map((workflow) => ({ profile, workflow }))))(
    'binds actual credential2 schema restrictions and runtime values for $profile/$workflow', ({ profile, workflow }) => {
      const input = fixture(workflow, profile, []);
      const core = buildModernManagedCore(input), context = contexts.buildModernGovernanceContext(input);
      const source = resolveModernManifestV8SourceContract({ selection: input.selection, recordedPlugins: input.plugins });
      const credentialInput = {
        recordedIdentity: context.governance.activationIdentity, profile, policyVersion: context.governance.policyVersion,
        selection: { project: context.project, framework: context.framework, profile },
        pluginResolutionDigest: input.plugins.resolutionDigest,
        activeLayoutDigest: manifestActiveLayoutDigest(context.activeLayout, source.layoutDescriptor)
      };
      // Preserve the correlated project/framework union for the authoritative runtime contract.
      const correlated = { ...credentialInput, selection: { ...input.selection, profile } };
      const schema = JSON.parse(text(core, 'repository-governance-credential-policy-schema'));
      expect(text(core, 'repository-governance-credential-policy-schema'))
        .toBe(renderModernCredentialPolicySchema(projectCatalog, correlated));
      expect(schema.$id).toBe('https://mission-control.local/liftoff/governance/credential-policy.schema.v2.json');
      expect(schema.title).toBe('Liftoff governance credential policy v2');
      const original = JSON.parse(renderCredentialPolicySchema());
      for (const field of Object.keys(original.properties).filter((key) => key !== 'identity' && key !== 'schemaVersion')) {
        expect(schema.properties[field]).toEqual(original.properties[field]);
      }
      expect(schema.required).toEqual(original.required);
      expect(schema.allOf).toEqual(original.allOf);
      expect(schema.additionalProperties).toBe(false);
      const runtime = createModernActivationRecordContract(projectCatalog, correlated);
      const { identity: _oldIdentity, schemaVersion: _oldVersion, ...metadata } = validateHistoricalV3CredentialPolicy(capturedV3Records().credential);
      const record = runtime.createCredentialMetadata(metadata);
      expect(record.schemaVersion).toBe(schema.properties.schemaVersion.const);
      for (const [key, value] of Object.entries(record.identity)) expect(schema.properties.identity.properties[key]).toEqual({ const: value });
      expect(runtime.readCredentialPolicy(record)).toEqual(record);
      expect(() => runtime.readCredentialPolicy({ ...record, identity: currentActivationIdentity })).toThrow();
      expect(() => runtime.readCredentialPolicy({ ...record, schemaVersion: 1 })).toThrow();
      expect(() => runtime.readCredentialPolicy({ ...record, nonForwarding: false })).toThrow();
      expect(() => runtime.readCredentialPolicy({ ...record, expiresAt: record.createdAt })).toThrow();
      expect(() => renderModernCredentialPolicySchema(projectCatalog, { ...correlated, recordedIdentity: currentActivationIdentity })).toThrow();
    });

  it('pins current schema1 bytes to the reviewed graph successor', () => {
    expect(sha(renderCredentialPolicySchema())).toBe('33700536d2dd57c2c9de723e09b660a9610c15080d27bd5db5a3fe4414357acf');
    const schema = JSON.parse(renderCredentialPolicySchema());
    expect(schema.properties.schemaVersion).toEqual({ const: 1 });
    expect(schema.properties.identity.required).toHaveLength(11);
    expect(schema.properties.identity.properties.phaseGraphHash.const).toBe(currentActivationIdentity.phaseGraphHash);
  });
});

describe('context and producer fail-closed boundaries', () => {
  it.each(['schemaVersion', 'kind', 'execution', 'project', 'framework', 'governance', 'plugins', 'activeLayout', 'sourceInterpretation'])(
    'rejects a changed context %s section', (field) => {
      const context = structuredClone(contexts.buildModernGovernanceContext(fixture()));
      Reflect.set(context, field, field === 'schemaVersion' ? 1 : {});
      expect(() => contexts.validateModernGovernanceContext(context)).toThrow();
    });

  it('rejects invented context observations, commands, enforcement and unregistered profile support', () => {
    const context = contexts.buildModernGovernanceContext(fixture());
    expect(() => contexts.validateModernGovernanceContext({ ...context, commands: [] })).toThrow();
    expect(() => contexts.validateModernGovernanceContext({ ...context, governance: { ...context.governance, liveEnforcement: 'active' } })).toThrow();
    expect(() => contexts.validateModernGovernanceContext({
      ...context, sourceInterpretation: { ...context.sourceInterpretation, filesystemObservation: 'verified' }
    })).toThrow();
    expect(() => contexts.buildModernGovernanceContext(fixture('manual', 'none', []))).toThrow('none has no governance context');
    expect(() => buildModernManagedCore({
      ...fixture(), selection: { ...fixture().selection, profile: 'unknown' }
    })).toThrow('explicit profile');
  });

  it('does not accept a borrowed plugin resolution or overwrite source layout relationships', () => {
    const first = fixture('openspec', 'single-maintainer-gitflow'), second = fixture('manual', 'team-gitflow');
    expect(() => buildModernManagedCore({ ...second, plugins: first.plugins })).toThrow();
    expect(() => buildModernManagedCore({
      ...first, activeLayout: { schemaVersion: 1, state: 'bound', bindings: [
        { kind: 'artifact', logicalName: 'root-readme', pathParts: ['.liftoff', 'governance', 'policy.md'] }
      ] }
    })).toThrow('reserved');
    const context = contexts.buildModernGovernanceContext(first);
    const source = resolveModernManifestV8SourceContract({ selection: second.selection, recordedPlugins: second.plugins });
    if (!('identity' in source.governanceSource)) throw new Error('Expected actual graph.');
    const graph = source.governanceSource.graph;
    expect(() => renderModernGovernanceGuide(context, graph)).toThrow('contradicts');
    const fakeContext = createModernGovernanceContextContract({
      ...contracts,
      resolveSourceContract(input) {
        const actual = resolveModernManifestV8SourceContract(input);
        return { ...actual, plugins: { ...actual.plugins, resolutionDigest: `sha256:${'0'.repeat(64)}` } };
      }
    });
    expect(() => fakeContext.buildModernGovernanceContext(first)).toThrow('independently resolved');
  });

  it.each([null, undefined, [], {}, true, { selection: {} }, { ...fixture(), approval: true }].map((input) => ({ input })))(
    'rejects incomplete or unknown-field producer input %#', ({ input }) => {
      expect(() => buildModernManagedCore(input)).toThrow();
    });

  it('rejects hooks at every untrusted source depth before digest or registry interpretation', () => {
    const cases: Array<(value: ReturnType<typeof fixture>, hook: () => never) => void> = [
      (value, hook) => Object.defineProperty(value, 'activeLayout', { enumerable: true, get: hook }),
      (value, hook) => Object.defineProperty(value.selection, 'profile', { enumerable: true, get: hook }),
      (value, hook) => Object.defineProperty(value.selection.project, 'workload', { enumerable: true, get: hook }),
      (value, hook) => Object.defineProperty(value.plugins.selections, '0', { enumerable: true, get: hook }),
      (value, hook) => Object.defineProperty(value.activeLayout, 'bindings', { enumerable: true, get: hook })
    ];
    for (const mutate of cases) {
      const input = structuredClone(fixture()), hook = vi.fn(() => { throw new Error('must not invoke hook'); });
      mutate(input, hook);
      expect(() => buildModernManagedCore(input)).toThrow();
      expect(() => contexts.buildModernGovernanceContext(input)).toThrow();
      expect(hook).not.toHaveBeenCalled();
    }
    const nested = structuredClone(fixture());
    Reflect.set(nested, 'activeLayout', { schemaVersion: 1, state: 'bound', bindings: new Array(1) });
    expect(() => buildModernManagedCore(nested)).toThrow();
  });

  it('does not turn supplied commands, provider observations or credential-shaped extras into generated content', () => {
    for (const field of ['commands', 'repository', 'providerReady', 'approval', 'timestamp', 'password', 'state']) {
      expect(() => buildModernManagedCore({ ...fixture(), [field]: 'never-read' })).toThrow();
    }
  });

  it.each(['absent', 'normalized'])('rejects %s policy text instead of relabeling bytes from a source registry facade', async (mode) => {
    const input = fixture(), actual = modernSourceRegistry();
    vi.resetModules();
    vi.doMock('../src/application/project/modern-plugins.js', () => ({
      modernSourceRegistry: () => ({
        ...actual,
        assetsFor: (owner: Parameters<typeof actual.assetsFor>[0]) => {
          const assets = actual.assetsFor(owner);
          if (owner.kind !== 'core') return assets;
          const own = { ...assets.own };
          if (mode === 'absent') delete own['modern-single-maintainer-policy'];
          else own['modern-single-maintainer-policy'] = `${own['modern-single-maintainer-policy'].trimEnd()}\r\n`;
          return { ...assets, own };
        }
      })
    }));
    try {
      const isolated = await import('../src/application/project/modern-managed-core.js');
      expect(() => isolated.buildModernManagedCore(input)).toThrow('policy bytes are unavailable or differ');
    } finally {
      vi.doUnmock('../src/application/project/modern-plugins.js');
      vi.resetModules();
    }
  });
});

describe('shared recorded source and active-binding interpretation', () => {
  it.each(profiles)('preserves custom paths and the original managed-core contract for %s', profile => {
    const unbound = fixture('manual', profile, []), original = resolveModernProjectSourceContext(unbound);
    const identity = original.source.layoutDescriptor.artifacts.find(artifact => artifact.component === 'backend');
    if (!identity) throw new Error('Expected a real declared backend artifact.');
    const layout = { schemaVersion: 1, state: 'bound', bindings: [
      { kind: 'component', component: 'backend', pathParts: ['Services', 'Custom API'] },
      { kind: 'artifact', logicalName: identity.logicalName, pathParts: ['Services', 'Custom API', 'custom-file'] }
    ] };
    const input = { ...unbound, activeLayout: layout }, before = structuredClone(input);
    const context = resolveModernProjectSourceContext(input);
    expect(context).toEqual(resolveModernManagedCoreInput(input));
    expect(context.activeLayout).toEqual(validateManifestActiveLayout(layout, original.source.layoutDescriptor));
    expect(findModernActiveComponentBinding(context, 'backend')?.pathParts).toEqual(['Services', 'Custom API']);
    expect(findModernActiveArtifactBinding(context, identity.logicalName)?.pathParts)
      .toEqual(['Services', 'Custom API', 'custom-file']);
    expect(findModernActiveComponentBinding(context, 'frontend')).toBeUndefined();
    expect(buildModernManagedCore(input)).toEqual(buildModernManagedCore({
      selection: context.selection, plugins: context.plugins, activeLayout: context.activeLayout
    }));
    expect(input).toEqual(before);
  });

  it.each(['unresolved', 'bound'] as const)('keeps missing %s bindings unknown rather than selecting template paths', state => {
    const bindings = state === 'bound'
      ? [{ kind: 'artifact', logicalName: 'root-readme', pathParts: ['Custom Documentation', 'README.md'] }] : [];
    const input = { ...fixture('manual', 'none', []), activeLayout: { schemaVersion: 1, state, bindings } };
    const context = resolveModernProjectSourceContext(input);
    expect(context.activeLayout.state).toBe(state);
    for (const component of context.source.layoutDescriptor.components) {
      expect(findModernActiveComponentBinding(context, component)).toBeUndefined();
    }
    for (const artifact of context.source.layoutDescriptor.artifacts) {
      expect(findModernActiveArtifactBinding(context, artifact.logicalName))
        .toEqual(bindings.find(binding => binding.logicalName === artifact.logicalName));
    }
    expect(context.activeLayout.bindings).toEqual(bindings);
  });

  it('preserves the rejection of an empty claimed-bound layout', () => {
    expect(() => resolveModernProjectSourceContext({
      ...fixture('manual', 'none', []), activeLayout: { schemaVersion: 1, state: 'bound', bindings: [] }
    })).toThrow('at least one binding');
  });

  it('rejects undeclared lookup identities instead of inventing an applicable target', () => {
    const context = resolveModernProjectSourceContext(fixture('manual', 'none', []));
    expect(() => findModernActiveComponentBinding(context, 'function-worker')).toThrow('declared by the selected source');
    expect(() => findModernActiveArtifactBinding(context, 'unselected-artifact')).toThrow('declared by the selected source');
  });

  it('does not accept foreign profile/plugin combinations or unsafe active paths', () => {
    const input = fixture('manual', 'none', []), other = fixture('openspec', 'team-gitflow');
    expect(() => resolveModernProjectSourceContext({ ...input, plugins: other.plugins })).toThrow();
    expect(() => resolveModernProjectSourceContext({
      ...input, activeLayout: { schemaVersion: 1, state: 'bound', bindings: [
        { kind: 'component', component: 'backend', pathParts: ['governance', 'credentials'] }
      ] }
    })).toThrow('reserved');
    expect(() => resolveModernProjectSourceContext({ ...input, execution: 'approved' })).toThrow();
  });

  it('rejects accessor input before invoking a hook or interpreting its source', () => {
    const input = fixture(), hook = vi.fn(() => { throw new Error('must not invoke'); });
    Object.defineProperty(input, 'activeLayout', { enumerable: true, get: hook });
    expect(() => resolveModernProjectSourceContext(input)).toThrow();
    expect(hook).not.toHaveBeenCalled();
  });
});
