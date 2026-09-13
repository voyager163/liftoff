import { spawn } from 'node:child_process';
import type { CommandRunner } from '../../process-runner.js';

export type GitHubMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface GitHubRequest {
  method: GitHubMethod;
  path: string;
  body?: unknown;
  binary?: boolean;
}
export interface GitHubResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  data: unknown;
}
export interface GitHubActivationTransport {
  request(request: GitHubRequest): Promise<GitHubResponse>;
}

const apiVersion = '2026-03-10';
const requestTimeoutMs = 30_000;
const maxResponseBytes = 4 * 1024 * 1024;

export class GitHubActivationError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message);
    this.name = 'GitHubActivationError';
  }
}

export function apiPath(value: string): string {
  if (!/^\/(?:repos|orgs|user|users|app|installation|applications)(?:\/|$|\?)/u.test(value) ||
    /[\s\\#\u0000-\u001f\u007f]/u.test(value) || /(?:%2e|%2f|%5c)/iu.test(value) ||
    value.split('?')[0]!.split('/').some((part) => part === '..' || part === '.')) {
    throw new GitHubActivationError('invalid-endpoint', 'GitHub requests must use a fixed, scoped REST endpoint.');
  }
  return value;
}

export function githubName(value: unknown, label = 'GitHub name'): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(value) || value.includes('..')) {
    throw new GitHubActivationError('invalid-input', `${label} must be an explicit GitHub path segment.`);
  }
  return value;
}

export function githubRepository(value: unknown): string {
  if (typeof value !== 'string' || value.split('/').length !== 2) {
    throw new GitHubActivationError('repository-required', 'Specify activation.repository.name as the exact owner/repository on github.com.');
  }
  return value.split('/').map((part) => githubName(part, 'Repository owner/name')).join('/');
}

export function githubRef(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/u.test(value) ||
    value.includes('..') || value.includes('//') || value.endsWith('/') ||
    value.endsWith('.lock') || value.split('/').some((part) => part.startsWith('.'))) {
    throw new GitHubActivationError('invalid-ref', 'An explicit safe branch or tag name is required.');
  }
  return value;
}

export function object(value: unknown, label = 'GitHub response'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Buffer.isBuffer(value)) {
    throw new GitHubActivationError('invalid-response', `${label} did not return a JSON object.`);
  }
  return value as Record<string, unknown>;
}

export function positiveId(value: unknown, label = 'GitHub resource ID'): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new GitHubActivationError('invalid-response', `${label} must be a positive provider resource ID.`);
  }
  return value as number;
}

export function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new GitHubActivationError('invalid-response', `${label} is absent or invalid.`);
  }
  return value;
}

export function safeGitHubFailure(error: unknown): string {
  return error instanceof GitHubActivationError ? error.message :
    'GitHub operation could not be verified. Check the approved identity, API access, and connectivity; provider diagnostics were withheld.';
}

export function expectStatus(response: GitHubResponse, statuses: readonly number[], operation: string): GitHubResponse {
  if (statuses.includes(response.status)) return response;
  const reason = response.status === 401 ? 'authentication is missing or expired' :
    response.status === 403 ? 'the approved identity lacks permission or the account capability is unavailable' :
      response.status === 404 ? 'the exact resource is absent or is not visible to this identity' :
        response.status === 409 || response.status === 422 ? 'provider state conflicts with the reviewed operation' :
          response.status === 429 ? 'the provider rate limit was reached' : 'the provider did not confirm the requested result';
  throw new GitHubActivationError('provider-response', `${operation}: ${reason} (HTTP ${response.status}).`, response.status);
}

function parseResponse(bytes: Buffer, binary: boolean): GitHubResponse {
  let body = bytes;
  let status = 0;
  const headers: Record<string, string> = {};
  while (body.subarray(0, 5).toString() === 'HTTP/') {
    let end = body.indexOf('\r\n\r\n');
    let width = 4;
    if (end === -1) { end = body.indexOf('\n\n'); width = 2; }
    if (end === -1) throw new GitHubActivationError('invalid-response', 'GitHub returned incomplete response headers.');
    const lines = body.subarray(0, end).toString('utf8').split(/\r?\n/u);
    status = Number(lines.shift()?.split(/\s/u)[1]);
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    body = body.subarray(end + width);
  }
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new GitHubActivationError('invalid-response', 'GitHub CLI did not return an HTTP status.');
  }
  if (binary && status === 200) return { status, headers, data: body };
  let data: unknown = null;
  try { data = body.length ? JSON.parse(body.toString('utf8')) : null; }
  catch { throw new GitHubActivationError('invalid-response', 'GitHub returned invalid JSON; response bytes were withheld.'); }
  return { status, headers, data };
}

// CommandRunner deliberately decodes text. Archives need a separate bounded byte collector.
async function runBinaryGitHub(args: readonly string[], cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', [...args], {
      cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GH_DEBUG: '', GH_PAGER: 'cat', GH_PROMPT_DISABLED: '1' }
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill('SIGKILL');
      reject(new GitHubActivationError('bounded-request', 'GitHub archive read exceeded its time or size bound.'));
    };
    const timer = setTimeout(stop, requestTimeoutMs);
    child.stdout.on('data', (bytes: Buffer) => {
      size += bytes.length;
      if (size > maxResponseBytes) stop();
      else chunks.push(bytes);
    });
    child.once('error', () => {
      clearTimeout(timer);
      if (!stopped) reject(new GitHubActivationError('authentication-prerequisite', 'Install and authenticate GitHub CLI using the owner-controlled provider flow.'));
    });
    child.once('close', () => {
      clearTimeout(timer);
      if (!stopped) resolve(Buffer.concat(chunks));
    });
  });
}

export function createGitHubCliTransport(runner: CommandRunner, projectRoot: string): GitHubActivationTransport {
  return {
    async request(request) {
      const endpoint = apiPath(request.path);
      const args = ['api', '--hostname', 'github.com', '--method', request.method,
        '--header', `X-GitHub-Api-Version: ${apiVersion}`, '--header', 'Accept: application/vnd.github+json', '--include', endpoint];
      if (request.binary) {
        if (request.method !== 'GET' || request.body !== undefined) {
          throw new GitHubActivationError('invalid-endpoint', 'Binary GitHub transport is read-only.');
        }
        return parseResponse(await runBinaryGitHub(args, projectRoot), true);
      }
      const stdin = request.body === undefined ? undefined : JSON.stringify(request.body);
      if (stdin !== undefined) args.push('--input', '-');
      const result = await runner.run({ executable: 'gh', args }, {
        cwd: projectRoot, stdin, timeoutMs: requestTimeoutMs, maxOutputBytes: maxResponseBytes, stream: false,
        env: { GH_DEBUG: '', GH_PAGER: 'cat', GH_PROMPT_DISABLED: '1' }
      });
      if (result.timedOut || result.outputLimitExceeded || result.errorCode || result.aborted) {
        throw new GitHubActivationError('bounded-request', 'GitHub request was not completed within its bounded execution window.');
      }
      // Even errors are parsed only for status, never copied into public output.
      return parseResponse(Buffer.from(result.stdout), false);
    }
  };
}

export function createAuthenticatedGitHubTransport(
  credential: Uint8Array,
  fetcher: typeof fetch = fetch
): GitHubActivationTransport {
  return {
    async request(request) {
      if (request.binary) throw new GitHubActivationError('invalid-endpoint', 'Protected credential probes cannot download arbitrary artifacts.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetcher(`https://api.github.com${apiPath(request.path)}`, {
          method: request.method, redirect: 'error', signal: controller.signal,
          headers: {
            Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': apiVersion,
            Authorization: `Bearer ${Buffer.from(credential).toString('utf8')}`,
            'Content-Type': 'application/json'
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) })
        });
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (response.body) for await (const bytes of response.body) {
          size += bytes.length;
          if (size > maxResponseBytes) {
            controller.abort();
            throw new GitHubActivationError('bounded-request', 'Protected GitHub response exceeded the configured size bound.');
          }
          chunks.push(bytes);
        }
        const raw = Buffer.concat(chunks);
        return {
          status: response.status, headers: Object.fromEntries(response.headers.entries()),
          data: raw.length ? JSON.parse(raw.toString('utf8')) : null
        };
      } catch (error) {
        if (error instanceof GitHubActivationError) throw error;
        throw new GitHubActivationError('protected-request', 'Protected GitHub request failed; credential and response diagnostics were withheld.');
      } finally { clearTimeout(timer); }
    }
  };
}

export class GitHubActivationClient {
  constructor(readonly transport: GitHubActivationTransport) {}

  async get(path: string): Promise<Record<string, unknown>> {
    return object(expectStatus(await this.transport.request({ method: 'GET', path }), [200], `Read ${path.split('?')[0]}`).data);
  }

  async optional(path: string): Promise<Record<string, unknown> | null> {
    const response = await this.transport.request({ method: 'GET', path });
    if (response.status === 404) return null;
    return object(expectStatus(response, [200], `Read ${path.split('?')[0]}`).data);
  }

  async write(method: Exclude<GitHubMethod, 'GET'>, path: string, body?: unknown): Promise<Record<string, unknown> | null> {
    const response = expectStatus(await this.transport.request({ method, path, body }), [200, 201, 202, 204], `Apply ${path}`);
    return response.data === null ? null : object(response.data);
  }

  async list(path: string, collection?: string): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = [];
    let expectedTotal: number | undefined;
    for (let page = 1; page <= 10; page++) {
      const response = expectStatus(await this.transport.request({
        method: 'GET', path: `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`
      }), [200], `List ${path.split('?')[0]}`);
      const envelope = collection ? object(response.data) : undefined;
      const entries = collection ? envelope![collection] : response.data;
      if (!Array.isArray(entries) || entries.length > 100) {
        throw new GitHubActivationError('incomplete-pagination', `GitHub ${collection ?? 'list'} returned an invalid page.`);
      }
      if (envelope && typeof envelope.total_count === 'number') {
        if (!Number.isSafeInteger(envelope.total_count) || envelope.total_count < 0 ||
          expectedTotal !== undefined && expectedTotal !== envelope.total_count) {
          throw new GitHubActivationError('incomplete-pagination', 'GitHub inventory changed during pagination; repeat read-only discovery.');
        }
        expectedTotal = envelope.total_count;
      }
      result.push(...entries.map((entry) => object(entry)));
      const next = /rel="next"/u.test(response.headers.link ?? '');
      if (!next && entries.length < 100) {
        if (expectedTotal !== undefined && result.length !== expectedTotal) {
          throw new GitHubActivationError('incomplete-pagination', 'GitHub returned incomplete inventory; absence cannot be inferred.');
        }
        return result;
      }
      if (!next && expectedTotal !== undefined && result.length === expectedTotal) return result;
    }
    throw new GitHubActivationError('incomplete-pagination', 'GitHub inventory exceeds the 1,000-resource bound; provide a narrower supported scope.');
  }
}
