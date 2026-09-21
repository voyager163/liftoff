import { describe, expect, it, vi } from 'vitest';
import { verifyGeneratedHealthResponses } from '../scripts/repository-security/generated-health.ts';
import { verifiedGeneratedImageHealth } from '../scripts/repository-security/trivy.ts';

const origin = 'http://127.0.0.1:12345';
const sentinel = 'PRIVATE_NONFUNCTIONAL_HEALTH_SENTINEL';
function request() {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeDefined();
    const pathname = new URL(String(url)).pathname;
    return new Response(JSON.stringify(pathname === '/openapi.json' ? { openapi: '3.1.0' }
      : { status: pathname === '/health' ? 'ok' : 'ready' }), { status: 200 });
  });
}

describe('bounded native generated endpoint contracts', () => {
  it('requires exact health/readiness semantics and an OpenAPI document rather than any status string', async () => {
    const fetch = request();
    expect(await verifyGeneratedHealthResponses(origin, false, fetch)).toEqual(['health-ok', 'ready-ready', 'openapi-v3']);
    expect(fetch).toHaveBeenCalledTimes(3);
    await expect(verifyGeneratedHealthResponses(origin, false, async () =>
      new Response(JSON.stringify({ status: 'error', private: sentinel }), { status: 200 })))
      .rejects.toThrow('status-semantic');
  });
  it.each(['https://example.invalid', 'http://localhost:12345', 'http://127.0.0.1:12345/path',
    'http://127.0.0.1:12345/?private=1', 'http://127.0.0.1'])('rejects unregistered origin %s before any request', async value => {
    const fetch = request();
    await expect(verifyGeneratedHealthResponses(value, false, fetch)).rejects.toThrow('origin');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects external frontend modules without following them or claiming an orchestrator probe', async () => {
    const fetch = vi.fn(async () => new Response('<div id="app"></div><script src="https://invalid.example/private.js"></script>',
      { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(verifyGeneratedHealthResponses(origin, true, fetch)).rejects.toThrow('external-target');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('qualifies frontend index and actual same-origin module content', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => new URL(String(url)).pathname === '/'
      ? new Response('<div id="app"></div><script src="/assets/main.js"></script>', { headers: { 'content-type': 'text/html' } })
      : new Response('console.log("Nonfunctional fixture");', { headers: { 'content-type': 'application/javascript' } }));
    expect(await verifyGeneratedHealthResponses(origin, true, fetch)).toEqual(['frontend-index', 'local-frontend-module']);
  });
  it('does not echo malformed output, transport failures or oversize bodies', async () => {
    for (const fetch of [
      async () => { throw new Error(sentinel); },
      async () => new Response(sentinel),
      async () => new Response(sentinel, { status: 500 }),
      async () => new Response('x'.repeat(4 * 1024 * 1024 + 1))
    ]) {
      let failure: unknown;
      try { await verifyGeneratedHealthResponses(origin, false, fetch); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain(sentinel);
    }
  });
  it('does not accept JSON/candidate assertions as issued native image health evidence', () => {
    for (const value of [{}, { kind: 'issued-local-generated-image-health', checks: ['health-ok', 'ready-ready', 'openapi-v3'] }]) {
      expect(() => verifiedGeneratedImageHealth(value)).toThrow('unissued-health-proof');
    }
  });
});
