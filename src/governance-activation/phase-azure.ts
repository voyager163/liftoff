import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput } from './transition-ports.js';
import type { TransitionOperation } from '../domain/governance/activation/types.js';
import { operation, transitionDestination } from '../domain/governance/activation/operations.js';
import { executeBootstrapStateDisposal, remoteImportRetention } from './phase-bootstrap-state.js';
import { validateAzureBindings } from '../adapters/azure/production-adapter.js';
import { executeAzurePhase0Discovery, resolveAzureInputs } from '../application/azure-activation/producer-discovery.js';
import { executeAzureProviderReadiness, planProviderReadiness } from '../application/azure-activation/producer-provider.js';
import { planStatePathSelection, executeStatePathSelected, executeExistingPrivatePathVerification } from '../application/azure-activation/producer-state-path.js';
import { executeBootstrapLocal, planBootstrapLocal, executeRemoteImportVerified, planRemoteImportVerified } from '../application/azure-activation/producer-bootstrap.js';
import { planExistingPrivatePath } from '../application/azure-activation/producer-private-path.js';
import { executeApplicationPrerequisites, planApplicationPrerequisites } from '../application/azure-activation/producer-prerequisites.js';
import { executeApplicationFoundation, planApplicationFoundation } from '../application/azure-activation/producer-foundation.js';
import { executeAzureQualificationPhase } from '../application/azure-activation/producer-qualification.js';
import { executeCompositePhase, planCompositePhase } from './phase-composite.js';

function azureOperation(
  phaseId: TransitionOperation['phaseId'],
  actionId: string,
  mutationClass: TransitionOperation['mutationClass'],
  inputs: Record<string, unknown>,
  subscriptionId: string,
  effects?: TransitionOperation['effects']
): TransitionOperation {
  return operation({
    adapter: 'azure-opentofu',
    actionId,
    mutationClass,
    phaseId,
    inputs,
    destination: transitionDestination('subscription', subscriptionId, { subscriptionId }),
    remote: true,
    destructive: false,
    ...(effects?.length ? { effects } : {})
  });
}

export async function planAzurePhase(input: PhasePlanningInput): Promise<PhasePlanBuild | null> {
  if (input.inspection.scope === 'repository') {
    return null;
  }

  if (input.phase.id === 'bootstrap-state-disposed') {
    return null;
  }
  if (input.phase.id === 'application-prerequisites-ready') return planApplicationPrerequisites(input);
  if (input.phase.id === 'application-foundation') return planApplicationFoundation(input);
  if (input.phase.id === 'application-artifact-ready') return planCompositePhase(input);
  if (input.phase.id === 'dev-proof') return planCompositePhase(input);
  if (input.phase.id === 'production-rehearsed') return planCompositePhase(input);
  if (input.phase.id === 'staging-qualified') return planCompositePhase(input);
  if (input.phase.id === 'existing-private-path') return planExistingPrivatePath(input);
  if (input.phase.id === 'bootstrap-local') return planBootstrapLocal(input);
  if (input.phase.id === 'remote-import-verified') return planRemoteImportVerified(input);
  if (input.phase.id === 'private-backend-proof') return planCompositePhase(input);

  const rawBindings = resolveAzureInputs(input);
  const activationInputsProvided = Boolean(
    input.inspection.activationInputs !== undefined ||
    input.inspection.state.activationInputs !== undefined
  );
  const hasAzureSpecificInputs = Boolean(
    input.inspection.activationInputs?.azure ||
    input.inspection.state.activationInputs?.azure ||
    Object.keys(rawBindings).length > 0
  );

  if (!activationInputsProvided && !hasAzureSpecificInputs) {
    if (input.phase.id !== 'phase-0-complete') return null;
    return {
      operations: [],
      blockers: [`Azure phase ${input.phase.id} requires explicit non-placeholder subscriptionId, tenantId and region before it is executable.`]
    };
  }

  if (!hasAzureSpecificInputs) {
    if (input.phase.id === 'remote-ready') {
      return null;
    }
    return {
      operations: [],
      blockers: [
        `Azure phase planning for ${input.phase.id} requires valid explicit non-placeholder subscriptionId, tenantId, and region.`
      ]
    };
  }

  const validation = validateAzureBindings(rawBindings);
  if (!validation.valid || !validation.subscriptionId || !validation.tenantId || !validation.region) {
    return {
      operations: [],
      blockers: [
        `Azure phase planning for ${input.phase.id} requires valid explicit non-placeholder subscriptionId, tenantId, and region. ${validation.errors.join(' ')}`
      ]
    };
  }

  const subId = validation.subscriptionId;
  const tenantId = validation.tenantId;
  const region = validation.region;

  switch (input.phase.id) {
    case 'phase-0-complete':
      return {
        operations: [
          azureOperation(input.phase.id, 'azure.phase0.discover', 'azure-read', { subscriptionId: subId, tenantId, region }, subId)
        ]
      };
    case 'provider-ready':
      return planProviderReadiness(input);
    case 'state-path-selected':
      return planStatePathSelection(input);
    case 'remote-ready':
      return {
        operations: [
          azureOperation(input.phase.id, 'azure.remote-ready.verify', 'azure-read', { retainBootstrapStateForDays: 30, subscriptionId: subId }, subId, [
            { mutationClass: 'backend-state-read', destination: transitionDestination('subscription', subId, { subscriptionId: subId }), remote: true, destructive: false }
          ])
        ]
      };
    default:
      return null;
  }
}

export async function executeAzurePhase(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null> {
  if (input.inspection.scope === 'repository') return null;
  const rawBindings = resolveAzureInputs(input);
  const hasAzureInputs = Boolean(
    input.inspection.activationInputs?.azure ||
    input.inspection.state.activationInputs?.azure ||
    Object.keys(rawBindings).length > 0
  );

  if (!hasAzureInputs && input.phase.id === 'remote-ready') {
    return null;
  }

  switch (input.phase.id) {
    case 'phase-0-complete':
      return executeAzurePhase0Discovery(input);
    case 'provider-ready':
      return executeAzureProviderReadiness(input);
    case 'state-path-selected':
      return executeStatePathSelected(input);
    case 'existing-private-path':
      return executeExistingPrivatePathVerification(input);
    case 'bootstrap-local':
      return executeBootstrapLocal(input);
    case 'private-backend-proof':
      return executeCompositePhase(input);
    case 'remote-import-verified':
      return executeRemoteImportVerified(input);
    case 'remote-ready':
      return remoteImportRetention(input);
    case 'application-prerequisites-ready':
      return executeApplicationPrerequisites(input);
    case 'application-artifact-ready':
    case 'dev-proof':
    case 'production-rehearsed':
    case 'staging-qualified':
      return executeCompositePhase(input);
    case 'application-foundation':
      return executeApplicationFoundation(input);
    case 'bootstrap-state-disposed':
      return executeBootstrapStateDisposal(input);
    default:
      return null;
  }
}
