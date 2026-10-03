import { once } from 'node:events';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTelemetryServer } from '../src/server.js';
import { telemetryStorageFields } from '../../../src/telemetry/contract.js';
import { silenceConsole, validEvent } from './support/fixtures.js';
import {
  afterPendingCallbacks,
  connectLoopback,
  nextAcceptedSocket,
  postHead,
  readResponseHead,
  serverPort,
  socketClosed
} from './support/sockets.js';

// Offline stand-ins for the Azure SDK: no managed-identity endpoint, credential or
// Logs Ingestion request is ever contacted from these tests.
const azure = vi.hoisted(() => {
  const state = {
    credentials: [] as object[],
    credentialOptions: [] as unknown[],
    clients: [] as Array<{ endpoint: string; credential: unknown }>,
    getToken: vi.fn<(scopes: string | string[]) => Promise<{ token: string; expiresOnTimestamp: number } | null>>(),
    upload: vi.fn<(ruleId: string, streamName: string, logs: Record<string, unknown>[]) => Promise<void>>()
  };
  class ManagedIdentityCredential {
    constructor(options: unknown) {
      state.credentials.push(this);
      state.credentialOptions.push(options);
    }

    getToken(scopes: string | string[]) {
      return state.getToken(scopes);
    }
  }
  class LogsIngestionClient {
    constructor(endpoint: string, credential: unknown) {
      state.clients.push({ endpoint, credential });
    }

    upload(ruleId: string, streamName: string, logs: Record<string, unknown>[]) {
      return state.upload(ruleId, streamName, logs);
    }
  }
  return { state, ManagedIdentityCredential, LogsIngestionClient };
});

vi.mock('@azure/identity', () => ({ ManagedIdentityCredential: azure.ManagedIdentityCredential }));
vi.mock('@azure/monitor-ingestion', () => ({ LogsIngestionClient: azure.LogsIngestionClient }));

type ServerModule = typeof import('../src/server.js');

const listener = vi.hoisted(() => ({
  calls: [] as Array<{ server: import('node:http').Server; args: unknown[] }>,
  override: undefined as
    | undefined
    | ((server: import('node:http').Server, actual: typeof import('../src/server.js')) => Promise<void>)
}));

// The entrypoint binds the production default 0.0.0.0:8080; record that call and bind an
// ephemeral loopback port instead.
vi.mock('../src/server.js', async (importOriginal) => {
  const actual = await importOriginal<ServerModule>();
  return {
    ...actual,
    listenTelemetryServer: (server: Server, ...args: unknown[]) => {
      listener.calls.push({ server, args });
      return listener.override
        ? listener.override(server, actual)
        : actual.listenTelemetryServer(server, 0, '127.0.0.1');
    }
  };
});

const ingestionEnvironment = {
  TELEMETRY_DCE_ENDPOINT: 'https://liftoff-gateway-test.invalid/',
  TELEMETRY_DCR_IMMUTABLE_ID: 'dcr-00000000000000000000000000000000',
  TELEMETRY_STREAM_NAME: 'Custom-LiftoffCommandEvents',
  AZURE_CLIENT_ID: '00000000-0000-0000-0000-000000000000'
} as const;

const shutdownSignals = ['SIGINT', 'SIGTERM'] as const;
type ShutdownSignal = (typeof shutdownSignals)[number];
type SignalListener = (signal: ShutdownSignal) => void;

let signalBaseline: Map<ShutdownSignal, Set<unknown>>;
let exitCodeBefore: typeof process.exitCode;

function addedSignalListeners(signal: ShutdownSignal): SignalListener[] {
  const baseline = signalBaseline.get(signal) ?? new Set<unknown>();
  return process.rawListeners(signal).filter((registered) => !baseline.has(registered)) as SignalListener[];
}

// Invokes the entrypoint's own once-wrapper exactly as signal delivery would, without
// signalling the shared test worker process.
function deliver(signal: ShutdownSignal): void {
  const [registered, ...unexpected] = addedSignalListeners(signal);
  expect(registered).toBeTypeOf('function');
  expect(unexpected).toHaveLength(0);
  registered.call(process, signal);
}

async function startGateway(): Promise<Server> {
  await import('../src/index.js');
  expect(listener.calls).toHaveLength(1);
  return listener.calls[0].server;
}

async function stalledRequest(server: Server): Promise<{ client: Socket; serverSocket: Socket }> {
  const accepted = nextAcceptedSocket(server);
  const requestSeen = once(server, 'request');
  const client = await connectLoopback(serverPort(server));
  client.write(`${postHead(100)}{"schemaVersion":1`);
  const serverSocket = await accepted;
  await requestSeen;
  return { client, serverSocket };
}

// A one-off, non-pooled connection so no client socket or timer outlives the request.
function postEvent(port: number, body: string): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/events',
      method: 'POST',
      agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
      });
      response.once('end', () => resolve({ status: response.statusCode, body: text }));
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

beforeEach(() => {
  vi.resetModules();
  for (const [name, value] of Object.entries(ingestionEnvironment)) {
    vi.stubEnv(name, value);
  }
  azure.state.credentials.length = 0;
  azure.state.credentialOptions.length = 0;
  azure.state.clients.length = 0;
  azure.state.getToken.mockResolvedValue({
    token: 'synthetic-test-token',
    expiresOnTimestamp: Date.now() + 3_600_000
  });
  azure.state.upload.mockResolvedValue(undefined);
  listener.calls.length = 0;
  listener.override = undefined;
  signalBaseline = new Map(
    shutdownSignals.map((signal) => [signal, new Set<unknown>(process.rawListeners(signal))])
  );
  exitCodeBefore = process.exitCode;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const signal of shutdownSignals) {
    for (const registered of addedSignalListeners(signal)) {
      process.removeListener(signal, registered);
    }
  }
  for (const { server } of listener.calls) {
    server.closeAllConnections();
    await closeTelemetryServer(server);
  }
  vi.unstubAllEnvs();
  process.exitCode = exitCodeBefore;
});

describe('telemetry gateway entrypoint startup', () => {
  it('acquires the managed-identity token before opening the listener', async () => {
    let issueToken!: (token: { token: string; expiresOnTimestamp: number } | null) => void;
    const tokenRequested = new Promise<void>((requested) => {
      azure.state.getToken.mockImplementation(() => {
        requested();
        return new Promise((resolve) => {
          issueToken = resolve;
        });
      });
    });

    const starting = import('../src/index.js');
    await tokenRequested;
    await afterPendingCallbacks();
    expect(listener.calls).toHaveLength(0);
    expect(addedSignalListeners('SIGINT')).toHaveLength(0);
    expect(addedSignalListeners('SIGTERM')).toHaveLength(0);

    issueToken({ token: 'synthetic-test-token', expiresOnTimestamp: Date.now() + 3_600_000 });
    await starting;
    expect(azure.state.getToken).toHaveBeenCalledOnce();
    expect(azure.state.getToken).toHaveBeenCalledWith('https://monitor.azure.com/.default');
    expect(azure.state.credentialOptions).toEqual([{ clientId: ingestionEnvironment.AZURE_CLIENT_ID }]);
    expect(azure.state.clients).toEqual([
      { endpoint: 'https://liftoff-gateway-test.invalid', credential: azure.state.credentials[0] }
    ]);
    expect(listener.calls).toHaveLength(1);
    // Production binds the default fixed port and host.
    expect(listener.calls[0].args).toEqual([]);
    expect(listener.calls[0].server.listening).toBe(true);
    expect(addedSignalListeners('SIGINT')).toHaveLength(1);
    expect(addedSignalListeners('SIGTERM')).toHaveLength(1);
  });

  it.each([
    ['TELEMETRY_DCE_ENDPOINT', undefined],
    ['TELEMETRY_DCR_IMMUTABLE_ID', '   '],
    ['TELEMETRY_STREAM_NAME', ''],
    ['AZURE_CLIENT_ID', undefined]
  ])('refuses to start without %s before creating any Azure client', async (name, value) => {
    vi.stubEnv(name, value);
    await expect(import('../src/index.js')).rejects.toThrow(
      `Missing required telemetry ingestion setting: ${name}`
    );
    expect(azure.state.credentials).toHaveLength(0);
    expect(azure.state.clients).toHaveLength(0);
    expect(listener.calls).toHaveLength(0);
    expect(addedSignalListeners('SIGTERM')).toHaveLength(0);
  });

  it('refuses a non-HTTPS ingestion endpoint', async () => {
    vi.stubEnv('TELEMETRY_DCE_ENDPOINT', 'http://liftoff-gateway-test.invalid');
    await expect(import('../src/index.js')).rejects.toThrow('TELEMETRY_DCE_ENDPOINT must use HTTPS.');
    expect(azure.state.credentials).toHaveLength(0);
    expect(listener.calls).toHaveLength(0);
  });

  it('does not listen when the managed identity cannot issue a token', async () => {
    const unavailable = new Error('ManagedIdentityCredential authentication unavailable.');
    azure.state.getToken.mockRejectedValue(unavailable);
    await expect(import('../src/index.js')).rejects.toBe(unavailable);
    expect(listener.calls).toHaveLength(0);
    expect(addedSignalListeners('SIGINT')).toHaveLength(0);
    expect(addedSignalListeners('SIGTERM')).toHaveLength(0);
  });

  it('does not listen when the managed identity returns no token', async () => {
    azure.state.getToken.mockResolvedValue(null);
    await expect(import('../src/index.js')).rejects.toThrow(
      'Unable to acquire the Azure Monitor managed-identity token.'
    );
    expect(listener.calls).toHaveLength(0);
    expect(addedSignalListeners('SIGTERM')).toHaveLength(0);
  });

  it('fails startup without shutdown handlers when the listener cannot bind', async () => {
    const occupant = createServer();
    await new Promise<void>((resolve) => occupant.listen(0, '127.0.0.1', resolve));
    listener.override = (server, actual) =>
      actual.listenTelemetryServer(server, serverPort(occupant), '127.0.0.1');
    try {
      await expect(import('../src/index.js')).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(listener.calls).toHaveLength(1);
      expect(listener.calls[0].server.listening).toBe(false);
      expect(addedSignalListeners('SIGINT')).toHaveLength(0);
      expect(addedSignalListeners('SIGTERM')).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => occupant.close(() => resolve()));
    }
  });
});

describe('telemetry gateway entrypoint ingestion', () => {
  it('uploads accepted events to the configured rule and stream and reports rejection as 503', async () => {
    const output = silenceConsole();
    const server = await startGateway();
    const body = JSON.stringify(validEvent);

    const before = Date.now();
    const accepted = await postEvent(serverPort(server), body);
    const after = Date.now();
    expect(accepted).toEqual({ status: 204, body: '' });
    expect(azure.state.upload).toHaveBeenCalledOnce();
    const [ruleId, streamName, logs] = azure.state.upload.mock.calls[0];
    expect(ruleId).toBe(ingestionEnvironment.TELEMETRY_DCR_IMMUTABLE_ID);
    expect(streamName).toBe(ingestionEnvironment.TELEMETRY_STREAM_NAME);
    expect(logs).toHaveLength(1);
    expect(Object.keys(logs[0])).toEqual([...telemetryStorageFields]);
    expect(logs[0]).toMatchObject({
      EventName: 'command_executed',
      SchemaVersion: 1,
      Command: 'infra:plan',
      CliVersion: '0.6.1',
      Outcome: 'success'
    });
    const generatedAt = Date.parse(String(logs[0].TimeGenerated));
    expect(generatedAt).toBeGreaterThanOrEqual(before);
    expect(generatedAt).toBeLessThanOrEqual(after);

    azure.state.upload.mockRejectedValueOnce(new Error('Logs Ingestion rejected the batch.'));
    expect(await postEvent(serverPort(server), body)).toEqual({ status: 503, body: '' });
    expect(azure.state.upload).toHaveBeenCalledTimes(2);
    output.expectNothingLogged();
  });
});

describe('telemetry gateway entrypoint shutdown', () => {
  it('drains an in-flight event on SIGTERM, exits cleanly and clears the shutdown bound', async () => {
    const output = silenceConsole();
    const server = await startGateway();
    const body = JSON.stringify(validEvent);
    const accepted = nextAcceptedSocket(server);
    const requestSeen = once(server, 'request');
    const client = await connectLoopback(serverPort(server));
    const responseHead = readResponseHead(client);
    client.write(`${postHead(body.length)}${body.slice(0, 10)}`);
    const serverSocket = await accepted;
    await requestSeen;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const forceClose = vi.spyOn(server, 'closeAllConnections');
    const serverClosed = once(server, 'close');
    deliver('SIGTERM');
    expect(server.listening).toBe(false);
    expect(addedSignalListeners('SIGTERM')).toHaveLength(0);

    client.write(body.slice(10));
    expect(await responseHead).toMatch(/^HTTP\/1\.1 204 No Content\r\n/);
    const serverSocketClosed = socketClosed(serverSocket);
    client.end();
    await Promise.all([serverSocketClosed, serverClosed]);
    await afterPendingCallbacks();
    expect(azure.state.upload).toHaveBeenCalledOnce();

    // A cleared bound can neither force connections closed nor fail the exit afterwards.
    vi.advanceTimersByTime(25_000);
    expect(forceClose).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exitCodeBefore);
    output.expectNothingLogged();
  });

  it('force-closes stalled connections at the 25-second bound and reports exit code 1', async () => {
    const output = silenceConsole();
    const server = await startGateway();
    const { client, serverSocket } = await stalledRequest(server);
    const clientClosed = socketClosed(client);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const forceClose = vi.spyOn(server, 'closeAllConnections');
    const serverClosed = once(server, 'close');
    deliver('SIGTERM');
    expect(server.listening).toBe(false);

    vi.advanceTimersByTime(24_999);
    expect(forceClose).not.toHaveBeenCalled();
    expect(serverSocket.destroyed).toBe(false);
    expect(process.exitCode).toBe(exitCodeBefore);

    vi.advanceTimersByTime(1);
    expect(forceClose).toHaveBeenCalledOnce();
    expect(serverSocket.destroyed).toBe(true);
    expect(process.exitCode).toBe(1);
    await Promise.all([serverClosed, clientClosed]);
    await afterPendingCallbacks();
    expect(process.exitCode).toBe(1);
    expect(azure.state.upload).not.toHaveBeenCalled();
    output.expectNothingLogged();
  });

  it('reports a failed listener close with exit code 1 and clears the bound', async () => {
    const server = await startGateway();
    const failure = Object.assign(new Error('Server is not running.'), { code: 'ERR_SERVER_NOT_RUNNING' });
    const close = vi.spyOn(server, 'close').mockImplementationOnce((function (
      this: Server,
      callback?: (error?: Error) => void
    ) {
      queueMicrotask(() => callback?.(failure));
      return this;
    }) as unknown as Server['close']);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const forceClose = vi.spyOn(server, 'closeAllConnections');
    deliver('SIGTERM');
    await afterPendingCallbacks();
    expect(close).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);

    vi.advanceTimersByTime(25_000);
    expect(forceClose).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('shuts down once on SIGINT and ignores a later SIGTERM', async () => {
    const server = await startGateway();
    const close = vi.spyOn(server, 'close');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const forceClose = vi.spyOn(server, 'closeAllConnections');
    const serverClosed = once(server, 'close');
    deliver('SIGINT');
    deliver('SIGTERM');
    expect(close).toHaveBeenCalledOnce();
    expect(addedSignalListeners('SIGINT')).toHaveLength(0);
    expect(addedSignalListeners('SIGTERM')).toHaveLength(0);

    await serverClosed;
    await afterPendingCallbacks();
    vi.advanceTimersByTime(25_000);
    expect(forceClose).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(exitCodeBefore);
  });
});
