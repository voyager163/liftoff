import type { ExecutionContext } from '../context.js';
import { requestUpdateApproval, type UpdateApprovalResult } from '../update/approval.js';
import type { RepairRequest } from './request.js';
import { requestReviewedFileApproval } from '../execution/kernel.js';

export function requestRepairApproval(
  request: RepairRequest, fingerprint: string, message: string, context: ExecutionContext, fileScopeRoot?: string
): Promise<UpdateApprovalResult> {
  if (request.check || request.json || request.capabilities || request.inspectLayout || request.recover) {
    return Promise.resolve({ status: 'required', fingerprint });
  }
  if (fileScopeRoot !== undefined) {
    return requestReviewedFileApproval({ kind: 'repair', projectRoot: fileScopeRoot, fingerprint, message }, {
      stdin: context.stdin, stderr: context.stderr, approvePlan: context.approveRepairPlan
    });
  }
  return requestUpdateApproval({ fingerprint, message }, {
    stdin: context.stdin, stderr: context.stderr, approveUpdatePlan: context.approveRepairPlan
  });
}
