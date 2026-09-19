export const reviewedUpdateTransactionPathParts = ['.liftoff', 'reviewed-update-transaction.json'] as const;
export const reviewedRepairTransactionPathParts = ['.liftoff', 'reviewed-repair-transaction.json'] as const;
export const reviewedAdoptionTransactionPathParts = ['.liftoff', 'reviewed-adoption-transaction.json'] as const;
export const reviewedSkillsTransactionPathParts = ['.liftoff', 'reviewed-skills-transaction.json'] as const;
export const reviewedInstallationTransactionPathParts = ['.liftoff', 'reviewed-installation-transaction.json'] as const;
export const reviewedUpdateTransactionSchemaVersion = 1 as const;

export type ReviewedTransactionKind = 'update' | 'repair' | 'adoption' | 'skills' | 'installation';
