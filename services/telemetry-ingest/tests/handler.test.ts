import { describe, expect, it, vi } from 'vitest';
import {
  azureMonitorScope,
  handleTelemetryRequest,
  maximumTelemetryBodyBytes,
  parseTelemetryEvent,
  readAzureTelemetryIngestionConfig,
  type TelemetryHttpRequest,
  type TelemetryIngestionDependencies
} from '../src/handler.js';
import {
  telemetryCommands,
  telemetryExcludedCommands,
  telemetryStorageFields,
  type TelemetryStorageRecord
} from '../../../src/telemetry/contract.js';
import releasedClient from './fixtures/released-client-v0.12.3.json';

const validEvent = {
  schemaVersion: 1,
  event: 'command_executed',
  command: 'infra:plan',
  cliVersion: '0.6.1',
  outcome: 'success'
};

function request(
  body: string,
  options: {
    method?: string;
    contentType?: string;
    contentLength?: string;
  } = {}
): TelemetryHttpRequest {
  const headers = new Headers();
  if (options.contentType !== null) {
    headers.set('content-type', options.contentType ?? 'application/json');
  }
  if (options.contentLength) {
    headers.set('content-length', options.contentLength);
  }
  return {
    method: options.method ?? 'POST',
    headers,
    body: {
      async *[Symbol.asyncIterator]() {
        yield body;
      }
    }
  };
}

function dependencies(): TelemetryIngestionDependencies & {
  upload: ReturnType<typeof vi.fn<(record: TelemetryStorageRecord) => Promise<void>>>;
} {
  return {
    now: () => new Date('2026-07-26T00:00:00.000Z'),
    upload: vi.fn<(record: TelemetryStorageRecord) => Promise<void>>().mockResolvedValue(undefined)
  };
}

describe('telemetry ingestion handler', () => {
  it.each(releasedClient.commands)('retains the released v0.12.3 %s event without a schema migration', async (command) => {
    for (const outcome of ['success', 'failure']) {
      const deps = dependencies();
      const event = {
        schemaVersion: releasedClient.schemaVersion,
        event: releasedClient.event,
        command,
        cliVersion: releasedClient.cliVersion,
        outcome
      };
      expect(await handleTelemetryRequest(request(JSON.stringify(event)), deps)).toEqual({ status: 204 });
      expect(deps.upload).toHaveBeenCalledOnce();
      expect(deps.upload.mock.calls[0][0]).toEqual({
        TimeGenerated: '2026-07-26T00:00:00.000Z',
        EventName: event.event,
        SchemaVersion: event.schemaVersion,
        Command: command,
        CliVersion: event.cliVersion,
        Outcome: outcome
      });
    }
  });

  it.each(telemetryCommands)('admits only the exact five-field %s event into the existing six columns', async (command) => {
    const deps = dependencies();
    const event = { ...validEvent, command, cliVersion: '0.13.0', outcome: 'failure' };
    expect(await handleTelemetryRequest(request(JSON.stringify(event)), deps)).toEqual({ status: 204 });
    expect(deps.upload).toHaveBeenCalledOnce();
    const record = deps.upload.mock.calls[0][0];
    expect(Object.keys(record)).toEqual(telemetryStorageFields);
    expect(record).toMatchObject({ Command: command, CliVersion: '0.13.0', Outcome: 'failure' });
  });

  it.each([
    ...telemetryExcludedCommands,
    'assess:execute',
    'adopt:all',
    'skills:install-all',
    'installation:migrate:direct',
    'installation:inspect:/project'
  ])('rejects excluded or similarly named command %s', async (command) => {
    const deps = dependencies();
    expect(await handleTelemetryRequest(
      request(JSON.stringify({ ...validEvent, command })), deps
    )).toEqual({ status: 400 });
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it.each([
    'installationId', 'sessionId', 'owner', 'channel', 'path', 'profile', 'model',
    'prompt', 'response', 'planFingerprint', 'receiptId', 'artifactChecksum',
    'resourceId', 'duration', 'architecture', 'arguments'
  ])('never admits lifecycle detail %s, even when only a hash is supplied', async (field) => {
    const deps = dependencies();
    expect(await handleTelemetryRequest(
      request(JSON.stringify({ ...validEvent, [field]: 'a'.repeat(64) })), deps
    )).toEqual({ status: 400 });
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it('accepts an exact event and uploads exactly six approved columns', async () => {
    const deps = dependencies();
    const response = await handleTelemetryRequest(request(JSON.stringify(validEvent)), deps);
    expect(response).toEqual({ status: 204 });
    expect(deps.upload).toHaveBeenCalledOnce();
    const record = deps.upload.mock.calls[0][0];
    expect(record).toEqual({
      TimeGenerated: '2026-07-26T00:00:00.000Z',
      EventName: 'command_executed',
      SchemaVersion: 1,
      Command: 'infra:plan',
      CliVersion: '0.6.1',
      Outcome: 'success'
    });

    expect(Object.keys(record)).toEqual(telemetryStorageFields);
  });

  it('accepts the canonical aggregate upgrade command', async () => {
    const deps = dependencies();
    const response = await handleTelemetryRequest(
      request(JSON.stringify({ ...validEvent, command: 'upgrade' })),
      deps
    );
    expect(response).toEqual({ status: 204 });
    expect(deps.upload.mock.calls[0][0]).toMatchObject({
      Command: 'upgrade'
    });
  });

  it.each([
    ['array', []],
    ['missing field', { ...validEvent, outcome: undefined }],
    ['extra field', { ...validEvent, anonymousId: 'identifier' }],
    ['schema', { ...validEvent, schemaVersion: 2 }],
    ['event', { ...validEvent, event: 'other' }],
    ['command', { ...validEvent, command: 'init:/private/project' }],
    ['version', { ...validEvent, cliVersion: '/private/project' }],
    ['build metadata identifier', { ...validEvent, cliVersion: '0.6.1+install-550e8400-e29b-41d4-a716-446655440000' }],
    ['unbounded prerelease', { ...validEvent, cliVersion: '0.6.1-preview.private' }],
    ['leading-zero prerelease version', { ...validEvent, cliVersion: '1.0.0-01' }],
    ['outcome', { ...validEvent, outcome: 'cancelled' }]
  ])('rejects invalid %s payloads', async (_name, value) => {
    const deps = dependencies();
    const response = await handleTelemetryRequest(request(JSON.stringify(value)), deps);
    expect(response).toEqual({ status: 400 });
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON without uploading', async () => {
    const deps = dependencies();
    expect(await handleTelemetryRequest(request('{invalid'), deps)).toEqual({ status: 400 });
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it('rejects wrong methods and content types', async () => {
    const deps = dependencies();
    expect(await handleTelemetryRequest(request('{}', { method: 'GET' }), deps)).toEqual({ status: 405 });
    expect(await handleTelemetryRequest(request('{}', { contentType: 'text/plain' }), deps)).toEqual({ status: 415 });
    expect(await handleTelemetryRequest(request('{}', { contentType: 'application/jsonx' }), deps)).toEqual({ status: 415 });
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it('rejects declared and observed oversized bodies', async () => {
    const deps = dependencies();
    expect(await handleTelemetryRequest(request('{}', {
      contentLength: String(maximumTelemetryBodyBytes + 1)
    }), deps)).toEqual({ status: 413 });
    expect(await handleTelemetryRequest(request('x'.repeat(maximumTelemetryBodyBytes + 1)), deps)).toEqual({ status: 413 });
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it('stops reading a streamed body as soon as the byte limit is exceeded', async () => {
    const deps = dependencies();
    let chunksRead = 0;
    const streamedRequest = request('{}');
    streamedRequest.body = {
      async *[Symbol.asyncIterator]() {
        chunksRead += 1;
        yield new Uint8Array(maximumTelemetryBodyBytes);
        chunksRead += 1;
        yield new Uint8Array(1);
        chunksRead += 1;
        yield new Uint8Array(1);
      }
    };

    expect(await handleTelemetryRequest(streamedRequest, deps)).toEqual({ status: 413 });
    expect(chunksRead).toBe(2);
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it('returns unavailable without exposing ingestion failures', async () => {
    const deps = dependencies();
    deps.upload.mockRejectedValueOnce(new Error('Azure credential detail'));
    expect(await handleTelemetryRequest(request(JSON.stringify(validEvent)), deps)).toEqual({ status: 503 });
  });

  it('validates the exact object shape independently', () => {
    expect(parseTelemetryEvent(validEvent)).toEqual(validEvent);
    expect(parseTelemetryEvent({ ...validEvent, path: '/secret' })).toBeUndefined();
  });

  it('requires HTTPS and every managed-identity ingestion setting', () => {
    expect(azureMonitorScope).toBe('https://monitor.azure.com/.default');
    expect(readAzureTelemetryIngestionConfig({
      TELEMETRY_DCE_ENDPOINT: 'https://example.ingest.monitor.azure.com',
      TELEMETRY_DCR_IMMUTABLE_ID: 'dcr-123',
      TELEMETRY_STREAM_NAME: 'Custom-LiftoffCommandEvents',
      AZURE_CLIENT_ID: 'client-id'
    })).toEqual({
      endpoint: 'https://example.ingest.monitor.azure.com',
      dcrImmutableId: 'dcr-123',
      streamName: 'Custom-LiftoffCommandEvents',
      managedIdentityClientId: 'client-id'
    });
    expect(() => readAzureTelemetryIngestionConfig({
      TELEMETRY_DCE_ENDPOINT: 'http://example.test',
      TELEMETRY_DCR_IMMUTABLE_ID: 'dcr-123',
      TELEMETRY_STREAM_NAME: 'Custom-LiftoffCommandEvents',
      AZURE_CLIENT_ID: 'client-id'
    })).toThrow(/HTTPS/);
    expect(() => readAzureTelemetryIngestionConfig({})).toThrow(/TELEMETRY_DCE_ENDPOINT/);
  });
});
