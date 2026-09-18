import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

const credentialPatterns: readonly RegExp[] = [
  /\bgh[oprsu]_[A-Za-z0-9_]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/u,
  /\bAccountKey=[^;\s]+/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bnpm_[a-z0-9]{20,}/iu,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/iu,
  /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/iu
];
const sensitivePatterns: readonly RegExp[] = [
  ...credentialPatterns,
  /\b(?:bearer|basic)\s+[a-z0-9+/_.=-]+/iu,
  /\b(?:password|passwd|client[_-]?secret|access[_-]?token|api[_-]?key|token|secret|signature|sig)\s*["']?\s*[:=]\s*["']?[^;\s"'<>]+/iu
];

export function containsSensitiveText(text: string): boolean {
  return sensitivePatterns.some((pattern) => pattern.test(text));
}

export function containsSourceCredentials(text: string): boolean {
  if (credentialPatterns.some((pattern) => pattern.test(text)) ||
      /\bsk-[A-Za-z0-9_-]{20,}\b/u.test(text) ||
      /\b(?:bearer|basic)\s+[a-z0-9+/_.=-]{16,}/iu.test(text)) return true;
  const assignments = /\b(?:[a-z_][a-z0-9_]*_)?(?:password|passwd|client[_-]?secret|access[_-]?token|api[_-]?key|token|secret|authorization)\b\s*["']?(?:\s*:\s*(?:str|string|String)(?:\s*\|\s*None)?)?\s*[:=]\s*(?:Field\s*\(\s*(?:default\s*=\s*)?)?(["'])([^\r\n]*?)\1/giu;
  for (const match of text.matchAll(assignments)) {
    if (match[2]!.trim().length > 0) return true;
  }
  return false;
}

export function sanitizeText(text: string, limit = 2048): string {
  const plain = stripVTControlCharacters(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '')
    .trim();
  if (containsSensitiveText(plain)) {
    return '[withheld: sensitive content]';
  }
  return plain.length > limit ? `${plain.slice(0, limit - 12)} [truncated]` : plain;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Canonical JSON cannot encode non-finite numbers.');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalValue(entry));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => {
        const entry = value[key];
        if (entry === undefined) {
          throw new Error(`Canonical JSON cannot encode undefined field ${key}.`);
        }
        return [key, canonicalValue(entry)];
      })
    );
  }
  throw new Error(`Canonical JSON cannot encode ${typeof value}.`);
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function computeInventoryDigest(
  files: readonly { path: string; digest: string; size?: number }[]
): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const raw = sorted.map((f) => `${f.path}:${f.digest}:${f.size ?? 0}`).join('\n');
  return `sha256:${sha256Hex(raw)}`;
}
