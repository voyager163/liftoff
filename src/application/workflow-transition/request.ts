import { isUpdatePlanFingerprint } from '../update/approval.js';

export interface WorkflowTransitionRequest {
  readonly subcommand?: string;
  readonly target?: string;
  readonly project?: string;
  readonly agents?: readonly string[];
  readonly defaultAgent?: string;
  readonly check: boolean;
  readonly approvePlan?: string;
  readonly recover: boolean;
  readonly json: boolean;
}

export function workflowTransitionRequestIssue(
  request: WorkflowTransitionRequest,
  help = false
): string | undefined {
  if (!help && request.subcommand !== 'set') {
    return 'Workflow transitions require `liftoff workflow set <openspec|spec-kit|manual> [project-path]`.';
  }
  if (request.target !== undefined &&
      !['openspec', 'spec-kit', 'manual'].includes(request.target)) {
    return 'Workflow set target must be openspec, spec-kit, or manual.';
  }
  if (!help && request.target === undefined) {
    return 'Workflow set requires an explicit target: openspec, spec-kit, or manual.';
  }
  if (request.project !== undefined &&
      (typeof request.project !== 'string' || !request.project.trim())) {
    return 'Workflow set project must be a non-empty path.';
  }
  if (request.agents !== undefined &&
      (!Array.isArray(request.agents) || request.agents.length > 3 ||
        request.agents.some(agent => typeof agent !== 'string' || !agent.trim()))) {
    return 'Workflow set agents must be a bounded non-empty list.';
  }
  if (request.defaultAgent !== undefined &&
      (typeof request.defaultAgent !== 'string' || !request.defaultAgent.trim())) {
    return 'Workflow set default agent must be a non-empty selected agent.';
  }
  if (request.defaultAgent !== undefined &&
      request.target !== undefined && request.target !== 'spec-kit') {
    return 'Workflow set --default-agent is supported only for the spec-kit target.';
  }
  if (request.approvePlan !== undefined &&
      !isUpdatePlanFingerprint(request.approvePlan)) {
    return 'Workflow --approve-plan requires exactly 64 lowercase hexadecimal characters.';
  }
  if (request.check &&
      (request.approvePlan !== undefined || request.recover)) {
    return 'Workflow --check cannot be combined with --approve-plan or --recover.';
  }
  if (request.recover && request.approvePlan === undefined) {
    return 'Workflow --recover requires --approve-plan <saved-fingerprint>.';
  }
  return undefined;
}
