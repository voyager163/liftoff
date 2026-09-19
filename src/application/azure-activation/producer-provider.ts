import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { operation, transitionDestination } from '../../domain/governance/activation/operations.js';
import { readbackProof } from '../../governance-activation/transition-records.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import type {
  PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput
} from '../../governance-activation/transition-ports.js';
import type { ExternalOperationState, TransitionOperation } from '../../domain/governance/activation/types.js';
import {
  executeAzureAccountShow, executeAzureProviderShow, validateAzureBindings, NIL_UUID, UUID_PATTERN,
  type ProviderNamespaceStatus
} from '../../adapters/azure/production-adapter.js';
import {
  AzureArmError, AzureProviderClient, createAzureCliArmTransport, type AzureProviderObservation
} from '../../adapters/azure/activation-rest.js';
import { UpdatePreviewError } from '../update/preview.js';
import { inspectProviderResourceInventory } from './provider-resource-inventory.js';
import { AzureActivationAdmissionError, assertAzurePhaseAuthority } from './authority.js';
import { prepareProviderRegistration, readProviderCheckpoints, settleProviderRegistration, submitProviderRegistration } from './provider-checkpoints.js';
import { resolveAzureInputs } from './producer-discovery.js';

function providerConfiguration(input: PhasePlanningInput) {
  const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  const phase = configuration?.phases['provider-ready'];
  if (!isRecord(phase) || Object.keys(phase).some((key) =>
    !['rootPathParts', 'principalId', 'registration', 'subscriptionId', 'tenantId', 'region'].includes(key)) ||
    !Array.isArray(phase.rootPathParts) || phase.rootPathParts.some((part) => typeof part !== 'string') ||
    typeof phase.principalId !== 'string' || !UUID_PATTERN.test(phase.principalId) || phase.principalId === NIL_UUID ||
    (phase.registration !== 'read-only' && phase.registration !== 'register-missing')) {
    throw new AzureActivationAdmissionError('provider-configuration',
      'Provider readiness requires exact rootPathParts, principalId and registration (read-only or register-missing). Configuration approval flags cannot authorize provider registration.');
  }
  return {
    rootPathParts: phase.rootPathParts.map((part) => {
      if (typeof part !== 'string') throw new AzureActivationAdmissionError('provider-configuration', 'Provider source paths require strings.');
      return part;
    }),
    principalId: phase.principalId, registration: phase.registration
  };
}

export async function deriveRequiredProviders(input: PhasePlanningInput): Promise<readonly string[]> {
  const config = providerConfiguration(input);
  return (await inspectProviderResourceInventory(input, config.rootPathParts)).namespaces;
}

export async function planProviderReadiness(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  if (input.phase.id !== 'provider-ready' || (input.inspection.scope ?? 'activation') !== 'activation') {
    return { operations: [], blockers: ['Provider readiness belongs only to explicit full activation.'] };
  }
  const config = providerConfiguration(input);
  const bindings = validateAzureBindings(resolveAzureInputs(input));
  if (!bindings.valid || !bindings.subscriptionId || !bindings.tenantId || !bindings.region) {
    return { operations: [], blockers: [`Provider readiness requires exact Azure bindings: ${bindings.errors.join(' ')}`] };
  }
  const { subscriptionId, tenantId, region } = bindings;
  const inventory = await inspectProviderResourceInventory(input, config.rootPathParts);
  if (inventory.namespaces.length > 32) throw new AzureActivationAdmissionError('provider-limit', 'Provider readiness exceeds the 32-namespace bound.');
  const phaseState = input.inspection.state.phases['provider-ready'];
  const interrupted = phaseState.state === 'running' ||
    phaseState.state === 'blocked' && phaseState.executionPlanDigest !== undefined ||
    input.inspection.recoverPhase === 'provider-ready';
  if (interrupted) {
    const recordedDigest = phaseState.operation?.planDigest ?? phaseState.executionPlanDigest;
    const original = input.inspection.contexts['provider-ready'].reviewedPlans?.find((plan) => plan.planDigest === recordedDigest);
    const originalOperations = original?.operations.filter((op) => op.actionId === 'azure.provider.ensure-ready');
    if (!originalOperations?.length || originalOperations.length !== inventory.namespaces.length ||
      originalOperations.some((op) => op.inputs.resourceInventoryDigest !== inventory.sourceDigest ||
        op.inputs.subscriptionId !== bindings.subscriptionId || op.inputs.tenantId !== bindings.tenantId ||
        op.inputs.principalId !== config.principalId || op.inputs.registration !== config.registration ||
        typeof op.inputs.namespace !== 'string' || !inventory.namespaces.includes(op.inputs.namespace))) {
      throw new AzureActivationAdmissionError('recovery-binding', 'Provider recovery requires the original reviewed operation and unchanged source, principal and target; no new registration was planned.');
    }
    return { operations: originalOperations };
  }
  const account = await executeAzureAccountShow(input.runner, input.inspection.projectRoot, bindings.subscriptionId, bindings.tenantId);
  if (!account.success) return { operations: [], blockers: [`Provider account discovery failed (${account.classification}): ${account.error}`] };
  const observations: ProviderNamespaceStatus[] = [];
  for (const namespace of inventory.namespaces) {
    const observed = await executeAzureProviderShow(input.runner, input.inspection.projectRoot, bindings.subscriptionId, namespace);
    if (!observed.success) return { operations: [], blockers: [`Provider ${namespace} discovery failed (${observed.classification}): ${observed.error}`] };
    if (observed.status.state === 'Registering' || observed.status.state === 'Unregistering') {
      return { operations: [], blockers: [`Provider ${namespace} is already ${observed.status.state}; without a prior bound Liftoff checkpoint it cannot be adopted or redispatched.`] };
    }
    observations.push(observed.status);
  }
  const missing = observations.filter((entry) => entry.state !== 'Registered').map((entry) => entry.namespace);
  if (missing.length && config.registration === 'read-only') {
    return { operations: [], blockers: [`Provider namespaces are not registered: ${missing.join(', ')}. Review a separate register-missing plan; no registration was dispatched.`] };
  }
  return { operations: observations.map((observed) => operation({
    adapter: 'azure-opentofu', actionId: 'azure.provider.ensure-ready', phaseId: 'provider-ready',
    mutationClass: observed.state === 'Registered' ? 'azure-read' : 'azure-provider-register',
    inputs: {
      subscriptionId, tenantId, region,
      principalId: config.principalId, registration: config.registration,
      namespace: observed.namespace, expected: observed, rootPathParts: inventory.rootPathParts, resourceInventoryDigest: inventory.sourceDigest,
      resources: inventory.resources.filter((entry) => entry.namespace === observed.namespace),
      retainedCapability: true, polling: { attempts: 3, maxNamespaces: 32, maxDurationMs: 120_000 }
    },
    destination: transitionDestination('subscription', subscriptionId, { subscriptionId }),
    remote: true, destructive: false,
    ...(observed.state === 'Registered' ? {} : { effects: [{
      mutationClass: 'azure-read' as const,
      destination: transitionDestination('subscription', subscriptionId, { subscriptionId }),
      remote: true, destructive: false
    }] })
  })) };
}

function pending(input: PhaseAdapterExecutionInput, operation: TransitionOperation, namespace: string, checkpoint: {
  prepared: { planDigest: string; preparedAt: string }; submitted: { requestId: string } | null;
}, observedAt: Date): ExternalOperationState | undefined {
  if (!checkpoint.submitted) return undefined;
  return {
    provider: 'azure', actionId: operation.actionId, operationId: checkpoint.submitted.requestId,
    resourceId: `/subscriptions/${operation.inputs.subscriptionId}/providers/${namespace}`,
    startedAt: checkpoint.prepared.preparedAt, observedAt: observedAt.toISOString(),
    status: 'running', planDigest: checkpoint.prepared.planDigest
  };
}

export async function executeAzureProviderReadiness(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  const completedOperations: TransitionOperation[] = [];
  let operationState = input.inspection.state.phases['provider-ready'].operation;
  const deadline = performance.now() + 120_000;
  const withinBudget = () => {
    if (performance.now() >= deadline) throw new AzureActivationAdmissionError('provider-window-ended', 'Provider observation exceeded its reviewed two-minute window; preserve checkpoints and resume without duplicate dispatch.');
  };
  try {
    const config = providerConfiguration(input);
    const bindings = validateAzureBindings(resolveAzureInputs(input));
    if (!bindings.valid || !bindings.subscriptionId || !bindings.tenantId) {
      return { status: 'blocked', blocker: `Provider readiness requires valid bindings: ${bindings.errors.join(' ')}`, completedOperations };
    }
    const operations = input.plan.operations.filter((op) => op.actionId === 'azure.provider.ensure-ready');
    const inventory = await inspectProviderResourceInventory(input, config.rootPathParts);
    if (operations.length !== inventory.namespaces.length || operations.length > 32 ||
      new Set(operations.map((op) => op.inputs.namespace)).size !== operations.length ||
      operations.some((op) => op.inputs.subscriptionId !== bindings.subscriptionId ||
        op.inputs.tenantId !== bindings.tenantId || op.inputs.principalId !== config.principalId ||
        op.inputs.registration !== config.registration || op.inputs.resourceInventoryDigest !== inventory.sourceDigest ||
        canonicalSha256(op.inputs.rootPathParts) !== canonicalSha256(inventory.rootPathParts) ||
        typeof op.inputs.namespace !== 'string' || !inventory.namespaces.includes(op.inputs.namespace) ||
        canonicalSha256(op.inputs.resources) !== canonicalSha256(inventory.resources.filter((entry) => entry.namespace === op.inputs.namespace)) ||
        !isRecord(op.inputs.expected) || op.inputs.expected.namespace !== op.inputs.namespace ||
        op.inputs.expected.resourceId !== `/subscriptions/${bindings.subscriptionId}/providers/${op.inputs.namespace}` ||
        op.mutationClass !== (op.inputs.expected.state === 'Registered' ? 'azure-read' : 'azure-provider-register') ||
        canonicalSha256(op.inputs.polling) !== canonicalSha256({ attempts: 3, maxNamespaces: 32, maxDurationMs: 120_000 }))) {
      return { status: 'blocked', blocker: 'Exact source/resource inventory or principal/registration plan changed before execution.', completedOperations };
    }
    for (const op of operations) await assertAzurePhaseAuthority(input, op);
    const client = new AzureProviderClient(azurePorts(input).transport ?? createAzureCliArmTransport(
      input.runner, input.inspection.projectRoot, { now: () => (input.clock?.() ?? input.now).getTime(), deadline }
    ), { subscriptionId: bindings.subscriptionId, tenantId: bindings.tenantId, principalId: config.principalId });
    const read = async (namespace: string) => {
      withinBudget();
      const observation = await client.read(namespace);
      withinBudget();
      return observation;
    };
    const preflight = new Map<string, {
      observation: AzureProviderObservation;
      checkpoint: Awaited<ReturnType<typeof readProviderCheckpoints>>;
    }>();
    for (const reviewed of operations) {
      const namespace = String(reviewed.inputs.namespace);
      withinBudget();
      await assertAzurePhaseAuthority(input, reviewed);
      const checkpoint = reviewed.mutationClass === 'azure-provider-register'
        ? await readProviderCheckpoints(input, reviewed, namespace) : null;
      const observation = await read(namespace);
      const expected = reviewed.inputs.expected;
      if (!isRecord(expected) || !checkpoint && (observation.state !== expected.state || observation.resourceId !== expected.resourceId)) {
        return { status: 'blocked', blocker: `Provider ${namespace} changed after review without a matching private checkpoint; no new provider write was attempted.`, completedOperations };
      }
      preflight.set(namespace, { observation, checkpoint });
    }
    for (const reviewed of operations) {
      const namespace = String(reviewed.inputs.namespace);
      const { checkpoint, observation: observed } = preflight.get(namespace)!;
      withinBudget();
      if (observed.state === 'Registered') {
        if (checkpoint && !checkpoint.settled) await settleProviderRegistration(input, reviewed, checkpoint.prepared, observed);
        completedOperations.push(reviewed);
        continue;
      }
      if (checkpoint && !checkpoint.settled) {
        if (observed.state === 'Registering') {
          const recordedOperation = pending(input, reviewed, namespace, checkpoint, input.clock?.() ?? input.now);
          if (recordedOperation) operationState = recordedOperation;
          return {
            status: recordedOperation ? 'pending' : 'blocked', ...(operationState ? { operation: operationState } : {}),
            blocker: recordedOperation ? `Provider ${namespace} is still registering; bounded continuation only reads the recorded operation.` :
              `Provider ${namespace} may have been submitted, but response identity was not retained. Preserve the pre-effect checkpoint; read-only recovery may confirm Registered, never redispatch.`,
            completedOperations
          };
        }
        return { status: 'blocked', blocker: `Provider ${namespace} is not terminal ready after its pre-effect checkpoint; uncertain submission cannot be retried blindly.`, completedOperations, ...(operationState ? { operation: operationState } : {}) };
      }
      const expected = reviewed.inputs.expected;
      const immediatelyBefore = await read(namespace);
      if (!isRecord(expected) || expected.state !== immediatelyBefore.state || expected.resourceId !== immediatelyBefore.resourceId ||
        reviewed.mutationClass !== 'azure-provider-register' || config.registration !== 'register-missing' ||
        !['NotRegistered', 'Unregistered'].includes(immediatelyBefore.state)) {
        return { status: 'blocked', blocker: `Provider ${namespace} differs from the exact registration precondition or is not authorized for a new write.`, completedOperations };
      }
      if (canonicalSha256(await inspectProviderResourceInventory(input, config.rootPathParts)) !== canonicalSha256(inventory)) {
        return { status: 'blocked', blocker: 'Resource sources changed immediately before registration; no further provider write was attempted.', completedOperations };
      }
      const prepared = await prepareProviderRegistration(input, reviewed, namespace);
      await assertAzurePhaseAuthority(input, reviewed);
      withinBudget();
      let submission: AzureProviderObservation;
      try {
        submission = await client.register(namespace, prepared.clientRequestId);
      } catch (error) {
        if (!(error instanceof AzureArmError)) throw error;
        if (error.requestId) {
          operationState = pending(input, reviewed, namespace, { prepared, submitted: { requestId: error.requestId } }, input.clock?.() ?? input.now);
          await submitProviderRegistration(input, reviewed, prepared, error.requestId);
        }
        const settled = await settleProviderRegistration(input, reviewed, prepared, error);
        if (settled === 'settled' && operationState) operationState = { ...operationState, status: 'failed' };
        throw error;
      }
      operationState = pending(input, reviewed, namespace, { prepared, submitted: { requestId: submission.requestId } }, input.clock?.() ?? input.now);
      completedOperations.push(reviewed);
      const submitted = await submitProviderRegistration(input, reviewed, prepared, submission.requestId);
      operationState = pending(input, reviewed, namespace, { prepared, submitted }, input.clock?.() ?? input.now);
      let readback = submission;
      for (let attempt = 0; attempt < 3; attempt++) {
        withinBudget();
        await assertAzurePhaseAuthority(input, reviewed);
        readback = await read(namespace);
        if (readback.state === 'Registered') break;
        if (readback.state !== 'Registering') {
          return { status: 'blocked', blocker: `Provider ${namespace} did not enter a supported pending or terminal registration state after submission.`, completedOperations, operation: operationState };
        }
      }
      if (readback.state !== 'Registered') {
        return { status: 'pending', blocker: `Provider ${namespace} registration is pending after three bounded reads; retain its exact operation identity.`, operation: operationState, completedOperations };
      }
      await settleProviderRegistration(input, reviewed, prepared, readback);
      if (operationState) operationState = { ...operationState, status: 'completed' };
    }
    const observations: AzureProviderObservation[] = [];
    for (const reviewed of operations) {
      withinBudget();
      await assertAzurePhaseAuthority(input, reviewed);
      const observed = await read(String(reviewed.inputs.namespace));
      if (observed.state !== 'Registered') {
        return { status: 'blocked', blocker: 'A required namespace changed before independent final provider readback.', completedOperations, ...(operationState ? { operation: operationState } : {}) };
      }
      observations.push(observed);
    }
    if (canonicalSha256(await inspectProviderResourceInventory(input, config.rootPathParts)) !== canonicalSha256(inventory)) {
      return { status: 'blocked', blocker: 'Resource inventory changed before final provider proof; effects and checkpoints were retained.', completedOperations, ...(operationState ? { operation: operationState } : {}) };
    }
    return {
      status: 'completed', resultState: 'verified',
      evidencePayload: {
        kind: 'provider-ready.v1', subscriptionId: bindings.subscriptionId, tenantId: bindings.tenantId, principalId: config.principalId,
        resourceInventoryDigest: inventory.sourceDigest, resources: inventory.resources, observations, retainedCapability: true
      },
      liveReadback: observations.map((entry) => readbackProof(input, 'azure', 'provider', entry.resourceId, entry)),
      outputs: { values: { 'azure.providers.ready': true, 'azure.providers.resourceInventoryDigest': inventory.sourceDigest },
        resources: observations.map((entry) => ({ provider: 'azure', resourceType: 'provider', resourceId: entry.resourceId })) },
      completedOperations
    };
  } catch (error) {
    if (!(error instanceof AzureArmError) && !(error instanceof AzureActivationAdmissionError) && !(error instanceof UpdatePreviewError)) throw error;
    return { status: 'blocked', blocker: error.message, completedOperations, ...(operationState ? { operation: operationState } : {}) };
  }
}
