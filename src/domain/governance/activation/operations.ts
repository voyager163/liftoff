import type { PhaseGraphNode, PhaseId, SavedTransitionPlan, TransitionOperation } from './types.js';
import { canonicalSha256 } from './canonical-json.js';
import { type ManagedPhaseGraph, phaseIds, type TransitionOperationDestination, type TransitionRollbackPlan, type RollbackOperation } from './types.js';

export function phaseById(graph: ManagedPhaseGraph, phaseId: PhaseId): PhaseGraphNode {
  const phase = graph.phases.find((entry) => entry.id === phaseId);
  if (!phase) throw new Error(`Unknown phase ${phaseId}.`);
  return phase;
}

export function phaseOrder(phaseId: PhaseId): number {
  return phaseIds.indexOf(phaseId);
}

export function operation(input: Omit<TransitionOperation, 'phaseId'> & { phaseId: PhaseId }): TransitionOperation {
  return input;
}

export function transitionDestination(
  type: TransitionOperationDestination['type'],
  identity: string,
  extras: Omit<TransitionOperationDestination, 'type' | 'identity'> = {}
): TransitionOperationDestination {
  return { type, identity, ...extras };
}

export function rollbackPlanForPhase(phase: PhaseGraphNode, completed: readonly TransitionOperation[] = []): TransitionRollbackPlan {
  return rollbackPlanFromCompletedOperations(phase.id, phase.rollback.kind, phase.rollback.target, completed);
}

export function rollbackPlanFromCompletedOperations(
  phaseId: PhaseId,
  strategy: TransitionRollbackPlan['strategy'],
  target: PhaseId | null,
  completed: readonly TransitionOperation[]
): TransitionRollbackPlan {
  const retained: string[] = [];
  const cleanupWarnings: string[] = [];
  const operations: RollbackOperation[] = [];
  for (const op of [...completed].reverse()) {
    if (op.mutationClass === 'azure-provider-register') {
      retained.push(`${op.phaseId}:${op.actionId}:provider-registration`);
      continue;
    }
    if (op.actionId.toLowerCase().includes('unregister')) {
      cleanupWarnings.push(`Refused to generate provider unregister rollback for ${op.actionId}.`);
      continue;
    }
    if (op.mutationClass === 'github-ruleset-write') {
      operations.push({
        adapter: 'github',
        actionId: 'github.ruleset.disable',
        mutationClass: 'github-ruleset-write',
        phaseId,
        inputs: { fromOperation: op.actionId, cannotExpandScope: true },
        destination: op.destination,
        remote: true,
        destructive: false
      });
      continue;
    }
    if (op.mutationClass === 'azure-network-provision' || op.mutationClass === 'azure-resource-provision') {
      operations.push({
        adapter: 'azure-opentofu',
        actionId: 'azure.resource.cleanup',
        mutationClass: op.mutationClass,
        phaseId,
        inputs: { fromOperation: op.actionId, noProviderUnregister: true },
        destination: op.destination,
        remote: true,
        destructive: true
      });
      continue;
    }
    if (op.mutationClass === 'write-local-state' || op.mutationClass === 'delete-local-state') {
      operations.push({
        adapter: 'local-state',
        actionId: 'local.state.rollback',
        mutationClass: op.mutationClass,
        phaseId,
        inputs: { fromOperation: op.actionId },
        destination: op.destination,
        remote: false,
        destructive: op.mutationClass === 'delete-local-state'
      });
    }
  }
  return { phaseId, strategy, target, operations, retained, cleanupWarnings };
}

export interface PlanDigestInput {
  phase: PhaseGraphNode;
  transitionDigest: string;
  operations: readonly TransitionOperation[];
  approvalPlanDigest: string;
}

export function planDigestFor(input: PlanDigestInput): string {
  return canonicalSha256({
    phaseId: input.phase.id,
    transitionDigest: input.transitionDigest,
    approvalPlanDigest: input.approvalPlanDigest,
    operations: input.operations
  });
}

const persistence = ['governance.evidence.write', 'governance.activation-state.write'];
const actions: Readonly<Record<PhaseId, readonly string[]>> = {
  'seed-valid': ['openspec.seed.validate', ...persistence],
  'seed-verified': ['openspec.seed.baseline-verify', 'seed.tasks.project', ...persistence],
  'seed-archived': ['openspec.seed.archive', ...persistence],
  committed: ['git.init', 'git.add-reviewed', 'git.commit-reviewed', 'git.verify-existing-commit', ...persistence],
  pushed: ['git.push-approved-ref', 'git.verify-existing-push', ...persistence],
  'phase-0-complete': ['github.phase0.discover', 'azure.phase0.discover', ...persistence],
  'activation-approved': ['openspec.governance.create-change', 'spec-kit.governance.create-change', 'governance.activation-state.write'],
  'credential-ready': ['github.credential.verify-policy', 'github.credential.enroll-masked', ...persistence],
  'provider-ready': ['azure.provider.ensure-ready', ...persistence],
  'state-path-selected': ['azure.state-path.select', ...persistence],
  'existing-private-path': ['azure.existing-private-path.verify', ...persistence],
  'bootstrap-local': ['azure.bootstrap-local.apply', 'github.bootstrap-local.configure', ...persistence],
  'runner-ready': ['github.runner.ensure-ready', ...persistence],
  'private-backend-proof': ['github.runner.backend-proof', 'azure.remote-state.read', ...persistence],
  'remote-import-verified': ['azure.remote-import.verify', ...persistence],
  'remote-ready': ['azure.remote-ready.verify', ...persistence],
  'application-foundation': ['azure.application-foundation.apply', 'openspec.governance.update', ...persistence],
  'workflow-source-ready': ['local.workflow-source.write', 'local.ruleset-source.write', ...persistence],
  'dev-proof': ['github.checks.dev-proof', ...persistence],
  'staging-qualified': ['github.checks.staging', 'azure.staging.readback', ...persistence],
  'production-rehearsed': ['github.checks.production-rehearsal', 'azure.production-readback', ...persistence],
  'green-red-proof': ['github.checks.green-red-proof', ...persistence],
  'enforcement-approved': ['governance.activation-state.write'],
  'rulesets-applied': ['github.ruleset.apply', 'github.ruleset.readback', ...persistence],
  'live-readback': ['github.ruleset.readback', ...persistence],
  'bootstrap-state-disposed': ['local.bootstrap-state.dispose', ...persistence]
};

type OperationContract = Pick<TransitionOperation, 'adapter' | 'remote'> & { mutations: readonly TransitionOperation['mutationClass'][] };

function operationContract(action: string): OperationContract {
  const explicit: Record<string, OperationContract> = {
    'governance.evidence.write': { adapter: 'local-evidence', remote: false, mutations: ['write-evidence'] },
    'governance.activation-state.write': { adapter: 'local-evidence', remote: false, mutations: ['write-activation-state'] },
    'openspec.seed.validate': { adapter: 'selected-spec-workflow', remote: false, mutations: ['read-worktree'] },
    'openspec.seed.baseline-verify': { adapter: 'selected-spec-workflow', remote: false, mutations: ['read-worktree'] },
    'openspec.seed.archive': { adapter: 'selected-spec-workflow', remote: false, mutations: ['write-openspec-seed', 'read-worktree'] },
    'seed.tasks.project': { adapter: 'selected-spec-workflow', remote: false, mutations: ['write-seed-tasks'] },
    'openspec.governance.create-change': { adapter: 'selected-spec-workflow', remote: false, mutations: ['write-openspec-governance'] },
    'spec-kit.governance.create-change': { adapter: 'selected-spec-workflow', remote: false, mutations: ['write-openspec-governance'] },
    'openspec.governance.update': { adapter: 'selected-spec-workflow', remote: false, mutations: ['write-openspec-governance'] },
    'git.init': { adapter: 'git', remote: false, mutations: ['git-commit'] },
    'git.add-reviewed': { adapter: 'git', remote: false, mutations: ['git-commit'] },
    'git.commit-reviewed': { adapter: 'git', remote: false, mutations: ['git-commit'] },
    'git.verify-existing-commit': { adapter: 'git', remote: false, mutations: ['read-worktree'] },
    'git.push-approved-ref': { adapter: 'git', remote: true, mutations: ['git-push'] },
    'git.verify-existing-push': { adapter: 'git', remote: true, mutations: ['github-read'] },
    'local.workflow-source.write': { adapter: 'local-state', remote: false, mutations: ['write-workflows'] },
    'local.ruleset-source.write': { adapter: 'local-state', remote: false, mutations: ['write-ruleset-source'] },
    'local.bootstrap-state.dispose': { adapter: 'local-state', remote: false, mutations: ['delete-local-state'] }
  };
  if (explicit[action]) return explicit[action];
  if (action.startsWith('github.')) {
    const mutation = action === 'github.credential.enroll-masked' ? 'github-secret-write' :
      action === 'github.ruleset.apply' ? 'github-ruleset-write' :
        ['github.bootstrap-local.configure', 'github.runner.ensure-ready'].includes(action) ? 'github-write' : 'github-read';
    return { adapter: 'github', remote: true, mutations: [mutation] };
  }
  const mutation = action === 'azure.provider.ensure-ready' ? 'azure-provider-register' :
    action === 'azure.bootstrap-local.apply' ? 'azure-network-provision' :
      action === 'azure.remote-import.verify' ? 'azure-state-import' :
        action === 'azure.application-foundation.apply' ? 'azure-resource-provision' : 'azure-read';
  return { adapter: 'azure-opentofu', remote: true, mutations: [mutation] };
}

export function assertOperationAllowed(phase: PhaseGraphNode, operation: TransitionOperation): void {
  if (operation.phaseId !== phase.id || !actions[phase.id].includes(operation.actionId)) {
    throw new Error(`Operation ${operation.actionId} is not allowlisted for phase ${phase.id}.`);
  }
  const contract = operationContract(operation.actionId);
  const allowed = operation.remote ? phase.allowedMutations.remote : phase.allowedMutations.local;
  if (operation.adapter !== contract.adapter || operation.remote !== contract.remote ||
    !contract.mutations.includes(operation.mutationClass) || !allowed.includes(operation.mutationClass)) {
    throw new Error(`Operation ${operation.actionId} adapter, authority, or mutation class is not declared by phase ${phase.id}.`);
  }
  if (operation.destructive !== (operation.actionId === 'local.bootstrap-state.dispose')) {
    throw new Error(`Operation ${operation.actionId} has an invalid destructive scope.`);
  }
  if (operation.destination.type === 'subscription' &&
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(operation.destination.subscriptionId ?? '')) {
    throw new Error(`Operation ${operation.actionId} has no verified subscription destination; placeholders cannot authorize a transition.`);
  }
  if (operation.remote && operation.destination.type === 'repository' &&
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(operation.destination.repository ?? '')) {
    throw new Error(`Operation ${operation.actionId} requires a verified owner/repository destination.`);
  }
}

export function assertPlanOperationsAllowed(plan: SavedTransitionPlan, phase: PhaseGraphNode): void {
  if (plan.phaseId !== phase.id || canonicalSha256(plan.mutationClasses) !== canonicalSha256(phase.allowedMutations) ||
    plan.approval.gateKind !== phase.approvalGate.kind || plan.approval.required !== phase.approvalGate.required ||
    plan.approval.evaluation.phaseId !== phase.id || plan.approval.evaluation.gateKind !== phase.approvalGate.kind ||
    plan.approval.envelopeId !== plan.approval.evaluation.envelopeId ||
    plan.approval.envelopeHash !== plan.approval.evaluation.envelopeHash ||
    Date.parse(plan.createdAt) >= Date.parse(plan.expiresAt)) {
    throw new Error(`Plan metadata, approval gate, or validity interval does not match phase ${phase.id}.`);
  }
  for (const operation of plan.operations) assertOperationAllowed(phase, operation);
}
