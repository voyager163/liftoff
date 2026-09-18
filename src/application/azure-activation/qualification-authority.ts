import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { canonicalApprovalEnvelopeHash, savedPlanAuthorityDigest } from '../../domain/governance/activation/approvals.js';
import { planDigestFor } from '../../domain/governance/activation/operations.js';
import type { ApprovalEnvelope, SavedTransitionPlan, TransitionOperation } from '../../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { containerAppResourceId, applicationUuid } from '../../adapters/azure/application-provisioning.js';
import { AzureArmError } from '../../adapters/azure/activation-rest.js';
import { GitHubActivationError } from '../../adapters/github/activation-rest.js';
import { assertGitHubPhaseAuthority } from '../repository-governance/workflow-authority.js';
import { assertAzurePhaseAuthority, AzureActivationAdmissionError } from './authority.js';
import { resolveAzureInputs } from './producer-discovery.js';

export type QualificationEnvironment = 'dev' | 'staging' | 'prod';
export const environmentQualificationScopeBlocker =
  'Full environment qualification requires activation scope; local, repository and lifecycle scopes cannot grant it.';

export function requireEnvironmentActivationScope(input: Pick<PhasePlanningInput, 'inspection'>): void {
  if ((input.inspection.scope ?? 'activation') !== 'activation') {
    qualificationFailure('qualification-scope', environmentQualificationScopeBlocker);
  }
}

export interface DisposableTargetConfig {
  authorityKind: 'disposable-operator-qualification';
  target: {
    environment: QualificationEnvironment;
    subscriptionId: string;
    tenantId: string;
    resourceGroup: string;
    appName: string;
    resourceId: string;
  };
  actor: {
    operator: string;
    githubActorId: number;
    azurePrincipalId: string;
  };
  spendCeilingCents: number;
  maxDurationMinutes: number;
  permittedEffects: readonly string[];
  notBefore: string;
  expiresAt: string;
}

export interface DisposableQualificationAuthority extends DisposableTargetConfig {
  /** Derived from the actual issued grant; the reviewed request window remains unchanged. */
  executionWindow: QualificationExecutionWindow;
  approval: {
    envelopeId: string;
    envelopeHash: string;
    approvedAt: string;
    planDigest: string;
    savedPlanDigest: string;
  };
}

export interface QualificationExecutionWindow {
  notBefore: string;
  expiresAt: string;
}

export type OperatorQualificationAuthorityValidation =
  | { valid: true; authority: DisposableQualificationAuthority }
  | { valid: false; blocker: string };

export function qualificationFailure(code: string, message: string): never {
  throw new AzureActivationAdmissionError(code, message);
}

export function qualificationObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))) {
    qualificationFailure('qualification-contract', `${label} requires exactly its registered fields; aliases and asserted approval flags are not accepted.`);
  }
  return value;
}

export function qualificationText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 2048 ||
    /[\u0000-\u001f\u007f]/u.test(value)) {
    qualificationFailure('qualification-contract', `${label} requires an exact bounded public string.`);
  }
  return value;
}

export function qualificationInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    qualificationFailure('qualification-contract', `${label} requires an actual bounded positive integer.`);
  }
  return value;
}

export function qualificationTimestamp(value: unknown, label: string): string {
  const text = qualificationText(value, label);
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
    qualificationFailure('qualification-clock', `${label} requires an exact ISO timestamp.`);
  }
  return text;
}

export function providerQualificationTimestamp(value: unknown, label: string): string {
  const text = qualificationText(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(text) ||
    !Number.isFinite(Date.parse(text))) {
    qualificationFailure('qualification-clock', `${label} requires an actual provider UTC timestamp.`);
  }
  const normalized = new Date(text).toISOString();
  if (text !== normalized && text !== normalized.replace('.000Z', 'Z')) {
    qualificationFailure('qualification-clock', `${label} is not a valid exact provider time.`);
  }
  return text;
}

export function qualificationExecutionWindow(
  target: DisposableTargetConfig,
  plan: Pick<SavedTransitionPlan, 'createdAt' | 'expiresAt'>,
  approval: Pick<ApprovalEnvelope, 'approvedAt' | 'expiresAt'>
): QualificationExecutionWindow {
  const start = Math.max(
    Date.parse(qualificationTimestamp(target.notBefore, 'Reviewed qualification start')),
    Date.parse(qualificationTimestamp(plan.createdAt, 'Original plan start')),
    Date.parse(qualificationTimestamp(approval.approvedAt, 'Original approval time'))
  );
  const end = Math.min(
    Date.parse(qualificationTimestamp(target.expiresAt, 'Reviewed qualification expiry')),
    Date.parse(qualificationTimestamp(plan.expiresAt, 'Original plan expiry')),
    Date.parse(qualificationTimestamp(approval.expiresAt, 'Original approval expiry'))
  );
  if (start >= end) {
    qualificationFailure('qualification-clock', 'The reviewed qualification, original plan and issued approval have no common execution interval.');
  }
  return { notBefore: new Date(start).toISOString(), expiresAt: new Date(end).toISOString() };
}

export function disposableTargetConfig(value: unknown): DisposableTargetConfig {
  const data = qualificationObject(value, [
    'authorityKind', 'target', 'actor', 'spendCeilingCents', 'maxDurationMinutes',
    'permittedEffects', 'notBefore', 'expiresAt'
  ], 'Disposable qualification request');
  const target = qualificationObject(data.target, [
    'environment', 'subscriptionId', 'tenantId', 'resourceGroup', 'appName', 'resourceId'
  ], 'Disposable target');
  const actor = qualificationObject(data.actor, ['operator', 'githubActorId', 'azurePrincipalId'], 'Qualification actors');
  if (data.authorityKind !== 'disposable-operator-qualification' ||
    target.environment !== 'dev' && target.environment !== 'staging' && target.environment !== 'prod' ||
    typeof data.spendCeilingCents !== 'number' || !Number.isSafeInteger(data.spendCeilingCents) ||
    data.spendCeilingCents < 0) {
    qualificationFailure('qualification-authority', 'Qualification needs an explicit environment and independent disposable spend ceiling in whole cents; a monthly budget is not this authority.');
  }
  const subscriptionId = applicationUuid(target.subscriptionId, 'Qualification subscription');
  const tenantId = applicationUuid(target.tenantId, 'Qualification tenant');
  const resourceGroup = qualificationText(target.resourceGroup, 'Qualification resource group');
  const appName = qualificationText(target.appName, 'Qualification application');
  const resourceId = containerAppResourceId(subscriptionId, resourceGroup, appName);
  if (target.resourceId !== resourceId) {
    qualificationFailure('qualification-target', 'The disposable target must name its exact canonical Container App, not a subscription, prefix or inferred resource.');
  }
  if (!Array.isArray(data.permittedEffects) || !data.permittedEffects.length || data.permittedEffects.length > 16) {
    qualificationFailure('qualification-effects', 'Qualification needs a bounded exact inventory of permitted remote effects.');
  }
  const permittedEffects = data.permittedEffects.map((effect) => qualificationText(effect, 'Permitted qualification effect'));
  if (new Set(permittedEffects).size !== permittedEffects.length) {
    qualificationFailure('qualification-effects', 'Qualification effects must not contain duplicates.');
  }
  const maxDurationMinutes = qualificationInteger(data.maxDurationMinutes, 'Disposable time ceiling', 120);
  const notBefore = qualificationTimestamp(data.notBefore, 'Disposable start time');
  const expiresAt = qualificationTimestamp(data.expiresAt, 'Disposable expiry');
  if (Date.parse(expiresAt) <= Date.parse(notBefore) ||
    Date.parse(expiresAt) - Date.parse(notBefore) > maxDurationMinutes * 60_000) {
    qualificationFailure('qualification-clock', 'The exact disposable interval exceeds its independently reviewed time ceiling.');
  }
  return {
    authorityKind: 'disposable-operator-qualification',
    target: { environment: target.environment, subscriptionId, tenantId, resourceGroup, appName, resourceId },
    actor: {
      operator: qualificationText(actor.operator, 'Approving operator'),
      githubActorId: qualificationInteger(actor.githubActorId, 'GitHub dispatch actor'),
      azurePrincipalId: applicationUuid(actor.azurePrincipalId, 'Qualification Azure principal')
    },
    spendCeilingCents: data.spendCeilingCents, maxDurationMinutes, permittedEffects, notBefore, expiresAt
  };
}

export function configuredDisposableTarget(
  input: Pick<PhasePlanningInput, 'inspection' | 'phase'>, environment: QualificationEnvironment
): DisposableTargetConfig {
  const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  const phase = configuration?.phases[input.phase.id];
  const target = disposableTargetConfig(phase?.disposableTarget);
  const workload = input.inspection.manifest.project.workload;
  const azure = resolveAzureInputs(input);
  if (target.target.environment !== environment || workload.kind === 'components' ||
    !workload.environments.includes(environment) ||
    typeof azure.subscriptionId !== 'string' || typeof azure.tenantId !== 'string' ||
    target.target.subscriptionId !== azure.subscriptionId.toLowerCase() ||
    target.target.tenantId !== azure.tenantId.toLowerCase()) {
    qualificationFailure('qualification-target', 'The exact qualification environment, subscription and tenant must already be declared in this project and current phase configuration.');
  }
  return target;
}

export async function requireDisposableQualificationAuthority(
  input: PhaseAdapterExecutionInput, environment: QualificationEnvironment, operation: TransitionOperation
): Promise<DisposableQualificationAuthority> {
  requireEnvironmentActivationScope(input);
  const target = configuredDisposableTarget(input, environment);
  const native = operation.adapter === 'azure-opentofu' && operation.mutationClass === 'backend-state-write' &&
    ['azure.application-private.prepare', 'azure.application-private.state', 'azure.application-private.recover'].includes(operation.actionId);
  if (input.plan.scope !== 'activation' ||
    !native && (operation.adapter !== 'github' || operation.mutationClass !== 'github-workflow-dispatch') ||
    canonicalSha256(operation.inputs.disposableTarget ?? null) !== canonicalSha256(target)) {
    qualificationFailure('qualification-authority', 'Disposable qualification requires the exact activation dispatch operation and independently reviewed target/actors/spend/time; repository receipts and configuration flags cannot authorize it.');
  }
  if (native) await assertAzurePhaseAuthority(input, operation);
  else await assertGitHubPhaseAuthority(input, operation);
  const envelope = input.inspection.approvals.filter((entry) => entry.id === input.plan.approval.envelopeId);
  const issued = envelope[0];
  if (envelope.length !== 1 || !issued || canonicalApprovalEnvelopeHash(issued) !== input.plan.approval.envelopeHash ||
    input.plan.planDigest !== planDigestFor({
      phase: input.phase, transitionDigest: input.plan.transitionDigest, operations: input.plan.operations,
      approvalPlanDigest: savedPlanAuthorityDigest(input.plan, input.phase)
    })) {
    qualificationFailure('qualification-approval', 'Qualification must retain its unique genuine issued envelope and original operation-bound plan digest.');
  }
  const effects = input.plan.operations.flatMap((entry) => [entry, ...(entry.effects ?? [])]).filter((entry) => entry.remote);
  const mutations = [...new Set(effects.map((entry) => entry.mutationClass))].sort();
  const workflow = operation.inputs.workflow;
  const privateExecution = operation.inputs.applicationPrivate;
  const nativeBinding = isRecord(privateExecution) ? privateExecution.binding : undefined;
  const now = (input.clock?.() ?? input.now).getTime();
  const executionWindow = qualificationExecutionWindow(target, input.plan, issued);
  const actorMatches = native
    ? isRecord(nativeBinding) && nativeBinding.principalId === target.actor.azurePrincipalId &&
      nativeBinding.subscriptionId === target.target.subscriptionId && nativeBinding.tenantId === target.target.tenantId
    : isRecord(workflow) && workflow.actorId === target.actor.githubActorId &&
      workflow.repository === input.inspection.state.remoteBinding?.name &&
      String(workflow.repositoryId) === input.inspection.state.remoteBinding?.id;
  if (!actorMatches ||
    target.actor.operator !== issued.approver ||
    canonicalSha256(mutations) !== canonicalSha256([...target.permittedEffects].sort()) ||
    mutations.some((effect) => !issued.permissions.includes(effect)) ||
    !effects.some((effect) => effect.destination.identity === target.target.resourceId &&
      effect.destination.subscriptionId === target.target.subscriptionId) ||
    !issued.resources.some((resource) => resource.identity === target.target.resourceId) ||
    !Number.isFinite(now) || now < Date.parse(executionWindow.notBefore) || now >= Date.parse(executionWindow.expiresAt)) {
    qualificationFailure('qualification-approval', 'The current actor, exact resources/effects or disposable time interval differs from the real issued phase approval; no monthly approval or expired grant is substituted.');
  }
  await input.lease!.assertHeld();
  return {
    ...target, executionWindow,
    approval: {
      envelopeId: issued.id, envelopeHash: canonicalApprovalEnvelopeHash(issued), approvedAt: issued.approvedAt,
      planDigest: input.plan.planDigest, savedPlanDigest: canonicalSha256(input.plan)
    }
  };
}

export async function validateOperatorQualificationAuthority(
  input: PhaseAdapterExecutionInput, environment: QualificationEnvironment, operation: TransitionOperation
): Promise<OperatorQualificationAuthorityValidation> {
  try { return { valid: true, authority: await requireDisposableQualificationAuthority(input, environment, operation) }; }
  catch (error) {
    if (!(error instanceof AzureActivationAdmissionError) && !(error instanceof AzureArmError) &&
      !(error instanceof GitHubActivationError)) throw error;
    return { valid: false, blocker: error.message };
  }
}
