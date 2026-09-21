import { createHash } from 'node:crypto';
import { sourceRoots } from './inventory.ts';
import {
  identifier, parseIdentity, parseSecurityReport, portableParts, SecurityEvidenceError,
  digest, type EvidenceIdentity, type SecurityReport, type Severity
} from './evidence.ts';

export interface CodeqlScope {
  category: string;
  identity: EvidenceIdentity;
  tool: SecurityReport['tool'];
  role: string;
  unit: SecurityReport['units'][number];
  sourcePaths: string[][];
  inputPaths?: string[][];
  extractedPaths: string[][];
  nonSecurityRules: readonly string[];
  expectedRules?: readonly string[];
  requireDriverRules?: boolean;
  execution?: {
    category: string;
    toolVersion: string;
    reportDigest: string;
    startedAt: string;
    completedAt: string;
    exitCode: number;
  };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SecurityEvidenceError('invalid-sarif-object');
  return value as Record<string, unknown>;
}

function array(value: unknown, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 100_000) throw new SecurityEvidenceError('invalid-sarif-array');
  return value;
}

function referenceIndex(value: unknown, length: number, code: string): number | undefined {
  // SARIF uses -1 as the unspecified-index sentinel.
  if (value === undefined || value === -1) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= length) {
    throw new SecurityEvidenceError(code);
  }
  return value;
}

function location(value: unknown): { parts: string[]; key: string } {
  const uri = object(value).uri;
  if (typeof uri !== 'string' || uri.length > 4096 || uri.includes('\\') || uri.startsWith('/')) {
    throw new SecurityEvidenceError('invalid-sarif-location');
  }
  let decoded: string;
  try { decoded = decodeURIComponent(uri); } catch { throw new SecurityEvidenceError('invalid-sarif-location'); }
  const parts = portableParts(decoded.split('/'));
  return { parts, key: parts.join('/') };
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\dT/.test(value)) {
    throw new SecurityEvidenceError('missing-sarif-time');
  }
  const stamp = Date.parse(value);
  if (!Number.isFinite(stamp)) throw new SecurityEvidenceError('invalid-sarif-time');
  return new Date(stamp).toISOString();
}

function severity(value: unknown): Severity {
  if (typeof value !== 'string' || !/^(?:[0-9](?:\.[0-9]+)?|10(?:\.0+)?)$/.test(value)) {
    throw new SecurityEvidenceError('unmapped-codeql-severity');
  }
  const number = Number(value);
  return number >= 9 ? 'critical' : number >= 7 ? 'high' : number >= 4 ? 'moderate' : number > 0 ? 'low' : 'info';
}

function canonicalResult(value: unknown, depth = 0): string {
  if (depth > 32) throw new SecurityEvidenceError('codeql-result-too-deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalResult(item, depth + 1)).join(',')}]`;
  const record = object(value);
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalResult(record[key], depth + 1)}`).join(',')}}`;
}

function resultIdentity(result: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalResult({
    message: object(result.message),
    fingerprints: result.fingerprints ?? null,
    partialFingerprints: result.partialFingerprints ?? null,
    codeFlows: result.codeFlows ?? null,
    relatedLocations: result.relatedLocations ?? null
  })).digest('hex');
}

function regionIdentity(value: unknown): Record<string, number> {
  const region = object(value);
  const identity: Record<string, number> = {};
  for (const name of ['startLine', 'startColumn', 'endLine', 'endColumn', 'charOffset', 'charLength', 'byteOffset', 'byteLength']) {
    if (region[name] === undefined && name !== 'startLine') continue;
    const number = region[name];
    const minimum = ['charOffset', 'charLength', 'byteOffset', 'byteLength'].includes(name) ? 0 : 1;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < minimum) {
      throw new SecurityEvidenceError('invalid-codeql-region');
    }
    identity[name] = number;
  }
  if (identity.endLine !== undefined && identity.endLine < identity.startLine! ||
      (identity.endLine === undefined || identity.endLine === identity.startLine) &&
        identity.startColumn !== undefined && identity.endColumn !== undefined &&
        identity.endColumn < identity.startColumn) throw new SecurityEvidenceError('invalid-codeql-region');
  return identity;
}

interface ReportingLocation {
  id: string; rule: string; securitySeverity: string; parts: string[]; region: Record<string, number>;
  primaryLocationLineHash?: string;
}

function inspectCodeqlSarif(source: string, scope: CodeqlScope, reporting: ReportingLocation[]): SecurityReport {
  if (Buffer.byteLength(source) > 4 * 1024 * 1024) throw new SecurityEvidenceError('sarif-too-large');
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { throw new SecurityEvidenceError('invalid-sarif-json'); }
  const sarif = object(parsed);
  if (sarif.version !== '2.1.0') throw new SecurityEvidenceError('unsupported-sarif-version');
  const runs = array(sarif.runs, 1);
  if (runs.length !== 1) throw new SecurityEvidenceError('ambiguous-codeql-category');
  const run = object(runs[0]);
  if (object(run.automationDetails).id !== scope.category) throw new SecurityEvidenceError('codeql-category-mismatch');
  const tool = object(run.tool), driver = object(tool.driver);
  if (driver.name !== 'CodeQL' || driver.semanticVersion !== scope.tool.version || scope.tool.name !== 'CodeQL') {
    throw new SecurityEvidenceError('codeql-tool-mismatch');
  }
  const invocations = array(run.invocations, 1).map(object);
  if (invocations.some(invocation => invocation.executionSuccessful !== true ||
      invocation.exitCode !== undefined && invocation.exitCode !== 0 ||
      invocation.toolExecutionNotifications !== undefined &&
        array(invocation.toolExecutionNotifications).some(value => object(value).level === 'error'))) {
    throw new SecurityEvidenceError('codeql-analysis-failed');
  }
  const execution = scope.execution;
  if (execution !== undefined) {
    if (invocations.length !== 1 || execution.exitCode !== 0 || execution.category !== scope.category ||
        execution.toolVersion !== scope.tool.version ||
        execution.reportDigest !== `sha256:${createHash('sha256').update(source).digest('hex')}`) {
      throw new SecurityEvidenceError('codeql-execution-mismatch');
    }
    if (timestamp(execution.completedAt) < timestamp(execution.startedAt)) {
      throw new SecurityEvidenceError('codeql-execution-time-order');
    }
  }
  // The native CLI omits invocation times. Only an independently captured,
  // report-digest-bound execution envelope may supply those missing fields.
  const starts = invocations.map(invocation =>
    timestamp(invocation.startTimeUtc === undefined ? execution?.startedAt : invocation.startTimeUtc)).sort();
  const ends = invocations.map(invocation =>
    timestamp(invocation.endTimeUtc === undefined ? execution?.completedAt : invocation.endTimeUtc)).sort();
  if (execution && (starts[0]! < timestamp(execution.startedAt) || ends.at(-1)! > timestamp(execution.completedAt))) {
    throw new SecurityEvidenceError('codeql-execution-time-mismatch');
  }
  const paths = scope.sourcePaths.map(parts => portableParts(parts).join('/'));
  if (paths.length === 0 || new Set(paths).size !== paths.length || paths.length !== scope.unit.count) {
    throw new SecurityEvidenceError('invalid-codeql-source-inventory');
  }
  // SARIF lists referenced artifacts, not every successfully extracted source file.
  const extracted = scope.extractedPaths.map(parts => portableParts(parts).join('/'));
  if (new Set(extracted).size !== extracted.length || extracted.length !== paths.length ||
      extracted.some(value => !paths.includes(value))) throw new SecurityEvidenceError('incomplete-codeql-source-coverage');
  const inputs = (scope.inputPaths ?? scope.sourcePaths).map(parts => portableParts(parts).join('/'));
  if (inputs.length > 10_000 || new Set(inputs.map(value => value.toLowerCase())).size !== inputs.length ||
      paths.some(value => !inputs.includes(value))) throw new SecurityEvidenceError('invalid-codeql-input-inventory');
  const reportedPaths = run.artifacts === undefined ? [] : array(run.artifacts).map(value => location(object(value).location).key);
  if (reportedPaths.some(value => !inputs.includes(value))) throw new SecurityEvidenceError('codeql-artifact-outside-scope');
  const extensions = tool.extensions === undefined ? [] : array(tool.extensions).map(object);
  if (scope.requireDriverRules && extensions.some(extension =>
    extension.rules !== undefined && array(extension.rules).length > 0)) {
    throw new SecurityEvidenceError('codeql-rule-layout-mismatch');
  }
  const pack = /^([^@]+)@([^@]+)$/.exec(scope.tool.database);
  for (const extension of extensions) {
    // Native reports also list dependency packs with no rule descriptors.
    // They confer no execution evidence and cannot resolve a finding.
    if (extension.rules === undefined || array(extension.rules).length === 0) continue;
    if (!pack || extension.name !== pack[1] ||
        (extension.semanticVersion ?? extension.version) !== pack[2] ||
        extension.semanticVersion !== undefined && extension.version !== undefined &&
          extension.semanticVersion !== extension.version) {
      throw new SecurityEvidenceError('codeql-extension-mismatch');
    }
  }
  const components = [driver, ...extensions];
  const componentRules = components.map(component => component.rules === undefined ? [] : array(component.rules).map(object));
  const rules = componentRules.flat();
  const ruleIds = rules.map(rule => identifier(rule.id, 'invalid-codeql-rule'));
  if (new Set(ruleIds).size !== ruleIds.length) throw new SecurityEvidenceError('duplicate-codeql-rule');
  if (new Set(scope.nonSecurityRules).size !== scope.nonSecurityRules.length ||
      scope.nonSecurityRules.some(rule => scope.expectedRules?.includes(rule))) {
    throw new SecurityEvidenceError('codeql-rule-classification-mismatch');
  }
  const securityRuleIds = ruleIds.filter(rule => !scope.nonSecurityRules.includes(rule));
  if (scope.expectedRules !== undefined && (scope.expectedRules.length === 0 ||
      new Set(scope.expectedRules).size !== scope.expectedRules.length ||
      securityRuleIds.length !== scope.expectedRules.length || securityRuleIds.some(rule => !scope.expectedRules!.includes(rule)))) {
    throw new SecurityEvidenceError('codeql-query-coverage-mismatch');
  }
  for (const rule of rules) {
    const properties = rule.properties === undefined ? {} : object(rule.properties);
    if (scope.nonSecurityRules.includes(String(rule.id))) {
      if (properties['security-severity'] !== undefined) throw new SecurityEvidenceError('codeql-rule-classification-mismatch');
    } else severity(properties['security-severity']);
  }
  const inputDigest = digest(scope.unit.inputDigest);
  const configurationDigest = digest(scope.identity.configurationDigest);
  const findings: SecurityReport['findings'] = [];
  const seenFindings = new Set<string>();
  for (const value of array(run.results)) {
    const result = object(value);
    const reference = result.rule === undefined ? {} : object(result.rule);
    let componentIndex = 0;
    if (reference.toolComponent !== undefined) {
      const component = object(reference.toolComponent);
      const index = referenceIndex(component.index, extensions.length, 'unknown-codeql-component');
      if (index !== undefined) componentIndex = index + 1;
      else if (component.name !== undefined || component.guid !== undefined) {
        const matches = components.flatMap((item, position) =>
          (component.name === undefined || item.name === component.name) &&
          (component.guid === undefined || item.guid === component.guid) ? [position] : []);
        if (matches.length !== 1) throw new SecurityEvidenceError('unknown-codeql-component');
        componentIndex = matches[0]!;
      }
      const registered = components[componentIndex]!;
      if (component.name !== undefined && component.name !== registered.name ||
          component.guid !== undefined && component.guid !== registered.guid) throw new SecurityEvidenceError('unknown-codeql-component');
    }
    const selectedRules = componentRules[componentIndex]!;
    const topIndex = referenceIndex(result.ruleIndex, componentRules[0]!.length, 'unknown-codeql-rule');
    const index = referenceIndex(reference.index, selectedRules.length, 'unknown-codeql-rule') ??
      (componentIndex === 0 ? topIndex : undefined);
    const indexedRule = index === undefined ? undefined : selectedRules[index];
    const guidRules = reference.guid === undefined ? [] : selectedRules.filter(rule => rule.guid === reference.guid);
    if (reference.guid !== undefined && guidRules.length !== 1) throw new SecurityEvidenceError('unknown-codeql-rule');
    const ruleId = identifier(result.ruleId ?? reference.id ?? indexedRule?.id ?? guidRules[0]?.id, 'invalid-codeql-rule');
    const rule = selectedRules.find(rule => rule.id === ruleId);
    if (!rule || reference.id !== undefined && reference.id !== ruleId ||
        indexedRule !== undefined && indexedRule.id !== ruleId ||
        reference.guid !== undefined && reference.guid !== rule.guid ||
        topIndex !== undefined && (componentIndex !== 0 || topIndex !== selectedRules.indexOf(rule))) {
      throw new SecurityEvidenceError('unknown-codeql-rule');
    }
    if (result.suppressions !== undefined && array(result.suppressions).length > 0) {
      throw new SecurityEvidenceError('unapproved-sarif-suppression');
    }
    if (scope.nonSecurityRules.includes(ruleId)) continue;
    const level = severity(object(rule.properties)['security-severity']);
    const resultKey = resultIdentity(result);
    for (const [locationIndex, value] of array(result.locations, 1).entries()) {
      const physical = object(object(value).physicalLocation);
      const file = location(physical.artifactLocation);
      if (!inputs.includes(file.key)) throw new SecurityEvidenceError('codeql-finding-outside-scope');
      const region = regionIdentity(physical.region);
      const id = createHash('sha256').update(JSON.stringify([
        scope.category, scope.tool.name, scope.tool.version, scope.tool.database,
        inputDigest, configurationDigest, ruleId, file.key, region, resultKey
      ])).digest('hex');
      if (seenFindings.has(id)) continue;
      seenFindings.add(id);
      const nativeFingerprint = result.partialFingerprints === undefined ? undefined
        : object(result.partialFingerprints).primaryLocationLineHash;
      if (nativeFingerprint !== undefined && (typeof nativeFingerprint !== 'string' ||
          !/^[a-f0-9]{16,64}:[1-9][0-9]*$/.test(nativeFingerprint) || /[\r\n]/.test(nativeFingerprint))) {
        throw new SecurityEvidenceError('invalid-codeql-line-fingerprint');
      }
      reporting.push({
        id, rule: ruleId, securitySeverity: String(object(rule.properties)['security-severity']),
        parts: file.parts, region,
        ...(locationIndex === 0 && typeof nativeFingerprint === 'string' ? { primaryLocationLineHash: nativeFingerprint } : {})
      });
      findings.push({
        id, kind: 'vulnerability', tool: 'CodeQL', rule: ruleId, scope: scope.unit.id,
        component: 'source', version: inputDigest, chains: [[ruleId]],
        location: file.parts, artifactDigest: scope.unit.inputDigest, severity: level,
        owner: 'voyager163'
      });
    }
  }
  return parseSecurityReport(JSON.stringify({
    schemaVersion: 1, role: scope.role, identity: parseIdentity(scope.identity), tool: scope.tool,
    generatedAt: starts[0], completedAt: ends.at(-1), complete: true, units: [scope.unit], findings
  }));
}

export function normalizeCodeqlSarif(source: string, scope: CodeqlScope): SecurityReport {
  return inspectCodeqlSarif(source, scope, []);
}

/** Rebuild source-only SARIF from validated metadata; never copy messages, snippets or code flows. */
export function sourceCodeqlReportingPayload(source: string, scope: CodeqlScope) {
  const category = scope.category.endsWith('/') ? scope.category.slice(0, -1) : scope.category;
  if (scope.role !== 'source-findings' || !sourceRoots.some(root => `source/${root.language}` === category)) {
    throw new SecurityEvidenceError('codeql-reporting-source-only');
  }
  const locations: ReportingLocation[] = [];
  const report = inspectCodeqlSarif(source, scope, locations);
  const rules = [...new Map(locations.map(item => [item.rule, {
    id: item.rule, shortDescription: { text: 'Source security finding' },
    fullDescription: { text: 'Source security finding detected by CodeQL.' },
    help: { text: 'Consult the matching local finding-policy assessment and the identified CodeQL rule.' },
    properties: { 'security-severity': item.securitySeverity, tags: ['security'] }
  }])).values()];
  const sarif = JSON.stringify({
    version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{
      tool: { driver: { name: 'CodeQL', semanticVersion: scope.tool.version, rules } },
      automationDetails: { id: scope.category },
      invocations: [{ executionSuccessful: true, startTimeUtc: report.generatedAt, endTimeUtc: report.completedAt }],
      results: locations.map(item => ({
        ruleId: item.rule, level: 'warning',
        message: { text: 'CodeQL reported a source security finding. Consult the matching local finding-policy assessment.' },
        partialFingerprints: { 'liftoff/scopedFindingId': item.id,
          ...(item.primaryLocationLineHash ? { primaryLocationLineHash: item.primaryLocationLineHash } : {}) },
        locations: [{ physicalLocation: {
          artifactLocation: { uri: item.parts.map(part => encodeURIComponent(part)).join('/') },
          region: item.region
        } }]
      }))
    }]
  });
  return {
    kind: 'sanitized-source-codeql-report', identity: report.identity, category: scope.category,
    sourceReportDigest: `sha256:${createHash('sha256').update(source).digest('hex')}`,
    reportingDigest: `sha256:${createHash('sha256').update(sarif).digest('hex')}`,
    sarif, findingCount: report.findings.length,
    nativeFingerprintCount: locations.filter(item => item.primaryLocationLineHash !== undefined).length,
    findingsEvaluated: false, uploadPerformed: false, hostedProtectionQualified: false
  };
}
