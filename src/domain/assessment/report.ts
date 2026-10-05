import { canonicalJson, canonicalSha256 } from '../governance/activation/canonical-json.js';
import type { Classification, JsonValue, ObservationSource } from '../governance/assessment/types.js';

export type ProjectAssessmentProfile = 'none' | 'single-maintainer-gitflow' | 'team-gitflow';
export type ProjectAssessmentCategory = 'metadata' | 'layout' | 'dependencies' | 'runtime' |
  'workflow' | 'agents' | 'managed-core' | 'governance' | 'infrastructure' | 'documentation' | 'references';
export type ProjectRemediationCategory = 'managed-update' | 'application-repair' | 'adoption' |
  'workflow-profile-migration' | 'new-environment-activation' | 'existing-deployment-planning';

export interface ProjectAssessmentTarget {
  cliVersion: string;
  manifestVersion: 8;
  profile: ProjectAssessmentProfile;
  profileSelection: 'explicit' | 'recorded' | 'default';
  policy: { version: string; digest: string } | null;
  pluginCatalog: { apiVersion: number; registryDigest: string; pluginSetDigest: string };
  selectedPlugins: { resolutionDigest: string; ids: string[] } | null;
  layoutDescriptorDigest: string | null;
}

export interface ProjectAssessmentObservation {
  availability: 'observed' | 'missing' | 'not-observed';
  value: JsonValue;
  source: { kind: 'file' | 'inventory' | 'installed-source'; pathParts: string[] | null; digest: string } |
    (ObservationSource & { kind: 'github' | 'azure' }) | null;
  facts?: JsonValue;
}

export interface ProjectAssessmentFinding {
  id: string;
  category: ProjectAssessmentCategory;
  title: string;
  pathParts: string[] | null;
  applicability: 'applicable' | 'inapplicable' | 'unknown';
  supported: boolean;
  classification: Classification;
  expected: JsonValue;
  observed: ProjectAssessmentObservation;
  reason: string;
  remediation: {
    category: ProjectRemediationCategory;
    available: boolean;
    previewCommand: string[] | null;
    separateConsent: true;
  };
}

export interface ProjectAssessmentReport {
  schemaVersion: 1;
  kind: 'liftoff-project-assessment';
  command: 'assess';
  readOnly: true;
  mode: 'local' | 'live';
  project: {
    root: string;
    kind: 'liftoff' | 'git' | 'non-git' | 'unavailable';
    manifestVersion: number | null;
    recordedProfile: string | null;
  };
  target: ProjectAssessmentTarget | null;
  snapshot: { inventoryDigest: string | null; metadataDigest: string | null; inputsStable: boolean };
  coverage: {
    total: number; applicable: number; inapplicable: number; unknownApplicability: number;
    fullyObserved: number; notObserved: number; unsupported: number; differences: number;
  };
  findings: ProjectAssessmentFinding[];
  diagnostics: { code: string; severity: 'warning' | 'error'; message: string }[];
  limitations: string[];
  outcome: 'aligned' | 'differences' | 'partial' | 'not-applicable' | 'error';
  exitCode: 0 | 1 | 2;
  resultDigest: string;
}

export function projectAssessmentFinding(
  input: Omit<ProjectAssessmentFinding, 'classification'> & { difference?: 'outdated' | 'conflicting' }
): ProjectAssessmentFinding {
  const { difference, ...finding } = input;
  const classification: Classification = finding.applicability === 'inapplicable' ? 'inapplicable'
    : finding.applicability === 'unknown' || !finding.supported || finding.observed.availability === 'not-observed'
      ? 'not-observed'
      : finding.observed.availability === 'missing' ? 'missing'
        : canonicalJson(finding.expected) === canonicalJson(finding.observed.value) ? 'aligned' : difference ?? 'conflicting';
  if (finding.observed.availability !== 'not-observed' && finding.observed.source === null) {
    throw new Error('Observed project facts and absence require provenance.');
  }
  return { ...finding, classification };
}

export function assembleProjectAssessmentReport(
  input: Pick<ProjectAssessmentReport, 'mode' | 'project' | 'target' | 'snapshot' | 'findings' | 'diagnostics' | 'limitations'>
): ProjectAssessmentReport {
  const findings = [...input.findings].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(findings.map(finding => finding.id)).size !== findings.length) {
    throw new Error('Whole-project finding identities must be unique.');
  }
  const diagnostics = [...input.diagnostics].sort((a, b) => {
    const left = `${a.code}\0${a.message}`, right = `${b.code}\0${b.message}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const applicable = findings.filter(finding => finding.applicability === 'applicable');
  const coverage: ProjectAssessmentReport['coverage'] = {
    total: findings.length, applicable: applicable.length,
    inapplicable: findings.filter(finding => finding.applicability === 'inapplicable').length,
    unknownApplicability: findings.filter(finding => finding.applicability === 'unknown').length,
    fullyObserved: applicable.filter(finding => finding.supported && finding.classification !== 'not-observed').length,
    notObserved: findings.filter(finding => finding.classification === 'not-observed').length,
    unsupported: findings.filter(finding => finding.applicability !== 'inapplicable' && !finding.supported).length,
    differences: findings.filter(finding => ['missing', 'outdated', 'conflicting', 'approved-exception'].includes(finding.classification)).length
  };
  const outcome = diagnostics.some(diagnostic => diagnostic.severity === 'error') || !input.target || !findings.length ? 'error'
    : !input.snapshot.inputsStable || coverage.unknownApplicability || coverage.notObserved || coverage.unsupported ? 'partial'
      : coverage.differences ? 'differences' : applicable.length ? 'aligned' : 'not-applicable';
  const report: ProjectAssessmentReport = {
    schemaVersion: 1, kind: 'liftoff-project-assessment', command: 'assess', readOnly: true,
    ...input, findings, diagnostics, coverage, outcome,
    exitCode: outcome === 'error' ? 1 : outcome === 'aligned' || outcome === 'not-applicable' ? 0 : 2,
    resultDigest: ''
  };
  report.resultDigest = canonicalSha256({ ...report, resultDigest: '' });
  return report;
}

export function providerAssessmentObservation(
  observation: { availability: ProjectAssessmentObservation['availability']; value: JsonValue; source: ObservationSource | null; facts?: JsonValue }
): ProjectAssessmentObservation {
  const provenance = observation.source;
  if (observation.availability !== 'not-observed' && provenance === null) {
    throw new Error('Observed live values and absence require complete provider provenance.');
  }
  let source: ProjectAssessmentObservation['source'] = null;
  if (provenance !== null) {
    const kind = provenance.kind;
    if (kind !== 'github' && kind !== 'azure') {
      throw new Error('Live observations require actual provider provenance, not installed-source or file provenance.');
    }
    if (!provenance.location || !Number.isFinite(Date.parse(provenance.capturedAt)) ||
        (provenance.digest !== null && !/^[a-f0-9]{64}$/u.test(provenance.digest)) ||
        (provenance.revision !== null && !provenance.revision) ||
        (provenance.line !== null && (!Number.isSafeInteger(provenance.line) || provenance.line < 1))) {
      throw new Error('Live observations require complete, valid provider provenance.');
    }
    source = { ...provenance, kind };
  }
  return {
    availability: observation.availability, value: observation.value,
    source,
    ...(observation.facts === undefined ? {} : { facts: observation.facts })
  };
}
