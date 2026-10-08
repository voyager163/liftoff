import { createHash } from 'node:crypto';
import path from 'node:path';
import { readBoundProjectFileSnapshot } from '../../adapters/filesystem/bound-project-files.js';
import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type {
  ManifestActiveLayout, ManifestLayoutBinding, ManifestLayoutComponentId
} from '../../domain/project/contracts.js';
import {
  manifestActiveLayoutDigest, validateManifestActiveLayout
} from '../../domain/project/manifest/layout.js';
import {
  resolveModernProjectSourceContext, type ModernProjectSourceInput
} from '../project/source-context.js';
import {
  assertApplicationNoLinkAncestors, canonicalApplicationRoot
} from '../repair/application-files.js';
import { currentBoundApplicationTargets } from '../repair/application-inventory.js';
import { applicationBounds } from '../repair/application-types.js';

export const adoptionLayoutPlanSchemaVersion = 1 as const;

export interface AdoptionLayoutBindingObservation {
  readonly logicalName: string;
  readonly pathParts: readonly string[];
  readonly component: ManifestLayoutComponentId | null;
  readonly status:
    | 'observed-preserved'
    | 'unobserved-omitted'
    | 'planning-only-excluded';
  readonly observedDigest: string | null;
  readonly observedMode: number | null;
  readonly observedBytes: number | null;
}

export interface AdoptionLayoutPlanReport {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-adoption-layout-plan';
  readonly readOnly: true;
  readonly projectRoot: string;
  readonly sourceDigest: string;
  readonly plannedSourceDigest: string | null;
  readonly pluginResolutionDigest: string;
  readonly status: 'blocked' | 'ready-for-candidate-inspection';
  readonly activeLayout: ManifestActiveLayout | null;
  readonly activeLayoutDigest: `sha256:${string}` | null;
  readonly bindings: readonly AdoptionLayoutBindingObservation[];
  readonly blockers: readonly {
    readonly code: 'supported-application-binding-unobserved';
  }[];
  readonly compatibility: 'not-verified';
  readonly deployment: 'planning-only';
  readonly gitHistory: 'not-read-or-modified';
  readonly limitations: readonly string[];
  readonly fingerprint: string;
}

/** Planned source metadata and captured bytes remain private comparison inputs. */
export interface AdoptionLayoutPlan {
  readonly report: AdoptionLayoutPlanReport;
  readonly source: ModernProjectSourceInput | null;
  readonly snapshots: readonly ProjectFileSnapshot[];
}

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function cloneSnapshot(snapshot: ProjectFileSnapshot): ProjectFileSnapshot {
  return {
    pathParts: [...snapshot.pathParts],
    ...(snapshot.content === undefined ? {} : { content: Buffer.from(snapshot.content) }),
    ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode })
  };
}

export async function prepareAdoptionLayoutPlan(
  root: string,
  sourceValue: unknown
): Promise<AdoptionLayoutPlan> {
  const context = resolveModernProjectSourceContext(sourceValue);
  const source: ModernProjectSourceInput = {
    selection: context.selection,
    plugins: context.plugins,
    activeLayout: context.activeLayout
  };
  const current = currentBoundApplicationTargets(source);
  const targets = new Map(current.target.artifacts.map(artifact => [artifact.logicalName, artifact]));
  const artifactDescriptors = new Map(
    context.source.layoutDescriptor.artifacts.map(artifact => [artifact.logicalName, artifact])
  );
  const artifactBindings: Extract<ManifestLayoutBinding, { kind: 'artifact' }>[] = [];
  for (const binding of context.activeLayout.bindings) {
    if (binding.kind === 'artifact') artifactBindings.push(binding);
  }
  const eligibleBindings = artifactBindings.filter(binding => targets.has(binding.logicalName));
  await assertApplicationNoLinkAncestors(path.resolve(root), 'Project inventory root');
  const projectRoot = await canonicalApplicationRoot(root);
  const snapshots = await Promise.all(eligibleBindings.map(binding =>
    readBoundProjectFileSnapshot(projectRoot, binding.pathParts, {
      maximumBytes: applicationBounds.fileBytes,
      linkPolicy: 'single-link',
      diagnostics: {
        pathLabel: `Adoption compatible binding ${binding.logicalName}`,
        invalid(detail): never {
          throw new Error(`Unsafe adoption binding ${binding.pathParts.join('/')}: ${detail}`);
        }
      }
    })));
  const snapshotsByName = new Map(
    eligibleBindings.map((binding, index) => [binding.logicalName, snapshots[index]!])
  );
  const bindings: AdoptionLayoutBindingObservation[] = artifactBindings.map(binding => {
    const descriptor = artifactDescriptors.get(binding.logicalName);
    const target = targets.get(binding.logicalName);
    const snapshot = snapshotsByName.get(binding.logicalName);
    if (!target || !snapshot) {
      return {
        logicalName: binding.logicalName,
        pathParts: [...binding.pathParts],
        component: descriptor?.component ?? null,
        status: 'planning-only-excluded' as const,
        observedDigest: null,
        observedMode: null,
        observedBytes: null
      };
    }
    return {
      logicalName: binding.logicalName,
      pathParts: [...binding.pathParts],
      component: descriptor?.component ?? null,
      status: snapshot.content === undefined
        ? 'unobserved-omitted' as const
        : 'observed-preserved' as const,
      observedDigest: snapshot.content === undefined ? null : digest(snapshot.content),
      observedMode: snapshot.mode ?? null,
      observedBytes: snapshot.content?.byteLength ?? null
    };
  });
  const observedNames = new Set(bindings.filter(binding =>
    binding.status === 'observed-preserved').map(binding => binding.logicalName));
  const applicationEvidence = bindings.some(binding =>
    binding.status === 'observed-preserved' && binding.component !== null);
  const blockers: AdoptionLayoutPlanReport['blockers'] = applicationEvidence
    ? []
    : [{ code: 'supported-application-binding-unobserved' }];
  let activeLayout: ManifestActiveLayout | null = null;
  let plannedSource: ModernProjectSourceInput | null = null;
  let activeLayoutDigest: `sha256:${string}` | null = null;
  if (!blockers.length) {
    const selectedComponents = new Set(bindings.flatMap(binding =>
      binding.status === 'observed-preserved' && binding.component !== null
        ? [binding.component]
        : []));
    activeLayout = validateManifestActiveLayout({
      schemaVersion: 1,
      state: 'bound',
      bindings: context.activeLayout.bindings.filter(binding =>
        binding.kind === 'artifact'
          ? observedNames.has(binding.logicalName)
          : selectedComponents.has(binding.component))
    }, context.source.layoutDescriptor);
    plannedSource = {
      selection: context.selection,
      plugins: context.plugins,
      activeLayout
    };
    activeLayoutDigest = manifestActiveLayoutDigest(activeLayout, context.source.layoutDescriptor);
  }
  const body = {
    schemaVersion: adoptionLayoutPlanSchemaVersion,
    kind: 'liftoff-adoption-layout-plan' as const,
    readOnly: true as const,
    projectRoot,
    sourceDigest: canonicalSha256(source),
    plannedSourceDigest: plannedSource === null ? null : canonicalSha256(plannedSource),
    pluginResolutionDigest: context.plugins.resolutionDigest,
    status: blockers.length ? 'blocked' as const : 'ready-for-candidate-inspection' as const,
    activeLayout,
    activeLayoutDigest,
    bindings,
    blockers,
    compatibility: 'not-verified' as const,
    deployment: 'planning-only' as const,
    gitHistory: 'not-read-or-modified' as const,
    limitations: [
      'Observed bindings retain their exact current project-relative paths and remain project-owned; no generation history or compatibility proof is created.',
      'Unobserved application bindings are omitted from the candidate instead of being filled from starter templates.',
      'Infrastructure, state, credentials, framework control and other protected bindings are not inspected here and remain planning-only.',
      'Static file observations do not replace complete file/reference review or independently permissioned behavioral verification.'
    ]
  };
  return privatePlan(
    { ...body, fingerprint: canonicalSha256(body) },
    plannedSource,
    snapshots
  );
}

function privatePlan(
  report: AdoptionLayoutPlanReport,
  source: ModernProjectSourceInput | null,
  snapshots: readonly ProjectFileSnapshot[]
): AdoptionLayoutPlan {
  const frozenReport = structuredClone(report);
  const freeze = <T>(value: T): T => {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  const capturedSource = source === null ? null : structuredClone(source);
  const capturedSnapshots = snapshots.map(cloneSnapshot);
  const result = { report: freeze(frozenReport) } as AdoptionLayoutPlan;
  Object.defineProperties(result, {
    source: {
      enumerable: false,
      get: () => capturedSource === null ? null : structuredClone(capturedSource)
    },
    snapshots: {
      enumerable: false,
      get: () => capturedSnapshots.map(cloneSnapshot)
    }
  });
  return Object.freeze(result);
}
