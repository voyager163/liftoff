import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { projectCatalog } from '../src/application/project/catalog.js';
import {
  managedCoreArtifactPaths,
  retiredManagedCoreIdentities
} from '../src/domain/project/artifact-lifecycle.js';
import {
  artifactPathTokenIssues,
  containsArtifactPathToken,
  materializeArtifactPathParts
} from '../src/domain/project/artifact-path-tokens.js';
import { pluginSelectionForPlan } from '../src/application/project/plugins.js';
import type { GeneratedArtifact, ProjectPlan } from '../src/domain/project/contracts.js';
import {
  currentInfrastructureIdentities,
  retiredFlatRootInfrastructureIdentities
} from '../src/domain/project/infrastructure-layout.js';
import { supportedHostPlatforms } from '../src/domain/project/supported-stack.js';
import { builtinAssets } from '../src/plugins/builtin/assets.js';
import {
  builtinCore,
  builtinDescriptors,
  builtinOperations,
  builtinRegistryInput,
  builtinRelease,
  builtinReleaseDigests,
  builtinSelectionSpace
} from '../src/plugins/builtin/index.js';
import type {
  ArtifactDeclaration,
  ContributionOwner,
  PackagedAssetBytes,
  PluginCondition,
  PluginDescriptor,
  PluginRegistry,
  PluginReleaseInventory,
  PluginSelection,
  Sha256Digest
} from '../src/plugins/contracts.js';
import { createPluginRegistry, pluginContentDigest } from '../src/plugins/registry.js';
import { buildArtifacts } from '../src/templates.js';
import { matrixPlan, pluginGenerationMatrix, type MatrixCase } from './fixtures/plugin-generation-matrix.js';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha256 = (bytes: Uint8Array): Sha256Digest => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// ---------------------------------------------------------------------------------------------
// Test-local construction from the real descriptors and unchanged packaged bytes.
// ---------------------------------------------------------------------------------------------

function packagedBytes(): PackagedAssetBytes[] {
  return builtinAssets.map((asset) => ({
    pathParts: asset.pathParts,
    bytes: readFileSync(path.join(repositoryRoot, ...asset.pathParts))
  }));
}

function computedRelease(descriptors: readonly PluginDescriptor[], bytes: readonly PackagedAssetBytes[]): PluginReleaseInventory {
  const digestOf = new Map(builtinAssets.map((asset, index) => [asset.id, sha256(bytes[index].bytes)]));
  const record = (asset: { id: string; pathParts: readonly string[] }) =>
    ({ id: asset.id, pathParts: [...asset.pathParts], sha256: digestOf.get(asset.id) as Sha256Digest });
  return {
    schemaVersion: 1,
    sharedAssets: builtinCore.sharedAssets.map(record),
    plugins: descriptors.map((descriptor) => ({
      category: descriptor.category,
      id: descriptor.id,
      apiVersion: descriptor.apiVersion,
      contentVersion: descriptor.contentVersion,
      contentDigest: pluginContentDigest({
        category: descriptor.category,
        id: descriptor.id,
        apiVersion: descriptor.apiVersion,
        contentVersion: descriptor.contentVersion,
        hostPlatforms: descriptor.hostPlatforms,
        supports: descriptor.supports,
        artifacts: descriptor.artifacts,
        assets: descriptor.assets.map((asset) => ({ id: asset.id, sha256: digestOf.get(asset.id) as Sha256Digest })),
        sharedAssets: [],
        checks: descriptor.checks,
        recipes: descriptor.recipes
      }),
      assets: descriptor.assets.map(record)
    }))
  };
}

function testRegistry(descriptors: readonly PluginDescriptor[] = builtinDescriptors): PluginRegistry {
  const bytes = packagedBytes();
  return createPluginRegistry({
    descriptors,
    core: builtinCore,
    selectionSpace: builtinSelectionSpace,
    operations: builtinOperations,
    release: computedRelease(descriptors, bytes),
    assets: bytes
  });
}

// ---------------------------------------------------------------------------------------------
// An evaluator independent of the registry, used for witness measurement.
// ---------------------------------------------------------------------------------------------

interface Declared {
  readonly owner: ContributionOwner;
  readonly declaration: ArtifactDeclaration;
}

const ownerKey = (owner: ContributionOwner): string => (owner.kind === 'core' ? 'core' : `${owner.category}:${owner.id}`);

const declarations: readonly Declared[] = [
  ...builtinCore.artifacts.map((declaration): Declared => ({ owner: { kind: 'core' }, declaration })),
  ...builtinDescriptors.flatMap((descriptor) => descriptor.artifacts.map((declaration): Declared => ({
    owner: { kind: 'plugin', category: descriptor.category, id: descriptor.id },
    declaration
  })))
];

function selectionFor(plan: ProjectPlan): PluginSelection {
  return {
    workload: plan.workload,
    ...(plan.workload === 'genai' ? { variant: plan.pattern.id } : {}),
    stack: plan.apiStack.id,
    cloud: plan.provider.id,
    workflow: plan.specWorkflow.id,
    agents: plan.agents.map((agent) => agent.id),
    frontend: plan.includeFrontend ? 'included' : 'omitted',
    governanceProfile: plan.governanceProfile.id,
    environments: plan.environments.map((environment) => environment.id)
  };
}

interface Constraint {
  readonly dimension: string;
  readonly holds: (selection: PluginSelection) => boolean;
}

const scalarDimensions = ['workload', 'variant', 'stack', 'cloud', 'workflow', 'frontend', 'governanceProfile'] as const;

function constraintsOf({ owner, declaration }: Declared): Constraint[] {
  const constraints: Constraint[] = [];
  if (owner.kind === 'plugin') {
    constraints.push({
      dimension: `owner:${owner.category}`,
      holds: owner.category === 'agent'
        ? (selection) => selection.agents.includes(owner.id)
        : (selection) => selection[owner.category as 'stack' | 'cloud' | 'workflow'] === owner.id
    });
  }
  const when: PluginCondition = declaration.when ?? {};
  for (const dimension of scalarDimensions) {
    const allowed = when[dimension];
    if (allowed !== undefined) {
      constraints.push({ dimension, holds: (selection) => (allowed as readonly string[]).includes(selection[dimension] as string) });
    }
  }
  if (when.agent !== undefined) {
    const allowed = when.agent;
    constraints.push({ dimension: 'agent', holds: (selection) => selection.agents.some((agent) => allowed.includes(agent)) });
  }
  if (when.environment !== undefined) {
    const allowed = when.environment;
    constraints.push({ dimension: 'environment', holds: (selection) => selection.environments.some((environment) => allowed.includes(environment)) });
  }
  return constraints;
}

const applies = (declared: Declared, selection: PluginSelection): boolean =>
  constraintsOf(declared).every((constraint) => constraint.holds(selection));

type Identity = string;

const renderedIdentity = (artifact: GeneratedArtifact): Identity => JSON.stringify([
  artifact.logicalName,
  artifact.category,
  artifact.lifecycle,
  artifact.lifecycle === 'project' ? artifact.provisioningGroup : null,
  artifact.pathParts
]);

const declaredIdentity = (declaration: ArtifactDeclaration, plan: ProjectPlan): Identity => JSON.stringify([
  declaration.logicalName,
  declaration.category,
  declaration.lifecycle,
  declaration.provisioningGroup ?? null,
  materializeArtifactPathParts(declaration.pathParts, { safeProjectName: plan.safeProjectName })
]);

const sorted = (values: Iterable<string>): string[] => [...values].sort();

/** Every valid selection: 96 scalar contexts, 8 agent subsets (including none) and 7 environment subsets. */
function fullSelectionSpace(): PluginSelection[] {
  const workloads = [
    { workload: 'standard', stack: 'python-fastapi' },
    { workload: 'standard', stack: 'node-fastify' },
    { workload: 'standard', stack: 'go-huma' },
    ...['generic', 'rag', 'chatbot', 'agent', 'prompt', 'multi-agent', 'fine-tuned', 'streaming', 'workflow']
      .map((variant) => ({ workload: 'genai', variant, stack: 'python-fastapi' }))
  ];
  const subsets = <T>(values: readonly T[]): T[][] =>
    Array.from({ length: 2 ** values.length }, (_, mask) => values.filter((_, index) => (mask >> index) & 1));
  const agentSets = subsets(['github-copilot', 'claude', 'codex']);
  const environmentSets = subsets(['dev', 'staging', 'prod']).filter((set) => set.length > 0);
  return workloads.flatMap((workload) => ['openspec', 'spec-kit'].flatMap((workflow) =>
    ['omitted', 'included'].flatMap((frontend) => ['single-maintainer-gitflow', 'none'].flatMap((governanceProfile) =>
      agentSets.flatMap((agents) => environmentSets.map((environments): PluginSelection => ({
        ...workload,
        cloud: 'azure',
        workflow,
        agents,
        frontend: frontend as PluginSelection['frontend'],
        governanceProfile,
        environments
      })))))));
}

interface Rendered {
  readonly entry: MatrixCase;
  readonly plan: ProjectPlan;
  readonly selection: PluginSelection;
  readonly identities: ReadonlySet<Identity>;
  readonly artifacts: readonly GeneratedArtifact[];
}

let renderedCache: Rendered[] | undefined;
function renderedMatrix(): Rendered[] {
  renderedCache ??= pluginGenerationMatrix.map((entry) => {
    const plan = matrixPlan(entry);
    const artifacts = buildArtifacts(plan);
    return { entry, plan, selection: selectionFor(plan), artifacts, identities: new Set(artifacts.map(renderedIdentity)) };
  });
  return renderedCache;
}

// ---------------------------------------------------------------------------------------------

describe('built-in plugin descriptors', () => {
  it('declare the closed first-party inventory with the planned counts', () => {
    expect(builtinDescriptors.map((descriptor) => `${descriptor.category}:${descriptor.id}`)).toEqual([
      'stack:python-fastapi', 'stack:node-fastify', 'stack:go-huma', 'cloud:azure',
      'workflow:openspec', 'workflow:spec-kit', 'agent:github-copilot', 'agent:claude', 'agent:codex'
    ]);
    const counts = Object.fromEntries([
      ['core', builtinCore.artifacts],
      ...builtinDescriptors.map((descriptor) => [descriptor.id, descriptor.artifacts] as const)
    ].map(([owner, artifacts]) => [owner, [
      (artifacts as readonly ArtifactDeclaration[]).length,
      new Set((artifacts as readonly ArtifactDeclaration[]).map((artifact) => artifact.logicalName)).size
    ]]));
    expect(counts).toEqual({
      core: [31, 31],
      'python-fastapi': [103, 43],
      'node-fastify': [15, 15],
      'go-huma': [12, 12],
      azure: [32, 32],
      openspec: [18, 7],
      'spec-kit': [7, 7],
      'github-copilot': [3, 3],
      claude: [3, 3],
      codex: [3, 3]
    });
    expect(declarations).toHaveLength(227);
    expect(new Set(declarations.map(({ declaration }) => declaration.logicalName)).size).toBe(154);
    for (const descriptor of builtinDescriptors) {
      expect(descriptor.apiVersion).toBe(1);
      expect(descriptor.contentVersion).toBe(descriptor.category === 'agent' ? 4 :
        descriptor.id === 'node-fastify' ? 3 : descriptor.id === 'python-fastapi' ? 2 : 1);
      expect(descriptor.hostPlatforms).toEqual([...supportedHostPlatforms]);
      expect([descriptor.sharedAssets, descriptor.checks, descriptor.recipes]).toEqual([[], [], []]);
    }
    // Agents admit every scalar context, so agent-free selections stay within validated contexts (A1).
    expect(Object.fromEntries(builtinDescriptors.map((descriptor) => [descriptor.id, descriptor.supports]))).toEqual({
      'python-fastapi': [{ workload: ['standard'] }, { workload: ['genai'] }],
      'node-fastify': [{ workload: ['standard'] }],
      'go-huma': [{ workload: ['standard'] }],
      azure: [{}],
      openspec: [{}],
      'spec-kit': [{}],
      'github-copilot': [{}],
      claude: [{}],
      codex: [{}]
    });
    expect(builtinOperations).toEqual([]);
  });

  it('are deeply frozen data that never aliases another module table', () => {
    const visit = (value: unknown, where: string, seen: Set<unknown>): void => {
      if (typeof value !== 'object' || value === null) return;
      expect(Object.isFrozen(value), `${where} is frozen`).toBe(true);
      expect(seen.has(value), `${where} is not shared`).toBe(false);
      seen.add(value);
      for (const [key, entry] of Object.entries(value)) visit(entry, `${where}.${key}`, seen);
    };
    const seen = new Set<unknown>();
    for (const [where, root] of Object.entries({ builtinDescriptors, builtinCore, builtinSelectionSpace, builtinOperations })) {
      visit(root, where, seen);
    }
    const tables: unknown[] = [
      ...[...managedCoreArtifactPaths.values()],
      ...currentInfrastructureIdentities(['dev', 'staging', 'prod']).map((identity) => identity.pathParts),
      ...builtinAssets.map((asset) => asset.pathParts)
    ];
    const reachable = new Set<unknown>();
    const collect = (value: unknown): void => {
      if (typeof value !== 'object' || value === null || reachable.has(value)) return;
      reachable.add(value);
      for (const entry of Object.values(value)) collect(entry);
    };
    collect({ builtinDescriptors, builtinCore, builtinSelectionSpace });
    expect(tables.filter((table) => reachable.has(table))).toEqual([]);
    expect(Object.isFrozen(currentInfrastructureIdentities(['dev'])[0].pathParts)).toBe(false);
  });

  it('match the catalog: stacks, patterns, workflows, agents and the only available cloud', () => {
    const catalog = projectCatalog;
    expect(builtinDescriptors.filter((d) => d.category === 'stack').map((d) => d.id)).toEqual(catalog.apiStacks.map((stack) => stack.id));
    expect(builtinDescriptors.filter((d) => d.category === 'workflow').map((d) => d.id)).toEqual(catalog.specWorkflows.map((workflow) => workflow.id));
    expect(builtinDescriptors.filter((d) => d.category === 'agent').map((d) => d.id)).toEqual(catalog.codingAgents.map((agent) => agent.id));
    expect(builtinDescriptors.filter((d) => d.category === 'cloud').map((d) => d.id)).toEqual(
      catalog.providers.filter((provider) => provider.status === 'available').map((provider) => provider.id));
    expect(catalog.providers.map((provider) => [provider.id, provider.status])).toEqual([
      ['azure', 'available'], ['aws', 'planned'], ['gcp', 'planned']
    ]);
    expect(builtinSelectionSpace).toEqual({
      workloads: [{ id: 'genai', variants: catalog.patterns.map((pattern) => pattern.id) }, { id: 'standard', variants: [] }],
      environments: catalog.environments.map((environment) => environment.id),
      governanceProfiles: ['single-maintainer-gitflow', 'none']
    });
    expect(catalog.patterns.map((pattern) => [pattern.id, pattern.scaffoldStatus])).toEqual(
      ['generic', 'rag', 'chatbot', 'agent', 'prompt', 'multi-agent', 'fine-tuned', 'streaming', 'workflow']
        .map((id) => [id, 'foundation']));
    // The nine GenAI identities and their foundation maturity are release behavior, pinned literally.
    const pattern = (id: string, label: string, aliases: string[], description: string, frontendStarter: string,
      routePrefix: string, worker: boolean, requiresVectorStore = false) =>
      ({ id, label, aliases, description, scaffoldStatus: 'foundation', frontendStarter, routePrefix, worker, requiresVectorStore });
    expect(catalog.patterns).toEqual([
      pattern('generic', 'Generic GenAI Starter', ['generic', 'undecided', 'unsure', 'not-sure'],
        'General FastAPI/PydanticAI request-response foundation without specialized orchestration.',
        'Generic AI playground', '/api/ai', false),
      pattern('rag', 'RAG (Knowledge Retrieval)', ['rag', 'retrieval', 'knowledge', 'knowledge-retrieval'],
        'RAG integration foundation with query, ingestion, and vector-store boundaries; retrieval and citation generation are deferred.',
        'RAG foundation interface', '/api/rag', true, true),
      pattern('chatbot', 'Chatbot / Conversational AI', ['chatbot', 'chat', 'conversational', 'conversational-ai'],
        'Conversational request-response foundation; message history, persistence, and memory are deferred.',
        'Chat foundation interface', '/api/chat', false),
      pattern('agent', 'Agent-based (Task Automation)', ['agent', 'agent-based', 'automation', 'task-automation'],
        'Agent invocation and worker foundation; tools and task execution are deferred.',
        'Agent foundation interface', '/api/agent', true),
      pattern('prompt', 'Prompt-based App (Simple LLM)', ['prompt', 'prompt-based', 'simple-llm', 'llm'],
        'Prompt invocation foundation; external prompt loading and specialized structured-output workflows are deferred.',
        'Prompt foundation interface', '/api/invoke', false),
      pattern('multi-agent', 'Multi-Agent System', ['multi-agent', 'multiagent', 'multi-agent-system'],
        'Multi-agent invocation and worker foundation; supervisor-worker coordination and shared orchestration are deferred.',
        'Multi-agent foundation interface', '/api/multi-agent', true),
      pattern('fine-tuned', 'Fine-tuned Model App', ['fine-tuned', 'finetuned', 'fine-tune', 'fine-tuning'],
        'Fine-tuned endpoint and evaluation-data foundation; training, fine-tuning, and model deployment are deferred.',
        'Fine-tuned model foundation interface', '/api/fine-tuned', false),
      pattern('streaming', 'Real-time / Streaming AI', ['streaming', 'real-time', 'realtime', 'sse', 'websocket'],
        'Buffered SSE response foundation; incremental model streaming is deferred.',
        'Buffered SSE foundation interface', '/api/stream', false),
      pattern('workflow', 'AI Workflow / Pipeline', ['workflow', 'pipeline', 'ai-workflow', 'ai-pipeline'],
        'Workflow invocation and worker foundation; pipeline execution, trigger orchestration, and run persistence are deferred.',
        'Workflow foundation interface', '/api/workflows', true)
    ]);
    const workerPatterns = catalog.patterns.filter((entry) => entry.worker).map((entry) => entry.id);
    const python = builtinDescriptors.find((descriptor) => descriptor.id === 'python-fastapi') as PluginDescriptor;
    expect(sorted(python.artifacts.filter((artifact) => artifact.logicalName === 'pattern-worker')
      .flatMap((artifact) => artifact.when?.variant ?? []))).toEqual(sorted(workerPatterns));
  });

  it('reuse the domain identity tables for managed core, retirement and infrastructure', () => {
    expect(builtinCore.managedCore).toEqual([...managedCoreArtifactPaths].map(([logicalName, pathParts]) => ({ logicalName, pathParts })));
    expect(builtinCore.retiredLogicalNames).toEqual([
      ...retiredManagedCoreIdentities.map((identity) => identity.logicalName),
      ...retiredFlatRootInfrastructureIdentities.map((identity) => identity.logicalName)
    ]);
    const azure = builtinDescriptors.find((descriptor) => descriptor.id === 'azure') as PluginDescriptor;
    expect(azure.artifacts.map(({ logicalName, category, pathParts, provisioningGroup }) => ({ logicalName, category, pathParts, provisioningGroup })))
      .toEqual(currentInfrastructureIdentities(['dev', 'staging', 'prod']).map((identity) => ({ ...identity, pathParts: [...identity.pathParts] })));
    const managed = declarations.filter(({ declaration }) => declaration.lifecycle === 'managed-core');
    expect(sorted(managed.map(({ declaration }) => `${declaration.logicalName} ${declaration.pathParts.join('/')}`)))
      .toEqual(sorted([...managedCoreArtifactPaths].map(([logicalName, pathParts]) => `${logicalName} ${pathParts.join('/')}`)));
  });

  it('consume the C1 asset table exactly once per asset', () => {
    const consumed = [
      ...builtinCore.sharedAssets.map((asset) => ['core', asset.id, asset.pathParts.join('/')]),
      ...builtinDescriptors.flatMap((descriptor) => descriptor.assets.map((asset) => [descriptor.id, asset.id, asset.pathParts.join('/')]))
    ];
    expect(sorted(consumed.map((row) => row.join(' ')))).toEqual(sorted(builtinAssets.map((asset) =>
      [asset.owner.kind === 'core' ? 'core' : asset.owner.id, asset.id, asset.pathParts.join('/')].join(' '))));
    expect(new Set(consumed.map((row) => row[2])).size).toBe(13);
  });
});

describe('built-in registry construction', () => {
  it('validates the real descriptors, core and unchanged bytes under the default limits', () => {
    const registry = testRegistry();
    const rank = (category: string) => ['stack', 'cloud', 'workflow', 'agent'].indexOf(category);
    expect(registry.inventory.map((entry) => `${entry.category}:${entry.id}`)).toEqual(
      [...builtinDescriptors].sort((left, right) => rank(left.category) - rank(right.category) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)).map((descriptor) => `${descriptor.category}:${descriptor.id}`));
  });

  it('computes order-independent digests', () => {
    const registry = testRegistry();
    const reversed = [...builtinDescriptors].reverse().map((descriptor) => ({
      ...descriptor,
      artifacts: [...descriptor.artifacts].reverse(),
      hostPlatforms: [...descriptor.hostPlatforms].reverse()
    }));
    const permuted = testRegistry(reversed);
    expect([permuted.pluginSetDigest, permuted.coreContributionDigest, permuted.registryDigest])
      .toEqual([registry.pluginSetDigest, registry.coreContributionDigest, registry.registryDigest]);
  });
});

describe('built-in release record', () => {
  it('equals the values recomputed from the real descriptors and unchanged packaged bytes', () => {
    const recomputed = computedRelease(builtinDescriptors, packagedBytes());
    const registry = testRegistry();
    const digests = {
      pluginSetDigest: registry.pluginSetDigest,
      coreContributionDigest: registry.coreContributionDigest,
      registryDigest: registry.registryDigest
    };
    if (!isDeepStrictEqual(structuredClone(builtinRelease), recomputed) ||
        !isDeepStrictEqual(structuredClone(builtinReleaseDigests), digests)) {
      // Printed for a reviewer to copy by hand into release.ts; nothing writes these values.
      console.log(`Recomputed values for src/plugins/builtin/release.ts:\n${JSON.stringify({
        assets: Object.fromEntries(recomputed.sharedAssets.concat(recomputed.plugins.flatMap((plugin) => plugin.assets))
          .map((asset) => [asset.id, asset.sha256])),
        plugins: recomputed.plugins.map(({ category, id, contentVersion, contentDigest }) => ({ category, id, contentVersion, contentDigest })),
        digests
      }, null, 2)}`);
    }
    expect(builtinRelease).toEqual(recomputed);
    expect(builtinReleaseDigests).toEqual(digests);
  });

  it('builds the registry from the literal release through the real registry input', () => {
    const registry = createPluginRegistry(builtinRegistryInput(packagedBytes()));
    expect({
      pluginSetDigest: registry.pluginSetDigest,
      coreContributionDigest: registry.coreContributionDigest,
      registryDigest: registry.registryDigest
    }).toEqual(builtinReleaseDigests);
    expect(Object.fromEntries(registry.inventory.map((entry) => [entry.id, [entry.contentVersion, entry.contentDigest]])))
      .toEqual(Object.fromEntries(builtinRelease.plugins.map((record) => [record.id, [record.contentVersion, record.contentDigest]])));
    expect(Object.isFrozen(builtinRelease.plugins[0].assets[0].pathParts)).toBe(true);
  });
});

describe('declarations versus unchanged rendering', () => {
  it('map every matrix plan to the same selection as the composition root', () => {
    for (const { entry, plan, selection } of renderedMatrix()) {
      expect(pluginSelectionForPlan(plan), entry.id).toEqual(selection);
    }
  });

  it('place the reserved bootstrap token only where the token module allows', () => {
    const tokenBearing = declarations.filter(({ declaration }) => declaration.pathParts.some(containsArtifactPathToken));
    expect(tokenBearing.map(({ owner, declaration }) => `${ownerKey(owner)} ${declaration.logicalName}`)).toEqual([
      'workflow:openspec openspec-seed-change-metadata',
      'workflow:openspec openspec-seed-proposal',
      'workflow:openspec openspec-seed-design',
      'workflow:openspec openspec-seed-tasks',
      ...Array(12).fill('workflow:openspec openspec-seed-spec')
    ]);
    expect(artifactPathTokenIssues(declarations.map(({ declaration }) => declaration))).toEqual([]);
  });

  it('declare exactly the identities the canonical renderers emit for every matrix plan', () => {
    for (const { entry, plan, selection, artifacts, identities } of renderedMatrix()) {
      const expected = declarations.filter((declared) => applies(declared, selection))
        .map(({ declaration }) => declaredIdentity(declaration, plan));
      expect(sorted(expected), entry.id).toEqual(sorted(artifacts.map(renderedIdentity)));
      expect(identities.size, `${entry.id} renders each identity once`).toBe(artifacts.length);
    }
  });

  it('agree with registry resolution, owner by owner, for every matrix plan', () => {
    const registry = testRegistry();
    for (const { entry, plan, selection } of renderedMatrix()) {
      const resolution = registry.resolveSelection(selection, { platform: 'linux/x64' });
      const resolved = resolution.artifacts.map((artifact) => `${ownerKey(artifact.owner)} ${declaredIdentity(artifact, plan)}`);
      const evaluated = declarations.filter((declared) => applies(declared, selection))
        .map(({ owner, declaration }) => `${ownerKey(owner)} ${declaredIdentity(declaration, plan)}`);
      expect(sorted(resolved), entry.id).toEqual(sorted(evaluated));
    }
  });

  it('witnesses every declaration positively and every witnessable negative in the fixed matrix', () => {
    const matrix = renderedMatrix();
    const space = fullSelectionSpace();
    expect(space).toHaveLength(5376);
    const report: string[] = [];
    const gaps: string[] = [];
    const missingPositive: string[] = [];
    const impossible = new Map<string, number>();
    let equivalentActive = 0;
    let negatives = 0;
    for (const declared of declarations) {
      const { owner, declaration } = declared;
      const label = `${ownerKey(owner)} ${declaration.logicalName} ${declaration.pathParts.join('/')}`;
      const constraints = constraintsOf(declared);
      const positive = matrix.find((rendered) => applies(declared, rendered.selection) &&
        rendered.identities.has(declaredIdentity(declaration, rendered.plan)));
      if (positive === undefined) missingPositive.push(label);
      const outcomes: string[] = [`+${positive?.entry.id ?? 'NONE'}`];
      for (const [index, constraint] of constraints.entries()) {
        const others = constraints.filter((_, position) => position !== index);
        const isNegative = (selection: PluginSelection) =>
          !constraint.holds(selection) && others.every((other) => other.holds(selection));
        const witness = matrix.find((rendered) => isNegative(rendered.selection));
        if (witness !== undefined) {
          negatives += 1;
          const identity = declaredIdentity(declaration, witness.plan);
          if (witness.identities.has(identity)) {
            const equivalents = declarations.filter((other) => other !== declared && applies(other, witness.selection) &&
              declaredIdentity(other.declaration, witness.plan) === identity);
            expect(equivalents.length, `${label} negative ${constraint.dimension} in ${witness.entry.id}`).toBe(1);
            equivalentActive += 1;
            outcomes.push(`-${constraint.dimension}:${witness.entry.id}(equivalent ${ownerKey(equivalents[0].owner)})`);
          } else {
            outcomes.push(`-${constraint.dimension}:${witness.entry.id}`);
          }
          continue;
        }
        if (space.some(isNegative)) {
          gaps.push(`${label} -${constraint.dimension}`);
          outcomes.push(`-${constraint.dimension}:GAP`);
          continue;
        }
        // Minimal subset of the other constraints that already forces this one over the full space.
        let forcing: Constraint[] | undefined;
        for (let size = 0; size <= others.length && forcing === undefined; size += 1) {
          const combinations = (from: number, chosen: Constraint[]): Constraint[] | undefined => {
            if (chosen.length === size) {
              return space.some((selection) => !constraint.holds(selection) && chosen.every((other) => other.holds(selection)))
                ? undefined
                : chosen;
            }
            for (let position = from; position < others.length; position += 1) {
              const found = combinations(position + 1, [...chosen, others[position]]);
              if (found !== undefined) return found;
            }
            return undefined;
          };
          forcing = combinations(0, []);
        }
        const reason = `${constraint.dimension} forced by [${(forcing ?? []).map((other) => other.dimension).join(', ')}]`;
        impossible.set(reason, (impossible.get(reason) ?? 0) + 1);
        outcomes.push(`-${constraint.dimension}:impossible(${reason})`);
      }
      report.push(`${label}\n    ${outcomes.join('\n    ')}`);
    }
    console.log([
      `built-in declaration witnesses: ${declarations.length} declarations, ${declarations.length - missingPositive.length} positive,`,
      `${negatives} negative (${equivalentActive} equivalent-active), ${[...impossible.values()].reduce((sum, count) => sum + count, 0)} impossible, ${gaps.length} gaps`,
      ...[...impossible].sort().map(([reason, count]) => `  impossible ${count}x ${reason}`),
      ...report
    ].join('\n'));
    expect(missingPositive).toEqual([]);
    expect(gaps).toEqual([]);
    expect(sorted(impossible.keys())).toEqual(sorted([
      'cloud forced by []',
      'owner:cloud forced by []',
      'owner:stack forced by [variant]',
      'owner:stack forced by [workload]',
      'workload forced by [stack]',
      'workload forced by [variant]'
    ]));
  });
});
