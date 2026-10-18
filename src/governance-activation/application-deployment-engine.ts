import {
  canonicalSha256, isRecord
} from '../domain/governance/activation/canonical-json.js';
import type { ExternalOperationState } from '../domain/governance/activation/types.js';
import { applicationError } from './application-readiness.js';
import {
  protectedApplicationAcceptedCheckpoint,
  protectedApplicationTerminalCheckpoint,
  protectedApplicationWriteObservationRequest,
  validateProtectedApplicationAcceptedCheckpoint,
  validateProtectedApplicationExecutionIntent,
  validateProtectedApplicationReadResult,
  validateProtectedApplicationTerminalCheckpoint,
  validateProtectedApplicationWriteResult,
  type ApplicationDeploymentReadback,
  type ApplicationStateMappingProof,
  type ProtectedApplicationCompletionProof,
  type ProtectedApplicationExecutionCheckpoints,
  type ProtectedApplicationExecutionFailureReason,
  type ProtectedApplicationExecutionProvenance,
  type ProtectedApplicationNoEffectResult,
  type ProtectedApplicationPlanProof,
  type ProtectedApplicationReadRequest,
  type ProtectedApplicationReadResult,
  type ProtectedApplicationRetainedCheckpoints,
  type ProtectedApplicationTerminalCheckpoint,
  type ProtectedApplicationWriteDispatchRequest,
  type ProtectedApplicationWriteObservationRequest,
  type ProtectedApplicationWriteRequest,
  type ProtectedApplicationWriteResult
} from './application-deployment.js';

const emptyCheckpoints = Object.freeze({
  intent: null,
  accepted: null,
  terminal: null
}) satisfies ProtectedApplicationRetainedCheckpoints;

export interface ProtectedApplicationCheckpointStore
  extends ProtectedApplicationExecutionCheckpoints {
  load(requestDigest: string): Promise<ProtectedApplicationRetainedCheckpoints>;
}

export type ProtectedApplicationWritePreflightResult =
  | ProtectedApplicationNoEffectResult
  | {
    status: 'ready';
    effect: 'none';
    requestDigest: string;
  };

export interface ProtectedApplicationWriteObservation {
  acceptedOperation: ExternalOperationState;
  currentOperation: ExternalOperationState;
}

export type ProtectedApplicationWriteFinalizationResult =
  | {
    status: 'failed';
    reason: ProtectedApplicationExecutionFailureReason;
  }
  | {
    status: 'completed';
    provenance: ProtectedApplicationExecutionProvenance;
    plan: ProtectedApplicationPlanProof;
    mappings: readonly ApplicationStateMappingProof[];
    completion: ProtectedApplicationCompletionProof;
  };

export interface ProtectedApplicationWriteExecutionPort {
  preflight(
    request: ProtectedApplicationWriteDispatchRequest
  ): Promise<ProtectedApplicationWritePreflightResult>;
  dispatch(
    request: ProtectedApplicationWriteDispatchRequest
  ): Promise<ExternalOperationState>;
  observe(
    request: ProtectedApplicationWriteObservationRequest
  ): Promise<ProtectedApplicationWriteObservation>;
  finalize(
    request: ProtectedApplicationWriteObservationRequest,
    terminal: ProtectedApplicationTerminalCheckpoint
  ): Promise<ProtectedApplicationWriteFinalizationResult>;
}

export interface ProtectedApplicationReadObservationPort {
  observe(request: ProtectedApplicationReadRequest): Promise<ApplicationDeploymentReadback>;
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return canonicalSha256(Object.keys(value).sort()) ===
    canonicalSha256([...keys].sort());
}

function sameOperationIdentity(
  left: ExternalOperationState,
  right: ExternalOperationState
): boolean {
  return left.provider === right.provider &&
    left.actionId === right.actionId &&
    left.operationId === right.operationId &&
    left.resourceId.toLowerCase() === right.resourceId.toLowerCase() &&
    left.startedAt === right.startedAt &&
    left.planDigest === right.planDigest;
}

function validateRetainedCheckpoints(
  request: ProtectedApplicationWriteRequest,
  retained: ProtectedApplicationRetainedCheckpoints
): ProtectedApplicationRetainedCheckpoints {
  if (!exactKeys(retained, ['intent', 'accepted', 'terminal']) ||
    retained.intent === null && (retained.accepted !== null || retained.terminal !== null) ||
    retained.accepted === null && retained.terminal !== null) {
    return applicationError(
      'application-deployment-checkpoint',
      'The application checkpoint store returned an incomplete retained checkpoint sequence.'
    );
  }
  if (retained.intent) {
    validateProtectedApplicationExecutionIntent(
      request.binding,
      request.source,
      request.plan,
      request.provenance,
      request.executionAuthority,
      request.stateAuthority,
      request.invocation,
      retained.intent
    );
    if (canonicalSha256(retained.intent) !== canonicalSha256(request.intent)) {
      return applicationError(
        'application-deployment-checkpoint',
        'The application checkpoint store changed the original pre-effect intent.'
      );
    }
  }
  if (retained.accepted) {
    validateProtectedApplicationAcceptedCheckpoint(request, retained.accepted);
  }
  if (retained.terminal) {
    validateProtectedApplicationTerminalCheckpoint(
      request, retained.accepted!, retained.terminal
    );
  }
  return retained;
}

async function retainedCheckpoints(
  request: ProtectedApplicationWriteRequest,
  store: ProtectedApplicationCheckpointStore
): Promise<ProtectedApplicationRetainedCheckpoints> {
  return validateRetainedCheckpoints(
    request,
    await store.load(request.intent.requestDigest)
  );
}

function observationRequest(
  request: ProtectedApplicationWriteRequest,
  retained: ProtectedApplicationRetainedCheckpoints
): ProtectedApplicationWriteObservationRequest {
  return protectedApplicationWriteObservationRequest(
    request.binding,
    request.source,
    request.plan,
    request.provenance,
    request.executionAuthority,
    request.stateAuthority,
    request.invocation,
    retained
  );
}

function resultRequest(
  request: ProtectedApplicationWriteRequest,
  retained: ProtectedApplicationRetainedCheckpoints
): ProtectedApplicationWriteRequest {
  return request.execution === 'observe'
    ? observationRequest(request, retained)
    : request;
}

function uncertainIntentResult(
  request: ProtectedApplicationWriteRequest,
  retained: ProtectedApplicationRetainedCheckpoints,
  reason: ProtectedApplicationExecutionFailureReason
): ProtectedApplicationWriteResult {
  if (!retained.intent) {
    return applicationError(
      'application-deployment-checkpoint',
      'An application uncertainty result requires its durable original intent.'
    );
  }
  return validateProtectedApplicationWriteResult(resultRequest(request, retained), {
    status: 'uncertain',
    effect: 'intent',
    reason,
    intent: retained.intent
  }, retained);
}

function acceptedResult(
  request: ProtectedApplicationWriteRequest,
  retained: ProtectedApplicationRetainedCheckpoints
): ProtectedApplicationWriteResult {
  if (!retained.intent || !retained.accepted) {
    return applicationError(
      'application-deployment-checkpoint',
      'An accepted application result requires its durable intent and provider handle.'
    );
  }
  return validateProtectedApplicationWriteResult(resultRequest(request, retained), {
    status: 'accepted',
    effect: 'accepted',
    operation: retained.accepted.operation,
    intent: retained.intent,
    accepted: retained.accepted
  }, retained);
}

function acceptedFailureResult(
  request: ProtectedApplicationWriteRequest,
  retained: ProtectedApplicationRetainedCheckpoints,
  reason: ProtectedApplicationExecutionFailureReason
): ProtectedApplicationWriteResult {
  if (!retained.intent || !retained.accepted) {
    return applicationError(
      'application-deployment-checkpoint',
      'A post-acceptance application failure requires its durable original handle.'
    );
  }
  return validateProtectedApplicationWriteResult(resultRequest(request, retained), {
    status: 'failed',
    effect: 'accepted',
    reason,
    operation: retained.accepted.operation,
    intent: retained.intent,
    accepted: retained.accepted
  }, retained);
}

function terminalFailureResult(
  request: ProtectedApplicationWriteRequest,
  retained: ProtectedApplicationRetainedCheckpoints,
  reason: ProtectedApplicationExecutionFailureReason
): ProtectedApplicationWriteResult {
  if (!retained.intent || !retained.accepted || !retained.terminal) {
    return applicationError(
      'application-deployment-checkpoint',
      'A post-terminal application failure requires its complete durable checkpoint sequence.'
    );
  }
  return validateProtectedApplicationWriteResult(resultRequest(request, retained), {
    status: 'failed',
    effect: 'terminal',
    reason,
    operation: retained.terminal.operation,
    intent: retained.intent,
    accepted: retained.accepted,
    terminal: retained.terminal
  }, retained);
}

async function persistIntent(
  request: ProtectedApplicationWriteDispatchRequest,
  store: ProtectedApplicationCheckpointStore
): Promise<{
  retained: ProtectedApplicationRetainedCheckpoints;
  recorded: boolean;
}> {
  let recorded = true;
  try {
    await store.recordIntent(request.intent);
  } catch {
    recorded = false;
  }
  return {
    retained: await retainedCheckpoints(request, store),
    recorded
  };
}

async function persistAccepted(
  request: ProtectedApplicationWriteRequest,
  operation: ExternalOperationState,
  store: ProtectedApplicationCheckpointStore,
  now: () => Date
): Promise<ProtectedApplicationRetainedCheckpoints> {
  const checkpoint = protectedApplicationAcceptedCheckpoint(
    request, operation, now().toISOString()
  );
  try {
    await store.recordAccepted(checkpoint);
  } catch {
    // The durable store is authoritative after an ambiguous write failure.
  }
  return retainedCheckpoints(request, store);
}

async function persistTerminal(
  request: ProtectedApplicationWriteRequest,
  retained: ProtectedApplicationRetainedCheckpoints,
  operation: ExternalOperationState,
  store: ProtectedApplicationCheckpointStore,
  now: () => Date
): Promise<ProtectedApplicationRetainedCheckpoints> {
  if (!retained.accepted) {
    return applicationError(
      'application-deployment-checkpoint',
      'Application terminal durability requires the original accepted-handle checkpoint.'
    );
  }
  const checkpoint = protectedApplicationTerminalCheckpoint(
    request, retained.accepted, operation, now().toISOString()
  );
  try {
    await store.recordTerminal(checkpoint);
  } catch {
    // The durable store is authoritative after an ambiguous write failure.
  }
  return retainedCheckpoints(request, store);
}

async function finalizeTerminalWrite(
  request: ProtectedApplicationWriteRequest,
  retained: ProtectedApplicationRetainedCheckpoints,
  port: ProtectedApplicationWriteExecutionPort
): Promise<ProtectedApplicationWriteResult> {
  if (!retained.terminal) {
    return applicationError(
      'application-deployment-checkpoint',
      'Application finalization cannot run before terminal checkpoint durability.'
    );
  }
  if (retained.terminal.operation.status === 'failed') {
    return terminalFailureResult(request, retained, 'operation-failed');
  }
  const observe = observationRequest(request, retained);
  let finalization: ProtectedApplicationWriteFinalizationResult;
  try {
    finalization = await port.finalize(observe, retained.terminal);
  } catch {
    return terminalFailureResult(request, retained, 'verification-failed');
  }
  if (finalization.status === 'failed') {
    return terminalFailureResult(request, retained, finalization.reason);
  }
  return validateProtectedApplicationWriteResult(observe, {
    status: 'completed',
    effect: 'terminal',
    action: 'application-foundation',
    operation: retained.terminal.operation,
    intent: retained.intent!,
    accepted: retained.accepted!,
    terminal: retained.terminal,
    provenance: finalization.provenance,
    plan: finalization.plan,
    mappings: finalization.mappings,
    completion: finalization.completion
  }, retained);
}

async function observeProtectedApplicationWrite(
  request: ProtectedApplicationWriteRequest,
  retained: ProtectedApplicationRetainedCheckpoints,
  port: ProtectedApplicationWriteExecutionPort,
  store: ProtectedApplicationCheckpointStore,
  now: () => Date
): Promise<ProtectedApplicationWriteResult> {
  if (retained.terminal) {
    return finalizeTerminalWrite(request, retained, port);
  }
  const observe = observationRequest(request, retained);
  let observation: ProtectedApplicationWriteObservation;
  try {
    observation = await port.observe(observe);
  } catch {
    return retained.accepted
      ? acceptedFailureResult(observe, retained, 'verification-failed')
      : uncertainIntentResult(observe, retained, 'verification-failed');
  }
  if (!exactKeys(observation, ['acceptedOperation', 'currentOperation']) ||
    observation.acceptedOperation.status !== 'running' ||
    !sameOperationIdentity(
      observation.acceptedOperation, observation.currentOperation
    ) ||
    !['running', 'completed', 'failed'].includes(
      observation.currentOperation.status
    )) {
    return applicationError(
      'application-deployment-result',
      'Application observation changed the accepted provider identity or returned an unsupported current status.'
    );
  }
  let current = retained;
  if (!current.accepted) {
    current = await persistAccepted(
      observe, observation.acceptedOperation, store, now
    );
    if (!current.accepted) {
      return uncertainIntentResult(observe, current, 'checkpoint-failed');
    }
  } else if (canonicalSha256(current.accepted.operation) !==
    canonicalSha256(observation.acceptedOperation)) {
    return applicationError(
      'application-deployment-result',
      'Application observation replaced the independently retained provider handle.'
    );
  }
  if (observation.currentOperation.status === 'running') {
    return acceptedResult(observe, current);
  }
  current = await persistTerminal(
    observe, current, observation.currentOperation, store, now
  );
  if (!current.terminal) {
    return acceptedFailureResult(observe, current, 'checkpoint-failed');
  }
  return finalizeTerminalWrite(observe, current, port);
}

export async function executeProtectedApplicationWrite(
  request: ProtectedApplicationWriteRequest,
  port: ProtectedApplicationWriteExecutionPort,
  store: ProtectedApplicationCheckpointStore,
  now: () => Date
): Promise<ProtectedApplicationWriteResult> {
  let retained = await retainedCheckpoints(request, store);
  if (retained.intent) {
    return observeProtectedApplicationWrite(
      request, retained, port, store, now
    );
  }
  if (request.execution !== 'dispatch') {
    return applicationError(
      'application-deployment-checkpoint',
      'Application observation cannot proceed without its durable original intent.'
    );
  }
  const preflight = await port.preflight(request);
  if (preflight.status === 'blocked') {
    return validateProtectedApplicationWriteResult(
      request, preflight, emptyCheckpoints
    );
  }
  if (!exactKeys(preflight, ['status', 'effect', 'requestDigest']) ||
    preflight.status !== 'ready' || preflight.effect !== 'none' ||
    preflight.requestDigest !== request.intent.requestDigest) {
    return applicationError(
      'application-deployment-result',
      'Application preflight did not bind readiness to the exact no-effect write request.'
    );
  }
  const intent = await persistIntent(request, store);
  retained = intent.retained;
  if (!retained.intent) {
    return validateProtectedApplicationWriteResult(request, {
      status: 'blocked',
      effect: 'none',
      reason: 'checkpoint-failed'
    }, emptyCheckpoints);
  }
  if (!intent.recorded) {
    return uncertainIntentResult(request, retained, 'checkpoint-failed');
  }
  let operation: ExternalOperationState;
  try {
    operation = await port.dispatch(request);
  } catch {
    return uncertainIntentResult(request, retained, 'operation-failed');
  }
  if (operation.status !== 'running') {
    return applicationError(
      'application-deployment-result',
      'Application dispatch must return the first running provider handle before observation.'
    );
  }
  retained = await persistAccepted(request, operation, store, now);
  if (!retained.accepted) {
    return uncertainIntentResult(request, retained, 'checkpoint-failed');
  }
  return acceptedResult(request, retained);
}

function validateApplicationReadObservation(
  request: ProtectedApplicationReadRequest,
  value: unknown
): ApplicationDeploymentReadback {
  if (!isRecord(value) ||
    !exactKeys(value, ['observed', 'liveReadback']) ||
    !isRecord(value.observed) ||
    !exactKeys(value.observed, [
      'kind', 'bindingDigest', 'sourceInventoryDigest', 'planDigest',
      'operationId', 'resourceGroupId', 'backendResourceId', 'backendUrl',
      'immutableImage', 'revision', 'health', 'noChangePlanDigest',
      'appliedResourceCount'
    ]) ||
    !isRecord(value.observed.health) ||
    !exactKeys(value.observed.health, [
      'endpoint', 'status', 'mediaType', 'bodyBytes', 'bodySha256',
      'parsedBodyDigest', 'observedAt'
    ]) ||
    value.observed.kind !== 'application-foundation-readback.v1' ||
    value.observed.bindingDigest !== request.binding.bindingDigest ||
    value.observed.sourceInventoryDigest !==
      request.source.sourceInventoryDigest ||
    value.observed.planDigest !== request.expectedPlanDigest ||
    value.observed.operationId !== request.admittedOperation.operationId ||
    typeof value.observed.resourceGroupId !== 'string' ||
    value.observed.resourceGroupId.toLowerCase() !==
      request.binding.resourceGroupId.toLowerCase() ||
    typeof value.observed.backendResourceId !== 'string' ||
    value.observed.backendResourceId.toLowerCase() !==
      `${request.binding.resourceGroupId}/providers/Microsoft.App/containerApps/${request.binding.expectedResourceNames.backendContainerApp}`
        .toLowerCase() ||
    value.observed.immutableImage !== request.binding.immutableImage ||
    typeof value.observed.backendUrl !== 'string' ||
    value.observed.health.endpoint !== `${value.observed.backendUrl}/health` ||
    value.observed.health.status !== 200 ||
    value.observed.health.mediaType !== 'application/json' ||
    typeof value.observed.health.bodyBytes !== 'number' ||
    !Number.isSafeInteger(value.observed.health.bodyBytes) ||
    value.observed.health.bodyBytes <= 0 ||
    value.observed.health.bodyBytes > 64 * 1024 ||
    typeof value.observed.health.bodySha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.observed.health.bodySha256) ||
    value.observed.health.parsedBodyDigest !==
      request.binding.healthTargets[0]?.parsedBodyDigest ||
    typeof value.observed.health.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.observed.health.observedAt)) ||
    typeof value.observed.noChangePlanDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.observed.noChangePlanDigest) ||
    typeof value.observed.appliedResourceCount !== 'number' ||
    !Number.isSafeInteger(value.observed.appliedResourceCount) ||
    value.observed.appliedResourceCount <
      request.binding.requiredResourceIds.length ||
    !Array.isArray(value.liveReadback) ||
    value.liveReadback.length < 2 ||
    value.liveReadback.length > 16) {
    return applicationError(
      'application-deployment-readback',
      'The protected application read observer returned malformed or differently bound workload evidence.'
    );
  }
  return value as unknown as ApplicationDeploymentReadback;
}

export async function executeProtectedApplicationRead(
  request: ProtectedApplicationReadRequest,
  port: ProtectedApplicationReadObservationPort
): Promise<ProtectedApplicationReadResult> {
  const observation = validateApplicationReadObservation(
    request, await port.observe(request)
  );
  return validateProtectedApplicationReadResult(request, {
    status: 'completed',
    effect: 'none',
    action: request.action,
    operation: request.admittedOperation,
    provenance: request.provenance,
    admittedCompletionDigest: request.admittedCompletionDigest,
    observation
  }, observation);
}
