import { createHash } from 'node:crypto';
import type {
  LiftoffManifest, ManifestProvenance, ManifestStandards, ProjectPlan
} from '../../domain/project/contracts.js';
import type { ProjectFileMutation } from '../../adapters/filesystem/project-transaction.js';
import {
  currentStandardsManifestContext, generatedComponentsForPlan
} from '../../adapters/packaged-assets/resource-catalog.js';

export function generatedManifestStandards(plan: ProjectPlan): ManifestStandards {
  const context = currentStandardsManifestContext();
  return {
    schemaVersion: 1,
    catalogDigest: context.profiles.digest,
    resourceCatalogDigest: context.resourceCatalogDigest,
    components: generatedComponentsForPlan(plan)
  };
}

export function preserveManifestProvenance(
  manifest: LiftoffManifest,
  original: Buffer
): { provenance: ManifestProvenance; history?: ProjectFileMutation } {
  if (manifest.artifactVersion === 8) return { provenance: structuredClone(manifest.provenance) };
  const digest = createHash('sha256').update(original).digest('hex');
  const historyPathParts = ['.liftoff', 'manifest-history', digest, 'manifest.json'];
  return {
    provenance: {
      kind: 'generated',
      origin: {
        kind: 'historical-manifest', artifactVersion: manifest.artifactVersion,
        writerVersion: manifest.liftoffVersion, contentHash: `sha256:${digest}`,
        historyPathParts, originalProfile: 'unknown'
      },
      repairs: []
    },
    history: { type: 'write', pathParts: historyPathParts, content: Buffer.from(original), mode: 0o600 }
  };
}
