import type {
  HistoricalLiftoffManifest, LiftoffManifest, LiftoffManifestV8, ManifestComponentWorkload,
  ManifestGeneratedWorkload, ManifestProjectIdentity, ManifestProvenance, ManifestWorkload
} from '../contracts.js';

export type GeneratedWorkloadManifest = HistoricalLiftoffManifest | (
  LiftoffManifestV8 & {
    project: ManifestProjectIdentity & { workload: ManifestGeneratedWorkload };
    provenance: Extract<ManifestProvenance, { kind: 'generated' }>;
  }
);

export type ComponentOnlyManifest = LiftoffManifestV8 & {
  project: ManifestProjectIdentity & { workload: ManifestComponentWorkload };
};

export function isApiManifestWorkload(workload: ManifestWorkload): workload is ManifestGeneratedWorkload {
  return workload.kind === 'genai' || workload.kind === 'standard';
}

// API facts can be adopted; they do not establish a generated seed or starter history.
export function hasGeneratedWorkload(manifest: LiftoffManifest): manifest is GeneratedWorkloadManifest {
  return isApiManifestWorkload(manifest.project.workload) &&
    (manifest.artifactVersion !== 8 || manifest.provenance.kind === 'generated');
}

export function isComponentOnlyManifest(manifest: LiftoffManifest): manifest is ComponentOnlyManifest {
  return manifest.artifactVersion === 8 && manifest.project.workload.kind === 'components';
}
