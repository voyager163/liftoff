import { describe, expect, it } from 'vitest';
import { openPrivateRunnerGitHubSession } from '../src/adapters/github/private-runner-session.js';
import type { CommandResult, CommandRunner } from '../src/process-runner.js';

const credential = `ghp_${'A'.repeat(36)}`;

function fixture(fetcher: typeof globalThis.fetch) {
  const calls: unknown[] = [];
  const result: CommandResult = { command: { executable: 'gh', args: [] }, signal: null, timedOut: false,
    status: 0, stdout: `${credential}\n`, stderr: 'SYNTHETIC_CREDENTIAL_DIAGNOSTIC', displayCommand: 'fixture' };
  const runner: CommandRunner = { async run(command, options) { calls.push({ command, options }); result.command = command; return result; } };
  return { calls, result, open: () => openPrivateRunnerGitHubSession(runner, process.cwd(), 9, { fetch: fetcher }) };
}

describe('private runner pinned administrator credential session', () => {
  it('pins one privately read credential to the actual approved actor, avoids argv diagnostics and closes further use', async () => {
    const sent: Array<{ method?: string; authorization: string | null }> = [];
    const f = fixture((async (_url, init) => {
      sent.push({ method: init?.method, authorization: new Headers(init?.headers).get('Authorization') });
      return new Response(JSON.stringify(init?.method === 'GET' ? { id: 9 } : { id: 55 }), { status: 200 });
    }) as typeof globalThis.fetch);
    const session = await f.open();
    await session.client.transport.request({ method: 'POST', path: '/orgs/owner/actions/runner-groups', body: { name: 'fixture' } });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ command: { executable: 'gh', args: ['auth', 'token', '--hostname', 'github.com'] },
      options: { timeoutMs: 15000, maxOutputBytes: 16384, stream: false } });
    expect(JSON.stringify(f.calls)).not.toContain(credential);
    expect(sent).toEqual([{ method: 'GET', authorization: `Bearer ${credential}` }, { method: 'POST', authorization: `Bearer ${credential}` }]);
    expect(f.result.stdout).toBe('');
    expect(f.result.stderr).toBe('');
    session.close();
    await expect(session.client.get('/user')).rejects.toThrow(/closed/);
    expect(sent).toHaveLength(2);
  });

  it('blocks a different actor before any provider mutation', async () => {
    const methods: unknown[] = [];
    const f = fixture((async (_url, init) => {
      methods.push(init?.method);
      return new Response('{"id":10}', { status: 200 });
    }) as typeof globalThis.fetch);
    await expect(f.open()).rejects.toMatchObject({ code: 'private-runner-actor' });
    expect(methods).toEqual(['GET']);
    expect(f.result.stdout).toBe('');
  });

  it('downloads only the exact report archive and strips credentials before following its provider-issued storage location', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const location = 'https://productionresultssa0.blob.core.windows.net/artifacts/report.zip?sig=SYNTHETIC_SIGNED_LOCATION';
    const f = fixture((async (url, init) => {
      requests.push({ url: String(url), authorization: new Headers(init?.headers).get('Authorization') });
      if (String(url).endsWith('/user')) return new Response('{"id":9}', { status: 200 });
      if (String(url).includes('api.github.com')) return new Response(null, {
        status: 302, headers: { location, 'x-github-request-id': 'ABCD:1234:FFFF:9999' }
      });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as typeof globalThis.fetch);
    const session = await f.open();
    try {
      const response = await session.client.transport.request({ method: 'GET', path: '/repos/owner/repo/actions/artifacts/987/zip', binary: true });
      expect(response.status).toBe(200);
      expect(response.data).toEqual(Buffer.from([1, 2, 3]));
      expect(response.headers).toEqual({ 'x-github-request-id': 'ABCD:1234:FFFF:9999' });
      expect(requests[2]).toEqual({ url: location, authorization: null });
      expect(f.calls).toHaveLength(1);
      expect(JSON.stringify(response)).not.toContain('SYNTHETIC_SIGNED_LOCATION');
      await expect(session.client.transport.request({ method: 'GET', path: '/repos/owner/repo/contents/state', binary: true })).rejects.toMatchObject({ code: 'private-runner-artifact' });
    } finally { session.close(); }
  });

  it.each(['https://attacker.example/report?token=SYNTHETIC_SECRET', 'http://productionresultssa0.blob.core.windows.net/report',
    'https://169.254.169.254/latest', 'https://user:password@productionresultssa0.blob.core.windows.net/report'])('rejects an untrusted report redirect without diagnostic leakage', async (location) => {
    let count = 0;
    const f = fixture((async (url) => {
      count++;
      return String(url).endsWith('/user') ? new Response('{"id":9}', { status: 200 })
        : new Response(null, { status: 302, headers: { location } });
    }) as typeof globalThis.fetch);
    const session = await f.open();
    try {
      await expect(session.client.transport.request({ method: 'GET', path: '/repos/owner/repo/actions/artifacts/987/zip', binary: true }))
        .rejects.toThrow('credential-bearing locations and diagnostics were withheld');
      expect(count).toBe(2);
    } finally { session.close(); }
  });
});
