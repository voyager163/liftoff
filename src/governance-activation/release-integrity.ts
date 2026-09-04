import { canonicalSha256 } from './canonical-json.js';
import { phaseContractDigests } from './graph.js';
import type { ActivationIdentity, ManagedPhaseGraph, PhaseId } from './types.js';

export interface ReleaseIntegrityInput {
  previousGraph: ManagedPhaseGraph;
  currentGraph: ManagedPhaseGraph;
  previousIdentity: ActivationIdentity;
  currentIdentity: ActivationIdentity & { setupSkillVersion?: string };
  compatibleGraphHashes: ReadonlyMap<string, string>;
}

function digestEntries(graph: ManagedPhaseGraph): [PhaseId, string][] {
  return Object.entries(phaseContractDigests(graph)) as [PhaseId, string][];
}

function equalDigestMaps(left: ManagedPhaseGraph, right: ManagedPhaseGraph): boolean {
  const leftEntries = digestEntries(left);
  const rightEntries = digestEntries(right);
  return leftEntries.length === rightEntries.length &&
    leftEntries.every(([phaseId, digest]) =>
      rightEntries.some(([otherPhaseId, otherDigest]) => otherPhaseId === phaseId && otherDigest === digest)
    );
}

function changedPhaseDigests(left: ManagedPhaseGraph, right: ManagedPhaseGraph): PhaseId[] {
  const rightDigests = phaseContractDigests(right);
  return digestEntries(left)
    .filter(([phaseId, digest]) => rightDigests[phaseId] !== digest)
    .map(([phaseId]) => phaseId);
}

export function validateReleaseIntegrity(input: ReleaseIntegrityInput): void {
  if (input.currentIdentity.setupSkillVersion !== undefined) {
    throw new Error('Setup wrapper content must not introduce an independent skill version.');
  }
  const previousHash = canonicalSha256(input.previousGraph);
  const currentHash = canonicalSha256(input.currentGraph);
  if (input.previousIdentity.phaseGraphHash !== previousHash) {
    throw new Error('Previous activation identity does not match previous graph hash.');
  }
  if (input.currentIdentity.phaseGraphHash !== currentHash) {
    throw new Error('Current activation identity does not match current graph hash.');
  }
  const graphBytesChanged = previousHash !== currentHash;
  const schemaChanged = input.previousGraph.schemaVersion !== input.currentGraph.schemaVersion;
  const behaviorChanged = changedPhaseDigests(input.previousGraph, input.currentGraph);
  if (!graphBytesChanged && behaviorChanged.length === 0 && !schemaChanged) {
    return;
  }
  if (schemaChanged && input.currentIdentity.phaseGraphSchemaVersion <= input.previousIdentity.phaseGraphSchemaVersion) {
    throw new Error('Phase-graph schema drift requires a phaseGraphSchemaVersion bump.');
  }
  if (behaviorChanged.length > 0 && input.currentIdentity.activationContractVersion <= input.previousIdentity.activationContractVersion) {
    throw new Error(`Phase behavior drift requires an activation-contract bump: ${behaviorChanged.join(', ')}.`);
  }
  if (graphBytesChanged && equalDigestMaps(input.previousGraph, input.currentGraph)) {
    const mapped = input.compatibleGraphHashes.get(previousHash);
    if (mapped !== currentHash) {
      throw new Error('Nonsemantic phase-graph byte drift requires an explicit compatible hash mapping.');
    }
  }
}
