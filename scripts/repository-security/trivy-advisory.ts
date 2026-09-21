import { createHash } from 'node:crypto';
import { isPublishedCvssVector } from './osv-advisory.ts';
import { SecurityEvidenceError, type Severity } from './evidence.ts';

const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const providers = ['nvd', 'ghsa', 'alpine', 'debian', 'ubuntu', 'redhat', 'amazon', 'suse', 'oracle-oval', 'wolfi'];
const labels = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const row = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safeIdentity = (value: unknown) => typeof value === 'string' && value.length > 0 &&
  value.length <= 500 && !/[\x00-\x1f\x7f]/.test(value) ? hash(value) : null;
const provider = (value: unknown) => typeof value === 'string' && providers.includes(value) ? value : 'unrecognized';
export const trivyUnscoredPolicyRules = Object.freeze([
  Object.freeze({ tool: 'trivy', rule: 'trivy-valid-native-unscored-advisory' })
]);

function validCvss2(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 500) return false;
  const metrics: Record<string, string[]> = {
    AV: ['L', 'A', 'N'], AC: ['H', 'M', 'L'], Au: ['M', 'S', 'N'],
    C: ['N', 'P', 'C'], I: ['N', 'P', 'C'], A: ['N', 'P', 'C'],
    E: ['ND', 'U', 'POC', 'F', 'H'], RL: ['ND', 'OF', 'TF', 'W', 'U'], RC: ['ND', 'UC', 'UR', 'C'],
    CDP: ['ND', 'N', 'L', 'LM', 'MH', 'H'], TD: ['ND', 'N', 'L', 'M', 'H'],
    CR: ['ND', 'L', 'M', 'H'], IR: ['ND', 'L', 'M', 'H'], AR: ['ND', 'L', 'M', 'H']
  };
  const source = value.startsWith('CVSS:2.0/') ? value.slice(9) : value;
  const seen = new Set<string>();
  for (const part of source.split('/')) {
    const [name, option, extra] = part.split(':');
    if (!name || !option || extra !== undefined || seen.has(name) || !metrics[name]?.includes(option)) return false;
    seen.add(name);
  }
  return ['AV', 'AC', 'Au', 'C', 'I', 'A'].every(name => seen.has(name));
}

export function classifyTrivyAdvisory(item: Record<string, unknown>, resultClass: string, type: string) {
  const severities: Record<string, Severity> = { LOW: 'low', MEDIUM: 'moderate', HIGH: 'high', CRITICAL: 'critical' };
  const publishedLabel = typeof item.Severity === 'string' && Object.hasOwn(severities, item.Severity)
    ? severities[item.Severity]! : undefined;
  const fail = (code: string): never => { throw new SecurityEvidenceError(`trivy-${code}`); };
  const validSource = (value: unknown) => typeof value === 'string' &&
    (publishedLabel ? /^[a-z][a-z0-9_-]{0,39}$/.test(value) && !/[\r\n]/.test(value) : providers.includes(value));
  if (!publishedLabel && item.Severity !== 'UNKNOWN') return fail('unknown-severity');
  if (item.SeveritySource !== undefined && !validSource(item.SeveritySource)) return fail('invalid-severity-source');
  for (const field of ['VendorSeverity', 'CVSS']) {
    const value = item[field];
    if (value === undefined) continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 20) {
      return fail('invalid-severity-metadata');
    }
    for (const [origin, data] of Object.entries(value)) {
      if (!validSource(origin)) return fail('unsupported-severity-source');
      if (field === 'VendorSeverity') {
        if (typeof data !== 'number' || !Number.isInteger(data) || data < 0 || data > 4) return fail('invalid-severity-metadata');
        if (!publishedLabel && data !== 0) return fail('unresolved-published-severity');
      } else {
        if (data === null || typeof data !== 'object' || Array.isArray(data)) return fail('invalid-severity-metadata');
        for (const [field, value] of Object.entries(data)) {
          if (['V2Score', 'V3Score', 'V40Score', 'V4Score'].includes(field)) {
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) return fail('invalid-severity-metadata');
          } else if (field === 'V2Vector') {
            if (!validCvss2(value)) return fail('unsupported-severity-vector');
          } else if (field === 'V3Vector' || field === 'V40Vector' || field === 'V4Vector') {
            if (!isPublishedCvssVector(field === 'V3Vector' ? 'CVSS_V3' : 'CVSS_V4', value)) return fail('unsupported-severity-vector');
          } else return fail('unsupported-severity-metadata');
        }
        // Even a genuine zero is published metadata, never an absent score.
        if (!publishedLabel && Object.keys(data).length !== 0) return fail('present-cvss-metadata');
      }
    }
  }
  if (publishedLabel) return { kind: 'vulnerability' as const, severity: publishedLabel };
  if (!recognizedTrivyAdvisory(item.VulnerabilityID, resultClass, type)) return fail('unqualified-unscored-advisory');
  return {
    kind: 'policy' as const, severity: 'high' as const,
    policyClass: 'trivy-valid-native-unscored-advisory' as const, upstreamSeverity: 'UNKNOWN' as const
  };
}

export function recognizedTrivyAdvisory(value: unknown, resultClass: unknown, type: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100 || /[\x00-\x1f\x7f]/.test(value)) return false;
  if (/^(?:CVE-[0-9]{4}-[0-9]{4,}|GHSA-[23456789cfghjmpqrvwx]{4}(?:-[23456789cfghjmpqrvwx]{4}){2}|GO-[0-9]{4}-[0-9]+)$/.test(value)) return true;
  return resultClass === 'os-pkgs' && type === 'debian' &&
    /^(?:TEMP-[0-9]{7}-[A-F0-9]{6}|DLA-[1-9][0-9]{0,6}-[1-9][0-9]{0,2})$/.test(value);
}

/** Same-record metadata only. It never supplies a severity or borrows an alias score. */
export function projectUnclassifiedTrivyAdvisories(value: unknown) {
  const result = row(value), all = Array.isArray(result.Vulnerabilities) ? result.Vulnerabilities : [];
  const selected = all.slice(0, 20_000).map((item, index) => ({ item: row(item), index })).filter(({ item }) =>
    typeof item.Severity !== 'string' || !['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(item.Severity));
  return {
    total: selected.length, omitted: Math.max(0, selected.length - 20), findingGate: 'unqualified',
    records: selected.slice(0, 20).map(({ item, index }) => {
      const id = item.VulnerabilityID;
      const recognized = recognizedTrivyAdvisory(id, result.Class, result.Type);
      const temporaryShape = typeof id === 'string' ? /^TEMP-([0-9]{1,12})-([a-f0-9]{1,64})$/i.exec(id) : null;
      const vendorIdentifier = typeof id === 'string' &&
        /^(?:CVE|GHSA|GO|TEMP|DSA|DLA|ALAS|RHSA|RUSTSEC|DEBIAN)-[A-Z0-9-]{1,90}$/i.test(id);
      const vendorLabels = Object.entries(row(item.VendorSeverity)).slice(0, 20).map(([source, severity]) => ({
        source: provider(source),
        label: typeof severity === 'number' && Number.isInteger(severity) && severity >= 0 && severity < labels.length
          ? labels[severity] : 'malformed'
      }));
      const vectors: { source: string; type: 'CVSS_V3' | 'CVSS_V4'; vector: string }[] = [];
      let unsupportedVectors = 0, malformedScores = 0;
      const scores: { source: string; version: string; score: number }[] = [];
      for (const [origin, data] of Object.entries(row(item.CVSS)).slice(0, 20)) {
        const cvss = row(data), source = provider(origin);
        for (const [field, type] of [['V3Vector', 'CVSS_V3'], ['V40Vector', 'CVSS_V4'], ['V4Vector', 'CVSS_V4']] as const) {
          if (cvss[field] === undefined || cvss[field] === '') continue;
          if (isPublishedCvssVector(type, cvss[field])) vectors.push({ source, type, vector: cvss[field] });
          else unsupportedVectors++;
        }
        if (cvss.V2Vector !== undefined && cvss.V2Vector !== '') unsupportedVectors++;
        for (const field of ['V2Score', 'V3Score', 'V40Score', 'V4Score']) {
          const score = cvss[field];
          if (score === undefined) continue;
          if (typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 10) {
            scores.push({ source, version: field, score });
          } else malformedScores++;
        }
      }
      return {
        index, advisory: recognized ? id : null, advisoryIdentityValid: recognized,
        opaqueAdvisoryDigest: recognized ? null : safeIdentity(id),
        unqualifiedVendorIdentifier: !recognized && vendorIdentifier ? id : null,
        unqualifiedIdentityShape: temporaryShape ? {
          family: 'debian-temporary-candidate', candidate: id,
          decimalDigits: temporaryShape[1]!.length, hexadecimalDigits: temporaryShape[2]!.length,
          uppercaseHex: temporaryShape[2] === temporaryShape[2]!.toUpperCase()
        } : null,
        componentDigest: safeIdentity(item.PkgName), installedVersionDigest: safeIdentity(item.InstalledVersion),
        selectedSeverity: item.Severity === 'UNKNOWN' ? 'UNKNOWN'
          : item.Severity === undefined ? 'missing' : typeof item.Severity === 'string' ? 'unsupported' : 'malformed',
        selectedSource: item.SeveritySource === undefined ? 'absent' : provider(item.SeveritySource),
        sameRecordVendorLabels: vendorLabels, sameRecordVectors: vectors, sameRecordScores: scores,
        unsupportedVectors, malformedScores,
        metadataObjectsMalformed: ['VendorSeverity', 'CVSS'].some(key =>
          item[key] !== undefined && (item[key] === null || typeof item[key] !== 'object' || Array.isArray(item[key]))),
        classificationAssigned: false, exceptionApplied: false
      };
    })
  };
}
