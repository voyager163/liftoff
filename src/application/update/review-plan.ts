import { createHash } from 'node:crypto';
import { liftoffVersion } from '../../version.js';
import { createUpdatePreviewDescriptor } from './preview.js';
import { uniqueUpdateSnapshots, type UpdateInspection } from './inspection.js';
import { planUpdateWrites } from './write-plan.js';
import type { UpdatePlanSummary } from './output.js';
import { prepareUpdateRevalidation } from './revalidation-plan.js';
import type { CommandRunner } from '../../process-runner.js';

function digest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function prepareUpdateReview(
  inspection: UpdateInspection,
  force: boolean,
  options: { runner?: CommandRunner; now?: Date } = {}
) {
  const writePlan = planUpdateWrites(inspection, force);
  const revalidation = await prepareUpdateRevalidation(inspection, writePlan, options);
  const preconditions = uniqueUpdateSnapshots([
    ...inspection.snapshots,
    ...inspection.stateMigration.preconditions
  ]).sort((left, right) => left.pathParts.join('\0').localeCompare(right.pathParts.join('\0'), 'en'));
  const blockers = inspection.reconciliation.status === 'blocked'
    ? [...inspection.reconciliation.issues] : [];
  if (inspection.historyMigration.status === 'eligible' && writePlan.skipped.length > 0) {
    blockers.push(`Required target managed-core conflicts remain: ${writePlan.skipped
      .map((entry) => entry.pathParts.join('/')).join(', ')}. Review a forceable variant or resolve unowned destinations.`);
  }
  const history = inspection.historyMigration;
  const needsRevalidation = revalidation !== undefined && (
    revalidation.preview.phases.length > 0 ||
    history.status === 'current' && history.history.status === 'committed' &&
      history.history.journal.revalidation.status !== 'complete'
  );
  const historyWriteCount = history.status === 'eligible'
    ? (history.historyDisposition === 'create' ? history.index.files.length + 1 : 0) +
      history.requiredRetirements.length + 2
    : 0;
  const descriptor = createUpdatePreviewDescriptor({
    projectRoot: inspection.projectRoot,
    cliVersion: liftoffVersion,
    mode: force ? 'force' : 'normal',
    source: {
      repositoryRoot: inspection.repositoryRoot ?? null,
      files: preconditions.map((snapshot) => ({
        pathParts: snapshot.pathParts,
        kind: snapshot.content === undefined ? 'missing' : 'file',
        contentDigest: snapshot.content === undefined ? null : digest(snapshot.content),
        mode: snapshot.mode ?? null
      })),
      migration: history.status === 'eligible' ? history.semanticPlan :
        history.status === 'current' && history.history.status === 'committed'
          ? history.history.journal : null,
      revalidationSource: inspection.revalidationSource ?? null,
      retainedSource: inspection.retainedSource ?? null
    },
    target: {
      manifest: JSON.stringify(writePlan.nextManifest),
      artifacts: inspection.render.filter((artifact) => artifact.lifecycle === 'managed-core').map((artifact) => ({
        logicalName: artifact.logicalName,
        pathParts: artifact.pathParts,
        contentDigest: digest(artifact.content)
      }))
    },
    operations: {
      mutations: writePlan.mutations.map((mutation) => ({
        type: mutation.type,
        pathParts: mutation.pathParts,
        ...(mutation.type === 'write' ? { contentDigest: digest(mutation.content), mode: mutation.mode ?? null } : {})
      })),
      migration: history.status === 'eligible' ? history.semanticPlan : null,
      revalidation: revalidation?.preview ?? null,
      provisioning: inspection.provisioningPlans.map((group) => ({
        group: group.group,
        blocked: group.blocked,
        entries: group.entries.map((entry) => ({
          status: entry.status,
          pathParts: entry.rendered.pathParts,
          contentDigest: digest(entry.rendered.content)
        }))
      }))
    }
  });
  const summary: UpdatePlanSummary = {
    mode: descriptor.mode,
    fingerprint: descriptor.fingerprint,
    eligible: blockers.length === 0,
    writeCount: writePlan.mutations.length + historyWriteCount +
      (needsRevalidation && history.status !== 'eligible' ? 1 : 0),
    blockers
  };
  return {
    descriptor, summary, writePlan, preconditions, revalidation, needsRevalidation,
    requiresApproval: writePlan.hasWrites || history.status === 'eligible' || needsRevalidation
  };
}

export type ReviewedUpdatePlan = Awaited<ReturnType<typeof prepareUpdateReview>>;
