import { createHash } from 'node:crypto';
import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { createManifestV8Candidate, type ManifestV8Candidate } from '../project/manifest-writer.js';
import { buildModernManagedCore } from '../project/modern-managed-core.js';
import { resolveModernProjectSourceContext, type ModernProjectSourceInput } from '../project/source-context.js';
import { inspectAdoptionLayout, type AdoptionInventoryReport } from './inventory.js';

interface AdoptionCandidateReportBase {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-adoption-candidate-inspection';
  readonly readOnly: true;
  readonly sourceDigest: string;
  readonly inventory: AdoptionInventoryReport;
  readonly managedSource: readonly {
    logicalName: string;
    pathParts: readonly string[];
    candidateHash: string;
  }[];
  readonly verification: 'not-performed';
  readonly publication: 'not-authorized';
  readonly requiredChecks: readonly string[];
}

export type AdoptionCandidateReport = AdoptionCandidateReportBase & (
  | {
    readonly status: 'blocked';
    readonly candidateDigest: null;
    readonly blockers: readonly { code: 'binding-unobserved'; logicalName: string; pathParts: readonly string[] }[];
  }
  | {
    readonly status: 'candidate-observed-unverified';
    readonly candidateDigest: string;
    readonly blockers: readonly [];
  }
);

/** Candidate bytes and original snapshots are private comparison inputs, not publication authority. */
export interface AdoptionCandidateInspection {
  readonly report: AdoptionCandidateReport;
  readonly candidate: ManifestV8Candidate | null;
  readonly snapshots: readonly ProjectFileSnapshot[];
}

export async function inspectAdoptionCandidate(root: string, source: unknown): Promise<AdoptionCandidateInspection> {
  const context = resolveModernProjectSourceContext(source);
  const captured: ModernProjectSourceInput = {
    selection: context.selection, plugins: context.plugins, activeLayout: context.activeLayout
  };
  const managed = buildModernManagedCore(captured);
  const inspection = await inspectAdoptionLayout(root, captured);
  const base: AdoptionCandidateReportBase = {
    schemaVersion: 1, kind: 'liftoff-adoption-candidate-inspection', readOnly: true,
    sourceDigest: canonicalSha256(captured), inventory: inspection.report,
    managedSource: managed.map(artifact => ({
      logicalName: artifact.logicalName, pathParts: [...artifact.pathParts],
      candidateHash: `sha256:${createHash('sha256').update(artifact.content, 'utf8').digest('hex')}`
    })),
    verification: 'not-performed', publication: 'not-authorized',
    requiredChecks: [
      'Compatible application behavior and complete semantic reference mappings.',
      'Exact current core destinations, independent permissions and approved effects.',
      'Actual selected framework and agent integrations, or independently verified Manual applicability.',
      'Authenticated external adoption ownership, matching staged verification and subsequent file approval.',
      'Current inputs under the project lock and exact recorded recovery before any new transaction.'
    ]
  };
  let candidate: ManifestV8Candidate | null = null;
  let report: AdoptionCandidateReport;
  if (inspection.report.unobservedBindings.length) {
    report = {
      ...base, status: 'blocked', candidateDigest: null,
      blockers: inspection.report.unobservedBindings.map(binding => ({
        code: 'binding-unobserved', logicalName: binding.logicalName, pathParts: [...binding.pathParts]
      }))
    };
  } else {
    candidate = createManifestV8Candidate({
      origin: 'adoption', selection: captured.selection, activeLayout: captured.activeLayout,
      managed: managed.map(artifact => ({
        kind: 'bytes', logicalName: artifact.logicalName, category: artifact.category,
        pathParts: [...artifact.pathParts], content: artifact.content
      })),
      adoptionObservations: inspection.report.adoptionObservations
    });
    report = {
      ...base, status: 'candidate-observed-unverified', candidateDigest: candidate.digest, blockers: []
    };
  }
  const result: AdoptionCandidateInspection = { report, candidate, snapshots: inspection.snapshots };
  Object.defineProperties(result, {
    candidate: { enumerable: false },
    snapshots: { enumerable: false }
  });
  return result;
}
