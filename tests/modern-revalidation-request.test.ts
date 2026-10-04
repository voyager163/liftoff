import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import {
  modernRevalidationCommandReportSchemaVersion, parseModernRevalidationRequest, parseModernRevalidationConsent
} from '../src/application/update/modern-revalidation-request.js';
import { reviewLocalPublicationWrites } from '../src/application/governance/modern-publication-review.js';

const fingerprint = 'a'.repeat(64);
const consent = {
  kind: 'approve-successor-revalidation', publishExactLocalBytes: true,
  intentFingerprint: fingerprint, candidateBinding: 'b'.repeat(64), targetSetDigest: 'c'.repeat(64)
};
describe('closed public successor revalidation requests', () => {
  it('allocates a separate reporting schema without changing verification or completion schemas', () => {
    expect(modernRevalidationCommandReportSchemaVersion).toBe(6);
  });
  it('requires an explicit local operation, exact selectors and separately supplied consent', () => {
    for (const tail of [
      ['plan', '--inputs', 'request.json'], ['approve', '--plan', fingerprint, '--inputs', 'consent.json'],
      ['apply-next', '--plan', fingerprint], ['apply-next', '--plan', fingerprint, '--execute'],
      ['recover', '--plan', fingerprint], ['recover', '--plan', fingerprint, '--execute=false'],
      ['recover', '--plan', fingerprint, '--execute']
    ]) expect(parseArgs(['governance', ...tail, '--scope', 'local', '--local-operation', 'revalidate-successor']).subcommand).toBe(tail[0]);
  });
  it('rejects implicit selection, replacement recovery and unrelated authority, even when false-valued', () => {
    for (const tail of [
      ['plan'], ['plan', '--inputs', 'request.json', '--plan', fingerprint],
      ['plan', '--inputs', 'request.json', '--execute=false'], ['approve', '--inputs', 'consent.json'],
      ['recover'], ['recover', '--plan', fingerprint, '--inputs', 'replacement.json'],
      ['status'], ['resume'], ['verify'],
      ...['live=false', 'protected-stdin=false', 'revalidation-publication=' + fingerprint, 'recover-phase=local-complete']
        .map(flag => ['apply-next', '--plan', fingerprint, '--' + flag])
    ]) expect(() => parseArgs(['governance', ...tail, '--scope', 'local', '--local-operation', 'revalidate-successor'])).toThrow();
    expect(() => parseArgs(['governance', 'plan', '--local-operation', 'revalidate-successor', '--inputs', 'request.json'])).toThrow();
  });
  it.each([
    { kind: 'revalidate-successor', executionFingerprint: fingerprint },
    { kind: 'review-successor-revalidation', publicationFingerprint: fingerprint }
  ])('copies the exact request without adding execution or publication approval: %j', request => {
    expect(parseModernRevalidationRequest(request)).toEqual(request);
    expect(parseModernRevalidationRequest(request)).not.toBe(request);
  });
  it.each([null, [], {}, { kind: 'revalidate-successor' }, { kind: 'verify-local', publicationFingerprint: fingerprint },
    { kind: 'revalidate-successor', executionFingerprint: fingerprint, complete: true },
    { kind: 'review-successor-revalidation', publicationFingerprint: fingerprint, recover: true }])('rejects an invalid request %j', request => {
    expect(() => parseModernRevalidationRequest(request)).toThrow();
  });
  it.each(['', 'A'.repeat(64), 'a'.repeat(63), '../external', 123, null])('rejects nonexact fingerprints %j', value => {
    expect(() => parseModernRevalidationRequest({ kind: 'revalidate-successor', executionFingerprint: value })).toThrow();
    expect(() => parseModernRevalidationRequest({ kind: 'review-successor-revalidation', publicationFingerprint: value })).toThrow();
    for (const field of ['intentFingerprint', 'candidateBinding', 'targetSetDigest']) {
      expect(() => parseModernRevalidationConsent({ ...consent, [field]: value })).toThrow();
    }
  });
  it('passes only the four private authorization fields, not the public discriminator', () => {
    const { kind, authorization } = parseModernRevalidationConsent(consent);
    expect(kind).toBe(consent.kind);
    expect(authorization).toEqual({
      publishExactLocalBytes: true, intentFingerprint: fingerprint, candidateBinding: 'b'.repeat(64), targetSetDigest: 'c'.repeat(64)
    });
    expect(authorization).not.toHaveProperty('kind');
  });
  it.each([false, 'true', null, undefined])('rejects nonaffirmative consent %j', value => {
    expect(() => parseModernRevalidationConsent({ ...consent, publishExactLocalBytes: value })).toThrow();
  });
  it('rejects foreign consent kinds, extra fields, missing bindings and accessor execution', () => {
    expect(() => parseModernRevalidationConsent({ ...consent, kind: 'approve-local-publication' })).toThrow();
    expect(() => parseModernRevalidationConsent({ ...consent, providerAccess: false })).toThrow();
    expect(() => parseModernRevalidationConsent({ ...consent, intentFingerprint: undefined })).toThrow();
    let called = false;
    const input = Object.defineProperty({}, 'kind', { enumerable: true, get() { called = true; throw new Error('Do not execute.'); } });
    expect(() => parseModernRevalidationRequest(input)).toThrow();
    expect(() => parseModernRevalidationConsent(input)).toThrow();
    expect(called).toBe(false);
  });
});

describe('shared exact-text publication review', () => {
  const target = { pathParts: ['governance', 'state.json'], mode: 0o600 };
  const mutation = { type: 'write' as const, pathParts: target.pathParts, mode: 0o600, content: Buffer.from('{"exact":true}\r\n') };
  it('retains every descriptor and exact UTF8 bytes without approving them', () => {
    const review = reviewLocalPublicationWrites([target], [mutation]);
    expect(review).toEqual([{ ...target, content: '{"exact":true}\r\n' }]);
    expect(Buffer.from(review[0].content)).toEqual(mutation.content);
    expect(target).not.toHaveProperty('content');
  });
  it('rejects lossy decoding rather than hiding bytes behind base64', () => {
    expect(() => reviewLocalPublicationWrites([target], [{ ...mutation, content: Buffer.from([0xff]) }])).toThrow('exact UTF8');
  });
  it('rejects nonwrite mutations, cardinality differences and missing descriptors', () => {
    expect(() => reviewLocalPublicationWrites([target], [{ type: 'delete', pathParts: target.pathParts }])).toThrow('writes');
    expect(() => reviewLocalPublicationWrites([], [mutation])).toThrow('descriptors differ');
    expect(() => reviewLocalPublicationWrites(new Array<typeof target>(1), [mutation])).toThrow('no target descriptor');
  });
});
