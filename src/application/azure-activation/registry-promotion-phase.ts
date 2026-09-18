import { isRecord } from '../../domain/governance/activation/canonical-json.js';
import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import type { ApplicationRegistryCopyOptions } from '../../adapters/azure/application-registry-copy.js';
import {
  applicationRegistryPromotionProtocol, executeApplicationRegistryPromotion, planApplicationRegistryPromotion
} from './application-registry-promotion.js';

export function isRegistryPromotionPhase(input: PhasePlanningInput): boolean {
  if (!['staging-qualified', 'production-rehearsed'].includes(input.phase.id)) return false;
  const value = (input.inspection.activationInputs ?? input.inspection.state.activationInputs)?.phases[input.phase.id];
  return isRecord(value) && Object.keys(value).join(',') === 'registryPromotion';
}

export const planRegistryPromotionPhase = planApplicationRegistryPromotion;

export async function executeRegistryPromotionPhase(
  input: PhaseAdapterExecutionInput, options: ApplicationRegistryCopyOptions = {}
): Promise<PhaseAdapterOutcome> {
  const actual = await executeApplicationRegistryPromotion(input, options);
  if (actual.status === 'blocked') return {
    status: 'blocked', blocker: actual.blocker, completedOperations: actual.completedOperations,
    evidencePayload: { kind: 'application-registry-promotion-incomplete.v1', promotion: actual }
  };
  return {
    status: 'review-required', completedOperations: actual.completedOperations,
    blocker: 'The exact immutable role image is independently read back in its approved environment registry. Separately review deployment or rehearsal; promotion alone is not environment qualification.',
    review: { schemaVersion: 1, phaseId: input.phase.id, sourcePlanDigest: input.plan.planDigest, kind: 'application-private-plan',
      payload: { protocol: applicationRegistryPromotionProtocol, stage: 'environment-artifact-promoted', receipt: actual.receipt } }
  };
}
