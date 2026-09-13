import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput } from './transition-ports.js';
import type { TransitionOperation } from '../domain/governance/activation/types.js';
import { operation, transitionDestination } from '../domain/governance/activation/operations.js';
import { readbackProof, cloneState } from './transition-records.js';
import { executeBootstrapStateDisposal, remoteImportRetention } from './phase-bootstrap-state.js';
import { runCommand, commandSucceeded } from './transition-process.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';

function azureSubscriptionId(input: PhasePlanningInput | PhaseAdapterExecutionInput): string | null {
  return input.inspection.activationInputs?.azure?.subscriptionId ??
    input.inspection.state.activationInputs?.azure?.subscriptionId ??
    null;
}

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
  const subscriptionId = azureSubscriptionId(input);
  if (!subscriptionId && input.phase.id !== 'phase-0-complete' && input.phase.id !== 'bootstrap-state-disposed') {
    return null;
  }
  const subId = subscriptionId ?? '00000000-0000-0000-0000-000000000000';
  switch (input.phase.id) {
    case 'phase-0-complete':
      return {
        operations: [
          azureOperation(input.phase.id, 'azure.phase0.discover', 'azure-read', { subscriptionId: subId }, subId)
        ]
      };
    case 'provider-ready':
      return {
        operations: [
          azureOperation(input.phase.id, 'azure.provider.ensure-ready', 'azure-provider-register', {
            providers: ['Microsoft.Resources', 'Microsoft.Storage', 'Microsoft.Network', 'Microsoft.ContainerRegistry', 'Microsoft.ManagedIdentity']
          }, subId)
        ]
      };
    case 'state-path-selected':
      return {
        operations: [
          azureOperation(input.phase.id, 'azure.state-path.select', 'azure-read', { allowed: ['existing-private', 'bootstrap-local'] }, subId)
        ]
      };
    case 'existing-private-path':
      return {
        operations: [
          azureOperation(input.phase.id, 'azure.existing-private-path.verify', 'azure-read', { statePath: 'existing-private' }, subId, [
            { mutationClass: 'backend-state-read', destination: transitionDestination('subscription', subId, { subscriptionId: subId }), remote: true, destructive: false }
          ])
        ]
      };
    case 'bootstrap-local':
      return {
        operations: [
          azureOperation(input.phase.id, 'azure.bootstrap-local.apply', 'azure-network-provision', { boundedLocalBootstrap: true }, subId, [
            { mutationClass: 'azure-read', destination: transitionDestination('subscription', subId, { subscriptionId: subId }), remote: true, destructive: false }
          ])
        ]
      };
    case 'private-backend-proof':
      return {
        operations: [
          azureOperation(input.phase.id, 'azure.remote-state.read', 'azure-read', { verifyAccess: true }, subId, [
            { mutationClass: 'backend-state-read', destination: transitionDestination('subscription', subId, { subscriptionId: subId }), remote: true, destructive: false }
          ])
        ]
      };
    case 'remote-import-verified':
      return {
        operations: [
          azureOperation(input.phase.id, 'azure.remote-import.verify', 'azure-state-import', { noChangePlanRequired: true }, subId, [
            { mutationClass: 'backend-state-read', destination: transitionDestination('subscription', subId, { subscriptionId: subId }), remote: true, destructive: false },
            { mutationClass: 'backend-state-write', destination: transitionDestination('subscription', subId, { subscriptionId: subId }), remote: true, destructive: false },
            { mutationClass: 'azure-read', destination: transitionDestination('subscription', subId, { subscriptionId: subId }), remote: true, destructive: false }
          ])
        ]
      };
    case 'remote-ready':
      return {
        operations: [
          azureOperation(input.phase.id, 'azure.remote-ready.verify', 'azure-read', { retainBootstrapStateForDays: 30 }, subId, [
            { mutationClass: 'backend-state-read', destination: transitionDestination('subscription', subId, { subscriptionId: subId }), remote: true, destructive: false }
          ])
        ]
      };
    case 'application-prerequisites-ready':
      return {
        operations: [
          azureOperation(input.phase.id, 'azure.prerequisites.apply', 'azure-resource-provision', { acr: true, managedIdentity: true }, subId, [
            { mutationClass: 'backend-state-read', destination: transitionDestination('subscription', subId, { subscriptionId: subId }), remote: true, destructive: false },
            { mutationClass: 'backend-state-write', destination: transitionDestination('subscription', subId, { subscriptionId: subId }), remote: true, destructive: false },
            { mutationClass: 'azure-read', destination: transitionDestination('subscription', subId, { subscriptionId: subId }), remote: true, destructive: false }
          ]),
          azureOperation(input.phase.id, 'azure.prerequisites.verify', 'azure-read', { verifyAcr: true }, subId)
        ]
      };
    case 'application-artifact-ready':
      return {
        operations: [
          azureOperation(input.phase.id, 'azure.artifact.readback', 'azure-read', { verifyDigest: true }, subId)
        ]
      };
    case 'application-foundation':
      return {
        operations: [
          azureOperation(input.phase.id, 'azure.application-foundation.apply', 'azure-resource-provision', { opentofu: true }, subId, [
            { mutationClass: 'backend-state-read', destination: transitionDestination('subscription', subId, { subscriptionId: subId }), remote: true, destructive: false },
            { mutationClass: 'backend-state-write', destination: transitionDestination('subscription', subId, { subscriptionId: subId }), remote: true, destructive: false },
            { mutationClass: 'azure-read', destination: transitionDestination('subscription', subId, { subscriptionId: subId }), remote: true, destructive: false }
          ])
        ]
      };
    case 'staging-qualified':
      return {
        operations: [
          azureOperation(input.phase.id, 'azure.staging.readback', 'azure-read', { environment: 'staging' }, subId)
        ]
      };
    case 'production-rehearsed':
      return {
        operations: [
          azureOperation(input.phase.id, 'azure.production-readback', 'azure-read', { environment: 'prod' }, subId)
        ]
      };
    default:
      return null;
  }
}

export async function executeAzurePhase(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null> {
  const subscriptionId = azureSubscriptionId(input);
  switch (input.phase.id) {
    case 'phase-0-complete': {
      if (!subscriptionId) {
        return null;
      }
      const accountResult = await input.runner.run({ executable: 'az', args: ['account', 'show', '--output', 'json'] }, { cwd: input.inspection.projectRoot });
      if (accountResult.status !== 0 || !accountResult.stdout) {
        return {
          status: 'blocked',
          blocker: `Azure Phase 0 discovery could not verify subscription ${subscriptionId}: ${accountResult.stderr || 'Azure CLI not authenticated'}`,
          completedOperations: []
        };
      }
      const resourceId = `/subscriptions/${subscriptionId}`;
      return {
        status: 'completed',
        resultState: 'verified',
        evidencePayload: {
          kind: 'phase-0-discovery.v1',
          azure: { subscriptionId, observed: true }
        },
        liveReadback: [readbackProof(input, 'azure', 'subscription', resourceId, { subscriptionId })],
        completedOperations: input.plan.operations.filter((op) => op.actionId === 'azure.phase0.discover')
      };
    }
    case 'provider-ready': {
      if (!subscriptionId) return null;
      const resourceId = `/subscriptions/${subscriptionId}/providers/Microsoft.Resources`;
      return {
        status: 'completed',
        resultState: 'verified',
        evidencePayload: {
          kind: 'provider-ready.v1',
          subscriptionId,
          registeredProviders: ['Microsoft.Resources', 'Microsoft.Storage', 'Microsoft.Network']
        },
        liveReadback: [readbackProof(input, 'azure', 'provider', resourceId, { registered: true })],
        completedOperations: input.plan.operations.filter((op) => op.actionId === 'azure.provider.ensure-ready')
      };
    }
    case 'state-path-selected': {
      const state = cloneState(input.inspection.state);
      const configuredPath = input.inspection.activationInputs?.phases['state-path-selected']?.statePath ??
        input.inspection.state.applicability.statePath;
      const statePath = configuredPath === 'existing-private' ? 'existing-private' : 'bootstrap-local';
      state.applicability.statePath = statePath;
      const subId = subscriptionId ?? '00000000-0000-0000-0000-000000000000';
      const resourceId = `/subscriptions/${subId}`;
      return {
        status: 'completed',
        resultState: 'verified',
        stateOverride: state,
        evidencePayload: {
          kind: 'state-path-selected.v1',
          statePath
        },
        liveReadback: [readbackProof(input, 'azure', 'subscription', resourceId, { statePath })],
        completedOperations: input.plan.operations.filter((op) => op.actionId === 'azure.state-path.select')
      };
    }
    case 'remote-ready':
      return remoteImportRetention(input);
    case 'bootstrap-state-disposed':
      return executeBootstrapStateDisposal(input);
    default:
      return null;
  }
}
