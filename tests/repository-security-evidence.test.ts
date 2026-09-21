import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  evaluateSecurityReport as evaluate, findingDigest, parseSecurityReport, parseVulnerabilityException,
  portableParts, requireSuccessfulRoles, type SecurityFinding, type SecurityReport,
  type VulnerabilityException, type EvidenceIdentity, type Policy
} from '../scripts/repository-security/evidence.ts';

const hash = `sha256:${'a'.repeat(64)}`;
const now = new Date('2026-09-20T12:00:00.000Z');

function finding(overrides: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    id: 'advisory-1', kind: 'vulnerability', tool: 'fixture', rule: 'GHSA-fixture',
    scope: 'python-standard', component: 'fixture-package', version: '1.0.0',
    chains: [['application', 'fixture-package']], location: ['backend', 'uv.lock'],
    artifactDigest: hash, severity: 'high', owner: 'voyager163', ...overrides
  };
}

function report(findings: SecurityFinding[] = []): SecurityReport {
  return {
    schemaVersion: 1, role: 'dependencies',
    identity: {
      repository: 'voyager163/liftoff', event: 'pull_request', sourceSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40), workflowSha: 'c'.repeat(40), runId: '123', attempt: 1,
      policyDigest: hash, inventoryDigest: hash, configurationDigest: hash
    },
    tool: { name: 'fixture', version: '1.0.0', database: 'fixture-2026-09-20' },
    generatedAt: '2026-09-20T11:00:00.000Z', completedAt: '2026-09-20T11:01:00.000Z',
    complete: true, units: [{ id: 'python-standard', inputDigest: hash, count: 5, platform: 'all' }], findings
  };
}

function exception(item: SecurityFinding, overrides: Partial<VulnerabilityException> = {}): VulnerabilityException {
  return {
    findingDigest: findingDigest(item), disposition: 'mitigated', owner: 'voyager163',
    rationale: 'Fixture behavior is not exposed.', mitigation: 'Keep the fixture disabled.',
    reviewedAt: '2026-09-01', reviewBy: '2026-10-01', ...overrides
  };
}

function evaluateSecurityReport(
  value: SecurityReport, identity: EvidenceIdentity, units: SecurityReport['units'], policy: Policy, now: Date
) {
  const producer = report();
  return evaluate(value, { identity, units, role: producer.role, tool: producer.tool }, policy, now);
}

describe('repository security evidence', () => {
  it('keeps exception identity stable across process locales and chain order', () => {
    const value = finding({ chains: [['aardvark', 'fixture-package'], ['zebra', 'fixture-package']] });
    const source = `import { findingDigest } from './scripts/repository-security/evidence.ts'; console.log(findingDigest(${JSON.stringify(value)}));`;
    const digests = ['en_US.UTF-8', 'da_DK.UTF-8'].map(locale =>
      execFileSync(process.execPath, ['--input-type=module', '-e', source], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
        env: { LANG: locale, LC_ALL: locale }
      }).trim());
    expect(digests[0]).toBe(digests[1]);
    expect(findingDigest({ ...value, chains: [...value.chains].reverse() })).toBe(digests[0]);
  });

  it('accepts complete exact evidence and independently blocks successful scans with findings', () => {
    const clean = report();
    expect(evaluateSecurityReport(clean, clean.identity, clean.units, { blockingRules: [], exceptions: [] }, now).passed).toBe(true);
    const vulnerable = report([finding()]);
    expect(evaluateSecurityReport(vulnerable, vulnerable.identity, vulnerable.units,
      { blockingRules: [], exceptions: [] }, now)).toEqual({ passed: false, blocking: ['advisory-1'], reviewed: [], tracked: [] });
  });

  it.each([
    { schemaVersion: 2 }, { complete: false }, { units: [] }, { unexpected: true },
    { tool: { name: 'fixture', version: '1.0.0' } }, { completedAt: '2026-09-20T10:59:00.000Z' }
  ])('rejects incomplete or unknown report shapes %j', override => {
    expect(() => parseSecurityReport(JSON.stringify({ ...report(), ...override }))).toThrow('Security evidence rejected');
  });

  it('bounds invalid input without reflecting raw parser content', () => {
    expect(() => parseSecurityReport('DO_NOT_ECHO_SENTINEL')).toThrow('invalid-report-json');
    expect(() => parseSecurityReport(' '.repeat(4 * 1024 * 1024 + 1))).toThrow('report-too-large');
  });

  it('rejects duplicate, out-of-scope, wrong-tool and malformed findings', () => {
    for (const findings of [
      [finding(), finding()], [finding({ scope: 'other' })], [finding({ tool: 'other' })],
      [finding({ location: ['..', 'uv.lock'] })], [finding({ chains: [['x'], ['x']] })]
    ]) expect(() => parseSecurityReport(JSON.stringify(report(findings)))).toThrow('Security evidence rejected');
    expect(() => parseSecurityReport(JSON.stringify({ ...report(), findings: [{ ...finding(), severity: 'unknown' }] })))
      .toThrow('invalid-severity');
    const duplicate = report();
    duplicate.units.push(duplicate.units[0]!);
    expect(() => parseSecurityReport(JSON.stringify(duplicate))).toThrow('duplicate-unit');
  });

  it('checks exact source, producer attempt, policy, input count and platform', () => {
    const value = report();
    for (const override of [{ sourceSha: 'd'.repeat(40) }, { runId: '124' }, { attempt: 2 },
      { policyDigest: `sha256:${'b'.repeat(64)}` }]) {
      expect(() => evaluateSecurityReport(value, { ...value.identity, ...override }, value.units,
        { blockingRules: [], exceptions: [] }, now)).toThrow('identity-mismatch');
    }
    for (const override of [{ role: 'wrong-role' }, { tool: { ...value.tool, version: '2.0.0' } },
      { tool: { ...value.tool, database: 'wrong-database' } }]) {
      expect(() => evaluate({ ...value, ...override }, value, { blockingRules: [], exceptions: [] }, now))
        .toThrow('producer-mismatch');
    }
    for (const override of [{ count: 6 }, { platform: 'linux/arm64' }, { inputDigest: `sha256:${'b'.repeat(64)}` }]) {
      expect(() => evaluateSecurityReport(value, value.identity, [{ ...value.units[0]!, ...override }],
        { blockingRules: [], exceptions: [] }, now)).toThrow('coverage-mismatch');
    }
  });

  it('rejects stale and future evidence, including unchanged historical successes', () => {
    const value = report();
    expect(() => evaluateSecurityReport(value, value.identity, value.units,
      { blockingRules: [], exceptions: [] }, new Date('2026-09-21T11:00:00.001Z'))).toThrow('stale-evidence');
    expect(() => evaluateSecurityReport(value, value.identity, value.units,
      { blockingRules: [], exceptions: [] }, new Date('2026-09-20T10:00:00.000Z'))).toThrow('stale-evidence');
  });

  it('tracks lower findings with owners while requiring mapped policy violations', () => {
    const value = report([finding({ severity: 'low' })]);
    expect(evaluateSecurityReport(value, value.identity, value.units,
      { blockingRules: [], exceptions: [] }, now).tracked).toEqual(['advisory-1']);
    const policyFinding = report([finding({ kind: 'policy', rule: 'fixture-policy', severity: 'info' })]);
    expect(() => evaluateSecurityReport(policyFinding, policyFinding.identity, policyFinding.units,
      { blockingRules: [], exceptions: [] }, now)).toThrow('unmapped-policy-rule');
    expect(evaluateSecurityReport(policyFinding, policyFinding.identity, policyFinding.units,
      { blockingRules: [{ tool: 'fixture', rule: 'fixture-policy' }], exceptions: [] }, now).passed).toBe(false);
  });

  it('accepts only exact exceptions and retains reviewed rather than fixed outcomes', () => {
    const item = finding(), value = report([item]);
    const policy = { blockingRules: [], exceptions: [exception(item)] };
    expect(evaluateSecurityReport(value, value.identity, value.units, policy, now).reviewed).toEqual(['advisory-1']);
    for (const changed of [finding({ version: '2.0.0' }), finding({ chains: [['different', 'fixture-package']] })]) {
      const candidate = report([changed]);
      expect(() => evaluateSecurityReport(candidate, candidate.identity, candidate.units, policy, now)).toThrow('stale-exception');
    }
    expect(() => evaluateSecurityReport(report(), value.identity, value.units, policy, now)).toThrow('stale-exception');
  });

  it.each([
    ['high', '2026-10-02'], ['critical', '2026-10-02'], ['low', '2026-12-01'],
    ['moderate', '2026-12-01'], ['info', '2026-12-01']
  ] as const)('rejects overlong %s exceptions', (severity, reviewBy) => {
    const item = finding({ severity }), value = report([item]);
    expect(() => evaluateSecurityReport(value, value.identity, value.units,
      { blockingRules: [], exceptions: [exception(item, { reviewBy })] }, now)).toThrow('invalid-exception-window');
  });

  it('rejects expiry, future review, invalid calendar days, broad keys and secret exceptions', () => {
    const item = finding(), value = report([item]);
    for (const dates of [{ reviewBy: '2026-09-19' }, { reviewedAt: '2026-09-21' }]) {
      expect(() => evaluateSecurityReport(value, value.identity, value.units,
        { blockingRules: [], exceptions: [exception(item, dates)] }, now)).toThrow('invalid-exception-window');
    }
    expect(() => parseVulnerabilityException(exception(item, { reviewedAt: '2026-02-30' }))).toThrow('invalid-time');
    expect(() => parseVulnerabilityException({ ...exception(item), ignoreUnfixed: true })).toThrow('invalid-exception');
    expect(() => parseVulnerabilityException({ ...exception(item), disposition: 'credential-exposure' })).toThrow('invalid-exception-disposition');
    expect(() => parseSecurityReport(JSON.stringify({ ...report(), findings: [{ ...item, kind: 'secret' }] })))
      .toThrow('invalid-finding-kind');
  });

  it.each([['..'], ['C:'], ['a/b'], ['a\\b'], ['AUX.txt'], ['trailing.'], ['name ']])(
    'rejects unsafe portable path parts %j', part => expect(() => portableParts([part])).toThrow('unsafe-location'));

  it.each(['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', ''])('never passes %s results', conclusion => {
    expect(() => requireSuccessfulRoles(['source'], [{ role: 'source', conclusion, evidencePassed: true }]))
      .toThrow('required-role-not-successful');
  });

  it('requires every declared role exactly once with parsed passing evidence', () => {
    expect(() => requireSuccessfulRoles(['source'], [])).toThrow('role-coverage-mismatch');
    expect(() => requireSuccessfulRoles(['source'], [{ role: 'source', conclusion: 'success', evidencePassed: false }]))
      .toThrow('required-role-not-successful');
    expect(() => requireSuccessfulRoles(['source'], [{ role: 'source', conclusion: 'success', evidencePassed: true }])).not.toThrow();
  });
});
