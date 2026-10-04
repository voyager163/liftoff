import { isUpdatePlanFingerprint } from './approval.js';
import type { UpdateRequest } from './use-case.js';

export const currentUpdateReportSchemaVersion = 4;

export interface CurrentUpdateRequest extends UpdateRequest {
  recover: boolean;
}

export function currentUpdateRequestIssue(request: CurrentUpdateRequest): string | undefined {
  if (['check', 'force', 'jsonMode', 'recover'].some(field => typeof Object.getOwnPropertyDescriptor(request, field)?.value !== 'boolean')) {
    return 'Update check, force, JSON and recovery modes must be explicit booleans.';
  }
  if (request.project !== undefined && (typeof request.project !== 'string' || !request.project.trim())) {
    return 'Update project must be a non-empty path.';
  }
  if (request.approvePlan !== undefined && !isUpdatePlanFingerprint(request.approvePlan)) {
    return '--approve-plan requires exactly 64 lowercase hexadecimal characters.';
  }
  if (request.check && (request.force || request.recover || request.approvePlan !== undefined)) {
    return '--check cannot be combined with --force, --recover or --approve-plan.';
  }
  if (request.recover && (request.force || request.approvePlan === undefined)) {
    return '--recover requires --approve-plan <saved-fingerprint> and cannot be combined with --force.';
  }
  return undefined;
}
