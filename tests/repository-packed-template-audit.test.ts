import { describe, expect, it } from 'vitest';
import { inspectPackedNpmLock } from '../scripts/repository-security/packed-template-inventory.ts';
import { normalizePackedTemplateAudit } from '../scripts/repository-security/packed-template-audit.ts';

const graph = inspectPackedNpmLock(JSON.stringify({
  lockfileVersion: 3, packages: { '': {}, 'node_modules/fixture': {
    version: '1.0.0', integrity: `sha512-${Buffer.alloc(64).toString('base64')}`
  } }
}), 'node-backend');
function report() {
  return {
    auditReportVersion: 2, vulnerabilities: {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
      dependencies: { prod: 1, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 1 } }
  };
}
describe('exact packed template npm audit', () => {
  it('reconciles an actual lock-instance count, not just an empty vulnerability object', () => {
    expect(normalizePackedTemplateAudit(graph, report(), `sha256:${'a'.repeat(64)}`)).toMatchObject({
      graph: 'node-backend', assessedLockInstances: 1, analysisComplete: true, findingsPassed: true,
      exceptionsTransplanted: false, findings: []
    });
  });
  it.each([0, 2, null, '1'])('rejects missing or altered component coverage %s', total => {
    const value = report();
    Object.assign(value.metadata.dependencies, { total });
    expect(() => normalizePackedTemplateAudit(graph, value, `sha256:${'a'.repeat(64)}`)).toThrow('audit-component-coverage');
  });
  it('rejects an omitted audit version instead of treating unrecognized data as clean', () => {
    const value = report();
    Object.assign(value, { auditReportVersion: undefined });
    expect(() => normalizePackedTemplateAudit(graph, value, `sha256:${'a'.repeat(64)}`)).toThrow();
  });
  it('keeps a lower-severity npm finding blocking and rejects nodes outside the exact lock', () => {
    const value = {
      ...report(),
      vulnerabilities: { fixture: {
        name: 'fixture', severity: 'low', isDirect: true, range: '<2.0.0', nodes: ['node_modules/fixture'],
        effects: [], fixAvailable: false,
        via: [{ source: 1234567, name: 'fixture', dependency: 'fixture', title: 'Nonfunctional assessment fixture',
          url: 'https://github.com/advisories/GHSA-2345-6789-cfgh', severity: 'low', range: '<2.0.0' }]
      } },
      metadata: { ...report().metadata,
        vulnerabilities: { info: 0, low: 1, moderate: 0, high: 0, critical: 0, total: 1 } }
    };
    expect(normalizePackedTemplateAudit(graph, value, `sha256:${'a'.repeat(64)}`)).toMatchObject({
      analysisComplete: true, findingsPassed: false,
      findings: [{ advisory: 'GHSA-2345-6789-CFGH', severity: 'low', versions: ['1.0.0'], blocking: true }]
    });
    value.vulnerabilities.fixture.nodes = ['node_modules/outside'];
    expect(() => normalizePackedTemplateAudit(graph, value, `sha256:${'a'.repeat(64)}`)).toThrow('finding-outside-packed-graph');
  });
});
