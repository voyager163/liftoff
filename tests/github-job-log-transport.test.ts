import { describe, expect, it, vi } from 'vitest';
import { createAuthenticatedGitHubTransport, createGitHubCliTransport, type GitHubRequest } from '../src/adapters/github/activation-rest.js';
import type { CommandRunner } from '../src/process-runner.js';

const request: GitHubRequest = { method: 'GET', path: '/repos/owner/repo/actions/jobs/123/logs', text: true };

function fixture(
  status: number | null = 0,
  signal: NodeJS.Signals | null = null,
  stdout = 'HTTP/2 200\r\ncontent-type: text/plain\r\n\r\nnative test output\n'
) {
  const run = vi.fn<CommandRunner['run']>(async (command) => ({
    command, displayCommand: 'controlled GitHub log read', status, signal, timedOut: false,
    stdout, stderr: ''
  }));
  return { run, transport: createGitHubCliTransport({ run }, process.cwd()) };
}

describe('bounded plain-text GitHub job log transport', () => {
  it('uses the supplied command runner instead of spawning an unbound archive downloader', async () => {
    const f = fixture();
    expect(await f.transport.request(request)).toEqual({
      status: 200, headers: { 'content-type': 'text/plain' }, data: 'native test output\n'
    });
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.run.mock.calls[0]![0].args.at(-1)).toBe(request.path);
    expect(f.run.mock.calls[0]![1]).toMatchObject({ timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024, stream: false });
  });

  it.each([
    { method: 'POST' as const }, { body: {} }, { binary: true },
    { path: '/repos/owner/repo/actions/jobs/0/logs' }, { path: '/repos/owner/repo/actions/runs/123' },
    { path: '/user' }, { path: '/repos/owner/repo/actions/jobs/123/logs?redirect=other' }
  ])('rejects unsupported text-read scope %# before invoking a tool', async (change) => {
    const f = fixture();
    await expect(f.transport.request({ ...request, ...change })).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each([[1, null], [null, null], [0, 'SIGTERM']] as const)('refuses partial success-shaped output after status %s / signal %s', async (status, signal) => {
    const f = fixture(status, signal);
    await expect(f.transport.request(request)).rejects.toThrow(/partial output cannot qualify execution/);
  });

  it('preserves plain text after the final HTTP response headers without treating the log as JSON', async () => {
    const f = fixture(0, null,
      'HTTP/2 302\r\nlocation: https://example.invalid/fixture\r\n\r\nHTTP/2 200\r\ncontent-type: text/plain\r\n\r\nnot a JSON document\n');
    expect((await f.transport.request(request)).data).toBe('not a JSON document\n');
  });

  it.each(['HTTP/2 200\r\ncontent-type: text/plain', 'native output without HTTP headers'])(
    'rejects an incomplete transport envelope %#', async (stdout) => {
      await expect(fixture(0, null, stdout).transport.request(request)).rejects.toThrow(/headers|HTTP status/);
    }
  );

  it('retains structured HTTP error handling for ordinary JSON requests', async () => {
    const f = fixture(1, null, 'HTTP/2 404\r\ncontent-type: application/json\r\n\r\n{"message":"fixture missing"}');
    expect(await f.transport.request({ method: 'GET', path: '/repos/owner/repo' })).toMatchObject({
      status: 404, data: { message: 'fixture missing' }
    });
  });

  it('does not reinterpret malformed ordinary JSON as an accepted text response', async () => {
    await expect(fixture().transport.request({ method: 'GET', path: '/repos/owner/repo' })).rejects.toThrow(/invalid JSON/);
  });

  it('does not widen the private credential-probe transport into log-reading authority', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const transport = createAuthenticatedGitHubTransport(Buffer.from('isolated-fixture-not-a-credential'), fetcher);
    await expect(transport.request(request)).rejects.toThrow(/credential probes/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
