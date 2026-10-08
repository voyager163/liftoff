export const reviewedUpdateTransactionPathParts = ['.liftoff', 'reviewed-update-transaction.json'] as const;
export const reviewedRepairTransactionPathParts = ['.liftoff', 'reviewed-repair-transaction.json'] as const;
export const reviewedAdoptionTransactionPathParts = ['.liftoff', 'reviewed-adoption-transaction.json'] as const;
export const localVerificationTransactionPathParts = ['.liftoff', 'local-verification-transaction.json'] as const;
export const reviewedUpdateTransactionSchemaVersion = 1 as const;
export const localVerificationTransactionSchemaVersion = 3 as const;

export type ReviewedTransactionKind = 'update' | 'repair' | 'adoption' | 'local-verification';
