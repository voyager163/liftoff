import { afterEach, describe, expect, it, vi } from 'vitest';
import { readApplicationRegistryManifest } from '../src/adapters/azure/application-registry.js';
import type { CommandRunner } from '../src/process-runner.js';
import { applicationSubscription, applicationTenant, applicationPrincipal, artifactSha } from './helpers/application-artifact-fixture.js';

const now = Date.parse('2026-09-15T00:00:00.000Z');
const jwt = (value: Record<string, unknown>) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: now / 1000 + 3600, ...value })).toString('base64url')}.Zml4dHVyZQ`;
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const body = Buffer.from('{"schemaVersion":2,"fixture":"exact prevalidated OCI manifest bytes"}');
  const digest = artifactSha(body);
  const aad: Record<string, unknown> = { aud: 'https://management.azure.com/', oid: applicationPrincipal, tid: applicationTenant };
  const refresh: Record<string, unknown> = { aud: 'crliftoff.azurecr.io', grant_type: 'refresh_token', tenant: applicationTenant };
  const access: Record<string, unknown> = { aud: 'crliftoff.azurecr.io', grant_type: 'access_token',
    access: [{ type: 'repository', name: 'team/app', actions: ['pull'] }] };
  const reply = { status: 0, stdout: '', stderr: '', displayCommand: 'isolated scoped credential source' };
  const run = vi.fn<CommandRunner['run']>(async () => {
    reply.stdout = JSON.stringify({ accessToken: jwt(aad), tokenType: 'Bearer', subscription: applicationSubscription, tenant: applicationTenant });
    return reply;
  });
  const beforeAccess = vi.fn(async () => undefined);
  let deniedPath: string | undefined;
  let oversized = false;
  let wrongDigest = false;
  const fetch = vi.fn<typeof globalThis.fetch>(async (resource, init) => {
    const url = new URL(String(resource));
    expect(url.origin).toBe('https://crliftoff.azurecr.io');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (deniedPath === url.pathname) return new Response('Private provider diagnostics must not escape', { status: 403 });
    if (oversized) return new Response('x'.repeat(128 * 1024 + 1));
    const form = new URLSearchParams(String(init?.body ?? ''));
    if (url.pathname === '/oauth2/exchange') {
      expect(init?.method).toBe('POST');
      expect(form.get('grant_type')).toBe('access_token');
      expect(form.get('service')).toBe('crliftoff.azurecr.io');
      expect(form.get('tenant')).toBe(applicationTenant);
      expect(form.get('access_token')).toBe(jwt(aad));
      return new Response(JSON.stringify({ refresh_token: jwt(refresh) }));
    }
    if (url.pathname === '/oauth2/token') {
      expect(init?.method).toBe('POST');
      expect(form.get('scope')).toBe('repository:team/app:pull');
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('refresh_token')).toBe(jwt(refresh));
      return new Response(JSON.stringify({ access_token: jwt(access) }));
    }
    expect(init?.method).toBe('GET');
    expect(url.pathname).toBe(`/v2/team/app/manifests/${digest}`);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${jwt(access)}`);
    return new Response(new Uint8Array(body), { headers: {
      'docker-content-digest': wrongDigest ? `sha256:${'b'.repeat(64)}` : digest,
      'x-ms-request-id': 'ACTUAL-REGISTRY-REQUEST'
    } });
  });
  vi.stubGlobal('fetch', fetch);
  const execute = () => readApplicationRegistryManifest({
    runner: { run }, projectRoot: 'isolated-project-no-files-read', loginServer: 'crliftoff.azurecr.io',
    binding: { subscriptionId: applicationSubscription, tenantId: applicationTenant, principalId: applicationPrincipal },
    repository: 'team/app', digest, beforeAccess, now: () => now
  });
  return {
    body, digest, aad, refresh, access, run, beforeAccess, reply, fetch, execute,
    deny: (pathname: string) => { deniedPath = pathname; },
    oversize: () => { oversized = true; },
    wrongDigest: () => { wrongDigest = true; }
  };
}

describe('principal-bound immutable ACR data-plane observation', () => {
  it('uses an explicit AAD binding and a repository-pull-only exchange without Docker login or credential argv', async () => {
    const f = fixture();
    expect(await f.execute()).toEqual({ digest: f.digest, size: f.body.length, requestId: 'ACTUAL-REGISTRY-REQUEST' });
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.beforeAccess).toHaveBeenCalledTimes(5);
    const [command, options] = f.run.mock.calls[0]!;
    expect(command.args).toEqual([
      'account', 'get-access-token', '--subscription', applicationSubscription, '--tenant', applicationTenant,
      '--resource', 'https://management.azure.com/', '--output', 'json', '--only-show-errors'
    ]);
    expect(options).toMatchObject({ stream: false, timeoutMs: 30000, maxOutputBytes: 65536 });
    expect(JSON.stringify(command)).not.toContain(jwt(f.aad));
    expect(f.reply.stdout).toBe('');
    expect(f.reply.stderr).toBe('');
  });

  it.each(['principal', 'tenant', 'audience', 'expired', 'premature'] as const)(
    'refuses wrong AAD %s before sending credentials to the registry', async (kind) => {
      const f = fixture();
      if (kind === 'principal') f.aad.oid = '99999999-2222-4333-8444-555555555557';
      if (kind === 'tenant') f.aad.tid = '99999999-2222-4333-8444-555555555558';
      if (kind === 'audience') f.aad.aud = 'https://another-audience.example';
      if (kind === 'expired') f.aad.exp = now / 1000;
      if (kind === 'premature') f.aad.nbf = now / 1000 + 3600;
      await expect(f.execute()).rejects.toThrow();
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.reply.stdout).toBe('');
    }
  );

  it.each(['refresh-tenant', 'refresh-audience', 'access-audience', 'access-scope', 'push-authority', 'expired-access'] as const)(
    'rejects %s instead of reusing broader or foreign registry credentials', async (kind) => {
      const f = fixture();
      if (kind === 'refresh-tenant') f.refresh.tenant = 'another-tenant';
      if (kind === 'refresh-audience') f.refresh.aud = 'another.azurecr.io';
      if (kind === 'access-audience') f.access.aud = 'another.azurecr.io';
      if (kind === 'access-scope') f.access.access = [{ type: 'repository', name: 'other/image', actions: ['pull'] }];
      if (kind === 'push-authority') f.access.access = [{ type: 'repository', name: 'team/app', actions: ['pull', 'push'] }];
      if (kind === 'expired-access') f.access.exp = now / 1000;
      await expect(f.execute()).rejects.toThrow();
      expect(f.fetch.mock.calls.some(([, options]) => options?.method === 'GET')).toBe(false);
    }
  );

  it.each(['auth-denied', 'oversized', 'digest-mismatch', 'lost-response'] as const)(
    'surfaces %s without success-shaped fallback or raw provider/credential diagnostics', async (kind) => {
      const f = fixture();
      if (kind === 'auth-denied') f.deny('/oauth2/exchange');
      if (kind === 'oversized') f.oversize();
      if (kind === 'digest-mismatch') f.wrongDigest();
      if (kind === 'lost-response') f.fetch.mockRejectedValueOnce(new Error('private provider response: SECRET'));
      let message = '';
      try { await f.execute(); throw new Error('Expected closed registry readback.'); }
      catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(message).not.toBe('Expected closed registry readback.');
      expect(message).not.toMatch(/SECRET|Private provider diagnostics|eyJhbGci/u);
      expect(f.reply.stdout).toBe('');
    }
  );
});
