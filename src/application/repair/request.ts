import { isUpdatePlanFingerprint } from '../update/approval.js';

export interface RepairRequest {
  project?: string;
  check: boolean;
  live: boolean;
  subscription?: string;
  approvePlan?: string;
  recover: boolean;
  json: boolean;
  capabilities?: boolean;
  inspectLayout?: boolean;
  applicationPatch?: string;
  verifyPlan?: string;
  allowNetwork?: boolean;
  allowDependencyPreparation?: boolean;
  agents?: readonly string[];
  defaultAgent?: string;
  installTools?: boolean;
  configureOpenSpecProfile?: boolean;
}

export function repairRequestIssue(request: RepairRequest, help = false): string | undefined {
  for (const [flag, value] of [['approve-plan', request.approvePlan], ['verify-plan', request.verifyPlan]]) {
    if (value !== undefined && !isUpdatePlanFingerprint(value)) {
      return `Flag --${flag} expects the complete 64-character lowercase fingerprint from a repair preview; ordinary interactive repair does not require fingerprint entry.`;
    }
  }
  const agentRequested =
    request.agents !== undefined || request.defaultAgent !== undefined;
  if (request.agents !== undefined &&
      (!Array.isArray(request.agents) ||
        request.agents.length === 0 ||
        request.agents.length > 3 ||
        request.agents.some(agent =>
          typeof agent !== 'string' ||
          !agent.trim() ||
          agent.trim().toLowerCase() === 'none'
        ))) {
    return 'Repair --agents requires a bounded non-empty list of real supported agents; additive repair cannot select none or remove agents.';
  }
  if (request.defaultAgent !== undefined &&
      (typeof request.defaultAgent !== 'string' ||
        !request.defaultAgent.trim() ||
        request.defaultAgent.trim().toLowerCase() === 'none')) {
    return 'Repair --default-agent requires one real supported Spec Kit agent.';
  }
  if ([request.capabilities, request.inspectLayout, request.recover,
    Boolean(request.approvePlan) && !request.recover,
    Boolean(request.verifyPlan)].filter(Boolean).length > 1 ||
      request.check && (request.recover || request.approvePlan || request.verifyPlan)) {
    return 'Repair check, capabilities, layout inspection, exact plan application, verification and recovery are separate operations.';
  }
  if (request.capabilities && (request.project || request.check || request.applicationPatch || request.live || request.subscription || request.allowNetwork || request.allowDependencyPreparation || agentRequested || request.installTools || request.configureOpenSpecProfile)) {
    return 'Repair capabilities accepts only output/help options and needs no project.';
  }
  if (request.applicationPatch && (request.inspectLayout || request.recover || request.approvePlan || request.verifyPlan || request.live || request.subscription || agentRequested || request.installTools || request.configureOpenSpecProfile)) {
    return 'Application patch selection belongs only to its preview/interactive journey; do not combine it with infrastructure discovery or saved-plan execution/recovery.';
  }
  if ((request.recover || request.approvePlan || request.verifyPlan || request.inspectLayout) && (request.live || request.subscription)) {
    return 'Live/subscription options belong only to the infrastructure preview; execution and recovery use only their saved scope.';
  }
  if (request.allowNetwork && !request.verifyPlan) {
    return 'Flag --allow-network is additional consent only for exact --verify-plan execution; ordinary interactive repair asks separately.';
  }
  if (request.allowDependencyPreparation && !request.verifyPlan) {
    return 'Flag --allow-dependency-preparation is separate permission only for exact --verify-plan execution; ordinary interactive repair asks separately.';
  }
  if (agentRequested &&
      (request.inspectLayout || request.applicationPatch ||
        request.verifyPlan || request.live || request.subscription ||
        request.allowNetwork || request.allowDependencyPreparation)) {
    return 'Additive agent repair is separate from application, infrastructure, live-discovery and verification operations.';
  }
  if ((request.installTools || request.configureOpenSpecProfile) &&
      !agentRequested) {
    return 'Repair tool or OpenSpec profile preparation requires an explicit additive --agents or --default-agent request.';
  }
  if (request.check &&
      (request.installTools || request.configureOpenSpecProfile)) {
    return 'Repair --check cannot authorize workstation tools or global OpenSpec profile changes.';
  }
  if ((request.approvePlan || request.recover) &&
      (request.installTools || request.configureOpenSpecProfile)) {
    return 'Exact repair apply or recovery cannot also authorize workstation tools or global OpenSpec profile changes.';
  }
  if (!help && request.live !== Boolean(request.subscription)) {
    return 'Live repair discovery requires both --live and --subscription <id>.';
  }
  if (request.subscription !== undefined &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(request.subscription)) {
    return 'Flag --subscription requires an Azure subscription UUID, not a name or guessed default.';
  }
  return undefined;
}
