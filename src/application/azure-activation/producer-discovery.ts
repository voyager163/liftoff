import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { readbackProof } from '../../governance-activation/transition-records.js';
import { validateAzureBindings, executeAzureAccountShow } from '../../adapters/azure/production-adapter.js';

export function resolveAzureInputs(
  input: Pick<PhasePlanningInput, 'inspection' | 'phase'>
): Parameters<typeof validateAzureBindings>[0] {
  const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  const cfg = configuration?.azure;
  const phaseCfg = configuration?.phases[input.phase.id] ?? {};
  const resolved: Parameters<typeof validateAzureBindings>[0] = {};
  for (const key of ['subscriptionId', 'tenantId', 'region'] as const) {
    const source = Object.hasOwn(phaseCfg, key) ? phaseCfg : cfg;
    if (source && Object.hasOwn(source, key)) resolved[key] = source[key];
  }
  return resolved;
}

export async function executeAzurePhase0Discovery(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  const bindings = resolveAzureInputs(input);
  const validation = validateAzureBindings(bindings);
  if (!validation.valid || !validation.subscriptionId || !validation.tenantId || !validation.region) {
    return {
      status: 'blocked',
      blocker: `Azure Phase 0 discovery cannot proceed: ${validation.errors.join(' ')}`,
      completedOperations: []
    };
  }

  const { subscriptionId, tenantId, region } = validation;
  const accountResult = await executeAzureAccountShow(
    input.runner,
    input.inspection.projectRoot,
    subscriptionId,
    tenantId
  );

  if (!accountResult.success) {
    return {
      status: 'blocked',
      blocker: `Azure Phase 0 discovery failed: ${accountResult.error}`,
      completedOperations: []
    };
  }

  const resourceId = `/subscriptions/${subscriptionId}`;
  return {
    status: 'completed',
    resultState: 'verified',
    evidencePayload: {
      kind: 'phase-0-discovery.v1',
      azure: {
        subscriptionId,
        tenantId,
        region,
        observed: true,
        state: 'Enabled',
        ...(accountResult.account.name === undefined ? {} : { name: accountResult.account.name })
      },
      facts: [
        { id: 'azure.accountReadable', value: true },
        { id: 'azure.accountState', value: 'Enabled' },
        { id: 'azure.subscriptionId', value: subscriptionId },
        { id: 'azure.tenantId', value: tenantId },
        { id: 'azure.region', value: region }
      ]
    },
    liveReadback: [
      readbackProof(input, 'azure', 'subscription', resourceId, {
        subscriptionId,
        tenantId,
        state: 'Enabled'
      })
    ],
    completedOperations: input.plan.operations.filter((op) => op.actionId === 'azure.phase0.discover')
  };
}
