import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { executeApplicationPrivateExecution, planApplicationPrivateExecution } from './application-private-execution.js';

export { inspectApplicationPrerequisiteResources, type PlannedApplicationResourceInventory } from '../../adapters/azure/application-provisioning.js';

export const applicationPrerequisitesInterfaceBlocker =
  'a registered prerequisite-only resource plan with private-backend custody/locking, exact registry/workload/build identities, ' +
  'approved scoped RBAC effects and per-effect recovery; registry and role metadata alone do not establish that plan or private execution';

export function planApplicationPrerequisites(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  return planApplicationPrivateExecution(input);
}

export async function executeApplicationPrerequisites(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  return executeApplicationPrivateExecution(input);
}
