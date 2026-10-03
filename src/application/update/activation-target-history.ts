import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { FileSystemError } from '../../domain/project/errors.js';
import { activationTargetHistoryPathParts } from '../../domain/project/manifest/activation-target-history.js';
import { createManifestV8Reader, type LiftoffManifestV8 } from '../../domain/project/manifest/v8.js';
import { parseHistoryJson, rawHistoryDigest } from '../../governance-activation/history-contracts.js';
import { copySourceHistoryData, copySourceHistoryObservations } from '../../governance-activation/source-history-capture.js';
import { projectCatalog } from '../project/catalog.js';
import { resolveModernManifestV8SourceContract } from '../project/manifest.js';

const reader = createManifestV8Reader({ catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract });

/** Checks actual original bytes and unchanged intent; journal linkage is independently reconstructed by its caller. */
export function readPreservedActivationTargetManifest(current: LiftoffManifestV8, observation: ProjectFileSnapshot) {
  const manifest = reader.parseManifestV8(copySourceHistoryData(current, 'maintained manifest'));
  const reference = manifest.activationTargetHistory;
  if (!reference) throw new FileSystemError('Maintained activation has no original target reference.');
  const [copy] = copySourceHistoryObservations([observation]);
  if (copy.pathParts.join('/') !== activationTargetHistoryPathParts(reference).join('/') ||
    copy.content === undefined || copy.mode !== reference.mode || copy.content.length !== reference.bytes ||
    rawHistoryDigest(copy.content) !== reference.manifestDigest) {
    throw new FileSystemError('Preserved original activation target differs from its exact path, bytes or mode.');
  }
  const original = reader.parseManifestV8(parseHistoryJson(copy.content, 'original activation target'));
  if (original.activationTargetHistory || original.governance.profile === 'none' || manifest.governance.profile === 'none') {
    throw new FileSystemError('Original activation target cannot be a preservation chain or a governance-none source.');
  }
  for (const field of ['project', 'framework', 'plugins', 'activeLayout', 'projectArtifacts', 'adoptionObservations'] as const) {
    if (canonicalSha256(original[field]) !== canonicalSha256(manifest[field])) {
      throw new FileSystemError(`Original activation target disagrees with current ${field}.`);
    }
  }
  if (canonicalSha256(original.sourceManifestHistory ?? null) !== canonicalSha256(manifest.sourceManifestHistory) ||
    original.governance.profile !== manifest.governance.profile ||
    original.governance.policyVersion !== manifest.governance.policyVersion ||
    canonicalSha256(original.governance.activationIdentity) !== canonicalSha256(manifest.governance.activationIdentity)) {
    throw new FileSystemError('Original activation target has different source history or execution identity.');
  }
  return { manifest: original, content: copy.content, mode: copy.mode };
}
