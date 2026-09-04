import { readdir } from 'node:fs/promises';
import {
  readProjectFile,
  resolveProjectPath
} from '../file-system.js';
import type { LiftoffManifest } from '../types.js';
import {
  activationStateFilePathParts,
  loadActivationState
} from './activation-state.js';
import {
  credentialPolicyPathParts
} from './credentials.js';
import {
  evidenceContextForPhase,
  requiredLiveReadbackProviders,
  validateEvidenceFreshness
} from './evidence.js';
import {
  canonicalPhaseGraph,
  currentActivationIdentity,
  phaseContractDigests
} from './graph.js';
import { planHistoricalActivationStateMigration } from './migration.js';
import { calculatePhaseReadiness } from './readiness.js';
import {
  inspectGovernanceSourceOfTruth
} from './source-of-truth.js';
import type {
  EvidenceHeader,
  PhaseEvidenceRecord,
  PhaseId,
  PhaseState,
  UserActivationState
} from './types.js';
import { phaseIds } from './types.js';
import {
  validateCredentialPolicy,
  validateEvidenceHeader
} from './validators.js';

export interface GovernanceDoctorCheck {
  id: string;
  label: string;
  severity: 'ok' | 'warn' | 'fail' | 'skipped';
  state: string;
  detail: string;
  remedy?: string;
}

const evidencePathParts = ['governance', 'evidence'] as const;
const terminalEvidenceStates = new Set<PhaseState>([
  'verified',
  'failed',
  'inapplicable',
  'retained',
  'disposed'
]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown, pathLabel: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${pathLabel} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

async function readJsonDirectory(
  projectRoot: string,
  pathParts: readonly string[]
): Promise<Array<{ name: string; value: unknown }>> {
  const directory = await resolveProjectPath(projectRoot, [...pathParts]);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const values: Array<{ name: string; value: unknown }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const filePathParts = [...pathParts, entry.name];
    const bytes = await readProjectFile(projectRoot, filePathParts);
    if (bytes === undefined) {
      throw new Error(`${filePathParts.join('/')} disappeared during doctor inspection.`);
    }
    values.push({
      name: entry.name,
      value: JSON.parse(bytes.toString('utf8')) as unknown
    });
  }
  return values;
}

function evidenceRecord(value: unknown, evidenceId: string): PhaseEvidenceRecord {
  const record = asRecord(value, `governance/evidence/${evidenceId}.json`);
  if (Object.hasOwn(record, 'header')) {
    return {
      evidenceId: typeof record.evidenceId === 'string' && record.evidenceId.length > 0
        ? record.evidenceId
        : evidenceId,
      header: validateEvidenceHeader(record.header),
      ...(Array.isArray(record.liveReadback) ? { liveReadback: record.liveReadback as never } : {}),
      ...(Object.hasOwn(record, 'payload') ? { payload: record.payload } : {})
    };
  }
  return {
    evidenceId,
    header: validateEvidenceHeader(value)
  };
}

async function loadEvidenceForDoctor(projectRoot: string): Promise<PhaseEvidenceRecord[]> {
  const entries = await readJsonDirectory(projectRoot, evidencePathParts);
  return entries.map((entry) => evidenceRecord(entry.value, entry.name.replace(/\.json$/u, '')));
}

function contextForPhase(
  phaseId: PhaseId,
  state: UserActivationState,
  now: Date
): Parameters<typeof validateEvidenceFreshness>[1] {
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === phaseId)!;
  return {
    ...evidenceContextForPhase(phaseId, {
      repositoryId: state.repository.id,
      identity: state.identity,
      phaseGraphHash: state.identity.phaseGraphHash,
      now,
      liveReadbackProviders: requiredLiveReadbackProviders(phase)
    }),
    phaseContractDigest: phaseContractDigests(canonicalPhaseGraph)[phaseId]
  };
}

function evidenceStaleCheck(
  state: UserActivationState,
  evidence: readonly PhaseEvidenceRecord[],
  now: Date
): GovernanceDoctorCheck | undefined {
  const stale: string[] = [];
  for (const phaseId of phaseIds) {
    const stored = state.phases[phaseId];
    if (!terminalEvidenceStates.has(stored.state)) {
      continue;
    }
    const context = contextForPhase(phaseId, state, now);
    const records = evidence.filter((entry) => entry.header.phaseId === phaseId);
    const valid = records.some((entry) => {
      const result = validateEvidenceFreshness(entry, context);
      return result.valid && result.record.header.result === stored.state;
    });
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
    remedy: 'Revoke/rotate the runner preflight credential through the deterministic masked enrollment flow before using credential-ready evidence.'
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
    checks.push({
      id: 'governance-identity-incompatible',
      label: 'governance activation identity',
      severity: 'fail',
      state: 'identity-incompatible',
      detail: migration.report.issues[0] ?? 'activation state is not compatible with this Liftoff version',
      remedy: 'Upgrade Liftoff or provide an explicit versioned import mapping. Preserve user-owned state and evidence bytes; never import checkboxes, filenames, or prose as evidence.'
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
      remedy: 'Run liftoff update after review; the migration is staged with managed definitions and preserves evidence bytes.'
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
      remedy: 'Restore a supported activation identity tuple and recognized graph hash, or upgrade Liftoff before running setup.'
    });
    return checks;
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
      remedy: 'Repair malformed evidence or provide an explicit approved reconciliation mapping; do not infer evidence from filenames or prose.'
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
          privateStagingDast: false,
          credentialRequired: false
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

  const source = await inspectGovernanceSourceOfTruth({ projectRoot, manifest, state, evidence });
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
    evidenceStaleCheck(state, evidence, now),
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
