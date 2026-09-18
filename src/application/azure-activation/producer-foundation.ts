import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { executeApplicationPrivateExecution, planApplicationPrivateExecution } from './application-private-execution.js';

export { inspectApplicationFoundationResources, type PlannedApplicationResourceInventory } from '../../adapters/azure/application-provisioning.js';

export const applicationFoundationInterfaceBlocker =
  'a registered resource-changing OpenTofu plan executor bound to the exact private backend, qualified workspace, ' +
  'saved-plan bytes, immutable application artifact, owned resource inventory and per-effect recovery; ' +
  'the released state-only driver forbids resource changes and cannot be reused as deployment authority';

export function planApplicationFoundation(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  return planApplicationPrivateExecution(input);
}

export async function executeApplicationFoundation(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  return executeApplicationPrivateExecution(input);
}
