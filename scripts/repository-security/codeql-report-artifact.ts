import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { digest, identifier, parseIdentity, portableParts, record, SecurityEvidenceError, sha } from './evidence.ts';
import { planCodeqlReporting } from './codeql-reporting.ts';
import { canonicalDigest } from './admission.ts';
import type { CodeqlCategoryResult } from './codeql-driver.ts';
import type { EvidenceIdentity } from './evidence.ts';
import { sourceRoots } from './inventory.ts';

const categories = [...new Set(sourceRoots.map(root => `source/${root.language}`))];
const message = 'CodeQL reported a source security finding. Consult the matching local finding-policy assessment.';
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function fail(code: string): never { throw new SecurityEvidenceError(`codeql-report-artifact-${code}`); }
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return fail('invalid-list');
  return value;
}
function json(source: string, maximum: number): unknown {
  if (typeof source !== 'string' || Buffer.byteLength(source) > maximum) fail('size');
  try { return JSON.parse(source); } catch { return fail('invalid-json'); }
}
function time(value: unknown, now: Date): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value ||
      Date.parse(value) > now.getTime() || now.getTime() - Date.parse(value) > 86_400_000) fail('stale-report');
  return value;
}

export interface SourceReportingInvocation {
  event: 'pull_request' | 'push' | 'schedule' | 'workflow_dispatch';
  sourceSha: string;
  workflowSha: string;
  runId: string;
  attempt: number;
  ref: string;
  fork: boolean;
  dependabot: boolean;
}

export function codeqlWorkflowInvocation(env: NodeJS.ProcessEnv): SourceReportingInvocation {
  const event = env.GITHUB_EVENT_NAME;
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'voyager163/liftoff' ||
      !['pull_request', 'push', 'schedule', 'workflow_dispatch'].includes(event ?? '') ||
      !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9][0-9]{0,5}$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
      !['true', 'false'].includes(env.LIFTOFF_REPORTING_FORK ?? '') ||
      !['true', 'false'].includes(env.LIFTOFF_REPORTING_DEPENDABOT ?? '') || !env.GITHUB_REF) fail('workflow-context');
  const invocation: SourceReportingInvocation = {
    event: event as SourceReportingInvocation['event'],
    sourceSha: sha(env.GITHUB_SHA), workflowSha: sha(env.GITHUB_WORKFLOW_SHA),
    runId: env.GITHUB_RUN_ID!, attempt: Number(env.GITHUB_RUN_ATTEMPT), ref: env.GITHUB_REF,
    fork: env.LIFTOFF_REPORTING_FORK === 'true', dependabot: env.LIFTOFF_REPORTING_DEPENDABOT === 'true'
  };
  const placeholder = `sha256:${'0'.repeat(64)}`;
  planCodeqlReporting({
    identity: { repository: 'voyager163/liftoff', event: invocation.event,
      sourceSha: invocation.sourceSha, baseSha: invocation.sourceSha, workflowSha: invocation.workflowSha,
      runId: invocation.runId, attempt: invocation.attempt,
      policyDigest: placeholder, inventoryDigest: placeholder, configurationDigest: placeholder },
    ref: invocation.ref, fork: invocation.fork, dependabot: invocation.dependabot
  });
  return invocation;
}

/** Strictly rebuild the already-sanitized format; never copy native messages, snippets or extensions. */
function sanitizedSarif(source: string, category: string, now: Date) {
  const sarif = record(json(source, 4 * 1024 * 1024), ['version', '$schema', 'runs'], 'codeql-report-artifact-schema');
  if (sarif.version !== '2.1.0' || sarif.$schema !== 'https://json.schemastore.org/sarif-2.1.0.json') fail('schema');
  const runs = array(sarif.runs, 1);
  if (runs.length !== 1) fail('schema');
  const run = record(runs[0], ['tool', 'automationDetails', 'invocations', 'results'], 'codeql-report-artifact-run');
  const automation = record(run.automationDetails, ['id'], 'codeql-report-artifact-category');
  if (automation.id !== category && automation.id !== `${category}/`) fail('category');
  const tool = record(run.tool, ['driver'], 'codeql-report-artifact-tool');
  const driver = record(tool.driver, ['name', 'semanticVersion', 'rules'], 'codeql-report-artifact-tool');
  if (driver.name !== 'CodeQL' || typeof driver.semanticVersion !== 'string' ||
      !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(driver.semanticVersion) || /[\r\n]/.test(driver.semanticVersion)) fail('tool');
  const rules = array(driver.rules, 1000).map(value => {
    const rule = record(value, ['id', 'shortDescription', 'fullDescription', 'help', 'properties'], 'codeql-report-artifact-rule');
    const description = record(rule.shortDescription, ['text'], 'codeql-report-artifact-description');
    const full = record(rule.fullDescription, ['text'], 'codeql-report-artifact-description');
    const help = record(rule.help, ['text'], 'codeql-report-artifact-description');
    const properties = record(rule.properties, ['security-severity', 'tags'], 'codeql-report-artifact-classification');
    const severity = properties['security-severity'];
    if (description.text !== 'Source security finding' || full.text !== 'Source security finding detected by CodeQL.' ||
        help.text !== 'Consult the matching local finding-policy assessment and the identified CodeQL rule.' ||
        JSON.stringify(properties.tags) !== JSON.stringify(['security']) || typeof severity !== 'string' ||
        !/^(?:[0-9](?:\.[0-9]+)?|10(?:\.0+)?)$/.test(severity) || /[\r\n]/.test(severity)) fail('classification');
    return { id: identifier(rule.id, 'codeql-report-artifact-rule'),
      shortDescription: { text: 'Source security finding' }, fullDescription: { text: full.text },
      help: { text: help.text }, properties: { 'security-severity': severity, tags: ['security'] } };
  });
  if (new Set(rules.map(rule => rule.id)).size !== rules.length) fail('duplicate-rule');
  const invocations = array(run.invocations, 1);
  if (invocations.length !== 1) fail('invocation');
  const invocation = record(invocations[0], ['executionSuccessful', 'startTimeUtc', 'endTimeUtc'], 'codeql-report-artifact-invocation');
  const start = time(invocation.startTimeUtc, now), end = time(invocation.endTimeUtc, now);
  if (invocation.executionSuccessful !== true || start > end) fail('invocation');
  const results = array(run.results, 10_000).map(value => {
    const result = record(value, ['ruleId', 'level', 'message', 'partialFingerprints', 'locations'], 'codeql-report-artifact-result');
    if (!rules.some(rule => rule.id === result.ruleId) || result.level !== 'warning' ||
        record(result.message, ['text'], 'codeql-report-artifact-message').text !== message) fail('result');
    if (!result.partialFingerprints || typeof result.partialFingerprints !== 'object') fail('fingerprint');
    const hasNative = 'primaryLocationLineHash' in result.partialFingerprints;
    const fingerprint = record(result.partialFingerprints,
      ['liftoff/scopedFindingId', ...(hasNative ? ['primaryLocationLineHash'] : [])], 'codeql-report-artifact-fingerprint');
    const findingId = identifier(fingerprint['liftoff/scopedFindingId'], 'codeql-report-artifact-fingerprint');
    if (!/^[a-f0-9]{64}$/.test(findingId)) fail('fingerprint');
    const primary = fingerprint.primaryLocationLineHash;
    if (hasNative && (typeof primary !== 'string' || !/^[a-f0-9]{16,64}:[1-9][0-9]*$/.test(primary) ||
        /[\r\n]/.test(primary))) fail('fingerprint');
    const locations = array(result.locations, 1);
    if (locations.length !== 1) fail('location');
    const physical = record(record(locations[0], ['physicalLocation'], 'codeql-report-artifact-location').physicalLocation,
      ['artifactLocation', 'region'], 'codeql-report-artifact-location');
    const uri = record(physical.artifactLocation, ['uri'], 'codeql-report-artifact-location').uri;
    if (typeof uri !== 'string' || uri.length > 4096 || uri.startsWith('/') || uri.includes('\\')) fail('location');
    let parts: string[];
    try { parts = portableParts(decodeURIComponent(uri).split('/')); } catch { return fail('location'); }
    const allowed = ['startLine', 'startColumn', 'endLine', 'endColumn', 'charOffset', 'charLength', 'byteOffset', 'byteLength'];
    if (!physical.region || typeof physical.region !== 'object' || Array.isArray(physical.region)) fail('region');
    const region = Object.fromEntries(Object.entries(physical.region).map(([key, value]) => {
      if (!allowed.includes(key) || typeof value !== 'number' || !Number.isSafeInteger(value) ||
          value < (['charOffset', 'charLength', 'byteOffset', 'byteLength'].includes(key) ? 0 : 1)) fail('region');
      return [key, value];
    }));
    if (region.startLine === undefined || region.endLine !== undefined && region.endLine < region.startLine ||
        (region.endLine === undefined || region.endLine === region.startLine) &&
        region.startColumn !== undefined && region.endColumn !== undefined && region.endColumn < region.startColumn) fail('region');
    return {
      ruleId: String(result.ruleId), level: 'warning', message: { text: message },
      partialFingerprints: { 'liftoff/scopedFindingId': findingId,
        ...(typeof primary === 'string' ? { primaryLocationLineHash: primary } : {}) },
      locations: [{ physicalLocation: {
        artifactLocation: { uri: parts.map(part => encodeURIComponent(part)).join('/') }, region
      } }]
    };
  });
  if (new Set(results.map(result => result.partialFingerprints['liftoff/scopedFindingId'])).size !== results.length) {
    fail('duplicate-finding');
  }
  return {
    sarif: JSON.stringify({ version: '2.1.0', $schema: sarif.$schema, runs: [{
      tool: { driver: { name: 'CodeQL', semanticVersion: driver.semanticVersion, rules } },
      automationDetails: { id: automation.id },
      invocations: [{ executionSuccessful: true, startTimeUtc: start, endTimeUtc: end }], results
    }] }),
    findingCount: results.length,
    nativeFingerprintCount: results.filter(result => result.partialFingerprints.primaryLocationLineHash !== undefined).length
  };
}

export function prepareCodeqlArtifactReports(source: string, invocation: SourceReportingInvocation, now: Date) {
  if (!Number.isFinite(now.getTime())) fail('time');
  const bundle = record(json(source, 10 * 1024 * 1024),
    ['schemaVersion', 'kind', 'identity', 'matrixAnalysisComplete', 'reports'], 'codeql-report-artifact-bundle');
  if (bundle.schemaVersion !== 1 || bundle.kind !== 'source-codeql-reporting-artifact' ||
      typeof bundle.matrixAnalysisComplete !== 'boolean') fail('bundle');
  const identity = parseIdentity(bundle.identity);
  if (identity.repository !== 'voyager163/liftoff' || identity.event !== invocation.event ||
      identity.sourceSha !== sha(invocation.sourceSha) || identity.workflowSha !== sha(invocation.workflowSha) ||
      identity.runId !== invocation.runId || identity.attempt !== invocation.attempt) fail('run-identity');
  const plan = planCodeqlReporting({ identity, ref: invocation.ref, fork: invocation.fork, dependabot: invocation.dependabot });
  const reports = array(bundle.reports, categories.length).map(value => {
    const item = record(value, ['category', 'reportingDigest', 'sarif', 'findingCount'], 'codeql-report-artifact-entry');
    if (typeof item.category !== 'string' || !categories.includes(item.category) || typeof item.sarif !== 'string' ||
        hash(item.sarif) !== digest(item.reportingDigest)) fail('entry');
    const safe = sanitizedSarif(item.sarif, item.category, now);
    if (safe.findingCount !== item.findingCount) fail('count');
    return { category: item.category, reportingDigest: hash(safe.sarif), findingCount: safe.findingCount,
      nativeFingerprintCount: safe.nativeFingerprintCount,
      body: { commit_sha: identity.sourceSha, ref: invocation.ref, tool_name: 'CodeQL', validate: true,
        sarif: gzipSync(Buffer.from(safe.sarif)).toString('base64') } };
  });
  if (reports.length !== categories.length || new Set(reports.map(report => report.category)).size !== categories.length) {
    fail('missing-category');
  }
  return {
    kind: 'validated-source-reporting-data' as const, plan, reports,
    matrixAnalysisComplete: bundle.matrixAnalysisComplete,
    findingVerdictChanged: false, admissionQualified: false, publicationQualified: false
  };
}

export function createCodeqlReportingBundle(
  identity: EvidenceIdentity, outcomes: readonly CodeqlCategoryResult[], matrixAnalysisComplete: boolean
) {
  const reports = categories.map(category => {
    const selected = outcomes.filter(outcome => outcome.category === category);
    const result = selected[0], payload = result?.sourceReporting;
    if (selected.length !== 1 || result?.status !== 'complete' || !payload ||
        canonicalDigest(payload.identity) !== canonicalDigest(identity)) fail('missing-category');
    return { category, reportingDigest: payload.reportingDigest, sarif: payload.sarif, findingCount: payload.findingCount };
  });
  const value = JSON.stringify({
    schemaVersion: 1, kind: 'source-codeql-reporting-artifact', identity, matrixAnalysisComplete, reports
  });
  if (Buffer.byteLength(value) > 10 * 1024 * 1024) fail('size');
  return value;
}

export interface CodeqlReportingTransport {
  submit(body: ReturnType<typeof prepareCodeqlArtifactReports>['reports'][number]['body']): Promise<{ status: number; id: unknown }>;
  status(id: string): Promise<{ status: number; processingStatus: unknown; errorCount: number }>;
  wait(): Promise<void>;
}

/** Fixed bounded reporting protocol; permission failure never changes the underlying finding verdict. */
export async function deliverCodeqlArtifactReports(
  prepared: ReturnType<typeof prepareCodeqlArtifactReports>, transport: CodeqlReportingTransport
) {
  const outcomes: { category: string; status: 'uploaded' | 'unavailable' }[] = [];
  for (const report of prepared.reports) {
    let submitted: Awaited<ReturnType<CodeqlReportingTransport['submit']>>;
    try { submitted = await transport.submit(report.body); } catch { return fail('transport-error'); }
    if (submitted.status === 403) {
      outcomes.push({ category: report.category, status: 'unavailable' });
      continue;
    }
    if (submitted.status !== 202 || typeof submitted.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(submitted.id)) fail('submission-rejected');
    let completed = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      let result: Awaited<ReturnType<CodeqlReportingTransport['status']>>;
      try { result = await transport.status(submitted.id); } catch { return fail('transport-error'); }
      if (result.status !== 200 || !Number.isSafeInteger(result.errorCount) || result.errorCount !== 0) fail('processing-error');
      if (result.processingStatus === 'complete') { completed = true; break; }
      if (result.processingStatus !== 'pending') fail('processing-error');
      try { await transport.wait(); } catch { return fail('transport-error'); }
    }
    if (!completed) fail('processing-timeout');
    outcomes.push({ category: report.category, status: 'uploaded' });
  }
  return { kind: 'source-reporting-outcome', outcomes, available: outcomes.every(item => item.status === 'uploaded'),
    findingVerdictChanged: false, hostedProtectionQualified: false, publicationQualified: false };
}
