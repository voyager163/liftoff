import { DistributionError } from './errors.js';
import { digest, object, text } from './validation.js';

export interface NativeTransactionState {
  status: 'absent' | 'rolled-back' | 'committed' | 'blocked';
  committed: boolean;
  planFingerprint?: string;
  transactionDigest?: string;
  rollbackFailures: readonly string[];
  cleanupFailures: readonly string[];
}

export interface NativeInstallationTransactionOutcome extends NativeTransactionState {
  processSettlement: 'settled' | 'unconfirmed';
}

export function parseNativeTransactionOutcome(raw: unknown): NativeInstallationTransactionOutcome {
  const value = object(raw, [
    'status', 'committed', 'planFingerprint', 'transactionDigest', 'rollbackFailures', 'cleanupFailures', 'processSettlement'
  ], 'Native transaction outcome');
  const status = value.status;
  if ((status !== 'absent' && status !== 'rolled-back' && status !== 'committed' && status !== 'blocked') ||
      typeof value.committed !== 'boolean' || status === 'committed' && !value.committed ||
      (status === 'absent' || status === 'rolled-back') && value.committed ||
      (value.processSettlement !== 'settled' && value.processSettlement !== 'unconfirmed')) {
    throw new DistributionError('Native transaction outcome has inconsistent commit or settlement facts.', 'recovery_required');
  }
  const failures = (input: unknown): string[] => {
    if (!Array.isArray(input) || input.length > 128) throw new DistributionError('Native transaction failure inventory is invalid.', 'recovery_required');
    return input.map((failure) => text(failure, 'Native transaction failure', 4096));
  };
  return {
    status, committed: value.committed, processSettlement: value.processSettlement,
    rollbackFailures: failures(value.rollbackFailures), cleanupFailures: failures(value.cleanupFailures),
    ...(value.planFingerprint !== undefined ? { planFingerprint: digest(value.planFingerprint, 'Native transaction plan') } : {}),
    ...(value.transactionDigest !== undefined ? { transactionDigest: digest(value.transactionDigest, 'Native transaction identity') } : {})
  };
}

export function captureNativeTransactionOutcome(
  outcome: NativeTransactionState, processSettlement: 'settled' | 'unconfirmed'
): NativeInstallationTransactionOutcome {
  const bounded = (message: string): string => message.replace(/[\u0000-\u001f\u007f]+/gu, ' ').slice(0, 4096);
  return parseNativeTransactionOutcome({
    ...outcome, processSettlement,
    rollbackFailures: outcome.rollbackFailures.map(bounded),
    cleanupFailures: outcome.cleanupFailures.map(bounded)
  });
}
