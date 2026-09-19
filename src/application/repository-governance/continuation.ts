import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { phaseIds, phaseInScope, type GovernanceScope, type SavedTransitionPlan } from '../../domain/governance/activation/types.js';
import { createStructuredContinuation } from '../../protocol/continuation.js';
import { parseCommandTokens } from '../../domain/execution/command-line.js';
import { reviewMatchesPlan } from '../../governance-activation/phase-reviews.js';
import type { GovernanceSubcommand, GovernanceInspection, GovernanceNextAction } from './inspection-contracts.js';


export function governanceAction(
  inspection: GovernanceInspection,
  subcommand: GovernanceSubcommand,
  scope: GovernanceScope,
  extras: readonly string[] = [],
  approvalRequired = false
): GovernanceNextAction {
  const binding = inspection.configurationBinding;
  const args = ['governance', subcommand, '--project', inspection.projectRoot, '--scope', scope,
    ...(binding ? ['--inputs', binding.reference] : []), ...extras, '--json'];
  const parsed = parseCommandTokens(args).parsed;
  const continuation = createStructuredContinuation({
    args, cwd: inspection.projectRoot, scope, project: inspection.projectRoot, targetScope: 'project',
    ...(binding ? { configPath: binding.reference, configDigest: binding.digest } : {}),
    requiredAuthority: [
      ...(approvalRequired || subcommand === 'approve' ? ['exact-governance-plan'] : []),
      ...(parsed.flags.execute === true ? ['exact-governance-plan-execution'] : []),
      ...(subcommand === 'credential-enroll' ? ['protected-credential-enrollment'] : [])
    ],
    compatibilityIdentity: canonicalSha256(inspection.state.identity)
  });
  return {
    ...continuation, continuation,
    id: `governance-${subcommand}-${scope}`, label: `${subcommand} ${scope} governance`,
    command: { executable: 'liftoff', args: [...continuation.args] }, scope, approvalRequired
  };
}

export function governanceNextActions(
  inspection: GovernanceInspection,
  preview?: { fingerprint: string; plan: SavedTransitionPlan }
): GovernanceNextAction[] {
  if (inspection.manifest.governance.profile === 'none' && inspection.scope === 'activation') return [];
  if (inspection.readiness.completion[inspection.scope]) {
    if (inspection.scope === 'local') return [governanceAction(inspection, 'plan', 'activation')];
    if (inspection.scope === 'activation' && !inspection.readiness.completion.lifecycle) {
      return [governanceAction(inspection, 'status', 'lifecycle')];
    }
    return [];
  }
  if (preview) {
    const originals = inspection.contexts[preview.plan.phaseId].reviewedPlans ?? [];
    if (inspection.reviews?.some((review) => reviewMatchesPlan(review, preview.plan, originals))) {
      return [governanceAction(inspection, 'plan', preview.plan.selectionScope ?? inspection.scope)];
    }
    const planArgs = ['--plan', preview.fingerprint];
    if (preview.plan.approval.evaluation.approvalRequired) {
      return [governanceAction(inspection, 'approve', preview.plan.selectionScope ?? inspection.scope, planArgs, true)];
    }
    const subcommand = preview.plan.recovery ? 'recover' : 'apply-next';
    return [governanceAction(inspection, subcommand, preview.plan.selectionScope ?? inspection.scope,
      [...(inspection.stateSource === 'not-started' ? [] : planArgs), '--execute'])];
  }
  const interrupted = phaseIds.find((id) => phaseInScope(id, inspection.scope, true) && inspection.readiness.phases[id].recoveryRequired);
  if (interrupted) return [governanceAction(inspection, 'plan', inspection.scope, ['--recover-phase', interrupted])];
  return [governanceAction(inspection, 'plan', inspection.scope)];
}
