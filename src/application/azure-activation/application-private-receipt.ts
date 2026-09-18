import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph } from '../../domain/governance/activation/graph.js';
import { stateDigest, stateMetadataMatches } from '../../domain/repair/stateful-invariants.js';
import type { PhaseAdapterExecutionInput, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import { validateSavedTransitionPlan } from '../../domain/governance/activation/validators.js';
import { currentProjectMutationLease } from '../../adapters/filesystem/project-lock.js';
import { azureStateUrl } from '../../adapters/state/azure-blob.js';
import { createApplicationPrivateRuntime, type ApplicationPrivateAdapters } from '../../adapters/azure/application-private-runtime.js';
import { assertAzurePhaseAuthority } from './authority.js';
import {
  applicationPrivateAssert as must, type ApplicationPrivateAuthority, type ApplicationPrivatePhase,
  type ApplicationPrivateResult
} from './application-private-contracts.js';
import {
  applicationPrivateContext, applicationPrivateInputs, applicationPrivateIntent, applicationPrivateReadResourceIds,
  assertApplicationPrivateArtifact
} from './application-private-inputs.js';
import { ApplicationPrivateCheckpointStore } from './application-private-checkpoints.js';
import {
  admitApplicationPrivatePlan, applicationPrivateResourceId, applicationPrivateState, inspectApplicationPrivateCandidate
} from './application-private-plan.js';
import { inspectApplicationPrivateSource, verifyApplicationPrivateSource } from './application-private-source.js';
import {
  completedApplicationPrivateResult, readApplicationPrivateArtifact, readApplicationPrivateSavedPlan,
  validateApplicationPrivateEffectIntents, verifyApplicationPrivateOriginalAuthority
} from './application-private-custody.js';
import { qualificationEvidenceReference, requireQualificationEvidence, type QualificationEvidenceReference } from './qualification-evidence.js';
import { readRetainedPhaseReview, type PhaseReviewReference } from '../../governance-activation/phase-reviews.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import { readApplicationPrivateArtifactRoles } from './application-private-artifacts.js';

export interface ApplicationPrivateReceiptReference {
  phaseId: ApplicationPrivatePhase;
  evidence: QualificationEvidenceReference;
}

export interface ApplicationPrivateStageReference {
  phaseId: 'staging-qualified';
  review: PhaseReviewReference;
}

function originalContext(input: PhasePlanningInput, requested: ApplicationPrivateReceiptReference) {
  must(isRecord(requested) && Object.keys(requested).sort().join(',') === 'evidence,phaseId', 'original-receipt-reference');
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === requested.phaseId);
  must(phase && ['application-prerequisites-ready', 'application-foundation', 'staging-qualified', 'production-rehearsed']
    .includes(phase.id), 'original-receipt-phase');
  const reference = qualificationEvidenceReference(requested.evidence);
  const { record, plan } = requireQualificationEvidence(input.inspection, requested.phaseId, reference, input.now);
  must(plan.configuration && isRecord(record.payload) && isRecord(record.payload.applicationPrivate), 'original-private-receipt');
  // Historical plan inputs are read data, never a substitute for the current reader's authority.
  const original: PhasePlanningInput = {
    ...input, phase, inspection: { ...input.inspection, activationInputs: plan.configuration }
  };
  const config = applicationPrivateInputs(original);
  must(config.mode !== 'prepare' && config.reviewed && !['prerequisites-core', 'foundation-dependencies'].includes(config.scope),
    'completed-private-stage-required');
  const context = applicationPrivateContext(original, config);
  return { reference, record, publicResult: record.payload.applicationPrivate, plan, config, context, original };
}

export async function applicationPrivateReceiptOperation(
  input: PhasePlanningInput, requested: ApplicationPrivateReceiptReference
): Promise<TransitionOperation> {
  const original = originalContext(input, requested);
  const source = await inspectApplicationPrivateSource(input.inspection.projectRoot, input.inspection.manifest, original.config);
  const destination = { type: 'subscription' as const, identity: azureStateUrl(original.config.backend.backend, 'blob'),
    subscriptionId: original.config.binding.subscriptionId };
  return {
    phaseId: input.phase.id, adapter: 'azure-opentofu', actionId: 'azure.application-private.receipt',
    mutationClass: 'backend-state-read', remote: true, destructive: false, destination,
    inputs: { reference: { phaseId: requested.phaseId, evidence: original.reference }, resourceSourceDigest: source.digest },
    effects: [
      { mutationClass: 'read-worktree', destination: { type: 'external', identity: input.inspection.projectRoot }, remote: false, destructive: false },
      ...applicationPrivateReadResourceIds(original.config).map((identity) => ({
        mutationClass: 'azure-read' as const, destination: { ...destination, identity }, remote: true, destructive: false
      }))
    ]
  };
}

export interface CompletedApplicationPrivateReceipt {
  kind: 'completed-private-application-receipt.v1';
  reference: ApplicationPrivateReceiptReference;
  originalPlanDigest: string;
  result: ApplicationPrivateResult;
  observedResources: ApplicationPrivateResult['observations'];
  observedAt: string;
}

function originalStageContext(input: PhasePlanningInput, requested: ApplicationPrivateStageReference) {
  must(requested.phaseId === 'staging-qualified' && isRecord(requested.review) &&
    /^[a-f0-9]{64}$/u.test(requested.review.sourcePlanDigest) && /^[a-f0-9]{64}$/u.test(requested.review.reviewDigest),
  'original-private-stage-reference');
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === requested.phaseId)!;
  const matches = input.inspection.contexts[requested.phaseId].reviewedPlans?.filter((plan) =>
    plan.planDigest === requested.review.sourcePlanDigest) ?? [];
  must(matches.length === 1, 'original-private-stage-plan');
  const plan = validateSavedTransitionPlan(matches[0]);
  must(plan.phaseId === requested.phaseId && plan.configuration && plan.scope === 'activation', 'original-private-stage-plan');
  const original: PhasePlanningInput = {
    ...input, phase, inspection: { ...input.inspection, activationInputs: plan.configuration }
  };
  const config = applicationPrivateInputs(original);
  must(config.scope === 'staging' && config.mode !== 'prepare' && config.reviewed, 'completed-private-stage-required');
  return { plan, config, context: applicationPrivateContext(original, config) };
}

export async function applicationPrivateStageOperation(
  input: PhasePlanningInput, requested: ApplicationPrivateStageReference
): Promise<TransitionOperation> {
  const original = originalStageContext(input, requested);
  const source = await inspectApplicationPrivateSource(input.inspection.projectRoot, input.inspection.manifest, original.config);
  const destination = { type: 'subscription' as const, identity: azureStateUrl(original.config.backend.backend, 'blob'),
    subscriptionId: original.config.binding.subscriptionId };
  return {
    phaseId: input.phase.id, adapter: 'azure-opentofu', actionId: 'azure.application-private.receipt',
    mutationClass: 'backend-state-read', remote: true, destructive: false, destination,
    inputs: { stage: requested, resourceSourceDigest: source.digest },
    effects: [
      { mutationClass: 'read-worktree', destination: { type: 'external', identity: input.inspection.projectRoot }, remote: false, destructive: false },
      ...applicationPrivateReadResourceIds(original.config).map((identity) => ({
        mutationClass: 'azure-read' as const, destination: { ...destination, identity }, remote: true, destructive: false
      }))
    ]
  };
}

export async function readCompletedApplicationPrivateStage(
  input: PhaseAdapterExecutionInput, requested: ApplicationPrivateStageReference, operation: TransitionOperation,
  adapters: ApplicationPrivateAdapters = {}
): Promise<Omit<CompletedApplicationPrivateReceipt, 'reference'> & { reference: ApplicationPrivateStageReference }> {
  const original = originalStageContext(input, requested);
  must(canonicalSha256(operation) === canonicalSha256(await applicationPrivateStageOperation(input, requested)),
    'exact-private-stage-read-operation');
  const source = await inspectApplicationPrivateSource(input.inspection.projectRoot, input.inspection.manifest, original.config);
  const readReview = () => readRetainedPhaseReview(input.inspection.projectRoot, input.inspection.state, original.plan,
    requested.review, azurePorts(input).storage);
  const { review } = await readReview();
  const reviewedPayload = review.payload;
  must(review.kind === 'application-private-plan' && isRecord(reviewedPayload) &&
    reviewedPayload.stage === 'staging-deployed' && isRecord(reviewedPayload.result),
    'completed-private-stage-review');
  const check = async () => {
    const held = await currentProjectMutationLease(input.inspection.projectRoot);
    must(held, 'real-project-mutation-lease-required');
    await held.assertHeld();
    await assertAzurePhaseAuthority(input, operation);
    await verifyApplicationPrivateSource(input.inspection.projectRoot, source);
    if (original.config.artifactSet) await readApplicationPrivateArtifactRoles(input, original.config);
    else assertApplicationPrivateArtifact(input, original.config.artifact);
    await readReview();
  };
  const authority: ApplicationPrivateAuthority = {
    input, operation, operations: [operation], assertCurrent: check,
    async assertRelease() { must(false, 'read-only-private-stage'); }
  };
  await check();
  const runtime = await createApplicationPrivateRuntime(input, applicationPrivateIntent(original.config), source, original.context, authority, adapters);
  const store = new ApplicationPrivateCheckpointStore({
    authority, workspace: runtime.storage.workspace, context: original.context, configuration: original.config
  });
  const journal = await store.readCompleted(original.config.reviewed!, requested.phaseId);
  await verifyApplicationPrivateOriginalAuthority(input, journal);
  const saved = await readApplicationPrivateSavedPlan(runtime, journal, original.config);
  await validateApplicationPrivateEffectIntents(runtime, journal, saved);
  const result = completedApplicationPrivateResult(journal, original.config, saved.review);
  must(canonicalSha256(result) === canonicalSha256(reviewedPayload.result) &&
    journal.value.applyGovernancePlan?.planDigest === original.plan.planDigest, 'original-private-stage-result');
  const candidate = await readApplicationPrivateArtifact(runtime, journal.value.candidate!, 'candidate');
  try {
    const metadata = await runtime.backend.metadata(runtime.context);
    const remote = await runtime.backend.readPrivate(metadata, runtime.context);
    try {
      must(stateDigest(remote) === stateDigest(candidate) && journal.value.publication === 'verified' &&
        metadata.operationId === journal.value.publicationCorrelationId, 'completed-private-stage-state');
    } finally { remote.fill(0); }
    const state = applicationPrivateState(candidate, metadata);
    await runtime.assertArtifact();
    const observedResources: ApplicationPrivateResult['observations'][number][] = [];
    for (const target of saved.intent.targets) {
      const current = state.resources.get(target.address)?.values;
      must(current, 'completed-private-stage-inventory');
      const observed = await runtime.observe(target, true, undefined, current);
      must(String(applicationPrivateResourceId(target, current)).toLowerCase() === observed.resourceId.toLowerCase(),
        'completed-private-stage-resource');
      const { values: _values, privateDigest: _digest, ...publicObservation } = observed;
      observedResources.push(publicObservation);
    }
    must(stateMetadataMatches(metadata, await runtime.backend.metadata(runtime.context)), 'completed-private-stage-race');
    await check();
    return { kind: 'completed-private-application-receipt.v1', reference: requested, originalPlanDigest: original.plan.planDigest,
      result, observedResources, observedAt: (input.clock?.() ?? input.now).toISOString() };
  } finally { candidate.fill(0); }
}

/** Original journals/receipts remain immutable; this reader never acquires a lease, applies, or publishes state. */
export async function readCompletedApplicationPrivateReceipt(
  input: PhaseAdapterExecutionInput, requested: ApplicationPrivateReceiptReference, operation: TransitionOperation,
  adapters: ApplicationPrivateAdapters = {}
): Promise<CompletedApplicationPrivateReceipt> {
  const original = originalContext({ ...input, now: input.clock?.() ?? input.now }, requested);
  const expected = await applicationPrivateReceiptOperation(input, requested);
  must(canonicalSha256(operation) === canonicalSha256(expected), 'exact-private-read-operation');
  const source = await inspectApplicationPrivateSource(input.inspection.projectRoot, input.inspection.manifest, original.config);
  const check = async () => {
    const held = await currentProjectMutationLease(input.inspection.projectRoot);
    must(held, 'real-project-mutation-lease-required');
    await held.assertHeld();
    await assertAzurePhaseAuthority(input, operation);
    await verifyApplicationPrivateSource(input.inspection.projectRoot, source);
    if (original.config.artifactSet) await readApplicationPrivateArtifactRoles(input, original.config);
    else assertApplicationPrivateArtifact(input, original.config.artifact);
    originalContext({ ...input, now: input.clock?.() ?? input.now }, requested);
  };
  const authority: ApplicationPrivateAuthority = {
    input, operation, operations: [operation], assertCurrent: check,
    async assertRelease() { must(false, 'read-only-private-receipt'); }
  };
  await check();
  const runtime = await createApplicationPrivateRuntime(input, applicationPrivateIntent(original.config), source, original.context, authority, adapters);
  const store = new ApplicationPrivateCheckpointStore({
    authority, workspace: runtime.storage.workspace, context: original.context, configuration: original.config
  });
  const journal = await store.readCompleted(original.config.reviewed!, requested.phaseId);
  await verifyApplicationPrivateOriginalAuthority(input, journal);
  const saved = await readApplicationPrivateSavedPlan(runtime, journal, original.config);
  await validateApplicationPrivateEffectIntents(runtime, journal, saved);
  const result = completedApplicationPrivateResult(journal, original.config, saved.review);
  must(canonicalSha256(result) === canonicalSha256(original.publicResult) &&
    (journal.value.applyGovernancePlan?.planDigest === original.plan.planDigest ||
      journal.value.events.some((event) => event.kind === 'recovery-authorized' &&
        isRecord(event.details.governancePlan) && canonicalSha256(event.details.governancePlan) === canonicalSha256(original.plan))),
  'original-private-result-binding');
  const buffers: Uint8Array[] = [];
  try {
    const backup = await readApplicationPrivateArtifact(runtime, saved.original, 'backup'); buffers.push(backup);
    const shown = await readApplicationPrivateArtifact(runtime, saved.shownPlan, 'inspection'); buffers.push(shown);
    const candidate = await readApplicationPrivateArtifact(runtime, journal.value.candidate!, 'candidate'); buffers.push(candidate);
    const admitted = admitApplicationPrivatePlan(shown, backup, saved.originalSnapshot, saved.source, saved.intent);
    const checked = inspectApplicationPrivateCandidate(candidate, backup, saved.originalSnapshot, admitted);
    must(checked.complete, 'completed-private-candidate-required');
    const before = await runtime.backend.metadata(runtime.context);
    const remote = await runtime.backend.readPrivate(before, runtime.context); buffers.push(remote);
    must(stateDigest(remote) === stateDigest(candidate) &&
      (journal.value.publication === 'verified' ? before.operationId === journal.value.publicationCorrelationId :
        stateDigest(candidate) === saved.original.digest), 'completed-private-state-readback');
    const observedResources: ApplicationPrivateResult['observations'][number][] = [];
    await runtime.assertArtifact();
    for (const target of saved.intent.targets) {
      const state = checked.values.get(target.address)!;
      const observed = await runtime.observe(target, true, undefined, state);
      must(observed.exists && observed.verified &&
        String(applicationPrivateResourceId(target, state)).toLowerCase() === observed.resourceId.toLowerCase(),
      'completed-private-resource-readback');
      const { values: _values, privateDigest: _digest, ...publicObservation } = observed;
      observedResources.push(publicObservation);
    }
    const after = await runtime.backend.metadata(runtime.context);
    must(stateMetadataMatches(before, after), 'completed-private-state-race');
    await check();
    return {
      kind: 'completed-private-application-receipt.v1', reference: requested, originalPlanDigest: original.plan.planDigest,
      result, observedResources, observedAt: (input.clock?.() ?? input.now).toISOString()
    };
  } finally { for (const bytes of buffers) bytes.fill(0); }
}
