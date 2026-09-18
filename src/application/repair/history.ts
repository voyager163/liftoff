import type { ProjectFileMutation, ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { createHash } from 'node:crypto';
import { parseManifest } from '../project/manifest.js';
import { manifestRepairLinkPath } from '../project/repair-manifest.js';
import { repairSchemaVersions } from '../../domain/repair/identity.js';
import {
  mutationDescriptors, repairHistoryRoot, snapshotDescriptors, type RepairPreview
} from './preview.js';

export function repairManifestLinkDeclarations(mutations: readonly ProjectFileMutation[]) {
  const target = mutations.find((mutation) => mutation.type === 'write' && mutation.pathParts.join('/') === 'liftoff.manifest.json');
  if (!target || target.type !== 'write') return [];
  const parsed: unknown = JSON.parse(target.content.toString());
  if (!isRecord(parsed) || parsed.artifactVersion !== 8) return [];
  const manifest = parseManifest(parsed);
  if (manifest.artifactVersion !== 8) return [];
  const repair = manifest.provenance.repairs.at(-1);
  return repair ? [{ ...repair, pathParts: manifestRepairLinkPath(repair.recordId) }] : [];
}

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
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  const sourceManifestHash = `sha256:${createHash('sha256').update(input.sourceManifest).digest('hex')}`;
  const links = repairManifestLinkDeclarations(input.mutations);
  for (const link of links) {
    if (link.recipe !== preview.recipe.id || link.recipeVersion !== preview.recipe.version || link.sourceManifestHash !== sourceManifestHash) {
      throw new Error('Manifest repair provenance does not match the original source and registered recipe.');
    }
  }
  return [
    { type: 'write', pathParts: [...history, 'manifest.json'], content: input.sourceManifest, mode: 0o600 },
    { type: 'write', pathParts: [...history, 'receipt.json'], content: receiptBytes, mode: 0o600 },
    ...links.map((link): ProjectFileMutation => ({
      type: 'write', pathParts: link.pathParts, mode: 0o600,
      content: `${JSON.stringify({
        schemaVersion: 1, kind: 'liftoff-manifest-repair-link', recordId: link.recordId,
        sourceManifestHash, recipe: preview.recipe, fingerprint: preview.fingerprint,
        receiptPathParts: [...history, 'receipt.json'],
        receiptHash: `sha256:${createHash('sha256').update(receiptBytes).digest('hex')}`
      }, null, 2)}\n`
    }))
  ];
}
