import {
  applyProjectFileTransaction,
  captureProjectFileSnapshot,
  type ProjectFileMutation
} from '../../adapters/filesystem/project-transaction.js';
import { withProjectMutationLock } from '../../adapters/filesystem/project-lock.js';
import { canonicalJson } from '../../domain/governance/activation/canonical-json.js';
import { manifestDisplayPath } from '../../domain/project/paths.js';
import {
  activationHistoryIndexPathParts, historicalActivationStatePathParts, migrationStateFilePathParts,
  parseHistoryJson, rawHistoryDigest, validateMigrationJournal, type MigrationJournal
} from '../../governance-activation/history-contracts.js';
import { finalizeActivationHistoryMigration } from '../../governance-activation/migration-history.js';
import type { ExecutionContext } from '../context.js';
import { UpdatePlanError, type UpdateInspection } from './inspection.js';
import type { UpdateMigrationSummary, UpdateRevalidationSummary } from './output.js';
import type { ReviewedUpdatePlan } from './review-plan.js';
import { executeLocalRevalidation, type LocalRevalidationProgress } from './revalidation.js';
import { postUpdateProtectedInputs } from './revalidation-plan.js';

export function describeUpdateMigration(inspection: UpdateInspection): UpdateMigrationSummary {
  const history = inspection.historyMigration;
  if (history.status === 'eligible') {
    const indexPath = activationHistoryIndexPathParts(history.index.snapshotId);
    return {
      status: 'available',
      sourceIdentity: history.semanticPlan.sourceIdentity,
      targetIdentity: history.semanticPlan.targetIdentity,
      snapshotId: history.index.snapshotId,
      historyPaths: history.index.files.map((file) => manifestDisplayPath(file.originalPathParts)),
      operations: [
        ...(history.historyDisposition === 'create'
          ? [...history.index.files.map((file) => file.copyPathParts), indexPath].map((parts) => ({
            type: 'write' as const, path: manifestDisplayPath(parts)
          })) : []),
        ...history.requiredRetirements.map((entry) => ({ type: 'delete' as const, path: manifestDisplayPath(entry.pathParts) })),
        { type: 'write', path: manifestDisplayPath([...historicalActivationStatePathParts]) },
        { type: 'write', path: manifestDisplayPath([...migrationStateFilePathParts]) }
      ],
      issues: ['Preserve original v1 bytes, create a linked v2 successor, and establish fresh local proof.']
    };
  }
  if (history.status === 'blocked') {
    return {
      status: 'blocked', reasonCode: history.reasonCode, sourceIdentity: null, targetIdentity: null,
      historyPaths: [], issues: history.issues
    };
  }
  if (history.status === 'current' && history.history.status === 'committed') {
    return {
      status: 'committed',
      sourceIdentity: history.history.journal.sourceIdentity,
      targetIdentity: history.history.journal.targetIdentity,
      snapshotId: history.history.journal.snapshotId,
      historyPaths: history.history.index.files.map((file) => manifestDisplayPath(file.originalPathParts)),
      issues: []
    };
  }
  return { status: 'not-required', sourceIdentity: null, targetIdentity: null, historyPaths: [], issues: [] };
}

export function describeUpdateRevalidation(review: ReviewedUpdatePlan): UpdateRevalidationSummary {
  if (!review.revalidation) return { status: 'not-required', nextPhase: null, issues: [] };
  const issues = review.revalidation.preview.phases.flatMap((phase) =>
    phase.blockers.map((blocker) => `${phase.phaseId}: ${blocker}`)
  );
  return {
    status: issues.length ? 'blocked' : review.needsRevalidation ? 'pending' : 'complete',
    nextPhase: review.revalidation.preview.phases[0]?.phaseId ?? null,
    issues,
    preview: review.revalidation.preview
  };
}

export function materializeUpdateMutations(
  inspection: UpdateInspection,
  review: ReviewedUpdatePlan,
  now: Date
): { mutations: ProjectFileMutation[]; journal?: MigrationJournal } {
  if (inspection.historyMigration.status !== 'eligible') {
    return { mutations: review.writePlan.mutations };
  }
  const history = inspection.historyMigration;
  const finalized = finalizeActivationHistoryMigration(history, review.descriptor.fingerprint, now);
  const snapshotKeys = new Set([
    activationHistoryIndexPathParts(history.index.snapshotId).join('\0'),
    ...history.index.files.map((file) => file.copyPathParts.join('\0'))
  ]);
  const before = finalized.mutations.filter((mutation) => snapshotKeys.has(mutation.pathParts.join('\0')));
  const successor = finalized.mutations.filter((mutation) => !snapshotKeys.has(mutation.pathParts.join('\0')));
  const core = review.writePlan.mutations.filter((mutation) => mutation.pathParts.join('\0') !== 'liftoff.manifest.json');
  const manifest = review.writePlan.mutations.filter((mutation) => mutation.pathParts.join('\0') === 'liftoff.manifest.json');
  if (manifest.length !== 1) {
    throw new UpdatePlanError('The successor has no uniquely planned manifest write.',
      'invalid-successor-plan', 'Run liftoff update --check again.');
  }
  return { mutations: [...before, ...core, ...successor, ...manifest], journal: finalized.journal };
}

export async function verifyHistoryBeforeReplacement(
  inspection: UpdateInspection,
  mutation: ProjectFileMutation
): Promise<void> {
  if (inspection.historyMigration.status !== 'eligible') return;
  const original = inspection.historyMigration.index.files.find((file) =>
    file.originalPathParts.join('\0') === mutation.pathParts.join('\0'));
  if (!original) return;
  const copy = await captureProjectFileSnapshot(inspection.projectRoot, original.copyPathParts);
  if (!copy.content || rawHistoryDigest(copy.content) !== original.digest) {
    throw new UpdatePlanError(
      `The original bytes were not safely preserved before replacement: ${manifestDisplayPath(mutation.pathParts)}`,
      'history-preservation-failed', 'Preserve the original data and review the transaction recovery report.'
    );
  }
}

export async function runUpdateRevalidation(
  inspection: UpdateInspection,
  review: ReviewedUpdatePlan,
  mutations: readonly ProjectFileMutation[],
  context: ExecutionContext,
  validateReview?: () => Promise<void>
): Promise<UpdateRevalidationSummary> {
  if (!review.revalidation) return { status: 'not-required', nextPhase: null, issues: [] };
  const prepared = review.revalidation;
  const now = context.updateNow ?? (() => new Date());
  return withProjectMutationLock(inspection.projectRoot, async () => {
    await validateReview?.();
    let journalSnapshot = await captureProjectFileSnapshot(inspection.projectRoot, [...migrationStateFilePathParts]);
    if (!journalSnapshot.content) {
      throw new UpdatePlanError('The committed migration journal is missing.',
        'migration-journal-missing', 'Preserve v2 and restore the declared migration history before retrying.');
    }
    let journal = validateMigrationJournal(parseHistoryJson(journalSnapshot.content, 'governance/migration-state.json'));
    const snapshotId = journal.snapshotId;
    let progressWrites = 0;
    const maximumProgressWrites = 2 * (prepared.preview.phases.length + prepared.preview.reusedPhases.length) + 2;
    const protectedInputs = postUpdateProtectedInputs(inspection, review.writePlan, prepared, mutations, context.runner);
    async function recordProgress(progress: LocalRevalidationProgress): Promise<void> {
      if (++progressWrites > maximumProgressWrites) {
        throw new UpdatePlanError('Local revalidation exceeded its approved progress-write bound.',
          'revalidation-scope-changed', 'Run a fresh update check before continuing.');
      }
      const activePhase = progress.phaseId ?? (
        progress.status === 'blocked'
          ? journal.revalidation.phases.find((phase) =>
            !progress.phaseResults.some((result) => result.phaseId === phase.phaseId &&
              (result.status === 'verified' || result.status === 'already-complete'))
          )?.phaseId ?? journal.revalidation.phases[0]?.phaseId
          : undefined
      );
      const phases = journal.revalidation.phases.map((phase) => {
        const result = progress.phaseResults.find((entry) => entry.phaseId === phase.phaseId);
        const reused = prepared.preview.reusedPhases.find((entry) => entry.phaseId === phase.phaseId);
        if (result?.status === 'verified' || result?.status === 'already-complete') {
          const evidenceId = result.evidence?.evidenceId ?? reused?.evidenceId;
          if (!evidenceId) throw new Error(`Revalidation supplied no evidence reference for ${phase.phaseId}.`);
          return { ...phase, status: 'complete' as const, evidenceIds: [evidenceId], blockers: [] };
        }
        if (result?.status === 'blocked') {
          return { ...phase, status: 'blocked' as const, evidenceIds: [], blockers: [...result.blockers] };
        }
        if (activePhase === phase.phaseId) {
          return {
            ...phase, status: progress.status === 'blocked' ? 'blocked' as const : 'running' as const,
            evidenceIds: [], blockers: progress.status === 'blocked' ? [...progress.blockers] : []
          };
        }
        if (reused) return { ...phase, status: 'complete' as const, evidenceIds: [reused.evidenceId], blockers: [] };
        if (prepared.preview.phases.some((entry) => entry.phaseId === phase.phaseId)) {
          return { ...phase, status: 'pending' as const, evidenceIds: [], blockers: [] };
        }
        return phase;
      });
      const status = progress.status === 'complete' && phases.some((phase) => phase.status !== 'complete')
        ? 'blocked' : progress.status;
      const nextAction = status === 'complete' ? null :
        progress.blockers.join('; ') || 'Continue only the next separately reviewed supported governance phase.';
      const next = validateMigrationJournal({
        ...journal,
        revalidation: { status, updatedAt: now().toISOString(), phases, nextAction }
      });
      if (next.snapshotId !== snapshotId) throw new Error('The active migration identity changed.');
      const content = canonicalJson(next);
      await applyProjectFileTransaction(inspection.projectRoot, [{
        type: 'write', pathParts: [...migrationStateFilePathParts], content
      }], { preconditions: [journalSnapshot] });
      journal = next;
      journalSnapshot = {
        pathParts: [...migrationStateFilePathParts],
        content: Buffer.from(content),
        mode: journalSnapshot.mode
      };
    }
    const result = await executeLocalRevalidation({
      approvedPreview: prepared.preview,
      protectedInputs,
      runner: context.runner,
      clock: now,
      onProgress: recordProgress
    });
    return {
      status: result.status === 'complete' && journal.revalidation.status === 'complete' ? 'complete' : 'blocked',
      nextPhase: result.nextIncompletePhase,
      issues: result.blockers.length ? result.blockers : journal.revalidation.nextAction ? [journal.revalidation.nextAction] : [],
      preview: prepared.preview,
      phaseResults: result.phaseResults
    };
  });
}
