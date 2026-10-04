import type { ProjectFileMutation } from '../../adapters/filesystem/project-transaction.js';
import { localInputFailure } from '../../domain/governance/activation/modern-local-inputs.js';

export function reviewLocalPublicationWrites<T extends object>(targets: readonly T[], mutations: readonly ProjectFileMutation[]) {
  if (targets.length !== mutations.length) localInputFailure('Local publication writes and target descriptors differ.');
  return mutations.map((mutation, index) => {
    if (mutation.type !== 'write') localInputFailure('Only registered exact-file publication writes may be reviewed.');
    const bytes = Buffer.from(mutation.content), content = bytes.toString('utf8');
    if (!Buffer.from(content).equals(bytes)) localInputFailure('Local publication review requires exact UTF8 target bytes.');
    const target = targets[index] ?? localInputFailure('A prepared publication write has no target descriptor.');
    return { ...target, content };
  });
}
