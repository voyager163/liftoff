import { activationCompatibility, canonicalPhaseGraph } from './graph.js';
import {
  evidenceContextForPhase,
  type EvidenceFreshnessContext,
  requiredLiveReadbackProviders,
  selectLatestPhaseEvidence
} from './evidence.js';
import { resolveActivationCompatibility } from './identity.js';
import {
  evaluateApprovalForTransitionPlan,
  transitionPlanForPhase
} from './approvals.js';
import type {
  ActivationIdentity,
  ApprovalEnvelope,
  EvidenceHeader,
  ManagedPhaseGraph,
  PhaseEvidenceRecord,
  PhaseGraphNode,
  PhaseId,
  PhaseState,
  UserActivationState
} from './types.js';
import { validateApprovalEnvelope } from './validators.js';

export type PhaseReadiness = {
  phaseId: PhaseId;
  state: PhaseState | 'identity-incompatible';
  blockers: readonly string[];
};

export interface ReadinessResult {
  identityCompatible: boolean;
  identityBlocker?: string;
  phases: Record<PhaseId, PhaseReadiness>;
  nextReadyPhase: PhaseId | null;
}

export interface ReadinessInput {
  graph?: ManagedPhaseGraph;
  state: UserActivationState;
  approvals: readonly ApprovalEnvelope[];
  evidence: readonly (EvidenceHeader | PhaseEvidenceRecord)[];
  transitionContexts?: Partial<Record<PhaseId, EvidenceFreshnessContext>>;
  identity?: ActivationIdentity;
  now?: Date;
}

function phaseMap(graph: ManagedPhaseGraph): Record<PhaseId, PhaseGraphNode> {
  return Object.fromEntries(graph.phases.map((phase) => [phase.id, phase])) as Record<PhaseId, PhaseGraphNode>;
}

function applicabilityApplies(node: PhaseGraphNode, state: UserActivationState): boolean {
  if (node.applicability.kind === 'always') {
    return true;
  }
  if (node.applicability.discriminator === 'state-path') {
    if (node.applicability.when === 'statePath=existing-private') {
      return state.applicability.statePath === 'existing-private';
    }
    if (node.applicability.when === 'statePath=bootstrap-local') {
      return state.applicability.statePath === 'bootstrap-local';
    }
    return state.applicability.statePath !== 'none';
  }
  if (node.applicability.discriminator === 'private-staging-dast') {
    return state.applicability.privateStagingDast;
  }
  return state.applicability.credentialRequired;
}

function isPhaseEvidenceRecord(value: EvidenceHeader | PhaseEvidenceRecord): value is PhaseEvidenceRecord {
  return typeof value === 'object' && value !== null && 'header' in value && 'evidenceId' in value;
}

function evidenceRecord(entry: EvidenceHeader | PhaseEvidenceRecord, index: number): PhaseEvidenceRecord {
  if (isPhaseEvidenceRecord(entry)) {
    return entry;
  }
  return {
    evidenceId: `inline-${index}`,
    header: entry
  };
}

function rawRecordPhaseId(record: PhaseEvidenceRecord): string | undefined {
  return typeof record.header.phaseId === 'string' ? record.header.phaseId : undefined;
}

function dependencySatisfied(
  dependency: PhaseGraphNode['dependencies'][number],
  calculated: Record<string, PhaseReadiness>
): boolean {
  return dependency.anyOf.some((phaseId) => {
    const result = calculated[phaseId];
    return result !== undefined &&
      (dependency.accepts as readonly string[]).includes(result.state);
  });
}

export function calculatePhaseReadiness(input: ReadinessInput): ReadinessResult {
  const graph = input.graph ?? canonicalPhaseGraph;
  const identity = input.identity ?? input.state.identity;
  const compatibility = resolveActivationCompatibility(identity, activationCompatibility);
  const phases = {} as Record<PhaseId, PhaseReadiness>;
  if (!compatibility.compatible) {
    for (const phase of graph.phases) {
      phases[phase.id] = {
        phaseId: phase.id,
        state: 'identity-incompatible',
        blockers: [compatibility.reason]
      };
    }
    return {
      identityCompatible: false,
      identityBlocker: compatibility.reason,
      phases,
      nextReadyPhase: null
    };
  }

  const now = input.now ?? new Date();
  const approvals = input.approvals.map((approval) => validateApprovalEnvelope(approval));
  const evidence = input.evidence.map((entry, index) => evidenceRecord(entry, index));
  const byId = phaseMap(graph);
  for (const node of graph.phases) {
    const stored = input.state.phases[node.id];
    const blockers: string[] = [];
    if (!applicabilityApplies(node, input.state)) {
      phases[node.id] = { phaseId: node.id, state: 'inapplicable', blockers: [] };
      continue;
    }
    const recordsForPhase = evidence.filter((record) => rawRecordPhaseId(record) === node.id);
    const context = input.transitionContexts?.[node.id] ?? evidenceContextForPhase(node.id, {
      repositoryId: input.state.repository.id,
      identity,
      liveReadbackProviders: requiredLiveReadbackProviders(node),
      now
    });
    const selectedEvidence = selectLatestPhaseEvidence(recordsForPhase, context);
    if (selectedEvidence.selected?.header.result === 'failed' || stored.state === 'failed') {
      phases[node.id] = {
        phaseId: node.id,
        state: 'failed',
        blockers: selectedEvidence.selected?.header.result === 'failed' ? [] : stored.blockers
      };
      continue;
    }
    if (selectedEvidence.selected) {
      const foundEvidence = selectedEvidence.selected.header;
      phases[node.id] = {
        phaseId: node.id,
        state: foundEvidence.result === 'retained' ? 'retained' : foundEvidence.result,
        blockers: []
      };
      continue;
    }
    if (recordsForPhase.length > 0 && selectedEvidence.issues.length > 0) {
      phases[node.id] = {
        phaseId: node.id,
        state: 'blocked',
        blockers: selectedEvidence.issues.map((entry) => entry.message)
      };
      continue;
    }
    if (stored.state === 'running') {
      phases[node.id] = { phaseId: node.id, state: 'running', blockers: [] };
      continue;
    }
    if (stored.state === 'blocked' && stored.blockers.length > 0) {
      phases[node.id] = { phaseId: node.id, state: 'blocked', blockers: stored.blockers };
      continue;
    }
    if (
      node.id === 'bootstrap-state-disposed' &&
      input.state.bootstrapState?.status === 'retained' &&
      Date.parse(input.state.bootstrapState.disposeAfter) > now.getTime()
    ) {
      phases[node.id] = {
        phaseId: node.id,
        state: 'blocked',
        blockers: [`Retained bootstrap state is not disposable until ${input.state.bootstrapState.disposeAfter}.`]
      };
      continue;
    }
    for (const dependency of node.dependencies) {
      if (!dependencySatisfied(dependency, phases)) {
        blockers.push(dependency.description);
      }
    }
    if (node.approvalGate.required) {
      const approval = evaluateApprovalForTransitionPlan(
        transitionPlanForPhase(byId[node.id], input.state, context.transition),
        approvals,
        { now }
      );
      if (approval.approvalRequired) {
        blockers.push(
          `Approval gate ${node.approvalGate.kind} is not satisfied: ${approval.reasons.join('; ')}`
        );
      }
    }
    if (blockers.length > 0) {
      phases[node.id] = { phaseId: node.id, state: 'blocked', blockers };
      continue;
    }
    if (stored.state === 'approved' && (node.terminalStates as readonly string[]).includes('approved')) {
      phases[node.id] = { phaseId: node.id, state: 'approved', blockers: [] };
      continue;
    }
    phases[node.id] = { phaseId: node.id, state: 'ready', blockers: [] };
  }
  return {
    identityCompatible: true,
    phases,
    nextReadyPhase: graph.phases.find((phase) => phases[phase.id].state === 'ready')?.id ?? null
  };
}
