import { parseSecurityReport, SecurityEvidenceError, type SecurityReport, type Severity } from './evidence.ts';
import { osvAdvisoryId, osvRelease, type OsvGraph, type OsvSeverityIssue } from './osv.ts';
import type { OsvSnapshot } from './osv-transport.ts';

const labels = ['CRITICAL', 'HIGH', 'MODERATE', 'MEDIUM', 'LOW', 'INFO'] as const;
type PublishedLabel = typeof labels[number];
const cvss3: Record<string, readonly string[]> = {
  AV: ['N', 'A', 'L', 'P'], AC: ['L', 'H'], PR: ['N', 'L', 'H'], UI: ['N', 'R'], S: ['U', 'C'],
  C: ['N', 'L', 'H'], I: ['N', 'L', 'H'], A: ['N', 'L', 'H'],
  E: ['X', 'U', 'P', 'F', 'H'], RL: ['X', 'O', 'T', 'W', 'U'], RC: ['X', 'U', 'R', 'C'],
  CR: ['X', 'L', 'M', 'H'], IR: ['X', 'L', 'M', 'H'], AR: ['X', 'L', 'M', 'H'],
  MAV: ['X', 'N', 'A', 'L', 'P'], MAC: ['X', 'L', 'H'], MPR: ['X', 'N', 'L', 'H'],
  MUI: ['X', 'N', 'R'], MS: ['X', 'U', 'C'], MC: ['X', 'N', 'L', 'H'],
  MI: ['X', 'N', 'L', 'H'], MA: ['X', 'N', 'L', 'H']
};
const cvss4: Record<string, readonly string[]> = {
  AV: ['N', 'A', 'L', 'P'], AC: ['L', 'H'], AT: ['N', 'P'], PR: ['N', 'L', 'H'], UI: ['N', 'P', 'A'],
  VC: ['N', 'L', 'H'], VI: ['N', 'L', 'H'], VA: ['N', 'L', 'H'],
  SC: ['N', 'L', 'H'], SI: ['N', 'L', 'H'], SA: ['N', 'L', 'H'],
  E: ['X', 'A', 'P', 'U'], CR: ['X', 'L', 'M', 'H'], IR: ['X', 'L', 'M', 'H'], AR: ['X', 'L', 'M', 'H'],
  MAV: ['X', 'N', 'A', 'L', 'P'], MAC: ['X', 'L', 'H'], MAT: ['X', 'N', 'P'], MPR: ['X', 'N', 'L', 'H'],
  MUI: ['X', 'N', 'P', 'A'], MVC: ['X', 'N', 'L', 'H'], MVI: ['X', 'N', 'L', 'H'], MVA: ['X', 'N', 'L', 'H'],
  MSC: ['X', 'N', 'L', 'H'], MSI: ['X', 'N', 'L', 'H', 'S'], MSA: ['X', 'N', 'L', 'H', 'S'],
  S: ['X', 'N', 'P'], AU: ['X', 'N', 'Y'], R: ['X', 'A', 'U', 'I'], V: ['X', 'D', 'C'],
  RE: ['X', 'L', 'M', 'H'], U: ['X', 'Clear', 'Green', 'Amber', 'Red']
};

export function isPublishedCvssVector(type: unknown, value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 300) return false;
  const [prefix, ...fields] = value.split('/');
  const is3 = type === 'CVSS_V3' && (prefix === 'CVSS:3.0' || prefix === 'CVSS:3.1');
  if (!is3 && !(type === 'CVSS_V4' && prefix === 'CVSS:4.0')) return false;
  const allowed = is3 ? cvss3 : cvss4;
  const required = is3 ? ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A']
    : ['AV', 'AC', 'AT', 'PR', 'UI', 'VC', 'VI', 'VA', 'SC', 'SI', 'SA'];
  const seen = new Set<string>();
  for (const field of fields) {
    const [name, value, extra] = field.split(':');
    if (!name || !value || extra !== undefined || seen.has(name) || !Object.hasOwn(allowed, name) ||
        !allowed[name]!.includes(value)) return false;
    seen.add(name);
  }
  return required.every(name => seen.has(name));
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SecurityEvidenceError('osv-advisory-metadata-shape');
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 1000) throw new SecurityEvidenceError('osv-advisory-metadata-size');
  return value;
}
function version(value: unknown, git: boolean): string {
  if (typeof value !== 'string' || value.length > 100 ||
      !(git ? /^(?:0|[a-f0-9]{40})$/ : /^(?:v?[0-9][0-9A-Za-z.!+_-]*)$/).test(value)) {
    throw new SecurityEvidenceError('osv-advisory-metadata-version');
  }
  return value;
}

export interface PublishedAdvisoryMetadata {
  graph: string;
  package: string;
  version: string;
  advisory: string;
  labels: { origin: string; label: PublishedLabel }[];
  vectors: { type: 'CVSS_V3' | 'CVSS_V4'; vector: string }[];
  unsupportedSeverityEntries: number;
  ranges: { type: 'SEMVER' | 'ECOSYSTEM' | 'GIT'; events: { kind: string; version: string }[] }[];
  fixedVersions: string[];
  publishedVersionsCount: number;
  classificationResolved: false;
}

export interface OwnAdvisoryClassification {
  package: string;
  version: string;
  advisory: string;
  kind: 'vulnerability' | 'policy';
  severity: Severity;
  basis: 'published-label' | 'own-cvss-v3-base' | 'native-own-cvss' | 'unscored-policy';
}

function cvss3Base(vector: string): number {
  const [prefix, ...parts] = vector.split('/');
  const metrics = new Map(parts.map(part => part.split(':') as [string, string]));
  if ((prefix !== 'CVSS:3.0' && prefix !== 'CVSS:3.1') || metrics.size !== 8) {
    throw new SecurityEvidenceError('osv-unsupported-published-severity');
  }
  const weight = (key: string, values: Record<string, number>) => {
    const value = values[metrics.get(key)!];
    if (value === undefined) throw new SecurityEvidenceError('osv-unsupported-published-severity');
    return value;
  };
  const cia = { N: 0, L: 0.22, H: 0.56 };
  const impactBase = 1 - (1 - weight('C', cia)) * (1 - weight('I', cia)) * (1 - weight('A', cia));
  const changed = metrics.get('S') === 'C';
  const impact = changed ? 7.52 * (impactBase - 0.029) - 3.25 * ((impactBase - 0.02) ** 15) : 6.42 * impactBase;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * weight('AV', { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }) *
    weight('AC', { L: 0.77, H: 0.44 }) * weight('PR', changed ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 }) *
    weight('UI', { N: 0.85, R: 0.62 });
  const exact = Math.min((impact + exploitability) * (changed ? 1.08 : 1), 10);
  const scaled = Math.round(exact * 100_000);
  return scaled % 10_000 === 0 ? scaled / 100_000 : (Math.floor(scaled / 10_000) + 1) / 10;
}

export function classifyPublishedAdvisory(item: PublishedAdvisoryMetadata): OwnAdvisoryClassification {
  if (item.unsupportedSeverityEntries || item.vectors.some(value => !isPublishedCvssVector(value.type, value.vector))) {
    throw new SecurityEvidenceError('osv-unsupported-published-severity');
  }
  const ownLabels = [...new Set(item.labels.map(item => item.label === 'MEDIUM' ? 'MODERATE' : item.label))];
  if (ownLabels.length > 1) throw new SecurityEvidenceError('osv-conflicting-published-severity');
  const common = { package: item.package, version: item.version, advisory: item.advisory };
  if (ownLabels.length === 1) {
    const levels: Record<PublishedLabel, Severity> = {
      CRITICAL: 'critical', HIGH: 'high', MODERATE: 'moderate', MEDIUM: 'moderate', LOW: 'low', INFO: 'info'
    };
    return { ...common, kind: 'vulnerability', severity: levels[ownLabels[0]!], basis: 'published-label' };
  }
  if (item.vectors.length) {
    const scores = item.vectors.map(value => {
      if (value.type !== 'CVSS_V3' || !isPublishedCvssVector(value.type, value.vector)) {
        throw new SecurityEvidenceError('osv-unsupported-published-severity');
      }
      return cvss3Base(value.vector);
    });
    const score = Math.max(...scores);
    return { ...common, kind: 'vulnerability', basis: 'own-cvss-v3-base',
      severity: score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'moderate' : score > 0 ? 'low' : 'info' };
  }
  return { ...common, kind: 'policy', severity: 'high', basis: 'unscored-policy' };
}

export function publishedOsvSnapshotMetadata(graph: OsvGraph, snapshot: OsvSnapshot): PublishedAdvisoryMetadata[] {
  const issues: OsvSeverityIssue[] = snapshot.matches.flatMap(match => {
    const index = graph.components.findIndex(component => component.name === match.coordinate.name &&
      component.version === match.coordinate.version && component.ecosystem === match.coordinate.ecosystem);
    if (index < 0) throw new SecurityEvidenceError('osv-advisory-component-mismatch');
    return match.ids.length ? [{
      componentIndex: index, package: match.coordinate.name, version: match.coordinate.version,
      advisories: match.ids, classification: 'missing' as const
    }] : [];
  });
  return projectPublishedAdvisories(graph, issues, snapshot);
}

export function classifyOsvSnapshot(graph: OsvGraph, snapshot: OsvSnapshot): OwnAdvisoryClassification[] {
  return publishedOsvSnapshotMetadata(graph, snapshot).map(classifyPublishedAdvisory);
}

export function nativeOwnCvssClassification(
  metadata: PublishedAdvisoryMetadata, value: SecurityReport
): OwnAdvisoryClassification {
  const report = parseSecurityReport(JSON.stringify(value));
  const finding = report.findings[0];
  if (metadata.unsupportedSeverityEntries || metadata.labels.length || !metadata.vectors.length ||
      metadata.vectors.some(vector => !isPublishedCvssVector(vector.type, vector.vector)) ||
      report.tool.name !== 'osv-scanner' || report.tool.version !== osvRelease.version ||
      report.units.length !== 1 || report.units[0]!.count !== 1 || report.findings.length !== 1 ||
      !finding || finding.kind !== 'vulnerability' || finding.rule !== metadata.advisory ||
      finding.component !== metadata.package || finding.version !== metadata.version) {
    throw new SecurityEvidenceError('osv-own-score-coverage');
  }
  return { package: metadata.package, version: metadata.version, advisory: metadata.advisory,
    kind: 'vulnerability', severity: finding.severity, basis: 'native-own-cvss' };
}

/** Metadata only: no descriptions, reference URLs, source text or inferred score. */
export function projectPublishedAdvisories(
  graph: OsvGraph, issues: readonly OsvSeverityIssue[], snapshot: OsvSnapshot
): PublishedAdvisoryMetadata[] {
  return issues.flatMap(issue => {
    const component = graph.components[issue.componentIndex];
    if (!component || component.name !== issue.package || component.version !== issue.version) {
      throw new SecurityEvidenceError('osv-advisory-component-mismatch');
    }
    return issue.advisories.map(value => {
      const id = osvAdvisoryId(value);
      const advisory = snapshot.advisories.find(item => item.id === id);
      const match = snapshot.matches.find(item => item.coordinate.name === component.name &&
        item.coordinate.version === component.version && item.coordinate.ecosystem === component.ecosystem);
      if (!advisory || !match?.ids.includes(id)) throw new SecurityEvidenceError('osv-advisory-observation-mismatch');
      if (advisory.withdrawn !== undefined) throw new SecurityEvidenceError('osv-withdrawn-result');
      const affected = list(advisory.affected).map(object).filter(item => {
        const pkg = object(item.package);
        return pkg.name === component.name && pkg.ecosystem === component.ecosystem;
      });
      if (!affected.length) throw new SecurityEvidenceError('osv-advisory-component-mismatch');
      const published: PublishedAdvisoryMetadata = {
        graph: graph.id, package: component.name, version: component.version, advisory: id,
        labels: [], vectors: [], unsupportedSeverityEntries: 0, ranges: [], fixedVersions: [],
        publishedVersionsCount: 0, classificationResolved: false
      };
      const label = (data: unknown, origin: string) => {
        if (data === undefined) return;
        const value = object(data).severity;
        if (value === undefined) return;
        const recognized = labels.find(label => label === value);
        if (recognized) published.labels.push({ origin, label: recognized });
        else published.unsupportedSeverityEntries++;
      };
      const vectors = (data: unknown) => {
        if (data === undefined) return;
        for (const value of list(data)) {
          const item = object(value);
          const type = item.type;
          const score = item.score;
          if ((type === 'CVSS_V3' || type === 'CVSS_V4') && isPublishedCvssVector(type, score)) {
            published.vectors.push({ type, vector: score });
          } else published.unsupportedSeverityEntries++;
        }
      };
      label(advisory.database_specific, 'advisory.database_specific');
      vectors(advisory.severity);
      for (const item of affected) {
        label(item.database_specific, 'affected.database_specific');
        label(item.ecosystem_specific, 'affected.ecosystem_specific');
        vectors(item.severity);
        if (item.versions !== undefined) published.publishedVersionsCount += list(item.versions).length;
        for (const value of list(item.ranges ?? [])) {
          const range = object(value);
          if (range.type !== 'SEMVER' && range.type !== 'ECOSYSTEM' && range.type !== 'GIT') {
            throw new SecurityEvidenceError('osv-advisory-metadata-range');
          }
          const type = range.type;
          const events = list(range.events).map(value => {
            const event = object(value), keys = Object.keys(event);
            if (keys.length !== 1 || !['introduced', 'fixed', 'last_affected', 'limit'].includes(keys[0]!)) {
              throw new SecurityEvidenceError('osv-advisory-metadata-range');
            }
            const kind = keys[0]!, selected = version(event[kind], type === 'GIT');
            if (kind === 'fixed' && type !== 'GIT') published.fixedVersions.push(selected);
            return { kind, version: selected };
          });
          published.ranges.push({ type, events });
        }
      }
      published.fixedVersions = [...new Set(published.fixedVersions)].sort();
      return published;
    });
  });
}
