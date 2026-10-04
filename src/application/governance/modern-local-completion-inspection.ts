import { localExecutionRoot } from './modern-local-approval.js';
import {
  finalizationStore, inspectCompletionBoundary, loadFinalizationResult, readFinalizationPreview
} from './modern-local-finalization.js';
import {
  completionHash, validateFinalizationState, type LocalFinalizationState
} from '../../domain/governance/activation/modern-local-completion.js';
import { copyModernLocalData, localInputFailure } from '../../domain/governance/activation/modern-local-inputs.js';

export async function inspectModernLocalFinalization(root: string, fingerprint: string) {
  ({ root, fingerprint } = copyModernLocalData({ root, fingerprint }));
  completionHash(fingerprint);
  const canonical = await localExecutionRoot(root), store = finalizationStore(canonical);
  const preview = await readFinalizationPreview(canonical, fingerprint, store);
  const saved = await store.readState(fingerprint);
  const state = saved ? validateFinalizationState(saved.value as LocalFinalizationState, preview) : null;
  return {
    projectRoot: canonical, fingerprint, preview, state,
    recordedProgressIsCurrentProof: false as const
  };
}

async function selectedPublication(root: string, publicationFingerprint: string) {
  ({ root, publicationFingerprint } = copyModernLocalData({ root, publicationFingerprint }));
  completionHash(publicationFingerprint);
  const boundary = await inspectCompletionBoundary(root), canonical = boundary.root;
  if (boundary.transaction.status !== 'absent' && boundary.transaction.planFingerprint !== publicationFingerprint) {
    localInputFailure('Observed publication is not attributable to the exact selected publication.');
  }
  const store = finalizationStore(canonical), review = await loadFinalizationResult(canonical, publicationFingerprint, store);
  if (review.result.publicationFingerprint !== publicationFingerprint) {
    localInputFailure('Select the publication fingerprint, not a finalization or verification fingerprint.');
  }
  const saved = await store.readState(review.preview.fingerprint);
  if (!saved) localInputFailure('Original publication progress is missing.');
  const state = validateFinalizationState(saved.value as LocalFinalizationState, review.preview);
  if (state.publicationFingerprint !== publicationFingerprint || state.candidateBinding !== review.result.candidateBinding) {
    localInputFailure('Recorded publication progress differs from the selected exact-byte review.');
  }
  return { boundary, review, state };
}

export async function inspectModernLocalPublication(root: string, publicationFingerprint: string) {
  const { boundary, review, state } = await selectedPublication(root, publicationFingerprint);
  return {
    projectRoot: boundary.root, publicationFingerprint, finalizationFingerprint: review.preview.fingerprint,
    result: review.result, state, transaction: boundary.transaction,
    recordedProgressIsCurrentProof: false as const
  };
}

export async function reviewModernLocalPublication(root: string, publicationFingerprint: string) {
  const { boundary, review, state } = await selectedPublication(root, publicationFingerprint);
  const files = review.mutations.map((mutation, index) => {
    if (mutation.type !== 'write') localInputFailure('Only the registered exact-file completion writes may be reviewed.');
    const bytes = Buffer.from(mutation.content), content = bytes.toString('utf8');
    if (!Buffer.from(content).equals(bytes)) localInputFailure('Local completion review requires exact UTF8 target bytes.');
    const target = review.result.targets[index] ?? localInputFailure('A prepared completion write has no target descriptor.');
    return { ...target, content };
  });
  return {
    projectRoot: boundary.root, publicationFingerprint, finalizationFingerprint: review.preview.fingerprint,
    result: review.result, state, transaction: boundary.transaction, files,
    currentSourceVerified: false as const, publicationAuthorized: false as const
  };
}
