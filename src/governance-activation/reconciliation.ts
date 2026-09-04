import { canonicalPhaseGraph, canonicalPhaseGraphHash, phaseContractDigests } from './graph.js';
import type {
  GraphReconciliationRecord,
  ManagedPhaseGraph,
  PhaseId
} from './types.js';
import { phaseIds } from './types.js';
import { validateGraphReconciliationRecord } from './validators.js';

export interface GraphReconciliationResult {
  record: GraphReconciliationRecord;
  preservedPhaseIds: readonly PhaseId[];
  invalidPhaseIds: readonly PhaseId[];
}

function descendantsOf(graph: ManagedPhaseGraph, changed: ReadonlySet<PhaseId>): Set<PhaseId> {
  const descendants = new Set<PhaseId>(changed);
  let changedDuringPass = true;
  while (changedDuringPass) {
    changedDuringPass = false;
    for (const node of graph.phases) {
      if (descendants.has(node.id)) {
        continue;
      }
      if (node.dependencies.some((dependency) => dependency.anyOf.some((phaseId) => descendants.has(phaseId)))) {
        descendants.add(node.id);
        changedDuringPass = true;
      }
    }
  }
  return descendants;
}

function assertMappingMatchesGraph(
  record: GraphReconciliationRecord,
  fromGraph: ManagedPhaseGraph,
  toGraph: ManagedPhaseGraph
): void {
  const fromDigests = phaseContractDigests(fromGraph);
  const toDigests = phaseContractDigests(toGraph);
  for (const mapping of record.phaseMappings) {
    if (fromDigests[mapping.phaseId] !== mapping.fromContractDigest) {
      throw new Error(`graphReconciliation phase ${mapping.phaseId} fromContractDigest does not match the recognized source graph.`);
    }
    if (toDigests[mapping.phaseId] !== mapping.toContractDigest) {
      throw new Error(`graphReconciliation phase ${mapping.phaseId} toContractDigest does not match the recognized target graph.`);
    }
  }
}

export function calculateGraphReconciliation(
  value: unknown,
  options: {
    fromGraph?: ManagedPhaseGraph;
    toGraph?: ManagedPhaseGraph;
    recognizedGraphHashes?: ReadonlySet<string>;
  } = {}
): GraphReconciliationResult {
  const fromGraph = options.fromGraph ?? canonicalPhaseGraph;
  const toGraph = options.toGraph ?? canonicalPhaseGraph;
  const recognizedGraphHashes = options.recognizedGraphHashes ?? new Set([canonicalPhaseGraphHash]);
  const record = validateGraphReconciliationRecord(value, recognizedGraphHashes);
  assertMappingMatchesGraph(record, fromGraph, toGraph);
  const directlyChanged = new Set(
    record.phaseMappings
      .filter((mapping) => !mapping.preserveEvidence || mapping.fromContractDigest !== mapping.toContractDigest)
      .map((mapping) => mapping.phaseId)
  );
  const invalid = descendantsOf(toGraph, directlyChanged);
  const preserved = phaseIds.filter((phaseId) => {
    if (invalid.has(phaseId)) {
      return false;
    }
    const mapping = record.phaseMappings.find((entry) => entry.phaseId === phaseId);
    return mapping !== undefined &&
      mapping.preserveEvidence &&
      mapping.fromContractDigest === mapping.toContractDigest;
  });
  return {
    record,
    preservedPhaseIds: preserved,
    invalidPhaseIds: phaseIds.filter((phaseId) => invalid.has(phaseId))
  };
}
