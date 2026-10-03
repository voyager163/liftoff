import { expect, vi } from 'vitest';
import type {
  TelemetryHttpRequest,
  TelemetryIngestionDependencies
} from '../../src/handler.js';
import type { TelemetryStorageRecord } from '../../../../src/telemetry/contract.js';

export const validEvent = {
  schemaVersion: 1,
  event: 'command_executed',
  command: 'infra:plan',
  cliVersion: '0.6.1',
  outcome: 'success'
} as const;

export const fixedNow = new Date('2026-07-26T00:00:00.000Z');

export const validRecord: TelemetryStorageRecord = {
  TimeGenerated: '2026-07-26T00:00:00.000Z',
  EventName: 'command_executed',
  SchemaVersion: 1,
  Command: 'infra:plan',
  CliVersion: '0.6.1',
  Outcome: 'success'
};

// The exact bytes the gateway writes for malformed HTTP before settling the socket.
export const badRequestResponse =
  'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

export type RecordingDependencies = TelemetryIngestionDependencies & {
  upload: ReturnType<typeof vi.fn<(record: TelemetryStorageRecord) => Promise<void>>>;
};

export function recordingDependencies(): RecordingDependencies {
  return {
    now: () => new Date(fixedNow),
    upload: vi.fn<(record: TelemetryStorageRecord) => Promise<void>>().mockResolvedValue(undefined)
  };
}

const consoleMethods = ['debug', 'error', 'info', 'log', 'trace', 'warn'] as const;

export function silenceConsole(): { expectNothingLogged(): void } {
  const spies = consoleMethods.map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined)
  );
  return {
    expectNothingLogged() {
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    }
  };
}

export interface StreamedRequest extends TelemetryHttpRequest {
  readonly chunksPulled: number;
}

export function streamedRequest(
  chunks: readonly unknown[],
  options: { method?: string; contentType?: string | null; contentLength?: string } = {}
): StreamedRequest {
  const headers = new Headers();
  if (options.contentType !== null) {
    headers.set('content-type', options.contentType ?? 'application/json');
  }
  if (options.contentLength !== undefined) {
    headers.set('content-length', options.contentLength);
  }
  let pulled = 0;
  return {
    method: options.method ?? 'POST',
    headers,
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          pulled += 1;
          yield chunk;
        }
      }
    },
    get chunksPulled() {
      return pulled;
    }
  };
}
