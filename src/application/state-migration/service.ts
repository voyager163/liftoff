import type {
  RetainedStateKeyProvider, StateMigrationDependencies, StateMigrationService
} from '../../domain/repair/stateful.js';
import {
  observeStateMetadata, inspectApprovedState, buildStateMigrationPlan, validateStateMigrationPlan
} from './planning.js';
import { executeStateMigration } from './execution.js';
import { buildStateRecoveryPlan, executeStateRecovery, inspectStateMigration } from './recovery.js';
import { buildStateDisposalPlan, disposeRetainedState } from './lifecycle.js';

export function createStateMigrationService(
  dependencies: StateMigrationDependencies,
  retainedKeys?: RetainedStateKeyProvider
): StateMigrationService {
  return Object.freeze<StateMigrationService>({
    workspaceRef: dependencies.workspace.workspaceRef,
    observeMetadata: (request) => observeStateMetadata(dependencies, request),
    inspect: (request) => inspectApprovedState(dependencies, request),
    plan: (request) => buildStateMigrationPlan(dependencies, request),
    validate: (request) => validateStateMigrationPlan(dependencies, request),
    execute: (request) => executeStateMigration(dependencies, request),
    inspectOperation: (request) => inspectStateMigration(dependencies, request),
    planRecovery: (request) => buildStateRecoveryPlan(dependencies, request),
    recover: (request) => executeStateRecovery(dependencies, request),
    planDisposal: (request) => buildStateDisposalPlan(dependencies, request, retainedKeys),
    dispose: (request) => disposeRetainedState(dependencies, request, retainedKeys)
  });
}
