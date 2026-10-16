import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import type { ModernPlanInput } from '../domain/governance/activation/modern-records.js';
import type { InstalledLocalPreflight } from '../domain/governance/activation/modern-local-runtime.js';
import { installedLocalBinding } from '../domain/governance/activation/modern-local-runtime.js';
import { captureWorkflowBinding, workflowFailure } from './workflow-binding.js';
import { validatePublicActivationInputs } from '../domain/governance/activation/validators.js';
import {
  assertSource5WorkflowContext, source5PreviewFingerprint, source5WorkflowPhases
} from './workflow-source5-context.js';
import type { Source5WorkflowContext, Source5WorkflowPhase } from './workflow-source5-context.js';
import {
  source5WorkflowCheckpointOperation, source5WorkflowControlKey, source5WorkflowOperation,
  source5WorkflowPlanInventory, source5WorkflowProjectOperations, source5WorkflowActions
} from './workflow-source5-operations.js';
import type {
  Source5WorkflowAction, Source5WorkflowControlBinding, Source5WorkflowOrigin
} from './workflow-source5-operations.js';
import { validateSource5WorkflowPlanComponents } from './workflow-source5-components.js';

export interface Source5WorkflowReviewRequest {
  readonly phaseId: Source5WorkflowPhase;
  readonly executionId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly configuration: NonNullable<ModernPlanInput['configuration']>;
  readonly origin: Source5WorkflowOrigin | null;
  readonly remainingFrom: Source5WorkflowControlBinding['remainingFrom'];
  readonly effects: readonly { readonly action: Source5WorkflowAction; readonly binding: unknown }[];
}

function reviewRecord(value: unknown, keys: readonly string[]) {
  if (!isRecord(value) || canonicalSha256(Object.keys(value).sort()) !== canonicalSha256([...keys].sort())) {
    return workflowFailure('workflow-source5-review-request', 'Workflow review inputs require the exact closed public request fields.');
  }
  return value;
}
function reviewText(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024) {
    return workflowFailure('workflow-source5-review-request', 'Workflow review inputs contain a missing or unbounded string.');
  }
  return value;
}
export function parseSource5WorkflowReviewRequest(value: unknown): Source5WorkflowReviewRequest {
  const raw = reviewRecord(captureWorkflowBinding(value), [
    'schemaVersion', 'kind', 'phaseId', 'executionId', 'createdAt', 'expiresAt',
    'configuration', 'origin', 'remainingFrom', 'effects'
  ]);
  const phaseId = source5WorkflowPhases.find(phase => phase === raw.phaseId);
  if (raw.schemaVersion !== 1 || raw.kind !== 'review-workflow-source5' || !phaseId ||
    !Array.isArray(raw.effects) || !raw.effects.length) {
    return workflowFailure('workflow-source5-review-request', 'Select a schema-1 review-workflow-source5 request and its complete explicit workflow phase/effect inventory.');
  }
  const origin = raw.origin === null ? null : reviewRecord(raw.origin, [
    'planKey', 'proofKey', 'publicationDigest', 'commitSha', 'treeSha'
  ]);
  const remaining = raw.remainingFrom === null ? null : reviewRecord(raw.remainingFrom, ['planKey', 'operationDigests']);
  const remainingFrom = (() => {
    if (!remaining) return null;
    if (!Array.isArray(remaining.operationDigests)) {
      return workflowFailure('workflow-source5-review-request', 'A remaining-only review must retain the complete original operation digest array.');
    }
    return { planKey: reviewText(remaining.planKey), operationDigests: remaining.operationDigests.map(reviewText) };
  })();
  return captureWorkflowBinding({
    phaseId, executionId: reviewText(raw.executionId), createdAt: reviewText(raw.createdAt), expiresAt: reviewText(raw.expiresAt),
    configuration: validatePublicActivationInputs(raw.configuration),
    origin: origin ? {
      planKey: reviewText(origin.planKey), proofKey: reviewText(origin.proofKey),
      publicationDigest: reviewText(origin.publicationDigest), commitSha: reviewText(origin.commitSha), treeSha: reviewText(origin.treeSha)
    } : null,
    remainingFrom,
    effects: raw.effects.map(value => {
      const effect = reviewRecord(value, ['action', 'binding']);
      const action = source5WorkflowActions[phaseId].find(action => action === effect.action);
      if (!action) return workflowFailure('workflow-source5-review-request', 'The action is not a registered producer for this exact workflow phase.');
      return { action, binding: effect.binding };
    })
  });
}

/** Constructs review values only; stored progress and this preview confer no execution authority. */
export function planSource5WorkflowReview(input: {
  readonly context: Source5WorkflowContext;
  readonly installed: Extract<InstalledLocalPreflight, { status: 'observed' }>;
  readonly projectKey: string;
  readonly request: Source5WorkflowReviewRequest;
}) {
  assertSource5WorkflowContext(input.context);
  const context = input.context;
  const { installed, projectKey, request } = captureWorkflowBinding({
    installed: input.installed, projectKey: input.projectKey, request: input.request
  });
  const requestKeys = [
    'phaseId', 'executionId', 'createdAt', 'expiresAt', 'configuration', 'origin', 'remainingFrom', 'effects'
  ];
  if (!isRecord(request) ||
    canonicalSha256(Object.keys(request).sort()) !== canonicalSha256(requestKeys.sort()) ||
    !Array.isArray(request.effects) || request.effects.some(effect => !isRecord(effect) ||
      canonicalSha256(Object.keys(effect).sort()) !== canonicalSha256(['action', 'binding'])) ||
    !installed.current || installed.classification !== 'current' ||
    installed.binding !== installedLocalBinding(installed.snapshot) ||
    canonicalSha256(installed.current.state.identity) !== canonicalSha256(context.records.identity)) {
    return workflowFailure('workflow-source5-review-inputs',
      'A workflow review needs the complete exact current installed snapshot and identity, not fresh, historical or caller-expanded inputs.');
  }
  const state = context.records.readState(installed.current.state, installed.current.records);
  const phase = context.records.graph.phases.find(phase => phase.id === request.phaseId);
  if (!phase || !request.effects.length) {
    return workflowFailure('workflow-source5-review-phase', 'An explicit current workflow phase and complete nonempty effect inventory are required.');
  }
  const key = { projectKey, executionId: request.executionId, repositoryAnchor: state.repository.id, phaseId: request.phaseId };
  const control: Source5WorkflowControlBinding = {
    ...key, schemaVersion: 1, kind: 'workflow-source5-control.v1', controlKey: source5WorkflowControlKey(key),
    reviewKind: request.remainingFrom ? 'remaining-only' : request.origin ? 'bound-source' : 'publication',
    origin: request.origin, remainingFrom: request.remainingFrom
  };
  const checkpoint = source5WorkflowCheckpointOperation(control);
  const operations = [
    ...request.effects.map(effect => source5WorkflowOperation(request.phaseId, effect.action, effect.binding)),
    checkpoint, ...source5WorkflowProjectOperations(control)
  ];
  const plan = context.records.createPlan({
    phaseId: request.phaseId, createdAt: request.createdAt, expiresAt: request.expiresAt,
    stateHash: canonicalSha256(state), baselineDigest: installed.binding,
    inputDigest: canonicalSha256({ installedBinding: installed.binding, request }),
    transitionDigest: canonicalSha256({ control, request }), operations, noSecrets: true,
    configuration: request.configuration,
    approval: {
      gateKind: phase.approvalGate.kind, required: true, envelopeId: null, envelopeHash: null,
      evaluation: {
        phaseId: request.phaseId, gateKind: phase.approvalGate.kind, questionKind: null,
        approvalRequired: true, status: 'approval-required', envelopeId: null, envelopeHash: null,
        reasons: [], expansionReasons: []
      }
    },
    rollbackPlan: {
      phaseId: request.phaseId, strategy: phase.rollback.kind, target: phase.rollback.target,
      operations: [], retained: [], cleanupWarnings: []
    }
  });
  source5WorkflowPlanInventory(plan);
  validateSource5WorkflowPlanComponents(plan);
  return captureWorkflowBinding({
    kind: 'workflow-source5-review' as const, projectRoot: installed.snapshot.root,
    control, plan, fingerprint: source5PreviewFingerprint(installed.snapshot.root, plan),
    prerequisites: {
      status: 'not-observed' as const, dependencies: phase.dependencies,
      recordedProgressIsCurrentProof: false as const
    },
    execution: 'not-authorized' as const
  });
}
