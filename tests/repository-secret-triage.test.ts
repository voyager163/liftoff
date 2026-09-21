import { describe, expect, it } from 'vitest';
import { inspectPrivateKeySyntax } from '../scripts/repository-security/secret-triage.ts';

describe('private syntax-only triage never establishes a disposition', () => {
  it('identifies literal placeholders without printing them or waiving a detector result', () => {
    const source = '-----BEGIN PRIVATE KEY-----\nNONFUNCTIONAL_PRIVATE_KEY_PLACEHOLDER\n-----END PRIVATE KEY-----';
    const result = inspectPrivateKeySyntax(source);
    expect(result).toMatchObject({
      label: 'PRIVATE KEY', markerPair: true, hasBase64Body: false, placeholderMarkers: true,
      usableCredentialEstablished: false, changesFindingGate: false, disposition: 'unresolved-owner-review-required'
    });
    expect(JSON.stringify(result)).not.toContain('NONFUNCTIONAL_PRIVATE_KEY_PLACEHOLDER');
  });

  it('does not call an escaped or structurally plausible container an approved test key', () => {
    // A five-byte ASN.1 sequence is not a real private key.
    const source = '-----BEGIN PRIVATE KEY-----\\nMAMCAQA=\\n-----END PRIVATE KEY-----';
    expect(inspectPrivateKeySyntax(source)).toMatchObject({
      escapedNewlines: true, hasBase64Body: true, decodedBytes: 5, outerContainer: 'der-sequence',
      usableCredentialEstablished: false, cryptographicOperations: false, issuerContacted: false,
      disposition: 'unresolved-owner-review-required', changesFindingGate: false
    });
  });

  it('keeps unknown labels and malformed encodings unqualified without including input text', () => {
    const input = '-----BEGIN NONFUNCTIONAL_SENTINEL-----\nMAMCAQA\n-----END NONFUNCTIONAL_SENTINEL-----';
    const result = inspectPrivateKeySyntax(input);
    expect(result).toMatchObject({ label: 'unrecognized', hasBase64Body: false, outerContainer: 'not-established' });
    expect(JSON.stringify(result)).not.toContain('NONFUNCTIONAL_SENTINEL');
    expect(() => inspectPrivateKeySyntax('x'.repeat(16_385))).toThrow('private-key-triage-input-bound');
  });
});
