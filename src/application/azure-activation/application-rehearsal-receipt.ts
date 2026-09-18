import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import {
  approvalRequestForSavedPlan, canonicalApprovalEnvelopeHash, evaluateApprovalForTransitionPlan, savedPlanAuthorityDigest
} from '../../domain/governance/activation/approvals.js';
import { canonicalPhaseGraph } from '../../domain/governance/activation/graph.js';
import { assertPlanOperationsAllowed, planDigestFor } from '../../domain/governance/activation/operations.js';
import { validateApprovalEnvelope, validateSavedTransitionPlan } from '../../domain/governance/activation/validators.js';
import type { SavedTransitionPlan, TransitionOperation } from '../../domain/governance/activation/types.js';
import type {
  PhaseAdapterExecutionInput, PhasePlanningInput, PhaseReviewRequest
} from '../../governance-activation/transition-ports.js';
import { validatePhaseReview } from '../../governance-activation/phase-reviews.js';
import { assertGovernanceApprovalIssued } from '../../governance-activation/authority-records.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import { clientFor } from '../../governance-activation/github-config.js';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { protectedStateScope } from '../../adapters/state/protected-workspace.js';
import { readPrivateNativeFile } from '../../adapters/state/native-files.js';
import type { StateArtifactDescriptor, StateBackendMetadata } from '../../domain/repair/stateful.js';
import { stateDigest, stateMetadataMatches } from '../../domain/repair/stateful-invariants.js';
import { applicationUuid, parseApplicationImageReference } from '../../adapters/azure/application-provisioning.js';
import {
  ApplicationPrivateOpenTofu, applicationPrivateNativeFiles, inspectApplicationPrivateInstallation
} from '../../adapters/azure/application-private-opentofu.js';
import { createApplicationPrivateRuntime, type ApplicationPrivateAdapters } from '../../adapters/azure/application-private-runtime.js';
import { GitHubActivationClient, positiveId } from '../../adapters/github/activation-rest.js';
import { readBoundWorkflowRun, readBoundWorkflowArtifact } from '../../adapters/github/production-checks.js';
import { readWorkflowEffect } from '../repository-governance/workflow-checkpoints.js';
import {
  applicationPrivateAssert as must, type ApplicationPrivateAuthority, type ApplicationPrivateSavedPlan
} from './application-private-contracts.js';
import {
  applicationPrivateContext, applicationPrivateInputs, applicationPrivateIntent, applicationPrivateObject
} from './application-private-inputs.js';
import { ApplicationPrivateCheckpointStore } from './application-private-checkpoints.js';
import {
  applicationPrivateNativeRoot, inspectApplicationPrivateSource, verifyApplicationPrivateSource
} from './application-private-source.js';
import {
  completedApplicationPrivateResult, readApplicationPrivateArtifact, readApplicationPrivateSavedPlan,
  validateApplicationPrivateEffectIntents, verifyApplicationPrivateOriginalAuthority
} from './application-private-custody.js';
import {
  admitApplicationPrivatePlan, applicationPrivateJson, applicationPrivateState, applicationPrivateValue, inspectApplicationPrivateCandidate
} from './application-private-plan.js';
import { applicationArtifactInputs, defaultAzureArmTransport } from './application-artifact-inputs.js';
import { readApplicationBuildArchive, validateApplicationBuildReport, type VerifiedApplicationBuild } from './application-build-report.js';
import {
  applicationRehearsalBinding, applicationRehearsalBuildContext, applicationRehearsalInputs,
  applicationRehearsalPrivateIntent, applicationRehearsalPrivateReview, applicationRehearsalProtocol, rehearsalRecord, rehearsalText,
  type ApplicationRehearsalArtifact, type ApplicationRehearsalInputs, type ApplicationRehearsalPrivateReview,
  type ApplicationRehearsalReviewReference
} from './application-rehearsal-inputs.js';
import {
  assertIssuedApplicationRehearsalAuthority, type ApplicationRehearsalPrivateAuthority
} from './application-rehearsal-authority.js';
import { applicationRehearsalRecordStorage } from './application-rehearsal-record-storage.js';

export { assertApplicationRehearsalProjectLease } from './application-rehearsal-authority.js';

export type ApplicationRehearsalStepKind = 'rollout-prepared' | 'rollout-completed' | 'rollback-prepared' | 'rollback-completed';
export interface ApplicationRehearsalRoot {
  schemaVersion: 1;
  protocol: typeof applicationRehearsalProtocol;
  sequence: number;
  rehearsalId: string;
  projectRoot: string;
  projectIdentity: { device: string; inode: string; birthtime: string };
  backendKey: string;
  bindingDigest: string;
  sourceDigest: string;
  workspaceRef: string;
  originalPlan: SavedTransitionPlan;
}

export interface ApplicationRehearsalRetainedStep {
  schemaVersion: 1;
  protocol: typeof applicationRehearsalProtocol;
  rootDigest: string;
  kind: ApplicationRehearsalStepKind;
  plan: SavedTransitionPlan;
  reviewed: ApplicationRehearsalPrivateReview;
  snapshot: StateArtifactDescriptor;
  recordedAt: string;
}

const completedReceipts = new WeakMap<CompletedApplicationRehearsalReceipt, string>();

async function projectIdentity(root: string) {
  const info = await lstat(root);
  must(info.isDirectory() && !info.isSymbolicLink() && await realpath(root) === root, 'rehearsal-project-identity');
  return { device: String(info.dev), inode: String(info.ino), birthtime: String(info.birthtimeMs) };
}

/**
 * These immutable indices reserve the backend across BOTH native transactions.
 * A closed rollout journal cannot let a new rollout forget its unfinished rollback.
 * Index entries are locators, never proof; receipts reopen the native journals.
 */
export class ApplicationRehearsalRecordStore {
  readonly #store;
  readonly #backendKey: string;
  constructor(private readonly input: PhaseAdapterExecutionInput, private readonly config: ApplicationRehearsalInputs) {
    this.#store = applicationRehearsalRecordStorage(
      createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', azurePorts(input).storage)
    );
    const backend = config.privateExecution.backend.backend;
    this.#backendKey = canonicalSha256({
      protocol: applicationRehearsalProtocol, tenantId: backend.tenantId.toLowerCase(),
      subscriptionId: backend.subscriptionId.toLowerCase(), account: backend.account.toLowerCase(),
      container: backend.container.toLowerCase(), key: backend.key
    });
  }

  private key(sequence: number, kind: string) {
    return canonicalSha256({ protocol: applicationRehearsalProtocol, backend: this.#backendKey, sequence, kind });
  }

  async find(): Promise<{ root: ApplicationRehearsalRoot | null; closed: boolean; next: number }> {
    const identity = await projectIdentity(this.input.inspection.projectRoot);
    let root: ApplicationRehearsalRoot | null = null;
    for (let sequence = 0; sequence < 32; sequence++) {
      const record = await this.#store.read(this.key(sequence, 'started'));
      const closed = await this.#store.read(this.key(sequence, 'verified'));
      if (!record) {
        must(!closed, 'rehearsal-index-gap');
        return { root, closed: root !== null, next: sequence };
      }
      const data = applicationPrivateObject(record.value, ['schemaVersion', 'protocol', 'sequence', 'rehearsalId', 'projectRoot',
        'projectIdentity', 'backendKey', 'bindingDigest', 'sourceDigest', 'workspaceRef', 'originalPlan']);
      must(data.schemaVersion === 1 && data.protocol === applicationRehearsalProtocol && data.sequence === sequence &&
        data.projectRoot === record.projectRoot && data.projectRoot === this.input.inspection.projectRoot &&
        canonicalSha256(data.projectIdentity) === canonicalSha256(identity) && data.backendKey === this.#backendKey,
      'rehearsal-index-binding');
      const originalPlan = validateSavedTransitionPlan(data.originalPlan);
      const original = applicationRehearsalInputs({
        ...this.input, inspection: { ...this.input.inspection, activationInputs: originalPlan.configuration }
      });
      must(originalPlan.phaseId === 'production-rehearsed' && original.rehearsal.stage === 'rollout' &&
        original.privateExecution.mode === 'prepare' && data.bindingDigest === applicationRehearsalBinding(original) &&
        data.workspaceRef === `state-workspace:${original.privateExecution.custody.workspaceId}` &&
        typeof data.sourceDigest === 'string' && /^[a-f0-9]{64}$/u.test(data.sourceDigest), 'rehearsal-original-root');
      root = {
        schemaVersion: 1, protocol: applicationRehearsalProtocol, sequence,
        rehearsalId: applicationUuid(data.rehearsalId, 'Original rehearsal ID'), projectRoot: record.projectRoot,
        projectIdentity: identity, backendKey: this.#backendKey, bindingDigest: applicationRehearsalBinding(original),
        sourceDigest: data.sourceDigest, workspaceRef: rehearsalText(data.workspaceRef), originalPlan
      };
      if (!closed) return { root, closed: false, next: sequence + 1 };
      const final = applicationPrivateObject(closed.value, ['schemaVersion', 'protocol', 'rootDigest', 'receipt', 'verifiedAt']);
      must(final.schemaVersion === 1 && final.protocol === applicationRehearsalProtocol &&
        final.rootDigest === canonicalSha256(root) && isRecord(final.receipt) &&
        final.receipt.kind === 'completed-private-application-rehearsal.v1' &&
        final.receipt.rehearsalId === root.rehearsalId, 'rehearsal-closure');
    }
    must(false, 'rehearsal-retention-bound');
  }

  async start(sequence: number, sourceDigest: string, authority: ApplicationPrivateAuthority): Promise<ApplicationRehearsalRoot> {
    await authority.assertCurrent();
    must(this.config.rehearsal.stage === 'rollout' && this.config.privateExecution.mode === 'prepare', 'rehearsal-original-rollout-required');
    const root: ApplicationRehearsalRoot = {
      schemaVersion: 1, protocol: applicationRehearsalProtocol, sequence, rehearsalId: randomUUID(),
      projectRoot: this.input.inspection.projectRoot, projectIdentity: await projectIdentity(this.input.inspection.projectRoot),
      backendKey: this.#backendKey, bindingDigest: applicationRehearsalBinding(this.config), sourceDigest,
      workspaceRef: `state-workspace:${this.config.privateExecution.custody.workspaceId}`, originalPlan: structuredClone(this.input.plan)
    };
    await this.#store.write(this.key(sequence, 'started'), root);
    await authority.assertCurrent();
    return root;
  }

  async read(root: ApplicationRehearsalRoot, kind: ApplicationRehearsalStepKind): Promise<ApplicationRehearsalRetainedStep | null> {
    const record = await this.#store.read(this.key(root.sequence, kind));
    if (!record) return null;
    const data = applicationPrivateObject(record.value, ['schemaVersion', 'protocol', 'rootDigest', 'kind', 'plan', 'reviewed', 'snapshot', 'recordedAt']);
    must(data.schemaVersion === 1 && data.protocol === applicationRehearsalProtocol && data.rootDigest === canonicalSha256(root) &&
      data.kind === kind && record.projectRoot === root.projectRoot, 'rehearsal-step-binding');
    const plan = validateSavedTransitionPlan(data.plan);
    const config = applicationRehearsalInputs({ ...this.input, inspection: { ...this.input.inspection, activationInputs: plan.configuration } });
    const snapshot = applicationPrivateObject(data.snapshot, ['ref', 'purpose', 'scope', 'digest']);
    must(plan.phaseId === 'production-rehearsed' && applicationRehearsalBinding(config) === root.bindingDigest &&
      kind.startsWith(config.rehearsal.stage) && snapshot.purpose === 'inspection' &&
      typeof snapshot.digest === 'string' && /^[a-f0-9]{64}$/u.test(snapshot.digest) &&
      typeof snapshot.ref === 'string' && snapshot.ref.startsWith(`${root.workspaceRef}/`), 'rehearsal-step-plan');
    return {
      schemaVersion: 1, protocol: applicationRehearsalProtocol, rootDigest: canonicalSha256(root), kind, plan,
      reviewed: applicationRehearsalPrivateReview(data.reviewed, config.privateExecution.custody.workspaceId),
      snapshot: { ref: snapshot.ref, purpose: 'inspection', scope: rehearsalText(snapshot.scope), digest: snapshot.digest },
      recordedAt: rehearsalText(data.recordedAt, 32)
    };
  }

  async write(root: ApplicationRehearsalRoot, step: ApplicationRehearsalRetainedStep, authority: ApplicationPrivateAuthority): Promise<void> {
    await authority.assertCurrent();
    must(step.rootDigest === canonicalSha256(root), 'rehearsal-step-binding');
    await this.#store.write(this.key(root.sequence, step.kind), step);
    await authority.assertCurrent();
  }

  async close(root: ApplicationRehearsalRoot, receipt: CompletedApplicationRehearsalReceipt, authority: ApplicationPrivateAuthority): Promise<void> {
    must(completedReceipts.get(receipt) === canonicalSha256(receipt) && receipt.rehearsalId === root.rehearsalId,
      'rehearsal-concrete-receipt-required');
    await authority.assertCurrent();
    await this.#store.write(this.key(root.sequence, 'verified'), {
      schemaVersion: 1, protocol: applicationRehearsalProtocol, rootDigest: canonicalSha256(root), receipt,
      verifiedAt: (this.input.clock?.() ?? this.input.now).toISOString()
    });
    await authority.assertCurrent();
  }

  async readCompletion(root: ApplicationRehearsalRoot): Promise<{ receipt: Record<string, unknown>; verifiedAt: string }> {
    const record = await this.#store.read(this.key(root.sequence, 'verified'));
    must(record && record.projectRoot === root.projectRoot, 'rehearsal-private-completion-required');
    const value = applicationPrivateObject(record.value, ['schemaVersion', 'protocol', 'rootDigest', 'receipt', 'verifiedAt']);
    must(value.schemaVersion === 1 && value.protocol === applicationRehearsalProtocol &&
      value.rootDigest === canonicalSha256(root) && isRecord(value.receipt) &&
      value.receipt.kind === 'completed-private-application-rehearsal.v1' &&
      value.receipt.rehearsalId === root.rehearsalId && value.receipt.originalConfigurationRestored === true &&
      value.receipt.originalStateOwnershipRestored === true && value.receipt.atomicAcrossProviders === false,
    'rehearsal-private-completion-binding');
    return { receipt: value.receipt, verifiedAt: rehearsalText(value.verifiedAt, 32) };
  }
}

export async function verifyApplicationRehearsalOriginalApproval(
  input: PhasePlanningInput, original: SavedTransitionPlan, admittedAt: string
): Promise<void> {
  const plan = validateSavedTransitionPlan(original);
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === plan.phaseId);
  must(phase && plan.approval.envelopeHash, 'rehearsal-original-approval');
  assertPlanOperationsAllowed(plan, phase);
  const record = await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-approval', azurePorts(input).storage)
    .read(plan.approval.envelopeHash);
  must(record && isRecord(record.value) && record.value.kind === 'liftoff-governance-approval', 'rehearsal-issued-original-required');
  const envelope = validateApprovalEnvelope(record.value.envelope), authorityDigest = savedPlanAuthorityDigest(plan, phase);
  const at = Date.parse(admittedAt);
  must(canonicalApprovalEnvelopeHash(envelope) === plan.approval.envelopeHash && envelope.id === plan.approval.envelopeId &&
    envelope.planDigest === authorityDigest && plan.planDigest === planDigestFor({
      phase, transitionDigest: plan.transitionDigest, operations: plan.operations, approvalPlanDigest: authorityDigest
    }) && Number.isFinite(at) && at >= Date.parse(plan.createdAt) && at < Date.parse(plan.expiresAt), 'rehearsal-original-plan-approval');
  const approval = evaluateApprovalForTransitionPlan(approvalRequestForSavedPlan(plan, phase, input.inspection.state), [envelope], { now: new Date(at) });
  must(!approval.approvalRequired && approval.envelopeHash === plan.approval.envelopeHash, 'rehearsal-original-plan-approval');
  await assertGovernanceApprovalIssued(input.inspection.projectRoot, envelope, azurePorts(input).storage);
}

/** Read by exact original digest, not readPhaseReviews' current-phase pointer or a caller's payload. */
export async function readApplicationRehearsalPhaseReview(
  input: PhasePlanningInput, reference: ApplicationRehearsalReviewReference, original: SavedTransitionPlan
): Promise<PhaseReviewRequest> {
  must(original.phaseId === 'production-rehearsed' && original.planDigest === reference.sourcePlanDigest, 'rehearsal-original-review-plan');
  const key = canonicalSha256({ kind: 'liftoff-phase-review', phaseId: original.phaseId, sourcePlanDigest: reference.sourcePlanDigest });
  const record = await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', azurePorts(input).storage).read(key);
  must(record, 'rehearsal-private-phase-review-required');
  const data = applicationPrivateObject(record.value, ['schemaVersion', 'kind', 'projectRoot', 'repositoryId', 'identity',
    'sourcePlanDigest', 'sourcePlanContentDigest', 'recordedAt', 'review', 'completedOperationDigests', 'operation']);
  must(data.schemaVersion === 1 && data.kind === 'liftoff-phase-review' && data.projectRoot === record.projectRoot &&
    data.repositoryId === input.inspection.state.repository.id &&
    canonicalSha256(data.identity) === canonicalSha256(input.inspection.state.identity) &&
    data.sourcePlanDigest === original.planDigest && data.sourcePlanContentDigest === canonicalSha256(original) &&
    data.operation === null && Array.isArray(data.completedOperationDigests) &&
    canonicalSha256([...data.completedOperationDigests].sort()) ===
      canonicalSha256(original.operations.filter((entry) => entry.remote).map((entry) => canonicalSha256(entry)).sort()),
  'rehearsal-original-review-binding');
  const review = validatePhaseReview(data.review, original);
  must(review.kind === 'application-private-plan' && canonicalSha256(review) === reference.reviewDigest &&
    isRecord(review.payload) && review.payload.protocol === applicationRehearsalProtocol, 'rehearsal-original-review-binding');
  await verifyApplicationRehearsalOriginalApproval(input, original, rehearsalText(data.recordedAt, 32));
  return review;
}

export async function openApplicationRehearsalPrivateStage(
  input: PhaseAdapterExecutionInput, originalPlan: SavedTransitionPlan, reviewed: ApplicationRehearsalPrivateReview,
  completed: boolean, authority: ApplicationPrivateAuthority, adapters: ApplicationPrivateAdapters = {}
) {
  const plan = validateSavedTransitionPlan(originalPlan);
  must(plan.phaseId === 'production-rehearsed' && plan.configuration, 'rehearsal-original-native-plan');
  const original: PhasePlanningInput = { ...input, inspection: { ...input.inspection, activationInputs: plan.configuration } };
  applicationRehearsalInputs(original);
  // No type/phase coercion: until the owner admits the production scopes this fails closed.
  const config = applicationPrivateInputs(original);
  const source = await inspectApplicationPrivateSource(input.inspection.projectRoot, input.inspection.manifest, config);
  const context = applicationPrivateContext(original, config);
  const runtime = await createApplicationPrivateRuntime(input, applicationPrivateIntent(config), source, context, authority, adapters);
  const store = new ApplicationPrivateCheckpointStore({ authority, workspace: runtime.storage.workspace, context, configuration: config });
  let journal;
  if (completed) {
    must(config.mode !== 'prepare' && config.reviewed, 'rehearsal-completed-original-required');
    journal = await store.readCompleted(reviewed, config.reviewed.phaseId);
  } else {
    const active = await store.find();
    must(active.slot && !active.closed && active.slot.transactionId === reviewed.transactionId &&
      active.slot.journalRef === reviewed.journalRef, 'rehearsal-original-open-plan');
    journal = await store.open(active.slot);
  }
  await verifyApplicationPrivateOriginalAuthority(input, journal);
  const saved = await readApplicationPrivateSavedPlan(runtime, journal, config);
  must(canonicalSha256(saved.review) === canonicalSha256(reviewed) &&
    ((completed ? journal.value.applyGovernancePlan?.planDigest === plan.planDigest :
      journal.value.originalGovernancePlan.planDigest === plan.planDigest) ||
      journal.value.events.some((event) => event.kind === 'recovery-authorized' &&
        canonicalSha256(event.details.governancePlan ?? null) === canonicalSha256(plan))), 'rehearsal-exact-native-result-plan');
  if (completed) {
    await validateApplicationPrivateEffectIntents(runtime, journal, saved);
    must(journal.value.final === 'completed' && journal.value.processSettled && journal.value.nativeStarted &&
      journal.value.events.filter((event) => event.kind === 'native-started').length === 1 &&
      journal.value.events.some((event) => event.kind === 'state-readback' &&
        event.details.kind === 'independent-private-resource-refresh' && event.details.result === 'no-change') &&
      journal.value.publication === 'verified' && journal.value.candidate, 'rehearsal-concrete-closed-native-result');
  } else must(!journal.value.nativeStarted && journal.value.final === null, 'rehearsal-preparation-not-apply');
  const buffers: Uint8Array[] = [];
  try {
    const backup = await readApplicationPrivateArtifact(runtime, saved.original, 'backup'); buffers.push(backup);
    const shown = await readApplicationPrivateArtifact(runtime, saved.shownPlan, 'inspection'); buffers.push(shown);
    const exact = await readApplicationPrivateArtifact(runtime, saved.savedPlan, 'plan'); buffers.push(exact);
    const variables = await readApplicationPrivateArtifact(runtime, saved.variables, 'inspection'); buffers.push(variables);
    applicationPrivateJson(variables);
    const admitted = admitApplicationPrivatePlan(shown, backup, saved.originalSnapshot, saved.source, saved.intent);
    const original = applicationPrivateState(backup, saved.originalSnapshot);
    const inventory = applicationPrivateJson(shown).resource_changes;
    must(Array.isArray(inventory) && [...original.resources].every(([address, resource]) =>
      resource.mode !== 'managed' || inventory.some((entry) => isRecord(entry) && entry.address === address)) &&
      canonicalSha256(admitted.changes) === canonicalSha256(saved.review.changes), 'rehearsal-full-owned-native-inventory');
    if (completed) {
      const candidate = await readApplicationPrivateArtifact(runtime, journal.value.candidate!, 'candidate'); buffers.push(candidate);
      must(inspectApplicationPrivateCandidate(candidate, backup, saved.originalSnapshot, admitted).complete, 'rehearsal-incomplete-native-candidate');
    }
    return { runtime, config, source, saved, journal, admitted,
      result: completed ? completedApplicationPrivateResult(journal, config, saved.review) : null };
  } finally { for (const bytes of buffers) bytes.fill(0); }
}

export type ApplicationRehearsalPrivateStage = Awaited<ReturnType<typeof openApplicationRehearsalPrivateStage>>;

export interface ApplicationRehearsalInventory {
  schemaVersion: 1;
  protocol: typeof applicationRehearsalProtocol;
  resourceId: string;
  imageRef: string;
  revisionName: string;
  originalRevisionName: string;
  traffic: readonly { revisionName: string; weight: number; label: string | null }[];
  workloadIdentity: ApplicationRehearsalInputs['rehearsal']['baseline']['workloadIdentity'];
  configuration: Record<string, unknown>;
  revisions: readonly { name: string; template: Record<string, unknown>; active: boolean }[];
  originalRevisionTemplate: Record<string, unknown>;
  readbacks: readonly { resourceId: string; requestId: string }[];
  observedAt: string;
}

function configurationOf(resource: Record<string, unknown>): Record<string, unknown> {
  const properties = structuredClone(rehearsalRecord(resource.properties));
  for (const field of ['provisioningState', 'runningStatus', 'latestRevisionName', 'latestReadyRevisionName',
    'latestRevisionFqdn', 'eventStreamEndpoint', 'outboundIpAddresses']) delete properties[field];
  const configuration = rehearsalRecord(properties.configuration);
  const ingress = rehearsalRecord(configuration.ingress);
  must(Array.isArray(ingress.traffic), 'rehearsal-traffic');
  for (const raw of ingress.traffic) {
    const traffic = rehearsalRecord(raw);
    if (traffic.latestRevision === true) delete traffic.revisionName;
  }
  return {
    id: resource.id, type: resource.type, name: resource.name, location: resource.location,
    tags: resource.tags === undefined ? null : rehearsalRecord(resource.tags), identity: rehearsalRecord(resource.identity), properties
  };
}

function assertObservedOwnershipTag(resource: Record<string, unknown>, ownerId: string, required = false): void {
  const tags = resource.tags === undefined ? undefined : rehearsalRecord(resource.tags);
  const owner = tags?.['liftoff-repository-id'];
  must(required ? owner === ownerId : owner === undefined || owner === ownerId, 'rehearsal-resource-ownership');
}

/** Actual separate ARM resource, revision collection, immutable original revision and identity GETs. */
export async function readApplicationRehearsalInventory(
  input: PhaseAdapterExecutionInput, config: ApplicationRehearsalInputs, operation: TransitionOperation,
  expectedImage: string, authority: ApplicationPrivateAuthority
): Promise<ApplicationRehearsalInventory> {
  const target = config.disposableTarget.target, baseline = config.rehearsal.baseline;
  const transport = defaultAzureArmTransport(input), readbacks: { resourceId: string; requestId: string }[] = [];
  const get = async (resourceId: string, apiVersion = '2023-05-01') => {
    must(operation.actionId === 'azure.application-rehearsal.receipt' &&
      operation.effects?.some((effect) => effect.mutationClass === 'azure-read' && effect.destination.identity === resourceId),
    'rehearsal-undeclared-readback');
    await authority.assertCurrent();
    const response = await transport.request({ method: 'GET', resourceId, apiVersion }, config.privateExecution.binding);
    must(response.status === 200, 'rehearsal-resource-readback');
    const requestId = applicationUuid(response.requestId, 'Actual independent rehearsal GET request');
    must(!readbacks.some((entry) => entry.requestId === requestId), 'rehearsal-independent-read-identity');
    readbacks.push({ resourceId, requestId });
    return rehearsalRecord(response.data);
  };
  const app = await get(target.resourceId);
  const collection = await get(`${target.resourceId}/revisions`);
  const original = await get(`${target.resourceId}/revisions/${baseline.revisionName}`);
  const identity = await get(baseline.workloadIdentity.resourceId, '2023-01-31');
  const registry = await get(config.rehearsal.candidate.registryResourceId, '2023-07-01');
  const ownerId = config.privateExecution.backend.backend.ownerId;
  assertObservedOwnershipTag(app, ownerId,
    config.privateExecution.targets[0]!.expected['tags.liftoff-repository-id'] !== undefined);
  assertObservedOwnershipTag(identity, ownerId);
  assertObservedOwnershipTag(registry, ownerId);
  const properties = rehearsalRecord(app.properties), configuration = rehearsalRecord(properties.configuration);
  const template = rehearsalRecord(properties.template), ingress = rehearsalRecord(configuration.ingress);
  must(app.id === target.resourceId && app.name === target.appName && app.type === 'Microsoft.App/containerApps' &&
    properties.provisioningState === 'Succeeded' && properties.runningStatus === 'Running' &&
    typeof properties.latestRevisionName === 'string' && properties.latestRevisionName === properties.latestReadyRevisionName &&
    configuration.activeRevisionsMode === 'Single' && Array.isArray(template.containers) && template.containers.length === 1 &&
    rehearsalRecord(template.containers[0]).image === expectedImage, 'rehearsal-resource-configuration');
  const assigned = rehearsalRecord(rehearsalRecord(app.identity).userAssignedIdentities);
  const identityProperties = rehearsalRecord(identity.properties);
  must(rehearsalRecord(app.identity).type === 'UserAssigned' && Object.keys(assigned).join(',') === baseline.workloadIdentity.resourceId &&
    identity.id === baseline.workloadIdentity.resourceId && identity.type === 'Microsoft.ManagedIdentity/userAssignedIdentities' &&
    identityProperties.principalId === baseline.workloadIdentity.principalId &&
    identityProperties.clientId === baseline.workloadIdentity.clientId && identityProperties.tenantId === baseline.workloadIdentity.tenantId,
  'rehearsal-workload-principal-readback');
  const image = parseApplicationImageReference(expectedImage), registryProperties = rehearsalRecord(registry.properties);
  must(registry.id === config.rehearsal.candidate.registryResourceId && registry.type === 'Microsoft.ContainerRegistry/registries' &&
    registryProperties.loginServer === image.loginServer && registryProperties.provisioningState === 'Succeeded' &&
    registryProperties.adminUserEnabled === false,
  'rehearsal-registry-ownership');
  must(collection.nextLink === undefined && Array.isArray(collection.value) && collection.value.length > 0 &&
    collection.value.length <= 100, 'rehearsal-revision-inventory-bound');
  const revisions = collection.value.map((value) => {
    const revision = rehearsalRecord(value), state = rehearsalRecord(revision.properties);
    const name = rehearsalText(revision.name, 150);
    must(revision.id === `${target.resourceId}/revisions/${name}` && revision.type === 'Microsoft.App/containerApps/revisions' &&
      typeof state.active === 'boolean', 'rehearsal-revision-identity');
    return { name, template: rehearsalRecord(state.template), active: state.active, state };
  });
  must(new Set(revisions.map((entry) => entry.name)).size === revisions.length, 'rehearsal-revision-alias');
  const latest = revisions.find((entry) => entry.name === properties.latestRevisionName);
  const old = revisions.find((entry) => entry.name === baseline.revisionName);
  const originalProperties = rehearsalRecord(original.properties);
  must(latest && old && latest.active && revisions.filter((entry) => entry.active).length === 1 &&
    latest.state.provisioningState === 'Provisioned' && latest.state.healthState === 'Healthy' &&
    latest.state.runningState === 'Running' && canonicalSha256(latest.template) === canonicalSha256(template) &&
    original.id === `${target.resourceId}/revisions/${baseline.revisionName}` && original.name === baseline.revisionName &&
    original.type === 'Microsoft.App/containerApps/revisions' &&
    canonicalSha256(originalProperties.template) === canonicalSha256(old.template) &&
    Array.isArray(old.template.containers) && old.template.containers.length === 1 &&
    rehearsalRecord(old.template.containers[0]).image === baseline.artifact.imageRef, 'rehearsal-independent-revision-readback');
  must(Array.isArray(ingress.traffic) && ingress.traffic.length === 1, 'rehearsal-traffic');
  const route = rehearsalRecord(ingress.traffic[0]);
  must(route.latestRevision === true && route.weight === 100 &&
    (route.revisionName === undefined || route.revisionName === latest.name) &&
    (route.label === undefined || typeof route.label === 'string'), 'rehearsal-traffic');
  const confirmed = await get(target.resourceId), confirmedProperties = rehearsalRecord(confirmed.properties);
  must(canonicalSha256(configurationOf(confirmed)) === canonicalSha256(configurationOf(app)) &&
    confirmedProperties.latestRevisionName === properties.latestRevisionName &&
    confirmedProperties.latestReadyRevisionName === properties.latestReadyRevisionName &&
    confirmedProperties.provisioningState === 'Succeeded' && confirmedProperties.runningStatus === 'Running',
  'rehearsal-resource-readback-race');
  await authority.assertCurrent();
  return {
    schemaVersion: 1, protocol: applicationRehearsalProtocol, resourceId: target.resourceId, imageRef: expectedImage,
    revisionName: latest.name, originalRevisionName: baseline.revisionName,
    traffic: [{ revisionName: latest.name, weight: 100, label: typeof route.label === 'string' ? route.label : null }],
    workloadIdentity: structuredClone(baseline.workloadIdentity), configuration: configurationOf(app),
    revisions: revisions.map(({ state: _state, ...revision }) => revision), originalRevisionTemplate: old.template,
    readbacks, observedAt: (input.clock?.() ?? input.now).toISOString()
  };
}

export function assertApplicationRehearsalInventoryRestored(
  before: ApplicationRehearsalInventory, after: ApplicationRehearsalInventory
): void {
  must(before.resourceId === after.resourceId && before.imageRef === after.imageRef &&
    before.originalRevisionName === after.originalRevisionName &&
    canonicalSha256(before.workloadIdentity) === canonicalSha256(after.workloadIdentity) &&
    canonicalSha256(before.configuration) === canonicalSha256(after.configuration) &&
    canonicalSha256(before.originalRevisionTemplate) === canonicalSha256(after.originalRevisionTemplate) &&
    canonicalSha256(before.traffic.map(({ revisionName: _name, ...route }) => route)) ===
      canonicalSha256(after.traffic.map(({ revisionName: _name, ...route }) => route)) &&
    before.readbacks.every((read) => !after.readbacks.some((fresh) => fresh.requestId === read.requestId)),
  'rehearsal-original-configuration-not-restored');
  for (const original of before.revisions) {
    const retained = after.revisions.find((entry) => entry.name === original.name);
    must(retained && canonicalSha256(retained.template) === canonicalSha256(original.template), 'rehearsal-original-revision-changed');
  }
}

function restoredState(value: Uint8Array, metadata: StateBackendMetadata, address: string) {
  const parsed = applicationPrivateState(value, metadata), root = applicationPrivateJson(value);
  const selected = parsed.resources.get(address);
  must(selected?.type === 'azurerm_container_app' && selected.mode === 'managed', 'rehearsal-original-state-ownership');
  const resources = [...parsed.resources].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, resource]) => {
    const raw = structuredClone(rehearsalRecord(resource.raw));
    if (key === address) {
      must(Array.isArray(raw.instances) && raw.instances.length === 1, 'rehearsal-state-instance');
      const attributes = rehearsalRecord(rehearsalRecord(raw.instances[0]).attributes);
      // New provider-assigned revision identities are not desired configuration.
      delete attributes.latest_revision_name;
      delete attributes.latest_revision_fqdn;
    }
    return raw;
  });
  const { serial: _serial, resources: _resources, ...rest } = root;
  return { snapshot: parsed.snapshot, configuration: { ...rest, resources } };
}

/** Compare the entire retained ownership/configuration, including secrets, env, outputs and foreign resources privately. */
export function assertApplicationRehearsalStateRestored(
  before: Uint8Array, after: Uint8Array, metadata: StateBackendMetadata, address: string
): void {
  const original = restoredState(before, metadata, address), restored = restoredState(after, metadata, address);
  must(original.snapshot.lineage === restored.snapshot.lineage && restored.snapshot.serial! > original.snapshot.serial! &&
    canonicalSha256(original.configuration) === canonicalSha256(restored.configuration), 'rehearsal-original-native-state-not-restored');
}

export function assertApplicationRehearsalRollbackPlan(
  original: ApplicationRehearsalPrivateStage, rollback: ApplicationRehearsalPrivateStage, originalBytes: Uint8Array
): void {
  const old = applicationPrivateState(originalBytes, original.saved.originalSnapshot);
  must(original.source.digest === rollback.source.digest &&
    canonicalSha256(original.saved.intent.binding) === canonicalSha256(rollback.saved.intent.binding) &&
    canonicalSha256(original.saved.intent.backend) === canonicalSha256(rollback.saved.intent.backend) &&
    canonicalSha256(original.saved.intent.writer) === canonicalSha256(rollback.saved.intent.writer), 'rehearsal-rollback-source-owner');
  const address = original.saved.intent.targets[0]!.address;
  const planned = rollback.admitted.resources.get(address), baseline = old.resources.get(address);
  must(planned && baseline && planned.action === 'update', 'rehearsal-separate-rollback-plan');
  const projection = (raw: Record<string, unknown>) => {
    const value = structuredClone(raw);
    delete value.latest_revision_name;
    delete value.latest_revision_fqdn;
    return value;
  };
  must(canonicalSha256(projection(planned.after)) === canonicalSha256(projection(baseline.values)),
    'rehearsal-rollback-does-not-restore-original');
  const changes = rollback.admitted.value.output_changes;
  if (changes !== undefined) {
    const outputs = rehearsalRecord(applicationPrivateJson(originalBytes).outputs);
    for (const [key, value] of Object.entries(rehearsalRecord(changes))) {
      const change = rehearsalRecord(value);
      must(change.after_unknown === false && Object.hasOwn(outputs, key) &&
        canonicalSha256(change.after) === canonicalSha256(rehearsalRecord(outputs[key]).value), 'rehearsal-rollback-output-change');
    }
  }
}

export interface ApplicationRehearsalSnapshot {
  schemaVersion: 1;
  protocol: typeof applicationRehearsalProtocol;
  sourcePlanDigest: string;
  transactionId: string;
  state: StateArtifactDescriptor;
  nativeRefresh: { toolIdentity: string; result: 'no-change' };
  inventory: ApplicationRehearsalInventory;
}

/** A retained refresh must still consume the ORIGINAL protected variables/plan, not newly written native files. */
export async function assertApplicationRehearsalNativeReadbackInputs(
  saved: Pick<ApplicationPrivateSavedPlan, 'directory' | 'source' | 'savedPlan' | 'variables'>
): Promise<void> {
  const root = applicationPrivateNativeRoot(saved.directory.path, saved.source);
  for (const [filename, descriptor] of [
    [applicationPrivateNativeFiles.plan, saved.savedPlan], [applicationPrivateNativeFiles.variables, saved.variables]
  ] as const) {
    const bytes = await readPrivateNativeFile(path.join(root, filename), 64 * 1024 * 1024);
    try { must(stateDigest(bytes) === descriptor.digest, 'rehearsal-retained-native-input-changed'); }
    finally { bytes.fill(0); }
  }
}

export async function captureApplicationRehearsalSnapshot(
  input: PhaseAdapterExecutionInput, config: ApplicationRehearsalInputs, stage: ApplicationRehearsalPrivateStage,
  operation: TransitionOperation, authority: ApplicationPrivateAuthority, completed: boolean
): Promise<StateArtifactDescriptor> {
  const descriptor = completed ? stage.journal.value.candidate : stage.saved.original;
  must(descriptor, 'rehearsal-native-state-required');
  const bytes = await readApplicationPrivateArtifact(stage.runtime, descriptor, completed ? 'candidate' : 'backup');
  const native = new ApplicationPrivateOpenTofu({
    runner: stage.runtime.runner, intent: stage.saved.intent, context: stage.runtime.context, source: stage.saved.source,
    assertDirectory: (directory) => stage.runtime.assertDirectory(directory), authorize: () => authority.assertCurrent()
  });
  try {
    await authority.assertCurrent();
    await stage.runtime.assertArtifact();
    const before = await stage.runtime.backend.metadata(stage.runtime.context);
    const remote = await stage.runtime.backend.readPrivate(before, stage.runtime.context);
    try {
      must(before.exists && before.etag && before.version && stateDigest(remote) === descriptor.digest &&
        (!completed || before.operationId === stage.journal.value.publicationCorrelationId), 'rehearsal-current-private-state');
    } finally { remote.fill(0); }
    const expiresAt = config.privateExecution.mode === 'recover' ? config.privateExecution.recoveryWindow.expiresAt : config.privateExecution.expiresAt;
    const envelope = input.inspection.approvals.find((entry) => entry.id === input.plan.approval.envelopeId);
    must(envelope, 'rehearsal-readback-approval');
    const deadline = Math.min(Date.parse(expiresAt), Date.parse(input.plan.expiresAt), Date.parse(envelope.expiresAt));
    const nativeInputs = async () => {
      await stage.runtime.assertDirectory(stage.saved.directory);
      await assertApplicationRehearsalNativeReadbackInputs(stage.saved);
      must(canonicalSha256(await inspectApplicationPrivateInstallation(
        applicationPrivateNativeRoot(stage.saved.directory.path, stage.saved.source), stage.saved.directory.path, stage.saved.intent
      )) === canonicalSha256(stage.saved.installedFiles), 'rehearsal-retained-provider-installation-changed');
    };
    await nativeInputs();
    const remaining = Math.min(config.privateExecution.maxCommandMs, deadline - (input.clock?.() ?? input.now).getTime());
    must(remaining >= 1, 'rehearsal-readback-window');
    await native.verifyReadback(stage.saved.directory, bytes, AbortSignal.timeout(Math.ceil(remaining)));
    await nativeInputs();
    const state = applicationPrivateState(bytes, stage.saved.originalSnapshot);
    const appState = state.resources.get(config.privateExecution.targets[0]!.address)?.values;
    must(appState, 'rehearsal-owned-application-state');
    const imageRef = applicationPrivateValue(appState, 'template.0.container.0.image');
    must(typeof imageRef === 'string', 'rehearsal-state-image');
    const expected = completed ? config.privateExecution.artifact.imageRef : config.rehearsal.stage === 'rollout'
      ? config.rehearsal.baseline.artifact.imageRef : config.rehearsal.candidate.imageRef;
    must(imageRef === expected, 'rehearsal-state-image');
    const inventory = await readApplicationRehearsalInventory(input, config, operation, expected, authority);
    must(appState.latest_revision_name === inventory.revisionName &&
      (completed || config.rehearsal.stage !== 'rollout' || inventory.revisionName === config.rehearsal.baseline.revisionName),
    'rehearsal-state-revision');
    const fresh = await stage.runtime.backend.metadata(stage.runtime.context);
    must(stateMetadataMatches(before, fresh), 'rehearsal-state-readback-race');
    await verifyApplicationPrivateSource(input.inspection.projectRoot, stage.source);
    await authority.assertCurrent();
    const snapshot: ApplicationRehearsalSnapshot = {
      schemaVersion: 1, protocol: applicationRehearsalProtocol, sourcePlanDigest: input.plan.planDigest,
      transactionId: stage.saved.transactionId, state: descriptor,
      nativeRefresh: { toolIdentity: stage.saved.intent.custody.tools.tofu.sha256, result: 'no-change' }, inventory
    };
    const encoded = Buffer.from(canonicalJson(snapshot));
    try { return await stage.runtime.storage.workspace.put('inspection', protectedStateScope(stage.runtime.context), encoded); }
    finally { encoded.fill(0); }
  } finally { bytes.fill(0); await native.quiesce(); }
}

export async function readApplicationRehearsalSnapshot(
  stage: ApplicationRehearsalPrivateStage, step: ApplicationRehearsalRetainedStep, completed: boolean
): Promise<ApplicationRehearsalSnapshot> {
  const bytes = await readApplicationPrivateArtifact(stage.runtime, step.snapshot, 'inspection');
  try {
    const value = applicationPrivateJson(bytes);
    applicationPrivateObject(value, ['schemaVersion', 'protocol', 'sourcePlanDigest', 'transactionId', 'state', 'nativeRefresh', 'inventory']);
    const refresh = applicationPrivateObject(value.nativeRefresh, ['toolIdentity', 'result']);
    const state = completed ? stage.journal.value.candidate : stage.saved.original;
    must(state && value.schemaVersion === 1 && value.protocol === applicationRehearsalProtocol &&
      value.sourcePlanDigest === step.plan.planDigest && value.transactionId === stage.saved.transactionId &&
      canonicalSha256(value.state) === canonicalSha256(state) && refresh.result === 'no-change' &&
      refresh.toolIdentity === stage.saved.intent.custody.tools.tofu.sha256, 'rehearsal-private-snapshot-binding');
    const inventory = validateInventory(value.inventory);
    must(inventory.resourceId === stage.saved.intent.targets[0]!.resourceId &&
      Number.isFinite(Date.parse(inventory.observedAt)) && new Date(inventory.observedAt).toISOString() === inventory.observedAt &&
      Date.parse(inventory.observedAt) >= Date.parse(step.plan.createdAt) &&
      Date.parse(inventory.observedAt) < Date.parse(step.plan.expiresAt), 'rehearsal-private-inventory-binding');
    return {
      schemaVersion: 1, protocol: applicationRehearsalProtocol, sourcePlanDigest: step.plan.planDigest,
      transactionId: stage.saved.transactionId, state,
      nativeRefresh: { toolIdentity: refresh.toolIdentity, result: 'no-change' }, inventory
    };
  } finally { bytes.fill(0); }
}

function validateInventory(value: unknown): ApplicationRehearsalInventory {
  const data = applicationPrivateObject(value, ['schemaVersion', 'protocol', 'resourceId', 'imageRef', 'revisionName', 'originalRevisionName',
    'traffic', 'workloadIdentity', 'configuration', 'revisions', 'originalRevisionTemplate', 'readbacks', 'observedAt']);
  must(data.schemaVersion === 1 && data.protocol === applicationRehearsalProtocol &&
    Array.isArray(data.traffic) && data.traffic.length === 1 && Array.isArray(data.revisions) && data.revisions.length <= 100 &&
    Array.isArray(data.readbacks) && data.readbacks.length === 6, 'rehearsal-private-inventory');
  const identity = applicationPrivateObject(data.workloadIdentity, ['resourceId', 'principalId', 'clientId', 'tenantId']);
  return {
    schemaVersion: 1, protocol: applicationRehearsalProtocol, resourceId: rehearsalText(data.resourceId), imageRef: rehearsalText(data.imageRef),
    revisionName: rehearsalText(data.revisionName), originalRevisionName: rehearsalText(data.originalRevisionName),
    traffic: data.traffic.map((value) => {
      const route = applicationPrivateObject(value, ['revisionName', 'weight', 'label']);
      must(route.weight === 100 && (route.label === null || typeof route.label === 'string'), 'rehearsal-private-traffic');
      return { revisionName: rehearsalText(route.revisionName), weight: 100, label: route.label };
    }),
    workloadIdentity: {
      resourceId: rehearsalText(identity.resourceId), principalId: applicationUuid(identity.principalId, 'Retained workload principal'),
      clientId: applicationUuid(identity.clientId, 'Retained workload client'), tenantId: applicationUuid(identity.tenantId, 'Retained workload tenant')
    },
    configuration: rehearsalRecord(data.configuration), originalRevisionTemplate: rehearsalRecord(data.originalRevisionTemplate),
    revisions: data.revisions.map((value) => {
      const revision = applicationPrivateObject(value, ['name', 'template', 'active']);
      must(typeof revision.active === 'boolean', 'rehearsal-private-revision');
      return { name: rehearsalText(revision.name), template: rehearsalRecord(revision.template), active: revision.active };
    }),
    readbacks: data.readbacks.map((value) => {
      const read = applicationPrivateObject(value, ['resourceId', 'requestId']);
      return { resourceId: rehearsalText(read.resourceId), requestId: applicationUuid(read.requestId, 'Retained GET identity') };
    }), observedAt: rehearsalText(data.observedAt, 32)
  };
}

export interface ApplicationRehearsalBuildReadback {
  reference: ApplicationRehearsalArtifact;
  originalPlanDigest: string;
  source: { repositoryId: number; commitSha: string; treeSha: string; readerActorId: number };
  build: VerifiedApplicationBuild;
  artifact: { id: number; name: string; digest: string };
  observedAt: string;
}

/** Only original GitHub GET/artifact reads; never dispatch, create, retry or adopt a latest build. */
export async function readApplicationRehearsalBuild(
  input: PhaseAdapterExecutionInput, requested: ApplicationRehearsalArtifact, current: boolean,
  operation: TransitionOperation, authority: ApplicationPrivateAuthority
): Promise<ApplicationRehearsalBuildReadback> {
  const original = applicationRehearsalBuildContext({ ...input, now: input.clock?.() ?? input.now }, requested, current);
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'application-artifact-ready')!;
  const originalInput: PhaseAdapterExecutionInput = {
    ...input, phase, plan: original.plan, inspection: { ...input.inspection, activationInputs: original.plan.configuration }
  };
  const config = applicationArtifactInputs(originalInput);
  must(operation.actionId === 'github.application-rehearsal.source-receipt' && operation.mutationClass === 'github-read' &&
    operation.destination.repository === config.workflow.repository && config.workflow.sourceSha === requested.sourceSha &&
    config.registryResourceId === (requested.sourceRegistryResourceId ?? requested.registryResourceId), 'rehearsal-build-read-operation');
  const remote = clientFor(input), client = new GitHubActivationClient({
    async request(request) {
      must(request.method === 'GET' && (request.path === '/user' || request.path === `/repos/${config.workflow.repository}` ||
        request.path.startsWith(`/repos/${config.workflow.repository}/`)), 'rehearsal-build-read-only');
      await authority.assertCurrent();
      return remote.transport.request(request);
    }
  });
  const repository = await client.get(`/repos/${config.workflow.repository}`);
  const actor = await client.get('/user');
  const commit = await client.get(`/repos/${config.workflow.repository}/git/commits/${requested.sourceSha}`);
  const treeSha = rehearsalText(rehearsalRecord(commit.tree).sha, 40);
  must(repository.id === config.workflow.repositoryId && repository.full_name === config.workflow.repository &&
    actor.id === operation.inputs.actorId && commit.sha === requested.sourceSha &&
    /^[a-f0-9]{40}$/u.test(treeSha) && typeof actor.id === 'number' &&
    String(repository.id) === input.inspection.state.remoteBinding?.id, 'rehearsal-github-source-actor');
  const dispatches = original.plan.operations.filter((entry) => entry.actionId === 'github.artifact.build-dispatch');
  must(dispatches.length === 1, 'rehearsal-original-build-operation');
  const dispatch = dispatches[0]!;
  const checkpoints = await readWorkflowEffect(originalInput, dispatch, {
    repositoryId: config.workflow.repositoryId, ref: `${config.workflow.ref}:${config.workflow.workflowId}`, purpose: 'workflow-dispatch', step: 'dispatch'
  }, { workflow: config.workflow, dispatchInputs: config.dispatchInputs });
  must(checkpoints?.observed, 'rehearsal-private-build-checkpoint');
  await verifyApplicationRehearsalOriginalApproval(input, original.plan, checkpoints.prepared.preparedAt);
  const runId = positiveId(Number(checkpoints.observed.providerId));
  const resourceId = `/repos/${config.workflow.repository}/actions/runs/${runId}`;
  must(checkpoints.observed.resourceId === resourceId && original.payload.buildRunId === runId, 'rehearsal-original-build-run');
  const external = {
    provider: 'github' as const, actionId: dispatch.actionId, operationId: String(runId), resourceId,
    startedAt: checkpoints.prepared.preparedAt, observedAt: checkpoints.observed.recordedAt,
    status: 'completed' as const, planDigest: checkpoints.prepared.planDigest
  };
  const run = await readBoundWorkflowRun(client, config.workflow, external);
  const runCreated = Date.parse(rehearsalText(run.providerRun.created_at, 32));
  must(run.providerRun.display_title === `liftoff-${checkpoints.prepared.correlationId}` &&
    Number.isFinite(runCreated) && runCreated >= Date.parse(checkpoints.prepared.preparedAt) &&
    runCreated <= Date.parse(checkpoints.prepared.preparedAt) + 300_000, 'rehearsal-build-original-correlation');
  const descriptor = applicationPrivateObject(original.payload.artifact, ['id', 'name', 'digest']);
  const artifact = await readBoundWorkflowArtifact({
    client, binding: config.workflow, operation: external, artifactId: positiveId(descriptor.id), name: rehearsalText(descriptor.name)
  });
  let build: VerifiedApplicationBuild;
  try {
    build = validateApplicationBuildReport(readApplicationBuildArchive(artifact.archive), config, {
      runId: run.runId, jobs: run.jobs, loginServer: parseApplicationImageReference(original.payload.imageRef).loginServer
    });
  } finally { artifact.archive.fill(0); }
  must(artifact.digest === descriptor.digest && build.imageRef === original.payload.imageRef &&
    build.digest === parseApplicationImageReference(requested.imageRef).digest && build.sourceSha === requested.sourceSha &&
    canonicalSha256(build) === canonicalSha256(original.payload.provenance), 'rehearsal-actual-build-provenance');
  await authority.assertCurrent();
  return {
    reference: requested, originalPlanDigest: original.plan.planDigest, build,
    source: { repositoryId: config.workflow.repositoryId, commitSha: requested.sourceSha, treeSha, readerActorId: actor.id },
    artifact: { id: artifact.artifactId, name: artifact.name, digest: artifact.digest },
    observedAt: (input.clock?.() ?? input.now).toISOString()
  };
}

export interface CompletedApplicationRehearsalReceipt {
  kind: 'completed-private-application-rehearsal.v1';
  protocol: typeof applicationRehearsalProtocol;
  rehearsalId: string;
  rolloutReview: ApplicationRehearsalReviewReference;
  rollbackReview: ApplicationRehearsalReviewReference;
  rollout: { transactionId: string; journalRef: string; planRef: string; sourcePlanDigest: string };
  rollback: { transactionId: string; journalRef: string; planRef: string; sourcePlanDigest: string };
  privateSnapshots: { original: string; promoted: string; restored: string; verification: string };
  original: ApplicationRehearsalPublicInventory;
  promoted: ApplicationRehearsalPublicInventory;
  restored: ApplicationRehearsalPublicInventory;
  candidateBuild: ApplicationRehearsalBuildReadback;
  baselineBuild: ApplicationRehearsalBuildReadback;
  originalConfigurationRestored: true;
  originalStateOwnershipRestored: true;
  atomicAcrossProviders: false;
  qualification: 'unqualified-source-component';
}

export type ApplicationRehearsalPublicInventory = Omit<ApplicationRehearsalInventory,
  'configuration' | 'revisions' | 'originalRevisionTemplate'>;

export function publicApplicationRehearsalInventory(value: ApplicationRehearsalInventory): ApplicationRehearsalPublicInventory {
  const { configuration: _configuration, revisions: _revisions, originalRevisionTemplate: _template, ...publicValue } = value;
  return publicValue;
}

export function applicationRehearsalStepReview(
  root: ApplicationRehearsalRoot, step: ApplicationRehearsalRetainedStep
): PhaseReviewRequest {
  const next = {
    'rollout-prepared': { stage: 'rollout', mode: 'apply' },
    'rollout-completed': { stage: 'rollback', mode: 'prepare' },
    'rollback-prepared': { stage: 'rollback', mode: 'apply' },
    'rollback-completed': { stage: 'verify', mode: 'recover', recovery: 'inspect' }
  }[step.kind];
  return {
    schemaVersion: 1, phaseId: 'production-rehearsed', kind: 'application-private-plan', sourcePlanDigest: step.plan.planDigest,
    payload: {
      protocol: applicationRehearsalProtocol, rehearsalId: root.rehearsalId, completedStep: step.kind, next,
      reviewed: step.reviewed, snapshotRef: step.snapshot.ref
    }
  };
}

export async function requireApplicationRehearsalStepReview(
  input: PhasePlanningInput, root: ApplicationRehearsalRoot, step: ApplicationRehearsalRetainedStep,
  reference: ApplicationRehearsalReviewReference
): Promise<void> {
  const review = await readApplicationRehearsalPhaseReview(input, reference, step.plan);
  must(canonicalSha256(review) === canonicalSha256(applicationRehearsalStepReview(root, step)), 'rehearsal-private-review-step');
}

/**
 * Reopens BOTH original closed native journals and ALL four private reviews.
 * Historical rollout bytes are not compared to today's rolled-back backend.
 * Only the rollback candidate is read against today's backend, then compared
 * privately with the immutable pre-rollout backup and original ARM inventory.
 */
export async function readCompletedApplicationRehearsalReceipt(
  input: PhaseAdapterExecutionInput, authority: ApplicationRehearsalPrivateAuthority,
  companions: readonly [TransitionOperation, TransitionOperation], adapters: ApplicationPrivateAdapters = {}
): Promise<CompletedApplicationRehearsalReceipt> {
  await assertIssuedApplicationRehearsalAuthority(authority);
  must(canonicalSha256(input.plan) === canonicalSha256(authority.input.plan) &&
    canonicalSha256(companions) === canonicalSha256(authority.additionalOperations), 'rehearsal-exact-receipt-authority');
  const config = applicationRehearsalInputs(input);
  must(config.rehearsal.stage === 'verify' && config.rehearsal.rolloutReview && config.rehearsal.rollbackReview,
    'rehearsal-final-read-only-stage');
  const store = new ApplicationRehearsalRecordStore(input, config), found = await store.find(), root = found.root;
  must(root && root.bindingDigest === applicationRehearsalBinding(config), 'rehearsal-original-root');
  const preparedRollout = await store.read(root, 'rollout-prepared'), rollout = await store.read(root, 'rollout-completed');
  const preparedRollback = await store.read(root, 'rollback-prepared'), rollback = await store.read(root, 'rollback-completed');
  must(preparedRollout && rollout && preparedRollback && rollback, 'rehearsal-both-concrete-stages-required');
  const rollbackConfiguration = applicationRehearsalInputs({
    ...input, inspection: { ...input.inspection, activationInputs: rollback.plan.configuration }
  });
  must(config.privateExecution.mode === 'recover' && config.privateExecution.reviewed &&
    canonicalSha256(config.privateExecution.reviewed) === canonicalSha256(rollback.reviewed) &&
    canonicalSha256(applicationRehearsalPrivateIntent(config.privateExecution)) ===
      canonicalSha256(applicationRehearsalPrivateIntent(rollbackConfiguration.privateExecution)), 'rehearsal-verify-original-private-intent');
  await requireApplicationRehearsalStepReview(input, root, rollout, config.rehearsal.rolloutReview);
  await requireApplicationRehearsalStepReview(input, root, rollback, config.rehearsal.rollbackReview);
  for (const [prepared, completed] of [[preparedRollout, rollout], [preparedRollback, rollback]] as const) {
    const original = applicationRehearsalInputs({
      ...input, inspection: { ...input.inspection, activationInputs: completed.plan.configuration }
    });
    const reference = completed.kind === 'rollout-completed' ? original.rehearsal.rolloutReview : original.rehearsal.rollbackReview;
    must(reference && canonicalSha256(prepared.reviewed) === canonicalSha256(completed.reviewed), 'rehearsal-separate-saved-plan-review');
    await requireApplicationRehearsalStepReview(input, root, prepared, reference);
  }
  must(rollout.plan.approval.envelopeHash !== rollback.plan.approval.envelopeHash &&
    preparedRollback.plan.approval.envelopeHash !== rollback.plan.approval.envelopeHash &&
    preparedRollout.plan.approval.envelopeHash !== rollout.plan.approval.envelopeHash &&
    rollout.reviewed.transactionId !== rollback.reviewed.transactionId &&
    rollout.reviewed.planRef !== rollback.reviewed.planRef, 'rehearsal-separate-rollout-rollback-authority');
  const promoted = await openApplicationRehearsalPrivateStage(input, rollout.plan, rollout.reviewed, true, authority, adapters);
  const restored = await openApplicationRehearsalPrivateStage(input, rollback.plan, rollback.reviewed, true, authority, adapters);
  must(promoted.saved.source.digest === root.sourceDigest && restored.saved.source.digest === root.sourceDigest &&
    restored.saved.original.digest === promoted.journal.value.candidate?.digest &&
    (config.privateExecution.candidateRef === null || config.privateExecution.candidateRef === restored.journal.value.candidate?.ref),
  'rehearsal-original-stage-state-chain');
  const before = await readApplicationRehearsalSnapshot(promoted, preparedRollout, false);
  const afterRollout = await readApplicationRehearsalSnapshot(promoted, rollout, true);
  const beforeRollback = await readApplicationRehearsalSnapshot(restored, preparedRollback, false);
  const afterRollback = await readApplicationRehearsalSnapshot(restored, rollback, true);
  const clocks = [before, afterRollout, beforeRollback, afterRollback].map((snapshot) => Date.parse(snapshot.inventory.observedAt));
  must(clocks.every((time, index) => index === 0 || time >= clocks[index - 1]!), 'rehearsal-original-stage-order');
  must(afterRollout.inventory.imageRef === config.rehearsal.candidate.imageRef &&
    afterRollout.inventory.revisionName !== before.inventory.revisionName &&
    canonicalSha256(beforeRollback.inventory.configuration) === canonicalSha256(afterRollout.inventory.configuration) &&
    beforeRollback.inventory.revisionName === afterRollout.inventory.revisionName &&
    before.inventory.imageRef === config.rehearsal.baseline.artifact.imageRef, 'rehearsal-actual-stage-chain');
  assertApplicationRehearsalInventoryRestored(before.inventory, afterRollback.inventory);
  await promoted.runtime.assertArtifact();
  const originalBytes = await readApplicationPrivateArtifact(promoted.runtime, promoted.saved.original, 'backup');
  const rollbackBytes = await readApplicationPrivateArtifact(restored.runtime, restored.journal.value.candidate!, 'candidate');
  try {
    assertApplicationRehearsalRollbackPlan(promoted, restored, originalBytes);
    assertApplicationRehearsalStateRestored(originalBytes, rollbackBytes, promoted.saved.originalSnapshot,
      promoted.saved.intent.targets[0]!.address);
  } finally { originalBytes.fill(0); rollbackBytes.fill(0); }
  const candidateBuild = await readApplicationRehearsalBuild(input, config.rehearsal.candidate, true, companions[0], authority);
  const baselineBuild = await readApplicationRehearsalBuild(input, config.rehearsal.baseline.artifact, false, companions[0], authority);
  const freshRef = await captureApplicationRehearsalSnapshot(input, config, restored, companions[1], authority, true);
  const fresh = await readApplicationRehearsalSnapshot(restored, { ...rollback, plan: input.plan, snapshot: freshRef }, true);
  assertApplicationRehearsalInventoryRestored(before.inventory, fresh.inventory);
  must(fresh.inventory.revisionName === afterRollback.inventory.revisionName &&
    canonicalSha256(fresh.inventory.configuration) === canonicalSha256(afterRollback.inventory.configuration),
  'rehearsal-restored-resource-drift');
  await authority.assertCurrent();
  const reference = (step: ApplicationRehearsalRetainedStep) => ({
    transactionId: step.reviewed.transactionId, journalRef: step.reviewed.journalRef, planRef: step.reviewed.planRef,
    sourcePlanDigest: step.plan.planDigest
  });
  const receipt: CompletedApplicationRehearsalReceipt = {
    kind: 'completed-private-application-rehearsal.v1', protocol: applicationRehearsalProtocol, rehearsalId: root.rehearsalId,
    rolloutReview: config.rehearsal.rolloutReview, rollbackReview: config.rehearsal.rollbackReview,
    rollout: reference(rollout), rollback: reference(rollback),
    privateSnapshots: {
      original: preparedRollout.snapshot.ref, promoted: rollout.snapshot.ref, restored: rollback.snapshot.ref, verification: freshRef.ref
    },
    original: publicApplicationRehearsalInventory(before.inventory), promoted: publicApplicationRehearsalInventory(afterRollout.inventory),
    restored: publicApplicationRehearsalInventory(fresh.inventory), candidateBuild, baselineBuild,
    originalConfigurationRestored: true, originalStateOwnershipRestored: true,
    atomicAcrossProviders: false, qualification: 'unqualified-source-component'
  };
  completedReceipts.set(receipt, canonicalSha256(receipt));
  return receipt;
}
