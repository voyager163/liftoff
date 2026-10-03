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
  telemetryStorageFields,
  type TelemetryStorageRecord
} from '../../../src/telemetry/contract.js';
import { recordingDependencies, streamedRequest, validRecord } from './support/fixtures.js';

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
    ['future schema', { ...validEvent, schemaVersion: 3 }],
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

const encoder = new TextEncoder();
const validJson = JSON.stringify(validEvent);

function paddedTo(json: string, totalBytes: number): string {
  return json + ' '.repeat(totalBytes - encoder.encode(json).byteLength);
}

describe('telemetry ingestion handler request contract', () => {
  it.each(['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'TRACE'])(
    'rejects %s before reading the body',
    async (method) => {
      const deps = recordingDependencies();
      const incoming = streamedRequest([validJson], { method });
      expect(await handleTelemetryRequest(incoming, deps)).toEqual({ status: 405 });
      expect(incoming.chunksPulled).toBe(0);
      expect(deps.upload).not.toHaveBeenCalled();
    }
  );

  it('accepts POST regardless of method letter case', async () => {
    const deps = recordingDependencies();
    expect(await handleTelemetryRequest(streamedRequest([validJson], { method: 'post' }), deps))
      .toEqual({ status: 204 });
    expect(deps.upload).toHaveBeenCalledWith(validRecord);
  });

  it.each([
    ['a missing', null],
    ['an empty', ''],
    ['a text', 'text/plain'],
    ['a JSON-suffixed', 'application/problem+json'],
    ['a non-standard JSON', 'text/json'],
    ['a combined', 'application/json, text/plain'],
    ['a parameter-smuggled', 'multipart/form-data; boundary=application/json']
  ])('rejects %s content type before reading the body', async (_name, contentType) => {
    const deps = recordingDependencies();
    const incoming = streamedRequest([validJson], { contentType });
    expect(await handleTelemetryRequest(incoming, deps)).toEqual({ status: 415 });
    expect(incoming.chunksPulled).toBe(0);
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it.each(['application/json; charset=utf-8', 'APPLICATION/JSON', 'Application/Json ; charset=UTF-8'])(
    'accepts the JSON media type %s',
    async (contentType) => {
      const deps = recordingDependencies();
      expect(await handleTelemetryRequest(streamedRequest([validJson], { contentType }), deps))
        .toEqual({ status: 204 });
      expect(deps.upload).toHaveBeenCalledWith(validRecord);
    }
  );

  it('rejects a declared oversized body without reading it', async () => {
    const deps = recordingDependencies();
    const incoming = streamedRequest([validJson], {
      contentLength: String(maximumTelemetryBodyBytes + 1)
    });
    expect(await handleTelemetryRequest(incoming, deps)).toEqual({ status: 413 });
    expect(incoming.chunksPulled).toBe(0);
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it('accepts exactly the byte limit and rejects one more byte of otherwise valid JSON', async () => {
    const deps = recordingDependencies();
    const atLimit = paddedTo(validJson, maximumTelemetryBodyBytes);
    expect(encoder.encode(atLimit).byteLength).toBe(1_024);
    expect(await handleTelemetryRequest(streamedRequest([atLimit], { contentLength: '1024' }), deps))
      .toEqual({ status: 204 });
    expect(await handleTelemetryRequest(
      streamedRequest([paddedTo(validJson, maximumTelemetryBodyBytes + 1)]),
      deps
    )).toEqual({ status: 413 });
    expect(deps.upload).toHaveBeenCalledOnce();
  });

  it.each([
    ['understated', '10'],
    ['non-numeric', 'abc'],
    ['negative', '-1'],
    ['beyond safe integers', '9007199254740993']
  ])('keeps counting streamed bytes when the declared length is %s', async (_name, contentLength) => {
    const deps = recordingDependencies();
    expect(await handleTelemetryRequest(
      streamedRequest([paddedTo(validJson, maximumTelemetryBodyBytes + 1)], { contentLength }),
      deps
    )).toEqual({ status: 413 });
    expect(await handleTelemetryRequest(streamedRequest([validJson], { contentLength }), deps))
      .toEqual({ status: 204 });
    expect(deps.upload).toHaveBeenCalledOnce();
  });

  it('reassembles a byte-at-a-time stream', async () => {
    const deps = recordingDependencies();
    const chunks = Array.from(encoder.encode(validJson), (byte) => Uint8Array.of(byte));
    expect(await handleTelemetryRequest(streamedRequest(chunks), deps)).toEqual({ status: 204 });
    expect(deps.upload).toHaveBeenCalledWith(validRecord);
  });

  it.each([
    ['invalid UTF-8', [Uint8Array.of(0x7b, 0xff, 0x7d)]],
    ['truncated UTF-8', [encoder.encode('{"event":"'), Uint8Array.of(0xe2, 0x82)]],
    ['a non-byte chunk', [{ schemaVersion: 1 }]],
    ['a numeric chunk', [42]]
  ])('rejects %s as malformed without uploading', async (_name, chunks) => {
    const deps = recordingDependencies();
    expect(await handleTelemetryRequest(streamedRequest(chunks), deps)).toEqual({ status: 400 });
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it('treats a failing body stream as malformed without uploading', async () => {
    const deps = recordingDependencies();
    const aborted: TelemetryHttpRequest = {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: {
        async *[Symbol.asyncIterator]() {
          yield '{"schemaVersion":';
          throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
        }
      }
    };
    expect(await handleTelemetryRequest(aborted, deps)).toEqual({ status: 400 });
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it.each([
    ['null', 'null'],
    ['number', '1'],
    ['string', '"command_executed"'],
    ['boolean', 'true'],
    ['empty', ''],
    ['whitespace-only', ' \n\t ']
  ])('rejects a %s JSON document', async (_name, body) => {
    const deps = recordingDependencies();
    expect(await handleTelemetryRequest(streamedRequest([body]), deps)).toEqual({ status: 400 });
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it.each([
    ['a prototype key in place of a field', validJson.replace('"outcome"', '"__proto__"')],
    ['a constructor key in place of a field', validJson.replace('"outcome"', '"constructor"')],
    ['a string schema version', JSON.stringify({ ...validEvent, schemaVersion: '1' })],
    ['a numeric command', JSON.stringify({ ...validEvent, command: 1 })],
    ['an object command', JSON.stringify({ ...validEvent, command: { name: 'infra:plan' } })],
    ['a numeric version', JSON.stringify({ ...validEvent, cliVersion: 6 })],
    ['a null outcome', JSON.stringify({ ...validEvent, outcome: null })],
    ['an assessment command', JSON.stringify({ ...validEvent, command: 'governance:assess' })],
    ['a raw help flag', JSON.stringify({ ...validEvent, command: '--help' })]
  ])('rejects %s without uploading', async (_name, body) => {
    const deps = recordingDependencies();
    expect(await handleTelemetryRequest(streamedRequest([body]), deps)).toEqual({ status: 400 });
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it('records failure outcomes exactly', async () => {
    const deps = recordingDependencies();
    expect(await handleTelemetryRequest(
      streamedRequest([JSON.stringify({ ...validEvent, outcome: 'failure' })]),
      deps
    )).toEqual({ status: 204 });
    expect(deps.upload).toHaveBeenCalledWith({ ...validRecord, Outcome: 'failure' });
  });

  it('answers 503 without uploading when the server clock cannot stamp a record', async () => {
    const upload = vi.fn<(record: TelemetryStorageRecord) => Promise<void>>().mockResolvedValue(undefined);
    const clocks = [
      () => {
        throw new Error('Clock unavailable.');
      },
      () => new Date(Number.NaN)
    ];
    for (const now of clocks) {
      expect(await handleTelemetryRequest(streamedRequest([validJson]), { now, upload }))
        .toEqual({ status: 503 });
    }
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('telemetry ingestion configuration', () => {
  const completeEnvironment = {
    TELEMETRY_DCE_ENDPOINT: 'https://example.ingest.monitor.azure.com',
    TELEMETRY_DCR_IMMUTABLE_ID: 'dcr-123',
    TELEMETRY_STREAM_NAME: 'Custom-LiftoffCommandEvents',
    AZURE_CLIENT_ID: 'client-id'
  };

  it.each(Object.keys(completeEnvironment).flatMap((name) => [
    [name, undefined],
    [name, ' \t ']
  ]))('requires %s (received %j)', (name, value) => {
    expect(() => readAzureTelemetryIngestionConfig({ ...completeEnvironment, [String(name)]: value }))
      .toThrow(`Missing required telemetry ingestion setting: ${name}`);
  });

  it('trims every setting and normalizes the endpoint origin', () => {
    expect(readAzureTelemetryIngestionConfig({
      TELEMETRY_DCE_ENDPOINT: '  https://Example.Ingest.Monitor.Azure.com/  ',
      TELEMETRY_DCR_IMMUTABLE_ID: ' dcr-123 ',
      TELEMETRY_STREAM_NAME: '\tCustom-LiftoffCommandEvents\n',
      AZURE_CLIENT_ID: ' client-id '
    })).toEqual({
      endpoint: 'https://example.ingest.monitor.azure.com',
      dcrImmutableId: 'dcr-123',
      streamName: 'Custom-LiftoffCommandEvents',
      managedIdentityClientId: 'client-id'
    });
  });

  it('keeps an endpoint path while removing its trailing slash', () => {
    expect(readAzureTelemetryIngestionConfig({
      ...completeEnvironment,
      TELEMETRY_DCE_ENDPOINT: 'https://example.ingest.monitor.azure.com/base/'
    }).endpoint).toBe('https://example.ingest.monitor.azure.com/base');
  });

  it.each([
    'http://example.ingest.monitor.azure.com',
    'ftp://example.ingest.monitor.azure.com',
    'file:///var/run/endpoint'
  ])('rejects the non-HTTPS endpoint %s without echoing it', (endpoint) => {
    expect(() => readAzureTelemetryIngestionConfig({
      ...completeEnvironment,
      TELEMETRY_DCE_ENDPOINT: endpoint
    })).toThrow(/^TELEMETRY_DCE_ENDPOINT must use HTTPS\.$/);
  });

  it('rejects an endpoint that is not an absolute URL', () => {
    let thrown: unknown;
    try {
      readAzureTelemetryIngestionConfig({
        ...completeEnvironment,
        TELEMETRY_DCE_ENDPOINT: 'example.ingest.monitor.azure.com'
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toMatchObject({ code: 'ERR_INVALID_URL' });
  });
});
