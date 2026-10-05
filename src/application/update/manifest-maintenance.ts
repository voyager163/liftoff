import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { FileSystemError } from '../../domain/project/errors.js';
import { manifestHistoryPaths } from '../../domain/project/manifest/history.js';
import type { ActivationTargetHistoryReference } from '../../domain/project/manifest/activation-target-history.js';
import { createManifestV8Reader } from '../../domain/project/manifest/v8.js';
import { activationStateFilePathParts } from '../../governance-activation/activation-state.js';
import { migrationStateFilePathParts, parseHistoryJson, rawHistoryDigest } from '../../governance-activation/history-contracts.js';
import { copySourceHistoryData, copySourceHistoryObservations } from '../../governance-activation/source-history-capture.js';
import { projectCatalog } from '../project/catalog.js';
import { resolveModernManifestV8SourceContract } from '../project/manifest.js';
import { createManifestV8Candidate, type ManagedManifestDecision } from '../project/manifest-writer.js';
import { resolveModernProjectSourceContext, type ModernProjectSourceInput } from '../project/source-context.js';
import { readPreservedStandaloneManifest, type CapturedPresentFile } from './manifest-history.js';

export const manifestOnlyAbsentControlPaths = [
  activationStateFilePathParts, migrationStateFilePathParts,
  ['governance', 'credentials', 'preflight-policy.json'], ['governance', 'activation-baseline.json']
] as const;

const reader = createManifestV8Reader({ catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract });
function fail(detail: string): never {
  throw new FileSystemError(`Current manifest maintenance: ${detail}`);
}

/** Captured data is not filesystem truth, collection membership or publication authority. */
export function readCurrentManifestMaintenanceSource(captures: readonly ProjectFileSnapshot[]) {
  const snapshots = copySourceHistoryObservations(captures);
  const files = new Map(snapshots.map(file => [file.pathParts.join('/'), file]));
  function present(parts: readonly string[]): CapturedPresentFile {
    const file = files.get(parts.join('/'));
    if (!file || file.content === undefined || file.mode === undefined) fail(`required source ${parts.join('/')} was not captured.`);
    return { pathParts: [...file.pathParts], content: file.content, mode: file.mode };
  }
  for (const parts of manifestOnlyAbsentControlPaths) {
    const file = files.get(parts.join('/'));
    if (!file || file.content !== undefined) fail('requires observed absence of activation controls; active maintenance is a separate operation.');
  }
  const original = present(['liftoff.manifest.json']);
  const manifest = reader.parseManifestV8(parseHistoryJson(original.content, 'current source manifest'));
  if (manifest.sourceManifestHistory?.kind === 'activation-history') fail('missing activation state cannot retire or reinterpret activation history.');
  if (manifest.sourceManifestHistory) {
    const paths = manifestHistoryPaths(manifest.sourceManifestHistory);
    const historical = readPreservedStandaloneManifest(
      manifest.sourceManifestHistory, present(paths.indexPathParts), present(paths.manifestPathParts)
    );
    for (const field of ['project', 'framework', 'projectArtifacts'] as const) {
      if (canonicalSha256(historical[field]) !== canonicalSha256(manifest[field])) fail(`preserved history disagrees with current ${field}.`);
    }
    if (historical.governance.profile !== 'unspecified' && historical.governance.profile !== manifest.governance.profile) {
      fail('preserved history does not authorize a profile transition.');
    }
  }
  return { manifest, original, snapshots };
}

export function prepareManifestMaintenanceCandidate(
  original: CapturedPresentFile, selected: ModernProjectSourceInput, managed: readonly ManagedManifestDecision[],
  activationTargetHistory?: ActivationTargetHistoryReference
) {
  const [captured] = copySourceHistoryObservations([{
    pathParts: [...original.pathParts], content: original.content, mode: original.mode
  }]);
  if (captured.pathParts.join('/') !== 'liftoff.manifest.json' || captured.content === undefined || captured.mode === undefined) {
    fail('requires an actual captured source manifest.');
  }
  const source = reader.parseManifestV8(parseHistoryJson(captured.content, 'current source manifest'));
  const resolved = resolveModernProjectSourceContext(copySourceHistoryData(selected, 'current maintenance selection'));
  const selection: ModernProjectSourceInput = {
    selection: resolved.selection, plugins: resolved.plugins, activeLayout: resolved.activeLayout
  };
  const recorded = {
    selection: { project: source.project, framework: source.framework, profile: source.governance.profile },
    plugins: source.plugins, activeLayout: source.activeLayout
  };
  if (canonicalSha256(recorded) !== canonicalSha256(selection)) fail('cannot change the recorded project, framework, profile, plugins or active layout.');
  const candidate = createManifestV8Candidate({
    origin: 'maintenance', source: parseHistoryJson(captured.content, 'current source manifest'),
    managed: copySourceHistoryData(managed, 'current maintenance managed decisions'),
    ...(activationTargetHistory ? { activationTargetHistory } : {})
  });
  const manifestChanged = canonicalSha256(candidate.manifest) !== canonicalSha256(source);
  const content = manifestChanged ? candidate.content : captured.content.toString('utf8');
  const manifest = { ...candidate, content, digest: rawHistoryDigest(Buffer.from(content)) };
  return { manifest, manifestChanged };
}

export function prepareCurrentManifestMaintenance(
  captures: readonly ProjectFileSnapshot[], selected: ModernProjectSourceInput, managed: readonly ManagedManifestDecision[]
) {
  const source = readCurrentManifestMaintenanceSource(captures);
  const { manifest, manifestChanged } = prepareManifestMaintenanceCandidate(source.original, selected, managed);
  return {
    manifest, manifestChanged, preconditions: source.snapshots,
    semanticTransitionDigest: canonicalSha256({
      schemaVersion: 1, kind: 'liftoff-manifest-maintenance',
      sourceManifestDigest: rawHistoryDigest(source.original.content), targetManifestDigest: manifest.digest
    })
  };
}
