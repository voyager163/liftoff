import type { PhaseId, PhaseState } from '../../domain/governance/activation/types.js';
import { phaseIds, phaseInScope } from '../../domain/governance/activation/types.js';
import type { GovernanceInspection, SetupCompletionStatus } from './inspection-contracts.js';

export const terminalEvidenceStates = new Set<PhaseState>([
  'verified',
  'failed',
  'inapplicable',
  'retained',
  'disposed'
]);

export const successfulSetupStates = new Set<PhaseState>([
  'approved',
  'verified',
  'inapplicable',
  'retained',
  'disposed'
]);

export const terminalPhaseStates = new Set<PhaseState>([
  ...successfulSetupStates,
  'failed'
]);

export function verificationPhaseIds(inspection: GovernanceInspection): readonly PhaseId[] {
  return phaseIds.filter((id) => phaseInScope(id, inspection.scope, true));
}

export function setupCompletion(inspection: GovernanceInspection): {
  status: SetupCompletionStatus;
  complete: boolean;
  summary: string;
} {
  if (inspection.stateSource === 'not-started') {
    return {
      status: 'not-started',
      complete: false,
      summary: `Verification is consistent, but setup has not started. Next ready phase: ${inspection.readiness.nextReadyPhase ?? 'none'}.`
    };
  }
  if (inspection.readiness.completion[inspection.scope]) {
    return {
      status: 'complete',
      complete: true,
      summary: inspection.scope === 'local'
        ? 'Local setup is complete. Repository publication, cloud deployment, and governance activation are separate approved work.'
        : inspection.scope === 'activation'
          ? 'Governance activation is complete. Delayed retained-state disposal is tracked separately.'
          : inspection.scope === 'repository'
            ? 'Repository enforcement is complete. Cloud activation, production qualification and retained-state obligations remain separate.'
          : 'Lifecycle work is complete.'
    };
  }
  return {
    status: 'in-progress',
    complete: false,
    summary: inspection.readiness.nextReadyPhase
      ? `Verification is consistent, but setup is incomplete. Next ready phase: ${inspection.readiness.nextReadyPhase}.`
      : 'Verification is consistent, but setup is incomplete and currently blocked.'
  };
}
