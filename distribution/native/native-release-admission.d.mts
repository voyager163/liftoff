import type { Buffer } from 'node:buffer';

export function assertNativePublicationEvidence(
  record: unknown, evidence: unknown, approvedPolicy?: unknown
): unknown;

export function verifyNativeEvidenceSignature(
  bytes: Buffer, signature: Buffer, publicKey: Buffer | string, expectedKeySha256: string
): unknown;
