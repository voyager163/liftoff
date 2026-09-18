import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome } from '../../governance-activation/transition-ports.js';

export function missingAzureProducer(
  input: PhaseAdapterExecutionInput, requiredProof: string
): PhaseAdapterOutcome {
  const operation = input.inspection.state.phases[input.phase.id]?.operation;
  return {
    status: 'blocked',
    blocker: `Implementation missing for ${input.phase.id}: ${requiredProof}. Provider metadata, configuration flags and mocked regression results cannot substitute for this proof.`,
    completedOperations: [],
    ...(operation ? { operation } : {})
  };
}
