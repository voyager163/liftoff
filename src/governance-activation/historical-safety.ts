import { stripVTControlCharacters } from 'node:util';
import { isRecord } from '../domain/governance/activation/canonical-json.js';

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

const credentialText = [
  /\bgh[oprsu]_[A-Za-z0-9_]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bAccountKey=[^;\s]+/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9_.~-]{16,}/iu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/iu,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/u,
  /[?&]sig=[A-Za-z0-9%+/=]{16,}/iu
];
const sensitiveKeys = new Set([
  'password', 'passwd', 'secret', 'secretvalue', 'credentialvalue', 'tokenvalue',
  'accesstoken', 'refreshtoken', 'clientsecret', 'privatekey', 'encryptionkey',
  'accountkey', 'connectionstring', 'rawstate', 'statepayload', 'terraformstate',
  'tfstate', 'savedplan', 'planpayload', 'sensitiveplan'
]);

/** Reject rather than redact: redacted bytes cannot be called an immutable source snapshot. */
export function assertSafeHistoricalRecord(value: unknown, label: string): void {
  let nodes = 0;
  const fail = () => historyFail(label,
    'historical preservation is blocked by prohibited sensitive content or an unsafe payload; source bytes were not copied or modified.',
    'unsafe-historical-payload');
  function visit(entry: unknown, depth: number): void {
    if (++nodes > 200_000 || depth > 64) fail();
    if (typeof entry === 'string') {
      if (entry.length > 8 * 1024 * 1024 || credentialText.some((pattern) => pattern.test(entry))) fail();
      // Payloads serialized inside another JSON string are still payloads.
      let parsedJson = false;
      if (/^\s*[{[]/u.test(entry)) {
        try {
          const parsed: unknown = JSON.parse(entry);
          visit(parsed, depth + 1);
          parsedJson = true;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      if (!parsedJson && (/"(?:terraform_version|planned_values|resource_changes|prior_state)"\s*:/u.test(entry) ||
        /"serial"\s*:/u.test(entry) && /"lineage"\s*:/u.test(entry) && /"(?:resources|outputs)"\s*:/u.test(entry))) fail();
    } else if (Array.isArray(entry)) {
      entry.forEach((item) => visit(item, depth + 1));
    } else if (isRecord(entry)) {
      if ((Object.hasOwn(entry, 'serial') && Object.hasOwn(entry, 'lineage') &&
        (Object.hasOwn(entry, 'resources') || Object.hasOwn(entry, 'outputs'))) ||
        Object.hasOwn(entry, 'terraform_version') && (Object.hasOwn(entry, 'values') || Object.hasOwn(entry, 'resources')) ||
        Object.hasOwn(entry, 'planned_values') || Object.hasOwn(entry, 'resource_changes') ||
        Object.hasOwn(entry, 'prior_state') || Object.hasOwn(entry, 'root_module')) fail();
      for (const [key, item] of Object.entries(entry)) {
        const normalized = key.replace(/[-_]/gu, '').toLowerCase();
        if ((sensitiveKeys.has(normalized) || normalized === 'token' && typeof item === 'string') &&
          item !== null && item !== false && item !== '') fail();
        visit(key, depth + 1);
        visit(item, depth + 1);
      }
    }
  }
  visit(value, 0);
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
