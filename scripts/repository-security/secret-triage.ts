import { SecurityEvidenceError } from './evidence.ts';

/** Syntax inspection only: never imports, decrypts, signs with or validates a key. */
export function inspectPrivateKeySyntax(text: string) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16_384) {
    throw new SecurityEvidenceError('private-key-triage-input-bound');
  }
  const normalized = text.replaceAll('\\r\\n', '\n').replaceAll('\\n', '\n').trim();
  const labels = ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'DSA PRIVATE KEY',
    'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'PGP PRIVATE KEY BLOCK'];
  const matched = /^-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----$/.exec(normalized);
  const label = matched && labels.includes(matched[1]!) ? matched[1]! : 'unrecognized';
  const body = matched?.[2]?.replace(/\s/g, '') ?? '';
  const hasBase64Body = body.length > 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body);
  let outerContainer: 'der-sequence' | 'openssh-container' | 'not-established' = 'not-established';
  let decodedBytes = 0;
  if (hasBase64Body) {
    const decoded = Buffer.from(body, 'base64');
    try {
      decodedBytes = decoded.length;
      if (decoded.subarray(0, 15).equals(Buffer.from('openssh-key-v1\0'))) outerContainer = 'openssh-container';
      if (decoded[0] === 0x30 && decoded[1] !== undefined) {
        const octets = decoded[1] < 0x80 ? 0 : decoded[1] & 0x7f;
        const header = 2 + octets;
        if (octets <= 4 && header <= decoded.length && decoded[1] !== 0x80) {
          const length = octets === 0 ? decoded[1] : decoded.readUIntBE(2, octets);
          if (header + length === decoded.length) outerContainer = 'der-sequence';
        }
      }
    } finally { decoded.fill(0); }
  }
  return Object.freeze({
    kind: 'private-key-pattern-syntax-only', label, markerPair: Boolean(matched),
    escapedNewlines: text.includes('\\n'), hasBase64Body, decodedBytes, outerContainer,
    placeholderMarkers: Boolean(matched && /(?:\.\.\.|REDACTED|PLACEHOLDER|NONFUNCTIONAL)/i.test(matched[2]!)),
    usableCredentialEstablished: false, issuerContacted: false, cryptographicOperations: false,
    disposition: 'unresolved-owner-review-required', changesFindingGate: false
  });
}
