import { createHash } from 'node:crypto';

export class SecurityEvidenceError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Security evidence rejected: ${code}.`);
    this.name = 'SecurityEvidenceError';
    this.code = code;
  }
}

export type SecurityEvent = 'pull_request' | 'push' | 'schedule' | 'workflow_dispatch';
export type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

export interface EvidenceIdentity {
  repository: string;
  event: SecurityEvent;
  sourceSha: string;
  baseSha: string;
  workflowSha: string;
  runId: string;
  attempt: number;
  policyDigest: string;
  inventoryDigest: string;
  configurationDigest: string;
}

export interface SecurityFinding {
  id: string;
  kind: 'vulnerability' | 'policy';
  tool: string;
  rule: string;
  scope: string;
  component: string;
  version: string;
  chains: string[][];
  location: string[];
  artifactDigest: string;
  severity: Severity;
  owner: string;
  policyClass?: 'osv-valid-unscored-advisory' | 'trivy-valid-native-unscored-advisory';
  upstreamSeverity?: 'unscored' | 'UNKNOWN';
}

export interface SecurityReport {
  schemaVersion: 1;
  role: string;
  identity: EvidenceIdentity;
  tool: { name: string; version: string; database: string };
  generatedAt: string;
  completedAt: string;
  complete: true;
  units: { id: string; inputDigest: string; count: number; platform: string }[];
  findings: SecurityFinding[];
}

export interface VulnerabilityException {
  findingDigest: string;
  disposition: 'mitigated' | 'vulnerable-code-not-used';
  owner: string;
  rationale: string;
  mitigation: string;
  reviewedAt: string;
  reviewBy: string;
}

export interface Policy {
  blockingRules: readonly { tool: string; rule: string }[];
  exceptions: readonly VulnerabilityException[];
}

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const shaPattern = /^[0-9a-f]{40}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,199}$/;
const severities: readonly Severity[] = ['info', 'low', 'moderate', 'high', 'critical'];
const events: readonly SecurityEvent[] = ['pull_request', 'push', 'schedule', 'workflow_dispatch'];
const identityKeys = [
  'repository', 'event', 'sourceSha', 'baseSha', 'workflowSha', 'runId', 'attempt',
  'policyDigest', 'inventoryDigest', 'configurationDigest'
];

export function record(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SecurityEvidenceError(code);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key)) || keys.some(key => !(key in result))) {
    throw new SecurityEvidenceError(code);
  }
  return result;
}

export function text(value: unknown, code: string, limit = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) {
    throw new SecurityEvidenceError(code);
  }
  return value;
}

export function identifier(value: unknown, code: string): string {
  const result = text(value, code, 200);
  if (!idPattern.test(result)) throw new SecurityEvidenceError(code);
  return result;
}

export function digest(value: unknown): string {
  if (typeof value !== 'string' || !digestPattern.test(value)) throw new SecurityEvidenceError('invalid-digest');
  return value;
}

export function sha(value: unknown): string {
  if (typeof value !== 'string' || !shaPattern.test(value)) throw new SecurityEvidenceError('invalid-revision');
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SecurityEvidenceError(code);
  }
  return value;
}

function list(value: unknown, minimum: number, maximum: number, code: string): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new SecurityEvidenceError(code);
  return value;
}

export function portableParts(value: unknown): string[] {
  return list(value, 1, 40, 'invalid-location').map(part => {
    const result = text(part, 'invalid-location', 200);
    if (result === '.' || result === '..' || /[\\/:*?"<>|]/.test(result) ||
        /[. ]$/.test(result) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) {
      throw new SecurityEvidenceError('unsafe-location');
    }
    return result;
  });
}

function isoTime(value: unknown): string {
  const result = text(value, 'invalid-time', 30);
  const stamp = Date.parse(result);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString() !== result) throw new SecurityEvidenceError('invalid-time');
  return result;
}

function isoDate(value: unknown): string {
  const result = text(value, 'invalid-date', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new SecurityEvidenceError('invalid-date');
  isoTime(`${result}T00:00:00.000Z`);
  return result;
}

export function parseIdentity(value: unknown): EvidenceIdentity {
  const item = record(value, identityKeys, 'invalid-identity');
  const repository = text(item.repository, 'invalid-repository', 200);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new SecurityEvidenceError('invalid-repository');
  const event = events.find(event => event === item.event);
  if (!event) throw new SecurityEvidenceError('invalid-event');
  const runId = text(item.runId, 'invalid-run', 30);
  if (!/^[1-9][0-9]*$/.test(runId)) throw new SecurityEvidenceError('invalid-run');
  return {
    repository, event, sourceSha: sha(item.sourceSha), baseSha: sha(item.baseSha),
    workflowSha: sha(item.workflowSha), runId,
    attempt: integer(item.attempt, 1, 1_000_000, 'invalid-attempt'),
    policyDigest: digest(item.policyDigest), inventoryDigest: digest(item.inventoryDigest),
    configurationDigest: digest(item.configurationDigest)
  };
}

export function parseFinding(value: unknown): SecurityFinding {
  const policyMetadata = value !== null && typeof value === 'object' &&
    (Object.hasOwn(value, 'policyClass') || Object.hasOwn(value, 'upstreamSeverity'));
  const item = record(value, [
    'id', 'kind', 'tool', 'rule', 'scope', 'component', 'version', 'chains', 'location',
    'artifactDigest', 'severity', 'owner', ...(policyMetadata ? ['policyClass', 'upstreamSeverity'] : [])
  ], 'invalid-finding');
  if (item.kind !== 'vulnerability' && item.kind !== 'policy') throw new SecurityEvidenceError('invalid-finding-kind');
  const severity = severities.find(severity => severity === item.severity);
  if (!severity) throw new SecurityEvidenceError('invalid-severity');
  const osvUnscored = item.policyClass === 'osv-valid-unscored-advisory' && item.upstreamSeverity === 'unscored' &&
    item.tool === 'osv-scanner' && typeof item.rule === 'string' &&
    /^(?:GO-[0-9]{4}-[0-9]+|PYSEC-[0-9]{4}-[0-9]+|CVE-[0-9]{4}-[0-9]{4,}|GHSA-[23456789cfghjmpqrvwx]{4}(?:-[23456789cfghjmpqrvwx]{4}){2})$/.test(item.rule);
  const location = portableParts(item.location);
  const trivyUnscored = item.policyClass === 'trivy-valid-native-unscored-advisory' && item.upstreamSeverity === 'UNKNOWN' &&
    item.tool === 'trivy' && typeof item.rule === 'string' &&
    (/^(?:GO-[0-9]{4}-[0-9]+|CVE-[0-9]{4}-[0-9]{4,}|GHSA-[23456789cfghjmpqrvwx]{4}(?:-[23456789cfghjmpqrvwx]{4}){2})$/.test(item.rule) ||
      /^(?:TEMP-[0-9]{7}-[A-F0-9]{6}|DLA-[1-9][0-9]{0,6}-[1-9][0-9]{0,2})$/.test(item.rule) &&
        location[1] === 'os-pkgs' && location[2] === 'debian') &&
    location.length === 4 && location[0] === 'image' &&
    ['os-pkgs', 'lang-pkgs'].includes(location[1]!) && /^[a-f0-9]{64}$/.test(location[3]!) &&
    typeof item.component === 'string' && digestPattern.test(item.component) &&
    typeof item.version === 'string' && digestPattern.test(item.version);
  if (policyMetadata && ((!osvUnscored && !trivyUnscored) || item.kind !== 'policy' || severity !== 'high')) {
    throw new SecurityEvidenceError('invalid-unscored-policy-finding');
  }
  const chains = list(item.chains, 1, 100, 'invalid-chains').map(chain =>
    list(chain, 1, 50, 'invalid-chain').map(component => identifier(component, 'invalid-component')));
  if (new Set(chains.map(chain => JSON.stringify(chain))).size !== chains.length) {
    throw new SecurityEvidenceError('duplicate-chain');
  }
  return {
    id: identifier(item.id, 'invalid-finding-id'), kind: item.kind,
    tool: identifier(item.tool, 'invalid-tool'), rule: identifier(item.rule, 'invalid-rule'),
    scope: identifier(item.scope, 'invalid-scope'), component: identifier(item.component, 'invalid-component'),
    version: identifier(item.version, 'invalid-version'), chains,
    location, artifactDigest: digest(item.artifactDigest),
    severity, owner: identifier(item.owner, 'missing-owner'),
    ...(policyMetadata ? trivyUnscored
      ? { policyClass: 'trivy-valid-native-unscored-advisory' as const, upstreamSeverity: 'UNKNOWN' as const }
      : { policyClass: 'osv-valid-unscored-advisory' as const, upstreamSeverity: 'unscored' as const } : {})
  };
}

export function parseSecurityReport(source: string): SecurityReport {
  if (Buffer.byteLength(source, 'utf8') > 4 * 1024 * 1024) throw new SecurityEvidenceError('report-too-large');
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new SecurityEvidenceError('invalid-report-json'); }
  const item = record(value, [
    'schemaVersion', 'role', 'identity', 'tool', 'generatedAt', 'completedAt', 'complete', 'units', 'findings'
  ], 'invalid-report');
  if (item.schemaVersion !== 1 || item.complete !== true) throw new SecurityEvidenceError('incomplete-report');
  const tool = record(item.tool, ['name', 'version', 'database'], 'invalid-tool');
  const units = list(item.units, 1, 500, 'missing-coverage').map(value => {
    const unit = record(value, ['id', 'inputDigest', 'count', 'platform'], 'invalid-unit');
    return {
      id: identifier(unit.id, 'invalid-unit'), inputDigest: digest(unit.inputDigest),
      count: integer(unit.count, 1, 10_000_000, 'empty-coverage'),
      platform: identifier(unit.platform, 'invalid-platform')
    };
  });
  if (new Set(units.map(unit => unit.id)).size !== units.length) throw new SecurityEvidenceError('duplicate-unit');
  const findings = list(item.findings, 0, 20_000, 'invalid-findings').map(parseFinding);
  if (new Set(findings.map(finding => finding.id)).size !== findings.length) throw new SecurityEvidenceError('duplicate-finding');
  if (findings.some(finding => !units.some(unit => unit.id === finding.scope && unit.inputDigest === finding.artifactDigest))) {
    throw new SecurityEvidenceError('finding-outside-coverage');
  }
  if (findings.some(finding => finding.tool !== tool.name)) throw new SecurityEvidenceError('finding-tool-mismatch');
  const generatedAt = isoTime(item.generatedAt), completedAt = isoTime(item.completedAt);
  if (completedAt < generatedAt) throw new SecurityEvidenceError('invalid-time-order');
  return {
    schemaVersion: 1, role: identifier(item.role, 'invalid-role'), identity: parseIdentity(item.identity),
    tool: { name: identifier(tool.name, 'invalid-tool'), version: identifier(tool.version, 'invalid-version'),
      database: identifier(tool.database, 'missing-database-identity') },
    generatedAt, completedAt, complete: true, units, findings
  };
}

export function findingDigest(value: SecurityFinding): string {
  const finding = parseFinding(value);
  return `sha256:${createHash('sha256').update(JSON.stringify({
    ...finding, chains: finding.chains.map(chain => [...chain]).sort((a, b) => {
      const left = JSON.stringify(a), right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    })
  })).digest('hex')}`;
}

export function parseVulnerabilityException(value: unknown): VulnerabilityException {
  const item = record(value, [
    'findingDigest', 'disposition', 'owner', 'rationale', 'mitigation', 'reviewedAt', 'reviewBy'
  ], 'invalid-exception');
  if (item.disposition !== 'mitigated' && item.disposition !== 'vulnerable-code-not-used') {
    throw new SecurityEvidenceError('invalid-exception-disposition');
  }
  return {
    findingDigest: digest(item.findingDigest), disposition: item.disposition,
    owner: identifier(item.owner, 'missing-owner'), rationale: text(item.rationale, 'missing-rationale'),
    mitigation: text(item.mitigation, 'missing-mitigation'), reviewedAt: isoDate(item.reviewedAt), reviewBy: isoDate(item.reviewBy)
  };
}

export function requireExceptionWindow(
  exception: VulnerabilityException, severity: Severity, now: Date
): void {
  const start = Date.parse(exception.reviewedAt), end = Date.parse(exception.reviewBy);
  const days = (end - start) / 86_400_000;
  const maximumDays = severity === 'high' || severity === 'critical' ? 30 : 90;
  if (!Number.isFinite(now.getTime())) throw new SecurityEvidenceError('invalid-exception-window');
  const today = Date.parse(now.toISOString().slice(0, 10));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > today || end < today || days < 0 || days > maximumDays) {
    throw new SecurityEvidenceError('invalid-exception-window');
  }
}

export function evaluateSecurityReport(
  value: SecurityReport,
  expected: Pick<SecurityReport, 'identity' | 'role' | 'tool' | 'units'>,
  policy: Policy, now: Date
): { passed: boolean; blocking: string[]; reviewed: string[]; tracked: string[] } {
  const report = parseSecurityReport(JSON.stringify(value));
  const identity = parseIdentity(expected.identity);
  if (JSON.stringify(report.identity) !== JSON.stringify(identity)) throw new SecurityEvidenceError('identity-mismatch');
  if (report.role !== expected.role || report.tool.name !== expected.tool.name ||
      report.tool.version !== expected.tool.version || report.tool.database !== expected.tool.database) {
    throw new SecurityEvidenceError('producer-mismatch');
  }
  if (!Number.isFinite(now.getTime()) || Date.parse(report.completedAt) > now.getTime() ||
      now.getTime() - Date.parse(report.generatedAt) > 24 * 60 * 60 * 1000) {
    throw new SecurityEvidenceError('stale-evidence');
  }
  const expectedUnits = expected.units;
  if (expectedUnits.length === 0 || new Set(expectedUnits.map(unit => unit.id)).size !== expectedUnits.length ||
      report.units.length !== expectedUnits.length || expectedUnits.some(expected =>
        !report.units.some(unit => unit.id === expected.id && unit.inputDigest === expected.inputDigest &&
          unit.count === expected.count && unit.platform === expected.platform))) {
    throw new SecurityEvidenceError('coverage-mismatch');
  }
  const rules = policy.blockingRules.map(value => {
    const rule = record(value, ['tool', 'rule'], 'invalid-policy-rule');
    return `${identifier(rule.tool, 'invalid-tool')}\0${identifier(rule.rule, 'invalid-rule')}`;
  });
  if (new Set(rules).size !== rules.length) throw new SecurityEvidenceError('duplicate-policy-rule');
  const exceptions = policy.exceptions.map(parseVulnerabilityException);
  if (new Set(exceptions.map(item => item.findingDigest)).size !== exceptions.length) throw new SecurityEvidenceError('duplicate-exception');
  if (exceptions.some(item => !report.findings.some(finding => findingDigest(finding) === item.findingDigest))) {
    throw new SecurityEvidenceError('stale-exception');
  }
  const result = { passed: true, blocking: [] as string[], reviewed: [] as string[], tracked: [] as string[] };
  for (const finding of report.findings) {
    const blocked = finding.kind === 'policy'
      ? rules.includes(`${finding.tool}\0${finding.policyClass ?? finding.rule}`)
      : finding.severity === 'high' || finding.severity === 'critical';
    if (finding.kind === 'policy' && !blocked) throw new SecurityEvidenceError('unmapped-policy-rule');
    const exception = exceptions.find(item => item.findingDigest === findingDigest(finding));
    if (exception) {
      requireExceptionWindow(exception, finding.severity, now);
      result.reviewed.push(finding.id);
    } else if (blocked) {
      result.blocking.push(finding.id);
    } else {
      result.tracked.push(finding.id);
    }
  }
  result.passed = result.blocking.length === 0;
  return result;
}

export function requireSuccessfulRoles(
  expected: readonly string[],
  actual: readonly { role: string; conclusion: string; evidencePassed: boolean }[]
): void {
  if (expected.length === 0 || new Set(expected).size !== expected.length ||
      new Set(actual.map(item => item.role)).size !== actual.length || actual.length !== expected.length) {
    throw new SecurityEvidenceError('role-coverage-mismatch');
  }
  for (const role of expected) {
    const result = actual.find(item => item.role === role);
    if (!result || result.conclusion !== 'success' || result.evidencePassed !== true) {
      throw new SecurityEvidenceError('required-role-not-successful');
    }
  }
}
