import { isRecord } from '../governance/activation/canonical-json.js';

export type OperationStatus = 'completed' | 'failed' | 'interrupted' | 'blocked' | 'partial';
export type VerificationStatus = 'not-run' | 'not-required' | 'passed' | 'failed' | 'uncertain' | 'n/a';
export type CleanupStatus = 'completed' | 'retained' | 'failed' | 'not-required' | 'n/a';

export type EffectType =
  | 'file-write'
  | 'file-delete'
  | 'directory-create'
  | 'directory-remove'
  | 'process-execution'
  | 'network-mutation'
  | 'state-transition';

export interface OperationEffect {
  type: EffectType;
  target: string;
  description?: string;
  timestamp: string;
  verified: boolean;
}

export interface UnifiedOperationOutcome {
  schemaVersion: 1;
  operationId: string;
  command: string;
  status: OperationStatus;
  approvedEffects: readonly OperationEffect[];
  committedEffects: readonly OperationEffect[];
  verification: VerificationStatus;
  cleanup: CleanupStatus;
  remainingWork: readonly string[];
  failureReason?: string;
  uncertainSettlement?: boolean;
}

export interface CreateOperationOutcomeInput {
  operationId: string;
  command: string;
  status: OperationStatus;
  approvedEffects?: readonly OperationEffect[];
  committedEffects?: readonly OperationEffect[];
  verification?: VerificationStatus;
  cleanup?: CleanupStatus;
  remainingWork?: readonly string[];
  failureReason?: string;
  uncertainSettlement?: boolean;
}

export function operationFailureOutcome(input: {
  committed: boolean;
  attemptedEffects?: boolean;
  rollbackFailures?: readonly string[];
  uncertainSettlement?: boolean;
}): { status: 'partial' | 'failed'; verification: 'incomplete' | 'not-run' } {
  const hasEffects = input.committed || input.attemptedEffects === true ||
    (input.rollbackFailures?.length ?? 0) > 0 || input.uncertainSettlement === true;
  return { status: hasEffects ? 'partial' : 'failed', verification: hasEffects ? 'incomplete' : 'not-run' };
}

/**
 * Builds a unified operation outcome, enforcing strict invariants:
 * 1. If committed effects exist but verification or cleanup failed, status cannot be 'completed'.
 * 2. Earlier approved effects and committed effects are never erased or collapsed.
 * 3. Uncertain settlement blocks 'completed' status and forces verification to 'uncertain'.
 */
export function buildUnifiedOperationOutcome(input: CreateOperationOutcomeInput): UnifiedOperationOutcome {
  const approvedEffects = (input.approvedEffects ?? []).map((effect) => ({ ...effect }));
  const committedEffects = (input.committedEffects ?? []).map((effect) => ({ ...effect }));
  const remainingWork = [...input.remainingWork ?? []];
  let verification: VerificationStatus = input.verification ?? 'not-run';
  let cleanup: CleanupStatus = input.cleanup ?? 'not-required';
  let status: OperationStatus = input.status;
  const uncertainSettlement = input.uncertainSettlement === true;

  // If settlement is uncertain, verification cannot be 'passed' and status cannot be 'completed'
  if (uncertainSettlement) {
    verification = 'uncertain';
    cleanup = 'retained';
    if (status === 'completed') {
      status = committedEffects.length > 0 ? 'partial' : 'failed';
    }
  }

  // If verification failed or is uncertain, but effects were committed, status is partial or failed, not completed
  if ((verification === 'failed' || verification === 'uncertain') && status === 'completed') {
    status = committedEffects.length > 0 ? 'partial' : 'failed';
  }

  // If cleanup failed or remaining work exists, status cannot be completed
  if ((cleanup === 'failed' || cleanup === 'retained' || remainingWork.length > 0 || input.failureReason !== undefined ||
       committedEffects.length > 0 && verification === 'not-run') && status === 'completed') {
    status = 'partial';
  }

  // If effects were committed but an error occurred, preserve status as partial (not collapsed to failed with 0 effects)
  if (committedEffects.length > 0 && status === 'failed') {
    status = 'partial';
  }

  return validateUnifiedOperationOutcome({
    schemaVersion: 1,
    operationId: input.operationId,
    command: input.command,
    status,
    approvedEffects,
    committedEffects,
    verification,
    cleanup,
    remainingWork,
    failureReason: input.failureReason,
    uncertainSettlement: uncertainSettlement ? true : undefined
  });
}

export function validateUnifiedOperationOutcome(value: unknown): UnifiedOperationOutcome {
  if (!isRecord(value)) {
    throw new Error('UnifiedOperationOutcome must be a non-null object.');
  }

  if (value.schemaVersion !== 1) {
    throw new Error(`Unsupported outcome schemaVersion: ${value.schemaVersion}. Expected 1.`);
  }

  if (typeof value.operationId !== 'string' || value.operationId.trim().length === 0) {
    throw new Error('UnifiedOperationOutcome: operationId must be a non-empty string.');
  }

  if (typeof value.command !== 'string' || value.command.trim().length === 0) {
    throw new Error('UnifiedOperationOutcome: command must be a non-empty string.');
  }

  const validStatuses: OperationStatus[] = ['completed', 'failed', 'interrupted', 'blocked', 'partial'];
  if (!validStatuses.includes(value.status as OperationStatus)) {
    throw new Error(`UnifiedOperationOutcome: invalid status: ${value.status}`);
  }

  if (!Array.isArray(value.approvedEffects) || !Array.isArray(value.committedEffects)) {
    throw new Error('UnifiedOperationOutcome: approvedEffects and committedEffects must be arrays.');
  }
  const effects = (items: unknown[]): OperationEffect[] => {
    if (items.length > 4096) throw new Error('UnifiedOperationOutcome effects exceed the bounded inventory.');
    return items.map((item) => {
      if (!isRecord(item) ||
          !['file-write', 'file-delete', 'directory-create', 'directory-remove', 'process-execution', 'network-mutation', 'state-transition'].includes(String(item.type)) ||
          typeof item.target !== 'string' || !item.target || /[\u0000-\u001f\u007f]/u.test(item.target) ||
          typeof item.timestamp !== 'string' || !Number.isFinite(Date.parse(item.timestamp)) ||
          new Date(item.timestamp).toISOString() !== item.timestamp || typeof item.verified !== 'boolean' ||
          item.description !== undefined && typeof item.description !== 'string' ||
          Object.keys(item).some((key) => !['type', 'target', 'timestamp', 'verified', 'description'].includes(key))) {
        throw new Error('UnifiedOperationOutcome contains an invalid effect.');
      }
      return { ...item } as unknown as OperationEffect;
    });
  };
  const approvedEffects = effects(value.approvedEffects), committedEffects = effects(value.committedEffects);
  if (!['not-run', 'not-required', 'passed', 'failed', 'uncertain', 'n/a'].includes(String(value.verification)) ||
      !['completed', 'retained', 'failed', 'not-required', 'n/a'].includes(String(value.cleanup)) ||
      !Array.isArray(value.remainingWork) || value.remainingWork.length > 4096 ||
      value.remainingWork.some((item) => typeof item !== 'string' || !item) ||
      value.failureReason !== undefined && typeof value.failureReason !== 'string' ||
      value.uncertainSettlement !== undefined && typeof value.uncertainSettlement !== 'boolean') {
    throw new Error('UnifiedOperationOutcome contains invalid verification, cleanup or remaining work.');
  }
  if (Object.keys(value).some((key) => !['schemaVersion', 'operationId', 'command', 'status', 'approvedEffects',
    'committedEffects', 'verification', 'cleanup', 'remainingWork', 'failureReason', 'uncertainSettlement'].includes(key))) {
    throw new Error('UnifiedOperationOutcome has unrecognized fields.');
  }
  if (value.uncertainSettlement === true && (value.verification !== 'uncertain' || value.cleanup !== 'retained') ||
      value.status === 'completed' && (value.uncertainSettlement === true ||
        ['failed', 'uncertain'].includes(String(value.verification)) || ['retained', 'failed'].includes(String(value.cleanup)) ||
        value.remainingWork.length > 0 || value.failureReason !== undefined ||
        committedEffects.length > 0 && value.verification === 'not-run') ||
      value.status === 'failed' && committedEffects.length > 0) {
    throw new Error('UnifiedOperationOutcome contradicts its recorded effects or incomplete settlement.');
  }
  return { ...value, approvedEffects, committedEffects, remainingWork: [...value.remainingWork] } as unknown as UnifiedOperationOutcome;
}
