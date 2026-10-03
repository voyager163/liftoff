import { buildPhaseDefinitions } from './phase-graph-values.js';
import { canonicalJson, canonicalSha256, sha256Hex } from './canonical-json.js';
import {
  activationContractVersion,
  approvalEnvelopeSchemaVersion,
  buildActivationCompatibilityMap,
  createActivationIdentity,
  evidenceHeaderSchemaVersion,
  governanceActivationPolicyVersion,
  liftoffActivationPackageVersion,
  phaseGraphSchemaVersion
} from '../policy/identity.js';
import type {
  ActivationIdentity,
  ManagedPhaseGraph,
  MutationClass,
  PhaseGraphNode,
  PhaseId,
  LiveReadbackProvider,
  TerminalPhaseState
} from './types.js';
import { activationPhaseIds, lifecyclePhaseIds, localSetupPhaseIds } from './types.js';

const rawPhases: readonly PhaseGraphNode[] = buildPhaseDefinitions({
  evidenceHeaderSchemaVersion, approvalEnvelopeSchemaVersion
});

export const canonicalPhaseGraph = {
  schemaVersion: phaseGraphSchemaVersion,
  versions: {
    liftoffVersion: liftoffActivationPackageVersion,
    policyVersion: governanceActivationPolicyVersion,
    activationContractVersion,
    phaseGraphSchemaVersion
  },
  completionGroups: {
    local: localSetupPhaseIds,
    activation: activationPhaseIds,
    lifecycle: lifecyclePhaseIds
  },
  phases: rawPhases
} as const satisfies ManagedPhaseGraph;

export type CanonicalPhaseGraph = typeof canonicalPhaseGraph;

function phaseBehavior(node: PhaseGraphNode): Omit<PhaseGraphNode, 'label'> {
  return {
    id: node.id,
    dependencies: node.dependencies,
    applicability: node.applicability,
    allowedMutations: node.allowedMutations,
    evidence: node.evidence,
    approvalGate: node.approvalGate,
    invalidationInputs: node.invalidationInputs,
    rollback: node.rollback,
    terminalStates: node.terminalStates
  };
}

export function phaseContractDigest(node: PhaseGraphNode): string {
  return sha256Hex(canonicalJson(phaseBehavior(node)));
}

export function phaseContractDigests(
  graph: ManagedPhaseGraph = canonicalPhaseGraph
): Record<PhaseId, string> {
  return Object.fromEntries(
    graph.phases.map((node) => [node.id, phaseContractDigest(node)])
  ) as Record<PhaseId, string>;
}

export const canonicalPhaseGraphJson = canonicalJson(canonicalPhaseGraph);
export const canonicalPhaseGraphHash = canonicalSha256(canonicalPhaseGraph);
export const canonicalPhaseContractDigests = phaseContractDigests(canonicalPhaseGraph);
export const currentActivationIdentity: ActivationIdentity = createActivationIdentity(canonicalPhaseGraphHash);
export const activationCompatibility = buildActivationCompatibilityMap([
  currentActivationIdentity
]);
