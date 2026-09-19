import path from 'node:path';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { normalizeApprovalCostCeiling } from '../../domain/governance/activation/approvals.js';
import { evidenceBodyDigest, evidenceHeaderDigest } from '../../domain/governance/activation/evidence.js';
import type { SavedTransitionPlan, TransitionOperation } from '../../domain/governance/activation/types.js';
import type { PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { azureArmBinding, azureArmUrl } from '../../adapters/azure/activation-rest.js';
import { applicationUuid, parseApplicationImageReference } from '../../adapters/azure/application-provisioning.js';
import { validatePrivateStatePathTarget } from '../../adapters/azure/private-state-path.js';
import { azureStateUrl } from '../../adapters/state/azure-blob.js';
import { stateBindingDigest } from '../../domain/repair/stateful-invariants.js';
import { applicationPrivateAddress } from './application-private-address.js';
import {
  applicationPrivateAssert as must, applicationPrivateProtocol,
  type ApplicationPrivateArtifact, type ApplicationPrivateChange, type ApplicationPrivateIntent, type ApplicationPrivateReview,
  type ApplicationPrivateResult, type ApplicationPrivateScalar, type ApplicationPrivateTarget
} from './application-private-contracts.js';
import {
  applicationPrivateDigest, applicationPrivateObject, applicationPrivateReference, assertApplicationPrivateArtifact
} from './application-private-admission.js';
import { validatePrivateCustody } from './private-custody.js';
import {
  disposableTargetConfig, qualificationTimestamp, requireEnvironmentActivationScope,
  type DisposableTargetConfig
} from './qualification-authority.js';
import {
  qualificationEvidenceReference, requireQualificationEvidence, type QualificationEvidenceReference
} from './qualification-evidence.js';

export const applicationRehearsalProtocol = 'private-application-rehearsal/1' as const;
export type ApplicationRehearsalStage = 'rollout' | 'rollback' | 'verify';
export type ApplicationRehearsalScope = 'rehearsal-rollout' | 'rehearsal-rollback';
export const applicationRehearsalResourceActions = {
  rollout: 'azure.application-rehearsal.rollout',
  rollback: 'azure.application-rehearsal.rollback'
} as const;

export interface ApplicationRehearsalReviewReference {
  sourcePlanDigest: string;
  reviewDigest: string;
}

export interface ApplicationRehearsalArtifact {
  evidence: QualificationEvidenceReference;
  imageRef: string;
  sourceSha: string;
  registryResourceId: string;
  sourceRegistryResourceId?: string;
}

export interface ApplicationRehearsalBaseline {
  artifact: ApplicationRehearsalArtifact;
  revisionName: string;
  workloadIdentity: {
    resourceId: string;
    principalId: string;
    clientId: string;
    tenantId: string;
  };
}

/** Local widened types do not pretend production is foundation while the owner adds the core scopes. */
export type ApplicationRehearsalPrivateIntent = Omit<ApplicationPrivateIntent, 'scope' | 'artifact'> & {
  scope: ApplicationRehearsalScope;
  artifact: ApplicationPrivateArtifact;
};
export type ApplicationRehearsalPrivateReview = Omit<ApplicationPrivateReview, 'phaseId'> & {
  phaseId: 'production-rehearsed';
};
export type ApplicationRehearsalPrivateResult = Omit<ApplicationPrivateResult, 'reviewed'> & {
  reviewed?: ApplicationRehearsalPrivateReview;
};
export type ApplicationRehearsalPrivateConfiguration = ApplicationRehearsalPrivateIntent & (
  | { mode: 'prepare' }
  | { mode: 'apply'; reviewed: ApplicationRehearsalPrivateReview }
  | {
    mode: 'recover';
    reviewed: ApplicationRehearsalPrivateReview | null;
    recovery: 'inspect' | 'publish-retained';
    checkpoint: { transactionId: string; journalRef: string };
    candidateRef: string | null;
    recoveryWindow: { notBefore: string; expiresAt: string; releaseUntil: string };
  }
);

/**
 * Exact phases['production-rehearsed'] schema. Every field is required, including
 * null review references. This recipe updates one existing Single-revision app;
 * it cannot create dependencies, replace resources, change ownership or dispatch.
 *
 * rollout/prepare -> rollout/apply -> rollback/prepare -> rollback/apply ->
 * verify/recover(inspect). Each arrow consumes the preceding retained review.
 * Images change through protected variables, not edits to the approved HCL.
 * Interrupted preparation permits inspect with reviewed:null and its original
 * checkpoint, but cannot publish a candidate or complete a stage.
 */
export interface ApplicationRehearsalInputs {
  disposableTarget: DisposableTargetConfig;
  privateExecution: ApplicationRehearsalPrivateConfiguration;
  rehearsal: {
    stage: ApplicationRehearsalStage;
    staging: QualificationEvidenceReference;
    baseline: ApplicationRehearsalBaseline;
    candidate: ApplicationRehearsalArtifact;
    rolloutReview: ApplicationRehearsalReviewReference | null;
    rollbackReview: ApplicationRehearsalReviewReference | null;
  };
}

export function applicationRehearsalPrivateIntent(config: ApplicationRehearsalPrivateConfiguration): ApplicationRehearsalPrivateIntent {
  return {
    schemaVersion: config.schemaVersion, scope: config.scope, binding: config.binding, backend: config.backend,
    custody: config.custody, writer: config.writer, source: config.source, targets: config.targets, artifact: config.artifact,
    notBefore: config.notBefore, expiresAt: config.expiresAt, releaseUntil: config.releaseUntil, maxCommandMs: config.maxCommandMs
  };
}

export function rehearsalText(value: unknown, limit = 2048): string {
  must(typeof value === 'string' && value.length > 0 && value.length <= limit && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value), 'rehearsal-text');
  return value;
}

export function rehearsalRecord(value: unknown): Record<string, unknown> {
  must(isRecord(value), 'rehearsal-record');
  return value;
}

function armBinding(value: unknown) {
  const data = applicationPrivateObject(value, ['subscriptionId', 'tenantId', 'principalId']);
  return azureArmBinding({
    subscriptionId: rehearsalText(data.subscriptionId), tenantId: rehearsalText(data.tenantId), principalId: rehearsalText(data.principalId)
  });
}

function privateBackend(value: unknown) {
  const data = applicationPrivateObject(value, ['binding', 'backend', 'region', 'hostId', 'privateEndpointId', 'endpointAddress',
    'subnetId', 'virtualNetworkId', 'privateDnsZoneId', 'privateDnsLinkId', 'privateDnsZoneGroupId']);
  const backend = applicationPrivateObject(data.backend, ['id', 'ownerId', 'kind', 'format', 'tenantId', 'subscriptionId',
    'resourceGroup', 'account', 'container', 'key', 'network']);
  must(backend.kind === 'azurerm' && backend.format === 'opentofu-v4-json' && backend.network === 'private', 'rehearsal-private-backend');
  return validatePrivateStatePathTarget({
    binding: armBinding(data.binding),
    backend: {
      kind: 'azurerm', format: 'opentofu-v4-json', network: 'private', id: rehearsalText(backend.id), ownerId: rehearsalText(backend.ownerId),
      tenantId: rehearsalText(backend.tenantId), subscriptionId: rehearsalText(backend.subscriptionId),
      resourceGroup: rehearsalText(backend.resourceGroup), account: rehearsalText(backend.account),
      container: rehearsalText(backend.container), key: rehearsalText(backend.key)
    },
    region: rehearsalText(data.region), hostId: rehearsalText(data.hostId), privateEndpointId: rehearsalText(data.privateEndpointId),
    endpointAddress: rehearsalText(data.endpointAddress), subnetId: rehearsalText(data.subnetId), virtualNetworkId: rehearsalText(data.virtualNetworkId),
    privateDnsZoneId: rehearsalText(data.privateDnsZoneId), privateDnsLinkId: rehearsalText(data.privateDnsLinkId),
    privateDnsZoneGroupId: rehearsalText(data.privateDnsZoneGroupId)
  });
}

function strings(value: unknown): string[] {
  must(Array.isArray(value) && value.length > 0 && value.length <= 64, 'rehearsal-list');
  return value.map((entry) => rehearsalText(entry));
}

export function applicationRehearsalReviewReference(value: unknown): ApplicationRehearsalReviewReference {
  const ref = applicationPrivateObject(value, ['sourcePlanDigest', 'reviewDigest']);
  return { sourcePlanDigest: applicationPrivateDigest(ref.sourcePlanDigest), reviewDigest: applicationPrivateDigest(ref.reviewDigest) };
}

function artifact(value: unknown): ApplicationRehearsalArtifact {
  const data = applicationPrivateObject(value, ['evidence', 'imageRef', 'sourceSha', 'registryResourceId',
    ...(isRecord(value) && Object.hasOwn(value, 'sourceRegistryResourceId') ? ['sourceRegistryResourceId'] : [])]);
  const imageRef = rehearsalText(data.imageRef);
  parseApplicationImageReference(imageRef);
  const sourceSha = rehearsalText(data.sourceSha);
  must(/^[a-f0-9]{40}$/u.test(sourceSha), 'rehearsal-source-sha');
  return {
    evidence: qualificationEvidenceReference(data.evidence), imageRef, sourceSha,
    registryResourceId: rehearsalText(data.registryResourceId),
    ...(data.sourceRegistryResourceId !== undefined ? { sourceRegistryResourceId: rehearsalText(data.sourceRegistryResourceId) } : {})
  };
}

export function rehearsalPrivateArtifact(value: ApplicationRehearsalArtifact): ApplicationPrivateArtifact {
  return {
    evidenceId: value.evidence.evidenceId, headerDigest: value.evidence.headerDigest,
    imageRef: value.imageRef, sourceSha: value.sourceSha, registryResourceId: value.registryResourceId,
    ...(value.sourceRegistryResourceId !== undefined ? { sourceRegistryResourceId: value.sourceRegistryResourceId } : {})
  };
}

function executionWindow(value: unknown) {
  const data = applicationPrivateObject(value, ['notBefore', 'expiresAt', 'releaseUntil']);
  const notBefore = qualificationTimestamp(data.notBefore, 'Rehearsal private start');
  const expiresAt = qualificationTimestamp(data.expiresAt, 'Rehearsal private expiry');
  const releaseUntil = qualificationTimestamp(data.releaseUntil, 'Rehearsal lease-release deadline');
  const start = Date.parse(notBefore), end = Date.parse(expiresAt), release = Date.parse(releaseUntil);
  must(end > start && end - start <= 3_600_000 && release > end && release - end <= 120_000, 'rehearsal-window');
  return { notBefore, expiresAt, releaseUntil };
}

export function applicationRehearsalPrivateReview(value: unknown, workspaceId: string): ApplicationRehearsalPrivateReview {
  const review = applicationPrivateObject(value, ['schemaVersion', 'protocol', 'transactionId', 'journalRef', 'planRef', 'phaseId',
    'intentDigest', 'sourceDigest', 'backendBindingDigest', 'binding', 'artifact', 'tools', 'changes', 'expiresAt']);
  must(review.schemaVersion === 1 && review.protocol === applicationPrivateProtocol && review.phaseId === 'production-rehearsed',
    'rehearsal-private-review');
  const tools = applicationPrivateObject(review.tools, ['tofu', 'python', 'provider', 'providerVersion', 'hostId']);
  const image = applicationPrivateObject(review.artifact, ['evidenceId', 'headerDigest', 'imageRef', 'sourceSha', 'registryResourceId',
    ...(isRecord(review.artifact) && Object.hasOwn(review.artifact, 'sourceRegistryResourceId') ? ['sourceRegistryResourceId'] : [])]);
  parseApplicationImageReference(rehearsalText(image.imageRef));
  must(Array.isArray(review.changes) && review.changes.length === 1, 'rehearsal-review-effects');
  const changes: ApplicationPrivateChange[] = review.changes.map((raw) => {
    const change = applicationPrivateObject(raw, ['address', 'type', 'action', 'targetResourceId', 'changedAttributes', 'computedOutputs']);
    must(change.type === 'azurerm_container_app' && change.action === 'update' &&
      Array.isArray(change.changedAttributes) && Array.isArray(change.computedOutputs), 'rehearsal-review-effects');
    return {
      address: applicationPrivateAddress(change.address).address, type: change.type, action: change.action,
      targetResourceId: rehearsalText(change.targetResourceId),
      changedAttributes: change.changedAttributes.map((field) => rehearsalText(field, 100)),
      computedOutputs: change.computedOutputs.map((field) => rehearsalText(field, 100))
    };
  });
  return {
    schemaVersion: 1, protocol: applicationPrivateProtocol, phaseId: 'production-rehearsed',
    transactionId: applicationUuid(review.transactionId, 'Original rehearsal transaction'),
    journalRef: applicationPrivateReference(review.journalRef, workspaceId),
    planRef: applicationPrivateReference(review.planRef, workspaceId),
    intentDigest: applicationPrivateDigest(review.intentDigest), sourceDigest: applicationPrivateDigest(review.sourceDigest),
    backendBindingDigest: applicationPrivateDigest(review.backendBindingDigest), binding: armBinding(review.binding),
    artifact: {
      evidenceId: rehearsalText(image.evidenceId, 256), headerDigest: applicationPrivateDigest(image.headerDigest),
      imageRef: rehearsalText(image.imageRef), sourceSha: rehearsalText(image.sourceSha, 40),
      registryResourceId: rehearsalText(image.registryResourceId),
      ...(image.sourceRegistryResourceId !== undefined ? { sourceRegistryResourceId: rehearsalText(image.sourceRegistryResourceId) } : {})
    },
    tools: {
      tofu: applicationPrivateDigest(tools.tofu), python: applicationPrivateDigest(tools.python),
      provider: applicationPrivateDigest(tools.provider), providerVersion: rehearsalText(tools.providerVersion, 32),
      hostId: rehearsalText(tools.hostId, 256)
    }, changes, expiresAt: qualificationTimestamp(review.expiresAt, 'Original private review expiry')
  };
}

export function applicationRehearsalPrivateInputs(value: unknown): ApplicationRehearsalPrivateConfiguration {
  const data = rehearsalRecord(value), mode = data.mode;
  must(mode === 'prepare' || mode === 'apply' || mode === 'recover', 'rehearsal-mode');
  applicationPrivateObject(data, [
    'schemaVersion', 'scope', 'binding', 'backend', 'custody', 'writer', 'source', 'targets', 'artifact',
    'notBefore', 'expiresAt', 'releaseUntil', 'maxCommandMs', 'mode',
    ...(mode === 'prepare' ? [] : ['reviewed']),
    ...(mode === 'recover' ? ['recovery', 'recoveryWindow', 'checkpoint', 'candidateRef'] : [])
  ]);
  must(data.schemaVersion === 1 && (data.scope === 'rehearsal-rollout' || data.scope === 'rehearsal-rollback'), 'rehearsal-scope');
  const binding = armBinding(data.binding);
  const backend = privateBackend(data.backend), custody = validatePrivateCustody(data.custody);
  const writer = applicationPrivateObject(data.writer, ['keychainPath', 'service', 'account', 'subscriptionId', 'tenantId', 'principalId', 'clientId']);
  const writerBinding = armBinding({ subscriptionId: writer.subscriptionId, tenantId: writer.tenantId, principalId: writer.principalId });
  const source = applicationPrivateObject(data.source, ['rootPathParts', 'backendPathParts', 'variablesRef', 'provider']);
  const rootPathParts = strings(source.rootPathParts), backendPathParts = strings(source.backendPathParts);
  must(rootPathParts.join('/') === 'infrastructure/opentofu/azure/environments/prod' &&
    backendPathParts.slice(0, -1).join('/') === rootPathParts.join('/') &&
    /^[A-Za-z0-9_-]+\.tf$/u.test(backendPathParts.at(-1)!), 'rehearsal-prod-root');
  const provider = applicationPrivateObject(source.provider, ['source', 'version', 'mirrorDirectory', 'binary']);
  const binary = applicationPrivateObject(provider.binary, ['path', 'sha256']);
  const mirrorDirectory = rehearsalText(provider.mirrorDirectory), binaryPath = rehearsalText(binary.path);
  must(provider.source === 'registry.opentofu.org/hashicorp/azurerm' &&
    /^[45]\.\d+\.\d+$/u.test(rehearsalText(provider.version)) &&
    path.isAbsolute(mirrorDirectory) && path.isAbsolute(binaryPath) &&
    path.relative(mirrorDirectory, binaryPath) !== '' && !path.relative(mirrorDirectory, binaryPath).startsWith('..') &&
    !path.isAbsolute(path.relative(mirrorDirectory, binaryPath)), 'rehearsal-provider');
  const image = applicationPrivateObject(data.artifact, ['evidenceId', 'headerDigest', 'imageRef', 'sourceSha', 'registryResourceId',
    ...(isRecord(data.artifact) && Object.hasOwn(data.artifact, 'sourceRegistryResourceId') ? ['sourceRegistryResourceId'] : [])]);
  const privateArtifact: ApplicationPrivateArtifact = {
    evidenceId: rehearsalText(image.evidenceId, 256), headerDigest: applicationPrivateDigest(image.headerDigest),
    imageRef: rehearsalText(image.imageRef), sourceSha: rehearsalText(image.sourceSha, 40),
    registryResourceId: rehearsalText(image.registryResourceId),
    ...(image.sourceRegistryResourceId !== undefined ? { sourceRegistryResourceId: rehearsalText(image.sourceRegistryResourceId) } : {})
  };
  parseApplicationImageReference(privateArtifact.imageRef);
  must(/^[a-f0-9]{40}$/u.test(privateArtifact.sourceSha), 'rehearsal-source-sha');
  must(Array.isArray(data.targets) && data.targets.length === 1, 'rehearsal-existing-app-only');
  const target = applicationPrivateObject(data.targets[0], ['address', 'type', 'resourceId', 'actions', 'expected', 'role', 'runtime']);
  const address = applicationPrivateAddress(target.address);
  must(target.type === 'azurerm_container_app' && address.type === target.type && address.mode === 'managed' &&
    canonicalSha256(target.actions) === canonicalSha256(['update']) && target.role === null, 'rehearsal-existing-app-only');
  const expected: Record<string, ApplicationPrivateScalar> = {};
  for (const [key, value] of Object.entries(rehearsalRecord(target.expected))) {
    must(value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ||
      typeof value === 'string' && value.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value), 'rehearsal-expectations');
    expected[key] = value;
  }
  const runtime = applicationPrivateObject(target.runtime, ['url', 'statusField', 'statusValue']);
  const selectedTarget: ApplicationPrivateTarget = {
    address: address.address, type: 'azurerm_container_app', resourceId: rehearsalText(target.resourceId),
    actions: ['update'], expected, role: null,
    runtime: {
      url: rehearsalText(runtime.url), statusField: rehearsalText(runtime.statusField, 40), statusValue: rehearsalText(runtime.statusValue, 40)
    }
  };
  const window = executionWindow({ notBefore: data.notBefore, expiresAt: data.expiresAt, releaseUntil: data.releaseUntil });
  must(typeof data.maxCommandMs === 'number' && Number.isSafeInteger(data.maxCommandMs) &&
    data.maxCommandMs >= 1000 && data.maxCommandMs <= 300_000, 'rehearsal-command-bound');
  must(canonicalSha256(binding) === canonicalSha256(backend.binding) && canonicalSha256(binding) === canonicalSha256(writerBinding) &&
    backend.hostId === custody.tools.hostId && writer.account === backend.backend.ownerId &&
    custody.keyReference.account === backend.backend.ownerId && path.isAbsolute(rehearsalText(writer.keychainPath)) &&
    /^org\.liftoff\.azure-application-writer\.[A-Za-z0-9_.:-]{1,160}$/u.test(rehearsalText(writer.service)), 'rehearsal-actor-owner');
  const intent: ApplicationRehearsalPrivateIntent = {
    schemaVersion: 1, scope: data.scope, binding, backend, custody,
    writer: {
      ...writerBinding, keychainPath: rehearsalText(writer.keychainPath), service: rehearsalText(writer.service),
      account: rehearsalText(writer.account), clientId: applicationUuid(writer.clientId, 'Rehearsal writer client')
    },
    source: {
      rootPathParts, backendPathParts, variablesRef: applicationPrivateReference(source.variablesRef, custody.workspaceId),
      provider: {
        source: 'registry.opentofu.org/hashicorp/azurerm', version: rehearsalText(provider.version), mirrorDirectory,
        binary: { path: binaryPath, sha256: applicationPrivateDigest(binary.sha256) }
      }
    }, targets: [selectedTarget], artifact: privateArtifact, ...window, maxCommandMs: data.maxCommandMs
  };
  if (mode === 'prepare') return { ...intent, mode };
  const reviewed = data.reviewed === null ? null : applicationRehearsalPrivateReview(data.reviewed, custody.workspaceId);
  must(reviewed !== null || mode === 'recover' && data.recovery === 'inspect' && data.candidateRef === null, 'rehearsal-original-review-required');
  if (reviewed) must(reviewed.backendBindingDigest === stateBindingDigest(backend.backend) &&
    canonicalSha256(reviewed.binding) === canonicalSha256(binding) &&
    canonicalSha256(reviewed.artifact) === canonicalSha256(privateArtifact) &&
    reviewed.changes[0]!.address === selectedTarget.address && reviewed.changes[0]!.targetResourceId === selectedTarget.resourceId &&
    reviewed.expiresAt === intent.expiresAt, 'rehearsal-reviewed-binding');
  if (mode === 'apply') {
    must(reviewed, 'rehearsal-original-review-required');
    return { ...intent, mode, reviewed };
  }
  must(data.recovery === 'inspect' || data.recovery === 'publish-retained', 'rehearsal-recovery-no-reapply');
  const checkpoint = applicationPrivateObject(data.checkpoint, ['transactionId', 'journalRef']);
  const transactionId = applicationUuid(checkpoint.transactionId, 'Retained rehearsal transaction');
  const journalRef = applicationPrivateReference(checkpoint.journalRef, custody.workspaceId);
  const candidateRef = data.candidateRef === null ? null : applicationPrivateReference(data.candidateRef, custody.workspaceId);
  must((reviewed === null || transactionId === reviewed.transactionId && journalRef === reviewed.journalRef) &&
    (data.recovery !== 'publish-retained' || candidateRef !== null), 'rehearsal-recovery-original');
  return {
    ...intent, mode, reviewed, recovery: data.recovery, checkpoint: { transactionId, journalRef }, candidateRef,
    recoveryWindow: executionWindow(data.recoveryWindow)
  };
}

export function applicationRehearsalInputs(input: Pick<PhasePlanningInput, 'inspection' | 'phase'>): ApplicationRehearsalInputs {
  requireEnvironmentActivationScope(input);
  must(input.phase.id === 'production-rehearsed', 'rehearsal-phase');
  const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  must(configuration?.budget, 'rehearsal-budget');
  normalizeApprovalCostCeiling(configuration.budget);
  const wrapper = applicationPrivateObject(configuration.phases['production-rehearsed'], ['disposableTarget', 'privateExecution', 'rehearsal']);
  const disposableTarget = disposableTargetConfig(wrapper.disposableTarget);
  const privateExecution = applicationRehearsalPrivateInputs(wrapper.privateExecution);
  const data = applicationPrivateObject(wrapper.rehearsal, ['stage', 'staging', 'baseline', 'candidate', 'rolloutReview', 'rollbackReview']);
  must(data.stage === 'rollout' || data.stage === 'rollback' || data.stage === 'verify', 'rehearsal-stage');
  const old = applicationPrivateObject(data.baseline, ['artifact', 'revisionName', 'workloadIdentity']);
  const workload = applicationPrivateObject(old.workloadIdentity, ['resourceId', 'principalId', 'clientId', 'tenantId']);
  const baseline: ApplicationRehearsalBaseline = {
    artifact: artifact(old.artifact), revisionName: rehearsalText(old.revisionName, 150),
    workloadIdentity: {
      resourceId: rehearsalText(workload.resourceId), principalId: applicationUuid(workload.principalId, 'Original workload principal'),
      clientId: applicationUuid(workload.clientId, 'Original workload client'), tenantId: applicationUuid(workload.tenantId, 'Original workload tenant')
    }
  };
  const rehearsal: ApplicationRehearsalInputs['rehearsal'] = {
    stage: data.stage, staging: qualificationEvidenceReference(data.staging), baseline, candidate: artifact(data.candidate),
    rolloutReview: data.rolloutReview === null ? null : applicationRehearsalReviewReference(data.rolloutReview),
    rollbackReview: data.rollbackReview === null ? null : applicationRehearsalReviewReference(data.rollbackReview)
  };
  const target = disposableTarget.target, app = privateExecution.targets[0]!, declaration = input.inspection.manifest.project.workload;
  must(declaration.kind !== 'components' && declaration.environments.includes('prod') && declaration.environments.includes('staging') &&
    target.environment === 'prod' && target.subscriptionId === privateExecution.binding.subscriptionId &&
    target.tenantId === privateExecution.binding.tenantId && disposableTarget.actor.azurePrincipalId === privateExecution.writer.principalId &&
    app.resourceId === target.resourceId && app.expected.name === target.appName && app.expected.resource_group_name === target.resourceGroup &&
    (app.expected['tags.liftoff-repository-id'] === undefined ||
      app.expected['tags.liftoff-repository-id'] === privateExecution.backend.backend.ownerId) &&
    privateExecution.backend.backend.ownerId === input.inspection.state.remoteBinding?.id &&
    baseline.workloadIdentity.tenantId === target.tenantId && app.expected.revision_mode === 'Single' &&
    app.expected['identity.0.type'] === 'UserAssigned' &&
    app.expected['identity.0.identity_ids.0'] === baseline.workloadIdentity.resourceId, 'rehearsal-exact-target-owner');
  must(new RegExp(`^${target.appName}--[a-z0-9][a-z0-9-]{0,99}$`, 'u').test(baseline.revisionName) &&
    baseline.workloadIdentity.resourceId.startsWith(`/subscriptions/${target.subscriptionId}/resourceGroups/`) &&
    /\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[A-Za-z0-9_-]+$/u.test(baseline.workloadIdentity.resourceId),
  'rehearsal-baseline-identity');
  for (const item of [baseline.artifact, rehearsal.candidate]) {
    azureArmUrl(item.registryResourceId, '2023-07-01', target.subscriptionId);
    if (item.sourceRegistryResourceId !== undefined) {
      azureArmUrl(item.sourceRegistryResourceId, '2023-07-01', target.subscriptionId);
      must(item.sourceRegistryResourceId !== item.registryResourceId, 'rehearsal-mirror-identity');
    }
  }
  must(baseline.artifact.registryResourceId === rehearsal.candidate.registryResourceId &&
    baseline.artifact.imageRef !== rehearsal.candidate.imageRef && baseline.artifact.sourceSha !== rehearsal.candidate.sourceSha,
  'rehearsal-distinct-immutable-baseline');
  const selected = rehearsal.stage === 'rollout' ? rehearsal.candidate : baseline.artifact;
  must(privateExecution.scope === (rehearsal.stage === 'rollout' ? 'rehearsal-rollout' : 'rehearsal-rollback') &&
    canonicalSha256(privateExecution.artifact) === canonicalSha256(rehearsalPrivateArtifact(selected)) &&
    app.expected['template.0.container.0.image'] === selected.imageRef, 'rehearsal-stage-artifact');
  if (privateExecution.mode !== 'prepare' && privateExecution.reviewed) {
    const p = privateExecution;
    must(p.reviewed!.intentDigest === canonicalSha256({
      protocol: applicationPrivateProtocol, intent: applicationRehearsalPrivateIntent(p), budget: configuration.budget
    }) && canonicalSha256(p.reviewed!.tools) === canonicalSha256({
      tofu: p.custody.tools.tofu.sha256, python: p.custody.tools.python.sha256,
      provider: p.source.provider.binary.sha256, providerVersion: p.source.provider.version, hostId: p.custody.tools.hostId
    }), 'rehearsal-exact-original-intent-and-tools');
  }
  must(rehearsal.stage !== 'rollout' || rehearsal.rollbackReview === null, 'rehearsal-review-chain');
  must(privateExecution.mode !== 'prepare' || (rehearsal.stage === 'rollout'
    ? rehearsal.rolloutReview === null : rehearsal.rollbackReview === null), 'rehearsal-review-chain');
  const unpreparedInspection = privateExecution.mode === 'recover' && privateExecution.recovery === 'inspect' && privateExecution.reviewed === null;
  must(rehearsal.stage === 'rollout' && (privateExecution.mode === 'prepare' || unpreparedInspection) ||
    rehearsal.rolloutReview !== null, 'rehearsal-original-rollout-required');
  must(rehearsal.stage !== 'rollback' || privateExecution.mode === 'prepare' || unpreparedInspection ||
    rehearsal.rollbackReview !== null, 'rehearsal-separate-rollback-review');
  must(rehearsal.stage !== 'verify' || privateExecution.mode === 'recover' && privateExecution.recovery === 'inspect' &&
    privateExecution.reviewed !== null && rehearsal.rollbackReview !== null, 'rehearsal-verify-read-only');
  const window = privateExecution.mode === 'recover' ? privateExecution.recoveryWindow : privateExecution;
  must(Date.parse(window.notBefore) >= Date.parse(disposableTarget.notBefore) &&
    Date.parse(window.expiresAt) <= Date.parse(disposableTarget.expiresAt), 'rehearsal-disposable-window');
  return { disposableTarget, privateExecution, rehearsal };
}

/** Core planning/authority hook: rollback consumes its immutable original build, not the latest candidate as the old image. */
export function assertApplicationRehearsalArtifact(input: PhasePlanningInput, expected: ApplicationPrivateArtifact | null): void {
  const config = applicationRehearsalInputs(input);
  must(canonicalSha256(expected) === canonicalSha256(config.privateExecution.artifact), 'rehearsal-exact-private-artifact');
  applicationRehearsalBuildContext(input, config.rehearsal.candidate, true);
  applicationRehearsalBuildContext(input, config.rehearsal.baseline.artifact, false);
}

export function applicationRehearsalBinding(config: ApplicationRehearsalInputs): string {
  const p = config.privateExecution;
  return canonicalSha256({
    protocol: applicationRehearsalProtocol, target: config.disposableTarget.target, actors: config.disposableTarget.actor,
    staging: config.rehearsal.staging, baseline: config.rehearsal.baseline, candidate: config.rehearsal.candidate,
    backend: p.backend, writer: p.writer, custody: p.custody, address: p.targets[0]!.address,
    source: { rootPathParts: p.source.rootPathParts, backendPathParts: p.source.backendPathParts, provider: p.source.provider }
  });
}

export function requireApplicationRehearsalStaging(input: PhasePlanningInput, config: ApplicationRehearsalInputs): void {
  const { record } = requireQualificationEvidence(input.inspection, 'staging-qualified', config.rehearsal.staging, input.now);
  const payload = rehearsalRecord(record.payload), image = parseApplicationImageReference(config.rehearsal.candidate.imageRef);
  must(payload.kind === 'staging-qualified.v1' && payload.sourceSha === config.rehearsal.candidate.sourceSha &&
    payload.artifactDigest === image.digest && input.inspection.state.phases['staging-qualified'].state === 'verified' &&
    record.liveReadback?.some((proof) => proof.provider === 'github' && proof.matches) &&
    record.liveReadback.some((proof) => proof.provider === 'azure' && proof.matches), 'rehearsal-current-qualified-staging');
}

/** Old baseline evidence is historical, not relabelled as the current candidate. Its build is re-read remotely. */
export function applicationRehearsalBuildContext(input: PhasePlanningInput, requested: ApplicationRehearsalArtifact, current: boolean) {
  let record, plan: SavedTransitionPlan;
  if (current) {
    assertApplicationPrivateArtifact(input, rehearsalPrivateArtifact(requested));
    ({ record, plan } = requireQualificationEvidence(input.inspection, 'application-artifact-ready', requested.evidence, input.now));
  }
  else {
    const matches = input.inspection.evidence.filter((entry) => entry.evidenceId === requested.evidence.evidenceId);
    must(matches.length === 1, 'rehearsal-original-build-evidence');
    record = matches[0]!;
    const payload = rehearsalRecord(record.payload);
    const plans = input.inspection.contexts['application-artifact-ready'].reviewedPlans?.filter((entry) =>
      entry.planDigest === payload.planDigest && canonicalSha256(entry) === payload.savedPlanDigest) ?? [];
    must(plans.length === 1, 'rehearsal-original-build-plan');
    plan = plans[0]!;
  }
  const payload = rehearsalRecord(record.payload);
  must(record.header.phaseId === 'application-artifact-ready' && record.header.scope === 'activation' &&
    record.header.result === 'verified' && record.header.producer === 'liftoff-governance-transition-engine' &&
    evidenceHeaderDigest(record.header) === requested.evidence.headerDigest &&
    record.header.bodyDigest === requested.evidence.bodyDigest &&
    evidenceBodyDigest(record.payload, record.liveReadback) === requested.evidence.bodyDigest &&
    payload.kind === 'application-artifact-ready.v1' &&
    (requested.sourceRegistryResourceId !== undefined || payload.imageRef === requested.imageRef) &&
    parseApplicationImageReference(payload.imageRef).digest === parseApplicationImageReference(requested.imageRef).digest &&
    payload.sourceCommitSha === requested.sourceSha && payload.digest === parseApplicationImageReference(requested.imageRef).digest &&
    isRecord(payload.provenance) && payload.provenance.registryResourceId === (requested.sourceRegistryResourceId ?? requested.registryResourceId),
  'rehearsal-original-build-binding');
  return { record, plan, payload };
}

export function applicationRehearsalCompanionOperations(
  input: PhasePlanningInput, config: ApplicationRehearsalInputs, resourceSourceDigest: string,
  nativeReadResourceIds: readonly string[] = []
): readonly [TransitionOperation, TransitionOperation] {
  const repository = input.inspection.state.remoteBinding?.name;
  must(repository, 'rehearsal-repository');
  const target = config.disposableTarget.target, p = config.privateExecution;
  const destination = { type: 'subscription' as const, identity: target.resourceId, subscriptionId: target.subscriptionId };
  const identities = [...new Set([
    ...nativeReadResourceIds,
    target.resourceId, `${target.resourceId}/revisions`, `${target.resourceId}/revisions/${config.rehearsal.baseline.revisionName}`,
    config.rehearsal.baseline.workloadIdentity.resourceId, config.rehearsal.candidate.registryResourceId
  ])].sort();
  for (const identity of identities) azureArmUrl(identity, '2023-05-01', target.subscriptionId);
  return [{
    phaseId: 'production-rehearsed', adapter: 'github', actionId: 'github.application-rehearsal.source-receipt',
    mutationClass: 'github-read', remote: true, destructive: false,
    destination: { type: 'repository', identity: repository, repository },
    inputs: {
      protocol: applicationRehearsalProtocol, target: config.disposableTarget.target,
      candidate: config.rehearsal.candidate, baseline: config.rehearsal.baseline.artifact, staging: config.rehearsal.staging,
      actorId: config.disposableTarget.actor.githubActorId, access: 'original-build-source-artifact-read-only'
    }
  }, {
    phaseId: 'production-rehearsed', adapter: 'azure-opentofu', actionId: 'azure.application-rehearsal.receipt',
    mutationClass: 'backend-state-read', remote: true, destructive: false,
    destination: { ...destination, identity: azureStateUrl(p.backend.backend, 'blob') },
    inputs: { protocol: applicationRehearsalProtocol, rehearsal: config.rehearsal,
      disposableTarget: config.disposableTarget, resourceSourceDigest, independentNativeRefresh: true },
    effects: [
      { mutationClass: 'read-worktree', remote: false, destructive: false,
        destination: { type: 'external', identity: input.inspection.projectRoot } },
      { mutationClass: 'write-local-state', remote: false, destructive: false,
        destination: { type: 'external', identity: `state-workspace:${p.custody.workspaceId}` } },
      ...identities.map((identity) => ({
        mutationClass: 'azure-read' as const, remote: true, destructive: false, destination: { ...destination, identity }
      }))
    ]
  }];
}
