import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { assertBoundProjectPath } from '../../adapters/filesystem/bound-project-files.js';
import { errorCode } from '../../adapters/filesystem/errors.js';
import type { ProjectFileMutation, ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { InstalledLocalSnapshot } from '../../domain/governance/activation/modern-local-runtime.js';
import { FileSystemError } from '../../domain/project/errors.js';
import { activationTargetHistoryPathParts, validateActivationTargetHistoryReference } from '../../domain/project/manifest/activation-target-history.js';
import type { LiftoffManifestV8 } from '../../domain/project/manifest/v8.js';
import {
  reviewedAdoptionTransactionPathParts, reviewedUpdateTransactionPathParts,
  reviewedRepairTransactionPathParts, localVerificationTransactionPathParts
} from '../../domain/project/reviewed-update-artifacts.js';
import { rawHistoryDigest } from '../../governance-activation/history-contracts.js';
import { isSensitiveActivationPath } from '../../governance-activation/inputs.js';
import { copySourceHistoryObservations, createSourceHistoryCapture } from '../../governance-activation/source-history-capture.js';
import { validateCapturedModernMaintenanceSource, type ModernMaintenanceSource } from '../governance/modern-installed-preflight.js';
import type { ManagedManifestDecision } from '../project/manifest-writer.js';
import type { ModernManagedCoreInput } from '../project/modern-managed-core.js';
import { prepareManifestMaintenanceCandidate } from './manifest-maintenance.js';
import { readPreservedActivationTargetManifest } from './activation-target-history.js';

const competingTransactionPaths = [
  reviewedRepairTransactionPathParts,
  reviewedAdoptionTransactionPathParts,
  localVerificationTransactionPathParts
];
const transactionPaths = [reviewedUpdateTransactionPathParts, ...competingTransactionPaths];
export function activeMaintenanceFilePreconditions(source: ModernMaintenanceSource) {
  // Reserved journals are owned by their codecs, never supplied as ordinary project-data preconditions.
  return source.captures.filter(file => !transactionPaths.some(parts => parts.join('/') === file.pathParts.join('/')));
}

export function requiredActivationTargetPreservation(source: ModernMaintenanceSource, manifestChanged: boolean) {
  const reference = source.classification === 'successor' && manifestChanged && !source.manifest.activationTargetHistory
    ? validateActivationTargetHistoryReference({
      schemaVersion: 1, kind: 'activation-target-history',
      manifestDigest: rawHistoryDigest(source.original.content), bytes: source.original.content.length, mode: source.original.mode
    }) : undefined;
  if (reference) {
    const parts = activationTargetHistoryPathParts(reference);
    const protectedPaths = source.retention.flatMap(retention => retention.protectedPaths);
    if (isSensitiveActivationPath(parts, protectedPaths) ||
      protectedPaths.some(protectedPath => isSensitiveActivationPath(protectedPath, [parts]))) {
      throw new FileSystemError('Original target preservation overlaps retained state or key material; no destination bytes may be read.');
    }
  }
  return reference;
}

export async function prepareActiveManifestMaintenance(
  snapshot: InstalledLocalSnapshot, selected: ModernManagedCoreInput, managed: readonly ManagedManifestDecision[],
  preservationObservation?: ProjectFileSnapshot
) {
  const source = await validateCapturedModernMaintenanceSource(snapshot);
  let candidate = prepareManifestMaintenanceCandidate(source.original, selected, managed);
  const reference = requiredActivationTargetPreservation(source, candidate.manifestChanged);
  const mutations: ProjectFileMutation[] = [];
  const preconditions = activeMaintenanceFilePreconditions(source);
  if (reference) {
    if (!preservationObservation) throw new FileSystemError('Original target preservation destination was not captured.');
    const [observed] = copySourceHistoryObservations([preservationObservation]);
    const parts = activationTargetHistoryPathParts(reference);
    if (observed.pathParts.join('/') !== parts.join('/')) {
      throw new FileSystemError('Original target preservation has a different captured destination.');
    }
    if (observed.content === undefined) {
      mutations.push({ type: 'write', pathParts: [...parts], content: source.original.content, mode: reference.mode });
    } else if (!observed.content.equals(source.original.content) || observed.mode !== reference.mode) {
      throw new FileSystemError('Original target preservation cannot overwrite an occupied or different destination.');
    }
    preconditions.push(observed);
    candidate = prepareManifestMaintenanceCandidate(source.original, selected, managed, reference);
  } else if (preservationObservation !== undefined) {
    throw new FileSystemError('This maintenance does not require a new original target preservation observation.');
  }
  return {
    ...candidate, mutations, preconditions, source,
    semanticTransitionDigest: canonicalSha256({
      schemaVersion: 1, kind: 'liftoff-active-manifest-maintenance',
      sourceManifestDigest: rawHistoryDigest(source.original.content), targetManifestDigest: candidate.manifest.digest
    })
  };
}

export async function verifyActiveMaintenanceTarget(
  projectRoot: string, manifest: LiftoffManifestV8
): Promise<void> {
  if (!manifest.activationTargetHistory) return;
  const reader = await createSourceHistoryCapture(projectRoot);
  readPreservedActivationTargetManifest(manifest, await reader.capture(activationTargetHistoryPathParts(manifest.activationTargetHistory)));
  await reader.assertRoot();
}

export async function assertActiveMaintenanceCollections(snapshot: InstalledLocalSnapshot): Promise<void> {
  const reader = await createSourceHistoryCapture(snapshot.root);
  for (const parts of competingTransactionPaths) {
    await assertBoundProjectPath(reader.root, parts, {
      pathLabel: 'Active maintenance transaction guard', invalid(detail) { throw new FileSystemError(detail); }
    });
    try { await lstat(path.join(reader.root, ...parts)); }
    catch (error) { if (errorCode(error) === 'ENOENT') continue; throw error; }
    throw new FileSystemError('A competing local transaction appeared during active maintenance.');
  }
  for (const name of ['plans', 'evidence', 'approvals', 'supersessions', 'reconciliation'] as const) {
    const directory = snapshot.directories.find(entry => entry.pathParts.join('/') === `governance/${name}`);
    if (!directory) throw new FileSystemError('Active maintenance record collection was not captured.');
    const expected = directory.entries.filter(entry => /\.json$/iu.test(entry.name)).map(entry => entry.name).sort();
    const actual = (await reader.recordPaths(name)).map(parts => parts.at(-1)!).sort();
    if (canonicalSha256(expected) !== canonicalSha256(actual)) {
      throw new FileSystemError(`Active maintenance governance/${name} membership changed after inspection.`);
    }
  }
  await reader.assertRoot();
}
