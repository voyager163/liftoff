import path from 'node:path';
import { captureRetainedInputTree } from '../../adapters/filesystem/retained-inputs.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { isProjectMutationReservationName } from '../../domain/governance/activation/inputs.js';
import { reviewedUpdateTransactionPathParts } from '../../domain/project/reviewed-update-artifacts.js';
import type { ExternalCommand } from '../../domain/project/contracts.js';
import type { RunCommandOptions } from '../../process-runner.js';

export interface RetainedProjectInput {
  pathParts: string[];
  digest: string;
  mode: number;
}

const dependencyCaches = new Set([
  '.git', 'node_modules', '.venv', 'venv', '.terraform',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache'
]);
const mutableRecords = new Set([
  'governance/plans', 'governance/evidence',
  'governance/activation-state.json', 'governance/migration-state.json',
  reviewedUpdateTransactionPathParts.join('/')
]);

export const localValidationOutputPolicy = [
  { executable: 'npm', cwd: ['backend'], outputs: [['backend', 'dist'], ['backend', 'build'], ['backend', 'out'], ['backend', 'coverage'], ['backend', '.cache']] },
  { executable: 'npm', cwd: ['frontend'], outputs: [['frontend', 'dist'], ['frontend', 'build'], ['frontend', 'out'], ['frontend', 'coverage'], ['frontend', '.next'], ['frontend', '.cache']] },
  { executable: 'uv', cwd: [], outputs: [['.coverage'], ['coverage.xml'], ['htmlcov']] }
] as const;

export function isRetainedProjectInput(parts: readonly string[]): boolean {
  if (parts.some((part) => dependencyCaches.has(part) || isProjectMutationReservationName(part))) return false;
  for (let length = 1; length <= parts.length; length++) {
    if (mutableRecords.has(parts.slice(0, length).join('/'))) return false;
  }
  return true;
}

export async function captureRetainedProjectInputs(projectRoot: string): Promise<RetainedProjectInput[]> {
  return captureRetainedInputTree(projectRoot, isRetainedProjectInput);
}

export function changedRetainedProjectInputs(
  expected: readonly RetainedProjectInput[],
  actual: readonly RetainedProjectInput[]
): string[] {
  const before = new Map(expected.map((entry) => [entry.pathParts.join('/'), canonicalSha256(entry)]));
  const after = new Map(actual.map((entry) => [entry.pathParts.join('/'), canonicalSha256(entry)]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((key) => before.get(key) !== after.get(key)).sort();
}

export function outputsForLocalCommand(
  projectRoot: string,
  command: ExternalCommand,
  options?: RunCommandOptions
): readonly (readonly string[])[] {
  const cwd = path.resolve(options?.cwd ?? projectRoot);
  const policy = localValidationOutputPolicy.find((entry) =>
    command.executable === entry.executable && cwd === path.resolve(projectRoot, ...entry.cwd)
  );
  return policy?.outputs ?? [];
}

export function acceptDeclaredCommandOutputs(
  expected: readonly RetainedProjectInput[],
  actual: readonly RetainedProjectInput[],
  outputs: readonly (readonly string[])[]
): RetainedProjectInput[] {
  const permitted = (name: string) => outputs.some((parts) => {
    const root = parts.join('/');
    return name === root || name.startsWith(`${root}/`);
  });
  const changed = changedRetainedProjectInputs(expected, actual).filter((name) => !permitted(name));
  if (changed.length) {
    throw new Error(`Protected source changed during validation: ${changed.join(', ')}. Edits were preserved; obtain a fresh preview.`);
  }
  return actual.map((entry) => ({ ...entry, pathParts: [...entry.pathParts] }));
}
