import { createHash } from 'node:crypto';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { FileSystemError } from '../../domain/project/errors.js';
import { validateArtifactPathParts } from '../../domain/project/paths.js';
import {
  reviewedRepairTransactionPathParts, reviewedUpdateTransactionPathParts,
  localVerificationTransactionPathParts, localVerificationTransactionSchemaVersion,
  type ReviewedTransactionKind
} from '../../domain/project/reviewed-update-artifacts.js';
import {
  repairSchemaVersions, validateRepairExecutionIdentity, type RepairExecutionIdentity
} from '../../domain/repair/identity.js';
import type { ProjectFileMutation, ProjectFileSnapshot } from './project-transaction.js';

export const reviewedJournalLimits = Object.freeze({
  mutations: 1024, suppliedPreconditions: 4096,
  fileBytes: 8 * 1024 * 1024, snapshotBytes: 16 * 1024 * 1024, journalBytes: 32 * 1024 * 1024,
  missingDirectories: 1024 * 64 + 1
});

export type StoredSnapshot =
  | { kind: 'missing' }
  | { kind: 'file'; bytes: string; sha256: string; mode: number };

export interface StoredMutation {
  type: 'write' | 'delete';
  pathParts: string[];
  original: StoredSnapshot;
  target: StoredSnapshot;
  mode?: number;
}

export interface CapturedJournalPrecondition {
  pathParts: string[];
  stored: StoredSnapshot;
}

export type CapturedJournalMutation =
  | Extract<ProjectFileMutation, { type: 'delete' }>
  | (Omit<Extract<ProjectFileMutation, { type: 'write' }>, 'content'> & { content: Buffer });

export interface JournalBody {
  schemaVersion: 1 | 2 | 3;
  transactionKind?: ReviewedTransactionKind;
  repairIdentity?: RepairExecutionIdentity;
  projectRoot: string;
  planFingerprint: string;
  nonce: string;
  mutations: StoredMutation[];
  missingDirectories: string[][];
}

export interface JournalHeader extends JournalBody {
  transactionDigest: string;
}

export type JournalPayload = Omit<JournalBody, 'planFingerprint' | 'nonce'>;
export type JournalFrame = { phase: 'mutation'; index: number } | { phase: 'committed' };
export interface JournalSize {
  readonly kind: 'journal' | 'no-journal';
  readonly mutationCount: number;
  readonly suppliedPreconditionCount: number;
  readonly snapshotBytes: number;
  readonly headerBytes: number;
  readonly mutationFrameBytes: number;
  readonly commitFrameBytes: number;
  readonly completeJournalBytes: number;
}

const envelope = {
  planFingerprint: { width: 64, pattern: /^[a-f0-9]{64}$/ },
  nonce: { width: 36, pattern: /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/ },
  transactionDigest: { width: 64, pattern: /^[a-f0-9]{64}$/ }
} as const;
const key = (parts: readonly string[]) => parts.join('/');
const folded = (value: string) => value.normalize('NFC').toLowerCase();
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function fail(message: string): never {
  throw new FileSystemError(`Reviewed update transaction: ${message}`);
}

export function exactJournalKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((entry) => {
      const field = Object.getOwnPropertyDescriptor(value, entry);
      return !field?.enumerable || !Object.hasOwn(field, 'value');
    })) fail('malformed recovery journal fields.');
}

function array(value: unknown, maximum: number, message: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1) fail(message);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) fail(message);
    result.push(field.value);
  }
  return result;
}

export function journalPathParts(value: unknown): string[] {
  const input = Array.isArray(value) ? array(value, 64, 'a path is too long or contains non-portable characters.') : value;
  const parts = validateArtifactPathParts(input, 'Reviewed update path');
  if (parts.length > 64 || key(parts).length > 2048 ||
    parts.some((part) => part.length > 255 || /[<>:"|?*\u0000-\u001f\u007f]/u.test(part))) {
    fail('a path is too long or contains non-portable characters.');
  }
  return parts;
}

function envelopeValue(value: unknown, field: keyof typeof envelope): string {
  if (typeof value !== 'string' || !envelope[field].pattern.test(value)) {
    if (field === 'nonce') fail('unsupported, wrong-project, or oversized recovery journal.');
    fail('expected a full lowercase SHA-256 digest.');
  }
  return value;
}

export function assertJournalDigest(value: unknown): asserts value is string {
  envelopeValue(value, 'planFingerprint');
}

export function assertJournalMode(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 0 || value > 0o7777) fail('invalid snapshot mode.');
}

export function journalTargetMode(mode: number | undefined, originalMode: number | undefined, platform: NodeJS.Platform): number {
  if (mode === undefined) return originalMode ?? (platform === 'win32' ? 0o666 : 0o600);
  return platform === 'win32' ? (mode & 0o200 ? 0o666 : 0o444) : mode;
}

function bufferInput(value: unknown): asserts value is Buffer {
  if (!Buffer.isBuffer(value) || Object.getPrototypeOf(value) !== Buffer.prototype ||
    ['length', 'buffer', 'byteOffset', 'byteLength'].some((field) => Object.hasOwn(value, field))) {
    fail('invalid or oversized snapshot bytes.');
  }
}

function copyBytes(value: Buffer): Buffer {
  const bytes = Buffer.alloc(value.length);
  Uint8Array.prototype.set.call(bytes, value);
  return bytes;
}

export function storeJournalSnapshot(snapshot: ProjectFileSnapshot): StoredSnapshot {
  if (!isRecord(snapshot)) fail('malformed recovery journal fields.');
  const fields = ['pathParts', ...Object.hasOwn(snapshot, 'content') ? ['content'] : [], ...Object.hasOwn(snapshot, 'mode') ? ['mode'] : []];
  exactJournalKeys(snapshot, fields);
  if (snapshot.content === undefined) {
    if (snapshot.mode !== undefined) fail('a missing snapshot cannot have a mode.');
    return { kind: 'missing' };
  }
  bufferInput(snapshot.content);
  if (snapshot.content.length > reviewedJournalLimits.fileBytes) fail('invalid or oversized snapshot bytes.');
  const content = copyBytes(snapshot.content);
  assertJournalMode(snapshot.mode);
  return { kind: 'file', bytes: content.toString('base64'), sha256: hash(content), mode: snapshot.mode };
}

export function parseJournalSnapshot(value: unknown): StoredSnapshot {
  exactJournalKeys(value, ['kind', ...isRecord(value) && Object.getOwnPropertyDescriptor(value, 'kind')?.value === 'missing'
    ? [] : ['bytes', 'sha256', 'mode']]);
  if (value.kind === 'missing') return { kind: 'missing' };
  assertJournalMode(value.mode);
  assertJournalDigest(value.sha256);
  if (value.kind !== 'file' || typeof value.bytes !== 'string' ||
    value.bytes.length > Math.ceil(reviewedJournalLimits.fileBytes / 3) * 4) fail('invalid stored file snapshot.');
  const bytes = Buffer.from(value.bytes, 'base64');
  if (bytes.length > reviewedJournalLimits.fileBytes || bytes.toString('base64') !== value.bytes || hash(bytes) !== value.sha256) {
    fail('stored snapshot digest or encoding does not match its exact bytes.');
  }
  return { kind: 'file', bytes: value.bytes, sha256: value.sha256, mode: value.mode };
}

export function captureJournalPreconditions(value: readonly ProjectFileSnapshot[] = []): CapturedJournalPrecondition[] {
  const seen = new Set<string>();
  return array(value, reviewedJournalLimits.suppliedPreconditions, 'too many preconditions.').map((raw) => {
    if (!isRecord(raw)) fail('malformed recovery journal fields.');
    exactJournalKeys(raw, ['pathParts', ...Object.hasOwn(raw, 'content') ? ['content'] : [], ...Object.hasOwn(raw, 'mode') ? ['mode'] : []]);
    const pathParts = journalPathParts(raw.pathParts);
    const identity = folded(key(pathParts));
    if (seen.has(identity)) fail(`duplicate or case-colliding preconditions: ${key(pathParts)}.`);
    seen.add(identity);
    const snapshot: ProjectFileSnapshot = { pathParts };
    if (raw.content !== undefined) {
      bufferInput(raw.content);
      snapshot.content = raw.content;
    }
    if (raw.mode !== undefined) {
      assertJournalMode(raw.mode);
      snapshot.mode = raw.mode;
    }
    return { pathParts, stored: storeJournalSnapshot(snapshot) };
  });
}

export function captureJournalMutations(value: readonly ProjectFileMutation[]): CapturedJournalMutation[] {
  return array(value, reviewedJournalLimits.mutations, 'invalid or oversized mutation inventory.').map((raw) => {
    if (!isRecord(raw)) fail('malformed recovery journal fields.');
    const type = Object.getOwnPropertyDescriptor(raw, 'type')?.value;
    exactJournalKeys(raw, type === 'write'
      ? ['type', 'pathParts', 'content', ...Object.hasOwn(raw, 'mode') ? ['mode'] : []] : ['type', 'pathParts']);
    const pathParts = journalPathParts(raw.pathParts);
    if (raw.type === 'delete') return { type: 'delete', pathParts };
    if (raw.type !== 'write' || typeof raw.content !== 'string' && !Buffer.isBuffer(raw.content)) fail('invalid mutation type or bytes.');
    if (raw.mode !== undefined) assertJournalMode(raw.mode);
    if (typeof raw.content !== 'string') bufferInput(raw.content);
    const content = typeof raw.content === 'string' ? Buffer.from(raw.content, 'utf8') : copyBytes(raw.content);
    return { type: 'write', pathParts, content, ...raw.mode === undefined ? {} : { mode: raw.mode } };
  });
}

export function captureJournalRepairIdentity(value: unknown): RepairExecutionIdentity {
  exactJournalKeys(value, ['cliVersion', 'repairContractVersion', 'recipe']);
  exactJournalKeys(value.recipe, ['id', 'version', 'sourceLayouts', 'targetLayout']);
  const recipe = {
    id: value.recipe.id, version: value.recipe.version, targetLayout: value.recipe.targetLayout,
    sourceLayouts: array(value.recipe.sourceLayouts, 1024, 'invalid repair source layouts.')
  };
  if (typeof value.cliVersion !== 'string' || typeof value.repairContractVersion !== 'number' ||
    typeof recipe.id !== 'string' || typeof recipe.version !== 'number' || typeof recipe.targetLayout !== 'string' ||
    recipe.sourceLayouts.some((entry) => typeof entry !== 'string')) fail('malformed recovery journal fields.');
  return structuredClone(validateRepairExecutionIdentity({ ...value, recipe }));
}

export function validateJournalPaths(paths: readonly string[][]): void {
  const files = new Set<string>();
  const spelling = new Map<string, string>();
  for (const parts of [...paths, reviewedUpdateTransactionPathParts, reviewedRepairTransactionPathParts, localVerificationTransactionPathParts]) {
    for (let count = 1; count <= parts.length; count++) {
      const prefix = key(parts.slice(0, count));
      const identity = folded(prefix);
      const prior = spelling.get(identity);
      if (prior !== undefined && prior !== prefix) fail(`case-colliding inventory path: ${prefix}.`);
      if (count < parts.length && files.has(identity)) fail(`file/directory inventory collision: ${prefix}.`);
      spelling.set(identity, prefix);
    }
    const identity = folded(key(parts));
    if (files.has(identity) || [...spelling.keys()].some((name) => name.startsWith(`${identity}/`))) {
      fail(`duplicate or overlapping mutation: ${key(parts)}.`);
    }
    files.add(identity);
  }
}

export function validateJournalInventory(mutations: readonly StoredMutation[]): number {
  validateJournalPaths(mutations.map((entry) => entry.pathParts));
  const size = mutations.reduce((sum, mutation) => sum +
    (mutation.original.kind === 'file' ? Buffer.byteLength(mutation.original.bytes, 'base64') : 0) +
    (mutation.target.kind === 'file' ? Buffer.byteLength(mutation.target.bytes, 'base64') : 0), 0);
  if (size > reviewedJournalLimits.snapshotBytes) fail('transaction snapshots exceed the bounded size limit.');
  return size;
}

function payloadFields(value: unknown): string[] {
  return ['schemaVersion', 'projectRoot', 'mutations', 'missingDirectories',
    ...isRecord(value) && Object.hasOwn(value, 'transactionKind') ? ['transactionKind'] : [],
    ...isRecord(value) && Object.hasOwn(value, 'repairIdentity') ? ['repairIdentity'] : []];
}

function parsePayload(value: unknown, platform: NodeJS.Platform): JournalPayload {
  exactJournalKeys(value, payloadFields(value));
  const hasKind = Object.hasOwn(value, 'transactionKind');
  const kind = hasKind ? value.transactionKind : 'update';
  if (kind !== 'update' && kind !== 'repair' && kind !== 'local-verification') fail('unregistered transaction kind.');
  const hasRepairIdentity = Object.hasOwn(value, 'repairIdentity');
  let repairIdentity: RepairExecutionIdentity | undefined;
  if (kind === 'local-verification') {
    if (value.schemaVersion !== localVerificationTransactionSchemaVersion || hasRepairIdentity) {
      fail('local-verification requires schema 3 without repair identity.');
    }
  } else if (kind === 'repair' && value.schemaVersion === repairSchemaVersions.journal) {
    repairIdentity = captureJournalRepairIdentity(value.repairIdentity);
  } else if (value.schemaVersion !== 1 || hasRepairIdentity) {
    fail(`unsupported ${kind} journal schema/identity; supported ${kind === 'repair' ? 'sealed legacy schema 1 or repair schema 2 with contract 1 and a registered recipe' : 'update schema 1 without repair identity'}. Use a CLI supporting the original record; do not rewrite it.`);
  }
  if (typeof value.projectRoot !== 'string' || value.projectRoot.length === 0) fail('unsupported, wrong-project, or oversized recovery journal.');
  const mutations = array(value.mutations, reviewedJournalLimits.mutations, 'unsupported, wrong-project, or oversized recovery journal.').map((raw): StoredMutation => {
    if (!isRecord(raw)) fail('malformed recovery journal fields.');
    const hasMode = Object.hasOwn(raw, 'mode');
    exactJournalKeys(raw, ['type', 'pathParts', 'original', 'target', ...hasMode ? ['mode'] : []]);
    if (hasMode) assertJournalMode(raw.mode);
    const original = parseJournalSnapshot(raw.original);
    const target = parseJournalSnapshot(raw.target);
    if (raw.type !== 'write' && raw.type !== 'delete' ||
      raw.type === 'write' && target.kind !== 'file' || raw.type === 'delete' && target.kind !== 'missing') {
      fail('invalid serialized mutation type or target.');
    }
    const mode = hasMode ? raw.mode : undefined;
    if (mode !== undefined) assertJournalMode(mode);
    if (raw.type === 'delete' && hasMode ||
      target.kind === 'file' && target.mode !== journalTargetMode(mode, original.kind === 'file' ? original.mode : undefined, platform)) {
      fail('stored target mode does not match its approved mutation.');
    }
    return { type: raw.type, pathParts: journalPathParts(raw.pathParts), original, target,
      ...mode === undefined ? {} : { mode } };
  });
  validateJournalInventory(mutations);
  const missingDirectories = array(value.missingDirectories, reviewedJournalLimits.missingDirectories,
    'unsupported, wrong-project, or oversized recovery journal.').map(journalPathParts);
  const seen = new Set<string>();
  for (const parts of missingDirectories) {
    const name = key(parts);
    if (seen.has(folded(name)) || name !== '.liftoff' && !mutations.some((entry) =>
      entry.type === 'write' && key(entry.pathParts).startsWith(`${name}/`))) fail('invalid or duplicate directory cleanup inventory.');
    if (mutations.some((entry) => entry.original.kind === 'file' && key(entry.pathParts).startsWith(`${name}/`))) {
      fail('an original file cannot have an originally missing parent.');
    }
    seen.add(folded(name));
  }
  return { schemaVersion: kind === 'local-verification' ? localVerificationTransactionSchemaVersion
    : repairIdentity ? repairSchemaVersions.journal : 1, projectRoot: value.projectRoot,
    ...hasKind ? { transactionKind: kind } : {}, ...repairIdentity ? { repairIdentity } : {}, mutations, missingDirectories };
}

export function parseReviewedJournalHeader(value: unknown, root: string, kind: ReviewedTransactionKind, platform: NodeJS.Platform): JournalHeader {
  exactJournalKeys(value, [...payloadFields(value), 'planFingerprint', 'nonce', 'transactionDigest']);
  if ((Object.hasOwn(value, 'transactionKind') ? value.transactionKind : 'update') !== kind) {
    fail('recovery journal transaction kind does not match its registered path.');
  }
  const planFingerprint = envelopeValue(value.planFingerprint, 'planFingerprint');
  const transactionDigest = envelopeValue(value.transactionDigest, 'transactionDigest');
  const nonce = envelopeValue(value.nonce, 'nonce');
  if (value.projectRoot !== root) fail('unsupported, wrong-project, or oversized recovery journal.');
  const { planFingerprint: _plan, nonce: _nonce, transactionDigest: _digest, ...fields } = value;
  const payload = parsePayload(fields, platform);
  if (!payload.mutations.length) fail('unsupported, wrong-project, or oversized recovery journal.');
  const body: JournalBody = { ...payload, planFingerprint, nonce };
  if (canonicalSha256(body) !== transactionDigest) fail('transaction digest does not match the journal.');
  return { ...body, transactionDigest };
}

export function encodeReviewedJournalFrame(value: JournalFrame): Buffer {
  if (!isRecord(value)) fail('malformed recovery journal fields.');
  const phase = Object.getOwnPropertyDescriptor(value, 'phase')?.value;
  exactJournalKeys(value, phase === 'mutation' ? ['phase', 'index'] : ['phase']);
  if (value.phase === 'mutation') {
    if (!Number.isInteger(value.index) || value.index < 0 || value.index >= reviewedJournalLimits.mutations) fail('invalid mutation checkpoint.');
  } else if (value.phase !== 'committed') fail('invalid commit checkpoint.');
  return Buffer.from(canonicalJson(value), 'utf8');
}

function measurePayload(payload: JournalPayload, suppliedPreconditionCount: number): JournalSize {
  const mutationCount = payload.mutations.length;
  const snapshotBytes = validateJournalInventory(payload.mutations);
  if (!mutationCount) {
    return { kind: 'no-journal', mutationCount, suppliedPreconditionCount, snapshotBytes,
      headerBytes: 0, mutationFrameBytes: 0, commitFrameBytes: 0, completeJournalBytes: 0 };
  }
  // Count only protocol-fixed envelope widths; never construct stand-in values.
  const envelopeBytes = Object.entries(envelope).reduce((sum, [field, rule]) =>
    sum + 1 + Buffer.byteLength(canonicalJson(field), 'utf8') - 1 + 1 + 2 + rule.width, 0);
  const headerBytes = Buffer.byteLength(canonicalJson(payload), 'utf8') + envelopeBytes;
  let mutationFrameBytes = 0;
  for (let index = 0; index < mutationCount; index++) {
    mutationFrameBytes += encodeReviewedJournalFrame({ phase: 'mutation', index }).length;
  }
  const commitFrameBytes = encodeReviewedJournalFrame({ phase: 'committed' }).length;
  const completeJournalBytes = headerBytes + mutationFrameBytes + commitFrameBytes;
  if (completeJournalBytes > reviewedJournalLimits.journalBytes) fail('complete forward journal exceeds the bounded size limit.');
  return { kind: 'journal', mutationCount, suppliedPreconditionCount, snapshotBytes,
    headerBytes, mutationFrameBytes, commitFrameBytes, completeJournalBytes };
}

export function measureReviewedJournal(
  value: JournalPayload,
  suppliedPreconditions: readonly CapturedJournalPrecondition[],
  platform: NodeJS.Platform
): JournalSize {
  const supplied = array(suppliedPreconditions, reviewedJournalLimits.suppliedPreconditions, 'too many preconditions.');
  const payload = parsePayload(value, platform);
  const conditions = new Map<string, CapturedJournalPrecondition>();
  for (const entry of supplied) {
    exactJournalKeys(entry, ['pathParts', 'stored']);
    const parts = journalPathParts(entry.pathParts);
    const identity = folded(key(parts));
    if (conditions.has(identity)) fail(`duplicate or case-colliding preconditions: ${key(parts)}.`);
    conditions.set(identity, { pathParts: parts, stored: parseJournalSnapshot(entry.stored) });
  }
  for (const mutation of payload.mutations) {
    const identity = folded(key(mutation.pathParts));
    const previous = conditions.get(identity);
    if (previous && key(previous.pathParts) !== key(mutation.pathParts)) fail('case-colliding source and destination.');
    if (previous && canonicalSha256(previous.stored) !== canonicalSha256(mutation.original)) {
      fail('mutation original differs from its supplied precondition.');
    }
    conditions.set(identity, { pathParts: mutation.pathParts, stored: mutation.original });
  }
  validateJournalPaths([...conditions.values()].map((entry) => entry.pathParts));
  return measurePayload(payload, supplied.length);
}

export function encodeReviewedJournalHeader(value: JournalBody, platform: NodeJS.Platform): { header: JournalHeader; content: Buffer } {
  exactJournalKeys(value, [...payloadFields(value), 'planFingerprint', 'nonce']);
  const planFingerprint = envelopeValue(value.planFingerprint, 'planFingerprint');
  const nonce = envelopeValue(value.nonce, 'nonce');
  const { planFingerprint: _plan, nonce: _nonce, ...fields } = value;
  const payload = parsePayload(fields, platform);
  const size = measurePayload(payload, 0);
  if (size.kind === 'no-journal') fail('an empty transaction has no journal to encode.');
  const body: JournalBody = { ...payload, planFingerprint, nonce };
  const header = { ...body, transactionDigest: canonicalSha256(body) };
  envelopeValue(header.transactionDigest, 'transactionDigest');
  const content = Buffer.from(canonicalJson(header), 'utf8');
  if (content.length !== size.headerBytes) fail('encoded journal header differs from its exact measured size.');
  return { header, content };
}
