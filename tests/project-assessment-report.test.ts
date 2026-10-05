import { describe, expect, it } from 'vitest';
import {
  assembleProjectAssessmentReport, projectAssessmentFinding,
  type ProjectAssessmentFinding, type ProjectAssessmentTarget
} from '../src/domain/assessment/report.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';

const target: ProjectAssessmentTarget = {
  cliVersion: '0.12.3', manifestVersion: 8, profile: 'none', profileSelection: 'explicit', policy: null,
  pluginCatalog: { apiVersion: 1, registryDigest: 'registry', pluginSetDigest: 'plugins' },
  selectedPlugins: null, layoutDescriptorDigest: null
};
function finding(overrides: Partial<Parameters<typeof projectAssessmentFinding>[0]> = {}) {
  return projectAssessmentFinding({
    id: 'layout.backend', category: 'layout', title: 'Bound backend directory', pathParts: ['custom api'],
    applicability: 'applicable', supported: true, expected: 'directory',
    observed: { availability: 'observed', value: 'directory', source: { kind: 'inventory', pathParts: ['custom api'], digest: 'inventory' } },
    reason: 'Metadata presence only.',
    remediation: { category: 'application-repair', available: true, previewCommand: ['liftoff', 'repair', '--check'], separateConsent: true },
    ...overrides
  });
}
function report(findings: ProjectAssessmentFinding[], overrides: Partial<Parameters<typeof assembleProjectAssessmentReport>[0]> = {}) {
  return assembleProjectAssessmentReport({
    mode: 'local', project: { root: '/synthetic', kind: 'git', manifestVersion: null, recordedProfile: null },
    target, snapshot: { inventoryDigest: 'inventory', metadataDigest: null, inputsStable: true },
    findings, diagnostics: [], limitations: ['Not authority.'], ...overrides
  });
}

describe('whole-project report outcome and provenance contract', () => {
  it('requires complete applicable alignment for exit zero', () => {
    expect(report([finding()])).toMatchObject({ schemaVersion: 1, command: 'assess', readOnly: true, outcome: 'aligned', exitCode: 0 });
  });
  it('reports explicitly inapplicable scope without claiming alignment', () => {
    const result = report([finding({ applicability: 'inapplicable', supported: false,
      observed: { availability: 'not-observed', value: null, source: null } })]);
    expect(result).toMatchObject({ outcome: 'not-applicable', exitCode: 0 });
    expect(result.coverage).toMatchObject({ applicable: 0, inapplicable: 1, unsupported: 0, notObserved: 0 });
  });
  it.each(['outdated', 'conflicting'] as const)('preserves a genuine %s difference', difference => {
    const result = report([finding({ difference,
      observed: { availability: 'observed', value: 'file', source: { kind: 'inventory', pathParts: ['custom api'], digest: 'inventory' } } })]);
    expect(result).toMatchObject({ outcome: 'differences', exitCode: 2 });
    expect(result.findings[0].classification).toBe(difference);
    expect(result.coverage.differences).toBe(1);
  });
  it('distinguishes observed absence from uncollected evidence', () => {
    const absent = finding({ observed: { availability: 'missing', value: null,
      source: { kind: 'inventory', pathParts: ['custom api'], digest: 'inventory' } } });
    const unknown = finding({ id: 'references', observed: { availability: 'not-observed', value: null, source: null } });
    expect(absent.classification).toBe('missing');
    expect(unknown.classification).toBe('not-observed');
    expect(report([absent, unknown])).toMatchObject({ outcome: 'partial', exitCode: 2, coverage: { differences: 1, notObserved: 1 } });
  });
  it.each([{ applicability: 'unknown' as const }, { supported: false }])('does not turn observed facts into a pass with %j', overrides => {
    const result = report([finding(overrides)]);
    expect(result).toMatchObject({ outcome: 'partial', exitCode: 2 });
    expect(result.findings[0].observed.value).toBe('directory');
    expect(result.findings[0].classification).toBe('not-observed');
    expect(result.coverage.fullyObserved).toBe(0);
  });
  it('makes unstable observations partial and operational failures errors', () => {
    expect(report([finding()], { snapshot: { inventoryDigest: null, metadataDigest: null, inputsStable: false } })).toMatchObject({ outcome: 'partial', exitCode: 2 });
    expect(report([finding()], { diagnostics: [{ code: 'input-changed', severity: 'error', message: 'Changed inputs.' }] })).toMatchObject({ outcome: 'error', exitCode: 1 });
    expect(report([], { target: null })).toMatchObject({ outcome: 'error', exitCode: 1 });
    expect(report([])).toMatchObject({ outcome: 'error', exitCode: 1 });
  });
  it('sorts full finding and diagnostic identities deterministically and binds the result digest', () => {
    const a = finding({ id: 'a' }), b = finding({ id: 'b' });
    const diagnostics = [
      { code: 'z', severity: 'warning' as const, message: 'later' },
      { code: 'a', severity: 'warning' as const, message: 'first' }
    ];
    const result = report([b, a], { diagnostics });
    expect(result).toEqual(report([a, b], { diagnostics: [...diagnostics].reverse() }));
    expect(result.resultDigest).toBe(canonicalSha256({ ...result, resultDigest: '' }));
    expect([b, a].map(item => item.id)).toEqual(['b', 'a']);
  });
  it('rejects duplicate finding identities and observed facts without provenance', () => {
    expect(() => report([finding(), finding()])).toThrow('unique');
    for (const availability of ['observed', 'missing'] as const) {
      expect(() => finding({ observed: { availability, value: null, source: null } })).toThrow('provenance');
    }
  });
});
