import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanningInput, PhasePlanBuild } from '../../governance-activation/transition-ports.js';
import { readbackProof, cloneState } from '../../governance-activation/transition-records.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { operation, transitionDestination } from '../../domain/governance/activation/operations.js';
import {
  validateAzureBindings,
  executeAzureAccountShow
} from '../../adapters/azure/production-adapter.js';
import { resolveAzureInputs } from './producer-discovery.js';
import { assertAzurePhaseAuthority } from './authority.js';
export { executeExistingPrivatePathVerification } from './producer-private-path.js';

export function planStatePathSelection(input: PhasePlanningInput): PhasePlanBuild {
  const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  const phase = configuration?.phases['state-path-selected'];
  if (input.phase.id !== 'state-path-selected' || (input.inspection.scope ?? 'activation') !== 'activation') {
    return { operations: [], blockers: ['State path selection is an activation-only operation.'] };
  }
  if (input.inspection.manifest.project.workload.kind === 'components') {
    return { operations: [], blockers: ['Component-only manifests do not declare an Azure state management path.'] };
  }
  if (!isRecord(phase) || Object.keys(phase).some((key) => !['statePath', 'subscriptionId', 'tenantId', 'region'].includes(key)) ||
    (phase.statePath !== 'existing-private' && phase.statePath !== 'bootstrap-local')) {
    return {
      operations: [],
      blockers: ['State path selection requires an explicit existing-private or bootstrap-local choice in phases.state-path-selected. Automatic fallback and approval flags are rejected.']
    };
  }
  const validation = validateAzureBindings(resolveAzureInputs(input));
  if (!validation.valid || !validation.subscriptionId || !validation.tenantId || !validation.region) {
    return { operations: [], blockers: [`State path selection requires exact Azure account bindings: ${validation.errors.join(' ')}`] };
  }
  return {
    operations: [operation({
      adapter: 'azure-opentofu', actionId: 'azure.state-path.select', phaseId: 'state-path-selected',
      mutationClass: 'azure-read', remote: true, destructive: false,
      inputs: {
        statePath: phase.statePath, subscriptionId: validation.subscriptionId,
        tenantId: validation.tenantId, region: validation.region
      },
      destination: transitionDestination('subscription', validation.subscriptionId, { subscriptionId: validation.subscriptionId })
    })]
  };
}

export async function executeStatePathSelected(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  const planned = planStatePathSelection(input);
  const selected = planned.operations[0];
  if (planned.blockers?.length || !selected) {
    return {
      status: 'blocked',
      blocker: planned.blockers?.join(' ') ?? 'The exact state path selection plan is unavailable.',
      completedOperations: []
    };
  }
  const reviewed = input.plan.operations.find((entry) => entry.actionId === selected.actionId);
  if (!reviewed || canonicalSha256(reviewed) !== canonicalSha256(selected)) {
    return { status: 'blocked', blocker: 'State path, account or region changed after the exact plan was reviewed.', completedOperations: [] };
  }
  await assertAzurePhaseAuthority(input, reviewed);
  const { statePath, subscriptionId, tenantId, region } = reviewed.inputs;
  if ((statePath !== 'existing-private' && statePath !== 'bootstrap-local') ||
    typeof subscriptionId !== 'string' || typeof tenantId !== 'string' || typeof region !== 'string') {
    throw new Error('The validated state path operation lost its required typed inputs.');
  }
  const account = await executeAzureAccountShow(input.runner, input.inspection.projectRoot, subscriptionId, tenantId);
  if (!account.success) {
    return {
      status: 'blocked', blocker: `State path account readback failed (${account.classification}): ${account.error}`,
      completedOperations: [reviewed]
    };
  }
  await assertAzurePhaseAuthority(input, reviewed);
  const nextState = cloneState(input.inspection.state);
  nextState.applicability.statePath = statePath;
  const resourceId = `/subscriptions/${account.account.id}`;
  return {
    status: 'completed',
    resultState: 'verified',
    stateOverride: nextState,
    evidencePayload: {
      kind: 'state-path-selected.v1',
      statePath, subscriptionId: account.account.id, tenantId: account.account.tenantId, region,
      account: account.account,
      backendVerified: false
    },
    liveReadback: [
      readbackProof(input, 'azure', 'subscription', resourceId, account.account)
    ],
    outputs: {
      values: {
        'azure.statePath': statePath,
        'azure.subscriptionId': account.account.id,
        'azure.tenantId': account.account.tenantId
      },
      resources: [
        {
          provider: 'azure',
          resourceType: 'subscription',
          resourceId
        }
      ]
    },
    completedOperations: [reviewed]
  };
}
