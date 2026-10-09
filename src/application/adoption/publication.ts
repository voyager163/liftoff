import { createHash } from 'node:crypto';
import {
  readBoundProjectFileSnapshot
} from '../../adapters/filesystem/bound-project-files.js';
import {
  applyAdoptionTransaction, inspectAdoptionTransaction,
  recoverAdoptionTransaction, ReviewedUpdateTransactionError,
  type ReviewedUpdateTransactionOutcome
} from '../../adapters/filesystem/reviewed-update-transaction.js';
import {
  canonicalSha256
} from '../../domain/governance/activation/canonical-json.js';
import {
  applicationBounds
} from '../repair/application-types.js';
import {
  createAdoptionTransactionAuthorityStore
} from './transaction-authority.js';
import {
  adoptionVerificationTime
} from './verification-result.js';
import {
  loadAdoptionPublicationPlan, readStoredAdoptionPublicationPlan,
  type AdoptionPublicationPlan, type AdoptionPublicationPlanOptions,
  type AdoptionPublicationPlanReport
} from './publication-plan.js';

export const adoptionPublicationOutcomeSchemaVersion = 1 as const;

export interface AdoptionPublicationOutcome {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-adoption-publication-outcome';
  readonly operation: 'publish' | 'recover';
  readonly projectRoot: string;
  readonly publicationPlanFingerprint: string;
  readonly transactionCandidateBinding: string;
  readonly transactionDigest: string | null;
  readonly status:
    | 'absent'
    | 'rolled-back'
    | 'blocked'
    | 'committed-cleanup-pending'
    | 'committed-readback-failed'
    | 'committed';
  readonly committed: boolean;
  readonly readbackDigest: string | null;
  readonly rollbackFailures: readonly string[];
  readonly cleanupFailures: readonly string[];
  readonly readbackFailures: readonly string[];
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return canonicalSha256(left) === canonicalSha256(right);
}

async function readEffectSnapshot(
  projectRoot: string, pathParts: readonly string[]
) {
  return readBoundProjectFileSnapshot(projectRoot, pathParts, {
    maximumBytes: applicationBounds.fileBytes,
    linkPolicy: 'transaction-compatible',
    diagnostics: {
      pathLabel: `Adoption publication readback ${pathParts.join('/')}`,
      invalid(detail): never {
        throw new Error(
          `Unsafe adoption publication readback ${pathParts.join('/')}: ${detail}`
        );
      }
    }
  });
}

async function readbackEffects(
  report: AdoptionPublicationPlanReport
): Promise<string> {
  const observations = [];
  for (const effect of report.effects) {
    const snapshot = await readEffectSnapshot(
      report.projectRoot, effect.pathParts
    );
    if (!snapshot.content ||
        digest(snapshot.content) !== effect.contentDigest ||
        snapshot.content.length !== effect.contentBytes ||
        snapshot.mode !== effect.mode) {
      throw new Error(
        `Committed adoption effect differs from the exact approved bytes or mode: ${effect.pathParts.join('/')}.`
      );
    }
    observations.push({
      pathParts: effect.pathParts,
      contentDigest: effect.contentDigest,
      contentBytes: effect.contentBytes,
      mode: effect.mode
    });
  }
  return canonicalSha256({
    schemaVersion: 1,
    kind: 'liftoff-adoption-publication-readback',
    projectRoot: report.projectRoot,
    publicationPlanFingerprint: report.fingerprint,
    effects: observations
  });
}

async function assertProtectedApplicationUnchanged(
  plan: AdoptionPublicationPlan
): Promise<void> {
  for (const expected of plan.preconditions) {
    if (plan.report.effects.some(effect =>
      samePath(effect.pathParts, expected.pathParts))) {
      continue;
    }
    const actual = await readEffectSnapshot(
      plan.report.projectRoot, expected.pathParts
    );
    if (expected.content === undefined
      ? actual.content !== undefined
      : actual.content === undefined ||
        !actual.content.equals(expected.content) ||
        actual.mode !== expected.mode) {
      throw new Error(
        `Protected adoption input changed during publication: ${expected.pathParts.join('/')}.`
      );
    }
  }
}

function outcome(
  operation: AdoptionPublicationOutcome['operation'],
  report: AdoptionPublicationPlanReport,
  transaction?: ReviewedUpdateTransactionOutcome,
  readbackDigest: string | null = null,
  readbackFailures: readonly string[] = []
): AdoptionPublicationOutcome {
  const committed = transaction?.committed === true;
  const status = committed
    ? readbackFailures.length
      ? 'committed-readback-failed'
      : transaction!.cleanupFailures.length
      ? 'committed-cleanup-pending'
      : 'committed'
    : transaction?.status === 'rolled-back'
      ? 'rolled-back'
      : transaction?.status === 'absent'
        ? 'absent'
        : 'blocked';
  return Object.freeze({
    schemaVersion: adoptionPublicationOutcomeSchemaVersion,
    kind: 'liftoff-adoption-publication-outcome',
    operation,
    projectRoot: report.projectRoot,
    publicationPlanFingerprint: report.fingerprint,
    transactionCandidateBinding: report.transactionCandidateBinding,
    transactionDigest: transaction?.transactionDigest ?? null,
    status,
    committed,
    readbackDigest,
    rollbackFailures: Object.freeze([
      ...transaction?.rollbackFailures ?? []
    ]),
    cleanupFailures: Object.freeze([
      ...transaction?.cleanupFailures ?? []
    ]),
    readbackFailures: Object.freeze([...readbackFailures])
  });
}

function assertSamePublicationPlan(
  expected: AdoptionPublicationPlan,
  actual: AdoptionPublicationPlan
): void {
  if (canonicalSha256(actual.report) !== canonicalSha256(expected.report) ||
      actual.report.transactionCandidateBinding !==
        expected.report.transactionCandidateBinding ||
      canonicalSha256(actual.mutations.map((mutation, index) => ({
        type: mutation.type,
        pathParts: mutation.pathParts,
        effect: actual.report.effects[index]
      }))) !==
        canonicalSha256(expected.mutations.map((mutation, index) => ({
          type: mutation.type,
          pathParts: mutation.pathParts,
          effect: expected.report.effects[index]
        }))) ||
      canonicalSha256(actual.preconditions.map(snapshot => ({
        pathParts: snapshot.pathParts,
        digest: snapshot.content === undefined ? null : digest(snapshot.content),
        mode: snapshot.mode ?? null
      }))) !== expected.report.preconditionDigest) {
    throw new Error(
      'Adoption publication inputs changed after file approval.'
    );
  }
}

export async function publishAdoptionPlan(
  projectRoot: string,
  publicationPlanFingerprint: string,
  source: unknown,
  options: AdoptionPublicationPlanOptions = {}
): Promise<AdoptionPublicationOutcome> {
  const plan = await loadAdoptionPublicationPlan(
    projectRoot, publicationPlanFingerprint, source, options
  );
  const authorityStore = createAdoptionTransactionAuthorityStore(
    plan.report.projectRoot, options.storage
  );
  let transactionDigest: string | null = null;
  let committedReadback: string | null = null;
  const committedReadbackFailures: string[] = [];
  let transaction: ReviewedUpdateTransactionOutcome;
  try {
    transaction = await applyAdoptionTransaction(
      plan.report.projectRoot,
      plan.mutations,
      {
      planFingerprint: plan.report.fingerprint,
      authorityStore,
      preconditions: plan.preconditions,
      expectedCandidateBinding: plan.report.transactionCandidateBinding,
      validateCurrentInputs: async stage => {
        if (stage !== 'before-commit') {
          const current = await loadAdoptionPublicationPlan(
            plan.report.projectRoot,
            plan.report.fingerprint,
            source,
            options
          );
          assertSamePublicationPlan(plan, current);
          return;
        }
        const stored = await readStoredAdoptionPublicationPlan(
          plan.report.projectRoot,
          plan.report.fingerprint,
          options.storage
        );
        if (canonicalSha256(stored) !== canonicalSha256(plan.report) ||
            adoptionVerificationTime(options.storage).getTime() >=
              Date.parse(stored.expiresAt)) {
          throw new Error(
            'Adoption publication approval expired or changed before commit.'
          );
        }
        const observed = await inspectAdoptionTransaction(
          plan.report.projectRoot, { authorityStore }
        );
        if (observed.status !== 'interrupted' ||
            observed.planFingerprint !== plan.report.fingerprint ||
            !observed.transactionDigest ||
            transactionDigest !== observed.transactionDigest) {
          throw new Error(
            'Adoption precommit journal differs from the approved publication transaction.'
          );
        }
      },
      onCheckpoint: async checkpoint => {
        if (checkpoint.phase !== 'prepared' &&
            checkpoint.phase !== 'committed') {
          return;
        }
        const observed = await inspectAdoptionTransaction(
          plan.report.projectRoot, { authorityStore }
        );
        if (observed.status !==
              (checkpoint.phase === 'committed'
                ? 'committed'
                : 'interrupted') ||
            observed.planFingerprint !== plan.report.fingerprint ||
            !observed.transactionDigest ||
            transactionDigest !== null &&
              transactionDigest !== observed.transactionDigest) {
          throw new Error(
            'Adoption checkpoint lacks its exact plan and transaction attribution.'
          );
        }
        transactionDigest = observed.transactionDigest;
        if (checkpoint.phase === 'committed') {
          try {
            await assertProtectedApplicationUnchanged(plan);
            committedReadback = await readbackEffects(plan.report);
          } catch (error) {
            committedReadbackFailures.push(
              error instanceof Error
                ? error.message
                : 'Committed adoption readback failed.'
            );
          }
        }
      }
      }
    );
  } catch (error) {
    if (!(error instanceof ReviewedUpdateTransactionError) ||
        transactionDigest === null) {
      throw error;
    }
    const observed = await inspectAdoptionTransaction(
      plan.report.projectRoot, { authorityStore }
    );
    transaction = observed.status === 'absent' &&
      error.rollbackFailures.length === 0
      ? {
          status: 'rolled-back',
          committed: false,
          planFingerprint: plan.report.fingerprint,
          transactionDigest,
          rollbackFailures: [],
          cleanupFailures: []
        }
      : {
          status: 'blocked',
          committed: false,
          planFingerprint: plan.report.fingerprint,
          transactionDigest,
          rollbackFailures: error.rollbackFailures.length
            ? [...error.rollbackFailures]
            : [
                observed.reason ??
                  'Adoption publication failed and authenticated recovery remains required.'
              ],
          cleanupFailures: []
        };
  }
  if (transaction.transactionDigest !== transactionDigest) {
    throw new Error(
      'Adoption transaction outcome differs from its observed authenticated journal.'
    );
  }
  return outcome(
    'publish', plan.report, transaction, committedReadback,
    committedReadbackFailures
  );
}

export async function recoverAdoptionPlan(
  projectRoot: string,
  publicationPlanFingerprint: string,
  options: Pick<AdoptionPublicationPlanOptions, 'storage'> = {}
): Promise<AdoptionPublicationOutcome> {
  const report = await readStoredAdoptionPublicationPlan(
    projectRoot, publicationPlanFingerprint, options.storage
  );
  const authorityStore = createAdoptionTransactionAuthorityStore(
    report.projectRoot, options.storage
  );
  const observed = await inspectAdoptionTransaction(
    report.projectRoot, { authorityStore }
  );
  if (observed.status === 'absent') {
    return outcome('recover', report, {
      status: 'absent',
      committed: false,
      rollbackFailures: [],
      cleanupFailures: []
    });
  }
  if (observed.status === 'blocked' ||
      observed.planFingerprint !== report.fingerprint ||
      !observed.transactionDigest) {
    return outcome('recover', report, {
      status: 'blocked',
      committed: false,
      rollbackFailures: [
        observed.reason ??
          'The adoption transaction is absent or belongs to a different approved plan.'
      ],
      cleanupFailures: []
    });
  }
  const transaction = await recoverAdoptionTransaction(
    report.projectRoot,
    {
      authorityStore,
      expectedTransaction: {
        planFingerprint: report.fingerprint,
        transactionDigest: observed.transactionDigest
      }
    }
  );
  if ((transaction.status !== 'blocked' ||
      transaction.planFingerprint !== undefined ||
      transaction.transactionDigest !== undefined) &&
      (transaction.planFingerprint !== report.fingerprint ||
        transaction.transactionDigest !== observed.transactionDigest)) {
    throw new Error(
      'Adoption recovery returned different plan or transaction attribution.'
    );
  }
  let readbackDigest: string | null = null;
  const readbackFailures: string[] = [];
  if (transaction.committed && transaction.cleanupFailures.length === 0) {
    try {
      readbackDigest = await readbackEffects(report);
    } catch (error) {
      readbackFailures.push(
        error instanceof Error
          ? error.message
          : 'Committed adoption readback failed.'
      );
    }
  }
  return outcome(
    'recover', report, transaction, readbackDigest, readbackFailures
  );
}
