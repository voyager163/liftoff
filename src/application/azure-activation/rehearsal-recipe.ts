import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome } from '../../governance-activation/transition-ports.js';
import { applicationRehearsalProducer } from './application-rehearsal-default.js';

export const productionRehearsalInterfaceBlocker =
  'Production rehearsal requires its registered resource-changing private-backend executor for the ' +
  'exact separately approved disposable rollout AND rollback, with pre-effect checkpoints, actual provider operation IDs, ' +
  'saved-plan/artifact/principal bindings and independent before/after revision, traffic and resource readback. ' +
  'The released state-only executor forbids resource changes. Workflow success, a Running app, runtime observations ' +
  'and caller-authored ledgers cannot substitute for these effects; no cross-provider atomic rollback is claimed.';

export function verifyArtifactEquality(approvedDigest: string, candidateDigest: string): boolean {
  return /^sha256:[a-f0-9]{64}$/u.test(approvedDigest) &&
    /^sha256:[a-f0-9]{64}$/u.test(candidateDigest) && approvedDigest === candidateDigest;
}

export async function executeProductionRehearsalProducer(
  input: PhaseAdapterExecutionInput
): Promise<PhaseAdapterOutcome> {
  return applicationRehearsalProducer.execute(input);
}

export const planProductionRehearsalProducer = applicationRehearsalProducer.plan;
