#!/usr/bin/env node
import { constants } from 'node:fs';
import { appendFile, lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  codeqlWorkflowInvocation, deliverCodeqlArtifactReports, prepareCodeqlArtifactReports
} from './repository-security/codeql-report-artifact.ts';

function fail() { throw new Error('CodeQL reporting failed: invalid context, incomplete evidence or unavailable transport.'); }

export async function readReportingArtifact(directory, runnerTemp) {
  if (!directory || !runnerTemp || !path.isAbsolute(directory) || !path.isAbsolute(runnerTemp)) fail();
  const parent = await realpath(runnerTemp), root = await realpath(directory);
  const relative = path.relative(parent, root);
  if (root !== path.resolve(directory) || !relative || relative === '..' ||
      relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || (await lstat(directory)).isSymbolicLink()) fail();
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) fail();
  const target = path.join(root, 'source-codeql.json'), limit = 10 * 1024 * 1024;
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(limit)) fail();
    bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const part = await file.read(bytes, length, bytes.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    const after = await file.stat({ bigint: true }), named = await lstat(target, { bigint: true });
    if (BigInt(length) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs || named.ino !== before.ino || named.dev !== before.dev || named.isSymbolicLink()) fail();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { bytes?.fill(0); await file.close(); }
}

async function responseData(response) {
  if (!response.body) fail();
  const chunks = [], reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      size += value.value.length;
      if (size > 64 * 1024) { await reader.cancel(); fail(); }
      chunks.push(value.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); for (const chunk of chunks) chunk.fill(0); }
}

export function codeqlApiTransport(token, request = fetch) {
  if (typeof token !== 'string' || !token || /[\r\n\0]/.test(token)) fail();
  const root = 'https://api.github.com/repos/voyager163/liftoff/code-scanning/sarifs';
  const headers = {
    Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'
  };
  return {
    async submit(body) {
      const response = await request(root, {
        method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20_000)
      });
      if (response.status !== 202) { await response.body?.cancel(); return { status: response.status, id: null }; }
      const value = await responseData(response);
      return { status: response.status, id: value?.id };
    },
    async status(id) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) fail();
      const response = await request(`${root}/${id}`, {
        method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(20_000)
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        return { status: response.status, processingStatus: null, errorCount: 1 };
      }
      const value = await responseData(response);
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          value.errors !== null && value.errors !== undefined && !Array.isArray(value.errors)) fail();
      return { status: response.status, processingStatus: value.processing_status, errorCount: value.errors?.length ?? 0 };
    },
    wait: () => delay(5_000)
  };
}

export async function reportCodeqlSource(env = process.env, request = fetch, now = new Date()) {
  const invocation = codeqlWorkflowInvocation(env);
  if (!['true', 'false'].includes(env.LIFTOFF_CODEQL_UPLOAD_ENABLED ?? '') ||
      !env.GITHUB_STEP_SUMMARY || !path.isAbsolute(env.GITHUB_STEP_SUMMARY)) fail();
  const prepared = prepareCodeqlArtifactReports(
    await readReportingArtifact(env.LIFTOFF_CODEQL_REPORTING_ROOT, env.RUNNER_TEMP), invocation, now);
  const result = env.LIFTOFF_CODEQL_UPLOAD_ENABLED === 'true'
    ? await deliverCodeqlArtifactReports(prepared, codeqlApiTransport(env.GITHUB_TOKEN, request))
    : {
      kind: 'source-reporting-outcome', available: false, uploadDisabled: true,
      outcomes: prepared.reports.map(report => ({ category: report.category, status: 'retained-local-only' })),
      findingVerdictChanged: false, hostedProtectionQualified: false, publicationQualified: false
    };
  const lines = [
    '## CodeQL source reporting', '',
    'Reporting only: this does not decide finding policy, PR admission or publication.',
    `Complete source categories: ${prepared.reports.length}; complete full matrix: ${prepared.matrixAnalysisComplete}.`,
    ...prepared.reports.map(report => `- ${report.category}: ${report.findingCount} observed findings; ${report.nativeFingerprintCount} native line fingerprints.`),
    ...result.outcomes.map(outcome => `- ${outcome.category} reporting: ${outcome.status}.`),
    'Local analysis and finding evaluation remain required regardless of upload visibility.',
    'Missing native line fingerprints leave cross-run native alert matching unqualified; no line hash is fabricated.',
    'Native merge protection and fork/Dependabot behavior still require separate hosted qualification.', ''
  ];
  await appendFile(env.GITHUB_STEP_SUMMARY, lines.join('\n'));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) fail();
    const result = await reportCodeqlSource();
    console.log(JSON.stringify(result));
    if (!result.available && !('uploadDisabled' in result)) process.exitCode = 1;
  } catch {
    console.error('CodeQL reporting failed: invalid context, incomplete evidence or unavailable transport; finding results are unchanged.');
    process.exitCode = 1;
  }
}
