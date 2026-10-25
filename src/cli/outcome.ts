/**
 * Every command ends in one of these outcomes, and each has a fixed exit code.
 * "attention" means the command worked and found something to act on (for
 * example differences or a required approval), which is not a failure.
 */
export const OUTCOMES = {
  success: 0,
  failure: 1,
  usage: 2,
  attention: 3,
  cancelled: 4,
  partial: 5,
  unsupported: 6,
} as const;

export type Outcome = keyof typeof OUTCOMES;
export type ExitCode = (typeof OUTCOMES)[Outcome];

export const exitCodeFor = (outcome: Outcome): ExitCode => OUTCOMES[outcome];

/** An error the user can fix by changing the command line. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** The person stopped the command, for example by pressing Ctrl+C at a question. */
export class CancelledError extends Error {
  override readonly name = "CancelledError";
}

/** A request for something this release does not support. */
export class UnsupportedError extends Error {
  override readonly name = "UnsupportedError";
}
