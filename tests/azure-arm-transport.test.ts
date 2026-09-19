import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAzureCliArmTransport, AzureProviderClient, azureArmUrl
} from '../src/adapters/azure/activation-rest.js';
import type { CommandRunner } from '../src/process-runner.js';
import { producerSubscription, producerTenant } from './helpers/activation-producer-fixture.js';

const principal = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const now = Date.parse('2026-09-15T00:00:00Z');
const binding = { subscriptionId: producerSubscription, tenantId: producerTenant, principalId: principal };
const requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture(claimChanges: Record<string, unknown> = {}, options: { deadline?: number } = {}) {
  const calls: Parameters<CommandRunner['run']>[] = [];
  const fetches: Array<{ url: string; options?: RequestInit }> = [];
  const jwt = [
    Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ tid: producerTenant, oid: principal, aud: 'https://management.azure.com/', exp: now / 1000 + 3600, ...claimChanges })).toString('base64url'),
    Buffer.from('non-credential-fixture-signature').toString('base64url')
  ].join('.');
  const output = { status: 0, stdout: JSON.stringify({
    accessToken: jwt, tokenType: 'Bearer', subscription: producerSubscription, tenant: producerTenant
  }), stderr: '', displayCommand: 'scoped Azure token fixture' };
  let tokenHook: (() => void) | undefined;
  const runner: CommandRunner = { async run(command, options) { calls.push([command, options]); tokenHook?.(); return output; } };
  let response: () => Response | Promise<Response> = () => new Response(JSON.stringify({
    id: `/subscriptions/${producerSubscription}/providers/Microsoft.Storage`, namespace: 'Microsoft.Storage', registrationState: 'Registered'
  }), { status: 200, headers: { 'x-ms-request-id': requestId } });
  const fetcher: typeof fetch = async (url, options) => {
    fetches.push({ url: String(url), options });
    return response();
  };
  const transport = createAzureCliArmTransport(runner, process.cwd(), { now: () => now, fetch: fetcher, ...options });
  return {
    calls, fetches, output, transport, client: new AzureProviderClient(transport, binding),
    respond: (fn: typeof response) => { response = fn; }, beforeToken: (hook: () => void) => { tokenHook = hook; }
  };
}

describe('production bounded ARM transport', () => {
  it('obtains only a scoped in-memory token and binds actual provider request identity', async () => {
    const f = fixture();
    const observed = await f.client.read('Microsoft.Storage');
    expect(observed).toEqual({
      namespace: 'Microsoft.Storage', resourceId: `/subscriptions/${producerSubscription}/providers/Microsoft.Storage`,
      state: 'Registered', requestId
    });
    expect(f.calls[0]![0].args).toEqual([
      'account', 'get-access-token', '--subscription', producerSubscription, '--tenant', producerTenant,
      '--resource', 'https://management.azure.com/', '--output', 'json', '--only-show-errors'
    ]);
    expect(f.calls[0]![1]).toMatchObject({ stream: false, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
    expect(f.output.stdout).toBe('');
    expect(f.output.stderr).toBe('');
    expect(f.fetches[0]!.options).toMatchObject({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal) });
  });

  it.each([{ oid: producerTenant }, { tid: producerSubscription }, { aud: 'https://foreign.example/' }, { exp: now / 1000 - 1 }])(
    'rejects changed principal, tenant, audience or expiry before an HTTP request %#', async (claims) => {
      const f = fixture(claims);
      await expect(f.client.read('Microsoft.Storage')).rejects.toThrow(/differs from the exact reviewed binding/);
      expect(f.fetches).toEqual([]);
      expect(f.output.stdout).toBe('');
    }
  );

  it('transmits a pre-recorded client correlation separately from the provider-issued ID', async () => {
    const f = fixture();
    const clientId = randomUUID();
    const observed = await f.client.register('Microsoft.Storage', clientId);
    expect(observed.requestId).toBe(requestId);
    expect(f.fetches[0]!.options).toMatchObject({
      method: 'POST', headers: expect.objectContaining({ 'x-ms-client-request-id': clientId, 'x-ms-return-client-request-id': 'true' })
    });
    expect(f.fetches[0]!.url).toBe(`https://management.azure.com/subscriptions/${producerSubscription}/providers/Microsoft.Storage/register?api-version=2021-04-01`);
  });

  it('refuses arbitrary or cross-subscription ARM endpoints before credential access', async () => {
    const f = fixture();
    for (const resourceId of [
      `/subscriptions/${producerTenant}/providers/Microsoft.Storage`,
      `/subscriptions/${producerSubscription}/providers/../Microsoft.Storage`,
      `/subscriptions/${producerSubscription}/providers/Microsoft.Storage?token=unsafe`,
      'https://foreign.example/resource'
    ]) {
      expect(() => azureArmUrl(resourceId, '2021-04-01', producerSubscription)).toThrow();
    }
    await expect(f.transport.request({
      method: 'POST', resourceId: `/subscriptions/${producerSubscription}/providers/Microsoft.Storage/register`, apiVersion: '2021-04-01'
    }, binding)).rejects.toThrow(/pre-recorded/);
    expect(f.calls).toEqual([]);
  });

  it('rejects missing operation identity and redacts denied or malformed provider responses', async () => {
    const f = fixture();
    f.respond(() => new Response('{"private":"withheld"}', { status: 403, headers: { 'x-ms-request-id': requestId } }));
    await expect(f.client.read('Microsoft.Storage')).rejects.toThrow(/scoped permission was denied/);
    const missing = fixture();
    missing.respond(() => new Response('{}', { status: 200 }));
    await expect(missing.client.read('Microsoft.Storage')).rejects.toThrow(/provider-issued request ID/);
    const malformed = fixture();
    malformed.respond(() => new Response('private-provider-nonjson', { status: 200 }));
    await expect(malformed.client.read('Microsoft.Storage')).rejects.toThrow(/response bytes were withheld/);
  });

  it.each([100, 99, Number.NaN, Number.POSITIVE_INFINITY])('refuses an exhausted or invalid shared deadline before credentials: %s', async (deadline) => {
    vi.spyOn(performance, 'now').mockReturnValue(100);
    const f = fixture({}, { deadline });
    await expect(f.client.read('Microsoft.Storage')).rejects.toMatchObject({
      code: Number.isFinite(deadline) ? 'observation-window-ended' : 'invalid-deadline', dispatched: false
    });
    expect(f.calls).toEqual([]);
    expect(f.fetches).toEqual([]);
  });

  it('does not dispatch after token acquisition consumes the remaining observation window', async () => {
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(0);
    const f = fixture({}, { deadline: 10 });
    f.beforeToken(() => { monotonic.mockReturnValue(11); });
    await expect(f.client.register('Microsoft.Storage', randomUUID())).rejects.toMatchObject({
      code: 'observation-window-ended', dispatched: false
    });
    expect(f.calls[0]![1]?.timeoutMs).toBe(10);
    expect(f.output.stdout).toBe('');
    expect(f.fetches).toEqual([]);
  });

  it('shares the reviewed budget across token acquisition and HTTP rather than restarting thirty seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(0);
    const f = fixture({}, { deadline: 5000 });
    f.beforeToken(() => { monotonic.mockReturnValue(4000); });
    f.respond(() => new Promise<Response>((_resolve, reject) => {
      f.fetches.at(-1)!.options!.signal!.addEventListener('abort', () => reject(new Error('withheld HTTP diagnostics')), { once: true });
    }));
    const outcome = f.client.read('Microsoft.Storage').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.calls[0]![1]?.timeoutMs).toBe(5000);
    expect(f.fetches[0]!.options!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ code: 'request-timeout', dispatched: true });
    expect(f.fetches[0]!.options!.signal!.aborted).toBe(true);
    expect(f.output.stdout).toBe('');
  });

  it('retains returned provider identity when bounded response-body observation is interrupted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const f = fixture({}, { deadline: 100 });
    f.respond(() => new Response(new ReadableStream({
      start(controller) {
        f.fetches.at(-1)!.options!.signal!.addEventListener('abort', () => controller.error(new Error('withheld body diagnostics')), { once: true });
      }
    }), { status: 200, headers: { 'x-ms-request-id': requestId } }));
    const outcome = f.client.register('Microsoft.Storage', randomUUID()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toMatchObject({ code: 'request-timeout', status: 200, requestId, dispatched: true });
  });

  it('refuses a late successful observation even if a transport did not act on its abort signal', async () => {
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(0);
    const f = fixture({}, { deadline: 100 });
    f.respond(() => {
      monotonic.mockReturnValue(101);
      return new Response('{}', { status: 200, headers: { 'x-ms-request-id': requestId } });
    });
    await expect(f.client.read('Microsoft.Storage')).rejects.toMatchObject({
      code: 'observation-window-ended', requestId, status: 200, dispatched: true
    });
  });
});
