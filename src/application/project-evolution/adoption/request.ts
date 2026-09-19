import { isRecord } from '../../../domain/governance/activation/canonical-json.js';
import { isUpdatePlanFingerprint } from '../../update/approval.js';

export interface AdoptRequest {
  project?: string;
  profile?: string;
  component?: string;
  proposal?: string;
  check?: boolean;
  approvePlan?: string;
  verifyPlan?: string;
  allowDependencyPreparation?: boolean;
  allowNetwork?: boolean;
  recover?: boolean;
  json?: boolean;
}

export function adoptionRequestIssue(request: unknown, help = false): string | null {
  const strings = ['project', 'profile', 'component', 'proposal', 'approvePlan', 'verifyPlan'] as const;
  const booleans = ['check', 'allowDependencyPreparation', 'allowNetwork', 'recover', 'json'] as const;
  const allowed = new Set<string>([...strings, ...booleans]);
  if (!isRecord(request) || Object.keys(request).some((field) => !allowed.has(field))) {
    return 'Adoption accepts only its explicit project, profile, component, proposal, and documented execution permissions.';
  }
  for (const field of strings) {
    const value = request[field];
    if (value !== undefined &&
        (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value))) {
      return `Adoption ${field} must be a nonempty string without control characters.`;
    }
  }
  for (const field of booleans) {
    if (request[field] !== undefined && typeof request[field] !== 'boolean') {
      return `Adoption ${field} must be a boolean.`;
    }
  }
  if (!help && !request.project) return 'Adoption requires explicit --project <existing-directory> (or the registered positional project).';
  for (const value of [request.approvePlan, request.verifyPlan]) {
    if (value !== undefined && !isUpdatePlanFingerprint(value)) {
      return 'Adoption execution permissions require the full lowercase 64-character plan fingerprint.';
    }
  }
  if (request.check && (request.approvePlan || request.verifyPlan || request.allowNetwork || request.allowDependencyPreparation || request.recover)) {
    return 'Adoption check is non-executing and cannot be combined with approval, verification, preparation, network or recovery flags.';
  }
  if (request.approvePlan && request.verifyPlan) {
    return 'Run exact-plan verification first, inspect its result, then separately approve the file transaction.';
  }
  if ((request.allowNetwork || request.allowDependencyPreparation) && !request.verifyPlan) {
    return 'Preparation/network permissions apply only to an exact --verify-plan operation and do not authorize file writes.';
  }
  if (request.recover && (request.check || request.approvePlan || request.verifyPlan || request.proposal || request.profile || request.component || request.allowNetwork || request.allowDependencyPreparation)) {
    return 'Adoption recovery handles only recorded effects; it cannot be combined with new planning or execution.';
  }
  return null;
}
