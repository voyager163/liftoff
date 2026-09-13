import type { WorkstationRequirementId } from '../../workstation-catalog.js';

const NUMBER = '(?:0|[1-9][0-9]*)';
const CORE = `${NUMBER}\\.${NUMBER}(?:\\.${NUMBER})?`;
const IDENTIFIER = '[0-9A-Za-z-]+';
const VERSION = new RegExp(
  `^${CORE}(?:-${IDENTIFIER}(?:\\.${IDENTIFIER})*|(?:a|b|rc|alpha|beta|dev)[0-9]+)?` +
  `(?:\\+${IDENTIFIER}(?:\\.${IDENTIFIER})*)?$`
);
const TOKEN = '([0-9][0-9A-Za-z.+-]*)';
const MAX_VERSION_OUTPUT = 16_384;

function validatedToken(value: string, punctuation = false): string | undefined {
  const token = punctuation && value.endsWith('.') ? value.slice(0, -1) : value;
  if (token.length > 128 || !VERSION.test(token)) return undefined;
  const prerelease = token.split('+', 1)[0]!.match(/^[0-9.]+-(.+)$/)?.[1];
  if (prerelease?.split('.').some((part) => /^0[0-9]+$/.test(part))) return undefined;
  return token;
}

const labelledFormats: Partial<Record<WorkstationRequirementId, RegExp[]>> = {
  node: [new RegExp(`^Node(?:\\.js)?(?: version)?\\s+v?${TOKEN}$`, 'i')],
  npm: [new RegExp(`^npm(?: version)?\\s+v?${TOKEN}$`, 'i')],
  python: [new RegExp(`^Python\\s+${TOKEN}$`, 'i')],
  go: [new RegExp(`^go version go${TOKEN}(?:\\s+[A-Za-z0-9_]+/[A-Za-z0-9_]+)?$`)],
  uv: [new RegExp(`^uv\\s+${TOKEN}(?:\\s+\\([^\\r\\n]*\\))?$`, 'i')],
  docker: [new RegExp(`^Docker version\\s+${TOKEN}(?:,\\s+build\\s+\\S+)?$`, 'i')],
  opentofu: [new RegExp(`^OpenTofu\\s+v?${TOKEN}$`, 'i')],
  openspec: [new RegExp(`^OpenSpec(?: CLI)?(?: version)?\\s+v?${TOKEN}$`, 'i')],
  'github-cli': [new RegExp(`^gh version\\s+${TOKEN}(?:\\s+\\([^\\r\\n]*\\))?$`, 'i')],
  'spec-kit': [
    new RegExp(`^(?:specify(?:-cli)?|Spec Kit)(?: CLI)?(?:,? version)?\\s+v?${TOKEN}$`, 'i')
  ],
  'github-copilot': [
    new RegExp(`^(?:GitHub Copilot(?: CLI)?|copilot)(?: version)?\\s+v?${TOKEN}$`, 'i')
  ],
  claude: [
    new RegExp(`^Claude(?: Code)?(?: version)?\\s+v?${TOKEN}$`, 'i'),
    new RegExp(`^v?${TOKEN}\\s+\\(Claude Code\\)$`, 'i')
  ],
  codex: [new RegExp(`^(?:codex-cli|Codex(?: CLI)?)(?: version)?\\s+v?${TOKEN}$`, 'i')]
};

const agentIds = new Set<WorkstationRequirementId>(['github-copilot', 'claude', 'codex']);

/** Only registered version lines count; update announcements and dependency versions do not. */
export function extractVersion(output: string, tool?: WorkstationRequirementId): string | undefined {
  if (output.length > MAX_VERSION_OUTPUT) return undefined;
  const text = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim();
  if (tool === 'azure-cli') {
    try {
      const value: unknown = JSON.parse(text);
      return value && typeof value === 'object' && 'azure-cli' in value &&
        typeof value['azure-cli'] === 'string'
        ? validatedToken(value['azure-cli'])
        : undefined;
    } catch {
      return undefined;
    }
  }
  const formats = tool
    ? (labelledFormats[tool] ?? []).map((format) => ({ format, punctuation: agentIds.has(tool) }))
    : Object.entries(labelledFormats).flatMap(([id, patterns]) =>
        patterns.map((format) => ({
          format,
          punctuation: id === 'github-copilot' || id === 'claude' || id === 'codex'
        }))
      );
  const versions = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const bare = trimmed.match(new RegExp(`^v?${TOKEN}$`))?.[1];
    if (bare) {
      const version = validatedToken(bare, tool === undefined || agentIds.has(tool));
      if (!version) return undefined;
      if (tool && tool !== 'go' && versionCore(version).split('.').length !== 3) return undefined;
      versions.add(version);
      continue;
    }
    for (const { format, punctuation } of formats) {
      const token = trimmed.match(format)?.[1];
      if (token === undefined) continue;
      const version = validatedToken(token, punctuation);
      if (!version) return undefined;
      if (tool && tool !== 'go' && versionCore(version).split('.').length !== 3) return undefined;
      versions.add(version);
    }
  }
  return versions.size === 1 ? [...versions][0] : undefined;
}

export function versionCore(value: string): string {
  return value.match(/^\d+\.\d+(?:\.\d+)?/)?.[0] ?? value;
}

export function isPrereleaseVersion(value: string): boolean {
  return value.split('+', 1)[0]!.slice(versionCore(value).length).length > 0;
}

export function compareVersionCores(left: string, right: string): number {
  const leftParts = versionCore(left).split('.').map(BigInt);
  const rightParts = versionCore(right).split('.').map(BigInt);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const a = leftParts[index] ?? 0n;
    const b = rightParts[index] ?? 0n;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

export function compareVersions(left: string, right: string): number {
  const core = compareVersionCores(left, right);
  if (core !== 0) return core;
  const suffix = (version: string) =>
    version.split('+', 1)[0]!.slice(versionCore(version).length).replace(/^-/, '');
  const a = suffix(left);
  const b = suffix(right);
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const leftParts = a.split('.');
  const rightParts = b.split('.');
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const l = leftParts[index];
    const r = rightParts[index];
    if (l === r) continue;
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (/^\d+$/.test(l) && /^\d+$/.test(r)) return BigInt(l) < BigInt(r) ? -1 : 1;
    if (/^\d+$/.test(l)) return -1;
    if (/^\d+$/.test(r)) return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

export function matchesReleaseLine(value: string, releaseLine: string): boolean {
  const parts = versionCore(value).split('.');
  return releaseLine.split('.').every((part, index) => parts[index] === part);
}
