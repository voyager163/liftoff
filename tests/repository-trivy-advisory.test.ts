import { describe, expect, it } from 'vitest';
import { classifyTrivyAdvisory, projectUnclassifiedTrivyAdvisories, recognizedTrivyAdvisory } from '../scripts/repository-security/trivy-advisory.ts';

const sentinel = 'NONFUNCTIONAL_PRIVATE_TRIVY_METADATA_SENTINEL';
describe('bounded native Trivy unclassified-advisory metadata', () => {
  it('maps only valid absent native classification to its own blocking policy without invented score', () => {
    for (const metadata of [
      {}, { VendorSeverity: {}, CVSS: {} },
      { VendorSeverity: { debian: 0 }, CVSS: { debian: {} }, SeveritySource: 'debian' }
    ]) {
      expect(classifyTrivyAdvisory({ VulnerabilityID: 'DLA-4783-1', Severity: 'UNKNOWN', ...metadata }, 'os-pkgs', 'debian'))
        .toEqual({ kind: 'policy', severity: 'high', policyClass: 'trivy-valid-native-unscored-advisory', upstreamSeverity: 'UNKNOWN' });
    }
    expect(classifyTrivyAdvisory({ VulnerabilityID: 'CVE-2026-12345', Severity: 'HIGH' }, 'os-pkgs', 'debian'))
      .toEqual({ kind: 'vulnerability', severity: 'high' });
  });
  it.each([
    { Severity: undefined }, { Severity: null }, { Severity: 'unknown' }, { Severity: 'UNRECOGNIZED' },
    { SeveritySource: null }, { SeveritySource: '' }, { SeveritySource: 'unregistered' },
    { VulnerabilityID: 'UNQUALIFIED-123' }, { VendorSeverity: null }, { VendorSeverity: [] },
    { VendorSeverity: { debian: -1 } }, { VendorSeverity: { debian: 5 } },
    { VendorSeverity: { debian: 'HIGH' } }, { VendorSeverity: { nvd: 3 } },
    { CVSS: null }, { CVSS: [] }, { CVSS: { nvd: null } }, { CVSS: { nvd: [] } },
    { CVSS: { nvd: { V3Score: 0 } } }, { CVSS: { nvd: { V3Score: 9.8 } } },
    { CVSS: { nvd: { V3Vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' } } },
    { CVSS: { nvd: { V3Vector: 'bad-vector' } } }, { CVSS: { nvd: { V9Score: 5 } } }
  ])('never waives malformed, unsupported or actually published metadata %#', change => {
    expect(() => classifyTrivyAdvisory({ VulnerabilityID: 'DLA-4783-1', Severity: 'UNKNOWN', ...change }, 'os-pkgs', 'debian'))
      .toThrow('trivy-');
  });
  it('does not transplant Debian or OSV identities/policy across native surfaces', () => {
    for (const [id, type] of [['DLA-4783-1', 'alpine'], ['TEMP-1147318-639065', 'node-pkg'], ['osv-valid-unscored-advisory', 'debian']]) {
      expect(() => classifyTrivyAdvisory({ VulnerabilityID: id, Severity: 'UNKNOWN' }, 'os-pkgs', type!))
        .toThrow('unqualified-unscored-advisory');
    }
  });
  it('keeps malformed present metadata non-waivable even alongside a valid native HIGH label', () => {
    for (const metadata of [
      { VendorSeverity: null }, { VendorSeverity: { nvd: 999 } }, { CVSS: { nvd: null } },
      { CVSS: { nvd: { V3Score: -1 } } }, { CVSS: { nvd: { V3Score: '9.8' } } },
      { CVSS: { nvd: { V3Vector: 'unsupported' } } }, { CVSS: { nvd: { V9Score: 9 } } }
    ]) expect(() => classifyTrivyAdvisory({
      VulnerabilityID: 'CVE-2026-12345', Severity: 'HIGH', ...metadata
    }, 'os-pkgs', 'debian')).toThrow('trivy-');
    expect(classifyTrivyAdvisory({
      VulnerabilityID: 'CVE-2026-12345', Severity: 'HIGH',
      CVSS: { nvd: { V2Vector: 'AV:N/AC:L/Au:N/C:P/I:P/A:P', V2Score: 7.5, V3Score: 0 } }
    }, 'os-pkgs', 'debian')).toEqual({ kind: 'vulnerability', severity: 'high' });
  });
  it('recognizes the independently observed Debian LTS advisory family only on Debian OS results', () => {
    expect(recognizedTrivyAdvisory('DLA-4783-1', 'os-pkgs', 'debian')).toBe(true);
    for (const [id, kind, type] of [
      ['DLA-4783-1', 'lang-pkgs', 'debian'], ['DLA-4783-1', 'os-pkgs', 'alpine'],
      ['DLA-0-1', 'os-pkgs', 'debian'], ['DLA-4783-0', 'os-pkgs', 'debian'],
      ['DLA-4783-1\n', 'os-pkgs', 'debian'], ['DLA-PRIVATE-SENTINEL', 'os-pkgs', 'debian'],
      ['TEMP-1147318-639065', 'lang-pkgs', 'node-pkg']
    ]) expect(recognizedTrivyAdvisory(id, kind, type)).toBe(false);
    const metadata = projectUnclassifiedTrivyAdvisories({
      Class: 'os-pkgs', Type: 'debian', Vulnerabilities: [{ VulnerabilityID: 'DLA-4783-1', Severity: 'UNKNOWN' }]
    });
    expect(metadata.records[0]).toMatchObject({
      advisory: 'DLA-4783-1', advisoryIdentityValid: true, selectedSeverity: 'UNKNOWN',
      sameRecordVendorLabels: [], sameRecordVectors: [], sameRecordScores: [],
      classificationAssigned: false, exceptionApplied: false
    });
  });
  it('separates explicit UNKNOWN from missing/malformed data without assigning any policy severity', () => {
    const result = projectUnclassifiedTrivyAdvisories({ Vulnerabilities: [
      { VulnerabilityID: 'CVE-2026-12345', PkgName: 'fixture', InstalledVersion: '1.0', Severity: 'UNKNOWN' },
      { VulnerabilityID: 'CVE-2026-12346' },
      { VulnerabilityID: sentinel, Severity: { toString: sentinel }, Description: sentinel }
    ] });
    expect(result.records.map(record => record.selectedSeverity)).toEqual(['UNKNOWN', 'missing', 'malformed']);
    expect(result.records.every(record => record.classificationAssigned === false && record.exceptionApplied === false)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result.findingGate).toBe('unqualified');
  });
  it('retains only the same advisory record labels and validated vectors, without borrowing another record', () => {
    const vector = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
    const result = projectUnclassifiedTrivyAdvisories({ Vulnerabilities: [
      { VulnerabilityID: 'CVE-2026-12345', Severity: 'UNKNOWN',
        VendorSeverity: { nvd: 3 }, CVSS: { nvd: { V3Vector: vector, V3Score: 9.8 } } },
      { VulnerabilityID: 'CVE-2026-12346', Severity: 'UNKNOWN', VendorSeverity: { debian: 0 } }
    ] });
    expect(result.records[0]).toMatchObject({
      sameRecordVendorLabels: [{ source: 'nvd', label: 'HIGH' }],
      sameRecordVectors: [{ source: 'nvd', type: 'CVSS_V3', vector }],
      sameRecordScores: [{ source: 'nvd', version: 'V3Score', score: 9.8 }], classificationAssigned: false
    });
    expect(result.records[1]).toMatchObject({
      sameRecordVendorLabels: [{ source: 'debian', label: 'UNKNOWN' }],
      sameRecordVectors: [], sameRecordScores: []
    });
  });
  it('counts malformed classification fields without surfacing them as advisory prose or inventing a zero', () => {
    const result = projectUnclassifiedTrivyAdvisories({ Vulnerabilities: [{
      VulnerabilityID: 'CVE-2026-12345', Severity: 'UNKNOWN', SeveritySource: sentinel,
      CVSS: { nvd: { V3Vector: sentinel, V3Score: sentinel } }, VendorSeverity: null
    }] });
    expect(result.records[0]).toMatchObject({
      selectedSource: 'unrecognized', unsupportedVectors: 1, malformedScores: 1,
      sameRecordVectors: [], sameRecordScores: [], metadataObjectsMalformed: true
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
  it('retains a bounded TEMP identity shape for investigation without declaring it valid', () => {
    const result = projectUnclassifiedTrivyAdvisories({ Vulnerabilities: [{
      VulnerabilityID: 'TEMP-12345678-abcdef', Severity: 'UNKNOWN'
    }] });
    expect(result.records[0]).toMatchObject({
      advisory: null, advisoryIdentityValid: false,
      unqualifiedIdentityShape: {
        family: 'debian-temporary-candidate', candidate: 'TEMP-12345678-abcdef',
        decimalDigits: 8, hexadecimalDigits: 6, uppercaseHex: false
      }, classificationAssigned: false
    });
    const vendor = projectUnclassifiedTrivyAdvisories({ Vulnerabilities: [{
      VulnerabilityID: 'DSA-1234-1', Severity: 'UNKNOWN'
    }] });
    expect(vendor.records[0]).toMatchObject({
      advisoryIdentityValid: false, unqualifiedVendorIdentifier: 'DSA-1234-1', classificationAssigned: false
    });
  });
});
