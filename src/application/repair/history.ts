import type { ProjectFileMutation, ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { repairSchemaVersions } from '../../domain/repair/identity.js';
import {
  mutationDescriptors, repairHistoryRoot, snapshotDescriptors, type RepairPreview
} from './preview.js';

export function repairHistoryMutations(input: {
  preview: RepairPreview;
  sourceManifest: Buffer;
  snapshots: readonly ProjectFileSnapshot[];
  mutations: readonly ProjectFileMutation[];
  verificationPolicy: unknown;
  backupIndexKey?: string;
}): ProjectFileMutation[] {
  const { preview } = input;
  if (canonicalSha256(input.verificationPolicy) !== preview.verificationDigest) {
    throw new Error('Repair history cannot record verification that differs from the approved plan.');
  }
  const history = [...repairHistoryRoot, preview.fingerprint];
  const receipt = {
    schemaVersion: repairSchemaVersions.history, kind: 'liftoff-repair-history',
    cliVersion: preview.cliVersion, repairContractVersion: preview.repairContractVersion, recipe: preview.recipe,
    fingerprint: preview.fingerprint, projectRoot: preview.projectRoot, reviewedAt: preview.createdAt,
    source: snapshotDescriptors(input.snapshots), target: mutationDescriptors(input.mutations),
    verification: { policy: input.verificationPolicy, digest: preview.verificationDigest, result: 'declared-staged-checks-passed' },
    ...(input.backupIndexKey ? { backup: { namespace: 'repair-backup', indexKey: input.backupIndexKey } } : {}),
    activationEvidence: 'not-issued'
  };
  return [
    { type: 'write', pathParts: [...history, 'manifest.json'], content: input.sourceManifest, mode: 0o600 },
    { type: 'write', pathParts: [...history, 'receipt.json'], content: `${JSON.stringify(receipt, null, 2)}\n`, mode: 0o600 }
  ];
}
