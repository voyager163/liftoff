export const reviewedUpdateTransactionPathParts = ['.liftoff', 'reviewed-update-transaction.json'] as const;
export const reviewedRepairTransactionPathParts = ['.liftoff', 'reviewed-repair-transaction.json'] as const;
export const reviewedUpdateTransactionSchemaVersion = 1 as const;

export type ReviewedTransactionKind = 'update' | 'repair';
