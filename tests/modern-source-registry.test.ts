import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { builtinPluginRegistry, composeModernManifestPlugins } from '../src/application/project/plugins.js';
import { createModernSourceRegistry, modernSourceRegistry } from '../src/application/project/modern-plugins.js';
import {
  parseManifest, resolveInstalledManifestBindingContext, resolveManifestV8SourceContract, resolveModernManifestV8SourceContract
} from '../src/application/project/manifest.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { readDeclaredAssetBytes } from '../src/adapters/packaged-assets/plugin-assets.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { modernActivationSourceContracts } from '../src/domain/governance/policy/identity.js';
import { createModernActivationIdentityReader } from '../src/domain/governance/activation/modern-identity.js';
import { createManifestV8ProjectReader } from '../src/domain/project/manifest/v8-project.js';
import { manifestActiveLayoutDigest } from '../src/domain/project/manifest/layout.js';
import { readManifestPluginMetadata } from '../src/domain/project/manifest/plugins.js';
import { toSafeProjectName } from '../src/domain/project/planning.js';
import { retiredFlatRootInfrastructureIdentities } from '../src/domain/project/infrastructure-layout.js';
import { buildArtifacts } from '../src/templates.js';
import { builtinAssets } from '../src/plugins/builtin/assets.js';
import { builtinCore, builtinDescriptors, builtinRelease, builtinReleaseDigests, builtinSelectionSpace } from '../src/plugins/builtin/index.js';
import {
  modernAssets, modernCore, modernDescriptors, modernGovernanceAssets, modernRegistryInput, modernSelectionSpace
} from '../src/plugins/builtin/modern.js';
import { governanceAgentIntegrations } from '../src/domain/project/catalog.js';
import { createPluginRegistry, pluginContentDigest } from '../src/plugins/registry.js';
import { PluginRegistryError } from '../src/plugins/contracts.js';
import type { PluginSelection } from '../src/plugins/contracts.js';
import { modernRelease } from '../src/plugins/builtin/modern-release.js';

describe('modern source declarations', () => {
  it('declares exactly one real Manual no-framework contribution, not an execution callback', () => {
    const manual = modernDescriptors.find((descriptor) => descriptor.id === 'manual');
    expect(manual).toEqual({
      category: 'workflow', id: 'manual', apiVersion: 1, contentVersion: 1,
      hostPlatforms: builtinDescriptors[0].hostPlatforms, supports: [{}],
      artifacts: [], assets: [], sharedAssets: [], checks: [], recipes: []
    });
    expect(modernDescriptors).toHaveLength(builtinDescriptors.length + 1);
    expect(builtinDescriptors.some((descriptor) => descriptor.id === 'manual')).toBe(false);
    expect(Object.values(manual!).some((value) => typeof value === 'function')).toBe(false);
  });

    const rawDigest = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const readAssets = () => modernAssets.map(({ pathParts }) => ({
      pathParts, bytes: readFileSync(path.join(...pathParts))
    }));
    const packagedTable = () => readFileSync('assets/governance/modern/source-contracts.json');
    const modernReader = createModernActivationIdentityReader(projectCatalog);
    const leafReader = createManifestV8ProjectReader(projectCatalog);
    const patterns = ['generic', 'rag', 'chatbot', 'agent', 'prompt', 'multi-agent', 'fine-tuned', 'streaming', 'workflow'];
    const workloads = [
      ...['python-fastapi', 'node-fastify', 'go-huma'].map((apiStack) => ({ kind: 'standard', apiStack })),
      ...patterns.map((pattern) => ({ kind: 'genai', apiStack: 'python-fastapi', pattern }))
    ];
    const agentSets = [
      [], ['github-copilot'], ['claude'], ['codex'], ['github-copilot', 'claude'],
      ['github-copilot', 'codex'], ['claude', 'codex'], ['github-copilot', 'claude', 'codex']
    ];
    const enabledProfiles = ['single-maintainer-gitflow', 'team-gitflow'] as const;
    const workflows = ['openspec', 'spec-kit', 'manual'] as const;
    const profiles = ['none', ...enabledProfiles] as const;

    function fixture(
      workflow: (typeof workflows)[number] = 'openspec',
      profile: (typeof profiles)[number] = 'single-maintainer-gitflow',
      agents: string[] = ['github-copilot'],
      workload: { kind: string; apiStack: string; pattern?: string } = workloads[1],
      frontend = false,
      environments = ['dev']
    ) {
      const leaf = leafReader.validateManifestV8Project({
        project: {
          name: 'Modern Source', workload: { ...workload, cloud: 'azure', region: 'eastus', frontend, environments },
          specWorkflow: workflow, agents,
          ...(workflow === 'spec-kit' && agents.length ? { defaultAgent: agents.at(-1) } : {})
        },
        framework: workflow === 'manual' ? { state: 'not-required' } : {
          state: agents.length ? 'initialized' : 'legacy', adapter: workflow,
          ...(agents.length ? { contractVersion: projectCatalog.getFrameworkDefinition(workflow).version } : {})
        }
      });
      const selection: PluginSelection = {
        workload: workload.kind, ...(workload.pattern !== undefined ? { variant: workload.pattern } : {}),
        stack: workload.apiStack, cloud: 'azure', workflow, agents,
        frontend: frontend ? 'included' : 'omitted', governanceProfile: profile, environments
      };
      const composition = composeModernManifestPlugins(selection, { safeProjectName: toSafeProjectName(leaf.project.name) });
      const recordedPlugins = readManifestPluginMetadata({
        schemaVersion: 1, resolutionDigest: composition.resolution.digest, selections: composition.resolution.plugins
      }, { stack: workload.apiStack, cloud: 'azure', workflow, agents });
      const request = { selection: { ...leaf, profile }, recordedPlugins };
      return { leaf, selection, composition, request };
    }

    describe('actual modern registry and C1 source binding', () => {
      it('matches independently derived literal registry identities and keeps the default registry unchanged', () => {
        const modern = createModernSourceRegistry();
        expect(modern.pluginSetDigest).toBe('sha256:b37f1ea2319bdf25e2fda09faa271639c48007acdcbd80aaf540835a210eab73');
        expect(modern.coreContributionDigest).toBe('sha256:8502ebf3f4bce4ec93c98d674445828cf4db360bf32b0b7bfe30ba3f3fb39146');
        expect(modern.registryDigest).toBe('sha256:3f586dc05020ab6f8f5f8c312098fef7e2a1a0ff3a802d60c1f0366ef25023a1');
        const original = builtinPluginRegistry();
        expect(original).not.toBe(modernSourceRegistry());
        expect(modernSourceRegistry()).toBe(modernSourceRegistry());
        expect(original.pluginSetDigest).toBe(builtinReleaseDigests.pluginSetDigest);
        expect(original.coreContributionDigest).toBe(builtinReleaseDigests.coreContributionDigest);
        expect(original.registryDigest).toBe(builtinReleaseDigests.registryDigest);
        expect(original.inventory.some((entry) => entry.id === 'manual')).toBe(false);
        expect(original.inventory.filter((entry) => entry.category === 'agent').every((entry) => entry.contentVersion === 4)).toBe(true);
      });

      it('binds actual raw policies and canonical six-row table, never normalized prose or invented graph hashes', () => {
        const sources = modernActivationSourceContracts();
        expect(sources.map(({ identity }) => `${identity.profile}/${identity.workflow}`)).toEqual(
          enabledProfiles.flatMap((profile) => workflows.map((workflow) => `${profile}/${workflow}`)));
        const expected = canonicalJson({
          schemaVersion: 1, kind: 'liftoff-modern-source-contracts',
          sources: sources.map(({ identity, savedPlanSchemaVersion, compatibilityMetadataSchemaVersion }) =>
            ({ identity, savedPlanSchemaVersion, compatibilityMetadataSchemaVersion }))
        });
        expect(packagedTable().equals(Buffer.from(expected, 'utf8'))).toBe(true);
        expect(rawDigest(packagedTable())).toBe('sha256:b336953323f1099a429e35cb22a39c9dda48e884bc5e610bfa44424db914bcf6');
        for (const source of sources) {
          expect(rawDigest(readFileSync(path.join(...source.policyPathParts)))).toBe(source.identity.policyDigest);
          expect(canonicalSha256(source.graph)).toBe(source.identity.phaseGraphHash);
          expect(source.identity.policyVersion).toBe(source.identity.profile === 'team-gitflow' ? '1' : '7');
        }
        for (const field of ['sourceSelectionDigest', 'pluginResolutionDigest', 'activeLayoutDigest', 'approval', 'targetDigest', 'policyPathParts']) {
          expect(expected).not.toContain(`"${field}"`);
        }
        expect(new Set(sources.map((source) => source.identity.phaseGraphHash)).size).toBe(6);
      });

      it.each(workloads)('supports real $kind/$apiStack/$pattern modern selections and applicable owned identities', (workload) => {
        for (const workflow of workflows) {
          for (const profile of profiles) {
            for (const [index, agents] of agentSets.entries()) {
              const current = fixture(workflow, profile, [...agents], workload, index % 2 === 0,
                index % 2 === 0 ? ['prod', 'dev'] : ['staging']);
              const before = structuredClone(current.request);
              const result = resolveModernManifestV8SourceContract(current.request);
              expect(current.request).toEqual(before);
              expect(result.plugins).toEqual(current.request.recordedPlugins);
              expect(result.plugins.resolutionDigest).toBe(current.composition.resolution.digest);
              expect(result.managedArtifacts).toHaveLength(profile === 'none' ? agents.length : 6 + agents.length * 3);
              expect(result.requiredHandoffLogicalNames).toHaveLength(profile === 'none' ? 0 : 6 + agents.length * 2);
              expect(result.layoutDescriptor.components.includes('frontend')).toBe(index % 2 === 0);
              expect(result.layoutDescriptor.components.includes('opentofu-environment:prod')).toBe(index % 2 === 0);
              expect(result.layoutDescriptor.components.includes('function-worker'))
                .toBe('pattern' in workload && typeof workload.pattern === 'string' &&
                  ['rag', 'agent', 'multi-agent', 'workflow'].includes(workload.pattern));
              if (workflow === 'manual') {
                expect(current.composition.expected.some((artifact) => artifact.lifecycle === 'framework' || artifact.lifecycle === 'seed')).toBe(false);
                expect(current.leaf.framework).toEqual({ state: 'not-required' });
                expect(current.leaf.project).not.toHaveProperty('defaultAgent');
              }
              if (profile === 'none') {
                expect(result.governanceSource).toEqual({ profile: 'none' });
              } else {
                expect(result.governanceSource).toMatchObject({ identity: { profile, workflow } });
              }
              for (const retired of retiredFlatRootInfrastructureIdentities) {
                expect(result.readableProjectLogicalNames).toContain(retired.logicalName);
                expect(result.layoutDescriptor.artifacts.some((artifact) => artifact.logicalName === retired.logicalName)).toBe(false);
              }
              expect(Object.isFrozen(result)).toBe(true);
              expect(Object.isFrozen(result.governanceSource)).toBe(true);
            }
          }
        }
      });

      it.each(enabledProfiles.flatMap((profile) => workflows.map((workflow) => ({ profile, workflow }))))(
        'qualifies real $profile/$workflow plugin/layout context against the actual modern identity reader', ({ profile, workflow }) => {
          for (const agents of [[], ['github-copilot', 'claude', 'codex']]) {
            const current = fixture(workflow, profile, agents, workloads[4], true, ['prod', 'dev']);
            const source = resolveModernManifestV8SourceContract(current.request);
            expect('identity' in source.governanceSource).toBe(true);
            if (!('identity' in source.governanceSource)) throw new Error('Expected actual enabled governance source.');
            const activeLayout = {
              schemaVersion: 1, state: 'bound', bindings: [
                { kind: 'component', component: 'backend', pathParts: ['Services', 'Custom API'] },
                { kind: 'artifact', logicalName: 'backend-main', pathParts: ['Services', 'Custom API', 'main.py'] }
              ]
            };
            for (const layout of [activeLayout, { schemaVersion: 1, state: 'unresolved', bindings: [] }]) {
              const input = {
                profile, policyVersion: source.governanceSource.identity.policyVersion,
                selection: { ...current.leaf, profile },
                pluginResolutionDigest: source.plugins.resolutionDigest,
                activeLayoutDigest: manifestActiveLayoutDigest(layout, source.layoutDescriptor)
              };
              const identity = modernReader.identityForSource({
                ...input, sourceVersion: source.governanceSource.identity.liftoffVersion
              });
              expect(modernReader.validateReadableModernActivationIdentity({ ...input, recordedIdentity: identity })).toEqual(identity);
              expect(identity.phaseGraphHash).toBe(source.governanceSource.identity.phaseGraphHash);
              expect(identity.policyDigest).toBe(source.governanceSource.identity.policyDigest);
              expect(() => modernReader.validateReadableModernActivationIdentity({
                ...input, recordedIdentity: identity, pluginResolutionDigest: `sha256:${'0'.repeat(64)}`
              })).toThrow('independently supplied context');
              const renamed = structuredClone(current.leaf);
              Reflect.set(renamed.project, 'name', 'Changed source name');
              expect(() => modernReader.validateReadableModernActivationIdentity({
                ...input, recordedIdentity: identity,
                selection: { ...renamed, profile }
              })).toThrow('independently supplied context');
            }
          }
        });

      it('refuses old-core metadata even for an agentless source with identical plugin rows', () => {
        const plan = buildProjectPlan({
          projectName: 'Modern Source', projectType: 'standard', apiStack: 'node-fastify', cloud: 'azure',
          region: 'eastus', environments: ['dev'], agents: ['github-copilot']
        }, { requireProjectName: true });
        plan.agents = [];
        plan.defaultAgent = undefined;
        const old = resolveInstalledManifestBindingContext(plan);
        const current = fixture('openspec', 'single-maintainer-gitflow', []);
        expect(current.request.recordedPlugins.selections).toEqual(old.plugins.selections);
        expect(current.request.recordedPlugins.resolutionDigest).not.toBe(old.plugins.resolutionDigest);
        expect(() => resolveModernManifestV8SourceContract({ ...current.request, recordedPlugins: old.plugins }))
          .toThrow('exact installed release-owned source contract');
        expect(() => resolveManifestV8SourceContract(current.request)).toThrow('exact installed release-owned source contract');
        expect(resolveManifestV8SourceContract({ ...current.request, recordedPlugins: old.plugins }).plugins).toEqual(old.plugins);
        expect(currentActivationIdentity.policyVersion).toBe('6');
        expect(currentActivationIdentity.activationContractVersion).toBe(3);
        expect(JSON.parse(buildArtifacts(plan).find((artifact) => artifact.logicalName === 'manifest')!.content).artifactVersion).toBe(7);
      });

      it('does not turn modern schema interpretation into public Manual/team planner or default-registry support', () => {
        const manual = fixture('manual', 'team-gitflow');
        expect(resolveModernManifestV8SourceContract(manual.request).plugins).toEqual(manual.request.recordedPlugins);
        expect(() => resolveManifestV8SourceContract(manual.request)).toThrow(/unknown|unsupported|invalid/i);
        expect(projectCatalog.getSpecWorkflow('manual')).toBeUndefined();
        expect(projectCatalog.getGovernanceProfile('team-gitflow')).toBeUndefined();
        expect(() => builtinPluginRegistry().resolveSelection(manual.selection, { platform: 'darwin/arm64' })).toThrow();
      });
    });

    describe('modern source asset integrity and lazy isolation', () => {
      it.each(modernGovernanceAssets.map((asset) => ({ asset })))('fails closed for missing or changed $asset.id bytes', ({ asset }) => {
        const key = asset.pathParts.join('/');
        expect(() => createModernSourceRegistry(() => readAssets().filter((entry) => entry.pathParts.join('/') !== key))).toThrow();
        expect(() => createModernSourceRegistry(() => readAssets().map((entry) => entry.pathParts.join('/') === key
          ? { ...entry, bytes: Uint8Array.from(entry.bytes, (byte, index) => index === 0 ? byte ^ 1 : byte) }
          : entry))).toThrow();
      });

      it.each(modernGovernanceAssets.filter((asset) => asset.pathParts.at(-1)?.endsWith('.md')).map((asset) => ({ asset })))(
        'does not normalize newline changes in $asset.id', ({ asset }) => {
          const key = asset.pathParts.join('/');
          for (const rewrite of [
            (text: string) => text.replace(/\n/g, '\r\n'),
            (text: string) => text.trimEnd()
          ]) {
            expect(() => createModernSourceRegistry(() => readAssets().map((entry) => entry.pathParts.join('/') === key
              ? { ...entry, bytes: Buffer.from(rewrite(entry.bytes.toString('utf8')), 'utf8') }
              : entry))).toThrow();
          }
        });

      it('reads actual declared files from a foreign package root and never ignores a missing new asset', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'modern-source-package-'));
        try {
          for (const asset of modernAssets) {
            const target = path.join(root, ...asset.pathParts);
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, await readFile(path.join(...asset.pathParts)));
          }
          const read: Parameters<typeof createModernSourceRegistry>[0] = (declarations, bounds) =>
            readDeclaredAssetBytes(declarations, bounds, { packageRoot: root });
          expect(createModernSourceRegistry(read).registryDigest).toBe(modernSourceRegistry().registryDigest);
          for (const asset of modernGovernanceAssets) {
            const target = path.join(root, ...asset.pathParts), bytes = await readFile(target);
            await rm(target);
            expect(() => createModernSourceRegistry(read)).toThrow('could not be used');
            await writeFile(target, bytes);
          }
        } finally {
          await rm(root, { recursive: true });
        }
      });

      it.each(['missing-row', 'extra-row', 'wrong-policy', 'wrong-graph', 'unknown-field', 'cyclic-field', 'noncanonical'])(
        'rejects a %s packaged table', (variant) => {
          const table: { sources: Array<{ identity: Record<string, unknown> }>; [key: string]: unknown } = JSON.parse(packagedTable().toString('utf8'));
          if (variant === 'missing-row') table.sources.pop();
          if (variant === 'extra-row') table.sources.push(table.sources[0]);
          if (variant === 'wrong-policy') table.sources[0].identity.policyDigest = `sha256:${'0'.repeat(64)}`;
          if (variant === 'wrong-graph') table.sources[0].identity.phaseGraphHash = '0'.repeat(64);
          if (variant === 'unknown-field') table.extra = true;
          if (variant === 'cyclic-field') table.sources[0].identity.pluginResolutionDigest = `sha256:${'0'.repeat(64)}`;
          const content = variant === 'noncanonical' ? JSON.stringify(table, null, 2) : canonicalJson(table);
          expect(() => createModernSourceRegistry(() => readAssets().map((entry) =>
            entry.pathParts.at(-1) === 'source-contracts.json' ? { ...entry, bytes: Buffer.from(content, 'utf8') } : entry))).toThrow();
        });

      it('rejects stale/new-asset release records and verifies actual unchanged plugin digest algorithms', () => {
        const missing = { ...modernRelease, sharedAssets: modernRelease.sharedAssets.slice(0, -1) };
        expect(() => createPluginRegistry(modernRegistryInput(readAssets(), missing))).toThrow(PluginRegistryError);
        const stale = {
          ...modernRelease, plugins: modernRelease.plugins.map((plugin) =>
            plugin.category === 'agent' ? builtinRelease.plugins.find((old) => old.id === plugin.id)! : plugin)
        };
        expect(() => createPluginRegistry(modernRegistryInput(readAssets(), stale))).toThrow(PluginRegistryError);
        for (const plugin of modernSourceRegistry().inventory) {
          expect(pluginContentDigest(plugin)).toBe(plugin.contentDigest);
        }
      });

      it.each(['graph-object', 'policy-path', 'table-source-row', 'missing-source-row'])(
        'cross-checks real packaged assets against authoritative %s changes', async (variant) => {
          const originalSources = modernActivationSourceContracts();
          const rows = structuredClone(originalSources);
          if (variant === 'graph-object') Reflect.set(rows[0].graph, 'schemaVersion', 99);
          if (variant === 'policy-path') Reflect.set(rows[0], 'policyPathParts', originalSources[3].policyPathParts);
          if (variant === 'table-source-row') Reflect.set(rows[0].identity, 'policyDigest', `sha256:${'0'.repeat(64)}`);
          if (variant === 'missing-source-row') Reflect.set(rows, 'length', rows.length - 1);
          vi.resetModules();
          vi.doMock('../src/domain/governance/policy/identity.js', async () => {
            const actual = await vi.importActual<typeof import('../src/domain/governance/policy/identity.js')>(
              '../src/domain/governance/policy/identity.js');
            return { ...actual, modernActivationSourceContracts: () => rows };
          });
          try {
            const isolated = await import('../src/application/project/modern-plugins.js');
            expect(() => isolated.createModernSourceRegistry()).toThrow(
              variant === 'graph-object' ? 'canonical hash' : variant === 'policy-path' ? 'packaged declaration' : 'authoritative static source contracts');
          } finally {
            vi.doUnmock('../src/domain/governance/policy/identity.js');
            vi.resetModules();
          }
        });

      it('keeps current imports/generation independent of missing modern assets and retries failed modern initialization', async () => {
        const oldPlan = buildProjectPlan({
          projectName: 'Old Source', projectType: 'standard', apiStack: 'node-fastify', cloud: 'azure', agents: ['github-copilot']
        }, { requireProjectName: true });
        const expected = buildArtifacts(oldPlan);
        const modernRead = vi.fn();
        let missing = true;
        vi.resetModules();
        vi.doMock('../src/adapters/packaged-assets/plugin-assets.js', async () => {
          const actual = await vi.importActual<typeof import('../src/adapters/packaged-assets/plugin-assets.js')>(
            '../src/adapters/packaged-assets/plugin-assets.js');
          return {
            ...actual,
            readDeclaredAssetBytes: (...args: Parameters<typeof actual.readDeclaredAssetBytes>) => {
              if (args[0].some((asset) => asset.id === 'modern-governance-source-contracts')) {
                modernRead();
                if (missing) throw new Error('actual modern source asset unavailable');
              }
              return actual.readDeclaredAssetBytes(...args);
            }
          };
        });
        try {
          const application = await import('../src/application/project/manifest.js');
          const templates = await import('../src/templates.js');
          const registry = await import('../src/application/project/modern-plugins.js');
          expect(modernRead).not.toHaveBeenCalled();
          expect(templates.buildArtifacts(oldPlan)).toEqual(expected);
          const raw: unknown = JSON.parse(readFileSync(
            'tests/fixtures/contract-baseline-0.12.3/manifests/0.12.3-standard-go.json', 'utf8'));
          expect(application.parseManifest(raw)).toEqual(parseManifest(raw));
          expect(modernRead).not.toHaveBeenCalled();
          expect(() => registry.modernSourceRegistry()).toThrow('actual modern source asset unavailable');
          expect(modernRead).toHaveBeenCalledTimes(1);
          missing = false;
          const instance = registry.modernSourceRegistry();
          expect(instance.registryDigest).toBe(modernSourceRegistry().registryDigest);
          expect(modernRead).toHaveBeenCalledTimes(2);
          expect(registry.modernSourceRegistry()).toBe(instance);
          expect(modernRead).toHaveBeenCalledTimes(2);
          expect(templates.buildArtifacts(oldPlan)).toEqual(expected);
        } finally {
          vi.doUnmock('../src/adapters/packaged-assets/plugin-assets.js');
          vi.resetModules();
        }
      });
    });
  it('changes only exact agent setup/assessment applicability and agent content version', () => {
    const sourceRegistry = builtinPluginRegistry();
    for (const original of builtinDescriptors) {
      const modern = modernDescriptors.find((descriptor) => descriptor.id === original.id)!;
      if (original.category !== 'agent') {
        expect(modern).toBe(original);
        continue;
      }
      const integration = Object.entries(governanceAgentIntegrations).find(([id]) => id === original.id)![1];
      expect(modern).not.toBe(original);
      expect(original.contentVersion).toBe(4);
      expect(modern.contentVersion).toBe(2);
      expect(modern).toEqual({
        ...original,
        contentVersion: 2,
        artifacts: original.artifacts.map((artifact) =>
          artifact.logicalName === integration.setup.logicalName || artifact.logicalName === integration.assessment.logicalName
            ? { ...artifact, when: { governanceProfile: ['single-maintainer-gitflow', 'team-gitflow'] } }
            : artifact)
      });
      const repair = modern.artifacts.find((artifact) => artifact.logicalName === integration.repair.logicalName)!;
      expect(repair).toBe(original.artifacts.find((artifact) => artifact.logicalName === integration.repair.logicalName));
      expect(repair).not.toHaveProperty('when');
      // These plugins have no assets; this checks their actual declaration change, not a C1 release qualification.
      const actualDigest = pluginContentDigest({ ...modern, assets: [], sharedAssets: [] });
      expect(actualDigest).not.toBe(sourceRegistry.inventory.find((entry) => entry.id === original.id)!.contentDigest);
    }
  });

  it('broadens only the six explicitly registered core handoff identities', () => {
    const changed = modernCore.artifacts.filter((artifact, index) => artifact !== builtinCore.artifacts[index]);
    expect(changed.map((artifact) => artifact.logicalName).sort()).toEqual([
      'repository-governance-compatibility', 'repository-governance-context',
      'repository-governance-credential-policy-schema', 'repository-governance-guide',
      'repository-governance-phase-graph', 'repository-governance-policy'
    ]);
    for (const artifact of changed) {
      const original = builtinCore.artifacts.find((entry) => entry.logicalName === artifact.logicalName)!;
      expect(artifact).toEqual({ ...original, when: { governanceProfile: ['single-maintainer-gitflow', 'team-gitflow'] } });
      expect(original.when).toEqual({ governanceProfile: ['single-maintainer-gitflow'] });
    }
    expect(modernCore.managedCore).toBe(builtinCore.managedCore);
    expect(modernCore.retiredLogicalNames).toBe(builtinCore.retiredLogicalNames);
    expect(modernCore.artifacts).toHaveLength(builtinCore.artifacts.length);
  });

  it('retains actual workload/environment data and isolates the modern profile selection space', () => {
    expect(modernSelectionSpace.workloads).toBe(builtinSelectionSpace.workloads);
    expect(modernSelectionSpace.environments).toBe(builtinSelectionSpace.environments);
    expect(modernSelectionSpace.governanceProfiles).toEqual(['none', 'single-maintainer-gitflow', 'team-gitflow']);
    expect(builtinSelectionSpace.governanceProfiles).toEqual(['single-maintainer-gitflow', 'none']);
    expect(modernSelectionSpace.workloads.find((workload) => workload.id === 'genai')?.variants).toHaveLength(9);
  });

  it('reuses all thirteen dependency assets and adds three exact core source assets without fake sets', () => {
    expect(builtinAssets).toHaveLength(13);
    expect(modernAssets).toHaveLength(16);
    expect(modernAssets.slice(0, 13)).toEqual(builtinAssets.map(({ owner, id, pathParts }) => ({ owner, id, pathParts })));
    expect(modernAssets.slice(13)).toEqual(modernGovernanceAssets);
    expect(modernGovernanceAssets.map((asset) => [asset.id, asset.pathParts.join('/')])).toEqual([
      ['modern-single-maintainer-policy', 'assets/governance/single-maintainer-gitflow/policy-v7.md'],
      ['modern-team-policy', 'assets/governance/team-gitflow/policy-v1.md'],
      ['modern-governance-source-contracts', 'assets/governance/modern/source-contracts.json']
    ]);
    for (const asset of modernAssets) {
      expect(Object.keys(asset).sort()).toEqual(['id', 'owner', 'pathParts']);
      expect(asset).not.toHaveProperty('set');
      expect(asset).not.toHaveProperty('role');
    }
    expect(modernGovernanceAssets.every((asset) => asset.owner.kind === 'core')).toBe(true);
    expect(modernCore.sharedAssets).toEqual([
      ...builtinCore.sharedAssets,
      ...modernGovernanceAssets.map(({ id, pathParts }) => ({ id, pathParts }))
    ]);
  });

  it('does not qualify a modern registry with the old release and missing C1 assets', () => {
    const input = modernRegistryInput([], builtinRelease);
    expect(input.descriptors).toBe(modernDescriptors);
    expect(input.core).toBe(modernCore);
    expect(input.selectionSpace).toBe(modernSelectionSpace);
    expect(input.release).toBe(builtinRelease);
    expect(input.assets).toEqual([]);
    expect(() => createPluginRegistry(input)).toThrow(PluginRegistryError);
    expect(builtinRelease.plugins.some((record) => record.id === 'manual')).toBe(false);
    expect(builtinRelease.sharedAssets).toHaveLength(2);
  });

  it('freezes declaration copies without changing original registrations', () => {
    for (const value of [modernDescriptors, modernCore, modernSelectionSpace, modernAssets, modernGovernanceAssets,
      ...modernDescriptors, ...modernCore.artifacts, ...modernCore.sharedAssets, ...modernAssets]) {
      expect(Object.isFrozen(value)).toBe(true);
      expect(Reflect.set(value, 'extra', true)).toBe(false);
    }
    expect(Object.isFrozen(builtinCore)).toBe(true);
    expect(Object.isFrozen(builtinRelease)).toBe(true);
    expect(builtinDescriptors.filter((descriptor) => descriptor.category === 'agent').every((descriptor) => descriptor.contentVersion === 4)).toBe(true);
  });
});
