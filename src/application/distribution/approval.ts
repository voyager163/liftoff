import {
  requestPlanApproval,
  type PlanApprovalContext,
  type PlanApprovalPrompt,
  type PlanApprovalResult,
  isPlanFingerprint
} from '../execution/approval.js';

export type { PlanApprovalPrompt };

export interface MigrationApprovalRequest {
  fingerprint: string;
  approvePlan?: string;
  message?: string;
  json?: boolean;
}

export interface MigrationApprovalContext {
  stdin?: PlanApprovalContext['stdin'];
  stderr: PlanApprovalContext['stderr'];
  approveMigrationPlan?: PlanApprovalPrompt;
}

export type MigrationApprovalResult = PlanApprovalResult;

export async function requestMigrationApproval(
  request: MigrationApprovalRequest,
  context: MigrationApprovalContext
): Promise<MigrationApprovalResult> {
  return requestPlanApproval(
    {
      fingerprint: request.fingerprint,
      approvePlan: request.approvePlan,
      message: request.message
    },
    {
      ...(request.json ? {} : { stdin: context.stdin }),
      stderr: context.stderr,
      approvePlan: context.approveMigrationPlan
    }
  );
}

export { isPlanFingerprint };
