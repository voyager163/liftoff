export const reviewedUpdateTransactionPathParts = ['.liftoff', 'reviewed-update-transaction.json'] as const;
export const reviewedRepairTransactionPathParts = ['.liftoff', 'reviewed-repair-transaction.json'] as const;
export const reviewedAdoptionTransactionPathParts = ['.liftoff', 'reviewed-adoption-transaction.json'] as const;
export const workflowTransitionTransactionPathParts = ['.liftoff', 'workflow-transition-transaction.json'] as const;
export const profileTransitionTransactionPathParts = ['.liftoff', 'profile-transition-transaction.json'] as const;
export const localVerificationTransactionPathParts = ['.liftoff', 'local-verification-transaction.json'] as const;
export const reviewedUpdateTransactionSchemaVersion = 1 as const;
export const localVerificationTransactionSchemaVersion = 3 as const;

export type ReviewedTransactionKind =
  | 'update'
  | 'repair'
  | 'adoption'
  | 'workflow-transition'
  | 'profile-transition'
  | 'local-verification';
