import {
  adoptedBaseIdentity, adoptedSourceSnapshot, canonicalDigest, readAdoptedPolicyData,
  type AdoptedBaseHandle, type RawFinding
} from './admission.ts';
import { digest, parseIdentity, record, SecurityEvidenceError, type EvidenceIdentity } from './evidence.ts';
import { parseNpmCandidate } from './npm-release.ts';
import {
  parseDeclaredSecretSource, readIssuedSecretSource, type DeclaredSecretAssessment, type DeclaredSecretSource,
  type SecretSourceOccurrence
} from './gitleaks-source.ts';
import {
  adoptedSecretDispositionVerdict, secretDispositionAdapter, type KnownSecretFact
} from './policy-data.ts';
import { prepareAdoptedSecretProfile } from './secret-profile.ts';

function fail(code: string): never { throw new SecurityEvidenceError(`secrets-admission-${code}`); }

/**
 * Commit/run provenance is retained separately. An unchanged exact blob,
 * detector and location is the same finding across a policy-only commit.
 */
export function secretOccurrenceKey(
  occurrence: SecretSourceOccurrence, detector: { version: string; binaryDigest: string; configDigest: string }
): string {
  return canonicalDigest({
    detector, rule: occurrence.rule, pathParts: occurrence.pathParts, blob: occurrence.blob,
    line: occurrence.line, column: occurrence.column, endLine: occurrence.endLine, endColumn: occurrence.endColumn
  });
}

function adoptedConfirmedKeys(source: string): Set<string> {
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { return fail('invalid-adopted-dispositions'); }
  const data = record(parsed, ['schemaVersion', 'dispositions'], 'invalid-secret-disposition-data');
  if (data.schemaVersion !== 1 || !Array.isArray(data.dispositions) || data.dispositions.length > 1000) {
    return fail('invalid-adopted-dispositions');
  }
  const confirmed = new Set<string>();
  for (const value of data.dispositions) {
    const item = record(value, ['findingKey', 'state', 'owner', 'rationale', 'evidenceDigests', 'incidentHistory'],
      'invalid-secret-disposition-record');
    if (item.state === 'confirmed-awaiting-remediation') confirmed.add(digest(item.findingKey));
  }
  return confirmed;
}

/**
 * Consumes only a live issued scanner result and independently loaded base.
 * Context and verified facts come from the trusted caller, not the candidate.
 * This component result is not whole-PR admission or a publication receipt.
 */
export async function bindSecretSourceAssessment(options: {
  base: AdoptedBaseHandle;
  side: 'base' | 'candidate';
  result: DeclaredSecretAssessment;
  expectedReportDigest: string;
  expectedScope: DeclaredSecretSource;
  identity: EvidenceIdentity;
  policyId: string;
  upstreamProfile: string;
  verifiedFacts: readonly KnownSecretFact[];
  now: Date;
}) {
  const actual = readIssuedSecretSource(options.result);
  if (actual.reportDigest !== digest(options.expectedReportDigest)) fail('report-substitution');
  const base = adoptedBaseIdentity(options.base), source = adoptedSourceSnapshot(options.base, options.side);
  const identity = parseIdentity(options.identity), result = options.result;
  if (result.executionIdentity === null ||
      canonicalDigest(result.executionIdentity) !== canonicalDigest(identity)) fail('execution-identity-mismatch');
  const expectedScope = parseDeclaredSecretSource(options.expectedScope);
  if (canonicalDigest(result.scope) !== canonicalDigest(expectedScope) ||
      identity.inventoryDigest !== canonicalDigest(expectedScope)) fail('scope-mismatch');
  if (identity.repository !== 'voyager163/liftoff' || identity.sourceSha !== source.sourceCommit ||
      identity.baseSha !== base.baseCommit || identity.policyDigest !== base.policyDigest ||
      result.scope.sourceCommit !== source.sourceCommit || actual.repositoryRoot !== source.repositoryRoot ||
      canonicalDigest(actual.tree) !== source.treeDigest) fail('source-or-authority-mismatch');
  const now = options.now.getTime(), started = Date.parse(result.observedAt), completed = Date.parse(result.completedAt);
  if (![now, started, completed].every(Number.isFinite) || started > completed || completed > now ||
      now - started > 86_400_000) fail('stale-assessment');
  const profile = await prepareAdoptedSecretProfile(options.base, options.upstreamProfile);
  if (result.tool.version !== '8.30.1' || result.profile.configDigest !== profile.configDigest ||
      result.profile.sourceDigest !== profile.sourceDigest || !result.profile.behaviorChanged ||
      canonicalDigest(actual.rules) !== canonicalDigest(profile.rules)) fail('detector-policy-mismatch');
  const required = identity.event === 'pull_request' && options.side === 'candidate'
    ? ['current-tree', 'reachable-history', 'introduced-history'] : ['current-tree', 'reachable-history'];
  if (result.cleanup !== 'completed' || result.scans.length !== required.length ||
      required.some(kind => result.scans.filter(scan => scan.kind === kind).length !== 1) ||
      result.scans.some(scan => !scan.assessmentComplete) ||
      required.includes('introduced-history') &&
      (result.introducedBase !== base.baseCommit || !actual.introducedCommits?.length)) fail('incomplete-coverage');
  const detector = { version: result.tool.version, binaryDigest: result.tool.binaryDigest, configDigest: profile.configDigest };
  const configurationDigest = canonicalDigest({ detector, rules: actual.rules });
  if (identity.configurationDigest !== configurationDigest) fail('configuration-mismatch');
  const keys = [...new Set(actual.occurrences.map(occurrence => secretOccurrenceKey(occurrence, detector)))].sort();
  const confirmed = adoptedConfirmedKeys(readAdoptedPolicyData(options.base, options.policyId));
  const verified = new Map(options.verifiedFacts.map(fact => [fact.key, fact]));
  if (verified.size !== options.verifiedFacts.length) fail('duplicate-facts');
  // Preserve adopted incident knowledge even if a caller omits or contradicts it.
  const facts: KnownSecretFact[] = keys.map(key => ({
    key, confirmedUnremediated: confirmed.has(key) || verified.get(key)?.confirmedUnremediated === true,
    evidenceDigests: verified.get(key)?.evidenceDigests ?? [],
    verifiedRemediationDigests: verified.get(key)?.verifiedRemediationDigests ?? []
  }));
  facts.push(...options.verifiedFacts.filter(fact => !keys.includes(fact.key)));
  const findings: RawFinding[] = facts.filter(fact => keys.includes(fact.key)).map(fact => ({
    key: fact.key, kind: 'secret', confirmedUnremediated: fact.confirmedUnremediated
  }));
  const verdict = adoptedSecretDispositionVerdict(options.base, options.policyId, facts, findings, options.now);
  return {
    kind: 'issued-source-secrets-component-result' as const,
    identity, producerRunBound: result.executionIdentity !== null,
    sourceReportDigest: actual.reportDigest, completedAt: result.completedAt,
    protectedInputsDigest: source.protectedInputsDigest, analysisConfigurationDigest: configurationDigest,
    // Only exact base-registered policy DATA is excluded by the independently
    // loaded protected tree. Actual histories and run provenance remain above.
    comparisonCoverageDigest: canonicalDigest({
      protectedInputsDigest: source.protectedInputsDigest, detector,
      surfaces: ['current-tree', 'reachable-history'],
      refs: Object.entries(expectedScope.refs).map(([ref, commit]) =>
        [ref, commit === expectedScope.sourceCommit ? 'selected-source-revision' : commit])
    }),
    coverage: {
      complete: true, selectedCommits: result.selectedCommits,
      introducedCommits: actual.introducedCommits?.length ?? null,
      occurrenceCount: actual.occurrences.length, distinctFindingCount: findings.length
    },
    findings, facts, verdict,
    findingPolicy: verdict.passed ? 'passed' as const : 'blocked' as const,
    adapter: secretDispositionAdapter(facts),
    wholeAdmissionQualified: false, hostedQualification: false, publicationQualified: false
  };
}

/**
 * Fresh release-source assessment under policy already in that selected main
 * commit. This payload is evidence data, never publisher/ref authorization.
 */
export async function prepareReleaseSecretPayload(
  options: Parameters<typeof bindSecretSourceAssessment>[0],
  candidateValue: unknown,
  expectedIdentity: EvidenceIdentity
) {
  const candidate = parseNpmCandidate(candidateValue), expected = parseIdentity(expectedIdentity);
  const base = adoptedBaseIdentity(options.base), source = adoptedSourceSnapshot(options.base, options.side);
  if (canonicalDigest(options.identity) !== canonicalDigest(expected) ||
      !['push', 'workflow_dispatch'].includes(expected.event) ||
      source.sourceRef !== 'refs/heads/main' || candidate.source.dirty ||
      base.baseCommit !== candidate.source.commit || base.headCommit !== candidate.source.commit ||
      expected.sourceSha !== candidate.source.commit || expected.baseSha !== candidate.source.commit ||
      options.result.introducedBase !== null ||
      Date.parse(options.result.observedAt) < Date.parse(candidate.createdAt)) fail('unqualified-release-source-or-attempt');
  const bound = await bindSecretSourceAssessment(options);
  if (!bound.producerRunBound || !bound.verdict.passed || bound.verdict.policyDiagnostics !== 0 || bound.verdict.blocked !== 0 ||
      bound.findings.some(finding => finding.confirmedUnremediated)) fail('blocking-release-secrets');
  return {
    schemaVersion: 1, kind: 'fresh-adopted-source-secrets-evidence' as const,
    identity: expected, candidateDigest: canonicalDigest(candidate), artifactDigest: candidate.artifact.sha256,
    sourceCommit: candidate.source.commit, sourceReportDigest: bound.sourceReportDigest,
    scopeDigest: canonicalDigest(options.expectedScope),
    startedAt: options.result.observedAt, completedAt: options.result.completedAt,
    adoptedPolicyCommit: bound.verdict.authorityCommit, adoptedPolicyDigest: bound.verdict.authorityPolicyDigest,
    complete: true, findingPolicy: 'passed' as const, observedFindings: bound.findings.length,
    blockedFindings: 0, policyDiagnostics: 0, confirmedUnremediated: 0,
    currentTreeComplete: true, declaredHistoryComplete: true, cleanup: 'completed' as const,
    admissionEvidenceUsed: false, publicationAuthorized: false
  };
}
