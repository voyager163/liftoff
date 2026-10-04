import { inspectCompletionBoundary } from '../governance/modern-local-finalization.js';
import { reviewLocalPublicationWrites } from '../governance/modern-publication-review.js';
import { loadRevalidationResult, revalidationStore } from './modern-revalidation-records.js';
import { completionHash } from '../../domain/governance/activation/modern-local-completion.js';
import { copyModernLocalData, localInputFailure } from '../../domain/governance/activation/modern-local-inputs.js';
import {
  validateRevalidationState, type LocalRevalidationState
} from '../../domain/governance/activation/modern-revalidation-publication.js';

async function selectedRevalidation(root: string, publicationFingerprint: string) {
  ({ root, publicationFingerprint } = copyModernLocalData({ root, publicationFingerprint }));
  completionHash(publicationFingerprint);
  const boundary = await inspectCompletionBoundary(root);
  if (boundary.transaction.status !== 'absent' && boundary.transaction.planFingerprint !== publicationFingerprint) {
    localInputFailure('Observed transaction is not attributable to the exact selected revalidation publication.');
  }
  const store = revalidationStore(boundary.root), review = await loadRevalidationResult(boundary.root, publicationFingerprint, store);
  if (review.result.publicationFingerprint !== publicationFingerprint) {
    localInputFailure('Select the revalidation publication fingerprint, not its construction or verification fingerprint.');
  }
  const saved = await store.readState(review.intent.fingerprint);
  const state = saved ? validateRevalidationState(saved.value as LocalRevalidationState, review.result) : null;
  if (state?.transactionDigest && boundary.transaction.status !== 'absent' &&
      state.transactionDigest !== boundary.transaction.transactionDigest) {
    localInputFailure('Observed revalidation transaction differs from the original publication claim.');
  }
  return { boundary, review, state };
}

export async function inspectModernRevalidationProgress(root: string, publicationFingerprint: string) {
  const { boundary, review, state } = await selectedRevalidation(root, publicationFingerprint);
  return {
    projectRoot: boundary.root, publicationFingerprint, intentFingerprint: review.intent.fingerprint,
    result: review.result, state, transaction: boundary.transaction,
    recordedProgressIsCurrentProof: false as const
  };
}

export async function reviewModernRevalidationPublication(root: string, publicationFingerprint: string) {
  const { boundary, review, state } = await selectedRevalidation(root, publicationFingerprint);
  return {
    projectRoot: boundary.root, publicationFingerprint, intentFingerprint: review.intent.fingerprint,
    result: review.result, state, transaction: boundary.transaction,
    files: reviewLocalPublicationWrites(review.result.targets, review.mutations),
    currentSourceVerified: false as const, publicationAuthorized: false as const
  };
}
