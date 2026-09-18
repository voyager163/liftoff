import type {
  PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput
} from '../../governance-activation/transition-ports.js';
import { validateAzureBindings } from '../../adapters/azure/production-adapter.js';
import { resolveAzureInputs } from './producer-discovery.js';
import { blockedQualificationOutcome } from './qualification-checkpoints.js';
import { environmentQualificationScopeBlocker } from './qualification-authority.js';
import { planProductionDevProof } from './producer-dev-proof.js';
import { planProductionStaging } from './producer-staging-qualification.js';
import { fullProductionChecksProducer } from './producer-full-checks.js';
import {
  executeProductionRehearsalProducer, planProductionRehearsalProducer, productionRehearsalInterfaceBlocker
} from './rehearsal-recipe.js';
import {
  executeDevProofProducer, executeStagingQualificationProducer, executeGreenRedProofProducer,
  devQualificationInterfaceBlocker, stagingQualificationInterfaceBlocker, greenRedQualificationInterfaceBlocker
} from './environment-workflow-qualification.js';

export {
  disposableTargetConfig, configuredDisposableTarget, requireDisposableQualificationAuthority,
  validateOperatorQualificationAuthority, type DisposableTargetConfig, type DisposableQualificationAuthority,
  type OperatorQualificationAuthorityValidation
} from './qualification-authority.js';
export { readQualificationCheckpoints, qualificationOperationFromCheckpoint } from './qualification-checkpoints.js';
export { requireQualificationEvidence, type QualificationEvidenceReference } from './qualification-evidence.js';
export { readEnvironmentRuntimeProof, environmentRuntimeInputs, type EnvironmentRuntimeObservation } from './environment-runtime-proof.js';
export {
  renderEnvironmentRuntimeWorkflow, readEnvironmentRuntimeArchive, validateEnvironmentRuntimeReport
} from './environment-runtime-workflow.js';
export { executeProductionRehearsalProducer, verifyArtifactEquality, productionRehearsalInterfaceBlocker } from './rehearsal-recipe.js';
export {
  executeDevProofProducer, executeStagingQualificationProducer, executeGreenRedProofProducer,
  validateFullActivationProofReceipts, type FullActivationProofReferences,
  devQualificationInterfaceBlocker, stagingQualificationInterfaceBlocker, greenRedQualificationInterfaceBlocker
} from './environment-workflow-qualification.js';

export async function executeAzureQualificationPhase(
  input: PhaseAdapterExecutionInput, environment: 'staging' | 'prod'
): Promise<PhaseAdapterOutcome> {
  const bindings = resolveAzureInputs(input);
  const validation = validateAzureBindings(bindings);
  if (!validation.valid || !validation.subscriptionId) {
    return blockedQualificationOutcome(input,
      `Azure ${environment} qualification requires valid subscription: ${validation.errors.join(' ')}`);
  }

  const workload = input.inspection.manifest.project.workload;
  const configuredEnvironments = workload.kind === 'components' ? [] : workload.environments;
  if (!configuredEnvironments.includes(environment)) {
    return blockedQualificationOutcome(input,
      `Environment '${environment}' is not declared in project manifest environments: [${configuredEnvironments.join(', ')}]. Invented environments are rejected.`);
  }

  return environment === 'staging' ? executeStagingQualificationProducer(input) : executeProductionRehearsalProducer(input);
}

function blockedEnvironmentPlan(input: PhasePlanningInput, blocker: string): PhasePlanBuild {
  return { operations: [], blockers: [
    (input.inspection.scope ?? 'activation') === 'activation' ? blocker : environmentQualificationScopeBlocker
  ] };
}

export async function planDevProofPhase(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  return planProductionDevProof(input);
}

export async function planStagingQualificationPhase(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  return planProductionStaging(input);
}

export async function planProductionRehearsalPhase(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  return planProductionRehearsalProducer(input);
}

export async function planGreenRedProofPhase(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  return fullProductionChecksProducer.plan(input);
}

export const executeDevProofPhase = executeDevProofProducer;
export const executeStagingQualificationPhase = executeStagingQualificationProducer;
export const executeProductionRehearsalPhase = executeProductionRehearsalProducer;
export const executeGreenRedProofPhase = executeGreenRedProofProducer;

export const environmentQualificationWiring = {
  planners: {
    'dev-proof': planDevProofPhase, 'staging-qualified': planStagingQualificationPhase,
    'production-rehearsed': planProductionRehearsalPhase, 'green-red-proof': planGreenRedProofPhase
  },
  executors: {
    'dev-proof': executeDevProofPhase, 'staging-qualified': executeStagingQualificationPhase,
    'production-rehearsed': executeProductionRehearsalPhase, 'green-red-proof': executeGreenRedProofPhase
  },
  azureQualificationPhase: executeAzureQualificationPhase
};
