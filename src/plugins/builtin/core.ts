import {
  pluginApiVersion,
  type ArtifactDeclaration,
  type AssetDeclaration,
  type ContributionOwner,
  type CoreDeclarations,
  type OperationDefinition,
  type PluginCategory,
  type PluginCondition,
  type PluginDescriptor,
  type PluginSelectionSpace,
  type PluginSupportCondition
} from '../contracts.js';
import type { ArtifactLifecycle, CodingAgentId, ProjectProvisioningGroup } from '../../domain/project/contracts.js';
import { governanceAgentIntegrations, governanceArtifactPaths } from '../../domain/project/catalog.js';
import { managedCoreArtifactPaths, retiredManagedCoreIdentities } from '../../domain/project/artifact-lifecycle.js';
import { retiredFlatRootInfrastructureIdentities } from '../../domain/project/infrastructure-layout.js';
import { supportedHostPlatforms, type SupportedHostPlatform } from '../../domain/project/supported-stack.js';
import { builtinAssets } from './assets.js';

/*
 * Release-owned core declarations and the selection space shared by the first-party built-in
 * plugins. Everything here is static data derived from finite constant tables; nothing reads files,
 * environment or host state, and nothing grants ownership or approval.
 */

export const builtinPatternIds = Object.freeze([
  'generic', 'rag', 'chatbot', 'agent', 'prompt', 'multi-agent', 'fine-tuned', 'streaming', 'workflow'
] as const);
/** Patterns whose starter renders a worker, and on Azure an Azure Functions worker. */
export const builtinWorkerPatternIds = Object.freeze(['rag', 'agent', 'multi-agent', 'workflow'] as const);
export const builtinStackIds = Object.freeze(['python-fastapi', 'node-fastify', 'go-huma'] as const);
export const builtinEnvironmentIds = Object.freeze(['dev', 'staging', 'prod'] as const);
export const enabledGovernanceProfileId = 'single-maintainer-gitflow';
export const builtinGovernanceProfileIds = Object.freeze([enabledGovernanceProfileId, 'none'] as const);
export const builtinApiVersion = pluginApiVersion;

/** Every built-in lists every qualified host tag; this is data coverage, not native qualification. */
export function builtinHostPlatforms(): SupportedHostPlatform[] {
  return [...supportedHostPlatforms];
}

/**
 * Deeply freezes freshly built declaration data in place, including nested values of already frozen
 * containers. Tables owned by other modules are always copied before they reach this helper.
 */
export function deepFrozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) deepFrozen(entry);
    Object.freeze(value);
  }
  return value;
}

function cloneCondition<T extends PluginSupportCondition | PluginCondition>(condition: T): T {
  return Object.fromEntries(Object.entries(condition).map(([dimension, values]) =>
    [dimension, [...values as readonly string[]]])) as unknown as T;
}

function withCondition(declaration: ArtifactDeclaration, when: PluginCondition | undefined): ArtifactDeclaration {
  return when === undefined ? declaration : { ...declaration, when: cloneCondition(when) };
}

export function projectArtifact(
  logicalName: string,
  category: string,
  pathParts: readonly string[],
  when?: PluginCondition,
  provisioningGroup: ProjectProvisioningGroup = 'base'
): ArtifactDeclaration {
  return withCondition({ logicalName, category, pathParts: [...pathParts], lifecycle: 'project', provisioningGroup }, when);
}

export function lifecycleArtifact(
  logicalName: string,
  category: string,
  pathParts: readonly string[],
  lifecycle: Exclude<ArtifactLifecycle, 'project'>,
  when?: PluginCondition
): ArtifactDeclaration {
  return withCondition({ logicalName, category, pathParts: [...pathParts], lifecycle }, when);
}

function sameOwner(left: ContributionOwner, right: ContributionOwner): boolean {
  return left.kind === 'core'
    ? right.kind === 'core'
    : right.kind === 'plugin' && left.category === right.category && left.id === right.id;
}

/** The explicit asset identities that C1 assigns to one owner, in registry declaration form. */
export function assetsOwnedBy(owner: ContributionOwner): AssetDeclaration[] {
  return builtinAssets
    .filter((asset) => sameOwner(asset.owner, owner))
    .map((asset) => ({ id: asset.id, pathParts: [...asset.pathParts] }));
}

export const governanceEnabled: PluginCondition = deepFrozen({ governanceProfile: [enabledGovernanceProfileId] });

export interface BuiltinDescriptorInput {
  readonly category: PluginCategory;
  readonly id: string;
  /**
   * Advances for reviewed changes to this plugin's rendered behavior as well as its declarations or
   * assets, because content digests cover declarations and asset bytes but not renderer code.
   */
  readonly contentVersion: number;
  readonly supports: readonly PluginSupportCondition[];
  readonly artifacts: readonly ArtifactDeclaration[];
}

/** A first-party descriptor: every qualified host, the C1 assets it owns, and no checks or recipes. */
export function builtinDescriptor(input: BuiltinDescriptorInput): PluginDescriptor {
  return deepFrozen({
    category: input.category,
    id: input.id,
    apiVersion: builtinApiVersion,
    contentVersion: input.contentVersion,
    hostPlatforms: builtinHostPlatforms(),
    supports: input.supports.map(cloneCondition),
    artifacts: [...input.artifacts],
    assets: assetsOwnedBy({ kind: 'plugin', category: input.category, id: input.id }),
    sharedAssets: [],
    checks: [],
    recipes: []
  });
}

/** Setup and assessment integrations exist only with governance enabled; repair always exists. */
export function governanceAgentDescriptor(id: CodingAgentId, contentVersion: number): PluginDescriptor {
  const integration = governanceAgentIntegrations[id];
  return builtinDescriptor({
    category: 'agent',
    id,
    contentVersion,
    supports: [{}],
    artifacts: [
      lifecycleArtifact(integration.setup.logicalName, 'governance', integration.setup.pathParts, 'managed-core', governanceEnabled),
      lifecycleArtifact(integration.assessment.logicalName, 'governance', integration.assessment.pathParts, 'managed-core', governanceEnabled),
      lifecycleArtifact(integration.repair.logicalName, 'governance', integration.repair.pathParts, 'managed-core')
    ]
  });
}

const baseArtifacts: ArtifactDeclaration[] = [
  projectArtifact('root-readme', 'documentation', ['README.md']),
  projectArtifact('root-gitignore', 'project', ['.gitignore']),
  projectArtifact('root-dockerignore', 'runtime', ['.dockerignore']),
  projectArtifact('env-example', 'configuration', ['.env.example']),
  projectArtifact('backend-dockerfile', 'runtime', ['Dockerfile']),
  projectArtifact('docker-compose', 'local-development', ['docker-compose.yml']),
  lifecycleArtifact('liftoff-config', 'project', ['liftoff.config.json'], 'desired-state'),
  lifecycleArtifact('manifest', 'manifest', ['liftoff.manifest.json'], 'manifest')
];

const environmentArtifacts: ArtifactDeclaration[] = builtinEnvironmentIds.flatMap((environment) => [
  projectArtifact(`environment-${environment}-backend`, 'environment', ['environments', environment, 'backend.env'],
    { environment: [environment] }, `environment:${environment}`),
  projectArtifact(`environment-${environment}-functions`, 'environment', ['environments', environment, 'functions.env'],
    { workload: ['genai'], variant: [...builtinWorkerPatternIds], cloud: ['azure'], environment: [environment] },
    `environment:${environment}`)
]);

const frontendArtifacts: ArtifactDeclaration[] = ([
  ['frontend-package', ['package.json']],
  ['frontend-lock', ['package-lock.json']],
  ['frontend-index', ['index.html']],
  ['frontend-main', ['src', 'main.ts']],
  ['frontend-app', ['src', 'App.vue']],
  ['frontend-env-example', ['.env.example']],
  ['frontend-styles', ['src', 'styles.css']],
  ['frontend-vite-config', ['vite.config.ts']],
  ['frontend-tailwind-config', ['tailwind.config.ts']],
  ['frontend-dockerfile', ['Dockerfile']],
  ['frontend-dockerignore', ['.dockerignore']]
] as const).map(([logicalName, parts]) =>
  projectArtifact(logicalName, 'frontend', ['frontend', ...parts], { frontend: ['included'] }, 'frontend'));

const governanceArtifacts: ArtifactDeclaration[] = ([
  ['repository-governance-policy', governanceArtifactPaths.policy],
  ['repository-governance-context', governanceArtifactPaths.context],
  ['repository-governance-guide', governanceArtifactPaths.guide],
  ['repository-governance-phase-graph', governanceArtifactPaths.phaseGraph],
  ['repository-governance-compatibility', governanceArtifactPaths.compatibility],
  ['repository-governance-credential-policy-schema', governanceArtifactPaths.credentialPolicySchema]
] as const).map(([logicalName, pathParts]) =>
  lifecycleArtifact(logicalName, 'governance', pathParts, 'managed-core', governanceEnabled));

export const builtinCore: CoreDeclarations = deepFrozen({
  artifacts: [...baseArtifacts, ...environmentArtifacts, ...frontendArtifacts, ...governanceArtifacts],
  sharedAssets: assetsOwnedBy({ kind: 'core' }),
  managedCore: [...managedCoreArtifactPaths].map(([logicalName, pathParts]) => ({ logicalName, pathParts: [...pathParts] })),
  retiredLogicalNames: [
    ...retiredManagedCoreIdentities.map((identity) => identity.logicalName),
    ...retiredFlatRootInfrastructureIdentities.map((identity) => identity.logicalName)
  ]
});

export const builtinSelectionSpace: PluginSelectionSpace = deepFrozen({
  workloads: [
    { id: 'genai', variants: [...builtinPatternIds] },
    { id: 'standard', variants: [] }
  ],
  environments: [...builtinEnvironmentIds],
  governanceProfiles: [...builtinGovernanceProfileIds]
});

/** Built-ins declare no checks or recipes, so no core operation is offered to them. */
export const builtinOperations: readonly OperationDefinition[] = deepFrozen([]);
