import { readProjectFile } from '../adapters/filesystem/project-files.js';
import type { LiftoffManifest } from '../domain/project/contracts.js';
import {
  activationStateFilePathParts,
  loadActivationState
} from './activation-state.js';
import {
  credentialPolicyPathParts
} from './credentials.js';
import { selectLatestPhaseEvidence, type EvidenceFreshnessContext } from '../domain/governance/activation/evidence.js';
import { activationEvidenceContexts, readActivationInputSnapshot } from './inputs.js';
import { readActivationEvidence, readReviewedTransitionPlans } from './read-only.js';
import {
  canonicalPhaseGraph,
  currentActivationIdentity
} from '../domain/governance/activation/graph.js';
import { planHistoricalActivationStateMigration } from './migration.js';
import { planActivationHistoryMigration, readMigrationJournal } from './migration-history.js';
import { calculatePhaseReadiness } from '../domain/governance/activation/readiness.js';
import {
  inspectGovernanceSourceOfTruth
} from './source-of-truth.js';
import type {
  PhaseEvidenceRecord,
  PhaseId,
  PhaseState,
  UserActivationState
} from '../domain/governance/activation/types.js';
import { phaseIds } from '../domain/governance/activation/types.js';
import { validateCredentialPolicy } from '../domain/governance/activation/validators.js';

export interface GovernanceDoctorCheck {
  id: string;
  label: string;
  severity: 'ok' | 'warn' | 'fail' | 'skipped';
  state: string;
  detail: string;
  remedy?: string;
}

const terminalEvidenceStates = new Set<PhaseState>([
  'verified',
  'failed',
  'inapplicable',
  'retained',
  'disposed'
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadEvidenceForDoctor(projectRoot: string): Promise<PhaseEvidenceRecord[]> {
  return readActivationEvidence(projectRoot);
}

function evidenceStaleCheck(
  state: UserActivationState,
  evidence: readonly PhaseEvidenceRecord[],
  contexts: Record<PhaseId, EvidenceFreshnessContext>
): GovernanceDoctorCheck | undefined {
  const stale: string[] = [];
  for (const phaseId of phaseIds) {
    const stored = state.phases[phaseId];
    if (!terminalEvidenceStates.has(stored.state)) {
      continue;
    }
    const context = contexts[phaseId];
    const records = evidence.filter((entry) => entry.header.phaseId === phaseId);
    const selected = selectLatestPhaseEvidence(records, context);
    const valid = selected.selected?.header.result === stored.state;
    if (!valid) {
      stale.push(phaseId);
    }
  }
  if (stale.length === 0) {
    return undefined;
  }
  return {
    id: 'governance-evidence-stale',
    label: 'governance evidence',
    severity: 'fail',
    state: 'evidence-stale',
    detail: `stored terminal phase(s) lack current authoritative evidence: ${stale.join(', ')}`,
    remedy: 'Rerun liftoff governance verify and provide fresh evidence or an explicit approved reconciliation mapping; do not use checkboxes, filenames, or prose as evidence.'
  };
}

function phaseBlockedCheck(
  state: UserActivationState
): GovernanceDoctorCheck | undefined {
  const blocked = phaseIds.filter((phaseId) =>
    state.phases[phaseId].state === 'blocked' &&
    state.phases[phaseId].blockers.length > 0
  );
  if (blocked.length === 0) {
    return undefined;
  }
  return {
    id: 'governance-phase-blocked',
    label: 'governance phase',
    severity: 'warn',
    state: 'phase-blocked',
    detail: `${blocked[0]} is blocked: ${state.phases[blocked[0]!]!.blockers[0]}`,
    remedy: 'Resolve the named blocker, then run liftoff governance resume --json.'
  };
}

function enforcementIncompleteCheck(
  state: UserActivationState
): GovernanceDoctorCheck | undefined {
  const approved = state.phases['enforcement-approved'].state === 'approved' ||
    state.phases['enforcement-approved'].state === 'verified';
  const liveReadbackComplete = state.phases['live-readback'].state === 'verified';
  if (!approved || liveReadbackComplete) {
    return undefined;
  }
  return {
    id: 'governance-enforcement-incomplete',
    label: 'governance enforcement',
    severity: 'warn',
    state: 'enforcement-incomplete',
    detail: 'final enforcement was approved but ruleset application/live readback is incomplete',
    remedy: 'Run liftoff governance plan --json and continue only through approved rulesets-applied and live-readback phases.'
  };
}

function disposalPendingCheck(
  state: UserActivationState,
  now: Date
): GovernanceDoctorCheck | undefined {
  if (state.bootstrapState?.status !== 'retained') {
    return undefined;
  }
  const due = Date.parse(state.bootstrapState.disposeAfter) <= now.getTime();
  return {
    id: 'governance-disposal-pending',
    label: 'bootstrap state disposal',
    severity: due ? 'warn' : 'skipped',
    state: 'disposal-pending',
    detail: due
      ? `retained bootstrap state reached disposal date ${state.bootstrapState.disposeAfter}`
      : `retained bootstrap state is not disposable until ${state.bootstrapState.disposeAfter}`,
    remedy: due
      ? 'Approve destructive disposal, then run liftoff governance apply-next --execute.'
      : 'Leave retained local bootstrap state untouched until the disposal date.'
  };
}

async function credentialExpiringCheck(
  projectRoot: string,
  now: Date
): Promise<GovernanceDoctorCheck | undefined> {
  const bytes = await readProjectFile(projectRoot, [...credentialPolicyPathParts]);
  if (bytes === undefined) {
    return undefined;
  }
  const policy = validateCredentialPolicy(JSON.parse(bytes.toString('utf8')) as unknown);
  const rotationDue = Date.parse(policy.rotationDueAt) <= now.getTime();
  const expired = Date.parse(policy.expiresAt) <= now.getTime();
  if (policy.status !== 'expiring' && policy.status !== 'expired' && !rotationDue && !expired) {
    return undefined;
  }
  return {
    id: 'governance-credential-expiring',
    label: 'governance credential',
    severity: expired || policy.status === 'expired' ? 'fail' : 'warn',
    state: 'credential-expiring',
    detail: `credential policy status ${policy.status}; rotation due ${policy.rotationDueAt}; expires ${policy.expiresAt}`,
    remedy: 'Use an independently supported, reviewed provider rotation process. This CLI has no public credential enrollment/readback workflow; never enter credentials into task, state, or evidence files.'
  };
}

export async function governanceDoctorChecks(
  projectRoot: string,
  manifest: LiftoffManifest,
  now = new Date()
): Promise<GovernanceDoctorCheck[]> {
  if (manifest.governance.profile === 'none' || manifest.governance.profile === 'unspecified') {
    return [];
  }
  const checks: GovernanceDoctorCheck[] = [];
  const migration = await planHistoricalActivationStateMigration(projectRoot, now.toISOString());
  if (migration.status === 'blocked') {
    let history = migration.report.diagnosticOnly === true
      ? await planActivationHistoryMigration(projectRoot) : undefined;
    if (history?.status === 'blocked' && history.reasonCode === 'unreviewed-historical-records' &&
      history.unreviewedPathParts) {
      history = await planActivationHistoryMigration(projectRoot, {
        reviewedUnreferencedPathParts: history.unreviewedPathParts
      });
    }
    const supported = history?.status === 'eligible';
    checks.push({
      id: 'governance-identity-incompatible',
      label: supported ? 'governance migration available' : 'governance activation identity',
      severity: 'fail',
      state: supported ? 'migration-available' : 'identity-incompatible',
      detail: supported
        ? 'Historical activation v1 has a supported history-preserving v2 successor; existing history is not current execution proof.'
        : history?.status === 'blocked' ? history.issues.join('; ')
          : migration.report.issues[0] ?? 'activation state is not compatible with this Liftoff version',
      remedy: 'Preserve user-owned state and evidence bytes. ' + (migration.report.diagnosticOnly === true
        ? 'Historical activation v1 requires liftoff update --check followed by explicit approval of a supported plan; do not reset or retag history.'
        : 'The recorded activation format or identity is unsupported or invalid. Use a compatible Liftoff version or restore original state from a trusted backup; do not rewrite identity fields to bypass validation.')
    });
    return checks;
  }
  if (migration.status === 'migrate') {
    checks.push({
      id: 'governance-reconciliation-required',
      label: 'governance reconciliation',
      severity: 'warn',
      state: 'reconciliation-required',
      detail: `historical activation state has an explicit migration mapping to graph ${currentActivationIdentity.phaseGraphHash}`,
      remedy: 'Run liftoff update --check, then explicitly approve the matching plan; original evidence bytes remain preserved.'
    });
    return checks;
  }

  let loaded;
  try {
    loaded = await loadActivationState(projectRoot);
  } catch (error) {
    checks.push({
      id: 'governance-identity-incompatible',
      label: 'governance activation identity',
      severity: 'fail',
      state: 'identity-incompatible',
      detail: errorMessage(error),
      remedy: 'Restore original state from a trusted backup or use a compatible CLI; never hand-edit the recorded activation identity or graph hash.'
    });
    return checks;
  }
  const journal = await readMigrationJournal(projectRoot);
  if (journal) {
    const blocked = journal.revalidation.status !== 'complete';
    checks.push({
      id: 'governance-migration-progress',
      label: 'governance migration',
      severity: blocked ? 'fail' : 'ok',
      state: blocked ? 'revalidation-blocked' : 'migration-committed',
      detail: blocked
        ? `Local v2 migration committed; revalidation is ${journal.revalidation.status}: ${journal.revalidation.nextAction}`
        : 'Local v2 migration and its approved local revalidation are complete; preserved v1 history is informational, not live governance proof.',
      ...(blocked ? { remedy: 'Repair the named blocker, run liftoff update --check, and approve the remaining local work. Keep v2 and its preserved history.' } : {})
    });
  }
  let evidence: PhaseEvidenceRecord[];
  try {
    evidence = await loadEvidenceForDoctor(projectRoot);
  } catch (error) {
    checks.push({
      id: 'governance-evidence-stale',
      label: 'governance evidence',
      severity: 'fail',
      state: 'evidence-stale',
      detail: errorMessage(error),
      remedy: 'Preserve immutable evidence. Repair source inputs and explicitly retry supported local phases; unsupported remote proof remains blocked.'
    });
    return checks;
  }
  const state = loaded?.state;
  if (!state) {
    const source = await inspectGovernanceSourceOfTruth({
      projectRoot,
      manifest,
      state: {
        schemaVersion: currentActivationIdentity.activationStateSchemaVersion,
        identity: currentActivationIdentity,
        repository: {
          id: `local:${manifest.project.name}`,
          name: manifest.project.name,
          defaultBranch: 'develop'
        },
        activeChange: null,
        applicability: {
          statePath: 'none',
          privateStagingDast: 'unknown',
          credentialRequired: 'unknown'
        },
        phases: Object.fromEntries(phaseIds.map((phaseId) => [phaseId, {
          state: 'pending',
          updatedAt: '1970-01-01T00:00:00.000Z',
          evidence: [],
          approvals: [],
          blockers: []
        }])) as unknown as UserActivationState['phases'],
        createdAt: '1970-01-01T00:00:00.000Z',
        updatedAt: '1970-01-01T00:00:00.000Z'
      },
      evidence
    });
    if (source.status === 'seed-blocked') {
      checks.push({
        id: 'governance-seed-incomplete',
        label: 'governance seed',
        severity: 'warn',
        state: 'seed-incomplete',
        detail: source.blockers.join('; '),
        remedy: 'Run /liftoff-setup to complete, sync, and archive the generated seed before governance activation.'
      });
    } else {
      checks.push({
        id: 'governance-activation',
        label: 'governance activation',
        severity: 'skipped',
        state: 'phase-blocked',
        detail: 'no user-owned activation state exists yet',
        remedy: 'Run /liftoff-setup or liftoff governance status --json to start deterministic setup.'
      });
    }
    return checks;
  }

  const contexts = activationEvidenceContexts(canonicalPhaseGraph, state, await readActivationInputSnapshot(projectRoot, manifest), now);
  const reviewedPlans = await readReviewedTransitionPlans(projectRoot);
  for (const phase of phaseIds) contexts[phase].reviewedPlans = reviewedPlans;
  const source = await inspectGovernanceSourceOfTruth({ projectRoot, manifest, state, evidence, contexts });
  if (source.status === 'seed-blocked') {
    checks.push({
      id: 'governance-seed-incomplete',
      label: 'governance seed',
      severity: 'warn',
      state: 'seed-incomplete',
      detail: source.blockers.join('; '),
      remedy: 'Complete and archive the generated bootstrap seed; update modes do not bypass this gate.'
    });
  } else if (source.status === 'selected' && source.reconciliation.status !== 'not-required') {
    checks.push({
      id: 'governance-reconciliation-required',
      label: 'governance reconciliation',
      severity: source.reconciliation.status === 'blocked' ? 'fail' : 'warn',
      state: 'reconciliation-required',
      detail: source.reconciliation.issues.join('; '),
      remedy: 'Acknowledge the installed activation identity and graph hash in the active governance change before executing affected phases.'
    });
  } else if (source.status === 'ambiguous' || source.status === 'incompatible') {
    checks.push({
      id: 'governance-identity-incompatible',
      label: 'governance activation identity',
      severity: 'fail',
      state: 'identity-incompatible',
      detail: source.blockers.join('; '),
      remedy: 'Resolve active-change ownership with schema-valid metadata or supersession records before continuing setup.'
    });
  }

  const readiness = calculatePhaseReadiness({
    graph: canonicalPhaseGraph,
    state,
    approvals: [],
    evidence,
    transitionContexts: contexts,
    now
  });
  if (!readiness.identityCompatible) {
    checks.push({
      id: 'governance-identity-incompatible',
      label: 'governance activation identity',
      severity: 'fail',
      state: 'identity-incompatible',
      detail: readiness.identityBlocker ?? 'activation identity tuple is not compatible',
      remedy: 'Upgrade Liftoff or restore a supported tuple and recognized phase graph hash.'
    });
  }

  for (const check of [
    evidenceStaleCheck(state, evidence, contexts),
    phaseBlockedCheck(state),
    await credentialExpiringCheck(projectRoot, now),
    enforcementIncompleteCheck(state),
    disposalPendingCheck(state, now)
  ]) {
    if (check) {
      checks.push(check);
    }
  }
  if (checks.length === 0) {
    checks.push({
      id: 'governance-activation',
      label: 'governance activation',
      severity: 'ok',
      state: 'ready',
      detail: 'state, evidence, credentials, source of truth, and compatibility identity are readable',
      remedy: 'Continue with liftoff governance plan --json when a phase is ready.'
    });
  }
  return checks;
}
