import { stripVTControlCharacters } from 'node:util';
import { detectCredentialLeaks } from '../governance-activation/credentials.js';
import type { JsonValue, Observation, ObservationSource } from './types.js';
import { canonicalSha256 } from '../governance-activation/canonical-json.js';

const sensitiveText = [
  /\b(?:bearer|basic)\s+[a-z0-9+/_.=-]+/iu,
  /\b(?:password|passwd|client[_-]?secret|access[_-]?token|api[_-]?key|token|secret|signature|sig)\s*["']?\s*[:=]\s*["']?[^;\s"'<>]+/iu,
  /\bnpm_[a-z0-9]{20,}/iu,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/iu,
  /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/iu
];

export function containsSensitiveText(text: string): boolean {
  return detectCredentialLeaks([{ source: 'process-log', label: 'assessment', text }]).status === 'compromised' ||
    sensitiveText.some((pattern) => pattern.test(text));
}

export function sanitizeAssessmentText(text: string, limit = 2048): string {
  const plain = stripVTControlCharacters(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '').trim();
  if (containsSensitiveText(plain)) return '[withheld: sensitive content]';
  return plain.length > limit ? `${plain.slice(0, limit - 12)} [truncated]` : plain;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function jsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 12) throw new Error('Assessment value exceeds nesting limit.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry, depth + 1)]));
  }
  throw new Error('Assessment values must be JSON data.');
}

export function notObserved(reason: string, source: ObservationSource | null = null): Observation {
  return { availability: 'not-observed', value: null, source, reason: sanitizeAssessmentText(reason) };
}

export function observed(value: JsonValue, source: ObservationSource): Observation {
  if (containsSensitiveText(JSON.stringify(value)) || containsSensitiveText(source.location)) {
    return notObserved('Observation withheld because sensitive content was detected.');
  }
  return { availability: 'observed', value, source, reason: null };
}

export function source(
  kind: ObservationSource['kind'],
  location: string,
  capturedAt: string,
  content?: JsonValue,
  revision: string | null = null,
  line: number | null = null
): ObservationSource {
  return {
    kind, location: sanitizeAssessmentText(location), capturedAt,
    digest: content === undefined ? null : canonicalSha256(content),
    revision, line
  };
}
