import { realpath } from 'node:fs/promises';
import {
  createScopedUserLocalRecordStore, type UpdatePreviewOptions
} from '../adapters/filesystem/update-previews.js';
import { canonicalJson, canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import type { PhaseId, SavedTransitionPlan, UserActivationState } from '../domain/governance/activation/types.js';
import { phaseIds } from '../domain/governance/activation/types.js';
import { validateSavedTransitionPlan } from '../domain/governance/activation/validators.js';
import { authorityOperations } from '../domain/governance/activation/approvals.js';
import { canonicalPhaseGraph } from '../domain/governance/activation/graph.js';
import { assertPlanOperationsAllowed, phaseById } from '../domain/governance/activation/operations.js';
import { currentProjectMutationLease } from '../adapters/filesystem/project-lock.js';
import { assertGovernanceApprovalIssued } from './authority-records.js';
import { detectCredentialLeaks } from './credentials.js';
import type { GovernanceTransitionInspection, PhaseAdapterOutcome, PhaseReviewRequest } from './transition-ports.js';

const reviewKinds: Readonly<Partial<Record<PhaseId, readonly PhaseReviewRequest['kind'][]>>> = {
  'application-prerequisites-ready': ['application-private-plan', 'application-prerequisites-rbac'],
  'application-foundation': ['application-private-plan'],
  'staging-qualified': ['application-private-plan'],
  'production-rehearsed': ['application-private-plan'],
  'credential-ready': ['credential-enrollment', 'credential-usage']
};

export interface PhaseReviewReference {
  sourcePlanDigest: string;
  reviewDigest: string;
}

function reviewKey(phaseId: PhaseId, sourcePlanDigest: string): string {
  return canonicalSha256({ kind: 'liftoff-phase-review', phaseId, sourcePlanDigest });
}

export function validatePhaseReview(value: unknown, plan: SavedTransitionPlan): PhaseReviewRequest {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'kind,payload,phaseId,schemaVersion,sourcePlanDigest' ||
    value.schemaVersion !== 1 || value.phaseId !== plan.phaseId || value.sourcePlanDigest !== plan.planDigest ||
    !reviewKinds[plan.phaseId]?.some((kind) => kind === value.kind) || !isRecord(value.payload)) {
    throw new Error('A completed stage review must bind its exact registered phase, original saved plan and public review payload.');
  }
  const text = canonicalJson(value);
  if (Buffer.byteLength(text) > 48 * 1024) throw new Error('A phase review exceeds its bounded public metadata contract.');
  if (detectCredentialLeaks([{ source: 'generated-artifact', label: 'phase review', text }]).status === 'compromised') {
    throw new Error('A phase review cannot contain credential values or private execution payloads.');
  }
  return {
    schemaVersion: 1, phaseId: plan.phaseId, sourcePlanDigest: plan.planDigest,
    kind: value.kind as PhaseReviewRequest['kind'], payload: structuredClone(value.payload)
  };
}

export async function storePhaseReview(
  inspection: GovernanceTransitionInspection, plan: SavedTransitionPlan,
  outcome: PhaseAdapterOutcome, now: Date, storage?: UpdatePreviewOptions
): Promise<PhaseReviewRequest> {
  validateSavedTransitionPlan(plan);
  assertPlanOperationsAllowed(plan, phaseById(canonicalPhaseGraph, plan.phaseId));
  const lease = await currentProjectMutationLease(inspection.projectRoot);
  if (!lease) throw new Error('A settled phase review requires the actual project mutation lease.');
  await lease.assertHeld();
  const review = validatePhaseReview(outcome.review, plan);
  if (outcome.status !== 'review-required' || outcome.resultState !== undefined ||
    outcome.operation && outcome.operation.status !== 'completed' ||
    outcome.stateOverride !== undefined || outcome.fileMutations?.length) {
    throw new Error('Only a settled stage without terminal phase claims, pending effects or unreviewed file changes can request another review.');
  }
  if ((outcome.completedOperations ?? []).some((operation) =>
    !plan.operations.some((planned) => canonicalSha256(planned) === canonicalSha256(operation)))) {
    throw new Error('A phase review cannot attribute an operation outside its exact original plan.');
  }
  const envelope = inspection.approvals.find((entry) => entry.id === plan.approval.envelopeId);
  if (!envelope) throw new Error('A phase review requires the original privately issued exact stage approval.');
  await assertGovernanceApprovalIssued(inspection.projectRoot, envelope, storage);
  const record = {
    schemaVersion: 1, kind: 'liftoff-phase-review',
    projectRoot: await realpath(inspection.projectRoot), repositoryId: inspection.state.repository.id,
    identity: inspection.state.identity, sourcePlanDigest: plan.planDigest, sourcePlanContentDigest: canonicalSha256(plan),
    recordedAt: now.toISOString(), review,
    completedOperationDigests: (outcome.completedOperations ?? []).map((operation) => canonicalSha256(operation)),
    operation: outcome.operation ?? null
  };
  if (detectCredentialLeaks([{ source: 'generated-artifact', label: 'phase review checkpoint', text: canonicalJson(record) }]).status === 'compromised') {
    throw new Error('A phase review checkpoint cannot retain credential-shaped operation metadata.');
  }
  await createScopedUserLocalRecordStore(inspection.projectRoot, 'governance-operation', storage).write(reviewKey(plan.phaseId, plan.planDigest), record);
  await lease.assertHeld();
  return review;
}

export async function readPhaseReviews(
  projectRoot: string, state: UserActivationState, plans: readonly SavedTransitionPlan[], storage?: UpdatePreviewOptions
): Promise<PhaseReviewRequest[]> {
  const reviews: PhaseReviewRequest[] = [];
  const store = createScopedUserLocalRecordStore(projectRoot, 'governance-operation', storage);
  for (const phaseId of phaseIds) {
    const phase = state.phases[phaseId];
    if (!reviewKinds[phaseId] || !phase.executionPlanDigest || !['pending', 'blocked', 'running'].includes(phase.state)) continue;
    const record = await store.read(reviewKey(phaseId, phase.executionPlanDigest));
    if (!record) continue;
    const value = record.value;
    if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'liftoff-phase-review' ||
      Object.keys(value).sort().join(',') !== 'completedOperationDigests,identity,kind,operation,projectRoot,recordedAt,repositoryId,review,schemaVersion,sourcePlanContentDigest,sourcePlanDigest' ||
      value.projectRoot !== record.projectRoot || value.repositoryId !== state.repository.id ||
      canonicalSha256(value.identity) !== canonicalSha256(state.identity) || value.sourcePlanDigest !== phase.executionPlanDigest ||
      typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt)) ||
      !Array.isArray(value.completedOperationDigests)) {
      throw new Error('The retained phase review has an invalid or changed project/identity binding.');
    }
    const source = plans.find((plan) => plan.planDigest === value.sourcePlanDigest && canonicalSha256(plan) === value.sourcePlanContentDigest);
    if (!source || source.phaseId !== phaseId ||
      value.completedOperationDigests.some((digest) => typeof digest !== 'string' ||
        !source.operations.some((operation) => canonicalSha256(operation) === digest))) {
      throw new Error('The retained phase review has no exact original saved plan or attributed operation inventory.');
    }
    reviews.push(validatePhaseReview(value.review, source));
  }
  return reviews;
}

export async function readRetainedPhaseReview(
  projectRoot: string, state: UserActivationState, original: SavedTransitionPlan,
  reference: PhaseReviewReference, storage?: UpdatePreviewOptions
): Promise<{ review: PhaseReviewRequest; recordedAt: string }> {
  validateSavedTransitionPlan(original);
  if (!isRecord(reference) || Object.keys(reference).sort().join(',') !== 'reviewDigest,sourcePlanDigest' ||
    reference.sourcePlanDigest !== original.planDigest || !/^[a-f0-9]{64}$/u.test(reference.reviewDigest)) {
    throw new Error('A retained phase review requires exact original plan and review commitments.');
  }
  const record = await createScopedUserLocalRecordStore(projectRoot, 'governance-operation', storage)
    .read(reviewKey(original.phaseId, original.planDigest));
  const value = record?.value;
  if (!record || !isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'liftoff-phase-review' ||
    Object.keys(value).sort().join(',') !== 'completedOperationDigests,identity,kind,operation,projectRoot,recordedAt,repositoryId,review,schemaVersion,sourcePlanContentDigest,sourcePlanDigest' ||
    value.projectRoot !== record.projectRoot || value.repositoryId !== state.repository.id ||
    canonicalSha256(value.identity) !== canonicalSha256(state.identity) ||
    value.sourcePlanDigest !== original.planDigest || value.sourcePlanContentDigest !== canonicalSha256(original) ||
    typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt)) ||
    Date.parse(value.recordedAt) < Date.parse(original.createdAt) || value.operation !== null ||
    !Array.isArray(value.completedOperationDigests) ||
    canonicalSha256([...value.completedOperationDigests].sort()) !==
      canonicalSha256(original.operations.filter((entry) => entry.remote).map((entry) => canonicalSha256(entry)).sort())) {
    throw new Error('The retained phase review lacks its immutable original identity, plan or complete settled operation inventory.');
  }
  const review = validatePhaseReview(value.review, original);
  if (canonicalSha256(review) !== reference.reviewDigest) throw new Error('The retained phase review differs from its exact original commitment.');
  return { review, recordedAt: value.recordedAt };
}

export function reviewMatchesPlan(
  review: PhaseReviewRequest, plan: SavedTransitionPlan, originals: readonly SavedTransitionPlan[]
): boolean {
  const source = originals.find((entry) => entry.planDigest === review.sourcePlanDigest && entry.phaseId === review.phaseId);
  return source !== undefined && plan.phaseId === review.phaseId && source.inputDigest === plan.inputDigest &&
    source.baselineDigest === plan.baselineDigest &&
    canonicalSha256(authorityOperations(source.operations)) === canonicalSha256(authorityOperations(plan.operations));
}
