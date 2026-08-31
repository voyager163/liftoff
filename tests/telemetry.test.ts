import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureStream } from './helpers.js';
import {
  isTelemetryEnabled,
  maybeShowTelemetryNotice,
  productionTelemetryEndpoint,
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
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('telemetry client', () => {
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
