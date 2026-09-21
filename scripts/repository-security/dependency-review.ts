import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identifier, portableParts, sha, SecurityEvidenceError } from './evidence.ts';

export interface DependencyReviewContext {
  repository: string;
  baseSha: string;
  headSha: string;
  token: string;
}

export interface DependencyChangeFinding {
  advisory: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  scope: 'runtime' | 'development' | 'unknown';
  manifest: string[];
  package: string;
  version: string;
}

export interface DependencyReviewResult {
  coverage: 'native-dependency-diff';
  currentGraphsAssessed: false;
  repository: string;
  baseSha: string;
  headSha: string;
  added: number;
  removed: number;
  blocking: DependencyChangeFinding[];
  tracked: DependencyChangeFinding[];
  passed: boolean;
}

type Request = (url: string, init: RequestInit) => Promise<Response>;
const apiOrigin = 'https://api.github.com';
const sourceRepository = 'voyager163/liftoff';
const reportLimit = 4 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SecurityEvidenceError('invalid-dependency-review-object');
  }
  return value as Record<string, unknown>;
}

function repositoryName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) || value.length > 200) {
    throw new SecurityEvidenceError('invalid-dependency-review-repository');
  }
  if (value.split('/').some(part => part === '.' || part === '..')) throw new SecurityEvidenceError('invalid-dependency-review-repository');
  if (value !== sourceRepository) throw new SecurityEvidenceError('dependency-review-repository-mismatch');
  return value;
}

export function dependencyReviewContext(eventJson: string, repository: string, token: string): DependencyReviewContext {
  if (Buffer.byteLength(eventJson) > reportLimit) throw new SecurityEvidenceError('dependency-review-context-too-large');
  let parsed: unknown;
  try { parsed = JSON.parse(eventJson); } catch { throw new SecurityEvidenceError('invalid-dependency-review-context'); }
  const event = object(parsed), pullRequest = object(event.pull_request);
  const expectedRepository = repositoryName(repository);
  if (object(event.repository).full_name !== expectedRepository ||
      object(object(pullRequest.base).repo).full_name !== expectedRepository) {
    throw new SecurityEvidenceError('dependency-review-repository-mismatch');
  }
  if (!token || token.length > 2000 || !/^[\x21-\x7e]+$/.test(token)) throw new SecurityEvidenceError('missing-dependency-review-token');
  return {
    repository: expectedRepository,
    baseSha: sha(object(pullRequest.base).sha),
    headSha: sha(object(pullRequest.head).sha),
    token
  };
}

async function readResponse(response: Response): Promise<unknown[]> {
  if (!response.ok) {
    const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
      ? response.status : 'invalid-status';
    throw new SecurityEvidenceError(`dependency-review-api-error-${status}`);
  }
  if (response.headers.get('x-github-dependency-graph-snapshot-warnings')?.trim()) {
    throw new SecurityEvidenceError('incomplete-dependency-snapshots');
  }
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || response.body === null) {
    throw new SecurityEvidenceError('missing-dependency-review-report');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > reportLimit) {
        await reader.cancel();
        throw new SecurityEvidenceError('dependency-review-report-too-large');
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof SecurityEvidenceError) throw error;
    throw new SecurityEvidenceError('dependency-review-read-failed');
  } finally {
    reader.releaseLock();
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new SecurityEvidenceError('invalid-dependency-review-json'); }
  if (!Array.isArray(parsed) || parsed.length > 20_000) throw new SecurityEvidenceError('invalid-dependency-review-changes');
  return parsed;
}

function nextPage(header: string | null, endpoint: string, currentPage: number): string | null {
  if (!header) return null;
  if (header.length > 16_384) throw new SecurityEvidenceError('invalid-dependency-review-pagination');
  const links = header.split(',').map(part => part.trim());
  let next: string | null = null;
  for (const link of links) {
    const matched = /^<([^>]+)>;\s*rel="([^"]+)"$/.exec(link);
    if (!matched) throw new SecurityEvidenceError('invalid-dependency-review-pagination');
    if (matched[2] !== 'next') continue;
    if (next !== null) throw new SecurityEvidenceError('duplicate-dependency-review-next-page');
    let url: URL;
    try { url = new URL(matched[1]!); } catch { throw new SecurityEvidenceError('invalid-dependency-review-pagination'); }
    if (url.origin !== apiOrigin || url.pathname !== endpoint || url.username || url.password || url.hash ||
        url.searchParams.get('page') !== String(currentPage + 1) ||
        url.searchParams.get('per_page') !== '100' ||
        [...url.searchParams.keys()].length !== 2) {
      throw new SecurityEvidenceError('untrusted-dependency-review-pagination');
    }
    next = url.toString();
  }
  return next;
}

export async function reviewDependencyChanges(
  context: DependencyReviewContext, request: Request = fetch
): Promise<DependencyReviewResult> {
  const repository = repositoryName(context.repository), baseSha = sha(context.baseSha), headSha = sha(context.headSha);
  if (!context.token || context.token.length > 2000 || !/^[\x21-\x7e]+$/.test(context.token)) {
    throw new SecurityEvidenceError('missing-dependency-review-token');
  }
  const endpoint = `/repos/${repository}/dependency-graph/compare/${baseSha}...${headSha}`;
  let next: string | null = `${apiOrigin}${endpoint}?per_page=100&page=1`;
  const result: DependencyReviewResult = {
    coverage: 'native-dependency-diff', currentGraphsAssessed: false,
    repository, baseSha, headSha, added: 0, removed: 0, blocking: [], tracked: [], passed: true
  };
  const seenChanges = new Set<string>(), seenFindings = new Set<string>();
  for (let page = 1; next !== null; page++) {
    if (page > 100) throw new SecurityEvidenceError('dependency-review-pagination-limit');
    let response: Response;
    try {
      response = await request(next, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${context.token}`, 'X-GitHub-Api-Version': '2022-11-28' },
        redirect: 'error', signal: AbortSignal.timeout(10_000)
      });
    } catch { throw new SecurityEvidenceError('dependency-review-request-failed'); }
    const changes = await readResponse(response);
    for (const value of changes) {
      const change = object(value);
      if (change.change_type !== 'added' && change.change_type !== 'removed') throw new SecurityEvidenceError('invalid-dependency-change-kind');
      if (typeof change.manifest !== 'string') throw new SecurityEvidenceError('invalid-dependency-manifest');
      const manifest = portableParts(change.manifest.split('/'));
      const name = identifier(change.name, 'invalid-dependency-name');
      const version = identifier(change.version, 'invalid-dependency-version');
      const ecosystem = identifier(change.ecosystem, 'invalid-dependency-ecosystem');
      const scope = change.scope ?? 'unknown';
      if (scope !== 'runtime' && scope !== 'development' && scope !== 'unknown') throw new SecurityEvidenceError('invalid-dependency-scope');
      if (!Array.isArray(change.vulnerabilities)) throw new SecurityEvidenceError('missing-dependency-vulnerability-data');
      const changeKey = JSON.stringify([change.change_type, manifest, ecosystem, name, version, scope]);
      if (seenChanges.has(changeKey)) throw new SecurityEvidenceError('duplicate-dependency-change');
      seenChanges.add(changeKey);
      if (seenChanges.size > 20_000) throw new SecurityEvidenceError('dependency-review-change-limit');
      if (change.change_type === 'added') result.added++;
      else result.removed++;
      for (const value of change.vulnerabilities) {
        const vulnerability = object(value);
        const severity = vulnerability.severity;
        if (severity !== 'low' && severity !== 'moderate' && severity !== 'high' && severity !== 'critical') {
          throw new SecurityEvidenceError('unknown-dependency-severity');
        }
        const advisory = vulnerability.advisory_ghsa_id;
        if (typeof advisory !== 'string' || !/^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/i.test(advisory)) {
          throw new SecurityEvidenceError('invalid-dependency-advisory');
        }
        if (change.change_type === 'removed') continue;
        const findingKey = JSON.stringify([changeKey, advisory.toUpperCase()]);
        if (seenFindings.has(findingKey)) throw new SecurityEvidenceError('duplicate-dependency-advisory');
        seenFindings.add(findingKey);
        if (seenFindings.size > 20_000) throw new SecurityEvidenceError('dependency-review-finding-limit');
        const finding: DependencyChangeFinding = { advisory, severity, scope, manifest, package: name, version };
        (severity === 'high' || severity === 'critical' ? result.blocking : result.tracked).push(finding);
      }
    }
    next = nextPage(response.headers.get('link'), endpoint, page);
  }
  result.passed = result.blocking.length === 0;
  if (Buffer.byteLength(JSON.stringify(result)) > reportLimit) throw new SecurityEvidenceError('dependency-review-result-too-large');
  return result;
}

export function dependencyReviewSummary(result: DependencyReviewResult) {
  return {
    coverage: result.coverage, currentGraphsAssessed: result.currentGraphsAssessed,
    baseSha: result.baseSha, headSha: result.headSha,
    added: result.added, removed: result.removed,
    blocking: result.blocking.length, tracked: result.tracked.length,
    triageOwner: 'voyager163',
    blockingAdvisories: [...new Set(result.blocking.map(finding => finding.advisory))].sort(),
    trackedAdvisories: [...new Set(result.tracked.map(finding => finding.advisory))].sort(),
    passed: result.passed
  };
}

async function main(): Promise<void> {
  try {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'pull_request' ||
        !process.env.GITHUB_EVENT_PATH || process.env.GITHUB_REPOSITORY !== sourceRepository) {
      throw new SecurityEvidenceError('dependency-review-requires-repository-pr-context');
    }
    const context = dependencyReviewContext(
      await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'),
      process.env.GITHUB_REPOSITORY, process.env.GITHUB_TOKEN ?? ''
    );
    const result = await reviewDependencyChanges(context);
    process.stdout.write(`${JSON.stringify(dependencyReviewSummary(result))}\n`);
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    const code = error instanceof SecurityEvidenceError ? error.code : 'dependency-review-execution-error';
    process.stderr.write(`Dependency review failed: ${code}.\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
