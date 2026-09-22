import {
  adoptedBaseIdentity, canonicalDigest, readAdoptedControl, readAdoptedPolicyData, type AdoptedBaseHandle
} from './admission.ts';
import {
  evaluateSecurityReport, findingDigest, identifier, parseSecurityReport, parseVulnerabilityException,
  record, SecurityEvidenceError, text, type SecurityReport, type Severity, type VulnerabilityException
} from './evidence.ts';

const vulnerabilityTools = ['CodeQL', 'osv-scanner', 'trivy'] as const;
const policyPath = ['security', 'finding-policy.json'];

function fail(code: string): never { throw new SecurityEvidenceError(code); }
function json(source: string): unknown {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 256 * 1024) fail('finding-policy-size');
  try { return JSON.parse(source); } catch { return fail('finding-policy-json'); }
}

export function parseRepositoryFindingPolicy(source: string) {
  const value = record(json(source), [
    'schemaVersion', 'repository', 'triageOwner', 'blockingVulnerabilitySeverities',
    'lowerSeverityHandling', 'unknownClassification', 'npmPolicy', 'secretsPolicy', 'policyRules'
  ], 'finding-policy-schema');
  if (value.schemaVersion !== 1 || value.repository !== 'voyager163/liftoff' ||
      value.triageOwner !== 'voyager163' ||
      canonicalDigest(value.blockingVulnerabilitySeverities) !== canonicalDigest(['high', 'critical']) ||
      value.lowerSeverityHandling !== 'owner-bound-triage' || value.unknownClassification !== 'error' ||
      value.npmPolicy !== 'existing-exact-exception-for-every-finding' ||
      value.secretsPolicy !== 'independent-disposition-no-vulnerability-waiver') fail('finding-policy-invariant');
  if (!Array.isArray(value.policyRules) || value.policyRules.length === 0 || value.policyRules.length > 256) {
    fail('finding-policy-rule-inventory');
  }
  const policyRules = value.policyRules.map(entry => {
    const rule = record(entry, ['tool', 'rule', 'classification', 'reviewPriority', 'rationale'], 'finding-policy-rule');
    const checkov = rule.tool === 'checkov' && typeof rule.rule === 'string' && /^CKV2?_[A-Z][A-Z0-9]+_[0-9]+$/.test(rule.rule);
    const unscored = rule.tool === 'osv-scanner' && rule.rule === 'osv-valid-unscored-advisory' && rule.reviewPriority === 'high';
    const trivyUnscored = rule.tool === 'trivy' && rule.rule === 'trivy-valid-native-unscored-advisory' && rule.reviewPriority === 'high';
    if ((!checkov && !unscored && !trivyUnscored) || rule.classification !== 'blocking-policy' ||
        (rule.reviewPriority !== 'high' && rule.reviewPriority !== 'critical') ||
        typeof rule.rule !== 'string') fail('finding-policy-rule');
    return Object.freeze({
      tool: rule.tool === 'checkov' ? 'checkov' as const : trivyUnscored ? 'trivy' as const : 'osv-scanner' as const,
      rule: identifier(rule.rule, 'finding-policy-rule'),
      classification: 'blocking-policy' as const, reviewPriority: rule.reviewPriority,
      rationale: text(rule.rationale, 'finding-policy-rationale')
    });
  });
  if (new Set(policyRules.map(rule => rule.rule)).size !== policyRules.length) fail('finding-policy-rule-inventory');
  return Object.freeze({
    repository: 'voyager163/liftoff' as const, triageOwner: 'voyager163' as const,
    policyRules: Object.freeze(policyRules)
  });
}

export interface AdoptedFindingPolicy { readonly kind: 'adopted-finding-policy'; }
const adopted = new WeakMap<AdoptedFindingPolicy, {
  policy: ReturnType<typeof parseRepositoryFindingPolicy>;
  identity: ReturnType<typeof adoptedBaseIdentity>;
  exceptions: VulnerabilityException[];
}>();

/** Candidate JSON can be inspected, but only independently loaded base data issues this handle. */
export async function loadAdoptedFindingPolicy(base: AdoptedBaseHandle): Promise<AdoptedFindingPolicy> {
  const policy = parseRepositoryFindingPolicy(await readAdoptedControl(base, policyPath));
  const data = record(json(readAdoptedPolicyData(base, 'vulnerability-exceptions')),
    ['schemaVersion', 'exceptions'], 'finding-policy-exceptions');
  if (data.schemaVersion !== 1 || !Array.isArray(data.exceptions) || data.exceptions.length > 10_000) {
    fail('finding-policy-exceptions');
  }
  const exceptions = data.exceptions.map(parseVulnerabilityException);
  if (new Set(exceptions.map(item => item.findingDigest)).size !== exceptions.length) fail('duplicate-exception');
  const handle: AdoptedFindingPolicy = Object.freeze({ kind: 'adopted-finding-policy' });
  adopted.set(handle, { policy, identity: adoptedBaseIdentity(base), exceptions });
  return handle;
}

type ExpectedReport = Pick<SecurityReport, 'identity' | 'role' | 'tool' | 'units'>;

function parseReport(value: SecurityReport): SecurityReport {
  try { return parseSecurityReport(JSON.stringify(value)); }
  catch (error) {
    if (error instanceof SecurityEvidenceError) throw error;
    return fail('finding-report-invalid');
  }
}

/**
 * Assesses the complete declared non-npm report set. npm and secrets must pass
 * their own existing evaluators; this result is neither admission nor publication.
 */
export function evaluateRepositoryFindingReports(
  handle: AdoptedFindingPolicy, inputs: readonly SecurityReport[], expected: readonly ExpectedReport[], now: Date
) {
  const state = adopted.get(handle);
  if (!state) fail('unverified-finding-policy');
  if (!Array.isArray(inputs) || !Array.isArray(expected) || inputs.length === 0 ||
      inputs.length > 256 || inputs.length !== expected.length) fail('finding-report-set-coverage');
  const reports = inputs.map(parseReport);
  const identities = reports.map(({ identity }) => canonicalDigest({
    repository: identity.repository, event: identity.event, sourceSha: identity.sourceSha,
    baseSha: identity.baseSha, workflowSha: identity.workflowSha, runId: identity.runId,
    attempt: identity.attempt, policyDigest: identity.policyDigest
  }));
  if (new Set(identities).size !== 1 || reports.some(report =>
    report.identity.repository !== state.policy.repository ||
    report.identity.baseSha !== state.identity.baseCommit ||
    ![state.identity.baseCommit, state.identity.testedCommit].includes(report.identity.sourceSha) ||
    report.identity.policyDigest !== state.identity.policyDigest)) fail('finding-policy-identity-mismatch');
  const producers = expected.map((report: ExpectedReport) => canonicalDigest({
    role: report.role, tool: report.tool, units: report.units.map(unit => unit.id).sort()
  }));
  if (new Set(producers).size !== producers.length) fail('duplicate-finding-producer');
  const findings = reports.flatMap(report => report.findings);
  if (findings.length > 10_000) fail('finding-report-set-size');
  const findingKeys = findings.map(findingDigest);
  if (new Set(findingKeys).size !== findingKeys.length) fail('duplicate-finding');
  if (state.exceptions.some(exception => !findingKeys.includes(exception.findingDigest))) fail('stale-exception');
  const result = {
    scope: 'declared-non-npm-report-set' as const, passed: true,
    adoptedBaseCommit: state.identity.baseCommit, policyDigest: state.identity.policyDigest,
    blocking: [] as { reportIndex: number; id: string }[],
    reviewed: [] as { reportIndex: number; id: string }[],
    tracked: [] as { reportIndex: number; id: string; owner: string; severity: Severity }[],
    npmAssessed: false, secretsAssessed: false, admissionQualified: false, publicationQualified: false
  };
  reports.forEach((report, reportIndex) => {
    const vulnerabilityTool = vulnerabilityTools.some(tool => tool === report.tool.name);
    if (!vulnerabilityTool && report.tool.name !== 'checkov') fail('finding-tool-requires-separate-policy');
    for (const finding of report.findings) {
      if (finding.tool !== report.tool.name) fail('finding-tool-mismatch');
      if (finding.kind === 'policy') {
        const mapping = state.policy.policyRules.find(rule => rule.tool === finding.tool &&
          rule.rule === (finding.policyClass ?? finding.rule));
        if (!mapping) fail('unmapped-policy-rule');
        if (finding.kind !== 'policy' || finding.severity !== mapping.reviewPriority) fail('finding-classification-mismatch');
      } else if (!vulnerabilityTool) fail('finding-classification-mismatch');
    }
    const keys = new Set(report.findings.map(findingDigest));
    const verdict = evaluateSecurityReport(report, expected[reportIndex]!, {
      blockingRules: state.policy.policyRules.map(({ tool, rule }) => ({ tool, rule })),
      exceptions: state.exceptions.filter(exception => keys.has(exception.findingDigest))
    }, now);
    result.blocking.push(...verdict.blocking.map(id => ({ reportIndex, id })));
    result.reviewed.push(...verdict.reviewed.map(id => ({ reportIndex, id })));
    result.tracked.push(...verdict.tracked.map(id => ({
      reportIndex, id, owner: state.policy.triageOwner, severity: report.findings.find(finding => finding.id === id)!.severity
    })));
  });
  result.passed = result.blocking.length === 0;
  return result;
}
