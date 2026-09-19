import { inspectInstallation } from './inspect-installation.js';
import { planInstallationMigration } from './plan-migration.js';
import { executeInstallationMigration } from './execute-migration.js';
import { inspectMigrationRecovery } from './recover-migration.js';
import { upgradeLiftoff } from '../upgrade/use-case.js';
import { executeSkillsUseCase } from '../skills/use-case.js';
import { distributionEngine } from './capabilities.js';

export const distributionRuntime = Object.freeze({
  descriptor: distributionEngine,
  inspectInstallation,
  planInstallationMigration,
  executeInstallationMigration,
  inspectMigrationRecovery,
  upgradeLiftoff,
  executeSkillsUseCase
});

export * from './inspect-installation.js';
export * from './plan-migration.js';
export * from './execute-migration.js';
export * from './recover-migration.js';
export * from './native-upgrade.js';
export * from './capabilities.js';
export * from './approval.js';
export * from './target-resolution.js';
export * from './continuations.js';
