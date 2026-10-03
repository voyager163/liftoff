import { stripVTControlCharacters } from 'node:util';
import { assertSafeControlRecord } from '../domain/governance/activation/source-values.js';

function historyDiagnosticText(text: string): string {
  const plain = stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '');
  return plain.length > 4096 ? `${plain.slice(0, 4080)} [truncated]` : plain;
}

export class ActivationHistoryError extends Error {
  constructor(
    public readonly code: string,
    public readonly location: string,
    detail: string
  ) {
    super(`${historyDiagnosticText(location)}: ${historyDiagnosticText(detail)}`);
    this.location = historyDiagnosticText(location);
    this.name = 'ActivationHistoryError';
  }
}

export function historyFail(location: string, detail: string, code = 'invalid-history-record'): never {
  throw new ActivationHistoryError(code, location, detail);
}

/** Reject rather than redact: redacted bytes cannot be called an immutable source snapshot. */
export function assertSafeHistoricalRecord(value: unknown, label: string): void {
  const fail = () => historyFail(label,
    'historical preservation is blocked by prohibited sensitive content or an unsafe payload; source bytes were not copied or modified.',
    'unsafe-historical-payload');
  assertSafeControlRecord(value, fail);
}

export function assertSafeHistoricalBytes(content: Buffer, label: string): void {
  if (content.length > 8 * 1024 * 1024) {
    historyFail(label, 'historical record exceeds the bounded metadata preservation size.', 'unsafe-historical-payload');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    historyFail(label, 'historical metadata must be UTF-8 text; binary payloads were not copied.', 'unsafe-historical-payload');
  }
  if (text.includes('\u0000')) historyFail(label, 'binary payloads are not historical control metadata.', 'unsafe-historical-payload');
  assertSafeHistoricalRecord(text, label);
}
