import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureStream } from './helpers.js';
import { createTelemetryDelivery } from '../src/telemetry/delivery.js';
import { createSemanticTelemetryEvent } from '../src/telemetry/contract.js';
import {
  isTelemetryEnabled,
  maybeShowTelemetryNotice,
  productionTelemetryEndpoint,
  reportCommandEvent,
  telemetryNotice,
  trackCommand,
  type TelemetryFetch
} from '../src/telemetry/index.js';

const temporaryRoots: string[] = [];

async function configPath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-telemetry-'));
  temporaryRoots.push(root);
  return path.join(root, 'config.json');
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('telemetry client', () => {
  it('keeps the legacy void API within the maximum even when fetch ignores abort', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const fetch = vi.fn<TelemetryFetch>(() => new Promise<Response>(() => {}));
    let done = false;
    const result = trackCommand('help', '0.12.3', 0, {
      env: {}, endpoint: 'https://telemetry.example.test/api/events', fetch, timeoutMs: 5_000
    }).then(value => { done = true; return value; });
    await vi.advanceTimersByTimeAsync(999); expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not allocate a second command request when a shared invocation has claimed that slot', async () => {
    const fetch = vi.fn<TelemetryFetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const delivery = createTelemetryDelivery({ env: {}, fetch });
    try {
      await trackCommand('help', '0.12.3', 0, { env: {}, delivery });
      await trackCommand('update', '0.12.3', 2, { env: {}, delivery });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ schemaVersion: 1, command: 'help' });
    } finally {
      delivery.close();
    }
  });

  it('uses only the verified production HTTPS endpoint', () => {
    expect(productionTelemetryEndpoint).toBe(
      'https://ca-liftoff-telemetry-f5be1618.politetree-7a65ae27.koreacentral.azurecontainerapps.io/api/events'
    );
  });

  it('honors product, DNT, and CI disablement', () => {
    expect(isTelemetryEnabled({})).toBe(true);
    expect(isTelemetryEnabled({ LIFTOFF_TELEMETRY: '0' })).toBe(false);
    expect(isTelemetryEnabled({ DO_NOT_TRACK: '1' })).toBe(false);
    expect(isTelemetryEnabled({ CI: 'true', LIFTOFF_TELEMETRY: '1' })).toBe(false);
  });

  it('shows the versioned notice once on stderr', async () => {
    const stderr = new CaptureStream();
    const file = await configPath();
    expect(await maybeShowTelemetryNotice({ stderr, env: {}, config: { configPath: file } })).toBe(true);
    expect(await maybeShowTelemetryNotice({ stderr, env: {}, config: { configPath: file } })).toBe(true);
    expect(stderr.text()).toBe(telemetryNotice);
    expect(stderr.text()).toContain('LIFTOFF_TELEMETRY=0');
    expect(stderr.text()).toContain('DO_NOT_TRACK=1');
  });

  it('does no notice or config work when disabled', async () => {
    const stderr = new CaptureStream();
    const file = await configPath();
    expect(await maybeShowTelemetryNotice({
      stderr,
      env: { LIFTOFF_TELEMETRY: '0' },
      config: { configPath: file }
    })).toBe(false);
    expect(stderr.text()).toBe('');
  });

  it('suppresses collection when the disclosure cannot be written', async () => {
    const stderr = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('closed pipe'));
      }
    });
    expect(await maybeShowTelemetryNotice({
      stderr,
      env: {},
      config: { configPath: await configPath() }
    })).toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('posts the exact event once over HTTPS', async () => {
    const fetch = vi.fn<TelemetryFetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await trackCommand('infra:plan', '0.6.1', 0, {
      env: {},
      endpoint: 'https://telemetry.example.test/api/events',
      fetch
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://telemetry.example.test/api/events');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toEqual({
      schemaVersion: 1,
      event: 'command_executed',
      command: 'infra:plan',
      cliVersion: '0.6.1',
      outcome: 'success'
    });
  });

  it('returns the explicit result and rejects a second command report without aggregate recursion', async () => {
    const event = createSemanticTelemetryEvent('update', '0.12.3', 'attention-required');
    const fetch = vi.fn<TelemetryFetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const delivery = createTelemetryDelivery({ env: {}, fetch });
    try {
      await expect(reportCommandEvent(event, { env: {}, delivery })).resolves.toEqual({
        status: 'delivered', attempted: true
      });
      await expect(reportCommandEvent(event, { env: {}, delivery })).resolves.toEqual({
        status: 'failed', reason: 'duplicate-channel', attempted: false
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(event);
    } finally {
      delivery.close();
    }
  });

  it.each([
    { env: { DO_NOT_TRACK: '1' }, reason: 'global-opt-out' },
    { env: { LIFTOFF_TELEMETRY: '0' }, reason: 'global-opt-out' },
    { env: { CI: 'true' }, reason: 'ordinary-ci' },
    { env: { CI: 'true', DO_NOT_TRACK: '1' }, reason: 'global-opt-out' }
  ])('returns disabled for $env even with an independently enabled delivery object', async ({ env, reason }) => {
    const fetch = vi.fn<TelemetryFetch>(), delivery = createTelemetryDelivery({ env: {}, fetch });
    try {
      await expect(reportCommandEvent(createSemanticTelemetryEvent('help', '0.12.3', 'success'), {
        env, delivery
      })).resolves.toEqual({ status: 'disabled', reason, attempted: false });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      delivery.close();
    }
  });

  it.each(['network', 'http-rejected', 'invalid-endpoint'] as const)(
    'returns explicit %s failure without retry or response-body diagnostics', async reason => {
      const response = new Response('private response diagnostic', { status: 503 });
      const text = vi.spyOn(response, 'text'), json = vi.spyOn(response, 'json');
      const fetch = vi.fn<TelemetryFetch>();
      if (reason === 'network') fetch.mockRejectedValue(new Error('private network diagnostic'));
      else fetch.mockResolvedValue(response);
      await expect(reportCommandEvent(createSemanticTelemetryEvent('update', '0.12.3', 'failure'), {
        env: {}, endpoint: reason === 'invalid-endpoint' ? '' : productionTelemetryEndpoint, fetch
      })).resolves.toEqual({ status: 'failed', reason, attempted: reason !== 'invalid-endpoint' });
      expect(fetch).toHaveBeenCalledTimes(reason === 'invalid-endpoint' ? 0 : 1);
      expect(text).not.toHaveBeenCalled(); expect(json).not.toHaveBeenCalled();
    }
  );

  it('returns invalid-payload rather than delivering a malformed explicit report', async () => {
    const fetch = vi.fn<TelemetryFetch>();
    await expect(Reflect.apply(reportCommandEvent, undefined, [
      { ...createSemanticTelemetryEvent('help', '0.12.3', 'success'), rawProject: '/private/project' },
      { env: {}, fetch }
    ])).resolves.toEqual({ status: 'failed', reason: 'invalid-payload', attempted: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps explicit reporting in the remaining shared budget without another project request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const fetch = vi.fn<TelemetryFetch>(() => new Promise<Response>(() => {}));
    const delivery = createTelemetryDelivery({ env: {}, fetch });
    try {
      const project = delivery.deliver({ project: {
        endpoint: 'https://telemetry.example.test/api/projects',
        event: {
          schemaVersion: 2, event: 'project_observed', projectId: '550e8400-e29b-41d4-a716-446655440000',
          cliVersion: '0.12.3', policyProfile: 'none', policyVersion: 'none',
          templateSetDigest: `sha256:${'a'.repeat(64)}`, source: 'cli'
        }
      } });
      await vi.advanceTimersByTimeAsync(750);
      let done = false;
      const command = reportCommandEvent(createSemanticTelemetryEvent('update', '0.12.3', 'attention-required'), {
        env: {}, delivery
      }).then(result => { done = true; return result; });
      await vi.advanceTimersByTimeAsync(249);
      expect(done).toBe(false); expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(await command).toEqual({ status: 'failed', reason: 'budget-expired', attempted: true });
      expect(await project).toEqual({ project: { status: 'failed', reason: 'budget-expired', attempted: true } });
      expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/api/projects', '/api/events']);
      expect(fetch.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      delivery.close();
    }
  });

  it('does not fabricate success when an injected delivery omits the requested result', async () => {
    const delivery = createTelemetryDelivery({ env: {} });
    try {
      await expect(reportCommandEvent(createSemanticTelemetryEvent('help', '0.12.3', 'success'), {
        env: {}, delivery: { ...delivery, deliver: async () => ({}) }
      })).rejects.toThrow('Command telemetry delivery did not return its requested result.');
    } finally {
      delivery.close();
    }
  });

  it('sends no upgrade mode, target, registry, origin, path, or error detail', async () => {
    const fetch = vi.fn<TelemetryFetch>().mockResolvedValue(
      new Response(null, { status: 204 })
    );
    await trackCommand('upgrade', '0.7.0', 2, {
      env: {},
      endpoint: 'https://telemetry.example.test/api/events',
      fetch
    });
    const payload = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(payload).toEqual({
      schemaVersion: 1,
      event: 'command_executed',
      command: 'upgrade',
      cliVersion: '0.7.0',
      outcome: 'failure'
    });
    expect(Object.keys(payload)).toEqual([
      'schemaVersion',
      'event',
      'command',
      'cliVersion',
      'outcome'
    ]);
  });

  it('rejects non-HTTPS endpoints without transport', async () => {
    const fetch = vi.fn<TelemetryFetch>();
    await trackCommand('help', '0.6.1', 0, {
      env: {},
      endpoint: 'http://telemetry.example.test/api/events',
      fetch
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('contains network and HTTP failures without retrying', async () => {
    const networkFetch = vi.fn<TelemetryFetch>().mockRejectedValue(new Error('offline'));
    await expect(trackCommand('doctor', '0.6.1', 1, {
      env: {},
      endpoint: 'https://telemetry.example.test/api/events',
      fetch: networkFetch
    })).resolves.toBeUndefined();
    expect(networkFetch).toHaveBeenCalledTimes(1);

    const responseFetch = vi.fn<TelemetryFetch>().mockResolvedValue(new Response('no', { status: 503 }));
    await expect(trackCommand('doctor', '0.6.1', 1, {
      env: {},
      endpoint: 'https://telemetry.example.test/api/events',
      fetch: responseFetch
    })).resolves.toBeUndefined();
    expect(responseFetch).toHaveBeenCalledTimes(1);
  });

  it('does not follow redirects or replay the event body', async () => {
    const fetch = vi.fn<TelemetryFetch>().mockRejectedValue(
      new TypeError('redirect mode is set to error')
    );
    await trackCommand('help', '0.6.1', 0, {
      env: {},
      endpoint: 'https://telemetry.example.test/api/events',
      fetch
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.redirect).toBe('error');
  });

  it('aborts within the configured delivery budget', async () => {
    const fetch: TelemetryFetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
    const started = Date.now();
    await trackCommand('help', '0.6.1', 0, {
      env: {},
      endpoint: 'https://telemetry.example.test/api/events',
      fetch,
      timeoutMs: 10
    });
    expect(Date.now() - started).toBeLessThan(500);
  });
});
