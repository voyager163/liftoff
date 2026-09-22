import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  findingDigest, SecurityEvidenceError, type EvidenceIdentity, type SecurityFinding, type SecurityReport
} from '../scripts/repository-security/evidence.ts';
import {
  REPORTING_LIMITS, reportRepositorySecurity, writeSecurityJobSummary, type ReportedFindingAssessment, type ReportingCapabilityObservation,
  type ReportingExpectations, type ReportingObservations, type ReportingProducerOutcome, type SecretReportingEvidence
} from '../scripts/repository-security/reporting.ts';

const now = new Date('2026-09-20T12:00:00.000Z');
const hash = `sha256:${'a'.repeat(64)}`;
const otherHash = `sha256:${'b'.repeat(64)}`;
const sentinel = 'DO_NOT_ECHO_SENTINEL [raw](https://invalid.example) <script> & ` | \n';

function finding(overrides: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    id: 'CVE-2026-12345', kind: 'vulnerability', tool: 'CodeQL', rule: 'js/fixture-rule',
    scope: 'source-javascript', component: 'fixture-component', version: '1.0.0',
    chains: [['application', 'fixture-component']], location: ['src', 'fixture.ts'],
    artifactDigest: hash, severity: 'high', owner: 'voyager163', ...overrides
  };
}

function report(findings: SecurityFinding[] = []): SecurityReport {
  return {
    schemaVersion: 1, role: 'source-analysis',
    identity: {
      repository: 'voyager163/liftoff', event: 'pull_request', sourceSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
      workflowSha: 'c'.repeat(40), runId: '123', attempt: 1,
      policyDigest: hash, inventoryDigest: hash, configurationDigest: hash
    },
    tool: { name: 'CodeQL', version: '2.23.0', database: 'fixture-db' },
    generatedAt: '2026-09-20T11:00:00.000Z', completedAt: '2026-09-20T11:01:00.000Z',
    complete: true, units: [{ id: 'source-javascript', inputDigest: hash, count: 5, platform: 'all' }], findings
  };
}

type CompletedOutcome = Extract<ReportingProducerOutcome, { analysis: 'complete' }>;

function fixture(findings: SecurityFinding[] = [], event: EvidenceIdentity['event'] = 'pull_request') {
  const evidence = report(findings);
  evidence.identity.event = event;
  const expected: ReportingExpectations = {
    identity: structuredClone(evidence.identity),
    producers: [{
      id: 'source', owner: 'voyager163', policy: 'repository-findings',
      identity: structuredClone(evidence.identity), role: evidence.role,
      tool: structuredClone(evidence.tool), units: structuredClone(evidence.units), previousFindingDigests: null
    }],
    controls: [], blockingRules: []
  };
  const assessment: ReportedFindingAssessment = {
    status: findings.length ? 'blocked' : 'passed', blocking: findings.map(item => item.id), reviewed: [], tracked: []
  };
  const outcome: CompletedOutcome = { id: 'source', analysis: 'complete', report: evidence, assessment };
  const actual: ReportingObservations = { producers: [outcome], capabilities: [], admission: null };
  return { expected, actual, outcome, evidence, assessment };
}

function capabilityFixture() {
  const data = fixture();
  data.expected.controls = [
    { id: 'advanced-codeql', owner: 'voyager163', required: true, configurationDigest: hash }
  ];
  const capability: ReportingCapabilityObservation = {
    id: 'advanced-codeql', identity: structuredClone(data.expected.identity), observedAt: '2026-09-20T11:02:00.000Z',
    available: 'available', configured: true, executed: null, passed: null, enforced: null, configurationDigest: hash
  };
  data.actual.capabilities = [capability];
  return { ...data, capability };
}

function admission(data: ReturnType<typeof fixture>, mode: 'normal' | 'policy-maintenance' = 'normal') {
  data.actual.admission = {
    identity: structuredClone(data.expected.identity), observedAt: '2026-09-20T11:03:00.000Z',
    mode, status: 'passed', evidenceDigest: otherHash
  };
}

function secretFixture(disposition: SecretReportingEvidence['findings'][number]['disposition'] = 'unresolved') {
  const data = fixture();
  data.evidence.tool.name = 'gitleaks';
  data.expected.producers[0]!.tool.name = 'gitleaks';
  data.expected.producers[0]!.policy = 'independent-secrets';
  const evidence: SecretReportingEvidence = {
    ...data.evidence, findings: [{
      id: 'sanitized-secret-id', findingDigest: otherHash, scope: 'source-javascript', artifactDigest: hash,
      rule: 'fixture-rule', owner: 'credential-owner', disposition
    }]
  };
  data.outcome.report = evidence;
  data.assessment.status = 'blocked';
  data.assessment.blocking = ['sanitized-secret-id'];
  return { ...data, secretEvidence: evidence };
}

describe('bounded local repository security reporting', () => {
  it('writes owner-visible scheduled findings without sending API notifications or changing verdicts', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lf-summary-')));
    try {
      const data = fixture([finding()], 'schedule'), report = reportRepositorySecurity(data.expected, data.actual, now);
      const output = path.join(root, 'summary');
      await writeSecurityJobSummary(report.summary, 'osv', output);
      expect(await readFile(output, 'utf8')).toBe(report.markdown);
      expect(report.summary.actualFindings.reportedStatus).toBe('blocked');
      expect(report.summary.recurrence.status).toBe('owner-action-required');
      await expect(writeSecurityJobSummary(structuredClone(report.summary), 'osv', output))
        .rejects.toThrow('unverified-job-summary');
      const oldIdentity = report.summary.identity.runId;
      report.summary.identity.runId = '999';
      await expect(writeSecurityJobSummary(report.summary, 'osv', output)).rejects.toThrow('mutated-job-summary');
      report.summary.identity.runId = oldIdentity;
      await writeSecurityJobSummary(null, 'osv', output);
      expect(await readFile(output, 'utf8')).toContain('analysis incomplete');
      expect(report.summary.notifications.every(item => item.delivery === 'not-sent')).toBe(true);
    } finally { await rm(root, { recursive: true }); }
  });
  it('does not create output for ordinary local runs and fails explicitly on oversized summary files', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lf-summary-')));
    try {
      await expect(writeSecurityJobSummary(null, 'codeql', undefined)).resolves.toBeUndefined();
      const output = path.join(root, 'summary');
      await writeFile(output, Buffer.alloc(1024 * 1024));
      await expect(writeSecurityJobSummary(null, 'codeql', output)).rejects.toThrow('job-summary-file');
      expect((await readFile(output)).length).toBe(1024 * 1024);
    } finally { await rm(root, { recursive: true }); }
  });
  it.skipIf(process.platform === 'win32')('refuses a symlink summary target without changing the target', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lf-summary-')));
    try {
      const target = path.join(root, 'target'), link = path.join(root, 'summary');
      await writeFile(target, sentinel);
      await symlink(target, link);
      await expect(writeSecurityJobSummary(null, 'codeql', link)).rejects.toThrow('job-summary-write');
      expect(await readFile(target, 'utf8')).toBe(sentinel);
    } finally { await rm(root, { recursive: true }); }
  });
  it('reports complete analysis separately and never issues authority, even for a passing report', () => {
    const data = fixture();
    admission(data);
    const result = reportRepositorySecurity(data.expected, data.actual, now);
    expect(result.summary).toMatchObject({
      kind: 'local-security-reporting-summary',
      analysis: { status: 'complete', expectedCount: 1, completeCount: 1 },
      actualFindings: { reportedStatus: 'passed', observedCount: 0, coverageComplete: true },
      reportedAdmission: { status: 'passed', mode: 'normal' },
      authority: {
        producerAuthentication: 'not-performed', activeExceptionGrant: 'none', admissionDecision: 'not-issued',
        releaseReceipt: 'not-issued', publicationAuthorization: 'none', hostedEnforcement: 'not-qualified'
      },
      recurrence: {
        releaseRequirement: 'fresh-passing-exact-release-attempt-qualification-required',
        historicalScheduleSuccess: 'not-publication-authorization'
      }
    });
    expect(JSON.parse(result.json)).toEqual(result.summary);
    expect(result.markdown).toContain('no producer authentication');
    expect(result.markdown).toContain('Historical scheduled success is not publication authorization');
    expect(result.summary.notifications).toEqual([]);
  });

  it('retains a blocked actual finding when analysis and reported maintenance admission pass', () => {
    const data = fixture([finding()]);
    admission(data, 'policy-maintenance');
    const result = reportRepositorySecurity(data.expected, data.actual, now);
    expect(result.summary.analysis.status).toBe('complete');
    expect(result.summary.actualFindings.reportedStatus).toBe('blocked');
    expect(result.summary.reportedAdmission?.status).toBe('passed');
    expect(result.summary.producers[0]!.findings[0]).toMatchObject({
      id: 'CVE-2026-12345', findingDigest: findingDigest(finding()), disposition: 'blocking', owner: 'voyager163'
    });
    expect(result.markdown).toContain('actual findings: blocked');
    expect(result.markdown).toContain('policy-maintenance / passed');
    expect(result.json).not.toContain('neutral');
    expect(result.json).not.toContain('fixed');
  });

  it('rejects a reported normal admission pass that contradicts actual blocked findings', () => {
    const data = fixture([finding()]);
    admission(data);
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('reporting-admission-inconsistent');
  });

  it('keeps an omitted producer explicitly missing rather than inventing a clean empty report', () => {
    const data = fixture();
    data.actual.producers = [];
    const result = reportRepositorySecurity(data.expected, data.actual, now);
    expect(result.summary).toMatchObject({
      analysis: { status: 'incomplete', completeCount: 0 },
      actualFindings: { reportedStatus: 'incomplete', coverageComplete: false },
      producers: [{ analysis: 'missing', findingCount: null, reportedFindingsStatus: 'not-evaluated' }]
    });
    expect(result.summary.notifications).toEqual([expect.objectContaining({
      owner: 'voyager163', id: 'source', reason: 'analysis-incomplete', action: 'rerun-exact-scope', delivery: 'not-sent'
    })]);
    expect(result.markdown).toContain('| missing | not-evaluated | unknown |');
  });

  it.each(['missing', 'skipped', 'cancelled', 'error'] as const)(
    'never treats a %s producer as complete or lets maintenance mask it', analysis => {
      const data = fixture();
      data.actual.producers = [{
        id: 'source', analysis, identity: structuredClone(data.expected.identity), observedAt: '2026-09-20T11:01:00.000Z'
      }];
      const summary = reportRepositorySecurity(data.expected, data.actual, now).summary;
      expect(summary.analysis.status).toBe('incomplete');
      expect(summary.producers[0]!.analysis).toBe(analysis);
      expect(summary.actualFindings.reportedStatus).toBe('incomplete');
      admission(data, 'policy-maintenance');
      expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('reporting-admission-inconsistent');
    });

  it.each([null, { status: 'error' as const, blocking: [], reviewed: [], tracked: [] }])(
    'reports complete analysis but incomplete/error finding evaluation %#', assessment => {
      const data = fixture([finding()]);
      data.outcome.assessment = assessment;
      const summary = reportRepositorySecurity(data.expected, data.actual, now).summary;
      expect(summary.analysis.status).toBe('complete');
      expect(summary.actualFindings).toMatchObject({ coverageComplete: false, observedCount: 1 });
      expect(summary.actualFindings.reportedStatus).toBe(assessment === null ? 'incomplete' : 'error');
      expect(summary.producers[0]!.findings[0]!.disposition).toBe('unassessed');
      expect(summary.notifications).toContainEqual(expect.objectContaining({ reason: 'assessment-incomplete' }));
      admission(data, 'policy-maintenance');
      expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('reporting-admission-inconsistent');
    });

  it.each(['info', 'low', 'moderate'] as const)('retains the exact %s finding and adopted triage owner', severity => {
    const data = fixture([finding({ severity, owner: 'producer-default-owner' })]);
    data.assessment.status = 'passed';
    data.assessment.blocking = [];
    data.assessment.tracked = [{ id: 'CVE-2026-12345', owner: 'voyager163' }];
    const result = reportRepositorySecurity(data.expected, data.actual, now);
    expect(result.summary.producers[0]!.findings[0]).toMatchObject({
      id: 'CVE-2026-12345', severity, owner: 'voyager163', disposition: 'tracked'
    });
    expect(result.summary.notifications).toContainEqual(expect.objectContaining({
      id: 'CVE-2026-12345', owner: 'voyager163', reason: 'lower-severity-triage', findingDigest: findingDigest(data.evidence.findings[0]!)
    }));
    expect(result.json).not.toContain('fixed');
    expect(result.json).not.toContain('producer-default-owner');
    data.assessment.tracked = [{ id: 'CVE-2026-12345', owner: 'different-owner' }];
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('reporting-triage-owner-mismatch');
  });

  it('labels supplied reviewed outcomes as observations, not active exception grants', () => {
    const data = fixture([finding()]);
    data.assessment.status = 'passed';
    data.assessment.blocking = [];
    data.assessment.reviewed = ['CVE-2026-12345'];
    const result = reportRepositorySecurity(data.expected, data.actual, now);
    expect(result.summary.actualFindings.reportedStatus).toBe('passed');
    expect(result.summary.producers[0]!.findings[0]!.disposition).toBe('reviewed');
    expect(result.summary.policyBoundaries.reviewedFindings).toBe('reported-only-not-an-active-grant');
    expect(result.summary.authority.activeExceptionGrant).toBe('none');
  });

  it.each([
    { sourceSha: 'd'.repeat(40) }, { baseSha: 'd'.repeat(40) }, { workflowSha: 'd'.repeat(40) },
    { repository: 'other/repository' }, { event: 'push' }, { runId: '124' }, { attempt: 2 },
    { policyDigest: otherHash }, { inventoryDigest: otherHash }, { configurationDigest: otherHash }
  ])('rejects independently expected identity drift %#', changed => {
    const data = fixture();
    Object.assign(data.evidence.identity, changed);
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('identity-mismatch');
  });

  it('validates incomplete-producer, capability and admission identities too', () => {
    const data = capabilityFixture();
    data.actual.producers = [{
      id: 'source', analysis: 'cancelled', identity: { ...data.expected.identity, attempt: 2 },
      observedAt: '2026-09-20T11:01:00.000Z'
    }];
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('identity-mismatch');
    data.actual.producers = [data.outcome];
    data.capability.identity.runId = '124';
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('identity-mismatch');
    data.capability.identity.runId = '123';
    admission(data);
    data.actual.admission!.identity.policyDigest = otherHash;
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('identity-mismatch');
  });

  it('rejects inconsistent expectations instead of deriving expectations from actual outcomes', () => {
    const data = fixture();
    data.expected.producers[0]!.identity.sourceSha = 'd'.repeat(40);
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('identity-mismatch');
    expect(() => reportRepositorySecurity(undefined as unknown as ReportingExpectations, data.actual, now))
      .toThrow('reporting-input-shape');
    data.expected.producers = [];
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('reporting-producers');
  });

  it.each([
    { role: 'wrong-role' }, { tool: { name: 'CodeQL', version: '0.0.0', database: 'fixture-db' } },
    { units: [{ id: 'source-javascript', inputDigest: otherHash, count: 5, platform: 'all' }] },
    { units: [{ id: 'source-javascript', inputDigest: hash, count: 4, platform: 'all' }] },
    { units: [{ id: 'source-javascript', inputDigest: hash, count: 5, platform: 'linux/arm64' }] },
    { units: [] }, { complete: false }
  ])('rejects changed producer or incomplete coverage %#', changed => {
    const data = fixture();
    Object.assign(data.evidence, changed);
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow(SecurityEvidenceError);
  });

  it.each([
    '2026-09-19T10:59:59.999Z', '2026-09-20T12:00:00.001Z', '2026-09-20T11:00:00Z',
    '2026-02-30T11:00:00.000Z', 'not-a-time'
  ])('rejects stale, future or malformed timestamps %s', generatedAt => {
    const data = fixture();
    data.evidence.generatedAt = generatedAt;
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow(SecurityEvidenceError);
  });

  it('uses a controlled 24-hour bound, including completion, capability, admission and missing-result evidence', () => {
    const data = fixture();
    data.evidence.generatedAt = '2026-09-19T12:00:00.000Z';
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).not.toThrow();
    expect(() => reportRepositorySecurity(data.expected, data.actual, new Date('2026-09-20T12:00:00.001Z')))
      .toThrow('stale-evidence');
    expect(() => reportRepositorySecurity(data.expected, data.actual, new Date(NaN))).toThrow('invalid-time');
    data.evidence.completedAt = '2026-09-20T12:00:00.001Z';
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('stale-evidence');
    const caps = capabilityFixture();
    caps.capability.observedAt = '2026-09-18T12:00:00.000Z';
    expect(() => reportRepositorySecurity(caps.expected, caps.actual, now)).toThrow('stale-evidence');
    caps.capability.observedAt = '2026-09-20T11:02:00.000Z';
    admission(caps);
    caps.actual.admission!.observedAt = '2026-09-18T12:00:00.000Z';
    expect(() => reportRepositorySecurity(caps.expected, caps.actual, now)).toThrow('stale-evidence');
    caps.actual.admission = null;
    caps.actual.producers = [{
      id: 'source', analysis: 'missing', identity: caps.expected.identity, observedAt: '2026-09-18T12:00:00.000Z'
    }];
    expect(() => reportRepositorySecurity(caps.expected, caps.actual, now)).toThrow('stale-evidence');
  });

  it('reports a newly disclosed scheduled finding with actionable owner metadata and fresh-release requirements', () => {
    const data = fixture([finding()], 'schedule');
    data.expected.producers[0]!.previousFindingDigests = [];
    const result = reportRepositorySecurity(data.expected, data.actual, now);
    expect(result.summary.recurrence).toMatchObject({ status: 'owner-action-required', newDisclosureCount: 1 });
    expect(result.summary.notifications).toContainEqual(expect.objectContaining({
      reason: 'scheduled-new-disclosure', action: 'triage-exact-finding', owner: 'voyager163',
      id: 'CVE-2026-12345', producerId: 'source', findingDigest: findingDigest(finding()), delivery: 'not-sent'
    }));
    expect(result.summary.notifications).toContainEqual(expect.objectContaining({ reason: 'scheduled-failure' }));
    expect(result.summary.authority.publicationAuthorization).toBe('none');
    expect(result.markdown).toContain('Fresh passing qualification for the exact release attempt is required');
    data.expected.producers[0]!.previousFindingDigests = [findingDigest(finding())];
    const existing = reportRepositorySecurity(data.expected, data.actual, now).summary;
    expect(existing.recurrence.newDisclosureCount).toBe(0);
    expect(existing.notifications).toContainEqual(expect.objectContaining({ reason: 'scheduled-failure' }));
    expect(existing.producers[0]!.findings[0]!.disclosure).toBe('previously-observed');
  });

  it('does not fabricate a new-disclosure comparison when historical evidence is unavailable', () => {
    const data = fixture([finding()], 'schedule');
    const summary = reportRepositorySecurity(data.expected, data.actual, now).summary;
    expect(summary.producers[0]!.findings[0]!.disclosure).toBe('not-compared');
    expect(summary.recurrence.newDisclosureCount).toBe(0);
    expect(summary.notifications.some(item => item.reason === 'scheduled-new-disclosure')).toBe(false);
  });

  it('makes scheduled cancellation owner-visible without allowing historical passing observations to replace it', () => {
    const data = fixture([], 'schedule');
    data.actual.producers = [{
      id: 'source', analysis: 'cancelled', identity: data.expected.identity, observedAt: '2026-09-20T11:01:00.000Z'
    }];
    const summary = reportRepositorySecurity(data.expected, data.actual, now).summary;
    expect(summary.recurrence.status).toBe('owner-action-required');
    expect(summary.notifications).toContainEqual(expect.objectContaining({
      owner: 'voyager163', reason: 'scheduled-failure', action: 'rerun-exact-scope'
    }));
    data.actual.producers = [data.outcome];
    const passed = reportRepositorySecurity(data.expected, data.actual, now).summary;
    expect(passed.recurrence.status).toBe('reported-pass');
    expect(passed.authority.publicationAuthorization).toBe('none');
    expect(passed.recurrence.releaseRequirement).toBe('fresh-passing-exact-release-attempt-qualification-required');
  });

  it('keeps configured, executed, passed and enforced independent rather than upgrading local success', () => {
    const data = capabilityFixture();
    const configured = reportRepositorySecurity(data.expected, data.actual, now).summary.capabilities[0]!;
    expect(configured).toMatchObject({
      configured: true, executed: null, passed: null, enforced: null, drift: 'unchanged',
      enforcementQualification: 'not-performed', attention: 'blocker'
    });
    data.capability.executed = true;
    data.capability.passed = true;
    const passed = reportRepositorySecurity(data.expected, data.actual, now).summary.capabilities[0]!;
    expect(passed).toMatchObject({ executed: true, passed: true, enforced: null, attention: 'blocker' });
    Object.assign(data.capability, { enforced: true });
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('reporting-enforcement-unverified');
  });

  it('reports required unavailable controls as blockers and optional capabilities as limitations', () => {
    const data = capabilityFixture();
    Object.assign(data.capability, {
      available: 'unavailable', configured: false, executed: null, passed: null, enforced: false
    });
    expect(reportRepositorySecurity(data.expected, data.actual, now).summary.capabilities[0])
      .toMatchObject({ available: 'unavailable', attention: 'blocker' });
    data.expected.controls[0]!.required = false;
    expect(reportRepositorySecurity(data.expected, data.actual, now).summary.capabilities[0])
      .toMatchObject({ attention: 'limitation' });
    data.actual.capabilities = [];
    expect(reportRepositorySecurity(data.expected, data.actual, now).summary.capabilities[0])
      .toMatchObject({ available: 'unknown', configured: null, drift: 'not-observed' });
  });

  it('derives control drift against the independently expected digest and preserves the configured state', () => {
    const data = capabilityFixture();
    data.capability.configurationDigest = otherHash;
    const result = reportRepositorySecurity(data.expected, data.actual, now);
    expect(result.summary.capabilities[0]).toMatchObject({
      configured: true, drift: 'changed', expectedConfigurationDigest: hash, observedConfigurationDigest: otherHash
    });
    expect(result.summary.notifications).toContainEqual(expect.objectContaining({
      id: 'advanced-codeql', owner: 'voyager163', reason: 'configuration-drift', action: 'review-control-drift'
    }));
  });

  it.each([
    { passed: true }, { configured: true, configurationDigest: null },
    { available: 'inapplicable' }, { available: 'unknown-freeform-status' }, { executed: 'true' }
  ])('rejects contradictory or malformed capability snapshots %#', change => {
    const data = capabilityFixture();
    Object.assign(data.capability, change);
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow(SecurityEvidenceError);
  });

  it('preserves every-finding npm exception discipline, including lower severity', () => {
    const data = fixture([finding({ tool: 'npm', severity: 'low' })]);
    data.evidence.tool.name = 'npm';
    data.expected.producers[0]!.tool.name = 'npm';
    data.expected.producers[0]!.policy = 'npm-exact-exceptions';
    expect(reportRepositorySecurity(data.expected, data.actual, now).summary.actualFindings.reportedStatus).toBe('blocked');
    data.assessment.status = 'passed';
    data.assessment.blocking = [];
    data.assessment.tracked = [{ id: 'CVE-2026-12345', owner: 'voyager163' }];
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('finding-tool-requires-separate-policy');
    data.assessment.tracked = [];
    data.assessment.reviewed = ['CVE-2026-12345'];
    expect(reportRepositorySecurity(data.expected, data.actual, now).summary.producers[0]!.findings[0]!.disposition)
      .toBe('reviewed');
    data.expected.producers[0]!.policy = 'repository-findings';
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('finding-tool-requires-separate-policy');
  });

  it('keeps unresolved secrets independent of severity and generic exception windows', () => {
    const data = secretFixture();
    const result = reportRepositorySecurity(data.expected, data.actual, now);
    expect(result.summary.actualFindings.reportedStatus).toBe('blocked');
    expect(result.summary.producers[0]!.findings[0]).toMatchObject({
      id: 'sanitized-secret-id', owner: 'credential-owner', kind: 'secret', severity: null, disposition: 'unresolved'
    });
    expect(result.summary.notifications).toContainEqual(expect.objectContaining({
      owner: 'credential-owner', action: 'credential-owner-remediation'
    }));
    data.assessment.status = 'passed';
    data.assessment.blocking = [];
    data.assessment.reviewed = ['sanitized-secret-id'];
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('reporting-secret-disposition-mismatch');
    Object.assign(data.secretEvidence.findings[0]!, { severity: 'low', reviewBy: '2026-12-20' });
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('reporting-secret-finding');
  });

  it('does not display a passing maintenance admission for confirmed unremediated exposure', () => {
    const data = secretFixture('confirmed-unremediated');
    admission(data, 'policy-maintenance');
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('reporting-admission-inconsistent');
  });

  it.each(['reviewed-false-positive', 'reviewed-fixture', 'remediated'] as const)(
    'reports the independently supplied secret disposition %s without granting authority', disposition => {
      const data = secretFixture(disposition);
      data.assessment.status = 'passed';
      data.assessment.blocking = [];
      data.assessment.reviewed = ['sanitized-secret-id'];
      const result = reportRepositorySecurity(data.expected, data.actual, now);
      expect(result.summary.producers[0]!.findings[0]!.disposition).toBe(disposition);
      expect(result.summary.authority.activeExceptionGrant).toBe('none');
    });

  it('reuses the OSV-specific valid-unscored policy without transferring it to Trivy UNKNOWN', () => {
    const data = fixture([finding({
      kind: 'policy', tool: 'osv-scanner', rule: 'GO-2026-5932',
      policyClass: 'osv-valid-unscored-advisory', upstreamSeverity: 'unscored'
    })]);
    data.evidence.tool.name = 'osv-scanner';
    data.expected.producers[0]!.tool.name = 'osv-scanner';
    data.expected.blockingRules = [{ tool: 'osv-scanner', rule: 'osv-valid-unscored-advisory' }];
    const summary = reportRepositorySecurity(data.expected, data.actual, now).summary;
    expect(summary.actualFindings.reportedStatus).toBe('blocked');
    expect(summary.producers[0]!.findings[0]).toMatchObject({
      kind: 'policy', severity: 'high', policyClass: 'osv-valid-unscored-advisory', upstreamSeverity: 'unscored'
    });
    data.evidence.tool.name = 'trivy';
    data.expected.producers[0]!.tool.name = 'trivy';
    data.evidence.findings[0]!.tool = 'trivy';
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('invalid-unscored-policy-finding');
    data.evidence.findings = [{ ...finding({ tool: 'trivy' }), severity: 'UNKNOWN' } as unknown as SecurityFinding];
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('invalid-severity');
  });

  it('uses existing rule and severity semantics instead of accepting high or policy findings as tracked', () => {
    const data = fixture([finding()]);
    data.assessment.status = 'passed';
    data.assessment.blocking = [];
    data.assessment.tracked = [{ id: 'CVE-2026-12345', owner: 'voyager163' }];
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('reporting-assessment-mismatch');
    data.evidence.findings[0]!.kind = 'policy';
    data.evidence.findings[0]!.severity = 'info';
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('unmapped-policy-rule');
    data.expected.blockingRules = [{ tool: 'CodeQL', rule: 'js/fixture-rule' }];
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('reporting-assessment-mismatch');
  });

  it.each([
    { status: 'passed', blocking: ['CVE-2026-12345'], reviewed: [], tracked: [] },
    { status: 'blocked', blocking: [], reviewed: ['CVE-2026-12345'], tracked: [] },
    { status: 'passed', blocking: [], reviewed: [], tracked: [] },
    { status: 'blocked', blocking: ['another-finding'], reviewed: [], tracked: [] },
    { status: 'error', blocking: ['CVE-2026-12345'], reviewed: [], tracked: [] },
    { status: 'neutral', blocking: [], reviewed: ['CVE-2026-12345'], tracked: [] }
  ])('rejects inconsistent or synthetic assessment partitions %#', assessment => {
    const data = fixture([finding()]);
    data.outcome.assessment = assessment as ReportedFindingAssessment;
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow(SecurityEvidenceError);
  });

  it('rejects duplicate and unexpected producer/control/finding identities', () => {
    const data = capabilityFixture();
    data.actual.producers = [data.outcome, data.outcome];
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('duplicate-identity');
    data.actual.producers = [{ ...data.outcome, id: 'not-expected' }];
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('unexpected-identity');
    data.actual.producers = [data.outcome];
    data.actual.capabilities = [data.capability, data.capability];
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('duplicate-identity');
    data.actual.capabilities = [{ ...data.capability, id: 'not-expected' }];
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('unexpected-identity');
    data.actual.capabilities = [data.capability];
    data.expected.producers = [data.expected.producers[0]!, { ...data.expected.producers[0]!, id: 'alias' }];
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('duplicate-producer');
    data.expected.producers = data.expected.producers.slice(0, 1);
    data.evidence.findings = [finding(), finding()];
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('duplicate-finding');
    data.evidence.findings = [];
    data.expected.producers[0]!.previousFindingDigests = [hash, hash];
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('duplicate-finding');
  });

  it('is byte-deterministic across permutations and does not mutate caller objects', () => {
    const data = fixture([finding(), finding({ id: 'second', rule: 'js/second' })]);
    const secondReport = report();
    secondReport.role = 'generated-analysis';
    secondReport.units[0]!.id = 'generated-node';
    secondReport.identity.inventoryDigest = otherHash;
    data.expected.producers = [
      data.expected.producers[0]!,
      { ...structuredClone(data.expected.producers[0]!), id: 'generated',
        role: secondReport.role, units: structuredClone(secondReport.units), identity: structuredClone(secondReport.identity) }
    ];
    data.actual.producers = [
      data.outcome, { id: 'generated', analysis: 'complete', report: secondReport,
        assessment: { status: 'passed', blocking: [], reviewed: [], tracked: [] } }
    ];
    const before = JSON.stringify({ expected: data.expected, actual: data.actual });
    const first = reportRepositorySecurity(data.expected, data.actual, now);
    expect(JSON.stringify({ expected: data.expected, actual: data.actual })).toBe(before);
    data.expected.producers = [...data.expected.producers].reverse();
    data.actual.producers = [...data.actual.producers].reverse();
    data.evidence.findings.reverse();
    data.assessment.blocking = [...data.assessment.blocking].reverse();
    const second = reportRepositorySecurity(data.expected, data.actual, now);
    expect(second.json).toBe(first.json);
    expect(second.markdown).toBe(first.markdown);
  });

  it('rejects raw scanner prose and unknown fields at every reporting boundary without echoing it', () => {
    const mutations: Array<(data: ReturnType<typeof capabilityFixture>) => void> = [
      data => Object.assign(data.expected, { description: sentinel }),
      data => Object.assign(data.expected.producers[0]!, { approved: sentinel }),
      data => Object.assign(data.expected.controls[0]!, { blocker: sentinel }),
      data => Object.assign(data.actual, { stdout: sentinel }),
      data => Object.assign(data.outcome, { stderr: sentinel }),
      data => Object.assign(data.evidence, { description: sentinel }),
      data => Object.assign(data.evidence.findings[0]!, { description: sentinel }),
      data => Object.assign(data.evidence.findings[0]!, { rawOutput: sentinel }),
      data => Object.assign(data.evidence.units[0]!, { description: sentinel }),
      data => Object.assign(data.evidence.tool, { description: sentinel }),
      data => Object.assign(data.assessment, { exception: sentinel }),
      data => Object.assign(data.capability, { enforcementEvidence: sentinel }),
      data => { admission(data); Object.assign(data.actual.admission!, { approval: sentinel }); },
      data => { data.evidence.findings[0]!.id = sentinel; },
      data => { data.evidence.findings[0]!.owner = sentinel; }
    ];
    for (const mutate of mutations) {
      const data = capabilityFixture();
      data.evidence.findings = [finding()];
      data.assessment.status = 'blocked';
      data.assessment.blocking = ['CVE-2026-12345'];
      mutate(data);
      let error: unknown;
      try { reportRepositorySecurity(data.expected, data.actual, now); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(SecurityEvidenceError);
      expect(String(error)).not.toContain('DO_NOT_ECHO_SENTINEL');
      expect(JSON.stringify(error)).not.toContain('DO_NOT_ECHO_SENTINEL');
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it('validates portable source locations but omits all paths and Markdown-encodes logical identifiers', () => {
    const data = fixture([finding({
      id: 'CVE_2026@triage', owner: 'owner_name', location: ['src', '[DO_NOT_ECHO_SENTINEL](link).ts']
    })]);
    const result = reportRepositorySecurity(data.expected, data.actual, now);
    expect(result.markdown).toContain('CVE&#95;2026&#64;triage');
    expect(result.markdown).toContain('owner&#95;name');
    expect(result.json).toContain('CVE_2026@triage');
    expect(result.json).not.toContain('location');
    expect(result.json).not.toContain('DO_NOT_ECHO_SENTINEL');
    expect(result.markdown).not.toContain('DO_NOT_ECHO_SENTINEL');
    data.evidence.findings[0]!.location = ['..', 'fixture.ts'];
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('unsafe-location');
  });

  it('bounds input size and rejects cycles, accessors, custom serializers and inherited fields', () => {
    const data = fixture();
    const serializer = vi.fn(() => ({ description: sentinel }));
    Object.assign(data.actual, { toJSON: serializer });
    expect(() => reportRepositorySecurity(data.expected, data.actual, now)).toThrow('reporting-input-shape');
    expect(serializer).not.toHaveBeenCalled();
    const getter = vi.fn(() => sentinel);
    const withGetter = { ...fixture().actual };
    Object.defineProperty(withGetter, 'description', { get: getter, enumerable: true });
    expect(() => reportRepositorySecurity(data.expected, withGetter, now)).toThrow('reporting-input-shape');
    expect(getter).not.toHaveBeenCalled();
    const cyclic = { ...fixture().actual };
    Object.assign(cyclic, { cycle: cyclic });
    expect(() => reportRepositorySecurity(data.expected, cyclic, now)).toThrow('reporting-input-limit');
    expect(() => reportRepositorySecurity(data.expected, Object.create(fixture().actual), now)).toThrow('reporting-input-shape');
    const tooLarge = { ...fixture().actual, description: 'x'.repeat(501) };
    expect(() => reportRepositorySecurity(data.expected, tooLarge, now)).toThrow('reporting-input-limit');
    const tooMany = { ...data.expected, producers: Array(REPORTING_LIMITS.producers + 1).fill(data.expected.producers[0]) };
    expect(() => reportRepositorySecurity(tooMany, fixture().actual, now)).toThrow('reporting-producers');
  });

  it('sanitizes exceptions thrown by hostile object proxies instead of echoing their error messages', () => {
    const data = fixture();
    const proxy = new Proxy(data.actual, {
      getPrototypeOf() { throw new SecurityEvidenceError(sentinel); }
    });
    expect(() => reportRepositorySecurity(data.expected, proxy, now)).toThrow('reporting-input-shape');
    try { reportRepositorySecurity(data.expected, proxy, now); }
    catch (error) { expect(String(error)).not.toContain('DO_NOT_ECHO_SENTINEL'); }
  });
});
