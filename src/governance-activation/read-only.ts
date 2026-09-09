import type { LiftoffManifest } from '../domain/project/contracts.js';
import type { CommandRunner } from '../process-runner.js';
import { loadActivationState } from './activation-state.js';
import { activationEvidenceContexts, readActivationInputSnapshot } from './inputs.js';
import { canonicalPhaseGraph } from '../domain/governance/activation/graph.js';
import { selectLatestPhaseEvidence } from '../domain/governance/activation/evidence.js';
import { validateManifestActivationForExecution } from '../domain/governance/activation/validators.js';
import { phaseIds } from '../domain/governance/activation/types.js';
import { readActivationEvidence, readReviewedTransitionPlans } from './proof-records.js';
import { inspectActivationMigrationHistory } from './migration-history.js';
export { readActivationEvidence, readReviewedTransitionPlans } from './proof-records.js';

/** Read-only proof boundary: returned values carry no executor, credential, or mutation port. */
export async function inspectCurrentActivationEvidence(projectRoot: string, manifest: LiftoffManifest, options: { runner?: CommandRunner; now?: Date } = {}) {
  validateManifestActivationForExecution(manifest);
  const loaded = await loadActivationState(projectRoot);
  if (!loaded) return { status: 'not-started' as const };
  const migration = await inspectActivationMigrationHistory(projectRoot);
  const snapshot = await readActivationInputSnapshot(projectRoot, manifest, options.runner);
  const contexts = activationEvidenceContexts(canonicalPhaseGraph, loaded.state, snapshot, options.now);
  const plans = await readReviewedTransitionPlans(projectRoot);
  const records = await readActivationEvidence(projectRoot);
  for (const phaseId of phaseIds) contexts[phaseId].reviewedPlans = plans;
  const selections = Object.fromEntries(phaseIds.map((phaseId) => [phaseId,
    selectLatestPhaseEvidence(records.filter((record) => record.header.phaseId === phaseId), contexts[phaseId])]));
  return {
    status: 'inspected' as const, state: loaded.state, snapshot, contexts, records, selections,
    migration: migration.status === 'committed' ? migration.journal : null
  };
}

export { evidenceBodyDigest, evidenceHeaderDigest, selectLatestPhaseEvidence, validateEvidenceFreshness } from '../domain/governance/activation/evidence.js';
export { activationEvidenceContexts, readActivationInputSnapshot } from './inputs.js';
export type { EvidenceFreshnessContext, EvidenceSelectionResult } from '../domain/governance/activation/evidence.js';
export { planDigestFor, type PlanDigestInput } from '../domain/governance/activation/operations.js';
