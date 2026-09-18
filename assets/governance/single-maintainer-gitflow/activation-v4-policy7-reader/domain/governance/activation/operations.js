                                                                                                                                                                           
import { canonicalSha256 } from './canonical-json.js';
import { canonicalPhaseGraph } from './graph.js';
import {                         phaseIds, phaseScope,                                                                                          } from './types.js';
import { validateGovernanceTaskProjectionContract } from './validators.js';

export const governanceTaskProjectionAction = 'governance.tasks.project'         ;

export function taskProjectionContract(operations                                )                                               {
  const projections = operations.filter((operation) => operation.actionId === governanceTaskProjectionAction);
  if (projections.length > 1) throw new Error('A phase can project only one exact current governance task document.');
  if (!projections.length) return undefined;
  const operation = projections[0];
  if (Object.keys(operation.inputs).join(',') !== 'projection') throw new Error('Task projection has no unbounded adapter inputs.');
  const contract = validateGovernanceTaskProjectionContract(operation.inputs.projection);
  if (operation.adapter !== 'local-evidence' || operation.mutationClass !== 'project-governance-tasks' ||
    operation.remote || operation.destructive || operation.effects?.length ||
    operation.destination.type !== 'local' || operation.destination.identity !== contract.taskPathParts.join('/') ||
    operation.destination.pathParts?.join('/') !== contract.taskPathParts.join('/') ||
    Object.keys(operation.destination).some((key) => !['type', 'identity', 'pathParts'].includes(key))) {
    throw new Error('Task projection must name only its exact local checkbox destination.');
  }
  return contract;
}

export function phaseById(graph                   , phaseId         )                 {
  const phase = graph.phases.find((entry) => entry.id === phaseId);
  if (!phase) throw new Error(`Unknown phase ${phaseId}.`);
  return phase;
}

export function phaseOrder(phaseId         )         {
  return phaseIds.indexOf(phaseId);
}

const providerMutationClasses                                                           = {
  github: new Set(['git-push', 'github-read', 'github-write', 'github-repository-create', 'github-workflow-dispatch', 'github-secret-write', 'github-ruleset-write']),
  azure: new Set(['azure-read', 'azure-provider-register', 'azure-network-provision', 'azure-state-import', 'azure-resource-provision', 'backend-state-read', 'backend-state-write', 'registry-publish'])
};

export function phaseUsesProvider(phase                , provider                      )          {
  return phase.allowedMutations.remote.some((mutation) => providerMutationClasses[provider].has(mutation));
}

export function operation(input                                                             )                      {
  return input;
}

export function transitionDestination(
  type                                        ,
  identity        ,
  extras                                                            = {}
)                                 {
  return { type, identity, ...extras };
}

export function rollbackPlanForPhase(phase                , completed                                 = [])                         {
  return rollbackPlanFromCompletedOperations(phase.id, phase.rollback.kind, phase.rollback.target, completed);
}

export function rollbackPlanFromCompletedOperations(
  phaseId         ,
  strategy                                    ,
  target                ,
  completed                                
)                         {
  const retained           = [];
  const cleanupWarnings           = [];
  const operations                      = [];
  for (const op of [...completed].reverse()) {
    if (op.mutationClass === 'azure-provider-register') {
      retained.push(`${op.phaseId}:${op.actionId}:provider-registration`);
      continue;
    }
    if (op.actionId.toLowerCase().includes('unregister')) {
      cleanupWarnings.push(`Refused to generate provider unregister rollback for ${op.actionId}.`);
      continue;
    }
    if (op.mutationClass === 'github-ruleset-write' || op.actionId === 'github.repository.settings.apply') {
      retained.push(`${op.phaseId}:${op.actionId}:repository-protection`);
      cleanupWarnings.push('Repository protection is retained; recovery requires fresh observation and separately approved exact control changes.');
      continue;
    }
    if (op.actionId === 'github.workflow-source.publish') {
      retained.push(`${op.phaseId}:${op.actionId}:published-history`);
      cleanupWarnings.push('Published workflow commits and pull requests are retained; recovery must use their exact recorded identities.');
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

                                  
                        
                           
                                             
                             
 

export function planDigestFor(input                 )         {
  return canonicalSha256({
    phaseId: input.phase.id,
    transitionDigest: input.transitionDigest,
    approvalPlanDigest: input.approvalPlanDigest,
    operations: input.operations
  });
}

const persistence = ['governance.evidence.write', 'governance.activation-state.write'];
const actions                                               = {
  'seed-valid': ['openspec.seed.validate', ...persistence],
  'seed-verified': ['openspec.seed.baseline-verify', 'seed.tasks.project', ...persistence],
  'seed-archived': ['openspec.seed.archive', ...persistence],
  committed: ['git.init', 'git.add-reviewed', 'git.commit-reviewed', 'git.verify-existing-commit', ...persistence],
  pushed: ['github.repository.ensure', 'git.remote.bind', 'git.push-approved-ref', 'git.verify-existing-push', 'github.repository.default-branch', ...persistence],
  'repository-discovered': ['github.repository.discover', ...persistence],
  'repository-workflow-source-ready': ['local.workflow-source.write', 'local.ruleset-source.write', 'git.commit-reviewed', 'git.push-approved-ref', 'github.workflow-source.publish', 'github.workflow-source.verify', ...persistence],
  'repository-checks-qualified': ['github.checks.repository-qualified', ...persistence],
  'repository-enforcement-approved': ['governance.activation-state.write'],
  'repository-rulesets-applied': ['github.repository.settings.apply', 'github.ruleset.apply', 'github.ruleset.readback', ...persistence],
  'repository-live-readback': ['github.ruleset.readback', ...persistence],
  'phase-0-complete': ['github.phase0.discover', 'azure.phase0.discover', ...persistence],
  'activation-approved': ['openspec.governance.create-change', 'spec-kit.governance.create-change', 'governance.activation-state.write'],
  'bootstrap-workflow-source-ready': ['local.workflow-source.write', 'git.commit-reviewed', 'git.push-approved-ref', 'github.bootstrap-local.configure', 'github.workflow-source.publish', 'github.workflow-source.verify', ...persistence],
  'credential-ready': ['github.credential.verify-policy', 'github.credential.enroll-masked', 'github.credential.usage-challenge', 'local.credential-policy.write', ...persistence],
  'provider-ready': ['azure.provider.ensure-ready', ...persistence],
  'state-path-selected': ['azure.state-path.select', ...persistence],
  'existing-private-path': ['azure.existing-private-path.verify', ...persistence],
  'bootstrap-local': ['azure.bootstrap-local.apply', 'github.bootstrap-local.configure', ...persistence],
  'runner-ready': ['github.runner.ensure-ready', 'github.runner.reachability-dispatch', ...persistence],
  'private-backend-proof': ['github.runner.backend-proof', 'azure.remote-state.read', 'azure.private-backend.lease.acquire', 'azure.private-backend.lease.renew', 'azure.private-backend.lease.release', ...persistence],
  'remote-import-verified': ['azure.remote-import.verify', ...persistence],
  'remote-ready': ['azure.remote-ready.verify', ...persistence],
  'application-prerequisites-ready': ['azure.prerequisites.apply', 'azure.prerequisites.verify', 'azure.application-private.prepare', 'azure.application-private.state', 'azure.application-private.recover', 'azure.application-private.initialize', ...persistence],
  'application-artifact-ready': ['github.artifact.build-dispatch', 'azure.artifact.readback', ...persistence],
  'application-foundation': ['azure.application-foundation.apply', 'azure.application-private.prepare', 'azure.application-private.state', 'azure.application-private.recover', 'azure.application-private.initialize', 'openspec.governance.update', ...persistence],
  'workflow-source-ready': ['local.workflow-source.write', 'local.ruleset-source.write', 'github.workflow-source.publish', 'github.workflow-source.verify', ...persistence],
  'dev-proof': ['github.checks.dev-proof', 'azure.dev.readback', 'azure.application-private.receipt', ...persistence],
  'staging-qualified': ['github.checks.staging', 'azure.staging.readback',
    'azure.application-private.prepare', 'azure.application-private.state', 'azure.application-private.recover',
    'azure.application-private.receipt', 'azure.application-staging.apply', 'azure.application-staging.target-read',
    'github.application-staging.dev-receipt', 'azure.artifact.promote', ...persistence],
  'production-rehearsed': ['github.checks.production-rehearsal', 'azure.production-readback',
    'azure.application-private.prepare', 'azure.application-private.state', 'azure.application-private.recover',
    'azure.application-rehearsal.rollout', 'azure.application-rehearsal.rollback',
    'github.application-rehearsal.source-receipt', 'azure.application-rehearsal.receipt', 'azure.artifact.promote', ...persistence],
  'green-red-proof': ['github.checks.green-red-proof', ...persistence],
  'enforcement-approved': ['governance.activation-state.write'],
  'rulesets-applied': ['github.repository.settings.apply', 'github.ruleset.apply', 'github.ruleset.readback', ...persistence],
  'live-readback': ['github.ruleset.readback', ...persistence],
  'bootstrap-state-disposed': ['local.bootstrap-state.dispose', ...persistence]
};

                                                                            
                                                             
                                                            
                                                                    
  

function operationContract(action        )                    {
  const explicit                                    = {
    'governance.evidence.write': { adapter: 'local-evidence', remote: false, mutations: ['write-evidence'] },
    'governance.activation-state.write': { adapter: 'local-evidence', remote: false, mutations: ['write-activation-state'] },
    [governanceTaskProjectionAction]: { adapter: 'local-evidence', remote: false, mutations: ['project-governance-tasks'] },
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
    'git.remote.bind': { adapter: 'git', remote: false, mutations: ['git-remote-bind'] },
    'github.repository.ensure': { adapter: 'github', remote: true, mutations: ['github-read', 'github-repository-create'] },
    'github.repository.default-branch': { adapter: 'github', remote: true, mutations: ['github-write'] },
    'git.push-approved-ref': { adapter: 'git', remote: true, mutations: ['git-push'] },
    'git.verify-existing-push': { adapter: 'git', remote: true, mutations: ['github-read'] },
    'github.phase0.discover': { adapter: 'github', remote: true, mutations: ['github-read'] },
    'github.repository.discover': { adapter: 'github', remote: true, mutations: ['github-read'] },
    'github.workflow-source.publish': { adapter: 'github', remote: true, mutations: ['github-write'], effects: ['github-read', 'git-push'], requiredEffects: ['github-read', 'git-push'] },
    'github.workflow-source.verify': { adapter: 'github', remote: true, mutations: ['github-read'] },
    'github.checks.repository-qualified': { adapter: 'github', remote: true, mutations: ['github-read', 'github-workflow-dispatch'], effects: ['github-read', 'github-write', 'git-push'] },
    'azure.phase0.discover': { adapter: 'azure-opentofu', remote: true, mutations: ['azure-read'] },
    'github.credential.verify-policy': { adapter: 'github', remote: true, mutations: ['github-read'] },
    'github.credential.enroll-masked': { adapter: 'github', remote: true, mutations: ['github-secret-write'] },
    'github.credential.usage-challenge': { adapter: 'github', remote: true, mutations: ['github-workflow-dispatch'], effects: ['github-read', 'github-write'] },
    'local.credential-policy.write': { adapter: 'local-state', remote: false, mutations: ['write-credential-policy'] },
    'azure.provider.ensure-ready': { adapter: 'azure-opentofu', remote: true, mutations: ['azure-provider-register', 'azure-read'], effects: ['azure-read'] },
    'azure.state-path.select': { adapter: 'azure-opentofu', remote: true, mutations: ['azure-read'] },
    'azure.existing-private-path.verify': { adapter: 'azure-opentofu', remote: true, mutations: ['azure-read'], effects: ['backend-state-read'] },
    'azure.bootstrap-local.apply': { adapter: 'azure-opentofu', remote: true, mutations: ['azure-network-provision'], effects: ['write-local-state', 'azure-read'] },
    'github.bootstrap-local.configure': { adapter: 'github', remote: true, mutations: ['github-write'] },
    'github.runner.ensure-ready': { adapter: 'github', remote: true, mutations: ['github-write', 'github-read'], effects: ['github-read', 'github-workflow-dispatch'] },
    'github.runner.reachability-dispatch': { adapter: 'github', remote: true, mutations: ['github-workflow-dispatch'], effects: ['github-read'] },
    'github.runner.backend-proof': { adapter: 'github', remote: true, mutations: ['github-workflow-dispatch', 'github-read'], effects: ['backend-state-read', 'backend-state-write', 'azure-read'] },
    'azure.private-backend.lease.acquire': { adapter: 'azure-opentofu', remote: true, mutations: ['backend-state-write'] },
    'azure.private-backend.lease.renew': { adapter: 'azure-opentofu', remote: true, mutations: ['backend-state-write'] },
    'azure.private-backend.lease.release': { adapter: 'azure-opentofu', remote: true, mutations: ['backend-state-write'] },
    'azure.remote-state.read': { adapter: 'azure-opentofu', remote: true, mutations: ['azure-read', 'backend-state-read'] },
    'azure.remote-import.verify': { adapter: 'azure-opentofu', remote: true, mutations: ['azure-state-import'], effects: ['backend-state-read', 'backend-state-write', 'azure-read'] },
    'azure.remote-ready.verify': { adapter: 'azure-opentofu', remote: true, mutations: ['azure-read'], effects: ['backend-state-read'] },
    'azure.prerequisites.apply': { adapter: 'azure-opentofu', remote: true, mutations: ['azure-resource-provision'], effects: ['backend-state-read', 'backend-state-write', 'azure-read'] },
    'azure.prerequisites.verify': { adapter: 'azure-opentofu', remote: true, mutations: ['azure-read'] },
    'azure.application-private.prepare': { adapter: 'azure-opentofu', remote: true, mutations: ['backend-state-write'], effects: ['write-local-state', 'backend-state-read', 'azure-read'] },
    'azure.application-private.initialize': { adapter: 'azure-opentofu', remote: true, mutations: ['backend-state-write', 'backend-state-read'], effects: ['write-local-state', 'backend-state-read', 'azure-read'] },
    'azure.application-private.state': { adapter: 'azure-opentofu', remote: true, mutations: ['backend-state-write'], effects: ['write-local-state', 'backend-state-read', 'azure-read'] },
    'azure.application-private.recover': { adapter: 'azure-opentofu', remote: true, mutations: ['backend-state-write'], effects: ['write-local-state', 'backend-state-read', 'azure-read'] },
    'azure.application-private.receipt': { adapter: 'azure-opentofu', remote: true, mutations: ['backend-state-read'], effects: ['read-worktree', 'azure-read'] },
    'github.application-rehearsal.source-receipt': { adapter: 'github', remote: true, mutations: ['github-read'] },
    'azure.application-rehearsal.receipt': { adapter: 'azure-opentofu', remote: true, mutations: ['backend-state-read'], effects: ['azure-read', 'read-worktree', 'write-local-state'] },
    'azure.application-rehearsal.rollout': { adapter: 'azure-opentofu', remote: true, mutations: ['azure-resource-provision'], effects: ['azure-read'] },
    'azure.application-rehearsal.rollback': { adapter: 'azure-opentofu', remote: true, mutations: ['azure-resource-provision'], effects: ['azure-read'] },
    'github.artifact.build-dispatch': { adapter: 'github', remote: true, mutations: ['github-workflow-dispatch'], effects: ['github-read', 'registry-publish'] },
    'azure.artifact.readback': { adapter: 'azure-opentofu', remote: true, mutations: ['azure-read'] },
    'azure.artifact.promote': { adapter: 'azure-opentofu', remote: true, mutations: ['registry-publish'], effects: ['azure-read'] },
    'azure.application-staging.apply': { adapter: 'azure-opentofu', remote: true, mutations: ['azure-resource-provision'], effects: ['azure-read'] },
    'azure.application-staging.target-read': { adapter: 'azure-opentofu', remote: true, mutations: ['azure-read'] },
    'github.application-staging.dev-receipt': { adapter: 'github', remote: true, mutations: ['github-read'] },
    'azure.application-foundation.apply': { adapter: 'azure-opentofu', remote: true, mutations: ['azure-resource-provision'], effects: ['backend-state-read', 'backend-state-write', 'azure-read'] },
    'github.checks.dev-proof': { adapter: 'github', remote: true, mutations: ['github-workflow-dispatch'], effects: ['github-read'] },
    'azure.dev.readback': { adapter: 'azure-opentofu', remote: true, mutations: ['azure-read'] },
    'github.checks.staging': { adapter: 'github', remote: true, mutations: ['github-workflow-dispatch'], effects: ['github-read', 'azure-resource-provision', 'backend-state-read', 'backend-state-write'] },
    'azure.staging.readback': { adapter: 'azure-opentofu', remote: true, mutations: ['azure-read'], effects: ['azure-read'] },
    'github.checks.production-rehearsal': { adapter: 'github', remote: true, mutations: ['github-workflow-dispatch'], effects: ['github-read', 'azure-resource-provision', 'backend-state-read', 'backend-state-write'] },
    'azure.production-readback': { adapter: 'azure-opentofu', remote: true, mutations: ['azure-read'] },
    'github.checks.green-red-proof': { adapter: 'github', remote: true, mutations: ['github-workflow-dispatch'], effects: ['github-read', 'git-push', 'github-write'] },
    'github.repository.settings.apply': { adapter: 'github', remote: true, mutations: ['github-write'] },
    'github.ruleset.apply': { adapter: 'github', remote: true, mutations: ['github-ruleset-write'] },
    'github.ruleset.readback': { adapter: 'github', remote: true, mutations: ['github-read'] },
    'local.workflow-source.write': { adapter: 'local-state', remote: false, mutations: ['write-workflows'] },
    'local.ruleset-source.write': { adapter: 'local-state', remote: false, mutations: ['write-ruleset-source'] },
    'local.bootstrap-state.dispose': { adapter: 'local-state', remote: false, mutations: ['delete-local-state'] }
  };
  if (explicit[action]) return explicit[action];
  throw new Error(`Operation ${action} has no declared execution contract.`);
}

function assertConcreteDestination(destination                                , remote         , actionId        )       {
  if (destination.type === 'subscription' &&
    (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(destination.subscriptionId ?? '') ||
      destination.subscriptionId === '00000000-0000-0000-0000-000000000000')) {
    throw new Error(`Operation ${actionId} has no verified subscription destination; placeholders cannot authorize a transition.`);
  }
  if (remote && destination.type === 'repository' &&
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(destination.repository ?? '')) {
    throw new Error(`Operation ${actionId} requires a verified owner/repository destination.`);
  }
}

export function assertOperationAllowed(phase                , operation                     )       {
  if (operation.phaseId !== phase.id ||
    !actions[phase.id].includes(operation.actionId) && operation.actionId !== governanceTaskProjectionAction) {
    throw new Error(`Operation ${operation.actionId} is not allowlisted for phase ${phase.id}.`);
  }
  const contract = operationContract(operation.actionId);
  const allowed = operation.remote ? phase.allowedMutations.remote : phase.allowedMutations.local;
  if (operation.adapter !== contract.adapter || operation.remote !== contract.remote ||
    !contract.mutations.includes(operation.mutationClass) ||
    (!allowed.includes(operation.mutationClass) && operation.actionId !== governanceTaskProjectionAction)) {
    throw new Error(`Operation ${operation.actionId} adapter, authority, or mutation class is not declared by phase ${phase.id}.`);
  }
  if (operation.destructive !== (operation.actionId === 'local.bootstrap-state.dispose')) {
    throw new Error(`Operation ${operation.actionId} has an invalid destructive scope.`);
  }
  assertConcreteDestination(operation.destination, operation.remote, operation.actionId);
  if (operation.actionId === governanceTaskProjectionAction) taskProjectionContract([operation]);
  for (const mutationClass of contract.requiredEffects ?? []) {
    if (!operation.effects?.some((effect) => effect.mutationClass === mutationClass &&
      effect.remote === operation.remote && canonicalSha256(effect.destination) === canonicalSha256(operation.destination))) {
      throw new Error(`Operation ${operation.actionId} must declare its ${mutationClass} effect at the exact approved destination.`);
    }
  }
  for (const effect of operation.effects ?? []) {
    const effectAllowed = effect.remote ? phase.allowedMutations.remote : phase.allowedMutations.local;
    if (!contract.effects?.includes(effect.mutationClass) || !effectAllowed.includes(effect.mutationClass) || effect.destructive) {
      throw new Error(`Delegated effect ${effect.mutationClass} is not authorized for ${operation.actionId} in ${phase.id}.`);
    }
    assertConcreteDestination(effect.destination, effect.remote, operation.actionId);
  }
}

export function assertPlanOperationsAllowed(plan                     , phase                )       {
  if (plan.phaseId !== phase.id || plan.scope !== phaseScope(phase.id) ||
    canonicalSha256(plan.mutationClasses) !== canonicalSha256(phase.allowedMutations) ||
    plan.approval.gateKind !== phase.approvalGate.kind || plan.approval.required !== phase.approvalGate.required ||
    plan.approval.evaluation.phaseId !== phase.id || plan.approval.evaluation.gateKind !== phase.approvalGate.kind ||
    plan.approval.envelopeId !== plan.approval.evaluation.envelopeId ||
    plan.approval.envelopeHash !== plan.approval.evaluation.envelopeHash ||
    Date.parse(plan.createdAt) >= Date.parse(plan.expiresAt)) {
    throw new Error(`Plan metadata, approval gate, or validity interval does not match phase ${phase.id}.`);
  }
  for (const operation of plan.operations) assertOperationAllowed(phase, operation);
  const projection = taskProjectionContract(plan.operations);
  if (projection) {
    if (plan.fileChanges?.some((change) => change.pathParts.join('/') === projection.taskPathParts.join('/'))) {
      throw new Error('Derived checkbox projection cannot also authorize a generic task-file replacement.');
    }
    const metadata = plan.fileChanges?.find((change) => change.pathParts.join('/') === projection.metadataPathParts.join('/'));
    if (projection.source === 'create'
      ? !metadata || metadata.beforeHash !== null || metadata.afterHash !== projection.metadataHash
      : metadata !== undefined) {
      throw new Error('Task projection metadata must be the exact new source or an unchanged existing source.');
    }
  }
  for (const bundled of plan.approvalBundle ?? []) {
    const node = phaseById(canonicalPhaseGraph, bundled.phaseId);
    if (phaseScope(node.id) !== plan.scope || node.approvalGate.kind !== phase.approvalGate.kind) {
      throw new Error('Bundled operations cannot expand the approval scope or authority gate.');
    }
    for (const operation of bundled.operations) assertOperationAllowed(node, operation);
  }
}
