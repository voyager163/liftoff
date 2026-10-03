import { localInputFailure } from '../../domain/governance/activation/modern-local-inputs.js';
import { completionDigest, specKitCompletionPolicy, type CompletedLocalExecutionBinding, type SpecKitWorkflowOutcome } from '../../domain/governance/activation/modern-local-completion.js';
import type { ModernActivationState, ModernPhaseId, ModernSavedTransitionPlan } from '../../domain/governance/activation/modern-record-contracts.js';
import type { ModernActivationRecordContract } from '../../domain/governance/activation/modern-records.js';

export interface LocalEvidenceReview {
  kind: 'finalization' | 'revalidation';
  fingerprint: string;
  projectRoot: string;
  expiresAt: string;
  execution: CompletedLocalExecutionBinding;
}

export function createLocalEvidencePlan(
  api: ModernActivationRecordContract, review: LocalEvidenceReview, state: ModernActivationState,
  id: ModernPhaseId, createdAt: string, workflow?: SpecKitWorkflowOutcome
): ModernSavedTransitionPlan {
  const node = api.graph.phases.find(phase => phase.id === id);
  if (!node || !id.startsWith('local-')) localInputFailure('Only a registered local phase can receive local evidence.');
  for (const dep of node.dependencies) {
    if (!dep.anyOf.some(phase => dep.accepts.includes(state.phases[phase].state as typeof dep.accepts[number]))) {
      localInputFailure('Native local phase dependency is not actually satisfied.');
    }
  }
  if (review.kind !== 'finalization' && review.kind !== 'revalidation') localInputFailure('Unknown local evidence review.');
  if (review.kind === 'revalidation' && workflow) localInputFailure('Successor revalidation cannot authorize a workflow transformation.');
  if (workflow && (id !== 'local-complete' || api.identity.workflow !== 'spec-kit')) {
    localInputFailure('Only Spec Kit local completion can carry its workflow transformation.');
  }
  const commitment = review.kind === 'finalization'
    ? { finalizationFingerprint: review.fingerprint } : { revalidationFingerprint: review.fingerprint };
  return api.createPlan({
    phaseId: id, createdAt, expiresAt: review.expiresAt, stateHash: completionDigest(state),
    baselineDigest: review.execution.baselineDigest, inputDigest: review.execution.observationDigest,
    transitionDigest: completionDigest({ ...commitment, phaseId: id, execution: review.execution }),
    operations: [{
      adapter: 'local-evidence', actionId: `governance.local.${id}`, mutationClass: 'write-evidence', phaseId: id,
      inputs: { ...commitment, executionResultDigest: review.execution.resultDigest },
      destination: { type: 'local', identity: review.projectRoot }, remote: false, destructive: false
    }, ...(workflow?.disposition === 'changed' ? [{
      adapter: 'selected-spec-workflow' as const, actionId: 'governance.local.finalize-spec-kit-tasks',
      mutationClass: 'write-spec-kit-seed' as const, phaseId: id, inputs: { workflow },
      destination: { type: 'local' as const, identity: specKitCompletionPolicy.taskPath.join('/'), pathParts: [...specKitCompletionPolicy.taskPath] },
      remote: false, destructive: false
    }] : [])],
    approval: { gateKind: node.approvalGate.kind, required: false, envelopeId: null, envelopeHash: null,
      evaluation: { phaseId: id, gateKind: node.approvalGate.kind, questionKind: null, approvalRequired: false,
        status: 'not-required', envelopeId: null, envelopeHash: null, reasons: [], expansionReasons: [] } },
    rollbackPlan: { phaseId: id, strategy: node.rollback.kind, target: node.rollback.target, operations: [], retained: [], cleanupWarnings: [] },
    noSecrets: true,
    ...(workflow ? { inputDigest: workflow.inputDigest,
      fileChanges: [{ pathParts: [...specKitCompletionPolicy.taskPath], beforeHash: workflow.originalTaskHash, afterHash: workflow.targetTaskHash }] } : {})
  });
}
