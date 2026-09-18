import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import type {
  PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput
} from '../../governance-activation/transition-ports.js';
import { readbackProof } from '../../governance-activation/transition-records.js';
import { AzureArmError } from '../../adapters/azure/activation-rest.js';
import { GitHubActivationError } from '../../adapters/github/activation-rest.js';
import { StateMigrationError } from '../../domain/repair/stateful.js';
import type { ApplicationPrivateAdapters } from '../../adapters/azure/application-private-runtime.js';
import { parseApplicationImageReference } from '../../adapters/azure/application-provisioning.js';
import { AzureActivationAdmissionError } from './authority.js';
import {
  ApplicationPrivateError, applicationPrivateAssert as must,
  type ApplicationPrivateResult
} from './application-private-contracts.js';
import { readApplicationPrivateArtifact } from './application-private-custody.js';
import {
  applicationRehearsalBinding, applicationRehearsalInputs, applicationRehearsalPrivateReview, applicationRehearsalProtocol,
  type ApplicationRehearsalInputs, type ApplicationRehearsalPrivateResult
} from './application-rehearsal-inputs.js';
import {
  ApplicationRehearsalRecordStore, applicationRehearsalStepReview,
  assertApplicationRehearsalRollbackPlan, captureApplicationRehearsalSnapshot, openApplicationRehearsalPrivateStage,
  readApplicationRehearsalBuild, readApplicationRehearsalInventory, readApplicationRehearsalSnapshot, readCompletedApplicationRehearsalReceipt,
  requireApplicationRehearsalStepReview, type ApplicationRehearsalPrivateStage, type ApplicationRehearsalRetainedStep,
  type ApplicationRehearsalRoot, type ApplicationRehearsalStepKind
} from './application-rehearsal-receipt.js';
import {
  assertIssuedApplicationRehearsalAuthority, createApplicationRehearsalAuthority, prepareApplicationRehearsalExecution,
  type ApplicationRehearsalPrivateAuthority
} from './application-rehearsal-authority.js';

export {
  assertIssuedApplicationRehearsalAuthority, type ApplicationRehearsalPrivateAuthority
} from './application-rehearsal-authority.js';

export const applicationRehearsalEngineSeamBlocker =
  'NEED-COORDINATOR: register production-rehearsed private scopes rehearsal-rollout/rehearsal-rollback and the exact prod root; ' +
  'wire the concrete executeApplicationPrivatePlan with authentic external disposable authority and the two exact companion read operations. ' +
  'This coordinator never substitutes foundation, a state-only executor, a supplied success ledger or a workflow dispatch.';

/**
 * NEED-COORDINATOR: this is a wiring object for the concrete resource engine,
 * not a phase-success callback. The engine must retain its exact native plan,
 * pre-effect intents, lease/CAS and recovery invariants; compare the FULL remote
 * operation list to private operations + authority.additionalOperations; invoke
 * assertIssuedApplicationRehearsalAuthority at every pre-effect boundary; and
 * use assertApplicationRehearsalArtifact for the original rollback artifact.
 * Rehearsal scopes require full source/state inventory (no -target planning).
 *
 * Its result supplies ONLY a locator. The coordinator reopens the original
 * protected plan, actual closed journal, effect intents, candidate and readback.
 * No default implementation is installed until the owner supplies these seams.
 */
export interface ApplicationRehearsalEngineWiring {
  executeApplicationPrivatePlan(
    input: PhaseAdapterExecutionInput, adapters: ApplicationPrivateAdapters,
    authority: ApplicationRehearsalPrivateAuthority
  ): Promise<ApplicationPrivateResult | ApplicationRehearsalPrivateResult>;
}

export interface ApplicationRehearsalOptions {
  privateEngine?: ApplicationRehearsalEngineWiring;
  privateAdapters?: ApplicationPrivateAdapters;
}

function blocker(error: unknown): string {
  if (error instanceof ApplicationPrivateError || error instanceof StateMigrationError) return error.message;
  if (error instanceof AzureActivationAdmissionError || error instanceof AzureArmError || error instanceof GitHubActivationError) return error.message;
  return 'Private production rehearsal did not settle. Preserve its original review, private journal and candidate; automatic reapply is forbidden.';
}

export async function planApplicationRehearsalExecution(
  input: PhasePlanningInput, options: ApplicationRehearsalOptions = {}
): Promise<PhasePlanBuild> {
  try {
    const config = applicationRehearsalInputs(input);
    if (config.rehearsal.stage !== 'verify' && !options.privateEngine) return { operations: [], blockers: [applicationRehearsalEngineSeamBlocker] };
    return { operations: (await prepareApplicationRehearsalExecution(input)).operations };
  } catch (error) { return { operations: [], blockers: [blocker(error)] }; }
}

async function requireStep(
  store: ApplicationRehearsalRecordStore, root: ApplicationRehearsalRoot, kind: ApplicationRehearsalStepKind
) {
  const step = await store.read(root, kind);
  must(step, 'rehearsal-original-step-required');
  return step;
}

async function reviewedPredecessor(
  input: PhaseAdapterExecutionInput, config: ApplicationRehearsalInputs,
  store: ApplicationRehearsalRecordStore, root: ApplicationRehearsalRoot
): Promise<ApplicationRehearsalRetainedStep | null> {
  if (config.rehearsal.stage === 'rollout' && config.privateExecution.mode === 'prepare') {
    must(root.originalPlan.planDigest === input.plan.planDigest, 'rehearsal-cannot-replace-unfinished-rollout');
    return null;
  }
  const unpreparedInspection = config.privateExecution.mode === 'recover' && config.privateExecution.recovery === 'inspect' &&
    config.privateExecution.reviewed === null;
  if (config.rehearsal.stage === 'rollout' && unpreparedInspection) return null;
  const kind = config.rehearsal.stage === 'rollout' ? 'rollout-prepared' : 'rollout-completed';
  const rollout = await requireStep(store, root, kind);
  must(config.rehearsal.rolloutReview, 'rehearsal-original-rollout-required');
  await requireApplicationRehearsalStepReview(input, root, rollout, config.rehearsal.rolloutReview);
  if (config.rehearsal.stage === 'rollout') return rollout;
  if (config.privateExecution.mode === 'prepare' || unpreparedInspection) return null;
  const rollback = await requireStep(store, root, config.rehearsal.stage === 'verify' ? 'rollback-completed' : 'rollback-prepared');
  must(config.rehearsal.rollbackReview, 'rehearsal-separate-rollback-review');
  await requireApplicationRehearsalStepReview(input, root, rollback, config.rehearsal.rollbackReview);
  return rollback;
}

async function assertRollbackPreconditions(
  input: PhaseAdapterExecutionInput, config: ApplicationRehearsalInputs, store: ApplicationRehearsalRecordStore,
  root: ApplicationRehearsalRoot, rollback: ApplicationRehearsalPrivateStage,
  authority: ApplicationRehearsalPrivateAuthority, adapters: ApplicationPrivateAdapters
): Promise<void> {
  if (config.rehearsal.stage !== 'rollback') return;
  const rollout = await requireStep(store, root, 'rollout-completed');
  const original = await openApplicationRehearsalPrivateStage(input, rollout.plan, rollout.reviewed, true, authority, adapters);
  must(rollback.saved.original.digest === original.journal.value.candidate?.digest &&
    rollback.saved.transactionId !== original.saved.transactionId &&
    input.plan.approval.envelopeHash !== rollout.plan.approval.envelopeHash, 'rehearsal-original-rollback-state-and-approval');
  const bytes = await readApplicationPrivateArtifact(original.runtime, original.saved.original, 'backup');
  try { assertApplicationRehearsalRollbackPlan(original, rollback, bytes); }
  finally { bytes.fill(0); }
}

export function applicationRehearsalReviewOutcome(
  input: PhaseAdapterExecutionInput, root: ApplicationRehearsalRoot, step: ApplicationRehearsalRetainedStep
): PhaseAdapterOutcome {
  must(input.plan.planDigest === step.plan.planDigest, 'rehearsal-review-original-plan');
  const messages = {
    'rollout-prepared': 'The exact private rollout plan and original inventory are retained. Separately approve this saved plan before any rollout.',
    'rollout-completed': 'Rollout is privately complete and independently observed. Production rehearsal is NOT complete: prepare and separately approve rollback to the retained original configuration.',
    'rollback-prepared': 'The exact rollback saved plan restores the immutable original configuration. A separate rollback apply approval is still required.',
    'rollback-completed': 'The separately approved private rollback is complete. Review the read-only verify stage to compare both original results and the immutable pre-rollout inventory.'
  };
  return {
    status: 'review-required', blocker: messages[step.kind], review: applicationRehearsalStepReview(root, step),
    completedOperations: input.plan.operations.filter((entry) => entry.remote),
    cleanupWarnings: [`Retained rehearsal ${root.rehearsalId}; original private plans, state and reviews are not disposed or replaced.`]
  };
}

/** One stage only per invocation. Neither a prepared plan nor a completed rollout can complete the phase. */
export async function executeApplicationRehearsalExecution(
  supplied: PhaseAdapterExecutionInput, options: ApplicationRehearsalOptions = {}
): Promise<PhaseAdapterOutcome> {
  const started = performance.now();
  const input: PhaseAdapterExecutionInput = { ...supplied, clock: supplied.clock ??
    (() => new Date(supplied.now.getTime() + performance.now() - started)) };
  let root: ApplicationRehearsalRoot | null = null;
  let actual: ApplicationPrivateResult | ApplicationRehearsalPrivateResult | null = null;
  const completedOperations: TransitionOperation[] = [];
  try {
    const config = applicationRehearsalInputs(input), engine = options.privateEngine, adapters = options.privateAdapters ?? {};
    must(!input.inspection.state.phases['production-rehearsed'].operation, 'rehearsal-unresolved-external-operation');
    if (config.rehearsal.stage !== 'verify' && !engine) return { status: 'blocked', blocker: applicationRehearsalEngineSeamBlocker };
    const { prepared, authority } = await createApplicationRehearsalAuthority(input);
    const store = new ApplicationRehearsalRecordStore(input, config), found = await store.find();
    root = found.root;
    if (config.rehearsal.stage !== 'verify') {
      await readApplicationRehearsalBuild(input, config.rehearsal.candidate, true, prepared.companions[0], authority);
      await readApplicationRehearsalBuild(input, config.rehearsal.baseline.artifact, false, prepared.companions[0], authority);
      completedOperations.push(prepared.companions[0]);
    }
    if (!root || found.closed && config.rehearsal.stage === 'rollout' && config.privateExecution.mode === 'prepare') {
      must(config.rehearsal.stage === 'rollout' && config.privateExecution.mode === 'prepare' &&
        (!root || root.originalPlan.approval.envelopeHash !== input.plan.approval.envelopeHash), 'rehearsal-fresh-original-authority');
      root = await store.start(found.next, prepared.source.digest, authority);
    }
    const inspectionOnly = config.rehearsal.stage !== 'verify' && config.privateExecution.mode === 'recover' &&
      config.privateExecution.recovery === 'inspect';
    must(root.bindingDigest === applicationRehearsalBinding(config) && (inspectionOnly || root.sourceDigest === prepared.source.digest) &&
      root.workspaceRef === `state-workspace:${config.privateExecution.custody.workspaceId}`, 'rehearsal-unfinished-original-binding');
    await reviewedPredecessor(input, config, store, root);
    if (config.rehearsal.stage === 'verify') {
      const receipt = await readCompletedApplicationRehearsalReceipt(input, authority, prepared.companions, adapters);
      if (!found.closed) await store.close(root, receipt, authority);
      return {
        status: 'completed', resultState: 'verified', completedOperations: prepared.operations,
        evidencePayload: {
          kind: 'production-rehearsed.v1', recipe: applicationRehearsalProtocol,
          sourceSha: config.rehearsal.candidate.sourceSha, artifactDigest: parseApplicationImageReference(config.rehearsal.candidate.imageRef).digest,
          staging: config.rehearsal.staging, applicationRehearsal: receipt
        },
        outputs: {
          values: {
            'production.sourceSha': config.rehearsal.candidate.sourceSha,
            'production.artifactDigest': parseApplicationImageReference(config.rehearsal.candidate.imageRef).digest,
            'production.rehearsalId': root.rehearsalId, 'production.rollout.imageRef': receipt.promoted.imageRef,
            'production.restored.imageRef': receipt.restored.imageRef, 'production.original.revisionName': receipt.original.revisionName,
            'production.restored.revisionName': receipt.restored.revisionName
          },
          resources: [{ provider: 'azure', resourceType: 'Microsoft.App/containerApps', resourceId: receipt.restored.resourceId }]
        },
        liveReadback: [
          ...[receipt.candidateBuild, receipt.baselineBuild].map((build) => readbackProof(input, 'github', 'workflow-run',
            `/repos/${input.inspection.state.remoteBinding!.name}/actions/runs/${build.build.runId}`,
            { source: build.source, sourceSha: build.build.sourceSha, jobId: build.build.jobId,
              artifact: build.artifact, originalPlanDigest: build.originalPlanDigest })),
          ...receipt.restored.readbacks.map((read) => readbackProof(input, 'azure',
            read.resourceId.includes('/revisions') ? 'Microsoft.App/containerApps/revisions' : 'rehearsal-resource',
            read.resourceId, { readbackRequestId: read.requestId, observedAt: receipt.restored.observedAt }))
        ],
        cleanupWarnings: ['Original rollout and rollback records remain retained. No automatic disposal, resource reapply or cross-provider atomic rollback is claimed.']
      };
    }
    const scope = config.rehearsal.stage;
    const preparedKind = scope === 'rollout' ? 'rollout-prepared' : 'rollback-prepared';
    const completedKind = scope === 'rollout' ? 'rollout-completed' : 'rollback-completed';
    const priorCompleted = await store.read(root, completedKind);
    must(!priorCompleted || config.privateExecution.mode === 'recover' && config.privateExecution.recovery === 'inspect',
      'rehearsal-stage-already-executed');
    if (config.privateExecution.mode === 'apply') {
      const preceding = await requireStep(store, root, preparedKind);
      must(canonicalSha256(config.privateExecution.reviewed) === canonicalSha256(preceding.reviewed) &&
        preceding.plan.approval.envelopeHash !== input.plan.approval.envelopeHash, 'rehearsal-separate-exact-apply-review');
      const retained = await openApplicationRehearsalPrivateStage(input, preceding.plan, preceding.reviewed, false, authority, adapters);
      await assertRollbackPreconditions(input, config, store, root, retained, authority, adapters);
      // Re-read the private original inventory, not values supplied in the next input.
      const original = await readApplicationRehearsalSnapshot(retained, preceding, false);
      const fresh = await readApplicationRehearsalInventory(input, config, prepared.companions[1], original.inventory.imageRef, authority);
      must(fresh.revisionName === original.inventory.revisionName &&
        canonicalSha256(fresh.configuration) === canonicalSha256(original.inventory.configuration) &&
        canonicalSha256(fresh.originalRevisionTemplate) === canonicalSha256(original.inventory.originalRevisionTemplate) &&
        canonicalSha256(fresh.traffic) === canonicalSha256(original.inventory.traffic), 'rehearsal-full-inventory-drift-after-review');
    }
    must(engine, 'rehearsal-core-unavailable');
    await assertIssuedApplicationRehearsalAuthority(authority);
    actual = await engine.executeApplicationPrivatePlan(input, adapters, authority);
    if (actual.status === 'blocked' || actual.status === 'partial-published' || actual.status === 'closed-unapplied') {
      return {
        status: 'blocked', blocker: actual.blocker ?? 'The original native rehearsal stage is incomplete; inspect or publish only its exact retained candidate. Never repeat apply.',
        evidencePayload: { kind: 'production-rehearsal-incomplete.v1', rehearsalId: root.rehearsalId, applicationPrivate: actual },
        completedOperations
      };
    }
    if (actual.status === 'inspected') {
      return { status: 'blocked', blocker: priorCompleted
        ? `Original ${scope} is already settled. Consume its retained phase review ${priorCompleted.plan.planDigest}; inspection does not create a replacement stage.`
        : 'Original rehearsal inspected without resource apply. Retain the original saved-plan review and use only separately approved retained-candidate publication.',
        evidencePayload: { kind: 'production-rehearsal-inspected.v1', rehearsalId: root.rehearsalId, applicationPrivate: actual }, completedOperations };
    }
    must(actual.reviewed && actual.transactionId && actual.journalRef, 'rehearsal-real-private-result-required');
    const reviewed = applicationRehearsalPrivateReview(actual.reviewed, config.privateExecution.custody.workspaceId);
    must(actual.transactionId === reviewed.transactionId && actual.journalRef === reviewed.journalRef, 'rehearsal-private-result-locator');
    const wasPrepared = actual.status === 'prepared';
    const native = await openApplicationRehearsalPrivateStage(input, input.plan, reviewed, !wasPrepared, authority, adapters);
    must(native.saved.source.digest === root.sourceDigest, 'rehearsal-original-source');
    must(!priorCompleted, 'rehearsal-original-closed-stage');
    await assertRollbackPreconditions(input, config, store, root, native, authority, adapters);
    const kind = wasPrepared ? preparedKind : completedKind;
    const existing = await store.read(root, kind);
    if (existing) {
      must(existing.plan.planDigest === input.plan.planDigest && canonicalSha256(existing.reviewed) === canonicalSha256(reviewed),
        'rehearsal-original-stage-review-required');
      return applicationRehearsalReviewOutcome(input, root, existing);
    }
    const snapshot = await captureApplicationRehearsalSnapshot(input, config, native, prepared.companions[1], authority, !wasPrepared);
    const step: ApplicationRehearsalRetainedStep = {
      schemaVersion: 1, protocol: applicationRehearsalProtocol, rootDigest: canonicalSha256(root), kind,
      plan: structuredClone(input.plan), reviewed, snapshot, recordedAt: input.clock!().toISOString()
    };
    if (!wasPrepared) {
      const preceding = await requireStep(store, root, preparedKind);
      must(canonicalSha256(preceding.reviewed) === canonicalSha256(reviewed), 'rehearsal-original-prepared-stage');
    }
    await store.write(root, step, authority);
    return applicationRehearsalReviewOutcome(input, root, step);
  } catch (error) {
    return {
      status: 'blocked', blocker: blocker(error), completedOperations,
      ...(root || actual ? { evidencePayload: {
        kind: 'production-rehearsal-incomplete.v1', rehearsalId: root?.rehearsalId ?? null, applicationPrivate: actual
      } } : {}),
      cleanupWarnings: root ? [`Rehearsal ${root.rehearsalId} remains reserved with its original records. Do not substitute a new rollout or repeat a native apply.`] : []
    };
  }
}

/** Owner-only default wiring; a phase input cannot install or select another executor. */
export function createApplicationRehearsalComponent(
  privateEngine: ApplicationRehearsalEngineWiring, privateAdapters: ApplicationPrivateAdapters = {}
) {
  must(typeof privateEngine.executeApplicationPrivatePlan === 'function', 'rehearsal-concrete-engine-function');
  const options = Object.freeze({
    privateEngine: Object.freeze({ executeApplicationPrivatePlan: privateEngine.executeApplicationPrivatePlan.bind(privateEngine) }), privateAdapters
  });
  return Object.freeze({
    phaseId: 'production-rehearsed' as const,
    plan: (input: PhasePlanningInput) => planApplicationRehearsalExecution(input, options),
    execute: (input: PhaseAdapterExecutionInput) => executeApplicationRehearsalExecution(input, options)
  });
}
