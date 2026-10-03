import { isTelemetrySemanticOutcome, type TelemetrySemanticOutcome } from '../telemetry/contract.js';

export interface CommandOutcome {
  record(outcome: TelemetrySemanticOutcome): void;
}

export function createCommandOutcome(): CommandOutcome & { finish(exitCode: number): TelemetrySemanticOutcome } {
  let observed: TelemetrySemanticOutcome | undefined;
  let completed: TelemetrySemanticOutcome | undefined;
  return Object.freeze({
    record(outcome: TelemetrySemanticOutcome) {
      if (!isTelemetrySemanticOutcome(outcome)) throw new TypeError('Invalid semantic command outcome.');
      if (completed !== undefined || observed === 'failure') return;
      observed = outcome;
    },
    finish(exitCode: number) {
      if (completed !== undefined) return completed;
      completed = observed === 'failure' ? 'failure' :
        observed === 'attention-required' || observed === 'cancelled' ? observed :
          exitCode === 0 ? 'success' : 'failure';
      return completed;
    }
  });
}
