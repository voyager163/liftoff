import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { captureWorkflowBinding, workflowFailure } from './workflow-binding.js';
import {
  createSource5WorkflowEffectInput, recordSource5WorkflowStage
} from './workflow-source5-ports.js';
import type { Source5WorkflowEffectFields } from './workflow-source5-ports.js';
import { assertSource5WorkflowJournal } from './workflow-source5-journal.js';
import type { Source5WorkflowJournal } from './workflow-source5-journal.js';
import {
  executeWorkflowSourcePublication, observeWorkflowSourcePublication, validateWorkflowPublication
} from './workflow-publication.js';
import type { WorkflowPublicationBinding, PublishedWorkflowSource } from './workflow-publication.js';
import { bindImmutableWorkflowExecutionRef, workflowExecutionRefName } from './workflow-execution-ref.js';
import type { WorkflowExecutionRefBinding, ImmutableWorkflowExecutionRef } from './workflow-execution-ref.js';
import { admitReviewedRunnerWorkflows, validateWorkflowRunnerAdmission } from './workflow-runner-admission.js';
import type { WorkflowRunnerAdmissionBinding } from './workflow-runner-admission.js';
import {
  executeWorkflowContextProof, readCurrentWorkflowContextProof, validateWorkflowContextBinding,
  verifySource5WorkflowProofMatrix
} from './workflow-context-proof.js';
import type { WorkflowContextBinding, WorkflowContextProof, WorkflowProofCheckpoint } from './workflow-context-proof.js';
import { protectedWorkflowFamilies } from './workflow-requirements.js';
import type { WorkflowRequirementSource } from './workflow-requirements.js';
import { source5WorkflowPlanInventory } from './workflow-source5-operations.js';
import { validateSource5WorkflowCheckpointData } from './workflow-source5-checkpoints.js';
import type { Source5WorkflowEvent } from './workflow-source5-journal.js';
import { workflowObservationRuntime } from './workflow-runtime.js';
import type { ModernSavedTransitionPlan } from '../domain/governance/activation/modern-record-contracts.js';
import { githubRepository, positiveId } from '../adapters/github/activation-rest.js';
import { sourceSha } from './github-config.js';

export type Source5WorkflowComponentFields = Omit<Source5WorkflowEffectFields,
  'kind' | 'observationOnly' | 'reviewedPlans'>;
export type Source5WorkflowPlanComponentFields = Omit<Source5WorkflowComponentFields, 'operation'>;
export type Source5WorkflowComponentProof = PublishedWorkflowSource | ImmutableWorkflowExecutionRef |
  WorkflowContextProof | { bindingDigest: string; observationDigest: string };
export type Source5WorkflowComponentResult =
  | { readonly status: 'pending'; readonly checkpoint: WorkflowProofCheckpoint }
  | { readonly status: 'completed'; readonly proof: Source5WorkflowComponentProof;
      readonly currentObservationDigest: string; readonly currentObservedAt: string };

function assertComponentFields(
  fields: Source5WorkflowPlanComponentFields, operation: boolean
): void {
  const required = ['projectRoot', 'plan', 'phase', 'authority', 'lease', 'now', 'runner', 'transport', 'profile',
    ...(operation ? ['operation'] : [])];
  if (!isRecord(fields) || ![Object.prototype, null].includes(Object.getPrototypeOf(fields)) ||
    required.some(key => !Object.hasOwn(fields, key)) ||
    Reflect.ownKeys(fields).some(key => typeof key !== 'string' || ![...required, 'clock'].includes(key)) ||
    Object.values(Object.getOwnPropertyDescriptors(fields)).some(descriptor => descriptor.get || descriptor.set) ||
    !(fields.now instanceof Date) || !Number.isFinite(fields.now.getTime()) ||
    fields.clock !== undefined && typeof fields.clock !== 'function') {
    workflowFailure('workflow-source5-component-fields',
      'A component needs closed own runtime fields without accessors, caller checkpoints or caller-selected observation mode.');
  }
}
function captureComponentFields(fields: Source5WorkflowComponentFields): Source5WorkflowComponentFields {
  assertComponentFields(fields, true);
  return Object.freeze({ ...fields, plan: captureWorkflowBinding(fields.plan),
    operation: captureWorkflowBinding(fields.operation), phase: captureWorkflowBinding(fields.phase),
    now: new Date(fields.now.getTime()) });
}

function capturePlanFields(
  fields: Source5WorkflowPlanComponentFields, journal: Source5WorkflowJournal
): Source5WorkflowPlanComponentFields {
  assertSource5WorkflowJournal(journal);
  assertComponentFields(fields, false);
  fields = Object.freeze({ ...fields, plan: captureWorkflowBinding(fields.plan),
    phase: captureWorkflowBinding(fields.phase), now: new Date(fields.now.getTime()) });
  if (fields.projectRoot !== journal.projectRoot || fields.lease !== journal.lease ||
    canonicalSha256(fields.plan) !== canonicalSha256(journal.plan)) {
    return workflowFailure('workflow-source5-component-plan', 'Plan execution requires this exact original journal, root, native lease and whole operation inventory.');
  }
  validateSource5WorkflowPlanComponents(fields.plan);
  return fields;
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (!isRecord(value) || required.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    return workflowFailure('workflow-source5-component-binding', 'A private component requires its closed exact original binding, not extra fields or a caller-selected subset.');
  }
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string') return workflowFailure('workflow-source5-component-binding', 'An original component string binding is missing.');
  return value;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return workflowFailure('workflow-source5-component-binding', 'An original provider ID must be an actual positive integer.');
  }
  return value;
}
function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) return workflowFailure('workflow-source5-component-binding', 'An original component needs its complete explicit array inventory.');
  return value;
}
function executionBinding(value: unknown): WorkflowExecutionRefBinding {
  const raw = exact(value, ['repository', 'repositoryId', 'sourceSha', 'treeSha', 'executionRef']);
  return { repository: text(raw.repository), repositoryId: number(raw.repositoryId),
    sourceSha: text(raw.sourceSha), treeSha: text(raw.treeSha), executionRef: text(raw.executionRef) };
}
function publicationBinding(value: unknown): WorkflowPublicationBinding {
  const raw = exact(value, ['repository', 'repositoryId', 'ref', 'parentSha', 'files', 'sourceTransmissionApproved']);
  if (raw.sourceTransmissionApproved !== true) {
    return workflowFailure('workflow-source5-component-binding', 'Source publication still needs exact original transmission consent.');
  }
  return { repository: text(raw.repository), repositoryId: number(raw.repositoryId), ref: text(raw.ref),
    parentSha: text(raw.parentSha), sourceTransmissionApproved: true, files: list(raw.files).map(value => {
      const file = exact(value, ['path', 'beforeDigest', 'digest', 'content']);
      if (file.beforeDigest !== null && typeof file.beforeDigest !== 'string') {
        return workflowFailure('workflow-source5-component-binding', 'Every original source file needs an explicit before digest or absence.');
      }
      return { path: text(file.path), beforeDigest: file.beforeDigest, digest: text(file.digest), content: text(file.content) };
    }) };
}
function runnerBinding(value: unknown): WorkflowRunnerAdmissionBinding {
  const raw = exact(value, ['repository', 'repositoryId', 'groupId', 'groupName', 'networkConfigurationId', 'beforeWorkflows', 'afterWorkflows']);
  return { repository: text(raw.repository), repositoryId: number(raw.repositoryId), groupId: number(raw.groupId),
    groupName: text(raw.groupName), networkConfigurationId: text(raw.networkConfigurationId),
    beforeWorkflows: list(raw.beforeWorkflows).map(text), afterWorkflows: list(raw.afterWorkflows).map(text) };
}
function contextBinding(value: unknown): WorkflowContextBinding {
  const raw = exact(value, ['repository', 'repositoryId', 'family', 'ref', 'sourceSha', 'treeSha', 'executionRef',
    'workflowPath', 'workflowDigest', 'contexts', 'mode', 'tokenSuppressedTrigger'], ['violation']);
  const family = protectedWorkflowFamilies.find(family => family === raw.family);
  if (!family || raw.mode !== 'green' && raw.mode !== 'controlled-red' || raw.tokenSuppressedTrigger !== true) {
    return workflowFailure('workflow-source5-component-binding', 'An original dispatch must name its actual protected family, green/red mode and token-safe trigger.');
  }
  const violation = raw.violation === undefined ? undefined : exact(raw.violation,
    ['path', 'parentSha', 'beforeDigest', 'afterDigest', 'context']);
  return validateWorkflowContextBinding({
    repository: text(raw.repository), repositoryId: number(raw.repositoryId), family, ref: text(raw.ref),
    sourceSha: text(raw.sourceSha), treeSha: text(raw.treeSha), executionRef: text(raw.executionRef),
    workflowPath: text(raw.workflowPath), workflowDigest: text(raw.workflowDigest), mode: raw.mode,
    tokenSuppressedTrigger: true, contexts: list(raw.contexts).map(value => {
      const context = exact(value, ['jobId', 'name', 'validationStep']);
      return { jobId: text(context.jobId), name: text(context.name), validationStep: text(context.validationStep) };
    }), ...(violation ? { violation: { path: text(violation.path), parentSha: text(violation.parentSha),
      beforeDigest: text(violation.beforeDigest), afterDigest: text(violation.afterDigest), context: text(violation.context) } } : {})
  });
}
type ComponentBinding =
  | { kind: 'publication'; binding: WorkflowPublicationBinding }
  | { kind: 'execution-ref'; binding: WorkflowExecutionRefBinding }
  | { kind: 'runner'; binding: WorkflowRunnerAdmissionBinding }
  | { kind: 'dispatch'; binding: WorkflowContextBinding };
function readComponentBinding(action: string, raw: unknown): ComponentBinding {
  if (action === 'git.workflow-source.publish-reviewed') return { kind: 'publication', binding: publicationBinding(raw) };
  if (action === 'github.workflow-source.bind-execution-ref') return { kind: 'execution-ref', binding: executionBinding(raw) };
  if (action === 'github.workflow-source.admit-reviewed') return { kind: 'runner', binding: runnerBinding(raw) };
  if (['github.checks.dev-proof', 'github.checks.staging', 'github.checks.production-rehearsal', 'github.checks.green-red-proof'].includes(action)) {
    return { kind: 'dispatch', binding: contextBinding(raw) };
  }
  return workflowFailure('workflow-source5-component-binding', 'Only an exact indexed workflow entry has a private component producer.');
}

export function validateSource5WorkflowPlanComponents(plan: ModernSavedTransitionPlan): void {
  for (const operation of source5WorkflowPlanInventory(plan).effects) {
    const selected = readComponentBinding(operation.actionId.split(':')[0]!, operation.inputs);
    if (selected.kind === 'publication') validateWorkflowPublication(selected.binding);
    else if (selected.kind === 'runner') validateWorkflowRunnerAdmission(selected.binding);
    else if (selected.kind === 'execution-ref') {
      githubRepository(selected.binding.repository); positiveId(selected.binding.repositoryId);
      sourceSha(selected.binding.treeSha);
      if (selected.binding.executionRef !== workflowExecutionRefName(selected.binding.sourceSha)) {
        return workflowFailure('workflow-execution-ref', 'Execution requires the exact full-commit-named tag, not a mutable branch or an undocumented SHA-dispatch fallback.');
      }
    }
  }
}

export async function executeSource5WorkflowComponent(
  fields: Source5WorkflowComponentFields, journal: Source5WorkflowJournal
): Promise<Source5WorkflowComponentResult> {
  assertSource5WorkflowJournal(journal);
  fields = captureComponentFields(fields);
  await journal.assertInventory();
  const action = fields.operation.actionId.split(':')[0];
  const raw = captureWorkflowBinding(fields.operation.inputs);
  const selected = readComponentBinding(action!, raw);
  const prior = await journal.events(fields.operation);
  const completed = prior.find(event => event.stage === 'component-completed');
  const input = await createSource5WorkflowEffectInput({ ...fields, kind: 'source5-workflow-effect.v1',
    reviewedPlans: [journal.plan], observationOnly: journal.wasAttempted(fields.operation) || prior.length > 0 }, journal);
  let proof: Source5WorkflowComponentProof;
  if (selected.kind === 'publication') {
    const binding = selected.binding;
    const publication = input.observationOnly ? await observeWorkflowSourcePublication(input, binding) :
      await executeWorkflowSourcePublication(input, binding);
    if (input.observationOnly && !completed) {
      const base = { bindingDigest: canonicalSha256(binding), planDigest: journal.plan.planDigest };
      if (!prior.some(event => event.stage === 'publication-committed')) {
        await recordSource5WorkflowStage(input, 'publication-committed', { ...base, stage: 'committed', commitSha: publication.commitSha });
      }
      await recordSource5WorkflowStage(input, 'publication-published', { ...base, stage: 'published', commitSha: publication.commitSha });
    }
    proof = publication;
  } else if (selected.kind === 'runner') {
    proof = await admitReviewedRunnerWorkflows(input, selected.binding);
  } else if (selected.kind === 'dispatch') {
    const result = await executeWorkflowContextProof(input, selected.binding);
    if (result.status === 'pending') return result;
    // A retained terminal summary is not an independently current job/check/source observation.
    const current = await readCurrentWorkflowContextProof(input, result.proof);
    if (current.observationDigest !== result.proof.observationDigest) {
      return workflowFailure('workflow-source5-component-current', 'Independent current proof differs from this original terminal run; its recorded truth is retained without completion.');
    }
    proof = result.proof;
  } else {
    proof = await bindImmutableWorkflowExecutionRef(input, selected.binding);
  }
  if (completed) {
    const original = completed.data.proof;
    if (!isRecord(original) || original.observationDigest !== proof.observationDigest ||
      canonicalSha256({ ...original, observedAt: null }) !== canonicalSha256({ ...proof, observedAt: null })) {
      return workflowFailure('workflow-source5-component-current', 'Current provider/source truth differs from the immutable original component. No receipt may be replaced, retagged or repeated.');
    }
    if ('observedAt' in proof && typeof original.observedAt === 'string') {
      proof = { ...proof, observedAt: original.observedAt };
    }
  } else {
    await recordSource5WorkflowStage(input, 'component-completed', { proof });
  }
  return captureWorkflowBinding({ status: 'completed', proof,
    currentObservationDigest: proof.observationDigest, currentObservedAt: (fields.clock?.() ?? fields.now).toISOString() });
}

export interface Source5WorkflowPlanComponentObservation {
  readonly operationDigest: string;
  readonly actionId: string;
  readonly result: Source5WorkflowComponentResult;
}

/** Runs the original whole inventory in order; it neither issues approval nor finalizes a phase. */
export async function executeSource5WorkflowPlanComponents(
  fields: Source5WorkflowPlanComponentFields, journal: Source5WorkflowJournal
) {
  fields = capturePlanFields(fields, journal);
  const { control, effects } = source5WorkflowPlanInventory(fields.plan);
  await journal.assertInventory();
  const observations: Source5WorkflowPlanComponentObservation[] = [];
  for (const [index, operation] of effects.entries()) {
    const result = await executeSource5WorkflowComponent({ ...fields, operation }, journal);
    observations.push({ operationDigest: canonicalSha256(operation), actionId: operation.actionId, result });
    if (result.status === 'pending') {
      return captureWorkflowBinding({
        status: 'pending' as const, controlKey: control.controlKey, planDigest: fields.plan.planDigest,
        observations, unexecutedOperationDigests: effects.slice(index + 1).map(operation => canonicalSha256(operation)),
        phaseComplete: false as const, matrixComplete: false as const
      });
    }
  }
  return captureWorkflowBinding({
    status: 'components-observed' as const, controlKey: control.controlKey, planDigest: fields.plan.planDigest,
    observations, unexecutedOperationDigests: [],
    phaseComplete: false as const, matrixComplete: false as const
  });
}

function assertOriginalContextProof(
  proof: unknown, operation: Source5WorkflowEffectFields['operation'],
  events: readonly Source5WorkflowEvent[], planDigest: string
): asserts proof is WorkflowContextProof {
  if (!operation.actionId.startsWith('github.checks.green-red-proof:')) {
    return workflowFailure('workflow-source5-component-matrix', 'A current matrix must contain only its original green/red context-proof entries.');
  }
  validateSource5WorkflowCheckpointData(operation, 'component-completed', {
    bindingDigest: canonicalSha256(operation.inputs), planDigest, proof
  }, events, planDigest);
}

/** Reconstructs observation carriers from original receipts, never caller-selected proof values. */
export async function observeSource5WorkflowPlanMatrix(
  fields: Source5WorkflowPlanComponentFields, journal: Source5WorkflowJournal,
  requirements: WorkflowRequirementSource
) {
  fields = capturePlanFields(fields, journal);
  requirements = captureWorkflowBinding(requirements);
  if (fields.plan.phaseId !== 'green-red-proof') {
    return workflowFailure('workflow-source5-component-matrix', 'Only the complete original green/red plan can request a current matrix observation.');
  }
  const runtime = workflowObservationRuntime(fields);
  const { control, effects } = source5WorkflowPlanInventory(fields.plan);
  await journal.assertInventory();
  runtime.assertWithinDeadline();
  const originals: { operation: Source5WorkflowEffectFields['operation']; proof: WorkflowContextProof }[] = [];
  for (const operation of effects) {
    const events = await journal.events(operation);
    runtime.assertWithinDeadline();
    const completed = events.find(event => event.stage === 'component-completed');
    if (!completed) {
      return workflowFailure('workflow-source5-component-matrix', 'Every original matrix entry must already have its retained complete component; pending or missing work cannot be dispatched by observation.');
    }
    const proof = completed.data.proof;
    assertOriginalContextProof(proof, operation, events, fields.plan.planDigest);
    originals.push({ operation, proof });
  }
  const entries: {
    input: Awaited<ReturnType<typeof createSource5WorkflowEffectInput>>; proof: WorkflowContextProof;
  }[] = [];
  for (const original of originals) {
    runtime.assertWithinDeadline();
    const input = await createSource5WorkflowEffectInput({
      ...fields, operation: original.operation, transport: runtime.client.transport,
      kind: 'source5-workflow-effect.v1', observationOnly: true, reviewedPlans: [journal.plan]
    }, journal);
    runtime.assertWithinDeadline();
    entries.push({ input, proof: original.proof });
  }
  const matrix = await verifySource5WorkflowProofMatrix(entries, requirements);
  runtime.assertWithinDeadline();
  return captureWorkflowBinding({
    controlKey: control.controlKey, planDigest: fields.plan.planDigest, matrix,
    observedAt: (fields.clock?.() ?? fields.now).toISOString(), phaseComplete: false as const
  });
}
