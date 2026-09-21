import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sourceCodeqlReportingPayload, type CodeqlScope } from '../scripts/repository-security/codeql.ts';
import {
  codeqlWorkflowInvocation, createCodeqlReportingBundle, deliverCodeqlArtifactReports, prepareCodeqlArtifactReports,
  type CodeqlReportingTransport
} from '../scripts/repository-security/codeql-report-artifact.ts';
import { readReportingArtifact, reportCodeqlSource } from '../scripts/report-codeql-source.mjs';
import type { CodeqlCategoryResult } from '../scripts/repository-security/codeql-driver.ts';

const now = new Date('2026-09-21T00:00:00.000Z');
const digest = `sha256:${'a'.repeat(64)}`;
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const sentinel = 'NONFUNCTIONAL_PRIVATE_SOURCE_REPORT_SENTINEL';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true }); });

interface TestSarif {
  runs: [{
    tool: { driver: { rules: [{ properties: { 'security-severity': string } }] } };
    invocations: [{ executionSuccessful: boolean; endTimeUtc: string }];
    results: [{
      message: { text: string }; codeFlows?: unknown[];
      locations: [{ physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number; endLine?: number } } }];
    }];
  }];
}

function fixture() {
  const identity = {
    repository: 'voyager163/liftoff', event: 'pull_request' as const, sourceSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40), workflowSha: 'c'.repeat(40), runId: '123', attempt: 1,
    policyDigest: digest, inventoryDigest: digest, configurationDigest: digest
  };
  const outcomes: CodeqlCategoryResult[] = (['javascript-typescript', 'python', 'actions'] as const).map(language => {
    const category = `source/${language}`;
    const scope: CodeqlScope = {
      category, identity, role: 'source-findings', tool: { name: 'CodeQL', version: '2.25.0', database: 'fixture' },
      unit: { id: category, count: 1, inputDigest: digest, platform: 'all' },
      sourcePaths: [['src', 'fixture.ts']], extractedPaths: [['src', 'fixture.ts']], nonSecurityRules: []
    };
    const sarif = JSON.stringify({ version: '2.1.0', runs: [{
      automationDetails: { id: category },
      tool: { driver: { name: 'CodeQL', semanticVersion: '2.25.0',
        rules: [{ id: 'fixture/rule', properties: { 'security-severity': '8.0' } }] } },
      invocations: [{ executionSuccessful: true, startTimeUtc: '2026-09-20T23:58:00.000Z', endTimeUtc: '2026-09-20T23:59:00.000Z' }],
      results: [{ ruleId: 'fixture/rule', message: { text: sentinel },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'src/fixture.ts' }, region: { startLine: 1 } } }] }]
    }] });
    return {
      category, language, status: 'complete',
      inputDigest: digest, sourceCount: 1, sourceReporting: sourceCodeqlReportingPayload(sarif, scope)
    };
  });
  const bundle = createCodeqlReportingBundle(identity, outcomes, false);
  const invocation = {
    event: identity.event, sourceSha: identity.sourceSha, workflowSha: identity.workflowSha,
    runId: identity.runId, attempt: identity.attempt, ref: 'refs/pull/17/merge', fork: true, dependabot: false
  };
  const env: NodeJS.ProcessEnv = {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: identity.repository, GITHUB_EVENT_NAME: identity.event,
    GITHUB_SHA: identity.sourceSha, GITHUB_WORKFLOW_SHA: identity.workflowSha,
    GITHUB_RUN_ID: identity.runId, GITHUB_RUN_ATTEMPT: '1', GITHUB_REF: invocation.ref,
    LIFTOFF_REPORTING_FORK: 'true', LIFTOFF_REPORTING_DEPENDABOT: 'false'
  };
  return { identity, outcomes, bundle, invocation, env };
}

describe('strict source-only reporting artifact', () => {
  it('retains source findings even when the complete generated matrix did not pass', () => {
    const value = fixture();
    const result = prepareCodeqlArtifactReports(value.bundle, value.invocation, now);
    expect(result.matrixAnalysisComplete).toBe(false);
    expect(result.reports).toHaveLength(3);
    expect(result.findingVerdictChanged).toBe(false);
    expect(result.admissionQualified).toBe(false);
    expect(result.plan.permissions).toEqual({ contents: 'read' });
    for (const report of result.reports) {
      const body = gunzipSync(Buffer.from(report.body.sarif, 'base64')).toString('utf8');
      expect(body).not.toContain(sentinel);
      expect(JSON.parse(body).runs[0].results).toHaveLength(1);
      expect(report.body.commit_sha).toBe(value.identity.sourceSha);
    }
  });

  it.each([
    { sourceSha: 'd'.repeat(40) }, { workflowSha: 'd'.repeat(40) }, { runId: '124' }, { attempt: 2 },
    { ref: 'refs/pull/17/head' }
  ])('rejects source/workflow/run/ref mismatch %#', change => {
    const value = fixture();
    expect(() => prepareCodeqlArtifactReports(value.bundle, { ...value.invocation, ...change }, now)).toThrow();
  });

  it('rejects omitted/generated/duplicate categories, missing native outcomes and byte substitution', () => {
    const value = fixture(), bundle = JSON.parse(value.bundle);
    for (const reports of [
      [], bundle.reports.slice(0, 1), [bundle.reports[0], bundle.reports[0]],
      [bundle.reports[0], { ...bundle.reports[1], category: 'generated/python' }],
      [bundle.reports[0], { ...bundle.reports[1], reportingDigest: digest }]
    ]) expect(() => prepareCodeqlArtifactReports(JSON.stringify({ ...bundle, reports }), value.invocation, now)).toThrow();
    expect(() => createCodeqlReportingBundle(value.identity, value.outcomes.slice(0, 1), true)).toThrow();
    expect(() => createCodeqlReportingBundle(value.identity, [
      { ...value.outcomes[0]!, status: 'error' }, value.outcomes[1]!
    ], true)).toThrow();
  });

  it('revalidates every serialized SARIF field before forwarding even when its outer digest is recomputed', () => {
    const value = fixture();
    for (const alter of [
      (sarif: TestSarif) => { sarif.runs[0].results[0].message.text = sentinel; },
      (sarif: TestSarif) => { sarif.runs[0].results[0].codeFlows = [{ message: sentinel }]; },
      (sarif: TestSarif) => { sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri = '../escape'; },
      (sarif: TestSarif) => { sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine = 0; },
      (sarif: TestSarif) => { sarif.runs[0].results[0].locations[0].physicalLocation.region.endLine = -1; },
      (sarif: TestSarif) => { sarif.runs[0].tool.driver.rules[0].properties['security-severity'] = 'unknown'; },
      (sarif: TestSarif) => { sarif.runs[0].invocations[0].executionSuccessful = false; },
      (sarif: TestSarif) => { sarif.runs[0].invocations[0].endTimeUtc = '2026-09-22T00:00:00.000Z'; }
    ]) {
      const bundle = JSON.parse(value.bundle), data = JSON.parse(bundle.reports[0].sarif);
      alter(data);
      bundle.reports[0].sarif = JSON.stringify(data);
      bundle.reports[0].reportingDigest = hash(bundle.reports[0].sarif);
      let failure: unknown;
      try { prepareCodeqlArtifactReports(JSON.stringify(bundle), value.invocation, now); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain(sentinel);
    }
  });

  it('derives exact runner identities but never authenticates workflow contents from the App name', () => {
    const value = fixture();
    expect(codeqlWorkflowInvocation(value.env)).toEqual(value.invocation);
    for (const change of [
      { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_ACTIONS: 'false' }, { GITHUB_RUN_ID: '' },
      { GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_RUN_ATTEMPT: '0' }, { GITHUB_WORKFLOW_SHA: '' },
      { GITHUB_REF: 'refs/heads/unapproved' }, { LIFTOFF_REPORTING_FORK: '' }
    ]) expect(() => codeqlWorkflowInvocation({ ...value.env, ...change })).toThrow();
  });
});

describe('bounded reporting delivery with simulated GitHub responses only', () => {
  function transport(): CodeqlReportingTransport {
    return { submit: vi.fn(async () => ({ status: 202, id: 'upload-fixture-1' })),
      status: vi.fn(async () => ({ status: 200, processingStatus: 'complete', errorCount: 0 })), wait: vi.fn(async () => {}) };
  }
  it('requires processing completion rather than equating HTTP acceptance with a successful upload', async () => {
    const value = fixture(), prepared = prepareCodeqlArtifactReports(value.bundle, value.invocation, now);
    const mock = transport();
    const result = await deliverCodeqlArtifactReports(prepared, mock);
    expect(result.available).toBe(true);
    expect(result.outcomes.map(item => item.status)).toEqual(['uploaded', 'uploaded', 'uploaded']);
    expect(result.hostedProtectionQualified).toBe(false);
    expect(result.findingVerdictChanged).toBe(false);
  });
  it('records unavailable fork upload without elevated fallback, neutral status or altered findings', async () => {
    const value = fixture(), mock = transport();
    mock.submit = vi.fn(async () => ({ status: 403, id: null }));
    const result = await deliverCodeqlArtifactReports(prepareCodeqlArtifactReports(value.bundle, value.invocation, now), mock);
    expect(result.available).toBe(false);
    expect(result.outcomes.every(item => item.status === 'unavailable')).toBe(true);
    expect(mock.status).not.toHaveBeenCalled();
  });
  it.each(['outage', 'bad-id', 'failed', 'pending', 'error-message'])('fails closed for %s', async mode => {
    const value = fixture(), mock = transport();
    if (mode === 'outage') mock.submit = async () => { throw new Error(sentinel); };
    if (mode === 'bad-id') mock.submit = async () => ({ status: 202, id: '../not-an-id' });
    if (mode === 'failed') mock.status = async () => ({ status: 200, processingStatus: 'failed', errorCount: 0 });
    if (mode === 'pending') mock.status = async () => ({ status: 200, processingStatus: 'pending', errorCount: 0 });
    if (mode === 'error-message') mock.status = async () => ({ status: 200, processingStatus: 'complete', errorCount: 1 });
    const result = deliverCodeqlArtifactReports(prepareCodeqlArtifactReports(value.bundle, value.invocation, now), mock);
    await expect(result).rejects.toThrow('codeql-report-artifact-');
    if (mode === 'pending') expect(mock.wait).toHaveBeenCalledTimes(12);
  });
});

describe.skipIf(process.platform === 'win32')('read-only staged reporter and owned artifact paths', () => {
  async function files() {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff source reports '))); roots.push(parent);
    const root = path.join(parent, 'artifact'); await mkdir(root);
    const value = fixture();
    await writeFile(path.join(root, 'source-codeql.json'), value.bundle);
    return { ...value, parent, root };
  }
  it('reports locally with upload disabled and never invokes a client', async () => {
    const value = await files(), request = vi.fn();
    const summary = path.join(value.parent, 'summary.md');
    const result = await reportCodeqlSource({
      ...value.env, RUNNER_TEMP: value.parent, LIFTOFF_CODEQL_REPORTING_ROOT: value.root,
      LIFTOFF_CODEQL_UPLOAD_ENABLED: 'false', GITHUB_STEP_SUMMARY: summary
    }, request, now);
    expect(request).not.toHaveBeenCalled();
    expect(result).toMatchObject({ uploadDisabled: true, available: false, findingVerdictChanged: false });
    expect(await readFile(summary, 'utf8')).toContain('does not decide finding policy');
  });
  it('sends only fixed-repository sanitized SARIF using a fake transport and validates string upload IDs', async () => {
    const value = await files();
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toMatch(/^https:\/\/api.github.com\/repos\/voyager163\/liftoff\/code-scanning\/sarifs(?:\/upload-fixture-1)?$/);
      expect(init.redirect).toBe('error');
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(gunzipSync(Buffer.from(body.sarif, 'base64')).toString()).not.toContain(sentinel);
        return new Response(JSON.stringify({ id: 'upload-fixture-1' }), { status: 202 });
      }
      return new Response(JSON.stringify({ processing_status: 'complete', errors: null }), { status: 200 });
    });
    const result = await reportCodeqlSource({
      ...value.env, RUNNER_TEMP: value.parent, LIFTOFF_CODEQL_REPORTING_ROOT: value.root,
      LIFTOFF_CODEQL_UPLOAD_ENABLED: 'true', GITHUB_STEP_SUMMARY: path.join(value.parent, 'summary.md'),
      GITHUB_TOKEN: 'NONFUNCTIONAL_TOKEN_NOT_SENT_TO_NETWORK'
    }, request, now);
    expect(result.available).toBe(true);
    expect(request).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(result)).not.toContain('NONFUNCTIONAL_TOKEN');
  });
  it('rejects escaping or aliased roots/files before artifact consumption', async () => {
    const value = await files(), alias = path.join(value.parent, 'alias');
    await symlink(value.root, alias);
    await expect(readReportingArtifact(alias, value.parent)).rejects.toThrow();
    await expect(readReportingArtifact(value.root, path.join(value.parent, 'nonexistent'))).rejects.toThrow();
    await rm(path.join(value.root, 'source-codeql.json'));
    await symlink(path.join(value.parent, 'outside.json'), path.join(value.root, 'source-codeql.json'));
    await expect(readReportingArtifact(value.root, value.parent)).rejects.toThrow();
  });
});
