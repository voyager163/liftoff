import { exactRecord, isRecord } from '../../domain/project/manifest/fields.js';
import { copyModernLocalData, localInputFailure } from '../../domain/governance/activation/modern-local-inputs.js';
import { completionHash } from '../../domain/governance/activation/modern-local-completion.js';

export const modernRevalidationCommandReportSchemaVersion = 6;

export function parseModernRevalidationRequest(input: unknown) {
  const copied = copyModernLocalData(input);
  if (!isRecord(copied)) localInputFailure('Successor revalidation requires an explicit public JSON object.');
  if (copied.kind === 'revalidate-successor') {
    const value = exactRecord(copied, ['kind', 'executionFingerprint'], 'Successor revalidation request');
    completionHash(value.executionFingerprint);
    return { kind: 'revalidate-successor' as const, executionFingerprint: value.executionFingerprint };
  }
  const value = exactRecord(copied, ['kind', 'publicationFingerprint'], 'Successor revalidation review request');
  if (value.kind !== 'review-successor-revalidation') localInputFailure('Select one completed successor verification or one prepared revalidation publication.');
  completionHash(value.publicationFingerprint);
  return { kind: 'review-successor-revalidation' as const, publicationFingerprint: value.publicationFingerprint };
}

export function parseModernRevalidationConsent(input: unknown) {
  const value = exactRecord(copyModernLocalData(input), [
    'kind', 'publishExactLocalBytes', 'intentFingerprint', 'candidateBinding', 'targetSetDigest'
  ], 'Successor revalidation publication consent');
  if (value.kind !== 'approve-successor-revalidation' || value.publishExactLocalBytes !== true) {
    localInputFailure('Separate exact-byte successor revalidation publication approval is required.');
  }
  completionHash(value.intentFingerprint);
  completionHash(value.candidateBinding);
  completionHash(value.targetSetDigest);
  return {
    kind: 'approve-successor-revalidation' as const,
    authorization: {
      publishExactLocalBytes: true as const, intentFingerprint: value.intentFingerprint,
      candidateBinding: value.candidateBinding, targetSetDigest: value.targetSetDigest
    }
  };
}
