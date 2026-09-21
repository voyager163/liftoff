import {
  digest, evaluateSecurityReport, findingDigest, identifier, parseIdentity, parseSecurityReport,
  record, SecurityEvidenceError, type EvidenceIdentity, type Policy, type SecurityReport, type Severity
} from './evidence.ts';

export const REPORTING_LIMITS = Object.freeze({
  inputBytes: 4 * 1024 * 1024, outputBytes: 16 * 1024 * 1024,
  nodes: 100_000, producers: 128, controls: 128, findings: 10_000, maxAgeSeconds: 86_400
});

export type ReportingPolicy = 'repository-findings' | 'npm-exact-exceptions' | 'independent-secrets';
export type IncompleteAnalysis = 'missing' | 'skipped' | 'cancelled' | 'error';
type ExpectedReport = Pick<SecurityReport, 'identity' | 'role' | 'tool' | 'units'>;

export interface ReportingProducerExpectation extends ExpectedReport {
  id: string;
  owner: string;
  policy: ReportingPolicy;
  /** Independently retained exact finding digests, or null when no comparison is available. */
  previousFindingDigests: readonly string[] | null;
}

export interface ReportingControlExpectation {
  id: string;
  owner: string;
  required: boolean;
  configurationDigest: string;
}

export interface ReportingExpectations {
  identity: EvidenceIdentity;
  producers: readonly ReportingProducerExpectation[];
  controls: readonly ReportingControlExpectation[];
  blockingRules: Policy['blockingRules'];
}

export interface ReportedFindingAssessment {
  status: 'passed' | 'blocked' | 'error';
  blocking: readonly string[];
  reviewed: readonly string[];
  tracked: readonly { id: string; owner: string }[];
}

export interface ReportedSecretFinding {
  id: string;
  findingDigest: string;
  scope: string;
  artifactDigest: string;
  rule: string;
  owner: string;
  disposition: 'unresolved' | 'confirmed-unremediated' | 'reviewed-false-positive' | 'reviewed-fixture' | 'remediated';
}

/** Already redacted metadata from the independent secrets evaluator, never detector output. */
export interface SecretReportingEvidence extends Omit<SecurityReport, 'findings'> {
  findings: ReportedSecretFinding[];
}

export type ReportingProducerOutcome =
  | { id: string; analysis: IncompleteAnalysis; identity: EvidenceIdentity; observedAt: string }
  | {
    id: string;
    analysis: 'complete';
    report: SecurityReport | SecretReportingEvidence;
    assessment: ReportedFindingAssessment | null;
  };

export interface ReportingCapabilityObservation {
  id: string;
  identity: EvidenceIdentity;
  observedAt: string;
  available: 'available' | 'unavailable' | 'inapplicable' | 'unknown';
  configured: boolean | null;
  executed: boolean | null;
  passed: boolean | null;
  /** Local reporting cannot authenticate hosted behavior/readback; true is deliberately unsupported. */
  enforced: false | null;
  configurationDigest: string | null;
}

export interface ReportedAdmission {
  identity: EvidenceIdentity;
  observedAt: string;
  mode: 'normal' | 'policy-maintenance';
  status: 'passed' | 'blocked' | 'error';
  evidenceDigest: string;
}

export interface ReportingObservations {
  producers: readonly ReportingProducerOutcome[];
  capabilities: readonly ReportingCapabilityObservation[];
  admission: ReportedAdmission | null;
}

type FindingSummary = {
  id: string; findingDigest: string; owner: string; scope: string; rule: string;
  kind: 'vulnerability' | 'policy' | 'secret'; severity: Severity | null;
  policyClass: 'osv-valid-unscored-advisory' | 'trivy-valid-native-unscored-advisory' | null;
  upstreamSeverity: 'unscored' | 'UNKNOWN' | null;
  disposition: 'blocking' | 'reviewed' | 'tracked' | 'unassessed' | ReportedSecretFinding['disposition'];
  disclosure: 'new' | 'previously-observed' | 'not-compared';
};

type Notification = {
  owner: string; subject: 'producer' | 'finding' | 'control'; id: string;
  producerId: string | null; findingDigest: string | null;
  reason: 'analysis-incomplete' | 'assessment-incomplete' | 'blocking-finding' | 'lower-severity-triage'
    | 'scheduled-new-disclosure' | 'scheduled-failure' | 'capability-unqualified' | 'configuration-drift';
  action: 'rerun-exact-scope' | 'review-adopted-policy-result' | 'triage-exact-finding'
    | 'credential-owner-remediation' | 'obtain-capability-evidence' | 'review-control-drift';
  delivery: 'not-sent';
};

function fail(code: string): never { throw new SecurityEvidenceError(code); }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const ordered = <T extends { id: string }>(items: T[]): T[] => items.sort((a, b) => compare(a.id, b.id));

function choice<const T extends string>(value: unknown, choices: readonly T[], code: string): T {
  return choices.find(item => item === value) ?? fail(code);
}

function list(value: unknown, maximum: number, code: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return fail(code);
  return value;
}

function unique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) fail(code);
}

/*
 * Accept plain bounded data only. In particular, never invoke toJSON, getters,
 * or a caller's Error formatter while constructing public summaries/diagnostics.
 */
function plainData(value: unknown, budget: { bytes: number; nodes: number }, depth = 0): unknown {
  if (++budget.nodes > REPORTING_LIMITS.nodes || depth > 24) fail('reporting-input-limit');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('reporting-input-shape');
    return value;
  }
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value);
    if (value.length > 500 || budget.bytes > REPORTING_LIMITS.inputBytes) fail('reporting-input-limit');
    return value;
  }
  if (typeof value !== 'object') return fail('reporting-input-shape');
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    fail('reporting-input-shape');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > REPORTING_LIMITS.nodes - budget.nodes) fail('reporting-input-limit');
  if (array) {
    if (value.length > REPORTING_LIMITS.findings || keys.length !== value.length + 1) fail('reporting-input-shape');
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const property = Object.getOwnPropertyDescriptor(value, String(index));
      if (!property?.enumerable || !('value' in property)) fail('reporting-input-shape');
      result.push(plainData(property.value, budget, depth + 1));
    }
    return result;
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || key.length > 200) fail('reporting-input-shape');
    budget.bytes += Buffer.byteLength(key);
    if (budget.bytes > REPORTING_LIMITS.inputBytes) fail('reporting-input-limit');
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property?.enumerable || !('value' in property)) fail('reporting-input-shape');
    result[key] = plainData(property.value, budget, depth + 1);
  }
  return result;
}

function safeData(value: unknown, budget: { bytes: number; nodes: number }): unknown {
  try { return plainData(value, budget); }
  catch (error) {
    let oversized = false;
    try { oversized = error instanceof SecurityEvidenceError && error.code === 'reporting-input-limit'; } catch { /* Untrusted proxy. */ }
    return fail(oversized ? 'reporting-input-limit' : 'reporting-input-shape');
  }
}

function timestamp(value: unknown, now: Date): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('invalid-time');
  const age = now.getTime() - Date.parse(value);
  if (age < 0 || age > REPORTING_LIMITS.maxAgeSeconds * 1000) fail('stale-evidence');
  return value;
}

function sameIdentity(actual: EvidenceIdentity, expected: EvidenceIdentity): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('identity-mismatch');
}

function parseExpected(value: unknown): ReportingExpectations {
  const item = record(value, ['identity', 'producers', 'controls', 'blockingRules'], 'reporting-expectations');
  const identity = parseIdentity(item.identity);
  const producers = list(item.producers, REPORTING_LIMITS.producers, 'reporting-producers').map(value => {
    const producer = record(value, [
      'id', 'owner', 'policy', 'identity', 'role', 'tool', 'units', 'previousFindingDigests'
    ], 'reporting-producer-expectation');
    // Reuse the existing exact tool, coverage, identity and portable-parts contract.
    const envelope = parseSecurityReport(JSON.stringify({
      schemaVersion: 1, role: producer.role, identity: producer.identity, tool: producer.tool, units: producer.units,
      generatedAt: '2000-01-01T00:00:00.000Z', completedAt: '2000-01-01T00:00:00.000Z', complete: true, findings: []
    }));
    sameIdentity({ ...envelope.identity, inventoryDigest: identity.inventoryDigest,
      configurationDigest: identity.configurationDigest }, identity);
    const policy = choice(producer.policy, [
      'repository-findings', 'npm-exact-exceptions', 'independent-secrets'
    ], 'reporting-policy');
    const tools = policy === 'repository-findings' ? ['CodeQL', 'checkov', 'osv-scanner', 'trivy']
      : policy === 'npm-exact-exceptions' ? ['npm'] : ['gitleaks', 'github-secret-scanning'];
    if (!tools.includes(envelope.tool.name)) fail('finding-tool-requires-separate-policy');
    const previousFindingDigests = producer.previousFindingDigests === null ? null
      : list(producer.previousFindingDigests, REPORTING_LIMITS.findings, 'reporting-history').map(digest).sort(compare);
    if (previousFindingDigests) unique(previousFindingDigests, 'duplicate-finding');
    return {
      id: identifier(producer.id, 'invalid-producer-id'), owner: identifier(producer.owner, 'missing-owner'),
      policy, identity: envelope.identity, role: envelope.role, tool: envelope.tool,
      units: ordered(envelope.units), previousFindingDigests
    };
  });
  if (producers.length === 0) fail('reporting-producers');
  unique(producers.map(item => item.id), 'duplicate-producer');
  unique(producers.map(item => JSON.stringify({
    identity: item.identity, role: item.role, tool: item.tool, units: item.units
  })), 'duplicate-producer');
  const controls = list(item.controls, REPORTING_LIMITS.controls, 'reporting-controls').map(value => {
    const control = record(value, ['id', 'owner', 'required', 'configurationDigest'], 'reporting-control-expectation');
    if (typeof control.required !== 'boolean') fail('reporting-control-expectation');
    return {
      id: identifier(control.id, 'invalid-control-id'), owner: identifier(control.owner, 'missing-owner'),
      required: control.required, configurationDigest: digest(control.configurationDigest)
    };
  });
  unique(controls.map(item => item.id), 'duplicate-control');
  const blockingRules = list(item.blockingRules, 256, 'invalid-policy-rule').map(value => {
    const rule = record(value, ['tool', 'rule'], 'invalid-policy-rule');
    return { tool: identifier(rule.tool, 'invalid-tool'), rule: identifier(rule.rule, 'invalid-rule') };
  });
  unique(blockingRules.map(rule => `${rule.tool}\0${rule.rule}`), 'duplicate-policy-rule');
  return { identity, producers: ordered(producers), controls: ordered(controls), blockingRules };
}

function parseAssessment(value: unknown, ids: readonly string[]): ReportedFindingAssessment | null {
  if (value === null) return null;
  const item = record(value, ['status', 'blocking', 'reviewed', 'tracked'], 'reporting-assessment');
  const status = choice(item.status, ['passed', 'blocked', 'error'], 'reporting-assessment');
  const parseIds = (value: unknown) => list(value, REPORTING_LIMITS.findings, 'reporting-assessment')
    .map(id => identifier(id, 'invalid-finding-id')).sort(compare);
  const blocking = parseIds(item.blocking), reviewed = parseIds(item.reviewed);
  const tracked = ordered(list(item.tracked, REPORTING_LIMITS.findings, 'reporting-assessment').map(value => {
    const finding = record(value, ['id', 'owner'], 'reporting-assessment');
    return { id: identifier(finding.id, 'invalid-finding-id'), owner: identifier(finding.owner, 'missing-owner') };
  }));
  const assessed = [...blocking, ...reviewed, ...tracked.map(item => item.id)];
  unique(assessed, 'duplicate-finding');
  if (status === 'error' ? assessed.length !== 0
    : assessed.length !== ids.length || assessed.some(id => !ids.includes(id)) ||
      (status === 'passed') !== (blocking.length === 0)) fail('reporting-assessment-mismatch');
  return { status, blocking, reviewed, tracked };
}

function parseSecret(value: unknown): ReportedSecretFinding {
  const item = record(value, [
    'id', 'findingDigest', 'scope', 'artifactDigest', 'rule', 'owner', 'disposition'
  ], 'reporting-secret-finding');
  return {
    id: identifier(item.id, 'invalid-finding-id'), findingDigest: digest(item.findingDigest),
    scope: identifier(item.scope, 'invalid-scope'), artifactDigest: digest(item.artifactDigest),
    rule: identifier(item.rule, 'invalid-rule'), owner: identifier(item.owner, 'missing-owner'),
    disposition: choice(item.disposition, [
      'unresolved', 'confirmed-unremediated', 'reviewed-false-positive', 'reviewed-fixture', 'remediated'
    ], 'invalid-secret-disposition')
  };
}

function producerSummary(
  value: unknown | undefined, expected: ReportingProducerExpectation, blockingRules: Policy['blockingRules'], now: Date
) {
  const identity = expected.identity;
  const base = { id: expected.id, owner: expected.owner, policy: expected.policy, identity,
    role: expected.role, tool: expected.tool, units: expected.units };
  if (value === undefined) return {
    ...base, analysis: 'missing' as const, generatedAt: null, completedAt: null,
    reportedFindingsStatus: 'not-evaluated' as const, findingCount: null, findings: [] as FindingSummary[]
  };
  const header = value as Record<string, unknown>;
  if (header.analysis !== 'complete') {
    const item = record(value, ['id', 'analysis', 'identity', 'observedAt'], 'reporting-producer-outcome');
    const analysis = choice(item.analysis, ['missing', 'skipped', 'cancelled', 'error'], 'reporting-analysis');
    sameIdentity(parseIdentity(item.identity), identity);
    return {
      ...base, analysis, generatedAt: null, completedAt: timestamp(item.observedAt, now),
      reportedFindingsStatus: 'not-evaluated' as const, findingCount: null, findings: [] as FindingSummary[]
    };
  }
  const item = record(value, ['id', 'analysis', 'report', 'assessment'], 'reporting-producer-outcome');
  const secret = expected.policy === 'independent-secrets';
  const raw = record(item.report, [
    'schemaVersion', 'role', 'identity', 'tool', 'generatedAt', 'completedAt', 'complete', 'units', 'findings'
  ], 'invalid-report');
  const secrets = secret ? list(raw.findings, REPORTING_LIMITS.findings, 'invalid-findings').map(parseSecret) : [];
  const report = parseSecurityReport(JSON.stringify(secret ? { ...raw, findings: [] } : raw));
  timestamp(report.generatedAt, now);
  timestamp(report.completedAt, now);
  const baseline = evaluateSecurityReport(report, expected, { blockingRules, exceptions: [] }, now);
  unique(secrets.map(finding => finding.id), 'duplicate-finding');
  unique(secrets.map(finding => finding.findingDigest), 'duplicate-finding');
  if (secrets.some(finding => !report.units.some(unit =>
    unit.id === finding.scope && unit.inputDigest === finding.artifactDigest))) fail('finding-outside-coverage');
  const ids = secret ? secrets.map(finding => finding.id) : report.findings.map(finding => finding.id);
  const assessment = parseAssessment(item.assessment, ids);
  const assessed = assessment !== null && assessment.status !== 'error';
  const tracked = new Map(assessment?.tracked.map(item => [item.id, item.owner]));
  if (assessment?.tracked.some(item => item.owner !== expected.owner)) fail('reporting-triage-owner-mismatch');
  if (expected.policy === 'npm-exact-exceptions' && report.findings.some(finding => finding.kind !== 'vulnerability')) {
    fail('finding-tool-requires-separate-policy');
  }
  if (assessed) {
    if (expected.policy !== 'repository-findings' && tracked.size !== 0) fail('finding-tool-requires-separate-policy');
    if (baseline.blocking.some(id => tracked.has(id))) fail('reporting-assessment-mismatch');
    for (const finding of secrets) {
      const blocking = finding.disposition === 'unresolved' || finding.disposition === 'confirmed-unremediated';
      if (blocking !== assessment.blocking.includes(finding.id)) fail('reporting-secret-disposition-mismatch');
    }
  }
  const previous = expected.previousFindingDigests === null ? null : new Set(expected.previousFindingDigests);
  const disclosure = (key: string): FindingSummary['disclosure'] =>
    previous === null ? 'not-compared' : previous.has(key) ? 'previously-observed' : 'new';
  const findings: FindingSummary[] = secret ? secrets.map(finding => ({
    id: finding.id, findingDigest: finding.findingDigest, owner: finding.owner, scope: finding.scope,
    rule: finding.rule, kind: 'secret', severity: null, disposition: finding.disposition,
    policyClass: null, upstreamSeverity: null,
    disclosure: disclosure(finding.findingDigest)
  })) : report.findings.map(finding => {
    const key = findingDigest(finding);
    return {
      id: finding.id, findingDigest: key, owner: tracked.get(finding.id) ?? finding.owner,
      scope: finding.scope, rule: finding.rule, kind: finding.kind, severity: finding.severity,
      policyClass: finding.policyClass ?? null, upstreamSeverity: finding.upstreamSeverity ?? null,
      disposition: !assessed ? 'unassessed' : assessment.blocking.includes(finding.id) ? 'blocking'
        : assessment.reviewed.includes(finding.id) ? 'reviewed' : 'tracked',
      disclosure: disclosure(key)
    };
  });
  return {
    ...base, analysis: 'complete' as const, generatedAt: report.generatedAt, completedAt: report.completedAt,
    reportedFindingsStatus: assessment?.status ?? 'not-evaluated', findingCount: findings.length,
    findings: ordered(findings)
  };
}

function nullableBoolean(value: unknown): boolean | null {
  if (value !== null && typeof value !== 'boolean') fail('reporting-capability');
  return value;
}

function capabilitySummary(
  value: unknown | undefined, expected: ReportingControlExpectation, identity: EvidenceIdentity, now: Date
) {
  let observedAt: string | null = null;
  let available: ReportingCapabilityObservation['available'] = 'unknown';
  let configured: boolean | null = null, executed: boolean | null = null, passed: boolean | null = null;
  let enforced: false | null = null, configurationDigest: string | null = null;
  if (value !== undefined) {
    const item = record(value, [
      'id', 'identity', 'observedAt', 'available', 'configured', 'executed', 'passed', 'enforced', 'configurationDigest'
    ], 'reporting-capability');
    sameIdentity(parseIdentity(item.identity), identity);
    observedAt = timestamp(item.observedAt, now);
    available = choice(item.available, ['available', 'unavailable', 'inapplicable', 'unknown'], 'reporting-capability');
    configured = nullableBoolean(item.configured);
    executed = nullableBoolean(item.executed);
    passed = nullableBoolean(item.passed);
    if (item.enforced !== false && item.enforced !== null) fail('reporting-enforcement-unverified');
    enforced = item.enforced;
    configurationDigest = item.configurationDigest === null ? null : digest(item.configurationDigest);
    if (passed === true && executed !== true || configured === true && configurationDigest === null ||
        (available === 'unavailable' || available === 'inapplicable') &&
        (configured === true || executed === true || passed === true)) fail('reporting-capability-inconsistent');
  }
  return {
    id: expected.id, owner: expected.owner, required: expected.required, observedAt,
    available, configured, executed, passed, enforced,
    expectedConfigurationDigest: expected.configurationDigest, observedConfigurationDigest: configurationDigest,
    drift: configurationDigest === null ? 'not-observed' as const
      : configurationDigest === expected.configurationDigest ? 'unchanged' as const : 'changed' as const,
    enforcementQualification: 'not-performed' as const,
    attention: expected.required ? 'blocker' as const : 'limitation' as const
  };
}

function indexObservations(value: unknown, expected: readonly { id: string }[], maximum: number, code: string) {
  const result = new Map<string, unknown>();
  for (const entry of list(value, maximum, code)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail(code);
    const id = identifier((entry as Record<string, unknown>).id, code);
    if (result.has(id)) fail('duplicate-identity');
    if (!expected.some(item => item.id === id)) fail('unexpected-identity');
    result.set(id, entry);
  }
  return result;
}

function build(expectedValue: unknown, actualValue: unknown, now: Date) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('invalid-time');
  const budget = { bytes: 0, nodes: 0 };
  const expected = parseExpected(safeData(expectedValue, budget));
  const actual = record(safeData(actualValue, budget), ['producers', 'capabilities', 'admission'], 'reporting-observations');
  const outcomes = indexObservations(actual.producers, expected.producers, REPORTING_LIMITS.producers, 'reporting-producers');
  const observations = indexObservations(actual.capabilities, expected.controls, REPORTING_LIMITS.controls, 'reporting-controls');
  const producers = expected.producers.map(producer => producerSummary(outcomes.get(producer.id), producer, expected.blockingRules, now));
  const capabilities = expected.controls.map(control => capabilitySummary(observations.get(control.id), control, expected.identity, now));
  const findings = producers.flatMap(producer => producer.findings);
  if (findings.length > REPORTING_LIMITS.findings) fail('reporting-finding-limit');
  unique(findings.map(finding => finding.findingDigest), 'duplicate-finding');
  const analysisComplete = producers.every(producer => producer.analysis === 'complete');
  const findingsStatus = producers.some(producer => producer.reportedFindingsStatus === 'error') ? 'error' as const
    : producers.some(producer => producer.reportedFindingsStatus === 'not-evaluated') ? 'incomplete' as const
    : producers.some(producer => producer.reportedFindingsStatus === 'blocked') ? 'blocked' as const : 'passed' as const;
  let admission: ReportedAdmission | null = null;
  if (actual.admission !== null) {
    const item = record(actual.admission, ['identity', 'observedAt', 'mode', 'status', 'evidenceDigest'], 'reporting-admission');
    const identity = parseIdentity(item.identity);
    sameIdentity(identity, expected.identity);
    admission = {
      identity, observedAt: timestamp(item.observedAt, now),
      mode: choice(item.mode, ['normal', 'policy-maintenance'], 'reporting-admission'),
      status: choice(item.status, ['passed', 'blocked', 'error'], 'reporting-admission'),
      evidenceDigest: digest(item.evidenceDigest)
    };
    if (admission.status === 'passed' && (!analysisComplete || findingsStatus === 'incomplete' || findingsStatus === 'error' ||
        admission.mode === 'normal' && findingsStatus !== 'passed' ||
        findings.some(finding => finding.disposition === 'confirmed-unremediated'))) fail('reporting-admission-inconsistent');
  }
  const notifications: Notification[] = [];
  const scheduled = expected.identity.event === 'schedule';
  for (const producer of producers) {
    const notify = (reason: Notification['reason'], action: Notification['action'], finding?: FindingSummary) =>
      notifications.push({
        owner: finding?.owner ?? producer.owner, subject: finding ? 'finding' : 'producer',
        id: finding?.id ?? producer.id, producerId: producer.id, findingDigest: finding?.findingDigest ?? null,
        reason, action, delivery: 'not-sent'
      });
    if (producer.analysis !== 'complete') notify('analysis-incomplete', 'rerun-exact-scope');
    else if (producer.reportedFindingsStatus === 'error' || producer.reportedFindingsStatus === 'not-evaluated') {
      notify('assessment-incomplete', 'review-adopted-policy-result');
    }
    if (scheduled && producer.reportedFindingsStatus !== 'passed') notify('scheduled-failure', 'rerun-exact-scope');
    for (const finding of producer.findings) {
      const action = finding.kind === 'secret' ? 'credential-owner-remediation' : 'triage-exact-finding';
      if (['blocking', 'unresolved', 'confirmed-unremediated'].includes(finding.disposition)) {
        notify('blocking-finding', action, finding);
      }
      if (finding.disposition === 'tracked') notify('lower-severity-triage', action, finding);
      if (scheduled && finding.disclosure === 'new') notify('scheduled-new-disclosure', action, finding);
    }
  }
  for (const control of capabilities) {
    notifications.push({
      owner: control.owner, subject: 'control', id: control.id, producerId: null, findingDigest: null,
      reason: control.drift === 'changed' ? 'configuration-drift' : 'capability-unqualified',
      action: control.drift === 'changed' ? 'review-control-drift' : 'obtain-capability-evidence', delivery: 'not-sent'
    });
  }
  notifications.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  return {
    schemaVersion: 1 as const, kind: 'local-security-reporting-summary' as const,
    identity: expected.identity, reportedAt: now.toISOString(),
    authority: {
      producerAuthentication: 'not-performed', activeExceptionGrant: 'none', admissionDecision: 'not-issued',
      releaseReceipt: 'not-issued', publicationAuthorization: 'none', hostedEnforcement: 'not-qualified'
    } as const,
    policyBoundaries: {
      npm: 'existing-exact-exception-for-every-finding', secrets: 'independent-disposition-no-vulnerability-waiver',
      reviewedFindings: 'reported-only-not-an-active-grant'
    } as const,
    analysis: { status: analysisComplete ? 'complete' as const : 'incomplete' as const,
      expectedCount: producers.length, completeCount: producers.filter(producer => producer.analysis === 'complete').length },
    actualFindings: { reportedStatus: findingsStatus, observedCount: findings.length,
      coverageComplete: analysisComplete && findingsStatus !== 'incomplete' && findingsStatus !== 'error' },
    producers, capabilities, reportedAdmission: admission, notifications,
    recurrence: {
      status: !scheduled ? 'not-scheduled' as const
        : notifications.length > 0 ? 'owner-action-required' as const : 'reported-pass' as const,
      newDisclosureCount: scheduled ? findings.filter(finding => finding.disclosure === 'new').length : 0,
      releaseRequirement: 'fresh-passing-exact-release-attempt-qualification-required' as const,
      historicalScheduleSuccess: 'not-publication-authorization' as const
    }
  };
}

export type RepositorySecuritySummary = ReturnType<typeof build>;

// Identifiers are allowlisted by evidence.ts; encode Markdown punctuation as well.
const cell = (value: string | number | boolean | null) => value === null ? 'unknown'
  : String(value).replace(/[^A-Za-z0-9 -]/g, char => `&#${char.charCodeAt(0)};`);

function markdown(summary: RepositorySecuritySummary): string {
  const lines = [
    '# Local security reporting',
    '',
    'Reporting only: no producer authentication, active exception grant, admission decision, release receipt or publication authorization.',
    'Fresh passing qualification for the exact release attempt is required. Historical scheduled success is not publication authorization.',
    'Reviewed findings are reported observations, not active grants. Secrets use independent disposition, not vulnerability exception windows.',
    '',
    `Repository: ${cell(summary.identity.repository)}; source: ${cell(summary.identity.sourceSha)}; run: ${cell(summary.identity.runId)}; attempt: ${summary.identity.attempt}.`,
    `Analysis: ${summary.analysis.status}; actual findings: ${summary.actualFindings.reportedStatus}.`,
    `Reported admission: ${summary.reportedAdmission?.mode ?? 'not-supplied'} / ${summary.reportedAdmission?.status ?? 'not-supplied'}.`,
    '',
    '| Producer | Owner | Analysis | Reported findings | Observed count |',
    '| --- | --- | --- | --- | --- |',
    ...summary.producers.map(producer => `| ${cell(producer.id)} | ${cell(producer.owner)} | ${producer.analysis} | ${producer.reportedFindingsStatus} | ${cell(producer.findingCount)} |`),
    '',
    '| Producer | Finding | Digest | Scope | Rule | Owner | Kind | Severity or priority | Policy class | Upstream severity | Disposition | Disclosure |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summary.producers.flatMap(producer => producer.findings.map(finding =>
      `| ${cell(producer.id)} | ${cell(finding.id)} | ${cell(finding.findingDigest)} | ${cell(finding.scope)} | ${cell(finding.rule)} | ${cell(finding.owner)} | ${finding.kind} | ${cell(finding.severity)} | ${cell(finding.policyClass)} | ${cell(finding.upstreamSeverity)} | ${finding.disposition} | ${finding.disclosure} |`)),
    '',
    'Hosted enforcement is not qualified by this local reporter. Required evidence gaps are blockers; optional gaps are limitations.',
    '',
    '| Control | Owner | Available | Configured | Executed | Passed | Enforced | Drift | Attention |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summary.capabilities.map(control =>
      `| ${cell(control.id)} | ${cell(control.owner)} | ${control.available} | ${cell(control.configured)} | ${cell(control.executed)} | ${cell(control.passed)} | ${cell(control.enforced)} | ${control.drift} | ${control.attention} |`),
    '',
    'Owner actions below are local metadata only; no notifications have been sent.',
    '',
    '| Owner | Subject | Identity | Producer | Reason | Action |',
    '| --- | --- | --- | --- | --- | --- |',
    ...summary.notifications.map(notification =>
      `| ${cell(notification.owner)} | ${notification.subject} | ${cell(notification.id)} | ${cell(notification.producerId)} | ${notification.reason} | ${notification.action} |`)
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Pure, non-authoritative presentation of already evaluated, sanitized outcomes.
 * The caller must independently obtain trusted expectations and authenticate
 * producers, adopted policy/evaluations, and any historical comparison. Passing
 * this structural check does none of those things and cannot authorize release.
 * No exceptions, credentials, prose diagnostics, raw scanner output or paths are
 * accepted as summary fields. This local foundation intentionally rejects every
 * positive hosted-enforcement claim until a separate qualification layer exists.
 */
export function reportRepositorySecurity(
  expected: ReportingExpectations, observations: ReportingObservations, now: Date
): { summary: RepositorySecuritySummary; json: string; markdown: string } {
  try {
    const summary = build(expected, observations, new Date(Date.prototype.getTime.call(now)));
    const json = `${JSON.stringify(summary, null, 2)}\n`;
    const rendered = markdown(summary);
    if (Buffer.byteLength(json) + Buffer.byteLength(rendered) > REPORTING_LIMITS.outputBytes) fail('reporting-output-limit');
    return { summary, json, markdown: rendered };
  } catch (error) {
    if (error instanceof SecurityEvidenceError) throw error;
    return fail('reporting-input-shape');
  }
}
