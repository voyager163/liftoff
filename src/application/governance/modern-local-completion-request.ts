import { exactRecord } from '../../domain/project/manifest/fields.js';
import { copyModernLocalData, localInputFailure } from '../../domain/governance/activation/modern-local-inputs.js';
import {
  completionHash, validateFinalizationScopes, validateSpecKitFinalizationScopes
} from '../../domain/governance/activation/modern-local-completion.js';

export const modernLocalCompletionReportSchemaVersion = 5;

export function parseModernLocalFinalizationRequest(input: unknown) {
  const value = exactRecord(copyModernLocalData(input), ['kind', 'executionFingerprint'], 'Local finalization request');
  if (value.kind !== 'finalize-local') localInputFailure('Select explicit local finalization of one completed verification.');
  completionHash(value.executionFingerprint);
  return { kind: 'finalize-local' as const, executionFingerprint: value.executionFingerprint };
}

export function parseModernLocalFinalizationConsent(input: unknown) {
  const value = exactRecord(copyModernLocalData(input), ['kind', 'scopes'], 'Local finalization consent');
  if (value.kind === 'approve-manual-finalization') {
    return { kind: 'approve-manual-finalization' as const, scopes: validateFinalizationScopes(value.scopes) };
  }
  if (value.kind === 'approve-spec-kit-finalization') {
    return { kind: 'approve-spec-kit-finalization' as const, scopes: validateSpecKitFinalizationScopes(value.scopes) };
  }
  return localInputFailure('Select explicit Manual or Spec Kit finalization consent; publication requires separate approval.');
}

export function parseModernLocalPublicationRequest(input: unknown) {
  const value = exactRecord(copyModernLocalData(input), ['kind', 'publicationFingerprint'], 'Local publication review request');
  if (value.kind !== 'review-local-publication') localInputFailure('Select the exact prepared local publication for review.');
  completionHash(value.publicationFingerprint);
  return { kind: 'review-local-publication' as const, publicationFingerprint: value.publicationFingerprint };
}

export function parseModernLocalPublicationConsent(input: unknown) {
  const value = exactRecord(copyModernLocalData(input), [
    'kind', 'publishExactLocalBytes', 'finalizationFingerprint', 'candidateBinding', 'targetSetDigest'
  ], 'Local publication consent');
  if (value.kind !== 'approve-local-publication' || value.publishExactLocalBytes !== true) {
    localInputFailure('Explicit approval of the exact prepared local bytes is required.');
  }
  completionHash(value.finalizationFingerprint);
  completionHash(value.candidateBinding);
  completionHash(value.targetSetDigest);
  return {
    kind: 'approve-local-publication' as const,
    authorization: {
      publishExactLocalBytes: true as const, finalizationFingerprint: value.finalizationFingerprint,
      candidateBinding: value.candidateBinding, targetSetDigest: value.targetSetDigest
    }
  };
}
