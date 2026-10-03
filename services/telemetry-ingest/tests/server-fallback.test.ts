import { describe, expect, it, vi } from 'vitest';
import { handleTelemetryRequest } from '../src/handler.js';
import {
  closeTelemetryServer,
  createTelemetryServer,
  listenTelemetryServer,
  telemetryRoute
} from '../src/server.js';
import { recordingDependencies, silenceConsole, validEvent, validRecord } from './support/fixtures.js';
import { serverPort } from './support/sockets.js';

vi.mock('../src/handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/handler.js')>();
  return { ...actual, handleTelemetryRequest: vi.fn(actual.handleTelemetryRequest) };
});

describe('telemetry HTTP server unexpected failures', () => {
  it('answers 503 without detail when request handling fails unexpectedly, then keeps serving', async () => {
    const output = silenceConsole();
    const deps = recordingDependencies();
    const server = createTelemetryServer(() => deps);
    await listenTelemetryServer(server, 0, '127.0.0.1');
    const post = () => fetch(`http://127.0.0.1:${serverPort(server)}${telemetryRoute}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validEvent)
    });
    try {
      vi.mocked(handleTelemetryRequest).mockRejectedValueOnce(
        new Error('Unexpected failure while handling {"command":"init:/private/project"}')
      );
      const failed = await post();
      expect(failed.status).toBe(503);
      expect(failed.headers.get('cache-control')).toBe('no-store');
      expect(await failed.text()).toBe('');
      expect(deps.upload).not.toHaveBeenCalled();

      const accepted = await post();
      expect(accepted.status).toBe(204);
      expect(deps.upload).toHaveBeenCalledOnce();
      expect(deps.upload).toHaveBeenCalledWith(validRecord);
      output.expectNothingLogged();
    } finally {
      server.closeAllConnections();
      await closeTelemetryServer(server);
    }
  });
});
