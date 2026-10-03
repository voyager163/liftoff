import {
  readDeclaredAssetBytes,
  templateAssetContextFromTexts,
  type DeclaredPackagedAsset,
  type PackagedAssetReadBounds
} from '../../adapters/packaged-assets/plugin-assets.js';
import type { PackagedTemplateAssetContext } from '../../adapters/packaged-assets/template-assets.js';
import {
  artifactPathTokenIssues,
  concreteArtifactPathIssues,
  containsArtifactPathToken,
  isArtifactPathToken,
  materializeArtifactPathParts,
  type ArtifactPathIssue,
  type ArtifactPathTokenValues
} from '../../domain/project/artifact-path-tokens.js';
import type { GeneratedArtifact, ProjectPlan } from '../../domain/project/contracts.js';
import { supportedHostPlatforms } from '../../domain/project/supported-stack.js';
import { builtinAssets } from '../../plugins/builtin/assets.js';
import { builtinRegistryInput } from '../../plugins/builtin/index.js';
import {
  pluginRegistryLimits,
  type ArtifactIdentity,
  type ContributionOwner,
  type PackagedAssetBytes,
  type PluginRegistry,
  type PluginRegistryLimits,
  type PluginResolution,
  type PluginSelection
} from '../../plugins/contracts.js';
import { createPluginRegistry } from '../../plugins/registry.js';
import { modernSourceRegistry } from './modern-plugins.js';

/*
 * Composition root for the bundled first-party plugins. It builds the registry once, on first
 * generation, from the built-in descriptors, the C1 asset table, bounded reads and the literal
 * release record; resolves a plan's selection host-neutrally; materializes and validates concrete
 * identities before any renderer runs; and verifies rendered identities before they are returned.
 * Registry and reader errors propagate unchanged. Nothing here reads host platform state, and no
 * resolution grants approval, write scope or execution authority.
 */

export type PluginCompositionStage = 'pre-render' | 'post-render';

export interface PluginCompositionIssue {
  readonly code: string;
  readonly subject: string;
  readonly detail: string;
}

export class PluginCompositionError extends Error {
  readonly stage: PluginCompositionStage;
  readonly issues: readonly PluginCompositionIssue[];

  constructor(stage: PluginCompositionStage, issues: readonly PluginCompositionIssue[]) {
    const frozen = Object.freeze(issues.map((issue) => Object.freeze({ code: issue.code, subject: issue.subject, detail: issue.detail })));
    super([
      `Bundled plugin composition failed ${stage === 'pre-render' ? 'before rendering' : 'after rendering'}:`,
      ...frozen.map((issue) => `- ${issue.code} ${issue.subject}: ${issue.detail}`)
    ].join('\n'));
    this.name = 'PluginCompositionError';
    this.stage = stage;
    this.issues = frozen;
  }
}

/** Reads the declared built-in assets within the given bounds. */
export type BuiltinAssetReader = (
  declarations: readonly DeclaredPackagedAsset[],
  bounds: PackagedAssetReadBounds
) => readonly PackagedAssetBytes[];

const readInstalledAssets: BuiltinAssetReader = (declarations, bounds) => readDeclaredAssetBytes(declarations, bounds);

const limitNames: readonly string[] = Object.keys(pluginRegistryLimits);

const invalidLimit = (subject: string, detail: string): PluginCompositionIssue =>
  ({ code: 'invalid-registry-limit', subject, detail });

/**
 * Validates limit overrides before any packaged read: a plain object whose own enumerable data
 * properties name known registry limits, each a positive safe integer no greater than its default.
 * Nothing is clamped, coerced or defaulted; the registry validates the same values again.
 */
function validatedLimitOverrides(limits: unknown): Partial<PluginRegistryLimits> | undefined {
  if (limits === undefined) return undefined;
  const prototype: unknown = typeof limits === 'object' && limits !== null ? Object.getPrototypeOf(limits) : undefined;
  if (typeof limits !== 'object' || limits === null || (prototype !== Object.prototype && prototype !== null)) {
    throw new PluginCompositionError('pre-render', [invalidLimit('limits', 'limit overrides must be a plain object of known registry limits')]);
  }
  const issues: PluginCompositionIssue[] = [];
  const overrides: Partial<Record<keyof PluginRegistryLimits, number>> = {};
  const keys = Reflect.ownKeys(limits);
  if (keys.some((key) => typeof key !== 'string')) {
    issues.push(invalidLimit('limits', 'symbol-keyed limit overrides are not accepted'));
  }
  for (const key of keys.filter((entry): entry is string => typeof entry === 'string').sort()) {
    const subject = `limits.${key}`;
    if (!limitNames.includes(key)) {
      issues.push(invalidLimit(subject, 'is not a bundled plugin registry limit'));
      continue;
    }
    const name = key as keyof PluginRegistryLimits;
    const ceiling = pluginRegistryLimits[name];
    // Reading the descriptor never invokes an accessor; an accessor is not a data property.
    const descriptor = Object.getOwnPropertyDescriptor(limits, key) as PropertyDescriptor;
    const value: unknown = descriptor.value;
    if (!('value' in descriptor) || descriptor.enumerable !== true || typeof value !== 'number' ||
        !Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
      issues.push(invalidLimit(subject, `must be an enumerable data property holding a positive safe integer no greater than the default ${ceiling}`));
      continue;
    }
    overrides[name] = value;
  }
  if (issues.length > 0) throw new PluginCompositionError('pre-render', issues);
  return overrides;
}

/**
 * Builds a fresh built-in registry. Limit overrides may only lower the registry defaults; malformed
 * or raised overrides are refused before the reader is invoked, never clamped.
 */
export function createBuiltinPluginRegistry(
  read: BuiltinAssetReader = readInstalledAssets,
  limits?: Partial<PluginRegistryLimits>
): PluginRegistry {
  const overrides = validatedLimitOverrides(limits);
  const effective: PluginRegistryLimits = { ...pluginRegistryLimits, ...overrides };
  const bytes = read(builtinAssets, {
    maxAssetBytes: effective.maxAssetBytes,
    maxTotalAssetBytes: effective.maxTotalAssetBytes,
    maxPathParts: effective.maxPathParts,
    maxPartLength: effective.maxStringLength
  });
  return createPluginRegistry(builtinRegistryInput(bytes, overrides));
}

let registry: PluginRegistry | undefined;
let templateAssets: PackagedTemplateAssetContext | undefined;

/** The one lazily built registry of the installed built-ins; a failed build is retried, never cached. */
export function builtinPluginRegistry(): PluginRegistry {
  registry ??= createBuiltinPluginRegistry();
  return registry;
}

/** Template asset texts from a registry, which verified their bytes against the release record. */
export function templateAssetsFromRegistry(source: PluginRegistry): PackagedTemplateAssetContext {
  return templateAssetContextFromTexts((owner: ContributionOwner, id: string) => {
    const text = source.assetsFor(owner).own[id];
    if (typeof text !== 'string') {
      throw new PluginCompositionError('pre-render', [{
        code: 'missing-asset-text',
        subject: `asset:${owner.kind === 'core' ? 'core' : `${owner.category}:${owner.id}`}:${id}`,
        detail: 'the registry holds no verified text for this template asset identity'
      }]);
    }
    return text;
  });
}

/** The generator's template asset context, built once from the lazily verified built-in registry. */
export function builtinTemplateAssets(): PackagedTemplateAssetContext {
  templateAssets ??= templateAssetsFromRegistry(builtinPluginRegistry());
  return templateAssets;
}

export function pluginSelectionForPlan(plan: ProjectPlan): PluginSelection {
  if (plan.framework.id !== plan.specWorkflow.id) {
    throw new PluginCompositionError('pre-render', [{
      code: 'workflow-framework-mismatch',
      subject: 'selection',
      detail: `the ${plan.specWorkflow.id} workflow does not match the ${plan.framework.id} framework adapter`
    }]);
  }
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const semanticKey = (resolution: PluginResolution): string => {
  const { hostPlatform: _host, ...semantic } = resolution;
  return stableJson(semantic);
};

/**
 * Generation output is host-neutral: the selection must resolve identically on every qualified host
 * platform. The first sorted host's resolution is only an internal verification witness; it is not
 * the running machine's platform, and nothing reports or persists it.
 */
function resolveHostNeutral(source: PluginRegistry, selection: PluginSelection): PluginResolution {
  const resolutions = [...supportedHostPlatforms].sort()
    .map((platform) => source.resolveSelection(selection, { platform }));
  const [witness, ...others] = resolutions;
  const key = semanticKey(witness);
  if (others.some((other) => other.digest !== witness.digest || semanticKey(other) !== key)) {
    throw new PluginCompositionError('pre-render', [{
      code: 'host-dependent-resolution',
      subject: 'selection',
      detail: 'the selection resolves differently across qualified host platforms'
    }]);
  }
  return witness;
}

/** A concrete identity, materialized for one plan, that the renderers must emit exactly once. */
export interface ExpectedArtifact extends ArtifactIdentity {
  readonly owner: ContributionOwner;
}

export interface ProjectPluginComposition {
  readonly resolution: PluginResolution;
  readonly expected: readonly ExpectedArtifact[];
  /** Verifies the rendered artifacts before they may be returned or written; never mutates them. */
  verify(artifacts: readonly GeneratedArtifact[]): void;
}

const identityKey = (logicalName: string, pathParts: readonly string[]): string =>
  JSON.stringify([logicalName, pathParts]);

const asCompositionIssues = (issues: readonly ArtifactPathIssue[]): PluginCompositionIssue[] =>
  issues.map(({ code, subject, detail }) => ({ code, subject, detail }));

export function composeProjectPlugins(
  plan: ProjectPlan,
  source: PluginRegistry = builtinPluginRegistry()
): ProjectPluginComposition {
  const resolution = resolveComposition(source, pluginSelectionForPlan(plan));
  const values = { safeProjectName: plan.safeProjectName };
  return materializeComposition(source, resolution, values);
}

export function composeManifestPlugins(
  selection: PluginSelection,
  values: ArtifactPathTokenValues
): ProjectPluginComposition {
  const source = builtinPluginRegistry();
  const resolution = resolveComposition(source, selection);
  return materializeComposition(source, resolution, values);
}

export function composeModernManifestPlugins(
  selection: PluginSelection,
  values: ArtifactPathTokenValues
): ProjectPluginComposition {
  const source = modernSourceRegistry();
  const resolution = resolveComposition(source, selection);
  return materializeComposition(source, resolution, values);
}

function resolveComposition(source: PluginRegistry, selection: PluginSelection): PluginResolution {
  const resolution = resolveHostNeutral(source, selection);
  const tokenIssues = artifactPathTokenIssues(resolution.artifacts);
  if (tokenIssues.length > 0) throw new PluginCompositionError('pre-render', asCompositionIssues(tokenIssues));
  return resolution;
}

function materializeComposition(
  source: PluginRegistry,
  resolution: PluginResolution,
  values: ArtifactPathTokenValues
): ProjectPluginComposition {
  const declaredPaths = new Map<string, readonly string[]>();
  const expected = resolution.artifacts.map((artifact): ExpectedArtifact => {
    const pathParts = materializeArtifactPathParts(artifact.pathParts, values);
    if (artifact.pathParts.some(isArtifactPathToken)) {
      declaredPaths.set(identityKey(artifact.logicalName, pathParts), artifact.pathParts);
    }
    return Object.freeze({
      owner: artifact.owner,
      logicalName: artifact.logicalName,
      category: artifact.category,
      pathParts: Object.freeze(pathParts),
      lifecycle: artifact.lifecycle,
      ...(artifact.provisioningGroup === undefined ? {} : { provisioningGroup: artifact.provisioningGroup })
    });
  });
  const concreteIssues = concreteArtifactPathIssues(expected);
  if (concreteIssues.length > 0) throw new PluginCompositionError('pre-render', asCompositionIssues(concreteIssues));

  const verify = (artifacts: readonly GeneratedArtifact[]): void => {
    const leaks = artifacts.filter((artifact) => Array.isArray(artifact.pathParts) &&
      artifact.pathParts.some((part) => typeof part === 'string' && containsArtifactPathToken(part)))
      .map((artifact): PluginCompositionIssue => ({
        code: 'token-leak',
        subject: `artifact:${artifact.logicalName}`,
        detail: `${artifact.pathParts.join('/')} contains a reserved path token that was never materialized`
      }));
    if (leaks.length > 0) throw new PluginCompositionError('post-render', leaks);
    // The registry stays authoritative: it receives the declared (token) form of exactly the
    // materialized identities and reports undeclared, missing, duplicate or mismatched artifacts.
    const declaredForm = artifacts.map((artifact) => {
      const declared = Array.isArray(artifact.pathParts)
        ? declaredPaths.get(identityKey(artifact.logicalName, artifact.pathParts))
        : undefined;
      return declared === undefined ? artifact : { ...artifact, pathParts: [...declared] };
    });
    source.verifyComposedArtifacts(resolution, declaredForm);
  };
  return Object.freeze({ resolution, expected: Object.freeze(expected), verify });
}
