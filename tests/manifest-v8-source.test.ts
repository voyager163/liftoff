import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  parseManifest, resolveInstalledManifestBindingContext, resolveManifestLayoutDescriptor, resolveManifestV8SourceContract
} from '../src/application/project/manifest.js';
import {
  builtinPluginRegistry, composeManifestPlugins, composeProjectPlugins, pluginSelectionForPlan, type ProjectPluginComposition
} from '../src/application/project/plugins.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { toSafeProjectName } from '../src/domain/project/planning.js';
import type { ProjectOptions, ProjectPlan } from '../src/domain/project/contracts.js';
import type { PluginRegistry } from '../src/plugins/contracts.js';
import { retiredFlatRootInfrastructureIdentities } from '../src/domain/project/infrastructure-layout.js';
import { repairManagedCoreLogicalNames } from '../src/domain/project/artifact-lifecycle.js';
import { validateManifestActiveLayout } from '../src/domain/project/manifest/layout.js';
import { bootstrapChangeToken } from '../src/domain/project/artifact-path-tokens.js';
import { buildArtifacts } from '../src/templates.js';

const selectedPlan = (options: ProjectOptions = {}) => buildProjectPlan({
  projectName: 'Recorded Source', projectType: 'standard', apiStack: 'node-fastify',
  cloud: 'azure', region: 'eastus', agents: ['github-copilot'], environments: ['dev'], ...options
}, { requireProjectName: true });

function sourceRequest(plan: ProjectPlan) {
  const plugin = resolveInstalledManifestBindingContext(plan).plugins;
  const identity = {
    kind: plan.workload, apiStack: plan.apiStack.id, cloud: plan.provider.id,
    region: plan.region.slug, frontend: plan.includeFrontend,
    environments: plan.environments.map((environment) => environment.id),
    ...(plan.workload === 'genai' ? { pattern: plan.pattern.id } : {})
  };
  return {
    selection: {
      project: {
        name: plan.projectName, workload: identity, specWorkflow: plan.specWorkflow.id,
        agents: plan.agents.map((agent) => agent.id),
        ...(plan.defaultAgent ? { defaultAgent: plan.defaultAgent.id } : {})
      },
      framework: {
        state: plan.agents.length ? 'initialized' : 'legacy',
        adapter: plan.specWorkflow.id,
        ...(plan.agents.length ? { contractVersion: plan.framework.version } : {})
      },
      profile: plan.governanceProfile.id
    },
    recordedPlugins: structuredClone(plugin)
  };
}

const subsets = [
  [], ['github-copilot'], ['claude'], ['codex'],
  ['github-copilot', 'claude'], ['github-copilot', 'codex'], ['claude', 'codex'],
  ['github-copilot', 'claude', 'codex']
];
const variants: { label: string; options: ProjectOptions }[] = [
  ...['python-fastapi', 'node-fastify', 'go-huma'].map((apiStack) =>
    ({ label: apiStack, options: { projectType: 'standard', apiStack } })),
  ...['generic', 'rag', 'chatbot', 'agent', 'prompt', 'multi-agent', 'fine-tuned', 'streaming', 'workflow'].map((pattern) =>
    ({ label: `genai-${pattern}`, options: { projectType: 'genai', apiStack: 'python-fastapi', pattern } }))
];

describe('actual installed v8 source-contract producer', () => {
  it.each(variants)('resolves actual $label sources without changing recorded intent', ({ options }) => {
    for (const workflow of ['openspec', 'spec-kit']) {
      for (const profile of ['none', 'single-maintainer-gitflow']) {
        for (const [index, agents] of subsets.entries()) {
          const plan = selectedPlan({
            ...options, specWorkflow: workflow, governanceProfile: profile,
            agents: agents.length ? [...agents] : ['github-copilot'],
            ...(workflow === 'spec-kit' && agents.length ? { defaultAgent: agents.at(-1) } : {}),
            includeFrontend: index % 2 === 0, environments: index % 2 === 0 ? ['prod', 'dev'] : ['staging']
          });
          if (!agents.length) {
            plan.agents = [];
            plan.defaultAgent = undefined;
          }
          const request = sourceRequest(plan);
          const before = structuredClone(request);
          const result = resolveManifestV8SourceContract(request);
          const composition = composeProjectPlugins(plan);
          expect(request).toEqual(before);
          expect(result.plugins).toEqual(request.recordedPlugins);
          expect(result.plugins.resolutionDigest).toBe(composition.resolution.digest);
          expect(result.layoutDescriptor).toEqual(resolveManifestLayoutDescriptor(plan));
          expect(result.managedArtifacts).toEqual(composition.expected
            .filter((artifact) => artifact.lifecycle === 'managed-core')
            .map(({ logicalName, category, pathParts }) => ({ logicalName, category, pathParts })));
          expect(result.requiredHandoffLogicalNames).toEqual(profile === 'none' ? [] :
            result.managedArtifacts.filter(({ logicalName }) =>
              !repairManagedCoreLogicalNames.some((name) => name === logicalName)).map(({ logicalName }) => logicalName));
          expect(result.readableProjectLogicalNames).toEqual([...new Set([
            ...composition.expected.filter((artifact) => artifact.lifecycle === 'project').map((artifact) => artifact.logicalName),
            ...retiredFlatRootInfrastructureIdentities.map((artifact) => artifact.logicalName)
          ])].sort());
          expect(result).toEqual(resolveManifestV8SourceContract(request));
          expect(result.plugins.selections.filter((entry) => entry.category === 'agent').map((entry) => entry.id))
            .toEqual([...agents].sort());
          expect(request.selection.project.agents).toEqual(agents);
        }
      }
    }
  });

  it('preserves the direct source composition shape and verifies unchanged generated artifact identities', () => {
    const plan = selectedPlan();
    const actual = composeManifestPlugins(pluginSelectionForPlan(plan), { safeProjectName: plan.safeProjectName });
    const previous = composeProjectPlugins(plan);
    expectTypeOf(actual).toEqualTypeOf<ProjectPluginComposition>();
    expect(Object.keys(actual)).toEqual(Object.keys(previous));
    expect(actual.resolution).toEqual(previous.resolution);
    expect(actual.expected).toEqual(previous.expected);
    const generated = buildArtifacts(plan);
    expect(() => actual.verify(generated)).not.toThrow();
    const missing = generated.filter((artifact) => artifact.logicalName !== 'manifest');
    expect(() => actual.verify(missing)).toThrow(/missing-artifact/);
    expect(() => previous.verify(missing)).toThrow(/missing-artifact/);
  });

  it.each(['My App 2', 'Café Ω', '!!!', 'x'.repeat(160)])('materializes only declared source path tokens for %s', (name) => {
    const plan = selectedPlan({ projectName: name });
    const result = resolveManifestV8SourceContract(sourceRequest(plan));
    const expected = composeProjectPlugins(plan);
    const direct = composeManifestPlugins(pluginSelectionForPlan(plan), { safeProjectName: toSafeProjectName(name) });
    expect(direct.expected).toEqual(expected.expected);
    expect(result.layoutDescriptor).toEqual(resolveManifestLayoutDescriptor(plan));
    expect(result.layoutDescriptor.protectedPaths.filter((parts) => parts[0] === 'openspec' && parts[1] === 'changes')
      .every((parts) => parts[2] === `bootstrap-${toSafeProjectName(name)}`)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(bootstrapChangeToken);
  });

  it('keeps historical readable identities out of active bindings, managed ownership and access scope', () => {
    const result = resolveManifestV8SourceContract(sourceRequest(selectedPlan()));
    for (const retired of retiredFlatRootInfrastructureIdentities) {
      expect(result.readableProjectLogicalNames).toContain(retired.logicalName);
      expect(result.layoutDescriptor.artifacts.some((entry) => entry.logicalName === retired.logicalName)).toBe(false);
      expect(result.managedArtifacts.some((entry) => entry.logicalName === retired.logicalName)).toBe(false);
      expect(() => validateManifestActiveLayout({
        schemaVersion: 1, state: 'bound', bindings: [
          { kind: 'artifact', logicalName: retired.logicalName, pathParts: retired.pathParts }
        ]
      }, result.layoutDescriptor)).toThrow('unknown or unselected artifact');
    }
    expect(Object.keys(result).sort()).toEqual([
      'layoutDescriptor', 'managedArtifacts', 'plugins', 'readableProjectLogicalNames', 'requiredHandoffLogicalNames'
    ]);
    expect(result).not.toHaveProperty('mutations');
    expect(result).not.toHaveProperty('sourcePaths');
    expect(result).not.toHaveProperty('activationIdentity');
  });

  it('returns independent frozen data without freezing caller metadata', () => {
    const request = sourceRequest(selectedPlan());
    const before = structuredClone(request);
    const result = resolveManifestV8SourceContract(request);
    expect(request).toEqual(before);
    expect(Object.isFrozen(request)).toBe(false);
    expect(Object.isFrozen(request.recordedPlugins)).toBe(false);
    expect(result.plugins).not.toBe(request.recordedPlugins);
    for (const value of [result, result.plugins, result.plugins.selections, ...result.plugins.selections,
      result.layoutDescriptor, result.managedArtifacts, ...result.managedArtifacts,
      ...result.managedArtifacts.map((entry) => entry.pathParts), result.readableProjectLogicalNames,
      result.requiredHandoffLogicalNames]) expect(Object.isFrozen(value)).toBe(true);
    Reflect.set(request.recordedPlugins, 'resolutionDigest', `sha256:${'f'.repeat(64)}`);
    request.selection.project.name = 'New current name';
    expect(result.plugins).toEqual(before.recordedPlugins);
  });
});

describe('source contract rejects missing, foreign and contradictory metadata', () => {
  it.each([
    { label: 'pattern', options: { pattern: 'chatbot' } },
    { label: 'profile', options: { governanceProfile: 'none' } },
    { label: 'frontend', options: { includeFrontend: true } },
    { label: 'environments', options: { environments: ['dev', 'prod'] } }
  ])('does not accept another full $label resolution just because plugin rows agree', ({ options }) => {
    const base = { projectType: 'genai', apiStack: 'python-fastapi', pattern: 'rag' };
    const original = sourceRequest(selectedPlan(base));
    const changed = sourceRequest(selectedPlan({ ...base, ...options }));
    expect(original.recordedPlugins.selections).toEqual(changed.recordedPlugins.selections);
    expect(original.recordedPlugins.resolutionDigest).not.toBe(changed.recordedPlugins.resolutionDigest);
    expect(() => resolveManifestV8SourceContract({
      selection: changed.selection, recordedPlugins: original.recordedPlugins
    })).toThrow('exact installed release-owned source contract');
  });

  it.each(['apiVersion', 'contentVersion', 'contentDigest', 'resolutionDigest'])('rejects changed %s with remaining source identity unchanged', (field) => {
    const request = sourceRequest(selectedPlan());
    if (field === 'resolutionDigest') Reflect.set(request.recordedPlugins, field, `sha256:${'e'.repeat(64)}`);
    else Reflect.set(request.recordedPlugins.selections[0], field,
      field === 'contentDigest' ? `sha256:${'e'.repeat(64)}` : Number.MAX_SAFE_INTEGER);
    expect(() => resolveManifestV8SourceContract(request)).toThrow('exact installed release-owned source contract');
  });

  it('validates workload, region, framework, agent and default fields even when registry rows are unchanged', () => {
    const request = sourceRequest(selectedPlan());
    const cases = [
      { ...request.selection, project: { ...request.selection.project, workload: { ...request.selection.project.workload, region: 'unknown' } } },
      { ...request.selection, project: { ...request.selection.project, workload: { ...request.selection.project.workload, cloud: 'aws' } } },
      { ...request.selection, project: { ...request.selection.project, agents: ['copilot'] } },
      { ...request.selection, project: { ...request.selection.project, defaultAgent: 'github-copilot' } },
      { ...request.selection, framework: { state: 'initialized', adapter: 'spec-kit', contractVersion: '1.0.0' } },
      { ...request.selection, framework: { state: 'initialized', adapter: 'openspec', contractVersion: 'latest' } }
    ];
    for (const selection of cases) expect(() => resolveManifestV8SourceContract({ ...request, selection })).toThrow();
  });

  it.each(['Manual', '', 'unknown', null, 1, undefined].map((profile) => ({ profile })))(
    'rejects invalid source profile %#', ({ profile }) => {
      const request = sourceRequest(selectedPlan());
      expect(() => resolveManifestV8SourceContract({
        ...request, selection: { ...request.selection, profile }
      })).toThrow('source profile');
    });

  it('recognizes Manual/team syntax without borrowing an installed source descriptor', () => {
    const request = sourceRequest(selectedPlan());
    const manualPlugins = {
      ...request.recordedPlugins,
      selections: request.recordedPlugins.selections.map((entry) => entry.category === 'workflow'
        ? { ...entry, id: 'manual' } : entry)
    };
    expect(() => resolveManifestV8SourceContract({
      selection: {
        project: { ...request.selection.project, specWorkflow: 'manual' },
        framework: { state: 'not-required' }, profile: 'none'
      },
      recordedPlugins: manualPlugins
    })).toThrow(/unknown|unsupported|invalid/i);
    expect(() => resolveManifestV8SourceContract({
      ...request, selection: { ...request.selection, profile: 'team-gitflow' }
    })).toThrow(/unknown|unsupported|invalid/i);
  });

  it('does not fabricate missing recorded plugin data or tolerate request authority fields', () => {
    const request = sourceRequest(selectedPlan());
    for (const invalid of [undefined, null, [], {}, { selection: request.selection },
      { ...request, recordedPlugins: undefined }, { ...request, targetIdentity: {} },
      { ...request, sourceManifestHistory: {} }, { ...request, selection: { ...request.selection, approval: true } }]) {
      expect(() => resolveManifestV8SourceContract(invalid)).toThrow();
    }
  });

  it('rejects own-data/accessor violations before executing untrusted hooks', () => {
    for (const part of ['selection', 'recordedPlugins']) {
      const request = sourceRequest(selectedPlan());
      const hook = vi.fn(() => { throw new Error('untrusted accessor ran'); });
      Object.defineProperty(request, part, { enumerable: true, get: hook });
      expect(() => resolveManifestV8SourceContract(request)).toThrow('own enumerable data field');
      expect(hook).not.toHaveBeenCalled();
    }
    for (const part of ['project', 'framework', 'profile']) {
      const request = sourceRequest(selectedPlan());
      const hook = vi.fn(() => { throw new Error('selection accessor ran'); });
      Object.defineProperty(request.selection, part, { enumerable: true, get: hook });
      expect(() => resolveManifestV8SourceContract(request)).toThrow('own enumerable data field');
      expect(hook).not.toHaveBeenCalled();
    }
    const request = sourceRequest(selectedPlan());
    expect(() => resolveManifestV8SourceContract(Object.create(request))).toThrow('plain JSON object');
    const hook = vi.fn(() => 'none');
    expect(() => resolveManifestV8SourceContract({
      ...request, selection: { ...request.selection, profile: { toString: hook, [Symbol.toPrimitive]: hook } }
    })).toThrow('source profile');
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('shared composition preserves original evaluation order', () => {
  it('reports framework or resolution errors before reading the project path-token value', () => {
    const registry = builtinPluginRegistry();
    const plan = structuredClone(selectedPlan());
    const tokenRead = vi.fn(() => { throw new Error('safeProjectName read too early'); });
    Object.defineProperty(plan, 'safeProjectName', { get: tokenRead });
    plan.framework.id = 'spec-kit';
    expect(() => composeProjectPlugins(plan, registry)).toThrow('workflow-framework-mismatch');
    expect(tokenRead).not.toHaveBeenCalled();
    plan.framework.id = 'openspec';
    const failure = new Error('exact resolution failure');
    const failingRegistry: PluginRegistry = { ...registry, resolveSelection: () => { throw failure; } };
    expect(() => composeProjectPlugins(plan, failingRegistry)).toThrow(failure);
    expect(tokenRead).not.toHaveBeenCalled();
  });

  it('keeps token validation before safeProjectName access, and concrete validation after it', () => {
    const registry = builtinPluginRegistry();
    const plan = structuredClone(selectedPlan());
    const tokenRead = vi.fn(() => '../escape');
    Object.defineProperty(plan, 'safeProjectName', { get: tokenRead });
    const badTokens: PluginRegistry = {
      ...registry,
      resolveSelection: (selection, host) => {
        const resolution = registry.resolveSelection(selection, host);
        return { ...resolution, artifacts: resolution.artifacts.map((entry) =>
          entry.logicalName === 'root-readme' ? { ...entry, pathParts: ['bad', bootstrapChangeToken, 'file'] } : entry) };
      }
    };
    expect(() => composeProjectPlugins(plan, badTokens)).toThrow('token-misplaced');
    expect(tokenRead).not.toHaveBeenCalled();
    expect(() => composeProjectPlugins(plan, registry)).toThrow(/non-portable-path/);
    expect(tokenRead).toHaveBeenCalledTimes(1);
  });

  it('evaluates the default registry before project properties, but does not evaluate it when injected', async () => {
    const plan = selectedPlan();
    const registry = builtinPluginRegistry();
    const failure = new Error('packaged registry unavailable');
    const read = vi.fn(() => { throw failure; });
    vi.resetModules();
    vi.doMock('../src/adapters/packaged-assets/plugin-assets.js', async () => {
      const original = await vi.importActual<typeof import('../src/adapters/packaged-assets/plugin-assets.js')>(
        '../src/adapters/packaged-assets/plugin-assets.js');
      return { ...original, readDeclaredAssetBytes: read };
    });
    try {
      const composition = await import('../src/application/project/plugins.js');
      const frameworkRead = vi.fn(() => { throw new Error('framework getter'); });
      Object.defineProperty(plan, 'framework', { get: frameworkRead });
      expect(() => composition.composeProjectPlugins(plan)).toThrow(failure);
      expect(read).toHaveBeenCalledTimes(1);
      expect(frameworkRead).not.toHaveBeenCalled();
      expect(() => composition.composeProjectPlugins(plan, registry)).toThrow('framework getter');
      expect(read).toHaveBeenCalledTimes(1);
      expect(frameworkRead).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('../src/adapters/packaged-assets/plugin-assets.js');
      vi.resetModules();
    }
  });

  it('composes genuine legacy-empty source once without planner, template renderer or eager registry calls', async () => {
    const plan = selectedPlan();
    plan.agents = [];
    plan.defaultAgent = undefined;
    const request = sourceRequest(plan);
    const actual = composeProjectPlugins(plan);
    const compose = vi.fn(() => actual);
    const forbidden = vi.fn(() => { throw new Error('scaffold/renderer/target path used'); });
    vi.resetModules();
    vi.doMock('../src/application/project/plugins.js', () => ({
      composeManifestPlugins: compose, composeProjectPlugins: forbidden
    }));
    vi.doMock('../src/application/project/planning.js', () => ({ buildProjectPlan: forbidden }));
    vi.doMock('../src/templates.js', () => ({ buildArtifacts: forbidden, buildManifest: forbidden }));
    try {
      const application = await import('../src/application/project/manifest.js');
      expect(compose).not.toHaveBeenCalled();
      const raw: unknown = JSON.parse(readFileSync(
        new URL('./fixtures/contract-baseline-0.12.3/manifests/0.12.3-standard-go.json', import.meta.url), 'utf8'));
      expect(application.parseManifest(raw)).toEqual(parseManifest(raw));
      expect(compose).not.toHaveBeenCalled();
      const result = application.resolveManifestV8SourceContract(request);
      expect(compose).toHaveBeenCalledTimes(1);
      expect(compose.mock.calls[0]).toEqual([
        {
          workload: 'standard', stack: 'node-fastify', cloud: 'azure', workflow: 'openspec',
          agents: [], frontend: 'omitted', governanceProfile: 'single-maintainer-gitflow', environments: ['dev']
        },
        { safeProjectName: 'recorded-source' }
      ]);
      expect(result.plugins.selections.some((entry) => entry.category === 'agent')).toBe(false);
      expect(request.selection.framework).toEqual({ state: 'legacy', adapter: 'openspec' });
      expect(request.selection.project.agents).toEqual([]);
      expect(request.selection.project).not.toHaveProperty('defaultAgent');
      expect(forbidden).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../src/application/project/plugins.js');
      vi.doUnmock('../src/application/project/planning.js');
      vi.doUnmock('../src/templates.js');
      vi.resetModules();
    }
  });
});
