import { exactRecord, isRecord } from '../../domain/project/manifest/fields.js';
import { copyModernLocalData, localInputFailure } from '../../domain/governance/activation/modern-local-inputs.js';
import { validateLocalExecutionScopes, validateManualNativeExecutionScopes } from '../../domain/governance/activation/modern-local-runtime.js';
import { validateBootstrapScopeAttestation } from '../../domain/governance/activation/modern-openspec-obligations.js';
import { parseApplicationPreparation } from '../repair/application-preparation-inputs.js';

export const modernLocalCommandReportSchemaVersion = 7;

export interface ModernLocalVerificationRequest {
  kind: 'verify-local' | 'verify-manual-native' | 'verify-openspec-local' | 'verify-openspec-initialized' | 'verify-openspec-archived';
  preparation: ReturnType<typeof parseApplicationPreparation>;
}

export function parseModernLocalVerificationRequest(input: unknown): ModernLocalVerificationRequest {
  const value = exactRecord(copyModernLocalData(input), ['kind', 'preparation'], 'Local verification request');
  const kind = value.kind;
  if (kind !== 'verify-local' && kind !== 'verify-manual-native' && kind !== 'verify-openspec-local' &&
      kind !== 'verify-openspec-initialized' && kind !== 'verify-openspec-archived') {
    localInputFailure('Select one registered local verification request; no activation or publication is authorized.');
  }
  return { kind, preparation: parseApplicationPreparation(value.preparation) };
}

export function parseModernLocalConsentRequest(input: unknown) {
  const copied = copyModernLocalData(input);
  if (!isRecord(copied)) localInputFailure('Local execution consent must be an explicit public JSON object.');
  if (copied.kind === 'approve-openspec-initialized') {
    const value = exactRecord(copied, ['kind', 'scopes', 'bootstrapScopeAttestation'], 'Initialized local consent request');
    return {
      kind: 'approve-openspec-initialized' as const,
      scopes: validateLocalExecutionScopes(value.scopes),
      bootstrapScopeAttestation: validateBootstrapScopeAttestation(value.bootstrapScopeAttestation)
    };
  }
  const value = exactRecord(copied, ['kind', 'scopes'], 'Local execution consent request');
  if (value.kind === 'approve-manual-native') {
    return { kind: 'approve-manual-native' as const, scopes: validateManualNativeExecutionScopes(value.scopes) };
  }
  if (value.kind !== 'approve-local-execution') localInputFailure('An explicit local execution consent request is required.');
  return { kind: 'approve-local-execution' as const, scopes: validateLocalExecutionScopes(value.scopes) };
}
