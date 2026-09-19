import { createServer, type Server } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  createAzureTelemetryIngestionDependencies,
  handleTelemetryRequest,
  type AzureTelemetryIngestionConfig,
  type TelemetryHttpRequest
} from '../src/handler.js';
import {
  closeTelemetryServer,
  createTelemetryServer,
  listenTelemetryServer
} from '../src/server.js';
import type { TelemetryStorageRecord } from '../../../src/telemetry/contract.js';

// Mock Azure SDK modules for createAzureTelemetryIngestionDependencies testing
vi.mock('@azure/identity', () => {
  const MockCredential = vi.fn().mockImplementation(function () {
    return {
      getToken: vi.fn().mockImplementation(async (scope: string) => {
        if (scope.includes('fail')) {
          return null;
        }
        return { token: 'mock-token', expiresOnTimestamp: Date.now() + 3600_000 };
      })
    };
  });
  return {
    ManagedIdentityCredential: MockCredential
  };
});

vi.mock('@azure/monitor-ingestion', () => {
  const MockClient = vi.fn().mockImplementation(function () {
    return {
      upload: vi.fn().mockResolvedValue(undefined)
    };
  });
  return {
    LogsIngestionClient: MockClient
  };
});

describe('Azure telemetry ingestion dependencies and client', () => {
  const testConfig: AzureTelemetryIngestionConfig = {
    endpoint: 'https://test.ingest.monitor.azure.com',
    dcrImmutableId: 'dcr-test-1234',
    streamName: 'Custom-LiftoffEvents',
    managedIdentityClientId: 'client-test-5678'
  };

  it('initializes dependencies, warms up credential token, and provides now()', async () => {
    const deps = createAzureTelemetryIngestionDependencies(testConfig);
    expect(deps.now()).toBeInstanceOf(Date);

    await expect(deps.warmUp()).resolves.toBeUndefined();
  });

  it('fails warmUp if token acquisition returns null', async () => {
    const { ManagedIdentityCredential } = await import('@azure/identity');
    vi.mocked(ManagedIdentityCredential).mockImplementationOnce(function () {
      return {
        getToken: vi.fn().mockResolvedValue(null)
      } as any;
    });

    const deps = createAzureTelemetryIngestionDependencies(testConfig);
    await expect(deps.warmUp()).rejects.toThrow('Unable to acquire the Azure Monitor managed-identity token.');
  });

  it('uploads properly formatted Azure Monitor Log Analytics records', async () => {
    const deps = createAzureTelemetryIngestionDependencies(testConfig);
    const record: TelemetryStorageRecord = {
      TimeGenerated: '2026-09-15T00:00:00.000Z',
      EventName: 'command_executed',
      SchemaVersion: 1,
      Command: 'infra:plan',
      CliVersion: '0.13.0',
      Outcome: 'success'
    };

    await expect(deps.upload(record)).resolves.toBeUndefined();
  });
});

describe('telemetry request body reader edge cases', () => {
  it('returns 400 invalid when chunk is neither string nor Uint8Array', async () => {
    const badChunkRequest: TelemetryHttpRequest = {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: {
        async *[Symbol.asyncIterator]() {
          yield 12345 as any; // invalid chunk type
        }
      }
    };

    const dummyDeps = {
      now: () => new Date(),
      upload: vi.fn().mockResolvedValue(undefined)
    };

    const response = await handleTelemetryRequest(badChunkRequest, dummyDeps);
    expect(response.status).toBe(400);
  });

  it('returns 400 invalid when stream encounters invalid UTF-8 bytes', async () => {
    const badUtf8Request: TelemetryHttpRequest = {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: {
        async *[Symbol.asyncIterator]() {
          // Invalid continuation byte sequence in UTF-8
          yield new Uint8Array([0xC3, 0x28]);
        }
      }
    };

    const dummyDeps = {
      now: () => new Date(),
      upload: vi.fn().mockResolvedValue(undefined)
    };

    const response = await handleTelemetryRequest(badUtf8Request, dummyDeps);
    expect(response.status).toBe(400);
  });
});

describe('telemetry server lifecycle and client errors', () => {
  it('handles clientError event by ending socket with 400 Bad Request', () => {
    const server = createTelemetryServer(() => ({
      now: () => new Date(),
      upload: vi.fn()
    }));

    const socket = new Socket();
    let writtenData = '';
    vi.spyOn(socket, 'writable', 'get').mockReturnValue(true);
    vi.spyOn(socket, 'end').mockImplementation(((chunk: any) => {
      writtenData = chunk?.toString() || '';
      return socket;
    }) as any);

    server.emit('clientError', new Error('client read error'), socket);
    expect(writtenData).toContain('HTTP/1.1 400 Bad Request');
  });

  it('ignores clientError if socket is not writable', () => {
    const server = createTelemetryServer(() => ({
      now: () => new Date(),
      upload: vi.fn()
    }));

    const socket = new Socket();
    vi.spyOn(socket, 'writable', 'get').mockReturnValue(false);
    const endSpy = vi.spyOn(socket, 'end');

    server.emit('clientError', new Error('client error'), socket);
    expect(endSpy).not.toHaveBeenCalled();
  });

  it('no-ops when closing an unstarted server', async () => {
    const server = createServer();
    expect(server.listening).toBe(false);
    await expect(closeTelemetryServer(server)).resolves.toBeUndefined();
  });

  it('rejects listenTelemetryServer if port is unavailable or server errors', async () => {
    const server1 = createServer();
    await new Promise<void>((resolve) => server1.listen(0, '127.0.0.1', () => resolve()));
    const port = (server1.address() as any).port;

    const server2 = createTelemetryServer(() => ({
      now: () => new Date(),
      upload: vi.fn()
    }));

    await expect(listenTelemetryServer(server2, port, '127.0.0.1')).rejects.toThrow();
    await new Promise<void>((resolve) => server1.close(() => resolve()));
  });

  it('handles error in closeTelemetryServer', async () => {
    const server = createServer();
    vi.spyOn(server, 'listening', 'get').mockReturnValue(true);
    vi.spyOn(server, 'close').mockImplementation(((cb: any) => {
      cb(new Error('forced close error'));
      return server;
    }) as any);

    await expect(closeTelemetryServer(server)).rejects.toThrow('forced close error');
  });
});

describe('deployed shared telemetry contract', () => {
  it('validates isTelemetryCliVersion against SemVer formats', async () => {
    const { isTelemetryCliVersion } = await import('../../../src/telemetry/contract.js');
    expect(isTelemetryCliVersion('0.13.0')).toBe(true);
    expect(isTelemetryCliVersion('1.0.0-rc.1')).toBe(true);
    expect(isTelemetryCliVersion('bad-version')).toBe(false);
    expect(isTelemetryCliVersion(null)).toBe(false);
    expect(isTelemetryCliVersion(undefined)).toBe(false);
    expect(isTelemetryCliVersion(123)).toBe(false);
  });

  it('evaluates isTelemetryExcludedCommand accurately across commands and flags', async () => {
    const { isTelemetryExcludedCommand } = await import('../../../src/telemetry/contract.js');

    // Repair with capabilities or inspect-layout flag is excluded
    expect(isTelemetryExcludedCommand({ command: 'repair', subcommand: undefined, positional: [], flags: { capabilities: true } })).toBe(true);
    expect(isTelemetryExcludedCommand({ command: 'repair', subcommand: undefined, positional: [], flags: { 'inspect-layout': true } })).toBe(true);
    expect(isTelemetryExcludedCommand({ command: 'repair', subcommand: undefined, positional: [], flags: {} })).toBe(false);

    // Help installation is excluded
    expect(isTelemetryExcludedCommand({ command: 'help', subcommand: undefined, positional: ['installation'], flags: {} })).toBe(true);
    expect(isTelemetryExcludedCommand({ command: 'help', subcommand: undefined, positional: ['init'], flags: {} })).toBe(false);

    // Installation flags exclusions
    expect(isTelemetryExcludedCommand({ command: 'installation', subcommand: undefined, positional: [], flags: { help: true } })).toBe(true);
    expect(isTelemetryExcludedCommand({ command: 'installation', subcommand: undefined, positional: [], flags: { check: true } })).toBe(true);
    expect(isTelemetryExcludedCommand({ command: 'installation', subcommand: undefined, positional: [], flags: { recover: true } })).toBe(true);
    expect(isTelemetryExcludedCommand({ command: 'installation', subcommand: 'migrate', positional: [], flags: { json: true } })).toBe(true);
    expect(isTelemetryExcludedCommand({ command: 'installation', subcommand: 'migrate', positional: [], flags: { 'approve-plan': 'yes' } })).toBe(false);

    // Explicit excluded commands (e.g. governance:assess, installation:inspect)
    expect(isTelemetryExcludedCommand({ command: 'governance', subcommand: 'assess', positional: [], flags: {} })).toBe(true);
    expect(isTelemetryExcludedCommand({ command: 'installation', subcommand: 'inspect', positional: [], flags: {} })).toBe(true);
    expect(isTelemetryExcludedCommand({ command: 'init', subcommand: undefined, positional: [], flags: {} })).toBe(false);
  });

  it('enforces canPersistTelemetryNotice policy', async () => {
    const { canPersistTelemetryNotice } = await import('../../../src/telemetry/contract.js');

    expect(canPersistTelemetryNotice({ command: undefined, subcommand: undefined, positional: [], flags: {} })).toBe(false);
    expect(canPersistTelemetryNotice({ command: 'init', subcommand: undefined, positional: [], flags: { help: true } })).toBe(false);
    expect(canPersistTelemetryNotice({ command: 'init', subcommand: undefined, positional: [], flags: { check: true } })).toBe(false);
    expect(canPersistTelemetryNotice({ command: 'help', subcommand: undefined, positional: [], flags: {} })).toBe(false);
    expect(canPersistTelemetryNotice({ command: 'doctor', subcommand: undefined, positional: [], flags: {} })).toBe(false);
    expect(canPersistTelemetryNotice({ command: 'plan', subcommand: undefined, positional: [], flags: {} })).toBe(false);

    // Governance subcommands
    expect(canPersistTelemetryNotice({ command: 'governance', subcommand: 'status', positional: [], flags: {} })).toBe(false);
    expect(canPersistTelemetryNotice({ command: 'governance', subcommand: 'plan', positional: [], flags: {} })).toBe(false);
    expect(canPersistTelemetryNotice({ command: 'governance', subcommand: 'resume', positional: [], flags: {} })).toBe(false);
    expect(canPersistTelemetryNotice({ command: 'governance', subcommand: 'verify', positional: [], flags: {} })).toBe(false);
    expect(canPersistTelemetryNotice({ command: 'governance', subcommand: 'apply-next', positional: [], flags: { execute: false } })).toBe(false);
    expect(canPersistTelemetryNotice({ command: 'governance', subcommand: 'apply-next', positional: [], flags: { execute: true } })).toBe(true);

    // Normal mutating command allows notice
    expect(canPersistTelemetryNotice({ command: 'init', subcommand: undefined, positional: [], flags: {} })).toBe(true);
  });

  it('determines canonicalTelemetryCommand and creates valid telemetry events', async () => {
    const { canonicalTelemetryCommand, createTelemetryEvent } = await import('../../../src/telemetry/contract.js');

    expect(canonicalTelemetryCommand({ command: undefined, subcommand: undefined, positional: [], flags: {} })).toBe('help');
    expect(canonicalTelemetryCommand({ command: 'help', subcommand: undefined, positional: [], flags: {} })).toBe('help');
    expect(canonicalTelemetryCommand({ command: 'init', subcommand: undefined, positional: [], flags: { help: true } })).toBe('help');

    expect(canonicalTelemetryCommand({ command: 'governance', subcommand: 'assess', positional: [], flags: {} })).toBeUndefined();
    expect(canonicalTelemetryCommand({ command: 'unknown-cmd', subcommand: undefined, positional: [], flags: {} })).toBeUndefined();

    // Valid command
    expect(canonicalTelemetryCommand({ command: 'init', subcommand: undefined, positional: [], flags: {} })).toBe('init');
    expect(canonicalTelemetryCommand({ command: 'upgrade', subcommand: undefined, positional: [], flags: {} })).toBe('upgrade');
    expect(canonicalTelemetryCommand({ command: 'infra', subcommand: 'plan', positional: [], flags: {} })).toBe('infra:plan');

    // createTelemetryEvent
    const successEvent = createTelemetryEvent('init', '0.13.0', 0);
    expect(successEvent).toEqual({
      schemaVersion: 1,
      event: 'command_executed',
      command: 'init',
      cliVersion: '0.13.0',
      outcome: 'success'
    });

    const failEvent = createTelemetryEvent('infra:plan', '0.13.0', 1);
    expect(failEvent.outcome).toBe('failure');
  });
});
