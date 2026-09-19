import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import {
  evidenceBodyDigest, evidenceHeaderDigest, validateEvidenceFreshness, type PhaseEvidenceSource
} from '../../domain/governance/activation/evidence.js';
import type { PhaseEvidenceRecord, PhaseId, SavedTransitionPlan } from '../../domain/governance/activation/types.js';
import { validateSavedTransitionPlan } from '../../domain/governance/activation/validators.js';
import { qualificationFailure, qualificationObject, qualificationText } from './qualification-authority.js';

export interface QualificationEvidenceReference {
  evidenceId: string;
  headerDigest: string;
  bodyDigest: string;
}

export function qualificationDigest(value: unknown, label: string): string {
  const digest = qualificationText(value, label);
  if (!/^[a-f0-9]{64}$/u.test(digest)) qualificationFailure('qualification-digest', `${label} must be an exact SHA-256 commitment.`);
  return digest;
}

export function qualificationEvidenceReference(value: unknown): QualificationEvidenceReference {
  const reference = qualificationObject(value, ['evidenceId', 'headerDigest', 'bodyDigest'], 'Original qualification reference');
  return {
    evidenceId: qualificationText(reference.evidenceId, 'Original evidence ID'),
    headerDigest: qualificationDigest(reference.headerDigest, 'Original header digest'),
    bodyDigest: qualificationDigest(reference.bodyDigest, 'Original body digest')
  };
}

export function requireQualificationEvidence(
  source: PhaseEvidenceSource, phaseId: PhaseId, reference: QualificationEvidenceReference, now: Date
): { record: PhaseEvidenceRecord; plan: SavedTransitionPlan } {
  const exact = qualificationEvidenceReference(reference);
  const candidates = source.evidence.filter((entry) => entry.evidenceId === exact.evidenceId);
  const record = candidates[0];
  const context = source.contexts[phaseId];
  if (!Number.isFinite(now.getTime()) || candidates.length !== 1 || !record || !context?.evidenceReferences?.length ||
    !context.reviewedPlans?.length || !context.remoteBindingDigest ||
    record.header.phaseId !== phaseId || record.header.scope !== 'activation' ||
    record.header.result !== 'verified' || record.header.producer !== 'liftoff-governance-transition-engine' ||
    evidenceHeaderDigest(record.header) !== exact.headerDigest ||
    record.header.bodyDigest !== exact.bodyDigest ||
    evidenceBodyDigest(record.payload, record.liveReadback) !== exact.bodyDigest) {
    qualificationFailure('qualification-evidence', 'Qualification requires one explicitly referenced original activation receipt with authoritative state/header/body and retained-plan bindings. No latest, first, repository-only or rehashed replacement receipt is adopted.');
  }
  const result = validateEvidenceFreshness(record, { ...context, now });
  if (!result.valid) {
    qualificationFailure('qualification-evidence', `The original ${phaseId} receipt is not current: ${result.issues.map((issue) => issue.message).join(' ')}`);
  }
  const payload = record.payload;
  if (!isRecord(payload)) qualificationFailure('qualification-evidence', 'The original environment evidence body is absent.');
  const plans = context.reviewedPlans.filter((plan) =>
    plan.planDigest === payload.planDigest && canonicalSha256(plan) === payload.savedPlanDigest);
  if (plans.length !== 1) {
    qualificationFailure('qualification-evidence', 'Exactly one original reviewed plan must match both saved-plan and operation digests.');
  }
  return { record, plan: validateSavedTransitionPlan(plans[0]) };
}
