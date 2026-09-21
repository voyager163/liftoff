import { canonicalDigest } from './admission.ts';
import { digest, identifier, parseFinding, SecurityEvidenceError } from './evidence.ts';
import { generatedSecurityCases, imageCases } from './inventory.ts';
import { imageCoverage, TRIVY_POLICY, type ImageAssessment } from './trivy.ts';
import { assertIssuedCheckovObservation, verifiedCheckovScope, type CheckovInputScope } from './checkov.ts';
import { previewCheckovRoleDiagnostics } from './checkov-role-policy.ts';
import { parseRepositoryFindingPolicy } from './finding-policy.ts';

function fail(code: string): never { throw new SecurityEvidenceError(`artifact-gate-${code}`); }
const same = (left: unknown, right: unknown) => canonicalDigest(left) === canonicalDigest(right);

export interface BuiltImageExpectation { caseId: string; imageDigest: string; platform: string; }

/** Strict local finding evaluation; adopted exceptions and source/run authentication belong to the coordinator. */
export function summarizeImageGate(
  selectedCases: readonly string[], builtImages: readonly BuiltImageExpectation[],
  assessments: readonly ImageAssessment[], cleanup: 'completed' | 'failed' | 'pending', now = new Date()
) {
  if (!selectedCases.length || selectedCases.length > imageCases.length ||
      new Set(selectedCases).size !== selectedCases.length ||
      selectedCases.some(id => !imageCases.some(entry => entry.id === id)) ||
      new Set(builtImages.map(image => image.caseId)).size !== builtImages.length ||
      new Set(assessments.map(image => image.caseId)).size !== assessments.length ||
      [...builtImages, ...assessments].some(item => !selectedCases.includes(item.caseId)) ||
      !['completed', 'failed', 'pending'].includes(cleanup) || !Number.isFinite(now.getTime())) fail('image-inventory');
  const cases = selectedCases.map(caseId => {
    const expected = builtImages.find(image => image.caseId === caseId), assessment = assessments.find(image => image.caseId === caseId);
    if (!expected) {
      if (assessment) fail('image-without-build');
      return { caseId, owner: 'voyager163', analysis: 'missing-build' as const, blocking: 0, tracked: 0 };
    }
    digest(expected.imageDigest);
    const coverage = imageCoverage(caseId);
    if (expected.platform !== coverage.platform) fail('image-platform');
    if (!assessment) return { caseId, owner: 'voyager163', analysis: 'missing-assessment' as const, blocking: 0, tracked: 0 };
    if (assessment.imageDigest !== expected.imageDigest || assessment.platform !== expected.platform ||
        assessment.toolVersion !== TRIVY_POLICY.version) fail('image-producer-identity');
    digest(assessment.databaseDigest);
    const start = Date.parse(assessment.generatedAt), end = Date.parse(assessment.completedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end > now.getTime() ||
        now.getTime() - start > 86_400_000) fail('stale-image-evidence');
    for (const kind of ['os', 'application'] as const) {
      const observed = assessment.coverage[kind];
      if (!observed || observed.status !== coverage[kind] || !Number.isSafeInteger(observed.packages) ||
          (coverage[kind] === 'required' ? observed.packages < 1 : observed.packages !== 0)) fail('image-component-coverage');
    }
    if (!Array.isArray(assessment.findings) || assessment.findings.length > 20_000) fail('image-findings');
    const findings = assessment.findings.map(parseFinding);
    if (new Set(findings.map(finding => finding.id)).size !== findings.length ||
        findings.some(finding => finding.tool !== 'trivy' || finding.scope !== caseId ||
          finding.artifactDigest !== expected.imageDigest ||
          finding.kind === 'policy' && finding.policyClass !== 'trivy-valid-native-unscored-advisory')) fail('image-finding-identity');
    const blocking = findings.filter(finding => finding.kind === 'policy' || ['high', 'critical'].includes(finding.severity)).length;
    return { caseId, owner: 'voyager163', analysis: 'complete' as const, imageDigest: expected.imageDigest, platform: expected.platform,
      reportDigest: canonicalDigest(assessment), findings: findings.length,
      blocking, tracked: findings.length - blocking,
      policyFindings: findings.filter(finding => finding.kind === 'policy').length };
  });
  const complete = cleanup === 'completed' && cases.every(item => item.analysis === 'complete');
  return {
    kind: 'local-image-finding-gate', cases, cleanup, analysisComplete: complete,
    gate: !complete ? 'incomplete' as const : cases.some(item => item.blocking > 0) ? 'blocked' as const : 'passed' as const,
    fullImageInventory: selectedCases.length === imageCases.length,
    policy: 'strict-no-exceptions-not-adopted-authority',
    sourceRunAuthentication: false, hostedQualification: false, publicationQualified: false
  };
}

export type CheckovGateOutcome = { id: string; status: 'complete'; result: unknown } |
  { id: string; status: 'error' | 'missing' | 'cancelled' | 'skipped' };

/** Every native failure remains visible, including exact diagnostics and unmapped/unsupported rules. */
export function summarizeCheckovGate(
  expected: readonly { id: string; scope: CheckovInputScope }[], outcomes: readonly CheckovGateOutcome[], policySource: string
) {
  if (!expected.length || expected.length > 256 || new Set(expected.map(item => item.id)).size !== expected.length ||
      new Set(outcomes.map(item => item.id)).size !== outcomes.length ||
      outcomes.some(item => !expected.some(entry => entry.id === item.id))) fail('iac-inventory');
  const policy = parseRepositoryFindingPolicy(policySource);
  const complete = outcomes.filter((item): item is Extract<CheckovGateOutcome, { status: 'complete' }> => item.status === 'complete');
  complete.forEach(item => {
    assertIssuedCheckovObservation(item.result);
    const scope = expected.find(entry => entry.id === item.id)!.scope;
    if (!same(verifiedCheckovScope(item.result), scope)) fail('iac-input-drift');
  });
  const preview = complete.length ? previewCheckovRoleDiagnostics(complete.map(item => item.result)) : null;
  const cases = expected.map(entry => {
    identifier(entry.id, 'artifact-gate-iac-id');
    const outcome = outcomes.find(item => item.id === entry.id);
    if (!outcome || outcome.status !== 'complete') return {
      id: entry.id, owner: 'voyager163', analysis: outcome?.status ?? 'missing', blocking: [], diagnostics: [], controlEquivalences: [], unmapped: [],
      resourceApplicabilityQualified: false
    };
    assertIssuedCheckovObservation(outcome.result);
    const result = outcome.result, reportIndex = complete.indexOf(outcome);
    const blocking: string[] = [], diagnostics: string[] = [], controlEquivalences: string[] = [], unmapped: string[] = [];
    for (const [resultIndex, finding] of result.results.entries()) {
      if (finding.status !== 'failed') continue;
      if (finding.applicability === 'unsupported-api-version') { unmapped.push(finding.rule); continue; }
      if (preview?.diagnostics.some(item => item.reportIndex === reportIndex && item.resultIndex === resultIndex)) {
        diagnostics.push(finding.rule);
      } else if (preview?.controlEquivalences.some(item => item.reportIndex === reportIndex && item.resultIndex === resultIndex)) {
        controlEquivalences.push(finding.rule);
      } else if (policy.policyRules.some(rule => rule.tool === 'checkov' && rule.rule === finding.rule)) {
        blocking.push(finding.rule);
      } else unmapped.push(finding.rule);
    }

    return {
      id: entry.id, owner: 'voyager163', analysis: 'complete', blocking, diagnostics, controlEquivalences, unmapped,
      nativeFailures: result.failed, nativeFailureEvidenceDigest: canonicalDigest(result.results),
      cleanup: result.cleanup, resourceApplicabilityQualified: result.resourceApplicabilityQualified,
      resourceApplicabilityBasis: result.resourceApplicabilityBasis,
      inputDigest: canonicalDigest(result.files), reportDigest: canonicalDigest(result)
    };
  });
  const analysisComplete = cases.every(item => item.analysis === 'complete');
  const policyComplete = analysisComplete && cases.every(item => item.unmapped.length === 0 && item.resourceApplicabilityQualified);
  return {
    kind: 'local-iac-finding-gate', cases, analysisComplete,
    gate: !policyComplete ? 'incomplete' as const : cases.some(item => item.blocking.length) ? 'blocked' as const : 'passed' as const,
    nativeFailuresUnchanged: true, roleDiagnosticsAreNotNativePasses: true,
    providerDefaultEquivalencesAreNotNativePasses: true,
    ownerActions: cases.flatMap(entry => [
      ...(entry.analysis !== 'complete' ? [{ owner: 'voyager163', scope: entry.id, action: 'rerun-exact-scope' }] : []),
      ...(entry.blocking.length ? [{ owner: 'voyager163', scope: entry.id, action: 'triage-blocking-findings' }] : []),
      ...(entry.unmapped.length || !entry.resourceApplicabilityQualified
        ? [{ owner: 'voyager163', scope: entry.id, action: 'qualify-rule-and-resource-applicability' }] : []),
      ...(entry.diagnostics.length ? [{ owner: 'voyager163', scope: entry.id, action: 'track-exact-role-feature-limitations' }] : []),
      ...(entry.controlEquivalences.length ? [{ owner: 'voyager163', scope: entry.id, action: 'retain-exact-provider-default-evidence' }] : [])
    ]),
    sourceRunAuthentication: false, adoptedPolicyAuthority: false, hostedQualification: false, publicationQualified: false
  };
}

export interface ArtifactGateObservation {
  id: string;
  kind: 'iac' | 'images';
  inputDigest: string;
  reportDigest: string;
  sourceCommit: string;
  completedAt: string;
  execution: 'complete' | 'error' | 'skipped' | 'cancelled';
  findingGate: 'passed' | 'blocked' | 'incomplete';
  cleanup: 'completed' | 'failed' | 'pending';
  units: readonly string[];
}

/** Exact group composition only; this cannot authenticate producer receipts. */
export function combineArtifactGates(
  expected: readonly { id: string; kind: 'iac' | 'images'; inputDigest: string; reportDigest: string; units: readonly string[] }[],
  observations: readonly ArtifactGateObservation[], sourceCommit: string, now = new Date()
) {
  const required = ['source-iac', 'runtime-images', ...generatedSecurityCases.map(entry => `generated-iac/${entry.id}`)];
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || !Number.isFinite(now.getTime()) ||
      expected.length !== required.length || new Set(expected.map(item => item.id)).size !== required.length ||
      required.some(id => !expected.some(item => item.id === id)) ||
      new Set(observations.map(item => item.id)).size !== observations.length ||
      observations.some(item => !required.includes(item.id))) fail('full-inventory');
  const groups = expected.map(entry => {
    const image = entry.id === 'runtime-images';
    digest(entry.inputDigest); digest(entry.reportDigest);
    if (entry.kind !== (image ? 'images' : 'iac') || !entry.units.length ||
        new Set(entry.units).size !== entry.units.length ||
        image && !same([...entry.units].sort(), imageCases.map(item => item.id).sort()) ||
        entry.units.some(unit => typeof unit !== 'string' || !unit || unit.length > 250)) fail('expected-units');
    const actual = observations.find(item => item.id === entry.id);
    if (!actual) return { id: entry.id, analysis: 'missing', gate: 'incomplete', cleanup: 'pending' };
    if (actual.sourceCommit !== sourceCommit || actual.kind !== entry.kind ||
        actual.inputDigest !== entry.inputDigest || actual.reportDigest !== entry.reportDigest ||
        !same([...actual.units].sort(), [...entry.units].sort())) fail('producer-or-input-drift');
    const completed = Date.parse(actual.completedAt);
    if (!Number.isFinite(completed) || new Date(completed).toISOString() !== actual.completedAt ||
        completed > now.getTime() || now.getTime() - completed > 86_400_000) fail('stale-group');
    if (!['complete', 'error', 'skipped', 'cancelled'].includes(actual.execution) ||
        !['passed', 'blocked', 'incomplete'].includes(actual.findingGate) ||
        !['completed', 'failed', 'pending'].includes(actual.cleanup)) fail('group-state');
    return {
      id: entry.id, analysis: actual.execution, gate: actual.findingGate, cleanup: actual.cleanup,
      inputDigest: actual.inputDigest, reportDigest: actual.reportDigest
    };
  });
  const analysisComplete = groups.every(group => group.analysis === 'complete' && group.cleanup === 'completed');
  return {
    kind: 'source-and-generated-artifact-gates', sourceCommit, expectedGroups: required.length,
    observedGroups: observations.length, groups, analysisComplete,
    gate: !analysisComplete || groups.some(group => group.gate === 'incomplete') ? 'incomplete' as const
      : groups.some(group => group.gate === 'blocked') ? 'blocked' as const : 'passed' as const,
    authentication: 'not-established-by-composition', maintenanceAdmission: false, publicationQualified: false
  };
}
