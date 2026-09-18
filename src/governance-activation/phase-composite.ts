import type { PhaseId } from '../domain/governance/activation/types.js';
import {
  executeApplicationArtifactReady, planApplicationArtifactReady
} from '../application/azure-activation/producer-artifact.js';
import {
  executePrivateBackendProof, planPrivateBackendProof
} from '../application/azure-activation/private-backend-proof.js';
import { executeProductionDevProof, planProductionDevProof } from '../application/azure-activation/producer-dev-proof.js';
import { applicationRehearsalProducer } from '../application/azure-activation/application-rehearsal-default.js';
import { executeProductionStaging, planProductionStaging } from '../application/azure-activation/producer-staging-qualification.js';
import { fullProductionChecksProducer } from '../application/azure-activation/producer-full-checks.js';
import { planApplicationArtifactSetReady } from '../application/azure-activation/application-artifact-set.js';
import { executeApplicationArtifactSetReady } from '../application/azure-activation/application-artifact-set-execution.js';
import { isRegistryPromotionPhase, planRegistryPromotionPhase, executeRegistryPromotionPhase } from '../application/azure-activation/registry-promotion-phase.js';
import type {
  PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput
} from './transition-ports.js';

interface CompositePhaseProducer {
  plan(input: PhasePlanningInput): PhasePlanBuild | Promise<PhasePlanBuild>;
  execute(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome>;
}

function artifactSetMode(input: PhasePlanningInput): boolean {
  return (input.inspection.activationInputs ?? input.inspection.state.activationInputs)
    ?.phases['application-artifact-ready']?.mode === 'artifact-set';
}

const compositeProducers: Partial<Record<PhaseId, CompositePhaseProducer>> = {
  'private-backend-proof': { plan: planPrivateBackendProof, execute: executePrivateBackendProof },
  'application-artifact-ready': {
    plan: (input) => artifactSetMode(input) ? planApplicationArtifactSetReady(input) : planApplicationArtifactReady(input),
    execute: (input) => artifactSetMode(input) ? executeApplicationArtifactSetReady(input) : executeApplicationArtifactReady(input)
  },
  'dev-proof': { plan: planProductionDevProof, execute: executeProductionDevProof },
  'production-rehearsed': applicationRehearsalProducer,
  'staging-qualified': { plan: planProductionStaging, execute: executeProductionStaging },
  'green-red-proof': fullProductionChecksProducer
};

export async function planCompositePhase(input: PhasePlanningInput): Promise<PhasePlanBuild | null> {
  if ((input.inspection.scope ?? 'activation') !== 'activation') return null;
  if (isRegistryPromotionPhase(input)) return planRegistryPromotionPhase(input);
  return await compositeProducers[input.phase.id]?.plan(input) ?? null;
}

export async function executeCompositePhase(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null> {
  if ((input.inspection.scope ?? 'activation') !== 'activation') return null;
  if (isRegistryPromotionPhase(input)) return executeRegistryPromotionPhase(input);
  return await compositeProducers[input.phase.id]?.execute(input) ?? null;
}
