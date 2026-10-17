import type {
  ExternalOperationState, LiveReadbackProof, SavedTransitionPlan, TransitionOperation
} from '../domain/governance/activation/types.js';

const maximumHandleTextLength = 2_048;
const maximumOperationAgeMs = 24 * 60 * 60 * 1_000;
const maximumObservationAgeMs = 10 * 60 * 1_000;
const maximumFutureSkewMs = 60_000;

function boundedHandleText(value: string, label: string): void {
  if (!value || value.length > maximumHandleTextLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a bounded printable provider identity.`);
  }
}

function providerForOperation(operation: TransitionOperation): ExternalOperationState['provider'] | null {
  if (operation.adapter === 'azure-opentofu') return 'azure';
  if (operation.adapter === 'github') return 'github';
  return null;
}

function resourceMatchesDestination(operation: TransitionOperation, resourceId: string): boolean {
  const normalized = resourceId.toLowerCase();
  const destination = operation.destination;
  if (destination.type === 'subscription') {
    return normalized === `/subscriptions/${destination.subscriptionId}`.toLowerCase() ||
      normalized.startsWith(`/subscriptions/${destination.subscriptionId}/`.toLowerCase());
  }
  if (destination.type === 'repository') {
    const repository = destination.repository?.toLowerCase();
    return Boolean(repository && (
      normalized === repository ||
      normalized.startsWith(`${repository}/`) ||
      normalized.includes(`/repos/${repository}`)
    ));
  }
  const identity = destination.identity.toLowerCase();
  return normalized === identity || normalized.startsWith(`${identity}/`);
}

function operationReadback(
  operation: ExternalOperationState,
  liveReadback: readonly LiveReadbackProof[] | undefined
): LiveReadbackProof | undefined {
  return liveReadback?.find((proof) =>
    proof.provider === operation.provider &&
    proof.resourceId.toLowerCase() === operation.resourceId.toLowerCase() &&
    proof.matches &&
    proof.sourceDigest === proof.readbackDigest);
}

export function validateExternalOperationCheckpoint(input: {
  plan: SavedTransitionPlan;
  operation: ExternalOperationState;
  previous?: ExternalOperationState;
  liveReadback?: readonly LiveReadbackProof[];
  observedAt: Date;
}): ExternalOperationState {
  const planned = input.plan.operations.find((operation) =>
    operation.actionId === input.operation.actionId && operation.remote);
  if (!planned) {
    throw new Error('The reported external operation has no corresponding action in the reviewed plan.');
  }
  const expectedProvider = providerForOperation(planned);
  if (!expectedProvider || input.operation.provider !== expectedProvider) {
    throw new Error('The reported external operation provider does not match the reviewed action adapter.');
  }
  for (const [value, label] of [
    [input.operation.actionId, 'External operation actionId'],
    [input.operation.operationId, 'External operation operationId'],
    [input.operation.resourceId, 'External operation resourceId']
  ] as const) {
    boundedHandleText(value, label);
  }
  if (!resourceMatchesDestination(planned, input.operation.resourceId)) {
    throw new Error('The reported external operation resource is outside the reviewed destination.');
  }
  const startedAt = Date.parse(input.operation.startedAt);
  const observedAt = Date.parse(input.operation.observedAt);
  const now = input.observedAt.getTime();
  if (!Number.isFinite(startedAt) || !Number.isFinite(observedAt) || observedAt < startedAt ||
    startedAt > now + maximumFutureSkewMs || observedAt > now + maximumFutureSkewMs) {
    throw new Error('The reported external operation timestamps are invalid or in the future.');
  }
  if (now - startedAt > maximumOperationAgeMs || now - observedAt > maximumObservationAgeMs) {
    throw new Error('The reported external operation handle is stale; inspect current ownership and approve recovery.');
  }
  const readback = operationReadback(input.operation, input.liveReadback);
  if (input.previous) {
    const readbackObservedAt = readback ? Date.parse(readback.observedAt) : Number.NaN;
    if (!Number.isFinite(readbackObservedAt) || readbackObservedAt < observedAt ||
      readbackObservedAt > now + maximumFutureSkewMs || now - readbackObservedAt > maximumObservationAgeMs) {
      throw new Error('The reported external operation requires a current matching provider readback.');
    }
    const stableFields = ['provider', 'actionId', 'operationId', 'resourceId', 'startedAt', 'pollUrl'] as const;
    if (stableFields.some((field) => (input.previous?.[field] ?? null) !== (input.operation[field] ?? null))) {
      throw new Error('The resumed external operation does not match the exact recorded provider handle.');
    }
    if (Date.parse(input.operation.observedAt) <= Date.parse(input.previous.observedAt) ||
      readbackObservedAt <= Date.parse(input.previous.observedAt)) {
      throw new Error('The resumed external operation was not freshly reobserved.');
    }
  }
  return {
    ...input.operation,
    planDigest: input.previous?.planDigest ?? input.plan.planDigest
  };
}
