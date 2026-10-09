import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput } from './transition-ports.js';
import type { TransitionOperation } from '../domain/governance/activation/types.js';
import { operation, transitionDestination } from '../domain/governance/activation/operations.js';
import { readbackProof } from './transition-records.js';
import { executeBootstrapStateDisposal, remoteImportRetention } from './phase-bootstrap-state.js';
import { runCommand, commandSucceeded } from './transition-process.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { phaseCapabilities } from '../domain/governance/activation/capabilities.js';
import { AzureDiscoveryError, observeAzurePhase0 } from './azure-discovery.js';
import {
  executeAzureProviderReadiness, planAzureProviderReadiness
} from './azure-provider-readiness.js';
import { planAzureDeploymentOwnership } from './azure-deployment-ownership.js';

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
  if (!subscriptionId && input.phase.id !== 'bootstrap-state-disposed') {
    return null;
  }
  const subId = subscriptionId ?? '00000000-0000-0000-0000-000000000000';
  switch (input.phase.id) {
    case 'phase-0-complete':
    {
      const azure = input.inspection.activationInputs?.azure ?? input.inspection.state.activationInputs?.azure;
      if (!azure) return null;
      return {
        operations: [
          azureOperation(input.phase.id, 'azure.phase0.discover', 'azure-read', {
            subscriptionId: azure.subscriptionId,
            tenantId: azure.tenantId,
            region: azure.region
          }, subId)
        ]
      };
    }
    case 'provider-ready':
      return planAzureProviderReadiness(input);
    case 'state-path-selected':
      return {
        operations: [
          azureOperation(input.phase.id, 'azure.state-path.select', 'azure-read', { allowed: ['existing-private', 'bootstrap-local'] }, subId)
        ]
      };
    case 'existing-private-path':
      return {
        operations: [
          planAzureDeploymentOwnership(input, subId),
          azureOperation(input.phase.id, 'azure.existing-private-path.verify', 'azure-read', { statePath: 'existing-private' }, subId, [
            { mutationClass: 'backend-state-read', destination: transitionDestination('subscription', subId, { subscriptionId: subId }), remote: true, destructive: false }
          ])
        ]
      };
    case 'bootstrap-local':
      return {
        operations: [
          planAzureDeploymentOwnership(input, subId),
          azureOperation(input.phase.id, 'azure.bootstrap-local.apply', 'azure-network-provision', { boundedLocalBootstrap: true }, subId, [
            { mutationClass: 'azure-read', destination: transitionDestination('subscription', subId, { subscriptionId: subId }), remote: true, destructive: false }
          ])
        ]
      };
    case 'private-backend-proof':
      return {
        operations: [
          planAzureDeploymentOwnership(input, subId),
          azureOperation(input.phase.id, 'azure.remote-state.read', 'azure-read', { verifyAccess: true }, subId, [
            { mutationClass: 'backend-state-read', destination: transitionDestination('subscription', subId, { subscriptionId: subId }), remote: true, destructive: false }
          ])
        ]
      };
    case 'remote-import-verified':
      return {
        operations: [
          planAzureDeploymentOwnership(input, subId),
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
          planAzureDeploymentOwnership(input, subId),
          azureOperation(input.phase.id, 'azure.remote-ready.verify', 'azure-read', { retainBootstrapStateForDays: 30 }, subId, [
            { mutationClass: 'backend-state-read', destination: transitionDestination('subscription', subId, { subscriptionId: subId }), remote: true, destructive: false }
          ])
        ]
      };
    case 'application-prerequisites-ready':
      return {
        operations: [
          planAzureDeploymentOwnership(input, subId),
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
          planAzureDeploymentOwnership(input, subId),
          azureOperation(input.phase.id, 'azure.artifact.readback', 'azure-read', { verifyDigest: true }, subId)
        ]
      };
    case 'application-foundation':
      return {
        operations: [
          planAzureDeploymentOwnership(input, subId),
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
          planAzureDeploymentOwnership(input, subId),
          azureOperation(input.phase.id, 'azure.staging.readback', 'azure-read', { environment: 'staging' }, subId)
        ]
      };
    case 'production-rehearsed':
      return {
        operations: [
          planAzureDeploymentOwnership(input, subId),
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
      const operation = input.plan.operations.find((entry) => entry.actionId === 'azure.phase0.discover');
      if (!subscriptionId || !operation) {
        return null;
      }
      try {
        const report = await observeAzurePhase0(input);
        const subscriptionResource = `/subscriptions/${report.subscription.id}`;
        const environmentResources = report.environments.flatMap((environment) => [
          ...(environment.resourceGroup ? [{
            provider: 'azure' as const,
            resourceType: 'resource-group',
            resourceId: environment.resourceGroup.id
          }] : []),
          ...environment.observedResources.map((resource) => ({
            provider: 'azure' as const,
            resourceType: resource.type,
            resourceId: resource.id
          }))
        ]);
        const environmentReadbacks = report.environments.flatMap((environment) => [
          ...(environment.resourceGroup ? [
            readbackProof(input, 'azure', 'resource-group', environment.resourceGroup.id, environment.resourceGroup)
          ] : []),
          ...environment.observedResources.map((resource) =>
            readbackProof(input, 'azure', resource.type, resource.id, resource))
        ]);
        return {
          status: 'completed',
          resultState: 'verified',
          evidencePayload: {
            kind: 'phase-0-discovery.v1',
            azure: report
          },
          liveReadback: [
            readbackProof(input, 'azure', 'subscription', subscriptionResource, report),
            ...environmentReadbacks
          ],
          outputs: {
            values: {
              subscriptionId: report.subscription.id,
              tenantId: report.subscription.tenantId,
              subscriptionState: report.subscription.state,
              principalType: report.principal.type,
              principalObjectId: report.principal.objectId,
              principalAppId: report.principal.appId ?? null,
              cloudName: report.cloud.name,
              resourceManagerEndpoint: report.cloud.resourceManager,
              resourceManagerAudience: report.cloud.resourceManagerAudience,
              region: report.region,
              environmentCount: report.environments.length,
              occupiedEnvironmentCount: report.environments
                .filter((environment) => environment.status === 'occupied-unverified-ownership').length
            },
            resources: [{
              provider: 'azure',
              resourceType: 'subscription',
              resourceId: subscriptionResource
            }, ...environmentResources]
          },
          completedOperations: [operation]
        };
      } catch (error) {
        return {
          status: 'blocked',
          resultState: 'failed',
          blocker: error instanceof AzureDiscoveryError
            ? error.message
            : 'Azure Phase 0 discovery failed unexpectedly; provider diagnostics were withheld.',
          completedOperations: []
        };
      }
    }
    case 'provider-ready':
      return executeAzureProviderReadiness(input);
    case 'state-path-selected':
      // No production executor exists yet; never synthesize state-path readback.
      return {
        status: 'blocked',
        blocker: phaseCapabilities[input.phase.id].blocker ?? 'No production executor is available.',
        completedOperations: []
      };
    case 'remote-ready':
      return remoteImportRetention(input);
    case 'bootstrap-state-disposed':
      return executeBootstrapStateDisposal(input);
    default:
      return null;
  }
}
