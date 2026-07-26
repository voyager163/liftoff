import type { ParsedArgs } from '../types.js';
import {
  canonicalTelemetryCommand,
  createTelemetryEvent,
  telemetryNoticeVersion,
  type TelemetryCommand
} from './contract.js';
import {
  readTelemetryNoticeVersion,
  recordTelemetryNotice,
  type TelemetryConfigOptions
} from './config.js';

export const productionTelemetryEndpoint: string | undefined = undefined;
export const telemetryRequestTimeoutMs = 1_000;
export const telemetryNotice =
  'Telemetry: Liftoff sends command name, CLI version, and zero/nonzero outcome with no persistent identifier. ' +
  'Opt out with LIFTOFF_TELEMETRY=0 or DO_NOT_TRACK=1.\n';

export type TelemetryFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface TelemetryRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  endpoint?: string;
  fetch?: TelemetryFetch;
  timeoutMs?: number;
  config?: TelemetryConfigOptions;
  stderr?: NodeJS.WritableStream;
}

export function isTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.LIFTOFF_TELEMETRY !== '0' &&
    env.DO_NOT_TRACK !== '1' &&
    env.CI !== 'true'
  );
}

export function telemetryCommandFor(parsed: ParsedArgs): TelemetryCommand | undefined {
  return canonicalTelemetryCommand(parsed);
}

export async function maybeShowTelemetryNotice(
  options: TelemetryRuntimeOptions = {}
): Promise<boolean> {
  if (!isTelemetryEnabled(options.env)) {
    return false;
  }

  try {
    const seenVersion = await readTelemetryNoticeVersion(options.config);
    if (seenVersion !== undefined && seenVersion >= telemetryNoticeVersion) {
      return true;
    }
    if (!(await writeTelemetryNotice(options.stderr ?? process.stderr))) {
      return false;
    }
    await recordTelemetryNotice(options.config);
    return true;
  } catch {
    // Telemetry disclosure state must never affect command execution.
    return false;
  }
}

function writeTelemetryNotice(stderr: NodeJS.WritableStream): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (success: boolean, awaitErrorEvent = false): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (!awaitErrorEvent) {
        stderr.removeListener('error', onError);
      }
      resolve(success);
    };
    const onError = (): void => {
      finish(false);
    };

    stderr.once('error', onError);
    try {
      stderr.write(telemetryNotice, (error?: Error | null) => {
        finish(error == null, error != null);
      });
    } catch {
      finish(false);
    }
  });
}

export async function trackCommand(
  command: TelemetryCommand,
  cliVersion: string,
  exitCode: number,
  options: TelemetryRuntimeOptions = {}
): Promise<void> {
  if (!isTelemetryEnabled(options.env)) {
    return;
  }

  const endpoint = options.endpoint ?? productionTelemetryEndpoint;
  if (!endpoint) {
    return;
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return;
  }
  if (url.protocol !== 'https:') {
    return;
  }

  const fetchTelemetry = options.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const response = await fetchTelemetry(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createTelemetryEvent(command, cliVersion, exitCode)),
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? telemetryRequestTimeoutMs)
    });
    if (!response.ok) {
      return;
    }
  } catch {
    // Delivery is deliberately best-effort and never retried or persisted.
  }
}
