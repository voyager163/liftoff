import { activationCompatibility, canonicalPhaseGraph } from './graph.js';
import {
  evidenceContextForPhase,
  type EvidenceFreshnessContext,
  requiredLiveReadbackProviders,
  selectLatestPhaseEvidence
} from './evidence.js';
import { resolveActivationCompatibility } from '../policy/identity.js';
import {
  approvalRequestForSavedPlan,
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
import { type GovernanceScope, phaseScope } from './types.js';
import { validateApprovalEnvelope } from './validators.js';

export type PhaseReadiness = {
  phaseId: PhaseId;
  state: PhaseState | 'identity-incompatible';
  blockers: readonly string[];
  plannable?: boolean;
  approvalRequired?: boolean;
  recoveryRequired?: boolean;
};

export interface ReadinessResult {
  identityCompatible: boolean;
  identityBlocker?: string;
  phases: Record<PhaseId, PhaseReadiness>;
  nextReadyPhase: PhaseId | null;
  nextPlannablePhase: PhaseId | null;
  scope: GovernanceScope;
  completion: Record<GovernanceScope, boolean>;
}

export interface ReadinessInput {
  graph?: ManagedPhaseGraph;
  state: UserActivationState;
  approvals: readonly ApprovalEnvelope[];
  evidence: readonly (EvidenceHeader | PhaseEvidenceRecord)[];
  transitionContexts?: Partial<Record<PhaseId, EvidenceFreshnessContext>>;
  identity?: ActivationIdentity;
  now?: Date;
  phaseBlockers?: Partial<Record<PhaseId, readonly string[]>>;
  retryArchivedSeedBaseline?: boolean;
  scope?: GovernanceScope;
  recoverPhase?: PhaseId;
  historicalLifecycleBlockers?: readonly string[];
}

const terminalStates = new Set<PhaseState>([
  'approved',
  'verified',
  'failed',
  'inapplicable',
  'retained',
  'disposed'
]);

function phaseMap(graph: ManagedPhaseGraph): Record<PhaseId, PhaseGraphNode> {
  return Object.fromEntries(graph.phases.map((phase) => [phase.id, phase])) as Record<PhaseId, PhaseGraphNode>;
}

function propagatedPhaseBlockers(
  graph: ManagedPhaseGraph,
  explicit: Partial<Record<PhaseId, readonly string[]>>
): Partial<Record<PhaseId, readonly string[]>> {
  const propagated: Partial<Record<PhaseId, readonly string[]>> = {};
  for (const node of graph.phases) {
    const direct = explicit[node.id] ?? [];
    if (direct.length > 0) {
      propagated[node.id] = direct;
      continue;
    }
    const inherited = node.dependencies.flatMap((dependency) => {
      const alternatives = dependency.anyOf.map((phaseId) => ({
        phaseId,
        blockers: propagated[phaseId] ?? []
      }));
      if (alternatives.length === 0 || alternatives.some((entry) => entry.blockers.length === 0)) {
        return [];
      }
      return [
        `${dependency.description} Blocked upstream: ${alternatives
          .map((entry) => `${entry.phaseId}: ${entry.blockers.join('; ')}`)
          .join(' | ')}`
      ];
    });
    if (inherited.length > 0) {
      propagated[node.id] = inherited;
    }
  }
  return propagated;
}

export function applicabilityApplies(node: PhaseGraphNode, state: UserActivationState): boolean | 'unknown' {
  if (node.applicability.kind === 'always') {
    return true;
  }
  if (node.applicability.discriminator === 'state-path') {
    if (state.applicability.cloudStateRequired === false) return false;
    if (state.applicability.statePath === 'none') return 'unknown';
    if (node.applicability.when === 'statePath=existing-private') {
      return state.applicability.statePath === 'existing-private';
    }

    if (node.applicability.when === 'statePath=bootstrap-local') {
      return state.applicability.statePath === 'bootstrap-local';
    }
    return true;
  }
  if (node.applicability.discriminator === 'private-staging-dast') {
    return state.applicability.privateStagingDast;
  }
  if (node.applicability.discriminator === 'cloud-state-required') return state.applicability.cloudStateRequired ?? 'unknown';
  if (node.applicability.discriminator === 'private-runner-required') return state.applicability.privateRunnerRequired ?? 'unknown';
  return state.applicability.credentialRequired;
}

function hasApplicabilityProof(
  node: PhaseGraphNode,
  state: UserActivationState,
  records: readonly PhaseEvidenceRecord[],
  contexts: ReadinessInput['transitionContexts']
): boolean {
  if (node.applicability.kind === 'always') return true;
  const statePath = node.applicability.discriminator === 'state-path' && state.applicability.cloudStateRequired !== false;
  const sourceId = statePath ? 'state-path-selected' : 'phase-0-complete';
  const context = contexts?.[sourceId];
  if (!context) return false;
  const selected = selectLatestPhaseEvidence(records.filter((record) => record.header.phaseId === sourceId), context).selected;
  if (selected?.header.result !== 'verified') return false;
  const payload = selected.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  if (statePath) return value.statePath === state.applicability.statePath;
  const factId = node.applicability.discriminator === 'credential-required' ? 'credentialRequired' :
    node.applicability.discriminator === 'private-staging-dast' ? 'privateStagingDast' :
      node.applicability.discriminator === 'private-runner-required' ? 'privateRunnerRequired' : 'cloudStateRequired';
  return Array.isArray(value.facts) && value.facts.some((fact) => typeof fact === 'object' && fact !== null &&
    fact.id === factId && fact.value === state.applicability[factId]);
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

export function dependencySatisfied(
  dependency: PhaseGraphNode['dependencies'][number],
  calculated: Record<string, PhaseReadiness>,
  state: UserActivationState
): boolean {
  const selected = dependency.anyOf.includes('existing-private-path') && dependency.anyOf.includes('remote-import-verified')
    ? dependency.anyOf.filter((id) => state.applicability.statePath === 'existing-private'
      ? id === 'existing-private-path' : state.applicability.statePath === 'bootstrap-local' && id === 'remote-import-verified')
    : dependency.anyOf;
  return selected.some((phaseId) => {
    const result = calculated[phaseId];
    return result !== undefined &&
      (selected.length === dependency.anyOf.length || result.state !== 'inapplicable') &&
      (dependency.accepts as readonly string[]).includes(result.state);
  });
}

export function calculatePhaseReadiness(input: ReadinessInput): ReadinessResult {
  const graph = input.graph ?? canonicalPhaseGraph;
  const scope = input.scope ?? 'activation';
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
      nextReadyPhase: null,
      nextPlannablePhase: null,
      scope,
      completion: { local: false, activation: false, lifecycle: false }
    };
  }

  const now = input.now ?? new Date();
  const approvals = input.approvals.map((approval) => validateApprovalEnvelope(approval));
  const evidence = input.evidence.map((entry, index) => evidenceRecord(entry, index));
  const externalPhaseBlockers = propagatedPhaseBlockers(graph, input.phaseBlockers ?? {});
  for (const node of graph.phases) {
    const stored = input.state.phases[node.id];
    const blockers: string[] = [];
    const recordsForPhase = evidence.filter((record) => rawRecordPhaseId(record) === node.id);
    const context = input.transitionContexts?.[node.id];
    if (!context) {
      phases[node.id] = { phaseId: node.id, state: 'blocked', blockers: ['Current independently read phase inputs are unavailable.'] };
      continue;
    }
    const selectedEvidence = selectLatestPhaseEvidence(recordsForPhase, context);
    if (
      selectedEvidence.selected &&
      !(node.terminalStates as readonly string[]).includes(selectedEvidence.selected.header.result)
    ) {
      phases[node.id] = {
        phaseId: node.id,
        state: 'blocked',
        blockers: [
          `Evidence ${selectedEvidence.selected.evidenceId} reports ${selectedEvidence.selected.header.result}, ` +
            `which is not an allowed terminal state for ${node.id}.`
        ]
      };
      continue;
    }
    if (
      terminalStates.has(stored.state) &&
      !(node.terminalStates as readonly string[]).includes(stored.state)
    ) {
      phases[node.id] = {
        phaseId: node.id,
        state: 'blocked',
        blockers: [`Stored state ${stored.state} is not an allowed terminal state for ${node.id}.`]
      };
      continue;
    }
    const applicability = applicabilityApplies(node, input.state);
    if (node.id === 'bootstrap-state-disposed' && input.historicalLifecycleBlockers?.length) {
      phases[node.id] = { phaseId: node.id, state: 'blocked', blockers: input.historicalLifecycleBlockers, plannable: false };
      continue;
    }
    if (applicability === 'unknown') {
      phases[node.id] = { phaseId: node.id, state: 'blocked', blockers: ['Applicability is unknown; independent current facts are required before this phase can be skipped.'] };
      continue;
    }
    if (!applicability) {
      if (!hasApplicabilityProof(node, input.state, evidence, input.transitionContexts)) {
        phases[node.id] = { phaseId: node.id, state: 'blocked', blockers: ['Inapplicability has no current independent applicability proof.'] };
        continue;
      }
      phases[node.id] = { phaseId: node.id, state: 'inapplicable', blockers: [] };
      continue;
    }
    const externalBlockers = externalPhaseBlockers[node.id] ?? [];
    if (externalBlockers.length > 0) {
      phases[node.id] = { phaseId: node.id, state: 'blocked', blockers: externalBlockers };
      continue;
    }
    const localRetry = ['seed-valid', 'seed-verified', 'seed-archived'].includes(node.id);
    if (!localRetry && input.recoverPhase !== node.id && stored.state === 'blocked' &&
      (stored.operation || stored.executionPlanDigest)) {
      phases[node.id] = {
        phaseId: node.id, state: 'blocked', recoveryRequired: true,
        blockers: [...stored.blockers, 'An interrupted or partial external execution requires an explicitly reviewed recovery plan.']
      };
      continue;
    }
    if (!localRetry && input.recoverPhase !== node.id &&
      (selectedEvidence.selected?.header.result === 'failed' || stored.state === 'failed' || stored.operation?.status === 'failed')) {
      phases[node.id] = {
        phaseId: node.id,
        state: 'failed',
        blockers: stored.blockers.length ? stored.blockers : ['The prior operation failed; preview and explicitly approve its recovery before retrying.'],
        recoveryRequired: true
      };
      continue;
    }
    const staleInputFields = new Set(['baselineSha', 'inputDigest', 'transition.baselineSha', 'transition.inputDigest', 'transition.transitionDigest',
      'payload.synchronizedSpecDigest', 'remoteBindingDigest']);
    const integrityIssues = selectedEvidence.issues.filter((issue) =>
      !staleInputFields.has(issue.field) && !(issue.field === 'plan' && issue.message === 'Evidence phase, current inputs, or timing differ from the reviewed transition plan.')
    );
    if (recordsForPhase.length > 0 && integrityIssues.length > 0) {
      phases[node.id] = {
        phaseId: node.id,
        state: 'blocked',
        blockers: integrityIssues.map((entry) => entry.message)
      };
      continue;
    }
    if (!localRetry && stored.state === 'running' && !stored.operation && input.recoverPhase !== node.id) {
      phases[node.id] = {
        phaseId: node.id, state: 'blocked',
        blockers: ['The running phase has no external operation handle; inspect and approve recovery rather than dispatching it again.'],
        recoveryRequired: true
      };
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
      if (input.recoverPhase === node.id && (stored.executionPlanDigest || stored.operation?.planDigest)) continue;
      if (!dependencySatisfied(dependency, phases, input.state)) {
        blockers.push(dependency.description);
      }
    }
    if (blockers.length > 0) {
      phases[node.id] = { phaseId: node.id, state: 'blocked', blockers, plannable: false };
      continue;
    }
    if (selectedEvidence.selected && selectedEvidence.selected.header.result !== 'failed') {
      phases[node.id] = {
        phaseId: node.id, state: selectedEvidence.selected.header.result, blockers: [], plannable: false
      };
      continue;
    }
    let approvalRequired = false;
    if (node.approvalGate.required) {
      const reviewed = context.reviewedPlans?.filter((plan) =>
        plan.phaseId === node.id && plan.inputDigest === context.inputDigest && plan.baselineDigest === context.baselineSha
      ).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
      const approval = evaluateApprovalForTransitionPlan(
        reviewed ? approvalRequestForSavedPlan(reviewed, node, input.state) :
          transitionPlanForPhase(node, input.state, context.transition, undefined, context.publicationDestination),
        approvals,
        { now }
      );
      approvalRequired = approval.approvalRequired;
      if (approval.approvalRequired) {
        blockers.push(
          `Approval gate ${node.approvalGate.kind} is not satisfied: ${approval.reasons.join('; ')}. Preview this phase and use governance approve with its exact plan fingerprint.`
        );
      }
    }
    if (blockers.length > 0) {
      phases[node.id] = { phaseId: node.id, state: 'blocked', blockers, plannable: true, approvalRequired };
      continue;
    }
    if (stored.state === 'approved' && (node.terminalStates as readonly string[]).includes('approved')) {
      phases[node.id] = { phaseId: node.id, state: 'approved', blockers: [] };
      continue;
    }
    phases[node.id] = {
      phaseId: node.id, state: stored.state === 'running' && input.recoverPhase !== node.id ? 'running' : 'ready',
      blockers: [], plannable: true, approvalRequired: false
    };
  }
  const succeeded = new Set(['approved', 'verified', 'inapplicable', 'retained', 'disposed']);
  const localComplete = graph.completionGroups.local.every((id) => succeeded.has(phases[id].state));
  const effectiveScope = input.scope ?? (localComplete ? 'activation' : 'local');
  const scoped = graph.phases.filter((phase) => phaseScope(phase.id) === effectiveScope);
  return {
    identityCompatible: true,
    phases,
    scope: effectiveScope,
    nextReadyPhase: scoped.find((phase) => phases[phase.id].state === 'ready')?.id ?? null,
    nextPlannablePhase: scoped.find((phase) => phases[phase.id].plannable)?.id ?? null,
    completion: {
      local: localComplete,
      activation: [...graph.completionGroups.local, ...graph.completionGroups.activation].every((id) => succeeded.has(phases[id].state)),
      lifecycle: graph.completionGroups.lifecycle.every((id) => succeeded.has(phases[id].state))
    }
  };
}
