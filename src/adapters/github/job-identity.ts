import { constants, createHash, createPublicKey, verify } from 'node:crypto';
import { types } from 'node:util';
import { GitHubActivationError, githubRef, githubRepository, positiveId } from './activation-rest.js';

export const githubJobIdentityIssuer = 'https://token.actions.githubusercontent.com';
export const githubJobIdentityJwks = `${githubJobIdentityIssuer}/.well-known/jwks`;
const fetchGitHub = globalThis.fetch.bind(globalThis);
const deadlineMs = 10_000;
const maximumTokenBytes = 16_384;

export interface GitHubJobIdentityExpectation {
  readonly repository: string;
  readonly repositoryId: number;
  readonly ownerId: number;
  readonly actorId: number;
  readonly runId: number;
  readonly checkRunId: number;
  readonly runAttempt: 1;
  readonly sourceSha: string;
  readonly workflowRef: string;
  readonly audience: string;
}

export interface GitHubJobIdentityObservation extends GitHubJobIdentityExpectation {
  readonly schemaVersion: 1;
  readonly kind: 'github-job-identity-observation';
  readonly issuer: typeof githubJobIdentityIssuer;
  readonly runnerEnvironment: 'github-hosted';
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly tokenSha256: string;
  readonly workflowAuthority: 'not-issued';
  readonly programDelivery: 'not-established';
  readonly hostCustody: 'not-established';
}

const observations = new WeakMap<GitHubJobIdentityObservation, { binding: string; expiresAt: number }>();
function failure(code: string, message: string): never {
  throw new GitHubActivationError(`github-job-identity-${code}`, message);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !types.isProxy(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).every(key => typeof key === 'string') &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(field =>
      field.enumerable && Object.hasOwn(field, 'value'));
}
function expectation(value: unknown): GitHubJobIdentityExpectation {
  const fields = ['repository', 'repositoryId', 'ownerId', 'actorId', 'runId', 'checkRunId',
    'runAttempt', 'sourceSha', 'workflowRef', 'audience'];
  if (!record(value) || Object.keys(value).sort().join() !== fields.sort().join() ||
    value.runAttempt !== 1 || typeof value.sourceSha !== 'string' || !/^[a-f0-9]{40}$/u.test(value.sourceSha) ||
    typeof value.workflowRef !== 'string' || typeof value.audience !== 'string' ||
    !/^urn:liftoff:github-job-identity:[a-f0-9]{64}$/u.test(value.audience)) {
    return failure('binding', 'Job identity requires one exact repository, original job/run, source, workflow and purpose-bound audience; callbacks and credential inputs are prohibited.');
  }
  const repository = githubRepository(value.repository);
  const prefix = `${repository}/.github/workflows/`;
  const parts = value.workflowRef.split('@');
  if (parts.length !== 2 || !parts[0]!.startsWith(prefix) ||
    !/^[A-Za-z0-9_-]+\.ya?ml$/u.test(parts[0]!.slice(prefix.length)) ||
    !parts[1]!.startsWith('refs/heads/')) {
    return failure('binding', 'Job identity requires one literal same-repository branch workflow; reusable workflows and implicit references are unsupported.');
  }
  githubRef(parts[1]!.slice('refs/heads/'.length));
  return Object.freeze({
    repository, repositoryId: positiveId(value.repositoryId), ownerId: positiveId(value.ownerId),
    actorId: positiveId(value.actorId), runId: positiveId(value.runId), checkRunId: positiveId(value.checkRunId),
    runAttempt: 1, sourceSha: value.sourceSha, workflowRef: value.workflowRef, audience: value.audience
  });
}
function json(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return failure('response', 'Job identity returned invalid bounded UTF-8 JSON; credential and response bytes were withheld.'); }
}
function base64(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return failure('token', 'Job identity returned an unsupported compact token.');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) return failure('token', 'Job identity returned a noncanonical compact token.');
  return bytes;
}
function requestUrl(raw: string | undefined, audience: string): URL {
  let url: URL;
  try { url = new URL(raw ?? ''); }
  catch { return failure('unavailable', 'A genuine GitHub Actions token endpoint is unavailable; no ambient credential fallback was attempted.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    return failure('endpoint-transport', 'Job credentials require an original HTTPS endpoint without URL credentials, a custom port or a fragment.');
  }
  if (!/^(?:pipelines[a-z0-9-]*|run-actions-[a-z0-9-]+)\.actions\.githubusercontent\.com$/u.test(url.hostname)) {
    return failure('endpoint-host', 'The original endpoint is not a supported GitHub Actions token service host.');
  }
  if (!/^\/[A-Za-z0-9_./-]+\/idtoken$/u.test(url.pathname)) {
    return failure('endpoint-path', 'The original GitHub Actions endpoint is not a supported token path.');
  }
  if ([...url.searchParams.keys()].some(key => key !== 'api-version') ||
    url.searchParams.getAll('api-version').length > 1) {
    return failure('endpoint-query', 'The original GitHub Actions endpoint has unsupported query selectors or an injected audience.');
  }
  url.searchParams.set('audience', audience);
  return url;
}

/** Verifies GitHub's job claims only; this is not program delivery, custody or effect approval. */
export async function observeGitHubJobIdentity(value: unknown, signal?: AbortSignal): Promise<GitHubJobIdentityObservation> {
  const expected = expectation(value);
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const aborted = () => failure(timedOut ? 'timeout' : 'aborted',
    'Job identity observation was cancelled or exceeded its total ten-second deadline; no observation was issued.');
  const check = () => {
    if (Date.now() - started >= deadlineMs) timedOut = true;
    if (timedOut || signal?.aborted || controller.signal.aborted) return aborted();
  };
  check();
  const url = requestUrl(process.env.ACTIONS_ID_TOKEN_REQUEST_URL, expected.audience);
  const credential = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!credential || credential.length > maximumTokenBytes || /[\s\u0000-\u001f\u007f]/u.test(credential)) {
    return failure('unavailable', 'The original GitHub Actions request credential is unavailable; no login or credential fallback was attempted.');
  }
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let rejectAbort: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => {
      try { aborted(); } catch (error) { reject(error); }
    };
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadlineMs);
  async function read(url: URL | string, maximum: number, authorization?: string): Promise<unknown> {
    check();
    let response: Response;
    try {
      response = await fetchGitHub(url, {
        method: 'GET', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/json', ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) }
      });
    } catch {
      check();
      return failure('unavailable', 'The fixed GitHub identity endpoint could not be read; credentials and provider diagnostics were withheld.');
    }
    check();
    const length = response.headers.get('content-length');
    if (response.status !== 200 || !response.body || length !== null &&
      (!/^[0-9]+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) {
      return failure('response', 'The GitHub identity endpoint did not return a complete bounded successful response.');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        check();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maximum) {
          return failure('response', 'The GitHub identity response exceeded its byte bound; no observation was issued.');
        }
        chunks.push(part.value);
      }
      return json(Buffer.concat(chunks, size));
    } catch (error) {
      check();
      if (error instanceof GitHubActivationError) throw error;
      return failure('unavailable', 'The bounded GitHub identity response could not be completed; credential and stream diagnostics were withheld.');
    } finally { reader.releaseLock(); }
  }
  async function observe(): Promise<GitHubJobIdentityObservation> {
    const response = await read(url, 32_768, credential);
    if (!record(response) || typeof response.value !== 'string' ||
      Buffer.byteLength(response.value) > maximumTokenBytes) {
      return failure('token', 'GitHub did not return one bounded compact identity token.');
    }
    const token = response.value;
    const segments = token.split('.');
    if (segments.length !== 3) return failure('token', 'GitHub returned an unsupported compact identity token.');
    const header = json(base64(segments[0]!));
    const claims = json(base64(segments[1]!));
    const signature = base64(segments[2]!);
    if (!record(header) || header.alg !== 'RS256' || header.typ !== 'JWT' ||
      typeof header.kid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(header.kid) ||
      Object.keys(header).some(key => !['alg', 'typ', 'kid', 'x5t'].includes(key)) ||
      Object.hasOwn(header, 'x5t') && (typeof header.x5t !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(header.x5t)) ||
      signature.length < 256 || signature.length > 1024 || !record(claims)) {
      return failure('token', 'GitHub job identity requires the supported RS256 token without caller-selected keys or algorithms.');
    }
    const now = Math.floor(Date.now() / 1000);
    const { iat, nbf, exp } = claims;
    if (typeof iat !== 'number' || !Number.isSafeInteger(iat) ||
      typeof nbf !== 'number' || !Number.isSafeInteger(nbf) ||
      typeof exp !== 'number' || !Number.isSafeInteger(exp) ||
      iat > now + 30 || iat < now - 600 || nbf > now + 30 || nbf < iat - 30 ||
      exp <= now || exp <= iat || nbf >= exp || exp - iat > 600 ||
      claims.iss !== githubJobIdentityIssuer || claims.aud !== expected.audience ||
      claims.repository !== expected.repository || claims.repository_id !== String(expected.repositoryId) ||
      claims.repository_owner_id !== String(expected.ownerId) || claims.actor_id !== String(expected.actorId) ||
      claims.run_id !== String(expected.runId) || claims.check_run_id !== String(expected.checkRunId) ||
      claims.run_attempt !== '1' || claims.sha !== expected.sourceSha ||
      claims.workflow_sha !== expected.sourceSha || claims.workflow_ref !== expected.workflowRef ||
      claims.event_name !== 'workflow_dispatch' || claims.runner_environment !== 'github-hosted' ||
      claims.ref !== expected.workflowRef.split('@')[1] || claims.ref_type !== 'branch' ||
      claims.sub !== `repo:${expected.repository}:ref:${claims.ref}` ||
      Object.hasOwn(claims, 'job_workflow_ref') || Object.hasOwn(claims, 'job_workflow_sha') ||
      Object.hasOwn(claims, 'environment')) {
      return failure('claims', 'Signed job identity must match the exact original repository, actor, job/run, source, workflow, purpose, host kind and current lifetime; reruns and unsupported subject forms are refused.');
    }
    const jwks = await read(githubJobIdentityJwks, 65_536);
    if (!record(jwks) || !Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 20) {
      return failure('keys', 'The fixed GitHub issuer returned no bounded signing-key inventory.');
    }
    const matching = jwks.keys.filter((key: unknown) => record(key) && key.kid === header.kid);
    if (matching.length !== 1 || !record(matching[0])) {
      return failure('keys', 'The fixed GitHub issuer did not identify one unambiguous signing key.');
    }
    const key = matching[0];
    if (key.kty !== 'RSA' || key.alg !== 'RS256' || key.use !== 'sig' ||
      typeof key.n !== 'string' || key.n.length > 1366 ||
      typeof key.e !== 'string' || key.e.length > 11) {
      return failure('keys', 'The fixed GitHub issuer returned an unsupported signing key.');
    }
    base64(key.n); base64(key.e);
    let valid: boolean;
    try {
      const publicKey = createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' });
      const bits = publicKey.asymmetricKeyDetails?.modulusLength;
      valid = bits !== undefined && bits >= 2048 && bits <= 8192 &&
        verify('RSA-SHA256', Buffer.from(`${segments[0]}.${segments[1]}`),
          { key: publicKey, padding: constants.RSA_PKCS1_PADDING }, signature);
    } catch {
      return failure('signature', 'GitHub job signature verification failed; key and token bytes were withheld.');
    }
    if (!valid) return failure('signature', 'GitHub did not cryptographically verify this exact job identity.');
    check();
    if (Date.now() >= exp * 1000) return failure('expired', 'GitHub job identity expired during observation.');
    const observation: GitHubJobIdentityObservation = Object.freeze({
      ...expected, schemaVersion: 1, kind: 'github-job-identity-observation',
      issuer: githubJobIdentityIssuer, runnerEnvironment: 'github-hosted',
      observedAt: new Date().toISOString(), expiresAt: new Date(exp * 1000).toISOString(),
      tokenSha256: createHash('sha256').update(token).digest('hex'),
      workflowAuthority: 'not-issued', programDelivery: 'not-established', hostCustody: 'not-established'
    });
    observations.set(observation, { binding: JSON.stringify(expected), expiresAt: exp * 1000 });
    return observation;
  }
  try { return await Promise.race([observe(), abort]); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
    controller.abort();
  }
}

export function assertCurrentGitHubJobIdentity(value: GitHubJobIdentityObservation, binding: unknown): void {
  const issued = observations.get(value);
  if (!issued || issued.binding !== JSON.stringify(expectation(binding)) || Date.now() >= issued.expiresAt) {
    return failure('observation', 'Only the original independently verified, unexpired job observation may be reused for its exact binding; a copied record is not authority.');
  }
}
