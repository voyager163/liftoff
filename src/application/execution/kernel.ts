import path from 'node:path';
import {
  applyReviewedUpdateTransaction, type ReviewedUpdateTransactionOptions,
  type ReviewedUpdateTransactionOutcome
} from '../../adapters/filesystem/reviewed-update-transaction.js';
import type { ProjectFileMutation } from '../../adapters/filesystem/project-transaction.js';
import { withProjectMutationLock } from '../../adapters/filesystem/project-lock.js';
import {
  buildUnifiedOperationOutcome, type OperationEffect, type UnifiedOperationOutcome
} from '../../domain/execution/operation-outcome.js';
import { assertReviewedReadback, assertReviewedSnapshotsCurrent, captureReviewedTarget } from './plan-binding.js';
import { assertNoConflictingTransactions, type ExecutionExclusionOptions } from './cross-writers.js';
import {
  requestPlanApproval, type PlanApprovalContext, type PlanApprovalRequest, type PlanApprovalResult
} from './approval.js';
import type { SupportedJournalKind } from './journal-adapter.js';

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

interface IssuedApproval {
  kind: SupportedJournalKind;
  fingerprint: string;
  target: Awaited<ReturnType<typeof captureReviewedTarget>>;
  issuedAt: string;
  used: boolean;
}

const issuedApprovals = new WeakMap<object, IssuedApproval>();

export async function requestReviewedFileApproval(
  request: PlanApprovalRequest & { projectRoot: string; kind: SupportedJournalKind },
  context: PlanApprovalContext
): Promise<PlanApprovalResult> {
  if (request.kind !== 'update' && request.kind !== 'repair') {
    throw new AuthorizationError('Only reviewed update and repair file approval is adapted by this kernel.');
  }
  const target = await captureReviewedTarget(request.projectRoot);
  const result = Object.freeze(await requestPlanApproval({
    ...request, message: request.message ?? `Apply this exact ${request.kind} plan (${request.fingerprint})?`
  }, context));
  if (result.status === 'approved') {
    issuedApprovals.set(result, {
      kind: request.kind, fingerprint: result.fingerprint, target,
      issuedAt: new Date().toISOString(), used: false
    });
  }
  return result;
}

export interface ReviewedExecutionOptions extends Pick<ReviewedUpdateTransactionOptions,
  'planFingerprint' | 'approvalStore' | 'preconditions' | 'repairIdentity' | 'onBeforeMutation' | 'onCheckpoint'> {
  transactionKind?: SupportedJournalKind;
  approval: PlanApprovalResult;
  preconditions: NonNullable<ReviewedUpdateTransactionOptions['preconditions']>;
  validatePlan(): Promise<void>;
  verifyCommitted(): Promise<void>;
  storage?: ExecutionExclusionOptions['storage'];
}

export interface ReviewedExecutionOutcome extends ReviewedUpdateTransactionOutcome {
  operation: UnifiedOperationOutcome;
}

export async function assertReviewedFileApprovalCurrent(
  projectRoot: string, kind: SupportedJournalKind, fingerprint: string, result: PlanApprovalResult
): Promise<void> {
  const approval = typeof result === 'object' && result !== null ? issuedApprovals.get(result) : undefined;
  if (!approval || approval.used || approval.kind !== kind || approval.fingerprint !== fingerprint) {
    throw new AuthorizationError('The exact issued file approval is missing, already used, or belongs to another operation.');
  }
  const target = await captureReviewedTarget(projectRoot);
  if (target.root !== approval.target.root) throw new AuthorizationError('File approval belongs to another project target.');
  await approval.target.assertCurrent();
}

/**
 * File execution is the released sealed transaction, not a callback-based writer.
 * Command coordinators retain their own inspection, receipt and action-specific
 * preparation/verification consent. Native upgrade and init do not use this API.
 */
export async function applyReviewedExecution(
  projectRoot: string, mutations: readonly ProjectFileMutation[], options: ReviewedExecutionOptions
): Promise<ReviewedExecutionOutcome> {
  const kind = options.transactionKind ?? 'update';
  const approval = typeof options.approval === 'object' && options.approval !== null
    ? issuedApprovals.get(options.approval) : undefined;
  if (!approval || approval.used || approval.kind !== kind ||
      approval.fingerprint !== options.planFingerprint || options.approval.status !== 'approved' ||
      typeof options.validatePlan !== 'function' || typeof options.verifyCommitted !== 'function' ||
      !Array.isArray(options.preconditions)) {
    throw new AuthorizationError('Execution requires the exact issued file-scope approval, current reviewed preconditions and registered readback; flags or Boolean consent are not authority.');
  }
  const target = approval.target;
  if (!Array.isArray(mutations) || mutations.length > 1024 || options.preconditions.length > 4096) {
    throw new AuthorizationError('Reviewed file execution has an invalid or oversized mutation/precondition inventory.');
  }
  const selected = mutations.map((mutation): ProjectFileMutation => mutation.type === 'write'
    ? { ...mutation, pathParts: [...mutation.pathParts], content: Buffer.from(mutation.content) }
    : { ...mutation, pathParts: [...mutation.pathParts] });
  const preconditions = options.preconditions.map((snapshot) => ({
    ...snapshot, pathParts: [...snapshot.pathParts],
    ...(snapshot.content === undefined ? {} : { content: Buffer.from(snapshot.content) })
  }));
  const { approvalStore, validatePlan, verifyCommitted, onBeforeMutation, onCheckpoint } = options;
  const repairIdentity = options.repairIdentity === undefined ? undefined : structuredClone(options.repairIdentity);
  const approvedEffects: OperationEffect[] = selected.map((mutation) => ({
    type: mutation.type === 'write' ? 'file-write' : 'file-delete',
    target: path.join(target.root, ...mutation.pathParts), timestamp: approval.issuedAt, verified: false
  }));
  buildUnifiedOperationOutcome({
    operationId: approval.fingerprint, command: kind, status: 'blocked', approvedEffects
  });
  await assertReviewedFileApprovalCurrent(projectRoot, kind, approval.fingerprint, options.approval);
  approval.used = true;
  const exclusion = { currentCommand: kind, storage: options.storage };
  await assertNoConflictingTransactions(projectRoot, exclusion);
  let settled: ReviewedExecutionOutcome | undefined;
  try {
    return await withProjectMutationLock(projectRoot, async () => {
      const readback: { status: 'not-run' | 'passed' | 'failed' } = { status: 'not-run' };
      const result = await applyReviewedUpdateTransaction(projectRoot, selected, {
        transactionKind: kind, repairIdentity, planFingerprint: approval.fingerprint, approvalStore,
        preconditions, onBeforeMutation,
        validatePlan: async () => {
          await approval.target.assertCurrent();
          await assertNoConflictingTransactions(projectRoot, exclusion);
          await validatePlan();
          await assertReviewedSnapshotsCurrent(projectRoot, preconditions);
          await approval.target.assertCurrent();
        },
        onCheckpoint: async (checkpoint) => {
          await onCheckpoint?.(checkpoint);
          if (checkpoint.phase !== 'committed') return;
          readback.status = 'failed';
          await approval.target.assertCurrent();
          await verifyCommitted();
          await approval.target.assertCurrent();
          readback.status = 'passed';
        }
      });
      let finalReadbackFailure: string | undefined;
      if (result.committed && readback.status === 'passed') {
        try {
          await assertReviewedReadback(projectRoot, selected, preconditions);
          await approval.target.assertCurrent();
        } catch (error) {
          readback.status = 'failed';
          finalReadbackFailure = error instanceof Error ? error.message : String(error);
        }
      }
      const remainingWork = [...result.rollbackFailures, ...result.cleanupFailures,
        ...(finalReadbackFailure ? [finalReadbackFailure] : [])];
      const operation = buildUnifiedOperationOutcome({
        operationId: result.transactionDigest ?? approval.fingerprint,
        command: kind, status: result.committed || selected.length === 0 ? 'completed' : 'failed',
        approvedEffects,
        committedEffects: result.committed ? approvedEffects.map((effect) => ({ ...effect, verified: readback.status === 'passed' })) : [],
        verification: selected.length === 0 ? 'not-required' : readback.status,
        cleanup: result.rollbackFailures.length || result.cleanupFailures.length ? 'retained' : 'completed',
        remainingWork
      });
      settled = { ...result, operation, cleanupFailures: [...result.cleanupFailures, ...(finalReadbackFailure ? [finalReadbackFailure] : [])] };
      return settled;
    });
  } catch (error) {
    if (!settled?.committed) throw error;
    const failure = `Project mutation lock cleanup: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ...settled, cleanupFailures: [...settled.cleanupFailures, failure],
      operation: buildUnifiedOperationOutcome({
        ...settled.operation, status: 'partial', cleanup: 'retained',
        remainingWork: [...settled.operation.remainingWork, failure]
      })
    };
  }
}
