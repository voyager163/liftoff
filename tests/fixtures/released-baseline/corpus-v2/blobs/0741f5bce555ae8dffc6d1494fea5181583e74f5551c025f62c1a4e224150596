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

const checkedStates = new Set<PhaseProjectionState>([
  'approved',
  'verified',
  'inapplicable',
  'retained',
  'disposed'
]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function projectedChecked(state: PhaseProjectionState): boolean {
  return checkedStates.has(state);
}

function projectionState(value: PhaseProjectionInput | undefined): PhaseProjectionState | undefined {
  if (value === undefined) {
    return undefined;
  }
  const state = typeof value === 'string' ? value : value.state;
  if (state !== 'identity-incompatible' && !currentPhaseStates.some((entry) => entry === state)) {
    throw new Error('Task projection requires an explicit calculated current phase state, not historical or unknown progress.');
  }
  return state;
}

function validateMappings(mappings: readonly PhaseTaskMapping[]): void {
  const phases = new Set<PhaseId>();
  const tasks = new Set<string>();
  for (const mapping of mappings) {
    if (!phaseIds.some((id) => id === mapping.phaseId)) throw new Error('Task projection contains an unknown current phase.');
    if (phases.has(mapping.phaseId)) {
      throw new Error(`Task projection contains duplicate mapping for phase ${mapping.phaseId}.`);
    }
    if (tasks.has(mapping.taskId)) {
      throw new Error(`Task projection contains duplicate mapping for task ${mapping.taskId}.`);
    }
    if (mapping.taskId.trim().length === 0) {
      throw new Error(`Task projection task id for phase ${mapping.phaseId} must be non-empty.`);
    }
    phases.add(mapping.phaseId);
    tasks.add(mapping.taskId);
  }
}

/** Project only a validated current source. Historical task bytes are never a projection destination. */
export function projectGovernanceChangeTasks(
  markdown: string, metadata: unknown, phaseStates: Partial<Record<PhaseId, PhaseProjectionInput>>
): TaskProjectionResult {
  const current = validateGovernanceChangeMetadata(metadata);
  if (canonicalSha256(current.activationIdentity) !== canonicalSha256(currentActivationIdentity)) {
    throw new Error('Historical or incompatible governance tasks cannot be projected as current proof.');
  }
  for (const mapping of current.phaseTaskMapping) {
    const task = new RegExp(`^\\s*[-*]\\s+\\[[ xX]\\]\\s+${escapeRegex(mapping.taskId)}(?=\\s|$)`);
    const rows = markdown.split(/\r?\n/u).filter((line) => task.test(line));
    if (rows.length !== 1 || !rows[0].includes(mapping.marker) || markdown.split(mapping.marker).length !== 2) {
      throw new Error(`Current task ${mapping.taskId} must have exactly its registered phase marker.`);
    }
  }
  return projectOpenSpecTaskCheckboxes(markdown, current.phaseTaskMapping, phaseStates);
}

export function governanceTaskLayoutHash(markdown: string, metadata: unknown): string {
  return sha256Hex(projectGovernanceChangeTasks(markdown, metadata,
    Object.fromEntries(phaseIds.map((id) => [id, 'pending' as const]))).markdown);
}

export function projectOpenSpecTaskCheckboxes(
  markdown: string,
  mappings: readonly PhaseTaskMapping[],
  phaseStates: Partial<Record<PhaseId, PhaseProjectionInput>>
): TaskProjectionResult {
  validateMappings(mappings);
  const lines = markdown.split('\n');
  const changes: TaskProjectionChange[] = [];
  for (const mapping of mappings) {
    const state = projectionState(phaseStates[mapping.phaseId]);
    if (!state) {
      throw new Error(`Task projection is missing calculated phase state for ${mapping.phaseId}.`);
    }
    const pattern = new RegExp(`^(\\s*[-*]\\s+\\[)([ xX])(\\]\\s+${escapeRegex(mapping.taskId)}(?=\\s|$).*)$`);
    const matches = lines
      .map((line, index) => ({ line, index, match: (line.endsWith('\r') ? line.slice(0, -1) : line).match(pattern) }))
      .filter((entry): entry is { line: string; index: number; match: RegExpMatchArray } => entry.match !== null);
    if (matches.length === 0) {
      throw new Error(`Task projection mapping for ${mapping.phaseId} cannot find task ${mapping.taskId}.`);
    }
    if (matches.length > 1) {
      throw new Error(`Task projection mapping for ${mapping.phaseId} is ambiguous for task ${mapping.taskId}.`);
    }
    const [match] = matches;
    const fromChecked = match.match[2]!.toLowerCase() === 'x';
    const toChecked = projectedChecked(state);
    if (fromChecked !== toChecked) {
      const position = match.match[1].length;
      lines[match.index] = `${match.line.slice(0, position)}${toChecked ? 'x' : ' '}${match.line.slice(position + 1)}`;
      changes.push({
        phaseId: mapping.phaseId,
        taskId: mapping.taskId,
        fromChecked,
        toChecked,
        state
      });
    }
  }
  return {
    markdown: lines.join('\n'),
    changes
  };
}
