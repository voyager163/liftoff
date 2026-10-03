import { once } from 'node:events';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
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
import {
  badRequestResponse,
  recordingDependencies,
  silenceConsole,
  validRecord
} from './support/fixtures.js';
import {
  afterPendingCallbacks,
  captureText,
  connectLoopback,
  nextAcceptedSocket,
  postHead,
  readResponseHead,
  serverPort,
  socketClosed
} from './support/sockets.js';

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

async function startLoopbackServer(
  resolveDependencies: () => TelemetryIngestionDependencies
): Promise<Server> {
  const server = createTelemetryServer(resolveDependencies);
  await listenTelemetryServer(server, 0, '127.0.0.1');
  return server;
}

async function stopServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await closeTelemetryServer(server);
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function postValidEvent(baseUrl: string, target = telemetryRoute): Promise<Response> {
  return fetch(`${baseUrl}${target}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validEvent)
  });
}

describe('telemetry HTTP server malformed requests', () => {
  it.each([
    ['an invalid request line', 'GARBAGE\r\n\r\n'],
    [
      'an invalid content length',
      'POST /api/events HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: abc\r\n\r\n'
    ],
    [
      'conflicting body framing',
      'POST /api/events HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n{}'
    ],
    ['an invalid header name', 'POST /api/events HTTP/1.1\r\nHost: localhost\r\nBad Header: value\r\n\r\n']
  ])('answers %s with one complete 400 and settles a client that never sends FIN', async (_name, rawRequest) => {
    const output = silenceConsole();
    const resolve = vi.fn(() => recordingDependencies());
    const server = await startLoopbackServer(resolve);
    const accepted = nextAcceptedSocket(server);
    const client = await connectLoopback(serverPort(server), { allowHalfOpen: true });
    try {
      const received = captureText(client);
      const serverSocket = await accepted;
      const serverSocketClosed = socketClosed(serverSocket);
      const finReceived = once(client, 'end');
      client.write(rawRequest);

      await Promise.all([finReceived, serverSocketClosed]);
      expect(received()).toBe(badRequestResponse);
      // The client never half-closed, so only the server can have settled the connection.
      expect(client.writable).toBe(true);
      await closeTelemetryServer(server);
      expect(server.listening).toBe(false);
      expect(resolve).not.toHaveBeenCalled();
      output.expectNothingLogged();
    } finally {
      client.destroy();
      await stopServer(server);
    }
  });

  it('settles a connection reset during request headers without resolving dependencies', async () => {
    const output = silenceConsole();
    const deps = recordingDependencies();
    const resolve = vi.fn(() => deps);
    const server = await startLoopbackServer(resolve);
    try {
      const accepted = nextAcceptedSocket(server);
      const client = await connectLoopback(serverPort(server));
      const serverSocket = await accepted;
      const serverSocketClosed = socketClosed(serverSocket);
      client.write('POST /api/events HTTP/1.1\r\nHost: localhost\r\n');
      client.resetAndDestroy();
      await serverSocketClosed;
      expect(resolve).not.toHaveBeenCalled();

      const response = await postValidEvent(`http://127.0.0.1:${serverPort(server)}`);
      expect(response.status).toBe(204);
      expect(deps.upload).toHaveBeenCalledOnce();
      expect(deps.upload).toHaveBeenCalledWith(validRecord);
      output.expectNothingLogged();
    } finally {
      await stopServer(server);
    }
  });

  it.each([
    ['closes', (socket: Socket) => socket.destroy()],
    ['resets', (socket: Socket) => socket.resetAndDestroy()]
  ])('discards a body whose client %s mid-stream and keeps serving', async (_name, abort) => {
    const output = silenceConsole();
    const deps = recordingDependencies();
    const server = await startLoopbackServer(() => deps);
    try {
      const requestSeen = once(server, 'request');
      const client = await connectLoopback(serverPort(server));
      client.write(`${postHead(100)}{"schemaVersion":1`);
      const [, response] = (await requestSeen) as [IncomingMessage, ServerResponse];
      const responseClosed = once(response, 'close');
      abort(client);
      await responseClosed;
      await afterPendingCallbacks();
      expect(response.statusCode).toBe(400);
      expect(deps.upload).not.toHaveBeenCalled();

      expect((await postValidEvent(`http://127.0.0.1:${serverPort(server)}`)).status).toBe(204);
      expect(deps.upload).toHaveBeenCalledOnce();
      expect(deps.upload).toHaveBeenCalledWith(validRecord);
      output.expectNothingLogged();
    } finally {
      await stopServer(server);
    }
  });
});

describe('telemetry HTTP server client-error settlement', () => {
  function stalledFlushSocket() {
    const writes: Buffer[] = [];
    const pendingWrites: Array<() => void> = [];
    const socket = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        writes.push(Buffer.from(chunk));
        pendingWrites.push(() => callback());
      }
    });
    return {
      socket,
      written: () => Buffer.concat(writes).toString('latin1'),
      completeFlush: () => {
        for (const complete of pendingWrites.splice(0)) {
          complete();
        }
      }
    };
  }

  it('keeps a repeated parse error from discarding a 400 that is still flushing', async () => {
    const server = createTelemetryServer(() => recordingDependencies());
    const { socket, written, completeFlush } = stalledFlushSocket();

    server.emit('clientError', codedError('HPE_INVALID_METHOD', 'Parse Error'), socket);
    server.emit('clientError', codedError('HPE_INVALID_METHOD', 'Parse Error'), socket);
    expect(written()).toBe(badRequestResponse);
    expect(socket.destroyed).toBe(false);

    const closed = once(socket, 'close');
    completeFlush();
    await closed;
    expect(socket.destroyed).toBe(true);
    expect(written()).toBe(badRequestResponse);
  });

  it('bounds a stalled 400 flush when the request timeout fires', () => {
    const server = createTelemetryServer(() => recordingDependencies());
    const { socket, written } = stalledFlushSocket();

    server.emit('clientError', codedError('HPE_INVALID_METHOD', 'Parse Error'), socket);
    expect(socket.destroyed).toBe(false);
    server.emit('clientError', codedError('ERR_HTTP_REQUEST_TIMEOUT', 'Request timeout'), socket);
    expect(socket.destroyed).toBe(true);
    expect(written()).toBe(badRequestResponse);
  });

  it('destroys a socket that is no longer writable without writing a response', async () => {
    const server = createTelemetryServer(() => recordingDependencies());
    const write = vi.fn((_chunk: unknown, _encoding: BufferEncoding, callback: () => void) => callback());
    const finished = new Duplex({ read() {}, write });
    finished.end();
    await once(finished, 'finish');
    const reset = new Duplex({ read() {}, write });
    reset.destroy();

    expect(finished.writable).toBe(false);
    expect(finished.destroyed).toBe(false);
    server.emit('clientError', codedError('HPE_INVALID_EOF_STATE', 'Parse Error'), finished);
    server.emit('clientError', codedError('ECONNRESET', 'read ECONNRESET'), reset);
    expect(finished.destroyed).toBe(true);
    expect(reset.destroyed).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('telemetry HTTP server routing and dependency failures', () => {
  it('answers an unparseable request target with 404 without resolving dependencies', async () => {
    const resolve = vi.fn(() => recordingDependencies());
    const server = await startLoopbackServer(resolve);
    const client = await connectLoopback(serverPort(server));
    try {
      const head = readResponseHead(client);
      client.write(`${postHead(2, '//')}{}`);
      expect(await head).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/);
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      client.destroy();
      await stopServer(server);
    }
  });

  it('routes on the path alone and never stores query parameters', async () => {
    const deps = recordingDependencies();
    await withServer(deps, async (baseUrl) => {
      const response = await postValidEvent(baseUrl, `${telemetryRoute}?source=ci&path=%2Fprivate%2Fproject`);
      expect(response.status).toBe(204);
    });
    expect(deps.upload).toHaveBeenCalledOnce();
    expect(deps.upload).toHaveBeenCalledWith(validRecord);
  });

  it('answers 503 without detail when ingestion dependencies cannot be resolved', async () => {
    const output = silenceConsole();
    const resolve = vi.fn((): TelemetryIngestionDependencies => {
      throw new Error('Managed identity bootstrap detail');
    });
    const server = await startLoopbackServer(resolve);
    try {
      const response = await postValidEvent(`http://127.0.0.1:${serverPort(server)}`);
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe('');
      expect(resolve).toHaveBeenCalledOnce();
      output.expectNothingLogged();
    } finally {
      await stopServer(server);
    }
  });
});

describe('telemetry HTTP server listener lifecycle', () => {
  it('binds the fixed production port on every interface by default', async () => {
    const server = createTelemetryServer(() => recordingDependencies());
    const baseline = { error: server.listenerCount('error'), listening: server.listenerCount('listening') };
    const listen = vi.spyOn(server, 'listen').mockImplementation((function (this: Server) {
      process.nextTick(() => this.emit('listening'));
      return this;
    }) as unknown as Server['listen']);

    await listenTelemetryServer(server);
    expect(listen).toHaveBeenCalledOnce();
    expect(listen).toHaveBeenCalledWith(8080, '0.0.0.0');
    expect(server.listenerCount('error')).toBe(baseline.error);
    expect(server.listenerCount('listening')).toBe(baseline.listening);
  });

  it('rejects an occupied port and removes its startup listeners', async () => {
    const occupant = createServer();
    await listenTelemetryServer(occupant, 0, '127.0.0.1');
    const server = createTelemetryServer(() => recordingDependencies());
    const baseline = { error: server.listenerCount('error'), listening: server.listenerCount('listening') };
    try {
      await expect(listenTelemetryServer(server, serverPort(occupant), '127.0.0.1'))
        .rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(server.listening).toBe(false);
      expect(server.listenerCount('error')).toBe(baseline.error);
      expect(server.listenerCount('listening')).toBe(baseline.listening);
    } finally {
      await closeTelemetryServer(occupant);
    }
  });

  it('rejects when the listener reports a close failure', async () => {
    const server = await startLoopbackServer(() => recordingDependencies());
    const failure = codedError('ERR_SERVER_NOT_RUNNING', 'Server is not running.');
    const close = vi.spyOn(server, 'close').mockImplementationOnce((function (
      this: Server,
      callback?: (error?: Error) => void
    ) {
      callback?.(failure);
      return this;
    }) as unknown as Server['close']);
    try {
      await expect(closeTelemetryServer(server)).rejects.toBe(failure);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
      await stopServer(server);
    }
  });
});
