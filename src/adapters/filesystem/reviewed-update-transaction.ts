import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { types } from 'node:util';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { FileSystemError } from '../../domain/project/errors.js';
import {
  reviewedAdoptionTransactionPathParts, reviewedRepairTransactionPathParts,
  reviewedUpdateTransactionPathParts, workflowTransitionTransactionPathParts,
  profileTransitionTransactionPathParts,
  localVerificationTransactionPathParts, localVerificationTransactionSchemaVersion
} from '../../domain/project/reviewed-update-artifacts.js';
import type { ReviewedTransactionKind } from '../../domain/project/reviewed-update-artifacts.js';
import type { LocalVerificationTransactionAuthorityStore } from '../../application/update/transaction-approval.js';
import {
  repairSchemaVersions, type RepairExecutionIdentity
} from '../../domain/repair/identity.js';
import { commandShellForPlatform, formatShellCommand } from '../process/shell-command.js';
import { errorCode, errorMessage } from './errors.js';
import { withProjectMutationLock } from './project-lock.js';
import type { ProjectMutationLease } from './project-lock.js';
import { ProjectFileTransactionError } from './project-transaction.js';
import type { ProjectFileMutation, ProjectFileSnapshot } from './project-transaction.js';
import { assertBoundProjectPath, readBoundProjectFileSnapshot } from './bound-project-files.js';
import {
  reviewedJournalLimits, exactJournalKeys as exactKeys,
  assertJournalDigest as assertDigest, journalTargetMode, storeJournalSnapshot as storeSnapshot,
  captureJournalMutations, captureJournalPreconditions, captureJournalRepairIdentity,
  validateJournalPaths as validatePaths, validateJournalInventory as validateInventory,
  parseReviewedJournalHeader, measureReviewedJournal, encodeReviewedJournalHeader, encodeReviewedJournalFrame
} from './reviewed-update-journal.js';
import type {
  StoredSnapshot, StoredMutation, JournalPayload, JournalHeader, JournalFrame, JournalSize,
  CapturedJournalMutation, CapturedJournalPrecondition
} from './reviewed-update-journal.js';

export {
  reviewedAdoptionTransactionPathParts, reviewedRepairTransactionPathParts,
  reviewedUpdateTransactionPathParts, reviewedUpdateTransactionSchemaVersion,
  workflowTransitionTransactionPathParts, profileTransitionTransactionPathParts,
  localVerificationTransactionPathParts, localVerificationTransactionSchemaVersion
} from '../../domain/project/reviewed-update-artifacts.js';
export type { ReviewedTransactionKind } from '../../domain/project/reviewed-update-artifacts.js';

// The store is user-local, outside the repository, and keeps separate entries for each digest.
export interface ReviewedUpdateApprovalStore {
  write(planFingerprint: string, transactionDigest: string): Promise<void>;
  verify(planFingerprint: string, transactionDigest: string): Promise<boolean>;
  remove(planFingerprint: string, transactionDigest: string): Promise<void>;
}

export interface AdoptionTransactionAuthorityStore extends ReviewedUpdateApprovalStore {
  readonly transactionKind: 'adoption';
  readonly projectRoot: string;
}

export interface WorkflowTransitionTransactionAuthorityStore extends ReviewedUpdateApprovalStore {
  readonly transactionKind: 'workflow-transition';
  readonly projectRoot: string;
}

export interface ProfileTransitionTransactionAuthorityStore extends ReviewedUpdateApprovalStore {
  readonly transactionKind: 'profile-transition';
  readonly projectRoot: string;
}

export interface ReviewedUpdateTransactionCheckpoint {
  phase: 'prepared' | 'before-mutation' | 'staged' | 'after-mutation' | 'before-commit' | 'committed';
  index?: number;
}

export interface ReviewedUpdateTransactionOptions {
  transactionKind?: ReviewedTransactionKind;
  repairIdentity?: RepairExecutionIdentity;
  planFingerprint: string;
  approvalStore: ReviewedUpdateApprovalStore;
  preconditions?: readonly ProjectFileSnapshot[];
  expectedCandidateBinding?: string;
  validatePlan?: () => Promise<void>;
  onBeforeMutation?: (mutation: ProjectFileMutation, index: number) => Promise<void>;
  onBeforeCommit?: () => Promise<void>;
  onCheckpoint?: (checkpoint: ReviewedUpdateTransactionCheckpoint) => Promise<void>;
}

export type ReviewedPublicationInputStage = 'before-admission' | 'before-publication' | 'before-commit';

export interface LocalVerificationTransactionOptions {
  planFingerprint: string;
  authorityStore: LocalVerificationTransactionAuthorityStore;
  preconditions: readonly ProjectFileSnapshot[];
  expectedCandidateBinding: string;
  /** Compare the protected baseline and exact original/target controls; never produce new effects. */
  validateCurrentInputs: (stage: ReviewedPublicationInputStage) => Promise<void>;
  onCheckpoint?: (checkpoint: ReviewedUpdateTransactionCheckpoint) => Promise<void>;
}

export interface AdoptionTransactionOptions {
  planFingerprint: string;
  authorityStore: AdoptionTransactionAuthorityStore;
  preconditions: readonly ProjectFileSnapshot[];
  expectedCandidateBinding: string;
  /** Revalidate the approved adoption plan and protected application inputs under the project lock. */
  validateCurrentInputs: (stage: ReviewedPublicationInputStage) => Promise<void>;
  onBeforeMutation?: (mutation: ProjectFileMutation, index: number) => Promise<void>;
  onBeforeCommit?: () => Promise<void>;
  onCheckpoint?: (checkpoint: ReviewedUpdateTransactionCheckpoint) => Promise<void>;
}

export interface WorkflowTransitionTransactionOptions {
  planFingerprint: string;
  authorityStore: WorkflowTransitionTransactionAuthorityStore;
  preconditions: readonly ProjectFileSnapshot[];
  expectedCandidateBinding: string;
  /** Revalidate the exact saved transition and physical inputs under the project lock. */
  validateCurrentInputs: (stage: ReviewedPublicationInputStage) => Promise<void>;
  onCheckpoint?: (checkpoint: ReviewedUpdateTransactionCheckpoint) => Promise<void>;
}

export interface ProfileTransitionTransactionOptions {
  planFingerprint: string;
  authorityStore: ProfileTransitionTransactionAuthorityStore;
  preconditions: readonly ProjectFileSnapshot[];
  expectedCandidateBinding: string;
  /** Revalidate the exact saved transition and physical inputs under the project lock. */
  validateCurrentInputs: (stage: ReviewedPublicationInputStage) => Promise<void>;
  onCheckpoint?: (checkpoint: ReviewedUpdateTransactionCheckpoint) => Promise<void>;
}

export interface ReviewedUpdateRecoveryOptions {
  transactionKind?: ReviewedTransactionKind;
  approvalStore?: ReviewedUpdateApprovalStore;
  expectedTransaction?: ReviewedRecoveryExpectation;
}

export interface ReviewedRecoveryExpectation {
  readonly planFingerprint: string;
  readonly transactionDigest: string;
}

export interface ReviewedUpdateTransactionDestination {
  pathParts: string[];
  attempted: boolean;
  disposition: 'original' | 'target' | 'changed';
}

export interface ReviewedUpdateTransactionInspection {
  status: 'absent' | 'interrupted' | 'committed' | 'blocked';
  committed: boolean;
  journalPath: string;
  planFingerprint?: string;
  transactionDigest?: string;
  schemaVersion?: number;
  repairIdentity?: RepairExecutionIdentity;
  reason?: string;
  destinations: ReviewedUpdateTransactionDestination[];
}

export interface ReviewedUpdateTransactionOutcome {
  status: 'absent' | 'rolled-back' | 'committed' | 'blocked';
  committed: boolean;
  planFingerprint?: string;
  transactionDigest?: string;
  rollbackFailures: string[];
  cleanupFailures: string[];
}

export interface ReviewedUpdateCandidate {
  readonly payload: JournalPayload;
  readonly suppliedPreconditions: readonly CapturedJournalPrecondition[];
  readonly size: JournalSize;
  readonly binding: string;
}

export class ReviewedUpdateTransactionError extends ProjectFileTransactionError {
  readonly committed = false;

  constructor(message: string, rollbackFailures: readonly string[] = []) {
    super(message, rollbackFailures);
    this.name = 'ReviewedUpdateTransactionError';
  }
}

interface LoadedJournal {
  header: JournalHeader;
  snapshot: ProjectFileSnapshot;
  pendingIndex: number;
  committed: boolean;
  rollbackComplete?: boolean;
}

const MAX_FILE_BYTES = reviewedJournalLimits.fileBytes;
const MAX_JOURNAL_BYTES = reviewedJournalLimits.journalBytes;
const privateFileMode = process.platform === 'win32' ? 0o666 : 0o600;
const transactionKinds = [
  'update', 'repair', 'adoption', 'workflow-transition', 'profile-transition',
  'local-verification'
] as const;

function fail(message: string): never {
  throw new FileSystemError(`Reviewed update transaction: ${message}`);
}

const boundPathDiagnostics = { pathLabel: 'Reviewed update path', invalid: fail };

function journalParts(kind: ReviewedTransactionKind = 'update'): readonly string[] {
  if (kind === 'update') return reviewedUpdateTransactionPathParts;
  if (kind === 'repair') return reviewedRepairTransactionPathParts;
  if (kind === 'adoption') return reviewedAdoptionTransactionPathParts;
  if (kind === 'workflow-transition') return workflowTransitionTransactionPathParts;
  if (kind === 'profile-transition') return profileTransitionTransactionPathParts;
  if (kind === 'local-verification') return localVerificationTransactionPathParts;
  return fail('unregistered transaction kind.');
}

function captureTransactionKind(options: ReviewedUpdateRecoveryOptions): ReviewedTransactionKind {
  const field = Object.getOwnPropertyDescriptor(options, 'transactionKind');
  if (!field) {
    if ('transactionKind' in options) fail('transaction kind must be an own data field.');
    return 'update';
  }
  if (!Object.hasOwn(field, 'value')) fail('transaction kind cannot be an accessor.');
  const kind = field.value ?? 'update';
  if (!transactionKinds.includes(kind)) fail('unregistered transaction kind.');
  return kind;
}

function captureAuthorityStore(store: ReviewedUpdateApprovalStore | undefined, kind: ReviewedTransactionKind) {
  const attribution = store && Object.getOwnPropertyDescriptor(store, 'transactionKind');
  if (store && 'transactionKind' in store &&
      (!attribution || !Object.hasOwn(attribution, 'value'))) fail('authority kind must be an own data field.');
  let projectRoot: string | undefined;
  if (kind === 'local-verification' || kind === 'adoption' ||
      kind === 'workflow-transition' || kind === 'profile-transition') {
    const root = store && Object.getOwnPropertyDescriptor(store, 'projectRoot');
    if (attribution?.value !== kind || !root || !Object.hasOwn(root, 'value') ||
        typeof root.value !== 'string' || !path.isAbsolute(root.value) || path.resolve(root.value) !== root.value) {
      fail(`${kind} requires dedicated authority attributed to its canonical project root.`);
    }
    projectRoot = root.value;
  } else if (attribution) {
    fail('scoped transaction authority cannot authorize update or repair.');
  }
  if (!store) return { store: undefined, projectRoot };
  const { write, verify, remove } = store;
  if (typeof write !== 'function' || typeof verify !== 'function' || typeof remove !== 'function') {
    fail('transaction authority requires write, verify and remove methods.');
  }
  return { store: { write: write.bind(store), verify: verify.bind(store), remove: remove.bind(store) }, projectRoot };
}

function assertAuthorityRoot(root: string, authority: ReturnType<typeof captureAuthorityStore>): void {
  if (authority.projectRoot !== undefined && authority.projectRoot !== root) {
    fail('scoped transaction authority belongs to a different canonical project root.');
  }
}

function captureRecoveryExpectation(options: { expectedTransaction?: ReviewedRecoveryExpectation }): ReviewedRecoveryExpectation | undefined {
  if (!options || typeof options !== 'object' || types.isProxy(options)) fail('recovery options must be own data.');
  const field = Object.getOwnPropertyDescriptor(options, 'expectedTransaction');
  if (!field) {
    if ('expectedTransaction' in options) fail('recovery expectation must be an own data field.');
    return undefined;
  }
  if (!Object.hasOwn(field, 'value')) fail('recovery expectation cannot be an accessor.');
  const value: unknown = field.value;
  if (value === undefined) return undefined;
  if (types.isProxy(value)) fail('recovery expectation cannot be a proxy.');
  exactKeys(value, ['planFingerprint', 'transactionDigest']);
  const { planFingerprint, transactionDigest } = value;
  assertDigest(planFingerprint);
  assertDigest(transactionDigest);
  return Object.freeze({ planFingerprint, transactionDigest });
}

export async function assertNoPendingReviewedUpdate(projectRoot: string): Promise<void> {
  await assertNoPendingTransactions(await canonicalRoot(projectRoot), 'update', true);
}

async function assertNoPendingTransactions(root: string, kind: ReviewedTransactionKind, propagateReadErrors = false): Promise<void> {
  for (const pendingKind of transactionKinds) {
    const parts = journalParts(pendingKind);
    const recovery = pendingKind === 'local-verification'
      ? 'the dedicated local-verification recovery entrypoint (no public recovery command is enabled)'
      : pendingKind === 'adoption'
        ? formatShellCommand({
            executable: 'liftoff',
            args: ['adopt', '--project', root, '--recover', '--approve-plan', '<fingerprint>']
          }, commandShellForPlatform(process.platform))
        : pendingKind === 'workflow-transition'
          ? formatShellCommand({
              executable: 'liftoff',
              args: [
                'workflow', 'set', '<target>', root, '--recover',
                '--approve-plan', '<fingerprint>'
              ]
            }, commandShellForPlatform(process.platform))
      : formatShellCommand({
      executable: 'liftoff',
      args: pendingKind === 'repair' ? ['repair', root, '--recover'] : ['update', '--project', root]
    }, commandShellForPlatform(process.platform));
    const check = kind === 'local-verification' ? 'a fresh local-verification publication review' : formatShellCommand({
      executable: 'liftoff',
      args: kind === 'repair' ? ['repair', root, '--check']
        : kind === 'adoption' ? ['adopt', '--project', root, '--check']
          : kind === 'workflow-transition'
            ? ['workflow', 'set', '<target>', root, '--check']
          : ['update', '--check', '--project', root]
    }, commandShellForPlatform(process.platform));
    let snapshot: ProjectFileSnapshot;
    try {
      snapshot = await readSnapshot(root, parts, MAX_JOURNAL_BYTES);
    } catch (error) {
      if (propagateReadErrors) throw error;
      fail(`${key(parts)} blocks new work: ${errorMessage(error)} Review ${recovery}, then run ${check}.`);
    }
    if (snapshot.content !== undefined) {
      fail(`an existing recovery journal blocks new work: ${key(parts)}; recover it with ${recovery}, then run ${check}.`);
    }
  }
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function key(parts: readonly string[]): string {
  return parts.join('/');
}

function folded(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

function targetMode(mode: number | undefined, original: StoredSnapshot): number {
  return reviewedUpdateTargetMode(mode, original.kind === 'file' ? original.mode : undefined);
}

export function reviewedUpdateTargetMode(mode: number | undefined, originalMode?: number): number {
  return journalTargetMode(mode, originalMode, process.platform);
}

async function canonicalRoot(projectRoot: string): Promise<string> {
  const root = path.resolve(projectRoot);
  const details = await lstat(root);
  if (!details.isDirectory() || details.isSymbolicLink()) fail('project root must be a directory, not a symlink or junction.');
  return realpath(root);
}

async function safePath(root: string, parts: readonly string[]): Promise<string> {
  await assertBoundProjectPath(root, parts, boundPathDiagnostics);
  return path.join(root, ...parts);
}

async function readSnapshot(
  root: string, parts: readonly string[], maximum = MAX_FILE_BYTES
): Promise<ProjectFileSnapshot> {
  return readBoundProjectFileSnapshot(root, parts, {
    maximumBytes: maximum, linkPolicy: 'transaction-compatible', diagnostics: boundPathDiagnostics
  });
}

function matches(snapshot: ProjectFileSnapshot, stored: StoredSnapshot): boolean {
  return stored.kind === 'missing'
    ? snapshot.content === undefined
    : snapshot.content !== undefined && snapshot.mode === stored.mode && hash(snapshot.content) === stored.sha256;
}

async function assertSnapshot(root: string, parts: readonly string[], stored: StoredSnapshot): Promise<void> {
  if (!matches(await readSnapshot(root, parts), stored)) fail(`target changed after review: ${key(parts)}.`);
}

interface CandidateDirectoryIdentity {
  dev: string;
  ino: string;
  mode: string;
}

interface CandidateParent {
  pathParts: string[];
  identity: CandidateDirectoryIdentity | null;
}

async function candidateDirectoryIdentity(native: string): Promise<CandidateDirectoryIdentity> {
  const details = await lstat(native, { bigint: true });
  if (!details.isDirectory() || details.isSymbolicLink()) fail('project root or transaction parent must be a directory, not a symlink or junction.');
  if (typeof details.dev !== 'bigint' || details.dev < 0n || typeof details.ino !== 'bigint' || details.ino <= 0n ||
    typeof details.mode !== 'bigint' || details.mode < 0n) fail('transaction directory identity is unavailable.');
  return { dev: details.dev.toString(), ino: details.ino.toString(), mode: details.mode.toString() };
}

async function candidateRootIdentity(root: string): Promise<CandidateDirectoryIdentity> {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root || path.resolve(root) !== root ||
    /[\u0000-\u001f\u007f]/u.test(root) || root.startsWith('\\\\?\\') || root.startsWith('\\\\.\\')) {
    fail('candidate project root must be an absolute canonical native path.');
  }
  const before = await candidateDirectoryIdentity(root);
  if (await realpath(root) !== root) fail('candidate project root changed or is not its canonical physical path.');
  const after = await candidateDirectoryIdentity(root);
  if (canonicalSha256(before) !== canonicalSha256(after)) fail('candidate project root changed during capture.');
  return after;
}

async function captureCandidateParent(root: string, parts: string[]): Promise<CandidateParent> {
  const native = await safePath(root, parts);
  let details;
  try {
    details = await lstat(native, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { pathParts: [...parts], identity: null };
    throw error;
  }
  if (!details.isDirectory() || details.isSymbolicLink()) fail(`not a directory: ${key(parts)}.`);
  if (typeof details.dev !== 'bigint' || details.dev < 0n || typeof details.ino !== 'bigint' || details.ino <= 0n ||
    typeof details.mode !== 'bigint' || details.mode < 0n) fail(`transaction parent identity is unavailable: ${key(parts)}.`);
  return { pathParts: [...parts], identity: {
    dev: details.dev.toString(), ino: details.ino.toString(), mode: details.mode.toString()
  } };
}

async function captureTransactionCandidate(
  root: string,
  selected: readonly CapturedJournalMutation[],
  suppliedPreconditions: readonly CapturedJournalPrecondition[],
  kind: ReviewedTransactionKind,
  repairIdentity?: RepairExecutionIdentity
) {
  const rootIdentity = await candidateRootIdentity(root);
  const conditions = new Map<string, CapturedJournalPrecondition>();
  for (const snapshot of suppliedPreconditions) conditions.set(folded(key(snapshot.pathParts)), snapshot);
  const stored: StoredMutation[] = [];
  for (const mutation of selected) {
    const expected = conditions.get(folded(key(mutation.pathParts)));
    if (expected && key(expected.pathParts) !== key(mutation.pathParts)) fail('case-colliding source and destination.');
    const original = expected?.stored ?? storeSnapshot(await readSnapshot(root, mutation.pathParts));
    if (mutation.type === 'write' && mutation.content.length > MAX_FILE_BYTES) fail(`oversized target: ${key(mutation.pathParts)}.`);
    const target: StoredSnapshot = mutation.type === 'delete' ? { kind: 'missing' }
      : storeSnapshot({ pathParts: mutation.pathParts, content: mutation.content, mode: targetMode(mutation.mode, original) });
    stored.push({
      type: mutation.type, pathParts: mutation.pathParts, original, target,
      ...(mutation.type === 'write' && mutation.mode !== undefined ? { mode: mutation.mode } : {})
    });
    conditions.set(folded(key(mutation.pathParts)), { pathParts: mutation.pathParts, stored: original });
  }
  validateInventory(stored);
  validatePaths([...conditions.values()].map((entry) => entry.pathParts));
  const assertConditions = async () => {
    for (const condition of conditions.values()) await assertSnapshot(root, condition.pathParts, condition.stored);
  };
  await assertConditions();
  const parents = new Map<string, CandidateParent>();
  if (stored.length) {
    for (const parts of [...stored.filter((entry) => entry.type === 'write').map((entry) => entry.pathParts), journalParts(kind)]) {
      for (let count = 1; count < parts.length; count++) {
        const parent = parts.slice(0, count);
        if (!parents.has(key(parent))) parents.set(key(parent), await captureCandidateParent(root, parent));
      }
    }
  }
  const assertParents = async () => {
    if (canonicalSha256(rootIdentity) !== canonicalSha256(await candidateRootIdentity(root))) {
      fail('candidate project root changed during capture.');
    }
    for (const parent of parents.values()) {
      if (canonicalSha256(parent) !== canonicalSha256(await captureCandidateParent(root, parent.pathParts))) {
        fail(`transaction parent changed after review: ${key(parent.pathParts)}.`);
      }
    }
    if (canonicalSha256(rootIdentity) !== canonicalSha256(await candidateRootIdentity(root))) {
      fail('candidate project root changed during capture.');
    }
  };
  await assertConditions();
  await assertParents();
  const payload: JournalPayload = {
    schemaVersion: kind === 'local-verification' ? localVerificationTransactionSchemaVersion
      : repairIdentity ? repairSchemaVersions.journal : 1,
    transactionKind: kind, ...(repairIdentity ? { repairIdentity } : {}),
    projectRoot: root, mutations: stored,
    missingDirectories: [...parents.values()].filter((entry) => entry.identity === null).map((entry) => [...entry.pathParts])
  };
  const size = measureReviewedJournal(payload, suppliedPreconditions, process.platform);
  const candidate: ReviewedUpdateCandidate = {
    payload, suppliedPreconditions, size,
    binding: canonicalSha256({
      kind: kind === 'local-verification'
        ? 'local-verification-candidate'
        : kind === 'adoption'
          ? 'adoption-transaction-candidate'
          : kind === 'workflow-transition'
            ? 'workflow-transition-transaction-candidate'
          : kind === 'profile-transition'
            ? 'profile-transition-transaction-candidate'
          : 'reviewed-update-candidate',
      payload, suppliedPreconditions, rootIdentity, parents: [...parents.values()]
    })
  };
  return { candidate, conditions, assertConditions, assertParents };
}

// Read-only observations and a full-byte binding are not approval. Apply must
// rebuild the same candidate under its existing cooperating mutation lock.
export async function inspectReviewedUpdateCandidate(
  canonicalProjectRoot: string,
  mutations: readonly ProjectFileMutation[],
  preconditions: readonly ProjectFileSnapshot[]
): Promise<ReviewedUpdateCandidate> {
  const selected = captureJournalMutations(mutations);
  const suppliedPreconditions = captureJournalPreconditions(preconditions);
  await candidateRootIdentity(canonicalProjectRoot);
  await assertNoPendingTransactions(canonicalProjectRoot, 'update', true);
  const captured = await captureTransactionCandidate(canonicalProjectRoot, selected, suppliedPreconditions, 'update');
  await assertNoPendingTransactions(canonicalProjectRoot, 'update', true);
  return captured.candidate;
}

export async function inspectLocalVerificationCandidate(
  canonicalProjectRoot: string,
  mutations: readonly ProjectFileMutation[],
  preconditions: readonly ProjectFileSnapshot[]
): Promise<ReviewedUpdateCandidate> {
  if (!Array.isArray(preconditions)) fail('local-verification requires explicit physical preconditions.');
  const selected = captureJournalMutations(mutations);
  const supplied = captureJournalPreconditions(preconditions);
  await candidateRootIdentity(canonicalProjectRoot);
  await assertNoPendingTransactions(canonicalProjectRoot, 'local-verification', true);
  const captured = await captureTransactionCandidate(canonicalProjectRoot, selected, supplied, 'local-verification');
  await assertNoPendingTransactions(canonicalProjectRoot, 'local-verification', true);
  return captured.candidate;
}

export async function inspectAdoptionTransactionCandidate(
  canonicalProjectRoot: string,
  mutations: readonly ProjectFileMutation[],
  preconditions: readonly ProjectFileSnapshot[]
): Promise<ReviewedUpdateCandidate> {
  const selected = captureJournalMutations(mutations);
  const supplied = captureJournalPreconditions(preconditions);
  await candidateRootIdentity(canonicalProjectRoot);
  await assertNoPendingTransactions(canonicalProjectRoot, 'adoption', true);
  const captured = await captureTransactionCandidate(
    canonicalProjectRoot, selected, supplied, 'adoption'
  );
  await assertNoPendingTransactions(canonicalProjectRoot, 'adoption', true);
  return captured.candidate;
}

export async function inspectWorkflowTransitionTransactionCandidate(
  canonicalProjectRoot: string,
  mutations: readonly ProjectFileMutation[],
  preconditions: readonly ProjectFileSnapshot[]
): Promise<ReviewedUpdateCandidate> {
  const selected = captureJournalMutations(mutations);
  const supplied = captureJournalPreconditions(preconditions);
  await candidateRootIdentity(canonicalProjectRoot);
  await assertNoPendingTransactions(
    canonicalProjectRoot, 'workflow-transition', true
  );
  const captured = await captureTransactionCandidate(
    canonicalProjectRoot, selected, supplied, 'workflow-transition'
  );
  await assertNoPendingTransactions(
    canonicalProjectRoot, 'workflow-transition', true
  );
  return captured.candidate;
}

export async function inspectProfileTransitionTransactionCandidate(
  canonicalProjectRoot: string,
  mutations: readonly ProjectFileMutation[],
  preconditions: readonly ProjectFileSnapshot[]
): Promise<ReviewedUpdateCandidate> {
  const selected = captureJournalMutations(mutations);
  const supplied = captureJournalPreconditions(preconditions);
  await candidateRootIdentity(canonicalProjectRoot);
  await assertNoPendingTransactions(
    canonicalProjectRoot, 'profile-transition', true
  );
  const captured = await captureTransactionCandidate(
    canonicalProjectRoot, selected, supplied, 'profile-transition'
  );
  await assertNoPendingTransactions(
    canonicalProjectRoot, 'profile-transition', true
  );
  return captured.candidate;
}

export async function inspectRepairTransactionCandidate(
  canonicalProjectRoot: string,
  mutations: readonly ProjectFileMutation[],
  preconditions: readonly ProjectFileSnapshot[],
  repairIdentity: RepairExecutionIdentity
): Promise<ReviewedUpdateCandidate> {
  const selected = captureJournalMutations(mutations);
  const supplied = captureJournalPreconditions(preconditions);
  await candidateRootIdentity(canonicalProjectRoot);
  await assertNoPendingTransactions(canonicalProjectRoot, 'repair', true);
  const captured = await captureTransactionCandidate(
    canonicalProjectRoot, selected, supplied, 'repair', repairIdentity
  );
  await assertNoPendingTransactions(canonicalProjectRoot, 'repair', true);
  return captured.candidate;
}

function parseHeader(value: unknown, root: string, kind: ReviewedTransactionKind): JournalHeader {
  return parseReviewedJournalHeader(value, root, kind, process.platform);
}

function frameDigest(header: JournalHeader, frame: JournalFrame): string {
  return canonicalSha256({ schemaVersion: 1, transactionDigest: header.transactionDigest, ...frame });
}

function rollbackCleanupDigest(header: JournalHeader): string {
  return canonicalSha256({ schemaVersion: 1, transactionDigest: header.transactionDigest, phase: 'rollback-cleanup-only' });
}

function parseCanonicalLine(line: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    fail('malformed recovery journal JSON.');
  }
  if (canonicalJson(value) !== `${line}\n`) fail('recovery journal is not strict canonical JSON.');
  return value;
}

async function loadJournal(
  root: string, kind: ReviewedTransactionKind, store?: ReviewedUpdateApprovalStore
): Promise<LoadedJournal | undefined> {
  const snapshot = await readSnapshot(root, journalParts(kind), MAX_JOURNAL_BYTES);
  if (!snapshot.content) return undefined;
  if (snapshot.mode !== privateFileMode) fail('recovery journal must have restrictive permissions.');
  const text = snapshot.content.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(snapshot.content)) fail('recovery journal is not UTF-8.');
  const lines = text.split('\n');
  const tail = lines.pop()!;
  if (!lines.length) fail('incomplete recovery journal header.');
  const header = parseHeader(parseCanonicalLine(lines[0]), root, kind);
  let pendingIndex = -1;
  let committed = false;
  let lastFrame: JournalFrame | undefined;
  for (const line of lines.slice(1)) {
    const frame = parseCanonicalLine(line);
    if (committed || !isRecord(frame)) fail('invalid recovery phase sequence.');
    if (frame.phase === 'mutation') {
      exactKeys(frame, ['phase', 'index']);
      if (frame.index !== pendingIndex + 1 || pendingIndex + 1 >= header.mutations.length) fail('invalid mutation checkpoint.');
      pendingIndex += 1;
      lastFrame = { phase: 'mutation', index: pendingIndex };
    } else {
      exactKeys(frame, ['phase']);
      if (frame.phase !== 'committed' || pendingIndex !== header.mutations.length - 1) fail('invalid commit checkpoint.');
      committed = true;
      lastFrame = { phase: 'committed' };
    }
  }
  if (tail) {
    const next: JournalFrame = pendingIndex + 1 < header.mutations.length
      ? { phase: 'mutation', index: pendingIndex + 1 } : { phase: 'committed' };
    // An interrupted append is accepted only as an exact prefix of the one possible next record.
    if (committed || !canonicalJson(next).startsWith(tail)) fail('malformed trailing recovery checkpoint.');
  }
  if (!store) {
    fail('missing or invalid user-local transaction approval; the project journal cannot authorize recovery.');
  }
  const approved = await store.verify(header.planFingerprint, header.transactionDigest) === true;
  const cleanupOnly = !approved && await store.verify(header.planFingerprint, rollbackCleanupDigest(header)) === true;
  if (!approved && !cleanupOnly) {
    fail('missing or invalid user-local transaction approval; the project journal cannot authorize recovery.');
  }
  if (approved && lastFrame && await store.verify(header.planFingerprint, frameDigest(header, lastFrame)) !== true) {
    fail('recovery checkpoint has no matching user-local approval seal.');
  }
  // A durable external commit seal wins even if the local commit append was interrupted or truncated.
  const sealedCommit = await store.verify(header.planFingerprint, frameDigest(header, { phase: 'committed' }));
  if (committed && sealedCommit !== true) fail('committed journal has no matching external commit seal.');
  if (cleanupOnly && !sealedCommit) {
    // This separately sealed capability cannot restore files: every original must already be intact.
    for (const mutation of header.mutations) await assertSnapshot(root, mutation.pathParts, mutation.original);
  }
  return { header, snapshot, pendingIndex, committed: sealedCommit === true, rollbackComplete: cleanupOnly && !sealedCommit };
}

function temporaryParts(header: JournalHeader, index: number, restore: boolean): string[] {
  return [
    ...header.mutations[index].pathParts.slice(0, -1),
    `.liftoff-reviewed-${header.transactionDigest}-${index}-${restore ? 'original' : 'target'}.tmp`
  ];
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (process.platform !== 'win32' ||
        !['EACCES', 'EPERM', 'EINVAL', 'ENOTSUP', 'EISDIR'].includes(String(errorCode(error)))) throw error;
  } finally {
    await handle?.close();
  }
}

async function ensureParents(root: string, parts: readonly string[], permitted: readonly string[][]): Promise<void> {
  for (let count = 1; count < parts.length; count += 1) {
    const parent = parts.slice(0, count);
    const native = await safePath(root, parent);
    try {
      if (!(await lstat(native)).isDirectory()) fail(`not a directory: ${key(parent)}.`);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      if (!permitted.some((allowed) => key(allowed) === key(parent))) fail(`parent changed after review: ${key(parent)}.`);
      await mkdir(native, { mode: 0o700 });
      await chmod(await safePath(root, parent), 0o700);
      await syncDirectory(path.dirname(native));
    }
  }
}

async function assertJournalCurrent(root: string, snapshot: ProjectFileSnapshot): Promise<void> {
  const current = await readSnapshot(root, snapshot.pathParts, MAX_JOURNAL_BYTES);
  if (!current.content?.equals(snapshot.content!) || current.mode !== snapshot.mode) {
    fail('recovery journal changed; the changed file was preserved.');
  }
}

async function createJournal(root: string, header: JournalHeader, bytes: Buffer, lease: ProjectMutationLease): Promise<ProjectFileSnapshot> {
  const parts = journalParts(header.transactionKind);
  await ensureParents(root, parts, header.missingDirectories);
  const native = await safePath(root, parts);
  await lease.assertHeld();
  const handle = await open(native, 'wx', 0o600);
  let identity: { dev: number; ino: number } | undefined;
  let closed = false;
  try {
    identity = await handle.stat();
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    const failures: string[] = [];
    try {
      await handle.close();
      closed = true;
      await lease.assertHeld();
      const current = await readSnapshot(root, parts, MAX_JOURNAL_BYTES);
      const details = await lstat(native);
      if (!identity || details.dev !== identity.dev || details.ino !== identity.ino ||
          current.mode !== privateFileMode || !current.content ||
          !bytes.subarray(0, current.content.length).equals(current.content)) {
        fail('partially created recovery journal changed; it was preserved.');
      }
      await unlink(native);
      await syncDirectory(path.dirname(native));
    } catch (cleanupError) {
      failures.push(errorMessage(cleanupError));
    }
    throw new FileSystemError(
      `Unable to create ${key(parts)}: ${errorMessage(error)}` +
      (failures.length ? ` Cleanup failed: ${failures.join('; ')}` : '')
    );
  } finally {
    if (!closed) await handle.close();
  }
  await syncDirectory(path.dirname(native));
  return readSnapshot(root, parts, MAX_JOURNAL_BYTES);
}

async function appendFrame(
  root: string, snapshot: ProjectFileSnapshot, frame: JournalFrame, lease: ProjectMutationLease
): Promise<ProjectFileSnapshot> {
  await lease.assertHeld();
  await assertJournalCurrent(root, snapshot);
  const native = await safePath(root, snapshot.pathParts);
  const handle = await open(native, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
  try {
    await handle.writeFile(encodeReviewedJournalFrame(frame));
    await handle.sync();
  } finally {
    await handle.close();
  }
  return readSnapshot(root, snapshot.pathParts, MAX_JOURNAL_BYTES);
}

async function durableMutation(
  root: string, header: JournalHeader, index: number, restore: boolean, lease: ProjectMutationLease,
  onStaged?: () => Promise<void>
): Promise<void> {
  const mutation = header.mutations[index];
  const before = restore ? mutation.target : mutation.original;
  const after = restore ? mutation.original : mutation.target;
  await lease.assertHeld();
  await assertSnapshot(root, mutation.pathParts, before);
  if (after.kind === 'missing') {
    if (before.kind === 'missing') return;
    await unlink(await safePath(root, mutation.pathParts));
    await syncDirectory(path.dirname(path.join(root, ...mutation.pathParts)));
  } else {
    await ensureParents(root, mutation.pathParts, header.missingDirectories);
    const temporary = await safePath(root, temporaryParts(header, index, restore));
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(Buffer.from(after.bytes, 'base64'));
      await handle.chmod(after.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await onStaged?.();
    await lease.assertHeld();
    await assertSnapshot(root, mutation.pathParts, before);
    await assertSnapshot(root, temporaryParts(header, index, restore), after);
    await rename(temporary, await safePath(root, mutation.pathParts));
    await syncDirectory(path.dirname(temporary));
  }
  await assertSnapshot(root, mutation.pathParts, after);
}

async function cleanupTemporary(
  root: string, header: JournalHeader, index: number, restore: boolean, lease: ProjectMutationLease
): Promise<void> {
  const parts = temporaryParts(header, index, restore);
  const snapshot = await readSnapshot(root, parts);
  if (snapshot.content === undefined) return;
  const intended = restore ? header.mutations[index].original : header.mutations[index].target;
  if (intended.kind !== 'file' || !Buffer.from(intended.bytes, 'base64').subarray(0, snapshot.content.length).equals(snapshot.content) ||
      snapshot.mode !== privateFileMode && snapshot.mode !== intended.mode) {
    fail(`temporary changed; it was preserved: ${key(parts)}.`);
  }
  await lease.assertHeld();
  const current = await readSnapshot(root, parts);
  if (!current.content?.equals(snapshot.content) || current.mode !== snapshot.mode) fail(`temporary changed: ${key(parts)}.`);
  await unlink(await safePath(root, parts));
  await syncDirectory(path.dirname(path.join(root, ...parts)));
}

async function cleanupJournal(
  root: string, loaded: LoadedJournal, store: ReviewedUpdateApprovalStore, lease: ProjectMutationLease
): Promise<string[]> {
  const failures: string[] = [];
  const removeApproval = async (digest: string): Promise<boolean> => {
    try {
      await store.remove(loaded.header.planFingerprint, digest);
      return true;
    } catch (error) {
      failures.push(`user-local approval ${digest}: ${errorMessage(error)}`);
      return false;
    }
  };
  if (!loaded.committed) {
    await lease.assertHeld();
    await assertJournalCurrent(root, loaded.snapshot);
    // A failed revocation must leave the journal blocking new work after rollback.
    if (!await removeApproval(loaded.header.transactionDigest)) return failures;
  }
  try {
    await lease.assertHeld();
    await assertJournalCurrent(root, loaded.snapshot);
    await unlink(await safePath(root, loaded.snapshot.pathParts));
    await syncDirectory(path.join(root, '.liftoff'));
  } catch (error) {
    return [`${key(loaded.snapshot.pathParts)}: ${errorMessage(error)}`];
  }
  // Never discard the commit seal while an approval capable of authorizing rollback remains.
  if (loaded.committed && !await removeApproval(loaded.header.transactionDigest)) return failures;
  const digests = [
    ...loaded.header.mutations.map((_entry, index) => frameDigest(loaded.header, { phase: 'mutation', index })),
    frameDigest(loaded.header, { phase: 'committed' }),
    rollbackCleanupDigest(loaded.header)
  ];
  for (const digest of digests) await removeApproval(digest);
  if (!loaded.committed && loaded.header.missingDirectories.some((parts) => key(parts) === '.liftoff')) {
    try {
      await lease.assertHeld();
      await rmdir(await safePath(root, ['.liftoff']));
      await syncDirectory(root);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') failures.push(`.liftoff: ${errorMessage(error)}`);
    }
  }
  return failures;
}

async function destinations(root: string, loaded: LoadedJournal): Promise<ReviewedUpdateTransactionDestination[]> {
  const result: ReviewedUpdateTransactionDestination[] = [];
  for (const [index, mutation] of loaded.header.mutations.entries()) {
    const current = await readSnapshot(root, mutation.pathParts);
    result.push({
      pathParts: [...mutation.pathParts], attempted: index <= loaded.pendingIndex,
      disposition: matches(current, mutation.original) ? 'original'
        : index <= loaded.pendingIndex && matches(current, mutation.target) ? 'target' : 'changed'
    });
  }
  return result;
}

function outcome(status: ReviewedUpdateTransactionOutcome['status'], loaded?: LoadedJournal): ReviewedUpdateTransactionOutcome {
  return {
    status, committed: loaded?.committed ?? false,
    ...(loaded ? { planFingerprint: loaded.header.planFingerprint, transactionDigest: loaded.header.transactionDigest } : {}),
    rollbackFailures: [], cleanupFailures: []
  };
}

async function recoverLocked(
  root: string, loaded: LoadedJournal, store: ReviewedUpdateApprovalStore, lease: ProjectMutationLease
): Promise<ReviewedUpdateTransactionOutcome> {
  if (loaded.committed) {
    return { ...outcome('committed', loaded), cleanupFailures: await cleanupJournal(root, loaded, store, lease) };
  }
  if (loaded.rollbackComplete) {
    for (const mutation of loaded.header.mutations) await assertSnapshot(root, mutation.pathParts, mutation.original);
    const cleanupFailures = await cleanupJournal(root, loaded, store, lease);
    return { ...outcome(cleanupFailures.length ? 'blocked' : 'rolled-back', loaded), cleanupFailures };
  }
  const result = outcome('rolled-back', loaded);
  const entries = await destinations(root, loaded);
  for (const [index, mutation] of [...loaded.header.mutations.entries()].reverse()) {
    try {
      await lease.assertHeld();
      await assertJournalCurrent(root, loaded.snapshot);
      const current = entries[index];
      if (current.disposition === 'changed') fail(`target changed before rollback; it was preserved: ${key(mutation.pathParts)}.`);
      if (current.attempted) {
        await cleanupTemporary(root, loaded.header, index, false, lease);
        await cleanupTemporary(root, loaded.header, index, true, lease);
      }
      if (current.disposition === 'target') await durableMutation(root, loaded.header, index, true, lease);
    } catch (error) {
      result.rollbackFailures.push(`${key(mutation.pathParts)}: ${errorMessage(error)}`);
    }
  }
  for (const parts of [...loaded.header.missingDirectories].sort((left, right) => right.length - left.length)) {
    if (key(parts) === '.liftoff') continue;
    if (!loaded.header.mutations.some((mutation, index) => index <= loaded.pendingIndex &&
        mutation.type === 'write' && key(mutation.pathParts).startsWith(`${key(parts)}/`))) continue;
    try {
      await lease.assertHeld();
      await assertJournalCurrent(root, loaded.snapshot);
      await rmdir(await safePath(root, parts));
      await syncDirectory(path.dirname(path.join(root, ...parts)));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') result.rollbackFailures.push(`${key(parts)}: ${errorMessage(error)}`);
    }
  }
  if (result.rollbackFailures.length) result.status = 'blocked';
  else result.cleanupFailures = await cleanupJournal(root, loaded, store, lease);
  if (result.cleanupFailures.length) result.status = 'blocked';
  return result;
}

async function withReviewedMutationLock(
  root: string, operation: (lease: ProjectMutationLease) => Promise<ReviewedUpdateTransactionOutcome>
): Promise<ReviewedUpdateTransactionOutcome> {
  let result: ReviewedUpdateTransactionOutcome | undefined;
  try {
    return await withProjectMutationLock(root, async (lease) => {
      result = await operation(lease);
      return result;
    });
  } catch (error) {
    if (result?.committed) {
      return { ...result, cleanupFailures: [...result.cleanupFailures, `Project mutation lock cleanup: ${errorMessage(error)}`] };
    }
    throw error;
  }
}

export async function inspectReviewedUpdateTransaction(
  projectRoot: string, options: ReviewedUpdateRecoveryOptions = {}
): Promise<ReviewedUpdateTransactionInspection> {
  const kind = captureTransactionKind(options);
  const journalPath = path.join(path.resolve(projectRoot), ...journalParts(kind));
  try {
    const authority = captureAuthorityStore(options.approvalStore, kind);
    const root = await canonicalRoot(projectRoot);
    assertAuthorityRoot(root, authority);
    const loaded = await loadJournal(root, kind, authority.store);
    if (!loaded) return { status: 'absent', committed: false, journalPath, destinations: [] };
    return {
      status: loaded.committed ? 'committed' : 'interrupted', committed: loaded.committed, journalPath,
      planFingerprint: loaded.header.planFingerprint, transactionDigest: loaded.header.transactionDigest,
      schemaVersion: loaded.header.schemaVersion,
      ...(loaded.header.repairIdentity ? { repairIdentity: loaded.header.repairIdentity } : {}),
      destinations: loaded.committed ? [] : await destinations(root, loaded)
    };
  } catch (error) {
    return { status: 'blocked', committed: false, journalPath, reason: errorMessage(error), destinations: [] };
  }
}

export async function recoverReviewedUpdateTransaction(
  projectRoot: string, options: ReviewedUpdateRecoveryOptions = {}
): Promise<ReviewedUpdateTransactionOutcome> {
  let kind: ReviewedTransactionKind;
  let authority: ReturnType<typeof captureAuthorityStore>;
  let expectedTransaction: ReviewedRecoveryExpectation | undefined;
  try {
    kind = captureTransactionKind(options);
    authority = captureAuthorityStore(options.approvalStore, kind);
    expectedTransaction = captureRecoveryExpectation(options);
    if (authority.projectRoot !== undefined) assertAuthorityRoot(await canonicalRoot(projectRoot), authority);
  } catch (error) {
    return { ...outcome('blocked'), rollbackFailures: [errorMessage(error)] };
  }
  return withReviewedMutationLock(projectRoot, async (lease) => {
    try {
      const root = await canonicalRoot(projectRoot);
      assertAuthorityRoot(root, authority);
      const loaded = await loadJournal(root, kind, authority.store);
      if (expectedTransaction && (!loaded || loaded.header.planFingerprint !== expectedTransaction.planFingerprint ||
          loaded.header.transactionDigest !== expectedTransaction.transactionDigest)) {
        fail('the recovery journal is absent or differs from the exact observed fingerprint and transaction digest.');
      }
      if (!loaded) return outcome('absent');
      return await recoverLocked(root, loaded, authority.store!, lease);
    } catch (error) {
      return { ...outcome('blocked'), rollbackFailures: [errorMessage(error)] };
    }
  });
}

export async function applyReviewedUpdateTransaction(
  projectRoot: string, mutations: readonly ProjectFileMutation[], options: ReviewedUpdateTransactionOptions
): Promise<ReviewedUpdateTransactionOutcome> {
  const kind = captureTransactionKind(options);
  if (kind === 'local-verification' || kind === 'adoption' ||
      kind === 'workflow-transition' || kind === 'profile-transition') {
    fail(`${kind} requires its dedicated publication entrypoint.`);
  }
  return applyTransaction(projectRoot, mutations, options);
}

export async function applyAdoptionTransaction(
  projectRoot: string,
  mutations: readonly ProjectFileMutation[],
  options: AdoptionTransactionOptions
): Promise<ReviewedUpdateTransactionOutcome> {
  const {
    authorityStore, planFingerprint, preconditions, expectedCandidateBinding,
    validateCurrentInputs, onBeforeMutation, onBeforeCommit, onCheckpoint
  } = options;
  assertDigest(expectedCandidateBinding);
  if (!Array.isArray(preconditions) || typeof validateCurrentInputs !== 'function') {
    fail('adoption requires physical preconditions and locked current-input checks.');
  }
  return applyTransaction(projectRoot, mutations, {
    planFingerprint,
    transactionKind: 'adoption',
    approvalStore: authorityStore,
    preconditions,
    expectedCandidateBinding,
    ...(onBeforeMutation ? { onBeforeMutation } : {}),
    ...(onBeforeCommit ? { onBeforeCommit } : {}),
    ...(onCheckpoint ? { onCheckpoint } : {})
  }, validateCurrentInputs);
}

export function inspectAdoptionTransaction(
  projectRoot: string,
  options: { authorityStore: AdoptionTransactionAuthorityStore }
): Promise<ReviewedUpdateTransactionInspection> {
  return inspectReviewedUpdateTransaction(projectRoot, {
    transactionKind: 'adoption',
    approvalStore: options.authorityStore
  });
}

export function recoverAdoptionTransaction(
  projectRoot: string,
  options: {
    authorityStore: AdoptionTransactionAuthorityStore;
    expectedTransaction?: ReviewedRecoveryExpectation;
  }
): Promise<ReviewedUpdateTransactionOutcome> {
  return recoverReviewedUpdateTransaction(projectRoot, {
    transactionKind: 'adoption',
    approvalStore: options.authorityStore,
    ...(options.expectedTransaction
      ? { expectedTransaction: options.expectedTransaction }
      : {})
  });
}

export async function applyWorkflowTransitionTransaction(
  projectRoot: string,
  mutations: readonly ProjectFileMutation[],
  options: WorkflowTransitionTransactionOptions
): Promise<ReviewedUpdateTransactionOutcome> {
  const {
    authorityStore, planFingerprint, preconditions, expectedCandidateBinding,
    validateCurrentInputs, onCheckpoint
  } = options;
  assertDigest(expectedCandidateBinding);
  if (!Array.isArray(preconditions) ||
      typeof validateCurrentInputs !== 'function') {
    fail(
      'workflow-transition requires physical preconditions and locked current-input checks.'
    );
  }
  return applyTransaction(projectRoot, mutations, {
    planFingerprint,
    transactionKind: 'workflow-transition',
    approvalStore: authorityStore,
    preconditions,
    expectedCandidateBinding,
    ...(onCheckpoint ? { onCheckpoint } : {})
  }, validateCurrentInputs);
}

export function inspectWorkflowTransitionTransaction(
  projectRoot: string,
  options: {
    authorityStore: WorkflowTransitionTransactionAuthorityStore;
  }
): Promise<ReviewedUpdateTransactionInspection> {
  return inspectReviewedUpdateTransaction(projectRoot, {
    transactionKind: 'workflow-transition',
    approvalStore: options.authorityStore
  });
}

export function recoverWorkflowTransitionTransaction(
  projectRoot: string,
  options: {
    authorityStore: WorkflowTransitionTransactionAuthorityStore;
    expectedTransaction?: ReviewedRecoveryExpectation;
  }
): Promise<ReviewedUpdateTransactionOutcome> {
  return recoverReviewedUpdateTransaction(projectRoot, {
    transactionKind: 'workflow-transition',
    approvalStore: options.authorityStore,
    ...(options.expectedTransaction
      ? { expectedTransaction: options.expectedTransaction }
      : {})
  });
}

export async function applyProfileTransitionTransaction(
  projectRoot: string,
  mutations: readonly ProjectFileMutation[],
  options: ProfileTransitionTransactionOptions
): Promise<ReviewedUpdateTransactionOutcome> {
  const {
    authorityStore, planFingerprint, preconditions, expectedCandidateBinding,
    validateCurrentInputs, onCheckpoint
  } = options;
  assertDigest(expectedCandidateBinding);
  if (!Array.isArray(preconditions) ||
      typeof validateCurrentInputs !== 'function') {
    fail(
      'profile-transition requires physical preconditions and locked current-input checks.'
    );
  }
  return applyTransaction(projectRoot, mutations, {
    planFingerprint,
    transactionKind: 'profile-transition',
    approvalStore: authorityStore,
    preconditions,
    expectedCandidateBinding,
    ...(onCheckpoint ? { onCheckpoint } : {})
  }, validateCurrentInputs);
}

export function inspectProfileTransitionTransaction(
  projectRoot: string,
  options: {
    authorityStore: ProfileTransitionTransactionAuthorityStore;
  }
): Promise<ReviewedUpdateTransactionInspection> {
  return inspectReviewedUpdateTransaction(projectRoot, {
    transactionKind: 'profile-transition',
    approvalStore: options.authorityStore
  });
}

export function recoverProfileTransitionTransaction(
  projectRoot: string,
  options: {
    authorityStore: ProfileTransitionTransactionAuthorityStore;
    expectedTransaction?: ReviewedRecoveryExpectation;
  }
): Promise<ReviewedUpdateTransactionOutcome> {
  return recoverReviewedUpdateTransaction(projectRoot, {
    transactionKind: 'profile-transition',
    approvalStore: options.authorityStore,
    ...(options.expectedTransaction
      ? { expectedTransaction: options.expectedTransaction }
      : {})
  });
}

export async function applyLocalVerificationTransaction(
  projectRoot: string, mutations: readonly ProjectFileMutation[], options: LocalVerificationTransactionOptions
): Promise<ReviewedUpdateTransactionOutcome> {
  const { planFingerprint, authorityStore, preconditions, expectedCandidateBinding, validateCurrentInputs, onCheckpoint } = options;
  assertDigest(expectedCandidateBinding);
  if (!Array.isArray(preconditions) || typeof validateCurrentInputs !== 'function') {
    fail('local-verification requires physical preconditions and locked current-input checks.');
  }
  return applyTransaction(projectRoot, mutations, {
    transactionKind: 'local-verification', planFingerprint, approvalStore: authorityStore, preconditions,
    expectedCandidateBinding, onCheckpoint
  }, validateCurrentInputs);
}

export function inspectLocalVerificationTransaction(
  projectRoot: string, options: { authorityStore: LocalVerificationTransactionAuthorityStore }
): Promise<ReviewedUpdateTransactionInspection> {
  return inspectReviewedUpdateTransaction(projectRoot, { transactionKind: 'local-verification', approvalStore: options.authorityStore });
}

export function recoverLocalVerificationTransaction(
  projectRoot: string, options: { authorityStore: LocalVerificationTransactionAuthorityStore; expectedTransaction?: ReviewedRecoveryExpectation }
): Promise<ReviewedUpdateTransactionOutcome> {
  let expectedTransaction: ReviewedRecoveryExpectation | undefined;
  try { expectedTransaction = captureRecoveryExpectation(options); }
  catch (error) { return Promise.resolve({ ...outcome('blocked'), rollbackFailures: [errorMessage(error)] }); }
  return recoverReviewedUpdateTransaction(projectRoot, { transactionKind: 'local-verification', approvalStore: options.authorityStore, expectedTransaction });
}

async function applyTransaction(
  projectRoot: string, mutations: readonly ProjectFileMutation[], options: ReviewedUpdateTransactionOptions,
  validateCurrentInputs?: (stage: ReviewedPublicationInputStage) => Promise<void>
): Promise<ReviewedUpdateTransactionOutcome> {
  const kind = captureTransactionKind(options);
  if ((kind === 'local-verification' || kind === 'adoption') && !validateCurrentInputs) {
    fail(`${kind} requires its dedicated publication entrypoint and current-input checks.`);
  }
  const journalPathParts = journalParts(kind);
  const repairIdentity = kind === 'repair' ? captureJournalRepairIdentity(options.repairIdentity) : undefined;
  if (kind === 'update' && options.repairIdentity !== undefined) fail('update cannot acquire repair identity or authority.');
  assertDigest(options.planFingerprint);
  const planFingerprint = options.planFingerprint;
  const expectedCandidateBinding = options.expectedCandidateBinding;
  if (expectedCandidateBinding !== undefined) assertDigest(expectedCandidateBinding);
  const authority = captureAuthorityStore(options.approvalStore, kind);
  const approvalStore = authority.store;
  if (!approvalStore) fail('a user-local transaction approval store is required.');
  const selected = captureJournalMutations(mutations);
  const suppliedPreconditions = captureJournalPreconditions(options.preconditions);
  if (authority.projectRoot !== undefined) assertAuthorityRoot(await canonicalRoot(projectRoot), authority);
  return withReviewedMutationLock(projectRoot, async (lease) => {
    const root = await canonicalRoot(projectRoot);
    assertAuthorityRoot(root, authority);
    await assertNoPendingTransactions(root, kind);
    await options.validatePlan?.();
    await validateCurrentInputs?.('before-admission');
    await lease.assertHeld();
    const { candidate, conditions, assertConditions, assertParents } =
      await captureTransactionCandidate(root, selected, suppliedPreconditions, kind, repairIdentity);
    if (expectedCandidateBinding !== undefined && candidate.binding !== expectedCandidateBinding) {
      fail('the captured transaction candidate changed after review; obtain a fresh preview.');
    }
    const { payload } = candidate;
    const stored = payload.mutations;
    if (!stored.length) return outcome('absent');
    const { header, content: headerBytes } = encodeReviewedJournalHeader({
      ...payload, planFingerprint, nonce: randomUUID()
    }, process.platform);
    for (const [index] of stored.entries()) {
      for (const restore of [false, true]) {
        if ((await readSnapshot(root, temporaryParts(header, index, restore))).content !== undefined) {
          fail(`reserved temporary already exists: ${key(temporaryParts(header, index, restore))}.`);
        }
      }
    }
    await assertConditions();
    await assertParents();
    let loaded: LoadedJournal | undefined;
    let committed = false;
    let operation = 'persist user-local transaction approval';
    try {
      await approvalStore.write(header.planFingerprint, header.transactionDigest);
      await approvalStore.write(header.planFingerprint, rollbackCleanupDigest(header));
      if (await approvalStore.verify(header.planFingerprint, header.transactionDigest) !== true ||
          await approvalStore.verify(header.planFingerprint, rollbackCleanupDigest(header)) !== true) {
        fail('the user-local approval store did not persist its transaction seal.');
      }
      await lease.assertHeld();
      if (validateCurrentInputs) {
        await validateCurrentInputs('before-publication');
        await lease.assertHeld();
      }
      await assertConditions();
      await assertNoPendingTransactions(root, kind);
      await assertParents();
      operation = `create ${key(journalPathParts)}`;
      loaded = { header, snapshot: await createJournal(root, header, headerBytes, lease), pendingIndex: -1, committed: false };
      await options.onCheckpoint?.({ phase: 'prepared' });
      for (const [index, mutation] of selected.entries()) {
        operation = `${mutation.type} ${key(mutation.pathParts)}`;
        const callbackMutation: ProjectFileMutation = mutation.type === 'write'
          ? { ...mutation, pathParts: [...mutation.pathParts], content: Buffer.from(mutation.content) }
          : { ...mutation, pathParts: [...mutation.pathParts] };
        await options.onBeforeMutation?.(callbackMutation, index);
        await lease.assertHeld();
        await assertConditions();
        const frame: JournalFrame = { phase: 'mutation', index };
        await approvalStore.write(header.planFingerprint, frameDigest(header, frame));
        loaded.snapshot = await appendFrame(root, loaded.snapshot, frame, lease);
        loaded.pendingIndex = index;
        await options.onCheckpoint?.({ phase: 'before-mutation', index });
        await assertConditions();
        await durableMutation(root, header, index, false, lease,
          () => options.onCheckpoint?.({ phase: 'staged', index }) ?? Promise.resolve());
        conditions.set(folded(key(mutation.pathParts)), { pathParts: mutation.pathParts, stored: stored[index].target });
        await options.onCheckpoint?.({ phase: 'after-mutation', index });
      }
      operation = `commit reviewed ${kind}`;
      await options.onCheckpoint?.({ phase: 'before-commit' });
      await options.onBeforeCommit?.();
      await lease.assertHeld();
      if (validateCurrentInputs) {
        await validateCurrentInputs('before-commit');
        await lease.assertHeld();
      }
      await assertConditions();
      await assertJournalCurrent(root, loaded.snapshot);
      await approvalStore.write(header.planFingerprint, frameDigest(header, { phase: 'committed' }));
      committed = true;
      loaded.committed = true;
      loaded.snapshot = await appendFrame(root, loaded.snapshot, { phase: 'committed' }, lease);
      await options.onCheckpoint?.({ phase: 'committed' });
      return { ...outcome('committed', loaded), cleanupFailures: await cleanupJournal(root, loaded, approvalStore, lease) };
    } catch (error) {
      if (committed) {
        return {
          ...outcome('committed', loaded),
          committed: true, cleanupFailures: [`Committed transaction finalization: ${errorMessage(error)}`]
        };
      }
      let recovered: ReviewedUpdateTransactionOutcome | undefined;
      try {
        const current = await loadJournal(root, kind, approvalStore);
        if (current) {
          recovered = await recoverLocked(root, current, approvalStore, lease);
          if (recovered.committed) {
            recovered.cleanupFailures.unshift(`Committed transaction finalization: ${errorMessage(error)}`);
            return recovered;
          }
        } else {
          await approvalStore.remove(header.planFingerprint, header.transactionDigest);
          await approvalStore.remove(header.planFingerprint, rollbackCleanupDigest(header));
          if (header.missingDirectories.some((parts) => key(parts) === '.liftoff')) {
            try {
              await lease.assertHeld();
              await rmdir(await safePath(root, ['.liftoff']));
              await syncDirectory(root);
            } catch (cleanupError) {
              if (errorCode(cleanupError) !== 'ENOENT') throw cleanupError;
            }
          }
        }
      } catch (recoveryError) {
        throw new ReviewedUpdateTransactionError(
          `Project ${kind} failed to ${operation}: ${errorMessage(error)} Recovery blocked: ${errorMessage(recoveryError)}`,
          [errorMessage(recoveryError)]
        );
      }
      const failures = [...recovered?.rollbackFailures ?? [], ...recovered?.cleanupFailures ?? []];
      throw new ReviewedUpdateTransactionError(
        `Project ${kind} failed to ${operation}: ${errorMessage(error)} ${failures.length
          ? `Recovery incomplete: ${failures.join('; ')}` : 'All attributable changes were rolled back.'}`,
        failures
      );
    }
  });
}
