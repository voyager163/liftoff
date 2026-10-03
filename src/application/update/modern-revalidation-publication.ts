import { randomBytes } from 'node:crypto';
import {
  applyLocalVerificationTransaction, inspectLocalVerificationCandidate, inspectLocalVerificationTransaction,
  recoverLocalVerificationTransaction, ReviewedUpdateTransactionError, type ReviewedUpdateTransactionOutcome
} from '../../adapters/filesystem/reviewed-update-transaction.js';
import { compareCompletionInputs, completionPreconditions } from '../../adapters/filesystem/modern-local-publication-inputs.js';
import { assertModernLocalToolsCurrent } from '../../adapters/process/modern-local-tools.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { copyModernLocalData, localInputFailure } from '../../domain/governance/activation/modern-local-inputs.js';
import { completionHash, completionTime } from '../../domain/governance/activation/modern-local-completion.js';
import {
  validateRevalidationConsent, validateRevalidationState, type LocalRevalidationConsent, type LocalRevalidationState
} from '../../domain/governance/activation/modern-revalidation-publication.js';
import { exactRecord } from '../../domain/project/manifest/fields.js';
import { inspectCompletionBoundary, requireIdleCompletionBoundary } from '../governance/modern-local-finalization.js';
import { inspectModernInstalledActivation, validateCapturedModernSuccessorSource } from '../governance/modern-installed-preflight.js';
import {
  compareRevalidationExecution, loadRevalidationResult, revalidationStore, validateRevalidationConstruction
} from './modern-revalidation-records.js';

type Review = Awaited<ReturnType<typeof loadRevalidationResult>>;
type Store = ReturnType<typeof revalidationStore>;
export interface SuccessorRevalidationOutcome {
  status: 'awaiting-consent' | 'awaiting-publication' | 'interrupted' | 'blocked' | 'rolled-back' |
    'committed-cleanup-pending' | 'committed-readback-pending' | 'revalidation-complete-current' | 'revalidation-incomplete';
  projectRoot: string; publicationFingerprint: string; candidateBinding: string; transactionDigest: string | null;
  committed: boolean; readbackDigest: string | null; rollbackFailures: string[]; cleanupFailures: string[];
  authority: 'local-only';
}
function outcome(status: SuccessorRevalidationOutcome['status'], review: Review, state?: LocalRevalidationState,
  transaction?: ReviewedUpdateTransactionOutcome): SuccessorRevalidationOutcome {
  return {
    status, projectRoot: review.intent.projectRoot, publicationFingerprint: review.result.publicationFingerprint,
    candidateBinding: review.result.candidateBinding, transactionDigest: transaction?.transactionDigest ?? state?.transactionDigest ?? null,
    committed: transaction?.committed === true || Boolean(state?.commitObservation),
    readbackDigest: null, rollbackFailures: transaction?.rollbackFailures ?? [], cleanupFailures: transaction?.cleanupFailures ?? [], authority: 'local-only'
  };
}
async function loadReview(root: string, fingerprint: string) {
  completionHash(fingerprint);
  const review = await loadRevalidationResult(root, fingerprint);
  if (review.result.publicationFingerprint !== fingerprint) localInputFailure('Select the exact revalidation publication fingerprint, not its construction intent.');
  return review;
}
async function consent(review: Review, live: boolean) {
  const saved = await revalidationStore(review.intent.projectRoot).read('publication-consent', review.result.publicationFingerprint);
  if (!saved) localInputFailure('Separate exact-byte revalidation publication consent is missing.');
  const raw = copyModernLocalData(saved.value) as LocalRevalidationConsent;
  if (completionTime(raw.approvedAt) > Date.now()) localInputFailure('Revalidation consent is dated after observation.');
  return validateRevalidationConsent(raw, review.result, live ? new Date() : new Date(raw.approvedAt));
}
async function changeState(store: Store, review: Review, digest: string, state: LocalRevalidationState) {
  const value = validateRevalidationState({ ...state, updatedAt: new Date().toISOString() }, review.result);
  const saved = await store.compareExchangeState(review.intent.fingerprint, digest, value);
  return { digest: saved.digest, value };
}
async function protectedCurrent(review: Review, stage: 'original' | 'target-pending' | 'target') {
  const native = await compareRevalidationExecution(review.intent);
  await assertModernLocalToolsCurrent(review.intent.projectRoot, native.state.workspace ?? review.intent.projectRoot, native.preview.tools);
  await compareCompletionInputs(review.index, review.result.targets, stage);
}
async function readback(review: Review) {
  const root = review.intent.projectRoot;
  await requireIdleCompletionBoundary(root);
  await protectedCurrent(review, 'target');
  const installed = await inspectModernInstalledActivation(root);
  if (installed.status !== 'observed') localInputFailure('Committed revalidation has no independently valid installed readback.');
  const source = await validateCapturedModernSuccessorSource(installed.snapshot);
  if (source.journal.semanticTransitionDigest !== review.intent.originalTransitionDigest ||
      canonicalSha256(source.journal.preparation) !== review.intent.originalPreparationDigest ||
      source.current.state.baselineAnchor !== review.intent.execution.baselineDigest ||
      source.journal.revalidation.status !== (review.result.phases.every(phase => phase.status === 'complete') ? 'complete' : 'blocked') ||
      review.result.phases.some((phase, index) => {
        const recorded = source.journal.revalidation.phases[index], state = source.current.state.phases[phase.phaseId];
        return recorded.phaseId !== phase.phaseId || recorded.status !== phase.status ||
          canonicalSha256(recorded.evidenceIds) !== canonicalSha256(phase.evidenceId ? [phase.evidenceId] : []) ||
          canonicalSha256(recorded.blockers) !== canonicalSha256(phase.blockers) || state.state !== (phase.status === 'complete' ? 'verified' : 'blocked');
      })) localInputFailure('Committed successor progress differs from its original identities or fresh local proof.');
  await protectedCurrent(review, 'target');
  return canonicalSha256({ kind: 'liftoff-successor-revalidation-readback', schemaVersion: 1, projectRoot: root,
    publicationFingerprint: review.result.publicationFingerprint, targetSetDigest: review.result.targetSetDigest,
    protectedSetDigest: review.result.protectedSetDigest, installedBinding: installed.binding });
}
async function finish(store: Store, review: Review, saved: { digest: string; value: LocalRevalidationState },
  transaction?: ReviewedUpdateTransactionOutcome) {
  if (!saved.value.commitObservation) localInputFailure('Revalidation cannot infer commit from installed target bytes.');
  const cleaned = await changeState(store, review, saved.digest, { ...saved.value, cleanupPending: false });
  const readbackDigest = await readback(review), complete = review.result.phases.every(phase => phase.status === 'complete');
  const final = await changeState(store, review, cleaned.digest, {
    ...cleaned.value, phase: complete ? 'complete' : 'incomplete', readbackDigest
  });
  return { ...outcome(complete ? 'revalidation-complete-current' : 'revalidation-incomplete', review, final.value, transaction), readbackDigest };
}

export async function approveModernSuccessorRevalidationPublication(root: string, publicationFingerprint: string, input: {
  publishExactLocalBytes: true; intentFingerprint: string; candidateBinding: string; targetSetDigest: string;
}): Promise<LocalRevalidationConsent> {
  ({ root, publicationFingerprint, input } = copyModernLocalData({ root, publicationFingerprint, input }));
  exactRecord(input, ['publishExactLocalBytes', 'intentFingerprint', 'candidateBinding', 'targetSetDigest'], 'Revalidation publication approval');
  const { root: canonical } = await requireIdleCompletionBoundary(root), review = await loadReview(canonical, publicationFingerprint);
  if (input.publishExactLocalBytes !== true || input.intentFingerprint !== review.intent.fingerprint ||
      input.candidateBinding !== review.result.candidateBinding || input.targetSetDigest !== review.result.targetSetDigest) {
    localInputFailure('Revalidation approval does not match the exact proposed local bytes.');
  }
  const store = revalidationStore(canonical);
  if (await store.readState(review.intent.fingerprint)) localInputFailure('Revalidation publication was already claimed; no replay or replacement approval.');
  await validateRevalidationConstruction(review);
  const prior = await store.read('publication-consent', publicationFingerprint);
  if (prior) return validateRevalidationConsent(prior.value as LocalRevalidationConsent, review.result, new Date());
  const value: LocalRevalidationConsent = {
    kind: 'liftoff-local-revalidation-publication-consent', schemaVersion: 1, projectRoot: canonical, intentFingerprint: review.intent.fingerprint,
    resultDigest: review.result.resultDigest, publicationFingerprint, candidateBinding: review.result.candidateBinding, targetSetDigest: review.result.targetSetDigest,
    executionConsentDigest: review.intent.execution.consentDigest, executionResultDigest: review.intent.execution.resultDigest,
    approvedAt: new Date().toISOString(), expiresAt: review.result.reviewExpiresAt,
    scopes: { publishLocalRecords: true, workflowWrites: false, projectCode: false, dependencyPreparation: false, dependencyNetwork: false,
      protectedStateAccess: false, providerAccess: false }
  };
  validateRevalidationConsent(value, review.result, new Date());
  await store.write('publication-consent', publicationFingerprint, value);
  return value;
}

export async function publishModernSuccessorRevalidation(root: string, publicationFingerprint: string): Promise<SuccessorRevalidationOutcome> {
  ({ root, publicationFingerprint } = copyModernLocalData({ root, publicationFingerprint }));
  const boundary = await requireIdleCompletionBoundary(root), canonical = boundary.root, review = await loadReview(canonical, publicationFingerprint);
  const store = revalidationStore(canonical);
  if (await store.readState(review.intent.fingerprint)) localInputFailure('Revalidation publication was already claimed; inspect or recover it instead of replaying.');
  await consent(review, true);
  await validateRevalidationConstruction(review);
  const preconditions = await completionPreconditions(review.index, review.result.targets);
  const candidate = await inspectLocalVerificationCandidate(canonical, review.mutations, preconditions);
  if (candidate.binding !== review.result.candidateBinding || canonicalSha256(candidate.size) !== canonicalSha256(review.result.candidateSize)) {
    localInputFailure('Revalidation candidate differs from its independently measured transaction.');
  }
  const startedAt = new Date().toISOString();
  let state: LocalRevalidationState = validateRevalidationState({
    kind: 'liftoff-local-revalidation-state', schemaVersion: 1, projectRoot: canonical, operationId: review.intent.operationId,
    intentFingerprint: review.intent.fingerprint, publicationFingerprint, candidateBinding: review.result.candidateBinding,
    ownerTokenDigest: canonicalSha256(randomBytes(32).toString('hex')), phase: 'publishing', startedAt, updatedAt: startedAt,
    transactionDigest: null, commitObservation: null, readbackDigest: null, cleanupPending: false
  }, review.result);
  let digest = (await store.compareExchangeState(review.intent.fingerprint, null, state)).digest;
  async function checkpoint(next: LocalRevalidationState) {
    const saved = await changeState(store, review, digest, next); digest = saved.digest; state = saved.value;
  }
  let transaction: ReviewedUpdateTransactionOutcome;
  try {
    transaction = await applyLocalVerificationTransaction(canonical, review.mutations, {
    planFingerprint: publicationFingerprint, authorityStore: boundary.authorityStore, preconditions, expectedCandidateBinding: review.result.candidateBinding,
    validateCurrentInputs: async stage => {
      await consent(review, true);
      const retained = await loadReview(canonical, publicationFingerprint);
      if (retained.result.resultDigest !== review.result.resultDigest) localInputFailure('Immutable revalidation result changed during publication.');
      if (stage === 'before-commit') {
        const observed = await inspectLocalVerificationTransaction(canonical, { authorityStore: boundary.authorityStore });
        if (observed.status !== 'interrupted' || observed.planFingerprint !== publicationFingerprint || observed.transactionDigest !== state.transactionDigest) {
          localInputFailure('Revalidation precommit journal differs from the attributed transaction.');
        }
      }
      await protectedCurrent(review, stage === 'before-commit' ? 'target-pending' : 'original');
    },
    onCheckpoint: async event => {
      if (event.phase !== 'prepared' && event.phase !== 'committed') return;
      const observed = await inspectLocalVerificationTransaction(canonical, { authorityStore: boundary.authorityStore });
      if (observed.planFingerprint !== publicationFingerprint || !observed.transactionDigest ||
          observed.status !== (event.phase === 'committed' ? 'committed' : 'interrupted') ||
          state.transactionDigest !== null && state.transactionDigest !== observed.transactionDigest) {
        localInputFailure('Actual revalidation checkpoint has different root, review or transaction attribution.');
      }
      await checkpoint({ ...state, transactionDigest: observed.transactionDigest, ...(event.phase === 'committed' ? {
        phase: 'committed-readback-pending' as const, cleanupPending: true,
        commitObservation: { publicationFingerprint, transactionDigest: observed.transactionDigest,
          observedAt: new Date().toISOString(), source: 'local-verification-inspector' as const, committed: true as const }
      } : {}) });
    }
    });
  } catch (error) {
    if (error instanceof ReviewedUpdateTransactionError && !state.commitObservation && error.rollbackFailures.length === 0) {
      const observed = await inspectLocalVerificationTransaction(canonical, { authorityStore: boundary.authorityStore });
      if (observed.status === 'absent') await checkpoint({ ...state, phase: 'rolled-back' });
    }
    throw error;
  }
  if (!transaction.committed) {
    await checkpoint({ ...state, phase: transaction.status === 'rolled-back' ? 'rolled-back' : 'blocked' });
    return outcome(transaction.status === 'rolled-back' ? 'rolled-back' : 'blocked', review, state, transaction);
  }
  if (transaction.cleanupFailures.length) return outcome('committed-cleanup-pending', review, state, transaction);
  return finish(store, review, { digest, value: state }, transaction);
}

export async function recoverModernSuccessorRevalidation(root: string, request: { publicationFingerprint: string }): Promise<SuccessorRevalidationOutcome> {
  ({ root, request } = copyModernLocalData({ root, request }));
  exactRecord(request, ['publicationFingerprint'], 'Successor revalidation recovery');
  const boundary = await inspectCompletionBoundary(root), review = await loadReview(boundary.root, request.publicationFingerprint);
  await consent(review, false);
  const store = revalidationStore(boundary.root), progress = await store.readState(review.intent.fingerprint);
  if (!progress) localInputFailure('Revalidation recovery lacks its original publication claim.');
  let saved = { digest: progress.digest, value: validateRevalidationState(progress.value as LocalRevalidationState, review.result) };
  const observed = boundary.transaction;
  if (observed.status === 'blocked') return { ...outcome(saved.value.commitObservation ? 'committed-readback-pending' : 'blocked', review, saved.value),
    cleanupFailures: [observed.reason ?? 'Revalidation transaction inspection is blocked.'] };
  if (observed.status !== 'absent' && (observed.planFingerprint !== request.publicationFingerprint || !observed.transactionDigest ||
      saved.value.transactionDigest !== null && saved.value.transactionDigest !== observed.transactionDigest)) {
    localInputFailure('Revalidation recovery transaction belongs to another approved publication.');
  }
  if (saved.value.commitObservation && observed.status !== 'absent' && !observed.committed) {
    localInputFailure('Previously committed successor revalidation cannot be downgraded or rolled back.');
  }
  if (observed.committed) saved = await changeState(store, review, saved.digest, {
    ...saved.value, phase: 'committed-readback-pending', cleanupPending: true, readbackDigest: null,
    transactionDigest: observed.transactionDigest!, commitObservation: saved.value.commitObservation ?? {
      publicationFingerprint: request.publicationFingerprint, transactionDigest: observed.transactionDigest!,
      observedAt: new Date().toISOString(), source: 'local-verification-inspector', committed: true
    }
  });
  if (observed.status === 'absent') {
    if (!saved.value.commitObservation) return outcome(saved.value.phase === 'rolled-back' ? 'rolled-back' : 'blocked', review, saved.value);
    if (saved.value.cleanupPending) return { ...outcome('committed-cleanup-pending', review, saved.value),
      cleanupFailures: ['The journal is absent but successful seal cleanup was not durably observed; no completion or automatic disposal is authorized.'] };
    return finish(store, review, saved);
  }
  const transaction = await recoverLocalVerificationTransaction(boundary.root, { authorityStore: boundary.authorityStore,
    expectedTransaction: { planFingerprint: request.publicationFingerprint, transactionDigest: observed.transactionDigest! } });
  if ((transaction.status !== 'blocked' || transaction.planFingerprint !== undefined || transaction.transactionDigest !== undefined) &&
      (transaction.planFingerprint !== request.publicationFingerprint || transaction.transactionDigest !== observed.transactionDigest)) {
    localInputFailure('Recovery returned a different revalidation transaction attribution.');
  }
  if (!transaction.committed) {
    if (transaction.status === 'rolled-back') saved = await changeState(store, review, saved.digest, { ...saved.value, phase: 'rolled-back' });
    return outcome(transaction.status === 'rolled-back' ? 'rolled-back' : 'blocked', review, saved.value, transaction);
  }
  if (transaction.cleanupFailures.length) return outcome('committed-cleanup-pending', review, saved.value, transaction);
  return finish(store, review, saved, transaction);
}

export async function inspectModernSuccessorRevalidationPublication(root: string, publicationFingerprint: string): Promise<SuccessorRevalidationOutcome> {
  ({ root, publicationFingerprint } = copyModernLocalData({ root, publicationFingerprint }));
  const boundary = await inspectCompletionBoundary(root), review = await loadReview(boundary.root, publicationFingerprint);
  const store = revalidationStore(boundary.root), progress = await store.readState(review.intent.fingerprint);
  const state = progress ? validateRevalidationState(progress.value as LocalRevalidationState, review.result) : undefined;
  if (boundary.transaction.status !== 'absent') {
    if (boundary.transaction.planFingerprint !== publicationFingerprint ||
        state?.transactionDigest && state.transactionDigest !== boundary.transaction.transactionDigest) {
      localInputFailure('Inspected local transaction is not this revalidation publication.');
    }
    return { ...outcome(boundary.transaction.committed ? 'committed-cleanup-pending' : boundary.transaction.status === 'blocked' ? 'blocked' : 'interrupted', review, state),
      committed: boundary.transaction.committed || Boolean(state?.commitObservation), transactionDigest: boundary.transaction.transactionDigest ?? state?.transactionDigest ?? null,
      cleanupFailures: boundary.transaction.reason ? [boundary.transaction.reason] : [] };
  }
  if (!state) {
    if (completionTime(review.result.reviewExpiresAt) <= Date.now()) localInputFailure('Revalidation publication review expired; prepare a fresh review.');
    const approved = await store.read('publication-consent', publicationFingerprint);
    if (approved) await consent(review, true);
    return outcome(approved ? 'awaiting-publication' : 'awaiting-consent', review);
  }
  await consent(review, false);
  if (!state.commitObservation) return outcome(state.phase === 'publishing' ? 'interrupted' : state.phase === 'rolled-back' ? 'rolled-back' : 'blocked', review, state);
  if (state.cleanupPending) return { ...outcome('committed-cleanup-pending', review, state), cleanupFailures: ['Successful transaction cleanup has not been durably observed.'] };
  const readbackDigest = await readback(review);
  return { ...outcome(review.result.phases.every(phase => phase.status === 'complete') ? 'revalidation-complete-current' : 'revalidation-incomplete', review, state), readbackDigest };
}
