import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import {
  modernLocalCompletionReportSchemaVersion, parseModernLocalFinalizationRequest,
  parseModernLocalFinalizationConsent, parseModernLocalPublicationRequest, parseModernLocalPublicationConsent
} from '../src/application/governance/modern-local-completion-request.js';

const fingerprint = 'a'.repeat(64);
const scopes = {
  finalizeLocal: true, workflowWrites: false, projectCode: false,
  dependencyPreparation: false, dependencyNetwork: false, publishLocalRecords: false
};
const publication = {
  kind: 'approve-local-publication', publishExactLocalBytes: true,
  finalizationFingerprint: fingerprint, candidateBinding: 'b'.repeat(64), targetSetDigest: 'c'.repeat(64)
};

describe('closed public modern local completion requests', () => {
  it('keeps completion reporting distinct from verification schema four', () => {
    expect(modernLocalCompletionReportSchemaVersion).toBe(5);
  });

  describe('explicit public completion grammar', () => {
    it.each(['finalize', 'publish'])('requires separate plan, approval and execution for %s', operation => {
      for (const tail of [
        ['plan', '--inputs', 'request.json'], ['approve', '--plan', fingerprint, '--inputs', 'consent.json'],
        ['apply-next', '--plan', fingerprint], ['apply-next', '--plan', fingerprint, '--execute'],
        ['apply-next', '--plan', fingerprint, '--execute=false']
      ]) {
        expect(parseArgs(['governance', ...tail, '--scope', 'local', '--local-operation', operation]).flags['local-operation']).toBe(operation);
      }
    });
    it('permits only separately selected publication recovery, with explicit execution', () => {
      for (const flags of [[], ['--execute'], ['--execute=false']]) {
        expect(parseArgs(['governance', 'recover', '--scope', 'local', '--local-operation', 'publish', '--plan', fingerprint, ...flags]).subcommand).toBe('recover');
      }
      expect(() => parseArgs(['governance', 'recover', '--scope', 'local', '--local-operation', 'finalize', '--plan', fingerprint])).toThrow();
    });
    it.each(['finalize', 'publish'])('rejects ambiguous or implicit %s authority', operation => {
      for (const tail of [
        ['status'], ['resume'], ['verify'], ['plan'], ['plan', '--inputs', 'request.json', '--execute=false'],
        ['plan', '--inputs', 'request.json', '--plan', fingerprint],
        ['approve', '--inputs', 'consent.json'], ['apply-next'], ['apply-next', '--plan', fingerprint, '--inputs', 'new.json'],
        ['apply-next', '--plan', fingerprint, '--live=false'],
        ['apply-next', '--plan', fingerprint, '--revalidation-publication', fingerprint],
        ['apply-next', '--plan', fingerprint, '--recover-phase', 'local-complete']
      ]) expect(() => parseArgs(['governance', ...tail, '--scope', 'local', '--local-operation', operation])).toThrow();
      expect(() => parseArgs(['governance', 'plan', '--local-operation', operation, '--inputs', 'request.json'])).toThrow();
    });
    it('rejects a replacement recovery request and missing recovery fingerprint', () => {
      for (const tail of [[], ['--plan', fingerprint, '--inputs', 'replacement.json']]) {
        expect(() => parseArgs(['governance', 'recover', '--scope', 'local', '--local-operation', 'publish', ...tail])).toThrow();
      }
    });
  });
  it('selects one completed verification without adding permission', () => {
    const input = { kind: 'finalize-local', executionFingerprint: fingerprint };
    expect(parseModernLocalFinalizationRequest(input)).toEqual(input);
  });
  it('selects one prepared publication without approving it', () => {
    const input = { kind: 'review-local-publication', publicationFingerprint: fingerprint };
    expect(parseModernLocalPublicationRequest(input)).toEqual(input);
  });
  it.each([null, [], {}, { kind: 'finalize-local' }, { kind: 'verify-local', executionFingerprint: fingerprint },
    { kind: 'finalize-local', executionFingerprint: fingerprint, execute: true }])('rejects an invalid finalization request %j', input => {
    expect(() => parseModernLocalFinalizationRequest(input)).toThrow();
  });
  it.each(['', 'a'.repeat(63), 'A'.repeat(64), '../external', 123, null])('rejects a non-exact fingerprint %j', value => {
    expect(() => parseModernLocalFinalizationRequest({ kind: 'finalize-local', executionFingerprint: value })).toThrow();
    expect(() => parseModernLocalPublicationRequest({ kind: 'review-local-publication', publicationFingerprint: value })).toThrow();
    for (const field of ['finalizationFingerprint', 'candidateBinding', 'targetSetDigest']) {
      expect(() => parseModernLocalPublicationConsent({ ...publication, [field]: value })).toThrow();
    }
  });
  it.each(['approve-manual-finalization', 'approve-spec-kit-finalization'])('preserves the exact independent %s consent', kind => {
    const input = { kind, scopes: { ...scopes, workflowWrites: kind === 'approve-spec-kit-finalization' } };
    const result = parseModernLocalFinalizationConsent(input);
    expect(result).toEqual(input);
    expect(result.scopes).not.toBe(input.scopes);
  });
  it.each(['projectCode', 'dependencyPreparation', 'dependencyNetwork', 'publishLocalRecords'])('rejects unrelated permission %s', field => {
    expect(() => parseModernLocalFinalizationConsent({
      kind: 'approve-manual-finalization', scopes: { ...scopes, [field]: true }
    })).toThrow();
    expect(() => parseModernLocalFinalizationConsent({
      kind: 'approve-spec-kit-finalization', scopes: { ...scopes, workflowWrites: true, [field]: true }
    })).toThrow();
  });
  it.each([false, 'true', null])('requires affirmative finalization permission rather than %j', finalizeLocal => {
    expect(() => parseModernLocalFinalizationConsent({
      kind: 'approve-manual-finalization', scopes: { ...scopes, finalizeLocal }
    })).toThrow();
  });
  it('requires workflow writes only for the explicit Spec Kit consent kind', () => {
    expect(() => parseModernLocalFinalizationConsent({
      kind: 'approve-manual-finalization', scopes: { ...scopes, workflowWrites: true }
    })).toThrow();
    expect(() => parseModernLocalFinalizationConsent({ kind: 'approve-spec-kit-finalization', scopes })).toThrow();
  });
  it.each([null, {}, { kind: 'approve-openspec-finalization', scopes }, { kind: 'approve-manual-finalization', scopes: true },
    { kind: 'approve-manual-finalization', scopes, execute: false },
    { kind: 'approve-manual-finalization', scopes: { ...scopes, cloud: false } }])('rejects invalid or expanded consent %j', input => {
    expect(() => parseModernLocalFinalizationConsent(input)).toThrow();
  });
  it('passes only the closed private authorization fields, never the public discriminator', () => {
    const { kind, authorization } = parseModernLocalPublicationConsent(publication);
    expect(kind).toBe('approve-local-publication');
    expect(authorization).toEqual({
      publishExactLocalBytes: true, finalizationFingerprint: fingerprint,
      candidateBinding: 'b'.repeat(64), targetSetDigest: 'c'.repeat(64)
    });
    expect(authorization).not.toHaveProperty('kind');
  });
  it.each([false, 'true', null, undefined])('rejects missing or non-affirmative publication permission %j', value => {
    expect(() => parseModernLocalPublicationConsent({ ...publication, publishExactLocalBytes: value })).toThrow();
  });
  it('rejects replay selectors, unknown modes and extra metadata on publication requests', () => {
    expect(() => parseModernLocalPublicationRequest({ kind: 'publish-local', publicationFingerprint: fingerprint })).toThrow();
    expect(() => parseModernLocalPublicationRequest({
      kind: 'review-local-publication', publicationFingerprint: fingerprint, recover: true
    })).toThrow();
    expect(() => parseModernLocalPublicationConsent({ ...publication, kind: 'approve-local-execution' })).toThrow();
    expect(() => parseModernLocalPublicationConsent({ ...publication, state: {} })).toThrow();
  });
  it('does not invoke accessors while decoding any request or consent', () => {
    let called = false;
    const input = Object.defineProperty({}, 'kind', { enumerable: true, get() { called = true; throw new Error('Do not execute.'); } });
    for (const parse of [parseModernLocalFinalizationRequest, parseModernLocalFinalizationConsent,
      parseModernLocalPublicationRequest, parseModernLocalPublicationConsent]) expect(() => parse(input)).toThrow();
    expect(called).toBe(false);
  });
});
