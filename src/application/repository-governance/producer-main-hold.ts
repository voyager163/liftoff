import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import type {
  ApprovalEnvelope,
  PhaseEvidenceRecord, PhaseId, SavedTransitionPlan, UserActivationState
} from '../../domain/governance/activation/types.js';
import { selectLatestPhaseEvidence, type EvidenceFreshnessContext } from '../../domain/governance/activation/evidence.js';
import { validateApprovalEnvelope, validateSavedTransitionPlan } from '../../domain/governance/activation/validators.js';
import { approvalRequestForSavedPlan, evaluateApprovalForTransitionPlan } from '../../domain/governance/activation/approvals.js';
import { canonicalPhaseGraph } from '../../domain/governance/activation/graph.js';
import {
  productionRulesetSourceDigest,
  type RepositoryControlPlan, type RepositoryControlWriteResult
} from '../../adapters/github/production-rulesets.js';
import { GitHubActivationError, positiveId, text } from '../../adapters/github/activation-rest.js';

export interface MainUpdateHoldRecord {
  schemaVersion: 1;
  repository: string;
  boundMainSha: string;
  ownedControlsDigest: string;
  approvalEnvelopeId: string;
  heldAt: string;
  status: 'active' | 'released';
  releaseCriteria: 'production-qualification-and-separate-approval';
}

export interface MainHoldEvaluationResult {
  canRelease: boolean;
  holdRetained: boolean;
  reasons: readonly string[];
}

export interface ObservedMainUpdateHold extends MainUpdateHoldRecord {
  repositoryId: number;
  actorId: number;
  control: { id: number; nodeId: string; name: 'liftoff-gitflow-main'; definitionDigest: string };
  settingsDigest: string;
  planDigest: string;
  approvalEnvelopeHash: string;
  priorHoldDigest: string | null;
}

export function ownedControlsForMainHold(result: { controls: readonly { definition: Record<string, unknown> }[] }): readonly unknown[] {
  return result.controls.map((entry) => ({
    id: positiveId(entry.definition.id), nodeId: text(entry.definition.node_id, 'Owned control node ID'),
    name: text(entry.definition.name, 'Owned control name'), definitionDigest: productionRulesetSourceDigest([entry.definition])
  })).sort((a, b) => a.id - b.id);
}

export function observedMainUpdateHold(input: {
  plan: RepositoryControlPlan;
  result: RepositoryControlWriteResult;
  planDigest: string;
  approvalEnvelopeId: string;
  approvalEnvelopeHash: string;
  priorHold?: ObservedMainUpdateHold | null;
  now: Date;
}): ObservedMainUpdateHold {
  const main = input.result.controls.find((entry) => entry.definition.name === 'liftoff-gitflow-main');
  const rules = main?.definition.rules;
  if (!main || !Array.isArray(rules) || !rules.some((rule) => isRecord(rule) && rule.type === 'update' &&
    (rule.parameters === undefined || isRecord(rule.parameters) && rule.parameters.update_allows_fetch_and_merge === false)) ||
    canonicalSha256(main.definition.bypass_actors) !== canonicalSha256([]) ||
    canonicalSha256(main.definition.conditions) !== canonicalSha256({ ref_name: { include: ['refs/heads/main'], exclude: [] } }) ||
    main.definition.enforcement !== 'active' || input.plan.mainHold.mode !== 'hold' ||
    input.result.observation.mainSha !== input.plan.baseline.mainSha) {
    throw new GitHubActivationError('main-hold-readback', 'Hold metadata cannot substitute for an independently observed active non-bypassable main-update rule and unchanged main tip.');
  }
  return {
    ...createMainUpdateHold({
      repository: input.result.observation.binding.repository, mainSha: input.result.observation.mainSha,
      ownedControls: ownedControlsForMainHold(input.result), approvalEnvelopeId: input.approvalEnvelopeId, now: input.now
    }),
    repositoryId: input.result.observation.binding.repositoryId, actorId: input.result.observation.binding.actor.id,
    control: {
      id: positiveId(main.definition.id), nodeId: text(main.definition.node_id, 'Main control node ID'),
      name: 'liftoff-gitflow-main', definitionDigest: productionRulesetSourceDigest([main.definition])
    },
    settingsDigest: canonicalSha256(input.plan.desiredSettings), planDigest: input.planDigest,
    approvalEnvelopeHash: input.approvalEnvelopeHash, priorHoldDigest: input.priorHold ? canonicalSha256(input.priorHold) : null
  };
}

/**
 * Creates a main-update hold bound to the current main baseline and owned controls.
 *
 * Prevents unqualified updates to main branch while repository-only governance is active.
 * Does NOT create synthetic staging results or force pushes.
 */
export function createMainUpdateHold(input: {
  repository: string;
  mainSha: string;
  ownedControls: readonly unknown[];
  approvalEnvelopeId: string;
  now?: Date;
}): MainUpdateHoldRecord {
  const ownedControlsDigest = canonicalSha256(input.ownedControls);
  return {
    schemaVersion: 1,
    repository: input.repository,
    boundMainSha: input.mainSha,
    ownedControlsDigest,
    approvalEnvelopeId: input.approvalEnvelopeId,
    heldAt: (input.now ?? new Date()).toISOString(),
    status: 'active',
    releaseCriteria: 'production-qualification-and-separate-approval'
  };
}

/**
 * Evaluates whether an existing main-update hold can be released or replaced.
 *
 * Requirements (Tasks 10.10, 10.11):
 * - Missing proof: retains hold.
 * - Changed main tip: retains hold.
 * - Changed owned controls: retains hold.
 * - Stale or absent approval: retains hold.
 * - Real applicable qualification (staging-qualified, green-red-proof) must be proven.
 */
export function evaluateMainHoldReplacement(input: {
  hold: MainUpdateHoldRecord;
  currentMainSha: string;
  currentOwnedControls: readonly unknown[];
  qualificationEvidence: readonly PhaseEvidenceRecord[];
  qualificationContexts?: Partial<Record<PhaseId, EvidenceFreshnessContext>>;
  replacementPlan?: SavedTransitionPlan;
  state?: UserActivationState;
  replacementApproval?: ApprovalEnvelope | null;
  now?: Date;
}): MainHoldEvaluationResult {
  const reasons: string[] = [];
  const installed = input.hold as Partial<ObservedMainUpdateHold>;
  if (!installed.control || !Number.isSafeInteger(installed.repositoryId) ||
    installed.control.name !== 'liftoff-gitflow-main' || !Number.isSafeInteger(installed.control.id) ||
    typeof installed.control.nodeId !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(installed.control.definitionDigest) ||
    input.hold.status !== 'active') {
    reasons.push('A retained installed main-hold provider identity and independent control readback are required; pure hold metadata is not protection.');
  }

  // Check 1: Main branch tip drift
  if (input.currentMainSha !== input.hold.boundMainSha) {
    reasons.push(
      `Current main tip (${input.currentMainSha}) differs from the reviewed bound baseline (${input.hold.boundMainSha}); retaining main hold.`
    );
  }

  // Check 2: Owned controls drift
  const currentControlsDigest = canonicalSha256(input.currentOwnedControls);
  if (currentControlsDigest !== input.hold.ownedControlsDigest) {
    reasons.push(
      'Live owned ruleset controls differ from the hold baseline; retaining main hold.'
    );
  }

  const qualification = ['staging-qualified', 'production-rehearsed', 'green-red-proof'] as const;
  const completeQualification = qualification.every((phase) => {
    const context = input.qualificationContexts?.[phase];
    if (!context) return false;
    const selected = selectLatestPhaseEvidence(input.qualificationEvidence.filter((record) => record.header.phaseId === phase), context).selected;
    return selected?.header.result === 'verified' && selected.header.scope === 'activation';
  });
  if (!completeQualification) {
    reasons.push(
      'Real current production qualification (staging-qualified, production-rehearsed and green-red-proof) is incomplete; flags and repository proof cannot satisfy production release.'
    );
  }

  // Check 4: Separate replacement approval
  if (!input.replacementApproval) {
    reasons.push(
      'A fresh separately approved transition plan is required to release the main hold.'
    );
  } else {
    const nowTime = (input.now ?? new Date()).getTime();
    if (Date.parse(input.replacementApproval.expiresAt) <= nowTime ||
      Date.parse(input.replacementApproval.approvedAt) <= Date.parse(input.hold.heldAt) ||
      input.replacementApproval.id === input.hold.approvalEnvelopeId) {
      reasons.push('Hold replacement requires a fresh separate approval after the original hold.');
    }
    if (!input.replacementPlan || !input.state || input.state.remoteBinding?.name !== input.hold.repository) {
      reasons.push('An independently bound exact replacement plan and repository state are required.');
    } else {
      try {
        const plan = validateSavedTransitionPlan(input.replacementPlan);
        const approval = validateApprovalEnvelope(input.replacementApproval, {
          expectedIdentity: input.state.identity, requireUnexpired: true, now: input.now ?? new Date()
        });
        const phase = canonicalPhaseGraph.phases.find((phase) => phase.id === plan.phaseId)!;
        const evaluation = evaluateApprovalForTransitionPlan(approvalRequestForSavedPlan(plan, phase, input.state), [approval], { now: input.now });
        const readback = plan.operations.find((operation) => operation.actionId === 'github.ruleset.readback' && isRecord(operation.inputs.controlPlan));
        const controlPlan = readback?.inputs.controlPlan;
        if (plan.scope !== 'activation' || !['enforcement-approved', 'rulesets-applied'].includes(plan.phaseId) ||
          evaluation.approvalRequired || evaluation.envelopeId !== approval.id ||
          !isRecord(controlPlan) || !isRecord(controlPlan.mainHold) || controlPlan.mainHold.mode !== 'replace' ||
          !isRecord(controlPlan.baseline) || controlPlan.baseline.mainSha !== input.hold.boundMainSha ||
          !isRecord(controlPlan.baseline.binding) || controlPlan.baseline.binding.repositoryId !== installed.repositoryId ||
          !Array.isArray(controlPlan.ownedControls) || !controlPlan.ownedControls.some((control) => isRecord(control) &&
            control.id === installed.control?.id && control.nodeId === installed.control?.nodeId)) {
          reasons.push('Replacement approval does not authorize this exact full-activation control plan.');
        }
      } catch {
        reasons.push('Replacement plan or approval is invalid under the current contract.');
      }
    }
  }

  const canRelease = reasons.length === 0;
  return {
    canRelease,
    holdRetained: !canRelease,
    reasons
  };
}
