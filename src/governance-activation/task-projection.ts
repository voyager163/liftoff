import { assertTaskMarkers, projectTaskCheckboxValues } from '../domain/governance/activation/source-values.js';
import { phaseIds, phaseStates as currentPhaseStates, type PhaseId, type PhaseState } from '../domain/governance/activation/types.js';
import { validateGovernanceChangeMetadata } from './source-of-truth.js';
import { currentActivationIdentity } from '../domain/governance/activation/graph.js';
import { canonicalSha256, sha256Hex } from '../domain/governance/activation/canonical-json.js';

export interface PhaseTaskMapping {
  phaseId: PhaseId;
  taskId: string;
}

export type PhaseProjectionState = PhaseState | 'identity-incompatible';
export type PhaseProjectionInput = PhaseProjectionState | { state: PhaseProjectionState };

export interface TaskProjectionChange {
  phaseId: PhaseId;
  taskId: string;
  fromChecked: boolean;
  toChecked: boolean;
  state: PhaseProjectionState;
}

export interface TaskProjectionResult {
  markdown: string;
  changes: readonly TaskProjectionChange[];
}

/** Project only a validated current source. Historical task bytes are never a projection destination. */
export function projectGovernanceChangeTasks(
  markdown: string, metadata: unknown, phaseStates: Partial<Record<PhaseId, PhaseProjectionInput>>
): TaskProjectionResult {
  const current = validateGovernanceChangeMetadata(metadata);
  if (canonicalSha256(current.activationIdentity) !== canonicalSha256(currentActivationIdentity)) {
    throw new Error('Historical or incompatible governance tasks cannot be projected as current proof.');
  }
  assertTaskMarkers(markdown, current.phaseTaskMapping);
  return projectOpenSpecTaskCheckboxes(markdown, current.phaseTaskMapping, phaseStates);
}

export function governanceTaskLayoutHash(markdown: string, metadata: unknown): string {
  return sha256Hex(projectGovernanceChangeTasks(markdown, metadata,
    Object.fromEntries(phaseIds.map((id) => [id, 'pending' as const]))).markdown);
}

export function projectOpenSpecTaskCheckboxes(
  markdown: string, mappings: readonly PhaseTaskMapping[], phaseStates: Partial<Record<PhaseId, PhaseProjectionInput>>
): TaskProjectionResult {
  return projectTaskCheckboxValues(markdown, mappings, phaseStates, phaseIds, currentPhaseStates);
}
