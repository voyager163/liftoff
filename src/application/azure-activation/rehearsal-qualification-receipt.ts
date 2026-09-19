import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph } from '../../domain/governance/activation/graph.js';
import type { PhaseAdapterExecutionInput, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import type { GitHubActivationClient } from '../../adapters/github/activation-rest.js';
import {
  applicationRehearsalInputs, applicationRehearsalProtocol
} from './application-rehearsal-inputs.js';
import {
  ApplicationRehearsalRecordStore, applicationRehearsalStepReview, readApplicationRehearsalPhaseReview,
  verifyApplicationRehearsalOriginalApproval
} from './application-rehearsal-receipt.js';
import { requireQualificationEvidence, type QualificationEvidenceReference } from './qualification-evidence.js';
import { qualificationFailure, requireEnvironmentActivationScope } from './qualification-authority.js';
import { readVerifiedStagingQualification } from './staging-qualification-receipt.js';
import { sourceSha } from '../../governance-activation/github-config.js';
import { applicationImageDigest } from '../../adapters/azure/application-provisioning.js';

/** Enforcing readers consume sealed native results without gaining a new Azure/state execution capability. */
export async function readVerifiedRehearsalQualification(
  input: PhasePlanningInput, client: GitHubActivationClient, reference: QualificationEvidenceReference
) {
  requireEnvironmentActivationScope(input);
  const { record, plan } = requireQualificationEvidence(input.inspection, 'production-rehearsed', reference, input.now);
  const payload = record.payload;
  if (!isRecord(payload) || payload.kind !== 'production-rehearsed.v1' || payload.recipe !== applicationRehearsalProtocol ||
    !isRecord(payload.applicationRehearsal)) {
    qualificationFailure('rehearsal-original-producer', 'Only the concrete privately retained rollout and separately approved rollback can qualify rehearsal.');
  }
  const applicationSourceSha = sourceSha(payload.sourceSha);
  const artifactDigest = applicationImageDigest(payload.artifactDigest);
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'production-rehearsed')!;
  const original: PhaseAdapterExecutionInput = {
    ...input, phase, plan, adapters: input.adapters ?? {},
    inspection: { ...input.inspection, activationInputs: plan.configuration }
  };
  const config = applicationRehearsalInputs(original);
  if (config.rehearsal.stage !== 'verify') qualificationFailure('rehearsal-original-stage', 'Only the separately approved final read-only comparison can complete rehearsal.');
  const store = new ApplicationRehearsalRecordStore(original, config);
  const found = await store.find(), root = found.root;
  if (!root || !found.closed || root.rehearsalId !== payload.applicationRehearsal.rehearsalId) {
    qualificationFailure('rehearsal-private-completion', 'The exact original privately verified rehearsal reservation is absent; no latest or caller-authored result is adopted.');
  }
  const completion = await store.readCompletion(root);
  if (canonicalSha256(completion.receipt) !== canonicalSha256(payload.applicationRehearsal) ||
    Date.parse(completion.verifiedAt) > Date.parse(record.header.producedAt)) {
    qualificationFailure('rehearsal-private-completion', 'The public rehearsal body differs from the original sealed native completion.');
  }
  await verifyApplicationRehearsalOriginalApproval(input, plan, completion.verifiedAt);
  for (const kind of ['rollout-prepared', 'rollout-completed', 'rollback-prepared', 'rollback-completed'] as const) {
    const step = await store.read(root, kind);
    if (!step) qualificationFailure('rehearsal-original-step', 'All four original preparation and completion records are required.');
    const review = applicationRehearsalStepReview(root, step);
    await readApplicationRehearsalPhaseReview(input, {
      sourcePlanDigest: step.plan.planDigest, reviewDigest: canonicalSha256(review)
    }, step.plan);
    await verifyApplicationRehearsalOriginalApproval(input, step.plan, step.recordedAt);
  }
  const staging = await readVerifiedStagingQualification(input, client, config.rehearsal.staging);
  if (staging.sourceSha !== payload.sourceSha || staging.artifactDigest !== payload.artifactDigest) {
    qualificationFailure('rehearsal-qualified-source', 'The concrete staging and retained rollout/rollback results do not bind the same original source and artifact.');
  }
  return { kind: 'verified-rehearsal-qualification.v1' as const, reference,
    sourceSha: applicationSourceSha, artifactDigest,
    rehearsal: completion.receipt, staging, producedAt: record.header.producedAt };
}
