import path from 'node:path';
import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { ManifestAdoptionObservation } from '../../domain/project/manifest/v8.js';
import { manifestActiveLayoutDigest } from '../../domain/project/manifest/layout.js';
import { resolveModernProjectSourceContext } from '../project/source-context.js';
import { currentBoundApplicationTargets, applicationInventoryLimitations } from '../repair/application-inventory.js';
import {
  ApplicationFiles, ApplicationInspectionError, applicationDigest, applicationExclusion,
  applicationParts, applicationPathFold, applicationPathKey, assertApplicationNoLinkAncestors,
  canonicalApplicationRoot
} from '../repair/application-files.js';
import { applicationText, inspectApplicationReferences } from '../repair/application-references.js';
import {
  applicationBounds, type ApplicationDirectoryObservation, type ApplicationFileObservation,
  type ApplicationReference, type ApplicationTargetLayout
} from '../repair/application-types.js';

export interface AdoptionInventoryReport {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-adoption-inventory';
  readonly readOnly: true;
  readonly projectRoot: string;
  readonly manifest: 'observed-absent';
  readonly inspectionDigest: string;
  readonly target: ApplicationTargetLayout;
  readonly pluginResolutionDigest: string;
  readonly activeLayoutDigest: string;
  readonly files: readonly ApplicationFileObservation[];
  readonly directoryInventory: readonly ApplicationDirectoryObservation[];
  readonly references: readonly ApplicationReference[];
  readonly exclusions: ApplicationFiles['exclusions'];
  readonly adoptionObservations: readonly ManifestAdoptionObservation[];
  readonly unobservedBindings: readonly { logicalName: string; pathParts: readonly string[] }[];
  readonly unmappedFiles: readonly { pathParts: readonly string[] }[];
  readonly referenceCoverage: 'bounded-literals-only';
  readonly compatibility: 'not-verified';
  readonly deployment: 'planning-only';
  readonly limitations: readonly string[];
  readonly bounds: typeof applicationBounds;
}

/** Private captured bytes are deliberately excluded from report serialization. */
export interface AdoptionLayoutInspection {
  readonly report: AdoptionInventoryReport;
  readonly snapshots: readonly ProjectFileSnapshot[];
}

export async function inspectAdoptionLayout(root: string, source: unknown): Promise<AdoptionLayoutInspection> {
  await assertApplicationNoLinkAncestors(path.resolve(root), 'Project inventory root');
  const projectRoot = await canonicalApplicationRoot(root);
  const context = resolveModernProjectSourceContext(source);
  if (context.activeLayout.state !== 'bound') {
    throw new ApplicationInspectionError('Adoption inventory requires explicit active bindings; unresolved paths are not application evidence.');
  }
  const current = currentBoundApplicationTargets({
    selection: context.selection, plugins: context.plugins, activeLayout: context.activeLayout
  });
  const reader = new ApplicationFiles(projectRoot, parts =>
    applicationExclusion(parts, current.protectedPaths, current.examplePaths, current.protectedTrees));
  const boundary = await reader.inventory([]);
  for (const entry of boundary.entries) {
    const name = applicationPathFold(entry.name);
    if (name === 'liftoff.manifest.json' || name === '.liftoff' || name === '.liftoff-init.lock') {
      throw new ApplicationInspectionError(
        'Adoption requires observed absence of Liftoff control/transaction boundaries; validate existing metadata or resolve recorded recovery, never reinitialize it.'
      );
    }
  }
  await reader.walk();
  await reader.assertUnchanged();
  const snapshots = [...reader.snapshots.values()].filter(snapshot => snapshot.content !== undefined)
    .sort((left, right) => applicationPathKey(left.pathParts).localeCompare(applicationPathKey(right.pathParts), 'en'));
  const files: ApplicationFileObservation[] = snapshots.map(snapshot => ({
    pathParts: applicationParts(snapshot.pathParts), digest: applicationDigest(snapshot.content!),
    mode: snapshot.mode!, bytes: snapshot.content!.byteLength, text: applicationText(snapshot.content!) !== null,
    currentTargetLogicalName: current.target.artifacts.find(artifact =>
      applicationPathKey(artifact.pathParts) === applicationPathKey(snapshot.pathParts))?.logicalName ?? null,
    provenance: null
  }));
  const references = inspectApplicationReferences(snapshots, reader.directoryInventory);
  const artifactBindings = context.activeLayout.bindings.filter(binding => binding.kind === 'artifact');
  const adoptionObservations: ManifestAdoptionObservation[] = [];
  const unobservedBindings: AdoptionInventoryReport['unobservedBindings'][number][] = [];
  for (const binding of artifactBindings) {
    const file = files.find(entry => entry.currentTargetLogicalName === binding.logicalName &&
      applicationPathKey(entry.pathParts) === applicationPathKey(binding.pathParts));
    if (file) adoptionObservations.push({
      logicalName: binding.logicalName, pathParts: [...binding.pathParts], observedHash: `sha256:${file.digest}`
    });
    else unobservedBindings.push({ logicalName: binding.logicalName, pathParts: [...binding.pathParts] });
  }
  const body: Omit<AdoptionInventoryReport, 'inspectionDigest'> = {
    schemaVersion: 1, kind: 'liftoff-adoption-inventory', readOnly: true, projectRoot,
    manifest: 'observed-absent', target: current.target,
    pluginResolutionDigest: context.plugins.resolutionDigest,
    activeLayoutDigest: manifestActiveLayoutDigest(context.activeLayout, context.source.layoutDescriptor),
    files, directoryInventory: [...reader.directoryInventory].sort((left, right) =>
      applicationPathKey(left.pathParts).localeCompare(applicationPathKey(right.pathParts), 'en')),
    references, exclusions: reader.exclusions, adoptionObservations, unobservedBindings,
    unmappedFiles: files.filter(file => file.currentTargetLogicalName === null)
      .map(file => ({ pathParts: [...file.pathParts] })),
    referenceCoverage: 'bounded-literals-only', compatibility: 'not-verified', deployment: 'planning-only',
    limitations: [
      'Explicit installed source selection and active bindings are comparison inputs, not a generated manifest or proof of compatible application behavior.',
      'No generation history, approval, transaction ownership, tool preparation, project execution, Git operation, network or file write is produced.',
      'Missing or excluded bindings and unmapped files require exact review; bounded literal references do not resolve dynamic or framework-specific mappings.',
      'Pre-existing infrastructure, deployment configuration and state are excluded and remain planning-only; local state absence is not cloud absence.',
      ...applicationInventoryLimitations.slice(1)
    ],
    bounds: applicationBounds
  };
  await reader.assertUnchanged();
  const inspection: AdoptionLayoutInspection = {
    report: { ...body, inspectionDigest: canonicalSha256({ ...body, selection: context.selection }) }, snapshots
  };
  Object.defineProperty(inspection, 'snapshots', { enumerable: false });
  return inspection;
}
