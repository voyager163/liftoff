import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  GitHubActivationClient, GitHubActivationError, apiPath, createAuthenticatedGitHubTransport, createGitHubCliTransport,
  expectStatus, githubName, githubRef, githubRepository, object, positiveId, safeGitHubFailure, text,
  type GitHubActivationTransport, type GitHubRequest, type GitHubResponse
} from '../src/adapters/github/activation-rest.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';

const projectRoot = path.join(process.cwd(), '.cache', `governance-github-rest-${process.pid}`);
const credentialMarker = ['credential', 'marker', 'for', 'rest', 'tests'].join('-');

function thrown(action: () => unknown): GitHubActivationError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubActivationError);
    return error as GitHubActivationError;
  }
  throw new Error('Expected the GitHub adapter to refuse the input.');
}

async function rejected(action: () => Promise<unknown>): Promise<GitHubActivationError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubActivationError);
    return error as GitHubActivationError;
  }
  throw new Error('Expected the GitHub adapter to reject the request.');
}

function response(status: number, data: unknown = null, headers: Record<string, string> = {}): GitHubResponse {
  return { status, headers, data };
}

class CannedRunner implements CommandRunner {
  readonly calls: Array<{ command: ExternalCommand; options?: RunCommandOptions }> = [];

  constructor(private readonly result: Partial<CommandResult>) {}

  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push({ command, options });
    return {
      command, displayCommand: 'gh api', status: 0, signal: null, stdout: '', stderr: '', timedOut: false,
      ...this.result
    };
  }
}

class ScriptedTransport implements GitHubActivationTransport {
  readonly requests: GitHubRequest[] = [];

  constructor(private readonly respond: (request: GitHubRequest, index: number) => GitHubResponse) {}

  async request(request: GitHubRequest): Promise<GitHubResponse> {
    this.requests.push(request);
    return this.respond(request, this.requests.length - 1);
  }
}

describe('GitHub activation request boundaries', () => {
  it('accepts only fixed, scoped REST endpoints', () => {
    for (const endpoint of [
      '/repos/owner/repo', '/orgs/acme/actions/hosted-runners?per_page=100', '/user', '/users/octo',
      '/app/installations/1', '/installation/repositories', '/applications/1/token'
    ]) {
      expect(apiPath(endpoint)).toBe(endpoint);
    }
    for (const endpoint of [
      'https://api.github.com/repos/o/r', 'repos/o/r', '/graphql', '/search/code?q=token', '/repositories/1',
      '/repos/o/r#fragment', '/repos/o r', '/repos\\o\\r', '/repos/o/r\u0000', '/repos/o/r\u007f',
      '/repos/%2e%2e/admin', '/repos/o%2Fr', '/repos/o/%5cr', '/repos/../orgs/acme', '/repos/./o/r', '/repos/o/r/..?x=1'
    ]) {
      const error = thrown(() => apiPath(endpoint));
      expect(error.code).toBe('invalid-endpoint');
      expect(error.status).toBeUndefined();
    }
  });

  it('requires explicit names, repositories, and refs before any provider access', () => {
    expect(githubName('my.repo_name-1')).toBe('my.repo_name-1');
    for (const value of [42, '', '-leading', '.hidden', 'a..b', 'x'.repeat(101), 'has space', 'semi;colon', 'slash/name']) {
      expect(thrown(() => githubName(value, 'Owner')).message).toBe('Owner must be an explicit GitHub path segment.');
    }
    expect(githubRepository('Owner/Repo')).toBe('Owner/Repo');
    for (const value of ['owner', 'a/b/c', 42, undefined]) {
      expect(thrown(() => githubRepository(value)).code).toBe('repository-required');
    }
    for (const value of ['owner/..', 'owner/-x', '/repo', 'owner/']) {
      expect(thrown(() => githubRepository(value)).code).toBe('invalid-input');
    }
    for (const value of ['develop', 'release/1.2.3', 'v1.0.0']) expect(githubRef(value)).toBe(value);
    for (const value of ['feature//x', 'x/', 'x.lock', 'refs/.hidden', '../x', '-x', 'a'.repeat(201), 42, 'a b', 'a..b']) {
      expect(thrown(() => githubRef(value)).code).toBe('invalid-ref');
    }
  });

  it('rejects non-object, non-positive, and unbounded provider fields', () => {
    for (const value of [null, [], Buffer.from('{}'), 'object', 1]) {
      expect(thrown(() => object(value, 'Installation')).message).toBe('Installation did not return a JSON object.');
    }
    expect(object({ id: 1 })).toEqual({ id: 1 });
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      expect(thrown(() => positiveId(value)).code).toBe('invalid-response');
    }
    expect(positiveId(9)).toBe(9);
    for (const value of ['', 'x'.repeat(1025), 'line\nbreak', 'delete\u007f', 5, undefined]) {
      expect(thrown(() => text(value, 'Token expiry')).message).toBe('Token expiry is absent or invalid.');
    }
    expect(text('ok', 'Label')).toBe('ok');
  });

  it('maps provider statuses to bounded reasons without copying response bodies', () => {
    const body = { message: `Bad credentials ${credentialMarker}`, documentation_url: 'https://docs.github.com' };
    const cases: Array<[number, RegExp]> = [
      [401, /authentication is missing or expired/], [403, /lacks permission or the account capability is unavailable/],
      [404, /absent or is not visible to this identity/], [409, /conflicts with the reviewed operation/],
      [422, /conflicts with the reviewed operation/], [429, /rate limit was reached/], [500, /did not confirm the requested result/],
      [302, /did not confirm the requested result/]
    ];
    for (const [status, reason] of cases) {
      const error = thrown(() => expectStatus(response(status, body), [200], 'Read /repos/o/r'));
      expect(error).toMatchObject({ code: 'provider-response', status });
      expect(error.message).toMatch(reason);
      expect(error.message).toContain(`(HTTP ${status})`);
      expect(error.message.startsWith('Read /repos/o/r: ')).toBe(true);
      expect(error.message).not.toContain(credentialMarker);
    }
    const accepted = response(204);
    expect(expectStatus(accepted, [200, 204], 'Apply')).toBe(accepted);
  });

  it('keeps provider-authored refusals public and withholds every other diagnostic', () => {
    expect(safeGitHubFailure(new GitHubActivationError('scope', 'The installation is over-scoped.'))).toBe('The installation is over-scoped.');
    for (const failure of [new Error(`stderr: token=${credentialMarker}`), `raw ${credentialMarker}`, { credentialMarker }]) {
      const message = safeGitHubFailure(failure);
      expect(message).toMatch(/provider diagnostics were withheld/);
      expect(message).not.toContain(credentialMarker);
    }
  });
});

describe('GitHub CLI activation transport', () => {
  it('issues literal bounded gh api requests and passes bodies only on stdin', async () => {
    const runner = new CannedRunner({
      stdout: 'HTTP/2.0 201 Created\r\nContent-Type: application/json\r\nLink: <https://api.github.com/x?page=2>; rel="next"\r\n\r\n{"id":7}'
    });
    const body = { title: 'Reviewed issue', note: credentialMarker };
    const result = await createGitHubCliTransport(runner, projectRoot).request({ method: 'POST', path: '/repos/o/r/issues', body });

    expect(result).toEqual({
      status: 201,
      headers: { 'content-type': 'application/json', link: '<https://api.github.com/x?page=2>; rel="next"' },
      data: { id: 7 }
    });
    expect(runner.calls).toHaveLength(1);
    const [{ command, options }] = runner.calls;
    expect(command).toEqual({
      executable: 'gh',
      args: [
        'api', '--hostname', 'github.com', '--method', 'POST', '--header', 'X-GitHub-Api-Version: 2026-03-10',
        '--header', 'Accept: application/vnd.github+json', '--include', '/repos/o/r/issues', '--input', '-'
      ]
    });
    expect(command.args.join(' ')).not.toContain(credentialMarker);
    expect(options).toMatchObject({
      cwd: projectRoot, stdin: JSON.stringify(body), timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024, stream: false,
      env: { GH_DEBUG: '', GH_PAGER: 'cat', GH_PROMPT_DISABLED: '1' }
    });
  });

  it('omits the stdin input flag for body-free reads', async () => {
    const runner = new CannedRunner({ stdout: 'HTTP/2 200 OK\r\n\r\n{"login":"octo"}' });
    await expect(createGitHubCliTransport(runner, projectRoot).request({ method: 'GET', path: '/user' }))
      .resolves.toMatchObject({ status: 200, data: { login: 'octo' } });
    expect(runner.calls[0]!.command.args).not.toContain('--input');
    expect(runner.calls[0]!.options?.stdin).toBeUndefined();
  });

  it('parses informational, LF-only, empty, and non-success responses for the caller to interpret', async () => {
    const cases: Array<[string, GitHubResponse]> = [
      ['HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 204 No Content\r\nX-Test: a:b\r\n\r\n', response(204, null, { 'x-test': 'a:b' })],
      ['HTTP/2 404 Not Found\nx-github-request-id: 1\n\n{"message":"Not Found"}',
        response(404, { message: 'Not Found' }, { 'x-github-request-id': '1' })]
    ];
    for (const [stdout, expected] of cases) {
      await expect(createGitHubCliTransport(new CannedRunner({ stdout }), projectRoot).request({ method: 'GET', path: '/repos/o/r' }))
        .resolves.toEqual(expected);
    }
  });

  it('rejects incomplete, status-less, and invalid output without echoing provider bytes', async () => {
    const cases: Array<[string, RegExp]> = [
      ['HTTP/2 200 OK\r\nx-partial: yes', /incomplete response headers/],
      ['{"not":"http"}', /did not return an HTTP status/],
      ['HTTP/2 abc\r\n\r\n{}', /did not return an HTTP status/],
      ['HTTP/2 99 Low\r\n\r\n{}', /did not return an HTTP status/],
      [`HTTP/2 200 OK\r\n\r\n{"token":"${credentialMarker}"`, /invalid JSON; response bytes were withheld/]
    ];
    for (const [stdout, expected] of cases) {
      const error = await rejected(() => createGitHubCliTransport(new CannedRunner({ stdout }), projectRoot)
        .request({ method: 'GET', path: '/repos/o/r' }));
      expect(error.code).toBe('invalid-response');
      expect(error.message).toMatch(expected);
      expect(error.message).not.toContain(credentialMarker);
    }
  });

  it('fails closed when the bounded gh execution does not complete', async () => {
    const complete = 'HTTP/2 200 OK\r\n\r\n{"id":1}';
    for (const failure of [
      { timedOut: true }, { outputLimitExceeded: true }, { errorCode: 'ENOENT' }, { aborted: true }
    ] satisfies Partial<CommandResult>[]) {
      const error = await rejected(() => createGitHubCliTransport(new CannedRunner({ stdout: complete, ...failure }), projectRoot)
        .request({ method: 'GET', path: '/repos/o/r' }));
      expect(error).toMatchObject({ code: 'bounded-request' });
      expect(error.message).toBe('GitHub request was not completed within its bounded execution window.');
    }
  });

  it('refuses unscoped endpoints and archive writes before running gh', async () => {
    const runner = new CannedRunner({ stdout: 'HTTP/2 200 OK\r\n\r\n{}' });
    const transport = createGitHubCliTransport(runner, projectRoot);
    expect((await rejected(() => transport.request({ method: 'GET', path: '/graphql' }))).code).toBe('invalid-endpoint');
    expect((await rejected(() => transport.request({ method: 'POST', path: '/repos/o/r/zipball/main', binary: true })))
      .message).toBe('Binary GitHub transport is read-only.');
    expect((await rejected(() => transport.request({ method: 'GET', path: '/repos/o/r/zipball/main', binary: true, body: {} })))
      .code).toBe('invalid-endpoint');
    expect(runner.calls).toEqual([]);
  });
});

describe('protected-credential GitHub transport', () => {
  type FetchCall = { url: string; init: RequestInit };

  function fetchStub(respond: (call: FetchCall) => Response | Promise<Response>): { fetcher: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(url), init: init ?? {} };
      calls.push(call);
      return respond(call);
    }) as typeof fetch;
    return { fetcher, calls };
  }

  it('sends scoped requests with the protected bearer credential and refuses redirects', async () => {
    const { fetcher, calls } = fetchStub(() => new Response('{"id":1}', {
      status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '5' }
    }));
    const transport = createAuthenticatedGitHubTransport(Buffer.from(credentialMarker), fetcher);
    const result = await transport.request({ method: 'PATCH', path: '/repos/o/r', body: { default_branch: 'develop' } });

    expect(result).toMatchObject({ status: 200, data: { id: 1 }, headers: { 'x-ratelimit-remaining': '5' } });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe('https://api.github.com/repos/o/r');
    expect(init).toMatchObject({
      method: 'PATCH', redirect: 'error', body: '{"default_branch":"develop"}',
      headers: {
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10',
        Authorization: `Bearer ${credentialMarker}`, 'Content-Type': 'application/json'
      }
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal!.aborted).toBe(false);
  });

  it('returns null data for empty provider bodies and omits bodies for reads', async () => {
    const { fetcher, calls } = fetchStub(() => new Response(null, { status: 204 }));
    await expect(createAuthenticatedGitHubTransport(Buffer.from(credentialMarker), fetcher).request({ method: 'GET', path: '/user' }))
      .resolves.toMatchObject({ status: 204, data: null });
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it('refuses archive downloads and unscoped endpoints before sending the credential', async () => {
    const { fetcher, calls } = fetchStub(() => new Response('{}'));
    const transport = createAuthenticatedGitHubTransport(Buffer.from(credentialMarker), fetcher);
    expect((await rejected(() => transport.request({ method: 'GET', path: '/repos/o/r/zipball/main', binary: true }))).message)
      .toBe('Protected credential probes cannot download arbitrary artifacts.');
    expect((await rejected(() => transport.request({ method: 'GET', path: '/graphql' }))).code).toBe('invalid-endpoint');
    expect(calls).toEqual([]);
  });

  it('withholds network and response parsing diagnostics', async () => {
    for (const respond of [
      () => { throw new Error(`connect failed with Bearer ${credentialMarker}`); },
      () => new Response(`{"token":"${credentialMarker}"`, { status: 200 })
    ]) {
      const { fetcher } = fetchStub(respond);
      const error = await rejected(() => createAuthenticatedGitHubTransport(Buffer.from(credentialMarker), fetcher)
        .request({ method: 'GET', path: '/user' }));
      expect(error.code).toBe('protected-request');
      expect(error.message).toBe('Protected GitHub request failed; credential and response diagnostics were withheld.');
    }
  });

  it('aborts oversized protected responses at the size bound', async () => {
    let chunks = 0;
    const { fetcher, calls } = fetchStub(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks++ < 6) controller.enqueue(new Uint8Array(1024 * 1024));
        else controller.close();
      }
    }), { status: 200 }));
    const error = await rejected(() => createAuthenticatedGitHubTransport(Buffer.from(credentialMarker), fetcher)
      .request({ method: 'GET', path: '/orgs/acme/actions/hosted-runners' }));
    expect(error).toMatchObject({ code: 'bounded-request' });
    expect(calls[0]!.init.signal!.aborted).toBe(true);
    expect(chunks).toBeLessThanOrEqual(6);
  });
});

describe('GitHub activation client status and pagination contracts', () => {
  it('reads required and optional resources with exact status handling', async () => {
    const statuses = [response(200, { id: 1 }), response(404), response(200, []), response(404), response(200, { id: 2 }), response(403)];
    const client = new GitHubActivationClient(new ScriptedTransport((_request, index) => statuses[index]!));

    await expect(client.get('/repos/o/r')).resolves.toEqual({ id: 1 });
    const missing = await rejected(() => client.get('/repos/o/r?ref=develop'));
    expect(missing).toMatchObject({ code: 'provider-response', status: 404 });
    expect(missing.message.startsWith('Read /repos/o/r: ')).toBe(true);
    expect((await rejected(() => client.get('/repos/o/r'))).code).toBe('invalid-response');
    await expect(client.optional('/repos/o/r')).resolves.toBeNull();
    await expect(client.optional('/repos/o/r')).resolves.toEqual({ id: 2 });
    expect(await rejected(() => client.optional('/repos/o/r'))).toMatchObject({ code: 'provider-response', status: 403 });
  });

  it('accepts only confirmed write statuses and object bodies', async () => {
    const statuses = [response(204), response(201, { id: 3 }), response(202, {}), response(422, { message: 'exists' }), response(200, [1])];
    const transport = new ScriptedTransport((_request, index) => statuses[index]!);
    const client = new GitHubActivationClient(transport);

    await expect(client.write('PUT', '/repos/o/r/actions/secrets/NAME', { key_id: 'k' })).resolves.toBeNull();
    await expect(client.write('POST', '/orgs/acme/repos', { name: 'r' })).resolves.toEqual({ id: 3 });
    await expect(client.write('DELETE', '/installation/token')).resolves.toEqual({});
    expect(await rejected(() => client.write('PATCH', '/repos/o/r', {}))).toMatchObject({ code: 'provider-response', status: 422 });
    expect((await rejected(() => client.write('PATCH', '/repos/o/r', {}))).code).toBe('invalid-response');
    expect(transport.requests[0]).toEqual({ method: 'PUT', path: '/repos/o/r/actions/secrets/NAME', body: { key_id: 'k' } });
  });

  function entries(count: number, offset = 0): Array<{ id: number }> {
    return Array.from({ length: count }, (_value, index) => ({ id: offset + index + 1 }));
  }

  it('paginates bounded inventories through explicit next links and exact totals', async () => {
    const short = new ScriptedTransport(() => response(200, { total_count: 2, runners: entries(2) }));
    await expect(new GitHubActivationClient(short).list('/orgs/acme/actions/hosted-runners', 'runners')).resolves.toHaveLength(2);
    expect(short.requests.map((request) => request.path)).toEqual(['/orgs/acme/actions/hosted-runners?per_page=100&page=1']);

    const queried = new ScriptedTransport(() => response(200, entries(1)));
    await new GitHubActivationClient(queried).list('/orgs/acme/personal-access-tokens?owner[]=octo');
    expect(queried.requests[0]!.path).toBe('/orgs/acme/personal-access-tokens?owner[]=octo&per_page=100&page=1');

    const linked = new ScriptedTransport((_request, index) => index === 0
      ? response(200, entries(100), { link: '<https://api.github.com/x?page=2>; rel="next"' })
      : response(200, entries(1, 100)));
    await expect(new GitHubActivationClient(linked).list('/installation/repositories')).resolves.toHaveLength(101);

    const exact = new ScriptedTransport(() => response(200, { total_count: 100, repositories: entries(100) }));
    await expect(new GitHubActivationClient(exact).list('/installation/repositories', 'repositories')).resolves.toHaveLength(100);
    expect(exact.requests).toHaveLength(1);

    const unconfirmed = new ScriptedTransport((_request, index) => response(200, index === 0 ? entries(100) : []));
    await expect(new GitHubActivationClient(unconfirmed).list('/user/repos')).resolves.toHaveLength(100);
    expect(unconfirmed.requests.map((request) => request.path)).toEqual(['/user/repos?per_page=100&page=1', '/user/repos?per_page=100&page=2']);
  });

  it('refuses to infer absence from invalid, changing, incomplete, or unbounded inventories', async () => {
    const cases: Array<[(request: GitHubRequest, index: number) => GitHubResponse, RegExp]> = [
      [() => response(200, { total_count: 1 }), /returned an invalid page/],
      [() => response(200, { total_count: 101, runners: entries(101) }), /returned an invalid page/],
      [() => response(200, { total_count: -1, runners: [] }), /inventory changed during pagination/],
      [() => response(200, { total_count: 1.5, runners: [] }), /inventory changed during pagination/],
      [(_request, index) => response(200, { total_count: index === 0 ? 150 : 151, runners: entries(index === 0 ? 100 : 50) },
        index === 0 ? { link: '<next>; rel="next"' } : {}), /inventory changed during pagination/],
      [() => response(200, { total_count: 3, runners: entries(2) }), /incomplete inventory; absence cannot be inferred/],
      [() => response(200, { runners: entries(100) }, { link: '<next>; rel="next"' }), /exceeds the 1,000-resource bound/]
    ];
    for (const [respond, expected] of cases) {
      const transport = new ScriptedTransport(respond);
      const error = await rejected(() => new GitHubActivationClient(transport).list('/orgs/acme/actions/hosted-runners', 'runners'));
      expect(error.code).toBe('incomplete-pagination');
      expect(error.message).toMatch(expected);
      expect(transport.requests.length).toBeLessThanOrEqual(10);
    }
    const nonObject = new ScriptedTransport(() => response(200, [1]));
    expect((await rejected(() => new GitHubActivationClient(nonObject).list('/installation/repositories'))).code).toBe('invalid-response');
    const denied = new ScriptedTransport(() => response(403, { message: 'Resource not accessible by integration' }));
    expect(await rejected(() => new GitHubActivationClient(denied).list('/orgs/acme/settings/network-configurations', 'network_configurations')))
      .toMatchObject({ code: 'provider-response', status: 403 });
  });
});

describe.skipIf(process.platform === 'win32')('bounded GitHub CLI archive reads', () => {
  const binDirectory = path.join(projectRoot, 'fake-gh-bin');
  const emptyDirectory = path.join(projectRoot, 'empty-bin');
  const argsFile = path.join(projectRoot, 'fake-gh-args.txt');
  const oversizedPayload = path.join(projectRoot, 'oversized.bin');
  const saved = { PATH: process.env.PATH, FAKE_GH_MODE: process.env.FAKE_GH_MODE, FAKE_GH_ARGS: process.env.FAKE_GH_ARGS, FAKE_GH_PAYLOAD: process.env.FAKE_GH_PAYLOAD };
  const noRunner = new CannedRunner({ stdout: 'HTTP/2 500 Unexpected\r\n\r\n{}' });

  beforeAll(async () => {
    await mkdir(binDirectory, { recursive: true });
    await mkdir(emptyDirectory, { recursive: true });
    await writeFile(path.join(binDirectory, 'gh'), [
      '#!/bin/sh',
      'printf \'%s\\n\' "$@" > "$FAKE_GH_ARGS"',
      'printf \'GH_PROMPT_DISABLED=%s GH_DEBUG=%s\\n\' "$GH_PROMPT_DISABLED" "$GH_DEBUG" >> "$FAKE_GH_ARGS"',
      'case "$FAKE_GH_MODE" in',
      '  archive) printf \'HTTP/2.0 200 OK\\r\\ncontent-type: application/zip\\r\\n\\r\\nPK\\003\\004\\000\\377archive\' ;;',
      '  missing) printf \'HTTP/2.0 404 Not Found\\r\\n\\r\\n{"message":"Not Found"}\' ;;',
      '  oversized) cat "$FAKE_GH_PAYLOAD" ;;',
      'esac',
      ''
    ].join('\n'));
    await chmod(path.join(binDirectory, 'gh'), 0o755);
    await writeFile(oversizedPayload, Buffer.concat([Buffer.from('HTTP/2.0 200 OK\r\n\r\n'), Buffer.alloc(5 * 1024 * 1024, 1)]));
    process.env.FAKE_GH_ARGS = argsFile;
    process.env.FAKE_GH_PAYLOAD = oversizedPayload;
  });

  afterEach(() => {
    process.env.PATH = saved.PATH;
    if (saved.FAKE_GH_MODE === undefined) delete process.env.FAKE_GH_MODE;
    else process.env.FAKE_GH_MODE = saved.FAKE_GH_MODE;
  });

  afterAll(async () => {
    for (const key of ['FAKE_GH_ARGS', 'FAKE_GH_PAYLOAD'] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await rm(projectRoot, { recursive: true, force: true });
  });

  function useFakeGh(mode: string): void {
    process.env.FAKE_GH_MODE = mode;
    process.env.PATH = `${binDirectory}${path.delimiter}${saved.PATH ?? ''}`;
  }

  it('reads archive bytes without text decoding and without the injected text runner', async () => {
    useFakeGh('archive');
    const result = await createGitHubCliTransport(noRunner, projectRoot).request({ method: 'GET', path: '/repos/o/r/zipball/abc', binary: true });
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('application/zip');
    expect(Buffer.isBuffer(result.data)).toBe(true);
    expect(result.data).toEqual(Buffer.concat([Buffer.from('PK'), Buffer.from([3, 4, 0, 255]), Buffer.from('archive')]));
    const args = (await readFile(argsFile, 'utf8')).split('\n');
    expect(args).toEqual(expect.arrayContaining(['api', '--hostname', 'github.com', '--method', 'GET', '--include', '/repos/o/r/zipball/abc']));
    expect(args).not.toContain('--input');
    expect(args).toContain('GH_PROMPT_DISABLED=1 GH_DEBUG=');
    expect(noRunner.calls).toEqual([]);
  });

  it('parses a missing archive as a JSON status for the caller', async () => {
    useFakeGh('missing');
    await expect(createGitHubCliTransport(noRunner, projectRoot).request({ method: 'GET', path: '/repos/o/r/tarball/abc', binary: true }))
      .resolves.toMatchObject({ status: 404, data: { message: 'Not Found' } });
  });

  it('stops archive reads that exceed the size bound', async () => {
    useFakeGh('oversized');
    expect(await rejected(() => createGitHubCliTransport(noRunner, projectRoot).request({ method: 'GET', path: '/repos/o/r/zipball/big', binary: true })))
      .toMatchObject({ code: 'bounded-request', message: 'GitHub archive read exceeded its time or size bound.' });
  });

  it('requires an installed GitHub CLI instead of falling back to another channel', async () => {
    process.env.PATH = emptyDirectory;
    expect(await rejected(() => createGitHubCliTransport(noRunner, projectRoot).request({ method: 'GET', path: '/repos/o/r/zipball/abc', binary: true })))
      .toMatchObject({ code: 'authentication-prerequisite' });
    expect(noRunner.calls).toEqual([]);
  });
});
