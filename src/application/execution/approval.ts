import type { Readable } from 'node:stream';
import { hasUsableApprovalTerminal } from '../update/approval.js';

export { hasUsableApprovalTerminal };
export {
  createSkillsTransactionApprovalStore,
  createSkillsOwnershipAuthorityStore
} from '../../adapters/filesystem/update-previews.js';

export interface PlanApprovalRequest {
  fingerprint: string;
  approvePlan?: string;
  message?: string;
}

export type PlanApprovalPrompt = (
  config: { message: string; default: false },
  context: { input: Readable; output: NodeJS.WritableStream }
) => Promise<boolean>;

export interface PlanApprovalContext {
  stdin?: Readable;
  stderr: NodeJS.WritableStream;
  approvePlan?: PlanApprovalPrompt;
}

export type PlanApprovalResult =
  | { status: 'approved'; fingerprint: string; method: 'fingerprint' | 'interactive' }
  | { status: 'required'; fingerprint: string }
  | { status: 'declined'; fingerprint: string; reason: 'declined' | 'cancelled' }
  | { status: 'mismatch'; fingerprint: string; requestedFingerprint: string };

export class InvalidPlanApprovalError extends Error {
  constructor(readonly field: 'fingerprint' | 'approvePlan') {
    super(
      `${field === 'fingerprint' ? 'The reviewed plan fingerprint' : 'Flag --approve-plan'} ` +
        'must contain exactly 64 lowercase hexadecimal characters.'
    );
    this.name = 'InvalidPlanApprovalError';
  }
}

export function isPlanFingerprint(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/u.test(value);
}

function isPromptCancellation(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'ExitPromptError' ||
    error.name === 'AbortPromptError' ||
    error.name === 'InteractiveCancelledError'
  );
}

/**
 * Enforces canonical plan approval:
 * - Machine execution: requires exact --approve-plan <fingerprint> matching the 64-char hex plan fingerprint.
 * - Terminal execution: displays immutable plan and requests interactive Yes/No with default No.
 * - Non-interactive / piped / model-generated execution without exact fingerprint: returns status: 'required'. Never infers approval from generic boolean Yes.
 */
export async function requestPlanApproval(
  { fingerprint, approvePlan, message }: PlanApprovalRequest,
  context: PlanApprovalContext
): Promise<PlanApprovalResult> {
  if (!isPlanFingerprint(fingerprint)) {
    throw new InvalidPlanApprovalError('fingerprint');
  }

  if (approvePlan !== undefined) {
    if (!isPlanFingerprint(approvePlan)) {
      throw new InvalidPlanApprovalError('approvePlan');
    }
    return approvePlan === fingerprint
      ? { status: 'approved', fingerprint, method: 'fingerprint' }
      : { status: 'mismatch', fingerprint, requestedFingerprint: approvePlan };
  }

  if (!hasUsableApprovalTerminal(context)) {
    return { status: 'required', fingerprint };
  }

  const input = context.stdin;
  const output = context.stderr;

  try {
    const prompt = context.approvePlan ?? (await import('@inquirer/prompts')).confirm;
    const approved = await prompt({
      message: message ?? `Apply this exact reviewed plan (${fingerprint})?`,
      default: false
    }, { input, output });
    return approved === true
      ? { status: 'approved', fingerprint, method: 'interactive' }
      : { status: 'declined', fingerprint, reason: 'declined' };
  } catch (error) {
    if (isPromptCancellation(error)) {
      return { status: 'declined', fingerprint, reason: 'cancelled' };
    }
    throw error;
  }
}
