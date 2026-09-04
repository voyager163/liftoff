import type { PhaseId, PhaseState } from './types.js';

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
  return typeof value === 'string' ? value : value.state;
}

function validateMappings(mappings: readonly PhaseTaskMapping[]): void {
  const phases = new Set<PhaseId>();
  const tasks = new Set<string>();
  for (const mapping of mappings) {
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
      .map((line, index) => ({ line, index, match: line.match(pattern) }))
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
      lines[match.index] = `${match.match[1]}${toChecked ? 'x' : ' '}${match.match[3]}`;
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
