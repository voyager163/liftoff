import { runCli, type RunCliOptions } from '../../src/cli.js';

export const releasedTelemetryVersion = '0.12.3';

export function runReleasedTelemetryCli(options: RunCliOptions = {}): Promise<number> {
  return runCli({ ...options, telemetryReleaseVersion: releasedTelemetryVersion });
}
