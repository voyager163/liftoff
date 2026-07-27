import { request as httpRequest, type Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  closeTelemetryServer,
  createTelemetryServer,
  listenTelemetryServer,
  telemetryPort,
  telemetryRoute
} from '../src/server.js';
import type { TelemetryIngestionDependencies } from '../src/handler.js';
import type { TelemetryStorageRecord } from '../../../src/telemetry/contract.js';

const validEvent = {
  schemaVersion: 1,
  event: 'command_executed',
  command: 'infra:plan',
  cliVersion: '0.6.1',
  outcome: 'success'
};

function dependencies(): TelemetryIngestionDependencies & {
  upload: ReturnType<typeof vi.fn<(record: TelemetryStorageRecord) => Promise<void>>>;
} {
  return {
    now: () => new Date('2026-07-26T00:00:00.000Z'),
    upload: vi.fn<(record: TelemetryStorageRecord) => Promise<void>>().mockResolvedValue(undefined)
  };
}

async function withServer(
  deps: TelemetryIngestionDependencies,
  run: (baseUrl: string, server: Server) => Promise<void>
): Promise<void> {
  const server = createTelemetryServer(() => deps);
  await listenTelemetryServer(server, 0, '127.0.0.1');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP server address.');
  }
  try {
    await run(`http://127.0.0.1:${address.port}`, server);
  } finally {
    await closeTelemetryServer(server);
  }
}

function streamedRequest(baseUrl: string, chunks: Uint8Array[]): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${baseUrl}${telemetryRoute}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked'
      }
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    for (const chunk of chunks) {
      request.write(chunk);
    }
    request.end();
  });
}

describe('telemetry HTTP server', () => {
  it('uses the fixed nonprivileged port and exact public route', () => {
    expect(telemetryPort).toBe(8080);
    expect(telemetryRoute).toBe('/api/events');
  });

  it('accepts a valid event through the real HTTP boundary', async () => {
    const deps = dependencies();
    await withServer(deps, async (baseUrl) => {
      const response = await fetch(`${baseUrl}${telemetryRoute}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validEvent)
      });
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
    });
    expect(deps.upload).toHaveBeenCalledOnce();
    expect(deps.upload.mock.calls[0][0]).toEqual({
      TimeGenerated: '2026-07-26T00:00:00.000Z',
      EventName: 'command_executed',
      SchemaVersion: 1,
      Command: 'infra:plan',
      CliVersion: '0.6.1',
      Outcome: 'success'
    });
  });

  it('exposes no health or diagnostics route and initializes no dependencies there', async () => {
    const resolve = vi.fn(() => dependencies());
    const server = createTelemetryServer(resolve);
    await listenTelemetryServer(server, 0, '127.0.0.1');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP server address.');
    }
    try {
      for (const route of ['/health', '/metrics', '/']) {
        expect((await fetch(`http://127.0.0.1:${address.port}${route}`)).status).toBe(404);
      }
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      await closeTelemetryServer(server);
    }
  });

  it('rejects malformed, wrong-method, and streamed oversized requests without logging', async () => {
    const deps = dependencies();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await withServer(deps, async (baseUrl) => {
        expect((await fetch(`${baseUrl}${telemetryRoute}`)).status).toBe(405);
        expect((await fetch(`${baseUrl}${telemetryRoute}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{invalid'
        })).status).toBe(400);
        expect(await streamedRequest(baseUrl, [
          new Uint8Array(1_024),
          new Uint8Array(1)
        ])).toBe(413);
      });
      expect(deps.upload).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('closes gracefully and idempotently', async () => {
    const server = createTelemetryServer(() => dependencies());
    await listenTelemetryServer(server, 0, '127.0.0.1');
    expect(server.listening).toBe(true);
    await closeTelemetryServer(server);
    expect(server.listening).toBe(false);
    await expect(closeTelemetryServer(server)).resolves.toBeUndefined();
  });
});
