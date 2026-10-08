import path from 'node:path';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { ApiStackId, ManifestLayoutComponentId } from '../../domain/project/contracts.js';
import { applicationPathKey } from '../repair/application-files.js';
import type { ApplicationReference } from '../repair/application-types.js';
import type { AdoptionDestinationPlanReport } from './destination-plan.js';
import type { AdoptionInventoryReport } from './inventory.js';
import type { AdoptionPreview } from './preview.js';

export const adoptionMappingReviewSchemaVersion = 1 as const;

export type AdoptionMappingSurface =
  | 'source'
  | 'build'
  | 'test'
  | 'container'
  | 'compose'
  | 'ci'
  | 'documentation'
  | 'configuration'
  | 'other';

export type AdoptionReferenceSurface = AdoptionMappingSurface | 'import';

export interface AdoptionMappingFileReview {
  readonly pathParts: readonly string[];
  readonly expectedDigest: string;
  readonly expectedMode: number;
  readonly currentTargetLogicalName: string | null;
  readonly surface: AdoptionMappingSurface;
  readonly decision: 'explicit-review-required';
  readonly suggestedDisposition:
    | 'preserve-current-path'
    | 'mapping-decision-required'
    | 'unsupported-language-conversion'
    | 'unsupported-framework-conversion';
}

export interface AdoptionMappingReferenceReview {
  readonly referenceId: string;
  readonly sourcePathParts: readonly string[];
  readonly targetPathParts: readonly string[];
  readonly kind: ApplicationReference['kind'];
  readonly surface: AdoptionReferenceSurface;
  readonly decision: 'explicit-review-required';
}

export interface AdoptionMappingReviewReport {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-adoption-mapping-review';
  readonly readOnly: true;
  readonly projectRoot: string;
  readonly reviewFingerprint: string;
  readonly destinationPlanFingerprint: string;
  readonly inventoryDigest: string;
  readonly targetLayoutDigest: string;
  readonly status: 'blocked' | 'explicit-review-required';
  readonly files: readonly AdoptionMappingFileReview[];
  readonly references: readonly AdoptionMappingReferenceReview[];
  readonly unresolvedMappings: readonly {
    readonly pathParts: readonly string[];
    readonly reason:
      | 'mapping-decision-required'
      | 'unsupported-language-conversion'
      | 'unsupported-framework-conversion';
  }[];
  readonly observedSurfaces: readonly AdoptionMappingSurface[];
  readonly observedReferenceSurfaces: readonly AdoptionReferenceSurface[];
  readonly dynamicReferencesReviewed: false;
  readonly verificationSelection: 'not-provided';
  readonly compatibility: 'not-verified';
  readonly publication: 'not-authorized';
  readonly limitations: readonly string[];
  readonly fingerprint: string;
}

function fileSurface(pathParts: readonly string[]): AdoptionMappingSurface {
  const key = applicationPathKey(pathParts).toLowerCase();
  const name = path.posix.basename(key);
  if (key.startsWith('.github/workflows/')) return 'ci';
  if (/^(?:dockerfile|containerfile)(?:\.|$)/u.test(name)) return 'container';
  if (/^(?:docker-)?compose(?:\.[^.]+)?\.(?:ya?ml)$/u.test(name)) return 'compose';
  if (key.startsWith('docs/') || /\.(?:md|mdx|rst|adoc|txt)$/u.test(name)) return 'documentation';
  if (/(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|$)/u.test(key) ||
      /\.(?:test|spec)\.[^.]+$/u.test(name)) return 'test';
  if (/^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|uv\.lock|requirements(?:\.[^.]+)?\.txt|go\.(?:mod|sum)|tsconfig(?:\.[^.]+)?\.json|[^/]*config\.[^/]+)$/u.test(name)) {
    return 'build';
  }
  if (/^(?:\.env\.example|runtime\.config\.example\.json|local\.settings\.example\.json)$/u.test(name)) {
    return 'configuration';
  }
  if (/\.(?:[cm]?[jt]sx?|py|go|java|cs|rb|php|rs|swift|kt|kts|scala|sql)$/u.test(name)) {
    return 'source';
  }
  return 'other';
}

function referenceSurface(
  reference: ApplicationReference,
  sourceSurface: AdoptionMappingSurface
): AdoptionReferenceSurface {
  if (reference.kind === 'python-import' ||
      reference.kind === 'relative-literal' && (sourceSurface === 'source' || sourceSurface === 'test')) {
    return 'import';
  }
  return sourceSurface;
}

type LanguageFamily = 'node' | 'python' | 'go';

function targetFamily(stack: ApiStackId): LanguageFamily {
  return stack === 'node-fastify' ? 'node' : stack === 'python-fastapi' ? 'python' : 'go';
}

function sourceFamily(pathParts: readonly string[]): LanguageFamily | null {
  const name = pathParts.at(-1)?.toLowerCase() ?? '';
  if (name === 'go.mod' || name === 'go.sum' || name.endsWith('.go')) return 'go';
  if (name === 'pyproject.toml' || name === 'uv.lock' ||
      /^requirements(?:\.[^.]+)?\.txt$/u.test(name) || name.endsWith('.py')) return 'python';
  if (name === 'package.json' || name === 'package-lock.json' ||
      name === 'pnpm-lock.yaml' || name === 'yarn.lock' ||
      /^tsconfig(?:\.[^.]+)?\.json$/u.test(name) ||
      /\.(?:[cm]?[jt]sx?)$/u.test(name)) return 'node';
  return null;
}

function within(parts: readonly string[], parent: readonly string[]): boolean {
  return parent.length > 0 && parent.length <= parts.length &&
    parent.every((part, index) => part === parts[index]);
}

function applicationRoots(
  inventory: AdoptionInventoryReport
): readonly { component: ManifestLayoutComponentId; pathParts: readonly string[] }[] {
  const roots = new Map<string, { component: ManifestLayoutComponentId; pathParts: readonly string[] }>();
  const descriptors = new Map(inventory.target.artifacts.map(artifact => [
    artifact.logicalName,
    { component: artifact.component, pathParts: artifact.componentRootPathParts }
  ]));
  for (const binding of inventory.adoptionObservations) {
    const target = descriptors.get(binding.logicalName);
    if (!target || target.component !== 'backend' && target.component !== 'functions' ||
        target.pathParts.length === 0) continue;
    const component: ManifestLayoutComponentId = target.component === 'functions'
      ? 'function-worker'
      : 'backend';
    roots.set(`${component}:${applicationPathKey(target.pathParts)}`, {
      component,
      pathParts: [...target.pathParts]
    });
  }
  return [...roots.values()];
}

export function createAdoptionMappingReview(
  inventory: AdoptionInventoryReport,
  preview: AdoptionPreview,
  destination: AdoptionDestinationPlanReport
): AdoptionMappingReviewReport {
  if (inventory.projectRoot !== preview.projectRoot ||
      destination.projectRoot !== preview.projectRoot ||
      destination.reviewFingerprint !== preview.fingerprint ||
      inventory.inspectionDigest !== preview.inventoryDigest ||
      preview.candidateStatus !== 'candidate-observed-unverified' ||
      destination.candidateDigest !== preview.candidateDigest) {
    throw new Error('Adoption mapping review requires one exact current inventory, review and destination plan.');
  }
  const roots = applicationRoots(inventory);
  const selectedFamily = targetFamily(inventory.target.workload.apiStack);
  const files = inventory.files.map(file => {
    const surface = fileSurface(file.pathParts);
    const incompatible = file.currentTargetLogicalName === null &&
      roots.some(root => within(file.pathParts, root.pathParts)) &&
      sourceFamily(file.pathParts) !== null &&
      sourceFamily(file.pathParts) !== selectedFamily;
    return {
      pathParts: [...file.pathParts],
      expectedDigest: file.digest,
      expectedMode: file.mode,
      currentTargetLogicalName: file.currentTargetLogicalName,
      surface,
      decision: 'explicit-review-required' as const,
      suggestedDisposition: incompatible
        ? 'unsupported-language-conversion' as const
        : file.currentTargetLogicalName === null
          ? 'mapping-decision-required' as const
          : 'preserve-current-path' as const
    };
  }).sort((left, right) =>
    applicationPathKey(left.pathParts).localeCompare(applicationPathKey(right.pathParts), 'en'));
  const surfaceByPath = new Map(files.map(file => [applicationPathKey(file.pathParts), file.surface]));
  const references = inventory.references.map(reference => ({
    referenceId: reference.id,
    sourcePathParts: [...reference.sourcePathParts],
    targetPathParts: [...reference.targetPathParts],
    kind: reference.kind,
    surface: referenceSurface(
      reference,
      surfaceByPath.get(applicationPathKey(reference.sourcePathParts)) ?? 'other'
    ),
    decision: 'explicit-review-required' as const
  }));
  const unresolvedMappings = files.flatMap(file =>
    file.suggestedDisposition === 'preserve-current-path'
      ? []
      : [{
          pathParts: [...file.pathParts],
          reason: file.suggestedDisposition
        }]);
  const observedSurfaces = [...new Set(files.map(file => file.surface))].sort();
  const observedReferenceSurfaces = [...new Set(references.map(reference => reference.surface))].sort();
  const body = {
    schemaVersion: adoptionMappingReviewSchemaVersion,
    kind: 'liftoff-adoption-mapping-review' as const,
    readOnly: true as const,
    projectRoot: inventory.projectRoot,
    reviewFingerprint: preview.fingerprint,
    destinationPlanFingerprint: destination.fingerprint,
    inventoryDigest: inventory.inspectionDigest,
    targetLayoutDigest: inventory.target.digest,
    status: unresolvedMappings.length ? 'blocked' as const : 'explicit-review-required' as const,
    files,
    references,
    unresolvedMappings,
    observedSurfaces,
    observedReferenceSurfaces,
    dynamicReferencesReviewed: false as const,
    verificationSelection: 'not-provided' as const,
    compatibility: 'not-verified' as const,
    publication: 'not-authorized' as const,
    limitations: [
      'Every file and bounded reference still requires an explicit final compatibility decision; suggested dispositions are not approval.',
      'Dynamic imports, generated references, aliases, package resolution and framework behavior remain unreviewed until declared checks pass.',
      'Unsupported backend-language or framework evidence remains unresolved; Liftoff does not replace it with a selected starter or claim an automatic conversion.',
      'This review reads no protected deployment/state scope and grants no staging, verification, file transaction or active-binding publication authority.'
    ]
  };
  const report = structuredClone({
    ...body,
    fingerprint: canonicalSha256(body)
  });
  const freeze = <T>(value: T): T => {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  return freeze(report);
}

export { fileSurface as classifyAdoptionMappingSurface };
