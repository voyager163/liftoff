import type { ProjectFileMutation, ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { assertReviewedReadback } from '../execution/plan-binding.js';

export async function assertRepairReadback(
  root: string, mutations: readonly ProjectFileMutation[], originals: readonly ProjectFileSnapshot[]
): Promise<void> {
  await assertReviewedReadback(root, mutations, originals, 'Repair');
}
