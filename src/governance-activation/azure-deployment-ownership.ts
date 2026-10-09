import type {
  MutationClass, TransitionOperation
} from '../domain/governance/activation/types.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { operation, transitionDestination } from '../domain/governance/activation/operations.js';
import type {
  PhaseAdapterExecutionInput, PhasePlanningInput
} from './transition-ports.js';
import {
  AzureDiscoveryError, expectedAzureEnvironmentBindings, observeAzurePhase0
} from './azure-discovery.js';
import { readbackProof } from './transition-records.js';

export const deploymentOwnershipActionId = 'azure.deployment.classify-ownership';

const protectedDeploymentMutations = new Set<MutationClass>([
  'registry-publish',
  'backend-state-read',
  'backend-state-write',
  'azure-network-provision',
  'azure-state-import',
  'azure-resource-provision'
]);

export function operationRequiresDeploymentOwnership(operation: TransitionOperation): boolean {
  return protectedDeploymentMutations.has(operation.mutationClass) ||
    (operation.effects ?? []).some((effect) => protectedDeploymentMutations.has(effect.mutationClass));
}

export function planRequiresDeploymentOwnership(operations: readonly TransitionOperation[]): boolean {
  return operations.some(operationRequiresDeploymentOwnership);
}

export function planAzureDeploymentOwnership(
  input: PhasePlanningInput,
  subscriptionId: string
): TransitionOperation {
  return operation({
    adapter: 'azure-opentofu',
    actionId: deploymentOwnershipActionId,
    mutationClass: 'azure-read',
    phaseId: input.phase.id,
    inputs: {
      scope: 'new-environment-activation',
      environments: expectedAzureEnvironmentBindings(input).map((environment) => ({
        environment: environment.environment,
        resourceGroup: environment.resources.resourceGroup
      })),
      allowed: ['new-environment', 'same-operation-owned'],
      preExisting: 'planning-only',
      readsDeploymentState: false
    },
    destination: transitionDestination('subscription', subscriptionId, { subscriptionId }),
    remote: true,
    destructive: false
  });
}

type AzurePhase0Report = Awaited<ReturnType<typeof observeAzurePhase0>>;
type EnvironmentReport = AzurePhase0Report['environments'][number];

export interface DeploymentOwnershipResult {
  operation: TransitionOperation;
  completedOperations: readonly TransitionOperation[];
  blocker?: string;
  payload?: {
    kind: 'deployment-ownership.v1';
    scope: 'new-environment-activation';
    classificationDigest: string;
    environments: readonly {
      environment: string;
      status: 'new-environment' | 'same-operation-owned' | 'pre-existing-or-unknown';
      resourceGroupId: string | null;
      observedResourceCount: number;
      operationProofDigest: string | null;
    }[];
  };
  liveReadback?: ReturnType<typeof readbackProof>[];
}

function normalizedResourceIds(environment: EnvironmentReport): string[] {
  return [
    ...(environment.resourceGroup ? [environment.resourceGroup.id] : []),
    ...environment.observedResources.map((resource) => resource.id)
  ].map((value) => value.toLowerCase());
}

function sameOperationProof(
  input: PhaseAdapterExecutionInput,
  environment: EnvironmentReport
): string | null {
  if (!environment.resourceGroup) return null;
  const phaseState = input.inspection.state.phases[input.phase.id];
  const external = phaseState.operation;
  if (!external || external.provider !== 'azure' || external.status === 'failed' ||
    phaseState.executionPlanDigest !== input.plan.planDigest ||
    external.planDigest !== input.plan.planDigest) {
    return null;
  }
  const planned = input.plan.operations.find((candidate) =>
    candidate.actionId === external.actionId && operationRequiresDeploymentOwnership(candidate)
  );
  if (!planned) return null;
  const observed = normalizedResourceIds(environment);
  const recorded = new Set([
    external.resourceId,
    ...(input.inspection.state.phaseOutputs?.[input.phase.id]?.resources ?? [])
      .filter((resource) => resource.provider === 'azure')
      .map((resource) => resource.resourceId)
  ].map((value) => value.toLowerCase()));
  if (!recorded.has(environment.resourceGroup.id.toLowerCase()) ||
    observed.some((resourceId) => !recorded.has(resourceId))) {
    return null;
  }
  return canonicalSha256({
    phaseId: input.phase.id,
    planDigest: input.plan.planDigest,
    actionId: external.actionId,
    operationId: external.operationId,
    resourceId: external.resourceId,
    observed
  });
}

export async function inspectAzureDeploymentOwnership(
  input: PhaseAdapterExecutionInput
): Promise<DeploymentOwnershipResult | null> {
  const classification = input.plan.operations.find((candidate) =>
    candidate.actionId === deploymentOwnershipActionId
  );
  const required = planRequiresDeploymentOwnership(input.plan.operations);
  if (!classification) {
    if (!required) return null;
    return {
      operation: input.plan.operations.find(operationRequiresDeploymentOwnership)!,
      completedOperations: [],
      blocker: 'Deployment execution requires an exact reviewed Azure ownership-classification operation before any protected effect.'
    };
  }
  try {
    const report = await observeAzurePhase0(input);
    const environments = report.environments.map((environment) => {
      if (environment.status === 'observed-absent') {
        return {
          environment: environment.environment,
          status: 'new-environment' as const,
          resourceGroupId: null,
          observedResourceCount: 0,
          operationProofDigest: null
        };
      }
      const operationProofDigest = sameOperationProof(input, environment);
      return {
        environment: environment.environment,
        status: operationProofDigest ? 'same-operation-owned' as const : 'pre-existing-or-unknown' as const,
        resourceGroupId: environment.resourceGroup?.id ?? null,
        observedResourceCount: environment.observedResources.length,
        operationProofDigest
      };
    });
    const payload = {
      kind: 'deployment-ownership.v1' as const,
      scope: 'new-environment-activation' as const,
      classificationDigest: canonicalSha256(environments),
      environments
    };
    const subscriptionResource = `/subscriptions/${report.subscription.id}`;
    const liveReadback = [
      readbackProof(input, 'azure', 'deployment-ownership', subscriptionResource, {
        subscription: report.subscription,
        principal: report.principal,
        cloud: report.cloud,
        region: report.region,
        environments
      }),
      ...report.environments.flatMap((environment) => [
        ...(environment.resourceGroup ? [
          readbackProof(input, 'azure', 'resource-group', environment.resourceGroup.id, environment.resourceGroup)
        ] : []),
        ...environment.observedResources.map((resource) =>
          readbackProof(input, 'azure', resource.type, resource.id, resource))
      ])
    ];
    const blocked = environments.filter((environment) => environment.status === 'pre-existing-or-unknown');
    return {
      operation: classification,
      completedOperations: [classification],
      payload,
      liveReadback,
      ...(blocked.length ? {
        blocker: `Deployment ownership is pre-existing or uncertain for ${blocked.map((entry) => entry.environment).join(', ')}; ` +
          'this release preserves that scope as planning-only and performed no state read, import, or resource write.'
      } : {})
    };
  } catch (error) {
    if (!(error instanceof AzureDiscoveryError)) throw error;
    return {
      operation: classification,
      completedOperations: [],
      blocker: error.message
    };
  }
}
