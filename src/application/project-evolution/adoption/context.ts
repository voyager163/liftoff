import type { ManifestStandards } from '../../../domain/project/contracts.js';

export interface AdoptionInspectionContext {
  schemaVersion: 1;
  kind: 'liftoff-adoption-inspection-context';
  projectName: string;
  standards: ManifestStandards;
  assessmentDigest: string;
}
