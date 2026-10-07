import path from 'node:path';
import { types } from 'node:util';
import {
  canonicalSha256, isRecord
} from '../../domain/governance/activation/canonical-json.js';
import {
  claimAdoptionVerificationAttempt as claimAuthenticatedAttempt,
  readAdoptionVerificationAttempt as readAuthenticatedAttempt,
  updateAdoptionVerificationAttempt as updateAuthenticatedAttempt,
  type AuthenticatedAdoptionVerificationAttempt,
  type RepairWorkspaceFileIdentity,
  type RepairWorkspaceStorageOptions
} from '../repair/workspaces.js';
import {
  validateWorkspaceFileIdentity
} from '../repair/workspaces-records.js';
import {
  adoptionVerificationResultSchemaVersion, adoptionVerificationTime,
  type AdoptionVerificationExecutionResult,
  type AdoptionVerificationIdentity
} from './verification-result.js';

export type AdoptionVerificationAttemptPhase =
  | 'claimed' | 'executing' | 'verified' | 'failed' | 'uncertain';

export interface AdoptionVerificationAttempt {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-adoption-verification-attempt';
  readonly projectRoot: string;
  readonly reviewFingerprint: string;
  readonly destinationPlanFingerprint: string;
  readonly compatibilityPlanFingerprint: string;
  readonly verificationPlanFingerprint: string;
  readonly consentFingerprint: string;
  readonly attemptId: string;
  readonly phase: AdoptionVerificationAttemptPhase;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly staging: {
    readonly path: string;
    readonly identity: RepairWorkspaceFileIdentity | null;
  };
  readonly workspaceId: string | null;
  readonly draft: AdoptionVerificationExecutionResult | null;
}

export interface SavedAdoptionVerificationAttempt {
  readonly attempt: AdoptionVerificationAttempt;
  readonly digest: string;
}

function exactRecord(
  value: unknown, fields: readonly string[], message: string
): Record<string, unknown> {
  if (!isRecord(value) || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(message);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length ||
      keys.some(key => typeof key !== 'string' || !fields.includes(key)) ||
      fields.some(field => {
        const descriptor = descriptors[field];
        return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
      })) {
    throw new Error(message);
  }
  return Object.fromEntries(
    fields.map(field => [field, descriptors[field]!.value])
  );
}

function digest(value: unknown, message: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(message);
  }
}

function attemptTimestamp(
  value: unknown, message: string
): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(message);
  }
}

function validateAttemptDraft(
  value: unknown,
  expected: {
    identity: AdoptionVerificationIdentity;
    consentFingerprint: string;
    phase: AdoptionVerificationAttemptPhase;
    workspaceId: string | null;
  }
): AdoptionVerificationExecutionResult | null {
  if (value === null) {
    if (!['claimed', 'executing'].includes(expected.phase)) {
      throw new Error('Saved adoption verification attempt lacks its result draft.');
    }
    return null;
  }
  if (!isRecord(value)) {
    throw new Error('Saved adoption verification attempt result is invalid.');
  }
  const draft = value as unknown as AdoptionVerificationExecutionResult;
  const expectedStatus = expected.phase === 'verified'
    ? 'passed'
    : expected.phase === 'uncertain' ? 'uncertain' : 'failed';
  if (['claimed', 'executing'].includes(expected.phase) ||
      draft.schemaVersion !== adoptionVerificationResultSchemaVersion ||
      draft.kind !== 'liftoff-adoption-verification-result' ||
      draft.projectRoot !== expected.identity.projectRoot ||
      draft.reviewFingerprint !== expected.identity.reviewFingerprint ||
      draft.destinationPlanFingerprint !==
        expected.identity.destinationPlanFingerprint ||
      draft.compatibilityPlanFingerprint !==
        expected.identity.compatibilityPlanFingerprint ||
      draft.verificationPlanFingerprint !==
        expected.identity.verificationPlanFingerprint ||
      draft.consentFingerprint !== expected.consentFingerprint ||
      draft.workspaceId !==
        (expected.workspaceId ?? canonicalSha256('unallocated')) ||
      draft.status !== expectedStatus ||
      !Array.isArray(draft.commands) ||
      !Array.isArray(draft.preparation) ||
      !Array.isArray(draft.blockers) ||
      !Array.isArray(draft.limitations) ||
      draft.receiptFingerprint !== null ||
      draft.approval !== 'not-requested' ||
      draft.transaction !== 'not-authorized' ||
      draft.publication !== 'not-authorized') {
    throw new Error(
      'Saved adoption verification attempt result is invalid or bound to different authority.'
    );
  }
  if (expected.phase === 'verified' &&
      (draft.cleanupComplete !== false ||
       draft.compatibility !== 'not-verified' ||
       draft.inputsUnchanged !== true ||
       draft.blockers.length !== 0 ||
       typeof draft.retainedWorkspace !== 'string')) {
    throw new Error(
      'Saved adoption verification attempt is not a non-authoritative verified draft.'
    );
  }
  return structuredClone(draft);
}

function validateAttempt(
  value: unknown,
  identity: AdoptionVerificationIdentity,
  consentFingerprint: string
): AdoptionVerificationAttempt {
  const record = exactRecord(value, [
    'schemaVersion', 'kind', 'projectRoot', 'reviewFingerprint',
    'destinationPlanFingerprint', 'compatibilityPlanFingerprint',
    'verificationPlanFingerprint', 'consentFingerprint', 'attemptId',
    'phase', 'startedAt', 'updatedAt', 'staging', 'workspaceId', 'draft'
  ], 'Saved adoption verification attempt is invalid.');
  if (record.schemaVersion !== 1 ||
      record.kind !== 'liftoff-adoption-verification-attempt' ||
      record.projectRoot !== identity.projectRoot ||
      record.reviewFingerprint !== identity.reviewFingerprint ||
      record.destinationPlanFingerprint !==
        identity.destinationPlanFingerprint ||
      record.compatibilityPlanFingerprint !==
        identity.compatibilityPlanFingerprint ||
      record.verificationPlanFingerprint !==
        identity.verificationPlanFingerprint ||
      record.consentFingerprint !== consentFingerprint ||
      !path.isAbsolute(record.projectRoot as string) ||
      typeof record.phase !== 'string' ||
      !['claimed', 'executing', 'verified', 'failed', 'uncertain']
        .includes(record.phase)) {
    throw new Error(
      'Saved adoption verification attempt belongs to different or unsupported authority.'
    );
  }
  digest(record.attemptId, 'Saved adoption verification attempt identity is invalid.');
  attemptTimestamp(
    record.startedAt, 'Saved adoption verification attempt start time is invalid.'
  );
  attemptTimestamp(
    record.updatedAt, 'Saved adoption verification attempt update time is invalid.'
  );
  if (Date.parse(record.updatedAt) < Date.parse(record.startedAt)) {
    throw new Error('Saved adoption verification attempt predates its claim.');
  }
  const staging = exactRecord(
    record.staging, ['path', 'identity'],
    'Saved adoption verification staging identity is invalid.'
  );
  if (typeof staging.path !== 'string' || !path.isAbsolute(staging.path) ||
      path.normalize(staging.path) !== staging.path) {
    throw new Error('Saved adoption verification staging path is invalid.');
  }
  const stagingIdentity = staging.identity === null
    ? null
    : validateWorkspaceFileIdentity(staging.identity);
  if (record.workspaceId !== null) {
    digest(
      record.workspaceId,
      'Saved adoption verification workspace identity is invalid.'
    );
  }
  if (record.phase === 'claimed' && record.workspaceId !== null ||
      ['executing', 'verified'].includes(record.phase) &&
        record.workspaceId === null) {
    throw new Error('Saved adoption verification attempt phase is inconsistent.');
  }
  const phase = record.phase as AdoptionVerificationAttemptPhase;
  const draft = validateAttemptDraft(record.draft, {
    identity, consentFingerprint, phase,
    workspaceId: record.workspaceId as string | null
  });
  return Object.freeze(structuredClone({
    ...record,
    phase,
    staging: { path: staging.path as string, identity: stagingIdentity },
    workspaceId: record.workspaceId as string | null,
    draft
  })) as unknown as AdoptionVerificationAttempt;
}

function savedAttempt(
  saved: AuthenticatedAdoptionVerificationAttempt,
  identity: AdoptionVerificationIdentity,
  consentFingerprint: string
): SavedAdoptionVerificationAttempt {
  return Object.freeze({
    attempt: validateAttempt(saved.value, identity, consentFingerprint),
    digest: saved.digest
  });
}

export async function claimAdoptionVerificationExecution(
  identity: AdoptionVerificationIdentity,
  consentFingerprint: string,
  attemptId: string,
  stagingPath: string,
  storage?: RepairWorkspaceStorageOptions
): Promise<{
  readonly acquired: boolean;
  readonly saved: SavedAdoptionVerificationAttempt;
}> {
  digest(attemptId, 'Adoption verification attempt identity is invalid.');
  const timestamp = adoptionVerificationTime(storage).toISOString();
  const value: AdoptionVerificationAttempt = {
    schemaVersion: 1,
    kind: 'liftoff-adoption-verification-attempt',
    ...identity,
    consentFingerprint,
    attemptId,
    phase: 'claimed',
    startedAt: timestamp,
    updatedAt: timestamp,
    staging: { path: stagingPath, identity: null },
    workspaceId: null,
    draft: null
  };
  const claimed = await claimAuthenticatedAttempt(
    identity.projectRoot, identity.verificationPlanFingerprint, value, storage
  );
  return {
    acquired: claimed.acquired,
    saved: savedAttempt(claimed.attempt, identity, consentFingerprint)
  };
}

export async function updateAdoptionVerificationExecutionAttempt(
  saved: SavedAdoptionVerificationAttempt,
  identity: AdoptionVerificationIdentity,
  consentFingerprint: string,
  next: Pick<
    AdoptionVerificationAttempt,
    'phase' | 'staging' | 'workspaceId' | 'draft'
  >,
  storage?: RepairWorkspaceStorageOptions
): Promise<SavedAdoptionVerificationAttempt> {
  const transitions: Record<
    AdoptionVerificationAttemptPhase,
    readonly AdoptionVerificationAttemptPhase[]
  > = {
    claimed: ['claimed', 'executing', 'failed'],
    executing: ['verified', 'failed', 'uncertain'],
    verified: [],
    failed: [],
    uncertain: []
  };
  if (!transitions[saved.attempt.phase].includes(next.phase)) {
    throw new Error(
      'Adoption verification attempt transition is not authorized.'
    );
  }
  const value = validateAttempt({
    ...saved.attempt,
    ...next,
    updatedAt: adoptionVerificationTime(storage).toISOString()
  }, identity, consentFingerprint);
  const updated = await updateAuthenticatedAttempt(
    identity.projectRoot, identity.verificationPlanFingerprint,
    saved.digest, value, storage
  );
  return savedAttempt(updated, identity, consentFingerprint);
}

export async function readAdoptionVerificationExecutionAttempt(
  identity: AdoptionVerificationIdentity,
  consentFingerprint: string,
  storage?: RepairWorkspaceStorageOptions
): Promise<SavedAdoptionVerificationAttempt | null> {
  const saved = await readAuthenticatedAttempt(
    identity.projectRoot, identity.verificationPlanFingerprint, storage
  );
  return saved ? savedAttempt(saved, identity, consentFingerprint) : null;
}
