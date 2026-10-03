import type {
  ArtifactLifecycle,
  GeneratedArtifact,
  ProjectProvisioningGroup
} from '../domain/project/contracts.js';
import type { SupportedHostPlatform } from '../domain/project/supported-stack.js';

/*
 * Contracts for release-owned, first-party bundled plugins. Descriptors are static data compiled
 * into the CLI: they identify contributions, but never grant approval, write scope, network access
 * or execution authority. Bundled plugins are trusted first-party code; the registry is not a
 * security sandbox, and inputs are release-owned data rather than hostile objects.
 */

export const pluginApiVersion = 1 as const;
export type PluginApiVersion = typeof pluginApiVersion;
export const supportedPluginApiVersions: readonly number[] = Object.freeze([pluginApiVersion]);

/** Canonical category order, also used for deterministic ordering of owners. */
export const pluginCategories = Object.freeze(['stack', 'cloud', 'workflow', 'agent'] as const);
export type PluginCategory = (typeof pluginCategories)[number];

export const frontendSelections = Object.freeze(['included', 'omitted'] as const);
export type FrontendSelection = (typeof frontendSelections)[number];

/** Descriptive upper bounds only; operations keep approval, verification and recovery authority. */
export const pluginEffectClasses = Object.freeze([
  'project-read',
  'local-tool',
  'project-code',
  'network'
] as const);
export type PluginEffectClass = (typeof pluginEffectClasses)[number];

export type Sha256Digest = `sha256:${string}`;

export interface PluginRef {
  readonly category: PluginCategory;
  readonly id: string;
}

export type ContributionOwner =
  | { readonly kind: 'core' }
  | { readonly kind: 'plugin'; readonly category: PluginCategory; readonly id: string };

/** Scalar dimensions: the selected value must be listed. An omitted dimension means any value. */
export interface PluginSupportCondition {
  readonly workload?: readonly string[];
  readonly variant?: readonly string[];
  readonly stack?: readonly string[];
  readonly cloud?: readonly string[];
  readonly workflow?: readonly string[];
  readonly frontend?: readonly FrontendSelection[];
  readonly governanceProfile?: readonly string[];
}

/** Set dimensions use positive membership only: the selection must include any listed value. */
export interface PluginCondition extends PluginSupportCondition {
  readonly agent?: readonly string[];
  readonly environment?: readonly string[];
}

export interface ArtifactIdentity {
  readonly logicalName: string;
  readonly category: string;
  readonly pathParts: readonly string[];
  readonly lifecycle: ArtifactLifecycle;
  readonly provisioningGroup?: ProjectProvisioningGroup;
}

export interface ArtifactDeclaration extends ArtifactIdentity {
  readonly when?: PluginCondition;
}

/** Package-root-relative location of one explicit asset identity. */
export interface AssetDeclaration {
  readonly id: string;
  readonly pathParts: readonly string[];
}

export interface CheckDeclaration {
  readonly id: string;
  readonly version: number;
  readonly operation: string;
  readonly effects: readonly PluginEffectClass[];
  readonly when?: PluginCondition;
}

/** Must exactly match a core-owned operation recipe identity. */
export interface RecipeReference {
  readonly operation: string;
  readonly id: string;
  readonly version: number;
  readonly when?: PluginCondition;
}

export interface PluginDescriptor extends PluginRef {
  readonly apiVersion: number;
  readonly contentVersion: number;
  readonly hostPlatforms: readonly SupportedHostPlatform[];
  /** Non-empty disjunction of scalar-only support alternatives. */
  readonly supports: readonly PluginSupportCondition[];
  readonly artifacts: readonly ArtifactDeclaration[];
  /** Plugin-owned asset identities. */
  readonly assets: readonly AssetDeclaration[];
  /** Explicit references to core-owned shared asset identities. */
  readonly sharedAssets: readonly string[];
  readonly checks: readonly CheckDeclaration[];
  readonly recipes: readonly RecipeReference[];
}

export interface ManagedCoreIdentity {
  readonly logicalName: string;
  readonly pathParts: readonly string[];
}

export interface CoreDeclarations {
  readonly artifacts: readonly ArtifactDeclaration[];
  readonly sharedAssets: readonly AssetDeclaration[];
  readonly managedCore: readonly ManagedCoreIdentity[];
  readonly retiredLogicalNames: readonly string[];
}

export interface WorkloadSelectionSpace {
  readonly id: string;
  readonly variants: readonly string[];
}

export interface PluginSelectionSpace {
  readonly workloads: readonly WorkloadSelectionSpace[];
  readonly environments: readonly string[];
  readonly governanceProfiles: readonly string[];
}

export interface OperationRecipe {
  readonly id: string;
  readonly version: number;
}

export interface OperationDefinition {
  readonly id: string;
  readonly permittedCheckEffects: readonly PluginEffectClass[];
  readonly recipes: readonly OperationRecipe[];
}

export interface PackagedAssetBytes {
  readonly pathParts: readonly string[];
  readonly bytes: Uint8Array;
}

export interface ReleaseAssetRecord {
  readonly id: string;
  readonly pathParts: readonly string[];
  readonly sha256: Sha256Digest;
}

export interface PluginReleaseRecord extends PluginRef {
  readonly apiVersion: number;
  readonly contentVersion: number;
  readonly contentDigest: Sha256Digest;
  readonly assets: readonly ReleaseAssetRecord[];
}

export interface PluginReleaseInventory {
  readonly schemaVersion: 1;
  readonly sharedAssets: readonly ReleaseAssetRecord[];
  readonly plugins: readonly PluginReleaseRecord[];
}

export interface PluginRegistryLimits {
  readonly maxDescriptors: number;
  readonly maxArtifactsPerOwner: number;
  readonly maxArtifacts: number;
  readonly maxAssetsPerOwner: number;
  readonly maxChecksPerPlugin: number;
  readonly maxRecipesPerPlugin: number;
  readonly maxSupportAlternatives: number;
  readonly maxConditionValues: number;
  readonly maxPathParts: number;
  readonly maxStringLength: number;
  readonly maxIdLength: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxAssetBytes: number;
  readonly maxTotalAssetBytes: number;
  /** Host-expanded candidate selection contexts enumerated for satisfiability. */
  readonly maxSelectionContexts: number;
  readonly maxConflictPairs: number;
  readonly maxSatisfiabilityWork: number;
}

/** Fail-closed safety bounds; exceeding any bound rejects the whole registry. */
export const pluginRegistryLimits: PluginRegistryLimits = Object.freeze({
  maxDescriptors: 64,
  maxArtifactsPerOwner: 4096,
  maxArtifacts: 16384,
  maxAssetsPerOwner: 1024,
  maxChecksPerPlugin: 256,
  maxRecipesPerPlugin: 256,
  maxSupportAlternatives: 64,
  maxConditionValues: 256,
  maxPathParts: 32,
  maxStringLength: 255,
  maxIdLength: 64,
  maxDepth: 16,
  maxNodes: 1_048_576,
  maxAssetBytes: 4 * 1024 * 1024,
  maxTotalAssetBytes: 32 * 1024 * 1024,
  maxSelectionContexts: 65_536,
  maxConflictPairs: 262_144,
  maxSatisfiabilityWork: 20_000_000
});

export interface PluginRegistryInput {
  readonly descriptors: readonly PluginDescriptor[];
  readonly core: CoreDeclarations;
  readonly selectionSpace: PluginSelectionSpace;
  readonly operations: readonly OperationDefinition[];
  readonly release: PluginReleaseInventory;
  readonly assets: readonly PackagedAssetBytes[];
  /** May only lower the default bounds; a higher value is rejected. */
  readonly limits?: Partial<PluginRegistryLimits>;
}

export interface PluginSelection {
  readonly workload: string;
  readonly variant?: string;
  readonly stack: string;
  readonly cloud: string;
  readonly workflow: string;
  readonly agents: readonly string[];
  readonly frontend: FrontendSelection;
  readonly governanceProfile: string;
  readonly environments: readonly string[];
}

export interface PluginHost {
  readonly platform: string;
}

export interface AssetDigest {
  readonly id: string;
  readonly sha256: Sha256Digest;
}

export interface PluginInventoryEntry extends PluginRef {
  readonly apiVersion: number;
  readonly contentVersion: number;
  readonly contentDigest: Sha256Digest;
  readonly hostPlatforms: readonly SupportedHostPlatform[];
  readonly supports: readonly PluginSupportCondition[];
  readonly artifacts: readonly ArtifactDeclaration[];
  readonly assets: readonly AssetDigest[];
  readonly sharedAssets: readonly AssetDigest[];
  readonly checks: readonly CheckDeclaration[];
  readonly recipes: readonly RecipeReference[];
}

export interface ResolvedPlugin extends PluginRef {
  readonly apiVersion: number;
  readonly contentVersion: number;
  readonly contentDigest: Sha256Digest;
}

export interface ResolvedArtifact extends ArtifactIdentity {
  readonly owner: ContributionOwner;
}

export interface ResolvedCheck {
  readonly owner: PluginRef;
  readonly id: string;
  readonly version: number;
  readonly operation: string;
  readonly effects: readonly PluginEffectClass[];
}

export interface ResolvedRecipe {
  readonly owner: PluginRef;
  readonly operation: string;
  readonly id: string;
  readonly version: number;
}

export interface PluginResolution {
  /** Normalized copy: sorted agents/environments and a variant only for variant workloads. */
  readonly selection: PluginSelection;
  /** Validated support context; excluded from the resolution digest. */
  readonly hostPlatform: SupportedHostPlatform;
  readonly plugins: readonly ResolvedPlugin[];
  readonly artifacts: readonly ResolvedArtifact[];
  readonly checks: readonly ResolvedCheck[];
  readonly recipes: readonly ResolvedRecipe[];
  readonly sharedAssets: readonly AssetDigest[];
  /** Operation definitions referenced by resolved checks and recipes. */
  readonly operations: readonly OperationDefinition[];
  /** Identity/integrity metadata for the resolved semantics; never approval authority. */
  readonly digest: Sha256Digest;
}

export interface PluginAssetTexts {
  readonly own: Readonly<Record<string, string>>;
  readonly shared: Readonly<Record<string, string>>;
}

export interface PluginRegistry {
  readonly apiVersion: PluginApiVersion;
  readonly inventory: readonly PluginInventoryEntry[];
  readonly pluginSetDigest: Sha256Digest;
  readonly coreContributionDigest: Sha256Digest;
  readonly registryDigest: Sha256Digest;
  resolveSelection(selection: PluginSelection, host: PluginHost): PluginResolution;
  assetsFor(owner: ContributionOwner): PluginAssetTexts;
  verifyComposedArtifacts(resolution: PluginResolution, artifacts: readonly GeneratedArtifact[]): void;
}

export const pluginIssueCodes = Object.freeze([
  'invalid-registry-input',
  'invalid-descriptor',
  'validation-limit-exceeded',
  'invalid-plugin-id',
  'duplicate-plugin-id',
  'unknown-category',
  'incompatible-api-version',
  'invalid-content-version',
  'unsupported-host-platform',
  'invalid-condition',
  'unsatisfiable-condition',
  'missing-category',
  'no-supported-selection',
  'invalid-artifact',
  'duplicate-logical-name',
  'path-alias-collision',
  'path-prefix-collision',
  'unregistered-managed-core',
  'retired-logical-name',
  'invalid-asset',
  'duplicate-asset-id',
  'asset-location-conflict',
  'unknown-shared-asset',
  'missing-asset',
  'undeclared-asset',
  'invalid-asset-encoding',
  'missing-release-record',
  'unexpected-release-record',
  'release-record-mismatch',
  'digest-mismatch',
  'invalid-check',
  'invalid-recipe',
  'unknown-operation',
  'unpermitted-effect',
  'unknown-recipe',
  'invalid-selection',
  'unknown-plugin',
  'wrong-category',
  'unsupported-combination',
  'resolution-mismatch',
  'undeclared-artifact',
  'artifact-identity-mismatch',
  'missing-artifact',
  'duplicate-artifact'
] as const);
export type PluginIssueCode = (typeof pluginIssueCodes)[number];

export type PluginRegistryStage = 'registry' | 'selection' | 'composition';

export interface PluginIssue {
  readonly code: PluginIssueCode;
  readonly subject: string;
  readonly detail: string;
}

export class PluginRegistryError extends Error {
  readonly stage: PluginRegistryStage;
  readonly issues: readonly PluginIssue[];

  constructor(stage: PluginRegistryStage, issues: readonly PluginIssue[]) {
    const frozen = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
    super([
      `Bundled plugin ${stage} validation failed:`,
      ...frozen.map((issue) => `- ${issue.code} ${issue.subject}: ${issue.detail}`)
    ].join('\n'));
    this.name = 'PluginRegistryError';
    this.stage = stage;
    this.issues = frozen;
  }
}
