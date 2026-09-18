import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  applicationImageDigest, applicationImageRepository, applicationRegistryHost,
  applicationUuid
} from '../../adapters/azure/application-provisioning.js';
import { AzureArmError, azureArmBinding, type AzureArmBinding } from '../../adapters/azure/activation-rest.js';
import type { ApplicationRegistryTransferUsage } from '../../adapters/azure/application-registry-copy.js';
import {
  applicationRegistryPromotionRegistryId, validateApplicationRegistryPromotionReadback,
  type ApplicationRegistryPromotionReadback
} from '../../adapters/azure/application-registry-readback.js';
import { currentProjectMutationLease } from '../../adapters/filesystem/project-lock.js';
import { readProjectFile } from '../../adapters/filesystem/project-files.js';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import {
  canonicalApprovalEnvelopeHash, evaluateApprovalForTransitionPlan, approvalRequestForSavedPlan,
  normalizeApprovalCostCeiling, savedPlanAuthorityDigest
} from '../../domain/governance/activation/approvals.js';
import {
  evidenceBodyDigest, evidenceHeaderDigest, validateEvidenceFreshness
} from '../../domain/governance/activation/evidence.js';
import { canonicalPhaseGraph, currentActivationIdentity } from '../../domain/governance/activation/graph.js';
import { assertPlanOperationsAllowed, planDigestFor } from '../../domain/governance/activation/operations.js';
import {
  validateEvidenceHeader, validateLiveReadbackProof, validateSavedTransitionPlan
} from '../../domain/governance/activation/validators.js';
import type {
  ApprovalCostCeiling, PhaseEvidenceRecord, TransitionOperation
} from '../../domain/governance/activation/types.js';
import { assertGovernanceApprovalIssued } from '../../governance-activation/authority-records.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import { evidencePathParts, transitionPlanPathParts } from '../../governance-activation/transition-records.js';
import type {
  PhaseAdapterExecutionInput, PhasePlanBuild, PhasePlanningInput
} from '../../governance-activation/transition-ports.js';
import type { CommandRunner } from '../../process-runner.js';
import { readWorkflowEffect } from '../repository-governance/workflow-checkpoints.js';
import { applicationArtifactInputs, applicationArtifactOperations } from './application-artifact-inputs.js';
import type { VerifiedApplicationBuild } from './application-build-report.js';
import { assertAzurePhaseAuthority, AzureActivationAdmissionError } from './authority.js';
import { privateAccessProjectIdentity } from './private-checkpoints.js';
import { qualificationObject, qualificationTimestamp } from './qualification-authority.js';
import { readApplicationArtifactSetReference } from './application-artifact-set-execution.js';
import type { ApplicationArtifactRole } from './application-artifact-inputs.js';

export { applicationRegistryPromotionRegistryId } from '../../adapters/azure/application-registry-readback.js';

export const applicationRegistryPromotionProtocol = 'azure-immutable-registry-promotion/1' as const;
export const applicationRegistryPromotionAction = 'azure.artifact.promote' as const;

export interface ApplicationRegistryBuildReference {
  evidenceId: string;
  headerDigest: string;
  /** Exact original reviewed build plan, not a most-recent-plan selector. */
  planPathParts: readonly string[];
  savedPlanDigest: string;
  artifactSet?: { role: ApplicationArtifactRole; bodyDigest: string; setDigest: string };
}

export interface ApplicationRegistryTransferBounds {
  maxBlobs: number;
  maxManifests: number;
  maxBlobBytes: number;
  maxManifestBytes: number;
  maxConfigBytes: number;
  /** Per-layer decompression ceiling while verifying the configuration's diff IDs. */
  maxExpandedLayerBytes: number;
  /** Unique image bytes retained in memory, including manifests and configurations. */
  maxImageBytes: number;
  /** All HTTP response bodies and attempted request bodies, including ARM and OAuth. */
  maxTransferBytes: number;
  /** HTTP requests plus bounded private Azure CLI account/token acquisitions. */
  maxRequests: number;
  maxWriteRequests: number;
  chunkBytes: number;
  requestTimeoutMs: number;
  deadline: string;
}

export interface ApplicationRegistryPromotionDisposableTarget {
  authorityKind: 'disposable-registry-promotion';
  environment: 'staging' | 'prod';
  registryResourceId: string;
  operator: string;
  spendCeilingCents: number;
  maxDurationMinutes: number;
  permittedEffects: readonly ['azure-read', 'registry-publish'];
  notBefore: string;
  expiresAt: string;
}

export interface ApplicationRegistryPromotionCheckpointReference {
  key: string;
  preparedDigest: string;
}

export interface ApplicationRegistryPromotionConfiguration {
  schemaVersion: 1;
  mode: 'promote' | 'readback' | 'recover';
  binding: AzureArmBinding & { clientId: string | null };
  sourceBuild: ApplicationRegistryBuildReference;
  sourceRegistryResourceId: string;
  sourceLoginServer: string;
  sourceRepository: string;
  imageDigest: string;
  targetRegistryResourceId: string;
  targetLoginServer: string;
  targetRepository: string;
  disposableTarget: ApplicationRegistryPromotionDisposableTarget;
  transfer: ApplicationRegistryTransferBounds;
  checkpoint: ApplicationRegistryPromotionCheckpointReference | null;
}

export interface ApplicationRegistryPromotionSource {
  reference: ApplicationRegistryBuildReference;
  provenance: VerifiedApplicationBuild;
  repository: string;
  repositoryId: number;
  artifactId: number;
  artifactDigest: string;
  originalPlanDigest: string;
  originalApprovalEnvelopeHash: string;
  originalDispatchDigest: string;
}

export interface ApplicationRegistryPromotionReceipt {
  schemaVersion: 1;
  kind: 'application-registry-promotion.v1';
  protocol: typeof applicationRegistryPromotionProtocol;
  source: ApplicationRegistryPromotionSource;
  sourceRegistryResourceId: string;
  targetRegistryResourceId: string;
  sourceImageRef: string;
  targetImageRef: string;
  imageDigest: string;
  configDigest: string;
  readback: ApplicationRegistryPromotionReadback;
  checkpoint: ApplicationRegistryPromotionCheckpointReference;
  planDigest: string;
  approvalEnvelopeHash: string;
  observedAt: string;
}

export type ApplicationRegistryPromotionResult =
  | {
    status: 'completed';
    disposition: 'copied' | 'already-present' | 'recovered' | 'readback';
    receipt: ApplicationRegistryPromotionReceipt;
    usage: ApplicationRegistryTransferUsage;
    completedOperations: readonly TransitionOperation[];
  }
  | {
    status: 'blocked';
    code: string;
    blocker: string;
    checkpoint: ApplicationRegistryPromotionCheckpointReference | null;
    effects: readonly ApplicationRegistryPromotionEffectCheckpoint[];
    usage: ApplicationRegistryTransferUsage;
    completedOperations: readonly [];
  };

function must(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new AzureActivationAdmissionError(`registry-promotion-${code}`, message);
}

function hash(value: unknown): string {
  must(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'digest', 'An exact lowercase SHA-256 metadata commitment is required.');
  return value;
}

function boundedInteger(value: unknown, maximum: number, minimum = 1): number {
  must(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    'bound', 'Promotion requires explicit safe numeric bounds within the supported transfer contract.');
  return value;
}

function text(value: unknown, pattern: RegExp): string {
  must(typeof value === 'string' && pattern.test(value), 'input', 'Promotion requires exact bounded public identities; aliases and credentials are not accepted.');
  return value;
}

function buildReference(value: unknown): ApplicationRegistryBuildReference {
  const data = qualificationObject(value, ['evidenceId', 'headerDigest', 'planPathParts', 'savedPlanDigest',
    ...(isRecord(value) && Object.hasOwn(value, 'artifactSet') ? ['artifactSet'] : [])], 'Original build reference');
  const evidenceId = text(data.evidenceId, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u);
  must(Array.isArray(data.planPathParts) && data.planPathParts.length === 3 &&
    data.planPathParts[0] === 'governance' && data.planPathParts[1] === 'plans' &&
    typeof data.planPathParts[2] === 'string' &&
    /^application-artifact-ready-[A-Za-z0-9-]+\.json$/u.test(data.planPathParts[2]),
  'source-plan', 'Promotion must name the original saved application build plan.');
  let artifactSet: ApplicationRegistryBuildReference['artifactSet'];
  if (data.artifactSet !== undefined) {
    const selected = qualificationObject(data.artifactSet, ['role', 'bodyDigest', 'setDigest'], 'Original complete artifact-set role');
    must(selected.role === 'backend' || selected.role === 'frontend', 'source-role', 'Promotion requires one explicit original artifact role, never a backend fallback.');
    artifactSet = { role: selected.role, bodyDigest: hash(selected.bodyDigest), setDigest: hash(selected.setDigest) };
  }
  return {
    evidenceId, headerDigest: hash(data.headerDigest),
    planPathParts: ['governance', 'plans', data.planPathParts[2]], savedPlanDigest: hash(data.savedPlanDigest),
    ...(artifactSet ? { artifactSet } : {})
  };
}

/** Public configuration contains no bearer material, upload URLs or asserted authorization. */
export function validateApplicationRegistryPromotionConfiguration(value: unknown): ApplicationRegistryPromotionConfiguration {
  const data = qualificationObject(value, [
    'schemaVersion', 'mode', 'binding', 'sourceBuild', 'sourceRegistryResourceId', 'sourceLoginServer',
    'sourceRepository', 'imageDigest', 'targetRegistryResourceId', 'targetLoginServer', 'targetRepository',
    'disposableTarget', 'transfer', 'checkpoint'
  ], 'Registry promotion');
  must(data.schemaVersion === 1 && ['promote', 'readback', 'recover'].includes(String(data.mode)),
    'mode', 'Only explicit immutable promotion, readback or readback-only recovery is supported.');
  const bindingData = qualificationObject(data.binding, ['subscriptionId', 'tenantId', 'principalId', 'clientId'], 'Registry promotion actor');
  const binding = {
    ...azureArmBinding({
      subscriptionId: applicationUuid(bindingData.subscriptionId, 'Promotion subscription'),
      tenantId: applicationUuid(bindingData.tenantId, 'Promotion tenant'),
      principalId: applicationUuid(bindingData.principalId, 'Current registry read/write principal')
    }),
    clientId: bindingData.clientId === null ? null : applicationUuid(bindingData.clientId, 'Explicit Azure client')
  };
  const sourceRegistryResourceId = applicationRegistryPromotionRegistryId(data.sourceRegistryResourceId, binding.subscriptionId);
  const targetRegistryResourceId = applicationRegistryPromotionRegistryId(data.targetRegistryResourceId, binding.subscriptionId);
  const sourceLoginServer = applicationRegistryHost(data.sourceLoginServer);
  const targetLoginServer = applicationRegistryHost(data.targetLoginServer);
  must(sourceRegistryResourceId.toLowerCase() !== targetRegistryResourceId.toLowerCase() && sourceLoginServer !== targetLoginServer,
    'distinct-registries', 'This producer copies between two different exact registries; relabeling the source registry is not promotion.');
  const disposable = qualificationObject(data.disposableTarget, [
    'authorityKind', 'environment', 'registryResourceId', 'operator', 'spendCeilingCents',
    'maxDurationMinutes', 'permittedEffects', 'notBefore', 'expiresAt'
  ], 'Disposable registry target');
  must(disposable.authorityKind === 'disposable-registry-promotion' && (disposable.environment === 'staging' || disposable.environment === 'prod') &&
    disposable.registryResourceId === targetRegistryResourceId &&
    canonicalSha256(disposable.permittedEffects) === canonicalSha256(['azure-read', 'registry-publish']),
  'disposable-target', 'Promotion requires its separately reviewed staging/production registry and exact read/publish effects.');
  const notBefore = qualificationTimestamp(disposable.notBefore, 'Promotion start');
  const expiresAt = qualificationTimestamp(disposable.expiresAt, 'Promotion expiry');
  const maxDurationMinutes = boundedInteger(disposable.maxDurationMinutes, 60);
  must(Date.parse(expiresAt) > Date.parse(notBefore) &&
    Date.parse(expiresAt) - Date.parse(notBefore) <= maxDurationMinutes * 60_000,
  'time', 'The disposable registry interval exceeds its explicitly reviewed time ceiling.');
  const limits = qualificationObject(data.transfer, [
    'maxBlobs', 'maxManifests', 'maxBlobBytes', 'maxManifestBytes', 'maxConfigBytes', 'maxExpandedLayerBytes', 'maxImageBytes',
    'maxTransferBytes', 'maxRequests', 'maxWriteRequests', 'chunkBytes', 'requestTimeoutMs', 'deadline'
  ], 'Registry transfer bounds');
  const transfer: ApplicationRegistryTransferBounds = {
    maxBlobs: boundedInteger(limits.maxBlobs, 256), maxManifests: boundedInteger(limits.maxManifests, 32),
    maxBlobBytes: boundedInteger(limits.maxBlobBytes, 128 * 1024 * 1024),
    maxManifestBytes: boundedInteger(limits.maxManifestBytes, 1024 * 1024),
    maxConfigBytes: boundedInteger(limits.maxConfigBytes, 1024 * 1024),
    maxExpandedLayerBytes: boundedInteger(limits.maxExpandedLayerBytes, 256 * 1024 * 1024),
    maxImageBytes: boundedInteger(limits.maxImageBytes, 256 * 1024 * 1024),
    maxTransferBytes: boundedInteger(limits.maxTransferBytes, 2 * 1024 * 1024 * 1024),
    maxRequests: boundedInteger(limits.maxRequests, 4096),
    maxWriteRequests: boundedInteger(limits.maxWriteRequests, 512),
    chunkBytes: boundedInteger(limits.chunkBytes, 8 * 1024 * 1024),
    requestTimeoutMs: boundedInteger(limits.requestTimeoutMs, 30_000, 100),
    deadline: qualificationTimestamp(limits.deadline, 'Transfer deadline')
  };
  must(transfer.maxConfigBytes <= transfer.maxBlobBytes && transfer.maxBlobBytes <= transfer.maxImageBytes &&
    transfer.maxManifestBytes <= transfer.maxImageBytes && transfer.chunkBytes <= transfer.maxBlobBytes &&
    transfer.maxTransferBytes >= transfer.maxImageBytes && transfer.maxWriteRequests <= transfer.maxRequests &&
    Date.parse(transfer.deadline) > Date.parse(notBefore) && Date.parse(transfer.deadline) <= Date.parse(expiresAt),
  'bounds', 'Transfer sizes, request counts and deadline must fit the explicit image and disposable bounds.');
  let checkpoint: ApplicationRegistryPromotionCheckpointReference | null = null;
  if (data.checkpoint !== null) {
    const reference = qualificationObject(data.checkpoint, ['key', 'preparedDigest'], 'Original promotion checkpoint');
    checkpoint = { key: hash(reference.key), preparedDigest: hash(reference.preparedDigest) };
  }
  must(data.mode === 'recover' ? checkpoint !== null : checkpoint === null,
    'recovery-reference', 'Recovery requires the original exact checkpoint; other modes cannot supply replacement checkpoint metadata.');
  return {
    schemaVersion: 1, mode: data.mode === 'promote' ? 'promote' : data.mode === 'recover' ? 'recover' : 'readback',
    binding, sourceBuild: buildReference(data.sourceBuild), sourceRegistryResourceId, sourceLoginServer,
    sourceRepository: applicationImageRepository(data.sourceRepository), imageDigest: applicationImageDigest(data.imageDigest),
    targetRegistryResourceId, targetLoginServer, targetRepository: applicationImageRepository(data.targetRepository),
    disposableTarget: {
      authorityKind: 'disposable-registry-promotion', environment: disposable.environment, registryResourceId: targetRegistryResourceId,
      operator: text(disposable.operator, /^[A-Za-z0-9][A-Za-z0-9_.@ -]{0,159}$/u),
      spendCeilingCents: boundedInteger(disposable.spendCeilingCents, Number.MAX_SAFE_INTEGER, 0),
      maxDurationMinutes, permittedEffects: ['azure-read', 'registry-publish'], notBefore, expiresAt
    },
    transfer, checkpoint
  };
}

function budgetFor(input: Pick<PhasePlanningInput, 'inspection'>): ApprovalCostCeiling {
  const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  must(configuration?.budget, 'budget', 'Promotion requires an explicit monthly ceiling as well as its independent disposable spending limit.');
  qualificationObject(configuration.budget, ['currency', 'fixedMonthlyCents', 'usageMonthlyCents'], 'Promotion budget');
  return normalizeApprovalCostCeiling(configuration.budget);
}

export function applicationRegistryPromotionInputs(input: Pick<PhasePlanningInput, 'inspection' | 'phase'>): ApplicationRegistryPromotionConfiguration {
  must(['staging-qualified', 'production-rehearsed'].includes(input.phase.id) && (input.inspection.scope ?? 'activation') === 'activation',
    'phase', 'Registry promotion belongs only to an independently approved staging or rehearsal activation stage.');
  const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  const config = validateApplicationRegistryPromotionConfiguration(configuration?.phases[input.phase.id]?.registryPromotion);
  const workload = input.inspection.manifest.project.workload;
  const environment = input.phase.id === 'staging-qualified' ? 'staging' : 'prod';
  must(config.disposableTarget.environment === environment && workload.kind !== 'components' && workload.environments.includes(environment) &&
    configuration?.azure?.subscriptionId?.toLowerCase() === config.binding.subscriptionId &&
    configuration.azure.tenantId?.toLowerCase() === config.binding.tenantId,
  'project-binding', 'The exact promotion environment, subscription and tenant must already be explicitly declared for this project.');
  budgetFor(input);
  return config;
}

export function applicationRegistryPromotionOperation(
  config: ApplicationRegistryPromotionConfiguration, budget: ApprovalCostCeiling
): TransitionOperation {
  const configuration = validateApplicationRegistryPromotionConfiguration(config);
  const destination = (identity: string) => ({
    type: 'subscription' as const, identity, subscriptionId: configuration.binding.subscriptionId
  });
  return {
    phaseId: configuration.disposableTarget.environment === 'staging' ? 'staging-qualified' : 'production-rehearsed',
    adapter: 'azure-opentofu', actionId: applicationRegistryPromotionAction,
    mutationClass: 'registry-publish', remote: true, destructive: false,
    destination: destination(configuration.targetRegistryResourceId),
    inputs: { protocol: applicationRegistryPromotionProtocol, registryPromotion: configuration, budget: normalizeApprovalCostCeiling(budget) },
    effects: [configuration.sourceRegistryResourceId, configuration.targetRegistryResourceId].map((id) => ({
      mutationClass: 'azure-read', remote: true, destructive: false, destination: destination(id)
    }))
  };
}

/** Returns the bounded substage plan, not a claim that staging qualification is complete. */
export function planApplicationRegistryPromotion(input: PhasePlanningInput): PhasePlanBuild {
  try { return { operations: [applicationRegistryPromotionOperation(applicationRegistryPromotionInputs(input), budgetFor(input))] }; }
  catch (error) {
    if (!(error instanceof AzureActivationAdmissionError) && !(error instanceof AzureArmError)) throw error;
    return { operations: [], blockers: [error.message] };
  }
}

async function jsonFile(root: string, parts: readonly string[], maximumBytes: number): Promise<unknown> {
  const bytes = await readProjectFile(root, [...parts]);
  must(bytes && bytes.length <= maximumBytes && isUtf8(bytes), 'source-file', 'The exact original source evidence or plan is missing, oversized or malformed.');
  try { return JSON.parse(bytes.toString('utf8')) as unknown; }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new AzureActivationAdmissionError('registry-promotion-source-file', 'Original source evidence or plan contains invalid JSON.');
  } finally { bytes.fill(0); }
}

interface SourceCustody {
  source: ApplicationRegistryPromotionSource;
  evidenceDigest: string;
}

async function readOriginalBuild(input: PhaseAdapterExecutionInput, config: ApplicationRegistryPromotionConfiguration): Promise<SourceCustody> {
  const reference = config.sourceBuild;
  const root = input.inspection.projectRoot;
  if (reference.artifactSet) {
    const set = await readApplicationArtifactSetReference(input, {
      evidenceId: reference.evidenceId, headerDigest: reference.headerDigest, bodyDigest: reference.artifactSet.bodyDigest,
      planPathParts: reference.planPathParts, savedPlanDigest: reference.savedPlanDigest, setDigest: reference.artifactSet.setDigest
    });
    const selected = set.evidence.artifacts.filter((artifact) => artifact.role === reference.artifactSet!.role);
    const role = selected[0];
    const imageRef = `${config.sourceLoginServer}/${config.sourceRepository}@${config.imageDigest}`;
    must(selected.length === 1 && role && role.provenance.imageRef === imageRef && role.provenance.digest === config.imageDigest &&
      role.provenance.registryResourceId === config.sourceRegistryResourceId &&
      role.provenance.sourceSha === set.evidence.source.sourceSha &&
      set.evidence.source.repositoryId === Number(input.inspection.state.remoteBinding?.id), 'source-role',
    'Promotion source must be the exact selected role of a complete privately retained artifact set; other role bytes or partial sets cannot substitute.');
    const record = input.inspection.evidence.find((entry) => entry.evidenceId === reference.evidenceId)!;
    return {
      source: {
        reference, provenance: role.provenance, repository: set.evidence.source.repository,
        repositoryId: set.evidence.source.repositoryId, artifactId: role.artifact.id, artifactDigest: role.artifact.digest,
        originalPlanDigest: set.originalPlanDigest, originalApprovalEnvelopeHash: set.originalApprovalEnvelopeHash,
        originalDispatchDigest: role.dispatchCheckpointDigest
      },
      evidenceDigest: canonicalSha256(record)
    };
  }
  const raw = qualificationObject(await jsonFile(root, evidencePathParts(reference.evidenceId), 256 * 1024),
    ['evidenceId', 'header', 'payload', 'liveReadback'], 'Original registered build evidence');
  must(raw.evidenceId === reference.evidenceId && Array.isArray(raw.liveReadback),
    'source-evidence', 'The original source build must be an actual body-bound producer record.');
  const record: PhaseEvidenceRecord = {
    evidenceId: reference.evidenceId, header: validateEvidenceHeader(raw.header), payload: raw.payload,
    liveReadback: raw.liveReadback.map(validateLiveReadbackProof)
  };
  const plan = validateSavedTransitionPlan(await jsonFile(root, reference.planPathParts, 256 * 1024));
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'application-artifact-ready')!;
  assertPlanOperationsAllowed(plan, phase);
  const known = input.inspection.evidence.filter((entry) => entry.evidenceId === reference.evidenceId);
  const phaseState = input.inspection.state.phases['application-artifact-ready'];
  must(known.length === 1 && canonicalSha256(known[0]) === canonicalSha256(record) &&
    record.header.result === 'verified' && record.header.producer === 'liftoff-governance-transition-engine' &&
    record.header.phaseId === phase.id && record.header.scope === 'activation' && phaseState.state === 'verified' &&
    evidenceHeaderDigest(record.header) === reference.headerDigest &&
    phaseState.evidence.some((ref) => ref.evidenceId === reference.evidenceId && ref.headerDigest === reference.headerDigest && ref.result === 'verified') &&
    record.header.bodyDigest === evidenceBodyDigest(record.payload, record.liveReadback) &&
    canonicalSha256(plan) === reference.savedPlanDigest &&
    canonicalSha256(transitionPlanPathParts(plan)) === canonicalSha256(reference.planPathParts) &&
    isRecord(record.payload) && record.payload.kind === 'application-artifact-ready.v1' &&
    record.payload.planDigest === plan.planDigest && record.payload.savedPlanDigest === reference.savedPlanDigest,
  'source-evidence', 'Promotion requires the exact current, stored, registered original build evidence and reviewed plan; injected receipts are not proof.');
  const freshness = validateEvidenceFreshness(record, {
    ...input.inspection.contexts['application-artifact-ready'],
    evidenceReferences: [...phaseState.evidence], reviewedPlans: [plan], now: input.clock?.() ?? new Date()
  });
  must(freshness.valid, 'source-freshness', 'The exact original build evidence is not current for the project source, graph and reviewed inputs.');
  const originalInput: PhaseAdapterExecutionInput = {
    ...input, phase, plan, inspection: {
      ...input.inspection, activationInputs: plan.configuration,
      state: { ...input.inspection.state, activationInputs: plan.configuration }
    },
    adapters: {
      ...input.adapters,
      githubActivation: { ...input.adapters.githubActivation, storage: input.adapters.githubActivation?.storage ?? azurePorts(input).storage }
    }
  };
  const build = applicationArtifactInputs(originalInput);
  const operations = applicationArtifactOperations(build);
  const external = plan.operations.filter((entry) => entry.remote);
  must(external.length === operations.length && operations.every((operation) =>
    external.filter((entry) => canonicalSha256(entry) === canonicalSha256(operation)).length === 1),
  'source-operation', 'The original source plan must contain the real registered build dispatch and immutable registry readback.');
  const envelopes = input.inspection.approvals.filter((entry) => entry.id === plan.approval.envelopeId);
  const envelope = envelopes[0];
  must(envelopes.length === 1 && envelope && canonicalApprovalEnvelopeHash(envelope) === plan.approval.envelopeHash,
    'source-approval', 'The original build approval envelope is required; its history cannot be replaced by promotion approval.');
  await assertGovernanceApprovalIssued(root, envelope, azurePorts(input).storage);
  const originalApproval = evaluateApprovalForTransitionPlan(
    approvalRequestForSavedPlan(plan, phase, originalInput.inspection.state), [envelope], { now: new Date(record.header.producedAt) }
  );
  must(!originalApproval.approvalRequired && originalApproval.envelopeHash === plan.approval.envelopeHash,
    'source-approval', 'The actual original build must have completed under its own issued source-bound approval.');
  const payload = record.payload;
  const provenance = qualificationObject(payload.provenance, [
    'digest', 'configDigest', 'imageRef', 'registryResourceId', 'sourceSha', 'runId', 'runAttempt', 'workflowId', 'actorId', 'jobId', 'platform'
  ], 'Original OCI provenance');
  const imageRef = `${config.sourceLoginServer}/${config.sourceRepository}@${config.imageDigest}`;
  must(build.registryResourceId === config.sourceRegistryResourceId && build.imageName === config.sourceRepository &&
    build.azure.subscriptionId === config.binding.subscriptionId && build.azure.tenantId === config.binding.tenantId &&
    (build.expectedDigest === undefined || build.expectedDigest === config.imageDigest) &&
    payload.imageRef === imageRef && payload.digest === config.imageDigest &&
    payload.sourceCommitSha === build.workflow.sourceSha && payload.buildRunId === provenance.runId &&
    provenance.digest === config.imageDigest && provenance.imageRef === imageRef &&
    provenance.registryResourceId === config.sourceRegistryResourceId && provenance.sourceSha === build.workflow.sourceSha &&
    provenance.workflowId === build.workflow.workflowId && provenance.actorId === build.workflow.actorId &&
    provenance.runAttempt === 1 && provenance.platform === build.platform &&
    canonicalSha256(payload.workflow) === canonicalSha256(build.workflow),
  'source-binding', 'Source registry, immutable digest and build provenance must remain exactly those of the original build, never the staging registry.');
  const verified: VerifiedApplicationBuild = {
    digest: config.imageDigest, configDigest: applicationImageDigest(provenance.configDigest), imageRef,
    registryResourceId: config.sourceRegistryResourceId, sourceSha: build.workflow.sourceSha,
    runId: boundedInteger(provenance.runId, Number.MAX_SAFE_INTEGER), runAttempt: 1, workflowId: build.workflow.workflowId,
    actorId: build.workflow.actorId, jobId: boundedInteger(provenance.jobId, Number.MAX_SAFE_INTEGER), platform: build.platform
  };
  const artifact = qualificationObject(payload.artifact, ['id', 'name', 'digest'], 'Original build report artifact');
  must(artifact.name === build.artifactName, 'source-artifact', 'The source report must retain its exact original artifact identity.');
  const artifactId = boundedInteger(artifact.id, Number.MAX_SAFE_INTEGER);
  const artifactDigest = applicationImageDigest(artifact.digest);
  const outputs = input.inspection.state.phaseOutputs?.['application-artifact-ready'];
  const runResourceId = `/repos/${build.workflow.repository}/actions/runs/${verified.runId}`;
  must(outputs && canonicalSha256(payload.outputBindings) === canonicalSha256(outputs) &&
    outputs.values['azure.artifact.imageRef'] === imageRef && outputs.values['azure.artifact.digest'] === config.imageDigest &&
    outputs.values['azure.artifact.sourceSha'] === verified.sourceSha && outputs.values['azure.artifact.configDigest'] === verified.configDigest &&
    outputs.values['azure.artifact.buildRunId'] === verified.runId &&
    outputs.values['github.artifact.id'] === artifactId && outputs.values['github.artifact.digest'] === artifactDigest &&
    outputs.resources.some((resource) => resource.provider === 'azure' && resource.resourceId === config.sourceRegistryResourceId) &&
    record.liveReadback?.some((proof) => proof.provider === 'azure' && proof.matches && proof.resourceId === config.sourceRegistryResourceId) &&
    record.liveReadback?.some((proof) => proof.provider === 'github' && proof.matches && proof.resourceId === runResourceId),
  'source-outputs', 'The original build outputs and independent source registry/run readbacks are not bound to this artifact.');
  const dispatch = await readWorkflowEffect(originalInput, operations[0]!, {
    repositoryId: build.workflow.repositoryId, ref: `${build.workflow.ref}:${build.workflow.workflowId}`,
    purpose: 'workflow-dispatch', step: 'dispatch'
  }, { workflow: build.workflow, dispatchInputs: build.dispatchInputs });
  must(dispatch?.observed && dispatch.observed.providerId === String(verified.runId) &&
    dispatch.observed.resourceId === runResourceId &&
    dispatch.prepared.planDigest === plan.planDigest && dispatch.prepared.approvalEnvelopeHash === plan.approval.envelopeHash,
  'source-custody', 'The original actual build run has no matching immutable private dispatch custody; a public receipt alone cannot authorize promotion.');
  return {
    source: {
      reference, provenance: verified, repository: build.workflow.repository, repositoryId: build.workflow.repositoryId,
      artifactId, artifactDigest, originalPlanDigest: plan.planDigest,
      originalApprovalEnvelopeHash: hash(plan.approval.envelopeHash), originalDispatchDigest: canonicalSha256(dispatch.prepared)
    },
    evidenceDigest: canonicalSha256(record)
  };
}

function immutableTarget(config: ApplicationRegistryPromotionConfiguration) {
  return {
    protocol: applicationRegistryPromotionProtocol, targetRegistryResourceId: config.targetRegistryResourceId.toLowerCase(),
    targetRepository: config.targetRepository, imageDigest: config.imageDigest
  };
}

function immutableSourceAndTarget(config: ApplicationRegistryPromotionConfiguration) {
  return {
    ...immutableTarget(config), binding: config.binding, sourceBuild: config.sourceBuild,
    sourceRegistryResourceId: config.sourceRegistryResourceId, sourceLoginServer: config.sourceLoginServer,
    sourceRepository: config.sourceRepository, targetLoginServer: config.targetLoginServer
  };
}

export interface ApplicationRegistryPromotionPrepared {
  schemaVersion: 1;
  protocol: typeof applicationRegistryPromotionProtocol;
  projectRoot: string;
  projectIdentity: { device: string; inode: string; birthtime: string };
  activationIdentityDigest: string;
  transactionId: string;
  configuration: ApplicationRegistryPromotionConfiguration;
  sourceDigest: string;
  planDigest: string;
  operationDigest: string;
  approvalEnvelopeHash: string;
  preparedAt: string;
}

export interface ApplicationRegistryPromotionEffect {
  kind: 'begin-blob' | 'upload-chunk' | 'complete-blob' | 'put-manifest';
  digest: string;
  size: number;
  offset: number;
  uploadId: string | null;
  bodyDigest: string;
}

export interface ApplicationRegistryPromotionEffectPrepared extends ApplicationRegistryPromotionEffect {
  sequence: number;
  preparedDigest: string;
  clientCorrelationId: string;
  preparedAt: string;
}

export interface ApplicationRegistryPromotionEffectResponse {
  effectDigest: string;
  status: number;
  providerRequestId: string | null;
  uploadId: string | null;
  /** Opaque upload state is deliberately not persisted, even in the private metadata store. */
  uploadState: 'uuid-only' | 'volatile-state-required' | 'unknown' | null;
  returnedAt: string;
}

export interface ApplicationRegistryPromotionEffectCheckpoint {
  prepared: ApplicationRegistryPromotionEffectPrepared;
  response: ApplicationRegistryPromotionEffectResponse | null;
}

export interface ApplicationRegistryPromotionCheckpoint {
  reference: ApplicationRegistryPromotionCheckpointReference;
  prepared: ApplicationRegistryPromotionPrepared;
  effects: readonly ApplicationRegistryPromotionEffectCheckpoint[];
  completed: ApplicationRegistryPromotionReceipt | null;
}

const issued = new WeakSet<PromotionAuthority>();
const stageKey = (key: string, stage: string) => canonicalSha256({ key, stage });

function exactStored<T>(value: unknown, expected: T, code: string): T {
  must(canonicalSha256(value) === canonicalSha256(expected), code, 'The immutable promotion checkpoint is malformed or has changed; preserve it and do not repeat effects.');
  return expected;
}

class PromotionAuthority {
  readonly #configuration: ApplicationRegistryPromotionConfiguration;
  readonly #operation: TransitionOperation;
  readonly #source: SourceCustody;
  readonly #planDigest: string;
  readonly #inputDigest: string;
  readonly #sourceStateDigest: string;
  readonly #store;
  readonly key: string;
  #active = false;
  #ownedTransactionId: string | null = null;

  constructor(readonly input: PhaseAdapterExecutionInput, config: ApplicationRegistryPromotionConfiguration, source: SourceCustody) {
    this.#configuration = structuredClone(config);
    this.#operation = applicationRegistryPromotionOperation(config, budgetFor(input));
    this.#source = structuredClone(source);
    this.#planDigest = canonicalSha256(input.plan);
    this.#inputDigest = canonicalSha256({ config, manifest: input.inspection.manifest, budget: budgetFor(input) });
    this.#sourceStateDigest = canonicalSha256({
      phase: input.inspection.state.phases['application-artifact-ready'],
      outputs: input.inspection.state.phaseOutputs?.['application-artifact-ready']
    });
    this.key = canonicalSha256(immutableTarget(config));
    this.#store = createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', azurePorts(input).storage);
  }

  get configuration() { return structuredClone(this.#configuration); }
  get source() { return structuredClone(this.#source.source); }
  get operation() { return structuredClone(this.#operation); }
  get projectRoot() { return this.input.inspection.projectRoot; }
  get runner(): CommandRunner { return this.input.runner; }
  now(): number { return (this.input.clock?.() ?? new Date()).getTime(); }

  async assertCurrent(): Promise<void> {
    must(issued.has(this), 'authority', 'Only a privately issued real phase approval can create registry promotion authority.');
    const lease = await currentProjectMutationLease(this.projectRoot);
    must(lease, 'lease', 'Registry promotion requires the actual held project mutation lease, not a supplied success callback.');
    await lease.assertHeld();
    const config = applicationRegistryPromotionInputs(this.input);
    must(this.#planDigest === canonicalSha256(this.input.plan) &&
      this.#inputDigest === canonicalSha256({ config, manifest: this.input.inspection.manifest, budget: budgetFor(this.input) }),
    'drift', 'The reviewed promotion plan, project or source/target/actor/transfer inputs changed.');
    await assertCurrentApproval({ ...this.input, lease }, config, this.#operation);
    const raw = await jsonFile(this.projectRoot, evidencePathParts(config.sourceBuild.evidenceId), 256 * 1024);
    const plan = await jsonFile(this.projectRoot, config.sourceBuild.planPathParts, 256 * 1024);
    const observed = this.input.inspection.evidence.filter((entry) => entry.evidenceId === config.sourceBuild.evidenceId);
    must(canonicalSha256(raw) === this.#source.evidenceDigest &&
      canonicalSha256(plan) === config.sourceBuild.savedPlanDigest &&
      observed.length === 1 && canonicalSha256(observed[0]) === this.#source.evidenceDigest &&
      this.#sourceStateDigest === canonicalSha256({
        phase: this.input.inspection.state.phases['application-artifact-ready'],
        outputs: this.input.inspection.state.phaseOutputs?.['application-artifact-ready']
      }),
    'source-drift', 'Original build evidence or its reviewed plan changed during promotion.');
    if (config.sourceBuild.artifactSet) {
      const current = await readOriginalBuild(this.input, config);
      must(canonicalSha256(current) === canonicalSha256(this.#source), 'source-role-drift',
        'The original complete artifact-set role or private custody changed during promotion.');
    }
  }

  enter(): void {
    must(issued.has(this) && !this.#active, 'concurrent', 'One authority cannot start concurrent registry transfers.');
    this.#active = true;
  }
  leave(): void { this.#active = false; }

  async checkpoint(): Promise<ApplicationRegistryPromotionCheckpoint | null> {
    must(issued.has(this), 'authority', 'An actual issued promotion authority is required to inspect private effect custody.');
    const start = await this.#store.read(stageKey(this.key, 'prepared'));
    const final = await this.#store.read(stageKey(this.key, 'completed'));
    if (!start) {
      must(!final, 'checkpoint', 'Promotion completion has no original private pre-effect checkpoint.');
      return null;
    }
    const value = qualificationObject(start.value, [
      'schemaVersion', 'protocol', 'projectRoot', 'projectIdentity', 'activationIdentityDigest', 'transactionId',
      'configuration', 'sourceDigest', 'planDigest', 'operationDigest', 'approvalEnvelopeHash', 'preparedAt'
    ], 'Original promotion checkpoint');
    const identity = await privateAccessProjectIdentity(this.projectRoot);
    const configuration = validateApplicationRegistryPromotionConfiguration(value.configuration);
    must(canonicalSha256(immutableSourceAndTarget(configuration)) === canonicalSha256(immutableSourceAndTarget(this.#configuration)),
      'checkpoint-binding', 'This output already has custody for a different source or actor; no replacement promotion is authorized.');
    const prepared: ApplicationRegistryPromotionPrepared = exactStored(value, {
      schemaVersion: 1, protocol: applicationRegistryPromotionProtocol, ...identity,
      activationIdentityDigest: canonicalSha256(currentActivationIdentity),
      transactionId: applicationUuid(value.transactionId, 'Local promotion transaction'),
      configuration, sourceDigest: canonicalSha256(this.source), planDigest: hash(value.planDigest),
      operationDigest: hash(value.operationDigest), approvalEnvelopeHash: hash(value.approvalEnvelopeHash),
      preparedAt: qualificationTimestamp(value.preparedAt, 'Original promotion preparation')
    }, 'checkpoint');
    must(start.projectRoot === this.projectRoot, 'checkpoint-project', 'Original promotion custody belongs to another project.');
    const reference = { key: this.key, preparedDigest: canonicalSha256(prepared) };
    if (this.#configuration.checkpoint) exactStored(this.#configuration.checkpoint, reference, 'recovery-reference');
    const effects: ApplicationRegistryPromotionEffectCheckpoint[] = [];
    for (let sequence = 0; sequence <= configuration.transfer.maxWriteRequests; sequence++) {
      const [p, r] = await Promise.all([
        this.#store.read(stageKey(this.key, `effect-${sequence}`)),
        this.#store.read(stageKey(this.key, `response-${sequence}`))
      ]);
      if (!p) {
        must(!r, 'checkpoint-effect', 'A returned registry effect has no original pre-effect checkpoint.');
        break;
      }
      must(sequence < configuration.transfer.maxWriteRequests, 'checkpoint-bound', 'Retained registry effects exceed their original reviewed count.');
      const effect = qualificationObject(p.value, [
        'kind', 'digest', 'size', 'offset', 'uploadId', 'bodyDigest', 'sequence', 'preparedDigest', 'clientCorrelationId', 'preparedAt'
      ], 'Registry pre-effect checkpoint');
      const intent = validateEffect(effect, configuration.transfer);
      const decoded: ApplicationRegistryPromotionEffectPrepared = exactStored(effect, {
        ...intent, sequence, preparedDigest: reference.preparedDigest,
        clientCorrelationId: applicationUuid(effect.clientCorrelationId, 'Client-only registry correlation'),
        preparedAt: qualificationTimestamp(effect.preparedAt, 'Registry pre-effect time')
      }, 'checkpoint-effect');
      let response: ApplicationRegistryPromotionEffectResponse | null = null;
      if (r) {
        const returned = qualificationObject(r.value, [
          'effectDigest', 'status', 'providerRequestId', 'uploadId', 'uploadState', 'returnedAt'
        ], 'Registry response checkpoint');
        const uploadState = returned.uploadState;
        must(uploadState === null || uploadState === 'uuid-only' || uploadState === 'volatile-state-required' || uploadState === 'unknown',
          'checkpoint-response', 'Unsupported registry upload custody metadata.');
        response = exactStored(returned, {
          effectDigest: canonicalSha256(decoded), status: boundedInteger(returned.status, 599, 100),
          providerRequestId: returned.providerRequestId === null ? null : applicationUuid(returned.providerRequestId, 'Actual registry request'),
          uploadId: returned.uploadId === null ? null : applicationUuid(returned.uploadId, 'Actual registry upload'),
          uploadState, returnedAt: qualificationTimestamp(returned.returnedAt, 'Registry response time')
        }, 'checkpoint-response');
        must(response.providerRequestId !== decoded.clientCorrelationId &&
          Date.parse(response.returnedAt) >= Date.parse(decoded.preparedAt),
        'checkpoint-response', 'Client correlation cannot stand in for a provider-issued request ID.');
      }
      effects.push({ prepared: decoded, response });
    }
    let completed: ApplicationRegistryPromotionReceipt | null = null;
    if (final) {
      qualificationObject(final.value, ['receipt', 'receiptDigest'], 'Retained promotion completion');
      must(isRecord(final.value) && isRecord(final.value.receipt) &&
        final.value.receiptDigest === canonicalSha256(final.value.receipt) &&
        canonicalSha256(final.value.receipt.checkpoint) === canonicalSha256(reference) &&
        canonicalSha256(final.value.receipt.source) === canonicalSha256(this.source) &&
        final.value.receipt.imageDigest === configuration.imageDigest,
      'checkpoint-completion', 'Retained promotion completion is malformed; independent readback is still required.');
      // Completion is never authority for skipping a new target byte readback.
      completed = decodeReceipt(final.value.receipt, this.source, reference, configuration);
    }
    return { reference, prepared, effects, completed };
  }

  async prepare(): Promise<ApplicationRegistryPromotionCheckpoint> {
    await this.assertCurrent();
    const prior = await this.checkpoint();
    if (prior) return prior;
    must(this.#configuration.mode !== 'recover', 'missing-recovery', 'Recovery cannot create a replacement for missing original custody.');
    const prepared: ApplicationRegistryPromotionPrepared = {
      schemaVersion: 1, protocol: applicationRegistryPromotionProtocol,
      ...await privateAccessProjectIdentity(this.projectRoot), activationIdentityDigest: canonicalSha256(currentActivationIdentity),
      transactionId: randomUUID(), configuration: this.configuration, sourceDigest: canonicalSha256(this.source),
      planDigest: this.input.plan.planDigest, operationDigest: canonicalSha256(this.operation),
      approvalEnvelopeHash: hash(this.input.plan.approval.envelopeHash), preparedAt: new Date(this.now()).toISOString()
    };
    await this.#store.write(stageKey(this.key, 'prepared'), prepared);
    this.#ownedTransactionId = prepared.transactionId;
    await this.assertCurrent();
    return { reference: { key: this.key, preparedDigest: canonicalSha256(prepared) }, prepared, effects: [], completed: null };
  }

  async prepareEffect(intent: ApplicationRegistryPromotionEffect): Promise<ApplicationRegistryPromotionEffectPrepared> {
    await this.assertCurrent();
    must(this.#active && this.#configuration.mode === 'promote', 'read-only-recovery', 'Registry readback and recovery can never authorize registry writes.');
    const checkpoint = await this.prepare();
    must(!checkpoint.completed && this.#ownedTransactionId === checkpoint.prepared.transactionId &&
      checkpoint.prepared.planDigest === this.input.plan.planDigest &&
      checkpoint.prepared.approvalEnvelopeHash === this.input.plan.approval.envelopeHash &&
      checkpoint.effects.length < this.#configuration.transfer.maxWriteRequests,
    'effect-authority', 'Registry effects must remain inside the original approved bounded execution.');
    const effect: ApplicationRegistryPromotionEffectPrepared = {
      ...validateEffect(intent, this.#configuration.transfer), sequence: checkpoint.effects.length,
      preparedDigest: checkpoint.reference.preparedDigest, clientCorrelationId: randomUUID(),
      preparedAt: new Date(this.now()).toISOString()
    };
    await this.#store.write(stageKey(this.key, `effect-${effect.sequence}`), effect);
    await this.assertCurrent();
    return effect;
  }

  async recordResponse(
    effect: ApplicationRegistryPromotionEffectPrepared,
    response: Omit<ApplicationRegistryPromotionEffectResponse, 'effectDigest' | 'returnedAt'>
  ): Promise<void> {
    must(issued.has(this), 'authority', 'Registry response custody requires its original issued authority.');
    const original = await this.#store.read(stageKey(this.key, `effect-${effect.sequence}`));
    must(original && canonicalSha256(original.value) === canonicalSha256(effect), 'effect-response', 'Registry response has no exact original pre-effect record.');
    must(response.uploadState === null || response.uploadState === 'uuid-only' ||
      response.uploadState === 'volatile-state-required' || response.uploadState === 'unknown',
    'effect-response', 'Only non-secret scoped upload custody classifications may be recorded, never upload URLs or opaque state.');
    const value: ApplicationRegistryPromotionEffectResponse = {
      effectDigest: canonicalSha256(effect), status: boundedInteger(response.status, 599, 100),
      providerRequestId: response.providerRequestId === null ? null : applicationUuid(response.providerRequestId, 'Provider registry request'),
      uploadId: response.uploadId === null ? null : applicationUuid(response.uploadId, 'Provider upload'),
      uploadState: response.uploadState, returnedAt: new Date(this.now()).toISOString()
    };
    must(value.providerRequestId !== effect.clientCorrelationId, 'client-correlation', 'Client correlation is not an actual provider-issued request ID.');
    // A returned effect must be retained even if its deadline/approval expired in flight.
    await this.#store.write(stageKey(this.key, `response-${effect.sequence}`), value);
  }
}

function validateEffect(value: ApplicationRegistryPromotionEffect | Record<string, unknown>, bounds: ApplicationRegistryTransferBounds): ApplicationRegistryPromotionEffect {
  must(value.kind === 'begin-blob' || value.kind === 'upload-chunk' || value.kind === 'complete-blob' || value.kind === 'put-manifest',
    'effect', 'Only digest-scoped blob upload and immutable manifest effects are supported.');
  const uploadId = value.uploadId === null ? null : applicationUuid(value.uploadId, 'Scoped provider upload UUID');
  const size = boundedInteger(value.size, value.kind === 'put-manifest' ? bounds.maxManifestBytes : bounds.maxBlobBytes, 0);
  const offset = boundedInteger(value.offset, bounds.maxBlobBytes, 0);
  must((value.kind === 'begin-blob' || value.kind === 'put-manifest') ? uploadId === null && offset === 0 : uploadId !== null,
    'effect-upload', 'An upload effect requires its actual provider-issued scoped upload UUID.');
  return { kind: value.kind, digest: applicationImageDigest(value.digest), size, offset, uploadId, bodyDigest: applicationImageDigest(value.bodyDigest) };
}

function decodeReceipt(
  value: Record<string, unknown>, source: ApplicationRegistryPromotionSource, checkpoint: ApplicationRegistryPromotionCheckpointReference,
  configuration: ApplicationRegistryPromotionConfiguration
): ApplicationRegistryPromotionReceipt {
  must(value.schemaVersion === 1 && value.kind === 'application-registry-promotion.v1' &&
    value.protocol === applicationRegistryPromotionProtocol && isRecord(value.readback),
  'receipt', 'Unsupported retained promotion receipt.');
  // The full persisted body is a consistency commitment, never a substitute for the live verifier.
  const receipt: ApplicationRegistryPromotionReceipt = {
    schemaVersion: 1, kind: 'application-registry-promotion.v1', protocol: applicationRegistryPromotionProtocol,
    source, checkpoint, sourceRegistryResourceId: configuration.sourceRegistryResourceId,
    targetRegistryResourceId: configuration.targetRegistryResourceId,
    sourceImageRef: source.provenance.imageRef,
    targetImageRef: `${configuration.targetLoginServer}/${configuration.targetRepository}@${configuration.imageDigest}`,
    imageDigest: configuration.imageDigest, configDigest: source.provenance.configDigest,
    readback: validateApplicationRegistryPromotionReadback(value.readback),
    planDigest: hash(value.planDigest), approvalEnvelopeHash: hash(value.approvalEnvelopeHash),
    observedAt: qualificationTimestamp(value.observedAt, 'Retained promotion observation')
  };
  must(receipt.readback.sourceRegistry.id.toLowerCase() === configuration.sourceRegistryResourceId.toLowerCase() &&
    receipt.readback.targetRegistry.id.toLowerCase() === configuration.targetRegistryResourceId.toLowerCase() &&
    receipt.readback.sourceRegistry.loginServer === configuration.sourceLoginServer &&
    receipt.readback.targetRegistry.loginServer === configuration.targetLoginServer &&
    receipt.readback.imageDigest === configuration.imageDigest && receipt.readback.configDigest === source.provenance.configDigest &&
    receipt.readback.sourceSha === source.provenance.sourceSha && receipt.readback.sourceRepository === source.repository &&
    receipt.readback.platform === source.provenance.platform,
  'receipt-binding', 'The retained receipt does not bind the original source and exact target registry readback.');
  return exactStored(value, receipt, 'receipt');
}

async function assertCurrentApproval(
  input: PhaseAdapterExecutionInput, config: ApplicationRegistryPromotionConfiguration, operation: TransitionOperation
): Promise<void> {
  const external = input.plan.operations.filter((entry) => entry.remote);
  must(external.length === 1 && canonicalSha256(external[0]) === canonicalSha256(operation) &&
    input.plan.recovery === (config.mode === 'recover'),
  'operation', 'The promotion substage requires exactly its own reviewed registry operation; build, deploy and unrelated writes are not implied.');
  await assertAzurePhaseAuthority(input, operation);
  const matches = input.inspection.approvals.filter((entry) => entry.id === input.plan.approval.envelopeId);
  const envelope = matches[0];
  must(matches.length === 1 && envelope && envelope.approver === config.disposableTarget.operator &&
    canonicalApprovalEnvelopeHash(envelope) === input.plan.approval.envelopeHash &&
    input.plan.planDigest === planDigestFor({
      phase: input.phase, transitionDigest: input.plan.transitionDigest, operations: input.plan.operations,
      approvalPlanDigest: savedPlanAuthorityDigest(input.plan, input.phase)
    }) &&
    ['azure-read', 'registry-publish'].every((effect) => envelope.permissions.includes(effect)) &&
    [config.sourceRegistryResourceId, config.targetRegistryResourceId].every((id) =>
      envelope.resources.some((resource) => resource.identity === id)),
  'approval', 'The real issued approval must bind both exact registries, current operator, effects and operation digest.');
  const now = (input.clock?.() ?? new Date()).getTime();
  must(Number.isFinite(now) && now >= Math.max(Date.parse(config.disposableTarget.notBefore), Date.parse(envelope.approvedAt)) &&
    now < Math.min(Date.parse(config.transfer.deadline), Date.parse(config.disposableTarget.expiresAt),
      Date.parse(input.plan.expiresAt), Date.parse(envelope.expiresAt)),
  'deadline', 'The exact disposable promotion, transfer, plan or approval interval is not current.');
}

/** Opaque runtime authority: structural objects and caller-provided authorizer functions are rejected. */
export type ApplicationRegistryPromotionAdmission = PromotionAuthority;

/** Reads original producer custody only; this grants no registry access or promotion authority. */
export async function readApplicationRegistryPromotionSource(input: PhaseAdapterExecutionInput): Promise<ApplicationRegistryPromotionSource> {
  return (await readOriginalBuild(input, applicationRegistryPromotionInputs(input))).source;
}

export async function createApplicationRegistryPromotionAdmission(input: PhaseAdapterExecutionInput): Promise<ApplicationRegistryPromotionAdmission> {
  const config = applicationRegistryPromotionInputs(input);
  const lease = await currentProjectMutationLease(input.inspection.projectRoot);
  must(input.lease && lease, 'lease', 'Promotion requires the actual cooperating project mutation lease, not an injected lease callback.');
  const execution = { ...input, lease };
  await assertCurrentApproval(execution, config, applicationRegistryPromotionOperation(config, budgetFor(input)));
  const source = await readOriginalBuild(execution, config);
  const authority = new PromotionAuthority(execution, config, source);
  issued.add(authority);
  await authority.assertCurrent();
  return authority;
}

export async function assertApplicationRegistryPromotionAuthority(authority: ApplicationRegistryPromotionAdmission): Promise<void> {
  must(issued.has(authority), 'authority', 'A structural or forged registry promotion authority cannot grant access.');
  await authority.assertCurrent();
}

export async function readApplicationRegistryPromotionCheckpoint(
  authority: ApplicationRegistryPromotionAdmission
): Promise<ApplicationRegistryPromotionCheckpoint | null> {
  await assertApplicationRegistryPromotionAuthority(authority);
  return authority.checkpoint();
}
