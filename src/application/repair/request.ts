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
  recipe?: string;
}

export function repairRequestIssue(request: RepairRequest, help = false): string | undefined {
  for (const [flag, value] of [['approve-plan', request.approvePlan], ['verify-plan', request.verifyPlan]]) {
    if (value !== undefined && !isUpdatePlanFingerprint(value)) {
      return `Flag --${flag} expects the complete 64-character lowercase fingerprint from a repair preview; ordinary interactive repair does not require fingerprint entry.`;
    }
  }
  if (request.recipe !== undefined && !['azure-local-layout', 'azure-baseline-settings', 'application-layout-patch'].includes(request.recipe)) {
    return 'Flag --recipe expects a registered repair recipe: azure-local-layout, azure-baseline-settings or application-layout-patch.';
  }
  if (request.recipe && (request.recover || request.approvePlan || request.verifyPlan)) {
    return 'Flag --recipe belongs to repair inspection and preview; saved-plan execution and recovery use only their saved recipe identity.';
  }
  if (request.capabilities && (request.project || request.check || request.applicationPatch || request.live || request.subscription || request.allowNetwork || request.allowDependencyPreparation || request.recipe)) {
    return 'Repair capabilities accepts only output/help options and needs no project or recipe.';
  }
  if (request.inspectLayout && request.recipe) {
    return 'Layout inspection is an actual-file inventory and does not accept --recipe.';
  }
  if (request.recipe === 'azure-baseline-settings' && (request.live || request.subscription)) {
    return 'Recipe azure-baseline-settings is configuration-only and does not accept --live or --subscription.';
  }
  if (request.applicationPatch && request.recipe && request.recipe !== 'application-layout-patch') {
    return 'Flag --application-patch requires recipe application-layout-patch.';
  }
  if (request.recipe === 'application-layout-patch' && !request.applicationPatch) {
    return 'Recipe application-layout-patch requires an external patch document via --application-patch <file>.';
  }
  if ([request.capabilities, request.inspectLayout, request.recover, Boolean(request.approvePlan), Boolean(request.verifyPlan)].filter(Boolean).length > 1 ||
      request.check && (request.recover || request.approvePlan || request.verifyPlan)) {
    return 'Repair check, capabilities, layout inspection, exact plan application, verification and recovery are separate operations.';
  }
  if (request.applicationPatch && (request.inspectLayout || request.recover || request.approvePlan || request.verifyPlan || request.live || request.subscription)) {
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
  if (!help && request.live !== Boolean(request.subscription)) {
    return 'Live repair discovery requires both --live and --subscription <id>.';
  }
  if (request.subscription !== undefined &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(request.subscription)) {
    return 'Flag --subscription requires an Azure subscription UUID, not a name or guessed default.';
  }
  return undefined;
}
