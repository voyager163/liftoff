import {
  inspectReviewedUpdateTransaction,
  recoverReviewedUpdateTransaction,
  type ReviewedUpdateRecoveryOptions,
  type ReviewedUpdateTransactionInspection
} from '../../adapters/filesystem/reviewed-update-transaction.js';

export type SupportedJournalKind = 'update' | 'repair';
export type UnifiedJournalInspection = ReviewedUpdateTransactionInspection & { kind: SupportedJournalKind };

function assertJournalKind(kind: SupportedJournalKind): void {
  if (kind !== 'update' && kind !== 'repair') throw new Error('Unsupported execution journal kind; only registered update and repair recovery is adapted here.');
}

export async function inspectExecutionJournal(
  projectRoot: string,
  kind: SupportedJournalKind,
  options: Omit<ReviewedUpdateRecoveryOptions, 'transactionKind' | 'skillsScope'> = {}
): Promise<UnifiedJournalInspection> {
  assertJournalKind(kind);
  // The released reader validates identity, exact bytes and external seals. A blocked
  // inspection stays blocked; English diagnostics are never interpreted as authority.
  return { ...await inspectReviewedUpdateTransaction(projectRoot, { ...options, transactionKind: kind }), kind };
}

export async function recoverExecutionJournal(
  projectRoot: string,
  kind: SupportedJournalKind,
  options: Omit<ReviewedUpdateRecoveryOptions, 'transactionKind' | 'skillsScope'> = {}
) {
  assertJournalKind(kind);
  // Recovery reopens and authenticates the original journal under its original lease.
  return recoverReviewedUpdateTransaction(projectRoot, { ...options, transactionKind: kind });
}
