import { createHash } from 'node:crypto';

/**
 * Contract foundation only: this module never starts a scanner, reads repository
 * content, fetches alerts, writes reports, or performs credential actions.
 *
 * A future isolated adapter must redact BEFORE producing this metadata report,
 * pipe (never inherit/tee/persist) both process streams, and enforce byte/time
 * limits while collecting them. Any stream output fails this boundary. Raw
 * Gitleaks/hosted payloads are not this report format and must never be logged.
 * Context, policy bytes and their digest must come from the trusted evaluator,
 * not from the candidate. Their provenance is the caller's separate obligation.
 */
export const SECRET_LIMITS = Object.freeze({
  jsonBytes: 2_097_152,
  policyBytes: 262_144,
  findings: 1_000,
  scopes: 256,
  commits: 50_000,
  locations: 10_000,
  maxAgeSeconds: 86_400
});

type ErrorCode =
  | 'invalid-json' | 'invalid-shape' | 'invalid-metadata' | 'limit-exceeded'
  | 'duplicate-identity' | 'identity-mismatch' | 'stale-evidence'
  | 'incomplete-scope' | 'unsafe-output' | 'scanner-failed'
  | 'missing-report' | 'invalid-disposition' | 'unapproved-exclusion';

class SecretContractError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(`Secrets contract rejected: ${code}.`);
    this.code = code;
    this.name = 'SecretContractError';
  }
}

function fail(code: ErrorCode): never {
  throw new SecretContractError(code);
}

// Never retain a parser/system exception as a cause, or interpolate its message.
function guarded<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error: unknown) {
    if (error instanceof SecretContractError) throw error;
    return fail('invalid-shape');
  }
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Strict JSON also rejects duplicate object keys, which JSON.parse overwrites. */
function json(text: unknown, maxBytes: number = SECRET_LIMITS.jsonBytes): unknown {
  if (typeof text !== 'string') return fail('invalid-json');
  if (text.length > maxBytes || Buffer.byteLength(text) > maxBytes) return fail('limit-exceeded');
  let offset = 0;
  let nodes = 0;
  const whitespace = () => { while (/[ \t\r\n]/.test(text[offset] ?? '') && offset < text.length) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '\\') { offset++; continue; }
      if (char !== '"') continue;
      let value: unknown;
      try { value = JSON.parse(text.slice(start, offset)); } catch { return fail('invalid-json'); }
      if (typeof value !== 'string') return fail('invalid-json');
      if (value.length > 512) return fail('limit-exceeded');
      if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return fail('invalid-metadata');
      return value;
    }
    return fail('invalid-json');
  };
  const value = (depth: number): unknown => {
    if (++nodes > 200_000 || depth > 24) return fail('limit-exceeded');
    whitespace();
    const char = text[offset];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      offset++;
      whitespace();
      const result: Record<string, unknown> = {};
      const items: unknown[] = [];
      const seen = new Set<string>();
      const end = char === '{' ? '}' : ']';
      if (text[offset] === end) { offset++; return char === '{' ? result : items; }
      while (offset < text.length) {
        if (char === '{') {
          if (text[offset] !== '"') return fail('invalid-json');
          const key = string();
          if (seen.has(key)) return fail('duplicate-identity');
          if (['__proto__', 'constructor', 'prototype'].includes(key)) return fail('invalid-shape');
          seen.add(key);
          whitespace();
          if (text[offset++] !== ':') return fail('invalid-json');
          result[key] = value(depth + 1);
        } else {
          items.push(value(depth + 1));
        }
        whitespace();
        if (text[offset] === end) { offset++; return char === '{' ? result : items; }
        if (text[offset++] !== ',') return fail('invalid-json');
        whitespace();
      }
      return fail('invalid-json');
    }
    for (const [token, literal] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(token, offset)) { offset += token.length; return literal; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(offset));
    if (!number) return fail('invalid-json');
    offset += number[0].length;
    const parsed = Number(number[0]);
    if (!Number.isFinite(parsed)) return fail('invalid-metadata');
    return parsed;
  };
  const parsed = value(0);
  whitespace();
  if (offset !== text.length) return fail('invalid-json');
  return parsed;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('invalid-shape');
  const entries = Object.entries(value);
  if (entries.length !== keys.length || entries.some(([key]) => !keys.includes(key))) return fail('invalid-shape');
  return Object.fromEntries(entries);
}

function list<T>(value: unknown, max: number, parse: (item: unknown) => T, nonempty = false): T[] {
  if (!Array.isArray(value)) return fail('invalid-shape');
  if (value.length > max) return fail('limit-exceeded');
  if (nonempty && value.length === 0) return fail('incomplete-scope');
  return value.map(parse);
}

function text(value: unknown, pattern: RegExp, max = 512): string {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) return fail('invalid-metadata');
  return value;
}

function choice<const T extends string>(value: unknown, choices: readonly T[]): T {
  for (const item of choices) if (value === item) return item;
  return fail('invalid-metadata');
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return fail('invalid-metadata');
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return fail('invalid-metadata');
  return value;
}

const sha = (value: unknown) => text(value, /^[a-f0-9]{40}$/);
const hash = (value: unknown) => text(value, /^[a-f0-9]{64}$/);
const id = (value: unknown) => text(value, /^[a-z0-9][a-z0-9-]{0,79}$/);
const owner = (value: unknown) => text(value, /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/);
const nullableSha = (value: unknown) => value === null ? null : sha(value);

function time(value: unknown): string {
  const parsed = text(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
  const millis = Date.parse(parsed);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== parsed.replace(/(?<!\.\d{3})Z$/, '.000Z')) {
    return fail('invalid-metadata');
  }
  return new Date(millis).toISOString();
}

function ref(value: unknown): string {
  const result = text(value, /^refs\/(?:heads|tags|pull)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/);
  if (result.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
    || result.includes('..')) return fail('invalid-metadata');
  return result;
}

function pathParts(value: unknown): string[] {
  const parts = list(value, 32, part => {
    const result = text(part, /^[A-Za-z0-9_.][A-Za-z0-9_. -]{0,99}$/);
    if (result === '.' || result === '..' || /[ .]$/.test(result)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) return fail('invalid-metadata');
    return result;
  }, true);
  if (parts.join('/').length > 512) return fail('limit-exceeded');
  return parts;
}

function unique<T>(values: readonly T[], key: (value: T) => string): void {
  if (new Set(values.map(key)).size !== values.length) fail('duplicate-identity');
}

function identity(value: unknown) {
  const r = record(value, ['repository', 'event', 'ref', 'sourceCommit', 'baseCommit', 'workflowCommit',
    'runId', 'attempt', 'basePolicyCommit', 'basePolicyDigest', 'inventoryDigest']);
  return {
    repository: text(r.repository, /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
    event: choice(r.event, ['pull_request', 'push', 'schedule', 'release', 'workflow_dispatch']),
    ref: ref(r.ref), sourceCommit: sha(r.sourceCommit), baseCommit: nullableSha(r.baseCommit),
    workflowCommit: sha(r.workflowCommit), runId: integer(r.runId, 1), attempt: integer(r.attempt, 1),
    basePolicyCommit: sha(r.basePolicyCommit), basePolicyDigest: hash(r.basePolicyDigest),
    inventoryDigest: hash(r.inventoryDigest)
  };
}

function detector(value: unknown) {
  const r = record(value, ['name', 'version', 'binaryDigest', 'configDigest']);
  return {
    name: choice(r.name, ['gitleaks']),
    version: text(r.version, /^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})$/),
    binaryDigest: hash(r.binaryDigest), configDigest: hash(r.configDigest)
  };
}

type Selector = ReturnType<typeof selector>;
function selector(value: unknown) {
  const r = record(value, ['ruleId', 'pathParts', 'line', 'column', 'endLine', 'endColumn', 'commit']);
  const identity = { ruleId: id(r.ruleId), pathParts: pathParts(r.pathParts), commit: sha(r.commit) };
  if ([r.line, r.column, r.endLine, r.endColumn].every(value => value === null)) {
    return { ...identity, line: null, column: null, endLine: null, endColumn: null };
  }
  const result = {
    ...identity,
    line: integer(r.line, 1, 10_000_000), column: integer(r.column, 1, 10_000_000),
    endLine: integer(r.endLine, 1, 10_000_000), endColumn: integer(r.endColumn, 1, 10_000_000)
  };
  if (result.endLine < result.line || (result.endLine === result.line && result.endColumn < result.column)) fail('invalid-metadata');
  return result;
}

function selectorKey(value: Selector): string {
  return JSON.stringify([value.ruleId, value.pathParts, value.line, value.column, value.endLine, value.endColumn, value.commit]);
}

type Scope = ReturnType<typeof scope>;
function scope(value: unknown) {
  const r = record(value, ['id', 'kind', 'ref', 'revision', 'baseRevision', 'commits']);
  const result = {
    id: id(r.id), kind: choice(r.kind, ['current-tree', 'reachable-history', 'introduced-history']),
    ref: ref(r.ref), revision: sha(r.revision), baseRevision: nullableSha(r.baseRevision),
    commits: list(r.commits, SECRET_LIMITS.commits, sha, true).sort()
  };
  unique(result.commits, commit => commit);
  if (!result.commits.includes(result.revision)) fail('incomplete-scope');
  if (result.kind === 'current-tree' && result.commits.length !== 1) fail('incomplete-scope');
  if (result.kind === 'introduced-history') {
    if (result.baseRevision === null || result.commits.includes(result.baseRevision)) fail('incomplete-scope');
  } else if (result.baseRevision !== null) fail('invalid-metadata');
  return result;
}

function context(value: unknown) {
  const r = record(value, ['schemaVersion', 'identity', 'mode', 'observedAt', 'now',
    'maxAgeSeconds', 'policyDigest', 'scopes', 'locations']);
  if (r.schemaVersion !== 1) fail('invalid-shape');
  const result = {
    identity: identity(r.identity), mode: choice(r.mode, ['full', 'intake']),
    observedAt: time(r.observedAt), now: time(r.now),
    maxAgeSeconds: integer(r.maxAgeSeconds, 1, SECRET_LIMITS.maxAgeSeconds),
    policyDigest: hash(r.policyDigest), scopes: list(r.scopes, SECRET_LIMITS.scopes, scope, true),
    locations: list(r.locations, SECRET_LIMITS.locations, pathParts, true)
  };
  unique(result.scopes, item => item.id);
  unique(result.scopes, item => `${item.kind}:${item.ref}`);
  unique(result.locations, parts => parts.join('/').toLowerCase());
  if (result.scopes.reduce((sum, item) => sum + item.commits.length, 0) > SECRET_LIMITS.commits) fail('limit-exceeded');
  const trees = result.scopes.filter(item => item.kind === 'current-tree');
  if (trees.length !== 1 || trees[0]?.revision !== result.identity.sourceCommit || trees[0].ref !== result.identity.ref) {
    fail('incomplete-scope');
  }
  if (result.mode === 'intake') {
    const introduced = result.scopes.filter(item => item.kind === 'introduced-history');
    if (result.identity.event !== 'pull_request' || result.identity.baseCommit === null || introduced.length !== 1
      || introduced[0]?.revision !== result.identity.sourceCommit || introduced[0].baseRevision !== result.identity.baseCommit
      || introduced[0].ref !== result.identity.ref) fail('incomplete-scope');
  } else if (result.identity.event === 'pull_request' || !result.scopes.some(item => item.kind === 'reachable-history')
    || result.scopes.some(item => item.kind === 'introduced-history')) fail('incomplete-scope');
  if (Date.parse(result.observedAt) > Date.parse(result.now)
    || Date.parse(result.now) - Date.parse(result.observedAt) > result.maxAgeSeconds * 1_000) fail('stale-evidence');
  return result;
}
type Context = ReturnType<typeof context>;

const states = ['unresolved', 'confirmed-awaiting-remediation', 'false-positive', 'nonfunctional-fixture', 'remediated'] as const;
export type SecretDispositionState = typeof states[number];

function disposition(value: unknown, expected: Context) {
  const r = record(value, ['finding', 'state', 'owner', 'rationale', 'approval', 'remediation']);
  const state = choice(r.state, states);
  const rationales = {
    unresolved: 'awaiting-triage',
    'confirmed-awaiting-remediation': 'credential-exposure-confirmed',
    'false-positive': 'pattern-is-not-a-credential',
    'nonfunctional-fixture': 'documented-nonfunctional-fixture',
    remediated: 'owner-verified-invalidation'
  } as const;
  // The approval evidence digest references the review/rationale; the public
  // rationale is a code, not free text that could accidentally contain a match.
  const rationale = choice(r.rationale, [rationales[state]]);
  const finding = selector(r.finding);
  const credentialOwner = owner(r.owner);
  const a = record(r.approval, ['owner', 'approvedAt', 'basePolicyCommit', 'basePolicyDigest', 'evidenceDigest']);
  const approval = {
    owner: owner(a.owner), approvedAt: time(a.approvedAt),
    basePolicyCommit: sha(a.basePolicyCommit), basePolicyDigest: hash(a.basePolicyDigest), evidenceDigest: hash(a.evidenceDigest)
  };
  if (approval.basePolicyCommit !== expected.identity.basePolicyCommit
    || approval.basePolicyDigest !== expected.identity.basePolicyDigest) fail('identity-mismatch');
  if (Date.parse(approval.approvedAt) > Date.parse(expected.now)) fail('stale-evidence');
  let remediation: {
    method: 'revoked' | 'rotated'; credentialOwner: string; authorizedBy: string; authorizedAt: string;
    completedAt: string; authorizationDigest: string; evidenceDigest: string;
    sourceCommit: string; sourceCheckedAt: string; sourceEvidenceDigest: string;
  } | null = null;
  if (state === 'remediated') {
    const m = record(r.remediation, ['method', 'credentialOwner', 'authorizedBy', 'authorizedAt', 'completedAt',
      'authorizationDigest', 'evidenceDigest', 'sourceCommit', 'sourceCheckedAt', 'sourceEvidenceDigest']);
    remediation = {
      method: choice(m.method, ['revoked', 'rotated']), credentialOwner: owner(m.credentialOwner),
      authorizedBy: owner(m.authorizedBy), authorizedAt: time(m.authorizedAt), completedAt: time(m.completedAt),
      authorizationDigest: hash(m.authorizationDigest), evidenceDigest: hash(m.evidenceDigest),
      sourceCommit: sha(m.sourceCommit), sourceCheckedAt: time(m.sourceCheckedAt), sourceEvidenceDigest: hash(m.sourceEvidenceDigest)
    };
    if (remediation.credentialOwner !== credentialOwner || remediation.authorizedBy !== credentialOwner) fail('invalid-disposition');
    if (Date.parse(remediation.authorizedAt) > Date.parse(remediation.completedAt)
      || Date.parse(remediation.completedAt) > Date.parse(approval.approvedAt)
      || Date.parse(remediation.sourceCheckedAt) < Date.parse(remediation.completedAt)
      || Date.parse(remediation.sourceCheckedAt) > Date.parse(approval.approvedAt)) fail('invalid-disposition');
    if (remediation.sourceCommit !== expected.identity.sourceCommit) fail('identity-mismatch');
  } else if (r.remediation !== null) fail('invalid-disposition');
  return { finding, state, owner: credentialOwner, rationale, approval, remediation };
}

function policy(value: unknown, expected: Context) {
  const r = record(value, ['schemaVersion', 'repository', 'basePolicyCommit', 'basePolicyDigest', 'detector', 'rules', 'exclusions', 'dispositions']);
  if (r.schemaVersion !== 1) fail('invalid-shape');
  if (r.repository !== expected.identity.repository || r.basePolicyCommit !== expected.identity.basePolicyCommit
    || r.basePolicyDigest !== expected.identity.basePolicyDigest) fail('identity-mismatch');
  const result = {
    detector: detector(r.detector), rules: list(r.rules, 1_000, id, true),
    exclusions: list(r.exclusions, SECRET_LIMITS.findings, selector),
    dispositions: list(r.dispositions, SECRET_LIMITS.findings, item => disposition(item, expected))
  };
  unique(result.rules, item => item);
  unique(result.exclusions, selectorKey);
  unique(result.dispositions, item => selectorKey(item.finding));
  const commits = new Set(expected.scopes.flatMap(item => item.commits));
  const locations = new Set(expected.locations.map(item => item.join('/')));
  for (const item of [...result.exclusions, ...result.dispositions.map(entry => entry.finding)]) {
    if (!result.rules.includes(item.ruleId) || !commits.has(item.commit) || !locations.has(item.pathParts.join('/'))) fail('identity-mismatch');
  }
  for (const exclusion of result.exclusions) {
    const approved = result.dispositions.find(item => selectorKey(item.finding) === selectorKey(exclusion));
    if (!approved || !['false-positive', 'nonfunctional-fixture'].includes(approved.state)) fail('unapproved-exclusion');
  }
  return result;
}
type Policy = ReturnType<typeof policy>;

type CoverageStatus = 'complete' | 'incomplete' | 'failed' | 'skipped' | 'cancelled';
function coverage(value: unknown, expected: Scope) {
  const r = record(value, ['id', 'kind', 'ref', 'revision', 'baseRevision', 'commitCount', 'commitsDigest',
    'status', 'shallow', 'missingObjects', 'skippedInputs']);
  if (r.id !== expected.id || r.kind !== expected.kind || r.ref !== expected.ref || r.revision !== expected.revision
    || r.baseRevision !== expected.baseRevision || integer(r.commitCount) !== expected.commits.length
    || hash(r.commitsDigest) !== digest(JSON.stringify(expected.commits))) fail('identity-mismatch');
  const status: CoverageStatus = choice(r.status, ['complete', 'incomplete', 'failed', 'skipped', 'cancelled']);
  const shallow = boolean(r.shallow);
  const missingObjects = integer(r.missingObjects, 0, SECRET_LIMITS.commits);
  const skippedInputs = integer(r.skippedInputs, 0, SECRET_LIMITS.locations);
  return { status, qualified: status === 'complete' && !shallow && missingObjects === 0 && skippedInputs === 0 };
}

function finding(value: unknown, expected: Context, trusted: Policy) {
  const r = record(value, ['finding', 'scopeIds', 'currentSource']);
  const found = selector(r.finding);
  const scopeIds = list(r.scopeIds, SECRET_LIMITS.scopes, id, true).sort();
  unique(scopeIds, item => item);
  const currentSource = choice(r.currentSource, ['present', 'absent', 'unknown']);
  if (!trusted.rules.includes(found.ruleId) || !expected.locations.some(parts => parts.join('/') === found.pathParts.join('/'))) {
    fail('identity-mismatch');
  }
  for (const scopeId of scopeIds) {
    const selected = expected.scopes.find(item => item.id === scopeId);
    if (!selected || !selected.commits.includes(found.commit)) fail('identity-mismatch');
    if (selected.kind === 'current-tree' && currentSource !== 'present') fail('invalid-metadata');
  }
  const applicable = expected.scopes.filter(item => item.commits.includes(found.commit)).map(item => item.id).sort();
  if (!same(scopeIds, applicable)) fail('incomplete-scope');
  return { finding: found, scopeIds, currentSource };
}

export interface SecretCapture {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly signal: string | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  /** UTF-8 bytes of this contract's metadata, NOT a native scanner/alert payload. */
  readonly report: Uint8Array | null;
}

export interface SecretResult {
  readonly schemaVersion: 1;
  readonly assessment: 'qualified' | 'unqualified';
  readonly gate: 'passed' | 'blocked';
  readonly protection: 'not-established';
  readonly evidenceDigest: string;
  readonly policyDigest: string;
  readonly sourceCommit: string;
  readonly coverage: readonly { readonly scopeIndex: number; readonly status: CoverageStatus; readonly qualified: boolean }[];
  readonly findings: readonly {
    readonly id: string; readonly ruleIndex: number; readonly locationIndex: number;
    readonly line: number | null; readonly column: number | null;
    readonly endLine: number | null; readonly endColumn: number | null;
    readonly commit: string; readonly state: SecretDispositionState; readonly blocking: boolean;
  }[];
  readonly counts: Readonly<Record<SecretDispositionState, number>>;
}

export interface SecretProposal {
  readonly authority: 'proposal-only';
  readonly adoptionRequired: boolean;
  readonly changes: readonly ('detector' | 'rules' | 'exclusions' | 'dispositions')[];
  readonly dispositionCount: number;
}

export interface SecretsBoundary {
  assess(capture: SecretCapture): SecretResult;
  /** Policy proposals never mutate the trusted policy or approve their own hits. */
  propose(candidatePolicyJson: string): SecretProposal;
  /** Only results actually produced by this boundary can become public output. */
  serialize(result: SecretResult): string;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Public results use registry indexes + hashes, not caller/scanner text. The
 * trusted scope/location/rule registry is used privately to resolve those indexes.
 * Evidence remains an assertion until the separate producer/provenance contract
 * is qualified; this module never claims push/merge protection or real execution.
 * Approval/invalidation/source digests reference externally verified sanitized
 * records, not proof invented or fetched here. Exclusions are exact post-detection
 * dispositions: they never permit skipped inputs or omitted detections.
 */
export function createSecretsBoundary(contextJson: string, trustedPolicyJson: string): SecretsBoundary {
  return guarded(() => {
    const expected = context(json(contextJson));
    if (typeof trustedPolicyJson !== 'string' || Buffer.byteLength(trustedPolicyJson) > SECRET_LIMITS.policyBytes) fail('limit-exceeded');
    if (digest(trustedPolicyJson) !== expected.policyDigest) fail('identity-mismatch');
    const trusted = policy(json(trustedPolicyJson, SECRET_LIMITS.policyBytes), expected);
    const publicResults = new WeakMap<SecretResult, string>();
    return Object.freeze({
      assess(capture: SecretCapture): SecretResult {
        return guarded(() => {
          const c = record(capture, ['exitCode', 'timedOut', 'signal', 'stdout', 'stderr', 'report']);
          if (!(c.stdout instanceof Uint8Array) || !(c.stderr instanceof Uint8Array)) fail('invalid-shape');
          // Do not decode, hash, interpolate or retain process output, even on errors.
          if (c.stdout.byteLength !== 0 || c.stderr.byteLength !== 0) fail('unsafe-output');
          if (c.timedOut !== false || c.signal !== null || (c.exitCode !== 0 && c.exitCode !== 1)) fail('scanner-failed');
          if (!(c.report instanceof Uint8Array) || c.report.byteLength === 0) fail('missing-report');
          if (c.report.byteLength > SECRET_LIMITS.jsonBytes) fail('limit-exceeded');
          let reportText: string;
          try { reportText = new TextDecoder('utf-8', { fatal: true }).decode(c.report); } catch { return fail('invalid-json'); }
          const r = record(json(reportText), ['schemaVersion', 'identity', 'policyDigest', 'detector',
            'observedAt', 'startedAt', 'completedAt', 'coverage', 'findingCount', 'findings']);
          if (r.schemaVersion !== 1) fail('invalid-shape');
          if (!same(identity(r.identity), expected.identity) || hash(r.policyDigest) !== expected.policyDigest
            || !same(detector(r.detector), trusted.detector) || time(r.observedAt) !== expected.observedAt) fail('identity-mismatch');
          const startedAt = time(r.startedAt);
          const completedAt = time(r.completedAt);
          if (Date.parse(startedAt) < Date.parse(expected.observedAt) || Date.parse(startedAt) > Date.parse(completedAt)
            || Date.parse(completedAt) > Date.parse(expected.now)
            || Date.parse(expected.now) - Date.parse(completedAt) > expected.maxAgeSeconds * 1_000) fail('stale-evidence');
          const coverageRecords = list(r.coverage, SECRET_LIMITS.scopes, item => {
            const entry = record(item, ['id', 'kind', 'ref', 'revision', 'baseRevision', 'commitCount', 'commitsDigest',
              'status', 'shallow', 'missingObjects', 'skippedInputs']);
            const scopeIndex = expected.scopes.findIndex(selected => selected.id === entry.id);
            const selected = expected.scopes[scopeIndex];
            if (!selected) fail('identity-mismatch');
            return { scopeIndex, ...coverage(item, selected) };
          });
          unique(coverageRecords, item => String(item.scopeIndex));
          const complete = expected.scopes.map((_, scopeIndex) => coverageRecords.find(item => item.scopeIndex === scopeIndex)
            ?? { scopeIndex, status: 'incomplete' as const, qualified: false });
          const findings = list(r.findings, SECRET_LIMITS.findings, item => finding(item, expected, trusted));
          unique(findings, item => selectorKey(item.finding));
          if (integer(r.findingCount, 0, SECRET_LIMITS.findings) !== findings.length) fail('incomplete-scope');
          if ((c.exitCode === 0) !== (findings.length === 0)) fail('scanner-failed');
          const counts: Record<SecretDispositionState, number> = {
            unresolved: 0, 'confirmed-awaiting-remediation': 0, 'false-positive': 0, 'nonfunctional-fixture': 0, remediated: 0
          };
          const results = findings.map(item => {
            const approved = trusted.dispositions.find(entry => selectorKey(entry.finding) === selectorKey(item.finding));
            const state = approved?.state ?? 'unresolved';
            counts[state]++;
            const blocking = state === 'unresolved' || state === 'confirmed-awaiting-remediation'
              || (state === 'remediated' && item.currentSource !== 'absent');
            return Object.freeze({
              id: digest(selectorKey(item.finding)), ruleIndex: trusted.rules.indexOf(item.finding.ruleId),
              locationIndex: expected.locations.findIndex(parts => same(parts, item.finding.pathParts)),
              line: item.finding.line, column: item.finding.column,
              endLine: item.finding.endLine, endColumn: item.finding.endColumn,
              commit: item.finding.commit, state, blocking
            });
          });
          const qualified = complete.every(item => item.qualified);
          const result: SecretResult = Object.freeze({
            schemaVersion: 1, assessment: qualified ? 'qualified' : 'unqualified',
            gate: qualified && results.every(item => !item.blocking) ? 'passed' : 'blocked',
            protection: 'not-established',
            // Hash only the validated metadata, never the raw JSON or streams.
            evidenceDigest: digest(JSON.stringify({
              identity: expected.identity, policyDigest: expected.policyDigest, detector: trusted.detector,
              observedAt: expected.observedAt, startedAt, completedAt, complete, results
            })),
            policyDigest: expected.policyDigest, sourceCommit: expected.identity.sourceCommit,
            coverage: Object.freeze(complete.map(item => Object.freeze(item))),
            findings: Object.freeze(results), counts: Object.freeze(counts)
          });
          publicResults.set(result, JSON.stringify(result));
          return result;
        });
      },
      propose(candidatePolicyJson: string): SecretProposal {
        return guarded(() => {
          const candidate = policy(json(candidatePolicyJson, SECRET_LIMITS.policyBytes), expected);
          const changes = (['detector', 'rules', 'exclusions', 'dispositions'] as const).filter(key => !same(trusted[key], candidate[key]));
          return Object.freeze({
            authority: 'proposal-only', adoptionRequired: changes.length > 0,
            changes: Object.freeze(changes), dispositionCount: candidate.dispositions.length
          });
        });
      },
      serialize(result: SecretResult): string {
        const safe = publicResults.get(result);
        if (safe === undefined) fail('invalid-shape');
        return safe;
      }
    });
  });
}
