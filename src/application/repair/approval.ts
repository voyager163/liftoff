import type { ExecutionContext } from '../context.js';
import { requestUpdateApproval, type UpdateApprovalResult } from '../update/approval.js';
import type { RepairRequest } from './request.js';

export function requestRepairApproval(
  request: RepairRequest, fingerprint: string, message: string, context: ExecutionContext
): Promise<UpdateApprovalResult> {
  if (request.check || request.json || request.capabilities || request.inspectLayout || request.recover) {
    return Promise.resolve({ status: 'required', fingerprint });
  }
  return requestUpdateApproval({ fingerprint, message }, {
    stdin: context.stdin, stderr: context.stderr, approveUpdatePlan: context.approveRepairPlan
  });
}
