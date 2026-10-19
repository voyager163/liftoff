import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubJobIdentityExpectation } from '../src/adapters/github/job-identity.js';

const expected: GitHubJobIdentityExpectation = {
  repository: 'owner/repository', repositoryId: 123, ownerId: 456, actorId: 789,
  runId: 1011, checkRunId: 1213, runAttempt: 1, sourceSha: 'a'.repeat(40),
  workflowRef: 'owner/repository/.github/workflows/identity.yml@refs/heads/feature/identity',
  audience: `urn:liftoff:github-job-identity:${'b'.repeat(64)}`
};
const requestUrl = 'https://pipelines.actions.githubusercontent.com/0123/_apis/distributedtask/hubs/build/plans/plan/jobs/job/idtoken?api-version=2.0';
const requestCredential = 'private-original-request-credential';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = { ...key.publicKey.export({ format: 'jwk' }), kid: 'original-key', alg: 'RS256', use: 'sig' };
const fetchGitHub = vi.fn<typeof fetch>();
let identity: typeof import('../src/adapters/github/job-identity.js');
let token: string;
let jwks: unknown;

function claims(change: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://token.actions.githubusercontent.com', aud: expected.audience,
    sub: `repo:${expected.repository}:ref:refs/heads/feature/identity`,
    repository: expected.repository, repository_id: '123', repository_owner_id: '456',
    actor_id: '789', run_id: '1011', check_run_id: '1213', run_attempt: '1',
    sha: expected.sourceSha, workflow_sha: expected.sourceSha, workflow_ref: expected.workflowRef,
    ref: 'refs/heads/feature/identity', ref_type: 'branch',
    event_name: 'workflow_dispatch', runner_environment: 'github-hosted',
    iat: now, nbf: now - 5, exp: now + 300, ...change
  };
}
function signed(payload = claims(), header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT', kid: 'original-key' }) {
  const prefix = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${prefix}.${sign('RSA-SHA256', Buffer.from(prefix), key.privateKey).toString('base64url')}`;
}
function response(value: unknown) { return new Response(JSON.stringify(value), { status: 200 }); }

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchGitHub);
  identity = await import('../src/adapters/github/job-identity.js');
});
beforeEach(() => {
  vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', requestUrl);
  vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', requestCredential);
  token = signed();
  jwks = { keys: [publicKey] };
  fetchGitHub.mockReset().mockImplementation(async url =>
    String(url) === identity.githubJobIdentityJwks ? response(jwks) : response({ value: token }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
afterAll(() => vi.unstubAllGlobals());

describe('original signed GitHub job identity, not delivery or custody authority', () => {
  it('verifies an actual RSA signature and exact binding, discloses no credential and accepts only its original live observation', async () => {
    const observed = await identity.observeGitHubJobIdentity(expected);
    expect(observed).toMatchObject({
      ...expected, kind: 'github-job-identity-observation', schemaVersion: 1,
      runnerEnvironment: 'github-hosted', workflowAuthority: 'not-issued',
      programDelivery: 'not-established', hostCustody: 'not-established'
    });
    expect(Object.isFrozen(observed)).toBe(true);
    expect(observed.tokenSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(observed)).not.toContain(token);
    expect(JSON.stringify(observed)).not.toContain(requestCredential);
    expect(() => identity.assertCurrentGitHubJobIdentity(observed, expected)).not.toThrow();
    expect(() => identity.assertCurrentGitHubJobIdentity({ ...observed }, expected)).toThrow(/original/);
    expect(() => identity.assertCurrentGitHubJobIdentity(observed, { ...expected, checkRunId: 900 })).toThrow(/original/);
    const [request, options] = fetchGitHub.mock.calls[0]!;
    expect(new URL(String(request)).searchParams.get('audience')).toBe(expected.audience);
    expect(options).toMatchObject({
      method: 'GET', redirect: 'error', cache: 'no-store',
      headers: { Authorization: `Bearer ${requestCredential}` }
    });
    expect(fetchGitHub.mock.calls[1]![0]).toBe(identity.githubJobIdentityJwks);
    expect(fetchGitHub.mock.calls[1]![1]?.headers).not.toHaveProperty('Authorization');
  });
  it.each([
    undefined, null, {}, { ...expected, runAttempt: 2 }, { ...expected, runId: 0 },
    { ...expected, runId: Number.MAX_SAFE_INTEGER + 1 }, { ...expected, repository: 'owner/../other' },
    { ...expected, sourceSha: 'a'.repeat(39) }, { ...expected, audience: 'api://AzureADTokenExchange' },
    { ...expected, workflowRef: 'another/repository/.github/workflows/identity.yml@refs/heads/main' },
    { ...expected, workflowRef: 'owner/repository/.github/workflows/identity.yml@refs/tags/v1' },
    { ...expected, workflowRef: 'owner/repository/.github/workflows/../identity.yml@refs/heads/main' },
    { ...expected, workflowRef: 'owner/repository/.github/workflows/identity.yml@refs/heads/../main' },
    { ...expected, callback: () => true }, { ...expected, token: 'caller-issued' },
    Object.create(expected)
  ])('rejects unsupported expected bindings before requesting a token: %j', async value => {
    await expect(identity.observeGitHubJobIdentity(value)).rejects.toThrow();
    expect(fetchGitHub).not.toHaveBeenCalled();
  });
  it('does not execute getters or proxy traps while capturing a binding', async () => {
    let reads = 0;
    for (const value of [
      { ...expected, get runId() { reads++; return expected.runId; } },
      new Proxy(expected, { get() { reads++; return expected.runId; } }),
      { ...expected, [Symbol('authority')]: true }
    ]) await expect(identity.observeGitHubJobIdentity(value)).rejects.toThrow();
    expect(reads).toBe(0);
    expect(fetchGitHub).not.toHaveBeenCalled();
  });
  it.each([
    '', 'http://pipelines.actions.githubusercontent.com/jobs/job/idtoken',
    'https://outside.example/jobs/job/idtoken',
    'https://pipelines.actions.githubusercontent.com.outside.example/jobs/job/idtoken',
    'https://outside.actions.githubusercontent.com/jobs/job/idtoken',
    'https://user@pipelines.actions.githubusercontent.com/jobs/job/idtoken',
    'https://pipelines.actions.githubusercontent.com:8443/jobs/job/idtoken',
    `${requestUrl}#fragment`, `${requestUrl}&audience=injected`, `${requestUrl}&api-version=2.0`,
    'https://pipelines.actions.githubusercontent.com/another-endpoint'
  ])('never sends a credential to an unsupported endpoint: %s', async url => {
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', url);
    await expect(identity.observeGitHubJobIdentity(expected)).rejects.toThrow();
    expect(fetchGitHub).not.toHaveBeenCalled();
  });
  it.each([
    ['https://private-endpoint-user@pipelines.actions.githubusercontent.com/jobs/job/idtoken', 'transport'],
    ['https://private-endpoint-host.example/jobs/job/idtoken', 'host'],
    ['https://pipelines.actions.githubusercontent.com/private-endpoint-path', 'path-unsupported'],
    [`${requestUrl}&private-endpoint-query=private-endpoint-value`, 'query']
  ])('reports only a fixed endpoint rejection stage: %s', async (url, stage) => {
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', url);
    const error = await identity.observeGitHubJobIdentity(expected).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: `github-job-identity-endpoint-${stage}` });
    expect(String(error)).not.toMatch(/private-endpoint|private-original-request-credential/);
    expect(fetchGitHub).not.toHaveBeenCalled();
  });
  it.each([
    ['/idtoken', 'root-idtoken'], ['/jobs/opaque/token', 'token'],
    ['/jobs/opaque/idtoken/', 'trailing-slash'], ['/jobs/opaque/IdToken', 'idtoken-encoding-or-case']
  ])('classifies unsupported token paths without returning original path data: %s', async (pathname, shape) => {
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', `https://pipelines.actions.githubusercontent.com${pathname}`);
    await expect(identity.observeGitHubJobIdentity(expected)).rejects.toMatchObject({
      code: `github-job-identity-endpoint-path-${shape}`
    });
    expect(fetchGitHub).not.toHaveBeenCalled();
  });
  it.each(['', 'private\ncredential', 'a'.repeat(16_385)])('refuses absent or unsafe request credentials without fallback', async value => {
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', value);
    await expect(identity.observeGitHubJobIdentity(expected)).rejects.toMatchObject({ code: 'github-job-identity-unavailable' });
    expect(fetchGitHub).not.toHaveBeenCalled();
  });
  it.each([
    { iss: 'https://another.example' }, { aud: 'api://AzureADTokenExchange' }, { aud: [expected.audience] },
    { repository: 'owner/another' }, { repository_id: '999' }, { repository_owner_id: '999' },
    { actor_id: '999' }, { run_id: '999' }, { check_run_id: '999' }, { run_attempt: '2' },
    { sha: 'c'.repeat(40) }, { workflow_sha: 'c'.repeat(40) },
    { workflow_ref: expected.workflowRef.replace('identity.yml', 'another.yml') },
    { event_name: 'pull_request' }, { runner_environment: 'self-hosted' },
    { ref: 'refs/heads/main' }, { ref_type: 'tag' }, { sub: 'repo:owner/repository:environment:prod' },
    { job_workflow_ref: expected.workflowRef }, { job_workflow_sha: expected.sourceSha }, { environment: 'prod' },
    { run_id: expected.runId }, { check_run_id: expected.checkRunId }, { iat: 'now' }, { exp: null }, { nbf: 'now' }
  ])('rejects a genuinely signed but foreign or unsupported claim: %j', async change => {
    token = signed(claims(change));
    await expect(identity.observeGitHubJobIdentity(expected)).rejects.toMatchObject({ code: 'github-job-identity-claims' });
    expect(fetchGitHub).toHaveBeenCalledTimes(1);
  });
  it.each(['expired', 'future-issue', 'old-issue', 'future-not-before', 'not-before-after-expiry', 'overlong'])(
    'rejects %s token lifetimes', async kind => {
      const now = Math.floor(Date.now() / 1000);
      const changes: Record<string, Record<string, number>> = {
        expired: { exp: now }, 'future-issue': { iat: now + 31 },
        'old-issue': { iat: now - 601 }, 'future-not-before': { nbf: now + 31 },
        'not-before-after-expiry': { nbf: now + 20, exp: now + 10 },
        overlong: { exp: now + 601 }
      };
      token = signed(claims(changes[kind]));
      await expect(identity.observeGitHubJobIdentity(expected)).rejects.toMatchObject({ code: 'github-job-identity-claims' });
    }
  );
  it.each([
    { alg: 'none' }, { alg: 'HS256' }, { typ: 'other' }, { kid: undefined },
    { jku: 'https://outside.example/keys' }, { jwk: publicKey }, { crit: ['b64'], b64: false },
    { x5t: ['not-scalar'] }
  ])('refuses algorithm/key selection from the token header: %j', async change => {
    token = signed(claims(), { alg: 'RS256', typ: 'JWT', kid: 'original-key', ...change });
    await expect(identity.observeGitHubJobIdentity(expected)).rejects.toMatchObject({ code: 'github-job-identity-token' });
    expect(fetchGitHub).toHaveBeenCalledTimes(1);
  });
  it.each(['not-jwt', 'a.b.c', `${'a'.repeat(16_385)}.b.c`, 'e30.e30.', 'e30=.e30.signature'])(
    'rejects malformed or oversized compact tokens without issuer-key reads: %s', async value => {
      token = value;
      await expect(identity.observeGitHubJobIdentity(expected)).rejects.toThrow();
      expect(fetchGitHub).toHaveBeenCalledTimes(1);
    }
  );
  it.each([
    {}, { keys: [] }, { keys: Array(21).fill(publicKey) },
    { keys: [{ ...publicKey, kid: 'another' }] }, { keys: [publicKey, publicKey] },
    { keys: [{ ...publicKey, alg: 'HS256' }] }, { keys: [{ ...publicKey, use: 'enc' }] },
    { keys: [{ ...publicKey, kty: 'EC' }] }, { keys: [{ ...publicKey, n: 'bad=' }] },
    { keys: [{ ...publicKey, n: 'a'.repeat(1367) }] }, { keys: [{ ...publicKey, e: 'a'.repeat(12) }] }
  ])('refuses missing, ambiguous or unsupported issuer keys: %j', async value => {
    jwks = value;
    await expect(identity.observeGitHubJobIdentity(expected)).rejects.toThrow();
    expect(fetchGitHub).toHaveBeenCalledTimes(2);
  });
  it('refuses an altered signed body and an unrelated issuer key', async () => {
    const parts = token.split('.');
    const altered = claims({ workflow: 'tampered-private-token-content' });
    token = `${parts[0]}.${Buffer.from(JSON.stringify(altered)).toString('base64url')}.${parts[2]}`;
    await expect(identity.observeGitHubJobIdentity(expected)).rejects.toMatchObject({ code: 'github-job-identity-signature' });
    token = signed();
    const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 });
    jwks = { keys: [{ ...publicKey, ...foreign.publicKey.export({ format: 'jwk' }) }] };
    await expect(identity.observeGitHubJobIdentity(expected)).rejects.toMatchObject({ code: 'github-job-identity-signature' });
  });
  it('refuses an undersized issuer RSA key', async () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
    jwks = { keys: [{ ...publicKey, ...weak.publicKey.export({ format: 'jwk' }) }] };
    await expect(identity.observeGitHubJobIdentity(expected)).rejects.toMatchObject({ code: 'github-job-identity-signature' });
  });
  it('enforces the independent JWKS response bound', async () => {
    for (const body of [
      new Response('small', { headers: { 'content-length': '65537' } }),
      new Response('a'.repeat(65_537))
    ]) {
      fetchGitHub.mockResolvedValueOnce(response({ value: token })).mockResolvedValueOnce(body);
      await expect(identity.observeGitHubJobIdentity(expected)).rejects.toMatchObject({ code: 'github-job-identity-response' });
    }
    expect(fetchGitHub).toHaveBeenCalledTimes(4);
  });
  it.each([302, 401, 403, 429, 500])('refuses HTTP %s without following a redirect or trying a fallback', async status => {
    fetchGitHub.mockResolvedValueOnce(new Response('private-provider-diagnostics', { status }));
    await expect(identity.observeGitHubJobIdentity(expected)).rejects.toMatchObject({ code: 'github-job-identity-response' });
    expect(fetchGitHub).toHaveBeenCalledTimes(1);
  });
  it.each([
    new Response('private-invalid-json'),
    new Response(new Uint8Array([0xff, 0xfe])),
    new Response('small', { headers: { 'content-length': '32769' } }),
    new Response('small', { headers: { 'content-length': 'unknown' } }),
    new Response('a'.repeat(32_769)),
    new Response(null),
    response({ value: null })
  ])('refuses malformed, absent and oversized response bodies without issuing proof', async value => {
    fetchGitHub.mockResolvedValueOnce(value.clone());
    await expect(identity.observeGitHubJobIdentity(expected)).rejects.toThrow();
    expect(fetchGitHub).toHaveBeenCalledTimes(1);
  });
  it('withholds network and streaming diagnostics', async () => {
    fetchGitHub.mockRejectedValueOnce(new Error(`private-provider-diagnostics:${requestCredential}`));
    await expect(identity.observeGitHubJobIdentity(expected)).rejects.not.toThrow(requestCredential);
    fetchGitHub.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.error(new Error(`private-stream-diagnostics:${requestCredential}`)); }
    })));
    await expect(identity.observeGitHubJobIdentity(expected)).rejects.toMatchObject({ code: 'github-job-identity-unavailable' });
  });
  it('starts no request for a pre-aborted invocation', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(identity.observeGitHubJobIdentity(expected, abort.signal)).rejects.toMatchObject({ code: 'github-job-identity-aborted' });
    expect(fetchGitHub).not.toHaveBeenCalled();
  });
  it('does not advance to issuer keys after the exact token-arrival/abort microtask race', async () => {
    const abort = new AbortController();
    fetchGitHub.mockImplementationOnce(async () => {
      queueMicrotask(() => abort.abort());
      return response({ value: token });
    });
    await expect(identity.observeGitHubJobIdentity(expected, abort.signal)).rejects.toMatchObject({ code: 'github-job-identity-aborted' });
    expect(fetchGitHub).toHaveBeenCalledTimes(1);
  });
  it('captures the original selectors before caller substitution during token observation', async () => {
    const mutable = { ...expected };
    fetchGitHub.mockImplementationOnce(async () => {
      mutable.sourceSha = 'd'.repeat(40);
      mutable.runId = 900;
      return response({ value: token });
    });
    const observed = await identity.observeGitHubJobIdentity(mutable);
    expect(observed.sourceSha).toBe(expected.sourceSha);
    expect(observed.runId).toBe(expected.runId);
    expect(() => identity.assertCurrentGitHubJobIdentity(observed, mutable)).toThrow();
    expect(() => identity.assertCurrentGitHubJobIdentity(observed, expected)).not.toThrow();
  });
  it('refuses cancellation during key observation without issuing late proof', async () => {
    const abort = new AbortController();
    fetchGitHub.mockResolvedValueOnce(response({ value: token })).mockImplementationOnce(async () => {
      queueMicrotask(() => abort.abort());
      return response(jwks);
    });
    await expect(identity.observeGitHubJobIdentity(expected, abort.signal)).rejects.toMatchObject({ code: 'github-job-identity-aborted' });
    expect(fetchGitHub).toHaveBeenCalledTimes(2);
  });
  it('bounds a nonsettling request and refuses a late token without starting another request', async () => {
    vi.useFakeTimers();
    let settle: ((response: Response) => void) | undefined;
    fetchGitHub.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    const result = identity.observeGitHubJobIdentity(expected).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ code: 'github-job-identity-timeout' });
    settle!(response({ value: token }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchGitHub).toHaveBeenCalledTimes(1);
  });
  it('shares one deadline across both requests and body reads', async () => {
    vi.useFakeTimers();
    fetchGitHub.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 6_000));
      return response({ value: token });
    }).mockImplementationOnce(() => new Promise(() => {}));
    const result = identity.observeGitHubJobIdentity(expected).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ code: 'github-job-identity-timeout' });
    expect(fetchGitHub).toHaveBeenCalledTimes(2);
    fetchGitHub.mockReset().mockResolvedValueOnce(new Response(new ReadableStream()));
    const stream = identity.observeGitHubJobIdentity(expected).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await stream).toMatchObject({ code: 'github-job-identity-timeout' });
  });
  it('rejects expiry during key observation and expiry of a previously issued original observation', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    token = signed(claims({ exp: Math.floor(now / 1000) + 1 }));
    fetchGitHub.mockImplementationOnce(async () => response({ value: token })).mockImplementationOnce(async () => {
      vi.setSystemTime(now + 2_000);
      return response(jwks);
    });
    await expect(identity.observeGitHubJobIdentity(expected)).rejects.toMatchObject({ code: 'github-job-identity-expired' });
    token = signed();
    fetchGitHub.mockImplementation(async url =>
      String(url) === identity.githubJobIdentityJwks ? response(jwks) : response({ value: token }));
    const observed = await identity.observeGitHubJobIdentity(expected);
    vi.setSystemTime(new Date(observed.expiresAt).getTime());
    expect(() => identity.assertCurrentGitHubJobIdentity(observed, expected)).toThrow(/unexpired/);
  });
});
