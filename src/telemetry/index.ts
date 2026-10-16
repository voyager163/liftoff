import type { ParsedArgs } from '../domain/project/contracts.js';
import {
  canonicalTelemetryCommand,
  createTelemetryEvent,
  telemetryNoticeVersion,
  type TelemetryCommand,
  type TelemetryCommandEvent
} from './contract.js';
import {
  readTelemetryNoticeVersion,
  recordTelemetryNotice,
  type TelemetryConfigOptions
} from './config.js';
import {
  createTelemetryDelivery, isTelemetryEnabled, maximumTelemetryDeliveryMs, telemetryDisabledResult,
  type TelemetryDelivery, type TelemetryDeliveryResult, type TelemetryFetch
} from './delivery.js';
export { isTelemetryEnabled } from './delivery.js';
export type { TelemetryFetch } from './delivery.js';

export const productionTelemetryEndpoint =
  'https://ca-liftoff-telemetry-f5be1618.politetree-7a65ae27.koreacentral.azurecontainerapps.io/api/events';
export const telemetryRequestTimeoutMs = maximumTelemetryDeliveryMs;
export const telemetryNotice =
  'Telemetry: Liftoff sends command name, CLI version, and semantic outcome with no persistent identifier. ' +
  'Opt out with LIFTOFF_TELEMETRY=0 or DO_NOT_TRACK=1.\n';

export interface TelemetryRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  endpoint?: string;
  fetch?: TelemetryFetch;
  timeoutMs?: number;
  config?: TelemetryConfigOptions;
  stderr?: NodeJS.WritableStream;
  delivery?: TelemetryDelivery;
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
    const config = { ...options.config, env: options.config?.env ?? options.env };
    const seenVersion = await readTelemetryNoticeVersion(config);
    if (seenVersion !== undefined && seenVersion >= telemetryNoticeVersion) {
      return true;
    }
    if (!(await writeTelemetryNotice(options.stderr ?? process.stderr))) {
      return false;
    }
    await recordTelemetryNotice(config);
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

  await reportCommandEvent(createTelemetryEvent(command, cliVersion, exitCode), options).catch(() => undefined);
}

export async function reportCommandEvent(
  event: TelemetryCommandEvent,
  options: TelemetryRuntimeOptions = {}
): Promise<TelemetryDeliveryResult> {
  const disabled = telemetryDisabledResult(options.env);
  if (disabled) return disabled;

  const endpoint = options.endpoint ?? productionTelemetryEndpoint;
  const delivery = options.delivery ?? createTelemetryDelivery({
    env: options.env, fetch: options.fetch, timeoutMs: options.timeoutMs
  });
  try {
    const result = await delivery.deliver({ command: { endpoint, event } });
    if (!result.command) {
      throw new Error('Command telemetry delivery did not return its requested result.');
    }
    return result.command;
  } finally {
    if (!options.delivery) delivery.close();
  }
}
