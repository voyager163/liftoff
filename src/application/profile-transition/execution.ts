import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import {
  readBoundProjectFileSnapshot
} from '../../adapters/filesystem/bound-project-files.js';
import {
  applyProfileTransitionTransaction,
  inspectProfileTransitionTransaction,
  recoverProfileTransitionTransaction,
  type ReviewedUpdateTransactionOutcome
} from '../../adapters/filesystem/reviewed-update-transaction.js';
import type {
  UpdatePreviewOptions
} from '../../adapters/filesystem/update-previews.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import {
  assertProfileTransitionPlanCurrent,
  assertProfileTransitionControlsCurrent,
  readProfileTransitionPlan,
  rebuildProfileTransitionCandidate,
  type ProfileTransitionPlan
} from './plan.js';
import {
  createProfileTransitionTransactionAuthorityStore
} from './transaction-authority.js';

export interface ProfileTransitionExecutionOutcome {
  readonly operation: 'apply' | 'recover';
  readonly status:
    | 'absent'
    | 'rolled-back'
    | 'blocked'
    | 'committed-cleanup-pending'
    | 'committed-readback-failed'
    | 'committed';
  readonly committed: boolean;
  readonly transactionDigest: string | null;
  readonly readbackDigest: string | null;
  readonly rollbackFailures: readonly string[];
  readonly cleanupFailures: readonly string[];
  readonly readbackFailures: readonly string[];
}

const sha256 = (value: Buffer): string =>
  createHash('sha256').update(value).digest('hex');

async function readback(plan: ProfileTransitionPlan): Promise<string> {
  const observations = [];
  for (const effect of plan.effects) {
    const observed = await readBoundProjectFileSnapshot(
      plan.projectRoot,
      effect.pathParts,
      {
        maximumBytes: 8 * 1024 * 1024,
        linkPolicy: 'transaction-compatible',
        diagnostics: {
          pathLabel: `Profile transition readback ${effect.pathParts.join('/')}`,
          invalid(detail): never {
            throw new Error(detail);
          }
        }
      }
    );
    if (observed.content === undefined ||
        sha256(observed.content) !== effect.contentDigest ||
        observed.content.length !== effect.contentBytes ||
        observed.mode !== effect.mode) {
      throw new Error(
        `Profile transition readback differs from reviewed ${effect.operation} bytes: ${effect.pathParts.join('/')}.`
      );
    }
    observations.push({
      operation: effect.operation,
      logicalName: effect.logicalName,
      pathParts: effect.pathParts,
      contentDigest: effect.contentDigest,
      contentBytes: effect.contentBytes,
      mode: effect.mode
    });
  }
  return canonicalSha256({
    schemaVersion: 1,
    kind: 'liftoff-profile-transition-readback',
    projectRoot: plan.projectRoot,
    planFingerprint: plan.fingerprint,
    sourceProfile: plan.source.profile,
    targetProfile: plan.target.profile,
    effects: observations,
    evidenceReusableForTarget: false,
    providerOperations: false
  });
}

function outcome(
  operation: 'apply' | 'recover',
  transaction: ReviewedUpdateTransactionOutcome,
  readbackDigest: string | null,
  readbackFailures: readonly string[]
): ProfileTransitionExecutionOutcome {
  const status = transaction.committed
    ? readbackFailures.length
      ? 'committed-readback-failed'
      : transaction.cleanupFailures.length
        ? 'committed-cleanup-pending'
        : 'committed'
    : transaction.status;
  return Object.freeze({
    operation,
    status,
    committed: transaction.committed,
    transactionDigest: transaction.transactionDigest ?? null,
    readbackDigest,
    rollbackFailures: Object.freeze([...transaction.rollbackFailures]),
    cleanupFailures: Object.freeze([...transaction.cleanupFailures]),
    readbackFailures: Object.freeze([...readbackFailures])
  });
}

export async function applyProfileTransitionPlan(
  plan: ProfileTransitionPlan,
  options: {
    readonly now: Date;
    readonly storage?: UpdatePreviewOptions;
  }
): Promise<ProfileTransitionExecutionOutcome> {
  await assertProfileTransitionPlanCurrent(plan);
  const candidate = await rebuildProfileTransitionCandidate(plan);
  const authorityStore = createProfileTransitionTransactionAuthorityStore(
    plan.projectRoot,
    options.storage
  );
  const existing = await inspectProfileTransitionTransaction(
    plan.projectRoot,
    { authorityStore }
  );
  if (existing.status !== 'absent') {
    return Object.freeze({
      operation: 'apply',
      status: 'blocked',
      committed: existing.committed,
      transactionDigest: existing.transactionDigest ?? null,
      readbackDigest: null,
      rollbackFailures: Object.freeze([
        existing.reason ??
          'A profile transition recovery journal already exists.'
      ]),
      cleanupFailures: Object.freeze([]),
      readbackFailures: Object.freeze([])
    });
  }
  const transaction = await applyProfileTransitionTransaction(
    plan.projectRoot,
    candidate.mutations,
    {
      planFingerprint: plan.fingerprint,
      authorityStore,
      preconditions: candidate.preconditions,
      expectedCandidateBinding:
        plan.execution.transactionCandidateBinding,
      validateCurrentInputs: async stage => {
        if (stage === 'before-commit') {
          const stored = await readProfileTransitionPlan(
            plan.projectRoot,
            plan.fingerprint,
            options.now,
            options.storage
          );
          if (canonicalSha256(stored) !== canonicalSha256(plan)) {
            throw new Error(
              'Stored profile transition plan changed before commit.'
            );
          }
          await assertProfileTransitionControlsCurrent(plan);
          return;
        }
        await assertProfileTransitionPlanCurrent(plan);
      }
    }
  );
  let readbackDigest: string | null = null;
  const readbackFailures: string[] = [];
  if (transaction.committed) {
    try {
      readbackDigest = await readback(plan);
    } catch (error) {
      readbackFailures.push(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  return outcome('apply', transaction, readbackDigest, readbackFailures);
}

export async function recoverProfileTransitionPlan(
  projectRoot: string,
  fingerprint: string,
  options: {
    readonly now: Date;
    readonly storage?: UpdatePreviewOptions;
  }
): Promise<ProfileTransitionExecutionOutcome> {
  const plan = await readProfileTransitionPlan(
    projectRoot,
    fingerprint,
    options.now,
    options.storage,
    true
  );
  return recoverProfileTransitionJournal(
    plan.projectRoot,
    fingerprint,
    {
      storage: options.storage,
      plan
    }
  );
}

export async function recoverProfileTransitionJournal(
  projectRoot: string,
  fingerprint: string,
  options: {
    readonly storage?: UpdatePreviewOptions;
    readonly plan?: ProfileTransitionPlan;
  } = {}
): Promise<ProfileTransitionExecutionOutcome> {
  const root = await realpath(projectRoot);
  const plan = options.plan;
  if (plan &&
      (plan.projectRoot !== root || plan.fingerprint !== fingerprint)) {
    return outcome('recover', {
      status: 'blocked',
      committed: false,
      rollbackFailures: [
        'Profile transition recovery plan does not match the selected project and fingerprint.'
      ],
      cleanupFailures: []
    }, null, []);
  }
  const authorityStore = createProfileTransitionTransactionAuthorityStore(
    root,
    options.storage
  );
  const observed = await inspectProfileTransitionTransaction(
    root,
    { authorityStore }
  );
  if (observed.status === 'absent') {
    return outcome('recover', {
      status: 'absent',
      committed: false,
      rollbackFailures: [],
      cleanupFailures: []
    }, null, []);
  }
  if (observed.status === 'blocked' ||
      observed.planFingerprint !== fingerprint ||
      !observed.transactionDigest) {
    return outcome('recover', {
      status: 'blocked',
      committed: false,
      rollbackFailures: [
        observed.reason ??
          'Profile transition recovery journal is not attributable to the selected plan.'
      ],
      cleanupFailures: []
    }, null, []);
  }
  const transaction = await recoverProfileTransitionTransaction(
    root,
    {
      authorityStore,
      expectedTransaction: {
        planFingerprint: fingerprint,
        transactionDigest: observed.transactionDigest
      }
    }
  );
  let readbackDigest: string | null = null;
  const readbackFailures: string[] = [];
  if (transaction.committed && plan) {
    try {
      readbackDigest = await readback(plan);
    } catch (error) {
      readbackFailures.push(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  return outcome('recover', transaction, readbackDigest, readbackFailures);
}
