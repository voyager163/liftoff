import type { ProjectFileSnapshot } from '../adapters/filesystem/project-transaction.js';
import {
  validateManifestHistorySource, validateManifestSourceHistoryReference,
  type ManifestHistorySource, type ManifestSourceHistoryReference
} from '../domain/project/manifest/history.js';
import type { HistoricalV1ActivationIdentity, HistoricalV2ActivationIdentity, ReleasedV3ActivationIdentity } from '../domain/governance/policy/identity.js';
import {
  historyCaseKey, historyFail, historyPathKey, parseHistoryJson, rawHistoryDigest, validateFrozenActivationHistoryIndex, validateFrozenV3SourceIndex
} from './history-contracts.js';
import {
  assertCapturedHistoricalAncestor, validateCapturedHistoricalSnapshot, type HistoricalActivationInventory,
  assertCapturedV3SourceAncestor, assertCapturedV3MetadataAncestry, validateCapturedV3SourceSnapshot, type FrozenV3SourceInventory
} from './historical-state.js';

import { createSourceHistoryCapture, maximumSourceHistoryFiles as maximumFiles } from './source-history-capture.js';

export interface FrozenActivationManifestHistory {
  readonly reference: ManifestSourceHistoryReference & { readonly kind: 'activation-history' };
  readonly source: ManifestHistorySource;
  readonly sourceIdentity: HistoricalV1ActivationIdentity | HistoricalV2ActivationIdentity;
  readonly manifestCopyPathParts: readonly string[];
  readonly captures: readonly ProjectFileSnapshot[];
}

export interface FrozenV3ActivationManifestHistory extends Omit<FrozenActivationManifestHistory, 'sourceIdentity'> {
  readonly sourceIdentity: ReleasedV3ActivationIdentity;
}

/** Stored provenance only; no active successor, write authority or installed target is consulted. */
export async function readFrozenActivationManifestHistory(
  projectRoot: string, reference: unknown
): Promise<FrozenActivationManifestHistory> {
  return readStoredManifestHistory(projectRoot, reference, false);
}

/** New index-1/v3 preservation combination, not a released snapshot writer or execution boundary. */
export async function readFrozenV3ActivationManifestHistory(
  projectRoot: string, reference: unknown
): Promise<FrozenV3ActivationManifestHistory> {
  return readStoredManifestHistory(projectRoot, reference, true);
}

function readStoredManifestHistory(root: string, reference: unknown, v3: false): Promise<FrozenActivationManifestHistory>;
function readStoredManifestHistory(root: string, reference: unknown, v3: true): Promise<FrozenV3ActivationManifestHistory>;
async function readStoredManifestHistory(
  projectRoot: string, reference: unknown, v3: boolean
): Promise<Omit<FrozenActivationManifestHistory, 'sourceIdentity'> & {
  sourceIdentity: FrozenActivationManifestHistory['sourceIdentity'] | ReleasedV3ActivationIdentity;
}> {
  const decoded = validateManifestSourceHistoryReference(reference);
  if (decoded.kind !== 'activation-history') {
    historyFail('manifest source history', 'requires an activation-history reference.', 'unsupported-historical-reference');
  }
  const { assertRoot, capture, captures } = await createSourceHistoryCapture(projectRoot);
  let snapshotId = decoded.snapshotId;
  let indexDigest = decoded.indexDigest;
  const visited = new Set<string>();
  let successor: HistoricalActivationInventory | undefined;
  let v3Successor: FrozenV3SourceInventory | undefined;
  const inventories: (FrozenV3SourceInventory | HistoricalActivationInventory)[] = [];
  let origin: Pick<FrozenActivationManifestHistory | FrozenV3ActivationManifestHistory, 'source' | 'sourceIdentity' | 'manifestCopyPathParts'> | undefined;
  for (;;) {
    if (visited.size >= (v3 ? 3 : 2) || visited.has(snapshotId)) {
      historyFail('frozen history ancestry', v3 ? 'does not follow the three-node v3 source contract.' : 'does not follow the two-node released source contract.', 'invalid-historical-reference');
    }
    visited.add(snapshotId);
    const storedIndex = await capture(['governance', 'history', snapshotId, 'index.json']);
    if (rawHistoryDigest(storedIndex.content) !== indexDigest) {
      historyFail(historyPathKey(storedIndex.pathParts), 'raw index digest differs from its reference.', 'history-digest-mismatch');
    }
    const value = parseHistoryJson(storedIndex.content, historyPathKey(storedIndex.pathParts));
    const index = v3 && visited.size === 1 ? validateFrozenV3SourceIndex(value) : validateFrozenActivationHistoryIndex(value);
    if (index.snapshotId !== snapshotId) historyFail('frozen history index', 'names another snapshot.', 'history-digest-mismatch');
    if (captures.size + index.files.filter(file => !captures.has(historyCaseKey(file.copyPathParts))).length > maximumFiles) {
      historyFail('frozen history index', 'frozen-source inspection exceeds 1024 captured files.', 'history-inspection-limit');
    }
    // State JSON must be nonempty; deferring it admits valid empty files at the exact byte ceiling.
    const scheduled = [...index.files.filter(file => file.kind !== 'state'), ...index.files.filter(file => file.kind === 'state')];
    const copies: ProjectFileSnapshot[] = [];
    for (const file of scheduled) {
      const copy = await capture(file.copyPathParts);
      if (rawHistoryDigest(copy.content) !== file.digest) {
        historyFail(historyPathKey(file.copyPathParts), 'raw copy digest differs from its original index.', 'history-digest-mismatch');
      }
      copies.push(copy);
    }
    let inventory: HistoricalActivationInventory | FrozenV3SourceInventory;
    if (v3 && visited.size === 1) {
      v3Successor = await validateCapturedV3SourceSnapshot(validateFrozenV3SourceIndex(index), copies);
      inventory = v3Successor;
    } else {
      const historicalIndex = validateFrozenActivationHistoryIndex(index);
      inventory = await validateCapturedHistoricalSnapshot(historicalIndex, copies);
      if (v3Successor) {
        assertCapturedV3SourceAncestor(v3Successor, historicalIndex, inventory);
        v3Successor = undefined;
      } else if (successor) assertCapturedHistoricalAncestor(successor, historicalIndex, inventory);
      successor = inventory;
    }
    if (v3) inventories.push(inventory);
    if (!origin) {
      const manifestEntry = index.files.find(file => file.kind === 'manifest')!;
      const copy = captures.get(historyCaseKey(manifestEntry.copyPathParts))!;
      const source = validateManifestHistorySource({
        artifactVersion: inventory.manifest.artifactVersion,
        digest: rawHistoryDigest(copy.content), bytes: copy.content.length, mode: manifestEntry.mode
      });
      if (source.artifactVersion !== index.sourceIdentity.manifestArtifactVersion) {
        historyFail('frozen manifest', 'version contradicts its indexed source identity.', 'invalid-historical-reference');
      }
      origin = {
        source, sourceIdentity: { ...index.sourceIdentity },
        manifestCopyPathParts: Object.freeze([...manifestEntry.copyPathParts])
      };
    }
    if (!inventory.sourceMigration) break;
    snapshotId = inventory.sourceMigration.snapshotId;
    indexDigest = inventory.sourceMigration.historyIndexDigest;
  }
  await assertRoot();
  if (v3) assertCapturedV3MetadataAncestry(inventories);
  if (!origin) return historyFail('frozen manifest', 'has no original manifest.', 'missing-historical-record');
  return Object.freeze({
    reference: Object.freeze({ ...decoded, kind: 'activation-history' as const }), ...origin,
    captures: Object.freeze([...captures.values()])
  });
}

/** Compare with independently observed original input, never with mutable maintenance output. */
export function assertFrozenActivationManifestSource(
  history: FrozenActivationManifestHistory, expectedSource: unknown
): void {
  const expected = validateManifestHistorySource(expectedSource);
  const actual = validateManifestHistorySource(history.source);
  if (actual.artifactVersion !== expected.artifactVersion || actual.digest !== expected.digest ||
    actual.bytes !== expected.bytes || actual.mode !== expected.mode) {
    historyFail('frozen manifest source', 'does not match the exact original version, raw digest, length and mode.', 'historical-source-changed');
  }
}
