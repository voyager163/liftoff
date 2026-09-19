import {
  canonicalEngines,
  engineIds,
  engineOwners,
  type EngineDescriptor,
  type EngineId,
  type EngineOwner
} from '../domain/execution/engines.js';
import {
  validatePublicCapabilitiesEnvelope,
  type PublicCapabilitiesEnvelopeV1,
  type PublicCapabilityV1
} from '../protocol/capabilities.js';
import { liftoffVersion } from '../version.js';
import { standardsAssessmentCapabilities } from './standards-assessment/capabilities.js';
import { projectGenerationCapabilities } from './project-generation/capabilities.js';
import { projectEvolutionCapabilities } from './project-evolution/capabilities.js';
import { repositoryGovernanceCapabilities } from './repository-governance/capabilities.js';
import { azureActivationCapabilities } from './azure-activation/capabilities.js';
import { distributionCapabilities } from './distribution/capabilities.js';
import type { CommandContext, ExecutionContext } from './context.js';
import type { PresentationSession } from '../terminal.js';

export interface ApplicationEngines {
  readonly 'standards-assessment': typeof import('./standards-assessment/index.js').standardsAssessmentRuntime;
  readonly 'project-generation': typeof import('./project-generation/index.js').projectGenerationRuntime;
  readonly 'project-evolution': typeof import('./project-evolution/index.js').projectEvolutionRuntime;
  readonly 'repository-governance': typeof import('./repository-governance/index.js').repositoryGovernanceRuntime;
  readonly 'azure-activation': typeof import('./azure-activation/index.js').azureActivationRuntime;
  readonly distribution: typeof import('./distribution/index.js').distributionRuntime;
}

let composedEngines: Promise<ApplicationEngines> | undefined;

export function composeApplicationEngines(): Promise<ApplicationEngines> {
  // Capability inspection must not initialize operational modules or their dependencies.
  composedEngines ??= Promise.all([
    import('./standards-assessment/index.js'),
    import('./project-generation/index.js'),
    import('./project-evolution/index.js'),
    import('./repository-governance/index.js'),
    import('./azure-activation/index.js'),
    import('./distribution/index.js')
  ]).then(([standards, generation, evolution, repository, azure, distribution]) => Object.freeze({
    'standards-assessment': standards.standardsAssessmentRuntime,
    'project-generation': generation.projectGenerationRuntime,
    'project-evolution': evolution.projectEvolutionRuntime,
    'repository-governance': repository.repositoryGovernanceRuntime,
    'azure-activation': azure.azureActivationRuntime,
    distribution: distribution.distributionRuntime
  }));
  return composedEngines;
}

export function getApplicationEngines(context: Pick<ExecutionContext, 'engines'>): Promise<ApplicationEngines> {
  return context.engines ? Promise.resolve(context.engines) : composeApplicationEngines();
}

export async function composeExecutionContext(
  context: CommandContext, presentation: PresentationSession
): Promise<ExecutionContext> {
  const engines = await composeApplicationEngines();
  const adapters = {
    ...context.adapters,
    providerEngines: {
      repositoryGovernance: engines['repository-governance'],
      azureActivation: engines['azure-activation']
    }
  };
  return {
    ...context, presentation, engines, adapters,
    storage: context.storage ?? context.updatePreview
  };
}

export const allRegisteredCapabilities: readonly PublicCapabilityV1[] = [
  ...standardsAssessmentCapabilities,
  ...projectGenerationCapabilities,
  ...projectEvolutionCapabilities,
  ...repositoryGovernanceCapabilities,
  ...azureActivationCapabilities,
  ...distributionCapabilities
];

import { phaseCapabilities, type PhaseCapability } from '../domain/governance/activation/capabilities.js';
import type { PhaseId } from '../domain/governance/activation/types.js';

export { phaseCapabilities };
export type { PhaseCapability, PhaseId };

export function getRegisteredEngines(): readonly EngineDescriptor[] {
  return engineIds.map((id) => canonicalEngines[id]);
}

export function getRegisteredCapabilities(): readonly PublicCapabilityV1[] {
  return allRegisteredCapabilities;
}

export function resolveCapability(id: string): PublicCapabilityV1 | undefined {
  return allRegisteredCapabilities.find((cap) => cap.id === id);
}

export function resolveEngine(id: EngineId): EngineDescriptor | undefined {
  return canonicalEngines[id];
}

export function buildPublicCapabilitiesEnvelope(): PublicCapabilitiesEnvelopeV1 {
  const envelope: PublicCapabilitiesEnvelopeV1 = {
    schemaVersion: 1,
    kind: 'liftoff-public-capabilities',
    cliVersion: liftoffVersion,
    capabilities: allRegisteredCapabilities,
    engines: getRegisteredEngines()
  };
  return validatePublicCapabilitiesEnvelope(envelope);
}
