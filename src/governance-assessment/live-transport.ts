import { performance } from 'node:perf_hooks';
import type { CommandResult, CommandRunner } from '../process-runner.js';
import type { ExternalCommand } from '../types.js';
import { isRecord } from './sanitize.js';
import { assessmentLimits, type AssessmentDiagnostic, type LiveAssessmentScope } from './types.js';

const githubCliHost = 'github.com';
const githubApiOrigin = 'https://api.github.com';
const armHost = 'https://management.azure.com';
const pageSize = 100;
export const githubApiVersion = '2022-11-28';

export class LiveFailure extends Error {
  constructor(readonly code: string, message: string, readonly transient = false) {
    super(message);
  }
}

export type GitHubAction =
  | 'repository' | 'actions-app' | 'rulesets' | 'ruleset' | 'branch' | 'protection' | 'branch-rules'
  | 'checks' | 'environments' | 'environment-policies' | 'workflows'
  | 'runner' | 'runner-group' | 'runner-assignment' | 'runner-network';

interface GitHubResponse {
  value: unknown;
  headers: Map<string, string>;
}

function failureForStatus(status: number): LiveFailure {
  if (status === 401) return new LiveFailure('authentication', 'Existing authentication did not authorize the read.');
  if (status === 403) return new LiveFailure('denied', 'The scoped read was denied; absence cannot be established.');
  if (status === 404) return new LiveFailure('masked-not-found', 'The read returned 404; absence cannot be distinguished from hidden access.');
  if (status === 429) return new LiveFailure('rate-limit', 'The provider rate-limited the scoped read.', true);
  if (status >= 500 && status <= 599) return new LiveFailure('provider-unavailable', 'The provider could not complete the scoped read.', true);
  return new LiveFailure('http-error', 'The provider returned an unsuccessful HTTP response.');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LiveFailure('invalid-response', 'The provider response was invalid or truncated JSON.');
  }
}

function parseGitHub(text: string): GitHubResponse {
  const split = text.search(/\r?\n\r?\n/u);
  if (split < 0) throw new LiveFailure('invalid-response', 'GitHub response headers were unavailable; pagination cannot be verified.');
  const lines = text.slice(0, split).split(/\r?\n/u);
  const status = /^HTTP\/[0-9.]+\s+([0-9]{3})(?:\s|$)/u.exec(lines.shift() ?? '');
  if (!status) throw new LiveFailure('invalid-response', 'GitHub returned an invalid HTTP envelope.');
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 1) throw new LiveFailure('invalid-response', 'GitHub returned malformed response headers.');
    const name = line.slice(0, colon).toLowerCase();
    if (!/^[a-z0-9-]+$/u.test(name) || headers.has(name)) {
      throw new LiveFailure('invalid-response', 'GitHub returned ambiguous response headers.');
    }
    headers.set(name, line.slice(colon + 1).trim());
  }
  const code = Number(status[1]);
  if (code < 200 || code >= 300) throw failureForStatus(code);
  const body = text.slice(split).replace(/^\r?\n\r?\n/u, '');
  const length = headers.get('content-length');
  if (length !== undefined && !headers.has('content-encoding') &&
      (!/^\d+$/u.test(length) || Number(length) !== Buffer.byteLength(body))) {
    throw new LiveFailure('truncated-response', 'The GitHub response did not match its declared content length.');
  }
  return { value: parseJson(body), headers };
}

function httpError(result: CommandResult): LiveFailure {
  if (result.errorCode === 'ENOENT') return new LiveFailure('tool-unavailable', 'The required CLI is unavailable; no installation was attempted.');
  const code = /\bHTTP(?:\/[0-9.]+)?\s+([1-5][0-9]{2})\b/iu.exec(result.stderr)?.[1] ??
    /\b(?:status(?:\s+code)?|StatusCode)\s*[:=]?\s*([1-5][0-9]{2})\b/iu.exec(result.stderr)?.[1];
  if (code) return failureForStatus(Number(code));
  if (/\b(?:AuthorizationFailed|Forbidden|AccessDenied)\b/u.test(result.stderr)) return failureForStatus(403);
  if (/\b(?:AuthenticationFailed|Unauthorized|NotLoggedIn)\b|az login|gh auth login/iu.test(result.stderr)) return failureForStatus(401);
  if (/\b(?:ResourceNotFound|NotFound)\b/u.test(result.stderr)) return failureForStatus(404);
  if (['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT'].includes(result.errorCode ?? '')) {
    return new LiveFailure('transport-unavailable', 'The scoped read encountered a transient transport failure.', true);
  }
  return new LiveFailure('command-failed', 'The read-only CLI request failed; provider error details were withheld.');
}

export class LiveTransport {
  private readonly clockStart: number;
  private readonly monotonicStart = performance.now();
  private verified = false;
  private readonly shas = new Set<string>();
  private readonly unavailable = new Set<string>();
  private readonly active = new Set<AbortController>();
  private deadlineFailure: LiveFailure | undefined;

  constructor(
    private readonly runner: CommandRunner,
    private readonly now: () => Date,
    private readonly scope: LiveAssessmentScope,
    private readonly azureUrls: ReadonlySet<string>,
    private readonly diagnostic: (value: AssessmentDiagnostic) => void
  ) {
    this.clockStart = now().getTime();
  }

  verifyRepository(): void {
    this.verified = true;
  }

  bindSha(sha: string): void {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha)) {
      throw new LiveFailure('scope-mismatch', 'A check request requires a verified commit SHA.');
    }
    this.shas.add(sha);
  }

  private remaining(): number {
    if (this.deadlineFailure) throw this.deadlineFailure;
    const elapsed = Math.max(this.now().getTime() - this.clockStart, performance.now() - this.monotonicStart);
    const remaining = assessmentLimits.liveDeadlineMs - elapsed;
    if (!Number.isFinite(remaining) || remaining <= 0) {
      throw this.expireDeadline();
    }
    return Math.max(1, Math.floor(remaining));
  }

  private expireDeadline(): LiveFailure {
    this.deadlineFailure ??= new LiveFailure('deadline', 'The live collection deadline was reached; remaining proof was not collected.');
    for (const controller of this.active) controller.abort(this.deadlineFailure);
    return this.deadlineFailure;
  }

  githubUrl(action: GitHubAction, selector?: string | number): URL {
    const repository = this.scope.repository;
    if (!repository || (action !== 'repository' && !this.verified)) {
      throw new LiveFailure('unverified-scope', 'Repository identity must be verified before dependent reads.');
    }
    const root = `/repos/${repository.owner}/${repository.name}`;
    const runner = this.scope.runner;
    let pathname: string;
    switch (action) {
      case 'repository': pathname = root; break;
      case 'actions-app': pathname = '/apps/github-actions'; break;
      case 'rulesets': pathname = `${root}/rulesets`; break;
      case 'ruleset':
        if (typeof selector !== 'number' || !Number.isSafeInteger(selector) || selector < 1) {
          throw new LiveFailure('unsafe-scope', 'A ruleset read requires an observed numeric ruleset ID.');
        }
        pathname = `${root}/rulesets/${selector}`;
        break;
      case 'branch':
      case 'protection':
      case 'branch-rules':
        if (typeof selector !== 'string' || !this.scope.refs.includes(selector)) {
          throw new LiveFailure('unsafe-scope', 'The requested branch was not in the validated scope.');
        }
        pathname = action === 'branch-rules'
          ? `${root}/rules/branches/${encodeURIComponent(selector)}`
          : `${root}/branches/${encodeURIComponent(selector)}${action === 'protection' ? '/protection' : ''}`;
        break;
      case 'checks':
        if (typeof selector !== 'string' || !this.shas.has(selector)) {
          throw new LiveFailure('unverified-scope', 'Checks must be requested for an observed commit SHA.');
        }
        pathname = `${root}/commits/${selector}/check-runs`;
        break;
      case 'environments': pathname = `${root}/environments`; break;
      case 'environment-policies':
        if (typeof selector !== 'string' || !this.scope.environments.includes(selector)) {
          throw new LiveFailure('unsafe-scope', 'The environment was not in the validated scope.');
        }
        pathname = `${root}/environments/${encodeURIComponent(selector)}/deployment-branch-policies`;
        break;
      case 'workflows': pathname = `${root}/actions/workflows`; break;
      case 'runner':
      case 'runner-group':
      case 'runner-assignment':
      case 'runner-network':
        if (!runner || runner.organization.toLowerCase() !== repository.owner.toLowerCase() ||
            !Number.isSafeInteger(runner.runnerId) || runner.runnerId <= 0 ||
            !Number.isSafeInteger(runner.groupId) || Number(runner.groupId) <= 0 ||
            typeof runner.networkConfigurationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(runner.networkConfigurationId)) {
          throw new LiveFailure('unsafe-scope', 'Exact runner, group, network and repository bindings are required.');
        }
        pathname = action === 'runner' ? `/orgs/${repository.owner}/actions/hosted-runners/${runner.runnerId}`
          : action === 'runner-group' ? `/orgs/${repository.owner}/actions/runner-groups/${runner.groupId}`
            : action === 'runner-network' ? `/orgs/${repository.owner}/settings/network-configurations/${runner.networkConfigurationId}`
              : `/orgs/${repository.owner}/actions/runner-groups`;
        break;
      default: throw new LiveFailure('unsafe-action', 'The requested action is not an allowlisted live read.');
    }
    const url = new URL(pathname, githubApiOrigin);
    if (action === 'rulesets' || action === 'ruleset') url.searchParams.set('includes_parents', 'true');
    if (action === 'checks') url.searchParams.set('filter', 'latest');
    if (action === 'runner-assignment') url.searchParams.set('visible_to_repository', repository.name);
    return url;
  }

  async github(action: GitHubAction, selector?: string | number): Promise<unknown> {
    const response = await this.getGitHub(this.githubUrl(action, selector));
    if (response.headers.has('link')) {
      throw new LiveFailure('incomplete-pagination', 'A single-object read unexpectedly returned pagination.');
    }
    return response.value;
  }

  async pages<T>(
    action: GitHubAction,
    field: string | null,
    normalize: (value: unknown) => { key: string; value: T },
    selector?: string | number
  ): Promise<T[]> {
    const base = this.githubUrl(action, selector);
    base.searchParams.set('per_page', String(pageSize));
    base.searchParams.set('page', '1');
    let current = base;
    let expectedTotal: number | undefined;
    let expectedLast: number | undefined;
    let terminalProbe = false;
    let bytes = 0;
    const rows: T[] = [];
    const keys = new Set<string>();
    for (let page = 1; page <= assessmentLimits.maxPages; page += 1) {
      const response = await this.getGitHub(current);
      const container = response.value;
      if (isRecord(container) && (container.incomplete_results === true || container.truncated === true ||
          container.nextLink !== undefined || container['@odata.nextLink'] !== undefined)) {
        throw new LiveFailure('incomplete-pagination', 'The provider marked the inventory incomplete or supplied unsupported continuation metadata.');
      }
      const entries = field === null ? container : isRecord(container) ? container[field] : undefined;
      if (!Array.isArray(entries) || entries.length > pageSize) {
        throw new LiveFailure('invalid-page', 'The provider returned an invalid inventory page.');
      }
      if (field !== null) {
        const count = isRecord(container) ? container.total_count : undefined;
        if (!Number.isSafeInteger(count) || Number(count) < 0) {
          throw new LiveFailure('invalid-page', 'The inventory page did not provide a valid total count.');
        }
        if (expectedTotal !== undefined && expectedTotal !== count) {
          throw new LiveFailure('incomplete-pagination', 'The inventory changed while its pages were being read.');
        }
        expectedTotal = Number(count);
        if (expectedTotal > assessmentLimits.maxPages * pageSize) {
          throw new LiveFailure('page-limit', 'The inventory exceeds the release-owned page limit.');
        }
      }
      for (const entry of entries) {
        const normalized = normalize(entry);
        if (keys.has(normalized.key)) {
          throw new LiveFailure('incomplete-pagination', 'The inventory repeated an entry across pages.');
        }
        keys.add(normalized.key);
        bytes += Buffer.byteLength(JSON.stringify(normalized.value));
        if (bytes > assessmentLimits.responseBytes) {
          throw new LiveFailure('size-limit', 'Normalized inventory metadata exceeded the byte limit.');
        }
        rows.push(normalized.value);
      }
      if (expectedTotal !== undefined && rows.length > expectedTotal) {
        throw new LiveFailure('incomplete-pagination', 'The inventory exceeded its declared total count.');
      }
      const link = response.headers.get('link');
      const { next, last } = link === undefined ? { next: null, last: undefined }
        : this.nextPage(link, base, page, terminalProbe && entries.length === 0);
      if (last !== undefined) {
        if (expectedLast !== undefined && expectedLast !== last) {
          throw new LiveFailure('incomplete-pagination', 'The advertised final inventory page changed during collection.');
        }
        expectedLast = last;
        if (last > assessmentLimits.maxPages) {
          throw new LiveFailure('page-limit', 'The advertised inventory exceeds the release-owned page limit.');
        }
      }
      if (expectedLast !== undefined) {
        if (terminalProbe && entries.length === 0 && page === expectedLast + 1 && next === null) return rows;
        if (page > expectedLast || (page < expectedLast && next === null) || (page === expectedLast && next !== null)) {
          throw new LiveFailure('incomplete-pagination', 'Inventory continuation metadata contradicted the advertised final page.');
        }
      }
      if (next !== null) {
        if (entries.length === 0 || (expectedTotal !== undefined && rows.length >= expectedTotal)) {
          throw new LiveFailure('incomplete-pagination', 'The inventory returned inconsistent continuation metadata.');
        }
        current = next;
        terminalProbe = false;
      } else {
        if (expectedTotal !== undefined) {
          if (rows.length !== expectedTotal) {
            throw new LiveFailure('incomplete-pagination', 'The inventory ended before its declared total count.');
          }
          return rows;
        }
        if (entries.length < pageSize || page === expectedLast) return rows;
        // Bare-array APIs have no total: an exactly full last page needs a terminal read.
        current = new URL(base);
        current.searchParams.set('page', String(page + 1));
        terminalProbe = true;
      }
    }
    throw new LiveFailure('page-limit', 'The inventory could not be completed within the page limit.');
  }

  private nextPage(
    link: string, base: URL, currentPage: number, emptyTerminalProbe: boolean
  ): { next: URL | null; last: number | undefined } {
    let next: URL | null = null;
    let last: number | undefined;
    const relations = new Set<string>();
    for (const item of link.split(',')) {
      const match = /^\s*<([^<>]+)>;\s*rel="(next|prev|first|last)"\s*$/u.exec(item);
      if (!match || relations.has(match[2]!)) {
        throw new LiveFailure('unsafe-continuation', 'The provider supplied an invalid or ambiguous continuation link.');
      }
      relations.add(match[2]!);
      let url: URL;
      try { url = new URL(match[1]!); } catch {
        throw new LiveFailure('unsafe-continuation', 'The provider supplied an invalid continuation URL.');
      }
      if (match[1]!.split('?')[0] !== `${githubApiOrigin}${base.pathname}` ||
          url.origin !== githubApiOrigin || url.username || url.password || url.hash || url.pathname !== base.pathname) {
        throw new LiveFailure('unsafe-continuation', 'A continuation attempted to leave the verified API host or endpoint scope.');
      }
      const params = [...url.searchParams];
      if (new Set(params.map(([key]) => key)).size !== params.length ||
          params.length !== [...base.searchParams].length ||
          params.some(([key, value]) => key !== 'page' && base.searchParams.get(key) !== value) ||
          !/^[1-9]\d*$/u.test(url.searchParams.get('page') ?? '')) {
        throw new LiveFailure('unsafe-continuation', 'A continuation changed the allowlisted query scope.');
      }
      const page = Number(url.searchParams.get('page'));
      if (!Number.isSafeInteger(page) || (match[2] === 'next' && page !== currentPage + 1) ||
          (match[2] === 'prev' && page !== currentPage - 1) || (match[2] === 'first' && page !== 1)) {
        throw new LiveFailure('unsafe-continuation', 'A continuation skipped or repeated an inventory page.');
      }
      if (match[2] === 'next') next = url;
      if (match[2] === 'last') last = page;
    }
    if (last !== undefined &&
        ((last < currentPage && !(emptyTerminalProbe && last === currentPage - 1 && next === null)) ||
         (last > currentPage && next === null) || (last <= currentPage && next !== null))) {
      throw new LiveFailure('incomplete-pagination', 'The next and final page links were incomplete or contradictory.');
    }
    return { next, last };
  }

  private async getGitHub(url: URL): Promise<GitHubResponse> {
    return this.request({
      executable: 'gh',
      args: [
        'api', '--method', 'GET', '--hostname', githubCliHost,
        '--header', 'Accept: application/vnd.github+json',
        '--header', `X-GitHub-Api-Version: ${githubApiVersion}`, '--include', url.href
      ]
    }, parseGitHub);
  }

  async azure(url: string): Promise<unknown> {
    if (!this.verified || !this.azureUrls.has(url) || !url.startsWith(`${armHost}/subscriptions/`)) {
      throw new LiveFailure('unsafe-scope', 'The ARM URL was not an explicitly bound metadata read.');
    }
    return this.request({
      executable: 'az',
      args: ['rest', '--method', 'GET', '--url', url, '--output', 'json', '--only-show-errors']
    }, (stdout) => {
      const value = parseJson(stdout);
      if (isRecord(value) && (value.nextLink !== undefined || value['@odata.nextLink'] !== undefined)) {
        throw new LiveFailure('incomplete-pagination', 'A bound ARM object unexpectedly returned a continuation; it was not followed.');
      }
      return value;
    });
  }

  private async request<T>(command: ExternalCommand, decode: (stdout: string) => T): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      if (this.unavailable.has(command.executable)) {
        throw new LiveFailure('tool-unavailable', 'The required CLI is unavailable; dependent reads were withheld.');
      }
      const remaining = this.remaining();
      const timeoutMs = Math.min(assessmentLimits.requestTimeoutMs, remaining);
      const controller = new AbortController();
      this.active.add(controller);
      const cancellationFailure = () => controller.signal.reason instanceof LiveFailure ? controller.signal.reason
        : new LiveFailure('request-cancelled', 'The scoped read was cancelled.');
      let onAbort: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(cancellationFailure());
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let completed = false;
      try {
        timer = setTimeout(() => {
          if (remaining <= assessmentLimits.requestTimeoutMs) this.expireDeadline();
          else controller.abort(new LiveFailure('request-timeout', 'The scoped read exceeded its request timeout.', true));
        }, timeoutMs);
        const running = Promise.resolve().then(() => {
          if (controller.signal.aborted) throw cancellationFailure();
          this.remaining();
          return this.runner.run(command, {
            stream: false, timeoutMs, maxOutputBytes: assessmentLimits.responseBytes, signal: controller.signal,
            env: {
              GH_HOST: githubCliHost, GH_REPO: '', GH_DEBUG: '', GH_PROMPT_DISABLED: '1',
              GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
              GH_FORCE_TTY: '', NO_COLOR: '1',
              AZURE_CORE_COLLECT_TELEMETRY: 'false', AZURE_CORE_ONLY_SHOW_ERRORS: 'true',
              AZURE_LOGGING_ENABLE_LOG_FILE: 'false', AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no'
            }
          });
        }).finally(() => { completed = true; });
        const result = await Promise.race([running, cancelled]);
        if (controller.signal.aborted) throw cancellationFailure();
        this.remaining();
        if (result.outputLimitExceeded ||
            Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > assessmentLimits.responseBytes) {
          throw new LiveFailure('size-limit', 'The provider response exceeded the byte limit; its body was discarded.');
        }
        if (result.timedOut) throw new LiveFailure('request-timeout', 'The scoped read exceeded its request timeout.', true);
        if (result.aborted) throw new LiveFailure('request-cancelled', 'The scoped read was cancelled.');
        if (result.status !== 0 || result.errorCode) {
          if (command.executable === 'gh' && /^HTTP\/[0-9.]+\s/u.test(result.stdout)) {
            parseGitHub(result.stdout);
          }
          throw httpError(result);
        }
        return decode(result.stdout);
      } catch (error) {
        const failure = error instanceof LiveFailure ? error
          : new LiveFailure('transport-failed', 'The read-only transport failed; error details were withheld.');
        if (failure.code === 'tool-unavailable') this.unavailable.add(command.executable);
        if (!failure.transient || attempt >= assessmentLimits.retries) throw failure;
        this.remaining();
        this.diagnostic({
          code: 'live-retried-request', severity: 'info',
          source: command.executable === 'gh' ? 'github' : 'azure',
          message: 'A transient scoped read failed; the single permitted retry was attempted.'
        });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        this.active.delete(controller);
        controller.signal.removeEventListener('abort', onAbort!);
        if (!completed && !controller.signal.aborted) {
          controller.abort(new LiveFailure('request-cancelled', 'The scoped read was cancelled.'));
        }
      }
    }
  }
}
