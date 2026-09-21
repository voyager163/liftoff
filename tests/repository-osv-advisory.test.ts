import { describe, expect, it } from 'vitest';
import { classifyOsvSnapshot, classifyPublishedAdvisory, isPublishedCvssVector, nativeOwnCvssClassification, projectPublishedAdvisories } from '../scripts/repository-security/osv-advisory.ts';
import { osvRelease } from '../scripts/repository-security/osv.ts';
import type { SecurityReport } from '../scripts/repository-security/evidence.ts';
import type { OsvGraph, OsvSeverityIssue } from '../scripts/repository-security/osv.ts';
import type { OsvSnapshot } from '../scripts/repository-security/osv-transport.ts';

const sentinel = 'NONFUNCTIONAL_ADVISORY_TEXT_SENTINEL';
const id = 'GO-2026-5932';
const component = { name: 'golang.org/x/crypto', version: 'v0.54.0', ecosystem: 'Go' as const, chains: [['fixture']] };
const graph: OsvGraph = { id: 'go-backend', pathParts: ['go.mod'], inputDigest: `sha256:${'a'.repeat(64)}`, components: [component] };
const issue: OsvSeverityIssue = { componentIndex: 0, package: component.name, version: component.version,
  advisories: [id], classification: 'missing' };
const vector = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
function snapshot(): OsvSnapshot {
  return {
    coordinates: [component], matches: [{ coordinate: component, ids: [id] }],
    requests: [], digest: `sha256:${'b'.repeat(64)}`,
    advisories: [{
      id, summary: sentinel, details: sentinel, references: [{ url: `https://invalid.example/${sentinel}` }],
      database_specific: { severity: 'HIGH' }, severity: [{ type: 'CVSS_V3', score: vector }],
      affected: [{ package: { name: component.name, ecosystem: 'Go' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '0.55.0' }] }] }]
    }]
  };
}

describe('minimal published advisory metadata', () => {
  it('retains exact published labels, vectors and fixes without resolving classification or copying prose', () => {
    const projected = projectPublishedAdvisories(graph, [issue], snapshot());
    expect(projected).toEqual([{
      graph: 'go-backend', package: component.name, version: component.version, advisory: id,
      labels: [{ origin: 'advisory.database_specific', label: 'HIGH' }],
      vectors: [{ type: 'CVSS_V3', vector }], unsupportedSeverityEntries: 0,
      ranges: [{ type: 'SEMVER', events: [{ kind: 'introduced', version: '0' }, { kind: 'fixed', version: '0.55.0' }] }],
      fixedVersions: ['0.55.0'], publishedVersionsCount: 0, classificationResolved: false
    }]);
    expect(JSON.stringify(projected)).not.toContain(sentinel);
  });

  it('keeps genuinely absent scoring and fixes explicit without inventing a value', () => {
    const source = snapshot();
    source.advisories = [{ id, affected: [{ package: { name: component.name, ecosystem: 'Go' } }] }];
    expect(projectPublishedAdvisories(graph, [issue], source)[0]).toMatchObject({
      labels: [], vectors: [], ranges: [], fixedVersions: [], classificationResolved: false
    });
  });

  it('rejects a transplanted component, advisory or affected-package association', () => {
    expect(() => projectPublishedAdvisories(graph, [{ ...issue, version: 'v0.55.0' }], snapshot())).toThrow('component-mismatch');
    const missing = snapshot(); missing.matches[0]!.ids = [];
    expect(() => projectPublishedAdvisories(graph, [issue], missing)).toThrow('observation-mismatch');
    const wrong = snapshot();
    wrong.advisories[0]!.affected = [{ package: { name: 'different/package', ecosystem: 'Go' } }];
    expect(() => projectPublishedAdvisories(graph, [issue], wrong)).toThrow('component-mismatch');
  });

  it('does not emit arbitrary severity strings disguised as labels or vectors', () => {
    const source = snapshot();
    source.advisories[0]!.database_specific = { severity: sentinel };
    source.advisories[0]!.severity = [{ type: 'CVSS_V3', score: `CVSS:3.1/AV:${sentinel}` }];
    const result = projectPublishedAdvisories(graph, [issue], source);
    expect(result[0]).toMatchObject({ labels: [], vectors: [], unsupportedSeverityEntries: 2 });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it('requires complete known metrics without pretending to calculate scores', () => {
    expect(isPublishedCvssVector('CVSS_V3', vector)).toBe(true);
    expect(isPublishedCvssVector('CVSS_V4', 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')).toBe(true);
    for (const invalid of [
      'CVSS:3.1/AV:N', `${vector}/AV:L`, vector.replace('AV:N', 'AV:UNREGISTERED'),
      `${vector}/EXTRA:DATA`, 'CVSS:4.0/AV:N', sentinel
    ]) expect(isPublishedCvssVector('CVSS_V3', invalid)).toBe(false);
  });

  it('preserves a record\'s own published HIGH without lending it to an unscored alias', () => {
    const source = snapshot();
    const ghsa = 'GHSA-2v4p-qf9q-27wj';
    const go = { ...source.advisories[0]!, database_specific: {}, severity: [] };
    source.advisories = [go, { ...source.advisories[0], id: ghsa }];
    source.matches[0]!.ids = [id, ghsa];
    expect(classifyOsvSnapshot(graph, source)).toEqual([
      { package: component.name, version: component.version, advisory: id, kind: 'policy',
        severity: 'high', basis: 'unscored-policy' },
      { package: component.name, version: component.version, advisory: ghsa, kind: 'vulnerability',
        severity: 'high', basis: 'published-label' }
    ]);
  });

  it('uses only a record\'s own supported base CVSS vector and never waives malformed or withdrawn records', () => {
    const source = snapshot();
    source.advisories[0]!.database_specific = {};
    expect(classifyOsvSnapshot(graph, source)[0]).toMatchObject({
      kind: 'vulnerability', severity: 'critical', basis: 'own-cvss-v3-base'
    });

    const low = projectPublishedAdvisories(graph, [issue], source)[0]!;
    low.vectors[0]!.vector = 'CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N';
    expect(classifyPublishedAdvisory(low).severity).toBe('low');
    const malformed = snapshot();
    malformed.advisories[0]!.severity = [{ type: 'CVSS_V3', score: sentinel }];
    expect(() => classifyOsvSnapshot(graph, malformed)).toThrow('unsupported-published-severity');
    const withdrawn = snapshot(); withdrawn.advisories[0]!.withdrawn = '2026-09-20T00:00:00Z';
    expect(() => classifyOsvSnapshot(graph, withdrawn)).toThrow('withdrawn-result');
    const unsupported = snapshot();
    unsupported.advisories[0]!.database_specific = {};
    unsupported.advisories[0]!.severity = [{
      type: 'CVSS_V4', score: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'
    }];
    expect(() => classifyOsvSnapshot(graph, unsupported)).toThrow('unsupported-published-severity');
  });

  it('requires a single exact native-scored advisory/component, preserving genuine zero', () => {
    const source = snapshot();
    source.advisories[0]!.database_specific = {};
    const metadata = projectPublishedAdvisories(graph, [issue], source)[0]!;
    const digest = `sha256:${'a'.repeat(64)}`;
    const report: SecurityReport = {
      schemaVersion: 1, role: 'non-npm-dependencies', complete: true,
      identity: { repository: 'fixture/isolated', event: 'workflow_dispatch', sourceSha: 'a'.repeat(40),
        baseSha: 'a'.repeat(40), workflowSha: 'a'.repeat(40), runId: '1', attempt: 1,
        policyDigest: digest, inventoryDigest: digest, configurationDigest: digest },
      tool: { name: 'osv-scanner', version: osvRelease.version, database: digest },
      generatedAt: '2026-09-20T00:00:00.000Z', completedAt: '2026-09-20T00:01:00.000Z',
      units: [{ id: graph.id, inputDigest: digest, count: 1, platform: 'all' }],
      findings: [{ id: 'fixture', kind: 'vulnerability', tool: 'osv-scanner', rule: id, scope: graph.id,
        component: component.name, version: component.version, chains: [['fixture']], location: ['fixture.cdx.json'],
        artifactDigest: digest, severity: 'info', owner: 'fixture' }]
    };
    expect(nativeOwnCvssClassification(metadata, report)).toMatchObject({
      advisory: id, severity: 'info', kind: 'vulnerability', basis: 'native-own-cvss'
    });
    for (const change of [
      { ...report, findings: [] }, { ...report, complete: false },
      { ...report, units: [{ ...report.units[0]!, count: 2 }] },
      { ...report, findings: [{ ...report.findings[0]!, rule: 'GO-2026-9999' }] }
    ]) expect(() => nativeOwnCvssClassification(metadata, change as SecurityReport)).toThrow();
    expect(() => nativeOwnCvssClassification({ ...metadata, vectors: [] }, report)).toThrow('own-score-coverage');
    expect(() => nativeOwnCvssClassification({ ...metadata, unsupportedSeverityEntries: 1 }, report)).toThrow('own-score-coverage');
  });
});
