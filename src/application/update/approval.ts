import type { Readable } from 'node:stream';

export interface UpdateApprovalRequest {
  fingerprint: string;
  approvePlan?: string;
}

export type UpdateApprovalPrompt = (
  config: { message: string; default: false },
  context: { input: Readable; output: NodeJS.WritableStream }
) => Promise<boolean>;

export interface UpdateApprovalContext {
  stdin?: Readable;
  stderr: NodeJS.WritableStream;
  approveUpdatePlan?: UpdateApprovalPrompt;
}

export type UpdateApprovalResult =
  | { status: 'approved'; fingerprint: string; method: 'fingerprint' | 'interactive' }
  | { status: 'required'; fingerprint: string }
  | { status: 'declined'; fingerprint: string; reason: 'declined' | 'cancelled' }
  | { status: 'mismatch'; fingerprint: string; requestedFingerprint: string };

export class InvalidUpdateApprovalError extends Error {
  constructor(readonly field: 'fingerprint' | 'approvePlan') {
    super(
      `${field === 'fingerprint' ? 'The current update plan fingerprint' : 'Flag --approve-plan'} ` +
        'must contain exactly 64 lowercase hexadecimal characters.'
    );
    this.name = 'InvalidUpdateApprovalError';
  }
}

export function isUpdatePlanFingerprint(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/u.test(value);
}

function isPromptCancellation(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'ExitPromptError' ||
    error.name === 'AbortPromptError' ||
    error.name === 'InteractiveCancelledError'
  );
}

// Consent only: the caller must match a preview first and recheck the plan under the project lock before writes.
export async function requestUpdateApproval(
  { fingerprint, approvePlan }: UpdateApprovalRequest,
  context: UpdateApprovalContext
): Promise<UpdateApprovalResult> {
  if (!isUpdatePlanFingerprint(fingerprint)) {
    throw new InvalidUpdateApprovalError('fingerprint');
  }
  if (approvePlan !== undefined) {
    if (!isUpdatePlanFingerprint(approvePlan)) {
      throw new InvalidUpdateApprovalError('approvePlan');
    }
    return approvePlan === fingerprint
      ? { status: 'approved', fingerprint, method: 'fingerprint' }
      : { status: 'mismatch', fingerprint, requestedFingerprint: approvePlan };
  }

  const input = context.stdin as (Readable & { isTTY?: boolean }) | undefined;
  const output = context.stderr as NodeJS.WritableStream & {
    isTTY?: boolean;
    destroyed?: boolean;
    writableEnded?: boolean;
  };
  if (
    !input || input.isTTY !== true || input.destroyed || input.readableEnded || !input.readable ||
    output.isTTY !== true || output.destroyed || output.writableEnded || !output.writable
  ) {
    return { status: 'required', fingerprint };
  }

  try {
    const prompt = context.approveUpdatePlan ?? (await import('@inquirer/prompts')).confirm;
    const approved = await prompt({
      message: `Apply this exact update plan (${fingerprint})?`,
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
