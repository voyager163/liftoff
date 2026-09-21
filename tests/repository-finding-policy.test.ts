import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptedBaseIdentity, loadAdoptedBase } from '../scripts/repository-security/admission.ts';
import {
  evaluateRepositoryFindingReports, loadAdoptedFindingPolicy, parseRepositoryFindingPolicy
} from '../scripts/repository-security/finding-policy.ts';
import { findingDigest, type SecurityFinding, type SecurityReport, type VulnerabilityException } from '../scripts/repository-security/evidence.ts';
import { createAdmissionGitFixture } from './fixtures/security-git.js';

const now = new Date('2026-09-20T12:00:00.000Z');
const hash = `sha256:${'a'.repeat(64)}`;
const policySource = await readFile('security/finding-policy.json', 'utf8');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function finding(overrides: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    id: 'fixture-finding', kind: 'vulnerability', tool: 'osv-scanner', rule: 'GHSA-fixture',
    scope: 'python-standard', component: 'fixture-package', version: '1.0.0',
    chains: [['application', 'fixture-package']], location: ['backend', 'uv.lock'],
    artifactDigest: hash, severity: 'high', owner: 'producer-default-owner', ...overrides
  };
}
function exception(item: SecurityFinding): VulnerabilityException {
  return { findingDigest: findingDigest(item), disposition: 'mitigated', owner: 'voyager163',
    rationale: 'Isolated nonfunctional fixture only.', mitigation: 'No deployment of this fixture.',
    reviewedAt: '2026-09-20', reviewBy: '2026-10-20' };
}
async function fixture(exceptions: VulnerabilityException[] = [], candidate = policySource) {
  const git = await createAdmissionGitFixture();
  cleanups.push(() => git.cleanup());
  const registry = {
    schemaVersion: 1, repository: 'voyager163/liftoff',
    policyData: [{ id: 'vulnerability-exceptions', adapter: 'vulnerability', pathParts: ['security', 'exceptions.json'] }],
    validatorInputs: [['validator.txt']],
    controlInputs: [['validator.txt'], ['security', 'control-plane.json'], ['security', 'finding-policy.json']]
  };
  const files = {
    'validator.txt': 'Synthetic validator identity.',
    'security/control-plane.json': JSON.stringify(registry),
    'security/finding-policy.json': policySource,
    'security/exceptions.json': JSON.stringify({ schemaVersion: 1, exceptions })
  };
  const baseCommit = await git.commit(files);
  const headCommit = await git.commit({ ...files, 'security/finding-policy.json': candidate });
  const base = await loadAdoptedBase(git.root, { repository: 'voyager163/liftoff', baseRef: 'develop', baseCommit, headCommit, now });
  const handle = await loadAdoptedFindingPolicy(base);
  const authority = adoptedBaseIdentity(base);
  const report = (findings: SecurityFinding[] = [], tool = 'osv-scanner', scope = 'python-standard'): SecurityReport => ({
    schemaVersion: 1, role: 'non-npm-findings', complete: true,
    identity: {
      repository: 'voyager163/liftoff', event: 'pull_request', sourceSha: headCommit, baseSha: baseCommit,
      workflowSha: baseCommit, runId: '123', attempt: 1, policyDigest: authority.policyDigest,
      inventoryDigest: hash, configurationDigest: hash
    },
    tool: { name: tool, version: '1.0.0', database: 'nonfunctional-fixture' },
    generatedAt: '2026-09-20T11:00:00.000Z', completedAt: '2026-09-20T11:01:00.000Z',
    units: [{ id: scope, inputDigest: hash, count: 1, platform: 'all' }], findings
  });
  return { handle, report };
}

describe('explicit adopted finding policy', () => {
  it('registers precise policy rules without treating priority as a CVSS score', () => {
    const parsed = parseRepositoryFindingPolicy(policySource);
    expect(parsed.policyRules[0]).toEqual({
      tool: 'checkov', rule: 'CKV_AZURE_3', classification: 'blocking-policy', reviewPriority: 'high',
      rationale: 'Storage-account transport must require HTTPS. Review priority is not a CVSS score.'
    });
    expect(parsed.policyRules[1]).toMatchObject({
      tool: 'osv-scanner', rule: 'osv-valid-unscored-advisory', classification: 'blocking-policy', reviewPriority: 'high'
    });
    expect(Object.isFrozen(parsed.policyRules[0])).toBe(true);
  });

  it.each([
    { blockingVulnerabilitySeverities: ['critical'] }, { lowerSeverityHandling: 'ignore' },
    { unknownClassification: 'clean' }, { triageOwner: '' }, { npmPolicy: 'high-only' },
    { secretsPolicy: 'vulnerability-exception' }, { approved: true }, { policyRules: [] }
  ])('rejects weakening or ambiguous policy %#', change => {
    expect(() => parseRepositoryFindingPolicy(JSON.stringify({ ...JSON.parse(policySource), ...change }))).toThrow();
  });

  it.each([
    { rule: '*' }, { reviewPriority: 'low' }, { classification: 'advisory-only' },
    { tool: 'gitleaks' }, { rationale: '' }
  ])('rejects unregistered policy-rule shapes %#', change => {
    const value = JSON.parse(policySource);
    Object.assign(value.policyRules[0], change);
    expect(() => parseRepositoryFindingPolicy(JSON.stringify(value))).toThrow();
  });

  it('uses adopted data rather than a weakening candidate or a caller-created handle', async () => {
    const candidate = { ...JSON.parse(policySource), blockingVulnerabilitySeverities: ['critical'] };
    const { handle, report } = await fixture([], JSON.stringify(candidate));
    const value = report([finding()]);
    expect(evaluateRepositoryFindingReports(handle, [value], [value], now).passed).toBe(false);
    expect(() => evaluateRepositoryFindingReports({ kind: 'adopted-finding-policy' }, [value], [value], now))
      .toThrow('unverified-finding-policy');
  });

  it.each(['high', 'critical'] as const)('blocks %s while retaining owner-bound lower triage', async severity => {
    const { handle, report } = await fixture();
    const value = report([finding({ severity }), finding({ id: 'lower', rule: 'GHSA-lower', severity: 'low' })]);
    const result = evaluateRepositoryFindingReports(handle, [value], [value], now);
    expect(result).toMatchObject({
      passed: false, blocking: [{ reportIndex: 0, id: 'fixture-finding' }],
      tracked: [{ reportIndex: 0, id: 'lower', owner: 'voyager163' }],
      npmAssessed: false, secretsAssessed: false, admissionQualified: false, publicationQualified: false
    });
  });

  it('does not turn lower-severity triage into a claim of remediation', async () => {
    const { handle, report } = await fixture();
    const value = report([finding({ severity: 'moderate' })]);
    expect(evaluateRepositoryFindingReports(handle, [value], [value], now)).toMatchObject({
      passed: true, reviewed: [], tracked: [{ id: 'fixture-finding', owner: 'voyager163', severity: 'moderate' }]
    });
  });

  it('requires the exact Checkov rule, policy kind and registered review priority', async () => {
    const { handle, report } = await fixture();
    const item = finding({ kind: 'policy', tool: 'checkov', rule: 'CKV_AZURE_3' });
    const value = report([item], 'checkov');
    expect(evaluateRepositoryFindingReports(handle, [value], [value], now).passed).toBe(false);
    for (const changed of [
      { ...item, rule: 'CKV_AZURE_999999' }, { ...item, severity: 'low' as const },
      { ...item, kind: 'vulnerability' as const }, { ...item, tool: 'osv-scanner' }
    ]) {
      const invalid = report([changed], 'checkov');
      expect(() => evaluateRepositoryFindingReports(handle, [invalid], [invalid], now)).toThrow();
    }
  });

  it.each(['npm', 'gitleaks', 'unknown-scanner'])('cannot replace %s enforcement with generic severity policy', async tool => {
    const { handle, report } = await fixture();
    const value = report([finding({ tool, severity: 'low' })], tool);
    expect(() => evaluateRepositoryFindingReports(handle, [value], [value], now))
      .toThrow('finding-tool-requires-separate-policy');
  });

  it('cannot apply an adopted vulnerability exception to a secret detector', async () => {
    const item = finding({ tool: 'gitleaks', severity: 'low' });
    const { handle, report } = await fixture([exception(item)]);
    const value = report([item], 'gitleaks');
    expect(() => evaluateRepositoryFindingReports(handle, [value], [value], now))
      .toThrow('finding-tool-requires-separate-policy');
  });

  it('keeps unknown severity and missing finding ownership as errors, not clean results', async () => {
    const { handle, report } = await fixture();
    for (const change of [{ severity: 'unknown' }, { owner: '' }]) {
      const value = report([{ ...finding(), ...change } as SecurityFinding]);
      expect(() => evaluateRepositoryFindingReports(handle, [value], [value], now)).toThrow();
    }
  });

  it('checks stale exceptions globally without transplanting them across report scopes', async () => {
    const first = finding(), second = finding({ tool: 'trivy', scope: 'node-image' });
    const { handle, report } = await fixture([exception(first), exception(second)]);
    const values = [report([first]), report([second], 'trivy', 'node-image')];
    values[1]!.identity.configurationDigest = `sha256:${'b'.repeat(64)}`;
    const result = evaluateRepositoryFindingReports(handle, values, values, now);
    expect(result.passed).toBe(true);
    expect(result.reviewed).toHaveLength(2);
    expect(() => evaluateRepositoryFindingReports(handle, values.slice(0, 1), values.slice(0, 1), now)).toThrow('stale-exception');
    const transplant = structuredClone(values);
    transplant[1]!.findings[0]!.scope = 'different-image';
    transplant[1]!.units[0]!.id = 'different-image';
    expect(() => evaluateRepositoryFindingReports(handle, transplant, transplant, now)).toThrow('stale-exception');
  });

  it('keeps the 30-day cap for a non-comparable blocking policy exception', async () => {
    const item = finding({ kind: 'policy', tool: 'checkov', rule: 'CKV_AZURE_3' });
    const permit = { ...exception(item), reviewBy: '2026-10-21' };
    const { handle, report } = await fixture([permit]);
    const value = report([item], 'checkov');
    expect(() => evaluateRepositoryFindingReports(handle, [value], [value], now)).toThrow('invalid-exception-window');
  });

  it('binds an unscored policy exception to the exact advisory, component, version, graph and chains', async () => {
    const item = finding({
      kind: 'policy', tool: 'osv-scanner', rule: 'GO-2026-5932', policyClass: 'osv-valid-unscored-advisory',
      upstreamSeverity: 'unscored', severity: 'high'
    });
    const blocked = await fixture();
    const original = blocked.report([item]);
    expect(evaluateRepositoryFindingReports(blocked.handle, [original], [original], now).passed).toBe(false);
    const adopted = await fixture([exception(item)]);
    const report = adopted.report([item]);
    expect(evaluateRepositoryFindingReports(adopted.handle, [report], [report], now)).toMatchObject({
      passed: true, reviewed: [{ reportIndex: 0, id: item.id }]
    });
    for (const change of [
      { rule: 'GO-2026-6303' }, { component: 'different-package' }, { version: '2.0.0' },
      { chains: [['different-root', item.component]] }
    ]) {
      const different = adopted.report([{ ...item, ...change }]);
      expect(() => evaluateRepositoryFindingReports(adopted.handle, [different], [different], now)).toThrow('stale-exception');
    }
    const expired = await fixture([{ ...exception(item), reviewBy: '2026-10-21' }]);
    const invalid = expired.report([item]);
    expect(() => evaluateRepositoryFindingReports(expired.handle, [invalid], [invalid], now)).toThrow('invalid-exception-window');
    expect(() => findingDigest({ ...item, severity: 'low' })).toThrow('invalid-unscored-policy-finding');
    expect(() => findingDigest({ ...item, rule: 'osv-valid-unscored-advisory' })).toThrow('invalid-unscored-policy-finding');
  });

  it('rejects missing, duplicate, stale and wrong-provenance report sets', async () => {
    const { handle, report } = await fixture();
    const value = report();
    expect(() => evaluateRepositoryFindingReports(handle, [], [], now)).toThrow('finding-report-set-coverage');
    expect(() => evaluateRepositoryFindingReports(handle, [value], [], now)).toThrow('finding-report-set-coverage');
    expect(() => evaluateRepositoryFindingReports(handle, [value, value], [value, value], now)).toThrow('duplicate-finding-producer');
    for (const change of [
      { sourceSha: 'c'.repeat(40) }, { baseSha: 'c'.repeat(40) }, { policyDigest: `sha256:${'c'.repeat(64)}` }
    ]) {
      const changed = { ...value, identity: { ...value.identity, ...change } };
      expect(() => evaluateRepositoryFindingReports(handle, [changed], [changed], now)).toThrow('finding-policy-identity-mismatch');
    }
    const stale = { ...value, generatedAt: '2026-09-18T11:00:00.000Z' };
    expect(() => evaluateRepositoryFindingReports(handle, [stale], [stale], now)).toThrow('stale-evidence');
    const missing = { ...value, complete: false };
    expect(() => evaluateRepositoryFindingReports(handle, [missing as SecurityReport], [value], now)).toThrow('incomplete-report');
  });

  it('keeps Trivy UNKNOWN separate and binds any adopted exception to exact image and advisory identities', async () => {
    const item = finding({
      kind: 'policy', tool: 'trivy', rule: 'DLA-4783-1', policyClass: 'trivy-valid-native-unscored-advisory',
      upstreamSeverity: 'UNKNOWN', severity: 'high', scope: 'telemetry-ingest', component: hash, version: hash,
      location: ['image', 'os-pkgs', 'debian', 'a'.repeat(64)]
    });
    const blocked = await fixture(), original = blocked.report([item], 'trivy', item.scope);
    expect(evaluateRepositoryFindingReports(blocked.handle, [original], [original], now).passed).toBe(false);
    const adopted = await fixture([exception(item)]), report = adopted.report([item], 'trivy', item.scope);
    expect(evaluateRepositoryFindingReports(adopted.handle, [report], [report], now).passed).toBe(true);
    for (const change of [
      { rule: 'DLA-4784-1' }, { component: `sha256:${'b'.repeat(64)}` }, { version: `sha256:${'b'.repeat(64)}` },
      { artifactDigest: `sha256:${'b'.repeat(64)}` }, { scope: 'different-image' },
      { location: ['image', 'os-pkgs', 'debian', 'b'.repeat(64)] }
    ]) {
      const wrong = adopted.report([{ ...item, ...change }], 'trivy', change.scope ?? item.scope);
      if (change.artifactDigest) wrong.units[0]!.inputDigest = change.artifactDigest;
      expect(() => evaluateRepositoryFindingReports(adopted.handle, [wrong], [wrong], now)).toThrow('stale-exception');
    }
    const expired = await fixture([{ ...exception(item), reviewBy: '2026-10-21' }]);
    const invalid = expired.report([item], 'trivy', item.scope);
    expect(() => evaluateRepositoryFindingReports(expired.handle, [invalid], [invalid], now)).toThrow('invalid-exception-window');
    for (const change of [
      { severity: 'low' }, { upstreamSeverity: 'unscored' }, { rule: 'trivy-valid-native-unscored-advisory' },
      { tool: 'osv-scanner' }, { location: ['image', 'os-pkgs', 'alpine', 'a'.repeat(64)] }
    ]) expect(() => findingDigest({ ...item, ...change } as SecurityFinding)).toThrow('invalid-unscored-policy-finding');
  });
});
